/**
 * Provider-agnostic KYB / business-verification interface + a Persona implementation.
 *
 * DRAFT — research spike. Written against Persona docs (2025-12-08 API version) on
 * 2026-09-09. Shapes taken from the published OpenAPI-derived reference are marked
 * as verified in NOTES.md; everything I could not confirm from a doc page is marked
 * inline with `// UNVERIFIED:`.
 *
 * Docs used:
 *  - https://docs.withpersona.com/authentication
 *  - https://docs.withpersona.com/api-reference/inquiries/create-an-inquiry
 *  - https://docs.withpersona.com/api-reference/inquiries/retrieve-an-inquiry
 *  - https://docs.withpersona.com/api-reference/inquiries/perform-simulate-actions
 *  - https://docs.withpersona.com/integration-testing
 *  - https://docs.withpersona.com/model-lifecycle
 *  - https://docs.withpersona.com/webhooks-best-practices
 *  - https://docs.withpersona.com/integration-guide-kyb-via-api
 *  - https://docs.stripe.com/webhooks  (Stripe-Signature scheme, 300s tolerance)
 *  - https://docs.stripe.com/connect/testing  (magic EINs incl. 222221000-222221005)
 *  - https://docs.stripe.com/connect/testing-verification
 *  - https://docs.stripe.com/api/accounts/object  (requirements.errors[])
 *
 * IMPORTANT (see NOTES.md): Persona's real KYB product (the Transactions-based flow,
 * Business Registry Verification, Business Watchlist) is NOT on the free self-serve
 * tier. Implementations here, in the order you'd actually reach for them:
 *
 *   - PersonaDirectorKycProvider   live sandbox individual KYC. Free, self-serve, and
 *                                  the only provider whose statuses can be driven from
 *                                  the server (perform-simulate-actions).
 *   - StripeConnectRegistryProvider  live company-registry check in Stripe test mode.
 *                                  Free, self-serve, real failure codes.
 *   - SimulatedRegistryProvider    labelled fallback if Connect turns out gated.
 *                                  Always reports evidence: "simulated".
 *   - PersonaKybProvider           the real Persona KYB. Needs a transaction type that
 *                                  only Persona can provision. Kept so the production
 *                                  shape is written down.
 *   - CompositeKybProvider         person leg + business leg, strictest status wins,
 *                                  evidence degrades to "simulated" if either leg was.
 *
 * Stripe Identity is deliberately absent: it is individual KYC only, and it has no
 * documented way to force verified/requires_input/processing in test mode (no CLI
 * trigger fixture exists), which makes it a poor fit for demoing lifecycle states.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/* -------------------------------------------------------------------------- */
/*  Domain types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Normalised status across providers. Maps onto Persona's inquiry lifecycle
 * (created / pending / completed / expired / failed / needs_review / approved /
 * declined) — https://docs.withpersona.com/model-lifecycle
 */
export type VerificationStatus =
  | "created"
  | "pending"
  | "approved"
  | "declined"
  | "needs_review"
  | "expired"
  | "failed";

export interface Address {
  street1: string;
  street2?: string;
  city: string;
  /** Persona wants ISO 3166-2 subdivision. NB: the KYB-via-API guide says abbreviated
   *  ("CA") for business addresses, but the Inquiry `fields.address-subdivision` doc
   *  says UNABBREVIATED ("California") for US residence addresses. Do not share one
   *  formatter between the two. */
  subdivision: string;
  postalCode: string;
  /** 2-letter ISO country code, e.g. "US" */
  countryCode: string;
}

export interface AssociatedPerson {
  firstName: string;
  lastName: string;
  middleName?: string;
  /** 0–100 */
  percentageOwnership?: number;
  /** Freeform, e.g. "CEO", "UBO" */
  association?: string;
  /** YYYY-MM-DD */
  birthdate?: string;
  address?: Address;
  /** SSN for an individual. Never log this. */
  taxIdentificationNumber?: string;
  emailAddress?: string;
  phoneNumber?: string;
}

export interface CreateBusinessVerificationInput {
  /** Our own id for the business; round-trips back on webhooks. */
  referenceId: string;
  businessName: string;
  /** EIN, e.g. "12-3456789" */
  taxIdentificationNumber: string;
  registeredAddress: Address;
  physicalAddress?: Address;
  associatedPeople?: AssociatedPerson[];
  /** Sandbox only. Forces the outcome so we can demo non-happy paths. */
  sandboxOutcome?: "passed" | "failed";
}

export interface VerificationCheck {
  name: string;
  status: "passed" | "failed" | "not_applicable";
  reasons?: string[];
}

