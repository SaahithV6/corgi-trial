/**
 * Payee confirmation — the public surface.
 *
 * ONE ENTRY POINT MATTERS: `confirmPayee()`. Everything else is exported for
 * tests, for the screen, and for the day a second caller needs a leg on its
 * own.
 *
 * ─── WHERE TO CALL IT ──────────────────────────────────────────────────────
 *
 * In `requestPayment()` (src/lib/approvals/instructions.ts), inside the
 * transaction, immediately after the KYB gate and before the
 * `payment_instruction` INSERT:
 *
 *     const payee = await gatePaymentOnPayee(args, tx as unknown as Sql);
 *     if (payee !== null) return fail(payee.code, payee.message);
 *
 * That position is chosen, not convenient:
 *
 *   * AFTER the KYB gate, because an unverified business should be told it
 *     cannot transact at all before it is told anything about its payee.
 *   * INSIDE the transaction, so the payee book is read under the same
 *     snapshot that writes the instruction — the same argument the KYB gate
 *     makes about approve-then-revoke.
 *   * BEFORE the INSERT, so a blocked destination writes no instruction at
 *     all. There is no "raised then refused" state to clean up, and the
 *     approvals queue never shows a payment that could not be made.
 *
 * `gatePaymentOnPayee` performs NO network call — a checksum is arithmetic
 * and the book is one indexed read — so it adds nothing measurable to a
 * transaction that is already writing two rows. The provider legs run on the
 * payee screen, when a payee is added or re-checked, where a person is
 * waiting and a 150ms round trip is affordable.
 */

export {
  ABA_LENGTH,
  ABA_WEIGHTS,
  abaChecksumOk,
  abaNearMisses,
  abaPrefixAssigned,
  abaWeight,
  checkRoutingNumber,
  describeAbaPrefix,
  normaliseRoutingNumber,
  transpositionIsDetectable,
  type AbaNearMiss,
  type AbaVerdict,
} from "./aba";

export {
  IncreaseRoutingDirectory,
  INCREASE_ROUTING_PROVIDER,
  NOT_CHECKED,
  type DirectoryLookup,
  type DirectoryStatus,
  type RoutingDirectory,
} from "./directory";

export {
  NO_IDENTITY_SOURCE,
  PLAID_IDENTITY_MATCH_PROVIDER,
  PlaidIdentityNameSource,
  type IdentityCheckResult,
  type IdentityNameSource,
  type ProviderNameCheck,
} from "./identity";

export {
  compareNames,
  describeNameComparison,
  jaro,
  jaroWinkler,
  NAME_CLOSE_THRESHOLD,
  NAME_MATCH_THRESHOLD,
  nameMatchBand,
  nameTokens,
  normaliseName,
  structuralScore,
  type NameComparison,
  type NameMatchBand,
} from "./name-match";

export {
  accountNumberEntryAgrees,
  assertBlockIsArithmetic,
  decide,
  findConflictingTwin,
  verifyPayee,
  type VerifyDeps,
} from "./verify";

export {
  FINDING_CODES,
  FRESH_DAYS,
  PAYEE_RAILS,
  payeeCandidateSchema,
  STALE_DAYS,
  type BookEntry,
  type CheckEvidence,
  type DirectoryOutcome,
  type FindingCode,
  type FindingSeverity,
  type Freshness,
  type NameCheckResult,
  type NameMatchOutcome,
  type NameSource,
  type PayeeCandidate,
  type PayeeCheck,
  type PayeeFinding,
  type PayeeOutcome,
  type PayeeRail,
} from "./types";

export {
  ADD_PAYEE_HREF,
  confirmPayee,
  gatePaymentOnPayee,
  signWarningHref,
  type ConfirmPayeeResult,
  type PayeeGateRefusal,
} from "./gate";

export {
  explainRoutingNumber,
  summariseExplanation,
  type AbaExplanation,
  type AbaGroup,
  type AbaTerm,
  type InvisibleSwap,
  type TranspositionRepair,
} from "./explain";

export { recheckPayee, type RecheckRefusal, type RecheckResult } from "./recheck";
