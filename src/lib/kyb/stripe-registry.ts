/**
 * Business-registry verification via Stripe Connect test mode.
 *
 * BE ACCURATE ABOUT WHAT THIS IS. This is Stripe verifying a business in order
 * to onboard it as a connected account. It performs a real company-registry
 * check — company name, EIN, owners, directors — and returns structured,
 * machine-readable failure codes, free and self-serve on a test key. It is not
 * a KYB vendor's compliance API, and nothing in the UI should imply that it is.
 * What it is, precisely: "Stripe Connect's company verification, which performs
 * a real registry check and returns structured failure codes."
 *
 * WHY IT IS HERE AT ALL. Every dedicated KYB sandbox is gated (Persona behind
 * support, Middesk behind sales, Sumsub behind a credit card — research/kyb/
 * NOTES.md §4). Connect test mode is the only free, self-serve, genuinely
 * third-party registry signal available, and it publishes magic EINs that force
 * each documented failure mode:
 *
 *   222221000  company not found in registry
 *   222221001  owners not found in registry
 *   222221002  directors not found in registry
 *   222221003  missing owners on the account vs the registry
 *   222221004  missing directors on the account vs the registry
 *   222221005  pending response from registry
 *
 * WHERE THE ANSWER LIVES — and a correction worth keeping, because the obvious
 * guess is wrong: THERE IS NO `company.verification.status` FIELD.
 * `company.verification` holds only a `document` sub-object; `verification.
 * status` exists on Person objects. The registry outcome is read from
 * `requirements.errors[]`, `requirements.pending_verification`,
 * `requirements.currently_due` and `requirements.disabled_reason`.
 *
 * KNOWN UNCONFIRMED: https://docs.stripe.com/connect/testing-verification says
 * the test key must come from an account "which has begun Connect platform
 * onboarding". Whether that is one dashboard click or a review is not stated
 * anywhere. If it turns out to be gated, the factory in ./index.ts selects
 * `SimulatedRegistryProvider` and says so — see ./README.md §"When a real key
 * appears".
 *
 * Signature verification is NOT here: `stripeVerifier` in
 * `src/lib/webhooks/inbox.ts` authenticates `account.updated` deliveries, and
 * `legFromStripeAccountEvent` maps the already-verified payload.
 */

import {
  KybProviderError,
  type CreateKybVerificationInput,
  type KybAddress,
  type KybCheck,
  type KybLegProvider,
  type KybLegResult,
  type KybStatus,
} from './types';

// ---------------------------------------------------------------------------
// 1. Configuration and test values
// ---------------------------------------------------------------------------

export const STRIPE_DEFAULT_BASE_URL = 'https://api.stripe.com';

