/**
 * RLP, the only serialisation Ethereum transactions have.
 *
 * Two cases and no more: a byte string, and a list of items. Everything else —
 * integers, addresses, calldata — is a byte string by the time it arrives here,
 * which is why `toMinimalBytes` lives in ./hex and not in this file.
 */

import { concatBytes } from "./hex";

export type RlpItem = Uint8Array | readonly RlpItem[];

function encodeLength(length: number, offset: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  const lengthBytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) lengthBytes.unshift(n % 256);
  return concatBytes(Uint8Array.of(offset + 55 + lengthBytes.length), Uint8Array.from(lengthBytes));
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    // A single byte below 0x80 is its own encoding. This is the case that
    // silently breaks a hand-rolled encoder: chain id 1 encodes as `01`, not
    // as `81 01`.
    if (item.length === 1 && item[0] !== undefined && item[0] < 0x80) return item;
    return concatBytes(encodeLength(item.length, 0x80), item);
  }
  const body = concatBytes(...item.map(rlpEncode));
  return concatBytes(encodeLength(body.length, 0xc0), body);
}
