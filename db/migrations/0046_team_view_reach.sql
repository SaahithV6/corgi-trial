-- 0046 — THE TEAM GUARDS JUDGE THE WHOLE POPULATION
--
-- The twenty-fifth instance of this build's defining failure, and it is
-- inside the security fix that shipped an hour ago.
--
-- ---------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------
--
-- Measured by `scripts/dbcheck.mjs` GUARD REACH, on this book, before
-- this file:
--
--     v_member_approval_without_right       33 of 186 'approved' events
--     v_team_terms_by_unauthorised_author    3 of 422 member-version rows
--     v_approved_auth_for_dead_member       11 of  26 approved decisions
--
-- All three resolve their subject through an INNER JOIN — to
-- `team_member` for the first two, to `team_member_version` for the
-- third.  So an actor with no membership of that business, or a decision
-- that pinned no member version, is not judged AND NOT REPORTED.  It
-- falls out of the FROM clause before any predicate is applied.
--
-- That is 0033's defect verbatim, one table over.  0033 looked the author
-- up `AND state <> 'removed'`, got NULL for a removed admin, and NULL was
-- the branch that TRUSTS.  0044 closed that door for REMOVED members and
-- left it open for NON-members, in the VIEW rather than in the function.
--
--     WHAT THE GUARD EXCLUDES FROM ITS OWN POPULATION IS EXACTLY THE
--     POPULATION IT EXISTS TO STOP.
--
-- ---------------------------------------------------------------------
-- THE EXPOSURE, MEASURED BEFORE ANYTHING WAS CHANGED
-- ---------------------------------------------------------------------
--
-- 153 unjudged approvals.  ALL of them Corgi staff — `business_id IS
-- NULL`, `kind = 'human'`, no membership of any business — and exactly
-- two people:
--
--     76f9266f-23c9-52de-b8ff-0ec0b23ef386  Dana Okonkwo   100 approvals
--     9fff2b99-0a56-56cd-8fdf-699d64d085ac  Miles Ferrara   53 approvals
--
-- 419 unjudged member-version rows.  ALL of them authored by Dana
-- Okonkwo, the same staff actor.  15 unjudged auth decisions, every one
-- of them on a card that belongs to NO member (11 harness cards with no
-- `card_member` row, 3 on a provider token this book has no `card` row
-- for at all, 1 on a card issued outside the team path).
--
-- Zero by a member of another business.  Zero by a business-scoped actor
-- holding no membership.  Zero by the agent surface.
--
-- SO THIS IS A REPORTING GAP TODAY AND A LIVE HOLE TOMORROW, and the two
-- are worth separating out loud: nothing on this book is currently being
-- laundered through the blind spot, and nothing on this book would have
-- SHOWN if it were.  A guard whose greenness depends on who happens to
-- have been seeded is not a guard.
--
-- ---------------------------------------------------------------------
-- THE SHAPE OF THE REPAIR
-- ---------------------------------------------------------------------
--
-- LEFT JOIN, with the non-member case CLASSIFIED EXPLICITLY rather than
-- dropped.  This is not a new idea either: it is exactly what 0044's own
-- repair did inside the FUNCTION — the state filter came out of the
-- `WHERE` and became a named refusal — and exactly what 0032 did to
-- `v_refused_auth_hold`, whose INNER JOIN to the verdict table excluded
-- the missing verdict that WAS the bug.  An unattributable row must
-- APPEAR, never vanish.
--
-- ONE PREDICATE, THREE CONSUMERS, per subject.  Each guard is now built
-- in two layers:
--
--     v_*_judged    every row of the population, with its actor kind and
--                   its verdict — a REPORT, expected to have rows
--     v_*_census    the same rows, grouped — what GUARD REACH prints
--     the INVARIANT  = the judged rows WHERE is_violation
--
-- so the guard and the census cannot disagree about what is inside the
-- guard.  That is 0040's `v_hold_closure_census` argument: the census
-- derives `in_guard` from the same column the view filters on, and a
-- census hand-written beside a predicate is a census that goes stale.
--
-- ---------------------------------------------------------------------
-- CREATE OR REPLACE, NOT DROP
-- ---------------------------------------------------------------------
--
-- `CREATE OR REPLACE VIEW` keeps the OID, and therefore the ACL and every
-- dependency.  It may only APPEND columns, never reorder or retype them,
-- which is why every existing column below is reproduced in its original
-- position with its original type and the new ones are at the end.  §4
-- reads the catalogue back and aborts if that is untrue.
--
-- 0033 and 0044 are applied and hashed; `scripts/migrate.mjs` refuses a
-- file whose contents changed.  Neither is touched.


