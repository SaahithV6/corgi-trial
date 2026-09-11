-- =====================================================================
-- 0039  THE INBOUND RECALL: one row corrected, one claim withdrawn,
--       and one operator report.  No money table is touched.
-- =====================================================================
--
-- docs/GAUNTLET.md, written against commit 2f863c8, reported two inbound
-- ACH rows in `rail_event_semantics` as UNREACHABLE CODE:
--
--     ach / increase / inbound_ach_transfer.created           -> inbound_ach_credit
--     ach / increase / inbound_ach_transfer.updated/returned  -> inbound_ach_return
--
-- `increaseAchConsumer` parked every `inbound_ach_transfer` delivery on
-- `associated_object_type` BEFORE any semantics lookup ran, so neither
-- row could ever be consulted by anything.  The consumer now consults
-- them (see §4b of src/lib/webhooks/consumers/increase-ach.ts).  The
-- moment it did, one of the two turned out to be WRONG -- which is the
-- whole argument for not leaving a row unreachable.
--
-- ---------------------------------------------------------------------
-- 1.  THE MEASUREMENT
-- ---------------------------------------------------------------------
--
-- The outbound `ach_transfer` object and the inbound `inbound_ach_transfer`
-- object do not describe a return the same way.  MEASURED on the Increase
-- sandbox, 2026-09-11, end to end:
--
--   POST /simulations/inbound_ach_transfers
--        {account_number_id: sandbox_account_number_96mzhz3n61f5p0jpvytc,
--         amount: 250000, company_name: "ACME SUPPLY CO"}
--     -> 200  sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b
--             status "accepted", effective_date "2026-09-11",
--             trace_number "848154134534850", transfer_return null
--
--   POST /inbound_ach_transfers/{id}/transfer_return
--        {reason: "credit_entry_refused_by_receiver"}
--     -> 200  status "returned", and the ONLY new block on the object:
--
--             "transfer_return": {
--               "reason": "credit_entry_refused_by_receiver",
--               "returned_at": "2026-09-11T08:53:59Z",
--               "transaction_id": "sandbox_transaction_wqd6t4p2k5berabecln8"
--             }
--
-- There is NO `return` key and NO `created_at` inside it.  The seeded row
-- says `value_date_source = payload.return.created_at`, which is the
-- OUTBOUND object's shape, copied across by analogy and never measured --
-- because the only code that would have read it could not be reached.
-- `valueDateFromSource()` walks that path, finds nothing, returns null,
-- and the consumer parks: a recall that could never be dated could never
-- be acted on, even after the branch existed.
--
-- So the row is corrected here, and the correction is the cheap half of
-- the rule in docs/RAIL-SEMANTICS.md §5 ("Changing an existing row"):
-- a wrong row normally needs a correction pass over the entries it
-- mis-dated, and the hard half is that pass.  THERE IS NOTHING TO
-- CORRECT.  The row has dated zero postings, because it was unreachable
-- for its entire life:
--
--     SELECT count(*) FROM journal_entry
--      WHERE idempotency_key LIKE 'ach:inbound:%';   -- 0, measured 09:0xZ
--
-- ---------------------------------------------------------------------
-- 2.  THE CLAIM BEING WITHDRAWN
-- ---------------------------------------------------------------------
--
-- Both notes described a build that posts inbound credits to a customer's
-- 2100 leaf and opens a 9200 uncleared-credit hold.  THIS BUILD DOES NOT,
-- and cannot, and the reason is one measured fact:
--
--     GET /account_numbers  ->  exactly ONE object,
--     sandbox_account_number_96mzhz3n61f5p0jpvytc (7467448488 / 123308582),
--     on the program's own FBO account sandbox_account_zkfx1wcn4brwoaiyksj6
--
-- Six businesses share that one number.  An inbound ACH credit names
-- `account_number_id`, so the field that is supposed to say whose money it
-- is names the programme.  There is no `account_number -> business` table
-- in this schema and no path that issues per-customer numbers, so an
-- inbound credit CANNOT be attributed and is refused -- requirement 4,
-- unchanged and deliberate.
--
-- The notes are rewritten to describe the build that exists.  The
-- `canonical_kind` and `semantics` columns are NOT touched: the
-- classification was right both times.  A credit is a new event at its
-- effective date; a recall is a new event at its own date.  What was
-- wrong was one field name and two sentences of scope.
--
-- WHY THIS IS A MIGRATION RATHER THAN AN EDIT TO scripts/seed.mjs.
-- Precedent: 0025_wires.sql inserted eight `rail_event_semantics` rows
-- directly, with its measurements in the notes, and the live table has
-- carried 30 rows against the seed file's 22 ever since.  This follows
-- that path and widens the same gap by zero rows.  THE SEED FILE IS STILL
-- THE SOURCE OF TRUTH AND IS NOW ONE FIELD BEHIND: the follow-up, for
-- whoever owns it, is one string in `RAIL_EVENT_SEMANTICS` and one in
-- `EXPECTED` in src/lib/rails/semantics.test.ts.  Stated here rather than
-- left to be discovered, because a divergence nobody wrote down is how a
-- re-seed silently reverts a measured fix.
--
-- NO INVARIANT IS ADDED.  The obvious candidates -- "no entry exists under
-- an ach:inbound: key", "no recall is booked without a credit" -- are both
-- guards over states no code on this build can produce, and a guard that
-- cannot fail is the same species of dead weight as the row this migration
-- exists to make honest.  §3 adds a REPORT instead, and says so in its
-- own comment so nobody wires it into scripts/dbcheck.mjs expecting zero.
--
-- NOTHING IN THIS FILE TOUCHES journal_entry, journal_line, hold OR
-- account.  It rewrites two rows of reference data and creates one view.


