-- =====================================================================
-- 0035.  The actor trail:  who did what to this business, in order.
-- =====================================================================
--
-- The ledger answers "what happened to the MONEY" and it answers it four
-- ways over -- privileges, triggers, no ON CONFLICT DO UPDATE, a sha256
-- chain -- and `dbcheck` proves the application role cannot physically
-- express UPDATE on a money table.
--
-- Nothing answers "who DID that".  The facts exist; they are scattered
-- across thirty-odd stores with four different ideas of what an actor is,
-- and there is no way to ask the first question a regulator or an incident
-- review asks, which is: what happened to this business, in order?
--
-- ---------------------------------------------------------------------
-- 1.  WHY THIS READS AND DOES NOT WRITE
-- ---------------------------------------------------------------------
--
-- The alternative was a fifth store every surface must call.  It is
-- stronger where it is called and worthless where it is forgotten, and
-- this repository has now found seventeen guards that failed because what
-- they excluded was shaped exactly like the thing they existed to catch.
-- A write path fails in precisely that shape: the surface that forgets to
-- call the audit logger is invisible, the trail reads complete, and the
-- omission is discovered by an auditor rather than by us.
--
-- A projection cannot lose a surface that forgets to call it, because
-- there is nothing to call.  It has one failure mode instead -- a store
-- that exists and is not read -- and that failure is DETECTABLE FROM THE
-- CATALOG, which is what §6 and §7 below do.  Every base table in this
-- schema must be classified, projected or excluded-with-a-reason, and a
-- table nobody has decided about is reported as unclaimed.  You cannot
-- write the equivalent check for a write path: there is no catalog of
-- call sites.
--
-- It is also RETROACTIVE.  A write path starts at its deploy and leaves
-- every action taken before it invisible forever.  This projects the
-- 2,800 journal entries, 922 provider callbacks and 314 approval events
-- that are already on this book.
--
-- The price is stated rather than hidden: a surface that records NOTHING
-- durably cannot be read into existence.  There is exactly one of those
-- and §3 gives it a table so that wiring it is one line.  The full list
-- of unrecorded actions is in docs/AUDIT.md.
--
-- ---------------------------------------------------------------------
-- 2.  WHY THE TRAIL IS APPEND-ONLY WITHOUT OWNING A ROW
-- ---------------------------------------------------------------------
--
-- "A who-did-what log that can be UPDATEd is not evidence."  Agreed --
-- and the strongest version of that is a trail with no rows of its own to
-- edit.  Every row `v_actor_action` returns is read live out of a store
-- `corgi_app` holds no UPDATE and no DELETE on, and `v_audit_source_weak`
-- (§7) re-derives that from `information_schema.role_table_grants` and
-- `pg_trigger` on every render rather than asserting it in a comment.  A
-- source that loses its append-only defence stops being evidence and the
-- screen says so.
--
-- The two tables this migration DOES create carry the same defence as the
-- money tables: INSERT and SELECT only for `corgi_app`, plus the
-- no-UPDATE/no-DELETE and no-TRUNCATE triggers from 0001 §13.
--
-- ---------------------------------------------------------------------
-- 3.  EVERY JOIN IN THE PROJECTION IS A LEFT JOIN
-- ---------------------------------------------------------------------
--
-- This is the one rule that makes the count in §6 mean anything.  An
-- INNER JOIN to `account` silently drops the rows whose account was never
-- written -- which is the shape of the bug the trail exists to find.  So
-- nothing in §5 may drop a row: a row that cannot be attributed to a
-- business is projected with `business_id IS NULL` and shows up as
-- UNATTRIBUTED, never as absent, and §6 asserts
-- `projected_rows = stored_rows` for every source.

-- ---------------------------------------------------------------------
-- §1.  THE SOURCE REGISTRY
-- ---------------------------------------------------------------------
--
-- One row per base table in this schema.  Not a pattern, not a LIKE, not
-- a shape heuristic -- an enumeration, because the detector for "is this
-- an action store?" must not be able to be fooled by a store shaped like
-- something it would skip.  Adding a table to the schema without adding a
-- row here makes `v_audit_source_unclaimed` non-empty, which is the
-- invariant.
--
-- Append-only for the same reason the money tables are: the history of
-- what this trail CLAIMED to cover is itself evidence.  A later migration
-- that starts projecting a store appends a superseding row; it does not
-- rewrite the old one.  `v_audit_source` takes the latest row per table.

