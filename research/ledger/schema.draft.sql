-- =====================================================================
-- Corgi work trial - Track 3 - ledger schema (draft)
-- Postgres 15+ (Neon).  Reasoning lives in DESIGN.md; this file carries
-- the mechanics and a comment on every non-obvious line.
--
-- Conventions used throughout:
--   * All money is bigint CENTS.  No float, no numeric, anywhere on a
--     stored money column.
--   * amount_cents is SIGNED: a DEBIT is positive, a CREDIT is negative.
--     "The entry balances" is therefore SUM(amount_cents) = 0 and "the
--     account balance" is SUM(amount_cents) * normal_side.  One column,
--     two invariants, no CASE in any hot query.
--   * value_date  = when it happened in the business (date, book tz).
--     booking_seq = when we learned it (bigint, total order = commit order).
--   * Money tables are append-only.  Immutability is enforced by
--     privileges FIRST and triggers SECOND (defence in depth).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- digest() for the hash chain

-- The book timezone.  A US business bank settles on Fed/ACH calendars,
-- which are Eastern; day boundaries anywhere else disagree with the rails.
-- Used only to derive a value_date from an instant - value_date itself is
-- a plain date and never carries a zone.
CREATE OR REPLACE FUNCTION book_tz() RETURNS text
  LANGUAGE sql IMMUTABLE AS $$ SELECT 'America/New_York'::text $$;

CREATE OR REPLACE FUNCTION book_date(ts timestamptz) RETURNS date
  LANGUAGE sql STABLE AS $$ SELECT (ts AT TIME ZONE book_tz())::date $$;

-- ---------------------------------------------------------------------
-- 1.  Enumerations
-- ---------------------------------------------------------------------

CREATE TYPE account_type   AS ENUM ('asset','liability','equity','income','expense');
CREATE TYPE account_book   AS ENUM ('financial','memo');
CREATE TYPE entry_type     AS ENUM ('original','reversal','rebook');
CREATE TYPE actor_kind     AS ENUM ('human','agent','system');
CREATE TYPE hold_kind      AS ENUM ('card_auth','uncleared_credit','manual');
CREATE TYPE rail           AS ENUM ('card','ach','usdc','wire','internal');
CREATE TYPE event_semantics AS ENUM ('new_event','correction');

-- Card lifecycle vocabulary, canonical (NOT Lithic's vocabulary - the
-- adapter maps into this).  force_post is a clearing that never had an
-- authorisation; close is the network telling us the auth is finished.
CREATE TYPE card_event_kind AS ENUM (
  'authorization',
  'incremental_authorization',
  'authorization_reversal',
  'clearing',
  'force_post',
  'refund',
  'expiry',
  'close'
);

CREATE TYPE payment_event_kind AS ENUM (
  'requested','approved','rejected','submitted','settled','returned','cancelled'
);

-- ---------------------------------------------------------------------
-- 2.  Principals and tenants
-- ---------------------------------------------------------------------

-- A legal entity that owns a chart of accounts.  Entries may never cross
-- entities; inter-entity flow is two entries against a due-to/due-from
-- pair.  One column now, and the model survives a holdco with a banking
-- leg and an insurance leg sharing this spine.
CREATE TABLE book_entity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id     uuid NOT NULL REFERENCES book_entity(id),
  legal_name    text NOT NULL,
  ein           text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Every write to the ledger is attributed to an actor.  kind is the whole
-- maker-checker story: an agent or a system principal CANNOT be an
-- approver, and that is a table constraint rather than a code path, so it
-- holds against code nobody has written yet.
CREATE TABLE actor (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         actor_kind NOT NULL,
  display_name text NOT NULL,
  email        text,
  business_id  uuid REFERENCES business(id),      -- null for Corgi staff/system
  can_approve  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- The one line that makes "the agent approved its own payment" unrepresentable.
  CONSTRAINT actor_only_humans_approve CHECK (NOT (kind <> 'human' AND can_approve))
);

-- ---------------------------------------------------------------------
-- 3.  Chart of accounts
-- ---------------------------------------------------------------------

