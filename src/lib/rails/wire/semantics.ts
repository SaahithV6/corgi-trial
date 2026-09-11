/**
 * Increase's wire objects -> the seven-member `RailEvent` union.
 *
 * Pure functions. No network, no database, no clock. Everything here is a
 * total mapping from a payload the provider gave us onto the vocabulary the
 * ledger already speaks, which is what makes it testable against the exact
 * bytes that were measured.
 *
 * ─── THE ONE THING TO READ BEFORE TOUCHING THIS FILE ────────────────────────
 *
 * A WIRE HAS NO SETTLEMENT OBJECT, AND THAT IS NOT AN OMISSION.
 *
 * ../types.ts documents THE INCREASE TRAP for ACH: a settled ACH transfer
 * keeps `status: "submitted"` and grows a `settlement.settled_at`, so every
 * ACH adapter must PROMOTE `submitted + settled_at` to `settled` or it will
 * never release a hold. The wire endpoint has the mirror-image trap, and it
 * catches you the other way round:
 *
 *   MEASURED 2026-09-11, one transfer, one simulated submit:
 *     status:      pending_creating  ->  complete
 *     submission:  null              ->  { input_message_accountability_data,
 *                                          submitted_at }
 *     settlement:  (no such field, at any point)
 *
 * Fedwire is real-time gross settlement. The Fed accepting the message IS the
 * transfer of funds — final, same day, irrevocable. So `submission.submitted_at`
 * is the settlement time, and an adapter that waited for a settlement field
 * because "that is how Increase does it" would hold a customer's money
 * against an event that is never coming.
 *
 * ─── AND NO RETURN. ANYWHERE. ───────────────────────────────────────────────
 *
 * Nothing in this file can produce `RailEvent` of type `returned`, and that is
 * enforced by the shape of the code rather than promised in a comment: there
 * is no branch that constructs one. A `reversed` wire maps to `settled` —
 * because it did settle, and stays settled — and the money coming back is
 * lifted out separately by `returnOfFunds()` as an INBOUND CREDIT, which is
 * what it is. See ./types.ts `IncreaseWireReversal` for the three measured
 * fields that make that the honest reading.
 */

import { usd, type Money, type RailEvent } from '../types';

import {
  WIRE_PROVIDER,
  type IncreaseEventPointer,
  type IncreaseInboundWireTransfer,
  type IncreaseWireTransfer,
  type InboundWireCredit,
} from './types';

/* -------------------------------------------------------------------------- */
/* The pointer                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Parse a verified webhook body into the pointer it is.
 *
 * Returns null rather than throwing on anything unrecognised. A throw here
 * becomes a 5xx, and a provider that collects enough 5xx responses disables
 * the subscription — the rule ../types.ts states for `parseEvent` and this
 * module obeys for the same reason.
 */
export function parseEventPointer(rawBody: string): IncreaseEventPointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const body = parsed as Partial<IncreaseEventPointer>;
  if (
    typeof body.id !== 'string' ||
    typeof body.category !== 'string' ||
    typeof body.associated_object_id !== 'string' ||
    typeof body.associated_object_type !== 'string'
  ) {
    return null;
  }
  return {
    id: body.id,
    type: typeof body.type === 'string' ? body.type : 'event',
    category: body.category,
    created_at: typeof body.created_at === 'string' ? body.created_at : '',
    associated_object_id: body.associated_object_id,
    associated_object_type: body.associated_object_type,
  };
}

/* -------------------------------------------------------------------------- */
/* The key `rail_event_semantics` is looked up by                             */
/* -------------------------------------------------------------------------- */

/**
 * `<category>/<status>` — the nested-step key convention `semanticsKey()` and
 * the existing Increase ACH rows use.
 *
 * Increase fires ONE `wire_transfer.updated` for submission, completion,
 * cancellation and reversal alike, with the step in the object's `status`, so
 * the whole lifecycle would collapse into one ungovernable row if the key were
 * the category alone. `wire_transfer.created` has no step, because there is
 * only one thing it can mean.
 */
export function wireSemanticsKey(category: string, status: string | null): string {
  if (category.endsWith('.created')) return category;
  return status === null || status.length === 0 ? category : `${category}/${status}`;
}

/* -------------------------------------------------------------------------- */
/* Outbound                                                                   */
/* -------------------------------------------------------------------------- */

/** `amount` is integer minor units on both sides; this is the only cast. */
function money(amount: number): Money {
  return usd(BigInt(Math.trunc(amount)));
}

