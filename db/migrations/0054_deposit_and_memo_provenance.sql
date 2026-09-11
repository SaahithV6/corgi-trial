-- =====================================================================
-- 0054  DEPOSIT AND MEMO PROVENANCE  -  generalising instance 27 past
--                                      the pot table
-- =====================================================================
--
-- 0052 closed the pot case and wrote down WHY it was closable:
--
--   "A balance guard catches a foreign write only when the amount
--    happens to break a balance.  Drain the pot first, or move LESS
--    than it holds, and the identical unauthorized write is invisible
--    -- because the balance views ask about the NUMBER, and none of
--    them asks WHO WROTE THE LINE."
--
-- That is instance 27 of this build's through-line defect.  The open
-- question 0052 left was how many of the other thirty invariants have
-- the same shape.  All thirty-one were read -- the SQL body, not the
-- one-line summary -- and classified in docs/INVARIANTS.md.  Fifteen
-- turn on a quantity.  Eleven of those fifteen are dodgeable: the
-- unauthorized write they exist to catch can be sized or placed so the
-- arithmetic they compare stays legal.  Each dodge was CONSTRUCTED
-- against this database in a transaction that was rolled back, not
-- reasoned about.  This migration closes the worst two.
--
-- ---------------------------------------------------------------------
-- DODGE A -- THE WORST ONE.  $250,000.00 BETWEEN TWO CUSTOMERS.
-- ---------------------------------------------------------------------
--
-- `v_deposit_control_drift` is the ONLY invariant ranging over the whole
-- customer deposit subtree, and it compares:
--
--   subtree   sum over the recursive walk from the house `2100`
--   reported  sum over v_ledger_balance for business_id IS NOT NULL
--             accounts with code '2100' or inside that same walk
--
-- The two sides count THE SAME ACCOUNTS.  Every customer `2100` is a
-- child of the house `2100`, so it is in the walk, and it carries a
-- business_id, so it is in the report.  Any write whose lines are both
-- inside the subtree moves both sides by the same number and the
-- difference stays zero -- FOR ANY AMOUNT.  The guard is not loosely
-- calibrated; it is structurally incapable of seeing a movement inside
-- the population it ranges over.
--
-- MEASURED, as corgi_app, through the ordinary `ledger_append()` path,
-- in a transaction that was rolled back: $250,000.00 was moved out of
-- business 7e57b115-...-0000000000f2's `2100` into business
-- f1e1fa7e-...-000000000007's `2100`, on the ach rail, under an `ach:`
-- key.  One customer's balance fell by a quarter of a million dollars
-- and another's rose by it, and:
--
--   v_deposit_control_drift    0 -> 0
--   v_book_not_zero            0 -> 0   (one entity, and it balances)
--   v_entry_unbalanced         0 -> 0   (two lines, netting to zero)
--   v_balance_definition_drift 0 -> 0   (ledger and available move together)
--   v_pot_identity_drift       0 -> 0   (no pot account touched)
--   v_pot_line_provenance      0 -> 0   (correctly: not a pot entry)
--   v_value_date_unexplained   0 -> 0   (value_date is today)
--
-- Nine balance guards, every one green, on the clearest theft this book
-- can express.  0052's sentence generalises exactly: they are asking
-- about the NUMBER.
--
-- ---------------------------------------------------------------------
-- DODGE D -- WITHHOLDING PARKED WHERE NO HOLD COUNTS IT
-- ---------------------------------------------------------------------
--
-- `v_hold_state.memo_balance_cents` is the fold the whole hold model
-- rests on, and its LATERAL reads:
--
--   WHERE e.hold_id = h.id AND l.account_id = h.memo_account_id
--
-- A memo line on any OTHER account is not in that sum.  So a memo entry
-- posted under a live hold's id, with its customer line on a DIFFERENT
-- business's memo account, changes no hold's balance at all.
--
-- MEASURED, same method: $85,000.00 was credited to Ridgeline
-- Robotics' `9100` card-authorisation memo account under Kettle &
-- Crumb's live uncleared-credit hold 47b2aa2d-....  v_hold_drift,
-- v_hold_release_drift, v_balance_definition_drift, v_book_not_zero,
-- v_entry_unbalanced, v_refused_auth_hold, v_hold_expiry_drift and
-- v_wire_availability_drift ALL stayed exactly where they were.  The
-- memo book now carried $85,000.00 of withholding that no hold claimed
-- and no guard could name.
--
-- (The nearby dodge that is NOT closed here, stated so it is not
-- mistaken for covered: two memo entries on a RELEASED hold's OWN memo
-- account, +$100,000.00 then -$100,000.00.  Both are correctly placed,
-- both net to zero, and `v_hold_release_drift` only fires on
-- `memo_balance_cents <> 0`.  The obvious repair -- "no memo posting
-- after closure" -- is NOT TRUE of this book: 271 memo entries are
-- booked after their hold's closure and they are ordinary settlement
-- traffic.  A guard asserting it would arrive red with 271 rows of
-- correct behaviour, which is how a suppression gets written.  It is
-- left open and ranked in docs/INVARIANTS.md rather than half-closed.)
--
-- ---------------------------------------------------------------------
-- WHY NEITHER OF THESE IS A KEY-PREFIX WHITELIST
-- ---------------------------------------------------------------------
--
-- The tempting deposit guard is "every entry touching a customer's
-- `2100` carries a key from the declared writer list".  That was
-- measured before it was rejected: 3,043 entries touch a customer
-- deposit account under TWENTY-FOUR distinct (key prefix, rail)
-- combinations -- planted, card, reversal, livefire, ach, plaid, stmt,
-- payment, test, accrual, dispute, interest, pot, increase.wire, usdc,
-- statements.  A whitelist over that is `v_internal_transfer_impure`'s
-- defect at 150x the scale: the writer opts into the population by
-- choosing a prefix, so the one writer that does not claim to be a
-- deposit operation is the one writer the guard cannot see.  0052's
-- rule is the whole point -- the population must be A FACT ABOUT THE
-- CHART, not a label.
--
-- The facts used here, and the reason each cannot be argued with by the
-- code that writes the entry (verified against this database, as
-- corgi_app, via information_schema.role_table_grants):
--
--   account   SELECT only.  `parent_id` and `business_id` are not
--             writable by the application at all, so the subtree walk
--             and the customer attribution are outside the writer's
--             reach.
--   hold      INSERT, SELECT -- append-only.  `hold.memo_account_id` is
--             fixed at the moment the hold is created and can never be
--             repointed afterwards.
--   journal_entry / journal_line
--             INSERT, SELECT.  No UPDATE, no DELETE, no TRUNCATE.
--
--   je_memo_has_hold
--             CHECK (book = 'financial' OR hold_id IS NOT NULL).  This
--             is what makes the memo population total: EVERY memo entry
--             names a hold, enforced by the database, so there is no
--             `hold_id IS NULL` escape hatch.  It was found by trying
--             it -- the first form of dodge D posted a memo entry with
--             hold_id NULL and the database refused it.  Layer 1 was
--             already there; this view is the second line.
--
-- ---------------------------------------------------------------------
-- THE NULL-SWALLOW, ASKED FOR SEPARATELY IN BOTH VIEWS
-- ---------------------------------------------------------------------
--
-- 0052's second design choice, and it earned its keep again here.
-- `count(DISTINCT a.business_id)` SKIPS NULLS, and every house account
-- carries `business_id IS NULL`.  So a movement from a customer into a
-- house account leaves the distinct count at 1 and reads as one
-- customer.
--
-- That is not hypothetical either.  DODGE G, measured: $12,000.00 moved
-- out of Ridgeline's "Payroll -- October" pot into the HOUSE `2100`
-- control account, on the internal rail, under a well-formed
-- `pot:a94a4e92-...:` key naming the pot it actually touched.  Two
-- lines, one currency, netting to zero, every line inside the deposit
-- subtree.  `v_internal_transfer_impure` checks line count, currency,
-- deposit membership and `count(DISTINCT business_id) <> 1` -- and
-- stayed at 0, because the house side counted as no customer at all.
-- 0052's `house_lines` column is what reported it.
--
-- Both views below therefore count the house side with its own
-- `FILTER (WHERE business_id IS NULL)` rather than trusting a DISTINCT.
--
-- ---------------------------------------------------------------------
-- GREEN ON ARRIVAL, AND WHAT MAKES THE ZERO CHECKABLE
-- ---------------------------------------------------------------------
--
--   v_deposit_cross_customer   0 of 3,043 entries touching a customer
--                              deposit account
--   v_memo_line_placement      0 of 1,433 memo entries / 2,866 memo
--                              lines -- and 2,866 of 2,866 is the whole
--                              memo book, so the reach is total
--
-- GUARD REACH in `scripts/dbcheck.mjs` prints both populations, and
-- `dbcheck --prove` re-runs dodge A and dodge D so each view is seen
-- FIRING before it is believed.  The guards those dodges walked past
-- are still blind to them; these two report them.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The deposit census.  NOTHING IS FILTERED.
-- ---------------------------------------------------------------------
--
-- Every entry with a line inside the deposit control subtree, judged.
-- A CASE and not a WHERE, for 0047 §3's reason: the count of what was
-- judged is the only thing that makes the guard's zero mean anything.

