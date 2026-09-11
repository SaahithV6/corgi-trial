/**
 * The card slot, behind the rail contract — and the first time Lithic has been
 * behind any interface at all.
 *
 * ─── A CARD RAIL NEVER ORIGINATES A PAYMENT ─────────────────────────────────
 *
 * This is the asymmetry the contract exists to express rather than paper over.
 * Every other rail here is instructed: we tell Increase to move money, we tell
 * the chain to move money. Nobody tells a card network anything. A merchant's
 * acquirer originates; the network routes; Lithic tells us afterwards, twice —
 * once as an authorisation and again, days later and for a different amount, as
 * a clearing.
 *
 * So `supports.originate` is `{ supported: false }` with that sentence as its
 * reason, and there is NO `originate` method on this object. `canOriginate()`
 * returns false, the compiler refuses the call, and nothing anywhere has to
 * catch a `RailError` saying "not supported". `POST /v1/simulate/authorize`
 * exists and this adapter deliberately does not expose it as origination: it
 * plays the acquirer for a test, which is the opposite of us instructing a
 * payment, and dressing it up as `originate` would make the capability matrix
 * lie in the most flattering possible direction.
 *
 * ─── THE BODY CARRIES STATE, SO THERE IS NO READ-BACK ───────────────────────
 *
 * Increase POSTs a pointer and the ACH adapter has to fetch the transfer to
 * learn anything. Lithic POSTs the whole `Transaction`, events array included.
 * `observe` is therefore pure: no network, no clock, no rate limiter, and safe
 * to call on a stored payload while replaying history.
 *
 * The cost is that out-of-order delivery is NOT free here the way it is on
 * ACH. A stale redelivery carries a stale events array, and this adapter
 * reports what that body says because that is what the body says. Ordering is
 * the consumer's problem and `src/lib/webhooks/` already owns it.
 *
 * ─── WHICH EVENT IS THIS DELIVERY ABOUT ─────────────────────────────────────
 *
 * One transaction accumulates an events array and fires
 * `card_transaction.updated` on EVERY step, so a delivery is about the LAST
 * step in the array it carries. Ordering is `created`, with payload order as
 * the tie-break — the same rule, for the same reason, as `deriveCardEvents` in
 * `src/lib/holds/lithic-events.ts`: Lithic delivers in chronological order
 * already, and sorting makes this independent of that promise rather than
 * dependent on it. (These two functions agree by inspection and not by
 * construction. They map the same payload to different targets — this one to
 * the rail-agnostic event union, that one to hold arithmetic and card_auth_event
 * rows — so the shared six lines are duplicated deliberately rather than
 * inverting the layering and making rails/ depend on holds/.)
 */

import {
  makeRailProbe,
  settlementFromEvent,
  type ObservingRail,
  type RailIdentity,
  type RailObservation,
  type RailProbe,
  type RailProbeOptions,
  type RailSupport,
} from '../contract';
import { LITHIC_SANDBOX_BASE_URL } from '../lithic/client';
import type {
  Transaction,
  TransactionEvent,
  TransactionEventType,
} from '../lithic/types';
import type { Money, RailEvent, RailReturnReason } from '../types';
import { livenessFromStatus, readEnvValue, timedFetch } from './probe-http';

export const LITHIC_PROVIDER_SLUG = 'lithic.card';

/** The only Lithic event carrying the authorisation/clearing lifecycle. */
const LIFECYCLE_EVENT = 'card_transaction.updated';

