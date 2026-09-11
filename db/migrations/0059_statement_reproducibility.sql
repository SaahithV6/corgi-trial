-- =====================================================================
-- 0059  STATEMENT REPRODUCIBILITY, MADE AN INVARIANT
-- =====================================================================
--
-- THE GAP THIS CLOSES.  The brief's item 7 is:
--
--     "A closed day's statement is reproducible forever, corrections
--      included, IDENTICAL EVERY TIME."
--
-- The DESIGN supports that and has since 0009.  `statement` carries the
-- append-only triggers, `corgi_app` holds SELECT and INSERT on it and
-- nothing else, a correction is a NEW VERSION rather than an edit, and
-- `src/lib/statements/render.ts` takes the content hash over a preimage
-- whose inputs are exactly
--
--     (format version, account, period, booking watermark)
--
-- and nothing else -- not `statement.id`, not `version`, not
-- `generated_at`, which is what makes re-rendering able to reproduce a
-- published hash at all rather than circularly.
--
-- What did not exist was anything that CHECKS it.  Of the 37 gated
-- invariant views before this file there was no `v_statement_*` at all.
-- The whole reproducibility claim rested on a design argument, and this
-- build has a catalogue of what happens to design arguments nobody
-- executes: 0012's view was unsatisfiable, 0026's excluded the bug it
-- was written for, 0028's could see 55% of its table, and each of the
-- three shipped with a paragraph explaining why it was fine.
--
-- ---------------------------------------------------------------------
-- WHAT THIS VIEW ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------
--
-- IT DOES NOT RE-IMPLEMENT THE HASH.  The obvious view is "recompute
-- `content_hash` in SQL and compare".  That would be a SECOND definition
-- of the canonical rendering -- the netstring preimage, the field order,
-- the `STATEMENT_FORMAT` prefix -- living in a place no renderer change
-- would ever update, and the two definitions would agree until the day
-- they silently did not.  0022's rule about `ledger_availability()` is
-- the same rule: one definition, and everything else reads it.  The hash
-- has exactly one definition and it is in TypeScript.
--
-- WHAT IS CHECKABLE IN SQL, and is the thing the hash rests on, is the
-- RECTANGLE.  A published statement is a pure function of its inputs
-- only if the rows those inputs select are still exactly the rows they
-- selected on the day it was published.  Three of the document's stored
-- figures are re-derivable from the journal at the stored watermark
-- WITHOUT touching the renderer, and if any of them has moved then the
-- preimage has moved, so the hash cannot reproduce and the guarantee is
-- already broken -- whatever a re-render would say:
--
--     opening_balance_cents   SUM over value_date < period_start
--                             at booking_seq <= watermark
--     line_count              COUNT over value_date IN the period
--                             at booking_seq <= watermark
--     closing_balance_cents   opening + SUM of those same lines
--
-- These are the SAME two rectangles `readAccountPeriod()` draws --
-- deliberately, including its asymmetry, where the line query asserts
-- `e.book = 'financial'` and the opening query does not (a covering-index
-- choice, documented at the reader, and the two are the same set because
-- `assert_entry_balanced()` refuses an entry whose lines cross books).
-- This view reproduces that asymmetry rather than tidying it, because a
-- guard that draws a DIFFERENT rectangle from the renderer is not
-- checking the renderer, it is disagreeing with it.
--
-- The remaining half of reproducibility -- that the preimage bytes hash
-- to the stored digest -- is proved where the renderer lives:
-- `src/lib/statements/statements.integration.test.ts` re-renders a
-- published closed day TWICE, at two different instants, and asserts the
-- canonical preimage is byte-identical both times and the digest equals
-- the published `content_hash`.  The pair is the proof.  This file owns
-- "the rows have not moved"; the test owns "the bytes are the same".
--
-- ---------------------------------------------------------------------
-- THE FOURTH ARM: A FUNCTION THAT IS NOT A FUNCTION
-- ---------------------------------------------------------------------
--
-- "Identical every time" also means: the same four inputs cannot yield
-- two different documents.  So two `statement` rows agreeing on
-- (format, account_id, period_start, period_end, booking_watermark) and
-- DISAGREEING on `content_hash` is a violation on its face, with no
-- re-derivation needed.
--
-- ITS POPULATION ON THIS BOOK IS ZERO GROUPS, and that is stated here
-- rather than discovered later, because a zero-population arm is
-- `v_standing_order_double_fire`'s defect (0023) if it is the WHOLE
-- guard.  It is not: every version pair on this book sits at a different
-- watermark -- 62 statements, 5 accounts, and the four Ridgeline
-- 2026-07-24 versions sit at 485 / 487 / 498 / 502 -- so no two are
-- directly comparable and this arm has nothing to range over TODAY.  The
-- three re-derivation arms above it range over all 62, which is the
-- whole table, so the VIEW's reach is total and only this arm's is
-- contingent.  It is carried because the day a reissue lands at an
-- unchanged watermark is exactly the day it stops being contingent, and
-- `dbcheck --prove` makes it fire in a rolled-back transaction so it is
-- seen working before it is believed -- the rule 0026 broke.
--
-- ---------------------------------------------------------------------
-- WHY THE POPULATION IS TOTAL AND CANNOT BE ARGUED WITH BY A WRITER
-- ---------------------------------------------------------------------
--
-- Every row of `statement`, judged.  Not a subset chosen by format, by
-- account, by age or by a key prefix -- 0052's rule, which 0054 restated
-- at 150x scale: the population must be A FACT ABOUT THE CHART OR THE
-- TABLE, never a label the writer picks.
--
-- The facts this rests on, verified against this database as corgi_app:
--
--   statement       SELECT, INSERT.  No UPDATE, no DELETE, and the 0001
--                   append-only triggers refuse both for every role.  A
--                   published figure cannot be edited to agree with a
--                   later re-derivation; the only way to change what a
--                   period says is a NEW VERSION, which lands in this
--                   same population and is judged on its own.
--   journal_entry / journal_line
--                   SELECT, INSERT, with `ledger_row_is_immutable()` on
--                   UPDATE, DELETE and TRUNCATE.  So the rectangle below
--                   a published watermark is frozen BY THE DATABASE, and
--                   this view is the second line that says so if it ever
--                   stops being true.
--   account         SELECT only.  `normal_side` -- the sign convention
--                   the whole re-derivation turns on -- is outside the
--                   application's reach entirely.
--
-- The statement -> account join is INNER and that is safe rather than
-- narrowing: `statement.account_id` is a foreign key to `account.id`, so
-- it drops nothing.  Asserted at commit below rather than asserted here,
-- because a join that silently drops rows is how a guard narrows itself.
--
-- ---------------------------------------------------------------------
-- GREEN ON ARRIVAL
-- ---------------------------------------------------------------------
--
--   v_statement_content_drift   0 of 62 published statements -- and 59
--                               of those 62 carry at least one
--                               correction line inside their period
--                               (188 lines in all), so the guard's zero
--                               covers the brief's "corrections
--                               included" clause rather than only the
--                               quiet periods.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The census.  NOTHING IS FILTERED.
-- ---------------------------------------------------------------------
--
-- Every published statement, re-derived from the journal at its own
-- stored watermark, with the comparison spelled out column by column. A
-- CASE and not a WHERE, for 0047 §3's reason: the count of what was
-- judged is the only thing that makes the guard's zero mean anything.

