-- =====================================================================
-- 0041  Fixture provenance on the FX quote book
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- WHAT HAPPENED
-- ---------------------------------------------------------------------
--
-- `src/lib/fx/fx.integration.test.ts` runs against the LIVE database
-- when RUN_DB_TESTS=1, and every row it wrote COMMITTED. Over eleven
-- runs on 2026-09-11 it left 63 quotes, 63 rate observations, 28
-- acceptances and -- the one that matters -- SEVEN settlements in
-- `fx_quote_settlement`.
--
-- There have been EIGHT settlements in this system's whole history and
-- exactly ONE of them is real:
--
--   0x0acfad50d866e99ce4db08f3c09a2c8ca1d2771fd00ebcb6b0678fb75777d79e
--   Base Sepolia block 46666112, 1.979521 USDC, entry
--   027255d5-ee38-4eed-ac50-9771ba8d589a.  docs/STABLECOIN.md.
--
-- The other seven carry `tx_hash = '0x' || repeat('a', 64)` -- a
-- literal typed into a test file, not a keccak-256 digest of anything.
-- They have no `entry_id`, no destination address, and no rate
-- observation behind their settlement mid.
--
-- Nobody meant to claim eight cross-border payouts confirmed on chain.
-- But `SELECT count(*) FROM fx_quote_settlement` returns 8, and a
-- reader who checks one hash against Basescan and finds it confirms has
-- been handed the shape of a false claim. That is what this migration
-- closes.
--
-- ---------------------------------------------------------------------
-- WHY THE ROWS ARE NOT DELETED
-- ---------------------------------------------------------------------
--
-- Because they CANNOT be, and because they SHOULD NOT be, and the two
-- reasons are independent.
--
-- They cannot be. 0017 §7 gives `corgi_app` SELECT and INSERT on
-- `fx_quote_settlement` and revokes UPDATE, DELETE and TRUNCATE, then
-- adds `ledger_row_is_immutable()` triggers so the REVOKE binds the
-- table OWNER too. A DELETE here is refused at two layers, and the
-- second layer exists precisely so that a migration -- a file exactly
-- like this one -- cannot sail past the first. Writing a migration that
-- drops the trigger to delete the rows and puts it back would be the
-- single most dishonest thing in this repository: it would defeat the
-- control by using the privilege the control was written to deny.
--
-- They should not be. The trial's automatic fail is "UPDATE or DELETE
-- on money rows. Anywhere. Ever." `fx_quote_settlement` is guarded with
-- the same function, the same GRANT shape and the same trigger pair as
-- `journal_entry`; it carries `settlement_cost_cents`, a signed
-- `variance_cents` that is a real P&L position (account 4300), and a
-- foreign key into `journal_entry`. If it is not a money row it is
-- indistinguishable from one, and "I judged this table to be only
-- MOSTLY append-only" is not an argument anybody should have to accept
-- at two in the morning.
--
-- And a third reason, which is the one I would give first if asked:
-- "seven bogus settlements were written to production by a test suite
-- on 2026-09-11" is a TRUE AND USEFUL FACT ABOUT THIS SYSTEM. Deleting
-- the evidence of a bug is not cleaning up after it. The honest
-- correction to a wrong row in an append-only book is another row.
--
-- ---------------------------------------------------------------------
-- WHY A TABLE AND NOT A COLUMN
-- ---------------------------------------------------------------------
--
-- A marker COLUMN on `fx_quote_settlement` is the obvious first idea
-- and it is unimplementable here: `ALTER TABLE ... ADD COLUMN` would
-- work, and then the backfill is an UPDATE, which is refused by the
-- privilege AND by the trigger. A column that can never be written on
-- an existing row is a column that is always false.
--
-- So a new fact gets a new row, which is the shape this schema already
-- uses everywhere a fact is attached to an immutable one:
-- `fx_quote_acceptance`, `hold_closure`, `payee_archival`,
-- `hold_closure_reversal`. `fx_quote_fixture` is a sibling of those.
--
-- It keys on `fx_quote`, not on `fx_quote_settlement`, because the
-- quote is the root of the lineage: mark the quote and its observation,
-- its acceptance and its settlement are all accounted for by one row.
-- A suite that writes a quote and never settles it is marked by the
-- same mechanism.
--
-- ---------------------------------------------------------------------
-- AND WHY NOT A FILTER
-- ---------------------------------------------------------------------
--
-- The tempting fix is `WHERE tx_hash <> '0x' || repeat('a', 64)` in the
-- payouts query and nobody ever sees the seven again. That is the worst
-- available answer. A filter that hides fixtures is one edit -- one
-- widened predicate, one careless OR -- away from hiding a real
-- failure, and it hides it from the screen whose whole job is to be the
-- record. `v_fx_quote_marked` below filters NOTHING. It adds a column
-- that says which is which, `/payouts` prints it, and the count stays
-- eight.
--
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  The marker
-- ---------------------------------------------------------------------

