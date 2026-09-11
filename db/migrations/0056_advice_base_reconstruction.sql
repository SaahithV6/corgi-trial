-- =====================================================================
-- 0056  ADVICE BASE RECONSTRUCTION  -  the twelve advices nothing asked
--                                     a second question about
-- =====================================================================
--
-- Hole 3 of the four docs/INVARIANTS.md ranked open after 0054.
--
-- ---------------------------------------------------------------------
-- THE THRESHOLD, AND WHAT IS ON THE OTHER SIDE OF IT
-- ---------------------------------------------------------------------
--
-- `v_advice_delta_unsound` (0043) asks one question of an
-- AUTHORIZATION_ADVICE:
--
--     adv.absolute_cents IS NULL OR (adv.absolute_cents - signed_delta) < 0
--
-- An advice carries the ABSOLUTE authorised amount; this book stores the
-- DELTA that produces it. So `absolute - delta` is the base the
-- conversion implicitly claimed the authorisation stood at beforehand,
-- and 0043 fires when that base is IMPOSSIBLE -- below zero.
--
-- That is a threshold, and a threshold has a far side. Measured on this
-- book: 13 stored events derive from an advice. ONE fires. The other
-- TWELVE have a base of zero or more and are never questioned again --
-- not by this guard, and not by any other, because no other view on this
-- build reads an advice payload at all.
--
-- 12 of 13 unexamined is the same shape as instance 27 and as every
-- other entry in the catalogue: the predicate asks about a NUMBER'S SIGN
-- and stops. A base of 0 is as unexamined as a base of 4,000, and
-- "plausible" is not "correct".
--
-- ---------------------------------------------------------------------
-- THE QUESTION THAT IS NOT A THRESHOLD
-- ---------------------------------------------------------------------
--
-- The base is not merely supposed to be non-negative. It is supposed to
-- be A PARTICULAR NUMBER: the authorisation's own net immediately before
-- this event. The stored delta is sound exactly when
--
--     absolute_cents - signed_delta  =  A(E) over every PRIOR event
--
-- -- when the event this book wrote is precisely the event that turns
-- the state it already had into the state the network reported. That is
-- not a tolerance and it cannot be satisfied by choosing a smaller
-- number: there is one right-hand side and it is computed from rows.
--
-- The fold is the same one `v_card_auth_state.auth_net_cents` uses:
-- `authorization` and `incremental_authorization` add, `authorization_
-- reversal` subtracts, and `clearing`, `force_post`, `expiry` and
-- `close` do not move the authorised amount. Ordered by `received_at`
-- with `id` as the tiebreak, so two events landing in the same
-- microsecond still fold in a fixed order rather than an arbitrary one.
--
-- IT IS COMPUTED OVER EVERY `card_auth_event`, not only those carrying a
-- `card_auth_event_result`. An earlier revision of this predicate took
-- the fold from a query that INNER JOINed the result table, which
-- silently dropped every event whose verdict was never recorded -- and
-- "the verdict was never recorded" is the state 98 events on this book
-- were in when 0026 shipped a guard that excluded its own bug. The wrong
-- fold reported 12 sound and 1 unsound-for-the-wrong-reason; the right
-- one reports the partition below. The defect this file is about was one
-- SQL revision away from being reproduced inside the file about it.
--
-- ---------------------------------------------------------------------
-- THE PARTITION, AND WHY THIS GUARD IS NOT A SECOND RED
-- ---------------------------------------------------------------------
--
-- Run against this book, the two predicates divide the 13 exactly:
--
--   base < 0             1 event   a299ea01-f4c2-44a7-b042-13093b979329
--                                  -- ALREADY RED under
--                                  v_advice_delta_unsound, already on
--                                  dbcheck's RED_REGISTER, already
--                                  documented in 0043's header as the
--                                  Lithic over-reversal on transaction
--                                  5892c550-...: absolute 0, stored as
--                                  an incremental_authorization of
--                                  7,340 against a prior net of 0. A
--                                  fact the network never sent.
--   base >= 0           12 events  every one reconstructs its fold
--                                  exactly. GREEN.
--
-- So this guard is scoped to `base >= 0` and the negative arm is left
-- to its owner. That is a deliberate exclusion and it deserves the
-- suspicion this repository has taught: an exclusion shaped like the
-- failure is the defect being catalogued.
--
-- IT IS NOT THAT, and the test is simple -- does anything report the
-- excluded row? It does. `v_advice_delta_unsound` is on the same gate,
-- in the same run, RED, with that row in it, and dbcheck's GUARD REACH
-- prints this guard as "12 of 13" with the owner of the thirteenth
-- named. The alternative -- firing here too -- would put ONE defect on
-- the board TWICE and take the failure count from four to five while
-- the number of findings stayed at four. Inflating a red is the same
-- disservice as suppressing one: both teach a reader that the number on
-- the screen is not the number of things wrong.
--
-- ---------------------------------------------------------------------
-- WHAT THIS GUARD DOES NOT ASK
-- ---------------------------------------------------------------------
--
--   * Whether `provider_step` is right. Both this guard and 0043's draw
--     their population from `card_auth_event_result.provider_step`,
--     which INGEST WRITES. An advice mislabelled at the front door is
--     invisible to both, and that is a shared blind spot rather than a
--     new one -- named here because 0026's bug was exactly a front-door
--     loss and the reach line cannot show it.
--   * Whether the advice SHOULD have been applied. `v_refused_auth_hold`
--     and `v_hold_closure_unexplained` own the verdict questions.
--   * Anything about money moving. No advice on this book moved a cent:
--     A <= 0 had already closed the hold.
--
-- ---------------------------------------------------------------------
-- GREEN ON ARRIVAL
-- ---------------------------------------------------------------------
--
--   v_advice_base_drift   0 of 12 advices with a checkable, non-negative
--                         base (13 in the census, 1 owned by 0043)
--
-- `dbcheck --prove` makes it fire by storing a delta that does not
-- reconstruct its own fold -- the conversion defect 0043 repaired in
-- `lithic-events.ts`, re-created in a transaction that is rolled back.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The census.  NOTHING IS FILTERED.
-- ---------------------------------------------------------------------

