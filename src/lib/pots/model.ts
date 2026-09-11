/**
 * Pots: the decisions, as pure functions.
 *
 * Nothing in this file touches Postgres, `process`, or the clock. That is not
 * tidiness — it is what lets the one rule that matters be unit-tested without a
 * database and re-run identically inside the transaction that posts the money:
 *
 *     you cannot earmark money you do not have AVAILABLE.
 *
 * ---------------------------------------------------------------------------
 * WHY `available` AND NOT `ledger`
 * ---------------------------------------------------------------------------
 *
 * `availableBalance()` is
 * `ledger − active holds − uncleared credits − committed outflows`. A
 * $50.00 fuel-pump authorisation is money already committed to a merchant; an
 * ACH credit that has not cleared can still be pulled back. Both are in the
 * ledger balance and neither is spendable, so allowing either to be moved into
 * a pot would let a customer "set aside for payroll" money that a card
 * settlement is about to take. The gate is `available`, and the refusal names
 * all four figures so the customer can see which one bit.
 *
 * The mirror rule going the other way is different and deliberately so: a move
 * OUT of a pot is capped by the pot's own balance, not by anything on the main
 * account. A pot has no holds against it (nothing external can authorise
 * against a pot) so its available balance IS its ledger balance, and a pot can
 * never go negative — see `v_pot_negative`, which is an invariant view.
 *
 * A DEPOSIT account, by contrast, is allowed to go negative: an over-captured
 * authorisation settles above what was authorised and the honest answer is an
 * overdraft. The asymmetry is real. An overdraft is a fact about the world; a
 * negative pot would only ever be a bug in this file.
 */

import { formatUsd } from "@/lib/format/money";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** `in` earmarks money; `out` releases it back to the spendable balance. */
export const MOVE_DIRECTIONS = ["in", "out"] as const;

export type MoveDirection = (typeof MOVE_DIRECTIONS)[number];

export function isMoveDirection(value: unknown): value is MoveDirection {
  return typeof value === "string" && MOVE_DIRECTIONS.some((d) => d === value);
}

/**
 * The five figures `availableBalance()` returns, as this module needs them.
 *
 * Structurally identical to `AvailableBalance` in `ledger/balances.ts` and
 * deliberately restated rather than imported: that module is `server-only`, and
 * this one has to be importable by a unit test that holds no credentials.
 */
export interface Availability {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  /** Debits booked for a future value date: committed out, no hold row. */
  readonly pendingOutboundCents: bigint;
  readonly availableCents: bigint;
}

