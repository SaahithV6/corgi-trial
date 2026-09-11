-- =====================================================================
-- 0057  A POT MAY NOT GO NEGATIVE  -  prevention, where 0015 shipped
--                                     detection
-- =====================================================================
--
-- `v_pot_negative` (0015 §5) DETECTS a negative pot.  It does not
-- PREVENT one.  Measured, on this book, as corgi_app, through
-- `ledger_append()`, with every trigger armed and nothing disabled:
--
--   pot           Payroll — October (9e353cea-…) holding 1,200,000 cents
--   probe         $1,000,000.00 released out of it into its own 2100
--   v_pot_negative   before 0
--   RESULT           POSTED CLEANLY — the money moved
--   v_pot_negative   after  1   [{"Payroll — October", -98,800,000}]
--
-- The money moved; a view noticed afterwards.  For a savings pot that is
-- an unsecured overdraft nobody authorised, and finding out from a
-- report is finding out too late.  This migration refuses the write.
--
-- ---------------------------------------------------------------------
-- 1.  WHY NOT A CHECK CONSTRAINT
-- ---------------------------------------------------------------------
--
-- `je_memo_has_hold` (0001 §7) is the live example of a CHECK refusing a
-- malformed money write, and it is the shape to reach for first.  It
-- cannot be reached for here.  A pot's balance is an AGGREGATE over many
-- `journal_line` rows and a CHECK sees one row.  There is no column on
-- `journal_line` whose value decides this question, because the question
-- is about the SUM of a column across rows that the row being checked
-- does not know about.
--
-- ---------------------------------------------------------------------
-- 2.  WHY NOT A MATERIALISED BALANCE COLUMN
-- ---------------------------------------------------------------------
--
-- `pot.balance_cents bigint CHECK (balance_cents >= 0)`, maintained by a
-- trigger, would turn the aggregate into a column and let a CHECK see
-- it.  It is the fastest thing available and it is refused here for a
-- reason this codebase already treats as a defect in its own right:
--
--   * `ledger_availability()` is THE definition of availability, five
--     terms, and 0022 exists because a second definition drifted.
--     `v_pot_balance` is THE definition of a pot's balance, one line
--     over `v_ledger_balance`.  A stored column is a SECOND place a
--     balance lives, and the day the two disagree the CHECK is guarding
--     the copy rather than the money.
--   * `pot` is append-only (0015 §1: `pot_no_update_delete`, and
--     corgi_app holds SELECT on it and nothing else).  A maintained
--     balance column needs UPDATE on `pot`, which means unpicking the
--     immutability trigger and the privilege that backs it -- paying for
--     speed with the guarantee the rest of the book is built on.
--   * Gauntlet item 1: available must be derived from events, "never a
--     second stored number that drifts and gets fixed by a cron job".
--     `scripts/rebuild.mjs` re-derives every figure in plain JavaScript
--     precisely so that claim is checkable.  A stored pot balance is
--     that second number.
--
-- ---------------------------------------------------------------------
-- 3.  WHY NOT INSIDE `ledger_append()`
-- ---------------------------------------------------------------------
--
-- `ledger_append()` is "THE ONLY SANCTIONED WRITE PATH" (0001 §14) and
-- every money write funnels through it, so a check there would catch
-- every writer that exists today.  It is still the wrong layer, and the
-- reason is one grant:
--
--     GRANT SELECT, INSERT ON journal_entry, journal_line, … TO corgi_app;
--                                       ^^^^^^^^^^^^
--
-- The application role can express `INSERT INTO journal_line` directly.
-- It does not today -- `postEntry()` is the only caller and it calls the
-- function -- but "the only writer today always does X" is exactly the
-- argument that made `v_internal_transfer_impure` the weakest guard in
-- the book (0052).  A guard installed in a function is a guard whose
-- reach is the set of callers who choose to call that function, and the
-- writer chooses.  A guard installed on the TABLE is not optional: the
-- only way past it is to not write a journal line, and a module that
-- writes no journal line is not the hazard.
--
-- The same argument disqualifies anchoring on `rail`, on an
-- `idempotency_key` prefix, on `entry_type` or on a description.  Those
-- are all the writer's own label.  This guard's population is
--
--     journal_line.account_id IN (SELECT account_id FROM pot)
--
-- -- 0052's population, the same fact about the chart: `pot.account_id`
-- is UNIQUE, NOT NULL and its row is append-only, so membership cannot
-- be argued with by the code writing the entry.
--
-- And it is not dodgeable BY AMOUNT, which is the other half of
-- instance 27.  `v_pot_negative` catches a foreign write only when the
-- amount happens to break the balance: move less than the pot holds and
-- the same unauthorised write is invisible.  That property belongs to
-- DETECTION of a foreign writer, and it is `v_pot_line_provenance`
-- (0052) that answers it -- which is why that view stays, and why this
-- one is not sold as a replacement for it.  What is asserted here is
-- narrower and total within itself: NO amount, from ANY writer, on ANY
-- rail, under ANY key, may leave a pot holding less than nothing.
--
-- ---------------------------------------------------------------------
-- 4.  WHY IT IS DEFERRED, AND THE ARRIVAL-ORDER TRAP
-- ---------------------------------------------------------------------
--
-- `H(E) = 0 if closed(E) else max(A(E) − C(E), 0)` is a pure function of
-- an event SET, deliberately order-independent, because no arrival order
-- may be a special case.  A guard that is order-dependent re-introduces
-- exactly what the hold model spent 0008 and 0036 removing.
--
-- An IMMEDIATE trigger is order-dependent.  A transaction that releases
-- $12,000.00 from a pot and earmarks $12,000.00 back into it is the same
-- transaction in either order and ends with the same balance, but an
-- immediate check refuses it when the release is inserted first and
-- accepts it when the earmark is.  That is an arrival order being a
-- special case.
--
-- So this is a CONSTRAINT TRIGGER, `DEFERRABLE INITIALLY DEFERRED` --
-- the shape `journal_line_balanced` already uses, and for the same
-- reason: the question is only answerable once every row of the
-- transaction exists.  It is evaluated against the END STATE, so the
-- order rows arrived in is not a fact it can see.
--
-- §11's assertions prove this rather than claim it: the probe is run
-- with the pot driven to −$12,000.00 in the MIDDLE of the transaction
-- and restored by a later entry, and it is ACCEPTED.
--
-- ---------------------------------------------------------------------
-- 5.  ZERO IS LEGAL
-- ---------------------------------------------------------------------
--
-- The predicate is `balance_cents < 0`, the same strict inequality
-- `v_pot_negative` uses, and not `<= 0`.  A pot drained to exactly
-- $0.00 is a normal, correct state -- instance 27 was found on a pot at
-- exactly zero, and `dbcheck --prove`'s pot seeds are pinned in a total
-- order (0052) because an unordered `LIMIT 1` kept landing on one.  An
-- off-by-one here would refuse ordinary use, which is worse than the
-- detection it replaced.  §11 asserts a drain to exactly $0.00 is
-- accepted.
--
-- ---------------------------------------------------------------------
-- 6.  THE LOCK, AND WHY THE TRIGGER TAKES IT ITSELF
-- ---------------------------------------------------------------------
--
-- Check-then-act across two transactions is the oldest hole there is,
-- and 0015 §3 already closed it for the legitimate path:
-- `movePotFunds()` calls `lock_business_deposits()` as the first
-- statement of its transaction, so two concurrent movers of one
-- customer's deposits serialise.
--
-- A FOREIGN writer takes no such lock -- that is what makes it foreign.
-- Two transactions each releasing $60.00 from a pot holding $100.00
-- would each evaluate this guard against a balance the other's
-- uncommitted row is not in, both see $40.00, and both commit, leaving
-- −$20.00.  A guard the writer has to cooperate with is the thing this
-- migration exists to stop being.
--
-- So the trigger takes the lock itself, by calling the SAME definer
-- function the legitimate path calls, over the SAME total order
-- (`ORDER BY a.id` across the customer's 2100 leaf and every pot
-- beneath it).  Consequences, stated:
--
--   * On the legitimate path it is free.  `movePotFunds()` already holds
--     those row locks from statement 1, and re-taking a lock you hold is
--     a no-op.
--   * It runs at COMMIT, not at INSERT, so the hold window is the
--     shortest one available.
--   * One call locks the customer's WHOLE deposit family, so a
--     transaction touching several of one customer's pots acquires
--     everything on the first firing and the rest are no-ops.  Two
--     transactions can therefore only deadlock by touching two DIFFERENT
--     customers' pots in opposite orders -- an entry
--     `v_pot_line_provenance` already reports as "spans more than one
--     customer", and which no writer here performs.  If it ever
--     happened Postgres would abort one side, which is a REFUSAL: the
--     failure direction a money guard should fail in.
--
-- SECURITY DEFINER, `search_path` pinned, the house form for every
-- definer function in this schema (0015 §2/§3, 0003).  Not to reach
-- privileges the caller lacks in the usual sense -- corgi_app can read
-- `pot` and `v_pot_balance` -- but because a guard whose reach depends
-- on the WRITER's privileges is a guard the writer can narrow by
-- arriving as a role that cannot see `pot`.  It is the same argument as
-- §3, one layer down.
--
-- ---------------------------------------------------------------------
-- 7.  THE REFUSAL NAMES ITS OWN FIX
-- ---------------------------------------------------------------------
--
-- House form: `PAYEE_WARNING_UNACKNOWLEDGED`, `PAYEE_BOOK_UNREADABLE`.
-- A refusal a caller can act on is a NAMED code, not a Postgres string
-- a UI has to pattern-match on punctuation.  This one raises
--
--     POT_WOULD_GO_NEGATIVE
--
-- as the first token of the message, as the constraint name on the
-- error (postgres.js surfaces it as `constraint_name`), and with the
-- arithmetic spelled out in the DETAIL the way `decideMove()`'s
-- refusals are -- the pot, what it holds now, what the write would leave
-- it holding, and the shortfall.  `movePotFunds()` maps the token to a
-- `MoveResult` refusal code of the same name, so the caller gets
-- `POT_WOULD_GO_NEGATIVE` rather than `MOVE_FAILED`.
--
-- ERRCODE 23514 (check_violation), the same code every other structural
-- refusal in 0001 raises.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 8.  The guard
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_pot_not_negative() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_pot_id      uuid;
  v_business    uuid;
  v_name        text;
  v_balance     bigint;