CREATE TABLE account (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    uuid NOT NULL REFERENCES book_entity(id),
  code         text NOT NULL,                    -- '2100', '9100', ...
  name         text NOT NULL,
  parent_id    uuid REFERENCES account(id),      -- tree; only leaves are postable
  type         account_type NOT NULL,
  book         account_book NOT NULL DEFAULT 'financial',
  currency     char(3) NOT NULL DEFAULT 'USD',
  business_id  uuid REFERENCES business(id),     -- null for house accounts
  is_postable  boolean NOT NULL DEFAULT true,    -- rollup nodes are false
  -- +1 for debit-normal (asset, expense), -1 for credit-normal
  -- (liability, equity, income).  A customer's deposit is a LIABILITY of
  -- the bank, so it is credit-normal: the customer having money is us
  -- owing money.  Balance queries multiply by this and never branch.
  normal_side  smallint GENERATED ALWAYS AS
                 ((CASE WHEN type IN ('asset','expense') THEN 1 ELSE -1 END)::smallint) STORED,
  opened_at    timestamptz NOT NULL DEFAULT now(),
  closed_at    timestamptz,
  -- NULLS NOT DISTINCT (PG15+) so two house accounts cannot share a code:
  -- with default NULLS DISTINCT, (code,'2200',NULL) would be allowed twice.
  CONSTRAINT account_code_scope UNIQUE NULLS NOT DISTINCT (entity_id, code, business_id)
);

CREATE INDEX account_business_idx ON account (business_id) WHERE business_id IS NOT NULL;
CREATE INDEX account_parent_idx   ON account (parent_id);

-- ---------------------------------------------------------------------
-- 4.  Webhook inbox - replay dies here, at the database
-- ---------------------------------------------------------------------

-- NOT a money table.  It records what a third party told us (immutable)
-- plus our processing state (allowed to advance in one direction only).
CREATE TABLE webhook_inbox (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider           text NOT NULL,              -- 'lithic','increase','plaid','base'
  provider_event_id  text NOT NULL,              -- the provider's own event id
  event_type         text NOT NULL,              -- provider vocabulary, verbatim
  payload            jsonb NOT NULL,             -- raw body, exactly as received
  signature_verified boolean NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,                -- NULL -> once, never back
  processing_error   text,
  attempts           integer NOT NULL DEFAULT 0,
  -- THE replay guard.  The HTTP handler does INSERT ... ON CONFLICT DO
  -- NOTHING and returns 200 either way, so a redelivery is decided by
  -- this index before any business logic runs.  Twice is one.
  CONSTRAINT webhook_inbox_replay_key UNIQUE (provider, provider_event_id)
);

CREATE INDEX webhook_inbox_unprocessed_idx
  ON webhook_inbox (received_at) WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------
-- 5.  Funds-availability policy (versioned data, not code)
-- ---------------------------------------------------------------------

-- Every uncleared-credit hold records which policy row created it, so a
-- hold opened in March is still explainable in December after the policy
-- changed.  Append-only and effective-dated: policy is a fact with a
-- lifespan, which is why it gets effective dating and money rows do not.
CREATE TABLE funds_availability_policy (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rail               rail NOT NULL,
  counterparty_class text NOT NULL,              -- 'known','new','self','n/a'
  effective_from     date NOT NULL,
  banking_days_hold  integer NOT NULL CHECK (banking_days_hold >= 0),
  release_local_time time NOT NULL DEFAULT '09:00',
  confirmations      integer,                    -- USDC only
  note               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fap_version UNIQUE (rail, counterparty_class, effective_from)
);

-- ---------------------------------------------------------------------
-- 6.  Holds  (identity only - the balance is a SUM over memo postings)
-- ---------------------------------------------------------------------

