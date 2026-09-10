#!/usr/bin/env node
/**
 * Send USDC on Base Sepolia, wait for the receipt, and post it to the ledger.
 *
 *   node scripts/payout-usdc.mjs                    # the payout, end to end
 *   node scripts/payout-usdc.mjs --check            # read the chain, send nothing
 *   node scripts/payout-usdc.mjs --amount 0.25
 *   node scripts/payout-usdc.mjs --to 0x…           # override the recipient
 *   node scripts/payout-usdc.mjs --settle 0x<hash>  # post a transfer already sent
 *   node scripts/payout-usdc.mjs --allow-duplicate  # send a SECOND identical payout
 *
 * Load the environment first: `set -a; . ./.env; set +a`.
 *
 * WHAT THIS IS. A stablecoin payout that actually confirms on a testnet is
 * worth far more than a slide about one, so this script does the whole thing:
 * a real ERC-20 `transfer(address,uint256)`, EIP-1559, signed on this machine
 * with `node:crypto` and 200 lines of hand-rolled curve and hash code (there is
 * no viem and no ethers in this repo, and adding one to the deployed app for a
 * payout script would be a bad trade — see scripts/faucet.mjs for the same
 * argument about the CDP SDK), broadcast with `eth_sendRawTransaction`, and
 * then WAITED ON. A submitted transaction is not a confirmed one. Nothing
 * reaches the ledger until a receipt has come back with `status: 0x1`.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN. The transaction hash is
 * `keccak256(signed raw tx)` — computable here, before a byte goes over the
 * wire — so it is printed BEFORE the broadcast and used as the ledger's
 * idempotency key. `journal_entry.idempotency_key` is UNIQUE, so a crash
 * anywhere in this script cannot produce two postings for one transfer.
 * docs/STABLECOIN.md walks the three crash points.
 *
 * MODULE LOADING, AND WHY THERE IS A LOADER HERE AT ALL. The payout logic
 * lives in src/lib/rails/stablecoin/ because it is application code that the
 * app's own typecheck and test suite cover, not script code — and the ledger
 * write MUST go through `postEntry()`, which is the only thing in this
 * codebase allowed to touch the journal. So this script has to import
 * TypeScript out of src/. Three hooks make that work, all of them doing what
 * vitest.config.ts already does for the test run:
 *
 *   - `server-only` maps to that package's own empty module (vitest maps it to
 *     test/server-only-stub.ts for the same reason). This is a terminal; the
 *     point of that marker is that the code must not reach a browser.
 *   - `@/…` resolves to src/…, and extensionless relative imports get their
 *     `.ts` back, because TypeScript's `bundler` resolution allows both and
 *     Node's resolver does not.
 *   - `.ts` sources are transpiled with the repo's own `typescript`, NOT with
 *     Node's built-in type stripping. Node 26 strips types only; it cannot
 *     handle a constructor parameter property, and `src/lib/ledger/post.ts`
 *     uses one (`constructor(readonly deltaCents: bigint)`). Stripping throws
 *     ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX on the one module this script exists
 *     to call. `typescript` is already a devDependency; nothing is added.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = `${ROOT}/src/`;
const SERVER_ONLY_EMPTY = pathToFileURL(`${ROOT}/node_modules/server-only/empty.js`).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: SERVER_ONLY_EMPTY, shortCircuit: true };
    const spec = specifier.startsWith("@/") ? pathToFileURL(SRC + specifier.slice(2)).href : specifier;
    const relative = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("file:");
    if (relative && !/\.[cm]?[jt]s$/.test(spec)) {
      const base = spec.startsWith("file:") ? spec : new URL(spec, context.parentURL).href;
      for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    });
    return { format: "module", shortCircuit: true, source: outputText };
  },
});

const { BaseRpc } = await import(`${SRC}lib/rails/stablecoin/client.ts`);
const { sendUsdcPayout, settleTransaction } = await import(`${SRC}lib/rails/stablecoin/adapter.ts`);
const { formatUsdc, payoutIdempotencyKey } = await import(`${SRC}lib/rails/stablecoin/types.ts`);
const { parsePrivateKey, addressFromPrivateKey } = await import(`${SRC}lib/rails/stablecoin/secp256k1.ts`);
const { postUsdcPayout } = await import(`${SRC}lib/rails/stablecoin/ledger.ts`);
const { sql } = await import(`${SRC}lib/ledger/db.ts`);

/* -------------------------------------------------------------------------- */
/* Arguments and configuration                                                */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};

/**
 * The default recipient is a burn address.
 *
 * Said plainly because it is a real trade-off: on a testnet, with 20 USDC and
 * a faucet behind it, an unambiguous destination that needs no key management
 * is worth more than 0.50 USDC of recoverable balance. Override it with
 * USDC_PAYOUT_RECIPIENT or --to for any address you control.
 */
