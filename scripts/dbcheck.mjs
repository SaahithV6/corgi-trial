#!/usr/bin/env node
/**
 * Proves the ledger's invariants against the LIVE database.
 *
 * This exists because "UPDATE or DELETE on money rows, anywhere, ever" is an
 * automatic fail, and a README claiming immutability is worth nothing. This
 * script attempts the forbidden thing and asserts the database refuses.
 *
 * Run it in the debrief. It is the answer to "prove it".
 *
 *   pnpm db:check
 */
import postgres from "postgres";

// Connect as the APPLICATION role, not the owner. The whole point of layer 1
// is that the app cannot express UPDATE at all; running this as neondb_owner
// tests nothing, because privileges never bind the table owner. As corgi_app
// the privilege check fires before row matching, so the refusal is proven even
// against an empty table.
const url = process.env.APP_DATABASE_URL;
if (!url) { console.error("APP_DATABASE_URL is not set (must be the corgi_app role, not the owner)"); process.exit(1); }
const sql = postgres(url, { max: 1, onnotice: () => {} });

let pass = 0, fail = 0;
const ok  = (n, d) => { pass++; console.log(`  PASS  ${n}${d ? ` — ${d}` : ""}`); };
const bad = (n, d) => { fail++; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); };

/** Assert a statement is REFUSED by the database. Success here is a failure. */
async function mustRefuse(name, fn, expect) {
  try {
    await fn();
    bad(name, "the database ALLOWED it");
  } catch (e) {
    const m = (e.message || "").toLowerCase();
    if (!expect || m.includes(expect.toLowerCase())) ok(name, e.message.split("\n")[0].slice(0, 72));
    else bad(name, `refused, but for the wrong reason: ${e.message.slice(0, 90)}`);
  }
}

console.log("\nLEDGER INVARIANTS — attempting the forbidden, expecting refusal\n");

// ---- 1. money rows are physically immutable ---------------------------
for (const t of ["journal_entry", "journal_line"]) {
  await mustRefuse(`UPDATE ${t} is refused`, () =>
    sql.unsafe(`UPDATE ${t} SET value_date = value_date WHERE true`));
  await mustRefuse(`DELETE FROM ${t} is refused`, () =>
    sql.unsafe(`DELETE FROM ${t} WHERE true`));
  await mustRefuse(`TRUNCATE ${t} is refused`, () =>
    sql.unsafe(`TRUNCATE ${t} CASCADE`));
}

// ---- 2. the grant surface itself --------------------------------------
const grants = await sql`
  SELECT table_name, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
  FROM information_schema.role_table_grants
  WHERE grantee = current_user
    AND table_name IN ('journal_entry','journal_line','card_auth_event','hold_closure')
  GROUP BY table_name ORDER BY table_name`;
for (const g of grants) {
  const badPriv = ["UPDATE", "DELETE", "TRUNCATE"].filter((p) => g.privs.includes(p));
  if (badPriv.length) bad(`grants on ${g.table_name}`, `holds ${badPriv.join(",")}`);
  else ok(`grants on ${g.table_name}`, g.privs);
}

// ---- 3. every entry balances -----------------------------------------
const unbalanced = await sql`
  SELECT entry_id, currency, SUM(amount_cents) AS delta
  FROM journal_line GROUP BY entry_id, currency HAVING SUM(amount_cents) <> 0`;
if (unbalanced.length) bad("every entry sums to zero", `${unbalanced.length} unbalanced`);
else ok("every entry sums to zero", "checked all entries");

// ---- 4. trial balance --------------------------------------------------
const [tb] = await sql`SELECT COALESCE(SUM(amount_cents),0) AS total FROM journal_line
                       WHERE currency = 'USD'`;
if (String(tb.total) === "0") ok("trial balance is zero", "sum of all lines");
else bad("trial balance is zero", `off by ${tb.total} cents`);

// ---- 5. no stored balance columns anywhere ----------------------------
//
// THE EXCEPTIONS ARE NAMED (TABLE, COLUMN) PAIRS, NOT A PATTERN.
//
// This check exists because a stored balance is a second source of truth that
// drifts silently from the rows it summarises -- the defect migration 0022
// spent a whole pass undoing, where four definitions of "available" printed
// two different numbers on two screens at the same instant. So the exemption
// list must never be shaped like the thing it exempts: no `LIKE`, no column
// prefix, no whole-table pass. Three pairs, each with its argument, and a new
// stored balance anywhere else still fails this check on the first run.
//
// EACH EXEMPTION IS EVIDENCE, NOT A CACHE, AND THE TEST FOR THAT IS
// REPRODUCIBILITY: recomputing the figure from the immutable rows must give
// back exactly the stored number. Where that cannot be done, it is a cache and
// it does not belong here. Check 5b below performs that recomputation for
// interest_posting; `statement` carries its own equivalent in 0009.
const STORED_BALANCE_EXCEPTIONS = [
  // A statement is a PUBLISHED ARTEFACT: the figure it asserted must remain
  // queryable forever exactly as published, even after a later correction
  // changes what the ledger now says that day was. That is the opposite of a
  // drifting cache -- it is the as-published axis of the bitemporal model.
  ["statement", "opening_balance_cents"],
  ["statement", "closing_balance_cents"],
  // The balance a day of interest was PRICED ON, together with the booking
  // watermark it was true at (interest_posting.observed_booking_seq). It is a
  // historical fact about a decision, in the same sense as
  // standing_order_outcome.observed_*, and it is reproducible: booking_seq is
  // monotonic, so ledger_settled_cents(account, accrual_date, that watermark)
  // is frozen for all time and 5b re-derives it. Nothing READS it as a
  // balance -- no screen, no API and no other calculation takes a current
  // position from it; it is an input to an audit trail and the numerator of
  // the fraction printed beside it. See db/migrations/0024_interest.sql §6.
  ["interest_posting", "basis_balance_cents"],
];