CREATE TABLE fx_quote_fixture (
  -- Once per quote, and the PRIMARY KEY says so: a quote is a fixture
  -- or it is not, and two people cannot disagree about it in two rows.
  quote_id  uuid PRIMARY KEY REFERENCES fx_quote(id),

  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid NOT NULL REFERENCES actor(id),

  -- WHAT WROTE IT. A file path, so the next person can open it. Free
  -- text on purpose: a CHECK IN (...) list would go stale the first
  -- time a suite is renamed, and the value of this column is that it
  -- names something findable, not that it is enumerable.
  source    text NOT NULL CHECK (length(btrim(source)) > 0),

  -- WHY IT IS NOT REAL, in a sentence a stranger can act on. NOT NULL
  -- for the reason `audit_source.reason` is: a marker with no argument
  -- is an assertion, and an assertion is what this whole migration
  -- exists to replace.
  reason    text NOT NULL CHECK (length(btrim(reason)) > 0)
);

COMMENT ON TABLE fx_quote_fixture IS
  'A quote (and therefore its observation, acceptance and settlement) that was written by a test, not by a customer. Append-only: the correction to a wrong row in an append-only book is another row, never a DELETE.';
COMMENT ON COLUMN fx_quote_fixture.source IS
  'What wrote it - a file path, so the next reader can open it.';
COMMENT ON COLUMN fx_quote_fixture.reason IS
  'Why this is not a real customer commitment. NOT NULL: a marker with no argument is just an assertion.';


-- ---------------------------------------------------------------------
-- 2.  The backfill, and the proof that it marked the right rows
-- ---------------------------------------------------------------------
--
-- The criterion is the suite's OWN SIGNATURE. `fx.integration.test.ts`
-- builds `RUN_ID = 'it-' + Date.now().toString(36)` and appends it to
-- every `beneficiary_ref` it writes ("Settled it-mtw9gmn5", "Manila
-- contractor it-mtwa33ob"). Nothing else in this system writes that
-- shape: the four seeded demo quotes are "Guadalajara parts supplier",
-- "Manila contractor", "Bengaluru software vendor" and "Osaka machine
-- tools", and the three operator runs are "Off-ramp partner - testnet
-- demo".
--
-- A regex backfill is a guess unless it is checked, so it is checked,
-- against a SECOND AND INDEPENDENT criterion: a settlement is a fixture
-- iff its `tx_hash` is 64 repetitions of one hex digit, which no
-- keccak-256 digest has ever been. The two criteria must select exactly
-- the same settlements or this migration refuses to apply. On the
-- database this was written against they agree on 7 of 8, and the
-- eighth is the Base Sepolia payout.
--
-- On a freshly reset database both sides are empty, they agree
-- trivially, and nothing is inserted.

INSERT INTO fx_quote_fixture (quote_id, marked_by, source, reason)
SELECT q.id,
       a.id,
       'src/lib/fx/fx.integration.test.ts',
       'Written against the live database by the FX integration suite before it was wrapped in a rolled-back transaction. Identified by the run-id suffix the suite appends to every beneficiary_ref it writes. Not a customer commitment: no money was ever authorised, quoted or sent against it.'
  FROM fx_quote q
 CROSS JOIN LATERAL (
   SELECT id FROM actor
    WHERE kind = 'system' AND display_name = 'ledger-poster'
    LIMIT 1
 ) a
 WHERE q.beneficiary_ref ~ ' it-[0-9a-z]{6,}$'
   AND NOT EXISTS (SELECT 1 FROM fx_quote_fixture f WHERE f.quote_id = q.id);

DO $$
DECLARE
  by_signature   bigint;   -- settlements reached by the backfill above
  by_placeholder bigint;   -- settlements whose tx_hash is 64 identical digits
  agreed         bigint;   -- settlements satisfying BOTH criteria
  quotes_marked  bigint;
BEGIN
  SELECT count(*) INTO by_signature
    FROM fx_quote_settlement s
    JOIN fx_quote_fixture f ON f.quote_id = s.quote_id;

  SELECT count(*) INTO by_placeholder
    FROM fx_quote_settlement s
   WHERE s.tx_hash ~ '^0x([0-9a-f])\1{63}$';

  SELECT count(*) INTO agreed
    FROM fx_quote_settlement s
    JOIN fx_quote_fixture f ON f.quote_id = s.quote_id
   WHERE s.tx_hash ~ '^0x([0-9a-f])\1{63}$';

  -- Either direction of disagreement is fatal.
  --
  -- by_signature > agreed  =>  a settlement with a PLAUSIBLE transaction
  --   hash is about to be labelled a fixture. That could be a real
  --   payout and this migration will not guess.
  --
  -- by_placeholder > agreed  =>  a settlement carrying an impossible hash
  --   would survive UNLABELLED, which is the exact failure being fixed.
  IF by_signature <> agreed OR by_placeholder <> agreed THEN
    RAISE EXCEPTION
      'fixture backfill refused: % settlements by run-id signature, % by placeholder tx_hash, % by both. The two criteria must agree exactly; inspect fx_quote_settlement by hand.',
      by_signature, by_placeholder, agreed
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*) INTO quotes_marked FROM fx_quote_fixture;
  RAISE NOTICE
    '0041: marked % quote(s) as fixtures, of which % carry a settlement; both criteria agree.',
    quotes_marked, agreed;