export interface VerificationResult {
  /** Provider-side id (Persona: `inq_…` / `txn_…`). */
  id: string;
  provider: string;
  status: VerificationStatus;
  referenceId: string | null;
  /** Where to send the end user to complete the flow, if the provider has one. */
  hostedUrl?: string;
  checks?: VerificationCheck[];
  createdAt?: string;
  updatedAt?: string;
  /** Whether the underlying data came from a real third party or was simulated by us.
   *  Surfaced in the UI so nothing is passed off as a real registry hit. */
  evidence: "live-third-party" | "simulated";
  raw?: unknown;
}

export interface WebhookVerificationResult {
  valid: boolean;
  /** Provider event name, e.g. "inquiry.approved". Only set when `valid`. */
  eventName?: string;
  /** Parsed body. Only set when `valid` — never parse before verifying. */
  event?: unknown;
  reason?: string;
}

export interface KybProvider {
  readonly name: string;
  createBusinessVerification(
    input: CreateBusinessVerificationInput,
  ): Promise<VerificationResult>;
  getVerification(id: string): Promise<VerificationResult>;
  /**
   * `rawBody` MUST be the exact bytes received. Do not pass a re-serialised object:
   * Persona explicitly warns that JSON round-tripping can change float precision and
   * break the HMAC. https://docs.withpersona.com/webhooks-best-practices
   */
  verifyWebhook(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): WebhookVerificationResult;
}

/* -------------------------------------------------------------------------- */
/*  Shared helpers                                                            */
/* -------------------------------------------------------------------------- */

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== target) continue;
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Constant-time compare of two hex strings of possibly differing length. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/* -------------------------------------------------------------------------- */
/*  Persona: webhook signature verification                                   */
/* -------------------------------------------------------------------------- */

/**
 * Persona-Signature verification.
 *
 * VERIFIED against https://docs.withpersona.com/webhooks-best-practices and the
 * Node sample in https://docs.withpersona.com/quickstart-webhooks:
 *
 *   header name : `Persona-Signature`
 *   format      : `t=<unix_seconds>,v1=<hex>`
 *                 during secret rotation: `t=...,v1=<new> t=...,v1=<old>`
 *                 (two space-separated pairs; accept EITHER)
 *   algorithm   : HMAC-SHA256, hex digest
 *   signed data : `${t}.${rawBody}`  (literal dot between timestamp and raw body)
 *   secret      : the webhook's `wbhsec_…` value from Dashboard > Webhooks,
 *                 or `data.attributes.secrets[].value` from the Webhooks API.
 *
 * UNVERIFIED: Persona does NOT document a replay tolerance window anywhere I could
 * find. The `t` value is supplied "for your reference". 5 minutes is our own choice,
 * borrowed from the Stripe convention — it is not a Persona-published number.
 */
export const PERSONA_SIGNATURE_HEADER = "Persona-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function verifyPersonaSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): { valid: boolean; reason?: string } {
  if (!signatureHeader) return { valid: false, reason: "missing_signature_header" };
  if (!secret) return { valid: false, reason: "missing_secret" };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  // During rotation the header holds two space-separated `t=..,v1=..` groups.
  const groups = signatureHeader.trim().split(/\s+/).filter(Boolean);
  if (groups.length === 0) return { valid: false, reason: "malformed_signature_header" };

  // Persona's own samples read the timestamp from the FIRST group only. Both groups
  // carry a `t=` though, so verify each group against its own `t` — strictly safer
  // and still accepts everything the documented scheme produces.
  let sawWellFormed = false;
  let anyTimestampFresh = false;

  for (const group of groups) {
    const t = /(?:^|,)t=([^,]+)/.exec(group)?.[1];
    const v1 = /(?:^|,)v1=([^,\s]+)/.exec(group)?.[1];
    if (!t || !v1) continue;
    sawWellFormed = true;

    if (tolerance > 0) {
      const ts = Number.parseInt(t, 10);
      if (!Number.isFinite(ts)) continue;
      const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
      if (Math.abs(now - ts) > tolerance) continue;
    }
    anyTimestampFresh = true;

    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    if (safeEqualHex(expected, v1)) return { valid: true };
  }

  if (!sawWellFormed) return { valid: false, reason: "malformed_signature_header" };
  if (!anyTimestampFresh) return { valid: false, reason: "timestamp_outside_tolerance" };
  return { valid: false, reason: "signature_mismatch" };
}

/* -------------------------------------------------------------------------- */
/*  Persona: shared client bits                                               */
/* -------------------------------------------------------------------------- */

