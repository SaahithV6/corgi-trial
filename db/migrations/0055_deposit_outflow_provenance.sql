-- =====================================================================
-- 0055  DEPOSIT OUTFLOW PROVENANCE  -  hole 1, and the whitelist that
--                                     would have looked like closing it
-- =====================================================================
--
-- 0054 closed two dodges and RANKED WHAT IT LEFT OPEN.  Hole 1 was the
-- largest: a customer's money moved out to a house account that is not
-- the `2100` control.  One customer, one entry, and
-- `v_deposit_cross_customer` passes it, because it IS one customer.
--
-- MEASURED (dodge I), as corgi_app, through `ledger_append()`, in a
-- transaction that was rolled back: $500,000.00 moved out of business
-- 7e57b115-...-0000000000f2's `2100` into house `1000 Cash at bank`,
-- ach rail, `ach:` key.  TWELVE guards, every one green:
--
--   v_deposit_cross_customer   v_deposit_control_drift
--   v_book_not_zero            v_entry_unbalanced
--   v_balance_definition_drift v_pot_identity_drift
--   v_pot_negative             v_internal_transfer_impure
--   v_pot_line_provenance      v_value_date_unexplained
--   v_memo_line_placement      v_line_denorm_drift
--
-- ---------------------------------------------------------------------
-- THE QUESTION THIS MIGRATION HAD TO ANSWER FIRST
-- ---------------------------------------------------------------------
--
-- Is the honest guard
--
--   (A) "customer money may not leave `2100` except through a NAMED SET
--        of house accounts", or
--   (B) "an entry moving customer money to a house account must carry
--        PROVENANCE, the way a pot move does"?
--
-- (A) LOOKS like it works on this book, and that is the trap.  Ten house
-- accounts receive customer deposit money here.  `1000 Cash at bank` is
-- not one of them -- it receives NOTHING -- so a whitelist of the ten
-- would have reported dodge I, and the migration would have shipped
-- green with a proof attached.
--
-- IT WOULD HAVE BEEN WORTHLESS, and that was measured too rather than
-- argued.  DODGE I-PRIME: the identical $500,000.00 theft, from the same
-- customer, one account over -- into `1110 Cash - FBO settlement account
-- at sponsor bank`.  An asset.  Real money.  And an account any
-- whitelist MUST contain, because 145 legitimate entries use it.  Every
-- guard stayed green, and a whitelist containing `1110` stays green too.
--
-- So (A)'s discriminating power against anyone who reads the chart is
-- ZERO.  It catches the dodge that happened to be written first and
-- fails the dodge one line different.  That is exactly
-- `v_internal_transfer_impure`'s defect -- the guard is satisfied by the
-- writer choosing the right label -- and 0054's header rejected a
-- key-prefix whitelist for the same reason.  An account-code whitelist
-- is the same shape with a different column, and shipping it BECAUSE it
-- happened to catch the first probe would have been the worst outcome
-- available: a green tick, a passing proof, and no guard.
--
-- (B) is therefore the only honest form.  The reason is not stylistic.
-- A LEGITIMATE PAYOUT AND A THEFT ARE THE SAME TRANSACTION: customer
-- liability down, house asset down, two balanced lines, one currency,
-- one entity.  Side by side with a real cited ACH payout, dodge I
-- differs in NOTHING a balance or a chart shape can see.  The difference
-- is not in the money.  It is in whether anybody asked for it -- and
-- "anybody asked for it" is a row in another table, not a number.
--
-- ---------------------------------------------------------------------
-- WHAT (B) COSTS, STATED BEFORE IT IS BUILT
-- ---------------------------------------------------------------------
--
-- The strictest form of (B) is "an operational record must CITE this
-- entry by foreign key".  Measured over the 3,066 entries in the
-- population:
--
--   cited by an FK      2,660
--   NOT cited             406   $20,696,710.17 of customer money
--
-- and 303 of those 406 are CARD SETTLEMENTS.  Their provenance is real
-- -- a Lithic network reference -- but this schema has no foreign key
-- from a card settlement back to any card record, so the strict guard
-- would call 303 explained postings unexplained.
--
-- THAT GUARD IS NOT SHIPPED HERE, and the reason is the one 0043's
-- header gives from the other direction: a red that is mostly correct
-- behaviour teaches people to ignore reds.  It is a real finding, it is
-- written up with its numbers in docs/INVARIANTS.md, and it belongs to
-- whoever owns the card book as a RED_REGISTER argument.  Folding a new
-- finding into an old excuse is how a suppression gets written; so is
-- manufacturing a new red to look thorough.
--
-- ---------------------------------------------------------------------
-- WHAT IS SHIPPED, AND EXACTLY HOW STRONG IT IS
-- ---------------------------------------------------------------------
--
-- The guard below demands that a deposit outflow carry AN ANCHOR OF
-- SOME KIND, and it ranks them, because they are not equally good:
--
--   1 cited by an operational record   2,663   an FK from accrual,
--                                              interest, dispute,
--                                              payment instruction,
--                                              interchange, FX, recon,
--                                              outbound event, or a
--                                              reversal. UNFAKEABLE:
--                                              the row must exist in
--                                              another table.
--   2 provider webhook retained            8   `inbox_id` -> the
--                                              payload this book
--                                              actually received.
--   3 declared test fixture               49   a row in
--                                              `journal_deposit_outflow_fixture`,
--                                              written ONCE by this
--                                              migration. See below.
--   4 external reference only            364   `external_ref` is
--                                              non-null and nothing
--                                              else. THE WEAKEST ANCHOR
--                                              ON THIS LIST.
--   5 unexplained                          0   <- the guard
--
-- ARM 4 IS A LABEL AND IS LABELLED AS ONE.  `external_ref` is free text
-- the writer fills in.  A careless module that forgets it is reported; an
-- attacker who types anything at all into it is not.  It is accepted
-- because the provenance of 303 card settlements genuinely IS their
-- network reference and this book has nowhere else to put it -- but it
-- is counted separately, printed separately by GUARD REACH, and named
-- the weakest anchor everywhere it appears.  A guard whose honest
-- boundary is not written down is a guard that will be over-trusted, and
-- over-trust is what every instance in this catalogue is made of.
--
-- SO, PRECISELY: this guard catches a WRITER THAT FORGOT.  It does not
-- catch an ATTACKER WHO FILLED IN THE FIELD.  Both dodge I and dodge
-- I-prime are caught, because `ledger_append()` was called with
-- `p_external_ref => NULL` -- which is what a module posting money it
-- should not post actually looks like. The attacker-resistant version is
-- arm 1 alone, and arm 1 alone is the red that is not shipped.
--
-- ---------------------------------------------------------------------
-- THE FIXTURE TABLE, AND THE ONE PLACE IT DIVERGES FROM 0047
-- ---------------------------------------------------------------------
--
-- 49 entries carry NO anchor of any kind: no citation, no webhook, no
-- external reference. Every one is test seeding and says so in its own
-- description -- "Opening float for the hold fuzzer", "Opening float for
-- the card-hold integration suite", "Standing-order suite: top-up so the
-- funded leg has funds" -- under a `test:` key. $595,973.68 of customer
-- money, all of it seeded by suites that commit against the live book.
--
-- They are declared the way 0047 declared its value-date residue: an
-- append-only table naming the ENTRY, with a source a reader can open
-- and a reason a stranger can act on. The backfill runs ONCE, over the
-- rows that exist when this migration applies, so a future unanchored
-- outflow is NOT excused by it.
--
-- THE DIVERGENCE: 0047 grants `corgi_app` SELECT **and INSERT** on
-- `journal_value_date_residue`, so a suite that must commit an
-- out-of-band value date can mark what it commits in the same
-- transaction. That is a defensible trade for a guard about DATES.
--
-- IT WOULD BE FATAL HERE. This guard is about money leaving a customer's
-- account. If `corgi_app` could insert its own fixture row, the module
-- moving the money could excuse itself in the same transaction that
-- moved it, and the guard would be asking the writer's permission to
-- report the writer. So INSERT IS NOT GRANTED. A future exemption costs
-- a migration -- a reviewed act, which is 0047's own stated rule applied
-- more strictly than 0047 applied it.
--
-- ---------------------------------------------------------------------
-- GREEN ON ARRIVAL
-- ---------------------------------------------------------------------
--
--   v_deposit_outflow_unexplained   0 of 3,066 deposit-outflow entries
--
-- Green because every row was ACCOUNTED FOR, not because any row was
-- excluded: the census filters nothing, ranges over all 3,066, and
-- prints which of the five arms each landed in. `dbcheck --prove`
-- re-runs dodge I and dodge I-prime, and GUARD REACH prints the anchor
-- distribution so that "364 of these rest on a label" is on the screen
-- rather than in this comment.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The fixture declaration.  Append-only, and NOT writable by the app.
-- ---------------------------------------------------------------------

