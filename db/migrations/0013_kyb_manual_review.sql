-- =====================================================================
-- 0013_kyb_manual_review.sql  ·  Corgi work trial, Track 3
--
-- THE OPERATOR DECISION: what a KYB queue is for.
--
-- WHY THIS EXISTS
--
-- 0005 stored two legs of provider evidence and derived the answer. When
-- the business-registry leg moved onto GLEIF -- a real registry, queried
-- live -- every seeded business came back `not_in_lei_registry`, because
-- GLEIF's population is financial-market participants and a perfectly
-- ordinary small company is simply absent from it.  That is the CORRECT
-- registry answer: a hit is strong evidence, a miss is evidence of
-- nothing, and a miss must never approve on its own.
--
-- But `needs_review` is a QUEUE, not a verdict, and 0005 gave nobody a
-- way to act on it.  So an honest registry answer became a permanently
-- stuck account: leg 5 of the core loop -- an outbound payment needing a
-- second approver -- could not run at all, because canTransact() refused
-- every business on the book.
--
-- The wrong fixes were: weaken the gate, or invent an LEI for a demo
-- company.  The right one is what a real KYB operation does with a
-- registry miss -- a named human reviews it, on the record.
--
-- THE SHAPE
--
-- A review is ANOTHER OBSERVATION.  Same table, same append-only rule,
-- same "latest per (business, leg) wins" fold, so an override needs no
-- special case in the view and no second source of truth: it is simply
-- the most recent thing anybody said about that leg.  A reversal is a
-- further row.  There is still no UPDATE grant and no DELETE grant.
--
-- What is new is that a row can now name a PERSON instead of a vendor,
-- and the evidence lattice grew a third value to say so.
--
--   live       a third party we do not control produced this answer.
--   manual     a named operator decided it, with a written reason.
--   simulated  WE produced it.  Not verification of anything.
--
-- A human is not a third party.  Putting an operator's decision under
-- 'live' would be the exact forgery this schema exists to forbid, and
-- leaving it at 'simulated' would be a lie in the other direction -- a
-- documented decision by a named accountable person is not a simulator's
-- output.  So it gets its own label, ordered BETWEEN the two, and the
-- existing "worst leg wins" rule then makes the composite honest by
-- itself: a live director leg plus a manually-approved registry leg is a
-- verification labelled `manual`, for ever, with no path back to `live`.
--
-- DECLARATION ORDER IS LOAD-BEARING HERE TOO, exactly as it is for
-- kyb_status in 0005.  'manual' is inserted BEFORE 'simulated' so that
-- max(evidence) over the legs IS "the weakest evidence any leg rests on",
-- and the view below can drop its bool_and() special case for a max()
-- that reads the same way the status rule does.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.  The third evidence label
-- ---------------------------------------------------------------------

-- NOTE ON TRANSACTIONS.  scripts/migrate.mjs runs each file in ONE
-- transaction, and Postgres refuses to USE an enum value added in the
-- same transaction that added it ("unsafe use of new value").  Every
-- constraint below therefore compares `evidence::text = 'manual'` rather
-- than `evidence = 'manual'`: a text comparison needs no enum literal to
-- resolve at DDL time, and the view uses max() rather than naming the
-- new label at all.  Measured against this database before writing it.
ALTER TYPE kyb_evidence ADD VALUE IF NOT EXISTS 'manual' BEFORE 'simulated';

-- ---------------------------------------------------------------------
-- 2.  WHO decided, and WHY
-- ---------------------------------------------------------------------

-- Columns, not a jsonb blob.  "Who approved this business, and on what
-- grounds" is the first question a regulator asks and the last one a
-- free-text bag answers well: a column can be joined, indexed, and made
-- NOT NULL by a constraint, and `checks` already exists for the provider's
-- own prose.
ALTER TABLE kyb_verification_leg
  ADD COLUMN decided_by_actor_id uuid,
  -- Carried alongside the id ONLY so the foreign key below can constrain
  -- it.  See the constraint's comment: this is what makes "an agent
  -- approved a KYB leg" unrepresentable rather than merely checked.
  ADD COLUMN decided_by_kind     actor_kind,
  ADD COLUMN decision_reason     text;

-- 0001 already refuses an agent that can approve money
-- (actor_only_humans_approve).  KYB review is a different authority and
-- needs its own statement of the same rule.  A composite foreign key on
-- (id, kind) plus a CHECK pinning kind to 'human' means the database
-- itself will not accept a KYB decision attributed to an agent or a
-- system actor -- an absent capability, not a code path somebody has to
-- remember to write.
ALTER TABLE actor
  ADD CONSTRAINT actor_id_kind_uniq UNIQUE (id, kind);

ALTER TABLE kyb_verification_leg
  ADD CONSTRAINT kyb_leg_reviewer_fk
    FOREIGN KEY (decided_by_actor_id, decided_by_kind) REFERENCES actor (id, kind);

