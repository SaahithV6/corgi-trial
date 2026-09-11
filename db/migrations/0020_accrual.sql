-- =====================================================================
-- 0020  Daily accrual: the residual penny, with an address
-- =====================================================================
--
-- Stretch ladder item 3: "Interest or fee accrual computed at end of
-- day, visibly, on the ledger."
--
-- And, more to the point, non-negotiable 9:
--
--   "Money is never a float. Integer minor units or exact decimals.
--    State your currency handling and your rounding rule. Pro-rata maths
--    always leaves a penny, and someone has to eat it deterministically."
--
-- The written half is docs/ACCRUAL.md. This file is the half Postgres
-- enforces, and there is more of it here than there is there.
--
-- ---------------------------------------------------------------------
-- 1.  WHAT IS ACCRUED, AND WHY IT IS THIS AND NOT INTEREST
-- ---------------------------------------------------------------------
--
-- A monthly platform fee, accrued daily, pro-rata across the days of the
-- calendar month it belongs to.
--
-- Three candidates were on the table. Only one of them could be posted
-- without inventing an account, and it is also the one where the residual
-- penny bites hardest:
--
--   * MONTHLY PLATFORM FEE, ACCRUED DAILY.  Chart account 4200's own
--     description names it: "Fees we charge the customer - wire,
--     expedited ACH, MONTHLY PLATFORM - credited here at the same instant
--     the customer's deposit account is debited for them."  The account
--     exists, it is the right one, and nothing had to be invented. BUILT.
--
--   * OVERDRAFT INTEREST on negative deposit balances.  The right idea
--     for this book -- an over-captured fuel pump can push an account
--     below zero and v_overdrawn_accounts exists to find it -- but there
--     is NO INTEREST INCOME ACCOUNT IN THE CHART, and 4200 is not one.
--     4300's own note settles it: "It is not fee income -- 4200 is what
--     we charge, and netting variance into it would make a spread look
--     like a price."  Interest priced on a balance and a number of days
--     is not a fee for a service, Reg DD discloses the two differently,
--     and quietly posting an APR into the fee line would be exactly the
--     silent second convention this migration exists to prevent.
--     NOT BUILT.  The account to add is named in docs/ACCRUAL.md §7.
--
--   * INTEREST PAID ON CREDIT BALANCES.  Same problem, other side: it
--     needs an interest EXPENSE account and 5100/5200/5300/5900 are all
--     something else.  NOT BUILT, account named in docs/ACCRUAL.md §7.
--
-- The product is a column, the pricing is a row, and the arithmetic for
-- each product is one function. Adding overdraft interest is a migration
-- that adds an enum value, an account and a function -- not a rewrite.
--
-- ---------------------------------------------------------------------
-- 2.  THE ROUNDING RULE IS THE ONE ALREADY WRITTEN DOWN
-- ---------------------------------------------------------------------
--
-- research/ledger/DESIGN.md §12, which is the same rule the T+2h attack
-- plan committed to on the thread. Quoted, because the whole point is
-- that this is not a second convention:
--
--   §12.3  "One amount split across N lines: largest-remainder. Floor
--          each share to cents; the shortfall is at most N-1 pennies;
--          distribute one penny each to the shares with the largest
--          fractional remainder. This guarantees Sigma shares = source
--          EXACTLY, always, with no residual to lose."
--
--   §12.4  "Ties in the remainder, and therefore the residual penny, are
--          broken deterministically by line ordinal ascending... The
--          ordinal ordering is fixed by the posting template, not by
--          whatever order a map iterated in."
--
-- A monthly fee split across the days of its month is §12.3's case
-- exactly, with one simplification that makes it easier to check by hand
-- than the general one: every day's share is F/N, so every day's
-- fractional remainder is IDENTICAL, so §12.4's tiebreak decides the
-- whole allocation on its own. The ordinal is the day of the month.
--
--     q = F div N          the base share, floor division on integers
--     r = F mod N          the residual pennies, 0 <= r < N
--     share(d) = q + (1 if d <= r else 0)
--     cum(d)   = q*d + min(d, r)
--     cum(N)   = q*N + r = F                     EXACTLY, by construction
--
-- $25.00 a month, September, 30 days:
--     q = 2500 div 30 = 83,  r = 2500 - 2490 = 10
--     days 1..10 accrue 84c, days 11..30 accrue 83c
--     10*84 + 20*83 = 840 + 1660 = 2500.  Not 2499, not 2501.
--
-- What §12.2 (round half to even) does NOT apply to, and why saying so
-- matters: half-even is the rule for turning ONE value into ONE cent
-- amount. Applying it per day here -- round(2500/30) = 83 every day --
-- would charge 30 x 83 = $24.90 for a $25.00 plan, and the customer would
-- be $0.10 a month, $1.20 a year, and one support ticket better off than
-- the price they agreed to. Rounding each day independently is the bug.
-- Allocating the month is the fix. That is why §12 has both rules.
--
-- WHO EATS THE PENNY. Over a whole month, nobody: the sum is exactly F,
-- which is what largest-remainder buys. Within the month the residual is
-- a TIMING assignment and it lands on the earliest days, because §12.4
-- says lowest ordinal and the ordinal is the day. docs/ACCRUAL.md §4
-- states the partial-month consequence out loud and bounds it: a mid-
-- month close can leave a customer up to (F mod N) cents -- at most 30c
-- on a $25 plan -- ahead of exact pro-rata, and a mid-month open up to
-- the same amount behind it. That is disclosed, bounded and deterministic
-- rather than absent, and it is the price of having ONE rounding rule in
-- this ledger instead of two.
--
-- ---------------------------------------------------------------------
-- 3.  THE UNIT IS THE (SCHEDULE, DATE) PAIR, AND POSTGRES OWNS IT
-- ---------------------------------------------------------------------
--
-- 0012's construction, deliberately identical, because the requirement is
-- identical: running the job twice for the same day must post once.
--
--   * `accrual_day` is the CLAIM. UNIQUE (schedule_id, accrual_date), so
--     at most one can exist, decided by an index and not by a scheduler.
--
--   * `accrual_day.idempotency_key` is GENERATED ALWAYS from those two
--     source facts -- `accrual:<schedule>:<YYYY-MM-DD>` -- so the
--     application cannot compute it, and therefore cannot compute it
--     wrong. The date is assembled from EXTRACT()ed integers rather than
--     to_char(), because every textual rendering of a date is only
--     STABLE (DateStyle is a session GUC) and a generated column's
--     expression must be IMMUTABLE. An idempotency key that depends on a
--     session setting is a key that silently becomes a different key,
--     which is the exact shape of a double posting.
--
--   * That string is handed to postEntry(), where
--     `journal_entry.idempotency_key` is UNIQUE (0001 §12, line 289). A
--     second run re-derives the same key and ledger_append() returns the
--     ORIGINAL entry id, having written nothing.
--
--   * `accrual_posting` is the OUTCOME, PRIMARY KEY (accrual_day_id).
--     One decision per claimed day, enforced by the key.
--
-- So exactly-once here rests on two unique indexes and one generated
-- column. The row lock (§9) is a liveness device that keeps two
-- concurrent runs from doing the same work twice; it is NOT what makes
-- this safe, and the difference matters, because a crashed process
-- releases a lock and cannot release a unique index.
--
-- ---------------------------------------------------------------------
-- 4.  THE ARITHMETIC IS STORED, AND THE DATABASE RE-DERIVES IT
-- ---------------------------------------------------------------------
--
-- Every operand is a column on `accrual_posting`: the monthly price, the
-- days in the month, the day of the month, the base share, the residual
-- pennies, whether THIS day got one, the amount, and the cumulative
-- month-to-date. Stored, not derived at read time, for the same reason
-- `standing_order_outcome.observed_*` is stored: these are the figures the
-- decision was actually made against. Re-deriving them next year answers
-- a different question.
--
-- Stored figures rot, so they are not trusted: a CHECK constraint
-- re-derives all seven relations from the three inputs on every insert,
-- and a trigger checks the three inputs against the claim's date and the
-- schedule's price. The screen renders the stored columns and the
-- database guarantees they are the real arithmetic. "A number a customer
-- cannot reproduce by hand is a number they will dispute" -- so the
-- number is on the screen WITH the hand calculation, and Postgres has
-- already checked the hand calculation.
--
-- There is deliberately no second implementation of the formula to drift
-- from this one. DECISIONS 024's lesson was that two definitions held
-- equal by an invariant cannot be fixed one at a time. TypeScript
-- computes and Postgres VERIFIES -- that is a computation plus a proof,
-- not two computations.
--
-- ---------------------------------------------------------------------
-- 5.  VALUE DATE IS THE ACCRUAL DATE. THE TRIGGER SAYS SO.
-- ---------------------------------------------------------------------
--
-- This is the case the brief's gauntlet item 6 says the two columns exist
-- for. A tick that runs on Friday and catches up Tuesday, Wednesday and
-- Thursday posts three entries with THOSE value dates and Friday's
-- booking_seq. Tuesday's statement shows Tuesday's fee.
--
-- `assert_accrual_posting()` refuses an outcome whose journal entry has a
-- value_date other than the claim's accrual_date, so the job cannot get
-- this wrong even by accident, and a backdated accrual landing inside a
-- closed book day shows up in v_late_postings and produces a statement
-- v2 -- which is the designed behaviour, not a surprise.
-- =====================================================================