-- ---------------------------------------------------------------------
-- 1.  WHAT KIND OF PRINCIPAL IS THIS, RELATIVE TO THIS BUSINESS
-- ---------------------------------------------------------------------
--
-- ONE definition, used by all three guards, because three copies of a
-- classification is how two of them come to disagree about who Corgi
-- staff are.  Six answers, and each one is a different decision:
--
--   'non_human'                a principal that is not a person: the MCP
--                              agent surface, `ledger-poster`,
--                              `webhook-dispatcher`.  CHECKED FIRST, before
--                              membership and before scoping, because a
--                              non-person is never a member and never
--                              break-glass staff whatever other rows say.
--                              The brief is explicit — "The initiator can
--                              never approve their own action. Neither can
--                              an agent" — and `team_add_member()`
--                              hardcodes `kind = 'human'`, so a non-human
--                              membership is already unrepresentable
--                              through the only door there is.  If one ever
--                              appears it is a finding, not a category.
--
--   'member'                   a member of THIS business.  The population
--                              0033 and 0044 already judged, judged
--                              identically — by their terms at the instant,
--                              never their terms today.
--
--   'member_of_other_business' holds a membership somewhere, but not here.
--                              NEVER LEGITIMATE.  0033 §5(1) already
--                              refuses this at the trigger — "Alex
--                              Whitfield, a signer scoped to Ridgeline,
--                              could approve Kettle & Crumb's payment and
--                              nothing in the database would have stopped
--                              him" — and until now no view could see it,
--                              because the same INNER JOIN that made the
--                              trigger necessary made the guard blind.
--
--   'corgi_staff'              `business_id IS NULL`, human, a member of
--                              NOTHING.  0044 permits this deliberately and
--                              says why: "staff hold no membership of any
--                              business, and ending somebody's membership
--                              ends their authority rather than conferring
--                              the bank's".  Approving across customers is
--                              their job.  THE ONE PERMITTED NON-MEMBER.
--
--   'unattributable'           a HUMAN scoped to a business who holds no
--                              membership of any business at all.  A seeder,
--                              a script, a fixture, a direct insert by the
--                              owner.  REPORTED, and that is a decision
--                              worth arguing rather than assuming:
--
--                                `team_add_member()` is the only door that
--                                can mint a business-scoped human, and it
--                                writes the actor, the membership and terms
--                                version 1 IN ONE STATEMENT — 0033 §3, "a
--                                membership with no terms is
--                                unrepresentable".  So this principal did
--                                not come through the product.  Break-glass
--                                is `business_id IS NULL` and it is
--                                ATTRIBUTABLE: two named people, both
--                                auditable, both Corgi's.  This is neither
--                                a member nor staff, and treating "we do
--                                not know who this is" as permission is the
--                                precise sentence 0033 and 0044 were both
--                                written about.  A seeder that wants
--                                authority can hold a staff actor or a
--                                membership; it cannot hold neither.
--
--                              It is zero on this book today, which is why
--                              reporting it costs nothing and is exactly
--                              when a door should be closed.
--
--   'unknown_actor'            the FK says this is unreachable.  Kept
--                              because a classification with no else-branch
--                              returns NULL, and a NULL that means "we did
--                              not think of this" sorting into the
--                              permitted side is the whole defect class.
--
-- STABLE, not IMMUTABLE: it reads `actor` and `team_member`, both of
-- which are append-only, so the answer for a given (actor, business) can
-- only ever move from "not a member" to "a member" — never back.  STABLE
-- is what lets the planner call it once per row inside a scan.
CREATE FUNCTION team_actor_scope(p_actor_id uuid, p_business_id uuid)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT CASE
    WHEN a.id IS NULL                    THEN 'unknown_actor'
    WHEN a.kind <> 'human'               THEN 'non_human'
    WHEN EXISTS (SELECT 1 FROM team_member tm
                  WHERE tm.actor_id = p_actor_id
                    AND tm.business_id IS NOT DISTINCT FROM p_business_id)
                                         THEN 'member'
    WHEN EXISTS (SELECT 1 FROM team_member tm
                  WHERE tm.actor_id = p_actor_id)
                                         THEN 'member_of_other_business'
    WHEN a.business_id IS NULL           THEN 'corgi_staff'
    ELSE                                      'unattributable'
  END
  FROM actor a
  WHERE a.id = p_actor_id;