/**
 * An outbound wire, read as one normalised event.
 *
 * The switch has no `default` for the statuses we model, so a status Increase
 * adds later falls to the explicit `unknown` at the bottom rather than being
 * silently bucketed. `unknown` is not a failure — it is how an unmodelled
 * delivery still gets a 200.
 */
export function outboundWireEvent(
  transfer: IncreaseWireTransfer,
  event: { readonly id: string; readonly occurredAt: string },
): RailEvent {
  const base = {
    provider: WIRE_PROVIDER,
    railKind: 'wire' as const,
    evidence: 'live' as const,
    eventId: event.id,
    transferId: transfer.id,
    occurredAt: event.occurredAt,
    raw: transfer,
  };

  switch (transfer.status) {
    // ---- the settlement, and everything that stays settled ---------------
    //
    // `reversed` is in this branch and it is the load-bearing line of the
    // file. The wire settled. It was final. A beneficiary's bank later chose
    // to send a SECOND payment back — different IMAD, different transaction,
    // null reason code — and none of that makes the original untrue. So the
    // event this delivery reports is still the settlement, with the
    // settlement's own time and the settlement's own amount, and the money
    // coming back is lifted out by `returnOfFunds()` as the separate arrival
    // it is.
    case 'complete':
    case 'reversed': {
      if (transfer.submission === null) {
        // Complete with no submission would mean the Fed accepted a message
        // Increase never told us about. We do not know when it settled, so we
        // do not claim a settlement — `settledAt` is never inferred.
        return {
          ...base,
          type: 'unknown',
          providerType: `wire_transfer:${transfer.status}`,
          reason: 'unparseable',
        };
      }
      return {
        ...base,
        type: 'settled',
        // SUBMISSION IS SETTLEMENT. See the header.
        settledAt: transfer.submission.submitted_at,
        amount: money(transfer.amount),
      };
    }

    // ---- handed to the network, not yet confirmed complete ---------------
    case 'submitted':
      return {
        ...base,
        type: 'submitted',
        submittedAt: transfer.submission?.submitted_at ?? transfer.created_at,
      };

    // ---- it never left ---------------------------------------------------
    //
    // Cancellation is only possible BEFORE submission — the window closes the
    // instant the Fed accepts the message, which is the whole of "a wire
    // cannot be recalled" expressed as a state machine rather than a warning.
    case 'canceled':
      return {
        ...base,
        type: 'canceled',
        canceledAt: transfer.cancellation?.canceled_at ?? event.occurredAt,
      };

    case 'rejected':
      return {
        ...base,
        type: 'failed',
        reason: {
          // Refused by the bank before submission. This is our request being
          // unacceptable, so it is `invalid_request` and not `provider_error`:
          // a fresh attempt on the same details fails the same way.
          category: 'invalid_request',
          code: 'REJECTED',
          providerCode: 'rejected',
          description: 'Increase declined to submit this wire. No IMAD was issued.',
          retryable: false,
        },
      };

    // ---- nothing about the money has changed -----------------------------
    //
    // Every pending status, plus `requires_attention` — which means a human at
    // Increase has to look at it, not that the money did anything.
    case 'pending_approval':
    case 'pending_creating':
    case 'pending_reviewing':
    case 'pending_submission':
    case 'requires_attention':
      return {
        ...base,
        type: 'unknown',
        providerType: `wire_transfer:${transfer.status}`,
        reason: 'no_state_change',
      };

    default:
      return {
        ...base,
        type: 'unknown',
        providerType: `wire_transfer:${String(transfer.status)}`,
        reason: 'unmodelled_event',
      };
  }
}

/**
 * The money a beneficiary's bank sent back, read as a new arrival.
 *
 * Null for every wire that has no reversal, which is almost all of them.
 *
 * THIS IS NOT `reverse`. The contract's `reverse` operation means "report that
 * settled money came back" as a property of the rail, and on a wire it is not
 * one: we cannot cause it, we are not owed it, there is no code to classify it
 * by, and the network saw a different message with a different IMAD. So the
 * adapter declares `supports.reverse: false` and this function — which is on
 * the concrete adapter's own surface, never on the contract — turns the
 * provider's field into the fact it describes: a wire arrived.
 *
 * The value date is the reversal's OWN `created_at`, which is what
 * `rail_event_semantics` row `wire_transfer.updated/reversed` says
 * (`new_event`, `payload.reversal.created_at`). Taking the original's value
 * date would make the ledger claim the payment never happened on the day it
 * provably did.
 */
