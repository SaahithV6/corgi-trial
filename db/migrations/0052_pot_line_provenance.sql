-- =====================================================================
-- 0052  POT LINE PROVENANCE  -  the structural pot guard, which 0015's
--                               four are not
-- =====================================================================
--
-- Named, priced and left unbuilt by docs/POTS.md §10.3 ("The repair,
-- named rather than half-built"), and named again in the header of
-- `scripts/dbcheck.mjs`'s pot block.  This is that view.
--
-- ---------------------------------------------------------------------
-- WHAT THE FOUR EXISTING POT INVARIANTS ACTUALLY ASK
-- ---------------------------------------------------------------------
--
-- 0015 shipped four, and every one of them compares a BALANCE or a
-- SHAPE that the writer itself selected into:
--
--   v_pot_identity_drift        main + Sigma pots = the recursive walk of
--                               the customer's deposit subtree.  Two
--                               derivations of one NUMBER.
--   v_pot_negative              balance_cents < 0.  A NUMBER.
--   v_pot_orphan                the pot's account is a liability leaf
--                               under that business's own 2100.  A fact
--                               about the CHART, not about any entry.
--   v_internal_transfer_impure  two lines, one customer, inside the
--                               deposit subtree -- over the population
--                               `rail = 'internal' AND idempotency_key
--                               LIKE 'pot:%'`.
--
-- The fourth is the one that looks structural and is not.  Its
-- population is THE WRITER'S OWN LABEL.  `movePotFunds()` is the only
-- module that writes pot moves today and it always sets that key, so
-- the guard is true of everything on this book -- but `postEntry()`
-- takes an account id and asks no questions, correctly, so any other
-- module posting to a pot account is invisible to it.
--
-- MEASURED, in docs/POTS.md §10.3, in a transaction that was rolled
-- back: $50.00 was posted out of Ridgeline's "Sales tax" pot into
-- `1000 Cash at bank` -- a real asset account, a real rail -- under an
-- `ach:` key with `rail = 'ach'`.  The pot balance fell $3,250.00 to
-- $3,200.00 and `v_internal_transfer_impure`, `v_pot_identity_drift`
-- AND `v_deposit_control_drift` all stayed at 0.
--
--   * impure did not see it because the entry carried no `pot:` key,
--     so it was never in the population.
--   * identity drift did not see it because the money genuinely left
--     the subtree, so main + pots and the subtree walk fell by the same
--     $50.00 and stayed equal.
--   * control drift could not see it either: both of ITS sides count
--     the same subtree, so money LEAVING the subtree keeps them equal.
--
-- A pot line written by the wrong writer for the right amount passes
-- all four.  That is the gap, and it is a gap in KIND rather than in
-- degree: no amount of balance comparison can answer "which code wrote
-- this line".
--
-- ---------------------------------------------------------------------
-- THE POPULATION IS A FACT ABOUT THE CHART
-- ---------------------------------------------------------------------
--
--     journal_line.account_id IN (SELECT account_id FROM pot)
--
-- That is the whole difference.  `pot.account_id` is UNIQUE and NOT
-- NULL and its row is append-only (0015 §1), so membership of this
-- population cannot be argued with by the code that writes the entry.
-- A writer cannot opt out of this guard by choosing a different
-- idempotency key, a different rail, a different description or a
-- different entry type -- the only way out is to not touch a pot
-- account, and a module that does not touch a pot account is not the
-- hazard.
--
-- The two populations are DIFFERENT and they OVERLAP ON PURPOSE, which
-- is the arrangement `v_hold_closure_unexplained` (0043 §11.6) argues
-- for at length: a conforming pot move is judged by both guards, and
-- two guards agreeing is the only way to notice when one of them stops
-- ranging over something.
--
--   in impure, not here    an entry keyed `pot:` that touches no pot
--                          account at all.  0 on this book today.
--   here, not in impure    an entry that touches a pot account under
--                          any other key or rail.  THIS IS THE BUG.
--
-- ---------------------------------------------------------------------
-- WHAT "TRACEABLE TO A POT OPERATION" IS SPELLED OUT AS
-- ---------------------------------------------------------------------
--
-- Six conditions, each of which `movePotFunds()` satisfies by
-- construction and none of which is satisfied by accident:
--
--   1. rail = 'internal' and book = 'financial'.  A pot move touches no
--      rail and is real money, not a memo hold (0015 §4).
--   2. idempotency_key LIKE 'pot:%'.  The writer's declaration.  It is
--      NOT sufficient on its own -- that is what made 0015's fourth
--      view narrow -- but it is still necessary, because an entry that
--      moves pot money without claiming to is the shape being caught.
--   3. The key NAMES A POT THIS ENTRY ACTUALLY TOUCHES.  The key's form
--      is `pot:<pot uuid>:<in|out>:<client key>`, so the claim is
--      checkable against the lines rather than merely present.  This is
--      the condition no existing view comes near: it holds the writer's
--      own label to the chart, so a line stamped with one pot's key and
--      posted to another pot's account is reported.  All 20 entries on
--      this book satisfy it.
--   4. Exactly two lines, netting to zero, in one currency.  The
--      DEFERRABLE balanced-entry trigger (0001) already proves the net;
--      what is added is "and it was a MOVE", not a three-legged entry
--      that happens to balance.
--   5. Every line inside a customer's deposit subtree -- `code = '2100'`
--      or `code LIKE '2100.%'`.  This is the $50.00-to-1000 case.
--   6. Exactly one business, and no house line.  `count(DISTINCT
--      business_id)` alone would not catch a house account, because
--      house accounts carry `business_id IS NULL` and DISTINCT ignores
--      nulls -- so the null count is asked for separately.  One
--      customer's earmark cannot reach another customer's money, or
--      ours.
--
-- WHAT IS DELIBERATELY *NOT* HERE.  No exemption list, no `entry_type`
-- carve-out, no "unless it is a reversal".  This product has no pot
-- reversal path -- there is no `pot_closure` (0015's cut list) and
-- `movePotFunds()` is the only writer -- so an exemption for one would
-- be an allowance written for a caller that does not exist, which is
-- how 0026 shipped a guard that excluded its own bug.  If a reversal
-- path is ever built it keys `pot:` like every other pot operation, or
-- it adds its shape HERE, in a migration.  0047's rule: an exemption
-- should cost a reviewed act, not an INSERT.
--
-- ---------------------------------------------------------------------
-- GREEN ON ARRIVAL, AND WHAT THAT IS WORTH
-- ---------------------------------------------------------------------
--
-- 20 entries touch a pot account on this book and all 20 conform, so
-- the guard reads 0.  That is a real tick rather than an empty one:
-- GUARD REACH in `scripts/dbcheck.mjs` prints the 20, and
-- `dbcheck --prove` makes the view fire by re-running §10.3's measured
-- probe -- $50.00 out of a pot into `1000 Cash at bank` under an `ach:`
-- key -- in a transaction that is rolled back.  The three pot guards
-- that were blind to that probe are still blind to it; this one reports
-- it.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The census.  NOTHING IS FILTERED.
-- ---------------------------------------------------------------------
--
-- Every entry with a line on a pot account, with the judgement spelled
-- out per row.  A LEFT JOIN and a CASE rather than a WHERE, for 0047
-- §3's reason: a filter that hides the conforming majority is one edit
-- away from hiding a real failure, and the count of what was judged is
-- the only thing that makes the guard's zero mean anything.
--
-- `provenance = 'pot operation'` is the conforming arm.  Every other
-- value names the FIRST condition the entry failed, ordered so the
-- coarsest question is asked first -- an entry on the wrong rail is
-- reported as being on the wrong rail rather than as having the wrong
-- line count.

CREATE VIEW v_pot_line_entry AS
WITH touched AS (
  -- The population, and the only fact it rests on: this entry has a
  -- line on an account that the `pot` table names.  `pot.account_id` is
  -- UNIQUE, NOT NULL and append-only, so no writer can argue with it.
  SELECT DISTINCT l.entry_id
    FROM journal_line l
   WHERE l.account_id IN (SELECT account_id FROM pot)
),
shape AS (
  SELECT e.id                 AS entry_id,
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
         -- Every line NOT in a customer's deposit subtree.  The $50.00
         -- probe's second line -- `1000 Cash at bank` -- is exactly one
         -- of these.
         count(*) FILTER (WHERE a.code <> '2100'
                            AND a.code NOT LIKE '2100.%')     AS lines_outside_deposits,
         -- Asked separately from business_count on purpose: a house
         -- account carries `business_id IS NULL` and count(DISTINCT)
         -- skips nulls, so a pot move into a house account would leave
         -- business_count at 1 and look like one customer.
         count(*) FILTER (WHERE a.business_id IS NULL)        AS house_lines,
         count(DISTINCT a.business_id)                        AS business_count,
         count(*) FILTER (WHERE p.id IS NOT NULL)             AS pot_lines,
         count(DISTINCT p.id)                                 AS pot_count,
         -- The writer's own label, held to the chart.  True only if the
         -- pot uuid in the key belongs to a pot this entry actually
         -- posts to.  `bool_or` over the lines, so a two-pot move
         -- (pot to pot) is satisfied by naming either end.
         COALESCE(bool_or(e.idempotency_key
                          LIKE 'pot:' || p.id::text || ':%'), false)
                                                              AS key_names_a_touched_pot
    FROM journal_entry e
    JOIN touched       t ON t.entry_id = e.id
    JOIN journal_line  l ON l.entry_id = e.id
    JOIN account       a ON a.id = l.account_id
    LEFT JOIN pot      p ON p.account_id = l.account_id
   GROUP BY e.id, e.booking_seq, e.booking_time, e.value_date, e.book,
            e.entry_type, e.rail, e.idempotency_key, e.description
)
SELECT s.*,
       CASE
         WHEN s.rail <> 'internal'
           THEN 'posted on the ' || s.rail::text || ' rail, not internal'
         WHEN s.book <> 'financial'
           THEN 'posted in the ' || s.book::text || ' book, not financial'
         WHEN s.idempotency_key NOT LIKE 'pot:%'
           THEN 'no pot: key — the writer never claimed this was a pot operation'
         WHEN NOT s.key_names_a_touched_pot
           THEN 'the pot: key names a pot this entry does not touch'
         WHEN s.line_count <> 2
           THEN 'not a two-line move'
         WHEN s.currency_count <> 1
           THEN 'more than one currency'
         WHEN s.net_cents <> 0
           THEN 'does not net to zero'
         WHEN s.lines_outside_deposits > 0
           THEN 'reaches outside the deposit subtree'
         WHEN s.house_lines > 0
           THEN 'touches a house account'
         WHEN s.business_count <> 1
           THEN 'spans more than one customer'
         ELSE 'pot operation'
       END AS provenance
  FROM shape s;

COMMENT ON VIEW v_pot_line_entry IS
  'Every journal entry with a line on a pot account - the population is a fact about the chart, not the writer''s label - with the provenance of each spelled out. The conforming arm is provenance = ''pot operation''; every other value names the first condition the entry failed. See db/migrations/0052_pot_line_provenance.sql and docs/POTS.md 10.3.';


-- ---------------------------------------------------------------------
-- 2.  The guard.  MUST RETURN ZERO ROWS.  It is a TEST.
-- ---------------------------------------------------------------------
--
-- What it CAN see: every journal entry that touches a pot account, on
-- any rail, in any book, under any key, of any entry type.
--
-- What makes it fire: money moved into or out of a pot by anything that
-- is not a pot operation.  That includes the exact $50.00 probe 0015's
-- four all missed, and it includes any future module that calls
-- `postEntry()` with a pot account id in a line.

CREATE VIEW v_pot_line_provenance AS
SELECT entry_id, booking_seq, booking_time, value_date, book, entry_type,
       rail, idempotency_key, description, line_count, net_cents,
       currency_count, lines_outside_deposits, house_lines, business_count,
       pot_lines, pot_count, provenance
  FROM v_pot_line_entry
 WHERE provenance <> 'pot operation';

COMMENT ON VIEW v_pot_line_provenance IS
  'MUST BE EMPTY. A journal entry touching a pot account that is not traceable to a pot operation: wrong rail, wrong book, no pot: key, a key naming a pot it does not touch, not a two-line same-currency move netting to zero, or reaching outside one customer''s deposit subtree. The four pot invariants from 0015 compare balances and shapes the writer selected into; this one keys on the chart. See db/migrations/0052_pot_line_provenance.sql and scripts/dbcheck.mjs.';


-- ---------------------------------------------------------------------
-- 3.  Privileges
-- ---------------------------------------------------------------------
--
-- SELECT only, to `corgi_app`, exactly as 0015 §7 granted the other pot
-- views.  `scripts/dbcheck.mjs` and the chaos dashboard both read as
-- that role, and a guard the gate cannot read is a guard that fails
-- (dbcheck treats an unreadable view as a FAIL, never a pass).

GRANT SELECT ON v_pot_line_entry, v_pot_line_provenance TO corgi_app;


-- ---------------------------------------------------------------------
-- 4.  The migration refuses to commit on a book it would break
-- ---------------------------------------------------------------------
--
-- 0043's closing shape.  This view is asserted GREEN on arrival, which
-- is a claim about this database and therefore has to be checked here
-- rather than asserted in a comment.  If it is non-empty the migration
-- rolls back and prints the breakdown, because a guard that arrives red
-- is either a real finding or a wrong predicate and both deserve a
-- human before they are committed to.
--
-- The four views from 0015 are asserted UNDISTURBED for the same reason
-- 0043 asserted the three hold views: this migration creates views and
-- touches no data, so any movement in them means something else is
-- wrong and this is where it gets noticed.

DO $$
DECLARE
  v_bad       int;
  v_population int;
  v_impure    int;
  v_identity  int;
  v_negative  int;
  v_orphan    int;
  r           record;
BEGIN
  SELECT count(*) INTO v_impure   FROM v_internal_transfer_impure;
  SELECT count(*) INTO v_identity FROM v_pot_identity_drift;
  SELECT count(*) INTO v_negative FROM v_pot_negative;
  SELECT count(*) INTO v_orphan   FROM v_pot_orphan;

  IF v_impure <> 0 OR v_identity <> 0 OR v_negative <> 0 OR v_orphan <> 0 THEN
    RAISE EXCEPTION
      '0052 refuses to commit: v_internal_transfer_impure=% v_pot_identity_drift=% v_pot_negative=% v_pot_orphan=% (all four must be 0 -- this migration must not disturb them)',
      v_impure, v_identity, v_negative, v_orphan;
  END IF;

  SELECT count(*) INTO v_population FROM v_pot_line_entry;
  SELECT count(*) INTO v_bad        FROM v_pot_line_provenance;

  IF v_bad <> 0 THEN
    FOR r IN SELECT provenance, count(*) AS n FROM v_pot_line_provenance
              GROUP BY provenance ORDER BY n DESC LOOP
      RAISE WARNING '0052: v_pot_line_provenance: % -- % entry(s)', r.provenance, r.n;
    END LOOP;
    RAISE EXCEPTION
      '0052 refuses to commit: v_pot_line_provenance = % of % pot-touching entries. A guard that arrives red is a finding or a wrong predicate; neither commits unread.',
      v_bad, v_population;
  END IF;

  RAISE NOTICE '0052: v_pot_line_provenance = 0 of % pot-touching entries -- green, and the reach is printed by dbcheck so the zero is checkable',
    v_population;
END $$;
