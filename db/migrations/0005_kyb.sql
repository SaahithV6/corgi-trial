-- =====================================================================
-- 0005_kyb.sql  ·  Corgi work trial, Track 3
--
-- KYB / KYC state: the evidence a business's verification rests on, and
-- the gate that stops an unverified entity moving money.
--
-- THE SHAPE, AND WHY IT IS THIS SHAPE
--
-- There is no `business.kyb_status` column and no `business.kyb_evidence`
-- column.  That is the whole design, not an omission.
--
-- A composite verification is TWO legs -- a director KYC leg and a
-- business-registry leg -- and its overall status is the STRICTER of the
-- two while its evidence label degrades to 'simulated' if EITHER leg was
-- simulated.  Store that overall answer in a column and you have created
-- a second source of truth, one UPDATE away from claiming a business was
-- verified live when half its evidence was manufactured.  So the legs are
-- stored, append-only, and the overall answer is DERIVED by a view every
-- time it is read.  There is no column to forge.
--
-- The same rule is stated twice more, in code:
--   * src/lib/kyb/types.ts   `DegradeEvidence<A,B>` -- at the type level.
--   * src/lib/kyb/composite.ts  `CompositeKybResult` -- no evidence field
--     exists to set; it is a getter over private leg state.
-- Three independent statements of one invariant, none of them a comment.
--
-- Conventions inherited from 0001: uuid primary keys, timestamptz for
-- every instant, and enums only for vocabularies that are OURS.
-- `provider` is plain text for the same reason it is in webhook_inbox --
-- a sixth provider must never require a migration.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.  Vocabularies
-- ---------------------------------------------------------------------

-- DECLARATION ORDER IS LOAD-BEARING.  Postgres orders an enum by the
-- order its labels are declared, so `max(status)` over a set of legs IS
-- "the strictest status", and `a > b` reads as "a blocks more than b".
-- The order matches KYB_STATUS_STRICTNESS in src/lib/kyb/types.ts, and
-- v_business_kyb below depends on it.
--
--   approved      nothing is blocked.  The ONLY status that permits
--                 transacting.
--   pending       a provider has not answered yet.  Resolves by waiting.
--   needs_review  a human has to act: a review, an expired inquiry, an
--                 error code this build does not recognise.
--   rejected      a decision to say no.  Terminal.
CREATE TYPE kyb_status AS ENUM ('approved', 'pending', 'needs_review', 'rejected');

-- 'live'      a third party we do not control produced this answer.
-- 'simulated' WE produced it.  Useful, reproducible, and not verification
--             of anything.  There is deliberately no third value:
--             "partly live" is the state this schema exists to forbid.
CREATE TYPE kyb_evidence AS ENUM ('live', 'simulated');

-- The two halves of KYB.  Persona answers the first (their business
-- verification is sales-gated -- see src/lib/kyb/README.md), Stripe
-- Connect test mode answers the second.
CREATE TYPE kyb_leg AS ENUM ('director_kyc', 'business_registry');

-- ---------------------------------------------------------------------
-- 2.  The evidence: one row per observation, append-only
-- ---------------------------------------------------------------------

-- NOT a money table, and the same reasoning as webhook_inbox: it records
-- what a third party told us, so it is immutable.  A status that changes
-- is a NEW ROW, not an UPDATE -- which means the history of a decision is
-- the table, and "when did this business become approved, and on whose
-- word" is a query rather than an archaeology exercise.
CREATE TABLE kyb_verification_leg (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The tiebreak, and it is load-bearing.  "Latest observation wins" needs a
  -- total order, and (observed_at, recorded_at) is not one: two rows written
  -- in the SAME TRANSACTION share a recorded_at, because now() is fixed for
  -- the life of a transaction.  Falling back to `id DESC` there would tie-break
  -- on a random uuid -- i.e. pick a winner at random between a live leg and a
  -- simulated one.  (Measured: the first draft of this migration did exactly
  -- that, and the rolled-back validation run caught it.)  A sequence makes the
  -- fallback insertion order, which is the only defensible answer.
  seq           bigserial NOT NULL,
  business_id   uuid NOT NULL REFERENCES business(id),
  leg           kyb_leg NOT NULL,

  -- Which adapter answered, and the id it answered with.  These two
  -- columns are what the evidence pack cites: 'persona-inquiry' /
  -- 'inq_ABC...' is checkable by a reviewer; "we verified them" is not.
  provider           text NOT NULL,
  provider_reference text NOT NULL,

  status        kyb_status   NOT NULL,
  evidence      kyb_evidence NOT NULL,
  -- The provider's own status string, before normalisation.  Persona
  -- warns its status enum is open-ended, so the raw value is kept
  -- alongside our mapping of it and nothing is lost in translation.
  raw_status    text,
  -- Named checks with the provider's own reason strings.
  checks        jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- WHEN THE PROVIDER SAW IT vs WHEN WE LEARNED IT.  The same bitemporal
  -- split the journal uses (value_date / booking_date): observed_at
  -- orders the facts, recorded_at orders our knowledge of them, and
  -- webhooks are explicitly not ordered so the two genuinely differ.
  observed_at   timestamptz NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),

  -- The delivery this came from, when it came from one.  Lets a status
  -- be traced back to the exact signed bytes that produced it.
  inbox_id      uuid REFERENCES webhook_inbox(id),

  CONSTRAINT kyb_leg_provider_nonempty  CHECK (length(btrim(provider)) > 0),
  CONSTRAINT kyb_leg_reference_nonempty CHECK (length(btrim(provider_reference)) > 0),
  CONSTRAINT kyb_leg_checks_is_array    CHECK (jsonb_typeof(checks) = 'array'),

  -- A simulator's output cannot be filed as live evidence.
  -- src/lib/kyb/simulated-registry.ts encodes its outcome into an id
  -- prefixed 'sim.' and names itself 'simulated-*'; this refuses any row
  -- that claims 'live' while carrying either mark.
  --
  -- ONE DIRECTION ONLY, on purpose.  The converse -- a live adapter's
  -- name against 'simulated' evidence -- is legitimate and must stay
  -- expressible: it is what a leg looks like when the provider could not
  -- be reached and WE, not they, wrote the answer.
  CONSTRAINT kyb_leg_simulated_reference CHECK (
    evidence <> 'live'
    OR (provider_reference NOT LIKE 'sim.%' AND provider NOT LIKE 'simulated-%')
  )
);