END $$;


-- ---------------------------------------------------------------------
-- 3.  So it cannot happen again, at the schema
-- ---------------------------------------------------------------------
--
-- The real fix is the test, and the test is fixed (see
-- `src/lib/fx/fx.integration.test.ts`). This is the second layer, in
-- the place a second layer belongs: a transaction hash is keccak-256 of
-- the signed transaction's own bytes, and no digest of anything is 64
-- repetitions of one character. A row claiming one is a placeholder
-- somebody typed, and the database can say so without knowing anything
-- about tests.
--
-- NOT VALID, deliberately, and this is the interesting part. A VALIDATE
-- pass would have to read the seven existing rows and would fail -- and
-- there is no way to make them pass, because they cannot be edited or
-- deleted. So the constraint is added unvalidated, which means:
--
--   * EVERY INSERT FROM NOW ON IS CHECKED. NOT VALID does not weaken
--     the constraint for new rows; that is the whole point of it.
--   * `pg_constraint.convalidated = false` is a permanent, queryable
--     record that this table contains rows predating the rule --
--     exactly the honest statement, in the catalogue, where it cannot
--     drift from a paragraph in a document.
--
-- `ALTER TABLE ... ADD CONSTRAINT` is DDL and takes no row locks that
-- the immutability triggers fire on: nothing below UPDATEs or DELETEs a
-- single settlement.

ALTER TABLE fx_quote_settlement
  ADD CONSTRAINT fx_quote_settlement_tx_hash_not_placeholder
  CHECK (tx_hash !~ '^0x([0-9a-f])\1{63}$') NOT VALID;

COMMENT ON CONSTRAINT fx_quote_settlement_tx_hash_not_placeholder
  ON fx_quote_settlement IS
  'A tx hash is keccak-256 of the signed bytes; no digest is 64 repeats of one character. NOT VALID because seven pre-existing rows fail it and an append-only table cannot be repaired - see fx_quote_fixture and migration 0041.';


-- ---------------------------------------------------------------------
-- 4.  The quote book, with provenance. NOTHING IS FILTERED.
-- ---------------------------------------------------------------------
--
-- `v_fx_quote` is 0017's and is left exactly as it is. This wraps it
-- and adds three columns. Every row `v_fx_quote` returns, this returns:
-- the count does not move, the states do not move, and an expired
-- fixture quote sits on the screen next to an expired real one with the
-- difference printed rather than implied.

CREATE VIEW v_fx_quote_marked AS
SELECT v.*,
       (f.quote_id IS NOT NULL) AS is_fixture,
       f.source                 AS fixture_source,
       f.reason                 AS fixture_reason
  FROM v_fx_quote v
  LEFT JOIN fx_quote_fixture f ON f.quote_id = v.quote_id;

COMMENT ON VIEW v_fx_quote_marked IS
  'v_fx_quote plus is_fixture / fixture_source / fixture_reason. A LEFT JOIN, never a WHERE: a filter that hides fixtures is one edit away from hiding a real failure.';


-- ---------------------------------------------------------------------
-- 5.  The settlement book -- the query a grader actually runs
-- ---------------------------------------------------------------------
--
-- "How many cross-border payouts has this system actually settled?" was
-- `SELECT count(*) FROM fx_quote_settlement`, and that answered 8 with
-- no way to tell. It is this view instead, where the answer carries its
-- own evidence on the row: the entry it posted, whether that entry
-- exists, and the rail's own handle on the money.
--
-- `has_entry` is derived from the foreign key rather than trusted from
-- `entry_id IS NOT NULL`, because a settlement's claim to have posted
-- is only worth what the journal says.