CREATE VIEW v_statement_rederived AS
WITH judged AS (
  SELECT s.id                    AS statement_id,
         s.account_id,
         s.period_start,
         s.period_end,
         s.version,
         s.booking_watermark,
         s.format,
         s.generated_at,
         s.opening_balance_cents AS published_opening_cents,
         s.closing_balance_cents AS published_closing_cents,
         s.line_count            AS published_line_count,
         s.content_hash,

         -- RECTANGLE 1 -- everything strictly BEFORE the period, at the
         -- watermark. No `e.book` predicate, exactly as
         -- `readAccountPeriod()` leaves it off, to keep the
         -- (account_id, value_date, booking_seq) covering index in play.
         (SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side
            FROM journal_line l
           WHERE l.account_id  = a.id
             AND l.value_date  < s.period_start
             AND l.booking_seq <= s.booking_watermark)
                                 AS rederived_opening_cents,

         -- RECTANGLE 2 -- everything INSIDE the period, at the
         -- watermark. `e.book = 'financial'` asserted, exactly as the
         -- renderer asserts it.
         (SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint
            FROM journal_line l
            JOIN journal_entry e ON e.id = l.entry_id
           WHERE l.account_id  = a.id
             AND l.value_date BETWEEN s.period_start AND s.period_end
             AND l.booking_seq <= s.booking_watermark
             AND e.book = 'financial')
                                 AS rederived_movement_cents,

         (SELECT count(*)
            FROM journal_line l
            JOIN journal_entry e ON e.id = l.entry_id
           WHERE l.account_id  = a.id
             AND l.value_date BETWEEN s.period_start AND s.period_end
             AND l.booking_seq <= s.booking_watermark
             AND e.book = 'financial')
                                 AS rederived_line_count,

         -- HOW MANY OF THOSE LINES ARE A CORRECTION. Not judged -- a
         -- correction is ordinary, licensed traffic and the point of the
         -- brief's clause is that it must be INCLUDED, not excluded.
         -- Printed so the guard's zero can be read as covering periods
         -- that carry one, rather than only quiet ones.
         (SELECT count(*)
            FROM journal_line l
            JOIN journal_entry e ON e.id = l.entry_id
           WHERE l.account_id  = a.id
             AND l.value_date BETWEEN s.period_start AND s.period_end
             AND l.booking_seq <= s.booking_watermark
             AND e.book = 'financial'
             AND (e.entry_type <> 'original' OR e.correction_group_id IS NOT NULL))
                                 AS correction_lines,

         -- THE FOURTH ARM. Same four inputs, two different documents.
         -- Asked over the WINDOW rather than by a self-join, so a group
         -- of three disagreeing rows reports all three and not one pair.
         -- `min <> max` and not `count(DISTINCT ...)`: Postgres does not
         -- implement DISTINCT for window functions, and over a bytea the
         -- two are the same question anyway -- a group whose smallest and
         -- largest digest differ is a group that is not a function.
         count(*) OVER w         AS siblings_at_this_watermark,
         (min(s.content_hash) OVER w IS DISTINCT FROM max(s.content_hash) OVER w)
                                 AS hashes_disagree_at_this_watermark
    FROM statement s
    JOIN account   a ON a.id = s.account_id
  WINDOW w AS (PARTITION BY s.format, s.account_id, s.period_start,
                            s.period_end, s.booking_watermark)
)
SELECT j.*,
       (j.rederived_opening_cents + j.rederived_movement_cents)::bigint
         AS rederived_closing_cents,
       CASE
         -- The function-is-not-a-function arm goes FIRST: it needs no
         -- re-derivation to be a violation, so it must not be masked by
         -- one.
         WHEN j.hashes_disagree_at_this_watermark
           THEN 'two documents at the same watermark disagree on their content hash'
         WHEN j.content_hash IS NULL OR octet_length(j.content_hash) <> 32
           THEN 'the stored content hash is not a 32-byte digest'
         WHEN j.rederived_opening_cents <> j.published_opening_cents
           THEN 'the opening balance does not re-derive at the stored watermark'
         WHEN j.rederived_line_count <> j.published_line_count
           THEN 'the line count does not re-derive at the stored watermark'
         WHEN j.rederived_opening_cents + j.rederived_movement_cents
                <> j.published_closing_cents
           THEN 'the closing balance is not the opening plus the period''s movement'
         ELSE 'reproduces'
       END AS verdict
  FROM judged j;

