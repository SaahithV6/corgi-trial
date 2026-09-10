-- ---------------------------------------------------------------------
-- 0011.  The closure that was wrong, and the invariant that could not
--        see it.
-- ---------------------------------------------------------------------
--
-- WHAT THIS FIXES, measured in the live database on 2026-09-10:
--
--   3 holds carry a `hold_closure` row reading "authorisation fully
--   reversed" whose authorisation was never reversed.  Their event sets
--   are {clearing 3000, authorization 5000}: A = 5000, C = 3000, so the
--   model says 2000 is still authorised, and the memo book agrees --
--   `memo_balance_cents` is 2000 on all three.  Only the closure row
--   disagrees, and `v_hold_state.is_released` reads the closure row
--   first, so `active_hold_cents` is 0 and the customer may spend money
--   that is still authorised.  $60.00, three businesses, right now.
--
-- WHERE THEY CAME FROM.  They are residue of a bug that is already
-- fixed.  `origin = 'clearing_first'` on all three: the settlement beat
-- its authorisation, which makes A = 0 transiently, which satisfies the
-- `A <= 0` closure arm, and an earlier build wrote the append-only
-- closure row on the strength of it.  `HoldState.terminallyClosed` and
-- its `sawAuthorisation` guard exist precisely because of that bug, and
-- scenario 5 in holds.integration.test.ts asserts zero closures for this
-- exact pair of arrival orders.  The code has not written one since.
--
-- But `hold_closure` is APPEND-ONLY.  Fixing the writer does not unwrite
-- what it wrote, and there is no DELETE -- not for these rows, not for
-- any row, not by the migration role either.  A wrong entry in an
-- immutable table is corrected the same way a wrong journal entry is:
-- you append its reversal.  That is what `hold_closure_reversal` is, and
-- it is the same shape as `reverseAndRebook` for money.
--
-- THE PART WORTH READING TWICE.  `v_hold_drift` -- the invariant whose
-- entire job is "the memo book agrees with the fold over card events" --
-- is defined `WHERE NOT hs.is_released AND memo <> target`.  A spurious
-- closure row sets `is_released` TRUE.  So the invariant excluded, by
-- construction, exactly the rows the bug produced, and reported zero
-- while $60 sat freed.  It has been reporting zero all along and it was
-- telling the truth about a set that did not contain the bug.
--
-- The complement is the missing half and it is one line:
--
--     a RELEASED hold must not still be withholding memo money.
--
-- `v_hold_release_drift` below.  Between the two views every hold row is
-- covered: released ones must be flat, live ones must equal the fold.
--
-- WHAT THIS DELIBERATELY DOES NOT DO.  It does not add a `C >= A` arm to
-- `closed(E)` to make the over-capture attack write a closure row.  The
-- arm is arithmetically a no-op -- `GREATEST(A - C, 0)` is already 0
-- when C >= A -- so its only effect would be to write a PERMANENT
-- closure row on a condition a later incremental authorisation can undo.
-- That is the same mistake as the one being corrected above, and this
-- migration exists because we have measured what it costs.

-- ---------------------------------------------------------------------
-- 1.  The compensating append
-- ---------------------------------------------------------------------
--
-- PRIMARY KEY (hold_id) and a foreign key to hold_closure: a closure can
-- be reversed at most once, and only a closure that exists can be
-- reversed.  Both facts stay in the table, so the audit trail reads
-- "closed at T1 for reason R, reversed at T2 for reason R'" rather than
-- losing T1 the way a DELETE would.

CREATE TABLE hold_closure_reversal (
  hold_id     uuid PRIMARY KEY REFERENCES hold_closure(hold_id),
  reason      text NOT NULL,
  actor_id    uuid NOT NULL REFERENCES actor(id),
  reversed_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE hold_closure_reversal IS
  'Reverses a hold_closure row that should never have been written. Append-only, like everything else; the closure row stays where it is.';

CREATE TRIGGER hold_closure_reversal_no_update_delete
  BEFORE UPDATE OR DELETE ON hold_closure_reversal
  FOR EACH ROW EXECUTE FUNCTION ledger_row_is_immutable();

CREATE TRIGGER hold_closure_reversal_no_truncate
  BEFORE TRUNCATE ON hold_closure_reversal
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_row_is_immutable();

GRANT SELECT, INSERT ON hold_closure_reversal TO corgi_app;

-- ---------------------------------------------------------------------
-- 2.  The release predicate learns about it
-- ---------------------------------------------------------------------
--
-- Same column list and same types, so every dependent view -- and
-- v_available_balance is one -- survives the replace untouched.

CREATE OR REPLACE VIEW v_hold_state AS
SELECT h.id                AS hold_id,
       h.account_id,
       h.memo_account_id,
       h.kind,
       h.external_ref,
       h.value_date,
       h.expires_at,
       h.available_at,
       COALESCE(m.memo_balance_cents, 0) AS memo_balance_cents,
       r.is_released,
       CASE WHEN r.is_released THEN 0::bigint
            ELSE COALESCE(m.memo_balance_cents, 0)
       END AS active_hold_cents
  FROM hold h
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0) AS memo_balance_cents
      FROM journal_entry e
      JOIN journal_line  l ON l.entry_id = e.id
      JOIN account       a ON a.id = l.account_id
     WHERE e.hold_id = h.id
       AND l.account_id = h.memo_account_id
  ) m ON true
  CROSS JOIN LATERAL (
    SELECT (
      (EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = h.id)
       AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal hr WHERE hr.hold_id = h.id))
      OR (h.kind = 'card_auth'
          AND COALESCE((SELECT ch.is_closed FROM v_card_auth_hold ch WHERE ch.hold_id = h.id), false))
      OR (h.kind = 'uncleared_credit' AND now() >= h.available_at)
    ) AS is_released
  ) r;

-- ---------------------------------------------------------------------
-- 3.  The other half of the invariant
-- ---------------------------------------------------------------------
--
-- A released hold must be FLAT: whatever it was withholding has been
-- given back in the memo book.  Anything else means availability and the
-- memo book disagree about the same hold, which is the shape of every
-- over-release bug there is.
--
-- Note what is NOT asserted: that a released hold's model target is 0.
-- An operator may close a hold the fold still considers open -- that is
-- what closeHold() is FOR, and holds.integration.test.ts scenario 7
-- leaves four such rows behind on purpose.  The operator overrides the
-- model; the operator does not get to leave money withheld.  So the
-- money claim is the invariant and the model claim is not.

CREATE VIEW v_hold_release_drift AS
SELECT hs.hold_id,
       hs.account_id,
       hs.kind,
       hs.memo_balance_cents,
       hc.reason  AS closure_reason,
       hc.closed_at
  FROM v_hold_state hs
  LEFT JOIN hold_closure hc ON hc.hold_id = hs.hold_id
 WHERE hs.is_released
   AND hs.memo_balance_cents <> 0;

GRANT SELECT ON v_hold_release_drift TO corgi_app;
