/**
 * The wire rail's vocabulary, and the measured shape of Increase's wire API.
 *
 * ─── WHAT MAKES THIS A SECOND RAIL AND NOT A SECOND ACH ─────────────────────
 *
 * Four differences, and every one of them shows up as a type in this file:
 *
 *   1. FINALITY.  There is no `WireReturnReason`, because there is no wire
 *      return-code table to model. ACH has R01-R85; Fedwire has nothing of
 *      the kind. MEASURED 2026-09-11: Increase's reversal object HAS a
 *      `return_reason_code` field and the network left it null.
 *
 *   2. SETTLEMENT IS SUBMISSION.  `IncreaseWireTransfer` has a `submission`
 *      and NO settlement object. Fedwire is real-time gross settlement: the
 *      moment the Fed accepts the message and issues the IMAD, the funds have
 *      moved, irrevocably. This is the exact mirror of the Increase ACH trap
 *      documented in ../types.ts — there, `status` stays `submitted` and a
 *      `settlement.settled_at` appears later, so the adapter must PROMOTE;
 *      here, `status` becomes `complete` and no settlement object will ever
 *      appear, so an adapter that waits for one waits forever.
 *
 *   3. THE IMAD IS THE MONEY'S NAME.  `input_message_accountability_data` is
 *      the Fedwire Input Message Accountability Data: the network's own
 *      identifier for the payment, unique per message, and the thing a
 *      beneficiary's bank quotes back at you when something goes wrong. It is
 *      the settlement identity on this rail for the same reason the transfer
 *      id is on ACH and the clearing token is on a card — see `settlementRef`
 *      in ../contract.ts. A reversal gets a DIFFERENT IMAD, which is the
 *      single most useful fact in this file.
 *
 *   4. THE ADDRESS IS THE WIRE ABA, NOT THE ACH ONE.  A bank routinely holds
 *      two routing numbers, and `src/lib/payees/` already knows it: the
 *      seeded Plaid item carries 011401533 for ACH and 021000021 for wire,
 *      and Increase's routing-number directory reports `wire_transfers` as a
 *      field of its own. Substituting one for the other is an R13 on ACH; on
 *      a wire it is a message the Fed cannot route at all. `WireBeneficiary`
 *      therefore carries `wireRoutingNumber` as a distinct, named field and
 *      never a bare `routingNumber`.
 *
 * ─── EVERY AMOUNT HERE IS bigint CENTS ──────────────────────────────────────
 *
 * Increase speaks `number` for `amount` (integer minor units). The conversion
 * happens at this boundary and nowhere else, exactly as the card adapter does
 * it: `BigInt(n)` on the way in, `Number(b)` on the way out, both inside
 * ./client.ts.
 */

import type { Money } from '../types';

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The slug persisted on ledger rows, webhook routing and probe output.
 *
 * NOT `increase.ach`. One vendor, two rails: the ACH adapter's slug names its
 * rail and so does this one, so `reportSettlements` can route a delivery to
 * the adapter that understands it, and a ledger row says which network moved
 * the money rather than which company we bought it from.
 *
 * The webhook inbox is keyed on the VENDOR (`provider = 'increase'`) because
 * that is what signs the request, and the two keys are deliberately different
 * words for different things. `isWireDelivery()` below is the one function
 * that bridges them.
 */
export const WIRE_PROVIDER = 'increase.wire';

export const WIRE_TITLE = 'Increase wire (Fedwire)';

/* -------------------------------------------------------------------------- */
/* Increase's wire API, as measured                                           */
/* -------------------------------------------------------------------------- */

/**
 * `wire_transfer.status`, verbatim.
 *
 * Written as a union of literals plus `(string & {})` so an unrecognised
 * status from the provider does not become a type error at runtime — a rail
 * must never crash on a value the provider invented after we shipped. The
 * mapping in ./semantics.ts handles the unknown case explicitly.
 */
export type IncreaseWireStatus =
  | 'pending_approval'
  | 'pending_creating'
  | 'pending_reviewing'
  | 'pending_submission'
  | 'canceled'
  | 'complete'
  | 'rejected'
  | 'requires_attention'
  | 'reversed'
  | 'submitted';

/** `inbound_wire_transfer.status`, verbatim. */
export type IncreaseInboundWireStatus = 'pending' | 'accepted' | 'declined' | 'reversed';

/**
 * The submission half. Present once the message has been handed to Fedwire,
 * and on this rail its timestamp IS the settlement timestamp.
 */
export interface IncreaseWireSubmission {
  readonly input_message_accountability_data: string;
  readonly submitted_at: string;
}