CREATE VIEW v_deposit_entry_customers AS
WITH RECURSIVE walk AS (
  -- The deposit control account, and everything beneath it. This is the
  -- SAME root `v_deposit_control_drift` walks from -- deliberately, so
  -- that the two views range over one population and differ only in the
  -- question they ask of it.
  SELECT a.id, a.business_id
    FROM account a
   WHERE a.code = '2100' AND a.business_id IS NULL AND a.book = 'financial'
  UNION ALL
  SELECT c.id, c.business_id
    FROM account c
    JOIN walk w ON c.parent_id = w.id
),
-- DISTINCT because a customer's `2100` is reachable both as itself and
-- as a child of the house `2100`; without it every deposit line would be
-- counted twice and `line_count <> 2` would fire on the entire book.
tree AS (SELECT DISTINCT id, business_id FROM walk),
shape AS (
  SELECT e.id                AS entry_id,
         e.booking_seq,
         e.booking_time,
         e.value_date,
         e.book,
         e.entry_type,
         e.rail,
         e.idempotency_key,
         e.description,
         count(l.*)                                          AS line_count,
         SUM(l.amount_cents)                                 AS net_cents,
         count(DISTINCT l.currency)                          AS currency_count,
         -- Lines on a CUSTOMER's deposit account -- the thing being
         -- protected.
         count(*) FILTER (WHERE t.id IS NOT NULL
                            AND t.business_id IS NOT NULL)    AS customer_deposit_lines,
         -- Asked separately from customer_count for 0052's reason: the
         -- house `2100` carries business_id IS NULL and count(DISTINCT)
         -- would skip it, so a posting straight onto the control account
         -- would read as one customer.
         count(*) FILTER (WHERE t.id IS NOT NULL
                            AND t.business_id IS NULL)        AS house_deposit_lines,
         count(DISTINCT t.business_id)                        AS customer_count,
         count(*) FILTER (WHERE t.id IS NULL)                 AS lines_outside_the_subtree
    FROM journal_entry e
    JOIN journal_line  l ON l.entry_id = e.id
    LEFT JOIN tree     t ON t.id = l.account_id
   GROUP BY e.id, e.booking_seq, e.booking_time, e.value_date, e.book,
            e.entry_type, e.rail, e.idempotency_key, e.description
  -- The population, and the only fact it rests on: this entry has at
  -- least one line on an account that the parent chain places inside a
  -- customer's deposit subtree. `account` is SELECT-only to corgi_app,
  -- so no writer can move an entry out of this count by choosing a
  -- different key, rail, book, entry type or description.
  HAVING count(*) FILTER (WHERE t.id IS NOT NULL
                            AND t.business_id IS NOT NULL) > 0
)
SELECT s.*,
       CASE
         WHEN s.customer_count > 1
           THEN 'moves money between ' || s.customer_count::text || ' customers'
         WHEN s.house_deposit_lines > 0
           THEN 'posts directly onto the house 2100 control account'
         ELSE 'one customer'
       END AS reach
  FROM shape s;