$$;

ALTER FUNCTION team_actor_scope(uuid, uuid) SET search_path = public, pg_temp;

COMMENT ON FUNCTION team_actor_scope(uuid, uuid) IS
  'What kind of principal this actor is RELATIVE TO this business: non_human, member, member_of_other_business, corgi_staff, unattributable, unknown_actor. One definition, read by every team guard, so they cannot disagree about who break-glass staff are.';

GRANT EXECUTE ON FUNCTION team_actor_scope(uuid, uuid) TO corgi_app;


-- ---------------------------------------------------------------------
-- 2.  PAYMENT APPROVALS — every one of them, judged
-- ---------------------------------------------------------------------
--
-- A REPORT, NOT AN INVARIANT.  It is expected to have 186 rows on this
-- book, one per 'approved' event, because that is the point: the
-- population and the verdict in the same place.
--
-- The subject is resolved with a LEFT JOIN to `team_member` and a LEFT
-- JOIN LATERAL to the terms.  `business_id` is now taken from `account`
-- rather than from `team_member` — the SAME value for every row the old
-- view could see, since the old join equated them, and a non-NULL value
-- for the rows it could not.  The paying business is a property of the
-- payment, not of the approver's membership, and reading it off the
-- membership is what made it disappear when the membership did.
--
-- The terms lateral keeps 0033's clock exactly: the version in force is
-- the newest one whose `effective_from` is at or before the approval.
-- Historically exact — an approver who held the right on Monday and was
-- removed on Friday is not a violation, and a guard that said otherwise
-- would turn every removal into a retroactive indictment, go permanently
-- red, and stop being read.
CREATE VIEW v_payment_approval_judged AS
SELECT e.id             AS event_id,
       e.instruction_id,
       e.actor_id,
       e.occurred_at,
       acct.business_id,
       tm.id            AS member_id,
       scope.kind       AS actor_scope,
       terms.role       AS role_at_approval,
       terms.state      AS state_at_approval,
       verdict.v        AS verdict,
       verdict.v NOT IN ('member_with_the_right', 'corgi_staff_break_glass') AS is_violation
  FROM payment_instruction_event e
  JOIN payment_instruction pi   ON pi.id   = e.instruction_id
  JOIN account acct             ON acct.id = pi.account_id
  -- ONE SPELL, LATERALLY.  0033 wrote this as a plain join to
  -- `team_member`, which is one-to-MANY: `membership_seq` is the spell,
  -- and re-hiring somebody is membership 2 against the same actor and the
  -- same business (0033 §2).  A rejoined employee would therefore have
  -- had every one of their approvals counted twice by the guard.  This
  -- picks the latest spell that had already begun at the instant of the
  -- approval, which is the spell they were actually in.
  LEFT JOIN LATERAL (
        SELECT tm.id
          FROM team_member tm
         WHERE tm.actor_id    = e.actor_id
           AND tm.business_id = acct.business_id
           AND EXISTS (SELECT 1 FROM team_member_version v
                        WHERE v.member_id = tm.id
                          AND v.effective_from <= e.occurred_at)
         ORDER BY tm.membership_seq DESC
         LIMIT 1
       ) tm ON true
  CROSS JOIN LATERAL (
        SELECT team_actor_scope(e.actor_id, acct.business_id) AS kind
       ) scope
  LEFT JOIN LATERAL (
        SELECT v.state, v.role
          FROM team_member_version v
         WHERE v.member_id = tm.id
           AND v.effective_from <= e.occurred_at
         ORDER BY v.version DESC
         LIMIT 1
       ) terms ON true
  CROSS JOIN LATERAL (
        SELECT CASE scope.kind
                 WHEN 'member' THEN
                   CASE
                     -- A member of this business with NO terms at or before
                     -- the approval.  0033's INNER LATERAL dropped this row
                     -- as silently as it dropped the non-members, and it is
                     -- unrepresentable through `team_add_member()` — which
                     -- is exactly why its appearance would be a finding.
                     WHEN terms.state IS NULL             THEN 'member_without_terms'
                     WHEN terms.state <> 'active'         THEN 'member_not_active'
                     WHEN NOT team_role_can(terms.role, 'approve_payment')
                                                          THEN 'member_without_the_right'
                     ELSE                                      'member_with_the_right'
                   END
                 WHEN 'corgi_staff'              THEN 'corgi_staff_break_glass'
                 WHEN 'member_of_other_business' THEN 'approver_from_another_business'
                 WHEN 'non_human'                THEN 'not_a_person'
                 WHEN 'unattributable'           THEN 'no_membership_anywhere'
                 ELSE                                 'unknown_actor'
               END AS v
       ) verdict
 WHERE e.kind::text = 'approved';

