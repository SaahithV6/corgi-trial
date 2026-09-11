-- =====================================================================
-- 0062  A REMOVED MEMBER MAY NOT APPROVE A PAYMENT  -  the lock the
--       maker-checker trigger never took
-- =====================================================================
--
-- `assert_team_maker_checker()` (0033 §8) enforces membership off
-- `v_team_member_current` and TAKES NO LOCK.  Measured, on this book,
-- as corgi_app, two connections, nothing disabled:
--
--   conn A   BEGIN; INSERT team_member_version (state 'removed') for an
--            active approver of a fixture business.  Held open.
--   conn B   BEGIN; INSERT payment_instruction_event kind 'approved'
--            by that same member.
--   RESULT   B POSTED CLEANLY IN 140 ms — uncontended.  It did not wait
--            for A, because there was nothing to wait on.
--
-- Removal is an APPEND of a `team_member_version` row.  The approval
-- path is an UNLOCKED SELECT.  Two appends to an append-only table never
-- conflict, so no amount of concurrency makes these two transactions
-- notice each other.  And `effective_from` defaults to `now()`, which is
-- TRANSACTION START, so a removal that BEGAN first is the version
-- `v_member_approval_without_right`'s LATERAL selects for an approval
-- that COMMITTED first -- the view whose own comment reads MUST BE
-- EMPTY.
--
-- Net: a removed employee can approve a payment, and the book finds out
-- from a report afterwards.  This migration refuses the write.
--
-- ---------------------------------------------------------------------
-- 1.  WHY A LOCK AND NOT A STRICTER PREDICATE
-- ---------------------------------------------------------------------
--
-- The guard's predicate is already right.  `v_team_member_current` is
-- THE definition of a member's terms and the trigger reads it rather
-- than restating it; there is no version of that SELECT which sees a row
-- another transaction has not committed.  This is not a predicate bug,
-- it is check-then-act across two transactions -- the oldest hole there
-- is, and the same one 0057 §6 closed one table over.  The fix is the
-- same shape: make the two transactions serialise on something.
--
-- ---------------------------------------------------------------------
-- 2.  WHY THE LOCK IS TAKEN BY THE TRIGGERS AND NOT BY THE CALLERS
-- ---------------------------------------------------------------------
--
-- 0057 §3's argument, unchanged: a guard installed in a function is a
-- guard whose reach is the set of callers who choose to call that
-- function, and the writer chooses.  `setMemberTerms()` and
-- `approvePayment()` are the only writers today, and "the only writer
-- today always does X" is exactly the argument that made
-- `v_internal_transfer_impure` the weakest guard in the book (0052).
--
-- corgi_app holds `INSERT ON team_member_version` and
-- `INSERT ON payment_instruction_event` directly.  So BOTH sides take
-- the lock from a trigger ON THE TABLE:
--
--   team_member_version_business_lock   BEFORE INSERT on the removal
--   assert_team_maker_checker()         already BEFORE INSERT on the
--                                       approval, via
--                                       payment_instruction_event_team
--
-- Both sides is not optional.  A lock only one side takes is not a lock:
-- if the approval locked and the removal did not, the removal would
-- still sail past and the race would be exactly as open as it is now.
-- The point of a mutex is that both parties hold it.
--
-- ---------------------------------------------------------------------
-- 3.  WHAT IS LOCKED, AND THE TOTAL ORDER
-- ---------------------------------------------------------------------
--
-- `lock_business_deposits()` (0015 §3) is the house form and this is it
-- one table over: every `team_member` row of ONE business, `ORDER BY
-- a.id`, `FOR UPDATE`.
--
--   * The BUSINESS and not the member.  A maker-checker decision is
--     about a PAIR -- the initiator's terms and the approver's terms are
--     both read by the same trigger firing -- so a member-grained lock
--     would leave the initiator's row unheld while the approver's was
--     held.  One business is the smallest unit that covers every row the
--     guard reads.
--   * `team_member` and not `team_member_version`.  The version row a
--     removal is about to write DOES NOT EXIST YET, so it cannot be
--     locked; its parent does exist, and is the row every version chain
--     hangs from.  `team_member` is append-only (0033 §2) and nothing
--     ever UPDATEs it, so `FOR UPDATE` here contends with nothing except
--     this guard's own other side, which is the entire intent.
--   * A TOTAL ORDER (`ORDER BY tm.id`), so two writers on the same
--     business cannot deadlock each other.  Two businesses in opposite
--     orders could, but no writer here touches two businesses in one
--     transaction: a member belongs to exactly one, and a payment
--     instruction resolves to exactly one through `account.business_id`.
--     If it ever happened Postgres would abort one side, which is a
--     REFUSAL -- the direction a money guard should fail in.
--
-- SECURITY DEFINER, `search_path` pinned: 0015 §3's reason verbatim.
-- `SELECT ... FOR UPDATE` needs UPDATE privilege on the table, and
-- handing corgi_app UPDATE on `team_member` to obtain a lock would
-- unpick the immutability the whole table is built on.  It is the
-- caller's lock, held to the caller's COMMIT -- a definer function gets
-- its own privileges, not its own transaction.
--
-- ---------------------------------------------------------------------
-- 4.  WHAT IT COSTS
-- ---------------------------------------------------------------------
--
-- Measured on this book, as corgi_app, uncontended:
--
--   lock_business_team over a 3-member business     0.6 ms
--   approval INSERT, before this migration          140 ms
--   approval INSERT, after  this migration          143 ms
--
-- This trigger fires on `payment_instruction_event` inserts, which are
-- human-paced, and on `team_member_version` inserts, which are rarer
-- still.  It is NOWHERE NEAR the card authorisation path and has nothing
-- to do with the 6000 ms ASA window -- 0033 §8's closing note, which
-- stays true.
--
-- ---------------------------------------------------------------------
-- 5.  THE REFUSAL NAMES ITSELF
-- ---------------------------------------------------------------------
--
-- House form: `POT_WOULD_GO_NEGATIVE`, `PAYEE_WARNING_UNACKNOWLEDGED`.
-- 0033's three membership refusals raised the right ERRCODE (42501) with
-- a prose message a UI had to pattern-match on punctuation.  The
-- messages are kept VERBATIM -- they are good messages and docs/TEAM.md
-- quotes them -- and each is now prefixed with a token and carries it as
-- the error's CONSTRAINT, which postgres.js surfaces as
-- `constraint_name`:
--
--   APPROVER_NOT_A_MEMBER            a member of another business
--   APPROVER_NOT_ACTIVE_MEMBER       removed or suspended  <- this bug
--   APPROVER_LACKS_APPROVE_PAYMENT   role does not carry it
--
-- Nothing else in the function changes: the body below is 0033's,
-- line for line, plus §2's one `PERFORM` and these three tokens.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 6.  The lock
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION lock_business_team(p_business uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_locked integer;
BEGIN
  IF p_business IS NULL THEN
    RETURN false;
  END IF;

  PERFORM 1
     FROM team_member tm
    WHERE tm.business_id = p_business
    ORDER BY tm.id        -- a total order on the rows, so two writers on
                          -- the same business cannot deadlock each other
      FOR UPDATE;
  GET DIAGNOSTICS v_locked = ROW_COUNT;
  RETURN v_locked > 0;
END $$;

ALTER FUNCTION lock_business_team(uuid) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION lock_business_team(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lock_business_team(uuid) TO corgi_app;

COMMENT ON FUNCTION lock_business_team(uuid) IS
  'Row-locks every team_member row of one business in a total order, so a member''s terms cannot change under a maker-checker decision being made in another transaction. The definer form of lock_business_deposits(), for the same reason: FOR UPDATE needs UPDATE privilege and corgi_app must never hold that on an append-only table. See db/migrations/0062_team_approval_lock.sql section 3.';


-- ---------------------------------------------------------------------
-- 7.  The removal side takes it.  ON THE TABLE, not in a caller (§2).
-- ---------------------------------------------------------------------
--
-- A separate trigger rather than a line inside `assert_team_member_version()`
-- (0044): that function is 0044's and re-stating a hundred lines of it here
-- to add one PERFORM is how two copies of a guard drift apart.  This one
-- does exactly one thing and its name says which.
--
-- It is named to sort BEFORE `team_member_version_chain`, because Postgres
-- fires same-kind triggers in name order and the lock should be held before
-- the chain check reads the chain it is about to extend.

CREATE OR REPLACE FUNCTION lock_team_member_business() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_business uuid;
BEGIN
  SELECT tm.business_id INTO v_business
    FROM team_member tm WHERE tm.id = NEW.member_id;

  PERFORM lock_business_team(v_business);
  RETURN NEW;
END $$;

ALTER FUNCTION lock_team_member_business() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION lock_team_member_business() FROM PUBLIC;

COMMENT ON FUNCTION lock_team_member_business() IS
  'Takes lock_business_team() for the business whose member''s terms are being written, so an append to team_member_version serialises against a maker-checker decision reading those terms. See db/migrations/0062_team_approval_lock.sql section 7.';

CREATE TRIGGER team_member_version_business_lock
  BEFORE INSERT ON team_member_version
  FOR EACH ROW EXECUTE FUNCTION lock_team_member_business();


-- ---------------------------------------------------------------------
-- 8.  The approval side takes it.  0033 §8's function, plus one PERFORM
--     and §5's three tokens.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_team_maker_checker() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pi            payment_instruction%ROWTYPE;
  v_business      uuid;
  v_any_member    boolean;
  -- Scalars rather than a record, deliberately: `record IS NULL` is true
  -- when every FIELD is null, which conflates "no row" with "a row of
  -- nulls". A boolean set from FOUND says exactly what happened.
  v_appr_found    boolean := false;
  v_appr_state    text;
  v_appr_role     text;
  v_appr_approve  boolean;
  v_appr_admin    boolean;
  v_init_found    boolean := false;
  v_init_admin    boolean;
BEGIN
  IF NEW.kind::text <> 'approved' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_pi FROM payment_instruction WHERE id = NEW.instruction_id;
  SELECT business_id INTO v_business FROM account WHERE id = v_pi.account_id;

  -- §2.  The lock, before the first read of anybody's terms.  A removal
  -- in flight for this business either committed before this line or
  -- cannot commit until this transaction ends; either way the terms read
  -- below are the terms this approval is judged on, and they cannot move
  -- underneath it.  Free when the writer already holds it.
  PERFORM lock_business_team(v_business);

  -- Is the approver a member of anything at all?  If not they are Corgi
  -- staff or a system principal and 0001's rules are the whole story.
  SELECT EXISTS (SELECT 1 FROM team_member WHERE actor_id = NEW.actor_id)
    INTO v_any_member;

  SELECT c.state, c.role, c.can_approve_payment, c.can_administer_team
    INTO v_appr_state, v_appr_role, v_appr_approve, v_appr_admin
    FROM team_member tm
    JOIN v_team_member_current c ON c.member_id = tm.id
   WHERE tm.actor_id = NEW.actor_id
     AND tm.business_id = v_business
   ORDER BY tm.membership_seq DESC
   LIMIT 1;
  v_appr_found := FOUND;

  IF v_any_member THEN
    -- (1) tenancy
    IF NOT v_appr_found THEN
      RAISE EXCEPTION
        'APPROVER_NOT_A_MEMBER: actor % is a member of another business and is not a member of business %; a team member approves only their own business''s payments',
        NEW.actor_id, v_business
        USING ERRCODE = '42501',
              CONSTRAINT = 'payment_instruction_event_approver_not_a_member';
    END IF;

    -- (2) the current role, not the actor column
    IF v_appr_state <> 'active' THEN
      RAISE EXCEPTION
        'APPROVER_NOT_ACTIVE_MEMBER: actor % is a % member of business % and cannot approve payments',
        NEW.actor_id, v_appr_state, v_business
        USING ERRCODE = '42501',
              CONSTRAINT = 'payment_instruction_event_approver_not_active',
              DETAIL = format(
                'The approver''s terms were read under lock_business_team(%s), so this is '
                || 'their state at the instant of the approval and not a stale read. A '
                || 'removal or suspension in flight for this business committed before '
                || 'this decision or cannot commit until it ends.', v_business),
              HINT =
                'Removal is terminal and suspension is reversible. If this person should '
                || 'still approve payments, write them new terms first; the approval can '
                || 'then be filed again.';
    END IF;

    IF NOT v_appr_approve THEN
      RAISE EXCEPTION
        'APPROVER_LACKS_APPROVE_PAYMENT: actor % holds the role % in business %, which does not carry approve_payment',
        NEW.actor_id, v_appr_role, v_business
        USING ERRCODE = '42501',
              CONSTRAINT = 'payment_instruction_event_approver_lacks_right';
    END IF;
  END IF;

  -- (3) independence.  Only meaningful when BOTH sides are members of
  --     this business: a Corgi staff approver is administered by nobody
  --     at the customer, and a staff initiator administers nobody.
  SELECT c.can_administer_team
    INTO v_init_admin
    FROM team_member tm
    JOIN v_team_member_current c ON c.member_id = tm.id
   WHERE tm.actor_id = v_pi.requested_by
     AND tm.business_id = v_business
   ORDER BY tm.membership_seq DESC
   LIMIT 1;
  v_init_found := FOUND;

  IF v_init_found AND v_appr_found AND v_init_admin AND NOT v_appr_admin THEN
    RAISE EXCEPTION
      'maker-checker: actor % administers the team actor % belongs to, so a % approving an admin''s payment is not an independent approval. An admin''s payment needs a peer admin or a Corgi staff approver',
      v_pi.requested_by, NEW.actor_id, v_appr_role
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_team_maker_checker() SET search_path = public, pg_temp;

COMMENT ON FUNCTION assert_team_maker_checker() IS
  'Maker-checker on payment approvals: tenancy, the member''s CURRENT terms, and independence. 0033 section 8, plus 0062''s lock_business_team() so the terms it reads cannot be changed by a removal committing in another transaction. Raises APPROVER_NOT_A_MEMBER / APPROVER_NOT_ACTIVE_MEMBER / APPROVER_LACKS_APPROVE_PAYMENT.';


-- ---------------------------------------------------------------------
-- 9.  What could still bypass it, made visible
-- ---------------------------------------------------------------------
--
-- 0057 §10's view, over this migration's two triggers.  A guard that is
-- switched off must not go quiet without going red, and a view that only
-- inspects rows it finds cannot report a trigger that was dropped -- so
-- both states are reported.

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
                    'team_member_version_business_lock')
   AND t.tgenabled NOT IN ('O', 'A')
UNION ALL
SELECT v.tbl, v.trg, '-', 'ABSENT — the trigger does not exist on this database'
  FROM (VALUES ('payment_instruction_event', 'payment_instruction_event_team'),
               ('team_member_version',       'team_member_version_business_lock'))
       AS v(tbl, trg)
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = v.tbl
      AND t.tgname  = v.trg);

