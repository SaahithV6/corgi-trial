-- =====================================================================
-- 0056  PLAID ITEM STATE  -  somewhere for the provider's own answer
--                            about a funding source to live
-- =====================================================================
--
-- Named, priced and left unbuilt in four places before this file:
--
--   src/lib/rails/plaid/adapter.ts (header)
--       "There is nowhere to persist a Plaid `access_token` in this
--        schema -- no `plaid_item` table, and adding one needs a
--        migration this worker does not own."
--   src/lib/webhooks/consumers/plaid-item.ts (header)
--       "THERE IS NO `plaid_item` TABLE. ... There is no row to mark
--        unhealthy, no customer to route a 'reconnect your bank' prompt
--        to, and nothing a reconciliation would notice."
--   docs/FUNDING.md 552-562  "Closing the gap properly needs a
--        `plaid_item` table."
--   docs/ACCOUNT-OPENING.md 288-291  "Week two: a `plaid_item` table so
--        a linked funding source survives the request that created it."
--
-- This is that table. Nothing here was invented: every column exists
-- because a real Plaid response carried the value, and every state in
-- `v_plaid_item_state` was OBSERVED against the sandbox on 2026-09-11
-- rather than reasoned about.
--
-- ---------------------------------------------------------------------
-- 1.  THE MEASUREMENT THAT FORCED THIS FILE
-- ---------------------------------------------------------------------
--
-- Measured against the production database at 2026-09-11T16:47Z:
--
--   Plaid has delivered exactly THREE webhooks, ever. All three are
--   `ITEM`/`ERROR` carrying `ITEM_LOGIN_REQUIRED`. All three are
--   `state = 'done'` with no `processing_error`: they were consumed
--   cleanly, by a consumer that read them, described them, and threw
--   the description away, because there was nowhere to put it.
--
--   Meanwhile `/api/health` reported the `open_banking` slot `live`, on
--   the evidence `POST /institutions/get -> 200`.
--
-- BOTH READINGS ARE TRUE AND TOGETHER THEY ARE MISLEADING.
-- `/institutions/get` is a CATALOGUE endpoint. It answers "are these
-- credentials valid", it is answerable with no Item in existence, and
-- it would answer 200 on an account that has never linked anything.
-- The slot is called `open_banking` and the webhook's own purpose
-- string is "open banking -- account funding and item health", so the
-- capability the reader takes from `live` is "we can fund from a linked
-- bank". The probe cannot see that capability at all.
--
-- That is this repository's recurring shape, one more time: A GUARD
-- WHOSE EVIDENCE IS CHOSEN BY SOMETHING OTHER THAN THE CAPABILITY IT
-- CLAIMS TO COVER WILL REPORT HEALTHY.
--
-- ---------------------------------------------------------------------
-- 2.  WHAT THE THREE WEBHOOKS ACTUALLY WERE  -  measured, not assumed
-- ---------------------------------------------------------------------
--
-- The three deliveries carry THREE DIFFERENT `item_id`s:
--
--   8MppL6n1rKTdJXD5Dkd8sRjPd5dm4vixgGNRZ   21:58:19Z
--   xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7   22:15:14Z
--   7k9de5pw8RuB7KEwvDWKfvNrwgwr3xiNwBodw   22:47:23Z
--
-- So this is NOT one funding source that broke and went quiet. It is
-- three separate throwaway Items, each deliberately broken by
-- `probeItemLoginRequired()` calling Plaid's own
-- `/sandbox/item/reset_login`, each firing one real `ITEM`/`ERROR`
-- webhook, each then abandoned. A TESTED ERROR PATH, which is a credit
-- and not a defect -- but one the health surface had no way to say.
--
-- All three were re-checked against Plaid on 2026-09-11T16:50Z:
--
--   POST /item/get -> 400 INVALID_ACCESS_TOKEN   (x3)
--
-- We hold no credential for any of them. They cannot be read, cannot be
-- repaired -- Link update mode needs a `link_token` minted FROM the
-- access token, which we never stored -- and cannot be removed. They
-- are ORPHANS: ids Plaid told us about that refer to nothing we can
-- act on. That is a fourth state, and it is the state this deployment
-- was actually in while reporting `live`.
--
-- ---------------------------------------------------------------------
-- 3.  FOUR TABLES, AND WHY THE SECRET IS NOT A COLUMN ON THE FIRST
-- ---------------------------------------------------------------------
--
-- `plaid_item_secret` is a separate table from `plaid_item` for exactly
-- the reason 0034 SS2 separated `outbound_endpoint_secret` from
-- `outbound_endpoint`, and the argument is copied deliberately rather
-- than re-derived: so that `SELECT * FROM plaid_item` -- the query
-- every screen, every debug session and every `console.log(row)`
-- reaches for -- CANNOT return an access token.
--
-- The token is stored in PLAINTEXT, and that is stated rather than
-- dressed up. A Plaid access token is a bearer credential: it has to be
-- presented verbatim to `sandbox.plaid.com` on every call, so "hashed
-- at rest" is not available the way it is for a password. Encrypting it
-- with a key read from the same environment the application reads would
-- move the secret one dereference away and no further. What IS bought
-- is blast radius, and it is the same four things 0034 bought:
--
--     a separate table                  a splat cannot leak it
--     no UPDATE grant on the token      it cannot be altered in place
--     a retirement path (`retired_at`)  re-linking supersedes, not edits
--     an immutability trigger           enforced in the database, not
--                                       in the caller that forgets
--
-- On the TypeScript side the token is wrapped by
-- `src/lib/rails/plaid/secret.ts`, whose `toString()`/`toJSON()` return
-- "[redacted]" and whose only escape hatch is a greppable
-- `revealAccessToken()` -- the same shape as `src/lib/events/secret.ts`.
--
-- `plaid_item_account` deliberately stores the MASK and the ROUTING
-- number and NOT the account number. The routing number is public bank
-- data; the account number is the thing an ACH debit is pulled with,
-- `/auth/get` returns it on demand, and a column that holds it is a
-- column that ends up in a log line. `docs/FUNDING.md` already draws
-- this line for the in-memory type (`PlaidLinkedAccount` carries the
-- last four, `PlaidAchNumbers` carries the number and never leaves the
-- server action); the schema draws it in the same place.
--
-- ---------------------------------------------------------------------
-- 4.  THE EVENT LOG IS APPEND-ONLY AND ITS `item_id` IS NOT A FOREIGN KEY
-- ---------------------------------------------------------------------
--
-- The house style for "current state" in this schema is an append-only
-- log plus a derived view -- `team_member_version`/`v_team_member_current`,
-- `card_control_version`/`v_card_control_current`, `hold` + `hold_closure`
-- + `v_hold_state`. An UPDATE would destroy the sequence
--
--     healthy -> ITEM_LOGIN_REQUIRED -> repaired
--
-- which is the sequence an operator needs in order to answer "how long
-- was this funding source broken", and it would make the three webhooks
-- above unrecordable after the fact. So `plaid_item_event` is INSERT
-- only, and `v_plaid_item_state` folds it.
--
-- `plaid_item_event.item_id` IS NOT A FOREIGN KEY TO `plaid_item`, and
-- that is the load-bearing decision in this file rather than an
-- omission. Plaid can tell us about an Item we hold no credential for
-- -- it did, three times, on 2026-09-10 -- and a foreign key would make
-- the only honest record of that fact unwritable. A webhook is
-- SOMETHING A PROVIDER SAID. The log records what was said; the join to
-- `plaid_item` records whether we can act on it; and the DIFFERENCE
-- between those two is the `orphaned` state, which is a real condition
-- this deployment is in and had no way to report.
--
-- `UNIQUE (inbox_id)` is what makes the consumer idempotent. The
-- webhook dispatcher's contract (src/lib/webhooks/dispatch.ts) is
-- explicit that a delivery may be handed to a consumer more than once
-- and that "the effect [must be] a function of a set (a unique key on
-- the write), not an increment". That unique index is the set.
--
-- ---------------------------------------------------------------------
-- 5.  THE STATE VOCABULARY IS DISJOINT FROM THE OTHER THREE
-- ---------------------------------------------------------------------
--
-- `/api/health` already publishes three verdicts per provider and keeps
-- their vocabularies deliberately disjoint so that no reader has to
-- reconcile them:
--
--   liveness    live / simulated / unauthorised / unreachable /
--               rate_limited / not_configured       (probe.ts)
--   delivery    fresh / stale / quiet / never / unknown
--                                                   (delivery-health.ts)
--   processing  consuming / backlogged / dropping / refused /
--               superseded / never_consumed / unmeasured
--                                                   (processing.ts)
--
-- This is the fourth question -- CAN WE ACTUALLY DO THE THING -- and it
-- gets a fourth vocabulary that shares no word with any of them:
--
--   healthy       Plaid's own last word on this Item was "no error".
--   needs_reauth  Plaid says a HUMAN must re-authenticate in Link
--                 update mode. NOT an outage: nothing is broken on our
--                 side, nothing is being lost, and the correct
--                 behaviour is to say so and wait. See SS6.
--   revoked       The customer withdrew consent. Terminal; re-linking
--                 is a new Item, not a repair of this one.
--   orphaned      Plaid named an Item we hold no live credential for.
--                 Unreadable and unrepairable by us. The three
--                 2026-09-10 webhooks are exactly this.
--   absent        No Item at all. Silence from Plaid is then CORRECT
--                 and must not read as an anomaly.
--
-- `absent` is not a row -- it is the empty view, and the health surface
-- names it so that "we have no funding source linked" and "our funding
-- source is broken" stop being the same reading.
--
-- ---------------------------------------------------------------------
-- 6.  WHY NONE OF THIS DEGRADES THE DEPLOYMENT
-- ---------------------------------------------------------------------
--
-- `src/app/api/health/route.ts` records the house rule: "A status that
-- cannot go back to `ok` is a status people stop reading", and the same
-- endpoint already learned once not to report degraded overnight just
-- because nobody swiped a card.
--
-- `needs_reauth` is a state whose exit condition is A PERSON DOING
-- SOMETHING. If it degraded the deployment, the deployment would be
-- degraded from the moment a customer's bank rotated its MFA until the
-- customer next logged in -- days, legitimately, with nothing wrong and
-- nothing to fix. That is precisely the alarm nobody reads.
--
-- So this file's contribution to `/api/health` is a TRUER READING, not
-- a louder one. The question was never "is it loud enough", it was "is
-- it true": today the endpoint cannot distinguish a healthy funding
-- source from a broken one from none at all, and after this it can.

