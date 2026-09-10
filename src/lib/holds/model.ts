/**
 * The card authorisation hold, as a pure function of an event SET.
 *
 *     A(E) = Σ amount over {authorization, incremental_authorization}
 *          − Σ amount over {authorization_reversal}
 *     C(E) = Σ amount over {clearing, force_post}
 *     closed(E) = (∃ e ∈ E : e.isFinal)
 *               ∨ (∃ e ∈ E : e.kind ∈ {close, expiry})
 *               ∨ (E ≠ ∅ ∧ A(E) ≤ 0)
 *               ∨ now ≥ expiresAt
 *     H(E) = 0                    if closed(E)
 *          = max(A(E) − C(E), 0)  otherwise
 *
 * Nothing in this file has an argument called "previous state", because there
 * is no previous state. `H` is built out of Σ, ∃, max and one clock
 * comparison over a set, and every one of those is invariant under
 * permutation. That is the entire out-of-order story: a settlement arriving
 * before its authorisation is not a case to handle, it is a set with the same
 * members assembled in a different order, and a function of a set cannot tell
 * the difference. Deduplication is likewise structural — `card_auth_event` has
 * `UNIQUE (auth_id, provider_event_id)`, so a redelivered webhook never enters
 * `E` at all and `H` cannot move.
 *
 * WHAT IS NOT HERE, deliberately: any reference to the provider's `status`.
 * Lithic flips `status` to SETTLED while a partial hold is still outstanding
 * (measured, DECISIONS 006: clearing 600 against auth 1000 reads
 * status=SETTLED, hold=-400). A release keyed off that field frees 400 cents
 * that are still authorised. `amounts.hold.amount` is also signed negative.
 * Both traps are avoided by not reading either field — the arithmetic below
 * reproduces Lithic's own numbers (400, 100, and 0 on over-capture) from the
 * events alone.
 *
 * This module must stay in exact agreement with `v_card_auth_hold` in
 * migration 0001, because `v_hold_drift` compares the memo book against that
 * view and must return zero rows. Same four closure conditions, same two sums,
 * same `max(·, 0)`. The SQL is authoritative; this is the readable copy that
 * the posting path uses, and `model.test.ts` asserts them equal against the
 * live database.
 *
 * Money is `bigint` cents throughout. No floats, no `number`, nowhere.
 */

/** Our vocabulary, not any provider's. Mirrors the `card_event_kind` enum. */
export type CardEventKind =
  | "authorization"
  | "incremental_authorization"
  | "authorization_reversal"
  | "clearing"
  | "force_post"
  | "refund"
  | "expiry"
  | "close";

/**
 * One fact the network told us. `amountCents` is a MAGNITUDE (>= 0); the
 * direction lives in `kind`, exactly as the `card_auth_event` table stores it.
 */
export interface CardEvent {
  readonly kind: CardEventKind;
  readonly amountCents: bigint;
  /** The network says no further capture is coming for this authorisation. */
  readonly isFinal: boolean;
  /** Card LOCAL TRANSACTION date in book time — not the settlement date. */
  readonly valueDate: string;
  /** Stable provider id. The set is deduplicated on this. */
  readonly providerEventId: string;
}

