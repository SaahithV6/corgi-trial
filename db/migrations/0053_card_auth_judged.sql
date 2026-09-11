-- 0053  An approval that judged nothing is not an approval that was judged
-- ---------------------------------------------------------------------
--
-- MEASURED ON THIS BOOK, 2026-09-11, whole history of `card_auth_decision`
-- (145 rows), re-measured rather than inherited from an earlier audit:
--
--     92 approvals in total, 63 of them on the PROVIDER lane
--
--     provider lane, by rule
--       44  no_controls_configured    approve   control_version_id NULL
--       11  card_not_under_control    approve   card_id NULL
--        8  within_controls           approve
--
--     936 cards.  44 carry any control version at all.
--       under_control  45      member_only  137      uncontrolled  756
--
-- Fifty-five of sixty-three provider-lane approvals — 87% — were produced
-- by a branch of `decide()` that returned APPROVE WITHOUT CONSULTING A
-- SINGLE CONTROL.  Neither branch is a defect.  Both are deliberate,
-- documented and unit-tested: `no_controls_configured` is "approve unless
-- told otherwise" for a card nobody has configured, and
-- `card_not_under_control` is the fail-OPEN at the scope boundary that
-- stops an ASA enrolment turning into a program-wide outage.  The
-- arguments are in src/lib/cards/decide.ts and neither is changed here.
--
-- THE DEFECT IS IN THE EVIDENCE, NOT IN THE DECISION.  All 63 rows carry
-- `outcome = 'approve'` and nothing more.  A reader counting approvals to
-- show that card controls work — a screen, an MCP client, a scoreboard,
-- a person in a debrief — counts 63 and is wrong by a factor of eight,
-- because a card with no controls is INDISTINGUISHABLE in that column
-- from a card whose controls said yes.  That is this repository's
-- recurring failure in its most ordinary form: the guard reports healthy
-- because the population it excluded is shaped exactly like the failure
-- it exists to catch.
--
-- ---------------------------------------------------------------------
-- WHY THERE IS NO NEW COLUMN AND NO BACKFILL
-- ---------------------------------------------------------------------
--
-- The obvious implementation is `card_auth_decision.judged boolean`.  It
-- is not done, for three reasons in order of weight:
--
--   1.  THE FACT IS ALREADY IN THE ROW.  `rule` is NOT NULL and has been
--       written on every decision this log has ever taken, and the
--       classification is TOTAL over the closed rule set — every rule is
--       wholly judged or wholly unjudged, by its own predicate.  So all
--       145 existing rows classify correctly with no backfill, and a
--       backfill that cannot be wrong is a backfill that need not exist.
--
--   2.  A STORED COLUMN CAN DISAGREE WITH THE RULE BESIDE IT.  Two
--       statements of one fact in one row is how a log starts lying.
--
--   3.  `card_auth_decision` IS WRITTEN BY MORE THAN THE APPLICATION —
--       scripts/dbcheck.mjs inserts into it directly to prove its own
--       invariants.  A NOT NULL column with no default would break those
--       writers; a column with a default of `true` would quietly record
--       the exact over-claim this migration exists to remove.
--
-- What the decision function does now write is `inputs.judged` — its OWN
-- statement, on rows taken from this build onward, so a dispute six
-- months from now reads the verdict's words rather than a reader's
-- classification of them.  `src/lib/cards/decide.test.ts` asserts the two
-- agree for every rule, and `src/lib/cards/judged.integration.test.ts`
-- asserts that THIS FILE's SQL list and the TypeScript list in
-- src/lib/cards/types.ts (`UNJUDGED_RULES`) are the same set — the only
-- thing that could make the screens and the database disagree.
--
-- ---------------------------------------------------------------------
-- THE DEFINITION, AND WHY IT PUTS FIVE RULES ON THE LIST AND NOT THREE
-- ---------------------------------------------------------------------
--
--     A decision is JUDGED when at least one control this book holds — a
--     card control version, or a member's terms — was compared with the
--     request AND COULD HAVE REFUSED IT.
--
--   control_store_unavailable       nothing was read, so nothing was
--                                   compared.  It DECLINES, and it is on
--                                   this list anyway: `judged` is a
--                                   statement about whether a control ran,
--                                   not about which way it went, and
--                                   keeping it orthogonal to `outcome` is
--                                   what makes "a decline nobody judged"
--                                   countable too.  9 rows.
--   card_not_under_control          the token is not in this book.  11.
--   no_controls_configured          predicate is literally
--                                   `controls IS NULL AND member IS NULL`,
--                                   so it cannot fire where anything
--                                   existed to compare.  44.
--   balance_inquiry_not_a_purchase  fires at position 3 of RULE_ORDER,
--                                   BEFORE card_frozen at position 7 — so
--                                   a balance inquiry on a FROZEN card is
--                                   approved and no control could have
--                                   stopped it.  0 rows today; on the
--                                   list because the ordering says it
--                                   belongs there, not because it is
--                                   currently inconvenient.
--   credit_not_a_purchase           same position, same reason.  0 rows.
--
-- Everything else names the control it compared in its own name, and
-- `within_controls` is reachable ONLY when `no_controls_configured`'s
-- predicate was false — that is, only when a control version or a member
-- existed.  So the classification is mechanical, and this list is the
-- whole of it.

