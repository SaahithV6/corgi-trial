import { describe, expect, it } from 'vitest';

import { RateLimiter } from './ratelimit';

/**
 * Timing tests use a short window (60–100ms) rather than the real 1000ms so the
 * suite stays fast. The invariant under test is identical: never more than
 * `limit` admissions inside any `windowMs`.
 *
 * Assertions are on *lower* bounds with a small slack allowance. A machine
 * under load can always be slower than the limiter demands; it must never be
 * faster.
 */

const SLACK_MS = 8;

function startTimes(): { mark: () => number; elapsed: number[] } {
  const t0 = Date.now();
  const elapsed: number[] = [];
  return {
    mark: () => {
      const dt = Date.now() - t0;
      elapsed.push(dt);
      return dt;
    },
    elapsed,
  };
}

describe('RateLimiter', () => {
  it('paces serial calls to one per window', async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60, safetyMarginMs: 0 });
    const { mark, elapsed } = startTimes();

    for (let i = 0; i < 4; i += 1) {
      await limiter.run(() => {
        mark();
      });
    }

    expect(elapsed).toHaveLength(4);
    for (let i = 1; i < elapsed.length; i += 1) {
      const gap = elapsed[i]! - elapsed[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(60 - SLACK_MS);
    }
  });

  it('is correct under concurrent callers: no window ever exceeds the limit', async () => {
    // The failure this catches: without a serialised admission section, all 8
    // callers observe an empty window simultaneously and fire at once.
    const limiter = new RateLimiter({ limit: 2, windowMs: 60, safetyMarginMs: 0 });
    const { mark } = startTimes();

    const stamps = await Promise.all(
      Array.from({ length: 8 }, () => limiter.run(() => mark())),
    );

    expect(stamps).toHaveLength(8);
    const sorted = [...stamps].sort((a, b) => a - b);
    // Sliding window: the (limit+1)-th admission must be a full window after
    // the first one in its group.
    for (let i = 2; i < sorted.length; i += 1) {
      expect(sorted[i]! - sorted[i - 2]!).toBeGreaterThanOrEqual(60 - SLACK_MS);
    }
    expect(limiter.admittedCount).toBe(8);
  });

  it('admits in FIFO order so a queue cannot starve an early caller', async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 20, safetyMarginMs: 0 });
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        limiter.run(() => {
          order.push(i);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('does not wedge the queue when a task rejects', async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 10, safetyMarginMs: 0 });

    await expect(
      limiter.run(() => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    // The next caller must still be admitted.
    await expect(limiter.run(() => 'ok')).resolves.toBe('ok');
    expect(limiter.admittedCount).toBe(2);
  });

  it('rate-limits on request starts, not completions', async () => {
    // A slow task must not make the effective rate slower than configured.
    const limiter = new RateLimiter({ limit: 5, windowMs: 1_000, safetyMarginMs: 0 });
    const { mark, elapsed } = startTimes();

    await Promise.all([
      limiter.run(async () => {
        mark();
        await new Promise((r) => setTimeout(r, 40));
      }),
      limiter.run(() => {
        mark();
      }),
    ]);

    // Both start well inside the window despite the first taking 40ms.
    expect(elapsed[1]! - elapsed[0]!).toBeLessThan(40);
  });

  it('reports queue depth while callers are waiting', async () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 40, safetyMarginMs: 0 });
    const pending = [
      limiter.run(() => 1),
      limiter.run(() => 2),
      limiter.run(() => 3),
    ];
    expect(limiter.queueDepth).toBeGreaterThan(0);
    await expect(Promise.all(pending)).resolves.toEqual([1, 2, 3]);
    expect(limiter.queueDepth).toBe(0);
  });

  it('drives waiting through the injected clock and sleep', async () => {
    // Deterministic proof of the admission arithmetic, with no wall clock.
    let now = 0;
    const sleeps: number[] = [];
    const limiter = new RateLimiter({
      limit: 1,
      windowMs: 1_000,
      safetyMarginMs: 50,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await limiter.run(() => undefined);
    await limiter.run(() => undefined);
    await limiter.run(() => undefined);

    // Each subsequent admission waits one window plus the safety margin.
    expect(sleeps).toEqual([1_050, 1_050]);
    expect(now).toBe(2_100);
  });

  it('rejects a nonsensical configuration', () => {
    expect(() => new RateLimiter({ limit: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 1, windowMs: 0 })).toThrow(RangeError);
  });
});
