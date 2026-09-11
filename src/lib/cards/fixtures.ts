/**
 * ASA payload shapes, and the fixture control sets the console's non-live
 * states render.
 *
 * ─── Where the payload shape comes from ─────────────────────────────────────
 *
 * `asaPayload()` is built field by field from Lithic's own published OpenAPI
 * document — the one their Node SDK pins,
 * `lithic-38a020a15ab14f79c7fea3290822406cf80a9d43d46ab3295632a9723f5e42cd.yml`,
 * schemas `authorization`, `asa_request_card`, `transaction_merchant`,
 * `converted_amount` and `asa_request_status`. Every required field of every
 * one of those schemas is present, with the provider's own examples where they
 * gave one (`acceptor_id: '333301802529120'`, `mcc: '5812'`, `city: 'NEW
 * YORK'`).
 *
 * THIS IS A SHAPE, NOT A CAPTURE, and the difference is the whole reason this
 * comment exists. A fixture built from a schema proves that the parser handles
 * the documented contract; it does not prove that the provider sends what it
 * documents. Only a real delivery proves that, and the honesty column
 * `card_auth_decision.source` is what keeps the two apart in the record:
 * anything driven from here is `harness`, and only Lithic's own synchronous
 * call writes `provider`.
 *
 * ─── The fuel pump ──────────────────────────────────────────────────────────
 *
 * The default is the brief's own live-fire case: a $50 authorisation at an
 * automated fuel dispenser, MCC 5542. Note `amounts.hold.amount` is 10000
 * against a cardholder amount of 5000 — Lithic's schema says the hold "may
 * exceed the cardholder and merchant amounts to account for anticipated final
 * transaction amounts such as tips or fuel fill-ups", and a fixture that did
 * not carry that divergence would let `parseAsaRequest` read the wrong field
 * and nobody would notice. The parser is asserted against exactly this.
 */

import type { CardControls } from "./types";

/** Deep-ish merge for the nested objects a caller usually wants to poke. */
type Json = Record<string, unknown>;

export type AsaPayloadOverrides = {
  readonly token?: string;
  readonly status?: string;
  readonly cardToken?: string;
  readonly amountCents?: number;
  readonly holdCents?: number;
  readonly mcc?: string;
  readonly descriptor?: string;
  readonly cardState?: string;
  readonly lastFour?: string;
};

/**
 * One ASA request body, in the provider's own shape.
 *
 * `amountCents` is a `number` here and ONLY here, because that is what JSON
 * carries and this function's job is to produce JSON. It becomes `bigint` the
 * moment `parseAsaRequest` reads it, and never becomes a number again.
 */
export function asaPayload(overrides: AsaPayloadOverrides = {}): Json {
  const amount = overrides.amountCents ?? 5_000;
  const hold = overrides.holdCents ?? 10_000;

  return {
    token: overrides.token ?? "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    status: overrides.status ?? "AUTHORIZATION",
    created: "2026-09-10T23:41:02Z",
    network: "MASTERCARD",
    transaction_initiator: "CARDHOLDER",

    // Deprecated aggregates. Present because Lithic still sends them, and a
    // parser that only reads `amounts` would be untested against the fallback
    // it is supposed to have.
    amount,
    authorization_amount: amount,
    merchant_amount: amount,
    merchant_currency: "USD",
    cardholder_currency: "USD",
    settled_amount: 0,
    acquirer_fee: 0,
    cash_amount: 0,
    cashback: 0,

    amounts: {
      cardholder: { amount, conversion_rate: "1.000000", currency: "USD" },
      merchant: { amount, currency: "USD" },
      settlement: null,
      // Deliberately larger than the cardholder amount. See the header.
      hold: { amount: hold, currency: "USD" },
    },

    card: {
      token: overrides.cardToken ?? "c6d49cfe-2758-4b4b-85de-2eaba92d6713",
      last_four: overrides.lastFour ?? "2081",
      memo: "corgi console · Ridgeline Robotics, Inc.",
      spend_limit: 500_000,
      spend_limit_duration: "TRANSACTION",
      state: overrides.cardState ?? "OPEN",
      type: "VIRTUAL",
    },

    merchant: {
      acceptor_id: "333301802529120",
      acquiring_institution_id: "191231",
      city: "AUSTIN",
      country: "USA",
      descriptor: overrides.descriptor ?? "CORGI FUEL PUMP 14",
      mcc: overrides.mcc ?? "5542",
      state: "TX",
      postal_code: "78701",
      street_address: "1 CONGRESS AVE",
      phone_number: "5125550100",
    },

    pos: {
      entry_mode: {
        card: "MAGNETIC_STRIPE",
        cardholder: "ON_FILE",
        pan: "MANUAL",
        pin_entered: false,
      },
      terminal: {
        attended: false,
        card_retention_capable: false,
        on_premise: true,
        operator: "CARDHOLDER",
        partial_approval_capable: true,
        pin_capability: "UNSPECIFIED",
        type: "AUTOFUEL_DISPENSER",
        acceptor_terminal_id: "AFD-000014",
      },
    },

    avs: {
      address: "1 CONGRESS AVE",
      zipcode: "78701",
      address_on_file_match: "MATCH",
    },

    cardholder_authentication: null,
    fleet_info: null,
    network_risk_score: null,
    network_specific_data: null,
    account_type: null,
    token_info: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Console fixtures                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Control sets behind the panel's non-live URL states.
 *
 * These write nothing and read nothing. That is the same rule the rest of this
 * console follows: a frozen card and a failed control read are not conditions
 * you create on a live book to show someone.
 */
export const FIXTURE_CONTROLS: CardControls = {
  cardId: "00000000-0000-4000-8000-00000000c0de",
  controlVersionId: "00000000-0000-4000-8000-00000000ffff",
  version: 3,
  effectiveFrom: "2026-09-10T18:00:00.000Z",
  cardState: "active",
  perTxnLimitCents: 1_000n,
  dailyLimitCents: 5_000n,
  monthlyLimitCents: 50_000n,
  blockedMccs: ["5542", "7995"],
  note: "Fuel and gambling blocked; $10 per transaction while the card is on trial.",
};
