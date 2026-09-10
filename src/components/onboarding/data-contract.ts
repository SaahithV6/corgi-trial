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
  /** `vs_…`, `inq_…`, `sim.…`. Cited, so a reviewer can check it. */
  readonly reference: string;
  readonly status: KybStatus;
  readonly evidence: Evidence;
  /** The provider's own status string, before normalisation. */
  readonly rawStatus: string | null;
  readonly checks: readonly KybCheck[];
  readonly observedAt: Instant;
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

export type OnboardingSnapshot = {
  readonly asOf: Instant;
  readonly wiring: WiringView;
  readonly businesses: readonly BusinessKybView[];
};

export interface OnboardingDataSource {
  /** The whole screen in one call. */
  getSnapshot(): Promise<Result<OnboardingSnapshot, ErrorShape>>;
}
