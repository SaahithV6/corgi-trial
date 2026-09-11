/**
 * Pure derivations for the account screen.
 *
 * Everything the screen needs to *say* about the numbers, computed here in
 * integer cents and unit-tested, rather than inline in JSX where it cannot be
 * asserted. The components below this file are strictly presentation.
 */

import type { AccountSummary, Cents, Hold, Posting } from "./data-contract";

/* -------------------------------------------------------------------------- */
/* Holds                                                                      */
/* -------------------------------------------------------------------------- */

export type HoldStatus =
  /** Withholding money right now: `remainingCents > 0`. */
  | "active"
  /** Closed, and the network captured more than it authorised. */
  | "over_captured"
  /** Closed and fully reconciled: cleared exactly what was authorised, or reversed. */
  | "closed";

/**
 * `H(E) = 0 if closed(E) else max(A(E) − C(E), 0)` — §8.1, and the formula
 * DECISIONS 006 confirmed against Lithic's own arithmetic (400, 100, 0).
 *
 * The screen does not need to compute this: the ledger supplies
 * `remainingCents`. It computes it anyway and compares, because the failure
 * mode this guards against — a consumer that released a hold on
 * `status === "SETTLED"` and freed money that was still authorised — is
 * invisible in the rendered number and obvious in the comparison.
 */
export function expectedRemainingCents(hold: {
  readonly authorisedCents: Cents;
  readonly clearedCents: Cents;
  readonly closed: boolean;
}): Cents {
  if (hold.closed) return 0;
  return Math.max(hold.authorisedCents - hold.clearedCents, 0);
}

/** True when the network captured more than it was authorised for. */
export function isOverCaptured(hold: {
  readonly authorisedCents: Cents;
  readonly clearedCents: Cents;
}): boolean {
  return hold.clearedCents > hold.authorisedCents;
}

/**
 * How much more than the authorisation was captured. Zero when there was no
 * over-capture. This is the amount that was never held and therefore never
 * protected — the money that overdraws an account at a fuel pump.
 */
export function overCaptureCents(hold: {
  readonly authorisedCents: Cents;
  readonly clearedCents: Cents;
}): Cents {
  return Math.max(hold.clearedCents - hold.authorisedCents, 0);
}

export function holdStatus(hold: Hold): HoldStatus {
  if (isOverCaptured(hold)) return "over_captured";
  if (hold.remainingCents > 0) return "active";
  return "closed";
}

/**
 * True when the rail says the authorisation is settled while the hold is still
 * withholding money. DECISIONS 006: this is Lithic's measured behaviour on a
 * partial clearing, and it is the trap the derived hold model exists to avoid.
 */
export function providerStatusDisagrees(hold: Hold): boolean {
  if (hold.providerStatus === null) return false;
  return hold.providerStatus.toUpperCase() === "SETTLED" && hold.remainingCents > 0;
}

/** Active holds first, then the rest; newest first within each group. */
export function sortHolds(holds: readonly Hold[]): readonly Hold[] {
  return [...holds].sort((a, b) => {
    const activeDelta = Number(b.remainingCents > 0) - Number(a.remainingCents > 0);
    if (activeDelta !== 0) return activeDelta;
    return b.placedAt.localeCompare(a.placedAt);
  });
}

/* -------------------------------------------------------------------------- */
/* The gap between the two balances                                           */
/* -------------------------------------------------------------------------- */

export type ReconciliationLine = {
  readonly key: "ledger" | "holds" | "uncleared" | "committed" | "available";
  readonly label: string;
  readonly cents: Cents;
  /** How the line combines into the total: `+`, `−`, or `=` for the result. */
  readonly operator: "+" | "−" | "=";
  readonly hint: string;
};

export type Reconciliation = {
  readonly lines: readonly ReconciliationLine[];
  /** `ledger − activeHolds − unclearedCredits − committed`, in integers. */
  readonly derivedAvailableCents: Cents;
  /** True when the ledger's own `availableCents` agrees with the derivation. */
  readonly reconciles: boolean;
  /** Signed difference when it does not reconcile; zero when it does. */
  readonly driftCents: Cents;
  /** True when the two headline balances are equal — nothing is being withheld. */
  readonly balancesAgree: boolean;
};

/**
 * Decompose the gap between ledger and available into the two things that
 * cause it, and check the decomposition.
 *
 * This is the whole argument of the screen expressed as data: available is not
 * a stored number, it is `ledger` minus what is being withheld, and the
 * withholding is itemised so that a viewer can see *which* $50 is missing.
 */
export function reconcileBalances(summary: AccountSummary): Reconciliation {
  const derivedAvailableCents =
    summary.ledgerCents -
    summary.activeHoldsCents -
    summary.unclearedCreditsCents -
    summary.pendingOutboundCents;

  const driftCents = summary.availableCents - derivedAvailableCents;

  const lines: readonly ReconciliationLine[] = [
    {
      key: "ledger",
      label: "Ledger balance",
      cents: summary.ledgerCents,
      operator: "+",
      hint: "Settled postings only. A card authorisation never moves this.",
    },
    {
      key: "holds",
      label: "Active holds",
      cents: summary.activeHoldsCents,
      operator: "−",
      hint: "Authorised but not yet cleared, plus manual holds.",
    },
    {
      key: "uncleared",
      label: "Uncleared credits",
      cents: summary.unclearedCreditsCents,
      operator: "−",
      hint: "Money received but not yet available under the funds-availability policy.",
    },
    {
      key: "committed",
      label: "Committed outflows",
      cents: summary.pendingOutboundCents,
      operator: "−",
      hint: "Debits booked for a future value date. No hold row — a journal entry.",
    },
    {
      key: "available",
      label: "Available balance",
      cents: summary.availableCents,
      operator: "=",
      hint: "What the business can actually spend right now.",
    },
  ];

  return {
    lines,
    derivedAvailableCents,
    reconciles: driftCents === 0,
    driftCents,
    balancesAgree: summary.availableCents === summary.ledgerCents,
  };
}

/* -------------------------------------------------------------------------- */
/* Postings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Walk the ledger balance backwards through a newest-first posting list.
 *
 * The running balance is a fold, not a column (§10): the number beside a row is
 * derived here from the current balance and the deltas above it, so nothing on
 * this screen can display a stored balance that has drifted from its postings.
 *
 * Memo postings get `null` — they have no ledger effect, and showing the
 * unchanged balance next to them would imply one.
 */
export function runningLedgerBalances(
  postings: readonly Posting[],
  ledgerCents: Cents,
): readonly (Cents | null)[] {
  let running = ledgerCents;
  const out: (Cents | null)[] = [];

  for (const posting of postings) {
    if (posting.ledgerDeltaCents === null) {
      out.push(null);
      continue;
    }
    out.push(running);
    running -= posting.ledgerDeltaCents;
  }

  return out;
}

/** True when a posting touched availability but not the ledger. The demo, in one predicate. */
export function isMemoOnly(posting: Posting): boolean {
  return posting.ledgerDeltaCents === null;
}
