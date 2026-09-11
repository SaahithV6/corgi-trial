/**
 * `PaymentRail` — the one money-movement adapter interface.
 *
 * A RAIL IS AN ADAPTER, NOT A SCHEMA. The ledger owns truth about money; a rail
 * owns "what the network did to this instruction, and when we learned about
 * it". So nothing in this file is an ACH noun. Routing numbers, SEC codes and
 * ODFIs live inside one variant of the `Destination` union, and only the ACH
 * adapters ever read that variant. The card adapter and the USDC adapter get
 * their own variants and slot in behind the identical four methods without ever
 * learning what Nacha is.
 *
 * Five invariants the rest of the app may rely on:
 *
 *   1. MONEY IS AN INTEGER, ALWAYS, AND ALWAYS THE SAME KIND OF INTEGER.
 *      `Money.amount` is a `bigint` of minor units. Not a number, not a string,
 *      never a float. See the note on `Money` for why bigint and not number.
 *
 *   2. ONE EVENT UNION. Every provider's callback normalises into exactly seven
 *      `RailEvent` types — submitted, settled, returned, failed, canceled,
 *      correction, unknown — so the ledger's state machine is written once.
 *      `unknown` is not a failure mode; it is how an unrecognised delivery still
 *      gets a 200 instead of a 500 that gets the subscription disabled.
 *
 *   3. A RETURN IS A SECOND MONEY MOVEMENT, NOT AN EDIT. `returned` carries its
 *      own `amount` and a structured `RailReturnReason`. Nothing ever rewrites
 *      the original transfer's amount; the ledger appends.
 *
 *   4. SETTLEMENT IS A TIMESTAMP THE RAIL OWNS. `settledAt` is never inferred by
 *      the caller from `submittedAt + N days`. See `RailTransferStatus`.
 *
 *   5. THE RETURN WINDOW OUTLIVES SETTLEMENT. `capabilities.returnWindowDays` is
 *      what drives hold release, not `settledAt`. A balance is not spendable the
 *      moment it settles.
 *
 * NO `verifyWebhook` HERE, DELIBERATELY. Increase and Lithic both implement the
 * Standard Webhooks scheme, and `src/lib/webhooks/inbox.ts` already has one
 * generic, tested verifier for it plus a registry keyed by provider. A
 * per-rail copy of a shared scheme is exactly the duplication DECISIONS 007
 * deleted — "a per-provider copy of a shared scheme is how the fifth provider
 * gets verified differently from the first four". Verification therefore happens
 * once, upstream, in the inbox; by the time a rail sees a body the bytes are
 * already authenticated, which is why `parseEvent` takes a raw string and
 * nothing else.
 */

// Type-only, and therefore erased: ./contract.ts imports its money vocabulary
// from this file with `import type` too, so neither direction survives to
// runtime and there is no module cycle. `RailLiveness` is imported rather than
// restated because `RailSlotHealth` and `RailProbe` must answer the liveness
// question with the SAME six words — a slot health with its own private
// vocabulary is how two surfaces come to disagree about what `live` means.
import type { RailLiveness } from './contract';

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * ISO-4217, plus USDC as its own code so a stablecoin balance can never be
 * silently summed with a fiat one.
 */
export type Currency = 'USD' | 'USDC';

/**
 * Integer minor units.
 *
 * WHY BIGINT AND NOT NUMBER. The three rails have to agree, and one of them is
 * USDC: 6 decimal places, uint256 on the wire, values that pass
 * `Number.MAX_SAFE_INTEGER` almost immediately. `research/usdc/adapter.draft.ts`
 * is categorical about it ("must NEVER be a number or a float"), and a single
 * interface cannot be bigint on one rail and number on another without a
 * conversion site that will eventually be wrong. ACH cents fit in a number
 * comfortably; USDC units do not; so the interface is bigint and the adapters
 * that speak `number` to their provider convert at their own boundary — Lithic's
 * `Cents = number` becomes `BigInt(cents)` on the way in and `Number(...)` on the
 * way out, both inside the card adapter.
 *
 * The cost, stated plainly: `JSON.stringify(1n)` throws. Anything that crosses
 * a JSON boundary uses `serializeMoney` / `deserializeMoney` below.
 */