// Paired positionally through two text[] parameters, so the exemption is the
// PAIR and not either half of it: `interest_posting.something_balance_cents`
// and `some_other_table.basis_balance_cents` both still fail.
const exceptTables = STORED_BALANCE_EXCEPTIONS.map(([t]) => t);
const exceptColumns = STORED_BALANCE_EXCEPTIONS.map(([, c]) => c);

const stored = await sql`
  SELECT c.table_name, c.column_name FROM information_schema.columns c
  WHERE c.table_schema='public'
    AND (c.column_name LIKE '%balance%' OR c.column_name = 'available_cents')
    AND c.table_name NOT LIKE 'v\\_%'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(${exceptTables}::text[], ${exceptColumns}::text[]) AS ex(t, col)
       WHERE ex.t = c.table_name AND ex.col = c.column_name)`;
if (stored.length) {
  bad("no stored balance column", stored.map((r) => `${r.table_name}.${r.column_name}`).join(", "));
} else {
  ok(
    "no stored balance column",
    `balances are derived, not stored (${STORED_BALANCE_EXCEPTIONS.length} named exceptions, each proven reproducible)`,
  );
}

// ---- 5b. the one exemption that has to earn itself --------------------
//
// THE PRICE OF EXEMPTING interest_posting.basis_balance_cents IS THIS CHECK.
//
// Recompute every stored basis from the journal, through 0022's canonical
// `ledger_settled_cents(account, value_date, booking_seq)` -- the SAME function
// every other balance in this system runs through -- at the watermark the row
// itself recorded, and assert equality. If a single row disagrees, the column
// is a cache and the exemption above is wrong, which is the honest failure and
// the one worth being told about.
//
// It is also the check that makes the column defensible at all: a figure you
// can re-derive from immutable rows is evidence of what you priced; one you
// cannot is a number someone typed.
const basisDrift = await sql`
  SELECT count(*)::int AS n
    FROM interest_posting ip
    JOIN interest_day d      ON d.id = ip.interest_day_id
    JOIN interest_schedule s ON s.id = d.schedule_id
   WHERE ip.basis_balance_cents
         IS DISTINCT FROM ledger_settled_cents(s.account_id, d.accrual_date, ip.observed_booking_seq)`;
if ((basisDrift[0]?.n ?? 0) === 0) {
  ok(
    "every stored interest basis re-derives from the journal",
    "ledger_settled_cents at the recorded watermark, row by row",
  );
} else {
  bad(
    "every stored interest basis re-derives from the journal",
    `${basisDrift[0].n} row(s) disagree — basis_balance_cents is a cache, not evidence`,
  );
}

// ---- 6. denormalised clocks have not drifted --------------------------
const drift = await sql`
  SELECT count(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
  WHERE l.value_date <> e.value_date OR l.booking_seq <> e.booking_seq`;
if (String(drift[0].n) === "0") ok("denormalised clocks match their entry", "zero drift");
else bad("denormalised clocks match their entry", `${drift[0].n} rows drifted`);