export interface PersonaConfig {
  /** Sandbox key from Dashboard > API > API Keys. Sandbox and production keys differ. */
  apiKey: string;
  /** Default https://api.withpersona.com/api/v1 (https://withpersona.com/api/v1 also
   *  appears in some Persona docs — they are the same API surface). */
  baseUrl?: string;
  /** Pin the server API version so payload shapes don't drift under us. */
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

const PERSONA_DEFAULT_BASE = "https://api.withpersona.com/api/v1";
const PERSONA_DEFAULT_VERSION = "2025-12-08";

class PersonaApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = "PersonaApiError";
  }
}

async function personaRequest<T = any>(
  cfg: PersonaConfig,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const doFetch = cfg.fetchImpl ?? fetch;
  const url = `${cfg.baseUrl ?? PERSONA_DEFAULT_BASE}${path}`;

  const res = await doFetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
      "Persona-Version": cfg.apiVersion ?? PERSONA_DEFAULT_VERSION,
      // Persona serialises response keys kebab-case by default; keep it explicit.
      "Key-Inflection": "kebab",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const parsed = text ? safeJson(text) : null;
  if (!res.ok) {
    throw new PersonaApiError(
      res.status,
      parsed ?? text,
      `Persona ${method} ${path} -> ${res.status}`,
    );
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Persona inquiry statuses are already our canonical set, modulo snake_case. */
function normalisePersonaStatus(s: string | undefined): VerificationStatus {
  switch (s) {
    case "created":
    case "pending":
    case "completed": // "user is done", no decision yet -> treat as pending for us
      return s === "completed" ? "pending" : (s as VerificationStatus);
    case "approved":
    case "declined":
    case "expired":
    case "failed":
      return s;
    case "needs_review":
    case "needs-review":
      return "needs_review";
    default:
      // Persona explicitly warns the status enum is not closed.
      return "pending";
  }
}

/* -------------------------------------------------------------------------- */
/*  Persona: director / individual KYC via Inquiries  (WORKS ON FREE SANDBOX)  */
/* -------------------------------------------------------------------------- */

export interface PersonaInquiryConfig extends PersonaConfig {
  /** Dynamic Flow template id, `itmpl_…`, from Dashboard > Inquiries > Templates. */
  inquiryTemplateId: string;
  /** Hosted-flow host. Default `inquiry.withpersona.com`; orgs can get a subdomain. */
  hostedFlowHost?: string;
  /** Sandbox environment id (`env_…`) for hosted-flow links. Optional. */
  environmentId?: string;
  /** Verification template id used by the simulate-actions helper (`vtmpl_…`). */
  verificationTemplateId?: string;
}

/**
 * Individual (director / control-person) KYC through Persona Inquiries.
 * This is the path that genuinely works on a free self-serve sandbox account.
 */
export class PersonaDirectorKycProvider implements KybProvider {
  readonly name = "persona-inquiry";
  constructor(private readonly cfg: PersonaInquiryConfig) {}

  async createBusinessVerification(
    input: CreateBusinessVerificationInput,
  ): Promise<VerificationResult> {
    const director = input.associatedPeople?.[0];

    const payload = {
      data: {
        attributes: {
          "inquiry-template-id": this.cfg.inquiryTemplateId,
          fields: {
            "name-first": director?.firstName,
            "name-last": director?.lastName,
            "name-middle": director?.middleName,
            birthdate: director?.birthdate,
            "email-address": director?.emailAddress,
            "phone-number": director?.phoneNumber,
            "address-street-1": director?.address?.street1,
            "address-street-2": director?.address?.street2,
            "address-city": director?.address?.city,
            // NB: unabbreviated for US on this endpoint ("California", not "CA").
            "address-subdivision": director?.address?.subdivision,
            "address-postal-code": director?.address?.postalCode,
            "address-country-code": director?.address?.countryCode,
          },
        },
      },
      meta: {
        "auto-create-account": true,
        "auto-create-account-reference-id": input.referenceId,
        // Ask Persona for a one-time link so we don't have to mint a session ourselves.
        "auto-create-one-time-link": true,
      },
    };

    const res = await personaRequest<any>(this.cfg, "POST", "/inquiries", payload, {
      // Safe to retry the create without double-charging / double-creating.
      "Idempotency-Key": `kyb-create-${input.referenceId}`,
    });

    return this.toResult(res, input.referenceId);
  }

  async getVerification(id: string): Promise<VerificationResult> {
    const res = await personaRequest<any>(
      this.cfg,
      "GET",
      `/inquiries/${encodeURIComponent(id)}`,
    );
    return this.toResult(res);
  }

  verifyWebhook(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): WebhookVerificationResult {
    const sig = headerValue(headers, PERSONA_SIGNATURE_HEADER);
    const { valid, reason } = verifyPersonaSignature(rawBody, sig, secret);
    if (!valid) return { valid: false, reason };

    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    const event = safeJson(body) as any;
    return {
      valid: true,
      // Envelope: { data: { type: "event", id: "evt_…",
      //             attributes: { name: "inquiry.approved", payload: { data: {...} } } } }
      eventName: event?.data?.attributes?.name,
      event,
    };
  }

  /* ---- sandbox-only helpers, for demoing non-happy paths ---- */

  /**
   * Drive a SANDBOX inquiry through arbitrary lifecycle states.
   * https://docs.withpersona.com/api-reference/inquiries/perform-simulate-actions
   * https://docs.withpersona.com/integration-testing
   *
   * Each action fires the corresponding real webhook, so this is how we demo
   * pending / declined / needs-review end-to-end without faking anything locally.
   */
  async simulate(inquiryId: string, actions: PersonaSimulateAction[]): Promise<VerificationResult> {
    const res = await personaRequest<any>(
      this.cfg,
      "POST",
      `/inquiries/${encodeURIComponent(inquiryId)}/perform-simulate-actions`,
      { meta: { "simulate-actions": actions } },
    );
    return this.toResult(res);
  }

  private toResult(res: any, fallbackRef?: string): VerificationResult {
    const d = res?.data ?? {};
    const a = d.attributes ?? {};
    return {
      id: d.id,
      provider: this.name,
      status: normalisePersonaStatus(a.status),
      referenceId: a["reference-id"] ?? fallbackRef ?? null,
      hostedUrl: this.hostedUrlFor(res, d.id),
      createdAt: a["created-at"],
      updatedAt: a["updated-at"],
      evidence: "live-third-party",
      raw: res,
    };
  }

  private hostedUrlFor(res: any, inquiryId: string | undefined): string | undefined {
    // UNVERIFIED: the exact response location of the auto-created one-time link.
    // `meta.one-time-link` is the shape I expect from `auto-create-one-time-link`,
    // but I could not find it spelled out on a doc page — confirm against a real
    // sandbox response before relying on it, and fall back to the template link.
    const otl = res?.meta?.["one-time-link"] ?? res?.data?.attributes?.["one-time-link"];
    if (typeof otl === "string") return otl;

    if (!inquiryId) return undefined;
    // VERIFIED shape: https://docs.withpersona.com/hosted-flow
    //   https://inquiry.withpersona.com/verify?inquiry-id=inq_XXXX
    const host = this.cfg.hostedFlowHost ?? "inquiry.withpersona.com";
    const params = new URLSearchParams({ "inquiry-id": inquiryId });
    if (this.cfg.environmentId) params.set("environment-id", this.cfg.environmentId);
    return `https://${host}/verify?${params.toString()}`;
  }
}

/**
 * VERIFIED enum: https://docs.withpersona.com/api-reference/inquiries/perform-simulate-actions
 */
export type PersonaSimulateAction =
  | { type: "start_inquiry" }
  | { type: "complete_inquiry" }
  | { type: "fail_inquiry" }
  | { type: "expire_inquiry" }
  | { type: "mark_for_review_inquiry" }
  | { type: "approve_inquiry" }
  | { type: "decline_inquiry" }
  | { type: "create_passed_verification"; data: { "verification-template-id": string } }
  | { type: "create_failed_verification"; data: { "verification-template-id": string } };

/** Ready-made scripts for the four states we need to demo. */
export const PERSONA_DEMO_SCRIPTS = {
  pending: (): PersonaSimulateAction[] => [{ type: "start_inquiry" }],
  approved: (vtmpl?: string): PersonaSimulateAction[] => [
    { type: "start_inquiry" },
    ...(vtmpl
      ? ([{ type: "create_passed_verification", data: { "verification-template-id": vtmpl } }] as const)
      : []),
    { type: "complete_inquiry" },
    { type: "approve_inquiry" },
  ],
  declined: (vtmpl?: string): PersonaSimulateAction[] => [
    { type: "start_inquiry" },
    ...(vtmpl
      ? ([{ type: "create_failed_verification", data: { "verification-template-id": vtmpl } }] as const)
      : []),
    { type: "complete_inquiry" },
    { type: "decline_inquiry" },
  ],
  needsReview: (): PersonaSimulateAction[] => [
    { type: "start_inquiry" },
    { type: "complete_inquiry" },
    { type: "mark_for_review_inquiry" },
  ],
} as const;

/* -------------------------------------------------------------------------- */
/*  Persona: true KYB via Transactions  (REQUIRES PROVISIONING — NOT FREE)     */
/* -------------------------------------------------------------------------- */

export interface PersonaKybConfig extends PersonaConfig {
  /** Provisioned by Persona for your org. There is no self-serve way to create one. */
  transactionTypeId: string;
}

/**
 * Persona's real KYB flow.
 *
 * GATED: https://docs.withpersona.com/integration-guide-kyb-via-api says
 * "Make sure your organization is set up with the requisite transaction and workflows!
 *  Reach out to your Persona team for support with this."
 * and the Business Verification help article lists the Startup (free) program as
 * "Not Available". Kept here so the interface is honest about what production looks
 * like — do not expect this to run on a free sandbox org.
 */
export class PersonaKybProvider implements KybProvider {
  readonly name = "persona-kyb";
  constructor(private readonly cfg: PersonaKybConfig) {}

  async createBusinessVerification(
    input: CreateBusinessVerificationInput,
  ): Promise<VerificationResult> {
    // VERIFIED field names against the KYB-via-API guide. NOTE: this endpoint uses
    // snake_case field keys inside `fields`, unlike the kebab-case Inquiries API.
    const payload = {
      data: {
        attributes: {
          transaction_type_id: this.cfg.transactionTypeId,
          reference_id: input.referenceId,
          fields: {
            business_name: input.businessName,
            business_tax_identification_number: input.taxIdentificationNumber,
            business_registered_address: toPersonaAddress(input.registeredAddress),
            ...(input.physicalAddress
              ? { business_physical_address: toPersonaAddress(input.physicalAddress) }
              : {}),
            ...(input.associatedPeople?.length
              ? {
                  associated_people: input.associatedPeople.map((p) => ({
                    name_first: p.firstName,
                    name_last: p.lastName,
                    name_middle: p.middleName,
                    percentage_ownership: p.percentageOwnership,
                    association: p.association,
                    birthdate: p.birthdate,
                    email_address: p.emailAddress,
                    phone_number: p.phoneNumber,
                    tax_identification_number: p.taxIdentificationNumber,
                    ...(p.address ? { address: toPersonaAddress(p.address) } : {}),
                  })),
                }
              : {}),
            // VERIFIED: "For Sandbox verifications only: set as `passed` to pass
            // verifications or `failed` to force-fail the verifications."
            ...(input.sandboxOutcome ? { debug: input.sandboxOutcome } : {}),
          },
        },
      },
    };

    const res = await personaRequest<any>(this.cfg, "POST", "/transactions", payload, {
      "Idempotency-Key": `kyb-txn-${input.referenceId}`,
    });
    return this.toResult(res, input.referenceId);
  }

  async getVerification(id: string): Promise<VerificationResult> {
    const res = await personaRequest<any>(
      this.cfg,
      "GET",
      `/transactions/${encodeURIComponent(id)}`,
    );
    return this.toResult(res);
  }

  verifyWebhook(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): WebhookVerificationResult {
    // Identical scheme to inquiries — one org-wide Persona-Signature format.
    const sig = headerValue(headers, PERSONA_SIGNATURE_HEADER);
    const { valid, reason } = verifyPersonaSignature(rawBody, sig, secret);
    if (!valid) return { valid: false, reason };
    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    const event = safeJson(body) as any;
    return { valid: true, eventName: event?.data?.attributes?.name, event };
  }

  private toResult(res: any, fallbackRef?: string): VerificationResult {
    const d = res?.data ?? {};
    const a = d.attributes ?? {};
    // VERIFIED statuses: created | approved | declined | needs_review | errored
    // (custom statuses are configurable per transaction type, so this is open-ended).
    // UNVERIFIED: the exact attribute key holding the status on a Transaction. The
    // guide talks about "Transaction statuses" and the `transaction.status-updated`
    // event but does not print a serialised Transaction object. `status` is the
    // obvious guess; confirm before relying on it.
    const rawStatus: string | undefined = a.status ?? a["status"];
    const status: VerificationStatus =
      rawStatus === "errored" ? "failed" : normalisePersonaStatus(rawStatus);

    return {
      id: d.id,
      provider: this.name,
      status,
      referenceId: a["reference-id"] ?? a.reference_id ?? fallbackRef ?? null,
      createdAt: a["created-at"],
      updatedAt: a["updated-at"],
      evidence: "live-third-party",
      raw: res,
    };
  }
}

function toPersonaAddress(a: Address) {
  return {
    street_1: a.street1,
    street_2: a.street2 ?? "",
    city: a.city,
    subdivision: a.subdivision,
    postal_code: a.postalCode,
    country_code: a.countryCode,
  };
}

/* -------------------------------------------------------------------------- */
/*  Stripe: webhook signature verification                                    */
/* -------------------------------------------------------------------------- */

/**
 * Stripe-Signature verification.
 *
 * VERIFIED against https://docs.stripe.com/webhooks (manual verification section):
 *
 *   header name : `Stripe-Signature`
 *   format      : `t=<unix_seconds>,v1=<hex>[,v1=<hex>…][,v0=<hex>]`
 *                 multiple v1 entries appear while a rolled secret is still active
 *                 (up to 24h) — accept ANY of them
 *   algorithm   : HMAC-SHA256, hex digest
 *   signed data : `${t}.${rawBody}`  (same construction as Persona)
 *   tolerance   : Stripe's own libraries default to 300s. Docs: "Don't use a
 *                 tolerance value of 0. Using a tolerance value of 0 disables the
 *                 recency check entirely."
 *
 * SECURITY: the docs say "To prevent downgrade attacks, ignore all schemes that
 * aren't v1." `v0` is a deliberate decoy on test events — never accept it.
 */
export const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";

export function verifyStripeSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): { valid: boolean; reason?: string } {
  if (!signatureHeader) return { valid: false, reason: "missing_signature_header" };
  if (!secret) return { valid: false, reason: "missing_secret" };

  const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  let t: string | undefined;
  const v1s: string[] = [];
  for (const element of signatureHeader.split(",")) {
    const idx = element.indexOf("=");
    if (idx === -1) continue;
    const prefix = element.slice(0, idx).trim();
    const value = element.slice(idx + 1).trim();
    if (prefix === "t") t ??= value;
    else if (prefix === "v1") v1s.push(value);
    // Deliberately ignore v0 and any future scheme — downgrade protection.
  }

  if (!t || v1s.length === 0) return { valid: false, reason: "malformed_signature_header" };

  if (tolerance > 0) {
    const ts = Number.parseInt(t, 10);
    if (!Number.isFinite(ts)) return { valid: false, reason: "malformed_timestamp" };
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > tolerance) {
      return { valid: false, reason: "timestamp_outside_tolerance" };
    }
  }

  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return v1s.some((sig) => safeEqualHex(expected, sig))
    ? { valid: true }
    : { valid: false, reason: "signature_mismatch" };
}

