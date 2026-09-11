-- 0044_team_author_removed.sql
--
-- BEING REMOVED FROM A TEAM DOES NOT FAIL THE AUTHORSHIP CHECK. IT PASSES IT.
--
-- `docs/TEST-AUDIT.md` §1 reports it and proves it twice on this database.
-- This migration is the repair.
--
-- ---------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------
--
-- Two functions in 0033 establish the author's authority with the same
-- lookup and the same gate:
--
--   0033:309-322  assert_team_member_version(), clause (d)
--   0033:818-831  team_add_member()
--
--     SELECT tmc.role INTO v_author
--       FROM team_member tm
--       JOIN v_team_member_current tmc ON tmc.member_id = tm.id
--      WHERE tm.business_id = ...
--        AND tm.actor_id    = <the author>
--        AND tmc.state <> 'removed'        -- <<<< HERE
--      ORDER BY tm.membership_seq DESC
--      LIMIT 1;
--
--     IF v_author IS NOT NULL AND NOT team_role_can(v_author, 'administer_team') THEN
--       RAISE EXCEPTION ...
--
-- `v_author IS NULL` is the CORGI-STAFF BREAK-GLASS BRANCH, and 0033 says
-- so at :250-252 and :817 -- "an admin of this business, or Corgi staff".
-- Staff carry `business_id IS NULL`, match no `team_member` row, and are
-- therefore correctly waved through.
--
-- But `AND tmc.state <> 'removed'` makes the lookup ALSO return NULL for a
-- removed member OF THIS VERY BUSINESS. Removal does not fail the check.
-- It moves the actor out of the branch that CHECKS and into the branch
-- that TRUSTS. What the lookup excludes from itself is exactly the
-- population it exists to stop.
--
-- The code could not tell "no such member" from "a member who was
-- removed", because it asked one question -- `role` -- and threw the
-- second fact away inside the WHERE clause. Those are different facts and
-- they deserve opposite answers.
--
-- Proven against this database, each inside a transaction that ended by
-- throwing (docs/TEST-AUDIT.md §1, and again in this migration's own
-- proofs in docs/TEAM.md §11):
--
--   (a) a REMOVED admin of Ridgeline authored a promotion of another
--       member to `admin`;
--   (b) a REMOVED admin called team_add_member() and minted a NEW ACTIVE
--       APPROVER with actor.can_approve = true -- manufacturing the
--       second pair of eyes that maker-checker rests on.
--
-- (b) is the one that matters. `actor.can_approve` is decided ONCE, at
-- creation, inside team_add_member(), and `actor` is append-only -- 0033
-- refuses every later widening and says why. So a removed admin does not
-- merely edit a row: they mint a fresh approving principal. Removal is
-- meant to be the remedy for a compromised signer. Here it was the
-- qualification.
--
-- ---------------------------------------------------------------------
-- THE FIX, AND WHY IT IS THE SHAPE 0033 ALREADY USES ELSEWHERE
-- ---------------------------------------------------------------------
--
-- The state filter comes OUT of the lookup and becomes a REFUSAL. The
-- lookup now answers both questions -- "is this actor a member of this
-- business at all" (FOUND) and "what is their state and role" -- and the
-- gate reads:
--
--     IF FOUND THEN                       -- they ARE a member here
--       IF state <> 'active' THEN RAISE   -- ... and their spell has ended
--       IF NOT administer_team  THEN RAISE
--     END IF;                             -- otherwise: no membership -> staff
--
-- This is not a new idea introduced by this migration. It is EXACTLY the
-- shape the other two triggers in 0033 already use, twenty lines apart:
--
--   assert_team_initiator()      IF NOT FOUND THEN RETURN NEW; END IF;
--                                IF v_state <> 'active' THEN RAISE
--                                  'actor % is a % member of business % and
--                                   cannot raise a payment'
--
--   assert_team_maker_checker()  v_appr_found := FOUND;
--                                IF v_appr_state <> 'active' THEN RAISE
--                                  'actor % is a % member of business % and
--                                   cannot approve payments'
--
-- Both of those got it right. The two authorship checks are the two that
-- did not, and after this migration all four read the same way: a
-- membership that is not `active` is a REFUSAL that names the state, and
-- only the genuine absence of a membership row is the staff branch.
--
-- `suspended` is refused for the same reason and by the same line. A
-- suspended admin was ALSO waved into the check in 0033 (the filter only
-- excluded `removed`, so a suspended admin resolved to `admin` and
-- passed on role alone) -- the same hole one state to the left, and
-- narrowing it costs nothing: 0033 §7 already holds that a suspended
-- member may neither raise nor approve a payment, so a suspended member
-- deciding who else may is not a position this schema takes anywhere
-- else.
--
-- ---------------------------------------------------------------------
-- WHAT DOES NOT CHANGE
-- ---------------------------------------------------------------------
--
--   * Corgi staff (business_id IS NULL, no membership row anywhere)
--     still pass. That branch is unchanged and it is reached by the same
--     condition it always was: NOT FOUND.
--   * An ACTIVE admin of the business still passes.
--   * The refusal message for a member with the wrong ROLE is WORD FOR
--     WORD what 0033 raised. Nothing that reads it has to change.
--   * Re-hiring is unaffected. `ORDER BY membership_seq DESC LIMIT 1`
--     already selected the newest spell, and removal is terminal, so at
--     most one spell per (business, actor) is ever non-removed and it is
--     always the newest. Dropping the filter cannot make an older removed
--     spell shadow a live one.
--   * Self-removal by an active admin still works: this is a BEFORE
--     INSERT trigger, so `v_team_member_current` still reads the author's
--     PRE-INSERT terms, which are active.
--   * No grant is widened. `corgi_app` still holds SELECT and only SELECT
--     on `actor`, which `approvals.integration.test.ts` asserts by trying.
--
-- Both functions are REPLACED rather than edited: 0033 is applied and
-- hashed, and `scripts/migrate.mjs` refuses a file whose contents changed
-- after the fact. `CREATE OR REPLACE FUNCTION` is ordinary DDL, it keeps
-- the OID and therefore the ACL, and it runs inside this migration's
-- transaction like every other statement. It does NOT keep `proconfig`,
-- so `SET search_path = public, pg_temp` is restated in both bodies
-- below rather than assumed -- a SECURITY DEFINER function that loses its
-- search_path is a privilege escalation, not a cosmetic regression, and
-- the verification at the bottom of this file reads `proconfig`,
-- `prosecdef` and `proacl` back and RAISES if any of the three moved.


