-- =====================================================================
-- 0042  A VIRTUAL ACCOUNT NUMBER PER BUSINESS: the missing FACT that
--       makes an inbound credit attributable.  No money row is touched.
-- =====================================================================
--
-- ---------------------------------------------------------------------
-- 1.  THE GAP, AS IT WAS MEASURED
-- ---------------------------------------------------------------------
--
-- `docs/GAUNTLET.md` item 5 is half an item.  An outbound ACH payment
-- bounced for real -- a $6,000.00 R01 on
-- sandbox_ach_transfer_x5vdo5m7b6k924sszlms -- and the corrected position
-- landed on the day the return happened.  The INBOUND half booked
-- nothing, and the reason was not a bug in the consumer:
--
--     GET https://sandbox.increase.com/account_numbers   (2026-09-11)
--       -> EXACTLY ONE object
--          sandbox_account_number_96mzhz3n61f5p0jpvytc
--          account_number 7467448488  routing_number 123308582
--          name "primary"  on the programme's own FBO account
--          sandbox_account_zkfx1wcn4brwoaiyksj6
--
-- One number, shared by every business on this book.  An inbound ACH
-- credit names `account_number_id`, so the field that is supposed to say
-- WHOSE MONEY IT IS named the programme.  The consumer refused to guess
-- and parked, which was right, and `db/migrations/0039_inbound_recall.sql`
-- withdrew the two `rail_event_semantics` notes that described a build
-- which could attribute one.  Nothing could be posted, so a recall had
-- nothing to correct, so the sentence the brief actually asks for --
-- "the corrected position appears on the day it happened" -- was never
-- demonstrated on the inbound leg and was not claimed.
--
-- ---------------------------------------------------------------------
-- 2.  WHAT THIS MIGRATION ADDS, AND WHY IT IS A TABLE
-- ---------------------------------------------------------------------
--
-- `POST /account_numbers` issues a SECOND, THIRD, Nth account number on
-- the same Increase account, each with its own `account_number` and its
-- own id, and inbound ACH and inbound wires addressed to it arrive
-- naming THAT id.  MEASURED, 2026-09-11:
--
--     POST /account_numbers
--          {account_id: sandbox_account_zkfx1wcn4brwoaiyksj6,
--           name: "Ridgeline Robotics, Inc.",
--           inbound_ach: {debit_status: "blocked"}}
--       -> 200  sandbox_account_number_bh5spt0xmebnj6xq6t3l
--               account_number 3164662367  routing_number 123308582
--               status "active"  idempotency_key echoed back
--
-- So the provider will tell us which number was addressed.  What it
-- cannot tell us is whose number it is: THAT is ours to record, and it is
-- a FACT, not a derivation.  There is no rule that turns an account
-- number into a business -- no prefix, no checksum, no ordering -- and
-- any code that appeared to do so would be a heuristic that silently
-- mis-attributes somebody's money the first time the provider changes how
-- it allocates digits.  A fact gets stored once, by the operator action
-- that created it, and read back for ever.  Hence a table.
--
-- ---------------------------------------------------------------------
-- 3.  WHY THE TABLE REFUSES UPDATE AND DELETE
-- ---------------------------------------------------------------------
--
-- `journal_entry` is append-only because rewriting history is a lie about
-- money.  This table is append-only for a sharper reason: an UPDATE of
-- `business_id` would silently re-point every future credit addressed to
-- that number at a DIFFERENT CUSTOMER, and every past park would read as
-- though it had always meant the new one.  There is no correcting entry
-- that could make that visible, because the mis-attribution would be in
-- the lookup rather than in the book.
--
-- So the guard refuses both, in those words, and `corgi_app` is granted
-- SELECT AND NOTHING ELSE.  The application -- the webhook consumer that
-- reads this to decide whose money arrived -- physically cannot write it;
-- issuing a number is an operator action taken with the owner credential
-- through scripts/provision-account-numbers.mjs, against the provider
-- first and this table second.
--
-- ---------------------------------------------------------------------
-- 4.  WHAT IT DELIBERATELY DOES NOT STORE
-- ---------------------------------------------------------------------
--
-- No account id of ours.  `business_id` is the fact; which leaf of the
-- chart a credit lands on is the LEDGER's question and is answered by
-- `mainDepositAccountId()`, the one reader that knows a pot sub-account
-- (`2100.<uuid>`) is not the spendable leaf.  A second copy of that
-- answer here would be a second opinion about where money goes.
--
-- No provider status.  The row is never updated, so a mirrored `status`
-- column would rot the first time a number was deactivated at Increase
-- and would be believed anyway.  The provider is the authority on whether
-- a number is live; this table is the authority on whose it is.
--
-- No balance, no amount, no money of any kind.  Nothing in this file
-- touches journal_entry, journal_line, hold or account.

