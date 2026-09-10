/**
 * Lithic sandbox adapter — DRAFT
 * ==============================
 *
 * Self-contained. No SDK dependency. `fetch` + Node's `crypto` only.
 *
 * All money is INTEGER CENTS (`number`). Never a float, never a string.
 * Lithic's own API is integer-cents throughout, so there is no conversion layer.
 *
 * Every endpoint path, field name, and enum value below was read from Lithic's
 * published OpenAPI spec (https://docs.lithic.com/reference/<op>.md) and the
 * generated `lithic-node` SDK source. Anything I could not confirm from an
 * official source is marked `// UNVERIFIED:`.
 *
 * See ./NOTES.md for the operational detail behind each choice.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/* ────────────────────────────────────────────────────────────────────────────
 * Config
 * ──────────────────────────────────────────────────────────────────────────── */

export const LITHIC_SANDBOX_BASE_URL = 'https://sandbox.lithic.com';
export const LITHIC_PRODUCTION_BASE_URL = 'https://api.lithic.com';

export interface LithicConfig {
  /** Sandbox API key — a bare UUID from https://app.lithic.com/settings */
  apiKey: string;
  /** Defaults to the sandbox base URL. */
  baseUrl?: string;
  /** Per-request timeout in ms. Defaults to 15_000. */
  timeoutMs?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Money
 * ──────────────────────────────────────────────────────────────────────────── */

/** Integer minor units (cents for USD). Positive = debit, negative = credit. */
export type Cents = number;

export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} exceeds safe integer range: ${value}`);
  }
  return value;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Errors
 * ──────────────────────────────────────────────────────────────────────────── */

export class LithicApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** Lithic's own correlation id — quote it to their support. */
  readonly debuggingRequestId?: string;
  /** Present on 429; Lithic sends `retry-after: "1"`. */
  readonly retryAfterSeconds?: number;

  constructor(status: number, body: unknown, retryAfterSeconds?: number) {
    const message =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message: unknown }).message)
        : `Lithic request failed with HTTP ${status}`;
    super(message);
    this.name = 'LithicApiError';
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
    if (body && typeof body === 'object' && 'debugging_request_id' in body) {
      this.debuggingRequestId = String((body as { debugging_request_id: unknown }).debugging_request_id);
    }
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Transport
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Auth header format, confirmed from the official SDK (`lithic-node`
 * `src/client.ts`: `buildHeaders([{ Authorization: this.apiKey }])`) and from
 * every curl sample in Lithic's docs:
 *
 *     Authorization: <api_key>
 *
 * The raw key. No `Bearer`, no `Basic`, no base64. (Lithic's Environments page
 * additionally documents `Authorization: Basic {api_key}` and `curl -u {key}:`
 * as accepted alternatives, but the raw form is canonical.)
 */
async function request<T>(
  cfg: LithicConfig,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const base = cfg.baseUrl ?? LITHIC_SANDBOX_BASE_URL;
  const headers: Record<string, string> = {
    Authorization: cfg.apiKey,
    Accept: 'application/json',
    ...extraHeaders,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 15_000);

  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    const parsed: unknown = text.length ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after');
      throw new LithicApiError(res.status, parsed ?? text, retryAfter ? Number(retryAfter) : undefined);
    }
    return parsed as T;
  } finally {
    clearTimeout(timer);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shared response shapes
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every simulate endpoint returns this correlation id. */
export interface DebuggingEnvelope {
  debugging_request_id?: string;
}

/** ISO 4217. The simulator accepts ONLY USD, GBP, EUR — and defaults to GBP. */
export type SimulatorCurrency = 'USD' | 'GBP' | 'EUR';

/* ────────────────────────────────────────────────────────────────────────────
 * Cards — POST /v1/cards
 * ──────────────────────────────────────────────────────────────────────────── */

export type CardType =
  | 'VIRTUAL'
  | 'PHYSICAL'
  | 'SINGLE_USE'
  | 'MERCHANT_LOCKED'
  /** @deprecated behaves like VIRTUAL */
  | 'UNLOCKED'
  /** @deprecated behaves like VIRTUAL */
  | 'DIGITAL_WALLET';

export type CardState = 'OPEN' | 'PAUSED' | 'CLOSED' | 'PENDING_ACTIVATION' | 'PENDING_FULFILLMENT';

export type SpendLimitDuration = 'ANNUALLY' | 'FOREVER' | 'MONTHLY' | 'TRANSACTION' | 'DAILY';

export interface CreateCardParams {
  /** The only required field. Use VIRTUAL — SINGLE_USE closes after one auth. */
  type: CardType;
  /** Required only for programs enrolling users via /v1/account_holders. */
  account_token?: string;
  memo?: string;
  /** Integer cents. 0 means NO limit; only >= 1 produces declines. */
  spend_limit?: Cents;
  spend_limit_duration?: SpendLimitDuration;
  state?: 'OPEN' | 'PAUSED';
  /** "MM" — if both exp fields are omitted, Lithic generates +5 years. */
  exp_month?: string;
  /** "yyyy" */
  exp_year?: string;
  /**
   * Sandbox test values documented by Lithic:
   *   00000000-0000-0000-1000-000000000000
   *   00000000-0000-0000-2000-000000000000
   */
  card_program_token?: string;
  /** Base64 encrypted PIN block. */
  pin?: string;
  /** PHYSICAL only. */
  product_id?: string;
  /** Sent as the `Idempotency-Key` HTTP header, not in the body. */
  idempotencyKey?: string;
}

export interface LithicCard {
  token: string;
  account_token: string;
  card_program_token: string;
  created: string;
  last_four: string;
  spend_limit: Cents;
  spend_limit_duration: SpendLimitDuration;
  state: CardState;
  type: CardType;
  pin_status: 'OK' | 'BLOCKED' | 'NOT_SET';
  funding: {
    token: string;
    account_name?: string;
    created: string;
    last_four: string;
    nickname?: string;
    state: string;
    type: string;
  } | null;
  cardholder_currency?: string;
  exp_month?: string;
  exp_year?: string;
  memo?: string;
  hostname?: string;
  /** SANDBOX ONLY (and PCI-compliant production). Never persist this. */
  pan?: string;
  /** SANDBOX ONLY. Never persist this. */
  cvv?: string;
}

/**
 * Create a card.
 *
 * `POST /v1/cards` → HTTP **200** (note: not 201).
 *
 * In sandbox the response includes the full `pan` and `cvv` in the clear, which
 * is what `simulateAuthorization` needs. In production those fields are absent
 * unless the program is PCI-DSS compliant — so read `card.pan` only on the
 * sandbox code path and persist `token` + `last_four` instead.
 *
 * Sandbox rate limit: 2 RPS on cards writes.
 */
export async function createCard(cfg: LithicConfig, params: CreateCardParams): Promise<LithicCard> {
  const { idempotencyKey, ...body } = params;
  if (body.spend_limit !== undefined) assertCents(body.spend_limit, 'spend_limit');

  return request<LithicCard>(
    cfg,
    'POST',
    '/v1/cards',
    body,
    idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulate: authorization — POST /v1/simulate/authorize
 * ──────────────────────────────────────────────────────────────────────────── */

export type SimulateAuthorizationStatus =
  /** Dual-message purchase auth. Requires a subsequent clearing to settle. */
  | 'AUTHORIZATION'
  /** $0 balance inquiry. `amount` MUST be 0. */
  | 'BALANCE_INQUIRY'
  /** Dual-message refund auth. Requires a subsequent clearing. */
  | 'CREDIT_AUTHORIZATION'
  /** Single-message immediate debit (ATM-like). No clearing. Settles at once. */
  | 'FINANCIAL_AUTHORIZATION'
  /** Single-message immediate credit. No clearing. */
  | 'FINANCIAL_CREDIT_AUTHORIZATION';

export interface SimulateAuthorizationParams {
  /**
   * Integer cents, 0 … 2_000_000_000.
   * Must be 0 for BALANCE_INQUIRY.
   * For CREDIT_* / FINANCIAL_CREDIT_* types Lithic negates this internally —
   * pass a positive number.
   */
  amount: Cents;
  /** Merchant descriptor, 1–25 chars. */
  descriptor: string;
  /** 16-digit card number, from `createCard(...).pan`. */
  pan: string;
  /** 4-digit ISO 18245 merchant category code. */
  mcc?: string;
  /** Max 13 chars. */
  merchant_acceptor_city?: string;
  /** ISO 3166-2 subdivision, max 3 chars. */
  merchant_acceptor_state?: string;
  /** ISO 3166-1 alpha-3, exactly 3 chars, e.g. "USA". */
  merchant_acceptor_country?: string;
  /** Payment acceptor identifier, 1–15 chars. */
  merchant_acceptor_id?: string;
  /** Amount in `merchant_currency`, including acquirer fees. Integer cents. */
  merchant_amount?: Cents;
  /**
   * ALWAYS SEND "USD". The simulator accepts only USD/GBP/EUR and
   * "defaults to GBP if another ISO 4217 code is provided".
   */
  merchant_currency?: SimulatorCurrency;
  partial_approval_capable?: boolean;
  /** 4–12 chars. Omit to skip PIN verification entirely. */
  pin?: string;
  /** Defaults to AUTHORIZATION. */
  status?: SimulateAuthorizationStatus;
}

export interface SimulateAuthorizationResponse extends DebuggingEnvelope {
  /**
   * The TRANSACTION token. This is the value that ties the whole lifecycle
   * together — pass it to simulateClearing / simulateVoid /
   * simulateAuthorizationAdvice, and fetch it via GET /v1/transactions/{token}.
   *
   * Caveat: a DECLINED simulation can also return a `token` alongside a
   * `message`. Presence of a token does not mean approval — read the resulting
   * Transaction's `status` / `result`.
   */
  token?: string;
}

/**
 * Simulate an authorization arriving from the card network.
 *
 * `POST /v1/simulate/authorize` → HTTP 201
 * `{ "token": "<transaction uuid>", "debugging_request_id": "..." }`
 *
 * Errors return HTTP 422 with `{ message, debugging_request_id }`.
 *
 * Gotchas:
 *  - Non-ASA sandbox accounts carry a default $5,000/day transaction limit.
 *    Raise it with PATCH /v1/accounts/{account_token}.
 *  - Once an ASA responder endpoint is enrolled, this endpoint calls YOUR ASA
 *    endpoint and requires valid JSON back, or simulations break.
 *  - Sandbox writes to /v1/simulate/* are capped at 1 RPS.
 */
export async function simulateAuthorization(
  cfg: LithicConfig,
  params: SimulateAuthorizationParams,
): Promise<SimulateAuthorizationResponse> {
  assertCents(params.amount, 'amount');
  if (params.merchant_amount !== undefined) assertCents(params.merchant_amount, 'merchant_amount');
  if (params.status === 'BALANCE_INQUIRY' && params.amount !== 0) {
    throw new RangeError('BALANCE_INQUIRY requires amount === 0');
  }
  return request<SimulateAuthorizationResponse>(cfg, 'POST', '/v1/simulate/authorize', {
    merchant_currency: 'USD' satisfies SimulatorCurrency,
    ...params,
  });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulate: clearing / capture — POST /v1/simulate/clearing
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SimulateClearingParams {
  /** The transaction token returned by simulateAuthorization. */
  token: string;
  /**
   * Integer cents to clear.
   *
   * OMIT to clear the full authorized amount.
   *
   * May be HIGHER OR LOWER than the authorization — verbatim from the docs:
   * "Typically this will match the amount in the original authorization, but
   * can be higher or lower."
   *
   * Sign is auto-matched to the original authorization's sign, so always pass a
   * positive number even when clearing a credit authorization.
   */
  amount?: Cents;
}

/** Clearing does NOT return a token — only the debugging id. */
export type SimulateClearingResponse = DebuggingEnvelope;

/**
 * Clear (capture) an existing authorization, for the same, a higher, or a lower
 * amount.
 *
 * `POST /v1/simulate/clearing` → HTTP 201 `{ "debugging_request_id": "..." }`
 *
 * The transaction transitions PENDING → SETTLED. The clearing appears as a
 * `CLEARING` entry in `transaction.events[]` carrying the cleared amount.
 *
 * Docs state this "may be called multiple times against the same authorization
 * to simulate a multiple-completion scenario, with each call creating a
 * separate clearing event" — while the endpoint summary elsewhere says
 * already-cleared transactions cannot be cleared again.
 *
 * // UNVERIFIED: whether a second clearing against an already fully-cleared
 * // authorization is accepted or rejected in sandbox. Test before relying on
 * // multiple completions.
 * // UNVERIFIED: exact hold arithmetic for a PARTIAL clearing — whether
 * // `amounts.hold.amount` drops to the remainder with status still PENDING, or
 * // drops to 0 with status SETTLED. The endpoint doc says the status
 * // transitions to SETTLED after a clearing, unqualified.
 */
export async function simulateClearing(
  cfg: LithicConfig,
  params: SimulateClearingParams,
): Promise<SimulateClearingResponse> {
  if (params.amount !== undefined) assertCents(params.amount, 'amount');
  return request<SimulateClearingResponse>(cfg, 'POST', '/v1/simulate/clearing', params);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulate: authorization advice (incremental auth)
 * POST /v1/simulate/authorization_advice
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SimulateAuthorizationAdviceParams {
  /** The transaction token returned by simulateAuthorization. */
  token: string;
  /**
   * The NEW total pending amount in integer cents.
   *
   * This is ABSOLUTE, not a delta: "This amount will override the transaction's
   * amount that was originally set by /v1/simulate/authorize." To take a 1000¢
   * hold to 1500¢, send 1500 — not 500.
   */
  amount: Cents;
}

export interface SimulateAuthorizationAdviceResponse extends DebuggingEnvelope {
  token?: string;
}

/**
 * Simulate an authorization advice — Lithic's mechanism for an incremental /
 * adjusted authorization. "An authorization advice changes the pending amount
 * of the transaction."
 *
 * `POST /v1/simulate/authorization_advice` → HTTP 201
 * `{ "token": "...", "debugging_request_id": "..." }`
 *
 * Appends an `AUTHORIZATION_ADVICE` entry to `transaction.events[]`.
 */
export async function simulateAuthorizationAdvice(
  cfg: LithicConfig,
  params: SimulateAuthorizationAdviceParams,
): Promise<SimulateAuthorizationAdviceResponse> {
  assertCents(params.amount, 'amount');
  return request<SimulateAuthorizationAdviceResponse>(
    cfg,
    'POST',
    '/v1/simulate/authorization_advice',
    params,
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulate: void / reversal — POST /v1/simulate/void
 * ──────────────────────────────────────────────────────────────────────────── */

export type SimulateVoidType =
  /** Merchant reversed the authorization. Default. Supports partial amounts. */
  | 'AUTHORIZATION_REVERSAL'
  /** Lithic expired the authorization. ALWAYS voids the full pending amount. */
  | 'AUTHORIZATION_EXPIRY';

export interface SimulateVoidParams {
  /** The transaction token returned by simulateAuthorization. */
  token: string;
  /**
   * Integer cents to void. OMIT for a full void.
   *
   * "Typically this will match the amount in the original authorization, but
   * can be less. Applies to authorization reversals only. An authorization
   * expiry will always apply to the full pending amount."
   *
   * // UNVERIFIED: Lithic's own doc sample sends `{"amount": 0}` while the field
   * // description says an unset amount voids the full amount. Whether 0 means
   * // "full" or literally zero is not documented. This adapter OMITS the field
   * // for a full void rather than sending 0.
   */
  amount?: Cents;
  /** Defaults to AUTHORIZATION_REVERSAL. */
  type?: SimulateVoidType;
}

/** Void does NOT return a token. */
export type SimulateVoidResponse = DebuggingEnvelope;

/**
 * Void (reverse) a PENDING authorization, fully or partially.
 *
 * `POST /v1/simulate/void` → HTTP 201 `{ "debugging_request_id": "..." }`
 *
 * Constraints from the docs:
 *  - Works on pending (uncleared) authorizations.
 *  - "Can be used on partially voided transactions but not partially cleared
 *    transactions."
 *  - Simulating an expiry on credit authorizations / credit authorization
 *    advice is not currently supported.
 *
 * A full void moves the transaction to status VOIDED; an expiry to EXPIRED.
 */
export async function simulateVoid(
  cfg: LithicConfig,
  params: SimulateVoidParams,
): Promise<SimulateVoidResponse> {
  const body: SimulateVoidParams = { token: params.token };
  if (params.type !== undefined) body.type = params.type;
  if (params.amount !== undefined) body.amount = assertCents(params.amount, 'amount');
  return request<SimulateVoidResponse>(cfg, 'POST', '/v1/simulate/void', body);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulate: return (refund) — POST /v1/simulate/return
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SimulateReturnParams {
  /** Integer cents to refund. Pass a positive number. */
  amount: Cents;
  /** Merchant descriptor. */
  descriptor: string;
  /** 16-digit card number. Note: a return is addressed by PAN, NOT by token. */
  pan: string;
}

export interface SimulateReturnResponse extends DebuggingEnvelope {
  /**
   * A NEW transaction token for the credit. A return is not a child of the
   * original purchase — Lithic gives you no linkage, so if your ledger needs to
   * attribute a refund to an original sale you must correlate it yourself.
   * Feed this token to `simulateReturnReversal`.
   */
  token?: string;
}

/**
 * Simulate a return / refund back to a card.
 *
 * `POST /v1/simulate/return` → HTTP 201
 * `{ "token": "...", "debugging_request_id": "..." }`
 *
 * "Returns simulated via this endpoint clear immediately, without prior
 * authorization, and result in a SETTLED transaction status." There is no
 * PENDING phase and no clearing step.
 */
export async function simulateReturn(
  cfg: LithicConfig,
  params: SimulateReturnParams,
): Promise<SimulateReturnResponse> {
  assertCents(params.amount, 'amount');
  return request<SimulateReturnResponse>(cfg, 'POST', '/v1/simulate/return', params);
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulate: return reversal — POST /v1/simulate/return_reversal
 * ──────────────────────────────────────────────────────────────────────────── */

export interface SimulateReturnReversalParams {
  /** The token of a SETTLED credit transaction (from simulateReturn). */
  token: string;
}

export type SimulateReturnReversalResponse = DebuggingEnvelope;

/**
 * Reverse a return — "a credit transaction with a SETTLED status".
 *
 * `POST /v1/simulate/return_reversal` → HTTP 201
 * `{ "debugging_request_id": "..." }`
 */
export async function simulateReturnReversal(
  cfg: LithicConfig,
  params: SimulateReturnReversalParams,
): Promise<SimulateReturnReversalResponse> {
  return request<SimulateReturnReversalResponse>(cfg, 'POST', '/v1/simulate/return_reversal', params);
}

/* ────────────────────────────────────────────────────────────────────────────
 * "Force post"
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * There is NO force-post simulation endpoint in Lithic.
 *
 * I enumerated every path containing "simulate" in Lithic's OpenAPI spec. The
 * complete card-transaction set is:
 *
 *   /v1/simulate/authorize
 *   /v1/simulate/authorization_advice
 *   /v1/simulate/clearing
 *   /v1/simulate/credit_authorization_advice
 *   /v1/simulate/return
 *   /v1/simulate/return_reversal
 *   /v1/simulate/void
 *
 * `/v1/simulate/clearing` REQUIRES a `token` from a prior authorization, so it
 * cannot originate an unmatched clearing. There is no `force` anywhere in the
 * spec.
 *
 * The closest reachable behaviour is a single-message financial authorization:
 * money moves immediately with no dual-message auth and no clearing step. It
 * produces a `FINANCIAL_AUTHORIZATION` event on a transaction that goes
 * straight to SETTLED.
 *
 * If your ledger needs to handle a genuine unmatched clearing, code defensively
 * against `Transaction.result === 'ORIGINAL_NOT_FOUND'` and the event-level
 * `detailed_results` value `REVERSAL_UNMATCHED`, but note that sandbox cannot
 * produce them via the simulate API.
 */
export async function simulateForcePostApproximation(
  cfg: LithicConfig,
  params: Omit<SimulateAuthorizationParams, 'status'>,
): Promise<SimulateAuthorizationResponse> {
  return simulateAuthorization(cfg, { ...params, status: 'FINANCIAL_AUTHORIZATION' });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Transactions — GET /v1/transactions/{token}
 * ──────────────────────────────────────────────────────────────────────────── */

export type TransactionStatus = 'DECLINED' | 'EXPIRED' | 'PENDING' | 'SETTLED' | 'VOIDED';

export type TransactionResult =
  | 'ACCOUNT_PAUSED'
  | 'ACCOUNT_STATE_TRANSACTION_FAIL'
  | 'APPROVED'
  | 'BANK_CONNECTION_ERROR'
  | 'BANK_NOT_VERIFIED'
  | 'CARD_CLOSED'
  | 'CARD_PAUSED'
  | 'DECLINED'
  | 'FRAUD_ADVICE'
  | 'IGNORED_TTL_EXPIRY'
  | 'SUSPECTED_FRAUD'
  | 'INACTIVE_ACCOUNT'
  | 'INCORRECT_PIN'
  | 'INVALID_CARD_DETAILS'
  | 'INSUFFICIENT_FUNDS'
  | 'INSUFFICIENT_FUNDS_PRELOAD'
  | 'INVALID_TRANSACTION'
  | 'MERCHANT_BLACKLIST'
  | 'ORIGINAL_NOT_FOUND'
  | 'PREVIOUSLY_COMPLETED'
  | 'SINGLE_USE_RECHARGED'
  | 'SWITCH_INOPERATIVE_ADVICE'
  | 'UNAUTHORIZED_MERCHANT'
  | 'UNKNOWN_HOST_TIMEOUT'
  | 'USER_TRANSACTION_LIMIT';

/**
 * `transaction.events[].type` — THIS is what distinguishes an authorization
 * from its clearing. There is no separate clearing object: one Transaction
 * accumulates an events array, and each event carries its own amount.
 */
export type TransactionEventType =
  | 'AUTHORIZATION'
  | 'AUTHORIZATION_ADVICE'
  | 'AUTHORIZATION_EXPIRY'
  | 'AUTHORIZATION_REVERSAL'
  | 'BALANCE_INQUIRY'
  | 'CLEARING'
  | 'CORRECTION_CREDIT'
  | 'CORRECTION_DEBIT'
  | 'CREDIT_AUTHORIZATION'
  | 'CREDIT_AUTHORIZATION_ADVICE'
  | 'FINANCIAL_AUTHORIZATION'
  | 'FINANCIAL_CREDIT_AUTHORIZATION'
  | 'RETURN'
  | 'RETURN_REVERSAL';

export interface TransactionEventAmounts {
  cardholder: { amount: Cents; conversion_rate: string; currency: string };
  merchant: { amount: Cents; currency: string };
  settlement: { amount: Cents; currency: string } | null;
}

export interface TransactionEvent {
  /** Event token — distinct from the transaction token. */
  token: string;
  /** @deprecated use `amounts`. Amount of THIS event in settlement currency. */
  amount: Cents;
  amounts: TransactionEventAmounts;
  created: string;
  type: TransactionEventType;
  effective_polarity: 'CREDIT' | 'DEBIT';
  result: TransactionResult;
  /** ~60-value fine-grained enum, incl. CUSTOMER_ASA_TIMEOUT, REVERSAL_UNMATCHED. */
  detailed_results: string[];
  rule_results: unknown[];
  network_info: Record<string, unknown> | null;
  account_type?: 'CHECKING' | 'SAVINGS';
  network_specific_data?: Record<string, unknown> | null;
}

export interface TransactionAmounts {
  /** Estimated settled amount in the cardholder billing currency. */
  cardholder: { amount: Cents; conversion_rate: string; currency: string };
  /** THE PENDING / HELD AMOUNT in the anticipated settlement currency. */
  hold: { amount: Cents; currency: string };
  /** Settled amount in the merchant currency. */
  merchant: { amount: Cents; currency: string };
  /** Settled amount in the settlement currency. */
  settlement: { amount: Cents; currency: string };
}

export interface LithicTransaction {
  token: string;
  account_token: string;
  card_token: string;
  financial_account_token: string | null;
  created: string;
  updated: string;
  status: TransactionStatus;
  result: TransactionResult;
  /** USE THIS for money. The flat amount fields below are all deprecated. */
  amounts: TransactionAmounts;
  /** @deprecated auth amount while PENDING, settled amount once SETTLED. */
  amount: Cents;
  /** @deprecated use `amounts.hold.amount`. */
  authorization_amount: Cents | null;
  /** @deprecated use `amounts.settlement.amount`. */
  settled_amount: Cents;
  /** @deprecated use `amounts.merchant.amount`. */
  merchant_amount: Cents | null;
  /** @deprecated */
  merchant_authorization_amount: Cents | null;
  /** @deprecated use `amounts.merchant.currency`. */
  merchant_currency: string;
  acquirer_fee: Cents | null;
  /** @deprecated moved to event-level `network_info`. */
  acquirer_reference_number: string | null;
  authorization_code: string | null;
  network: 'AMEX' | 'INTERLINK' | 'MAESTRO' | 'MASTERCARD' | 'UNKNOWN' | 'VISA' | null;
  network_risk_score: number | null;
  merchant: Record<string, unknown>;
  pos: Record<string, unknown>;
  avs: { address: string; zipcode: string } | null;
  cardholder_authentication: Record<string, unknown> | null;
  service_location: Record<string, unknown> | null;
  token_info: { wallet_type: string } | null;
  tags: Record<string, string>;
  /** Present on GET by token; the whole lifecycle lives here. */
  events?: TransactionEvent[];
}

/** `GET /v1/transactions/{transaction_token}` */
export async function getTransaction(cfg: LithicConfig, transactionToken: string): Promise<LithicTransaction> {
  return request<LithicTransaction>(cfg, 'GET', `/v1/transactions/${encodeURIComponent(transactionToken)}`);
}

/** Convenience: the currently held (pending) amount, in cents. */
export function pendingAmountOf(txn: LithicTransaction): Cents {
  return txn.amounts.hold.amount;
}

/** Convenience: the settled amount, in cents. */
export function settledAmountOf(txn: LithicTransaction): Cents {
  return txn.amounts.settlement.amount;
}

/**
 * NOTE ON `pending_amount`: that field name does NOT exist on the card
 * Transaction object. It lives on the FINANCIAL TRANSACTION resource
 * (`GET /v1/financial_accounts/{token}/financial_transactions` and
 * `GET /v1/cards/{token}/financial_transactions`), whose shape is
 * `{ token, category, status, result, pending_amount, settled_amount, currency,
 *    descriptor, events[], created, updated }`. There, `pending_amount` "will go
 * to zero over time once the financial transaction is settled" and
 * `settled_amount` "may change over time".
 *
 * On the card Transaction, the equivalent of `pending_amount` is
 * `amounts.hold.amount`. Pick one view and be consistent.
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Event subscriptions (webhook registration)
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The complete Lithic event type union, verbatim from the OpenAPI spec.
 * `card_transaction.updated` is the one that carries the auth/clearing
 * lifecycle — its payload is the full Transaction object plus `event_type`.
 */
export type LithicEventType =
  | 'account_holder_document.updated'
  | 'account_holder.created'
  | 'account_holder.updated'
  | 'account_holder.verification'
  | 'auth_rules.backtest_report.created'
  | 'balance.updated'
  | 'book_transfer_transaction.created'
  | 'book_transfer_transaction.updated'
  | 'card_authorization.challenge'
  | 'card_authorization.challenge_response'
  | 'card_transaction.enhanced_data.created'
  | 'card_transaction.enhanced_data.updated'
  | 'card_transaction.updated'
  | 'card.converted'
  | 'card.created'
  | 'card.reissued'
  | 'card.renewed'
  | 'card.shipped'
  | 'card.updated'
  | 'claim_document.accepted'
  | 'claim_document.rejected'
  | 'claim_document.uploaded'
  | 'claim.created'
  | 'claim.updated'
  | 'digital_wallet.tokenization_result'
  | 'digital_wallet.tokenization_two_factor_authentication_code'
  | 'digital_wallet.tokenization_two_factor_authentication_code_sent'
  | 'digital_wallet.tokenization_updated'
  | 'dispute_evidence.upload_failed'
  | 'dispute_transaction.created'
  | 'dispute_transaction.updated'
  | 'dispute.updated'
  | 'embed.session_generated'
  | 'embed.viewed'
  | 'external_bank_account.created'
  | 'external_bank_account.updated'
  | 'external_payment.created'
  | 'external_payment.updated'
  | 'financial_account.created'
  | 'financial_account.updated'
  | 'funding_event.created'
  | 'internal_transaction.created'
  | 'internal_transaction.updated'
  | 'loan_tape.created'
  | 'loan_tape.updated'
  | 'management_operation.created'
  | 'management_operation.updated'
  | 'network_total.created'
  | 'network_total.updated'
  | 'payment_transaction.created'
  | 'payment_transaction.updated'
  | 'settlement_report.updated'
  | 'statements.created'
  | 'three_ds_authentication.challenge'
  | 'three_ds_authentication.created'
  | 'three_ds_authentication.updated'
  | 'tokenization.approval_request'
  | 'tokenization.result'
  | 'tokenization.two_factor_authentication_code'
  | 'tokenization.two_factor_authentication_code_sent'
  | 'tokenization.updated';

/**
 * The event types that matter for the card auth → clearing lifecycle.
 * `card_transaction.updated` fires on EVERY step: authorization, advice,
 * clearing, void, expiry, return. It is not a "new transaction" signal.
 */
export const CARD_LIFECYCLE_EVENT_TYPES = [
  'card_transaction.updated',
  'card_authorization.challenge',
  'card_authorization.challenge_response',
] as const satisfies readonly LithicEventType[];

/**
 * `card_authorization.approval_request` is the ASA (Auth Stream Access)
 * real-time decisioning request. It is delivered to a RESPONDER ENDPOINT
 * (POST /v1/responder_endpoints), not to an event subscription, so it is
 * deliberately absent from `LithicEventType` above — matching the spec.
 */
export type LithicAsaEventType = 'card_authorization.approval_request';

export interface CreateEventSubscriptionParams {
  /** Must be a valid HTTPS address. localhost will not work. */
  url: string;
  description?: string;
  /** Omit to receive ALL event types. */
  event_types?: LithicEventType[];
  /** true = inactive. */
  disabled?: boolean;
}

export interface EventSubscription {
  token: string;
  url: string;
  description: string | null;
  event_types: LithicEventType[] | null;
  disabled: boolean;
  debugging_request_id?: string;
}

/** `POST /v1/event_subscriptions` */
export async function createEventSubscription(
  cfg: LithicConfig,
  params: CreateEventSubscriptionParams,
): Promise<EventSubscription> {
  return request<EventSubscription>(cfg, 'POST', '/v1/event_subscriptions', params);
}

/** `GET /v1/event_subscriptions/{token}/secret` → `{ "key": "whsec_..." }` */
export async function getEventSubscriptionSecret(
  cfg: LithicConfig,
  subscriptionToken: string,
): Promise<{ key: string }> {
  return request<{ key: string }>(
    cfg,
    'GET',
    `/v1/event_subscriptions/${encodeURIComponent(subscriptionToken)}/secret`,
  );
}

/**
 * Fire a synthetic event at your endpoint — the fastest way to test signature
 * verification without burning simulate-endpoint rate limit.
 * `POST /v1/simulate/event_subscriptions/{token}/send_example`
 */
export async function sendExampleEvent(
  cfg: LithicConfig,
  subscriptionToken: string,
  eventType: LithicEventType,
): Promise<DebuggingEnvelope> {
  return request<DebuggingEnvelope>(
    cfg,
    'POST',
    `/v1/simulate/event_subscriptions/${encodeURIComponent(subscriptionToken)}/send_example`,
    { event_type: eventType },
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Webhook signature verification — Standard Webhooks (the Svix scheme)
 * ──────────────────────────────────────────────────────────────────────────── */

/** Standard Webhooks reference tolerance: 5 minutes. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Verify a Lithic webhook signature.
 *
 * Lithic uses **Standard Webhooks** — the spec Svix authored and open-sourced.
 * The official `lithic-node` SDK literally does
 * `import { Webhook } from 'standardwebhooks'` and calls `wh.verify(body, headers)`,
 * so any Svix-compatible verifier is byte-compatible. This is a dependency-free
 * reimplementation of exactly that algorithm.
 *
 * Headers (case-insensitive; this function lowercases them for you):
 *   webhook-id         message id, stable across retries, == event.token
 *   webhook-timestamp  Unix SECONDS as a decimal string
 *   webhook-signature  space-delimited list of `v1,<base64>` entries
 *                      (multiple entries occur during secret rotation)
 *
 * Algorithm:
 *   1. signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`
 *   2. key           = base64Decode(secret without the `whsec_` prefix)
 *   3. expected      = base64(HMAC_SHA256(key, utf8(signedContent)))
 *   4. any `v1,<sig>` entry whose <sig> constant-time-equals `expected` ⇒ valid
 *   5. reject if |now - timestamp| > 300 seconds (replay protection)
 *
 * @param rawBody MUST be the raw request body string, byte-for-byte as received.
 *                On Next.js App Router: `await req.text()`. Never `req.json()`
 *                followed by `JSON.stringify` — key order and whitespace will
 *                differ and every signature will fail.
 * @param headers Request headers as a plain object (any casing).
 * @param secret  The `whsec_...` value from
 *                GET /v1/event_subscriptions/{token}/secret, or the ASA HMAC
 *                secret from GET /v1/auth_stream/secret. The `whsec_` prefix is
 *                optional — it is stripped if present.
 * @returns true if the signature and timestamp are both valid. Never throws for
 *          an invalid signature; only for a structurally unusable secret.
 */
