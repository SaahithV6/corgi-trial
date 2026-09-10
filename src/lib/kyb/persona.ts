/**
 * Director / control-person KYC via Persona Inquiries.
 *
 * WHY PERSONA IS THE KYC LEG AND NOT THE KYB LEG — this is settled, it is not
 * an assumption, and the sources are in research/kyb/NOTES.md §1.3:
 *
 *   Persona's Business Verification / KYB is gated behind a sales conversation.
 *   Four plan-availability tables list it as "Not Available" below Growth, the
 *   Essential tier has to buy it separately, and the API-first KYB guide's very
 *   first step is "Reach out to your Persona team" to have a transaction type
 *   provisioned. There is no self-serve path. We do not attempt it.
 *
 *   Persona's INDIVIDUAL KYC is self-serve on a sandbox key, and it is the only
 *   provider in the survey that can drive pending / approved / declined /
 *   needs_review FROM THE SERVER — `POST /inquiries/{id}/perform-simulate-actions`
 *   moves a sandbox inquiry and fires the real webhook for each transition.
 *   That is why it is the primary: the non-happy-path states in the demo are
 *   Persona's own transitions arriving over Persona's own signed webhooks, not
 *   rows we flipped in our database.
 *
 * WHAT IS NOT IN THIS FILE: signature verification. Inbound Persona deliveries
 * are authenticated exactly once, by `personaVerifier` in
 * `src/lib/webhooks/inbox.ts`, and land in the webhook inbox. This module maps
 * an ALREADY-VERIFIED payload (`legFromPersonaEvent`). A second HMAC
 * implementation would be a second thing to get wrong.
 *
 * Sandbox facts that will bite a reader of test output (NOTES.md §1.2):
 *   - Sandbox keys are prefixed `persona_sandbox`.
 *   - Sandbox overwrites submitted names to `Alexander J Sample`. Never assert
 *     on the name you sent coming back.
 *   - One 60-day trial per business, EVER, and the free Starter plan no longer
 *     exists. The trial is metered ("up to 50 services"), so nothing in this
 *     module's tests may call the live sandbox: every test injects `fetchImpl`.
 */

import {
  KybProviderError,
  KYB_PROVIDER_CODE_CHECK,
  type CreateKybVerificationInput,
  type KybAddress,
  type KybCheck,
  type KybLegKind,
  type KybLegProvider,
  type KybLegResult,
  type KybPerson,
  type KybStatus,
} from './types';

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

export const PERSONA_DEFAULT_BASE_URL = 'https://api.withpersona.com/api/v1';
/** Pinned so payload shapes cannot drift under us between deploys. */
export const PERSONA_DEFAULT_API_VERSION = '2025-12-08';
export const PERSONA_DEFAULT_HOSTED_FLOW_HOST = 'inquiry.withpersona.com';

export interface PersonaConfig {
  /** Sandbox key, `persona_sandbox…` (Dashboard > API > API Keys). */
  readonly apiKey: string;
  /** Dynamic Flow template, `itmpl_…`. A legacy `tmpl_…` is a different field. */
  readonly inquiryTemplateId: string;
  /** `vtmpl_…`, only needed by `simulate()` for pass/fail verifications. */
  readonly verificationTemplateId?: string | undefined;
  /** `env_…`, appended to hosted-flow links when present. */
  readonly environmentId?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly apiVersion?: string | undefined;
  readonly hostedFlowHost?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injected in tests. Nothing here ever calls the live sandbox under vitest. */
  readonly fetchImpl?: typeof fetch | undefined;
}

// ---------------------------------------------------------------------------
// 2. Status mapping
// ---------------------------------------------------------------------------

/**
 * Persona inquiry status -> our lattice. Sourced from
 * https://docs.withpersona.com/model-lifecycle.
 *
 * The three judgement calls, stated rather than buried:
 *
 *   `completed` -> pending. Persona is explicit that `completed` means "the
 *   user reached the Completed screen", NOT "we decided yes". Approval is a
 *   separate post-inquiry phase. Mapping it to approved is the single easiest
 *   way to let an unverified person through, so it maps to pending.
 *
 *   `expired` -> needs_review. An inquiry that timed out is not a decline —
 *   nobody decided anything — but it is also not in progress. A human has to
 *   re-invite the director, and `needs_review` is exactly "a human must act".
 *
 *   `failed` -> needs_review. The user hit the Failed screen (attempt limits,
 *   an unsupported document). Also not a decision. `declined` is the only
 *   status that reaches `rejected`, because a decline is the only one of these
 *   that is a decision to say no.
 *
 * Persona warns that this enum is open — "Do not assume this is a static
 * enumeration" — so anything unrecognised maps to `needs_review`. An unknown
 * status must never be able to reach `approved`.
 */
