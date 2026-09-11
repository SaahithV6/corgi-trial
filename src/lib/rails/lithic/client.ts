/**
 * Lithic card rail — HTTP client.
 *
 * SERVER ONLY. This module reads `process.env.LITHIC_API_KEY`; it must never be
 * imported from a client component. (`server-only` is deliberately not imported
 * here so the module stays testable under vitest's node environment — the
 * route/service layer that consumes it should carry the `server-only` import.)
 *
 * No SDK. `fetch` plus `node:crypto` for idempotency keys, nothing else.
 *
 * EVERYTHING VERIFIED AGAINST THE LIVE SANDBOX IS MARKED [MEASURED].
 * See DECISIONS.md 004 and 006 for the measurements; ./README.md for the two
 * traps a consumer has to know about before touching `Transaction`.
 *
 * Auth: `Authorization: <key>` — the RAW key, no `Bearer`, no `Basic`, no
 * base64. That is what the official SDK sends and what the sandbox accepts.
 *
 * Every call is paced by ./ratelimit.ts. The sandbox simulate endpoints are
 * capped at 1 request/second and will 429 the moment two calls race.
 */

import { randomUUID } from 'node:crypto';

import { cardWriteLimiter, readLimiter, simulateLimiter, type RateLimiter } from './ratelimit';
import {
  assertCents,
  type Card,
  type Cents,
  type CreateCardParams,
  type ListCardsQuery,
  type ListTransactionsQuery,
  type LithicPage,
  type NormalizedTransaction,
  type NormalizedTransactionEvent,
  type SimulateAuthorizeParams,
  type SimulateAuthorizeResponse,
  type SimulateClearingParams,
  type SimulateClearingResponse,
  type SimulateReturnParams,
  type SimulateReturnResponse,
  type SimulateVoidParams,
  type SimulateVoidResponse,
  type Transaction,
  type TransactionEvent,
} from './types';

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration
 * ──────────────────────────────────────────────────────────────────────────── */

/** [MEASURED] Paths below are appended to this, so it already includes /v1. */
export const LITHIC_SANDBOX_BASE_URL = 'https://sandbox.lithic.com/v1';
export const LITHIC_PRODUCTION_BASE_URL = 'https://api.lithic.com/v1';

export interface LithicRequestOptions {
  /**
   * Overrides the API key. Omit in application code: the key is read from
   * `process.env.LITHIC_API_KEY` AT CALL TIME, so a key loaded after module
   * evaluation (or rotated in place) is picked up without a restart, and the
   * value is never captured in module scope where it could leak into a dump.
   */
  apiKey?: string;
  /** Defaults to `process.env.LITHIC_BASE_URL`, else the sandbox base URL. */
  baseUrl?: string;
  /** Per-attempt timeout. Defaults to 15s. */
  timeoutMs?: number;
  /** Caller cancellation, composed with the timeout. */
  signal?: AbortSignal;
  /** Injected for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override the limiter for this call. Defaults to the per-resource limiter. */
  limiter?: RateLimiter;
  /** See the idempotency note on `createCard`. */
  idempotencyKey?: string;
  /** Attempts after a 429, honouring `retry-after`. Defaults to 2. */
  maxRateLimitRetries?: number;
}

/** Thrown when the environment is not set up. Never contains the key itself. */
export class LithicConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LithicConfigError';
  }
}