COMMENT ON VIEW v_payment_approval_judged IS
  'REPORT, NOT AN INVARIANT. Every payment approval on this book with the kind of principal who filed it and the verdict on their right to. Expected to have rows; the invariant is the is_violation subset.';

-- The census.  `is_violation` is read from the view above rather than
-- restated here, so "inside the guard" cannot drift from the guard.
CREATE VIEW v_payment_approval_census AS
SELECT actor_scope, verdict, is_violation,
       count(*)                 AS approvals,
       count(DISTINCT actor_id) AS actors
  FROM v_payment_approval_judged
 GROUP BY actor_scope, verdict, is_violation;

COMMENT ON VIEW v_payment_approval_census IS
  'Every payment approval grouped by the kind of principal who filed it, and whether the invariant judges it. The denominator behind GUARD REACH.';

-- INVARIANT.  MUST RETURN ZERO ROWS.
--
-- 0033's claim, unchanged, over a population that is now the whole
-- population: no payment approval stands from a principal who did not
-- hold the right at that instant.  The only permitted non-member is
-- Corgi staff, and 0044 argues that exemption rather than inheriting it
-- from a join.
--
-- The first seven columns are 0033's, in 0033's order and types, because
-- CREATE OR REPLACE VIEW may only append.
CREATE OR REPLACE VIEW v_member_approval_without_right AS
SELECT j.event_id,
       j.instruction_id,
       j.actor_id,
       j.occurred_at,
       j.business_id,
       j.role_at_approval,
       j.state_at_approval,
       j.actor_scope,
       j.verdict,
       j.member_id
  FROM v_payment_approval_judged j
 WHERE j.is_violation;

COMMENT ON VIEW v_member_approval_without_right IS
  'MUST BE EMPTY. A payment approval by a principal who did not hold approve_payment at that instant: a member whose role and state did not carry it, a member of ANOTHER business, a non-human principal, or an actor with no membership anywhere. Corgi staff (business_id IS NULL, a member of nothing) are the one permitted non-member, per 0044. Widened from 0033 by 0046: the old INNER JOIN to team_member judged 33 of 186 approvals.';


