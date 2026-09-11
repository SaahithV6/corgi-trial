-- =====================================================================
-- 0049  The day that was priced before it closed
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- WHAT HAPPENED, MEASURED
-- ---------------------------------------------------------------------
--
-- docs/ACCRUAL.md §16 defines the interest basis as "the settled ledger
-- balance at the END of each business date".  `runAccrual()` refused a
-- `bookDate` in the FUTURE (§9) and allowed `bookDate = today`, which
-- was also the cron's default.  A date that has not ended has no
-- end-of-day balance, so what the tick actually priced on an open date
-- was THE BALANCE AT THE INSTANT IT RAN.
--
-- `interest_day` is UNIQUE (schedule_id, accrual_date).  That index is
-- §5's whole exactly-once guarantee -- and it is the same index that
-- makes a mid-day guess permanent, because a re-price is not
-- expressible as a second interest day.
--
-- Five enrolments were priced that way on 2026-09-11, between 00:21:16
-- and 00:21:19 America/New_York, at booking watermarks 2262-2266:
--
--   business                     priced on        at wm   posted
--   Pots Integration Fixture Co.    $25,000.06     2262      86c credit
--   Kettle & Crumb Bakery LLC       $31,656.67     2263     108c credit
--   Ridgeline Robotics, Inc.        $33,843.03     2264     116c credit
--   Holds Integration Fixture Co.  $145,315.17     2265     498c credit
--   Hold Fuzzer Fixture Co.        $499,854.26     2266    1712c credit
--
-- By watermark 5568 the same five value dates stood at $25,000.92,
-- $45,866.63, $58,638.31, -$858,941.45 and $534,030.87.  ONE OF THEM
-- CHANGED SIGN.  Entry `47ad3ebe-1b69-4c6d-9c9a-bdb25d0fbf0a` pays
-- Holds Integration 498c of CREDIT interest out of `5400` for a business
-- date that account closed $858,941.45 overdrawn -- a day worth roughly
-- $423.53 CHARGED to `4400`, in the other direction.  Both the amount
-- and the side are wrong, and the posting is immutable.
--
-- ---------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES, AND WHAT IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------
--
-- It does NOT repair the five rows.  It cannot, and neither can anything
-- else today, and the reason is the whole argument:
--
--     ALL FIVE ARE VALUE-DATED 2026-09-11, WHICH IS TODAY.
--
-- The correction has to book what the day ACTUALLY closed at.  The day
-- has not closed.  Any figure read now is a mid-day figure, which is the
-- defect itself -- committed a second time, deliberately, by the repair.
-- It is not hypothetical: the table above was measured at watermark 5568
-- and three of its five figures had already moved by watermark 5859 a
-- few hours later ($534,030.87 -> $527,828.87, $45,866.63 -> $45,301.36,
-- $58,638.31 -> $58,346.31).  A correction computed from a moving number
-- is a second wrong number with a better story.
--
-- So this migration ships the three things that ARE available before the
-- date closes, and every one of them is a thing the correction needs:
--
--   §1-§2  THE GUARD.  `interest_posting` now records the BOOK DATE its
--          basis was read on, Postgres assigns it rather than the job,
--          and `assert_interest_posting()` refuses any posting whose
--          day had not closed.  The defect becomes unrepresentable
--          rather than merely absent from one code path.
--
--   §4     THE MARKER.  `v_interest_priced_before_close` reports every
--          day that was priced early, with the basis and watermark it
--          WAS priced at beside the basis and watermark the same date
--          stands at NOW -- recomputed on every read, never stored.  The
--          book carries its own correction where a reader will find it.
--
--   §3     THE SHAPE A CORRECTION HAS TO TAKE.  `interest_adjustment`,
--          the product docs/ACCRUAL.md §19 named and did not build.  A
--          re-price is not a second `interest_day` -- reaching around
--          that index is the one thing that must not happen -- so the
--          adjustment is a DIFFERENT CLAIM ABOUT THE SAME DAY, with its
--          own claim space, its own generated key
--          `interest-adj:<enrolment>:<date>:<watermark>`, every
--          arithmetic relation re-derived by the database, and the
--          journal's own `reversal`/`rebook` lineage carrying the money
--          at the ORIGINAL value date.  It stores NO BALANCE -- the
--          first draft did, `scripts/dbcheck.mjs` check 5 failed it on
--          this database, and §3 records why the guard was right.
--
--          AND IT OBEYS THE RULE IT EXISTS TO ENFORCE.  An adjustment
--          for a date that has not closed is refused, by a CHECK over
--          two columns of its own row and by its trigger.  The fix for
--          pricing an open day is ONE rule, and the repair path is not
--          exempt from it.
--
-- `scripts/repair-0049-mispriced-interest.mjs` is the operator's end of
-- §3, ranging over §5.  Run before midnight America/New_York it refuses every row and
-- says why; run after, it corrects all five at value date 2026-09-11.
--
-- ---------------------------------------------------------------------
-- WHAT IS NOT TOUCHED, AND WHY
-- ---------------------------------------------------------------------
--
-- THE FEE LEG.  `accrual_day` takes no guard here and must not.  A
-- platform fee is `F`, `N` and `d` -- a price, a calendar and an ordinal
-- (§2).  It reads no balance, so an open day cannot make it wrong, and
-- holding a correct number back buys nothing.  The asymmetry between the
-- two legs of one tick is the point: the leg that reads a balance waits
-- for the balance to exist, and the leg that does not, does not.
--
-- THE FIVE ROWS THEMSELVES.  Nothing here updates or deletes them.  They
-- are immutable and they stay exactly as written; what changes is that
-- the book can now SAY what is wrong with them and, from tomorrow,
-- express the correction.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The column: which book date the basis was read on
-- ---------------------------------------------------------------------
--
-- `observed_booking_seq` already records WHERE IN THE LEDGER the basis
-- was read.  What it cannot say is WHETHER THE DATE HAD ENDED when it
-- was read, and that is the question these five rows failed.  A
-- watermark is a position in a total order, not a wall clock; 2266 is
-- not visibly "00:21 on the morning of the day being priced".
--
-- NULLABLE, deliberately.  Every row written before this migration gets
-- NULL rather than a backfilled `book_date(now())`, because that value
-- would be a fabrication about a past event -- exactly what 0047 §1
-- refused to do to a value date.  NULL here reads "this row predates
-- 0049 and the question was not recorded"; `v_interest_priced_before_close`
-- answers it for those rows from `interest_day.claimed_at` instead.
--
-- Owned by Postgres.  The DEFAULT fills it and §2's trigger OVERWRITES
-- whatever the caller supplied, so there is no value here for a job to
-- state wrongly.  16.1's rule holds: this is evidence, not a balance.

