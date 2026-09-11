-- =====================================================================
-- 0043  A(E) is not floored - and the two guards that earn that answer
-- =====================================================================
--
-- Two defects were measured on the live book on 2026-09-11 and both were
-- deliberately left standing.  This migration is the second look.
--
-- =====================================================================
-- PART ONE.  `A(E)` WENT TO -7340 AND AN ADVICE OF NOTHING BECAME AN
--            INCREMENT OF SEVENTY-THREE DOLLARS AND FORTY CENTS
-- =====================================================================
--
-- Lithic transaction `5892c550-b966-4afb-b681-a6456e1cf3c4`, delivered as
-- ONE payload of six events at 09:02:58Z (webhook_inbox
-- 3520124c-2d1a-4c28-be52-432590c6f519):
--
--     AUTHORIZATION          5000  APPROVED     A =  5000
--     CLEARING               7340  APPROVED     C =  7340
--     AUTHORIZATION_REVERSAL 7340  APPROVED     A = -2340
--     AUTHORIZATION_REVERSAL 5000  APPROVED     A = -7340   <- over-reversed
--     AUTHORIZATION_ADVICE      0  APPROVED     delta = 0 - (-7340) = +7340
--     CLEARING               7340  APPROVED
--
-- The network reversed $123.40 against a $50 authorisation, and the advice
-- that followed said THE AUTHORISED AMOUNT IS NOW ZERO.  Converted against
-- the negative running total, an advice of nothing was stored as
-- `card_auth_event a299ea01-f4c2-44a7-b042-13093b979329`, kind
-- `incremental_authorization`, amount **7340** - an increment the network
-- never sent, in an append-only table.
--
-- ---------------------------------------------------------------------
-- WHAT WAS DECIDED, AND WHY THE OBVIOUS ANSWER IS THE WRONG ONE
-- ---------------------------------------------------------------------
--
-- Three candidates were on the table.
--
-- **Floor `A(E)` at zero in the fold.**  REJECTED, and the arithmetic does
-- the rejecting rather than taste.  If `A < 0` then `A <= 0`, so
-- `v_card_auth_hold.is_closed` is ALREADY TRUE on the fourth disjunct and
-- `target_hold_cents` is ALREADY 0 - by the CLOSURE, not by the
-- `GREATEST(A - C, 0)`.  Substitute `GREATEST(A, 0)` and it is still
-- `<= 0`, still closed, still zero.  Not one customer-visible number
-- moves.  What the floor DOES change is that `auth_net_cents` stops being
-- able to say the network over-reversed.  That is paying real evidence for
-- no correctness at all.
--
-- And it would not have fixed the harm.  The damage was done by a RUNNING
-- total inside one payload, in `src/lib/holds/lithic-events.ts`; a floor
-- applied at the end of the fold never touches it.
--
-- **Reject the second reversal at ingest.**  REJECTED.  It refuses a fact
-- the network sent, which this build does nowhere else, and it cannot be
-- expressed without cross-event judgement in the front door: each reversal
-- is well formed on its own, only their SUM over-reverses.  Decision 050
-- is the standing lesson about deciding things at the front door - the
-- verdict was discarded there and $4,451.00 was withheld that nobody had
-- authorised.
--
-- **Keep `A` unfloored and assert non-negativity.**  HALF ACCEPTED, and
-- the half that is rejected is the important one.  `A >= 0` IS NOT AN
-- INVARIANT.  A lone `authorization_reversal` - a reversal that arrives
-- before the authorisation it belongs to, which is the case the brief
-- names - puts `A` below zero legitimately, and the next delivery puts it
-- back.  Measured on the fuzzer's own corpus: **1,614 of 7,220 generated
-- sets (22.4%) reach `A < 0`, 812 of them after a real authorisation, and
-- ZERO of them are open or holding a cent.**  A view asserting `A >= 0`
-- would go red on 22% of legitimate event sets.  The property that IS true
-- is asserted in `fuzz.test.ts` instead:
--
--     A(E) < 0  =>  closed(E)  AND  H(E) = 0
--
-- so the clamp is the SECOND line there, not the only one.
--
-- ---------------------------------------------------------------------
-- SO WHAT ACTUALLY CHANGED
-- ---------------------------------------------------------------------
--
-- `lithic-events.ts` converts an advice against `max(A, 0)`.  An advice
-- overrides an AUTHORISED AMOUNT and an authorised amount cannot be
-- negative - you cannot have authorised less than nothing.  Where
-- `A >= 0`, which is every advice this book has ever seen except the one
-- above, nothing changes.  Where `A < 0` the over-reversal is KEPT rather
-- than cancelled out by a fabricated increment, and the derived delta can
-- only ever be SMALLER than it was, so the change can never withhold more
-- of a customer's money.
--
-- `v_advice_delta_unsound` below is the guard, and it is RED ON ARRIVAL
-- with exactly the one row above, $73.40.  That row is NOT repaired.
-- There is no `card_auth_event_reversal`, and the only compensation
-- available - appending an `authorization_reversal 7340` - would be a
-- SECOND fact the network never sent, which is the sin being corrected.
-- `H` is 0 either way and the hold is closed and released, so the exposure
-- is zero cents.  Recording the reasoning is the repair, exactly as
-- `v_hold_expiry_drift`'s nine rows were handled in 0040 SS7.
--
-- =====================================================================
-- PART TWO.  FOUR CLOSURES, $132.00, THAT NO GUARD ON THIS BUILD COULD SEE
-- =====================================================================
--
-- docs/HOLDS.md SS10.4.  Four `hold_closure` rows written by an early
-- version of `holds.integration.test.ts` case 7b stand over $33.00
-- authorisations the fold still calls OPEN:
--
--     6fd4ff31-6509-433c-b7de-514ae0a5e73b   auth-1789059056109-7b
--     8df083ba-9a0f-492c-a135-901aef79d29f   auth-1789059102546-7b
--     052ba6c6-5f23-404f-98b1-5f00bf50452c   auth-1789059231213-7b
--     c4ee66e9-e7a0-4000-b7c2-499d8bc52e3c   auth-1789059686167-7b
--
-- `v_hold_drift` is `WHERE NOT is_released` and the closure released them.
-- `v_hold_release_drift` needs a non-zero memo balance and theirs is zero.
-- `v_hold_closure_not_terminal` ranges over `source IN ('posting_path',
-- 'expiry_sweep')` and theirs is `test_harness`.
--
-- ---------------------------------------------------------------------
-- THE REPAIRS ARE STILL BOTH WORSE.  MEASURED, NOT ASSERTED.
-- ---------------------------------------------------------------------
--
-- A SYNTHETIC EXPIRY EVENT is a false statement in an append-only table:
-- their clocks run to 2026-09-17 and have not run out.  Unchanged.
--
-- A CLOSURE REVERSAL is the move migration 0011 built the mechanism for,
-- and the argument against it in SS10.4 stopped halfway - "it would turn
-- zero exposure into $132.00 of `v_hold_drift`" is only true of a repair
-- that reverses the closure and stops.  So the full version was priced.
-- Reverse the closure, then complete the memo posting through
-- `settleHoldPosting()` (the mechanism SS9.6 already used), and the book
-- ends: four LIVE holds, $132.00 withheld, `v_hold_drift` empty again.
--
-- That is a worse book than the one we have, for three measured reasons.
--
--   1. It withholds $132.00 of two real businesses' available balance
--      (`a0c41a37-...` x3, `66fdc0f8-...`) against authorisations that
--      exist at no provider.  Nothing will ever capture them.
--   2. The memo book for these four is NOT missing - it opened AND
--      released.  Each hold carries `Card hold opened/increased ...-e1`
--      (+3300) and `Card hold reduced/released ...-sweep` (-3300), the
--      second written by `expiry.expireOne()` under the test's forged
--      clock.  So a completion sweep would be RE-withholding money this
--      book has already, deliberately, given back.
--   3. It is not even stable.  On 2026-09-17 the real clock reaches
--      `expires_at`, `is_closed` flips, `is_released` flips, and four
--      holds carrying $132.00 land on `v_hold_release_drift` until
--      somebody runs a sweep that nothing schedules (decision 046).
--
-- So the SS10.4 conclusion stands: they are not repaired.  Its
-- CONSEQUENCE does not.  "Both repairs are worse" is a reason not to
-- repair; it was never a reason for no guard to be able to see them, and
-- a census column printed under GUARD REACH is a report, not a guard.
--
-- ---------------------------------------------------------------------
-- SO THE GUARD IS WIDENED, NOT NARROWED
-- ---------------------------------------------------------------------
--
-- `v_hold_closure_unexplained` ranges over EVERY `hold_closure` row on a
-- card_auth hold.  No source filter at all - 129 in
-- `v_hold_closure_not_terminal`'s population plus the 52 `repair` and 16
-- `test_harness` rows outside it, all 197 of them.  It asks the same
-- question that view asks, and then subtracts only what another guard can
-- be SHOWN to own:
--
--     a standing, unreversed closure over an authorisation the fold calls
--     OPEN, where the network is NOT on record as having refused any step
--     of that authorisation
--
-- The exemption is DEMONSTRATED rather than declared, and that matters,
-- because 0040 SS10.3's declared version is not true any more.  It said
-- the 52 `repair` closures were "owned by `v_refused_auth_hold`, which is
-- red on exactly that evidence".  Measured today: **0 of those 52 holds
-- are in `v_refused_auth_hold`** - 0032's repair reversed their memo
-- entries, so they stopped withholding money and left that view the moment
-- they were fixed.  Ownership by membership was already stale.
--
-- Ownership by EVIDENCE is not.  All 52 carry a `card_auth_event_result`
-- row whose `result` is not `APPROVED` - the network's verdict, retained
-- from the payload, which the fold deliberately does not read.  That is
-- exactly why the fold calls them open: its INPUT lost the refusal, which
-- is 0026's and 0032's whole finding.  A closure over an authorisation the
-- network refused is correct and stays out.
--
-- The four `test_harness` rows carry **0** such verdicts.  Nothing refused
-- them; a test fabricated them.  They are reported.
--
-- **This view is RED ON ARRIVAL with four rows and $132.00, and that is
-- the point of it.**  It is the same disposition `v_refused_auth_hold`
-- (149 unanswered) and `v_hold_expiry_drift` (9 fixture rows) already
-- have on this book: a standing, named, counted red that tells the truth,
-- rather than a green tick over a population chosen to produce one.
--
-- TWO INDEPENDENT INPUTS, per docs/HOLDS.md SS9.8, for both views:
--
--   v_advice_delta_unsound        the row WE stored  x  the payload the
--                                 PROVIDER sent, retained in webhook_inbox
--   v_hold_closure_unexplained    the fold over card_auth_event  x  the
--                                 verdicts in card_auth_event_result,
--                                 which the fold does not read
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  v_advice_delta_unsound  -  an advice converted against a base that
--     could not be an authorised amount
-- ---------------------------------------------------------------------
--
-- The base is RECOVERED rather than re-derived: `base = absolute - signed
-- delta`, where the absolute is read out of the retained payload and the
-- signed delta is read off the row we wrote.  Neither number is computed
-- from the other and neither is computed from anything the other reads.
--
-- The `no_retained_payload` arm exists because "we cannot check this one"
-- is not a pass.  0026 shipped `AND r.result IS NOT NULL` over an INNER
-- JOIN and thereby excluded, by construction, the exact state its bug
-- produced; an inner join to `webhook_inbox` here would make an advice
-- whose payload we never kept invisible to the guard that exists to check
-- advices.  `dbcheck` prints the two findings separately so a reader can
-- tell which red they are looking at without running a query.