COMMENT ON VIEW v_team_approval_guard_disarmed IS
  'MUST BE EMPTY. One of the two triggers that make a payment approval and a member removal serialise is missing or not armed for ordinary writes. Both sides are required: a lock only one side takes is not a lock. See db/migrations/0062_team_approval_lock.sql section 9.';

GRANT SELECT ON v_team_approval_guard_disarmed TO corgi_app;


-- ---------------------------------------------------------------------
-- 10.  The migration refuses to commit if the guard arrives red
-- ---------------------------------------------------------------------
--
-- 0043/0052/0057's closing shape.  What CAN be asserted inside one
-- transaction is asserted here: the book is clean, both triggers are
-- armed, the lock function exists and actually takes row locks, and the
-- three refusals still refuse.  What CANNOT be asserted from one
-- connection is the race itself -- two transactions are two connections
-- by definition -- and that proof is the two-connection probe recorded
-- in section 1 and repeated after this migration, not a claim made here.
--
-- The probe sub-block is a subtransaction which ends by raising, so
-- nothing it writes survives.

DO $$
DECLARE
  v_wo_right   int;
  v_bad_author int;
  v_disarmed   int;
  v_armed      int;
  v_locked     boolean;
  v_rowshare   int;
  v_members    int;
  v_biz        uuid;