// ---- 7. THE INVARIANT VIEWS ------------------------------------------
//
// Added late, and the reason is worth writing down. Migration 0001 says of
// these views: "Every one of these MUST return zero rows in CI. They are
// TESTS." They were not in CI. This script proves REFUSALS — it attempts a
// forbidden UPDATE and asserts the database says no — and everyone, including
// me, read "dbcheck 14/14" as covering the drift views too. It never touched
// them.
//
// That mattered on a clock. Every uncleared-credit hold in this book matures
// at 2026-09-11T13:00Z. At that instant `v_hold_state.is_released` flips true
// while the memo balance is still non-zero, which is precisely what
// `v_hold_release_drift` exists to catch — and nothing would have looked.
//
// A view that is asserted to be empty and never queried is a comment.
const INVARIANT_VIEWS = [
  ["v_entry_unbalanced", "every entry sums to zero, per currency"],
  ["v_line_denorm_drift", "denormalised clocks match their entry"],
  ["v_hold_drift", "the memo book equals the fold over card events"],
  ["v_hold_release_drift", "a released hold withholds nothing"],
  ["v_book_not_zero", "the whole book nets to zero, per entity and book"],
  ["v_deposit_control_drift", "the deposits subtree equals what we report"],
  ["v_accrual_month_drift", "a month's daily shares sum to the fee exactly"],
  ["v_accrual_ledger_drift", "every accrual claim matches the entry it cites"],
  // ---- added by migration 0023 ---------------------------------------
  //
  // Both of these are here because they can now FAIL. That is not a
  // throwaway remark: v_standing_order_double_fire was in this system for
  // days as a view that joined payment_instruction on a UNIQUE column and
  // asked for count > 1, so it could not return a row under any state of
  // the database, and its emptiness was quoted in a test, a document and
  // compliance.mjs as proof that a scheduled payment cannot fire twice. A
  // guard that cannot fail converts an untested claim into a green tick.
  //
  // 0023 points it at the question the unique index does NOT answer — a
  // second instruction in the mandate's keyspace under a different
  // spelling of the derived key — and both views below were made to fail
  // on purpose, against this database, in a transaction that was rolled
  // back. Only then were they added here.
  ["v_standing_order_double_fire", "one occurrence, at most one payment instruction"],
  ["v_dispute_ledger_double_count", "one dispute line, one row — the episode screen counts money once"],
  // ---- 0022's own invariant, which was never wired into this script ---
  //
  // "MUST RETURN ZERO ROWS. Nothing repairs what it reports." — 0022 §4.
  // It holds v_hold_state's release predicate equal to the one
  // ledger_availability() re-derives at a parameterised instant. They are
  // two bodies, which is exactly why the assertion exists, and an
  // assertion nothing queries is a comment.
  ["v_balance_definition_drift", "the hold model and availability agree, at the live point"],
  // ---- added by migration 0024 (interest) -----------------------------
  //
  // Both were MADE TO FAIL before being listed here, against this database,
  // in transactions that were rolled back — 0023's lesson applied on the way
  // in rather than after the fact:
  //
  //   v_interest_ledger_drift  0 -> 1  after a posting was made to cite an
  //                                    entry belonging to a different day
  //                                    (trigger disabled to allow the insert)
  //   v_interest_rate_drift    0 -> 5  after a rate row was backdated behind
  //                                    interest_rate_policy_forward_only
  //
  // The second is the one worth reading twice: it is "a rate change did not
  // retroactively re-price yesterday", asked of the whole book. Every posting
  // must still resolve to the rate card that was effective on ITS accrual
  // date, forever.
  ["v_interest_ledger_drift", "every interest posting matches the entry and side it cites"],
  ["v_interest_rate_drift", "no day has been re-priced by a rate that came later"],
  // ---- added by 0026 and 0028, and the reason they belong HERE ---------
  //
  // Both were written by agents that could not edit this file, so each was
  // left as "a one-line addition, noted in the migration" — which is the
  // state every invisible invariant in this build has passed through.
  // 0022's v_balance_definition_drift sat unqueried for a day that way.
  // An assertion nothing runs is a comment, so they are wired in here.
  //
  // v_refused_auth_hold (0026) is the one that reaches OUTSIDE the fold.
  // The declined-authorisation bug was invisible to v_hold_drift and
  // v_hold_release_drift for the life of the build, and those two were not
  // broken — they were telling the truth. The memo book said 5000 and the
  // fold over card_auth_event said 5000, because the fold's input had
  // already lost the verdict at the front door. Two derivations of the same
  // impoverished input agree perfectly, and that agreement is all a drift
  // view measures. This one joins to what the PROVIDER actually said, which
  // is the only place the disagreement was ever visible.
  //
  // v_hold_closure_not_terminal (0028) catches the CAUSE one step before
  // v_hold_release_drift sees the damage: a posting-path closure, never
  // reversed, whose fold now says the authorisation is open. It catches
  // 0011's three spurious closures and the $0 card-on-file defect the
  // fuzzer found, and it is empty against this database today.
  // ---- 0026's claim, and the word that changed in 0032 -----------------
  //
  // It used to read "an authorisation the network refused". That is what
  // the view asked, and asking it needed a recorded refusal — so the view
  // INNER JOINed the verdict table and added `AND r.result IS NOT NULL`,
  // which are the two ways this schema spells WE HAVE NO VERDICT. Losing
  // the verdict is the failure 0026 exists to catch, so the guard excluded
  // by construction exactly the state the bug produces, and read zero rows
  // while 98 of the 130 authorisation events on live holds carried no
  // verdict at all and $5,665.60 sat withheld behind them.
  //
  // 0032 rebuilt it on a LEFT JOIN with `r.result IS DISTINCT FROM
  // 'APPROVED'`, so the claim below is now the stronger one: not "nobody
  // proved a refusal" but "everything still withholding money is recorded
  // as approved". The breakdown printed when it is non-empty separates
  // `refused` (repairable, and 0032 repaired 12 holds / $600.00) from
  // `unanswered` (no verdict was ever observed — reported, never guessed).
  ["v_refused_auth_hold", "no hold withholds money against an authorisation not recorded as APPROVED"],
  ["v_hold_closure_not_terminal", "no permanent closure stands over a hold the fold says is open"],
  // ---- 0025's own invariant, which nothing queried ---------------------
  //
  // 0025 created this under the heading "the proof that availability is
  // immediate, as a view that must be empty" and then nothing ever ran it.
  // On the wire rail ledger and available move together, so an
  // uncleared-credit hold whose money became spendable LATER than the instant
  // it was credited means the funds-availability policy, the rail the credit
  // chose, or its value date is wrong. Made to fail on purpose against this
  // database — see `--prove`.
  //
  // It briefly lived in a second array, because the agent that found it could
  // not edit `src/lib/chaos/invariants.ts` and this list is asserted equal to
  // that one. That split was the honest move for a worker with a write scope;
  // as a permanent arrangement it would have left the chaos dashboard checking
  // fifteen invariants while CI checked sixteen — a screen claiming more
  // coverage than it has. Both lists now carry it and the second array is gone.
  ["v_wire_availability_drift", "a wire credit is spendable the moment it is booked"],
  // ---- added by 0033 (team) --------------------------------------------
  //
  // Both were MADE TO FAIL on purpose before being listed, in rolled-back
  // transactions against this database. The second is the more interesting
  // proof: writing a violating row required BOTH triggers to be disabled,
  // which is itself evidence that 0001's maker-checker and 0033's team check
  // compose rather than overlap.
  //
  //   v_approved_auth_for_dead_member   0 -> 1
  //   v_member_approval_without_right   0 -> 1
  //     {"role_at_approval":"viewer","state_at_approval":"active"}
  //
  // They are here rather than only on the /team screen because a screen that
  // counts an invariant is a dashboard; a gate that counts it is a test.
  ["v_approved_auth_for_dead_member", "no authorisation is approved for a member who has been removed"],
  ["v_member_approval_without_right", "no approval stands from a member who lacked the right at the time"],
];