-- The read pattern is "latest observation per (business, leg)", which is
-- a DISTINCT ON over exactly this order.
CREATE INDEX kyb_verification_leg_latest_idx
  ON kyb_verification_leg (business_id, leg, observed_at DESC, recorded_at DESC, seq DESC);

CREATE INDEX kyb_verification_leg_reference_idx
  ON kyb_verification_leg (provider, provider_reference);

CREATE INDEX kyb_verification_leg_inbox_idx
  ON kyb_verification_leg (inbox_id) WHERE inbox_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 3.  The derived state -- the thing the gate reads
-- ---------------------------------------------------------------------

-- A view, not columns, so the composite answer cannot go stale and there
-- is no second copy to drift.  Identical reasoning to v_webhook_dead_letter
-- in 0002 and the balance views in 0001.
--
-- The two rules, in SQL:
--
--   STRICTEST WINS   max(status) over the latest leg rows.  Correct only
--                    because of the enum's declaration order above.
--   EVIDENCE DEGRADES  bool_and(evidence = 'live') -- one simulated leg
--                    and the whole verification is simulated, for ever.
--
-- And the rule that catches the case people forget: a business with only
-- ONE leg on file is 'pending', never 'approved'.  A verification half of
-- which was never performed has not passed.
CREATE VIEW v_business_kyb AS
WITH latest AS (
  SELECT DISTINCT ON (business_id, leg)
         business_id, leg, provider, provider_reference,
         status, evidence, raw_status, observed_at
    FROM kyb_verification_leg
   ORDER BY business_id, leg, observed_at DESC, recorded_at DESC, seq DESC
),
rolled AS (
  SELECT business_id,
         count(*)                        AS legs_on_file,
         max(status)                     AS strictest_status,
         bool_and(evidence = 'live')     AS every_leg_live,
         max(observed_at)                AS last_observed_at
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
         WHEN COALESCE(r.legs_on_file, 0) >= 2 AND r.every_leg_live THEN 'live'::kyb_evidence
         ELSE 'simulated'::kyb_evidence
       END                                         AS kyb_evidence,
       r.last_observed_at                          AS decided_at,
       -- Denormalised for the compliance view: which provider answered
       -- each leg, and with what id.
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
  'Derived KYB state per business: strictest status across both legs, evidence degraded to simulated if either leg was. Read by canTransact() in src/lib/kyb/types.ts. There is deliberately no stored copy of these two columns.';

-- ---------------------------------------------------------------------
-- 4.  Privileges
-- ---------------------------------------------------------------------

-- The app records observations and reads the derived state.  It cannot
-- rewrite an observation, which is the same absent-capability argument as
-- the money tables: no UPDATE grant means no UPDATE statement is
-- expressible, rather than a check someone could forget to write.
GRANT SELECT, INSERT ON kyb_verification_leg TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON kyb_verification_leg FROM corgi_app, PUBLIC;
-- bigserial owns a sequence, and INSERT on the table is not enough to draw
-- from it.  Without this, every insert as corgi_app fails with "permission
-- denied for sequence".
GRANT USAGE ON SEQUENCE kyb_verification_leg_seq_seq TO corgi_app;

GRANT SELECT ON v_business_kyb TO corgi_app;
