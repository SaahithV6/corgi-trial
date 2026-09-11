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
 * A STRIPE IDENTITY SESSION CAN REACH THREE OF OUR FOUR STATUSES, AND THE
 * FOURTH IS EARNED RATHER THAN ASSUMED. See `stripeIdentityStatusToKyb`.
 *
 * THE REGISTRY LEG IS LIVE, AND IT IS GLEIF.
 *
 * `src/lib/kyb/gleif.ts` queries `api.gleif.org` — the Global LEI index, a real
 * third-party registry, no key, no account, CC0 data, every record validated by
 * an accredited LOU against a named government company register. It replaces
 * the labelled simulator that stood here while every KYB vendor on the brief's
 * menu turned out to be gated behind a sales conversation (DECISION 018) and
 * Stripe Connect behind platform onboarding (DECISION 017).
 *
 * The rule that leg brings with it, and it is the reason it is honest: A HIT IS
 * AUTHORITATIVE, A MISS IS EVIDENCE OF NOTHING. GLEIF covers entities required
 * to hold an LEI, not every company that exists, so an absent record is
 * `needs_review` and can never be an approval. The seeded demo businesses are
 * fictional and therefore miss — which is the correct answer, arrived at by an
 * authenticated round trip rather than asserted by us.
 *
 * `KYB_FORCE_SIMULATED=business_registry` still switches that leg back to the
 * labelled simulator without a deploy, and the screen then says so.
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
import { verdictView } from "@/components/onboarding/verdict";

