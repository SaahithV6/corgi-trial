/**
 * wire.ts — the thin adapter between the composite KYB provider and a request.
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR
 *
 * Everything else in `src/lib/kyb/` is pure rules plus provider adapters, and
 * for most of this build it was reachable from nowhere: no request path
 * imported it, so the lattice, the composite and `canTransact()` were good code
 * that never ran (DECISIONS 027 §3). This module is the wire. It does four
 * things and deliberately no more:
 *
 *   1. SELECTS the two legs for THIS deployment, on top of `selectKybLegs()`,
 *      and says out loud where its answer differs from the health endpoint's.
 *   2. BEGINS / REFRESHES a verification, and appends what came back to
 *      `kyb_verification_leg` — INSERT only, which is the only verb the
 *      `corgi_app` role holds on that table.
 *   3. READS the derived state back out of `v_business_kyb` for the screen.
 *   4. ASKS `canTransact()` before anything is allowed to start a payment.
 *
 * WHAT IT DOES NOT DO: decide anything. It never computes a status, never
 * computes an evidence label, and never stores either. Both are derived — by
 * `CompositeKybResult` in TypeScript and by `v_business_kyb` in Postgres — and
 * this module's job is to carry values between them without inventing one.
 * ===========================================================================
 *
 * THE DIRECTOR LEG IS LIVE, AND IT IS STRIPE IDENTITY.
 *
 * `POST /v1/identity/verification_sessions` is a real third-party call to a
 * provider we do not control, made only from an explicit operator action, never
 * on render. DECISION 018 settled the ordering: Persona first when its keys are
 * present, because `perform-simulate-actions` can drive an inquiry to declined
 * and fire the real webhook for it; Stripe Identity second, because it is
 * self-serve and measured working (200, `status: requires_input`, a
 * `verify.stripe.com` hosted URL) but publishes no forced-outcome path. This
 * module honours that order — it only reaches for Identity when the Persona
 * keys are absent.
 *
 * THE REGISTRY LEG IS SIMULATED, AND SAYS SO.
 *
 * Not a fallback, and specifically not the "try live, fall back on error" the
 * factory's header forbids: it is a declared selection with a measured reason.
 * `POST /v1/accounts` answers 400 "you can only create new accounts if you've
 * signed up for Connect" on this account (DECISION 017), and every KYB vendor
 * on the brief's menu is gated behind a sales conversation (DECISION 018). So
 * the leg is simulated, it is labelled `simulated`, and — by the composite's
 * rule 2 — every verification this deployment produces is labelled `simulated`
 * even when the director leg was genuinely live. That degradation is the whole
 * point of the module and this file exists partly to make it visible.
 */

import "server-only";

import { DEPOSIT_PARENT_CODE } from "@/lib/ledger/chart";
import { sql, type Sql } from "@/lib/ledger/db";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";
import { rootLogger, type Logger } from "@/lib/log";
import type {
  BusinessKybView,
  DepositAccountView,
  LegView,
  LegWiringView,
  OnboardingDataSource,
  OnboardingSnapshot,
  WiringView,
} from "@/components/onboarding/data-contract";
// The one place a `TransactDecision` becomes something renderable, shared with
// the fixtures so a live row and a fixture row are described identically.
import { gateView } from "@/components/onboarding/gate-view";

import { CompositeKybProvider, type CompositeKybResult } from "./composite";
import { KYB_ENV, selectKybLegs } from "./index";
import { SimulatedDirectorKycProvider, SimulatedRegistryProvider } from "./simulated-registry";
import {
  asEvidence,
  asKybStatus,
  businessKybStateFromRow,
  canTransact,
  KybGateError,
  KybProviderError,
  KYB_LEG_LABEL,
  type BusinessKybState,
  type CreateKybVerificationInput,
  type Evidence,
  type KybAddress,
  type KybCheck,
  type KybLegKind,
  type KybLegProvider,
  type KybLegResult,
  type KybStatus,
  type TransactDecision,
  type TransactPolicy,
} from "./types";

/** The env bag shape the rest of the module reads. Values are never logged. */
type EnvBag = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// 1. The live director leg: Stripe Identity
// ---------------------------------------------------------------------------

export const STRIPE_IDENTITY_DEFAULT_BASE_URL = "https://api.stripe.com";

export const STRIPE_IDENTITY_PROVIDER_NAME = "stripe-identity";