export const PERSONA_STATUS_MAP: Readonly<Record<string, KybStatus>> = {
  created: 'pending',
  pending: 'pending',
  completed: 'pending',
  approved: 'approved',
  declined: 'rejected',
  expired: 'needs_review',
  failed: 'needs_review',
  needs_review: 'needs_review',
  'needs-review': 'needs_review',
  marked_for_review: 'needs_review',
};

/**
 * `Object.hasOwn` rather than a bare index: `PERSONA_STATUS_MAP['toString']`
 * walks the prototype chain and returns a FUNCTION, which `?? 'needs_review'`
 * would happily pass through as a status. A provider's status field is
 * untrusted input like any other.
 */
export function personaStatusToKyb(raw: string | null | undefined): KybStatus {
  if (typeof raw !== 'string') return 'needs_review';
  return isKnownPersonaStatus(raw) ? (PERSONA_STATUS_MAP[normalisePersonaStatus(raw)] ?? 'needs_review') : 'needs_review';
}

function normalisePersonaStatus(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isKnownPersonaStatus(raw: string): boolean {
  return Object.hasOwn(PERSONA_STATUS_MAP, normalisePersonaStatus(raw));
}

/** Persona event name -> the inquiry status it announces. */
export const PERSONA_EVENTS: readonly string[] = [
  'inquiry.created',
  'inquiry.started',
  'inquiry.completed',
  'inquiry.failed',
  'inquiry.expired',
  'inquiry.approved',
  'inquiry.declined',
  'inquiry.marked-for-review',
];

// ---------------------------------------------------------------------------
// 3. The adapter
// ---------------------------------------------------------------------------

/**
/**
 * ===========================================================================
 * THE MACHINERY BOTH PERSONA LEGS SHARE.
 *
 * Extracted so a Persona KYB template can be dropped in as a CREDENTIAL rather
 * than a refactor. The Inquiries API is one endpoint — `POST /inquiries` with
 * an `inquiry-template-id` — and the template decides what the inquiry collects.
 * Auth, versioning, key-inflection, idempotency, the status vocabulary, the
 * hosted-link fallback and the webhook envelope are identical for both, so they
 * live here once and neither subclass reimplements any of them.
 *
 * `evidence` is `'live'` on the base, which is what holds every subclass to
 * `KybLegProvider<'live'>`: no descendant can return a manufactured answer.
 * ===========================================================================
 */
abstract class PersonaInquiryProvider implements KybLegProvider<'live'> {
  abstract readonly leg: KybLegKind;
  abstract readonly name: string;
  readonly evidence = 'live' as const;

  protected constructor(protected readonly cfg: PersonaConfig) {}

  /** The `fields` object for this leg's template. */
  protected abstract fieldsFor(input: CreateKybVerificationInput): Record<string, string>;

  /** Prefix for the idempotency key, so the two legs cannot collide. */
  protected abstract idempotencyPrefix(): string;

  async begin(input: CreateKybVerificationInput): Promise<KybLegResult<'live'>> {
    const body = {
      data: {
        attributes: {
          'inquiry-template-id': this.cfg.inquiryTemplateId,
          fields: this.fieldsFor(input),
        },
      },
      meta: {
        'auto-create-account': true,
        // `data.attributes.reference-id` is deprecated in favour of this.
        'auto-create-account-reference-id': input.referenceId,
        'auto-create-one-time-link': true,
      },
    };

    const response = await this.request('POST', '/inquiries', body, {
      'Idempotency-Key': `${this.idempotencyPrefix()}-${input.referenceId}`,
    });
    return this.toLeg(response, input.referenceId);
  }

  async refresh(inquiryId: string): Promise<KybLegResult<'live'>> {
    const response = await this.request('GET', `/inquiries/${encodeURIComponent(inquiryId)}`);
    return this.toLeg(response, null);
  }

  protected toLeg(response: unknown, fallbackReference: string | null): KybLegResult<'live'> {
    const data = readObject(response, ['data']);
    const attributes = readObject(response, ['data', 'attributes']);
    const rawStatus = readString(attributes, ['status']);
    return {
      leg: this.leg,
      provider: this.name,
      reference: readString(data, ['id']) ?? '',
      referenceId: readString(attributes, ['reference-id']) ?? fallbackReference,
      status: personaStatusToKyb(rawStatus),
      rawStatus,
      checks: personaChecks(rawStatus, this.leg),
      hostedUrl: this.hostedUrlFor(response, readString(data, ['id'])),
      observedAt: readString(attributes, ['updated-at']) ?? new Date().toISOString(),
      evidence: this.evidence,
    };
  }

  protected hostedUrlFor(response: unknown, inquiryId: string | null): string | null {
    // UNVERIFIED against a live response: `auto-create-one-time-link` is
    // documented, the exact key carrying the link back is not. Both plausible
    // locations are read, and the deterministic hosted-flow URL — which IS a
    // documented shape — is the fallback, so this degrades to a working link
    // rather than to null.
    const oneTime =
      readString(response, ['meta', 'one-time-link']) ??
      readString(response, ['data', 'attributes', 'one-time-link']);
    if (oneTime !== null) return oneTime;
    if (inquiryId === null || inquiryId === '') return null;

    const host = this.cfg.hostedFlowHost ?? PERSONA_DEFAULT_HOSTED_FLOW_HOST;
    const params = new URLSearchParams({ 'inquiry-id': inquiryId });
    if (this.cfg.environmentId !== undefined) params.set('environment-id', this.cfg.environmentId);
    return `https://${host}/verify?${params.toString()}`;
  }

  protected async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const url = `${this.cfg.baseUrl ?? PERSONA_DEFAULT_BASE_URL}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Accept: 'application/json',
      'Persona-Version': this.cfg.apiVersion ?? PERSONA_DEFAULT_API_VERSION,
      // Persona can serialise either casing; pinning it means the readers below
      // do not have to accept both.
      'Key-Inflection': 'kebab',
      ...extraHeaders,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new KybProviderError(
        this.name,
        `Persona ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const text = await response.text();
    const parsed = text === '' ? null : safeJsonParse(text);
    if (!response.ok) {
      // The response body can echo submitted fields, so it is summarised to a
      // status code rather than attached. The full body belongs in the log line
      // the caller writes, not in an exception message that may reach a user.
      throw new KybProviderError(
        this.name,
        `Persona ${method} ${path} -> ${response.status}`,
        response.status,
      );
    }
    return parsed;
  }
}

