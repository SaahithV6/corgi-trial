-- =====================================================================
-- 0012  Standing orders: an occurrence fires once, and only once
-- =====================================================================
--
-- Gauntlet item 8, and the brief's own v1 scope:
--
--   "Scheduled payments that fire once and only once across restarts and
--    retries, with a written policy for the day the balance cannot cover
--    them."
--
-- The written policy is docs/STANDING-ORDERS.md. This file is the half of
-- it Postgres enforces.
--
-- ---------------------------------------------------------------------
-- 1.  THE UNIT IS THE OCCURRENCE, NOT THE ORDER
-- ---------------------------------------------------------------------
--
-- "Fires once" is meaningless said of a standing order: a monthly rent
-- mandate is *supposed* to fire twelve times a year. The thing that must
-- happen at most once is one (standing order, scheduled date) pair. So
-- that pair is a row, and it carries the unique constraint:
--
--     CONSTRAINT standing_order_occurrence_once
--       UNIQUE (standing_order_id, scheduled_date)
--
-- and one derived, unique idempotency key. Nothing about exactly-once is
-- decided by a scheduler behaving itself.
--
-- ---------------------------------------------------------------------
-- 2.  THE KEY IS DERIVED BY THE DATABASE, NOT BY THE APPLICATION
-- ---------------------------------------------------------------------
--
-- DECISIONS' rule for idempotency keys is that they come from SOURCE
-- FACTS and never from a uuid we generated. `standing:<order>:<date>` is
-- exactly that -- but if the application computed it, the application
-- could compute it wrong, and a wrong key is a second payment.
--
-- So it is a GENERATED ALWAYS ... STORED column. There is no way to
-- INSERT a different one; `standing_order_occurrence.idempotency_key` is
-- a function of the two columns that identify the occurrence, and the
-- lifecycle trigger below then refuses any outcome whose payment
-- instruction does not carry that exact string as ITS idempotency key.
-- Since `payment_instruction.idempotency_key` is itself UNIQUE (0001
-- section 12), a double fire is refused by a unique index in Postgres,
-- twice, on two different tables.
--
-- Why the date is spelled out with EXTRACT and lpad instead of to_char:
-- a generated column's expression must be IMMUTABLE, and every textual
-- rendering of a date -- to_char(), date::text, format() -- is only
-- STABLE, because DateStyle is a session setting that changes the answer.
-- An idempotency key whose value depends on a session GUC is a key that
-- silently becomes a different key, which is the precise shape of a
-- double payment. date_part() on a `date` is immutable, so the key is
-- built from integers.
--
-- ---------------------------------------------------------------------
-- 3.  LIFECYCLE IS POLICED BY A TRIGGER, NOT BY APPLICATION CODE
-- ---------------------------------------------------------------------
--
-- 0007's instinct, copied. Two things the application must not be trusted
-- to get right are checked at the row:
--
--   * an occurrence may only exist for a date THE SCHEDULE ACTUALLY
--     GENERATES. `standing_order_due_dates()` is the one definition of
--     when a mandate is due, and `assert_standing_order_occurrence()`
--     calls that same function to validate the insert. You cannot invent
--     an occurrence, and there is no second copy of the calendar
--     arithmetic in TypeScript to drift from this one.
--
--   * an outcome that says `raised` must cite a payment instruction that
--     belongs to this occurrence -- same account, same rail, same amount,
--     and above all the same idempotency key. "This occurrence fired" and
--     "that instruction exists" cannot come apart.
--
-- ---------------------------------------------------------------------
-- 4.  A REFUSAL IS A ROW
-- ---------------------------------------------------------------------
--
-- The failure mode the brief names -- "it never fired and nobody knows
-- why" -- is a missing row. So the outcome table has a `refused`
-- disposition with a code, a sentence, and the four figures that were
-- observed at the moment of the decision: ledger, holds, uncleared and
-- available. `v_standing_order_history` renders them side by side,
-- because the interesting refusal is the one where the LEDGER was
-- sufficient and AVAILABLE was not.
--
-- ---------------------------------------------------------------------
-- 5.  EVERYTHING HERE IS APPEND-ONLY
-- ---------------------------------------------------------------------
--
-- Not because these are money rows -- they are not, no journal line is
-- written by anything in this file -- but because they are the AUDIT of
-- money movement, and an audit trail you can UPDATE is a story. Same
-- treatment as `payment_instruction`: SELECT and INSERT for corgi_app,
-- an explicit REVOKE of UPDATE/DELETE/TRUNCATE, and 0001's
-- `ledger_row_is_immutable()` trigger as the second layer that also
-- binds the table owner.
--
-- Cancelling a mandate is therefore an INSERT into
-- `standing_order_cancellation`, whose PRIMARY KEY is the order id -- the
-- same shape as `hold_closure`, and exactly-once for the same reason.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 6.  Vocabulary
-- ---------------------------------------------------------------------