-- btree_gist gives the EXCLUDE constraint in §7 equality operators for
-- uuid and for an enum, which plain gist does not have.
CREATE EXTENSION IF NOT EXISTS btree_gist;


-- ---------------------------------------------------------------------
-- 6.  Vocabulary
-- ---------------------------------------------------------------------

-- One value today. The enum exists so that adding overdraft interest is
-- `ALTER TYPE ... ADD VALUE` plus one function, rather than a boolean
-- called `is_interest` that some later reader has to reverse-engineer.
CREATE TYPE accrual_product AS ENUM ('platform_fee');

-- Two dispositions and no third. There is no 'pending': a claimed day
-- with no outcome row HAS no disposition, which is a state you can query
-- (v_accrual_unresolved) rather than a label somebody has to remember to
-- move on. 0012's argument, unchanged.
--
-- 'skipped' is not a failure. It is the day whose share is legitimately
-- zero cents -- a plan priced below one cent per day, e.g. $0.20 a month
-- over 31 days, where q = 0 and only the first r days accrue anything at
-- all. postEntry() refuses a zero-amount line ("always an allocation
-- bug"), and it is right to, so a zero day is recorded as a decided day
-- with no entry rather than posted as an entry that says nothing.
CREATE TYPE accrual_disposition AS ENUM ('posted', 'skipped');


-- ---------------------------------------------------------------------
-- 7.  The schedule: who is enrolled, at what price, over what window
-- ---------------------------------------------------------------------

CREATE TABLE accrual_schedule (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The customer's deposit account. Tenancy is reached through it, the
  -- way `hold` and `standing_order` do it -- no business_id column here
  -- to drift from account.business_id.
  account_id    uuid NOT NULL REFERENCES account(id),

  product       accrual_product NOT NULL,

  -- What a customer sees on their bill: "Business Standard". Not
  -- decoration -- it is rendered on the screen next to the arithmetic,
  -- because "84 cents" is only checkable if you know what plan it is a
  -- thirtieth of.
  plan_name     text NOT NULL CHECK (length(btrim(plan_name)) > 0),

  -- THE PRICE, IN INTEGER CENTS. Not a rate, not a numeric, not dollars.
  -- A platform fee is quoted per month, so the integer that is quoted is
  -- the integer that is stored, and the division into days happens once,
  -- in SQL, on integers. Nothing in this feature ever holds a float.
  --
  -- When overdraft interest arrives it adds `rate_bps int` beside this
  -- and a CHECK that exactly one of the two is set per product. A rate
  -- is stored integer-scaled (basis points) for the identical reason.
  monthly_cents bigint NOT NULL CHECK (monthly_cents > 0),

  currency      char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),

  -- Effective dating, because a price is a fact with a lifespan and
  -- DESIGN §5 is explicit that those live in their own versioned table
  -- rather than being back-fitted onto the journal. A price change is a
  -- new row, never an UPDATE -- there is no UPDATE.
  start_date    date NOT NULL,
  end_date      date,

  created_by    uuid NOT NULL REFERENCES actor(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Derived from the fact that caused the enrolment (a signed order
  -- form, a plan change, this migration). Re-running the thing that
  -- creates schedules cannot create a second copy of one.
  schedule_key  text NOT NULL UNIQUE CHECK (length(btrim(schedule_key)) > 0),

  CONSTRAINT accrual_schedule_window CHECK (end_date IS NULL OR end_date >= start_date),

  -- One live price per account per product at any instant. Without this,
  -- two overlapping schedules would each accrue their own share of their
  -- own month and the customer would be billed twice with both halves
  -- arithmetically perfect. Postgres refuses the overlap instead.
  CONSTRAINT accrual_schedule_no_overlap EXCLUDE USING gist (
    account_id WITH =,
    product    WITH =,
    daterange(start_date, COALESCE(end_date, 'infinity'::date), '[]') WITH &&
  )
);

CREATE INDEX accrual_schedule_account_idx ON accrual_schedule (account_id);

COMMENT ON TABLE accrual_schedule IS
  'Who is enrolled in a daily-accrued charge, at what price, over what window. Append-only and effective-dated: a price change is a new row.';
COMMENT ON COLUMN accrual_schedule.monthly_cents IS
  'The quoted monthly price in integer cents. The ONLY money input to the allocation. Divided into days by accrual_daily_share(), on integers, never by anything holding a float.';
COMMENT ON CONSTRAINT accrual_schedule_no_overlap ON accrual_schedule IS
  'One live price per account per product. Two overlapping schedules would bill the same month twice, each half perfectly rounded.';


-- ---------------------------------------------------------------------
-- 8.  The arithmetic, in ONE place, as IMMUTABLE integer functions
-- ---------------------------------------------------------------------
--
-- These are the whole rounding rule. They take bigint cents and integers
-- and return bigint cents; there is no numeric, no float and no division
-- that is not integer division. IMMUTABLE so a CHECK constraint may call
-- them -- which is the point: the application computes the same numbers
-- in TypeScript and the database refuses to store any other answer.

-- The days in the calendar month a date belongs to. Written with
-- date_trunc on a TIMESTAMP (immutable) rather than a timestamptz
-- (stable, because it depends on TimeZone), so it can be used inside a
-- generated column and a CHECK.
CREATE FUNCTION accrual_days_in_month(p_date date) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT EXTRACT(DAY FROM (
           date_trunc('month', p_date::timestamp) + interval '1 month' - interval '1 day'
         ))::int
$$;

-- q = F div N. Floor division: both operands are positive, so Postgres's
-- truncation toward zero IS the floor.
CREATE FUNCTION accrual_base_share(p_monthly_cents bigint, p_days int) RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT p_monthly_cents / p_days
$$;

-- r = F mod N. The number of pennies largest-remainder has to place, and
-- therefore the number of days that carry one. 0 <= r < N, always.
CREATE FUNCTION accrual_residual_pennies(p_monthly_cents bigint, p_days int) RETURNS int
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT (p_monthly_cents % p_days)::int
$$;

-- share(d) = q + (1 if d <= r else 0).
--
-- DESIGN §12.4: the tiebreak is ordinal ascending, and the ordinal here
-- is the day of the month. Every day's fractional remainder is F/N mod 1
-- and therefore identical, so the tiebreak decides the entire allocation
-- and there is nothing else to compare.
CREATE FUNCTION accrual_daily_share(p_monthly_cents bigint, p_days int, p_day int)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT accrual_base_share(p_monthly_cents, p_days)
       + CASE WHEN p_day <= accrual_residual_pennies(p_monthly_cents, p_days)
              THEN 1 ELSE 0 END
$$;

-- cum(d) = q*d + min(d, r). At d = N this is q*N + r = F exactly, which
-- is the guarantee the whole rule exists to provide.
CREATE FUNCTION accrual_cumulative_through(p_monthly_cents bigint, p_days int, p_day int)
RETURNS bigint
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT accrual_base_share(p_monthly_cents, p_days) * p_day
       + LEAST(p_day, accrual_residual_pennies(p_monthly_cents, p_days))
$$;

COMMENT ON FUNCTION accrual_daily_share(bigint, int, int) IS
  'DESIGN §12.3 largest-remainder with §12.4''s ordinal-ascending tiebreak, where the ordinal is the day of the month. The sum over a whole month is exactly the monthly price, by construction.';

ALTER FUNCTION accrual_days_in_month(date)                 SET search_path = public, pg_temp;
ALTER FUNCTION accrual_base_share(bigint, int)             SET search_path = public, pg_temp;
ALTER FUNCTION accrual_residual_pennies(bigint, int)       SET search_path = public, pg_temp;
ALTER FUNCTION accrual_daily_share(bigint, int, int)       SET search_path = public, pg_temp;
ALTER FUNCTION accrual_cumulative_through(bigint, int, int) SET search_path = public, pg_temp;


-- ---------------------------------------------------------------------
-- 9.  The claim -- at most once, by unique index
-- ---------------------------------------------------------------------

CREATE TABLE accrual_day (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id   uuid NOT NULL REFERENCES accrual_schedule(id),

  -- THE BUSINESS DATE THIS ACCRUAL IS FOR. Not the date the job ran.
  -- It becomes the journal entry's value_date, and §5's trigger refuses
  -- any entry that says otherwise.
  accrual_date  date NOT NULL,

  -- `accrual:<schedule id>:<YYYY-MM-DD>`. Generated, for the reason in
  -- the header §3: an application that can compute the key can compute
  -- it wrong, and a wrong key is a second debit.
  idempotency_key text GENERATED ALWAYS AS (
    'accrual:' || schedule_id::text || ':'
      || lpad(EXTRACT(YEAR  FROM accrual_date)::int::text, 4, '0') || '-'
      || lpad(EXTRACT(MONTH FROM accrual_date)::int::text, 2, '0') || '-'
      || lpad(EXTRACT(DAY   FROM accrual_date)::int::text, 2, '0')
  ) STORED,

  claimed_at    timestamptz NOT NULL DEFAULT now(),
  -- Which run took it. Not an actor: the claim is made by a cron
  -- invocation, and inventing a human to attribute it to would be worse
  -- provenance than the run id that actually did it.
  claimed_by    text NOT NULL CHECK (length(btrim(claimed_by)) > 0),

  -- THE constraint. Everything else here exists so that this is the
  -- thing that decides.
  CONSTRAINT accrual_day_once UNIQUE (schedule_id, accrual_date),
  CONSTRAINT accrual_day_key_once UNIQUE (idempotency_key)
);

CREATE INDEX accrual_day_date_idx ON accrual_day (accrual_date DESC, schedule_id);

COMMENT ON COLUMN accrual_day.accrual_date IS
  'The business date the charge accrued FOR. Becomes journal_entry.value_date; assert_accrual_posting() refuses any entry whose value date differs.';
COMMENT ON COLUMN accrual_day.idempotency_key IS
  'GENERATED ALWAYS from the schedule and the date -- source facts, never a uuid. Handed to postEntry(), where journal_entry.idempotency_key is UNIQUE in turn.';


-- A day may only be claimed inside its schedule's effective window. A
-- claim outside it would produce a fee for a month the customer was not
-- enrolled in, and the sum for that month would then be neither F nor
-- a pro-rata of F.
CREATE FUNCTION assert_accrual_day() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sched accrual_schedule%ROWTYPE;
BEGIN
  SELECT * INTO v_sched FROM accrual_schedule WHERE id = NEW.schedule_id;

  IF NEW.accrual_date < v_sched.start_date
     OR (v_sched.end_date IS NOT NULL AND NEW.accrual_date > v_sched.end_date) THEN
    RAISE EXCEPTION
      'schedule % runs % .. %; % is outside it and can never accrue',
      NEW.schedule_id, v_sched.start_date,
      COALESCE(v_sched.end_date::text, 'open'), NEW.accrual_date
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_accrual_day() SET search_path = public, pg_temp;

CREATE TRIGGER accrual_day_window
  BEFORE INSERT ON accrual_day
  FOR EACH ROW EXECUTE FUNCTION assert_accrual_day();


-- ---------------------------------------------------------------------
-- 10.  The outcome -- one per claimed day, with the sum shown
-- ---------------------------------------------------------------------

CREATE TABLE accrual_posting (
  accrual_day_id     uuid PRIMARY KEY REFERENCES accrual_day(id),
  disposition        accrual_disposition NOT NULL,

  -- ---- the three inputs, as they stood when the decision was made ----
  monthly_cents      bigint NOT NULL CHECK (monthly_cents > 0),
  days_in_month      int    NOT NULL CHECK (days_in_month BETWEEN 28 AND 31),
  day_of_month       int    NOT NULL CHECK (day_of_month >= 1),

  -- ---- the working, which the CHECK below re-derives ----------------
  base_share_cents   bigint NOT NULL CHECK (base_share_cents >= 0),
  residual_pennies   int    NOT NULL CHECK (residual_pennies >= 0),
  residual_applied   boolean NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents >= 0),
  -- Month-to-date INCLUDING this day. On the last day of the month this
  -- equals monthly_cents exactly; v_accrual_month_drift watches it.
  cumulative_cents   bigint NOT NULL CHECK (cumulative_cents >= 0),

  -- The journal entry, on 'posted'. NULL on 'skipped'.
  entry_id           uuid REFERENCES journal_entry(id),
  -- Why nothing was posted. Set on 'skipped' only.
  skip_reason        text,

  decided_at         timestamptz NOT NULL DEFAULT now(),
  decided_by_run     text NOT NULL CHECK (length(btrim(decided_by_run)) > 0),

  -- =================================================================
  -- THE ARITHMETIC, RE-DERIVED BY THE DATABASE ON EVERY INSERT.
  --
  -- Seven relations over three inputs. A row that disagrees with
  -- accrual_daily_share() by one cent cannot be stored, so the figures
  -- the screen renders are not a claim about the arithmetic -- they ARE
  -- the arithmetic, checked by the thing that persisted them.
  -- =================================================================
  CONSTRAINT accrual_posting_arithmetic CHECK (
        day_of_month     <= days_in_month
    AND base_share_cents  = accrual_base_share(monthly_cents, days_in_month)
    AND residual_pennies  = accrual_residual_pennies(monthly_cents, days_in_month)
    AND residual_applied  = (day_of_month <= residual_pennies)
    AND amount_cents      = accrual_daily_share(monthly_cents, days_in_month, day_of_month)
    AND amount_cents      = base_share_cents + (CASE WHEN residual_applied THEN 1 ELSE 0 END)
    AND cumulative_cents  = accrual_cumulative_through(monthly_cents, days_in_month, day_of_month)
  ),

  -- A posted day has an entry and a non-zero amount; a skipped day has
  -- neither and says why. There is no third shape.
  CONSTRAINT accrual_posting_shape CHECK (
       (disposition = 'posted'
          AND entry_id IS NOT NULL AND skip_reason IS NULL AND amount_cents > 0)
    OR (disposition = 'skipped'
          AND entry_id IS NULL AND skip_reason IS NOT NULL AND amount_cents = 0)
  )
);

