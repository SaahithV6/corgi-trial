-- =====================================================================
-- 0025  WIRES — the rail that cannot be taken back
-- =====================================================================
--
-- A wire is not an ACH transfer with a different label, and everything
-- in this file is one of the four places they differ.
--
--   1. FINALITY.  A Fedwire funds transfer is final on receipt.  There is
--      no return window, no R-code table, and no recall as of right.
--      ACH's entire design in this schema -- the uncleared-credit hold,
--      funds_availability_policy, rail_event_semantics classifying a
--      return as a new event -- exists because an ACH entry can come
--      back.  A wire cannot.
--   2. VALUE DATE.  Fedwire is real-time gross settlement.  The value
--      date IS the day the message is accepted; there is no T+1.
--   3. IDENTIFIERS.  A wire is addressed by the WIRE variant of the ABA,
--      not the ACH one, and carries an IMAD -- the Fedwire Input Message
--      Accountability Data -- which is the network's own name for the
--      payment and the join key for everything downstream.
--   4. APPROVAL.  Section 2.
--
-- NOTHING HERE CHANGES AN EXISTING RAIL.  Every statement is either an
-- INSERT of new reference data keyed on a rail nothing else uses, or a
-- read-only view.  No existing row is touched, no existing object is
-- replaced, no enum is widened -- `rail` has carried 'wire' since 0001.
--
-- WHAT WAS MEASURED, AND WHEN.  Every claim about Increase in this file
-- was produced by a real call against sandbox.increase.com on
-- 2026-09-11 with the trial's own credential.  The calls, the status
-- codes and the resulting object ids are in docs/WIRES.md §1.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1.  Funds availability: immediate, and the 09:00 that made it not
-- ---------------------------------------------------------------------
--
-- The seeded row for wire (2026-01-01) already says 0 banking days.
-- That is the right number and it is not sufficient, because
-- `funds_availability_policy` has a SECOND clock column:
--
--     release_local_time  time NOT NULL DEFAULT '09:00'
--
-- and 09:00 is an ACH-shaped default.  It is correct for ACH because an
-- ACH hold is measured in whole banking days and the release therefore
-- lands at the start of a business morning.  On a zero-day policy it is
-- not a rounding detail, it is a hold:
--
--     scheduleAvailability({bankingDaysHold: 0, releaseLocalTime: '09:00'},
--                          '2026-09-11')
--         -> available_at = 2026-09-11 09:00 America/New_York
--
-- Fedwire's operating day opens at 21:00 ET on the PRECEDING calendar
-- day and closes at 18:00 ET.  A wire received at 08:00 ET is an
-- ordinary wire, and under the 09:00 row it would be withheld for an
-- hour -- from a customer, on a rail that cannot be reversed, for no
-- risk that exists.  Whether the hold binds would depend on what time
-- of day the money arrived, which is the definition of an accident.
--
-- So this is an effective-dated supersession, which is the mechanism
-- this table was built for: append a new version, never edit the old
-- one, and every hold created before today still cites the row it was
-- created under and is still explainable.
--
-- WITH THIS ROW IN FORCE, IMMEDIATE AVAILABILITY IS ARITHMETIC AND NOT A
-- BRANCH.  addBankingDays(d, 0) = d, bankingInstant(d, '00:00') is
-- midnight ET on the credit's own value date, and the value date of a
-- wire is the day it arrived.  So available_at is ALWAYS in the past at
-- the moment the credit is booked, and `ledger_availability`'s existing
-- release predicate --
--
--     OR (held.kind = 'uncleared_credit' AND p_as_of >= held.available_at)
--
-- -- releases the hold at the same instant the ledger entry that created
-- it commits.  src/lib/rails/wire/ledger.ts writes the SAME hold row
-- and the SAME memo posting as the ACH funding path, and there is no
-- wire-shaped `if` anywhere in it: the rail's availability behaviour is
-- entirely in this row.
--
-- ONE THING DID NOT FALL OUT, AND IT IS WORTH THE PARAGRAPH.  A hold
-- that is released the instant it is created has no LATER for the ACH
-- availability sweeper to run in, and `v_hold_release_drift` (0011
-- sec 3) requires a released hold to be flat in the memo book -- a
-- second, different definition of "released" from the clock one above,
-- and a correct one, because it is what catches over-release bugs.  So
-- the wire credit path closes the hold and posts the reversing memo
-- entry in its own transaction, which is what the sweeper would have
-- done a day later on ACH.  The predicate that decides is
-- `availableAt <= arrival`, which names no rail and would fire for a
-- zero-day policy on any of them.  Found by `node scripts/dbcheck.mjs`
-- going to 21/22 on the first wire ever booked, which is the argument
-- for having the invariant.
--
-- counterparty_class stays 'n/a' and that is deliberate.  The ACH
-- classes -- self / known / new -- exist to price RETURN RISK, and they
-- can only price it because a return is possible.  Grading wire
-- counterparties into risk bands would imply the bands buy something.
-- They buy nothing: the money is already gone and already ours.