/** Everything `H` needs about the authorisation that is not in the event set. */
export interface AuthorizationClock {
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface HoldState {
  /** A(E). MAY BE NEGATIVE — a reversal can arrive before its authorisation. */
  readonly authorisedCents: bigint;
  /** C(E). May exceed A(E): fuel pumps and tips over-capture routinely. */
  readonly capturedCents: bigint;
  readonly sawFinal: boolean;
  readonly sawClose: boolean;
  /** At least one authorisation or incremental has been seen. See below. */
  readonly sawAuthorisation: boolean;
  readonly expired: boolean;
  /**
   * `closed(E)` exactly as `v_card_auth_hold.is_closed` computes it. This is
   * the term `H` uses, and it must not drift from the SQL by a single case or
   * `v_hold_drift` starts reporting.
   */
  readonly closed: boolean;
  /**
   * `closed(E)` AND the closure cannot be undone by a later event.
   *
   * The difference is one case and it is a real one, found by running the
   * out-of-order scenario against the database rather than by reading the
   * model. A settlement that arrives before its authorisation creates an
   * identity whose event set is `{clearing 3000}`: `A = 0`, which satisfies
   * `A <= 0`, which makes `closed` TRUE. That is harmless for `H` — it is 0
   * either way, because `max(0 − 3000, 0)` is also 0 — but `hold_closure` is
   * APPEND-ONLY with `PRIMARY KEY (hold_id)`, so writing a closure row on the
   * strength of it would permanently free a hold that the late authorisation
   * is about to open. Availability reads the closure row, so the customer
   * would spend 5000 they no longer have.
   *
   * `A <= 0` is only terminal once there is something to have reversed. A
   * clearing-first identity has `A = 0` because nothing has authorised
   * anything yet, not because everything was reversed — and telling those two
   * apart is exactly what `sawAuthorisation` is for.
   */
  readonly terminallyClosed: boolean;
  /** H(E), always >= 0. */
  readonly holdCents: bigint;
  readonly eventCount: number;
}

const RAISES_AUTH: ReadonlySet<CardEventKind> = new Set([
  "authorization",
  "incremental_authorization",
]);

const LOWERS_AUTH: ReadonlySet<CardEventKind> = new Set(["authorization_reversal"]);

const CAPTURES: ReadonlySet<CardEventKind> = new Set(["clearing", "force_post"]);

const CLOSES: ReadonlySet<CardEventKind> = new Set(["expiry", "close"]);

/** True for the kinds that move real money rather than only the memo book. */
export function movesFinancialBook(kind: CardEventKind): boolean {
  return kind === "clearing" || kind === "force_post" || kind === "refund";
}

/**
 * `H(E)` and the terms it is made of.
 *
 * `events` is treated as a set: duplicates by `providerEventId` are dropped
 * here as well as by the database, so calling this with a list that the caller
 * has not yet deduplicated gives the same answer as calling it with one that
 * has been. That redundancy is on purpose — the invariant is "H is a function
 * of the set", and it should hold at every layer that claims it, not only at
 * the layer that happens to have a unique index.
 */
export function holdState(
  events: Iterable<CardEvent>,
  clock: AuthorizationClock,
): HoldState {
  const seen = new Set<string>();
  let authorised = 0n;
  let captured = 0n;
  let sawFinal = false;
  let sawClose = false;
  let sawAuthorisation = false;
  let count = 0;

  for (const event of events) {
    if (seen.has(event.providerEventId)) continue;
    seen.add(event.providerEventId);
    count += 1;

    if (event.amountCents < 0n) {
      // The column is `CHECK (amount_cents >= 0)`. A negative magnitude here
      // means a mapping bug upstream, and silently taking its absolute value
      // would turn a reversal into an authorisation.
      throw new Error(
        `card event ${event.providerEventId} has a negative magnitude (${event.amountCents}); kind carries direction, amount does not`,
      );
    }

    if (RAISES_AUTH.has(event.kind)) {
      authorised += event.amountCents;
      sawAuthorisation = true;
    } else if (LOWERS_AUTH.has(event.kind)) {
      authorised -= event.amountCents;
    }

    if (CAPTURES.has(event.kind)) captured += event.amountCents;

    if (event.isFinal) sawFinal = true;
    if (CLOSES.has(event.kind)) sawClose = true;
  }

  const expired = clock.now.getTime() >= clock.expiresAt.getTime();

  // Four ways to be closed, and `A <= 0` needs the non-empty guard: an
  // authorisation we have created an identity for but heard nothing about yet
  // has A = 0, and that is OPEN-with-nothing-held, not CLOSED.
  const closed = sawFinal || sawClose || expired || (count > 0 && authorised <= 0n);

  const remainder = authorised - captured;
  const holdCents = closed ? 0n : remainder > 0n ? remainder : 0n;

  return {
    authorisedCents: authorised,
    capturedCents: captured,
    sawFinal,
    sawClose,
    expired,
    closed,
    holdCents,
    eventCount: count,
  };
}

/** `H(E)` on its own, for callers that do not need the working. */
export function holdCents(events: Iterable<CardEvent>, clock: AuthorizationClock): bigint {
  return holdState(events, clock).holdCents;
}

/**
 * The idempotency key of the memo posting that moves the hold to `H(E)` after
 * `providerEventId`.
 *
 * Derived from the source fact, never from a uuid we generate, and `UNIQUE` on
 * `journal_entry`. This is the last line of the exactly-once argument: even a
 * bug that bypassed the row lock could not append a second delta for the same
 * event, because Postgres would refuse the row.
 */
export function holdPostingKey(holdId: string, providerEventId: string): string {
  return `hold:${holdId}:after:${providerEventId}`;
}

/** The idempotency key of the FINANCIAL entry for a money-moving card event. */
export function financialPostingKey(kind: CardEventKind, providerEventId: string): string {
  return `card:${kind}:${providerEventId}`;
}
