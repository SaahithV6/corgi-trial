/**
 * MEASURED PAYLOADS. Not fixtures shaped like payloads — the actual bytes.
 *
 * Every object in this file came off sandbox.increase.com, or out of the
 * deployed system's `webhook_inbox`, on 2026-09-11 with the trial's own
 * credential, and is pasted here unaltered but for ONE redaction noted below.
 * That is the whole point: a unit test asserting against a hand-written object
 * tests the author's belief about the provider, and the two measured surprises
 * on this rail — Increase moving the wire endpoint to ISO 20022 nouns, and a
 * wire having no settlement object at all — are exactly what a hand-written
 * fixture would have hidden.
 *
 * THE ONE REDACTION: `wire_transfer.account_number` is masked to
 * `**********0000`. It was Plaid's published sandbox number and nothing was at
 * risk, but a full account number does not belong in a repo even when it is
 * fake, and the last four is all any assertion here needs.
 *
 * Re-earn them:
 *
 *   set -a; . ./.env; set +a; RUN_LIVE_PROBES=1 pnpm vitest run \
 *     src/lib/rails/wire/wire.integration.test.ts
 */

import type { IncreaseInboundWireTransfer, IncreaseWireTransfer } from './types';

/**
 * The outbound wire this rail actually sent, read back AFTER a simulated
 * reversal. Four things in it carry the whole argument:
 *
 *   status                                        'reversed'
 *   submission.input_message_accountability_data   '20260911sgzamiaa787670'
 *   reversal.input_message_accountability_data     '20260911apvdjfqt599399'  <- DIFFERENT
 *   reversal.return_reason_code                    null
 *
 * A different IMAD means the network saw a different message. A null reason
 * code means there was no code to give, because no wire return-code table
 * exists. And there is no `settlement` field anywhere in the object.
 */
export const MEASURED_OUTBOUND_WIRE = {
  "type": "wire_transfer",
  "id": "sandbox_wire_transfer_897tmwn18z27tzkqbkhe",
  "message_to_recipient": "CORGI WIRE TEST",
  "amount": 250000,
  "currency": "USD",
  "account_number": "**********0000",
  "remittance": {
    "category": "unstructured",
    "unstructured": {
      "message": "CORGI WIRE TEST"
    },
    "tax": null
  },
  "beneficiary_name": "Ridgeline Robotics Inc",
  "beneficiary_address_line1": null,
  "beneficiary_address_line2": null,
  "beneficiary_address_line3": null,
  "creditor": {
    "name": "Ridgeline Robotics Inc",
    "address": null
  },
  "originator_name": "Corgi (48 hour work trial)",
  "originator_address_line1": "33 Liberty Street",
  "originator_address_line2": "New York",
  "originator_address_line3": "NY, 10045",
  "debtor": {
    "name": "Corgi (48 hour work trial)",
    "address": {
      "unstructured": {
        "line1": "33 Liberty Street",
        "line2": "New York",
        "line3": "NY, 10045"
      },
      "structured": null
    }
  },
  "account_id": "sandbox_account_zkfx1wcn4brwoaiyksj6",
  "source_account_number_id": null,
  "inbound_wire_drawdown_request_id": null,
  "external_account_id": null,
  "routing_number": "021000021",
  "approval": null,
  "cancellation": null,
  "reversal": {
    "amount": 250000,
    "created_at": "2026-09-11T03:58:50Z",
    "class_name": "inbound_wire_reversal",
    "description": "Inbound wire reversal",
    "input_cycle_date": "-4712-01-01",
    "input_sequence_number": "1",
    "input_source": "8C5P8B",
    "input_message_accountability_data": "20260911apvdjfqt599399",
    "transaction_id": "sandbox_transaction_z2nbixfsj9yy6kmf1nc0",
    "wire_transfer_id": "sandbox_wire_transfer_897tmwn18z27tzkqbkhe",
    "instruction_identification": null,
    "debtor_routing_number": "479016407",
    "return_reason_code": null,
    "return_reason_code_description": null,
    "return_reason_additional_information": null,
    "sender_reference": null,
    "originator_routing_number": null,
    "previous_message_input_message_accountability_data": null,
    "previous_message_input_cycle_date": null,
    "previous_message_input_sequence_number": null,
    "previous_message_input_source": null,
    "receiver_financial_institution_information": null,
    "financial_institution_to_financial_institution_information": null,
    "originator_to_beneficiary_information": null
  },
  "created_at": "2026-09-11T03:58:17Z",
  "network": "wire",
  "path": "/transfers/sandbox_wire_transfer_897tmwn18z27tzkqbkhe",
  "status": "reversed",
  "submission": {
    "input_message_accountability_data": "20260911sgzamiaa787670",
    "submitted_at": "2026-09-11T03:58:34Z"
  },
  "transaction_id": "sandbox_transaction_2ff00n3glfneatkctcl9",
  "pending_transaction_id": "sandbox_pending_transaction_4ju78ykcnucoym5ehm38",
  "created_by": {
    "category": "api_key",
    "api_key": {
      "description": null
    }
  },
  "unique_end_to_end_transaction_reference": "d6f0e8c6-05cc-450c-bc42-12333d595621",
  "idempotency_key": "corgi-wire-27138-12782",
  "unique_identifier": "corgi-wire-27138-12782"
} as unknown as IncreaseWireTransfer;