CREATE TABLE journal_deposit_outflow_fixture (
  entry_id  uuid PRIMARY KEY REFERENCES journal_entry(id),

  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid NOT NULL REFERENCES actor(id),

  -- WHAT WROTE IT. Free text on purpose, for 0041 §6's reason: a
  -- CHECK IN (...) goes stale the first time a suite is renamed, and the
  -- value of this column is that it names something findable.
  source    text NOT NULL CHECK (length(btrim(source)) > 0),

  -- WHY THIS OUTFLOW HAS NO ANCHOR, in a sentence a stranger can act on.
  -- NOT NULL because a marker with no argument is an assertion, and an
  -- assertion is what this table exists to replace.
  reason    text NOT NULL CHECK (length(btrim(reason)) > 0)
);

COMMENT ON TABLE journal_deposit_outflow_fixture IS
  'A journal entry moving customer deposit money against a house account which carries no operational citation, no provider webhook and no external reference, and which was already on the book when 0055 applied. Append-only, and deliberately NOT insertable by corgi_app: a guard about money leaving a customer account must not let the writer excuse itself in the transaction that moved the money.';
COMMENT ON COLUMN journal_deposit_outflow_fixture.source IS
  'What wrote it - a file path or suite name, so the next reader can open it.';
COMMENT ON COLUMN journal_deposit_outflow_fixture.reason IS
  'Why this outflow has no anchor. NOT NULL: a marker with no argument is just an assertion.';