/* -------------------------------------------------------------------------- */
/*  Stripe Connect: the live business-registry leg                            */
/* -------------------------------------------------------------------------- */

export interface StripeConnectConfig {
  /** `sk_test_…` for test mode. */
  secretKey: string;
  baseUrl?: string;
  /** Pin the Stripe API version. */
  apiVersion?: string;
  fetchImpl?: typeof fetch;
}

/**
 * VERIFIED magic values — https://docs.stripe.com/connect/testing
 * "You can only use these values while testing with test API keys."
 *
 * These are the reason the business leg can be genuinely live at $0: Stripe runs a
 * real registry check against company name / EIN / owners / directors, and these
 * EINs force each documented failure mode.
 */
export const STRIPE_TEST_EINS = {
  match: "000000000",
  matchNonProfit: "000000001",
  inactiveBusiness: "000000004",
  identityMismatch: "111111111",
  taxIdNotIssued: "111111112",
  /** Result returned inline in the API response rather than via webhook. */
  immediateMatch: "222222222",
  companyNotFoundInRegistry: "222221000",
  ownersNotFoundInRegistry: "222221001",
  directorsNotFoundInRegistry: "222221002",
  missingOwnersVsRegistry: "222221003",
  missingDirectorsVsRegistry: "222221004",
  pendingResponseFromRegistry: "222221005",
} as const;

