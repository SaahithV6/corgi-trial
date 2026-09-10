-- =====================================================================
-- 0002_webhook_inbox.sql  ·  Corgi work trial, Track 3
--
-- The webhook inbox, finished: the raw bytes we verified, and the
-- processing state the dispatcher drives.
--
-- 0001_ledger.sql creates `webhook_inbox` in its minimal form (the shape
-- sketched in research/ledger/schema.draft.sql) because journal_entry and
-- card_auth_event carry foreign keys to it and it therefore has to exist
-- inside that migration.  This migration owns everything else about the
-- table and does NOT recreate it: it adds the columns the ingestion and
-- dispatch layers need, the indexes their queries need, and the
-- constraints that make the states unrepresentable-if-wrong.
--
-- Reasoning: DESIGN.md §4 (the one exception to append-only), §11
-- (idempotency and out-of-order delivery), and src/lib/webhooks/README.md.
--
-- Conventions inherited from 0001:
--   * uuid primary keys, timestamptz for every instant.
--   * money is bigint CENTS.  See the note under `parked_reason` for why
--     there is deliberately no money column on this table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.  The four states
-- ---------------------------------------------------------------------

-- These are OURS, which is why this is an enum while `provider` stays a
-- plain text column: a fifth provider must never require a migration.
--
--   pending  queued for the dispatcher.  A row currently leased to a
--            worker is also 'pending' — a lease is a timeout, not a state.
--   parked   the event references an entity we have not seen yet.  Not an
--            error and not a drop: the referent is named on the row, and
--            the row is woken when it appears (or re-checked on a timer).
--   done     a consumer applied it, or deliberately ignored it.
--   dead     bounded retry exhausted, or a referent that never arrived.
--            Visible to staff in v_webhook_dead_letter, requeueable by
--            hand once the bug is fixed.
CREATE TYPE webhook_inbox_state AS ENUM ('pending', 'parked', 'done', 'dead');

-- ---------------------------------------------------------------------
-- 2.  Columns
-- ---------------------------------------------------------------------

ALTER TABLE webhook_inbox
  -- THE BYTES WE VERIFIED, verbatim.  0001 stores the parsed `payload`,
  -- which is what you want for querying and exactly what you must not
  -- sign: JSON.parse then JSON.stringify is not the identity function.
  -- Keeping the raw string means any signature can be re-checked years
  -- later, and a re-serialisation bug can be proven instead of argued
  -- about.  DEFAULT '' only so the ADD COLUMN is safe on a populated
  -- table; dropped immediately below so new rows must supply it.
  ADD COLUMN raw_body text NOT NULL DEFAULT '',

  -- Only the signature-bearing headers, captured through an allowlist in
  -- each verifier.  Never Authorization, never cookies: this row is kept
  -- for years and must not become a credential store.
  ADD COLUMN headers jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- When we checked the signature.  Replaces 0001's
  -- `signature_verified boolean` (dropped below): a row only exists here
  -- because verification passed — an unauthenticated body is not evidence
  -- of anything and is never persisted — so the useful fact is *when*,
  -- which is what an auditor asks for.  A boolean that can be false
  -- invites a code path that reads it and carries on.
  ADD COLUMN signature_verified_at timestamptz NOT NULL DEFAULT now(),

  ADD COLUMN state webhook_inbox_state NOT NULL DEFAULT 'pending',

  -- Of the `attempts` claims, how many ended in a park.  A park is not a
  -- failure, so the retry budget is (attempts - park_attempts) and the two
  -- caps are independent.  See src/lib/webhooks/dispatch.ts:failedAttempts.
  ADD COLUMN park_attempts integer NOT NULL DEFAULT 0,

  -- When this row next becomes visible to the dispatcher.  Exponential
  -- backoff writes it; the poll query reads it.
  ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),

  -- Lease, not a state.  A claimed row stays 'pending' and is hidden from
  -- other workers until this passes, so a worker that dies releases its
  -- work by doing nothing at all.  Nothing has to notice the crash.
  ADD COLUMN locked_until timestamptz,

  -- The parked state, modelled explicitly.  An event that references an
  -- entity we have not heard of is parked AGAINST THAT ENTITY, by
  -- (kind, ref) in the consumer's own vocabulary — 'card_authorization',
  -- 'ach_transfer', 'business' — plus the provider's id for it.  Naming
  -- the referent is what makes the wake-up possible: when a later event
  -- reports creating that entity, one UPDATE moves every row waiting on
  -- it back to 'pending'.  Parking without a referent would be a queue
  -- nothing can drain, which is why the check constraint below refuses it.
  -- These are NOT cleared on unpark or on death: keeping them is free and
  -- answers "what was this waiting for?" months later.
  ADD COLUMN parked_on_kind text,
  ADD COLUMN parked_on_ref  text,
  ADD COLUMN parked_reason  text,

  ADD COLUMN dead_lettered_at timestamptz;

