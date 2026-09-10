/**
 * secp256k1: key derivation and ECDSA signing with a recovery id.
 *
 * WHY NOT `node:crypto`'s EC. Node will happily sign with a secp256k1 key, but
 * it returns (r, s) and nothing else. An Ethereum transaction needs a third
 * number — the recovery id — and recovering it from a finished signature means
 * implementing point *decompression* (a modular square root, then a candidate
 * public key per parity) on top of the point arithmetic. Signing here instead
 * means we already know R = kG, so the recovery id falls out of R's parity for
 * free, and the same 40 lines of curve arithmetic also give us the address
 * derivation we need anyway to prove the key matches USDC_SENDER_ADDRESS
 * before a single wei of gas is spent.
 *
 * `k` is RFC 6979 deterministic (HMAC-SHA256, from `node:crypto`), not random.
 * Two reasons, and the second is the one that matters here:
 *
 *   1. A repeated or biased `k` leaks the private key outright. Determinism
 *      removes the entropy source from the threat model entirely.
 *   2. THE SAME TRANSACTION MUST HASH TO THE SAME VALUE. The transaction hash
 *      is this payout's idempotency key (see ./adapter.ts). With a random `k`,
 *      signing identical transaction fields twice produces two different
 *      hashes — two different idempotency keys for one intent, which is the
 *      exact failure the key exists to prevent.
 *
 * `s` is normalised to the lower half of the curve order (EIP-2), because
 * (r, s) and (r, n − s) are both valid signatures and Ethereum accepts only
 * the low one. The recovery bit flips with it; that is handled at the flip
 * site, not left to the caller.
 *
 * TESTNET ONLY, as everything in this package is. The private key is read from
 * the environment at call time by the caller and never held in module scope.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { keccak256 } from "./keccak";
import { concatBytes, fromHex, toHex } from "./hex";

/** Field prime: 2^256 − 2^32 − 977. */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
/** Group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

/** An affine point, or `null` for the point at infinity. */
type Point = { readonly x: bigint; readonly y: bigint } | null;

const G: Point = { x: GX, y: GY };

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

/** Extended Euclid. Throws rather than returning a wrong answer for 0. */
function modInv(a: bigint, m: bigint): bigint {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("modular inverse does not exist");
  return mod(old_s, m);
}

function pointDouble(p: Point): Point {
  if (p === null) return null;
  if (p.y === 0n) return null;
  const lambda = mod(3n * p.x * p.x * modInv(2n * p.y, P), P);
  const x = mod(lambda * lambda - 2n * p.x, P);
  return { x, y: mod(lambda * (p.x - x) - p.y, P) };
}

function pointAdd(a: Point, b: Point): Point {
  if (a === null) return b;
  if (b === null) return a;
  if (a.x === b.x) return a.y === b.y ? pointDouble(a) : null;
  const lambda = mod((b.y - a.y) * modInv(b.x - a.x, P), P);
  const x = mod(lambda * lambda - a.x - b.x, P);
  return { x, y: mod(lambda * (a.x - x) - a.y, P) };
}

/**
 * Double-and-add, most significant bit first.
 *
 * Not constant time, and deliberately not claimed to be: this runs in an
 * operator script against a testnet key that has never touched real funds. A
 * production signer belongs in a KMS or an HSM, not in application code, and
 * pretending otherwise would be a worse lie than the timing leak.
 */
function pointMul(scalar: bigint, point: Point): Point {
  let result: Point = null;
  let addend = point;
  for (let k = mod(scalar, N); k > 0n; k >>= 1n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
  }
  return result;
}

export interface Signature {
  readonly r: bigint;
  readonly s: bigint;
  /** EIP-1559 `yParity`: 0 or 1. */
  readonly yParity: 0 | 1;
}

export class SigningError extends Error {
  override readonly name = "SigningError";
}

function requirePrivateKey(privateKey: Uint8Array): bigint {
  if (privateKey.length !== 32) {
    throw new SigningError(`a secp256k1 private key is 32 bytes, got ${privateKey.length}`);
  }
  const d = BigInt(toHex(privateKey));
  if (d === 0n || d >= N) throw new SigningError("private key is out of range for secp256k1");
  return d;
}

/** Parse `0x…` (or bare) 32-byte hex into key material. */
export function parsePrivateKey(hex: string): Uint8Array {
  const bytes = fromHex(hex.trim());
  requirePrivateKey(bytes);
  return bytes;
}

