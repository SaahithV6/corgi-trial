-- =====================================================================
-- 0053  The hold an accepted FX quote should always have placed
-- =====================================================================
--
-- THE DEFECT, MEASURED ON THIS BOOK (2026-09-11, in a rolled-back
-- transaction, against the code as it stood before this file):
--
--   SUBJECT   Ridgeline Robotics, Inc.
--             2100 account   a0c41a37-2be1-5c30-bfe9-03455f048fac
--             ledger         $61,876.11
--             AVAILABLE      $35,514.93
--
--   QUOTE 1   FXQ-2896RMDZ  sell $21,308.95
--   QUOTE 2   FXQ-0BF9XKXM  sell $21,308.95
--   ACCEPT 1  ACCEPTED      ACCEPT 2  ACCEPTED
--   AFTER     available $35,514.93   holds $410.00      <- UNMOVED
--   GATE 1    CLEARS - $21,308.95 may leave
--   GATE 2    CLEARS - $21,308.95 may leave
--   TOTAL     $42,617.90 cleared against $35,514.93 available
--
-- Accepting a quote wrote a row in `fx_quote_acceptance` and reserved
-- NOTHING.  A customer could accept N commitments, every one of which
-- would later clear, and all N cleared against the same balance.  That
-- is an overdraft path with no guard on it, and docs/FX.md named it
-- twice - SS6 ("Also missing: the memo hold an acceptance should place")
-- and SS11.2 ("a customer can accept five quotes against one balance and
-- the gate will clear all five") - without closing it.
--
-- ---------------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO, AND THAT IS THE POINT
-- ---------------------------------------------------------------------
--
-- IT DOES NOT INVENT A RESERVATION.  This system already has a hold
-- model, it is a pure function of an event SET, and availability already
-- has exactly one definition - `ledger_availability()`, migration 0022,
-- five terms.  A second way to withhold money would be a SIXTH
-- definition of available balance, which is the defect 0022 exists to
-- have ended.  So an accepted commitment becomes an ordinary `hold` row
-- of kind `manual`, its memo posting goes through `ledger_append()` like
-- every other posting, and `ledger_availability()`'s existing hold term
-- picks it up with no change to how the term is computed.
--
-- The only thing this migration changes about availability is ONE
-- PREDICATE, in SS3, and it is provably a no-op on every row that exists
-- today.  Everything else here is new tables and a new guard.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  Where a commitment hold lives in the chart:  9300
-- ---------------------------------------------------------------------
--
-- docs/FX.md SS6 named this account before it existed:
--
--     9300  Holds - accepted FX commitments   (memo book)
--
-- It is a sibling of 9100 (card authorisations) and 9200 (uncleared
-- credits), credit-normal, in the memo book, with 9900 memo contra
-- taking the other side exactly as it does for the other two.  Mirrored
-- in `src/lib/ledger/chart.ts`, which is the source of truth the seeder
-- reads; this INSERT exists because the chart is seeded once and this
-- book is already seeded.
--
-- ---------------------------------------------------------------------
-- WHY IT IS A HOUSE ACCOUNT AND NOT ONE LEAF PER CUSTOMER
-- ---------------------------------------------------------------------
--
-- 9100 and 9200 are `perBusiness: true`: each customer owns a leaf.
-- This one is not, and the reason is scope rather than principle.
--
-- ARITHMETICALLY IT MAKES NO DIFFERENCE, and that is checkable rather
-- than asserted.  Both `v_hold_state` and `ledger_availability()` read a
-- hold's memo balance as
--
--     SUM(l.amount_cents * a.normal_side)
--       WHERE e.hold_id = <this hold> AND l.account_id = h.memo_account_id
--
-- - keyed on the HOLD, not on the account.  Two customers' commitments
-- sharing one memo leaf therefore cannot contaminate each other's
-- availability: each hold's balance is the sum over its own entries.
--
-- WHAT IT COSTS is a reporting affordance, named plainly: a customer's
-- statement renders memo lines from their own 9100/9200 leaves
-- (src/lib/ledger/queries.ts), so an FX commitment hold does not appear
-- there.  Availability is right; the statement line is missing.
--
-- WHY THE COST WAS TAKEN.  Making 9300 `perBusiness: true` means a row
-- in `per_business_rollup` (0021 SS1), a leaf backfilled for every
-- existing customer, and edits to `src/lib/onboarding/open.test.ts` and
-- `src/lib/onboarding/shape.test.ts`, both of which enumerate the three
-- rollups by hand - four files owned by other work, to move a statement
-- line, in a change whose actual job is to stop an overdraft.  The
-- upgrade is a later migration that inserts the row in
-- `per_business_rollup`, opens the leaves and repoints
-- `fx_commitment_hold.hold_id -> hold.memo_account_id`; nothing here
-- forecloses it, because no code reads 9300 by any route other than
-- `hold.memo_account_id`.

INSERT INTO account (entity_id, code, name, parent_id, type, book,
                     currency, business_id, rail_control, is_postable)
SELECT e.id, '9300', 'Holds - accepted FX commitments', p.id,
       'liability', 'memo', 'USD', NULL, NULL, true
  FROM book_entity e
  JOIN account p ON p.entity_id = e.id AND p.code = '9000' AND p.business_id IS NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM account a
    WHERE a.entity_id = e.id AND a.code = '9300' AND a.business_id IS NULL
 );