-- ---------------------------------------------------------------------
-- 2.  The backfill.  ONCE, over the rows that exist today.
-- ---------------------------------------------------------------------
--
-- On a freshly reset database this matches nothing and inserts nothing,
-- which is correct: there is no fixture residue to declare.
--
-- The predicate is the census's own arm 5, spelled out here rather than
-- referenced, because the view does not exist yet and because a backfill
-- that reads the view it is about to make green is a circle.

INSERT INTO journal_deposit_outflow_fixture (entry_id, marked_by, source, reason)
WITH RECURSIVE walk AS (
  SELECT a.id, a.business_id FROM account a
   WHERE a.code = '2100' AND a.business_id IS NULL AND a.book = 'financial'
  UNION ALL
  SELECT c.id, c.business_id FROM account c JOIN walk w ON c.parent_id = w.id
),
tree AS (SELECT DISTINCT id, business_id FROM walk),
outflow AS (
  SELECT e.id AS entry_id
    FROM journal_entry e
    JOIN journal_line l ON l.entry_id = e.id
    JOIN account      a ON a.id = l.account_id
    LEFT JOIN tree    t ON t.id = l.account_id
   WHERE e.book = 'financial'
   GROUP BY e.id
  HAVING count(*) FILTER (WHERE t.id IS NOT NULL AND t.business_id IS NOT NULL) > 0
     AND count(*) FILTER (WHERE t.id IS NULL AND a.business_id IS NULL) > 0
)
SELECT e.id,
       act.id,
       'test suites that commit against the live book (idempotency key `test:%`)',
       'Seeded by an integration or fuzz suite that commits rather than rolling back - '
         || 'the description says so in every case: ' || e.description || '. '
         || 'Real, balanced, attributed postings; what they lack is an operational record, '
         || 'because no operation asked for them. Declared by 0055''s one-time backfill; '
         || 'a deposit outflow with no anchor booked after that migration is NOT covered '
         || 'by this row and is reported.'
  FROM outflow o
  JOIN journal_entry e ON e.id = o.entry_id
 CROSS JOIN LATERAL (
   SELECT id FROM actor
    WHERE kind = 'system' AND display_name = 'ledger-poster'
    LIMIT 1
 ) act
 WHERE e.inbox_id IS NULL
   AND e.external_ref IS NULL
   AND e.entry_type = 'original'
   AND NOT EXISTS (SELECT 1 FROM accrual_posting        x WHERE x.entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM interest_posting       x WHERE x.entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM dispute_event          x WHERE x.entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM dispute                x WHERE x.disputed_entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM payment_instruction_event x WHERE x.entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM interchange_posting    x WHERE x.entry_id = e.id
                                                           OR x.settlement_entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM fx_quote_settlement    x WHERE x.entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM recon_match            x WHERE x.entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM outbound_event         x WHERE x.source_entry_id = e.id)
   AND NOT EXISTS (SELECT 1 FROM journal_entry          r WHERE r.reverses_entry_id = e.id);


