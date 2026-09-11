-- =====================================================================
-- 0033  The team: members, their roles, their cards, and what happens
--       to money when one of them is removed.
-- =====================================================================
--
-- THE FIRST PARAGRAPH OF THE BRIEF, VERBATIM:
--
--   "Business current accounts. Customers hold a balance, send and
--    receive payments, and get A CARD FOR EACH PERSON ON THE TEAM."
--
-- Everything downstream of that sentence was already built -- real
-- cardholders, real virtual cards, authorisations decided inside a
-- measured 6000 ms ASA window, per-card controls versioned and pinned --
-- and the sentence's SUBJECT was not.  There were two demo personas and
-- no notion of a business having PEOPLE.  That gap is why several
-- controls in this build read thinner than they are:
--
--   * `assert_maker_checker()` already refuses to let an initiator
--     approve their own payment, in the database, since 0001.  But
--     "initiator" and "approver" were demo personas rather than members
--     of a company, so the constraint guarded a distinction nothing
--     modelled.
--   * a spend limit was per CARD.  A card is an instrument.  A limit is
--     something you give a PERSON, and a person can hold more than one
--     instrument over time (re-issuing a card is a new `card` row -- see
--     0008 -- so a per-card limit resets when a card is replaced, which
--     is exactly wrong).
--   * nothing answered "who at this business can do what, and who spent
--     this".
--
-- This migration models the people.  It adds no new money table, posts
-- nothing, and is not reachable from `ledger_append()`.
--
-- ---------------------------------------------------------------------
-- THE ROLE MODEL, AND WHY THESE FOUR
-- ---------------------------------------------------------------------
--
-- The brief names the verbs itself, in one line each:
--
--   "Users need to SEE THEIR BALANCE."                     -> viewer
--   "Users need to APPROVE PAYMENTS above a threshold."    -> approver
--   ...and a payment has to be raised before it is approved -> initiator
--   ...and somebody has to hold the roles and the limits    -> admin
--
-- Four roles, each of which exists because a sentence of the brief
-- requires it, and no role that exists because a permissions matrix
-- looked asymmetric.  Twelve documented roles beat by four enforced
-- ones: every capability below is read by a trigger or by the real-time
-- authorisation decision, and none of them is read only by a screen.
--
-- The capabilities are CUMULATIVE and that is a deliberate simplification
-- with one deliberate exception:
--
--   capability        viewer  initiator  approver  admin
--   view_balance        yes      yes       yes      yes
--   raise_payment        no      yes       yes      yes
--   approve_payment      no       no       yes      yes
--   administer_team      no       no        no      yes
--
-- The exception worth arguing about is that `admin` carries
-- `approve_payment`.  An administrator who can also approve holds
-- unilateral control in a one-admin business -- they choose the
-- approvers AND are one.  That is not solved by taking approval away
-- from admins (it just moves the problem: the admin promotes a
-- compliant subordinate instead).  It is solved by §7 below, which
-- refuses an approval by anybody the initiator administers.  So an
-- admin's own above-threshold payment needs a PEER admin or a Corgi
-- staff approver, and a business with exactly one admin must appoint a
-- second before its admin can move large money.  That is what a real
-- bank means by "two authorised signatories", and it is a trigger here
-- rather than a sentence in a policy document.
--
-- ---------------------------------------------------------------------
-- WHY `actor` IS NOT EXTENDED, AND WHAT A MEMBER ACTUALLY IS
-- ---------------------------------------------------------------------
--
-- A member IS an actor -- `team_member.actor_id` -- and not a parallel
-- identity.  Every attribution in this system already runs through
-- `actor_id`: journal entries, payment instructions, approvals, control
-- versions.  Inventing a second principal type would mean every one of
-- those either learns about members or silently keeps working on the old
-- one, and the second is how a permission system becomes decorative.
--
-- `actor.can_approve` stays exactly as 0001 wrote it and this migration
-- can only NARROW it.  See §7.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The capability matrix, as a function the database itself can call
-- ---------------------------------------------------------------------
--
-- IMMUTABLE and pure, so it is legal in a CHECK, in an index predicate
-- and inside a trigger on the approval path.  One definition, read by
-- the maker-checker trigger, by the initiator gate, by the views, and --
-- through `v_team_member_current` -- by the real-time authorisation
-- decision.  There is no second copy of this table in TypeScript that
-- can drift: `src/lib/team/roles.ts` re-states it and
-- `team.integration.test.ts` asserts the two agree cell by cell.

CREATE FUNCTION team_role_can(p_role text, p_capability text)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
AS $$
  SELECT CASE p_capability
    WHEN 'view_balance'    THEN p_role IN ('viewer','initiator','approver','admin')
    WHEN 'raise_payment'   THEN p_role IN ('initiator','approver','admin')
    WHEN 'approve_payment' THEN p_role IN ('approver','admin')
    WHEN 'administer_team' THEN p_role IN ('admin')
    ELSE false
  END
