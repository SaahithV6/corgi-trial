#!/usr/bin/env node
/**
 * Book the opening USDC the wallet was funded with, so 1140 reconciles.
 *
 * THE PROBLEM THIS FIXES. `1140 USDC omnibus wallet` read **-$0.50** against a
 * wallet holding 19.50 USDC on chain. The payout debited a customer and
 * credited 1140 correctly; what was never booked is where the 20.00 USDC in
 * that wallet CAME FROM. It arrived from the Circle testnet faucet and simply
 * appeared.
 *
 * An asset that appears with no corresponding credit is the one thing
 * double-entry exists to make impossible, and the account went negative
 * because it had funded a payout it had never been funded for. Every invariant
 * in the system stayed green throughout — the entry that credited 1140 was
 * itself perfectly balanced — which is worth noticing: `v_book_not_zero`
 * checks that the books net to zero, not that every asset has a provenance.
 *
 * A faucet grant is not income, because we did not earn it, and not a
 * liability, because nobody will ask for it back. It is a capital contribution
 * from outside the business, so it credits `3200 Contributed capital — testnet
 * funding`, named so it can never be read as real money raised.
 *
 * Idempotent on `idempotency_key`, UNIQUE on journal_entry: running it twice
 * posts once.
 *
 *   node scripts/book-usdc-funding.mjs           # dry run
 *   node scripts/book-usdc-funding.mjs --apply
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
const { postEntry } = await import(`${SRC}lib/ledger/post.ts`);

const APPLY = process.argv.includes("--apply");

/** What the faucet granted, in cents at 1 USDC = 100 cents. */
const FUNDED_CENTS = 2000n;
const KEY = "usdc:opening-funding:circle-faucet";

const balanceOf = async (code) => {
  const [row] = await sql`
    SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS bal
      FROM account a LEFT JOIN journal_line l ON l.account_id = a.id
     WHERE a.code = ${code} AND a.business_id IS NULL`;
  return row?.bal ?? 0n;
};

const [existing] = await sql`SELECT id FROM journal_entry WHERE idempotency_key = ${KEY}`;
if (existing) {
  console.log(`already booked as ${existing.id}; 1140 = ${await balanceOf("1140")} cents`);
  await sql.end();
  process.exit(0);
}

const [entity] = await sql`SELECT id FROM book_entity LIMIT 1`;
const [wallet] = await sql`SELECT id FROM account WHERE code = '1140' AND business_id IS NULL`;
const [capital] = await sql`SELECT id FROM account WHERE code = '3200' AND business_id IS NULL`;
if (!wallet || !capital) throw new Error("1140 or 3200 missing; run node scripts/seed.mjs");

console.log(`1140 before: ${await balanceOf("1140")} cents`);
console.log(`3200 before: ${await balanceOf("3200")} cents`);

if (!APPLY) {
  console.log(`would post DR 1140 ${FUNDED_CENTS} / CR 3200 ${FUNDED_CENTS} at value date 2026-09-09`);
  console.log("dry run; re-run with --apply");
  await sql.end();
  process.exit(0);
}

const [actor] = await sql`
  SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
if (!actor) throw new Error("no 'ledger-poster' system actor; run node scripts/seed.mjs");

const entryId = await postEntry(
  {
    entityId: entity.id,
    book: "financial",
    // The date the wallet was funded, not today. Booking it today would say
    // the business was capitalised after it had already made a payment.
    valueDate: "2026-09-09",
    entryType: "original",
    rail: "usdc",
    description: "Opening USDC funding — Circle testnet faucet, 20.000000 USDC",
    idempotencyKey: KEY,
    actorId: actor.id,
    lines: [
      { accountId: wallet.id, amountCents: FUNDED_CENTS, currency: "USD", ordinal: 0 },
      { accountId: capital.id, amountCents: -FUNDED_CENTS, currency: "USD", ordinal: 1 },
    ],
  },
  sql,
);

console.log(`posted ${entryId}`);
console.log(`1140 after:  ${await balanceOf("1140")} cents`);
console.log(`3200 after:  ${await balanceOf("3200")} cents`);
await sql.end();
