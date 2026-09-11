-- =====================================================================
-- 0061  The hold an approved payment should always have placed
-- =====================================================================
--
-- THE DEFECT, MEASURED ON THIS BOOK (2026-09-11, in a rolled-back
-- transaction, against the code as it stood before this file):
--
--   SUBJECT   Pots Integration Fixture Co.
--             2100 account  b86fb38f-e5b4-4c2f-af46-f364562e9911
--             AVAILABLE     $25,000.92
--
--   REQUEST   $20,000.00 ACH        (availableCents checked HERE, once,
--                                    at src/lib/mcp/tool-initiate-payment
--                                    .ts:379 -- and never again)
--   APPROVE   two checkers          AFTER available $25,000.92  <- UNMOVED
--   DRAIN     $24,000.00 leaves the account by any other path
--   RELEASE   releasePayment()      POSTS. $20,000.00 leaves.
--   AFTER     ledger -$18,999.08
--
-- `releasePayment()` had no availability check at all. The comparison
-- lived only at request time, so every approved instruction was an
-- unreserved claim on a balance that anything else was free to spend.
-- One person, no concurrency: request, wait, release.
--
-- ---------------------------------------------------------------------
-- WHAT THIS FILE DOES NOT DO, AND THAT IS THE POINT
-- ---------------------------------------------------------------------
--
-- IT DOES NOT INVENT A RESERVATION, and it does not add a second
-- availability check at release. `ledger_availability()` (0022) is the
-- ONE definition of available balance, five terms, and this migration
-- does not touch it. An approved payment becomes an ordinary `manual`
-- hold on the customer's own 2100 leaf with the memo leg on a house
-- account, posted through `ledger_append()` like every other posting,
-- and the EXISTING hold term picks it up with no change to how that
-- term is computed. This is 0053's shape, one morning later, for the
-- same class of defect: a commitment the system is on the hook for that
-- reserved nothing.
--
-- WHERE THE CHECK MOVES TO. Not to release -- to APPROVAL. A refusal at
-- release is a refusal after the money was promised, and it can only
-- ever say no; a hold placed when the second approver signs withholds
-- the money from that instant, so the drain above is the thing that gets
-- refused and the release still clears. The decision that commits the
-- money is the one that must be able to say "not enough".


-- ---------------------------------------------------------------------
-- 1.  Where an approved payment's hold lives in the chart:  9400
-- ---------------------------------------------------------------------
--
-- A sibling of 9100 (card authorisations), 9200 (uncleared credits) and
-- 9300 (accepted FX commitments): credit-normal, memo book, 9900 memo
-- contra on the other side. HOUSE, not per-business, for exactly the
-- reason 0053 gives at length and does not need restating: both
-- `v_hold_state` and `ledger_availability()` read a hold's memo balance
-- keyed on THE HOLD, not on the account, so two customers sharing one
-- memo leaf cannot contaminate each other's availability. The cost is
-- the same one 0053 took -- the statement's memo lines render from the
-- customer's own 9100/9200 leaves, so this hold does not appear there --
-- and the upgrade path is the same later migration, because no code
-- reads 9400 by any route other than `hold.memo_account_id`.

INSERT INTO account (entity_id, code, name, parent_id, type, book,
                     currency, business_id, rail_control, is_postable)
SELECT e.id, '9400', 'Holds - approved payments awaiting release', p.id,
       'liability', 'memo', 'USD', NULL, NULL, true
  FROM book_entity e
  JOIN account p ON p.entity_id = e.id AND p.code = '9000' AND p.business_id IS NULL
 WHERE NOT EXISTS (
   SELECT 1 FROM account a
    WHERE a.entity_id = e.id AND a.code = '9400' AND a.business_id IS NULL
 );


