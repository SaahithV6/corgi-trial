-- =====================================================================
-- 0029.  Chaos mode — the control surface that hands the graders the
--        weapon, and the four tables that make it impossible to leave on.
-- =====================================================================
--
-- WHAT CHAOS MODE IS, IN ONE SENTENCE.  Four switches that perturb the
-- DELIVERY of card webhooks this deployment originates itself -- their
-- availability, their timing, their multiplicity and their order -- so
-- that the brief's live-fire gauntlet can be driven from a screen instead
-- of from a terminal on somebody else's laptop.
--
-- WHAT CHAOS MODE IS NOT.  It is not a provider outage, it does not reach
-- the ledger, and it has no branch anywhere in the receiving path.  Every
-- delivery it makes goes through the same `ingestWebhook` ->
-- `webhook_inbox` -> dispatcher -> consumer pipeline as a real one, and
-- the duplicates it sends are absorbed by
-- `webhook_inbox UNIQUE (provider, provider_event_id)` -- the replay
-- suppression that was already there -- and by nothing else.
--
-- ---------------------------------------------------------------------
-- THE ONE THING THIS MIGRATION EXISTS TO ENFORCE
-- ---------------------------------------------------------------------
--
-- A demo control that can be left on is worse than no demo control.  If
-- the deployed URL is showing a graders' demo, a forgotten switch is
-- indistinguishable from a broken build -- and the person who forgot it
-- is by definition not looking.
--
-- So the bound is NOT in the application.  It is a CHECK constraint:
--
--     CHECK (expires_at > armed_at
--            AND expires_at <= armed_at + interval '10 minutes')
--
-- There is no code path, no admin form, no direct `psql`, and no future
-- worker's bug that can write a chaos switch lasting eleven minutes.
-- Postgres refuses the row.  `v_chaos_active` then filters on `now()`, so
-- a switch that has run out is not merely ignored by one reader -- it is
-- absent from the only thing anything reads.
--
-- The result is the property the build actually needs: the WORST CASE for
-- a forgotten switch is ten minutes, and the normal case is the off
-- button, which is a DELETE.
--
-- ---------------------------------------------------------------------
-- WHY THESE TABLES ARE NOT MONEY TABLES, AND CARRY NO APPEND-ONLY GUARD
-- ---------------------------------------------------------------------
--
-- Every money table in this schema carries `%I_no_update_delete` and
-- `%I_no_truncate`.  These four deliberately do not, and the distinction
-- is the point rather than an oversight:
--
--   chaos_control   is a SWITCH.  Turning it off must be a DELETE, because
--                   a switch whose off state is another row is a switch
--                   with two truths.
--   chaos_delivery  is an OUTBOX.  A withheld delivery is released later,
--                   which is an UPDATE of its own `released_at`.
--   chaos_run       closes when the episode ends.
--   chaos_event     IS append-only in practice and is the audit trail of
--                   every arm, disarm, expiry and run -- but it holds no
--                   money either, so the guard would be theatre.
--
-- None of the four has a `cents` column, a foreign key into `account`,
-- `journal_entry`, `journal_line`, `hold` or `card_auth_event`, or any
-- way to be read by the balance derivation.  `chaos_delivery.raw_body`
-- holds bytes that have not been ingested yet; once ingested the fact
-- lives in `webhook_inbox` like every other delivery and this table holds
-- only a pointer to it.  Dropping all four at any moment would lose the
-- demo's script and not one cent of the book.
--
-- ---------------------------------------------------------------------
-- HOW A CHAOS-ORIGINATED DELIVERY IS TOLD APART FROM A REAL ONE, FOREVER
-- ---------------------------------------------------------------------
--
-- Three layers, copied from the ACH simulator's anti-forgery doctrine in
-- `src/lib/rails/achsim/signing.ts`, because that doctrine is correct:
--
--   1. THE KEY IS DIFFERENT.  Chaos signs with `CHAOS_WEBHOOK_SECRET`
--      (or a loudly-named development default) and refuses at construction
--      to be handed `LITHIC_WEBHOOK_SECRET`.  A chaos delivery therefore
--      CANNOT be accepted by the deployed `/api/webhooks/lithic` route,
--      which verifies against Lithic's own subscription secret.  Chaos
--      hands its deliveries to `ingestWebhook` in-process with its own
--      verifier registry.
--   2. THE MARKER IS INSIDE THE SIGNED BYTES.  Every body carries a
--      top-level `"corgi_chaos"` object naming the run and the control
--      that shaped the delivery.  Strip it to make the row look like a
--      Lithic delivery and the HMAC no longer verifies.
--   3. THE ID LIVES IN ITS OWN KEY SPACE.  Every chaos `webhook-id` is
--      `chaos_<run>_<seq>_<copy>`, so `webhook_inbox.provider_event_id`
--      -- half of the table's own primary dedupe key -- says so:
--
--          SELECT * FROM webhook_inbox
--           WHERE provider_event_id LIKE 'chaos\_%';
--
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1.  chaos_control — the switches
-- ---------------------------------------------------------------------
--
-- One row per ARMED control.  Absence is off.  There is deliberately no
-- `enabled boolean`: a nullable/false-able flag is a state that can be
-- written once and never revisited, and this table's entire job is to
-- make "still on tomorrow" unrepresentable.