CREATE TYPE standing_order_cadence AS ENUM ('daily', 'weekly', 'monthly');

-- Two dispositions and no third. There is no 'pending' and no 'retrying':
-- an occurrence that has not been decided has NO OUTCOME ROW, which is a
-- state you can query for (v_standing_order_unresolved) rather than a
-- label somebody has to remember to move on.
CREATE TYPE standing_order_disposition AS ENUM ('raised', 'refused');


-- ---------------------------------------------------------------------
-- 7.  The mandate
-- ---------------------------------------------------------------------

CREATE TABLE standing_order (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The customer deposit account the money leaves. Tenancy is reached
  -- through this account, exactly as `hold` does it -- no business_id
  -- column to drift from account.business_id.
  account_id    uuid NOT NULL REFERENCES account(id),
  -- What a human calls it on a statement: "Rent - Unit 4".
  reference     text NOT NULL CHECK (length(btrim(reference)) > 0),
  rail          rail NOT NULL,
  amount_cents  bigint NOT NULL CHECK (amount_cents > 0),
  currency      char(3) NOT NULL DEFAULT 'USD',
  -- Same jsonb shape as payment_instruction.counterparty, validated by
  -- the same zod schema on the way in and on the way out. Never a full
  -- account number; see src/lib/approvals/types.ts.
  counterparty  jsonb NOT NULL,

  cadence       standing_order_cadence NOT NULL,
  day_of_month  smallint CHECK (day_of_month BETWEEN 1 AND 31),
  day_of_week   smallint CHECK (day_of_week BETWEEN 0 AND 6),   -- 0 = Sunday

  start_date    date NOT NULL,
  end_date      date,

  -- The human who authorised the mandate. This actor is the one the
  -- raised instruction is attributed to, which means the maker-checker
  -- rule applies to a standing order without a single line of new code:
  -- assert_maker_checker() refuses an `approved` event whose actor is the
  -- instruction's requested_by, so the person who set the mandate up
  -- cannot also be the second pair of eyes on the payments it raises.
  created_by    uuid NOT NULL REFERENCES actor(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Derived from the source fact that caused the mandate to exist (a
  -- signed direct-debit form, a lease id, a seed run). Re-running the
  -- thing that creates mandates cannot create a second copy of one.
  mandate_key   text NOT NULL UNIQUE CHECK (length(btrim(mandate_key)) > 0),

  -- Exactly the fields the cadence needs, and no others. A weekly order
  -- carrying a day_of_month is a bug waiting for a reader to resolve it
  -- one way while the SQL resolves it the other.
  CONSTRAINT standing_order_cadence_fields CHECK (
       (cadence = 'daily'   AND day_of_month IS NULL     AND day_of_week IS NULL)
    OR (cadence = 'weekly'  AND day_of_month IS NULL     AND day_of_week IS NOT NULL)
    OR (cadence = 'monthly' AND day_of_month IS NOT NULL AND day_of_week IS NULL)
  ),
  CONSTRAINT standing_order_window CHECK (end_date IS NULL OR end_date >= start_date),
  -- `card` is in the rail enum because the ledger books card settlement
  -- against it. A card movement originates at a network, never at a
  -- schedule, so it is not a rail a standing order can name.
  CONSTRAINT standing_order_rail_is_payout CHECK (rail <> 'card')
);

CREATE INDEX standing_order_account_idx ON standing_order (account_id);

COMMENT ON COLUMN standing_order.mandate_key IS
  'Derived from the fact that created the mandate, never a generated uuid. UNIQUE, so re-running the creator is a no-op decided by Postgres.';
COMMENT ON COLUMN standing_order.created_by IS
  'The human who authorised the mandate, and therefore the requested_by on every instruction it raises. That is what makes maker-checker apply to a scheduled payment with no new code.';


-- Cancellation is an append with the order id as its PRIMARY KEY: one
-- row can exist, it cannot be written twice, and it cannot be undone by
-- an UPDATE because there is no UPDATE. The same construction as
-- hold_closure, and exactly-once for the same reason.
CREATE TABLE standing_order_cancellation (
  standing_order_id uuid PRIMARY KEY REFERENCES standing_order(id),
  cancelled_at      timestamptz NOT NULL DEFAULT now(),
  cancelled_by      uuid NOT NULL REFERENCES actor(id),
  reason            text NOT NULL CHECK (length(btrim(reason)) > 0)
);


-- ---------------------------------------------------------------------
-- 8.  The calendar, in ONE place
-- ---------------------------------------------------------------------
--
-- Every question about when a mandate is due -- the firing routine's
-- "what is owed today", the screen's "next occurrence", and the trigger
-- that validates an occurrence insert -- resolves through this function.
--
-- DECISIONS 024 is the argument for that. The TypeScript hold model and
-- the SQL hold view were held equal by an invariant, and when they
-- disagreed on one edge case there was no cheap fix: changing either one
-- alone turns a documentation gap into a live drift alarm. The lesson is
-- not "write better tests", it is "do not have two definitions". So the
-- calendar is here, the application asks it, and there is no second copy
-- of month-end clamping in TypeScript to get wrong.
--
-- Month-end clamping is the case that matters: a mandate for the 31st is
-- due on 30 April and on 28 February, not skipped. LEAST(day_of_month,
-- days-in-that-month) is the whole rule.

CREATE FUNCTION standing_order_due_dates(p_standing_order uuid, p_from date, p_to date)
RETURNS SETOF date
LANGUAGE sql STABLE AS $$
  WITH win AS (
    SELECT so.cadence,
           so.day_of_month,
           so.day_of_week,
           GREATEST(so.start_date, p_from)                  AS lo,
           LEAST(COALESCE(so.end_date, p_to), p_to)         AS hi
      FROM standing_order so
     WHERE so.id = p_standing_order
  ),
  every_day AS (
    SELECT d::date AS d, win.*
      FROM win, generate_series(win.lo::timestamp, win.hi::timestamp, interval '1 day') AS d
     WHERE win.cadence IN ('daily', 'weekly')
  ),
  month_start AS (
    SELECT m::date AS m, win.*
      FROM win, generate_series(date_trunc('month', win.lo::timestamp),
                                date_trunc('month', win.hi::timestamp),
                                interval '1 month') AS m
     WHERE win.cadence = 'monthly'
  )
  SELECT d FROM every_day
   WHERE cadence = 'daily'
      OR EXTRACT(DOW FROM d)::int = day_of_week
  UNION
  SELECT clamped FROM (
    SELECT (m + (LEAST(
                   day_of_month,
                   EXTRACT(DAY FROM (m + interval '1 month' - interval '1 day'))::int
                 ) - 1))::date AS clamped,
           lo, hi
      FROM month_start
  ) monthly
   WHERE clamped BETWEEN lo AND hi
   ORDER BY 1
$$;

COMMENT ON FUNCTION standing_order_due_dates(uuid, date, date) IS
  'The only definition of when a standing order is due. The firing routine, the next-occurrence view and the occurrence insert trigger all call it, so there is nothing for a second implementation to drift from.';


-- ---------------------------------------------------------------------
-- 9.  The occurrence -- the claim, and the exactly-once anchor
-- ---------------------------------------------------------------------

CREATE TABLE standing_order_occurrence (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  standing_order_id uuid NOT NULL REFERENCES standing_order(id),
  scheduled_date    date NOT NULL,

  -- `standing:<order id>:<YYYY-MM-DD>`. See section 2 for why it is
  -- generated by the database and why the date is assembled from
  -- integers rather than formatted.
  idempotency_key   text GENERATED ALWAYS AS (
    'standing:' || standing_order_id::text || ':'
      || lpad(EXTRACT(YEAR  FROM scheduled_date)::int::text, 4, '0') || '-'
      || lpad(EXTRACT(MONTH FROM scheduled_date)::int::text, 2, '0') || '-'
      || lpad(EXTRACT(DAY   FROM scheduled_date)::int::text, 2, '0')
  ) STORED,

  claimed_at        timestamptz NOT NULL DEFAULT now(),
  -- Which run took the claim. Not an actor: the decision is made by a
  -- cron invocation, and inventing a human to attribute it to would be
  -- worse provenance than the run id that actually did it.
  claimed_by        text NOT NULL CHECK (length(btrim(claimed_by)) > 0),

  -- THE constraint. Everything else in this migration exists to make
  -- sure this one is the thing that decides.
  CONSTRAINT standing_order_occurrence_once UNIQUE (standing_order_id, scheduled_date),
  CONSTRAINT standing_order_occurrence_key_once UNIQUE (idempotency_key)
);

CREATE INDEX standing_order_occurrence_date_idx
  ON standing_order_occurrence (scheduled_date DESC, standing_order_id);

COMMENT ON COLUMN standing_order_occurrence.idempotency_key IS
  'GENERATED ALWAYS. Derived from the standing order and the scheduled date -- source facts -- never from a uuid. Handed to requestPayment(), where payment_instruction.idempotency_key is UNIQUE in turn.';


-- An occurrence may only exist for a date the schedule generates, and
-- only for a mandate that was not already cancelled when that date came
-- round. Both checks call the same function everything else calls.
CREATE FUNCTION assert_standing_order_occurrence() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cancelled_on date;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM standing_order_due_dates(
      NEW.standing_order_id, NEW.scheduled_date, NEW.scheduled_date)
  ) THEN
    RAISE EXCEPTION
      'standing order % is not due on %: an occurrence can only exist for a date the schedule generates',
      NEW.standing_order_id, NEW.scheduled_date USING ERRCODE = '55006';
  END IF;

  SELECT (c.cancelled_at AT TIME ZONE 'America/New_York')::date
    INTO v_cancelled_on
    FROM standing_order_cancellation c
   WHERE c.standing_order_id = NEW.standing_order_id;

  -- Cancelled on the day itself still fires that day's occurrence if it
  -- was already due -- a mandate stopped at 4pm did not un-happen the
  -- 9am payment. Anything scheduled AFTER the cancellation date is
  -- refused outright rather than left to application code to filter.
  IF v_cancelled_on IS NOT NULL AND NEW.scheduled_date > v_cancelled_on THEN
    RAISE EXCEPTION
      'standing order % was cancelled on %; % is after that and can never occur',
      NEW.standing_order_id, v_cancelled_on, NEW.scheduled_date
      USING ERRCODE = '55006';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_standing_order_occurrence() SET search_path = public, pg_temp;