-- NO MONEY COLUMN, deliberately.  Amounts belong to the adapter's output
-- (rail_event) and to journal_line, in signed bigint cents.  Copying an
-- amount here would create a second, unreconciled place where a figure
-- lives.  If one is ever added it is `bigint` cents like every other money
-- column in this database — never numeric, never float.

ALTER TABLE webhook_inbox ALTER COLUMN raw_body DROP DEFAULT;
ALTER TABLE webhook_inbox ALTER COLUMN signature_verified_at DROP DEFAULT;

-- Superseded by signature_verified_at above.  Nothing references it: it is
-- not in any index, constraint, trigger or grant in 0001.
ALTER TABLE webhook_inbox DROP COLUMN signature_verified;

-- One case needs these nullable: a body whose signature verified but which
-- will not parse as JSON.  Those bytes really did come from the provider,
-- so losing them would be losing evidence; the row is filed dead on
-- arrival with the raw body and no parsed payload, rather than dropped.
ALTER TABLE webhook_inbox ALTER COLUMN event_type DROP NOT NULL;
ALTER TABLE webhook_inbox ALTER COLUMN payload    DROP NOT NULL;

-- ---------------------------------------------------------------------
-- 3.  Constraints — make the wrong states unrepresentable
-- ---------------------------------------------------------------------

ALTER TABLE webhook_inbox
  ADD CONSTRAINT webhook_inbox_attempts_nonneg      CHECK (attempts >= 0),
  ADD CONSTRAINT webhook_inbox_park_attempts_nonneg CHECK (park_attempts >= 0),
  -- Every park is a claim, so parks can never outnumber claims.  This is
  -- what keeps (attempts - park_attempts) meaningful as a failure count.
  ADD CONSTRAINT webhook_inbox_parks_le_attempts    CHECK (park_attempts <= attempts),

  -- 'done' and processed_at are the same fact; neither may exist alone.
  ADD CONSTRAINT webhook_inbox_done_iff_processed
    CHECK ((state = 'done') = (processed_at IS NOT NULL)),
  -- 'dead' and dead_lettered_at, likewise.
  ADD CONSTRAINT webhook_inbox_dead_iff_stamped
    CHECK ((state = 'dead') = (dead_lettered_at IS NOT NULL)),
  -- One direction only: parked REQUIRES a referent (otherwise it can never
  -- be woken), while a row that has since been unparked or dead-lettered
  -- keeps its referent columns for forensics.
  ADD CONSTRAINT webhook_inbox_parked_needs_referent
    CHECK (state <> 'parked' OR (parked_on_kind IS NOT NULL AND parked_on_ref IS NOT NULL)),
  ADD CONSTRAINT webhook_inbox_referent_is_a_pair
    CHECK ((parked_on_kind IS NULL) = (parked_on_ref IS NULL));

COMMENT ON COLUMN webhook_inbox.raw_body IS
  'The exact bytes the signature was computed over. Never a re-serialisation of the parsed payload.';