-- ---------------------------------------------------------------------
-- 2.  The instruction and the hold, bound
-- ---------------------------------------------------------------------
--
-- One row per approved instruction that placed a hold. It exists so the
-- binding is a FOREIGN KEY rather than a naming convention: the hold's
-- `external_ref` carries the instruction id -- `hold_ref UNIQUE (kind,
-- external_ref)` is what makes placing it idempotent under a race -- but
-- a guard cannot join on a string prefix (0040: a guard discriminating
-- on prose).

CREATE TABLE payment_release_hold (
  -- One hold per instruction, for ever.
  instruction_id uuid PRIMARY KEY REFERENCES payment_instruction(id),
  hold_id        uuid NOT NULL UNIQUE REFERENCES hold(id),
  -- The figure withheld, copied on at the moment it was withheld. Not a
  -- second spelling of payment_instruction.amount_cents that could drift
  -- -- that table is append-only and the column cannot move -- but the
  -- number §5's invariant compares the memo book against, so the guard
  -- reads one row instead of a three-table join.
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  placed_at      timestamptz NOT NULL DEFAULT now(),
  placed_by      uuid NOT NULL REFERENCES actor(id)
);

CREATE INDEX payment_release_hold_hold_idx ON payment_release_hold (hold_id);

COMMENT ON TABLE payment_release_hold IS
  'Binds an approved payment instruction to the memo hold its approval placed. '
  'One row per instruction, written in the same transaction as the `approved` '
  'event that completed the policy. Append-only.';

-- A HOLD CANNOT EXIST FOR A PAYMENT NOBODY APPROVED, and it cannot be
-- for a figure the instruction does not name, and it cannot be on
-- somebody else's money.
--
-- The `approved` event is inserted first, in the same transaction, so
-- this trigger can see it. `amount_cents` is re-derived from the
-- instruction rather than trusted from the caller for the same reason
-- 0053 re-derives `sell_cents` from the quote: a hold for a figure
-- nobody agreed to would put that figure into the availability
-- calculation.
CREATE OR REPLACE FUNCTION payment_release_hold_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  p record;
BEGIN
  SELECT pi.amount_cents, pi.account_id
    INTO p
    FROM payment_instruction pi
   WHERE pi.id = NEW.instruction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no payment instruction %', NEW.instruction_id USING ERRCODE = '23503';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM payment_instruction_event ev
     WHERE ev.instruction_id = NEW.instruction_id AND ev.kind = 'approved'
  ) THEN
    RAISE EXCEPTION
      'instruction % has not been approved, so there is nothing to withhold against',
      NEW.instruction_id
      USING ERRCODE = '55006';
  END IF;

  IF NEW.amount_cents <> p.amount_cents THEN
    RAISE EXCEPTION
      'release hold for instruction % is % cents but the instruction is % cents',
      NEW.instruction_id, NEW.amount_cents, p.amount_cents
      USING ERRCODE = '55006';
  END IF;

  -- The hold must be on the account the payment actually leaves.
  -- Withholding one customer's balance against another's payment is the
  -- memo-book shape of the card-token mix-up 0008 §3 exists to prevent.
  IF NOT EXISTS (
    SELECT 1 FROM hold h WHERE h.id = NEW.hold_id AND h.account_id = p.account_id
  ) THEN
    RAISE EXCEPTION
      'the hold for instruction % is not on the account the payment leaves',
      NEW.instruction_id
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER payment_release_hold_preconditions
  BEFORE INSERT ON payment_release_hold
  FOR EACH ROW EXECUTE FUNCTION payment_release_hold_guard();

CREATE TRIGGER payment_release_hold_no_update_delete
  BEFORE UPDATE OR DELETE ON payment_release_hold
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER payment_release_hold_no_truncate
  BEFORE TRUNCATE ON payment_release_hold
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

GRANT SELECT, INSERT ON payment_release_hold TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON payment_release_hold FROM corgi_app, PUBLIC;


