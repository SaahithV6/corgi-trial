-- =====================================================================
-- 0064  A REMOVAL MAY NOT BE STAMPED BEFORE A DECISION ALREADY
--       RECORDED  -  the other half of 0062's race
-- =====================================================================
--
-- 0062 closed ONE direction of the maker-checker race: a removal that
-- begins first now holds `lock_business_team()` from its BEFORE INSERT
-- trigger, so a concurrent approval blocks on it and is then refused
-- `APPROVER_NOT_ACTIVE_MEMBER`.  Measured on this book, two connections:
-- 169 ms and clean before 0062, 3,078 ms and refused after.
--
-- The OPPOSITE ORDER is still open, and 0062's own section 1 names it:
--
--   conn B   BEGIN.  `now()` is TRANSACTION START and it is pinned here.
--   conn A   BEGIN; INSERT the approval; COMMIT.  Nothing to wait on:
--            B has not written a row yet, so it holds nothing.
--   conn B   INSERT team_member_version state 'removed'.  Its
--            `effective_from` DEFAULTS to `now()` -- B's transaction
--            start -- which is EARLIER than the approval that committed
--            while B was sitting there.  COMMIT.
--
-- Measured on this book, as neondb_owner, two connections, every trigger
-- armed, before this migration (the removal rolled back rather than
-- committed -- see section 10):
--
--   conn B  BEGIN, transaction_timestamp = 2026-09-11T20:17:04.235Z
--   conn A  COMMITTED approval event 4e8449d5-… occurred_at = …:05.023Z
--   conn B  v_member_approval_without_right BEFORE the removal = 0
--   conn B  removal APPENDED version 2, effective_from = …:04.235Z
--   conn B  v_member_approval_without_right AFTER  the removal = 1
--           verdict 'member_not_active', state_at_approval 'removed'
--
-- Both writes are legal, both guards passed, and the book ends RED: an
-- approval that was correct when it was filed is retroactively an
-- approval by a removed member, in a view whose own comment reads MUST
-- BE EMPTY, on a book where nothing can be taken back out.
--
-- ---------------------------------------------------------------------
-- 1.  WHY A LOCK CANNOT CLOSE THIS ONE
-- ---------------------------------------------------------------------
--
-- 0062's lock makes the two transactions serialise, and they DID.  The
-- approval committed first, entirely; the removal then ran with the
-- approval fully visible to it.  There is no interleaving left to
-- prevent.  What is wrong is not the ORDER the two transactions ran in
-- -- it is the TIMESTAMP the second one wrote, which says the removal
-- happened before something it demonstrably happened after.
--
-- A mutex cannot fix a clock.  `effective_from` is a value on the row,
-- and the guard has to be a check ON THAT VALUE, on the removal side.
--
-- ---------------------------------------------------------------------
-- 2.  THE SEMANTICS, CHOSEN: REFUSE.  NOT RE-STAMP.
-- ---------------------------------------------------------------------
--
-- Two answers are defensible and this migration takes the first:
--
--   (A) REFUSE the write whose `effective_from` would retroactively
--       invalidate an approval that is already on the book.
--   (B) SILENTLY RE-STAMP the row at the later instant, so the approval
--       stands and the removal takes effect after it.
--
-- (B) is refused here, and the reason is that the trigger CANNOT TELL
-- THE TWO CASES APART, and they deserve opposite answers:
--
--   the RACE          `effective_from` was never chosen by anybody.  It
--                     is `now()`, the column default, off by the 788 ms
--                     conn B happened to sit open.  Re-stamping it is
--                     harmless and arguably kind.
--
--   a BACKDATED       An operator writes "she left on Monday" on
--   REMOVAL           Thursday, and there is an approval from Wednesday.
--                     That approval WAS filed by somebody who no longer
--                     held the right.  It is a genuine finding, and the
--                     red row in `v_member_approval_without_right` is
--                     the book doing its job.
--
-- Both arrive at this trigger as "a version stamped before a recorded
-- approval".  Option (B) would take the second case -- a departed
-- employee approving a payment, which is the exact event 0033, 0044 and
-- 0062 were all written about -- and move the removal quietly forward
-- until the view went green.  That is not a fix; it is laundering a
-- finding, performed by a trigger, with no row anywhere recording that
-- it happened.  A guard that turns a real red into a green is worse than
-- no guard, because the report it silences is the one somebody trusts.
--
-- The house also already answers this.  `POT_WOULD_GO_NEGATIVE` does not
-- clamp the amount to what the pot holds; `PAYEE_WARNING_UNACKNOWLEDGED`
-- does not acknowledge the warning for you.  A money guard refuses and
-- names its fix (0057 §7).  Refusal is the direction it should fail in.
--
-- AND REFUSAL IS NOT A DEAD END, which is what makes it affordable:
--
--   * For the RACE, the retry succeeds.  `setMemberTerms()` does not
--     choose `effective_from`; the next attempt's `now()` is after the
--     approval, so the operator presses Save again and the removal
--     lands.  The failure is transient exactly in the case where it is
--     an artefact.
--   * For the BACKDATED REMOVAL, the refusal hands over the event ids
--     and instructs a HUMAN to decide: either the removal genuinely
--     takes effect after those approvals -- write it so, EXPLICITLY,
--     with `effective_from` set and a `note` that says why -- or those
--     approvals should not be standing, which is a payment reversal and
--     an incident, not a timestamp.
--
-- The distinction (B) cannot make, a person can.  This refusal is how
-- the question reaches them.
--
-- NOTHING IS REWRITTEN, either way.  `team_member_version` is
-- append-only (0033 §2, `team_member_version_no_update_delete`) and
-- `effective_from` on an existing version is immutable.  This guard
-- writes nothing at all: it reads, and it raises.
--
-- ---------------------------------------------------------------------
-- 3.  THE PREDICATE IS THE VIEW.  IT IS NOT RESTATED.
-- ---------------------------------------------------------------------
--
-- The obvious implementation is to restate the clock here: "does an
-- 'approved' event exist for this member's actor on this business at or
-- after NEW.effective_from, and does NEW fail to carry the right".  It
-- is refused for 0062 §1's reason, which applies with more force here.
--
-- `v_payment_approval_judged` (0046 §2) is THE definition of whether an
-- approval stands, and it is not a small one: the spell lateral
-- (`membership_seq DESC`, because re-hiring is membership 2 and 0033
-- double-counted it), the terms lateral (`effective_from <= occurred_at`,
-- `version DESC`), `team_actor_scope()`'s six kinds of principal, and
-- the Corgi-staff exemption 0044 argues rather than inherits.  A second
-- copy of that in plpgsql would be a second definition of a member's
-- right to approve, and 0022 exists because a second definition of
-- availability drifted.
--
-- So this trigger asks the INVARIANT VIEW ITSELF, after the row is in
-- place:
--
--     SELECT ... FROM v_member_approval_without_right WHERE member_id = …
--
-- It cannot drift from the guard, because it IS the guard.  It also
-- catches, for free and without a line of its own, every shape of the
-- same mistake -- a backdated SUSPENSION, or a backdated demotion to
-- `viewer`, both of which invalidate a recorded approval exactly as a
-- removal does, and neither of which a removal-shaped predicate would
-- have seen.  The trigger is named for what it protects, not for
-- `state = 'removed'`.
--
-- ANY row for this member is a refusal, not "a row this statement
-- added".  A deferred trigger cannot see a before-picture, and it does
-- not need one: the view MUST BE EMPTY, 0062 §10.1 refused to commit
-- onto a book where it was not, and the two guards together keep it so.
-- On a book where it is already red for this member, refusing further
-- writes to that member's terms is the correct direction to fail in.
--
-- ---------------------------------------------------------------------
-- 4.  WHY IT IS DEFERRED
-- ---------------------------------------------------------------------
--
-- 0057 §4's argument, one table over: an IMMEDIATE check is
-- order-dependent, and no arrival order may be a special case.
--
-- A transaction that writes version N+1 `suspended` stamped last Monday
-- and then version N+2 `active` stamped last Tuesday ends with the
-- member active over the whole window and every approval standing -- but
-- an immediate check refuses it the instant N+1 lands, because at that
-- moment N+1 is the newest version at or before those approvals.  The
-- END STATE is clean and the middle is not.
--
-- `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`, the shape
-- `journal_line_balanced` and 0057's `pot_not_negative` already use, for
-- the identical reason: the question is only answerable once every row
-- of the transaction exists.  §10.5 proves this rather than claims it.
--
-- ---------------------------------------------------------------------
-- 5.  WHY IT IS STILL SOUND UNDER CONCURRENCY -- 0062 IS LOad-BEARING
-- ---------------------------------------------------------------------
--
-- This check reads COMMITTED approvals.  On its own that would be
-- check-then-act all over again: an approval committing between this
-- trigger's read and this transaction's commit would be missed.
--
-- It is not, and the reason is 0062.  The removal took
-- `lock_business_team()` in its BEFORE INSERT trigger, before this row
-- existed, and holds it to COMMIT.  A concurrent approval on the same
-- business takes the same lock in `assert_team_maker_checker()` and
-- therefore CANNOT commit inside this window.  So the set of approvals
-- this trigger reads at commit time is the final set.
--
-- The two migrations are one guard in two halves, and neither is
-- sufficient alone: 0062 without 0064 leaves the timestamp, 0064 without
-- 0062 leaves the window.  §9's view reports either half going dark.
--
-- ---------------------------------------------------------------------
-- 6.  SECURITY DEFINER
-- ---------------------------------------------------------------------
--
-- 0057 §6's reason verbatim.  corgi_app can read
-- `v_member_approval_without_right` today, but a guard whose reach
-- depends on the WRITER's privileges is a guard the writer narrows by
-- arriving as a role that cannot see the view -- and a SELECT that
-- cannot see rows finds none, which reads as "clean".  `search_path`
-- pinned, the house form for every definer function in this schema.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 7.  The refusal
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_terms_do_not_predate_approval() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_count   int;
  v_events  text;
  v_first   timestamptz;
