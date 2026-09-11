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
 * ─── The one field it MUST read, and did not ─────────────────────────────────
 *
 *   event.result               APPROVED, or the refusal the network answered
 *                              with. Migration 0026.
 *
 * Until 0026 this file contained ZERO occurrences of `result`, `APPROVED` or
 * `DECLINED`, and `card_auth_event` had no column to put the answer in. An
 * authorisation the network REFUSED was therefore ingested as an
 * `authorization` — indistinguishable, row for row, from one it approved — and
 * raised `A(E)` by its full amount. The customer's money was then withheld for
 * a purchase that never happened, until the seven-day expiry sweeper reached
 * it. Measured: 60 authorisations, $2,951.00 of authorised amount that never
 * existed, $1,151.00 of it still withheld across three businesses at the time
 * of the fix, on transactions like
 * `041d610c-a71a-432e-ad62-ca16b6d882b0` —
 * `AUTHORIZATION 5000 result DECLINED ["ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED"]`.
 *
 * Neither `v_hold_drift` nor `v_hold_release_drift` could see it, and both were
 * right to be empty: they compare the memo book against the fold over
 * `card_auth_event`, and the fold's input had already lost the verdict at the
 * front door. Two derivations of the same impoverished input agree perfectly.
 * `v_refused_auth_hold` (0026) is the invariant that reaches outside the
 * derivation, to the raw payload the provider actually sent.
 *
 * THE RULE, and it is deliberately uniform: `result` present and not
 * `APPROVED` means the network did not do this, so the step contributes to
 * NOTHING — not A, not C, not closure, not the financial book. It is still
 * recorded, at its real amount and its real value date, under the kind
 * `declined`. `CLEARING` and the credit steps are held to the same rule as
 * `AUTHORIZATION`, even though every non-APPROVED result observed in this
 * sandbox has been on an authorisation: the alternative is posting money for a
 * capture the network refused, and of the two possible mistakes that is much
 * the worse one.
 *
 * `normalizeTransaction()` from the rail adapter is used here for exactly one
 * purpose: as an INDEPENDENT SECOND OPINION. It computes the hold from the same
 * events by a different route (advice-wins-absolutely rather than
 * advice-as-delta) and exposes what the provider itself claims. When its answer
 * and ours disagree, that disagreement is surfaced as a reconciliation signal
 * rather than silently resolved in either direction.
 *
 * ─── Advice, and the base it is converted against ───────────────────────────
 *
 * An `AUTHORIZATION_ADVICE` OVERRIDES the authorised amount — 1000 → 1500 is
 * `amount: 1500`, not `amount: 500`. Our stored model sums, because
 * `v_card_auth_state` sums and the memo book must agree with it or
 * `v_hold_drift` reports. So an advice is converted to the delta that produces
 * its absolute figure, using the events that precede it IN THIS SAME PAYLOAD.
 *
 * THE BASE IS CLAMPED AT ZERO, AND THAT IS THE WHOLE OF MIGRATION 0043.
 * [MEASURED] Lithic transaction `5892c550-b966-4afb-b681-a6456e1cf3c4`,
 * delivered 2026-09-11T09:02:58Z as one payload of six events:
 *
 *     AUTHORIZATION          5000  APPROVED      A =   5000
 *     CLEARING               7340  APPROVED      C =   7340
 *     AUTHORIZATION_REVERSAL 7340  APPROVED      A =  -2340
 *     AUTHORIZATION_REVERSAL 5000  APPROVED      A =  -7340   <- over-reversed
 *     AUTHORIZATION_ADVICE      0  APPROVED      delta = 0 - (-7340) = +7340
 *     CLEARING               7340  APPROVED
 *
 * The network reversed $123.40 against a $50 authorisation, and the advice that
 * followed said "the authorised amount is now ZERO". Converted against the
 * negative running total, that advice of NOTHING became a stored
 * `incremental_authorization` of **7340** — a $73.40 increment the network
 * never sent, written into an append-only table. No money moved, because
 * `closed(E)` already held on `A <= 0` and `H = max(A − C, 0)` clamps twice
 * over, but the EVENT LOG acquired a fact that did not happen, which is the
 * sin migration 0028 and DECISIONS 051 are both about.
 *
 * An advice overrides an AUTHORISED AMOUNT, and an authorised amount is not a
 * quantity that can be negative: you cannot have authorised less than nothing.
 * So the base is `max(A, 0)`. Where `A >= 0` — every advice this book has ever
 * seen except the one above — nothing changes at all. Where `A < 0` the
 * over-reversal is KEPT on the books instead of being cancelled out by a
 * fabricated increment, and the derived delta can only ever be SMALLER than it
 * was before, so the change can never withhold more of a customer's money.
 *
 * ─── Order-freedom: the claim that was true per payload and false across them ─
 *
 * This header used to say the conversion was "still a function of the payload
 * alone, not of arrival order". Per payload that is true and it is worth
 * keeping: within one `events[]` array the base is fixed, so two processors
 * handed the same payload derive the same delta.
 *
 * ACROSS payloads it is NOT true, and saying so was the more useful half of the
 * sentence to get right. The stored delta is fixed by the FIRST payload that
 * carries the advice, because `insertCardEvents()` is
 * `ON CONFLICT (auth_id, provider_event_id) DO NOTHING`: a later delivery that
 * derives a different delta under the same Lithic token is silently discarded.
 * The delta is therefore stable only under a promise Lithic makes and we do not
 * verify — that `events[]` is append-only, so every snapshot containing the
 * advice contains exactly the same events before it. Two ways that promise can
 * fail to hold for US even if it holds for Lithic: our own `created` sort keeps
 * delivered order for ties, and a redrive or a hand-built payload (livefire,
 * fixtures) may carry a subset.
 *
 * The clamp does not make it true either, and pretending otherwise would be the
 * same mistake in a new paragraph. What holds after 0043 is narrower and
 * checkable: the base is non-negative in EVERY payload, so no snapshot can turn
 * an advice of nothing into an increment of something.
 *
 * `v_advice_delta_unsound` (migration 0043) is the invariant. It recovers the
 * base that was actually used — `absolute_amount − signed_delta`, where the
 * absolute comes from the payload retained verbatim in `webhook_inbox` and the
 * signed delta comes from the row we stored — and reports any advice whose base
 * was negative, OR whose payload can no longer be found to check it against.
 * Two inputs, neither computed from the other, which is the rule docs/HOLDS.md
 * §9.8 says a guard has to satisfy to be worth its tick.
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