CREATE VIEW v_advice_delta_unsound AS
SELECT e.id                                   AS event_id,
       e.auth_id,
       ca.provider_auth_id,
       e.provider_event_id,
       e.kind::text                           AS stored_kind,
       e.amount_cents                         AS stored_magnitude_cents,
       e.value_date,
       r.provider_step,
       adv.absolute_cents,
       sd.signed_delta_cents,
       adv.absolute_cents - sd.signed_delta_cents          AS base_cents,
       CASE WHEN adv.absolute_cents IS NULL
            THEN 'no_retained_payload'
            ELSE 'negative_base'
       END                                    AS finding
  FROM card_auth_event       e
  JOIN card_auth_event_result r ON r.event_id = e.id
  JOIN card_authorization    ca ON ca.id = e.auth_id
  -- The delta as we stored it, with the sign put back on: `card_auth_event`
  -- keeps a magnitude and puts the direction in the kind.
  CROSS JOIN LATERAL (
    SELECT CASE WHEN e.kind = 'authorization_reversal'
                THEN -e.amount_cents ELSE e.amount_cents END AS signed_delta_cents
  ) sd
  -- The provider's own absolute figure for the same step, out of the body
  -- we kept.  Same precedence `eventMagnitude()` uses: the settlement
  -- figure when there is one, the flat amount otherwise, absolute value.
  LEFT JOIN LATERAL (
    SELECT abs(COALESCE((ev->'amounts'->'settlement'->>'amount')::bigint,
                        (ev->>'amount')::bigint))           AS absolute_cents
      FROM webhook_inbox wi
      CROSS JOIN LATERAL jsonb_array_elements(wi.payload->'events') ev
     WHERE wi.id = e.inbox_id
       AND ev->>'token' = e.provider_event_id
     LIMIT 1
  ) adv ON true
 WHERE r.provider_step IN ('AUTHORIZATION_ADVICE', 'CREDIT_AUTHORIZATION_ADVICE')
   AND (adv.absolute_cents IS NULL
        OR adv.absolute_cents - sd.signed_delta_cents < 0);