COMMENT ON COLUMN account.code IS
  'The chart code, bare. 9300 -- the memo home of accepted FX commitments -- was added to the chart by migration 0053 and to src/lib/ledger/chart.ts in the same change.';


-- ---------------------------------------------------------------------
-- 2.  `hold.available_at` stops being an uncleared-credit column
-- ---------------------------------------------------------------------
--
-- `hold` has three clock columns and they divide the kinds:
--
--     expires_at    card_auth      the authorisation's own expiry
--     available_at  uncleared_cred the funds-availability instant
--     (none)        manual         an operator closes it by hand
--
-- An accepted FX commitment has a clock and it is neither of those: the
-- SETTLEMENT WINDOW, `accepted_at + settlement_window_seconds`, fixed at
-- acceptance and printed on the offer.  Past it the commitment has
-- lapsed, `requireAcceptedQuote()` refuses the payout with
-- `FX_QUOTE_COMMITMENT_LAPSED`, and the customer's money must stop being
-- withheld.
--
-- `available_at` is that column, generalised from "when an uncleared
-- credit becomes spendable" to "the instant this hold's own clock
-- releases it, whatever kind it is".  See SS3 for the predicate.

COMMENT ON COLUMN hold.available_at IS
  'The instant this hold releases ON THE CLOCK, for any kind that has one: '
  'the funds-availability moment for an uncleared credit, the settlement '
  'window for an accepted FX commitment (0053). NULL means this hold has no '
  'clock and is released only by a hold_closure row or, for a card '
  'authorisation, by its own event fold. Read by v_hold_state and by '
  'ledger_availability() at a parameterised instant.';


-- ---------------------------------------------------------------------
-- 3.  ONE PREDICATE, in the two bodies that must agree
-- ---------------------------------------------------------------------
--
-- The release arm reads, in both `v_hold_state` (0011) and
-- `ledger_availability()` (0022):
--
--     OR (h.kind = 'uncleared_credit' AND now() >= h.available_at)
--
-- and becomes
--
--     OR (h.available_at IS NOT NULL AND now() >= h.available_at)
--
-- THIS IS A NO-OP ON EVERY ROW THAT EXISTS TODAY, and that is measured,
-- not assumed.  On this database immediately before this migration:
--
--     kind              rows   available_at NOT NULL
--     uncleared_credit   101                     101
--     card_auth          986                       0
--     manual               0                       -
--
-- `available_at` is non-null exactly on the kind the old arm selected,
-- so old predicate and new predicate have the same truth value on all
-- 1,087 rows.  What changes is only what a FUTURE row can mean.
--
-- THE NULL IS WHY THE ARM IS WRITTEN THIS WAY AND NOT THE SHORTER WAY.
-- Both bodies wrap the disjunction in `NOT (...)`.  `NULL >= x` is NULL,
-- `false OR NULL` is NULL, and `NOT NULL` is NULL - which a WHERE clause
-- drops.  A bare `p_as_of >= held.available_at` would therefore treat
-- every card authorisation (available_at NULL) as RELEASED and free
-- every card hold on the book.  The `IS NOT NULL` guard is load-bearing
-- and is the first thing to check if this arm is ever "tidied".
--
-- AND IT IS A DERIVED RELEASE, NOT A CLOSURE ROW.  See SS5: the clock
-- frees the money without anybody writing a permanent row, exactly as it
-- already does for an uncleared credit.