-- ---------------------------------------------------------------------
-- 3.  MEMBER TERMS — every version, judged by who wrote it
-- ---------------------------------------------------------------------
--
-- 0044's lateral, kept verbatim in its clock and its strictness, wrapped
-- in a LEFT JOIN so that an author with no membership of that business
-- is classified instead of deleted.
--
-- THE THREE CLOCK CASES, and why there are three rather than two.
-- 0044 chose `v.created_at < tmv.created_at` — STRICTLY before — with an
-- argument this file has no business overturning: `created_at` defaults
-- to `now()`, which is the TRANSACTION timestamp, so two versions written
-- in one transaction carry the same instant and `<=` would let a change
-- made later in a transaction indict a write made earlier in it.  A guard
-- that can go red over something nobody did wrong is a guard people learn
-- to ignore.
--
-- But `<` also has a silent case of its own: an author who is a member of
-- the business whose own terms were written in the SAME instant as the
-- row they are authoring — an admin created and then adding somebody
-- inside one transaction.  Under 0044 that row simply has no author and
-- vanishes.  So it gets a THIRD verdict, `author_terms_concurrent`, and
-- it is PERMITTED and NAMED: the trigger already refuses the dangerous
-- half of that state, because `v_team_member_current` inside the same
-- transaction already reads `removed` for an author who removed
-- themselves.  Named and permitted is not the same as invisible, and this
-- is the difference the whole migration is about.
CREATE VIEW v_team_terms_judged AS
SELECT tmv.id             AS member_version_id,
       tmv.member_id,
       tm.business_id,
       tmv.version,
       tmv.state          AS terms_state,
       tmv.role           AS terms_role,
       tmv.created_at,
       tmv.created_by     AS author_actor_id,
       before.author_member_id,
       before.state       AS author_state_at_write,
       before.role        AS author_role_at_write,
       scope.kind         AS author_scope,
       verdict.v          AS verdict,
       verdict.v NOT IN ('active_admin_of_this_business',
                         'corgi_staff_break_glass',
                         'author_terms_concurrent')  AS is_violation
  FROM team_member_version tmv
  JOIN team_member tm ON tm.id = tmv.member_id
  CROSS JOIN LATERAL (
        SELECT team_actor_scope(tmv.created_by, tm.business_id) AS kind
       ) scope
  -- 0044's lateral, unchanged except for the LEFT.
  LEFT JOIN LATERAL (
        SELECT atm.id AS author_member_id, v.state, v.role
          FROM team_member atm
          JOIN team_member_version v ON v.member_id = atm.id
         WHERE atm.business_id = tm.business_id
           AND atm.actor_id    = tmv.created_by
           AND v.created_at    < tmv.created_at
         ORDER BY atm.membership_seq DESC, v.version DESC
         LIMIT 1
       ) before ON true
  -- Only consulted when the strict one found nothing: does the author hold
  -- ANY terms at or before this instant?  This separates "written in the
  -- same transaction" from "wrote somebody's terms before holding any".
  LEFT JOIN LATERAL (
        SELECT 1 AS at_or_before
          FROM team_member atm
          JOIN team_member_version v ON v.member_id = atm.id
         WHERE atm.business_id = tm.business_id
           AND atm.actor_id    = tmv.created_by
           AND v.created_at   <= tmv.created_at
         LIMIT 1
       ) concurrent ON true
  CROSS JOIN LATERAL (
        SELECT CASE scope.kind
                 WHEN 'member' THEN
                   CASE
                     WHEN before.state IS NULL AND concurrent.at_or_before IS NOT NULL
                                                    THEN 'author_terms_concurrent'
                     WHEN before.state IS NULL      THEN 'author_without_terms'
                     WHEN before.state <> 'active'  THEN 'author_not_active'
                     WHEN NOT team_role_can(before.role, 'administer_team')
                                                    THEN 'author_without_administer_team'
                     ELSE                                'active_admin_of_this_business'
                   END
                 WHEN 'corgi_staff'              THEN 'corgi_staff_break_glass'
                 WHEN 'member_of_other_business' THEN 'author_from_another_business'
                 WHEN 'non_human'                THEN 'not_a_person'
                 WHEN 'unattributable'           THEN 'no_membership_anywhere'
                 ELSE                                 'unknown_actor'
               END AS v
       ) verdict;

COMMENT ON VIEW v_team_terms_judged IS
  'REPORT, NOT AN INVARIANT. Every team_member_version with the kind of principal who wrote it and the verdict on their authority at that instant. Expected to have rows; the invariant is the is_violation subset.';

CREATE VIEW v_team_terms_author_census AS
SELECT author_scope, verdict, is_violation,
       count(*)                        AS member_versions,
       count(DISTINCT author_actor_id) AS authors
  FROM v_team_terms_judged
 GROUP BY author_scope, verdict, is_violation;

COMMENT ON VIEW v_team_terms_author_census IS
  'Every member-version row grouped by the kind of principal who authored it, and whether the invariant judges it. The denominator behind GUARD REACH.';