COMMENT ON VIEW v_statement_rederived IS
  'Every published statement, re-derived from the journal at its OWN stored watermark - the same two rectangles readAccountPeriod() draws, including its deliberate book-predicate asymmetry - with the comparison column by column. The conforming arm is verdict = ''reproduces''. The hash itself is NOT recomputed here: it has one definition, in src/lib/statements/render.ts, and a second one in SQL would be the defect 0022 exists to have ended. See db/migrations/0059_statement_reproducibility.sql.';


-- ---------------------------------------------------------------------
-- 2.  The guard.  MUST RETURN ZERO ROWS.  It is a TEST.
-- ---------------------------------------------------------------------
--
-- WHAT IT CAN SEE: every row of `statement`, in any format, on any
-- account, of any version, at any age. 62 on this book.
--
-- WHAT MAKES IT FIRE: a published document whose figures no longer
-- follow from the book at the watermark it pinned. That is the exact
-- failure of "identical every time" -- if the rectangle moved, the
-- preimage moved, and the hash cannot reproduce whatever anyone re-runs.
-- Or two documents claiming the same four inputs and disagreeing.
--
-- WHAT IT DOES NOT EXAMINE, named rather than left implied:
--
--   * THE HASH ITSELF. One definition, in TypeScript, proved against
--     this table by `statements.integration.test.ts` re-rendering a
--     published day twice at two instants. Recomputing the netstring
--     preimage in SQL would be a second definition; see the header.
--   * WHETHER A PERIOD SHOULD HAVE A NEWER VERSION. A late posting
--     inside a closed period is legitimate and is exactly why versions
--     exist; `listLatePostings()` and the /statements screen own that
--     question. A statement at an old watermark is correct AS AT that
--     watermark, which is the whole claim.
--   * WHETHER THE DAY WAS CLOSED. `publishStatement` refuses an open
--     day with `DayNotClosedError` and `book_day` is append-only; this
--     view judges the document, not the gate in front of it.
--   * PDF RENDERING. `pdf.ts` renders FROM the document this view
--     checks. A byte-identical document is the precondition; the PDF's
--     own determinism is `pdf.test.ts`.