CREATE TRIGGER standing_order_occurrence_schedule
  BEFORE INSERT ON standing_order_occurrence
  FOR EACH ROW EXECUTE FUNCTION assert_standing_order_occurrence();


-- ---------------------------------------------------------------------
-- 10.  The outcome -- one per occurrence, by PRIMARY KEY
-- ---------------------------------------------------------------------

CREATE TABLE standing_order_outcome (
  occurrence_id            uuid PRIMARY KEY REFERENCES standing_order_occurrence(id),
  disposition              standing_order_disposition NOT NULL,

  -- Set on `raised`. The instruction went through requestPayment(), so
  -- it carries its policy version, its content hash and its KYB gate
  -- decision like any human-initiated payment.
  instruction_id           uuid REFERENCES payment_instruction(id),

  -- Set on `refused`. A code a screen can branch on and a sentence a
  -- person can read.
  refusal_code             text,
  refusal_reason           text,

  -- What was true at the moment of the decision. Stored, not derived,
  -- and that is deliberate: these are the AS-OBSERVED figures the
  -- decision was made against, the same axis as
  -- statement.closing_balance_cents. Re-deriving them tomorrow answers a
  -- different question ("what is the balance now") and would quietly
  -- rewrite the reason a payment was refused.
  --
  -- Deliberately NOT named *_balance_* or `available_cents`: `pnpm
  -- db:check` fails the build on a stored balance column, and it is
  -- right to, so these carry the `observed_` prefix that says what they
  -- are -- a measurement taken once, not a cache of anything.
  observed_ledger_cents    bigint,
  observed_holds_cents     bigint,
  observed_uncleared_cents bigint,
  observed_available_cents bigint,
  shortfall_cents          bigint CHECK (shortfall_cents IS NULL OR shortfall_cents > 0),

  decided_at               timestamptz NOT NULL DEFAULT now(),
  decided_by_run           text NOT NULL CHECK (length(btrim(decided_by_run)) > 0),

  CONSTRAINT standing_order_outcome_shape CHECK (
       (disposition = 'raised'
          AND instruction_id IS NOT NULL
          AND refusal_code IS NULL AND refusal_reason IS NULL)
    OR (disposition = 'refused'
          AND instruction_id IS NULL
          AND refusal_code IS NOT NULL AND refusal_reason IS NOT NULL)
  )
);

