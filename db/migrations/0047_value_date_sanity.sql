-- =====================================================================
-- 0047  Value-date sanity: the one axis nothing on this book guarded
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- WHAT HAPPENED
-- ---------------------------------------------------------------------
--
-- `src/lib/timetravel/timetravel.integration.test.ts` went red by
-- EXACTLY 1,234 cents on every run, on a case whose whole claim is that
-- moving the BOOKING cut cannot move a VALUE date below the correction
-- act being demonstrated. It was right about the book.
--
-- Measured on this database on 2026-09-11 at 12:30Z:
--
--   1,712 journal entries carry a value date that cannot be real. The
--   earliest is 1606-04-01. The business this ledger belongs to,
--   `book_entity CORGI-BANK`, was created on 2026-09-10.
--
-- Four writers, all of them test suites, all of them committing to the
-- live book the deployed console reads:
--
--   1,580  PLANT-   src/lib/recon/planted-break.test.ts   1606-04-01 … 2013-08-16
--     104  STMT-    statements.integration.test.ts        1980-12-09 … 2011-11-19
--      16  LF3-     live fire, attack 3, an older revision 2000-05-05 … 2011-08-06
--      12  LF6-     live fire, attack 6                   2002-02-15 … 2010-05-11
--
-- Every one of them back-dates ON PURPOSE, and the purpose is good: a
-- shared book has no per-run schema, so a suite isolates itself by
-- drawing a business date nothing else could plausibly own. 146,097 days
-- of Gregorian cycle give two concurrent runs a 7e-6 chance of
-- colliding, where the five-second modulus that preceded it gave them a
-- near-certainty. That argument is correct.
--
-- What nothing said was that the isolation trick is INDISTINGUISHABLE,
-- on every screen in this product, from a backdating bug. A statement,
-- a balance-as-of, a reconciliation diff and the bitemporal demo all
-- read `value_date` and none of them has ever had a way to say "that
-- date is impossible". `dbcheck` had twenty-five invariants and not one
-- of them looked at the value axis at all.
--
-- The immediate cause is fixed where causes get fixed: planted-break is
-- now wrapped in a transaction that is rolled back, and the timetravel
-- case derives its comparison day from the act it actually got instead
-- of from a constant. This migration is the second layer, and it is the
-- one that would have caught all four writers without knowing any of
-- their names.
--
-- ---------------------------------------------------------------------
-- WHY THE ROWS ARE NOT DELETED, AND NOT REVERSED EITHER
-- ---------------------------------------------------------------------
--
-- Not deleted: `journal_entry` and `journal_line` hold no DELETE for any
-- role including the owner (0001 §13), the trial's automatic fail is
-- "UPDATE or DELETE on money rows, anywhere, ever", and 0041 already
-- settled the argument at length for a smaller table. Nothing here drops
-- a trigger or borrows the owner connection to get around one.
--
-- Not reversed either, and this is the less obvious half. The honest
-- correction to a wrong row in an append-only book is another row — but
-- these rows are not WRONG. Each one is a balanced, correctly-signed,
-- correctly-attributed posting that a suite really made. A reversal
-- entry says "we booked this and it was an error", which would be a
-- claim about the ledger that is false; and a reversal must carry the
-- ORIGINAL value date, so 1,712 reversals would put 1,712 MORE
-- impossible value dates on the book in order to complain about the
-- first 1,712. The correction would be shaped exactly like the defect.
--
-- So they stay, and they are made LEGIBLE instead — per row, with the
-- file that wrote them, in the schema rather than in a document.
--
-- ---------------------------------------------------------------------
-- THE BAND, AND WHY IT IS DERIVED RATHER THAN TYPED
-- ---------------------------------------------------------------------
--
--   lower   the entity's own creation date, minus one year
--   upper   today on the book's calendar, plus eighteen months
--
-- The lower bound is `book_entity.created_at`, not a literal, so it
-- cannot go stale and it means something a reader can check: a US
-- business account cannot settle a card or an ACH transfer on a day
-- before the program that issued it existed. One year of slack is for
-- genuine backdating — a correction, a migration from a predecessor
-- ledger — and it is generous: the earliest REAL value date on this book
-- is 2026-07-24, seven weeks before the entity was created, and it sits
-- comfortably inside.
--
-- The upper bound is a settlement-and-scheduling window, not a guess.
-- The furthest-dated real entry on this book is 2027-12-07 — standing
-- orders, value-dated ahead on purpose, and `docs/TIMETRAVEL.md` relies
-- on exactly those for the `asKnownAt` < `asOf` quadrant. That is 14.9
-- months out; eighteen gives headroom without admitting a century. The
-- bound moves forward with the clock, so an entry can only ever become
-- MORE plausible with time, never less — the band never retroactively
-- condemns a row it once accepted.
--
-- ---------------------------------------------------------------------
-- AND WHY THIS IS NOT A FILTER
-- ---------------------------------------------------------------------
--
-- The tempting version hides out-of-band entries from the statements
-- screen and nobody sees 1606 again. That is the worst available answer
-- and 0041 §"AND WHY NOT A FILTER" already wrote the reason: a predicate
-- that hides fixtures is one careless OR away from hiding a real
-- failure, and it hides it from the record. `v_value_date_out_of_band`
-- filters NOTHING within its population — it returns every out-of-band
-- entry there is, with a column saying how each one is accounted for.
-- The guard is a SECOND view over it, and the count stays 1,712.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The marker
-- ---------------------------------------------------------------------
--
-- One row per entry, keyed on the entry, because that is the grain the
-- fact has: this particular posting carries a value date the band
-- refuses, and here is what wrote it. A PRIMARY KEY on `entry_id` says
-- two people cannot disagree about one entry in two rows.

