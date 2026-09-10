-- =====================================================================
-- 0014  Card controls, and the append-only record of every decision
--       they produced inside the provider's authorisation timeout.
-- =====================================================================
--
-- WHAT THIS IS FOR.  Lithic's Auth Stream Access (ASA) is a SYNCHRONOUS
-- webhook: Lithic holds the authorisation open, calls us, and waits.  We
-- return APPROVED or one of eight decline reasons.  Measured against the
-- sandbox program on 2026-09-10:
--
--   GET  /v1/auth_stream                       -> 200 {"enrolled": false}
--   GET  /v1/auth_stream/secret                -> 200 {"secret": "whsec_..."}
--   GET  /v1/responder_endpoints?type=AUTH_STREAM_ACCESS
--                                              -> 200 {"enrolled": false, "url": null}
--
-- so the capability is real on this program and this migration exists to
-- serve it.  The hard timeout is 6000 ms and the provider's own
-- recommendation is 3000 ms; on timeout Lithic DECLINES and stamps the
-- transaction `CUSTOMER_ASA_TIMEOUT`.  See docs/CARD-CONTROLS.md for the
-- measurements and the latency budget derived from them.
--
-- THE TWO TABLES BELOW ARE NOT MONEY TABLES, AND THAT IS THE POINT.
-- A synchronous decision that writes to the journal is a synchronous
-- decision that can block on the journal's append lock, and a blocked
-- decision is a declined card.  So this path READS controls and recent
-- spend and RETURNS a verdict.  Money still moves later, on the ordinary
-- asynchronous `card_transaction.updated` webhook, through the same
-- inbox, the same dispatcher and the same consumer it always did.
-- Nothing in this file is reachable from ledger_append().
--
-- Both tables are still APPEND-ONLY, for the same reason the journal is:
-- a decline a customer disputes in March must be explainable in
-- September, and a control set that can be edited after the fact is a
-- control set that can be made to say it always allowed the thing it
-- declined.
--
-- ---------------------------------------------------------------------
-- 1.  Controls as data, versioned -- the approval_policy pattern
-- ---------------------------------------------------------------------
--
-- 0001's `approval_policy` is the model this follows and the comment at
-- the top of 0007 says why it works: a payment is judged under a policy
-- VERSION, cited by id from the instruction, so a later policy change
-- cannot retroactively make a past approval look wrong.
--
-- The same shape, one card at a time.  A control change is an INSERT of
-- version N+1, never an UPDATE of version N.  Every decision row below
-- pins `control_version_id`, so "what was this card allowed to do at
-- 14:07 on the ninth" is a lookup and not an argument.
--
-- Two differences from approval_policy, both deliberate:
--
--   * `effective_from` is a timestamptz, not a date.  An operator who
--     freezes a stolen card at 14:07 means 14:07, not midnight.
--   * the version number is explicit and contiguous, asserted by the
--     trigger below.  approval_policy orders by `effective_from` and
--     gets away with it because policies are rare and hand-seeded;
--     controls are edited from a screen by people in a hurry, and two
--     of them clicking Save in the same second must not produce a pair
--     of rows whose order depends on clock skew.

