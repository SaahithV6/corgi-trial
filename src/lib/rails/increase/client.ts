/**
 * Increase ACH rail — the LIVE adapter.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HONESTY NOTE. This adapter has NEVER been executed against a real         │
 * │ Increase key. Every wire shape below is derived from the public docs      │
 * │ (research/ach/NOTES.md, fetched 2026-09-09) and is marked [DOCS]; nothing │
 * │ in this file is marked [MEASURED], because nothing here has been          │
 * │ measured. Contrast `../lithic/`, where the traps carry [MEASURED] and     │
 * │ DECISIONS 006 records the session that produced them. Anything this file  │
 * │ produces is `evidence: 'live'` — but until a key exists, this code path   │
 * │ does not run, and the ACH slot is served by `../achsim/`, which says      │
 * │ `evidence: 'simulated'` on every value it returns.                        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * SERVER ONLY. Reads `INCREASE_API_KEY` at call time, never at import time, so
 * a rotated key is picked up without a restart and the value is never captured
 * in module scope where a heap dump could find it. (`server-only` is
 * deliberately not imported so the module stays testable under vitest's node
 * environment; the route layer that consumes it carries that import.)
 *
 * No SDK. `fetch` and nothing else.
 *
 * Auth:        Authorization: Bearer <key>
 * Sandbox:     https://sandbox.increase.com     Production: https://api.increase.com
 * Idempotency: Idempotency-Key: <our clientReferenceId>
 *              A replay with identical params returns the ORIGINAL object, 200,
 *              plus `Idempotent-Replayed: true`. A replay with different params
 *              is a 409 and a bug in our key generation, never a retry.
 * Errors:      RFC 9457 problem details, `{ type, title, status, detail }`.
 *
 * Two things worth reading before touching this file:
 *
 *   1. THERE IS NO `settled` STATUS. See `mapTransfer`.
 *   2. THE WEBHOOK BODY IS A POINTER, NOT A PAYLOAD. See `parseEvent`.
 */

import {
  RailError,
  type AccountCorrection,
  type AuthorizationKind,
  type Evidence,
  type Money,
  type PaymentRail,
  type RailCapabilities,
  type RailEnvironment,
  type RailEvent,
  type RailReturnReason,
  type RailTransfer,
  type RailTransferStatus,
  type ReturnCategory,
  type TransferDirection,
  type TransferRequest,
} from '../types';

export const INCREASE_SANDBOX_BASE_URL = 'https://sandbox.increase.com';
export const INCREASE_PRODUCTION_BASE_URL = 'https://api.increase.com';

/** The slug persisted on every ledger row this adapter produces. */
export const INCREASE_PROVIDER = 'increase.ach';

/**
 * The adapter is unconditionally `live`: it is the real provider's API on the
 * other end of `fetch`. It is a `const`, not a constructor argument, precisely
 * so no configuration mistake can make the live adapter claim to be a simulator
 * or — the direction that actually matters — make anything else claim to be
 * this.
 */
const EVIDENCE: Evidence = 'live';