$$;

COMMENT ON FUNCTION team_role_can(text, text) IS
  'The whole permission system: four roles, four capabilities, one table. Read by triggers and by the real-time authorisation decision, never only by a screen.';


-- ---------------------------------------------------------------------
-- 2.  Membership
-- ---------------------------------------------------------------------
--
-- One row per (person, business, spell).  Deliberately carries NO state
-- and NO role: those change over time and therefore live in the
-- append-only chain in §3, for the same reason `card_control_version`
-- exists rather than mutable columns on `card`.
--
-- `membership_seq` is the SPELL.  Removal is terminal within a chain
-- (§3), so re-hiring somebody is membership 2, a new row with a new id,
-- and their two spells are two separate histories that cannot be
-- confused with one another.  The alternative -- writing an 'active'
-- version after a 'removed' one -- would let a single append silently
-- re-arm a card that had been revoked, which is the one thing removal
-- must not be one keystroke away from.
--
-- Contiguity and "the previous spell must be terminally removed" are
-- asserted by the trigger below; `UNIQUE (business_id, actor_id,
-- membership_seq)` is what makes it safe under concurrency, exactly as
-- `UNIQUE (card_id, version)` does in 0014.

CREATE TABLE team_member (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES business(id),
  actor_id       uuid NOT NULL REFERENCES actor(id),
  membership_seq integer NOT NULL DEFAULT 1 CHECK (membership_seq >= 1),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_member_spell_key UNIQUE (business_id, actor_id, membership_seq)
);

CREATE INDEX team_member_business_idx ON team_member (business_id);
CREATE INDEX team_member_actor_idx    ON team_member (actor_id);

COMMENT ON TABLE team_member IS
  'One spell of one person''s membership of one business. State and role live in team_member_version; removal is terminal, so re-hiring is membership_seq + 1.';

-- Append-only.  A membership that can be deleted is a history that can
-- be deleted, and this is a regulated system: the fact that somebody was
-- on this team between March and July is evidence, not configuration.
CREATE TRIGGER team_member_no_update_delete
  BEFORE UPDATE OR DELETE ON team_member
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER team_member_no_truncate
  BEFORE TRUNCATE ON team_member
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 3.  The member's terms, versioned -- the card_control_version pattern
-- ---------------------------------------------------------------------
--
-- Role, state and the person's own spend limits, in ONE chain.  They are
-- one chain and not three because they are one question -- "what is this
-- person allowed to do, and since when" -- and because a decision pins
-- ONE version id.  Three chains would mean three ids on every row and
-- three ways for an audit to find a different answer.
--
-- NULL limit != 0 limit, the same distinction 0014 makes for cards:
-- NULL is "no limit of this kind on this person", 0 is "this person
-- spends nothing".  Both are reachable from the screen and they mean
-- different things.
--
-- `state`:
--   active     normal
--   suspended  reversible.  Cards stop authorising; the person stays.
--   removed    TERMINAL.  No further version may be written for this
--              membership.  Their history stands, their outstanding
--              authorisations still settle, and their card stops.