export interface Money {
  /** Integer minor units. USD -> cents. USDC -> 1e-6 units. */
  readonly amount: bigint;
  readonly currency: Currency;
}

/** USD cents. Accepts a number only if it is a safe integer; rejects floats. */
export function usd(cents: bigint | number): Money {
  return { amount: toMinorUnits(cents, 'usd'), currency: 'USD' };
}

/**
 * The one place a `number` is allowed to become money. Anything fractional is a
 * caller bug and is rejected here rather than silently truncated three layers
 * down.
 */
export function toMinorUnits(value: bigint | number, label = 'amount'): bigint {
  if (typeof value === 'bigint') return value;
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer number of minor units, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} is outside the safe integer range: ${value}`);
  }
  return BigInt(value);
}

/** JSON has no bigint. Amounts cross a JSON boundary as decimal strings. */
export function serializeMoney(money: Money): { amount: string; currency: Currency } {
  return { amount: money.amount.toString(), currency: money.currency };
}

export function deserializeMoney(wire: { amount: string; currency: Currency }): Money {
  return { amount: BigInt(wire.amount), currency: wire.currency };
}

// ---------------------------------------------------------------------------
// Provenance — the label that must never be forgeable
// ---------------------------------------------------------------------------

/**
 * Where a fact came from.
 *
 *   'live'      a real provider's API or a real provider's signed webhook
 *               produced this. (Sandbox counts as live: it is the provider's
 *               own system. `RailEnvironment` is what separates sandbox money
 *               from production money.)
 *   'simulated' our simulator produced this. It is not evidence of anything a
 *               bank did.
 *
 * Every `RailTransfer`, every `RailEvent`, every `RailError` and every
 * `RailCapabilities` carries one. A UI, a report or a demo that presents a
 * value without reading this field is presenting a claim it has not checked —
 * `assertLive` exists so that check is one call and a hard failure.
 */
export type Evidence = 'live' | 'simulated';

export type RailEnvironment = 'production' | 'sandbox' | 'simulator';

/** A `T` that has been proven to have come from a real provider. */
export type LiveOnly<T extends { readonly evidence: Evidence }> = T & { readonly evidence: 'live' };

export function isSimulated(x: { readonly evidence: Evidence }): boolean {
  return x.evidence === 'simulated';
}

/**
 * Narrow to live, or throw. Call this at every point where a value is about to
 * be presented as a real money movement — a statement, an export, a balance a
 * customer can act on. It is deliberately a throw and not a boolean: the failure
 * mode being defended against is a caller who forgot to look.
 */
export function assertLive<T extends { readonly evidence: Evidence }>(
  x: T,
  context = 'value',
): LiveOnly<T> {
  if (x.evidence !== 'live') {
    throw new RailError(
      `refusing to present a simulated ${context} as live`,
      { provider: 'unknown', code: 'simulated_result_not_presentable', retryable: false, evidence: x.evidence },
    );
  }
  return x as LiveOnly<T>;
}

/** The word a README table, a badge or a log line should use. */
export function evidenceLabel(evidence: Evidence): 'LIVE' | 'SIMULATED' {
  return evidence === 'live' ? 'LIVE' : 'SIMULATED';
}

// ---------------------------------------------------------------------------
// Rail identity + capabilities
// ---------------------------------------------------------------------------

export type RailKind = 'ach' | 'wire' | 'rtp' | 'card' | 'usdc' | 'internal';

/**
 * Static description of what a rail can do. The app reads this to decide which
 * rails to offer for a payout and — the part that matters for ACH — to decide
 * how long after settlement funds must stay held.
 */
export interface RailCapabilities {
  readonly kind: RailKind;
  /** Stable slug, persisted on every ledger row. e.g. 'increase.ach'. */
  readonly provider: string;
  /** Whether this adapter talks to a real provider or to our simulator. */
  readonly evidence: Evidence;
  readonly environment: RailEnvironment;
  readonly supportsCredit: boolean;
  readonly supportsDebit: boolean;
  /**
   * True when the network can claw funds back AFTER they have settled.
   * ACH: yes. Card: yes, via chargeback. Wire/RTP/USDC: no.
   */
  readonly supportsReturns: boolean;
  /**
   * How long after settlement a return can still arrive, in calendar days.
   * Null when returns are impossible.
   *
   * THIS LIVES ON CAPABILITIES AND NOT ON A TRANSFER ON PURPOSE. The return
   * window outlives settlement, so it cannot be a property of the settlement
   * event; it is a property of the rail, and it is the input to "when do these
   * funds become available", which is a different question from "when did they
   * settle". ACH is 60 here: 2 business days covers a commercial return, but an
   * unauthorised consumer debit can come back for 60 calendar days, and a hold
   * policy is only correct if it is sized for the worst case the rail allows.
   */
  readonly returnWindowDays: number | null;
  readonly supportsIdempotency: boolean;
  /** ACH notification-of-change, card account updater, and nothing else. */
  readonly supportsAccountCorrection: boolean;
}

// ---------------------------------------------------------------------------
// Destinations — the one place rail-specific detail is allowed
// ---------------------------------------------------------------------------

export type AchAccountType = 'checking' | 'savings';

/** Who the counterparty is, for network-level compliance coding. */
export type AccountHolderKind = 'business' | 'individual' | 'unknown';

/**
 * HOW THE PAYMENT WAS AUTHORISED — an intent, not a network code.
 *
 * The ACH adapters map this to a Nacha SEC code:
 *
 *   business_agreement  -> CCD  corporate_credit_or_debit
 *   consumer_written    -> PPD  prearranged_payments_and_deposit
 *   consumer_online     -> WEB  internet_initiated
 *   business_remittance -> CTX  corporate_trade_exchange
 *
 * Card and USDC adapters ignore it. Expressing it as intent rather than as the
 * literal string "CCD" is what keeps those two adapters from having to know
 * that Nacha exists — and it is also the honest model, because the caller
 * genuinely knows how the customer authorised the payment and genuinely does
 * not know which three letters that implies.
 */
export type AuthorizationKind =
  | 'business_agreement'
  | 'consumer_written'
  | 'consumer_online'
  | 'business_remittance';

export type Destination =
  | {
      readonly type: 'ach';
      /** 9-digit ABA. Supply this + accountNumber, OR externalAccountId. */
      readonly routingNumber?: string | undefined;
      readonly accountNumber?: string | undefined;
      /**
       * Provider-side stored counterparty (Increase External Account, Modern
       * Treasury external_account, Moov paymentMethodID). Preferred, so raw
       * account numbers never re-enter our request path.
       */
      readonly externalAccountId?: string | undefined;
      readonly accountType?: AchAccountType | undefined;
      readonly holderName: string;
      readonly holderKind?: AccountHolderKind | undefined;
      readonly authorization: AuthorizationKind;
    }
  | {
      readonly type: 'card';
      /** Network token / provider card id. Never a raw PAN. */
      readonly cardTokenId: string;
      readonly holderName?: string | undefined;
    }
  | {
      readonly type: 'usdc';
      readonly chain: 'ethereum' | 'base' | 'base-sepolia' | 'solana' | 'polygon';
      readonly address: string;
    }
  | {
      readonly type: 'internal';
      /** Another account at the same provider — a book transfer. */
      readonly accountId: string;
    };

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface TransferRequest {
  /**
   * OUR id for this instruction, and the idempotency key. Must be stable across
   * retries of the same intent and unique across distinct intents.
   */
  readonly clientReferenceId: string;
  /** The funding/receiving account on OUR side, at the provider. */
  readonly sourceAccountId: string;
  readonly destination: Destination;
  /** Always positive. Direction comes from which method you called. */
  readonly amount: Money;
  /** <= 10 chars on ACH; appears on the counterparty's statement. */
  readonly statementDescriptor: string;
  readonly description?: string | undefined;
  /** Earliest date we want funds to land, YYYY-MM-DD. Ignored where unsupported. */
  readonly effectiveDate?: string | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
}

// ---------------------------------------------------------------------------
// Normalised transfer state
// ---------------------------------------------------------------------------

/**
 * The rail-agnostic state machine.
 *
 *   created -> pending_approval? -> submitted -> settled -> returned
 *          \-> canceled          \-> failed
 *
 * `settled` is NOT terminal: `returned` follows it, sometimes months later.
 * Only `returned`, `failed` and `canceled` are terminal.
 *
 * THE INCREASE TRAP, WHICH THE INTERFACE EXISTS TO ABSORB: Increase has no
 * `settled` status. A settled ACH transfer keeps `status: "submitted"` and grows
 * a `settlement.settled_at` timestamp. An adapter that maps status-to-status and
 * stops there will never release a hold. Every ACH adapter in this repo promotes
 * `submitted` + `settlement.settled_at` to `settled` explicitly, and says so at
 * the promotion site.
 */
export type RailTransferStatus =
  | 'created'
  | 'pending_approval'
  | 'submitted'
  | 'settled'
  | 'returned'
  | 'failed'
  | 'canceled';

export type TransferDirection = 'credit' | 'debit';

export interface RailTransfer {
  readonly provider: string;
  readonly railKind: RailKind;
  /** 'live' or 'simulated'. Never absent, never inferred. */
  readonly evidence: Evidence;
  /** The provider's id. Store it: it is the join key for every webhook. */
  readonly id: string;
  readonly clientReferenceId?: string | undefined;
  readonly direction: TransferDirection;
  readonly status: RailTransferStatus;
  /** Always the positive magnitude. `direction` carries the sign. */
  readonly amount: Money;
  readonly createdAt: string;
  readonly submittedAt?: string | undefined;
  /** Set only once the network actually settled. Never guessed. */
  readonly settledAt?: string | undefined;
  readonly returnedAt?: string | undefined;
  readonly returnReason?: RailReturnReason | undefined;
  /** The counterparty's bank told us their details changed (ACH NOC/COR). */
  readonly corrections?: readonly AccountCorrection[] | undefined;
  /** Whatever the provider gave us, untouched, for audit. */
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Returns — the part the whole design hangs on
// ---------------------------------------------------------------------------

/**
 * Semantic buckets. Retry and dunning logic branches on THIS, never on the raw
 * code, so one implementation covers an ACH R01, a card `insufficient_funds`
 * decline and a reverted USDC transfer.
 */
export type ReturnCategory =
  /** Money was not there. Retrying later is sensible. (R01, R09) */
  | 'insufficient_funds'
  /** The account does not exist or is closed. Never retry; get new details. (R02, R03, R04) */
  | 'account_invalid'
  /** The counterparty disputes the authorisation. Never retry; escalate. (R05, R07, R08, R10, R29) */
  | 'unauthorized'
  /** We sent something malformed. Fixable by us. (R13, R17, R19, R28) */
  | 'invalid_request'
  /** Blocked for compliance or sanctions. Never retry; escalate. (R16) */
  | 'blocked'
  /** A bank-side or network-side problem. Retryable. */
  | 'provider_error'
  | 'unknown';

export interface RailReturnReason {
  /** The normalised bucket. Branch on this. */
  readonly category: ReturnCategory;
  /**
   * The network-native code, canonical and uppercased where one exists:
   * ACH -> 'R01' | 'R02' | ... ; card -> the chargeback reason code;
   * USDC -> 'REVERTED'. Null only when the provider genuinely said nothing.
   */
  readonly code: string | null;
  /**
   * Exactly what the provider said, untouched, so nothing is lost in
   * normalisation. Increase spells R01 `insufficient_fund` — singular — and
   * that string is preserved here rather than tidied away.
   */
  readonly providerCode: string | null;
  readonly description?: string | undefined;
  /** Could a fresh attempt on the same details plausibly succeed? */
  readonly retryable: boolean;
}

/** ACH notification of change (NOC/COR), card account updater. */
export interface AccountCorrection {
  readonly field:
    | 'routing_number'
    | 'account_number'
    | 'account_type'
    | 'individual_id'
    | 'other';
  readonly correctedValue: string;
  /** e.g. 'C01'. */
  readonly code?: string | undefined;
  readonly receivedAt?: string | undefined;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * Why an event came back as `unknown` rather than one of the six modelled
 * types. Both cases MUST produce a 200: a 5xx on an event we do not model is
 * how a provider decides our subscription is broken and disables it.
 */
export type UnknownEventReason =
  /** A provider event type this adapter does not model. Log it and move on. */
  | 'unmodelled_event'
  /** Recognised, but nothing about the money's fate changed (e.g. Increase's
   *  `ach_transfer.created` on a transfer still awaiting submission). */
  | 'no_state_change'
  /** Verified bytes we could not parse into anything. */
  | 'unparseable';

export interface RailEventBase {
  readonly provider: string;
  readonly railKind: RailKind;
  /** 'live' or 'simulated'. Present on EVERY event, including `unknown`. */
  readonly evidence: Evidence;
  /** The provider's event id. UNIQUE — persist it and drop duplicates. */
  readonly eventId: string;
  /** The provider transfer id this event is about. */
  readonly transferId: string;
  readonly occurredAt: string;
  readonly raw: unknown;
}

/**
 * Seven types, and no more. Adding an eighth means every consumer's switch has
 * to change, so the bar for one is high.
 */
export type RailEvent =
  | (RailEventBase & { readonly type: 'submitted'; readonly submittedAt: string })
  | (RailEventBase & {
      readonly type: 'settled';
      readonly settledAt: string;
      /**
       * THE AMOUNT THAT ACTUALLY SETTLED, which is not always the amount that
       * was authorised.
       *
       * This field was added when `contract.ts` tried to write ONE settlement
       * reporter across ACH, card and USDC and could not: `returned` carried
       * its own amount and `settled` did not, so the only rail-agnostic thing a
       * consumer could learn from a settlement was that one had happened. On
       * ACH the missing number is recoverable (a settled ACH transfer settles
       * for its face amount), which is why the gap survived — but on a card it
       * is not, and "settlement is not authorisation. Different amount, days
       * later" is the entire point of this track. A $50.00 fuel-pump hold that
       * clears at $73.40 has a settled amount of 7340 and an authorised amount
       * of 5000, and no amount of reading the original instruction will tell
       * you the first.
       *
       * So it travels with the event, for the same reason it travels with
       * `returned`: the ledger must be able to post what happened from the
       * event alone.
       */
      readonly amount: Money;
    })
  | (RailEventBase & {
      readonly type: 'returned';
      readonly returnedAt: string;
      readonly reason: RailReturnReason;
      /**
       * The amount coming back. Present because a return is a SECOND MONEY
       * MOVEMENT: the ledger posts this as a new entry against the original
       * transfer, it does not edit the original entry's amount.
       */
      readonly amount: Money;
    })
  | (RailEventBase & { readonly type: 'failed'; readonly reason: RailReturnReason })
  | (RailEventBase & { readonly type: 'canceled'; readonly canceledAt: string })
  | (RailEventBase & {
      readonly type: 'correction';
      readonly corrections: readonly AccountCorrection[];
    })
  | (RailEventBase & {
      readonly type: 'unknown';
      readonly providerType: string;
      readonly reason: UnknownEventReason;
    });

export type RailEventType = RailEvent['type'];

/** Every member of the union, for exhaustiveness tests and documentation. */
export const RAIL_EVENT_TYPES = [
  'submitted',
  'settled',
  'returned',
  'failed',
  'canceled',
  'correction',
  'unknown',
] as const satisfies readonly RailEventType[];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface RailErrorOptions {
  readonly provider: string;
  readonly code: string;
  readonly httpStatus?: number | undefined;
  /**
   * True for 429 / 5xx / network failures — the caller may retry with the SAME
   * idempotency key. False for validation errors, where a retry just fails
   * again more expensively.
   */
  readonly retryable: boolean;
  /** A failure from the simulator is not evidence that a bank refused anything. */
  readonly evidence: Evidence;
  readonly raw?: unknown;
}

export class RailError extends Error {
  override readonly name = 'RailError';
  readonly provider: string;
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly retryable: boolean;
  readonly evidence: Evidence;
  readonly raw: unknown;

  constructor(message: string, opts: RailErrorOptions) {
    super(message);
    this.provider = opts.provider;
    this.code = opts.code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable;
    this.evidence = opts.evidence;
    this.raw = opts.raw;
  }
}

// ---------------------------------------------------------------------------
// Health — what /api/health prints for a rail slot
// ---------------------------------------------------------------------------

/**
 * One rail slot's status, shaped like `IntegrationReport` in
 * `src/lib/webhooks/route-handler.ts` so a health route can render both without
 * a second vocabulary. `label` is what a human reads; `evidence` is what code
 * branches on.
 *
 * THREE FIELDS, THREE DIFFERENT QUESTIONS, AND THEY ARE NOT THE SAME QUESTION.
 * Conflating them is what produced the bug this shape now prevents:
 *
 *   selected   WHICH ADAPTER is wired up. Decided from configuration, and
 *              configuration is the right input for that question.
 *   evidence   WHETHER THE PROVIDER IS REAL. A property of the adapter, known
 *              at construction: Increase is a bank, the simulator is us.
 *   liveness   WHETHER A ROUND TRIP HAS PROVEN IT WORKS, right now. This is
 *              the ONLY one a credential cannot answer, and `unprobed` is the
 *              honest verdict when a key is present and nothing has been run
 *              with it. Same six words as `RailLiveness`/`Liveness`, so this
 *              cannot become a seventh opinion.
 *
 * `label` is derived from the last two by `railProbeLabel` and is never
 * written by hand — LIVE needs a real provider AND a successful round trip.
 */
export interface RailSlotHealth {
  readonly slot: RailKind;
  readonly provider: string;
  readonly selected: 'live_adapter' | 'simulator';
  readonly evidence: Evidence;
  /** What a round trip proved. Never inferred from a credential being set. */
  readonly liveness: RailLiveness;
  readonly environment: RailEnvironment;
  readonly label: 'LIVE' | 'SIMULATED';
  /** Env var NAMES only. Never values — a health endpoint is public. */
  readonly missingEnv: readonly string[];
  /** One sentence a human can act on. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// THE INTERFACE
// ---------------------------------------------------------------------------

/**
 * Four methods. ACH, card and USDC all fit behind them.
 *
 * Everything the app does with money is: push, pull, ask, interpret a callback.
 * Anything a specific rail can do beyond that — ACH prenotes, card 3DS, USDC gas
 * policy, and every sandbox/simulation affordance — belongs on that adapter's
 * own surface and NOT here. Widening this interface for one rail is how an
 * adapter rots back into a schema.
 */
export interface PaymentRail {
  readonly capabilities: RailCapabilities;

  /** Push money out. MUST be idempotent on `req.clientReferenceId`. */
  initiateCredit(req: TransferRequest): Promise<RailTransfer>;

  /**
   * Pull money in. Rejects with a non-retryable `RailError` when
   * `capabilities.supportsDebit` is false.
   */
  initiateDebit(req: TransferRequest): Promise<RailTransfer>;

  /**
   * The authoritative read-back. Used for reconciliation sweeps and to repair
   * state after a missed webhook. Webhooks are hints; this is truth.
   */
  getTransfer(transferId: string): Promise<RailTransfer>;

  /**
   * An already-VERIFIED raw body -> one normalised event.
   *
   * Async because the read-back is part of interpretation on rails whose
   * webhooks are pointers rather than payloads: Increase's body says only
   * "ach_transfer_x changed", and the only way to learn *how* is
   * `getTransfer(x)`. That is a feature — it makes out-of-order delivery
   * harmless, because the read-back reflects the latest state whichever order
   * the notifications arrived in.
   *
   * MUST NEVER THROW on an unrecognised payload. Return `{ type: 'unknown' }`
   * instead; a throw here becomes a 5xx, and a provider that collects enough
   * 5xx responses disables the subscription.
   */
  parseEvent(rawBody: string): Promise<RailEvent>;
}
