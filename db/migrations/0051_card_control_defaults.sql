-- =====================================================================
-- 0051  A newly-issued card is born under a control, and the cards that
--       are not are COUNTABLE instead of inferable from an approval.
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- THE FINDING, MEASURED ON THE LIVE BOOK BEFORE ANYTHING HERE WAS WRITTEN
-- ---------------------------------------------------------------------
--
--   SELECT source, outcome, rule, count(*) FROM card_auth_decision ...
--
--     128 decisions, 68 of them in the provider lane.
--     Of 51 provider approvals:
--         no_controls_configured   38
--         card_not_under_control   10
--         within_controls           3
--
--   SELECT count(*), count(*) FILTER (WHERE EXISTS (
--            SELECT 1 FROM card_control_version v WHERE v.card_id = c.id))
--     FROM card c;
--
--     911 cards.  31 with any control version at all.
--
-- FORTY-EIGHT OF FIFTY-ONE APPROVALS WERE PRODUCED BY A RULE THAT JUDGED
-- NOTHING.  The feature was proven — ten real Lithic transactions on
-- 2026-09-11 drove per-card limits, MCC blocks, a per-member limit summed
-- across two cards, the deliberate fail-open and the fail-closed decline,
-- at a p50 of 14.2 ms against a 6000 ms provider ceiling — and then it sat
-- over a book where almost no card was under it.
--
-- ---------------------------------------------------------------------
-- WHY.  IT IS NOT `decide()`, AND IT IS NOT A SCHEMA DEFECT
-- ---------------------------------------------------------------------
--
-- Rule 15, `no_controls_configured`, is INTENDED.  The control read
-- succeeded and told the truth: nobody has said anything about this card,
-- so it approves, and the row records `fail_mode` accordingly.  That is
-- the same fail-OPEN argument rule 2 makes at the scope boundary, it is
-- unit-tested, and turning it into a decline would refuse live cards for a
-- reason no customer chose.  0051 does not touch it.
--
-- The gap is PROVISIONING.  Before this migration, `setCardControls()` had
-- exactly one caller in the tree: the `/accounts` server action, reachable
-- only by a human pressing Save.  Both issuance paths —
-- `issueCardAction()` for the console and `issueCardForMember()` for the
-- team — call Lithic's `createCard()`, then `registerCard()`, and stop.  A
-- card was born with no controls unless somebody remembered.  Thirty-one
-- people remembered out of nine hundred and eleven cards.
--
-- So: an intended default sitting on top of an unintended gap, and only
-- the second one is a bug.
--
-- ---------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES AND, MORE IMPORTANTLY, WHAT IT DOES NOT
-- ---------------------------------------------------------------------
--
-- It does TWO things:
--
--   1. creates the `system` actor that version 1 of a default control set
--      is attributed to, and
--   2. creates `v_card_control_coverage`, so "how many of this business's
--      cards are under control" is one aggregate rather than a join an
--      operator has to remember how to write.
--
-- IT WRITES NO CONTROL VERSIONS.  Not one, not even for the cards this
-- book is about to backfill.  `card_control_version` has exactly one
-- writer in this system and it is the application — `setCardControls()`
-- for a human's change, `applyDefaultControls()` for the program default.
-- A migration that INSERTed control rows would be a SECOND writer of the
-- values the card network receives inside Lithic's authorisation window,
-- which is precisely the surface `src/lib/mcp/limits.ts` and
-- `src/lib/api/limits.ts` argue must stay narrow: a control change IS an
-- authorisation decision made in advance, with no person on the path.
-- Adding a door in SQL because SQL was convenient would undo that
-- argument in the one file nobody re-reads.
--
-- The backfill of this book's named demo cards therefore runs THROUGH
-- `applyDefaultControls()`, is enumerated card by card in
-- docs/CARD-CONTROLS.md §11, and leaves the same `created_by`, the same
-- figures and the same version-1 shape a newly-issued card gets.
--
-- AND THERE IS NO TRIGGER.  An `AFTER INSERT ON card` trigger would cover
-- every path at once and it is the obvious implementation, but it would
-- make an uncontrolled card UNREPRESENTABLE — and `no_controls_configured`
-- is a branch this system must keep being able to reach, because a
-- fail-open that cannot be produced is a fail-open that cannot be tested.
-- `cards.integration.test.ts` and the panel's `?controls=empty` state both
-- need a card that has never had a control set.  The long form of the
-- argument is in the header of `src/lib/cards/defaults.ts`.
--
-- NOTHING HERE IS ON THE HOT PATH.  `readControlsAndSpend()` is untouched:
-- one statement, one `LEFT JOIN v_card_control_current`, two
-- `CROSS JOIN LATERAL` aggregates, one 600 ms deadline.  A card with a
-- default control version resolves through the join that was already
-- there.  The view below is read by a server component and by nothing
-- else; the decision path holds a card token, not a business id, and
-- could not call it if it wanted to.  A control that is correct and late
-- is a decline, so no round trip was added anywhere near it.