CREATE OR REPLACE VIEW v_hold_state AS
SELECT h.id                AS hold_id,
       h.account_id,
       h.memo_account_id,
       h.kind,
       h.external_ref,
       h.value_date,
       h.expires_at,
       h.available_at,
       COALESCE(m.memo_balance_cents, 0) AS memo_balance_cents,
       r.is_released,
       CASE WHEN r.is_released THEN 0::bigint
            ELSE COALESCE(m.memo_balance_cents, 0)
       END AS active_hold_cents
  FROM hold h
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0) AS memo_balance_cents
      FROM journal_entry e
      JOIN journal_line  l ON l.entry_id = e.id
      JOIN account       a ON a.id = l.account_id
     WHERE e.hold_id = h.id
       AND l.account_id = h.memo_account_id
  ) m ON true
  CROSS JOIN LATERAL (
    SELECT (
      (EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = h.id)
       AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal hr WHERE hr.hold_id = h.id))
      OR (h.kind = 'card_auth'
          AND COALESCE((SELECT ch.is_closed FROM v_card_auth_hold ch WHERE ch.hold_id = h.id), false))
      -- 0053: the clock, for ANY hold that names one. Was
      -- `h.kind = 'uncleared_credit' AND now() >= h.available_at`.
      OR (h.available_at IS NOT NULL AND now() >= h.available_at)
    ) AS is_released
  ) r;


CREATE OR REPLACE FUNCTION ledger_availability(
  p_account     uuid,
  p_value_date  date,
  p_booking_seq bigint,
  p_as_of       timestamptz
) RETURNS TABLE (
  ledger_cents           bigint,
  hold_cents             bigint,
  uncleared_cents        bigint,
  pending_outbound_cents bigint,
  available_cents        bigint
)
  LANGUAGE sql
  STABLE
  SET search_path = public, pg_temp
AS $$
  WITH held AS (
    SELECT h.id, h.kind, h.value_date, h.expires_at, h.available_at,
           h.memo_account_id
      FROM hold h
     WHERE h.account_id = p_account
  ),
  memo AS (
    SELECT held.id AS hold_id,
           COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS memo_cents
      FROM held
      LEFT JOIN journal_entry e ON e.hold_id = held.id
                               AND e.booking_seq <= p_booking_seq
      LEFT JOIN journal_line  l ON l.entry_id = e.id
                               AND l.account_id = held.memo_account_id
      LEFT JOIN account       a ON a.id = l.account_id
     GROUP BY held.id
  ),
  fold AS (
    SELECT held.id AS hold_id,
           count(ev.id) AS event_count,
           COALESCE(SUM(ev.amount_cents) FILTER (
             WHERE ev.kind IN ('authorization','incremental_authorization')), 0)::bigint
         - COALESCE(SUM(ev.amount_cents) FILTER (
             WHERE ev.kind = 'authorization_reversal'), 0)::bigint      AS auth_net_cents,
           COALESCE(bool_or(ev.is_final), false)                        AS saw_final,
           COALESCE(bool_or(ev.kind IN ('expiry','close')), false)      AS saw_close
      FROM held
      LEFT JOIN card_authorization ca ON ca.hold_id = held.id
      LEFT JOIN card_auth_event    ev ON ev.auth_id = ca.id
                                     AND ev.received_at <= p_as_of
     GROUP BY held.id
  ),
  live AS (
    SELECT held.kind, memo.memo_cents
      FROM held
      JOIN memo ON memo.hold_id = held.id
      JOIN fold ON fold.hold_id = held.id
     WHERE held.value_date <= p_value_date          -- (c)
       AND NOT (
             -- closure row, less its reversal (0011)
             EXISTS (SELECT 1 FROM hold_closure hc
                      WHERE hc.hold_id = held.id
                        AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal hr
                                         WHERE hr.hold_id = hc.hold_id))
             -- the card model: four ways to be closed, none of them a status
          OR (held.kind = 'card_auth' AND (
                   fold.saw_final
                OR fold.saw_close
                OR p_as_of >= held.expires_at
                OR (fold.event_count > 0 AND fold.auth_net_cents <= 0)))
             -- 0053: the clock, for ANY hold that names one. Was
             -- `held.kind = 'uncleared_credit' AND p_as_of >= held.available_at`.
             -- The IS NOT NULL is load-bearing: without it a card
             -- authorisation's NULL makes this whole NOT(...) NULL and
             -- frees every card hold on the book.
          OR (held.available_at IS NOT NULL AND p_as_of >= held.available_at)
           )
  ),
  future AS (
    SELECT e.id, SUM(l.amount_cents * a.normal_side)::bigint AS delta_cents
      FROM journal_line  l
      JOIN journal_entry e ON e.id = l.entry_id
      JOIN account       a ON a.id = l.account_id
     WHERE l.account_id  = p_account
       AND l.value_date  > p_value_date
       AND l.booking_seq <= p_booking_seq
     GROUP BY e.id
  ),
  parts AS (
    SELECT ledger_settled_cents(p_account, p_value_date, p_booking_seq)   AS ledger_cents,
           COALESCE((SELECT SUM(memo_cents) FROM live
                      WHERE kind <> 'uncleared_credit'), 0)::bigint       AS hold_cents,
           COALESCE((SELECT SUM(memo_cents) FROM live
                      WHERE kind =  'uncleared_credit'), 0)::bigint       AS uncleared_cents,
           COALESCE((SELECT -SUM(delta_cents) FROM future
                      WHERE delta_cents < 0), 0)::bigint                  AS pending_outbound_cents
  )
  SELECT parts.ledger_cents,
         parts.hold_cents,
         parts.uncleared_cents,
         parts.pending_outbound_cents,
         (parts.ledger_cents
            - parts.hold_cents
            - parts.uncleared_cents
            - parts.pending_outbound_cents)::bigint AS available_cents
    FROM parts