ALTER TABLE kyb_verification_leg
  -- A manual row names a reviewer; a provider row must not, in either
  -- direction.  Written as an equality of two predicates so neither half
  -- can be added without the other.
  ADD CONSTRAINT kyb_leg_manual_has_reviewer CHECK (
    (evidence::text = 'manual') = (decided_by_actor_id IS NOT NULL)
  ),
  ADD CONSTRAINT kyb_leg_reviewer_kind_matches CHECK (
    decided_by_actor_id IS NULL OR decided_by_kind IS NOT NULL
  ),
  -- ONLY A HUMAN.  See actor_id_kind_uniq above.
  ADD CONSTRAINT kyb_leg_reviewer_is_human CHECK (
    decided_by_kind IS NULL OR decided_by_kind = 'human'
  ),
  -- A REASON IS REQUIRED, AND "ok" IS NOT A REASON.  The floor is
  -- deliberately low enough to be no obstacle to a real explanation and
  -- high enough that a rubber stamp has to be typed out on purpose.
  ADD CONSTRAINT kyb_leg_manual_has_reason CHECK (
    evidence::text <> 'manual' OR length(btrim(decision_reason)) >= 20
  ),
  ADD CONSTRAINT kyb_leg_reason_only_when_manual CHECK (
    evidence::text = 'manual' OR decision_reason IS NULL
  ),
  -- The mirror of kyb_leg_simulated_reference: an operator's decision
  -- cannot be filed under a vendor's name or claim to be a third party's
  -- answer.  src/lib/kyb/manual-review.ts writes provider
  -- 'operator-review' and a reference prefixed 'manual.'.
  ADD CONSTRAINT kyb_leg_manual_reference CHECK (
    evidence::text <> 'manual'
    OR (provider = 'operator-review' AND provider_reference LIKE 'manual.%')
  ),
  ADD CONSTRAINT kyb_leg_operator_is_not_a_provider CHECK (
    provider <> 'operator-review' OR evidence::text = 'manual'
  );

CREATE INDEX kyb_verification_leg_reviewer_idx
  ON kyb_verification_leg (decided_by_actor_id)
  WHERE decided_by_actor_id IS NOT NULL;

COMMENT ON COLUMN kyb_verification_leg.decided_by_actor_id IS
  'The human who decided this leg by review. NULL on every provider observation; NOT NULL on every manual one, enforced both ways.';
COMMENT ON COLUMN kyb_verification_leg.decision_reason IS
  'Required free text on a manual decision. The record of WHY a registry answer was overridden, which is the whole point of allowing it.';

-- ---------------------------------------------------------------------
-- 3.  The derived state, with one special case removed
-- ---------------------------------------------------------------------

-- The only change to the rule is that `bool_and(evidence = 'live')` --
-- a two-valued test that cannot express a third label -- becomes
-- `max(evidence)`, which is the SAME "worst wins" fold already used for
-- status and is correct for exactly the same reason: enum declaration
-- order.  A business with fewer than two legs is still 'pending' and
-- still 'simulated'; a verification half of which was never performed
-- has not passed, whoever reviewed the other half.
CREATE OR REPLACE VIEW v_business_kyb AS
WITH latest AS (
  SELECT DISTINCT ON (business_id, leg)
         business_id, leg, provider, provider_reference,
         status, evidence, raw_status, observed_at
    FROM kyb_verification_leg
   ORDER BY business_id, leg, observed_at DESC, recorded_at DESC, seq DESC
),
rolled AS (
  SELECT business_id,
         count(*)            AS legs_on_file,
         max(status)         AS strictest_status,
         max(evidence)       AS weakest_evidence,
         max(observed_at)    AS last_observed_at
    FROM latest
   GROUP BY business_id
)
SELECT b.id                                        AS business_id,
       b.legal_name,
       COALESCE(r.legs_on_file, 0)                 AS legs_on_file,
       CASE
         WHEN COALESCE(r.legs_on_file, 0) < 2 THEN 'pending'::kyb_status
         ELSE r.strictest_status
       END                                         AS kyb_status,
       CASE
         WHEN COALESCE(r.legs_on_file, 0) < 2 THEN 'simulated'::kyb_evidence
         ELSE r.weakest_evidence
       END                                         AS kyb_evidence,
       r.last_observed_at                          AS decided_at,
       (SELECT l.provider           FROM latest l WHERE l.business_id = b.id AND l.leg = 'director_kyc')      AS director_provider,
       (SELECT l.provider_reference FROM latest l WHERE l.business_id = b.id AND l.leg = 'director_kyc')      AS director_reference,
       (SELECT l.status             FROM latest l WHERE l.business_id = b.id AND l.leg = 'director_kyc')      AS director_status,
       (SELECT l.evidence           FROM latest l WHERE l.business_id = b.id AND l.leg = 'director_kyc')      AS director_evidence,
       (SELECT l.provider           FROM latest l WHERE l.business_id = b.id AND l.leg = 'business_registry') AS registry_provider,
       (SELECT l.provider_reference FROM latest l WHERE l.business_id = b.id AND l.leg = 'business_registry') AS registry_reference,
       (SELECT l.status             FROM latest l WHERE l.business_id = b.id AND l.leg = 'business_registry') AS registry_status,
       (SELECT l.evidence           FROM latest l WHERE l.business_id = b.id AND l.leg = 'business_registry') AS registry_evidence
  FROM business b
  LEFT JOIN rolled r ON r.business_id = b.id;

COMMENT ON VIEW v_business_kyb IS
  'Derived KYB state per business: strictest status across both legs, weakest evidence across both legs (live < manual < simulated). Read by canTransact() in src/lib/kyb/types.ts. There is deliberately no stored copy of these two columns.';

-- ---------------------------------------------------------------------
-- 4.  Privileges
-- ---------------------------------------------------------------------

-- Table-level grants cover columns added later, so the app can write a
-- review row and still cannot rewrite one.  Restated rather than assumed,
-- because "the grant probably still covers it" is how a privilege gap
-- ships.
GRANT SELECT, INSERT ON kyb_verification_leg TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON kyb_verification_leg FROM corgi_app, PUBLIC;
GRANT SELECT ON v_business_kyb TO corgi_app;
-- The reviewer is resolved by joining actor; the app already reads it.
GRANT SELECT ON actor TO corgi_app;
