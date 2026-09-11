-- ---------------------------------------------------------------------
-- 0028.  The permanent row, written on a condition that was not permanent.
-- ---------------------------------------------------------------------
--
-- WHAT THIS FIXES.  `HoldState.terminallyClosed` is the predicate that
-- licenses a `hold_closure` row.  That table is APPEND-ONLY with
-- PRIMARY KEY (hold_id), so the predicate carries an obligation that
-- `closed(E)` does not: it must be MONOTONE.  True on a subset must mean
-- true on every superset, or the system permanently frees a hold that
-- the next delivery re-opens.
--
-- It was:
--
--     terminallyClosed = sawFinal v sawClose v expired
--                                v (sawAuthorisation ^ A <= 0)
--
-- The first three arms are monotone by construction -- two are EXISTS
-- over a growing set, and the third does not read the set at all.  The
-- fourth is a predicate on a RUNNING TOTAL THAT CAN GO BACK UP, and an
-- adversarial fuzzer (src/lib/holds/fuzz.test.ts, 6.25M orderings)
-- shrank it to two events, seed 5300024:
--
--     E1 = { authorization 0 }                    -> terminal, row written
--     E2 = E1 + { incremental_authorization 1 }   -> NOT terminal, H = 1
--
-- A $0 authorisation is card-on-file verification.  Lithic sends
-- AUTHORIZATION amount 0 and then an AUTHORIZATION_ADVICE carrying the
-- real figure.  In one payload it is harmless.  Split across two
-- deliveries -- the ordinary case, and precisely the case the brief
-- tells us to survive -- the FIRST delivery closed the hold for ever.
-- Second witness, same defect with more steps: {auth 100, reversal 100}
-- followed by a late incremental.
--
-- THE DAMAGE PATH, and it is 0011's own observation playing out again.
-- `v_hold_state.is_released` reads the closure row FIRST, so
-- `active_hold_cents` goes to 0 and availability stops withholding money
-- that H(E) says is held.  `settleHoldPosting()` then drives the memo
-- book back up to H(E), and the hold is simultaneously RELEASED and
-- CARRYING MONEY -- the exact row shape `v_hold_release_drift` was added
-- in 0011 to report, and the exact shape `v_hold_drift` cannot see,
-- because it is defined WHERE NOT is_released.  On the $0 path the row
-- is written with reason 'authorisation fully reversed', which is a
-- FALSE STATEMENT IN AN APPEND-ONLY AUDIT TABLE about an authorisation
-- nobody reversed.
--
-- THE PART WORTH READING TWICE.  This migration's argument has been made
-- in this repository twice already, both times about the NEIGHBOURING
-- disjunct.  Migration 0011 declined a `C >= A` arm because it would
-- "write a PERMANENT closure row on a condition a later incremental
-- authorisation can undo".  DECISIONS 049 declined the same arm again on
-- a fresh Lithic measurement.  `A <= 0` IS such a condition, it sat one
-- line away, and neither pass looked at it.  Being right about a line is
-- not the same as being right about the file.
--
-- ---------------------------------------------------------------------
-- 1.  The change, and why it costs nothing
-- ---------------------------------------------------------------------
--
-- `A <= 0` moves OUT of `terminallyClosed` and STAYS in `closed(E)`.
-- That is the distinction src/lib/holds/model.ts already drew and simply
-- mis-assigned:
--
--     closed(E)        "withhold nothing NOW"        -- keeps the arm
--     terminallyClosed "...and nothing can undo it"  -- loses the arm
--
-- NO CUSTOMER-VISIBLE NUMBER MOVES, and that is checkable rather than
-- asserted:
--
--   * H = max(A - C, 0) is ALREADY 0 when A <= 0, so the hold figure is
--     identical with the arm and without it.
--   * `v_card_auth_hold.is_closed` KEEPS the arm (it mirrors closed(E),
--     not terminallyClosed), so `v_hold_state.is_released` is still TRUE
--     on a fully reversed authorisation and availability still frees the
--     money on the customer's screen.  It now does so FROM THE FOLD,
--     where a later event can move it, instead of FROM A ROW, where
--     nothing can.
--   * `v_hold_drift` compares `memo_balance_cents` against
--     `target_hold_cents`.  Neither side of that comparison reads
--     `terminallyClosed`, so the invariant that holds the TypeScript and
--     the SQL equal does not move either.
--
-- Verified before the change was made, against the fuzzer's own
-- generators at deep scale: 320,000 sets, 5,118,851 orderings,
-- 16,199,101 prefixes.  Zero sets where H changed, zero where closed(E)
-- changed, zero where the new predicate failed to imply closed, zero
-- where it failed to imply H = 0, zero non-monotone prefixes (against
-- 141,209 for the predicate it replaces).  11,236 sets lose terminality;
-- EVERY ONE of them already had H = 0 and closed(E) TRUE.
--
-- ---------------------------------------------------------------------
-- 2.  WHAT THIS MIGRATION DELIBERATELY DOES NOT CHANGE
-- ---------------------------------------------------------------------
--
-- `v_card_auth_hold.is_closed` and `v_hold_state.is_released` are NOT
-- altered, and that needs saying out loud because the obvious reading of
-- "the model and the SQL are held equal by an invariant" is that both
-- must move together.  They must -- for `closed(E)`.  They do not here,
-- because `terminallyClosed` HAS NO SQL COUNTERPART AND NEVER DID:
--
--   * v_card_auth_hold.is_closed        (0001) mirrors closed(E)
--   * v_hold_state.is_released          (0001, 0011) = closure row
--                                        AND NOT its reversal, OR
--                                        closed(E), OR the uncleared clock
--   * ledger_availability()             (0022) re-derives the same
--                                        closed(E) fold at an instant
--   * holdItemisationAsOf()             scopes on the closure row and
--                                        then SIZES on the memo balance,
--                                        which is 0 on this arm anyway
--
-- All four express "withhold nothing now".  None of them expresses "and
-- nothing can undo that" -- that judgement existed only in the writer,
-- in apply.ts step 5, which is exactly why it was able to be wrong in
-- one place without anything disagreeing with it.  The SQL was already
-- right.  Changing a view to match a predicate that is not in it would
-- have moved `is_released` and therefore moved real money.
--
-- What was missing was not agreement.  It was a view.
--
-- ---------------------------------------------------------------------
-- 3.  The invariant that would have caught this, and 0011, on day one
-- ---------------------------------------------------------------------
--
-- The pair added in 0011 covers every hold row between them, but both
-- catch the DAMAGE rather than the CAUSE:
--
--     v_hold_drift          a LIVE hold's memo book equals the fold
--     v_hold_release_drift  a RELEASED hold withholds nothing
--
-- A spurious closure only reaches `v_hold_release_drift` once the memo
-- book has been driven back up by a later delivery -- money is already
-- misstated by the time anything reports.  The cause is one step
-- earlier and is stateable on its own:
--
--     A CLOSURE THE FOLD NO LONGER BELIEVES IS A BUG.
--
-- After this migration the posting path writes a closure only on
-- sawFinal, sawClose or expired.  Every one of those is monotone, so for
-- every row it writes, `v_card_auth_hold.is_closed` must be TRUE over
-- the FULL event set, now and for ever.  A row for which it is FALSE is
-- either a closure written on a reversible condition (this defect) or a
-- closure written before its authorisation arrived (0011's defect).
-- Both land here, before either drift view can see anything.
--
-- SCOPE, stated honestly.  This is restricted to closures the POSTING
-- PATH wrote, identified by the reason strings `closureReason()` and the
-- expiry sweep emit.  An operator's deliberate `closeHold()` is excluded
-- and must be: 0011 §3 records that an operator may close a hold the
-- fold still considers open -- that is what closeHold() is FOR, and
-- holds.integration.test.ts scenario 7 leaves four such rows behind on
-- purpose.  The operator overrides the model; the operator does not get
-- to leave money withheld, and THAT half is v_hold_release_drift's job.
--
-- The cost of keying on reason strings is that a new `closureReason()`
-- branch added to apply.ts without being added here is silently outside
-- the invariant.  That is a real gap and it is written down rather than
-- hidden: the strings below are the complete output of `closureReason()`
-- plus `sweepExpiredHolds()`'s one string, as of this migration.
--
-- Measured empty on the live database immediately before this migration
-- was written, and empty immediately after it was applied.

CREATE VIEW v_hold_closure_not_terminal AS
SELECT hc.hold_id,
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
 WHERE hc.reason IN (
         -- closureReason(), src/lib/holds/apply.ts
         'authorisation closed or expired by the network',   -- sawClose
         'final capture received',                           -- sawFinal
         'authorisation expiry reached',                     -- expired
         'authorisation fully reversed',                     -- the arm 0028 removed
         -- sweepExpiredHolds(), src/lib/holds/expiry.ts
         'authorisation expired unused'
       )
   -- A closure that has already been compensated is not an open defect.
   -- Same shape as v_hold_state's own predicate (0011).
   AND NOT EXISTS (
         SELECT 1 FROM hold_closure_reversal hr WHERE hr.hold_id = hc.hold_id)
   -- ...and the fold, over the full set as it stands NOW, disagrees.
   AND NOT ch.is_closed;

COMMENT ON VIEW v_hold_closure_not_terminal IS
  'INVARIANT. Must return zero rows. A hold_closure the posting path wrote, '
  'not since reversed, whose fold over the event set now says the '
  'authorisation is open. Migration 0011 produced these rows by closing on a '
  'clearing-first identity; migration 0028 stopped them being produced by '
  'closing on A <= 0. Both are permanent rows written on a reversible '
  'condition, and both are visible here one step before v_hold_release_drift '
  'can see the money.';

GRANT SELECT ON v_hold_closure_not_terminal TO corgi_app;

-- ---------------------------------------------------------------------
-- 4.  NOT ADDED HERE: the dbcheck entry
-- ---------------------------------------------------------------------
--
-- scripts/dbcheck.mjs carries a hardcoded INVARIANT_VIEWS list, and that
-- file is outside this change's mandate (nine agents are live in this
-- tree).  So this view is NOT yet asserted by `node scripts/dbcheck.mjs`
-- and must not be counted as if it were.  The one-line addition is:
--
--     ["v_hold_closure_not_terminal",
--      "a closure row the fold no longer believes"],
--
-- scripts/repair-0028-premature-closures.mjs reads the view on every
-- run, so it is exercised rather than merely declared -- but a repair
-- script nobody runs is not CI, and saying otherwise would be the same
-- shape of claim this migration exists to correct.  dbcheck's own
-- comment already records that it once read "14/14" while two drift
-- views went unchecked.  This is that note, kept honest.
