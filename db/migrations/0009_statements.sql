-- =====================================================================
-- 0009  Statements: the two things 0001's `statement` table does not have
-- =====================================================================
--
-- 0001 already carries the whole statement model and none of it is
-- repeated or reimplemented here:
--
--   * book_day            (entity_id, business_date) PK, closed_at,
--                         booking_watermark, closed_by
--   * statement           immutable, versioned per
--                         (account_id, period_start, period_end, version),
--                         pinned to a booking_watermark, content_hash bytea
--                         with a 32-byte CHECK
--   * the append-only triggers on BOTH tables, plus the privilege layer:
--                         corgi_app holds SELECT, INSERT and nothing else
--   * v_late_postings     entries booked above their own day's watermark
--
-- That is the design of §13 and it is right. Two columns are missing, and
-- both were found by writing the publisher against it rather than by
-- reading the file.
--
-- ---------------------------------------------------------------------
-- 1.  WHO ISSUED THE DOCUMENT
-- ---------------------------------------------------------------------
--
-- Every other artefact in this schema records the actor that produced it:
--
--     book_day.closed_by        uuid NOT NULL REFERENCES actor(id)
--     recon_run.run_by          uuid NOT NULL REFERENCES actor(id)
--     scheme_file.imported_by   uuid NOT NULL REFERENCES actor(id)
--     journal_entry.actor_id    uuid NOT NULL REFERENCES actor(id)
--
-- `statement` records none. So the one artefact a customer actually
-- receives is the one artefact with no attribution, and "who issued the
-- corrected version of Tuesday, and when" is answerable for the close
-- that pinned it but not for the document itself. In a control review
-- that is the question, and the honest answer today is a shrug.
--
-- NOT NULL with no default and no backfill, deliberately: the table is
-- empty (nothing has ever written to it), so there is no historical row
-- to invent an author for. If there were, this would have to be a
-- nullable column with a documented cutover, because filling in an
-- author nobody can vouch for is worse than admitting we do not know.
--
-- ---------------------------------------------------------------------
-- 2.  WHICH RENDERER PRODUCED THE HASH
-- ---------------------------------------------------------------------
--
-- `content_hash` is sha256 over a canonical rendering. The rendering is
-- code, and code is a versioned artefact -- queries.draft.sql §4c already
-- says so: "either a money row changed - impossible, see the REVOKEs and
-- the hash chain - or the renderer changed, which is a versioned artefact
-- and a deployment question, not a ledger question."
--
-- Without this column the system cannot tell those two cases apart. A
-- renderer change would make every historical statement fail
-- verification, and the alarm would read "the ledger has been tampered
-- with" when the truth is "you deployed a new formatter". That is the
-- worst possible failure mode for a tamper-evidence mechanism: an alarm
-- nobody trusts is an alarm nobody reads.
--
-- With it, `verifyStatement` can say precisely: this row was rendered by
-- corgi.statement.v1, you are running corgi.statement.v2, so the hashes
-- are not comparable and this is a deployment fact rather than a P1.
--
-- The default is the format in use at the time this migration is written,
-- which is also the only one that has ever existed. It is on the column
-- rather than in the application so that a row written by a caller that
-- forgot cannot be silently format-less.
-- =====================================================================

ALTER TABLE statement
  ADD COLUMN generated_by uuid NOT NULL REFERENCES actor(id),
  ADD COLUMN format       text NOT NULL DEFAULT 'corgi.statement.v1';

COMMENT ON COLUMN statement.generated_by IS
  'The actor that issued this document. Matches book_day.closed_by and recon_run.run_by.';
COMMENT ON COLUMN statement.format IS
  'The canonical renderer that produced content_hash (src/lib/statements/render.ts, STATEMENT_FORMAT). A hash is only comparable against a hash from the same format.';

-- No new GRANT is needed: 0001 grants SELECT, INSERT on `statement` at the
-- TABLE level, and a table-level grant covers columns added later. The
-- REVOKE of UPDATE, DELETE, TRUNCATE is table-level too, so the new
-- columns are as unwritable-after-the-fact as the old ones. Verified by
-- pnpm db:check, which attempts UPDATE on the money tables as corgi_app
-- and asserts refusal.

-- ---------------------------------------------------------------------
-- The current version of every period, and the lineage behind it
-- ---------------------------------------------------------------------
--
-- queries.draft.sql §4d, as a view rather than as a query the application
-- has to remember to write correctly. `is_current` is the highest version
-- for the period -- NOT the one with the highest watermark, because those
-- are the same thing by construction (a version is only ever issued at a
-- watermark no earlier than its predecessor's) and version is the number
-- a human cites.
CREATE VIEW v_statement_version AS
SELECT s.id                                AS statement_id,
       s.account_id,
       a.business_id,
       s.period_start,
       s.period_end,
       s.version,
       s.booking_watermark,
       s.opening_balance_cents,
       s.closing_balance_cents,
       s.line_count,
       encode(s.content_hash, 'hex')       AS content_hash,
       s.format,
       s.generated_at,
       s.generated_by,
       s.version = MAX(s.version) OVER (
         PARTITION BY s.account_id, s.period_start, s.period_end
       )                                   AS is_current,
       -- The watermark the PREVIOUS version was pinned to. The entries
       -- that forced this version are exactly those with a value date in
       -- the period and a booking_seq in (prev_watermark, watermark].
       LAG(s.booking_watermark) OVER (
         PARTITION BY s.account_id, s.period_start, s.period_end
         ORDER BY s.version
       )                                   AS prev_booking_watermark
  FROM statement s
  JOIN account a ON a.id = s.account_id;

GRANT SELECT ON v_statement_version TO corgi_app;
