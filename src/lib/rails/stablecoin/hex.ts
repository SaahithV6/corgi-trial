/**
 * Hex on the JSON-RPC boundary.
 *
 * Every number the Ethereum JSON-RPC speaks is a `0x`-prefixed, minimally
 * encoded quantity, and every one of them is money-adjacent: a nonce, a gas
 * price, a wei balance, a uint256 of USDC. They are `bigint` here without
 * exception. `Number(...)` never appears in this package's value path — a
 * uint256 exceeds `Number.MAX_SAFE_INTEGER` before it reaches nine dollars of
 * ETH, and the only thing worse than crashing on it is not crashing on it.
 */

export function toHex(bytes: Uint8Array): string {
  return `0x${Buffer.from(bytes).toString("hex")}`;
}

export function fromHex(hex: string): Uint8Array {
  const body = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`odd-length hex string: ${hex}`);
  if (!/^[0-9a-fA-F]*$/.test(body)) throw new Error(`not hex: ${hex}`);
  // The regex above has already rejected anything Buffer.from would silently
  // drop, which is the whole reason it is there: `Buffer.from("zz", "hex")` is
  // an empty buffer, not an error.
  return Uint8Array.from(Buffer.from(body, "hex"));
}

/** A JSON-RPC quantity -> bigint. Rejects anything that is not one. */
export function quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`${what}: expected a 0x quantity, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** bigint -> minimal `0x` quantity, the shape the RPC expects on the way out. */
export function toQuantity(value: bigint): string {
  if (value < 0n) throw new Error(`quantities are unsigned: ${value}`);
  return `0x${value.toString(16)}`;
}

/**
 * Minimal big-endian bytes for RLP. Zero is the EMPTY string, not `0x00` —
 * getting this wrong produces a transaction the network rejects with a hash
 * that looks perfectly reasonable.
 */
export function toMinimalBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error(`cannot RLP-encode a negative integer: ${value}`);
  if (value === 0n) return new Uint8Array(0);
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = `0${hex}`;
  return fromHex(hex);
}

/** Left-pad to 32 bytes: the ABI encoding of every static word. */
export function padWord(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error(`${bytes.length} bytes will not fit in an ABI word`);
  const word = new Uint8Array(32);
  word.set(bytes, 32 - bytes.length);
  return word;
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Normalise and validate a 20-byte address. Lowercased; no checksum claim. */
export function normalizeAddress(address: string, what = "address"): string {
  if (!ADDRESS_RE.test(address)) throw new Error(`${what} is not a 20-byte hex address: ${address}`);
  return address.toLowerCase();
}
