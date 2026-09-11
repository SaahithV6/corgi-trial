-- =====================================================================
-- 0032.  The guard that could not see its own failure.
-- =====================================================================
--
-- 0026 installed `v_refused_auth_hold` to catch "a hold withholding money
-- against an authorisation the network refused".  It is the fourth guard
-- in this log written to reach OUTSIDE the derivation it guards, and the
-- reach was right.  The PREDICATE was not:
--
--     JOIN card_auth_event_result r ON r.event_id = ev.id     -- INNER
--    WHERE ...
--      AND r.result IS NOT NULL
--      AND r.result <> 'APPROVED'
--
-- Those are the two ways this schema spells WE HAVE NO VERDICT -- no row
-- for the event, or a row whose `result` is NULL -- and both are excluded
-- by construction.  Missing the verdict IS the failure 0026 exists to
-- catch: before 0026 the outcome was thrown away at the front door, so
-- the state the view is blindest to is precisely the state the bug
-- produces.  Sixteenth instance of the pattern this log tracks, and the
-- purest: the exclusion was built in the shape of the failure.
--
-- MEASURED IN THIS DATABASE, 2026-09-11T05:1xZ, before anything below ran:
--
--   * 130 authorisation-kind events sit on holds that are withholding
--     money right now.  98 of them (75%) carry no verdict, so the view
--     could not see them at all.  $5,665.60 withheld across 86 holds
--     behind a missing verdict.
--   * The view read ZERO ROWS at that instant.  Live fire found the two
--     holds it should have reported by asking Lithic directly.
--
-- AND THE PART THAT MAKES IT URGENT RATHER THAN TIDY.  Of the 47 card
-- events ingested since 0026 committed at 04:32Z, NOT ONE has a verdict
-- row, and 22 of them are AUTHORIZATIONS THE NETWORK DECLINED --
-- `result: "DECLINED"`, `detailed_results:
-- ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]` -- stored under `kind =
-- 'authorization'`, which feeds A(E).  Not one row anywhere in
-- `card_auth_event` carries the `declined` kind 0026 added.  The code
-- serving Lithic's deliveries predates 0026: the repository's ingest
-- path is correct and has written 18 `source = 'ingest'` verdicts into
-- this same database from the 16 deliveries it handled, but the host
-- Lithic posts to is running an older build.  So the bug 050 diagnosed
-- has been running again, in production, for the last forty minutes,
-- while the guard installed to catch it reported zero.
--
-- $600.00 of it is withheld right now, and the evidence is our own:
--
--     Kettle & Crumb Bakery LLC            6 holds   $300.00
--     Live Fire -- attack 7 (provider outage)  6 holds   $300.00
--
-- WHAT THIS MIGRATION DOES
--
--   1. Recovers every verdict that was retained in `webhook_inbox` and
--      never read, and writes an explicit `not_retained` row for every
--      event where there is genuinely nothing to read -- so "no row at
--      all" stops being a third, silent way to have no verdict.
--   2. Rebuilds `v_refused_auth_hold` on a LEFT JOIN, so a MISSING
--      verdict is loud instead of invisible, with a `verdict` column
--      separating `refused` (the network said no) from `unanswered`
--      (nobody can show it said yes).
--   3. Repairs the live book for every hold now provably standing
--      against a refusal -- appended at the original value date, 0026
--      section 6 and 0011 exactly.
--   4. Declares `v_wire_availability_drift` (0025) the invariant its own
--      comment says it is; `scripts/dbcheck.mjs` now runs it.
--   5. Proves the repairable half is repaired, in the transaction that
--      repaired it, and NAMES the half that is not.
--
-- THE HALF THAT IS NOT REPAIRABLE, said here rather than discovered
-- later.  After section 3 the view is still NOT empty: ~74 holds,
-- ~$5,065.60, whose authorisation events were ingested by direct
-- `applyCardTransaction()` calls that carried no `inbox_id` and left no
-- payload behind -- the hold fuzzer, the integration fixtures, and the
-- seed.  0026 recorded those as `source = 'not_retained'`: we looked,
-- and there is nothing to read.  Nothing in this migration invents a
-- verdict for them, and nothing EXCLUDES them either.  `pnpm db:check`
-- will therefore go RED on this view, and that is the correct reading:
-- money is being withheld on the strength of authorisations nobody can
-- show were approved.  A guard tuned until it is green again is the
-- defect this file exists to end.


