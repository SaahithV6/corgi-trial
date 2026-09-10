/**
 * Keccak-256, against published vectors.
 *
 * This file is the reason it was safe to sign anything. A wrong hash function
 * does not produce an error — it produces a valid-looking transaction for a
 * different sender, a selector that calls a different function, or a
 * transaction hash that names something that does not exist. Every one of
 * those fails silently and expensively, so the permutation is checked before
 * the key is ever used.
 *
 * THE PAD BYTE IS THE WHOLE POINT of the first assertion. Node's `sha3-256`
 * would return a completely different digest for the empty string; Ethereum
 * froze on pre-standard Keccak, which pads with 0x01 rather than 0x06.
 */
import { describe, expect, it } from "vitest";

import { toHex } from "./hex";
import { keccak256, keccak256Utf8 } from "./keccak";

describe("keccak256", () => {
  it("hashes the empty string to Ethereum's well-known constant", () => {
    expect(toHex(keccak256Utf8(""))).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    // SHA3-256("") is 0xa7ffc6f8bf1ed766…, and that is the bug this guards.
    expect(toHex(keccak256Utf8(""))).not.toBe(
      "0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a",
    );
  });

  it("hashes 'abc'", () => {
    expect(toHex(keccak256Utf8("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("hashes a single 0x80 byte to the empty-trie root", () => {
    // keccak256(rlp("")) — the empty Merkle-Patricia root every Ethereum
    // client ships as a constant. A convenient independent witness.
    expect(toHex(keccak256(Uint8Array.of(0x80)))).toBe(
      "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421",
    );
  });

  it("hashes across the 136-byte rate boundary", () => {
    // One block short, exactly one block, and one byte over: the three inputs
    // that separate a correct sponge from one that pads or absorbs wrongly.
    expect(toHex(keccak256(new Uint8Array(135)))).toBe(
      "0x29e3704feeca7fb9ba229f0fa04d9b36449cf3ad6e1d85d9cfff3a10df9abc3e",
    );
    expect(toHex(keccak256(new Uint8Array(136)))).toBe(
      "0x3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9",
    );
    expect(toHex(keccak256(new Uint8Array(137)))).toBe(
      "0xbee7fbb405cb0d91a8775e338c4a5e4b5d6b2d051f687fa942043cffdc73bd28",
    );
    expect(toHex(keccak256(new Uint8Array(200).fill(0xa3)))).toBe(
      "0x3a57666b048777f2c953dc4456f45a2588e1cb6f2da760122d530ac2ce607d4a",
    );
  });

  it("derives the ERC-20 selectors and topic rather than trusting a pasted constant", () => {
    expect(toHex(keccak256Utf8("transfer(address,uint256)")).slice(0, 10)).toBe("0xa9059cbb");
    expect(toHex(keccak256Utf8("balanceOf(address)")).slice(0, 10)).toBe("0x70a08231");
    expect(toHex(keccak256Utf8("Transfer(address,address,uint256)"))).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });
});