-- ---------------------------------------------------------------------
-- 1.  Who version 1 belongs to
-- ---------------------------------------------------------------------
--
-- `card_control_version.created_by` is the first column read in a dispute.
-- Putting the issuing operator's name on version 1 would assert that they
-- set a $5,000 per-transaction limit, which they did not do: they issued a
-- card and the program applied its default.  So version 1 gets a machine
-- principal, exactly as `ledger-poster` and `webhook-dispatcher` already
-- exist so that "who applied this" and "who chose this" stay two separate
-- answerable questions.
--
-- The id is not random.  It is `uuid5("actor:system.card-controls")` under
-- the seed's own namespace (`scripts/seed.mjs`), so a book rebuilt from
-- zero and this one agree on it, and `DEFAULT_CONTROL_ACTOR_ID` in
-- `src/lib/cards/defaults.ts` is the same 36 characters.
--
-- `can_approve` is false and `actor_only_humans_approve` (0001) makes it
-- unrepresentable otherwise, which is the right guarantee to inherit here:
-- the actor that applies a default limit must never be able to approve a
-- payment.
--
-- ON CONFLICT DO NOTHING because a book seeded after this ships may create
-- the same actor from `scripts/seed.mjs`, and a migration that fights the
-- seeder for a row they agree about is a migration that fails on a rebuild.

INSERT INTO actor (id, kind, display_name, email, business_id, can_approve)
VALUES (
  'b23a047b-e495-5f80-bf40-cd6396b77280',
  'system',
  'card-control-default',
  NULL,
  NULL,
  false
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON COLUMN card_control_version.created_by IS
  'Who authored this version. Version 1 of a card issued through a path that applies the program default is the system actor card-control-default; every later version is a human on the console. So "did a person choose this limit" is one join, not a guess.';

-- ---------------------------------------------------------------------
-- 2.  The coverage view — `no_controls_configured` made countable
-- ---------------------------------------------------------------------
--
-- THE THREE BUCKETS ARE THE THREE BRANCHES `decide()` ACTUALLY TAKES.
-- That is why they are these three and not a pair of configured/not:
--
--   under_control   a control version exists.  Judged by rules 7 to 11
--                   (frozen, MCC, per-txn, daily, monthly) and the
--                   decision row pins `control_version_id`.
--
--   member_only     no control version, but the card belongs to a team
--                   member, so rules 5, 6 and 12 to 14 judge it by the
--                   PERSON's terms.  Rule 15's predicate is
--                   `controls IS NULL AND member IS NULL` — a card with a
--                   holder HAS been judged, and calling it "no controls"
--                   on a screen would be false in the direction that
--                   makes an operator do unnecessary work.
--
--   uncontrolled    neither.  Every purchase on this card is approved by
--                   rule 15, having been compared with nothing.  This is
--                   the number the finding above is about, and it is the
--                   number that should fall.
--
-- `has_member` is the bare EXISTS and not "has a member WITH limits",
-- deliberately.  A member with every limit NULL is still a member: rules
-- 5 and 6 (removed, suspended) fire on their STATE regardless of their
-- terms, so their card is not in the same position as a card nobody
-- holds.  Collapsing the two would report Theo's card — whose holder is
-- removed, and whose every authorisation therefore declines — as
-- uncontrolled.
--
-- No index is added.  This is an aggregate over `card` for one business,
-- read by a server component; `card` is 911 rows on the busiest book this
-- system has, the two EXISTS clauses hit `card_control_version_card_idx`
-- and `card_member`'s primary key, and an index the planner is declining
-- to use is schema nobody can explain.  The same argument §3 of
-- docs/CARD-CONTROLS.md makes about the two remaining seq scans.

CREATE VIEW v_card_control_coverage AS
SELECT c.id                AS card_id,
       c.business_id,
       c.provider,
       c.provider_card_token,
       c.last_four,
       c.nickname,
       c.created_at,
       cc.version          AS control_version,
       cc.card_state,
       cm.member_id,
       (cc.card_id IS NOT NULL) AS has_controls,
       (cm.member_id IS NOT NULL) AS has_member,
       CASE
         WHEN cc.card_id IS NOT NULL   THEN 'under_control'
         WHEN cm.member_id IS NOT NULL THEN 'member_only'
         ELSE 'uncontrolled'
       END AS cover
  FROM card c
  LEFT JOIN v_card_control_current cc ON cc.card_id = c.id
  LEFT JOIN card_member cm            ON cm.card_id = c.id;

COMMENT ON VIEW v_card_control_coverage IS
  'One row per card, classified by WHAT WOULD JUDGE ITS NEXT AUTHORISATION: its own control version, its holder''s terms, or nothing at all (rule no_controls_configured). The operator''s answer to "how much of this estate is actually under the real-time decision path".';

GRANT SELECT ON v_card_control_coverage TO corgi_app;