BEGIN
  SELECT count(*),
         min(w.occurred_at),
         string_agg(w.event_id::text || ' (' || w.verdict || ', '
                    || to_char(w.occurred_at, 'YYYY-MM-DD"T"HH24:MI:SS.MSZ') || ')',
                    ', ' ORDER BY w.occurred_at)
    INTO v_count, v_first, v_events
    FROM v_member_approval_without_right w
   WHERE w.member_id = NEW.member_id;

  IF v_count > 0 THEN
    RAISE EXCEPTION
      'TERMS_PREDATE_RECORDED_APPROVAL: terms version % for member % takes effect at %, at or before % payment approval(s) already recorded against that member, which it retroactively invalidates',
      NEW.version, NEW.member_id, NEW.effective_from, v_count
      USING ERRCODE = '55006',
            CONSTRAINT = 'team_member_version_predates_approval',
            DETAIL = format(
              'These approvals stood when they were filed and are now judged %s by '
              || 'v_member_approval_without_right, whose comment reads MUST BE EMPTY: %s. '
              || 'The earliest is at %s. The ledger is append-only: neither those events '
              || 'nor this version''s effective_from can be edited afterwards, so the '
              || 'write is refused instead.',
              'a violation', v_events, v_first),
            HINT =
              'If this is a concurrent removal whose effective_from is only the now() '
              || 'default, simply write it again: the next attempt is stamped after those '
              || 'approvals and is accepted. If the backdating is deliberate, a person has '
              || 'to decide which of the two facts stands -- write the terms with an '
              || 'explicit effective_from after those approvals and a note saying why, or '
              || 'reverse the payments, which is an incident and not a timestamp.';
  END IF;

  RETURN NULL;   -- AFTER trigger: the return value is ignored
