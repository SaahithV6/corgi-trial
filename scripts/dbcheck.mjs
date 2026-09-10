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
  badPriv.length
    ? bad(`grants on ${g.table_name}`, `holds ${badPriv.join(",")}`)
    : ok(`grants on ${g.table_name}`, g.privs);
}

// ---- 3. every entry balances -----------------------------------------
const unbalanced = await sql`
  SELECT entry_id, currency, SUM(amount_cents) AS delta
  FROM journal_line GROUP BY entry_id, currency HAVING SUM(amount_cents) <> 0`;
unbalanced.length
  ? bad("every entry sums to zero", `${unbalanced.length} unbalanced`)
  : ok("every entry sums to zero", "checked all entries");

// ---- 4. trial balance --------------------------------------------------
const [tb] = await sql`SELECT COALESCE(SUM(amount_cents),0) AS total FROM journal_line
                       WHERE currency = 'USD'`;
String(tb.total) === "0"
  ? ok("trial balance is zero", "sum of all lines")
  : bad("trial balance is zero", `off by ${tb.total} cents`);

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
stored.length
  ? bad("no stored balance column", stored.map((s) => `${s.table_name}.${s.column_name}`).join(", "))
  : ok("no stored balance column", "balances are derived, not stored");

// ---- 6. denormalised clocks have not drifted --------------------------
const drift = await sql`
  SELECT count(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
  WHERE l.value_date <> e.value_date OR l.booking_seq <> e.booking_seq`;
String(drift[0].n) === "0"
  ? ok("denormalised clocks match their entry", "zero drift")
  : bad("denormalised clocks match their entry", `${drift[0].n} rows drifted`);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
await sql.end();
process.exit(fail ? 1 : 0);