export interface StripeRegistryConfig {
  /** `sk_test_…`. A live key must never reach this module. */
  readonly secretKey: string;
  readonly baseUrl?: string | undefined;
  /** `Stripe-Version`. Pin it in any deployment that matters. */
  readonly apiVersion?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

/**
 * Published magic EINs — https://docs.stripe.com/connect/testing.
 * "You can only use these values while testing with test API keys."
 */
export const STRIPE_TEST_EINS = {
  match: '000000000',
  matchNonProfit: '000000001',
  inactiveBusiness: '000000004',
  identityMismatch: '111111111',
  taxIdNotIssued: '111111112',
  /** Result arrives inline in the API response rather than via a webhook. */
  immediateMatch: '222222222',
  companyNotFoundInRegistry: '222221000',
  ownersNotFoundInRegistry: '222221001',
  directorsNotFoundInRegistry: '222221002',
  missingOwnersVsRegistry: '222221003',
  missingDirectorsVsRegistry: '222221004',
  pendingResponseFromRegistry: '222221005',
} as const;

/**
 * `requirements.errors[].code` values that are a DECISION to say no: the
 * registry was asked and the answer does not match. These reach `rejected`.
 * Source: https://docs.stripe.com/api/accounts/object.
 */
export const STRIPE_REJECT_CODES: ReadonlySet<string> = new Set([
  'verification_failed_tax_id_match',
  'verification_failed_tax_id_not_issued',
  'verification_failed_name_match',
  'verification_failed_keyed_match',
  'verification_failed_document_match',
  'verification_failed_address_match',
  'verification_directors_mismatch',
  'verification_legal_entity_structure_mismatch',
  'invalid_company_name_denylisted',
]);

/**
 * Codes that mean "the registry knows about people this account does not list"
 * — recoverable by adding them, so a human, not a decline.
 *
 * Everything NOT in either set also lands here: an error code this build does
 * not recognise is held for review and can never reach `approved`.
 */
export const STRIPE_REVIEW_CODES: ReadonlySet<string> = new Set([
  'verification_missing_owners',
  'verification_missing_directors',
  'verification_missing_executives',
  'verification_extraneous_directors',
  'verification_document_failed_test_mode',
]);

/**
 * `requirements.disabled_reason` values that are terminal.
 * `rejected.*` covers `rejected.fraud`, `rejected.incomplete_verification`, etc.
 */
function disabledReasonStatus(reason: string | null): KybStatus | null {
  if (reason === null) return null;
  if (reason.startsWith('rejected.') || reason === 'listed') return 'rejected';
  if (reason === 'under_review' || reason === 'platform_paused') return 'needs_review';
  if (reason === 'requirements.pending_verification') return 'pending';
  if (reason.startsWith('requirements.')) return 'pending';
  // An unrecognised disabled_reason is still a reason the account is disabled.
  return 'needs_review';
}

// ---------------------------------------------------------------------------
// 2. Status mapping
// ---------------------------------------------------------------------------

export interface StripeRequirementsView {
  readonly errors: readonly { readonly code: string | null; readonly reason: string | null; readonly requirement: string | null }[];
  readonly currentlyDue: readonly string[];
  readonly pastDue: readonly string[];
  readonly pendingVerification: readonly string[];
  readonly disabledReason: string | null;
}

/**
 * The registry outcome, from `requirements` alone.
 *
 * Precedence, strictest first, so a decline cannot be masked by a field that
 * also happens to be outstanding:
 *
 *   1. any error code in STRIPE_REJECT_CODES            -> rejected
 *   2. disabled_reason rejected.* / listed              -> rejected
 *   3. any other error, or disabled_reason under_review -> needs_review
 *   4. pending_verification non-empty (EIN 222221005)   -> pending
 *   5. currently_due / past_due non-empty               -> pending
 *   6. nothing outstanding                              -> approved
 */
export function stripeRequirementsToStatus(view: StripeRequirementsView): KybStatus {
  const codes = view.errors.map((e) => e.code).filter((c): c is string => typeof c === 'string');
  if (codes.some((c) => STRIPE_REJECT_CODES.has(c))) return 'rejected';

  const fromDisabled = disabledReasonStatus(view.disabledReason);
  if (fromDisabled === 'rejected') return 'rejected';

  // Any error at all that is not a hard decline needs a person, including codes
  // this build has never seen.
  if (view.errors.length > 0) return 'needs_review';
  if (fromDisabled === 'needs_review') return 'needs_review';

  if (view.pendingVerification.length > 0) return 'pending';
  if (view.currentlyDue.length > 0 || view.pastDue.length > 0) return 'pending';
  if (fromDisabled === 'pending') return 'pending';
  return 'approved';
}

// ---------------------------------------------------------------------------
// 3. The adapter
// ---------------------------------------------------------------------------

export class StripeConnectRegistryProvider implements KybLegProvider<'live'> {
  readonly leg = 'business_registry' as const;
  readonly name = 'stripe-connect';
  readonly evidence = 'live' as const;

  constructor(private readonly cfg: StripeRegistryConfig) {}

  async begin(input: CreateKybVerificationInput): Promise<KybLegResult<'live'>> {
    const form = new URLSearchParams();
    form.set('type', 'custom');
    form.set('country', input.registeredAddress.countryCode);
    form.set('business_type', 'company');
    form.set('company[name]', input.businessName);
    // Stripe wants nine digits and nothing else; a dash produces
    // `invalid_tax_id_format` rather than a registry answer.
    form.set('company[tax_id]', normaliseEin(input.taxIdentificationNumber));
    setAddress(form, 'company[address]', input.registeredAddress);
    const representative = input.associatedPeople?.[0];
    if (representative?.phoneNumber !== undefined) {
      form.set('company[phone]', representative.phoneNumber);
    }
    // Round-trips on every account.updated webhook, so a delivery can be
    // matched to a business without a lookup table.
    form.set('metadata[reference_id]', input.referenceId);

    const account = await this.request('POST', '/v1/accounts', form, {
      'Idempotency-Key': `kyb-registry-${input.referenceId}`,
    });
    return this.toLeg(account, input.referenceId);
  }

  async refresh(accountId: string): Promise<KybLegResult<'live'>> {
    const account = await this.request('GET', `/v1/accounts/${encodeURIComponent(accountId)}`);
    return this.toLeg(account, null);
  }