export function verifyLithicWebhook(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
): boolean {
  const h: Record<string, string> = {};
  for (const k of Object.keys(headers)) {
    const v = headers[k];
    if (typeof v === 'string') h[k.toLowerCase()] = v;
  }

  const webhookId = h['webhook-id'];
  const webhookTimestamp = h['webhook-timestamp'];
  const webhookSignature = h['webhook-signature'];
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  // ── Step 5: timestamp tolerance (±5 minutes) ──────────────────────────────
  const timestamp = Number.parseInt(webhookTimestamp, 10);
  if (!Number.isFinite(timestamp)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > WEBHOOK_TOLERANCE_SECONDS) return false; // too old
  if (timestamp - now > WEBHOOK_TOLERANCE_SECONDS) return false; // too new

  // ── Step 2: key = base64Decode(secret sans `whsec_`) ──────────────────────
  const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const key = Buffer.from(rawSecret, 'base64');
  if (key.length === 0) throw new Error('Lithic webhook secret decoded to zero bytes');

  // ── Steps 1 & 3 ───────────────────────────────────────────────────────────
  const signedContent = `${webhookId}.${timestamp}.${rawBody}`;
  const expected = createHmac('sha256', key).update(signedContent, 'utf8').digest('base64');
  const expectedBuf = Buffer.from(expected, 'utf8');

  // ── Step 4: any matching v1 signature wins ────────────────────────────────
  for (const entry of webhookSignature.split(' ')) {
    const comma = entry.indexOf(',');
    if (comma === -1) continue;
    const version = entry.slice(0, comma);
    if (version !== 'v1') continue;
    const candidate = Buffer.from(entry.slice(comma + 1), 'utf8');
    if (candidate.length !== expectedBuf.length) continue;
    if (timingSafeEqual(candidate, expectedBuf)) return true;
  }
  return false;
}

