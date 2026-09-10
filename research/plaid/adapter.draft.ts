/**
 * Plaid adapter — DRAFT (research spike, not wired up yet).
 *
 * No SDK: plain `fetch` + Web Crypto only, so this runs unchanged on the Vercel
 * Node runtime and the Edge runtime.
 *
 * Scope: open-banking funding for the Corgi neobank — link an external US bank
 * account, read its ACH routing/account numbers, verify the account holder's
 * name, and handle Plaid's webhooks.
 *
 * Conventions used here:
 *   - Credentials go in PLAID-CLIENT-ID / PLAID-SECRET headers rather than the
 *     JSON body, so they never end up in a logged request payload.
 *   - Every response shape below is typed from the published API reference.
 *     Anything I could not pin to a doc page is flagged `// UNVERIFIED:`.
 *   - Money is NOT handled here. Plaid balances are floating-point dollars;
 *     convert to integer cents at the call site with an explicit rounding
 *     policy — do not let a float reach the ledger.
 *
 * Docs index: see ./NOTES.md
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type PlaidEnvironment = 'sandbox' | 'production';

const PLAID_HOSTS: Record<PlaidEnvironment, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: PlaidEnvironment;
  /** Per-request timeout in ms. Plaid can be slow on first Item calls. */
  timeoutMs?: number;
}

export function plaidConfigFromEnv(): PlaidConfig {
  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const environment = (process.env.PLAID_ENV ?? 'sandbox') as PlaidEnvironment;

  if (!clientId) throw new Error('PLAID_CLIENT_ID is not set');
  if (!secret) throw new Error('PLAID_SECRET is not set');
  if (environment !== 'sandbox' && environment !== 'production') {
    throw new Error(`PLAID_ENV must be "sandbox" or "production", got "${environment}"`);
  }

  return { clientId, secret, environment };
}

// ---------------------------------------------------------------------------
// Errors + transport
// ---------------------------------------------------------------------------

/** Plaid's standard error envelope. https://plaid.com/docs/errors/ */
export interface PlaidErrorBody {
  error_type: string;
  error_code: string;
  /** UNVERIFIED: present on newer errors only (e.g. OAUTH_INVALID_TOKEN). */
  error_code_reason?: string | null;
  error_message: string;
  display_message: string | null;
  request_id?: string;
  causes?: unknown[];
  status?: number;
  documentation_url?: string;
  suggested_action?: string | null;
}

export class PlaidApiError extends Error {
  readonly status: number;
  readonly body: PlaidErrorBody;

  constructor(status: number, body: PlaidErrorBody) {
    super(`Plaid ${body.error_code}: ${body.error_message}`);
    this.name = 'PlaidApiError';
    this.status = status;
    this.body = body;
  }

  get errorCode(): string {
    return this.body.error_code;
  }

  /** The user must re-authenticate through Link update mode. */
  get requiresUserReauth(): boolean {
    return (
      this.body.error_code === 'ITEM_LOGIN_REQUIRED' ||
      this.body.error_code === 'PENDING_EXPIRATION' ||
      this.body.error_code === 'PENDING_DISCONNECT'
    );
  }

  /** Transient — safe to retry with backoff. */
  get isRetryable(): boolean {
    return (
      this.status >= 500 ||
      this.status === 429 ||
      this.body.error_type === 'RATE_LIMIT_EXCEEDED' ||
      this.body.error_code === 'INSTITUTION_DOWN' ||
      this.body.error_code === 'INSTITUTION_NOT_RESPONDING' ||
      this.body.error_code === 'PRODUCT_NOT_READY' ||
      this.body.error_code === 'INTERNAL_SERVER_ERROR'
    );
  }
}

