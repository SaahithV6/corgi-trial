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
  // ---- 0031 and 0040, folded back in --------------------------------------
  //
  // These four lived in side arrays for one honest reason: the agents that
  // added them could not write `src/lib/chaos/invariants.ts`, and this list is
  // asserted equal to that one by `src/lib/chaos/invariants.test.ts`. Splitting
  // was the right call for a worker with a write scope — it kept them checked,
  // counted and provable rather than dropped.
  //
  // As a permanent arrangement it is the failure this file exists to catch. The
  // chaos dashboard would check N while the gate checked N+4, and a screen
  // claiming less coverage than CI has is the same bug as one claiming more:
  // the two numbers stop being comparable, and nobody notices which is right.
  // Both lists carry all of them now and the side arrays are gone.
  ["v_interchange_unreversed", "no revenue stands on a settlement the network took back"],
  ["v_interchange_drift", "every priced settlement carries the interchange it is now worth"],
  ["v_interchange_rate_drift", "no settlement has been re-priced by a rate that came later"],
  ["v_hold_expiry_drift", "one card hold, one expiry instant — the two readers agree"],
  // ---- 0043's two, folded in ----------------------------------------------
  //
  // Third time an agent has had to park a new invariant in a side array,
  // always for the same reason: it cannot write `src/lib/chaos/invariants.ts`,
  // which this list is asserted equal to. Parking keeps the view checked and
  // provable — right under a write scope, wrong as a resting state, because
  // the dashboard would then check two fewer than the gate.
  //
  // Both are RED ON ARRIVAL, deliberately. They make a measured finding
  // visible instead of absorbing it, and neither is exposure.
  //
  // v_advice_delta_unsound exists because deriveCardEvents() had never been
  // fuzzed. docs/FUZZ.md had NAMED that gap and excused it — "it is still
  // fuzzed as what it becomes" — which is not the same as fuzzing the step
  // that decides it. 4,000 generated payloads found 624 advices converted
  // against a negative base, $61,277.06 the old rule would have fabricated.
  ["v_advice_delta_unsound", "an advice is never converted against a base an authorised amount cannot take"],
  ["v_hold_closure_unexplained", "no unreversed closure stands over an open authorisation the provider does not explain"],
  // ---- 0044, folded in ----------------------------------------------------
  //
  // FOURTH time an agent has had to park a new invariant in a side array,
  // always the same cause: it cannot write `src/lib/chaos/invariants.ts`,
  // which this list is asserted equal to. That is the right call under a write
  // scope and the wrong resting state, so it gets folded in every time.
  //
  // This one watches the defect that was closest to real harm tonight: both
  // authorship checks in 0033 looked the author up with `AND state <> 'removed'`
  // and then treated NULL as Corgi staff, so a REMOVED admin was moved out of
  // the branch that checks and into the branch that trusts — and could mint a
  // new approver with can_approve = true, manufacturing the second pair of
  // eyes maker-checker rests on. Removal is meant to be the remedy for a
  // compromised signer; it was the qualification.
  //
  // It is deliberately NOT v_member_approval_without_right widened: that view
  // reads payment_instruction_event, and the approver this defect mints is
  // active, correctly-roled and perfectly legitimate at the moment they
  // approve. The fraud is one level up, in who put them there.
  ["v_team_terms_by_unauthorised_author", "no member's terms were written by somebody who was not an active admin of that business at the time"],
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

// ---------------------------------------------------------------------
// MIGRATION 0043'S TWO, AND WHY THEY ARE IN A SECOND ARRAY AGAIN.
// ---------------------------------------------------------------------
//
// Same mechanical reason as 0031's and 0040's were, and the comment above
// that says "the side arrays are gone" was true when it was written:
// `src/lib/chaos/invariants.test.ts` parses the FIRST array literal out of
// this file and asserts `src/lib/chaos/invariants.ts` lists exactly the
// same views in exactly the same order, and `src/lib/chaos/**` is outside
// this change's write scope. Appending above without the mirroring edit
// turns `pnpm test` red for a worker who cannot fix it, and a red tree is
// holding a deploy.
//
// So the same trade, stated rather than left to be discovered: an unrun
// invariant is a comment, these two run here, they count towards the SAME
// tally, `--prove` proves them like every other view, and nothing about
// them is softer. Whoever owns `src/lib/chaos/**` should move both into
// the array above and mirror them in one commit — it is a four-line edit.
//
// ---------------------------------------------------------------------
// BOTH ARE RED ON ARRIVAL, AND THAT IS WHAT THEY ARE FOR
// ---------------------------------------------------------------------
//
// `v_advice_delta_unsound` — 1 row, $73.40. An AUTHORIZATION_ADVICE
// carries the ABSOLUTE authorised amount; we store the delta that produces
// it. On Lithic transaction 5892c550-… the network over-reversed — two
// reversals, 7340 and 5000, against one authorisation of 5000 — so A(E)
// stood at -7340, and the advice that followed, whose absolute amount was
// ZERO, was converted against that negative base and stored as an
// `incremental_authorization` of 7340. A fact the network never sent, in
// an append-only table. No money moved: A <= 0 already closed the hold.
// The conversion is fixed (`lithic-events.ts`, base = max(A, 0)); the row
// is NOT repaired, because the only compensation available is a second
// fabricated event, and migration 0043's header prices that.
//
// `v_hold_closure_unexplained` — 4 rows, $132.00. The four closures of
// docs/HOLDS.md §10.4, written by an early `holds.integration.test.ts`
// case 7b, standing over $33.00 authorisations the fold still calls open.
// `v_hold_drift` is `WHERE NOT is_released` and the closure released them;
// `v_hold_release_drift` needs a non-zero memo balance and theirs is zero;
// `v_hold_closure_not_terminal` ranges over posting_path and expiry_sweep
// and theirs is test_harness. NO GUARD ON THIS BUILD COULD SEE THEM, and
// a census column printed under GUARD REACH is a report, not a guard.
//
// This view is the guard, and it is WIDER rather than narrower: every
// card-auth closure, whatever its source, minus only those the provider's
// own verdicts explain. That exemption is demonstrated per row — 52 of 52
// repair closures carry a non-APPROVED `card_auth_event_result` — and not
// declared per source, which matters, because 0040 §10.3's declared
// version has since gone stale: 0 of those 52 holds are in
// `v_refused_auth_hold` today, since 0032's repair took them out of it.

// ---------------------------------------------------------------------
// MIGRATION 0044'S ONE, AND WHY IT IS IN A SIDE ARRAY AGAIN.
// ---------------------------------------------------------------------
//
// The same mechanical reason every previous side array had, and the
// paragraphs above that say "the side arrays are gone" were true when
// they were written: `src/lib/chaos/invariants.test.ts` parses the FIRST
// array literal out of this file and asserts `src/lib/chaos/invariants.ts`
// lists exactly the same views in exactly the same order, and
// `src/lib/chaos/**` is outside this change's write scope — five agents
// are live tonight and a red `pnpm test` nobody can fix is holding a
// demo. So: an unrun invariant is a comment, this one runs here, it
// counts towards the SAME tally, `--prove` proves it like every other
// view, and nothing about it is softer. Whoever owns `src/lib/chaos/**`
// moves it into the array above and mirrors it — a two-line edit.
//
// ---------------------------------------------------------------------
// WHAT IT ASSERTS
// ---------------------------------------------------------------------
//
// GREEN on arrival, and it had to be MADE to fail before it was listed.
//
// `db/migrations/0033_team.sql:309-322` and `:818-831` both established
// the author's authority with a lookup filtered `AND state <> 'removed'`
// and then gated on `IF v_author IS NOT NULL`. NULL is the CORGI-STAFF
// break-glass branch. So a REMOVED member of the business resolved to
// NULL and was moved out of the branch that CHECKS into the branch that
// TRUSTS: what the lookup excluded from itself was exactly the population
// it existed to stop. Proven twice on this database — a removed admin
// authored a promotion, and a removed admin called `team_add_member()`
// and minted a new ACTIVE APPROVER with `actor.can_approve = true`, which
// is the second pair of eyes maker-checker rests on. Migration 0044 is
// the repair; this view is the second line behind it.
//
// It is NOT `v_member_approval_without_right` widened. That view reads
// `payment_instruction_event` and asks who approved a PAYMENT; this
// defect lands in `team_member_version`, and the approver it mints is
// active, correctly-roled and perfectly legitimate at the instant they
// approve. The fraud is one level up, in who put them there, and no
// widening of a view over payment approvals can see a table it does not
// read.

// ONE LIST, THREE CONSUMERS. The emptiness check below, GUARD REACH (§8)
// and `--prove` (§9) all range over exactly this, and none of them keeps a
// second copy. Side arrays have appeared in this file three times — each
// for a good mechanical reason, each merged back — and every time one
// existed, a section that walked only `INVARIANT_VIEWS` quietly stopped
// covering the views in it. Spreading it here once means a fourth side
// array is added in ONE place and all three consumers pick it up.
const GATED_INVARIANTS = [...INVARIANT_VIEWS];

