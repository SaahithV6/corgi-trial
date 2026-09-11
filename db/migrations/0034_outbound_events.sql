-- =====================================================================
-- 0034  Outbound events: the events THIS bank sends to ITS customers
-- =====================================================================
--
-- Every other webhook table in this schema records something a provider
-- told us. This one records something we told a customer. It is the
-- mirror of `webhook_inbox` and it is deliberately built out of the same
-- four decisions that one got right, because those were paid for:
--
--   inbound                              outbound (this file)
--   -----------------------------------  -----------------------------------
--   UNIQUE (provider, provider_event_id) UNIQUE (event_id, endpoint_id) and
--   kills a replay at the database       UNIQUE (business_id, source_entry_id,
--                                        event_type) kills a double emission
--   raw_body kept forever so a           body kept forever so a customer's
--   signature can be re-verified         "your signature is wrong" can be
--                                        settled with the exact bytes we sent
--   bounded retry -> dead letter with    identical policy, identical shape,
--   a message naming the missing thing   one screen
--   pending/parked/done/dead, a lease    pending/delivered/dead, a lease is a
--   is a timeout and not a state         timeout and not a state
--
-- ---------------------------------------------------------------------
-- 1.  THE ONE RULE THIS SCHEMA EXISTS TO MAKE UNBREAKABLE
-- ---------------------------------------------------------------------
--
-- A CUSTOMER'S WEBHOOK ENDPOINT MUST NEVER BE ABLE TO AFFECT THE LEDGER
-- AND MUST NEVER BE ABLE TO BLOCK A TRANSACTION.
--
-- It is held by the direction of every foreign key in this file. Look at
-- them: `outbound_event.source_entry_id REFERENCES journal_entry(id)`.
-- There is no column anywhere in the money schema that references
-- anything here, and nothing here is nullable-in-the-other-direction.
-- The dependency graph therefore runs strictly outbound -> ledger, so a
-- posting cannot be waiting on a delivery row that does not exist yet,
-- and a delivery row cannot be written in the posting's transaction
-- because the posting's transaction does not know this table exists.
--
-- The generator is a CURSOR, not a hook. `outbound_cursor.last_sequence`
-- walks `journal_entry.booking_seq` after the fact -- 0001 §14 serialises
-- booking_seq assignment so sequence order IS commit order, which makes
-- "everything above N" a stable set that can never gain rows below N
-- later. That is exactly the guarantee a change feed needs, and it is
-- already there. Nothing had to be added to the posting path, and
-- NOTHING SHOULD BE: the moment a `postEntry()` caller inserts into
-- `outbound_delivery`, a customer's dead endpoint is inside a money
-- transaction and their own payments stop settling.
--
-- ---------------------------------------------------------------------
-- 2.  THE SECRET LIVES IN ITS OWN TABLE, AND THAT IS THE WHOLE REASON
-- ---------------------------------------------------------------------
--
-- `outbound_endpoint_secret` is a separate table from `outbound_endpoint`
-- for one reason: so that `SELECT * FROM outbound_endpoint` -- the query
-- every screen, every debug session and every `console.log(row)` reaches
-- for -- CANNOT return a signing secret. A column on the endpoint row
-- would be one careless splat away from a log drain, and this repository
-- has already leaked two live credentials into git history.
--
-- The secret is shown to a human exactly once, in the response to the
-- call that created it, and never again. There is no read path in
-- `src/lib/events/**` that returns it to a screen; the only reader is the
-- signer, which wraps it in a type whose toString() and toJSON() both
-- return "[redacted]".
--
-- It is stored in plaintext, and that is stated rather than dressed up:
-- an HMAC needs the key material, so "hashed at rest" is not available
-- here the way it is for a password. Encrypting it at rest with a key
-- from the same environment the application reads would move the secret
-- one dereference away and no further. What IS bought is the blast
-- radius: a separate table, no UPDATE grant on the secret column, a
-- retirement path for rotation, and a guard trigger that refuses to let
-- the ciphertext of a live secret be altered.
--
-- ---------------------------------------------------------------------
-- 3.  ORDERING IS NOT PROMISED, SO ORDER IS CARRIED IN THE ROW
-- ---------------------------------------------------------------------
--
-- `outbound_event.sequence` IS `journal_entry.booking_seq`. It is not a
-- per-endpoint counter and not a delivery number: it is the ledger's own
-- total order, the same integer `/api/v1/transactions` publishes as
-- `booking_seq` and builds its cursor from. A customer sorts on it and
-- has the book's order regardless of what order the HTTP arrived in --
-- which is the only honest thing to give them, because we retry, we fan
-- out, and we run more than one worker.
--
-- `value_date` (when it happened) and `occurred_at` (when we learned it)
-- ride along for the same reason the public API carries both: an
-- integrator who treats either one as "the date" gets a correct-looking
-- answer until a backdated correction lands.