BEGIN
  -- The population, and the whole of it: is this line on an account the
  -- `pot` table names?  One probe of a UNIQUE index.  Every money write
  -- in the system pays exactly this and nothing more; the rest of the
  -- function is reached only by lines that actually touch a pot.
  SELECT p.id, p.business_id, p.name
    INTO v_pot_id, v_business, v_name
    FROM pot p
   WHERE p.account_id = NEW.account_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- §6.  The same lock the legitimate path takes, over the same total
  -- order, so a writer that did not bother to take it is serialised
  -- anyway.  Free when the caller already holds it.
  PERFORM lock_business_deposits(v_business);

  -- §2.  `v_pot_balance` is the ONE definition of a pot's balance and
  -- this reads it rather than restating it.  The planner pushes the
  -- account_id down through the GROUP BY into an index-only scan on
  -- journal_line_booking_idx: measured at 0.10 ms on this book.
  SELECT b.balance_cents INTO v_balance
    FROM v_pot_balance b
   WHERE b.account_id = NEW.account_id;

  -- §5.  Strictly less than zero.  Exactly $0.00 is a normal state.
  IF v_balance < 0 THEN
    RAISE EXCEPTION
      'POT_WOULD_GO_NEGATIVE: pot "%" (%) would hold % cents, which is less than nothing',
      v_name, v_pot_id, v_balance
      USING ERRCODE = '23514',
            CONSTRAINT = 'journal_line_pot_not_negative',
            DETAIL = format(
              'This entry leaves account %s — pot "%s" of business %s — at %s cents. '
              || 'A pot is this bank''s own construct: nothing external can authorise '
              || 'against one, so a negative pot is never a fact about the world, only '
              || 'an unsecured overdraft nobody asked for. The write is refused; '
              || 'v_pot_negative would only have reported it afterwards.',
              NEW.account_id, v_name, v_business, v_balance),
            HINT =
              'Release no more than the pot holds. movePotFunds() checks this before '
              || 'posting (INSUFFICIENT_POT) on figures held still by '
              || 'lock_business_deposits(); reaching this trigger means the write did '
              || 'not come through that path.';
  END IF;

  RETURN NULL;