-- ---------------------------------------------------------------------
-- 1.  The verdicts we kept and never read
-- ---------------------------------------------------------------------
--
-- Byte-for-byte 0026 section 4, re-run.  `webhook_inbox.payload` is
-- immutable under `webhook_inbox_guard()`, so this reads a measurement
-- taken at the time and kept, never one invented now.  Lithic delivers
-- the WHOLE `events[]` array on every `card_transaction.updated`, so one
-- event token appears in several payloads; `DISTINCT ON` takes the
-- EARLIEST delivery, which is the first moment we were told.
--
-- `ON CONFLICT (event_id) DO NOTHING` means an event that already has a
-- verdict keeps it: this recovers what is missing and overwrites nothing.
-- A re-run appends nothing, which is what makes it safe to leave in a
-- file that may be replayed against a database someone else has since
-- repaired.

INSERT INTO card_auth_event_result (event_id, result, provider_step, source, inbox_id)
SELECT cae.id,
       s.result,
       s.step,
       CASE WHEN s.token IS NULL THEN 'not_retained' ELSE 'retained_payload' END,
       s.inbox_id
  FROM card_auth_event cae
  LEFT JOIN card_auth_event_result existing ON existing.event_id = cae.id
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
 WHERE existing.event_id IS NULL
ON CONFLICT (event_id) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2.  The guard, rebuilt so that not knowing is not a pass
-- ---------------------------------------------------------------------
--
-- MUST RETURN ZERO ROWS.  It does not today, and section 5 says by how
-- much and why.
--
-- THE ONE LINE THAT MATTERS is `r.result IS DISTINCT FROM 'APPROVED'`
-- over a LEFT JOIN.  `IS DISTINCT FROM` is NULL-aware: a missing verdict
-- satisfies it, a refusal satisfies it, and only a recorded `APPROVED`
-- does not.  The old predicate had the burden of proof backwards -- it
-- asked the database to PROVE a refusal before it would report withheld
-- money, and an authorisation holding a customer's money with no
-- recorded outcome is an unanswered question, not a pass.
--
-- The `verdict` column keeps the two apart, because they are different
-- claims and they have different repairs:
--
--   refused     The provider's own word, retained verbatim, says the
--               network turned this authorisation down.  The money must
--               go back -- section 3 does it.
--   unanswered  No verdict was ever observed for this event.  There is
--               nothing to reverse (we do not know it was refused) and
--               nothing to dismiss (we cannot show it was approved).  It
--               is an open question about withheld money, and the only
--               honest thing a guard can do with one is report it.
--
-- CREATE OR REPLACE, not DROP and recreate: `src/lib/chaos/invariants.ts`,
-- `src/components/chaos/fixtures.ts`, two live-fire attacks and
-- `scripts/dbcheck.mjs` all read this view by name, and a DROP would take
-- the grant with it.  Replacing keeps the column list and appends one, in
-- the only way Postgres allows.

CREATE OR REPLACE VIEW v_refused_auth_hold AS
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
       -- 'absent' is unreachable after section 1 and is kept anyway: a
       -- guard must render a state it does not expect rather than fold it
       -- into one it does. That fold is the bug above.
       COALESCE(r.source, 'absent') AS result_source,
       CASE WHEN r.result IS NULL THEN 'unanswered' ELSE 'refused' END AS verdict
  FROM v_hold_state        hs
  JOIN card_authorization  ca ON ca.hold_id = hs.hold_id
  JOIN card_auth_event     ev ON ev.auth_id = ca.id
  LEFT JOIN card_auth_event_result r ON r.event_id = ev.id
 WHERE hs.active_hold_cents > 0
   AND ev.kind IN ('authorization', 'incremental_authorization')
   AND r.result IS DISTINCT FROM 'APPROVED';

