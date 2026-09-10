/**
 * Lithic's vocabulary → ours, as a pure function of one webhook payload.
 *
 * Lithic has no "clearing object". One `Transaction` accumulates an `events[]`
 * array, `card_transaction.updated` fires on every step, and the payload
 * carries the WHOLE array every time — authorisation, advice, clearing, void,
 * expiry. So the natural unit of ingestion is not "the newest event" but "every
 * event in this payload", each keyed by its own immutable Lithic event token.
 *
 * That choice is what makes out-of-order delivery a non-problem in practice as
 * well as in theory. Two deliveries of the same transaction at different points
 * in its life produce overlapping sets; the overlap is dropped by
 * `UNIQUE (auth_id, provider_event_id)` and the remainder is added. Whichever
 * delivery arrives first, the set converges on the same members, and `H(E)` is
 * a function of the set (see `./model.ts`).
 *
 * ─── The three fields this module refuses to read ────────────────────────────
 *
 *   txn.status                 flips to SETTLED while a partial hold is still
 *                              outstanding. [MEASURED, DECISIONS 006]
 *   txn.amounts.hold.amount    signed NEGATIVE, and it is the *remaining* hold.
 *   txn.settled_amount et al.  deprecated aggregates that restate the above.
 *
 * `normalizeTransaction()` from the rail adapter is used here for exactly one
 * purpose: as an INDEPENDENT SECOND OPINION. It computes the hold from the same
 * events by a different route (advice-wins-absolutely rather than
 * advice-as-delta) and exposes what the provider itself claims. When its answer
 * and ours disagree, that disagreement is surfaced as a reconciliation signal
 * rather than silently resolved in either direction.
 *
 * ─── Advice ─────────────────────────────────────────────────────────────────
 *
 * An `AUTHORIZATION_ADVICE` OVERRIDES the authorised amount — 1000 → 1500 is
 * `amount: 1500`, not `amount: 500`. Our stored model sums, because
 * `v_card_auth_state` sums and the memo book must agree with it or
 * `v_hold_drift` reports. So an advice is converted to the delta that produces
 * its absolute figure, using the events that precede it IN THIS SAME PAYLOAD.
 *
 * That conversion is still a function of the payload alone, not of arrival
 * order, because `events[]` is append-only: an event that precedes the advice
 * can never appear in a later delivery than the advice does, so the running
 * total at the advice is the same in every payload that contains it. The
 * derived delta is therefore stable, and its `providerEventId` is the advice's
 * own Lithic token, so a redelivery deduplicates rather than double-counting.
 */

import { normalizeTransaction } from "@/lib/rails/lithic/client";
import type {
  Transaction,
  TransactionEvent,
  TransactionEventType,
  TransactionStatus,
} from "@/lib/rails/lithic/types";

import { bookDate } from "@/lib/mcp/time";

import type { CardEvent, CardEventKind } from "./model";

/** How we first heard of an authorisation. Reporting only; nothing branches. */
export type AuthOrigin = "authorization" | "clearing_first" | "force_post";

export interface DerivedCardEvents {
  /** Lithic's transaction token — the provider's stable authorisation id. */
  readonly providerAuthId: string;
  /** Lithic's card token. Resolved to a customer through the `card` table. */
  readonly providerCardToken: string;
  /** Canonical events, in payload order, deduplicated on `providerEventId`. */
  readonly events: readonly CardEvent[];
  /** What the first event we can see says about how this auth began. */
  readonly origin: AuthOrigin;
  /** `txn.created` in book time. The authorisation's own value date. */
  readonly valueDate: string;
  /** `txn.created` as an instant, for deriving the expiry. */
  readonly createdAt: Date;
  /**
   * What `normalizeTransaction()` makes of the same transaction. Carried for
   * comparison and for the reconciliation screen; NEVER used to decide a hold.
   */
  readonly providerView: {
    readonly status: TransactionStatus;
    readonly providerSaysSettled: boolean;
    readonly holdCents: bigint;
    readonly settledCents: bigint;
    readonly eventDerivedHoldCents: bigint;
    readonly holdMatchesEvents: boolean;
  };
}