END $$;

ALTER FUNCTION assert_pot_not_negative() SET search_path = public, pg_temp;
REVOKE ALL ON FUNCTION assert_pot_not_negative() FROM PUBLIC;

COMMENT ON FUNCTION assert_pot_not_negative() IS
  'Refuses any transaction that would leave a pot holding less than nothing. Population: journal_line.account_id IN (SELECT account_id FROM pot) - a fact about the chart, not the writer''s label. Deferred to COMMIT, so it judges the end state and no arrival order is a special case. Raises POT_WOULD_GO_NEGATIVE. See db/migrations/0057_pot_negative_prevented.sql.';


-- ---------------------------------------------------------------------
-- 9.  The trigger.  ON THE TABLE, not in the function (§3).
-- ---------------------------------------------------------------------
--
-- `journal_line_balanced`'s shape exactly: AFTER INSERT, FOR EACH ROW,
-- DEFERRABLE INITIALLY DEFERRED.  There is no UPDATE or DELETE arm
-- because there is no UPDATE or DELETE on this table -- 0001 §13 revokes
-- both from corgi_app and PUBLIC and `ledger_row_is_immutable()` refuses
-- them for everyone else.  The ledger is append-only, so prevention
-- means REFUSING THE WRITE; there is no repair-after arm to write.