const DEFAULT_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const TOKEN = process.env.USDC_CONTRACT_ADDRESS;
const SENDER = process.env.USDC_SENDER_ADDRESS;
const KEY = process.env.USDC_SENDER_PRIVATE_KEY;
const CHAIN_ID = process.env.BASE_SEPOLIA_CHAIN_ID;
const RECIPIENT = option("to", process.env.USDC_PAYOUT_RECIPIENT ?? DEFAULT_RECIPIENT);
const BUSINESS = option("business", "Ridgeline Robotics, Inc.");
const ACTOR = option("actor", "ledger-poster");
const REFERENCE = option("reference", "trial demo payout");
const SETTLE_ONLY = option("settle", null);
const CHECK_ONLY = flag("check");
const ALLOW_DUPLICATE = flag("allow-duplicate");

const missing = Object.entries({ USDC_CONTRACT_ADDRESS: TOKEN, USDC_SENDER_ADDRESS: SENDER, USDC_SENDER_PRIVATE_KEY: KEY, BASE_SEPOLIA_CHAIN_ID: CHAIN_ID })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length > 0) {
  console.error(`missing configuration: ${missing.join(", ")}\nrun:  set -a; . ./.env; set +a`);
  process.exit(2);
}

/** Decimal USDC -> integer minor units. No floats: `parseFloat("0.1")` is not 0.1. */
function parseUsdc(text) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!match) throw new Error(`not a USDC amount with at most 6 decimals: ${text}`);
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

const AMOUNT_UNITS = parseUsdc(option("amount", "0.50"));

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

const rule = (title) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
const kv = (k, v) => console.log(`  ${k.padEnd(22)}${v}`);
const explorer = (hash) => `https://sepolia.basescan.org/tx/${hash}`;

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const rpc = new BaseRpc({ url: RPC_URL });
const privateKey = parsePrivateKey(KEY);

const request = {
  tokenAddress: TOKEN,
  fromAddress: SENDER,
  toAddress: RECIPIENT,
  amountUnits: AMOUNT_UNITS,
  chainId: BigInt(CHAIN_ID),
  privateKey,
  confirmations: 1,
  receiptTimeoutMs: 180_000,
};

rule("configuration");
kv("rpc", `${new URL(RPC_URL).origin}${new URL(RPC_URL).pathname === "/" ? "" : "/<redacted path>"}`);
kv("chain id", CHAIN_ID);
kv("token", TOKEN);
kv("from", SENDER);
kv("key derives", addressFromPrivateKey(privateKey));
kv("to", RECIPIENT);
kv("amount", formatUsdc(AMOUNT_UNITS));

rule("chain, before");
const before = {
  usdc: await rpc.erc20BalanceOf(TOKEN, SENDER),
  wei: await rpc.getBalance(SENDER),
  nonceLatest: await rpc.getTransactionCount(SENDER, "latest"),
  noncePending: await rpc.getTransactionCount(SENDER, "pending"),
  recipient: await rpc.erc20BalanceOf(TOKEN, RECIPIENT),
};
kv("sender USDC", formatUsdc(before.usdc));
kv("sender gas", `${before.wei} wei`);
kv("nonce", `latest=${before.nonceLatest} pending=${before.noncePending}`);
kv("recipient USDC", formatUsdc(before.recipient));

if (CHECK_ONLY) {
  console.log("\n--check: nothing sent, nothing posted.");
  await sql.end();
  process.exit(0);
}

rule("payout");
const hooks = {
  onSigned: (txHash, raw) => {
    // BEFORE the broadcast, deliberately. If this process dies on the next
    // line, this is the handle that recovers the money:
    //   node scripts/payout-usdc.mjs --settle <hash>
    console.log(`  signed locally`);
    console.log(`  tx hash               ${txHash}   <- known BEFORE broadcast`);
    console.log(`  idempotency key       ${payoutIdempotencyKey(txHash)}`);
    console.log(`  raw bytes             ${raw.length / 2 - 1} bytes`);
    console.log(`  broadcasting ...`);
  },
  onProgress: (message) => console.log(`  ${message}`),
};

const outcome = SETTLE_ONLY
  ? await settleTransaction(rpc, request, SETTLE_ONLY.toLowerCase(), {
      recovered: true,
      nonce: -1n,
      gas: null,
      ...hooks,
    })
  : await sendUsdcPayout(rpc, request, { ...hooks, allowDuplicate: ALLOW_DUPLICATE });

rule("outcome");
kv("kind", outcome.kind.toUpperCase());

if (outcome.kind === "refused") {
  kv("reason", outcome.reason);
  kv("detail", outcome.detail);
  if (outcome.txHash) kv("tx hash", outcome.txHash);
  console.log("\nNothing was posted to the ledger. That is the correct outcome for a refusal.");
  await sql.end();
  process.exit(1);
}