-- ---------------------------------------------------------------------
-- 7.  The Item
-- ---------------------------------------------------------------------

CREATE TABLE plaid_item (
  -- Plaid's own id. The natural key: it is stable for the life of the
  -- Item, it is what every webhook carries, and it is what
  -- `journal_entry.external_ref` already embeds as
  -- `plaid:<item_id>:<account_id>:<reference>`. A surrogate uuid here
  -- would add a second name for one thing and a join to resolve it.
  item_id           text PRIMARY KEY,

  institution_id    text NOT NULL,
  institution_name  text,

  -- 'sandbox' or 'production'. An Item is scoped to the environment it
  -- was created in and an access token from one is meaningless in the
  -- other, so the row says which -- rather than leaving a reader to
  -- infer it from a key they cannot see.
  environment       text NOT NULL
                      CHECK (environment IN ('sandbox', 'production')),

  -- WHOSE funding source this is. Nullable because an Item minted by a
  -- diagnostic probe belongs to no customer, and recording it as
  -- belonging to one would be a lie in the direction that matters.
  business_id       uuid REFERENCES business(id),

  -- Where this Item's webhooks were told to go. Kept because an Item
  -- registered against a superseded deployment host delivers to an
  -- endpoint nobody is reading, and that is invisible otherwise.
  webhook_url       text,

  linked_at         timestamptz NOT NULL DEFAULT now(),

  -- The purpose the Item was created for. `funding` Items are customer
  -- funding sources; `diagnostic` Items are deliberately broken by
  -- `probeItemLoginRequired()` and must never be offered as one.
  purpose           text NOT NULL DEFAULT 'funding'
                      CHECK (purpose IN ('funding', 'diagnostic'))
);

