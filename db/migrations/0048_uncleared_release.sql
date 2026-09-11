-- =====================================================================
-- 0048  The uncleared credit that a clock released and nobody booked
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- WHAT HAPPENED, MEASURED
-- ---------------------------------------------------------------------
--
-- `v_hold_release_drift` was empty at 12:24Z and at 12:47Z on
-- 2026-09-11.  At 13:17Z it held THIRTEEN rows.  Nothing wrote them.
--
-- Every one is an `uncleared_credit` hold opened by the Plaid funding
-- path between 2026-09-10T22:36Z and 2026-09-11T03:39Z, every one
-- carries `available_at = 2026-09-11T13:00:00Z` -- 09:00 America/New_York,
-- the instant `funds_availability_policy` (ach/self, 1 banking day,
-- 09:00 ET) names -- and every one has EXACTLY ONE journal entry against
-- it: the opening withholding, booked the day it was funded.  There is no
-- `hold_closure` row on any of the thirteen.  Verified on this database:
--
--   13 rows, 13 holds, 13 entries, 0 closures, all is_released = true.
--
-- So the trigger was the clock.  `v_hold_state.is_released` has three
-- arms and only one of them can have fired here:
--
--     a standing hold_closure row            -- there is none
--     the card fold (kind = 'card_auth')     -- wrong kind
--     kind = 'uncleared_credit' AND now() >= h.available_at    <-- this
--
-- `ledger_availability()` re-derives the same arm at a parameterised
-- instant, which is what makes the money genuinely spendable rather than
-- merely reported so.  Measured on Ridgeline's 2100 leaf, same value date
-- and same booking watermark, across the boundary:
--
--     as_of 2026-09-11T12:59:59Z   uncleared 3,345,518   available 1,984,953
--     as_of 2026-09-11T13:00:01Z   uncleared 1,720,118   available 3,610,353
--
-- $16,254.00 became spendable, correctly, on the instant the policy names,
-- with no posting and nothing running.  That is the design working -- 0022
-- §2 and docs/FUNDING.md §4.3 both say the customer's available balance is
-- right whether or not any sweep executes.  What is left behind is the
-- MEMO BOOK, still carrying the withholding, which is exactly the state
-- 0011 created `v_hold_release_drift` to report.
--
-- It grows by itself.  45 more uncleared credits carry a finite future
-- `available_at` -- 28 at 2026-09-14T13:00Z and 17 at 2026-09-15T13:00Z,
-- three of the latter already closed -- so 42 more rows will arrive on
-- those two instants with nobody writing them either.  (A further 24
-- uncleared holds carry `available_at = infinity`: dispute provisional
-- credits, released by a person and never by a clock.  All 24 are already
-- closed and flat, and no clock can ever reach them.)
--
-- ---------------------------------------------------------------------
-- THE SWEEP THAT ALREADY EXISTED, AND WHY IT DID NOT COVER THIS
-- ---------------------------------------------------------------------
--
-- `releaseAvailableCredits()` in `src/lib/rails/plaid/adapter.ts` is the
-- uncleared-credit sibling of `sweepExpiredHolds()`, it is called by
-- `drainOnce()`, and `/api/drain` is on cron.  It is not missing.  It has
-- simply never had a due hold at a moment it ran, and the reason is
-- structural rather than accidental:
--
--     every uncleared credit on the ACH rail matures at 09:00 ET
--     /api/drain runs at 04:17Z  = 00:17 ET
--     /api/cron/holds runs at 08:11Z = 04:11 ET
--
-- Both scheduled triggers fire BEFORE 09:00 ET every day, so a maturity is
-- guaranteed to be swept on the FOLLOWING calendar day at the earliest.
-- Measured: `hold_closure.source = 'availability_sweep'` has ZERO rows on
-- this database, and all 13 entries keyed `hold:%:after:availability:%`
-- were written by the zero-day WIRE path, inline with the credit.
--
-- That guaranteed lateness is the second defect, and it is the one that
-- reaches the statement.  `releaseAvailableCredits()` books the release at
-- `bookDateOf(now)` -- the day the sweeper happened to run.  Swept on
-- 2026-09-12 at 04:17Z, thirteen releases whose policy instant was
-- 2026-09-11T09:00 ET would be value-dated 2026-09-12, and the statement
-- for the 11th would show money withheld that the policy had released.  On
-- a build whose differentiator is bitemporality, a value date that depends
-- on cron timing is not a rounding error.
--
-- So the release's VALUE DATE is `book_date(hold.available_at)`: derived
-- from immutable data, identical on every run for ever, and independent of
-- when anybody notices.  The BOOKING time is still now(), which is the
-- honest bitemporal split -- it happened at the policy instant, we recorded
-- it when the sweep ran.
--
-- ---------------------------------------------------------------------
-- WHY THIS REPAIR IS MECHANICAL WHERE 0036 §3 SAID IT WAS NOT
-- ---------------------------------------------------------------------
--
-- Migration 0036 §3 excluded `v_hold_release_drift` from its sweeper, and
-- that reasoning is correct and is NOT overturned here:
--
--   "a row here means EITHER the memo posting never landed OR the closure
--    should never have been written, and posting the release would silence
--    the alarm without answering the question."
--
-- The question exists because a closure exists.  These thirteen have NO
-- CLOSURE ROW AT ALL.  `is_released` came from `now() >= h.available_at`,
-- a predicate over `hold.available_at`, which is written once when the
-- credit is booked and is on an append-only table nothing may UPDATE.
-- There is no act of judgement standing behind the release that could be
-- the thing that is wrong, and therefore no question for a human to
-- answer: the only available reading is that the posting has not landed
-- yet.  That is the OPENING direction's situation, one hold kind over.
--
-- The carve-out is drawn exactly there and nowhere wider:
--
--   * `kind = 'uncleared_credit'` -- a card hold's release folds over
--     `card_auth_event`, whose INPUT can be wrong (0026, 0032: the lost
--     DECLINE).  A fold over an impoverished input agrees with the memo
--     book perfectly and both are wrong together.  Not in scope.
--   * NO `hold_closure` row for the hold, at all, reversed or not.  The
--     moment somebody has written a closure, 0036 §3's question is live
--     again and `scripts/repair-0011-spurious-closures.mjs` is where it
--     gets answered, one hold at a time, by a human.
--
-- NOTHING IS NARROWED.  `v_hold_release_drift` keeps its predicate, its
-- population and its place in `scripts/dbcheck.mjs`.  This file adds a
-- WORK QUEUE defined FROM it -- 0036 §1's load-bearing line -- so the
-- repair cannot range over rows the alarm cannot see, and asserts the
-- equality in both directions over the sub-population it claims.
--
-- ---------------------------------------------------------------------
-- THE TWO ALTERNATIVES, AND WHY THEY LOSE
-- ---------------------------------------------------------------------
--
-- (1) POST THE RELEASE AT FUNDING TIME, value-dated to `available_at`, so
--     no clock is involved.  This is the tempting one and it is wrong on
--     the domain.  A value date is a DAY; `available_at` is an INSTANT --
--     09:00 America/New_York.  Neither `v_hold_state`'s memo lateral nor
--     `ledger_availability()`'s memo CTE has a value-date predicate today,
--     so a pre-posted release would flatten the hold IMMEDIATELY and the
--     money would be spendable at funding time: core-loop leg 2 ("ledger
--     rises, available does not") would fail on the spot.  Adding the
--     predicate does not save it either -- it would make the release land
--     at 00:00 ET on the release day, NINE HOURS before 09:00 ET.
--     docs/FUNDING.md §4.2 already prices a ONE-hour version of that
--     mistake as unacceptable ("the money is spendable an hour before the
--     policy says it is").  Releasing funds early to keep a bookkeeping
--     view green is narrowing the guard by other means.
--
-- (2) NEVER WRITE THE MEMO ENTRY; derive the withholding from the hold row
--     the way `ledger_availability()` derives the future-dated-debit term.
--     `hold` carries no amount column, so this needs one -- a second
--     stored number for money that is currently derived, which is the one
--     thing the track's own gauntlet forbids ("never a second stored number
--     that drifts and gets fixed by a cron job").  It would also delete the
--     9200 evidence trail docs/FUNDING.md §3 prints, and it cannot be
--     applied to the 95 uncleared holds already on this book.
--
-- So: a sweep, symmetrical with `sweepExpiredHolds()`, with the value date
-- taken from the policy instant instead of from the clock that triggers it.
-- `src/lib/holds/availability.ts` is the body, `/api/cron/holds` is the
-- schedule, `scripts/repair-0048-uncleared-release.mjs` is the one-off.
--
-- NOTHING HERE WRITES.  Every object in this file is a STABLE read.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The work queue
-- ---------------------------------------------------------------------
--
-- `FROM v_hold_release_drift d` is the load-bearing line, for 0036 §1's
-- reason: the sweeper's domain is a SUBSET OF THE GUARD'S BY
-- CONSTRUCTION, chosen by two facts about which ARM of `is_released`
-- fired rather than by a re-derivation of the arm itself.  There is no
-- second copy of the release predicate in this file, so there is nothing
-- to keep in step with `v_hold_state`.
--
-- The columns beyond the guard's are the ones the sweeper and a human
-- need and the guard has no business carrying:
--
--   release_value_date  book_date(available_at).  THE DAY THE RELEASE
--                       HAPPENED, derived from the policy instant, not
--                       from the clock that triggers the sweep.  Stable
--                       for ever; a run next week books the same date.
--   rail                the rail of the hold's own OPENING memo entry, so
--                       the release carries the same rail as the credit
--                       it releases rather than a guess.
--   age                 how long the memo book has been behind the clock.
--                       Unlike 0036's queue this has no in-flight
--                       transient to tolerate: the clock strikes at an
--                       instant nothing is racing, so any age at all is
--                       the sweep not having run yet.
--   entity_id           the book the 9900 contra leg belongs to.

CREATE VIEW v_uncleared_release_due AS
SELECT d.hold_id,
       d.account_id,
       acct.entity_id,
       h.memo_account_id,
       d.memo_balance_cents,
       h.available_at,
       book_date(h.available_at)          AS release_value_date,
       h.value_date                       AS credit_value_date,
       h.external_ref,
       h.policy_id,
       open_ev.rail,
       now() - h.available_at             AS age
  FROM v_hold_release_drift d
  JOIN hold    h    ON h.id      = d.hold_id
  JOIN account acct ON acct.id   = h.account_id
  -- The rail of the entry that OPENED the withholding. LEFT, because a
  -- hold with no opening entry cannot be in this view anyway (the guard
  -- needs a non-zero memo balance), and a NULL rail is a value postEntry
  -- accepts rather than a row this queue silently drops.
  LEFT JOIN LATERAL (
    SELECT e.rail
      FROM journal_entry e
     WHERE e.hold_id = h.id
     ORDER BY e.booking_seq
     LIMIT 1
  ) open_ev ON true
 WHERE d.kind = 'uncleared_credit'
   -- No closure, reversed or standing. With no closure row in existence
   -- there is no act of judgement behind the release for 0036 §3's
   -- question to be about, so the repair is mechanical. The moment one
   -- exists this row leaves the queue and stays in the guard.
   AND NOT EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = h.id);

COMMENT ON VIEW v_uncleared_release_due IS
  'NOT an invariant -- a WORK QUEUE. One row per uncleared-credit hold that '
  'the CLOCK released (now() >= hold.available_at) while the memo book is '
  'still carrying the withholding, restricted to holds with no hold_closure '
  'row of any kind, so the only possible reading is that the release posting '
  'has not landed. Defined FROM v_hold_release_drift so the repair cannot '
  'range over rows the guard cannot see; 0048 SS2 asserts the equality over '
  'that sub-population in both directions. release_value_date is '
  'book_date(available_at) -- the day the POLICY released the money, not the '
  'day a sweep happened to run. Read by src/lib/holds/availability.ts and '
  'scripts/repair-0048-uncleared-release.mjs. Deliberately NOT in '
  'scripts/dbcheck.mjs: v_hold_release_drift is the invariant and it stays '
  'absolute.';

GRANT SELECT ON v_uncleared_release_due TO corgi_app;


-- ---------------------------------------------------------------------
-- 2.  The domain assertion, and the residue said out loud
-- ---------------------------------------------------------------------
--
-- Three claims, all of which can fail, and the day someone edits either
-- view without the other is the day they do.
--
--   (a) Every row in the queue really was released BY THE CLOCK:
--       now() >= available_at on every one of them. If this is ever
--       non-zero then `is_released` acquired a fourth arm and this
--       sweeper is moving the memo book on a hold for a reason it does
--       not understand -- an unobserved write to the book, which 0036 §2
--       calls the worse of the two failure directions.
--
--   (b) No row of `v_hold_release_drift` that carries the queue's two
--       defining facts -- uncleared_credit, no closure -- is missing from
--       the queue. A repair that reaches fewer rows than the guard leaves
--       money withheld behind an alarm nobody can clear.
--
--   (c) The RESIDUE is counted and printed rather than left implicit.
--       "Outside the repair" must never mean "invisible", which is 0040's
--       whole lesson and 0047's. These rows are the guard's and stay the
--       guard's; they are not this sweeper's to touch.

DO $$
DECLARE
  v_not_by_clock int;
  v_only_guard   int;
  v_queue        int;
  v_residue_card int;
  v_residue_clos int;
BEGIN
  SELECT count(*) INTO v_not_by_clock
    FROM v_uncleared_release_due q
   WHERE NOT (now() >= q.available_at);

  SELECT count(*) INTO v_only_guard
    FROM v_hold_release_drift d
    JOIN hold h ON h.id = d.hold_id
   WHERE d.kind = 'uncleared_credit'
     AND NOT EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = h.id)
     AND NOT EXISTS (SELECT 1 FROM v_uncleared_release_due q WHERE q.hold_id = d.hold_id);

  IF v_not_by_clock <> 0 OR v_only_guard <> 0 THEN
    RAISE EXCEPTION
      '0048 refuses to commit: % queued row(s) were not released by the clock, '
      '% guard row(s) with the queue''s own shape are missing from it; both must be 0',
      v_not_by_clock, v_only_guard;
  END IF;

  SELECT count(*) INTO v_queue FROM v_uncleared_release_due;

  SELECT count(*) INTO v_residue_card
    FROM v_hold_release_drift d WHERE d.kind <> 'uncleared_credit';

  SELECT count(*) INTO v_residue_clos
    FROM v_hold_release_drift d
   WHERE d.kind = 'uncleared_credit'
     AND EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = d.hold_id);

  RAISE NOTICE
    '0048: v_uncleared_release_due holds % row(s); v_hold_release_drift holds %, '
    'of which % are not uncleared credits and % carry a closure somebody wrote. '
    'The residue stays with the guard and with repair-0011.',
    v_queue,
    (SELECT count(*) FROM v_hold_release_drift),
    v_residue_card, v_residue_clos;