-- ---------------------------------------------------------------------
-- 1.  The corrected row: where a recall's value date is READ FROM
-- ---------------------------------------------------------------------

UPDATE rail_event_semantics
   SET value_date_source = 'payload.transfer_return.returned_at',
       note = 'THE RECALL OF AN INBOUND CREDIT, and on this build its ledger consequence is nothing. MEASURED 2026-09-11 on sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b: returning an inbound ACH adds ONE block, transfer_return {reason, returned_at, transaction_id}, and the object carries no `return` key at all -- the outbound ach_transfer shape (return.created_at) does not apply here, and this row shipped naming it because nothing could reach the row to find out. Still a NEW EVENT at its own date: the credit really did arrive on the effective date and really did go back on the returned_at date, so a recall never rewrites the arrival day. What it does NOT do here is reverse a posting, because this build issues no virtual account numbers, cannot attribute an inbound credit to a customer, and therefore never booked one -- there is no entry to reverse and no 9200 hold to close. The consumer records the recall, reports the value date from this field, and RESOLVES the parked arrival delivery, because the money has gone back and there is no longer anything for an operator to attribute.'
 WHERE provider = 'increase'
   AND provider_event_type = 'inbound_ach_transfer.updated/returned';


-- ---------------------------------------------------------------------
-- 2.  The withdrawn claim: what an inbound credit actually does here
-- ---------------------------------------------------------------------

UPDATE rail_event_semantics
   SET note = 'Someone is sending money to the programme''s FBO account number, effective on the date the originator chose -- a NEW EVENT at payload.effective_date, which is right and is why this column is unchanged. WHAT THIS BUILD DOES WITH IT IS NOTHING, and the earlier note overstated it: there is no debit of 1130, no credit of a 2100 leaf and no 9200 hold, because there is nobody to credit. MEASURED 2026-09-11: GET /account_numbers returns exactly one account_number (sandbox_account_number_96mzhz3n61f5p0jpvytc), on the programme''s own FBO account, shared by all six businesses on this book; no account_number -> business mapping exists in this schema and no path issues per-customer numbers. So the object''s account_number_id identifies the programme, not a customer, and posting would mean guessing whose money it is. The delivery PARKS on inbound_ach_account_mapping -- bounded, then a dead letter in front of a human -- and an operator either attributes it by hand or returns it to the originator. This note describes the build that exists; when per-customer account numbers are issued, the posting rule in the first sentence of the old note is the right one to write.'
 WHERE provider = 'increase'
   AND provider_event_type = 'inbound_ach_transfer.created';


-- ---------------------------------------------------------------------
-- 3.  The operator report.  A REPORT, NOT AN INVARIANT.
-- ---------------------------------------------------------------------
--
-- This view is EXPECTED TO HAVE ROWS.  Every row is money that genuinely
-- arrived in the FBO account and that this build correctly refused to
-- attribute; an empty result means nobody has sent us an unattributable
-- credit, not that everything is fine.  Do NOT add it to
-- scripts/dbcheck.mjs, which asserts emptiness.
--
-- It reads `webhook_inbox` only -- the inbox is the record of what
-- arrived, and since nothing is posted there is nothing in the ledger for
-- an aging report to range over.  That is itself the point the view
-- makes: the exposure is real, it is dateable, and until now it existed
-- only inside a `parked_reason` string.
--
-- `recalled` is the column that matters operationally: an arrival whose
-- delivery is still parked is a live question for a human, and one whose
-- sibling delivery reported a recall is a question that answered itself.

CREATE OR REPLACE VIEW v_inbound_ach_unattributed AS
SELECT w.parked_on_ref                                   AS inbound_transfer_id,
       min(w.received_at)                                AS first_seen_at,
       max(w.received_at)                                AS last_seen_at,
       (CURRENT_DATE - min(w.received_at)::date)         AS age_days,
       count(*)::int                                     AS deliveries,
       count(*) FILTER (WHERE w.state = 'parked')::int   AS still_parked,
       count(*) FILTER (WHERE w.state = 'dead')::int     AS dead_lettered,
       count(*) FILTER (WHERE w.state = 'done')::int     AS resolved,
       -- A recall resolves the delivery rather than parking it, so a
       -- transfer with a resolved delivery and none still parked is one
       -- whose money has gone back to the originator.
       (count(*) FILTER (WHERE w.state = 'done') > 0
        AND count(*) FILTER (WHERE w.state = 'parked') = 0) AS recalled,
       max(w.parked_reason)                              AS last_reason
  FROM webhook_inbox w
 WHERE w.provider = 'increase'
   AND w.parked_on_kind = 'inbound_ach_account_mapping'
 GROUP BY w.parked_on_ref;

COMMENT ON VIEW v_inbound_ach_unattributed IS
  'REPORT, NOT AN INVARIANT -- rows are expected. Inbound ACH credits that reached the programme FBO account and that this build refused to attribute, because it issues no per-customer account numbers (measured 2026-09-11: GET /account_numbers returns one object, shared by every business). One row per inbound transfer, with age and whether the question has since answered itself by the credit being recalled. Do not add to scripts/dbcheck.mjs.';

GRANT SELECT ON v_inbound_ach_unattributed TO corgi_app;
