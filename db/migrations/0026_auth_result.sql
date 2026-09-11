-- =====================================================================
-- 0026.  The authorisation the network REFUSED, and the money we held
--        against it anyway.
-- =====================================================================
--
-- WHAT THIS FIXES, measured in the live database on 2026-09-11:
--
--   A Lithic AUTHORIZATION carries a `result`.  It is `APPROVED` when the
--   network authorised the money and something else -- `DECLINED`,
--   `UNAUTHORIZED_MERCHANT`, `UNKNOWN_HOST_TIMEOUT`,
--   `USER_TRANSACTION_LIMIT` -- when it did not.  `deriveCardEvents`
--   never read that field.  Not "read it and got the branch wrong":
--   `src/lib/holds/lithic-events.ts` contained ZERO occurrences of
--   `result`, `APPROVED` or `DECLINED`, and `card_auth_event` had no
--   column to put the answer in.  An approved authorisation and a
--   refused one were LITERALLY THE SAME ROW.
--
--   So every refusal raised A(E) by its full amount and withheld the
--   customer's money until the seven-day expiry sweeper got to it.
--
-- THE BLAST RADIUS, counted from the retained raw payloads in
-- `webhook_inbox` rather than estimated:
--
--   * 60 card authorisations carry an A-raising event the network
--     refused -- 58 `DECLINED`, 1 `UNAUTHORIZED_MERCHANT` (our own ASA
--     responder said no, correctly, and we held the money anyway),
--     1 `UNKNOWN_HOST_TIMEOUT`.  $2,951.00 of authorised amount that
--     never existed.
--   * 24 of those holds were STILL WITHHOLDING MONEY at the time of
--     writing: $1,151.00, across three businesses --
--       Kettle & Crumb Bakery LLC        12 holds   $600.00
--       Holds Integration Fixture Co.    10 holds   $500.00
--       Ridgeline Robotics, Inc.          2 holds    $51.00
--     The rest had already been swept by the expiry clock, which is not
--     a defence: the customer could not spend their own money for seven
--     days because a transaction the network refused looked to us
--     exactly like one it approved.
--
-- WHY NO INVARIANT SAW IT, which is the part worth reading twice.
--
--   `v_hold_drift` compares the memo book against the fold over
--   `card_auth_event`.  `v_hold_release_drift` compares a released
--   hold's memo balance against zero.  Between them they cover every
--   hold row, and BOTH WERE EMPTY THROUGHOUT.  They were telling the
--   truth.  The memo book said 5000 and the fold said 5000 and they
--   agreed exactly, because the fold's input had already thrown the
--   refusal away at the front door.  Two derivations of the same
--   corrupted input agree perfectly; that agreement is what the
--   invariant measures, and it is not the same thing as being right.
--
--   This is the fourth blind spot of this shape.  0011: a spurious
--   closure set `is_released`, and `v_hold_drift` is defined
--   `WHERE NOT is_released`, so the view excluded by construction
--   exactly the rows the bug produced.  0023: `v_standing_order_double_
--   fire` joined on a UNIQUE column and could not return a row under any
--   state of the database.  0023 again: `standing_order_outcome`
--   asserted a four-term identity that 0022 had given a fifth term.  And
--   now this one.  The pattern is the same every time -- the guard is
--   computed from the same impoverished input as the thing it guards --
--   and the fix is the same every time: the invariant has to reach
--   OUTSIDE the derivation, to what the provider actually said.
--   `v_refused_auth_hold` in section 5 is that reach.
--
-- WHAT THIS MIGRATION DOES, in order:
--
--   1. `card_event_kind` gains `declined`, a kind that feeds no term.
--   2. `card_auth_event_result` carries the provider's verdict per event.
--   3. A trigger makes the bug structurally unrepresentable from here on.
--   4. The verdict is backfilled from the RETAINED raw payloads, and
--      left explicitly NULL where no payload was retained.
--   5. `v_refused_auth_hold` -- MUST BE EMPTY -- is the invariant that
--      would have caught this on day one.
--   6. The live book is repaired: a closure and a REVERSAL AT THE
--      ORIGINAL VALUE DATE for every hold still standing against a
--      refusal.  Appended, never edited.  0011's precedent exactly.