COMMENT ON VIEW v_deposit_entry_customers IS
  'Every journal entry with a line inside a customer''s deposit subtree - the population is the parent chain from the deposit control account, a fact about the chart that corgi_app cannot write - with how far each entry reaches. The conforming arm is reach = ''one customer''. See db/migrations/0054_deposit_and_memo_provenance.sql.';


-- ---------------------------------------------------------------------
-- 2.  The deposit guard.  MUST RETURN ZERO ROWS.  It is a TEST.
-- ---------------------------------------------------------------------
--
-- WHAT IT CAN SEE: every journal entry touching any customer's deposit
-- subtree, on any rail, in any book, under any key, of any entry type.
-- 3,043 on this book.
--
-- WHAT MAKES IT FIRE: an entry that moves one customer's deposit money
-- into another customer's, or posts straight onto the house control
-- account.  Neither has a legitimate writer on this book: money between
-- customers goes out through a house rail account and back in, in two
-- entries, and the control account is a parent, never a posting target.
--
-- WHAT IT DOES NOT EXAMINE, named rather than left implied:
--
--   * A customer's money moved out to a HOUSE account that is not the
--     `2100` control -- `1000 Cash at bank`, say.  That is a one-customer
--     entry and this guard passes it.  It is the shape 0052's
--     `v_pot_line_provenance` reports for pot accounts, and NOTHING
--     reports it for a plain `2100`.  Ranked #3 and open; see
--     docs/INVARIANTS.md.
--   * Whether the amount was authorised, sufficient, or a good idea.
--     `ledger_availability()` and the approval guards own that.  This
--     view asks only how far the entry reaches.