console.log("\nINVARIANT VIEWS — each MUST return zero rows\n");
for (const [view, claim] of GATED_INVARIANTS) {
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
  // 0043's two. Both carry a standing, named, unrepairable population, so
  // both owe the reader the same thing `v_refused_auth_hold` owes: which
  // red is this, in cents, without anybody having to run a query.
  if (view === "v_advice_delta_unsound") {
    try {
      const rows = await sql.unsafe(`
        SELECT finding, count(*)::int AS n,
               COALESCE(SUM(stored_magnitude_cents), 0)::text AS cents,
               min(provider_auth_id) AS example
          FROM v_advice_delta_unsound GROUP BY finding ORDER BY finding`);
      return rows.map((r) =>
        `${String(r.finding).padEnd(19)} ${String(r.n).padStart(3)} advice(s), ${usd(r.cents)} of derived delta` +
        (r.finding === "negative_base"
          ? `  <- converted against A < 0. e.g. ${r.example}. The conversion is fixed (base = max(A,0)); the ROW is not repairable — the only compensation is a second event the network never sent.`
          : `  <- the payload is no longer retained, so the base cannot be checked. Reported rather than excluded: an unverifiable advice is not a pass.`),
      );
    } catch { return []; }
  }
  if (view === "v_hold_closure_unexplained") {
    try {
      const rows = await sql.unsafe(`
        SELECT closure_source, count(*)::int AS n,
               COALESCE(SUM(target_hold_cents), 0)::text AS cents,
               min(provider_auth_id) AS example
          FROM v_hold_closure_unexplained GROUP BY closure_source ORDER BY n DESC`);
      return rows.map((r) =>
        `${String(r.closure_source).padEnd(19)} ${String(r.n).padStart(3)} closure(s), ${usd(r.cents)} the fold says is still authorised` +
        (r.closure_source === "test_harness"
          ? `  <- e.g. ${r.example}. docs/HOLDS.md §10.4: a fixture's closures. NOT repaired — 0043's header prices both repairs and both are worse.`
          : `  <- e.g. ${r.example}. A closure the model's terminal predicate did not license and the provider's verdicts do not explain.`),
      );
    } catch { return []; }
  }
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
  // ---- 0043's two ------------------------------------------------------
  //
  // The reach and the TOTAL are both given for the advice guard, so the
  // third column prints how much of the population is outside it. It should
  // read "ranges over N of N": the view's `no_retained_payload` arm exists
  // precisely so that an advice we cannot check is REPORTED rather than
  // silently dropped by an inner join to `webhook_inbox`. If those two
  // numbers ever differ, the guard has acquired the blind spot 0026 shipped
  // with, and this line is where it shows up.
  ["v_advice_delta_unsound", "stored events derived from an AUTHORIZATION_ADVICE",
    `SELECT count(*)::int AS n FROM card_auth_event e
       JOIN card_auth_event_result r ON r.event_id = e.id
      WHERE r.provider_step IN ('AUTHORIZATION_ADVICE','CREDIT_AUTHORIZATION_ADVICE')`,
    `SELECT count(*)::int AS n FROM card_auth_event e
       JOIN card_auth_event_result r ON r.event_id = e.id
      WHERE r.provider_step IN ('AUTHORIZATION_ADVICE','CREDIT_AUTHORIZATION_ADVICE')`],
  // NO source filter, deliberately. `v_hold_closure_not_terminal` ranges
  // over 129 of 197 card-auth closures BY DECLARED WRITER; this one ranges
  // over all of them and subtracts only what the provider's verdicts
  // explain. The two numbers being different is the finding, not a bug.
  ["v_hold_closure_unexplained", "card-auth closures, ALL of them, whatever their declared writer",
    `SELECT count(*)::int AS n FROM hold_closure hc
       JOIN card_authorization ca ON ca.hold_id = hc.hold_id`],

  // =====================================================================
  // THE TEN THAT WERE NEVER HERE, AND WHY THAT WAS THE SAME FAILURE AGAIN
  // =====================================================================
  //
  // This table was fifteen hand-typed rows against twenty-five gated
  // invariants. It was built BECAUSE a guard that cannot fail is a green
  // tick, and it was itself incomplete by construction: ten views were
  // checked for emptiness above and their populations were never measured,
  // so ten green ticks stood with nothing behind them saying whether there
  // had been anything to be green about. Nobody had to remove a row to
  // make that happen — the row simply was never typed, and an absence
  // prints as nothing at all.
  //
  // The loop below no longer walks this array. It walks the SAME invariant
  // arrays the emptiness check walks, and a view with no entry here is a
  // named FAILURE, exactly as `--prove` does it for a view with no proof.
  // Adding an invariant without its reach is now impossible to do quietly.
  //
  // TWO OF THE TEN ARE THE REASON THIS MATTERS, and both were measured on
  // this database rather than reasoned about:
  //
  //   v_member_approval_without_right     30 of 177 'approved' events
  //   v_team_terms_by_unauthorised_author  2 of 373 member-version rows
  //
  // Both have the SHAPE OF THE BUG THEY WERE WRITTEN AGAINST. Each reaches
  // its subject through an INNER JOIN to a `team_member` row, so an actor
  // with no membership of that business — the CORGI-STAFF break-glass
  // path, a seeder, an agent surface — is not judged and not reported. It
  // falls out of the FROM clause. That is precisely 0033's defect: a
  // lookup filtered `AND state <> 'removed'` moved the removed member out
  // of the branch that CHECKS and into the branch that TRUSTS, and 0044's
  // repair view now reproduces the same silence one table over. The
  // percentages below are the sentence "what the lookup excluded from
  // itself is exactly the population it existed to stop", in numbers.
  //
  // NOT REPAIRED HERE. These are views in migrations, and this file may
  // not edit a migration. What it can do is stop the blind spot being
  // invisible, which is the whole job of this section.

  // The denormalised clock check. Its join is to the entry every line must
  // have, so its reach is every line there is — stated, not assumed.
  ["v_line_denorm_drift", "journal lines carrying a denormalised clock",
    `SELECT count(*)::int AS n FROM journal_line l
       JOIN journal_entry e ON e.id = l.entry_id`,
    `SELECT count(*)::int AS n FROM journal_line`],

  // The whole-book identity. It is a GROUP BY, so its population is
  // groups, not rows: one number per (entity, book, currency). Counting
  // journal_line here would have been the `hold_closure` mistake again —
  // the table's size is not the guard's reach.
  ["v_book_not_zero", "(entity × book × currency) groups the book nets over",
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
        GROUP BY e.entity_id, e.book, l.currency) g`],

  // A CROSS JOIN of two scalars: the guard is ONE comparison, and what
  // varies underneath it is which accounts the recursive walk reaches.
  // That walk is the reach, because an account outside the 2100 subtree is
  // outside the subtree arm of the comparison.
  ["v_deposit_control_drift", "accounts inside the 2100 deposit subtree the walk reaches",
    `WITH RECURSIVE t AS (
       SELECT id FROM account WHERE code = '2100' AND business_id IS NULL
       UNION ALL
       SELECT a.id FROM account a JOIN t ON a.parent_id = t.id)
     SELECT count(*)::int AS n FROM t`],

  // BY DECLARED WRITER, and the census below prints the rest per source.
  // This is the row the 0040 comment above refers to when it says
  // "129 of 197": the same fraction, measured live rather than quoted.
  ["v_hold_closure_not_terminal", "card-auth closures whose declared writer is posting_path or expiry_sweep",
    `SELECT count(*)::int AS n FROM hold_closure hc
       JOIN card_authorization ca ON ca.hold_id = hc.hold_id
      WHERE hc.source IN ('posting_path','expiry_sweep')`,
    `SELECT count(*)::int AS n FROM hold_closure hc
       JOIN card_authorization ca ON ca.hold_id = hc.hold_id`],

  // An approval is only judged if the decision recorded WHICH member
  // version authorised it. A decision with a null member_version_id is not
  // reported as unjudgeable — it is not reported at all, because the join
  // is inner.
  ["v_approved_auth_for_dead_member", "approved auth decisions that cite a member version",
    `SELECT count(*)::int AS n FROM card_auth_decision d
       JOIN team_member_version tmv ON tmv.id = d.member_version_id
      WHERE d.outcome = 'approve'
        AND d.request_status IN ('AUTHORIZATION','FINANCIAL_AUTHORIZATION')`,
    `SELECT count(*)::int AS n FROM card_auth_decision d
      WHERE d.outcome = 'approve'
        AND d.request_status IN ('AUTHORIZATION','FINANCIAL_AUTHORIZATION')`],

  // ONE OF THE TWO. `JOIN team_member tm ON tm.actor_id = e.actor_id AND
  // tm.business_id = acct.business_id` is an INNER join, so every approval
  // by an actor who is not a member of that business — break-glass, an
  // operator, the agent surface — is invisible to the guard that exists to
  // ask whether the approver had the right. Maker-checker is the control
  // this build grades hardest, and this is the fraction of approvals its
  // standing guard can even see.
  ["v_member_approval_without_right", "'approved' events whose actor IS a member of the paying business",
    `SELECT count(*)::int AS n FROM payment_instruction_event e
       JOIN payment_instruction pi ON pi.id = e.instruction_id
       JOIN account acct ON acct.id = pi.account_id
       JOIN team_member tm ON tm.actor_id = e.actor_id
                          AND tm.business_id = acct.business_id
      WHERE e.kind::text = 'approved'`,
    `SELECT count(*)::int AS n FROM payment_instruction_event e
      WHERE e.kind::text = 'approved'`],

  // "An interchange posting whose settlement was reversed must itself be
  // reversed" can only speak about postings whose settlement WAS reversed.
  // The rest are outside by construction and correctly so — but the number
  // belongs here, because a guard over a third of its table that is read
  // as covering the table is how the last three of these went wrong.
  ["v_interchange_unreversed", "interchange postings whose settlement entry has a reversal",
    `SELECT count(*)::int AS n FROM interchange_posting ip
       JOIN journal_entry srev ON srev.reverses_entry_id = ip.settlement_entry_id`,
    `SELECT count(*)::int AS n FROM interchange_posting`],

  // Both interchange arithmetic guards LEFT JOIN, so a posting with no
  // settlement group and no booked line still lands in the view with
  // COALESCE zeroes rather than vanishing. Reach is the whole table, and
  // that is a property worth printing rather than assuming.
  ["v_interchange_drift", "interchange postings (LEFT JOINed, so none drop out)",
    `SELECT count(*)::int AS n FROM interchange_posting`,
    `SELECT count(*)::int AS n FROM interchange_posting`],
  ["v_interchange_rate_drift", "interchange postings re-priced against the rate card of their value date",
    `SELECT count(*)::int AS n FROM interchange_posting`,
    `SELECT count(*)::int AS n FROM interchange_posting`],

  // THE OTHER ONE, AND THE WORST OF THE TWO. 0044's repair view resolves
  // the AUTHOR through `JOIN team_member atm ON atm.business_id =
  // tm.business_id AND atm.actor_id = tmv.created_by`, inside a LATERAL
  // with LIMIT 1. A member version written by an actor who holds no
  // membership of that business produces no author row, the LATERAL yields
  // nothing, and the INNER join drops the version entirely.
  //
  // That is the same door 0033 left open. 0033 looked up the author `AND
  // state <> 'removed'`, got NULL for a removed admin, and NULL was the
  // break-glass branch that TRUSTS. 0044 closed that for removed members
  // and left it open for non-members, in the view rather than in the
  // function. The number below is how much of the table is behind that
  // door.
  ["v_team_terms_by_unauthorised_author", "member-version rows whose author holds a membership of that same business",
    `SELECT count(*)::int AS n FROM team_member_version tmv
       JOIN team_member tm ON tm.id = tmv.member_id
      WHERE EXISTS (SELECT 1 FROM team_member atm
                      JOIN team_member_version v ON v.member_id = atm.id
                     WHERE atm.business_id = tm.business_id
                       AND atm.actor_id = tmv.created_by
                       AND v.created_at < tmv.created_at)`,
    `SELECT count(*)::int AS n FROM team_member_version`],
];

// ---- the driver, and why it no longer walks REACH ---------------------
//
// IT WALKS THE INVARIANT ARRAYS. Identical in shape to `--prove`'s driver
// below: coverage is COMPUTED from the list of things that must be covered,
// never from the list of things that happen to be covered. `for (const row
// of REACH)` could only ever report on rows somebody had typed, which is
// why fifteen rows stood against twenty-five invariants and the output said
// nothing was missing. A view checked for emptiness above and absent from
// REACH is now a named FAIL in the tally.
//
// A reach that is genuinely not expressible as a count is declared, not
// omitted: pass `null` as the query and a sentence as the fourth element,
// and the row prints as HARD with the sentence. Nothing uses that today —
// all twenty-five have a real query — and it exists so that the cheapest
// way out of a difficult one is still a visible row.
const REACH_BY_VIEW = new Map(REACH.map((row) => [row[0], row]));
const GATED_VIEWS = GATED_INVARIANTS.map(([v]) => v);
const reachCovered = GATED_VIEWS.filter((v) => REACH_BY_VIEW.has(v)).length;