-- ---------------------------------------------------------------------
-- 1.  assert_team_member_version() -- clause (d), authorship
-- ---------------------------------------------------------------------
--
-- Clauses (a) contiguity, (b) terminality and (c) the approval envelope
-- are reproduced BYTE FOR BYTE from 0033. Only (d) changes.

CREATE OR REPLACE FUNCTION assert_team_member_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_prev          team_member_version%ROWTYPE;
  v_member        team_member%ROWTYPE;
  v_actor         actor%ROWTYPE;
  -- Scalars and an explicit FOUND, for the reason assert_team_maker_checker()
  -- states in 0033: a single `v_author text` cannot distinguish "no row" from
  -- "a row whose role happened to be NULL", and THAT conflation is this
  -- migration's whole subject.
  v_author_found  boolean := false;
  v_author_role   text;
  v_author_state  text;
BEGIN
  SELECT * INTO v_member FROM team_member WHERE id = NEW.member_id;
  SELECT * INTO v_actor  FROM actor       WHERE id = v_member.actor_id;

  SELECT * INTO v_prev
    FROM team_member_version
   WHERE member_id = NEW.member_id
   ORDER BY version DESC
   LIMIT 1;

  -- (a) contiguity
  IF v_prev.id IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION
        'member % has no terms yet; the first version must be 1, not %',
        NEW.member_id, NEW.version USING ERRCODE = '55006';
    END IF;
  ELSE
    IF NEW.version <> v_prev.version + 1 THEN
      RAISE EXCEPTION
        'member % is at terms version %; the next version must be %, not %',
        NEW.member_id, v_prev.version, v_prev.version + 1, NEW.version
        USING ERRCODE = '55006';
    END IF;
    IF NEW.effective_from < v_prev.effective_from THEN
      RAISE EXCEPTION
        'member % terms version % takes effect at %, before version % at %',
        NEW.member_id, NEW.version, NEW.effective_from,
        v_prev.version, v_prev.effective_from USING ERRCODE = '55006';
    END IF;

    -- (b) terminality
    IF v_prev.state = 'removed' THEN
      RAISE EXCEPTION
        'member % was removed at %; removal is terminal. Re-adding this person is a new membership (membership_seq %), not a new version of the old one',
        NEW.member_id, v_prev.effective_from, v_member.membership_seq + 1
        USING ERRCODE = '55006';
    END IF;
  END IF;

  -- (c) the approval envelope: this table may narrow actor.can_approve,
  --     never widen it.
  IF team_role_can(NEW.role, 'approve_payment') AND NOT v_actor.can_approve THEN
    RAISE EXCEPTION
      'actor % was created without approval rights (actor.can_approve is false and actor rows are append-only), so member % cannot hold the role %. Approval rights are granted when the member is created, never afterwards',
      v_actor.id, NEW.member_id, NEW.role USING ERRCODE = '42501';
  END IF;

  -- (d) authorship.  NO state filter: the lookup asks whether this actor
  --     has a membership of this business AT ALL, and the answer decides
  --     which branch we are in.  A member whose spell has ended is a
  --     member, and is refused BY NAME.
  SELECT tmc.role, tmc.state
    INTO v_author_role, v_author_state
    FROM team_member tm
    JOIN v_team_member_current tmc ON tmc.member_id = tm.id
   WHERE tm.business_id = v_member.business_id
     AND tm.actor_id    = NEW.created_by
   ORDER BY tm.membership_seq DESC
   LIMIT 1;
  v_author_found := FOUND;

  IF v_author_found THEN
    IF v_author_state <> 'active' THEN
      RAISE EXCEPTION
        'actor % is a % member of business % and cannot change a member''s terms; only an ACTIVE admin of this business, or Corgi staff, may. A % member is not Corgi staff -- staff hold no membership of any business, and ending somebody''s membership ends their authority rather than conferring the bank''s',
        NEW.created_by, v_author_state, v_member.business_id, v_author_state
        USING ERRCODE = '42501';
    END IF;

    IF NOT team_role_can(v_author_role, 'administer_team') THEN
      -- 0033's sentence, unchanged.
      RAISE EXCEPTION
        'actor % is a % of this business and cannot change a member''s terms; administer_team is held by admin only',
        NEW.created_by, v_author_role USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION assert_team_member_version() IS
  'The four things a team_member_version must satisfy: contiguity, terminality, the approval envelope, and authorship. 0044 fixed authorship: a REMOVED or SUSPENDED member of this business is refused by name, and only the genuine absence of a membership row is the Corgi-staff break-glass.';