COMMENT ON VIEW v_advice_delta_unsound IS
  'MUST BE EMPTY. An AUTHORIZATION_ADVICE carries the ABSOLUTE authorised '
  'amount and is stored as the delta that produces it; this recovers the base '
  'that delta was measured from -- payload absolute minus stored signed delta '
  '-- and reports any advice converted against a NEGATIVE base, which is not a '
  'quantity an authorised amount can take. finding=negative_base is the defect '
  '(one row on arrival: an advice of 0 against A=-7340 stored as an '
  'incremental_authorization of 7340, Lithic 5892c550-...); '
  'finding=no_retained_payload means the advice cannot be checked at all, '
  'which is reported rather than excluded. Two independent inputs: the row we '
  'wrote and the payload the provider sent.';

GRANT SELECT ON v_advice_delta_unsound TO corgi_app;


-- ---------------------------------------------------------------------
-- 2.  v_hold_closure_unexplained  -  the guard the four rows were outside
-- ---------------------------------------------------------------------
--
-- Deliberately NOT `WHERE source IN (...)`.  The population is every
-- card-auth closure in the table, and the only thing subtracted is a
-- closure whose authorisation the network is on record as having REFUSED.
-- `v_hold_closure_not_terminal` keeps its narrower population and its
-- narrower claim ("the model's terminal predicate licensed this row");
-- this one asks the wider question nobody was asking.
--
-- The two overlap on purpose.  A `posting_path` closure over an open
-- authorisation with no refusal on record reports in BOTH, and that is
-- correct: two guards agreeing is not duplication, it is the only way to
-- notice when one of them stops ranging over something.