CREATE VIEW v_deposit_cross_customer AS
SELECT entry_id, booking_seq, booking_time, value_date, book, entry_type,
       rail, idempotency_key, description, line_count, net_cents,
       currency_count, customer_deposit_lines, house_deposit_lines,
       customer_count, lines_outside_the_subtree, reach
  FROM v_deposit_entry_customers
 WHERE reach <> 'one customer';

COMMENT ON VIEW v_deposit_cross_customer IS
  'MUST BE EMPTY. A single journal entry that moves money between two customers'' deposit subtrees, or posts directly onto the house 2100 control account. v_deposit_control_drift cannot see either: both of its sides count the same subtree, so a movement INSIDE it is invisible for any amount - measured at $250,000.00. See db/migrations/0054_deposit_and_memo_provenance.sql and scripts/dbcheck.mjs.';


-- ---------------------------------------------------------------------
-- 3.  The memo census.  NOTHING IS FILTERED.
-- ---------------------------------------------------------------------
--
-- Every memo entry, with its placement spelled out.  The population is
-- total and provably so: `je_memo_has_hold` guarantees hold_id IS NOT
-- NULL on every memo entry, and `hold.id` is the primary key, so the
-- join below drops nothing.  2,866 of 2,866 memo lines.

CREATE VIEW v_memo_line_placed AS
WITH shape AS (
  SELECT e.id                AS entry_id,
         e.booking_seq,
         e.booking_time,
         e.value_date,
         e.rail,
         e.idempotency_key,
         e.description,
         h.id                AS hold_id,
         h.kind              AS hold_kind,
         count(l.*)                                          AS line_count,
         SUM(l.amount_cents)                                 AS net_cents,
         count(DISTINCT l.currency)                          AS currency_count,
         -- The hold's OWN memo account. `hold` is append-only to
         -- corgi_app (INSERT, SELECT), so `memo_account_id` is fixed at
         -- creation and cannot be repointed at whatever the writer
         -- happened to post to.
         count(*) FILTER (WHERE l.account_id = h.memo_account_id)
                                                              AS lines_on_the_holds_memo_account,
         -- The contra side. Counted with its own FILTER and not inferred
         -- from a DISTINCT, for the same null-swallow reason as above:
         -- house memo accounts carry business_id IS NULL.
         count(*) FILTER (WHERE a.business_id IS NULL)        AS house_memo_lines,
         -- THE DODGE. A customer memo line that is not the one this
         -- hold names: withholding parked where the fold does not count
         -- it.
         count(*) FILTER (WHERE a.business_id IS NOT NULL
                            AND l.account_id <> h.memo_account_id)
                                                              AS customer_lines_elsewhere,
         count(*) FILTER (WHERE a.book <> 'memo')             AS lines_outside_the_memo_book
    FROM journal_entry e
    JOIN journal_line  l ON l.entry_id = e.id
    JOIN account       a ON a.id = l.account_id
    JOIN hold          h ON h.id = e.hold_id
   WHERE e.book = 'memo'
   GROUP BY e.id, e.booking_seq, e.booking_time, e.value_date, e.rail,
            e.idempotency_key, e.description, h.id, h.kind
)
SELECT s.*,
       CASE
         WHEN s.line_count <> 2
           THEN 'not a two-line memo posting'
         WHEN s.currency_count <> 1
           THEN 'more than one currency'
         WHEN s.net_cents <> 0
           THEN 'does not net to zero'
         WHEN s.lines_outside_the_memo_book > 0
           THEN 'a line on an account outside the memo book'
         WHEN s.customer_lines_elsewhere > 0
           THEN 'withholding parked on a memo account this hold does not name'
         WHEN s.lines_on_the_holds_memo_account <> 1
           THEN 'no line on the memo account the hold names'
         WHEN s.house_memo_lines <> 1
           THEN 'the contra side is not a single house memo line'
         ELSE 'hold memo posting'
       END AS placement
  FROM shape s;

