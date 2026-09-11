-- =====================================================================
-- 0019  Disputes on settled card transactions, and provisional credit
-- =====================================================================
--
-- A dispute is the customer telling us that a card transaction which has
-- ALREADY SETTLED -- the money is gone, the clearing is booked, the
-- network has been paid -- should not have happened.  Between that claim
-- and the network's answer sits provisional credit: OUR money, advanced
-- to the customer on a maybe, which we may never get back.
--
-- Everything in this file exists to make three things unrepresentable.
--
-- ---------------------------------------------------------------------
-- 1.  A provisional credit is NOT a refund
-- ---------------------------------------------------------------------
--
-- A refund is final.  A provisional credit is REVERSIBLE, and the
-- reversal must not look like a new debit the customer did not make.
--
-- So which is a clawback: a CORRECTION of the credit at its original
-- value date, or a NEW EVENT at the day it happened?
--
-- It is a NEW EVENT, and the test that decides it is the one DECISIONS
-- 019 already applied to an ACH return:
--
--     Did the FACT change, or was the RECORD wrong?
--
-- A card clearing reversal is a CORRECTION.  The merchant reversing
-- Tuesday's settlement means the settlement should never have posted at
-- that amount -- the record was wrong about Tuesday, and Tuesday's
-- statement must now show the corrected figure.
--
-- A dispute clawback is the opposite.  On the day we granted provisional
-- credit, the grant was CORRECT: on the evidence we had, we chose to
-- advance the customer their money, we told them so, and their balance
-- really did go up.  Nothing about that day was mis-recorded.  What
-- changed is that the network later decided the charge was valid -- a NEW
-- FACT, learned on a new day, that creates a NEW obligation running the
-- other way.  Two facts, two days, two entries, both standing.
--
-- Reversing the grant at its original value date would be a lie in both
-- directions: the customer's statement for the grant day would show no
-- credit even though we had written to them saying there was one, and the
-- decision day would show nothing happening even though that is the day
-- the money came back.  `reverseAndRebook` in src/lib/ledger/post.ts is
-- therefore the WRONG tool here, and it is the right tool for the case
-- immediately next door: an operator who granted credit against the wrong
-- transaction, or for the wrong amount, has a mis-recorded grant, and
-- that IS a correction at the original value date.
--
-- ---------------------------------------------------------------------
-- 2.  A provisional credit must not inflate AVAILABLE balance
-- ---------------------------------------------------------------------
--
-- The credit is real money in the ledger on the day it is granted -- the
-- statement and the ledger balance must show it, because we told the
-- customer it was there.  Whether they may SPEND it is a separate
-- question, and the answer is no, not until the case resolves.
--
-- This is a US BUSINESS account, so Regulation E does not apply: there is
-- no consumer-account obligation to give "full use of the funds" during
-- the investigation.  What governs is the network's dispute rules and our
-- deposit agreement, and they leave availability to us.  So we hold it,
-- and the reason is the whole point of the feature:
--
--     THE HOLD IS WHAT MAKES THE CLAWBACK SAFE.
--
-- If the credit were spendable and the dispute is lost, taking it back
-- overdraws a customer who did nothing wrong.  With the hold, available
-- balance is unchanged across the entire episode, and losing the dispute
-- can never put the customer in the red.
--
-- The mechanism is the existing one -- `hold`, memo book, 9200 -- because
-- available balance must stay `ledger - holds` with no new term.  Two
-- details:
--
--   * KIND IS `uncleared_credit`, NOT `manual`.  `manual` is the
--     semantically tempting choice (released only by an explicit
--     decision) and it is a trap: `availableBalance()` in
--     src/lib/ledger/balances.ts sums `card_auth` and `uncleared_credit`
--     and NOTHING ELSE, so a `manual` hold withholds nothing there while
--     `v_available_balance` subtracts it -- the two would disagree about
--     the same hold, which is exactly the state migration 0011 existed to
--     clean up.  A hold kind availability does not subtract is worse than
--     a slightly stretched label.
--
--   * `available_at` IS `'infinity'`.  `hold_clock` requires an
--     uncleared-credit hold to carry one, and `v_hold_state` releases
--     such a hold when `now() >= available_at`.  A dispute credit is not
--     awaiting SETTLEMENT, it is awaiting a DECISION, so no clock may
--     ever release it.  `'infinity'` says precisely that -- not a
--     far-future sentinel someone picked, but the literal statement that
--     the clock arm never fires.  Release is `hold_closure` and nothing
--     else.
--
--     The network's outside date for the case lives on `dispute` as
--     `network_outside_date` and drives AGEING ON THE SCREEN.  It is
--     deliberately not `available_at`: putting it there would make
--     `v_hold_release_drift` -- a view asserted to be empty for ever --
--     fire on an ordinary business condition.  Invariants are for
--     impossible states; deadlines are for operators.
--
-- ---------------------------------------------------------------------
-- 3.  An illegal transition is unrepresentable
-- ---------------------------------------------------------------------
--
--   raised
--     |-- provisional_credit_authorized   (a second human, above threshold)
--     |-- provisional_credit_granted  ----> money moves, hold opens
--     |-- provisional_credit_declined ----> no money moves
--     |-- evidence_submitted          (repeatable, until a decision)
--     |
--     +-- won -------> credit_finalized     hold releases; credit stands
--     +-- lost ------> credit_clawed_back   customer repays  (the EDGE case)
--     |          \--> credit_written_off    we eat it -> 5200
--     +-- withdrawn  (only if nothing was advanced)
--
-- Policed by `assert_dispute_lifecycle()`, a BEFORE INSERT trigger, in
-- the shape 0007 established for payments: the fold lives in a view, the
-- LAW lives in a trigger, and application code cannot route around it.
-- Every comparison is written `::text` for the reason 0007 gives.
--
-- ---------------------------------------------------------------------
-- What is OURS and what is the PROVIDER's
-- ---------------------------------------------------------------------
--
-- Measured, not assumed: Lithic's sandbox has no dispute simulator.
-- `POST /v1/simulate/chargeback` and `POST /v1/simulate/dispute` both
-- return 404.  So:
--
--   the transaction is REAL          (Lithic sandbox card, real webhook)
--   the settlement is REAL           (real clearing, booked from the webhook)
--   the dispute workflow is OURS     (intake, provisional credit, evidence)
--   the network's verdict is OPERATOR-DRIVEN
--
-- Nothing in this file claims otherwise, and `dispute.network_case_ref`
-- is nullable precisely because in this deployment there is no network
-- case to reference.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  Vocabulary
-- ---------------------------------------------------------------------