export const REFUSAL_CODES = [
  "AMOUNT_NOT_POSITIVE",
  "INSUFFICIENT_AVAILABLE",
  "INSUFFICIENT_POT",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type MoveDecision =
  | { readonly kind: "allow"; readonly amountCents: bigint }
  | {
      readonly kind: "refuse";
      readonly code: RefusalCode;
      /** One sentence, with the arithmetic in it. Rendered verbatim. */
      readonly reason: string;
      readonly requestedCents: bigint;
      /** What was actually there to draw on. */
      readonly coverCents: bigint;
      /** `requested − cover`, always positive on a refusal. */
      readonly shortfallCents: bigint;
    };

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The refusal sentences quote money, so they go through the one formatter.
 *
 * `format/money.ts` is a pure module — no `server-only`, no I/O — so importing
 * it here keeps this file unit-testable without credentials while making it
 * impossible for a refusal to render a figure differently from the table
 * beside it. There is no `/ 100` and no `toFixed` on this path: `formatUsd`
 * does integer division and remainder on `bigint`.
 */
const usd = (cents: bigint): string => formatUsd(cents);

/**
 * May this move be posted?
 *
 * Called TWICE on the write path, on purpose: once to draw the screen, and
 * again inside the transaction that posts the entry, after
 * `lock_business_deposits()` has serialised every other mover of this
 * customer's money. The first answer is a forecast and the second is the
 * decision. Two concurrent moves that both read $100.00 available cannot both
 * post $80.00, because the second one re-reads the balance behind the lock.
 */
export function decideMove(
  request: { readonly direction: MoveDirection; readonly amountCents: bigint },
  context: {
    readonly availability: Availability;
    readonly potBalanceCents: bigint;
    readonly potName: string;
  },
): MoveDecision {
  const { amountCents, direction } = request;

  if (amountCents <= 0n) {
    return {
      kind: "refuse",
      code: "AMOUNT_NOT_POSITIVE",
      reason:
        "An internal transfer moves a positive amount. To move money the other way, change the direction — a negative amount is a second way of saying the same thing and the ledger only needs one.",
      requestedCents: amountCents,
      coverCents: 0n,
      shortfallCents: 0n,
    };
  }

  if (direction === "in") {
    const {
      ledgerCents,
      holdsCents,
      unclearedCents,
      pendingOutboundCents,
      availableCents,
    } =
      context.availability;
    if (amountCents > availableCents) {
      return {
        kind: "refuse",
        code: "INSUFFICIENT_AVAILABLE",
        reason:
          `${usd(amountCents)} cannot be earmarked into “${context.potName}”: only ${usd(availableCents)} is available. ` +
          `Available is ledger ${usd(ledgerCents)} − holds ${usd(holdsCents)} − uncleared credits ${usd(unclearedCents)} ` +
          `− committed outflows ${usd(pendingOutboundCents)} = ${usd(availableCents)}, ` +
          `which is ${usd(amountCents - availableCents)} short. ` +
          (ledgerCents >= amountCents
            ? "The LEDGER balance covers it and the AVAILABLE balance does not — that difference is money already committed to a card authorisation or to a credit that has not cleared, and a pot may not earmark it."
            : "The ledger balance does not cover it either."),
        requestedCents: amountCents,
        coverCents: availableCents,
        shortfallCents: amountCents - availableCents,
      };
    }
    return { kind: "allow", amountCents };
  }

  if (amountCents > context.potBalanceCents) {
    return {
      kind: "refuse",
      code: "INSUFFICIENT_POT",
      reason:
        `${usd(amountCents)} cannot be released from “${context.potName}”: the pot holds ${usd(context.potBalanceCents)}, ` +
        `which is ${usd(amountCents - context.potBalanceCents)} short. A pot is our own construct and nothing external can overdraw one, so a negative pot would be a bug rather than a fact — v_pot_negative exists to say so.`,
      requestedCents: amountCents,
      coverCents: context.potBalanceCents,
      shortfallCents: amountCents - context.potBalanceCents,
    };
  }

  return { kind: "allow", amountCents };
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The key that makes a double-submit one transfer.
 *
 * ============================================================================
 * DERIVED FROM SOURCE FACTS, NOT FROM A UUID WE GENERATE.
 *
 * There is no provider event behind an internal transfer — that is the point
 * of it — so the source facts are the ones a person supplies: WHICH POT, WHICH
 * DIRECTION, and the REFERENCE they are moving the money for ("payroll-2026-09",
 * the invoice number, the ticket). `journal_entry.idempotency_key` is UNIQUE,
 * so a browser that re-POSTs, a double-click, or a retry after a timeout all
 * land on the same row and `ledger_append()` returns the ORIGINAL entry id
 * having written nothing.
 *
 * THE AMOUNT IS DELIBERATELY NOT IN THE KEY. If it were, re-submitting
 * "payroll-2026-09" for a different figure would quietly post a SECOND
 * transfer, which is the exact failure idempotency exists to prevent: the
 * reference names the movement, and one movement is one entry. Submitting the
 * same reference with a different amount is refused as a replay, and the screen
 * shows the entry that already exists so the operator can see what was booked.
 * Correcting a transfer that was posted for the wrong amount is a REVERSAL,
 * like every other correction in this system — never an edit and never a
 * silently-appended second leg.
 * ============================================================================
 */
export function moveIdempotencyKey(
  potId: string,
  direction: MoveDirection,
  reference: string,
): string {
  return `pot:${potId}:${direction}:${reference}`;
}

/** The sentence written into `journal_entry.description`. */
export function moveDescription(
  potName: string,
  direction: MoveDirection,
  reference: string,
): string {
  return direction === "in"
    ? `Internal transfer — earmark into pot “${potName}” (${reference})`
    : `Internal transfer — release from pot “${potName}” (${reference})`;
}

/* -------------------------------------------------------------------------- */
/* The two legs                                                               */
/* -------------------------------------------------------------------------- */

export interface TransferLeg {
  readonly accountId: string;
  /** DEBIT positive, CREDIT negative — the one signed column, as everywhere. */
  readonly amountCents: bigint;
  readonly memo: string;
}

/**
 * The entry, as two lines that sum to zero.
 *
 * Both accounts are credit-normal liabilities of the bank inside ONE customer's
 * deposit subtree, so "money moves from A to B" is a DEBIT to A (we owe them
 * less on that leaf) and a CREDIT to B (we owe them more on this one). The
 * customer's total is unchanged — that is what makes the deposit control
 * account still balance — and the money never leaves the entity, so no asset
 * account moves and no rail is touched. `SUM = 0` by construction here, and
 * again in `postEntry()`, and again in the deferred trigger at COMMIT.
 */
export function transferLegs(args: {
  readonly mainAccountId: string;
  readonly potAccountId: string;
  readonly potName: string;
  readonly direction: MoveDirection;
  readonly amountCents: bigint;
}): readonly [TransferLeg, TransferLeg] {
  const { mainAccountId, potAccountId, potName, direction, amountCents } = args;

  if (direction === "in") {
    return [
      {
        accountId: mainAccountId,
        amountCents,
        memo: `earmarked into pot “${potName}”`,
      },
      {
        accountId: potAccountId,
        amountCents: -amountCents,
        memo: `earmarked from the main balance`,
      },
    ];
  }

  return [
    {
      accountId: potAccountId,
      amountCents,
      memo: `released from pot “${potName}”`,
    },
    {
      accountId: mainAccountId,
      amountCents: -amountCents,
      memo: `released back to the main balance`,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* The identity                                                               */
/* -------------------------------------------------------------------------- */

export interface PotFigure {
  readonly potId: string;
  readonly name: string;
  readonly balanceCents: bigint;
}

export interface Identity {
  readonly mainCents: bigint;
  readonly potsCents: bigint;
  readonly totalCents: bigint;
  /** The independent derivation: a recursive walk of the deposit subtree. */
  readonly subtreeCents: bigint;
  /** True when the two derivations agree, which they must. */
  readonly holds: boolean;
}

/**
 * `main + Σ pots = total deposit liability`, computed here rather than trusted.
 *
 * The screen renders both sides of this and the difference between them, so a
 * viewer reads the arithmetic instead of a green tick. `subtreeCents` arrives
 * from `v_pot_subtree`, which walks `account.parent_id` recursively and never
 * looks at the `pot` table at all — so agreement is two independent routes to
 * one number, not the same SUM printed twice.
 */
export function identityOf(
  mainCents: bigint,
  pots: readonly PotFigure[],
  subtreeCents: bigint,
): Identity {
  let potsCents = 0n;
  for (const pot of pots) potsCents += pot.balanceCents;
  const totalCents = mainCents + potsCents;
  return {
    mainCents,
    potsCents,
    totalCents,
    subtreeCents,
    holds: totalCents === subtreeCents,
  };
}