export interface IncreaseConfig {
  /** Defaults to `process.env.INCREASE_API_KEY`, read at call time. */
  readonly apiKey?: string | undefined;
  /** Defaults to `process.env.INCREASE_BASE_URL`, else the sandbox URL. */
  readonly baseUrl?: string | undefined;
  /** Per-attempt timeout in ms. Defaults to 15s. */
  readonly timeoutMs?: number | undefined;
  /** Injected in tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
}

// ---------------------------------------------------------------------------
// SEC codes — reached through an intent, never named by the caller
// ---------------------------------------------------------------------------

type IncreaseSecCode =
  | 'corporate_credit_or_debit'
  | 'corporate_trade_exchange'
  | 'prearranged_payments_and_deposit'
  | 'internet_initiated';

/**
 * The only place in the repo that knows what a SEC code is. A caller says how
 * the customer authorised the payment; this table says which three letters
 * Nacha wants. The card and USDC adapters never import it.
 */
export const SEC_CODE_BY_AUTHORIZATION: Readonly<Record<AuthorizationKind, IncreaseSecCode>> = {
  business_agreement: 'corporate_credit_or_debit', //        CCD
  consumer_written: 'prearranged_payments_and_deposit', //   PPD
  consumer_online: 'internet_initiated', //                  WEB
  business_remittance: 'corporate_trade_exchange', //        CTX
};

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * [DOCS] Increase's ACH transfer status enum -> ours.
 *
 * Note what is NOT in this table: `settled`. Increase does not have one. The
 * promotion happens in `mapTransfer`, where the settlement timestamp is in
 * scope.
 */
const INCREASE_STATUS: Readonly<Record<string, RailTransferStatus>> = {
  pending_approval: 'pending_approval',
  pending_transfer_session_confirmation: 'pending_approval',
  pending_reviewing: 'pending_approval',
  pending_submission: 'created',
  submitted: 'submitted',
  returned: 'returned',
  rejected: 'failed',
  // No documented API recovery path. Conservative: surface it to an operator
  // as a failure rather than leaving it in a limbo the ledger has no state for.
  requires_attention: 'failed',
  canceled: 'canceled',
};

interface ReturnCodeEntry {
  readonly r: string;
  readonly category: ReturnCategory;
  readonly retryable: boolean;
}

/**
 * [DOCS] Increase's `return.return_reason_code` is a snake_case NAME, not
 * "R01"; `return.raw_return_reason_code` carries the Nacha string. Both are
 * kept: the canonical code goes in `RailReturnReason.code`, the provider's
 * spelling goes in `providerCode` untouched.
 *
 * Increase spells R01 `insufficient_fund` — SINGULAR. That is not a typo here.
 *
 * UNVERIFIED: only R01/R02/R03 were confirmed against Increase's ACH-returns
 * page. The rest are the standard Nacha mapping for each documented enum name.
 * An unrecognised name is not an error — it falls through to category
 * 'unknown', `retryable: false`, with the provider's string preserved.
 */
const INCREASE_RETURN_CODES: Readonly<Record<string, ReturnCodeEntry>> = {
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
  customer_advised_not_within_authorization_terms: {
    r: 'R11',
    category: 'unauthorized',
    retryable: false,
  },
  account_sold_to_another_dfi: { r: 'R12', category: 'account_invalid', retryable: false },
  invalid_ach_routing_number: { r: 'R13', category: 'invalid_request', retryable: false },
  beneficiary_or_account_holder_deceased: { r: 'R14', category: 'account_invalid', retryable: false },
  account_frozen_entry_returned_per_ofac_instruction: { r: 'R16', category: 'blocked', retryable: false },
  non_transaction_account: { r: 'R20', category: 'account_invalid', retryable: false },
  invalid_company_id: { r: 'R21', category: 'invalid_request', retryable: false },
  credit_entry_refused_by_receiver: { r: 'R23', category: 'unauthorized', retryable: false },
  duplicate_entry: { r: 'R24', category: 'invalid_request', retryable: false },
  addenda_error: { r: 'R25', category: 'invalid_request', retryable: false },
  mandatory_field_error: { r: 'R26', category: 'invalid_request', retryable: false },
  trace_number_error: { r: 'R27', category: 'invalid_request', retryable: false },
  routing_number_check_digit_error: { r: 'R28', category: 'invalid_request', retryable: false },
  corporate_customer_advised_not_authorized: { r: 'R29', category: 'unauthorized', retryable: false },
};

/** The reason names this adapter maps. Any other string is still accepted. */
export type IncreaseReturnReasonName = keyof typeof INCREASE_RETURN_CODES;

/** Canonicalise a Nacha code: '01' | 'r01' | 'R01' all become 'R01'. */
export function normaliseRCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  const match = /^R?(\d{2})$/.exec(trimmed);
  return match ? `R${match[1]}` : trimmed;
}

export function mapIncreaseReturnReason(ret: IncreaseReturn | null | undefined): RailReturnReason {
  if (!ret) {
    return { category: 'unknown', code: null, providerCode: null, retryable: false };
  }
  const known = INCREASE_RETURN_CODES[ret.return_reason_code];
  return {
    category: known?.category ?? 'unknown',
    // Prefer Increase's own raw Nacha string; fall back to our table.
    code: normaliseRCode(ret.raw_return_reason_code) ?? known?.r ?? null,
    providerCode: ret.return_reason_code,
    description: ret.return_reason_code.replaceAll('_', ' '),
    retryable: known?.retryable ?? false,
  };
}

/**
 * [DOCS] NOC change codes. C01 account number, C02 routing number, C03 both,
 * C05 transaction/account type, C06/C07 combinations. Anything else is 'other'
 * with the code preserved, because dropping a correction we do not recognise is
 * how a customer's payments keep failing for a reason nobody can see.
 */
function correctionField(changeCode: string): AccountCorrection['field'] {
  switch (changeCode.toUpperCase()) {
    case 'C01':
      return 'account_number';
    case 'C02':
      return 'routing_number';
    case 'C05':
      return 'account_type';
    case 'C09':
      return 'individual_id';
    default:
      return 'other';
  }
}

