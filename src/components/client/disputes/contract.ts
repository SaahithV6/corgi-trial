/**
 * What `/client/disputes` renders, as one shape.
 *
 * The same discipline `src/components/client/contract.ts` states at length and
 * for the same reasons, so this file only records where it differs:
 *
 *   * MONEY STAYS `bigint`. Every view below is a server component, so there is
 *     no serialisation boundary for a `bigint` to fail to cross. The one thing
 *     this screen sends to the browser is the file-a-dispute form, and every
 *     field on it is a string.
 *
 *   * NO ROW CARRIES A `businessId`. A charge a customer may dispute and a case
 *     they have already raised both arrive from a `WHERE business_id = $1`
 *     inside Postgres. If the row carried the tenant, somebody would eventually
 *     filter on it in JavaScript and isolation would stop being a predicate.
 *     `ClientHeader.businessId` is the exception and it names the SUBJECT of
 *     the screen, not a filter key.
 *
 * The screen reuses `ClientHeader` rather than inventing its own, so the
 * business switcher, the `asOf` instant and the value date mean exactly what
 * they mean on the other five client screens.
 */

import type { ClientHeader } from "@/components/client/contract";
import type { DisputeReason } from "@/lib/disputes";

/**
 * One settled card transaction this customer may still claim against.
 *
 * `outstandingCents` is `netChargeCents - alreadyClaimedCents`, computed by the
 * library's own SQL and carried here unchanged — the screen never re-derives it
 * and the form never sends it back. When this customer files, the amount comes
 * from this subtraction done again server-side at the moment of the write, not
 * from anything the browser posted.
 */
export type DisputableCharge = {
  readonly entryId: string;
  readonly valueDate: string;
  readonly description: string;
  /** The merchant reference the card network gave us, or `null`. */
  readonly externalRef: string | null;
  readonly netChargeCents: bigint;
  readonly alreadyClaimedCents: bigint;
  readonly outstandingCents: bigint;
  /** `null` when the clearing could not be matched back to a card on file. */
  readonly cardLastFour: string | null;
  readonly cardNickname: string | null;
};

/** One step that has already happened on a case, in the customer's words. */
export type CaseStep = {
  readonly id: string;
  readonly kind: string;
  /** What happened, said plainly. Never the enum. */
  readonly sentence: string;
  readonly valueDate: string;
  /** True when this step was a Corgi decision rather than the customer's. */
  readonly byCorgi: boolean;
  readonly amountCents: bigint | null;
};

/**
 * A case this customer has raised.
 *
 * `status` is the fold `v_dispute_state` computes; there is no stored status
 * column anywhere behind it. `statusMeaning` is the library's own sentence for
 * that status, not a second vocabulary invented on this screen.
 */
export type CustomerCase = {
  readonly disputeId: string;
  readonly caseRef: string;
  readonly disputedEntryId: string;
  readonly reason: DisputeReason;
  readonly reasonWord: string;
  readonly narrative: string;
  readonly amountCents: bigint;
  readonly status: string;
  readonly statusMeaning: string;
  readonly isClosed: boolean;
  readonly valueDate: string;
  readonly networkOutsideDate: string;
  readonly daysToOutsideDate: number;
  /** What has actually been advanced. `0n` until an operator grants credit. */
  readonly advancedCents: bigint;
  /** Of the advance, what is still withheld by the dispute's own hold. */
  readonly heldCents: bigint;
  readonly steps: readonly CaseStep[];
};

/** A reason the customer may pick, with the network's code resolved for them. */
export type ReasonOption = {
  readonly reason: DisputeReason;
  /** The customer's sentence. */
  readonly label: string;
  /** `visa/10.4`. Shown as provenance; the server resolves it, not the form. */
  readonly networkCode: string;
  /** The network's own wording for that code, unedited. */
  readonly networkLabel: string;
};

export type DisputesScreen = {
  readonly header: ClientHeader;
  readonly charges: readonly DisputableCharge[];
  readonly cases: readonly CustomerCase[];
  readonly reasons: readonly ReasonOption[];
  /**
   * `ledger_availability()`'s own answer for this business, carried unchanged.
   *
   * On screen so the customer can see that filing a dispute did NOT change what
   * they can spend. It is read through `readBalanceScreen`, which is the same
   * reader `/client` uses; this screen computes no availability of its own.
   */
  readonly availableCents: bigint;
  readonly ledgerCents: bigint;
};