CREATE VIEW v_advice_base AS
WITH fold AS (
  -- The authorised-amount fold, over EVERY card_auth_event -- no join to
  -- the result table, for the reason in the header. `clearing`,
  -- `force_post`, `expiry` and `close` do not move A(E), matching
  -- `v_card_auth_state.auth_net_cents` exactly.
  SELECT e.id,
         e.auth_id,
         e.kind,
         e.amount_cents,
         e.inbox_id,
         e.provider_event_id,
         e.value_date,
         CASE WHEN e.kind = 'authorization_reversal'
              THEN -e.amount_cents ELSE e.amount_cents END      AS signed_delta_cents,
         COALESCE(SUM(
           CASE WHEN e.kind = 'authorization_reversal'          THEN -e.amount_cents
                WHEN e.kind IN ('authorization',
                                'incremental_authorization')    THEN  e.amount_cents
                ELSE 0 END)
           OVER (PARTITION BY e.auth_id
                     ORDER BY e.received_at, e.id
                      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
                                                                AS auth_net_before_cents
    FROM card_auth_event e
)
SELECT f.id                          AS event_id,
       f.auth_id,
       ca.provider_auth_id,
       f.kind::text                  AS stored_kind,
       f.amount_cents                AS stored_magnitude_cents,
       f.value_date,
       r.provider_step,
       adv.absolute_cents,
       f.signed_delta_cents,
       f.auth_net_before_cents,
       adv.absolute_cents - f.signed_delta_cents AS base_claimed_cents,
       (adv.absolute_cents - f.signed_delta_cents) - f.auth_net_before_cents AS drift_cents,
       CASE
         WHEN adv.absolute_cents IS NULL
           THEN 'no retained payload — owned by v_advice_delta_unsound'
         WHEN adv.absolute_cents - f.signed_delta_cents < 0
           THEN 'negative base — owned by v_advice_delta_unsound'
         WHEN adv.absolute_cents - f.signed_delta_cents = f.auth_net_before_cents
           THEN 'the delta reconstructs the fold'
         ELSE 'the delta does not reconstruct the fold'
       END AS finding
  FROM fold f
  JOIN card_auth_event_result r ON r.event_id = f.id
  JOIN card_authorization    ca ON ca.id = f.auth_id
  -- LEFT JOIN LATERAL, never an inner one: an advice whose payload this
  -- book did not retain must be REPORTED as uncheckable, not dropped.
  -- That is the whole reason 0043's view has a `no_retained_payload` arm
  -- and the reason its reach reads N of N.
  LEFT JOIN LATERAL (
    SELECT abs(COALESCE(
             ((ev.value -> 'amounts' -> 'settlement') ->> 'amount')::bigint,
             (ev.value ->> 'amount')::bigint)) AS absolute_cents
      FROM webhook_inbox wi
      CROSS JOIN LATERAL jsonb_array_elements(wi.payload -> 'events') ev
     WHERE wi.id = f.inbox_id
       AND (ev.value ->> 'token') = f.provider_event_id
     LIMIT 1
  ) adv ON true
 WHERE r.provider_step IN ('AUTHORIZATION_ADVICE', 'CREDIT_AUTHORIZATION_ADVICE');

COMMENT ON VIEW v_advice_base IS
  'Every stored event derived from an AUTHORIZATION_ADVICE, with the base its conversion implicitly claimed and the authorisation net actually standing before it. The conforming arm is finding = ''the delta reconstructs the fold''. Two arms are owned by v_advice_delta_unsound (0043) and are red there rather than here, so one defect is not counted twice. See db/migrations/0056_advice_base_reconstruction.sql.';


-- ---------------------------------------------------------------------
-- 2.  The guard.  MUST RETURN ZERO ROWS.  It is a TEST.
-- ---------------------------------------------------------------------
--
-- WHAT IT CAN SEE: every advice whose payload was retained and whose
-- claimed base is non-negative -- precisely the twelve that
-- `v_advice_delta_unsound`'s `< 0` threshold passes over in silence.
--
-- WHAT MAKES IT FIRE: a stored delta that does not turn the
-- authorisation's actual prior net into the absolute amount the network
-- reported. Not a tolerance: one right-hand side, computed from rows.

CREATE VIEW v_advice_base_drift AS
SELECT event_id, auth_id, provider_auth_id, stored_kind,
       stored_magnitude_cents, value_date, provider_step,
       absolute_cents, signed_delta_cents, auth_net_before_cents,
       base_claimed_cents, drift_cents, finding
  FROM v_advice_base
 WHERE finding = 'the delta does not reconstruct the fold';

COMMENT ON VIEW v_advice_base_drift IS
  'MUST BE EMPTY. An advice whose stored delta does not reconstruct the authorisation net that actually stood before it - the question v_advice_delta_unsound''s `base < 0` threshold never reaches, which on this book is 12 of its 13 rows. The negative-base and missing-payload arms are deliberately left to that guard, which is RED on the one row they cover; firing here as well would put one defect on the board twice. See db/migrations/0056_advice_base_reconstruction.sql.';


-- ---------------------------------------------------------------------
-- 3.  Privileges
-- ---------------------------------------------------------------------

GRANT SELECT ON v_advice_base, v_advice_base_drift TO corgi_app;


-- ---------------------------------------------------------------------
-- 4.  The migration refuses to commit on a book it would break
-- ---------------------------------------------------------------------
--
-- 0043's closing shape, as 0052, 0054 and 0055 used it -- with one extra
-- assertion these did not need.
--
-- THE PARTITION IS CHECKED, not assumed. Every row of the census must
-- land in exactly one of the four arms, and the rows this guard declines
-- must be exactly the rows `v_advice_delta_unsound` reports. If that ever
-- stops being true, an advice has fallen between the two guards -- which
-- is the failure mode a deliberate exclusion creates, and the only
-- honest way to hold an exclusion is to assert its owner still covers it.

DO $$
DECLARE
  v_bad       int;
  v_pop       int;
  v_checkable int;
  v_declined  int;
  v_old_red   int;
  v_orphan    int;
  r           record;
BEGIN
  SELECT count(*) INTO v_pop       FROM v_advice_base;
  SELECT count(*) INTO v_bad       FROM v_advice_base_drift;
  SELECT count(*) INTO v_checkable FROM v_advice_base
                                   WHERE finding IN ('the delta reconstructs the fold',
                                                     'the delta does not reconstruct the fold');
  SELECT count(*) INTO v_declined  FROM v_advice_base
                                   WHERE finding LIKE '%owned by v_advice_delta_unsound';
  SELECT count(*) INTO v_old_red   FROM v_advice_delta_unsound;

  IF v_bad <> 0 THEN
    FOR r IN SELECT event_id, drift_cents FROM v_advice_base_drift LOOP
      RAISE WARNING '0056: v_advice_base_drift: event % -- base off by % cents', r.event_id, r.drift_cents;
    END LOOP;
    RAISE EXCEPTION
      '0056 refuses to commit: v_advice_base_drift = % of % checkable advices. A guard that arrives red is a finding or a wrong predicate; neither commits unread.',
      v_bad, v_checkable;
  END IF;

  -- Every row this guard declines must actually be reported by the guard
  -- that owns it. An exclusion whose owner has stopped looking is not an
  -- exclusion, it is a blind spot with a citation.
  SELECT count(*) INTO v_orphan
    FROM v_advice_base b
   WHERE b.finding LIKE '%owned by v_advice_delta_unsound'
     AND NOT EXISTS (SELECT 1 FROM v_advice_delta_unsound u
                      WHERE u.event_id = b.event_id);

  IF v_orphan <> 0 THEN
    RAISE EXCEPTION
      '0056 refuses to commit: % advice(s) are declined by v_advice_base_drift as belonging to v_advice_delta_unsound, and that view does NOT report them. An exclusion whose owner has stopped looking is a blind spot with a citation.',
      v_orphan;
  END IF;

  IF v_pop <> v_checkable + v_declined THEN
    RAISE EXCEPTION
      '0056 refuses to commit: the census partitions % advices into % checkable + % declined, which does not add up. A row in no arm is a row nothing judges.',
      v_pop, v_checkable, v_declined;
  END IF;

  RAISE NOTICE '0056: v_advice_base_drift = 0 of % checkable advices (% in the census; % declined to v_advice_delta_unsound, which reports % row(s))',
    v_checkable, v_pop, v_declined, v_old_red;
END $$;