CREATE TABLE hold (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES account(id),  -- customer deposit acct
  memo_account_id  uuid NOT NULL REFERENCES account(id),  -- 9100/9200 for that customer
  kind             hold_kind NOT NULL,
  external_ref     text NOT NULL,                -- provider auth id / transfer id
  value_date       date NOT NULL,
  expires_at       timestamptz,                  -- card auth expiry (clock release)
  available_at     timestamptz,                  -- uncleared credit release moment
  policy_id        uuid REFERENCES funds_availability_policy(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hold_ref UNIQUE (kind, external_ref),
  -- a card hold has an expiry, an uncleared-credit hold has an availability
  CONSTRAINT hold_clock CHECK (
    (kind = 'card_auth'        AND expires_at   IS NOT NULL) OR
    (kind = 'uncleared_credit' AND available_at IS NOT NULL) OR
    (kind = 'manual')
  )
);

-- Explicit, one-shot closure: an ACH credit that was returned, a manual
-- release, an ops decision.  UNIQUE(hold_id) makes closure exactly once
-- by construction - there is no second row to write.
CREATE TABLE hold_closure (
  hold_id     uuid PRIMARY KEY REFERENCES hold(id),
  reason      text NOT NULL,
  actor_id    uuid NOT NULL REFERENCES actor(id),
  closed_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7.  THE JOURNAL
-- ---------------------------------------------------------------------

-- booking_seq is drawn from this sequence while holding the ledger append
-- advisory lock, so sequence order == commit order.  Without the lock a
-- lower seq could commit after a higher one, and an "as of seq N" query
-- could gain rows below N later - which would destroy reproducibility.
CREATE SEQUENCE journal_booking_seq AS bigint START 1;

CREATE TABLE journal_entry (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ---- the two clocks -------------------------------------------------
  value_date          date NOT NULL,             -- WHEN IT HAPPENED (business)
  booking_seq         bigint NOT NULL UNIQUE,    -- WHEN WE LEARNED IT (total order)
  booking_time        timestamptz NOT NULL,      -- same axis, human readable, monotonic

  entity_id           uuid NOT NULL REFERENCES book_entity(id),
  book                account_book NOT NULL,     -- all lines must match (trigger)
  entry_type          entry_type NOT NULL DEFAULT 'original',

  -- ---- correction lineage --------------------------------------------
  reverses_entry_id   uuid REFERENCES journal_entry(id),
  correction_group_id uuid,                      -- original + reversal + rebook

  -- ---- provenance -----------------------------------------------------
  description         text NOT NULL,
  rail                rail,
  external_ref        text,                      -- provider's domain id
  inbox_id            uuid REFERENCES webhook_inbox(id),
  hold_id             uuid REFERENCES hold(id),  -- set on memo entries
  actor_id            uuid NOT NULL REFERENCES actor(id),

  -- ---- idempotency ----------------------------------------------------
  -- Derived from the source fact, NEVER from a UUID we generate:
  --   'card:clearing:<provider_event_id>'
  --   'hold:<hold_id>:after:<provider_event_id>'
  --   'ach:return:<transfer_id>:<trace_number>'
  -- Last line of defence: even if the inbox and the event-stream unique
  -- keys were both bypassed, the money cannot be written twice.
  idempotency_key     text NOT NULL UNIQUE,

  -- ---- tamper evidence ------------------------------------------------
  prev_hash           bytea NOT NULL,            -- 32 zero bytes for the genesis row
  hash                bytea NOT NULL UNIQUE,

  CONSTRAINT je_reversal_shape CHECK ((entry_type = 'reversal') = (reverses_entry_id IS NOT NULL)),
  CONSTRAINT je_memo_has_hold  CHECK (book = 'financial' OR hold_id IS NOT NULL),
  CONSTRAINT je_hash_len       CHECK (octet_length(hash) = 32 AND octet_length(prev_hash) = 32)
);

-- An entry may be reversed AT MOST ONCE.  A double-fire of the correction
-- path cannot double-credit.  Partial index because most entries are not
-- reversals and the column is null for them.
CREATE UNIQUE INDEX journal_entry_one_reversal_idx
  ON journal_entry (reverses_entry_id) WHERE reverses_entry_id IS NOT NULL;

CREATE INDEX journal_entry_value_date_idx  ON journal_entry (value_date, booking_seq);
CREATE INDEX journal_entry_booking_time_idx ON journal_entry (booking_time);
CREATE INDEX journal_entry_external_ref_idx ON journal_entry (rail, external_ref)
  WHERE external_ref IS NOT NULL;
CREATE INDEX journal_entry_hold_idx        ON journal_entry (hold_id) WHERE hold_id IS NOT NULL;
CREATE INDEX journal_entry_group_idx       ON journal_entry (correction_group_id)
  WHERE correction_group_id IS NOT NULL;

CREATE TABLE journal_line (
  entry_id     uuid NOT NULL REFERENCES journal_entry(id),
  ordinal      smallint NOT NULL,                -- fixed by the posting template;
                                                 -- also the deterministic tie-break
                                                 -- for the residual penny (DESIGN 12)
  account_id   uuid NOT NULL REFERENCES account(id),
  -- DEBIT positive, CREDIT negative.  Zero is meaningless and forbidden -
  -- a zero line is always a bug in an allocation.
  amount_cents bigint NOT NULL CHECK (amount_cents <> 0),
  currency     char(3) NOT NULL DEFAULT 'USD',
  memo         text,

  -- Denormalised copies of the entry's two clocks.  Normally a hazard;
  -- safe here because the source row is immutable, so the copy can never
  -- go stale - there is no update path that could change one and not the
  -- other.  Written only by ledger_append(); proved by v_line_denorm_drift.
  -- Buys a single-table index-only scan for every balance query.
  value_date   date NOT NULL,
  booking_seq  bigint NOT NULL,

  PRIMARY KEY (entry_id, ordinal)
);

-- The hot path: "sum one account's lines up to a value date and a booking
-- watermark".  Covering index -> index-only scan, no heap, no join.
CREATE INDEX journal_line_balance_idx
  ON journal_line (account_id, value_date, booking_seq) INCLUDE (amount_cents);

-- The bitemporal-proof path: "as we believed at seq N", any value date.
CREATE INDEX journal_line_booking_idx
  ON journal_line (account_id, booking_seq) INCLUDE (amount_cents, value_date);

-- ---------------------------------------------------------------------
-- 8.  Balanced-entry enforcement
-- ---------------------------------------------------------------------

-- Deferred to COMMIT because lines are inserted one at a time and the
-- entry is only balanced once they all are.  A plain CHECK cannot express
-- a cross-row invariant; a non-deferred trigger would fire after the first
-- line and always fail.  This is the standard shape and there is no
-- cleverer one.
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_bad_currency  char(3);
  v_sum           bigint;
  v_line_count    integer;
  v_entry_book    account_book;
  v_mixed_books   integer;
BEGIN
  -- 1. every currency in the entry must net to exactly zero
  SELECT l.currency, SUM(l.amount_cents)
    INTO v_bad_currency, v_sum
    FROM journal_line l
   WHERE l.entry_id = NEW.entry_id
   GROUP BY l.currency
  HAVING SUM(l.amount_cents) <> 0
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'unbalanced journal entry %: currency % sums to % cents, must be 0',
      NEW.entry_id, v_bad_currency, v_sum
      USING ERRCODE = '23514';
  END IF;

  -- 2. at least two lines: a one-line "entry" is not double entry
  SELECT count(*) INTO v_line_count FROM journal_line WHERE entry_id = NEW.entry_id;
  IF v_line_count < 2 THEN
    RAISE EXCEPTION 'journal entry % has % line(s); double entry needs >= 2',
      NEW.entry_id, v_line_count USING ERRCODE = '23514';
  END IF;

  -- 3. no entry may mix the financial and memo books, and no entry may
  --    cross legal entities.  Both keep each book independently balanced.
  SELECT e.book INTO v_entry_book FROM journal_entry e WHERE e.id = NEW.entry_id;

  SELECT count(*) INTO v_mixed_books
    FROM journal_line l
    JOIN account a ON a.id = l.account_id
    JOIN journal_entry e ON e.id = l.entry_id
   WHERE l.entry_id = NEW.entry_id
     AND (a.book <> v_entry_book OR a.entity_id <> e.entity_id
          OR a.is_postable = false OR a.currency <> l.currency);

  IF v_mixed_books > 0 THEN
    RAISE EXCEPTION
      'journal entry % has lines in the wrong book/entity/currency, or posts to a rollup account',
      NEW.entry_id USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_line_balanced
  AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();

-- And the mirror case: an entry with NO lines at all would never fire the
-- trigger above, so check from the entry side too.
CREATE OR REPLACE FUNCTION assert_entry_has_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM journal_line WHERE entry_id = NEW.id;
  IF n = 0 THEN
    RAISE EXCEPTION 'journal entry % committed with no lines', NEW.id
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entry_has_lines
  AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_has_lines();

-- A reversal must be the exact arithmetic negation of what it reverses,
-- and must carry the ORIGINAL's value date - that is the entire bitemporal
-- correction requirement, enforced rather than documented.
CREATE OR REPLACE FUNCTION assert_reversal_is_exact() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_orig  journal_entry%ROWTYPE;
  v_delta bigint;
BEGIN
  IF NEW.entry_type <> 'reversal' THEN RETURN NULL; END IF;

  SELECT * INTO v_orig FROM journal_entry WHERE id = NEW.reverses_entry_id;

  IF v_orig.entry_type = 'reversal' THEN
    RAISE EXCEPTION 'entry % may not reverse a reversal; re-book instead', NEW.id
      USING ERRCODE = '23514';
  END IF;

  IF v_orig.value_date <> NEW.value_date THEN
    RAISE EXCEPTION
      'reversal % must carry the original value_date % (got %): a correction fixes the day it happened',
      NEW.id, v_orig.value_date, NEW.value_date USING ERRCODE = '23514';
  END IF;

  -- lines must cancel account-by-account
  SELECT COALESCE(SUM(amt),0) INTO v_delta FROM (
    SELECT account_id, currency, SUM(amount_cents) AS amt
      FROM journal_line WHERE entry_id IN (NEW.id, v_orig.id)
     GROUP BY account_id, currency
  ) s WHERE amt <> 0;

  IF v_delta <> 0 OR EXISTS (
    SELECT 1 FROM (
      SELECT account_id, currency, SUM(amount_cents) AS amt
        FROM journal_line WHERE entry_id IN (NEW.id, v_orig.id)
       GROUP BY account_id, currency
    ) s WHERE amt <> 0
  ) THEN
    RAISE EXCEPTION 'reversal % is not the exact negation of %', NEW.id, v_orig.id
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER journal_entry_reversal_exact
  AFTER INSERT ON journal_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_reversal_is_exact();

-- ---------------------------------------------------------------------
-- 9.  Card authorisation: immutable identity + append-only event stream
-- ---------------------------------------------------------------------

-- No status column, deliberately.  State is a fold over card_auth_event
-- (see v_card_auth_state), which is why a settlement arriving before its
-- own authorisation needs no special case: there is no order to be out of.
CREATE TABLE card_authorization (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_auth_id  text NOT NULL,
  card_id           uuid NOT NULL,
  account_id        uuid NOT NULL REFERENCES account(id),   -- customer deposit acct
  hold_id           uuid NOT NULL REFERENCES hold(id),
  -- how we FIRST heard of this auth.  'clearing_first' means the
  -- settlement beat the authorisation; 'force_post' means there never was
  -- one.  Recorded for reporting only - the maths does not branch on it.
  origin            text NOT NULL CHECK (origin IN ('authorization','clearing_first','force_post')),
  expires_at        timestamptz NOT NULL,   -- clock-based release, no cron needed
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_auth_provider_key UNIQUE (provider, provider_auth_id)
);

CREATE TABLE card_auth_event (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id           uuid NOT NULL REFERENCES card_authorization(id),
  kind              card_event_kind NOT NULL,
  amount_cents      bigint NOT NULL CHECK (amount_cents >= 0),  -- magnitude; kind carries direction
  is_final          boolean NOT NULL DEFAULT false,             -- network says no more captures
  value_date        date NOT NULL,          -- LOCAL TRANSACTION DATE, not settlement date
  provider_event_id text NOT NULL,
  inbox_id          uuid REFERENCES webhook_inbox(id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  -- Dedup at the domain level, not just the envelope level.  This is what
  -- makes the event stream a SET, which is what makes H(E) order-free.
  CONSTRAINT card_auth_event_dedup UNIQUE (auth_id, provider_event_id)
);

CREATE INDEX card_auth_event_auth_idx ON card_auth_event (auth_id);

-- ---------------------------------------------------------------------
-- 10.  Day close and statements
-- ---------------------------------------------------------------------

-- Closing a day pins a watermark.  It does NOT forbid later postings with
-- that value date: late and corrected entries are legal and expected, they
-- simply land above the watermark and show up in the next statement
-- version and in v_late_postings.
CREATE TABLE book_day (
  entity_id        uuid NOT NULL REFERENCES book_entity(id),
  business_date    date NOT NULL,
  closed_at        timestamptz NOT NULL DEFAULT now(),
  booking_watermark bigint NOT NULL,      -- max(booking_seq) at the moment of close
  closed_by        uuid NOT NULL REFERENCES actor(id),
  PRIMARY KEY (entity_id, business_date)
);

-- A statement is a (period, watermark) pair, not a period.  v1 of Tuesday
-- is frozen at Tuesday's close watermark and reproduces byte-identically
-- forever.  When Thursday's correction lands with Tuesday's value date we
-- issue Tuesday v2 at a later watermark and keep both - a corrected
-- statement is a new document with a version, never an edit.
CREATE TABLE statement (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES account(id),
  period_start          date NOT NULL,
  period_end            date NOT NULL,
  version               integer NOT NULL CHECK (version >= 1),
  booking_watermark     bigint NOT NULL,
  opening_balance_cents bigint NOT NULL,
  closing_balance_cents bigint NOT NULL,
  line_count            integer NOT NULL,
  content_hash          bytea NOT NULL,   -- sha256 over the canonical rendering
  generated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_version UNIQUE (account_id, period_start, period_end, version),
  CONSTRAINT statement_period  CHECK (period_end >= period_start),
  CONSTRAINT statement_hash_len CHECK (octet_length(content_hash) = 32)
);

-- ---------------------------------------------------------------------
-- 11.  Scheme-file reconciliation
-- ---------------------------------------------------------------------

CREATE TABLE scheme_file (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL,
  rail          rail NOT NULL,
  business_date date NOT NULL,
  filename      text NOT NULL,
  sha256        bytea NOT NULL,
  row_count     integer NOT NULL,
  total_cents   bigint NOT NULL,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  imported_by   uuid NOT NULL REFERENCES actor(id),
  -- Re-importing the identical file is a unique violation, i.e. a no-op.
  CONSTRAINT scheme_file_content UNIQUE (sha256)
);

CREATE TABLE scheme_file_row (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id       uuid NOT NULL REFERENCES scheme_file(id),
  row_no        integer NOT NULL,
  external_ref  text NOT NULL,          -- network reference / trace number
  amount_cents  bigint NOT NULL,        -- signed, from OUR point of view
  value_date    date NOT NULL,
  raw           jsonb NOT NULL,
  CONSTRAINT scheme_file_row_pos UNIQUE (file_id, row_no)
);

CREATE INDEX scheme_file_row_ref_idx ON scheme_file_row (external_ref);
CREATE INDEX scheme_file_row_date_idx ON scheme_file_row (value_date);

-- One file row matches at most one entry and vice versa; an amount
-- mismatch is still a match (matched by reference, disagreeing on money),
-- which is why both amounts are recorded here rather than inferred later.
CREATE TABLE recon_match (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_row_id        uuid NOT NULL UNIQUE REFERENCES scheme_file_row(id),
  entry_id           uuid NOT NULL UNIQUE REFERENCES journal_entry(id),
  file_amount_cents  bigint NOT NULL,
  ledger_amount_cents bigint NOT NULL,
  match_rule         text NOT NULL CHECK (match_rule IN ('exact_ref','ref_amount_mismatch','heuristic')),
  matched_at         timestamptz NOT NULL DEFAULT now(),
  matched_by         uuid NOT NULL REFERENCES actor(id)
);

-- Adjudication is append-only and points at the correcting entry, so a
-- resolved break keeps its history instead of vanishing from a screen.
CREATE TABLE recon_break_note (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  break_kind         text NOT NULL CHECK (break_kind IN ('in_file_not_ledger','in_ledger_not_file','amount_mismatch')),
  break_key          text NOT NULL,     -- file_row_id or entry_id, as text
  note               text NOT NULL,
  resolution         text CHECK (resolution IN ('corrected','accepted_timing','written_off','duplicate')),
  adjusting_entry_id uuid REFERENCES journal_entry(id),
  created_by         uuid NOT NULL REFERENCES actor(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 12.  Maker-checker on money out
-- ---------------------------------------------------------------------

CREATE TABLE approval_policy (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rail               rail NOT NULL,
  effective_from     date NOT NULL,
  threshold_cents    bigint NOT NULL CHECK (threshold_cents >= 0),
  required_approvals integer NOT NULL CHECK (required_approvals >= 0),
  note               text NOT NULL,
  CONSTRAINT approval_policy_version UNIQUE (rail, effective_from)
);

CREATE TABLE payment_instruction (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES account(id),
  rail            rail NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  currency        char(3) NOT NULL DEFAULT 'USD',
  counterparty    jsonb NOT NULL,
  value_date      date NOT NULL,
  requested_by    uuid NOT NULL REFERENCES actor(id),
  requested_at    timestamptz NOT NULL DEFAULT now(),
  policy_id       uuid NOT NULL REFERENCES approval_policy(id),
  idempotency_key text NOT NULL UNIQUE,
  -- sha256 over (account, rail, amount, counterparty, value_date).  An
  -- approval must cite this hash, so you cannot approve $100 and submit
  -- $10,000: changing any approved field means a new instruction row.
  content_hash    bytea NOT NULL CHECK (octet_length(content_hash) = 32)
);

CREATE TABLE payment_instruction_event (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instruction_id       uuid NOT NULL REFERENCES payment_instruction(id),
  kind                 payment_event_kind NOT NULL,
  actor_id             uuid NOT NULL REFERENCES actor(id),
  approved_content_hash bytea,
  reason               text,
  value_date           date NOT NULL,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  entry_id             uuid REFERENCES journal_entry(id),  -- set on submitted/settled/returned
  -- one actor, one decision: an approver cannot approve twice to satisfy
  -- a two-approver rule
  CONSTRAINT pie_one_decision_per_actor UNIQUE (instruction_id, kind, actor_id)
);

CREATE INDEX pie_instruction_idx ON payment_instruction_event (instruction_id);

CREATE OR REPLACE FUNCTION assert_maker_checker() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pi       payment_instruction%ROWTYPE;
  v_actor    actor%ROWTYPE;
  v_policy   approval_policy%ROWTYPE;
  v_approvals integer;
BEGIN
  SELECT * INTO v_pi    FROM payment_instruction WHERE id = NEW.instruction_id;
  SELECT * INTO v_actor FROM actor               WHERE id = NEW.actor_id;

  IF NEW.kind = 'approved' THEN
    -- (a) an automated surface can never approve.  Belt and braces on top
    --     of actor_only_humans_approve: the agent lands in the same queue
    --     as a person and is refused at the same place.
    IF v_actor.kind <> 'human' OR NOT v_actor.can_approve THEN
      RAISE EXCEPTION 'actor % (kind %) is not an approver', NEW.actor_id, v_actor.kind
        USING ERRCODE = '42501';
    END IF;

    -- (b) the initiator can never approve their own payment
    IF NEW.actor_id = v_pi.requested_by THEN
      RAISE EXCEPTION 'maker-checker: actor % initiated instruction % and cannot approve it',
        NEW.actor_id, NEW.instruction_id USING ERRCODE = '42501';
    END IF;

    -- (c) approve-the-hash
    IF NEW.approved_content_hash IS DISTINCT FROM v_pi.content_hash THEN
      RAISE EXCEPTION 'approval for % cites the wrong content hash', NEW.instruction_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF NEW.kind = 'submitted' THEN
    SELECT * INTO v_policy FROM approval_policy WHERE id = v_pi.policy_id;

    IF v_pi.amount_cents >= v_policy.threshold_cents THEN
      SELECT count(DISTINCT e.actor_id) INTO v_approvals
        FROM payment_instruction_event e
        JOIN actor a ON a.id = e.actor_id
       WHERE e.instruction_id = NEW.instruction_id
         AND e.kind = 'approved'
         AND a.kind = 'human'
         AND e.actor_id <> v_pi.requested_by;

      IF v_approvals < v_policy.required_approvals THEN
        RAISE EXCEPTION
          'instruction % needs % approval(s) above the % cent threshold, has %',
          NEW.instruction_id, v_policy.required_approvals,
          v_policy.threshold_cents, v_approvals
          USING ERRCODE = '42501';
      END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM payment_instruction_event
                WHERE instruction_id = NEW.instruction_id
                  AND kind IN ('rejected','cancelled')) THEN
      RAISE EXCEPTION 'instruction % was rejected or cancelled and cannot be submitted',
        NEW.instruction_id USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER payment_instruction_event_maker_checker
  BEFORE INSERT ON payment_instruction_event
  FOR EACH ROW EXECUTE FUNCTION assert_maker_checker();
