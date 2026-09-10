/**
 * The four fixture states behind the onboarding screen's data contract.
 *
 * `default` is not here: it is the live derived state, read from Neon by
 * `createLiveOnboardingSource()` in `src/lib/kyb/wire.ts`. These four exist so
 * `loading`, `empty`, `error` and — the one that matters — `edge` can be shown
 * on demand, in order, in front of a panel, without breaking a database or
 * spending a real verification session to reproduce a state.
 *
 * EVERY GATE DECISION HERE IS COMPUTED, NOT WRITTEN DOWN. The fixtures build a
 * `BusinessKybState` and hand it to the real `canTransact()`, through the same
 * `gateView()` the live source uses. So a fixture cannot show a denial the
 * predicate would not produce, and it cannot show an allowance either: if
 * somebody weakened the gate, these rows would change with it.
 *
 * The ids and EINs are the seeded ones, so a fixture row and a live row of the
 * same business are the same business.
 */

import { canTransact, type BusinessKybState } from "@/lib/kyb";
import { fail, ok } from "@/lib/result";

import type {
  BusinessKybView,
  LegView,
  OnboardingDataSource,
  OnboardingSnapshot,
  WiringView,
} from "./data-contract";
import { gateView } from "./gate-view";
import { verdictView } from "./verdict";
import type { DemoState } from "./demo-state";

/** Fixed, so ages and screenshots are reproducible. */
export const DEMO_NOW = "2026-09-10T18:20:00.000Z"; // 14:20 ET

/** How long `?state=loading` holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const RIDGELINE_ID = "e274546d-6bdd-5266-b0fb-cc839a7811f9";

/**
 * The wiring the edge state describes: a live director leg, a simulated
 * registry leg, and therefore a simulated ceiling. It is the wiring this
 * deployment actually runs, restated as a fixture so the edge state reads
 * consistently even with no keys present.
 */
const EDGE_WIRING: WiringView = {
  director: {
    leg: "director_kyc",
    label: "director / control-person KYC",
    mode: "live",
    provider: "stripe-identity",
    evidence: "live",
    reason:
      "Stripe Identity verification sessions — a real third-party KYC call (POST /v1/identity/verification_sessions), and on the brief's own KYC identity menu, so this half is compliant rather than substituted.",
    missingEnv: [],
    compliance: "on-brief",
    complianceLabel: "on the brief's menu",
    complianceNote:
      "The brief's KYC identity menu names Persona, Sumsub, Stripe Identity and Onfido. This leg is Stripe Identity, so it is one of the named options — compliant, not substituted.",
    limits: [
      "it verifies a DOCUMENT and a selfie — it does not prove that person controls this business",
      "it does not check the ownership tree or beneficial ownership",
      "it does not screen sanctions, PEP or adverse media",
    ],
    reachableStatuses: ["approved", "pending", "needs_review"],
    reachabilityNote:
      "MEASURED: `rejected` is not reachable on this leg. Stripe will not hand back a terminal session that still carries its refusal — POST /cancel returns 200 with `last_error` set to null — and a cancelled session with no refusal in it is not a decline.",
  },
  registry: {
    leg: "business_registry",
    label: "business registry check",
    mode: "simulated",
    provider: "simulated-registry",
    evidence: "simulated",
    reason:
      "forced to the labelled simulator by KYB_FORCE_SIMULATED, so this state can show the composite's degradation rule on demand. The live default for this leg is GLEIF — itself a SUBSTITUTE for the brief's named KYB vendors (Persona KYB, Middesk, Sumsub KYB), all three of which are gated behind a sales conversation.",
    missingEnv: [],
    compliance: "simulated",
    complianceLabel: "SIMULATED — nobody asked",
    complianceNote:
      "Nobody was asked. This leg is a labelled simulator and its answers are admissible as a demonstration and as nothing else.",
    limits: ["no registry was queried, because nobody was asked"],
    reachableStatuses: ["approved", "pending", "needs_review", "rejected"],
    reachabilityNote: null,
  },
  evidenceCeiling: "simulated",
  healthDisagreement: null,
};