ALTER TABLE interest_posting
  ADD COLUMN basis_book_date date;

ALTER TABLE interest_posting
  ALTER COLUMN basis_book_date SET DEFAULT book_date(now());

COMMENT ON COLUMN interest_posting.basis_book_date IS
  'The BOOK DATE (America/New_York) on which the basis was read. Assigned by assert_interest_posting(), never by the job. Must be strictly later than the accrual date: a business date is priced once it has CLOSED. NULL on rows written before migration 0049.';


-- ---------------------------------------------------------------------
-- 2.  The guard: a posting whose day has not closed is refused
-- ---------------------------------------------------------------------
--
-- 0024 §13's `assert_interest_posting()`, unchanged except for the block
-- marked 0049.  Replaced in full rather than wrapped, because a second
-- trigger asking half of the same question is how two definitions of one
-- rule start drifting -- DECISIONS 024's lesson, and §6's.
--
-- WHY THE CHECK LIVES ON THE POSTING AND NOT ON THE CLAIM.  Two reasons,
-- and the second is the load-bearing one:
--
--   1. The posting is where the BASIS is.  A claim is a date and a
--      schedule; it prices nothing.  The thing that must be
--      unrepresentable is "a basis read from an open day", and that
--      sentence is about this row.
--
--   2. `scripts/dbcheck.mjs --prove` reaches the `v_interest_ledger_drift`
--      failure state by inserting an `interest_day` for `max(accrual_date)
--      + 1` -- which on this book is TOMORROW -- with
--      `interest_posting_lifecycle` deliberately disabled.  A guard on
--      the CLAIM would refuse that insert and silently remove a prover,
--      leaving `--prove` a check short with nothing saying so.  A guard
--      on the POSTING sits inside the trigger the prover already turns
--      off, on purpose, for a reason it already states.  The guard keeps
--      its teeth against the product and takes none away from the proof.
--
-- The tick never gets this far: `interestPricingHorizon()` in
-- `src/lib/accrual/interest-store.ts` stops the window at
-- `book_date(now()) - 1`, so an open date is not in the due list at all.
-- This is the layer that survives that function being deleted.

CREATE OR REPLACE FUNCTION assert_interest_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_day      interest_day%ROWTYPE;
  v_sched    interest_schedule%ROWTYPE;
  v_policy   interest_rate_policy%ROWTYPE;
  v_entry    journal_entry%ROWTYPE;
  v_basis    bigint;
  v_expected integer;
  v_deposit  bigint;
  v_income   bigint;
  v_expense  bigint;
  v_lines    int;