/** The only `result` Lithic uses for "the network did this". */
export const APPROVED_RESULT = "APPROVED";

/**
 * `card_event_kind`'s member for a step the network refused. Added by
 * migration 0026.
 *
 * WHY THE CAST. `CardEventKind` in `./model.ts` has deliberately NOT been
 * widened to include it, and that is the whole design rather than an oversight
 * to tidy up later. `H(E)` has two implementations that must agree exactly or
 * `v_hold_drift` reports — `holdState()` and `v_card_auth_state` — and both
 * select the kinds that feed a term by MEMBERSHIP of a fixed list:
 *
 *   TypeScript   RAISES_AUTH / LOWERS_AUTH / CAPTURES / CLOSES, four Sets
 *   SQL          SUM(...) FILTER (WHERE ev.kind IN ('authorization', ...))
 *
 * A kind in none of those lists feeds nothing — in both implementations, by
 * construction, with no edit to either and therefore no way for the two to
 * drift apart. Widening the union would mean touching `model.ts` and the
 * views together, which is exactly the class of change `docs/HOLDS.md` warns
 * is "one migration that moves both, or it is not made".
 *
 * So the seam is this one cast, it is named, and `lithic-events.test.ts` pins
 * the behaviour that matters — `holdState` folds a `declined` event to nothing
 * — against the value rather than against the type.
 */
const DECLINED_KIND = "declined" as unknown as CardEventKind;

/**
 * Did the network refuse this step?
 *
 * `undefined` is NOT a refusal: Lithic's `result` is optional on
 * `TransactionEvent`, and an absent verdict means we were not told, which is a
 * different thing from being told no. Treating silence as a refusal would
 * silently stop placing holds the moment the provider changed a payload shape.
 */