CREATE TABLE IF NOT EXISTS chaos_control (
  -- The control's name IS the primary key: one arming per control, and a
  -- re-arm is an upsert that resets the clock rather than a second row
  -- with a different expiry that somebody has to reconcile.
  control      text        PRIMARY KEY,
  armed_at     timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  -- The actor who armed it. Not an FK: `actor` rows are money-adjacent and
  -- a demo switch must never be able to block their lifecycle.
  armed_by     text        NOT NULL,
  armed_by_id  uuid,
  -- Control-specific parameters: {"provider":"lithic"},
  -- {"seconds":45}, {"copies":3}, {"seconds":20}.
  params       jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT chaos_control_known
    CHECK (control IN ('webhooks_off',
                       'settlement_delay',
                       'duplicate_delivery',
                       'reorder_window')),

  -- THE CONSTRAINT THIS MIGRATION EXISTS FOR.  Read the header.
  CONSTRAINT chaos_control_bounded
    CHECK (expires_at > armed_at
           AND expires_at <= armed_at + interval '10 minutes'),

  CONSTRAINT chaos_control_params_object
    CHECK (jsonb_typeof(params) = 'object')
);

COMMENT ON TABLE chaos_control IS
  'Armed chaos controls. Absence is off. A row cannot outlive its arming by '
  'more than ten minutes -- chaos_control_bounded, enforced by Postgres, not '
  'by the application.';

-- ---------------------------------------------------------------------
-- 2.  chaos_run — one episode
-- ---------------------------------------------------------------------
--
-- An episode is the scripted card lifecycle chaos puts through the pipe:
-- a $50.00 fuel-pump authorisation and a $73.40 clearing two beats later,
-- which is the brief's own live-fire pair.  The run records WHICH
-- controls were armed when it started, so the dashboard can say what the
-- ledger survived rather than what is armed now.

CREATE TABLE IF NOT EXISTS chaos_run (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz,
  started_by          text        NOT NULL,
  -- The card the episode targets, and the business it belongs to. The card
  -- token is NOT an FK to `card`: the interesting demo is precisely the one
  -- where the card is NOT registered yet, the events park, and the system
  -- refuses to guess whose money to move.
  card_token          text        NOT NULL,
  business_id         uuid,
  card_registered     boolean     NOT NULL DEFAULT false,
  -- The Lithic-shaped transaction token the episode's deliveries share.
  transaction_token   text        NOT NULL,
  auth_cents          bigint      NOT NULL,
  clearing_cents      bigint      NOT NULL,
  -- Snapshot of `v_chaos_active` at the instant the run started.
  controls            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  note                text,

  CONSTRAINT chaos_run_amounts_positive
    CHECK (auth_cents > 0 AND clearing_cents > 0),
  CONSTRAINT chaos_run_controls_array
    CHECK (jsonb_typeof(controls) = 'array')
);

CREATE INDEX IF NOT EXISTS chaos_run_started_at_idx
  ON chaos_run (started_at DESC);

COMMENT ON TABLE chaos_run IS
  'One chaos episode: the scripted card lifecycle chaos put through the real '
  'delivery pipeline, and the controls that were armed while it did.';

-- ---------------------------------------------------------------------
-- 3.  chaos_delivery — the outbox
-- ---------------------------------------------------------------------
--
-- The four controls are four different answers to "when, how many times
-- and in what order does this row leave the outbox":
--
--   webhooks_off       nothing leaves at all; rows sit at 'withheld'
--   settlement_delay   the clearing's planned_at moves into the future
--   duplicate_delivery copy_index 1..N, SAME webhook_id, SAME bytes
--   reorder_window     `seq` is assigned in the reversed order
--
-- Nothing here decides what a delivery MEANS. That is the consumer's, and
-- the consumer has never heard of this table.