CREATE INDEX accrual_posting_entry_idx ON accrual_posting (entry_id) WHERE entry_id IS NOT NULL;

COMMENT ON TABLE accrual_posting IS
  'One decision per claimed day, by PRIMARY KEY. Carries the complete working -- price, days, day, base share, residual pennies, whether this day got one, the amount and the month-to-date -- so a customer can reproduce the number by hand from the row.';
COMMENT ON CONSTRAINT accrual_posting_arithmetic ON accrual_posting IS
  'Re-derives all seven relations from the three inputs. TypeScript computes, Postgres verifies: a computation plus a proof, not two computations that can drift.';


-- The lifecycle gate. 0012 §10's instinct, and the same two claims that
-- would be catastrophic if they were merely conventional.
CREATE FUNCTION assert_accrual_posting() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_day     accrual_day%ROWTYPE;
  v_sched   accrual_schedule%ROWTYPE;
  v_entry   journal_entry%ROWTYPE;
  v_deposit bigint;
  v_income  bigint;
  v_lines   int;
BEGIN
  SELECT * INTO v_day   FROM accrual_day      WHERE id = NEW.accrual_day_id;
  SELECT * INTO v_sched FROM accrual_schedule WHERE id = v_day.schedule_id;

  -- The three inputs must describe THIS day and THIS price. Without
  -- this, a caller could store a perfectly self-consistent piece of
  -- arithmetic about some other day and the CHECK above would pass it.
  IF NEW.day_of_month IS DISTINCT FROM EXTRACT(DAY FROM v_day.accrual_date)::int THEN
    RAISE EXCEPTION 'posting says day % but the claim is dated %',
      NEW.day_of_month, v_day.accrual_date USING ERRCODE = '42501';
  END IF;

  IF NEW.days_in_month IS DISTINCT FROM accrual_days_in_month(v_day.accrual_date) THEN
    RAISE EXCEPTION 'posting says % days in the month but % has %',
      NEW.days_in_month, v_day.accrual_date, accrual_days_in_month(v_day.accrual_date)
      USING ERRCODE = '42501';
  END IF;

  IF NEW.monthly_cents IS DISTINCT FROM v_sched.monthly_cents THEN
    RAISE EXCEPTION 'posting prices the month at %c but schedule % is %c',
      NEW.monthly_cents, v_sched.id, v_sched.monthly_cents USING ERRCODE = '42501';
  END IF;

  IF NEW.disposition::text = 'skipped' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_entry FROM journal_entry WHERE id = NEW.entry_id;
  IF v_entry.id IS NULL THEN
    RAISE EXCEPTION 'posting for day % cites entry % which does not exist',
      NEW.accrual_day_id, NEW.entry_id USING ERRCODE = '55006';
  END IF;

  -- The one that makes this exactly-once rather than merely careful. The
  -- claim's key is generated by the database from source facts; the
  -- entry's key is UNIQUE. If they match, this claim and that entry are
  -- the same fact, and no second entry can ever match this claim.
  IF v_entry.idempotency_key IS DISTINCT FROM v_day.idempotency_key THEN
    RAISE EXCEPTION
      'day % derives key %, but entry % carries % -- these are not the same accrual',
      NEW.accrual_day_id, v_day.idempotency_key, v_entry.id, v_entry.idempotency_key
      USING ERRCODE = '42501';
  END IF;

  -- VALUE DATE IS THE ACCRUAL DATE, NOT THE RUN DATE. Header §5. A job
  -- that catches up three days must post three entries dated those three
  -- days, and this is where that stops being a promise.
  IF v_entry.value_date IS DISTINCT FROM v_day.accrual_date THEN
    RAISE EXCEPTION
      'entry % has value date % but the accrual is for % -- accrual books at the date it accrued for',
      v_entry.id, v_entry.value_date, v_day.accrual_date USING ERRCODE = '42501';
  END IF;

  IF v_entry.book::text <> 'financial' THEN
    RAISE EXCEPTION 'entry % is in the % book; a fee is real money and belongs in the financial book',
      v_entry.id, v_entry.book USING ERRCODE = '42501';
  END IF;

  -- And the entry must actually BE this charge: a debit of exactly
  -- amount_cents to the enrolled deposit account, a credit of exactly
  -- amount_cents to 4200, and nothing else.
  SELECT count(*),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE l.account_id = v_sched.account_id), 0),
         COALESCE(SUM(l.amount_cents) FILTER (WHERE a.code = '4200'), 0)
    INTO v_lines, v_deposit, v_income
    FROM journal_line l JOIN account a ON a.id = l.account_id
   WHERE l.entry_id = v_entry.id;

  IF v_lines <> 2 OR v_deposit <> NEW.amount_cents OR v_income <> -NEW.amount_cents THEN
    RAISE EXCEPTION
      'entry % is not this accrual: % lines, %c to the deposit account, %c to 4200; expected 2, %c and %c',
      v_entry.id, v_lines, v_deposit, v_income, NEW.amount_cents, -NEW.amount_cents
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_accrual_posting() SET search_path = public, pg_temp;