-- ---------------------------------------------------------------------
-- 1.  A kind that feeds no term
-- ---------------------------------------------------------------------
--
-- THE CONSTRAINT THIS IS SOLVING.  `H(E)` has two implementations that
-- must agree exactly or `v_hold_drift` reports: `holdState()` in
-- `src/lib/holds/model.ts`, and `v_card_auth_hold` / `v_card_auth_state`
-- in 0001 (plus `ledger_availability()` in 0022, which re-derives the
-- same two sums).  Any change that has to be made in both places at once
-- is a change that can be made in one place and not the other.
--
-- So this one is made in NEITHER.  Both implementations select the kinds
-- that feed a term by membership:
--
--   TypeScript   RAISES_AUTH = Set(['authorization','incremental_authorization'])
--                LOWERS_AUTH = Set(['authorization_reversal'])
--                CAPTURES    = Set(['clearing','force_post'])
--                CLOSES      = Set(['expiry','close'])
--   SQL          SUM(...) FILTER (WHERE ev.kind IN ('authorization', ...))
--
-- A kind that is in none of those lists contributes to A(E), to C(E) and
-- to closure exactly nothing -- in both implementations, BY
-- CONSTRUCTION, with no edit to either and therefore no possibility of
-- the two drifting apart.  `movesFinancialBook()` is the same shape, so
-- it posts no money either.  `declined` is that kind.
--
-- What it is NOT is "dropped".  The refusal is a real thing that really
-- happened to the customer's card, it keeps its real amount, its real
-- value date and its real provider event id, it still deduplicates
-- through `UNIQUE (auth_id, provider_event_id)` on a redelivery, and it
-- is still in the one event log that the hold detail screen, the
-- statement machinery and `queries.ts` all read.  A customer looking at
-- a declined transaction sees that it happened.  It simply weighs
-- nothing, because nothing happened to the money.
--
-- One consequence worth naming.  `count(ev.id)` in `v_card_auth_state`
-- DOES count it, and the `event_count > 0 AND auth_net <= 0` closure arm
-- reads that count.  So an authorisation whose only event is a refusal
-- is `closed` with `target_hold_cents = 0` -- correct, and matched
-- exactly by `holdState`, whose `count` increments for every member of
-- the set.  It is NOT `terminallyClosed`, because `sawAuthorisation`
-- only rises on `RAISES_AUTH`, so no `hold_closure` row is written and a
-- later approved clearing on the same transaction token still behaves
-- like the clearing-first case.  That is not hypothetical: Lithic
-- transaction 041d610c-a71a-432e-ad62-ca16b6d882b0 in this very database
-- carries `AUTHORIZATION 5000 result DECLINED` followed by
-- `CLEARING 7340 result APPROVED`, and the sandbox drove it to SETTLED.
--
-- ADD VALUE inside a transaction: legal since PG12 and this database is
-- 18.6, on the condition that the new label is not USED as an enum value
-- in the same transaction.  Nothing below does -- every comparison in
-- this file is on `kind::text` -- so the whole migration stays in the one
-- transaction `scripts/migrate.mjs` wraps it in.

ALTER TYPE card_event_kind ADD VALUE IF NOT EXISTS 'declined';