-- ---------------------------------------------------------------------
-- 4.  Endpoints
-- ---------------------------------------------------------------------

CREATE TYPE outbound_endpoint_status AS ENUM ('active', 'disabled');

-- One row per URL a business has registered. Scoped to the business: the
-- business_id here is the ONLY thing that decides which events reach this
-- URL, and it is a foreign key rather than a filter someone remembers to
-- apply.
CREATE TABLE outbound_endpoint (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES business(id),
  url           text NOT NULL,
  description   text NOT NULL,
  status        outbound_endpoint_status NOT NULL DEFAULT 'active',
  -- Empty array means "every event type". A subscription filter, applied
  -- at fan-out, so an endpoint that only wants settlements is not woken
  -- by every memo movement -- and so a customer's noisy endpoint cannot
  -- make its own delivery log unreadable.
  event_types   text[] NOT NULL DEFAULT '{}',
  created_by    uuid REFERENCES actor(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  disabled_at   timestamptz,

  -- The application refuses far more than this (see src/lib/events/url.ts:
  -- loopback, link-local, private ranges, non-443 ports, credentials in
  -- the URL, and every address the hostname resolves to). This constraint
  -- is the floor underneath that, in the one place an application bug
  -- cannot route around: a plaintext delivery would put a Standard
  -- Webhooks signature and a customer's transaction history on the wire
  -- in clear, and no amount of care in TypeScript makes that acceptable.
  CONSTRAINT outbound_endpoint_https  CHECK (url LIKE 'https://%'),
  CONSTRAINT outbound_endpoint_len    CHECK (length(url) BETWEEN 12 AND 2000),
  -- Registering the same URL twice would double every delivery to it and
  -- halve the meaning of the delivery log.
  CONSTRAINT outbound_endpoint_unique UNIQUE (business_id, url),
  CONSTRAINT outbound_endpoint_disabled_shape
    CHECK ((status = 'disabled') = (disabled_at IS NOT NULL))
);

CREATE INDEX outbound_endpoint_business_idx
  ON outbound_endpoint (business_id) WHERE status = 'active';

-- The secret. Its own table; see §2.
--
-- Versioned rather than replaced, because rotation is a real operation:
-- a customer needs a window where BOTH secrets verify, which is exactly
-- what the inbound verifiers already support (`secret: string[]`, "any
-- match wins", inbox.ts). Retiring is setting `retired_at`, which the
-- guard below makes a one-way door.
CREATE TABLE outbound_endpoint_secret (
  endpoint_id  uuid NOT NULL REFERENCES outbound_endpoint(id),
  version      integer NOT NULL,
  -- `whsec_` + base64(32 random bytes), the Standard Webhooks shape, so a
  -- customer can paste it into any off-the-shelf verifier.
  secret       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz,
  PRIMARY KEY (endpoint_id, version),
  CONSTRAINT outbound_secret_shape CHECK (secret LIKE 'whsec_%' AND length(secret) >= 20)
);

-- Signing reads the live secrets for one endpoint. Partial index so the
-- hot path never scans retired ones.
CREATE INDEX outbound_endpoint_secret_live_idx
  ON outbound_endpoint_secret (endpoint_id) WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------
-- 5.  Events
-- ---------------------------------------------------------------------

-- The event, once, per business. NOT per endpoint: an event is a fact
-- about the book and the `id` on it is the id the customer deduplicates
-- on, so two endpoints belonging to the same business receive the SAME
-- `event.id` -- which is what makes "twice is one" work on their side
-- exactly the way `UNIQUE (provider, provider_event_id)` makes it work
-- on ours.
CREATE TABLE outbound_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      uuid NOT NULL REFERENCES business(id),
  event_type       text NOT NULL,

  -- THE ORDERING FIELD. journal_entry.booking_seq, verbatim. See §3.
  sequence         bigint NOT NULL,
  -- WHEN WE LEARNED IT (journal_entry.booking_time).
  occurred_at      timestamptz NOT NULL,
  -- WHEN IT HAPPENED (journal_entry.value_date).
  value_date       date NOT NULL,

  source_entry_id  uuid NOT NULL REFERENCES journal_entry(id),

  -- THE EXACT BYTES WE SIGN, kept forever.
  --
  -- `text`, not `jsonb`. jsonb normalises: it reorders keys, drops
  -- insignificant whitespace and renormalises numbers, and a signature is
  -- over BYTES. Storing jsonb and re-serialising at send time is the
  -- outbound spelling of the exact footgun `rawbody.ts` exists to prevent
  -- -- one space, completely different signature -- except that here we
  -- would be the ones producing signatures nobody can verify. The body is
  -- serialised once, here, and every retry sends this string unchanged.
  body             text NOT NULL,

  created_at       timestamptz NOT NULL DEFAULT now(),

  -- Generation idempotency. The cursor is at-least-once by design (a
  -- worker can die between sending the rows and advancing the watermark),
  -- so the second pass over an entry must produce nothing. Decided here,
  -- by an index, and not by an `if` in application code.
  CONSTRAINT outbound_event_source_key UNIQUE (business_id, source_entry_id, event_type),
  CONSTRAINT outbound_event_body_len CHECK (length(body) BETWEEN 2 AND 65536)
);

CREATE INDEX outbound_event_business_seq_idx ON outbound_event (business_id, sequence DESC);
CREATE INDEX outbound_event_created_idx      ON outbound_event (created_at DESC);

-- The generator's watermark. One row per stream.
--
-- Deliberately NOT a money row and deliberately mutable: it is a
-- bookmark, and a bookmark whose only legal move is forwards is a
-- bookmark. The guard below refuses to let it go backwards, because
-- rewinding it would re-emit events a customer has already deduplicated
-- away -- harmless -- and, far worse, would make the delivery log lie
-- about what was sent when.
CREATE TABLE outbound_cursor (
  stream         text PRIMARY KEY,
  last_sequence  bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_cursor_nonneg CHECK (last_sequence >= 0)
);

-- Start at the current head rather than at zero.
--
-- 2,823 entries are already on this book. Starting at 0 would fan out
-- thousands of historical events to the first endpoint anybody registers,
-- which is not a feature -- a customer integrating today wants what
-- happens from today, and a backfill is a separate, deliberate, rate-
-- limited operation, not the default behaviour of turning the feature on.
INSERT INTO outbound_cursor (stream, last_sequence)
SELECT 'journal', COALESCE(MAX(booking_seq), 0) FROM journal_entry;

-- ---------------------------------------------------------------------
-- 6.  Deliveries
-- ---------------------------------------------------------------------

-- Three states, and the reasons are the inbox's reasons.
--
-- There is no 'failed' or 'retrying' state: a delivery that failed and
-- will be tried again is `pending` with `attempts > 0` and
-- `next_attempt_at` in the future. A lease (`locked_until`) is a timeout
-- and not a state, so a worker that dies releases its work by doing
-- nothing at all.
CREATE TYPE outbound_delivery_state AS ENUM ('pending', 'delivered', 'dead');

CREATE TABLE outbound_delivery (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         uuid NOT NULL REFERENCES outbound_event(id),
  endpoint_id      uuid NOT NULL REFERENCES outbound_endpoint(id),
  state            outbound_delivery_state NOT NULL DEFAULT 'pending',

  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_until     timestamptz,

  -- What came back last. Bounded, because a customer's error page is not
  -- our storage budget and an unbounded body from an untrusted host is a
  -- denial-of-service vector with a `text` column for a target.
  last_status      integer,
  last_error       text,
  last_attempt_at  timestamptz,

  delivered_at     timestamptz,
  dead_at          timestamptz,
  -- The dead-letter message NAMES THE MISSING THING. "invalid request" is
  -- what the inbound side used to say and the reason nobody could act on
  -- it; this one says "8 attempts, last: HTTP 503 from <host>" or
  -- "endpoint resolved to 10.0.0.5, a private address".
  dead_reason      text,

  created_at       timestamptz NOT NULL DEFAULT now(),

  -- THE FAN-OUT REPLAY GUARD. One event reaches one endpoint once. The
  -- generator is at-least-once and this index is what makes the second
  -- pass a no-op.
  CONSTRAINT outbound_delivery_once UNIQUE (event_id, endpoint_id),
  CONSTRAINT outbound_delivery_attempts_nonneg CHECK (attempts >= 0),
  CONSTRAINT outbound_delivery_terminal_shape CHECK (
    (state = 'delivered') = (delivered_at IS NOT NULL)
    AND (state = 'dead') = (dead_at IS NOT NULL)
    AND (dead_at IS NULL) = (dead_reason IS NULL)
  ),
  CONSTRAINT outbound_delivery_error_len CHECK (last_error IS NULL OR length(last_error) <= 2000),
  CONSTRAINT outbound_delivery_dead_len  CHECK (dead_reason IS NULL OR length(dead_reason) <= 2000)
);

-- The poll: due, unclaimed, oldest first. Partial, so the index stays the
-- size of the backlog rather than the size of history.
CREATE INDEX outbound_delivery_due_idx
  ON outbound_delivery (next_attempt_at, created_at)
  WHERE state = 'pending';

CREATE INDEX outbound_delivery_endpoint_idx ON outbound_delivery (endpoint_id, created_at DESC);
CREATE INDEX outbound_delivery_event_idx    ON outbound_delivery (event_id);
CREATE INDEX outbound_delivery_dead_idx     ON outbound_delivery (dead_at DESC) WHERE state = 'dead';

-- Every attempt, append-only. This is the delivery log the customer sees.
--
-- A `last_status` column on the delivery row answers "what happened"; it
-- cannot answer "what has been happening", which is the question a
-- customer debugging a flaky endpoint actually has. So each attempt is a
-- row, and the row records the two things that settle an argument: the
-- `webhook-id` we signed under, and the IP WE ACTUALLY CONNECTED TO.
--
-- `resolved_ip` is unusual and it is the SSRF audit trail. The URL says
-- one thing; DNS decides another, and it can decide differently on every
-- attempt. Recording the address the socket went to means "did we ever
-- connect to something internal" is a query rather than an argument.
CREATE TABLE outbound_attempt (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id        uuid NOT NULL REFERENCES outbound_delivery(id),
  attempt_no         integer NOT NULL,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  duration_ms        integer NOT NULL,

  -- NULL when we never got a response (DNS, TLS, timeout, refusal).
  response_status    integer,
  -- Bounded to 1 KiB. Evidence, not a mirror of the customer's server.
  response_excerpt   text,
  error              text,

  -- The signature inputs, so a customer's "your signature is wrong" is
  -- settled by recomputation rather than by trust. The SIGNATURE itself is
  -- reproducible from these plus `outbound_event.body` plus the secret --
  -- and the secret is not here, so this table can be read by anyone who
  -- can read the delivery log without leaking the key.
  webhook_id         text NOT NULL,
  webhook_timestamp  bigint NOT NULL,
  secret_version     integer NOT NULL,

  -- The address the socket actually connected to. See above.
  resolved_ip        inet,

  CONSTRAINT outbound_attempt_once UNIQUE (delivery_id, attempt_no),
  CONSTRAINT outbound_attempt_no_positive CHECK (attempt_no >= 1),
  CONSTRAINT outbound_attempt_duration CHECK (duration_ms >= 0),
  CONSTRAINT outbound_attempt_excerpt_len CHECK (response_excerpt IS NULL OR length(response_excerpt) <= 1024),
  CONSTRAINT outbound_attempt_error_len   CHECK (error IS NULL OR length(error) <= 2000)
);

CREATE INDEX outbound_attempt_delivery_idx ON outbound_attempt (delivery_id, attempt_no DESC);
CREATE INDEX outbound_attempt_time_idx     ON outbound_attempt (requested_at DESC);

-- ---------------------------------------------------------------------
-- 7.  Guards: what is a fact, and what is processing state
-- ---------------------------------------------------------------------
--
-- Same line 0002 drew across `webhook_inbox`, drawn again. What we SENT
-- is immutable -- the bytes, the event, the attempt and its response are
-- evidence, and evidence that can be edited is not evidence. What we are
-- DOING about it (retry counters, the lease, the terminal state) advances
-- in one direction only.

CREATE OR REPLACE FUNCTION outbound_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbound_event is append-only: what we sent a customer is evidence'
      USING ERRCODE = '55006';
  END IF;
  RAISE EXCEPTION 'outbound_event is immutable: the signed bytes may never change'
    USING ERRCODE = '55006';
END $$;

CREATE TRIGGER outbound_event_immutable
  BEFORE UPDATE OR DELETE ON outbound_event
  FOR EACH ROW EXECUTE FUNCTION outbound_event_guard();

CREATE OR REPLACE FUNCTION outbound_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outbound_attempt is append-only: a delivery log that can be edited is not a log'
    USING ERRCODE = '55006';
END $$;

CREATE TRIGGER outbound_attempt_append_only
  BEFORE UPDATE OR DELETE ON outbound_attempt
  FOR EACH ROW EXECUTE FUNCTION outbound_attempt_guard();

CREATE OR REPLACE FUNCTION outbound_delivery_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'outbound_delivery is append-only' USING ERRCODE = '55006';
  END IF;

  -- The pairing is the fact. Which event went to which endpoint can never
  -- be restated, or the delivery log becomes a story rather than a record.
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'outbound_delivery identity is immutable' USING ERRCODE = '55006';
  END IF;

  -- Terminal is terminal. Both directions, and the second one matters
  -- more: a `dead` row that can go back to `pending` behind an operator's
  -- back is a dead letter that quietly un-dead-letters itself, and the
  -- screen would be reporting a queue depth nobody can trust. Requeue
  -- exists (§8) and it is an OWNER operation, not something the
  -- application role can express.
  IF OLD.state = 'delivered' AND NEW.state IS DISTINCT FROM 'delivered' THEN
    RAISE EXCEPTION 'a delivered webhook cannot be undelivered' USING ERRCODE = '55006';
  END IF;
  IF OLD.state = 'dead' AND NEW.state IS DISTINCT FROM 'dead' THEN
    RAISE EXCEPTION 'a dead-lettered delivery is requeued by the owner, not by the app'
      USING ERRCODE = '55006';
  END IF;

  -- Attempts climb. This is the poison-message defence, the same one the
  -- inbox has: a worker that dies mid-delivery has still spent an attempt,
  -- so an endpoint that reliably kills workers cannot loop for ever.
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'outbound_delivery.attempts may only climb' USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER outbound_delivery_immutable_facts
  BEFORE UPDATE OR DELETE ON outbound_delivery
  FOR EACH ROW EXECUTE FUNCTION outbound_delivery_guard();

CREATE OR REPLACE FUNCTION outbound_secret_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a signing secret is retired, never deleted: deliveries signed under it must stay explainable'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.secret IS DISTINCT FROM OLD.secret
     OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a signing secret is immutable; rotation inserts a new version'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'retired_at only moves once, NULL -> timestamp' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbound_secret_immutable
  BEFORE UPDATE OR DELETE ON outbound_endpoint_secret
  FOR EACH ROW EXECUTE FUNCTION outbound_secret_guard();

CREATE OR REPLACE FUNCTION outbound_cursor_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'the outbound cursor is not deleted' USING ERRCODE = '55006';
  END IF;
  IF NEW.last_sequence < OLD.last_sequence THEN
    RAISE EXCEPTION 'the outbound cursor only moves forwards (% -> %)', OLD.last_sequence, NEW.last_sequence
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbound_cursor_forward_only
  BEFORE UPDATE OR DELETE ON outbound_cursor
  FOR EACH ROW EXECUTE FUNCTION outbound_cursor_guard();

CREATE OR REPLACE FUNCTION outbound_endpoint_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an endpoint is disabled, never deleted: its delivery log must survive it'
      USING ERRCODE = '55006';
  END IF;
  -- The URL is pinned once registered. Editing it in place would move
  -- every historical delivery in the log onto a destination that never
  -- received it, and -- the reason it is a trigger and not a review
  -- comment -- it would be a way to point a validated endpoint at an
  -- internal address AFTER the SSRF checks ran on the original. A new
  -- destination is a new endpoint row, with new checks and a new secret.
  IF NEW.url IS DISTINCT FROM OLD.url
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an endpoint URL is immutable; register a new endpoint instead'
      USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbound_endpoint_immutable_url
  BEFORE UPDATE OR DELETE ON outbound_endpoint
  FOR EACH ROW EXECUTE FUNCTION outbound_endpoint_guard();

-- ---------------------------------------------------------------------
-- 8.  Privileges
-- ---------------------------------------------------------------------
--
-- Layer 1, the same as 0001 §13: the application cannot express the
-- statements it must never issue, so they are an absent capability rather
-- than a check somebody can forget.
--
-- Note what corgi_app does NOT get: UPDATE on `outbound_endpoint_secret`
-- except `retired_at`, UPDATE on `outbound_event` or `outbound_attempt`
-- at all, and DELETE on anything. Requeuing a dead letter is deliberately
-- an owner operation -- it is an ops decision taken after a bug is fixed,
-- and the difference between "an operator requeued it" and "the app
-- requeued it" is the difference between a decision and a loop.

GRANT SELECT, INSERT ON
  outbound_endpoint, outbound_endpoint_secret, outbound_event,
  outbound_delivery, outbound_attempt, outbound_cursor
TO corgi_app;

REVOKE UPDATE, DELETE, TRUNCATE ON
  outbound_endpoint, outbound_endpoint_secret, outbound_event,
  outbound_delivery, outbound_attempt, outbound_cursor
FROM corgi_app, PUBLIC;

-- Processing state, and nothing else.
GRANT UPDATE (state, attempts, next_attempt_at, locked_until,
              last_status, last_error, last_attempt_at,
              delivered_at, dead_at, dead_reason)
  ON outbound_delivery TO corgi_app;

GRANT UPDATE (last_sequence, updated_at) ON outbound_cursor TO corgi_app;
GRANT UPDATE (status, disabled_at, description, event_types) ON outbound_endpoint TO corgi_app;
GRANT UPDATE (retired_at) ON outbound_endpoint_secret TO corgi_app;

-- ---------------------------------------------------------------------
-- 9.  The screen's two views
-- ---------------------------------------------------------------------
--
-- Views rather than queries in TypeScript, for the reason 0002 gave for
-- `v_webhook_dead_letter`: a view cannot go stale against a schema change,
-- and the customer-facing delivery log and the operator's dead-letter
-- list must be reading the same join or they will eventually disagree in
-- front of somebody.
--
-- NEITHER VIEW SELECTS A SECRET, and neither joins the secret table. That
-- is checked by reading them, which is the point of putting the join in
-- SQL where it can be read.

CREATE VIEW v_outbound_delivery AS
SELECT d.id                AS delivery_id,
       d.state,
       d.attempts,
       d.next_attempt_at,
       d.last_status,
       d.last_error,
       d.last_attempt_at,
       d.delivered_at,
       d.dead_at,
       d.dead_reason,
       d.created_at        AS queued_at,
       e.id                AS event_id,
       e.business_id,
       e.event_type,
       e.sequence,
       e.occurred_at,
       e.value_date,
       e.source_entry_id,
       length(e.body)      AS body_bytes,
       ep.id               AS endpoint_id,
       ep.url,
       ep.description      AS endpoint_description,
       ep.status           AS endpoint_status,
       -- The last attempt's evidence, flattened for the table.
       a.attempt_no        AS last_attempt_no,
       a.response_status   AS last_response_status,
       a.response_excerpt  AS last_response_excerpt,
       a.duration_ms       AS last_duration_ms,
       a.resolved_ip       AS last_resolved_ip,
       a.webhook_id        AS last_webhook_id
  FROM outbound_delivery d
  JOIN outbound_event    e  ON e.id = d.event_id
  JOIN outbound_endpoint ep ON ep.id = d.endpoint_id
  LEFT JOIN LATERAL (
    SELECT * FROM outbound_attempt at2
     WHERE at2.delivery_id = d.id
     ORDER BY at2.attempt_no DESC
     LIMIT 1
  ) a ON true;

-- The dead letter, as a view so it cannot go stale.
CREATE VIEW v_outbound_dead_letter AS
SELECT delivery_id, business_id, endpoint_id, url, event_id, event_type,
       sequence, attempts, dead_at, dead_reason, last_status, last_response_excerpt
  FROM v_outbound_delivery
 WHERE state = 'dead';

GRANT SELECT ON v_outbound_delivery, v_outbound_dead_letter TO corgi_app;
