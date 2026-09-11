#!/usr/bin/env node
/**
 * Book the releases for the uncleared credits a clock already freed.
 *
 * BACKGROUND. An inbound credit is withheld until `funds_availability_policy`
 * says it is spendable. That instant arrives. `v_hold_state.is_released` flips
 * true on `now() >= hold.available_at`, `ledger_availability()` re-derives the
 * same arm and the money really does become spendable — correctly, on the
 * instant, with nothing running. The MEMO BOOK is still carrying the
 * withholding, and `v_hold_release_drift` reports exactly that, correctly and
 * immediately, and then nothing happens, because reporting is all a view can
 * do.
 *
 * Measured on this database on 2026-09-11: the guard was empty at 12:24Z and
 * 12:47Z and held THIRTEEN rows at 13:17Z. All thirteen are Plaid
 * `uncleared_credit` holds opened 22:36Z–03:39Z the night before, all thirteen
 * carry `available_at = 2026-09-11T13:00:00Z` (09:00 America/New_York), all
 * thirteen have exactly one journal entry — the opening withholding — and NONE
 * of them has a `hold_closure` row. Nothing wrote them. A clock struck.
 *
 * WHY THIS IS MECHANICAL WHERE 0036 §3 SAID IT WAS NOT. That section kept
 * `v_hold_release_drift` out of the completion sweeper because a row there can
 * mean two things — the posting never landed, or the closure should never have
 * been written — and posting the release answers the first while leaving the
 * second standing. The ambiguity exists because a closure exists. These have no
 * closure at all: `is_released` came from `now() >= available_at`, over a column
 * written once at funding on a table nothing may UPDATE. There is no act of
 * judgement to adjudicate, so there is no question for a human.
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO INVENT. Nothing in here computes an
 * amount or a date. It reads `v_uncleared_release_due` — defined FROM
 * `v_hold_release_drift` (migration 0048 §1), so it cannot range over rows the
 * guard cannot see — and calls `sweepMaturedUnclearedCredits()`, the same
 * production body `/api/cron/holds` runs:
 *
 *     write hold_closure (PRIMARY KEY (hold_id), source 'availability_sweep')
 *     balance := memo_balance(hold)     the journal's own answer, in the tx
 *     append −balance                   at book_date(available_at), if non-zero
 *
 * APPEND ONLY. No UPDATE, no DELETE, no second mechanism for moving the memo
 * book. The entry carries `hold:<hold_id>:after:availability:<available_at>` —
 * byte-identical to the key `releaseAvailableCredits()` builds — so the two
 * triggers are ONE append and neither can race a second entry in beside the
 * other.
 *
 * THE VALUE DATE IS THE POLICY'S, NOT TODAY'S. `book_date(available_at)`, the
 * day the money actually became available, derived from immutable data and
 * identical on every run for ever. `releaseAvailableCredits()` books at the
 * date the sweeper happened to run; every ACH maturity on this book is at 09:00
 * ET and both scheduled triggers fire before it, so that date is guaranteed to
 * be the following banking day, and the statement for the release day would
 * show money withheld that the policy had freed.
 *
 * WHAT IT WILL NOT TOUCH. Every other row of `v_hold_release_drift`: a card
 * hold, whose release folds over `card_auth_event` and whose INPUT can be wrong
 * (0026, 0032), and any hold carrying a closure somebody wrote, where 0036 §3's
 * question is live and `scripts/repair-0011-spurious-closures.mjs` is where a
 * human answers it. The counts are printed below either way, so "outside this
 * repair" never means "invisible".
 *
 *   node scripts/repair-0048-uncleared-release.mjs             # dry run
 *   node scripts/repair-0048-uncleared-release.mjs --apply     # append
 *   node scripts/repair-0048-uncleared-release.mjs --min-age 60
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
const { findUnclearedReleasesDue, sweepMaturedUnclearedCredits } = await import(
  `${SRC}lib/holds/availability.ts`
);

const APPLY = process.argv.includes("--apply");
const minAgeArg = process.argv.indexOf("--min-age");
const MIN_AGE = minAgeArg === -1 ? 0 : Number(process.argv[minAgeArg + 1] ?? 0);
if (!Number.isFinite(MIN_AGE) || MIN_AGE < 0) {
  console.error("--min-age takes a non-negative number of seconds");
  process.exit(2);
}

const fmt = (cents) => {
  const n = BigInt(cents);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  return `${sign}$${(abs / 100n).toString()}.${(abs % 100n).toString().padStart(2, "0")}`;
};
const age = (seconds) =>
  seconds < 90 ? `${Math.round(seconds)}s` : seconds < 5400 ? `${Math.round(seconds / 60)}m` : `${(seconds / 3600).toFixed(1)}h`;

const [guard] = await sql`SELECT count(*)::int AS n FROM v_hold_release_drift`;
const due = await findUnclearedReleasesDue({ minAgeSeconds: MIN_AGE, limit: 500 });

// The residue, named rather than implied. 0040's lesson and 0047's: "outside
// the guard" must never be allowed to mean "unexamined".
const [residue] = await sql`
  SELECT count(*) FILTER (WHERE d.kind <> 'uncleared_credit')::int AS not_uncleared,
         count(*) FILTER (
           WHERE d.kind = 'uncleared_credit'
             AND EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = d.hold_id))::int AS has_closure
    FROM v_hold_release_drift d`;

console.log(`v_hold_release_drift reports ${guard.n} hold(s).`);
console.log(`v_uncleared_release_due, age >= ${MIN_AGE}s, reports ${due.length}.`);
console.log(
  `left with the guard: ${residue.not_uncleared} card hold(s) and ` +
    `${residue.has_closure} uncleared hold(s) carrying a closure somebody wrote — ` +
    `see scripts/repair-0011-spurious-closures.mjs.\n`,
);

if (due.length === 0) {
  console.log("Nothing to release.");
  await sql.end();
  process.exit(guard.n === 0 ? 0 : 1);
}

for (const row of due) {
  console.log(
    `  RELEASE ${row.holdId}\n` +
      `          ${fmt(row.memoBalanceCents)} still withheld in the memo book, freed by the clock ` +
      `${age(row.ageSeconds)} ago\n` +
      `          available_at ${row.availableAt.toISOString()} -> value date ${row.releaseValueDate} ` +
      `(credit value date ${row.creditValueDate}, rail ${row.rail ?? "(none)"})\n` +
      `          ${row.externalRef}`,
  );
}

const owed = due.reduce((n, r) => n + r.memoBalanceCents, 0n);
console.log(
  `\n${due.length} hold(s), ${fmt(owed)} already spendable by the customer and still shown as withheld ` +
    `in the memo book.`,
);

if (!APPLY) {
  console.log("Dry run. Re-run with --apply to append the releases.");
  await sql.end();
  process.exit(0);
}

const holdIds = due.map((r) => r.holdId);
const result = await sweepMaturedUnclearedCredits({ minAgeSeconds: MIN_AGE, limit: 500 });

console.log(
  `\nexamined ${result.examined}   closed ${result.closed}   released ${result.released}   ` +
    `returned ${fmt(result.releasedCents)}`,
);
for (const f of result.failures) console.log(`  FAILED ${f.holdId}: ${f.error}`);

// The entries this run appended, read back from the database rather than from
// the return value: a repair that reports what it meant to write is not
// evidence of what it wrote.
const appended = await sql`
  SELECT e.id, e.value_date::text AS value_date, e.booking_seq, e.idempotency_key, e.hold_id,
         (SELECT l.amount_cents * a.normal_side
            FROM journal_line l JOIN account a ON a.id = l.account_id
            JOIN hold h ON h.id = e.hold_id
           WHERE l.entry_id = e.id AND l.account_id = h.memo_account_id) AS memo_cents
    FROM journal_entry e
   WHERE e.hold_id = ANY(${holdIds}::uuid[])
     AND e.idempotency_key LIKE 'hold:%:after:availability:%'
   ORDER BY e.booking_seq`;
if (appended.length > 0) {
  console.log("\nEntries appended by this repair, read back from the book:");
  for (const e of appended) {
    console.log(
      `  ${e.id}  seq ${e.booking_seq}  value date ${e.value_date}  ${fmt(e.memo_cents)}  hold ${e.hold_id}`,
    );
  }
}

const [live] = await sql`SELECT count(*)::int AS n FROM v_hold_drift`;
const [rel] = await sql`SELECT count(*)::int AS n FROM v_hold_release_drift`;
const [notterm] = await sql`SELECT count(*)::int AS n FROM v_hold_closure_not_terminal`;
const [queue] = await sql`SELECT count(*)::int AS n FROM v_uncleared_release_due`;
console.log(
  `\nv_hold_drift: ${live.n}   v_hold_release_drift: ${rel.n}   ` +
    `v_hold_closure_not_terminal: ${notterm.n}   v_uncleared_release_due: ${queue.n}   (all four must be 0)`,
);
await sql.end();
process.exit(
  live.n === 0 && rel.n === 0 && notterm.n === 0 && queue.n === 0 && result.failures.length === 0 ? 0 : 1,
);