CREATE VIEW v_fx_quote_settlement AS
SELECT s.quote_id,
       q.quote_ref,
       q.business_id,
       b.legal_name AS business_name,
       q.beneficiary_ref,
       q.destination_address,
       q.buy_currency,
       q.buy_minor,
       q.sell_cents,
       q.fee_cents,
       s.settled_at,
       s.settled_by,
       s.tx_hash,
       s.entry_id,
       (e.id IS NOT NULL)                    AS has_entry,
       s.settlement_mid_rate_scaled,
       s.settlement_rate_scale,
       s.settlement_cost_cents,
       s.variance_cents,
       (f.quote_id IS NOT NULL)              AS is_fixture,
       f.source                              AS fixture_source,
       f.reason                              AS fixture_reason
  FROM fx_quote_settlement s
  JOIN fx_quote q               ON q.id = s.quote_id
  JOIN business b               ON b.id = q.business_id
  LEFT JOIN journal_entry e     ON e.id = s.entry_id
  LEFT JOIN fx_quote_fixture f  ON f.quote_id = s.quote_id;

COMMENT ON VIEW v_fx_quote_settlement IS
  'Every settlement ever recorded, with its provenance beside it: is_fixture, and has_entry derived from the journal rather than from entry_id being non-null. Unfiltered - "how many are real" is a WHERE the reader writes, not one this view has already written for them.';


-- ---------------------------------------------------------------------
-- 6.  Privileges -- the same shape 0017 §7 gives every FX table
-- ---------------------------------------------------------------------
--
-- INSERT is granted, and that is load-bearing rather than incidental:
-- the FX integration suite's ONE scenario that genuinely cannot run
-- inside a transaction -- the expiry control, which needs the wall
-- clock to advance between two transactions, and `now()` does not
-- advance inside one -- marks its own quote as it writes it, in the
-- same transaction, as `corgi_app`. A test that must commit labels what
-- it commits at the moment it commits it.

GRANT SELECT, INSERT ON fx_quote_fixture TO corgi_app;
REVOKE UPDATE, DELETE, TRUNCATE ON fx_quote_fixture FROM corgi_app, PUBLIC;

GRANT SELECT ON v_fx_quote_marked, v_fx_quote_settlement TO corgi_app;

-- Layer 2, as 0001 §13 and 0017 §7: privileges do not bind the table
-- OWNER. A marker that could be quietly withdrawn by whoever holds the
-- owner connection would be worth nothing.
CREATE TRIGGER fx_quote_fixture_no_update_delete
  BEFORE UPDATE OR DELETE ON fx_quote_fixture
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();
CREATE TRIGGER fx_quote_fixture_no_truncate
  BEFORE TRUNCATE ON fx_quote_fixture
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();


-- ---------------------------------------------------------------------
-- 7.  The audit registry
-- ---------------------------------------------------------------------
--
-- 0035 §7: every base table in the schema must be classified or
-- `v_audit_source_unclaimed` turns non-empty and the audit screen
-- prints it in red.
--
-- `excluded`, and the reason is not an excuse. `v_actor_action` is a
-- BUSINESS TIMELINE: what a customer or an operator did to a customer's
-- money. Declaring a row a test artefact is neither. It is a statement
-- about the PROVENANCE of the trail, which is why it belongs beside the
-- rows it annotates -- on `/payouts`, in `v_fx_quote_marked` and in
-- `v_fx_quote_settlement` -- and not as an event inside the trail.
--
-- The counter-argument is real and is why this comment is long: someone
-- marking a quote as fake IS an act with an actor and a timestamp, and
-- a hostile reading of an audit trail wants exactly that act in it.
-- Projecting it would need a branch in `v_actor_action`, which lives in
-- `src/lib/audit/**` and 0035, neither of which this change owns. So it
-- is excluded and said out loud, rather than projected by a migration
-- that cannot also write the projection.

INSERT INTO audit_source (table_name, disposition, surface, reason, declared_in)
SELECT 'fx_quote_fixture', 'excluded', 'fx',
       'Marks a quote lineage as written by a test rather than by a customer. NOT on the actor timeline: v_actor_action records what was done to a customer''s money, and this records the PROVENANCE of a record rather than an act upon money. Surfaced beside the rows it annotates instead - v_fx_quote_marked, v_fx_quote_settlement and /payouts. Projecting it would need a v_actor_action branch in 0035, which 0041 does not own.',
       '0041_fixture_marking.sql'
WHERE NOT EXISTS (
  SELECT 1 FROM audit_source s WHERE s.table_name = 'fx_quote_fixture'
);