INSERT INTO funds_availability_policy
  (rail, counterparty_class, effective_from, banking_days_hold,
   release_local_time, confirmations, note)
VALUES
  ('wire', 'n/a', DATE '2026-09-11', 0, TIME '00:00:00', NULL,
   'Immediate, and immediate at every hour of the Fedwire day. A wire is final on receipt: there is no return window to survive, so a hold buys nothing and costs the customer the use of their own settled money. Supersedes the 2026-01-01 row, which said the same 0 banking days but kept the ACH-shaped 09:00 release time -- and on a zero-day policy that is not a rounding detail, it withholds every wire that arrives before 09:00 ET, which on a rail whose operating day opens at 21:00 ET the night before is an ordinary arrival. Midnight ET on the value date is the only release time under which "0 banking days" means what it says.')
ON CONFLICT (rail, counterparty_class, effective_from) DO NOTHING;


-- ---------------------------------------------------------------------
-- 2.  The approval threshold: $0, two approvers, and the argument
-- ---------------------------------------------------------------------
--
-- The numbers do not change.  The reasoning does, and `note` is the only
-- place the reasoning sits next to the numbers where a reviewer -- or an
-- approver reading the policy version cited on the instruction they are
-- being asked to sign -- will actually meet it.  An effective-dated
-- append is the only way this table can carry a revised rationale, so
-- that is what this is.
--
-- WHY $0, WHEN ACH IS $2,500.
--
-- ACH's threshold is not a statement about size.  Its own note says so:
-- "an ACH entry is recallable for two banking days, which bounds the
-- damage".  $2,500 is the price of the band BELOW which an unattended
-- agent may act, and that band exists only because a mistake inside it
-- is recoverable by a mechanism that exists.  A wire has no such
-- mechanism at any amount, so there is no amount at which the band can
-- be drawn.  The threshold is $0 because the recoverability it would be
-- measuring is $0.
--
-- The disputes rail reached the same conclusion from the same premise
-- and landed on $50 rather than $0 (0019 §6), and the difference is
-- worth stating because it is the load-bearing half.  When
-- recoverability is zero the threshold stops pricing loss and starts
-- pricing REVIEW: what does a second human cost, and how often is the
-- bill paid.  Provisional credits are frequent, small and mechanical,
-- so the review has to be worth having, and $50 is where it becomes so.
-- Wires are the opposite on all three counts.  A business current
-- account originates a handful a month, each already carrying a
-- $25-$35 network fee that has priced micro-wires out of existence.  The
-- review is paid for a handful of times a month and buys the only
-- control this rail has.  Break-even sits below the smallest wire
-- anybody sends, so the honest threshold is the floor.
--
-- WHY TWO APPROVERS, WHEN USDC -- ALSO IRREVERSIBLE -- TAKES ONE.
--
-- Not "more money, more caution".  The two rails fail differently.
--
--   USDC       the failure is a MALFORMED destination: a mistyped or
--              swapped address.  That is a closed question, arithmetic
--              catches it (EIP-55), and a second human adds very little
--              to a checksum.
--   WIRE       the failure is business email compromise: a
--              WELL-FORMED instruction.  Real beneficiary name, real
--              bank, valid ABA, sent from a real employee's real
--              mailbox.  Nothing about it is wrong on its face and no
--              amount of validation will find it.
--
-- The only control that has ever worked against BEC is out-of-band
-- confirmation by a second person who was not in the email thread.  Two
-- DISTINCT human approvers is that control, expressed in the one place
-- the database can enforce it -- assert_maker_checker() already refuses
-- a second decision by the same actor and refuses any agent at all.
-- `required_approvals = 2` is therefore specific to the attack this
-- rail carries, not a dial turned up.
--
-- WHAT THIS TABLE CANNOT SAY, STATED RATHER THAN WORKED AROUND.
-- One (threshold, required_approvals) pair is one band.  ACH gets two
-- bands out of it because its threshold does the splitting: below
-- $2,500, zero approvers.  Wire, with the threshold at the floor, has
-- one band and no way to express "two approvers above $250,000, one
-- below".  A ladder would need a second column or a second row per
-- rail, and that is a schema change this migration deliberately does
-- not make -- it is written down in docs/WIRES.md §5 as the week-two
-- item instead.