$$;

COMMENT ON FUNCTION ledger_availability(uuid, date, bigint, timestamptz) IS
  'Q2. available = settled ledger - active holds - uncleared credits - '
  'committed future-dated debits, at a value date, a booking watermark and an '
  'instant. The ONE definition: v_available_balance and the TypeScript '
  'availableBalance() are both calls to this body, not copies of it. An '
  'accepted FX commitment is an ordinary manual hold and lands in hold_cents '
  '(0053).';


-- ---------------------------------------------------------------------
-- 4.  The commitment and the hold, bound
-- ---------------------------------------------------------------------
--
-- One row per accepted quote that placed a hold, and it exists so the
-- binding is a FOREIGN KEY rather than a naming convention.  The hold's
-- `external_ref` also carries the quote reference - `hold_ref UNIQUE
-- (kind, external_ref)` is what makes placing the hold idempotent - but
-- a guard cannot join on a string prefix, and docs/DECISIONS is full of
-- what happens when one tries (0040: a guard discriminating on prose).

CREATE TABLE fx_commitment_hold (
  -- One hold per accepted quote, and the acceptance is already once-only
  -- (fx_quote_acceptance.quote_id is its PRIMARY KEY), so this is too.
  quote_id   uuid PRIMARY KEY REFERENCES fx_quote(id),
  hold_id    uuid NOT NULL UNIQUE REFERENCES hold(id),
  -- The figure withheld, copied onto the row at the moment it was
  -- withheld. NOT a second spelling of fx_quote.sell_cents that could
  -- drift - fx_quote is append-only and sell_cents cannot move - but the
  -- number the invariant in SS6 compares the memo book against, so the
  -- guard reads one row instead of a three-table join.
  sell_cents bigint NOT NULL CHECK (sell_cents > 0),
  placed_at  timestamptz NOT NULL DEFAULT now(),
  placed_by  uuid NOT NULL REFERENCES actor(id)
);

CREATE INDEX fx_commitment_hold_hold_idx ON fx_commitment_hold (hold_id);

COMMENT ON TABLE fx_commitment_hold IS
  'Binds an accepted FX quote to the memo hold its acceptance placed. One row '
  'per quote, written in the same transaction as the acceptance. Append-only.';

