/**
 * EIP-1559 (type 0x02) transaction encoding, signing, and — the whole point —
 * hashing BEFORE broadcast.
 *
 * ── WHY THE HASH IS COMPUTED HERE AND NOT READ BACK FROM THE NODE ───────────
 *
 * An Ethereum transaction hash is `keccak256` of the signed transaction's own
 * bytes. It is not assigned by the network, it is not allocated by the node,
 * and nothing about it depends on the transaction being accepted, mined, or
 * even sent. That means the identifier for this money movement exists on this
 * machine *before* a single byte goes over the wire — so it can be written
 * down, logged, and used as the ledger's idempotency key without ever creating
 * a window where money has moved under a name we do not yet know.
 *
 * A payout that asked the node "what did you call it?" after broadcasting
 * would have exactly that window, and it is the window that produces double
 * spends: crash inside it and there is no way to ask whether the money left.
 *
 * `signTransaction` therefore returns `{ raw, hash }` together, and
 * `../adapter.ts` prints the hash before it calls `eth_sendRawTransaction`.
 *
 * Signing is deterministic (RFC 6979, see ./secp256k1.ts), so the same fields
 * always produce the same hash. Identical intent, identical identifier.
 */

import { concatBytes, fromHex, normalizeAddress, toHex, toMinimalBytes } from "./hex";
import { keccak256 } from "./keccak";
import { rlpEncode, type RlpItem } from "./rlp";
import { sign, type Signature } from "./secp256k1";

/** The EIP-2718 type byte for an EIP-1559 transaction. */
export const EIP_1559_TX_TYPE = 0x02;

export interface Eip1559Fields {
  readonly chainId: bigint;
  readonly nonce: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly gasLimit: bigint;
  readonly to: string;
  readonly value: bigint;
  readonly data: Uint8Array;
}

export interface SignedTransaction {
  /** The bytes for `eth_sendRawTransaction`. */
  readonly raw: Uint8Array;
  /** `keccak256(raw)`. Known before broadcast; the idempotency key. */
  readonly hash: string;
}

function unsignedItems(tx: Eip1559Fields): RlpItem[] {
  return [
    toMinimalBytes(tx.chainId),
    toMinimalBytes(tx.nonce),
    toMinimalBytes(tx.maxPriorityFeePerGas),
    toMinimalBytes(tx.maxFeePerGas),
    toMinimalBytes(tx.gasLimit),
    fromHex(normalizeAddress(tx.to, "to")),
    toMinimalBytes(tx.value),
    tx.data,
    // Empty access list. Present and empty is REQUIRED — a nine-element list
    // is not an EIP-1559 transaction and the node rejects it outright.
    [],
  ];
}

/**
 * The payload that gets signed: `0x02 || rlp([…nine fields…])`, keccak'd.
 *
 * The type byte is prepended to the RLP and then hashed — it is not part of
 * the RLP list. Getting that backwards produces a signature that recovers to
 * a different address, which the network reports as "invalid sender" and
 * nothing more helpful.
 */
export function signingHash(tx: Eip1559Fields): Uint8Array {
  return keccak256(concatBytes(Uint8Array.of(EIP_1559_TX_TYPE), rlpEncode(unsignedItems(tx))));
}

/**
 * Combine fields and a signature into the broadcast bytes and their hash.
 *
 * Split out from `signTransaction` so it can be tested with a signature we did
 * not produce: ./tx.test.ts feeds it the fields and (r, s, yParity) of a
 * transaction that is on Base Sepolia right now and asserts the hash comes back
 * equal to the one the chain has. That checks the encoder against the network's
 * own answer with no private key anywhere near the test.
 */
export function encodeSignedTransaction(tx: Eip1559Fields, signature: Signature): SignedTransaction {
  const raw = concatBytes(
    Uint8Array.of(EIP_1559_TX_TYPE),
    rlpEncode([
      ...unsignedItems(tx),
      toMinimalBytes(BigInt(signature.yParity)),
      toMinimalBytes(signature.r),
      toMinimalBytes(signature.s),
    ]),
  );
  return { raw, hash: toHex(keccak256(raw)) };
}

/** Sign, encode, and hash. Deterministic in every field. */
export function signTransaction(tx: Eip1559Fields, privateKey: Uint8Array): SignedTransaction {
  return encodeSignedTransaction(tx, sign(signingHash(tx), privateKey));
}
