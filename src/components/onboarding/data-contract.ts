/**
 * The onboarding screen's data contract.
 *
 * Same rule as the account and approvals contracts: the screen depends on this
 * interface and on nothing else. `src/lib/kyb/wire.ts` implements it against
 * Neon and the live provider; `fixtures.ts` implements it four more times, once
 * per demo state. Nothing under `src/components/**` opens a connection or
 * imports `postgres`.
 *
 * Shape notes:
 *
 * - **Nothing here is money.** This screen moves no cents and renders none. The
 *   one number it carries is `legsOnFile`, which is a count of evidence rows.
 * - **Every instant is an ISO 8601 UTC string.**
 * - **Failure is a value, not a throw**, so the error state is a branch.
 * - **The screen decides nothing.** `gate` is the output of `canTransact()`,
 *   computed on the server, rendered verbatim. The button it disables is a
 *   courtesy; the server action re-runs the same predicate on every POST.
 * - **`evidence` is never assembled here.** It arrives already derived, by
 *   `v_business_kyb` in Postgres and by `CompositeKybResult` in TypeScript, and
 *   the screen has no way to compute or override it.
 */

import type {
  Evidence,
  KybCheck,
  KybLegKind,
  KybStatus,
  TransactDenialCode,
} from "@/lib/kyb";
import type { ErrorShape, Result } from "@/lib/result";

export type Instant = string;

/**
 * HOW THIS LEG STANDS RELATIVE TO THE BRIEF'S OWN PROVIDER MENU.
 *
 * The two legs are not equally compliant and the screen must not average them
 * into one badge:
 *
 *   on-brief     the provider is named on the brief's list for this slot.
 *                Stripe Identity is on the KYC identity menu (Persona, Sumsub,
 *                Stripe Identity, Onfido), so director KYC needs no apology.
 *   substituted  a real, live third party that is NOT on the brief's list, used
 *                because every option on that list was measured shut. GLEIF is
 *                this. It is live and it is a substitution, and both halves of
 *                that sentence go on screen together or neither does.
 *   simulated    nobody was asked.
 */
export type LegCompliance = "on-brief" | "substituted" | "simulated";

/** Which adapter answers one leg in this deployment, and why. */
export type LegWiringView = {
  readonly leg: KybLegKind;
  readonly label: string;
  readonly mode: "live" | "simulated";
  readonly provider: string;
  readonly evidence: Evidence;
  /** One sentence, safe to print. Names env vars, never values. */
  readonly reason: string;
  /** Env var NAMES only, and only the ones that are absent. */
  readonly missingEnv: readonly string[];

  readonly compliance: LegCompliance;
  /** Four words for a badge. */
  readonly complianceLabel: string;
  /** Where this leg stands against the brief's named options, in one sentence. */
  readonly complianceNote: string;
  /**
   * WHAT THIS LEG DOES NOT PROVE. Rendered next to the leg rather than filed in
   * a document nobody opens: it is the first thing a hostile reviewer should be
   * told, not the first thing they get to discover.
   */
  readonly limits: readonly string[];
  /**
   * The statuses this leg can actually reach ON REAL PROVIDER EVIDENCE, as
   * measured — not the statuses its mapping table contains. Stripe Identity's
   * table maps a `rejected`; the API will not produce one, and a screen that
   * implied otherwise would be claiming a capability nobody has.
   */
  readonly reachableStatuses: readonly KybStatus[];
  /** Why a status in the lattice is missing from `reachableStatuses`. */
  readonly reachabilityNote: string | null;
};

export type WiringView = {
  readonly director: LegWiringView;
  readonly registry: LegWiringView;
  /**
   * The best evidence label this wiring could ever produce. A ceiling, not a
   * claim that anything has been verified.
   */
  readonly evidenceCeiling: Evidence;
  /**
   * Set when `/api/health` would describe a leg differently from the way this
   * screen actually wires it. Rendered loudly: two surfaces disagreeing about
   * live-vs-simulated is the exact failure this codebase keeps catching.
   */
  readonly healthDisagreement: string | null;
};

/** One observation of one leg — the latest row in `kyb_verification_leg`. */
export type LegView = {
  readonly leg: KybLegKind;
  readonly label: string;
  readonly provider: string;
  /** `vs_…`, `HWUPKR0MPOU8FGXBT394`, `sim.…`. Cited, so a reviewer can check it. */
  readonly reference: string;
  readonly status: KybStatus;
  readonly evidence: Evidence;
  /** The provider's own status string, before normalisation. */
  readonly rawStatus: string | null;
  /**
   * The provider's own MACHINE-READABLE code for this answer, when it gave one:
   * `document_unverified_other`, `entity_status_inactive`, `not_in_lei_registry`.
   *
   * Read out of `checks` under the reserved name `provider_outcome` (see
   * `KYB_PROVIDER_CODE_CHECK`), so it survives a page reload without a column
   * that an UPDATE could make disagree with the evidence it came from. This is
   * the field that makes a refusal checkable rather than merely stated.
   */
  readonly providerCode: string | null;
  /**
   * Where this answer can be verified: which registry, which entry, at what
   * corroboration level — or which provider session id to re-read. Null when
   * the leg cites nothing, which a simulated leg never should be able to hide.
   */
  readonly citation: string | null;
  readonly checks: readonly KybCheck[];
  readonly observedAt: Instant;
  /**
   * Set when this observation is a HUMAN's decision rather than a provider's
   * answer. Null on every provider row, in both directions — 0013 refuses a
   * reviewer without a reason and a reason without a reviewer.
   *
   * `overrode` is the latest THIRD-PARTY observation this decision superseded,
   * carried alongside so the screen can show both. That is the whole point:
   * "latest wins" would otherwise hide the registry's own answer behind a green
   * badge, collapsing two facts — what the registry said, and what a person
   * decided — into the one word the review mechanism exists to keep apart.
   */
  readonly review: ReviewView | null;
};