COMMENT ON VIEW v_refused_auth_hold IS
  'MUST BE EMPTY. Money withheld from a customer on an authorisation that is not recorded as APPROVED -- either the network REFUSED it (verdict=refused) or no verdict was ever observed (verdict=unanswered). 0026 shipped this on an INNER JOIN with "AND r.result IS NOT NULL", which excluded by construction the exact state the bug it was written for produces; 0032 rebuilt it on a LEFT JOIN with IS DISTINCT FROM. Unlike v_hold_drift and v_hold_release_drift -- two derivations of the same event set, which agreed perfectly while the bug ran -- it joins to what the provider actually said, retained verbatim in webhook_inbox.';


-- ---------------------------------------------------------------------
-- 3.  Give back the money the network never agreed to take
-- ---------------------------------------------------------------------
--
-- 0026 section 6, unchanged in substance, restricted to `verdict =
-- 'refused'`.  An APPEND at the ORIGINAL value date, never an edit.  Two
-- appends per hold, and both are needed -- either alone trips an
-- invariant, which is the pair doing its job:
--
--   * the memo entry that opened the hold is REVERSED at its own
--     `value_date`, so the day the money was withheld is the day that
--     stops being wrong and the statement for that day shows the
--     corrected position.  Reversal only, no re-book: the authorisation
--     never happened.  Without it `v_hold_release_drift` reports
--     "released, still withholding".
--   * a `hold_closure` row, because the fold cannot be made to say zero:
--     the stored `kind` on those immutable rows is `authorization` and
--     `v_card_auth_hold.target_hold_cents` will say so for ever.  Without
--     it `v_hold_drift` reports "live hold, memo 0, target N".  0011
--     blessed exactly this case: "the operator overrides the model; the
--     operator does not get to leave money withheld."
--
-- `unanswered` rows are deliberately NOT touched.  Reversing a hold we
-- cannot show was refused would be the mirror of the bug being fixed --
-- inventing a verdict in the customer's favour instead of in ours -- and
-- both are the same error: acting on a fact nobody measured.
--
-- MONEY MOVES THROUGH `ledger_append()` AND NOTHING ELSE.  There is no
-- INSERT into `journal_entry` or `journal_line` in this file.

DO $$
DECLARE
  v_actor  uuid;
  v_hold   record;
  v_entry  record;
  v_lines  jsonb;
  v_holds  int    := 0;
  v_rev    int    := 0;
  v_cents  bigint := 0;