-- ---------------------------------------------------------------------
-- 3.  The census.  NOTHING IS FILTERED.
-- ---------------------------------------------------------------------
--
-- Every entry that moves customer deposit money against a house account,
-- with the strongest anchor it carries named. A CASE and not a WHERE,
-- for 0047 §3's reason: the count of what was judged is the only thing
-- that makes the guard's zero mean anything -- and here it is also the
-- only way the weakness of arm 4 stays visible.

CREATE VIEW v_deposit_outflow_entry AS
WITH RECURSIVE walk AS (
  -- Same root, same walk, as 0054's `v_deposit_entry_customers` and as
  -- `v_deposit_control_drift`. `account` is SELECT-only to corgi_app, so
  -- `parent_id` and `business_id` are outside the writer's reach.
  SELECT a.id, a.business_id FROM account a
   WHERE a.code = '2100' AND a.business_id IS NULL AND a.book = 'financial'
  UNION ALL
  SELECT c.id, c.business_id FROM account c JOIN walk w ON c.parent_id = w.id
),
-- DISTINCT because a customer's `2100` is reachable both as itself and
-- as a child of the house `2100`.
tree AS (SELECT DISTINCT id, business_id FROM walk),
shape AS (
  SELECT e.id                AS entry_id,
         e.booking_seq,
         e.booking_time,
         e.value_date,
         e.entry_type,
         e.rail,
         e.idempotency_key,
         e.description,
         e.external_ref,
         e.inbox_id,
         count(l.*)                                          AS line_count,
         count(*) FILTER (WHERE t.id IS NOT NULL
                            AND t.business_id IS NOT NULL)    AS customer_deposit_lines,
         -- Asked with its own FILTER rather than inferred from a
         -- DISTINCT, for 0052's reason and 0054's: house accounts carry
         -- `business_id IS NULL` and count(DISTINCT) skips nulls, so the
         -- house side of an outflow would otherwise be uncountable.
         count(*) FILTER (WHERE t.id IS NULL
                            AND a.business_id IS NULL)        AS house_lines_outside_deposits,
         count(DISTINCT t.business_id)                        AS customer_count,
         -- The customer money at risk in this entry, for the magnitude
         -- column GUARD REACH prints.
         COALESCE(sum(abs(l.amount_cents)) FILTER (
           WHERE t.id IS NOT NULL AND t.business_id IS NOT NULL), 0) AS customer_cents
    FROM journal_entry e
    JOIN journal_line  l ON l.entry_id = e.id
    JOIN account       a ON a.id = l.account_id
    LEFT JOIN tree     t ON t.id = l.account_id
   WHERE e.book = 'financial'
   GROUP BY e.id, e.booking_seq, e.booking_time, e.value_date, e.entry_type,
            e.rail, e.idempotency_key, e.description, e.external_ref, e.inbox_id
  -- THE POPULATION: this entry has a line inside a customer's deposit
  -- subtree AND a line on a house account outside it. Money crossing out
  -- of the customer book into ours. Both halves are facts about the
  -- chart; neither is a key, a rail or a description.
  HAVING count(*) FILTER (WHERE t.id IS NOT NULL AND t.business_id IS NOT NULL) > 0
     AND count(*) FILTER (WHERE t.id IS NULL AND a.business_id IS NULL) > 0
),
anchored AS (
  SELECT s.*,
         -- ARM 1. An operational record names this entry by FOREIGN KEY.
         -- Unfakeable in the way that matters: the row has to exist in
         -- another table, and the FK is checked by the database.
         (EXISTS (SELECT 1 FROM accrual_posting  x WHERE x.entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM interest_posting x WHERE x.entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM dispute_event    x WHERE x.entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM dispute          x WHERE x.disputed_entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM payment_instruction_event x WHERE x.entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM interchange_posting x WHERE x.entry_id = s.entry_id
                                                       OR x.settlement_entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM fx_quote_settlement x WHERE x.entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM recon_match      x WHERE x.entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM outbound_event   x WHERE x.source_entry_id = s.entry_id)
       OR EXISTS (SELECT 1 FROM journal_entry    r WHERE r.reverses_entry_id = s.entry_id)
       OR s.entry_type <> 'original')                        AS cited,
         EXISTS (SELECT 1 FROM journal_deposit_outflow_fixture f
                  WHERE f.entry_id = s.entry_id)             AS declared_fixture
    FROM shape s
)
SELECT a.*,
       CASE
         WHEN a.cited                    THEN 'cited by an operational record'
         WHEN a.inbox_id IS NOT NULL     THEN 'provider webhook retained'
         WHEN a.declared_fixture         THEN 'declared test fixture'
         WHEN a.external_ref IS NOT NULL THEN 'external reference only'
         ELSE 'unexplained'
       END AS anchor
  FROM anchored a;

