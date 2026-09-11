/**
 * The triage screen's data contract.
 *
 * ============================================================================
 * The screen renders this type and nothing else. Every figure on the page is a
 * field below; there is no literal on the page that is a number.
 * ============================================================================
 *
 * `src/app/(app)/dashboard/live-source.ts` implements it against the live book
 * and `./fixtures.ts` implements it four more times, once per non-default URL
 * state. The components import this file and never open a connection — the
 * same rule the account, approvals and console contracts carry, for the same
 * reason: a component that can reach the database is a component that can
 * quietly disagree with the screen it links to.
 *
 * **Money is `bigint` cents, all the way to the renderer.** `<Money>` takes
 * `bigint` directly, so nothing narrows on the way out. Recon is the one
 * exception and it is not this file's choice: `src/lib/recon/**` narrows to
 * `number` at its own contract boundary with a documented refusal rather than
 * a rounding, and this screen re-uses that contract rather than restating it.
 *
 * **Every figure carries the thing that produced it.** `href` on a row is not
 * decoration — the rule this screen is built to is that a number you cannot
 * drill through is a claim, and this build's whole posture is that a figure
 * without its evidence is worthless. Where no drill-through exists, the field
 * is `null` and the renderer says so in words rather than linking to a screen
 * that will not contain the row.
 */

import type { BreakRow, RunRow } from "@/components/recon/data-contract";
import type { Completeness } from "@/lib/audit/types";
import type { ErrorShape, Result } from "@/lib/result";

import type { Classified, Tally } from "./decided";

/** Integer minor units (US cents), exactly as the `int8` column holds them. */
export type Cents = bigint;

/** ISO 8601 UTC. */
export type Instant = string;

/* -------------------------------------------------------------------------- */
/* 1. Is anything wrong right now?                                            */
/* -------------------------------------------------------------------------- */

/**
 * One row out of a red view, printed so the count can be checked.
 *
 * `group` is the view's OWN classifying column — `verdict`, `finding`,
 * `closure_source` — never a label this screen invents. `dbcheck`'s `explain()`
 * prints the same breakdown for the same reason: a count is enough to fail on
 * and never enough to act on.
 */
export type Witness = {
  /** The view's own classifying column, verbatim. Null where it has none. */
  readonly group: string | null;
  /** The provider's id for the authorisation. The join key into every log. */
  readonly providerAuthId: string | null;
  /** Drill-through target, when the view names a hold. */
  readonly holdId: string | null;
  /** Money the view itself names, with the column it came from. */
  readonly figures: readonly { readonly label: string; readonly cents: Cents }[];
  /** Anything else the view says about the row, in its own words. */
  readonly detail: string | null;
};

/** A red view's rows, grouped by the view's own classifying column. */
export type WitnessGroup = {
  readonly group: string;
  readonly rows: number;
  /** Distinct holds, where the view names one. Null where it does not. */
  readonly holds: number | null;
  readonly cents: Cents | null;
  /** What the money column was called. Printed, so the figure is checkable. */
  readonly centsLabel: string | null;
};

export type InvariantCard = {
  readonly classified: Classified;
  /** Up to five rows, for the drill-through. Empty when none were read. */
  readonly witnesses: readonly Witness[];
  readonly groups: readonly WitnessGroup[];
  /**
   * Why there is no drill-through, when there is none.
   *
   * Load-bearing. A red view with no evidence panel and no sentence explaining
   * that is a count presented as a finding.
   */
  readonly noWitnessReason: string | null;
};

export type InvariantSection = {
  readonly cards: readonly InvariantCard[];
  readonly tally: Tally;
  readonly headline: string;
  /** `now()` from the database, at the instant the views were read. */
  readonly readAt: Instant;
};

/* -------------------------------------------------------------------------- */
/* 2. What is waiting on a human?                                             */
/* -------------------------------------------------------------------------- */

export type ApprovalsWaiting = {
  readonly pending: number;
  readonly aboveThreshold: number;
  /** True when the queue read hit its page limit, so `pending` is a floor. */
  readonly capped: boolean;
  readonly oldestAt: Instant | null;
  readonly totalCents: Cents;
  readonly aboveThresholdCents: Cents;
};

export type DisputesWaiting = {
  /** Open, needing an authorisation nobody has granted or declined. */
  readonly needingDecision: number;
  readonly open: number;
  readonly closed: number;
};

/** Deliveries held because they name a referent this book has never seen. */
export type ParkedGroup = {
  readonly kind: string;
  readonly ref: string | null;
  readonly count: number;
  /** The consumer's own refusal, verbatim. Never paraphrased. */
  readonly reason: string | null;
};

export type DeadLetterGroup = {
  readonly provider: string;
  readonly kind: string | null;
  readonly count: number;
  readonly oldestAt: Instant | null;
  readonly newestAt: Instant | null;
  /** The newest dead letter's own `processing_error`, verbatim. */
  readonly reason: string | null;
  /** Oldest age in days, as `v_webhook_dead_letter` computes it. */
  readonly oldestAgeDays: number | null;
};

/** An inbound credit nobody can attribute to a customer. */
export type UnattributedCredit = {
  readonly transferId: string;
  readonly firstSeenAt: Instant;
  readonly ageDays: number;
  readonly deliveries: number;
  readonly stillParked: number;
  readonly deadLettered: number;
  readonly attributed: boolean;
  /** The consumer's own refusal, verbatim. */
  readonly reason: string | null;
};