/**
 * The webhook body Lithic POSTs is the PAYLOAD object itself, carrying its own
 * `event_type` discriminator at the top level. (The
 * `{ token, event_type, payload, created }` envelope is what
 * `GET /v1/events` returns, not what is delivered over HTTP.)
 *
 * For `card_transaction.updated` the body is the full Transaction plus
 * `event_type`.
 */
export type CardTransactionUpdatedWebhook = LithicTransaction & {
  event_type: 'card_transaction.updated';
};

/**
 * Parse a webhook after verifying it. Use `webhook-id` as your idempotency key:
 * it is stable across Lithic's retry schedule
 * (immediate → +5s → +5m → +30m → +2h → +5h → +10h → +10h, 8 attempts),
 * so duplicate deliveries are expected and must be deduped.
 */
export function parseVerifiedWebhook<T = { event_type: LithicEventType }>(
  rawBody: string,
  headers: Record<string, string>,
  secret: string,
): { event: T; webhookId: string } | null {
  if (!verifyLithicWebhook(rawBody, headers, secret)) return null;
  const lower: Record<string, string> = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k]!;
  return { event: JSON.parse(rawBody) as T, webhookId: lower['webhook-id']! };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Auth Stream Access (ASA) — real-time decisioning. STRETCH GOAL.
 * ──────────────────────────────────────────────────────────────────────────── */

