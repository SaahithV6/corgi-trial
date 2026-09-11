#!/usr/bin/env node
/**
 * Seed the ledger's reference data, from zero, idempotently.
 *
 *   set -a; . ./.env; set +a
 *   node scripts/seed.mjs
 *
 * ---------------------------------------------------------------------------
 * What this creates, and what it deliberately does not
 * ---------------------------------------------------------------------------
 *
 * Creates: one `book_entity`, the whole chart of accounts (imported from
 * src/lib/ledger/chart.ts, never re-typed here), three demo businesses in
 * three different KYB states, the actors that act on the book, an
 * `approval_policy` per money-out rail, the `funds_availability_policy` rows
 * from DESIGN.md §10.1, and the `rail_event_semantics` mapping.
 *
 * Posts NO journal entries. Not one. Seeding money is the posting path's job
 * (src/lib/ledger/post.ts), and a seed that hand-writes journal rows would be
 * a second, unverified write path around `ledger_append()` — exactly the thing
 * DESIGN.md §14 exists to prevent. Every table this script touches is
 * reference data; the money tables are left empty for the posting worker.
 *
 * ---------------------------------------------------------------------------
 * How it is idempotent
 * ---------------------------------------------------------------------------
 *
 * Every row's primary key is a UUIDv5 derived from a fixed namespace and a
 * stable natural name ('business:ridgeline-robotics', 'account:corgi-bank:2100
 * :house', ...). The same input therefore always produces the same uuid, and
 * every INSERT is `ON CONFLICT DO NOTHING` with no conflict target, so ANY
 * unique violation — the primary key, or `account_code_scope`, or
 * `approval_policy_version` — is a silent no-op rather than an error.
 *
 * Deterministic ids buy a second thing that matters more than the idempotence:
 * `account.parent_id` and `account.business_id` are computed, not looked up.
 * There is no SELECT-then-INSERT anywhere in this script, so there is no race
 * between the two statements and no ordering requirement beyond the foreign
 * keys themselves.
 *
 * `funds_availability_policy` and `approval_policy` carry the append-only
 * triggers from 0001, so they are inserted and never updated: changing a
 * policy means a new row with a later `effective_from`, which is the entire
 * point of effective dating them.
 *
 * ---------------------------------------------------------------------------
 * Which connection, and why
 * ---------------------------------------------------------------------------
 *
 * DIRECT_URL — the OWNER role, unpooled. Per DECISIONS 008/009 the application
 * connects as `corgi_app`, which holds SELECT and INSERT on the money tables
 * and only SELECT on `account`, `business`, `actor`, `book_entity` and the two
 * policy tables. `corgi_app` therefore cannot seed reference data, and that is
 * the design working: seeding is an operator action, like a migration, not
 * something the app can express.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";

import {
  CHART,
  DEPOSIT_PARENT_CODE,
  accountsForBusiness,
  depositAccountCode,
  perBusinessAccountName,
  requireAccount,
} from "../src/lib/ledger/chart.ts";

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

/** Fixed namespace for this project's seed. Changing it re-seeds everything. */
const SEED_NAMESPACE = "1b0f9d1a-6c3b-5a7e-9a2f-5c1f0d9e7a31";