CREATE TABLE journal_value_date_residue (
  entry_id  uuid PRIMARY KEY REFERENCES journal_entry(id),

  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid NOT NULL REFERENCES actor(id),

  -- WHAT WROTE IT. A file path, so the next reader can open it. Free
  -- text on purpose, for 0041's reason: a CHECK IN (...) list goes stale
  -- the first time a suite is renamed, and the value of this column is
  -- that it names something findable, not that it is enumerable.
  source    text NOT NULL CHECK (length(btrim(source)) > 0),

  -- WHY THE DATE IS NOT REAL, in a sentence a stranger can act on. NOT
  -- NULL because a marker with no argument is an assertion, and an
  -- assertion is what this migration exists to replace.
  reason    text NOT NULL CHECK (length(btrim(reason)) > 0)
);

COMMENT ON TABLE journal_value_date_residue IS
  'A journal entry whose value date is outside the plausible band and which was already on the book when 0047 applied. Append-only: the correction to a row in an append-only book is another row, never a DELETE - and never a reversal either, because these postings are not wrong, only impossibly dated.';
COMMENT ON COLUMN journal_value_date_residue.source IS
  'What wrote it - a file path, so the next reader can open it.';
COMMENT ON COLUMN journal_value_date_residue.reason IS
  'Why the value date is not real. NOT NULL: a marker with no argument is just an assertion.';


-- ---------------------------------------------------------------------
-- 2.  The backfill, attributed per row
-- ---------------------------------------------------------------------
--
-- RESIDUE AND DECLARED ARE DIFFERENT CLAIMS, and only two of the four
-- families belong here:
--
--   residue   this happened, it is bounded, and it must not happen again
--   declared  this writer is sanctioned and will write more (§3)
--
--   PLANT-  residue.  `REF_PREFIX = 'PLANT-' + tag` in
--                     planted-break.test.ts, which now commits nothing.
--                     A new PLANT- entry means the wrapping came off.
--   LF3-    residue.  live fire attack 3, an earlier revision. No LF3-
--                     mint site remains anywhere in the tree, so a new
--                     one would be a genuine surprise.
--   STMT-   declared in §3 — an active, documented must-commit seeder.
--   LF6-    declared in §3 — an active attack.
--
-- Each family is identified by the reference prefix its own source file
-- mints, which is a signature the suite writes about itself rather than
-- a guess made here.
--
-- An entry with no recognised prefix is deliberately NOT marked. If one
-- exists it belongs in the guard, because an impossible value date
-- nobody can attribute is precisely the thing worth a red.
--
-- On a freshly reset database the SELECT matches nothing and this
-- inserts nothing, which is correct: there is no residue to declare.