-- ---------------------------------------------------------------------
-- 1.  Every decision, classified
-- ---------------------------------------------------------------------
--
-- REPORT, NOT AN INVARIANT.  It is expected to have rows, and a non-zero
-- `unjudged` count is a FACT ABOUT THE ESTATE, not a violation: 756 of
-- this book's 936 cards have no controls and no holder, which is what
-- `v_card_control_coverage` (migration 0051) counts and what the coverage
-- panel on /accounts shows.  Nothing here declines anything that was
-- approved before, and nothing here changes a decision.

CREATE VIEW v_card_auth_decision_judged AS
SELECT d.id                AS decision_id,
       d.decided_at,
       d.provider,
       d.provider_card_token,
       d.card_id,
       d.control_version_id,
       d.member_id,
       d.amount_cents,
       d.request_status,
       d.outcome,
       d.result_code,
       d.rule,
       d.source,
       -- THE ONE EXPRESSION.  Mirrored from UNJUDGED_RULES in
       -- src/lib/cards/types.ts; a test asserts the two sets are equal.
       -- A rule this migration has never heard of reports JUDGED, the
       -- same direction the TypeScript takes and for the same reason:
       -- over-reporting the unjudged count would manufacture a finding.
       (d.rule NOT IN ('control_store_unavailable',
                       'card_not_under_control',
                       'no_controls_configured',
                       'balance_inquiry_not_a_purchase',
                       'credit_not_a_purchase'))           AS judged,
       -- What the decision function ITSELF said, on rows written from the
       -- build that added it.  NULL on every earlier row, and that NULL is
       -- the honest answer: those rows predate the field.  Kept beside the
       -- derivation rather than instead of it so the two can be compared.
       (d.inputs ->> 'judged')::boolean                     AS judged_recorded
  FROM card_auth_decision d;

COMMENT ON VIEW v_card_auth_decision_judged IS
  'REPORT, NOT AN INVARIANT. Every real-time card authorisation decision with whether ANY control this book holds was compared with it. judged = false on an approve means nothing said yes, because nothing said anything: the card had no control version and no holder, or the token is not one this book issues controls for. Expected to have rows. The number that matters is the unjudged share of approvals, which is what v_card_auth_judged_census counts.';

GRANT SELECT ON v_card_auth_decision_judged TO corgi_app;

-- ---------------------------------------------------------------------
-- 2.  The census — the denominator the "51 approvals" claim needed
-- ---------------------------------------------------------------------
--
-- Split by `source` because the two lanes are not the same claim and
-- merging them is how a harness replay ends up counted as evidence that
-- the provider drove a decision.  `provider` is Lithic calling us inside
-- its own timeout; `harness` is us replaying a payload through the same
-- code.  Both are real; only one of them is the network.

CREATE VIEW v_card_auth_judged_census AS
SELECT source,
       outcome,
       judged,
       count(*)                    AS decisions,
       sum(amount_cents)           AS amount_cents,
       min(decided_at)             AS first_decided_at,
       max(decided_at)             AS last_decided_at
  FROM v_card_auth_decision_judged
 GROUP BY source, outcome, judged;

COMMENT ON VIEW v_card_auth_judged_census IS
  'Card authorisation decisions grouped by lane, outcome and whether a control was actually compared. The honest denominator behind any claim of the form "N authorisations were approved by the control system": subtract the judged = false rows, because no control was consulted on them.';

GRANT SELECT ON v_card_auth_judged_census TO corgi_app;

-- ---------------------------------------------------------------------
-- 3.  The approvals nothing judged, listed
-- ---------------------------------------------------------------------
--
-- NOT AN INVARIANT AND DELIBERATELY NOT NAMED LIKE ONE.  It has 55 rows
-- today and it is SUPPOSED to: each one is a correct decision under a
-- documented fail-open.  It exists so the population is enumerable rather
-- than inferred — an operator asking "which authorisations went through
-- without anything checking them, and on whose cards" gets a list with
-- the card and the reason on it, and can go and set a control.
--
-- The join to `card` is by TOKEN as well as by id, for the same reason
-- `listDecisions()` in src/lib/cards/store.ts does it: `card_id` is NULL
-- on exactly the rows this view is about, and resolving the business only
-- through `card_id` would hide them from the customer they belong to.

CREATE VIEW v_card_auth_approval_unjudged AS
SELECT j.decision_id,
       j.decided_at,
       j.rule,
       j.source,
       j.amount_cents,
       j.provider_card_token,
       COALESCE(j.card_id, ct.id)          AS card_id,
       ct.business_id,
       ct.last_four,
       ct.nickname
  FROM v_card_auth_decision_judged j
  LEFT JOIN card ct ON ct.provider            = j.provider
                   AND ct.provider_card_token = j.provider_card_token
 WHERE j.outcome = 'approve'
   AND j.judged  = false;

COMMENT ON VIEW v_card_auth_approval_unjudged IS
  'REPORT, NOT AN INVARIANT — 55 rows on this book and each one is a correct decision. Every authorisation this system approved without comparing it with a single control, with the card it was on so an operator can go and set one. A non-zero count is an estate fact (see v_card_control_coverage), not a violation; what would be a violation is counting these as evidence that card controls work.';

GRANT SELECT ON v_card_auth_approval_unjudged TO corgi_app;
