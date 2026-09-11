/**
 * Dispute intake on a settled card transaction, with provisional credit.
 *
 *   model.ts       the postings, the keys, the legal transitions. Pure — no
 *                  database, no clock — so the money arithmetic and the state
 *                  machine are provable in a plain Node process.
 *   store.ts       every statement. No raw money INSERTs; `postEntry()` only.
 *   operations.ts  one transaction per transition, with the event inside it.
 *   screen.ts      the read model for `/disputes`. `bigint` narrows here, once.
 *
 * The law is in db/migrations/0019_disputes.sql, not here:
 * `assert_dispute_intake()` decides what may be disputed and
 * `assert_dispute_lifecycle()` decides what may follow what. This module
 * refuses earlier and with a better sentence; it never refuses ALONE.
 */

export {
  CLOSED_STATUSES,
  DISPUTE_EVENT_KINDS,
  DISPUTE_LOSS_CODE,
  DISPUTE_REASONS,
  DISPUTE_RECEIVABLE_CODE,
  DISPUTE_STATUSES,
  DISPUTE_STATUS_MEANING,
  MEMO_CONTRA_CODE,
  NETWORK_OUTSIDE_DAYS,
  canTransition,
  caseRef,
  clawbackLines,
  disputeHoldRef,
  disputeKeys,
  finalCreditLines,
  holdLines,
  isClosed,
  isDisputeReason,
  networkOutsideDate,
  provisionalCreditLines,
  writeOffLines,
  type DisputeAccounts,
  type DisputeEventKind,
  type DisputeFold,
  type DisputeReason,
  type DisputeStatus,
  type PostingLine,
  type TransitionVerdict,
} from "./model";

export {
  bookDate,
  closeDisputeHold,
  customerBalance,
  effectiveCardPolicy,
  heldCents,
  insertDispute,
  insertDisputeEvent,
  listDisputableCharges,
  listDisputeCustomers,
  listDisputeEvents,
  listDisputeLedger,
  listDisputeStates,
  listReasonCodes,
  openDisputeHold,
  positionAt,
  readAccountContext,
  readCardCharge,
  readDisputeState,
  type AccountContext,
  type CustomerBalance,
  type DisputableChargeRow,
  type DisputeEventRow,
  type DisputeLedgerLineRow,
  type DisputeRow,
  type DisputeStateRow,
  type ReasonCodeRow,
} from "./store";

export {
  authorizeProvisionalCredit,
  clawBackCredit,
  declineProvisionalCredit,
  finalizeCredit,
  grantProvisionalCredit,
  raiseDispute,
  recordDecision,
  submitEvidence,
  writeOffCredit,
  type Raised,
  type Refused,
  type Transitioned,
} from "./operations";