INSERT INTO approval_policy
  (rail, effective_from, threshold_cents, required_approvals, note)
VALUES
  ('wire', DATE '2026-09-11', 0, 2,
   'Every wire, at any amount, needs two distinct human approvers -- and the threshold is $0 for a different reason than "wires are big". ACH''s $2,500 buys the band below which an unattended agent may act, and that band exists only because an ACH entry is recallable for two banking days; the threshold prices recoverability, not size. A Fedwire funds transfer is final on receipt at every amount, so there is no amount at which the band can be drawn and the floor is the honest answer. Where recoverability is zero the threshold prices the REVIEW instead, which is how the disputes rail reached $50 for provisional credit: frequent, small, mechanical, so the review must be cheap to be worth having. Wires are rare, large and already carry a $25-$35 network fee, so break-even sits below the smallest wire anyone sends. Two approvers rather than one -- unlike USDC, also irreversible -- because the rails fail differently: a USDC payout fails on a MALFORMED address, which a checksum catches, while a wire fails on a WELL-FORMED instruction from a compromised mailbox, which nothing but a second human outside the email thread has ever caught.')
ON CONFLICT (rail, effective_from) DO NOTHING;


-- ---------------------------------------------------------------------
-- 3.  Rail event semantics: correction, or new event?
-- ---------------------------------------------------------------------
--
-- 0001 §5b: get one of these rows backwards and every past statement it
-- touches is silently corrupted while all five invariants keep passing.
-- So one row per provider event, each with the reasoning on it.
--
-- The key is `<event category>/<nested step>`, matching the convention
-- `semanticsKey()` and the existing Increase ACH rows already use --
-- Increase fires ONE `wire_transfer.updated` for submission, completion,
-- cancellation and reversal alike, with the step in the object's
-- `status`, so the whole lifecycle would collapse into one ungovernable
-- row if the key were the category alone.
--
-- EVERY WIRE ROW IS `new_event`, AND THAT IS THE FINDING, NOT A DEFAULT.
--
-- `correction` means the original posting was a FALSE STATEMENT about
-- its own value date.  A card clearing reversal is one: the clearing
-- should never have posted at that amount, so Tuesday must be made
-- whole.  Nothing a wire does is ever that, because a wire settles
-- exactly once, for exactly the instructed amount, on the day the Fed
-- accepted the message -- there is no later fact that can make the
-- original day's posting untrue.
--
-- Including the reversal.  ESPECIALLY the reversal.  MEASURED on
-- 2026-09-11: POST /simulations/wire_transfers/{id}/reverse returned a
-- `reversal` object with `class_name: "inbound_wire_reversal"`, its OWN
-- IMAD (20260911apvdjfqt599399, different from the original's
-- 20260911sgzamiaa787670), its OWN transaction id, and
-- `return_reason_code: null`.  Increase has that field; the network did
-- not fill it, because unlike ACH there is no wire return-code table to
-- fill it from.  What came back is a SECOND PAYMENT, sent by the
-- beneficiary's bank at its own discretion, that happens to reference
-- the first.  The original wire really did settle, really was final,
-- and its value date is still true.  So: its own value date, from its
-- own timestamp.
--
-- value_date_source names the field the value date is READ FROM, and
-- for a wire that field is never a settlement timestamp, because there
-- isn't one.  See §4.

INSERT INTO rail_event_semantics
  (rail, provider, provider_event_type, canonical_kind, semantics,
   value_date_source, note)