-- A HOLD CANNOT EXIST FOR A COMMITMENT NOBODY MADE.
--
-- The acceptance row is inserted first, in the same transaction, so this
-- trigger can see it. It also re-derives `sell_cents` from the quote
-- rather than trusting the caller: the whole point of a GENERATED column
-- on `fx_quote` is that the commitment is the database's arithmetic and
-- not the application's, and a hold for a figure the quote does not name
-- would put a number nobody agreed to into the availability calculation.
CREATE OR REPLACE FUNCTION fx_commitment_hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  q record;
BEGIN
  SELECT fq.quote_ref, fq.sell_cents, fq.business_id
    INTO q
    FROM fx_quote fq
   WHERE fq.id = NEW.quote_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no quote %', NEW.quote_id USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM fx_quote_acceptance a WHERE a.quote_id = NEW.quote_id) THEN
    RAISE EXCEPTION
      'quote % has not been accepted, so there is no commitment to hold against',
      q.quote_ref
      USING ERRCODE = '55006';
  END IF;

  IF NEW.sell_cents <> q.sell_cents THEN
    RAISE EXCEPTION
      'commitment hold for quote % is % cents but the quote commits % cents',
      q.quote_ref, NEW.sell_cents, q.sell_cents
      USING ERRCODE = '55006';
  END IF;

  -- The hold must be on the customer's OWN deposit account. Holding one
  -- customer's balance against another's commitment is the memo-book
  -- shape of the card-token mix-up migration 0008 SS3 exists to prevent.
  IF NOT EXISTS (
    SELECT 1 FROM hold h
      JOIN account a ON a.id = h.account_id
     WHERE h.id = NEW.hold_id
       AND a.code = '2100'
       AND a.business_id = q.business_id
  ) THEN
    RAISE EXCEPTION
      'the hold for quote % is not on that customer''s own 2100 account',
      q.quote_ref
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER fx_commitment_hold_preconditions
  BEFORE INSERT ON fx_commitment_hold
  FOR EACH ROW EXECUTE FUNCTION fx_commitment_hold_guard();

CREATE TRIGGER fx_commitment_hold_no_update_delete
  BEFORE UPDATE OR DELETE ON fx_commitment_hold
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER fx_commitment_hold_no_truncate
  BEFORE TRUNCATE ON fx_commitment_hold
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

GRANT SELECT, INSERT ON fx_commitment_hold TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON fx_commitment_hold FROM corgi_app, PUBLIC;


-- ---------------------------------------------------------------------
-- 5.  Closure:  ONE condition licenses a permanent row, and it is not
--     the clock
-- ---------------------------------------------------------------------
--
-- `closed` and `terminallyClosed` are different predicates in
-- src/lib/holds/model.ts and the difference decides whether an
-- APPEND-ONLY `hold_closure` row may be written.  0011 and 0028 both
-- paid for getting it wrong.  For an FX commitment there are exactly two
-- conditions under which the money stops being withheld, and only one of
-- them writes a row.
--
--   SETTLED - `fx_quote_settlement` has a row for this quote.
--      TERMINAL.  `quote_id` is that table's PRIMARY KEY, the table is
--      append-only at both layers (0017 SS7), so this is an EXISTS over a
--      growing set and an EXISTS never un-fires.  The payout happened,
--      the financial book moved, and the reason the money was freed will
--      still be true for ever.  It gets the `hold_closure` row, with
--      `source = 'fx_settlement'`.
--
--   LAPSED - `now() >= accepted_at + settlement_window_seconds`.
--      NOT TERMINAL, and this is the interesting one.  The clock itself
--      is monotone, so monotonicity is not the objection.  The objection
--      is that the row would be a PERMANENT CLAIM ABOUT WHY, and that
--      claim can be overtaken: src/lib/fx/settle.ts says in terms that a
--      LAPSED commitment still posts on the `--settle` recovery path,
--      because the USDC may already have left before anybody noticed the
--      window had closed.  A closure row written by the clock would then
--      stand for ever saying the hold was released because the customer
--      ran out of time, on a commitment that in fact settled - a false
--      permanent record in the one book that exists to be trusted, and
--      not repairable, because the correction to an append-only row is
--      another row (`hold_closure_reversal`) and now the audit trail is
--      three rows saying what one row should have said.
--
--      So the lapse releases the money from the CLOCK, derived, at the
--      parameterised instant, writing nothing - which is exactly what
--      SS3's predicate does and exactly how an uncleared credit has
--      always been released.  If the settlement then lands, its closure
--      row is the only permanent record and it says the true thing.
--
-- A THIRD CONDITION IS DELIBERATELY ABSENT: "the customer's available
-- balance has gone negative" is not a release.  It is not a fact about
-- the commitment at all.

