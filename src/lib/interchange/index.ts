/**
 * Interchange: the price of a settlement, and the unit economics it makes
 * legible.
 *
 *   rate-card.ts   the arithmetic (DESIGN §12.2) and the posting template. Pure.
 *   dimensions.ts  one provider payload -> the dimensions it is priced on. Pure.
 *   store.ts       every statement the machinery issues. No raw money INSERTs,
 *                  and no SQL against journal_entry / journal_line / account.
 *   book.ts        reconcileSettlement(): book, unbook and re-price, as ONE
 *                  idempotent function, so the reversal path cannot be the one
 *                  somebody forgot to call.
 *   backfill.ts    the same function, run over the settlements that were
 *                  already on the book.
 *   screen.ts      the economics read.
 *
 * `rate-card.ts` and `dimensions.ts` have no database and no clock, which is
 * why the interesting properties — the half-even tie, the fixed component not
 * needing a second rounding rule, a fully refunded purchase netting to zero —
 * are provable without one.
 */

export {
  BPS_DENOMINATOR,
  PRESENTMENTS,
  interchangeForNet,
  interchangeLines,
  interchangePostingKey,
  interchangeRebookKey,
  priceSettlement,
  roundHalfEven,
  roundingOf,
  type BasisPoints,
  type InterchangeArithmetic,
  type InterchangeDirection,
  type Presentment,
  type RateCardEntry,
  type Rounding,
} from "./rate-card";

export {
  isPriceable,
  presentmentOf,
  readDimensions,
  type SettlementDimensions,
} from "./dimensions";

export {
  CARD_SETTLEMENT_CODE,
  INTERCHANGE_INCOME_CODE,
  findCandidateByEntry,
  findCandidateByEvent,
  listCandidates,
  readPostingPosition,
  resolveCategory,
  resolveRate,
  type PostingPosition,
  type SettlementCandidate,
} from "./store";

export {
  reconcileCandidate,
  reconcileSettlement,
  reconcileSettlementEvent,
  type ReconcileContext,
  type ReconcileOutcome,
  type RepairPosted,
} from "./book";

export {
  backfillInterchange,
  type BackfillOptions,
  type BackfillResult,
} from "./backfill";