CREATE TABLE IF NOT EXISTS chaos_delivery (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid        NOT NULL REFERENCES chaos_run(id) ON DELETE CASCADE,
  -- Release order within the run, after the reorder control has had its say.
  seq                integer     NOT NULL,
  -- 'authorization' | 'clearing'. The lifecycle step the body asserts.
  step               text        NOT NULL,
  -- 0 is the original; 1..N are the duplicate control's copies. They carry
  -- the same webhook_id on purpose: that is what makes the existing
  -- UNIQUE (provider, provider_event_id) the thing that suppresses them.
  copy_index         integer     NOT NULL DEFAULT 0,
  provider           text        NOT NULL DEFAULT 'lithic',
  -- chaos_<run>_<seq>_<copy>. Also the inbox's provider_event_id.
  webhook_id         text        NOT NULL,
  -- The exact bytes that were signed, held so a withheld delivery can be
  -- released later verbatim rather than re-serialised.
  raw_body           text        NOT NULL,
  headers            jsonb       NOT NULL,
  planned_at         timestamptz NOT NULL,
  released_at        timestamptz,
  -- 'withheld' until it leaves; then the verdict ingestWebhook returned.
  outcome            text        NOT NULL DEFAULT 'withheld',
  -- The webhook_inbox row it became, when it became one.
  inbox_id           uuid,
  detail             text,

  CONSTRAINT chaos_delivery_step_known
    CHECK (step IN ('authorization', 'clearing')),
  CONSTRAINT chaos_delivery_outcome_known
    CHECK (outcome IN ('withheld', 'accepted', 'replay', 'dead_on_arrival', 'rejected', 'failed')),
  CONSTRAINT chaos_delivery_copy_index_sane
    CHECK (copy_index >= 0 AND copy_index < 10),
  CONSTRAINT chaos_delivery_released_iff_left
    CHECK ((outcome = 'withheld') = (released_at IS NULL)),
  CONSTRAINT chaos_delivery_headers_object
    CHECK (jsonb_typeof(headers) = 'object'),
  -- One row per (run, seq, copy). The duplicate control repeats the
  -- webhook_id, never the outbox row.
  CONSTRAINT chaos_delivery_unique_slot
    UNIQUE (run_id, seq, copy_index)
);

CREATE INDEX IF NOT EXISTS chaos_delivery_run_idx
  ON chaos_delivery (run_id, seq, copy_index);

CREATE INDEX IF NOT EXISTS chaos_delivery_due_idx
  ON chaos_delivery (planned_at)
  WHERE outcome = 'withheld';

COMMENT ON TABLE chaos_delivery IS
  'The chaos outbox. A row leaves it when the armed controls allow, and what '
  'happens after it leaves is the ordinary webhook pipeline''s business.';

-- ---------------------------------------------------------------------
-- 4.  chaos_event — the audit trail
-- ---------------------------------------------------------------------
--
-- Every arm, disarm, expiry, run and release, in order.  This is what the
-- dashboard's timeline reads, and it is also the answer to the only
-- question that matters after a demo: WAS IT ON, AND WHO TURNED IT ON.

CREATE TABLE IF NOT EXISTS chaos_event (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text        NOT NULL,
  control     text,
  run_id      uuid        REFERENCES chaos_run(id) ON DELETE SET NULL,
  actor       text        NOT NULL,
  detail      text        NOT NULL,
  params      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT chaos_event_kind_known
    CHECK (kind IN ('armed', 'disarmed', 'disarmed_all', 'expired',
                    'run_started', 'run_finished', 'released',
                    'card_registered')),
  CONSTRAINT chaos_event_params_object
    CHECK (jsonb_typeof(params) = 'object')
);

CREATE INDEX IF NOT EXISTS chaos_event_at_idx ON chaos_event (at DESC);

COMMENT ON TABLE chaos_event IS
  'Append-only audit trail of chaos mode: every arm, disarm, expiry and run.';

-- ---------------------------------------------------------------------
-- 5.  v_chaos_active — the ONLY thing any reader reads
-- ---------------------------------------------------------------------
--
-- `now()` is in the view, not in the callers.  A control that has run out
-- is not "ignored by the code that remembered to check" -- it is not there.
-- Every reader gets the same answer because there is only one place the
-- question is asked.