ALTER TABLE hold_closure DROP CONSTRAINT IF EXISTS hold_closure_source_known;

ALTER TABLE hold_closure
  ADD CONSTRAINT hold_closure_source_known CHECK (
    source IS NULL OR source IN (
      'posting_path',        -- src/lib/holds/apply.ts     - closed(E) said so
      'expiry_sweep',        -- src/lib/holds/expiry.ts    - the clock said so
      'availability_sweep',  -- src/lib/rails/plaid/adapter.ts - ACH maturity
      'wire_availability',   -- src/lib/rails/wire/ledger.ts   - zero-day wire
      'dispute',             -- src/lib/disputes/store.ts  - a dispute resolved
      'repair',              -- a migration undoing a hold that was never owed
      'operator',            -- a human overriding the model (0011 SS3)
      'test_harness',        -- a test writing against this shared book
      'fx_settlement'        -- 0053: an accepted FX quote funded its payout
    ));

COMMENT ON COLUMN hold_closure.source IS
  'WHO decided to close this hold, as a CHECK-constrained value, so an '
  'invariant can select its population by construction instead of by '
  'matching English against hold_closure.reason. NULL means the writer did '
  'not declare one; for a card_auth hold that is refused at INSERT (see '
  'hold_closure_declares_source). Added by 0040 without a single UPDATE on '
  'this append-only table; ''fx_settlement'' added by 0053.';


-- ---------------------------------------------------------------------
-- 6.  The invariant, and the watermark it is honest about
-- ---------------------------------------------------------------------
--
-- THE CLAIM: a commitment this system is on the hook for is withholding
-- the customer's money, to the cent, for as long as it stands.
--
-- THE POPULATION IT CAN HONESTLY MAKE THAT CLAIM ABOUT.  This book
-- already carries 23 quotes in state `accepted` and 3 in `lapsed`, every
-- one of them accepted before this migration existed and therefore
-- holding nothing.  A guard that went red on 23 rows the day it shipped
-- would be a guard nobody could read, and backfilling holds for them
-- would move availability on a live book to make a view green - which is
-- repairing the measurement rather than the thing.
--
-- So the regime has a START INSTANT, it is a row rather than a comment,
-- and the guard ranges over acceptances at or after it.  This is 0049's
-- watermark shape and it is used here for the same reason: the honest
-- scope of a new control is "from when it existed", stated as data so a
-- reader can see the boundary instead of inferring it.

CREATE TABLE fx_commitment_regime (
  -- One row, for ever. `singleton` is the PRIMARY KEY and the CHECK
  -- pins its only legal value, so a second row is unrepresentable
  -- rather than merely discouraged.
  singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  effective_from timestamptz NOT NULL DEFAULT now(),
  note           text NOT NULL
);

INSERT INTO fx_commitment_regime (singleton, note) VALUES
  (true,
   'Migration 0053. Acceptances at or after this instant place a memo hold for sell_cents; v_fx_commitment_unheld ranges over exactly those. The 23 accepted and 3 lapsed quotes that predate it hold nothing and are outside this guard by construction, counted in dbcheck GUARD REACH.');

COMMENT ON TABLE fx_commitment_regime IS
  'When the FX commitment hold started existing. One row. Read only by v_fx_commitment_unheld, so the guard''s population is data rather than a sentence in a migration.';

GRANT SELECT ON fx_commitment_regime TO corgi_app;