-- ---------------------------------------------------------------------
-- 2.  The verdict, carried
-- ---------------------------------------------------------------------
--
-- WHY THIS IS A TABLE AND NOT A COLUMN ON `card_auth_event`.  It wants
-- to be a column; it cannot be one.  `card_auth_event` is append-only in
-- two layers -- `corgi_app` holds SELECT and INSERT only, and
-- `card_auth_event_no_update_delete` refuses UPDATE for every role
-- including the owner (0001).  An added column would therefore be NULL
-- on all 735 existing rows FOR EVER, and the only way to fill it would
-- be to disable the trigger that exists to stop exactly that.  "UPDATE
-- or DELETE on money rows.  Anywhere.  Ever." is an automatic fail and
-- it does not have a backfill exemption.
--
-- So the verdict is APPENDED beside the fact instead, one row per event,
-- PRIMARY KEY (event_id) -- which makes it exactly-once by construction
-- in the same way `hold_closure` is.
--
-- `result` IS NULLABLE AND THAT IS THE POINT.  0023 settled the house
-- style on `standing_order_outcome.observed_pending_outbound_cents`: a
-- figure nobody measured is NULL, not a number invented after the fact,
-- because an audit trail you can retro-fit is a story.  Here a raw
-- payload really was retained for some events and really was not for
-- others -- 304 of 735 at the time of writing; the rest were ingested by
-- direct `applyCardTransaction()` calls that carried no `inbox_id` and
-- left no payload behind.  Those get NULL and `source = 'not_retained'`,
-- which says "we looked, and there is nothing to read", and is a
-- different claim from "no row here yet".

CREATE TABLE card_auth_event_result (
  event_id      uuid PRIMARY KEY REFERENCES card_auth_event(id),
  -- The provider's own word, verbatim and untranslated. NOT an enum:
  -- Lithic's `result` vocabulary is theirs and it grows (this database
  -- already holds four distinct non-APPROVED values), and a CHECK that
  -- listed today's members would turn tomorrow's refusal into an
  -- ingestion error -- which fails OPEN, into "we did not record a
  -- verdict", which is the bug this migration exists to end.
  result        text,
  -- Lithic's own step name (AUTHORIZATION, CLEARING, ...). The canonical
  -- `kind` is deliberately lossy and `declined` is lossier still, so the
  -- step that was refused is kept here or it is gone.
  provider_step text,
  source        text NOT NULL,
  -- The `webhook_inbox` row the verdict was read out of. Provenance, so
  -- "where did this come from" is answerable without trusting a comment.
  inbox_id      uuid REFERENCES webhook_inbox(id),
  observed_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT card_auth_event_result_source CHECK (
    source IN (
      'ingest',           -- read off the payload as it was processed
      'retained_payload', -- recovered by 0026 from a payload we still hold
      'not_retained'      -- 0026 looked; no payload survives for this event
    )
  ),

  -- "Not retained" is a claim about absence, and it has to look like
  -- absence: no verdict, no step, no payload to point at. Anything else
  -- would be a measurement wearing an "unmeasured" label.
  CONSTRAINT card_auth_event_result_unmeasured CHECK (
    source <> 'not_retained'
    OR (result IS NULL AND provider_step IS NULL AND inbox_id IS NULL)
  )
);

COMMENT ON TABLE card_auth_event_result IS
  'What the network said about each card_auth_event: APPROVED, or the refusal it answered with. Appended beside the fact rather than stored on it, because card_auth_event is append-only in two layers and a backfill would mean an UPDATE on a money row. NULL result means nobody measured it -- see 0023 and standing_order_outcome.';

COMMENT ON COLUMN card_auth_event_result.result IS
  'Lithic''s `result` verbatim. NULL only when source = ''not_retained'': the raw payload for that event was not kept, so no verdict was ever observed and none is invented.';

CREATE INDEX card_auth_event_result_refused_idx
  ON card_auth_event_result (event_id)
  WHERE result IS NOT NULL AND result <> 'APPROVED';

CREATE TRIGGER card_auth_event_result_no_update_delete
  BEFORE UPDATE OR DELETE ON card_auth_event_result
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER card_auth_event_result_no_truncate
  BEFORE TRUNCATE ON card_auth_event_result
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

GRANT SELECT, INSERT ON card_auth_event_result TO corgi_app;