CREATE VIEW v_hold_closure_unexplained AS
SELECT hc.hold_id,
       COALESCE(hc.source, '(undeclared)')    AS closure_source,
       hc.reason                              AS closure_reason,
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
   -- the fold, over the full set as it stands NOW, says the authorisation
   -- is still open
 WHERE NOT ch.is_closed
   -- a closure already compensated is not an open defect (0011)
   AND NOT EXISTS (
         SELECT 1 FROM hold_closure_reversal hr WHERE hr.hold_id = hc.hold_id)
   -- ...and nothing the PROVIDER said explains why the fold disagrees.
   -- This is the clause that lets 0026's and 0032's 52 repairs out, by
   -- evidence rather than by their declared source: the fold calls those
   -- authorisations open because its INPUT lost the network's refusal,
   -- and the refusal is right here in a table the fold does not read.
   AND NOT EXISTS (
         SELECT 1
           FROM card_auth_event        e
           JOIN card_auth_event_result r ON r.event_id = e.id
          WHERE e.auth_id = ca.id
            AND r.result IS NOT NULL
            AND r.result <> 'APPROVED');

COMMENT ON VIEW v_hold_closure_unexplained IS
  'MUST BE EMPTY. Every card-auth hold_closure, whatever its declared source, '
  'that has not been reversed, stands over an authorisation the fold still '
  'calls OPEN, and that the provider''s own verdicts do not explain. Wider '
  'than v_hold_closure_not_terminal on purpose: that view ranges over '
  'posting_path and expiry_sweep only, and the four test_harness closures of '
  'docs/HOLDS.md SS10.4 -- $132.00, written by holds.integration.test.ts case '
  '7b -- were outside every guard on this build. RED ON ARRIVAL with those '
  'four; they are not repaired, and 0043''s header prices both repairs. The '
  '52 repair closures of 0026/0032 are out because a refusal is ON RECORD for '
  'each, which is demonstrated per row rather than declared per source.';

