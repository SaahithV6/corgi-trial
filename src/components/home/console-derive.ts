/**
 * The console's arithmetic, in one pure file.
 *
 * ============================================================================
 * Nothing here reads anything. Every function is a fold over values the source
 * already returned, so "the page shows a number the query did not" is a test
 * failure rather than something a reviewer has to catch by eye.
 * ============================================================================
 *
 * Money is `bigint` throughout. There is no `Number()`, no `+` on a string and
 * no division: a total is a sum of integer cents and nothing else. The one
 * comparison that exists (`< 0n`) is against a `bigint` zero, because `0` and
 * `0n` are not the same value to `===` and `eqeqeq` is on.
 */

import type {
  AccountPosition,
  Attention,
  BookTotals,
  Cents,
  Movement,
  PositionTotals,
} from "./console-contract";

/* -------------------------------------------------------------------------- */
/* The book, folded                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Sum one set of positions.
 *
 * `withheld` is folded per account (`ledger − available`) and then summed,
 * rather than computed once from the two totals. Identical arithmetic on any
 * input, and it stays identical if a later account is ever allowed to net
 * against another — which is the kind of change that turns a shortcut into a
 * wrong number six months after somebody took it.
 */
function sumPositions(
  positions: readonly AccountPosition[],
): PositionTotals {
  let ledgerCents = 0n;
  let availableCents = 0n;
  let withheldCents = 0n;
  let negativeAvailable = 0;
  const businesses = new Set<string>();

  for (const position of positions) {
    ledgerCents += position.ledgerCents;
    availableCents += position.availableCents;
    withheldCents += position.ledgerCents - position.availableCents;
    if (position.availableCents < 0n) negativeAvailable += 1;
    businesses.add(position.businessName);
  }

  return {
    ledgerCents,
    availableCents,
    withheldCents,
    accounts: positions.length,
    businesses: businesses.size,
    negativeAvailable,
  };
}

/**
 * Sum the positions — whole book, customers only, and fixtures only.
 *
 * ---------------------------------------------------------------------------
 * THE SPLIT IS THE POINT, AND THE UNSPLIT TOTAL IS STILL PUBLISHED.
 * ---------------------------------------------------------------------------
 *
 * Three of the seven deposit accounts on this book belong to test suites, and
 * one of them — `Holds Integration Fixture Co.` — sits at -$858,941.45 after
 * two $500,000.00 force-posts whose refund was never reached. Summed in
 * silently, this fold reported that the bank held **-$196,505.08** of customer
 * money (measured 2026-09-11T16:00Z). It does not: customers held $105,600.67
 * and test fixtures held -$302,105.75, both true at that one instant. The
 * customer half moves as the demo book moves. The sign of the headline was
 * the defect, and that does not move.
 *
 * `all` is the arithmetic sum of the other two and is deliberately kept. A
 * fold that suppressed it would be the failure it was written to remove — a
 * console quietly disagreeing with `SELECT sum(...)` run by hand — and the
 * three totals reconcile by construction, which `console-derive.test.ts`
 * asserts rather than trusts.
 *
 * Classification happens in `console-source.ts`, once, from the business's own
 * EIN; this file only reads the flag it was handed. See
 * `@/lib/home/fixture-businesses` for why the rows are labelled instead of
 * filtered, deleted or reversed.
 */
export function foldTotals(
  positions: readonly AccountPosition[],
): BookTotals {
  return {
    ...sumPositions(positions),
    live: sumPositions(positions.filter((p) => p.fixture === null)),
    fixture: sumPositions(positions.filter((p) => p.fixture !== null)),
  };
}

/* -------------------------------------------------------------------------- */
/* What is waiting on a person                                                */
/* -------------------------------------------------------------------------- */

export type AttentionItem = {
  readonly key: string;
  readonly count: number;
  /** Already agreeing in number with `count` — "1 account", "3 accounts". */
  readonly label: string;
  /** Where it gets worked. A route that exists in this build. */
  readonly href: string;
  /** What the number means, and why it is or is not alarming. */
  readonly detail: string;
};

/**
 * Everything currently waiting on a human, as rows.
 *
 * Returned in full — including the zeros — so the caller decides what to show
 * and the ordering is not a function of today's data. `pendingCapped` widens
 * the label to "at least", because a count that hit its page limit is a floor
 * and printing it as an exact figure would be a small lie of the same shape as
 * every other lie this page is built to avoid.
 */
