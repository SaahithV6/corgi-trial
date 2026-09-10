/**
 * The HTTP surface for inbound provider webhooks.
 *
 * `inbox.ts` owns verification, persistence and replay. This module owns the
 * three things that are HTTP's problem and not the inbox's:
 *
 *   1. WIRING — which providers exist, which env vars each one needs, and how
 *      to build its verifier. One catalogue (`WEBHOOK_INTEGRATIONS`), read both
 *      by the router and by `/api/health`, so an integration cannot be
 *      advertised as live on the health page while its route answers 404.
 *   2. STATUS CODES — the failure table in `src/app/api/webhooks/README.md`,
 *      implemented in exactly one place (`respondTo`) so the mapping is a table
 *      a reviewer can read rather than branches scattered through a handler.
 *   3. LOGGING — one structured line per delivery carrying provider, event id,
 *      verified, outcome and duration.
 *
 * THE ORDER IS LOAD-BEARING, and this module does not re-implement it. The
 * whole handler body is `await ingestWebhook(provider, req, ...)`, and
 * `ingestWebhook` reads `await req.text()` first, verifies the signature over
 * those exact bytes, and only then calls `parseVerifiedJson`. Nothing here ever
 * touches `req.json()`, and because the request body is a one-shot stream,
 * `ingestWebhook` having consumed it means nothing downstream *can* re-read or
 * re-serialise it. That is the "impossible to get wrong" property: it is not
 * enforced by a comment, it is enforced by there being exactly one call and the
 * body being gone afterwards. `route-handler.test.ts` asserts it with a request
 * whose `json()` throws.
 */

import postgres from 'postgres';

import { logger, requestIdFrom, type Logger } from '../log';
import {
  cachedVerificationKeys,
  createPostgresInboxStore,
  increaseVerifier,
  ingestWebhook,
  lithicVerifier,
  personaVerifier,
  plaidVerifier,
  sqlExecutorFromPostgresJs,
  stripeVerifier,
  VerifierRegistry,
  type InboxStore,
  type IngestResult,
  type PlaidJwk,
  type ProviderName,
  type WebhookVerifier,
} from './inbox';

// ---------------------------------------------------------------------------
// 1. The integration catalogue — the single source of truth
// ---------------------------------------------------------------------------

/** A bag of environment variables. `process.env` satisfies it. */
export type EnvBag = Readonly<Record<string, string | undefined>>;

export interface WebhookIntegration {
  /** Path segment: POST /api/webhooks/<provider>. Also the inbox's `provider`. */
  readonly provider: ProviderName;
  readonly label: string;
  readonly purpose: string;
  /**
   * The env var holding this provider's API key. If it is absent the
   * integration is `not_configured` on /api/health — never `live`. Requirement
   * 6's rule lives here, in the catalogue, rather than in the health route,
   * because a rule stated once cannot disagree with itself.
   */
  readonly apiKeyEnv: string;
  /**
   * Every env var that must be present before an inbound delivery from this
   * provider can be verified. Absent => no verifier is registered => the route
   * answers 503, because a webhook we cannot authenticate must not be accepted.
   */
  readonly verificationEnv: readonly string[];
  /** Built only when every `verificationEnv` key is present. */
  readonly makeVerifier: (env: EnvBag) => WebhookVerifier;
}

/**
 * Every provider, in one list.
 *
 * Adding a sixth is one entry here plus a consumer registration in dispatch.
 * No route file, no migration: the route is `[provider]`, and `provider` is a
 * plain text column (see webhooks/README §6).
 */