/** A non-2xx from Lithic. */
export class LithicApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Lithic's own correlation id. Quote it to their support. */
  readonly debuggingRequestId: string | undefined;
  /** Present on 429; Lithic sends `retry-after: 1`. */
  readonly retryAfterSeconds: number | undefined;

  constructor(status: number, body: unknown, retryAfterSeconds?: number) {
    const message =
      body !== null && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `Lithic request failed with HTTP ${status}`;
    super(message);
    this.name = 'LithicApiError';
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
    this.debuggingRequestId =
      body !== null && typeof body === 'object' && 'debugging_request_id' in body
        ? String((body as { debugging_request_id: unknown }).debugging_request_id)
        : undefined;
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * Resolved at call time, never at import time. Throws rather than sending an
 * empty Authorization header, which the sandbox answers with an opaque 401.
 */
function resolveApiKey(options: LithicRequestOptions): string {
  const key = options.apiKey ?? process.env.LITHIC_API_KEY;
  if (!key) {
    throw new LithicConfigError(
      'LITHIC_API_KEY is not set. Add it to .env.local (server-side only) or pass ' +
        '{ apiKey } explicitly. The key is read at call time, not at import time.',
    );
  }
  return key;
}

function resolveBaseUrl(options: LithicRequestOptions): string {
  const base = options.baseUrl ?? process.env.LITHIC_BASE_URL ?? LITHIC_SANDBOX_BASE_URL;
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Transport
 * ──────────────────────────────────────────────────────────────────────────── */

interface RequestSpec {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
  limiter: RateLimiter;
  /** Sent as `Idempotency-Key` when present. */
  idempotencyKey?: string;
}

function buildQuery(query: Record<string, string | number | undefined> | undefined): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length > 0 ? `?${encoded}` : '';
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function lithicRequest<T>(spec: RequestSpec, options: LithicRequestOptions): Promise<T> {
  const apiKey = resolveApiKey(options);
  const url = `${resolveBaseUrl(options)}${spec.path}${buildQuery(spec.query)}`;
  const doFetch = options.fetchImpl ?? fetch;
  const limiter = options.limiter ?? spec.limiter;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const maxRetries = options.maxRateLimitRetries ?? 2;

  const headers: Record<string, string> = {
    // The RAW key. No Bearer. [MEASURED]
    Authorization: apiKey,
    Accept: 'application/json',
  };
  if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
  const idempotencyKey = options.idempotencyKey ?? spec.idempotencyKey;
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;

  for (let attempt = 0; ; attempt += 1) {
    // Re-acquired on every attempt: a retry is a fresh request as far as
    // Lithic's counter is concerned.
    const response = await limiter.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = (): void => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const init: RequestInit = {
        method: spec.method,
        headers,
        signal: controller.signal,
      };
      if (spec.body !== undefined) init.body = JSON.stringify(spec.body);
      try {
        return await doFetch(url, init);
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    });

    const text = await response.text();
    const parsed: unknown = text.length > 0 ? safeJsonParse(text) : undefined;

    if (response.ok) return parsed as T;

    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterSeconds = retryAfterHeader === null ? undefined : Number(retryAfterHeader);

    // 429 means the limiter's window drifted from Lithic's. Wait it out rather
    // than surfacing a spurious failure into the ledger.
    if (response.status === 429 && attempt < maxRetries) {
      const waitMs =
        retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)
          ? Math.max(retryAfterSeconds * 1000, 250)
          : 1_000 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }

    throw new LithicApiError(response.status, parsed ?? text, retryAfterSeconds);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cards
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `POST /v1/cards` — returns 200 (not 201) with the PCI shape in sandbox, i.e.
 * `pan` and `cvv` in the clear. Only the simulate path may read `pan`; persist
 * `token` and `last_four`.
 *
 * IDEMPOTENCY: `Idempotency-Key` is the one place Lithic documents native
 * idempotency support, so it is used here and one is generated if the caller
 * does not supply one. Supply your own (e.g. the ledger row id) whenever the
 * call can be retried — an auto-generated key protects against a transport
 * retry inside this function, not against your process retrying the operation.
 *
 * The simulate endpoints do NOT document idempotency support; see the
 * idempotency section of ./README.md for what to do instead.
 */
export async function createCard(
  params: CreateCardParams,
  options: LithicRequestOptions = {},
): Promise<Card> {
  const body: Record<string, unknown> = { type: params.type };
  if (params.account_token !== undefined) body.account_token = params.account_token;
  if (params.memo !== undefined) body.memo = params.memo;
  if (params.spend_limit !== undefined) body.spend_limit = assertCents(params.spend_limit, 'spend_limit');
  if (params.spend_limit_duration !== undefined) body.spend_limit_duration = params.spend_limit_duration;
  if (params.state !== undefined) body.state = params.state;
  if (params.exp_month !== undefined) body.exp_month = params.exp_month;
  if (params.exp_year !== undefined) body.exp_year = params.exp_year;
  if (params.card_program_token !== undefined) body.card_program_token = params.card_program_token;
  if (params.product_id !== undefined) body.product_id = params.product_id;

  return lithicRequest<Card>(
    {
      method: 'POST',
      path: '/cards',
      body,
      limiter: cardWriteLimiter,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    },
    options,
  );
}

/** `GET /v1/cards/{card_token}`. */
export async function getCard(
  cardToken: string,
  options: LithicRequestOptions = {},
): Promise<Card> {
  return lithicRequest<Card>(
    { method: 'GET', path: `/cards/${encodeURIComponent(cardToken)}`, limiter: readLimiter },
    options,
  );
}

/** `GET /v1/cards` — the non-PCI shape: no `pan`, no `cvv`, in any environment. */
export async function listCards(
  query: ListCardsQuery = {},
  options: LithicRequestOptions = {},
): Promise<LithicPage<Card>> {
  return lithicRequest<LithicPage<Card>>(
    { method: 'GET', path: '/cards', query: { ...query }, limiter: readLimiter },
    options,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `POST /v1/simulate/authorize`.
 *
 * [MEASURED] The request MUST carry `merchant_amount` whenever it carries
 * `merchant_currency` — sending the currency alone is rejected with
 * "'merchant_currency' requires that 'merchant_amount' is set". And the
 * currency cannot simply be dropped, because the simulator then defaults to
 * GBP. So both always go on the wire; `merchant_amount` mirrors `amount`
 * unless the caller specifies otherwise.
 *
 * [MEASURED] `status`:
 *   'AUTHORIZATION'           two-message. Creates a hold. Needs a clearing.
 *   'FINANCIAL_AUTHORIZATION' single-message. Settles immediately, no hold.
 *
 * [MEASURED] The response `token` identifies the WHOLE transaction lifecycle —
 * it is the key for clearing, void, and `getTransaction`. A decline also
 * returns a token, so never treat its presence as approval: read the resulting
 * transaction.
 */
export async function simulateAuthorize(
  params: SimulateAuthorizeParams,
  options: LithicRequestOptions = {},
): Promise<SimulateAuthorizeResponse> {
  const amount = assertCents(params.amount, 'amount');
  if (amount < 0) throw new RangeError('simulateAuthorize amount must be >= 0');
  if (params.descriptor.length === 0 || params.descriptor.length > 25) {
    throw new RangeError('descriptor must be 1–25 characters');
  }

  const merchantAmount = assertCents(params.merchant_amount ?? amount, 'merchant_amount');

  const body: Record<string, unknown> = {
    amount,
    // Both, always. Neither one is safe alone.
    merchant_amount: merchantAmount,
    merchant_currency: params.merchant_currency ?? 'USD',
    descriptor: params.descriptor,
    pan: params.pan,
    status: params.status ?? 'AUTHORIZATION',
  };
  if (params.mcc !== undefined) body.mcc = params.mcc;
  if (params.merchant_acceptor_id !== undefined) body.merchant_acceptor_id = params.merchant_acceptor_id;
  if (params.merchant_acceptor_city !== undefined) body.merchant_acceptor_city = params.merchant_acceptor_city;
  if (params.merchant_acceptor_state !== undefined) body.merchant_acceptor_state = params.merchant_acceptor_state;
  if (params.merchant_acceptor_country !== undefined) {
    body.merchant_acceptor_country = params.merchant_acceptor_country;
  }
  if (params.partial_approval_capable !== undefined) {
    body.partial_approval_capable = params.partial_approval_capable;
  }
  if (params.pin !== undefined) body.pin = params.pin;

  return lithicRequest<SimulateAuthorizeResponse>(
    { method: 'POST', path: '/simulate/authorize', body, limiter: simulateLimiter },
    options,
  );
}

/**
 * `POST /v1/simulate/clearing` — body is `{ token, amount? }`.
 *
 * [MEASURED] Omit `amountCents` to clear the full authorised amount. Partial
 * clearings, over-captures and repeat clearings against one authorisation all
 * work; each call appends a separate CLEARING event.
 *
 * [MEASURED] The response carries no token. A clearing is an event on the
 * existing transaction, not a new object — re-read the transaction to see it.
 *
 * [MEASURED] After a PARTIAL clearing the transaction reads `status: SETTLED`
 * with a hold still outstanding. Do not release the hold here. Feed the
 * re-read transaction through `normalizeTransaction`.
 */
export async function simulateClearing(
  params: SimulateClearingParams,
  options: LithicRequestOptions = {},
): Promise<SimulateClearingResponse> {
  const body: Record<string, unknown> = { token: params.token };
  if (params.amountCents !== undefined) {
    const amount = assertCents(params.amountCents, 'amountCents');
    if (amount <= 0) {
      throw new RangeError(
        'simulateClearing amountCents must be > 0. To clear the full authorised ' +
          'amount, omit amountCents entirely.',
      );
    }
    body.amount = amount;
  }

  return lithicRequest<SimulateClearingResponse>(
    { method: 'POST', path: '/simulate/clearing', body, limiter: simulateLimiter },
    options,
  );
}

/**
 * `POST /v1/simulate/void` — body is `{ token, amount?, type? }`.
 *
 * ⚠ THIS ENDPOINT DID NOT TAKE EFFECT IN OUR SANDBOX MEASUREMENT. It answered
 * HTTP 200 with a `debugging_request_id` and left the transaction PENDING with
 * the hold unchanged at -3000. Read the "Void" section of ./README.md before
 * relying on it. The client does three things about that:
 *
 *  1. `amount` is OMITTED from the JSON when `amountCents` is undefined — never
 *     sent as `null` or `0`. Lithic's field doc says "if amount is not set, the
 *     full amount will be voided", while Lithic's own sample body sends
 *     `{"amount": 0}`. `minimum: 0` in the schema means a literal zero is a
 *     valid request, so `{"amount": 0}` is very plausibly a successful void of
 *     nothing — exactly the 200-with-no-effect that was observed.
 *  2. `amountCents: 0` is REJECTED here rather than forwarded, so that a
 *     zero-void no-op can never happen silently.
 *  3. `simulateVoidAndVerify` re-reads the transaction and reports whether the
 *     hold actually moved, so a no-op surfaces as data instead of as an
 *     assumption.
 *
 * [DOCS] Constraints: the authorisation must be pending. "Can be used on
 * partially voided transactions but not partially cleared transactions" — so
 * once ANY clearing has landed, a void is expected to be a no-op or an error.
 */
export async function simulateVoid(
  params: SimulateVoidParams,
  options: LithicRequestOptions = {},
): Promise<SimulateVoidResponse> {
  const body: Record<string, unknown> = { token: params.token };
  if (params.amountCents !== undefined) {
    const amount = assertCents(params.amountCents, 'amountCents');
    if (amount <= 0) {
      throw new RangeError(
        'simulateVoid amountCents must be > 0. A zero-amount void is accepted by ' +
          'Lithic and voids nothing — omit amountCents to void the full pending amount.',
      );
    }
    body.amount = amount;
  }
  if (params.type !== undefined) body.type = params.type;

  return lithicRequest<SimulateVoidResponse>(
    { method: 'POST', path: '/simulate/void', body, limiter: simulateLimiter },
    options,
  );
}

export interface VoidVerification {
  response: SimulateVoidResponse;
  before: NormalizedTransaction;
  after: NormalizedTransaction;
  /** Did the hold actually move? False ⇒ the void was accepted but did nothing. */
  tookEffect: boolean;
  /** Positive number of cents the hold fell by. Zero when `tookEffect` is false. */
  holdReleasedCents: Cents;
}

/**
 * Void, then prove it. Costs three rate-limited calls (~3s in sandbox), so it
 * is not the default path — use it in the seed script and in any test that
 * asserts a void worked, and check `tookEffect` rather than the HTTP status.
 *
 * This exists because the endpoint returned success and changed nothing. A
 * provider call that reports success without doing anything is exactly the
 * failure a ledger must never absorb quietly.
 */
export async function simulateVoidAndVerify(
  params: SimulateVoidParams,
  options: LithicRequestOptions = {},
): Promise<VoidVerification> {
  const before = normalizeTransaction(await getTransaction(params.token, options));
  const response = await simulateVoid(params, options);
  const after = normalizeTransaction(await getTransaction(params.token, options));
  const holdReleasedCents = Math.max(before.holdCents - after.holdCents, 0);
  return {
    response,
    before,
    after,
    tookEffect: holdReleasedCents > 0 || after.providerStatus === 'VOIDED',
    holdReleasedCents,
  };
}

/**
 * `POST /v1/simulate/return` — body is `{ amount, descriptor, pan }`.
 *
 * [DOCS] Keyed by PAN, not by transaction token: a return is a NEW, independent
 * credit transaction that clears immediately to SETTLED with no prior
 * authorisation. It returns its own token, unrelated to the original purchase.
 * Attributing a refund to the sale it reverses is the ledger's job.
 */
export async function simulateReturn(
  params: SimulateReturnParams,
  options: LithicRequestOptions = {},
): Promise<SimulateReturnResponse> {
  const amount = assertCents(params.amount, 'amount');
  if (amount <= 0) throw new RangeError('simulateReturn amount must be > 0');
  if (params.descriptor.length === 0 || params.descriptor.length > 25) {
    throw new RangeError('descriptor must be 1–25 characters');
  }

  return lithicRequest<SimulateReturnResponse>(
    {
      method: 'POST',
      path: '/simulate/return',
      body: { amount, descriptor: params.descriptor, pan: params.pan },
      limiter: simulateLimiter,
    },
    options,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Transactions
 * ──────────────────────────────────────────────────────────────────────────── */

/** `GET /v1/transactions/{transaction_token}` — includes the `events[]` array. */
export async function getTransaction(
  transactionToken: string,
  options: LithicRequestOptions = {},
): Promise<Transaction> {
  return lithicRequest<Transaction>(
    {
      method: 'GET',
      path: `/transactions/${encodeURIComponent(transactionToken)}`,
      limiter: readLimiter,
    },
    options,
  );
}

/**
 * `getTransaction`, but tolerant of the provider's read-after-write delay.
 *
 * `POST /v1/simulate/authorize` answers `201 {token}` BEFORE the transaction is
 * readable, and everything keyed on that token — this endpoint and
 * `/v1/simulate/clearing` alike — answers **404 until it is**. The token is
 * valid the whole time; the caller is simply early.
 *
 * Measured on the sandbox, six trials each, polling every 200ms from the
 * authorize response:
 *
 *   AUTHORISATION APPROVED    969  1166  1177  1184  1450  1759 ms   mean 1284
 *   AUTHORISATION DECLINED    781   788   829   875  1047  1051 ms   mean  895
 *
 * An approved authorisation takes ~390ms longer to surface, because it has a
 * pending transaction and a hold to create. `simulateLimiter` paces the next
 * call to ~1100-1200ms, which is past the far tail of the declined
 * distribution and through the MIDDLE of the approved one — so this race was
 * always present and the declined era was simply on the safe side of it. It
 * became visible the day the spend cap was raised and authorisations started
 * approving, which looked like a regression and was a distribution shift.
 *
 * This lives here so the next call site does not have to know any of that.
 *
 * Two deliberate properties:
 *
 *   - It retries ONLY on 404. Any other status rethrows immediately, because a
 *     401 or a 500 is not a delay and waiting on one hides it.
 *   - It fails HARD at the deadline rather than returning null. A token still
 *     dark after 30s is a different fault from a slow one, and a longer wait
 *     must not paper over it — the throw quotes the measurement above so
 *     whoever reads it knows what normal looks like.
 */
export async function getTransactionWhenVisible(
  transactionToken: string,
  options: LithicRequestOptions & { timeoutMs?: number; pollMs?: number } = {},
): Promise<Transaction> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 250;
  const startedAt = Date.now();
  for (;;) {
    try {
      return await getTransaction(transactionToken, options);
    } catch (error) {
      const notYetVisible = error instanceof LithicApiError && error.status === 404;
      if (!notYetVisible) throw error;
      const waited = Date.now() - startedAt;
      if (waited >= timeoutMs) {
        throw new Error(
          `transaction ${transactionToken} was still not readable after ${waited}ms. ` +
            `Lithic makes a simulated authorisation visible in roughly 0.8-1.8s ` +
            `(approved runs ~390ms behind declined), so this is not the ordinary ` +
            `read-after-write delay and should not be waited out further.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/** `GET /v1/transactions`. List rows may omit `events[]`; re-read by token for the lifecycle. */
export async function listTransactions(
  query: ListTransactionsQuery = {},
  options: LithicRequestOptions = {},
): Promise<LithicPage<Transaction>> {
  return lithicRequest<LithicPage<Transaction>>(
    { method: 'GET', path: '/transactions', query: { ...query }, limiter: readLimiter },
    options,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Event subscriptions — the webhook registration, read back from Lithic
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A registered webhook endpoint, as Lithic holds it.
 *
 * [MEASURED] `GET /v1/event_subscriptions -> 200`:
 *
 *   {"data":[{"description":"Corgi work trial - card auth and clearing",
 *             "token":"ep_3J8yb9…","event_types":null,"disabled":false,
 *             "url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic",
 *             "version":null}],"has_more":false}
 *
 * `event_types: null` means "every event type", not "none".
 */
export interface EventSubscription {
  token: string;
  url: string;
  /** Lithic sends `disabled`, not `enabled`. A disabled subscription delivers nothing. */
  disabled: boolean;
  description?: string | null;
  event_types?: string[] | null;
  version?: number | null;
}

/**
 * [MEASURED] The four values seen on the `status` field, and the two that are
 * NOT terminal. `PENDING` and `SENDING` are a delivery still in flight; only
 * `SUCCESS` and `FAILED` are outcomes.
 */
export type EventSubscriptionAttemptStatus = 'FAILED' | 'PENDING' | 'SENDING' | 'SUCCESS';

/**
 * One delivery attempt Lithic made to a subscription's URL, with the HTTP
 * status our endpoint answered. This is the provider's own record of the
 * inbound leg — the half of the webhook loop nothing on our side of the wire
 * can otherwise see.
 *
 * [MEASURED] a success and a failure from our own history:
 *
 *   {"created":"2026-09-10T18:40:36.424Z","status":"SUCCESS",
 *    "response_status_code":202,"response":"{\"status\":\"accepted\",…}",
 *    "url":"https://corgi-trial-psi.vercel.app/api/webhooks/lithic", …}
 *
 *   {"created":"2026-09-10T16:18:47.680Z","status":"FAILED",
 *    "response_status_code":500,
 *    "response":"{\"error\":{\"code\":\"WEBHOOK_INBOX_UNAVAILABLE\",…}}", …}
 *
 * That 500 pair is the inbox bug of DECISIONS 020, recorded by Lithic and
 * recovered by its retry. It is the exact shape a probe has to be able to see.
 */
export interface EventSubscriptionAttempt {
  token: string;
  event_subscription_token: string;
  event_token: string;
  url: string;
  status: EventSubscriptionAttemptStatus;
  /** Null when the attempt never got an HTTP response at all. */
  response_status_code: number | null;
  /** Our endpoint's response body, verbatim, as a string. */
  response?: string;
  created: string;
}

/** `GET /v1/event_subscriptions` — every webhook endpoint registered on the account. */
export async function listEventSubscriptions(
  query: { page_size?: number } = {},
  options: LithicRequestOptions = {},
): Promise<LithicPage<EventSubscription>> {
  return lithicRequest<LithicPage<EventSubscription>>(
    { method: 'GET', path: '/event_subscriptions', query: { ...query }, limiter: readLimiter },
    options,
  );
}

/**
 * `GET /v1/event_subscriptions/{token}/attempts` — delivery history, NEWEST
 * FIRST. [MEASURED] ordering, and `?status=` filtering by attempt status.
 *
 * [MEASURED] An unknown subscription token answers `404 {"message":"endpoint
 * not found"}`, which is a different message from the account-level 404 and is
 * about the subscription, not the route.
 */
export async function listEventSubscriptionAttempts(
  subscriptionToken: string,
  query: { page_size?: number; status?: EventSubscriptionAttemptStatus } = {},
  options: LithicRequestOptions = {},
): Promise<LithicPage<EventSubscriptionAttempt>> {
  return lithicRequest<LithicPage<EventSubscriptionAttempt>>(
    {
      method: 'GET',
      path: `/event_subscriptions/${encodeURIComponent(subscriptionToken)}/attempts`,
      query: { ...query },
      limiter: readLimiter,
    },
    options,
  );
}


/* ────────────────────────────────────────────────────────────────────────────
 * Normalisation — the whole point of this adapter
 * ──────────────────────────────────────────────────────────────────────────── */

/** Absolute magnitude, defensive against a missing or non-numeric field. */
function absCents(value: number | null | undefined): Cents {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.abs(Math.trunc(value));
}

/** The best available amount for one event, as a positive magnitude. */
function eventAmountCents(event: TransactionEvent): Cents {
  const settlement = event.amounts?.settlement?.amount;
  if (typeof settlement === 'number' && Number.isFinite(settlement)) return absCents(settlement);
  return absCents(event.amount);
}

function normalizeEvent(event: TransactionEvent): NormalizedTransactionEvent {
  const normalized: NormalizedTransactionEvent = {
    type: event.type,
    amountCents: eventAmountCents(event),
    polarity: event.effective_polarity ?? 'UNKNOWN',
  };
  if (event.token !== undefined) normalized.token = event.token;
  if (event.created !== undefined) normalized.created = event.created;
  return normalized;
}

/**
 * Recompute the outstanding hold from the event set alone:
 *
 *     H(E) = max( authorised(E) − released(E), 0 )
 *
 * where `authorised` is the last ADVICE amount if any advice exists (an advice
 * OVERRIDES the amount, it is not a delta) and otherwise the sum of the
 * hold-opening authorisations, and `released` is the sum of the clearings,
 * reversals and expiries.
 *
 * This reproduces every measured case:
 *   auth 1000, clr 600            -> max(1000 − 600, 0)  = 400
 *   auth 1000, clr 600, clr 300   -> max(1000 − 900, 0)  = 100
 *   auth 5000, clr 7340           -> max(5000 − 7340, 0) = 0     (over-capture)
 *   FINANCIAL_AUTHORIZATION 2500  -> 0                           (never held)
 *
 * It agrees with `amounts.hold.amount` in all of them, and — unlike `status` —
 * it is derived from what actually happened rather than from a message-flow
 * marker. When the two disagree, that disagreement is itself the signal.
 */
function deriveHoldFromEvents(events: ReadonlyArray<TransactionEvent>): Cents {
  let authorised = 0;
  let sawAdvice = false;
  let released = 0;

  for (const event of events) {
    const amount = eventAmountCents(event);
    switch (event.type) {
      case 'AUTHORIZATION':
      case 'CREDIT_AUTHORIZATION':
        // Advice wins outright, so ignore the original once one has arrived.
        if (!sawAdvice) authorised += amount;
        break;
      case 'AUTHORIZATION_ADVICE':
      case 'CREDIT_AUTHORIZATION_ADVICE':
        // Absolute override, and the LAST one is the live figure.
        sawAdvice = true;
        authorised = amount;
        break;
      case 'CLEARING':
      case 'AUTHORIZATION_REVERSAL':
      case 'AUTHORIZATION_EXPIRY':
        released += amount;
        break;
      default:
        // BALANCE_INQUIRY, FINANCIAL_*, RETURN*, CORRECTION_*: never hold.
        break;
    }
  }

  return Math.max(authorised - released, 0);
}

/**
 * Turn a raw Lithic transaction into something a ledger can safely consume.
 *
 * TRAP 1 — `status` LIES ABOUT THE HOLD. [MEASURED] a partial clearing flips
 * `status` to SETTLED while the hold is still outstanding:
 *
 *     auth 1000            status PENDING   hold -1000  settlement 0
 *     clearing 600         status SETTLED   hold  -400  settlement -600
 *     clearing 300         status SETTLED   hold  -100  settlement -900
 *
 * `providerSaysSettled` is exposed and is explicitly NOT a hold-release
 * predicate. Releasing on `status === 'SETTLED'` — the obvious implementation —
 * frees 400 cents that are still authorised. Use `hasOutstandingHold`.
 *
 * TRAP 2 — `amounts.hold.amount` IS SIGNED NEGATIVE. [MEASURED] a 1000-cent
 * debit hold reads -1000. A naive read gets the direction of the money wrong as
 * well as the amount. `holdCents` and `settledCents` are positive magnitudes;
 * direction lives in each event's `polarity` and in the transaction type.
 *
 * The raw provider fields are preserved verbatim under `raw` — this normalises
 * for consumers without hiding what the provider actually said.
 *
 * Pure function. No I/O, no clock, no rate limiting. Safe to call on a webhook
 * payload (`card_transaction.updated` delivers the full Transaction).
 */
export function normalizeTransaction(txn: Transaction): NormalizedTransaction {
  const events = txn.events ?? [];
  const holdCents = absCents(txn.amounts?.hold?.amount);
  const settledCents = absCents(txn.amounts?.settlement?.amount);
  const eventDerivedHoldCents = deriveHoldFromEvents(events);

  return {
    token: txn.token,
    providerStatus: txn.status,
    // Exposed because the reconciliation UI must show what the provider claims.
    // NOT a hold-release predicate. See TRAP 1.
    providerSaysSettled: txn.status === 'SETTLED',
    holdCents,
    settledCents,
    events: events.map(normalizeEvent),
    eventDerivedHoldCents,
    // Only meaningful when the events came back at all; a list row without
    // events cannot disagree with anything.
    holdMatchesEvents: events.length === 0 ? true : eventDerivedHoldCents === holdCents,
    hasOutstandingHold: holdCents > 0,
    raw: {
      status: txn.status,
      ...(txn.result !== undefined ? { result: txn.result } : {}),
      holdAmount: txn.amounts?.hold?.amount ?? null,
      settlementAmount: txn.amounts?.settlement?.amount ?? null,
      holdCurrency: txn.amounts?.hold?.currency ?? null,
      settlementCurrency: txn.amounts?.settlement?.currency ?? null,
    },
  };
}

export { RateLimiter, cardWriteLimiter, readLimiter, simulateLimiter } from './ratelimit';