-- ---------------------------------------------------------------------
-- 5.  The table
-- ---------------------------------------------------------------------

CREATE TABLE virtual_account_number (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The rail vendor that issued it. Not `rail`: one provider issues
  -- numbers that receive ACH, wires and checks alike, and the number does
  -- not know which rail will address it.
  provider                    text        NOT NULL,

  -- The provider's id for the number. THIS is the field an inbound
  -- credit names (`inbound_ach_transfer.account_number_id`), and it is
  -- the join key the consumer looks up.
  provider_account_number_id  text        NOT NULL,

  -- The account at the provider the number hangs off -- our FBO account.
  -- Recorded so an operator can see that every customer number sits on
  -- the one omnibus account, which is what a virtual number IS.
  provider_account_id         text        NOT NULL,

  -- The digits a customer would put on an invoice. Stored because an
  -- inbound payment that never arrives is investigated by these, not by
  -- the provider's opaque id, and a support conversation that cannot
  -- quote them is a support conversation that goes nowhere.
  routing_number              text        NOT NULL CHECK (routing_number ~ '^[0-9]{9}$'),
  account_number              text        NOT NULL CHECK (account_number ~ '^[0-9]{4,17}$'),

  -- WHOSE IT IS. The whole point of the table.
  business_id                 uuid        NOT NULL REFERENCES business(id),

  -- The name we asked the provider to label it with, echoed back. Kept so
  -- a mismatch between the label at Increase and the business on this
  -- book is visible rather than inferred.
  name                        text        NOT NULL,

  -- The provider's own creation instant, and ours. Two clocks, because
  -- "when did this number start existing on the rail" and "when did this
  -- book learn whose it was" are different questions and the gap between
  -- them is an operational fact.
  provider_created_at         timestamptz NOT NULL,
  recorded_at                 timestamptz NOT NULL DEFAULT now(),

  -- The number is the customer's identity on the rail: one number, one
  -- business, for ever.
  UNIQUE (provider, provider_account_number_id),
  -- And the digits themselves, which is what an originator actually
  -- types. Two rows claiming one routing/account pair would be two
  -- answers to the same question.
  UNIQUE (provider, routing_number, account_number)
);

-- One ACTIVE number per business, per provider.
--
-- Not because attribution needs it -- attribution reads number -> business
-- and is unambiguous with a hundred numbers per business -- but because
-- "the business's account number", singular, is what a screen, an invoice
-- and a support call all say. A build that wants per-invoice numbers
-- drops this index and keeps everything else.
CREATE UNIQUE INDEX virtual_account_number_one_per_business
  ON virtual_account_number (provider, business_id);

COMMENT ON TABLE virtual_account_number IS
  'Which business owns which virtual account number at a payment provider. The missing FACT that makes an inbound credit attributable: an inbound ACH or wire names account_number_id, and nothing about that id derives a customer, so the mapping is recorded once by the operator action that created the number and read for ever after. Append-only: an UPDATE here would silently re-point somebody else''s money.';

COMMENT ON COLUMN virtual_account_number.provider_account_number_id IS
  'The provider''s id for the number -- the exact string an inbound credit carries in account_number_id. The consumer''s lookup key.';
COMMENT ON COLUMN virtual_account_number.business_id IS
  'Whose number it is. Never inferred, never defaulted: a credit naming a number with no row here PARKS, because guessing whose money it is is the one failure this build refuses.';