COMMENT ON VIEW v_deposit_outflow_entry IS
  'Every journal entry moving customer deposit money against a house account outside the deposit subtree - the population is the parent chain from the deposit control account, a fact about the chart that corgi_app cannot write - with the strongest anchor each carries. Arms in descending strength: cited by an operational record (a foreign key, unfakeable), provider webhook retained, declared test fixture, external reference only (THE WEAKEST - free text the writer fills in), unexplained. See db/migrations/0055_deposit_outflow_provenance.sql.';


-- ---------------------------------------------------------------------
-- 4.  The guard.  MUST RETURN ZERO ROWS.  It is a TEST.
-- ---------------------------------------------------------------------
--
-- WHAT IT CAN SEE: every entry taking customer deposit money out to a
-- house account, on any rail, under any key, of any entry type. 3,066 on
-- this book.
--
-- WHAT MAKES IT FIRE: money leaving a customer's account with NOTHING
-- anywhere in this database saying anybody asked for it.
--
-- WHAT IT DOES NOT CATCH, stated plainly because a guard whose boundary
-- is not written down gets over-trusted:
--
--   * AN ATTACKER WHO FILLS IN `external_ref`. Arm 4 is a label. This
--     guard catches a writer that forgot, not one that lied. The
--     attacker-resistant form is arm 1 alone, which is red at 406 rows
--     and left for a RED_REGISTER argument -- docs/INVARIANTS.md.
--   * WHETHER THE INSTRUCTION WAS AUTHORISED. That is
--     `v_member_approval_without_right` and
--     `v_approved_auth_for_dead_member`. This view asks only whether an
--     instruction EXISTS, never whether the person who filed it could.
--   * MONEY MOVING WITHIN ONE CUSTOMER'S SUBTREE, which touches no house
--     account and is not in this population. `v_pot_line_provenance`
--     owns the pot case; `v_pot_identity_drift` owns the balance.
--   * MONEY MOVING BETWEEN TWO CUSTOMERS. That is 0054's
--     `v_deposit_cross_customer`, and the two populations overlap on
--     purpose (0043 §11.6): two guards agreeing is the only way to
--     notice when one of them stops ranging over something.

CREATE VIEW v_deposit_outflow_unexplained AS
SELECT entry_id, booking_seq, booking_time, value_date, entry_type, rail,
       idempotency_key, description, external_ref, line_count,
       customer_deposit_lines, house_lines_outside_deposits, customer_count,
       customer_cents, anchor
  FROM v_deposit_outflow_entry
 WHERE anchor = 'unexplained';

COMMENT ON VIEW v_deposit_outflow_unexplained IS
  'MUST BE EMPTY. Customer deposit money moved out to a house account with no operational record citing it, no provider webhook behind it, no external reference on it and no declared fixture row for it - nothing in this database saying anybody asked for it. Twelve balance and provenance guards are blind to this shape, measured at $500,000.00. NOTE THE BOUNDARY: the weakest accepted anchor is external_ref, which is free text, so this catches a writer that forgot and not an attacker that lied. See db/migrations/0055_deposit_outflow_provenance.sql and docs/INVARIANTS.md.';