export function attentionItems(
  attention: Attention,
): readonly AttentionItem[] {
  /** "1 account", "3 accounts". A count and its noun must agree, always. */
  const plural = (count: number, one: string, many: string): string =>
    count === 1 ? one : many;

  return [
    {
      key: "approvals",
      count: attention.pendingPayments,
      label: `${plural(
        attention.pendingPayments,
        "payment awaiting approval",
        "payments awaiting approval",
      )}${attention.pendingCapped ? " (at least)" : ""}`,
      href: "/approvals",
      detail:
        "Money out, raised and not yet decided. The initiator can never be the approver — the trigger refuses it, not the screen.",
    },
    {
      key: "overdrawn",
      count: attention.overdrawnAccounts,
      label: plural(
        attention.overdrawnAccounts,
        "account overdrawn",
        "accounts overdrawn",
      ),
      href: "/accounts",
      detail:
        "A debit-normal balance on a credit-normal deposit liability. Real, and deliberately not clamped to zero: the customer is genuinely overdrawn.",
    },
    {
      key: "kyb",
      count: attention.businessesNotApproved,
      label: plural(
        attention.businessesNotApproved,
        "business not cleared to transact",
        "businesses not cleared to transact",
      ),
      href: "/onboarding",
      detail:
        "KYB is not approved, so the gate refuses a payment from them. A business gets its 2100 account when KYB approves it, and not before.",
    },
    {
      key: "parked",
      count: attention.parkedWebhooks,
      label: plural(
        attention.parkedWebhooks,
        "webhook delivery parked",
        "webhook deliveries parked",
      ),
      href: "/api/health",
      detail:
        "Verified, stored, and waiting on an entity this book has not seen yet. Not an error and not a drop — they replay when the entity arrives.",
    },
    {
      key: "dead",
      count: attention.deadLetteredWebhooks,
      label: plural(
        attention.deadLetteredWebhooks,
        "webhook delivery dead-lettered",
        "webhook deliveries dead-lettered",
      ),
      href: "/api/health",
      detail:
        "Retry budget exhausted. The payload is still stored verbatim; nothing was discarded, and nothing replays without a person.",
    },
  ];
}

/** The rows worth showing: a count of zero is not work. */
export function outstanding(
  items: readonly AttentionItem[],
): readonly AttentionItem[] {
  return items.filter((item) => item.count > 0);
}

/** One sentence for the panel header, true for any input including none. */
export function summariseAttention(items: readonly AttentionItem[]): string {
  const open = outstanding(items);
  if (open.length === 0) {
    return "Nothing on this book is waiting on a person right now.";
  }
  const total = open.reduce((sum, item) => sum + item.count, 0);
  const noun = total === 1 ? "thing is" : "things are";
  const kinds = open.length === 1 ? "one kind" : `${open.length} kinds`;
  return `${total} ${noun} waiting on a person, across ${kinds}.`;
}

/* -------------------------------------------------------------------------- */
/* Movement                                                                   */
/* -------------------------------------------------------------------------- */

/** Money in or money out, from the customer's side. Never "positive/negative". */
export function directionOf(amountCents: Cents): "in" | "out" {
  return amountCents < 0n ? "out" : "in";
}

/**
 * The correction-lineage note under an entry, or `null` for a plain one.
 *
 * A reversal and its re-book are not mistakes hidden from the operator: they
 * are the only way this ledger corrects anything, because nothing is ever
 * updated in place. Saying so on the row is cheaper than the support ticket
 * that asks why the same settlement appears three times.
 */
export function lineageNote(entryType: string): string | null {
  switch (entryType) {
    case "reversal":
      return "Reversal — the original entry stands and this cancels it. Nothing was edited.";
    case "rebook":
      return "Re-book — the corrected figure, posted after the reversal above it.";
    case "original":
      return null;
    default:
      return `Entry type ${entryType}.`;
  }
}

/** Newest first, by the order we learned things in. A stable, total sort. */
export function newestFirst(
  movements: readonly Movement[],
): readonly Movement[] {
  return [...movements].sort((a, b) => {
    const left = BigInt(a.bookingSeq);
    const right = BigInt(b.bookingSeq);
    if (left === right) return 0;
    return left < right ? 1 : -1;
  });
}
