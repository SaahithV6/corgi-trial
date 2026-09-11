/**
 * What `/client/pots` renders, as one shape.
 *
 * The same contract discipline as `@/components/client/contract`: the view is
 * a pure function of this value, money stays `bigint` on the boundary because
 * every consumer of it is a SERVER component, and NO ROW CARRIES A TENANT
 * DISCRIMINATOR. There is no `businessId` on a `PotLine`, so no component can
 * write `pots.filter(p => p.businessId === mine)` and turn isolation into a
 * step in a program. The scoping happened in the `WHERE business_id = $1`
 * clause that produced the row.
 *
 * `subject` is the single exception and it names the SUBJECT of the screen —
 * whose pots these are — not a filter key. It is also what the three forms
 * post back as a hidden field, where it is re-checked as a predicate rather
 * than trusted.
 */

import type { BusinessRef } from "@/components/client/contract";

/** One pot, as the customer refers to it. */
export type PotLine = {
  readonly potId: string;
  readonly name: string;
  readonly purpose: string | null;
  readonly balanceCents: bigint;
  /** `2100.<uuid>` — a real account under the customer's own deposit leaf. */
  readonly accountCode: string;
  readonly openedAt: string;
};

/**
 * The five terms of `ledger_availability()`, carried across unchanged.
 *
 * Nothing on this screen sums a journal line, subtracts a hold or clamps
 * anything at zero. These arrive from `readBalanceScreen()`, which reads
 * `availableBalance()` -> `ledger_availability()`, migration 0022 — the same
 * function the staff console reads and the same one `/client` restates. A
 * second definition of "available" is a defect in this codebase and one has
 * already shipped once.
 */
export type AvailabilityTerms = {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  readonly pendingOutboundCents: bigint;
  readonly availableCents: bigint;
};

/**
 * `main + Σ pots = total`, with the independent second derivation beside it.
 *
 * `subtreeCents` comes from `v_pot_subtree`, which walks `account.parent_id`
 * recursively and never reads the `pot` table at all. Agreement between the
 * two is two routes to one number rather than the same SUM printed twice, so
 * the screen shows both figures and their difference instead of a green tick.
 */
export type PotIdentity = {
  readonly mainCents: bigint;
  readonly potsCents: bigint;
  readonly totalCents: bigint;
  readonly subtreeCents: bigint;
  readonly holds: boolean;
};

export type ClientPotsScreen = {
  readonly subject: {
    readonly businessId: string;
    readonly legalName: string;
    readonly accountName: string | null;
    readonly asOf: string;
    readonly live: boolean;
    readonly businesses: readonly BusinessRef[];
  };
  readonly pots: readonly PotLine[];
  readonly terms: AvailabilityTerms;
  /** `null` when this business has no deposit leaf, so the identity has no subject. */
  readonly identity: PotIdentity | null;
};