// ---------------------------------------------------------------------
// THE SECOND LIST, AND WHY IT IS SEPARATE RATHER THAN APPENDED.
// ---------------------------------------------------------------------
//
// `src/lib/chaos/invariants.test.ts` parses the array literal above out of
// THIS FILE and asserts the chaos dashboard's copy lists exactly the same
// views in exactly the same order. That test is right and it is the only
// reason the duplication is tolerable — so a view added to the array above
// without the matching edit in `src/lib/chaos/invariants.ts` turns the
// suite red, and `src/lib/chaos/**` was outside this change's remit.
//
// The choice was therefore: leave a real invariant unrun, or run it from a
// list the dashboard does not mirror. An unrun invariant is a comment —
// this file exists because four of them were — so it runs here, and the
// mirror is named as the follow-up in docs/COMPLIANCE.md rather than left
// to be discovered. These are checked identically to the list above and
// count towards the same tally; nothing about them is softer.

// ---------------------------------------------------------------------
// MIGRATION 0031'S THREE, AND WHY THEY ARE IN A SECOND ARRAY AGAIN.
// ---------------------------------------------------------------------
//
// Same reason as the paragraph above, same trade, same follow-up named
// rather than left to be discovered: `src/lib/chaos/invariants.test.ts`
// parses the FIRST array out of this file and asserts the chaos
// dashboard's copy matches it exactly, and `src/lib/chaos/**` was outside
// this change's remit. Appending there without the mirroring edit turns
// `pnpm test` red for a worker who cannot fix it.
//
// So the choice is the same one: leave three real invariants unrun, or
// run them from a list the dashboard does not yet mirror. An unrun
// invariant is a comment. They run here, they count towards the same
// tally, and the mirror is a two-line edit in
// `src/lib/chaos/invariants.ts` for whoever owns it.
//
// ---------------------------------------------------------------------
// WHY THESE HAD TO BE WRITTEN AT ALL
// ---------------------------------------------------------------------
//
// Every invariant in the list above asks whether entries BALANCE, or
// whether two derivations of one number AGREE. Interchange booked on a
// settlement that was later reversed balances perfectly — two equal and
// opposite lines, the right entity, the right value date — and every one
// of those checks stays green while the ledger overstates income for
// ever. These are the first guards on this book about whether an entry
// SHOULD EXIST.
//
//   v_interchange_unreversed  did the repair happen at all: the
//                             settlement has a reversal and the
//                             interchange entry has none
//   v_interchange_drift       is the amount right: what the settlement
//                             now nets to, priced at the rate the
//                             posting was priced at, against what the
//                             4100 lines actually say
//   v_interchange_rate_drift  no settlement re-priced by a rate that
//                             came later
//
// ALL THREE WERE MADE TO FAIL BEFORE ANY WAS LISTED, on real settlements,
// in transactions that were rolled back — and they are re-proved on every
// run of `src/lib/interchange/interchange.integration.test.ts`, which is
// 0023's lesson applied on the way in rather than after the fact:
//
//   v_interchange_unreversed   0 -> n   reverse a real priced settlement
//                                       and skip the unbooking
//   v_interchange_drift        0 -> 1   the same; and again after a
//                                       repair that files an audit row
//                                       against a net the journal does
//                                       not agree with, which is the case
//                                       where a bookkeeping-table guard
//                                       goes quiet and this one does not
//   v_interchange_rate_drift   0 -> n   backdate a rate row with
//                                       interchange_rate_policy_forward_
//                                       only disabled
//
// NEITHER OF THE FIRST TWO READS `interchange_reversal`. An earlier draft
// of the first did, and it was wrong in BOTH directions: writing a row
// silenced it while the revenue stood, and losing one made it scream
// while the journal was perfectly correct. The second was observed on
// this database — 56 correctly repaired settlements reported as
// unrepaired after the audit table was rebuilt. Both read journal_entry
// and journal_line and nothing else.
const INVARIANT_VIEWS_0031 = [
  ["v_interchange_unreversed", "no revenue stands on a settlement the network took back"],
  ["v_interchange_drift", "every priced settlement carries the interchange it is now worth"],
  ["v_interchange_rate_drift", "no settlement has been re-priced by a rate that came later"],
];