END $$;

ALTER FUNCTION assert_terms_do_not_predate_approval() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION assert_terms_do_not_predate_approval() FROM PUBLIC;

COMMENT ON FUNCTION assert_terms_do_not_predate_approval() IS
  'Refuses a team_member_version whose effective_from is at or before a payment approval already recorded against that member and which it would retroactively invalidate. Reads v_member_approval_without_right rather than restating its clock, so the guard cannot drift from the invariant it defends. Raises TERMS_PREDATE_RECORDED_APPROVAL. See db/migrations/0064_team_retroactive_removal.sql sections 2 and 3.';

CREATE CONSTRAINT TRIGGER team_member_version_approval_stamp
  AFTER INSERT ON team_member_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_terms_do_not_predate_approval();


-- ---------------------------------------------------------------------
-- 8.  (no change to the approval side)
-- ---------------------------------------------------------------------
--
-- `assert_team_maker_checker()` is 0062's and is not reopened here.  The
-- approval side already refuses a member who is not active AT THE
-- INSTANT IT RUNS, under the lock.  This migration adds the one thing
-- that side cannot know: what a LATER writer will claim about an
-- EARLIER instant.


-- ---------------------------------------------------------------------
-- 9.  What could still bypass it, made visible
-- ---------------------------------------------------------------------
--
-- 0062 §9's view, extended to the third trigger.  A constraint trigger
-- adds one failure mode an ordinary one does not have -- it can be armed
-- and still not fire, if somebody leaves it SET CONSTRAINTS DEFERRED and
-- never commits -- but that is not a persistent state and there is no
-- catalogue row for it; what IS reportable is absence and tgenabled, and
-- both are reported for all three triggers.