/**
 * What each lifecycle step means for MONEY — which is a different question
 * from what it means for a hold, and a different question again from whether
 * it is a correction.
 *
 *   moved      money changed hands. A settlement, in the contract's sense.
 *   returned   settled money came back.
 *   held       a hold moved. No money did.
 *   released   a hold was released without money moving.
 *   nothing    no effect on either.
 *   unclassified
 *              a real Lithic event type that no provider call in this repo has
 *              ever produced. NOT mapped, on purpose. See below.
 *
 * ─── THE TRAP THIS TABLE EXISTS TO ABSORB ───────────────────────────────────
 *
 * `AUTHORIZATION_REVERSAL` reverses the AUTHORISATION and never the
 * settlement. Measured, in docs/CARD-CORRECTIONS.md, against the exact
 * transaction this track is built around: a $50.00 authorisation that cleared
 * at $73.40, then `POST /simulate/void` — which appended
 * `AUTHORIZATION_REVERSAL −7340` and left `settled_amount` UNCHANGED at 7340.
 *
 * A reasonable-looking adapter reads the word "reversal", maps it to the
 * contract's `returned`, and reports that $73.40 came back. It did not. The
 * customer's money is still gone, the hold is what was released, and a
 * settlement report built on that mapping would be short by $73.40 and
 * perfectly self-consistent about it. So a void is `released`, and the only
 * two things that put money back on a card are `RETURN` and the corrections
 * this adapter refuses to guess at.
 *
 * ─── AND THE THREE IT REFUSES TO CLASSIFY ───────────────────────────────────
 *
 * `CORRECTION_DEBIT` and `CORRECTION_CREDIT` are published Lithic event types
 * and NO sandbox endpoint emits them: `/v1/simulate/correction`,
 * `/correction_debit` and `/correction_credit` are all 404, measured. Nothing
 * in this repo has ever seen one. They almost certainly move money — and
 * "almost certainly" is not the standard. They come back as `unknown` with
 * `unmodelled_event`, which produces a 200, keeps the bytes, and leaves the
 * decision to `rail_event_semantics` and the ledger consumer, which is where
 * a reviewed row for them belongs anyway.
 */
type MoneyEffect = 'moved' | 'returned' | 'held' | 'released' | 'nothing' | 'unclassified';

const MONEY_EFFECT: Readonly<Record<TransactionEventType, MoneyEffect>> = {
  // Holds. The money has not moved and may never move for this amount.
  AUTHORIZATION: 'held',
  CREDIT_AUTHORIZATION: 'held',
  AUTHORIZATION_ADVICE: 'held',
  CREDIT_AUTHORIZATION_ADVICE: 'held',

  // Money moved.
  CLEARING: 'moved',
  // Single-message: settles immediately and never holds. [MEASURED] a
  // FINANCIAL_AUTHORIZATION of 2500 reads status SETTLED with hold 0.
  FINANCIAL_AUTHORIZATION: 'moved',
  FINANCIAL_CREDIT_AUTHORIZATION: 'moved',
  // [MEASURED] a RETURN is an independent CREDIT transaction that settles
  // immediately, and a RETURN_REVERSAL undoes it ~45s later with a real
  // signed webhook. The pair nets to zero, which is what the arithmetic in
  // `reportSettlements` will show.
  RETURN_REVERSAL: 'moved',
  RETURN: 'returned',

  // Holds released, nothing moved. See the trap above.
  AUTHORIZATION_REVERSAL: 'released',
  AUTHORIZATION_EXPIRY: 'released',

  BALANCE_INQUIRY: 'nothing',

  // Never observed. Never guessed.
  CORRECTION_DEBIT: 'unclassified',
  CORRECTION_CREDIT: 'unclassified',
};

/** Absolute magnitude, defensive against a missing or non-numeric field. */
function absCents(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.abs(Math.trunc(value));
}

/**
 * The event's own amount, as positive `bigint` minor units.
 *
 * Settlement figure first, falling back to the deprecated flat `amount` — the
 * same precedence `normalizeTransaction` uses, so the two cannot disagree
 * about what a step was worth. `Cents` is a `number` on Lithic's wire and
 * becomes a `bigint` here, at this adapter's boundary and nowhere else, which
 * is exactly what ../types.ts asks of an adapter whose provider speaks number.
 */
function eventAmount(event: TransactionEvent): Money {
  const settlement = event.amounts?.settlement?.amount;
  const cents =
    typeof settlement === 'number' && Number.isFinite(settlement)
      ? absCents(settlement)
      : absCents(event.amount);
  return { amount: BigInt(cents), currency: 'USD' };
}

/**
 * A card return has no failure reason, and this says so rather than inventing
 * one.
 *
 * `ReturnCategory` buckets the reasons a bank refused a transfer — R01 through
 * R29, a declined card, a reverted transfer. A cardholder refund is not a
 * refusal; nothing went wrong. `unknown` is the honest bucket, and the
 * provider's own word survives in `code` and `providerCode` so nothing is lost
 * to the normalisation.
 */
function cardReturnReason(type: TransactionEventType): RailReturnReason {
  return {
    category: 'unknown',
    code: type,
    providerCode: type,
    description: 'card return: the merchant refunded a settled transaction, not a refusal',
    retryable: false,
  };
}

/** Chronological, with payload order as the tie-break. See the header. */
function orderedEvents(txn: Transaction): readonly TransactionEvent[] {
  const raw = txn.events ?? [];
  return [...raw]
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const ta = Date.parse(a.event.created ?? txn.created ?? '');
      const tb = Date.parse(b.event.created ?? txn.created ?? '');
      if (ta !== tb) return ta - tb;
      return a.index - b.index;
    })
    .map(({ event }) => event);
}