BEGIN
  SELECT * INTO v_day   FROM interest_day      WHERE id = NEW.interest_day_id;
  SELECT * INTO v_sched FROM interest_schedule WHERE id = v_day.schedule_id;

  -- ==== 0049: THE BUSINESS DATE MUST HAVE ENDED =======================
  --
  -- The basis is the settled balance at the END of a business date. A
  -- date that has not ended does not have one, and UNIQUE (schedule_id,
  -- accrual_date) means whatever is frozen here can never be taken back.
  --
  -- Postgres assigns the column; the caller does not get a say.
  NEW.basis_book_date := book_date(now());

  IF NEW.basis_book_date <= v_day.accrual_date THEN
    RAISE EXCEPTION
      'refusing to price % on %: the basis is the settled balance at the END of a business date, and % has not closed. interest_day is UNIQUE (schedule_id, accrual_date), so a mid-day figure stored here could never be re-priced. The tick prices a date on the first run after it closes.',
      v_day.accrual_date, NEW.basis_book_date, v_day.accrual_date
      USING ERRCODE = '55006';
  END IF;
  -- ====================================================================

  -- ---- the rate card row that priced it -----------------------------
  --
  -- THIS is "a rate change must not retroactively re-price yesterday",
  -- enforced at the moment the row is written. The policy is resolved
  -- from the tier and THE ACCRUAL DATE, so a replay of an old date
  -- resolves the old rate and a posting that cites any other row is
  -- refused.
  v_policy := interest_rate_at(v_sched.rate_tier, v_day.accrual_date);

  IF v_policy.id IS NULL THEN
    RAISE EXCEPTION 'rate card % has no row effective on or before %',
      v_sched.rate_tier, v_day.accrual_date USING ERRCODE = '55006';
  END IF;

  IF NEW.policy_id IS DISTINCT FROM v_policy.id THEN
    RAISE EXCEPTION
      'posting cites rate policy %, but % on % resolves to % (effective %)',
      NEW.policy_id, v_sched.rate_tier, v_day.accrual_date,
      v_policy.id, v_policy.effective_from USING ERRCODE = '42501';
  END IF;

  IF NEW.day_count IS DISTINCT FROM v_policy.day_count_denominator THEN
    RAISE EXCEPTION 'posting uses a /% day count but policy % is /%',
      NEW.day_count, v_policy.id, v_policy.day_count_denominator
      USING ERRCODE = '42501';
  END IF;

  v_expected := CASE NEW.side
                  WHEN 'credit'    THEN v_policy.credit_rate_bps
                  WHEN 'overdraft' THEN v_policy.overdraft_rate_bps
                  ELSE 0
                END;

  IF NEW.rate_bps IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'posting prices the % side at % bps but policy % says % bps',
      NEW.side, NEW.rate_bps, v_policy.id, v_expected USING ERRCODE = '42501';
  END IF;

  -- ---- the basis, re-derived rather than believed --------------------
  --
  -- 0022's ledger_settled_cents IS the balance definition in this
  -- system. Asking it again here means the stored basis is a figure the
  -- database agrees with, not a figure the job asserted.
  v_basis := ledger_settled_cents(v_sched.account_id, v_day.accrual_date, NEW.observed_booking_seq);

  IF NEW.basis_balance_cents IS DISTINCT FROM v_basis THEN
    RAISE EXCEPTION
      'posting prices a balance of %c on % at watermark %, but the ledger says %c',
      NEW.basis_balance_cents, v_day.accrual_date, NEW.observed_booking_seq, v_basis
      USING ERRCODE = '42501';
  END IF;

  IF NEW.disposition::text = 'skipped' THEN
    RETURN NEW;
  END IF;

  -- ---- the journal entry IS this accrual -----------------------------
  SELECT * INTO v_entry FROM journal_entry WHERE id = NEW.entry_id;
  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'posting for day % cites entry % which does not exist',
      NEW.interest_day_id, NEW.entry_id USING ERRCODE = '55006';
  END IF;

  -- The one that makes this exactly-once rather than merely careful.
  IF v_entry.idempotency_key IS DISTINCT FROM v_day.idempotency_key THEN
    RAISE EXCEPTION
      'day % derives key %, but entry % carries % -- these are not the same accrual',
      NEW.interest_day_id, v_day.idempotency_key, v_entry.id, v_entry.idempotency_key
      USING ERRCODE = '42501';
  END IF;

  -- VALUE DATE IS THE ACCRUAL DATE, NOT THE RUN DATE.
  IF v_entry.value_date IS DISTINCT FROM v_day.accrual_date THEN
    RAISE EXCEPTION
      'entry % has value date % but the interest is for % -- interest books at the date it accrued for',
      v_entry.id, v_entry.value_date, v_day.accrual_date USING ERRCODE = '42501';
  END IF;

  IF v_entry.book::text <> 'financial' THEN
    RAISE EXCEPTION 'entry % is in the % book; interest is real money',
      v_entry.id, v_entry.book USING ERRCODE = '42501';
  END IF;

  -- ---- and the entry must be the RIGHT SHAPE for its side ------------
  SELECT count(*),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE l.account_id = v_sched.account_id), 0),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE a.code = '4400'), 0),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE a.code = '5400'), 0)
    INTO v_lines, v_deposit, v_income, v_expense
    FROM journal_line l JOIN account a ON a.id = l.account_id
   WHERE l.entry_id = v_entry.id;

  IF NEW.side = 'credit' THEN
    IF v_lines <> 2 OR v_deposit <> -NEW.amount_cents
       OR v_expense <> NEW.amount_cents OR v_income <> 0 THEN
      RAISE EXCEPTION
        'entry % is not this credit-interest accrual: % lines, %c to the deposit account, %c to 5400, %c to 4400; expected 2, %c, %c and 0',
        v_entry.id, v_lines, v_deposit, v_expense, v_income,
        -NEW.amount_cents, NEW.amount_cents USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_lines <> 2 OR v_deposit <> NEW.amount_cents
       OR v_income <> -NEW.amount_cents OR v_expense <> 0 THEN
      RAISE EXCEPTION
        'entry % is not this overdraft-interest accrual: % lines, %c to the deposit account, %c to 4400, %c to 5400; expected 2, %c, %c and 0',
        v_entry.id, v_lines, v_deposit, v_income, v_expense,
        NEW.amount_cents, -NEW.amount_cents USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_interest_posting() SET search_path = public, pg_temp;

COMMENT ON FUNCTION assert_interest_posting() IS
  'The lifecycle gate for an interest posting. 0024 §13, plus 0049s closure check: the accrual date must have ENDED before its balance may be read, and basis_book_date is assigned here rather than supplied.';



-- ---------------------------------------------------------------------
-- 3.  The correction: a different claim about the same day
-- ---------------------------------------------------------------------
--
-- THE MODEL PROBLEM, STATED BEFORE IT IS SOLVED.  A re-price is not
-- expressible as a second `interest_day`: UNIQUE (schedule_id,
-- accrual_date) refuses it, and that index is not an obstacle to be
-- worked around -- it is the exactly-once guarantee the whole tick rests
-- on.  Anything that loosens it to permit a correction destroys the
-- property that made the defect detectable in the first place.
--
-- The way through is to notice that the adjustment IS NOT THE SAME KIND
-- OF FACT as the day.  `interest_day` claims "this enrolment's 11th of
-- September has been decided", and that claim is true and stays true --
-- the day WAS decided, wrongly.  The adjustment claims something else:
-- "the decision recorded for that day priced a balance that was not that
-- date's closing balance, and at watermark W the date was worth this
-- instead".  Two different sentences about one day, so two claim spaces,
-- and the day's uniqueness is untouched.
--
-- The grain is therefore (interest_day, repriced_at_seq), which is
-- exactly the key docs/ACCRUAL.md §19 named without building:
--
--     interest-adj:<enrolment>:<date>:<watermark>
--
-- and the watermark in the key is doing real work.  It says WHICH answer
-- to "what did that date close at" this correction was computed from, so
-- a replay of the same repair re-derives the same key and writes
-- nothing, while a genuinely later re-measurement is a different fact
-- with a different key rather than a silent overwrite.
--
-- THE MONEY IS THE JOURNAL'S OWN CORRECTION MACHINERY, not a second one.
-- 0001 already has `entry_type` ('original','reversal','rebook'),
-- `reverses_entry_id`, `correction_group_id`, a UNIQUE index making an
-- entry reversible AT MOST ONCE, and `assert_reversal_is_exact()`
-- forcing a reversal to carry the ORIGINAL's value date and to be its
-- exact arithmetic negation account by account.  That is the brief's
-- bitemporal correction test, already enforced.  This table does not
-- move money; it records WHY those entries exist.
--
-- WHY A REVERSAL PLUS A REBOOK AND NOT ONE NETTING ENTRY.  A net entry
-- for Holds Integration would be arithmetically equivalent and would
-- hide the two facts a reader needs: that 498c of credit interest was
-- paid and taken back, and that overdraft interest was charged.  Those
-- land on DIFFERENT ACCOUNTS -- `5400` and `4400` -- and a netted entry
-- would have to pick one, which is the error `4300`'s note forbids:
-- netting variance into an account makes a spread look like a price.
--
-- ---------------------------------------------------------------------
-- WHY THIS TABLE DOES NOT COPY `interest_posting`'s STORED WORKING
-- ---------------------------------------------------------------------
--
-- The obvious shape is `interest_posting`'s: store the basis, the two
-- integers of the fraction, the quotient, the remainder and the rounding
-- direction, and re-derive all eight relations in a CHECK.  That shape
-- was written, applied to this database, and removed, because
-- `scripts/dbcheck.mjs` check 5 immediately failed on it:
--
--     FAIL  no stored balance column
--           — interest_adjustment.basis_balance_cents
--
-- Check 5's exemption list is "a `(table, column)` PAIR, never a
-- pattern" (0024 §16.1), and the ONE interest exemption it grants is
-- paid for by check 5b, which recomputes every stored basis from the
-- journal at the watermark the row recorded.  A second table claiming
-- the same exemption needs a second 5b, and a new money table whose
-- first act is to widen the ledger's own anti-drift check is the wrong
-- trade.  The guard was right and the first design was wrong.
--
-- So THE BASIS IS NOT STORED HERE AT ALL, and nothing derived from it is
-- either -- no numerator, which is the balance times the rate and would
-- have been the same number wearing a hat.  What is stored is
-- `repriced_at_seq`, and the basis is
--
--     ledger_settled_cents(account, accrual_date, repriced_at_seq)
--
-- which is frozen for all time because `booking_seq` is monotonic and
-- the journal is append-only.  That is the SAME reproducibility argument
-- 0024 §16.1 makes for the stored column, arriving at the stronger
-- conclusion: if the number can be re-derived from immutable rows, do
-- not keep a copy of it.
--
-- The cost is that the eight arithmetic relations cannot be a CHECK
-- here, because a CHECK may not read another table and the operand it
-- would need lives in the journal.  They are re-derived by the trigger
-- instead, and then asked AGAIN of the live book on every read by
-- `v_interest_adjustment` and `v_interest_adjustment_drift`.  A CHECK
-- fires once, at insert; a drift view re-asks for ever.

