/**
 * RLP, ECDSA and the EIP-1559 envelope, against two independent witnesses.
 *
 *   1. THE PUBLISHED EIP-155 EXAMPLE. Private key 0x4646…46, the exact
 *      transaction in the EIP's own text. It pins the address derivation, the
 *      RLP encoding, the signing hash, and — because the signature here is
 *      RFC 6979 deterministic — the precise r and s the EIP publishes. If any
 *      one of the four were wrong, r and s could not both come out right.
 *
 *   2. THE TRANSACTION THIS REPO ACTUALLY BROADCAST. Block 46,651,201 on Base
 *      Sepolia, hash 0xb47c5a36…. Its fields and signature are read off the
 *      chain and fed back through the encoder; the hash that comes out has to
 *      be the hash the network has. That is the strongest available check on
 *      the typed-envelope encoding, and it needs no private key.
 */
import { describe, expect, it } from "vitest";

import { fromHex, toHex, toMinimalBytes } from "./hex";
import { keccak256 } from "./keccak";
import { rlpEncode } from "./rlp";
import { addressFromPrivateKey, sign } from "./secp256k1";
import { encodeSignedTransaction, signTransaction, signingHash, type Eip1559Fields } from "./tx";
import { encodeTransferCall } from "./client";

describe("rlp", () => {
  it("encodes a single low byte as itself", () => {
    // The case that silently breaks a hand-rolled encoder: 0x01 is `01`, not
    // `8101`. Chain id 1 and yParity 1 both hit it.
    expect(toHex(rlpEncode(Uint8Array.of(0x01)))).toBe("0x01");
  });

  it("encodes zero as the empty string, not as 0x00", () => {
    expect(toHex(rlpEncode(toMinimalBytes(0n)))).toBe("0x80");
  });

  it("encodes an empty list", () => {
    expect(toHex(rlpEncode([]))).toBe("0xc0");
  });

  it("switches to the long form above 55 bytes", () => {
    expect(toHex(rlpEncode(new Uint8Array(56))).slice(0, 6)).toBe("0xb838");
  });
});

describe("the published EIP-155 example transaction", () => {
  const PRIVATE_KEY = fromHex("0x4646464646464646464646464646464646464646464646464646464646464646");

  it("derives the documented address", () => {
    expect(addressFromPrivateKey(PRIVATE_KEY)).toBe("0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f");
  });

  it("reproduces the RLP, the signing hash and the exact published signature", () => {
    const rlp = rlpEncode([
      toMinimalBytes(9n),
      toMinimalBytes(20_000_000_000n),
      toMinimalBytes(21_000n),
      fromHex("0x3535353535353535353535353535353535353535"),
      toMinimalBytes(1_000_000_000_000_000_000n),
      new Uint8Array(0),
      toMinimalBytes(1n),
      new Uint8Array(0),
      new Uint8Array(0),
    ]);
    expect(toHex(rlp)).toBe(
      "0xec098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080018080",
    );

    const signature = sign(keccak256(rlp), PRIVATE_KEY);
    expect(`0x${signature.r.toString(16).padStart(64, "0")}`).toBe(
      "0x28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276",
    );
    expect(`0x${signature.s.toString(16).padStart(64, "0")}`).toBe(
      "0x67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83",
    );
    // EIP-155 publishes v = 37 on chain 1, i.e. 35 + chainId*2 + 0.
    expect(signature.yParity).toBe(0);
  });

  it("signs deterministically: the same fields always produce the same hash", () => {
    const fields: Eip1559Fields = {
      chainId: 84_532n,
      nonce: 0n,
      maxPriorityFeePerGas: 1_000_000n,
      maxFeePerGas: 16_000_000n,
      gasLimit: 56_528n,
      to: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      value: 0n,
      data: encodeTransferCall("0x000000000000000000000000000000000000dEaD", 500_000n),
    };
    expect(signTransaction(fields, PRIVATE_KEY).hash).toBe(signTransaction(fields, PRIVATE_KEY).hash);
  });
});

describe("the transaction this repo broadcast to Base Sepolia", () => {
  // Read back with eth_getTransactionByHash. Nothing here is invented.
  const FIELDS: Eip1559Fields = {
    chainId: 0x14a34n,
    nonce: 0n,
    maxPriorityFeePerGas: 0xf4240n,
    maxFeePerGas: 0xf42400n,
    gasLimit: 0xdcd0n,
    to: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    value: 0n,
    data: fromHex(
      "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead" +
        "000000000000000000000000000000000000000000000000000000000007a120",
    ),
  };
  const SIGNATURE = {
    r: 0x7971a951a0ffc0343e9270c4c2691849a56e3aecd807744a5e611c31e486df70n,
    s: 0x47851a3a4e415d942f6e798cb0755b7efe9166fbf87586b348d0403503a858d8n,
    yParity: 1 as const,
  };
  const HASH = "0xb47c5a368f79786f73947c4f1980615557ff1800cd92818bd33070f7ed7986a1";

  it("re-encodes to the hash the chain has", () => {
    expect(encodeSignedTransaction(FIELDS, SIGNATURE).hash).toBe(HASH);
  });

  it("builds the calldata the chain recorded", () => {
    expect(toHex(encodeTransferCall("0x000000000000000000000000000000000000dEaD", 500_000n))).toBe(
      toHex(FIELDS.data),
    );
  });

  it("produces a signing hash distinct from the transaction hash", () => {
    // The signed payload and the broadcast payload are different byte strings;
    // conflating them yields an idempotency key that names nothing.
    expect(toHex(signingHash(FIELDS))).not.toBe(HASH);
  });
});