// ---------------------------------------------------------------------------
// Wire shapes — [DOCS], from increase.com/documentation, not from a live key
// ---------------------------------------------------------------------------

export interface IncreaseReturn {
  readonly created_at: string;
  readonly raw_return_reason_code: string | null;
  readonly return_reason_code: string;
  readonly trace_number: string | null;
  readonly transaction_id: string | null;
  readonly transfer_id: string;
  readonly addenda_information?: string | null;
}

export interface IncreaseNotificationOfChange {
  readonly created_at: string;
  readonly change_code: string;
  readonly corrected_data: string;
}

export interface IncreaseAchTransfer {
  readonly id: string;
  readonly type: 'ach_transfer';
  readonly account_id: string;
  /** Integer USD cents. POSITIVE = credit (push), NEGATIVE = debit (pull). */
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly created_at: string;
  readonly idempotency_key: string | null;
  readonly routing_number: string | null;
  readonly account_number: string | null;
  readonly external_account_id: string | null;
  readonly standard_entry_class_code: string;
  readonly statement_descriptor: string;
  readonly acknowledgement: { readonly acknowledged_at: string } | null;
  readonly submission: { readonly submitted_at: string; readonly trace_number: string } | null;
  /** The trap. See `mapTransfer`. */
  readonly settlement: { readonly settled_at: string } | null;
  readonly return: IncreaseReturn | null;
  readonly notifications_of_change: readonly IncreaseNotificationOfChange[] | null;
  readonly transaction_id: string | null;
}

/**
 * THE INBOUND OBJECT, AND IT IS NOT THE OUTBOUND ONE.
 *
 * MEASURED on the sandbox, 2026-09-11, on
 * `sandbox_inbound_ach_transfer_n8dm6ffh9tijbi27of5b` — a real $2,500.00 credit
 * created with `POST /simulations/inbound_ach_transfers` and then returned with
 * `POST /inbound_ach_transfers/{id}/transfer_return`. The difference is exactly
 * where a value date goes wrong:
 *
 *   outbound `ach_transfer`          inbound `inbound_ach_transfer`
 *   -----------------------------    ------------------------------------
 *   return.created_at                transfer_return.returned_at
 *   return.trace_number              trace_number   (on the object itself)
 *   return.return_reason_code        transfer_return.reason
 *   settlement.settled_at            settlement.settled_at        (same)
 *   -                                effective_date, account_number_id
 *
 * `account_number_id` is the field that says WHICH OF OUR ACCOUNT NUMBERS the
 * originator addressed, and — since `db/migrations/0042_virtual_account_numbers.sql`
 * issued one per business — therefore whose money it is. It was the same single
 * FBO number for every business before that, which is why every inbound credit
 * parked. See `./account-numbers.ts`.
 */
export interface IncreaseInboundAchTransfer {
  readonly id: string;
  /** Integer USD cents, always positive on a credit. */
  readonly amount: number;
  readonly account_id?: string | null;
  readonly account_number_id?: string | null;
  readonly direction?: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly effective_date?: string | null;
  readonly trace_number?: string | null;
  readonly originator_company_name?: string | null;
  readonly originator_company_entry_description?: string | null;
  readonly settlement?: { readonly settled_at?: string | null } | null;
  readonly acceptance?: { readonly accepted_at?: string | null; readonly transaction_id?: string | null } | null;
  readonly decline?: { readonly reason?: string | null } | null;
  readonly transfer_return?: {
    readonly reason?: string | null;
    readonly returned_at?: string | null;
    readonly transaction_id?: string | null;
  } | null;
}

/**
 * [DOCS] One virtual account number. Several hang off one `account_id`, and an
 * inbound payment names the one it was addressed to — which is what makes an
 * inbound credit attributable at all. See `./account-numbers.ts`.
 */
export interface IncreaseAccountNumber {
  readonly id: string;
  readonly account_id: string;
  readonly account_number: string;
  readonly routing_number: string;
  readonly name: string;
  readonly status: string;
  readonly created_at: string;
  readonly idempotency_key: string | null;
  readonly inbound_ach?: { readonly debit_status?: string | null } | null;
}

/**
 * [DOCS] The webhook body. Note what it does NOT contain: any transfer state.
 * It is a pointer. See `parseEvent`.
 */