CREATE CONSTRAINT TRIGGER journal_line_pot_not_negative
  AFTER INSERT ON journal_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_pot_not_negative();


-- ---------------------------------------------------------------------
-- 10.  What could still bypass it, made visible
-- ---------------------------------------------------------------------
--
-- Prevention and detection are not substitutes.  `v_pot_negative` stays
-- exactly as 0015 wrote it, because if this trigger is ever bypassed
-- something must still notice.  The bypasses are:
--
--   1. `ALTER TABLE journal_line DISABLE TRIGGER
--      journal_line_pot_not_negative`, as the table owner.  corgi_app
--      cannot: ALTER TABLE requires ownership and is not grantable.
--   2. `SET session_replication_role = replica`, superuser/owner only,
--      which silences every non-replica trigger on the database at once.
--   3. A direct write by the owner with the trigger dropped.
--
-- All three are owner-level acts, and all three are exactly what
-- `dbcheck --prove`'s `disable:` arm exists to perform deliberately.
-- What is NOT acceptable is for one to happen and leave no trace, so
-- the first two are made READABLE: the view below reports the guard
-- whenever it is not armed for ordinary writes.  It reads `pg_trigger`,
-- which is a fact about the catalogue -- the §3 argument applied to the
-- guard itself.
--
-- `tgenabled`: 'O' origin (armed, the normal state), 'D' disabled,
-- 'R' replica-only, 'A' always.  Anything but 'O' or 'A' means an
-- ordinary INSERT does not reach the guard.

CREATE VIEW v_pot_guard_disarmed AS
SELECT c.relname                     AS table_name,
       t.tgname                      AS trigger_name,
       t.tgenabled                   AS enabled_flag,
       CASE t.tgenabled
         WHEN 'D' THEN 'DISABLED — an ordinary INSERT does not reach the guard'
         WHEN 'R' THEN 'REPLICA ONLY — origin writes do not reach the guard'
         ELSE 'not armed for origin writes'
       END                           AS state
  FROM pg_trigger t
  JOIN pg_class   c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND t.tgname = 'journal_line_pot_not_negative'
   AND t.tgenabled NOT IN ('O', 'A')
UNION ALL
-- And the harder case: the trigger is not there at all.  A view that
-- only ever inspects rows it finds cannot report a row that was
-- dropped, which is how a guard goes quiet without going red.
SELECT 'journal_line', 'journal_line_pot_not_negative', '-',
       'ABSENT — the trigger does not exist on this database'
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'journal_line'
      AND t.tgname = 'journal_line_pot_not_negative');

