/**
 * The adversarial fuzzer for `H(E)`.
 *
 * `model.ts` argues that the hold is a pure function of an event SET — Σ, ∃,
 * `max` and one clock comparison, every one of them invariant under permutation
 * — and concludes that out-of-order delivery is not a case to handle. It is a
 * good argument. `model.test.ts` supports it with fifteen hand-picked rows.
 *
 * A function of a set is exactly what property-based testing was invented for,
 * so this file stops asserting the claim and starts attacking it: sets nobody
 * chose, delivered in every order that exists, checked against the formula in
 * the module header rather than against the code that implements it.
 *
 * ─── What is asserted ────────────────────────────────────────────────────────
 *
 *   1.  PERMUTATION INVARIANCE.  For a given set, `holdState()` returns the same
 *       `HoldState` — every field, not just `holdCents` — under every ordering.
 *       Exhaustive for sets small enough that `n!` is affordable, sampled for
 *       the rest.  This is the claim the whole design rests on.
 *   2.  THE SPECIFICATION.  A second, deliberately naive implementation of the
 *       formula in the `model.ts` header is run beside the real one on every
 *       generated set.  Differential testing against the documented spec: if the
 *       comment and the code ever part company, this is what notices.
 *   3.  H >= 0, always.
 *   4.  closed(E) => H = 0.
 *   5.  not closed(E) => H = max(A − C, 0).
 *   6.  DEDUPLICATION.  Re-delivering any event, at any position, changes
 *       nothing at all.
 *   7.  terminallyClosed => closed.
 *   8.  TERMINAL CLOSURE IS PERMANENT.  Once `terminallyClosed` is true, no
 *       further event makes it false.  *** THIS ONE USED TO FAIL.  It is now a
 *       real assertion; see FINDING 1 below and docs/FUZZ.md. ***
 *   9.  Refusals: a negative magnitude is refused wherever it sits in the order.
 *
 * ─── FINDING 1: terminal closure was not permanent.  FIXED in 0028 ───────────
 *
 * `terminallyClosed` WAS `sawFinal || sawClose || expired || (sawAuthorisation &&
 * authorised <= 0)`.  The first three arms are monotone under adding events.
 * The fourth was not, and the shrinker took it to two events:
 *
 *     E1 = { authorization 0 }                     <- a $0 card-verification auth
 *          A = 0, sawAuthorisation = true  ->  terminallyClosed = TRUE
 *     E2 = E1 + { incremental_authorization 1 }    <- the advice, one delivery later
 *          A = 1                            ->  terminallyClosed = FALSE
 *
 * `H(E2)` is 1, so money is genuinely held again — but `apply.ts` step 5 had
 * already written `hold_closure` on the strength of `E1`, that table is
 * APPEND-ONLY with `PRIMARY KEY (hold_id)`, and `v_hold_state.is_released` reads
 * it first.  The hold was permanently free while the memo book carried money in
 * it.  Same shape as the clearing-first bug that migration 0011 was written to
 * repair, in the one closure arm that survived it.
 *
 * The reversal shape is the same defect with more steps —
 * `{ authorization 100, authorization_reversal 100 }` then a late incremental —
 * and both are pinned below as witnesses A and B.
 *
 * ─── What migration 0028 did, and what this file does now ────────────────────
 *
 * `A <= 0` moved out of `terminallyClosed` and stayed in `closed`, which is the
 * distinction `model.ts` already drew.  Nothing else moved, and NO CUSTOMER
 * NUMBER moved: `H` is 0 on that arm either way by `max(A − C, 0)`,
 * `v_card_auth_hold.is_closed` still carries the arm, so availability still
 * withholds nothing — reversibly, from the fold, instead of permanently, from a
 * row.  The SQL was already right; only the predicate that licenses the row was
 * wrong.
 *
 * The properties below were NOT tuned around the finding, and they are not tuned
 * around the fix either.  Property 8 was `it.fails` — green while the defect
 * stood, red the day the model was fixed.  That day came, so it is now a plain
 * `it` asserting monotonicity outright.  The localisation test below keeps the
 * diagnosis alive rather than deleting it: it recomputes the PRE-0028 predicate
 * from the same `HoldState` fields and asserts (a) the current predicate never
 * un-fires, and (b) the legacy one still does, on this same corpus.  (b) is what
 * stops (a) from going green because the corpus got weaker.
 *
 * ─── Budget ──────────────────────────────────────────────────────────────────
 *
 * This runs on every `pnpm test`, so it is sized to stay under a couple of
 * seconds. `FUZZ_EXHAUSTIVE=1` multiplies every corpus by fifty for the deeper
 * run — that is the one whose numbers go in the report.
 */
import { describe, expect, it } from "vitest";

import {
  counterexample,
  describeEvents,
  factorial,
  generateEventSet,
  makeRng,
  orderings,
  permutations,
  shrink,
  type GenerateOptions,
} from "./fuzz-generators";
import { holdState, type AuthorizationClock, type CardEvent, type HoldState } from "./model";

const EXHAUSTIVE = process.env["FUZZ_EXHAUSTIVE"] === "1";
const SCALE = EXHAUSTIVE ? 50 : 1;

/** Distinct seed ranges per property, so one property's corpus is its own. */
const SEED_BASE = {
  permutationSmall: 1_000_000,
  permutationLarge: 2_000_000,
  invariants: 3_000_000,
  dedupe: 4_000_000,
  terminal: 5_000_000,
  refusal: 6_000_000,
} as const;

const CORPUS = {
  permutationSmall: 400 * SCALE,
  permutationLarge: 120 * SCALE,
  invariants: 3_000 * SCALE,
  dedupe: 500 * SCALE,
  terminal: 3_000 * SCALE,
  refusal: 200 * SCALE,
} as const;

/** How many orderings a set of eight or more events gets. */
const SHUFFLE_BUDGET = 120 * (EXHAUSTIVE ? 4 : 1);

/** Sets small enough for every ordering: 6! = 720, 7! = 5040. */
const EXHAUSTIVE_PERMUTATION_CEILING = 720 * (EXHAUSTIVE ? 8 : 1);

// ---------------------------------------------------------------------------
// The specification, implemented a second time
// ---------------------------------------------------------------------------

/**
 * `H(E)` transcribed from the formula at the top of `model.ts`, as naively as
 * it can be written: filter, sum, `some`, one `max`.
 *
 * This is not a better implementation and it is not meant to be used. It exists
 * so the fuzzer has something to disagree WITH. `holdState()` folds in a single
 * pass with mutable accumulators for speed; this one is the arithmetic as
 * documented. If the fold ever drifts from the documentation — a `+=` that
 * should have been `-=`, a set membership that gained a member — the two answers
 * separate and the corpus finds the set that separates them.
 */
