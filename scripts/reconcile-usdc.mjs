#!/usr/bin/env node
/**
 * Reconcile the USDC control account against the actual blockchain.
 *
 * This is the only reconciliation in the system whose counterparty is a public
 * ledger anyone can read, so it is the one that cannot be argued with: either
 * `1140` equals what the wallet holds on Base Sepolia, or the books are wrong
 * about money that exists.
 *
 * IT HAS NOW BEEN WRONG ITSELF, WHICH IS THE MORE INTERESTING FAILURE. When a
 * second stablecoin provider went live, USDC started living in TWO wallets we
 * control — the direct-signing treasury wallet and Circle's developer-controlled
 * wallet — while `1140` remained ONE omnibus account representing all of it.
 * This script read a single address and reported a 90-cent drift against a
 * ledger that was exactly right.
 *
 * A reconciliation that knows about fewer accounts than the control account
 * covers does not report "I am incomplete", it reports "you are wrong", and it
 * is most confident precisely when a new venue has just been added. So the
 * addresses are enumerated from configuration below, and adding a provider
 * without adding its wallet here is meant to be conspicuous.
 *
 * It caught a real gap first. 1140 read -$0.50 against a wallet holding 19.50 USDC,
 * because the 20.00 USDC the wallet was funded with by the Circle faucet had
 * never been booked — an asset that appeared with no corresponding credit. The
 * account had funded a payout it was never funded for.
 *
 * WHAT IS WORTH NOTICING is that no invariant caught it. `v_book_not_zero`,
 * `v_entry_unbalanced` and the hash chain were all green throughout, because
 * the entry that credited 1140 was itself perfectly balanced. Those checks ask
 * whether the books are internally consistent. This one asks whether they are
 * true. A system can be flawlessly self-consistent about a wallet that holds
 * something else entirely, and only an external counterparty can say so.
 *
 * Exits non-zero on any difference, so it can gate a release.
 *
 *   node scripts/reconcile-usdc.mjs
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


const { sql } = await import(`${SRC}lib/ledger/db.ts`);

const RPC = process.env.BASE_SEPOLIA_RPC_URL;
const TOKEN = process.env.USDC_CONTRACT_ADDRESS;
const WALLET = process.env.USDC_SENDER_ADDRESS;
if (!RPC || !TOKEN || !WALLET) {
  console.error("BASE_SEPOLIA_RPC_URL / USDC_CONTRACT_ADDRESS / USDC_SENDER_ADDRESS must be set");
  process.exit(2);
}

/** balanceOf(address) — selector 70a08231, address left-padded to 32 bytes. */
async function balanceOf(address) {
  const data = `0x70a08231${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: TOKEN, data }, "latest"] }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`eth_call: ${JSON.stringify(body.error)}`);
  return BigInt(body.result);
}

/**
 * Every wallet `1140` represents.
 *
 * The direct path signs from `USDC_SENDER_ADDRESS`. Circle's Web3 Services
 * holds a developer-controlled wallet of its own, and money sitting in it is
 * still ours and still on that account. Discovered from Circle rather than
 * pinned in env, so a wallet created after this was written is still counted.
 */
async function walletsOfRecord() {
  const wallets = [{ label: "direct (treasury)", address: WALLET }];
  const key = process.env.CIRCLE_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://api.circle.com/v1/w3s/wallets", {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) {
        const body = await res.json();
        for (const w of body?.data?.wallets ?? []) {
          if (w.address) wallets.push({ label: `circle ${w.id?.slice(0, 8) ?? ""}`.trim(), address: w.address });
        }
      } else {
        wallets.push({ label: "circle", address: null, note: `wallet list unavailable (${res.status})` });
      }
    } catch (thrown) {
      wallets.push({ label: "circle", address: null, note: `unreachable: ${String(thrown).slice(0, 60)}` });
    }
  }
  return wallets;
}

const [row] = await sql`
  SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS bal
    FROM account a LEFT JOIN journal_line l ON l.account_id = a.id
   WHERE a.code = '1140' AND a.business_id IS NULL`;
const ledgerCents = BigInt(row?.bal ?? 0);

const wallets = await walletsOfRecord();
let units = 0n;
let incomplete = false;
for (const w of wallets) {
  if (!w.address) {
    // A venue we know about but could not read. Say so and FAIL, rather than
    // quietly reconciling against a subset and calling the remainder drift.
    console.log(`  ${w.label.padEnd(20)} ${"—".padStart(10)}         ${w.note}`);
    incomplete = true;
    continue;
  }
  const held = await balanceOf(w.address);
  units += held;
  console.log(`  ${w.label.padEnd(20)} ${String(held / 10_000n).padStart(10)} cents   (${Number(held) / 1e6} USDC)  ${w.address}`);
}

const chainCents = units / 10_000n;          // carried at 1 USDC = 100 cents
const dust = units % 10_000n;                // sub-cent, which 2900 exists for

console.log(`  ${"-".repeat(70)}`);
console.log(`  ledger 1140       ${String(ledgerCents).padStart(10)} cents`);
console.log(`  on chain, total   ${String(chainCents).padStart(10)} cents   (${Number(units) / 1e6} USDC, ${wallets.length} wallet(s))`);
if (dust !== 0n) console.log(`  sub-cent dust     ${String(dust).padStart(10)} units  (belongs to 2900)`);
console.log(`  difference        ${String(ledgerCents - chainCents).padStart(10)} cents`);

const ok = ledgerCents === chainCents && !incomplete;
console.log(ok ? "\n  RECONCILES — the books agree with the chain" : "\n  DRIFT — the books disagree with money that exists");
await sql.end();
process.exit(ok ? 0 : 1);