END $$;


-- ---------------------------------------------------------------------
-- 3.  The guard's comment records the carve-out. The guard does not move.
-- ---------------------------------------------------------------------
--
-- A COMMENT, not a predicate. `v_hold_release_drift` is byte-identical to
-- what migration 0011 created; this only writes down which of its rows
-- now have a mechanical repair and which still need a human, so the next
-- reader does not have to reconstruct 0036 §3 from scratch.

COMMENT ON VIEW v_hold_release_drift IS
  'MUST BE EMPTY. A released hold that still withholds money. Added by '
  'migration 0011 as the complement to v_hold_drift, because a spurious '
  'closure sets is_released and therefore hides itself from that view. '
  'Its rows split in two. (1) An uncleared credit whose CLOCK released it '
  'with no hold_closure row anywhere: nobody decided anything, so there is '
  'nothing to adjudicate and the repair is mechanical -- 0048''s '
  'v_uncleared_release_due and src/lib/holds/availability.ts, on '
  '/api/cron/holds. (2) Everything else -- a card hold, or any hold '
  'carrying a closure somebody wrote: a row means EITHER the memo posting '
  'never landed OR the closure should never have been written, posting the '
  'release would silence the alarm without answering the question, and '
  'scripts/repair-0011-spurious-closures.mjs is where a human answers it. '
  'The 0036 sweeper touches neither.';