CREATE TABLE interest_adjustment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  interest_day_id     uuid NOT NULL REFERENCES interest_day(id),

  -- Denormalised from the day and re-checked by the trigger against it.
  -- Present for ONE reason: a GENERATED column's expression may read no
  -- other table, and §19's key is spelt from the enrolment and the date.
  -- The trigger refuses any row where these two disagree with the day,
  -- so there is no second copy that can drift -- only a second spelling
  -- that must match.
  schedule_id         uuid NOT NULL REFERENCES interest_schedule(id),
  accrual_date        date NOT NULL,

  -- THE WATERMARK THE CORRECTED BASIS WAS READ AT, and the only handle
  -- on that basis this row keeps.  Read AFTER the reversal is posted, so
  -- the original and its reversal are both inside it and cancel exactly
  -- -- which makes the corrected basis "what the date closed at as if
  -- the wrong entry had never happened", through ledger_settled_cents()
  -- and with no hand arithmetic anywhere.  The rebook is posted after
  -- this is read and is therefore outside its own basis, exactly as
  -- basisAt() arranges for an ordinary day.
  repriced_at_seq     bigint NOT NULL CHECK (repriced_at_seq >= 0),

  idempotency_key     text GENERATED ALWAYS AS (
    'interest-adj:' || schedule_id::text || ':'
      || lpad(EXTRACT(YEAR  FROM accrual_date)::int::text, 4, '0') || '-'
      || lpad(EXTRACT(MONTH FROM accrual_date)::int::text, 2, '0') || '-'
      || lpad(EXTRACT(DAY   FROM accrual_date)::int::text, 2, '0') || ':'
      || repriced_at_seq::text
  ) STORED,

  -- ---- what the day, once closed, was actually worth ----------------
  --
  -- The DECISION, not its operands. Every one of these is re-derived by
  -- the trigger from the basis at `repriced_at_seq` and the rate card
  -- `interest_rate_at()` resolves for `accrual_date`, and a cent of
  -- disagreement refuses the row.
  side                interest_side NOT NULL,
  policy_id           uuid NOT NULL REFERENCES interest_rate_policy(id),
  rate_bps            integer NOT NULL CHECK (rate_bps BETWEEN 0 AND 10000),
  day_count           integer NOT NULL CHECK (day_count IN (360, 365)),
  rounding            interest_rounding NOT NULL,
  amount_cents        bigint NOT NULL CHECK (amount_cents >= 0),

  -- ---- the entries, and the group that ties them --------------------
  original_entry_id   uuid NOT NULL REFERENCES journal_entry(id),
  reversal_entry_id   uuid NOT NULL REFERENCES journal_entry(id),
  -- NULL when the closed day prices to zero cents: the wrong posting is
  -- reversed and there is nothing to re-book, because postEntry() refuses
  -- a zero-amount line and is right to.
  rebook_entry_id     uuid REFERENCES journal_entry(id),
  correction_group_id uuid NOT NULL,

  adjusted_at         timestamptz NOT NULL DEFAULT now(),
  -- Assigned by the trigger, like basis_book_date. Paired with
  -- accrual_date on the same row, which is what lets the closure rule be
  -- a real CHECK here rather than only a trigger.
  adjusted_on_book_date date NOT NULL DEFAULT book_date(now()),
  adjusted_by_run     text NOT NULL CHECK (length(btrim(adjusted_by_run)) > 0),
  reason              text NOT NULL CHECK (length(btrim(reason)) > 0),

  -- At most one adjustment per day per repriced watermark. A replay of
  -- the same repair writes nothing; a second, genuinely later
  -- measurement is a different row rather than an overwrite.
  CONSTRAINT interest_adjustment_once     UNIQUE (interest_day_id, repriced_at_seq),
  CONSTRAINT interest_adjustment_key_once UNIQUE (idempotency_key),

  -- THE RULE THIS TABLE EXISTS TO ENFORCE, APPLIED TO ITSELF. A
  -- correction may not be computed from an open business date either.
  -- Both operands are columns of this row, so it is a CHECK and not a
  -- convention.
  CONSTRAINT interest_adjustment_after_close CHECK (adjusted_on_book_date > accrual_date),

  CONSTRAINT interest_adjustment_shape CHECK (
       (amount_cents > 0 AND side <> 'flat' AND rebook_entry_id IS NOT NULL)
    OR (amount_cents = 0 AND rebook_entry_id IS NULL)
  )
);