CREATE TABLE team_member_version (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id      uuid NOT NULL REFERENCES team_member(id),
  version        integer NOT NULL CHECK (version >= 1),
  effective_from timestamptz NOT NULL DEFAULT now(),

  state          text NOT NULL CHECK (state IN ('active','suspended','removed')),
  role           text NOT NULL CHECK (role  IN ('viewer','initiator','approver','admin')),

  -- The PERSON's envelope, on top of whatever their card allows.  A
  -- per-card limit is a property of an instrument; this is a property of
  -- a human being, and it survives the card being replaced.
  per_txn_limit_cents   bigint CHECK (per_txn_limit_cents   IS NULL OR per_txn_limit_cents   >= 0),
  daily_limit_cents     bigint CHECK (daily_limit_cents     IS NULL OR daily_limit_cents     >= 0),
  monthly_limit_cents   bigint CHECK (monthly_limit_cents   IS NULL OR monthly_limit_cents   >= 0),

  -- Why this version exists.  NOT NULL forces the screen to ask, and it
  -- is the first thing read when somebody asks why a card stopped.
  note           text NOT NULL,
  created_by     uuid NOT NULL REFERENCES actor(id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT team_member_version_key UNIQUE (member_id, version)
);

CREATE INDEX team_member_version_member_idx
  ON team_member_version (member_id, version DESC);

COMMENT ON TABLE team_member_version IS
  'Append-only chain of one member''s terms: role, state and their personal spend limits. A change is version N+1. Removal is terminal.';

CREATE TRIGGER team_member_version_no_update_delete
  BEFORE UPDATE OR DELETE ON team_member_version
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER team_member_version_no_truncate
  BEFORE TRUNCATE ON team_member_version
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- The four things a new version must satisfy.  All BEFORE INSERT, all
-- RAISE, and one RAISE aborts the statement.
--
--   (a) contiguity and monotonic effective_from -- 0014's argument,
--       applied to people: a gap makes "the version before this one"
--       ambiguous in an audit, and terms that took effect before the
--       terms they replace cannot be reasoned about at all.
--   (b) TERMINALITY.  Nothing follows 'removed'.
--   (c) THE APPROVAL ENVELOPE.  A role carrying `approve_payment` may
--       only be written for an actor whose `can_approve` is already
--       true.  0001 owns that column and this migration NEVER widens it
--       -- see §7 -- so a member created as a viewer cannot be promoted
--       into approval rights by a row in this table.  That promotion is
--       REFUSED LOUDLY here rather than accepted and then silently
--       ignored by assert_maker_checker() at the moment somebody tries
--       to approve a payment, which is the failure mode this build
--       spends its time hunting: a screen that says yes and a database
--       that says no.
--   (d) AUTHORSHIP.  The author must hold `administer_team` in this
--       business, or be Corgi staff (no membership of it).  Staff are
--       the break-glass and the bootstrap: somebody has to create the
--       first admin, and it cannot be that business's first admin.

CREATE FUNCTION assert_team_member_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev     team_member_version%ROWTYPE;
  v_member   team_member%ROWTYPE;
  v_actor    actor%ROWTYPE;
  v_author   text;
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

  -- (d) authorship
  SELECT tmc.role INTO v_author
    FROM team_member tm
    JOIN v_team_member_current tmc ON tmc.member_id = tm.id
   WHERE tm.business_id = v_member.business_id
     AND tm.actor_id    = NEW.created_by
     AND tmc.state <> 'removed'
   ORDER BY tm.membership_seq DESC
   LIMIT 1;

  IF v_author IS NOT NULL AND NOT team_role_can(v_author, 'administer_team') THEN
    RAISE EXCEPTION
      'actor % is a % of this business and cannot change a member''s terms; administer_team is held by admin only',
      NEW.created_by, v_author USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_team_member_version() SET search_path = public, pg_temp;

-- Created AFTER v_team_member_current below, because the function body
-- references it.  plpgsql bodies are parsed at execution time, so the
-- order of creation does not matter to Postgres -- it matters to the
-- reader, and the view is fifty lines down.


-- ---------------------------------------------------------------------
-- 4.  The current terms, derived
-- ---------------------------------------------------------------------
--
-- DISTINCT ON, the same shape as `v_card_control_current`, for the same
-- reason: the planner turns it into one index scan per member against
-- `team_member_version_member_idx`.  Nothing is stored.

CREATE VIEW v_team_member_current AS
SELECT DISTINCT ON (tmv.member_id)
       tmv.member_id,
       tmv.id            AS member_version_id,
       tmv.version,
       tmv.effective_from,
       tmv.state,
       tmv.role,
       tmv.per_txn_limit_cents,
       tmv.daily_limit_cents,
       tmv.monthly_limit_cents,
       tmv.note,
       tmv.created_by,
       tmv.created_at,
       team_role_can(tmv.role, 'view_balance')    AS can_view_balance,
       team_role_can(tmv.role, 'raise_payment')   AS can_raise_payment,
       team_role_can(tmv.role, 'approve_payment') AS can_approve_payment,
       team_role_can(tmv.role, 'administer_team') AS can_administer_team
  FROM team_member_version tmv
 ORDER BY tmv.member_id, tmv.version DESC;

COMMENT ON VIEW v_team_member_current IS
  'Newest terms per member, with the capability matrix expanded. Derived from the append-only chain, never stored.';

CREATE TRIGGER team_member_version_chain
  BEFORE INSERT ON team_member_version
  FOR EACH ROW EXECUTE FUNCTION assert_team_member_version();


-- The team, as a screen reads it: person, terms, capabilities.
CREATE VIEW v_team_member AS
SELECT tm.id                AS member_id,
       tm.business_id,
       tm.actor_id,
       tm.membership_seq,
       tm.created_at        AS joined_at,
       a.display_name,
       a.email,
       a.can_approve        AS actor_can_approve,
       c.member_version_id,
       c.version            AS terms_version,
       c.effective_from     AS terms_effective_from,
       c.state,
       c.role,
       c.per_txn_limit_cents,
       c.daily_limit_cents,
       c.monthly_limit_cents,
       c.note,
       c.can_view_balance,
       c.can_raise_payment,
       c.can_approve_payment,
       c.can_administer_team
  FROM team_member tm
  JOIN actor a ON a.id = tm.actor_id
  JOIN v_team_member_current c ON c.member_id = tm.id;


-- ---------------------------------------------------------------------
-- 5.  A card belongs to a person
-- ---------------------------------------------------------------------
--
-- A SEPARATE TABLE RATHER THAN A COLUMN ON `card`, and the reason is
-- worth stating because a column would have been shorter.  `card` is
-- append-only with SELECT/INSERT only and its INSERT is owned by
-- `registerCard()` in `src/lib/holds/store.ts`, which this work is not
-- allowed to change tonight.  Adding a nullable column would have meant
-- either a second INSERT statement against `card` (two issuing paths,
-- which is exactly what the task forbids) or an UPDATE, which does not
-- exist.  A binding table is written AFTER the existing issuing path
-- runs, unchanged, and it costs one indexed join on the hot path.
--
-- PRIMARY KEY (card_id): a card belongs to exactly ONE person for its
-- whole life.  Moving a card to a different person is re-issuing, which
-- 0008 already defines as a new `card` row with a new provider token --
-- "an UPDATE that repointed provider_card_token from Ridgeline to Kettle
-- & Crumb would silently bill one customer for another customer's
-- spend".  The same sentence with "person" in place of "customer" is why
-- there is no UPDATE here either.

CREATE TABLE card_member (
  card_id     uuid PRIMARY KEY REFERENCES card(id),
  member_id   uuid NOT NULL REFERENCES team_member(id),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by uuid NOT NULL REFERENCES actor(id)
);

CREATE INDEX card_member_member_idx ON card_member (member_id);

COMMENT ON TABLE card_member IS
  'Which person holds which card. One card, one member, for the life of the card: re-assigning is re-issuing.';

CREATE TRIGGER card_member_no_update_delete
  BEFORE UPDATE OR DELETE ON card_member
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER card_member_no_truncate
  BEFORE TRUNCATE ON card_member
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

-- Two claims, both of which are money claims:
--   * the card's business and the member's business are the same one.
--     A card that spends from Ridgeline's 2100 held by a member of
--     Kettle & Crumb is the cross-tenant bug 0008's header describes,
--     arriving through a different door.
--   * a card is never issued to a member who is not active.  Giving a
--     card to somebody who has been removed is not a state this system
--     should be able to reach by accident.
CREATE FUNCTION assert_card_member() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_card_business uuid;
  v_mem_business  uuid;
  v_state         text;
BEGIN
  SELECT business_id INTO v_card_business FROM card        WHERE id = NEW.card_id;
  SELECT business_id INTO v_mem_business  FROM team_member WHERE id = NEW.member_id;

  IF v_card_business IS DISTINCT FROM v_mem_business THEN
    RAISE EXCEPTION
      'card % belongs to business % and member % to business %: a card cannot be held by a member of another business',
      NEW.card_id, v_card_business, NEW.member_id, v_mem_business
      USING ERRCODE = '42501';
  END IF;

  SELECT state INTO v_state FROM v_team_member_current WHERE member_id = NEW.member_id;
  IF v_state IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'member % is %, so no card may be issued to them',
      NEW.member_id, COALESCE(v_state, 'not a member') USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_card_member() SET search_path = public, pg_temp;

CREATE TRIGGER card_member_valid
  BEFORE INSERT ON card_member
  FOR EACH ROW EXECUTE FUNCTION assert_card_member();


-- ---------------------------------------------------------------------
-- 6.  An authorisation is attributable to a PERSON
-- ---------------------------------------------------------------------
--
-- Two columns on the append-only decision log, denormalised at the
-- instant of the decision.
--
-- WHY DENORMALISED RATHER THAN JOINED THROUGH `card_member`.  Both are
-- available -- a card's member cannot change, so the join would give the
-- same answer forever -- but the velocity read on the hot path sums
-- `amount_cents` over ONE PERSON'S decisions, and that has to be an
-- index scan, not a join to a join.  `member_id` here is what makes the
-- partial index below usable.  `member_version_id` is the terms the
-- decision was judged under, pinned exactly as `control_version_id`
-- pins the card's: a limit raised tomorrow must not make today's
-- decline look wrong.
--
-- Both are NULL for a card with no member -- every card issued before
-- tonight -- and NULL means "not attributed to a person", which is a
-- different thing from "attributed to nobody".

ALTER TABLE card_auth_decision
  ADD COLUMN member_id         uuid REFERENCES team_member(id),
  ADD COLUMN member_version_id uuid REFERENCES team_member_version(id);

COMMENT ON COLUMN card_auth_decision.member_id IS
  'The person this authorisation was decided for, as bound at the moment of the decision. NULL for a card that belongs to no member.';
COMMENT ON COLUMN card_auth_decision.member_version_id IS
  'The member terms version this decision was judged under. Pinned, for the same reason control_version_id is.';

-- The per-person velocity read.  Same shape and same argument as
-- `card_auth_decision_velocity_idx` from 0014: partial on the approvals,
-- because a decline consumed nothing and declines are most of the table
-- on a card that is doing its job.
CREATE INDEX card_auth_decision_member_velocity_idx
  ON card_auth_decision (member_id, source, decided_at DESC)
  WHERE outcome = 'approve' AND member_id IS NOT NULL;


-- ---------------------------------------------------------------------
-- 7.  Maker-checker, now that there are members
-- ---------------------------------------------------------------------
--
-- 0001's `assert_maker_checker()` is LEFT ALONE, for the reason 0007
-- gives at length: it is applied, hashed and immutable, and re-issuing
-- it to bolt on branches would put the self-approval refusal at risk for
-- the sake of an addition.  0007 added a second BEFORE INSERT trigger
-- that composes with it.  This is the third.  Postgres fires BEFORE
-- triggers in alphabetical order by name, so the sequence is
--
--     ..._lifecycle  ->  ..._maker_checker  ->  ..._team
--
-- and the order does not matter: all three are BEFORE INSERT, all three
-- RAISE, and one RAISE aborts the statement.
--
-- THIS TRIGGER CAN ONLY EVER REFUSE.  Every check below is a NARROWING
-- of what 0001 already allows.  There is no branch here that permits an
-- approval 0001 would have refused, which is the property that makes
-- adding it safe: `actor.can_approve` and `initiator <> approver` still
-- hold exactly as they did, and this adds three more ways to be refused.
--
-- (1) A MEMBER MAY ONLY APPROVE THEIR OWN BUSINESS'S PAYMENTS.
--     This is a hole that existed until tonight and it is worth naming:
--     0001 gates on `actor.can_approve`, which is global.  Alex
--     Whitfield, a signer scoped to Ridgeline, could approve Kettle &
--     Crumb's payment, and nothing in the database would have stopped
--     him.  Corgi staff (actors with no membership anywhere) are
--     unaffected -- they are the bank's own approvers and approving
--     across customers is their job.
--
-- (2) A MEMBER WHOSE CURRENT ROLE DOES NOT CARRY `approve_payment`
--     CANNOT APPROVE, whatever `actor.can_approve` says.  This is the
--     narrowing that makes removal real: a removed member's actor row
--     still says can_approve, because actor rows are append-only and
--     0001 owns that column.  Their membership says removed, and this
--     is where that stops being a label.
--
-- (3) THE INDEPENDENCE RULE.  The initiator may not be approved by
--     somebody they ADMINISTER.
--
--     THE QUESTION, PUT PROPERLY: can two members of the same business
--     approve each other's payments?
--
--     YES, and that is the deliberate answer.  What maker-checker
--     actually buys is that two humans looked at the same payment with
--     the same content hash.  Forbidding peers from approving each
--     other would make the control unusable for a three-person
--     business, and an unusable control is not a stricter control -- it
--     is a control people route around by sharing a login, which
--     destroys attribution entirely.  Every business banking product
--     that ships dual authorisation allows peer approval.  Collusion is
--     a real risk and no threshold fixes it; it is answered by
--     attribution and audit, both of which this system has.
--
--     EXCEPT where the second pair of eyes is not independent.  A
--     member whose ROLE, SPEND LIMITS and CONTINUED MEMBERSHIP are all
--     controlled by the initiator is not a second pair of eyes; they
--     are an extension of the first, and the initiator can make that
--     explicit at any time by writing a version of their terms.  So an
--     approval is refused when the initiator holds `administer_team`
--     in the business and the approver does not.  Admins do not
--     administer each other, so a peer admin may approve.
--
--     The consequence, stated rather than discovered: a business with
--     exactly ONE admin cannot approve that admin's above-threshold
--     payments internally.  It must appoint a second admin, or use a
--     Corgi staff approver.  That is what "two authorised signatories"
--     means and it is the correct amount of friction on the one account
--     where a single person would otherwise hold both halves of the
--     control.
--
--     The direction matters and only one direction is refused: an admin
--     approving a junior's payment is fine (the approver is not under
--     the initiator's control).  A junior approving THEIR admin's
--     payment is refused.
--
-- A note on cost: this trigger runs on `payment_instruction_event`
-- inserts, which are human-paced.  It is not on the card authorisation
-- path and has nothing to do with the 6000 ms ASA window.

CREATE FUNCTION assert_team_maker_checker() RETURNS trigger
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
        'actor % is a member of another business and is not a member of business %; a team member approves only their own business''s payments',
        NEW.actor_id, v_business USING ERRCODE = '42501';
    END IF;

    -- (2) the current role, not the actor column
    IF v_appr_state <> 'active' THEN
      RAISE EXCEPTION
        'actor % is a % member of business % and cannot approve payments',
        NEW.actor_id, v_appr_state, v_business USING ERRCODE = '42501';
    END IF;

    IF NOT v_appr_approve THEN
      RAISE EXCEPTION
        'actor % holds the role % in business %, which does not carry approve_payment',
        NEW.actor_id, v_appr_role, v_business USING ERRCODE = '42501';
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

CREATE TRIGGER payment_instruction_event_team
  BEFORE INSERT ON payment_instruction_event
  FOR EACH ROW EXECUTE FUNCTION assert_team_maker_checker();


-- The other half of maker-checker: who may be the MAKER.
--
-- A member whose role does not carry `raise_payment` cannot raise one,
-- and a suspended or removed member cannot raise one at all.  Same
-- narrowing property: an actor with no membership is untouched, so the
-- agent surface, the standing-order runner and Corgi staff all behave
-- exactly as they did.
CREATE FUNCTION assert_team_initiator() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_business  uuid;
  v_state     text;
  v_role      text;
  v_raise     boolean;
BEGIN
  SELECT business_id INTO v_business FROM account WHERE id = NEW.account_id;

  SELECT c.state, c.role, c.can_raise_payment
    INTO v_state, v_role, v_raise
    FROM team_member tm
    JOIN v_team_member_current c ON c.member_id = tm.id
   WHERE tm.actor_id = NEW.requested_by
     AND tm.business_id = v_business
   ORDER BY tm.membership_seq DESC
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF v_state <> 'active' THEN
    RAISE EXCEPTION
      'actor % is a % member of business % and cannot raise a payment',
      NEW.requested_by, v_state, v_business USING ERRCODE = '42501';
  END IF;

  IF NOT v_raise THEN
    RAISE EXCEPTION
      'actor % holds the role % in business %, which does not carry raise_payment',
      NEW.requested_by, v_role, v_business USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_team_initiator() SET search_path = public, pg_temp;

CREATE TRIGGER payment_instruction_team
  BEFORE INSERT ON payment_instruction
  FOR EACH ROW EXECUTE FUNCTION assert_team_initiator();


-- ---------------------------------------------------------------------
-- 8.  Creating a member, without granting the application INSERT on actor
-- ---------------------------------------------------------------------
--
-- `corgi_app` holds SELECT and nothing else on `actor`, and
-- `approvals.integration.test.ts` ASSERTS THAT -- it attempts
-- `INSERT INTO actor (kind, display_name, can_approve) VALUES ('agent',
-- 'rogue', true)` and requires `permission denied`.  That assertion is
-- correct and it stays true after this migration: no grant below widens
-- it.
--
-- So adding a member goes through a SECURITY DEFINER function, the same
-- pattern and the same argument as `ledger_append()`: "so corgi_app can
-- call it without holding privileges it should not have".  The function
-- is the ONLY path, and because it is the only path it can enforce
-- things a grant cannot:
--
--   * `kind` is hardcoded 'human'.  The application cannot create an
--     agent through this door, with or without approval rights.
--   * `business_id` is always set.  It cannot mint a Corgi staff actor.
--   * `can_approve` is derived from the role, once, at creation.  See
--     §3(c) for why it is never written again.
--   * the membership and terms version 1 are written in the SAME
--     statement, so a membership with no terms is unrepresentable.
--   * the author must hold `administer_team` in this business, or be
--     Corgi staff.  The first admin of a business is created by the
--     bank, which is the only honest bootstrap.
--
-- Re-adding somebody who was removed REUSES their actor row and opens
-- membership_seq + 1.  One person, one principal, two spells -- so their
-- old journal entries, approvals and card decisions still point at the
-- same actor and their history reads as one person's, which is the
-- point of not deleting anything.

CREATE FUNCTION team_add_member(
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
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor_id    uuid;
  v_member_id   uuid;
  v_seq         integer;
  v_prev_seq    integer;
  v_prev_state  text;
  v_prev_found  boolean;
  v_author      text;
  v_email       text := lower(btrim(p_email));
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

  -- Authorship: an admin of this business, or Corgi staff.
  SELECT c.role INTO v_author
    FROM team_member tm
    JOIN v_team_member_current c ON c.member_id = tm.id
   WHERE tm.business_id = p_business_id
     AND tm.actor_id    = p_created_by
     AND c.state <> 'removed'
   ORDER BY tm.membership_seq DESC
   LIMIT 1;

  IF v_author IS NOT NULL AND NOT team_role_can(v_author, 'administer_team') THEN
    RAISE EXCEPTION
      'actor % is a % of this business and cannot add members',
      p_created_by, v_author USING ERRCODE = '42501';
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

ALTER FUNCTION team_add_member(uuid, text, text, text, uuid, text, bigint, bigint, bigint)
  SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION team_add_member(uuid, text, text, text, uuid, text, bigint, bigint, bigint)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_add_member(uuid, text, text, text, uuid, text, bigint, bigint, bigint)
  TO corgi_app;

-- The contiguity trigger fires on team_member too: a spell may only
-- follow a terminally-removed one.  In the function above that is
-- already true by construction; the trigger is what holds when somebody
-- writes SQL by hand.
CREATE FUNCTION assert_team_member_spell() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev_seq   integer;
  v_prev_state text;
BEGIN
  SELECT tm.membership_seq, c.state
    INTO v_prev_seq, v_prev_state
    FROM team_member tm
    LEFT JOIN v_team_member_current c ON c.member_id = tm.id
   WHERE tm.business_id = NEW.business_id
     AND tm.actor_id    = NEW.actor_id
   ORDER BY tm.membership_seq DESC
   LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.membership_seq <> 1 THEN
      RAISE EXCEPTION
        'actor % has never been a member of business %; the first spell is 1, not %',
        NEW.actor_id, NEW.business_id, NEW.membership_seq USING ERRCODE = '55006';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.membership_seq <> v_prev_seq + 1 THEN
    RAISE EXCEPTION
      'actor % is on spell % of business %; the next is %, not %',
      NEW.actor_id, v_prev_seq, NEW.business_id,
      v_prev_seq + 1, NEW.membership_seq USING ERRCODE = '55006';
  END IF;

  IF v_prev_state IS DISTINCT FROM 'removed' THEN
    RAISE EXCEPTION
      'actor % is already a % member of business %; a second live membership is not representable',
      NEW.actor_id, COALESCE(v_prev_state, 'termless'), NEW.business_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_team_member_spell() SET search_path = public, pg_temp;

CREATE TRIGGER team_member_spell_chain
  BEFORE INSERT ON team_member
  FOR EACH ROW EXECUTE FUNCTION assert_team_member_spell();

-- One principal per person per business, enforced rather than checked.
-- Without this, two concurrent `team_add_member` calls for the same
-- email both miss the lookup and both create an actor.  Scoped to
-- business-owned actors so Corgi staff and the system principals (which
-- carry NULL business_id, and in two cases NULL email) are untouched.
CREATE UNIQUE INDEX actor_business_email_key
  ON actor (business_id, lower(email))
  WHERE business_id IS NOT NULL AND email IS NOT NULL;


-- ---------------------------------------------------------------------
-- 9.  REMOVING A MEMBER SAFELY -- the report, and the two invariants
-- ---------------------------------------------------------------------
--
-- What removal is, in this schema: ONE INSERT.  A new
-- `team_member_version` with state 'removed'.  That is the entire
-- database side of it, and the things it deliberately does NOT do are
-- the feature:
--
--   * it does not delete the member, so their history stands;
--   * it does not touch `card`, so the card still resolves to the same
--     business, the same 2100 and the same 9100 leaf;
--   * it does not touch `card_authorization`, `card_auth_event`, `hold`
--     or `hold_closure`, so an authorisation that was outstanding when
--     they were removed still settles through exactly the path it would
--     have settled through if nobody had been removed;
--   * it does not post, reverse or release anything.
--
-- A "delete user" that released the hold would hand the customer back
-- money the merchant is still going to claim, and the clearing would
-- then arrive against a released hold -- a double count, discovered days
-- later by reconciliation.  A "delete user" that deleted the card row
-- would orphan the authorisation entirely: the Lithic consumer parks on
-- an unknown card token and the money never books.  Neither is
-- reachable here, because neither verb exists on these tables.
--
-- What DOES stop is the future: the real-time authorisation decision
-- declines on rule `member_removed` (src/lib/cards/decide.ts), and the
-- application pauses the card at Lithic so the decline holds even while
-- ASA is disenrolled.  Both are in front of the money; neither is in it.

-- A REPORT, NOT AN INVARIANT.  This view is EXPECTED to have rows: they
-- are the correct state of the world, not a fault.  It is listed here
-- and NOT in the invariant set on purpose -- a view asserted to be empty
-- that has rows in normal operation is how a guard gets deleted.
CREATE VIEW v_removed_member_open_authorisation AS
SELECT tm.id                    AS member_id,
       tm.business_id,
       a.display_name,
       c.state                  AS member_state,
       c.effective_from         AS removed_at,
       cm.card_id,
       cd.provider_card_token,
       cd.last_four,
       ca.id                    AS auth_id,
       ca.provider_auth_id,
       ca.hold_id,
       ch.auth_net_cents,
       ch.captured_cents,
       ch.target_hold_cents,
       hs.memo_balance_cents,
       ca.expires_at
  FROM team_member tm
  JOIN actor a                   ON a.id = tm.actor_id
  JOIN v_team_member_current c   ON c.member_id = tm.id
  JOIN card_member cm            ON cm.member_id = tm.id
  JOIN card cd                   ON cd.id = cm.card_id
  JOIN card_authorization ca     ON ca.card_id = cm.card_id
  JOIN v_card_auth_hold ch       ON ch.auth_id = ca.id
  JOIN v_hold_state hs           ON hs.hold_id = ca.hold_id
 WHERE c.state IN ('suspended','removed')
   AND NOT ch.is_closed;

COMMENT ON VIEW v_removed_member_open_authorisation IS
  'REPORT, NOT AN INVARIANT. Authorisations still outstanding on the card of a member who has been suspended or removed. Rows here are correct: the money must still settle.';

-- INVARIANT.  MUST RETURN ZERO ROWS.
--
-- No purchase was ever approved for a person who had been suspended or
-- removed at the moment it was decided.  Computed from the PINNED
-- `member_version_id` and not from the member's current state, so it is
-- historically exact: a decision approved while the member was active
-- and who was removed an hour later is not a violation, and must not be
-- reported as one.
--
-- This is the guard on rule `member_removed` in decide.ts.  It was made
-- to fail on purpose before it was written down -- see docs/TEAM.md §7
-- for the transcript and the 0 -> 1 delta.
CREATE VIEW v_approved_auth_for_dead_member AS
SELECT d.id           AS decision_id,
       d.decided_at,
       d.member_id,
       d.member_version_id,
       tmv.state      AS member_state_at_decision,
       d.amount_cents,
       d.rule,
       d.source
  FROM card_auth_decision d
  JOIN team_member_version tmv ON tmv.id = d.member_version_id
 WHERE d.outcome = 'approve'
   AND d.request_status IN ('AUTHORIZATION','FINANCIAL_AUTHORIZATION')
   AND tmv.state <> 'active';

COMMENT ON VIEW v_approved_auth_for_dead_member IS
  'MUST BE EMPTY. A purchase approved under member terms that were suspended or removed at the instant of the decision.';

-- INVARIANT.  MUST RETURN ZERO ROWS.
--
-- No payment was ever approved by a member who, AT THE MOMENT OF THE
-- APPROVAL, did not hold `approve_payment`.  Point in time, from the
-- terms chain: the version in force is the newest one whose
-- `effective_from` is at or before the approval.
--
-- This is the guard on §7(2), and it is the one that makes
-- `actor.can_approve` honest.  0001's column says a principal MAY hold
-- approval rights; the member's role says whether they DO, at each
-- instant; and this view asserts the composition held for every approval
-- ever written.  It too was made to fail on purpose -- docs/TEAM.md §7.
CREATE VIEW v_member_approval_without_right AS
SELECT e.id          AS event_id,
       e.instruction_id,
       e.actor_id,
       e.occurred_at,
       tm.business_id,
       terms.role    AS role_at_approval,
       terms.state   AS state_at_approval
  FROM payment_instruction_event e
  JOIN payment_instruction pi ON pi.id = e.instruction_id
  JOIN account acct           ON acct.id = pi.account_id
  JOIN team_member tm         ON tm.actor_id = e.actor_id
                            AND tm.business_id = acct.business_id
  JOIN LATERAL (
        SELECT v.state, v.role
          FROM team_member_version v
         WHERE v.member_id = tm.id
           AND v.effective_from <= e.occurred_at
         ORDER BY v.version DESC
         LIMIT 1
       ) terms ON true
 WHERE e.kind::text = 'approved'
   AND (terms.state <> 'active' OR NOT team_role_can(terms.role, 'approve_payment'));

COMMENT ON VIEW v_member_approval_without_right IS
  'MUST BE EMPTY. A payment approval by a member whose role and state AT THAT INSTANT did not carry approve_payment.';


-- ---------------------------------------------------------------------
-- 10.  Grants
-- ---------------------------------------------------------------------
--
-- SELECT and INSERT, matching every other append-only table in this
-- schema.  No UPDATE, no DELETE, no TRUNCATE -- not because the
-- application would not try, but because the role cannot express it.
--
-- `team_member` is SELECT ONLY.  Its INSERT lives inside
-- `team_add_member()`, which runs as the definer, so the only way the
-- application can create a membership is through the function that also
-- creates the actor, sets can_approve from the role, writes terms
-- version 1 in the same statement and checks the author's rights.  A
-- membership with no terms is therefore unrepresentable.
--
-- NOTHING HERE WIDENS `actor`.  corgi_app still holds SELECT and only
-- SELECT on it, which approvals.integration.test.ts asserts by trying.

GRANT SELECT                 ON team_member         TO corgi_app;
GRANT SELECT, INSERT         ON team_member_version TO corgi_app;
GRANT SELECT, INSERT         ON card_member         TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON team_member, team_member_version, card_member
  FROM corgi_app, PUBLIC;

GRANT SELECT ON v_team_member_current                TO corgi_app;
GRANT SELECT ON v_team_member                        TO corgi_app;
GRANT SELECT ON v_removed_member_open_authorisation  TO corgi_app;
GRANT SELECT ON v_approved_auth_for_dead_member      TO corgi_app;
GRANT SELECT ON v_member_approval_without_right      TO corgi_app;

GRANT EXECUTE ON FUNCTION team_role_can(text, text) TO corgi_app;