-- ---------------------------------------------------------------------
-- 2.  team_add_member() -- the same gate, the same fix
-- ---------------------------------------------------------------------
--
-- This is the more dangerous of the two, because it is the ONE MOMENT
-- `actor.can_approve` is decided. Everything else in the body is
-- reproduced byte for byte from 0033:882-900 onward; only the authorship
-- lookup and its gate change.
--
-- SECURITY DEFINER, `SET search_path` and the signature (including the
-- three DEFAULT NULLs) are restated exactly, because CREATE OR REPLACE
-- rebuilds the pg_proc row from what it is given.

CREATE OR REPLACE FUNCTION team_add_member(
  p_business_id         uuid,
  p_display_name        text,
  p_email               text,
  p_role                text,
  p_created_by          uuid,
  p_note                text,
  p_per_txn_limit_cents bigint DEFAULT NULL,
  p_daily_limit_cents   bigint DEFAULT NULL,
  p_monthly_limit_cents bigint DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_id      uuid;
  v_member_id     uuid;
  v_seq           integer;
  v_prev_seq      integer;
  v_prev_state    text;
  v_prev_found    boolean;
  v_author_found  boolean := false;
  v_author_role   text;
  v_author_state  text;
  v_email         text := lower(btrim(p_email));
BEGIN
  IF NOT EXISTS (SELECT 1 FROM business WHERE id = p_business_id) THEN
    RAISE EXCEPTION 'no such business: %', p_business_id USING ERRCODE = '23503';
  END IF;
  IF p_role NOT IN ('viewer','initiator','approver','admin') THEN
    RAISE EXCEPTION 'unknown role: %', p_role USING ERRCODE = '22023';
  END IF;
  IF v_email IS NULL OR v_email = '' OR position('@' in v_email) = 0 THEN
    RAISE EXCEPTION 'a member needs an email address; got %', quote_literal(p_email)
      USING ERRCODE = '22023';
  END IF;
  IF btrim(COALESCE(p_note,'')) = '' THEN
    RAISE EXCEPTION 'a membership needs a note saying why it exists' USING ERRCODE = '22023';
  END IF;

  -- Authorship: an ACTIVE admin of this business, or Corgi staff.
  -- No state filter -- see the header. A removed admin used to land in the
  -- staff branch and mint a new approving principal from inside it.
  SELECT c.role, c.state
    INTO v_author_role, v_author_state
    FROM team_member tm
    JOIN v_team_member_current c ON c.member_id = tm.id
   WHERE tm.business_id = p_business_id
     AND tm.actor_id    = p_created_by
   ORDER BY tm.membership_seq DESC
   LIMIT 1;
  v_author_found := FOUND;

  IF v_author_found THEN
    IF v_author_state <> 'active' THEN
      RAISE EXCEPTION
        'actor % is a % member of business % and cannot add members; only an ACTIVE admin of this business, or Corgi staff, may. A % member is not Corgi staff -- and adding a member is the one moment actor.can_approve is decided, so this door is how a removed signer would mint their own second pair of eyes',
        p_created_by, v_author_state, p_business_id, v_author_state
        USING ERRCODE = '42501';
    END IF;

    IF NOT team_role_can(v_author_role, 'administer_team') THEN
      -- 0033's sentence, unchanged.
      RAISE EXCEPTION
        'actor % is a % of this business and cannot add members',
        p_created_by, v_author_role USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM actor WHERE id = p_created_by AND kind = 'human') THEN
    RAISE EXCEPTION
      'a member is added by a person: actor % is not a human actor', p_created_by
      USING ERRCODE = '42501';
  END IF;

  -- One principal per person per business.
  SELECT id INTO v_actor_id
    FROM actor
   WHERE business_id = p_business_id AND lower(email) = v_email
   LIMIT 1;

  IF v_actor_id IS NULL THEN
    INSERT INTO actor (kind, display_name, email, business_id, can_approve)
    VALUES ('human', p_display_name, v_email, p_business_id,
            team_role_can(p_role, 'approve_payment'))
    RETURNING id INTO v_actor_id;
    v_seq := 1;
  ELSE
    SELECT tm.membership_seq, c.state
      INTO v_prev_seq, v_prev_state
      FROM team_member tm
      JOIN v_team_member_current c ON c.member_id = tm.id
     WHERE tm.business_id = p_business_id AND tm.actor_id = v_actor_id
     ORDER BY tm.membership_seq DESC
     LIMIT 1;
    v_prev_found := FOUND;

    IF NOT v_prev_found THEN
      v_seq := 1;
    ELSIF v_prev_state <> 'removed' THEN
      RAISE EXCEPTION
        '% is already a % member of this business', v_email, v_prev_state
        USING ERRCODE = '23505';
    ELSE
      v_seq := v_prev_seq + 1;
    END IF;

    -- Re-hiring cannot widen approval rights either: the actor row is
    -- the one they already had.
    IF team_role_can(p_role, 'approve_payment')
       AND NOT (SELECT can_approve FROM actor WHERE id = v_actor_id) THEN
      RAISE EXCEPTION
        'actor % was created without approval rights and actor rows are append-only, so they cannot return as %',
        v_actor_id, p_role USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO team_member (business_id, actor_id, membership_seq)
  VALUES (p_business_id, v_actor_id, v_seq)
  RETURNING id INTO v_member_id;

  INSERT INTO team_member_version (
    member_id, version, state, role,
    per_txn_limit_cents, daily_limit_cents, monthly_limit_cents,
    note, created_by
  ) VALUES (
    v_member_id, 1, 'active', p_role,
    p_per_txn_limit_cents, p_daily_limit_cents, p_monthly_limit_cents,
    p_note, p_created_by
  );

  RETURN v_member_id;