-- OUR canonical reasons.  The network's own codes live in a lookup table
-- below, exactly as `rail_event_semantics` keeps provider event names out
-- of our enums: Visa and Mastercard disagree about both the numbering and
-- the boundaries, and an enum that spoke one scheme's dialect would have
-- to be altered the day the other one was wired up.
CREATE TYPE dispute_reason AS ENUM (
  'fraud',                  -- the cardholder did not make or authorise it
  'goods_not_received',     -- paid for, never arrived
  'duplicate',              -- the same purchase charged twice
  'incorrect_amount',       -- charged more than agreed
  'not_as_described',       -- arrived, but is not what was sold
  'credit_not_processed'    -- the merchant agreed a refund and never sent it
);

CREATE TYPE dispute_event_kind AS ENUM (
  'raised',
  'provisional_credit_authorized',
  'provisional_credit_granted',
  'provisional_credit_declined',
  'evidence_submitted',
  'won',
  'lost',
  'withdrawn',
  'credit_finalized',
  'credit_clawed_back',
  'credit_written_off'
);

-- The network's vocabulary, verbatim, keyed the way the network keys it.
-- Same discipline as `rail_event_semantics`: one row per (network, code),
-- our word in a column, and the mapping is DATA that can be read on a
-- screen rather than a CASE buried in a consumer.
CREATE TABLE dispute_reason_code (
  network       text           NOT NULL,   -- 'visa' | 'mastercard'
  network_code  text           NOT NULL,   -- '10.4', '4837' -- their numbering
  reason        dispute_reason NOT NULL,   -- ours
  network_label text           NOT NULL,   -- their wording, unedited
  evidence_note text           NOT NULL,   -- what the issuer must actually file
  PRIMARY KEY (network, network_code)
);

INSERT INTO dispute_reason_code (network, network_code, reason, network_label, evidence_note) VALUES
  ('visa', '10.4',   'fraud',
   'Other Fraud - Card-Absent Environment',
   'Cardholder statement that the transaction was not authorised, plus our own device and velocity evidence. No merchant rebuttal is possible on a confirmed-fraud code without compelling evidence.'),
  ('visa', '13.1',   'goods_not_received',
   'Merchandise/Services Not Received',
   'The expected delivery date must have passed and the cardholder must have attempted resolution with the merchant first.'),
  ('visa', '12.6.1', 'duplicate',
   'Duplicate Processing',
   'Both transaction records, showing the same card, amount, merchant and date. If the merchant already refunded one, the correct code is 13.6, not this one.'),
  ('visa', '12.5',   'incorrect_amount',
   'Incorrect Amount',
   'The authorised amount and the settled amount, and the document that set the price. A tip or a fuel-pump completion is NOT an incorrect amount -- it is a legitimate over-capture.'),
  ('visa', '13.3',   'not_as_described',
   'Not as Described or Defective Merchandise/Services',
   'Description of what was ordered against what arrived, and evidence the cardholder tried to return it.'),
  ('visa', '13.6',   'credit_not_processed',
   'Credit Not Processed',
   'The merchant''s written agreement to refund, and proof that the refund never reached the account.'),
  ('mastercard', '4837', 'fraud',
   'No Cardholder Authorisation',
   'Mastercard splits fraud by environment differently from Visa; 4837 is the card-absent equivalent of Visa 10.4.'),
  ('mastercard', '4855', 'goods_not_received',
   'Goods or Services Not Provided',
   'Mastercard requires the cardholder to wait until the latest anticipated delivery date before this may be filed.'),
  ('mastercard', '4834', 'duplicate',
   'Point-of-Interaction Error',
   'Mastercard folds duplicate processing into the broader point-of-interaction error code.'),
  ('mastercard', '4853', 'not_as_described',
   'Cardholder Dispute - Goods or Services Not as Described',
   'Mastercard carries incorrect amount, not-as-described and credit-not-processed under one umbrella code with different sub-conditions.');

