/**
 * The account screen's data contract.
 *
 * ============================================================================
 * TODO(ledger): swap the fixture for the real implementation.
 *
 * `src/lib/ledger/balances.ts` is owned by another worker and does not exist
 * yet. This file is the seam between us: the screen depends on this interface
 * and on nothing else, and the ledger worker implements it. When it lands, the
 * only change on this side is inside `getAccountDataSource()` in
 * `src/components/account/fixtures.ts` — one import swap, no component edits.
 *
 * Nothing in `src/components/**` may import `postgres`, `src/lib/db`, or
 * `src/lib/ledger/*` directly. If a component needs a number that is not on
 * these types, the fix is to widen this contract, not to open a connection.
 * ============================================================================
 *
 * Shape notes for whoever implements this:
 *
 * - **Every amount is integer minor units (US cents).** Never dollars, never a
 *   float, never a string carrying a decimal point. `NUMERIC` out of Postgres
 *   must be narrowed on the way through, not on the way to the screen.
 * - **Every instant is an ISO 8601 string in UTC**, with an offset or a `Z`.
 *   The UI renders it in the banking timezone (America/New_York); it does not
 *   want a pre-formatted string, because it needs the instant to compute ages.
 * - **Value dates are `YYYY-MM-DD`**, not instants. §5 of the ledger design is
 *   explicit that these are the two clocks and they are not the same type.
 * - **Failure is a value, not a throw.** Every method returns a `Result`, so
 *   the screen's error state is a branch and not a boundary. A thrown error is
 *   still caught by the page, but it renders as an unexplained failure.
 * - **The screen never writes.** This interface is read-only by design; money
 *   movement goes through a route handler with maker-checker, never through a
 *   render.
 */

import type { ErrorShape, Result } from "@/lib/result";

/**
 * An amount of money, as integer minor units (US cents).
 *
 * `number` rather than `bigint` because these values cross the server/client
 * boundary in this app and `number` is safe to `$90 trillion`, which is
 * comfortably past any balance a business current account will hold. All
 * formatting goes through `src/lib/format/money.ts`, which accepts `bigint`
 * too — so widening this alias later is a one-line change here plus a
 * serialisation decision, and no component arithmetic changes.
 */
export type Cents = number;

/** ISO 8601 instant in UTC, e.g. `2026-09-09T19:42:00.000Z`. */
export type Instant = string;

/** Calendar date, `YYYY-MM-DD`. The value-date axis of §5, not an instant. */
export type ValueDate = string;

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The two balances, and the decomposition of the gap between them.
 *
 * `availableCents` must equal
 * `ledgerCents - activeHoldsCents - unclearedCreditsCents - pendingOutboundCents`,
 * exactly, in integers. The screen asserts this and shows a reconciliation warning if it
 * fails, because a gap that does not decompose is a ledger bug that an
 * operator needs to see rather than a rounding curiosity to hide.
 *
 * Both figures are folds over journal lines (§10) — there is no stored balance
 * column to read, and this contract does not create one. `asOf` is the instant
 * the fold was taken, and every age on the screen is measured against it.
 */
export type AccountSummary = {
  readonly accountId: string;
  /** Customer-facing account name, e.g. `Operating`. */
  readonly accountName: string;
  /** The business that owns the account. */
  readonly businessName: string;
  /** Last four of the account number. Never the full number. */
  readonly accountNumberLast4: string;
  /** ISO 4217. This build is USD-only; the field exists so a mixed book cannot be rendered by accident. */
  readonly currency: "USD";

  /**
   * Settled position: the sum of financial postings with `value_date <= today`
   * and `booking_seq <= watermark`. Memo (hold) postings never touch it.
   *
   * Negative means overdrawn — a debit-normal balance on a credit-normal
   * deposit liability (§2.1). Render it, do not clamp it.
   */
  readonly ledgerCents: Cents;

  /**
   * Spendable position: `ledger − Σ active holds − Σ committed outflows`. May
   * be negative after an over-capture; §10 is explicit that it is not clamped,
   * because clamping loses money.
   */
  readonly availableCents: Cents;

  /** Σ of `remainingCents` over card-auth and manual holds. Non-negative. */
  readonly activeHoldsCents: Cents;

  /** Σ of `remainingCents` over uncleared-credit holds. Non-negative. */
  readonly unclearedCreditsCents: Cents;

  /**
   * Debits already booked for a FUTURE value date. Non-negative; committed out.
   *
   * The fourth term, and the one with no row in the holds table: an outbound
   * ACH originated today for tomorrow's settlement is a journal entry, not a
   * hold. It has not moved `ledgerCents` — `value_date <= today` excluded it —
   * and it must still come off `available`, because money booked to leave has
   * been committed and a customer who can spend it again before it settles has
   * been overdrawn on their own behalf. See `ledger_availability()`,
   * migration 0022.
   */
  readonly pendingOutboundCents: Cents;

  /** The instant this fold was taken. All ages are measured against it. */
  readonly asOf: Instant;

  /**
   * The booking watermark the fold was taken at (§5.3). Displayed as
   * provenance so a screenshot of this page is reproducible later.
   */
  readonly bookingWatermark: number;
};