CREATE INDEX interest_adjustment_day_idx  ON interest_adjustment (interest_day_id);
CREATE INDEX interest_adjustment_date_idx ON interest_adjustment (accrual_date DESC, schedule_id);

COMMENT ON TABLE interest_adjustment IS
  'The interest adjustment docs/ACCRUAL.md §19 named: a reversal plus a re-book at the ORIGINAL value date, for a day whose recorded basis was not that dates closing balance. A different claim about the same day, so it has its own claim space and interest_day UNIQUE (schedule_id, accrual_date) is untouched. Stores no balance: the basis is ledger_settled_cents(account, accrual_date, repriced_at_seq), derived on every read.';
COMMENT ON COLUMN interest_adjustment.repriced_at_seq IS
  'The booking watermark the corrected basis was read at -- after the reversal, so the wrong entry and its reversal are both inside it and cancel. Part of the idempotency key: WHICH answer to "what did that date close at" this correction was computed from.';
COMMENT ON CONSTRAINT interest_adjustment_after_close ON interest_adjustment IS
  'A correction may not be computed from an open business date either. The fix for pricing an open day is one rule, and the repair path is not exempt from it.';


CREATE FUNCTION assert_interest_adjustment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_day      interest_day%ROWTYPE;
  v_sched    interest_schedule%ROWTYPE;
  v_post     interest_posting%ROWTYPE;
  v_policy   interest_rate_policy%ROWTYPE;
  v_rev      journal_entry%ROWTYPE;
  v_reb      journal_entry%ROWTYPE;
  v_orig     journal_entry%ROWTYPE;
  v_basis    bigint;
  v_expected integer;
  v_deposit  bigint;
  v_income   bigint;
  v_expense  bigint;
  v_lines    int;