COMMENT ON VIEW v_memo_line_placed IS
  'Every entry in the memo book, with its placement judged against the hold it names. The population is total because je_memo_has_hold CHECKs that a memo entry has a hold_id. The conforming arm is placement = ''hold memo posting''. See db/migrations/0054_deposit_and_memo_provenance.sql.';


-- ---------------------------------------------------------------------
-- 4.  The memo guard.  MUST RETURN ZERO ROWS.  It is a TEST.
-- ---------------------------------------------------------------------
--
-- WHAT IT CAN SEE: every line in the memo book, all 2,866 of them.
--
-- WHAT MAKES IT FIRE: memo withholding written anywhere the hold model
-- does not read.  `v_hold_state` sums only lines where `l.account_id =
-- h.memo_account_id`, so every other placement is money in the memo
-- book that no hold's balance contains -- and therefore money that
-- `v_hold_drift` and `v_hold_release_drift` cannot compare, because
-- neither side of their comparison includes it.
--
-- WHAT IT DOES NOT EXAMINE, named rather than left implied:
--
--   * WHETHER the withholding should exist. `v_refused_auth_hold` asks
--     whether the provider approved it -- and only when the hold is
--     still withholding money; see the reach line in dbcheck.
--   * Memo entries on a hold that is already closed. 271 of those are
--     ordinary settlement traffic on this book. Open, ranked #4.
--   * The AMOUNT. Two memo entries that net to zero on the correct
--     account are conforming here and invisible to the balance guards
--     as well. That is dodge C, open, ranked #4.

CREATE VIEW v_memo_line_placement AS
SELECT entry_id, booking_seq, booking_time, value_date, rail,
       idempotency_key, description, hold_id, hold_kind, line_count,
       net_cents, currency_count, lines_on_the_holds_memo_account,
       house_memo_lines, customer_lines_elsewhere,
       lines_outside_the_memo_book, placement
  FROM v_memo_line_placed
 WHERE placement <> 'hold memo posting';

COMMENT ON VIEW v_memo_line_placement IS
  'MUST BE EMPTY. A memo posting whose lines are not where the hold it names says they are - most importantly, withholding on a memo account belonging to a different customer. v_hold_state sums only l.account_id = h.memo_account_id, so such a line changes no hold balance and no drift view can see it - measured at $85,000.00. See db/migrations/0054_deposit_and_memo_provenance.sql and scripts/dbcheck.mjs.';


-- ---------------------------------------------------------------------
-- 5.  Privileges
-- ---------------------------------------------------------------------
--
-- SELECT only, to `corgi_app`, exactly as 0052 §3 granted the pot
-- provenance views. `scripts/dbcheck.mjs` and the chaos dashboard both
-- read as that role, and dbcheck treats an unreadable view as a FAIL,
-- never a pass.

GRANT SELECT ON v_deposit_entry_customers, v_deposit_cross_customer,
                v_memo_line_placed, v_memo_line_placement TO corgi_app;