INSERT INTO journal_value_date_residue (entry_id, marked_by, source, reason)
SELECT e.id,
       a.id,
       w.source,
       w.reason
  FROM journal_entry e
 CROSS JOIN LATERAL (
   SELECT ((SELECT min(created_at) FROM book_entity)::date
             - INTERVAL '1 year')::date       AS lo,
          (book_date(now()) + INTERVAL '18 months')::date AS hi
 ) band
 CROSS JOIN LATERAL (
   SELECT id FROM actor
    WHERE kind = 'system' AND display_name = 'ledger-poster'
    LIMIT 1
 ) a
 CROSS JOIN LATERAL (
   VALUES
     ('PLANT-',
      'src/lib/recon/planted-break.test.ts',
      'Booked by the planted-break reconciliation suite before it was wrapped in a rolled-back transaction. Its business date is drawn from a 146,097-day space (1600-01-02 .. 1999-12-31) so that two concurrent runs cannot collide on a shared book; earlier rows come from the Date.now() % 5000 window that preceded it (2000-03-19 .. 2013-08-16). Real postings, balanced and attributed - only the date is synthetic. The suite now commits nothing, so a new PLANT- entry means the wrapping came off.'),
     ('LF3-',
      'src/test/livefire/attack-03-bitemporal-correction.test.ts (an earlier revision)',
      'Booked by live-fire attack 3 before it was rewritten to open its own business. No LF3- mint site remains in the tree, so this prefix is residue rather than a declared writer: if these references ever reappear the guard should fire.')
 ) AS w(ref_prefix, source, reason)
 WHERE (e.value_date < band.lo OR e.value_date > band.hi)
   AND e.external_ref LIKE w.ref_prefix || '%'
   AND NOT EXISTS (
     SELECT 1 FROM journal_value_date_residue r WHERE r.entry_id = e.id
   );

DO $$
DECLARE
  out_of_band bigint;
  marked      bigint;
  unmarked    bigint;
BEGIN
  SELECT count(*) INTO out_of_band
    FROM journal_entry e
   WHERE e.value_date < ((SELECT min(created_at) FROM book_entity)::date - INTERVAL '1 year')::date
      OR e.value_date > (book_date(now()) + INTERVAL '18 months')::date;

  SELECT count(*) INTO marked FROM journal_value_date_residue;

  SELECT count(*) INTO unmarked
    FROM journal_entry e
   WHERE (e.value_date < ((SELECT min(created_at) FROM book_entity)::date - INTERVAL '1 year')::date
       OR e.value_date > (book_date(now()) + INTERVAL '18 months')::date)
     AND NOT EXISTS (SELECT 1 FROM journal_value_date_residue r WHERE r.entry_id = e.id)
     AND COALESCE(e.external_ref, '') NOT LIKE 'STMT-%'
     AND COALESCE(e.external_ref, '') NOT LIKE 'LF6-%';

  -- NOT an exception. An entry this backfill could not attribute is
  -- exactly what `v_value_date_unexplained` exists to report, and
  -- refusing to apply would leave the book with no guard at all rather
  -- than with a guard that has something to say. It is announced instead.
  RAISE NOTICE
    '0047: % entries out of band, % marked as residue, % left for the guard to report.',
    out_of_band, marked, unmarked;
END $$;


-- ---------------------------------------------------------------------
-- 3.  The census. NOTHING IS FILTERED.
-- ---------------------------------------------------------------------
--
-- Every out-of-band entry there is, with how each one is accounted for.
-- Three dispositions and they are ordered by how much they should worry
-- a reader:
--
--   declared    a writer this schema knows about, named here, in SQL,
--               with its file path. Adding one takes a MIGRATION, which
--               is the point: an exemption should cost a reviewed act,
--               not an INSERT.
--   residue     already on the book when 0047 applied, attributed per
--               row in `journal_value_date_residue`. A bounded,
--               finite set that can only shrink relative to the book.
--   unexplained an impossible value date nobody has claimed. The guard.
--
-- `PLANT-` IS DELIBERATELY NOT A DECLARED WRITER. Its 1,580 existing
-- rows are residue, which closes them; but the suite is now wrapped, so
-- a single new PLANT- entry means the wrapping came off, and this view
-- will say so within one `dbcheck` run instead of within one red
-- timetravel assertion three files away.

CREATE VIEW v_value_date_out_of_band AS
WITH band AS (
  SELECT ((SELECT min(created_at) FROM book_entity)::date - INTERVAL '1 year')::date AS lo,
         (book_date(now()) + INTERVAL '18 months')::date                             AS hi
),
declared AS (
  SELECT *
    FROM (VALUES
      ('STMT-', 'src/lib/statements/statements.integration.test.ts'),
      ('LF6-',  'src/test/livefire/attack-06-planted-break.test.ts')
    ) AS w(ref_prefix, source)
)
SELECT e.id                AS entry_id,
       e.booking_seq,
       e.booking_time,
       e.value_date,
       e.entry_type,
       e.book,
       e.rail,
       e.external_ref,
       e.description,
       b.lo                AS band_lo,
       b.hi                AS band_hi,
       CASE WHEN e.value_date < b.lo THEN 'before the entity existed'
            ELSE 'beyond the settlement window' END AS which_side,
       CASE WHEN d.ref_prefix IS NOT NULL THEN 'declared'
            WHEN r.entry_id   IS NOT NULL THEN 'residue'
            ELSE 'unexplained' END                  AS accounted_by,
       COALESCE(d.source, r.source)                 AS source,
       r.reason                                     AS residue_reason
  FROM journal_entry e
 CROSS JOIN band b
  LEFT JOIN journal_value_date_residue r ON r.entry_id = e.id
  LEFT JOIN declared d ON e.external_ref LIKE d.ref_prefix || '%'
 WHERE e.value_date < b.lo OR e.value_date > b.hi;