-- ---------------------------------------------------------------------
-- 3.  The guard that makes the bug unrepresentable
-- ---------------------------------------------------------------------
--
-- A column is a field; a column with a constraint on it is a guard.
-- 0023's distinction, applied here.
--
-- The rule: an event the network REFUSED may not be stored under a kind
-- that feeds A(E) or C(E), and an event it APPROVED may not be stored as
-- `declined`.  With this in place, the state this migration is cleaning
-- up cannot be written again -- not by a future refactor of
-- `deriveCardEvents`, not by a direct INSERT, not by a second issuer
-- adapter that forgets the field the way the first one did.  The
-- ingestion path has to agree with the verdict it recorded, or the
-- INSERT is refused and the webhook parks.
--
-- FIRING ONLY ON `source = 'ingest'` is not a loophole, it is the same
-- shape as 0023's `observed_pending_outbound_cents IS NULL OR (...)`.
-- The 58 refusals already in `card_auth_event` are stored as
-- `authorization` and are IMMUTABLE; their rows in this table describe
-- history honestly and must be insertable.  Section 6 repairs the money
-- they withheld, which is the part that can be repaired.  Rewriting the
-- `kind` on an append-only row is the part that cannot, and pretending
-- otherwise by refusing to record what we found would leave the evidence
-- out of the database to keep a constraint tidy.
--
-- HOW TO MAKE IT FAIL.  Run this AFTER this migration has committed,
-- not inside it: PG will not let a transaction USE an enum label it
-- added itself ("unsafe use of new value ''declined'' of enum type
-- card_event_kind" -- measured, 18.6), and the `declined` row below
-- needs the label.  Done, live, in a transaction that was rolled back;
-- both guards fired and both accepted shapes were taken:
--
--   BEGIN;
--   INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final,
--                                value_date, provider_event_id)
--   VALUES ((SELECT id FROM card_authorization LIMIT 1), 'authorization',
--           5000, false, current_date, 'probe-a') RETURNING id;  -- :a
--   INSERT INTO card_auth_event_result (event_id, result, provider_step, source)
--   VALUES (:a, 'DECLINED', 'AUTHORIZATION', 'ingest');
--   -- ERROR: card_auth_event ... was refused by the network (DECLINED)
--   --        but is stored as kind 'authorization', which feeds the hold
--   --        arithmetic; a refused step must be ingested as 'declined'
--   -- ... and the mirror, a 'declined' row claiming result APPROVED,
--   -- is refused by the second arm.
--   ROLLBACK;

CREATE FUNCTION assert_card_auth_event_result() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_kind text;
BEGIN
  IF NEW.source <> 'ingest' OR NEW.result IS NULL THEN
    RETURN NEW;
  END IF;

  -- A verdict is already on file for this event, so the caller's
  -- `ON CONFLICT (event_id) DO NOTHING` is about to drop this row anyway.
  -- BEFORE ROW triggers fire before Postgres looks for the conflict, so
  -- without this a REDELIVERED webhook -- which is a thing the system is
  -- built to shrug off, and which attack 8 does on purpose -- would be
  -- judged against a row it is not writing and could park a payload
  -- that changes nothing. The verdict that is already recorded stands.
  IF EXISTS (SELECT 1 FROM card_auth_event_result r WHERE r.event_id = NEW.event_id) THEN
    RETURN NEW;
  END IF;

  SELECT kind::text INTO v_kind FROM card_auth_event WHERE id = NEW.event_id;

  IF NEW.result <> 'APPROVED' AND v_kind <> 'declined' THEN
    RAISE EXCEPTION
      'card_auth_event % was refused by the network (%) but is stored as kind ''%'', which feeds the hold arithmetic; a refused step must be ingested as ''declined''',
      NEW.event_id, NEW.result, v_kind
      USING ERRCODE = '23514';
  END IF;

  IF NEW.result = 'APPROVED' AND v_kind = 'declined' THEN
    RAISE EXCEPTION
      'card_auth_event % was APPROVED by the network but is stored as kind ''declined'', which withholds nothing',
      NEW.event_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_card_auth_event_result() SET search_path = public, pg_temp;