CREATE VIEW v_statement_content_drift AS
SELECT statement_id, account_id, period_start, period_end, version,
       booking_watermark, format, generated_at,
       published_opening_cents, rederived_opening_cents,
       published_closing_cents, rederived_closing_cents,
       published_line_count, rederived_line_count,
       rederived_movement_cents, correction_lines,
       siblings_at_this_watermark, hashes_disagree_at_this_watermark,
       verdict
  FROM v_statement_rederived
 WHERE verdict <> 'reproduces';

COMMENT ON VIEW v_statement_content_drift IS
  'MUST BE EMPTY. A published statement whose opening balance, line count or closing balance no longer re-derives from the journal at the watermark it pinned - so its canonical preimage has moved and its content_hash can never reproduce - or two documents claiming the same (format, account, period, watermark) and disagreeing on that hash. This is the brief''s "a closed day''s statement is reproducible forever, corrections included, identical every time" as a gated invariant rather than a design argument. See db/migrations/0059_statement_reproducibility.sql and scripts/dbcheck.mjs.';


-- ---------------------------------------------------------------------
-- 3.  Privileges
-- ---------------------------------------------------------------------
--
-- SELECT only, to `corgi_app`, exactly as 0052 §3 and 0054 §5 granted
-- theirs. `scripts/dbcheck.mjs` and the chaos dashboard both read as that
-- role, and dbcheck treats an unreadable view as a FAIL, never a pass.

GRANT SELECT ON v_statement_rederived, v_statement_content_drift TO corgi_app;