/**
 * Magnitude of one Lithic event, in cents, as a bigint.
 *
 * Same precedence the rail adapter uses: the settlement figure when the event
 * has one, the (deprecated but universally populated) flat `amount` otherwise.
 * Absolute value, because direction lives in the canonical kind — Lithic's own
 * signs are inconsistent between the transaction and its events.
 */
function eventMagnitude(event: TransactionEvent): bigint {
  const settlement = event.amounts?.settlement?.amount;
  const raw =
    typeof settlement === "number" && Number.isFinite(settlement) ? settlement : event.amount;
  if (!Number.isFinite(raw)) return 0n;
  if (!Number.isSafeInteger(raw)) {
    throw new TypeError(
      `lithic event ${event.token} amount ${raw} is not a safe integer number of cents`,
    );
  }
  return BigInt(Math.abs(raw));
}

/**
 * The canonical kind for a Lithic event type, or `null` for the ones that carry
 * no money and no hold.
 *
 * `null` is not "unknown" — it is "recognised and irrelevant". A BALANCE_INQUIRY
 * is a real event we deliberately do not record, because storing a zero-amount
 * row in `card_auth_event` would put a member in `E` that changes `count(*)`
 * (which the `A <= 0` closure test guards on) without changing any sum.
 */
function canonicalKind(
  type: TransactionEventType,
  polarity: "CREDIT" | "DEBIT" | undefined,
): CardEventKind | null {
  switch (type) {
    case "AUTHORIZATION":
      return "authorization";

    case "AUTHORIZATION_ADVICE":
    case "CREDIT_AUTHORIZATION_ADVICE":
      // Handled by the caller: absolute, so it becomes an incremental or a
      // reversal depending on what it overrides.
      return null;

    case "AUTHORIZATION_REVERSAL":
      return "authorization_reversal";

    case "AUTHORIZATION_EXPIRY":
      return "expiry";

    case "CLEARING":
      // A clearing against a credit authorisation moves money TOWARDS the
      // customer. Reading the polarity is not optional: a refund booked as a
      // capture debits a customer who is owed money.
      return polarity === "CREDIT" ? "refund" : "clearing";

    case "FINANCIAL_AUTHORIZATION":
      // Single-message: settles immediately, never places a hold.
      // [MEASURED] 2500 -> status SETTLED, hold 0, settled -2500.
      // This is the closest thing Lithic's sandbox has to a force post, and it
      // takes exactly the no-hold-to-release path an unmatched clearing takes
      // (DECISIONS 004 / 006).
      return "force_post";

    case "FINANCIAL_CREDIT_AUTHORIZATION":
    case "RETURN":
    case "CORRECTION_CREDIT":
      // Money to the customer. Financial book only; contributes to neither
      // A(E) nor C(E), exactly as `v_card_auth_state` has it.
      return "refund";

    case "RETURN_REVERSAL":
    case "CORRECTION_DEBIT":
      // The refund taken back. These arrive on their own transaction with no
      // authorisation of their own, so A = 0 and H stays 0 while the money
      // still posts — the unmatched-clearing path.
      return "force_post";

    case "CREDIT_AUTHORIZATION":
      // A pending credit. It places a hold in LITHIC's model, but a hold on an
      // incoming credit would reduce the customer's available balance for money
      // arriving, which is backwards. It is recognised and skipped; the money
      // posts when its FINANCIAL_CREDIT_AUTHORIZATION or CREDIT clearing lands.
      return null;

    case "BALANCE_INQUIRY":
      return null;

    default:
      return null;
  }
}

/**
 * `is_final`: the network says no further capture is coming.
 *
 * Set for single-message events, which settle in one shot by construction, and
 * for an expiry. NOT set for a clearing: Lithic offers no "last capture" flag,
 * and the measured behaviour is that a partial clearing looks identical to a
 * final one. `max(A − C, 0)` handles both without needing to know which it was,
 * which is precisely why the model does not depend on this field.
 */