CREATE OR REPLACE VIEW v_team_approval_guard_disarmed AS
SELECT c.relname    AS table_name,
       t.tgname     AS trigger_name,
       t.tgenabled  AS enabled_flag,
       CASE t.tgenabled
         WHEN 'D' THEN 'DISABLED — an ordinary INSERT does not reach the guard'
         WHEN 'R' THEN 'REPLICA ONLY — origin writes do not reach the guard'
         ELSE 'not armed for origin writes'
       END          AS state
  FROM pg_trigger t
  JOIN pg_class   c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND t.tgname IN ('payment_instruction_event_team',
                    'team_member_version_business_lock',
                    'team_member_version_approval_stamp')
   AND t.tgenabled NOT IN ('O', 'A')
UNION ALL
SELECT v.tbl, v.trg, '-', 'ABSENT — the trigger does not exist on this database'
  FROM (VALUES ('payment_instruction_event', 'payment_instruction_event_team'),
               ('team_member_version',       'team_member_version_business_lock'),
               ('team_member_version',       'team_member_version_approval_stamp'))
       AS v(tbl, trg)
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v.tbl
      AND t.tgname  = v.trg);

COMMENT ON VIEW v_team_approval_guard_disarmed IS
  'MUST BE EMPTY. One of the THREE triggers that keep a payment approval and a member''s terms consistent is missing or not armed for ordinary writes: the lock on each side (0062, a removal in flight vs an approval in flight) and the effective_from check on the removal (0064, a removal stamped before an approval already recorded). See db/migrations/0064_team_retroactive_removal.sql section 9.';

GRANT SELECT ON v_team_approval_guard_disarmed TO corgi_app;


-- ---------------------------------------------------------------------
-- 10.  The migration refuses to commit if the guard arrives red
-- ---------------------------------------------------------------------
--
-- 0043/0052/0057/0062's closing shape, and 0062 §10.3's standing
-- instruction: PROVE THE GUARD FIRES.  A constraint trigger that exists,
-- is armed, is deferrable and never raises passes every catalogue check
-- there is and defends nothing -- the exact failure 0062 refused to
-- ship a claim about for its lock.
--
-- So the probe below actually writes the offending row, in a
-- subtransaction which ends by rolling back, and requires:
--
--   10.4  a version stamped at a recorded approval is REFUSED, with the
--         right ERRCODE and the right token;
--   10.5  the SAME version stamped after that approval is ACCEPTED --
--         the over-refusal half, without which "refuses everything"
--         would pass 10.4;
--   10.6  the trigger is genuinely DEFERRED, i.e. the offending INSERT
--         itself returns cleanly and the refusal arrives later.  10.4
--         forces it early with SET CONSTRAINTS; if that were unnecessary
--         the trigger would not be deferred and §4's argument would be a
--         comment rather than a behaviour.
--
-- Nothing the probe writes survives: each sub-block ends by raising.
-- What CANNOT be asserted from one connection is the race itself -- two
-- transactions are two connections by definition -- and that proof is
-- the two-connection run recorded in section 0 and repeated after this
-- migration, not a claim made here.