COMMENT ON COLUMN webhook_inbox.attempts IS
  'Incremented when the dispatcher CLAIMS the row, not when it fails, so a worker that crashes mid-event still spends an attempt and a poison event cannot loop for ever.';
COMMENT ON COLUMN webhook_inbox.parked_on_ref IS
  'The entity this event is waiting for. Parking is a state with a named referent, never a silent drop.';
COMMENT ON COLUMN webhook_inbox.provider IS
  'Plain text, deliberately not an enum: adding a fifth provider must be a registration in application code, never an ALTER TYPE.';

-- ---------------------------------------------------------------------
-- 4.  Indexes
-- ---------------------------------------------------------------------

-- 0001's index was (received_at) WHERE processed_at IS NULL, which was
-- right for a queue with one state.  The dispatcher's actual poll is:
--
--   WHERE state IN ('pending','parked')
--     AND next_attempt_at <= now()
--     AND (locked_until IS NULL OR locked_until <= now())
--   ORDER BY next_attempt_at, received_at
--   LIMIT n FOR UPDATE SKIP LOCKED
--
-- so the leading column has to be next_attempt_at, and dead rows must not
-- sit in the index for ever.  Replaced rather than added to: two indexes
-- for one query is two indexes to maintain on every insert.
DROP INDEX IF EXISTS webhook_inbox_unprocessed_idx;

-- Partial on the two live states, so the index holds only work in flight
-- and never grows with the millions of 'done' rows that accumulate — it
-- stays small enough to stay in cache for the life of the system.  Ordered
-- so the ORDER BY is satisfied by the scan with no sort, and so ties break
-- on arrival order rather than on a uuid, which is random.  locked_until
-- is deliberately NOT in the predicate: it is compared against now(),
-- which is not immutable and therefore not indexable, and the number of
-- currently-leased rows is tiny.
CREATE INDEX webhook_inbox_due_idx
  ON webhook_inbox (next_attempt_at, received_at)
  WHERE state IN ('pending', 'parked');

-- The unpark: "everything waiting for the entity that just appeared".
CREATE INDEX webhook_inbox_parked_referent_idx
  ON webhook_inbox (parked_on_kind, parked_on_ref)
  WHERE state = 'parked';

-- The staff dead-letter screen, newest first.
CREATE INDEX webhook_inbox_dead_letter_idx
  ON webhook_inbox (dead_lettered_at DESC)
  WHERE state = 'dead';

-- Support lookups: "show me everything Lithic sent us on Tuesday".  Not
-- partial — this one is asked about old, done rows by definition.
CREATE INDEX webhook_inbox_provider_received_idx
  ON webhook_inbox (provider, received_at DESC);

-- The replay guard itself, UNIQUE (provider, provider_event_id), is
-- created in 0001 as webhook_inbox_replay_key.  It is the entire answer to
-- "replay must be a no-op at the database": ingestion is a single
-- INSERT ... ON CONFLICT DO NOTHING and the row count it returns is what
-- distinguishes a first delivery from a redelivery.  There is no
-- SELECT-then-INSERT anywhere in the codebase, because that has a race
-- between its two statements and this has none.

-- ---------------------------------------------------------------------
-- 5.  The guard trigger, extended
-- ---------------------------------------------------------------------