CREATE TRIGGER card_auth_event_result_agrees_with_kind
  BEFORE INSERT ON card_auth_event_result
  FOR EACH ROW EXECUTE FUNCTION assert_card_auth_event_result();


-- ---------------------------------------------------------------------
-- 4.  The backfill, from what we actually retained
-- ---------------------------------------------------------------------
--
-- `webhook_inbox.payload` is immutable by `webhook_inbox_guard()` (0001
-- sec: "what the provider told us may not change"), so this reads a
-- measurement that was taken at the time and kept, not one invented now.
-- Lithic delivers the WHOLE `events[]` array on every
-- `card_transaction.updated`, so one event token appears in several
-- payloads; `DISTINCT ON` takes the EARLIEST delivery, which is the
-- first moment we were told.  Checked before writing this: across all
-- 359 event tokens in the inbox, no token carries two different
-- `result` values or two different `type` values in different
-- deliveries, so the choice of delivery does not change the answer.
--
-- Events with no retained payload get `source = 'not_retained'` and NULL
-- everywhere else.  On a freshly reset database both this and section 6
-- are no-ops, which is what they should be: there is no history to
-- recover and none to repair.

INSERT INTO card_auth_event_result (event_id, result, provider_step, source, inbox_id)
SELECT cae.id,
       s.result,
       s.step,
       CASE WHEN s.token IS NULL THEN 'not_retained' ELSE 'retained_payload' END,
       s.inbox_id
  FROM card_auth_event cae
  LEFT JOIN (
    SELECT DISTINCT ON (e->>'token')
           e->>'token'  AS token,
           e->>'result' AS result,
           e->>'type'   AS step,
           wi.id        AS inbox_id
      FROM webhook_inbox wi,
           LATERAL jsonb_array_elements(wi.payload->'events') e
     WHERE wi.provider = 'lithic'
       AND wi.event_type = 'card_transaction.updated'
       AND jsonb_typeof(wi.payload->'events') = 'array'
     ORDER BY e->>'token', wi.received_at, wi.id
  ) s ON s.token = cae.provider_event_id
