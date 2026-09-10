/**
 * Lithic card rail — wire types.
 *
 * Everything here mirrors Lithic's own JSON shapes. Nothing is renamed, so a
 * response can be cast to these types without a translation layer; the
 * normalisation (and the two traps that make it necessary) lives in
 * `./client.ts` → `normalizeTransaction`.
 *
 * MONEY RULE: every monetary value is an INTEGER number of minor units (cents
 * for USD), typed `Cents`. Never a float, never a string, never dollars.
 * Lithic is integer-cents end to end, so there is no conversion anywhere in
 * this adapter.
 *
 * Provenance of each fact:
 *   [MEASURED] verified against the live sandbox (see DECISIONS.md 004 / 006)
 *   [DOCS]     read from Lithic's OpenAPI spec / docs
 *   [UNVERIFIED] neither — flagged so it is not mistaken for either
 */

/* ────────────────────────────────────────────────────────────────────────────
 * Money
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Integer minor units. NOT branded, because Lithic's own JSON is plain
 * `number` and a brand would force a cast on every field of every response.
 * Use `assertCents` at the boundaries where a value enters from outside.
 *
 * SIGN WARNING: on responses, Lithic's sign convention is *not* uniform — see
 * `TransactionAmounts.hold` below. Values you *send* are always positive.
 */
export type Cents = number;