export const WEBHOOK_INTEGRATIONS: readonly WebhookIntegration[] = [
  {
    provider: 'lithic',
    label: 'Lithic',
    purpose: 'card issuing — authorisations and clearings',
    apiKeyEnv: 'LITHIC_API_KEY',
    verificationEnv: ['LITHIC_WEBHOOK_SECRET'],
    makeVerifier: (env) => lithicVerifier({ secret: mustRead(env, 'LITHIC_WEBHOOK_SECRET') }),
  },
  {
    provider: 'persona',
    label: 'Persona',
    purpose: 'KYB / KYC — inquiry and case status',
    apiKeyEnv: 'PERSONA_API_KEY',
    verificationEnv: ['PERSONA_WEBHOOK_SECRET'],
    makeVerifier: (env) => personaVerifier({ secret: mustRead(env, 'PERSONA_WEBHOOK_SECRET') }),
  },
  {
    provider: 'plaid',
    label: 'Plaid',
    purpose: 'open banking — account funding and item health',
    apiKeyEnv: 'PLAID_SECRET',
    // Plaid has no shared webhook secret: verification is an ES256 JWT checked
    // against a key fetched from Plaid itself, which needs the API credentials.
    verificationEnv: ['PLAID_CLIENT_ID', 'PLAID_SECRET'],
    makeVerifier: (env) =>
      plaidVerifier({
        fetchVerificationKey: plaidVerificationKeyFetcher(env),
        expectedEnvironment: plaidEnvironment(env),
      }),
  },
  {
    provider: 'increase',
    label: 'Increase',
    purpose: 'ACH — transfer lifecycle and returns',
    apiKeyEnv: 'INCREASE_API_KEY',
    verificationEnv: ['INCREASE_WEBHOOK_SECRET'],
    makeVerifier: (env) => increaseVerifier({ secret: mustRead(env, 'INCREASE_WEBHOOK_SECRET') }),
  },
  {
    provider: 'stripe',
    label: 'Stripe',
    purpose: 'collections — the fifth provider, proving the registry is generic',
    apiKeyEnv: 'STRIPE_SECRET_KEY',
    verificationEnv: ['STRIPE_WEBHOOK_SECRET'],
    makeVerifier: (env) => stripeVerifier({ secret: mustRead(env, 'STRIPE_WEBHOOK_SECRET') }),
  },
];

/** Path segments we route, in catalogue order. */
export const WEBHOOK_PROVIDERS: readonly ProviderName[] = WEBHOOK_INTEGRATIONS.map(
  (i) => i.provider,
);

export function findIntegration(provider: string): WebhookIntegration | undefined {
  return WEBHOOK_INTEGRATIONS.find((i) => i.provider === provider);
}

export function webhookPathFor(provider: ProviderName): string {
  return `/api/webhooks/${provider}`;
}

// ---------------------------------------------------------------------------
// 2. Integration status — read by /api/health, derived from the same catalogue
// ---------------------------------------------------------------------------

/**
 * `live` means: every credential this integration needs is present, so the
 * route will verify and accept its deliveries. It does NOT mean we have just
 * pinged the provider — that is why `evidence` says what was actually checked.
 * Anything less than every credential present is `not_configured`, never
 * `live`, and never `degraded`: a missing key is a deployment fact, not a
 * transient one.
 */
export type IntegrationStatus = 'live' | 'not_configured';

export interface IntegrationReport {
  readonly provider: ProviderName;
  readonly label: string;
  readonly purpose: string;
  readonly status: IntegrationStatus;
  readonly webhookPath: string;
  /** True once a verifier is registered, i.e. the route will not answer 503. */
  readonly webhookVerifierRegistered: boolean;
  /** Env var NAMES that are absent. Never values — this is a public endpoint. */
  readonly missingEnv: readonly string[];
  readonly evidence: 'credentials_present' | 'credentials_missing';
}

/** Per-provider status for /api/health. Pure: reads env, touches no network. */
export function integrationReports(env: EnvBag = process.env): IntegrationReport[] {
  return WEBHOOK_INTEGRATIONS.map((integration) => {
    const required = [integration.apiKeyEnv, ...integration.verificationEnv];
    const missingEnv = [...new Set(required)].filter((key) => readEnv(env, key) === undefined);
    const live = missingEnv.length === 0;
    return {
      provider: integration.provider,
      label: integration.label,
      purpose: integration.purpose,
      status: live ? 'live' : 'not_configured',
      webhookPath: webhookPathFor(integration.provider),
      webhookVerifierRegistered: integration.verificationEnv.every(
        (key) => readEnv(env, key) !== undefined,
      ),
      missingEnv,
      evidence: live ? 'credentials_present' : 'credentials_missing',
    };
  });
}

