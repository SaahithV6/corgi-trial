/**
 * PaymentRail — a provider-agnostic money-movement adapter.
 *
 * Corgi trial, Track 3. Draft: 2026-09-09.
 *
 * DESIGN STANCE
 * -------------
 * A rail is an ADAPTER, not a schema. The ledger owns truth about money; the rail
 * owns "what the network did to this instruction, and when we learned about it."
 * So this interface deliberately does NOT expose ACH nouns (routing number, SEC
 * code, ODFI) at the top level. Those live inside a `Destination` variant that
 * only the ACH adapter knows how to read. Card and USDC get their own variants
 * and slot in behind the identical five methods.
 *
 * Three invariants the rest of the app can rely on:
 *
 *   1. Every rail speaks in integer minor units (USD cents) + an explicit currency.
 *      No floats, ever.
 *   2. Every rail's terminal-ish outcomes normalise into ONE event union
 *      (`RailEvent`), so the ledger's state machine is written once, not per rail.
 *      "Returned" is a first-class event with a structured reason, because on ACH
 *      the return IS the product surface.
 *   3. Settlement is DELAYED and the rail is the only thing that knows when it
 *      happened. `settledAt` is never inferred by the caller from `submittedAt`.
 *
 * The `returned` event is modelled as a *reversal of a previously-settled or
 * previously-submitted transfer*, not as a failure of the original instruction.
 * That distinction is what makes the ledger correct: a return debits the balance
 * a second time, it does not un-write history.
 *
 * Provider implemented below: INCREASE (sandbox). See NOTES.md for why.
 * Shapes marked `// UNVERIFIED:` were derived from docs but not exercised against
 * a live sandbox key.
 */

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** ISO-4217. USDC is modelled as its own code so a stablecoin rail can't be
 *  silently mixed with fiat in the ledger. */
export type Currency = 'USD' | 'USDC';

export interface Money {
  /** Integer minor units. USD -> cents. USDC -> 1e-6 units ("micro-USDC"). */
  readonly amount: number;
  readonly currency: Currency;
}

// ---------------------------------------------------------------------------
// Rail identity + capabilities
// ---------------------------------------------------------------------------

export type RailKind = 'ach' | 'wire' | 'rtp' | 'card' | 'usdc' | 'internal';

/**
 * Static description of what a rail can do. The app uses this to decide which
 * rails to offer for a given payout, and to decide whether it must wait for a
 * return window before releasing funds.
 */
export interface RailCapabilities {
  readonly kind: RailKind;
  /** Stable slug, e.g. "increase.ach". Persisted on every ledger row. */
  readonly provider: string;
  readonly supportsCredit: boolean;
  readonly supportsDebit: boolean;
  /** True when funds can be clawed back by the network after settlement
   *  (ACH: yes, 2–60 days. Wire/RTP/USDC: no. Card: yes, via chargeback). */
  readonly supportsReturns: boolean;
  /** How long after settlement a return can still arrive. Drives hold release.
   *  Null when returns are impossible. */
  readonly returnWindowDays: number | null;
  readonly supportsIdempotency: boolean;
  /** Whether the rail can tell us about corrected account details (ACH NOC/COR,
   *  card account updater). */
  readonly supportsAccountCorrection: boolean;
}

// ---------------------------------------------------------------------------
// Destinations — the one place rail-specific detail is allowed
// ---------------------------------------------------------------------------

export type AchAccountType = 'checking' | 'savings';

/** Who the counterparty is, for network-level compliance coding. */
export type AccountHolderKind = 'business' | 'individual' | 'unknown';

/**
 * How the payment was authorised by the counterparty. The ACH adapter maps this
 * to a Nacha SEC code; other rails mostly ignore it. Keeping it as *intent*
 * rather than as a literal "CCD" string means the card and USDC adapters aren't
 * forced to understand Nacha.
 */
export type AuthorizationKind =
  /** Business-to-business, contract-backed. -> CCD */
  | 'business_agreement'
  /** Consumer, signed/recurring authorisation on file. -> PPD */
  | 'consumer_written'
  /** Consumer, authorised online or in-app. -> WEB */
  | 'consumer_online'
  /** B2B with structured remittance addenda. -> CTX */
  | 'business_remittance';