CREATE OR REPLACE VIEW v_chaos_active AS
SELECT c.control,
       c.armed_at,
       c.expires_at,
       c.armed_by,
       c.armed_by_id,
       c.params,
       GREATEST(0, EXTRACT(EPOCH FROM (c.expires_at - now()))::int) AS seconds_remaining
  FROM chaos_control c
 WHERE c.expires_at > now();

COMMENT ON VIEW v_chaos_active IS
  'Chaos controls that are armed AND have not run out. The expiry lives here '
  'so no caller can forget it.';

-- ---------------------------------------------------------------------
-- 6.  v_chaos_expired — switches that ran out and have not been swept
-- ---------------------------------------------------------------------
--
-- Not the same question as `v_chaos_active`, and worth its own view: this
-- is "the demo ended and nobody pressed off", which the dashboard reports
-- as history rather than as chaos.

CREATE OR REPLACE VIEW v_chaos_expired AS
SELECT c.control,
       c.armed_at,
       c.expires_at,
       c.armed_by,
       EXTRACT(EPOCH FROM (now() - c.expires_at))::int AS seconds_since_expiry
  FROM chaos_control c
 WHERE c.expires_at <= now();

-- ---------------------------------------------------------------------
-- 7.  v_chaos_outbox — the dashboard's delivery rollup
-- ---------------------------------------------------------------------

CREATE OR REPLACE VIEW v_chaos_outbox AS
SELECT d.run_id,
       count(*)::int                                                     AS deliveries,
       count(*) FILTER (WHERE d.outcome = 'withheld')::int               AS withheld,
       count(*) FILTER (WHERE d.outcome = 'accepted')::int               AS accepted,
       count(*) FILTER (WHERE d.outcome = 'replay')::int                 AS suppressed_replays,
       count(*) FILTER (WHERE d.outcome IN ('rejected', 'failed',
                                            'dead_on_arrival'))::int     AS refused,
       count(*) FILTER (WHERE d.copy_index > 0)::int                     AS duplicate_copies,
       min(d.planned_at)                                                 AS first_planned_at,
       max(d.released_at)                                                AS last_released_at
  FROM chaos_delivery d
 GROUP BY d.run_id;

COMMENT ON VIEW v_chaos_outbox IS
  '`suppressed_replays` is the demonstration: duplicates absorbed by '
  'webhook_inbox UNIQUE (provider, provider_event_id), not by a chaos branch.';

-- ---------------------------------------------------------------------
-- 8.  v_chaos_inbox — what the chaos deliveries became
-- ---------------------------------------------------------------------
--
-- Joined by the key space, not by a column we added to webhook_inbox.
-- Chaos does not get to alter the money pipeline's schema to watch itself.

CREATE OR REPLACE VIEW v_chaos_inbox AS
SELECT w.id,
       w.provider,
       w.provider_event_id,
       w.event_type,
       w.state::text                                 AS state,
       w.received_at,
       w.processed_at,
       w.attempts,
       w.park_attempts,
       w.parked_on_kind,
       w.parked_on_ref,
       w.parked_reason,
       w.dead_lettered_at,
       w.payload -> 'corgi_chaos' ->> 'run_id'       AS run_id,
       w.payload -> 'corgi_chaos' ->> 'control'      AS shaped_by
  FROM webhook_inbox w
 WHERE w.provider_event_id LIKE 'chaos\_%';

COMMENT ON VIEW v_chaos_inbox IS
  'The webhook_inbox rows chaos originated. Identified by the id key space and '
  'the in-band marker, both of which are inside the signed bytes.';

-- ---------------------------------------------------------------------
-- 9.  Grants
-- ---------------------------------------------------------------------
--
-- The app role gets full CRUD on the four chaos tables and read on the
-- views.  That is a deliberately wider grant than it holds on any money
-- table -- `corgi_app` cannot UPDATE or DELETE a `journal_entry` and never
-- will -- and it is safe for exactly the reason section 2 of this header
-- gives: nothing here is money.

GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_control  TO corgi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_run      TO corgi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON chaos_delivery TO corgi_app;
-- `chaos_event.id` is GENERATED ALWAYS AS IDENTITY, whose sequence is owned by
-- the column: INSERT on the table carries the right to advance it, and an
-- explicit sequence grant would be both redundant and a name this migration
-- would have to guess.
GRANT SELECT, INSERT                 ON chaos_event    TO corgi_app;

GRANT SELECT ON v_chaos_active  TO corgi_app;
GRANT SELECT ON v_chaos_expired TO corgi_app;
GRANT SELECT ON v_chaos_outbox  TO corgi_app;
GRANT SELECT ON v_chaos_inbox   TO corgi_app;

COMMIT;