function referenceHold(
  events: readonly CardEvent[],
  clock: AuthorizationClock,
): { a: bigint; c: bigint; closed: boolean; h: bigint; count: number } {
  // Deduplicate by providerEventId, first occurrence wins, exactly as the
  // unique index does.
  const seen = new Set<string>();
  const e: CardEvent[] = [];
  for (const event of events) {
    if (seen.has(event.providerEventId)) continue;
    seen.add(event.providerEventId);
    e.push(event);
  }

  const sum = (kinds: readonly CardEvent["kind"][]): bigint =>
    e
      .filter((x) => kinds.includes(x.kind))
      .reduce((acc, x) => acc + x.amountCents, 0n);

  const a = sum(["authorization", "incremental_authorization"]) - sum(["authorization_reversal"]);
  const c = sum(["clearing", "force_post"]);

  const closed =
    e.some((x) => x.isFinal) ||
    e.some((x) => x.kind === "close" || x.kind === "expiry") ||
    (e.length > 0 && a <= 0n) ||
    clock.now.getTime() >= clock.expiresAt.getTime();

  const remainder = a - c;
  return { a, c, closed, h: closed ? 0n : remainder > 0n ? remainder : 0n, count: e.length };
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/** Every field of `HoldState`, flattened to a string, for cheap comparison. */
function fingerprint(state: HoldState): string {
  return [
    state.authorisedCents,
    state.capturedCents,
    state.sawFinal,
    state.sawClose,
    state.sawAuthorisation,
    state.expired,
    state.closed,
    state.terminallyClosed,
    state.holdCents,
    state.eventCount,
  ].join("|");
}

function fail(message: string): never {
  throw new Error(message);
}

/**
 * How much work this file actually does, counted rather than claimed.
 *
 * "I ran fifty thousand orderings" is only a real result if the number is real,
 * so it is accumulated by the properties themselves and pinned by the last test
 * in the file. A future edit that quietly shrinks a corpus turns that test red
 * instead of silently turning the fuzzer into a formality.
 */
const CENSUS = { sets: 0, orderings: 0, prefixes: 0 };

/** One ordering, evaluated and counted. */
function fingerprintOf(events: readonly CardEvent[], clock: AuthorizationClock): string {
  CENSUS.orderings += 1;
  return fingerprint(holdState(events, clock));
}

/** One set, generated and counted. */
function gen(
  seed: number,
  options: GenerateOptions = {},
): { seed: number; events: readonly CardEvent[]; clock: AuthorizationClock } {
  CENSUS.sets += 1;
  const generated = generateEventSet(seed, options);
  return { seed, events: generated.events, clock: generated.clock };
}

/** One state over a prefix or a whole set, evaluated and counted. */
function evaluate(events: readonly CardEvent[], clock: AuthorizationClock): HoldState {
  CENSUS.prefixes += 1;
  return holdState(events, clock);
}

// ---------------------------------------------------------------------------
// 1. Permutation invariance — the claim the design rests on
// ---------------------------------------------------------------------------

/**
 * Does any ordering of `events` disagree with any other? Pure, and shaped as a
 * predicate so the shrinker can drive it.
 */
function orderingDisagrees(
  events: readonly CardEvent[],
  clock: AuthorizationClock,
  budget: number,
  shuffleSeed: number,
): { disagrees: boolean; detail?: string } {
  const rng = makeRng(shuffleSeed);
  const { orders } = orderings(events, rng, budget);
  const baseline = orders[0];
  if (baseline === undefined) return { disagrees: false };

  const reference = fingerprintOf(baseline, clock);
  for (const order of orders) {
    const got = fingerprintOf(order, clock);
    if (got !== reference) {
      return {
        disagrees: true,
        detail:
          `ordering ${describeEvents(order)}\n          gives ${got}\n` +
          `          but  ${describeEvents(baseline)}\n          gives ${reference}`,
      };
    }
  }
  return { disagrees: false };
}

describe(`H(E) is a function of the SET — ${CORPUS.permutationSmall} sets, every ordering`, () => {
  it("returns an identical HoldState under every one of the n! arrival orders", () => {
    let setsChecked = 0;
    let orderingsChecked = 0;

    for (let i = 0; i < CORPUS.permutationSmall; i++) {
      const seed = SEED_BASE.permutationSmall + i;
      const { events, clock } = gen(seed, { minSize: 1, maxSize: 6 });
      if (factorial(events.length) > EXHAUSTIVE_PERMUTATION_CEILING) continue;

      setsChecked += 1;
      const orders = permutations(events);
      orderingsChecked += orders.length;

      const first = orders[0] as CardEvent[];
      const reference = fingerprintOf(first, clock);

      for (const order of orders) {
        if (fingerprintOf(order, clock) === reference) continue;

        const shrunk = shrink(events, (candidate) =>
          permutations(candidate).some(
            (o) =>
              fingerprintOf(o, clock) !==
              fingerprintOf(candidate, clock),
          ),
        );
        fail(
          counterexample({
            property: "H(E) is invariant under permutation of E",
            seed,
            clock,
            original: events,
            shrunk,
            detail: `the ordering ${describeEvents(order)} disagrees with ${describeEvents(first)}`,
          }),
        );
      }
    }

    // The corpus has to have actually done something. A generator that quietly
    // produced 400 empty sets would pass everything above and prove nothing.
    expect(setsChecked).toBeGreaterThan(CORPUS.permutationSmall * 0.9);
    expect(orderingsChecked).toBeGreaterThan(CORPUS.permutationSmall * 2);
  });

  it(`holds for large sets too — ${CORPUS.permutationLarge} sets of 7..14 events, ${SHUFFLE_BUDGET} shuffles each`, () => {
    let orderingsChecked = 0;

    for (let i = 0; i < CORPUS.permutationLarge; i++) {
      const seed = SEED_BASE.permutationLarge + i;
      const { events, clock } = gen(seed, { minSize: 7, maxSize: 14 });

      const result = orderingDisagrees(events, clock, SHUFFLE_BUDGET, seed);
      orderingsChecked += Math.min(SHUFFLE_BUDGET, factorial(events.length));

      if (result.disagrees) {
        const shrunk = shrink(
          events,
          (candidate) => orderingDisagrees(candidate, clock, SHUFFLE_BUDGET, seed).disagrees,
        );
        fail(
          counterexample({
            property: "H(E) is invariant under permutation of E (sampled)",
            seed,
            clock,
            original: events,
            shrunk,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          }),
        );
      }
    }

    expect(orderingsChecked).toBeGreaterThan(CORPUS.permutationLarge * SHUFFLE_BUDGET * 0.9);
  });

  it("a delivery that repeats the whole set in a new order is still the same answer", () => {
    // The shape of a real redelivery: Lithic sends the WHOLE events[] array
    // every time, so the second delivery is the same set again, and there is no
    // promise its order matches the first.
    for (let i = 0; i < 500 * SCALE; i++) {
      const seed = SEED_BASE.permutationSmall + 500_000 + i;
      const { events, clock } = gen(seed, { minSize: 1, maxSize: 8 });
      const rng = makeRng(seed ^ 0x5f5f);

      const once = fingerprintOf(events, clock);
      const twice = fingerprint(
        holdState([...events, ...rng.shuffle(events)], clock),
      );
      const thrice = fingerprint(
        holdState([...rng.shuffle(events), ...events, ...rng.shuffle(events)], clock),
      );

      if (once !== twice || once !== thrice) {
        fail(
          counterexample({
            property: "re-delivering the whole set in a new order changes nothing",
            seed,
            clock,
            original: events,
            shrunk: shrink(events, (candidate) => {
              const a = fingerprintOf(candidate, clock);
              const b = fingerprintOf([...candidate, ...candidate].reverse(), clock);
              return a !== b;
            }),
            detail: `once=${once} twice=${twice} thrice=${thrice}`,
          }),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2–5. The invariants that hold for every set, whatever the order
// ---------------------------------------------------------------------------

describe(`the invariants — ${CORPUS.invariants} sets`, () => {
  /** Sets of every size including the empty one, every kind, both clocks. */
  function* corpus(
    count: number,
    base: number,
    options: GenerateOptions = {},
  ): Generator<{ seed: number; events: readonly CardEvent[]; clock: AuthorizationClock }> {
    for (let i = 0; i < count; i++) {
      const seed = base + i;
      const { events, clock } = gen(seed, {
        minSize: 0,
        maxSize: 10,
        ...options,
      });
      yield { seed, events, clock };
    }
  }

  it("H >= 0 for every set, and H = 0 whenever closed(E)", () => {
    for (const { seed, events, clock } of corpus(CORPUS.invariants, SEED_BASE.invariants)) {
      const state = evaluate(events, clock);

      if (state.holdCents < 0n) {
        fail(
          counterexample({
            property: "H(E) >= 0",
            seed,
            clock,
            original: events,
            shrunk: shrink(events, (c) => holdState(c, clock).holdCents < 0n),
            detail: `H = ${state.holdCents}`,
          }),
        );
      }

      if (state.closed && state.holdCents !== 0n) {
        fail(
          counterexample({
            property: "closed(E) => H(E) = 0",
            seed,
            clock,
            original: events,
            shrunk: shrink(events, (c) => {
              const s = holdState(c, clock);
              return s.closed && s.holdCents !== 0n;
            }),
            detail: `closed but H = ${state.holdCents}`,
          }),
        );
      }
    }
  });

  it("H = max(A − C, 0) whenever the set is not closed", () => {
    for (const { seed, events, clock } of corpus(
      CORPUS.invariants,
      SEED_BASE.invariants + 100_000,
    )) {
      const state = evaluate(events, clock);
      if (state.closed) continue;

      const remainder = state.authorisedCents - state.capturedCents;
      const expected = remainder > 0n ? remainder : 0n;
      if (state.holdCents === expected) continue;

      fail(
        counterexample({
          property: "not closed(E) => H(E) = max(A − C, 0)",
          seed,
          clock,
          original: events,
          shrunk: shrink(events, (c) => {
            const s = holdState(c, clock);
            if (s.closed) return false;
            const r = s.authorisedCents - s.capturedCents;
            return s.holdCents !== (r > 0n ? r : 0n);
          }),
          detail: `A=${state.authorisedCents} C=${state.capturedCents} H=${state.holdCents} expected ${expected}`,
        }),
      );
    }
  });

  it("agrees with the formula in the model.ts header, transcribed independently", () => {
    // Differential test against the SPECIFICATION rather than against a fixture.
    // The day the fold and the comment disagree, this is what says so.
    for (const { seed, events, clock } of corpus(
      CORPUS.invariants,
      SEED_BASE.invariants + 200_000,
    )) {
      const state = evaluate(events, clock);
      const spec = referenceHold(events, clock);

      const mismatch =
        state.authorisedCents !== spec.a ||
        state.capturedCents !== spec.c ||
        state.closed !== spec.closed ||
        state.holdCents !== spec.h ||
        state.eventCount !== spec.count;

      if (!mismatch) continue;

      fail(
        counterexample({
          property: "holdState() equals the formula documented at the top of model.ts",
          seed,
          clock,
          original: events,
          shrunk: shrink(events, (c) => {
            const s = holdState(c, clock);
            const r = referenceHold(c, clock);
            return (
              s.authorisedCents !== r.a ||
              s.capturedCents !== r.c ||
              s.closed !== r.closed ||
              s.holdCents !== r.h ||
              s.eventCount !== r.count
            );
          }),
          detail:
            `code: A=${state.authorisedCents} C=${state.capturedCents} closed=${state.closed} H=${state.holdCents} n=${state.eventCount}\n` +
            `  spec: A=${spec.a} C=${spec.c} closed=${spec.closed} H=${spec.h} n=${spec.count}`,
        }),
      );
    }
  });

  it("carries amounts past 2^53 without losing a cent", () => {
    // The system claims bigint cents everywhere. A fuzzer that never leaves the
    // safe-integer range never tests the claim, so one set does it on purpose.
    const huge = 9_007_199_254_740_993n; // 2^53 + 1, not representable as a double
    const state = holdState(
      [
        {
          kind: "authorization",
          amountCents: huge,
          isFinal: false,
          valueDate: "2026-09-10",
          providerEventId: "big-1",
        },
        {
          kind: "clearing",
          amountCents: 1n,
          isFinal: false,
          valueDate: "2026-09-10",
          providerEventId: "big-2",
        },
      ],
      { expiresAt: new Date("2099-01-01T00:00:00Z"), now: new Date("2026-09-10T12:00:00Z") },
    );
    expect(state.holdCents).toBe(huge - 1n);
    // ...and the demonstration that it had to be bigint: as `number`, the sum
    // and the input are the SAME VALUE. A float ledger loses this cent silently.
    expect(Number(state.holdCents)).toBe(Number(huge));
    expect(state.holdCents).not.toBe(huge);
  });
});

// ---------------------------------------------------------------------------
// 6. Deduplication by providerEventId
// ---------------------------------------------------------------------------

describe(`deduplication — ${CORPUS.dedupe} sets, every event re-delivered at every position`, () => {
  it("adding a duplicate of any event, anywhere in the order, changes nothing", () => {
    let insertions = 0;

    for (let i = 0; i < CORPUS.dedupe; i++) {
      const seed = SEED_BASE.dedupe + i;
      const { events, clock } = gen(seed, { minSize: 1, maxSize: 6 });
      const reference = fingerprintOf(events, clock);

      for (let e = 0; e < events.length; e++) {
        const duplicate = events[e] as CardEvent;
        for (let at = 0; at <= events.length; at++) {
          insertions += 1;
          const candidate = [...events.slice(0, at), duplicate, ...events.slice(at)];
          if (fingerprintOf(candidate, clock) === reference) continue;

          fail(
            counterexample({
              property: "E ∪ {e} = E when e is already in E — dedupe by providerEventId",
              seed,
              clock,
              original: events,
              shrunk: shrink(events, (c) =>
                c.some(
                  (dup) =>
                    fingerprintOf([dup, ...c], clock) !==
                    fingerprintOf(c, clock),
                ),
              ),
              detail: `re-delivering ${duplicate.providerEventId} at position ${at} moved the answer`,
            }),
          );
        }
      }
    }

    expect(insertions).toBeGreaterThan(CORPUS.dedupe * 4);
  });

  it("a duplicate is decided by the id alone — and that is a PRECONDITION, not a property", () => {
    // Two events sharing a providerEventId but disagreeing about their contents
    // are NOT a set the database can produce: `UNIQUE (auth_id,
    // provider_event_id)` means the second insert never lands, so `E` can never
    // contain both. Fed to `holdState()` directly they ARE order-dependent —
    // first occurrence wins — and that is worth writing down rather than
    // discovering later, because it is the single precondition the
    // function-of-a-set argument rests on.
    const clock = {
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      now: new Date("2026-09-10T12:00:00Z"),
    };
    const a: CardEvent = {
      kind: "authorization",
      amountCents: 5_000n,
      isFinal: false,
      valueDate: "2026-09-10",
      providerEventId: "same-id",
    };
    const b: CardEvent = { ...a, kind: "clearing", amountCents: 900n };

    expect(holdState([a, b], clock).holdCents).toBe(5_000n);
    expect(holdState([b, a], clock).holdCents).toBe(0n);
    // The dedupe key must therefore be trusted, which is why it is a database
    // constraint and not a convention.
  });
});

// ---------------------------------------------------------------------------
// 7–8. Closure, and the one that matters most
// ---------------------------------------------------------------------------

/**
 * `terminallyClosed` as it stood BEFORE migration 0028, recomputed from the
 * fields of the state the current model returns.
 *
 * It is here so the fix is asserted rather than assumed. Deleting the defect's
 * test would leave "the corpus finds no violations" resting on the corpus still
 * being able to produce one, which is exactly the kind of silent weakening the
 * census below exists to prevent. Every property that asserts the new predicate
 * is monotone also asserts that this one is NOT, on the same sets, in the same
 * loop.
 */
function legacyTerminallyClosed(state: HoldState): boolean {
  return (
    state.sawFinal ||
    state.sawClose ||
    state.expired ||
    (state.sawAuthorisation && state.authorisedCents <= 0n)
  );
}

/**
 * The corpus for the closure properties, biased towards the shapes that can
 * possibly move a closure: authorisations, reversals and increments.
 */
function closureCorpus(count: number, base: number): {
  seed: number;
  events: readonly CardEvent[];
  clock: AuthorizationClock;
}[] {
  const out: { seed: number; events: readonly CardEvent[]; clock: AuthorizationClock }[] = [];
  for (let i = 0; i < count; i++) {
    const seed = base + i;
    const { events, clock } = gen(seed, {
      minSize: 1,
      maxSize: 8,
      // Never generate the expired clock here: `expired` is true for every
      // subset alike, so it would mask the arms this is actually probing.
      expiredProbability: 0,
    });
    out.push({ seed, events, clock });
  }
  return out;
}

describe(`closure — ${CORPUS.terminal} sets`, () => {
  it("terminallyClosed implies closed, for every set", () => {
    for (const { seed, events, clock } of closureCorpus(CORPUS.terminal, SEED_BASE.terminal)) {
      const state = evaluate(events, clock);
      if (!state.terminallyClosed || state.closed) continue;

      fail(
        counterexample({
          property: "terminallyClosed(E) => closed(E)",
          seed,
          clock,
          original: events,
          shrunk: shrink(events, (c) => {
            const s = holdState(c, clock);
            return s.terminallyClosed && !s.closed;
          }),
        }),
      );
    }
  });

  it("terminallyClosed also implies H = 0, so a closure row never frees money still held", () => {
    for (const { seed, events, clock } of closureCorpus(
      CORPUS.terminal,
      SEED_BASE.terminal + 100_000,
    )) {
      const state = evaluate(events, clock);
      if (!state.terminallyClosed || state.holdCents === 0n) continue;

      fail(
        counterexample({
          property: "terminallyClosed(E) => H(E) = 0",
          seed,
          clock,
          original: events,
          shrunk: shrink(events, (c) => {
            const s = holdState(c, clock);
            return s.terminallyClosed && s.holdCents !== 0n;
          }),
          detail: `H = ${state.holdCents} on a hold that has been permanently closed`,
        }),
      );
    }
  });

  /**
   * *** THE ONE THAT MATTERS MOST, AND IT FAILS. ***
   *
   * `apply.ts` step 5 writes an append-only `hold_closure` row the moment
   * `terminallyClosed` is true. `PRIMARY KEY (hold_id)` and migration 0011's
   * whole preamble say the same thing: that row cannot be unwritten except by a
   * compensating `hold_closure_reversal` that nothing in the live path emits.
   * So `terminallyClosed` must be MONOTONE — true on a subset means true on
   * every superset — or the system permanently frees a hold that a later event
   * re-opens.
   *
   * It was not, and this test was `it.fails` while that stood: green on the
   * defect, red the day `model.ts` was fixed. That day was migration 0028, so
   * the body below is now a plain assertion and the corpus has to actually find
   * nothing. Its sweep, its shrinker and its failure message are untouched — the
   * only edit is the wrapper. See FINDING 1 in the header and docs/FUZZ.md.
   */
  it(
    "FINDING 1, fixed — once terminallyClosed, no further event makes it false again",
    () => {
      // The WHOLE corpus is swept before anything is thrown, so the failure
      // message carries a rate rather than an anecdote. A property that gives up
      // at its first counterexample cannot tell you whether you found a corner
      // or a wall.
      let firstSeed = -1;
      let firstEvents: readonly CardEvent[] = [];
      let firstClock: AuthorizationClock | null = null;
      let firstDetail = "";
      let violations = 0;
      let setsSwept = 0;

      for (const { seed, events, clock } of closureCorpus(
        CORPUS.terminal,
        SEED_BASE.terminal + 200_000,
      )) {
        setsSwept += 1;
        // Deliver the set one event at a time and watch for the flag going back
        // down. Order matters here on purpose: the claim is about the ARRIVAL
        // of further facts, and every prefix is a set the system really was in.
        let everTerminal = false;
        for (let n = 1; n <= events.length; n++) {
          const state = evaluate(events.slice(0, n), clock);
          if (state.terminallyClosed) {
            everTerminal = true;
            continue;
          }
          if (!everTerminal) continue;

          violations += 1;
          if (firstClock === null) {
            firstSeed = seed;
            firstEvents = events;
            firstClock = clock;
            firstDetail =
              `after ${n} events terminallyClosed went back to false; ` +
              `A=${state.authorisedCents} H=${state.holdCents} — and hold_closure is append-only`;
          }
          break;
        }
      }

      if (firstClock === null) return; // the invariant holds — which is now a PASS

      const clock = firstClock;
      fail(
        counterexample({
          property: "terminallyClosed is monotone under adding events to E",
          seed: firstSeed,
          clock,
          original: firstEvents,
          shrunk: shrink(firstEvents, (candidate) => {
            let seenTerminal = false;
            for (let k = 1; k <= candidate.length; k++) {
              const s = holdState(candidate.slice(0, k), clock);
              if (s.terminallyClosed) seenTerminal = true;
              else if (seenTerminal) return true;
            }
            return false;
          }),
          detail: `${firstDetail}\n  rate: ${violations} of ${setsSwept} generated sets break this`,
        }),
      );
    },
  );

  it("FINDING 1 was EXACTLY the `A <= 0` arm — and 0028 removed exactly that arm", () => {
    // The localisation, and it is the part that turns "closure is unreliable"
    // into a one-line diagnosis. Sweep the corpus, collect every prefix where
    // terminal closure went back down, and check what was true at the prefix
    // that closed it. If `sawFinal`, `sawClose` or `expired` had been the reason
    // it could never have un-fired — those three are monotone by construction.
    // So every violation must be the fourth disjunct, or the diagnosis is wrong.
    //
    // Both predicates are swept in the SAME loop, off the same `HoldState`:
    //
    //   currentViolations  MUST be 0   — the arm is gone, so nothing un-fires
    //   legacyViolations   MUST be > 0 — the corpus can still produce the
    //                                    shape, so the zero above is the fix
    //                                    and not a corpus that went quiet
    //
    // That pairing is the point. A test that only asserted the first would go
    // green if someone narrowed the generator, and the day it did, nothing in
    // this file would say so.
    let currentViolations = 0;
    let legacyViolations = 0;

    for (const { events, clock } of closureCorpus(
      CORPUS.terminal,
      SEED_BASE.terminal + 300_000,
    )) {
      let closedAt: HoldState | null = null;
      let everTerminal = false;

      for (let n = 1; n <= events.length; n++) {
        const state = evaluate(events.slice(0, n), clock);

        // The predicate as it stands NOW must never go back down.
        if (state.terminallyClosed) everTerminal = true;
        else if (everTerminal) currentViolations += 1;

        // The predicate as it stood BEFORE 0028, on the same prefix.
        if (legacyTerminallyClosed(state)) {
          closedAt ??= state;
          continue;
        }
        if (closedAt === null) continue;

        legacyViolations += 1;
        // The prefix that wrote the permanent closure did so on `A <= 0` and on
        // nothing else...
        expect({
          sawFinal: closedAt.sawFinal,
          sawClose: closedAt.sawClose,
          expired: closedAt.expired,
          sawAuthorisation: closedAt.sawAuthorisation,
          authorisedAtMostZero: closedAt.authorisedCents <= 0n,
        }).toEqual({
          sawFinal: false,
          sawClose: false,
          expired: false,
          sawAuthorisation: true,
          authorisedAtMostZero: true,
        });
        // ...and the later event that un-closed it raised A back above zero.
        expect(state.authorisedCents > 0n).toBe(true);
        // ...and it is only the closure flag that moved: `H` was 0 at the
        // closing prefix and `closed(E)` was TRUE there, which is why removing
        // the arm from the permanent row costs no customer-visible number.
        expect({ h: closedAt.holdCents, closed: closedAt.closed }).toEqual({
          h: 0n,
          closed: true,
        });
        break;
      }
    }

    // The fix: the arm that produced every violation is gone.
    expect(currentViolations).toBe(0);
    // The corpus that proved it still reaches the shape. Not a one-in-a-million
    // corner then, and not a silenced generator now.
    expect(legacyViolations).toBeGreaterThan(0);
  });

  it("FINDING 1, witness A (pinned): a $0 authorisation is no longer closed on arrival", () => {
    // The minimal witness the shrinker found, and the reachable one. A $0
    // authorisation is how card-on-file verification works and how a fuel pump
    // opens before the advice carries the real figure — Lithic sends
    // AUTHORIZATION with amount 0, then an AUTHORIZATION_ADVICE later.
    //
    // `lithic-events.ts` already knows this hazard exists: BALANCE_INQUIRY is
    // deliberately dropped because "storing a zero-amount row in card_auth_event
    // would put a member in E that changes count(*) ... without changing any
    // sum". A genuine zero-amount AUTHORIZATION is not dropped, and it lands in
    // `E` with `sawAuthorisation = true`.
    const clock = {
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      now: new Date("2026-09-10T12:00:00Z"),
    };
    const zeroAuth: CardEvent = {
      kind: "authorization",
      amountCents: 0n,
      isFinal: false,
      valueDate: "2026-09-10",
      providerEventId: "f1a-auth-zero",
    };
    const advice: CardEvent = {
      kind: "incremental_authorization",
      amountCents: 5_000n,
      isFinal: false,
      valueDate: "2026-09-10",
      providerEventId: "f1a-advice",
    };

    // Delivery one, on its own, as the webhook really arrives.
    const first = holdState([zeroAuth], clock);
    expect(first.sawAuthorisation).toBe(true);
    expect(first.authorisedCents).toBe(0n);

    // BEFORE 0028: apply.ts step 5 wrote the append-only hold_closure row HERE,
    // with closureReason() == "authorisation fully reversed" — a false statement
    // in an immutable audit table, about an authorisation nobody reversed.
    expect(legacyTerminallyClosed(first)).toBe(true);
    // AFTER 0028: no row. Nothing about this delivery is permanent.
    expect(first.terminallyClosed).toBe(false);

    // And the money is unchanged, which is the claim that made the fix free.
    // `closed(E)` keeps the `A <= 0` arm, so `v_card_auth_hold.is_closed` still
    // reads TRUE and availability still withholds nothing — it just does it
    // from the fold, where a later event can move it, rather than from a row,
    // where nothing can.
    expect(first.closed).toBe(true);
    expect(first.holdCents).toBe(0n);

    // Delivery two: the real amount lands.
    const second = holdState([zeroAuth, advice], clock);
    expect(second.authorisedCents).toBe(5_000n);
    expect(second.holdCents).toBe(5_000n); // $50 is genuinely held again...
    expect(second.closed).toBe(false); // ...and the fold says so...
    expect(second.terminallyClosed).toBe(false); // ...on a hold nothing closed.

    // The consequence that used to follow, spelled out: `v_hold_state.is_released`
    // reads the closure row FIRST, so `active_hold_cents` was 0 while the memo
    // book carried 5000. That was $50 the customer could spend twice, and it is
    // the exact row shape `v_hold_release_drift` was added in 0011 to report.
    // With no row written, `is_released` is now just the fold, and the fold
    // re-opens.
  });

  it("FINDING 1, witness B (pinned): a full reversal, then a late incremental", () => {
    const clock = {
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      now: new Date("2026-09-10T12:00:00Z"),
    };
    const ev = (
      kind: CardEvent["kind"],
      amountCents: bigint,
      providerEventId: string,
    ): CardEvent => ({
      kind,
      amountCents,
      isFinal: false,
      valueDate: "2026-09-10",
      providerEventId,
    });

    const auth = ev("authorization", 100n, "f1b-auth");
    const reversal = ev("authorization_reversal", 100n, "f1b-rev");
    const increment = ev("incremental_authorization", 1n, "f1b-incr");

    // Deliveries one and two: a genuine full reversal. This is the shape the
    // `A <= 0` arm was really written for, and it is still `closed` — the money
    // is right, H is 0, availability withholds nothing.
    const closedState = holdState([auth, reversal], clock);
    expect(closedState.closed).toBe(true);
    expect(closedState.holdCents).toBe(0n);
    // It is what happens NEXT that the old predicate got wrong. "Fully reversed"
    // is a statement about a running total, not about the future: pre-0028 it
    // licensed a permanent row, and post-0028 it does not.
    expect(legacyTerminallyClosed(closedState)).toBe(true);
    expect(closedState.terminallyClosed).toBe(false);

    // Delivery three: an incremental lands late — the ordinary out-of-order case
    // the brief names. A cent is held again on a hold already closed for ever.
    const reopened = holdState([auth, reversal, increment], clock);
    expect(reopened.authorisedCents).toBe(1n);
    expect(reopened.holdCents).toBe(1n);
    expect(reopened.closed).toBe(false);
    expect(reopened.terminallyClosed).toBe(false);

    // AND THE POINT: `H` itself was always blameless. Every ordering of the full
    // set agrees, exactly as model.ts claims. What was not a function of the set
    // is the CLOSURE ROW, because it was decided on a PREFIX and then made
    // permanent. "No arrival order is a special case" was true of H(E) and false
    // of the append-only row H(E)'s caller wrote on the way — which is the whole
    // of FINDING 1, and what 0028 closed.
    for (const order of permutations([auth, reversal, increment])) {
      const state = holdState(order, clock);
      expect(state.holdCents).toBe(1n);
      expect(state.terminallyClosed).toBe(false);
    }

    // The repaired claim, stated over PREFIXES rather than over the set: no
    // arrival order of these three events reaches a prefix that would write the
    // permanent row. That is the property the closure row needed all along, and
    // it now holds for the same reason H does — it is built out of arms that
    // cannot go back down.
    for (const order of permutations([auth, reversal, increment])) {
      for (let n = 1; n <= order.length; n++) {
        expect(holdState(order.slice(0, n), clock).terminallyClosed).toBe(false);
      }
    }
  });

  it("the other three arms ARE monotone, which is why the diagnosis is that narrow", () => {
    // sawFinal and sawClose are ∃ over a growing set, and `expired` does not
    // read the set at all. Asserted rather than assumed, because the whole
    // diagnosis above rests on it.
    for (const { seed, events, clock } of closureCorpus(
      CORPUS.terminal,
      SEED_BASE.terminal + 400_000,
    )) {
      let sawFinal = false;
      let sawClose = false;
      let expired = false;
      for (let n = 1; n <= events.length; n++) {
        const state = evaluate(events.slice(0, n), clock);
        if (
          (sawFinal && !state.sawFinal) ||
          (sawClose && !state.sawClose) ||
          (expired && !state.expired)
        ) {
          fail(
            counterexample({
              property: "sawFinal, sawClose and expired are monotone under adding events",
              seed,
              clock,
              original: events,
              shrunk: events.slice(0, n),
              detail: `at ${n} events: final ${sawFinal}->${state.sawFinal}, close ${sawClose}->${state.sawClose}, expired ${expired}->${state.expired}`,
            }),
          );
        }
        sawFinal ||= state.sawFinal;
        sawClose ||= state.sawClose;
        expired ||= state.expired;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Refusals
// ---------------------------------------------------------------------------

describe("refusals are order-free too", () => {
  it("a negative magnitude is refused wherever in the arrival order it sits", () => {
    for (let i = 0; i < CORPUS.refusal; i++) {
      const seed = SEED_BASE.refusal + i;
      const { events, clock } = gen(seed, { minSize: 1, maxSize: 5 });
      const rng = makeRng(seed);
      const poison: CardEvent = {
        kind: rng.pick(["authorization", "authorization_reversal", "clearing"] as const),
        amountCents: -BigInt(rng.between(1, 100_000)),
        isFinal: false,
        valueDate: "2026-09-10",
        providerEventId: `poison-${seed}`,
      };

      for (let at = 0; at <= events.length; at++) {
        const candidate = [...events.slice(0, at), poison, ...events.slice(at)];
        expect(() => holdState(candidate, clock)).toThrow(/negative magnitude/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The fuzzer's own machinery
// ---------------------------------------------------------------------------

describe("the fuzzer itself", () => {
  it("is deterministic: the same seed is the same set, every time, in this process and the next", () => {
    const a = generateEventSet(424_242, { minSize: 3, maxSize: 3 });
    const b = generateEventSet(424_242, { minSize: 3, maxSize: 3 });
    expect(describeEvents(a.events)).toBe(describeEvents(b.events));
    expect(a.clock.expiresAt.toISOString()).toBe(b.clock.expiresAt.toISOString());

    // A different seed is a different set. Not guaranteed for any given pair,
    // but a generator where it never happened would be a constant.
    const differing = Array.from({ length: 50 }, (_, i) =>
      describeEvents(generateEventSet(500_000 + i, { minSize: 3, maxSize: 3 }).events),
    );
    expect(new Set(differing).size).toBeGreaterThan(40);
  });

  it("shrinks a forty-event counterexample down to the events that cause it", () => {
    // Plant a defect the shrinker must find: "this set contains a close". Forty
    // events of noise around one of them.
    const rng = makeRng(7);
    const noise: CardEvent[] = Array.from({ length: 40 }, (_, i) => ({
      kind: "clearing" as const,
      amountCents: BigInt(rng.between(1, 9_999)),
      isFinal: false,
      valueDate: "2026-09-10",
      providerEventId: `noise-${i}`,
    }));
    noise[17] = {
      kind: "close",
      amountCents: 4_242n,
      isFinal: false,
      valueDate: "2026-09-10",
      providerEventId: "the-close",
    };

    const shrunk = shrink(noise, (c) => c.some((e) => e.kind === "close"));
    expect(shrunk).toHaveLength(1);
    expect(shrunk[0]?.providerEventId).toBe("the-close");
    // ...and simplified, because a reader does not need to know it was 4242.
    expect(shrunk[0]?.amountCents).toBe(0n);
  });

  it("generates every kind in the vocabulary across the default corpus", () => {
    // A corpus that never emits a force_post is a corpus that never tests one.
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i++) {
      for (const e of generateEventSet(SEED_BASE.invariants + i, { maxSize: 10 }).events) {
        seen.add(e.kind);
      }
    }
    expect([...seen].sort()).toEqual(
      [
        "authorization",
        "authorization_reversal",
        "clearing",
        "close",
        "expiry",
        "force_post",
        "incremental_authorization",
        "refund",
      ].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// The census — how much work was actually done
// ---------------------------------------------------------------------------

describe("the census", () => {
  it("pins the amount of work, so nobody can quietly turn this into a formality", () => {
    // Accumulated by the properties above, not asserted about them. The numbers
    // are lower bounds at the DEFAULT scale; FUZZ_EXHAUSTIVE=1 multiplies them
    // by fifty. Shrink a corpus and this goes red.
    //
    // These are the figures quoted in docs/FUZZ.md. Every one of them is a real
    // call into `holdState()` made by this file in this process.
    expect(CENSUS.sets).toBeGreaterThanOrEqual(25_720 * SCALE);
    expect(CENSUS.orderings).toBeGreaterThanOrEqual(98_611 * SCALE);
    expect(CENSUS.prefixes).toBeGreaterThanOrEqual(55_036 * SCALE);
  });
});

// ===========================================================================
// The same property, end to end, against the live book
// ===========================================================================
//
// Everything above is about a pure function, and a pure function is the easy
// half. The claim the brief actually makes is about a SYSTEM: deliver the same
// facts in different orders through `applyCardTransaction()` — inbox, unique
// index, row lock, financial postings, closure row, compare-and-append — and the
// book lands in the same place.
//
// So: one generated set, several arrival orders, one fresh card and
// authorisation per order, ONE EVENT PER WEBHOOK (the only way to make ordering
// real — Lithic's own payload carries the whole array, so a "clearing-first"
// delivery is a delivery that does not mention the authorisation). Then the
// memo balance, `v_hold_drift` and `v_hold_release_drift` all have to agree.
//
// Gated on RUN_DB_TESTS=1, like the rest of the live-fire suite:
//
//   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
//
// ─── WHAT THIS DELIBERATELY DOES NOT DELIVER, AND WHY ────────────────────────
//
// Sets that reproduce FINDING 1 are filtered out before anything is sent. That
// is not the property being tuned until it passes — it is a refusal to corrupt a
// shared ledger to prove a point that is already proved above. Reproducing
// FINDING 1 here writes a PERMANENT, WRONG `hold_closure` row into an
// append-only table on a database five other people are using, and the only way
// back is a hand-written `hold_closure_reversal` (see
// scripts/repair-0011-spurious-closures.mjs, which exists because this happened
// once already). The filter is named, asserted, and counted below; docs/FUZZ.md
// carries the manual recipe for anyone who wants to watch it happen on a
// throwaway database.
import type {
  Transaction,
  TransactionEvent,
  TransactionEventType,
} from "@/lib/rails/lithic/types";

import type * as ApplyModule from "./apply";
import type * as StoreModule from "./store";
import type { sql as SqlHandle } from "@/lib/ledger/db";

/** How many generated sets the live-book property delivers. Each costs ~3x
 *  its length in round trips to Neon, so it is small on purpose. */
const DB_SETS = 6;

const RUN_DB = process.env["RUN_DB_TESTS"] === "1";
const dbDescribe = RUN_DB ? describe : describe.skip;

/** Lithic steps with a 1:1 canonical mapping and a `new_event` semantics row. */
const DB_STEPS: readonly TransactionEventType[] = [
  "AUTHORIZATION",
  "AUTHORIZATION_REVERSAL",
  "CLEARING",
  "FINANCIAL_AUTHORIZATION",
  "RETURN",
];

/**
 * Deliberately NOT in `DB_STEPS`:
 *
 *   AUTHORIZATION_ADVICE   its canonical delta is computed from the events that
 *                          precede it IN THE SAME PAYLOAD, so splitting a
 *                          payload one-event-per-delivery changes what it means.
 *                          That is a property of the Lithic adapter, not of the
 *                          hold model, and conflating the two would make this
 *                          test unable to say which layer broke.
 *   RETURN_REVERSAL,       classified `correction` in `rail_event_semantics`:
 *   CORRECTION_*           they take the reverse-and-rebook path at the ORIGINAL
 *                          value date, which is a different property with its
 *                          own suite (corrections.test.ts).
 */

dbDescribe("the same event set, delivered in different orders, against the live book", () => {
  let sql: typeof SqlHandle;
  let apply: typeof ApplyModule;
  let store: typeof StoreModule;

  /** This suite's own business, so no other suite's deltas are in the frame. */
  const FUZZ_BUSINESS_ID = "7e57b115-0000-5000-a000-0000000000f2";
  const run = Date.now();
  let cardSeq = 0;
  let businessId: string;
  let memoAccountId: string;

  /** Sets the FINDING 1 filter refused to send. Asserted on, not swallowed. */
  let filteredForFinding1 = 0;
  let setsDelivered = 0;
  let orderingsDelivered = 0;

  /**
   * The fixture, opened THROUGH THE PRODUCT rather than around it.
   *
   * The business row and its two KYB legs are written with the owner
   * connection, because they are operator facts and the application role
   * deliberately cannot forge them. The ACCOUNTS are then opened by
   * `openBusinessAccounts()` — the same call the onboarding screen makes, which
   * goes through `business_accounts_open()`, which reads `v_business_kyb`
   * itself and refuses a business that is not approved.
   *
   * Two consequences worth stating. First, this suite writes no SQL against
   * `account`, `journal_entry` or `journal_line` — `src/lib/ledger/boundary.test.ts`
   * is a ratchet and a new file has no allowance, correctly. Second, the fixture
   * cannot exist unless the KYB gate passed, so "the fuzzer opened an account
   * the product would have refused to open" is not a state this can reach.
   *
   * The legs are labelled `simulated` evidence from a provider named
   * `simulated-hold-fuzzer`, which is what they are. `kyb_leg_simulated_reference`
   * would refuse them if they claimed to be live.
   */
  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    apply = await import("./apply");
    store = await import("./store");

    const directUrl = process.env["DIRECT_URL"];
    if (directUrl === undefined || directUrl === "") {
      throw new Error("DIRECT_URL (the owner role) is required to open the fuzz test business");
    }
    const { default: postgres } = await import("postgres");
    const owner = postgres(directUrl, { max: 1, onnotice: () => {} });
    try {
      await owner`
        INSERT INTO business (id, entity_id, legal_name, ein)
        SELECT ${FUZZ_BUSINESS_ID}::uuid, e.id, 'Hold Fuzzer Fixture Co.', '00-0000001'
          FROM book_entity e LIMIT 1
        ON CONFLICT DO NOTHING`;

      // `kyb_verification_leg` is append-only, so the guard is NOT EXISTS
      // rather than ON CONFLICT: repeated runs must not file the same evidence
      // again, and there is no key to conflict on.
      for (const leg of ["director_kyc", "business_registry"] as const) {
        await owner`
          INSERT INTO kyb_verification_leg
            (business_id, leg, provider, provider_reference, status, evidence,
             raw_status, observed_at)
          SELECT ${FUZZ_BUSINESS_ID}::uuid, ${leg}::kyb_leg,
                 'simulated-hold-fuzzer', ${`sim.fuzz-${leg}`},
                 'approved'::kyb_status, 'simulated'::kyb_evidence,
                 'approved', now()
           WHERE NOT EXISTS (
             SELECT 1 FROM kyb_verification_leg
              WHERE business_id = ${FUZZ_BUSINESS_ID}::uuid AND leg = ${leg}::kyb_leg)`;
      }
    } finally {
      await owner.end();
    }

    const actorId = await store.ledgerPosterActorId(sql);
    const { openBusinessAccounts } = await import("@/lib/onboarding/open");
    const opened = await openBusinessAccounts(FUZZ_BUSINESS_ID, actorId, { conn: sql });
    if (!opened.ok) {
      throw new Error(`the fuzz fixture's accounts did not open: ${opened.error.code}`);
    }
    if (opened.value.kind === "not_yet") {
      throw new Error(`the fuzz fixture is ${opened.value.status}, not approved`);
    }

    const { findBusiness, resolveChartCodes } = await import("@/lib/ledger/readers");
    const business = await findBusiness(FUZZ_BUSINESS_ID, sql);
    if (business === null || business.depositAccountId === null || business.memoAccountId === null) {
      throw new Error("the fuzz fixture has no deposit or memo leaf");
    }
    businessId = business.businessId;
    memoAccountId = business.memoAccountId;

    // An opening float, once ever, so an over-capture is a fall from a real
    // balance rather than a step from zero — and so this fixture never shows up
    // on `v_overdrawn_accounts` as somebody else's mystery. Fixed idempotency
    // key: repeated runs do not inflate the book.
    const house = await resolveChartCodes(
      { entityId: business.entityId, houseCodes: ["1110"] },
      sql,
    );
    const cash = house.get("1110");
    if (cash === undefined) throw new Error("seed first: node scripts/seed.mjs");

    const { postEntry } = await import("@/lib/ledger/post");
    await postEntry({
      entityId: business.entityId,
      valueDate: "2026-09-01",
      book: "financial",
      description: "Opening float for the hold fuzzer",
      idempotencyKey: "test:holds:fuzz:opening-float",
      actorId,
      rail: "internal",
      lines: [
        { accountId: cash.accountId, amountCents: 500_000_00n },
        { accountId: business.depositAccountId, amountCents: -500_000_00n },
      ],
    });
  }, 180_000);

  interface Step {
    readonly type: TransactionEventType;
    readonly amountCents: bigint;
  }

  /**
   * A small set of Lithic steps, deterministically, from a seed.
   *
   * One authorisation of a real size, then one to three follow-ups drawn from
   * the whole vocabulary. The authorisation is in the SET, not in the delivery
   * order — every ordering below still shuffles it, and half of them deliver a
   * clearing or a reversal before it. The bias exists so the corpus contains
   * holds that are still OPEN at the end: a uniform draw over these five steps
   * ends with `H = 0` almost every time, which would make the memo-balance
   * assertion below true for an uninteresting reason.
   */
  function generateSteps(seed: number): Step[] {
    const rng = makeRng(seed);
    const authorised = rng.between(5_000, 20_000);
    const followUps = rng.between(1, 3);
    return [
      { type: "AUTHORIZATION" as const, amountCents: BigInt(authorised) },
      ...Array.from({ length: followUps }, () => ({
        type: rng.pick(DB_STEPS),
        // Capped at the authorised figure plus a fuel-pump margin: an
        // over-capture should overdraw the account, not obliterate it.
        amountCents: BigInt(rng.between(0, authorised + 5_000)),
      })),
    ];
  }

  /** The canonical events those steps become, in the model's vocabulary. */
  function canonical(steps: readonly Step[], ids: readonly string[]): CardEvent[] {
    return steps.map((step, i) => ({
      kind:
        step.type === "AUTHORIZATION"
          ? ("authorization" as const)
          : step.type === "AUTHORIZATION_REVERSAL"
            ? ("authorization_reversal" as const)
            : step.type === "CLEARING"
              ? ("clearing" as const)
              : step.type === "FINANCIAL_AUTHORIZATION"
                ? ("force_post" as const)
                : ("refund" as const),
      amountCents: step.amountCents,
      isFinal: step.type === "FINANCIAL_AUTHORIZATION",
      valueDate: "2026-09-10",
      providerEventId: ids[i] as string,
    }));
  }

  /**
   * Is this ordering safe to deliver to a shared ledger? See the header: a
   * prefix that is `terminallyClosed` while the full set still holds money
   * writes a permanent, wrong closure row. FINDING 1, already proved above.
   *
   * After migration 0028 this should never refuse anything — `terminallyClosed`
   * is monotone, so a terminal prefix implies a terminal set, and terminal
   * implies `H = 0`. The guard stays because it is cheap and because the cost of
   * being wrong about that is a permanent row in an append-only table on a
   * SHARED book, not a red test. `filteredForFinding1` is counted and asserted
   * below: if this ever starts refusing again, the count says so out loud
   * instead of the suite quietly delivering less.
   */
  function safeToDeliver(events: readonly CardEvent[], clock: AuthorizationClock): boolean {
    const full = holdState(events, clock);
    for (let n = 1; n <= events.length; n++) {
      if (!holdState(events.slice(0, n), clock).terminallyClosed) continue;
      return full.terminallyClosed && full.holdCents === 0n;
    }
    return true;
  }

  function lithicEvent(step: Step, token: string, created: string): TransactionEvent {
    const amount = Number(step.amountCents);
    return {
      token,
      type: step.type,
      created,
      amount,
      amounts: {
        cardholder: { amount, conversion_rate: "1.000000", currency: "USD" },
        merchant: { amount, currency: "USD" },
        settlement: step.type === "CLEARING" ? { amount, currency: "USD" } : null,
      },
      effective_polarity: step.type === "RETURN" ? "CREDIT" : "DEBIT",
    };
  }

  function txn(
    cardToken: string,
    authToken: string,
    events: TransactionEvent[],
    created: string,
  ): Transaction {
    return {
      token: authToken,
      account_token: "2742964f-478f-47ef-a4e9-852dc50d9c44",
      card_token: cardToken,
      created,
      updated: new Date().toISOString(),
      // The trap fields, populated and ignored: nothing in the posting path
      // reads either, and this suite would notice if that changed.
      status: "SETTLED",
      result: "APPROVED",
      amounts: {
        cardholder: { amount: 0, conversion_rate: "1.000000", currency: "USD" },
        hold: { amount: -1, currency: "USD" },
        merchant: { amount: 0, currency: "USD" },
        settlement: { amount: 0, currency: "USD" },
      },
      events,
    };
  }

  /** Deliver one ordering, one event per webhook, onto its own fresh card. */
  async function deliver(
    steps: readonly Step[],
    order: readonly number[],
    label: string,
  ): Promise<{ holdId: string; memoCents: bigint; fingerprint: string }> {
    cardSeq += 1;
    const card = await store.registerCard(
      {
        provider: "lithic",
        providerCardToken: `fuzz-card-${run}-${cardSeq}`,
        businessId,
        lastFour: "4242",
        nickname: `hold fuzzer ${label}`,
      },
      sql,
    );
    const authToken = `fuzz-auth-${run}-${label}`;
    const created = new Date().toISOString();

    let last: ApplyModule.HoldOutcome | null = null;
    for (const index of order) {
      const step = steps[index] as Step;
      const result = await apply.applyCardTransaction(
        txn(
          card.providerCardToken,
          authToken,
          [lithicEvent(step, `${authToken}-e${index}`, created)],
          created,
        ),
        { now: new Date() },
      );
      if (result.status !== "applied") throw new Error(`expected applied, got ${result.status}`);
      last = result;
    }
    if (last === null) throw new Error("no deliveries");

    return {
      holdId: last.holdId,
      memoCents: await store.memoHoldBalance(last.holdId, memoAccountId),
      fingerprint: fingerprint(last.state),
    };
  }

  it(
    "converges on the same hold, the same memo balance and no drift, in every order",
    async () => {
      const clock: AuthorizationClock = {
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
        now: new Date(),
      };
      const holdIds: string[] = [];

      for (let i = 0; i < DB_SETS; i++) {
        const seed = 9_000_000 + i;
        const steps = generateSteps(seed);
        const ids = steps.map((_, n) => `fuzz-auth-${run}-s${i}-e${n}`);
        const events = canonical(steps, ids);

        // Three orderings: as delivered, exactly reversed, and one shuffle.
        const identity = steps.map((_, n) => n);
        const rng = makeRng(seed ^ 0xabcd);
        const orders = [identity, [...identity].reverse(), rng.shuffle(identity)];

        if (!orders.every((o) => safeToDeliver(o.map((n) => events[n] as CardEvent), clock))) {
          filteredForFinding1 += 1;
          continue;
        }

        setsDelivered += 1;
        const results = [];
        for (let k = 0; k < orders.length; k++) {
          orderingsDelivered += 1;
          results.push(await deliver(steps, orders[k] as number[], `s${i}-o${k}`));
        }
        for (const r of results) holdIds.push(r.holdId);

        const first = results[0];
        if (first === undefined) throw new Error("no results");

        // THE CLAIM, at the database rather than in a pure function: identical
        // facts, different arrival orders, identical everything.
        for (const r of results) {
          expect({ fp: r.fingerprint, memo: r.memoCents }).toEqual({
            fp: first.fingerprint,
            memo: first.memoCents,
          });
        }

        // And the memo book agrees with the model's own answer for the set.
        expect(first.memoCents).toBe(holdState(events, clock).holdCents);
      }

      // Something was actually delivered — a filter that swallowed the whole
      // corpus would make every assertion above vacuous.
      expect(setsDelivered).toBeGreaterThan(0);
      expect(orderingsDelivered).toBeGreaterThanOrEqual(setsDelivered * 3);
      // And the refusal is visible rather than silent: every generated set was
      // either delivered or named as a FINDING 1 shape this suite will not write
      // into a shared append-only ledger.
      expect(setsDelivered + filteredForFinding1).toBe(DB_SETS);

      // Neither drift view has anything to say about the holds this test made...
      const mine = await sql<{ hold_id: string }[]>`
        SELECT hold_id FROM v_hold_drift WHERE hold_id = ANY(${holdIds}::uuid[])
        UNION ALL
        SELECT hold_id FROM v_hold_release_drift WHERE hold_id = ANY(${holdIds}::uuid[])`;
      expect(mine).toEqual([]);

      // ...nor about anything else in the book. Both halves of the invariant
      // that migration 0011 split in two: a LIVE hold equals the fold over its
      // events, and a RELEASED hold is withholding nothing.
      for (const view of ["v_hold_drift", "v_hold_release_drift"] as const) {
        const rows = await sql.unsafe(`SELECT * FROM ${view}`);
        expect({ view, rows: rows.length }).toEqual({ view, rows: 0 });
      }
    },
    600_000,
  );
});
