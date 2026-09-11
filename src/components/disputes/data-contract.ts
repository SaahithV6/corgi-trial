/**
 * The disputes screen's data contract.
 *
 * Same seam and the same rules as the pots and breaks screens: nothing under
 * `src/components/disputes/**` opens a connection, imports `postgres`, or
 * reaches into `src/lib/disputes/*` for anything but these types. The screen
 * depends on this interface; `src/lib/disputes/screen.ts` implements it against
 * the live database and `./fixtures.ts` implements it without one.
 *
 * Shape notes:
 *
 * - **Every amount is integer minor units (US cents)**, never dollars, never a
 *   float. `number` rather than `bigint` because these cross to the client and
 *   `bigint` does not survive JSON; `src/lib/disputes/**` is `bigint`
 *   throughout and narrows once, at the edge, in `screen.ts`.
 * - **The episode carries BOTH entries and the balance at each step**, because
 *   the claim this screen is making — that a clawback is a new event and not a
 *   correction, and that available balance never moved — is only checkable if
 *   the reader can see the two entry ids, their two value dates, and the three
 *   balances beside each other.
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen never writes.** Raising, authorising, granting and resolving
 *   are server actions raised from a form; a render is not one.
 */

import type { ErrorShape, Result } from "@/lib/result";

/** Integer minor units (US cents). Never dollars. */
export type Cents = number;
/** ISO 8601 instant. */
export type Instant = string;
/** `YYYY-MM-DD`. The value-date axis, not an instant. */
export type ValueDate = string;

/* -------------------------------------------------------------------------- */
/* Honest labelling                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What is provider truth and what is ours, printed on the screen's face.
 *
 * Lithic's sandbox has no dispute simulator — `/v1/simulate/chargeback` and
 * `/v1/simulate/dispute` both 404, measured. So the transaction and its
 * settlement are real and everything after intake is an operator action. A
 * screen that showed a dispute lifecycle without saying that would be claiming
 * a live integration it does not have.
 */
export type ProvenanceView = {
  readonly line: string;
  readonly provider: "live" | "operator";
}[];

/* -------------------------------------------------------------------------- */
/* A case                                                                     */
/* -------------------------------------------------------------------------- */

export type CaseView = {
  readonly disputeId: string;
  readonly caseRef: string;
  readonly businessId: string;
  readonly legalName: string;
  readonly disputedEntryId: string;
  readonly reason: string;
  readonly network: string;
  readonly networkCode: string;
  readonly networkLabel: string | null;
  readonly narrative: string;
  readonly amountCents: Cents;
  readonly status: string;
  readonly statusMeaning: string;
  readonly isClosed: boolean;
  readonly raisedBy: string;
  readonly raisedAt: Instant;
  readonly valueDate: ValueDate;
  readonly decidedOn: ValueDate | null;
  /** 120 days out. Drives ageing HERE, never the release of the hold. */
  readonly networkOutsideDate: ValueDate;
  readonly daysToOutsideDate: number;
  /** Advanced and still outstanding, summed from `journal_line`. */
  readonly advancedCents: Cents;
  /** What the memo book is currently withholding for this case. */
  readonly heldCents: Cents;
  readonly holdReleased: boolean | null;
  readonly needsAuthorization: boolean;
  readonly authorizations: number;
  readonly requiredApprovals: number;
  readonly thresholdCents: Cents;
};

/* -------------------------------------------------------------------------- */
/* The episode                                                                */
/* -------------------------------------------------------------------------- */

export type EpisodeEventView = {
  readonly kind: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly valueDate: ValueDate;
  readonly occurredAt: Instant;
  readonly entryId: string | null;
  readonly detail: string | null;
};

export type EpisodeLineView = {
  readonly ordinal: number;
  readonly accountCode: string;
  readonly accountName: string;
  /** Signed exactly as stored: a debit is POSITIVE, a credit is NEGATIVE. */
  readonly amountCents: Cents;
};

export type EpisodeEntryView = {
  readonly entryId: string;
  readonly eventKind: string;
  readonly book: "financial" | "memo";
  readonly entryType: string;
  readonly valueDate: ValueDate;
  readonly bookingSeq: string;
  readonly bookingTime: Instant;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly lines: readonly EpisodeLineView[];
};