DO $$
DECLARE
  v_wo_right   int;
  v_disarmed   int;
  v_armed      int;
  v_deferred   boolean;
  v_member     uuid;
  v_role       text;
  v_state      text;
  v_next       int;
  v_at         timestamptz;
  v_author     uuid;
  v_refused    boolean := false;
  v_accepted   boolean := false;
  v_deferred_ok boolean := false;
  v_msg        text;
BEGIN
  -- ---- 10.1  the book this guard arrives on -------------------------
  SELECT count(*) INTO v_wo_right FROM v_member_approval_without_right;
  IF v_wo_right <> 0 THEN
    RAISE EXCEPTION
      '0064 refuses to commit: v_member_approval_without_right = % (must be 0 — a prevention migration must not arrive on a book that already has the thing it prevents, and an append-only book cannot have it removed afterwards)',
      v_wo_right;
  END IF;

  -- ---- 10.2  all three triggers armed -------------------------------
  SELECT count(*) INTO v_disarmed FROM v_team_approval_guard_disarmed;
  IF v_disarmed <> 0 THEN
    RAISE EXCEPTION
      '0064 refuses to commit: v_team_approval_guard_disarmed = % — a trigger this migration depends on is missing or not armed. Both halves are required: 0062''s lock closes the window, 0064''s check closes the timestamp',
      v_disarmed;
  END IF;

  -- ---- 10.3  it is a CONSTRAINT trigger and it is DEFERRED ----------
  SELECT count(*), bool_and(t.tgdeferrable AND t.tginitdeferred)
    INTO v_armed, v_deferred
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'team_member_version'
     AND t.tgname  = 'team_member_version_approval_stamp';
  IF v_armed <> 1 THEN
    RAISE EXCEPTION '0064 refuses to commit: % trigger(s) named team_member_version_approval_stamp', v_armed;
  END IF;
  IF NOT v_deferred THEN
    RAISE EXCEPTION
      '0064 refuses to commit: team_member_version_approval_stamp is not DEFERRABLE INITIALLY DEFERRED, so it judges the middle of a transaction rather than its end (section 4)';
  END IF;

  -- ---- the subject of the probe -------------------------------------
  --
  -- A member who is active, who has a recorded approval, and whose
  -- latest terms took effect at or before it — so a new version stamped
  -- AT that approval is legal on every one of 0033/0044's four clauses
  -- and fails only on this migration's.  Fixture businesses first
  -- (`ein LIKE '00-%'`), then a total order, so this lands on the same
  -- row every run and never on a customer's team.
  SELECT tm.id, c.role, c.state, c.version + 1, max(e.occurred_at)
    INTO v_member, v_role, v_state, v_next, v_at
    FROM payment_instruction_event e
    JOIN payment_instruction pi ON pi.id = e.instruction_id
    JOIN account acct           ON acct.id = pi.account_id
    JOIN business b             ON b.id = acct.business_id
    JOIN team_member tm         ON tm.actor_id = e.actor_id
                               AND tm.business_id = acct.business_id
    JOIN v_team_member_current c ON c.member_id = tm.id
   WHERE e.kind::text = 'approved'
     AND c.state = 'active'
     AND team_role_can(c.role, 'approve_payment')
   GROUP BY tm.id, c.role, c.state, c.version, b.ein
  HAVING max(e.occurred_at) >= (SELECT max(v.effective_from)
                                  FROM team_member_version v
                                 WHERE v.member_id = tm.id)
   ORDER BY (b.ein LIKE '00-%') DESC, tm.id
   LIMIT 1;

  IF v_member IS NULL THEN
    RAISE EXCEPTION
      '0064 refuses to commit: no active approver on this book has a recorded approval to stamp a removal against, so the guard is unproven and this migration does not ship a claim (0062 section 10.3)';
  END IF;

  SELECT a.id INTO v_author
    FROM actor a
   WHERE a.business_id IS NULL AND a.kind = 'human'
   ORDER BY a.id LIMIT 1;
  IF v_author IS NULL THEN
    RAISE EXCEPTION '0064 refuses to commit: no Corgi staff actor to author the probe''s terms';
  END IF;

  -- ---- 10.4  the backdated write is REFUSED -------------------------
  --
  -- The INSERT itself must return CLEANLY (that is 10.6: the check is
  -- deferred, §4), and the refusal must then arrive when the queued
  -- event is forced to fire.  `SET CONSTRAINTS … IMMEDIATE` is that
  -- force, and it is how this is demonstrated without ever attempting
  -- the commit that would leave the red row on an append-only book.
  BEGIN
    INSERT INTO team_member_version (member_id, version, effective_from, state, role, note, created_by)
    VALUES (v_member, v_next, v_at, 'removed', v_role,
            '0064 10.4 probe — refused and rolled back', v_author);
    v_deferred_ok := true;   -- the INSERT returned: the check is deferred (10.6)
    SET CONSTRAINTS team_member_version_approval_stamp IMMEDIATE;
    RAISE EXCEPTION 'PROBE_NOT_REFUSED';
  EXCEPTION
    WHEN SQLSTATE '55006' THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg NOT LIKE 'TERMS_PREDATE_RECORDED_APPROVAL:%' THEN
        RAISE EXCEPTION
          '0064 refuses to commit: the backdated write was refused, but by something else — %', v_msg;
      END IF;
      v_refused := true;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      RAISE EXCEPTION
        '0064 refuses to commit: a terms version stamped at member %''s own recorded approval (%) was NOT refused by TERMS_PREDATE_RECORDED_APPROVAL — got: %. The trigger exists and does not defend',
        v_member, v_at, v_msg;
  END;

  IF NOT v_refused THEN
    RAISE EXCEPTION '0064 refuses to commit: the backdated probe did not raise at all';
  END IF;

  -- ---- 10.6  ...and it was refused LATE, not at the INSERT ----------
  IF NOT v_deferred_ok THEN
    RAISE EXCEPTION
      '0064 refuses to commit: the refusal arrived during the INSERT statement itself, so the check is immediate and section 4''s order-independence is not true of it';
  END IF;

  -- ---- 10.5  the same write, stamped LATER, is ACCEPTED -------------
  --
  -- Without this, a trigger that refused every insert would pass 10.4.
  BEGIN
    INSERT INTO team_member_version (member_id, version, effective_from, state, role, note, created_by)
    VALUES (v_member, v_next, v_at + interval '1 millisecond', 'removed', v_role,
            '0064 10.5 probe — accepted and rolled back', v_author);
    SET CONSTRAINTS team_member_version_approval_stamp IMMEDIATE;
    v_accepted := true;
    RAISE EXCEPTION 'PROBE_ROLLBACK';
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
      IF v_msg <> 'PROBE_ROLLBACK' THEN
        RAISE EXCEPTION
          '0064 refuses to commit: a removal stamped AFTER member %''s last approval (%) was refused — %. This guard would refuse ordinary removals, which is worse than the hole it closes',
          v_member, v_at, v_msg;
      END IF;
  END;

  IF NOT v_accepted THEN
    RAISE EXCEPTION '0064 refuses to commit: the forward-stamped probe did not reach its INSERT';
  END IF;

  RAISE NOTICE '0064: member % — a removal stamped at its recorded approval % is REFUSED (TERMS_PREDATE_RECORDED_APPROVAL, deferred to the end of the transaction); the same removal stamped 1 ms later is ACCEPTED. Both rolled back', v_member, v_at;
  RAISE NOTICE '0064: three triggers armed — the lock on both sides (0062) and the effective_from check on the terms (0064). v_member_approval_without_right stays MUST BE EMPTY, and v_team_approval_guard_disarmed reports any of the three going dark';
END $$;