-- ---------------------------------------------------------------------
-- 3.  Closure:  ONE condition licenses a permanent row, and it is the
--     posting
-- ---------------------------------------------------------------------
--
-- `hold_closure` is APPEND-ONLY and a row in it is a permanent claim
-- about WHY the money stopped being withheld. 0011 and 0028 both paid
-- for writing one on a condition that could be overtaken. An approved
-- payment's hold comes off in exactly two ways and only one of them
-- writes a row:
--
--   RELEASED - `payment_instruction_event` has a `released` row, which
--      means `releasePayment()` posted the FINANCIAL entry in the same
--      transaction. TERMINAL, and terminal in the strongest sense this
--      system has: the debit against the 2100 leaf now exists in the
--      financial book, so the money is no longer promised, it is gone.
--      `payment_instruction_event` is append-only (0001 §13) and
--      `assert_payment_lifecycle()` refuses a second `released`, so this
--      is an EXISTS over a growing set and an EXISTS never un-fires. A
--      later `returned` or `failed` does not reopen it: those are new
--      money movements with their own postings, not an edit to this one.
--      It gets the `hold_closure` row, `source = 'payment_release'`.
--
--   WITHDRAWN - `payment_instruction_event` has a `rejected` or a
--      `cancelled` row. ALSO TERMINAL, and terminal by the same trigger:
--      `assert_payment_lifecycle()` allows nothing after either
--      (`src/lib/approvals/state.ts` mirrors it -- ALLOWED_NEXT for both
--      is the empty list), the table is append-only, so "this
--      instruction was withdrawn" is a claim that can never be overtaken
--      and the money must stop being withheld at once. It gets a
--      `hold_closure` row, `source = 'payment_withdrawn'`.
--
--      THE CLOCK IS NOT USED HERE, and that is the deliberate part.
--      `hold.available_at` is left NULL: an approved payment has no
--      deadline of its own -- nothing in this system expires an approval
--      -- so inventing one would be a clock nobody agreed to, freeing a
--      customer's committed money at an instant no policy names. 0053
--      could derive a lapse because the settlement window is PRINTED ON
--      THE OFFER. There is no such number here, so the hold comes off
--      only on a fact: a posting, or a withdrawal.
--
-- A THIRD CONDITION IS DELIBERATELY ABSENT: "the customer's available
-- balance has gone negative" is not a release. It is not a fact about
-- the payment at all.

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
      'operator',            -- a human overriding the model (0011 §3)
      'test_harness',        -- a test writing against this shared book
      'fx_settlement',       -- 0053: an accepted FX quote funded its payout
      'payment_release',     -- 0061: an approved payment posted its own debit
      'payment_withdrawn'    -- 0061: an approved payment was rejected/cancelled
    ));


-- ---------------------------------------------------------------------
-- 4.  The regime, and the watermark it is honest about
-- ---------------------------------------------------------------------
--
-- This book already carries approved-and-unreleased instructions, every
-- one of them approved before this migration existed and therefore
-- holding nothing. A guard that went red on arrival for them would be a
-- guard nobody could read, and backfilling holds for them would move
-- availability on a live book to make a view green -- repairing the
-- measurement rather than the thing.
--
-- So the regime has a START INSTANT, it is a row rather than a comment,
-- and the guard ranges over approvals at or after it. 0049's watermark
-- shape, used here for the same reason: the honest scope of a new
-- control is "from when it existed", stated as data.

CREATE TABLE payment_hold_regime (
  singleton      boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  effective_from timestamptz NOT NULL DEFAULT now(),
  note           text NOT NULL
);

INSERT INTO payment_hold_regime (singleton, note) VALUES
  (true,
   'Migration 0061. An approval that completes an instruction''s policy places a memo hold for amount_cents; v_payment_release_unheld ranges over exactly those. Instructions approved before this instant hold nothing and are outside the guard by construction, counted in v_payment_release_census.');