/**
 * Registry-shaped `requirements.errors[].code` values that should map to a hard
 * decline rather than "needs more info".
 * VERIFIED list — https://docs.stripe.com/api/accounts/object (requirements.errors).
 */
const STRIPE_REGISTRY_DECLINE_CODES = new Set([
  "verification_failed_tax_id_match",
  "verification_failed_tax_id_not_issued",
  "verification_failed_name_match",
  "verification_failed_keyed_match",
  "verification_failed_document_match",
  "verification_directors_mismatch",
  "verification_legal_entity_structure_mismatch",
  "verification_failed_address_match",
  "invalid_company_name_denylisted",
]);

/**
 * Business-registry verification via Stripe Connect account onboarding.
 *
 * Be accurate about what this is: Stripe verifying a business in order to onboard it
 * as a connected account. It is a REAL registry check with real failure codes, and it
 * is free and self-serve in test mode — but it is not a general-purpose KYB vendor
 * API, and the UI copy should not imply that it is.
 *
 * UNCONFIRMED: https://docs.stripe.com/connect/testing-verification says "You must
 * provide a test API key from a Stripe account which has begun Connect platform
 * onboarding." Whether "has begun" is one Dashboard click or a review is not stated.
 * Check this before committing to this leg; fall back to SimulatedRegistryProvider.
 */