export function returnOfFunds(transfer: IncreaseWireTransfer): InboundWireCredit | null {
  const reversal = transfer.reversal;
  if (reversal === null) return null;
  return {
    // The arrival's identity is the REVERSAL's, not the original transfer's.
    // Keying it on the original would make a settle-then-return pair look
    // like one event seen twice, and `reportSettlements` dedupes on exactly
    // that key.
    transferId: reversal.transaction_id ?? `${transfer.id}:reversal`,
    imad: reversal.input_message_accountability_data,
    amount: money(reversal.amount),
    acceptedAt: reversal.created_at,
    debtorName: transfer.creditor?.name ?? null,
    remittance: reversal.description,
    returnOfWireTransferId: transfer.id,
  };
}

/* -------------------------------------------------------------------------- */
/* Inbound                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * An inbound wire, read as one normalised event.
 *
 * `accepted` and `reversed` are both `settled` for the same reason `complete`
 * and `reversed` are on the outbound side: the arrival happened. If we later
 * sent the money back out, that is a payment WE made, on the day we made it,
 * and it does not reach back and un-happen the receipt. The statement for the
 * day the wire landed must keep saying the wire landed.
 */
export function inboundWireEvent(
  transfer: IncreaseInboundWireTransfer,
  event: { readonly id: string; readonly occurredAt: string },
): RailEvent {
  const base = {
    provider: WIRE_PROVIDER,
    railKind: 'wire' as const,
    evidence: 'live' as const,
    eventId: event.id,
    transferId: transfer.id,
    occurredAt: event.occurredAt,
    raw: transfer,
  };

  switch (transfer.status) {
    case 'accepted':
    case 'reversed': {
      if (transfer.acceptance === null) {
        return {
          ...base,
          type: 'unknown',
          providerType: `inbound_wire_transfer:${transfer.status}`,
          reason: 'unparseable',
        };
      }
      return {
        ...base,
        type: 'settled',
        // MEASURED: accepted_at === created_at. There is no pending stage on
        // an inbound wire and therefore no gap between arrival and value —
        // which is the entire reason the availability hold on this rail is
        // released the instant it is created.
        settledAt: transfer.acceptance.accepted_at,
        amount: money(transfer.amount),
      };
    }

    case 'declined':
      return {
        ...base,
        type: 'failed',
        reason: {
          category: 'blocked',
          code: 'DECLINED',
          providerCode: 'declined',
          description: 'The inbound wire was declined on arrival; no funds were credited.',
          retryable: false,
        },
      };

    case 'pending':
      return {
        ...base,
        type: 'unknown',
        providerType: 'inbound_wire_transfer:pending',
        reason: 'no_state_change',
      };

    default:
      return {
        ...base,
        type: 'unknown',
        providerType: `inbound_wire_transfer:${String(transfer.status)}`,
        reason: 'unmodelled_event',
      };
  }
}

/**
 * An accepted inbound wire, read as a credit the ledger can book.
 *
 * Null until acceptance, because a wire that has not been accepted is not our
 * money and booking it would be inventing a receivable on a rail that has no
 * receivables.
 */
export function inboundCredit(
  transfer: IncreaseInboundWireTransfer,
): InboundWireCredit | null {
  if (transfer.acceptance === null) return null;
  return {
    transferId: transfer.id,
    imad: transfer.input_message_accountability_data,
    amount: money(transfer.amount),
    acceptedAt: transfer.acceptance.accepted_at,
    // Increase fills whichever of these the message carried. The sandbox
    // simulation fills neither, which is stated in ./client.ts rather than
    // papered over with a placeholder name.
    debtorName: transfer.debtor_name ?? transfer.originator_name,
    remittance:
      transfer.unstructured_remittance_information ??
      transfer.originator_to_beneficiary_information ??
      transfer.description,
    returnOfWireTransferId: null,
  };
}

/**
 * The settlement identity on this rail: the IMAD.
 *
 * ../contract.ts requires the ADAPTER to choose this, because only the adapter
 * knows which kind of rail it is holding:
 *
 *   ACH   the transfer id     — one transfer settles once, and every pointer
 *                               re-read resolves to the same settlement
 *   card  the clearing token  — one transaction settles many times
 *   wire  the IMAD            — one message, one settlement, and a reversal is
 *                               a DIFFERENT message with a DIFFERENT IMAD
 *
 * The IMAD is the strongest of the three, because it is the NETWORK's
 * identifier rather than a provider's. Two providers describing the same
 * Fedwire message agree on it; they do not agree on their own transfer ids.
 *
 * Falls back to the provider id when no IMAD exists — a transfer that has not
 * been submitted has no message and therefore no settlement to identify, so
 * the fallback is only ever reached by non-settling events.
 */
export function wireSettlementRef(
  imad: string | null | undefined,
  providerId: string,
): string {
  return imad === null || imad === undefined || imad.length === 0 ? providerId : imad;
}