GRANT SELECT ON dispute_reason_code TO corgi_app;

CREATE TRIGGER dispute_reason_code_no_update_delete
  BEFORE UPDATE OR DELETE ON dispute_reason_code
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 2.  The case
-- ---------------------------------------------------------------------
--
-- WHAT IS DISPUTED IS AN ENTRY, NOT AN AMOUNT SOMEBODY TYPED.
-- `disputed_entry_id` points at the settled clearing in the journal, so
-- "is this a real settled card transaction, and did this customer
-- actually pay it" is a join rather than an assertion.  A dispute whose
-- subject is a number in a form is a dispute you cannot reconcile.
--
-- Deliberately absent: a `status` column.  Status is a fold over
-- `dispute_event` (see `v_dispute_state`), for the same reason
-- `card_authorization` has no status column -- a stored status is a
-- second source of truth that drifts from the event stream and then gets
-- "fixed".
--
-- Also deliberately absent: an amount owed, a balance, or a provisional
-- credit figure.  `amount_cents` is what was CLAIMED.  What was actually
-- advanced is `SUM` over the journal, reached through
-- `dispute_event.entry_id`.
CREATE TABLE dispute (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_ref             text NOT NULL UNIQUE,       -- our case number, shown to the customer

  -- what is disputed
  disputed_entry_id    uuid NOT NULL REFERENCES journal_entry(id),
  account_id           uuid NOT NULL REFERENCES account(id),   -- customer's 2100 leaf
  memo_account_id      uuid NOT NULL REFERENCES account(id),   -- customer's 9200 leaf
  card_id              uuid REFERENCES card(id),
  auth_id              uuid REFERENCES card_authorization(id),

  -- why
  reason               dispute_reason NOT NULL,
  network              text NOT NULL,
  network_code         text NOT NULL,
  narrative            text NOT NULL,              -- the customer's own words
  network_case_ref     text,                       -- NULL here: no network case exists

  -- how much, and when
  amount_cents         bigint NOT NULL CHECK (amount_cents > 0),
  currency             char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  value_date           date NOT NULL,              -- the day the claim was made
  -- The date by which the network will have finished with this case.  Drives
  -- ageing on the breaks-style view, NOT the release of the hold.  See the
  -- header: an invariant view must not fire on a business condition.
  network_outside_date date NOT NULL,

  -- who, and under what rule
  raised_by            uuid NOT NULL REFERENCES actor(id),
  raised_at            timestamptz NOT NULL DEFAULT now(),
  policy_id            uuid NOT NULL REFERENCES approval_policy(id),

  FOREIGN KEY (network, network_code)
    REFERENCES dispute_reason_code (network, network_code),
  CONSTRAINT dispute_outside_date_after_claim CHECK (network_outside_date > value_date)
);

CREATE INDEX dispute_entry_idx   ON dispute (disputed_entry_id);
CREATE INDEX dispute_account_idx ON dispute (account_id);
CREATE INDEX dispute_raised_idx  ON dispute (raised_at DESC);

CREATE TRIGGER dispute_no_update_delete
  BEFORE UPDATE OR DELETE ON dispute
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();
CREATE TRIGGER dispute_no_truncate
  BEFORE TRUNCATE ON dispute
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 3.  The event stream
-- ---------------------------------------------------------------------
--
-- Append-only, like `card_auth_event` and `payment_instruction_event`.
-- `entry_id` ties the event to the money it moved, and it is the ONLY
-- link between a dispute and the journal -- `journal_entry` gains no
-- column here, because a dispute is not a property of an entry.
CREATE TABLE dispute_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id    uuid NOT NULL REFERENCES dispute(id),
  kind          dispute_event_kind NOT NULL,
  actor_id      uuid NOT NULL REFERENCES actor(id),
  -- WHEN IT HAPPENED, in book time.  The clawback's value_date is the day
  -- the NETWORK decided, not the day the credit was granted.  That single
  -- column is the correction-versus-new-event decision, made concrete.
  value_date    date NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  amount_cents  bigint CHECK (amount_cents IS NULL OR amount_cents > 0),
  entry_id      uuid REFERENCES journal_entry(id),
  hold_id       uuid REFERENCES hold(id),
  detail        text
);

CREATE INDEX dispute_event_dispute_idx ON dispute_event (dispute_id, occurred_at);