BEGIN
  SELECT * INTO v_day   FROM interest_day      WHERE id = NEW.interest_day_id;
  SELECT * INTO v_sched FROM interest_schedule WHERE id = v_day.schedule_id;
  SELECT * INTO v_post  FROM interest_posting  WHERE interest_day_id = NEW.interest_day_id;

  -- ---- the denormalised key parts must BE the day's ------------------
  IF NEW.schedule_id IS DISTINCT FROM v_day.schedule_id
     OR NEW.accrual_date IS DISTINCT FROM v_day.accrual_date THEN
    RAISE EXCEPTION
      'adjustment names enrolment % / date % but day % is enrolment % / date %',
      NEW.schedule_id, NEW.accrual_date, NEW.interest_day_id,
      v_day.schedule_id, v_day.accrual_date USING ERRCODE = '42501';
  END IF;

  -- ---- the closure rule, applied to the correction -------------------
  NEW.adjusted_on_book_date := book_date(now());
  IF NEW.adjusted_on_book_date <= NEW.accrual_date THEN
    RAISE EXCEPTION
      'refusing to correct % on %: the corrected basis is the settled balance at the END of that date and % has not closed. Correcting a mid-day price with a second mid-day price is the same defect twice.',
      NEW.accrual_date, NEW.adjusted_on_book_date, NEW.accrual_date
      USING ERRCODE = '55006';
  END IF;

  -- ---- there must be a wrong posting to correct ----------------------
  IF v_post.interest_day_id IS NULL OR v_post.disposition::text <> 'posted' THEN
    RAISE EXCEPTION
      'day % has no POSTED interest to adjust', NEW.interest_day_id
      USING ERRCODE = '55006';
  END IF;

  IF NEW.original_entry_id IS DISTINCT FROM v_post.entry_id THEN
    RAISE EXCEPTION
      'adjustment cites original entry %, but day % posted entry %',
      NEW.original_entry_id, NEW.interest_day_id, v_post.entry_id
      USING ERRCODE = '42501';
  END IF;

  -- ---- the rate card, resolved on the ACCRUAL date as always ---------
  v_policy := interest_rate_at(v_sched.rate_tier, NEW.accrual_date);
  IF v_policy.id IS NULL THEN
    RAISE EXCEPTION 'rate card % has no row effective on or before %',
      v_sched.rate_tier, NEW.accrual_date USING ERRCODE = '55006';
  END IF;
  IF NEW.policy_id IS DISTINCT FROM v_policy.id THEN
    RAISE EXCEPTION
      'adjustment cites rate policy %, but % on % resolves to %',
      NEW.policy_id, v_sched.rate_tier, NEW.accrual_date, v_policy.id
      USING ERRCODE = '42501';
  END IF;
  IF NEW.day_count IS DISTINCT FROM v_policy.day_count_denominator THEN
    RAISE EXCEPTION 'adjustment uses a /% day count but policy % is /%',
      NEW.day_count, v_policy.id, v_policy.day_count_denominator
      USING ERRCODE = '42501';
  END IF;

  -- ---- THE CORRECTED BASIS, DERIVED AND NEVER STORED -----------------
  --
  -- The row keeps `repriced_at_seq` and nothing else about the balance.
  -- Everything below is re-derived here from 0022's canonical function
  -- and 0024's arithmetic functions -- the same bodies the ordinary tick
  -- runs through, so there is no second implementation of the rule.
  v_basis := ledger_settled_cents(v_sched.account_id, NEW.accrual_date, NEW.repriced_at_seq);

  IF NEW.side IS DISTINCT FROM interest_side_of(v_basis) THEN
    RAISE EXCEPTION
      'adjustment books the % side, but % closed % at %c, which is the % side',
      NEW.side, v_sched.account_id, NEW.accrual_date, v_basis,
      interest_side_of(v_basis) USING ERRCODE = '42501';
  END IF;

  v_expected := CASE NEW.side
                  WHEN 'credit'    THEN v_policy.credit_rate_bps
                  WHEN 'overdraft' THEN v_policy.overdraft_rate_bps
                  ELSE 0
                END;
  IF NEW.rate_bps IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION
      'adjustment prices the % side at % bps but policy % says % bps',
      NEW.side, NEW.rate_bps, v_policy.id, v_expected USING ERRCODE = '42501';
  END IF;

  IF NEW.rounding IS DISTINCT FROM interest_rounding_of(
       interest_numerator(v_basis, NEW.rate_bps), interest_denominator(NEW.day_count)) THEN
    RAISE EXCEPTION
      'adjustment records rounding %, but %/% rounds %',
      NEW.rounding, interest_numerator(v_basis, NEW.rate_bps),
      interest_denominator(NEW.day_count),
      interest_rounding_of(interest_numerator(v_basis, NEW.rate_bps),
                           interest_denominator(NEW.day_count))
      USING ERRCODE = '42501';
  END IF;

  IF NEW.amount_cents IS DISTINCT FROM
       interest_daily_cents(v_basis, NEW.rate_bps, NEW.day_count) THEN
    RAISE EXCEPTION
      'adjustment posts %c, but % bps ACT/% on %c for one day is %c',
      NEW.amount_cents, NEW.rate_bps, NEW.day_count, v_basis,
      interest_daily_cents(v_basis, NEW.rate_bps, NEW.day_count)
      USING ERRCODE = '42501';
  END IF;

  -- ---- the reversal IS the reversal of that original -----------------
  --
  -- assert_reversal_is_exact() has already forced the negation and the
  -- value date at ledger_append time; what is checked here is that this
  -- row is not citing SOME OTHER reversal.
  SELECT * INTO v_orig FROM journal_entry WHERE id = NEW.original_entry_id;
  SELECT * INTO v_rev  FROM journal_entry WHERE id = NEW.reversal_entry_id;

  IF v_rev.id IS NULL OR v_rev.entry_type::text <> 'reversal'
     OR v_rev.reverses_entry_id IS DISTINCT FROM NEW.original_entry_id THEN
    RAISE EXCEPTION
      'entry % is not the reversal of %', NEW.reversal_entry_id, NEW.original_entry_id
      USING ERRCODE = '42501';
  END IF;

  IF NEW.correction_group_id IS DISTINCT FROM v_orig.correction_group_id
     OR v_rev.correction_group_id IS DISTINCT FROM v_orig.correction_group_id THEN
    RAISE EXCEPTION
      'the correction group must be the original entry group %',
      v_orig.correction_group_id USING ERRCODE = '42501';
  END IF;

  -- THE WATERMARK MUST INCLUDE THE REVERSAL. Otherwise the corrected
  -- basis still carries the wrong entry and the re-book prices a balance
  -- that includes the money it is replacing.
  IF NEW.repriced_at_seq < v_rev.booking_seq THEN
    RAISE EXCEPTION
      'the corrected basis was read at watermark % but the reversal books at % -- the basis must be read AFTER the reversal, so the wrong entry and its reversal cancel inside it',
      NEW.repriced_at_seq, v_rev.booking_seq USING ERRCODE = '42501';
  END IF;

  -- ---- a zero-cent correction has no re-book ------------------------
  IF NEW.rebook_entry_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_reb FROM journal_entry WHERE id = NEW.rebook_entry_id;
  IF v_reb.id IS NULL OR v_reb.entry_type::text <> 'rebook' THEN
    RAISE EXCEPTION 'entry % is not a rebook', NEW.rebook_entry_id
      USING ERRCODE = '42501';
  END IF;
  IF v_reb.correction_group_id IS DISTINCT FROM v_orig.correction_group_id THEN
    RAISE EXCEPTION
      'the rebook must carry the original correction group %',
      v_orig.correction_group_id USING ERRCODE = '42501';
  END IF;

  -- VALUE DATE IS THE ORIGINAL DAY'S. The whole bitemporal requirement:
  -- 11 September's statement must show 11 September's corrected number.
  IF v_reb.value_date IS DISTINCT FROM NEW.accrual_date THEN
    RAISE EXCEPTION
      'rebook % has value date % but the interest is for % -- a correction books at the date it is correcting',
      v_reb.id, v_reb.value_date, NEW.accrual_date USING ERRCODE = '42501';
  END IF;
  IF v_reb.book::text <> 'financial' THEN
    RAISE EXCEPTION 'rebook % is in the % book; interest is real money',
      v_reb.id, v_reb.book USING ERRCODE = '42501';
  END IF;

  -- ---- and the rebook must be the RIGHT SHAPE for the CORRECTED side -
  --
  -- This is the clause that makes the sign flip safe. Holds Integration
  -- was paid on 5400 and owes on 4400; if the repair got the side
  -- backwards this refuses the row and the whole correction rolls back.
  SELECT count(*),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE l.account_id = v_sched.account_id), 0),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE a.code = '4400'), 0),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE a.code = '5400'), 0)
    INTO v_lines, v_deposit, v_income, v_expense
    FROM journal_line l JOIN account a ON a.id = l.account_id
   WHERE l.entry_id = v_reb.id;

  IF NEW.side = 'credit' THEN
    IF v_lines <> 2 OR v_deposit <> -NEW.amount_cents
       OR v_expense <> NEW.amount_cents OR v_income <> 0 THEN
      RAISE EXCEPTION
        'rebook % is not this credit-interest correction: % lines, %c to the deposit account, %c to 5400, %c to 4400; expected 2, %c, %c and 0',
        v_reb.id, v_lines, v_deposit, v_expense, v_income,
        -NEW.amount_cents, NEW.amount_cents USING ERRCODE = '42501';
    END IF;
  ELSE
    IF v_lines <> 2 OR v_deposit <> NEW.amount_cents
       OR v_income <> -NEW.amount_cents OR v_expense <> 0 THEN
      RAISE EXCEPTION
        'rebook % is not this overdraft-interest correction: % lines, %c to the deposit account, %c to 4400, %c to 5400; expected 2, %c, %c and 0',
        v_reb.id, v_lines, v_deposit, v_income, v_expense,
        NEW.amount_cents, -NEW.amount_cents USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_interest_adjustment() SET search_path = public, pg_temp;

CREATE TRIGGER interest_adjustment_lifecycle
  BEFORE INSERT ON interest_adjustment
  FOR EACH ROW EXECUTE FUNCTION assert_interest_adjustment();