/**
 * One Lithic delivery -> one `RailEvent`.
 *
 * Exported because it is the whole adapter and it is worth testing on its own
 * against measured payloads, with no probe, no client and no key.
 *
 * NEVER THROWS. A body that is not JSON, is not a transaction, or is an event
 * type this adapter does not model comes back as `unknown` — which is a 200,
 * and a 200 is the difference between an unmodelled event and a disabled
 * subscription. Lithic retries a 5xx eight times.
 */
export function parseLithicEvent(rawBody: string): RailEvent {
  const base = {
    provider: LITHIC_PROVIDER_SLUG,
    railKind: 'card' as const,
    evidence: 'live' as const,
  };

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return {
      ...base,
      eventId: '',
      transferId: '',
      occurredAt: new Date().toISOString(),
      type: 'unknown',
      providerType: 'unparseable',
      reason: 'unparseable',
      raw: rawBody,
    };
  }

  if (typeof body !== 'object' || body === null) {
    return {
      ...base,
      eventId: '',
      transferId: '',
      occurredAt: new Date().toISOString(),
      type: 'unknown',
      providerType: 'malformed',
      reason: 'unparseable',
      raw: body,
    };
  }

  const envelope = body as { event_type?: unknown } & Partial<Transaction>;
  const eventType = typeof envelope.event_type === 'string' ? envelope.event_type : 'absent';

  if (eventType !== LIFECYCLE_EVENT) {
    // A real Lithic event about something this adapter does not model — a card
    // shipping, a dispute, a balance update. 200 and move on.
    return {
      ...base,
      eventId: '',
      transferId: typeof envelope.token === 'string' ? envelope.token : '',
      occurredAt: new Date().toISOString(),
      type: 'unknown',
      providerType: eventType,
      reason: 'unmodelled_event',
      raw: body,
    };
  }

  const txn = envelope as Transaction;
  if (typeof txn.token !== 'string' || txn.token === '') {
    return {
      ...base,
      eventId: '',
      transferId: '',
      occurredAt: new Date().toISOString(),
      type: 'unknown',
      providerType: eventType,
      reason: 'unparseable',
      raw: body,
    };
  }

  /**
   * A timestamp is required and cannot be invented from the payload when the
   * payload does not carry one.
   *
   * Every real `card_transaction.updated` has `created` on the transaction and
   * on each event. A body that does not is malformed, and the honest fallback
   * is OUR receipt time, clearly ours — not a zero date, and not a crash in a
   * function contracted never to throw. `raw` keeps the body either way, so
   * nothing is lost to the substitution.
   */
  const receivedAt = new Date().toISOString();
  const txnCreated = typeof txn.created === 'string' ? txn.created : receivedAt;

  const ordered = orderedEvents(txn);
  const step = ordered.at(-1);

  if (step === undefined) {
    // A lifecycle delivery with no lifecycle in it. Recognised, and nothing
    // about the money's fate changed.
    return {
      ...base,
      eventId: txn.token,
      transferId: txn.token,
      occurredAt: txnCreated,
      type: 'unknown',
      providerType: eventType,
      reason: 'no_state_change',
      raw: body,
    };
  }

  const eventBase = {
    ...base,
    // The STEP's token, not the transaction's: one transaction fires this
    // webhook once per step, so the transaction token would collapse an
    // authorisation and its clearing into one id and lose the second.
    eventId: step.token,
    transferId: txn.token,
    occurredAt: typeof step.created === 'string' ? step.created : txnCreated,
    raw: body,
  };

  // `?? 'unclassified'` is NOT dead code, and the type system says it is.
  //
  // `MONEY_EFFECT` is keyed by `TransactionEventType`, so TypeScript is
  // certain this lookup succeeds — and TypeScript is reasoning about our copy
  // of Lithic's union, not about what Lithic will POST tomorrow. A step type
  // added at the provider arrives here as a key this table does not have, the
  // lookup is `undefined`, and without this the switch falls through and
  // returns nothing at all from a function whose contract is that it always
  // returns an event. That was live for one test run.
  const effect: MoneyEffect = MONEY_EFFECT[step.type] ?? 'unclassified';

  switch (effect) {
    case 'moved':
      return { ...eventBase, type: 'settled', settledAt: eventBase.occurredAt, amount: eventAmount(step) };
    case 'returned':
      return {
        ...eventBase,
        type: 'returned',
        returnedAt: eventBase.occurredAt,
        reason: cardReturnReason(step.type),
        amount: eventAmount(step),
      };
    case 'held':
      return { ...eventBase, type: 'submitted', submittedAt: eventBase.occurredAt };
    case 'released':
      return { ...eventBase, type: 'canceled', canceledAt: eventBase.occurredAt };
    case 'nothing':
      return { ...eventBase, type: 'unknown', providerType: step.type, reason: 'no_state_change' };
    case 'unclassified':
      return { ...eventBase, type: 'unknown', providerType: step.type, reason: 'unmodelled_event' };
  }
}