/**
 * The customer's position at one point in the episode, derived at a booking
 * watermark rather than read from anywhere.
 *
 * `availableCents` is `ledgerCents - holdsCents` computed at the same
 * watermark, which is why a reader can check the arithmetic by eye instead of
 * trusting the row.
 *
 * ─── THE ACCOUNT-WIDE COLUMNS ARE NOT THE CLAIM ───────────────────────────
 *
 * `ledgerCents`, `holdsCents` and `availableCents` are the WHOLE ACCOUNT at
 * that watermark, so every other thing that happened to this customer in
 * between — a card authorisation opening, a hold expiring, an inbound credit
 * clearing — lands in them. On a quiet book the available column reads the
 * same on all three rows and it is tempting to publish that as the proof.
 *
 * IT IS NOT THE PROOF, and on a busy book it is not even true: measured on
 * 2026-09-11 on case DSP-20260911-8U46YC, available read $65,774.03 on the
 * first two rows and $65,999.03 on the third, because an unrelated $225.00
 * card authorisation released between watermark 5678 and watermark 5762. The
 * screen was claiming "available does not move at all" over a number that had
 * moved for a reason that had nothing to do with the dispute.
 *
 * So the invariant is carried by the three `case…` columns instead: THIS
 * CASE'S OWN contribution to the same three sums, over this dispute's own
 * journal lines and nothing else. `caseAvailableCents` is zero from the grant
 * until the case resolves, whatever else the account is doing, and that is the
 * statement the feature actually makes.
 */
export type EpisodeBalanceView = {
  readonly label: string;
  readonly bookingSeq: string;
  readonly ledgerCents: Cents;
  readonly holdsCents: Cents;
  readonly availableCents: Cents;
  /** This dispute's own contribution to the ledger balance at this watermark. */
  readonly caseLedgerCents: Cents;
  /** This dispute's own contribution to active holds at this watermark. */
  readonly caseHoldsCents: Cents;
  /** `caseLedgerCents - caseHoldsCents`. Zero while the credit is outstanding. */
  readonly caseAvailableCents: Cents;
};

export type EpisodeView = {
  readonly disputeId: string;
  readonly caseRef: string;
  readonly legalName: string;
  readonly status: string;
  readonly amountCents: Cents;
  readonly reason: string;
  readonly network: string;
  readonly networkCode: string;
  readonly disputedEntryId: string;
  readonly disputedValueDate: ValueDate;
  readonly disputedDescription: string;
  readonly events: readonly EpisodeEventView[];
  readonly entries: readonly EpisodeEntryView[];
  readonly balances: readonly EpisodeBalanceView[];
  /** True when no entry in the episode is a `reversal` — the claim, checkable. */
  readonly noReversals: boolean;
};

/* -------------------------------------------------------------------------- */
/* Intake                                                                     */
/* -------------------------------------------------------------------------- */

/** A settled card charge with money still outstanding on it. */
export type ChargeView = {
  readonly entryId: string;
  readonly valueDate: ValueDate;
  readonly description: string;
  readonly netChargeCents: Cents;
  readonly alreadyClaimedCents: Cents;
  readonly disputableCents: Cents;
  readonly cardLastFour: string | null;
  readonly cardNickname: string | null;
  readonly providerAuthId: string | null;
  readonly authOrigin: string | null;
};

export type ReasonCodeView = {
  readonly network: string;
  readonly networkCode: string;
  readonly reason: string;
  readonly networkLabel: string;
  readonly evidenceNote: string;
};

export type PolicyView = {
  readonly thresholdCents: Cents;
  readonly requiredApprovals: number;
  readonly note: string;
};

export type BusinessOption = {
  readonly businessId: string;
  readonly legalName: string;
};

export type SelectedCustomerView = {
  readonly businessId: string;
  readonly legalName: string;
  readonly ledgerCents: Cents;
  readonly holdsCents: Cents;
  readonly availableCents: Cents;
};

/* -------------------------------------------------------------------------- */
/* The view                                                                   */
/* -------------------------------------------------------------------------- */

export type DisputesView = {
  /** Printed on the screen's face. Never inferred by the reader. */
  readonly source: "live" | "fixture";
  readonly asOf: Instant;
  readonly bookDate: ValueDate;
  readonly provenance: ProvenanceView;
  readonly policy: PolicyView | null;
  readonly businesses: readonly BusinessOption[];
  readonly selected: SelectedCustomerView | null;
  readonly cases: readonly CaseView[];
  readonly charges: readonly ChargeView[];
  readonly reasonCodes: readonly ReasonCodeView[];
  /** Populated only in the edge state: one lost-and-clawed-back case, expanded. */
  readonly episode: EpisodeView | null;
  /** Set when the edge state found no lost-and-recovered case to show. */
  readonly episodeMissing: string | null;
};

export type DisputesResult = Result<DisputesView, ErrorShape>;

export type DisputesDataSource = {
  load(args: {
    readonly businessId: string | null;
    readonly disputeId: string | null;
    readonly edge?: boolean;
  }): Promise<DisputesResult>;
};