/**
 * The inbound wire, read back after we sent it back out.
 *
 * `acceptance.accepted_at` equals `created_at` to the second: an inbound wire
 * has no pending stage, which is where "available immediately" comes from.
 * `reversal.reason` is 'creditor_request' — the creditor being us, because
 * `POST /inbound_wire_transfers/{id}/reverse` is a production method and not a
 * simulation.
 */
export const MEASURED_INBOUND_WIRE = {
  "type": "inbound_wire_transfer",
  "id": "sandbox_inbound_wire_transfer_00lkxr57i04x31blx06x",
  "amount": 1250000,
  "account_id": "sandbox_account_zkfx1wcn4brwoaiyksj6",
  "account_number_id": "sandbox_account_number_96mzhz3n61f5p0jpvytc",
  "status": "reversed",
  "created_at": "2026-09-11T03:59:29Z",
  "description": "Test wire transfer",
  "input_message_accountability_data": "20260911conbtmwu493867",
  "creditor_address_line1": null,
  "creditor_address_line2": null,
  "creditor_address_line3": null,
  "creditor_name": null,
  "end_to_end_identification": null,
  "debtor_address_line1": null,
  "debtor_address_line2": null,
  "debtor_address_line3": null,
  "debtor_name": null,
  "debtor_account_number": "987654321",
  "debtor_routing_number": "101050001",
  "instructing_agent_routing_number": "101050001",
  "unstructured_remittance_information": null,
  "purpose": null,
  "instruction_identification": null,
  "unique_end_to_end_transaction_reference": "07b440bb-aa9c-46bc-afd3-c17be55c4e8d",
  "beneficiary_address_line1": null,
  "beneficiary_address_line2": null,
  "beneficiary_address_line3": null,
  "beneficiary_name": null,
  "beneficiary_reference": null,
  "sender_reference": null,
  "originator_address_line1": null,
  "originator_address_line2": null,
  "originator_address_line3": null,
  "originator_name": null,
  "originator_routing_number": null,
  "originator_to_beneficiary_information_line1": null,
  "originator_to_beneficiary_information_line2": null,
  "originator_to_beneficiary_information_line3": null,
  "originator_to_beneficiary_information_line4": null,
  "originator_to_beneficiary_information": null,
  "wire_drawdown_request_id": null,
  "acceptance": {
    "accepted_at": "2026-09-11T03:59:29Z",
    "transaction_id": "sandbox_transaction_bq30vs3sbq6pq08xtp5k"
  },
  "reversal": {
    "reason": "creditor_request",
    "reversed_at": "2026-09-11T04:04:04Z"
  }
} as unknown as IncreaseInboundWireTransfer;

/**
 * Verified webhook bodies, read out of `webhook_inbox.raw_body` on the deployed
 * system. Thirteen wire deliveries arrived on 2026-09-11 and every one had its
 * signature verified; these are two of them, byte for byte.
 *
 * Note what is NOT in them: the amount, the status, the IMAD, the account. The
 * body is a POINTER, so `observe()` must read the object back — which is also
 * what makes out-of-order delivery harmless on this rail.
 */
export const MEASURED_OUTBOUND_DELIVERY = "{\"type\":\"event\",\"associated_object_id\":\"sandbox_wire_transfer_897tmwn18z27tzkqbkhe\",\"associated_object_type\":\"wire_transfer\",\"category\":\"wire_transfer.updated\",\"created_at\":\"2026-09-11T03:58:51Z\",\"id\":\"sandbox_event_001m279wftf826zcjv4ggzqvwbe\"}";

export const MEASURED_INBOUND_DELIVERY = "{\"type\":\"event\",\"associated_object_id\":\"sandbox_inbound_wire_transfer_00lkxr57i04x31blx06x\",\"associated_object_type\":\"inbound_wire_transfer\",\"category\":\"inbound_wire_transfer.created\",\"created_at\":\"2026-09-11T03:59:30Z\",\"id\":\"sandbox_event_001m279xnvhmtzj5x07tbpmys5y\"}";