export type ResponderEndpointType =
  | 'AUTH_STREAM_ACCESS'
  | 'THREE_DS_DECISIONING'
  | 'TOKENIZATION_DECISIONING';

/**
 * Enroll an ASA responder endpoint. Works in sandbox AND production, self-serve.
 * `POST /v1/responder_endpoints` → `{ "enrolled": true }`
 *
 * WARNING: once enrolled, `/v1/simulate/authorize` routes through your endpoint
 * and requires valid JSON back within the timeout. A broken ASA endpoint breaks
 * your otherwise-working simulations. Keep `disenrollResponderEndpoint` handy.
 */
export async function enrollResponderEndpoint(
  cfg: LithicConfig,
  params: { type: ResponderEndpointType; url: string },
): Promise<{ enrolled: boolean }> {
  return request<{ enrolled: boolean }>(cfg, 'POST', '/v1/responder_endpoints', params);
}

/** `DELETE /v1/responder_endpoints?type=...` */
export async function disenrollResponderEndpoint(
  cfg: LithicConfig,
  type: ResponderEndpointType,
): Promise<void> {
  await request<void>(cfg, 'DELETE', `/v1/responder_endpoints?type=${encodeURIComponent(type)}`);
}

/**
 * Retrieve (creating on first call) the ASA HMAC secret. Until this is called,
 * ASA requests carry NO webhook-id/timestamp/signature headers at all.
 * `GET /v1/auth_stream/secret`
 *
 * // UNVERIFIED: the response field name. The event-subscription secret
 * // endpoint returns `{ "key": "whsec_..." }`; the ASA one is documented only
 * // prosaically. Handle both `key` and `secret`.
 */