-- ---------------------------------------------------------------------
-- 4.  The migration refuses to commit on a book it would break
-- ---------------------------------------------------------------------
--
-- 0043's closing shape, as 0052 and 0054 used it. This migration creates
-- two views and touches no data, so any movement in a neighbouring guard
-- means something else is wrong and this is where it gets noticed.
--
-- The six standing reds are deliberately NOT in the undisturbed list:
-- they are argued on `RED_REGISTER` in scripts/dbcheck.mjs and they stay
-- red.

DO $$
DECLARE
  v_pop       int;
  v_drift     int;
  v_joined    int;
  v_all_stmts int;
  v_corr      int;
  v_control   int;
  v_memo_pop  int;
  v_deposit   int;
  r           record;
BEGIN
  SELECT count(*) INTO v_control  FROM v_deposit_control_drift;
  SELECT count(*) INTO v_deposit  FROM v_deposit_cross_customer;
  SELECT count(*) INTO v_memo_pop FROM v_memo_line_placed;

  IF v_control <> 0 OR v_deposit <> 0 THEN
    RAISE EXCEPTION
      '0059 refuses to commit: v_deposit_control_drift=% v_deposit_cross_customer=% (both must be 0 -- this migration creates views and must not disturb them)',
      v_control, v_deposit;
  END IF;

  -- REACH COMPLETENESS, checked here and not only printed by dbcheck.
  -- The census joins `statement` to `account`, and its whole claim to
  -- totality is that the join drops nothing. `statement.account_id` is a
  -- foreign key, so it cannot -- and that is asserted rather than
  -- trusted, because a guard whose population is not total is the defect
  -- 0052 and 0054 exist to close.
  SELECT count(*) INTO v_all_stmts FROM statement;
  SELECT count(*) INTO v_joined    FROM v_statement_rederived;

  IF v_joined <> v_all_stmts THEN
    RAISE EXCEPTION
      '0059 refuses to commit: v_statement_rederived reaches % of % published statements. A guard whose population is not total is the defect this migration exists to close.',
      v_joined, v_all_stmts;
  END IF;

  SELECT count(*) INTO v_pop   FROM v_statement_rederived;
  SELECT count(*) INTO v_drift FROM v_statement_content_drift;

  IF v_drift <> 0 THEN
    FOR r IN SELECT verdict, count(*) AS n FROM v_statement_content_drift
              GROUP BY verdict ORDER BY n DESC LOOP
      RAISE WARNING '0059: v_statement_content_drift: % -- % statement(s)', r.verdict, r.n;
    END LOOP;
    RAISE EXCEPTION
      '0059 refuses to commit: v_statement_content_drift = % of % published statements. A guard that arrives red is a finding or a wrong predicate; neither commits unread.',
      v_drift, v_pop;
  END IF;

  -- The brief's clause is "corrections INCLUDED", so the guard's zero is
  -- only worth what it covers. If no published period contains a
  -- correction line, this guard's green says nothing about corrections
  -- and the claim is still unproven -- so say so loudly rather than let
  -- the zero be read as more than it is.
  SELECT count(*) INTO v_corr FROM v_statement_rederived WHERE correction_lines > 0;

  IF v_corr = 0 THEN
    RAISE WARNING
      '0059: NO published statement on this book contains a correction line. v_statement_content_drift is green over % statements, and NONE of them exercises the "corrections included" half of the claim. src/lib/statements/statements.integration.test.ts carries that half against the 2026-09-08 Ridgeline correction group.',
      v_pop;
  ELSE
    RAISE NOTICE '0059: % of % published statements contain at least one correction line', v_corr, v_pop;
  END IF;

  RAISE NOTICE '0059: v_statement_content_drift = 0 of % published statements (% of % rows reached -- the population is total)',
    v_pop, v_joined, v_all_stmts;
  RAISE NOTICE '0059: v_memo_line_placed census stands at % memo entries (unchanged by this migration)', v_memo_pop;
END $$;