-- The working, derived. What `interest_posting` stores in columns, this
-- computes on every read, from the watermark the row kept and the same
-- 0024 functions. A customer can still reproduce the number by hand; the
-- book simply does not keep a second copy of the balance to do it.
CREATE VIEW v_interest_adjustment AS
SELECT adj.id                    AS adjustment_id,
       adj.interest_day_id,
       adj.schedule_id,
       s.account_id,
       b.legal_name              AS business_name,
       adj.accrual_date,
       adj.idempotency_key,
       adj.repriced_at_seq,
       ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq)
                                 AS basis_balance_cents,
       adj.side,
       adj.rate_bps,
       adj.day_count,
       interest_numerator(
         ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq),
         adj.rate_bps)           AS numerator,
       interest_denominator(adj.day_count) AS denominator,
       interest_numerator(
         ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq),
         adj.rate_bps) / interest_denominator(adj.day_count) AS whole_cents,
       interest_numerator(
         ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq),
         adj.rate_bps) % interest_denominator(adj.day_count) AS remainder_units,
       adj.rounding,
       adj.amount_cents,
       p.side                    AS priced_side,
       p.amount_cents            AS priced_amount_cents,
       p.observed_booking_seq    AS priced_at_seq,
       adj.original_entry_id,
       adj.reversal_entry_id,
       adj.rebook_entry_id,
       adj.correction_group_id,
       adj.adjusted_at,
       adj.adjusted_on_book_date,
       adj.adjusted_by_run,
       adj.reason
  FROM interest_adjustment adj
  JOIN interest_day        d ON d.id = adj.interest_day_id
  JOIN interest_posting    p ON p.interest_day_id = d.id
  JOIN interest_schedule   s ON s.id = adj.schedule_id
  JOIN account             a ON a.id = s.account_id
  LEFT JOIN business       b ON b.id = a.business_id;

COMMENT ON VIEW v_interest_adjustment IS
  'Every interest adjustment with its full working derived rather than stored: the basis from ledger_settled_cents() at the watermark the row kept, and the fraction from the same 0024 functions the tick uses.';


-- MUST BE EMPTY. The price of storing `amount_cents` at all.
--
-- An adjustment whose stored decision no longer re-derives from the
-- journal at its own recorded watermark, or from the rate card effective
-- on its own accrual date. It is check 5b's question asked of this table
-- -- and it is a VIEW rather than a script line because
-- `scripts/dbcheck.mjs` is outside this change's edit surface. It was
-- made to fail before it was written down: with
-- `interest_adjustment_lifecycle` disabled on the owner connection, a
-- row whose amount_cents was off by one cent took it from 0 to 1.
CREATE VIEW v_interest_adjustment_drift AS
SELECT adj.id AS adjustment_id, adj.interest_day_id, adj.accrual_date,
       adj.repriced_at_seq, adj.side, adj.rate_bps, adj.day_count,
       adj.amount_cents AS stored_amount_cents,
       ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq)
                          AS basis_balance_cents,
       interest_daily_cents(
         ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq),
         adj.rate_bps, adj.day_count) AS derived_amount_cents,
       interest_side_of(
         ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq))
                          AS derived_side,
       rc.id              AS resolved_policy_id
  FROM interest_adjustment adj
  JOIN interest_schedule   s ON s.id = adj.schedule_id
  LEFT JOIN LATERAL (SELECT * FROM interest_rate_at(s.rate_tier, adj.accrual_date)) rc ON true
 WHERE rc.id IS NULL
    OR adj.policy_id <> rc.id
    OR adj.day_count <> rc.day_count_denominator
    OR adj.side IS DISTINCT FROM interest_side_of(
         ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq))
    OR adj.rate_bps <> CASE adj.side
                         WHEN 'credit'    THEN rc.credit_rate_bps
                         WHEN 'overdraft' THEN rc.overdraft_rate_bps
                         ELSE 0
                       END
    OR adj.rounding IS DISTINCT FROM interest_rounding_of(
         interest_numerator(
           ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq),
           adj.rate_bps),
         interest_denominator(adj.day_count))
    OR adj.amount_cents IS DISTINCT FROM interest_daily_cents(
         ledger_settled_cents(s.account_id, adj.accrual_date, adj.repriced_at_seq),
         adj.rate_bps, adj.day_count);

COMMENT ON VIEW v_interest_adjustment_drift IS
  'Must be empty. Every stored adjustment must still re-derive from ledger_settled_cents() at its own watermark and the rate card effective on its own accrual date. This is dbcheck check 5bs question, asked of interest_adjustment, as a view because dbcheck.mjs is outside migration 0049s edit surface.';



-- ---------------------------------------------------------------------
-- 4.  The marker: every day that was priced before it closed
-- ---------------------------------------------------------------------
--
-- WHY THIS IS A VIEW AND NOT A TABLE.  The obvious shape is a marker
-- table holding the priced-at watermark beside the closed-at watermark
-- and the balance at each.  The second half of that row would be A
-- STORED BALANCE READ AT A WATERMARK -- which is the defect, one table
-- over.  `scripts/dbcheck.mjs` check 5 refuses stored balance columns
-- for exactly this reason and the one exemption
-- (`interest_posting.basis_balance_cents`) is paid for by check 5b
-- recomputing it.  A marker table would need a third.
--
-- Everything here is derived on every read: the priced side of each row
-- from `interest_posting`, the current side from `ledger_settled_cents()`
-- at the live watermark, through the same functions the product uses.
-- The row cannot go stale because there is no row.
--
-- IT COVERS PRE-0049 ROWS TOO.  `basis_book_date` is NULL on those, so
-- the question is asked of `interest_day.claimed_at` in book time
-- instead: a day claimed on or before itself was priced on a balance
-- that was not that date's closing balance.  COALESCE, not a filter --
-- a predicate that excludes the rows written before the guard existed
-- would hide precisely the rows the guard was written for.