export function isRefused(result: string | null | undefined): boolean {
  return typeof result === "string" && result !== "" && result !== APPROVED_RESULT;
}

export interface DerivedCardEvents {
  /** Lithic's transaction token — the provider's stable authorisation id. */
  readonly providerAuthId: string;
  /** Lithic's card token. Resolved to a customer through the `card` table. */
  readonly providerCardToken: string;
  /** Canonical events, in payload order, deduplicated on `providerEventId`. */
  readonly events: readonly CardEvent[];
  /**
   * `providerEventId` → the Lithic step type it came from.
   *
   * The canonical kind is deliberately lossy: `RETURN_REVERSAL` and
   * `CORRECTION_DEBIT` both become `force_post`, because `card_event_kind` has
   * no member for either and the hold arithmetic treats them identically. But
   * `rail_event_semantics` is keyed on the STEP, not on our kind, so the step
   * has to survive the translation or the table cannot be consulted about the
   * one thing it exists to decide. It is carried beside the events rather than
   * on them so `CardEvent` — which `model.ts` reasons about and the database
   * stores — keeps exactly the fields the arithmetic needs.
   */
  readonly stepTypes: ReadonlyMap<string, string>;
  /**
   * `providerEventId` → the network's verdict on that step, VERBATIM.
   *
   * Absent from the map when the payload carried no `result` for the step —
   * which is a different claim from `APPROVED`, and is stored as NULL rather
   * than guessed. `card_auth_event_result` (0026) is where this lands, and it
   * is what `v_refused_auth_hold` reaches for when it asks whether money is
   * being withheld on an authorisation the network refused.
   */
  readonly results: ReadonlyMap<string, string>;
  /**
   * The provider event ids this payload says the network REFUSED.
   *
   * Carried for the caller's reporting and for tests. The money consequence is
   * already baked in — these are the events pushed as `declined` — so nothing
   * downstream has to remember to check it.
   */
  readonly refused: readonly string[];
  /**
   * How far the network's own reversals ran PAST its own authorisations in
   * this payload, in cents. Zero for every ordinary transaction.
   *
   * This is the honest, loud form of "A(E) went negative", and the reason it
   * lives here rather than in `model.ts` is that only here can it be said
   * without being wrong. `A(E) < 0` is a perfectly legitimate state of the
   * FOLD: a reversal that arrives before its authorisation puts `A` below zero
   * and the next delivery puts it back, and that is the out-of-order case the
   * brief tells you to survive rather than a defect to alarm on. `holdState()`
   * therefore asserts nothing about the sign, and `model.ts` says why.
   *
   * A Lithic PAYLOAD is different: `events[]` carries the whole transaction, so
   * a snapshot whose reversals exceed its authorisations is not an artefact of
   * arrival order — there is no later delivery that explains it. That is a
   * surprising provider fact, this build's posture is that a surprising
   * provider fact should be VISIBLE, and `applyCardTransaction()` logs it.
   * Nothing branches on it and no money depends on it.
   */
  readonly overReversedCents: bigint;
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
  const stepTypes = new Map<string, string>();
  const results = new Map<string, string>();
  const refused: string[] = [];
  const seen = new Set<string>();
  let runningAuthorised = 0n;
  let origin: AuthOrigin | null = null;