/**
 * ===========================================================================
 * PERSONA KYB — THE BUSINESS-REGISTRY LEG, WIRED BUT NOT PROVEN.
 *
 * This class exists so that the day Corgi hands us a provisioned Persona KYB
 * template, moving the registry leg off GLEIF is TWO ENVIRONMENT VARIABLES and
 * no code change: `PERSONA_API_KEY` and `PERSONA_KYB_TEMPLATE_ID`. The
 * precedence ladder in ./registry-precedence.ts already puts this rung above
 * GLEIF, so it is picked up automatically.
 *
 * WHAT IS PROVEN AND WHAT IS NOT, because the difference is the whole point of
 * this codebase. PROVEN: the endpoint, the auth, the versioning header, the
 * status vocabulary and the webhook envelope are the Inquiries API's, shared
 * with the director leg, exercised by this file's tests. NOT PROVEN: the field
 * names a BUSINESS template expects, because Persona's KYB is gated behind a
 * sales conversation (research/kyb/NOTES.md §1.3) and nobody here has ever seen
 * one. The field mapping below is a best reading of Persona's business-field
 * conventions and is labelled as such.
 *
 * That risk is bounded on purpose. Wrong field names produce an inquiry that
 * collects the data from the human instead of being prefilled — Persona ignores
 * unknown fields — so the failure mode is a longer hosted flow, not a wrong
 * verdict. Nothing about the STATUS mapping depends on the fields, and
 * `personaStatusToKyb` still refuses to let an unrecognised status reach
 * `approved`.
 *
 * IT IS NOT SELECTED TODAY. No `PERSONA_KYB_TEMPLATE_ID` is set, so the ladder
 * walks past this rung. If one is set and it turns out to be wrong, the leg
 * fails loudly through `failedLeg()` — a `pending` leg labelled `simulated` —
 * and never silently degrades into GLEIF wearing Persona's name.
 * ===========================================================================
 */
export class PersonaKybRegistryProvider extends PersonaInquiryProvider {
  readonly leg = 'business_registry' as const;
  readonly name = 'persona-kyb-inquiry';

  constructor(cfg: PersonaConfig) {
    super(cfg);
  }

  protected override idempotencyPrefix(): string {
    return 'kyb-registry';
  }