-- ---------------------------------------------------------------------
-- 6.  The guard: append-only, and loud about why
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION virtual_account_number_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'virtual_account_number is append-only: DELETE refused. Deleting the row that says whose account number this is would make every past attribution unexplainable and every future credit to that number unattributable, silently. A number that should no longer be used is blocked or cancelled AT THE PROVIDER, which is the authority on whether it is live.';
  END IF;
  RAISE EXCEPTION
    'virtual_account_number is append-only: UPDATE refused (row %). Re-pointing an account number at a different business would redirect every future credit addressed to it, and would make every park and every posting already made under it read as though it had always meant the new owner. There is no correcting journal entry for a lie told by a lookup.',
    OLD.id;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER virtual_account_number_append_only
  BEFORE UPDATE OR DELETE ON virtual_account_number
  FOR EACH ROW EXECUTE FUNCTION virtual_account_number_guard();

-- SELECT and nothing else. The consumer reads this to decide whose money
-- arrived; it must not be able to decide the answer.
GRANT SELECT ON virtual_account_number TO corgi_app;

-- ---------------------------------------------------------------------
-- 7.  The two inbound `rail_event_semantics` notes, brought up to date
-- ---------------------------------------------------------------------
--
-- 0039 rewrote both notes to describe a build that could not attribute an
-- inbound credit, and was right to: that was the build. This migration
-- changes what is true, so the notes change with it. `canonical_kind`,
-- `semantics` and `value_date_source` are NOT touched -- all three were
-- right before and are right now, and `payload.transfer_return.returned_at`
-- is the field 0039 measured. The notes are prose about scope; the three
-- deciding columns are the classification, and nothing here re-dates a
-- posting. `ach:inbound:%` carried ZERO entries when this ran, so the
-- cheap case in docs/RAIL-SEMANTICS.md §5 still applies.

UPDATE rail_event_semantics
   SET note = 'Someone is sending money to a virtual account number on the programme''s FBO account, effective on the date the originator chose -- a NEW EVENT at payload.effective_date. Since db/migrations/0042_virtual_account_numbers.sql the receiver is knowable: the object names account_number_id, virtual_account_number maps that id to exactly one business, and the consumer books DR 1110 (the cash is at the sponsor bank the moment Increase accepts it) / CR that business''s 2100 leaf, then opens an uncleared_credit hold under the ach/new funds-availability policy -- two banking days -- so the LEDGER balance moves and the AVAILABLE balance does not. That is the ACH half of the availability contrast: an inbound wire is final on receipt and its hold is born released, an inbound ACH can still be pulled back by the originator and its hold binds. A credit naming a number with NO row in virtual_account_number still PARKS, unchanged and deliberate: the refusal is the point, and an attribution path with a default account would destroy it.'
 WHERE provider = 'increase'
   AND provider_event_type = 'inbound_ach_transfer.created';

UPDATE rail_event_semantics
   SET note = 'THE RECALL OF AN INBOUND CREDIT. MEASURED 2026-09-11 on sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b: returning an inbound ACH adds ONE block, transfer_return {reason, returned_at, transaction_id}, and the object carries no `return` key at all -- the outbound ach_transfer shape (return.created_at) does not apply here, which is why this row''s value_date_source names transfer_return.returned_at. A NEW EVENT at its own date, never a correction: the credit really did arrive on the effective date and really did go back on the returned_at date, so a recall never rewrites the arrival day and the arrival day''s statement still shows the money that was there. Since 0042 the consumer books it: DR the business''s 2100 leaf / CR 1110 at the recall''s own value date, and it CLOSES the uncleared_credit hold the arrival opened in the same transaction -- a hold left standing against a credit that has gone back would withhold the money twice. A recall of a credit this book never attributed still books nothing, because there is nothing to correct, and it resolves the parked arrival delivery instead of leaving an operator pointed at money that has already left.'
 WHERE provider = 'increase'
   AND provider_event_type = 'inbound_ach_transfer.updated/returned';

-- ---------------------------------------------------------------------
-- 8.  The operator views.  REPORTS, NOT INVARIANTS.
-- ---------------------------------------------------------------------
--
-- Neither of these belongs in scripts/dbcheck.mjs, which asserts
-- emptiness. Rows are expected in both, and an empty result means
-- something different from "healthy" in each case.