/** Breaks on the most recent run, with the recon module's own aging applied. */
export type BreaksWaiting = {
  readonly run: RunRow | null;
  /** Live breaks on that run's file, ranked by `recon/aging.ts`'s own order. */
  readonly breaks: readonly BreakRow[];
  readonly bySeverity: readonly { readonly severity: string; readonly count: number }[];
  readonly byAge: readonly { readonly bucket: string; readonly count: number }[];
  /**
   * Open breaks across EVERY file ever ingested.
   *
   * Not drillable from this screen and stated as such: `/reconciliation` is
   * scoped to one run, which is how an ops team works, and these two figures
   * are therefore not comparable.
   */
  readonly bookWide: number;
};

export type HumanSection = {
  readonly approvals: ApprovalsWaiting;
  readonly disputes: DisputesWaiting;
  readonly parked: readonly ParkedGroup[];
  readonly parkedTotal: number;
  readonly deadLetters: readonly DeadLetterGroup[];
  readonly deadLetterTotal: number;
  readonly unattributed: readonly UnattributedCredit[];
  readonly breaks: BreaksWaiting;
};

/* -------------------------------------------------------------------------- */
/* 3. What did the machine do while I was away?                               */
/* -------------------------------------------------------------------------- */

/**
 * One scheduled job, and the trace that would prove it ran.
 *
 * `lastTraceAt` is the newest row in the store the job writes into. It is the
 * job's EFFECT, not its tick: see `traceLimit` on the section below.
 */
export type ScheduledJob = {
  readonly path: string;
  /** The cron expression from `vercel.json`, verbatim. */
  readonly schedule: string;
  readonly what: string;
  /** The store that would carry evidence of a tick that did something. */
  readonly tracedBy: string;
  readonly lastTraceAt: Instant | null;
  readonly traceCount: number;
  /** What the trace says in the store's own vocabulary. */
  readonly traceNote: string;
};

/** What the machine wrote, from the audit trail's own projection. */
export type MachineAction = {
  readonly source: string;
  readonly surface: string;
  readonly actorKind: string;
  readonly count: number;
  readonly newestAt: Instant | null;
};

/** What the standing-order tick refused, and the terms it observed. */
export type Refusal = {
  readonly code: string;
  readonly reason: string;
  readonly count: number;
  readonly newestAt: Instant | null;
  readonly observedAvailableCents: Cents | null;
  readonly shortfallCents: Cents | null;
  /** `decided_by_run` — who ran it. A `test-` prefix is not a cron tick. */
  readonly runPrefix: string;
};

/** Hold closures, grouped by the writer each one declares. */
export type SweepWriter = {
  readonly source: string | null;
  readonly count: number;
  readonly oldestAt: Instant | null;
  readonly newestAt: Instant | null;
};

/** Outbound delivery attempts, by state, with the last HTTP status seen. */
export type OutboundState = {
  readonly state: string;
  readonly count: number;
  readonly newestAt: Instant | null;
  readonly lastStatus: number | null;
};

/**
 * The published `webhookProcessing` field, re-used rather than recomputed.
 *
 * Structurally `WebhookProcessingHealth` from `src/app/api/health/processing.ts`.
 * It is imported as that type in the live source; declared structurally here so
 * that `./fixtures.ts` can build one without importing the health module.
 */
export type ProviderProcessing = {
  readonly provider: string;
  readonly label: string;
  readonly verdict: string;
  readonly note: string;
  readonly lastConsumed: string | null;
  readonly lastDelivery: string | null;
  readonly parked: { readonly count: number };
  readonly deadLettered: {
    readonly count: number;
    readonly sinceLastConsumed: number;
    readonly supersededByConsumption: boolean;
    readonly reason: string | null;
    readonly clearedBy: string | null;
  };
  readonly degradesDeployment: boolean;
};

export type MachineSection = {
  readonly jobs: readonly ScheduledJob[];
  readonly actions: readonly MachineAction[];
  readonly refusals: readonly Refusal[];
  readonly sweeps: readonly SweepWriter[];
  readonly outbound: readonly OutboundState[];
  readonly processing: {
    readonly measured: boolean;
    readonly error: string | null;
    readonly measuredAt: string;
    readonly providers: readonly ProviderProcessing[];
    readonly degradedBy: readonly string[];
  };
  /** The audit trail's own reconciliation of itself. Includes the holes. */
  readonly completeness: Completeness;
};

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

export type Triage = {
  /** `now()` from the database on the live path; a fixed instant on a fixture. */
  readonly readAt: Instant;
  /** `MAX(booking_seq)`, as text. Provenance, so a screenshot is reproducible. */
  readonly bookingWatermark: string;
  readonly invariants: InvariantSection;
  readonly human: HumanSection;
  readonly machine: MachineSection;
  /**
   * False on every fixture state.
   *
   * Drives the LIVE/FIXTURE badge. A screen that let a fixture look live would
   * be the failure the integration table exists to prevent, one screen over —
   * and it matters more here, because the claim this screen makes is "nothing
   * new is wrong with the book".
   */
  readonly live: boolean;
};

export interface TriageDataSource {
  read(): Promise<Result<Triage, ErrorShape>>;
}