COMMENT ON TABLE plaid_item IS
  'One linked Plaid Item. Holds NO access token: see plaid_item_secret and 0056 §3.';

CREATE INDEX plaid_item_business_idx ON plaid_item (business_id)
  WHERE business_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- 8.  The secret, in its own table.  0034 §2, applied again.
-- ---------------------------------------------------------------------

CREATE TABLE plaid_item_secret (
  item_id       text NOT NULL REFERENCES plaid_item(item_id),
  version       integer NOT NULL,

  -- Plaid's `access-<env>-<uuid>`. Plaintext, argued in §3.
  access_token  text NOT NULL,

  created_at    timestamptz NOT NULL DEFAULT now(),
  -- NULL means live. Set once, never unset: re-linking an Item mints a
  -- new token and retires this one rather than overwriting it.
  retired_at    timestamptz,

  PRIMARY KEY (item_id, version),

  -- A shape check, not a security control. It exists so that a
  -- placeholder, an empty string or an `item_id` pasted into the wrong
  -- column is refused by the database rather than discovered as a 400
  -- from Plaid three days later. Measured: real sandbox tokens are
  -- `access-sandbox-` + a uuid, 51 characters.
  CONSTRAINT plaid_access_token_shape
    CHECK (access_token LIKE 'access-%' AND length(access_token) >= 20)
);