-- One actor, one authorisation.  Without this, one approver could write
-- two rows to satisfy a two-approver policy.  (`count(DISTINCT actor_id)`
-- in the trigger already defends the count; this makes the second row
-- impossible rather than merely ineffective.)
CREATE UNIQUE INDEX dispute_event_one_authorization_per_actor
  ON dispute_event (dispute_id, actor_id)
  WHERE kind = 'provisional_credit_authorized';

CREATE TRIGGER dispute_event_no_update_delete
  BEFORE UPDATE OR DELETE ON dispute_event
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();
CREATE TRIGGER dispute_event_no_truncate
  BEFORE TRUNCATE ON dispute_event
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 4.  Intake: what may be disputed at all
-- ---------------------------------------------------------------------
--
-- Four rules, all of them about money rather than about form validation,
-- and all of them enforced where the application cannot route around
-- them.
--
--   (a) The subject must be a CARD entry in the FINANCIAL book that
--       DEBITED THIS CUSTOMER.  A debit to a credit-normal deposit
--       account is money leaving -- which is what "settled" means for the
--       customer.  An authorisation never reaches the financial book, so
--       this rule alone makes "you cannot dispute a hold" structural.
--
--   (b) You cannot dispute money that has already come back.  The test is
--       run over the whole CORRECTION GROUP, not the single entry: if the
--       merchant already reversed the settlement, the group nets to zero
--       and there is nothing left to claim.
--
--   (c) The sum of live claims against one charge may not exceed the
--       charge.  A withdrawn case releases its amount; anything else
--       still consumes it.
--
--   (d) The customer's two accounts must actually be theirs: a 2100 leaf
--       and the 9200 leaf of the SAME business.  Getting this wrong is
--       how one customer's hold withholds another customer's money.
--
-- The advisory lock serialises (b) and (c) against a concurrent second
-- claim on the same charge.  Read-committed would let two claims each
-- read the other's absence and both commit; the lock is taken on the
-- disputed entry, so it costs nothing that is not already contended.
CREATE OR REPLACE FUNCTION assert_dispute_intake() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_entry     journal_entry%ROWTYPE;
  v_acct      account%ROWTYPE;
  v_memo      account%ROWTYPE;
  v_charge    bigint;
  v_claimed   bigint;
  v_policy    approval_policy%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.disputed_entry_id::text, 0));

  SELECT * INTO v_entry FROM journal_entry WHERE id = NEW.disputed_entry_id;
  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'no such entry %', NEW.disputed_entry_id USING ERRCODE = '23503';
  END IF;

  IF v_entry.rail::text <> 'card' OR v_entry.book::text <> 'financial' THEN
    RAISE EXCEPTION
      'entry % is a % entry in the % book; only a settled CARD transaction can be disputed',
      NEW.disputed_entry_id, COALESCE(v_entry.rail::text, 'railless'), v_entry.book
      USING ERRCODE = '42501';
  END IF;

  -- (d) tenancy
  SELECT * INTO v_acct FROM account WHERE id = NEW.account_id;
  SELECT * INTO v_memo FROM account WHERE id = NEW.memo_account_id;
  IF v_acct.code <> '2100' OR v_acct.business_id IS NULL THEN
    RAISE EXCEPTION 'account % is not a customer deposit leaf', NEW.account_id
      USING ERRCODE = '42501';
  END IF;
  IF v_memo.code <> '9200' OR v_memo.business_id IS DISTINCT FROM v_acct.business_id THEN
    RAISE EXCEPTION
      'memo account % is not the 9200 leaf of business %', NEW.memo_account_id, v_acct.business_id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.value_date < v_entry.value_date THEN
    RAISE EXCEPTION
      'dispute is dated % but the charge is dated %: a charge cannot be disputed before it happened',
      NEW.value_date, v_entry.value_date USING ERRCODE = '22007';
  END IF;

  -- (a) + (b): the net DEBIT this customer still carries for this charge,
  -- across the original, any reversal and any re-book.
  SELECT COALESCE(SUM(l.amount_cents), 0)::bigint INTO v_charge
    FROM journal_entry e
    JOIN journal_line  l ON l.entry_id = e.id
   WHERE e.correction_group_id = v_entry.correction_group_id
     AND l.account_id = NEW.account_id;

  IF v_charge <= 0 THEN
    RAISE EXCEPTION
      'entry % does not leave a debit on account % (net % cents): nothing was taken, or it has already been reversed',
      NEW.disputed_entry_id, NEW.account_id, v_charge USING ERRCODE = '42501';
  END IF;

  -- (c) claims already standing against the same charge
  SELECT COALESCE(SUM(d.amount_cents), 0)::bigint INTO v_claimed
    FROM dispute d
   WHERE d.disputed_entry_id = NEW.disputed_entry_id
     AND NOT EXISTS (
       SELECT 1 FROM dispute_event de
        WHERE de.dispute_id = d.id AND de.kind::text = 'withdrawn');

  IF v_claimed + NEW.amount_cents > v_charge THEN
    RAISE EXCEPTION
      'claims against entry % would total % cents against a % cent charge (% already claimed)',
      NEW.disputed_entry_id, v_claimed + NEW.amount_cents, v_charge, v_claimed
      USING ERRCODE = '42501';
  END IF;

  -- The policy must be a card-rail policy.  A dispute judged under the
  -- wire threshold would pass a control it was never subject to.
  SELECT * INTO v_policy FROM approval_policy WHERE id = NEW.policy_id;
  IF v_policy.rail::text <> 'card' THEN
    RAISE EXCEPTION
      'policy % is for the % rail; a dispute is judged under the card policy',
      NEW.policy_id, v_policy.rail USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER dispute_intake
  BEFORE INSERT ON dispute
  FOR EACH ROW EXECUTE FUNCTION assert_dispute_intake();