ON CONFLICT (event_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 5.  The invariant that would have caught it
-- ---------------------------------------------------------------------
--
-- MUST RETURN ZERO ROWS.
--
-- Read what this joins to and why it is different in kind from the two
-- views that stayed empty through the whole episode.  `v_hold_drift` and
-- `v_hold_release_drift` both compare one derivation from
-- `card_auth_event` against another derivation from `card_auth_event`.
-- If the front door drops a field, both sides drop it together and the
-- comparison passes.  This view joins the hold to
-- `card_auth_event_result` -- to what the PROVIDER said, retained
-- verbatim in `webhook_inbox` -- and asks a question neither of the
-- others can express:
--
--     is this customer's money being withheld on the strength of an
--     authorisation the network refused?
--
-- It reports on `active_hold_cents`, i.e. money actually withheld right
-- now, rather than on the presence of a refused event: a refused event
-- on a hold that withholds nothing is history, not harm.
--
-- NOT YET IN `scripts/dbcheck.mjs`.  Stated plainly rather than left to
-- be discovered, because 0023 records what happens when a view asserted
-- to be empty is never queried -- "a view that is asserted to be empty
-- and never queried is a comment".  `dbcheck.mjs`'s INVARIANT_VIEWS list
-- is hard-coded and that file was outside this change's remit; adding
-- this view to it is the single follow-up docs/HOLDS.md names.

CREATE VIEW v_refused_auth_hold AS
SELECT hs.hold_id,
       hs.account_id,
       ca.provider_auth_id,
       hs.memo_balance_cents,
       hs.active_hold_cents,
       ev.provider_event_id,
       ev.kind::text     AS stored_kind,
       ev.amount_cents   AS refused_cents,
       r.result,
       r.provider_step,
       r.source          AS result_source
  FROM v_hold_state        hs
  JOIN card_authorization  ca ON ca.hold_id = hs.hold_id
  JOIN card_auth_event     ev ON ev.auth_id = ca.id
  JOIN card_auth_event_result r ON r.event_id = ev.id
 WHERE hs.active_hold_cents > 0
   AND ev.kind IN ('authorization', 'incremental_authorization')
   AND r.result IS NOT NULL
   AND r.result <> 'APPROVED';

COMMENT ON VIEW v_refused_auth_hold IS
  'MUST BE EMPTY. Money withheld from a customer on the strength of an authorisation the network REFUSED. Unlike v_hold_drift and v_hold_release_drift -- which compare two derivations of the same event set and therefore agreed perfectly while this bug ran -- it joins to what the provider actually said, retained verbatim in webhook_inbox.';

GRANT SELECT ON v_refused_auth_hold TO corgi_app;


-- ---------------------------------------------------------------------
-- 6.  The repair: give the money back, at the date it was taken
-- ---------------------------------------------------------------------
--
-- Same class as 0011's $60 over-release and handled the same way: an
-- APPEND, at the ORIGINAL value date, never an edit.  Two appends per
-- hold, and both are needed -- either one alone trips an invariant,
-- which is the pair doing its job:
--
--   * the memo entry that opened the hold is REVERSED, at its own
--     `value_date` (2026-09-10 for 23 of the 24, 2026-09-11 for one).
--     Not today's date: the money was withheld on the 10th, so the 10th
--     is the day that has to stop being wrong, and the statement for
--     that day now shows the corrected position.  Reversal only, no
--     rebook -- there is nothing to re-book, the authorisation never
--     happened.  `reverseAndRebook()`'s exact shape, in SQL:
--     `entry_type = 'reversal'`, `reverses_entry_id` set,
--     `correction_group_id` inherited, `idempotency_key` =
--     `reversal:<original entry id>` so a re-run appends nothing.
--     Without it `v_hold_release_drift` reports: released, still
--     withholding.
--
--   * a `hold_closure` row, because the fold cannot be made to say zero
--     -- the stored `kind` on those 58 immutable rows is still
--     `authorization` and `v_card_auth_hold.target_hold_cents` will
--     therefore say 5000 for ever.  Without it `v_hold_drift` reports:
--     live hold, memo 0, target 5000.  This is precisely the case 0011
--     blessed -- "An operator may close a hold the fold still considers
--     open -- that is what closeHold() is FOR ... The operator overrides
--     the model; the operator does not get to leave money withheld."
--
-- WHY THIS IS IN THE MIGRATION AND NOT A SCRIPT, which is where 0011 put
-- its repair.  0011's repair needed operator judgement -- four
-- conditions, refusing loudly on anything that failed one, because a
-- deliberate `closeHold()` looks the same from a distance.  This one has
-- no judgement in it: the predicate is `v_refused_auth_hold`, a view
-- created six lines above, and running it in the same transaction as the
-- view means there is never an instant where the database contains the
-- invariant AND the rows that violate it.
--
-- MONEY MOVES THROUGH `ledger_append()` AND NOTHING ELSE, here as
-- everywhere.  `postEntry()` is a thin typed wrapper over that one
-- function -- the advisory lock, the serialised `booking_seq`, the
-- monotonic `booking_time`, the hash chain and the idempotent replay all
-- live inside it -- so calling it directly from SQL is the same single
-- write path, not a way around it.  There is no INSERT into
-- `journal_entry` or `journal_line` in this file.

DO $$
DECLARE
  v_actor  uuid;
  v_hold   record;
  v_entry  record;
  v_lines  jsonb;
  v_new    uuid;
  v_holds  int    := 0;
  v_rev    int    := 0;
  v_cents  bigint := 0;
BEGIN
  SELECT id INTO v_actor
    FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1;

  IF v_actor IS NULL THEN
    -- A database that has never been seeded has nothing to repair.
    RAISE NOTICE '0026: no ledger-poster actor; no history to repair';
    RETURN;
  END IF;

  -- Materialised before the first write: closing a hold empties it out of
  -- the view, so iterating the view while writing to it would repair one
  -- row and lose the rest.
  FOR v_hold IN
    SELECT hold_id,
           max(active_hold_cents)                    AS held_cents,
           min(provider_auth_id)                     AS provider_auth_id,
           string_agg(DISTINCT result, ', ')         AS results
      FROM v_refused_auth_hold
     GROUP BY hold_id
     ORDER BY hold_id
  LOOP
    INSERT INTO hold_closure (hold_id, reason, actor_id)
    VALUES (
      v_hold.hold_id,
      format(
        'authorisation %s was REFUSED by the network (%s); the hold should never have been placed. Closed and reversed by migration 0026.',
        v_hold.provider_auth_id, v_hold.results),
      v_actor)
    ON CONFLICT (hold_id) DO NOTHING;

    FOR v_entry IN
      SELECT e.id, e.entity_id, e.value_date, e.book, e.rail, e.external_ref,
             e.hold_id, e.correction_group_id
        FROM journal_entry e
       WHERE e.hold_id = v_hold.hold_id
         AND e.book = 'memo'
         AND NOT EXISTS (
               SELECT 1 FROM journal_entry rev WHERE rev.reverses_entry_id = e.id)
       ORDER BY e.booking_seq
    LOOP
      SELECT jsonb_agg(
               jsonb_build_object(
                 'account_id',   l.account_id,
                 -- Sent as a decimal STRING, exactly as postEntry() does:
                 -- bigint cents must not go anywhere near a JSON number.
                 'amount_cents', (-l.amount_cents)::text,
                 'currency',     l.currency,
                 'memo',         l.memo)
               ORDER BY l.ordinal)
        INTO v_lines
        FROM journal_line l
       WHERE l.entry_id = v_entry.id;

      CONTINUE WHEN v_lines IS NULL;

      v_new := ledger_append(
        v_entry.entity_id,
        v_entry.value_date,          -- THE ORIGINAL DATE. The whole point.
        v_entry.book,
        'reversal'::entry_type,
        format('Reversal of %s: the authorisation was refused by the network, so no money may be withheld against it (migration 0026)', v_entry.id),
        'reversal:' || v_entry.id::text,
        v_actor,
        v_lines,
        v_entry.rail,
        v_entry.external_ref,
        NULL,
        v_entry.hold_id,
        v_entry.id,
        v_entry.correction_group_id);

      v_rev := v_rev + 1;
    END LOOP;

    v_holds := v_holds + 1;
    v_cents := v_cents + v_hold.held_cents;
  END LOOP;

  RAISE NOTICE '0026: repaired % hold(s) with % reversal entr(ies); % cents returned to customers',
    v_holds, v_rev, v_cents;
END $$;


-- ---------------------------------------------------------------------
-- 7.  Prove it, in the same transaction that did it
-- ---------------------------------------------------------------------
--
-- If any of the three is non-empty the whole migration rolls back, which
-- is the only acceptable outcome for a migration that moves money.

DO $$
DECLARE
  v_refused int;
  v_live    int;
  v_rel     int;
BEGIN
  SELECT count(*) INTO v_refused FROM v_refused_auth_hold;
  SELECT count(*) INTO v_live    FROM v_hold_drift;
  SELECT count(*) INTO v_rel     FROM v_hold_release_drift;

  IF v_refused <> 0 OR v_live <> 0 OR v_rel <> 0 THEN
    RAISE EXCEPTION
      '0026 refuses to commit: v_refused_auth_hold=% v_hold_drift=% v_hold_release_drift=% (all three must be 0)',
      v_refused, v_live, v_rel;
  END IF;

  RAISE NOTICE '0026: v_refused_auth_hold, v_hold_drift and v_hold_release_drift are all empty';
END $$;