/** A human's decision on one leg, and the provider answer it superseded. */
export type ReviewView = {
  readonly decidedBy: string;
  readonly decidedByActorId: string;
  readonly reason: string;
  readonly decidedAt: Instant;
  readonly overrode: {
    readonly provider: string;
    readonly status: KybStatus;
    readonly rawStatus: string | null;
    readonly providerCode: string | null;
    readonly citation: string | null;
    readonly observedAt: Instant;
  } | null;
};

/** Where a verdict came from. See `src/components/onboarding/verdict.ts`. */
export type VerdictOrigin = "third-party" | "simulated" | "mixed" | "none";

/** One leg, as an attribution for the derived status. */
export type VerdictSourceView = {
  readonly leg: KybLegKind;
  readonly label: string;
  readonly provider: string;
  readonly evidence: Evidence;
  readonly status: KybStatus;
  readonly rawStatus: string | null;
  readonly reference: string;
  readonly providerCode: string | null;
  readonly citation: string | null;
};

/**
 * WHO SAID NO. The derived status, plus the legs that actually set it.
 *
 * Never assembled by a component: it is derived from the leg rows by
 * `verdictView()`, which both the live source and the fixtures call. A screen
 * that could write its own attribution could write a flattering one.
 */
export type VerdictView = {
  readonly status: KybStatus;
  readonly evidence: Evidence;
  /** The legs whose own status equals the derived one — i.e. what caused it. */
  readonly sources: readonly VerdictSourceView[];
  readonly origin: VerdictOrigin;
  /** Four words for a badge. */
  readonly originLabel: string;
  /** One sentence naming the provider and quoting its code. */
  readonly headline: string;
};

/** `canTransact()`'s answer, flattened for rendering. Never re-derived. */
export type TransactGateView = {
  readonly allowed: boolean;
  /** Null exactly when `allowed` is true. */
  readonly code: TransactDenialCode | null;
  readonly message: string;
  readonly status: KybStatus | null;
  readonly evidence: Evidence | null;
};

/** The deposit account, when one has been opened. `null` is the structural gate. */
export type DepositAccountView = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
};

export type BusinessKybView = {
  readonly businessId: string;
  readonly legalName: string;
  /** As stored. The magic EIN is what makes the registry outcome reproducible. */
  readonly ein: string;

  /** Derived by `v_business_kyb`: strictest status across the legs on file. */
  readonly status: KybStatus;
  /** Derived by `v_business_kyb`: `live` only if EVERY leg was live. */
  readonly evidence: Evidence;
  readonly legsOnFile: number;
  readonly decidedAt: Instant | null;

  /** Latest observation per leg. Empty until a verification is started. */
  readonly legs: readonly LegView[];

  /**
   * Which provider produced `status`, and with what code. Rendered at the top
   * of the card, next to the status itself, so a real third-party refusal and a
   * simulated one are distinguishable BY LOOKING rather than by reading source.
   */
  readonly verdict: VerdictView;

  /** `canTransact()` under this deployment's policy. */
  readonly gate: TransactGateView;
  /**
   * The same predicate under `requireLiveEvidence: true` — what this row would
   * do in a deployment that touches real money. Shown side by side so a
   * simulated approval is never mistaken for a verified one.
   */
  readonly gateIfLiveRequired: TransactGateView;

  /**
   * Null until KYB approves. Half the gate is structural: a business with no
   * 2100 account has nowhere for money to land, whatever a flag says.
   */
  readonly depositAccount: DepositAccountView | null;
};

/**
 * One live registry question that is NOT about a business on this book.
 *
 * See `probeRegistry()` in `src/lib/kyb/wire.ts` for why this exists and why it
 * writes nothing. The short version: every seeded business is fictional, so the
 * registry correctly misses on all of them, and a screen that can only ever
 * show a miss cannot distinguish a registry that works from one that shrugs.
 * This asks the same live adapter about anything a reviewer types, and is
 * labelled a question about the registry rather than a verification of anyone.
 */
export type RegistryProbeView = {
  readonly query: string;
  readonly kind: "lei" | "name";
  readonly leg: LegView;
};

export type OnboardingSnapshot = {
  readonly asOf: Instant;
  readonly wiring: WiringView;
  readonly businesses: readonly BusinessKybView[];
};

export interface OnboardingDataSource {
  /** The whole screen in one call. */
  getSnapshot(): Promise<Result<OnboardingSnapshot, ErrorShape>>;
}