export class StripeConnectRegistryProvider implements KybProvider {
  readonly name = "stripe-connect";

  constructor(private readonly cfg: StripeConnectConfig) {}

  async createBusinessVerification(
    input: CreateBusinessVerificationInput,
  ): Promise<VerificationResult> {
    const rep = input.associatedPeople?.[0];

    // Stripe's API is form-encoded, with bracket notation for nested fields.
    const form = new URLSearchParams();
    form.set("type", "custom");
    form.set("country", input.registeredAddress.countryCode);
    form.set("business_type", "company");
    form.set("company[name]", input.businessName);
    // Stripe wants 9 digits, no dashes: "invalid_tax_id_format".
    form.set("company[tax_id]", input.taxIdentificationNumber.replace(/\D/g, ""));
    form.set("company[address][line1]", input.registeredAddress.street1);
    if (input.registeredAddress.street2) {
      form.set("company[address][line2]", input.registeredAddress.street2);
    }
    form.set("company[address][city]", input.registeredAddress.city);
    form.set("company[address][state]", input.registeredAddress.subdivision);
    form.set("company[address][postal_code]", input.registeredAddress.postalCode);
    form.set("company[address][country]", input.registeredAddress.countryCode);
    if (rep?.phoneNumber) form.set("company[phone]", rep.phoneNumber);
    form.set("metadata[reference_id]", input.referenceId);

    const account = await this.stripeRequest<any>("POST", "/v1/accounts", form, {
      // Stripe supports Idempotency-Key on all POSTs.
      "Idempotency-Key": `kyb-connect-${input.referenceId}`,
    });

    return this.toResult(account, input.referenceId);
  }