CREATE VIEW v_interest_priced_before_close AS
WITH live AS (
  SELECT COALESCE(max(booking_seq), 0)::bigint AS seq FROM journal_entry
)
SELECT d.id                                   AS interest_day_id,
       d.schedule_id,
       s.account_id,
       b.legal_name                           AS business_name,
       d.accrual_date,
       d.claimed_at,
       (d.claimed_at AT TIME ZONE book_tz())::date AS claimed_on_book_date,
       p.basis_book_date,

       -- ---- what it WAS priced at ---------------------------------
       p.observed_booking_seq                 AS priced_at_seq,
       p.basis_balance_cents                  AS priced_basis_cents,
       p.side                                 AS priced_side,
       p.rate_bps                             AS priced_rate_bps,
       p.amount_cents                         AS priced_amount_cents,
       p.entry_id                             AS priced_entry_id,

       -- ---- what the same date stands at NOW, recomputed ----------
       live.seq                               AS live_seq,
       ledger_settled_cents(s.account_id, d.accrual_date, live.seq) AS basis_now_cents,
       interest_side_of(ledger_settled_cents(s.account_id, d.accrual_date, live.seq))
                                              AS side_now,
       interest_daily_cents(
         ledger_settled_cents(s.account_id, d.accrual_date, live.seq),
         CASE interest_side_of(ledger_settled_cents(s.account_id, d.accrual_date, live.seq))
           WHEN 'credit'    THEN rc.credit_rate_bps
           WHEN 'overdraft' THEN rc.overdraft_rate_bps
           ELSE 0
         END,
         rc.day_count_denominator)            AS amount_now_cents,

       -- ---- has the date closed, and has anyone corrected it? ------
       (d.accrual_date < book_date(now()))    AS date_has_closed,
       adj.id                                 AS adjustment_id,
       adj.repriced_at_seq                    AS adjusted_at_seq,
       adj.amount_cents                       AS adjusted_amount_cents,
       adj.side                               AS adjusted_side
  FROM interest_posting  p
  JOIN interest_day      d  ON d.id = p.interest_day_id
  JOIN interest_schedule s  ON s.id = d.schedule_id
  JOIN account           a  ON a.id = s.account_id
  LEFT JOIN business     b  ON b.id = a.business_id
  CROSS JOIN live
  LEFT JOIN LATERAL (SELECT * FROM interest_rate_at(s.rate_tier, d.accrual_date)) rc ON true
  LEFT JOIN interest_adjustment adj ON adj.interest_day_id = d.id
 WHERE p.disposition = 'posted'
   AND COALESCE(p.basis_book_date, (d.claimed_at AT TIME ZONE book_tz())::date)
         <= d.accrual_date;

COMMENT ON VIEW v_interest_priced_before_close IS
  'Every POSTED interest day whose basis was read on or before its own business date -- priced on the balance at the instant the tick ran rather than the balance at the close. Carries what it was priced at beside what the same date stands at now, recomputed on every read and never stored, plus whether the date has closed and whether an interest_adjustment has corrected it. Five rows on 2026-09-11; see docs/ACCRUAL.md §20 and §21.';


-- ---------------------------------------------------------------------
-- 5.  The guard that goes non-empty by itself, and back to empty
-- ---------------------------------------------------------------------
--
-- A day that was priced early, whose date HAS NOW CLOSED, whose closed
-- figure genuinely differs from what was posted, and that nobody has
-- corrected.  It reports the work that is outstanding, and it is the
-- thing `scripts/repair-0049-mispriced-interest.mjs` ranges over -- the
-- script cannot touch a row this view cannot see.
--
-- IT IS ZERO ROWS RIGHT NOW AND THAT IS NOT A PASS.  All five known rows
-- are value-dated 2026-09-11, which is today, so `date_has_closed` is
-- false for every one of them.  docs/ACCRUAL.md §20.5 makes the same
-- point about `v_accrual_month_drift` -- a guard gated on a condition
-- nothing has met is "green because there is nothing to be green about"
-- -- and the honest thing is to say so here, in the file, rather than
-- let a zero be read as health.  At 00:00 America/New_York on
-- 2026-09-12 it becomes FIVE ROWS with nobody writing them, exactly as
-- `v_hold_release_drift` did at 13:17Z in 0048.  It returns to zero when
-- the repair has run, and only then.
--
-- DELIBERATELY NOT ADDED TO scripts/dbcheck.mjs's INVARIANT_VIEWS. Two
-- reasons. It is not an invariant -- it is a work queue, and a work
-- queue that fails the build the moment a real defect is found trains
-- people to silence it. And a view that cannot currently return a row
-- has no honest prover, which is the state 0023 wrote its lesson about.
-- When the five are corrected and it is structurally empty, it can be
-- listed, and it will have been made to fail by the book rather than by
-- a fixture.

CREATE VIEW v_interest_mispriced_uncorrected AS
SELECT interest_day_id, schedule_id, account_id, business_name, accrual_date,
       priced_at_seq, priced_basis_cents, priced_side, priced_amount_cents,
       priced_entry_id, live_seq, basis_now_cents, side_now, amount_now_cents
  FROM v_interest_priced_before_close
 WHERE date_has_closed
   AND adjustment_id IS NULL
   AND (side_now, amount_now_cents) IS DISTINCT FROM (priced_side, priced_amount_cents);

COMMENT ON VIEW v_interest_mispriced_uncorrected IS
  'The work queue, not an invariant: interest days priced before their own date closed, whose closed figure differs from what was posted, and which no interest_adjustment has corrected. Zero rows until 2026-09-12 only because the five known rows are value-dated TODAY. scripts/repair-0049-mispriced-interest.mjs ranges over exactly this.';


-- ---------------------------------------------------------------------
-- 6.  Privileges, and layer 2
-- ---------------------------------------------------------------------
--
-- SELECT and INSERT, never UPDATE or DELETE: 0024 §17's shape, because
-- an adjustment is a money fact and money facts are append-only. The
-- immutability triggers are the second layer, and they bind the OWNER
-- too -- privileges never bind a table's owner, which is the lesson
-- .env.example records from the pass where the app ran as one.

GRANT SELECT, INSERT ON interest_adjustment TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON interest_adjustment FROM corgi_app;

GRANT SELECT ON v_interest_priced_before_close, v_interest_mispriced_uncorrected,
                v_interest_adjustment, v_interest_adjustment_drift
TO corgi_app;

CREATE TRIGGER interest_adjustment_no_update_delete
  BEFORE UPDATE OR DELETE ON interest_adjustment
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER interest_adjustment_no_truncate
  BEFORE TRUNCATE ON interest_adjustment
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();