/**
 * The reversal, MEASURED on 2026-09-11 against sandbox.increase.com.
 *
 * Read the three fields that matter together, because they are the argument
 * for `supports.reverse === false`:
 *
 *   class_name                            'inbound_wire_reversal'
 *   input_message_accountability_data     a DIFFERENT IMAD from the original
 *   return_reason_code                    null
 *
 * A different IMAD means the network saw a different message. `inbound`
 * means it came the other way. A null reason code means there was no code to
 * give, because no wire return-code table exists. Taken together: what came
 * back is a SECOND PAYMENT the beneficiary's bank chose to send, referencing
 * the first. It is not our original transfer being unwound, and nothing we
 * can do makes it happen.
 */
export interface IncreaseWireReversal {
  readonly amount: number;
  readonly created_at: string;
  readonly class_name: string;
  readonly description: string | null;
  readonly input_message_accountability_data: string | null;
  readonly transaction_id: string | null;
  readonly wire_transfer_id: string | null;
  /** Present in the schema; null in every measurement. See above. */
  readonly return_reason_code: string | null;
  readonly return_reason_code_description: string | null;
  /** The Fedwire field that would carry the original message's IMAD. */
  readonly previous_message_input_message_accountability_data: string | null;
  readonly debtor_routing_number: string | null;
}

export interface IncreaseWireCancellation {
  readonly canceled_at: string;
  readonly canceled_by?: unknown;
}

/** `POST /wire_transfers` / `GET /wire_transfers/{id}`, the fields we read. */
export interface IncreaseWireTransfer {
  readonly type: 'wire_transfer';
  readonly id: string;
  readonly account_id: string;
  readonly amount: number;
  readonly currency: string;
  readonly status: IncreaseWireStatus | (string & {});
  readonly created_at: string;
  readonly network: string;
  /** The beneficiary's WIRE routing number. Never the ACH one. */
  readonly routing_number: string | null;
  readonly account_number: string | null;
  readonly external_account_id: string | null;
  readonly creditor: { readonly name: string | null } | null;
  readonly debtor: { readonly name: string | null } | null;
  /** Null until the message is handed to Fedwire. Then it is the settlement. */
  readonly submission: IncreaseWireSubmission | null;
  readonly cancellation: IncreaseWireCancellation | null;
  readonly reversal: IncreaseWireReversal | null;
  readonly transaction_id: string | null;
  readonly pending_transaction_id: string | null;
  readonly idempotency_key: string | null;
  /** ISO 20022 end-to-end reference. Increase generates one per transfer. */
  readonly unique_end_to_end_transaction_reference: string | null;
}

/** The acceptance half of an inbound wire. Its timestamp is the value date. */
export interface IncreaseInboundWireAcceptance {
  readonly accepted_at: string;
  readonly transaction_id: string;
}

/** `POST /inbound_wire_transfers/{id}/reverse` — a PRODUCTION method, not a simulation. */
export interface IncreaseInboundWireReversal {
  readonly reason: string;
  readonly reversed_at: string;
}

/** `GET /inbound_wire_transfers/{id}`, the fields we read. */
export interface IncreaseInboundWireTransfer {
  readonly type: 'inbound_wire_transfer';
  readonly id: string;
  readonly account_id: string;
  readonly account_number_id: string;
  readonly amount: number;
  readonly status: IncreaseInboundWireStatus | (string & {});
  readonly created_at: string;
  readonly description: string | null;
  readonly input_message_accountability_data: string | null;
  readonly debtor_name: string | null;
  readonly debtor_account_number: string | null;
  readonly debtor_routing_number: string | null;
  readonly originator_name: string | null;
  readonly originator_routing_number: string | null;
  readonly unstructured_remittance_information: string | null;
  readonly originator_to_beneficiary_information: string | null;
  /**
   * MEASURED: `accepted_at` equals `created_at` exactly. An inbound wire has
   * no pending stage — it is either accepted on arrival or it is not ours.
   * This is where "available immediately" comes from; there is no gap between
   * arrival and value to hold anything in.
   */
  readonly acceptance: IncreaseInboundWireAcceptance | null;
  readonly reversal: IncreaseInboundWireReversal | null;
}

/**
 * The webhook body, MEASURED. It is a POINTER, exactly like ACH's.
 *
 *   {"id":"sandbox_event_...","type":"event",
 *    "category":"inbound_wire_transfer.created",
 *    "created_at":"2026-09-11T03:59:30Z",
 *    "associated_object_id":"sandbox_inbound_wire_transfer_...",
 *    "associated_object_type":"inbound_wire_transfer"}
 *
 * Nothing about the money is in it. `observe()` therefore reads the object
 * back, which is what makes out-of-order delivery harmless on this rail too:
 * whichever notification arrives first, the read-back reflects current state.
 */