/** Throws unless `value` is a safe integer. Use on anything user-supplied. */
export function assertCents(value: number, label = 'amount'): Cents {
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} exceeds the safe integer range: ${value}`);
  }
  return value;
}

/**
 * [DOCS] The simulator accepts only these three and *defaults to GBP* when
 * anything else (or, by the letter of the doc, nothing) is supplied. Always
 * send 'USD' explicitly.
 */
export type SimulatorCurrency = 'USD' | 'GBP' | 'EUR';

/* ────────────────────────────────────────────────────────────────────────────
 * Cards
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

export type CardState =
  | 'OPEN'
  | 'PAUSED'
  | 'CLOSED'
  | 'PENDING_ACTIVATION'
  | 'PENDING_FULFILLMENT';

export type SpendLimitDuration =
  | 'ANNUALLY'
  | 'DAILY'
  | 'FOREVER'
  | 'MONTHLY'
  | 'TRANSACTION';

export interface CardFunding {
  token: string;
  account_name?: string | null;
  created: string;
  last_four: string;
  nickname?: string | null;
  state: 'ENABLED' | 'PENDING' | 'DELETED';
  type: string;
}

/**
 * `POST /v1/cards` and `GET /v1/cards/{card_token}`.
 *
 * PAN/CVV: **sandbox returns them in the clear**; production withholds them
 * unless you are PCI-DSS compliant, and `GET /v1/cards` (list) returns the
 * non-PCI shape in both environments. They are therefore optional here, and
 * nothing outside the simulate path may read them. Persist `token` and
 * `last_four` only.
 */
export interface Card {
  token: string;
  account_token: string;
  card_program_token?: string;
  created: string;
  state: CardState;
  type: CardType;
  last_four: string;
  exp_month: string;
  exp_year: string;
  memo?: string | null;
  spend_limit: Cents;
  spend_limit_duration: SpendLimitDuration;
  cardholder_currency?: string;
  funding?: CardFunding;
  hostname?: string | null;
  replacement_for?: string | null;
  pin_status?: 'OK' | 'NOT_SET' | 'BLOCKED';
  /** Sandbox / PCI only. Never log, never persist. */
  pan?: string;
  /** Sandbox / PCI only. Never log, never persist. */
  cvv?: string;
  digital_card_art_token?: string | null;
}

export interface CreateCardParams {
  /** The only required field. Use VIRTUAL — SINGLE_USE closes after one auth. */
  type: CardType;
  /** Required only for programs enrolling users via /v1/account_holders. */
  account_token?: string;
  memo?: string;
  /** Integer cents. 0 means NO limit; only >= 1 can produce a decline. */
  spend_limit?: Cents;
  spend_limit_duration?: SpendLimitDuration;
  state?: 'OPEN' | 'PAUSED';
  /** "MM" — if both exp fields are omitted Lithic generates now + 5 years. */
  exp_month?: string;
  /** "yyyy" */
  exp_year?: string;
  card_program_token?: string;
  /** PHYSICAL only. */
  product_id?: string;
}

export interface ListCardsQuery {
  account_token?: string;
  state?: CardState;
  /** ISO-8601 inclusive lower bound on `created`. */
  begin?: string;
  /** ISO-8601 exclusive upper bound on `created`. */
  end?: string;
  page?: number;
  page_size?: number;
}

/**
 * [UNVERIFIED] Lithic's list envelope. Page-based on the v1 REST surface;
 * some resources also expose cursor fields. Everything but `data` is optional
 * so a shape change cannot break a caller that only reads `data`.
 */
export interface LithicPage<T> {
  data: T[];
  page?: number;
  total_entries?: number;
  total_pages?: number;
  has_more?: boolean;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Transactions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * TRAP #1 — see `normalizeTransaction`. [MEASURED] `SETTLED` appears while a
 * partial hold is still outstanding. This field is a *message-flow* marker,
 * not a description of the hold. Never release a hold because of it.
 */
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
  | 'INACTIVE_ACCOUNT'
  | 'INCORRECT_PIN'
  | 'INSUFFICIENT_FUNDS'
  | 'INSUFFICIENT_FUNDS_PRELOAD'
  | 'INVALID_CARD_DETAILS'
  | 'INVALID_TRANSACTION'
  | 'MERCHANT_BLACKLIST'
  | 'ORIGINAL_NOT_FOUND'
  | 'PREVIOUSLY_COMPLETED'
  | 'SINGLE_USE_RECHARGED'
  | 'SUSPECTED_FRAUD'
  | 'SWITCH_INOPERATIVE_ADVICE'
  | 'UNAUTHORIZED_MERCHANT'
  | 'UNKNOWN_HOST_TIMEOUT'
  | 'USER_TRANSACTION_LIMIT';

/**
 * There is no separate "clearing object". One Transaction accumulates an
 * `events[]` array and `events[].type` is what distinguishes an authorisation
 * from its clearing. This is the only trustworthy description of what
 * happened to the money.
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

/** Event types that place or raise a hold. */
export const HOLD_OPENING_EVENT_TYPES = ['AUTHORIZATION', 'CREDIT_AUTHORIZATION'] as const;

/**
 * [DOCS] An advice *overrides* the transaction's amount — it is absolute, not
 * a delta. 1000 -> 1500 is `amount: 1500`, not `amount: 500`.
 */
export const HOLD_REPLACING_EVENT_TYPES = [
  'AUTHORIZATION_ADVICE',
  'CREDIT_AUTHORIZATION_ADVICE',
] as const;

/** Event types that consume or release an existing hold. */
export const HOLD_RELEASING_EVENT_TYPES = [
  'CLEARING',
  'AUTHORIZATION_REVERSAL',
  'AUTHORIZATION_EXPIRY',
] as const;

/**
 * Single-message and credit events: they settle immediately and never place a
 * hold, so they contribute nothing to the hold arithmetic.
 * [MEASURED] FINANCIAL_AUTHORIZATION 2500 -> status SETTLED, hold 0.
 */
export const NO_HOLD_EVENT_TYPES = [
  'BALANCE_INQUIRY',
  'FINANCIAL_AUTHORIZATION',
  'FINANCIAL_CREDIT_AUTHORIZATION',
  'RETURN',
  'RETURN_REVERSAL',
  'CORRECTION_CREDIT',
  'CORRECTION_DEBIT',
] as const;

export interface EventAmount {
  amount: Cents;
  currency: string;
}

export interface CardholderAmount extends EventAmount {
  conversion_rate: string;
}

export interface TransactionEventAmounts {
  cardholder: CardholderAmount;
  merchant: EventAmount;
  /** Null until the event has a settlement figure. */
  settlement: EventAmount | null;
}

export interface TransactionEvent {
  /** Event token. NOT interchangeable with the transaction token. */
  token: string;
  type: TransactionEventType;
  created: string;
  /** @deprecated prefer `amounts`. Amount of THIS event in settlement currency. */
  amount: Cents;
  amounts?: TransactionEventAmounts;
  effective_polarity?: 'CREDIT' | 'DEBIT';
  result?: TransactionResult;
  /** ~60-value enum incl. REVERSAL_UNMATCHED, CUSTOMER_ASA_TIMEOUT. */
  detailed_results?: string[];
  rule_results?: unknown[];
  network_info?: Record<string, unknown> | null;
  account_type?: 'CHECKING' | 'SAVINGS';
  network_specific_data?: Record<string, unknown> | null;
}

export interface TransactionAmounts {
  /** Estimated settled amount in the cardholder billing currency. */
  cardholder: CardholderAmount;
  /**
   * TRAP #2 — [MEASURED] this is SIGNED NEGATIVE for a debit hold
   * (auth 1000 -> `amounts.hold.amount === -1000`). It is also the *remaining*
   * hold, which keeps decreasing across partial clearings while `status`
   * already reads SETTLED. Read it through `normalizeTransaction`.
   */
  hold: EventAmount;
  /** Settled amount in the merchant currency. Also signed. */
  merchant: EventAmount;
  /** Settled amount in the settlement currency. Also signed. */
  settlement: EventAmount;
}

export interface Transaction {
  token: string;
  account_token: string;
  card_token: string;
  financial_account_token?: string | null;
  created: string;
  updated: string;
  /** See TRAP #1 on `TransactionStatus`. */
  status: TransactionStatus;
  result: TransactionResult;
  /** Use this for money. Every flat amount field below is deprecated. */
  amounts: TransactionAmounts;
  /** @deprecated auth amount while PENDING, settled amount once SETTLED. */
  amount?: Cents;
  /** @deprecated use `amounts.hold.amount`. */
  authorization_amount?: Cents | null;
  /** @deprecated use `amounts.settlement.amount`. */
  settled_amount?: Cents;
  /** @deprecated use `amounts.merchant.amount`. */
  merchant_amount?: Cents | null;
  /** @deprecated */
  merchant_authorization_amount?: Cents | null;
  /** @deprecated use `amounts.merchant.currency`. */
  merchant_currency?: string;
  acquirer_fee?: Cents | null;
  authorization_code?: string | null;
  network?: 'AMEX' | 'INTERLINK' | 'MAESTRO' | 'MASTERCARD' | 'UNKNOWN' | 'VISA' | null;
  network_risk_score?: number | null;
  merchant?: Record<string, unknown>;
  pos?: Record<string, unknown>;
  avs?: { address?: string; zipcode?: string } | null;
  cardholder_authentication?: Record<string, unknown> | null;
  token_info?: { wallet_type?: string } | null;
  tags?: Record<string, string>;
  /**
   * The whole lifecycle. Present on GET-by-token and on the
   * `card_transaction.updated` webhook payload; may be absent on list rows.
   */
  events?: TransactionEvent[];
}

export interface ListTransactionsQuery {
  account_token?: string;
  card_token?: string;
  result?: 'APPROVED' | 'DECLINED';
  /** ISO-8601 inclusive lower bound on `created`. */
  begin?: string;
  /** ISO-8601 exclusive upper bound on `created`. */
  end?: string;
  page?: number;
  page_size?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Simulation request/response shapes
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * [DOCS] `AUTHORIZATION` is dual-message and needs a clearing to settle.
 * `FINANCIAL_AUTHORIZATION` is single-message: it settles immediately with no
 * hold and no clearing, which is the closest thing Lithic's sandbox has to a
 * force post (DECISIONS.md 004).
 */
export type SimulateAuthorizeStatus =
  | 'AUTHORIZATION'
  | 'BALANCE_INQUIRY'
  | 'CREDIT_AUTHORIZATION'
  | 'FINANCIAL_AUTHORIZATION'
  | 'FINANCIAL_CREDIT_AUTHORIZATION';

export interface SimulateAuthorizeParams {
  /** Integer cents, positive. Must be 0 for BALANCE_INQUIRY. */
  amount: Cents;
  /** Merchant name, 1–25 chars. */
  descriptor: string;
  /** 16-digit PAN from card create. Sandbox only. */
  pan: string;
  /** Defaults to 'AUTHORIZATION' (two-message, creates a hold). */
  status?: SimulateAuthorizeStatus;
  /**
   * [MEASURED] `merchant_currency` is REJECTED unless `merchant_amount` is
   * also present ("'merchant_currency' requires that 'merchant_amount' is
   * set"). The client always sends both; leave this undefined to mirror
   * `amount`.
   */
  merchant_amount?: Cents;
  /** Defaults to 'USD'. The simulator defaults to GBP if you let it. */
  merchant_currency?: SimulatorCurrency;
  /** 4-digit ISO 18245. */
  mcc?: string;
  merchant_acceptor_id?: string;
  merchant_acceptor_city?: string;
  merchant_acceptor_state?: string;
  /** ISO 3166-1 alpha-3, exactly 3 chars, e.g. "USA". */
  merchant_acceptor_country?: string;
  partial_approval_capable?: boolean;
  /** 4–12 chars. Omitted ⇒ no PIN check. */
  pin?: string;
}

/** Every simulate endpoint returns this correlation id. Quote it to support. */
export interface DebuggingEnvelope {
  debugging_request_id?: string;
}

/**
 * [MEASURED] `token` identifies the WHOLE transaction lifecycle — it is what
 * you pass to clearing/void and what `GET /v1/transactions/{token}` returns.
 *
 * A decline also returns a `token` alongside a `message`, so the presence of a
 * token does NOT mean approved. Read the resulting Transaction.
 */
export interface SimulateAuthorizeResponse extends DebuggingEnvelope {
  token?: string;
  message?: string;
}

export interface SimulateClearingParams {
  /** The transaction token from simulateAuthorize. */
  token: string;
  /**
   * [MEASURED] Omit to clear the full authorised amount. Partial clearings,
   * over-captures and repeat clearings against one auth all work.
   */
  amountCents?: Cents;
}

/** [MEASURED] No token in the clearing response — clearings are events, not objects. */
export type SimulateClearingResponse = DebuggingEnvelope;

export type SimulateVoidType = 'AUTHORIZATION_REVERSAL' | 'AUTHORIZATION_EXPIRY';

export interface SimulateVoidParams {
  token: string;
  /**
   * Omit to void the full pending amount. Sending 0 is a documented no-op and
   * the client rejects it — see the void finding in ./README.md.
   */
  amountCents?: Cents;
  /** Defaults to AUTHORIZATION_REVERSAL (merchant-initiated). */
  type?: SimulateVoidType;
}

export type SimulateVoidResponse = DebuggingEnvelope;

export interface SimulateReturnParams {
  amount: Cents;
  descriptor: string;
  pan: string;
}

/**
 * [DOCS] A return is a NEW, independent credit transaction keyed by PAN, not a
 * child of the original purchase, and it settles immediately. Correlating a
 * refund to its original sale is the ledger's job, not the provider's.
 */
export interface SimulateReturnResponse extends DebuggingEnvelope {
  token?: string;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Normalised view (what the ledger consumes)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface NormalizedTransactionEvent {
  type: TransactionEventType;
  /** Absolute magnitude in cents. Always >= 0; direction is in `polarity`. */
  amountCents: Cents;
  polarity: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  token?: string;
  created?: string;
}

export interface NormalizedTransaction {
  token: string;
  /** Lithic's raw `status`, passed through unmodified. */
  providerStatus: TransactionStatus;
  /**
   * `providerStatus === 'SETTLED'`.
   *
   * DO NOT RELEASE A HOLD ON THIS. [MEASURED] it is true while `holdCents` is
   * still 400. It means "a clearing message arrived", not "no money is held".
   */
  providerSaysSettled: boolean;
  /** Outstanding hold, sign-normalised to a positive magnitude. */
  holdCents: Cents;
  /** Settled total, sign-normalised to a positive magnitude. */
  settledCents: Cents;
  events: NormalizedTransactionEvent[];
  /**
   * The hold recomputed from `events[]` alone:
   *   H(E) = max(authorised(E) − released(E), 0)
   * Independent of both trap fields. If this disagrees with `holdCents` the
   * provider view and the event view have diverged and the transaction should
   * be flagged for reconciliation rather than silently trusted.
   */
  eventDerivedHoldCents: Cents;
  /** False ⇒ divergence between `amounts.hold` and the event set. */
  holdMatchesEvents: boolean;
  /** True iff `holdCents > 0`. The only correct hold-release predicate. */
  hasOutstandingHold: boolean;
  /** Raw provider fields, untouched, for audit and for the reconciliation UI. */
  raw: {
    status: TransactionStatus;
    result?: TransactionResult;
    holdAmount: Cents | null;
    settlementAmount: Cents | null;
    holdCurrency: string | null;
    settlementCurrency: string | null;
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Webhook events
 * ──────────────────────────────────────────────────────────────────────────── */

/** [DOCS] The complete Lithic event-type union from the OpenAPI spec. */
export type LithicEventName =
  | 'account_holder.created'
  | 'account_holder.updated'
  | 'account_holder.verification'
  | 'account_holder_document.updated'
  | 'auth_rules.backtest_report.created'
  | 'balance.updated'
  | 'book_transfer_transaction.created'
  | 'card.converted'
  | 'card.created'
  | 'card.reissued'
  | 'card.renewed'
  | 'card.shipped'
  | 'card.updated'
  | 'card_authorization.approval_request'
  | 'card_authorization.challenge'
  | 'card_authorization.challenge_response'
  | 'card_transaction.enhanced_data.created'
  | 'card_transaction.enhanced_data.updated'
  | 'card_transaction.updated'
  | 'claim.created'
  | 'claim.updated'
  | 'claim_document.updated'
  | 'digital_wallet.token_approval_request'
  | 'digital_wallet.tokenization_approval_request'
  | 'digital_wallet.tokenization_result'
  | 'digital_wallet.tokenization_two_factor_authentication_code'
  | 'digital_wallet.tokenization_two_factor_authentication_code_sent'
  | 'dispute.updated'
  | 'dispute_evidence.upload_failed'
  | 'dispute_transaction.created'
  | 'dispute_transaction.updated'
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
 * The HTTP body Lithic POSTs to a webhook endpoint is the PAYLOAD object
 * itself, carrying its own `event_type` discriminator at the top level. The
 * `{ token, event_type, payload, created }` wrapper is what `GET /v1/events`
 * returns — it is NOT what arrives over HTTP.
 */
export interface LithicEventEnvelope<T = unknown> {
  /** Equals the `webhook-id` header. Use it as the idempotency key. */
  token: string;
  event_type: LithicEventName;
  payload: T;
  created: string;
}

/**
 * The one event that carries the auth/clearing lifecycle. Its payload is the
 * full Transaction plus the discriminator. It fires on EVERY lifecycle step —
 * authorisation, advice, clearing, void, expiry — so a handler must diff
 * `events[]` rather than assume "new transaction".
 */
export interface CardTransactionUpdatedEvent extends Transaction {
  event_type: 'card_transaction.updated';
}

export interface CardCreatedEvent extends Card {
  event_type: 'card.created';
}

export interface CardUpdatedEvent extends Card {
  event_type: 'card.updated';
}

export interface BalanceUpdatedEvent {
  event_type: 'balance.updated';
  financial_account_token?: string;
  available_amount?: Cents;
  pending_amount?: Cents;
  total_amount?: Cents;
  currency?: string;
  updated?: string;
  [key: string]: unknown;
}

/** The event names given a concrete payload type above. */
export type KnownLithicEventName =
  | 'card_transaction.updated'
  | 'card.created'
  | 'card.updated'
  | 'balance.updated';

/**
 * Everything Lithic can send that this adapter has not modelled. Keeping it in
 * the union means `switch (event.event_type)` stays exhaustive instead of
 * silently dropping an unrecognised event.
 */
export interface UnmodelledLithicEvent {
  event_type: Exclude<LithicEventName, KnownLithicEventName>;
  [key: string]: unknown;
}

/**
 * Discriminated union over `event_type`. Narrow with a switch:
 *
 *   switch (event.event_type) {
 *     case 'card_transaction.updated':
 *       normalizeTransaction(event);   // event is a Transaction here
 *       break;
 *     default:
 *       // unmodelled — log and 2xx, never 5xx (Lithic retries 8 times)
 *   }
 */
export type LithicEventType =
  | CardTransactionUpdatedEvent
  | CardCreatedEvent
  | CardUpdatedEvent
  | BalanceUpdatedEvent
  | UnmodelledLithicEvent;

/** Type guard: is this the transaction lifecycle event? */
export function isCardTransactionUpdated(
  event: LithicEventType,
): event is CardTransactionUpdatedEvent {
  return event.event_type === 'card_transaction.updated';
}