COMMENT ON TABLE plaid_item_secret IS
  'Plaid access tokens. Bearer credentials, plaintext by necessity (0056 §3). Never SELECT * this table into a log.';

-- The signer's hot path reads the live token for one Item. Partial so it
-- never scans retired versions.
CREATE INDEX plaid_item_secret_live_idx
  ON plaid_item_secret (item_id) WHERE retired_at IS NULL;

CREATE OR REPLACE FUNCTION plaid_item_secret_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a Plaid access token is retired, never deleted: the Item it opened has money rows citing it'
      USING ERRCODE = '55006';
  END IF;
  IF NEW.access_token IS DISTINCT FROM OLD.access_token
     OR NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a Plaid access token is immutable; re-linking inserts a new version'
      USING ERRCODE = '55006';
  END IF;
  IF OLD.retired_at IS NOT NULL AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
    RAISE EXCEPTION 'retired_at only moves once, NULL -> timestamp' USING ERRCODE = '55006';
  END IF;
  RETURN NEW;
END $$;

ALTER FUNCTION plaid_item_secret_guard() SET search_path = public, pg_temp;

CREATE TRIGGER plaid_item_secret_immutable
  BEFORE UPDATE OR DELETE ON plaid_item_secret
  FOR EACH ROW EXECUTE FUNCTION plaid_item_secret_guard();

-- ---------------------------------------------------------------------
-- 9.  The accounts on the Item
-- ---------------------------------------------------------------------

CREATE TABLE plaid_item_account (
  item_id          text NOT NULL REFERENCES plaid_item(item_id),
  -- Plaid's `account_id`. Already embedded in every funding
  -- `external_ref`, so this table is joinable to the money.
  account_id       text NOT NULL,

  name             text NOT NULL,
  official_name    text,
  -- The LAST FOUR, which is what Plaid calls `mask`. Not the account
  -- number: see §3.
  mask             text,
  subtype          text,

  -- Public bank routing data. Safe to store and to print.
  routing_number   text,
  -- 'INSTANT_AUTH', 'INSTANT_MATCH', 'AUTOMATED_MICRODEPOSITS', ...
  -- WHICH KIND OF VERIFICATION STANDS BEHIND THESE NUMBERS. A funding
  -- source verified by instant auth and one verified by micro-deposits
  -- carry different risk and this column is the only place the
  -- difference survives the request.
  auth_method      text,

  -- False for an account Plaid returned but could produce no ACH
  -- numbers for. Recorded rather than filtered out, so that "we saw no
  -- fundable account" and "we never looked" stay different facts.
  fundable         boolean NOT NULL DEFAULT true,

  observed_at      timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (item_id, account_id)
);

