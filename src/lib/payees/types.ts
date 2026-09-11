/**
 * The vocabulary of payee confirmation.
 *
 * One file so that the three things a reader has to hold at once — what was
 * checked, how strong the answer was, and whether it stops a payment — are
 * next to each other rather than spread across a service, a store and a
 * component.
 *
 * Everything here mirrors a type declared in migration 0016. Where the two
 * could drift, `store.ts` re-validates on the way out with zod rather than
 * asserting, exactly as `standing/store.ts` does with `counterparty`.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Severity — the block/warn line, as a type                                  */
/* -------------------------------------------------------------------------- */

/**
 * Three levels and no fourth.
 *
 *   block  The payment cannot proceed and no acknowledgement exists that
 *          would let it. RESERVED FOR ARITHMETIC. In this entire module
 *          exactly one finding may carry it: a routing number that fails the
 *          ABA check digit. `assertBlockIsArithmetic()` in `verify.ts`
 *          enforces that at runtime and migration 0016 enforces it at the
 *          row.
 *
 *   warn   A named human must acknowledge, in writing, with a reason, before
 *          the payment proceeds. Everything about the name, the directory and
 *          the book lands here — because every one of those has a legitimate
 *          explanation, and a control that cannot be overridden by somebody
 *          who knows better is a control people learn to route around.
 *
 *   note   Shown, recorded, and stops nothing. Used where the honest answer
 *          is "we could not ask" and turning that into a warning would put a
 *          flag on every payment.
 */
export type FindingSeverity = "block" | "warn" | "note";

/** Machine-readable, screaming snake case — the repo's `ErrorShape.code` style. */
export const FINDING_CODES = [
  // ---- arithmetic. The only source of a block. ----------------------------
  "ROUTING_CHECKSUM_FAILED",
  // ---- the routing number, structurally -----------------------------------
  "ROUTING_PREFIX_UNALLOCATED",
  // ---- the directory ------------------------------------------------------
  "DIRECTORY_NOT_LISTED",
  "DIRECTORY_UNAVAILABLE",
  "DIRECTORY_RAIL_UNSUPPORTED",
  "DIRECTORY_CONFIRMED",
  // ---- the name -----------------------------------------------------------
  "NAME_CLOSE_MATCH",
  "NAME_NO_MATCH",
  "NAME_NOT_VERIFIABLE",
  "NAME_CONFIRMED_BY_INSTITUTION",
  // ---- the book -----------------------------------------------------------
  "TWIN_WITH_DIFFERENT_DETAILS",
  "VERIFICATION_STALE",
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];

export type PayeeFinding = {
  readonly code: FindingCode;
  readonly severity: FindingSeverity;
  /** One line, for a heading. */
  readonly title: string;
  /** A paragraph a person can act on. Never provider jargon. */
  readonly detail: string;
};

/* -------------------------------------------------------------------------- */
/* The outcome                                                                */
/* -------------------------------------------------------------------------- */

/** Mirrors `payee_verification_outcome` in 0016, same order, worst last. */
export type PayeeOutcome = "verified" | "warned" | "blocked";

/** Mirrors `payee_name_match`. */
export type NameMatchOutcome = "match" | "close_match" | "no_match" | "unavailable";

/** Mirrors `payee_directory_result`. */
export type DirectoryOutcome = "found" | "not_listed" | "unavailable" | "not_checked";

/** Mirrors `payee_name_source`. The most important label on the screen. */
export type NameSource = "payer_asserted" | "linked_account_holder" | "confirmation_of_payee";

/** Mirrors `payee_check_evidence`. Same two words 0005 uses, same rule. */
export type CheckEvidence = "live" | "simulated";

/** Mirrors the strings `payee_verification_freshness()` returns. */
export type Freshness = "fresh" | "ageing" | "stale" | "never";

/**
 * How old a check may be before the screen says so.
 *
 * These numbers are NOT the definition — `payee_verification_freshness()` in
 * migration 0016 is, and the view computes the label. They are here so a
 * fixture and a test can talk about the boundaries without a database, and
 * `payees.integration.test.ts` asserts the two agree.
 */