export interface StripeIdentityConfig {
  readonly secretKey: string;
  readonly baseUrl?: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Where Stripe sends the human afterwards. Optional; omitted by default. */
  readonly returnUrl?: string | undefined;
  /** Test seam. Every test injects this; nothing in the suite calls Stripe. */
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Stripe Identity session status -> our lattice.
 *
 * The published values are `requires_input`, `processing`, `verified` and
 * `canceled`. Mapped the same way the rest of this module maps a provider: only
 * an explicit success reaches `approved`, and anything this build does not
 * recognise is held for review rather than guessed at.
 */
export const STRIPE_IDENTITY_STATUS_MAP: Readonly<Record<string, KybStatus>> = {
  verified: "approved",
  processing: "pending",
  requires_input: "pending",
  canceled: "needs_review",
};

/**
 * `requires_input` means two different things and the difference matters.
 *
 * With no `last_error`, nobody has submitted anything yet — the session is in
 * flight, which is `pending`. With a `last_error`, a document WAS submitted and
 * Stripe could not verify it; the session sits back at `requires_input` and a
 * person has to decide whether to re-invite or decline. That is `needs_review`,
 * not `pending`, and never `rejected`: Stripe Identity has no terminal decline,
 * which is exactly why DECISION 018 keeps Persona ahead of it.
 *
 * `Object.hasOwn` rather than a bare index, for the same reason
 * `personaStatusToKyb` uses it: `MAP['toString']` walks the prototype chain and
 * returns a FUNCTION, which `?? 'needs_review'` would pass straight through as
 * a status. A provider's status field is untrusted input like any other, and
 * this build's own test suite caught it here.
 */
export function stripeIdentityStatusToKyb(
  raw: string | null | undefined,
  lastErrorCode: string | null = null,
): KybStatus {
  if (typeof raw !== "string") return "needs_review";
  if (raw === "requires_input" && lastErrorCode !== null) return "needs_review";
  if (!Object.hasOwn(STRIPE_IDENTITY_STATUS_MAP, raw)) return "needs_review";
  return STRIPE_IDENTITY_STATUS_MAP[raw] ?? "needs_review";
}

/** Turn a verification session object into a live director leg. */
export function identitySessionToLeg(
  session: unknown,
  fallbackReferenceId: string | null,
  providerName: string = STRIPE_IDENTITY_PROVIDER_NAME,
): KybLegResult<"live"> {
  const rawStatus = readString(session, ["status"]);
  const lastErrorCode = readString(session, ["last_error", "code"]);
  const lastErrorReason = readString(session, ["last_error", "reason"]);
  const status = stripeIdentityStatusToKyb(rawStatus, lastErrorCode);
  const created = readNumber(session, ["created"]);

  return {
    leg: "director_kyc",
    provider: providerName,
    reference: readString(session, ["id"]) ?? "",
    referenceId: readString(session, ["metadata", "reference_id"]) ?? fallbackReferenceId,
    status,
    rawStatus,
    checks: [
      {
        name: "director_identity_document",
        status: status === "approved" ? "passed" : status === "rejected" ? "failed" : "pending",
        reasons: [
          `stripe identity session status: ${rawStatus ?? "(absent)"}`,
          ...(lastErrorCode === null ? [] : [`last_error.code: ${lastErrorCode}`]),
          ...(lastErrorReason === null ? [] : [lastErrorReason]),
          ...(rawStatus !== null && !(rawStatus in STRIPE_IDENTITY_STATUS_MAP)
            ? ["status not recognised by this build; held for review"]
            : []),
        ],
      },
    ],
    // The short-lived redirect URL. Stripe returns it on create; it is
    // single-use and expires, so the screen shows it once, at creation.
    hostedUrl: readString(session, ["url"]),
    observedAt: created === null ? new Date().toISOString() : new Date(created * 1000).toISOString(),
    evidence: "live",
  };
}

/**
 * Director / control-person KYC through Stripe Identity.
 *
 * Declared `KybLegProvider<'live'>`, which is a promise the type system holds
 * it to: nothing in this class can return `evidence: 'simulated'`, and nothing
 * outside it can relabel what it returns.
 *
 * NO SIGNATURE VERIFICATION LIVES HERE, and none may be added — inbound Stripe
 * deliveries are authenticated exactly once, by `stripeVerifier` in
 * `src/lib/webhooks/inbox.ts`, and land in the inbox.
 */
export class StripeIdentityDirectorKycProvider implements KybLegProvider<"live"> {
  readonly leg = "director_kyc" as const;
  readonly name = STRIPE_IDENTITY_PROVIDER_NAME;
  readonly evidence = "live" as const;

  constructor(private readonly cfg: StripeIdentityConfig) {}