export async function getAsaSecret(cfg: LithicConfig): Promise<{ key?: string; secret?: string }> {
  return request<{ key?: string; secret?: string }>(cfg, 'GET', '/v1/auth_stream/secret');
}

/**
 * The decision your ASA endpoint returns, as HTTP 200 JSON.
 * Only `result` is required. Timeout is 6 SECONDS (Lithic declines after that);
 * they recommend responding within 3s or you will see approved transactions
 * voided shortly afterwards.
 */
export type AsaResult =
  /** Approve. */
  | 'APPROVED'
  /** Trigger an Authorization Challenge. Cardholder-initiated txns only. */
  | 'CHALLENGE'
  | 'AVS_INVALID'
  | 'CARD_PAUSED'
  | 'INSUFFICIENT_FUNDS'
  | 'UNAUTHORIZED_MERCHANT'
  | 'VELOCITY_EXCEEDED'
  | 'DRIVER_NUMBER_INVALID'
  | 'VEHICLE_NUMBER_INVALID'
  | 'SUSPECTED_FRAUD';

export interface AsaResponse {
  /** Anything other than APPROVED / CHALLENGE declines the transaction. */
  result: AsaResult;
  /** Echo of the request's transaction token. Optional. */
  token?: string;
  /**
   * Integer cents. PRESENCE OF THIS FIELD IMPLIES A PARTIAL APPROVAL —
   * omit it entirely to fully approve. The terminal must be
   * partial-approval capable for it to take effect.
   */
  approved_amount?: Cents;
  avs_result?: 'MATCH' | 'MATCH_ZIP_ONLY' | 'MATCH_ADDRESS_ONLY' | 'FAIL';
  /** Required for BALANCE_INQUIRY messages; otherwise Lithic returns $0. */
  balance?: {
    /** Balance held on the card, cents. */
    amount: Cents | null;
    /** Settled minus pending authorizations, cents. */
    available: Cents | null;
  };
  /** E.164 without hyphens, e.g. "+15555555555". Only when result === CHALLENGE. */
  challenge_phone_number?: string;
  /** // UNVERIFIED: enum values of name_validation_result not captured here. */
  name_validation_result?: string;
}