export interface IncreaseEvent {
  readonly id: string;
  readonly type: 'event';
  /** e.g. 'ach_transfer.updated'. There is no `ach_transfer.returned`. */
  readonly category: string;
  readonly associated_object_id: string;
  readonly associated_object_type: string;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class IncreaseAchRail implements PaymentRail {
  readonly capabilities: RailCapabilities;

  private readonly cfg: IncreaseConfig;

  constructor(cfg: IncreaseConfig = {}) {
    this.cfg = cfg;
    const baseUrl = this.baseUrl();
    const environment: RailEnvironment =
      baseUrl === INCREASE_PRODUCTION_BASE_URL ? 'production' : 'sandbox';
    this.capabilities = {
      kind: 'ach',
      provider: INCREASE_PROVIDER,
      evidence: EVIDENCE,
      environment,
      supportsCredit: true,
      supportsDebit: true,
      supportsReturns: true,
      // 2 business days for a commercial return; 60 CALENDAR days for an
      // unauthorised consumer debit. Held to the worst case the rail permits,
      // because a hold policy sized for the common case is wrong exactly when
      // it matters. See types.ts on `returnWindowDays`.
      returnWindowDays: 60,
      supportsIdempotency: true,
      supportsAccountCorrection: true,
    };
  }

  // -- writes ---------------------------------------------------------------

  initiateCredit(req: TransferRequest): Promise<RailTransfer> {
    return this.createAchTransfer(req, 'credit');
  }

  initiateDebit(req: TransferRequest): Promise<RailTransfer> {
    return this.createAchTransfer(req, 'debit');
  }

  /**
   * ONE ENDPOINT, BOTH DIRECTIONS. `POST /ach_transfers` with a positive
   * `amount` pushes funds; a negative `amount` pulls them. So credit and debit
   * differ by a sign and nothing else.
   */
  private async createAchTransfer(
    req: TransferRequest,
    direction: TransferDirection,
  ): Promise<RailTransfer> {
    const d = req.destination;
    if (d.type !== 'ach') {
      throw this.error(`${INCREASE_PROVIDER} cannot pay a '${d.type}' destination`, {
        code: 'unsupported_destination',
        retryable: false,
      });
    }
    if (req.amount.currency !== 'USD') {
      throw this.error(`${INCREASE_PROVIDER} is USD-only, got ${req.amount.currency}`, {
        code: 'unsupported_currency',
        retryable: false,
      });
    }
    if (req.amount.amount <= 0n) {
      throw this.error('amount must be a positive integer number of cents', {
        code: 'invalid_amount',
        retryable: false,
      });
    }
    // The interface is bigint (USDC needs it); Increase's JSON is a number.
    // This is the ONE conversion site, and it refuses rather than truncates.
    if (req.amount.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw this.error('amount exceeds what Increase can represent in JSON', {
        code: 'invalid_amount',
        retryable: false,
      });
    }
    const magnitude = Number(req.amount.amount);

    const body: Record<string, unknown> = {
      account_id: req.sourceAccountId,
      amount: direction === 'credit' ? magnitude : -magnitude,
      statement_descriptor: req.statementDescriptor,
      standard_entry_class_code: SEC_CODE_BY_AUTHORIZATION[d.authorization],
      // Increase 400s on an individual_name longer than 22 characters, and a
      // 400 here is a payment that does not happen. "Fairbanks Machining LLC"
      // is 23 — a real payee on this book that could not be paid at all.
      //
      // Truncating is the lesser evil and it is what the field is for: a name
      // on a bank statement, not an identifier. Nothing joins on it.
      individual_name: d.holderName.slice(0, 22),
      destination_account_holder: d.holderKind ?? 'unknown',
    };

    // Either a stored External Account, or raw routing + account numbers.
    if (d.externalAccountId) {
      body['external_account_id'] = d.externalAccountId;
    } else if (d.routingNumber && d.accountNumber) {
      body['routing_number'] = d.routingNumber;
      body['account_number'] = d.accountNumber;
      if (d.accountType) body['funding'] = d.accountType;
    } else {
      throw this.error(
        'ach destination needs externalAccountId, or routingNumber and accountNumber',
        { code: 'invalid_destination', retryable: false },
      );
    }

    if (req.description) body['company_entry_description'] = req.description.slice(0, 10);
    // UNVERIFIED: exact nesting of preferred_effective_date.
    if (req.effectiveDate) body['preferred_effective_date'] = { date: req.effectiveDate };

    const transfer = await this.request<IncreaseAchTransfer>('POST', '/ach_transfers', {
      body,
      idempotencyKey: req.clientReferenceId,
    });
    return this.mapTransfer(transfer, req.clientReferenceId);
  }

  // -- reads ----------------------------------------------------------------

  async getTransfer(transferId: string): Promise<RailTransfer> {
    const t = await this.request<IncreaseAchTransfer>(
      'GET',
      `/ach_transfers/${encodeURIComponent(transferId)}`,
    );
    return this.mapTransfer(t);
  }

  /**
   * `GET /inbound_ach_transfers/{id}` — money somebody sent US.
   *
   * Returned raw rather than mapped to a `RailTransfer`. The mapping exists to
   * normalise OUR instruction's lifecycle (created → submitted → settled →
   * returned, with the `settlement.settled_at` promotion `mapTransfer`
   * documents); an arrival has a different lifecycle, a different return shape,
   * and one field no outbound transfer has — `account_number_id`, which is the
   * only thing on the message that can say whose money it is. Flattening it
   * into the outbound shape would throw that field away at the door.
   *
   * This is the method `src/lib/webhooks/consumers/increase-ach.ts` used to
   * open-code as a bare `fetch`, with a comment saying it belonged here. It
   * does, and the reason is not tidiness: a bare fetch has no error
   * classification, so a 500 from Increase and a malformed body were
   * indistinguishable at the call site from "this transfer does not exist".
   */
  getInboundTransfer(transferId: string): Promise<IncreaseInboundAchTransfer> {
    return this.request<IncreaseInboundAchTransfer>(
      'GET',
      `/inbound_ach_transfers/${encodeURIComponent(transferId)}`,
    );
  }

  // -- account numbers ------------------------------------------------------

  /**
   * `GET /account_numbers` — every virtual number on the programme.
   *
   * The read that measured the gap this rail spent its life inside: on
   * 2026-09-11 it returned EXACTLY ONE object, `sandbox_account_number_
   * 96mzhz3n61f5p0jpvytc` (7467448488 / 123308582, name "primary"), on the
   * programme's own FBO account and shared by all six businesses on the book.
   * An inbound credit names `account_number_id`, so the field that should
   * identify the customer identified the programme, and every inbound credit
   * parked as unattributable — correctly.
   */
  async listAccountNumbers(limit = 100): Promise<readonly IncreaseAccountNumber[]> {
    const page = await this.request<{ data: readonly IncreaseAccountNumber[] }>(
      'GET',
      `/account_numbers?limit=${limit}`,
    );
    return page.data;
  }

  /**
   * `POST /account_numbers` — issue a virtual number for one customer.
   *
   * `idempotencyKey` is NOT optional in practice and the reason is measured: a
   * repeat POST carrying a key that has already been used answers `409
   * idempotency_key_already_used_error` with `resource_id` naming the number it
   * already issued — it does not replay the object. That is a stronger
   * guarantee than a replay (the provider refuses to issue a second number for
   * one key), and it is why `scripts/provision-account-numbers.mjs` keys on the
   * business id and recovers by fetching `resource_id`. A key derived from a
   * clock or a run id would make that recovery unreachable and leave an orphan
   * account number at the provider after every crash.
   *
   * `inbound_ach.debit_status` defaults to `"allowed"` at Increase, which lets
   * anyone holding the digits PULL money out. This build does not model an
   * inbound ACH debit — the consumer parks one under `increase_debit_pull` — so
   * every number it issues blocks them.
   */
  createAccountNumber(args: {
    readonly accountId: string;
    readonly name: string;
    readonly idempotencyKey: string;
    readonly inboundDebitStatus?: 'allowed' | 'blocked';
  }): Promise<IncreaseAccountNumber> {
    return this.request<IncreaseAccountNumber>('POST', '/account_numbers', {
      body: {
        account_id: args.accountId,
        name: args.name,
        inbound_ach: { debit_status: args.inboundDebitStatus ?? 'blocked' },
      },
      idempotencyKey: args.idempotencyKey,
    });
  }

  // -- inbound simulation ---------------------------------------------------
  //
  // These two are the ONLY way to exercise an arrival end to end: nothing this
  // programme does can make a stranger's bank send it money, and the brief's
  // item 5 — "an inbound payment is recalled" — cannot be demonstrated without
  // one. Both are real Increase endpoints against the real sandbox, and both
  // produce real signature-verified webhook deliveries to the deployed
  // endpoint; `/simulations/` marks whose side the origination is played from,
  // not whether the object is real.

  /** `POST /simulations/inbound_ach_transfers` — a stranger pays a customer. */
  simulateInboundAchTransfer(args: {
    readonly accountNumberId: string;
    readonly amountCents: number;
    readonly companyName?: string;
    readonly companyEntryDescription?: string;
  }): Promise<IncreaseInboundAchTransfer> {
    return this.request<IncreaseInboundAchTransfer>('POST', '/simulations/inbound_ach_transfers', {
      body: {
        account_number_id: args.accountNumberId,
        amount: args.amountCents,
        ...(args.companyName === undefined ? {} : { company_name: args.companyName }),
        ...(args.companyEntryDescription === undefined
          ? {}
          : { company_entry_description: args.companyEntryDescription }),
      },
    });
  }

  /**
   * `POST /inbound_ach_transfers/{id}/transfer_return` — send it back.
   *
   * A PRODUCTION endpoint, not a simulation: this is the RECEIVING bank (us)
   * returning a credit it does not want, which is a thing a real programme
   * really does. MEASURED: the object comes back `status: "returned"` with ONE
   * new block, `transfer_return {reason, returned_at, transaction_id}`, and no
   * `return` key anywhere — which is the difference `db/migrations/0039` exists
   * for.
   */
  returnInboundAchTransfer(
    transferId: string,
    reason: string,
  ): Promise<IncreaseInboundAchTransfer> {
    return this.request<IncreaseInboundAchTransfer>(
      'POST',
      `/inbound_ach_transfers/${encodeURIComponent(transferId)}/transfer_return`,
      { body: { reason } },
    );
  }

  // -- events ---------------------------------------------------------------

  /**
   * THE BODY IS A POINTER, NOT A PAYLOAD.
   *
   * An Increase webhook body is the Event object — an id, a category and
   * `associated_object_id`. It carries no transfer state at all, so "what
   * happened" is only knowable by reading the transfer back. This method does
   * both steps: parse, then `getTransfer`.
   *
   * That read-back is why out-of-order delivery is harmless here. If the
   * settlement notification overtakes the submission notification, both
   * read-backs return the same current transfer, the later one is a no-op, and
   * the ledger converges. Nothing in this adapter assumes an order, because
   * nothing in it is allowed to.
   *
   * Note there is no `ach_transfer.returned` category — a return arrives as
   * `ach_transfer.updated` like everything else, which is a second reason state
   * cannot be read off the event.
   *
   * NEVER THROWS. Every failure path returns an `unknown` event, so the route
   * answers 200 and the subscription survives.
   */
  async parseEvent(rawBody: string): Promise<RailEvent> {
    let ev: IncreaseEvent;
    try {
      ev = JSON.parse(rawBody) as IncreaseEvent;
    } catch {
      return this.unknownEvent('', '', 'unparseable', 'unparseable', rawBody);
    }
    if (!ev || typeof ev !== 'object' || !ev.id || !ev.category) {
      return this.unknownEvent('', '', String(ev?.category ?? 'malformed'), 'unparseable', ev);
    }
    // Match on the TYPE, not on a prefix of the id.
    //
    // Increase's sandbox ids are `sandbox_ach_transfer_...`, so a
    // `startsWith('ach_transfer_')` gate classified every sandbox delivery as
    // an event about something this adapter does not model — and returned 200.
    // Silently. Every settlement and every return we generated in sandbox went
    // down that branch, which is the entire rail we claim to support, dropped
    // by a string that was right about production and wrong about the only
    // environment anyone has run.
    //
    // `associated_object_type` is the field Increase actually documents for
    // this, it is identical in both environments, and it cannot be defeated by
    // a prefix nobody thought to look for.
    if (ev.associated_object_type !== 'ach_transfer') {
      // A real event about something this adapter does not model — an inbound
      // transfer, a declined transaction. 200 and move on.
      return this.unknownEvent(ev.id, ev.associated_object_id ?? '', ev.category, 'unmodelled_event', ev);
    }

    // Deliberately NOT wrapped in a try/catch. "Never throws" is about
    // unrecognised payloads, not about a failed read-back: if the API call
    // fails we do not know the state, and returning `unknown` here would let
    // the dispatcher mark the row done and lose the event. A throw is a
    // retryable failure in dispatch.ts, which is the correct outcome.
    const transfer = await this.getTransfer(ev.associated_object_id);

    const base = {
      provider: INCREASE_PROVIDER,
      railKind: 'ach' as const,
      evidence: EVIDENCE,
      eventId: ev.id,
      transferId: transfer.id,
      occurredAt: ev.created_at,
      raw: { event: ev, transfer: transfer.raw },
    };

    // A correction can arrive alongside any status, and is not itself a state
    // change, so it is checked first and reported on its own.
    if (transfer.corrections && transfer.corrections.length > 0) {
      return { ...base, type: 'correction', corrections: transfer.corrections };
    }

    switch (transfer.status) {
      case 'returned':
        return {
          ...base,
          type: 'returned',
          returnedAt: transfer.returnedAt ?? ev.created_at,
          reason:
            transfer.returnReason ??
            { category: 'unknown', code: null, providerCode: null, retryable: false },
          // The return is a second movement of the same magnitude.
          amount: transfer.amount,
        };
      case 'settled':
        return {
          ...base,
          type: 'settled',
          settledAt: transfer.settledAt ?? ev.created_at,
          // The face amount, because an ACH transfer settles for exactly what
          // was instructed — there is no partial settlement on ACH. It travels
          // with the event anyway so that one settlement reporter can read ACH
          // and card without branching; see ../contract.ts.
          amount: transfer.amount,
        };
      case 'submitted':
        return { ...base, type: 'submitted', submittedAt: transfer.submittedAt ?? ev.created_at };
      case 'canceled':
        return { ...base, type: 'canceled', canceledAt: ev.created_at };
      case 'failed':
        return {
          ...base,
          type: 'failed',
          reason:
            transfer.returnReason ??
            { category: 'provider_error', code: null, providerCode: null, retryable: false },
        };
      case 'created':
      case 'pending_approval':
        // Recognised, but the money's fate has not changed: the transfer is
        // still waiting to be handed to the network. Reported as `unknown` with
        // `no_state_change` rather than invented as an eighth event type.
        return {
          ...base,
          type: 'unknown',
          providerType: ev.category,
          reason: 'no_state_change',
        };
    }
  }

  // -- sandbox-only affordances --------------------------------------------
  //
  // NOT part of PaymentRail, on purpose: test affordances do not belong in the
  // production interface. These exist only in Increase's sandbox and 404 in
  // production. Integration tests reach for them directly.
  //
  // NOTE the difference between these and `../achsim/`. These drive the REAL
  // provider's state machine, so what comes back is `evidence: 'live'` — a real
  // Increase transfer really did move to `returned`. They cannot produce the
  // awkward cases the simulator can: they cannot deliver a settlement webhook
  // before a submission webhook, cannot redeliver a duplicate on demand, and
  // cannot take the provider offline for ninety seconds. That is what the
  // simulator is for.

  /** `pending_submission` -> `submitted`. */
  simulateSubmit(transferId: string): Promise<IncreaseAchTransfer> {
    return this.simulation(transferId, 'submit', {});
  }

  /** Adds the `acknowledgement` sub-object (FedACH said "got it"). */
  simulateAcknowledge(transferId: string): Promise<IncreaseAchTransfer> {
    return this.simulation(transferId, 'acknowledge', {});
  }

  /** Stamps `settlement.settled_at`. Status STAYS `submitted`. */
  simulateSettle(transferId: string): Promise<IncreaseAchTransfer> {
    return this.simulation(transferId, 'settle', {});
  }

  /**
   * Force a return with a chosen reason:
   *   'insufficient_fund' -> R01, 'account_closed' -> R02, 'no_account' -> R03.
   */
  simulateReturn(
    transferId: string,
    reason: IncreaseReturnReasonName | string,
    addendaInformation?: string,
  ): Promise<IncreaseAchTransfer> {
    return this.simulation(
      transferId,
      'return',
      addendaInformation === undefined ? { reason } : { reason, addenda_information: addendaInformation },
    );
  }

  /** Simulate a notification of change from the receiving bank. */
  simulateNotificationOfChange(
    transferId: string,
    corrected: {
      corrected_routing_number?: string;
      corrected_account_number?: string;
      corrected_account_funding?: string;
      corrected_individual_id?: string;
    },
  ): Promise<IncreaseAchTransfer> {
    return this.simulation(transferId, 'create_notification_of_change', corrected);
  }

  private simulation(
    transferId: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<IncreaseAchTransfer> {
    return this.request<IncreaseAchTransfer>(
      'POST',
      `/simulations/ach_transfers/${encodeURIComponent(transferId)}/${action}`,
      { body },
    );
  }

  // -- mapping --------------------------------------------------------------

  /**
   * THE TRAP, AND THE ONE LINE THAT ABSORBS IT.
   *
   * Increase has NO `settled` status. A settled transfer keeps
   * `status: "submitted"` and grows `settlement.settled_at`. An adapter that
   * maps status-to-status is correct on every value in the enum and still never
   * releases a hold, because the state it is waiting for is not in the enum.
   *
   * So the promotion is explicit and it is here, where both fields are in
   * scope: `submitted` + `settlement.settled_at` => our `settled`.
   */
  private mapTransfer(t: IncreaseAchTransfer, clientReferenceId?: string): RailTransfer {
    const mapped = INCREASE_STATUS[t.status] ?? 'created';
    const status: RailTransferStatus =
      mapped === 'submitted' && t.settlement?.settled_at ? 'settled' : mapped;

    const amount: Money = { amount: BigInt(Math.abs(t.amount)), currency: 'USD' };
    const corrections = (t.notifications_of_change ?? []).map((n) => ({
      field: correctionField(n.change_code),
      correctedValue: n.corrected_data,
      code: n.change_code,
      receivedAt: n.created_at,
    }));

    return {
      provider: INCREASE_PROVIDER,
      railKind: 'ach',
      evidence: EVIDENCE,
      id: t.id,
      clientReferenceId: clientReferenceId ?? t.idempotency_key ?? undefined,
      // The sign convention again, in reverse. Never read the sign off our own
      // request: a read-back of someone else's transfer has to work too.
      direction: t.amount < 0 ? 'debit' : 'credit',
      status,
      amount,
      createdAt: t.created_at,
      submittedAt: t.submission?.submitted_at ?? t.acknowledgement?.acknowledged_at ?? undefined,
      settledAt: t.settlement?.settled_at ?? undefined,
      returnedAt: t.return?.created_at ?? undefined,
      returnReason: t.return ? mapIncreaseReturnReason(t.return) : undefined,
      corrections,
      raw: t,
    };
  }

  private unknownEvent(
    eventId: string,
    transferId: string,
    providerType: string,
    reason: 'unmodelled_event' | 'no_state_change' | 'unparseable',
    raw: unknown,
  ): RailEvent {
    return {
      provider: INCREASE_PROVIDER,
      railKind: 'ach',
      evidence: EVIDENCE,
      eventId,
      transferId,
      occurredAt: new Date().toISOString(),
      type: 'unknown',
      providerType,
      reason,
      raw,
    };
  }

  // -- plumbing -------------------------------------------------------------

  private baseUrl(): string {
    return (
      this.cfg.baseUrl ??
      readEnv('INCREASE_BASE_URL') ??
      INCREASE_SANDBOX_BASE_URL
    ).replace(/\/+$/, '');
  }

  /** Resolved at CALL time. Never captured in module scope. */
  private apiKey(): string {
    const key = this.cfg.apiKey ?? readEnv('INCREASE_API_KEY');
    if (key === undefined) {
      throw this.error(
        'INCREASE_API_KEY is not set. The ACH slot should be running the simulator — see src/lib/rails/achsim/factory.ts.',
        { code: 'not_configured', retryable: false },
      );
    }
    return key;
  }

  private error(
    message: string,
    opts: { code: string; retryable: boolean; httpStatus?: number; raw?: unknown },
  ): RailError {
    return new RailError(message, {
      provider: INCREASE_PROVIDER,
      evidence: EVIDENCE,
      ...opts,
    });
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey()}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);

    let res: Response;
    try {
      res = await fetchImpl(`${this.baseUrl()}${path}`, {
        method,
        headers,
        signal: controller.signal,
        // Conditional spread rather than `body: undefined`:
        // `exactOptionalPropertyTypes` means an explicit undefined is not the
        // same as an absent key, and `RequestInit.body` does not accept one.
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (cause) {
      // Retryable, and safe to retry: the same Idempotency-Key means a request
      // that did land is returned rather than repeated.
      throw this.error(`network error calling ${method} ${path}`, {
        code: 'network_error',
        retryable: true,
        raw: cause,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();
    if (!res.ok) {
      let problem: { type?: string; title?: string; detail?: string } = {};
      try {
        problem = JSON.parse(text) as typeof problem;
      } catch {
        /* keep the raw text */
      }
      throw this.error(problem.title ?? `Increase ${res.status}`, {
        code: problem.type ?? `http_${res.status}`,
        httpStatus: res.status,
        // A 409 is `idempotency_key_already_used_error`: our key generation is
        // wrong. Retrying it just produces another 409.
        retryable: res.status === 429 || res.status >= 500,
        raw: text,
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw this.error(`Increase returned a non-JSON body for ${method} ${path}`, {
        code: 'malformed_response',
        retryable: true,
        raw: cause,
      });
    }
  }
}

/** Trimmed, or undefined. An empty string is a missing value, not a value. */
function readEnv(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