const LITHIC_SUPPORT: RailSupport = {
  originate: {
    supported: false,
    reason:
      'A card rail never originates a payment. The merchant’s acquirer does; Lithic reports it to us afterwards. POST /v1/simulate/authorize plays the acquirer for a test and is not origination.',
  },
  observe: {
    supported: true,
    proof: 'measured',
    evidence:
      'card_transaction.updated carries the whole Transaction, events array included. Real signed deliveries are in webhook_inbox; the negative control (tampered signature) answers 401.',
  },
  settle: {
    supported: true,
    proof: 'measured',
    evidence:
      'CLEARING carries its own amount, which differs from the authorisation: $50.00 authorised, $73.40 cleared, measured.',
  },
  reverse: {
    supported: true,
    proof: 'measured',
    evidence:
      'RETURN then RETURN_REVERSAL, measured end to end with a real webhook ~45s later. A clearing itself CANNOT be reversed — return_reversal on a debit transaction is a 400, also measured.',
  },
  probe: {
    supported: true,
    proof: 'measured',
    evidence: 'GET /v1/cards?page_size=1 with the sandbox key.',
  },
};

/**
 * The Lithic card adapter.
 *
 * `evidence` is the literal `'live'` and not a constructor argument, for the
 * same reason the Plaid and Increase adapters do it: the sandbox is Lithic's
 * own system answering our fetch, so a fact from it IS live evidence, and no
 * configuration mistake should be able to make something else claim to be
 * this.
 */
export function lithicCardAdapter(
  args: { readonly env?: Readonly<Record<string, string | undefined>> | undefined } = {},
): ObservingRail {
  const env = args.env ?? process.env;
  const baseUrl = (readEnvValue(env, 'LITHIC_BASE_URL') ?? LITHIC_SANDBOX_BASE_URL).replace(/\/+$/, '');
  const identity: RailIdentity = {
    slot: 'card',
    provider: LITHIC_PROVIDER_SLUG,
    title: 'Lithic card issuing',
    evidence: 'live',
    environment: baseUrl.includes('sandbox') ? 'sandbox' : 'production',
  };

  return {
    identity,
    supports: LITHIC_SUPPORT,

    observe(rawBody: string): Promise<RailObservation> {
      const event = parseLithicEvent(rawBody);
      // THE EVENT, not the transaction.
      //
      // The opposite choice from the ACH adapter, and for the opposite reason:
      // one card transaction settles as many times as the merchant likes.
      // `auth 1000, clearing 600, clearing 300` is two settlements on one
      // token, and keying them by the token would lose $3.00. `eventId` is the
      // clearing event's own token, which is also stable across a redelivery —
      // so partial captures stay distinct and a replay is still one.
      return Promise.resolve({ event, settlement: settlementFromEvent(event, event.eventId) });
    },

    async probe(opts: RailProbeOptions = {}): Promise<RailProbe> {
      const key = readEnvValue(env, 'LITHIC_API_KEY');
      if (key === undefined) {
        return makeRailProbe(identity, {
          liveness: 'not_configured',
          detail: 'LITHIC_API_KEY absent',
          ms: 0,
        });
      }
      // Lithic sends the key BARE in Authorization — no `Bearer` prefix. This
      // is the one line of this probe that is not shared with the others.
      const { res, ms, err } = await timedFetch(
        `${baseUrl}/cards?page_size=1`,
        { headers: { Authorization: key } },
        opts,
      );
      if (res === null) {
        return makeRailProbe(identity, { liveness: 'unreachable', detail: err ?? 'no response', ms });
      }
      return makeRailProbe(identity, {
        liveness: livenessFromStatus(res.status),
        detail: `GET /v1/cards?page_size=1 -> ${res.status}`,
        ms,
      });
    },
  };
}
