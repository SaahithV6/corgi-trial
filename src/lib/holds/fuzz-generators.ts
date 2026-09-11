/**
 * Adversarial input for `holdState()`: valid event SETS, every ordering of
 * them, and a shrinker for whatever comes back broken.
 *
 * `model.ts` makes a strong claim — `H` is a pure function of an event set,
 * built out of Σ, ∃, `max` and one clock comparison, all of which are invariant
 * under permutation, so "the settlement arrived before its authorisation" is not
 * a case to handle. `model.test.ts` supports that claim with fifteen hand-picked
 * rows. Hand-picked rows prove the rows.
 *
 * This module exists so the claim can be attacked instead: generate sets nobody
 * chose, deliver them in every order that exists, and see whether the answer
 * moves. Everything here is DETERMINISTIC FROM A SEED — the seed travels with
 * the set and is printed in every failure message, so any counterexample this
 * finds can be reproduced by anyone with the number.
 *
 * Nothing in this file imports the database, a clock, or any RUNTIME value from
 * outside `./model`. It is input, not opinion: it does not know what the right
 * answer is and has no way to express one. `fuzz.test.ts` owns the properties.
 * (Section 7 takes a TYPE-ONLY import of Lithic's payload shapes, which is
 * erased at compile time and adds no runtime dependency on the rail adapter.)
 *
 * ─── Section 7 exists because the fuzzer was attacking the wrong function ────
 *
 * Everything above section 7 generates CANONICAL event sets and hands them to
 * `holdState()`. That is the function the model's argument is about, and 6.25M
 * orderings say the argument holds.
 *
 * It is not the function the bug was in. On 2026-09-11 an `AUTHORIZATION_ADVICE`
 * of **0** was stored as an `incremental_authorization` of **7340**, because
 * `deriveCardEvents()` converts an advice's ABSOLUTE amount into a delta against
 * a running total that had gone to -7340 — and `deriveCardEvents()` had never
 * been fuzzed at all. It could not have been, from here: an advice is a Lithic
 * PAYLOAD concept and `CardEventKind` has no member for it, so no set this file
 * generated could ever contain one. The live-book property in `fuzz.test.ts`
 * makes the same exclusion explicitly, in `DB_STEPS`, with a comment saying why.
 *
 * **That gap is the finding, and section 7 closes it.** `generateLithicPayload()`
 * produces whole `card_transaction.updated` bodies — advices included, reversals
 * weighted heavily enough to drive the running total below zero — so the
 * absolute→delta conversion has a corpus to be attacked on.
 *
 * Money is `bigint` cents throughout, like everywhere else.
 */

import type {
  Transaction,
  TransactionEvent,
  TransactionEventType,
} from "@/lib/rails/lithic/types";

import type { AuthorizationClock, CardEvent, CardEventKind } from "./model";

// ---------------------------------------------------------------------------
// 1. The PRNG
// ---------------------------------------------------------------------------

/**
 * mulberry32. Thirty-two bits of state, one multiply-xor-shift round, and it is
 * here rather than in a dependency because a fuzzer whose randomness comes from
 * `Math.random()` cannot print a seed, and a counterexample nobody can reproduce
 * is a rumour rather than a bug report.
 */
export interface Rng {
  /** The seed this stream started from. Carried so failures can name it. */
  readonly seed: number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, bound). */
  int(bound: number): number;
  /** Uniform integer in [lo, hi], inclusive. */
  between(lo: number, hi: number): number;
  /** True with probability `p` (default one half). */
  bool(p?: number): boolean;
  /** One member of a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Fisher–Yates, on a copy. */
  shuffle<T>(items: readonly T[]): T[];
}

export function makeRng(seed: number): Rng {
  // Keep the state in an unsigned 32-bit lane. A seed of 0 is legal and does
  // not degenerate, because the increment below is odd.
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  const int = (bound: number): number => {
    if (bound <= 0) return 0;
    return Math.floor(next() * bound);
  };

  const rng: Rng = {
    seed,
    next,
    int,
    between: (lo, hi) => lo + int(hi - lo + 1),
    bool: (p = 0.5) => next() < p,
    pick: <T,>(items: readonly T[]): T => {
      const chosen = items[int(items.length)];
      if (chosen === undefined) throw new Error("pick() on an empty array");
      return chosen;
    },
    shuffle: <T,>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        const a = out[i] as T;
        const b = out[j] as T;
        out[i] = b;
        out[j] = a;
      }
      return out;
    },
  };

  return rng;
}

// ---------------------------------------------------------------------------
// 2. The vocabulary
// ---------------------------------------------------------------------------