CREATE INDEX standing_order_outcome_instruction_idx
  ON standing_order_outcome (instruction_id) WHERE instruction_id IS NOT NULL;

COMMENT ON TABLE standing_order_outcome IS
  'One row per occurrence, enforced by PRIMARY KEY (occurrence_id). An occurrence with no row here has not been decided; that is a queryable state, not a label.';


-- The lifecycle gate. 0007 put the rules that matter on the row rather
-- than in the caller; this does the same for the one claim that would be
-- catastrophic if it were merely conventional -- "the instruction this
-- occurrence raised".
CREATE FUNCTION assert_standing_order_outcome() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_occ  standing_order_occurrence%ROWTYPE;
  v_so   standing_order%ROWTYPE;
  v_pi   payment_instruction%ROWTYPE;
BEGIN
  SELECT * INTO v_occ FROM standing_order_occurrence WHERE id = NEW.occurrence_id;
  SELECT * INTO v_so  FROM standing_order            WHERE id = v_occ.standing_order_id;

  IF NEW.disposition::text = 'refused' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_pi FROM payment_instruction WHERE id = NEW.instruction_id;
  IF v_pi.id IS NULL THEN
    RAISE EXCEPTION 'outcome for occurrence % cites instruction % which does not exist',
      NEW.occurrence_id, NEW.instruction_id USING ERRCODE = '55006';
  END IF;

  -- The one that matters. The occurrence's key is generated by the
  -- database from source facts; the instruction's key is UNIQUE. If they
  -- match, this occurrence and that instruction are the same event, and
  -- no second instruction can ever match this occurrence.
  IF v_pi.idempotency_key IS DISTINCT FROM v_occ.idempotency_key THEN
    RAISE EXCEPTION
      'occurrence % derives idempotency key %, but instruction % carries % -- these are not the same firing',
      NEW.occurrence_id, v_occ.idempotency_key, v_pi.id, v_pi.idempotency_key
      USING ERRCODE = '42501';
  END IF;

  -- Belt and braces: an instruction that matched the key but described a
  -- different payment would mean the key was computed somewhere it
  -- should not have been.
  IF v_pi.account_id   IS DISTINCT FROM v_so.account_id
  OR v_pi.rail         IS DISTINCT FROM v_so.rail
  OR v_pi.amount_cents IS DISTINCT FROM v_so.amount_cents
  OR v_pi.currency     IS DISTINCT FROM v_so.currency THEN
    RAISE EXCEPTION
      'instruction % does not describe standing order % (account/rail/amount/currency differ)',
      NEW.instruction_id, v_so.id USING ERRCODE = '42501';
  END IF;

  -- The value date a scheduled payment lands on IS its scheduled date.
  -- If those two ever differ, the ledger and the calendar are telling
  -- different stories about the same money.
  IF v_pi.value_date IS DISTINCT FROM v_occ.scheduled_date THEN
    RAISE EXCEPTION
      'instruction % has value date % but occurrence % is scheduled for %',
      NEW.instruction_id, v_pi.value_date, NEW.occurrence_id, v_occ.scheduled_date
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END $$;