  /**
   * UNVERIFIED FIELD NAMES. See the class header. Persona ignores fields a
   * template does not declare, so the downside of being wrong here is a hosted
   * flow that asks a human for what we could have prefilled.
   */
  protected override fieldsFor(input: CreateKybVerificationInput): Record<string, string> {
    const address = input.registeredAddress;
    return compactFields({
      'business-name': input.businessName,
      'business-tax-identification-number': input.taxIdentificationNumber,
      'business-address-street-1': address.street1,
      'business-address-street-2': address.street2,
      'business-address-city': address.city,
      'business-address-subdivision': address.subdivision,
      'business-address-postal-code': address.postalCode,
      'business-address-country-code': address.countryCode,
    });
  }
}

export class PersonaDirectorKycProvider extends PersonaInquiryProvider {
  readonly leg = 'director_kyc' as const;
  readonly name = 'persona-inquiry';

  constructor(cfg: PersonaConfig) {
    super(cfg);
  }

  protected override idempotencyPrefix(): string {
    return 'kyb-director';
  }

  protected override fieldsFor(input: CreateKybVerificationInput): Record<string, string> {
    return personaFields(input.associatedPeople?.[0]);
  }

  /**
   * SANDBOX ONLY. Drive an inquiry through real lifecycle transitions.
   *
   * Every action fires the corresponding real webhook from Persona's servers to
   * our deployed endpoint, which is the entire reason this provider is the
   * primary: `pending`, `declined` and `needs_review` in the demo are Persona's
   * transitions arriving over Persona's signature, not database edits.
   *
   * Metered against the trial's service cap. Never call it in a test loop.
   */
  async simulate(inquiryId: string, actions: readonly PersonaSimulateAction[]): Promise<KybLegResult<'live'>> {
    const response = await this.request(
      'POST',
      `/inquiries/${encodeURIComponent(inquiryId)}/perform-simulate-actions`,
      { meta: { 'simulate-actions': actions } },
    );
    return this.toLeg(response, null);
  }

  /** The four demo states, as ready-made action scripts. */
  scriptFor(outcome: PersonaDemoOutcome): PersonaSimulateAction[] {
    return personaDemoScript(outcome, this.cfg.verificationTemplateId);
  }

}

// ---------------------------------------------------------------------------
// 4. Webhooks: map an ALREADY-VERIFIED delivery
// ---------------------------------------------------------------------------

/**
 * Turn a verified Persona webhook payload into a leg result.
 *
 * The caller is the webhook dispatcher, which receives rows the inbox has
 * already authenticated with `personaVerifier`. This function does no
 * verification and must never be handed an unverified body.
 *
 * Envelope (https://docs.withpersona.com/webhooks):
 *   { data: { type: 'event', id: 'evt_…',
 *             attributes: { name: 'inquiry.approved',
 *                           payload: { data: { id: 'inq_…', attributes: {…} } } } } }
 *
 * Returns null when the payload is not an inquiry event — a verification-level
 * or unrelated event is not an error, it is just not this leg's business.
 */
export function legFromPersonaEvent(payload: unknown): KybLegResult<'live'> | null {
  const eventName = readString(payload, ['data', 'attributes', 'name']);
  if (eventName === null || !eventName.startsWith('inquiry.')) return null;

  const inquiry = readObject(payload, ['data', 'attributes', 'payload', 'data']);
  if (inquiry === null) return null;

  const attributes = readObject(inquiry, ['attributes']);
  const rawStatus = readString(attributes, ['status']);
  const reference = readString(inquiry, ['id']);
  if (reference === null) return null;

  return {
    leg: 'director_kyc',
    provider: 'persona-inquiry',
    reference,
    referenceId: readString(attributes, ['reference-id']),
    status: personaStatusToKyb(rawStatus),
    rawStatus,
    checks: personaChecks(rawStatus, 'director_kyc', eventName),
    hostedUrl: null,
    observedAt:
      readString(attributes, ['updated-at']) ??
      readString(attributes, ['created-at']) ??
      new Date().toISOString(),
    evidence: 'live',
  };
}

// ---------------------------------------------------------------------------
// 5. Simulate actions
// ---------------------------------------------------------------------------

/** https://docs.withpersona.com/api-reference/inquiries/perform-simulate-actions */
export type PersonaSimulateAction =
  | { readonly type: 'start_inquiry' }
  | { readonly type: 'complete_inquiry' }
  | { readonly type: 'fail_inquiry' }
  | { readonly type: 'expire_inquiry' }
  | { readonly type: 'mark_for_review_inquiry' }
  | { readonly type: 'approve_inquiry' }
  | { readonly type: 'decline_inquiry' }
  | {
      readonly type: 'create_passed_verification' | 'create_failed_verification';
      readonly data: { readonly 'verification-template-id': string };
    };