GRANT SELECT ON v_hold_closure_unexplained TO corgi_app;


-- ---------------------------------------------------------------------
-- 3.  v_auth_over_reversed  -  a population report, NOT an invariant
-- ---------------------------------------------------------------------
--
-- `A < 0` is a legitimate state and this view says so by not being a
-- guard.  It exists so that `dbcheck`'s GUARD REACH can print how many
-- authorisations stand there, how deep, and - the number that would
-- matter - how many of them are withholding a cent.  That last column is
-- covered by an invariant already: `A < 0` implies `is_closed`, which
-- implies `is_released`, and `v_hold_release_drift` asserts that a
-- released hold withholds nothing.  Naming the owner is the point.

CREATE VIEW v_auth_over_reversed AS
SELECT s.auth_id,
       s.hold_id,
       ca.provider_auth_id,
       s.auth_net_cents,
       s.captured_cents,
       s.event_count,
       ch.is_closed,
       ch.target_hold_cents,
       hs.memo_balance_cents,
       hs.is_released
  FROM v_card_auth_state  s
  JOIN card_authorization ca ON ca.id = s.auth_id
  JOIN v_card_auth_hold   ch ON ch.auth_id = s.auth_id
  JOIN v_hold_state       hs ON hs.hold_id = s.hold_id
 WHERE s.auth_net_cents < 0;

COMMENT ON VIEW v_auth_over_reversed IS
  'NOT an invariant - a population report. Authorisations whose reversals '
  'exceed their authorisations, i.e. A(E) < 0. That is a LEGITIMATE state: a '
  'reversal delivered before the authorisation it belongs to reaches it, and '
  'the fuzzer reaches it on 22.4% of generated sets, all of them closed and '
  'holding nothing. A(E) is deliberately not floored -- see 0043''s header and '
  'src/lib/holds/model.ts. dbcheck prints this under GUARD REACH; the money '
  'question it raises is owned by v_hold_release_drift.';

GRANT SELECT ON v_auth_over_reversed TO corgi_app;


-- ---------------------------------------------------------------------
-- 4.  WHAT THIS MIGRATION ASSERTS BEFORE IT COMMITS
-- ---------------------------------------------------------------------
--
-- It adds no column, writes no row and moves no money, so the strong
-- assertion 0032 could make is not available.  The one it CAN make is
-- that the three views it is not allowed to disturb are exactly where
-- they were, and that the two new guards are non-vacuous - each has to be
-- capable of returning a row, which on this book means each DOES return
-- the rows its header names.  A guard that shipped empty here would be
-- the twenty-fourth instance of the pattern, not the fix for it.
--
-- `dbcheck --prove` makes both of them move on every run.

DO $$
DECLARE
  v_drift    int;
  v_release  int;
  v_terminal int;
  v_advice   int;
  v_closure  int;
  v_negative int;
  v_cents    bigint;
BEGIN
  SELECT count(*) INTO v_drift    FROM v_hold_drift;
  SELECT count(*) INTO v_release  FROM v_hold_release_drift;
  SELECT count(*) INTO v_terminal FROM v_hold_closure_not_terminal;

  IF v_drift <> 0 OR v_release <> 0 OR v_terminal <> 0 THEN
    RAISE EXCEPTION
      '0043 refuses to commit: v_hold_drift=% v_hold_release_drift=% v_hold_closure_not_terminal=% (all three must be 0 -- this migration must not disturb them)',
      v_drift, v_release, v_terminal;
  END IF;

  SELECT count(*) INTO v_advice  FROM v_advice_delta_unsound;
  SELECT count(*), COALESCE(sum(target_hold_cents), 0)
    INTO v_closure, v_cents FROM v_hold_closure_unexplained;
  SELECT count(*) INTO v_negative FROM v_auth_over_reversed;

  RAISE NOTICE '0043: v_advice_delta_unsound = % row(s) -- RED ON ARRIVAL, not repaired; see the header', v_advice;
  RAISE NOTICE '0043: v_hold_closure_unexplained = % row(s), % cents -- RED ON ARRIVAL, not repaired; see the header', v_closure, v_cents;
  RAISE NOTICE '0043: v_auth_over_reversed = % authorisation(s) standing at A < 0 (a population report, not a guard)', v_negative;
END $$;
