-- =====================================================================
-- 0038_webhook_refusals.sql  ·  Corgi work trial, Track 3
--
-- A REFUSED WEBHOOK IS A ROW.
--
-- docs/AUDIT.md §2.1 item 2: `src/lib/webhooks/route-handler.ts` answers a
-- forged delivery with 401 and the sentence "signature verification
-- failed; nothing was stored".  The refusal is correct -- an
-- unauthenticated body is not evidence of anything and must never reach
-- the inbox -- but it leaves NO ROW ANYWHERE.  `webhook_inbox` therefore
-- holds only the deliveries we ACCEPTED, so every count, trail and
-- dashboard built on it reads complete while the entire population of
-- forged, misrouted and stale attempts is invisible.  An operator asking
-- "is anyone hammering our webhook endpoints?" gets silence, and silence
-- is indistinguishable from safety.
--
-- The precedent this follows is `payee_candidate_refusal` (0016 §2, §10):
-- "a blocked candidate never becomes a payee, so without this table the
-- caught typo would leave no trace at all".  Same shape, same reason.
--
-- Named `webhook_refusal`, not `webhook_rejection` as AUDIT.md §2
-- sketched it, to share the vocabulary of the precedent it cites.
--
-- ---------------------------------------------------------------------
-- WHAT THIS TABLE MUST NOT BECOME
-- ---------------------------------------------------------------------
--
-- The counterparty here is UNAUTHENTICATED.  Every byte of a refused
-- delivery is chosen by whoever sent it, and this endpoint is open to
-- the internet.  So a table on the 401 path is, by construction, a place
-- where an attacker picks what our database contains and what our
-- screens render.  Two rules follow, and every column below obeys them:
--
--   1. NOTHING ATTACKER-CHOSEN IS STORED AS TEXT.  Not the body, not a
--      header value, not the signature, not the user agent, not the
--      request id (`requestIdFrom` reads a caller-supplied
--      `x-request-id`), and not the verifier's own reason string -- that
--      last one looks safe and is not: `plaidVerifier` builds
--      "unexpected alg '<attacker string>'" and "no verification key for
--      kid <attacker string>".  What is kept instead is a SHA-256 of the
--      body (64 hex characters, fixed width, attacker-uninfluenceable in
--      shape), a byte count, a reason drawn from an enum WE define, and
--      a signature-shape token drawn from a closed grammar.
--
--   2. EVERY COLUMN IS BOUNDED BY ITS TYPE OR A CHECK.  `source_ip` is
--      `inet`, so a hostile x-forwarded-for cannot smuggle anything
--      through -- the parser is the validator.  `provider` is the
--      sanitised path segment with a regex on it.  `signature_shape`
--      matches a closed pattern.  An attacker who finds a way to write
--      arbitrary text into this table has to get past Postgres first.
--
-- ---------------------------------------------------------------------
-- WHY THERE IS A COUNTER AND NOT ONE ROW PER REQUEST
-- ---------------------------------------------------------------------
--
-- One row per rejected request is free storage for anyone who finds the
-- URL: the endpoint is unauthenticated, so the write amplification is
-- exactly the attack.  A row here is therefore a BUCKET --
-- (provider, reason_code, source_ip, minute) -- carrying a count, an
-- exemplar, and a window.  Ten thousand forged deliveries from one
-- address in one minute are one row saying 10000, not ten thousand rows.
--
-- The application adds a second bound on top of this one (a per-instance
-- cap on rows written per minute, with the overflow folded into a row
-- whose `source_ip` is NULL and whose `source_header` is 'folded').
-- See src/lib/webhooks/refusals.ts and docs/WEBHOOKS.md for what that
-- costs.
--
-- Conventions inherited from 0001: uuid primary keys, timestamptz for
-- every instant.  NO MONEY COLUMN, and there never is one: nothing in
-- this table has been authenticated, so nothing in it may ever be used
-- to decide where money goes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1.  The reasons
-- ---------------------------------------------------------------------
--
-- These are OURS -- an enum, exactly as `webhook_inbox_state` is an enum
-- while `provider` stays plain text.  A single `invalid` bucket would
-- throw away the only thing this table is for, because these are FIVE
-- DIFFERENT OPERATIONAL STORIES with five different owners:
--
--   unknown_provider          A POST to /api/webhooks/<segment> we have
--                             no verifier for.  Nobody real sends this:
--                             a provider only ever posts to the URL we
--                             gave it.  Scanning, or our own copy-paste
--                             error in a provider dashboard.  THE BODY
--                             OF THESE IS NEVER READ (see §2), which is
--                             why their body columns are null.
--
--   signature_absent          The signature headers the scheme requires
--                             are not present at all.  A naive forgery,
--                             a health-check probe, or a load balancer
--                             stripping headers.
--
--   signature_malformed       A signature header IS present but does not
--                             parse as this provider's scheme.  The
--                             MISROUTING signal: a Stripe delivery
--                             arriving at the Lithic endpoint looks
--                             exactly like this, and so does a provider
--                             that changed its scheme under us.
--
--   signature_mismatch        A well-formed signature that DID NOT
--                             VERIFY.  Two causes and no third: our
--                             secret is wrong (rotated in the provider
--                             dashboard and not here -- in which case we
--                             are silently dropping real money events),
--                             or someone is forging.  Telling them apart
--                             is `source_ip`'s job: the provider's
--                             address means the secret; a stranger's
--                             means the stranger.  This is the row that
--                             should page somebody.
--
--   timestamp_outside_window  The signature's timestamp is outside the
--                             ±300s replay window, or is not a unix
--                             second count.  Either a replayed capture
--                             (the replay defence doing its job) or our
--                             clock has drifted and we are now refusing
--                             GENUINE deliveries -- the failure mode
--                             that looks like an attack and is an
--                             outage.
--
-- Re-runnable: a migration that can only be applied to an empty database
-- is a migration that cannot be applied to a restored one.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'webhook_refusal_reason') THEN
    CREATE TYPE webhook_refusal_reason AS ENUM (
      'unknown_provider',
      'signature_absent',
      'signature_malformed',
      'signature_mismatch',
      'timestamp_outside_window'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------
-- 2.  The table
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_refusal (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ---- what was aimed at ------------------------------------------
  -- The path segment AS SANITISED by the route handler: [A-Za-z0-9_-]
  -- only, 40 characters at most, and possibly empty.  Empty is a
  -- representable value on purpose -- `POST /api/webhooks/%00` is a real
  -- thing to be told about -- which is why the regex allows {0,40} and
  -- not {1,40}.  Bounded HERE as well as in the application because a
  -- second copy of a rule that the database enforces is a rule that
  -- holds when the application is wrong.
  provider          text NOT NULL
                    CHECK (provider ~ '^[A-Za-z0-9_-]{0,40}$'),
  -- Derived from `provider`, not read from the request.  Kept because it
  -- is what an operator greps for, and because the day a second webhook
  -- mount point exists this column is already the discriminator.
  endpoint          text NOT NULL
                    CHECK (endpoint ~ '^/api/webhooks/[A-Za-z0-9_-]{0,40}$'),

  -- ---- why it was refused ------------------------------------------
  reason_code       webhook_refusal_reason NOT NULL,

  -- ---- who sent it, as far as the edge will say ---------------------
  -- `inet`, never text.  A forwarded-for header is attacker-influenced,
  -- and the TYPE is the validator: an address that does not parse is
  -- stored as NULL with source_header = 'unparseable' rather than
  -- preserved as a string nobody sanitised.
  --
  -- NULL means one of three things, and `source_header` says which:
  --   'none'         no forwarding header was present (direct hit)
  --   'unparseable'  a header was present and was not an IP address
  --   'folded'       the per-minute write budget was spent and this row
  --                  aggregates an unrecorded set of sources
  source_ip         inet,
  -- WHICH header the address came from, so an operator knows how much to
  -- trust it.  A closed set: this can never hold a header name a caller
  -- invented.  Ordered by trust in the application -- the platform's own
  -- header first, the caller-settable one last.
  source_header     text NOT NULL
                    CHECK (source_header IN ('x-vercel-forwarded-for',
                                             'x-real-ip',
                                             'x-forwarded-for',
                                             'none',
                                             'unparseable',
                                             'folded')),

  -- ---- the bucket ---------------------------------------------------
  -- The aggregation key's time component.  One row per minute per
  -- (provider, reason, source), so the write rate is bounded by the
  -- clock rather than by the attacker's request rate.
  minute_bucket     timestamptz NOT NULL
                    CHECK (minute_bucket = date_trunc('minute', minute_bucket)),
  first_seen_at     timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL,
  -- How many refused requests this row stands for.  Only ever climbs;
  -- the trigger in §4 enforces that.
  refusals          integer NOT NULL DEFAULT 1 CHECK (refusals > 0),

  -- ---- the exemplar: the SHAPE of the delivery, never its content ---
  --
  -- These describe the FIRST refused request in the bucket.  Requests
  -- 2..N contribute to `refusals` and to `body_varied` and are otherwise
  -- not individually described.  That is the cost of aggregating and it
  -- is stated rather than hidden.
  signature_present boolean NOT NULL,
  -- A token from a closed grammar, generated by us from the header's
  -- STRUCTURE: 'absent', 'unparsed', 'swh:v1x2' (Standard Webhooks, two
  -- v1 entries -- what a secret rotation looks like), 'tshmac:t+v1x1',
  -- 'jwt:3part'.  Never the header's bytes.  The regex is the guarantee.
  signature_shape   text NOT NULL
                    CHECK (signature_shape ~ '^[a-z]+(:[a-z0-9+_-]{1,24})?$'
                           AND length(signature_shape) <= 32),
  -- The header's LENGTH.  A 43-character v1 entry is the right shape for
  -- base64 HMAC-SHA256; a 12-character one is somebody guessing.
  signature_bytes   integer CHECK (signature_bytes IS NULL OR signature_bytes >= 0),

  -- THE BODY, AS A FIXED-WIDTH DIGEST AND A LENGTH, AND IN NO OTHER
  -- FORM.  This is the whole argument of the table in two columns: the
  -- hash answers "is this the same forged payload again?" and "is this
  -- the delivery the provider says it sent?" -- you can hash a body the
  -- provider replays from its dashboard and compare -- without ever
  -- putting a byte the attacker chose into our database or onto a
  -- screen.  What it cannot answer is "what did the forgery SAY", and
  -- that is the deliberate trade: a forged body is an attacker-authored
  -- document, and a system that stores one has accepted a submission
  -- from an unauthenticated stranger.
  body_bytes        bigint CHECK (body_bytes IS NULL OR body_bytes >= 0),
  body_sha256       text   CHECK (body_sha256 IS NULL OR body_sha256 ~ '^[0-9a-f]{64}$'),
  -- Set true the first time a request in this bucket carries a body hash
  -- different from the exemplar's.  One boolean that separates "the same
  -- captured delivery replayed 10,000 times" from "10,000 different
  -- probes", which are different attacks.
  body_varied       boolean NOT NULL DEFAULT false,

  CONSTRAINT webhook_refusal_window_ordered
    CHECK (last_seen_at >= first_seen_at),
  CONSTRAINT webhook_refusal_window_is_in_its_bucket
    CHECK (first_seen_at >= minute_bucket),

  -- THE ORDER OF OPERATIONS, AS A CONSTRAINT.
  --
  -- `unknown_provider` is decided from the path segment alone, before
  -- the body is touched: there is no verifier, so there is nothing that
  -- could ever authenticate those bytes and no reason to read them.
  -- Every other reason is decided by a verifier, which by definition has
  -- already read the raw body.  So "body columns are null if and only if
  -- the reason is unknown_provider" is not bookkeeping -- it is the
  -- read-before-authenticate rule, enforced by the database.  A future
  -- edit that starts reading the body of an unroutable request cannot
  -- store the result without tripping this.
  CONSTRAINT webhook_refusal_body_read_iff_there_was_a_verifier
    CHECK ((reason_code = 'unknown_provider') = (body_sha256 IS NULL)),
  CONSTRAINT webhook_refusal_body_facts_are_a_pair
    CHECK ((body_sha256 IS NULL) = (body_bytes IS NULL)),
  -- A folded row aggregates sources it did not record, so it must not
  -- claim one; and a row that recorded an address must say which header
  -- it came from.
  CONSTRAINT webhook_refusal_folded_has_no_source
    CHECK (source_header <> 'folded' OR source_ip IS NULL),
  CONSTRAINT webhook_refusal_source_pair
    CHECK ((source_ip IS NULL)
           = (source_header IN ('none', 'unparseable', 'folded')))
);

COMMENT ON TABLE webhook_refusal IS
  'Every inbound webhook we refused, aggregated per (provider, reason, source, minute). The 401 path stores nothing of the payload but its SHA-256 and its length: an unauthenticated body is an attacker-authored document and is never kept verbatim.';
COMMENT ON COLUMN webhook_refusal.body_sha256 IS
  'SHA-256 of the exact refused bytes. Fixed width, attacker-uninfluenceable in shape, and enough to answer "the same forgery again?" and "is this the delivery the provider says it sent?" without storing what it said.';
COMMENT ON COLUMN webhook_refusal.refusals IS
  'Requests this bucket stands for. A row is a minute, not a request: an unauthenticated endpoint that writes a row per POST is free storage for whoever finds it.';
COMMENT ON COLUMN webhook_refusal.reason_code IS
  'Ours, hence an enum. A single invalid bucket would throw away the only thing this table is for: a wrong secret and an attacker are different incidents.';
COMMENT ON COLUMN webhook_refusal.source_header IS
  'Which forwarding header the address was read from, so an operator knows how much to trust it. A closed set, never a caller-supplied header name.';

-- ---------------------------------------------------------------------
-- 3.  Indexes
-- ---------------------------------------------------------------------

-- THE BUCKET KEY, and therefore the ON CONFLICT target.  The unique
-- index is what decides "new bucket" versus "another one in the bucket I
-- already have" -- the same construction the inbox uses for replay, for
-- the same reason: a SELECT-then-INSERT has a race between its two
-- statements and this has none.
--
-- NULLS NOT DISTINCT (PG15+) because `source_ip` is NULL for the three
-- source-less cases and those must still aggregate rather than
-- accumulate a row per request -- the default NULL semantics would make
-- every unattributed refusal its own row, which is precisely the
-- unbounded write this design exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_refusal_bucket_key
  ON webhook_refusal (provider, reason_code, minute_bucket, source_ip, source_header)
  NULLS NOT DISTINCT;

-- "What has been hitting us, newest first" -- the operator's question,
-- and the rate query in §5.
CREATE INDEX IF NOT EXISTS webhook_refusal_recent_idx
  ON webhook_refusal (minute_bucket DESC, provider);

-- "Has THIS address been at it before?", asked after one row looks bad.
-- Partial: a row with no address cannot answer the question.
CREATE INDEX IF NOT EXISTS webhook_refusal_source_idx
  ON webhook_refusal (source_ip, minute_bucket DESC)
  WHERE source_ip IS NOT NULL;

-- ---------------------------------------------------------------------
-- 4.  Append-mostly, with a NAMED GUARD
-- ---------------------------------------------------------------------
--
-- This table is not append-ONLY, and the exception is deliberate and
-- narrow: `refusals`, `last_seen_at` and `body_varied` advance as a
-- bucket fills, because the alternative is a row per request, which is
-- the attack.  It is exactly the carve-out `webhook_inbox` already
-- holds, and it is defended the same way -- a column-level GRANT so the
-- application CANNOT EXPRESS a rewrite of the facts, plus a trigger so
-- the owner cannot either.
--
-- The evidence -- who, when, which endpoint, which reason, which body
-- hash -- is immutable from the instant it lands.
CREATE OR REPLACE FUNCTION webhook_refusal_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webhook_refusal rows are never deleted'
      USING ERRCODE = '55006',
            HINT = 'A refusal that can be deleted is not evidence. Retention is a job that has not been written; when it is, it summarises and never erases.';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'webhook_refusal is never truncated' USING ERRCODE = '55006';
  END IF;

  IF NEW.provider          IS DISTINCT FROM OLD.provider
  OR NEW.endpoint          IS DISTINCT FROM OLD.endpoint
  OR NEW.reason_code       IS DISTINCT FROM OLD.reason_code
  OR NEW.source_ip         IS DISTINCT FROM OLD.source_ip
  OR NEW.source_header     IS DISTINCT FROM OLD.source_header
  OR NEW.minute_bucket     IS DISTINCT FROM OLD.minute_bucket
  OR NEW.first_seen_at     IS DISTINCT FROM OLD.first_seen_at
  OR NEW.signature_present IS DISTINCT FROM OLD.signature_present
  OR NEW.signature_shape   IS DISTINCT FROM OLD.signature_shape
  OR NEW.signature_bytes   IS DISTINCT FROM OLD.signature_bytes
  OR NEW.body_bytes        IS DISTINCT FROM OLD.body_bytes
  OR NEW.body_sha256       IS DISTINCT FROM OLD.body_sha256 THEN
    RAISE EXCEPTION 'what a refused caller sent is immutable' USING ERRCODE = '55006';
  END IF;

  -- A counter that can go down is a counter someone can launder an
  -- attack through.
  IF NEW.refusals < OLD.refusals THEN
    RAISE EXCEPTION 'webhook_refusal.refusals only increases' USING ERRCODE = '55006';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at THEN
    RAISE EXCEPTION 'webhook_refusal.last_seen_at only moves forward' USING ERRCODE = '55006';
  END IF;
  -- One-way door: a bucket that has seen two different bodies has seen
  -- them, and no later write may un-see it.
  IF OLD.body_varied AND NOT NEW.body_varied THEN
    RAISE EXCEPTION 'webhook_refusal.body_varied never returns to false' USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS webhook_refusal_immutable_facts ON webhook_refusal;
CREATE TRIGGER webhook_refusal_immutable_facts
  BEFORE UPDATE OR DELETE ON webhook_refusal
  FOR EACH ROW EXECUTE FUNCTION webhook_refusal_guard();

DROP TRIGGER IF EXISTS webhook_refusal_no_truncate ON webhook_refusal;
CREATE TRIGGER webhook_refusal_no_truncate
  BEFORE TRUNCATE ON webhook_refusal
  FOR EACH STATEMENT EXECUTE FUNCTION webhook_refusal_guard();

-- ---------------------------------------------------------------------
-- 5.  Views
-- ---------------------------------------------------------------------

-- What an operator opens after the pager goes off.  Newest first, 24
-- hours, every column that is safe to render -- which is all of them,
-- because nothing attacker-authored is in the table.
CREATE OR REPLACE VIEW v_webhook_refusal_recent AS
SELECT id,
       provider,
       endpoint,
       reason_code,
       source_ip,
       source_header,
       minute_bucket,
       first_seen_at,
       last_seen_at,
       refusals,
       signature_present,
       signature_shape,
       signature_bytes,
       body_bytes,
       body_sha256,
       body_varied
  FROM webhook_refusal
 WHERE minute_bucket >= now() - interval '24 hours'
 ORDER BY minute_bucket DESC, refusals DESC;

COMMENT ON VIEW v_webhook_refusal_recent IS
  'The refused deliveries of the last 24 hours. The half of the webhook traffic webhook_inbox cannot hold, because webhook_inbox holds only what verified.';

-- The rate, per provider per reason, over two windows.  A view rather
-- than a query in TypeScript so the health endpoint and a psql session
-- read the same definition -- the same reasoning as
-- `payee_verification_freshness()` in 0016: two copies of a rule held
-- equal by nothing will not stay equal.
--
-- `distinct_sources` is the number the shape of the incident turns on:
-- one address is a misconfigured integration or one scanner; four
-- hundred is a botnet.  Folded rows (source_ip IS NULL) are counted in
-- `folded_rows` instead, so an attack big enough to spend the write
-- budget is visible AS an attack big enough to spend the write budget.
CREATE OR REPLACE VIEW v_webhook_refusal_rate AS
SELECT provider,
       reason_code,
       sum(refusals) FILTER (WHERE minute_bucket >= now() - interval '15 minutes')::bigint
         AS refusals_15m,
       sum(refusals) FILTER (WHERE minute_bucket >= now() - interval '24 hours')::bigint
         AS refusals_24h,
       count(DISTINCT source_ip) FILTER (WHERE minute_bucket >= now() - interval '24 hours')::bigint
         AS distinct_sources_24h,
       count(*) FILTER (WHERE source_header = 'folded'
                          AND minute_bucket >= now() - interval '24 hours')::bigint
         AS folded_rows_24h,
       max(last_seen_at) AS last_seen_at
  FROM webhook_refusal
 WHERE minute_bucket >= now() - interval '24 hours'
 GROUP BY provider, reason_code;

COMMENT ON VIEW v_webhook_refusal_rate IS
  'Refusal rate per provider per reason over 15 minutes and 24 hours. Read by /api/health so a refusal rate sits beside consumed, parked and dead-lettered depth instead of only in a log line.';

-- ---------------------------------------------------------------------
-- 6.  Privileges
-- ---------------------------------------------------------------------

-- INSERT and the three advancing columns, and nothing else.  The
-- application cannot express an UPDATE that rewrites what a refused
-- caller sent, and cannot express a DELETE at all: an absent capability
-- rather than a check someone could forget.  0001's words, applied here.
GRANT SELECT, INSERT ON webhook_refusal TO corgi_app;
GRANT UPDATE (refusals, last_seen_at, body_varied) ON webhook_refusal TO corgi_app;

-- Explicit and redundant, so a reviewer can grep for it.
REVOKE DELETE, TRUNCATE ON webhook_refusal FROM corgi_app, PUBLIC;

GRANT SELECT ON v_webhook_refusal_recent, v_webhook_refusal_rate TO corgi_app;

-- ---------------------------------------------------------------------
-- 7.  The audit registry
-- ---------------------------------------------------------------------
--
-- 0035 §7: "a migration that adds an action store and does not append to
-- `audit_source` turns `v_audit_source_unclaimed` non-empty, and the
-- audit screen prints it in red on its face."  The detector is every
-- base table in the schema, so this table MUST be classified.
--
-- Classified `excluded`, and the reason is the point rather than an
-- excuse: `v_actor_action` is a BUSINESS TIMELINE keyed by an actor, and
-- a refused webhook has neither.  The counterparty is an unauthenticated
-- stranger with no `actor` row, and the delivery names no business --
-- it could not, because naming one would mean reading and trusting a
-- body we just refused.  Projecting it would mean inventing an actor and
-- a business for every scanner on the internet, which would corrupt the
-- one trail the audit screen exists to keep honest.
--
-- Its home is the OPERATIONAL surface instead: `v_webhook_refusal_rate`,
-- `/api/health`'s webhookProcessing family, and docs/WEBHOOKS.md.  The
-- gap docs/AUDIT.md §2.1 named is closed by the table existing, not by
-- the timeline rendering it.
--
-- Re-runnable, and appending rather than rewriting: `audit_source`
-- refuses UPDATE, and the history of what the trail CLAIMED to cover is
-- itself evidence.
INSERT INTO audit_source (table_name, disposition, surface, reason, declared_in)
SELECT 'webhook_refusal', 'excluded', NULL,
       'Inbound webhooks we refused, bucketed per (provider, reason, source, minute). NOT on the actor timeline: the counterparty is unauthenticated, has no actor row, and names no business — projecting it would mean inventing an actor for every scanner on the internet. Surfaced operationally in v_webhook_refusal_rate and /api/health instead. Closes docs/AUDIT.md §2.1 item 2.',
       '0038_webhook_refusals.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM audit_source s WHERE s.table_name = 'webhook_refusal'
);