-- ---------------------------------------------------------------------
-- 5.  The lifecycle
-- ---------------------------------------------------------------------
--
-- Same shape as `assert_payment_lifecycle()` in 0007, and the maker-
-- checker clauses are the same clauses, with ONE addition that matters
-- here and does not arise for payments:
--
--     THE COUNTERPARTY TO THE ADVANCE CANNOT AUTHORISE IT.
--
-- Provisional credit is the bank advancing its own money to this
-- customer.  An approver belonging to the disputing business would be
-- approving a payment to themselves, so the authoriser must be a Corgi
-- human approver -- `business_id IS NULL` -- who is not the raiser.  The
-- agent surface is excluded twice over, by `actor_only_humans_approve` in
-- 0001 and by the explicit `kind = 'human'` test below.
--
-- WHY NOT `payment_instruction`.  The approvals machinery in 0007 is
-- bound to an instruction with a rail, a counterparty, a content hash and
-- a release that submits to a provider.  A provisional credit has no
-- counterparty and no rail leg -- it never leaves the bank -- so routing
-- it through `payment_instruction` would mean fabricating a payment that
-- the payments queue, the release path and scheme reconciliation would
-- all then have to special-case.  What IS reused is everything that is
-- genuinely shared: `approval_policy` (effective-dated, append-only, so a
-- later threshold change cannot make a past grant look wrong), the
-- `actor` constraints, and the maker-checker rule itself.  The event
-- stream is the dispute's own because the subject is the dispute.
CREATE OR REPLACE FUNCTION assert_dispute_lifecycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_d          dispute%ROWTYPE;
  v_actor      actor%ROWTYPE;
  v_policy     approval_policy%ROWTYPE;
  v_kind       text := NEW.kind::text;
  v_approvals  integer;
  v_granted    boolean;
  v_decided    boolean;   -- won / lost / withdrawn
  v_resolved   boolean;   -- finalized / clawed back / written off