BEGIN
  SELECT id INTO v_actor
    FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1;

  IF v_actor IS NULL THEN
    RAISE NOTICE '0032: no ledger-poster actor; no history to repair';
    RETURN;
  END IF;

  -- Materialised before the first write: closing a hold empties it out of
  -- the view, so iterating the view while writing to it would repair one
  -- row and lose the rest.
  FOR v_hold IN
    SELECT hold_id,
           max(active_hold_cents)            AS held_cents,
           min(provider_auth_id)             AS provider_auth_id,
           string_agg(DISTINCT result, ', ') AS results
      FROM v_refused_auth_hold
     WHERE verdict = 'refused'
     GROUP BY hold_id
     ORDER BY hold_id
  LOOP
    INSERT INTO hold_closure (hold_id, reason, actor_id)
    VALUES (
      v_hold.hold_id,
      format(
        'authorisation %s was REFUSED by the network (%s); the hold should never have been placed. Closed and reversed by migration 0032, from the verdict retained in webhook_inbox.',
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
                 -- Decimal STRING, exactly as postEntry() does: bigint
                 -- cents must not go anywhere near a JSON number.
                 'amount_cents', (-l.amount_cents)::text,
                 'currency',     l.currency,
                 'memo',         l.memo)
               ORDER BY l.ordinal)
        INTO v_lines
        FROM journal_line l
       WHERE l.entry_id = v_entry.id;

      CONTINUE WHEN v_lines IS NULL;

      PERFORM ledger_append(
        v_entry.entity_id,
        v_entry.value_date,          -- THE ORIGINAL DATE. The whole point.
        v_entry.book,
        'reversal'::entry_type,
        format('Reversal of %s: the authorisation was refused by the network, so no money may be withheld against it (migration 0032)', v_entry.id),
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

  RAISE NOTICE '0032: repaired % hold(s) with % reversal entr(ies); % cents returned to customers',
    v_holds, v_rev, v_cents;
END $$;


-- ---------------------------------------------------------------------
-- 4.  0025's invariant, which nothing has ever run
-- ---------------------------------------------------------------------
--
-- `v_wire_availability_drift` was created by 0025 under the heading "the
-- proof that availability is immediate, as a view that must be empty",
-- and it was never added to `scripts/dbcheck.mjs`.  0023 already wrote
-- down what that is worth: "a view that is asserted to be empty and never
-- queried is a comment."  The same sentence was written about 0022's
-- `v_balance_definition_drift`, which sat unqueried for a day, and about
-- 0026 and 0028.  Four times is a habit, not an oversight, so the claim
-- is being attached to the object itself where the next reader will find
-- it, and `dbcheck` runs it from this migration forward.
--
-- The view ranges over uncleared-credit holds that have a wire-rail memo
-- entry, and it reports the ones whose money became spendable LATER than
-- the instant it was credited.  It is capable of returning a row against
-- this database -- proved by construction in `scripts/dbcheck.mjs`, which
-- makes it fail on purpose in a rolled-back transaction.

COMMENT ON VIEW v_wire_availability_drift IS
  'MUST BE EMPTY. One row per uncleared-credit hold from a wire credit whose money became spendable LATER than the moment it was booked -- on this rail ledger and available move together, and a row here means the wire funds-availability policy, the rail the credit chose, or the value date it was booked with is wrong. Nothing repairs what it reports: append a correcting entry, never an UPDATE. Wired into scripts/dbcheck.mjs by 0032; it was created by 0025 and never queried.';


-- ---------------------------------------------------------------------
-- 5.  Prove the repairable half, and NAME the half that is not
-- ---------------------------------------------------------------------
--
-- 0026 asserted all three views were empty and refused to commit
-- otherwise.  This one cannot make that assertion honestly, so it makes
-- the one it can: every hold whose refusal is PROVEN is repaired, the two
-- fold invariants are still clean after the repair, and the unanswered
-- remainder is printed with the money it withholds rather than quietly
-- surviving inside a green migration.
--
-- If the repair were to break either fold invariant the whole migration
-- rolls back, which is the only acceptable outcome for a migration that
-- moves money.

DO $$
DECLARE
  v_refused    int;
  v_unanswered int;
  v_cents      bigint;
  v_live       int;
  v_rel        int;
BEGIN
  SELECT count(*) INTO v_refused
    FROM v_refused_auth_hold WHERE verdict = 'refused';
  SELECT count(DISTINCT hold_id), COALESCE(sum(active_hold_cents), 0)
    INTO v_unanswered, v_cents
    FROM (SELECT DISTINCT hold_id, active_hold_cents
            FROM v_refused_auth_hold WHERE verdict = 'unanswered') u;
  SELECT count(*) INTO v_live FROM v_hold_drift;
  SELECT count(*) INTO v_rel  FROM v_hold_release_drift;

  IF v_refused <> 0 OR v_live <> 0 OR v_rel <> 0 THEN
    RAISE EXCEPTION
      '0032 refuses to commit: v_refused_auth_hold(refused)=% v_hold_drift=% v_hold_release_drift=% (all three must be 0)',
      v_refused, v_live, v_rel;
  END IF;

  RAISE NOTICE '0032: every PROVEN refusal is repaired; v_hold_drift and v_hold_release_drift are empty';
  RAISE NOTICE '0032: % hold(s) remain UNANSWERED, withholding % cents on authorisations nobody can show were approved. pnpm db:check will report this and it is not to be tuned away.',
    v_unanswered, v_cents;
END $$;