export type Destination =
  | {
      readonly type: 'ach';
      /** 9-digit ABA. Supply this + accountNumber, OR externalAccountId. */
      readonly routingNumber?: string;
      readonly accountNumber?: string;
      /** Provider-side stored counterparty (Increase External Account, MT
       *  external_account, Moov paymentMethodID). Preferred in production so
       *  raw PANs/account numbers never re-enter our request path. */
      readonly externalAccountId?: string;
      readonly accountType?: AchAccountType;
      readonly holderName: string;
      readonly holderKind?: AccountHolderKind;
      readonly authorization: AuthorizationKind;
    }
  | {
      readonly type: 'card';
      /** Network token / provider card id. Never a raw PAN. */
      readonly cardTokenId: string;
      readonly holderName?: string;
    }
  | {
      readonly type: 'usdc';
      readonly chain: 'ethereum' | 'base' | 'solana' | 'polygon';
      readonly address: string;
    }
  | {
      readonly type: 'internal';
      /** Another account on the same provider — book transfer, settles instantly. */
      readonly accountId: string;
    };

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface TransferRequest {
  /** OUR id for this instruction. Doubles as the idempotency key. Must be
   *  stable across retries and unique across all attempts of distinct intents. */
  readonly clientReferenceId: string;
  /** The funding/receiving account on OUR side, at the provider. */
  readonly sourceAccountId: string;
  readonly destination: Destination;
  readonly amount: Money;
  /** <=10 chars on ACH; shows on the counterparty's bank statement. */
  readonly statementDescriptor: string;
  /** Free-text shown to the counterparty where the rail supports it. */
  readonly description?: string;
  /** Earliest date we want the money to land. Rails that can't honour it ignore it. */
  readonly effectiveDate?: string; // YYYY-MM-DD
  /** Opaque; echoed back on events where the rail supports metadata. */
  readonly metadata?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Normalised transfer state
// ---------------------------------------------------------------------------

/**
 * The rail-agnostic state machine. Every provider status maps onto exactly one
 * of these. Note that `settled` is NOT terminal — `returned` and `reversed`
 * follow it. Only `failed`, `canceled` and `returned` are terminal.
 *
 *   created -> pending_approval? -> submitted -> settled -> returned
 *          \-> canceled          \-> failed
 */
export type RailTransferStatus =
  /** Accepted by the provider, not yet handed to the network. */
  | 'created'
  /** Held for our own or the provider's approval/review. */
  | 'pending_approval'
  /** Handed to the network; irrevocable from our side. */
  | 'submitted'
  /** Funds have moved at the network. Return window may still be open. */
  | 'settled'
  /** Network gave the money back. Terminal; see `returnReason`. */
  | 'returned'
  /** Never made it to the network. Terminal. */
  | 'failed'
  /** Withdrawn before submission. Terminal. */
  | 'canceled';

export type TransferDirection = 'credit' | 'debit';

export interface RailTransfer {
  readonly provider: string;
  readonly railKind: RailKind;
  /** Provider's id. Store this; it is the join key for webhooks. */
  readonly id: string;
  readonly clientReferenceId?: string;
  readonly direction: TransferDirection;
  readonly status: RailTransferStatus;
  readonly amount: Money;
  readonly createdAt: string; // ISO-8601
  readonly submittedAt?: string;
  /** Set only once the network actually settled. Never guessed. */
  readonly settledAt?: string;
  readonly returnedAt?: string;
  readonly returnReason?: RailReturnReason;
  /** Present when the counterparty's bank told us their details changed. */
  readonly corrections?: readonly AccountCorrection[];
  /** Whatever the provider gave us, untouched — for debugging and audit. */
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Returns — the part the whole design hangs on
// ---------------------------------------------------------------------------

/**
 * Semantic buckets. The app routes on THIS, not on the raw code, so the same
 * retry/dunning logic works for an ACH R01 and a card `insufficient_funds`
 * decline and a USDC reverted transfer.
 */
export type ReturnCategory =
  /** Money wasn't there. Safe and sensible to retry later. (R01, R09) */
  | 'insufficient_funds'
  /** The account does not exist / is closed. Never retry; ask for new details. (R02, R03, R04) */
  | 'account_invalid'
  /** Counterparty disputes the authorisation. Never retry; escalate. (R05, R07, R08, R10, R29) */
  | 'unauthorized'
  /** We sent something malformed. Fixable by us. (R13, R17, R19, R28) */
  | 'invalid_request'
  /** Blocked for compliance/sanctions. Never retry; escalate. (R16) */
  | 'blocked'
  /** Bank-side or network-side problem. Retryable. */
  | 'provider_error'
  | 'unknown';

export interface RailReturnReason {
  /** Normalised bucket — branch on this. */
  readonly category: ReturnCategory;
  /**
   * Network-native code, uppercased and canonical where one exists:
   * ACH -> "R01" | "R02" | "R03" | ...
   * Card -> the decline/chargeback reason code.
   * USDC -> "REVERTED" | "INSUFFICIENT_GAS" | ...
   * Null when the provider genuinely gave us nothing.
   */
  readonly code: string | null;
  /** Exactly what the provider said, so nothing is lost in normalisation.
   *  e.g. Increase's `insufficient_fund` (note: singular). */
  readonly providerCode: string | null;
  readonly description?: string;
  /** Whether a fresh attempt on the same details could plausibly succeed. */
  readonly retryable: boolean;
}

/** ACH NOC/COR, card account-updater, etc. */
export interface AccountCorrection {
  readonly field: 'routing_number' | 'account_number' | 'account_type' | 'individual_id' | 'other';
  readonly correctedValue: string;
  readonly code?: string; // e.g. "C01"
  readonly receivedAt?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Common envelope so the ledger can dedupe and order without a per-rail switch. */
interface RailEventBase {
  readonly provider: string;
  readonly railKind: RailKind;
  /** Provider's event id. UNIQUE — persist it and drop duplicates. Webhooks
   *  WILL be redelivered. */
  readonly eventId: string;
  /** Provider transfer id this event is about. */
  readonly transferId: string;
  readonly occurredAt: string; // ISO-8601
  readonly raw: unknown;
}

export type RailEvent =
  | (RailEventBase & { readonly type: 'transfer.created'; readonly status: RailTransferStatus })
  | (RailEventBase & { readonly type: 'transfer.submitted'; readonly submittedAt: string })
  | (RailEventBase & { readonly type: 'transfer.settled'; readonly settledAt: string })
  | (RailEventBase & {
      readonly type: 'transfer.returned';
      readonly returnedAt: string;
      readonly reason: RailReturnReason;
    })
  | (RailEventBase & {
      readonly type: 'transfer.failed';
      readonly reason: RailReturnReason;
    })
  | (RailEventBase & { readonly type: 'transfer.canceled' })
  | (RailEventBase & {
      readonly type: 'transfer.correction';
      readonly corrections: readonly AccountCorrection[];
    })
  /**
   * Anything we recognise as ours but don't model yet. Emitting this instead of
   * throwing keeps the webhook endpoint returning 200, which stops providers
   * from disabling the subscription. Log and move on.
   */
  | (RailEventBase & { readonly type: 'unknown'; readonly providerType: string });

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

export interface WebhookVerificationInput {
  /** The RAW request body bytes/string, byte-for-byte as received. Verifying a
   *  re-serialised JSON object is the classic way to get this wrong. */
  readonly rawBody: string;
  /** Lower-cased header map. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Seconds of clock skew tolerated. Default 300. */
  readonly toleranceSeconds?: number;
}

export type WebhookVerification =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'bad_signature' | 'stale_timestamp' | 'malformed' };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class RailError extends Error {
  constructor(
    message: string,
    readonly opts: {
      readonly provider: string;
      readonly code: string;
      readonly httpStatus?: number;
      /** True for 429/5xx/network — the caller may retry with the SAME
       *  idempotency key. False for validation errors. */
      readonly retryable: boolean;
      readonly raw?: unknown;
    },
  ) {
    super(message);
    this.name = 'RailError';
  }
}

// ---------------------------------------------------------------------------
// THE INTERFACE
// ---------------------------------------------------------------------------

/**
 * Five methods. ACH, card and USDC all fit behind them.
 *
 * Everything the app does with money is: push, pull, ask, authenticate a
 * callback, interpret a callback. Anything a specific rail can do beyond that
 * (ACH prenotes, card 3DS, USDC gas policy) belongs in that adapter's own
 * surface, NOT here — widening this interface for one rail is how adapters rot
 * into schemas.
 */
export interface PaymentRail {
  readonly capabilities: RailCapabilities;

  /** Push money out. MUST be idempotent on `req.clientReferenceId`. */
  initiateCredit(req: TransferRequest): Promise<RailTransfer>;

  /** Pull money in. Rejects with a non-retryable RailError when
   *  `capabilities.supportsDebit` is false. */
  initiateDebit(req: TransferRequest): Promise<RailTransfer>;

  /** Authoritative read-back. Used for reconciliation sweeps and for repairing
   *  state after a missed webhook — never trust webhooks alone. */
  getTransfer(transferId: string): Promise<RailTransfer>;

  /** Constant-time signature + timestamp check over the RAW body. */
  verifyWebhook(input: WebhookVerificationInput): WebhookVerification;

  /** Raw body -> normalised event. Must never throw on an unrecognised payload;
   *  return `{ type: 'unknown' }` instead. */
  parseEvent(rawBody: string): RailEvent;
}

// ===========================================================================
// INCREASE ADAPTER
// ===========================================================================
//
// Docs:
//   https://increase.com/documentation/api/overview
//   https://increase.com/documentation/api/ach-transfers
//   https://increase.com/documentation/webhooks
//   https://increase.com/documentation/sandbox
//
// Sandbox base URL: https://sandbox.increase.com
// Auth:             Authorization: Bearer <key>
// Idempotency:      Idempotency-Key: <uuid>   (replay -> 200 + Idempotent-Replayed: true)
//
// Increase's model is unusually clean for this interface: ONE endpoint,
// POST /ach_transfers, does both directions. A positive `amount` is a credit
// (push), a negative `amount` is a debit (pull). So initiateCredit and
// initiateDebit differ only in a sign.
//
// ---------------------------------------------------------------------------

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface IncreaseConfig {
  readonly apiKey: string;
  /** https://sandbox.increase.com or https://api.increase.com */
  readonly baseUrl?: string;
  /** `shared_secret` from the Event Subscription. */
  readonly webhookSecret: string;
  readonly fetchImpl?: typeof fetch;
}

type IncreaseSecCode =
  | 'corporate_credit_or_debit'
  | 'corporate_trade_exchange'
  | 'prearranged_payments_and_deposit'
  | 'internet_initiated';

const SEC_CODE_BY_AUTHORIZATION: Record<AuthorizationKind, IncreaseSecCode> = {
  business_agreement: 'corporate_credit_or_debit', // CCD
  business_remittance: 'corporate_trade_exchange', // CTX
  consumer_written: 'prearranged_payments_and_deposit', // PPD
  consumer_online: 'internet_initiated', // WEB
};

/**
 * Increase ACH transfer statuses -> our normalised statuses.
 *
 * The important subtlety: Increase has NO `settled` status. A settled transfer
 * stays `submitted` and grows a `settlement.settled_at` timestamp. So the status
 * mapping alone is not enough — `mapTransfer` checks `settlement` too. Getting
 * this wrong means never releasing a hold.
 */
const INCREASE_STATUS: Record<string, RailTransferStatus> = {
  pending_approval: 'pending_approval',
  pending_transfer_session_confirmation: 'pending_approval',
  pending_reviewing: 'pending_approval',
  pending_submission: 'created',
  submitted: 'submitted',
  returned: 'returned',
  rejected: 'failed',
  requires_attention: 'failed', // conservative: surface it to an operator
  canceled: 'canceled',
};

/**
 * Increase's `return.return_reason_code` is a snake_case name, not the raw
 * "R01". `return.raw_return_reason_code` carries the Nacha string. We normalise
 * both. Note Increase spells R01 `insufficient_fund` — SINGULAR.
 *
 * UNVERIFIED: the R-code numbers below are the Nacha mapping for each named
 * Increase enum member; the enum member names themselves are from the docs, but
 * only R01/R02/R03 were confirmed against the ACH-returns page.
 */
const INCREASE_RETURN_CODES: Record<string, { r: string; category: ReturnCategory; retryable: boolean }> = {
  insufficient_fund: { r: 'R01', category: 'insufficient_funds', retryable: true },
  account_closed: { r: 'R02', category: 'account_invalid', retryable: false },
  no_account: { r: 'R03', category: 'account_invalid', retryable: false },
  invalid_account_number_structure: { r: 'R04', category: 'account_invalid', retryable: false },
  unauthorized_debit_to_consumer_account_using_corporate_sec_code: {
    r: 'R05',
    category: 'unauthorized',
    retryable: false,
  },
  returned_per_odfi_request: { r: 'R06', category: 'provider_error', retryable: false },
  authorization_revoked_by_customer: { r: 'R07', category: 'unauthorized', retryable: false },
  payment_stopped: { r: 'R08', category: 'unauthorized', retryable: false },
  uncollected_funds: { r: 'R09', category: 'insufficient_funds', retryable: true },
  customer_advised_unauthorized_improper_ineligible_or_incomplete: {
    r: 'R10',
    category: 'unauthorized',
    retryable: false,
  },
  customer_advised_not_within_authorization_terms: { r: 'R11', category: 'unauthorized', retryable: false },
  non_transaction_account: { r: 'R20', category: 'account_invalid', retryable: false },
  invalid_company_id: { r: 'R21', category: 'invalid_request', retryable: false },
  account_frozen_entry_returned_per_ofac_instruction: { r: 'R16', category: 'blocked', retryable: false },
  credit_entry_refused_by_receiver: { r: 'R23', category: 'unauthorized', retryable: false },
  duplicate_entry: { r: 'R24', category: 'invalid_request', retryable: false },
  addenda_error: { r: 'R25', category: 'invalid_request', retryable: false },
  mandatory_field_error: { r: 'R26', category: 'invalid_request', retryable: false },
  trace_number_error: { r: 'R27', category: 'invalid_request', retryable: false },
  routing_number_check_digit_error: { r: 'R28', category: 'invalid_request', retryable: false },
  corporate_customer_advised_not_authorized: { r: 'R29', category: 'unauthorized', retryable: false },
  beneficiary_or_account_holder_deceased: { r: 'R14', category: 'account_invalid', retryable: false },
  invalid_ach_routing_number: { r: 'R13', category: 'invalid_request', retryable: false },
  account_sold_to_another_dfi: { r: 'R12', category: 'account_invalid', retryable: false },
};

function mapReturnReason(ret: IncreaseReturn | null | undefined): RailReturnReason {
  if (!ret) {
    return { category: 'unknown', code: null, providerCode: null, retryable: false };
  }
  const known = INCREASE_RETURN_CODES[ret.return_reason_code];
  return {
    category: known?.category ?? 'unknown',
    // Prefer Increase's own raw Nacha string when present; fall back to our table.
    code: normaliseRCode(ret.raw_return_reason_code) ?? known?.r ?? null,
    providerCode: ret.return_reason_code,
    description: ret.return_reason_code.replace(/_/g, ' '),
    retryable: known?.retryable ?? false,
  };
}

function normaliseRCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^R?(\d{2})$/.exec(raw.trim().toUpperCase());
  return m ? `R${m[1]}` : raw.trim().toUpperCase();
}

// --- Increase wire shapes (UNVERIFIED: field-by-field, from docs not a live key) ---

interface IncreaseReturn {
  readonly created_at: string;
  readonly raw_return_reason_code: string | null;
  readonly return_reason_code: string;
  readonly trace_number: string | null;
  readonly transaction_id: string | null;
  readonly transfer_id: string;
  readonly addenda_information?: string | null;
}

interface IncreaseNotificationOfChange {
  readonly created_at: string;
  readonly change_code: string;
  readonly corrected_data: string;
}

interface IncreaseAchTransfer {
  readonly id: string;
  readonly type: 'ach_transfer';
  readonly account_id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly created_at: string;
  readonly idempotency_key: string | null;
  readonly routing_number: string | null;
  readonly account_number: string | null;
  readonly external_account_id: string | null;
  readonly standard_entry_class_code: IncreaseSecCode;
  readonly statement_descriptor: string;
  readonly acknowledgement: { readonly acknowledged_at: string } | null;
  readonly submission: { readonly submitted_at: string; readonly trace_number: string } | null;
  readonly settlement: { readonly settled_at: string } | null;
  readonly return: IncreaseReturn | null;
  readonly notifications_of_change: readonly IncreaseNotificationOfChange[];
  readonly transaction_id: string | null;
}

interface IncreaseEvent {
  readonly id: string;
  readonly type: 'event';
  readonly category: string; // e.g. "ach_transfer.updated"
  readonly associated_object_id: string;
  readonly associated_object_type: string;
  readonly created_at: string;
}

// --- The adapter ---

export class IncreaseAchRail implements PaymentRail {
  readonly capabilities: RailCapabilities = {
    kind: 'ach',
    provider: 'increase.ach',
    supportsCredit: true,
    supportsDebit: true,
    supportsReturns: true,
    // 2 business days for commercial, 60 calendar days for consumer
    // (unauthorised). Hold to the worst case for consumer debits.
    returnWindowDays: 60,
    supportsIdempotency: true,
    supportsAccountCorrection: true,
  };

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: IncreaseConfig) {
    this.baseUrl = cfg.baseUrl ?? 'https://sandbox.increase.com';
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  // -- writes ---------------------------------------------------------------

  initiateCredit(req: TransferRequest): Promise<RailTransfer> {
    return this.createAchTransfer(req, 'credit');
  }

  initiateDebit(req: TransferRequest): Promise<RailTransfer> {
    return this.createAchTransfer(req, 'debit');
  }

  private async createAchTransfer(req: TransferRequest, direction: TransferDirection): Promise<RailTransfer> {
    if (req.destination.type !== 'ach') {
      throw new RailError(`increase.ach cannot pay a "${req.destination.type}" destination`, {
        provider: this.capabilities.provider,
        code: 'unsupported_destination',
        retryable: false,
      });
    }
    if (req.amount.currency !== 'USD') {
      throw new RailError(`increase.ach is USD-only, got ${req.amount.currency}`, {
        provider: this.capabilities.provider,
        code: 'unsupported_currency',
        retryable: false,
      });
    }
    if (req.amount.amount <= 0) {
      throw new RailError('amount must be a positive integer number of cents', {
        provider: this.capabilities.provider,
        code: 'invalid_amount',
        retryable: false,
      });
    }

    const d = req.destination;
    // THE sign convention: positive pushes, negative pulls.
    const signedAmount = direction === 'credit' ? req.amount.amount : -req.amount.amount;

    const body: Record<string, unknown> = {
      account_id: req.sourceAccountId,
      amount: signedAmount,
      statement_descriptor: req.statementDescriptor,
      standard_entry_class_code: SEC_CODE_BY_AUTHORIZATION[d.authorization],
      individual_name: d.holderName,
      destination_account_holder: d.holderKind ?? 'unknown',
    };

    // Either a stored External Account, or raw routing + account numbers.
    if (d.externalAccountId) {
      body.external_account_id = d.externalAccountId;
    } else if (d.routingNumber && d.accountNumber) {
      body.routing_number = d.routingNumber;
      body.account_number = d.accountNumber;
      if (d.accountType) body.funding = d.accountType; // "checking" | "savings"
    } else {
      throw new RailError('ach destination needs externalAccountId or routingNumber+accountNumber', {
        provider: this.capabilities.provider,
        code: 'invalid_destination',
        retryable: false,
      });
    }

    if (req.effectiveDate) {
      // UNVERIFIED: exact nesting of preferred_effective_date.
      body.preferred_effective_date = { date: req.effectiveDate };
    }

    const transfer = await this.request<IncreaseAchTransfer>('POST', '/ach_transfers', {
      body,
      idempotencyKey: req.clientReferenceId,
    });
    return this.mapTransfer(transfer, req.clientReferenceId);
  }

  // -- reads ----------------------------------------------------------------

  async getTransfer(transferId: string): Promise<RailTransfer> {
    const t = await this.request<IncreaseAchTransfer>('GET', `/ach_transfers/${encodeURIComponent(transferId)}`);
    return this.mapTransfer(t);
  }

  // -- webhooks -------------------------------------------------------------

  /**
   * Increase implements the Standard Webhooks spec.
   *
   *   headers: webhook-id, webhook-timestamp (unix seconds), webhook-signature
   *   signed payload: `${webhook-id}.${webhook-timestamp}.${rawBody}`
   *   signature: "v1," + base64(HMAC-SHA256(shared_secret, signedPayload))
   *   the webhook-signature header may hold SEVERAL space-separated signatures
   *   (secret rotation) — accept if ANY matches.
   */
  verifyWebhook(input: WebhookVerificationInput): WebhookVerification {
    const id = input.headers['webhook-id'];
    const ts = input.headers['webhook-timestamp'];
    const sigHeader = input.headers['webhook-signature'];
    if (!id || !ts || !sigHeader) return { ok: false, reason: 'malformed' };

    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return { ok: false, reason: 'malformed' };
    const tolerance = input.toleranceSeconds ?? 300;
    if (Math.abs(Date.now() / 1000 - tsNum) > tolerance) {
      return { ok: false, reason: 'stale_timestamp' };
    }

    const signedPayload = `${id}.${ts}.${input.rawBody}`;
    const expected =
      'v1,' + createHmac('sha256', this.cfg.webhookSecret).update(signedPayload, 'utf8').digest('base64');

    const presented = sigHeader.split(' ');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const matched = presented.some((s) => {
      const b = Buffer.from(s, 'utf8');
      return b.length === expectedBuf.length && timingSafeEqual(b, expectedBuf);
    });
    return matched ? { ok: true } : { ok: false, reason: 'bad_signature' };
  }

  /**
   * Increase webhook bodies are the *Event* object — an id, a category, and a
   * pointer to the object that changed. They carry NO transfer state.
   *
   * That means `parseEvent` alone can only tell you "ach_transfer X changed".
   * To get submitted/settled/returned you must then call `getTransfer(X)`.
   * That is a feature, not a bug: it makes the read-back authoritative and makes
   * out-of-order webhook delivery harmless. `parseEventWithTransfer` is the
   * two-step version, and is what the webhook route should actually call.
   */
  parseEvent(rawBody: string): RailEvent {
    let ev: IncreaseEvent;
    try {
      ev = JSON.parse(rawBody) as IncreaseEvent;
    } catch {
      return this.unknownEvent('', '', 'unparseable', rawBody);
    }
    if (!ev?.id || !ev?.category) {
      return this.unknownEvent('', '', 'malformed', ev);
    }
    if (ev.category === 'ach_transfer.created') {
      return {
        provider: this.capabilities.provider,
        railKind: 'ach',
        eventId: ev.id,
        transferId: ev.associated_object_id,
        occurredAt: ev.created_at,
        type: 'transfer.created',
        status: 'created',
        raw: ev,
      };
    }
    // ach_transfer.updated and everything else needs the object to interpret.
    return this.unknownEvent(ev.id, ev.associated_object_id, ev.category, ev);
  }

  /**
   * The real entry point for the webhook route:
   *   verifyWebhook -> parseEventWithTransfer -> apply to ledger (dedupe on eventId).
   */
  async parseEventWithTransfer(rawBody: string): Promise<RailEvent> {
    const shallow = this.parseEvent(rawBody);
    const ev = JSON.parse(rawBody) as IncreaseEvent;
    if (!ev?.associated_object_id?.startsWith('ach_transfer_')) return shallow;

    const t = await this.getTransfer(ev.associated_object_id);
    const base = {
      provider: this.capabilities.provider,
      railKind: 'ach' as const,
      eventId: ev.id,
      transferId: t.id,
      occurredAt: ev.created_at,
      raw: { event: ev, transfer: t.raw },
    };

    if (t.corrections?.length) {
      return { ...base, type: 'transfer.correction', corrections: t.corrections };
    }
    switch (t.status) {
      case 'returned':
        return {
          ...base,
          type: 'transfer.returned',
          returnedAt: t.returnedAt ?? ev.created_at,
          reason: t.returnReason ?? { category: 'unknown', code: null, providerCode: null, retryable: false },
        };
      case 'settled':
        return { ...base, type: 'transfer.settled', settledAt: t.settledAt ?? ev.created_at };
      case 'submitted':
        return { ...base, type: 'transfer.submitted', submittedAt: t.submittedAt ?? ev.created_at };
      case 'canceled':
        return { ...base, type: 'transfer.canceled' };
      case 'failed':
        return {
          ...base,
          type: 'transfer.failed',
          reason: t.returnReason ?? {
            category: 'provider_error',
            code: null,
            providerCode: null,
            retryable: false,
          },
        };
      default:
        return { ...base, type: 'transfer.created', status: t.status };
    }
  }

  // -- sandbox-only helpers -------------------------------------------------
  //
  // Not part of PaymentRail on purpose: test affordances do not belong in the
  // production interface. Integration tests reach for these directly.

  /** Move a `pending_submission` transfer to `submitted`. */
  simulateSubmit(transferId: string): Promise<IncreaseAchTransfer> {
    return this.request('POST', `/simulations/ach_transfers/${encodeURIComponent(transferId)}/submit`, { body: {} });
  }

  /** Add the `acknowledgement` sub-object (FedACH said "got it"). */
  simulateAcknowledge(transferId: string): Promise<IncreaseAchTransfer> {
    return this.request('POST', `/simulations/ach_transfers/${encodeURIComponent(transferId)}/acknowledge`, {
      body: {},
    });
  }

  /** Stamp `settlement.settled_at`. Status stays `submitted`. */
  simulateSettle(transferId: string, inboundFundsHoldBehavior?: 'currently_holding' | 'holdless'): Promise<IncreaseAchTransfer> {
    return this.request('POST', `/simulations/ach_transfers/${encodeURIComponent(transferId)}/settle`, {
      // UNVERIFIED: exact enum values for inbound_funds_hold_behavior.
      body: inboundFundsHoldBehavior ? { inbound_funds_hold_behavior: inboundFundsHoldBehavior } : {},
    });
  }

  /**
   * THE ONE THAT MATTERS. Force a return with a chosen reason code.
   *   simulateReturn(id, 'insufficient_fund')  -> R01
   *   simulateReturn(id, 'account_closed')     -> R02
   *   simulateReturn(id, 'no_account')         -> R03
   */
  simulateReturn(transferId: string, reason: keyof typeof INCREASE_RETURN_CODES | string, addendaInformation?: string): Promise<IncreaseAchTransfer> {
    return this.request('POST', `/simulations/ach_transfers/${encodeURIComponent(transferId)}/return`, {
      body: addendaInformation ? { reason, addenda_information: addendaInformation } : { reason },
    });
  }

  /** Simulate a Notification of Change (NOC/COR) from the receiving bank. */
  simulateNotificationOfChange(
    transferId: string,
    corrected: {
      corrected_routing_number?: string;
      corrected_account_number?: string;
      corrected_account_funding?: string;
      corrected_individual_id?: string;
    },
  ): Promise<IncreaseAchTransfer> {
    return this.request(
      'POST',
      `/simulations/ach_transfers/${encodeURIComponent(transferId)}/create_notification_of_change`,
      { body: corrected },
    );
  }

  /** Simulate someone ELSE sending us money (or debiting us).
   *  Negative amount = an inbound debit pulling funds from us. */
  simulateInboundAch(params: {
    account_number_id: string;
    amount: number;
    standard_entry_class_code?: IncreaseSecCode;
    company_name?: string;
    receiver_name?: string;
    resolve_at?: string;
  }): Promise<unknown> {
    return this.request('POST', '/simulations/inbound_ach_transfers', { body: params });
  }

  // -- plumbing -------------------------------------------------------------

  private mapTransfer(t: IncreaseAchTransfer, clientReferenceId?: string): RailTransfer {
    const mapped = INCREASE_STATUS[t.status] ?? 'created';
    // Increase has no `settled` status; settlement is a timestamp on a
    // still-`submitted` transfer. Promote it here so the ledger sees one machine.
    const status: RailTransferStatus =
      mapped === 'submitted' && t.settlement?.settled_at ? 'settled' : mapped;

    return {
      provider: this.capabilities.provider,
      railKind: 'ach',
      id: t.id,
      clientReferenceId: clientReferenceId ?? t.idempotency_key ?? undefined,
      direction: t.amount < 0 ? 'debit' : 'credit',
      status,
      amount: { amount: Math.abs(t.amount), currency: 'USD' },
      createdAt: t.created_at,
      submittedAt: t.submission?.submitted_at ?? t.acknowledgement?.acknowledged_at ?? undefined,
      settledAt: t.settlement?.settled_at ?? undefined,
      returnedAt: t.return?.created_at ?? undefined,
      returnReason: t.return ? mapReturnReason(t.return) : undefined,
      corrections: (t.notifications_of_change ?? []).map((n) => ({
        // UNVERIFIED: change_code -> field mapping; C01=account number,
        // C02=routing number, C03=both, C05=account type.
        field:
          n.change_code === 'C01'
            ? ('account_number' as const)
            : n.change_code === 'C02'
              ? ('routing_number' as const)
              : n.change_code === 'C05'
                ? ('account_type' as const)
                : ('other' as const),
        correctedValue: n.corrected_data,
        code: n.change_code,
        receivedAt: n.created_at,
      })),
      raw: t,
    };
  }

  private unknownEvent(eventId: string, transferId: string, providerType: string, raw: unknown): RailEvent {
    return {
      provider: this.capabilities.provider,
      railKind: 'ach',
      eventId,
      transferId,
      occurredAt: new Date().toISOString(),
      type: 'unknown',
      providerType,
      raw,
    };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (cause) {
      throw new RailError(`network error calling ${method} ${path}`, {
        provider: this.capabilities.provider,
        code: 'network_error',
        retryable: true, // safe: same Idempotency-Key on retry
        raw: cause,
      });
    }

    const text = await res.text();
    if (!res.ok) {
      // RFC 9457 problem detail: { type, title, status, detail }
      let problem: { type?: string; title?: string; detail?: string } = {};
      try {
        problem = JSON.parse(text);
      } catch {
        /* keep the raw text */
      }
      throw new RailError(problem.title ?? `Increase ${res.status}`, {
        provider: this.capabilities.provider,
        code: problem.type ?? `http_${res.status}`,
        httpStatus: res.status,
        // 409 idempotency_key_already_used_error is a BUG in our key generation,
        // never a retry.
        retryable: res.status === 429 || res.status >= 500,
        raw: text,
      });
    }
    return JSON.parse(text) as T;
  }
}

// ---------------------------------------------------------------------------
// Sketch: the same interface over a card rail and a USDC rail.
// Not implemented — here to prove the interface doesn't leak ACH.
// ---------------------------------------------------------------------------
//
//   class StripeCardRail implements PaymentRail {
//     capabilities = { kind: 'card', provider: 'stripe.card', supportsCredit: true,
//       supportsDebit: true, supportsReturns: true, returnWindowDays: 120,
//       supportsIdempotency: true, supportsAccountCorrection: true };
//     // initiateDebit -> PaymentIntent; initiateCredit -> Payout/Transfer.
//     // a chargeback maps to { type: 'transfer.returned',
//     //   reason: { category: 'unauthorized', code: '10.4', ... } }
//   }
//
//   class CircleUsdcRail implements PaymentRail {
//     capabilities = { kind: 'usdc', provider: 'circle.usdc', supportsCredit: true,
//       supportsDebit: false, supportsReturns: false, returnWindowDays: null,
//       supportsIdempotency: true, supportsAccountCorrection: false };
//     // initiateDebit throws unsupported. 'transfer.settled' fires on N
//     // confirmations. 'transfer.returned' is never emitted — irreversible.
//   }