/**
 * The ASA request body Lithic POSTs to your responder endpoint.
 * Signed with the SAME Standard Webhooks scheme as event webhooks — verify it
 * with `verifyLithicWebhook(rawBody, headers, asaSecret)`.
 *
 * Only the fields load-bearing for a decision are typed here; the full shape is
 * the `authorization` schema in Lithic's OpenAPI spec and is considerably wider
 * (fleet_info, network_specific_data, service_location, latest_challenge, …).
 */
export interface AsaRequest {
  event_type: 'card_authorization.approval_request';
  /** The transaction token. Echo it back in `AsaResponse.token`. */
  token: string;
  event_token?: string;
  created: string;
  status: string;
  /** @deprecated use `amounts`. */
  amount: Cents;
  amounts: TransactionAmounts;
  authorization_amount: Cents;
  settled_amount: Cents;
  merchant_amount: Cents;
  merchant_currency: string;
  cardholder_currency: string;
  acquirer_fee: Cents;
  cash_amount: Cents;
  cashback?: Cents;
  card: { token: string; last_four: string; state: string; type: string; memo?: string };
  merchant: Record<string, unknown>;
  pos?: Record<string, unknown>;
  avs: { address?: string; zipcode?: string };
  transaction_initiator: 'CARDHOLDER' | 'MERCHANT' | 'UNKNOWN';
  network?: 'AMEX' | 'INTERLINK' | 'MAESTRO' | 'MASTERCARD' | 'UNKNOWN' | 'VISA';
  network_risk_score?: number | null;
  token_info?: { wallet_type: string } | null;
  cardholder_authentication?: Record<string, unknown>;
  account_type?: 'CHECKING' | 'SAVINGS';
  ttl?: string;
}

