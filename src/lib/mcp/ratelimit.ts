/**
 * Per-token rate limiting: a token bucket, in memory, per process.
 *
 * A bucket rather than a fixed window because a fixed window lets a client
 * spend a full minute's budget in the last millisecond of one window and the
 * first of the next — 2x the nominal rate at the worst possible moment. The
 * bucket refills continuously, so the burst is exactly the capacity and never
 * twice it.
 *
 * HONEST LIMITATION. This state lives in the process. On Vercel each lambda
 * instance holds its own bucket, so N warm instances permit N times the
 * configured rate. That is a real gap and it is written here rather than
 * implied to be solved: the fix is a shared counter (Redis, or a Postgres
 * table with a bounded window), and it is not built because a shared counter
 * on the money path is a new failure mode and this limiter's job is to stop an
 * agent in a retry loop, not to stop an attacker. The controls that stop an
 * attacker are the token, the tenant scope, and the approval queue.
 *
 * Two budgets, not one:
 *
 *   - the per-token request budget, from the grant;
 *   - a much smaller WRITE budget, because "queue a payment" costs a human's
 *     attention. Sixty reads a minute is a busy agent; sixty queued payments a
 *     minute is a denial-of-service attack on the approver, and the approver
 *     is the control this whole design rests on.
 */

/** Queued payments per minute per token. Deliberately small. */
export const WRITE_LIMIT_PER_MINUTE = 6;

/**
 * Failed authentications per minute per client address. Bounds token guessing
 * without needing a shared store to be useful — a guesser has to find one
 * 32-byte secret at 20 tries a minute per address.
 */
export const UNAUTHENTICATED_LIMIT_PER_MINUTE = 20;

/** Buckets untouched for this long are dropped, so the Map cannot grow forever. */
const IDLE_EVICTION_MS = 10 * 60_000;

export interface RateDecision {
  readonly allowed: boolean;
  readonly limitPerMinute: number;
  /** Whole tokens left after this call. */
  readonly remaining: number;
  /** Seconds until one token is available. 0 when allowed. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepMs = 0;

  /**
   * Spend one token from `key`'s bucket.
   *
   * `nowMs` is a parameter rather than a call to `Date.now()` so the tests can
   * prove the refill curve instead of sleeping through it.
   */
  check(key: string, limitPerMinute: number, nowMs: number): RateDecision {
    this.sweep(nowMs);

    const perMs = limitPerMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: limitPerMinute, lastRefillMs: nowMs };

    const elapsed = Math.max(0, nowMs - bucket.lastRefillMs);
    bucket.tokens = Math.min(limitPerMinute, bucket.tokens + elapsed * perMs);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      const deficit = 1 - bucket.tokens;
      return {
        allowed: false,
        limitPerMinute,
        remaining: 0,
        // Always at least 1: a Retry-After of 0 invites an immediate retry,
        // which is the loop this exists to break.
        retryAfterSeconds: Math.max(1, Math.ceil(deficit / perMs / 1000)),
      };
    }

    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return {
      allowed: true,
      limitPerMinute,
      remaining: Math.floor(bucket.tokens),
      retryAfterSeconds: 0,
    };
  }

  /** Test seam and a way for an operator to reset a wedged process. */
  reset(): void {
    this.buckets.clear();
    this.lastSweepMs = 0;
  }

  size(): number {
    return this.buckets.size;
  }

  private sweep(nowMs: number): void {
    if (nowMs - this.lastSweepMs < IDLE_EVICTION_MS) return;
    this.lastSweepMs = nowMs;
    for (const [key, bucket] of this.buckets) {
      if (nowMs - bucket.lastRefillMs > IDLE_EVICTION_MS) this.buckets.delete(key);
    }
  }
}

/**
 * Best-effort client address for the unauthenticated budget.
 *
 * `x-forwarded-for` is trivially spoofable by anyone talking to this process
 * directly, so this is not a security boundary — it is a way to make a naive
 * guesser's life slow. When the platform sets `x-real-ip` (Vercel does) that
 * value is preferred because the edge writes it and a client cannot.
 */
export function clientKey(headers: Headers): string {
  const real = headers.get("x-real-ip");
  if (real !== null && real.trim() !== "") return real.trim();
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first !== undefined && first !== "") return first;
  return "unknown";
}