COMMENT ON VIEW v_pot_guard_disarmed IS
  'MUST BE EMPTY. The 0057 negative-pot guard is missing or not armed for ordinary writes. Prevention does not retire v_pot_negative - this view is how the third state (the guard was switched off) becomes visible rather than silent. See db/migrations/0057_pot_negative_prevented.sql section 10.';

GRANT SELECT ON v_pot_guard_disarmed TO corgi_app;


-- ---------------------------------------------------------------------
-- 11.  The migration refuses to commit if the guard arrives red
-- ---------------------------------------------------------------------
--
-- 0043/0052/0054's closing shape, and then some: a guard nobody has
-- seen REFUSE is a claim, so this block does not only assert the book is
-- clean, it MAKES THE GUARD FIRE and asserts it fired, and makes the two
-- legal shapes it must NOT refuse and asserts they passed.
--
-- Each probe runs in a plpgsql sub-block, which is a subtransaction, and
-- every one of them ends by raising -- so nothing any probe writes
-- survives this block.  `SET CONSTRAINTS journal_line_pot_not_negative
-- IMMEDIATE` is what stands in for COMMIT: it forces the pending
-- deferred check to be evaluated at that point, which is precisely what
-- COMMIT would do.  The setting is transaction-local and the
-- subtransaction unwinds it.
--
-- The four pot views from 0015 and 0052's fifth are asserted UNDISTURBED
-- for 0052's reason: this migration creates a trigger and a view and
-- touches no data, so any movement in them means something else is
-- wrong and this is where a human finds out.

DO $$
DECLARE
  v_negative   int;
  v_identity   int;
  v_orphan     int;
  v_impure     int;
  v_provenance int;
  v_disarmed   int;
  v_pots       int;
  v_lines      int;

  v_pot_acct   uuid;
  v_main_acct  uuid;
  v_entity     uuid;
  v_actor      uuid;
  v_bal        bigint;
  v_msg        text;
  v_probe      text;
