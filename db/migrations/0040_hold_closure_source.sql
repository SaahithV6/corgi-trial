-- =====================================================================
-- 0040  hold_closure.source  -  a guard stops discriminating on prose
-- =====================================================================
--
-- THE DEFECT.  `v_hold_closure_not_terminal` (0028) selects its population
-- with
--
--     WHERE hc.reason IN ( ...five English sentences... )
--
-- against `hold_closure.reason`, which is free text.  Measured on this
-- database on 2026-09-11: 228 closure rows exist and the literal list can
-- see 126 of them.  **102 rows (45%) are outside the invariant by
-- construction**, and migration 0032's own twelve closures are among them
-- - not because a repair should be inside the guard, but because nothing
-- about the row said so except its WORDING.  0028 wrote that cost down
-- ("the cost of keying on reason strings is that a new closureReason()
-- branch added to apply.ts without being added here is silently outside
-- the invariant") and shipped anyway.  This migration pays it.
--
-- THE FIX.  A closure declares WHO WROTE IT, in a CHECK-constrained
-- column, and the view filters on that.  A reason is a sentence for a
-- human; a source is a fact for a machine, and the two stop being the
-- same field.
--
-- ---------------------------------------------------------------------
-- THE SET OF SOURCES IS DERIVED FROM THE CODE, NOT INVENTED
-- ---------------------------------------------------------------------
--
-- Every statement in this repository that can produce a `hold_closure`
-- row, found by `grep -rn 'INSERT INTO hold_closure'` over src/, db/ and
-- scripts/ - there are exactly two in application code and two in
-- migrations - and then by the call sites of the two functions:
--
--   src/lib/holds/store.ts        closeHold(), called from
--     - src/lib/holds/apply.ts      the model's terminal predicate, with
--                                   closureReason(state)   -> posting_path
--     - src/lib/holds/expiry.ts     expireOne()/sweepExpiredHolds()
--                                                          -> expiry_sweep
--     - src/lib/rails/plaid/adapter.ts   the ACH uncleared-credit
--                                   availability sweep -> availability_sweep
--     - src/lib/rails/wire/ledger.ts     the zero-day wire release
--                                                     -> wire_availability
--     - src/lib/holds/holds.integration.test.ts  case 7b writes a closure
--                                   against this shared book on purpose,
--                                   to simulate a crash    -> test_harness
--   src/lib/disputes/store.ts     closeDisputeHold()        -> dispute
--   db/migrations/0026_auth_result.sql, 0032_guard_repairs.sql
--                                 refused-authorisation repairs -> repair
--
-- `operator` is in the CHECK with no writer behind it today, and that is
-- deliberate rather than sloppy: 0011 SS3 and 0028 both reason about "an
-- operator's deliberate closeHold()" overriding the model, and the policy
-- needs a name before the screen exists.  A value with no rows is not a
-- claim - `dbcheck`'s GUARD REACH prints the census per source on every
-- run, so `operator 0` is a printed fact rather than a comment.
--
-- ---------------------------------------------------------------------
-- HOW YOU ADD A COLUMN TO AN APPEND-ONLY TABLE
-- ---------------------------------------------------------------------
--
-- `hold_closure` carries `hold_closure_no_update_delete`, a BEFORE UPDATE
-- OR DELETE FOR EACH ROW trigger running `ledger_row_is_immutable()`,
-- which raises 55006 unconditionally.  It binds the OWNER too - that is
-- its entire purpose, per 0001 SS13 ("these exist to catch a future
-- migration ... running as the table OWNER").  So the obvious backfill,
--
--     UPDATE hold_closure SET source = ...
--
-- is refused, and the obvious workaround - DISABLE TRIGGER, UPDATE,
-- ENABLE TRIGGER - is a migration switching off the immutability guard
-- on a money-adjacent table.  This build's whole argument is that such a
-- thing is never necessary.  It is not necessary here either.
--
-- ADD COLUMN and ALTER COLUMN ... TYPE are DDL.  They rewrite the heap
-- wholesale; they do not issue an UPDATE, and row-level UPDATE triggers
-- do not fire for them.  And `ALTER COLUMN ... TYPE ... USING <expr>` is
-- the one form of DDL whose expression may read the row's OWN columns.
-- So the backfill is expressed as a type change that happens to keep the
-- type:
--
--     ALTER TABLE hold_closure ADD COLUMN source text;              -- all NULL
--     ALTER TABLE hold_closure ALTER COLUMN source TYPE text
--       USING (CASE ... END);                                       -- classified
--
-- No UPDATE is executed, no trigger is disabled, and the immutability
-- guard is still armed for the statement after this one.  Verified in a
-- rolled-back transaction against this database before this file was
-- written: the CASE evaluated per row, the trigger did not fire, and an
-- ordinary `UPDATE hold_closure SET source = source` in the same session
-- was still refused with 55006.
--
-- Nothing a row already asserted is touched.  `hold_id`, `reason`,
-- `actor_id` and `closed_at` come out of the rewrite bit-identical; the
-- column being filled did not exist when the row was written, so this
-- classifies history rather than rewriting it.
--
-- ---------------------------------------------------------------------
-- WHAT THE VIEW RANGES OVER AFTERWARDS, AND WHY THE REST IS OUT
-- ---------------------------------------------------------------------
--
-- Measured on this database immediately before this migration:
--
--   source              rows  fold says OPEN, not reversed   in the view?
--   posting_path          56                             0   YES
--   expiry_sweep          70                             0   YES
--   repair                52            52  ($2,551.00)   no
--   test_harness          15             4    ($132.00)   no
--   dispute               23                             - (no card auth)
--   wire_availability     12                             - (no card auth)
--   availability_sweep     0                             - (no card auth)
--   operator               0                             -
--
-- The `repair` line is the one that has to be argued rather than asserted.
-- All 52 of those closures stand over authorisations the fold still calls
-- OPEN, and they are RIGHT to: 0026 and 0032 closed holds whose network
-- verdict was DECLINED and whose verdict never reached `card_auth_event`,
-- so the fold's input is the thing that is wrong, not the closure.  Had
-- `repair` been admitted to this view it would report 52 rows on the day
-- it shipped, all of them correct.  The guard that owns that population is
-- `v_refused_auth_hold`, which reads the provider's verdict rather than
-- the fold, and it is currently red on exactly that evidence.
--
-- `test_harness` is the finding.  Four closures written by an early
-- version of `holds.integration.test.ts` case 7b - before that test grew
-- the `expiry.expireOne()` tidy-up it now ends with - stand over $33.00
-- authorisations the fold still calls open, with the memo book already at
-- zero.  They are outside this invariant because the model's terminal
-- predicate never licensed them: a test fabricated them to simulate a
-- crash.  They are NOT outside the system's attention: `dbcheck` prints,
-- per source, how many excluded rows carry the shape this guard looks
-- for, so "outside the guard" can never again mean "invisible".  See
-- docs/HOLDS.md.
--
-- `posting_path` reads 0 rather than 3 in that column because 0011's three
-- spurious closures are already compensated by `hold_closure_reversal`,
-- and the view excludes a reversed closure exactly as it did before.

-- ---------------------------------------------------------------------
-- 1.  THE COLUMN
-- ---------------------------------------------------------------------

ALTER TABLE hold_closure ADD COLUMN source text;

-- ---------------------------------------------------------------------
-- 2.  THE BACKFILL, AS DDL - NOT ONE UPDATE, NOT ONE DISABLED TRIGGER
-- ---------------------------------------------------------------------
--
-- Every arm is an EXACT literal or an anchored prefix that exactly one
-- writer can emit, quoted from that writer.  The arms are the last time
-- this system reads a closure's prose, and they are here rather than in a
-- view because a backfill is a one-off statement about rows that already
-- exist, where a view is a standing claim about rows that do not yet.
--
-- Anything an arm cannot attribute lands NULL - explicitly, so that
-- "we do not know who wrote this" is a value rather than a guess.  On
-- this database that arm matches zero rows, and SS3 asserts it.

ALTER TABLE hold_closure
  ALTER COLUMN source TYPE text
  USING (CASE
    -- closureReason(), src/lib/holds/apply.ts - the model's four
    -- terminal branches, verbatim.
    WHEN reason = 'authorisation closed or expired by the network' THEN 'posting_path'
    WHEN reason = 'final capture received'                         THEN 'posting_path'
    WHEN reason = 'authorisation expiry reached'                   THEN 'posting_path'
    WHEN reason = 'authorisation fully reversed'                   THEN 'posting_path'
    -- expireOne(), src/lib/holds/expiry.ts
    WHEN reason = 'authorisation expired unused'                   THEN 'expiry_sweep'
    -- src/lib/rails/wire/ledger.ts.  Checked BEFORE the ACH sweep's
    -- prefix, which is a prefix of this one.
    WHEN reason LIKE 'wire funds availability reached at %'         THEN 'wire_availability'
    -- src/lib/rails/plaid/adapter.ts
    WHEN reason LIKE 'funds availability reached at %'              THEN 'availability_sweep'
    -- src/lib/disputes/operations.ts, through closeDisputeHold()
    WHEN reason = 'dispute won; provisional credit is final'        THEN 'dispute'
    WHEN reason = 'dispute lost; provisional credit recovered'      THEN 'dispute'
    WHEN reason = 'dispute lost; provisional credit written off'    THEN 'dispute'
    -- 0026 SS5 and 0032 SS4.  Both sentences end with the migration that
    -- wrote them, which is why they can be attributed at all.
    WHEN reason LIKE '%Closed and reversed by migration 0026.'      THEN 'repair'
    WHEN reason LIKE '%Closed and reversed by migration 0032,%'     THEN 'repair'
    -- src/lib/holds/holds.integration.test.ts case 7b
    WHEN reason = 'simulated crash before release'                  THEN 'test_harness'
    ELSE NULL
  END);

-- ---------------------------------------------------------------------
-- 3.  THE CHECK, AND THE ASSERTION THE BACKFILL HAS TO PASS
-- ---------------------------------------------------------------------

ALTER TABLE hold_closure
  ADD CONSTRAINT hold_closure_source_known CHECK (
    source IS NULL OR source IN (
      'posting_path',        -- src/lib/holds/apply.ts     - closed(E) said so
      'expiry_sweep',        -- src/lib/holds/expiry.ts    - the clock said so
      'availability_sweep',  -- src/lib/rails/plaid/adapter.ts - ACH maturity
      'wire_availability',   -- src/lib/rails/wire/ledger.ts   - zero-day wire
      'dispute',             -- src/lib/disputes/store.ts  - a dispute resolved
      'repair',              -- a migration undoing a hold that was never owed
      'operator',            -- a human overriding the model (0011 SS3)
      'test_harness'         -- a test writing against this shared book
    ));

COMMENT ON COLUMN hold_closure.source IS
  'WHO decided to close this hold, as a CHECK-constrained value, so an '
  'invariant can select its population by construction instead of by '
  'matching English against hold_closure.reason. NULL means the writer did '
  'not declare one; for a card_auth hold that is refused at INSERT (see '
  'hold_closure_declares_source). Added by 0040 without a single UPDATE on '
  'this append-only table - see the header.';

DO $$
DECLARE undeclared int;
BEGIN
  SELECT count(*) INTO undeclared
    FROM hold_closure hc JOIN hold h ON h.id = hc.hold_id
   WHERE h.kind = 'card_auth' AND hc.source IS NULL;
  IF undeclared > 0 THEN
    -- The population of v_hold_closure_not_terminal is exactly the
    -- card_auth closures, so a card_auth closure nobody can attribute is
    -- a permanent hole in the guard. Better to refuse the migration than
    -- to ship a guard with a silent remainder, which is the defect this
    -- file exists to remove.
    RAISE EXCEPTION
      '0040: % card_auth closure(s) could not be attributed to a writer; '
      'add the arm to SS2 rather than shipping a guard with a hole', undeclared;
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 4.  A CARD-AUTH CLOSURE MUST DECLARE ITS WRITER - AND WHY THAT IS
--     ENFORCED IN THE GATE RATHER THAN IN A TRIGGER
-- ---------------------------------------------------------------------
--
-- Without enforcement the fix is only as good as the next person's memory:
-- a new closure path added to apply.ts and not to this column would write
-- NULL, fall outside the view, and reproduce 0028's defect in a new
-- field.  So the rule is real:
--
--     every hold_closure row on a card_auth hold declares its source
--
-- The obvious implementation is a BEFORE INSERT trigger that refuses the
-- row.  It was written, and it worked - verified in a rolled-back
-- transaction: an undeclared card_auth closure was refused with 23514, an
-- undeclared uncleared-credit closure was allowed, and `source =
-- 'nonsense'` was refused by the CHECK.  It is NOT in this file, and the
-- reason is the same trade this migration makes two paragraphs down about
-- the rails.
--
-- A migration lands on the database the moment it runs.  The deployed
-- build is whatever was last pushed, and 0056 is this log's entry about
-- exactly that gap: the repository had the fix and the box did not, for
-- eight hours.  A trigger refusing an undeclared closure would, in that
-- window, refuse a CORRECT closure - written by the deployed apply.ts,
-- which cannot know about a column that did not exist when it was built -
-- and the ingest transaction would roll back with it.  The delivery parks
-- and retries, so nothing is corrupted, but a customer's card hold stays
-- on their money until the deploy catches up.
--
-- Refusing a correct write to enforce a LABEL on it is the wrong trade.
-- 0026's trigger refuses a refusal filed as an authorisation - a wrong
-- row, refused for being wrong - and that is a different thing.
--
-- So the rule is enforced where it costs nobody's money: `dbcheck`
-- carries "every card-auth closure declares its writer" as a pass/fail
-- check of its own, alongside "no stored balance column". It reads
-- `v_hold_closure_census` below, it is red the first time an undeclared
-- card_auth closure appears, and `scripts/compliance.mjs` spawns
-- `dbcheck` as part of AF3. A rule that turns CI red on the first
-- offending row is not a weaker rule than one that raises 23514; it is
-- the same rule, collected a few minutes later, without a window in
-- which correct work is refused.

-- ---------------------------------------------------------------------
-- 5.  THE VIEW, FILTERED ON THE COLUMN INSTEAD OF ON THE PROSE
-- ---------------------------------------------------------------------
--
-- DROP rather than CREATE OR REPLACE because the column list changes:
-- `source` is now on the face of the view, so anyone reading a row can
-- see which writer is being held to the claim.  Nothing else in the
-- schema depends on this view; `scripts/repair-0028-premature-closures.mjs`
-- reads it and gains a column.

DROP VIEW IF EXISTS v_hold_closure_not_terminal;

CREATE VIEW v_hold_closure_not_terminal AS
SELECT hc.hold_id,
       hc.source               AS closure_source,
       hc.reason               AS closure_reason,
       hc.closed_at,
       ca.provider_auth_id,
       ca.origin,
       s.auth_net_cents,
       s.captured_cents,
       s.event_count,
       ch.target_hold_cents,
       hs.memo_balance_cents,
       hs.is_released
  FROM hold_closure       hc
  JOIN card_authorization ca ON ca.hold_id = hc.hold_id
  JOIN v_card_auth_state  s  ON s.hold_id  = hc.hold_id
  JOIN v_card_auth_hold   ch ON ch.hold_id = hc.hold_id
  JOIN v_hold_state       hs ON hs.hold_id = hc.hold_id
   -- THE WHOLE POINT OF THIS MIGRATION IS THIS LINE.
   --
   -- The two writers that claim the MODEL's terminal predicate licensed a
   -- permanent row: `closed(E)` in apply.ts, and the clock in expiry.ts.
   -- Those are the only closures about which "the fold now says the
   -- authorisation is open" is a contradiction. A repair, an operator
   -- override and a test fixture all close a hold the fold may well call
   -- open, on purpose, and each has its own guard or its own argument.
 WHERE hc.source IN ('posting_path', 'expiry_sweep')
   -- A closure that has already been compensated is not an open defect.
   -- Same shape as v_hold_state's own predicate (0011).
   AND NOT EXISTS (
         SELECT 1 FROM hold_closure_reversal hr WHERE hr.hold_id = hc.hold_id)
   -- ...and the fold, over the full set as it stands NOW, disagrees.
   AND NOT ch.is_closed;

COMMENT ON VIEW v_hold_closure_not_terminal IS
  'INVARIANT. Must return zero rows. A hold_closure whose SOURCE says the '
  'hold model licensed it - posting_path or expiry_sweep - not since '
  'reversed, whose fold over the event set now says the authorisation is '
  'open. Migration 0011 produced these rows by closing on a clearing-first '
  'identity; 0028 stopped them being produced by closing on A <= 0; 0040 '
  'stopped the population being chosen by matching English against '
  'hold_closure.reason, which left 102 of 228 rows outside the guard by '
  'wording rather than by intent.';

GRANT SELECT ON v_hold_closure_not_terminal TO corgi_app;

-- ---------------------------------------------------------------------
-- 6.  THE CENSUS, AS A VIEW, SO THE REACH FIGURE IS DERIVED NOT TYPED
-- ---------------------------------------------------------------------
--
-- `dbcheck`'s GUARD REACH section printed 228 for this guard while the
-- guard could see 126, because the reach query and the view's predicate
-- were written separately and drifted - the exact failure the section
-- exists to catch, reproduced inside the mechanism built to catch it.
--
-- So the reach is no longer a query in a script. It is this view, which
-- derives `in_guard` from the same column the guard filters on, and adds
-- the column that stops "outside the guard" meaning "unexamined":
-- `defect_shape` counts rows that are NOT in the guard's population and
-- nonetheless look like what it hunts for - a standing, unreversed
-- closure over an authorisation the fold calls open.

CREATE VIEW v_hold_closure_census AS
SELECT COALESCE(hc.source, '(undeclared)')                        AS source,
       h.kind::text                                               AS hold_kind,
       (hc.source IN ('posting_path', 'expiry_sweep')
         AND ca.id IS NOT NULL)                                   AS in_guard,
       count(*)::int                                              AS closures,
       count(*) FILTER (
         WHERE ca.id IS NOT NULL
           AND NOT ch.is_closed
           AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal hr
                            WHERE hr.hold_id = hc.hold_id))::int   AS defect_shape,
       COALESCE(SUM(ch.target_hold_cents) FILTER (
         WHERE ca.id IS NOT NULL
           AND NOT ch.is_closed
           AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal hr
                            WHERE hr.hold_id = hc.hold_id)), 0)::bigint
                                                                  AS defect_shape_cents
  FROM hold_closure hc
  JOIN hold h ON h.id = hc.hold_id
  LEFT JOIN card_authorization ca ON ca.hold_id = hc.hold_id
  LEFT JOIN v_card_auth_hold  ch ON ch.hold_id = hc.hold_id
 GROUP BY 1, 2, 3;