// ---------------------------------------------------------------------------
// 3. Wiring: the verifier registry and the inbox store
// ---------------------------------------------------------------------------

/**
 * Build a registry from the catalogue. A provider whose verification
 * credentials are missing is deliberately NOT registered: half-verified is not
 * a state this system has, and an endpoint that cannot authenticate its caller
 * must not write to the inbox.
 */
export function buildVerifierRegistry(env: EnvBag = process.env): VerifierRegistry {
  const registry = new VerifierRegistry();
  for (const integration of WEBHOOK_INTEGRATIONS) {
    const ready = integration.verificationEnv.every((key) => readEnv(env, key) !== undefined);
    if (!ready) continue;
    registry.register(integration.makeVerifier(env));
  }
  return registry;
}

let registryCache: { env: EnvBag; registry: VerifierRegistry } | null = null;

/** Process-wide registry, rebuilt only when handed a different env bag. */
export function verifierRegistryFor(env: EnvBag = process.env): VerifierRegistry {
  if (registryCache && registryCache.env === env) return registryCache.registry;
  const registry = buildVerifierRegistry(env);
  registryCache = { env, registry };
  return registry;
}

let storeCache: { url: string; store: InboxStore } | null = null;

/**
 * The inbox store, backed by Postgres as the RESTRICTED `corgi_app` role.
 *
 * `APP_DATABASE_URL` only, with no fallback to `DATABASE_URL`. DECISIONS 008:
 * privileges never bind the table owner, so connecting as the owner silently
 * voids the ledger's immutability guarantee. A missing `APP_DATABASE_URL` is a
 * broken deployment, and the right answer to a webhook we cannot store is 500
 * so the provider retries once someone fixes it — not a quiet downgrade to a
 * connection that can UPDATE money rows.
 */
export function inboxStoreFor(env: EnvBag = process.env): InboxStore {
  const url = readEnv(env, 'APP_DATABASE_URL');
  if (url === undefined) {
    throw new Error(
      'APP_DATABASE_URL is not set. The application connects as the restricted corgi_app role; it never uses DATABASE_URL (owner) at runtime — see DECISIONS 008.',
    );
  }
  if (storeCache && storeCache.url === url) return storeCache.store;
  const sql = postgres(url, {
    max: 3,
    // Neon's pooled endpoint runs pgbouncer in transaction mode, which has no
    // session to hold a prepared statement in.
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 30,
    onnotice: () => {},
  });
  const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));
  storeCache = { url, store };
  return store;
}

// ---------------------------------------------------------------------------
// 4. The handler
// ---------------------------------------------------------------------------

/**
 * The minimum a route handler needs from the request. Structural rather than
 * `NextRequest` so the tests can pass an object whose `json()` throws and prove
 * this module never calls it.
 */
export interface WebhookHttpRequest {
  text(): Promise<string>;
  headers: Headers;
}

export interface WebhookRouteOptions {
  store?: InboxStore | undefined;
  registry?: VerifierRegistry | undefined;
  env?: EnvBag | undefined;
  now?: (() => Date) | undefined;
  log?: Logger | undefined;
}

/** What the log line and the README's table call this delivery. */
export type WebhookOutcome =
  | 'accepted'
  | 'replay'
  | 'unparseable'
  | 'signature_invalid'
  | 'unusable'
  | 'unknown_provider'
  | 'not_configured'
  | 'inbox_unavailable';

