/**
 * THE BOUNDS, ON A REAL SOCKET.
 *
 * ===========================================================================
 * WHY THIS TEST EXISTS
 * ===========================================================================
 *
 * `transport.test.ts` proves the refusals, and every one of them happens
 * before a packet is sent — which is why it needs no network. The two bounds
 * on the far side of the connect cannot be proved that way. They live
 * entirely in Node's socket and stream events, and the bug they were written
 * for was a DISAGREEMENT between those events: `res.destroy()` emits
 * `aborted` and `close` and never `end`, and `close` on the request cleared
 * the wall-clock backstop. An in-process fake would have had to reproduce
 * that behaviour to catch it, which means it would only have caught it if
 * somebody already knew.
 *
 * Measured before the fix, against the receiver below, with a 20 KiB body
 * echoed back as 40 KiB:
 *
 *   { settledAfterMs: null, outcome: "NEVER SETTLED" }   — 40s wall clock,
 *   on a transport whose documented timeout is 10s, still pending when the
 *   harness gave up. `deliverOnce` awaits this call in a sequential loop, so
 *   that is the whole outbound queue stopped by one customer's error page.
 *
 * After: 545 ms, `limit: "response_too_large"`, dead letter.
 *
 * Gated on `EVENTS_LIVE=1` for the reason `roundtrip.live.test.ts` gives:
 * `pnpm test` stays hermetic, and a suite that goes red when a third party
 * has a bad afternoon teaches people to ignore red suites.
 *
 *   EVENTS_LIVE=1 npx vitest run src/lib/events/bounds.live.test.ts
 *
 * THE RECEIVER is `https://httpbin.org/post` — the same one the round trip
 * uses, chosen for the same reason: it is a public HTTPS host, so it passes
 * our own SSRF fence (loopback would not, which is the point), and it echoes
 * the request body, which is how a caller can make the RESPONSE oversized by
 * choosing the REQUEST. Nothing about the assertions trusts it: they are
 * about our own byte count and our own clock.
 */

import { describe, expect, it } from "vitest";

import { postSigned, MAX_RESPONSE_BYTES, MAX_EXCERPT_CHARS } from "./transport";

const LIVE = process.env["EVENTS_LIVE"] === "1";
const ECHO = process.env["EVENTS_LIVE_RECEIVER"] ?? "https://httpbin.org/post";

const HEADERS = { "content-type": "application/json" };

/** Long enough to be unmistakable: five times the transport's own timeout. */
const WALL_MS = 50_000;

describe.runIf(LIVE)("bounds on a real socket", () => {
  it(
    "settles — and does not stall the worker — on a response over the read cap",
    async () => {
      // 20 KiB in, ~40 KiB echoed back: five times the cap, arriving in
      // chunks bigger than the cap, which is the case that used to hang.
      const body = JSON.stringify({ pad: "x".repeat(20_000) });

      const started = Date.now();
      const raced = await Promise.race([
        postSigned({ url: ECHO, body, headers: HEADERS }),
        new Promise<"STALLED">((r) => setTimeout(() => r("STALLED"), WALL_MS)),
      ]);
      const elapsed = Date.now() - started;

      // THE ASSERTION THE BUG WOULD HAVE FAILED. Everything below it is
      // detail; this line is the queue.
      expect(raced).not.toBe("STALLED");
      if (raced === "STALLED") return;

      expect(elapsed).toBeLessThan(WALL_MS);
      expect(raced.kind).toBe("response");
      if (raced.kind !== "response") return;

      // Terminal, and the reason names the number, because "too large" with
      // no number is a support ticket rather than a fix.
      expect(raced.limit).toBe("response_too_large");
      expect(raced.error).toContain(String(MAX_RESPONSE_BYTES));

      // The prefix is still evidence: the customer's own first line is the
      // most useful field on the delivery log, and truncation must not cost
      // it. Still inside the column's CHECK.
      expect(raced.excerpt).not.toBeNull();
      expect((raced.excerpt ?? "").length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
      expect(raced.resolvedIp).not.toBe("");
    },
    WALL_MS + 20_000,
  );

  it(
    "an ordinary response under the cap is unaffected — no limit, full body, 2xx",
    async () => {
      const outcome = await postSigned({
        url: ECHO,
        body: JSON.stringify({ pad: "y".repeat(200) }),
        headers: HEADERS,
      });

      expect(outcome.kind).toBe("response");
      if (outcome.kind !== "response") return;
      // `close` fires on every exchange including this one. If its handler
      // ordered ahead of `end`, this would come back as a `no_response` —
      // which is exactly the regression a backstop can introduce.
      expect(outcome.limit).toBeNull();
      expect(outcome.ok).toBe(true);
      expect(outcome.status).toBe(200);
      expect(outcome.error).toBeNull();
    },
    30_000,
  );

  it(
    "an ordinary timeout is still a RETRYABLE failure, not a dead letter",
    async () => {
      // The socket-level timeout must keep winning the race against the hard
      // deadline; if the deadline started catching ordinary slow endpoints,
      // every slow customer would dead-letter on attempt one.
      const outcome = await postSigned({
        url: "https://httpbin.org/delay/10",
        body: "{}",
        headers: HEADERS,
        timeoutMs: 1_000,
      });

      expect(outcome.kind).toBe("no_response");
      if (outcome.kind !== "no_response") return;
      expect(outcome.limit).toBeNull();
      expect(outcome.error).toMatch(/1000ms|socket hang up|closed/i);
      expect(outcome.durationMs).toBeLessThan(10_000);
    },
    30_000,
  );
});
