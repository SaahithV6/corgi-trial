/**
 * Card authorisation holds.
 *
 *   model.ts          H(E) = 0 if closed(E) else max(A(E) − C(E), 0). Pure.
 *   lithic-events.ts  one webhook payload → canonical facts. Pure.
 *   store.ts          every statement the machinery issues. No raw money INSERTs.
 *   apply.ts          lock, append, post, close, compare-and-append.
 *   expiry.ts         the clock release, which is bookkeeping and not a repair.
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
  type CardBinding,
} from "./store";

export {
  LITHIC_PROVIDER,
  applyCardTransaction,
  settleHoldPosting,
  type ApplyContext,
  type ApplyResult,
  type HoldOutcome,
} from "./apply";

export {
  expireOne,
  expiryEventId,
  sweepExpiredHolds,
  type ExpirySweepResult,
} from "./expiry";