export async function handleWebhookRequest(
  req: WebhookHttpRequest,
  provider: string,
  options: WebhookRouteOptions = {},
): Promise<Response> {
  const startedAt = Date.now();
  const env = options.env ?? process.env;
  const requestId = requestIdFrom(req.headers);
  const log =
    options.log ??
    logger({ requestId, base: { route: 'POST /api/webhooks/[provider]', provider } });

  const finish = (
    httpStatus: number,
    outcome: WebhookOutcome,
    verified: boolean,
    body: Record<string, unknown>,
    logFields: Record<string, unknown> = {},
  ): Response => {
    const durationMs = Date.now() - startedAt;
    const line = {
      provider,
      eventId: (body['providerEventId'] as string | undefined) ?? null,
      verified,
      outcome,
      httpStatus,
      durationMs,
      ...logFields,
    };
    // Requirement 7: one line per request, always, whatever happened.
    if (httpStatus >= 500) log.error('webhook.request', line);
    else if (httpStatus >= 400) log.warn('webhook.request', line);
    else log.info('webhook.request', line);
    return jsonResponse(httpStatus, requestId, { ...body, durationMs });
  };

  // --- Provider validation, before the body is touched --------------------
  //
  // The path segment is validated against the VERIFIER REGISTRY, not against a
  // string list: if there is no verifier there is no way to authenticate the
  // caller, so there is nothing to do with the bytes. An unrecognised segment
  // is a 404 and can never become a 500, because nothing is constructed from
  // it — it is only ever a Map lookup.
  const registry = options.registry ?? verifierRegistryFor(env);
  if (registry.get(provider) === undefined) {
    const known = findIntegration(provider) !== undefined;
    if (!known) {
      return finish(404, 'unknown_provider', false, {
        error: {
          code: 'UNKNOWN_PROVIDER',
          message: `no webhook endpoint for '${sanitiseProvider(provider)}'`,
        },
      });
    }
    // Known provider, missing credentials. 503 rather than 404 on purpose:
    // 404 tells a real provider to give up on an event we simply cannot verify
    // yet, and the event is then gone. 503 is retryable, so the delivery
    // survives a deploy that forgot a secret. Still never a 500 — nothing
    // threw; this is a configuration fact we know and can state.
    return finish(503, 'not_configured', false, {
      error: {
        code: 'WEBHOOK_PROVIDER_NOT_CONFIGURED',
        message: `webhooks for '${provider}' are not configured on this deployment`,
      },
      retryable: true,
    });
  }

  // --- Verify -> persist -> return. No dispatch, no ledger, no consumer. ---
  //
  // Requirement 3: Plaid fails a delivery that has not been answered within 10
  // seconds and then retries for 24 hours. Everything after the INSERT happens
  // out of band in dispatch.ts, driven by cron — there is deliberately no
  // `after()` nudge here, because a nudge that usually runs is a delivery
  // mechanism people start to rely on.
  let result: IngestResult;
  try {
    const store = options.store ?? inboxStoreFor(env);
    result = await ingestWebhook(provider, req, {
      store,
      registry,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  } catch (error) {
    // The inbox write failed (or the store could not be built). 500 so the
    // provider retries: we have accepted responsibility for nothing, and the
    // only honest answer is "come back". The error text stays in the log; the
    // response says nothing about our database to an unauthenticated caller.
    return finish(
      500,
      'inbox_unavailable',
      false,
      {
        error: {
          code: 'WEBHOOK_INBOX_UNAVAILABLE',
          message: 'could not record the event; please retry',
        },
        retryable: true,
      },
      { error },
    );
  }

  return respondTo(result, finish);
}

/**
 * The failure table from `src/app/api/webhooks/README.md`, as code. One switch,
 * total over `IngestResult`, so the documented mapping and the implemented one
 * cannot drift.
 */
function respondTo(
  result: IngestResult,
  finish: (
    httpStatus: number,
    outcome: WebhookOutcome,
    verified: boolean,
    body: Record<string, unknown>,
    logFields?: Record<string, unknown>,
  ) => Response,
): Response {
  switch (result.status) {
    case 'accepted':
      return finish(
        202,
        'accepted',
        true,
        {
          status: 'accepted',
          inboxId: result.id,
          providerEventId: result.providerEventId,
          eventType: result.eventType,
          message: 'stored; processing happens out of band',
        },
        { eventType: result.eventType, inboxId: result.id },
      );

    case 'replay':
      // 200, NEVER 409. A provider that gets a 4xx on a replay retries the
      // replay, for ever. The duplicate was refused by the unique index, so
      // nothing was reprocessed and there is nothing to report but the fact.
      return finish(
        200,
        'replay',
        true,
        {
          status: 'replay',
          replay: true,
          inboxId: result.id,
          providerEventId: result.providerEventId,
          message: 'duplicate delivery: this event was already accepted, nothing was reprocessed',
        },
        { inboxId: result.id },
      );

    case 'dead_on_arrival':
      // Signature verified, body will not parse. Should be impossible: it means
      // the provider signed bytes that are not JSON. The row is filed with its
      // raw bytes (evidence we do not throw away) and the status is 400,
      // because the request really is malformed and no retry can fix it. The
      // inbox library would answer 202 here; see README, "Where this diverges".
      return finish(
        400,
        'unparseable',
        true,
        {
          error: {
            code: 'WEBHOOK_BODY_UNPARSEABLE',
            message: 'signature verified but the body is not valid JSON',
            details: { reason: result.reason },
          },
          status: 'dead_on_arrival',
          filed: true,
          inboxId: result.id,
          providerEventId: result.providerEventId,
        },
        { inboxId: result.id, reason: result.reason },
      );

    case 'rejected':
      switch (result.httpStatus) {
        case 401:
          // Nothing persisted. The reason goes to the log, not to the caller:
          // whoever sent this has not authenticated, and "timestamp too old"
          // versus "no v1 signature matched" is free information for someone
          // probing the endpoint.
          return finish(
            401,
            'signature_invalid',
            false,
            {
              error: {
                code: 'WEBHOOK_SIGNATURE_INVALID',
                message: 'signature verification failed; nothing was stored',
              },
            },
            { reason: result.reason },
          );
        case 404:
          return finish(
            404,
            'unknown_provider',
            false,
            { error: { code: 'UNKNOWN_PROVIDER', message: 'no webhook endpoint for this provider' } },
            { reason: result.reason },
          );
        case 400:
        default:
          // Past verification, so this caller IS the provider and the reason is
          // safe (and useful) to hand back.
          return finish(
            400,
            'unusable',
            true,
            {
              error: {
                code: 'WEBHOOK_BODY_UNUSABLE',
                message: 'signature verified but the event could not be used',
                details: { reason: result.reason },
              },
            },
            { reason: result.reason },
          );
      }
  }
}

// ---------------------------------------------------------------------------
// 5. Small helpers
// ---------------------------------------------------------------------------

/**
 * Every response carries the request id, in the body and in a header, and none
 * of them are cacheable.
 */
export function jsonResponse(
  status: number,
  requestId: string,
  body: Record<string, unknown>,
): Response {
  return Response.json(
    { requestId, ...body },
    {
      status,
      headers: {
        'x-request-id': requestId,
        'cache-control': 'no-store',
      },
    },
  );
}

/** Trimmed, or undefined. An empty string is a missing value, not a value. */
export function readEnv(env: EnvBag, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function mustRead(env: EnvBag, key: string): string {
  const value = readEnv(env, key);
  if (value === undefined) throw new Error(`${key} is not set`);
  return value;
}

/** Never echo an unvalidated path segment back verbatim. */
function sanitiseProvider(provider: string): string {
  return provider.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || '(empty)';
}

function plaidEnvironment(env: EnvBag): 'sandbox' | 'production' {
  return readEnv(env, 'PLAID_ENV') === 'production' ? 'production' : 'sandbox';
}

/**
 * Fetch a Plaid webhook verification key by `kid`, cached per kid (Plaid's own
 * sample caches one key globally, which breaks on their first rotation).
 */
function plaidVerificationKeyFetcher(env: EnvBag): (kid: string) => Promise<PlaidJwk | null> {
  const clientId = mustRead(env, 'PLAID_CLIENT_ID');
  const secret = mustRead(env, 'PLAID_SECRET');
  const base =
    plaidEnvironment(env) === 'production'
      ? 'https://production.plaid.com'
      : 'https://sandbox.plaid.com';

  return cachedVerificationKeys(async (kid: string) => {
    const response = await fetch(`${base}/webhook_verification_key/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret, key_id: kid }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { key?: PlaidJwk };
    return body.key ?? null;
  });
}