  const push = (
    event: CardEvent,
    stepType: TransactionEventType,
    result: string | undefined,
  ): void => {
    if (seen.has(event.providerEventId)) return;
    seen.add(event.providerEventId);
    events.push(event);
    stepTypes.set(event.providerEventId, stepType);
    if (result !== undefined && result !== "") results.set(event.providerEventId, result);
    // Inside `push`, behind the `seen` check, so a payload that repeats an
    // event token does not report the same refusal twice. Found by
    // `lithic-events.test.ts`, not reasoned about.
    if (event.kind === DECLINED_KIND) refused.push(event.providerEventId);
    if (RAISES.has(event.kind)) runningAuthorised += event.amountCents;
    else if (event.kind === "authorization_reversal") runningAuthorised -= event.amountCents;
    if (origin === null) {
      if (event.kind === DECLINED_KIND) {
        // A refusal carries no canonical kind to read the origin off, so read
        // the STEP instead: a transaction that opened with an AUTHORIZATION
        // the network turned down still OPENED WITH AN AUTHORISATION, and
        // `origin` answers "how did we first hear of this", which is a
        // question about the message and not about the money.
        // `card_authorization.origin` is CHECK-constrained to exactly these
        // three values (0001) and nothing anywhere branches on it.
        origin =
          stepType === "FINANCIAL_AUTHORIZATION" || stepType === "FINANCIAL_CREDIT_AUTHORIZATION"
            ? "force_post"
            : stepType === "CLEARING"
              ? "clearing_first"
              : "authorization";
      } else {
        origin =
          event.kind === "authorization"
            ? "authorization"
            : event.kind === "force_post"
              ? "force_post"
              : "clearing_first";
      }
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
    const result = lithicEvent.result;

    // ---- THE REFUSAL BRANCH, and it comes FIRST ------------------------
    //
    // Before the advice conversion, and before `canonicalKind`, because a
    // refused advice must not move `runningAuthorised` either: the delta an
    // advice implies is the delta the network would have applied HAD IT
    // AGREED, and converting a refusal into one would put the refused amount
    // back into A(E) through the side door.
    //
    // The step is recorded in full — real amount, real value date, real
    // provider event token, so a redelivery still deduplicates through
    // `UNIQUE (auth_id, provider_event_id)` — under a kind that feeds no term
    // of the model and moves no money. `isFinal` is FALSE: a refusal is not
    // the network saying "no further capture is coming", it is the network
    // saying "this one did not happen", and setting the flag would close the
    // hold on a transaction that may yet carry an approved clearing. Lithic
    // transaction 041d610c-a71a-432e-ad62-ca16b6d882b0 is exactly that shape:
    // AUTHORIZATION 5000 DECLINED, then CLEARING 7340 APPROVED.
    if (isRefused(result)) {
      push(
        {
          kind: DECLINED_KIND,
          amountCents,
          isFinal: false,
          valueDate,
          providerEventId: token,
        },
        lithicEvent.type,
        result,
      );
      continue;
    }

    if (
      lithicEvent.type === "AUTHORIZATION_ADVICE" ||
      lithicEvent.type === "CREDIT_AUTHORIZATION_ADVICE"
    ) {
      // Absolute → delta, against a base that CANNOT BE NEGATIVE.
      //
      // `runningAuthorised` is the sum of what the network has said so far in
      // this payload and it is allowed to go below zero — a Lithic transaction
      // really has over-reversed, measured, and that fact is kept rather than
      // flattened (see the header and `overReversedCents`). But an advice
      // overrides an AUTHORISED AMOUNT, and there is no such thing as having
      // authorised less than nothing, so the figure this delta is measured from
      // is the authorised position clamped at zero.
      //
      // Without the clamp, an advice of 0 against a base of -7340 became an
      // `incremental_authorization` of 7340 — a fact the network never sent.
      // With it, that advice produces `delta = 0` and no row at all.
      const base = runningAuthorised > 0n ? runningAuthorised : 0n;
      const delta = amountCents - base;
      if (delta === 0n) continue;
      push(
        {
          kind: delta > 0n ? "incremental_authorization" : "authorization_reversal",
          amountCents: delta > 0n ? delta : -delta,
          isFinal: false,
          valueDate,
          providerEventId: token,
        },
        lithicEvent.type,
        result,
      );
      continue;
    }

    const kind = canonicalKind(lithicEvent.type, lithicEvent.effective_polarity);
    if (kind === null) continue;

    push(
      {
        kind,
        amountCents,
        isFinal: isFinal(lithicEvent.type),
        valueDate,
        providerEventId: token,
      },
      lithicEvent.type,
      result,
    );
  }

  return {
    providerAuthId: txn.token,
    providerCardToken: txn.card_token,
    events,
    stepTypes,
    results,
    refused,
    // The final running total, not the deepest excursion: a payload that dips
    // below zero and is brought back by a later authorisation in the SAME
    // snapshot has not over-reversed, it has been read halfway through.
    overReversedCents: runningAuthorised < 0n ? -runningAuthorised : 0n,
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