BEGIN
  -- ---- 11.1  the book this guard arrives on -------------------------
  SELECT count(*) INTO v_negative   FROM v_pot_negative;
  SELECT count(*) INTO v_identity   FROM v_pot_identity_drift;
  SELECT count(*) INTO v_orphan     FROM v_pot_orphan;
  SELECT count(*) INTO v_impure     FROM v_internal_transfer_impure;
  SELECT count(*) INTO v_provenance FROM v_pot_line_provenance;

  IF v_negative <> 0 OR v_identity <> 0 OR v_orphan <> 0
     OR v_impure <> 0 OR v_provenance <> 0 THEN
    RAISE EXCEPTION
      '0057 refuses to commit: v_pot_negative=% v_pot_identity_drift=% v_pot_orphan=% v_internal_transfer_impure=% v_pot_line_provenance=% (all five must be 0 — a prevention migration must not arrive on a book that already has the thing it prevents)',
      v_negative, v_identity, v_orphan, v_impure, v_provenance;
  END IF;

  SELECT count(*) INTO v_disarmed FROM v_pot_guard_disarmed;
  IF v_disarmed <> 0 THEN
    RAISE EXCEPTION
      '0057 refuses to commit: v_pot_guard_disarmed = % — the trigger this migration just created is not armed',
      v_disarmed;
  END IF;

  -- ---- 11.2  a seed to probe with, pinned in a TOTAL ORDER ----------
  --
  -- 0052's rule, and it was learned the hard way: its provenance probe
  -- drew a pot on an unordered LIMIT 1, got one this book had already
  -- drained to $0.00, and measured a different guard entirely.  The
  -- richest pot, and its own main leaf via a.parent_id -- NOT
  -- `code = '2100' LIMIT 1`, which can return the house rollup and
  -- trips assert_entry_balanced() instead of this guard.
  SELECT p.account_id, a.parent_id, a.entity_id, b.balance_cents
    INTO v_pot_acct, v_main_acct, v_entity, v_bal
    FROM pot p
    JOIN account a        ON a.id = p.account_id
    JOIN v_pot_balance b  ON b.account_id = p.account_id
   ORDER BY b.balance_cents DESC, p.id
   LIMIT 1;

  SELECT id INTO v_actor FROM actor ORDER BY id LIMIT 1;

  IF v_pot_acct IS NULL OR v_main_acct IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION
      '0057 refuses to commit: no pot to prove the guard against. A guard nobody has seen refuse is a claim, and this migration does not ship one.';
  END IF;

  IF v_bal <= 0 THEN
    RAISE EXCEPTION
      '0057 refuses to commit: the richest pot on this book holds % cents, so the probes below would measure some other guard',
      v_bal;
  END IF;

  -- ---- 11.3  THE PROBE MUST NOW BE REFUSED --------------------------
  --
  -- The exact write that posted cleanly: released out of the pot into
  -- its own main 2100, rail internal, through ledger_append(), nothing
  -- disabled.  $1,000,000.00 over what the pot holds.
  BEGIN
    PERFORM ledger_append(
      v_entity, current_date, 'financial'::account_book, 'original'::entry_type,
      '0057 §11.3: a pot driven below zero',
      '0057-probe-negative:' || gen_random_uuid()::text, v_actor,
      jsonb_build_array(
        jsonb_build_object('account_id', v_pot_acct,  'amount_cents', (v_bal + 100000000)::text, 'currency', 'USD', 'memo', '0057 probe'),
        jsonb_build_object('account_id', v_main_acct, 'amount_cents', (-(v_bal + 100000000))::text, 'currency', 'USD', 'memo', '0057 probe')),
      'internal'::rail, NULL, NULL, NULL, NULL, NULL);

    -- Stands in for COMMIT: evaluate the pending deferred check NOW.
    SET CONSTRAINTS journal_line_pot_not_negative IMMEDIATE;

    -- Reaching here means the guard did not fire.  Raise to unwind the
    -- subtransaction, and carry that fact out in the message.
    RAISE EXCEPTION 'POT_PROBE_POSTED_CLEANLY';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  -- Back to DEFERRED explicitly rather than trusting the subtransaction to
  -- unwind the SET: §11.5 is only a proof of order-independence if the check
  -- it runs under is the deferred one the product actually commits through.
  SET CONSTRAINTS journal_line_pot_not_negative DEFERRED;

  IF v_msg LIKE '%POT_PROBE_POSTED_CLEANLY%' THEN
    RAISE EXCEPTION
      '0057 refuses to commit: the negative-pot probe STILL POSTS CLEANLY with the trigger installed. The guard does not guard.';
  END IF;
  IF v_msg NOT LIKE '%POT_WOULD_GO_NEGATIVE%' THEN
    RAISE EXCEPTION
      '0057 refuses to commit: the probe was refused, but not by this guard and not with its code — got: %', v_msg;
  END IF;
  v_probe := v_msg;

  -- ---- 11.4  ZERO IS LEGAL ------------------------------------------
  --
  -- The pot drained to EXACTLY $0.00.  Instance 27 was found on a pot at
  -- exactly zero; an off-by-one here refuses ordinary use.
  v_msg := NULL;
  BEGIN
    PERFORM ledger_append(
      v_entity, current_date, 'financial'::account_book, 'original'::entry_type,
      '0057 §11.4: a pot drained to exactly $0.00',
      '0057-probe-zero:' || gen_random_uuid()::text, v_actor,
      jsonb_build_array(
        jsonb_build_object('account_id', v_pot_acct,  'amount_cents', v_bal::text, 'currency', 'USD', 'memo', '0057 probe'),
        jsonb_build_object('account_id', v_main_acct, 'amount_cents', (-v_bal)::text, 'currency', 'USD', 'memo', '0057 probe')),
      'internal'::rail, NULL, NULL, NULL, NULL, NULL);

    SET CONSTRAINTS journal_line_pot_not_negative IMMEDIATE;

    SELECT b.balance_cents INTO v_bal FROM v_pot_balance b WHERE b.account_id = v_pot_acct;
    IF v_bal <> 0 THEN
      RAISE EXCEPTION 'POT_ZERO_PROBE_MISSED: the drain left % cents, not 0', v_bal;
    END IF;
    RAISE EXCEPTION 'POT_ZERO_PROBE_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  SET CONSTRAINTS journal_line_pot_not_negative DEFERRED;

  IF v_msg NOT LIKE '%POT_ZERO_PROBE_ACCEPTED%' THEN
    RAISE EXCEPTION
      '0057 refuses to commit: a pot drained to exactly $0.00 was NOT accepted. Zero is a normal state and a guard that refuses it is worse than the detection it replaced — got: %', v_msg;
  END IF;

  -- ---- 11.5  NO ARRIVAL ORDER IS A SPECIAL CASE ---------------------
  --
  -- The pot is driven to −$5,000.00 by the first entry and brought back
  -- to exactly $0.00 by the second, in the order an immediate check
  -- would refuse.  The deferred check judges the END STATE, so this is
  -- accepted -- and if it ever is not, this guard has become
  -- order-dependent and the hold model's whole argument has been
  -- contradicted one table over.
  SELECT b.balance_cents INTO v_bal FROM v_pot_balance b WHERE b.account_id = v_pot_acct;
  v_msg := NULL;
  BEGIN
    -- out first: the pot goes to -(v_bal + 500000) mid-transaction
    PERFORM ledger_append(
      v_entity, current_date, 'financial'::account_book, 'original'::entry_type,
      '0057 §11.5: release, arriving first',
      '0057-probe-order-out:' || gen_random_uuid()::text, v_actor,
      jsonb_build_array(
        jsonb_build_object('account_id', v_pot_acct,  'amount_cents', (v_bal + 500000)::text, 'currency', 'USD', 'memo', '0057 probe'),
        jsonb_build_object('account_id', v_main_acct, 'amount_cents', (-(v_bal + 500000))::text, 'currency', 'USD', 'memo', '0057 probe')),
      'internal'::rail, NULL, NULL, NULL, NULL, NULL);

    -- in second: brings it back from −$5,000.00 to exactly $0.00
    PERFORM ledger_append(
      v_entity, current_date, 'financial'::account_book, 'original'::entry_type,
      '0057 §11.5: earmark, arriving second',
      '0057-probe-order-in:' || gen_random_uuid()::text, v_actor,
      jsonb_build_array(
        jsonb_build_object('account_id', v_main_acct, 'amount_cents', '500000', 'currency', 'USD', 'memo', '0057 probe'),
        jsonb_build_object('account_id', v_pot_acct,  'amount_cents', '-500000', 'currency', 'USD', 'memo', '0057 probe')),
      'internal'::rail, NULL, NULL, NULL, NULL, NULL);

    SET CONSTRAINTS journal_line_pot_not_negative IMMEDIATE;
    RAISE EXCEPTION 'POT_ORDER_PROBE_ACCEPTED';
  EXCEPTION WHEN OTHERS THEN
    v_msg := SQLERRM;
  END;
  SET CONSTRAINTS journal_line_pot_not_negative DEFERRED;

  IF v_msg NOT LIKE '%POT_ORDER_PROBE_ACCEPTED%' THEN
    RAISE EXCEPTION
      '0057 refuses to commit: the guard is ORDER-DEPENDENT. A release arriving before the earmark that covers it was refused, though the transaction ends with the pot at the balance it started with — got: %', v_msg;
  END IF;

  -- ---- 11.6  nothing the probes wrote survived ----------------------
  SELECT count(*) INTO v_negative FROM v_pot_negative;
  IF v_negative <> 0 THEN
    RAISE EXCEPTION
      '0057 refuses to commit: v_pot_negative reads % after the probes — a subtransaction did not unwind',
      v_negative;
  END IF;

  SELECT count(*) INTO v_pots FROM pot;
  SELECT count(*) INTO v_lines
    FROM journal_line l WHERE l.account_id IN (SELECT account_id FROM pot);

  RAISE NOTICE '0057: the negative-pot probe is REFUSED — %', v_probe;
  RAISE NOTICE '0057: zero is legal (a drain to exactly $0.00 was accepted) and the guard is order-independent (a release arriving before its earmark was accepted)';
  RAISE NOTICE '0057: armed over % pot account(s) and the % journal line(s) already on them; v_pot_negative stays, and v_pot_guard_disarmed reports the guard being switched off',
    v_pots, v_lines;
END $$;