kv("tx hash", outcome.txHash);
kv("explorer", explorer(outcome.txHash));

if (outcome.kind !== "confirmed") {
  if (outcome.kind === "reverted") {
    kv("receipt status", "0x0 — REVERTED");
    kv("block", outcome.receipt.blockNumber);
    kv("gas burned", `${outcome.receipt.gasCostWei} wei`);
    console.log("\nThe transaction was mined and FAILED. The gas is gone; no USDC moved.");
  } else if (outcome.kind === "reorged") {
    kv("detail", outcome.detail);
    console.log("\nThe block that carried this transfer is no longer canonical. Nothing posted.");
  } else if (outcome.kind === "unconfirmed") {
    kv("waited", `${outcome.waitedMs} ms`);
    console.log(`\nStill in the mempool. The hash above is valid — re-run with:\n  node scripts/payout-usdc.mjs --settle ${outcome.txHash}`);
  } else if (outcome.kind === "dropped") {
    console.log("\nThe node stopped knowing about this transaction. Nothing moved; re-running is safe.");
  }
  console.log("Nothing was posted to the ledger.");
  await sql.end();
  process.exit(1);
}

kv("receipt status", "0x1 — SUCCESS");
kv("recovered", outcome.recovered ? "yes — found on chain, nothing was sent this run" : "no — broadcast by this run");
kv("block", outcome.receipt.blockNumber);
kv("block hash", outcome.receipt.blockHash);
kv("block time", new Date(Number(outcome.receipt.blockTimestamp) * 1000).toISOString());
kv("gas used", `${outcome.receipt.gasUsed} @ ${outcome.receipt.effectiveGasPriceWei} wei = ${outcome.receipt.gasCostWei} wei`);

rule("chain, after");
const after = {
  usdc: await rpc.erc20BalanceOf(TOKEN, SENDER),
  wei: await rpc.getBalance(SENDER),
  recipient: await rpc.erc20BalanceOf(TOKEN, RECIPIENT),
};
kv("sender USDC", `${formatUsdc(before.usdc)}  ->  ${formatUsdc(after.usdc)}`);
kv("sender gas", `${before.wei} wei  ->  ${after.wei} wei`);
kv("recipient USDC", `${formatUsdc(before.recipient)}  ->  ${formatUsdc(after.recipient)}`);

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

rule("ledger");
const [entity] = await sql`SELECT id, code FROM book_entity ORDER BY created_at LIMIT 1`;
if (!entity) throw new Error("no book_entity — run pnpm migrate && node scripts/seed.mjs");
const [business] = await sql`SELECT id, legal_name FROM business WHERE legal_name = ${BUSINESS}`;
if (!business) throw new Error(`no business named ${BUSINESS}`);
const [actor] = await sql`SELECT id, display_name FROM actor WHERE display_name = ${ACTOR}`;
if (!actor) throw new Error(`no actor named ${ACTOR}`);

const posting = await postUsdcPayout({
  outcome,
  entityId: entity.id,
  businessId: business.id,
  actorId: actor.id,
  reference: REFERENCE,
});

kv("entity", `${entity.code} ${entity.id}`);
kv("business", `${business.legal_name} ${business.id}`);
kv("actor", `${actor.display_name} ${actor.id}`);
kv("value date", `${posting.valueDate}  (from the block timestamp, in book time)`);
kv("idempotency key", posting.idempotencyKey);
kv("entry id", posting.entryId);

const rows = await sql`
  SELECT l.ordinal, a.code, a.business_id, a.name, l.amount_cents, l.currency, l.memo
    FROM journal_line l JOIN account a ON a.id = l.account_id
   WHERE l.entry_id = ${posting.entryId}::uuid
   ORDER BY l.ordinal`;
console.log();
for (const row of rows) {
  const side = row.amount_cents > 0n ? "DR" : "CR";
  const magnitude = row.amount_cents > 0n ? row.amount_cents : -row.amount_cents;
  const code = row.business_id ? `${row.code}/${String(row.business_id).slice(0, 8)}…` : row.code;
  console.log(`  ${side} ${code.padEnd(18)} ${String(magnitude).padStart(10)} ${row.currency}   ${row.name}`);
}
const total = rows.reduce((sum, row) => sum + row.amount_cents, 0n);
console.log(`  ${" ".repeat(3)}${"balance".padEnd(18)} ${String(total).padStart(10)}       (must be 0)`);

const [duplicates] = await sql`
  SELECT count(*)::int AS n FROM journal_entry WHERE idempotency_key = ${posting.idempotencyKey}`;
console.log();
kv("entries with this key", `${duplicates.n}  (UNIQUE constraint; a re-run cannot add another)`);

console.log(`\nDone.  ${explorer(outcome.txHash)}`);
await sql.end();
