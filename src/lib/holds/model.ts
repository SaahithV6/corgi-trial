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
 * WHY THERE IS NO `C >= A` ARM. This is the question the file gets asked most,
 * so the answer lives next to the arithmetic rather than only in a document.
 * An over-capture -- A = 5000, C = 7340 -- satisfies none of the four closure
 * conditions: Lithic's CLEARING carries no last-capture flag so `sawFinal` is
 * false, nothing closed or expired, and A > 0. So `closed` is FALSE and H is 0
 * by the `max`, not by the closure, and no `hold_closure` row is written.
 *
 * A fifth arm on `C >= A` is arithmetically a NO-OP for H -- max(A - C, 0) is
 * already 0 once C reaches A. Its only effects are the APPEND-ONLY closure row
 * and `v_hold_state.is_released`, which forces the hold to 0 regardless of the
 * memo balance. Both are claims about what happens NEXT, so the arm is safe
 * only if over-capture is terminal.
 *
 * [MEASURED] It is not terminal. Lithic sandbox transaction
 * faae9502-16fe-4020-8374-40b54f47bd70: authorize 5000 -> clearing 7340
 * (status SETTLED, amounts.hold 0) -> POST /v1/simulate/authorization_advice
 * 9000 answers 201 and appends AUTHORIZATION_ADVICE 9000 result APPROVED ->
 * clearing 1660 result APPROVED, settlement -9000. A rises to 9000 against
 * C = 7340, so H REOPENS at 1660 -- and the network then captures exactly that
 * 1660. A closure row written one event earlier would have freed money that was
 * still authorised, which is the $60 failure migration 0011 exists to clean up.
 *
 * DESIGN Sec 8.3 row 2 is not the row that applies here: its arrival order says
 * `clearing 73.40 FINAL`, so it closes on `sawFinal`. Rows 5 and 12 -- captures
 * never flagged final -- both say `closed: n`, which is what this computes.
 * Live-fire attack 2 re-takes the measurement above on every run and skips
 * loudly if Lithic ever refuses the incremental; docs/HOLDS.md has the argument
 * and the condition that would flip the decision.
 *
 * AND THE SAME ARGUMENT, ONE LINE OVER (migration 0028). The paragraphs above
 * were written twice -- once in migration 0011, once in DECISIONS 049 -- about
 * `C >= A`, and both times the conclusion was "a permanent row may not be
 * written on a condition a later incremental can undo". `A <= 0` IS such a
 * condition, it sat in the next disjunct, and neither pass looked at it. The
 * fuzzer did: 6.25M orderings, zero disagreements about `H`, and one
 * counterexample to the permanence of the closure row.
 *
 *     E1 = { authorization 0 }                     -> terminal, row written
 *     E2 = E1 + { incremental_authorization 1 }    -> not terminal, H = 1
 *
 * A $0 authorisation is card-on-file verification: Lithic sends AUTHORIZATION
 * amount 0 and then an advice carrying the real figure. One payload, harmless.
 * Two deliveries -- the ordinary case, and the one the brief names -- and the
 * first delivery closes the hold for ever. So `A <= 0` now belongs to `closed`
 * and NOT to `terminallyClosed`, which is the distinction this file already
 * drew and simply mis-assigned. No number moves: H is 0 on that arm either way,
 * `v_card_auth_hold.is_closed` keeps the arm and so availability still
 * withholds nothing. All that changes is that the APPEND-ONLY row is no longer
 * written on a reversible condition.
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
  | "close"
  /**
   * The network REFUSED this authorisation.
   *
   * It is a real fact and it belongs in the event log — a customer looking at a
   * declined transaction should see that it happened — but it must contribute
   * to nothing. Before migration 0026 the verdict was discarded at ingest and a
   * refusal was indistinguishable from an approval, so the ledger withheld
   * $4,451.00 that the network had never authorised.
   *
   * It appears in NO contributing set below, and that is deliberate: both folds
   * select by membership (four `Set`s here, `FILTER (WHERE kind IN ...)` in
   * SQL), so a kind in neither list is neutral in both BY CONSTRUCTION. There
   * is no arm to keep in sync and therefore nothing that can drift.
   */
  | "declined";

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
  /**
   * A(E). MAY BE NEGATIVE — a reversal can arrive before its authorisation.
   *
   * ─── WHY IT IS NOT FLOORED, decided in migration 0043 ──────────────────────
   *
   * It went to **−7340** on Lithic transaction
   * `5892c550-b966-4afb-b681-a6456e1cf3c4`: two `AUTHORIZATION_REVERSAL`s, 7340
   * and 5000, against one `AUTHORIZATION` of 5000. Three answers were on the
   * table and only one of them survives contact with the arithmetic.
   *
   * **Flooring `A` in the fold is a provable NO-OP for `H`, so it buys nothing
   * and costs the evidence.** If `A < 0` then `A <= 0`, so `closed(E)` is
   * already TRUE and `H` is already 0 — by the CLOSURE arm, not by the clamp.
   * Replace `A` with `max(A, 0)` and it is still `<= 0`, still closed, still
   * `H = 0`. Not one customer-visible number moves. What does move is
   * `v_card_auth_state.auth_net_cents`, which would stop being able to say that
   * the network over-reversed. This build's posture is that a surprising
   * provider fact is made visible, not absorbed, and flooring absorbs it in
   * exchange for nothing.
   *
   * It also would not have fixed the reported harm. The damage on that
   * transaction was done by the absolute→delta conversion in
   * `lithic-events.ts`, which reads a RUNNING total inside one payload; an
   * end-of-fold floor never touches that number. A fix that leaves the bug
   * standing is not the fix.
   *
   * **Rejecting the second reversal at ingest** refuses a fact the network
   * sent, which this build does nowhere else, and it cannot be done without
   * putting cross-event judgement in the front door — each reversal is
   * well-formed on its own; only their SUM over-reverses. Decision 050 is the
   * standing lesson about deciding things at the front door: the verdict was
   * discarded there and $4,451.00 was withheld that nobody had authorised.
   *
   * **So `A` stays unfloored — but `A >= 0` is NOT an invariant, and asserting
   * it would be a guard that fires on correct behaviour.** A lone
   * `authorization_reversal` is `A < 0` and it is exactly the shape the brief
   * names: "the settlement webhook can arrive before the auth it belongs to."
   * The fuzzer measures this rather than arguing it — **1,614 of 7,220
   * generated sets (22.4%) reach `A < 0`, 812 of them after a real
   * authorisation, and ZERO of them are open or holding a cent.** An invariant
   * that went red on 22% of legitimate event sets would be worse than no
   * invariant.
   *
   * What IS asserted, in `fuzz.test.ts`:
   *
   *     A(E) < 0  =>  closed(E)  AND  H(E) = 0
   *
   * — so the `max(·, 0)` clamp is the SECOND line there and not the only one,
   * which is the opposite of how it looked from the incident.
   *
   * And the loud part, where it can be said without being wrong: a single
   * Lithic PAYLOAD carries the whole `events[]` array, so a snapshot whose
   * reversals exceed its authorisations cannot be explained by arrival order.
   * `deriveCardEvents().overReversedCents` reports it, `applyCardTransaction()`
   * logs it, and `dbcheck`'s GUARD REACH counts the authorisations standing at
   * `A < 0` on every run.
   */
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
   * This is the predicate that licenses the APPEND-ONLY `hold_closure` row, so
   * it carries an obligation `closed` does not: it must be MONOTONE. True on a
   * subset means true on every superset, because `PRIMARY KEY (hold_id)` and
   * fifty lines of migration 0011 say that row cannot be unwritten. A
   * non-monotone arm here permanently frees a hold that the next delivery
   * re-opens.
   *
   * So it is the intersection of `closed` with the arms that are monotone by
   * construction, and there are exactly three:
   *
   *     sawFinal   ∃ over a growing set — an ∃ never un-fires
   *     sawClose   likewise
   *     expired    does not read the set at all, and the clock runs one way
   *
   * `A <= 0` is NOT one of them and that is the whole content of migration
   * 0028. `A` is a running total that can go back up: a $0 card-on-file
   * authorisation, or a genuine full reversal, is `A <= 0` today and `A = 1`
   * the moment an incremental lands. Both shapes are real Lithic traffic and
   * both are pinned as witnesses in `fuzz.test.ts`. Dropping the arm costs
   * nothing, because `closed` keeps it: `H` is already 0 there by
   * `max(A − C, 0)`, `v_card_auth_hold.is_closed` still reads TRUE, and
   * `v_hold_state.is_released` therefore still frees the money on the
   * customer's screen — reversibly, from the fold, which is what it should
   * always have been doing.
   *
   * Two shapes this used to get wrong, kept here because they are the ones
   * that will be asked about:
   *
   *   - a clearing-first identity, `{clearing 3000}`: `A = 0` because nothing
   *     authorised anything yet. `closed`, never terminal. That was migration
   *     0011's bug, and `sawAuthorisation` was the narrowing written for it —
   *     it is no longer load-bearing here, and the field stays because it is
   *     the honest name for what the set contains.
   *   - an over-capture, `A = 5000, C = 7340`: `closed` is FALSE and `H` is 0
   *     by the `max`. Measured non-terminal (DECISIONS 049), so no arm, and no
   *     closure row. See the header.
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

  // The same conditions MINUS the one a later event can undo. `A <= 0` is a
  // predicate on a running total that can go back up, and this flag is what
  // writes an append-only row. Three arms, all monotone, nothing else. See the
  // note on `terminallyClosed` and migration 0028.
  const terminallyClosed = sawFinal || sawClose || expired;

  const remainder = authorised - captured;
  const holdCents = closed ? 0n : remainder > 0n ? remainder : 0n;

  return {
    authorisedCents: authorised,
    capturedCents: captured,
    sawFinal,
    sawClose,
    sawAuthorisation,
    expired,
    closed,
    terminallyClosed,
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
