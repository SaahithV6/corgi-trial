#!/usr/bin/env node
/**
 * Finish the card holds whose opening memo posting never landed.
 *
 * BACKGROUND. A card authorisation arrives, the facts commit, and the memo
 * entry that withholds the money does not. The fold over the card events says
 * $50 is authorised; the memo book says nothing is held; the customer can spend
 * money a merchant is going to claim. `v_hold_drift` reports it immediately and
 * correctly, and then nothing happens, because reporting is all a view can do.
 *
 * The drift is in the CUSTOMER'S FAVOUR, which is the direction nobody
 * complains about and therefore the direction that survives longest. The four
 * holds this script was written for stood for between eleven minutes and an
 * hour with nobody watching, and would have stood for seven days: at
 * `expires_at` the clock flips `v_card_auth_hold.is_closed`, `v_hold_drift`'s
 * `WHERE NOT is_released` stops matching, and the row leaves the guard without
 * the money ever having been withheld.
 *
 * WHAT IT DOES, AND WHAT IT REFUSES TO INVENT. Nothing in here computes an
 * amount. It reads `v_hold_posting_incomplete` — which is defined FROM
 * `v_hold_drift`, so it cannot see fewer holds than the invariant does — and
 * calls `sweepIncompleteHoldPostings()`, which calls `settleHoldPosting()`,
 * which is the same compare-and-append `apply.ts` and `expiry.ts` use:
 *
 *     lock the authorisation
 *     H_new := H(E)                 recomputed from the database, under the lock
 *     H_cur := memo_balance(hold)   the journal's own answer, under the lock
 *     append H_new − H_cur          at the ORIGINAL value date, if non-zero
 *
 * APPEND ONLY. No UPDATE, no DELETE, no second mechanism for moving the memo
 * book. The entry carries `hold:<hold_id>:after:<provider_event_id>` — the key
 * the lost delivery would have used — so if that delivery is ever redelivered,
 * `apply.ts` computes Δ = 0 and appends nothing rather than racing a second
 * entry in beside this one. The value date is the event's, never today's,
 * because the day the money should have been withheld is the day the statement
 * has to show it.
 *
 * SAFE WHILE A DELIVERY IS IN FLIGHT. Not by waiting — by the row lock. Two
 * processors on one authorisation cannot both see `H_cur` and both post: one
 * computes Δ and the other computes Δ = 0. `--min-age` exists so an operator
 * can ask for only the ones nothing is coming for (measured in-process window:
 * 342ms p50, 2.1s p95). It defaults to 0, because a default that skipped rows
 * would be one more guard excluding the state it exists to catch.
 *
 * WHAT IT WILL NOT TOUCH. `v_hold_release_drift` — a RELEASED hold that still
 * withholds money — is out of scope and that is a decision, not an oversight.
 * Posting the release there would silence 0011's alarm while leaving a false
 * closure standing in an append-only audit table. See migration 0036 §3 and
 * `scripts/repair-0011-spurious-closures.mjs`, where that judgement is made by
 * a human, one hold at a time.
 *
 *   node scripts/repair-0036-missing-memo.mjs                 # dry run
 *   node scripts/repair-0036-missing-memo.mjs --apply         # append
 *   node scripts/repair-0036-missing-memo.mjs --min-age 60    # only the stuck ones
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
const { findIncompleteHoldPostings, sweepIncompleteHoldPostings } = await import(
  `${SRC}lib/holds/completion.ts`
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

const [guard] = await sql`SELECT count(*)::int AS n FROM v_hold_drift`;
const due = await findIncompleteHoldPostings({ minAgeSeconds: MIN_AGE, limit: 500 });

console.log(`v_hold_drift reports ${guard.n} hold(s).`);
console.log(
  `v_hold_posting_incomplete, age >= ${MIN_AGE}s, reports ${due.length}.\n`,
);

if (due.length === 0) {
  console.log("Nothing to complete.");
  await sql.end();
  process.exit(guard.n === 0 ? 0 : 1);
}

// The provenance columns are the whole reason the view carries them: an
// operator looking at one row cannot otherwise tell a delivery in flight from a
// hold nothing will ever finish, and those need different responses.
for (const row of due) {
  const origin = !row.throughApply
    ? "NOT through ensureAuthorization() — written directly, nothing will post this later"
    : row.fromWebhook
      ? "webhook-borne; a delivery exists behind these facts"
      : "through apply.ts, no inbox row — a direct applyCardTransaction() call";
  console.log(
    `  COMPLETE ${row.identity.holdId} (${row.providerAuthId})\n` +
      `           memo ${row.memoBalanceCents} target ${row.targetHoldCents} ` +
      `missing ${fmt(row.missingCents)} at value date ${row.lastEventValueDate}, age ${age(row.ageSeconds)}\n` +
      `           ${origin}`,
  );
}

const owed = due.reduce((n, r) => n + r.missingCents, 0n);
console.log(
  `\n${due.length} hold(s), ${fmt(owed)} authorised and NOT withheld — spendable by the customer right now.`,
);

if (!APPLY) {
  console.log("Dry run. Re-run with --apply to append the postings.");
  await sql.end();
  process.exit(0);
}

const result = await sweepIncompleteHoldPostings({ minAgeSeconds: MIN_AGE, limit: 500 });

console.log(
  `\nexamined ${result.examined}   completed ${result.completed}   already done ${result.alreadyDone}   ` +
    `withheld ${fmt(result.withheldCents)}`,
);
for (const f of result.failures) console.log(`  FAILED ${f.holdId}: ${f.error}`);

// The entries this run appended, read back from the database rather than from
// the return value: a repair that reports what it meant to write is not
// evidence of what it wrote.
const appended = await sql`
  SELECT e.id, e.value_date::text AS value_date, e.idempotency_key, e.description,
         (SELECT l.amount_cents * a.normal_side
            FROM journal_line l JOIN account a ON a.id = l.account_id
            JOIN hold h ON h.id = e.hold_id
           WHERE l.entry_id = e.id AND l.account_id = h.memo_account_id) AS memo_cents
    FROM journal_entry e
   WHERE e.description LIKE 'Card hold posting completed by sweep %'
   ORDER BY e.booking_seq`;
if (appended.length > 0) {
  console.log("\nEntries appended by this repair, read back from the book:");
  for (const e of appended) {
    console.log(`  ${e.id}  ${e.value_date}  ${fmt(e.memo_cents)}  ${e.idempotency_key}`);
  }
}

const [live] = await sql`SELECT count(*)::int AS n FROM v_hold_drift`;
const [rel] = await sql`SELECT count(*)::int AS n FROM v_hold_release_drift`;
const [notterm] = await sql`SELECT count(*)::int AS n FROM v_hold_closure_not_terminal`;
console.log(
  `\nv_hold_drift: ${live.n}   v_hold_release_drift: ${rel.n}   v_hold_closure_not_terminal: ${notterm.n}   (all three must be 0)`,
);
await sql.end();
process.exit(live.n === 0 && rel.n === 0 && notterm.n === 0 && result.failures.length === 0 ? 0 : 1);