/** A verified Stripe Identity session — a real third party's answer. */
const EDGE_DIRECTOR_LEG: LegView = {
  leg: "director_kyc",
  label: "director / control-person KYC",
  provider: "stripe-identity",
  reference: "vs_1UEDemoEDGE00000000000000",
  status: "approved",
  evidence: "live",
  rawStatus: "verified",
  providerCode: "stripe_identity_verified",
  citation:
    "Stripe Identity verification session vs_1UEDemoEDGE00000000000000 — status verified; re-readable with GET /v1/identity/verification_sessions/{id}",
  checks: [
    {
      name: "director_identity_document",
      status: "passed",
      reasons: ["stripe identity session status: verified"],
    },
    { name: "provider_outcome", status: "passed", reasons: ["stripe_identity_verified"] },
  ],
  observedAt: "2026-09-10T18:05:00.000Z",
};

/** The other half, which nobody outside this system performed. */
const EDGE_REGISTRY_LEG: LegView = {
  leg: "business_registry",
  label: "business registry check",
  provider: "simulated-registry",
  reference: `sim.business_registry.approved.${RIDGELINE_ID}`,
  status: "approved",
  evidence: "simulated",
  rawStatus: "simulated:approved",
  providerCode: "simulated:approved",
  // Deliberately null. A simulated leg cites nothing, because there is nothing
  // to cite, and the screen renders that absence rather than filling it in.
  citation: null,
  checks: [
    {
      name: "business_registry_match",
      status: "passed",
      reasons: ["simulated: business id number matched the registry"],
    },
    { name: "provider_outcome", status: "passed", reasons: ["simulated:approved"] },
    {
      name: "business_watchlist",
      status: "not_applicable",
      reasons: ["simulated: no watchlist provider is configured"],
    },
  ],
  observedAt: "2026-09-10T18:05:00.000Z",
};

/** Build a row the same way the live source does: state in, predicate out. */
function business(
  fields: Omit<BusinessKybView, "gate" | "gateIfLiveRequired">,
): BusinessKybView {
  const state: BusinessKybState = {
    businessId: fields.businessId,
    status: fields.status,
    evidence: fields.evidence,
    decidedAt: fields.decidedAt,
  };
  return {
    ...fields,
    gate: gateView(canTransact(state, { requireLiveEvidence: false })),
    gateIfLiveRequired: gateView(canTransact(state, { requireLiveEvidence: true })),
  };
}

/**
 * Attribution is DERIVED here exactly as it is for a live row — same function,
 * same leg inputs. A fixture that could write its own "third-party verdict"
 * badge would be the forgery this screen exists to make impossible.
 */
function withVerdict(
  fields: Omit<BusinessKybView, "gate" | "gateIfLiveRequired" | "verdict">,
): BusinessKybView {
  return business({
    ...fields,
    verdict: verdictView(fields.status, fields.evidence, fields.legs),
  });
}

/**
 * THE EDGE STATE.
 *
 * One business. One leg answered by a third party, one by us. Both approve, so
 * the composite approves — and the label reads `simulated`, because a
 * verification is only as live as its least live leg. The two gate columns are
 * the payoff: this row may transact under this deployment's policy and may not
 * under one that requires live evidence, and the difference is a single flag
 * rather than a different code path.
 */
const EDGE: OnboardingSnapshot = {
  asOf: DEMO_NOW,
  wiring: EDGE_WIRING,
  businesses: [
    withVerdict({
      businessId: RIDGELINE_ID,
      legalName: "Ridgeline Robotics, Inc.",
      ein: "000000000",
      status: "approved",
      evidence: "simulated",
      legsOnFile: 2,
      decidedAt: "2026-09-10T18:05:00.000Z",
      legs: [EDGE_DIRECTOR_LEG, EDGE_REGISTRY_LEG],
      depositAccount: {
        id: "0a9b1f2c-0000-5000-a000-00000000d101",
        code: "2100",
        name: "Ridgeline Robotics, Inc. — business current account",
      },
    }),
  ],
};

const EMPTY: OnboardingSnapshot = {
  asOf: DEMO_NOW,
  wiring: EDGE_WIRING,
  businesses: [],
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createFixtureSource(state: DemoState): OnboardingDataSource {
  return {
    async getSnapshot() {
      if (state === "loading") {
        // A genuinely slow read, so the Suspense fallback is the real one.
        await sleep(DEMO_LOADING_MS);
        return ok(EDGE);
      }
      if (state === "empty") return ok(EMPTY);
      if (state === "error") {
        return fail(
          "KYB_READ_FAILED",
          "The verification state could not be read. Nothing was written — this is a read, and kyb_verification_leg holds no UPDATE or DELETE grant to write with.",
        );
      }
      return ok(EDGE);
    },
  };
}