// ---------------------------------------------------------------------
// MIGRATION 0040'S ONE, AND WHY IT IS IN A THIRD ARRAY.
// ---------------------------------------------------------------------
//
// Same reason as the two paragraphs above, and it is the LAST time this
// should be necessary: `src/lib/chaos/invariants.test.ts` parses the
// FIRST array out of this file and asserts the chaos dashboard's copy in
// `src/lib/chaos/invariants.ts` matches it exactly, and `src/lib/chaos/**`
// was outside this change's write scope. Appending there without the
// mirroring edit turns `pnpm test` red for a worker who cannot fix it, and
// a red tree is currently holding a deploy.
//
// So the same trade: an unrun invariant is a comment, this one runs here,
// it counts towards the same tally and `--prove` proves it like every
// other. Whoever owns `src/lib/chaos/**` should move all four views from
// the two arrays below into the first one and mirror them in one commit.
//
// ---------------------------------------------------------------------
// WHAT IT ASSERTS, AND WHY IT IS RED ON ARRIVAL
// ---------------------------------------------------------------------
//
// A card hold's expiry is stored TWICE. `ledger_availability()` reads
// `hold.expires_at`; `v_card_auth_hold` reads
// `card_authorization.expires_at`. `ensureAuthorization()` writes one
// value into both rows — so they are MEANT to be the same instant, and
// nothing in the schema says they must be. No foreign key, no CHECK, and
// until 0040 no view that would say anything if they diverged. Two bodies
// deriving "has this hold expired?" from two different columns is 0022's
// stored-balance defect wearing a timestamp instead of a number.
//
// NINE HOLDS ON THIS BOOK ALREADY DISAGREE, by 135-158 MILLISECONDS. Every
// one is a fixture that bypassed `ensureAuthorization()` and ran two
// separate `now() + interval '7 days'` statements. Exposure today is ZERO
// CENTS: all nine are closed, released and withholding nothing.
//
// It is NOT narrowed to make it pass. `WHERE external_ref NOT LIKE
// 'lithic:team-test-%'` would be safe, and would still be an exclusion
// shaped like the failure — which is the sentence 0032 wrote about the
// other deliberate red on this list.
const INVARIANT_VIEWS_0040 = [
  ["v_hold_expiry_drift", "one card hold, one expiry instant — the two readers agree"],
];