async function plaidFetch<T>(
  cfg: PlaidConfig,
  path: `/${string}`,
  body: Record<string, unknown>,
): Promise<T> {
  const url = `${PLAID_HOSTS[cfg.environment]}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 30_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'PLAID-CLIENT-ID': cfg.clientId,
        'PLAID-SECRET': cfg.secret,
      },
      // Strip undefined so we never send `"webhook": null` by accident.
      body: JSON.stringify(body, (_k, v) => (v === undefined ? undefined : v)),
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) {
    let parsed: PlaidErrorBody;
    try {
      parsed = JSON.parse(text) as PlaidErrorBody;
    } catch {
      parsed = {
        error_type: 'API_ERROR',
        error_code: 'UNPARSEABLE_RESPONSE',
        error_message: text.slice(0, 500),
        display_message: null,
      };
    }
    throw new PlaidApiError(res.status, parsed);
  }

  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// Shared response types
// ---------------------------------------------------------------------------

export type PlaidAccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'brokerage' | 'other';

export interface PlaidBalances {
  available: number | null;
  current: number | null;
  limit: number | null;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  /** UNVERIFIED: returned by some products/institutions only. */
  last_updated_datetime?: string | null;
}

export type PlaidVerificationStatus =
  | 'pending_automatic_verification'
  | 'pending_manual_verification'
  | 'automatically_verified'
  | 'manually_verified'
  | 'verification_expired'
  | 'verification_failed'
  // UNVERIFIED: seen in newer docs for the database-match flows.
  | 'database_matched'
  | 'database_insights_pending';

export interface PlaidAccount {
  account_id: string;
  balances: PlaidBalances;
  /** Last 2-4 chars of the account number. Nullable at some institutions. */
  mask: string | null;
  name: string;
  official_name: string | null;
  type: PlaidAccountType;
  subtype: string | null;
  /** Present only during/after a micro-deposit or database verification flow. */
  verification_status?: PlaidVerificationStatus;
  /** UNVERIFIED: only present for micro-deposit items. */
  verification_name?: string | null;
  persistent_account_id?: string;
}

/** How Plaid obtained the Auth numbers. Worth persisting for risk scoring. */
export type PlaidAuthMethod =
  | 'INSTANT_AUTH'
  | 'INSTANT_MATCH'
  | 'AUTOMATED_MICRODEPOSITS'
  | 'SAME_DAY_MICRODEPOSITS'
  | 'INSTANT_MICRODEPOSITS'
  | 'DATABASE_MATCH'
  | 'DATABASE_INSIGHTS';

export interface PlaidItem {
  item_id: string;
  institution_id: string | null;
  /** UNVERIFIED: newer field; may be absent on older Items. */
  institution_name?: string | null;
  webhook: string | null;
  error: PlaidErrorBody | null;
  available_products: string[];
  billed_products: string[];
  products?: string[];
  consented_products?: string[];
  consented_data_scopes?: string[];
  consent_expiration_time: string | null;
  update_type: 'background' | 'user_present_required' | string;
  auth_method?: PlaidAuthMethod | null;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// 1. /link/token/create
// ---------------------------------------------------------------------------

export type PlaidProduct =
  | 'auth'
  | 'identity'
  | 'transactions'
  | 'balance'
  | 'transfer'
  | 'liabilities'
  | 'investments'
  | 'assets'
  | 'income_verification'
  | 'signal'
  | 'identity_verification'
  | 'statements';

export interface CreateLinkTokenParams {
  /** Your stable internal user id. Do NOT put PII (email, SSN) here. */
  clientUserId: string;
  /** Shown in the Link UI. Plaid enforces a 30 character maximum. */
  clientName: string;
  products?: PlaidProduct[];
  /** Best-effort: won't fail the link if the institution can't provide them. */
  optionalProducts?: PlaidProduct[];
  /** Required where supported, skipped where not. */
  requiredIfSupportedProducts?: PlaidProduct[];
  countryCodes?: string[];
  language?: string;
  /** HTTPS endpoint that will receive this Item's webhooks. */
  webhook?: string;
  /**
   * OAuth institutions only. Must be pre-registered on the dashboard allowlist,
   * no query params, no '#', HTTPS (localhost over HTTP allowed in Sandbox).
   */
  redirectUri?: string;
  /** Update mode: pass an existing access_token and omit `products`. */
  accessToken?: string;
  /**
   * Restrict what the user can select. For funding a business account we only
   * ever want a checking or savings account.
   */
  accountFilters?: {
    depository?: { account_subtypes: string[] };
    credit?: { account_subtypes: string[] };
    loan?: { account_subtypes: string[] };
    investment?: { account_subtypes: string[] };
  };
  linkCustomizationName?: string;
  /** UNVERIFIED: Hosted Link config shape not fully pinned down. */
  hostedLink?: Record<string, unknown>;
}

export interface LinkTokenCreateResponse {
  link_token: string;
  /** ISO 8601. Default lifetime is 4 hours. */
  expiration: string;
  request_id: string;
}

/**
 * Mint a short-lived token used to initialize Plaid Link in the browser.
 * Server-side only — never expose the secret to the client.
 *
 * Default here is `products: ['auth']` with `identity` as an optional product,
 * which is what the funding flow needs: routing/account numbers plus a name to
 * match against the business owner on file.
 */
export async function createLinkToken(
  cfg: PlaidConfig,
  params: CreateLinkTokenParams,
): Promise<LinkTokenCreateResponse> {
  if (params.clientName.length > 30) {
    throw new Error(`client_name must be <= 30 characters, got ${params.clientName.length}`);
  }
  if (!params.accessToken && (!params.products || params.products.length === 0)) {
    throw new Error('products is required unless creating an update-mode link token');
  }

  return plaidFetch<LinkTokenCreateResponse>(cfg, '/link/token/create', {
    client_name: params.clientName,
    language: params.language ?? 'en',
    country_codes: params.countryCodes ?? ['US'],
    user: { client_user_id: params.clientUserId },
    // Update mode: `products` must be omitted when `access_token` is present.
    products: params.accessToken ? undefined : params.products,
    optional_products: params.optionalProducts,
    required_if_supported_products: params.requiredIfSupportedProducts,
    webhook: params.webhook,
    redirect_uri: params.redirectUri,
    access_token: params.accessToken,
    account_filters: params.accountFilters,
    link_customization_name: params.linkCustomizationName,
    hosted_link: params.hostedLink,
  });
}

// ---------------------------------------------------------------------------
// 2. /sandbox/public_token/create  — skip the Link UI entirely
// ---------------------------------------------------------------------------

/**
 * Sandbox custom-user config, passed as the *password*.
 * Full schema: https://plaid.com/docs/sandbox/user-custom/
 * UNVERIFIED: only the fields we need are modelled; the real schema is much larger.
 */
export interface SandboxCustomUser {
  seed?: string;
  override_accounts: Array<{
    type: string;
    subtype: string;
    /** Dollars, not cents — Plaid's sandbox config is float dollars. */
    starting_balance?: number;
    force_available_balance?: number;
    currency?: string;
    numbers?: {
      account?: string;
      /** Use "322271627" to make /transfer/capabilities/get return true. */
      routing?: string;
      wire_routing?: string;
    };
    identity?: {
      names?: string[];
      phone_numbers?: Array<{ primary: boolean; type: string; data: string }>;
      emails?: Array<{ primary: boolean; type: string; data: string }>;
      addresses?: Array<{
        primary: boolean;
        data: {
          street: string;
          city: string;
          region: string;
          postal_code: string;
          country: string;
        };
      }>;
    };
    transactions?: Array<{
      date_transacted?: string;
      date_posted: string;
      amount: number;
      currency: string;
      description: string;
    }>;
    meta?: { name?: string; official_name?: string; limit?: number };
  }>;
}

export interface CreateSandboxPublicTokenParams {
  /** Default: ins_109508 (First Platypus Bank, non-OAuth). */
  institutionId?: string;
  initialProducts?: PlaidProduct[];
  /** Set this if you want to exercise webhooks against this Item. */
  webhook?: string;
  /** Default 'user_good'. Use 'user_custom' with a customUser config. */
  overrideUsername?: string;
  /**
   * Default 'pass_good'. Also accepts 'error_<CODE>' to force a link failure,
   * or 'microdeposits_good' for the micro-deposit flow.
   * Ignored when `customUser` is supplied.
   */
  overridePassword?: string;
  /**
   * Deterministic account data. When set, username defaults to 'user_custom'
   * and the JSON is serialized into override_password.
   */
  customUser?: SandboxCustomUser;
  /** transactions.days_requested, 1-730, default 90. */
  transactionsDaysRequested?: number;
}

export interface SandboxPublicTokenCreateResponse {
  public_token: string;
  request_id: string;
}

/**
 * Create a fully-formed Sandbox Item without any browser interaction.
 *
 * This is the fast path for tests, seed scripts and demos: call this, then
 * exchangePublicToken(), and you have a working access_token in ~2 seconds
 * with no Link UI, no link_token and no OAuth redirect.
 *
 * Sandbox only — it 400s in production.
 */
export async function createSandboxPublicToken(
  cfg: PlaidConfig,
  params: CreateSandboxPublicTokenParams = {},
): Promise<SandboxPublicTokenCreateResponse> {
  if (cfg.environment !== 'sandbox') {
    throw new Error('createSandboxPublicToken is only available in the sandbox environment');
  }

  const overrideUsername =
    params.overrideUsername ?? (params.customUser ? 'user_custom' : 'user_good');
  const overridePassword = params.customUser
    ? JSON.stringify(params.customUser)
    : (params.overridePassword ?? 'pass_good');

  return plaidFetch<SandboxPublicTokenCreateResponse>(cfg, '/sandbox/public_token/create', {
    institution_id: params.institutionId ?? 'ins_109508',
    initial_products: params.initialProducts ?? ['auth', 'identity'],
    options: {
      webhook: params.webhook,
      override_username: overrideUsername,
      override_password: overridePassword,
    },
    transactions: params.transactionsDaysRequested
      ? { days_requested: params.transactionsDaysRequested }
      : undefined,
  });
}

// ---------------------------------------------------------------------------
// 3. /item/public_token/exchange
// ---------------------------------------------------------------------------

export interface ExchangePublicTokenResponse {
  /** Long-lived. Encrypt at rest; never send to the client. */
  access_token: string;
  item_id: string;
  request_id: string;
}

/**
 * Exchange the short-lived public_token from Link's onSuccess (or from
 * createSandboxPublicToken) for a long-lived access_token.
 * public_token expires after 30 minutes and is single-use.
 */
export async function exchangePublicToken(
  cfg: PlaidConfig,
  publicToken: string,
): Promise<ExchangePublicTokenResponse> {
  return plaidFetch<ExchangePublicTokenResponse>(cfg, '/item/public_token/exchange', {
    public_token: publicToken,
  });
}

// ---------------------------------------------------------------------------
// 4. /auth/get
// ---------------------------------------------------------------------------

export interface PlaidAchNumbers {
  account_id: string;
  /** The deposit account number (or a tokenized stand-in — see the flag below). */
  account: string;
  /** ACH (ABA) routing number. THIS is the one you send to an ACH provider. */
  routing: string;
  /** Fedwire routing number. Different rail — never substitute for `routing`. */
  wire_routing: string | null;
  /** When true, `account` is a per-merchant token, not the customer's real DDA. */
  is_tokenized_account_number?: boolean;
}

export interface PlaidEftNumbers {
  account_id: string;
  account: string;
  institution: string;
  branch: string;
}

export interface PlaidInternationalNumbers {
  account_id: string;
  iban: string;
  bic: string;
}

export interface PlaidBacsNumbers {
  account_id: string;
  account: string;
  sort_code: string;
}

export interface AuthGetResponse {
  accounts: PlaidAccount[];
  numbers: {
    /** Flat array across all accounts — join to accounts on account_id. */
    ach: PlaidAchNumbers[];
    eft: PlaidEftNumbers[];
    international: PlaidInternationalNumbers[];
    bacs: PlaidBacsNumbers[];
  };
  item: PlaidItem;
  request_id: string;
}

export async function getAuth(
  cfg: PlaidConfig,
  accessToken: string,
  options?: { accountIds?: string[] },
): Promise<AuthGetResponse> {
  return plaidFetch<AuthGetResponse>(cfg, '/auth/get', {
    access_token: accessToken,
    options: options?.accountIds ? { account_ids: options.accountIds } : undefined,
  });
}

/** What our funding flow actually needs out of /auth/get, flattened and checked. */
export interface FundingSource {
  accountId: string;
  accountName: string;
  mask: string | null;
  subtype: string | null;
  /** ACH routing number — 9 digits. */
  routingNumber: string;
  accountNumber: string;
  wireRoutingNumber: string | null;
  isTokenizedAccountNumber: boolean;
  verificationStatus: PlaidVerificationStatus | null;
  authMethod: PlaidAuthMethod | null;
  /** True when it is safe to originate an ACH debit against this account. */
  readyForAch: boolean;
}

/**
 * Join accounts to their ACH numbers and apply the guardrails we care about:
 * depository only, no pending micro-deposit verification, valid ABA checksum.
 */
export function toFundingSources(res: AuthGetResponse): FundingSource[] {
  const byAccountId = new Map(res.numbers.ach.map((n) => [n.account_id, n]));

  return res.accounts.flatMap((acct) => {
    const ach = byAccountId.get(acct.account_id);
    if (!ach) return [];
    if (acct.type !== 'depository') return [];

    const pending =
      acct.verification_status === 'pending_automatic_verification' ||
      acct.verification_status === 'pending_manual_verification';
    const failed =
      acct.verification_status === 'verification_expired' ||
      acct.verification_status === 'verification_failed';

    return [
      {
        accountId: acct.account_id,
        accountName: acct.name,
        mask: acct.mask,
        subtype: acct.subtype,
        routingNumber: ach.routing,
        accountNumber: ach.account,
        wireRoutingNumber: ach.wire_routing,
        isTokenizedAccountNumber: ach.is_tokenized_account_number ?? false,
        verificationStatus: acct.verification_status ?? null,
        authMethod: res.item.auth_method ?? null,
        readyForAch: !pending && !failed && isValidAbaRoutingNumber(ach.routing),
      },
    ];
  });
}

/** ABA checksum (3-7-1 weighting). Cheap sanity check before origination. */
export function isValidAbaRoutingNumber(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + 1 * (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// 5. /identity/get
// ---------------------------------------------------------------------------

export interface PlaidOwner {
  names: string[];
  phone_numbers: Array<{ data: string; primary: boolean; type: string }>;
  emails: Array<{ data: string; primary: boolean; type: string }>;
  addresses: Array<{
    data: {
      street: string | null;
      city: string | null;
      region: string | null;
      postal_code: string | null;
      country: string | null;
    };
    primary: boolean;
  }>;
  /** UNVERIFIED: documented for some institutions only. */
  document_ids?: Array<{ document_type: string; number: string | null }>;
}

export interface IdentityGetResponse {
  accounts: Array<PlaidAccount & { owners: PlaidOwner[] }>;
  item: PlaidItem;
  request_id: string;
}

export async function getIdentity(
  cfg: PlaidConfig,
  accessToken: string,
  options?: { accountIds?: string[] },
): Promise<IdentityGetResponse> {
  return plaidFetch<IdentityGetResponse>(cfg, '/identity/get', {
    access_token: accessToken,
    options: options?.accountIds ? { account_ids: options.accountIds } : undefined,
  });
}

/**
 * UNVERIFIED (endpoint availability): /identity/match is billed separately from
 * /identity/get and may need to be enabled on the account. Prefer it over
 * hand-rolled string comparison when it is available — Plaid handles nicknames,
 * name ordering and business-name detection.
 * Scores: 99-85 strong, 84-70 partial. Recommended threshold >= 70.
 */
export interface IdentityMatchResponse {
  accounts: Array<{
    account_id: string;
    legal_name: {
      score: number | null;
      is_nickname_match: boolean | null;
      is_first_name_or_last_name_match: boolean | null;
      is_business_name_detected: boolean | null;
    } | null;
    phone_number: { score: number | null } | null;
    email_address: { score: number | null } | null;
    address: { score: number | null; is_postal_code_match: boolean | null } | null;
  }>;
  item: PlaidItem;
  request_id: string;
}

export async function matchIdentity(
  cfg: PlaidConfig,
  accessToken: string,
  user: {
    legal_name?: string;
    phone_number?: string;
    email_address?: string;
    address?: {
      street?: string;
      city?: string;
      region?: string;
      postal_code?: string;
      country?: string;
    };
  },
  options?: { accountIds?: string[] },
): Promise<IdentityMatchResponse> {
  return plaidFetch<IdentityMatchResponse>(cfg, '/identity/match', {
    access_token: accessToken,
    user,
    options: options?.accountIds ? { account_ids: options.accountIds } : undefined,
  });
}

// ---------------------------------------------------------------------------
// 6. Sandbox test helpers
// ---------------------------------------------------------------------------

export type PlaidWebhookType =
  | 'AUTH'
  | 'ITEM'
  | 'TRANSACTIONS'
  | 'HOLDINGS'
  | 'INVESTMENTS_TRANSACTIONS'
  | 'LIABILITIES'
  | 'ASSETS';

export type SandboxWebhookCode =
  | 'DEFAULT_UPDATE'
  | 'NEW_ACCOUNTS_AVAILABLE'
  | 'SMS_MICRODEPOSITS_VERIFICATION'
  | 'USER_PERMISSION_REVOKED'
  | 'USER_ACCOUNT_REVOKED'
  | 'PENDING_DISCONNECT'
  | 'RECURRING_TRANSACTIONS_UPDATE'
  | 'LOGIN_REPAIRED'
  | 'SYNC_UPDATES_AVAILABLE'
  | 'PRODUCT_READY'
  | 'ERROR';

export interface FireWebhookResponse {
  webhook_fired: boolean;
  request_id: string;
}

/**
 * Trigger a webhook on demand. The Item must already have a webhook URL set
 * (via options.webhook on createSandboxPublicToken, or webhook on
 * createLinkToken, or /item/webhook/update).
 */
export async function fireSandboxWebhook(
  cfg: PlaidConfig,
  accessToken: string,
  webhookCode: SandboxWebhookCode,
  webhookType?: PlaidWebhookType,
): Promise<FireWebhookResponse> {
  if (cfg.environment !== 'sandbox') {
    throw new Error('fireSandboxWebhook is only available in the sandbox environment');
  }
  return plaidFetch<FireWebhookResponse>(cfg, '/sandbox/item/fire_webhook', {
    access_token: accessToken,
    webhook_type: webhookType,
    webhook_code: webhookCode,
  });
}

/** Force ITEM_LOGIN_REQUIRED, to exercise the reconnect / update-mode path. */
export async function resetSandboxLogin(
  cfg: PlaidConfig,
  accessToken: string,
): Promise<{ reset_login: boolean; request_id: string }> {
  if (cfg.environment !== 'sandbox') {
    throw new Error('resetSandboxLogin is only available in the sandbox environment');
  }
  return plaidFetch(cfg, '/sandbox/item/reset_login', { access_token: accessToken });
}

/** Skip the 24h micro-deposit wait, or force it to expire. */
export async function setSandboxVerificationStatus(
  cfg: PlaidConfig,
  accessToken: string,
  accountId: string,
  status: 'automatically_verified' | 'verification_expired',
): Promise<{ request_id: string }> {
  if (cfg.environment !== 'sandbox') {
    throw new Error('setSandboxVerificationStatus is only available in the sandbox environment');
  }
  return plaidFetch(cfg, '/sandbox/item/set_verification_status', {
    access_token: accessToken,
    account_id: accountId,
    verification_status: status,
  });
}

/** Point an existing Item at a new webhook URL. */
export async function updateItemWebhook(
  cfg: PlaidConfig,
  accessToken: string,
  webhook: string | null,
): Promise<{ item: PlaidItem; request_id: string }> {
  return plaidFetch(cfg, '/item/webhook/update', {
    access_token: accessToken,
    webhook,
  });
}

// ---------------------------------------------------------------------------
// 7. Processor tokens (for a later pairing with Increase / Moov)
// ---------------------------------------------------------------------------

/**
 * Snake_case enum. Full list in ./NOTES.md §7 — both 'increase' and 'moov' are
 * supported. Stripe is the exception: use /processor/stripe/bank_account_token/create.
 */
export type PlaidProcessor =
  | 'increase'
  | 'moov'
  | 'modern_treasury'
  | 'dwolla'
  | 'unit'
  | 'treasury_prime'
  | 'column' // UNVERIFIED: not in the enum list I read; confirm before using.
  | (string & {});

export async function createProcessorToken(
  cfg: PlaidConfig,
  accessToken: string,
  accountId: string,
  processor: PlaidProcessor,
): Promise<{ processor_token: string; request_id: string }> {
  return plaidFetch(cfg, '/processor/token/create', {
    access_token: accessToken,
    account_id: accountId,
    processor,
  });
}

// ---------------------------------------------------------------------------
// 8. Webhook verification
// ---------------------------------------------------------------------------

export interface PlaidWebhookEnvelope {
  webhook_type: string;
  webhook_code: string;
  item_id?: string;
  error?: PlaidErrorBody | null;
  environment?: 'sandbox' | 'production';
  /** ITEM/WEBHOOK_UPDATE_ACKNOWLEDGED */
  new_webhook_url?: string;
  /** AUTH/*_VERIFICATION and micro-deposit codes */
  account_id?: string;
  [key: string]: unknown;
}

interface PlaidJwk {
  alg: string;
  created_at: number;
  crv: string;
  expired_at: number | null;
  kid: string;
  kty: string;
  use: string;
  x: string;
  y: string;
}

/**
 * Per-`kid` key cache. Plaid rotates signing keys, so caching a single global
 * key (as Plaid's own Python sample does) breaks on the first rotation.
 * Module-scope, so it survives warm serverless invocations and dies with the
 * container — which is the behaviour we want.
 */
const jwkCache = new Map<string, PlaidJwk>();

async function fetchVerificationKey(cfg: PlaidConfig, keyId: string): Promise<PlaidJwk> {
  const cached = jwkCache.get(keyId);
  if (cached) return cached;

  const res = await plaidFetch<{ key: PlaidJwk; request_id: string }>(
    cfg,
    '/webhook_verification_key/get',
    { key_id: keyId },
  );

  if (res.key.expired_at !== null) {
    throw new PlaidWebhookVerificationError(`verification key ${keyId} is expired`);
  }
  jwkCache.set(keyId, res.key);
  return res.key;
}

export class PlaidWebhookVerificationError extends Error {
  constructor(message: string) {
    super(`Plaid webhook verification failed: ${message}`);
    this.name = 'PlaidWebhookVerificationError';
  }
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const b64 = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlToJson<T>(input: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(input))) as T;
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Length-independent constant-time compare of two hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyPlaidWebhookOptions {
  /** Max age of the JWT in seconds. Plaid's documented limit is 5 minutes. */
  maxAgeSeconds?: number;
}

/**
 * Verify an inbound Plaid webhook.
 *
 * ┌─ CRITICAL ─────────────────────────────────────────────────────────────┐
 * │ `rawBody` MUST be the exact bytes Plaid sent. In a Next.js App Router   │
 * │ route handler that means:                                              │
 * │                                                                        │
 * │   const rawBody = await req.text();          // FIRST, before parsing  │
 * │   const payload = await verifyPlaidWebhook(cfg, rawBody, req.headers);  │
 * │                                                                        │
 * │ Never JSON.parse -> JSON.stringify -> hash. Plaid's docs note the       │
 * │ request_body_sha256 claim "is sensitive to the whitespace in the        │
 * │ webhook body and uses a tab-spacing of 2", so any re-serialization      │
 * │ produces a different hash and the check fails.                         │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Algorithm (all six steps mandatory):
 *   1. Read the Plaid-Verification header.
 *   2. Decode the JWT header WITHOUT verifying; assert alg === 'ES256'.
 *      (Rejecting anything else is the algorithm-confusion defense.)
 *   3. Fetch the JWK for the header's `kid` via /webhook_verification_key/get,
 *      from the SAME environment the webhook came from. Cache per kid.
 *   4. Verify the ES256 signature over `${header}.${payload}` with that JWK.
 *   5. Reject if iat is more than 5 minutes old (anti-replay).
 *   6. Constant-time compare sha256_hex(rawBody) against request_body_sha256.
 *
 * Returns the parsed webhook body on success; throws otherwise.
 */
export async function verifyPlaidWebhook(
  cfg: PlaidConfig,
  rawBody: string,
  headers: Headers | Record<string, string | string[] | undefined>,
  options: VerifyPlaidWebhookOptions = {},
): Promise<PlaidWebhookEnvelope> {
  // --- Step 1: pull the header (case-insensitively) -------------------------
  const signedJwt =
    headers instanceof Headers
      ? headers.get('plaid-verification')
      : (() => {
          const key = Object.keys(headers).find((k) => k.toLowerCase() === 'plaid-verification');
          const v = key ? headers[key] : undefined;
          return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
        })();

  if (!signedJwt) {
    throw new PlaidWebhookVerificationError('missing Plaid-Verification header');
  }

  const parts = signedJwt.split('.');
  if (parts.length !== 3) {
    throw new PlaidWebhookVerificationError('malformed JWT');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  // --- Step 2: alg must be ES256 -------------------------------------------
  let jwtHeader: { alg?: string; kid?: string; typ?: string };
  try {
    jwtHeader = base64UrlToJson(encodedHeader);
  } catch {
    throw new PlaidWebhookVerificationError('unparseable JWT header');
  }
  if (jwtHeader.alg !== 'ES256') {
    throw new PlaidWebhookVerificationError(`unexpected alg "${jwtHeader.alg}", expected ES256`);
  }
  if (!jwtHeader.kid) {
    throw new PlaidWebhookVerificationError('JWT header missing kid');
  }

  // --- Step 3: fetch (and cache) the public key ----------------------------
  const jwk = await fetchVerificationKey(cfg, jwtHeader.kid);

  // --- Step 4: verify the ES256 signature ----------------------------------
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );

  // ES256 signatures are raw r||s (64 bytes), which is exactly what Web Crypto
  // expects — no DER unwrapping needed.
  const signature = base64UrlToBytes(encodedSignature);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);

  const signatureValid = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    signature as BufferSource,
    signingInput as BufferSource,
  );
  if (!signatureValid) {
    throw new PlaidWebhookVerificationError('bad signature');
  }

  // --- Step 5: freshness ---------------------------------------------------
  let claims: { iat?: number; request_body_sha256?: string };
  try {
    claims = base64UrlToJson(encodedPayload);
  } catch {
    throw new PlaidWebhookVerificationError('unparseable JWT payload');
  }

  const maxAge = options.maxAgeSeconds ?? 5 * 60;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof claims.iat !== 'number' || claims.iat < nowSeconds - maxAge) {
    throw new PlaidWebhookVerificationError('JWT is stale (possible replay)');
  }

  // --- Step 6: body integrity, constant-time -------------------------------
  if (!claims.request_body_sha256) {
    throw new PlaidWebhookVerificationError('JWT missing request_body_sha256 claim');
  }
  const bodyHash = await sha256Hex(rawBody);
  if (!timingSafeEqualHex(bodyHash, claims.request_body_sha256)) {
    throw new PlaidWebhookVerificationError('body hash mismatch');
  }

  const payload = JSON.parse(rawBody) as PlaidWebhookEnvelope;

  // Defense in depth: never let a production webhook mutate sandbox state.
  if (payload.environment && payload.environment !== cfg.environment) {
    throw new PlaidWebhookVerificationError(
      `environment mismatch: webhook says "${payload.environment}", adapter is "${cfg.environment}"`,
    );
  }

  return payload;
}

/*
 * ---------------------------------------------------------------------------
 * Usage sketch — app/api/webhooks/plaid/route.ts
 * ---------------------------------------------------------------------------
 *
 * export const runtime = 'nodejs';
 * export const dynamic = 'force-dynamic';
 *
 * export async function POST(req: Request) {
 *   const rawBody = await req.text();          // raw bytes FIRST
 *   const cfg = plaidConfigFromEnv();
 *
 *   let payload;
 *   try {
 *     payload = await verifyPlaidWebhook(cfg, rawBody, req.headers);
 *   } catch (err) {
 *     console.warn('rejected plaid webhook', err);
 *     return new Response('invalid signature', { status: 401 });
 *   }
 *
 *   // Plaid requires a 2xx within 10 seconds and retries for 24h otherwise.
 *   // Persist-and-ack; do the real work out of band.
 *   await enqueuePlaidWebhook(payload);
 *   return new Response(null, { status: 200 });
 * }
 *
 * ---------------------------------------------------------------------------
 * Usage sketch — seed a funded-ready test account with zero UI
 * ---------------------------------------------------------------------------
 *
 * const cfg = plaidConfigFromEnv();
 * const { public_token } = await createSandboxPublicToken(cfg, {
 *   institutionId: 'ins_109508',
 *   initialProducts: ['auth', 'identity'],
 *   webhook: process.env.PLAID_WEBHOOK_URL,
 *   customUser: {
 *     seed: 'corgi-trial-1',
 *     override_accounts: [{
 *       type: 'depository',
 *       subtype: 'checking',
 *       starting_balance: 25000,
 *       numbers: { account: '1234567890', routing: '011401533', wire_routing: '021000021' },
 *       identity: { names: ['Jane Q Founder'] },
 *     }],
 *   },
 * });
 * const { access_token, item_id } = await exchangePublicToken(cfg, public_token);
 * const sources = toFundingSources(await getAuth(cfg, access_token));
 * // sources[0].routingNumber === '011401533', .accountNumber === '1234567890'
 */