-- INVARIANT.  MUST RETURN ZERO ROWS.
--
-- 0044's claim over the whole table rather than over the 3 rows of it
-- whose author happened to hold a membership.  The eleven columns of
-- 0044's view, in 0044's order and types, plus two.
CREATE OR REPLACE VIEW v_team_terms_by_unauthorised_author AS
SELECT j.member_version_id,
       j.member_id,
       j.business_id,
       j.version,
       j.terms_state,
       j.terms_role,
       j.created_at,
       j.author_actor_id,
       j.author_member_id,
       j.author_state_at_write,
       j.author_role_at_write,
       j.author_scope,
       j.verdict
  FROM v_team_terms_judged j
 WHERE j.is_violation;

COMMENT ON VIEW v_team_terms_by_unauthorised_author IS
  'MUST BE EMPTY. A team_member_version written by somebody who, at the instant they wrote it, was not an ACTIVE holder of administer_team in that business: a member who was removed, suspended or wrongly roled, a member of ANOTHER business, a non-human principal, or an actor with no membership anywhere. Corgi staff (business_id IS NULL, a member of nothing) are the one permitted non-member, per 0044. Widened from 0044 by 0046: the old INNER LATERAL judged 3 of 422 rows.';


-- ---------------------------------------------------------------------
-- 4.  CARD AUTHORISATIONS — every approval, judged
-- ---------------------------------------------------------------------
--
-- THE SIBLING.  "If two team views share this shape, look for a third."
-- `v_approved_auth_for_dead_member` reads 11 of 26 approved
-- authorisation decisions by the same measure, and the mechanism is the
-- same one wearing a different join: `JOIN team_member_version tmv ON
-- tmv.id = d.member_version_id` is INNER, so a decision that pinned NO
-- member version is not reported as unjudgeable — it is not reported at
-- all.
--
-- The three unpinned cases are genuinely different and only one of them
-- is a fault:
--
--   'card_belongs_to_nobody'   the card exists and has no `card_member`
--                              row.  PERMITTED, and deliberately so:
--                              docs/TEAM.md §4 — "a card that belongs to
--                              no member is judged exactly as it was
--                              before this feature existed... rule 2
--                              draws the distinction between WE KNOW THE
--                              ANSWER IS NO MEMBER and WE DO NOT KNOW THE
--                              ANSWER, and the two get opposite
--                              defaults."  Every card in this book
--                              predates the feature.  11 rows.
--
--   'card_not_in_this_book'    the decision names a provider token this
--                              book has no `card` row for.  PERMITTED,
--                              because it is the other half of the same
--                              sentence — rule 2, `card_not_under_control`,
--                              approves by design.  3 rows, and they are
--                              in the census where somebody can count
--                              them, which is the only claim made here.
--
--   'card_is_held_but_unjudged'  the card DOES belong to a person, that
--                              binding existed at the instant of the
--                              decision, and the decision pinned no
--                              member version anyway.  A VIOLATION: it
--                              means the authorisation path approved a
--                              purchase for a named person without
--                              consulting their terms — a removed
--                              member's card spending because the bind
--                              lookup missed, which is precisely what
--                              rules 5 and 6 exist to stop.  0 rows
--                              today, and no guard on this build could
--                              have seen it.
--
-- And one that is not about pinning at all:
--
--   'pinned_version_wrong_member'  `member_version_id` names a version of
--                              a DIFFERENT member than `member_id`.  The
--                              two columns are denormalised side by side
--                              at the instant of the decision (0033 §6)
--                              and nothing constrains them to agree, so
--                              a decision could cite one person's limits
--                              while attributing the spend to another.
--                              0 rows today.
CREATE VIEW v_card_auth_member_judged AS
SELECT d.id            AS decision_id,
       d.decided_at,
       d.member_id,
       d.member_version_id,
       tmv.state       AS member_state_at_decision,
       d.amount_cents,
       d.rule,
       d.source,
       d.card_id,
       subject.kind    AS subject_scope,
       verdict.v       AS verdict,
       verdict.v NOT IN ('judged_under_active_terms',
                         'card_belongs_to_nobody',
                         'card_not_in_this_book')    AS is_violation
  FROM card_auth_decision d
  LEFT JOIN team_member_version tmv ON tmv.id = d.member_version_id
  -- The binding AS IT STOOD AT THE DECISION.  `card_member` is append-only
  -- and its PK is the card, so a card acquires a holder once and never
  -- loses one; without `assigned_at <= d.decided_at` a card bound to a
  -- person TODAY would retroactively indict every decision taken on it
  -- before anybody held it, which is the same retroactive-indictment trap
  -- 0044 named about the author clock.
  LEFT JOIN card_member cm ON cm.card_id     = d.card_id
                          AND cm.assigned_at <= d.decided_at
  CROSS JOIN LATERAL (
        SELECT CASE
                 WHEN d.member_version_id IS NOT NULL THEN 'version_pinned'
                 WHEN cm.member_id        IS NOT NULL THEN 'card_is_held'
                 WHEN d.card_id           IS NULL     THEN 'card_unknown'
                 ELSE                                      'card_unheld'
               END AS kind
       ) subject
  CROSS JOIN LATERAL (
        SELECT CASE subject.kind
                 WHEN 'version_pinned' THEN
                   CASE
                     WHEN tmv.id IS NULL THEN 'pinned_version_missing'
                     WHEN d.member_id IS DISTINCT FROM tmv.member_id
                                              THEN 'pinned_version_wrong_member'
                     WHEN tmv.state <> 'active' THEN 'judged_under_dead_terms'
                     ELSE                            'judged_under_active_terms'
                   END
                 WHEN 'card_is_held' THEN 'card_is_held_but_unjudged'
                 WHEN 'card_unknown' THEN 'card_not_in_this_book'
                 ELSE                     'card_belongs_to_nobody'
               END AS v
       ) verdict
 WHERE d.outcome = 'approve'
   AND d.request_status IN ('AUTHORIZATION', 'FINANCIAL_AUTHORIZATION');