  private toLeg(account: unknown, fallbackReference: string | null): KybLegResult<'live'> {
    return stripeAccountToLeg(account, fallbackReference, this.name);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    form?: URLSearchParams,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.secretKey}`,
      Accept: 'application/json',
      ...extraHeaders,
    };
    if (this.cfg.apiVersion !== undefined) headers['Stripe-Version'] = this.cfg.apiVersion;
    if (form !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';

    let response: Response;
    try {
      response = await doFetch(`${this.cfg.baseUrl ?? STRIPE_DEFAULT_BASE_URL}${path}`, {
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
    const parsed = text === '' ? null : safeJsonParse(text);
    if (!response.ok) {
      // Stripe's `error.message` is written for developers and is safe to
      // surface; it does not echo the submitted EIN.
      const message = readString(parsed, ['error', 'message']) ?? `${response.status}`;
      throw new KybProviderError(this.name, `Stripe ${method} ${path} -> ${message}`, response.status);
    }
    return parsed;
  }
}

// ---------------------------------------------------------------------------
// 4. Webhooks: map an ALREADY-VERIFIED delivery
// ---------------------------------------------------------------------------

/**
 * Turn a verified `account.updated` delivery into a leg result.
 *
 * Envelope: `{ id: 'evt_…', type: 'account.updated', data: { object: {…} } }`.
 * Returns null for any other event type.
 */
export function legFromStripeAccountEvent(payload: unknown): KybLegResult<'live'> | null {
  const type = readString(payload, ['type']);
  if (type === null || !type.startsWith('account.')) return null;
  const account = readObject(payload, ['data', 'object']);
  if (account === null) return null;
  if (readString(account, ['object']) !== 'account') return null;
  return stripeAccountToLeg(account, null, 'stripe-connect');
}

/** Shared by the adapter and the webhook mapper so both read one implementation. */
export function stripeAccountToLeg(
  account: unknown,
  fallbackReference: string | null,
  providerName = 'stripe-connect',
): KybLegResult<'live'> {
  const view = readRequirements(account);
  const status = stripeRequirementsToStatus(view);
  const created = readNumber(account, ['created']);

  return {
    leg: 'business_registry',
    provider: providerName,
    reference: readString(account, ['id']) ?? '',
    referenceId: readString(account, ['metadata', 'reference_id']) ?? fallbackReference,
    status,
    // Stripe has no single status field for this, so the honest "raw status" is
    // the disabled_reason when there is one and the derived summary otherwise.
    rawStatus: view.disabledReason ?? (view.errors.length > 0 ? 'requirements.errors' : null),
    checks: stripeChecks(view, status),
    hostedUrl: null,
    observedAt: created === null ? new Date().toISOString() : new Date(created * 1000).toISOString(),
    evidence: 'live',
  };
}

function readRequirements(account: unknown): StripeRequirementsView {
  const requirements = readObject(account, ['requirements']);
  const rawErrors = readPath(requirements, ['errors']);
  const errors = Array.isArray(rawErrors)
    ? rawErrors.map((e) => ({
        code: readString(e, ['code']),
        reason: readString(e, ['reason']),
        requirement: readString(e, ['requirement']),
      }))
    : [];
  return {
    errors,
    currentlyDue: readStringArray(requirements, ['currently_due']),
    pastDue: readStringArray(requirements, ['past_due']),
    pendingVerification: readStringArray(requirements, ['pending_verification']),
    disabledReason: readString(requirements, ['disabled_reason']),
  };
}

function stripeChecks(view: StripeRequirementsView, status: KybStatus): readonly KybCheck[] {
  const checks: KybCheck[] = [
    {
      name: 'business_registry_match',
      status: status === 'approved' ? 'passed' : status === 'rejected' ? 'failed' : 'pending',
      reasons: [
        ...(view.disabledReason === null ? [] : [`disabled_reason: ${view.disabledReason}`]),
        ...(view.pendingVerification.length > 0
          ? [`pending_verification: ${view.pendingVerification.join(', ')}`]
          : []),
        ...(view.currentlyDue.length > 0 ? [`currently_due: ${view.currentlyDue.join(', ')}`] : []),
        ...(view.pastDue.length > 0 ? [`past_due: ${view.pastDue.join(', ')}`] : []),
      ],
    },
  ];
  for (const error of view.errors) {
    const code = error.code ?? 'unknown_error_code';
    const known = STRIPE_REJECT_CODES.has(code) || STRIPE_REVIEW_CODES.has(code);
    checks.push({
      name: error.requirement ?? code,
      status: STRIPE_REJECT_CODES.has(code) ? 'failed' : 'pending',
      reasons: [
        code,
        ...(error.reason === null ? [] : [error.reason]),
        ...(known ? [] : ['error code not recognised by this build; held for review']),
      ],
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// 5. Small helpers
// ---------------------------------------------------------------------------

export function normaliseEin(ein: string): string {
  return ein.replace(/\D/g, '');
}

function setAddress(form: URLSearchParams, prefix: string, address: KybAddress): void {
  form.set(`${prefix}[line1]`, address.street1);
  if (address.street2 !== undefined && address.street2 !== '') {
    form.set(`${prefix}[line2]`, address.street2);
  }
  form.set(`${prefix}[city]`, address.city);
  // Stripe wants the ISO 3166-2 abbreviation here ("CA"), unlike Persona's
  // Inquiries API which wants "California". Two formatters on purpose.
  form.set(`${prefix}[state]`, address.subdivision);
  form.set(`${prefix}[postal_code]`, address.postalCode);
  form.set(`${prefix}[country]`, address.countryCode);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

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

function readNumber(value: unknown, path: readonly string[]): number | null {
  const found = readPath(value, path);
  return typeof found === 'number' && Number.isFinite(found) ? found : null;
}

function readObject(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  const found = readPath(value, path);
  return typeof found === 'object' && found !== null ? (found as Record<string, unknown>) : null;
}

function readStringArray(value: unknown, path: readonly string[]): readonly string[] {
  const found = readPath(value, path);
  return Array.isArray(found) ? found.filter((v): v is string => typeof v === 'string') : [];
}