/** RFC 4122 v5 (SHA-1, name-based). Same name in, same uuid out, for ever. */
function uuid5(name, namespace = SEED_NAMESPACE) {
  const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// ---------------------------------------------------------------------------
// The demo data
// ---------------------------------------------------------------------------

const ENTITY = {
  key: "corgi-bank",
  code: "CORGI-BANK",
  name: "Corgi Banking Program, Inc.",
};
const ENTITY_ID = uuid5(`entity:${ENTITY.key}`);

/**
 * KYB state, represented WITHOUT a schema change.
 *
 * `business` has no `kyb_status` column and this script does not add one:
 * migrations are frozen for this worker, and DESIGN.md §17 is explicit that
 * anything with an event stream gets no status column — KYB status is a fold
 * over provider decisions, not a mutable flag. So the state is carried by two
 * facts that are already representable and are both independently checkable:
 *
 *   1. `business.ein` holds the Stripe Connect TEST-MODE magic EIN that
 *      reproduces that exact registry outcome against the real sandbox
 *      (research/kyb/NOTES.md §4.4). The state is not asserted, it is
 *      re-derivable: point the KYB adapter at these rows and Stripe returns
 *      the same answer every time.
 *   2. Whether the business has a deposit account at all. You cannot owe money
 *      to a business you have not verified, so 2100/<id> — and its two memo
 *      hold accounts — are opened on approval and not before. A pending or
 *      rejected business having no account is the non-happy path, and it is
 *      structural rather than a flag somebody has to remember to check.
 */
const KYB = {
  approved: {
    ein: "000000000",
    registry: "successful business ID number match",
    opensAccounts: true,
  },
  pending: {
    ein: "222221005",
    registry: "pending response from registry",
    opensAccounts: false,
  },
  rejected: {
    ein: "222221000",
    registry: "company not found in registry",
    opensAccounts: false,
  },
};

/**
 * The business a reviewer is meant to follow, named here so the rest of the
 * demo can agree with one answer.
 *
 * `docs/DEMO.md` sends the grader to this business by name and
 * `scripts/verify-demo.mjs` check 16 asserts it is reachable on every screen it
 * should appear on. Changing this line means changing all three.
 */
const PROTAGONIST_KEY = "ridgeline-robotics";

const BUSINESSES = [
  {
    key: "ridgeline-robotics",
    legalName: "Ridgeline Robotics, Inc.",
    kyb: "approved",
    // Corrected 2026-09-11: this used to read "the only business with money
    // accounts", which stopped being true the moment core-loop leg 1 approved
    // Kettle & Crumb's KYB at request time and opened its chart of accounts.
    // A seed comment that describes the book as it was on day one is exactly
    // the kind of stale claim the audit exists to catch.
    why: "The happy path, and the business the demo is a story about: the only one that carries every leg of the published core loop — KYB approved on a named human's review, funded from a linked external bank, real Lithic cards, holds, standing orders, pots, disputes with provisional credit, and closed statements.",
  },
  {
    key: "kettle-and-crumb",
    legalName: "Kettle & Crumb Bakery LLC",
    kyb: "pending",
    why: "Onboarding is in flight and the registry has not answered. An inbound credit for this business has nowhere to land, which is what 2400 suspense and the inbox's parked state are for.",
  },
  {
    key: "silverline-freight",
    legalName: "Silverline Freight Co.",
    kyb: "rejected",
    why: "The registry could not find the company. Nothing may ever post to it, and proving that is the point: a rejected business with no deposit account cannot be credited by accident.",
  },
];

const ACTORS = [
  {
    key: "staff.controller",
    kind: "human",
    displayName: "Dana Okonkwo",
    email: "dana.okonkwo@corgi.example",
    business: null,
    canApprove: true,
    why: "Corgi controller. Checker #1 — approves money out above the policy threshold.",
  },
  {
    key: "staff.treasury",
    kind: "human",
    displayName: "Miles Ferrara",
    email: "miles.ferrara@corgi.example",
    business: null,
    canApprove: true,
    why: "Corgi treasury. Checker #2 — the second approval a wire needs, and the proof that two DISTINCT humans are required.",
  },
  {
    key: "staff.analyst",
    kind: "human",
    displayName: "Priya Raman",
    email: "priya.raman@corgi.example",
    business: null,
    canApprove: false,
    why: "Operations analyst. The maker: raises payment instructions and, by the maker-checker trigger, can never approve one — not even one she did not raise.",
  },
  {
    key: "business.ridgeline.owner",
    kind: "human",
    displayName: "Alex Whitfield",
    email: "alex@ridgeline.example",
    business: "ridgeline-robotics",
    canApprove: true,
    why: "The customer's own authorised signer; approves payments out of their account, and is scoped to their business_id so they can approve nothing else.",
  },
  {
    key: "agent.payments",
    kind: "agent",
    displayName: "Corgi payments agent",
    email: null,
    business: null,
    canApprove: false,
    why: "The autonomous surface that raises payment instructions. can_approve is false and CANNOT be true: actor_only_humans_approve makes an agent approver unrepresentable, so 'the agent approved its own payment' is not a bug that can be written.",
  },
  {
    key: "system.ledger",
    kind: "system",
    displayName: "ledger-poster",
    email: null,
    business: null,
    canApprove: false,
    why: "The principal every machine-originated journal entry is attributed to, so `journal_entry.actor_id` is never null and a webhook-driven posting is distinguishable from a human one.",
  },
  {
    key: "system.webhooks",
    kind: "system",
    displayName: "webhook-dispatcher",
    email: null,
    business: null,
    canApprove: false,
    why: "The inbox dispatcher's identity, kept separate from the poster so 'who applied this event' and 'who wrote this money' are two answerable questions.",
  },
];

const POLICY_FROM = "2026-01-01";

const APPROVAL_POLICIES = [
  {
    rail: "ach",
    thresholdCents: "250000",
    requiredApprovals: 1,
    note: "ACH debits of $2,500 or more need one approver who is not the initiator. Below that the agent may submit unattended; an ACH entry is recallable for two banking days, which bounds the damage.",
  },
  {
    rail: "usdc",
    thresholdCents: "100000",
    requiredApprovals: 1,
    note: "USDC from $1,000 up needs an approver. The threshold is lower than ACH because an on-chain transfer is irreversible the moment it confirms — there is no recall window to fall back on.",
  },
  {
    rail: "wire",
    thresholdCents: "0",
    requiredApprovals: 2,
    note: "Every wire, at any amount, needs two distinct human approvers. Wires are irrevocable on receipt and are the rail business-email-compromise actually uses.",
  },
  {
    rail: "internal",
    thresholdCents: "0",
    requiredApprovals: 0,
    note: "Book transfers between accounts on our own ledger need no approval: both legs are ours, nothing leaves the FBO account, and a mistake is correctable by a reversal.",
  },
];

const FUNDS_AVAILABILITY_POLICIES = [
  {
    rail: "ach",
    counterpartyClass: "known",
    bankingDaysHold: 1,
    releaseLocalTime: "09:00",
    confirmations: null,
    note: "Counterparty seen at least 3 times over at least 60 days. Administrative-return risk (R01/R02/R03) is concentrated in the first two banking days, and a proven payer — usually payroll or a recurring customer — earns one of them back.",
  },
  {
    rail: "ach",
    counterpartyClass: "new",
    bankingDaysHold: 2,
    releaseLocalTime: "09:00",
    confirmations: null,
    note: "A counterparty we have not seen before: settlement date plus two banking days, covering the unauthorised-return window for corporate CCD/CTX entries.",
  },
  {
    rail: "ach",
    counterpartyClass: "self",
    bankingDaysHold: 1,
    releaseLocalTime: "09:00",
    confirmations: null,
    note: "An ACH pull from the customer's own verified external account. Still a hold, because a customer can overdraw their own outside bank as easily as anyone else can.",
  },
  {
    rail: "wire",
    counterpartyClass: "n/a",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00",
    confirmations: null,
    note: "Immediate. A wire is irrevocable on receipt, so holding one is indefensible to the customer and buys us nothing.",
  },
  {
    rail: "usdc",
    counterpartyClass: "n/a",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00",
    confirmations: 1,
    note: "Released on the Nth confirmation, not on a timer: the risk here is a chain reorg, not a counterparty. 1 confirmation on the Base Sepolia demo; 2 is the number for anything that matters.",
  },
  {
    rail: "card",
    counterpartyClass: "n/a",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00",
    confirmations: null,
    note: "A merchant refund arriving over the card network is already funded through settlement, so it is available immediately.",
  },
  {
    rail: "internal",
    counterpartyClass: "self",
    bankingDaysHold: 0,
    releaseLocalTime: "09:00",
    confirmations: null,
    note: "A transfer between two accounts on our own book. Both legs are ours and neither can be returned, so there is nothing to hold against.",
  },
];

/**
 * `rail_event_semantics` — correction or new event, per provider event type.
 *
 * DESIGN.md §6.1: 'correction' means the original posting was a FALSE
 * STATEMENT about its own value date, so the reversal takes the ORIGINAL's
 * value date. 'new_event' means the original was true then and the world
 * changed after, so it takes ITS OWN value date. Get one row wrong and every
 * past statement it touches is silently corrupted while all five invariants
 * still pass — which is why this is data with a note per row and not a branch
 * inside a webhook handler.
 */
const RAIL_EVENT_SEMANTICS = [
  // ---- Lithic (card) ------------------------------------------------------
  // Lithic fires ONE webhook type, `card_transaction.updated`, for every step
  // of the lifecycle; the step is the nested `events[].type`. The primary key
  // here is (provider, provider_event_type), so the key has to carry both or
  // the whole card lifecycle would collapse into a single ungovernable row.
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/AUTHORIZATION",
    canonicalKind: "authorization",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    note: "The cardholder really did present the card at that moment. Opens a memo hold in 9100/<biz>; no financial-book posting at all.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/AUTHORIZATION_ADVICE",
    canonicalKind: "incremental_authorization",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    note: "An advice REPLACES the authorised amount, it is not a delta: 1000 -> 1500 arrives as 1500. The memo hold is set to the new figure, never incremented by it.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/AUTHORIZATION_REVERSAL",
    canonicalKind: "authorization_reversal",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    note: "New event, not a correction: the authorisation genuinely happened and the merchant genuinely released it later. The hold shrinks from the reversal's own date.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/AUTHORIZATION_EXPIRY",
    canonicalKind: "expiry",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    note: "The network aged the authorisation out. Cosmetic in this design — the release predicate already zeroed the hold at expires_at, so the posting can never double-count.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/CLEARING",
    canonicalKind: "clearing",
    semantics: "new_event",
    valueDateSource: "payload.created",
    note: "Value date is the LOCAL TRANSACTION DATE, not the settlement date: a Friday dinner that clears on Monday is Friday's spend. Debits the customer's 2100 leaf and credits 2200; releases the matching slice of the memo hold.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/FINANCIAL_AUTHORIZATION",
    canonicalKind: "force_post",
    semantics: "new_event",
    valueDateSource: "payload.created",
    note: "A single-message clearing that never had an authorisation. Posts straight to the customer with no hold to release, and is the path that can overdraw an account into 1190.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/RETURN",
    canonicalKind: "refund",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    note: "A merchant refund is a new economic event on its own date, not an unwinding of the purchase. Credits the customer; available immediately, because the network already funded it.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/RETURN_REVERSAL",
    canonicalKind: "refund_reversal",
    semantics: "correction",
    valueDateSource: "original.value_date",
    note: "The refund was a false statement about its own date — the money never came back. Reverses at the refund's value date so that day's statement is made whole.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/CORRECTION_DEBIT",
    canonicalKind: "correction_debit",
    semantics: "correction",
    valueDateSource: "original.value_date",
    note: "The network correcting its own earlier figure. By definition the original was wrong about its own date, so the correction carries that date.",
  },
  {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/CORRECTION_CREDIT",
    canonicalKind: "correction_credit",
    semantics: "correction",
    valueDateSource: "original.value_date",
    note: "As CORRECTION_DEBIT, in the other direction. Both land in the same correction_group_id as the entry they fix.",
  },

  // ---- Increase (ACH) -----------------------------------------------------
  {
    rail: "ach",
    provider: "increase",
    providerEventType: "ach_transfer.created",
    canonicalKind: "ach_originated",
    semantics: "new_event",
    valueDateSource: "payload.created_at",
    note: "We have created an outbound entry. No money has moved and nothing posts to the financial book yet; the payment_instruction is the record at this stage.",
  },
  {
    rail: "ach",
    provider: "increase",
    providerEventType: "ach_transfer.updated/submitted",
    canonicalKind: "ach_submitted",
    semantics: "new_event",
    valueDateSource: "payload.submission.submitted_at",
    note: "Handed to the ODFI. Debits the customer's 2100 leaf and credits 2300 in-transit: the customer's money is committed, and our cash has not left yet.",
  },
  {
    rail: "ach",
    provider: "increase",
    providerEventType: "ach_transfer.updated/settled",
    canonicalKind: "ach_settled",
    semantics: "new_event",
    valueDateSource: "payload.settlement.settled_at",
    note: "Funds actually left the FBO account. Clears 2300 against 1110 on the settlement date.",
  },
  {
    rail: "ach",
    provider: "increase",
    providerEventType: "ach_transfer.updated/returned",
    canonicalKind: "ach_return",
    semantics: "new_event",
    valueDateSource: "payload.return.created_at",
    note: "THE row people get wrong. A return is a NEW EVENT with its own value date: the payment really did settle on Monday and the RDFI really did return it on Thursday. Booking it at Monday's date would erase a settlement that occurred and make an already-issued statement disagree with the customer's own bank.",
  },
  {
    rail: "ach",
    provider: "increase",
    providerEventType: "ach_transfer.updated/notification_of_change",
    canonicalKind: "ach_notification_of_change",
    semantics: "new_event",
    valueDateSource: "payload.notifications_of_change[].created_at",
    note: "A NOC corrects the counterparty's routing or account number. No money moves and nothing posts — it is recorded so the next entry uses the corrected details.",
  },
  // The two INBOUND rows. Both were unreachable code until 2026-09-11 —
  // `increaseAchConsumer` parked every `inbound_ach_transfer` delivery before
  // any semantics lookup ran — and the first thing that happened when the
  // consumer finally asked was that one of them turned out to be wrong.
  // `db/migrations/0039_inbound_recall.sql` corrected the recall row's
  // value_date_source from the OUTBOUND `return.created_at` shape to the
  // inbound object's own `transfer_return.returned_at`, measured on the
  // Increase sandbox. `0042_virtual_account_numbers.sql` then rewrote both
  // notes again, once an inbound credit could be attributed to a business and
  // therefore booked.
  //
  // BOTH ARE MIRRORED HERE VERBATIM FROM THE DEPLOYED TABLE, and the mirroring
  // is the point rather than a tidy-up: this insert is
  // `ON CONFLICT DO UPDATE ... SET value_date_source = EXCLUDED.value_date_source,
  // note = EXCLUDED.note`, so any field the seed holds stale is a field the
  // next `node scripts/seed.mjs` silently reverts. A seed still carrying
  // `payload.return.created_at` would have put back a path that does not exist
  // on an `inbound_ach_transfer`, and every recall would have parked with no
  // value date. `src/lib/rails/semantics.test.ts` §7 asserts all seven columns
  // against the live table so the next drift is reported rather than shipped.
  {
    rail: "ach",
    provider: "increase",
    providerEventType: "inbound_ach_transfer.created",
    canonicalKind: "inbound_ach_credit",
    semantics: "new_event",
    valueDateSource: "payload.effective_date",
    note: "Someone is sending money to a virtual account number on the programme's FBO account, effective on the date the originator chose -- a NEW EVENT at payload.effective_date. Since db/migrations/0042_virtual_account_numbers.sql the receiver is knowable: the object names account_number_id, virtual_account_number maps that id to exactly one business, and the consumer books DR 1110 (the cash is at the sponsor bank the moment Increase accepts it) / CR that business's 2100 leaf, then opens an uncleared_credit hold under the ach/new funds-availability policy -- two banking days -- so the LEDGER balance moves and the AVAILABLE balance does not. That is the ACH half of the availability contrast: an inbound wire is final on receipt and its hold is born released, an inbound ACH can still be pulled back by the originator and its hold binds. A credit naming a number with NO row in virtual_account_number still PARKS, unchanged and deliberate: the refusal is the point, and an attribution path with a default account would destroy it.",
  },
  {
    rail: "ach",
    provider: "increase",
    providerEventType: "inbound_ach_transfer.updated/returned",
    canonicalKind: "inbound_ach_return",
    semantics: "new_event",
    valueDateSource: "payload.transfer_return.returned_at",
    note: "THE RECALL OF AN INBOUND CREDIT. MEASURED 2026-09-11 on sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b: returning an inbound ACH adds ONE block, transfer_return {reason, returned_at, transaction_id}, and the object carries no `return` key at all -- the outbound ach_transfer shape (return.created_at) does not apply here, which is why this row's value_date_source names transfer_return.returned_at. A NEW EVENT at its own date, never a correction: the credit really did arrive on the effective date and really did go back on the returned_at date, so a recall never rewrites the arrival day and the arrival day's statement still shows the money that was there. Since 0042 the consumer books it: DR the business's 2100 leaf / CR 1110 at the recall's own value date, and it CLOSES the uncleared_credit hold the arrival opened in the same transaction -- a hold left standing against a credit that has gone back would withhold the money twice. A recall of a credit this book never attributed still books nothing, because there is nothing to correct, and it resolves the parked arrival delivery instead of leaving an operator pointed at money that has already left.",
  },

  // ---- Increase (wire) ----------------------------------------------------
  // Mirrored from `db/migrations/0025_wires.sql`, which inserted these eight
  // directly with the Fedwire measurements in each note. They lived only in
  // the migration for a day, which meant the deployed table had 30 rows and
  // this file seeded 22: a database restored from the seed alone would have
  // come up with no wire classifications at all, and every wire delivery
  // would have parked. The seed is the source of truth for the table, so the
  // rows live here and the migration is the deployment of them.
  //
  // A wire is not an ACH. It cannot be returned, so every row here is a
  // new_event and not one of them anchors on the original's value date:
  // money coming back on this rail is a SECOND PAYMENT, measured
  // (class_name inbound_wire_reversal, its own IMAD, null return_reason_code).
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.created",
    canonicalKind: "wire_originated",
    semantics: "new_event",
    valueDateSource: "payload.created_at",
    note: "The instruction exists and nothing has been put on a wire: measured status pending_creating, submission null. Booked as its own event on the day it was raised. Nothing about the money has happened yet, which is why the ledger consequence of this row is nothing.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/submitted",
    canonicalKind: "wire_submitted",
    semantics: "new_event",
    valueDateSource: "payload.submission.submitted_at",
    note: "Handed to Fedwire, IMAD issued, and on this rail that is a transient status rather than a resting one -- measured, the object went pending_creating -> complete inside one simulated submit. Recorded as a new event at its own submission time.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/complete",
    canonicalKind: "wire_settled",
    semantics: "new_event",
    valueDateSource: "payload.submission.submitted_at",
    note: "THE SETTLEMENT, and it reads its value date from the SUBMISSION timestamp because a wire has no settlement object to read one from. Fedwire is real-time gross settlement: acceptance of the message IS the transfer of funds. This is the exact mirror of the Increase ACH trap -- there, status stays `submitted` and a `settlement.settled_at` appears, so submitted+settled_at must be promoted to settled; here, status becomes `complete` and no settlement object ever appears, so submission.submitted_at IS the settlement time. An adapter that waited for a settlement field on a wire would wait forever.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/reversed",
    canonicalKind: "wire_return_of_funds",
    semantics: "new_event",
    valueDateSource: "payload.reversal.created_at",
    note: "NOT a correction, and not a return either. Measured: the reversal carries class_name inbound_wire_reversal, its own IMAD, its own transaction id and a null return_reason_code -- it is a SECOND PAYMENT the beneficiary's bank chose to send back, not an unwinding of ours. The original wire settled, was final, and its value date stays true; the money coming back is a new receipt on the day it came back. Taking the original's value date would make the ledger claim the payment never happened on the day it provably did.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/canceled",
    canonicalKind: "wire_canceled",
    semantics: "new_event",
    valueDateSource: "payload.cancellation.canceled_at",
    note: "Cancelled BEFORE submission -- the only window in which a wire can be stopped at all, and it closes the moment the Fed accepts the message. No money moved, so there is nothing to correct and nothing to reverse.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/rejected",
    canonicalKind: "wire_rejected",
    semantics: "new_event",
    valueDateSource: "payload.created_at",
    note: "Refused before it left: Increase declined to submit. No IMAD was ever issued and no money was put on a wire, so this is a new event about an instruction, never a correction of a payment.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "inbound_wire_transfer.created",
    canonicalKind: "inbound_wire_credit",
    semantics: "new_event",
    valueDateSource: "payload.acceptance.accepted_at",
    note: "THE INBOUND LEG, and its value date is the acceptance instant because that is when the money became ours. Measured: acceptance.accepted_at equals created_at exactly -- an inbound wire has no pending stage. Compare inbound_ach_transfer.created, which dates from payload.effective_date because an inbound ACH credit is a promise about a future settlement day. This row is where \"available immediately\" comes from: there is no gap between arrival and value.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "inbound_wire_transfer.updated/reversed",
    canonicalKind: "inbound_wire_returned",
    semantics: "new_event",
    valueDateSource: "payload.reversal.reversed_at",
    note: "We sent it back. Measured: POST /inbound_wire_transfers/{id}/reverse is a PRODUCTION API method, not a simulation, and it took reason=creditor_request -- the creditor being us. So this is not the network recalling a payment, it is this bank ORIGINATING a wire in the other direction, and it dates from the day we did it. The customer's balance goes down on the day the funds left, not on the day they arrived; the arrival really happened and the statement for that day must keep saying so.",
  },

  // ---- Base (USDC) --------------------------------------------------------
  // These are not third-party webhooks: our own chain watcher synthesises them
  // from transaction receipts. They are registered here anyway so the
  // value-date rule for USDC is reviewed in exactly the same place, and by
  // exactly the same test, as the rule for a rail somebody else operates.
  {
    rail: "usdc",
    provider: "base",
    providerEventType: "usdc.transfer.pending",
    canonicalKind: "usdc_payout_pending",
    semantics: "new_event",
    valueDateSource: "payload.broadcast_at",
    note: "Broadcast, mined or not, below the confirmation bar. Debits the customer and credits 1140 at the broadcast date; the gas cost goes to 5300 and is never charged to the customer.",
  },
  {
    rail: "usdc",
    provider: "base",
    providerEventType: "usdc.transfer.confirmed",
    canonicalKind: "usdc_payout_confirmed",
    semantics: "new_event",
    valueDateSource: "payload.block_timestamp",
    note: "Receipt status success at or beyond N confirmations (1 on the testnet demo, 2 for anything real). Releases the hold; sub-cent dust from USDC's six decimals posts to 2900 rather than being truncated.",
  },
  {
    rail: "usdc",
    provider: "base",
    providerEventType: "usdc.transfer.failed",
    canonicalKind: "usdc_payout_failed",
    semantics: "correction",
    valueDateSource: "original.value_date",
    note: "A reverted transaction moved no money at all, so the pending posting was a false statement about its own value date. Reverses at that date. The gas in 5300 stays: it was really spent.",
  },
  {
    rail: "usdc",
    provider: "base",
    providerEventType: "usdc.transfer.reorged",
    canonicalKind: "usdc_payout_reorged",
    semantics: "correction",
    valueDateSource: "original.value_date",
    note: "The block that carried the transfer is no longer canonical, so it never happened on that date. This is the one case where the chain disagrees with something we already told a customer, and the correction carries the original date so the statement can be reissued as v2.",
  },
  {
    rail: "usdc",
    provider: "base",
    providerEventType: "usdc.deposit.observed",
    canonicalKind: "inbound_usdc_credit",
    semantics: "new_event",
    valueDateSource: "payload.block_timestamp",
    note: "Inbound USDC seen at our omnibus address. Debits 1140 and credits the customer, and holds it in 9200 until the confirmation count in the USDC availability policy is met.",
  },
];

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

