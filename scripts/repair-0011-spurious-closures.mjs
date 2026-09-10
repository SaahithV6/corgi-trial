#!/usr/bin/env node
/**
 * Reverse the `hold_closure` rows that should never have been written.
 *
 * BACKGROUND. `hold_closure` is append-only and its PRIMARY KEY (hold_id) is
 * what makes release exactly-once. That is the right design and it has one
 * consequence nobody enjoys: a row written in error stays written. Fixing the
 * writer does not unwrite what it wrote.
 *
 * Three holds in this database carry a closure reading "authorisation fully
 * reversed" whose authorisation was never reversed. All three have
 * `origin = 'clearing_first'`: the settlement beat its authorisation, which
 * makes A = 0 transiently, which satisfies the `A <= 0` arm, and a build from
 * before `terminallyClosed` existed wrote the permanent row on the strength of
 * it. The late authorisation then arrived and reopened the hold — but the
 * closure row outranks the fold in `is_released`, so $20.00 each is spendable
 * while still authorised.
 *
 * WHAT THIS WILL AND WILL NOT TOUCH. It reverses a closure only when all four
 * of these hold, and it refuses — loudly, without writing — on anything else:
 *
 *   1. `v_hold_release_drift` reports the hold, i.e. it is released and its
 *      memo book still withholds money;
 *   2. the fold over its event set says it is genuinely still open
 *      (`target_hold_cents > 0`), so the memo book is right and the closure
 *      is wrong, not the other way round;
 *   3. the closure reason is the `A <= 0` fallback string;
 *   4. `card_authorization.origin = 'clearing_first'`, which is the arrival
 *      order that produced the bug.
 *
 * An operator's deliberate `closeHold()` fails 2 and 3 and is left alone. That
 * matters: `holds.integration.test.ts` scenario 7 leaves four such rows behind
 * on purpose, and a repair script that "tidied" them would be destroying a
 * test fixture and calling it a fix.
 *
 * Idempotent: PRIMARY KEY (hold_id) on the reversal table, ON CONFLICT DO
 * NOTHING, so running it twice reverses nothing twice.
 *
 *   node scripts/repair-0011-spurious-closures.mjs           # dry run
 *   node scripts/repair-0011-spurious-closures.mjs --apply   # append
 */
import postgres from "postgres";

const url = process.env.DIRECT_URL || process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DIRECT_URL / APP_DATABASE_URL is not set");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");
const sql = postgres(url, { max: 1, onnotice: () => {} });

const REASON_FALLBACK = "authorisation fully reversed";

const candidates = await sql`
  SELECT d.hold_id,
         d.memo_balance_cents,
         d.closure_reason,
         a.business_id,
         ca.provider_auth_id,
         ca.origin,
         ch.auth_net_cents,
         ch.captured_cents,
         ch.target_hold_cents
    FROM v_hold_release_drift d
    JOIN account            a  ON a.id  = d.account_id
    JOIN card_authorization ca ON ca.hold_id = d.hold_id
    JOIN v_card_auth_hold   ch ON ch.hold_id = d.hold_id
   ORDER BY d.closed_at`;

console.log(`v_hold_release_drift reports ${candidates.length} hold(s).\n`);

const safe = [];
for (const c of candidates) {
  const reasons = [];
  if (c.target_hold_cents <= 0n) reasons.push(`fold says nothing is held (target ${c.target_hold_cents})`);
  if (c.closure_reason !== REASON_FALLBACK) reasons.push(`closure reason is "${c.closure_reason}", not the A<=0 fallback`);
  if (c.origin !== "clearing_first") reasons.push(`origin is "${c.origin}", not clearing_first`);

  const head = `hold ${c.hold_id} (${c.provider_auth_id}) memo ${c.memo_balance_cents} target ${c.target_hold_cents} A=${c.auth_net_cents} C=${c.captured_cents}`;
  if (reasons.length > 0) {
    console.log(`  REFUSE  ${head}\n          ${reasons.join("; ")}`);
    continue;
  }
  console.log(`  REVERSE ${head}\n          closed as "${c.closure_reason}" but A=${c.auth_net_cents} was never reversed`);
  safe.push(c);
}

if (safe.length === 0) {
  console.log("\nNothing to repair.");
  await sql.end();
  process.exit(0);
}

// postgres.js hands bigint columns back as strings, and `0n + "2000"` is
// string concatenation rather than a TypeError, so the naive reduce prints
// "0200020002000" and looks like a number. Coerce every one of them.
const freed = safe.reduce((n, c) => n + BigInt(c.memo_balance_cents), 0n);
console.log(`\n${safe.length} hold(s), ${freed} cents currently spendable while still authorised.`);

if (!APPLY) {
  console.log("Dry run. Re-run with --apply to append the reversals.");
  await sql.end();
  process.exit(0);
}

const [actor] = await sql`
  SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
if (!actor) throw new Error("no 'ledger-poster' system actor; run node scripts/seed.mjs");

for (const c of safe) {
  const before = await sql`SELECT available_cents FROM v_available_balance WHERE business_id = ${c.business_id}::uuid`;
  await sql`
    INSERT INTO hold_closure_reversal (hold_id, reason, actor_id)
    VALUES (${c.hold_id}::uuid,
            ${`closure written by the pre-terminallyClosed clearing_first path; A=${c.auth_net_cents} C=${c.captured_cents}, never reversed, ${c.memo_balance_cents} still authorised`},
            ${actor.id}::uuid)
    ON CONFLICT (hold_id) DO NOTHING`;
  const after = await sql`SELECT available_cents FROM v_available_balance WHERE business_id = ${c.business_id}::uuid`;
  console.log(`  ${c.hold_id}: available ${before[0]?.available_cents} -> ${after[0]?.available_cents}`);
}

const [drift] = await sql`SELECT count(*)::int AS n FROM v_hold_release_drift`;
const [live] = await sql`SELECT count(*)::int AS n FROM v_hold_drift`;
console.log(`\nv_hold_release_drift: ${drift.n}   v_hold_drift: ${live.n}   (both must be 0)`);
await sql.end();
process.exit(drift.n === 0 && live.n === 0 ? 0 : 1);