COMMENT ON VIEW v_card_auth_member_judged IS
  'REPORT, NOT AN INVARIANT. Every approved card authorisation decision with what is known about the person it was decided for, and the verdict. Expected to have rows; the invariant is the is_violation subset.';

CREATE VIEW v_card_auth_member_census AS
SELECT subject_scope, verdict, is_violation,
       count(*)              AS decisions,
       sum(amount_cents)     AS amount_cents
  FROM v_card_auth_member_judged
 GROUP BY subject_scope, verdict, is_violation;

COMMENT ON VIEW v_card_auth_member_census IS
  'Every approved card authorisation decision grouped by what was known about its cardholder, and whether the invariant judges it. The denominator behind GUARD REACH.';

-- INVARIANT.  MUST RETURN ZERO ROWS.
--
-- 0033's claim, plus the two states its INNER JOIN could not express.
-- The eight columns of 0033's view, in 0033's order and types, plus
-- three.
CREATE OR REPLACE VIEW v_approved_auth_for_dead_member AS
SELECT j.decision_id,
       j.decided_at,
       j.member_id,
       j.member_version_id,
       j.member_state_at_decision,
       j.amount_cents,
       j.rule,
       j.source,
       j.subject_scope,
       j.verdict,
       j.card_id
  FROM v_card_auth_member_judged j
 WHERE j.is_violation;

COMMENT ON VIEW v_approved_auth_for_dead_member IS
  'MUST BE EMPTY. An approved card authorisation that was judged under member terms which were suspended or removed at that instant, OR was not judged against a person at all although the card demonstrably belonged to one. A card that belongs to nobody, and a token this book has no card row for, are the two permitted cases and are counted in v_card_auth_member_census. Widened from 0033 by 0046: the old INNER JOIN judged 11 of 26 decisions.';


-- ---------------------------------------------------------------------
-- 5.  GRANTS
-- ---------------------------------------------------------------------
--
-- SELECT only, matching every other view in this schema.  The three
-- replaced views keep their own ACLs through CREATE OR REPLACE; §6
-- checks that rather than assuming it.

GRANT SELECT ON v_payment_approval_judged     TO corgi_app;
GRANT SELECT ON v_payment_approval_census     TO corgi_app;
GRANT SELECT ON v_team_terms_judged           TO corgi_app;
GRANT SELECT ON v_team_terms_author_census    TO corgi_app;
GRANT SELECT ON v_card_auth_member_judged     TO corgi_app;
GRANT SELECT ON v_card_auth_member_census     TO corgi_app;