END $$;

COMMENT ON FUNCTION team_add_member(uuid, text, text, text, uuid, text, bigint, bigint, bigint) IS
  'The only path that creates a member, and the only moment actor.can_approve is decided. 0044 fixed authorship: a REMOVED or SUSPENDED member of this business is refused by name rather than falling through into the Corgi-staff branch.';

-- The ACL survives CREATE OR REPLACE (the OID is unchanged), and the
-- verification block below asserts that rather than trusting it. Restated
-- anyway so this file alone describes who may call it.
GRANT EXECUTE ON FUNCTION team_add_member(uuid, text, text, text, uuid, text, bigint, bigint, bigint)
  TO corgi_app;


-- ---------------------------------------------------------------------
-- 3.  THE INVARIANT
-- ---------------------------------------------------------------------
--
-- MUST RETURN ZERO ROWS.
--
-- WHY IT IS A NEW VIEW AND NOT A WIDENING OF AN EXISTING ONE.
--
-- `v_member_approval_without_right` was the obvious candidate and it is
-- the wrong one. It ranges over `payment_instruction_event` and asks who
-- APPROVED A PAYMENT. The state this defect produces is a row in
-- `team_member_version` -- a change to somebody's ROLE, STATE or LIMITS,
-- or a whole new membership -- and no amount of widening will make a view
-- over payment approvals see a table it does not read. Worse, the damage
-- from (b) above is INVISIBLE to it by construction: the minted approver
-- is `active`, holds `approver`, and their approvals are therefore
-- perfectly legitimate at the moment they are filed. The fraud is one
-- level up, in who put them there.
--
-- So this is a sibling, on the table where the defect actually lands.
--
-- HISTORICALLY EXACT, the same way `v_member_approval_without_right` is:
-- the author's terms are the ones in force AT THE INSTANT THE VERSION WAS
-- WRITTEN, not their terms today. An admin who wrote a version on Monday
-- and was removed on Friday is NOT a violation and must never be reported
-- as one -- otherwise removing anybody would retroactively indict every
-- change they ever made, the guard would be permanently red, and a
-- permanently red guard is a guard nobody reads.
--
-- `created_at <= tmv.created_at ORDER BY version DESC` and not
-- `effective_from`, deliberately: the FUNCTION reads
-- `v_team_member_current`, which is the newest VERSION regardless of when
-- it takes effect. The view has to ask the question the gate asked, or the
-- two disagree and only one of them is enforcing anything.
--
-- INNER lateral, so an author with NO membership of that business is
-- absent from this view entirely. That is the Corgi-staff break-glass and
-- it is correct: staff authored all 275 versions on this book.
--
-- WIDER than the defect, on 0043's argument: it reports every version
-- written by a member of that business who was not an ACTIVE holder of
-- `administer_team` at the time -- removed, suspended, or simply the
-- wrong role. Narrowing it to `state = 'removed'` would be an exclusion
-- shaped like the failure, which is the sentence this whole finding is
-- about.