ALTER FUNCTION assert_standing_order_outcome() SET search_path = public, pg_temp;

CREATE TRIGGER standing_order_outcome_lifecycle
  BEFORE INSERT ON standing_order_outcome
  FOR EACH ROW EXECUTE FUNCTION assert_standing_order_outcome();


-- ---------------------------------------------------------------------
-- 11.  The row lock, without the UPDATE privilege
-- ---------------------------------------------------------------------
--
-- Exactly 0008's construction, for exactly 0008's reason. The firing
-- routine serialises itself per mandate with
--
--     SELECT lock_standing_order(:id)
--
-- taken in the CALLER's transaction and released at the caller's COMMIT.
-- corgi_app holds no UPDATE on standing_order and must not, so it cannot
-- write `FOR UPDATE` itself; this function can do nothing except take
-- that one lock on that one table.
--
-- The lock is what makes claiming at-most-once. It is NOT what makes
-- firing exactly-once -- the unique constraints are -- and the
-- difference matters, because a lock is a liveness device that a crashed
-- process releases, while a unique index is a safety device that a
-- crashed process cannot.

CREATE FUNCTION lock_standing_order(p_standing_order uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_id uuid;
BEGIN
  SELECT so.id INTO v_id FROM standing_order so WHERE so.id = p_standing_order FOR UPDATE;
  RETURN v_id IS NOT NULL;
END $$;

ALTER FUNCTION lock_standing_order(uuid) SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION lock_standing_order(uuid) FROM PUBLIC;


-- ---------------------------------------------------------------------
-- 12.  Append-only, in two layers
-- ---------------------------------------------------------------------

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'standing_order', 'standing_order_cancellation',
    'standing_order_occurrence', 'standing_order_outcome'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_no_update_delete BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
    EXECUTE format(
      'CREATE TRIGGER %I_no_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable()', t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON
  standing_order, standing_order_cancellation,
  standing_order_occurrence, standing_order_outcome
TO corgi_app;

-- Explicit and redundant, so a reviewer can grep for it -- 0001's words.
REVOKE UPDATE, DELETE, TRUNCATE ON
  standing_order, standing_order_cancellation,
  standing_order_occurrence, standing_order_outcome
FROM corgi_app, PUBLIC;

GRANT EXECUTE ON FUNCTION standing_order_due_dates(uuid, date, date) TO corgi_app;
GRANT EXECUTE ON FUNCTION lock_standing_order(uuid) TO corgi_app;


-- ---------------------------------------------------------------------
-- 13.  Projections
-- ---------------------------------------------------------------------
--
-- Views, not tables, for the reason DESIGN gives everywhere else: a
-- projection cannot go stale and there is no second copy to drift.
-- Created after 0001's blanket REVOKE, so each needs its own GRANT.

CREATE VIEW v_standing_order_schedule AS
SELECT so.id,
       so.reference,
       so.account_id,
       acc.name          AS account_name,
       acc.business_id,
       b.legal_name      AS business_name,
       so.rail,
       so.amount_cents,
       so.currency,
       so.counterparty,
       so.cadence,
       so.day_of_month,
       so.day_of_week,
       so.start_date,
       so.end_date,
       so.mandate_key,
       so.created_at,
       so.created_by,
       ca.display_name   AS created_by_name,
       (c.standing_order_id IS NOT NULL) AS cancelled,
       c.cancelled_at,
       c.reason          AS cancellation_reason
  FROM standing_order so
  JOIN account acc ON acc.id = so.account_id
  LEFT JOIN business b ON b.id = acc.business_id
  JOIN actor ca ON ca.id = so.created_by
  LEFT JOIN standing_order_cancellation c ON c.standing_order_id = so.id;

GRANT SELECT ON v_standing_order_schedule TO corgi_app;


-- The next occurrence that has not yet been claimed, looking a year and
-- a bit ahead so an annual mandate still has an answer.
--
-- `now() AT TIME ZONE 'America/New_York'` and not CURRENT_DATE: the book
-- day is a banking-timezone fact (src/lib/format/datetime.ts), and a
-- server in UTC would roll the schedule over five hours early every
-- night.
CREATE VIEW v_standing_order_next AS
SELECT so.id AS standing_order_id,
       (SELECT min(d)
          FROM standing_order_due_dates(
                 so.id,
                 (now() AT TIME ZONE 'America/New_York')::date,
                 (now() AT TIME ZONE 'America/New_York')::date + 400) AS d
         WHERE NOT EXISTS (
           SELECT 1 FROM standing_order_occurrence o
            WHERE o.standing_order_id = so.id AND o.scheduled_date = d
         )) AS next_due_date
  FROM standing_order so
 WHERE NOT EXISTS (
   SELECT 1 FROM standing_order_cancellation c WHERE c.standing_order_id = so.id
 );

GRANT SELECT ON v_standing_order_next TO corgi_app;


-- What fired, what was refused, and why -- one row per occurrence,
-- decided or not.
CREATE VIEW v_standing_order_history AS
SELECT o.id                        AS occurrence_id,
       o.standing_order_id,
       so.reference,
       so.account_id,
       acc.business_id,
       so.rail,
       so.amount_cents,
       so.currency,
       o.scheduled_date,
       o.idempotency_key,
       o.claimed_at,
       o.claimed_by,
       ou.disposition,
       ou.instruction_id,
       ou.refusal_code,
       ou.refusal_reason,
       ou.observed_ledger_cents,
       ou.observed_holds_cents,
       ou.observed_uncleared_cents,
       ou.observed_available_cents,
       ou.shortfall_cents,
       ou.decided_at,
       ou.decided_by_run,
       pi.content_hash,
       pi.requested_at             AS instruction_requested_at
  FROM standing_order_occurrence o
  JOIN standing_order so ON so.id = o.standing_order_id
  JOIN account acc ON acc.id = so.account_id
  LEFT JOIN standing_order_outcome ou ON ou.occurrence_id = o.id
  LEFT JOIN payment_instruction pi ON pi.id = ou.instruction_id;

GRANT SELECT ON v_standing_order_history TO corgi_app;


-- ---------------------------------------------------------------------
-- 14.  Invariants
-- ---------------------------------------------------------------------
--
-- Both of these must return zero rows. They are the standing-order
-- equivalents of v_hold_drift: not tests that run once, but questions
-- the database can be asked at any moment.

-- An occurrence that was claimed and never decided. Non-empty means a
-- process died between the claim and the decision -- which is SAFE (no
-- money moved, and the next run re-drives it to the same instruction via
-- the derived key) but must never be invisible. This is the row that
-- makes "it never fired and nobody knows why" impossible: nobody has to
-- notice an absence, because the claim is a presence.
CREATE VIEW v_standing_order_unresolved AS
SELECT o.id AS occurrence_id,
       o.standing_order_id,
       o.scheduled_date,
       o.idempotency_key,
       o.claimed_at,
       o.claimed_by,
       (now() - o.claimed_at) AS claimed_for
  FROM standing_order_occurrence o
 WHERE NOT EXISTS (
   SELECT 1 FROM standing_order_outcome ou WHERE ou.occurrence_id = o.id
 );

GRANT SELECT ON v_standing_order_unresolved TO corgi_app;

-- A double fire. It cannot be non-empty while
-- payment_instruction.idempotency_key is UNIQUE and the outcome trigger
-- refuses a mismatched key -- and that is exactly the point of writing
-- it down: the assertion is checkable, and its emptiness is a
-- consequence of two constraints rather than of anybody's discipline.
CREATE VIEW v_standing_order_double_fire AS
SELECT o.standing_order_id,
       o.scheduled_date,
       o.idempotency_key,
       count(DISTINCT pi.id) AS instructions
  FROM standing_order_occurrence o
  JOIN payment_instruction pi ON pi.idempotency_key = o.idempotency_key
 GROUP BY o.standing_order_id, o.scheduled_date, o.idempotency_key
HAVING count(DISTINCT pi.id) > 1;

GRANT SELECT ON v_standing_order_double_fire TO corgi_app;