COMMENT ON VIEW v_hold_closure_census IS
  'NOT an invariant - a population report. Every hold_closure row by '
  'declared writer, which of them v_hold_closure_not_terminal ranges over, '
  'and how many of the ones it does NOT range over carry its defect shape '
  'anyway. dbcheck prints it under GUARD REACH so a guard states its own '
  'domain out loud on every run.';

GRANT SELECT ON v_hold_closure_census TO corgi_app;

-- ---------------------------------------------------------------------
-- 7.  v_hold_expiry_drift  -  TWO VIEWS DISAGREE ABOUT ONE CLOCK
-- ---------------------------------------------------------------------
--
-- Not the same defect as the rest of this file, but the same CLASS, which
-- is why it lands here rather than waiting for a migration of its own.
--
-- A card hold's expiry is stored TWICE: `hold.expires_at`, which
-- `ledger_availability()` reads, and `card_authorization.expires_at`,
-- which `v_card_auth_hold` reads.  `ensureAuthorization()` takes one
-- `expiresAt` argument and writes it into both rows, so they are MEANT to
-- be the same instant - but that is a convention inside one function.
-- There is no foreign key, no CHECK, and until now no view that would say
-- anything if they diverged.  Two bodies deriving "has this hold expired?"
-- from two different columns is the stored-balance defect (0022) wearing a
-- timestamp instead of a number.
--
-- MEASURED, NOT HYPOTHETICAL.  Nine holds on this database already
-- disagree, by 135-158 MILLISECONDS:
--
--   hold 36a36a47-f8b5-43b5-a508-e19bfd7b7ecd / auth 4a972301-...  +135.502 ms
--   ...nine in total, all with external_ref 'lithic:team-test-%' or
--   'lithic:completion-%-bypass'
--
-- Every one is a fixture that bypassed `ensureAuthorization()` and ran two
-- separate `now() + interval '7 days'` statements, so the two rows were
-- written a few milliseconds apart and each kept its own `now()`.
--
-- EXPOSURE TODAY IS ZERO CENTS.  All nine are closed, released and
-- withholding nothing; the gap is 150 ms seven days out.  The defect is
-- not the money, it is that for the width of that gap the two bodies would
-- answer "is this hold expired?" differently and NOTHING WOULD SAY SO.
-- That is the whole reason this view exists, and it is why it is NOT
-- narrowed to exclude the fixtures that expose it:
--
--   THIS VIEW IS NON-EMPTY ON ARRIVAL, WITH NINE ROWS, AND THAT IS CORRECT.
--
-- `v_refused_auth_hold` is already a deliberate standing failure on this
-- book for the same reason - 0032's note that "the exclusion would be safe,
-- and would still be an exclusion shaped like the failure".  A second
-- honest red is worth more than a quiet `WHERE external_ref NOT LIKE
-- 'lithic:team-test-%'`.
--
-- The nine are NOT repaired here.  Repairing them means rewriting
-- `expires_at` on rows in two append-only tables, which is the one thing
-- this system does not do; the honest repairs available are a fixture
-- cleanup (another agent owns the fixture rows on this book) or nothing at
-- all, since the exposure is zero and every one of them is already
-- released.  Recording the reasoning is the repair.

CREATE VIEW v_hold_expiry_drift AS
SELECT h.id                            AS hold_id,
       ca.id                           AS auth_id,
       ca.provider_auth_id,
       h.external_ref,
       h.expires_at                    AS hold_expires_at,
       ca.expires_at                   AS auth_expires_at,
       ca.expires_at - h.expires_at    AS gap,
       hs.is_released,
       hs.active_hold_cents
  FROM hold h
  JOIN card_authorization ca ON ca.hold_id = h.id
  JOIN v_hold_state       hs ON hs.hold_id = h.id
 WHERE h.expires_at IS DISTINCT FROM ca.expires_at;

COMMENT ON VIEW v_hold_expiry_drift IS
  'INVARIANT. Must return zero rows. One card hold, one expiry instant - '
  'hold.expires_at is what ledger_availability() reads and '
  'card_authorization.expires_at is what v_card_auth_hold reads, and '
  'ensureAuthorization() writes one value into both. Non-empty on arrival '
  'with nine fixture rows that bypassed it and took two separate now() '
  'readings 135-158 ms apart; exposure zero cents, all nine released.';

GRANT SELECT ON v_hold_expiry_drift TO corgi_app;