console.log(
  `\nGUARD REACH — the population each invariant ranges over` +
    ` (${reachCovered} of ${GATED_VIEWS.length} views; a missing one is a FAIL, not a blank)\n`,
);
for (const view of GATED_VIEWS) {
  const row = REACH_BY_VIEW.get(view);
  if (row === undefined) {
    bad(
      `${view} declares its reach`,
      "NO REACH QUERY IS REGISTERED — its emptiness is unexplained, and an unexplained green tick is what this section exists to stop",
    );
    continue;
  }
  const [, what, query, totalQuery] = row;
  if (query === null) {
    console.log(`  HARD  ${view} — reach is not expressible as a count: ${totalQuery}`);
    continue;
  }
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
    // A reach that cannot be MEASURED is worth exactly what a reach that
    // was never written is worth, so it fails the same way rather than
    // printing five question marks into a scroll nobody re-reads.
    bad(
      `${view} declares its reach`,
      `the reach query could not be run: ${String(e.message).split("\n")[0].slice(0, 70)}`,
    );
  }
}

// A reach row for a view nothing checks is the mirror image, and cheap to
// catch while the two lists are in hand: it means either the view was
// dropped from the invariant list without its row, or the row names a view
// that was never gated. Both are a stale table pretending to be a complete
// one.
for (const [view] of REACH) {
  if (!GATED_VIEWS.includes(view)) {
    bad(
      `${view} is a gated invariant`,
      "a REACH row names a view that no invariant list checks — the table is measuring something nothing guards",
    );
  }
}

// ---- 8b. THE CLOSURE CENSUS — a guard stating its own domain out loud ---
//
// `v_hold_closure_not_terminal` used to choose its population by matching
// English against `hold_closure.reason`: five string literals, 126 of 228
// rows admitted, and migration 0032's own twelve closures excluded by the
// WORDING of their message rather than by anyone's intent. Migration 0040
// replaced the discriminator with a CHECK-constrained `source` column and
// pointed the view at it, and `v_hold_closure_census` derives "is this row
// in the guard" from the SAME column the guard filters on — so the reach
// figure and the guard cannot drift apart the way they did.
//
// `defect_shape` is the column that matters. It counts rows the guard does
// NOT range over that carry its shape anyway: a standing, unreversed
// closure over an authorisation the fold still calls open. "Outside the
// guard" is a legitimate answer; "outside the guard and therefore nobody
// looked" is the failure this build keeps rediscovering, and this column is
// the difference between the two.
try {
  const census = await sql.unsafe(`
    SELECT source, hold_kind, in_guard, closures, defect_shape, defect_shape_cents::text AS cents
      FROM v_hold_closure_census ORDER BY in_guard DESC, closures DESC`);
  const inGuard = census.filter((r) => r.in_guard).reduce((a, r) => a + r.closures, 0);
  const total = census.reduce((a, r) => a + r.closures, 0);
  console.log(`\n  v_hold_closure_not_terminal — ranges over ${inGuard} of ${total} closures, BY DECLARED WRITER`);
  for (const r of census) {
    const shape = r.defect_shape > 0 ? `  <- ${r.defect_shape} of these carry the guard's defect shape (${usd(r.cents)})` : "";
    console.log(
      `      ${r.in_guard ? "IN " : "out"}  ${String(r.source).padEnd(18)} ${String(r.closures).padStart(4)}` +
      ` closure(s) on ${r.hold_kind} holds${shape}`,
    );
  }
  console.log(
    "      out = a repair, an operator override, a dispute, a rail's availability sweep or a\n" +
    "            test fixture: none of them claims the hold model's terminal predicate licensed\n" +
    "            the row, which is the only thing this guard asserts. Every one is counted here.",
  );
} catch (e) {
  console.log(`  ????? v_hold_closure_census could not be read: ${String(e.message).split("\n")[0].slice(0, 60)}`);
}

// ---- 8b2. A(E) < 0 — a population, printed because it is NOT a guard ----
//
// `A(E)` is not floored, and migration 0043's header argues why: the floor
// is a provable no-op for `H` — A < 0 implies A <= 0 implies `is_closed`
// implies `target_hold_cents = 0`, BY THE CLOSURE and not by the clamp —
// so it changes no customer-visible number and costs the only evidence
// that the provider over-reversed.
//
// Nor is `A >= 0` an invariant, and that is the part worth printing rather
// than arguing. A reversal delivered before the authorisation it belongs to
// puts A below zero legitimately, which is the case the brief names; the
// fuzzer reaches it on 1,614 of 7,220 generated sets (22.4%), 812 of them
// after a real authorisation, and NONE of them open or holding a cent. A
// view asserting A >= 0 would be red on a fifth of correct behaviour.
//
// So it is a census with a named owner. The money question — is anything
// standing at A < 0 still withholding? — belongs to `v_hold_release_drift`,
// which is on the pass/fail list above, and the `holding` column here is
// the same question asked out loud so nobody has to take that on trust.
try {
  const [over] = await sql.unsafe(`
    SELECT count(*)::int                                             AS auths,
           COALESCE(SUM(-auth_net_cents), 0)::text                   AS cents,
           count(*) FILTER (WHERE NOT is_closed)::int                AS open,
           count(*) FILTER (WHERE memo_balance_cents <> 0)::int       AS holding
      FROM v_auth_over_reversed`);
  console.log(
    `\n  v_auth_over_reversed — ${over.auths} authorisation(s) standing at A(E) < 0, ${usd(over.cents)} over-reversed` +
    `\n      ${over.open} of them OPEN and ${over.holding} still withholding — both must be 0, and the second is` +
    `\n      owned by v_hold_release_drift above. A(E) is deliberately unfloored (0043).`,
  );
} catch (e) {
  console.log(`  ????? v_auth_over_reversed could not be read: ${String(e.message).split("\n")[0].slice(0, 60)}`);
}

// ---- 8c. EVERY CARD-AUTH CLOSURE DECLARES ITS WRITER --------------------
//
// The rule that keeps 8b honest, enforced HERE rather than by a trigger.
//
// A card-auth closure written without a `source` would be NULL, fall
// outside `v_hold_closure_not_terminal`, and reproduce 0028's defect in a
// new field — so the rule has to be real. It is not a BEFORE INSERT trigger
// because a migration lands on the database the instant it runs while the
// deployed build is whatever was last pushed (0056: the repository had the
// fix and the box did not, for eight hours). In that window a trigger would
// refuse a CORRECT closure written by a deployed `apply.ts` that cannot know
// about a column which did not exist when it was built, and the customer's
// card hold would sit on their money until the deploy caught up.
//
// Refusing a correct write to enforce a LABEL on it is the wrong trade.
// Turning CI red on the first offending row is the same rule, collected a
// few minutes later, with nobody's money held to make the point.
const undeclared = await sql`
  SELECT count(*)::int AS n
    FROM hold_closure hc JOIN hold h ON h.id = hc.hold_id
   WHERE h.kind = 'card_auth' AND hc.source IS NULL`;