-- ---------------------------------------------------------------------
-- 6.  VERIFY RATHER THAN ASSUME
-- ---------------------------------------------------------------------
--
-- 0044 ends with a DO block that reads the catalogue back and aborts if
-- any of its claims is untrue.  This one does the same, with one
-- deliberate difference:
--
--     IT DOES NOT ABORT ON A NON-EMPTY INVARIANT.
--
-- 0044 could refuse to ship a guard that was already red, because it was
-- NARROWING nothing — its view was new and its population was a subset
-- nobody had looked at.  This migration WIDENS three guards over rows
-- that have never been judged, and a widened guard that goes red is the
-- finding, not a failed migration.  Refusing to apply would be exactly
-- the move this build keeps catching: making the guard fit the book.
-- What it asserts instead is the thing that is actually this file's
-- claim — that the guards now range over the WHOLE population.
DO $$
DECLARE
  v_judged   bigint;
  v_total    bigint;
  v_missing  text;
BEGIN
  -- (a) THE CLAIM: reach == population, for all three.
  SELECT count(*) INTO v_judged FROM v_payment_approval_judged;
  SELECT count(*) INTO v_total  FROM payment_instruction_event WHERE kind::text = 'approved';
  IF v_judged <> v_total THEN
    RAISE EXCEPTION
      '0046: v_payment_approval_judged sees % of % approvals -- the widened guard still drops rows',
      v_judged, v_total;
  END IF;

  SELECT count(*) INTO v_judged FROM v_team_terms_judged;
  SELECT count(*) INTO v_total  FROM team_member_version;
  IF v_judged <> v_total THEN
    RAISE EXCEPTION
      '0046: v_team_terms_judged sees % of % member-version rows -- the widened guard still drops rows',
      v_judged, v_total;
  END IF;

  SELECT count(*) INTO v_judged FROM v_card_auth_member_judged;
  SELECT count(*) INTO v_total  FROM card_auth_decision
   WHERE outcome = 'approve' AND request_status IN ('AUTHORIZATION','FINANCIAL_AUTHORIZATION');
  IF v_judged <> v_total THEN
    RAISE EXCEPTION
      '0046: v_card_auth_member_judged sees % of % approved decisions -- the widened guard still drops rows',
      v_judged, v_total;
  END IF;

  -- (b) Every row carries a verdict.  A NULL verdict would sort into the
  --     permitted side of `is_violation` and reproduce the defect inside
  --     the repair.
  IF EXISTS (SELECT 1 FROM v_payment_approval_judged WHERE verdict IS NULL OR is_violation IS NULL)
     OR EXISTS (SELECT 1 FROM v_team_terms_judged      WHERE verdict IS NULL OR is_violation IS NULL)
     OR EXISTS (SELECT 1 FROM v_card_auth_member_judged WHERE verdict IS NULL OR is_violation IS NULL)
  THEN
    RAISE EXCEPTION '0046: a judged row carries no verdict -- an unclassified row must never exist';
  END IF;

  -- (c) CREATE OR REPLACE VIEW kept the ACL. It does, by OID, but the
  --     whole point of this migration is that "it does by construction"
  --     is how three guards came to see a fifth of their table.
  SELECT string_agg(v, ', ') INTO v_missing
    FROM (VALUES ('v_member_approval_without_right'),
                 ('v_team_terms_by_unauthorised_author'),
                 ('v_approved_auth_for_dead_member'),
                 ('v_payment_approval_judged'),
                 ('v_payment_approval_census'),
                 ('v_team_terms_judged'),
                 ('v_team_terms_author_census'),
                 ('v_card_auth_member_judged'),
                 ('v_card_auth_member_census')) AS t(v)
   WHERE NOT has_table_privilege('corgi_app', t.v, 'SELECT');
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION '0046: corgi_app cannot read %', v_missing;
  END IF;

  -- (d) The classifier is reachable by the application role, and it
  --     answers. A guard whose helper corgi_app cannot execute reads as
  --     "could not be read" in dbcheck, which is a FAIL, not a pass.
  IF NOT has_function_privilege('corgi_app', 'team_actor_scope(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '0046: corgi_app cannot execute team_actor_scope()';
  END IF;
END $$;