-- Who has a number, and who does not.
--
-- A business with no 2100 deposit leaf CANNOT be given one -- there would
-- be nowhere for the money to land -- and that is a state, not a fault.
CREATE VIEW v_virtual_account_number_coverage AS
SELECT b.id                                     AS business_id,
       b.legal_name,
       v.provider,
       v.provider_account_number_id,
       v.routing_number,
       v.account_number,
       v.recorded_at,
       (d.id IS NOT NULL)                       AS has_deposit_account,
       (v.id IS NOT NULL)                       AS has_account_number,
       CASE
         WHEN v.id IS NOT NULL           THEN 'attributable'
         WHEN d.id IS NULL               THEN 'no deposit account — nothing to attribute to'
         ELSE                                 'no account number issued — inbound credits would park'
       END                                      AS coverage
  FROM business b
  LEFT JOIN account d
         ON d.business_id = b.id
        AND d.code = '2100'
        AND d.closed_at IS NULL
  LEFT JOIN virtual_account_number v
         ON v.business_id = b.id;

COMMENT ON VIEW v_virtual_account_number_coverage IS
  'REPORT, NOT AN INVARIANT. One row per business: whether it has a deposit leaf, whether it has a virtual account number, and therefore whether an inbound credit addressed to it could be attributed at all. Rows with coverage <> ''attributable'' are expected; they are the population an operator would work through, not a failure.';

-- Inbound ACH credits that reached the FBO account, and what became of
-- them. 0039's version of this view is replaced rather than extended,
-- because its `recalled` column was defined as "a delivery finished and
-- none is still parked" -- true when the only way an inbound delivery
-- could finish was a recall, and a LIE the moment a credit can be
-- attributed and posted. The replacement asks the ledger instead of
-- inferring from the inbox.
DROP VIEW IF EXISTS v_inbound_ach_unattributed;

CREATE VIEW v_inbound_ach_unattributed AS
WITH deliveries AS (
  SELECT w.parked_on_ref                                  AS inbound_transfer_id,
         min(w.received_at)                               AS first_seen_at,
         max(w.received_at)                               AS last_seen_at,
         (CURRENT_DATE - min(w.received_at)::date)        AS age_days,
         count(*)::int                                    AS deliveries,
         count(*) FILTER (WHERE w.state = 'parked')::int  AS still_parked,
         count(*) FILTER (WHERE w.state = 'dead')::int    AS dead_lettered,
         count(*) FILTER (WHERE w.state = 'done')::int    AS resolved,
         max(w.parked_reason)                             AS last_reason
    FROM webhook_inbox w
   WHERE w.provider = 'increase'
     AND w.parked_on_kind = 'inbound_ach_account_mapping'
   GROUP BY w.parked_on_ref
)
SELECT d.inbound_transfer_id,
       d.first_seen_at,
       d.last_seen_at,
       d.age_days,
       d.deliveries,
       d.still_parked,
       d.dead_lettered,
       d.resolved,
       -- Booked, or not, read off the ledger's own idempotency key rather
       -- than guessed from the inbox's state machine.
       credit.id                                          AS credit_entry_id,
       recall.id                                          AS recall_entry_id,
       (credit.id IS NOT NULL)                            AS attributed,
       (recall.id IS NOT NULL)                            AS recalled,
       d.last_reason
  FROM deliveries d
  LEFT JOIN journal_entry credit
         ON credit.idempotency_key = 'ach:inbound:' || d.inbound_transfer_id
  LEFT JOIN journal_entry recall
         ON recall.idempotency_key LIKE 'ach:inbound:recall:' || d.inbound_transfer_id || ':%';

COMMENT ON VIEW v_inbound_ach_unattributed IS
  'REPORT, NOT AN INVARIANT -- rows are expected. Every inbound ACH transfer whose delivery has ever parked on inbound_ach_account_mapping, with what has since become of it: attributed (a credit entry exists), recalled (a recall entry exists), or still parked, in which case it is real money in the FBO account that this build refused to guess the owner of. `attributed` and `recalled` are read from journal_entry idempotency keys, never inferred from the inbox state. Do not add to scripts/dbcheck.mjs.';

GRANT SELECT ON v_virtual_account_number_coverage TO corgi_app;
GRANT SELECT ON v_inbound_ach_unattributed TO corgi_app;