-- ---------------------------------------------------------------------
-- 5.  Privileges
-- ---------------------------------------------------------------------
--
-- SELECT on the views, to `corgi_app`, as 0052 §3 and 0054 §5 granted
-- theirs. `scripts/dbcheck.mjs` and the chaos dashboard read as that
-- role and dbcheck treats an unreadable view as a FAIL, never a pass.
--
-- SELECT ONLY on the fixture table -- NO INSERT. This is the one place
-- 0055 is stricter than 0047 §6, and §"THE DIVERGENCE" above is why: a
-- guard about money leaving a customer account must not be insertable by
-- the role that moves the money, or the module can excuse itself in the
-- same transaction. A future exemption costs a migration.

GRANT SELECT ON v_deposit_outflow_entry, v_deposit_outflow_unexplained TO corgi_app;
GRANT SELECT ON journal_deposit_outflow_fixture TO corgi_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
    ON journal_deposit_outflow_fixture FROM corgi_app, PUBLIC;

-- Privileges do not bind the table OWNER (0001 §13). A declaration that
-- could be quietly withdrawn by whoever holds the owner connection is
-- worth nothing, and this one exists precisely to be un-withdrawable.
CREATE TRIGGER journal_deposit_outflow_fixture_no_update_delete
  BEFORE UPDATE OR DELETE ON journal_deposit_outflow_fixture
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();
CREATE TRIGGER journal_deposit_outflow_fixture_no_truncate
  BEFORE TRUNCATE ON journal_deposit_outflow_fixture
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 6.  The migration refuses to commit on a book it would break
-- ---------------------------------------------------------------------
--
-- 0043's closing shape, as 0052 §4 and 0054 §6 used it.
--
-- The extra assertion here is the one about ARM 4: if the number of
-- entries resting on `external_ref` alone is ever ZERO, the weakest arm
-- has become dead code and the guard is stronger than this header claims
-- -- which would be good news, and should still be noticed by a human
-- rather than drifting silently. It is a NOTICE, not an exception.

DO $$
DECLARE
  v_bad      int;
  v_pop      int;
  v_fixtures int;
  v_weak     int;
  v_cross    int;
  v_memo     int;
  v_control  int;
  r          record;
BEGIN
  SELECT count(*) INTO v_cross   FROM v_deposit_cross_customer;
  SELECT count(*) INTO v_memo    FROM v_memo_line_placement;
  SELECT count(*) INTO v_control FROM v_deposit_control_drift;

  IF v_cross <> 0 OR v_memo <> 0 OR v_control <> 0 THEN
    RAISE EXCEPTION
      '0055 refuses to commit: v_deposit_cross_customer=% v_memo_line_placement=% v_deposit_control_drift=% (all three must be 0 -- this migration must not disturb them)',
      v_cross, v_memo, v_control;
  END IF;

  SELECT count(*) INTO v_pop      FROM v_deposit_outflow_entry;
  SELECT count(*) INTO v_bad      FROM v_deposit_outflow_unexplained;
  SELECT count(*) INTO v_fixtures FROM journal_deposit_outflow_fixture;
  SELECT count(*) INTO v_weak     FROM v_deposit_outflow_entry
                                  WHERE anchor = 'external reference only';

  IF v_bad <> 0 THEN
    FOR r IN SELECT rail, count(*) AS n, sum(customer_cents) AS cents
               FROM v_deposit_outflow_unexplained
              GROUP BY rail ORDER BY n DESC LOOP
      RAISE WARNING '0055: v_deposit_outflow_unexplained: rail % -- % entry(s), % cents of customer money',
        r.rail, r.n, r.cents;
    END LOOP;
    RAISE EXCEPTION
      '0055 refuses to commit: v_deposit_outflow_unexplained = % of % deposit-outflow entries. A guard that arrives red is a finding or a wrong predicate; neither commits unread.',
      v_bad, v_pop;
  END IF;

  IF v_weak = 0 THEN
    RAISE NOTICE '0055: NOBODY rests on `external reference only` any more. The weakest arm is dead code and the guard is stronger than its header claims -- delete arm 4 and say so.';
  END IF;

  RAISE NOTICE '0055: v_deposit_outflow_unexplained = 0 of % deposit-outflow entries (% declared fixtures, % resting on external_ref alone -- the weakest anchor)',
    v_pop, v_fixtures, v_weak;
END $$;