VALUES
  ('wire', 'increase', 'wire_transfer.created',
   'wire_originated', 'new_event', 'payload.created_at',
   'The instruction exists and nothing has been put on a wire: measured status pending_creating, submission null. Booked as its own event on the day it was raised. Nothing about the money has happened yet, which is why the ledger consequence of this row is nothing.'),

  ('wire', 'increase', 'wire_transfer.updated/submitted',
   'wire_submitted', 'new_event', 'payload.submission.submitted_at',
   'Handed to Fedwire, IMAD issued, and on this rail that is a transient status rather than a resting one -- measured, the object went pending_creating -> complete inside one simulated submit. Recorded as a new event at its own submission time.'),

  ('wire', 'increase', 'wire_transfer.updated/complete',
   'wire_settled', 'new_event', 'payload.submission.submitted_at',
   'THE SETTLEMENT, and it reads its value date from the SUBMISSION timestamp because a wire has no settlement object to read one from. Fedwire is real-time gross settlement: acceptance of the message IS the transfer of funds. This is the exact mirror of the Increase ACH trap -- there, status stays `submitted` and a `settlement.settled_at` appears, so submitted+settled_at must be promoted to settled; here, status becomes `complete` and no settlement object ever appears, so submission.submitted_at IS the settlement time. An adapter that waited for a settlement field on a wire would wait forever.'),

  ('wire', 'increase', 'wire_transfer.updated/reversed',
   'wire_return_of_funds', 'new_event', 'payload.reversal.created_at',
   'NOT a correction, and not a return either. Measured: the reversal carries class_name inbound_wire_reversal, its own IMAD, its own transaction id and a null return_reason_code -- it is a SECOND PAYMENT the beneficiary''s bank chose to send back, not an unwinding of ours. The original wire settled, was final, and its value date stays true; the money coming back is a new receipt on the day it came back. Taking the original''s value date would make the ledger claim the payment never happened on the day it provably did.'),

  ('wire', 'increase', 'wire_transfer.updated/canceled',
   'wire_canceled', 'new_event', 'payload.cancellation.canceled_at',
   'Cancelled BEFORE submission -- the only window in which a wire can be stopped at all, and it closes the moment the Fed accepts the message. No money moved, so there is nothing to correct and nothing to reverse.'),

  ('wire', 'increase', 'wire_transfer.updated/rejected',
   'wire_rejected', 'new_event', 'payload.created_at',
   'Refused before it left: Increase declined to submit. No IMAD was ever issued and no money was put on a wire, so this is a new event about an instruction, never a correction of a payment.'),

  ('wire', 'increase', 'inbound_wire_transfer.created',
   'inbound_wire_credit', 'new_event', 'payload.acceptance.accepted_at',
   'THE INBOUND LEG, and its value date is the acceptance instant because that is when the money became ours. Measured: acceptance.accepted_at equals created_at exactly -- an inbound wire has no pending stage. Compare inbound_ach_transfer.created, which dates from payload.effective_date because an inbound ACH credit is a promise about a future settlement day. This row is where "available immediately" comes from: there is no gap between arrival and value.'),

  ('wire', 'increase', 'inbound_wire_transfer.updated/reversed',
   'inbound_wire_returned', 'new_event', 'payload.reversal.reversed_at',
   'We sent it back. Measured: POST /inbound_wire_transfers/{id}/reverse is a PRODUCTION API method, not a simulation, and it took reason=creditor_request -- the creditor being us. So this is not the network recalling a payment, it is this bank ORIGINATING a wire in the other direction, and it dates from the day we did it. The customer''s balance goes down on the day the funds left, not on the day they arrived; the arrival really happened and the statement for that day must keep saying so.')
ON CONFLICT (provider, provider_event_type) DO UPDATE
  SET rail              = EXCLUDED.rail,
      canonical_kind    = EXCLUDED.canonical_kind,
      semantics         = EXCLUDED.semantics,
      value_date_source = EXCLUDED.value_date_source,
      note              = EXCLUDED.note;


-- ---------------------------------------------------------------------
-- 4.  The proof that availability is immediate, as a view that must be
--     empty
-- ---------------------------------------------------------------------
--
-- Claiming "ledger and available move together on this rail" in a README
-- is worth nothing.  This is the claim as a query, in the shape 0022
-- established for v_balance_definition_drift: a view whose rows are
-- VIOLATIONS, so healthy means zero rows and nobody has to remember to
-- interpret a number.
--
-- One row per uncleared-credit hold created by a wire credit whose
-- availability was NOT already in the past when the credit was booked.
-- `booking_time` is the ledger's own learning clock -- the instant the
-- entry committed -- so this compares the moment the money appeared
-- against the moment it became spendable, which is exactly the question.
--
-- A row here means one of three things, all of them real bugs and none
-- of them fixable by editing a number:
--
--   * somebody seeded or superseded the wire funds_availability_policy
--     with a non-zero banking_days_hold or a release time later than
--     midnight;
--   * the wire credit path started choosing a policy row for a
--     different rail;
--   * a wire credit was booked with a value date later than the day it
--     arrived, which would mean the value date is being invented rather
--     than read off the acceptance.
--
-- NOTHING REPAIRS WHAT THIS REPORTS.  It is an invariant, like the other
-- drift views: append a correcting entry, never an UPDATE.