BEGIN
  SELECT * INTO v_d FROM dispute WHERE id = NEW.dispute_id;

  -- 'raised' opens the stream and is written exactly once, in the same
  -- transaction as the dispute row itself.
  IF v_kind = 'raised' THEN
    IF EXISTS (SELECT 1 FROM dispute_event WHERE dispute_id = NEW.dispute_id) THEN
      RAISE EXCEPTION
        'dispute % is already open: raised is written once, at intake', NEW.dispute_id
        USING ERRCODE = '55006';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM dispute_event
                  WHERE dispute_id = NEW.dispute_id AND kind::text = 'raised') THEN
    RAISE EXCEPTION
      'dispute % has no raised event; % cannot be its first transition',
      NEW.dispute_id, v_kind USING ERRCODE = '55006';
  END IF;

  SELECT
    bool_or(kind::text = 'provisional_credit_granted'),
    bool_or(kind::text IN ('won','lost','withdrawn')),
    bool_or(kind::text IN ('credit_finalized','credit_clawed_back','credit_written_off'))
    INTO v_granted, v_decided, v_resolved
    FROM dispute_event WHERE dispute_id = NEW.dispute_id;

  -- Nothing at all may follow a resolution.  This is the terminal wall.
  IF v_resolved THEN
    RAISE EXCEPTION 'dispute % is resolved and closed; % is not available any more',
      NEW.dispute_id, v_kind USING ERRCODE = '55006';
  END IF;

  -- ---- the credit decision, and the second human -------------------
  IF v_kind IN ('provisional_credit_authorized',
                'provisional_credit_granted',
                'provisional_credit_declined') THEN
    IF v_decided THEN
      RAISE EXCEPTION
        'dispute % has already been decided; provisional credit is not available any more',
        NEW.dispute_id USING ERRCODE = '55006';
    END IF;
    IF EXISTS (SELECT 1 FROM dispute_event
                WHERE dispute_id = NEW.dispute_id
                  AND kind::text IN ('provisional_credit_granted',
                                     'provisional_credit_declined')) THEN
      RAISE EXCEPTION
        'dispute % has already settled the question of provisional credit', NEW.dispute_id
        USING ERRCODE = '55006';
    END IF;
  END IF;

  IF v_kind = 'provisional_credit_authorized' THEN
    SELECT * INTO v_actor FROM actor WHERE id = NEW.actor_id;

    -- (a) an automated surface can never authorise.
    IF v_actor.kind::text <> 'human' OR NOT v_actor.can_approve THEN
      RAISE EXCEPTION 'actor % (kind %) is not an approver', NEW.actor_id, v_actor.kind
        USING ERRCODE = '42501';
    END IF;

    -- (b) the initiator can never authorise their own case.
    IF NEW.actor_id = v_d.raised_by THEN
      RAISE EXCEPTION
        'maker-checker: actor % raised dispute % and cannot authorise its provisional credit',
        NEW.actor_id, NEW.dispute_id USING ERRCODE = '42501';
    END IF;

    -- (c) and neither can the customer we would be advancing money to.
    IF v_actor.business_id IS NOT NULL THEN
      RAISE EXCEPTION
        'actor % belongs to a customer business and cannot authorise an advance to a customer',
        NEW.actor_id USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_kind = 'provisional_credit_granted' THEN
    SELECT * INTO v_policy FROM approval_policy WHERE id = v_d.policy_id;

    IF v_d.amount_cents >= v_policy.threshold_cents THEN
      SELECT count(DISTINCT e.actor_id) INTO v_approvals
        FROM dispute_event e
        JOIN actor a ON a.id = e.actor_id
       WHERE e.dispute_id = NEW.dispute_id
         AND e.kind::text = 'provisional_credit_authorized'
         AND a.kind::text = 'human'
         AND a.can_approve
         AND a.business_id IS NULL
         AND e.actor_id <> v_d.raised_by;

      IF v_approvals < v_policy.required_approvals THEN
        RAISE EXCEPTION
          'dispute % needs % authorisation(s) to advance % cents (threshold % cents), has %',
          NEW.dispute_id, v_policy.required_approvals, v_d.amount_cents,
          v_policy.threshold_cents, v_approvals
          USING ERRCODE = '42501';
      END IF;
    END IF;

    -- The event must cite the money it moved and the hold that withholds
    -- it.  An event that says "credit granted" without an entry is a
    -- claim the ledger cannot confirm.
    IF NEW.entry_id IS NULL OR NEW.hold_id IS NULL THEN
      RAISE EXCEPTION
        'a granted provisional credit must cite both its journal entry and its hold'
        USING ERRCODE = '23502';
    END IF;
    IF NEW.amount_cents IS DISTINCT FROM v_d.amount_cents THEN
      RAISE EXCEPTION
        'provisional credit of % cents does not match the % cents claimed on dispute %',
        NEW.amount_cents, v_d.amount_cents, NEW.dispute_id USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ---- evidence ----------------------------------------------------
  IF v_kind = 'evidence_submitted' AND v_decided THEN
    RAISE EXCEPTION
      'dispute % has already been decided; evidence cannot be filed now', NEW.dispute_id
      USING ERRCODE = '55006';
  END IF;

  -- ---- the network's answer ----------------------------------------
  IF v_kind IN ('won', 'lost', 'withdrawn') THEN
    IF v_decided THEN
      RAISE EXCEPTION 'dispute % has already been decided', NEW.dispute_id
        USING ERRCODE = '55006';
    END IF;
    -- A withdrawal after we advanced money is not a withdrawal, it is a
    -- loss for us: the money has to come back, so the case must be
    -- recorded as lost and resolved through a clawback or a write-off.
    IF v_kind = 'withdrawn' AND v_granted THEN
      RAISE EXCEPTION
        'dispute % has provisional credit outstanding and cannot simply be withdrawn: record it lost, then claw back or write off',
        NEW.dispute_id USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ---- resolution ---------------------------------------------------
  IF v_kind = 'credit_finalized' THEN
    IF NOT EXISTS (SELECT 1 FROM dispute_event
                    WHERE dispute_id = NEW.dispute_id AND kind::text = 'won') THEN
      RAISE EXCEPTION
        'dispute % was not won; a credit cannot be made final', NEW.dispute_id
        USING ERRCODE = '55006';
    END IF;
    -- Won WITH an advance: the hold releases and the credit already on the
    -- books simply becomes spendable.  Won WITHOUT one: the credit is
    -- posted now, final, with no hold.  Either way an entry lands.
    IF NEW.entry_id IS NULL THEN
      RAISE EXCEPTION 'making a credit final must cite the entry that did it'
        USING ERRCODE = '23502';
    END IF;
    IF v_granted AND NEW.hold_id IS NULL THEN
      RAISE EXCEPTION
        'dispute % holds provisional credit; finalising it must cite the hold being released',
        NEW.dispute_id USING ERRCODE = '23502';
    END IF;
  END IF;

  IF v_kind IN ('credit_clawed_back', 'credit_written_off') THEN
    IF NOT EXISTS (SELECT 1 FROM dispute_event
                    WHERE dispute_id = NEW.dispute_id AND kind::text = 'lost') THEN
      RAISE EXCEPTION
        'dispute % was not lost; % does not apply', NEW.dispute_id, v_kind
        USING ERRCODE = '55006';
    END IF;
    IF NOT v_granted THEN
      RAISE EXCEPTION
        'dispute % never advanced provisional credit; there is nothing to % ',
        NEW.dispute_id, v_kind USING ERRCODE = '55006';
    END IF;
    IF NEW.entry_id IS NULL OR NEW.hold_id IS NULL THEN
      RAISE EXCEPTION
        'resolving a lost dispute must cite both the entry and the hold it releases'
        USING ERRCODE = '23502';
    END IF;
    IF NEW.amount_cents IS DISTINCT FROM v_d.amount_cents THEN
      RAISE EXCEPTION
        '% of % cents does not match the % cents advanced on dispute %',
        v_kind, NEW.amount_cents, v_d.amount_cents, NEW.dispute_id USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER dispute_event_lifecycle
  BEFORE INSERT ON dispute_event
  FOR EACH ROW EXECUTE FUNCTION assert_dispute_lifecycle();