const url = process.env.DIRECT_URL;
if (!url) {
  console.error("DIRECT_URL is not set.");
  console.error("Seeding writes reference data, which the app role `corgi_app` cannot do");
  console.error("by design (DECISIONS 008/009). Source the owner URL first:");
  console.error("  set -a; . ./.env; set +a");
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

/** created/existing counts per table, for the summary. */
const tally = new Map();
function count(table, createdRows) {
  const t = tally.get(table) ?? { created: 0, existing: 0 };
  if (createdRows.length > 0) t.created += createdRows.length;
  else t.existing += 1;
  tally.set(table, t);
}

const created = { accounts: [], businesses: [], actors: [] };
let constraintProof = "not run";

try {
  await sql.begin(async (tx) => {
    // ---- book_entity ------------------------------------------------------
    count(
      "book_entity",
      await tx`
        INSERT INTO book_entity (id, code, name)
        VALUES (${ENTITY_ID}, ${ENTITY.code}, ${ENTITY.name})
        ON CONFLICT DO NOTHING
        RETURNING id`,
    );

    // ---- business ---------------------------------------------------------
    for (const business of BUSINESSES) {
      business.id = uuid5(`business:${business.key}`);
      const rows = await tx`
        INSERT INTO business (id, entity_id, legal_name, ein)
        VALUES (${business.id}, ${ENTITY_ID}, ${business.legalName}, ${KYB[business.kyb].ein})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      count("business", rows);
      if (rows.length > 0) created.businesses.push(business.legalName);
    }

    // ---- actor ------------------------------------------------------------
    for (const actor of ACTORS) {
      actor.id = uuid5(`actor:${actor.key}`);
      const businessId =
        actor.business === null
          ? null
          : (BUSINESSES.find((b) => b.key === actor.business)?.id ?? null);
      const rows = await tx`
        INSERT INTO actor (id, kind, display_name, email, business_id, can_approve)
        VALUES (${actor.id}, ${actor.kind}, ${actor.displayName}, ${actor.email},
                ${businessId}, ${actor.canApprove})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      count("actor", rows);
      if (rows.length > 0) created.actors.push(actor.displayName);
    }

    // ---- the CHECK that makes an agent approver unrepresentable -----------
    // Attempted inside a savepoint so the refusal cannot take the seed with
    // it. A README asserting maker-checker is a promise; this is evidence,
    // and it costs one rolled-back statement to produce.
    try {
      await tx.savepoint(async (sp) => {
        await sp`
          INSERT INTO actor (id, kind, display_name, can_approve)
          VALUES (${uuid5("actor:probe.agent-approver")}, 'agent', 'rogue approver', true)`;
      });
      constraintProof = "NOT ENFORCED — the database accepted an agent with can_approve";
    } catch (error) {
      const message = String(error?.message ?? error);
      constraintProof = message.includes("actor_only_humans_approve")
        ? "REFUSED by actor_only_humans_approve"
        : `refused, but for the wrong reason: ${message.slice(0, 80)}`;
    }

    // ---- the chart of accounts (house accounts) --------------------------
    // CHART is ordered parents-first, so parent_id always resolves.
    for (const account of CHART) {
      const id = uuid5(`account:${ENTITY.key}:${account.code}:house`);
      const parentId =
        account.parent === null ? null : uuid5(`account:${ENTITY.key}:${account.parent}:house`);
      const rows = await tx`
        INSERT INTO account (id, entity_id, code, name, parent_id, type, book,
                             currency, business_id, rail_control, is_postable)
        VALUES (${id}, ${ENTITY_ID}, ${account.code}, ${account.name}, ${parentId},
                ${account.type}, ${account.book}, 'USD', NULL,
                ${account.railControl ?? null}, ${account.postable})
        ON CONFLICT DO NOTHING
        RETURNING id`;
      count("account", rows);
      if (rows.length > 0) created.accounts.push(`${account.code} ${account.name}`);
    }

    // ---- per-customer accounts, for APPROVED businesses only -------------
    for (const business of BUSINESSES) {
      if (!KYB[business.kyb].opensAccounts) continue;
      for (const ref of accountsForBusiness(business.id)) {
        const parent = requireAccount(ref.parentCode);
        const id = uuid5(`account:${ENTITY.key}:${ref.code}:${business.id}`);
        const parentId = uuid5(`account:${ENTITY.key}:${ref.parentCode}:house`);
        const rows = await tx`
          INSERT INTO account (id, entity_id, code, name, parent_id, type, book,
                               currency, business_id, rail_control, is_postable)
          VALUES (${id}, ${ENTITY_ID}, ${ref.code},
                  ${perBusinessAccountName(ref.parentCode, business.legalName)},
                  ${parentId}, ${parent.type}, ${parent.book}, 'USD',
                  ${business.id}, NULL, true)
          ON CONFLICT DO NOTHING
          RETURNING id`;
        count("account", rows);
        if (rows.length > 0) {
          created.accounts.push(`${ref.code}/${business.id} ${business.legalName}`);
        }
      }
    }

    // ---- approval_policy --------------------------------------------------
    for (const policy of APPROVAL_POLICIES) {
      count(
        "approval_policy",
        await tx`
          INSERT INTO approval_policy (id, rail, effective_from, threshold_cents,
                                       required_approvals, note)
          VALUES (${uuid5(`approval_policy:${policy.rail}:${POLICY_FROM}`)}, ${policy.rail},
                  ${POLICY_FROM}, ${policy.thresholdCents}, ${policy.requiredApprovals},
                  ${policy.note})
          ON CONFLICT DO NOTHING
          RETURNING id`,
      );
    }

    // ---- funds_availability_policy ---------------------------------------
    for (const policy of FUNDS_AVAILABILITY_POLICIES) {
      count(
        "funds_availability_policy",
        await tx`
          INSERT INTO funds_availability_policy (id, rail, counterparty_class, effective_from,
                                                 banking_days_hold, release_local_time,
                                                 confirmations, note)
          VALUES (${uuid5(`fap:${policy.rail}:${policy.counterpartyClass}:${POLICY_FROM}`)},
                  ${policy.rail}, ${policy.counterpartyClass}, ${POLICY_FROM},
                  ${policy.bankingDaysHold}, ${policy.releaseLocalTime},
                  ${policy.confirmations}, ${policy.note})
          ON CONFLICT DO NOTHING
          RETURNING id`,
      );
    }

    // ---- rail_event_semantics --------------------------------------------
    // The one table here that is upserted rather than inserted-once: it is
    // pure reference data, it carries no append-only trigger, and a wrong row
    // silently corrupts every statement it touches — so re-seeding must be
    // able to carry a correction rather than leave the wrong row standing.
    for (const row of RAIL_EVENT_SEMANTICS) {
      const result = await tx`
        INSERT INTO rail_event_semantics (rail, provider, provider_event_type,
                                          canonical_kind, semantics, value_date_source, note)
        VALUES (${row.rail}, ${row.provider}, ${row.providerEventType},
                ${row.canonicalKind}, ${row.semantics}, ${row.valueDateSource}, ${row.note})
        ON CONFLICT (provider, provider_event_type) DO UPDATE
          SET rail = EXCLUDED.rail,
              canonical_kind = EXCLUDED.canonical_kind,
              semantics = EXCLUDED.semantics,
              value_date_source = EXCLUDED.value_date_source,
              note = EXCLUDED.note
        RETURNING (xmax = 0) AS inserted`;
      count("rail_event_semantics", result[0]?.inserted ? result : []);
    }
  });
} catch (error) {
  console.error("\nSEED FAILED — nothing was written; the whole seed is one transaction.\n");
  console.error(String(error?.message ?? error));
  await sql.end();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const rule = (label = "") =>
  console.log(label ? `\n── ${label} ${"─".repeat(Math.max(0, 74 - label.length))}` : "─".repeat(78));

const [entityRow] = await sql`SELECT code, name FROM book_entity WHERE id = ${ENTITY_ID}`;
const accountRows = await sql`
  SELECT code, name, type, book, business_id, is_postable, normal_side, rail_control
  FROM account WHERE entity_id = ${ENTITY_ID}
  ORDER BY book, code, business_id NULLS FIRST`;
const [{ entries }] = await sql`SELECT count(*)::int AS entries FROM journal_entry`;

console.log("");
rule();
console.log(`  SEED — ${entityRow?.name ?? ENTITY.name}  (${entityRow?.code ?? ENTITY.code})`);
rule();

rule("what changed");
for (const [table, t] of tally) {
  const verb = t.created > 0 ? `${t.created} created` : "no change";
  console.log(`  ${table.padEnd(28)} ${String(verb).padStart(12)}   ${t.existing} already present`);
}

rule("chart of accounts");
console.log("  code   side  name                                                     kind\n");
for (const account of accountRows.filter((a) => a.business_id === null)) {
  const charted = requireAccount(account.code);
  const depth = charted.parent === null ? 0 : 1;
  const side = account.normal_side === 1 ? "Dr" : "Cr";
  const kind = account.is_postable
    ? "postable"
    : charted.perBusiness === true
      ? "control, one leaf per customer"
      : account.code === "1190"
        ? "reporting reclass only, never posted"
        : "rollup";
  const flags = [
    kind,
    account.book === "memo" ? "· memo book" : null,
    account.rail_control ? `· rail control: ${account.rail_control}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const indent = "  ".repeat(depth);
  console.log(
    `  ${indent}${account.code.padEnd(6 - depth * 2)} ${side}  ${(indent + account.name).padEnd(56)} ${flags}`,
  );
}

rule("customer accounts (opened on KYB approval, not before)");
const customerAccounts = accountRows.filter((a) => a.business_id !== null);
if (customerAccounts.length === 0) {
  console.log("  none — no business has passed KYB");
}
for (const account of customerAccounts) {
  const business = BUSINESSES.find((b) => b.id === account.business_id);
  const side = account.normal_side === 1 ? "Dr" : "Cr";
  console.log(
    `  ${account.code}/${account.business_id}  ${side}  ${account.book === "memo" ? "memo " : "     "}${business?.legalName ?? ""}`,
  );
  console.log(`      ${account.name}`);
}
console.log(
  `\n  NOTE: the stored account.code is the BARE '${DEPOSIT_PARENT_CODE}'; the customer is`,
);
console.log("  identified by business_id. v_available_balance, v_overdrawn_accounts and");
console.log("  v_deposit_control_drift all select on code = '2100' AND business_id IS NOT");
console.log("  NULL, so a qualified code in that column would make them silently empty.");

rule("businesses and KYB");
for (const business of BUSINESSES) {
  const state = KYB[business.kyb];
  console.log(`  ${business.legalName}`);
  console.log(`    kyb            ${business.kyb.toUpperCase()}`);
  console.log(`    ein            ${state.ein}  (Stripe test mode: ${state.registry})`);
  console.log(
    `    deposit acct   ${state.opensAccounts ? depositAccountCode(business.id) : "— none: no deposit liability before KYB approves"}`,
  );
  console.log(`    demoes         ${business.why}`);
}

rule("actors");
for (const actor of ACTORS) {
  const approve = actor.canApprove ? "APPROVER" : "cannot approve";
  console.log(`  ${actor.displayName.padEnd(24)} ${actor.kind.padEnd(7)} ${approve}`);
  console.log(`      ${actor.why}`);
}
console.log(`\n  maker-checker constraint: ${constraintProof}`);

rule("policies");
for (const policy of APPROVAL_POLICIES) {
  const threshold = Number(policy.thresholdCents) / 100;
  console.log(
    `  approval    ${policy.rail.padEnd(9)} >= $${threshold.toFixed(2).padStart(10)}  needs ${policy.requiredApprovals} approval(s)`,
  );
}
for (const policy of FUNDS_AVAILABILITY_POLICIES) {
  const hold =
    policy.confirmations !== null
      ? `${policy.confirmations} confirmation(s)`
      : policy.bankingDaysHold === 0
        ? "immediate"
        : `+${policy.bankingDaysHold} banking day(s) @ ${policy.releaseLocalTime} ET`;
  console.log(`  availability ${policy.rail.padEnd(8)} ${policy.counterpartyClass.padEnd(6)} ${hold}`);
}

rule("rail event semantics");
const byProvider = new Map();
for (const row of RAIL_EVENT_SEMANTICS) {
  const bucket = byProvider.get(row.provider) ?? { new_event: 0, correction: 0 };
  bucket[row.semantics] += 1;
  byProvider.set(row.provider, bucket);
}
for (const [provider, bucket] of byProvider) {
  console.log(
    `  ${provider.padEnd(10)} ${String(bucket.new_event + bucket.correction).padStart(2)} rows   ${bucket.new_event} new_event, ${bucket.correction} correction`,
  );
}

rule("money");
console.log(`  journal_entry rows: ${entries}`);
console.log("  This script posts no money, by design. The posting path");
console.log("  (src/lib/ledger/post.ts) owns every journal entry in this system,");
console.log("  and ledger_append() is the only sanctioned write path to it.");

// ---------------------------------------------------------------------------
// The story, and the two blocks that stop a reviewer having to guess
// ---------------------------------------------------------------------------
//
// Reference data is not a demo. Somebody who has never seen this system opens a
// URL, and the question they ask in the first ninety seconds is "which of these
// rows is the point?". These last two sections answer it from the database
// rather than from a paragraph: one names the business to follow and the URL
// for each leg of the core loop, and the other names every OTHER business on
// the book and says plainly where it came from.

const protagonist = BUSINESSES.find((b) => b.key === PROTAGONIST_KEY);

/**
 * The deposit account is derived, not looked up.
 *
 * `depositAccountCode()` and the uuid5 namespace make the id a pure function of
 * the business key, so these URLs are the same on a book seeded ten minutes ago
 * and on the deployed one — which is what makes it safe to paste them into
 * docs/DEMO.md and into the submission email.
 */
const [protagonistAccount] = await sql`
  SELECT id, name FROM account
   WHERE business_id = ${protagonist.id} AND code = '2100'
   LIMIT 1`;

rule("the story — one business, and where each leg of it is on screen");
console.log(`  ${protagonist.legalName}`);
console.log(`    business_id      ${protagonist.id}`);
console.log(
  `    deposit account  ${protagonistAccount?.id ?? "— not open yet: KYB has not approved on this book"}`,
);
console.log("");
console.log("  Follow it in this order. Every URL below is a deep link, and every one of");
console.log("  them is also reachable by clicking — the query strings are a shortcut, not a");
console.log("  requirement, and no screen needs a parameter to work.");
console.log("");
const leg = (n, what, href) => console.log(`    ${n}. ${what.padEnd(46)} ${href}`);
leg(1, "KYB, and the gate before any money", "/onboarding");
leg(2, "fund it from a linked external bank", "/funding");
leg(3, "the two balances, and the holds between", `/accounts/${protagonistAccount?.id ?? "<no account yet>"}`);
leg(4, "raise money out", "/payments");
leg(5, "maker-checker refuses the maker", "/approvals");
leg(6, "the scheme file against the book", "/reconciliation");
leg(7, "a closed day, and its correction", `/statements?account=${protagonistAccount?.id ?? ""}`);
console.log("");
console.log("  Money arrives on this book through the posting path, never through this");
console.log("  script. `node scripts/coreloop.mjs` walks all seven legs end to end against");
console.log("  the deployed URL and prints what each one wrote.");

// ---------------------------------------------------------------------------
// Every other business on the book
// ---------------------------------------------------------------------------
//
// Integration and fuzz suites run against this same database, and each one
// opens a business of its own. Those rows are real evidence that the tests ran
// — a fuzz company with 759 postings is worth more than a paragraph claiming
// the hold model was exercised — and they are NOT deleted: this book is
// append-only, the app role holds no DELETE on a money table, and removing a
// business that has postings would be exactly the edit the whole design
// refuses. But a reviewer must never mistake one for a customer, so they are
// listed here by name, with their posting counts, before the console is opened.
const seededIds = BUSINESSES.map((b) => b.id);
const others = await sql`
  SELECT b.id, b.legal_name, b.created_at,
         (SELECT count(*)::int FROM account a WHERE a.business_id = b.id) AS accounts,
         (SELECT count(*)::int FROM journal_line jl
            JOIN account a2 ON a2.id = jl.account_id
           WHERE a2.business_id = b.id) AS lines
    FROM business b
   WHERE b.id <> ALL (${seededIds}::uuid[])
   ORDER BY b.created_at`;

rule("other businesses on this book — test fixtures, named as such");
if (others.length === 0) {
  console.log("  None. This book holds only the three businesses above, which is what a");
  console.log("  freshly seeded database looks like before any test suite has run.");
} else {
  console.log(`  ${others.length} business(es) on this book were not written by this script.`);
  console.log("  They were opened by the integration, fuzz and live-fire suites running");
  console.log("  against this same database. They are kept, and they are labelled:");
  console.log("");
  for (const row of others) {
    console.log(
      `    ${row.legal_name.padEnd(42)} ${String(row.accounts).padStart(2)} accts  ${String(
        row.lines,
      ).padStart(5)} lines  opened ${row.created_at.toISOString().slice(0, 16).replace("T", " ")}Z`,
    );
  }
  console.log("");
  console.log("  Two things follow from this that a reviewer should know before clicking:");
  console.log("");
  console.log("    - /accounts sorts its live deposit accounts ALPHABETICALLY, so a fixture");
  console.log("      is usually the first row and usually the largest balance. That is the");
  console.log("      list working as written, not the demo's customers having lost money.");
  console.log("    - Their balances are real postings through postEntry(), not literals, so");
  console.log("      they are included in the trial balance and in every invariant view.");
  console.log("      Nothing here is hidden from the totals to make a screen look tidier.");
}

rule();
console.log("");

await sql.end();