COMMENT ON TABLE payment_hold_regime IS
  'When the approved-payment hold started existing. One row. Read only by '
  'v_payment_release_unheld, so the guard''s population is data rather than a '
  'sentence in a migration.';

GRANT SELECT ON payment_hold_regime TO corgi_app;


-- ---------------------------------------------------------------------
-- 5.  The invariant
-- ---------------------------------------------------------------------
--
-- THE CLAIM: a payment this system has approved and not yet posted is
-- withholding the customer's money, to the cent, for as long as it
-- stands.
--
-- MUST RETURN ZERO ROWS. Nothing repairs what it reports. `finding`
-- says which of three things a row is, because "the hold is wrong" is
-- not an actionable sentence:
--
--   no_hold_placed   an approval completed and no hold went with it.
--                    This is the defect the whole migration is about,
--                    and it is what catches the approval path being
--                    changed back.
--   released_early   the hold exists and something released it while the
--                    payment still stands - a closure row written on a
--                    reversible condition (§3), or a clock set wrong.
--   wrong_amount     the memo book is withholding a figure that is not
--                    the approved amount.
--
-- WHAT IT DELIBERATELY DOES NOT RANGE OVER: released instructions (the
-- hold SHOULD be released and flat, and `v_hold_release_drift` already
-- requires a released hold to be withholding nothing) and withdrawn
-- ones (released by the clock, §3).
CREATE VIEW v_payment_release_unheld AS
SELECT pi.id AS instruction_id,
       acc.business_id,
       b.legal_name,
       pi.amount_cents                          AS approved_cents,
       COALESCE(hs.active_hold_cents, 0)::bigint AS withheld_cents,
       prh.hold_id,
       CASE WHEN prh.instruction_id IS NULL      THEN 'no_hold_placed'
            WHEN COALESCE(hs.is_released, true)  THEN 'released_early'
            ELSE 'wrong_amount'
       END AS finding
  FROM payment_instruction pi
  JOIN account acc ON acc.id = pi.account_id
  LEFT JOIN business b ON b.id = acc.business_id
  CROSS JOIN payment_hold_regime r
  JOIN LATERAL (
    SELECT min(ev.occurred_at) AS approved_at
      FROM payment_instruction_event ev
     WHERE ev.instruction_id = pi.id AND ev.kind = 'approved'
  ) ap ON ap.approved_at IS NOT NULL
  LEFT JOIN payment_release_hold prh ON prh.instruction_id = pi.id
  LEFT JOIN v_hold_state         hs  ON hs.hold_id = prh.hold_id
 WHERE ap.approved_at >= r.effective_from
   -- still standing: approved, not posted, not withdrawn
   AND NOT EXISTS (
     SELECT 1 FROM payment_instruction_event ev
      WHERE ev.instruction_id = pi.id
        AND ev.kind IN ('released', 'submitted', 'rejected', 'cancelled',
                        'settled', 'returned', 'failed'))
   AND COALESCE(hs.active_hold_cents, 0) <> pi.amount_cents;

COMMENT ON VIEW v_payment_release_unheld IS
  'MUST RETURN ZERO ROWS. Every approved, unreleased, unwithdrawn payment made '
  'under the 0061 regime is withholding exactly its approved amount in the memo '
  'book. A row is an overdraft path: money the customer has promised and can '
  'still spend.';

GRANT SELECT ON v_payment_release_unheld TO corgi_app;