-- ---------------------------------------------------------------------
-- 6.  The threshold policy
-- ---------------------------------------------------------------------
--
-- $50.00, one authoriser, on the card rail.
--
-- Why so much lower than ACH's $2,500.  The ACH threshold is set by
-- RECOVERABILITY -- an entry is recallable for two banking days, which
-- bounds the damage.  Provisional credit has no recall window at all: if
-- we advance it and lose, we recover it only from a balance that may not
-- be there months later, and there is no counterparty, no account number
-- and no name to verify against.  The only control that exists is a
-- second person reading the case.
--
-- So the threshold is set by the COST OF THE CONTROL rather than by the
-- size of the loss: below about fifty dollars the fully-loaded cost of an
-- analyst reading a case exceeds the expected loss from advancing it
-- unreviewed, which is why real issuers auto-grant small disputes and
-- review the rest.  A production book would tier it -- auto below $50,
-- one checker to $2,500, two above -- and this table is effective-dated
-- and append-only precisely so that raising it later cannot make today's
-- grants look like control failures.
--
-- `card` is a rail that no person ever instructs, so the payments form
-- already filters this row out (`toPolicyOption` in
-- src/app/(app)/payments/live-source.ts); it appears on the approvals
-- policy panel, which is where a threshold belongs.
INSERT INTO approval_policy (rail, effective_from, threshold_cents, required_approvals, note)
VALUES ('card', DATE '2026-01-01', 5000, 1,
        'Provisional credit of $50.00 or more on a disputed card transaction needs one Corgi approver who did not raise the case and does not work for the disputing business. Unlike an ACH debit there is no recall window: a provisional credit is recovered only from the customer''s balance months later, so the threshold is set by the cost of the review rather than by the size of the loss.')
ON CONFLICT (rail, effective_from) DO NOTHING;


-- ---------------------------------------------------------------------
-- 7.  The fold
-- ---------------------------------------------------------------------
--
-- Status is DERIVED here and stored nowhere, the same way
-- `v_card_auth_state` derives an authorisation's position from its event
-- set.  Ordering is by outcome, not by time: a case that has been
-- resolved is resolved regardless of what was written before it, which is
-- exactly the property the trigger guarantees.
CREATE VIEW v_dispute_state AS
SELECT d.id                          AS dispute_id,
       d.case_ref,
       d.disputed_entry_id,
       d.account_id,
       a.business_id,
       d.memo_account_id,
       d.card_id,
       d.auth_id,
       d.reason,
       d.network,
       d.network_code,
       d.amount_cents,
       d.value_date,
       d.network_outside_date,
       d.raised_by,
       d.raised_at,
       d.policy_id,
       p.threshold_cents,
       p.required_approvals,
       (d.amount_cents >= p.threshold_cents AND p.required_approvals > 0) AS needs_authorization,
       f.authorizations,
       f.granted,
       f.declined,
       f.evidence_count,
       f.won,
       f.lost,
       f.withdrawn,
       f.finalized,
       f.clawed_back,
       f.written_off,
       f.grant_hold_id,
       f.decided_on,
       CASE
         WHEN f.withdrawn   THEN 'withdrawn'
         WHEN f.finalized   THEN 'closed_won'
         WHEN f.clawed_back THEN 'closed_lost_recovered'
         WHEN f.written_off THEN 'closed_lost_written_off'
         WHEN f.won         THEN 'won_pending_finalization'
         WHEN f.lost        THEN 'lost_pending_recovery'
         WHEN f.evidence_count > 0 THEN 'evidence_submitted'
         WHEN f.granted     THEN 'provisional_credit_granted'
         WHEN f.declined    THEN 'provisional_credit_declined'
         WHEN f.authorizations > 0 THEN 'authorized'
         ELSE 'raised'
       END                           AS status,
       (f.withdrawn OR f.finalized OR f.clawed_back OR f.written_off) AS is_closed,
       -- Money actually advanced and still outstanding, read from the
       -- JOURNAL through the events -- never from a column.
       COALESCE(m.advanced_cents, 0) AS advanced_cents,
       COALESCE(h.memo_balance_cents, 0) AS held_cents,
       h.is_released                 AS hold_released,
       -- Days the case has been open against the network's outside date.
       -- Negative means we are past it and the network has still not
       -- answered: the ops alarm, on the screen where alarms belong.
       (d.network_outside_date - CURRENT_DATE) AS days_to_outside_date
  FROM dispute d
  JOIN account a          ON a.id = d.account_id
  JOIN approval_policy p  ON p.id = d.policy_id
  CROSS JOIN LATERAL (
    SELECT
      count(*) FILTER (WHERE e.kind::text = 'provisional_credit_authorized')::integer AS authorizations,
      count(*) FILTER (WHERE e.kind::text = 'evidence_submitted')::integer            AS evidence_count,
      bool_or(e.kind::text = 'provisional_credit_granted')  AS granted,
      bool_or(e.kind::text = 'provisional_credit_declined') AS declined,
      bool_or(e.kind::text = 'won')                         AS won,
      bool_or(e.kind::text = 'lost')                        AS lost,
      bool_or(e.kind::text = 'withdrawn')                   AS withdrawn,
      bool_or(e.kind::text = 'credit_finalized')            AS finalized,
      bool_or(e.kind::text = 'credit_clawed_back')          AS clawed_back,
      bool_or(e.kind::text = 'credit_written_off')          AS written_off,
      -- No max(uuid) exists in Postgres, and there is at most one grant
      -- anyway (the trigger guarantees it), so take the first.
      (ARRAY_AGG(e.hold_id) FILTER (WHERE e.kind::text = 'provisional_credit_granted'))[1]
                                                            AS grant_hold_id,
      max(e.value_date) FILTER (WHERE e.kind::text IN ('won','lost','withdrawn')) AS decided_on
      FROM dispute_event e WHERE e.dispute_id = d.id
  ) f
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_cents * ac.normal_side), 0)::bigint AS advanced_cents
      FROM dispute_event e
      JOIN journal_line l  ON l.entry_id = e.entry_id
      JOIN account      ac ON ac.id = l.account_id AND ac.id = d.account_id
     WHERE e.dispute_id = d.id
  ) m ON true
  LEFT JOIN v_hold_state h ON h.hold_id = f.grant_hold_id;

