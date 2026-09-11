/**
 * The pots screen's data contract.
 *
 * Same seam and the same rules as the standing-orders and breaks screens:
 * nothing under `src/components/pots/**` opens a connection, imports
 * `postgres`, or reaches into `src/lib/pots/*` for anything but these types.
 * The screen depends on this interface; `src/lib/pots/screen.ts` implements it
 * against the live database and `./fixtures.ts` implements it without one.
 *
 * Shape notes:
 *
 * - **Every amount is integer minor units (US cents)**, never dollars, never a
 *   float. `number` rather than `bigint` because these cross the server/client
 *   boundary and `bigint` does not survive JSON; `src/lib/pots/**` is `bigint`
 *   throughout and narrows once, at the edge, in `screen.ts`.
 * - **The identity is carried as both sides and the difference**, never as a
 *   boolean. A screen that says "balanced: yes" is asking to be believed; a
 *   screen that prints `main + Σ pots` and `subtree` and `0` beside each other
 *   can be checked by the person reading it.
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen never writes.** Opening a pot and moving money are server
 *   actions raised from a form; a render is not one.
 */

import type { ErrorShape, Result } from "@/lib/result";
import type { MoveDirection } from "@/lib/pots/model";

/** Integer minor units (US cents). Never dollars. */
export type Cents = number;
/** ISO 8601 instant. */
export type Instant = string;
/** `YYYY-MM-DD`. The value-date axis, not an instant. */
export type ValueDate = string;

export type { MoveDirection };

/* -------------------------------------------------------------------------- */
/* A pot                                                                      */
/* -------------------------------------------------------------------------- */

export type PotView = {
  readonly potId: string;
  readonly name: string;
  readonly purpose: string | null;
  /** `2100.<pot uuid>` — its position in the chart, shown rather than described. */
  readonly accountCode: string;
  readonly accountId: string;
  readonly balanceCents: Cents;
  readonly openedAt: Instant;
  /** Share of the customer's total deposit liability, in whole percent. */
  readonly sharePercent: number;
};

/* -------------------------------------------------------------------------- */
/* The identity                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `main + Σ pots = total deposit liability`, with both derivations carried.
 *
 * `totalCents` is the sum this screen computed from the rows it is showing.
 * `subtreeCents` comes from `v_pot_subtree`, a recursive walk of
 * `account.parent_id` that never reads the `pot` table. `differenceCents` is
 * the subtraction, and it is rendered — a zero somebody can see beats a tick
 * somebody has to trust.
 */
export type IdentityView = {
  readonly mainCents: Cents;
  readonly potsCents: Cents;
  readonly totalCents: Cents;
  readonly subtreeCents: Cents;
  readonly differenceCents: Cents;
  readonly holds: boolean;
};

/**
 * The four figures `availableBalance()` returns for the MAIN leaf.
 *
 * `ledgerCents` here is the main leaf's balance and NOT the customer's total:
 * money in a pot has left this account, which is the entire mechanism by which
 * a pot reduces what can be spent.
 */
export type AvailabilityView = {
  readonly ledgerCents: Cents;
  readonly holdsCents: Cents;
  readonly unclearedCents: Cents;
  readonly availableCents: Cents;
};

/* -------------------------------------------------------------------------- */
/* A movement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One internal transfer, as the journal holds it.
 *
 * `railColumns` carries the four fields that would name an external fact if
 * there were one. They are printed because the claim being made is that this
 * entry touched no rail, and the way to show that claim is the columns that
 * would have to be populated for it to be false.
 */
export type MovementView = {
  readonly entryId: string;
  readonly valueDate: ValueDate;
  readonly bookingSeq: string;
  readonly bookingTime: Instant;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly idempotencyKey: string;
  readonly actorName: string;
  readonly potId: string;
  readonly potName: string;
  readonly direction: MoveDirection;
  /** Always positive. The direction says which way; the sign is on the lines. */
  readonly amountCents: Cents;
  /** The two lines, signed exactly as stored: debit positive, credit negative. */
  readonly lines: readonly MovementLineView[];
  readonly railColumns: {
    readonly rail: string | null;
    readonly externalRef: string | null;
    readonly holdId: string | null;
    readonly inboxId: string | null;
  };
};

export type MovementLineView = {
  readonly accountLabel: string;
  readonly accountCode: string;
  readonly amountCents: Cents;
  readonly side: "debit" | "credit";
};

/* -------------------------------------------------------------------------- */
/* Invariants                                                                 */
/* -------------------------------------------------------------------------- */

export type InvariantView = {
  readonly view: string;
  readonly rows: number;
  readonly what: string;
};

/* -------------------------------------------------------------------------- */
/* The whole screen                                                           */
/* -------------------------------------------------------------------------- */

export type BusinessOption = {
  readonly businessId: string;
  readonly legalName: string;
  readonly mainAccountId: string;
};

export type PotsView = {
  /** Where these figures came from, said on the screen's face. */
  readonly source: "live" | "fixture";
  readonly asOf: Instant;
  /** Today in book time. The value date a move posted now would carry. */
  readonly bookDate: ValueDate;
  readonly businesses: readonly BusinessOption[];
  readonly selected: BusinessOption | null;
  readonly pots: readonly PotView[];
  readonly identity: IdentityView | null;
  readonly availability: AvailabilityView | null;
  readonly movements: readonly MovementView[];
  readonly invariants: readonly InvariantView[];
  /**
   * Set on the `edge` state only: the refusal, already decided, with its
   * arithmetic. Rendered as the screen's headline so the case that matters is
   * the first thing on it rather than something a viewer has to reproduce.
   */
  readonly refusal: RefusalView | null;
};

export type RefusalView = {
  readonly code: string;
  readonly reason: string;
  readonly potName: string;
  readonly direction: MoveDirection;
  readonly requestedCents: Cents;
  readonly coverCents: Cents;
  readonly shortfallCents: Cents;
};

export type PotsResult = Result<PotsView, ErrorShape>;

/** What the page asks its data source for. One call, one consistent snapshot. */
export type PotsDataSource = {
  load(args: {
    readonly businessId: string | null;
    /**
     * Run the edge probe: decide a move of one cent MORE than this customer's
     * live available balance, with the same pure function the transaction uses,
     * and return the refusal in `refusal`. Reads only — nothing is posted, no
     * lock is taken, and the four balances the refusal quotes are the live
     * ones.
     */
    readonly edge?: boolean;
  }): Promise<PotsResult>;
};
