/**
 * The wire's tests.
 *
 * NOTHING HERE TOUCHES A NETWORK OR A DATABASE. Every provider call goes
 * through an injected `fetchImpl` and every query through a stub connection, so
 * the suite can assert the exact bytes we would send Stripe — including the
 * fields we deliberately do NOT send — without creating a verification session
 * in a real account.
 *
 * The three properties worth stating up front, because they are what these
 * tests exist to hold:
 *
 *   1. The director leg is a REAL third-party call, made only from `begin()`.
 *      `refresh()` is a GET and creates nothing.
 *   2. The composite degrades: a genuinely live, genuinely approved director
 *      leg combined with a simulated registry leg is `approved` + `simulated`.
 *      That is the edge case the screen is built around.
 *   3. The gate fails closed on every state that is not exactly `approved`, and
 *      each denial carries its own code.
 */

import { describe, expect, it, vi } from "vitest";

import type { Sql } from "@/lib/ledger/db";

/**
 * `wire.ts` reaches the database through `@/lib/ledger/db`, which parses the
 * environment eagerly at import so a malformed DSN kills a process at boot
 * rather than at the first request that needs money. CI holds no credentials,
 * by design, so this supplies a syntactically valid placeholder BEFORE the
 * imports are evaluated — `vi.hoisted` runs first.
 *
 * It never connects to anything. `postgres()` is lazy, and every query in this
 * file goes through `stubConn` instead. An existing DSN is left alone, so
 * running the suite with a real `.env` sourced changes nothing.
 */
vi.hoisted(() => {
  process.env["APP_DATABASE_URL"] ??=
    "postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder";
});

import { selectKybLegs } from "./index";
import { SimulatedRegistryProvider } from "./simulated-registry";
import { CompositeKybProvider } from "./composite";
import type { CreateKybVerificationInput, KybLegProvider, KybLegResult } from "./types";
import { gateView } from "@/components/onboarding/gate-view";

import {
  createWiredKybProvider,
  identitySessionToLeg,
  legRow,
  PLACEHOLDER_REGISTERED_ADDRESS,
  probeRegistry,
  selectWiredLegs,
  STRIPE_IDENTITY_STATUS_MAP,
  StripeIdentityDirectorKycProvider,
  stripeIdentityStatusToKyb,
  transactGateForBusiness,
  wiringView,
} from "./wire";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUSINESS_ID = "e274546d-6bdd-5266-b0fb-cc839a7811f9";

/** A verification session as Stripe actually returned one (test mode, redacted). */
const SESSION = {
  id: "vs_1UED3fDgSL5WTGpmMLYIL1Fe",
  object: "identity.verification_session",
  created: 1789066251,
  last_error: null,
  livemode: false,
  metadata: { reference_id: BUSINESS_ID },
  status: "requires_input",
  type: "document",
  url: "https://verify.stripe.com/start/test_abc123",
};

type Call = { url: string; init: RequestInit };

function recordingFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function bodyOf(call: Call): string {
  return typeof call.init.body === "string" ? call.init.body : "";
}

const INPUT: CreateKybVerificationInput = {
  referenceId: BUSINESS_ID,
  businessName: "Ridgeline Robotics, Inc.",
  taxIdentificationNumber: "000000000",
  registeredAddress: PLACEHOLDER_REGISTERED_ADDRESS,
};

/** A tagged-template stub standing in for the `postgres` client. */
function stubConn(rows: readonly unknown[]): Sql {
  return (() => Promise.resolve([...rows])) as unknown as Sql;
}

// ---------------------------------------------------------------------------
// 1. The status map
// ---------------------------------------------------------------------------

describe("stripeIdentityStatusToKyb", () => {
  it("maps the four published statuses", () => {
    expect(stripeIdentityStatusToKyb("verified")).toBe("approved");
    expect(stripeIdentityStatusToKyb("processing")).toBe("pending");
    expect(stripeIdentityStatusToKyb("requires_input")).toBe("pending");
    expect(stripeIdentityStatusToKyb("canceled")).toBe("needs_review");
  });

  it("treats a requires_input carrying an error as needing a human, not as pending", () => {
    expect(stripeIdentityStatusToKyb("requires_input", "document_unverified_other")).toBe(
      "needs_review",
    );
  });

  it("never lets an unknown status reach approved", () => {
    for (const raw of ["", "ok", "VERIFIED", "verified ", "toString", "succeeded", null, undefined]) {
      expect(stripeIdentityStatusToKyb(raw)).toBe("needs_review");
    }
  });

  it("has no mapping that produces `rejected` — Stripe Identity has no terminal decline", () => {
    expect(Object.values(STRIPE_IDENTITY_STATUS_MAP)).not.toContain("rejected");
  });
});