/**
 * Every kind in `card_event_kind`, weighted the way a real card's life is
 * weighted rather than uniformly: an authorisation is common, an explicit
 * `close` is rare, and a set full of nothing but closes exercises one line of
 * the model a thousand times and the rest of it never.
 *
 * The weights are a search strategy, not an assertion. Every kind is reachable
 * and `ALL_KINDS` below is used unweighted by the exhaustive generator.
 */
const WEIGHTED_KINDS: readonly (readonly [CardEventKind, number])[] = [
  ["authorization", 22],
  ["incremental_authorization", 14],
  ["authorization_reversal", 14],
  ["clearing", 26],
  ["force_post", 8],
  ["refund", 8],
  ["expiry", 4],
  ["close", 4],
];

export const ALL_KINDS: readonly CardEventKind[] = WEIGHTED_KINDS.map(([kind]) => kind);

const WEIGHT_TOTAL = WEIGHTED_KINDS.reduce((sum, [, w]) => sum + w, 0);

function weightedKind(rng: Rng): CardEventKind {
  let roll = rng.int(WEIGHT_TOTAL);
  for (const [kind, weight] of WEIGHTED_KINDS) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return "authorization";
}

/**
 * Amounts the arithmetic is known to care about, plus a uniform tail.
 *
 * `0` is in here on purpose: a zero-amount authorisation makes `A = 0` without
 * making `E` empty, which is the exact input the `count > 0` guard in
 * `closed(E)` exists for. `5000` and `7340` are the measured fuel-pump pair from
 * DECISIONS 006. The rest is there so the generator is not only ever testing
 * numbers a human already thought of.
 */
const INTERESTING_CENTS: readonly bigint[] = [
  0n,
  1n,
  99n,
  100n,
  1_000n,
  3_000n,
  5_000n,
  6_000n,
  7_340n,
  10_000n,
  500_000_00n,
  // Far past anything `number` can hold exactly, because the whole system
  // claims bigint and a fuzzer that never leaves the safe-integer range never
  // tests that claim.
  9_007_199_254_740_993n,
];

function amount(rng: Rng): bigint {
  if (rng.bool(0.55)) return rng.pick(INTERESTING_CENTS);
  return BigInt(rng.between(0, 250_000));
}

const VALUE_DATES: readonly string[] = [
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
  "2026-09-11",
];

// ---------------------------------------------------------------------------
// 3. The sets
// ---------------------------------------------------------------------------

export interface GeneratedSet {
  /** Reproduce this exact set with `generateEventSet(seed, options)`. */
  readonly seed: number;
  readonly events: readonly CardEvent[];
  readonly clock: AuthorizationClock;
  /** True when the clock was generated already past `expiresAt`. */
  readonly clockExpired: boolean;
}

export interface GenerateOptions {
  readonly minSize?: number;
  readonly maxSize?: number;
  /** Restrict the vocabulary. Defaults to every kind, weighted. */
  readonly kinds?: readonly CardEventKind[];
  /** Probability that any one event carries `isFinal`. */
  readonly finalProbability?: number;
  /** Probability that the clock is generated already expired. */
  readonly expiredProbability?: number;
  /**
   * Probability that an event is an EXACT redelivery of an earlier one — same
   * `providerEventId`, same everything. This is the only duplicate the database
   * can produce, because `UNIQUE (auth_id, provider_event_id)` means a second
   * row under an id that is already present never lands.
   */
  readonly duplicateProbability?: number;
}

const FAR_FUTURE = new Date("2099-01-01T00:00:00Z");
const NOW = new Date("2026-09-10T12:00:00Z");
const PAST = new Date("2026-09-01T00:00:00Z");

/**
 * One valid event set, deterministically, from a seed.
 *
 * "Valid" means: every amount is a non-negative magnitude (the column is
 * `CHECK (amount_cents >= 0)` and the kind carries the direction), every
 * `providerEventId` that repeats repeats an event that is otherwise identical,
 * and nothing else. In particular the generator does NOT try to produce
 * lifecycles that make narrative sense — a reversal with no authorisation, three
 * closes, a clearing for nine trillion cents are all fair game, because the
 * model claims to be total over the set and a generator that only produces
 * sensible histories is a generator that only tests the sensible half.
 */
