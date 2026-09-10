/**
 * Determinism primitives for the ACH simulator.
 *
 * The simulator's whole value is that an awkward case can be reproduced exactly
 * — the same webhook bodies, in the same order, with the same ids and the same
 * signature bytes, from the same seed. That is only true if NOTHING in the
 * engine reads `Date.now()` or `Math.random()`. Those two calls are therefore
 * confined to this file, behind two objects the engine is handed at
 * construction, and the engine imports neither global.
 *
 * A virtual clock also buys the thing wall-clock time cannot: "four days after
 * settlement" is `advance(days(4))` and costs a microsecond. A simulator that
 * makes you wait four days to see an R01 is a simulator nobody runs.
 */

/** Milliseconds in n days. The ACH return window is measured in days, so is this. */
export function days(n: number): number {
  return n * 24 * 60 * 60 * 1000;
}

export function hours(n: number): number {
  return n * 60 * 60 * 1000;
}

/**
 * The default epoch: 2026-01-05T09:00:00Z, a Monday morning. Fixed rather than
 * "now" so a golden test of the exact webhook bytes is possible.
 */
export const DEFAULT_EPOCH_MS = Date.UTC(2026, 0, 5, 9, 0, 0);

/**
 * A clock that only moves when you move it.
 *
 * Note there is no `tick()` on a timer and no `setTimeout` anywhere in this
 * package. Time passes because a test or an operator said so, which means a
 * scenario runs at the same speed in CI as in a demo and never races.
 */
export class VirtualClock {
  private ms: number;

  constructor(epochMs: number = DEFAULT_EPOCH_MS) {
    this.ms = epochMs;
  }

  nowMs(): number {
    return this.ms;
  }

  nowIso(): string {
    return new Date(this.ms).toISOString();
  }

  /** Unix SECONDS, which is what the Standard Webhooks timestamp header wants. */
  nowUnixSeconds(): number {
    return Math.floor(this.ms / 1000);
  }

  /** Move forward. Refuses to go backwards: a clock that rewinds is a bug source. */
  advance(byMs: number): number {
    if (!Number.isFinite(byMs) || byMs < 0) {
      throw new RangeError(`advance() needs a non-negative number of ms, got ${byMs}`);
    }
    this.ms += byMs;
    return this.ms;
  }

  advanceTo(absoluteMs: number): number {
    if (absoluteMs < this.ms) {
      throw new RangeError(
        `refusing to move the clock backwards: now=${this.ms}, target=${absoluteMs}`,
      );
    }
    this.ms = absoluteMs;
    return this.ms;
  }
}

/**
 * mulberry32 — a small, fast, well-distributed 32-bit PRNG.
 *
 * Chosen over `Math.random` for the obvious reason (seedable) and over a
 * crypto RNG for the same reason. It is not cryptographic and is never used for
 * anything that needs to be: the simulator's HMAC keys come from configuration,
 * not from here.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any seed string into the 32-bit integer mulberry32 wants. */
export function seedFrom(seed: string | number): number {
  if (typeof seed === 'number') return seed >>> 0;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic id minting.
 *
 * IDS ARE PART OF THE LABEL. Every id this simulator issues carries `_sim_`:
 * `ach_sim_...`, `evt_sim_...`. A simulated transfer therefore lives in a
 * different key space from a real Increase one (`ach_transfer_...`,
 * `event_...`), so a simulated row is distinguishable in the inbox, in the
 * ledger and in a log line by its PRIMARY DATA — not only by a flag some
 * consumer might forget to read. See ./README-level notes in
 * ../README.md ("Three layers, none of them a promise").
 */
export class IdMinter {
  private readonly random: () => number;
  private counter = 0;

  constructor(seed: string | number) {
    this.random = mulberry32(seedFrom(seed));
  }

  private token(): string {
    // 16 base-36 chars from two draws — enough to look like a provider id and
    // deterministic given the seed.
    const a = Math.floor(this.random() * 0xffffffff).toString(36);
    const b = Math.floor(this.random() * 0xffffffff).toString(36);
    return `${a}${b}`.padEnd(13, '0').slice(0, 13);
  }

  transferId(): string {
    this.counter += 1;
    return `ach_sim_${this.token()}`;
  }

  eventId(): string {
    this.counter += 1;
    return `evt_sim_${this.token()}`;
  }

  traceNumber(): string {
    this.counter += 1;
    return String(100000000000000 + Math.floor(this.random() * 899999999999999));
  }

  /** How many ids have been minted. Used by tests to prove determinism. */
  minted(): number {
    return this.counter;
  }
}