// ---------------------------------------------------------------------------
// 2. The session mapping
// ---------------------------------------------------------------------------

describe("identitySessionToLeg", () => {
  it("carries the provider's own id, raw status and hosted URL", () => {
    const leg = identitySessionToLeg(SESSION, null);
    expect(leg.leg).toBe("director_kyc");
    expect(leg.provider).toBe("stripe-identity");
    expect(leg.reference).toBe(SESSION.id);
    expect(leg.referenceId).toBe(BUSINESS_ID);
    expect(leg.status).toBe("pending");
    expect(leg.rawStatus).toBe("requires_input");
    expect(leg.hostedUrl).toBe(SESSION.url);
    expect(leg.evidence).toBe("live");
    expect(leg.observedAt).toBe(new Date(SESSION.created * 1000).toISOString());
  });

  it("reads a verified session as approved", () => {
    const leg = identitySessionToLeg({ ...SESSION, status: "verified", url: null }, null);
    expect(leg.status).toBe("approved");
    expect(leg.hostedUrl).toBeNull();
  });

  it("quotes last_error on the check rather than dropping it", () => {
    const leg = identitySessionToLeg(
      {
        ...SESSION,
        status: "requires_input",
        last_error: { code: "document_unverified_other", reason: "the document could not be read" },
      },
      null,
    );
    expect(leg.status).toBe("needs_review");
    const reasons = leg.checks.flatMap((c) => c.reasons);
    expect(reasons.some((r) => r.includes("document_unverified_other"))).toBe(true);
    expect(reasons).toContain("the document could not be read");
  });

  it("falls back to the business id we sent when the provider echoes no metadata", () => {
    const leg = identitySessionToLeg({ ...SESSION, metadata: {} }, BUSINESS_ID);
    expect(leg.referenceId).toBe(BUSINESS_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. The live adapter — including what it must NOT send
// ---------------------------------------------------------------------------

describe("StripeIdentityDirectorKycProvider", () => {
  it("creates a session with POST /v1/identity/verification_sessions", async () => {
    const { fetchImpl, calls } = recordingFetch(SESSION);
    const provider = new StripeIdentityDirectorKycProvider({ secretKey: "sk_test_x", fetchImpl });

    const leg = await provider.begin(INPUT);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.stripe.com/v1/identity/verification_sessions");
    expect(call.init.method).toBe("POST");
    expect(bodyOf(call)).toContain("type=document");
    expect(bodyOf(call)).toContain(`metadata%5Breference_id%5D=${BUSINESS_ID}`);
    expect(leg.evidence).toBe("live");
    expect(leg.reference).toBe(SESSION.id);
  });

  it("sends no address, no tax id and no date of birth — we hold none of them", () => {
    const { fetchImpl, calls } = recordingFetch(SESSION);
    const provider = new StripeIdentityDirectorKycProvider({ secretKey: "sk_test_x", fetchImpl });

    return provider.begin(INPUT).then(() => {
      const body = bodyOf(calls[0]!);
      for (const forbidden of ["address", "line1", "tax_id", "ssn", "dob", "id_number", "000000000"]) {
        expect(body).not.toContain(forbidden);
      }
    });
  });

  it("sends an idempotency key, so two clicks are one session", async () => {
    const { fetchImpl, calls } = recordingFetch(SESSION);
    const provider = new StripeIdentityDirectorKycProvider({ secretKey: "sk_test_x", fetchImpl });
    await provider.begin(INPUT);
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(`kyb-director-${BUSINESS_ID}`);
    expect(headers["Authorization"]).toBe("Bearer sk_test_x");
  });

  it("refreshes with a GET, which creates nothing", async () => {
    const { fetchImpl, calls } = recordingFetch({ ...SESSION, status: "verified" });
    const provider = new StripeIdentityDirectorKycProvider({ secretKey: "sk_test_x", fetchImpl });

    const leg = await provider.refresh(SESSION.id);

    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.body).toBeUndefined();
    expect(calls[0]!.url).toBe(
      `https://api.stripe.com/v1/identity/verification_sessions/${SESSION.id}`,
    );
    expect(leg.status).toBe("approved");
  });

  it("fails the leg loudly rather than quietly becoming a simulator", async () => {
    const { fetchImpl } = recordingFetch({ error: { message: "No such session" } }, 404);
    const provider = new StripeIdentityDirectorKycProvider({ secretKey: "sk_test_x", fetchImpl });
    await expect(provider.refresh("vs_missing")).rejects.toThrow(/No such session/);
  });
});

// ---------------------------------------------------------------------------
// 4. Selection
// ---------------------------------------------------------------------------

describe("selectWiredLegs", () => {
  it("prefers Persona for the director leg when its keys are present", () => {
    const selection = selectWiredLegs({
      PERSONA_API_KEY: "persona_sandbox_x",
      PERSONA_INQUIRY_TEMPLATE_ID: "itmpl_x",
      STRIPE_SECRET_KEY: "sk_test_x",
    });
    expect(selection.director.provider.name).toBe("persona-inquiry");
    expect(selection.director.mode).toBe("live");
  });

  it("uses Stripe Identity when Persona is absent and a Stripe key is present", () => {
    const selection = selectWiredLegs({ STRIPE_SECRET_KEY: "sk_test_x" });
    expect(selection.director.provider.name).toBe("stripe-identity");
    expect(selection.director.mode).toBe("live");
    expect(selection.director.evidence).toBe("live");
  });

  it("simulates the director leg when neither provider is configured, and names both", () => {
    const selection = selectWiredLegs({});
    expect(selection.director.provider.name).toBe("simulated-director-kyc");
    expect(selection.director.mode).toBe("simulated");
    expect(selection.director.reason).toContain("PERSONA_API_KEY");
    expect(selection.director.reason).toContain("STRIPE_SECRET_KEY");
  });

  it("obeys KYB_FORCE_SIMULATED rather than quietly upgrading to Stripe Identity", () => {
    const selection = selectWiredLegs({
      STRIPE_SECRET_KEY: "sk_test_x",
      KYB_FORCE_SIMULATED: "director_kyc",
    });
    expect(selection.director.provider.name).toBe("simulated-director-kyc");
    expect(selection.director.reason).toContain("KYB_FORCE_SIMULATED");
  });

  it("wires the registry leg live, on the ladder's credential-free floor", () => {
    for (const env of [{}, { STRIPE_SECRET_KEY: "sk_test_x" }]) {
      const selection = selectWiredLegs(env);
      expect(selection.registry.provider.name).toBe("gleif-lei");
      expect(selection.registry.evidence).toBe("live");
      expect(selection.registry.missingEnv).toEqual([]);
      // Live AND a substitution, and the reason has to say both.
      expect(selection.registry.reason).toContain("SUBSTITUTE");
    }
  });

  it("puts the same ladder under this screen as under /api/health", () => {
    // The failure this pins: two surfaces choosing a registry provider by two
    // different rules, so a leg reads live on one and simulated on the other.
    for (const env of [
      {},
      { STRIPE_SECRET_KEY: "sk_test_x" },
      { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_CONNECT_KYB: "1" },
      { PERSONA_API_KEY: "k", PERSONA_KYB_TEMPLATE_ID: "itmpl_B" },
      { MIDDESK_API_KEY: "mk" },
      { KYB_FORCE_SIMULATED: "business_registry" },
    ]) {
      expect(selectWiredLegs(env).registry.provider.name).toBe(
        selectKybLegs(env).registry.provider.name,
      );
    }
  });

  it("a brief-named vendor credential displaces GLEIF with no code change", () => {
    const selection = selectWiredLegs({
      STRIPE_SECRET_KEY: "sk_test_x",
      PERSONA_API_KEY: "persona_sandbox_k",
      PERSONA_KYB_TEMPLATE_ID: "itmpl_BUSINESS",
    });
    expect(selection.registry.provider.name).toBe("persona-kyb-inquiry");
    // ...and the compliance badge follows the RUNG, so it stops saying
    // "substitution" the moment a named vendor answers.
    const view = wiringView({
      STRIPE_SECRET_KEY: "sk_test_x",
      PERSONA_API_KEY: "persona_sandbox_k",
      PERSONA_KYB_TEMPLATE_ID: "itmpl_BUSINESS",
    });
    expect(view.registry.compliance).toBe("on-brief");
  });

  it("labels GLEIF live AND substituted, never one without the other", () => {
    const view = wiringView({ STRIPE_SECRET_KEY: "sk_test_x" });
    expect(view.registry.mode).toBe("live");
    expect(view.registry.evidence).toBe("live");
    expect(view.registry.compliance).toBe("substituted");
    expect(view.registry.complianceLabel).toContain("SUBSTITUTION");
    expect(view.registry.complianceNote).toContain("Middesk");
    // And it prints what a hit does not prove, rather than filing it away.
    expect(view.registry.limits.join(" ")).toContain("beneficial ownership");
  });

  it("does not advertise a director rejection Stripe will not produce", () => {
    const view = wiringView({ STRIPE_SECRET_KEY: "sk_test_x" });
    expect(view.director.reachableStatuses).not.toContain("rejected");
    expect(view.director.reachabilityNote).toContain("last_error");
    // The registry leg CAN reach all four, and says so.
    expect(view.registry.reachableStatuses).toContain("rejected");
  });

  it("claims a live ceiling only when BOTH legs are live", () => {
    // Registry live, director live (Stripe Identity): a live ceiling, which is
    // a statement about the wiring and not about any verification.
    expect(wiringView({ STRIPE_SECRET_KEY: "sk_test_x" }).evidenceCeiling).toBe("live");
    // Director simulated: the ceiling is the worst leg.
    expect(wiringView({}).evidenceCeiling).toBe("simulated");
  });

  it("reports the disagreement with /api/health instead of smoothing it over", () => {
    // Both surfaces walk the same registry ladder, so the registry leg cannot
    // disagree. The DIRECTOR leg still can: `selectKybLegs()` knows only about
    // Persona and calls it simulated, while this screen reaches for Stripe
    // Identity. That is a real difference and it is reported rather than hidden.
    const view = wiringView({ STRIPE_SECRET_KEY: "sk_test_x" });
    expect(view.healthDisagreement).toContain("director=simulated");
    expect(view.healthDisagreement).toContain("director=live");
    // With no Stripe key, neither surface upgrades the director leg, so there
    // is nothing to report.
    expect(wiringView({}).healthDisagreement).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. THE EDGE CASE: one real leg, one simulated, and the label degrades
// ---------------------------------------------------------------------------

describe("the composite this deployment builds", () => {
  it("labels a verification simulated even when the director leg was genuinely live", async () => {
    const { fetchImpl } = recordingFetch({ ...SESSION, status: "verified", url: null });
    const director = new StripeIdentityDirectorKycProvider({ secretKey: "sk_test_x", fetchImpl });
    const composite = new CompositeKybProvider(director, new SimulatedRegistryProvider());

    // EIN 000000000 is the registry's documented "matched" outcome, so BOTH
    // legs approve. The status is approved; the evidence is not live.
    const result = await composite.begin(INPUT);

    expect(result.directorLeg?.evidence).toBe("live");
    expect(result.directorLeg?.status).toBe("approved");
    expect(result.registryLeg?.evidence).toBe("simulated");
    expect(result.registryLeg?.status).toBe("approved");
    expect(result.status).toBe("approved");
    expect(result.evidence).toBe("simulated");
    expect(result.isLive).toBe(false);
  });

  it("takes the strictest status across the legs", async () => {
    const { fetchImpl } = recordingFetch({ ...SESSION, status: "verified", url: null });
    const director = new StripeIdentityDirectorKycProvider({ secretKey: "sk_test_x", fetchImpl });
    const composite = new CompositeKybProvider(director, new SimulatedRegistryProvider());

    // 222221000 is "company not found in registry".
    const result = await composite.begin({ ...INPUT, taxIdentificationNumber: "222221000" });

    expect(result.directorLeg?.status).toBe("approved");
    expect(result.status).toBe("rejected");
  });

  it("degrades to simulated when a live leg cannot be reached", async () => {
    const failing: KybLegProvider<"live"> = {
      leg: "director_kyc",
      name: "stripe-identity",
      evidence: "live",
      begin: () => Promise.reject(new Error("connect ETIMEDOUT")),
      refresh: () => Promise.reject(new Error("connect ETIMEDOUT")),
    } as unknown as KybLegProvider<"live">;
    const composite = new CompositeKybProvider(failing, new SimulatedRegistryProvider());

    const result = await composite.begin(INPUT);

    expect(result.status).toBe("pending");
    expect(result.evidence).toBe("simulated");
    expect(result.directorLeg?.provider).toBe("stripe-identity-unavailable");
  });

  it("builds from the environment without touching a network", () => {
    // Constructing an adapter opens no socket: `GleifRegistryProvider` holds a
    // base URL and a timeout and nothing else, so this asserts the wiring
    // without asking anybody's server anything.
    const composite = createWiredKybProvider({ STRIPE_SECRET_KEY: "sk_test_x" });
    expect(composite.wiring.director_kyc.provider).toBe("stripe-identity");
    expect(composite.wiring.business_registry.provider).toBe("gleif-lei");
    expect(composite.wiring.business_registry.evidence).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// 5b. THE REGISTRY PROBE — a question about the registry, not about anybody
// ---------------------------------------------------------------------------

describe("probeRegistry", () => {
  /** A registry stub that records HOW it was asked, not just what it answered. */
  function spy(): { provider: KybLegProvider<"live">; calls: string[] } {
    const calls: string[] = [];
    const leg = (reference: string): KybLegResult<"live"> => ({
      leg: "business_registry",
      provider: "gleif-lei",
      reference,
      referenceId: null,
      status: "rejected",
      rawStatus: "INACTIVE/RETIRED",
      checks: [],
      hostedUrl: null,
      observedAt: "2026-09-10T18:00:00.000Z",
      evidence: "live",
    });
    return {
      calls,
      provider: {
        leg: "business_registry",
        name: "gleif-lei",
        evidence: "live",
        begin: (input: CreateKybVerificationInput) => {
          calls.push(`begin:${input.businessName}`);
          return Promise.resolve(leg("by-name"));
        },
        refresh: (reference: string) => {
          calls.push(`refresh:${reference}`);
          return Promise.resolve(leg(reference));
        },
      } as unknown as KybLegProvider<"live">,
    };
  }

  it("reads an LEI through refresh, because a probe asserts no applicant name", async () => {
    // THE BUG THIS PINS. `begin()` takes an application, and an application
    // always carries the applicant's name for the adapter to re-verify a
    // candidate against. A probe has no applicant. Passing the typed LEI as
    // the name made every identifier lookup compare a real legal name to
    // twenty random characters and answer `lei_name_mismatch` — so LEI
    // 254900ZT6ZFUC887FB87, a genuine decline (entity INACTIVE, registration
    // RETIRED), reported as a name mismatch and hid the outcome the panel
    // exists to demonstrate.
    const { provider, calls } = spy();
    const result = await probeRegistry("254900ZT6ZFUC887FB87", {
      env: {},
      registryProvider: provider,
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["refresh:254900ZT6ZFUC887FB87"]);
    if (result.ok) expect(result.value.kind).toBe("lei");
  });

  it("reads a NAME through begin, where the name check belongs", async () => {
    const { provider, calls } = spy();
    const result = await probeRegistry("  Apple Inc.  ", { env: {}, registryProvider: provider });
    expect(calls).toEqual(["begin:Apple Inc."]);
    if (result.ok) {
      expect(result.value.kind).toBe("name");
      // Echoed back trimmed, so the screen quotes what was actually asked.
      expect(result.value.query).toBe("Apple Inc.");
    }
  });

  it("refuses an empty query without troubling anybody's server", async () => {
    const { provider, calls } = spy();
    const result = await probeRegistry("   ", { env: {}, registryProvider: provider });
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a provider that throws becomes an unanswered leg, never a plausible answer", async () => {
    const provider = {
      leg: "business_registry",
      name: "gleif-lei",
      evidence: "live",
      begin: () => Promise.reject(new Error("ETIMEDOUT")),
      refresh: () => Promise.reject(new Error("ETIMEDOUT")),
    } as unknown as KybLegProvider<"live">;

    const result = await probeRegistry("Apple Inc.", { env: {}, registryProvider: provider });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.leg.status).toBe("pending");
    // WE wrote this row, so it is labelled ours.
    expect(result.value.leg.evidence).toBe("simulated");
    expect(result.value.leg.provider).toBe("gleif-lei-unavailable");
  });
});

// ---------------------------------------------------------------------------
// 6. Rows
// ---------------------------------------------------------------------------

describe("legRow", () => {
  const base: KybLegResult = {
    leg: "director_kyc",
    provider: "stripe-identity",
    reference: "vs_123",
    referenceId: BUSINESS_ID,
    status: "pending",
    rawStatus: "requires_input",
    checks: [],
    hostedUrl: null,
    observedAt: "2026-09-10T18:00:00.000Z",
    evidence: "live",
  };

  it("keeps a live leg's own provider reference untouched", () => {
    const row = legRow(BUSINESS_ID, base);
    expect(row.providerReference).toBe("vs_123");
    expect(row.evidence).toBe("live");
  });

  it("gives an unanswered leg an id that reads as ours, and only ever as simulated", () => {
    const row = legRow(BUSINESS_ID, {
      ...base,
      provider: "stripe-identity-unavailable",
      reference: "",
      evidence: "simulated",
    });
    expect(row.providerReference).toBe(`sim.unavailable.director_kyc.${BUSINESS_ID}`);
    expect(row.evidence).toBe("simulated");
    // The database CHECK this mirrors: a `sim.` reference may never be live.
    expect(row.providerReference.startsWith("sim.") && row.evidence === "live").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. The gate, on the real read path
// ---------------------------------------------------------------------------

describe("transactGateForBusiness", () => {
  it("denies a business with no verification on file", async () => {
    const decision = await transactGateForBusiness(BUSINESS_ID, { conn: stubConn([]) });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe("KYB_NOT_STARTED");
  });

  it("denies a pending business, with the reason a person can read", async () => {
    const decision = await transactGateForBusiness(BUSINESS_ID, {
      conn: stubConn([
        {
          business_id: BUSINESS_ID,
          kyb_status: "pending",
          kyb_evidence: "simulated",
          decided_at: null,
        },
      ]),
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.code).toBe("KYB_PENDING");
      expect(decision.message).toMatch(/viewed, but not transacted on/);
    }
  });

  it("denies a rejected business terminally", async () => {
    const decision = await transactGateForBusiness(BUSINESS_ID, {
      conn: stubConn([
        {
          business_id: BUSINESS_ID,
          kyb_status: "rejected",
          kyb_evidence: "simulated",
          decided_at: "2026-09-10T18:00:00.000Z",
        },
      ]),
    });
    if (!decision.allowed) expect(decision.code).toBe("KYB_REJECTED");
    else throw new Error("a rejected business must never be allowed to transact");
  });

  it("allows an approved business, and carries the evidence label with the permission", async () => {
    const conn = stubConn([
      {
        business_id: BUSINESS_ID,
        kyb_status: "approved",
        kyb_evidence: "simulated",
        decided_at: "2026-09-10T18:00:00.000Z",
      },
    ]);

    const permissive = await transactGateForBusiness(BUSINESS_ID, { conn });
    expect(permissive.allowed).toBe(true);
    if (permissive.allowed) expect(permissive.evidence).toBe("simulated");

    // The same row, in a deployment that touches real money.
    const strict = await transactGateForBusiness(BUSINESS_ID, {
      conn,
      policy: { requireLiveEvidence: true },
    });
    expect(strict.allowed).toBe(false);
    if (!strict.allowed) expect(strict.code).toBe("KYB_EVIDENCE_SIMULATED");
  });

  it("fails closed on a status this build cannot read", async () => {
    const decision = await transactGateForBusiness(BUSINESS_ID, {
      conn: stubConn([
        {
          business_id: BUSINESS_ID,
          kyb_status: "verified",
          kyb_evidence: "live",
          decided_at: null,
        },
      ]),
    });
    if (!decision.allowed) expect(decision.code).toBe("KYB_STATE_UNREADABLE");
    else throw new Error("an unreadable status must never be allowed to transact");
  });
});

describe("gateView", () => {
  it("renders a denial with its code and never invents an allowance", () => {
    const view = gateView({
      allowed: false,
      businessId: BUSINESS_ID,
      code: "KYB_NEEDS_REVIEW",
      message: "Verification is with a reviewer.",
      status: "needs_review",
      evidence: "simulated",
    });
    expect(view.allowed).toBe(false);
    expect(view.code).toBe("KYB_NEEDS_REVIEW");
    expect(view.message).toBe("Verification is with a reviewer.");
  });

  it("says out loud when an allowance rests on simulated evidence", () => {
    const view = gateView({
      allowed: true,
      businessId: BUSINESS_ID,
      status: "approved",
      evidence: "simulated",
      decidedAt: null,
    });
    expect(view.allowed).toBe(true);
    expect(view.code).toBeNull();
    expect(view.message).toContain("simulated evidence");
  });
});