export function generateEventSet(seed: number, options: GenerateOptions = {}): GeneratedSet {
  const rng = makeRng(seed);
  const minSize = options.minSize ?? 1;
  const maxSize = options.maxSize ?? 6;
  const finalProbability = options.finalProbability ?? 0.18;
  const expiredProbability = options.expiredProbability ?? 0.15;
  const duplicateProbability = options.duplicateProbability ?? 0.08;
  const kinds = options.kinds;

  const size = rng.between(minSize, maxSize);
  const events: CardEvent[] = [];

  for (let i = 0; i < size; i++) {
    // An exact redelivery of something already in the list. Same id, same
    // contents — the only duplicate the unique index can let through is none at
    // all, so this is what "the webhook fired twice" actually looks like.
    if (events.length > 0 && rng.bool(duplicateProbability)) {
      events.push(rng.pick(events));
      continue;
    }

    const kind = kinds === undefined ? weightedKind(rng) : rng.pick(kinds);
    events.push({
      kind,
      amountCents: amount(rng),
      isFinal: rng.bool(finalProbability),
      valueDate: rng.pick(VALUE_DATES),
      providerEventId: `s${seed}-e${i}`,
    });
  }

  const clockExpired = rng.bool(expiredProbability);
  return {
    seed,
    events,
    clock: clockExpired
      ? { expiresAt: PAST, now: NOW }
      : { expiresAt: FAR_FUTURE, now: NOW },
    clockExpired,
  };
}

// ---------------------------------------------------------------------------
// 4. Orderings
// ---------------------------------------------------------------------------

export function factorial(n: number): number {
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

/** Every ordering. Only ever called on sets small enough to mean it. */
export function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const head = items[i] as T;
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) out.push([head, ...tail]);
  }
  return out;
}

/**
 * The orderings to actually test: all of them when `n!` is affordable, and a
 * seeded random sample when it is not.
 *
 * The sample always includes the identity and the exact reverse, because those
 * two are the orderings a human would have written by hand and the ones the
 * brief names ("the settlement webhook can arrive before the auth it belongs
 * to"). Everything after them is the fuzzer's own idea.
 */
export function orderings<T>(
  items: readonly T[],
  rng: Rng,
  budget: number,
): { readonly orders: T[][]; readonly exhaustive: boolean } {
  const total = factorial(items.length);
  if (total <= budget) return { orders: permutations(items), exhaustive: true };

  const orders: T[][] = [[...items], [...items].reverse()];
  for (let i = orders.length; i < budget; i++) orders.push(rng.shuffle(items));
  return { orders, exhaustive: false };
}

// ---------------------------------------------------------------------------
// 5. Shrinking
// ---------------------------------------------------------------------------

/**
 * The smallest failing set this can get to by deleting and simplifying.
 *
 * Vitest ships no shrinker, so this is the loop the brief asks for: drop each
 * event in turn and keep the drop if the property still fails, then try to
 * simplify what survives (amount down to a small canonical value, `isFinal`
 * off), then go round again until a whole pass changes nothing.
 *
 * `stillFails` must be a pure predicate on the candidate. It is called O(n²)
 * times on a set of n events, which is nothing next to the value of handing a
 * reader three events instead of forty.
 */