GRANT SELECT ON v_dispute_state TO corgi_app;

-- Every journal entry a dispute caused, with its lines, in booking order.
-- This is what the EDGE screen renders: the grant on one day and the
-- clawback on another, both standing, neither an edit of the other.
--
-- Two sources, because a grant moves two books and an event cites one
-- entry.  The FINANCIAL entries are cited directly by the events that
-- caused them.  The MEMO entries are reached through the hold, which is
-- what a hold is for -- `journal_entry.hold_id` already ties every memo
-- posting to the hold it opened or released, so no second column on
-- `dispute_event` is needed to find them.
CREATE VIEW v_dispute_ledger AS
WITH dispute_entry AS (
  SELECT de.dispute_id,
         de.kind::text AS event_kind,
         de.occurred_at,
         de.entry_id
    FROM dispute_event de
   WHERE de.entry_id IS NOT NULL
  UNION
  SELECT g.dispute_id,
         'hold_posting'::text AS event_kind,
         e.booking_time       AS occurred_at,
         e.id                 AS entry_id
    FROM dispute_event g
    JOIN journal_entry e ON e.hold_id = g.hold_id AND e.book = 'memo'
   WHERE g.kind::text = 'provisional_credit_granted'
)
SELECT dx.dispute_id,
       dx.event_kind,
       dx.occurred_at,
       e.id                   AS entry_id,
       e.value_date,
       e.booking_seq,
       e.booking_time,
       e.book,
       e.entry_type,
       e.description,
       e.idempotency_key,
       l.ordinal,
       ac.code                AS account_code,
       ac.name                AS account_name,
       ac.business_id,
       l.amount_cents
  FROM dispute_entry dx
  JOIN journal_entry e  ON e.id = dx.entry_id
  JOIN journal_line  l  ON l.entry_id = e.id
  JOIN account       ac ON ac.id = l.account_id;

GRANT SELECT ON v_dispute_ledger TO corgi_app;


-- ---------------------------------------------------------------------
-- 8.  Privileges
-- ---------------------------------------------------------------------
--
-- SELECT and INSERT, matching `hold`, `card_authorization` and
-- `payment_instruction_event`.  No UPDATE, no DELETE, no TRUNCATE -- and
-- the triggers above hold even against the owner, which the grants do
-- not.
GRANT SELECT, INSERT ON dispute, dispute_event TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON dispute, dispute_event FROM corgi_app, PUBLIC;

COMMENT ON TABLE dispute IS
  'One customer claim against one settled card transaction. No status column: status is a fold over dispute_event (v_dispute_state).';
COMMENT ON TABLE dispute_event IS
  'Append-only lifecycle of a dispute. entry_id ties an event to the money it moved; the clawback carries the NETWORK DECISION DATE, not the grant date, because it is a new event and not a correction.';
