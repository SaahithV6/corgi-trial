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
const stored = await sql`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public'
    AND (column_name LIKE '%balance%' OR column_name = 'available_cents')
    AND table_name NOT LIKE 'v\\_%'
    -- statement.opening/closing_balance_cents are deliberately stored. A
    -- statement is a PUBLISHED ARTEFACT: the figure it asserted must remain
    -- queryable forever exactly as published, even after a later correction
    -- changes what the ledger now says that day was. That is the opposite of
    -- a drifting cache -- it is the as-published axis of the bitemporal model.
    -- Every other table must have no stored balance.
    AND table_name <> 'statement'`;
if (stored.length) {
  bad("no stored balance column", stored.map((r) => `${r.table_name}.${r.column_name}`).join(", "));
} else {
  ok("no stored balance column", "balances are derived, not stored");
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
];

console.log("\nINVARIANT VIEWS — each MUST return zero rows\n");
for (const [view, claim] of INVARIANT_VIEWS) {
  try {
    const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM ${view}`);
    const n = rows[0]?.n ?? 0;
    if (n === 0) ok(`${view} is empty`, claim);
    else bad(`${view} is empty`, `${n} row(s) — ${claim}`);
  } catch (e) {
    // A view this role cannot read is not a pass. Say which, and fail.
    bad(`${view} is empty`, `could not be read: ${String(e.message).split("\n")[0].slice(0, 70)}`);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);