  async getVerification(id: string): Promise<VerificationResult> {
    const account = await this.stripeRequest<any>(
      "GET",
      `/v1/accounts/${encodeURIComponent(id)}`,
    );
    return this.toResult(account);
  }

  verifyWebhook(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): WebhookVerificationResult {
    const sig = headerValue(headers, STRIPE_SIGNATURE_HEADER);
    const { valid, reason } = verifyStripeSignature(rawBody, sig, secret);
    if (!valid) return { valid: false, reason };

    const body = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : rawBody;
    const event = safeJson(body) as any;
    // Stripe envelope: { id: "evt_…", type: "account.updated", data: { object: {…} } }
    return { valid: true, eventName: event?.type, event };
  }

  private async stripeRequest<T>(
    method: "GET" | "POST",
    path: string,
    form?: URLSearchParams,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const base = this.cfg.baseUrl ?? "https://api.stripe.com";
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.secretKey}`,
        ...(this.cfg.apiVersion ? { "Stripe-Version": this.cfg.apiVersion } : {}),
        ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...extraHeaders,
      },
      body: form ? form.toString() : undefined,
    });

    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = (parsed as any)?.error?.message ?? `Stripe ${method} ${path} -> ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  }

  /**
   * Read the registry outcome out of `requirements`.
   *
   * NOTE — a correction worth keeping: there is **no** `company.verification.status`
   * field on the Account object. `company.verification` holds only a `document`
   * sub-object; `verification.status` exists on Person objects. Do not build against
   * `account.company.verification.status`.
   */
  private toResult(account: any, fallbackRef?: string): VerificationResult {
    const reqs = account?.requirements ?? {};
    const errors: any[] = Array.isArray(reqs.errors) ? reqs.errors : [];
    const currentlyDue: string[] = reqs.currently_due ?? [];
    const pendingVerification: string[] = reqs.pending_verification ?? [];

    const checks: VerificationCheck[] = errors.map((e) => ({
      name: e?.requirement ?? e?.code ?? "unknown",
      status: "failed" as const,
      reasons: [e?.code, e?.reason].filter(Boolean),
    }));

    let status: VerificationStatus;
    if (errors.some((e) => STRIPE_REGISTRY_DECLINE_CODES.has(e?.code))) {
      status = "declined";
    } else if (errors.length > 0) {
      // e.g. verification_missing_owners / _directors — recoverable, wants a human.
      status = "needs_review";
    } else if (pendingVerification.length > 0) {
      // Where EIN 222221005 ("pending response from registry") lands.
      status = "pending";
    } else if (currentlyDue.length > 0) {
      status = "pending";
    } else {
      status = "approved";
    }

    // UNCONFIRMED: `disabled_reason` values overlap with the above and may be a better
    // primary signal for a real product. Verify against live test-mode payloads before
    // relying on this precedence order.
    if (reqs.disabled_reason === "rejected.fraud" || reqs.disabled_reason === "listed") {
      status = "declined";
    }

    return {
      id: account?.id,
      provider: this.name,
      status,
      referenceId: account?.metadata?.reference_id ?? fallbackRef ?? null,
      checks,
      createdAt: account?.created
        ? new Date(account.created * 1000).toISOString()
        : undefined,
      evidence: "live-third-party",
      raw: account,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Simulated business-registry check — CLEARLY LABELLED AS NOT REAL          */
/* -------------------------------------------------------------------------- */

/**
 * Stand-in for the business-registry half of KYB, for use while the real KYB
 * product is sales-gated. Everything it returns carries `evidence: "simulated"`,
 * and the UI must render that badge. It is deliberately NOT a `KybProvider` that
 * can be swapped in silently for a live one — the caller has to opt in.
 *
 * Deterministic on `taxIdentificationNumber` so demos are reproducible.
 */
export class SimulatedRegistryProvider implements KybProvider {
  readonly name = "simulated-registry";

  async createBusinessVerification(
    input: CreateBusinessVerificationInput,
  ): Promise<VerificationResult> {
    const ein = input.taxIdentificationNumber.replace(/\D/g, "");
    const status: VerificationStatus =
      input.sandboxOutcome === "failed"
        ? "declined"
        : ein.endsWith("0")
          ? "declined"
          : ein.endsWith("1")
            ? "needs_review"
            : "approved";

    return {
      id: `sim_${input.referenceId}`,
      provider: this.name,
      status,
      referenceId: input.referenceId,
      checks: [
        { name: "business_registry_active", status: status === "approved" ? "passed" : "failed" },
        { name: "business_tin_match", status: status === "declined" ? "failed" : "passed" },
        { name: "business_watchlist", status: "not_applicable", reasons: ["simulated"] },
      ],
      createdAt: new Date().toISOString(),
      evidence: "simulated",
    };
  }

  async getVerification(id: string): Promise<VerificationResult> {
    // UNVERIFIED by design: a real implementation reads our own DB row here.
    throw new Error(`SimulatedRegistryProvider.getVerification not implemented for ${id}`);
  }

  verifyWebhook(): WebhookVerificationResult {
    return { valid: false, reason: "simulated_provider_has_no_webhooks" };
  }
}

/* -------------------------------------------------------------------------- */
/*  Composite: live director KYC + labelled registry check                    */
/* -------------------------------------------------------------------------- */

/**
 * The honest architecture for a $0 build: the person half is genuinely verified by
 * a third party; the business half is simulated and says so. Overall status is the
 * strictest of the two, and `evidence` degrades to "simulated" whenever any leg was.
 */
export class CompositeKybProvider implements KybProvider {
  readonly name = "composite-kyb";

  constructor(
    private readonly directorKyc: KybProvider,
    private readonly registry: KybProvider,
  ) {}

  async createBusinessVerification(
    input: CreateBusinessVerificationInput,
  ): Promise<VerificationResult> {
    const [person, business] = await Promise.all([
      this.directorKyc.createBusinessVerification(input),
      this.registry.createBusinessVerification(input),
    ]);

    return {
      id: person.id,
      provider: this.name,
      status: strictest(person.status, business.status),
      referenceId: input.referenceId,
      hostedUrl: person.hostedUrl,
      checks: [...(person.checks ?? []), ...(business.checks ?? [])],
      createdAt: person.createdAt,
      evidence:
        person.evidence === "live-third-party" && business.evidence === "live-third-party"
          ? "live-third-party"
          : "simulated",
      raw: { person, business },
    };
  }

  getVerification(id: string): Promise<VerificationResult> {
    return this.directorKyc.getVerification(id);
  }

  verifyWebhook(
    rawBody: string | Buffer,
    headers: Record<string, string | string[] | undefined>,
    secret: string,
  ): WebhookVerificationResult {
    return this.directorKyc.verifyWebhook(rawBody, headers, secret);
  }
}

const STATUS_SEVERITY: Record<VerificationStatus, number> = {
  approved: 0,
  created: 1,
  pending: 2,
  needs_review: 3,
  expired: 4,
  failed: 5,
  declined: 6,
};

function strictest(a: VerificationStatus, b: VerificationStatus): VerificationStatus {
  return STATUS_SEVERITY[a] >= STATUS_SEVERITY[b] ? a : b;
}