  /**
   * Create a verification session. THIS IS A REAL THIRD-PARTY WRITE and the
   * only call in this module that creates anything at a provider, which is why
   * every caller reaches it from an explicit operator action and never from a
   * render path.
   *
   * Note what is NOT in the body: no address, no date of birth, no tax id. The
   * `business` table carries none of those (0001), the hosted flow collects the
   * document itself, and a request that shipped placeholder PII to a real
   * provider would be worse than one that ships none.
   */
  async begin(input: CreateKybVerificationInput): Promise<KybLegResult<"live">> {
    const form = new URLSearchParams();
    form.set("type", "document");
    // Round-trips on the session and on every identity webhook, so a delivery
    // can be matched to a business without a lookup table.
    form.set("metadata[reference_id]", input.referenceId);
    form.set("metadata[business_name]", input.businessName);
    if (this.cfg.returnUrl !== undefined) form.set("return_url", this.cfg.returnUrl);

    const session = await this.request("POST", "/v1/identity/verification_sessions", form, {
      // Two clicks on one business reuse one session rather than littering the
      // Stripe account with abandoned ones.
      "Idempotency-Key": `kyb-director-${input.referenceId}`,
    });
    return identitySessionToLeg(session, input.referenceId);
  }

  /** Re-read a session. A GET creates nothing and is safe to repeat. */
  async refresh(reference: string): Promise<KybLegResult<"live">> {
    const session = await this.request(
      "GET",
      `/v1/identity/verification_sessions/${encodeURIComponent(reference)}`,
    );
    return identitySessionToLeg(session, null);
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    form?: URLSearchParams,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.secretKey}`,
      Accept: "application/json",
      ...extraHeaders,
    };
    if (this.cfg.apiVersion !== undefined) headers["Stripe-Version"] = this.cfg.apiVersion;
    if (form !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";

    let response: Response;
    try {
      response = await doFetch(`${this.cfg.baseUrl ?? STRIPE_IDENTITY_DEFAULT_BASE_URL}${path}`, {
        method,
        headers,
        ...(form === undefined ? {} : { body: form.toString() }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new KybProviderError(
        this.name,
        `Stripe ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    const parsed = text === "" ? null : safeJsonParse(text);
    if (!response.ok) {
      // Stripe's `error.message` is written for developers and carries no
      // submitted PII. The key is never in it and never goes near a log.
      const message = readString(parsed, ["error", "message"]) ?? `${response.status}`;
      throw new KybProviderError(this.name, `Stripe ${method} ${path} -> ${message}`, response.status);
    }
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// 2. Selection for THIS deployment
// ---------------------------------------------------------------------------

export interface WiredLeg {
  readonly leg: KybLegKind;
  readonly mode: "live" | "simulated";
  readonly provider: KybLegProvider;
  readonly evidence: Evidence;
  readonly reason: string;
  readonly missingEnv: readonly string[];
}

export interface WiredSelection {
  readonly director: WiredLeg;
  readonly registry: WiredLeg;
}

/**
 * Why the registry leg is the simulator, in one sentence the screen prints
 * verbatim. Measured, not assumed — see DECISIONS 015, 017 and 018.
 */
export const REGISTRY_SIMULATED_REASON =
  "no self-serve business-registry check exists on this account: POST /v1/accounts answers 400 \"you can only create new accounts if you've signed up for Connect\", and every KYB vendor on the brief's menu (Middesk, Persona KYB, Sumsub KYB) is gated behind a sales conversation";

/**
 * `KYB_FORCE_SIMULATED`, parsed.
 *
 * `index.ts` keeps its copy of this private, and the escape hatch must be
 * honoured by every path that selects a provider — a switch that only half the
 * code obeys is worse than no switch. So it is re-read here rather than
 * inferred: the first draft of this function guessed "simulated with nothing
 * missing means forced", which is wrong for a deployment that is BOTH missing
 * the Persona keys AND forced, and `wire.test.ts` caught it.
 */
function isForcedSimulated(env: EnvBag, leg: KybLegKind): boolean {
  const raw = readEnv(env, KYB_ENV.forceSimulated);
  if (raw === undefined) return false;
  const entries = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  return entries.includes("all") || entries.includes(leg);
}

/**
 * Choose the two legs.
 *
 * The director leg defers to `selectKybLegs()` first, so Persona wins whenever
 * its keys are present. `KYB_FORCE_SIMULATED` is still obeyed: a leg forced to
 * the simulator must not be quietly upgraded to Stripe Identity by this
 * function. Only a leg that degraded for want of Persona keys is offered to it.
 */
export function selectWiredLegs(env: EnvBag = process.env): WiredSelection {
  const base = selectKybLegs(env).director;
  const stripeKey = readEnv(env, KYB_ENV.stripeSecretKey);
  const forced = isForcedSimulated(env, "director_kyc");

  const director: WiredLeg =
    base.mode === "live"
      ? {
          leg: "director_kyc",
          mode: "live",
          provider: base.provider,
          evidence: "live",
          reason: base.reason,
          missingEnv: [],
        }
      : !forced && stripeKey !== undefined
        ? {
            leg: "director_kyc",
            mode: "live",
            provider: new StripeIdentityDirectorKycProvider({ secretKey: stripeKey }),
            evidence: "live",
            reason:
              "Stripe Identity verification sessions — a real third-party KYC call (POST /v1/identity/verification_sessions). Second choice behind Persona, which can drive its own non-happy paths; Stripe Identity publishes no forced outcome.",
            missingEnv: [],
          }
        : {
            leg: "director_kyc",
            mode: "simulated",
            provider: new SimulatedDirectorKycProvider(),
            evidence: "simulated",
            reason: forced
              ? `forced to the simulator by ${KYB_ENV.forceSimulated}`
              : `no live director KYC: neither ${base.missingEnv.join(" + ")} nor ${KYB_ENV.stripeSecretKey} is set`,
            // A forced leg is not a misconfigured one, so it reports nothing
            // missing: naming an env var that IS set would send the next
            // operator looking for a key they already have.
            missingEnv: forced
              ? []
              : [
                  ...base.missingEnv,
                  ...(stripeKey === undefined ? [KYB_ENV.stripeSecretKey] : []),
                ],
          };

  return {
    director,
    registry: {
      leg: "business_registry",
      mode: "simulated",
      provider: new SimulatedRegistryProvider(),
      evidence: "simulated",
      reason: REGISTRY_SIMULATED_REASON,
      missingEnv: [],
    },
  };
}

/** The composite this deployment runs. Legs chosen above; rules unchanged. */
export function createWiredKybProvider(env: EnvBag = process.env): CompositeKybProvider {
  const selection = selectWiredLegs(env);
  return new CompositeKybProvider(selection.director.provider, selection.registry.provider);
}

/**
 * What the screen prints about the wiring — including, loudly, any place this
 * wiring and `/api/health` would describe the same leg differently.
 *
 * `kybHealthReport()` reads `selectKybLegs()`, which calls the registry leg
 * LIVE whenever `STRIPE_SECRET_KEY` is set, because that is the key the Connect
 * adapter would use. This module does not use the Connect adapter at all. Two
 * surfaces disagreeing about live-vs-simulated is the precise failure this
 * codebase has caught four times (DECISIONS 011, 015, 016, 017, 026), so it is
 * reported rather than smoothed over. Setting
 * `KYB_FORCE_SIMULATED=business_registry` makes them agree.
 */
export function wiringView(env: EnvBag = process.env): WiringView {
  const selection = selectWiredLegs(env);
  const health = selectKybLegs(env);
  const director = toLegWiringView(selection.director);
  const registry = toLegWiringView(selection.registry);

  return {
    director,
    registry,
    evidenceCeiling:
      director.mode === "live" && registry.mode === "live" ? "live" : "simulated",
    healthDisagreement:
      health.registry.mode === "live"
        ? `/api/health reports the business-registry leg as LIVE because ${KYB_ENV.stripeSecretKey} is set, but no request path uses Stripe Connect — this screen wires the simulator. Set ${KYB_ENV.forceSimulated}=business_registry so both surfaces say the same thing.`
        : null,
  };
}

function toLegWiringView(leg: WiredLeg): LegWiringView {
  return {
    leg: leg.leg,
    label: KYB_LEG_LABEL[leg.leg],
    mode: leg.mode,
    provider: leg.provider.name,
    evidence: leg.evidence,
    reason: leg.reason,
    missingEnv: leg.missingEnv,
  };
}

// ---------------------------------------------------------------------------
// 3. Persisting an observation
// ---------------------------------------------------------------------------

/**
 * The `business` table carries no address (0001), so there is none to send.
 *
 * This placeholder exists only because `CreateKybVerificationInput` requires
 * the field. NO LEG IN THIS WIRING READS IT: Stripe Identity's request body
 * carries `type` and `metadata` and nothing else, and the simulated registry
 * reads the EIN. `wire.test.ts` asserts the outgoing body contains no address
 * field, so this staying inert is a test rather than a promise.
 */
export const PLACEHOLDER_REGISTERED_ADDRESS: KybAddress = {
  street1: "(not on file — the business table stores no address)",
  city: "(not on file)",
  subdivision: "(not on file)",
  postalCode: "(not on file)",
  countryCode: "US",
};

/** One row of `kyb_verification_leg`, in the column names the table uses. */
export interface KybLegRow {
  readonly leg: KybLegKind;
  readonly provider: string;
  readonly providerReference: string;
  readonly status: KybStatus;
  readonly evidence: Evidence;
  readonly rawStatus: string | null;
  readonly checks: readonly KybCheck[];
  readonly observedAt: string;
}

/**
 * Leg result -> row, with one substitution and no others.
 *
 * `failedLeg()` returns an empty reference, because a provider that did not
 * answer issued no id; the table's `kyb_leg_reference_nonempty` CHECK refuses
 * that, correctly. So an unanswered leg is filed under an id that says what it
 * is — `sim.unavailable.<leg>.<business>` — which reads as ours at a glance and
 * is legal only because such a leg is already `evidence: 'simulated'`. It could
 * never be filed as live: `kyb_leg_simulated_reference` refuses any row that
 * claims `live` while carrying a `sim.` reference.
 */
export function legRow(businessId: string, leg: KybLegResult): KybLegRow {
  return {
    leg: leg.leg,
    provider: leg.provider,
    providerReference:
      leg.reference.trim() === "" ? `sim.unavailable.${leg.leg}.${businessId}` : leg.reference,
    status: leg.status,
    evidence: leg.evidence,
    rawStatus: leg.rawStatus,
    checks: leg.checks,
    observedAt: leg.observedAt,
  };
}

/**
 * `KybCheck[]` -> the plain, mutable shape the driver's `json()` accepts.
 *
 * A `readonly` array of `readonly` interfaces is not a `JSONValue`, and the
 * copy is the honest fix: nothing here reshapes or drops a field, so what is
 * stored is what the provider's adapter produced.
 */
type ChecksJson = { name: string; status: string; reasons: string[] }[];

function checksAsJson(checks: readonly KybCheck[]): ChecksJson {
  return checks.map((check) => ({
    name: check.name,
    status: check.status,
    reasons: [...check.reasons],
  }));
}

async function appendLegs(
  businessId: string,
  result: CompositeKybResult,
  conn: Sql,
): Promise<void> {
  for (const leg of result.legs) {
    const row = legRow(businessId, leg);
    await conn`
      INSERT INTO kyb_verification_leg
        (business_id, leg, provider, provider_reference, status, evidence, raw_status, checks, observed_at)
      VALUES
        (${businessId}::uuid,
         ${row.leg}::kyb_leg,
         ${row.provider},
         ${row.providerReference},
         ${row.status}::kyb_status,
         ${row.evidence}::kyb_evidence,
         ${row.rawStatus},
         ${conn.json(checksAsJson(row.checks))},
         ${row.observedAt}::timestamptz)`;
  }
}

// ---------------------------------------------------------------------------
// 4. Begin and refresh
// ---------------------------------------------------------------------------

/** What an operator action gets back. JSON-safe: it crosses to the client. */
export interface VerificationOutcome {
  readonly businessId: string;
  readonly legalName: string;
  /** Derived by the composite, never stored: strictest of the two legs. */
  readonly status: KybStatus;
  /** Derived by the composite, never stored: `live` only if BOTH legs were. */
  readonly evidence: Evidence;
  readonly legs: readonly LegView[];
  /**
   * The provider's hosted flow, when one was issued. Single-use and
   * short-lived, which is why it is returned by the action and not stored.
   */
  readonly hostedUrl: string | null;
  /** The live provider reference to quote — `vs_…` for Stripe Identity. */
  readonly directorReference: string | null;
}

type BusinessRow = { readonly id: string; readonly legal_name: string; readonly ein: string };

async function loadBusiness(businessId: string, conn: Sql): Promise<BusinessRow | null> {
  const rows = await conn<BusinessRow[]>`
    SELECT id, legal_name, ein FROM business WHERE id = ${businessId}::uuid`;
  return rows[0] ?? null;
}

function inputFor(business: BusinessRow): CreateKybVerificationInput {
  return {
    referenceId: business.id,
    businessName: business.legal_name,
    taxIdentificationNumber: business.ein,
    registeredAddress: PLACEHOLDER_REGISTERED_ADDRESS,
  };
}

export interface WireOptions {
  readonly env?: EnvBag | undefined;
  readonly conn?: Sql | undefined;
  readonly provider?: CompositeKybProvider | undefined;
  readonly log?: Logger | undefined;
}

/**
 * Start a verification: run both legs, append what each said, return the
 * composite's derived answer.
 *
 * REFUSES IF A VERIFICATION IS ALREADY ON FILE. The director leg is a real
 * `POST` to Stripe, so a screen that created a session per click would litter a
 * live account with abandoned sessions. The existing rows are refreshable
 * instead, which re-reads the same session and costs nothing.
 */
export async function beginVerification(
  businessId: string,
  options: WireOptions = {},
): Promise<Result<VerificationOutcome, ErrorShape>> {
  const conn = options.conn ?? sql;
  const log = (options.log ?? rootLogger).child({ businessId });

  const business = await loadBusiness(businessId, conn);
  if (business === null) {
    return fail("BUSINESS_NOT_FOUND", "No business on this book has that id. Nothing was started.");
  }

  const existing = await latestLegs(conn, businessId);
  if ((existing.get(businessId)?.length ?? 0) > 0) {
    return fail(
      "KYB_ALREADY_STARTED",
      "A verification is already on file for this business. Refresh it instead — starting again would open a second session at the provider for no new information.",
    );
  }

  const provider = options.provider ?? createWiredKybProvider(options.env ?? process.env);
  let result: CompositeKybResult;
  try {
    result = await provider.begin(inputFor(business));
  } catch (error) {
    // The composite converts a leg failure into a `pending` leg, so reaching
    // here means something outside a leg broke. Nothing was written.
    log.warn("kyb.begin.failed", { error: error instanceof Error ? error.message : String(error) });
    return fail(
      "KYB_PROVIDER_UNAVAILABLE",
      "The verification could not be started. Nothing was recorded, so nothing has to be undone.",
    );
  }

  await appendLegs(businessId, result, conn);
  log.info("kyb.begin.recorded", {
    status: result.status,
    evidence: result.evidence,
    providers: result.citations.map((c) => c.provider),
  });

  return ok(toOutcome(business, result));
}

/**
 * Re-read both legs from their own references and append the new observations.
 *
 * Creates nothing at any provider: the director leg is a `GET` on the session
 * that already exists, and the registry simulator replays the outcome encoded
 * in its own reference id.
 */
export async function refreshVerification(
  businessId: string,
  options: WireOptions = {},
): Promise<Result<VerificationOutcome, ErrorShape>> {
  const conn = options.conn ?? sql;
  const log = (options.log ?? rootLogger).child({ businessId });

  const business = await loadBusiness(businessId, conn);
  if (business === null) {
    return fail("BUSINESS_NOT_FOUND", "No business on this book has that id. Nothing was read.");
  }

  const legs = (await latestLegs(conn, businessId)).get(businessId) ?? [];
  const director = legs.find((l) => l.leg === "director_kyc");
  const registry = legs.find((l) => l.leg === "business_registry");
  if (director === undefined || registry === undefined) {
    return fail(
      "KYB_NOT_STARTED",
      "There is no verification on file to refresh. Start one first.",
    );
  }

  const provider = options.provider ?? createWiredKybProvider(options.env ?? process.env);
  let result: CompositeKybResult;
  try {
    result = await provider.refresh(businessId, {
      director: director.reference,
      registry: registry.reference,
    });
  } catch (error) {
    log.warn("kyb.refresh.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return fail(
      "KYB_PROVIDER_UNAVAILABLE",
      "The verification could not be re-read. The existing evidence is unchanged — this table is append-only, so a failed read cannot damage it.",
    );
  }

  await appendLegs(businessId, result, conn);
  log.info("kyb.refresh.recorded", { status: result.status, evidence: result.evidence });

  return ok(toOutcome(business, result));
}

function toOutcome(business: BusinessRow, result: CompositeKybResult): VerificationOutcome {
  const legs = result.legs.map(toLegViewFromResult);
  const director = result.directorLeg;
  return {
    businessId: business.id,
    legalName: business.legal_name,
    status: result.status,
    evidence: result.evidence,
    legs,
    hostedUrl: result.hostedUrl,
    directorReference:
      director === null || director.reference.trim() === "" ? null : director.reference,
  };
}

function toLegViewFromResult(leg: KybLegResult): LegView {
  return {
    leg: leg.leg,
    label: KYB_LEG_LABEL[leg.leg],
    provider: leg.provider,
    reference: leg.reference.trim() === "" ? "(none — the provider did not answer)" : leg.reference,
    status: leg.status,
    evidence: leg.evidence,
    rawStatus: leg.rawStatus,
    checks: leg.checks,
    observedAt: leg.observedAt,
  };
}

// ---------------------------------------------------------------------------
// 5. Reading the derived state
// ---------------------------------------------------------------------------

type KybViewRow = {
  readonly business_id: string;
  readonly legal_name: string;
  readonly ein: string;
  readonly legs_on_file: bigint | number;
  readonly kyb_status: string | null;
  readonly kyb_evidence: string | null;
  readonly decided_at: Date | null;
};

type LegRowRead = {
  readonly business_id: string;
  readonly leg: string;
  readonly provider: string;
  readonly provider_reference: string;
  readonly status: string;
  readonly evidence: string;
  readonly raw_status: string | null;
  readonly checks: unknown;
  readonly observed_at: Date;
};

type AccountRow = {
  readonly id: string;
  readonly business_id: string;
  readonly code: string;
  readonly name: string;
};

/**
 * Latest observation per (business, leg).
 *
 * The ORDER BY is the view's, character for character, and it must stay that
 * way: `seq` is the tiebreak that makes "latest wins" a total order, and
 * dropping it would pick at random between a live leg and a simulated one for
 * two rows written in the same transaction (0005 §2).
 */
async function latestLegs(
  conn: Sql,
  businessId?: string,
): Promise<Map<string, readonly LegView[]>> {
  const rows = businessId === undefined
    ? await conn<LegRowRead[]>`
        SELECT DISTINCT ON (business_id, leg)
               business_id, leg::text AS leg, provider, provider_reference,
               status::text AS status, evidence::text AS evidence,
               raw_status, checks, observed_at
          FROM kyb_verification_leg
         ORDER BY business_id, leg, observed_at DESC, recorded_at DESC, seq DESC`
    : await conn<LegRowRead[]>`
        SELECT DISTINCT ON (business_id, leg)
               business_id, leg::text AS leg, provider, provider_reference,
               status::text AS status, evidence::text AS evidence,
               raw_status, checks, observed_at
          FROM kyb_verification_leg
         WHERE business_id = ${businessId}::uuid
         ORDER BY business_id, leg, observed_at DESC, recorded_at DESC, seq DESC`;

  const byBusiness = new Map<string, LegView[]>();
  for (const row of rows) {
    const view = toLegViewFromRow(row);
    if (view === null) continue;
    const list = byBusiness.get(row.business_id) ?? [];
    list.push(view);
    byBusiness.set(row.business_id, list);
  }
  return byBusiness;
}

/**
 * A stored row -> the screen's shape, narrowing at the boundary.
 *
 * `status` and `evidence` come back as text and are narrowed HERE, with the
 * same fail-closed rule the gate uses: a value this build does not recognise is
 * dropped rather than rendered, because a row the screen cannot read is a row
 * it must not describe.
 */
function toLegViewFromRow(row: LegRowRead): LegView | null {
  const leg: KybLegKind | null =
    row.leg === "director_kyc" || row.leg === "business_registry" ? row.leg : null;
  const status = asKybStatus(row.status);
  const evidence = asEvidence(row.evidence);
  if (leg === null || status === null || evidence === null) return null;

  return {
    leg,
    label: KYB_LEG_LABEL[leg],
    provider: row.provider,
    reference: row.provider_reference,
    status,
    evidence,
    rawStatus: row.raw_status,
    checks: parseChecks(row.checks),
    observedAt: row.observed_at.toISOString(),
  };
}

function parseChecks(raw: unknown): readonly KybCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: KybCheck[] = [];
  for (const entry of raw) {
    const name = readString(entry, ["name"]);
    const status = readString(entry, ["status"]);
    if (name === null) continue;
    if (
      status !== "passed" &&
      status !== "failed" &&
      status !== "pending" &&
      status !== "not_applicable"
    ) {
      continue;
    }
    const reasons = readPath(entry, ["reasons"]);
    out.push({
      name,
      status,
      reasons: Array.isArray(reasons) ? reasons.filter((r): r is string => typeof r === "string") : [],
    });
  }
  return out;
}

function toBusinessView(
  row: KybViewRow,
  legs: readonly LegView[],
  account: DepositAccountView | null,
  policy: TransactPolicy,
): BusinessKybView {
  const state = businessKybStateFromRow(row as unknown as Record<string, unknown>);
  const status = asKybStatus(row.kyb_status);
  const evidence = asEvidence(row.kyb_evidence);

  return {
    businessId: row.business_id,
    legalName: row.legal_name,
    ein: row.ein,
    // The view's CASE guarantees a value; the fallbacks are the same
    // fail-closed reading the gate applies to a row it cannot parse.
    status: status ?? "needs_review",
    evidence: evidence ?? "simulated",
    legsOnFile: Number(row.legs_on_file),
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    legs,
    gate: gateView(canTransact(state, policy)),
    gateIfLiveRequired: gateView(canTransact(state, { requireLiveEvidence: true })),
    depositAccount: account,
  };
}

/**
 * The live data source.
 *
 * One `asOf`, taken before the reads, so the screen is a statement about one
 * instant rather than a collage of several.
 */
export function createLiveOnboardingSource(
  options: { readonly conn?: Sql; readonly env?: EnvBag; readonly policy?: TransactPolicy } = {},
): OnboardingDataSource {
  const conn = options.conn ?? sql;
  const env = options.env ?? process.env;
  const policy = options.policy ?? { requireLiveEvidence: false };

  return {
    async getSnapshot(): Promise<Result<OnboardingSnapshot, ErrorShape>> {
      const asOf = new Date().toISOString();
      try {
        const [rows, legs, accounts] = await Promise.all([
          conn<KybViewRow[]>`
            SELECT v.business_id, v.legal_name, b.ein,
                   v.legs_on_file, v.kyb_status::text AS kyb_status,
                   v.kyb_evidence::text AS kyb_evidence, v.decided_at
              FROM v_business_kyb v
              JOIN business b ON b.id = v.business_id
             ORDER BY v.legal_name`,
          latestLegs(conn),
          conn<AccountRow[]>`
            SELECT id, business_id, code, name
              FROM account
             WHERE business_id IS NOT NULL AND code = ${DEPOSIT_PARENT_CODE}`,
        ]);

        const accountByBusiness = new Map<string, DepositAccountView>();
        for (const account of accounts) {
          accountByBusiness.set(account.business_id, {
            id: account.id,
            code: account.code,
            name: account.name,
          });
        }

        return ok({
          asOf,
          wiring: wiringView(env),
          businesses: rows.map((row) =>
            toBusinessView(
              row,
              legs.get(row.business_id) ?? [],
              accountByBusiness.get(row.business_id) ?? null,
              policy,
            ),
          ),
        });
      } catch (error) {
        rootLogger.warn("kyb.snapshot.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return fail(
          "KYB_READ_FAILED",
          "The verification state could not be read. Nothing was written — this is a read, and `kyb_verification_leg` is append-only INSERT-or-nothing anyway.",
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 6. THE GATE — an unverified entity can look, but not transact
// ---------------------------------------------------------------------------

/**
 * The KYB state of one business, read from the view the gate is documented
 * against. Returns `null` for a business that does not exist, which
 * `canTransact()` reads as `KYB_NOT_STARTED` — the fail-closed answer.
 */
export async function businessKybState(
  businessId: string,
  conn: Sql = sql,
): Promise<BusinessKybState | null> {
  const rows = await conn<Record<string, unknown>[]>`
    SELECT business_id, kyb_status::text AS kyb_status,
           kyb_evidence::text AS kyb_evidence, decided_at
      FROM v_business_kyb
     WHERE business_id = ${businessId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : businessKybStateFromRow(row);
}

/** The same, resolved from a deposit account rather than a business. */
export async function accountKybState(
  accountId: string,
  conn: Sql = sql,
): Promise<BusinessKybState | null> {
  const rows = await conn<Record<string, unknown>[]>`
    SELECT v.business_id, v.kyb_status::text AS kyb_status,
           v.kyb_evidence::text AS kyb_evidence, v.decided_at
      FROM account a
      JOIN v_business_kyb v ON v.business_id = a.business_id
     WHERE a.id = ${accountId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : businessKybStateFromRow(row);
}

/**
 * MAY THIS BUSINESS MOVE MONEY?
 *
 * The one call every money-out path should make before it writes anything. It
 * reads `v_business_kyb` and hands the row straight to `canTransact()` without
 * touching it — no narrowing, no defaulting, no "if it is not rejected it is
 * fine". A business with no verification, a pending one, one under review, a
 * declined one and a row this build cannot parse all come back denied, each
 * with its own code.
 */
export async function transactGateForBusiness(
  businessId: string,
  options: { readonly conn?: Sql; readonly policy?: TransactPolicy } = {},
): Promise<TransactDecision> {
  const state = await businessKybState(businessId, options.conn ?? sql);
  return canTransact(state, options.policy ?? { requireLiveEvidence: false });
}

/**
 * The account-shaped form, which is the shape a payment actually arrives in.
 *
 * `requestPayment()` in `src/lib/approvals/instructions.ts` takes an
 * `accountId`, so THIS is the function to call there — see the note at the end
 * of this file.
 */
export async function transactGateForAccount(
  accountId: string,
  options: { readonly conn?: Sql; readonly policy?: TransactPolicy } = {},
): Promise<TransactDecision> {
  const state = await accountKybState(accountId, options.conn ?? sql);
  return canTransact(state, options.policy ?? { requireLiveEvidence: false });
}

/**
 * Imperative form, for a call site in the middle of a transaction where an
 * early return is not available. Throws `KybGateError`, which carries the whole
 * decision, so nothing is lost on the way to the caller.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS BELONGS, EXACTLY.
 *
 * `src/lib/approvals/instructions.ts`, inside `requestPayment()`, immediately
 * after the policy lookup and before the `INSERT INTO payment_instruction`:
 *
 *     const gate = await transactGateForAccount(args.accountId, { conn: tx });
 *     if (!gate.allowed) return fail(gate.code, gate.message);
 *
 * That placement is the honest one for three reasons: it is inside the same
 * transaction, so the state cannot change between the check and the write; it
 * is the single entry point for BOTH the console and the MCP write tool, so an
 * agent cannot route around it; and it returns a `Result` rather than throwing,
 * which is what every other refusal in that function does.
 * ---------------------------------------------------------------------------
 */
export async function assertAccountCanTransact(
  accountId: string,
  options: { readonly conn?: Sql; readonly policy?: TransactPolicy } = {},
): Promise<Extract<TransactDecision, { allowed: true }>> {
  const decision = await transactGateForAccount(accountId, options);
  if (!decision.allowed) throw new KybGateError(decision);
  return decision;
}

// ---------------------------------------------------------------------------
// 7. Small readers
// ---------------------------------------------------------------------------

function readEnv(env: EnvBag, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function readString(value: unknown, path: readonly string[]): string | null {
  const found = readPath(value, path);
  return typeof found === "string" && found !== "" ? found : null;
}

function readNumber(value: unknown, path: readonly string[]): number | null {
  const found = readPath(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