CREATE TABLE card_control_version (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id       uuid NOT NULL REFERENCES card(id),

  -- 1, 2, 3, ... contiguous per card.  UNIQUE (card_id, version) is what
  -- actually makes concurrent saves safe: both writers compute N+1, both
  -- try to insert it, and Postgres decides.  The loser retries against
  -- the version the winner wrote and therefore sees it.
  version       integer NOT NULL CHECK (version >= 1),

  effective_from timestamptz NOT NULL DEFAULT now(),

  -- The on/off switch.  'frozen' is the customer saying "this card spends
  -- nothing until I say otherwise" and it is checked before any limit,
  -- because a frozen card's limits are irrelevant.
  card_state    text NOT NULL CHECK (card_state IN ('active', 'frozen')),

  -- NULL means "no limit of this kind", which is different from 0 ("this
  -- card may spend nothing").  Both are expressible and they mean
  -- different things; a single sentinel would collapse them.
  per_txn_limit_cents     bigint CHECK (per_txn_limit_cents     IS NULL OR per_txn_limit_cents     >= 0),
  daily_limit_cents       bigint CHECK (daily_limit_cents       IS NULL OR daily_limit_cents       >= 0),
  monthly_limit_cents     bigint CHECK (monthly_limit_cents     IS NULL OR monthly_limit_cents     >= 0),

  -- Merchant category codes this card may not transact at.  ISO 18245:
  -- exactly four digits, always a string -- '0742' is a veterinary
  -- surgeon and 742 is nothing at all, so storing these as integers
  -- would lose a leading zero and silently unblock a category.
  --
  -- The CHECK is written over `array_to_string` because a per-element
  -- constraint would need a DOMAIN, and a domain over text[] elements
  -- cannot be added without a type the rest of the schema would then
  -- have to know about.  This form is IMMUTABLE, so it is legal in a
  -- CHECK, and it rejects the whole array if any element is malformed.
  blocked_mccs  text[] NOT NULL DEFAULT '{}'
                  CHECK (array_to_string(blocked_mccs, ',') ~ '^([0-9]{4}(,[0-9]{4})*)?$'),

  -- Why this version exists.  Not decoration: it is the first thing read
  -- in a dispute, and a NOT NULL forces the screen to ask for it.
  note          text NOT NULL,

  created_by    uuid NOT NULL REFERENCES actor(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT card_control_version_key UNIQUE (card_id, version)
);

COMMENT ON TABLE card_control_version IS
  'Per-card limits, MCC blocks and the on/off switch, versioned and append-only. A change is version N+1; a decision cites the version it was judged under.';

-- Contiguity and monotonicity, asserted rather than assumed.
--
-- Two claims:
--   * version N may only follow version N-1.  A gap would make "the
--     version before this one" ambiguous in an audit.
--   * effective_from never goes backwards.  A control set that took
--     effect before the one it replaces cannot be reasoned about at all.
--
-- Both are BEFORE INSERT and both RAISE, which aborts the statement.
CREATE OR REPLACE FUNCTION assert_card_control_version() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev card_control_version%ROWTYPE;
BEGIN
  SELECT * INTO v_prev
    FROM card_control_version
   WHERE card_id = NEW.card_id
   ORDER BY version DESC
   LIMIT 1;

  IF v_prev.id IS NULL THEN
    IF NEW.version <> 1 THEN
      RAISE EXCEPTION
        'card % has no controls yet; the first version must be 1, not %',
        NEW.card_id, NEW.version USING ERRCODE = '55006';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.version <> v_prev.version + 1 THEN
    RAISE EXCEPTION
      'card % is at control version %; the next version must be %, not %',
      NEW.card_id, v_prev.version, v_prev.version + 1, NEW.version
      USING ERRCODE = '55006';
  END IF;

  IF NEW.effective_from < v_prev.effective_from THEN
    RAISE EXCEPTION
      'card % control version % takes effect at %, before version % at %',
      NEW.card_id, NEW.version, NEW.effective_from,
      v_prev.version, v_prev.effective_from
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_card_control_version() SET search_path = public, pg_temp;

CREATE TRIGGER card_control_version_chain
  BEFORE INSERT ON card_control_version
  FOR EACH ROW EXECUTE FUNCTION assert_card_control_version();

-- Append-only, by the same trigger function every other immutable table
-- in this schema uses.  A control set is not money, but it is the rule
-- money was judged under, and a rule that can be rewritten after the
-- judgement is not a rule.
CREATE TRIGGER card_control_version_no_update_delete
  BEFORE UPDATE OR DELETE ON card_control_version
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER card_control_version_no_truncate
  BEFORE TRUNCATE ON card_control_version
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

-- The hot path reads exactly one row: the newest version for one card.
CREATE INDEX card_control_version_card_idx
  ON card_control_version (card_id, version DESC);

-- ---------------------------------------------------------------------
-- 2.  Every decision, append-only, with the rule and the latency
-- ---------------------------------------------------------------------
--
-- This is the table that makes card controls a bank feature rather than
-- an if-statement.  A cardholder standing at a pump whose card was
-- declined is owed an answer, and the answer has to survive the control
-- set being changed twice and the process that made it being recycled.
--
-- So every row carries:
--   * WHAT WAS ASKED    amount, MCC, descriptor, request status
--   * WHAT WAS SEEN     `inputs`, the exact figures the rule compared
--   * WHICH RULE FIRED  `rule`, one value from a closed set
--   * WHAT WE ANSWERED  `outcome` and the network `result_code`
--   * HOW LONG IT TOOK  `decision_latency_us`
--   * UNDER WHAT RULES  `control_version_id`
--   * WHO ASKED         `source`: the provider, or our own harness
--
-- `source` is the honesty column and it is NOT NULL for that reason.
-- 'provider' means Lithic called us and waited for this answer.
-- 'harness' means we replayed an ASA-shaped payload through the same
-- decision function locally.  Both are useful; presenting the second as
-- the first would be the fastest way to fail this trial, so the
-- distinction is a column and not a convention, and the velocity query
-- below sums only within one source lane -- a harness run cannot eat a
-- real card's daily limit, and a real spend cannot make a harness
-- assertion pass.
--
-- There is deliberately NO unique constraint on (provider_auth_token).
-- Lithic documents rare duplicate ASA deliveries, and a duplicate
-- delivery genuinely IS a second decision: it was asked again, it was
-- answered again, and it took its own amount of time.  Suppressing the
-- second row would be an UPDATE-shaped lie in an append-only table. The
-- idempotency that matters -- one hold, one posting -- lives on the
-- asynchronous path, keyed by `journal_entry.idempotency_key`, and is
-- unaffected by anything here because nothing here posts.

CREATE TABLE card_auth_decision (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decided_at          timestamptz NOT NULL DEFAULT now(),

  provider            text NOT NULL,
  -- Lithic's provisional transaction token from the ASA request. It is the
  -- same token the asynchronous `card_transaction.updated` webhook will
  -- carry, which is what lets a decision be joined to the hold it did or
  -- did not allow.
  provider_auth_token text NOT NULL,
  provider_card_token text NOT NULL,

  -- NULL when the ASA request names a card token this book has never
  -- registered.  That is not an error and it is not a decline -- see
  -- `card_not_under_control` in src/lib/cards/decide.ts.
  card_id             uuid REFERENCES card(id),

  -- The version this decision was judged under.  NULL when there was no
  -- control set to judge it under, or when the store could not be read.
  control_version_id  uuid REFERENCES card_control_version(id),

  amount_cents        bigint NOT NULL CHECK (amount_cents >= 0),
  mcc                 text CHECK (mcc IS NULL OR mcc ~ '^[0-9]{4}$'),
  merchant_descriptor text,
  request_status      text NOT NULL,

  outcome             text NOT NULL CHECK (outcome IN ('approve', 'decline')),
  -- The value actually put on the wire, from Lithic's asa-response enum.
  result_code         text NOT NULL,
  -- Which rule fired.  A closed set enforced in src/lib/cards/decide.ts
  -- rather than by a CHECK here, so that adding a rule is a code change
  -- with a test and not a migration -- the audit value is in the string
  -- being recorded, not in the database policing its spelling.
  rule                text NOT NULL,
  reason              text NOT NULL,

  -- The figures the rule compared, verbatim, as JSON.  Money inside is
  -- serialised as a DECIMAL STRING of integer cents, never a JSON number:
  -- jsonb stores numbers as `numeric` and would survive the round trip,
  -- but every reader between here and a screen is JavaScript, and
  -- JSON.parse turns 9007199254740993 into 9007199254740992.
  inputs              jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Microseconds, integer.  Milliseconds would round a 700 us decision to
  -- 1 and a 400 us decision to 0, and the whole point of recording this
  -- is to be able to say where the budget went.
  decision_latency_us integer NOT NULL CHECK (decision_latency_us >= 0),

  source              text NOT NULL CHECK (source IN ('provider', 'harness')),
  -- `webhook-id` when the provider sent one, our own request id otherwise.
  request_id          text
);

COMMENT ON TABLE card_auth_decision IS
  'Append-only record of every real-time card authorisation decision: the rule that fired, the inputs it saw, the latency, and whether the provider or a local harness asked. Never posts money.';

CREATE TRIGGER card_auth_decision_no_update_delete
  BEFORE UPDATE OR DELETE ON card_auth_decision
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER card_auth_decision_no_truncate
  BEFORE TRUNCATE ON card_auth_decision
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

-- The velocity read is the only query on the hot path, and it is
-- `card_id + source + outcome='approve'` over a time window.  A partial
-- index on the approvals keeps it off the declines, which is most of the
-- table on a card that is doing its job.
CREATE INDEX card_auth_decision_velocity_idx
  ON card_auth_decision (card_id, source, decided_at DESC)
  WHERE outcome = 'approve';

-- The history panel and the join back to the asynchronous webhook.
CREATE INDEX card_auth_decision_card_idx  ON card_auth_decision (card_id, decided_at DESC);
CREATE INDEX card_auth_decision_token_idx ON card_auth_decision (provider, provider_auth_token);

-- ---------------------------------------------------------------------
-- 3.  The two views the screen and the hot path read
-- ---------------------------------------------------------------------

-- The current control set for every card.  DISTINCT ON rather than a
-- window function because the planner turns it into one index scan per
-- card against `card_control_version_card_idx`.
CREATE VIEW v_card_control_current AS
SELECT DISTINCT ON (ccv.card_id)
       ccv.card_id,
       ccv.id            AS control_version_id,
       ccv.version,
       ccv.effective_from,
       ccv.card_state,
       ccv.per_txn_limit_cents,
       ccv.daily_limit_cents,
       ccv.monthly_limit_cents,
       ccv.blocked_mccs,
       ccv.note,
       ccv.created_by,
       ccv.created_at
  FROM card_control_version ccv
 ORDER BY ccv.card_id, ccv.version DESC;

COMMENT ON VIEW v_card_control_current IS
  'Newest control version per card. Derived from the append-only chain, never stored.';

-- Decisions with the card, the business and the control version they
-- were judged under, for the history panel.  The screen must never have
-- to join these itself: a panel that renders "declined" without the rule
-- beside it is worse than no panel.
CREATE VIEW v_card_auth_decision AS
SELECT d.id,
       d.decided_at,
       d.provider,
       d.provider_auth_token,
       d.provider_card_token,
       d.card_id,
       c.business_id,
       c.last_four,
       c.nickname,
       d.control_version_id,
       ccv.version        AS control_version,
       d.amount_cents,
       d.mcc,
       d.merchant_descriptor,
       d.request_status,
       d.outcome,
       d.result_code,
       d.rule,
       d.reason,
       d.inputs,
       d.decision_latency_us,
       d.source,
       d.request_id
  FROM card_auth_decision d
  LEFT JOIN card c   ON c.id = d.card_id
  LEFT JOIN card_control_version ccv ON ccv.id = d.control_version_id;

-- ---------------------------------------------------------------------
-- 4.  Grants
-- ---------------------------------------------------------------------
--
-- SELECT and INSERT, matching `hold`, `card` and `card_authorization`.
-- No UPDATE, no DELETE, no TRUNCATE -- not because the application would
-- not try, but because the role cannot express it.  `pnpm db:check`
-- proves that property for the money tables by attempting the forbidden
-- thing; these two tables inherit the same shape by construction.
GRANT SELECT, INSERT ON card_control_version TO corgi_app;
GRANT SELECT, INSERT ON card_auth_decision   TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON card_control_version FROM corgi_app, PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON card_auth_decision   FROM corgi_app, PUBLIC;

GRANT SELECT ON v_card_control_current TO corgi_app;
GRANT SELECT ON v_card_auth_decision   TO corgi_app;
