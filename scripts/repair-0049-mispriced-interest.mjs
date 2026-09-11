#!/usr/bin/env node
/**
 * Correct the interest days that were priced before their own business date
 * closed.
 *
 * BACKGROUND. docs/ACCRUAL.md §16 defines the interest basis as the settled
 * ledger balance at the END of a business date. `runAccrual()` refused a
 * `bookDate` in the future and allowed `bookDate = today`, which was also the
 * cron's default — and a date that has not ended has no end-of-day balance, so
 * what the tick priced on an open date was the balance at the instant it ran.
 * `interest_day` is UNIQUE (schedule_id, accrual_date): the index that makes
 * the tick exactly-once is the index that makes a mid-day guess permanent.
 *
 * Five enrolments were priced that way on 2026-09-11 at watermarks 2262–2266.
 * Four are wrong by a material amount. One, `Holds Integration Fixture Co.`,
 * was paid 498¢ of CREDIT interest out of `5400` for a date it closed
 * $858,941.45 OVERDRAWN — a day that belongs on `4400`, in the other
 * direction. `interestPricingHorizon()` stops this recurring; migration 0049
 * makes it unrepresentable; this script is what is done about the rows that
 * already exist.
 *
 * WHAT IT REFUSES TO DO, WHICH IS THE POINT.
 *
 *   IT WILL NOT CORRECT A DAY THAT HAS NOT CLOSED.
 *
 * The re-book prices the balance the date actually closed at. Run at 11:00 on
 * the 11th, "what did the 11th close at" has no answer — and the numbers prove
 * it rather than the argument: the five closing figures measured at booking
 * watermark 5568 had already moved by 5859 a few hours later. A correction
 * computed from a moving number is a second wrong number with a better story,
 * and `interest_adjustment_after_close` (a CHECK over two columns of the
 * adjustment's own row) refuses it in the database whatever this script does.
 * So a run before midnight America/New_York reports every row as HELD and
 * posts nothing; the first run after midnight completes.
 *
 * WHAT IT DOES.
 *
 *   1. `lock_interest_schedule()`, then ask whether an adjustment already
 *      exists — the tick's own construction, because the thing on the other
 *      side of that race is a second payment.
 *   2. REVERSE the wrong entry, at its ORIGINAL value date.
 *      `assert_reversal_is_exact()` forces the negation and the date.
 *   3. Read the watermark AFTER the reversal, so the wrong entry and its
 *      reversal are both inside it and cancel exactly. The balance
 *      `ledger_settled_cents()` then returns IS the closing balance with the
 *      wrong entry removed, with no hand arithmetic anywhere.
 *   4. Re-price through the SAME pure function the tick uses, at the rate card
 *      effective on the ACCRUAL date, and RE-BOOK at that same value date.
 *   5. Write the `interest_adjustment` claim, whose trigger re-derives every
 *      one of those from the journal and refuses a cent of disagreement.
 *
 * All five steps are one transaction per day. Nothing is edited, nothing is
 * deleted, and the original posting stays exactly as written.
 *
 * WHAT IT WILL NOT TOUCH. Anything `v_interest_mispriced_uncorrected` cannot
 * see. 0048's rule: a repair that ranges over its own query can reach a row
 * the guard cannot, and then the guard is green while the repair has been
 * somewhere nobody is looking. Rows that are outside the queue are still
 * PRINTED, with the reason, so "outside this repair" never means "invisible".
 *
 *   node scripts/repair-0049-mispriced-interest.mjs             # dry run
 *   node scripts/repair-0049-mispriced-interest.mjs --apply     # append
 *   node scripts/repair-0049-mispriced-interest.mjs --limit 1
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = `${ROOT}/src/`;
const SERVER_ONLY_EMPTY = pathToFileURL(`${ROOT}/node_modules/server-only/empty.js`).href;

// The repair runs the PRODUCTION module, not a transcription of it. A repair
// script that re-implements the thing it is repairing is a second
// implementation to keep in step, and the first time they disagree the
// disagreement is a money bug nobody is looking for.
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
const { listMispricedInterestDays, runInterestAdjustments } = await import(
  `${SRC}lib/accrual/interest-adjust.ts`
);

const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg === -1 ? 200 : Number(process.argv[limitArg + 1] ?? 200);
if (!Number.isFinite(LIMIT) || LIMIT < 1) {
  console.error("--limit takes a positive number of days");
  process.exit(2);
}

const fmt = (cents) => {
  const n = BigInt(cents);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  return `${sign}$${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
};
const pad = (s, n) => String(s).padEnd(n);

const [{ book_today: TODAY }] = await sql`SELECT book_date(now())::text AS book_today`;

console.log(`\n0049 — interest days priced before their own business date closed`);
console.log(`book date today: ${TODAY}   mode: ${APPLY ? "APPLY" : "dry run"}\n`);

// ---------------------------------------------------------------------------
// 1. THE WHOLE POPULATION, not only the part this script may act on.
// ---------------------------------------------------------------------------
const marked = await sql`
  SELECT business_name, accrual_date::text AS accrual_date,
         priced_at_seq, priced_basis_cents, priced_side::text AS priced_side,
         priced_amount_cents, priced_entry_id,
         live_seq, basis_now_cents, side_now::text AS side_now, amount_now_cents,
         date_has_closed, adjustment_id
    FROM v_interest_priced_before_close
   ORDER BY accrual_date, priced_at_seq`;

console.log(`v_interest_priced_before_close — ${marked.length} row(s), all of them\n`);
console.log(
  `  ${pad("business", 30)} ${pad("date", 11)} ${pad("priced at wm", 13)} ` +
    `${pad("posted", 14)} ${pad("closes at", 15)} ${pad("owes", 14)} status`,
);
for (const r of marked) {
  const crosses = r.priced_side !== r.side_now;
  const status = r.adjustment_id
    ? "adjusted"
    : !r.date_has_closed
      ? "HELD — the date has not closed"
      : r.priced_side === r.side_now && String(r.priced_amount_cents) === String(r.amount_now_cents)
        ? "no change"
        : "TO CORRECT";
  console.log(
    `  ${pad((r.business_name ?? "—").slice(0, 29), 30)} ${pad(r.accrual_date, 11)} ` +
      `${pad(`${fmt(r.priced_basis_cents)} @${r.priced_at_seq}`, 13)} ` +
      `${pad(`${r.priced_amount_cents}c ${r.priced_side}`, 14)} ` +
      `${pad(fmt(r.basis_now_cents), 15)} ` +
      `${pad(`${r.amount_now_cents}c ${r.side_now}`, 14)} ${status}${crosses ? "  ** SIDE FLIPS **" : ""}`,
  );
}

// ---------------------------------------------------------------------------
// 2. THE QUEUE. Read through the production module, from the view.
// ---------------------------------------------------------------------------
const due = await listMispricedInterestDays(LIMIT);
console.log(`\nv_interest_mispriced_uncorrected — ${due.length} row(s) this script may act on`);

if (due.length === 0) {
  const held = marked.filter((r) => !r.date_has_closed && !r.adjustment_id).length;
  if (held > 0) {
    console.log(
      `\n  Nothing to do YET. ${held} row(s) are waiting for their own business date to close.\n` +
        `  The correction re-books what the date ACTUALLY closed at; ${TODAY} has not closed, and\n` +
        `  the closing figures above are still moving — they moved between watermark 5568 and 5859\n` +
        `  on the afternoon this was written. Correcting a mid-day price with a second mid-day price\n` +
        `  is the same defect twice, and interest_adjustment_after_close refuses it in the database.\n` +
        `  Run this again after 00:00 America/New_York.\n`,
    );
  } else {
    console.log(`\n  Nothing to do.\n`);
  }
} else if (!APPLY) {
  console.log(`\n  DRY RUN — nothing was posted. Re-run with --apply.\n`);
  for (const d of due) {
    console.log(
      `  ${d.accrualDate}  ${d.businessName ?? "—"}\n` +
        `      priced   ${fmt(d.pricedBasisCents)} @wm ${d.pricedAtSeq}  ->  ${d.pricedAmountCents}c ${d.pricedSide}  (entry ${d.pricedEntryId})\n` +
        `      closes   ${fmt(d.basisNowCents)}                 ->  ${d.amountNowCents}c ${d.sideNow}\n` +
        `      plan     reverse ${d.pricedEntryId} at value date ${d.accrualDate}, re-read the basis\n` +
        `               above the reversal, re-book on ${d.sideNow === "credit" ? "5400" : d.sideNow === "overdraft" ? "4400" : "— nothing"}\n`,
    );
  }
} else {
  const report = await runInterestAdjustments({
    runId: `repair-0049-${new Date().toISOString()}`,
    limit: LIMIT,
  });
  console.log(
    `\n  considered ${report.considered}  adjusted ${report.adjusted}  replayed ${report.replayed}` +
      `  held ${report.held}  failed ${report.failed}`,
  );
  console.log(
    `  reversed ${fmt(report.reversedCents)}   re-booked ${fmt(report.creditRebookedCents)} credit (5400)` +
      ` / ${fmt(report.overdraftRebookedCents)} overdraft (4400)\n`,
  );
  for (const d of report.days) {
    console.log(`  ${d.accrualDate}  ${d.businessName ?? "—"}  ${d.action.toUpperCase()}`);
    if (d.reversalEntryId) console.log(`      reversal  ${d.reversalEntryId}`);
    if (d.rebookEntryId) console.log(`      rebook    ${d.rebookEntryId}`);
    if (d.adjustmentId) console.log(`      claim     ${d.adjustmentId}  ${d.idempotencyKey ?? ""}`);
    if (d.correctedAmountCents !== null) {
      console.log(
        `      ${d.pricedAmountCents}c ${d.pricedSide}  ->  ${d.correctedAmountCents}c ${d.correctedSide}` +
          `  on ${fmt(d.basisBalanceCents ?? "0")} @wm ${d.repricedAtSeq}`,
      );
    }
    if (d.explanation) console.log(`      ${d.explanation}`);
    if (d.reason) console.log(`      ${d.reason}`);
  }
}

// ---------------------------------------------------------------------------
// 3. THE INVARIANTS, ASKED AFTER. `v_interest_adjustment_drift` is the price
//    of storing `amount_cents` on the adjustment at all: every stored decision
//    must still re-derive from ledger_settled_cents() at its own watermark.
// ---------------------------------------------------------------------------
const [inv] = await sql`
  SELECT (SELECT count(*) FROM v_interest_adjustment_drift)     AS adj_drift,
         (SELECT count(*) FROM v_interest_ledger_drift)         AS ledger_drift,
         (SELECT count(*) FROM v_interest_rate_drift)           AS rate_drift,
         (SELECT count(*) FROM v_interest_mispriced_uncorrected) AS queue,
         (SELECT count(*) FROM v_book_not_zero)                 AS book_not_zero`;
console.log(
  `\n  v_interest_adjustment_drift ${inv.adj_drift}   v_interest_ledger_drift ${inv.ledger_drift}` +
    `   v_interest_rate_drift ${inv.rate_drift}   v_book_not_zero ${inv.book_not_zero}` +
    `   queue remaining ${inv.queue}\n`,
);

await sql.end();
process.exit(
  Number(inv.adj_drift) + Number(inv.ledger_drift) + Number(inv.rate_drift) + Number(inv.book_not_zero) === 0
    ? 0
    : 1,
);