-- The census the guard's reach is computed from, so the coverage is
-- printed rather than claimed. Same shape as the other reach views.
CREATE VIEW v_payment_release_census AS
SELECT CASE
         WHEN ap.approved_at < r.effective_from THEN 'predates_the_regime'
         WHEN EXISTS (SELECT 1 FROM payment_instruction_event ev
                       WHERE ev.instruction_id = pi.id
                         AND ev.kind IN ('released','submitted','settled','returned','failed'))
                                                THEN 'released'
         WHEN EXISTS (SELECT 1 FROM payment_instruction_event ev
                       WHERE ev.instruction_id = pi.id
                         AND ev.kind IN ('rejected','cancelled'))
                                                THEN 'withdrawn'
         ELSE 'standing'
       END                                       AS approval_scope,
       count(*)                                  AS instructions,
       COALESCE(SUM(pi.amount_cents), 0)::bigint AS approved_cents
  FROM payment_instruction pi
  CROSS JOIN payment_hold_regime r
  JOIN LATERAL (
    SELECT min(ev.occurred_at) AS approved_at
      FROM payment_instruction_event ev
     WHERE ev.instruction_id = pi.id AND ev.kind = 'approved'
  ) ap ON ap.approved_at IS NOT NULL
 GROUP BY 1;

COMMENT ON VIEW v_payment_release_census IS
  'Every approved instruction, classified by whether v_payment_release_unheld '
  'can see it. Only `standing` is inside that guard; the other three are '
  'outside by construction and this view is how many.';

GRANT SELECT ON v_payment_release_census TO corgi_app;


-- ---------------------------------------------------------------------
-- 6.  What did not change
-- ---------------------------------------------------------------------
--
-- `ledger_availability()` is untouched: not one term added, not one
-- predicate edited. An approved payment's hold is an ordinary `manual`
-- hold and lands in `hold_cents` through the term that was already
-- there. `payment_instruction` and `payment_instruction_event` are
-- untouched: no column, no trigger replaced, no privilege widened.
-- Maker-checker is still `assert_maker_checker()` and nothing here
-- second-guesses it.


-- ---------------------------------------------------------------------
-- 7.  A guard that arrives red does not commit
-- ---------------------------------------------------------------------

DO $$
DECLARE
  v_unheld  bigint;
  v_pop     bigint;
  v_closure bigint;
  r         record;
BEGIN
  -- The chart leaf this migration depends on must exist on every entity.
  SELECT count(*) INTO v_pop FROM book_entity;
  SELECT count(*) INTO v_unheld
    FROM account WHERE code = '9400' AND business_id IS NULL;
  IF v_unheld <> v_pop THEN
    RAISE EXCEPTION
      '0061 refuses to commit: 9400 exists on % of % book entities. The memo home of an approved payment''s hold is not optional.',
      v_unheld, v_pop;
  END IF;

  -- The invariant itself, on arrival.
  SELECT count(*) INTO v_pop FROM v_payment_release_census WHERE approval_scope = 'standing';
  SELECT count(*) INTO v_unheld FROM v_payment_release_unheld;

  IF v_unheld <> 0 THEN
    FOR r IN SELECT finding, count(*) AS n FROM v_payment_release_unheld
              GROUP BY finding ORDER BY n DESC LOOP
      RAISE WARNING '0061: v_payment_release_unheld: % -- % instruction(s)', r.finding, r.n;
    END LOOP;
    RAISE EXCEPTION
      '0061 refuses to commit: v_payment_release_unheld = % of % standing approvals. A guard that arrives red is a finding or a wrong predicate; neither commits unread.',
      v_unheld, v_pop;
  END IF;

  -- The closure vocabulary the release path writes must be legal, or the
  -- release would fail at run time on a CHECK this migration owns.
  SELECT count(*) INTO v_closure
    FROM pg_constraint
   WHERE conrelid = 'hold_closure'::regclass
     AND conname  = 'hold_closure_source_known'
     AND pg_get_constraintdef(oid) LIKE '%payment_release%'
     AND pg_get_constraintdef(oid) LIKE '%payment_withdrawn%';
  IF v_closure <> 1 THEN
    RAISE EXCEPTION
      '0061 refuses to commit: hold_closure_source_known does not admit ''payment_release'' and ''payment_withdrawn'', so the release and withdrawal paths could not close the hold approval placed.';
  END IF;

  RAISE NOTICE '0061: v_payment_release_unheld = 0 of % standing approvals', v_pop;
END $$;