-- 0001 attached `webhook_inbox_immutable_facts` BEFORE UPDATE OR DELETE to
-- this function.  Replacing the body extends it to the columns added
-- above; the trigger itself is untouched.  The line it draws is DESIGN.md
-- §4's: what a third party told us is immutable, what we have done about
-- it advances in one direction only.
CREATE OR REPLACE FUNCTION webhook_inbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webhook_inbox rows are never deleted' USING ERRCODE = '55006';
  END IF;

  IF NEW.provider              IS DISTINCT FROM OLD.provider
  OR NEW.provider_event_id     IS DISTINCT FROM OLD.provider_event_id
  OR NEW.payload               IS DISTINCT FROM OLD.payload
  OR NEW.event_type            IS DISTINCT FROM OLD.event_type
  OR NEW.received_at           IS DISTINCT FROM OLD.received_at
  OR NEW.raw_body              IS DISTINCT FROM OLD.raw_body
  OR NEW.headers               IS DISTINCT FROM OLD.headers
  OR NEW.signature_verified_at IS DISTINCT FROM OLD.signature_verified_at THEN
    RAISE EXCEPTION 'what the provider told us is immutable' USING ERRCODE = '55006';
  END IF;

  -- processed_at is a one-way door.  Re-processing must never be recorded
  -- as if it were the first time: the ledger's idempotency keys are
  -- derived from the event, and a second "first" processing is exactly the
  -- shape of a double-post.
  IF OLD.processed_at IS NOT NULL AND NEW.processed_at IS DISTINCT FROM OLD.processed_at THEN
    RAISE EXCEPTION 'processed_at only moves once, NULL -> timestamp' USING ERRCODE = '55006';
  END IF;

  -- 'done' is terminal.  'dead' is not: requeueing a dead letter after the
  -- bug is fixed is a legitimate staff action.
  IF OLD.state = 'done' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a processed event cannot change state' USING ERRCODE = '55006';
  END IF;

  -- Counters only climb — except on that requeue path, which zeroes both
  -- together as it moves dead -> pending.
  IF (NEW.attempts < OLD.attempts OR NEW.park_attempts < OLD.park_attempts)
     AND NOT (NEW.attempts = 0 AND NEW.park_attempts = 0
              AND OLD.state = 'dead' AND NEW.state = 'pending') THEN
    RAISE EXCEPTION 'webhook_inbox attempt counters only increase' USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------
-- 6.  Privileges
-- ---------------------------------------------------------------------

-- 0001 granted UPDATE on exactly (processed_at, processing_error,
-- attempts).  The dispatcher's state machine needs the columns added
-- above, and nothing else: the immutable facts stay ungranted, so
-- corgi_app cannot express an UPDATE that rewrites what a provider sent —
-- an absent capability rather than a check someone could forget.
GRANT UPDATE (
  processed_at, processing_error, attempts,
  state, park_attempts, next_attempt_at, locked_until,
  parked_on_kind, parked_on_ref, parked_reason, dead_lettered_at
) ON webhook_inbox TO corgi_app;

-- ---------------------------------------------------------------------
-- 7.  Staff views
-- ---------------------------------------------------------------------

-- Requirement: the dead-letter state must be visible to staff.  A view,
-- not a table, so it cannot go stale and there is no second copy to drift
-- — the same reasoning as the reconciliation break views in DESIGN.md §15.
CREATE VIEW v_webhook_dead_letter AS
SELECT id,
       provider,
       provider_event_id,
       event_type,
       received_at,
       dead_lettered_at,
       attempts,
       park_attempts,
       attempts - park_attempts AS failed_attempts,
       parked_on_kind,
       parked_on_ref,
       processing_error,
       -- Age in whole days from the arrival date, computed at read time,
       -- so it is a fact about the event and not about when a job last ran.
       (CURRENT_DATE - received_at::date) AS age_days
FROM webhook_inbox
WHERE state = 'dead';

COMMENT ON VIEW v_webhook_dead_letter IS
  'Events that exhausted bounded retry, or waited for a referent that never arrived. Nothing retries for ever; everything that stops retrying lands here.';

-- What is waiting, and for what.  The operational question this answers is
-- "is the card auth stream lagging, or did we lose an event?"
CREATE VIEW v_webhook_parked AS
SELECT id,
       provider,
       provider_event_id,
       event_type,
       parked_on_kind,
       parked_on_ref,
       parked_reason,
       park_attempts,
       received_at,
       next_attempt_at,
       (now() - received_at) AS waiting_for
FROM webhook_inbox
WHERE state = 'parked';

GRANT SELECT ON v_webhook_dead_letter, v_webhook_parked TO corgi_app;
