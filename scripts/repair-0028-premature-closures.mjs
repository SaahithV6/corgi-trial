#!/usr/bin/env node
/**
 * Reverse the `hold_closure` rows migration 0028 proved could not be trusted.
 *
 * BACKGROUND.  Before 0028, `HoldState.terminallyClosed` carried the arm
 * `(sawAuthorisation && A <= 0)`.  That arm is a predicate on a running total
 * that can go back up, and it licensed an APPEND-ONLY `hold_closure` row.  A $0
 * card-on-file authorisation, or a genuine full reversal, closed the hold for
 * ever; the incremental that arrived one delivery later re-opened it, and
 * `v_hold_state.is_released` reads the closure row first.  The customer could
 * spend money the network still had authorised.  Same shape as the clearing-first
 * bug of migration 0011, in the arm that survived it.
 *
 * 0028 removed the arm.  Fixing the writer does not unwrite what it wrote:
 * `hold_closure` has PRIMARY KEY (hold_id) and no DELETE exists for it, not for
 * the migration role either.  A wrong row in an immutable table is corrected the
 * way a wrong journal entry is -- you append its reversal.  That is
 * `hold_closure_reversal` (0011), and this script is the same shape as
 * `repair-0011-spurious-closures.mjs`, deliberately.
 *
 * WHAT IT WILL TOUCH.  Exactly what `v_hold_closure_not_terminal` reports: a
 * closure the POSTING PATH wrote, not already reversed, whose fold over the full
 * event set now says the authorisation is OPEN.  That is the defect and nothing
 * else.  It then re-checks, per row, that:
 *
 *   1. the fold genuinely holds money (`target_hold_cents > 0`), so the closure
 *      is the thing that is wrong and not the memo book;
 *   2. the memo book ALREADY AGREES with the fold
 *      (`memo_balance_cents = target_hold_cents`).  If it does not, reversing
 *      the closure makes the hold live and `v_hold_drift` starts reporting --
 *      trading a silent bug for a loud one.  This script refuses instead, and
 *      names `settleHoldPosting()` as the thing to run first, because a repair
 *      script has no business appending money outside `postEntry()`.
 *
 * WHAT IT WILL NOT TOUCH, and reports separately:
 *
 *   - PREMATURE BUT UNCONTRADICTED closures: written on the `A <= 0` arm, so a
 *     post-0028 build would not have written them, but nothing has contradicted
 *     them -- `A` is still <= 0, the fold still says closed, the memo book is
 *     flat and no number is wrong.  `hold_closure_reversal` means "should never
 *     have been written", which is a stronger claim than "a later build would
 *     not have written it".  Appending reversals that move no number, into an
 *     append-only audit table, to make a report look tidier, is the same
 *     manufactured-evidence move this repository keeps catching itself at.  They
 *     are listed and left alone.
 *   - An operator's deliberate `closeHold()`.  0011 §3: the operator overrides
 *     the model.  Excluded by the view, and named here if it turns up anyway.
 *
 * Idempotent: PRIMARY KEY (hold_id) on `hold_closure_reversal`, ON CONFLICT DO
 * NOTHING, so running it twice reverses nothing twice.
 *
 *   node scripts/repair-0028-premature-closures.mjs           # dry run
 *   node scripts/repair-0028-premature-closures.mjs --apply   # append
 */
import postgres from "postgres";

const url = process.env.DIRECT_URL || process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DIRECT_URL / APP_DATABASE_URL is not set");
  process.exit(1);
}
const APPLY = process.argv.includes("--apply");
const sql = postgres(url, { max: 1, onnotice: () => {} });

/** `closureReason()`'s fallback: the string the removed arm produced. */
const REASON_FALLBACK = "authorisation fully reversed";

// ---------------------------------------------------------------------------
// 1.  The defect: a closure the fold no longer believes.
// ---------------------------------------------------------------------------

const candidates = await sql`
  SELECT v.*, a.business_id
    FROM v_hold_closure_not_terminal v
    JOIN hold h ON h.id = v.hold_id
    JOIN account a ON a.id = h.account_id
   ORDER BY v.closed_at`;

console.log(`v_hold_closure_not_terminal reports ${candidates.length} hold(s).\n`);

const safe = [];
for (const c of candidates) {
  const reasons = [];
  if (BigInt(c.target_hold_cents) <= 0n) {
    reasons.push(`fold says nothing is held (target ${c.target_hold_cents})`);
  }
  if (BigInt(c.memo_balance_cents) !== BigInt(c.target_hold_cents)) {
    reasons.push(
      `memo ${c.memo_balance_cents} <> target ${c.target_hold_cents}; ` +
        `run settleHoldPosting() for this hold BEFORE reversing the closure, or ` +
        `v_hold_drift will report it the moment it goes live`,
    );
  }

  const head =
    `hold ${c.hold_id} (${c.provider_auth_id}) memo ${c.memo_balance_cents} ` +
    `target ${c.target_hold_cents} A=${c.auth_net_cents} C=${c.captured_cents}`;
  if (reasons.length > 0) {
    console.log(`  REFUSE  ${head}\n          ${reasons.join("\n          ")}`);
    continue;
  }
  console.log(
    `  REVERSE ${head}\n` +
      `          closed as "${c.closure_reason}" but A=${c.auth_net_cents} is above zero again`,
  );
  safe.push(c);
}