COMMENT ON VIEW v_value_date_out_of_band IS
  'Every journal entry whose value date falls outside [entity created - 1 year, today + 18 months], with how each is accounted for: declared writer, marked residue, or unexplained. A LEFT JOIN, never a WHERE - a filter that hides fixtures is one edit away from hiding a real failure.';


-- ---------------------------------------------------------------------
-- 4.  The guard
-- ---------------------------------------------------------------------
--
-- An impossible value date nobody has claimed. Zero rows when 0047
-- applied, and it went to zero by ATTRIBUTING 1,712 entries rather than
-- by narrowing a predicate around them - the distinction 0032 and 0040
-- both insist on and the one this file would have failed most easily.
--
-- What it can see: EVERY entry in `journal_entry`, on either side of the
-- band. What makes it fire: a value date a writer nobody declared put
-- on the book after 2026-09-11. That includes the four suites above if
-- any of them ever mints a new prefix, and it includes the product.

CREATE VIEW v_value_date_unexplained AS
SELECT entry_id, booking_seq, booking_time, value_date, entry_type,
       book, rail, external_ref, description, band_lo, band_hi, which_side
  FROM v_value_date_out_of_band
 WHERE accounted_by = 'unexplained';

COMMENT ON VIEW v_value_date_unexplained IS
  'MUST BE EMPTY. A value date outside the plausible band that no declared writer owns and no residue row accounts for. See db/migrations/0047_value_date_sanity.sql and scripts/dbcheck.mjs.';


-- ---------------------------------------------------------------------
-- 5.  Privileges, and layer 2
-- ---------------------------------------------------------------------
--
-- SELECT and INSERT, the shape 0041 §6 gives `fx_quote_fixture`: a suite
-- that genuinely must commit an out-of-band value date can mark what it
-- commits, as `corgi_app`, in the same transaction that commits it. That
-- is the honest path and it should be available without an owner
-- connection.

GRANT SELECT, INSERT ON journal_value_date_residue TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON journal_value_date_residue FROM corgi_app, PUBLIC;

GRANT SELECT ON v_value_date_out_of_band, v_value_date_unexplained TO corgi_app;

-- Privileges do not bind the table OWNER (0001 §13). A marker that could
-- be quietly withdrawn by whoever holds the owner connection is worth
-- nothing, and this one exists precisely to be un-withdrawable.
CREATE TRIGGER journal_value_date_residue_no_update_delete
  BEFORE UPDATE OR DELETE ON journal_value_date_residue
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();
CREATE TRIGGER journal_value_date_residue_no_truncate
  BEFORE TRUNCATE ON journal_value_date_residue
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 6.  The audit registry
-- ---------------------------------------------------------------------
--
-- 0035 §7: every base table must be classified or
-- `v_audit_source_unclaimed` turns non-empty and the audit screen prints
-- it in red. `excluded`, for 0041's reason and it applies unchanged here:
-- `v_actor_action` is a business timeline — what somebody did to a
-- customer's money — and declaring an entry's DATE synthetic is a
-- statement about the provenance of a record, not an act upon money. It
-- is surfaced beside the rows it annotates, in the two views above and
-- in `dbcheck`.

INSERT INTO audit_source (table_name, disposition, surface, reason, declared_in)
SELECT 'journal_value_date_residue', 'excluded', 'ledger',
       'Marks a journal entry as carrying a value date outside the plausible band, written by a named test suite rather than by a customer. NOT on the actor timeline: v_actor_action records what was done to a customer''s money, and this records the PROVENANCE of a date. Surfaced beside the rows it annotates instead - v_value_date_out_of_band, v_value_date_unexplained and scripts/dbcheck.mjs. Projecting it would need a v_actor_action branch in 0035, which 0047 does not own.',
       '0047_value_date_sanity.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM audit_source s WHERE s.table_name = 'journal_value_date_residue'
);