export type PersonaDemoOutcome = 'pending' | 'approved' | 'declined' | 'needs_review';

/**
 * The four demo scripts. Each drives the inquiry to the named state AND fires
 * the matching webhook, which is how the app learns the outcome.
 */
export function personaDemoScript(
  outcome: PersonaDemoOutcome,
  verificationTemplateId?: string | undefined,
): PersonaSimulateAction[] {
  const passed: PersonaSimulateAction[] =
    verificationTemplateId === undefined
      ? []
      : [{ type: 'create_passed_verification', data: { 'verification-template-id': verificationTemplateId } }];
  const failed: PersonaSimulateAction[] =
    verificationTemplateId === undefined
      ? []
      : [{ type: 'create_failed_verification', data: { 'verification-template-id': verificationTemplateId } }];

  switch (outcome) {
    case 'pending':
      return [{ type: 'start_inquiry' }];
    case 'approved':
      return [{ type: 'start_inquiry' }, ...passed, { type: 'complete_inquiry' }, { type: 'approve_inquiry' }];
    case 'declined':
      return [{ type: 'start_inquiry' }, ...failed, { type: 'complete_inquiry' }, { type: 'decline_inquiry' }];
    case 'needs_review':
      return [{ type: 'start_inquiry' }, { type: 'complete_inquiry' }, { type: 'mark_for_review_inquiry' }];
  }
}

// ---------------------------------------------------------------------------
// 6. Small helpers
// ---------------------------------------------------------------------------

/**
 * The named checks a Persona inquiry produces.
 *
 * `leg` decides the check NAME, because the two legs answer different
 * questions and a screen that labelled a business inquiry `director_identity`
 * would be mis-citing its own evidence. `provider_outcome` carries Persona's
 * own status verbatim under the reserved name, so the screen prints their word
 * rather than our paraphrase of it.
 */
function personaChecks(
  rawStatus: string | null,
  leg: KybLegKind,
  eventName?: string,
): readonly KybCheck[] {
  const status = personaStatusToKyb(rawStatus);
  const reasons = [
    `persona inquiry status: ${rawStatus ?? 'unknown'}`,
    ...(eventName === undefined ? [] : [`event: ${eventName}`]),
    ...(rawStatus !== null && !isKnownPersonaStatus(rawStatus)
      ? ['unrecognised persona status, held for review (their enum is open-ended)']
      : []),
  ];
  const checkStatus: KybCheck['status'] =
    status === 'approved' ? 'passed' : status === 'rejected' ? 'failed' : 'pending';
  return [
    {
      name: leg === 'director_kyc' ? 'director_identity' : 'business_registry_match',
      status: checkStatus,
      reasons,
    },
    {
      name: KYB_PROVIDER_CODE_CHECK,
      status: checkStatus,
      reasons: [`persona_inquiry_${(rawStatus ?? 'unknown').trim().toLowerCase()}`],
    },
  ];
}

/** Drop empty and absent values, so no `fields` key is sent as a blank. */
function compactFields(fields: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * Persona's Inquiries API wants the UNABBREVIATED US subdivision
 * ("California"), unlike its own KYB Transactions API and unlike Stripe. This
 * is the formatter for THIS endpoint and is deliberately not shared.
 */
function personaFields(director: KybPerson | undefined): Record<string, string> {
  if (director === undefined) return {};
  const address: KybAddress | undefined = director.address;
  const fields: Record<string, string | undefined> = {
    'name-first': director.firstName,
    'name-last': director.lastName,
    'name-middle': director.middleName,
    birthdate: director.birthdate,
    'email-address': director.emailAddress,
    'phone-number': director.phoneNumber,
    'address-street-1': address?.street1,
    'address-street-2': address?.street2,
    'address-city': address?.city,
    'address-subdivision': address?.subdivision,
    'address-postal-code': address?.postalCode,
    'address-country-code': address?.countryCode,
  };
  // Note the omission: `tax_identification_number` is NOT sent here. The
  // director's SSN belongs in the verification flow the user completes, not in
  // a server-side create call we would then have to keep out of logs.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value !== '') out[key] = value;
  }
  return out;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Read a nested value off an unknown payload without trusting its shape. */
function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function readString(value: unknown, path: readonly string[]): string | null {
  const found = readPath(value, path);
  return typeof found === 'string' ? found : null;
}

function readObject(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  const found = readPath(value, path);
  return typeof found === 'object' && found !== null ? (found as Record<string, unknown>) : null;
}