CREATE VIEW v_team_terms_by_unauthorised_author AS
SELECT tmv.id                AS member_version_id,
       tmv.member_id,
       tm.business_id,
       tmv.version,
       tmv.state             AS terms_state,
       tmv.role              AS terms_role,
       tmv.created_at,
       tmv.created_by        AS author_actor_id,
       author.author_member_id,
       author.state          AS author_state_at_write,
       author.role           AS author_role_at_write
  FROM team_member_version tmv
  JOIN team_member tm ON tm.id = tmv.member_id
  JOIN LATERAL (
        SELECT atm.id AS author_member_id, v.state, v.role
          FROM team_member atm
          JOIN team_member_version v ON v.member_id = atm.id
         WHERE atm.business_id = tm.business_id
           AND atm.actor_id    = tmv.created_by
           AND v.created_at   <= tmv.created_at
         ORDER BY atm.membership_seq DESC, v.version DESC
         LIMIT 1
       ) author ON true
 WHERE author.state <> 'active'
    OR NOT team_role_can(author.role, 'administer_team');

COMMENT ON VIEW v_team_terms_by_unauthorised_author IS
  'MUST BE EMPTY. A team_member_version written by somebody who, at the instant they wrote it, was a member of that business without being an ACTIVE holder of administer_team. Actors with no membership of the business are Corgi staff and are not in the population. This is the guard on 0044.';