CREATE TABLE IF NOT EXISTS audit_source (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq           bigserial   NOT NULL,
  table_name    text        NOT NULL,
  -- projected        — §5 reads it into the trail
  -- excluded         — deliberately not in the trail; `reason` says why
  -- awaiting_wiring  — the table exists and is empty because the surface
  --                    that should write it has not been pointed at it.
  --                    Deliberately NOT 'projected': a source that reads
  --                    zero because nothing writes it must not be
  --                    indistinguishable from one that reads zero because
  --                    nothing happened.
  disposition   text        NOT NULL
                CHECK (disposition IN ('projected', 'excluded', 'awaiting_wiring')),
  surface       text,
  reason        text        NOT NULL,
  declared_in   text        NOT NULL,
  declared_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_source_table_idx ON audit_source (table_name, seq DESC);

-- ---------------------------------------------------------------------
-- §2.  THE AGENT SURFACE'S AUDIT TABLE
-- ---------------------------------------------------------------------
--
-- `src/lib/mcp/audit.ts` writes one record per MCP call -- including the
-- refused ones, which is the half that matters after an incident -- to
-- one JSON line on stdout, and says in its own header that the table
-- below is the missing piece and that migrations were owned elsewhere.
-- They are owned here.
--
-- This is the ONE surface a projection genuinely cannot recover: ten read
-- tools serving a customer's balances, transactions, payees, pots,
-- standing orders, card controls, accruals, disputes and recon breaks to
-- an autonomous agent, with no durable record in this database at all.
-- The write tool is safe -- it lands in `payment_instruction` and its
-- `requested` event, both append-only -- but "what did the agent READ"
-- has no answer that outlives a log retention window.
--
-- The DDL is 0035's because only 0035 could write it.  The one-line call
-- site change is NOT made here -- `src/app/api/mcp/route.ts` belongs to
-- another worker -- and is spelled out exactly in docs/AUDIT.md.  Until
-- that line lands this table is `awaiting_wiring` in the registry and the
-- audit screen prints the gap on its face.

CREATE TABLE IF NOT EXISTS mcp_audit (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at            timestamptz NOT NULL DEFAULT now(),
  request_id    text        NOT NULL,
  method        text        NOT NULL,
  tool          text,
  outcome       text        NOT NULL,
  error_code    text,
  -- Null when authentication itself failed: an unknown token has no actor,
  -- and inventing one would be the only dishonest row in this schema.
  actor_id      uuid        REFERENCES actor (id),
  business_id   uuid        REFERENCES business (id),
  grant_label   text,
  -- First four bytes of the token's sha256, never the token.  Named `_fp`
  -- and not `_token` on purpose: `@/lib/log` redacts any field whose name
  -- contains "token", and a column that is always `[redacted]` is a column
  -- that is not in the audit log.
  grant_fp      text,
  client_key    text        NOT NULL,
  -- Written through `redactArguments()` in src/lib/mcp/audit.ts, which
  -- masks account numbers to the last four and drops secrets entirely.
  arguments     jsonb,
  result        jsonb,
  duration_ms   integer     NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_audit_actor_idx    ON mcp_audit (actor_id, at DESC);
CREATE INDEX IF NOT EXISTS mcp_audit_business_idx ON mcp_audit (business_id, at DESC);
CREATE INDEX IF NOT EXISTS mcp_audit_outcome_idx  ON mcp_audit (outcome, at DESC);

-- ---------------------------------------------------------------------
-- §3.  THE SAME DEFENCE THE MONEY TABLES HAVE
-- ---------------------------------------------------------------------
--
-- Four layers, exactly as 0001 §13 does it for `journal_entry`:
--   1. the role holds INSERT and SELECT and nothing else (below);
--   2. a BEFORE UPDATE OR DELETE trigger that raises regardless of role,
--      so the OWNER cannot do it either -- privileges never bind a table
--      owner, which is why layer 1 alone is not enough;
--   3. a TRUNCATE trigger, because TRUNCATE is not DELETE and a role with
--      only INSERT+SELECT still cannot TRUNCATE but the owner can;
--   4. no UPDATE path in application code (there is no writer at all yet
--      for mcp_audit, and audit_source is written by migrations only).

CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: a who-did-what row that can be % is not evidence',
    TG_TABLE_NAME, lower(TG_OP) USING ERRCODE = '55006';
END $$;

CREATE OR REPLACE FUNCTION audit_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: TRUNCATE is not a correction', TG_TABLE_NAME
    USING ERRCODE = '55006';
END $$;

DROP TRIGGER IF EXISTS audit_source_no_update_delete ON audit_source;
CREATE TRIGGER audit_source_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_source
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

DROP TRIGGER IF EXISTS audit_source_no_truncate ON audit_source;
CREATE TRIGGER audit_source_no_truncate
  BEFORE TRUNCATE ON audit_source
  FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate();

DROP TRIGGER IF EXISTS mcp_audit_no_update_delete ON mcp_audit;
CREATE TRIGGER mcp_audit_no_update_delete
  BEFORE UPDATE OR DELETE ON mcp_audit
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

DROP TRIGGER IF EXISTS mcp_audit_no_truncate ON mcp_audit;
CREATE TRIGGER mcp_audit_no_truncate
  BEFORE TRUNCATE ON mcp_audit
  FOR EACH STATEMENT EXECUTE FUNCTION audit_no_truncate();

GRANT SELECT, INSERT ON mcp_audit    TO corgi_app;
GRANT SELECT           ON audit_source TO corgi_app;

-- ---------------------------------------------------------------------
-- §4.  THE CLASSIFICATION
-- ---------------------------------------------------------------------
--
-- Every base table in the schema as of this migration.  The `reason`
-- column is load-bearing: "excluded" with no argument is how a surface
-- goes missing, so an exclusion that cannot be written down is not an
-- exclusion, it is an omission.
--
-- Re-runnable: the guard below makes the seed a no-op once the rows are
-- there, because `audit_source` refuses UPDATE and a migration that can
-- only be applied to an empty database is a migration that cannot be
-- re-applied to a restored one.

INSERT INTO audit_source (table_name, disposition, surface, reason, declared_in)
SELECT v.table_name, v.disposition, v.surface, v.reason, '0035_audit.sql'
FROM (VALUES
  -- ---- projected: business-scoped actions --------------------------
  ('account_opening','projected','accounts','Who opened the account and on what KYB evidence.'),
  ('kyb_verification_leg','projected','kyb','Each verification leg, with BOTH time axes: observed_at is when the provider decided, recorded_at is when we learned.'),
  ('payment_instruction_event','projected','payments','The maker-checker trail: requested, approved, rejected, released, settled, returned, failed, cancelled.'),
  ('standing_order','projected','standing_orders','Who set up a recurring payment.'),
  ('standing_order_cancellation','projected','standing_orders','Who stopped one.'),
  ('standing_order_occurrence','projected','standing_orders','One row per scheduled firing, LEFT JOINed to its outcome so a claimed-but-undecided occurrence is visible as unresolved rather than absent.'),
  ('card','projected','cards','A card was issued to a person. NO ACTOR COLUMN EXISTS: projected as unattributed, which is the honest rendering of a hole. See docs/AUDIT.md.'),
  ('card_control_version','projected','cards','Who changed a spend limit or an MCC block, and from which version.'),
  ('card_auth_decision','projected','cards','The real-time authorisation decision, taken by this system inside the provider timeout.'),
  ('card_auth_event','projected','cards','What the issuer processor told us: auth, incremental, clearing, reversal, expiry, close.'),
  ('hold_closure','projected','holds','Who or what released a hold on customer funds.'),
  ('hold_closure_reversal','projected','holds','Who re-opened one.'),
  ('dispute_event','projected','disputes','Raising, provisional credit, evidence, outcome, clawback.'),
  ('fx_quote','projected','fx','Who priced a cross-border payout.'),
  ('fx_quote_acceptance','projected','fx','Who accepted the rate. The customer commitment.'),
  ('fx_quote_settlement','projected','fx','Who settled it on chain.'),
  ('payee','projected','payees','Who added a beneficiary to the book.'),
  ('payee_verification','projected','payees','Who ran the confirmation-of-payee check and what it said.'),
  ('payee_acknowledgement','projected','payees','Who overrode a warning, and their stated reason. The single most read row in any payments incident.'),
  ('payee_archival','projected','payees','Who removed a beneficiary.'),
  ('payee_candidate_refusal','projected','payees','An attempt the system refused before it became a payee. An action that was TAKEN, not one that succeeded.'),
  ('pot','projected','pots','Who opened a sub-account.'),
  ('statement','projected','statements','Who generated a statement version, and at which booking watermark.'),
  ('interest_schedule','projected','interest','Who put an account on a rate tier.'),
  ('interest_day','projected','interest','One row per accrual day, LEFT JOINed to its posting so an unresolved claim is visible.'),
  ('accrual_schedule','projected','fees','Who put an account on a fee plan.'),
  ('accrual_day','projected','fees','One row per fee day, LEFT JOINed to its posting so an unresolved claim is visible.'),
  ('interchange_posting','projected','interchange','The nightly pricing run that recognised interchange on a clearing.'),
  ('interchange_reversal','projected','interchange','Who reversed and re-booked a priced settlement.'),
  ('journal_entry','projected','ledger','Every posting to the book, with the canonical two axes: value_date and booking_time.'),
  ('webhook_inbox','projected','webhooks','The provider callback itself -- the fourth kind of actor. ONLY the columns webhook_inbox_guard() makes immutable are projected (provider, event id, type, received_at, signature_verified_at); the mutable processing state is deliberately not evidence.'),
  -- ---- projected: book-wide actions --------------------------------
  ('book_day','projected','book','Who closed a business day, and at what watermark.'),
  ('recon_run','projected','recon','Who ran the scheme reconciliation.'),
  ('scheme_file','projected','recon','Who imported a processor file, and its sha256.'),
  ('recon_break_note','projected','recon','Who wrote off, explained or adjusted a break.'),
  ('chaos_event','projected','chaos','Who armed, fired or disarmed an attack against this system. An operator action with customer-visible effects.'),
  ('interest_rate_policy','projected','policy','Who changed the rate card.'),
  ('interchange_rate_policy','projected','policy','Who changed the interchange rate card.'),
  -- ---- awaiting wiring ----------------------------------------------
  ('mcp_audit','awaiting_wiring','agent','Every MCP call including refusals. The table exists; the surface still writes to stdout only. One line in src/app/api/mcp/route.ts, spelled out in docs/AUDIT.md.'),
  -- ---- excluded: folded into a projected source ---------------------
  ('payment_instruction','excluded','payments','Its creation IS the `requested` row in payment_instruction_event, written in the same transaction. Projecting both would double-count every payment on the screen.'),
  ('dispute','excluded','disputes','Its raising IS the `raised` row in dispute_event.'),
  ('standing_order_outcome','excluded','standing_orders','Folded into the standing_order_occurrence branch, so an occurrence claimed by a run that then died is visible as unresolved instead of silently absent.'),
  ('accrual_posting','excluded','fees','Folded into the accrual_day branch, same reason.'),
  ('interest_posting','excluded','interest','Folded into the interest_day branch, same reason.'),
  ('card_auth_event_result','excluded','cards','The network verdict for a projected card_auth_event; carried in that row''s detail.'),
  ('journal_line','excluded','ledger','A component of a projected journal_entry, not a separate act.'),
  ('scheme_file_row','excluded','recon','Contents of a projected file import.'),
  ('scheme_file_reject','excluded','recon','Contents of a projected file import.'),
  ('recon_run_break','excluded','recon','A finding of a projected run, not an action. /breaks and /reconciliation own it.'),
  ('recon_match','excluded','recon','A match is the ABSENCE of a finding; the run that produced it is projected.'),
  ('fx_rate_observation','excluded','fx','Evidence cited by a projected fx_quote, carried in its detail.'),
  -- ---- excluded: state, not action ----------------------------------
  ('account','excluded','accounts','The chart of accounts. Its opening is projected from account_opening and every posting to it from journal_entry.'),
  ('card_authorization','excluded','cards','The authorisation''s identity. Its lifecycle is projected from card_auth_event.'),
  ('hold','excluded','holds','Created as a consequence of a projected authorisation or credit; its closure and re-opening are projected.'),
  -- ---- excluded: reference data -------------------------------------
  ('book_entity','excluded',NULL,'Reference data: the books themselves.'),
  ('per_business_rollup','excluded',NULL,'Reference data: the shape of a business subtree.'),
  ('dispute_reason_code','excluded',NULL,'Reference data: network reason codes.'),
  ('interchange_category','excluded',NULL,'Reference data.'),
  ('interchange_mcc','excluded',NULL,'Reference data: MCC to category.'),
  ('interest_rate_tier','excluded',NULL,'Reference data: tier names.'),
  ('rail_event_semantics','excluded',NULL,'Reference data: how a provider event type maps to a canonical kind.'),
  ('schema_migrations','excluded',NULL,'A deployment trail, and a real one -- filename plus sha256, refused on change. It is not an action taken against a customer, so it is not on the business timeline. Named here so it is excluded rather than forgotten.'),
  ('audit_source','excluded',NULL,'This registry. Self-reference would be noise on a business timeline; it is rendered directly by the completeness panel.'),
  -- ---- excluded: MUTABLE, therefore not evidence --------------------
  ('chaos_control','excluded','chaos','corgi_app holds UPDATE and DELETE on it: an armed control is live state, by design. What was armed and when is projected from chaos_event, which the role cannot mutate.'),
  ('chaos_delivery','excluded','chaos','Mutable delivery scheduling state. The attack that produced it is projected from chaos_event.'),
  ('chaos_run','excluded','chaos','Mutable run state. Its events are projected.'),
  -- ---- excluded: NO ACTION IS RECORDED AT ALL -----------------------
  --
  -- These four are the report, not the feature.  Each is a place an
  -- action is TAKEN and recorded nowhere, and no projection can invent
  -- the row that was never written.  docs/AUDIT.md carries the full
  -- list and the column each one needs.
  ('actor','excluded','team','HOLE. The register of who exists. Creating a user, granting can_approve, or removing a team member leaves NO row anywhere: there is no actor_event table, no created_by, and no removal concept at all. "Who removed a team member" is currently unanswerable.'),
  ('approval_policy','excluded','policy','HOLE. The maker-checker threshold itself. No actor column AND no timestamp column: who raised the approval threshold, and when, is not merely unattributed, it is unrecordable. The highest-value unaudited action in the schema.'),
  ('business','excluded','onboarding','HOLE. created_at only, no actor. Who onboarded this legal entity is not recorded.'),
  ('funds_availability_policy','excluded','policy','HOLE. created_at but no created_by. Who changed how long a wire credit is withheld is not recorded.')
) AS v(table_name, disposition, surface, reason)
WHERE NOT EXISTS (SELECT 1 FROM audit_source s WHERE s.table_name = v.table_name);

-- The registry as it stands now: the latest declaration per table.
CREATE OR REPLACE VIEW v_audit_source AS
SELECT DISTINCT ON (s.table_name)
       s.table_name, s.disposition, s.surface, s.reason, s.declared_in, s.declared_at
  FROM audit_source s
 ORDER BY s.table_name, s.seq DESC;

GRANT SELECT ON v_audit_source TO corgi_app;

-- ---------------------------------------------------------------------
-- §5.  THE PROJECTION
-- ---------------------------------------------------------------------
--
-- One row per action.  Two time axes on every row:
--
--   occurred_at  when the thing happened, in the world
--   recorded_at  when this book learned about it
--
-- Where a store keeps only one clock they are equal and
-- `time_axes_differ` is false, which is the honest rendering -- a screen
-- that prints two identical timestamps and implies they were separately
-- observed is worse than one that says they are the same.
--
-- ACTOR KINDS.  Five, not four, and the fifth is the point:
--
--   human         a person.  The only kind that can approve anything --
--                 `actor_only_humans_approve` makes the alternative
--                 unrepresentable.
--   agent         an autonomous MCP client acting under a token.
--   system        a cron tick, a run, a poster.  NOT a person, and
--                 deliberately not merged with `agent`: "the nightly
--                 accrual run posted this" and "a model decided to post
--                 this" are different facts and docs/AGENT-LIMITS.md is
--                 the statement of why.
--   provider      a third-party callback: Lithic, Increase, Stripe,
--                 Plaid.  Has no row in `actor` and should not: it is
--                 not a principal of ours, it is a counterparty, and
--                 giving it an id in our actor table would make it
--                 eligible for a `can_approve` column.
--   unattributed  the store recorded the act and not who took it.  A
--                 first-class value BECAUSE it is a defect; rendering it
--                 as "system" would hide the holes this build found.
--
-- `autonomous` is derived once here rather than at each call site, so
-- "an action taken by an autonomous agent" is a WHERE clause and not a
-- convention: every non-human kind is autonomous.
--
-- MONEY IS BIGINT CENTS.  `amount_cents` is nullable: an action with no
-- amount carries NULL rather than 0, because zero is a real settled
-- amount in this domain (a $0 card-on-file verification) and the two must
-- not print the same.
--
-- NO SECRETS.  No `provider_card_token`, no full account number, no PAN,
-- no API key, no raw webhook body.  Card identity is `last_four` only;
-- beneficiary identity is `account_number_last4` and the ABA routing
-- number, which is published by the Fed and is what an investigator needs
-- to name the receiving institution.

CREATE OR REPLACE VIEW v_actor_action AS

-- ---- accounts --------------------------------------------------------
SELECT 'account_opening'::text                       AS source,
       'account_opening:' || ao.account_id::text     AS action_id,
       ao.business_id                                AS business_id,
       ao.opened_at                                  AS occurred_at,
       ao.opened_at                                  AS recorded_at,
       ao.opened_at::date                            AS value_date,
       COALESCE(act.kind::text, 'unattributed')      AS actor_kind,
       ao.opened_by                                  AS actor_id,
       COALESCE(act.display_name, 'not recorded')    AS actor_label,
       'accounts'::text                              AS surface,
       'account.opened'::text                        AS action,
       'Account ' || COALESCE(a.code, '?') || ' opened' AS summary,
       NULL::bigint                                  AS amount_cents,
       'account'::text                               AS subject_kind,
       ao.account_id::text                           AS subject_id,
       NULL::uuid                                    AS entry_id,
       jsonb_build_object('rollup_code', ao.rollup_code, 'kyb_status', ao.kyb_status,
                          'kyb_evidence', ao.kyb_evidence, 'kyb_legs_on_file', ao.kyb_legs_on_file)
                                                     AS detail
  FROM account_opening ao
  LEFT JOIN actor   act ON act.id = ao.opened_by
  LEFT JOIN account a   ON a.id   = ao.account_id

-- ---- kyb: the clearest two-axis store in the schema -------------------
UNION ALL
SELECT 'kyb_verification_leg',
       'kyb_verification_leg:' || k.id::text,
       k.business_id,
       k.observed_at,
       k.recorded_at,
       k.observed_at::date,
       COALESCE(act.kind::text, 'provider'),
       k.decided_by_actor_id,
       COALESCE(act.display_name, k.provider),
       'kyb',
       'kyb.' || k.leg::text || '.' || k.status::text,
       initcap(replace(k.leg::text, '_', ' ')) || ' — ' || k.status::text || ' via ' || k.provider,
       NULL::bigint,
       'business', k.business_id::text, NULL::uuid,
       jsonb_build_object('leg', k.leg, 'status', k.status, 'evidence', k.evidence,
                          'provider', k.provider, 'provider_reference', k.provider_reference,
                          'raw_status', k.raw_status, 'decision_reason', k.decision_reason)
  FROM kyb_verification_leg k
  LEFT JOIN actor act ON act.id = k.decided_by_actor_id

-- ---- payments: the maker-checker trail --------------------------------
UNION ALL
SELECT 'payment_instruction_event',
       'payment_instruction_event:' || e.id::text,
       ac.business_id,
       e.occurred_at,
       e.occurred_at,
       e.value_date,
       COALESCE(act.kind::text, 'unattributed'),
       e.actor_id,
       COALESCE(act.display_name, 'not recorded'),
       'payments',
       'payment.' || e.kind::text,
       COALESCE(upper(pi.rail::text), 'payment') || ' payment ' || e.kind::text
         || COALESCE(' — ' || e.reason, ''),
       pi.amount_cents,
       'payment_instruction', e.instruction_id::text, e.entry_id,
       jsonb_build_object('rail', pi.rail, 'kind', e.kind,
                          'holder_name', pi.counterparty -> 'holderName',
                          'routing_number', pi.counterparty -> 'routingNumber',
                          'account_number_last4', pi.counterparty -> 'accountNumberLast4',
                          'approved_content_hash', encode(e.approved_content_hash, 'hex'))
  FROM payment_instruction_event e
  LEFT JOIN payment_instruction pi ON pi.id = e.instruction_id
  LEFT JOIN account ac             ON ac.id = pi.account_id
  LEFT JOIN actor   act            ON act.id = e.actor_id

-- ---- standing orders ---------------------------------------------------
UNION ALL
SELECT 'standing_order',
       'standing_order:' || so.id::text,
       ac.business_id,
       so.created_at, so.created_at, so.start_date,
       COALESCE(act.kind::text, 'unattributed'), so.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'standing_orders', 'standing_order.created',
       'Standing order ' || so.reference || ' created (' || so.cadence::text || ')',
       so.amount_cents,
       'standing_order', so.id::text, NULL::uuid,
       jsonb_build_object('rail', so.rail, 'cadence', so.cadence, 'reference', so.reference,
                          'start_date', so.start_date, 'end_date', so.end_date)
  FROM standing_order so
  LEFT JOIN account ac ON ac.id = so.account_id
  LEFT JOIN actor act  ON act.id = so.created_by

UNION ALL
SELECT 'standing_order_cancellation',
       'standing_order_cancellation:' || c.standing_order_id::text,
       ac.business_id,
       c.cancelled_at, c.cancelled_at, c.cancelled_at::date,
       COALESCE(act.kind::text, 'unattributed'), c.cancelled_by,
       COALESCE(act.display_name, 'not recorded'),
       'standing_orders', 'standing_order.cancelled',
       'Standing order ' || COALESCE(so.reference, '?') || ' cancelled'
         || COALESCE(' — ' || c.reason, ''),
       so.amount_cents,
       'standing_order', c.standing_order_id::text, NULL::uuid,
       jsonb_build_object('reason', c.reason)
  FROM standing_order_cancellation c
  LEFT JOIN standing_order so ON so.id = c.standing_order_id
  LEFT JOIN account ac        ON ac.id = so.account_id
  LEFT JOIN actor act         ON act.id = c.cancelled_by

-- An occurrence with no outcome is a run that claimed the work and died.
-- It is projected as `unresolved` rather than dropped, because "the
-- scheduled payment that nobody can account for" is the single row this
-- screen most needs to be able to show.
UNION ALL
SELECT 'standing_order_occurrence',
       'standing_order_occurrence:' || oc.id::text,
       ac.business_id,
       (oc.scheduled_date::timestamptz),
       COALESCE(o.decided_at, oc.claimed_at),
       oc.scheduled_date,
       'system', NULL::uuid,
       COALESCE(o.decided_by_run, oc.claimed_by, 'not recorded'),
       'standing_orders',
       'standing_order.' || COALESCE(o.disposition::text, 'unresolved'),
       'Standing order ' || COALESCE(so.reference, '?') || ' due ' || oc.scheduled_date::text
         || ' — ' || COALESCE(o.disposition::text, 'CLAIMED BUT NEVER DECIDED')
         || COALESCE(' (' || o.refusal_code || ')', ''),
       so.amount_cents,
       'standing_order', oc.standing_order_id::text, NULL::uuid,
       jsonb_build_object('scheduled_date', oc.scheduled_date, 'claimed_by', oc.claimed_by,
                          'disposition', o.disposition, 'refusal_code', o.refusal_code,
                          'refusal_reason', o.refusal_reason,
                          'instruction_id', o.instruction_id,
                          'observed_available_cents', o.observed_available_cents,
                          'shortfall_cents', o.shortfall_cents)
  FROM standing_order_occurrence oc
  LEFT JOIN standing_order_outcome o ON o.occurrence_id = oc.id
  LEFT JOIN standing_order so        ON so.id = oc.standing_order_id
  LEFT JOIN account ac               ON ac.id = so.account_id

-- ---- cards -------------------------------------------------------------
UNION ALL
SELECT 'card',
       'card:' || c.id::text,
       c.business_id,
       c.created_at, c.created_at, c.created_at::date,
       'unattributed', NULL::uuid, 'not recorded — card has no actor column',
       'cards', 'card.issued',
       'Card ••' || COALESCE(c.last_four, '????') || ' issued'
         || COALESCE(' (' || c.nickname || ')', ''),
       NULL::bigint,
       'card', c.id::text, NULL::uuid,
       jsonb_build_object('provider', c.provider, 'last_four', c.last_four, 'nickname', c.nickname)
  FROM card c

UNION ALL
SELECT 'card_control_version',
       'card_control_version:' || v.id::text,
       c.business_id,
       v.effective_from, v.created_at, v.effective_from::date,
       COALESCE(act.kind::text, 'unattributed'), v.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'cards', 'card.controls_changed',
       'Card ••' || COALESCE(c.last_four, '????') || ' controls v' || v.version::text
         || ' — ' || v.card_state || COALESCE(', ' || v.note, ''),
       v.per_txn_limit_cents,
       'card', v.card_id::text, NULL::uuid,
       jsonb_build_object('version', v.version, 'card_state', v.card_state,
                          'per_txn_limit_cents', v.per_txn_limit_cents,
                          'daily_limit_cents', v.daily_limit_cents,
                          'monthly_limit_cents', v.monthly_limit_cents,
                          'blocked_mccs', to_jsonb(v.blocked_mccs), 'note', v.note)
  FROM card_control_version v
  LEFT JOIN card c    ON c.id = v.card_id
  LEFT JOIN actor act ON act.id = v.created_by

UNION ALL
SELECT 'card_auth_decision',
       'card_auth_decision:' || d.id::text,
       c.business_id,
       d.decided_at, d.decided_at, d.decided_at::date,
       'system', NULL::uuid, 'auth decision (' || d.source || ')',
       'cards', 'card.auth_' || d.outcome,
       'Authorisation ' || d.outcome || ' — ' || COALESCE(d.merchant_descriptor, 'merchant')
         || COALESCE(' [' || d.rule || ']', ''),
       d.amount_cents,
       'card', d.card_id::text, NULL::uuid,
       jsonb_build_object('outcome', d.outcome, 'result_code', d.result_code, 'rule', d.rule,
                          'reason', d.reason, 'mcc', d.mcc, 'source', d.source,
                          'latency_us', d.decision_latency_us,
                          'control_version_id', d.control_version_id)
  FROM card_auth_decision d
  LEFT JOIN card c ON c.id = d.card_id

-- The provider is the actor here.  `received_at` is when we learned;
-- `value_date` is the day the money belongs to.  They differ constantly
-- and that difference is the whole of the settlement story.
UNION ALL
SELECT 'card_auth_event',
       'card_auth_event:' || ev.id::text,
       ac.business_id,
       (ev.value_date::timestamptz), ev.received_at, ev.value_date,
       'provider', NULL::uuid, COALESCE(ca.provider, 'provider'),
       'cards', 'card.' || ev.kind::text,
       COALESCE(initcap(replace(ev.kind::text, '_', ' ')), 'Card event')
         || CASE WHEN ev.is_final THEN ' (final)' ELSE '' END,
       ev.amount_cents,
       'card_authorization', ev.auth_id::text, NULL::uuid,
       jsonb_build_object('kind', ev.kind, 'is_final', ev.is_final,
                          'provider_event_id', ev.provider_event_id,
                          'network_result', r.result, 'provider_step', r.provider_step,
                          'result_source', r.source)
  FROM card_auth_event ev
  LEFT JOIN card_auth_event_result r ON r.event_id = ev.id
  LEFT JOIN card_authorization ca    ON ca.id = ev.auth_id
  LEFT JOIN account ac               ON ac.id = ca.account_id

-- ---- holds -------------------------------------------------------------
UNION ALL
SELECT 'hold_closure',
       'hold_closure:' || hc.hold_id::text,
       ac.business_id,
       hc.closed_at, hc.closed_at, h.value_date,
       COALESCE(act.kind::text, 'unattributed'), hc.actor_id,
       COALESCE(act.display_name, 'not recorded'),
       'holds', 'hold.closed',
       'Hold released — ' || hc.reason,
       NULL::bigint,
       'hold', hc.hold_id::text, NULL::uuid,
       jsonb_build_object('reason', hc.reason, 'hold_kind', h.kind, 'external_ref', h.external_ref)
  FROM hold_closure hc
  LEFT JOIN hold h     ON h.id = hc.hold_id
  LEFT JOIN account ac ON ac.id = h.account_id
  LEFT JOIN actor act  ON act.id = hc.actor_id

UNION ALL
SELECT 'hold_closure_reversal',
       'hold_closure_reversal:' || hr.hold_id::text,
       ac.business_id,
       hr.reversed_at, hr.reversed_at, h.value_date,
       COALESCE(act.kind::text, 'unattributed'), hr.actor_id,
       COALESCE(act.display_name, 'not recorded'),
       'holds', 'hold.closure_reversed',
       'Hold closure REVERSED — ' || hr.reason,
       NULL::bigint,
       'hold', hr.hold_id::text, NULL::uuid,
       jsonb_build_object('reason', hr.reason, 'hold_kind', h.kind)
  FROM hold_closure_reversal hr
  LEFT JOIN hold h     ON h.id = hr.hold_id
  LEFT JOIN account ac ON ac.id = h.account_id
  LEFT JOIN actor act  ON act.id = hr.actor_id

-- ---- disputes ----------------------------------------------------------
UNION ALL
SELECT 'dispute_event',
       'dispute_event:' || de.id::text,
       ac.business_id,
       de.occurred_at, de.occurred_at, de.value_date,
       COALESCE(act.kind::text, 'unattributed'), de.actor_id,
       COALESCE(act.display_name, 'not recorded'),
       'disputes', 'dispute.' || de.kind::text,
       'Dispute ' || COALESCE(d.case_ref, '?') || ' — ' || replace(de.kind::text, '_', ' ')
         || COALESCE(' — ' || de.detail, ''),
       de.amount_cents,
       'dispute', de.dispute_id::text, de.entry_id,
       jsonb_build_object('kind', de.kind, 'case_ref', d.case_ref, 'reason', d.reason,
                          'network', d.network, 'network_code', d.network_code,
                          'hold_id', de.hold_id, 'detail', de.detail)
  FROM dispute_event de
  LEFT JOIN dispute d  ON d.id = de.dispute_id
  LEFT JOIN account ac ON ac.id = d.account_id
  LEFT JOIN actor act  ON act.id = de.actor_id

-- ---- fx ----------------------------------------------------------------
UNION ALL
SELECT 'fx_quote',
       'fx_quote:' || q.id::text,
       q.business_id,
       q.created_at, q.created_at, q.created_at::date,
       COALESCE(act.kind::text, 'unattributed'), q.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'fx', 'fx.quoted',
       'FX quote ' || q.quote_ref || ' — ' || q.sell_currency || ' to ' || q.buy_currency,
       q.sell_cents,
       'fx_quote', q.id::text, NULL::uuid,
       jsonb_build_object('quote_ref', q.quote_ref, 'rail', q.rail,
                          'sell_currency', q.sell_currency, 'buy_currency', q.buy_currency,
                          'buy_minor', q.buy_minor, 'fee_cents', q.fee_cents,
                          'spread_bps', q.spread_bps, 'expires_at', q.expires_at,
                          'rate_evidence', o.evidence, 'rate_source', o.source)
  FROM fx_quote q
  LEFT JOIN actor act               ON act.id = q.created_by
  LEFT JOIN fx_rate_observation o    ON o.id  = q.observation_id

UNION ALL
SELECT 'fx_quote_acceptance',
       'fx_quote_acceptance:' || a.quote_id::text,
       q.business_id,
       a.accepted_at, a.accepted_at, a.accepted_at::date,
       COALESCE(act.kind::text, 'unattributed'), a.accepted_by,
       COALESCE(act.display_name, 'not recorded'),
       'fx', 'fx.accepted',
       'FX quote ' || COALESCE(q.quote_ref, '?') || ' ACCEPTED',
       q.sell_cents,
       'fx_quote', a.quote_id::text, NULL::uuid,
       jsonb_build_object('reference', a.reference, 'expires_at', q.expires_at)
  FROM fx_quote_acceptance a
  LEFT JOIN fx_quote q ON q.id = a.quote_id
  LEFT JOIN actor act  ON act.id = a.accepted_by

UNION ALL
SELECT 'fx_quote_settlement',
       'fx_quote_settlement:' || s.quote_id::text,
       q.business_id,
       s.settled_at, s.settled_at, s.settled_at::date,
       COALESCE(act.kind::text, 'unattributed'), s.settled_by,
       COALESCE(act.display_name, 'not recorded'),
       'fx', 'fx.settled',
       'FX payout settled on chain'
         || COALESCE(' — variance ' || s.variance_cents::text || 'c', ''),
       q.sell_cents,
       'fx_quote', s.quote_id::text, s.entry_id,
       jsonb_build_object('tx_hash', s.tx_hash, 'variance_cents', s.variance_cents,
                          'settlement_cost_cents', s.settlement_cost_cents)
  FROM fx_quote_settlement s
  LEFT JOIN fx_quote q ON q.id = s.quote_id
  LEFT JOIN actor act  ON act.id = s.settled_by

-- ---- payees ------------------------------------------------------------
UNION ALL
SELECT 'payee',
       'payee:' || p.id::text,
       p.business_id,
       p.created_at, p.created_at, p.created_at::date,
       COALESCE(act.kind::text, 'unattributed'), p.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'payees', 'payee.added',
       'Payee "' || p.display_name || '" added — ' || upper(p.rail::text)
         || ' ••' || COALESCE(p.account_number_last4, '????'),
       NULL::bigint,
       'payee', p.id::text, NULL::uuid,
       jsonb_build_object('holder_name', p.holder_name, 'rail', p.rail,
                          'routing_number', p.routing_number,
                          'account_number_last4', p.account_number_last4,
                          'account_type', p.account_type)
  FROM payee p
  LEFT JOIN actor act ON act.id = p.created_by

UNION ALL
SELECT 'payee_verification',
       'payee_verification:' || v.id::text,
       p.business_id,
       v.checked_at, v.checked_at, v.checked_at::date,
       COALESCE(act.kind::text, 'unattributed'), v.checked_by,
       COALESCE(act.display_name, 'not recorded'),
       'payees', 'payee.' || v.outcome::text,
       'Payee "' || COALESCE(p.display_name, '?') || '" check: ' || v.outcome::text
         || ' (name ' || v.name_match::text || ')',
       NULL::bigint,
       'payee', v.payee_id::text, NULL::uuid,
       jsonb_build_object('outcome', v.outcome, 'checksum_ok', v.checksum_ok,
                          'directory', v.directory, 'directory_provider', v.directory_provider,
                          'institution_name', v.institution_name, 'name_match', v.name_match,
                          'name_match_score', v.name_match_score, 'name_source', v.name_source,
                          'evidence', v.evidence)
  FROM payee_verification v
  LEFT JOIN payee p   ON p.id = v.payee_id
  LEFT JOIN actor act ON act.id = v.checked_by

UNION ALL
SELECT 'payee_acknowledgement',
       'payee_acknowledgement:' || ak.id::text,
       p.business_id,
       ak.acknowledged_at, ak.acknowledged_at, ak.acknowledged_at::date,
       COALESCE(act.kind::text, 'unattributed'), ak.acknowledged_by,
       COALESCE(act.display_name, 'not recorded'),
       'payees', 'payee.warning_acknowledged',
       'Payee warning OVERRIDDEN on "' || COALESCE(p.display_name, '?') || '" — ' || ak.reason,
       NULL::bigint,
       'payee', v.payee_id::text, NULL::uuid,
       jsonb_build_object('reason', ak.reason, 'verification_outcome', v.outcome,
                          'name_match', v.name_match)
  FROM payee_acknowledgement ak
  LEFT JOIN payee_verification v ON v.id = ak.verification_id
  LEFT JOIN payee p              ON p.id = v.payee_id
  LEFT JOIN actor act            ON act.id = ak.acknowledged_by

UNION ALL
SELECT 'payee_archival',
       'payee_archival:' || ar.payee_id::text,
       p.business_id,
       ar.archived_at, ar.archived_at, ar.archived_at::date,
       COALESCE(act.kind::text, 'unattributed'), ar.archived_by,
       COALESCE(act.display_name, 'not recorded'),
       'payees', 'payee.archived',
       'Payee "' || COALESCE(p.display_name, '?') || '" archived'
         || COALESCE(' — ' || ar.reason, ''),
       NULL::bigint,
       'payee', ar.payee_id::text, NULL::uuid,
       jsonb_build_object('reason', ar.reason)
  FROM payee_archival ar
  LEFT JOIN payee p   ON p.id = ar.payee_id
  LEFT JOIN actor act ON act.id = ar.archived_by

UNION ALL
SELECT 'payee_candidate_refusal',
       'payee_candidate_refusal:' || cr.id::text,
       cr.business_id,
       cr.attempted_at, cr.attempted_at, cr.attempted_at::date,
       COALESCE(act.kind::text, 'unattributed'), cr.attempted_by,
       COALESCE(act.display_name, 'not recorded'),
       'payees', 'payee.refused',
       'Payee REFUSED at entry — ' || cr.code || ': ' || cr.reason,
       NULL::bigint,
       'payee', NULL::text, NULL::uuid,
       jsonb_build_object('code', cr.code, 'reason', cr.reason, 'rail', cr.rail,
                          'holder_name', cr.holder_name,
                          'routing_number', cr.routing_number,
                          'account_number_last4', cr.account_number_last4)
  FROM payee_candidate_refusal cr
  LEFT JOIN actor act ON act.id = cr.attempted_by

-- ---- pots --------------------------------------------------------------
UNION ALL
SELECT 'pot',
       'pot:' || p.id::text,
       p.business_id,
       p.opened_at, p.opened_at, p.opened_at::date,
       COALESCE(act.kind::text, 'unattributed'), p.opened_by,
       COALESCE(act.display_name, 'not recorded'),
       'pots', 'pot.opened',
       'Pot "' || p.name || '" opened' || COALESCE(' — ' || p.purpose, ''),
       NULL::bigint,
       'pot', p.id::text, NULL::uuid,
       jsonb_build_object('name', p.name, 'purpose', p.purpose, 'account_id', p.account_id)
  FROM pot p
  LEFT JOIN actor act ON act.id = p.opened_by

-- ---- statements: period_end is when, generated_at is when we said so ----
UNION ALL
SELECT 'statement',
       'statement:' || st.id::text,
       ac.business_id,
       (st.period_end::timestamptz), st.generated_at, st.period_end,
       COALESCE(act.kind::text, 'unattributed'), st.generated_by,
       COALESCE(act.display_name, 'not recorded'),
       'statements', 'statement.generated',
       'Statement ' || st.period_start::text || '–' || st.period_end::text
         || ' v' || st.version::text || ' generated',
       st.closing_balance_cents,
       'statement', st.id::text, NULL::uuid,
       jsonb_build_object('version', st.version, 'booking_watermark', st.booking_watermark,
                          'line_count', st.line_count, 'format', st.format,
                          'content_hash', encode(st.content_hash, 'hex'))
  FROM statement st
  LEFT JOIN account ac ON ac.id = st.account_id
  LEFT JOIN actor act  ON act.id = st.generated_by

-- ---- interest ----------------------------------------------------------
UNION ALL
SELECT 'interest_schedule',
       'interest_schedule:' || s.id::text,
       ac.business_id,
       s.created_at, s.created_at, s.start_date,
       COALESCE(act.kind::text, 'unattributed'), s.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'interest', 'interest.scheduled',
       'Interest schedule on tier ' || s.rate_tier || ' from ' || s.start_date::text,
       NULL::bigint,
       'account', s.account_id::text, NULL::uuid,
       jsonb_build_object('rate_tier', s.rate_tier, 'start_date', s.start_date,
                          'end_date', s.end_date)
  FROM interest_schedule s
  LEFT JOIN account ac ON ac.id = s.account_id
  LEFT JOIN actor act  ON act.id = s.created_by

UNION ALL
SELECT 'interest_day',
       'interest_day:' || d.id::text,
       ac.business_id,
       (d.accrual_date::timestamptz), COALESCE(ip.decided_at, d.claimed_at), d.accrual_date,
       'system', NULL::uuid,
       COALESCE(ip.decided_by_run, d.claimed_by, 'not recorded'),
       'interest', 'interest.' || COALESCE(ip.disposition::text, 'unresolved'),
       'Interest ' || COALESCE(ip.disposition::text, 'CLAIMED BUT NEVER DECIDED')
         || ' for ' || d.accrual_date::text
         || COALESCE(' (' || ip.side::text || ')', ''),
       ip.amount_cents,
       'account', s.account_id::text, ip.entry_id,
       jsonb_build_object('accrual_date', d.accrual_date, 'claimed_by', d.claimed_by,
                          'disposition', ip.disposition, 'side', ip.side,
                          'rate_bps', ip.rate_bps, 'rounding', ip.rounding,
                          'skip_reason', ip.skip_reason)
  FROM interest_day d
  LEFT JOIN interest_posting ip ON ip.interest_day_id = d.id
  LEFT JOIN interest_schedule s ON s.id = d.schedule_id
  LEFT JOIN account ac          ON ac.id = s.account_id

-- ---- fee accrual -------------------------------------------------------
UNION ALL
SELECT 'accrual_schedule',
       'accrual_schedule:' || s.id::text,
       ac.business_id,
       s.created_at, s.created_at, s.start_date,
       COALESCE(act.kind::text, 'unattributed'), s.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'fees', 'fee.scheduled',
       'Fee plan "' || s.plan_name || '" from ' || s.start_date::text,
       s.monthly_cents,
       'account', s.account_id::text, NULL::uuid,
       jsonb_build_object('plan_name', s.plan_name, 'product', s.product,
                          'monthly_cents', s.monthly_cents, 'end_date', s.end_date)
  FROM accrual_schedule s
  LEFT JOIN account ac ON ac.id = s.account_id
  LEFT JOIN actor act  ON act.id = s.created_by

UNION ALL
SELECT 'accrual_day',
       'accrual_day:' || d.id::text,
       ac.business_id,
       (d.accrual_date::timestamptz), COALESCE(ap.decided_at, d.claimed_at), d.accrual_date,
       'system', NULL::uuid,
       COALESCE(ap.decided_by_run, d.claimed_by, 'not recorded'),
       'fees', 'fee.' || COALESCE(ap.disposition::text, 'unresolved'),
       'Fee ' || COALESCE(ap.disposition::text, 'CLAIMED BUT NEVER DECIDED')
         || ' for ' || d.accrual_date::text,
       ap.amount_cents,
       'account', s.account_id::text, ap.entry_id,
       jsonb_build_object('accrual_date', d.accrual_date, 'claimed_by', d.claimed_by,
                          'disposition', ap.disposition, 'residual_applied', ap.residual_applied,
                          'skip_reason', ap.skip_reason)
  FROM accrual_day d
  LEFT JOIN accrual_posting ap  ON ap.accrual_day_id = d.id
  LEFT JOIN accrual_schedule s  ON s.id = d.schedule_id
  LEFT JOIN account ac          ON ac.id = s.account_id

-- ---- interchange -------------------------------------------------------
UNION ALL
SELECT 'interchange_posting',
       'interchange_posting:' || ip.id::text,
       ip.business_id,
       (ip.value_date::timestamptz), ip.posted_at, ip.value_date,
       'system', NULL::uuid, COALESCE(ip.posted_by_run, 'not recorded'),
       'interchange', 'interchange.' || ip.direction::text,
       'Interchange ' || ip.direction::text || ' on ' || COALESCE(ip.category, '?')
         || ' (' || ip.presentment::text || ')',
       ip.interchange_cents,
       'interchange_posting', ip.id::text, ip.entry_id,
       jsonb_build_object('category', ip.category, 'mcc', ip.mcc,
                          'presentment', ip.presentment, 'rate_bps', ip.rate_bps,
                          'fixed_cents', ip.fixed_cents, 'settled_cents', ip.settled_cents,
                          'rounding', ip.rounding, 'network', ip.network)
  FROM interchange_posting ip

UNION ALL
SELECT 'interchange_reversal',
       'interchange_reversal:' || ir.interchange_posting_id::text,
       ip.business_id,
       (ir.value_date::timestamptz), ir.created_at, ir.value_date,
       COALESCE(act.kind::text, 'unattributed'), ir.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'interchange', 'interchange.reversed',
       'Interchange reversed and re-booked — ' || ir.reason,
       ip.interchange_cents,
       'interchange_posting', ir.interchange_posting_id::text, ir.reversal_entry_id,
       jsonb_build_object('reason', ir.reason, 'correction_group_id', ir.correction_group_id,
                          'rebook_entry_id', ir.rebook_entry_id,
                          'net_settled_cents', ir.net_settled_cents)
  FROM interchange_reversal ir
  LEFT JOIN interchange_posting ip ON ip.id = ir.interchange_posting_id
  LEFT JOIN actor act              ON act.id = ir.created_by

-- ---- the ledger itself: the canonical two axes -------------------------
--
-- business_id comes from the FIRST per-business leaf the entry touches, by
-- line ordinal.  A house-only entry (9900, 2200, 4100) attributes to no
-- business and is projected with NULL -- visible under "book-wide", never
-- dropped.
UNION ALL
SELECT 'journal_entry',
       'journal_entry:' || je.id::text,
       (SELECT a2.business_id
          FROM journal_line jl2 JOIN account a2 ON a2.id = jl2.account_id
         WHERE jl2.entry_id = je.id AND a2.business_id IS NOT NULL
         ORDER BY jl2.ordinal LIMIT 1),
       (je.value_date::timestamptz), je.booking_time, je.value_date,
       COALESCE(act.kind::text, 'unattributed'), je.actor_id,
       COALESCE(act.display_name, 'not recorded'),
       'ledger', 'ledger.' || je.entry_type::text,
       je.description,
       (SELECT max(abs(jl3.amount_cents)) FROM journal_line jl3 WHERE jl3.entry_id = je.id),
       'journal_entry', je.id::text, je.id,
       jsonb_build_object('book', je.book, 'entry_type', je.entry_type, 'rail', je.rail,
                          'booking_seq', je.booking_seq, 'external_ref', je.external_ref,
                          'reverses_entry_id', je.reverses_entry_id,
                          'correction_group_id', je.correction_group_id,
                          'hold_id', je.hold_id, 'inbox_id', je.inbox_id)
  FROM journal_entry je
  LEFT JOIN actor act ON act.id = je.actor_id

-- ---- provider callbacks: the fourth kind of actor ----------------------
--
-- ONLY the columns `webhook_inbox_guard()` makes immutable are projected.
-- `state`, `attempts`, `processed_at` and the park fields are live
-- processing state that `corgi_app` can UPDATE, so they are not evidence
-- and they are not here.  Attribution is by the first ledger entry or
-- card event that cites the inbox row -- a callback nothing has consumed
-- yet attributes to no business and shows as book-wide.
UNION ALL
SELECT 'webhook_inbox',
       'webhook_inbox:' || w.id::text,
       COALESCE(
         (SELECT a2.business_id FROM journal_entry je2
            JOIN journal_line jl2 ON jl2.entry_id = je2.id
            JOIN account a2 ON a2.id = jl2.account_id
           WHERE je2.inbox_id = w.id AND a2.business_id IS NOT NULL
           ORDER BY je2.booking_seq, jl2.ordinal LIMIT 1),
         (SELECT a3.business_id FROM card_auth_event ce
            JOIN card_authorization ca3 ON ca3.id = ce.auth_id
            JOIN account a3 ON a3.id = ca3.account_id
           WHERE ce.inbox_id = w.id LIMIT 1)),
       w.received_at, w.received_at, w.received_at::date,
       'provider', NULL::uuid, w.provider,
       'webhooks', 'webhook.received',
       w.provider || ' → ' || COALESCE(w.event_type, 'event')
         || CASE WHEN w.signature_verified_at IS NULL
                 THEN ' — SIGNATURE NOT VERIFIED' ELSE ' — signature verified' END,
       NULL::bigint,
       'webhook_inbox', w.id::text, NULL::uuid,
       jsonb_build_object('provider', w.provider, 'provider_event_id', w.provider_event_id,
                          'event_type', w.event_type,
                          'signature_verified_at', w.signature_verified_at)
  FROM webhook_inbox w

-- ---- book-wide operator actions ----------------------------------------
UNION ALL
SELECT 'book_day',
       'book_day:' || bd.entity_id::text || ':' || bd.business_date::text,
       NULL::uuid,
       (bd.business_date::timestamptz), bd.closed_at, bd.business_date,
       COALESCE(act.kind::text, 'unattributed'), bd.closed_by,
       COALESCE(act.display_name, 'not recorded'),
       'book', 'book.day_closed',
       'Business day ' || bd.business_date::text || ' closed at watermark '
         || bd.booking_watermark::text,
       NULL::bigint,
       'book_day', bd.business_date::text, NULL::uuid,
       jsonb_build_object('entity_id', bd.entity_id, 'booking_watermark', bd.booking_watermark)
  FROM book_day bd
  LEFT JOIN actor act ON act.id = bd.closed_by

UNION ALL
SELECT 'recon_run',
       'recon_run:' || rr.id::text,
       NULL::uuid,
       (rr.business_date::timestamptz), rr.started_at, rr.business_date,
       COALESCE(act.kind::text, 'unattributed'), rr.run_by,
       COALESCE(act.display_name, 'not recorded'),
       'recon', 'recon.run',
       'Reconciliation run #' || rr.run_no::text || ' for ' || rr.business_date::text
         || ' — ' || rr.matched_count::text || ' matched, ' || rr.break_count::text || ' breaks',
       rr.break_total_cents,
       'recon_run', rr.id::text, NULL::uuid,
       jsonb_build_object('run_no', rr.run_no, 'booking_watermark', rr.booking_watermark,
                          'matched_count', rr.matched_count, 'break_count', rr.break_count,
                          'file_id', rr.file_id)
  FROM recon_run rr
  LEFT JOIN actor act ON act.id = rr.run_by

UNION ALL
SELECT 'scheme_file',
       'scheme_file:' || sf.id::text,
       NULL::uuid,
       (sf.business_date::timestamptz), sf.imported_at, sf.business_date,
       COALESCE(act.kind::text, 'unattributed'), sf.imported_by,
       COALESCE(act.display_name, 'not recorded'),
       'recon', 'recon.file_imported',
       'Scheme file ' || sf.filename || ' imported (' || sf.row_count::text || ' rows)',
       sf.total_cents,
       'scheme_file', sf.id::text, NULL::uuid,
       jsonb_build_object('provider', sf.provider, 'rail', sf.rail, 'filename', sf.filename,
                          'row_count', sf.row_count, 'sha256', encode(sf.sha256, 'hex'))
  FROM scheme_file sf
  LEFT JOIN actor act ON act.id = sf.imported_by

UNION ALL
SELECT 'recon_break_note',
       'recon_break_note:' || bn.id::text,
       NULL::uuid,
       bn.created_at, bn.created_at, bn.created_at::date,
       COALESCE(act.kind::text, 'unattributed'), bn.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'recon', 'recon.break_noted',
       'Break ' || bn.break_kind || ' — ' || COALESCE(bn.resolution, 'noted') || ': ' || bn.note,
       NULL::bigint,
       'recon_break', bn.break_key, bn.adjusting_entry_id,
       jsonb_build_object('break_kind', bn.break_kind, 'break_key', bn.break_key,
                          'resolution', bn.resolution, 'note', bn.note)
  FROM recon_break_note bn
  LEFT JOIN actor act ON act.id = bn.created_by

UNION ALL
SELECT 'chaos_event',
       'chaos_event:' || ce.id::text,
       (SELECT cr.business_id FROM chaos_run cr WHERE cr.id = ce.run_id),
       ce.at, ce.at, ce.at::date,
       'system', NULL::uuid, COALESCE(ce.actor, 'not recorded'),
       'chaos', 'chaos.' || ce.kind,
       'Chaos ' || ce.kind || COALESCE(' — ' || ce.control, '')
         || COALESCE(': ' || ce.detail, ''),
       NULL::bigint,
       'chaos_run', ce.run_id::text, NULL::uuid,
       jsonb_build_object('kind', ce.kind, 'control', ce.control, 'detail', ce.detail)
  FROM chaos_event ce

UNION ALL
SELECT 'interest_rate_policy',
       'interest_rate_policy:' || rp.id::text,
       NULL::uuid,
       (rp.effective_from::timestamptz), rp.created_at, rp.effective_from,
       COALESCE(act.kind::text, 'unattributed'), rp.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'policy', 'policy.interest_rate',
       'Interest rate card for tier ' || rp.tier || ' effective ' || rp.effective_from::text
         || ' — credit ' || rp.credit_rate_bps::text || 'bps, overdraft '
         || rp.overdraft_rate_bps::text || 'bps',
       NULL::bigint,
       'interest_rate_policy', rp.id::text, NULL::uuid,
       jsonb_build_object('tier', rp.tier, 'credit_rate_bps', rp.credit_rate_bps,
                          'overdraft_rate_bps', rp.overdraft_rate_bps,
                          'day_count_denominator', rp.day_count_denominator, 'note', rp.note)
  FROM interest_rate_policy rp
  LEFT JOIN actor act ON act.id = rp.created_by

UNION ALL
SELECT 'interchange_rate_policy',
       'interchange_rate_policy:' || cp.id::text,
       NULL::uuid,
       (cp.effective_from::timestamptz), cp.created_at, cp.effective_from,
       COALESCE(act.kind::text, 'unattributed'), cp.created_by,
       COALESCE(act.display_name, 'not recorded'),
       'policy', 'policy.interchange_rate',
       'Interchange rate card for ' || cp.category || '/' || cp.presentment::text
         || ' effective ' || cp.effective_from::text
         || ' — ' || cp.rate_bps::text || 'bps + ' || cp.fixed_cents::text || 'c',
       NULL::bigint,
       'interchange_rate_policy', cp.id::text, NULL::uuid,
       jsonb_build_object('category', cp.category, 'presentment', cp.presentment,
                          'rate_bps', cp.rate_bps, 'fixed_cents', cp.fixed_cents, 'note', cp.note)
  FROM interchange_rate_policy cp
  LEFT JOIN actor act ON act.id = cp.created_by

-- ---- the agent surface, once it is wired --------------------------------
UNION ALL
SELECT 'mcp_audit',
       'mcp_audit:' || ma.id::text,
       ma.business_id,
       ma.at, ma.at, ma.at::date,
       COALESCE(act.kind::text, 'agent'), ma.actor_id,
       COALESCE(act.display_name, COALESCE(ma.grant_label, 'agent token')),
       'agent', 'agent.' || COALESCE(ma.tool, ma.method),
       'Agent ' || COALESCE(ma.tool, ma.method) || ' — ' || ma.outcome
         || COALESCE(' (' || ma.error_code || ')', ''),
       NULL::bigint,
       'mcp_call', ma.request_id, NULL::uuid,
       jsonb_build_object('method', ma.method, 'tool', ma.tool, 'outcome', ma.outcome,
                          'error_code', ma.error_code, 'grant_label', ma.grant_label,
                          'grant_fp', ma.grant_fp, 'duration_ms', ma.duration_ms,
                          'arguments', ma.arguments, 'result', ma.result)
  FROM mcp_audit ma
  LEFT JOIN actor act ON act.id = ma.actor_id;

GRANT SELECT ON v_actor_action TO corgi_app;

-- The trail with its derived flags.  Kept separate from the UNION so the
-- flags are defined once rather than in forty branches.
CREATE OR REPLACE VIEW v_business_timeline AS
SELECT t.*,
       (t.actor_kind <> 'human')                                       AS autonomous,
       (t.actor_kind = 'agent')                                        AS by_agent,
       (t.actor_kind = 'unattributed')                                 AS unattributed,
       (date_trunc('second', t.occurred_at)
          IS DISTINCT FROM date_trunc('second', t.recorded_at))        AS time_axes_differ,
       GREATEST(t.occurred_at, t.recorded_at)                          AS sort_at
  FROM v_actor_action t;

GRANT SELECT ON v_business_timeline TO corgi_app;

-- ---------------------------------------------------------------------
-- §6.  COMPLETENESS, MEASURED
-- ---------------------------------------------------------------------
--
-- `stored_rows` counts the source table directly, with no join and no
-- predicate.  `projected_rows` counts what came out of §5.  They must be
-- equal, for every source, and if they are not then a join in §5 dropped
-- a row -- which is precisely the failure mode of a read-based trail and
-- the only one it has.
--
-- The counts are computed independently ON PURPOSE.  Deriving
-- `stored_rows` from the projection would make the check tautological,
-- which is the same defect as a guard that cannot fail: it would read
-- green because it is the same number twice.

CREATE OR REPLACE VIEW v_audit_source_count AS
SELECT 'account_opening'::text AS source, count(*)::bigint AS stored_rows FROM account_opening
UNION ALL SELECT 'kyb_verification_leg',      count(*) FROM kyb_verification_leg
UNION ALL SELECT 'payment_instruction_event', count(*) FROM payment_instruction_event
UNION ALL SELECT 'standing_order',            count(*) FROM standing_order
UNION ALL SELECT 'standing_order_cancellation', count(*) FROM standing_order_cancellation
UNION ALL SELECT 'standing_order_occurrence',  count(*) FROM standing_order_occurrence
UNION ALL SELECT 'card',                      count(*) FROM card
UNION ALL SELECT 'card_control_version',      count(*) FROM card_control_version
UNION ALL SELECT 'card_auth_decision',        count(*) FROM card_auth_decision
UNION ALL SELECT 'card_auth_event',           count(*) FROM card_auth_event
UNION ALL SELECT 'hold_closure',              count(*) FROM hold_closure
UNION ALL SELECT 'hold_closure_reversal',     count(*) FROM hold_closure_reversal
UNION ALL SELECT 'dispute_event',             count(*) FROM dispute_event
UNION ALL SELECT 'fx_quote',                  count(*) FROM fx_quote
UNION ALL SELECT 'fx_quote_acceptance',       count(*) FROM fx_quote_acceptance
UNION ALL SELECT 'fx_quote_settlement',       count(*) FROM fx_quote_settlement
UNION ALL SELECT 'payee',                     count(*) FROM payee
UNION ALL SELECT 'payee_verification',        count(*) FROM payee_verification
UNION ALL SELECT 'payee_acknowledgement',     count(*) FROM payee_acknowledgement
UNION ALL SELECT 'payee_archival',            count(*) FROM payee_archival
UNION ALL SELECT 'payee_candidate_refusal',   count(*) FROM payee_candidate_refusal
UNION ALL SELECT 'pot',                       count(*) FROM pot
UNION ALL SELECT 'statement',                 count(*) FROM statement
UNION ALL SELECT 'interest_schedule',         count(*) FROM interest_schedule
UNION ALL SELECT 'interest_day',              count(*) FROM interest_day
UNION ALL SELECT 'accrual_schedule',          count(*) FROM accrual_schedule
UNION ALL SELECT 'accrual_day',               count(*) FROM accrual_day
UNION ALL SELECT 'interchange_posting',       count(*) FROM interchange_posting
UNION ALL SELECT 'interchange_reversal',      count(*) FROM interchange_reversal
UNION ALL SELECT 'journal_entry',             count(*) FROM journal_entry
UNION ALL SELECT 'webhook_inbox',             count(*) FROM webhook_inbox
UNION ALL SELECT 'book_day',                  count(*) FROM book_day
UNION ALL SELECT 'recon_run',                 count(*) FROM recon_run
UNION ALL SELECT 'scheme_file',               count(*) FROM scheme_file
UNION ALL SELECT 'recon_break_note',          count(*) FROM recon_break_note
UNION ALL SELECT 'chaos_event',               count(*) FROM chaos_event
UNION ALL SELECT 'interest_rate_policy',      count(*) FROM interest_rate_policy
UNION ALL SELECT 'interchange_rate_policy',   count(*) FROM interchange_rate_policy
UNION ALL SELECT 'mcp_audit',                 count(*) FROM mcp_audit;

GRANT SELECT ON v_audit_source_count TO corgi_app;

CREATE OR REPLACE VIEW v_audit_coverage AS
WITH projected AS (
  SELECT source,
         count(*)::bigint                                        AS projected_rows,
         count(*) FILTER (WHERE business_id IS NOT NULL)::bigint  AS attributed_rows,
         min(recorded_at)                                        AS first_at,
         max(recorded_at)                                        AS last_at
    FROM v_actor_action GROUP BY source
)
SELECT s.table_name                        AS source,
       s.disposition,
       s.surface,
       COALESCE(c.stored_rows, 0)          AS stored_rows,
       COALESCE(p.projected_rows, 0)       AS projected_rows,
       COALESCE(p.attributed_rows, 0)      AS attributed_rows,
       COALESCE(c.stored_rows, 0) - COALESCE(p.projected_rows, 0) AS dropped_rows,
       p.first_at,
       p.last_at,
       s.reason
  FROM v_audit_source s
  LEFT JOIN v_audit_source_count c ON c.source = s.table_name
  LEFT JOIN projected p            ON p.source = s.table_name
 WHERE s.disposition IN ('projected', 'awaiting_wiring');

GRANT SELECT ON v_audit_coverage TO corgi_app;

-- MUST RETURN ZERO ROWS.  A projected source whose §5 branch dropped a
-- row, in either direction.  Nothing repairs what it reports: it means
-- an action exists in a store and not on the timeline.
CREATE OR REPLACE VIEW v_audit_coverage_drift AS
SELECT source, disposition, stored_rows, projected_rows, dropped_rows
  FROM v_audit_coverage
 WHERE stored_rows <> projected_rows;

GRANT SELECT ON v_audit_coverage_drift TO corgi_app;

-- ---------------------------------------------------------------------
-- §7.  THE TWO INVARIANTS THAT MAKE "COMPLETE" MEAN SOMETHING
-- ---------------------------------------------------------------------
--
-- MUST RETURN ZERO ROWS.  A base table nobody has classified.  This is
-- the check a write-path trail cannot have: there is no catalog of call
-- sites, but there IS a catalog of tables.  A migration that adds an
-- action store and does not append to `audit_source` turns this
-- non-empty, and the audit screen prints it in red on its face.
--
-- The detector is deliberately the WIDEST possible one -- every base
-- table, no LIKE, no column-shape heuristic, no "looks like an event"
-- pattern -- because a narrower detector can be fooled by a store shaped
-- exactly like the thing it would skip, which is how seventeen guards in
-- this repository have failed.  Over-reporting costs one row of typing;
-- under-reporting costs an audit.
CREATE OR REPLACE VIEW v_audit_source_unclaimed AS
SELECT t.table_name
  FROM information_schema.tables t
  LEFT JOIN v_audit_source s ON s.table_name = t.table_name
 WHERE t.table_schema = 'public'
   AND t.table_type   = 'BASE TABLE'
   AND s.table_name IS NULL;

GRANT SELECT ON v_audit_source_unclaimed TO corgi_app;

-- MUST RETURN ZERO ROWS.  A projected source the application role can
-- UPDATE or DELETE.  Evidence the app can rewrite is not evidence, so
-- such a source must be excluded from the trail rather than shown on it.
--
-- `webhook_inbox` holds UPDATE and is still projected: its trigger
-- `webhook_inbox_guard()` refuses DELETE outright and refuses any change
-- to provider, provider_event_id, payload, event_type, received_at,
-- raw_body, headers or signature_verified_at -- which is exactly and
-- only the set of columns §5 projects.  The carve-out is therefore a
-- NAMED TABLE WITH A NAMED GUARD, not a privilege pattern: any other
-- table that acquires UPDATE still fails this check.
CREATE OR REPLACE VIEW v_audit_source_mutable AS
SELECT s.table_name,
       string_agg(DISTINCT g.privilege_type, ',' ORDER BY g.privilege_type) AS privileges
  FROM v_audit_source s
  JOIN information_schema.role_table_grants g
    ON g.table_name = s.table_name
   AND g.table_schema = 'public'
   AND g.grantee = 'corgi_app'
   AND g.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE')
 WHERE s.disposition = 'projected'
   AND s.table_name <> 'webhook_inbox'
 GROUP BY s.table_name;

GRANT SELECT ON v_audit_source_mutable TO corgi_app;

-- NOT an invariant: a report.  A projected source whose append-only
-- guarantee rests on privileges alone, with no BEFORE UPDATE OR DELETE
-- trigger -- so the OWNER could still rewrite it.  Every money table has
-- both.  Printed on the audit screen rather than asserted empty, because
-- it is a statement about the strength of the evidence and the honest
-- answer today is "one source is weaker than the rest".
CREATE OR REPLACE VIEW v_audit_source_weak AS
SELECT s.table_name, s.surface
  FROM v_audit_source s
 WHERE s.disposition = 'projected'
   AND NOT EXISTS (
     SELECT 1 FROM pg_trigger tg
       JOIN pg_class c ON c.oid = tg.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = s.table_name
        AND NOT tg.tgisinternal
        AND tg.tgtype & 24 <> 0            -- bits 8|16: fires on DELETE or UPDATE
        AND (tg.tgname LIKE '%no_update_delete%' OR tg.tgname LIKE '%immutable%'));

GRANT SELECT ON v_audit_source_weak TO corgi_app;
