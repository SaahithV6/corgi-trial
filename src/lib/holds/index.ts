/**
 * Card authorisation holds.
 *
 *   model.ts          H(E) = 0 if closed(E) else max(A(E) − C(E), 0). Pure.
 *   lithic-events.ts  one webhook payload → canonical facts. Pure.
 *   store.ts          every statement the machinery issues. No raw money INSERTs.
 *   apply.ts          lock, append, post, close, compare-and-append.
 *   corrections.ts    the repair: reverse at the ORIGINAL value date. Pure choice,
 *                     impure posting.
 *   expiry.ts         the clock release, which is bookkeeping and not a repair.
 *   completion.ts     the other end of the lifecycle: an OPENING whose memo
 *                     posting never landed. Idempotent, total, safe mid-flight.
 *
 * `model.ts` and `lithic-events.ts` have no database and no clock of their own,
 * which is why the interesting properties — order-independence, duplicate
 * immunity, the fuel-pump arithmetic — are provable without one.
 */

export {
  financialPostingKey,
  holdCents,
  holdPostingKey,
  holdState,
  movesFinancialBook,
  type AuthorizationClock,
  type CardEvent,
  type CardEventKind,
  type HoldState,
} from "./model";

export {
  deriveCardEvents,
  type AuthOrigin,
  type DerivedCardEvents,
} from "./lithic-events";

export {
  CARD_AUTH_EXPIRY_DAYS,
  CARD_SETTLEMENT_CODE,
  MEMO_CONTRA_CODE,
  closeHold,
  ensureAuthorization,
  findAuthorization,
  findExpiredAuthorizations,
  insertCardEvents,
  isHoldClosed,
  ledgerPosterActorId,
  loadCardEvents,
  lockAuthorization,
  memoHoldBalance,
  postCardMovement,
  postHoldDelta,
  registerCard,
  resolveCard,
  type AuthorizationIdentity,
  type ClosureSource,
  type CardBinding,
} from "./store";

export {
  LITHIC_LIFECYCLE_EVENT,
  LITHIC_PROVIDER,
  applyCardTransaction,
  settleHoldPosting,
  type ApplyContext,
  type ApplyResult,
  type HoldOutcome,
  type UnmatchedCorrection,
} from "./apply";

export {
  chooseCorrectionTarget,
  correctionRebookKey,
  directionOf,
  postCardCorrection,
  readTargetEntry,
  type CorrectionPosted,
  type CorrectionResult,
  type CorrectionTargetChoice,
  type CorrectionUnmatched,
  type MoneyDirection,
} from "./corrections";

export {
  expireOne,
  expiryEventId,
  sweepExpiredHolds,
  type ExpirySweepResult,
} from "./expiry";

export {
  completeOne,
  findIncompleteHoldPostings,
  sweepIncompleteHoldPostings,
  type HoldCompletionResult,
  type HoldCompletionSweepResult,
  type IncompleteHoldPosting,
} from "./completion";