console.log("\nINVARIANT VIEWS — each MUST return zero rows\n");
for (const [view, claim] of [...INVARIANT_VIEWS, ...INVARIANT_VIEWS_0031, ...INVARIANT_VIEWS_0040]) {
  try {
    const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM ${view}`);
    const n = rows[0]?.n ?? 0;
    if (n === 0) ok(`${view} is empty`, claim);
    else {
      bad(`${view} is empty`, `${n} row(s) — ${claim}`);
      for (const line of await explain(view)) console.log(`        ${line}`);
    }
  } catch (e) {
    // A view this role cannot read is not a pass. Say which, and fail.
    bad(`${view} is empty`, `could not be read: ${String(e.message).split("\n")[0].slice(0, 70)}`);
  }
}

/**
 * What a non-empty invariant is actually reporting.
 *
 * A count is enough to fail on and never enough to act on. The one guard in
 * this list that is expected to carry a standing, unrepairable population
 * says so in cents and in classes, so nobody has to run a query to find out
 * whether the red is the old known one or something new.
 */
async function explain(view) {
  if (view !== "v_refused_auth_hold") return [];
  try {
    const rows = await sql.unsafe(`
      SELECT verdict,
             count(*)::int                           AS events,
             count(DISTINCT hold_id)::int            AS holds,
             (SELECT COALESCE(SUM(u.active_hold_cents), 0)::text
                FROM (SELECT DISTINCT hold_id, active_hold_cents, verdict
                        FROM v_refused_auth_hold) u
               WHERE u.verdict = v.verdict)          AS cents
        FROM v_refused_auth_hold v
       GROUP BY verdict ORDER BY verdict`);
    return rows.map(
      (r) =>
        `${r.verdict.padEnd(11)} ${String(r.holds).padStart(4)} hold(s), ${String(r.events).padStart(4)}` +
        ` event(s), ${usd(r.cents)} withheld` +
        (r.verdict === "refused"
          ? "  <- the network said NO and the money is still held. REPAIRABLE: close and reverse at the original value date."
          : "  <- no verdict was ever observed for these events. NOT repairable by inventing one; see 0032."),
    );
  } catch {
    return [];
  }
}

/** Cents (as a string, from the driver) to `$1,234.56`. No float, anywhere. */
function usd(cents) {
  const n = BigInt(cents ?? 0);
  const neg = n < 0n;
  const abs = (neg ? -n : n).toString().padStart(3, "0");
  const whole = abs.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${whole}.${abs.slice(-2)}`;
}

// ---- 8. GUARD REACH — how many rows each invariant can even see -------
//
// THE FAILURE THIS SECTION EXISTS FOR. `v_standing_order_double_fire`
// joined a UNIQUE column and asked for `count > 1`, so it could not return
// a row under ANY state of the database, and its emptiness was quoted in a
// test, a document and `compliance.mjs` as proof that a scheduled payment
// cannot fire twice (0023). `v_refused_auth_hold` excluded the missing
// verdict that WAS the bug (0026, repaired by 0032). A guard that cannot
// fail converts an untested claim into a green tick, and a green tick is
// believed.
//
// Structural impossibility is caught by `--prove` below, which makes each
// guard fail on purpose. This section catches the quieter version: a guard
// whose PREDICATE is fine but whose POPULATION is empty, so it is green
// because there is nothing to be green about. That is not a failure — a
// book with no complete accrual month has no complete accrual month to get
// wrong — but it is not the evidence the tick looks like either, so it is
// printed rather than folded into the tally.
const REACH = [
  ["v_entry_unbalanced", "journal entries", "SELECT count(DISTINCT entry_id)::int AS n FROM journal_line"],
  ["v_hold_drift", "live holds the fold covers", "SELECT count(*)::int AS n FROM v_hold_state WHERE NOT is_released"],
  ["v_hold_release_drift", "released holds", "SELECT count(*)::int AS n FROM v_hold_state WHERE is_released"],
  ["v_accrual_month_drift", "COMPLETE accrual months", "SELECT count(*)::int AS n FROM v_accrual_month WHERE month_complete"],
  ["v_accrual_ledger_drift", "posted accrual days", "SELECT count(*)::int AS n FROM accrual_posting WHERE disposition = 'posted'"],
  ["v_interest_ledger_drift", "posted interest days", "SELECT count(*)::int AS n FROM interest_posting WHERE disposition = 'posted'"],
  ["v_interest_rate_drift", "interest postings", "SELECT count(*)::int AS n FROM interest_posting"],
  ["v_standing_order_double_fire", "standing-order occurrences", "SELECT count(*)::int AS n FROM standing_order_occurrence"],
  ["v_dispute_ledger_double_count", "dispute ledger lines", "SELECT count(*)::int AS n FROM v_dispute_ledger"],
  ["v_balance_definition_drift", "accounts with a balance", "SELECT count(*)::int AS n FROM v_available_balance"],
  ["v_refused_auth_hold", "auth events on holds withholding money",
    `SELECT count(*)::int AS n FROM v_hold_state hs
       JOIN card_authorization ca ON ca.hold_id = hs.hold_id
       JOIN card_auth_event ev ON ev.auth_id = ca.id
      WHERE hs.active_hold_cents > 0
        AND ev.kind IN ('authorization','incremental_authorization')`],
  // REACH IS THE VIEW'S OWN PREDICATE, NOT THE TABLE'S SIZE.
  //
  // This line read `SELECT count(*) FROM hold_closure` and printed 228, while
  // the view filtered `reason = ANY (ARRAY[...five string literals...])` and
  // could only ever see 126. The section written to state each guard's reach
  // overstated this one by 102 rows -- 45% of the population invisible, while
  // the line claiming to measure exactly that printed the larger number. The
  // reach query excluded precisely what the guard excluded, which is the
  // pattern this section exists to end, reproduced inside the mechanism built
  // to end it.
  //
  // MIGRATION 0040 REMOVED THE POSSIBILITY RATHER THAN THE SYMPTOM. A closure
  // now declares its WRITER in a CHECK-constrained `hold_closure.source`, the
  // view filters on that column, and the reach is no longer a query written
  // here at all: `v_hold_closure_census` derives `in_guard` from the same
  // column the view filters on, so the two cannot drift. It is printed in full
  // below this table, per source, with the one column that stops "outside the
  // guard" ever meaning "unexamined" again.
  ["v_wire_availability_drift", "uncleared-credit holds with a wire memo entry",
    `SELECT count(*)::int AS n FROM hold h
      WHERE h.kind = 'uncleared_credit'
        AND EXISTS (SELECT 1 FROM journal_entry je
                     WHERE je.hold_id = h.id AND je.book = 'memo' AND je.rail = 'wire')`],
  ["v_hold_expiry_drift", "card holds carrying an authorisation, i.e. two expiry clocks",
    `SELECT count(*)::int AS n FROM hold h
       JOIN card_authorization ca ON ca.hold_id = h.id`],
];

console.log("\nGUARD REACH — the population each invariant ranges over (not a pass/fail)\n");
for (const [view, what, query, totalQuery] of REACH) {
  try {
    const rows = await sql.unsafe(query);
    const n = rows[0]?.n ?? 0;
    // A guard that can only see part of its table must say so HERE, where the
    // reach is claimed, rather than in a document somebody has to find.
    if (totalQuery !== undefined) {
      const totals = await sql.unsafe(totalQuery);
      const total = totals[0]?.n ?? 0;
      if (total > n) {
        const pct = total === 0 ? 0 : Math.round(((total - n) / total) * 100);
        console.log(
          `  ${view}\n      ranges over ${n} of ${total} — ${total - n} rows (${pct}%) are OUTSIDE this guard by construction`,
        );
        continue;
      }
    }
    console.log(
      n === 0
        ? `  EMPTY ${view} — 0 ${what}: green because there is nothing to be green about`
        : `  reach ${view} — ${n} ${what}`,
    );
  } catch (e) {
    console.log(`  ????? ${view} — reach could not be measured: ${String(e.message).split("\n")[0].slice(0, 60)}`);
  }
}

// ---- 9. MAKE IT FAIL ON PURPOSE ---------------------------------------
//
// `node scripts/dbcheck.mjs --prove`
//
// THE HOUSE RULE, EXECUTED RATHER THAN ASSERTED. 0023 and 0024 made their
// new views fail on purpose before trusting them, in transactions that were
// rolled back, and wrote the deltas into the migration. 0026 and 0028 wrote
// the rule down and left the demonstration as prose — which is how a guard
// that could not fail (0026's own) shipped with a paragraph explaining why
// it could. Prose is not a measurement. This runs the demonstrations.
//
// Every proof below runs inside `sql.begin()` and ends by THROWING, so the
// transaction rolls back. The money tables are append-only and this role
// holds no DELETE, so a proof that leaked would be permanent — the throw is
// the teardown, and it is unconditional rather than in a `finally`.
//
// Not run by default: `scripts/compliance.mjs` spawns this script as part
// of AF3 against the live database, and a prover that writes on every
// invocation is a prover nobody dares run.
if (process.argv.includes("--prove")) {
  console.log("\nMADE TO FAIL ON PURPOSE — each in a transaction that is rolled back\n");

  /** Run `body` in a transaction that cannot commit. Returns its value. */
  async function inRollback(body) {
    let captured;
    try {
      await sql.begin(async (tx) => {
        captured = await body(tx);
        throw new Error("__dbcheck_rollback__");
      });
    } catch (e) {
      if (!String(e.message).includes("__dbcheck_rollback__")) throw e;
    }
    return captured;
  }

  /** `before -> after` on one view, with the delta named. */
  const delta = (name, before, after, how) => {
    if (after > before) ok(`${name} CAN fail`, `${before} -> ${after} after ${how}`);
    else bad(`${name} CAN fail`, `${before} -> ${after} after ${how} — the guard did not move`);
  };

  // ---- 9a. v_refused_auth_hold sees a REFUSAL --------------------------
  //
  // A new event of a kind that feeds A(E), on an authorisation whose hold is
  // withholding money right now, with the network's verdict recorded beside
  // it as a refusal. This is the shape of the bug 050 found and 0026 fixed.
  try {
    const proof = await inRollback(async (tx) => {
      const [target] = await tx.unsafe(`
        SELECT ca.id AS auth_id
          FROM v_hold_state hs
          JOIN card_authorization ca ON ca.hold_id = hs.hold_id
         WHERE hs.active_hold_cents > 0
         ORDER BY hs.hold_id LIMIT 1`);
      if (!target) return null;
      const [before] = await tx.unsafe(
        `SELECT count(*)::int AS n FROM v_refused_auth_hold WHERE verdict = 'refused'`);
      const [ev] = await tx.unsafe(`
        INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
        VALUES ('${target.auth_id}'::uuid, 'authorization', 1, false, current_date,
                'dbcheck-prove-refused-' || gen_random_uuid()::text)
        RETURNING id`);
      await tx.unsafe(`
        INSERT INTO card_auth_event_result (event_id, result, provider_step, source)
        VALUES ('${ev.id}'::uuid, 'DECLINED', 'AUTHORIZATION', 'retained_payload')`);
      const [after] = await tx.unsafe(
        `SELECT count(*)::int AS n FROM v_refused_auth_hold WHERE verdict = 'refused'`);
      return { before: before.n, after: after.n };
    });
    if (proof === null) bad("v_refused_auth_hold(refused) CAN fail", "no hold is withholding money to prove it on");
    else delta("v_refused_auth_hold(refused)", proof.before, proof.after,
      "a DECLINED verdict on a live hold's authorisation");
  } catch (e) {
    bad("v_refused_auth_hold(refused) CAN fail", String(e.message).split("\n")[0].slice(0, 80));
  }

  // ---- 9b. v_refused_auth_hold sees a MISSING verdict ------------------
  //
  // THE ONE THE OLD DEFINITION COULD NOT EXPRESS. Identical to 9a except
  // that no verdict is recorded at all — which under 0026's INNER JOIN and
  // `IS NOT NULL` moved the count by exactly zero, for ever.
  try {
    const proof = await inRollback(async (tx) => {
      const [target] = await tx.unsafe(`
        SELECT ca.id AS auth_id
          FROM v_hold_state hs
          JOIN card_authorization ca ON ca.hold_id = hs.hold_id
         WHERE hs.active_hold_cents > 0
         ORDER BY hs.hold_id LIMIT 1`);
      if (!target) return null;
      const [before] = await tx.unsafe(
        `SELECT count(*)::int AS n FROM v_refused_auth_hold WHERE verdict = 'unanswered'`);
      await tx.unsafe(`
        INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
        VALUES ('${target.auth_id}'::uuid, 'authorization', 1, false, current_date,
                'dbcheck-prove-unanswered-' || gen_random_uuid()::text)`);
      const [after] = await tx.unsafe(
        `SELECT count(*)::int AS n FROM v_refused_auth_hold WHERE verdict = 'unanswered'`);
      return { before: before.n, after: after.n };
    });
    if (proof === null) bad("v_refused_auth_hold(unanswered) CAN fail", "no hold is withholding money to prove it on");
    else delta("v_refused_auth_hold(unanswered)", proof.before, proof.after,
      "an authorisation event on a live hold with NO verdict recorded");
  } catch (e) {
    bad("v_refused_auth_hold(unanswered) CAN fail", String(e.message).split("\n")[0].slice(0, 80));
  }

  // ---- 9c. the 0026 ingest trigger still refuses the bug ---------------
  //
  // The other half of the guarantee: the view reports the state, and the
  // trigger makes the state unwritable through the live ingest path. A
  // refusal filed under a kind that feeds the hold arithmetic must be
  // REFUSED at INSERT, not reported later.
  try {
    const refused = await inRollback(async (tx) => {
      const [target] = await tx.unsafe(`SELECT id FROM card_authorization ORDER BY id LIMIT 1`);
      if (!target) return null;
      const [ev] = await tx.unsafe(`
        INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
        VALUES ('${target.id}'::uuid, 'authorization', 1, false, current_date,
                'dbcheck-prove-trigger-' || gen_random_uuid()::text)
        RETURNING id`);
      try {
        await tx.unsafe(`
          INSERT INTO card_auth_event_result (event_id, result, provider_step, source)
          VALUES ('${ev.id}'::uuid, 'DECLINED', 'AUTHORIZATION', 'ingest')`);
        return { refused: false, message: "the database ALLOWED it" };
      } catch (e) {
        return { refused: true, message: String(e.message).split("\n")[0] };
      }
    });
    if (refused === null) bad("ingest cannot file a refusal as an authorisation", "no card_authorization to prove it on");
    else if (refused.refused) ok("ingest cannot file a refusal as an authorisation", refused.message.slice(0, 88));
    else bad("ingest cannot file a refusal as an authorisation", refused.message);
  } catch (e) {
    bad("ingest cannot file a refusal as an authorisation", String(e.message).split("\n")[0].slice(0, 80));
  }

  // ---- 9d. v_wire_availability_drift ------------------------------------
  //
  // 0025's claim is that a wire credit is spendable the instant it is
  // booked. The violation is a wire credit whose hold releases LATER than
  // the entry that created it, so the proof builds exactly that: a new
  // uncleared-credit hold on a real account with `available_at` an hour in
  // the future, and a wire-rail memo entry against it through
  // `ledger_append()` — the same single write path everything else uses.
  try {
    const proof = await inRollback(async (tx) => {
      const [seed] = await tx.unsafe(`
        SELECT h.account_id, h.memo_account_id, e.entity_id, l.amount_cents, l.currency, l.account_id AS line_account
          FROM hold h
          JOIN journal_entry e ON e.hold_id = h.id AND e.book = 'memo' AND e.rail = 'wire'
          JOIN journal_line l ON l.entry_id = e.id AND l.account_id = h.memo_account_id
         WHERE h.kind = 'uncleared_credit'
         ORDER BY e.booking_seq LIMIT 1`);
      if (!seed) return null;
      const [actor] = await tx.unsafe(
        `SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`);
      if (!actor) return null;
      const [before] = await tx.unsafe(`SELECT count(*)::int AS n FROM v_wire_availability_drift`);
      const [hold] = await tx.unsafe(`
        INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, available_at)
        VALUES ('${seed.account_id}'::uuid, '${seed.memo_account_id}'::uuid, 'uncleared_credit',
                'dbcheck-prove-wire-' || gen_random_uuid()::text, current_date, now() + interval '1 hour')
        RETURNING id`);
      // The contra side is the same pair of accounts the real wire memo
      // entry used, read off the seed rather than chosen here: an entry
      // that does not balance is refused by the ledger, not by this script.
      const lines = await tx.unsafe(`
        SELECT jsonb_agg(jsonb_build_object(
                 'account_id', l.account_id,
                 'amount_cents', l.amount_cents::text,
                 'currency', l.currency,
                 'memo', 'dbcheck --prove') ORDER BY l.ordinal) AS lines
          FROM journal_line l
          JOIN journal_entry e ON e.id = l.entry_id
         WHERE e.hold_id IS NOT NULL AND e.book = 'memo' AND e.rail = 'wire'
           AND e.id = (SELECT e2.id FROM journal_entry e2
                        WHERE e2.book = 'memo' AND e2.rail = 'wire'
                        ORDER BY e2.booking_seq LIMIT 1)`);
      await tx.unsafe(`
        SELECT ledger_append(
          '${seed.entity_id}'::uuid, current_date, 'memo'::account_book, 'original'::entry_type,
          'dbcheck --prove: a wire credit that is NOT immediately spendable',
          'dbcheck-prove-wire:' || '${hold.id}', '${actor.id}'::uuid,
          '${JSON.stringify(lines[0].lines).replace(/'/g, "''")}'::jsonb,
          'wire'::rail, NULL, NULL, '${hold.id}'::uuid, NULL, NULL)`);
      const [after] = await tx.unsafe(`SELECT count(*)::int AS n FROM v_wire_availability_drift`);
      return { before: before.n, after: after.n };
    });
    if (proof === null) bad("v_wire_availability_drift CAN fail", "no wire credit on this book to model the proof on");
    else delta("v_wire_availability_drift", proof.before, proof.after,
      "a wire credit whose money becomes spendable an hour after it was booked");
  } catch (e) {
    bad("v_wire_availability_drift CAN fail", String(e.message).split("\n")[0].slice(0, 100));
  }
} else {
  console.log("\n  (run with --prove to make the card-hold and wire invariants FAIL on purpose,");
  console.log("   in transactions that are rolled back — a guard nobody has seen fail is a claim)\n");
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);