export interface IncreaseEventPointer {
  readonly id: string;
  readonly type: string;
  readonly category: string;
  readonly created_at: string;
  readonly associated_object_id: string;
  readonly associated_object_type: string;
}

/** The four Increase event categories this rail answers for. */
export const WIRE_EVENT_CATEGORIES = [
  'wire_transfer.created',
  'wire_transfer.updated',
  'inbound_wire_transfer.created',
  'inbound_wire_transfer.updated',
] as const;

/**
 * Does this delivery belong to the wire rail rather than the ACH one?
 *
 * The webhook inbox keys on the VENDOR (`increase`), and one vendor serves two
 * rails here. A dispatcher deciding which adapter gets a verified body needs
 * exactly this predicate and nothing else, so it lives beside the categories
 * rather than being re-derived with a `startsWith` at the call site.
 */
export function isWireDelivery(category: string): boolean {
  return (WIRE_EVENT_CATEGORIES as readonly string[]).includes(category);
}

/* -------------------------------------------------------------------------- */
/* Our vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where an outbound wire is going.
 *
 * `wireRoutingNumber` is named, not `routingNumber`, because the mistake this
 * rail actually suffers is substituting the ACH variant — a number that is a
 * perfectly valid ABA, passes the check digit, names the right bank, and
 * cannot be routed by Fedwire. A field called `routingNumber` accepts that
 * mistake in silence. This one at least asks the caller which they have.
 */
export interface WireBeneficiary {
  /** The name that goes on the Fedwire message. ISO 20022 `creditor.name`. */
  readonly name: string;
  /** The receiving bank's 9-digit WIRE ABA. Not its ACH ABA. */
  readonly wireRoutingNumber: string;
  readonly accountNumber: string;
  /** Shown to an approver; never sent. */
  readonly accountNumberLast4?: string | undefined;
}

/**
 * An outbound wire instruction — the `I` in `OriginatingRail<I>`.
 *
 * Deliberately NOT `TransferRequest`. That type is ACH-shaped: it carries a
 * SEC-code `authorization` intent and a 10-character `statementDescriptor`,
 * neither of which exists on Fedwire, and it lacks the one field Increase now
 * REQUIRES — `remittance`, the ISO 20022 structured/unstructured remittance
 * information. ../contract.ts is explicit that this is the right call:
 * "OriginatingRail is generic in its INSTRUCTION and uniform in its OUTCOME",
 * because a caller that is originating has already chosen the rail by choosing
 * the destination.
 */
export interface WireInstruction {
  /** Our id, and the Idempotency-Key. Stable across retries of one intent. */
  readonly clientReferenceId: string;
  /** The funding account at Increase. */
  readonly sourceAccountId: string;
  readonly beneficiary: WireBeneficiary;
  /** Positive magnitude, integer cents. */
  readonly amount: Money;
  /**
   * What the beneficiary sees. Increase requires it: `remittance.category`
   * plus, for `unstructured`, `remittance.unstructured.message`. MEASURED —
   * omitting it is a 400 naming the field.
   */
  readonly remittance: string;
}

/**
 * One inbound wire receipt, normalised, ready to be booked.
 *
 * Produced by ./adapter.ts from either an `inbound_wire_transfer` (money
 * somebody sent us) or the `reversal` on an outbound `wire_transfer` (money a
 * beneficiary's bank sent back). Those are the same KIND of fact — a wire
 * arrived — which is exactly the claim `supports.reverse === false` makes, so
 * they produce the same type and are booked by the same function.
 */
export interface InboundWireCredit {
  /** Increase's id for the arrival. The ledger's `external_ref` is built from it. */
  readonly transferId: string;
  /** The Fedwire IMAD. The settlement identity on this rail. */
  readonly imad: string | null;
  readonly amount: Money;
  /** When the money became ours. `acceptance.accepted_at`, never our clock. */
  readonly acceptedAt: string;
  /** Who sent it, as far as the message says. Often null in sandbox. */
  readonly debtorName: string | null;
  /** Free text off the message, for the ledger description. */
  readonly remittance: string | null;
  /**
   * Whether this arrival is the return of a wire we sent.
   *
   * Carried so the ledger description can say so, and for NO other reason:
   * the posting, the hold, the policy and the availability are identical
   * either way, because it is the same event. A flag that changed the money
   * would be `reverse` wearing a different name.
   */
  readonly returnOfWireTransferId: string | null;
}
