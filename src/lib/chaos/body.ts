/**
 * The bodies chaos delivers: Lithic's `card_transaction.updated`, on the wire.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THESE ARE NOT INVENTED SHAPES
 *
 * Every field below is copied from a real delivery sitting in this
 * deployment's own `webhook_inbox` right now, and every AMOUNT follows the two
 * traps `src/lib/rails/lithic/README.md` measured against the live sandbox
 * rather than read out of the documentation:
 *
 *   Trap 1  `status` flips to SETTLED on the FIRST clearing, while a partial
 *           hold is still outstanding. So the clearing body below says
 *           `status: "SETTLED"` even though that is not a statement about the
 *           money, and `normalizeTransaction` is expected to ignore it.
 *   Trap 2  `amounts.hold.amount` and `amounts.settlement.amount` are signed
 *           NEGATIVE for a debit. A 5000-cent hold reads -5000.
 *
 * The README's measured table for exactly the pair this module mints:
 *
 *   | authorize 5000 then clearing 7340 | SETTLED | hold 0 | settlement -7340 |
 *
 * so an over-capture leaves `amounts.hold.amount` at 0 and the event-derived
 * hold `max(5000 − 7340, 0)` at 0 too. The two independent derivations agree,
 * which means these bodies do NOT trip `providerDisagrees` and the demo shows
 * the hold model working rather than a divergence the demo itself caused.
 *
 * GETTING THIS WRONG WOULD BE WORSE THAN NOT BUILDING IT. A chaos body whose
 * aggregates contradict its own events would light up the reconciliation
 * signal, and the dashboard would be showing a break chaos manufactured while
 * claiming to show the ledger surviving. So the shapes are measured, and
 * `body.test.ts` asserts the arithmetic against the README's table.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WHAT CHAOS DOES NOT DO HERE. It does not alter a body to suit a control.
 * The authorisation body is what Lithic would send at authorisation time — one
 * event — and the clearing body is what Lithic would send at clearing time —
 * both events, because Lithic sends the whole transaction every time. The four
 * controls change WHEN a body leaves, HOW MANY copies leave and IN WHAT ORDER.
 * None of them changes a byte of what is inside. That is the difference
 * between perturbing delivery and forging facts, and it is the whole line this
 * feature is not allowed to cross.
 */

import { randomUUID } from 'node:crypto';

import {
  CHAOS_MARKER,
  type ChaosMarker,
  type ChaosStep,
} from './types';

/** Merchant descriptor Lithic truncates at 25 characters. */
const DESCRIPTOR_MAX = 25;

export interface ChaosBodyOptions {
  /** The run this body belongs to. Goes in the marker. */
  readonly runId: string;
  /** Shared by both bodies: one transaction, two lifecycle steps. */
  readonly transactionToken: string;
  /** The card the episode targets. May deliberately be unregistered. */
  readonly cardToken: string;
  readonly authCents: bigint;
  readonly clearingCents: bigint;
  /** The provider's own stamp. Chaos delays DELIVERY, never the value date. */
  readonly created: Date;
  /** Which control shaped this delivery, for the marker. '' when none did. */
  readonly shapedBy: string;
  /** Stable event tokens, so a re-mint of the same run is byte-identical. */
  readonly authEventToken: string;
  readonly clearingEventToken: string;
  readonly descriptor: string;
}

/**
 * The in-band marker.
 *
 * Inside the signed bytes, so it cannot be stripped from a delivery that still
 * verifies. `v_chaos_inbox` reads `payload -> 'corgi_chaos'` and every screen
 * that shows a chaos row shows this.
 */
function marker(runId: string, shapedBy: string): ChaosMarker {
  return {
    origin: 'corgi-chaos-mode',
    run_id: runId,
    control: shapedBy,
    note:
      'Originated by Corgi chaos mode, not by Lithic. Signed with CHAOS_WEBHOOK_SECRET, ' +
      'which the deployed /api/webhooks/lithic route does not accept.',
  };
}

function merchant(descriptor: string): Record<string, unknown> {
  return {
    acceptor_id: '174030075991',
    acquiring_institution_id: '',
    city: 'NEW YORK',
    country: 'USA',
    descriptor: descriptor.slice(0, DESCRIPTOR_MAX),
    // 5542 is automated fuel dispenser — the brief's own example, and the
    // reason an over-capture is the normal case rather than an anomaly.
    mcc: '5542',
    phone_number: null,
    postal_code: null,
    state: 'NY',
    street_address: null,
  };
}