CREATE TRIGGER accrual_posting_lifecycle
  BEFORE INSERT ON accrual_posting
  FOR EACH ROW EXECUTE FUNCTION assert_accrual_posting();


-- ---------------------------------------------------------------------
-- 11.  The row lock, without the UPDATE privilege
-- ---------------------------------------------------------------------
--
-- 0008's and 0012's construction, for their reason. corgi_app holds no
-- UPDATE on accrual_schedule and must not, so it cannot write FOR UPDATE
-- itself; this function can do nothing else.
--
-- Taken in the CALLER's transaction and released at the caller's COMMIT.
-- It serialises two ticks that want the same schedule. It is not what
-- makes the job exactly-once -- §3's unique indexes are.

CREATE FUNCTION lock_accrual_schedule(p_schedule uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT s.id INTO v_id FROM accrual_schedule s WHERE s.id = p_schedule FOR UPDATE;
  RETURN v_id IS NOT NULL;
END $$;

ALTER FUNCTION lock_accrual_schedule(uuid) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION lock_accrual_schedule(uuid) FROM PUBLIC;


-- ---------------------------------------------------------------------
-- 12.  What is owed: the calendar, in ONE place
-- ---------------------------------------------------------------------
--
-- 0012 §8's rule, applied again: no date arithmetic in TypeScript. The
-- set of dates a schedule owes is a SQL function, the firing routine asks
-- it, and there is no second implementation of "which days are in the
-- window" to drift from this one.
--
-- A schedule owes every date in [start_date, min(end_date, today)] that
-- has not already been claimed -- bounded below by a catch-up window so a
-- scheduler that has been down for a week recovers, and a schedule
-- enrolled last year does not try to backfill it in one tick. Unclaimed
-- dates older than the window are still visible in v_accrual_gap; they
-- are simply not accrued automatically, because a year of fees appearing
-- in one overnight batch is a conversation, not a cron job.

CREATE FUNCTION accrual_due_dates(p_schedule uuid, p_from date, p_to date)
RETURNS SETOF date
LANGUAGE sql STABLE AS $$
  SELECT d::date
    FROM accrual_schedule s,
         generate_series(
           GREATEST(s.start_date, p_from)::timestamp,
           LEAST(COALESCE(s.end_date, p_to), p_to)::timestamp,
           interval '1 day'
         ) AS d
   WHERE s.id = p_schedule
     AND NOT EXISTS (
           SELECT 1 FROM accrual_day ad
            WHERE ad.schedule_id = s.id AND ad.accrual_date = d::date
         )
   ORDER BY 1
$$;

ALTER FUNCTION accrual_due_dates(uuid, date, date) SET search_path = public, pg_temp;

COMMENT ON FUNCTION accrual_due_dates(uuid, date, date) IS
  'The only definition of which dates a schedule still owes. The tick asks it; nothing in TypeScript computes a date range.';


-- ---------------------------------------------------------------------
-- 13.  The views -- including the two that must always be empty
-- ---------------------------------------------------------------------

-- One row per (schedule, month): the target, what has been accrued, how
-- many residual pennies the month has to place, and how many have landed.
-- This is the screen's month panel and the invariant's raw material.
CREATE VIEW v_accrual_month AS
SELECT s.id                                            AS schedule_id,
       s.account_id,
       a.business_id,
       s.plan_name,
       s.product,
       date_trunc('month', ad.accrual_date::timestamp)::date AS month_start,
       accrual_days_in_month(ad.accrual_date)          AS days_in_month,
       s.monthly_cents,
       accrual_residual_pennies(s.monthly_cents, accrual_days_in_month(ad.accrual_date))
                                                       AS residual_pennies_in_month,
       count(*)                                        AS days_claimed,
       count(ap.*)                                     AS days_decided,
       count(*) FILTER (WHERE ap.disposition = 'posted')  AS days_posted,
       count(*) FILTER (WHERE ap.disposition = 'skipped') AS days_skipped,
       count(*) FILTER (WHERE ap.residual_applied)        AS residual_pennies_applied,
       COALESCE(SUM(ap.amount_cents), 0)               AS accrued_cents,
       s.monthly_cents - COALESCE(SUM(ap.amount_cents), 0) AS remaining_cents,
       -- A month is complete when every one of its days has been decided.
       count(ap.*) = accrual_days_in_month(ad.accrual_date) AS month_complete
  FROM accrual_day ad
  JOIN accrual_schedule s ON s.id = ad.schedule_id
  JOIN account a          ON a.id = s.account_id
  LEFT JOIN accrual_posting ap ON ap.accrual_day_id = ad.id
 GROUP BY s.id, s.account_id, a.business_id, s.plan_name, s.product,
          date_trunc('month', ad.accrual_date::timestamp), s.monthly_cents,
          accrual_days_in_month(ad.accrual_date);

COMMENT ON VIEW v_accrual_month IS
  'Per schedule and month: the price, the days, the pennies to place, the pennies placed, and the running total. A complete month must sum to the price exactly.';


-- MUST BE EMPTY. A month every day of which has been decided, whose
-- postings do not sum to the monthly price. This is the single claim the
-- rounding rule makes, and it is checkable in one query rather than
-- argued for in a README.
CREATE VIEW v_accrual_month_drift AS
SELECT schedule_id, account_id, plan_name, month_start, days_in_month,
       monthly_cents, accrued_cents,
       accrued_cents - monthly_cents AS drift_cents
  FROM v_accrual_month
 WHERE month_complete
   AND accrued_cents <> monthly_cents;

COMMENT ON VIEW v_accrual_month_drift IS
  'Must be empty. Largest-remainder guarantees a complete month sums to the price EXACTLY -- not within a penny, exactly (DESIGN §12). A row here means the allocation is wrong.';


-- MUST BE EMPTY. A posting whose amount disagrees with the journal entry
-- it cites. The lifecycle trigger refuses this on insert, so a row here
-- means the trigger is gone -- or that somebody edited a money row, which
-- the privileges say they cannot.
CREATE VIEW v_accrual_ledger_drift AS
SELECT ap.accrual_day_id,
       ad.accrual_date,
       ad.idempotency_key,
       e.id                  AS entry_id,
       e.value_date,
       ap.amount_cents,
       COALESCE(SUM(l.amount_cents) FILTER (WHERE l.account_id = s.account_id), 0)
                             AS deposit_debit_cents
  FROM accrual_posting ap
  JOIN accrual_day      ad ON ad.id = ap.accrual_day_id
  JOIN accrual_schedule s  ON s.id  = ad.schedule_id
  JOIN journal_entry    e  ON e.id  = ap.entry_id
  JOIN journal_line     l  ON l.entry_id = e.id
 WHERE ap.disposition = 'posted'
 GROUP BY ap.accrual_day_id, ad.accrual_date, ad.idempotency_key,
          e.id, e.value_date, ap.amount_cents
HAVING COALESCE(SUM(l.amount_cents) FILTER (WHERE l.account_id = s.account_id), 0)
         <> ap.amount_cents
    OR e.value_date <> ad.accrual_date;

COMMENT ON VIEW v_accrual_ledger_drift IS
  'Must be empty. The posting row and the journal entry must agree on the amount AND on the value date. assert_accrual_posting() refuses otherwise at insert.';


-- Claimed and never decided: a tick took the day and did not finish.
-- Safe -- nothing posted -- but never invisible. The next tick re-drives
-- it, and postEntry() returns the original entry if one exists.
CREATE VIEW v_accrual_unresolved AS
SELECT ad.id AS accrual_day_id, ad.schedule_id, ad.accrual_date,
       ad.idempotency_key, ad.claimed_at, ad.claimed_by,
       s.account_id, s.plan_name
  FROM accrual_day ad
  JOIN accrual_schedule s ON s.id = ad.schedule_id
  LEFT JOIN accrual_posting ap ON ap.accrual_day_id = ad.id
 WHERE ap.accrual_day_id IS NULL;


-- Days a schedule owes that nothing has claimed, up to today. Non-empty
-- is normal the moment a schedule is created and before the first tick;
-- persistently non-empty means the cron is not running, which is the
-- failure this whole feature would otherwise hide.
CREATE VIEW v_accrual_gap AS
SELECT s.id AS schedule_id, s.account_id, s.plan_name, d AS missing_date
  FROM accrual_schedule s
  CROSS JOIN LATERAL accrual_due_dates(
    s.id, s.start_date, LEAST(COALESCE(s.end_date, CURRENT_DATE), CURRENT_DATE)
  ) AS d;

COMMENT ON VIEW v_accrual_gap IS
  'Dates a schedule owes and nothing has claimed. Persistently non-empty means the tick is not running -- the one failure a silent accrual job would otherwise hide.';


-- ---------------------------------------------------------------------
-- 14.  Append-only, in two layers
-- ---------------------------------------------------------------------
--
-- No journal line is written by anything in this file -- postEntry() does
-- that -- so these are not money tables. They are the AUDIT of money
-- movement, and an audit trail you can UPDATE is a story. 0012 §12's
-- treatment, unchanged: no UPDATE/DELETE grant, and 0001's
-- ledger_row_is_immutable() as the second layer that also binds the owner.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['accrual_schedule', 'accrual_day', 'accrual_posting'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_no_update_delete BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON accrual_schedule, accrual_day, accrual_posting TO corgi_app;

-- Explicit and redundant, so a reviewer can grep for it -- 0001's words.
REVOKE UPDATE, DELETE, TRUNCATE ON accrual_schedule, accrual_day, accrual_posting FROM corgi_app;

GRANT SELECT ON
  v_accrual_month, v_accrual_month_drift, v_accrual_ledger_drift,
  v_accrual_unresolved, v_accrual_gap
TO corgi_app;

GRANT EXECUTE ON FUNCTION
  accrual_days_in_month(date),
  accrual_base_share(bigint, int),
  accrual_residual_pennies(bigint, int),
  accrual_daily_share(bigint, int, int),
  accrual_cumulative_through(bigint, int, int),
  accrual_due_dates(uuid, date, date),
  lock_accrual_schedule(uuid)
TO corgi_app;


-- ---------------------------------------------------------------------
-- 15.  Enrolment for the accounts that exist
-- ---------------------------------------------------------------------
--
-- Every business with a deposit account gets a plan, at three different
-- prices, chosen so that the three cases of the rounding rule are visible
-- side by side on one screen on one day rather than having to be
-- described:
--
--   $25.00 / 30 days = 83 r 10   pennies on days 1..10
--   $49.99 / 30 days = 166 r 19  pennies on days 1..19
--    $9.99 / 30 days = 33 r 9    pennies on days 1..9
--
-- So on the 10th of a 30-day month the first two accrue a residual penny
-- and the third does not; on the 11th only the second still does. The
-- transition is real, dated, and on the ledger.
--
-- start_date is the first of the current month, so the first tick has a
-- month-to-date to build and the screen has more than one row. Idempotent
-- on schedule_key: re-running this migration against a database that
-- already has them writes nothing.
--
-- The actor is the seeded `ledger-poster` system principal -- the same
-- one every machine-originated entry is attributed to. An enrolment made
-- by a migration is not a human act and is not dressed up as one.

INSERT INTO accrual_schedule
  (account_id, product, plan_name, monthly_cents, start_date, created_by, schedule_key)
SELECT a.id,
       'platform_fee'::accrual_product,
       v.plan_name,
       v.monthly_cents,
       date_trunc('month', CURRENT_DATE::timestamp)::date,
       act.id,
       'migration:0020:' || b.ein || ':platform_fee'
  FROM (VALUES
          ('Ridgeline Robotics, Inc.',       'Business Standard', 2500::bigint),
          ('Holds Integration Fixture Co.',  'Business Plus',     4999::bigint),
          ('Pots Integration Fixture Co.',   'Starter',            999::bigint)
       ) AS v(legal_name, plan_name, monthly_cents)
  JOIN business b ON b.legal_name = v.legal_name
  JOIN account  a ON a.business_id = b.id AND a.code = '2100'
  JOIN actor  act ON act.display_name = 'ledger-poster' AND act.kind = 'system'
ON CONFLICT (schedule_key) DO NOTHING;