export const FRESH_DAYS = 30;
export const STALE_DAYS = 90;

/* -------------------------------------------------------------------------- */
/* The destination being checked                                              */
/* -------------------------------------------------------------------------- */

/**
 * The rails a payee can name.
 *
 * `card` is absent for the same reason `standing_order_rail_is_payout`
 * excludes it: a card movement originates at a network, never at a payee.
 */
export const PAYEE_RAILS = ["ach", "wire", "usdc", "internal"] as const;
export type PayeeRail = (typeof PAYEE_RAILS)[number];

/**
 * What a caller hands the checker.
 *
 * NOTE WHAT IS NOT HERE: the full account number. This module never receives
 * one, so it cannot store one, log one, or send one to a provider. Only the
 * last four, which is the same rule `payment_instruction.counterparty`
 * follows. The consequence — that we cannot verify the account number itself
 * — is stated on the face of the feature rather than hidden.
 */
export const payeeCandidateSchema = z.object({
  businessId: z.uuid(),
  /** What our customer calls them. Never sent anywhere. */
  displayName: z.string().min(1).max(200),
  /** The name that would go on the payment. This is what gets compared. */
  holderName: z.string().min(1).max(200),
  rail: z.enum(PAYEE_RAILS),
  routingNumber: z.string().optional(),
  accountNumberLast4: z
    .string()
    .regex(/^\d{4}$/, { error: "last four digits only" })
    .optional(),
  accountType: z.enum(["checking", "savings"]).optional(),
  /**
   * Present only when this payee is an account somebody linked to us through
   * Plaid. When it is, the name check is real and `name_source` says
   * `linked_account_holder`; when it is not, the name check compares two
   * strings our own side typed and says `payer_asserted`.
   */
  plaidAccessToken: z.string().optional(),
  plaidAccountId: z.string().optional(),
});

export type PayeeCandidate = z.infer<typeof payeeCandidateSchema>;

/**
 * A payee already on the book, as far as the checker cares.
 *
 * Passed in rather than queried inside `verify.ts` so the checking logic is a
 * pure function of its inputs and can be tested — and demonstrated — without
 * a database. `store.ts` is what supplies these.
 */
export type BookEntry = {
  readonly id: string;
  readonly holderName: string;
  readonly rail: PayeeRail;
  readonly routingNumber: string | null;
  readonly accountNumberLast4: string | null;
};

/* -------------------------------------------------------------------------- */
/* The result                                                                 */
/* -------------------------------------------------------------------------- */

export type NameCheckResult = {
  readonly outcome: NameMatchOutcome;
  /** 0..100 whole points, or null when nobody was asked. */
  readonly score: number | null;
  readonly source: NameSource;
  /** The provider that answered, or null when none did. */
  readonly provider: string | null;
  /** The counterparty's name, when a third party supplied one. */
  readonly counterpartyName: string | null;
  /** The sentence the screen shows. Names the source or says there was not one. */
  readonly explanation: string;
  /**
   * The provider's own score, kept beside ours and never merged with it.
   * Two opinions on one question are more useful than an average of them.
   */
  readonly providerScore: number | null;
};

export type PayeeCheck = {
  readonly decision: PayeeOutcome;
  readonly findings: readonly PayeeFinding[];
  /** Whether a human may proceed by acknowledging. False only for a block. */
  readonly acknowledgeable: boolean;

  readonly routingNumber: string | null;
  readonly checksumOk: boolean;
  readonly prefixAssigned: boolean;
  /** Present only when the checksum failed: the single edits that would fix it. */
  readonly nearMisses: readonly { readonly kind: string; readonly candidate: string }[];

  readonly directory: DirectoryOutcome;
  readonly directoryProvider: string | null;
  readonly institutionName: string | null;
  readonly achSupported: boolean | null;
  readonly wireSupported: boolean | null;

  readonly name: NameCheckResult;

  readonly evidence: CheckEvidence;
  readonly checkedAt: string;
};