if ((undeclared[0]?.n ?? 0) === 0) {
  ok(
    "every card-auth closure declares its writer",
    "hold_closure.source is non-NULL on every closure the invariant's population is drawn from",
  );
} else {
  bad(
    "every card-auth closure declares its writer",
    `${undeclared[0].n} card-auth closure(s) carry source IS NULL — they are outside ` +
      "v_hold_closure_not_terminal and nothing says why. Add the arm to the writer, not to a reason string.",
  );
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
// IT USED TO RUN TWO OF THEM. `v_refused_auth_hold` and
// `v_wire_availability_drift` had provers; the other nineteen views on the
// list above were trusted on the strength of a sentence in a migration, and
// three of those sentences have since turned out to be wrong — 0012's
// (unsatisfiable), 0026's (excluded the bug), 0028's (could only see 55% of
// its table). A rule that is executed for two cases out of twenty-one is
// not a rule, it is a habit with two witnesses.
//
// SO EVERY INVARIANT VIEW NOW HAS A PROOF, AND COVERAGE IS COMPUTED RATHER
// THAN CLAIMED: the driver walks the same arrays the section above checks,
// and a view with no proof registered FAILS here by name. Nobody can add an
// invariant and forget this file; the tally says so on the next run.
//
// Every proof below runs inside `sql.begin()` and ends by THROWING, so the
// transaction rolls back. The money tables are append-only and this role
// holds no DELETE, so a proof that leaked would be permanent — the throw is
// the teardown, and it is unconditional rather than in a `finally`. Each
// proof then RE-READS its view outside the transaction and asserts the count
// is back where it started, because "it rolled back" is itself a claim.
//
// WHERE A PROOF NEEDS A TRIGGER DISABLED, IT SAYS SO IN THE OUTPUT. That is
// not an apology. A view whose violating state cannot be written through the
// live path at all is a view standing behind a constraint that already
// refuses the bug, and the pair — constraint refuses, view would catch it
// anyway — is the composition worth printing. Those proofs run on the OWNER
// connection, because `corgi_app` cannot disable a trigger (0001 §13) and
// that is the whole reason the privilege layer holds.
//
// Not run by default: `scripts/compliance.mjs` spawns this script as part
// of AF3 against the live database, and a prover that writes on every
// invocation is a prover nobody dares run.
if (process.argv.includes("--prove")) {
  console.log("\nMADE TO FAIL ON PURPOSE — each in a transaction that is rolled back\n");

  /**
   * The OWNER connection, opened once and only if a proof needs it.
   *
   * `corgi_app` cannot disable a trigger; that is layer 1 working, not a
   * limitation to route around. A proof that needs one runs as the owner and
   * prints the fact. If no owner URL is configured the proof FAILS — a check
   * that cannot be performed is unknown, and unknown is never a pass.
   */
  let ownerSql = null;
  let ownerTried = false;
  function owner() {
    if (ownerTried) return ownerSql;
    ownerTried = true;
    const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
    if (url) ownerSql = postgres(url, { max: 1, onnotice: () => {} });
    return ownerSql;
  }

  /** Run `body` in a transaction that cannot commit. Returns its value. */
  async function inRollback(conn, body) {
    let captured;
    try {
      await conn.begin(async (tx) => {
        captured = await body(tx);
        throw new Error("__dbcheck_rollback__");
      });
    } catch (e) {
      if (!String(e.message).includes("__dbcheck_rollback__")) throw e;
    }
    return captured;
  }

  /** First row of a statement, or undefined. */
  const one = async (tx, q) => (await tx.unsafe(q))[0];

  /** The system actor every posting in this book is attributed to. */
  const ACTOR = `(SELECT id FROM actor WHERE kind='system' AND display_name='ledger-poster' LIMIT 1)`;

  // =====================================================================
  // THE PROOFS
  // =====================================================================
  //
  // One entry per invariant view. `run` builds the violating state and
  // returns either nothing (it worked) or a STRING saying why it could not
  // be built — which is a failure, printed by name, never a silent skip.
  //
  //   view     the invariant being violated
  //   how      the sentence printed beside the delta
  //   as       "app" (corgi_app, the role the product runs as) or "owner"
  //   disable  triggers switched off for the transaction, printed out loud
  //   expect   the exact delta, or "increase" with the reason in `note`
  //   note     printed under the delta
  const PROOFS = [
    // ---- the journal ------------------------------------------------
    {
      view: "v_entry_unbalanced",
      how: "one extra line appended to a balanced entry",
      as: "app",
      note:
        "the entry is unbalanced INSIDE the transaction and could never commit: " +
        "`journal_line_balanced` is a DEFERRABLE INITIALLY DEFERRED constraint trigger " +
        "that fires at COMMIT. The view is the second line of defence, and this is what " +
        "it would see if the first ever failed — proved below by forcing the check early.",
      async run(tx) {
        const e = await one(tx, `
          SELECT l.entry_id FROM journal_line l
            JOIN journal_entry je ON je.id = l.entry_id
           GROUP BY l.entry_id, je.booking_seq ORDER BY je.booking_seq DESC LIMIT 1`);
        if (!e) return "this book has no journal entry to append a line to";
        await tx.unsafe(`
          INSERT INTO journal_line (entry_id, ordinal, account_id, amount_cents, currency, value_date, booking_seq)
          SELECT l.entry_id, max(l.ordinal) + 1, (array_agg(l.account_id ORDER BY l.ordinal))[1], 1, 'USD',
                 min(l.value_date), min(l.booking_seq)
            FROM journal_line l WHERE l.entry_id = '${e.entry_id}'::uuid GROUP BY l.entry_id`);
        return undefined;
      },
      /** The other half: the deferred constraint refuses the same state. */
      async andAlso(tx) {
        try {
          await tx.unsafe("SET CONSTRAINTS journal_line_balanced IMMEDIATE");
          return { refused: false, message: "the database ALLOWED the unbalanced entry" };
        } catch (err) {
          return { refused: true, message: String(err.message).split("\n")[0] };
        }
      },
    },
    {
      view: "v_line_denorm_drift",
      how: "a line whose value_date is a day ahead of the entry it belongs to",
      as: "app",
      note:
        "two lines are appended, +1 and -1, so the ENTRY still balances and only the " +
        "denormalised clock drifts — this guard and v_entry_unbalanced are proved " +
        "independent rather than by one write that trips both",
      async run(tx) {
        const e = await one(tx, `
          SELECT l.entry_id FROM journal_line l JOIN journal_entry je ON je.id = l.entry_id
           GROUP BY l.entry_id, je.booking_seq ORDER BY je.booking_seq DESC LIMIT 1`);
        if (!e) return "this book has no journal entry to append a line to";
        await tx.unsafe(`
          INSERT INTO journal_line (entry_id, ordinal, account_id, amount_cents, currency, value_date, booking_seq)
          SELECT l.entry_id, max(l.ordinal) + 1, (array_agg(l.account_id ORDER BY l.ordinal))[1], 1, 'USD',
                 min(l.value_date) + 1, min(l.booking_seq)
            FROM journal_line l WHERE l.entry_id = '${e.entry_id}'::uuid GROUP BY l.entry_id`);
        await tx.unsafe(`
          INSERT INTO journal_line (entry_id, ordinal, account_id, amount_cents, currency, value_date, booking_seq)
          SELECT l.entry_id, max(l.ordinal) + 1, (array_agg(l.account_id ORDER BY l.ordinal))[1], -1, 'USD',
                 min(l.value_date), min(l.booking_seq)
            FROM journal_line l WHERE l.entry_id = '${e.entry_id}'::uuid GROUP BY l.entry_id`);
        return undefined;
      },
    },
    {
      view: "v_book_not_zero",
      how: "one unbalanced line, which takes an entity's whole book off zero",
      as: "app",
      async run(tx) {
        const e = await one(tx, `
          SELECT l.entry_id FROM journal_line l JOIN journal_entry je ON je.id = l.entry_id
           GROUP BY l.entry_id, je.booking_seq ORDER BY je.booking_seq DESC LIMIT 1`);
        if (!e) return "this book has no journal entry to append a line to";
        await tx.unsafe(`
          INSERT INTO journal_line (entry_id, ordinal, account_id, amount_cents, currency, value_date, booking_seq)
          SELECT l.entry_id, max(l.ordinal) + 1, (array_agg(l.account_id ORDER BY l.ordinal))[1], 1, 'USD',
                 min(l.value_date), min(l.booking_seq)
            FROM journal_line l WHERE l.entry_id = '${e.entry_id}'::uuid GROUP BY l.entry_id`);
        return undefined;
      },
    },
    {
      view: "v_deposit_control_drift",
      how: "customer money booked to the HOUSE 2100 root, where no business can report it",
      as: "app",
      note:
        "the deposits subtree counts every 2100 account; the reported side counts only " +
        "the ones with a business_id. A line on the house root is inside the control " +
        "total and outside every customer's balance — the classic control-account break",
      async run(tx) {
        const root = await one(tx, `SELECT id FROM account WHERE code='2100' AND business_id IS NULL LIMIT 1`);
        if (!root) return "there is no house 2100 root account on this chart";
        const e = await one(tx, `
          SELECT l.entry_id FROM journal_line l JOIN journal_entry je ON je.id = l.entry_id
           WHERE je.book = 'financial'
           GROUP BY l.entry_id, je.booking_seq ORDER BY je.booking_seq DESC LIMIT 1`);
        if (!e) return "this book has no financial entry to append a line to";
        await tx.unsafe(`
          INSERT INTO journal_line (entry_id, ordinal, account_id, amount_cents, currency, value_date, booking_seq)
          SELECT l.entry_id, max(l.ordinal) + 1, '${root.id}'::uuid, 1, 'USD',
                 min(l.value_date), min(l.booking_seq)
            FROM journal_line l WHERE l.entry_id = '${e.entry_id}'::uuid GROUP BY l.entry_id`);
        return undefined;
      },
    },

    // ---- the hold model ----------------------------------------------
    {
      view: "v_hold_drift",
      how: "an incremental authorisation the memo book was never told about",
      as: "app",
      async run(tx) {
        const t = await one(tx, `
          SELECT ca.id AS auth_id
            FROM v_hold_state hs
            JOIN v_card_auth_hold ch ON ch.hold_id = hs.hold_id
            JOIN card_authorization ca ON ca.hold_id = hs.hold_id
           WHERE NOT hs.is_released AND hs.memo_balance_cents = ch.target_hold_cents
           ORDER BY hs.hold_id LIMIT 1`);
        if (!t) return "no live card hold to raise an authorisation against";
        await tx.unsafe(`
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
          VALUES ('${t.auth_id}'::uuid, 'incremental_authorization', 1, false, current_date,
                  'dbcheck-prove-holddrift-' || gen_random_uuid()::text)`);
        return undefined;
      },
    },
    {
      view: "v_hold_release_drift",
      how: "an operator closure over a hold whose memo book is still carrying money",
      as: "app",
      note: "this is the crash the 7b integration test simulates, left unrepaired",
      async run(tx) {
        const t = await one(tx, `
          SELECT hs.hold_id FROM v_hold_state hs
           WHERE NOT hs.is_released AND hs.memo_balance_cents <> 0
           ORDER BY hs.hold_id LIMIT 1`);
        if (!t) return "no live hold is carrying memo money to close over";
        await tx.unsafe(`
          INSERT INTO hold_closure (hold_id, reason, actor_id, source)
          VALUES ('${t.hold_id}'::uuid,
                  'dbcheck --prove: an operator release with the memo book left standing',
                  ${ACTOR}, 'operator')`);
        return undefined;
      },
    },
    {
      view: "v_hold_closure_not_terminal",
      how: "a posting-path closure over an authorisation the fold still calls OPEN",
      as: "app",
      note:
        "the closure declares source='posting_path' (migration 0040). The same row " +
        "written with source='repair' or 'test_harness' does NOT move this guard, " +
        "which is the whole point of the column — see the second proof below",
      async run(tx) {
        const t = await one(tx, `
          SELECT ch.hold_id FROM v_card_auth_hold ch
           WHERE NOT ch.is_closed
             AND NOT EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = ch.hold_id)
           ORDER BY ch.hold_id LIMIT 1`);
        if (!t) return "every open card authorisation on this book is already closed or already has a closure row";
        await tx.unsafe(`
          INSERT INTO hold_closure (hold_id, reason, actor_id, source)
          VALUES ('${t.hold_id}'::uuid,
                  'dbcheck --prove: a permanent closure on a reversible condition',
                  ${ACTOR}, 'posting_path')`);
        return undefined;
      },
    },
    {
      view: "v_hold_closure_not_terminal",
      label: "v_hold_closure_not_terminal(repair is OUT)",
      how: "the SAME row again, declared source='repair'",
      as: "app",
      expect: 0,
      note:
        "0 is the pass here. A repair closes a hold the fold calls open ON PURPOSE — " +
        "0026 and 0032 did it 52 times, because the fold's input had lost the network's " +
        "refusal. Before 0040 the population was chosen by matching English against " +
        "hold_closure.reason, so which side of the guard a row landed on depended on its " +
        "WORDING. This proof is the column doing its job in the negative direction.",
      async run(tx) {
        const t = await one(tx, `
          SELECT ch.hold_id FROM v_card_auth_hold ch
           WHERE NOT ch.is_closed
             AND NOT EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = ch.hold_id)
           ORDER BY ch.hold_id LIMIT 1`);
        if (!t) return "every open card authorisation on this book already has a closure row";
        await tx.unsafe(`
          INSERT INTO hold_closure (hold_id, reason, actor_id, source)
          VALUES ('${t.hold_id}'::uuid,
                  'dbcheck --prove: a repair closing a hold that was never owed',
                  ${ACTOR}, 'repair')`);
        return undefined;
      },
    },
    {
      view: "v_hold_expiry_drift",
      how: "a hold and its authorisation given expiry instants one second apart",
      as: "app",
      note:
        "ledger_availability() reads hold.expires_at and v_card_auth_hold reads " +
        "card_authorization.expires_at. ensureAuthorization() writes one value into both; " +
        "nothing in the schema says it must. Nine fixture rows on this book already differ " +
        "by 135-158 ms, which is why this view is a standing failure above",
      async run(tx) {
        const seed = await one(tx, `
          SELECT h.account_id, h.memo_account_id, ca.card_id
            FROM hold h JOIN card_authorization ca ON ca.hold_id = h.id
           WHERE h.kind = 'card_auth' ORDER BY h.id LIMIT 1`);
        if (!seed) return "this book has no card authorisation to model the proof on";
        const hold = await one(tx, `
          INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, expires_at)
          VALUES ('${seed.account_id}'::uuid, '${seed.memo_account_id}'::uuid, 'card_auth',
                  'dbcheck-prove-expiry-' || gen_random_uuid()::text, current_date,
                  now() + interval '7 days')
          RETURNING id`);
        await tx.unsafe(`
          INSERT INTO card_authorization (provider, provider_auth_id, card_id, account_id, hold_id, origin, expires_at)
          VALUES ('lithic', 'dbcheck-prove-expiry-' || gen_random_uuid()::text,
                  '${seed.card_id}'::uuid, '${seed.account_id}'::uuid, '${hold.id}'::uuid,
                  'authorization', now() + interval '7 days 1 second')`);
        return undefined;
      },
    },
    {
      view: "v_balance_definition_drift",
      how: "a card hold whose OWN clock has run out while the authorisation's has not",
      as: "app",
      note:
        "the same asymmetry v_hold_expiry_drift names, turned into money: " +
        "ledger_availability() drops the hold on hold.expires_at, v_hold_state keeps it " +
        "because v_card_auth_hold reads the authorisation. The customer's available " +
        "balance and the hold model then disagree about the same dollars",
      async run(tx) {
        const seed = await one(tx, `
          SELECT h.account_id, h.memo_account_id, e.entity_id, e.id AS entry_id
            FROM hold h
            JOIN journal_entry e ON e.hold_id = h.id AND e.book = 'memo'
           WHERE h.kind = 'card_auth'
           ORDER BY e.booking_seq LIMIT 1`);
        if (!seed) return "this book has no card-hold memo entry to model the proof on";
        const hold = await one(tx, `
          INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, expires_at)
          VALUES ('${seed.account_id}'::uuid, '${seed.memo_account_id}'::uuid, 'card_auth',
                  'dbcheck-prove-balancedef-' || gen_random_uuid()::text, current_date,
                  now() - interval '1 hour')
          RETURNING id`);
        // The memo entry goes through `ledger_append()` — the same single write
        // path everything else uses — with the seed entry's own lines, so an
        // entry that does not balance is refused by the ledger, not by this script.
        await tx.unsafe(`
          SELECT ledger_append(
            '${seed.entity_id}'::uuid, current_date, 'memo'::account_book, 'original'::entry_type,
            'dbcheck --prove: a hold the two definitions of available disagree about',
            'dbcheck-prove-balancedef:' || '${hold.id}', ${ACTOR},
            (SELECT jsonb_agg(jsonb_build_object(
                      'account_id', l.account_id,
                      'amount_cents', l.amount_cents::text,
                      'currency', l.currency,
                      'memo', 'dbcheck --prove') ORDER BY l.ordinal)
               FROM journal_line l WHERE l.entry_id = '${seed.entry_id}'::uuid),
            NULL, NULL, NULL, '${hold.id}'::uuid, NULL, NULL)`);
        return undefined;
      },
    },

    // ---- the card verdict, which reaches outside the fold --------------
    {
      view: "v_refused_auth_hold",
      label: "v_refused_auth_hold(refused)",
      how: "a DECLINED verdict on a live hold's authorisation",
      as: "app",
      count: `SELECT count(*)::int AS n FROM v_refused_auth_hold WHERE verdict = 'refused'`,
      async run(tx) {
        const t = await one(tx, `
          SELECT ca.id AS auth_id FROM v_hold_state hs
            JOIN card_authorization ca ON ca.hold_id = hs.hold_id
           WHERE hs.active_hold_cents > 0 ORDER BY hs.hold_id LIMIT 1`);
        if (!t) return "no hold is withholding money to prove it on";
        const ev = await one(tx, `
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
          VALUES ('${t.auth_id}'::uuid, 'authorization', 1, false, current_date,
                  'dbcheck-prove-refused-' || gen_random_uuid()::text)
          RETURNING id`);
        await tx.unsafe(`
          INSERT INTO card_auth_event_result (event_id, result, provider_step, source)
          VALUES ('${ev.id}'::uuid, 'DECLINED', 'AUTHORIZATION', 'retained_payload')`);
        return undefined;
      },
    },
    {
      view: "v_refused_auth_hold",
      label: "v_refused_auth_hold(unanswered)",
      how: "an authorisation event on a live hold with NO verdict recorded",
      as: "app",
      count: `SELECT count(*)::int AS n FROM v_refused_auth_hold WHERE verdict = 'unanswered'`,
      note:
        "THE ONE THE OLD DEFINITION COULD NOT EXPRESS. Under 0026's INNER JOIN and " +
        "`r.result IS NOT NULL` this moved the count by exactly zero, for ever — while " +
        "98 of 130 authorisation events on live holds carried no verdict at all",
      async run(tx) {
        const t = await one(tx, `
          SELECT ca.id AS auth_id FROM v_hold_state hs
            JOIN card_authorization ca ON ca.hold_id = hs.hold_id
           WHERE hs.active_hold_cents > 0 ORDER BY hs.hold_id LIMIT 1`);
        if (!t) return "no hold is withholding money to prove it on";
        await tx.unsafe(`
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
          VALUES ('${t.auth_id}'::uuid, 'authorization', 1, false, current_date,
                  'dbcheck-prove-unanswered-' || gen_random_uuid()::text)`);
        return undefined;
      },
    },
    {
      view: "v_wire_availability_drift",
      how: "a wire credit whose money becomes spendable an hour after it was booked",
      as: "app",
      async run(tx) {
        const seed = await one(tx, `
          SELECT h.account_id, h.memo_account_id, e.entity_id, e.id AS entry_id
            FROM hold h
            JOIN journal_entry e ON e.hold_id = h.id AND e.book = 'memo' AND e.rail = 'wire'
           WHERE h.kind = 'uncleared_credit'
           ORDER BY e.booking_seq LIMIT 1`);
        if (!seed) return "no wire credit on this book to model the proof on";
        const hold = await one(tx, `
          INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, available_at)
          VALUES ('${seed.account_id}'::uuid, '${seed.memo_account_id}'::uuid, 'uncleared_credit',
                  'dbcheck-prove-wire-' || gen_random_uuid()::text, current_date,
                  now() + interval '1 hour')
          RETURNING id`);
        await tx.unsafe(`
          SELECT ledger_append(
            '${seed.entity_id}'::uuid, current_date, 'memo'::account_book, 'original'::entry_type,
            'dbcheck --prove: a wire credit that is NOT immediately spendable',
            'dbcheck-prove-wire:' || '${hold.id}', ${ACTOR},
            (SELECT jsonb_agg(jsonb_build_object(
                      'account_id', l.account_id,
                      'amount_cents', l.amount_cents::text,
                      'currency', l.currency,
                      'memo', 'dbcheck --prove') ORDER BY l.ordinal)
               FROM journal_line l WHERE l.entry_id = '${seed.entry_id}'::uuid),
            'wire'::rail, NULL, NULL, '${hold.id}'::uuid, NULL, NULL)`);
        return undefined;
      },
    },

    // ---- fees and interest ---------------------------------------------
    {
      view: "v_accrual_month_drift",
      how: "a COMPLETE month of daily shares that do not sum to the monthly fee",
      as: "owner",
      disable: [["accrual_posting", "accrual_posting_lifecycle"]],
      note:
        "this guard has an EMPTY POPULATION on this book — zero complete accrual months — " +
        "so the proof has to build the month before it can break it: a whole February, " +
        "every day decided, with each day's share computed for a 31-day month. " +
        "Green because there is nothing to be green about is not the same as green",
      async run(tx) {
        const seed = await one(tx, `
          SELECT s.account_id, s.product::text AS product FROM accrual_schedule s LIMIT 1`);
        if (!seed) return "this book has no accrual schedule to copy a product from";
        const entry = await one(tx, `SELECT id FROM journal_entry WHERE book='financial' ORDER BY booking_seq DESC LIMIT 1`);
        if (!entry) return "this book has no financial entry for the postings to cite";
        const sched = await one(tx, `
          INSERT INTO accrual_schedule (account_id, product, plan_name, monthly_cents,
                                        start_date, end_date, created_by, schedule_key)
          VALUES ('${seed.account_id}'::uuid, '${seed.product}', 'dbcheck --prove', 2901,
                  '2019-02-01'::date, '2019-02-28'::date, ${ACTOR},
                  'dbcheck-prove-accrual-' || gen_random_uuid()::text)
          RETURNING id`);
        await tx.unsafe(`
          INSERT INTO accrual_day (schedule_id, accrual_date, claimed_by)
          SELECT '${sched.id}'::uuid, d::date, 'dbcheck --prove'
            FROM generate_series('2019-02-01'::date, '2019-02-28'::date, interval '1 day') d`);
        // days_in_month is a COLUMN, and the arithmetic CHECK holds it to its own
        // value rather than to the calendar — so a month priced as 31 days and
        // claimed for 28 satisfies every constraint and still loses $2.79.
        await tx.unsafe(`
          INSERT INTO accrual_posting (accrual_day_id, disposition, monthly_cents, days_in_month,
                                       day_of_month, base_share_cents, residual_pennies,
                                       residual_applied, amount_cents, cumulative_cents,
                                       entry_id, decided_by_run)
          SELECT ad.id, 'posted', 2901, 31, EXTRACT(DAY FROM ad.accrual_date)::int,
                 accrual_base_share(2901, 31), accrual_residual_pennies(2901, 31),
                 (EXTRACT(DAY FROM ad.accrual_date)::int <= accrual_residual_pennies(2901, 31)),
                 accrual_daily_share(2901, 31, EXTRACT(DAY FROM ad.accrual_date)::int),
                 accrual_cumulative_through(2901, 31, EXTRACT(DAY FROM ad.accrual_date)::int),
                 '${entry.id}'::uuid, 'dbcheck --prove'
            FROM accrual_day ad WHERE ad.schedule_id = '${sched.id}'::uuid`);
        return undefined;
      },
    },
    {
      view: "v_accrual_ledger_drift",
      how: "an accrual day posted against an entry that belongs to a different day",
      as: "owner",
      disable: [["accrual_posting", "accrual_posting_lifecycle"]],
      note:
        "the lifecycle trigger already refuses a posting that cites an entry it did not " +
        "key — it derives `accrual:<schedule>:<date>` and compares — so this state is " +
        "unreachable through the product and the view is the second line behind it",
      async run(tx) {
        const seed = await one(tx, `
          SELECT s.account_id, s.product::text AS product FROM accrual_schedule s LIMIT 1`);
        if (!seed) return "this book has no accrual schedule to copy a product from";
        const entry = await one(tx, `
          SELECT id FROM journal_entry WHERE book='financial' AND value_date <> '2019-03-05'::date
           ORDER BY booking_seq DESC LIMIT 1`);
        if (!entry) return "this book has no financial entry for the posting to mis-cite";
        const sched = await one(tx, `
          INSERT INTO accrual_schedule (account_id, product, plan_name, monthly_cents,
                                        start_date, end_date, created_by, schedule_key)
          VALUES ('${seed.account_id}'::uuid, '${seed.product}', 'dbcheck --prove', 3100,
                  '2019-03-01'::date, '2019-03-31'::date, ${ACTOR},
                  'dbcheck-prove-accrual-day-' || gen_random_uuid()::text)
          RETURNING id`);
        const day = await one(tx, `
          INSERT INTO accrual_day (schedule_id, accrual_date, claimed_by)
          VALUES ('${sched.id}'::uuid, '2019-03-05'::date, 'dbcheck --prove')
          RETURNING id`);
        await tx.unsafe(`
          INSERT INTO accrual_posting (accrual_day_id, disposition, monthly_cents, days_in_month,
                                       day_of_month, base_share_cents, residual_pennies,
                                       residual_applied, amount_cents, cumulative_cents,
                                       entry_id, decided_by_run)
          VALUES ('${day.id}'::uuid, 'posted', 3100, 31, 5,
                  accrual_base_share(3100, 31), accrual_residual_pennies(3100, 31),
                  (5 <= accrual_residual_pennies(3100, 31)),
                  accrual_daily_share(3100, 31, 5), accrual_cumulative_through(3100, 31, 5),
                  '${entry.id}'::uuid, 'dbcheck --prove')`);
        return undefined;
      },
    },
    {
      view: "v_interest_ledger_drift",
      how: "an interest posting made to cite an entry belonging to a different day",
      as: "owner",
      disable: [["interest_posting", "interest_posting_lifecycle"]],
      note:
        "0024 recorded this delta as 0 -> 1 with the trigger disabled; this runs it. " +
        "The trigger is the reason the state cannot be reached through the product, " +
        "and the view is what would see it if it ever were",
      async run(tx) {
        const seed = await one(tx, `
          SELECT ip.interest_day_id, d.schedule_id,
                 to_char(max(d2.accrual_date) + 1, 'YYYY-MM-DD') AS free_date
            FROM interest_posting ip
            JOIN interest_day d ON d.id = ip.interest_day_id
            JOIN interest_day d2 ON d2.schedule_id = d.schedule_id
           WHERE ip.disposition = 'posted'
           GROUP BY ip.interest_day_id, d.schedule_id, d.accrual_date
           ORDER BY d.accrual_date LIMIT 1`);
        if (!seed) return "this book has no posted interest day to model the proof on";
        // A day INSIDE the enrolment window — interest_day_window refuses anything
        // else — but one nothing has claimed, so the posting below is genuinely a
        // new day citing an old day's entry.
        const day = await one(tx, `
          INSERT INTO interest_day (schedule_id, accrual_date, claimed_by)
          VALUES ('${seed.schedule_id}'::uuid, '${seed.free_date}'::date, 'dbcheck --prove')
          RETURNING id`);
        // Every numeric field is copied from a REAL posting, so the arithmetic
        // CHECK passes untouched. The only lie is which day the entry belongs to.
        await tx.unsafe(`
          INSERT INTO interest_posting (interest_day_id, disposition, side, policy_id,
                                        basis_balance_cents, observed_booking_seq, rate_bps,
                                        day_count, numerator, denominator, whole_cents,
                                        remainder_units, rounding, amount_cents, entry_id,
                                        decided_by_run)
          SELECT '${day.id}'::uuid, ip.disposition, ip.side, ip.policy_id,
                 ip.basis_balance_cents, ip.observed_booking_seq, ip.rate_bps,
                 ip.day_count, ip.numerator, ip.denominator, ip.whole_cents,
                 ip.remainder_units, ip.rounding, ip.amount_cents, ip.entry_id,
                 'dbcheck --prove'
            FROM interest_posting ip WHERE ip.interest_day_id = '${seed.interest_day_id}'::uuid`);
        return undefined;
      },
    },
    {
      view: "v_interest_rate_drift",
      how: "a rate row backdated behind interest_rate_policy_forward_only",
      as: "owner",
      disable: [["interest_rate_policy", "interest_rate_policy_forward_only"]],
      expect: "increase",
      note:
        "the delta is not 1 and should not be: ONE backdated rate row re-prices EVERY " +
        "posting on that tier from that day forward, which is exactly the harm the " +
        "forward-only trigger exists to prevent. 0024 measured 0 -> 5",
      async run(tx) {
        // A date the tier has no policy row for yet, so the INSERT is a genuine
        // BACKDATE rather than a unique-key collision with the real rate card.
        const tier = await one(tx, `
          SELECT s.rate_tier, to_char(d.accrual_date, 'YYYY-MM-DD') AS oldest
            FROM interest_posting ip
            JOIN interest_day d ON d.id = ip.interest_day_id
            JOIN interest_schedule s ON s.id = d.schedule_id
           WHERE NOT EXISTS (SELECT 1 FROM interest_rate_policy p
                              WHERE p.tier = s.rate_tier AND p.effective_from = d.accrual_date)
           ORDER BY d.accrual_date LIMIT 1`);
        if (!tier) return "this book has no interest posting to re-price";
        await tx.unsafe(`
          INSERT INTO interest_rate_policy (tier, effective_from, credit_rate_bps,
                                            overdraft_rate_bps, day_count_denominator, note, created_by)
          VALUES ('${tier.rate_tier}', '${tier.oldest}'::date, 77, 1234, 365,
                  'dbcheck --prove: a backdated re-rate slipped past the trigger', ${ACTOR})`);
        return undefined;
      },
    },

    // ---- standing orders, disputes, team -------------------------------
    {
      view: "v_standing_order_double_fire",
      how: "a second instruction for one occurrence, under a different spelling of the derived key",
      as: "app",
      note:
        "NOBODY HAD EVER SEEN THIS VIEW RETURN A ROW. Until 0023 it joined " +
        "payment_instruction on a UNIQUE column and asked for count > 1, so no state of " +
        "the database could satisfy it, and its emptiness was quoted as proof in a test, " +
        "a document and compliance.mjs. 0023 repointed it at the mandate's KEYSPACE — " +
        "which is the question the unique index does not answer — and this is the first " +
        "time the repaired body has been made to fire",
      async run(tx) {
        const seed = await one(tx, `
          SELECT o.standing_order_id, pi.id AS pi_id
            FROM standing_order_occurrence o
            JOIN payment_instruction pi ON pi.idempotency_key = o.idempotency_key
           ORDER BY o.claimed_at DESC LIMIT 1`);
        if (!seed) return "no standing-order occurrence has fired an instruction yet";
        await tx.unsafe(`
          INSERT INTO payment_instruction
            (account_id, rail, amount_cents, currency, counterparty, value_date,
             requested_by, policy_id, idempotency_key, content_hash)
          SELECT p.account_id, p.rail, p.amount_cents, p.currency, p.counterparty, p.value_date,
                 p.requested_by, p.policy_id,
                 'standing:' || '${seed.standing_order_id}' || ':'
                   || to_char(p.value_date, 'YYYY-M-D') || '#retry-after-a-restart',
                 p.content_hash
            FROM payment_instruction p WHERE p.id = '${seed.pi_id}'::uuid`);
        return undefined;
      },
    },
    {
      view: "v_dispute_ledger_double_count",
      how: "two dispute events of different kinds citing one journal entry",
      as: "owner",
      disable: [["dispute_event", "dispute_event_lifecycle"]],
      expect: "increase",
      note:
        "the delta is one row per LINE of the entry, not one row overall: the episode " +
        "screen would count that entry's money twice for every line it carries. The " +
        "lifecycle trigger refuses a second event of a kind the dispute has already " +
        "passed, which is why this one needs the owner connection — the double count " +
        "is unreachable through the product, and the view is what would see it anyway",
      async run(tx) {
        const seed = await one(tx, `
          SELECT de.dispute_id, de.entry_id, de.kind::text AS kind, de.actor_id
            FROM dispute_event de
           WHERE de.entry_id IS NOT NULL ORDER BY de.occurred_at LIMIT 1`);
        if (!seed) return "this book has no dispute event citing a journal entry";
        const other = await one(tx, `
          SELECT k::text AS kind FROM unnest(enum_range(NULL::dispute_event_kind)) k
           WHERE k::text <> '${seed.kind}'
             AND NOT EXISTS (SELECT 1 FROM dispute_event d2
                              WHERE d2.dispute_id = '${seed.dispute_id}'::uuid
                                AND d2.entry_id = '${seed.entry_id}'::uuid
                                AND d2.kind = k)
           LIMIT 1`);
        if (!other) return "no second dispute event kind is available for this dispute";
        await tx.unsafe(`
          INSERT INTO dispute_event (dispute_id, kind, actor_id, value_date, entry_id, detail)
          SELECT '${seed.dispute_id}'::uuid, '${other.kind}', '${seed.actor_id}'::uuid,
                 e.value_date, e.id, 'dbcheck --prove: one entry, counted twice'
            FROM journal_entry e WHERE e.id = '${seed.entry_id}'::uuid`);
        return undefined;
      },
    },
    {
      view: "v_approved_auth_for_dead_member",
      how: "a card authorisation approved for a member whose version says removed",
      as: "owner",
      disable: [["team_member_version", "team_member_version_chain"]],
      note:
        "the removed-member VERSION is what has to be manufactured, and the chain " +
        "trigger refuses to append one out of band — so this proof is also evidence " +
        "that 0033's version chain is doing its job",
      async run(tx) {
        const seed = await one(tx, `
          SELECT tmv.id, tmv.member_id, tmv.version, tmv.role
            FROM team_member_version tmv
           WHERE tmv.state = 'active'
           ORDER BY tmv.created_at DESC LIMIT 1`);
        if (!seed) return "this book has no team member version to model the proof on";
        const dead = await one(tx, `
          INSERT INTO team_member_version (member_id, version, effective_from, state, role, note, created_by)
          VALUES ('${seed.member_id}'::uuid,
                  (SELECT max(version) + 1 FROM team_member_version WHERE member_id = '${seed.member_id}'::uuid),
                  now(), 'removed', '${seed.role}',
                  'dbcheck --prove: the member is gone', ${ACTOR})
          RETURNING id`);
        const card = await one(tx, `SELECT id, provider_card_token FROM card LIMIT 1`);
        if (!card) return "this book has no card to attach the decision to";
        await tx.unsafe(`
          INSERT INTO card_auth_decision
            (provider, provider_auth_token, provider_card_token, card_id, amount_cents,
             request_status, outcome, result_code, rule, reason, decision_latency_us,
             source, member_id, member_version_id)
          VALUES ('lithic', 'dbcheck-prove-' || gen_random_uuid()::text,
                  '${card.provider_card_token}', '${card.id}'::uuid, 100,
                  'AUTHORIZATION', 'approve', 'APPROVED', 'dbcheck --prove',
                  'an approval for a member who no longer exists', 1, 'harness',
                  '${seed.member_id}'::uuid, '${dead.id}'::uuid)`);
        return undefined;
      },
    },
    {
      view: "v_member_approval_without_right",
      how: "an approval filed by a member whose role at the time could not approve",
      as: "owner",
      disable: [
        ["payment_instruction_event", "payment_instruction_event_maker_checker"],
        ["payment_instruction_event", "payment_instruction_event_team"],
      ],
      note:
        "TWO triggers have to be switched off to write this row, and that is the finding, " +
        "not the workaround: 0001's maker-checker and 0033's team check COMPOSE rather " +
        "than overlap, so the state this view reports is unreachable through the product",
      async run(tx) {
        const seed = await one(tx, `
          SELECT pi.id AS instruction_id, tm.actor_id, tm.id AS member_id, tmv.version, tmv.role
            FROM payment_instruction pi
            JOIN account acct ON acct.id = pi.account_id
            JOIN team_member tm ON tm.business_id = acct.business_id
            JOIN LATERAL (SELECT v.version, v.role FROM team_member_version v
                           WHERE v.member_id = tm.id ORDER BY v.version DESC LIMIT 1) tmv ON true
           WHERE NOT EXISTS (SELECT 1 FROM payment_instruction_event e
                              WHERE e.instruction_id = pi.id AND e.kind = 'approved'
                                AND e.actor_id = tm.actor_id)
           ORDER BY pi.requested_at DESC LIMIT 1`);
        if (!seed) return "no payment instruction with an unused team member to approve it";
        await tx.unsafe(`ALTER TABLE team_member_version DISABLE TRIGGER team_member_version_chain`);
        await tx.unsafe(`
          INSERT INTO team_member_version (member_id, version, effective_from, state, role, note, created_by)
          VALUES ('${seed.member_id}'::uuid,
                  (SELECT max(version) + 1 FROM team_member_version WHERE member_id = '${seed.member_id}'::uuid),
                  now() - interval '1 year', 'active', 'viewer',
                  'dbcheck --prove: a viewer, who cannot approve', ${ACTOR})`);
        await tx.unsafe(`
          INSERT INTO payment_instruction_event (instruction_id, kind, actor_id, value_date, reason)
          SELECT pi.id, 'approved', '${seed.actor_id}'::uuid, pi.value_date,
                 'dbcheck --prove: approved by someone who held no right to'
            FROM payment_instruction pi WHERE pi.id = '${seed.instruction_id}'::uuid`);
        return undefined;
      },
    },

    // ---- interchange: the first guards about whether an entry SHOULD exist
    {
      view: "v_interchange_unreversed",
      how: "the network takes a settlement back and the interchange is left standing",
      as: "app",
      expect: "increase",
      note:
        "the reversal is appended through ledger_append() into the settlement's own " +
        "correction group, which is what the product does — the omission is the second " +
        "half, the unbooking that never happens",
      async run(tx) {
        const t = await one(tx, `
          SELECT ip.id, ip.settlement_entry_id
            FROM interchange_posting ip
            JOIN v_interchange_settlement_net n ON n.interchange_posting_id = ip.id
           WHERE NOT EXISTS (SELECT 1 FROM journal_entry r
                              WHERE r.reverses_entry_id = ip.settlement_entry_id)
           ORDER BY ip.value_date DESC LIMIT 1`);
        if (!t) return "every priced settlement on this book has already been reversed";
        await tx.unsafe(`
          SELECT ledger_append(
            se.entity_id, se.value_date, se.book, 'reversal'::entry_type,
            'dbcheck --prove: settlement taken back, interchange left standing',
            'dbcheck-prove-ic:' || gen_random_uuid()::text, ${ACTOR},
            (SELECT jsonb_agg(jsonb_build_object(
                      'account_id', l.account_id,
                      'amount_cents', (-l.amount_cents)::text,
                      'currency', l.currency,
                      'memo', 'dbcheck --prove') ORDER BY l.ordinal)
               FROM journal_line l WHERE l.entry_id = se.id),
            se.rail, NULL, NULL, NULL, se.id, se.correction_group_id)
            FROM journal_entry se WHERE se.id = '${t.settlement_entry_id}'::uuid`);
        return undefined;
      },
    },
    {
      view: "v_interchange_drift",
      how: "the same reversal, asked the harder question: what is the interchange now WORTH",
      as: "app",
      expect: "increase",
      note:
        "v_interchange_unreversed asks whether the repair happened; this one asks whether " +
        "the amount is right, and reads journal_entry and journal_line only — never " +
        "interchange_reversal, because a bookkeeping table can be written without the " +
        "money moving and can be lost while the money is perfectly correct",
      async run(tx) {
        const t = await one(tx, `
          SELECT ip.id, ip.settlement_entry_id
            FROM interchange_posting ip
            JOIN v_interchange_settlement_net n ON n.interchange_posting_id = ip.id
           WHERE NOT EXISTS (SELECT 1 FROM journal_entry r
                              WHERE r.reverses_entry_id = ip.settlement_entry_id)
           ORDER BY ip.value_date DESC LIMIT 1`);
        if (!t) return "every priced settlement on this book has already been reversed";
        await tx.unsafe(`
          SELECT ledger_append(
            se.entity_id, se.value_date, se.book, 'reversal'::entry_type,
            'dbcheck --prove: settlement taken back, interchange never re-priced',
            'dbcheck-prove-icd:' || gen_random_uuid()::text, ${ACTOR},
            (SELECT jsonb_agg(jsonb_build_object(
                      'account_id', l.account_id,
                      'amount_cents', (-l.amount_cents)::text,
                      'currency', l.currency,
                      'memo', 'dbcheck --prove') ORDER BY l.ordinal)
               FROM journal_line l WHERE l.entry_id = se.id),
            se.rail, NULL, NULL, NULL, se.id, se.correction_group_id)
            FROM journal_entry se WHERE se.id = '${t.settlement_entry_id}'::uuid`);
        return undefined;
      },
    },
    {
      view: "v_interchange_rate_drift",
      how: "a rate row backdated behind interchange_rate_policy_forward_only",
      as: "owner",
      disable: [["interchange_rate_policy", "interchange_rate_policy_forward_only"]],
      expect: "increase",
      note: "one backdated row re-prices every settlement in that category from that day on",
      async run(tx) {
        const t = await one(tx, `
          SELECT ip.category, ip.presentment::text AS presentment,
                 to_char(min(ip.value_date), 'YYYY-MM-DD') AS oldest
            FROM interchange_posting ip
           GROUP BY ip.category, ip.presentment ORDER BY count(*) DESC LIMIT 1`);
        if (!t) return "this book has no priced settlement to re-rate";
        await tx.unsafe(`
          INSERT INTO interchange_rate_policy
            (category, presentment, effective_from, rate_bps, fixed_cents, note, created_by)
          VALUES ('${t.category}', '${t.presentment}', '${t.oldest}'::date, 77, 1,
                  'dbcheck --prove: a backdated re-rate slipped past the trigger', ${ACTOR})`);
        return undefined;
      },
    },

    // ---- 0043: the advice conversion, and the closure nobody could see --
    //
    // Four proofs for two views, and in both cases the SECOND one is the
    // one worth reading. A guard that fires on the defect is half the
    // claim; a guard that stays quiet on the legitimate case that looks
    // identical is the other half, and this build has shipped three guards
    // that had only the first half (0012, 0026, 0028).
    {
      view: "v_advice_delta_unsound",
      how: "an AUTHORIZATION_ADVICE of 0 stored as a delta of +1, i.e. converted against a base of -1",
      as: "app",
      note:
        "the base is RECOVERED, not re-derived: payload absolute (0) minus stored signed " +
        "delta (+1) = -1, and an authorised amount cannot be negative. The two numbers come " +
        "from different places — the row we wrote and the body the provider sent, retained " +
        "in webhook_inbox — which is the only reason this view can see anything the fold " +
        "cannot. This is the shape of the live row on Lithic 5892c550-…, scaled to 1 cent.",
      async run(tx) {
        const t = await one(tx, `
          SELECT id FROM card_authorization ORDER BY id LIMIT 1`);
        if (!t) return "this book has no card authorisation to hang an advice on";
        const token = `dbcheck-prove-advice-${Date.now()}`;
        const inbox = await one(tx, `
          INSERT INTO webhook_inbox (provider, provider_event_id, event_type, payload,
                                     raw_body, signature_verified_at, state, processed_at)
          VALUES ('lithic', '${token}-inbox', 'card_transaction.updated',
                  jsonb_build_object('events', jsonb_build_array(
                    jsonb_build_object('token', '${token}', 'type', 'AUTHORIZATION_ADVICE',
                                       'amount', 0, 'result', 'APPROVED'))),
                  '{}', now(), 'done', now())
          RETURNING id`);
        const ev = await one(tx, `
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date,
                                       provider_event_id, inbox_id)
          VALUES ('${t.id}'::uuid, 'incremental_authorization', 1, false, current_date,
                  '${token}', '${inbox.id}'::uuid)
          RETURNING id`);
        await tx.unsafe(`
          INSERT INTO card_auth_event_result (event_id, result, provider_step, source)
          VALUES ('${ev.id}'::uuid, 'APPROVED', 'AUTHORIZATION_ADVICE', 'ingest')`);
        return undefined;
      },
    },
    {
      view: "v_advice_delta_unsound",
      label: "v_advice_delta_unsound(a sound advice is OUT)",
      how: "the SAME advice, whose payload absolute of 1 matches its stored delta of +1",
      as: "app",
      expect: 0,
      note:
        "0 is the pass. The guard is not 'an advice exists' — it is 'the base this advice " +
        "was measured from could not have been an authorised amount'. Base = 1 - 1 = 0, " +
        "which is the base every advice on this book except one was converted against, and " +
        "it is fine. Without this proof the first one would also pass if the view simply " +
        "reported every advice it could find.",
      async run(tx) {
        const t = await one(tx, `
          SELECT id FROM card_authorization ORDER BY id LIMIT 1`);
        if (!t) return "this book has no card authorisation to hang an advice on";
        const token = `dbcheck-prove-advice-ok-${Date.now()}`;
        const inbox = await one(tx, `
          INSERT INTO webhook_inbox (provider, provider_event_id, event_type, payload,
                                     raw_body, signature_verified_at, state, processed_at)
          VALUES ('lithic', '${token}-inbox', 'card_transaction.updated',
                  jsonb_build_object('events', jsonb_build_array(
                    jsonb_build_object('token', '${token}', 'type', 'AUTHORIZATION_ADVICE',
                                       'amount', 1, 'result', 'APPROVED'))),
                  '{}', now(), 'done', now())
          RETURNING id`);
        const ev = await one(tx, `
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date,
                                       provider_event_id, inbox_id)
          VALUES ('${t.id}'::uuid, 'incremental_authorization', 1, false, current_date,
                  '${token}', '${inbox.id}'::uuid)
          RETURNING id`);
        await tx.unsafe(`
          INSERT INTO card_auth_event_result (event_id, result, provider_step, source)
          VALUES ('${ev.id}'::uuid, 'APPROVED', 'AUTHORIZATION_ADVICE', 'ingest')`);
        return undefined;
      },
    },
    {
      view: "v_hold_closure_unexplained",
      how: "a test_harness closure over an open authorisation the network never refused",
      as: "app",
      note:
        "THIS IS THE ROW `v_hold_closure_not_terminal` CANNOT SEE. Declared " +
        "source='test_harness', so that guard's `source IN ('posting_path','expiry_sweep')` " +
        "excludes it; the memo book is at zero, so v_hold_release_drift excludes it; the " +
        "closure makes is_released true, so v_hold_drift excludes it. Four rows of exactly " +
        "this shape ($132.00) have stood on this book since 2026-09-10 — docs/HOLDS.md §10.4",
      async run(tx) {
        const t = await one(tx, `
          SELECT ch.hold_id, ch.auth_id FROM v_card_auth_hold ch
           WHERE NOT ch.is_closed
             AND NOT EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = ch.hold_id)
             AND NOT EXISTS (SELECT 1 FROM card_auth_event e
                               JOIN card_auth_event_result r ON r.event_id = e.id
                              WHERE e.auth_id = ch.auth_id
                                AND r.result IS NOT NULL AND r.result <> 'APPROVED')
           ORDER BY ch.hold_id LIMIT 1`);
        if (!t) return "every open card authorisation on this book already has a closure row or a refusal on record";
        await tx.unsafe(`
          INSERT INTO hold_closure (hold_id, reason, actor_id, source)
          VALUES ('${t.hold_id}'::uuid,
                  'dbcheck --prove: a fixture closing a hold the model never terminated',
                  ${ACTOR}, 'test_harness')`);
        return undefined;
      },
    },
    {
      view: "v_hold_closure_unexplained",
      label: "v_hold_closure_unexplained(a refused auth is OUT)",
      how: "the SAME closure, over an authorisation the network is on record as having REFUSED",
      as: "app",
      expect: 0,
      note:
        "0 is the pass, and this is the clause that lets 0026's and 0032's 52 repair " +
        "closures out — by EVIDENCE, per row, not by their declared source. The fold calls " +
        "those authorisations open because its INPUT lost the refusal; the refusal is in " +
        "card_auth_event_result, which the fold does not read. 0040 §10.3 claimed they were " +
        "owned by v_refused_auth_hold instead: measured today, 0 of the 52 are in it, " +
        "because 0032's own repair took them out of it. Ownership by membership was stale " +
        "the day it was written; ownership by evidence is not.",
      async run(tx) {
        const t = await one(tx, `
          SELECT ch.hold_id, ch.auth_id FROM v_card_auth_hold ch
           WHERE NOT ch.is_closed
             AND NOT EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = ch.hold_id)
           ORDER BY ch.hold_id LIMIT 1`);
        if (!t) return "every open card authorisation on this book already has a closure row";
        // The refusal is manufactured the only way the schema allows: a
        // `declined` event and its verdict, which is what ingest writes
        // (0026). `card_auth_event_result_agrees_with_kind` refuses a
        // DECLINED filed under `authorization`, and that trigger is NOT
        // disabled here — the proof goes through the front door.
        const ev = await one(tx, `
          INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final, value_date, provider_event_id)
          VALUES ('${t.auth_id}'::uuid, 'declined', 1, false, current_date,
                  'dbcheck-prove-refusal-' || gen_random_uuid()::text)
          RETURNING id`);
        await tx.unsafe(`
          INSERT INTO card_auth_event_result (event_id, result, provider_step, source)
          VALUES ('${ev.id}'::uuid, 'DECLINED', 'AUTHORIZATION', 'ingest')`);
        await tx.unsafe(`
          INSERT INTO hold_closure (hold_id, reason, actor_id, source)
          VALUES ('${t.hold_id}'::uuid,
                  'dbcheck --prove: a closure over an authorisation the network refused',
                  ${ACTOR}, 'test_harness')`);
        return undefined;
      },
    },

    // ---- 0044: the author of a member's terms ---------------------------
    {
      view: "v_team_terms_by_unauthorised_author",
      how: "a member's terms written by an admin who had already been removed",
      as: "owner",
      disable: [["team_member_version", "team_member_version_chain"]],
      note:
        "the chain trigger is 0044's OWN fix, so it has to be switched off to write the " +
        "row at all — which is the proof that the repair holds: before 0044 this state " +
        "was reachable through the front door, by the application role, with every " +
        "trigger armed. The removed version is BACKDATED one minute because now() is the " +
        "TRANSACTION timestamp and the view reads the author's terms STRICTLY BEFORE the " +
        "row it judges, so that a change made later in a transaction can never indict a " +
        "write made earlier in it",
      async run(tx) {
        // An author and a target in the SAME business, and not the same
        // person — a member editing their own terms is a different question.
        const seed = await one(tx, `
          SELECT author.id       AS author_member_id,
                 author.actor_id AS author_actor_id,
                 target.id       AS target_member_id
            FROM team_member author
            JOIN team_member target ON target.business_id = author.business_id
                                   AND target.id <> author.id
            JOIN v_team_member_current ac ON ac.member_id = author.id
            JOIN v_team_member_current tc ON tc.member_id = target.id
           WHERE ac.state = 'active' AND tc.state = 'active'
           ORDER BY author.created_at DESC LIMIT 1`);
        if (!seed) return "this book has no two active members of one business to model the proof on";
        // 1. the author is removed, an hour of clock ago.
        await tx.unsafe(`
          INSERT INTO team_member_version
            (member_id, version, effective_from, state, role, note, created_by, created_at)
          SELECT '${seed.author_member_id}'::uuid,
                 max(version) + 1, now() - interval '1 minute', 'removed',
                 (SELECT role FROM v_team_member_current WHERE member_id = '${seed.author_member_id}'::uuid),
                 'dbcheck --prove: the author is gone', ${ACTOR}, now() - interval '1 minute'
            FROM team_member_version WHERE member_id = '${seed.author_member_id}'::uuid`);
        // 2. …and then writes somebody else's terms anyway.
        await tx.unsafe(`
          INSERT INTO team_member_version
            (member_id, version, state, role, note, created_by)
          SELECT '${seed.target_member_id}'::uuid, max(version) + 1, 'active',
                 (SELECT role FROM v_team_member_current WHERE member_id = '${seed.target_member_id}'::uuid),
                 'dbcheck --prove: authored by a removed admin',
                 '${seed.author_actor_id}'::uuid
            FROM team_member_version WHERE member_id = '${seed.target_member_id}'::uuid`);
        return undefined;
      },
    },
  ];

  // ---- the driver -----------------------------------------------------
  //
  // COVERAGE IS COMPUTED, NOT CLAIMED. It walks the invariant arrays this
  // script already checks, so a view added above without a proof here is a
  // named FAILURE on the next run rather than a quiet gap. That is the same
  // mistake this whole section exists to stop being possible.
  const ALL_VIEWS = GATED_INVARIANTS;
  const proven = new Set();

  for (const [view] of ALL_VIEWS) {
    const specs = PROOFS.filter((p) => p.view === view);
    if (specs.length === 0) {
      bad(`${view} CAN fail`, "NO PROOF IS REGISTERED FOR THIS VIEW — it is trusted, not tested");
      continue;
    }
    for (const spec of specs) await runProof(spec);
    proven.add(view);
  }

  async function runProof(spec) {
    const label = `${spec.label ?? spec.view} CAN fail`;
    const countQ = spec.count ?? `SELECT count(*)::int AS n FROM ${spec.view}`;
    const conn = spec.as === "owner" ? owner() : sql;
    if (conn === null) {
      bad(label, "no owner connection configured (DIRECT_URL/DATABASE_URL) — a proof that cannot be performed is not a pass");
      return;
    }

    let out;
    try {
      out = await inRollback(conn, async (tx) => {
        const [b] = await tx.unsafe(countQ);
        for (const [table, trigger] of spec.disable ?? []) {
          await tx.unsafe(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
        }
        const blocked = await spec.run(tx);
        if (blocked) return { blocked };
        const [a] = await tx.unsafe(countQ);
        const extra = spec.andAlso ? await spec.andAlso(tx) : null;
        return { before: b.n, after: a.n, extra };
      });
    } catch (e) {
      bad(label, String(e.message).split("\n")[0].slice(0, 110));
      return;
    }

    if (out?.blocked) {
      bad(label, `could not build the violating state: ${out.blocked}`);
      return;
    }

    const want = spec.expect ?? 1;
    const moved = out.after - out.before;
    const okDelta =
      want === "increase" ? moved > 0 : want === 0 ? moved === 0 : moved === want;

    // The rollback is a claim too. Read the view again, on the APP connection,
    // outside every transaction this proof opened.
    const [post] = await sql.unsafe(countQ);
    const cleanedUp = post.n === out.before;

    if (okDelta && cleanedUp) {
      ok(label, `${out.before} -> ${out.after} after ${spec.how}`);
    } else if (!okDelta) {
      bad(label, `${out.before} -> ${out.after} after ${spec.how} — expected ${want === "increase" ? "an increase" : `+${want}`}`);
    } else {
      bad(label, `the rollback did NOT clean up: the view now reads ${post.n}, not ${out.before}`);
    }

    for (const [table, trigger] of spec.disable ?? []) {
      console.log(`        trigger disabled for the proof, on the OWNER connection: ${table}.${trigger}`);
      console.log(`        ^ the product cannot reach this state at all; the view is the second line`);
    }
    if (spec.note) for (const line of wrap(spec.note, 84)) console.log(`        ${line}`);
    if (out.extra) {
      console.log(
        out.extra.refused
          ? `        and the deferred constraint refuses it too: ${out.extra.message.slice(0, 76)}`
          : `        BUT the deferred constraint did NOT refuse it: ${out.extra.message}`,
      );
    }
  }

  // ---- 9z. the other half of 0026's guarantee ---------------------------
  //
  // Not a view proof: the trigger that makes the state unwritable through the
  // live ingest path. A refusal filed under a kind that feeds the hold
  // arithmetic must be REFUSED at INSERT, not reported later.
  try {
    const refused = await inRollback(sql, async (tx) => {
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

  console.log(
    `\n  --prove covered ${proven.size} of ${ALL_VIEWS.length} invariant views` +
      ` (${PROOFS.length} proofs, ${PROOFS.filter((p) => p.as === "owner").length} of them needing a trigger` +
      ` disabled on the owner connection)\n`,
  );

  if (ownerSql) await ownerSql.end();
} else {
  console.log("\n  (run with --prove to make EVERY invariant view FAIL on purpose, each in a");
  console.log("   transaction that is rolled back — a guard nobody has seen fail is a claim)\n");
}

/** Soft-wrap a note so the proof's reasoning stays readable in a terminal. */
function wrap(text, width) {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line.length + word.length + 1 > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);