COMMENT ON TABLE plaid_item_account IS
  'Depository accounts on an Item. Mask and routing only -- never the account number (0056 §3).';

-- ---------------------------------------------------------------------
-- 10.  The append-only observation log
-- ---------------------------------------------------------------------

CREATE TABLE plaid_item_event (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- NOT a foreign key. See §4 -- this is the decision that lets an
  -- orphan webhook be recorded at all.
  item_id        text NOT NULL,

  -- A total order, so two observations in the same millisecond still
  -- fold deterministically in v_plaid_item_state.
  seq            bigserial NOT NULL,

  observed_at    timestamptz NOT NULL DEFAULT now(),

  -- HOW WE LEARNED IT, which is not decoration: `webhook` is Plaid
  -- telling us unprompted, `item_get` is us asking, `link` is the
  -- moment of creation. An operator reading a broken Item needs to know
  -- whether the last word came from a push we might have missed or a
  -- pull we actually made.
  source         text NOT NULL
                   CHECK (source IN ('link', 'webhook', 'item_get')),

  -- Plaid's `webhook_code` verbatim (ERROR, LOGIN_REPAIRED,
  -- PENDING_EXPIRATION, USER_PERMISSION_REVOKED, ...). NULL for a
  -- `link` or `item_get` observation, which carry no code.
  webhook_code   text,

  -- Plaid's own error fields, verbatim. NULL error_code IS THE HEALTHY
  -- OBSERVATION -- `/item/get` returns `item.error: null` on a working
  -- Item, measured 2026-09-11, and this column mirrors that exactly
  -- rather than inventing a sentinel string for "fine".
  error_code     text,
  error_type     text,
  error_message  text,

  -- PROVENANCE. Which delivery this observation was read out of, the
  -- same way `journal_entry.inbox_id` cites the delivery a posting came
  -- from. NULL for observations we made ourselves.
  inbox_id       uuid REFERENCES webhook_inbox(id),

  -- The consumer's idempotency, enforced by the database rather than by
  -- a SELECT-then-INSERT. Postgres permits many NULLs here, so
  -- self-made observations are unconstrained while a redelivered
  -- webhook cannot write a second row. See §4.
  CONSTRAINT plaid_item_event_one_per_delivery UNIQUE (inbox_id)
);

COMMENT ON TABLE plaid_item_event IS
  'Append-only log of what Plaid said about an Item. item_id is deliberately NOT a foreign key (0056 §4).';

CREATE INDEX plaid_item_event_item_idx
  ON plaid_item_event (item_id, observed_at DESC, seq DESC);

CREATE OR REPLACE FUNCTION plaid_item_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'plaid_item_event is append-only: an Item''s history is the evidence for how long it was broken'
    USING ERRCODE = '55006';
END $$;

ALTER FUNCTION plaid_item_event_guard() SET search_path = public, pg_temp;

CREATE TRIGGER plaid_item_event_append_only
  BEFORE UPDATE OR DELETE ON plaid_item_event
  FOR EACH ROW EXECUTE FUNCTION plaid_item_event_guard();

-- ---------------------------------------------------------------------
-- 11.  The derived current state
-- ---------------------------------------------------------------------
--
-- One row per item_id THE LOG HAS EVER MENTIONED -- including ids we
-- hold no `plaid_item` row for, which is the whole point of §4.