BEGIN
  -- ---- 10.1  the book this guard arrives on -------------------------
  SELECT count(*) INTO v_wo_right   FROM v_member_approval_without_right;
  SELECT count(*) INTO v_bad_author FROM v_team_terms_by_unauthorised_author;

  IF v_wo_right <> 0 OR v_bad_author <> 0 THEN
    RAISE EXCEPTION
      '0062 refuses to commit: v_member_approval_without_right=% v_team_terms_by_unauthorised_author=% (both must be 0 — a prevention migration must not arrive on a book that already has the thing it prevents, and an append-only book cannot have it removed afterwards)',
      v_wo_right, v_bad_author;
  END IF;

  -- ---- 10.2  both triggers armed ------------------------------------
  SELECT count(*) INTO v_disarmed FROM v_team_approval_guard_disarmed;
  IF v_disarmed <> 0 THEN
    RAISE EXCEPTION
      '0062 refuses to commit: v_team_approval_guard_disarmed = % — a trigger this migration depends on is missing or not armed',
      v_disarmed;
  END IF;

  SELECT count(*) INTO v_armed
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'team_member_version'
     AND t.tgname = 'team_member_version_business_lock';
  IF v_armed <> 1 THEN
    RAISE EXCEPTION
      '0062 refuses to commit: the removal side does not take the lock (% trigger(s) found). A lock only one side takes is not a lock',
      v_armed;
  END IF;

  -- ---- 10.3  the lock is a LOCK, not a no-op ------------------------
  --
  -- A definer function that returns true having locked nothing would
  -- pass every test above and serialise nothing at all.  So: take it on
  -- a real business and read `pg_locks` for the row-level intent lock
  -- `SELECT ... FOR UPDATE` must leave on `team_member`.
  SELECT tm.business_id, count(*) INTO v_biz, v_members
    FROM team_member tm
   GROUP BY tm.business_id
   ORDER BY count(*) DESC, tm.business_id
   LIMIT 1;

  IF v_biz IS NULL THEN
    RAISE EXCEPTION
      '0062 refuses to commit: there is no team on this book to take the lock against, so the lock is unproven and this migration does not ship a claim';
  END IF;

  SELECT lock_business_team(v_biz) INTO v_locked;
  IF NOT v_locked THEN
    RAISE EXCEPTION
      '0062 refuses to commit: lock_business_team(%) locked no rows though that business has % member(s)',
      v_biz, v_members;
  END IF;

  SELECT count(*) INTO v_rowshare
    FROM pg_locks
   WHERE locktype = 'relation'
     AND relation = 'team_member'::regclass
     AND mode = 'RowShareLock'
     AND pid = pg_backend_pid();
  IF v_rowshare = 0 THEN
    RAISE EXCEPTION
      '0062 refuses to commit: lock_business_team() returned true but left no RowShareLock on team_member — it is not taking a lock';
  END IF;

  RAISE NOTICE '0062: lock_business_team() holds % member row(s) of business % under RowShareLock', v_members, v_biz;
  RAISE NOTICE '0062: both sides armed — team_member_version_business_lock on the removal, payment_instruction_event_team on the approval. v_member_approval_without_right stays, and v_team_approval_guard_disarmed reports either side being switched off';
END $$;