/**
 * Hard timeout after which Lithic declines the transaction on your behalf.
 * Lithic recommends 3s; past that you will see approved auths voided.
 */
export const ASA_HARD_TIMEOUT_MS = 6_000;
export const ASA_RECOMMENDED_BUDGET_MS = 3_000;

/**
 * Wrap your decisioning logic so it can never blow the ASA budget.
 * On timeout or throw, returns `fallback` (default: decline as SUSPECTED_FRAUD
 * — pick your own default deliberately; approving on failure is a real policy
 * choice with real money attached).
 */
export async function decideWithinAsaBudget(
  decide: (req: AsaRequest) => Promise<AsaResponse>,
  req: AsaRequest,
  budgetMs: number = ASA_RECOMMENDED_BUDGET_MS - 500,
  fallback: AsaResponse = { result: 'SUSPECTED_FRAUD' },
): Promise<AsaResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      decide(req),
      new Promise<AsaResponse>((resolve) => {
        timer = setTimeout(() => resolve(fallback), budgetMs);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Rate limiting helper
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * SANDBOX WRITE RATE LIMITS (from https://docs.lithic.com/docs/rate-limits):
 *
 *   POST /v1/simulate/*        1 RPS   ← the binding constraint on this track
 *   POST /v1/cards             2 RPS
 *   POST everything else       1 RPS
 *   GET  everything            15 RPS
 *
 * A 429 carries `retry-after: "1"`. Every response carries `x-requests-remaining`.
 *
 * An auth + clearing pair is two writes, so it takes >= 1 second no matter what.
 * Serialize simulate calls through this limiter or you will spend the trial
 * debugging spurious 429s.
 */
export class SerialRateLimiter {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly minIntervalMs = 1_100) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const value = await fn();
      await new Promise((r) => setTimeout(r, this.minIntervalMs));
      return value;
    });
    this.chain = result.catch(() => undefined);
    return result;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Worked example: auth, then clear for a DIFFERENT amount
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The canonical Track 3 flow. Authorize for one amount, settle for another.
 *
 *   const cfg = { apiKey: process.env.LITHIC_API_KEY! };
 *   const limiter = new SerialRateLimiter();
 *
 *   const card = await limiter.run(() =>
 *     createCard(cfg, { type: 'VIRTUAL', memo: 'corgi', spend_limit: 500_00,
 *                       spend_limit_duration: 'MONTHLY', state: 'OPEN' }));
 *
 *   const auth = await limiter.run(() =>
 *     simulateAuthorization(cfg, {
 *       amount: 3831,                        // $38.31
 *       descriptor: 'COFFEE SHOP',
 *       pan: card.pan!,                      // sandbox only
 *       status: 'AUTHORIZATION',
 *       mcc: '5812',
 *       merchant_acceptor_city: 'LOS ANGELES',
 *       merchant_acceptor_state: 'CA',
 *       merchant_acceptor_country: 'USA',
 *       merchant_currency: 'USD',            // else the simulator uses GBP
 *     }));
 *
 *   const txnToken = auth.token!;            // ties the whole lifecycle together
 *
 *   // PENDING: amounts.hold.amount === 3831, amounts.settlement.amount === 0
 *   await getTransaction(cfg, txnToken);
 *
 *   await limiter.run(() =>
 *     simulateClearing(cfg, { token: txnToken, amount: 4214 }));  // $42.14 — a tip
 *
 *   // SETTLED: amounts.hold.amount === 0, amounts.settlement.amount === 4214,
 *   // events === [{type:'AUTHORIZATION', amount:3831},
 *   //             {type:'CLEARING',      amount:4214}]
 *   const settled = await getTransaction(cfg, txnToken);
 *
 * Clear LOWER: pass a smaller `amount`. Clear the FULL auth: omit `amount`.
 */