-- ---------------------------------------------------------------------
-- 6.  The migration refuses to commit on a book it would break
-- ---------------------------------------------------------------------
--
-- 0043's closing shape, as 0052 used it. Both views are asserted GREEN
-- on arrival, which is a claim about this database and therefore gets
-- checked here rather than asserted in a comment.
--
-- The guards these two are companions to are asserted UNDISTURBED for
-- the same reason: this migration creates views and touches no data, so
-- any movement in them means something else is wrong and this is where
-- it gets noticed. `v_refused_auth_hold` is deliberately NOT in that
-- list -- it is one of the four known reds and stays red.

DO $$
DECLARE
  v_cross      int;
  v_dep_pop    int;
  v_memo       int;
  v_memo_pop   int;
  v_memo_lines int;
  v_all_memo   int;
  v_control    int;
  v_drift      int;
  v_release    int;
  v_impure     int;
  v_potprov    int;
  r            record;
BEGIN
  SELECT count(*) INTO v_control FROM v_deposit_control_drift;
  SELECT count(*) INTO v_drift   FROM v_hold_drift;
  SELECT count(*) INTO v_release FROM v_hold_release_drift;
  SELECT count(*) INTO v_impure  FROM v_internal_transfer_impure;
  SELECT count(*) INTO v_potprov FROM v_pot_line_provenance;

  IF v_control <> 0 OR v_drift <> 0 OR v_release <> 0
     OR v_impure <> 0 OR v_potprov <> 0 THEN
    RAISE EXCEPTION
      '0054 refuses to commit: v_deposit_control_drift=% v_hold_drift=% v_hold_release_drift=% v_internal_transfer_impure=% v_pot_line_provenance=% (all five must be 0 -- this migration must not disturb them)',
      v_control, v_drift, v_release, v_impure, v_potprov;
  END IF;

  SELECT count(*) INTO v_dep_pop FROM v_deposit_entry_customers;
  SELECT count(*) INTO v_cross   FROM v_deposit_cross_customer;

  IF v_cross <> 0 THEN
    FOR r IN SELECT reach, count(*) AS n FROM v_deposit_cross_customer
              GROUP BY reach ORDER BY n DESC LOOP
      RAISE WARNING '0054: v_deposit_cross_customer: % -- % entry(s)', r.reach, r.n;
    END LOOP;
    RAISE EXCEPTION
      '0054 refuses to commit: v_deposit_cross_customer = % of % entries touching a customer deposit account. A guard that arrives red is a finding or a wrong predicate; neither commits unread.',
      v_cross, v_dep_pop;
  END IF;

  SELECT count(*) INTO v_memo_pop FROM v_memo_line_placed;
  SELECT count(*) INTO v_memo     FROM v_memo_line_placement;

  IF v_memo <> 0 THEN
    FOR r IN SELECT placement, count(*) AS n FROM v_memo_line_placement
              GROUP BY placement ORDER BY n DESC LOOP
      RAISE WARNING '0054: v_memo_line_placement: % -- % entry(s)', r.placement, r.n;
    END LOOP;
    RAISE EXCEPTION
      '0054 refuses to commit: v_memo_line_placement = % of % memo entries. A guard that arrives red is a finding or a wrong predicate; neither commits unread.',
      v_memo, v_memo_pop;
  END IF;

  -- REACH COMPLETENESS, checked here and not only printed by dbcheck.
  -- The memo guard's whole claim to totality is that `je_memo_has_hold`
  -- leaves no memo entry without a hold, so the join below drops
  -- nothing. If that ever stops being true the guard silently narrows,
  -- which is instance 27 arriving inside the repair for instance 27.
  SELECT count(*) INTO v_memo_lines
    FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
    JOIN hold h ON h.id = e.hold_id
   WHERE e.book = 'memo';
  SELECT count(*) INTO v_all_memo
    FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
   WHERE e.book = 'memo';

  IF v_memo_lines <> v_all_memo THEN
    RAISE EXCEPTION
      '0054 refuses to commit: v_memo_line_placed reaches % of % memo lines. A guard whose population is not total is the defect this migration exists to close.',
      v_memo_lines, v_all_memo;
  END IF;

  RAISE NOTICE '0054: v_deposit_cross_customer = 0 of % entries touching a customer deposit account', v_dep_pop;
  RAISE NOTICE '0054: v_memo_line_placement = 0 of % memo entries (% of % memo lines -- the reach is total)',
    v_memo_pop, v_memo_lines, v_all_memo;
END $$;