// ---------------------------------------------------------------------------
// 2.  The weaker class, for the record: written on the arm, never contradicted.
// ---------------------------------------------------------------------------
//
// These are NOT repaired.  Reported because "the defect was latent" is only a
// real result if you can say how close it got, and this is the number.

const premature = await sql`
  SELECT hc.hold_id, hc.closed_at, ca.provider_auth_id, ca.origin,
         s.auth_net_cents, s.captured_cents, s.event_count,
         hs.memo_balance_cents, hs.is_released, ch.is_closed,
         (hr.hold_id IS NOT NULL) AS already_reversed
    FROM hold_closure       hc
    JOIN card_authorization ca ON ca.hold_id = hc.hold_id
    JOIN v_card_auth_state  s  ON s.hold_id  = hc.hold_id
    JOIN v_card_auth_hold   ch ON ch.hold_id = hc.hold_id
    JOIN v_hold_state       hs ON hs.hold_id = hc.hold_id
    LEFT JOIN hold_closure_reversal hr ON hr.hold_id = hc.hold_id
   WHERE hc.reason = ${REASON_FALLBACK}
     AND NOT s.saw_final
     AND NOT s.saw_close
     AND ch.is_closed              -- still closed: nothing has contradicted it
   ORDER BY hc.closed_at`;

if (premature.length > 0) {
  console.log(
    `\n${premature.length} closure(s) written on the arm 0028 removed, which nothing has\n` +
      `contradicted. A post-0028 build would not write these; no number is wrong, so\n` +
      `they are NOT reversed. Listed so the difference is visible rather than assumed:`,
  );
  for (const p of premature) {
    console.log(
      `  LEAVE   hold ${p.hold_id} (${p.provider_auth_id}) origin ${p.origin} ` +
        `A=${p.auth_net_cents} C=${p.captured_cents} over ${p.event_count} events; ` +
        `memo ${p.memo_balance_cents}, is_closed=${p.is_closed}, released=${p.is_released}` +
        (p.already_reversed ? ", already reversed" : ""),
    );
  }
}

// ---------------------------------------------------------------------------
// 3.  Reachability: has the live book ever carried the shapes at all?
// ---------------------------------------------------------------------------

const [reach] = await sql`
  SELECT count(*) FILTER (WHERE kind = 'authorization' AND amount_cents = 0)::int AS zero_auths,
         count(*) FILTER (WHERE kind = 'incremental_authorization')::int           AS incrementals,
         count(*) FILTER (WHERE kind = 'authorization_reversal')::int              AS reversals,
         count(*)::int                                                             AS events
    FROM card_auth_event`;
console.log(
  `\nReachability in the live book: ${reach.events} card events; ` +
    `${reach.zero_auths} zero-amount authorisations (witness A), ` +
    `${reach.incrementals} incrementals and ${reach.reversals} reversals ` +
    `(the only kinds that can raise A after a closure).`,
);

if (safe.length === 0) {
  console.log("\nNothing to repair.");
  await sql.end();
  process.exit(0);
}

const freed = safe.reduce((n, c) => n + BigInt(c.memo_balance_cents), 0n);
console.log(`\n${safe.length} hold(s), ${freed} cents currently spendable while still authorised.`);

if (!APPLY) {
  console.log("Dry run. Re-run with --apply to append the reversals.");
  await sql.end();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 4.  The compensating append.
// ---------------------------------------------------------------------------

const [actor] = await sql`
  SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
if (!actor) throw new Error("no 'ledger-poster' system actor; run node scripts/seed.mjs");

for (const c of safe) {
  const before = await sql`
    SELECT available_cents FROM v_available_balance WHERE business_id = ${c.business_id}::uuid`;
  await sql`
    INSERT INTO hold_closure_reversal (hold_id, reason, actor_id)
    VALUES (${c.hold_id}::uuid,
            ${
              `closure written on the pre-0028 \`A <= 0\` arm of terminallyClosed; ` +
              `A=${c.auth_net_cents} C=${c.captured_cents} over ${c.event_count} events, ` +
              `a later event raised A above zero and ${c.memo_balance_cents} is still authorised`
            },
            ${actor.id}::uuid)
    ON CONFLICT (hold_id) DO NOTHING`;
  const after = await sql`
    SELECT available_cents FROM v_available_balance WHERE business_id = ${c.business_id}::uuid`;
  console.log(`  ${c.hold_id}: available ${before[0]?.available_cents} -> ${after[0]?.available_cents}`);
}

// ---------------------------------------------------------------------------
// 5.  All three must be empty, including the one this repair could break.
// ---------------------------------------------------------------------------
//
// A reversal makes the hold LIVE, which moves it out of v_hold_release_drift's
// scope and into v_hold_drift's. Checking only the view this script reads would
// miss exactly the failure this script can cause.

let failed = 0;
for (const view of ["v_hold_closure_not_terminal", "v_hold_drift", "v_hold_release_drift"]) {
  const [row] = await sql.unsafe(`SELECT count(*)::int AS n FROM ${view}`);
  console.log(`  ${view.padEnd(30)} ${row.n}   (must be 0)`);
  if (row.n !== 0) failed += 1;
}

await sql.end();
process.exit(failed === 0 ? 0 : 1);
