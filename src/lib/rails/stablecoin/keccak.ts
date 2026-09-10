/**
 * Keccak-256 — the hash Ethereum actually uses.
 *
 * WHY THIS IS HAND-ROLLED AND NOT `createHash("sha3-256")`. Node's OpenSSL
 * offers SHA3-256, which is Keccak with a DIFFERENT PAD BYTE: FIPS-202 appends
 * 0x06, original Keccak appends 0x01. Ethereum froze on the pre-standard
 * version, so `sha3-256` produces a completely different digest and every
 * address, selector and transaction hash derived from it would be wrong in a
 * way that only the chain would tell you about. Measured on this machine:
 * `crypto.getHashes()` has no `keccak256` entry at all, and asking for one
 * throws "Digest method not supported".
 *
 * So: 60 lines of permutation, checked against published vectors in
 * ./keccak.test.ts before anything signed a transaction. That is a better
 * trade than adding a dependency to the deployed app.
 *
 * The state is a BigUint64Array on purpose — assignment into it truncates to
 * 64 bits for free, which removes the single most common source of bugs in a
 * from-scratch Keccak (a forgotten `& 0xffffffffffffffffn`).
 */

/** Round constants ι, all 24 of them. */
const RC = new BigUint64Array([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]);

/**
 * ρ rotation offsets, flattened by lane index `x + 5y`. A Uint8Array rather
 * than a number[] so `noUncheckedIndexedAccess` does not make every lookup a
 * `number | undefined`.
 */
const ROT = new Uint8Array([
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
]);

/** π lane permutation: destination index for each source lane `x + 5y`. */
const PI = (() => {
  const pi = new Uint8Array(25);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      pi[x + 5 * y] = y + 5 * ((2 * x + 3 * y) % 5);
    }
  }
  return pi;
})();

/** The rate for Keccak-256: 1600 bits of state minus 2×256 bits of capacity. */
export const KECCAK_256_RATE_BYTES = 136;

/**
 * `noUncheckedIndexedAccess` is on across this repo, and it applies to typed
 * arrays too, so every lane read below goes through these. The `?? 0n` can
 * never fire — every index is a compile-time-bounded 0..24 — but writing it
 * out is cheaper than turning the strictness off for a hot loop.
 */
function lane(state: BigUint64Array, index: number): bigint {
  return state[index] ?? 0n;
}

function shift(index: number): number {
  return ROT[index] ?? 0;
}

function rotl(value: bigint, bits: number): bigint {
  if (bits === 0) return value;
  const s = BigInt(bits);
  return ((value << s) | (value >> (64n - s))) & 0xffffffffffffffffn;
}

function permute(a: BigUint64Array): void {
  const c = new BigUint64Array(5);
  const b = new BigUint64Array(25);
  for (let round = 0; round < 24; round++) {
    // θ — parity of each column, folded back across the whole state
    for (let x = 0; x < 5; x++) {
      c[x] = lane(a, x) ^ lane(a, x + 5) ^ lane(a, x + 10) ^ lane(a, x + 15) ^ lane(a, x + 20);
    }
    for (let x = 0; x < 5; x++) {
      const d = lane(c, (x + 4) % 5) ^ rotl(lane(c, (x + 1) % 5), 1);
      for (let y = 0; y < 25; y += 5) a[x + y] = lane(a, x + y) ^ d;
    }
    // ρ (rotate each lane) and π (permute the lanes), in one pass
    for (let i = 0; i < 25; i++) b[PI[i] ?? 0] = rotl(lane(a, i), shift(i));
    // χ — the only non-linear step
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = lane(b, x + y) ^ (~lane(b, ((x + 1) % 5) + y) & lane(b, ((x + 2) % 5) + y));
      }
    }
    // ι — break the round symmetry
    a[0] = lane(a, 0) ^ (RC[round] ?? 0n);
  }
}

/**
 * Keccak-256 of arbitrary bytes.
 *
 * Sponge: absorb `rate` bytes at a time little-endian into the lanes, permute,
 * repeat; pad with 0x01 … 0x80 (NOT FIPS-202's 0x06); squeeze 32 bytes.
 */
export function keccak256(input: Uint8Array): Uint8Array {
  const rate = KECCAK_256_RATE_BYTES;
  const padded = new Uint8Array(Math.ceil((input.length + 1) / rate) * rate);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const state = new BigUint64Array(25);
  const view = new DataView(padded.buffer as ArrayBuffer, padded.byteOffset, padded.byteLength);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let index = 0; index < rate / 8; index++) {
      state[index] = lane(state, index) ^ view.getBigUint64(offset + index * 8, true);
    }
    permute(state);
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer as ArrayBuffer);
  for (let index = 0; index < 4; index++) outView.setBigUint64(index * 8, lane(state, index), true);
  return out;
}

/** Keccak-256 of a UTF-8 string. Used for function selectors and event topics. */
export function keccak256Utf8(input: string): Uint8Array {
  return keccak256(new TextEncoder().encode(input));
}
