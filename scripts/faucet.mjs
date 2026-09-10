#!/usr/bin/env node
/**
 * Request Base Sepolia gas from the Coinbase CDP faucet.
 *
 * WHY THIS EXISTS AT ALL. The USDC payout adapter, its idempotent send and its
 * ledger posting were finished and tested long before this script. The only
 * thing standing between them and a transaction hash on a public chain was
 * ~390,000,000,000 wei of gas, and the CDP portal would not load in an
 * automated browser. So the faucet is called the same way everything else in
 * this repo is called: over its API, with a real credential, and the result
 * read back off the chain rather than believed.
 *
 * NO SDK ON PURPOSE. `@coinbase/cdp-sdk` would do the JWT for us, but adding a
 * runtime dependency to the deployed app so that a one-off ops script can mint
 * a token is a bad trade. CDP secret API keys are raw Ed25519 (32-byte seed +
 * 32-byte public key, base64), and node can sign with those directly once the
 * seed is wrapped in the 16-byte PKCS#8 prefix for Ed25519. That is the only
 * clever line in the file and it is commented where it happens.
 *
 *   node scripts/faucet.mjs                 # request gas, then verify on chain
 *   node scripts/faucet.mjs --check         # read balances only, request nothing
 */
import { createPrivateKey, randomBytes, sign as edSign } from "node:crypto";

const KEY_ID = process.env.CDP_API_KEY_ID;
const KEY_SECRET = process.env.CDP_API_KEY_SECRET;
const ADDRESS = process.env.USDC_SENDER_ADDRESS;
const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const USDC = process.env.USDC_CONTRACT_ADDRESS;
const CHECK_ONLY = process.argv.includes("--check");

const HOST = "api.cdp.coinbase.com";
const PATH = "/platform/v2/evm/faucet";

if (!ADDRESS) { console.error("USDC_SENDER_ADDRESS is not set"); process.exit(1); }

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** An EdDSA JWT for one specific method+path, valid for two minutes. */
function bearer() {
  if (!KEY_ID || !KEY_SECRET) throw new Error("CDP_API_KEY_ID / CDP_API_KEY_SECRET are not set");
  const raw = Buffer.from(KEY_SECRET, "base64");
  if (raw.length !== 64) {
    throw new Error(`CDP_API_KEY_SECRET decoded to ${raw.length} bytes; an Ed25519 CDP key is 64 (32 seed + 32 public)`);
  }
  // PKCS#8 wrapper for a raw Ed25519 seed. node will not build a KeyObject
  // from 32 loose bytes, and this prefix is fixed for every Ed25519 key:
  //   SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING { ... } }
  const pkcs8 = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    raw.subarray(0, 32),
  ]);
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "EdDSA", kid: KEY_ID, typ: "JWT", nonce: randomBytes(16).toString("hex") };
  const claims = {
    sub: KEY_ID,
    iss: "cdp",
    aud: ["cdp_service"],
    nbf: now,
    exp: now + 120,
    // Scoped to exactly the call being made. A leaked token is worth one
    // faucet request on one host for two minutes.
    uris: [`POST ${HOST}${PATH}`],
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = edSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(sig)}`;
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function balances() {
  const wei = BigInt(await rpc("eth_getBalance", [ADDRESS, "latest"]));
  let usdc = 0n;
  if (USDC) {
    // balanceOf(address) — selector 70a08231, address left-padded to 32 bytes
    const data = `0x70a08231${ADDRESS.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
    usdc = BigInt(await rpc("eth_call", [{ to: USDC, data }, "latest"]));
  }
  const gasPrice = BigInt(await rpc("eth_gasPrice", []));
  const needed = 65_000n * gasPrice;
  return { wei, usdc, gasPrice, needed };
}

const before = await balances();
console.log(`address   ${ADDRESS}`);
console.log(`gas       ${before.wei} wei`);
console.log(`usdc      ${Number(before.usdc) / 1e6} USDC`);
console.log(`a send needs ~${before.needed} wei at ${before.gasPrice} wei/gas`);
console.log(`fundable  ${before.wei >= before.needed}`);

if (CHECK_ONLY) process.exit(before.wei >= before.needed ? 0 : 1);
if (before.wei >= before.needed) {
  console.log("\nAlready funded. Requesting nothing.");
  process.exit(0);
}

console.log(`\nPOST https://${HOST}${PATH} ...`);
const res = await fetch(`https://${HOST}${PATH}`, {
  method: "POST",
  headers: { authorization: `Bearer ${bearer()}`, "content-type": "application/json" },
  body: JSON.stringify({ address: ADDRESS, network: "base-sepolia", token: "eth" }),
});
const body = await res.text();
console.log(`-> ${res.status} ${body.slice(0, 400)}`);
if (!res.ok) process.exit(1);

let txHash;
try { txHash = JSON.parse(body).transactionHash; } catch { /* printed above */ }
if (txHash) console.log(`faucet tx ${txHash}`);

// Read the answer off the chain rather than trusting the 200.
for (let i = 0; i < 30; i++) {
  const now = await balances();
  if (now.wei > before.wei) {
    console.log(`\ngas ${before.wei} -> ${now.wei} wei`);
    console.log(`fundable  ${now.wei >= now.needed}   (needs ${now.needed})`);
    process.exit(now.wei >= now.needed ? 0 : 1);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("\nfaucet accepted the request but the balance has not moved in 60s");
process.exit(1);
