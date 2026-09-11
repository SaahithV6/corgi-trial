-- ---------------------------------------------------------------------
-- 0018.  The one money table with no append-only trigger.
-- ---------------------------------------------------------------------
--
-- `scripts/compliance.mjs` walks all 35 money tables and asserts each has
-- both `_no_update_delete` and `_no_truncate`. Thirty-four do.
-- `kyb_verification_leg` — added in 0005, extended in 0013 to carry a
-- reviewer, a reason and the `manual` evidence label — has neither.
--
-- WHY IT MATTERS EVEN THOUGH THE REVOKE HOLDS. `corgi_app` cannot express
-- UPDATE on this table and `has_table_privilege` proves it, so the
-- application cannot mutate a verification leg today. But the privilege
-- layer does not bind the TABLE OWNER, and the whole point of the trigger
-- layer — stated in 0001 — is to catch "a future migration, or a human in
-- psql, running as the owner". A KYB decision is exactly the row someone
-- would be tempted to fix by hand at 3am: an operator approved the wrong
-- business, and the smallest-looking repair is an UPDATE.
--
-- It is also the table that decides whether a business may transact, so a
-- silently edited row here is a silently changed answer to "was this
-- business verified, by whom, and on what evidence". Corrections are
-- appends — a later leg supersedes an earlier one, which is how the view
-- already reads it.

CREATE TRIGGER kyb_verification_leg_no_update_delete
  BEFORE UPDATE OR DELETE ON kyb_verification_leg
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER kyb_verification_leg_no_truncate
  BEFORE TRUNCATE ON kyb_verification_leg
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();
