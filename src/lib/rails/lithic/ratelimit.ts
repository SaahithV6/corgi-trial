/**
 * Serial rate limiter for the Lithic sandbox.
 *
 * WHY THIS EXISTS
 * ---------------
 * Lithic rate-limits by resource *and* by HTTP method, and the sandbox
 * simulate endpoints are the tightest surface on the whole platform:
 *
 *   POST /v1/simulate/*   1 request / second
 *   POST /v1/cards        2 requests / second
 *   GET  (most resources) 15 requests / second
 *
 * A breach returns HTTP 429 with `retry-after: 1`. An auth-then-clearing pair
 * is two simulate writes, so it can never take less than a second; a fifty
 * transaction seed takes at least ~100s. That constraint is structural, not a
 * tuning problem — the only sane response is to serialise every simulate call
 * through one queue.
 *
 * WHAT "CORRECT UNDER CONCURRENT CALLERS" MEANS HERE
 * --------------------------------------------------
 * Callers arrive from unrelated async contexts (a seed script, a webhook
 * replay, a UI action) and must not be able to interleave their way past the
 * limit. The admission decision — "read the clock, decide whether to wait,
 * record the slot" — is therefore executed inside a single promise chain, so
 * exactly one caller is ever inside it. Without that serialisation, N callers
 * would each independently observe an empty window and all fire at once.
 *
 * Admissions are FIFO: the chain preserves arrival order, so a long queue
 * cannot starve an early caller.
 *
 * A rejected `fn` does not wedge the queue — the gate is chained on the
 * *admission*, not on the caller's work, and swallows rejections.
 *
 * The limit is on request *starts*, not completions. That matches how the
 * provider counts, and it means slow responses do not silently shrink the
 * effective rate.
 *
 * SCOPE: this is per-process, in-memory state. Under serverless fan-out each
 * instance gets its own limiter and the global rate is instances x limit. Run
 * seeding and backfills as a single long-lived process (see ./README.md).
 */

/** Milliseconds. */
type Millis = number;

export interface RateLimiterOptions {
  /** Maximum number of admissions per window. */
  limit: number;
  /** Window length. Defaults to 1000ms. */
  windowMs?: Millis;
  /**
   * Extra delay added when the limiter has to wait, to absorb clock skew
   * between this process and Lithic's counter. Defaults to 50ms.
   * Set to 0 in tests that assert exact timing.
   */
  safetyMarginMs?: Millis;
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => Millis;
  /** Injectable sleep, for tests. Defaults to `setTimeout`. */
  sleep?: (ms: Millis) => Promise<void>;
}

const defaultSleep = (ms: Millis): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const swallow = (): void => undefined;

export class RateLimiter {
  readonly limit: number;
  readonly windowMs: Millis;
  readonly safetyMarginMs: Millis;

  /** Timestamps of the admissions still inside the current window, oldest first. */
  private readonly admissions: Millis[] = [];
  /** The serialisation gate. Exactly one admission runs at a time. */
  private gate: Promise<void> = Promise.resolve();
  private waiting = 0;
  private admitted = 0;
  private readonly now: () => Millis;
  private readonly sleep: (ms: Millis) => Promise<void>;

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new RangeError(`RateLimiter limit must be a positive integer, got ${options.limit}`);
    }
    this.limit = options.limit;
    this.windowMs = options.windowMs ?? 1_000;
    this.safetyMarginMs = options.safetyMarginMs ?? 50;
    if (this.windowMs <= 0) {
      throw new RangeError(`RateLimiter windowMs must be > 0, got ${this.windowMs}`);
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Number of callers currently queued behind the limiter. */
  get queueDepth(): number {
    return this.waiting;
  }

  /** Total admissions granted since construction. Useful in tests and metrics. */
  get admittedCount(): number {
    return this.admitted;
  }

  /**
   * Wait until it is legal to issue one request, then resolve.
   *
   * Prefer `run()`. Use `acquire()` directly only when the call site needs the
   * slot before it can build the request.
   */
  acquire(): Promise<void> {
    this.waiting += 1;
    const ticket = this.gate.then(() => this.admit());
    // The gate advances on the admission alone and never on the caller's work,
    // so one slow or failing caller cannot block the queue.
    this.gate = ticket.then(swallow, swallow);
    return ticket.finally(() => {
      this.waiting -= 1;
    });
  }

  /** Run `fn` no sooner than the rate limit allows. Rejections propagate untouched. */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    return fn();
  }

  /**
   * Run every task, serialised through the limiter, preserving input order in
   * the result. Tasks are submitted eagerly so they queue in order; only the
   * rate limit paces them.
   */
  async runAll<T>(tasks: ReadonlyArray<() => Promise<T> | T>): Promise<T[]> {
    return Promise.all(tasks.map((task) => this.run(task)));
  }

  /**
   * The single critical section. Only ever entered by one caller at a time,
   * which is what makes the limiter correct under concurrency.
   */
  private async admit(): Promise<void> {
    for (;;) {
      const now = this.now();

      // Drop admissions that have aged out of the window.
      while (this.admissions.length > 0) {
        const oldest = this.admissions[0];
        if (oldest === undefined || now - oldest < this.windowMs) break;
        this.admissions.shift();
      }

      if (this.admissions.length < this.limit) {
        this.admissions.push(now);
        this.admitted += 1;
        return;
      }

      // Window is full: sleep until the oldest admission expires, then
      // re-check. Re-checking rather than trusting the computed deadline keeps
      // this correct if the timer fires early or the clock jumps.
      const oldest = this.admissions[0] ?? now;
      const waitMs = oldest + this.windowMs - now + this.safetyMarginMs;
      await this.sleep(waitMs > 0 ? waitMs : 1);
    }
  }
}

/**
 * `POST /v1/simulate/*` — 1 write per second in sandbox. Every simulate call in
 * `./client.ts` goes through this instance, and it is exported so a seed script
 * can share the same queue rather than opening a competing one.
 */
export const simulateLimiter = new RateLimiter({ limit: 1, windowMs: 1_000 });

/** `POST /v1/cards` — 2 writes per second in sandbox. */
export const cardWriteLimiter = new RateLimiter({ limit: 2, windowMs: 1_000 });

/**
 * Reads are documented at 15 RPS in sandbox. Held at 10 deliberately: the
 * headroom costs nothing and a 429 on a poll during a demo costs a lot.
 */
export const readLimiter = new RateLimiter({ limit: 10, windowMs: 1_000 });
