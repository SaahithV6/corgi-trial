-- =====================================================================
-- 0023  Guard repairs: four assertions that read stronger than they were
-- =====================================================================
--
-- Every object in this file already existed. Nothing here adds a feature;
-- it repairs four places where a guard CLAIMED more than it CHECKED, and
-- each one was found and written down by the worker who built it, in the
-- document beside it, rather than quietly left for a reader to discover.
--
--   1. v_standing_order_double_fire could not return a row -- 0012 sec 14
--   2. standing_order_outcome recorded four of five balance terms
--      -- docs/BALANCE-DEFINITIONS.md sec 8
--   3. two dispute guards lived in TypeScript -- docs/DISPUTES.md sec 8.1, 8.2
--   4. v_accrual_gap bounded itself with CURRENT_DATE -- docs/ACCRUAL.md sec 10
--
-- 0012, 0019, 0020 and 0022 are applied and therefore immutable, so
-- everything below is additive: CREATE OR REPLACE over a view or a
-- function body, one ADD COLUMN, one ADD CONSTRAINT. No money row is
-- touched, nothing is backfilled, and no existing row changes meaning.
--
-- THE RULE THIS FILE IS WRITTEN AGAINST:
--
--     A GUARD YOU CANNOT MAKE FAIL ON PURPOSE IS NOT A GUARD.
--
-- A view asserted to be empty that is empty BY CONSTRUCTION does not
-- prove the thing it is quoted as proving. It is worse than no view,
-- because it converts an untested claim into a green tick -- and a
-- reviewer who sees the tick stops asking the question. Each repair
-- below is followed by the bad state that makes it fire; every one of
-- them was planted against this database inside a transaction and rolled
-- back before this migration was applied.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  v_standing_order_double_fire -- a guard that could not fail
-- ---------------------------------------------------------------------
--
-- WHAT IT CLAIMED.  0012 sec 14, and docs/STANDING-ORDERS.md sec 2, and the
-- integration suite, and scripts/compliance.mjs, all quote its emptiness
-- as the evidence that a scheduled date has never named two payments:
--
--     v_standing_order_double_fire   0    a scheduled date naming >1 instruction
--
-- WHAT IT ACTUALLY DID.  Nothing. The body was
--
--     JOIN payment_instruction pi ON pi.idempotency_key = o.idempotency_key
--     GROUP BY ... HAVING count(DISTINCT pi.id) > 1
--
-- and `payment_instruction.idempotency_key` is UNIQUE (0001 sec 12). An
-- equality join on a unique column yields at most one row per group, so
-- `count(DISTINCT pi.id)` is 0 or 1 and the HAVING clause can never be
-- satisfied. The view was tautologically empty: `SELECT ... WHERE false`
-- with extra steps. Its own comment said as much -- "it cannot be
-- non-empty while payment_instruction.idempotency_key is UNIQUE" -- and
-- that is precisely the admission that it was testing the unique index
-- rather than the system.
--
-- WHY IT IS NOT SIMPLY DELETED.  The claim it was quoted for is true, and
-- it is proved elsewhere and better: UNIQUE (standing_order_id,
-- scheduled_date) on the occurrence, a GENERATED ALWAYS idempotency key
-- derived from those two source facts, UNIQUE on
-- payment_instruction.idempotency_key, and assert_standing_order_outcome()
-- refusing an outcome whose instruction carries a different key. Those
-- four are the exactly-once proof and the view adds nothing to it. So the
-- honest options were to delete the view outright or to point it at a
-- question those four do NOT answer. There is such a question, and it is
-- the one that would actually pay a landlord twice:
--
--     IS THERE A SECOND INSTRUCTION THAT CLAIMS TO BE THIS OCCURRENCE?
--
-- The unique index defends the key. It does not defend the KEYSPACE. An
-- instruction raised for this mandate and this date under a DIFFERENT
-- spelling of the same key -- 'standing:<id>:2026-9-10' unpadded,
-- 'standing:<id>:2026-09-10:retry' suffixed, or the same string built by
-- application code that formatted the date through a session-dependent
-- to_char() -- is a second payment that every constraint in 0012 permits.
-- That is not a hypothetical: 0012 sec 2's whole argument for generating the
-- key in Postgres is that "if the application computed it, the
-- application could compute it wrong, and a wrong key is a second
-- payment". The generated column stops OUR path computing it wrong. This
-- view is what notices if some other path does.
--
-- SO THE JOIN IS ON THE NAMESPACE, NOT ON THE STRING.  An instruction is
-- attributed to an occurrence when its key is in that mandate's keyspace
-- ('standing:<order id>:...') AND it either carries the occurrence's
-- exact derived key or lands on the occurrence's scheduled date. One
-- instruction per occurrence is the healthy state; two is a double fire.
--
-- WHAT IT STILL CANNOT SEE, said plainly rather than left to be found: an
-- instruction outside the 'standing:' keyspace -- a hand-typed console
-- payment to the same payee for the same amount on the same day -- is
-- indistinguishable from a legitimate second payment, and this view does
-- not guess. Matching on shape alone (account, rail, amount, value date)
-- was tried against the live book and returned five instructions for a
-- single occurrence, all unrelated. A guard that cries wolf is the other
-- way to lose a reader.
--
-- HOW TO MAKE IT FAIL:  insert a payment_instruction whose key is in the
-- mandate's keyspace but is not the generated one, e.g.
--
--   BEGIN;
--   INSERT INTO payment_instruction (account_id, rail, amount_cents, currency,
--          counterparty, value_date, requested_by, policy_id, idempotency_key,
--          content_hash)
--   SELECT so.account_id, so.rail, so.amount_cents, so.currency, so.counterparty,
--          o.scheduled_date, so.created_by, pi.policy_id,
--          'standing:' || so.id || ':' || o.scheduled_date,   -- DateStyle-dependent spelling
--          pi.content_hash
--     FROM standing_order_occurrence o
--     JOIN standing_order so ON so.id = o.standing_order_id
--     JOIN payment_instruction pi ON pi.idempotency_key = o.idempotency_key
--    LIMIT 1;
--   SELECT * FROM v_standing_order_double_fire;   -- one row, instructions = 2
--   ROLLBACK;
--
-- Done, live, against this database. Under the old body the same planted
-- row returned nothing at all.
--
-- NOTE FOR WHOEVER OWNS src/components/standing/StandingView.tsx: the
-- operator note rendered when this view is non-empty still explains the
-- old body ("this view cannot be non-empty while ... is UNIQUE, so a
-- non-zero count here means that index is gone"). The title above it --
-- "A scheduled date names more than one payment instruction" -- is
-- exactly right for the new body; the sentence under it is now one index
-- too specific. That file belongs to another workstream and is not
-- touched here.

CREATE OR REPLACE VIEW v_standing_order_double_fire AS
SELECT o.standing_order_id,
       o.scheduled_date,
       o.idempotency_key,
       count(DISTINCT pi.id)                  AS instructions,
       -- Appended, so the operator does not have to write the query that
       -- answers "which two?" at the moment they least want to.
       array_agg(DISTINCT pi.id)              AS instruction_ids,
       array_agg(DISTINCT pi.idempotency_key) AS instruction_keys
  FROM standing_order_occurrence o
  JOIN payment_instruction pi
    -- the mandate's keyspace ...
    ON pi.idempotency_key LIKE 'standing:' || o.standing_order_id::text || ':%'
    -- ... and this occurrence within it, by the derived key OR by the
    -- date the money is dated to leave. The second disjunct is the one
    -- that catches a mis-spelled key, which is the whole point.
   AND (pi.idempotency_key = o.idempotency_key
        OR pi.value_date = o.scheduled_date)
 GROUP BY o.standing_order_id, o.scheduled_date, o.idempotency_key
HAVING count(DISTINCT pi.id) > 1;

COMMENT ON VIEW v_standing_order_double_fire IS
  'MUST BE EMPTY. One occurrence, at most one payment instruction claiming it. Joins on the mandate KEYSPACE, not on the unique key: the unique index already defends the exact string, so a view that joined on it could not fail. What this catches is a second instruction raised for the same mandate and date under a different spelling of the derived key.';


-- ---------------------------------------------------------------------
-- 2.  standing_order_outcome -- the fifth term of the identity
-- ---------------------------------------------------------------------
--
-- WHAT IT CLAIMED.  The refusal row carries "the four figures that were
-- observed at the moment of the decision: ledger, holds, uncleared and
-- available" (0012 sec 4), and every screen and test reads them as a
-- decomposition -- available = ledger - holds - uncleared.
--
-- WHAT IT ACTUALLY DID.  That was true when 0012 was written and stopped
-- being true when 0022 gave `available` a FIFTH term: committed
-- outbound flows, debits already booked for a future value date, which
-- reduce what the customer may spend without appearing in any of the
-- other four. So the recorded identity became an INEQUALITY,
--
--     available <= ledger - holds - uncleared
--
-- with an unexplained remainder, while `standing.integration.test.ts`
-- asserted it as an identity -- honestly, with the missing term named in
-- a comment, and with the real five-term identity asserted live instead.
-- The row on the screen still could not be made to add up by a reader
-- with a calculator, which is the only test that matters for a figure
-- printed next to the word "refused".
--
-- THE FIX its author named: add the column. It is appended; nothing is
-- rewritten. `standing_order_outcome` is append-only in two layers
-- (0012 sec 12) and rows written before this migration keep NULL in the new
-- column FOR EVER, which is the truthful value -- at the moment those
-- decisions were made nobody measured that term. A backfill would be a
-- measurement invented after the fact and stamped onto an audit row, and
-- an audit trail you can retro-fit is a story.
--
-- THE CHECK is what makes the column a guard rather than a field. It
-- fires only on rows that carry the term, so the historical rows are
-- untouched and every row written from here on must add up exactly.
--
-- HOW TO MAKE IT FAIL:
--
--   BEGIN;
--   INSERT INTO standing_order_outcome
--     (occurrence_id, disposition, refusal_code, refusal_reason,
--      observed_ledger_cents, observed_holds_cents, observed_uncleared_cents,
--      observed_pending_outbound_cents, observed_available_cents, decided_by_run)
--   VALUES (<an undecided occurrence>, 'refused', 'X', 'X',
--           100000, 10000, 5000, 2000, 85000, 'demo');  -- 85000 <> 83000
--   -- ERROR:  new row violates check constraint
--   --         "standing_order_outcome_availability_identity"
--   ROLLBACK;
--
-- Done, live. The same INSERT with 83000 is accepted, which is the other
-- half of the demonstration: the constraint refuses the wrong answer and
-- not the shape.

ALTER TABLE standing_order_outcome
  ADD COLUMN observed_pending_outbound_cents bigint;

COMMENT ON COLUMN standing_order_outcome.observed_pending_outbound_cents IS
  'The fifth term of ledger_availability() (0022): debits already booked for a future value date. NULL on rows decided before 0023 -- that term was not measured then, and an audit row is not backfilled with a number nobody observed.';

ALTER TABLE standing_order_outcome
  ADD CONSTRAINT standing_order_outcome_availability_identity CHECK (
    -- Rows from before 0023: no fifth term, no assertion. They remain
    -- exactly as they were written.
    observed_pending_outbound_cents IS NULL
    OR (
      -- A row that carries the fifth term carries all five, and they add
      -- up. This is ledger_availability()'s own arithmetic, asserted on
      -- the row rather than trusted from the caller -- 0020's "TypeScript
      -- computes, Postgres verifies", applied to the figure a refusal is
      -- explained by.
          observed_ledger_cents    IS NOT NULL
      AND observed_holds_cents     IS NOT NULL
      AND observed_uncleared_cents IS NOT NULL
      AND observed_available_cents IS NOT NULL
      AND observed_available_cents = observed_ledger_cents
                                   - observed_holds_cents
                                   - observed_uncleared_cents
                                   - observed_pending_outbound_cents
    )
  );

-- The history projection carries the new term too. CREATE OR REPLACE can
-- only APPEND columns, so it lands at the end rather than beside its four
-- siblings; correct beats tidy, and the alternative is dropping a view
-- three modules read.
CREATE OR REPLACE VIEW v_standing_order_history AS
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
       pi.requested_at             AS instruction_requested_at,
       ou.observed_pending_outbound_cents
  FROM standing_order_occurrence o
  JOIN standing_order so ON so.id = o.standing_order_id
  JOIN account acc ON acc.id = so.account_id
  LEFT JOIN standing_order_outcome ou ON ou.occurrence_id = o.id
  LEFT JOIN payment_instruction pi ON pi.id = ou.instruction_id;


-- ---------------------------------------------------------------------
-- 3a.  A dispute clawback was itself disputable
-- ---------------------------------------------------------------------
--
-- WHAT IT CLAIMED.  assert_dispute_intake() is 0019 sec 4's promise that what
-- may be disputed is decided "where the application cannot route around
-- it": a card entry, in the financial book, that debited this customer,
-- net of its correction group, within the amount not already claimed.
--
-- WHAT IT ACTUALLY DID.  Those rules are all true of a DISPUTE CLAWBACK.
-- When a case is lost, `DR 2100/<customer> / CR 1120` posts on the card
-- rail and debits the customer -- so it matched intake, and a customer
-- could dispute the recovery of their own provisional credit. There is
-- one such case standing in this book as evidence: dispute
-- ccbf1b9e-67f0-47b4-af8e-54640bbeebc9 was raised against entry
-- 104a6564-ba16-4610-a859-725c110de23a, which is the clawback entry of
-- dispute 2978c569-8f55-4890-98fb-bb16f150c558. It is left standing. It
-- is a real record of what the system permitted, and deleting history to
-- make a guard look older than it is would be the worse crime.
--
-- THE GUARD, as its author wrote it in docs/DISPUTES.md sec 8.1: a disputable
-- charge must ALSO CREDIT 2200, the card network settlement payable.
-- That is the shape of a real clearing or force post (postCardMovement in
-- src/lib/holds/store.ts) -- the customer was debited AND THE NETWORK WAS
-- PAID. A clawback credits 1120, a provisional credit credits 2100, a
-- write-off touches 5200, and the pre-0008 fixtures settled straight to
-- 1110: none of them credit 2200, because none of them is a purchase with
-- a merchant behind it and a network case to file.
--
-- WHY IT MOVES HERE.  It already existed, in listDisputableCharges(), and
-- it worked -- but as a filter on a LIST. A list is a suggestion. The
-- trigger is the rule, and the difference is any caller that reaches
-- INSERT INTO dispute without going through that function: the MCP write
-- surface, a script, a future screen, a debrief operator with psql. The
-- TypeScript clause stays where it is, because the form still needs the
-- list to exclude these charges before an operator can pick one; it is
-- now a courtesy in front of an enforcement, which is the right order.
--
-- HOW TO MAKE IT FAIL:
--
--   BEGIN;
--   INSERT INTO dispute (case_ref, disputed_entry_id, account_id, memo_account_id,
--                        reason, amount_cents, value_date, network_outside_date,
--                        raised_by, policy_id)
--   VALUES ('DEMO-CLAWBACK', '104a6564-...',  -- the clawback entry above
--           <2100 leaf>, <9200 leaf>, 'fraud', 7340, current_date,
--           current_date + 120, <raiser>, <card policy>);
--   -- ERROR:  entry 104a6564-... debits the customer but credits no network
--   --         settlement payable (2200): it is not a card clearing, so there
--   --         is nothing to dispute and no network case to file
--   ROLLBACK;
--
-- Done, live, on the very entry the live book already carries a dispute
-- against. Before this migration that INSERT succeeded.

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

  -- (e) 0023.  THE SUBJECT MUST BE A CLEARING, NOT ANY DEBIT ON THE CARD
  -- RAIL.  A real clearing or force post pays the network in the same
  -- entry that debits the customer, so it credits 2200.  A clawback
  -- (CR 1120), a provisional credit (CR 2100), a write-off (5200) and the
  -- pre-0008 fixtures that settled straight to 1110 do not -- and none of
  -- them is a purchase a network could rule on.  Checked on the ENTRY,
  -- not the correction group: a reversal or re-book of a clearing carries
  -- the same pair of legs, so a legitimately corrected settlement still
  -- passes on its own shape.
  IF NOT EXISTS (
    SELECT 1
      FROM journal_line  l
      JOIN account       a ON a.id = l.account_id
     WHERE l.entry_id = NEW.disputed_entry_id
       AND a.code = '2200'
       AND l.amount_cents < 0
  ) THEN
    RAISE EXCEPTION
      'entry % debits the customer but credits no network settlement payable (2200): it is not a card clearing, so there is nothing to dispute and no network case to file',
      NEW.disputed_entry_id USING ERRCODE = '42501';
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

-- 0003 hardened every definer/trigger function's search_path; a replaced
-- body keeps the setting, and this restates it so a reader of THIS file
-- does not have to take that on trust.
ALTER FUNCTION assert_dispute_intake() SET search_path = public, pg_temp;


-- ---------------------------------------------------------------------
-- 3b.  v_dispute_ledger double-counted one entry on a won case
-- ---------------------------------------------------------------------
--
-- WHAT IT CLAIMED.  "Every journal entry a dispute caused, with its
-- lines, in booking order" -- the episode screen's source of truth, where
-- every id can be looked up.
--
-- WHAT IT ACTUALLY DID.  It unions two sources: entries cited by an event,
-- and the memo entries reachable through the grant's hold. On a WON case
-- those sets overlap in exactly one place -- the finalising event cites
-- the hold RELEASE entry, which is also a memo posting on that hold --
-- and UNION does not collapse the two rows because `event_kind` differs
-- ('credit_finalized' vs 'hold_posting'). Every line of that entry came
-- back twice, and the episode screen printed the release twice: on a
-- screen whose entire purpose is that the ledger can be checked by hand,
-- $73.40 appeared to move twice. Two won cases in this book show it
-- (0cadea9b..., 2272e3a7...), four duplicated rows in total. It was
-- deduped at the read site with DISTINCT ON (entry_id, ordinal), which
-- worked and left the defect in the view for the next reader.
--
-- THE FIX, as docs/DISPUTES.md sec 8.2 says, belongs in the view -- and it is
-- an ANTI-JOIN, not a DISTINCT. The two sources are not duplicates in
-- general; they overlap for one identifiable reason, so the second source
-- yields only what the first does not already carry. A blanket DISTINCT
-- would have silenced any future duplicate as well, which is how one
-- fixed bug hides the next one. This way an entry that genuinely appears
-- under two events still shows twice, and v_dispute_ledger_double_count
-- below says so out loud.
--
-- The label survives too: an entry cited by an event keeps the event's
-- name, which is what tells a reader WHY the posting happened.
--
-- HOW TO MAKE IT FAIL:  see v_dispute_ledger_double_count below.

CREATE OR REPLACE VIEW v_dispute_ledger AS
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
     -- 0023: and NOT already carried by the first source. This is the
     -- whole repair. The finalising event cites the release posting on
     -- this same hold; naming it twice, once by its event and once as an
     -- anonymous 'hold_posting', printed the entry twice.
     AND NOT EXISTS (
       SELECT 1 FROM dispute_event c
        WHERE c.dispute_id = g.dispute_id
          AND c.entry_id   = e.id
     )
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

COMMENT ON VIEW v_dispute_ledger IS
  'Every journal line a dispute caused, financial and memo, once each. The memo source excludes entries already cited by one of the dispute''s own events -- the overlap that made a won case print its hold release twice.';

-- The invariant that keeps the repair honest.
--
-- MUST BE EMPTY, and unlike the view it replaces it CAN be non-empty: two
-- dispute events citing the same journal entry still produce two rows,
-- and they should, because that IS a double count on the screen. The
-- anti-join fixes the one overlap that had a structural cause; this view
-- watches for the rest.
--
-- HOW TO MAKE IT FAIL, live, in a transaction:
--
--   BEGIN;
--   -- an open case, and a second event citing an entry the case already cites
--   INSERT INTO dispute_event (dispute_id, kind, actor_id, value_date, entry_id,
--                              occurred_at)
--   VALUES (<open dispute>, 'evidence_submitted', <actor>, current_date,
--           <an entry another event already cites>, now() + interval '1 minute');
--   SELECT * FROM v_dispute_ledger_double_count;   -- one row per line, occurrences = 2
--   ROLLBACK;
--
-- (The explicit `occurred_at` is not incidental. Two events of the same
-- kind citing the same entry at the same instant are one row, because
-- the UNION collapses identical tuples and `occurred_at` defaults to
-- now(), which is the TRANSACTION's start. Two events a minute apart --
-- or of two different kinds -- are two rows, and two rows is the defect.)
CREATE VIEW v_dispute_ledger_double_count AS
SELECT dispute_id,
       entry_id,
       ordinal,
       count(*)               AS occurrences,
       array_agg(event_kind)  AS event_kinds
  FROM v_dispute_ledger
 GROUP BY dispute_id, entry_id, ordinal
HAVING count(*) > 1;

COMMENT ON VIEW v_dispute_ledger_double_count IS
  'MUST BE EMPTY. One journal line, one row per dispute. Non-empty means the episode screen is printing the same money twice.';

GRANT SELECT ON v_dispute_ledger_double_count TO corgi_app;


-- ---------------------------------------------------------------------
-- 4.  v_accrual_gap was on tomorrow for five hours a day
-- ---------------------------------------------------------------------
--
-- WHAT IT CLAIMED.  "Dates a schedule owes and nothing has claimed.
-- Persistently non-empty means the tick is not running."
--
-- WHAT IT ACTUALLY DID.  It bounded itself with CURRENT_DATE, which
-- resolves against the session TimeZone -- UTC on Neon -- while the book
-- day is America/New_York. Between 19:00 and midnight Eastern the view is
-- already on tomorrow and reports every live schedule as owing a day that
-- has not happened. Measured on this database while writing this
-- migration: 03:39 UTC, CURRENT_DATE 2026-09-11, book_date 2026-09-10,
-- v_accrual_gap 3 rows against a book that was fully caught up.
--
-- Nothing mis-posts -- runAccrual() takes its date from bookToday() and
-- refuses to run ahead of the book -- but an indicator that cries wolf
-- every evening is an indicator nobody reads by the second week, and this
-- one is the only thing standing between a silent cron failure and a
-- month of unbilled fees.
--
-- THE FIX is the one-line one its author wrote down: book_date(now()),
-- which is the same function `v_standing_order_next`, 0022's live point
-- and bookToday() all resolve "today" through. 0001 sec 0's rule, applied:
-- the book day is a banking-timezone fact and CURRENT_DATE is not it.
--
-- HOW TO MAKE IT FAIL:  it is not an invariant and it is not in dbcheck's
-- INVARIANT_VIEWS -- a gap is a real operational state, not an impossible
-- one. It is made non-empty by not running the tick for a day, which is
-- exactly what it is for. What can be demonstrated is that it now agrees
-- with the book: at 03:39 UTC on 2026-09-11 the old body returned 3 and
-- the new body returns 0, and readInvariants()'s hand-written copy of the
-- corrected question -- written because the view could not be trusted --
-- returns 0 as well. That copy is deleted in the same change, because two
-- definitions of one question is the defect DECISIONS 024 is about.

CREATE OR REPLACE VIEW v_accrual_gap AS
SELECT s.id AS schedule_id, s.account_id, s.plan_name, d AS missing_date
  FROM accrual_schedule s
  CROSS JOIN LATERAL accrual_due_dates(
    s.id, s.start_date,
    LEAST(COALESCE(s.end_date, book_date(now())), book_date(now()))
  ) AS d;

COMMENT ON VIEW v_accrual_gap IS
  'Dates a schedule owes and nothing has claimed, bounded by the BOOK day (book_date(now()), America/New_York) and not by CURRENT_DATE, which is UTC on Neon and five hours ahead of the book every evening.';