function isFinal(type: TransactionEventType): boolean {
  return (
    type === "FINANCIAL_AUTHORIZATION" ||
    type === "FINANCIAL_CREDIT_AUTHORIZATION" ||
    type === "AUTHORIZATION_EXPIRY"
  );
}

const RAISES = new Set<CardEventKind>(["authorization", "incremental_authorization"]);

/**
 * Turn one `card_transaction.updated` payload into the canonical events it
 * asserts. Pure: no clock, no I/O, no database.
 */
export function deriveCardEvents(txn: Transaction): DerivedCardEvents {
  // The rail adapter's own reading of the same transaction. Computed here so
  // the two answers travel together and can be compared; see the module header.
  const normalized = normalizeTransaction(txn);
  const createdAt = new Date(txn.created);
  const txnValueDate = bookDate(createdAt);
  const raw = txn.events ?? [];

  // Payload order, with `created` as the tie-break. Lithic delivers the array
  // in chronological order already; sorting makes the advice conversion below
  // independent of that promise rather than dependent on it. The sort is
  // stable, so events sharing a timestamp keep their delivered order.
  const ordered = [...raw].sort((a, b) => {
    const ta = Date.parse(a.created ?? txn.created);
    const tb = Date.parse(b.created ?? txn.created);
    if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return 0;
    return ta - tb;
  });

  const events: CardEvent[] = [];
  const seen = new Set<string>();
  let runningAuthorised = 0n;
  let origin: AuthOrigin | null = null;

  const push = (event: CardEvent): void => {
    if (seen.has(event.providerEventId)) return;
    seen.add(event.providerEventId);
    events.push(event);
    if (RAISES.has(event.kind)) runningAuthorised += event.amountCents;
    else if (event.kind === "authorization_reversal") runningAuthorised -= event.amountCents;
    if (origin === null) {
      origin =
        event.kind === "authorization"
          ? "authorization"
          : event.kind === "force_post"
            ? "force_post"
            : "clearing_first";
    }
  };

  for (const lithicEvent of ordered) {
    const token = lithicEvent.token;
    if (typeof token !== "string" || token.length === 0) {
      // No stable id means no dedupe key, and a fact we cannot deduplicate is a
      // fact we must not store: replaying the payload would double-count it.
      throw new Error(
        `lithic transaction ${txn.token} has an event with no token; it cannot be deduplicated`,
      );
    }

    const amountCents = eventMagnitude(lithicEvent);
    const valueDate = bookDate(new Date(lithicEvent.created ?? txn.created));

    if (
      lithicEvent.type === "AUTHORIZATION_ADVICE" ||
      lithicEvent.type === "CREDIT_AUTHORIZATION_ADVICE"
    ) {
      // Absolute → delta. See the module header for why this is still a pure
      // function of the payload and therefore still order-free.
      const delta = amountCents - runningAuthorised;
      if (delta === 0n) continue;
      push({
        kind: delta > 0n ? "incremental_authorization" : "authorization_reversal",
        amountCents: delta > 0n ? delta : -delta,
        isFinal: false,
        valueDate,
        providerEventId: token,
      });
      continue;
    }

    const kind = canonicalKind(lithicEvent.type, lithicEvent.effective_polarity);
    if (kind === null) continue;

    push({
      kind,
      amountCents,
      isFinal: isFinal(lithicEvent.type),
      valueDate,
      providerEventId: token,
    });
  }

  return {
    providerAuthId: txn.token,
    providerCardToken: txn.card_token,
    events,
    // An identity with no usable events yet is still an identity; calling its
    // origin 'clearing_first' would be a guess, and 'authorization' would be a
    // lie, so an empty payload inherits the neutral case.
    origin: origin ?? "clearing_first",
    valueDate: txnValueDate,
    createdAt,
    providerView: {
      status: normalized.providerStatus,
      providerSaysSettled: normalized.providerSaysSettled,
      holdCents: BigInt(normalized.holdCents),
      settledCents: BigInt(normalized.settledCents),
      eventDerivedHoldCents: BigInt(normalized.eventDerivedHoldCents),
      holdMatchesEvents: normalized.holdMatchesEvents,
    },
  };
}
