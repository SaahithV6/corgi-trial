-- =====================================================================
-- 0054  The FX commitment watermark is append-only, like everything else
-- =====================================================================
--
-- A SECOND FILE RATHER THAN AN EDIT, because 0053 is applied and
-- `scripts/migrate.mjs` refuses a file whose contents changed after it
-- ran ("A migration is immutable once applied. Write a new one.").  This
-- is that one.
--
-- ---------------------------------------------------------------------
-- WHAT 0053 LEFT OPEN
-- ---------------------------------------------------------------------
--
-- `fx_commitment_regime.effective_from` decides the POPULATION of
-- `v_fx_commitment_unheld`: the guard ranges over acceptances at or after
-- that instant, and the 35 that predate it are outside by construction
-- and counted in `v_fx_commitment_census`.  That is the honest scope of a
-- control that started existing on a particular day.
--
-- It is also, unguarded, a dial that turns the invariant off.  Move
-- `effective_from` to `now()` and every commitment already standing
-- leaves the guard's population; move it forward each morning and the
-- view is empty for ever while an acceptance places no hold at all.  The
-- view would go green and stay green, and nothing would have been
-- repaired.
--
-- `corgi_app` cannot do it - the role holds SELECT on that table and
-- nothing else, so the running application cannot express the UPDATE -
-- and that is layer 1 working.  Layer 2 is missing: 0001 SS13's whole
-- argument is that privileges do not bind the table OWNER, so a future
-- migration, or a human in psql, sails past the REVOKE.  Every other
-- table in this schema whose contents decide a number carries
-- `ledger_row_is_immutable()` for exactly that reason.  This one did not.
--
-- ---------------------------------------------------------------------
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------
--
-- The row becomes unwritable after the fact.  It does NOT become
-- unreadable, and the regime does not become unchangeable: if the scope
-- of this guard ever should move - because the population genuinely
-- changed, not because somebody wanted a green tick - the honest way is
-- what it is everywhere else in this book, a new row in a new table with
-- a migration saying why.  `singleton boolean PRIMARY KEY CHECK
-- (singleton)` already makes a second row in THIS table
-- unrepresentable, so the two constraints compose into "this instant is
-- decided once, by the migration that created the control".

CREATE TRIGGER fx_commitment_regime_no_update_delete
  BEFORE UPDATE OR DELETE ON fx_commitment_regime
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER fx_commitment_regime_no_truncate
  BEFORE TRUNCATE ON fx_commitment_regime
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

-- Redundant after the absent GRANT, and written anyway: it is the line a
-- reviewer greps for, the same reason 0017 SS7 writes its REVOKE out.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON fx_commitment_regime FROM corgi_app, PUBLIC;

COMMENT ON TABLE fx_commitment_regime IS
  'When the FX commitment hold started existing. One row, decided by migration '
  '0053 and made unwritable by 0054 - because this instant decides the '
  'population of v_fx_commitment_unheld, and a watermark that can be moved '
  'forward is an invariant that can be switched off.';

-- The claim, checked at apply time rather than asserted in a comment.
-- `ledger_row_is_immutable()` raises 55006 unconditionally, so the UPDATE
-- below must fail; if it ever succeeds this migration stops rather than
-- recording that a guard is armed when it is not.
DO $$
BEGIN
  BEGIN
    UPDATE fx_commitment_regime SET effective_from = effective_from;
    RAISE EXCEPTION
      'fx_commitment_regime accepted an UPDATE from the table owner - the immutability trigger is not armed';
  EXCEPTION WHEN sqlstate '55006' THEN
    RAISE NOTICE 'fx_commitment_regime refuses an UPDATE from its own owner (55006), as intended';
  END;
END $$;