-- THE EARLIEST MEMO ENTRY, and only that one.  A wire credit writes
-- TWO memo entries in one transaction -- the hold, then its release --
-- because a hold whose release moment has already passed has no later
-- sweep to close it and `v_hold_release_drift` (0011 sec 3) requires a
-- released hold to be flat in the memo book.  A plain join would return
-- one row per memo entry and count every wire twice, so the opening
-- entry is picked by `booking_seq`, which is commit order and is total.

CREATE OR REPLACE VIEW v_wire_availability_drift AS
SELECT h.id                                   AS hold_id,
       h.account_id,
       h.external_ref,
       h.value_date,
       h.available_at,
       e.booking_time                         AS credited_at,
       e.booking_seq,
       p.id                                   AS policy_id,
       p.banking_days_hold,
       p.release_local_time,
       -- How long the money was NOT spendable for. Positive means a
       -- hold that bound; it is the whole content of a row here.
       (h.available_at - e.booking_time)      AS withheld_for
  FROM hold h
  JOIN LATERAL (
    SELECT je.booking_time, je.booking_seq
      FROM journal_entry je
     WHERE je.hold_id = h.id
       AND je.book = 'memo'
       AND je.rail = 'wire'
     ORDER BY je.booking_seq
     LIMIT 1
  ) e ON true
  LEFT JOIN funds_availability_policy p ON p.id = h.policy_id
 WHERE h.kind = 'uncleared_credit'
   AND h.available_at > e.booking_time;


-- The companion, and the one a human actually reads: every wire credit
-- with the three numbers side by side.  Not an invariant -- a receipt.
--
-- `held_cents` is what `ledger_availability` would subtract for this
-- hold RIGHT NOW, computed with that function's own release predicate
-- rather than a second copy of it, so this view cannot develop its own
-- opinion about what "released" means.  On this rail it is 0 at every
-- instant a query could observe, and the demo is to run this straight
-- after booking a wire and read the zero.

CREATE OR REPLACE VIEW v_wire_credit AS
SELECT h.id                                   AS hold_id,
       h.account_id,
       h.external_ref,
       h.value_date,
       e.booking_time                         AS credited_at,
       h.available_at,
       -- The credit itself: the customer-facing leg of the financial
       -- entry that shares this hold's external_ref.
       (SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint
          FROM journal_entry fe
          JOIN journal_line  l ON l.entry_id = fe.id
          JOIN account       a ON a.id = l.account_id
         WHERE fe.book = 'financial'
           AND fe.rail = 'wire'
           AND fe.external_ref = h.external_ref
           AND l.account_id = h.account_id)   AS credited_cents,
       -- What the hold withholds at this instant, under the same
       -- predicate ledger_availability uses.  Two independent reasons
       -- for the zero, and both hold on this rail: the clock has passed,
       -- AND the memo book was squared by the release entry.
       CASE WHEN now() >= h.available_at THEN 0::bigint
            ELSE (SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint
                    FROM journal_entry me
                    JOIN journal_line  l ON l.entry_id = me.id
                    JOIN account       a ON a.id = l.account_id
                   WHERE me.hold_id = h.id
                     AND l.account_id = h.memo_account_id)
       END                                    AS held_cents,
       p.banking_days_hold,
       p.release_local_time,
       p.note                                 AS policy_note
  FROM hold h
  JOIN LATERAL (
    SELECT je.booking_time
      FROM journal_entry je
     WHERE je.hold_id = h.id
       AND je.book = 'memo'
       AND je.rail = 'wire'
     ORDER BY je.booking_seq
     LIMIT 1
  ) e ON true
  LEFT JOIN funds_availability_policy p ON p.id = h.policy_id
 WHERE h.kind = 'uncleared_credit';


-- ---------------------------------------------------------------------
-- 5.  Grants.  Reads only -- there is nothing new here to write.
-- ---------------------------------------------------------------------
--
-- The application already holds INSERT on hold, journal_entry (through
-- ledger_append) and SELECT on funds_availability_policy,
-- approval_policy and rail_event_semantics from 0001.  The wire rail
-- adds no table and therefore needs no new write privilege -- which is
-- the point of a rail being an adapter: it moved money without the
-- schema learning a new noun.

GRANT SELECT ON v_wire_availability_drift TO corgi_app;
GRANT SELECT ON v_wire_credit             TO corgi_app;