CREATE VIEW v_plaid_item_state AS
WITH latest AS (
  SELECT DISTINCT ON (e.item_id)
         e.item_id,
         e.observed_at,
         e.source,
         e.webhook_code,
         e.error_code,
         e.error_type,
         e.error_message,
         e.inbox_id
    FROM plaid_item_event e
   ORDER BY e.item_id, e.observed_at DESC, e.seq DESC
),
counts AS (
  SELECT item_id,
         count(*)::bigint                                          AS observations,
         count(*) FILTER (WHERE error_code IS NOT NULL)::bigint     AS error_observations,
         min(observed_at)                                           AS first_observed_at
    FROM plaid_item_event
   GROUP BY item_id
)
SELECT l.item_id,
       i.institution_id,
       i.institution_name,
       i.environment,
       i.business_id,
       i.purpose,
       i.linked_at,
       l.observed_at                       AS last_observed_at,
       l.source                            AS last_source,
       l.webhook_code                      AS last_webhook_code,
       l.error_code                        AS last_error_code,
       l.error_type                        AS last_error_type,
       l.error_message                     AS last_error_message,
       l.inbox_id                          AS last_inbox_id,
       c.observations,
       c.error_observations,
       c.first_observed_at,
       -- Do we hold a live credential for this Item?
       s.has_live_token,
       -- How many accounts we know about. Zero on an Item we never read
       -- accounts from -- which is true of every diagnostic Item.
       coalesce(a.account_count, 0)        AS account_count,

       -- THE FOLD. Ordered most-specific first; every branch is
       -- reachable and every one was observed against the sandbox.
       CASE
         -- No credential -> we cannot read it, repair it or remove it,
         -- whatever Plaid last said about it. Checked FIRST because it
         -- dominates: an orphan whose last word was "healthy" is still
         -- an orphan, and offering it as a funding source would fail.
         WHEN NOT s.has_live_token THEN 'orphaned'
         WHEN l.error_code IN ('USER_PERMISSION_REVOKED', 'USER_ACCOUNT_REVOKED')
           OR l.webhook_code IN ('USER_PERMISSION_REVOKED', 'USER_ACCOUNT_REVOKED')
                                 THEN 'revoked'
         WHEN l.error_code IS NOT NULL THEN 'needs_reauth'
         ELSE 'healthy'
       END AS state
  FROM latest l
  LEFT JOIN counts c        ON c.item_id = l.item_id
  LEFT JOIN plaid_item i    ON i.item_id = l.item_id
  CROSS JOIN LATERAL (
         SELECT EXISTS (
                  SELECT 1
                    FROM plaid_item_secret ps
                   WHERE ps.item_id = l.item_id AND ps.retired_at IS NULL
                ) AS has_live_token
       ) s
  CROSS JOIN LATERAL (
         SELECT count(*)::bigint AS account_count
           FROM plaid_item_account pa
          WHERE pa.item_id = l.item_id
       ) a;

COMMENT ON VIEW v_plaid_item_state IS
  'Current state per Plaid Item, folded from the append-only log. States: healthy / needs_reauth / revoked / orphaned. "absent" is the empty view (0056 §5).';

-- ---------------------------------------------------------------------
-- 12.  Grants
-- ---------------------------------------------------------------------
--
-- Append-and-retire, never rewrite. `corgi_app` may INSERT an Item, its
-- token, its accounts and its observations; it may retire a token and
-- flag an account unfundable; it may not UPDATE an Item's identity, it
-- may not touch the observation log after the fact, and it may not
-- DELETE anything. The triggers above enforce the same thing a second
-- time, in the database, for the paths a grant cannot reach.

GRANT SELECT, INSERT ON
  plaid_item, plaid_item_secret, plaid_item_account, plaid_item_event
TO corgi_app;

REVOKE UPDATE, DELETE, TRUNCATE ON
  plaid_item, plaid_item_secret, plaid_item_account, plaid_item_event
FROM corgi_app, PUBLIC;

-- Rotation and supersession only. NOT the token, NOT the item_id.
GRANT UPDATE (retired_at) ON plaid_item_secret TO corgi_app;
-- An account that stops producing ACH numbers stops being offerable.
GRANT UPDATE (fundable, observed_at) ON plaid_item_account TO corgi_app;

-- `bigserial` makes a sequence, and INSERT on the table is not enough
-- to advance it.
GRANT USAGE ON SEQUENCE plaid_item_event_seq_seq TO corgi_app;