/* -------------------------------------------------------------------------- */
/* Holds                                                                      */
/* -------------------------------------------------------------------------- */

/** §7: the three kinds of hold, and nothing else creates one. */
export type HoldKind = "card_auth" | "uncleared_credit" | "manual";

/**
 * One hold, as the memo book sees it.
 *
 * For a card auth these fields are the terms of `H(E) = 0 if closed(E) else
 * max(A(E) − C(E), 0)` from §8.1, exposed individually so the screen can show
 * an operator the arithmetic rather than a conclusion:
 *
 *   `authorisedCents` = A(E)   authorisations + increments − reversals
 *   `clearedCents`    = C(E)   clearings + force posts, including over-capture
 *   `remainingCents`  = H(E)   what is actually withheld from available
 *
 * Over-capture is therefore representable and must not be treated as invalid:
 * `clearedCents > authorisedCents` with `remainingCents === 0` is the fuel
 * pump case measured in DECISIONS 006 (auth $50.00, cleared $73.40).
 */
export type Hold = {
  readonly id: string;
  readonly kind: HoldKind;

  /**
   * What the operator will recognise: the merchant descriptor for a card auth,
   * the originator for an uncleared credit, the case reference for a manual
   * hold. Pass the network's descriptor through unaltered — an operator
   * comparing this against a customer's complaint needs the same string the
   * customer sees.
   */
  readonly descriptor: string;

  readonly authorisedCents: Cents;
  readonly clearedCents: Cents;
  readonly remainingCents: Cents;

  /**
   * `closed(E)`: final clearing, close, expiry, `A ≤ 0`, or a closure row.
   * A closed hold has `remainingCents === 0` and may still be listed briefly,
   * because "why did my available balance move" is answered by the hold that
   * just closed.
   */
  readonly closed: boolean;

  readonly placedAt: Instant;

  /** Card auths only: when the clock closes it. `null` for other kinds. */
  readonly expiresAt: Instant | null;

  /** Uncleared credits only: when the funds become available. `null` otherwise. */
  readonly availableAt: Instant | null;

  /** The `funds_availability_policy` row this hold was created under (§10.1). */
  readonly policyRef: string | null;

  /**
   * What the rail claims the state is, for display only.
   *
   * DECISIONS 006: Lithic flips this to `SETTLED` while a partial hold is
   * still live. It is shown next to the derived remaining amount precisely so
   * the disagreement is visible; it is never an input to `remainingCents`.
   */
  readonly providerStatus: string | null;
};

/* -------------------------------------------------------------------------- */
/* Postings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which book the row belongs to.
 *
 * `financial` moves the ledger balance. `memo` moves only availability — a
 * card authorisation is a memo posting, which is exactly why an auth changes
 * available and leaves ledger untouched (§8.2). The distinction is a column on
 * this type rather than a rule the reader has to remember.
 */
export type PostingBook = "financial" | "memo";

export type Posting = {
  readonly id: string;
  readonly book: PostingBook;

  /** One line, operator-readable: `Card clearing · SHELL OIL 1247`. */
  readonly description: string;
  readonly counterparty: string | null;

  /** When it happened (booking axis). */
  readonly occurredAt: Instant;
  /** The date it belongs to economically (value axis, §5). */
  readonly valueDate: ValueDate;

  /**
   * Effect on the ledger balance, signed from the customer's point of view:
   * money in is positive, money out is negative. (The journal stores the
   * bank's side — a customer debit — and the view flips it; see §2.2.)
   *
   * `null` for memo postings, which have no ledger effect at all. `null` is
   * not zero here, and the screen renders it as an em dash rather than
   * `$0.00`, because "did not touch the ledger" and "touched it for nothing"
   * are different facts.
   */
  readonly ledgerDeltaCents: Cents | null;

  /** Effect on available. Always present: every posting moves availability. */
  readonly availableDeltaCents: Cents;

  /** Set when this posting is a hold placement or release, for cross-linking. */
  readonly holdId: string | null;

  /** Provider event id, when the posting came from a rail. Shown as provenance. */
  readonly sourceRef: string | null;
};

/* -------------------------------------------------------------------------- */
/* The interface                                                              */
/* -------------------------------------------------------------------------- */

export type AccountQuery = {
  readonly accountId: string;
};

export type PostingsQuery = AccountQuery & {
  /** Newest first. Defaults to an implementation-chosen page size. */
  readonly limit?: number;
};

/**
 * Everything the account screen reads. Three methods, no more.
 *
 * Implementations must be safe to call concurrently — the screen issues all
 * three in a single `Promise.all` — and must be consistent as-of one instant,
 * so that `summary.ledgerCents` is a fold over exactly the postings that
 * `listPostings` returns and no others. If the implementation cannot guarantee
 * that from three separate queries, take the booking watermark once and pass
 * it into all three.
 */
export interface AccountDataSource {
  getAccountSummary(
    query: AccountQuery,
  ): Promise<Result<AccountSummary, ErrorShape>>;

  /** Active holds first, then recently closed ones, newest first within each. */
  listHolds(query: AccountQuery): Promise<Result<readonly Hold[], ErrorShape>>;

  /** Newest first. */
  listPostings(
    query: PostingsQuery,
  ): Promise<Result<readonly Posting[], ErrorShape>>;
}