GRANT SELECT ON v_team_terms_by_unauthorised_author TO corgi_app;


-- ---------------------------------------------------------------------
-- 4.  VERIFY RATHER THAN ASSUME
-- ---------------------------------------------------------------------
--
-- CREATE OR REPLACE FUNCTION is ordinary DDL and it keeps the OID, so the
-- ACL and every dependency survive. `proconfig` does NOT survive, which
-- is why `SET search_path` is restated in both bodies above. None of that
-- is worth believing on the strength of a paragraph, so this migration
-- reads the catalogue back and aborts its own transaction if any of it is
-- untrue. It also refuses to leave a book behind that the new invariant
-- already reports.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.proname, p.prosecdef, p.proconfig, p.proacl::text AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('assert_team_member_version','team_add_member')
  LOOP
    IF r.proconfig IS DISTINCT FROM ARRAY['search_path=public, pg_temp'] THEN
      RAISE EXCEPTION '0044: %() lost its search_path: %', r.proname, r.proconfig;
    END IF;
    IF r.proname = 'team_add_member' THEN
      IF NOT r.prosecdef THEN
        RAISE EXCEPTION '0044: team_add_member() is no longer SECURITY DEFINER';
      END IF;
      IF r.acl IS NULL OR r.acl NOT LIKE '%corgi_app=X%' THEN
        RAISE EXCEPTION '0044: corgi_app lost EXECUTE on team_add_member(): %', r.acl;
      END IF;
    END IF;
  END LOOP;

  -- The trigger still points at the replaced function, by name and by OID.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgname = 'team_member_version_chain'
       AND p.proname = 'assert_team_member_version'
  ) THEN
    RAISE EXCEPTION '0044: team_member_version_chain no longer calls assert_team_member_version()';
  END IF;

  PERFORM 1 FROM v_team_terms_by_unauthorised_author LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION
      '0044: the new invariant is NOT empty on this book -- % row(s). A guard must not be shipped red',
      (SELECT count(*) FROM v_team_terms_by_unauthorised_author);
  END IF;
END $$;