import { CompositeKybProvider, CompositeKybResult, failedLeg } from "./composite";
import { GLEIF_LIMITS, GLEIF_PROVIDER_NAME, isLeiFormat } from "./gleif";
import {
  isManualReview,
  manualReviewLeg,
  reviewRefusal,
  type ManualDecision,
  type Reviewer,
} from "./manual-review";
import { KYB_ENV, selectKybLegs } from "./index";
import { chooseRegistryProvider, rungForProviderName } from "./registry-precedence";
import { SimulatedDirectorKycProvider, SimulatedRegistryProvider } from "./simulated-registry";
import {
  asEvidence,
  asKybStatus,
  businessKybStateFromRow,
  canTransact,
  citationFromChecks,
  KybGateError,
  KybProviderError,
  providerCodeFromChecks,
  KYB_CITATION_CHECK,
  KYB_LEG_LABEL,
  KYB_PROVIDER_CODE_CHECK,
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
 * ===========================================================================
 * FOUR STATUSES OUT OF TWO STRIPE FIELDS, AND EVERY ONE OF THEM MEASURED.
 *
 * Stripe Identity's session status is a small vocabulary — `requires_input`,
 * `processing`, `verified`, `canceled` — and on its own it cannot express a
 * decline. `last_error` is the other half of the sentence, and reading the two
 * together is what lets a refusal be a refusal instead of a shrug.
 *
 *   verified                      -> approved      Stripe verified the document.
 *   processing                    -> pending       Stripe is still looking.
 *   requires_input, no last_error -> pending       nobody has submitted yet.
 *   requires_input + last_error   -> needs_review  STRIPE REFUSED THIS ATTEMPT.
 *                                                  Not terminal: `url` is still
 *                                                  live and a retry is open, so
 *                                                  a person decides what next.
 *   canceled, no last_error       -> needs_review  the session was closed with
 *                                                  nothing decided either way.
 *                                                  MEASURED: this is every
 *                                                  cancelled session, because
 *                                                  cancel erases last_error.
 *   canceled + last_error         -> rejected      Stripe refused the document
 *                                                  AND the session accepts no
 *                                                  further input. UNREACHABLE
 *                                                  on today's API — see below.
 *   anything else                 -> needs_review  fail closed.
 *
 * THE LAST ROW IS UNREACHABLE ON TODAY'S STRIPE, AND SAYING SO IS THE POINT.
 *
 * `rejected` in this build means "a decision to say no, terminal". An earlier
 * draft of this comment asserted that a cancelled session carried the refusal
 * that preceded it. RE-MEASURED against the live test-mode API on 2026-09-10,
 * and that is FALSE:
 *
 *   GET  /v1/identity/verification_sessions/vs_1UEFoWDgSL5WTGpmMCJLolW6
 *        -> 200, status `requires_input`, last_error
 *           {code: "document_unverified_other", reason: "The document is invalid."}
 *   POST /v1/identity/verification_sessions/vs_1UEFoWDgSL5WTGpmMCJLolW6/cancel
 *        -> 200, status `canceled`, and **last_error is now null**, along with
 *           `url` and `client_secret`. Cancelling ERASES the refusal.
 *   GET  the same session again -> 200, still `canceled`, still last_error null.
 *        Not a quirk of the cancel response: the object itself no longer
 *        carries the code.
 *   POST .../cancel a second time -> 200, a no-op, so the state is stable.
 *   POST /v1/identity/verification_sessions/vs_1UEDLcDgSL5WTGpmif87HEZ7/cancel
 *        -> 400 "You cannot cancel this VerificationSession because it has a
 *        status of \"verified\". Only a VerificationSession in
 *        \"requires_input\" status may be canceled." Stripe enforces the
 *        transition itself, which is what makes `canceled` a provider fact and
 *        not a local flag.
 *   POST .../redact -> 200, `redaction: {status: "processing"}`, status stays
 *        `canceled` and last_error stays null.
 *
 * CONSEQUENCE, STATED PLAINLY RATHER THAN LEFT FOR SOMEBODY TO FIND: on Stripe
 * Identity, this build cannot reach `rejected` on real evidence. Every terminal
 * state Stripe will sell us has had the refusal deleted out of it, and a
 * `canceled` with no `last_error` is NOT a decline — there is no refusal left to
 * point at, and manufacturing one out of an operator's click is exactly the
 * forgery this module exists to prevent. So the director leg's worst real
 * outcome is `needs_review`.
 *
 * The composite still reaches `rejected` on live third-party evidence, and it
 * does so on the OTHER leg: GLEIF answers `entity.status INACTIVE` /
 * `registration.status RETIRED` for a real withdrawn company, and HTTP 404 for
 * an LEI an applicant asserted that does not exist. Strictest-wins carries
 * either of those to the composite. A rejected verification on this book is a
 * real registry's refusal, not a button we pressed.
 *
 * The `canceled + last_error -> rejected` row is KEPT rather than deleted,
 * because it is the correct reading if Stripe ever stops erasing the field, and
 * a mapping that is right only for the states a provider happens to emit this
 * month is a mapping that fails silently when they add one. It is dead today
 * and labelled dead.
 *
 * `Object.hasOwn` rather than a bare index, for the same reason
 * `personaStatusToKyb` uses it: `MAP['toString']` walks the prototype chain and
 * returns a FUNCTION, which `?? 'needs_review'` would pass straight through as
 * a status. A provider's status field is untrusted input like any other, and
 * this build's own test suite caught it here.
 * ===========================================================================
 */
export function stripeIdentityStatusToKyb(
  raw: string | null | undefined,
  lastErrorCode: string | null = null,
): KybStatus {
  if (typeof raw !== "string") return "needs_review";
  if (raw === "canceled" && lastErrorCode !== null) return "rejected";
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
          ...(rawStatus === "canceled" && lastErrorCode !== null
            ? [
                "the session is canceled, so Stripe accepts no further document for it: url and client_secret are null and a re-cancel is a no-op",
              ]
            : []),
          ...(rawStatus !== null && !Object.hasOwn(STRIPE_IDENTITY_STATUS_MAP, rawStatus)
            ? ["status not recognised by this build; held for review"]
            : []),
        ],
      },
      // The provider's OWN machine-readable code, under the reserved name, so
      // the screen can print `document_unverified_other` rather than a mood.
      // A session with no error still emits the row, carrying the session
      // status, because "no code" is itself worth being able to see.
      {
        name: KYB_PROVIDER_CODE_CHECK,
        status: status === "approved" ? "passed" : lastErrorCode === null ? "pending" : "failed",
        reasons: [
          lastErrorCode ?? `stripe_identity_${rawStatus ?? "unknown"}`,
          ...(lastErrorReason === null ? [] : [lastErrorReason]),
        ],
      },
      {
        name: KYB_CITATION_CHECK,
        status: "passed",
        reasons: [
          `Stripe Identity verification session ${readString(session, ["id"]) ?? "(no id)"} — status ${rawStatus ?? "(absent)"}${
            lastErrorCode === null ? "" : `, last_error.code ${lastErrorCode}`
          }; re-readable with GET /v1/identity/verification_sessions/{id}`,
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
 * Why the registry leg WOULD be the simulator, in one sentence the screen
 * prints verbatim when `KYB_FORCE_SIMULATED` names it. Measured, not assumed —
 * see DECISIONS 015, 017 and 018.
 *
 * It is no longer the default: `GleifRegistryProvider` answers this leg live.
 * The sentence is kept because the escape hatch is kept, and a leg that has
 * been forced back to the simulator has to say why it is one.
 */
export const REGISTRY_SIMULATED_REASON =
  "forced to the labelled simulator. The live registry (GLEIF) is available with no credentials; every KYB *vendor* on the brief's menu (Middesk, Persona KYB, Sumsub KYB) is gated behind a sales conversation, and Stripe Connect behind platform onboarding, which is why the simulator exists at all";

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

  return { director, registry: selectRegistryLeg(env) };
}

/**
 * The registry leg, chosen off the PRECEDENCE LADDER.
 *
 * ===========================================================================
 * GLEIF IS A RUNG, NOT A HARD-CODING, AND THAT IS THE WHOLE POINT.
 *
 * `./registry-precedence.ts` holds the order — Persona KYB, Middesk, Sumsub,
 * Stripe Connect, GLEIF — and this function walks it. Every vendor named by the
 * brief sits ABOVE GLEIF, so the day a credential for one of them arrives, the
 * next boot picks it up and nothing in this file, in `composite.ts`, in the
 * screen or in the database changes. That is what makes the substitution a
 * considered fallback rather than the only thing anyone tried.
 *
 * `selectKybLegs()` in ./index.ts walks the SAME table, which is why
 * `/api/health` and this screen cannot describe this leg differently.
 *
 * LIVE WITHOUT A CREDENTIAL, at the bottom rung: `api.gleif.org` is a public,
 * key-less, CC0 index, so that rung always matches and this leg can never be
 * misconfigured into silently pretending. Every variable on the ladder UPGRADES
 * the leg; none of them is required for it to be live.
 *
 * The one switch is `KYB_FORCE_SIMULATED=business_registry`, honoured ahead of
 * the whole ladder, which puts the labelled simulator back. It is deliberately
 * still here: it is the documented way to demonstrate the composite's
 * degradation rule on demand, and the screen prints `REGISTRY_SIMULATED_REASON`
 * verbatim when it is used.
 * ===========================================================================
 */
function selectRegistryLeg(env: EnvBag): WiredLeg {
  if (isForcedSimulated(env, "business_registry")) {
    return {
      leg: "business_registry",
      mode: "simulated",
      provider: new SimulatedRegistryProvider(),
      evidence: "simulated",
      reason: `${REGISTRY_SIMULATED_REASON} (set by ${KYB_ENV.forceSimulated})`,
      // A forced leg is not a misconfigured one: naming an env var here would
      // send the next operator looking for a key that does not exist.
      missingEnv: [],
    };
  }

  const choice = chooseRegistryProvider(env);
  return {
    leg: "business_registry",
    mode: "live",
    provider: choice.provider,
    evidence: "live",
    // A rung whose credential is present but whose adapter is unwritten does not
    // disappear quietly. It is named here, in the sentence the wiring panel
    // prints, because a deployment that set MIDDESK_API_KEY and is still running
    // GLEIF looks exactly like one where the key took effect.
    reason:
      choice.blocked.length === 0
        ? choice.rung.reason
        : `${choice.rung.reason} — BUT NOTE: ${choice.blocked.join(" ")}`,
    missingEnv: [],
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
    // Both surfaces derive the registry leg from the same `selectKybLegs()`
    // rule now, so this is normally null. It is KEPT, and computed rather than
    // deleted, because "the health endpoint and the screen describe the same
    // leg differently" is the precise failure this codebase has caught five
    // times (DECISIONS 011, 015, 016, 017, 026) and a check that only exists
    // while it is failing is not a check.
    healthDisagreement:
      health.registry.mode === registry.mode && health.director.mode === director.mode
        ? null
        : `/api/health describes this deployment's legs as director=${health.director.mode}, registry=${health.registry.mode}; this screen wires director=${director.mode}, registry=${registry.mode}. Two surfaces disagreeing about live-vs-simulated is how a simulated integration ends up presented as a live one, so it is reported rather than smoothed over.`,
  };
}

/**
 * ===========================================================================
 * THE FRAMING, COMPUTED FROM THE WIRING RATHER THAN WRITTEN INTO A PARAGRAPH.
 *
 * The two legs are live for different reasons and they are not equally
 * compliant with the brief, so this function refuses to describe them with one
 * sentence:
 *
 *   DIRECTOR KYC IS ON THE BRIEF. The brief's KYC menu names Persona, Sumsub,
 *   Stripe Identity and Onfido. Stripe Identity is on it. This half is
 *   compliant and needs no apology, and pretending otherwise out of modesty
 *   would be its own kind of inaccuracy.
 *
 *   BUSINESS REGISTRY IS A SUBSTITUTION. The brief names Persona KYB, Middesk
 *   and Sumsub. GLEIF is none of them. Measured: Persona's KYB guide opens by
 *   telling you to contact their team and signup needs a business email this
 *   build does not have; Middesk and Sumsub KYB are both behind a sales
 *   conversation; Stripe Connect was the fourth candidate and is gated behind
 *   platform onboarding (DECISION 017). So the leg is live AND substituted, and
 *   the badge says both words rather than picking the flattering one.
 *
 * `limits` and `reachableStatuses` are the two fields that keep this from being
 * marketing. The first says what a hit does NOT prove; the second says which
 * statuses the provider will actually produce, which for Stripe Identity is
 * fewer than its own mapping table contains.
 * ===========================================================================
 */
const DIRECTOR_LIMITS_STRIPE: readonly string[] = [
  "it verifies a DOCUMENT and a selfie — it does not prove that person controls this business",
  "it does not check the ownership tree or beneficial ownership",
  "it does not screen sanctions, PEP or adverse media",
];

const DIRECTOR_LIMITS_SIMULATED: readonly string[] = [
  "no identity document was examined by anyone, because nobody was asked",
];

/**
 * MEASURED 2026-09-10, and the reason this field exists at all.
 *
 * Cancelling a Stripe Identity session ERASES its `last_error`, so the only
 * terminal state their API will sell us is one with the refusal deleted out of
 * it. A cancel with no refusal to point at is not a decline. The director leg
 * therefore cannot reach `rejected` on real evidence, and the composite's
 * `rejected` is earned on the registry leg instead — see
 * `stripeIdentityStatusToKyb` for the full transcript.
 */
const STRIPE_IDENTITY_REACHABILITY =
  "MEASURED: `rejected` is not reachable on this leg. Stripe will not hand back a terminal session that still carries its refusal — POST /cancel returns 200 with `last_error` set to null — and a cancelled session with no refusal in it is not a decline. A `rejected` on this book is the REGISTRY leg's: GLEIF answering INACTIVE/RETIRED for a withdrawn company, or 404 for an asserted LEI that does not exist.";

const GLEIF_REACHABILITY =
  "All four are reachable and three of them have been produced live: approved (Apple Inc., California Secretary of State entry 806592), rejected (RESILIENCE PARENT, LLC — entity INACTIVE, registration RETIRED; and HTTP 404 on an asserted LEI), needs_review (every seeded business, plus LAPSED registrations and PARTIALLY_CORROBORATED records). `pending` arrives only when GLEIF itself does not answer.";

function toLegWiringView(leg: WiredLeg): LegWiringView {
  const isGleif = leg.provider.name === GLEIF_PROVIDER_NAME;
  const isStripeIdentity = leg.provider.name === STRIPE_IDENTITY_PROVIDER_NAME;

  /**
   * COMPLIANCE IS READ OFF THE LADDER, NOT OFF A HARD-CODED NAME.
   *
   * `onBrief` is a property of the rung that won, so the day the Persona KYB
   * rung is selected this badge flips to "on the brief's menu" with no edit
   * here — and if somebody adds a rung and forgets to say whether the brief
   * names it, the honest default is that it does not.
   */
  const rung = leg.leg === "business_registry" ? rungForProviderName(leg.provider.name) : undefined;

  const compliance: LegWiringView["compliance"] =
    leg.mode === "simulated"
      ? "simulated"
      : leg.leg === "business_registry"
        ? (rung?.onBrief ?? false)
          ? "on-brief"
          : "substituted"
        : "on-brief";

  return {
    leg: leg.leg,
    label: KYB_LEG_LABEL[leg.leg],
    mode: leg.mode,
    provider: leg.provider.name,
    evidence: leg.evidence,
    reason: leg.reason,
    missingEnv: leg.missingEnv,
    compliance,
    complianceLabel:
      compliance === "on-brief"
        ? "on the brief's menu"
        : compliance === "substituted"
          ? "LIVE, but a SUBSTITUTION"
          : "SIMULATED — nobody asked",
    complianceNote:
      compliance === "on-brief"
        ? "The brief's KYC identity menu names Persona, Sumsub, Stripe Identity and Onfido. This leg is Stripe Identity, so it is one of the named options — compliant, not substituted."
        : compliance === "substituted"
          ? "The brief names Persona KYB, Middesk and Sumsub for this slot and GLEIF is none of them. All three were measured shut: Persona's KYB guide starts with \"contact our team\" and signup wants a business email this build has not got; Middesk and Sumsub KYB are behind a sales conversation; Stripe Connect, the fourth candidate, is gated behind platform onboarding. So this leg is a real third-party registry queried live AND an explicit substitution. Both, in that order, every time it is named."
          : "Nobody was asked. This leg is a labelled simulator and its answers are admissible as a demonstration and as nothing else.",
    limits: isGleif
      ? GLEIF_LIMITS
      : isStripeIdentity
        ? DIRECTOR_LIMITS_STRIPE
        : DIRECTOR_LIMITS_SIMULATED,
    reachableStatuses: isStripeIdentity
      ? ["approved", "pending", "needs_review"]
      : ["approved", "pending", "needs_review", "rejected"],
    reachabilityNote: isStripeIdentity
      ? STRIPE_IDENTITY_REACHABILITY
      : isGleif
        ? GLEIF_REACHABILITY
        : null,
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
  /**
   * Set on a review row and null on every provider observation, in both
   * directions — `kyb_leg_manual_has_reviewer` in 0013 refuses either half
   * without the other, so these three travel together or not at all.
   */
  readonly decidedByActorId: string | null;
  readonly decidedByKind: string | null;
  readonly decisionReason: string | null;
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
export function legRow(
  businessId: string,
  leg: KybLegResult,
  review: { readonly reviewer: Reviewer; readonly reason: string } | null = null,
): KybLegRow {
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
    decidedByActorId: review?.reviewer.id ?? null,
    decidedByKind: review?.reviewer.kind ?? null,
    decisionReason: review?.reason.trim() ?? null,
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
    await insertLeg(businessId, row, conn);
  }
}

/**
 * The ONE INSERT in this module.
 *
 * Every path that records an observation — begin, refresh, a registry recheck,
 * an operator review — goes through here, so there is exactly one statement to
 * read when asking what can be written to the evidence table and exactly one
 * place a column can be forgotten. The previous draft had this SQL written out
 * twice and the second copy had already drifted.
 */
async function insertLeg(businessId: string, row: KybLegRow, conn: Sql): Promise<void> {
  await conn`
    INSERT INTO kyb_verification_leg
      (business_id, leg, provider, provider_reference, status, evidence, raw_status, checks,
       observed_at, decided_by_actor_id, decided_by_kind, decision_reason)
    VALUES
      (${businessId}::uuid,
       ${row.leg}::kyb_leg,
       ${row.provider},
       ${row.providerReference},
       ${row.status}::kyb_status,
       ${row.evidence}::kyb_evidence,
       ${row.rawStatus},
       ${conn.json(checksAsJson(row.checks))},
       ${row.observedAt}::timestamptz,
       ${row.decidedByActorId}::uuid,
       ${row.decidedByKind === null ? null : row.decidedByKind}::actor_kind,
       ${row.decisionReason})`;
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

/**
 * The `business` table holds a legal name and an EIN and nothing else, so an
 * asserted LEI can only come from the operator, per action. It is threaded
 * through rather than stored: `kyb_verification_leg` records what a PROVIDER
 * said, and an applicant's claim about themselves is not that. What survives is
 * the answer — the leg's `provider_reference` becomes the LEI GLEIF confirmed,
 * or `gleif.notfound.<LEI>` when GLEIF says that identifier does not exist.
 */
function inputFor(business: BusinessRow, lei: string | null): CreateKybVerificationInput {
  return {
    referenceId: business.id,
    businessName: business.legal_name,
    taxIdentificationNumber: business.ein,
    registeredAddress: PLACEHOLDER_REGISTERED_ADDRESS,
    ...(lei === null || lei.trim() === "" ? {} : { lei: lei.trim().toUpperCase() }),
  };
}

export interface WireOptions {
  readonly env?: EnvBag | undefined;
  readonly conn?: Sql | undefined;
  readonly provider?: CompositeKybProvider | undefined;
  readonly log?: Logger | undefined;
  /**
   * A Legal Entity Identifier the operator says belongs to this business.
   * Optional; absent means the registry leg falls back to a name search, whose
   * miss is `needs_review` and never an approval. See ./gleif.ts.
   */
  readonly lei?: string | undefined;
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
    result = await provider.begin(inputFor(business, options.lei ?? null));
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

  // Refresh re-reads each leg FROM THE PROVIDER, so it must start from the
  // provider's last word — not from an operator's.
  //
  // This regressed a live business. After a manual review the latest row on a
  // leg is the review itself, whose `provider_reference` is a
  // `manual.approve.…` string. Neither Stripe nor GLEIF can resolve that, both
  // correctly reported unavailable, unavailable maps to `pending`, and pending
  // beats approved under strictest-wins — so pressing "Refresh from the
  // provider" silently knocked an approved, funded business back to pending
  // and its evidence from `manual` to `simulated`.
  //
  // `priorProviderLeg()` already existed and already excluded manual rows; it
  // was used on one path and not this one. Nothing is overwritten either way —
  // the table is append-only, so the review is still on file and the operator
  // decision is not lost. What changes is which row we hand to a provider and
  // ask it to look up.
  const providerLeg = async (leg: KybLegKind): Promise<LegView | undefined> => {
    const latest = legs.find((l) => l.leg === leg);
    if (latest === undefined) return undefined;
    if (!isManualReview(latest)) return latest;
    return (await priorProviderLeg(conn, businessId, leg)) ?? undefined;
  };

  const director = await providerLeg("director_kyc");
  const registry = await providerLeg("business_registry");
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

/**
 * ASK THE REGISTRY AGAIN, ABOUT A SPECIFIC IDENTIFIER.
 *
 * ===========================================================================
 * This is the third verb, and it exists because of an asymmetry in what the two
 * legs cost.
 *
 * `begin()` refuses a business that already has evidence on file, because the
 * DIRECTOR leg is a real `POST` to Stripe and a screen that created a session
 * per click would litter a live account. The REGISTRY leg has no such cost:
 * GLEIF is a public read, it creates nothing, and repeating it is free.
 *
 * What makes this worth a verb rather than a parameter is that it asks a
 * DIFFERENT QUESTION. Without an LEI the registry leg does a name search, whose
 * miss is `needs_review` — correct, and uninformative. With one, the applicant
 * has ASSERTED an identifier, and a registry can be asked about an assertion
 * directly: it confirms it, or it contradicts it, or it has never heard of it,
 * and those are three different answers rather than three shades of one.
 *
 * The claim is not stored. `kyb_verification_leg` records what a provider said,
 * and "the applicant says their LEI is X" is not that. What lands in the table
 * is GLEIF's answer, under GLEIF's name, with GLEIF's own code — and, when the
 * identifier does not exist, a `gleif.notfound.` reference that says so in the
 * id itself.
 *
 * It appends. It never edits: the previous registry observation stays exactly
 * where it was, and "latest wins" is a fold over the table rather than an
 * UPDATE. So a business whose registry leg went miss -> confirmed has both rows,
 * in order, with both timestamps.
 * ===========================================================================
 */
export async function recheckRegistry(
  businessId: string,
  options: WireOptions = {},
): Promise<Result<VerificationOutcome, ErrorShape>> {
  const conn = options.conn ?? sql;
  const env = options.env ?? process.env;
  const log = (options.log ?? rootLogger).child({ businessId });

  const business = await loadBusiness(businessId, conn);
  if (business === null) {
    return fail("BUSINESS_NOT_FOUND", "No business on this book has that id. Nothing was asked of anyone.");
  }

  const legs = (await latestLegs(conn, businessId)).get(businessId) ?? [];
  const director = legs.find((l) => l.leg === "director_kyc");
  if (director === undefined) {
    return fail(
      "KYB_NOT_STARTED",
      "There is no verification on file. Start one first — a registry answer on its own is one leg, and the view reads a single leg as pending however good that leg is.",
    );
  }

  const selection = selectWiredLegs(env);
  const registryProvider = selection.registry.provider;
  const input = inputFor(business, options.lei ?? null);

  let registryLeg: KybLegResult;
  try {
    registryLeg = await registryProvider.begin(input);
  } catch (error) {
    // Same rule as everywhere else in this module: a provider that did not
    // answer produces a leg WE wrote, so it is labelled simulated and it is
    // pending. There is no silent fallback to a plausible answer.
    log.warn("kyb.registry.recheck.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    registryLeg = failedLeg("business_registry", registryProvider.name, error);
  }

  const result = CompositeKybResult.rehydrate(businessId, [
    legResultFromView(director),
    registryLeg,
  ]);

  await insertLeg(businessId, legRow(businessId, registryLeg), conn);

  log.info("kyb.registry.recheck.recorded", {
    provider: registryLeg.provider,
    status: registryLeg.status,
    evidence: registryLeg.evidence,
    assertedLei: (options.lei ?? "").trim() !== "",
  });

  return ok(toOutcome(business, result));
}

// ---------------------------------------------------------------------------
// 4b. ASK THE REGISTRY ABOUT SOMETHING THAT IS NOT ON THIS BOOK
// ---------------------------------------------------------------------------

/**
 * ===========================================================================
 * THE REGISTRY PROBE, AND WHY IT IS A SEPARATE VERB THAT WRITES NOTHING.
 *
 * Every business seeded on this book is fictional, so GLEIF answers `not in the
 * LEI registry` for all three, and that is the CORRECT answer — a miss is
 * evidence of nothing and can never be an approval. It is also, on its own, a
 * screen that only ever shows one outcome, which would leave a reviewer unable
 * to tell a registry that works from a registry that always shrugs.
 *
 * The dishonest fix is to seed a real company's name onto a demo row and let
 * the screen imply we verified it. This is the honest one: a probe that asks
 * the SAME live adapter about any name or LEI a reviewer types, renders the
 * verdict with its citation, and is labelled — in the type, in the action and
 * on the screen — as a question about the registry rather than a verification
 * of anybody.
 *
 * IT WRITES NOTHING. No row, no leg, no status. `kyb_verification_leg` records
 * what a provider said ABOUT A BUSINESS ON THIS BOOK, and an answer about Apple
 * Inc. is not that. A probe that persisted would be one INSERT away from a
 * business whose evidence cites a company it has no relationship with.
 * ===========================================================================
 */
export interface RegistryProbeView {
  /** Exactly what was asked, echoed back. */
  readonly query: string;
  /** Which question it became: an exact identifier lookup, or a name search. */
  readonly kind: "lei" | "name";
  /** The verdict, in the same shape a real leg is rendered in. */
  readonly leg: LegView;
}

/**
 * The sentinel `referenceId` a probe carries.
 *
 * It is not a business id and is not a uuid, deliberately: if this value ever
 * reached the `kyb_verification_leg` INSERT it would be refused by the column
 * type rather than filed against a real row. The type system says a probe does
 * not persist; this makes the database say it too.
 */
export const REGISTRY_PROBE_REFERENCE_ID = "probe.not-a-business";

/**
 * Ask the live registry adapter one question. Reads only.
 *
 * The country is asserted as US because this is a US business-account product
 * and the cross-border guard in `gleif.ts` needs something to compare against —
 * it is what makes an Irish company called "Apple Computer, Inc." come back
 * `needs_review` instead of `approved`.
 */
export async function probeRegistry(
  query: string,
  options: {
    readonly env?: EnvBag;
    readonly log?: Logger;
    /**
     * Test seam, matching the one every other verb in this module has. The
     * suite injects a recording stub so it can assert HOW the adapter was
     * asked — `refresh` for an identifier, `begin` for a name — which is a
     * claim about this function and not about GLEIF's data.
     */
    readonly registryProvider?: KybLegProvider<"live"> | undefined;
  } = {},
): Promise<Result<RegistryProbeView, ErrorShape>> {
  const trimmed = query.trim();
  if (trimmed === "") {
    return fail("PROBE_EMPTY", "Nothing was asked, so nothing was sent to the registry.");
  }

  const registry =
    options.registryProvider ?? selectWiredLegs(options.env ?? process.env).registry.provider;
  const asLei = isLeiFormat(trimmed);

  const input: CreateKybVerificationInput = {
    referenceId: REGISTRY_PROBE_REFERENCE_ID,
    businessName: trimmed,
    taxIdentificationNumber: "(not asserted — a probe carries no EIN)",
    registeredAddress: PLACEHOLDER_REGISTERED_ADDRESS,
  };

  let leg: KybLegResult;
  try {
    /**
     * AN IDENTIFIER LOOKUP ASSERTS NO NAME, so it goes through `refresh()`.
     *
     * The bug this replaced: `begin()` takes an application, and an application
     * always carries the applicant's `businessName` for the adapter to
     * re-verify a candidate against. A probe has no applicant — the only thing
     * typed was the LEI — so passing the LEI string as the name made every
     * identifier lookup re-verify a real legal name against twenty random
     * characters and come back `lei_name_mismatch`. Measured: LEI
     * 254900ZT6ZFUC887FB87 is a decline (entity INACTIVE, registration RETIRED)
     * and the probe reported it as a name mismatch, hiding the very outcome
     * this panel exists to demonstrate.
     *
     * `refresh()` is the verb for "re-read this identifier, asserting nothing
     * about who it belongs to", which is exactly what a probe is. It asserts no
     * country either — the cross-border guard is a check on an APPLICATION, and
     * there is no application here.
     */
    leg = asLei ? await registry.refresh(trimmed.toUpperCase()) : await registry.begin(input);
  } catch (error) {
    // Same rule as everywhere else: a provider that did not answer produces a
    // leg WE wrote, labelled simulated and pending. No silent fallback.
    (options.log ?? rootLogger).warn("kyb.registry.probe.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    leg = failedLeg("business_registry", registry.name, error);
  }

  return ok({
    query: trimmed,
    kind: asLei ? "lei" : "name",
    leg: toLegViewFromResult(leg),
  });
}

// ---------------------------------------------------------------------------
// 4c. THE OPERATOR DECISION
// ---------------------------------------------------------------------------

/**
 * Record a human's decision on one leg.
 *
 * ===========================================================================
 * It is an INSERT like every other observation, and that is the design. The
 * registry's answer is not edited, not flagged, not soft-deleted — it stays
 * exactly where it was, with its citation and its provider code, and this row
 * becomes the latest thing anybody said about that leg. `v_business_kyb` folds
 * it in with no special case; a reversal is a further row.
 *
 * THE CHECKS RUN TWICE, ON PURPOSE. `reviewRefusal()` is pure and is called by
 * the screen to grey a control and explain why. It is called again HERE, on the
 * server, against the state read in this transaction — because the first call
 * is a courtesy and this one is the control. Underneath both, 0013 restates the
 * reviewer, the reason floor and the provider name as database CHECKs.
 * ===========================================================================
 */
export async function recordManualReview(
  businessId: string,
  args: {
    readonly leg: KybLegKind;
    readonly decision: ManualDecision;
    readonly reason: string;
    readonly reviewer: Reviewer;
  },
  options: { readonly conn?: Sql; readonly log?: Logger } = {},
): Promise<Result<VerificationOutcome, ErrorShape>> {
  const conn = options.conn ?? sql;
  const log = (options.log ?? rootLogger).child({ businessId, leg: args.leg });

  const business = await loadBusiness(businessId, conn);
  if (business === null) {
    return fail("BUSINESS_NOT_FOUND", "No business on this book has that id. Nothing was decided.");
  }

  const legs = (await latestLegs(conn, businessId)).get(businessId) ?? [];
  const current = legs.find((l) => l.leg === args.leg) ?? null;

  const refusal = reviewRefusal({
    decision: args.decision,
    reviewer: args.reviewer,
    currentStatus: current?.status ?? null,
    reason: args.reason,
  });
  if (refusal !== null) return fail(refusal.code, refusal.message);

  /**
   * WHAT IS BEING OVERRIDDEN is the latest THIRD-PARTY observation, not simply
   * the latest one. If an operator approves, changes their mind, declines, and
   * then approves again, all three of those are reviews — and the thing the
   * screen must keep showing underneath is what the REGISTRY said, which is
   * older than all of them.
   */
  const overridden = current !== null && isManualReview(current) ? await priorProviderLeg(conn, businessId, args.leg) : current;

  const leg = manualReviewLeg({
    leg: args.leg,
    decision: args.decision,
    reviewer: args.reviewer,
    reason: args.reason,
    businessId,
    overriding:
      overridden === null
        ? null
        : {
            provider: overridden.provider,
            status: overridden.status,
            rawStatus: overridden.rawStatus,
            providerCode: overridden.providerCode,
          },
  });

  await insertLeg(businessId, legRow(businessId, leg, { reviewer: args.reviewer, reason: args.reason }), conn);

  log.info("kyb.review.recorded", {
    decision: args.decision,
    reviewerId: args.reviewer.id,
    overrodeProvider: overridden?.provider ?? null,
    overrodeStatus: overridden?.status ?? null,
  });

  // Re-read, so the outcome returned is the DERIVED state and not this
  // function's opinion of what it should now be.
  const after = (await latestLegs(conn, businessId)).get(businessId) ?? [];
  const result = CompositeKybResult.rehydrate(businessId, after.map(legResultFromView));
  return ok(toOutcome(business, result));
}

/**
 * A stored leg row, back into the shape the composite folds.
 *
 * `hostedUrl` is null on the way back and that is correct rather than lossy: a
 * provider's hosted URL is single-use and short-lived, which is why it is never
 * stored, so a leg read from the table genuinely has none.
 */
function legResultFromView(leg: LegView): KybLegResult {
  return {
    leg: leg.leg,
    provider: leg.provider,
    reference: leg.reference,
    referenceId: null,
    status: leg.status,
    rawStatus: leg.rawStatus,
    checks: leg.checks,
    hostedUrl: null,
    observedAt: leg.observedAt,
    evidence: leg.evidence,
  };
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
    // Both are READ OUT OF the evidence rather than passed alongside it, so the
    // code the screen prints is the code that was stored, not a second copy.
    providerCode: providerCodeFromChecks(leg.checks),
    citation: citationFromChecks(leg.checks),
    checks: leg.checks,
    observedAt: leg.observedAt,
    // A freshly-built result carries no reviewer join; the screen reads reviews
    // back through `latestLegs`, which does. Null here is "not looked up", and
    // it is never rendered as "not reviewed" because this shape is only used
    // for the action's immediate echo.
    review: null,
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
  readonly decided_by_actor_id: string | null;
  readonly decision_reason: string | null;
  readonly decided_by_name: string | null;
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
        SELECT DISTINCT ON (k.business_id, k.leg)
               k.business_id, k.leg::text AS leg, k.provider, k.provider_reference,
               k.status::text AS status, k.evidence::text AS evidence,
               k.raw_status, k.checks, k.observed_at,
               k.decided_by_actor_id, k.decision_reason, a.display_name AS decided_by_name
          FROM kyb_verification_leg k
          LEFT JOIN actor a ON a.id = k.decided_by_actor_id
         ORDER BY k.business_id, k.leg, k.observed_at DESC, k.recorded_at DESC, k.seq DESC`
    : await conn<LegRowRead[]>`
        SELECT DISTINCT ON (k.business_id, k.leg)
               k.business_id, k.leg::text AS leg, k.provider, k.provider_reference,
               k.status::text AS status, k.evidence::text AS evidence,
               k.raw_status, k.checks, k.observed_at,
               k.decided_by_actor_id, k.decision_reason, a.display_name AS decided_by_name
          FROM kyb_verification_leg k
          LEFT JOIN actor a ON a.id = k.decided_by_actor_id
         WHERE k.business_id = ${businessId}::uuid
         ORDER BY k.business_id, k.leg, k.observed_at DESC, k.recorded_at DESC, k.seq DESC`;

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
 * THE ANSWER A REVIEW OVERRODE: the latest observation on this leg that a
 * PROVIDER made, skipping every operator decision above it.
 *
 * This is what keeps the override honest on screen. "Latest wins" means a
 * manual approval hides the registry's own answer from the fold, and a screen
 * that only rendered the fold would show a green `approved` with no trace of
 * the `not_in_lei_registry` underneath it — which is precisely the collapsing
 * of two facts into one word that the review mechanism exists to avoid. So the
 * superseded provider row is fetched alongside and rendered beneath.
 *
 * `evidence <> 'manual'` rather than `provider <> 'operator-review'`: the
 * evidence label is the one 0013 constrains in both directions, so it is the
 * one that cannot drift.
 */
async function priorProviderLeg(
  conn: Sql,
  businessId: string,
  leg: KybLegKind,
): Promise<LegView | null> {
  const rows = await conn<LegRowRead[]>`
    SELECT k.business_id, k.leg::text AS leg, k.provider, k.provider_reference,
           k.status::text AS status, k.evidence::text AS evidence,
           k.raw_status, k.checks, k.observed_at,
           k.decided_by_actor_id, k.decision_reason, NULL::text AS decided_by_name
      FROM kyb_verification_leg k
     WHERE k.business_id = ${businessId}::uuid
       AND k.leg = ${leg}::kyb_leg
       AND k.evidence <> 'manual'
     ORDER BY k.observed_at DESC, k.recorded_at DESC, k.seq DESC
     LIMIT 1`;
  const row = rows[0];
  return row === undefined ? null : toLegViewFromRow(row);
}

/** The same, for every business at once. One query, not N. */
async function priorProviderLegs(
  conn: Sql,
  businessId?: string,
): Promise<Map<string, readonly LegView[]>> {
  const rows = businessId === undefined
    ? await conn<LegRowRead[]>`
        SELECT DISTINCT ON (k.business_id, k.leg)
               k.business_id, k.leg::text AS leg, k.provider, k.provider_reference,
               k.status::text AS status, k.evidence::text AS evidence,
               k.raw_status, k.checks, k.observed_at,
               k.decided_by_actor_id, k.decision_reason, NULL::text AS decided_by_name
          FROM kyb_verification_leg k
         WHERE k.evidence <> 'manual'
         ORDER BY k.business_id, k.leg, k.observed_at DESC, k.recorded_at DESC, k.seq DESC`
    : await conn<LegRowRead[]>`
        SELECT DISTINCT ON (k.business_id, k.leg)
               k.business_id, k.leg::text AS leg, k.provider, k.provider_reference,
               k.status::text AS status, k.evidence::text AS evidence,
               k.raw_status, k.checks, k.observed_at,
               k.decided_by_actor_id, k.decision_reason, NULL::text AS decided_by_name
          FROM kyb_verification_leg k
         WHERE k.business_id = ${businessId}::uuid AND k.evidence <> 'manual'
         ORDER BY k.business_id, k.leg, k.observed_at DESC, k.recorded_at DESC, k.seq DESC`;

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

  const checks = parseChecks(row.checks);
  return {
    leg,
    label: KYB_LEG_LABEL[leg],
    provider: row.provider,
    reference: row.provider_reference,
    status,
    evidence,
    rawStatus: row.raw_status,
    providerCode: providerCodeFromChecks(checks),
    citation: citationFromChecks(checks),
    checks,
    observedAt: row.observed_at.toISOString(),
    // Populated ONLY from the columns, never from `checks` — the jsonb is the
    // reviewer's prose and the columns are the record. 0013 refuses one
    // without the other, so this is null on every provider row by construction.
    review:
      row.decided_by_actor_id === null || row.decision_reason === null
        ? null
        : {
            decidedByActorId: row.decided_by_actor_id,
            decidedBy: row.decided_by_name ?? "(actor no longer on the book)",
            reason: row.decision_reason,
            decidedAt: row.observed_at.toISOString(),
            overrode: null,
          },
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

/**
 * Attach, to each review row, the provider answer it superseded.
 *
 * Done here rather than in SQL because it is a presentation join: the two
 * queries each answer a clean question ("latest per leg", "latest PROVIDER row
 * per leg") and pairing them is cheap. Doing it in one query would need a
 * lateral or a window over a table whose read pattern is already indexed for
 * exactly these two orders.
 */
function withOverrides(
  legs: readonly LegView[],
  priors: readonly LegView[],
): readonly LegView[] {
  return legs.map((leg) => {
    if (leg.review === null) return leg;
    const prior = priors.find((p) => p.leg === leg.leg);
    if (prior === undefined) return leg;
    return {
      ...leg,
      review: {
        ...leg.review,
        overrode: {
          provider: prior.provider,
          status: prior.status,
          rawStatus: prior.rawStatus,
          providerCode: prior.providerCode,
          citation: prior.citation,
          observedAt: prior.observedAt,
        },
      },
    };
  });
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

  // The view's CASE guarantees a value; the fallbacks are the same fail-closed
  // reading the gate applies to a row it cannot parse.
  const derivedStatus = status ?? "needs_review";
  const derivedEvidence = evidence ?? "simulated";

  return {
    businessId: row.business_id,
    legalName: row.legal_name,
    ein: row.ein,
    status: derivedStatus,
    evidence: derivedEvidence,
    legsOnFile: Number(row.legs_on_file),
    decidedAt: row.decided_at === null ? null : row.decided_at.toISOString(),
    legs,
    verdict: verdictView(derivedStatus, derivedEvidence, legs),
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
        const [rows, legs, priorLegs, accounts] = await Promise.all([
          conn<KybViewRow[]>`
            SELECT v.business_id, v.legal_name, b.ein,
                   v.legs_on_file, v.kyb_status::text AS kyb_status,
                   v.kyb_evidence::text AS kyb_evidence, v.decided_at
              FROM v_business_kyb v
              JOIN business b ON b.id = v.business_id
             ORDER BY v.legal_name`,
          latestLegs(conn),
          priorProviderLegs(conn),
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
              withOverrides(
                legs.get(row.business_id) ?? [],
                priorLegs.get(row.business_id) ?? [],
              ),
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