/** The uncompressed public key, X‖Y, 64 bytes, with no 0x04 prefix. */
export function publicKey(privateKey: Uint8Array): Uint8Array {
  const q = pointMul(requirePrivateKey(privateKey), G);
  if (q === null) throw new SigningError("private key multiplies to the point at infinity");
  return concatBytes(
    fromHex(q.x.toString(16).padStart(64, "0")),
    fromHex(q.y.toString(16).padStart(64, "0")),
  );
}

/** The Ethereum address: the low 20 bytes of keccak256(X‖Y), lowercased. */
export function addressFromPrivateKey(privateKey: Uint8Array): string {
  return toHex(keccak256(publicKey(privateKey)).subarray(12));
}

/**
 * RFC 6979 §3.2, HMAC-SHA256. Returns the first candidate in [1, n).
 *
 * The extra `V = HMAC(K, V)` step inside the loop is not optional: without it
 * a rejected candidate would be retried identically forever.
 */
function deterministicK(hash: Uint8Array, privateKey: Uint8Array): bigint {
  let v: Uint8Array = new Uint8Array(32).fill(0x01);
  let k: Uint8Array = new Uint8Array(32).fill(0x00);
  const hmac = (key: Uint8Array, ...data: readonly Uint8Array[]): Uint8Array =>
    Uint8Array.from(data.reduce((h, d) => h.update(d), createHmac("sha256", key)).digest());

  k = hmac(k, v, Uint8Array.of(0x00), privateKey, hash);
  v = hmac(k, v);
  k = hmac(k, v, Uint8Array.of(0x01), privateKey, hash);
  v = hmac(k, v);

  for (let attempt = 0; attempt < 1000; attempt++) {
    v = hmac(k, v);
    const candidate = BigInt(toHex(v));
    if (candidate >= 1n && candidate < N) return candidate;
    k = hmac(k, v, Uint8Array.of(0x00));
    v = hmac(k, v);
  }
  throw new SigningError("RFC 6979 found no valid k in 1000 attempts — statistically impossible");
}

/**
 * Sign a 32-byte message hash. Deterministic, low-s, with `yParity`.
 *
 * `x >= N` on R is the case every toy implementation drops. It has never been
 * observed on this curve (it needs `r` to land in a window of width ~2^128 out
 * of 2^256) and it is handled anyway, by rejecting the candidate `k` outright,
 * because "cannot happen" and "produces an unrecoverable signature if it does"
 * are a bad pairing in a signer.
 */
export function sign(messageHash: Uint8Array, privateKey: Uint8Array): Signature {
  if (messageHash.length !== 32) {
    throw new SigningError(`message hash must be 32 bytes, got ${messageHash.length}`);
  }
  const d = requirePrivateKey(privateKey);
  const z = mod(BigInt(toHex(messageHash)), N);

  let k = deterministicK(messageHash, privateKey);
  for (let attempt = 0; attempt < 8; attempt++) {
    const point = pointMul(k, G);
    if (point !== null && point.x < N) {
      const r = mod(point.x, N);
      if (r !== 0n) {
        const sRaw = mod(modInv(k, N) * (z + r * d), N);
        if (sRaw !== 0n) {
          const odd = (point.y & 1n) === 1n;
          // EIP-2: only the low-s form is canonical. Negating s mirrors R
          // across the x-axis, so the parity bit flips with it.
          const high = sRaw > N / 2n;
          return { r, s: high ? N - sRaw : sRaw, yParity: (odd !== high ? 1 : 0) };
        }
      }
    }
    k = deterministicK(keccak256(concatBytes(messageHash, Uint8Array.of(attempt))), privateKey);
  }
  throw new SigningError("no valid signature after 8 candidate nonces");
}

/**
 * Constant-time-ish address comparison, so a mismatch between the configured
 * address and the one the key derives to is reported as a mismatch rather than
 * as a byte position.
 */
export function addressesMatch(a: string, b: string): boolean {
  const left = Buffer.from(a.toLowerCase().replace(/^0x/, ""), "hex");
  const right = Buffer.from(b.toLowerCase().replace(/^0x/, ""), "hex");
  return left.length === right.length && left.length === 20 && timingSafeEqual(left, right);
}