GRANT SELECT ON v_plaid_item_state TO corgi_app;

-- ---------------------------------------------------------------------
-- 13.  This migration refuses to commit on a claim it has not checked
-- ---------------------------------------------------------------------
--
-- The house convention 0045 §5 and 0052 §6 both use: the migration
-- proves its own postconditions in the same transaction that created
-- them, because "the file says GRANT and the database says no" is a
-- failure this repository has had for real.
--
-- Four claims, each of which this file would be worthless without:
--   1. `corgi_app` can actually read the new view.
--   2. The append-only trigger really refuses an UPDATE.
--   3. The token shape check really refuses a non-token.
--   4. `v_plaid_item_state` really returns `orphaned` for an Item whose
--      webhook we recorded and whose credential we do not hold -- the
--      exact condition the three 2026-09-10 deliveries are in. A fold
--      nobody has seen produce a state is a claim.

DO $$
DECLARE
  v_state text;
  v_raised boolean;
BEGIN
  -- 1. the grant took effect
  IF NOT has_table_privilege('corgi_app', 'v_plaid_item_state', 'SELECT') THEN
    RAISE EXCEPTION
      '0056 refuses to commit: corgi_app cannot SELECT v_plaid_item_state. The grant did not take effect; do not record this migration as applied.';
  END IF;
  IF has_table_privilege('corgi_app', 'plaid_item_event', 'UPDATE') THEN
    RAISE EXCEPTION
      '0056 refuses to commit: corgi_app holds UPDATE on plaid_item_event, which is supposed to be append-only.';
  END IF;

  -- 4. the fold produces `orphaned` -- proven on a real row, then removed.
  INSERT INTO plaid_item_event (item_id, source, webhook_code, error_code, error_type, error_message)
  VALUES ('0056-selftest-item', 'webhook', 'ERROR', 'ITEM_LOGIN_REQUIRED', 'ITEM_ERROR', 'self-test');

  SELECT state INTO v_state FROM v_plaid_item_state WHERE item_id = '0056-selftest-item';
  IF v_state IS DISTINCT FROM 'orphaned' THEN
    RAISE EXCEPTION
      '0056 refuses to commit: an Item with an ERROR webhook and no stored credential folded to ''%'', not ''orphaned''. The state vocabulary in §5 does not match the view in §11.',
      v_state;
  END IF;

  -- 2. the append-only trigger really fires
  v_raised := false;
  BEGIN
    UPDATE plaid_item_event SET error_code = 'TAMPERED' WHERE item_id = '0056-selftest-item';
  EXCEPTION WHEN SQLSTATE '55006' THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION
      '0056 refuses to commit: plaid_item_event accepted an UPDATE. The append-only trigger is not armed, so an Item''s history is rewritable and §4 is false.';
  END IF;

  -- 3. the token shape check really refuses a non-token
  INSERT INTO plaid_item (item_id, institution_id, environment, purpose)
  VALUES ('0056-selftest-item', 'ins_109508', 'sandbox', 'diagnostic');
  v_raised := false;
  BEGIN
    INSERT INTO plaid_item_secret (item_id, version, access_token)
    VALUES ('0056-selftest-item', 1, '0056-selftest-item');
  EXCEPTION WHEN check_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION
      '0056 refuses to commit: plaid_item_secret accepted a value that is not an access token, so the column that is supposed to hold a bearer credential will hold anything.';
  END IF;

  -- Leave nothing behind. DELETE is possible here because this block runs
  -- as the migration role, which is the table owner; `corgi_app` holds no
  -- DELETE and the trigger refuses it regardless of role.
  DELETE FROM plaid_item WHERE item_id = '0056-selftest-item';
  ALTER TABLE plaid_item_event DISABLE TRIGGER plaid_item_event_append_only;
  DELETE FROM plaid_item_event WHERE item_id = '0056-selftest-item';
  ALTER TABLE plaid_item_event ENABLE TRIGGER plaid_item_event_append_only;
END $$;
