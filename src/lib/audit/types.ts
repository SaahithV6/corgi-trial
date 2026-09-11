/**
 * The actor trail's shapes.
 *
 * Pure types and pure functions only — no `server-only`, no database — so the
 * screen's fixtures, the view-state parser and the tests can all import them
 * without a connection.
 *
 * The central claim of this module is the ACTOR MODEL, and it is deliberately
 * five values wide where the schema's `actor_kind` enum is three.
 */

/**
 * Who took an action.
 *
 *   human         A person. The ONLY kind that can approve anything: the
 *                 `actor_only_humans_approve` CHECK constraint on `actor`
 *                 makes an approving non-human unrepresentable, and
 *                 `assert_maker_checker()` refuses an `approved` event from
 *                 one besides.
 *
 *   agent         An autonomous MCP client acting under a token. It can raise
 *                 a payment; it lands in the same queue under the same policy
 *                 version as a person typing it in, and it can never approve
 *                 its own. `docs/AGENT-LIMITS.md` is the written half of that
 *                 boundary; this enum is the observable half.
 *
 *   system        A cron tick, a nightly run, the ledger poster. NOT a person
 *                 and deliberately NOT merged with `agent`: "the accrual run
 *                 posted this" and "a model decided to post this" are
 *                 different facts, and collapsing them would make the one
 *                 question a reviewer actually asks — did software decide
 *                 this, or did a person — unanswerable.
 *
 *   provider      A third-party callback: Lithic, Increase, Stripe, Plaid. It
 *                 has no row in `actor` and must not get one: it is a
 *                 counterparty, not a principal of ours, and an id in the
 *                 actor table would make it eligible for `can_approve`.
 *
 *   unattributed  The store recorded the act and not who took it. A
 *                 first-class value BECAUSE it is a defect. Rendering these
 *                 as `system` would hide exactly the holes this trail was
 *                 built to find — 61 card issuances on one business have no
 *                 recorded actor, and the screen says so rather than
 *                 guessing.
 */
export type ActorKind = "human" | "agent" | "system" | "provider" | "unattributed";

export const ACTOR_KINDS: readonly ActorKind[] = [
  "human",
  "agent",
  "system",
  "provider",
  "unattributed",
] as const;

/**
 * Everything except `human` is autonomous.
 *
 * Stated as a predicate over the kind rather than as a column each source
 * fills in, so a new source cannot introduce a sixth kind that quietly reads
 * as a person. `unattributed` counts as autonomous on purpose: an action
 * nobody is recorded as having taken must never be presented as though a
 * human took it.
 */
export function isAutonomous(kind: ActorKind): boolean {
  return kind !== "human";
}

export const ACTOR_KIND_LABEL: Record<ActorKind, string> = {
  human: "Person",
  agent: "Autonomous agent",
  system: "Scheduled run",
  provider: "Provider callback",
  unattributed: "Not recorded",
};

export const ACTOR_KIND_DESCRIPTION: Record<ActorKind, string> = {
  human: "A named person with a login. The only kind that can approve anything.",
  agent: "An MCP client acting on its own. Raises work into the human queue; approves nothing.",
  system: "A cron tick or a batch run. No judgement was exercised.",
  provider: "A third-party told us this happened. Not a principal of ours.",
  unattributed: "The store recorded the act and not the actor. This is a defect, not a category.",
};

/** One action, projected from one row of one append-only store. */
export type ActorAction = {
  /** The source table. Also the registry key in `audit_source`. */
  readonly source: string;
  /** `source:pk`. Stable, so a URL can select a row. */
  readonly actionId: string;
  readonly businessId: string | null;
  /** When it happened, in the world. */
  readonly occurredAt: string;
  /** When this book learned about it. */
  readonly recordedAt: string;
  /** The business date the action belongs to, where the store keeps one. */
  readonly valueDate: string | null;
  readonly actorKind: ActorKind;
  readonly actorId: string | null;
  readonly actorLabel: string;
  readonly surface: string;
  /** Dotted verb, e.g. `payment.approved`. */
  readonly action: string;
  readonly summary: string;
  /** Integer minor units. `null` means "no amount", never zero. */
  readonly amountCents: bigint | null;
  readonly subjectKind: string | null;
  readonly subjectId: string | null;
  /** The journal entry this action posted, where it posted one. */
  readonly entryId: string | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
  /** Derived in SQL so it is defined once: the two clocks disagree. */
  readonly timeAxesDiffer: boolean;
};

/** One projected source, reconciled against the store it reads. */
export type SourceCoverage = {
  readonly source: string;
  readonly disposition: "projected" | "awaiting_wiring";
  readonly surface: string | null;
  /** Counted directly off the table, with no join and no predicate. */
  readonly storedRows: bigint;
  /** Counted off the projection. Must equal `storedRows`. */
  readonly projectedRows: bigint;
  /** Of the projected rows, how many resolve to a business. */
  readonly attributedRows: bigint;
  readonly droppedRows: bigint;
  readonly firstAt: string | null;
  readonly lastAt: string | null;
  readonly reason: string;
};

/** A store that is deliberately NOT on the trail, and the argument for it. */
export type SourceExclusion = {
  readonly source: string;
  readonly surface: string | null;
  readonly reason: string;
  /**
   * True when the reason begins `HOLE.` — a place an action is taken and
   * recorded nowhere, as opposed to one folded into another source.
   */
  readonly isHole: boolean;
};

/**
 * The completeness report. Everything on it is measured, not asserted.
 */
export type Completeness = {
  readonly sources: readonly SourceCoverage[];
  readonly exclusions: readonly SourceExclusion[];
  /**
   * Base tables nobody has classified. MUST be empty for the trail to be
   * able to claim it covers the schema. When it is not empty the screen says
   * which, in red, because a trail that reads complete and is not is worse
   * than no trail.
   */
  readonly unclaimed: readonly string[];
  /** Projected sources the app role can UPDATE or DELETE. MUST be empty. */
  readonly mutable: readonly { readonly source: string; readonly privileges: string }[];
  /**
   * Projected sources defended by privileges alone, with no
   * BEFORE UPDATE OR DELETE trigger, so the OWNER could still rewrite them.
   * Not an invariant — a statement about the strength of the evidence.
   */
  readonly weak: readonly { readonly source: string; readonly surface: string | null }[];
};

/** What the timeline screen renders. */
export type TimelineResult = {
  readonly business: { readonly id: string; readonly legalName: string } | null;
  readonly actions: readonly ActorAction[];
  /** Total matching the filter, before the page limit. */
  readonly matched: number;
  /** Total for this business across every source, before any filter. */
  readonly total: number;
  /** Per-actor-kind counts for the whole business, before any filter. */
  readonly byKind: Readonly<Record<ActorKind, number>>;
  /** Per-source counts for this business, before any filter. */
  readonly bySource: Readonly<Record<string, number>>;
  /**
   * Actions that belong to the whole book rather than to this business — a
   * day close, a reconciliation run, a rate-card change. Printed on the count
   * line even when the scope filter is excluding them, because a screen that
   * silently drops a category is the failure this trail exists to prevent.
   */
  readonly bookWideAvailable: number;
  /** Which filters produced `matched`, echoed back for the count line. */
  readonly filterNote: string | null;
  /** Zero-based page index the rows came from. */
  readonly page: number;
  readonly pageSize: number;
  readonly completeness: Completeness;
  /** Live label for the demo: whether this came from the book or a fixture. */
  readonly live: boolean;
};

export type ActionSummaryRow = {
  readonly source: string;
  readonly count: number;
};