-- MUST RETURN ZERO ROWS.  Nothing repairs what it reports.
--
-- A row here is one of exactly three things and the `finding` column
-- says which, because "the hold is wrong" is not an actionable sentence:
--
--   no_hold_placed   an acceptance landed and no hold went with it. This
--                    is the defect this whole migration is about, and it
--                    is what the guard catches if acceptQuote() is ever
--                    changed to write the acceptance without the hold.
--   released_early   the hold exists and something released it while the
--                    commitment still stands - a closure row written on
--                    a reversible condition (SS5), or a clock set wrong.
--   wrong_amount     the memo book is withholding a figure that is not
--                    the committed price.
--
-- WHAT IT DELIBERATELY DOES NOT RANGE OVER: settled quotes (the hold
-- SHOULD be released and flat) and lapsed ones (released by the clock,
-- SS5). Both are asserted elsewhere - a settled quote's closure is
-- covered by `v_hold_release_drift`, which requires a released hold to
-- be withholding nothing.
CREATE VIEW v_fx_commitment_unheld AS
SELECT q.quote_ref,
       q.business_id,
       b.legal_name,
       a.accepted_at,
       (a.accepted_at + q.settlement_window_seconds * interval '1 second') AS settle_by,
       q.sell_cents                                    AS committed_cents,
       COALESCE(hs.active_hold_cents, 0)::bigint       AS withheld_cents,
       ch.hold_id,
       CASE WHEN ch.quote_id IS NULL          THEN 'no_hold_placed'
            WHEN COALESCE(hs.is_released, true) THEN 'released_early'
            ELSE 'wrong_amount'
       END AS finding
  FROM fx_quote q
  JOIN business             b ON b.id = q.business_id
  JOIN fx_quote_acceptance  a ON a.quote_id = q.id
  CROSS JOIN fx_commitment_regime r
  LEFT JOIN fx_commitment_hold ch ON ch.quote_id = q.id
  LEFT JOIN v_hold_state       hs ON hs.hold_id  = ch.hold_id
 WHERE a.accepted_at >= r.effective_from
   -- still a commitment: accepted, unsettled, inside the window
   AND NOT EXISTS (SELECT 1 FROM fx_quote_settlement s WHERE s.quote_id = q.id)
   AND now() <= a.accepted_at + q.settlement_window_seconds * interval '1 second'
   AND COALESCE(hs.active_hold_cents, 0) <> q.sell_cents;

COMMENT ON VIEW v_fx_commitment_unheld IS
  'MUST RETURN ZERO ROWS. Every FX commitment still standing - accepted, '
  'unsettled, inside its settlement window, made under the 0053 regime - is '
  'withholding exactly its committed price in the memo book. A row is an '
  'overdraft path: money the customer has committed and can still spend.';

GRANT SELECT ON v_fx_commitment_unheld TO corgi_app;

-- The census the guard's reach is computed from, so `dbcheck` can print
-- how many commitments this view can actually see rather than claiming
-- coverage. Same shape as the other reach views.
CREATE VIEW v_fx_commitment_census AS
SELECT CASE
         WHEN a.accepted_at < r.effective_from                     THEN 'predates_the_regime'
         WHEN EXISTS (SELECT 1 FROM fx_quote_settlement s WHERE s.quote_id = q.id)
                                                                   THEN 'settled'
         WHEN now() > a.accepted_at + q.settlement_window_seconds * interval '1 second'
                                                                   THEN 'lapsed'
         ELSE 'standing'
       END                                    AS commitment_scope,
       count(*)                               AS quotes,
       COALESCE(SUM(q.sell_cents), 0)::bigint AS committed_cents
  FROM fx_quote q
  JOIN fx_quote_acceptance a ON a.quote_id = q.id
  CROSS JOIN fx_commitment_regime r
 GROUP BY 1;

COMMENT ON VIEW v_fx_commitment_census IS
  'Every accepted quote, classified by whether v_fx_commitment_unheld can see '
  'it. Only `standing` is inside that guard; the other three are outside by '
  'construction and this view is how many.';

GRANT SELECT ON v_fx_commitment_census TO corgi_app;


-- ---------------------------------------------------------------------
-- 7.  What did not change
-- ---------------------------------------------------------------------
--
-- `fx_quote`, `fx_quote_acceptance` and `fx_quote_settlement` are
-- untouched: no column added, no trigger replaced, no privilege widened.
-- The rate cannot be substituted after acceptance for exactly the same
-- reasons it could not yesterday.
--
-- `journal_line` has no currency column and this migration did not want
-- one.  A hold is USD cents in the memo book, like every other hold.