export function shrink(
  events: readonly CardEvent[],
  stillFails: (candidate: readonly CardEvent[]) => boolean,
): readonly CardEvent[] {
  if (!stillFails(events)) return events;

  let best = [...events];
  let improved = true;

  while (improved) {
    improved = false;

    // Pass one: delete. Largest win per attempt, so it goes first.
    for (let i = 0; i < best.length; i++) {
      const candidate = [...best.slice(0, i), ...best.slice(i + 1)];
      if (stillFails(candidate)) {
        best = candidate;
        improved = true;
        i -= 1;
      }
    }

    // Pass two: simplify what is left, one field of one event at a time.
    for (let i = 0; i < best.length; i++) {
      const event = best[i] as CardEvent;

      for (const smaller of [0n, 1n, 100n, event.amountCents / 2n]) {
        if (smaller >= event.amountCents) continue;
        const candidate = best.map((e, j) =>
          j === i ? { ...e, amountCents: smaller } : e,
        );
        if (stillFails(candidate)) {
          best = candidate;
          improved = true;
          break;
        }
      }

      const simplified = best[i] as CardEvent;
      if (simplified.isFinal) {
        const candidate = best.map((e, j) => (j === i ? { ...e, isFinal: false } : e));
        if (stillFails(candidate)) {
          best = candidate;
          improved = true;
        }
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// 6. Rendering, so a failure message is readable
// ---------------------------------------------------------------------------

/** One event, on one line, in the vocabulary the model uses. */
export function describeEvent(event: CardEvent): string {
  return `${event.kind} ${event.amountCents}${event.isFinal ? " FINAL" : ""} (${event.providerEventId})`;
}

/** A whole set, for an assertion message. */
export function describeEvents(events: readonly CardEvent[]): string {
  if (events.length === 0) return "{}";
  return `{\n    ${events.map(describeEvent).join(",\n    ")}\n  }`;
}

/**
 * The block that goes in a failure message: what broke, on which set, from
 * which seed, and how to get it back.
 */
export function counterexample(args: {
  readonly property: string;
  readonly seed: number;
  readonly clock: AuthorizationClock;
  readonly original: readonly CardEvent[];
  readonly shrunk: readonly CardEvent[];
  readonly detail?: string;
}): string {
  const lines = [
    `PROPERTY VIOLATED: ${args.property}`,
    `  seed: ${args.seed}  (generateEventSet(${args.seed}, ...))`,
    `  clock: now=${args.clock.now.toISOString()} expiresAt=${args.clock.expiresAt.toISOString()}`,
    `  original (${args.original.length} events): ${describeEvents(args.original)}`,
    `  shrunk (${args.shrunk.length} events): ${describeEvents(args.shrunk)}`,
  ];
  if (args.detail !== undefined) lines.push(`  detail: ${args.detail}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 7. Lithic payloads — the layer the advice bug actually lived in
// ---------------------------------------------------------------------------

/**
 * The step types this generator draws from.
 *
 * `AUTHORIZATION_ADVICE` is the whole reason the section exists, and the
 * reversals are weighted heavily on purpose: the defect only appears once the
 * running authorised total inside ONE payload has gone below zero, which needs
 * reversals that outrun their authorisations. A uniform draw reaches that state
 * rarely enough to make the corpus a formality, so the weights are a search
 * strategy — `assertReachedOverReversal` in `fuzz.test.ts` is what turns the
 * strategy into a measured claim rather than a hope.
 */
const WEIGHTED_STEPS: readonly (readonly [TransactionEventType, number])[] = [
  ["AUTHORIZATION", 20],
  ["AUTHORIZATION_REVERSAL", 26],
  ["AUTHORIZATION_ADVICE", 22],
  ["CLEARING", 16],
  ["FINANCIAL_AUTHORIZATION", 6],
  ["AUTHORIZATION_EXPIRY", 4],
  ["RETURN", 3],
  // Recognised and deliberately dropped by `canonicalKind`. In the corpus so
  // that a payload the adapter must IGNORE sits between ones it must not.
  ["BALANCE_INQUIRY", 3],
];

const STEP_WEIGHT_TOTAL = WEIGHTED_STEPS.reduce((sum, [, w]) => sum + w, 0);

function weightedStep(rng: Rng): TransactionEventType {
  let roll = rng.int(STEP_WEIGHT_TOTAL);
  for (const [step, weight] of WEIGHTED_STEPS) {
    roll -= weight;
    if (roll < 0) return step;
  }
  return "AUTHORIZATION";
}

/**
 * Amounts as Lithic sends them: `number`, not `bigint`.
 *
 * Capped well inside the safe-integer range on purpose — `eventMagnitude()`
 * THROWS on an unsafe integer, and a generator that tripped that would be
 * testing the guard rather than the conversion. `0` is in the list because an
 * advice of zero is exactly the live defect, and the fuel-pump pair (5000,
 * 7340) is here for the same reason it is in `INTERESTING_CENTS`.
 */
const INTERESTING_LITHIC_AMOUNTS: readonly number[] = [
  0, 1, 100, 1_000, 2_340, 5_000, 6_000, 7_340, 9_000, 12_340,
];

function lithicAmount(rng: Rng): number {
  if (rng.bool(0.6)) return rng.pick(INTERESTING_LITHIC_AMOUNTS);
  return rng.between(0, 25_000);
}

export interface GeneratedPayload {
  /** Reproduce this exact payload with `generateLithicPayload(seed)`. */
  readonly seed: number;
  readonly txn: Transaction;
  /** `token` → the step type it was generated as. For the properties. */
  readonly steps: ReadonlyMap<string, TransactionEventType>;
  /** `token` → the magnitude the payload carries, as a bigint. */
  readonly magnitudes: ReadonlyMap<string, bigint>;
  /** Tokens the payload marks as REFUSED by the network. */
  readonly refused: readonly string[];
}

export interface GeneratePayloadOptions {
  readonly minEvents?: number;
  readonly maxEvents?: number;
  /** Probability that any one step carries a non-APPROVED `result`. */
  readonly refusalProbability?: number;
  /** Probability that a step is an exact re-listing of an earlier token. */
  readonly duplicateProbability?: number;
}

const REFUSALS: readonly string[] = [
  "DECLINED",
  "ACCOUNT_DAILY_SPEND_LIMIT_EXCEEDED",
  "INSUFFICIENT_FUNDS",
  "CARD_PAUSED",
];

/**
 * One `card_transaction.updated` body, deterministically, from a seed.
 *
 * "Valid" here means what it means in section 3: shaped the way Lithic shapes
 * it, NOT narratively sensible. A reversal with no authorisation in front of
 * it, three advices in a row, an expiry followed by a clearing — all fair game,
 * because `deriveCardEvents()` claims to be total over a payload and a
 * generator that only produces well-behaved transactions only tests the
 * well-behaved half. That is how the advice-of-zero shape got to production:
 * nobody had written it down, so nobody had tried it.
 *
 * `created` strictly increases across the array, one second apart, so the
 * adapter's `created` sort is a fixed order rather than a tie-break nobody can
 * reproduce. Lithic delivers chronologically; this matches it.
 */
export function generateLithicPayload(
  seed: number,
  options: GeneratePayloadOptions = {},
): GeneratedPayload {
  const rng = makeRng(seed);
  const minEvents = options.minEvents ?? 1;
  const maxEvents = options.maxEvents ?? 7;
  const refusalProbability = options.refusalProbability ?? 0.12;
  const duplicateProbability = options.duplicateProbability ?? 0.08;

  const size = rng.between(minEvents, maxEvents);
  const events: TransactionEvent[] = [];
  const steps = new Map<string, TransactionEventType>();
  const magnitudes = new Map<string, bigint>();
  const refused: string[] = [];
  const base = Date.parse("2026-09-10T22:35:00Z");

  for (let i = 0; i < size; i++) {
    // The redelivery Lithic can actually produce: the same token listed twice
    // in one array. `deriveCardEvents()` drops the second on its own `seen`
    // set, before the database's UNIQUE index ever sees it.
    if (events.length > 0 && rng.bool(duplicateProbability)) {
      const repeat = rng.pick(events);
      events.push({ ...repeat });
      continue;
    }

    const type = weightedStep(rng);
    const amount = lithicAmount(rng);
    const token = `p${seed}-e${i}`;
    const isRefused = rng.bool(refusalProbability);

    const event: TransactionEvent = {
      token,
      type,
      created: new Date(base + i * 1_000).toISOString(),
      amount,
      amounts: {
        cardholder: { amount, conversion_rate: "1.000000", currency: "USD" },
        merchant: { amount, currency: "USD" },
        // Only a clearing carries a settlement figure, which is the precedence
        // `eventMagnitude()` reads. Everything else falls back to `amount`.
        settlement: type === "CLEARING" ? { amount, currency: "USD" } : null,
      },
      effective_polarity: type === "RETURN" ? "CREDIT" : "DEBIT",
      // `exactOptionalPropertyTypes` is on, so the refusal string is narrowed
      // here rather than allowed to widen to `| undefined`. Every generated
      // step carries a verdict; `isRefused(result)` in `lithic-events.ts` is
      // what decides whether it counts as one.
      result: (isRefused ? rng.pick(REFUSALS) : "APPROVED") as NonNullable<
        TransactionEvent["result"]
      >,
    };

    events.push(event);
    steps.set(token, type);
    magnitudes.set(token, BigInt(Math.abs(amount)));
    if (isRefused) refused.push(token);
  }

  return {
    seed,
    steps,
    magnitudes,
    refused,
    txn: {
      token: `fuzz-txn-${seed}`,
      account_token: "2742964f-478f-47ef-a4e9-852dc50d9c44",
      card_token: `fuzz-card-${seed}`,
      created: new Date(base).toISOString(),
      updated: new Date(base + size * 1_000).toISOString(),
      // The two trap fields, populated with nonsense on purpose: nothing in
      // `deriveCardEvents()` may read either, and this corpus would notice.
      status: "SETTLED",
      result: "APPROVED",
      amounts: {
        cardholder: { amount: 0, conversion_rate: "1.000000", currency: "USD" },
        hold: { amount: -1, currency: "USD" },
        merchant: { amount: 0, currency: "USD" },
        settlement: { amount: 0, currency: "USD" },
      },
      events,
    },
  };
}

/** One Lithic step, on one line, for a failure message. */
export function describeStep(event: TransactionEvent): string {
  const verdict = event.result === undefined || event.result === "APPROVED" ? "" : ` ${event.result}`;
  return `${event.type} ${event.amount}${verdict} (${event.token})`;
}

/** A whole payload, for an assertion message. */
export function describePayload(txn: Transaction): string {
  const events = txn.events ?? [];
  if (events.length === 0) return "{}";
  return `{\n    ${events.map(describeStep).join(",\n    ")}\n  }`;
}