function iso(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

/**
 * The AUTHORIZATION event.
 *
 * `amounts.settlement` is `null`, exactly as the sandbox sends it, so
 * `eventMagnitude()` falls through to the flat `amount` — which is the
 * precedence `src/lib/holds/lithic-events.ts` implements and the one the
 * measured bodies exercise.
 */
function authorizationEvent(opts: ChaosBodyOptions): Record<string, unknown> {
  const cents = Number(opts.authCents);
  return {
    account_type: null,
    amount: cents,
    amounts: {
      cardholder: { amount: cents, conversion_rate: '1.000000', currency: 'USD' },
      hold: { amount: cents, currency: 'USD' },
      merchant: { amount: cents, currency: 'USD' },
      settlement: null,
    },
    created: iso(opts.created),
    detailed_results: ['APPROVED'],
    effective_polarity: 'DEBIT',
    network_info: null,
    network_specific_data: null,
    // APPROVED, and it matters. Migration 0026 exists because an authorisation
    // the network REFUSED and one it approved used to be the same row, and
    // every refusal raised the hold anyway. A chaos episode must authorise for
    // real or it is demonstrating the bug rather than the fix.
    result: 'APPROVED',
    rule_results: [],
    token: opts.authEventToken,
    type: 'AUTHORIZATION',
  };
}

/** The CLEARING event. Settlement figure signed negative, per trap 2. */
function clearingEvent(opts: ChaosBodyOptions): Record<string, unknown> {
  const cents = Number(opts.clearingCents);
  return {
    account_type: null,
    amount: cents,
    amounts: {
      cardholder: { amount: cents, conversion_rate: '1.000000', currency: 'USD' },
      hold: { amount: 0, currency: 'USD' },
      merchant: { amount: cents, currency: 'USD' },
      settlement: { amount: -cents, currency: 'USD' },
    },
    created: iso(opts.created),
    detailed_results: ['APPROVED'],
    effective_polarity: 'DEBIT',
    network_info: null,
    network_specific_data: null,
    result: 'APPROVED',
    rule_results: [],
    token: opts.clearingEventToken,
    type: 'CLEARING',
  };
}

/**
 * The body for one lifecycle step.
 *
 * The clearing body carries BOTH events, because that is what Lithic sends:
 * one webhook type per transaction, the whole `events[]` array every time, the
 * step inside it. `docs/RAIL-SEMANTICS.md` §2 is the reason the semantics table
 * is keyed `<event type>/<nested step>` at all.
 *
 * THAT IS ALSO WHY THE REORDER CONTROL IS AN HONEST TEST. Delivering the
 * clearing first hands the system a body asserting an authorisation it has
 * never heard of AND the clearing that closes it, in one delivery, out of
 * order. The claim is that the ledger ends in the same place either way — the
 * brief's gauntlet item 4 — and it is a claim about the consumer, not about
 * chaos being careful.
 */
export function chaosBody(step: ChaosStep, opts: ChaosBodyOptions): Record<string, unknown> {
  const authCents = Number(opts.authCents);
  const clearingCents = Number(opts.clearingCents);
  const settled = step === 'clearing';

  const events = settled
    ? [authorizationEvent(opts), clearingEvent(opts)]
    : [authorizationEvent(opts)];

  return {
    // The marker goes FIRST so it is visible in any truncated log line, and it
    // is a top-level key so `payload -> 'corgi_chaos'` finds it without a path
    // into the provider's own shape.
    [CHAOS_MARKER]: marker(opts.runId, opts.shapedBy),

    account_token: null,
    acquirer_fee: 0,
    acquirer_reference_number: null,
    amount: settled ? clearingCents : authCents,
    amounts: {
      cardholder: { amount: 0, conversion_rate: '1.000000', currency: 'USD' },
      // Trap 2: signed negative, and trap 1's measured row says an
      // over-capture leaves this at 0 rather than going negative.
      hold: {
        amount: settled ? 0 : -authCents,
        currency: 'USD',
      },
      merchant: { amount: 0, currency: 'USD' },
      settlement: { amount: settled ? -clearingCents : 0, currency: 'USD' },
    },
    authorization_amount: authCents,
    authorization_code: null,
    avs: null,
    card_token: opts.cardToken,
    cardholder_authentication: null,
    created: iso(opts.created),
    event_type: 'card_transaction.updated',
    events,
    family: 'CARD',
    financial_account_token: null,
    merchant: merchant(opts.descriptor),
    merchant_amount: settled ? clearingCents : authCents,
    merchant_authorization_amount: authCents,
    merchant_currency: 'USD',
    network: 'VISA',
    network_risk_score: null,
    pos: {
      entry_mode: {
        card: 'UNKNOWN',
        cardholder: 'UNKNOWN',
        pan: 'MANUAL',
        pin_entered: false,
      },
      terminal: {
        acceptor_terminal_id: null,
        attended: false,
        card_retention_capable: false,
        on_premise: true,
        operator: 'UNKNOWN',
        partial_approval_capable: false,
        pin_capability: 'UNSPECIFIED',
        type: 'PHONE',
      },
    },
    result: 'APPROVED',
    service_location: null,
    settled_amount: settled ? -clearingCents : 0,
    // Trap 1, stated in the body rather than in a comment: this says SETTLED
    // the moment a clearing arrives and it is NOT a description of the money.
    status: settled ? 'SETTLED' : 'PENDING',
    tags: {},
    token: opts.transactionToken,
    token_info: null,
    updated: iso(opts.created),
  };
}

/** Fresh identifiers for one episode. Separated so tests can pin them. */
export function newEpisodeIdentifiers(): {
  transactionToken: string;
  cardToken: string;
  authEventToken: string;
  clearingEventToken: string;
} {
  return {
    transactionToken: randomUUID(),
    cardToken: randomUUID(),
    authEventToken: randomUUID(),
    clearingEventToken: randomUUID(),
  };
}
