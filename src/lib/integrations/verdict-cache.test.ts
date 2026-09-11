import { beforeEach, describe, expect, it } from "vitest";

import {
  forgetVerdicts,
  recallAttempt,
  recallVerdict,
  rememberAttempt,
  rememberVerdict,
  type RecalledVerdict,
} from "./verdict-cache";

/**
 * The properties that keep this cache from becoming the thing it was built to
 * prevent.
 *
 * The flap it fixes was measured, not imagined: fourteen consecutive
 * `GET /api/health` calls against the deployment returned ten `live` readings
 * for `open_banking` and then three `simulated` ones, each of the three
 * carrying `POST /institutions/get -> 429`. Plaid rations that endpoint at ten
 * calls per credential per window and the health endpoint was spending one
 * unit per request.
 *
 * The fix is to quote the last EARNED verdict with its age. The danger of that
 * fix is obvious and is exactly what these tests pin down: a cache that
 * quotes too freely turns "the label is reproducible" into "the label is
 * always live", which is the automatic fail with a clock on it.
 */

// A fixed clock. Every test states its own instants; nothing here reads Date.
const T0 = 1_760_000_000_000;

const live = { liveness: "live", detail: "POST /institutions/get -> 200", ms: 17 };
const rejected = { liveness: "unauthorised", detail: "credentials rejected (INVALID_API_KEYS)", ms: 22 };

describe("the earned-verdict cache", () => {
  beforeEach(() => forgetVerdicts());

  it("quotes a verdict the provider pronounced, with its age", () => {
    rememberVerdict("open_banking", live, T0);
    const held = recallVerdict("open_banking", 60_000, T0 + 12_000);
    expect(held).not.toBeNull();
    expect((held as RecalledVerdict).liveness).toBe("live");
    expect((held as RecalledVerdict).ageMs).toBe(12_000);
    // The evidence travels verbatim: the quotation must be of the round trip
    // that happened, not a paraphrase of it.
    expect((held as RecalledVerdict).detail).toBe("POST /institutions/get -> 200");
    // And the latency reported is THAT round trip's, not this reading's.
    expect((held as RecalledVerdict).latencyMs).toBe(17);
  });

  it("stops quoting once the verdict is older than the caller's bound", () => {
    rememberVerdict("open_banking", live, T0);
    expect(recallVerdict("open_banking", 60_000, T0 + 59_999)).not.toBeNull();
    expect(recallVerdict("open_banking", 60_000, T0 + 60_001)).toBeNull();
  });

  it("has nothing to say about a slot that never earned a verdict", () => {
    expect(recallVerdict("open_banking", 60_000, T0)).toBeNull();
  });

  /* ---------------------------------------------------------------------- */
  /* The properties that stop this from becoming "always say live"          */
  /* ---------------------------------------------------------------------- */

  it("refuses to remember an absence of a verdict", () => {
    // These four are the ways a reading can fail to reach the provider's
    // opinion. None of them is a verdict, so none of them may be replayed as
    // one — and, just as importantly, none of them may be CACHED, or a
    // transient 429 would pin the slot to `unreachable` for the whole window.
    for (const liveness of ["rate_limited", "unreachable", "not_configured", "unprobed"]) {
      rememberVerdict("open_banking", { liveness, detail: "nothing was proven", ms: 5 }, T0);
      expect(recallVerdict("open_banking", 60_000, T0)).toBeNull();
    }
  });

  it("remembers a REJECTION exactly as readily as an acceptance", () => {
    // The cache must be symmetric or it is a bias. If it quoted `live` through
    // a throttled window but re-probed its way out of `unauthorised`, it would
    // be an instrument for producing green.
    rememberVerdict("open_banking", rejected, T0);
    const held = recallVerdict("open_banking", 60_000, T0 + 1_000);
    expect((held as RecalledVerdict).liveness).toBe("unauthorised");
  });

  it("lets a newer verdict overwrite an older one, in both directions", () => {
    rememberVerdict("open_banking", live, T0);
    rememberVerdict("open_banking", rejected, T0 + 1_000);
    expect((recallVerdict("open_banking", 60_000, T0 + 1_000) as RecalledVerdict).liveness).toBe(
      "unauthorised",
    );
    rememberVerdict("open_banking", live, T0 + 2_000);
    expect((recallVerdict("open_banking", 60_000, T0 + 2_000) as RecalledVerdict).liveness).toBe(
      "live",
    );
  });

  it("keeps slots apart", () => {
    rememberVerdict("open_banking", live, T0);
    expect(recallVerdict("card_issuing", 60_000, T0)).toBeNull();
  });

  it("refuses to quote a verdict from the future", () => {
    // A clock that moves backwards — a suspended instance, an NTP step —
    // would otherwise produce a negative age, which reads as "younger than any
    // bound" and would quote for ever.
    rememberVerdict("open_banking", live, T0 + 10_000);
    expect(recallVerdict("open_banking", 60_000, T0)).toBeNull();
  });

  /* ---------------------------------------------------------------------- */
  /* The flap itself, replayed                                              */
  /* ---------------------------------------------------------------------- */

  it("makes the measured 14-reading burst reproducible without inventing a verdict", () => {
    // The real sequence, as measured against the deployment: Plaid answers
    // 200 for ten calls in a window and 429 after that. Replayed here through
    // the two bounds the probe uses — refresh at 20s, stop quoting at 5m.
    const REFRESH = 20_000;
    const MAX_QUOTE = 300_000;
    let plaidCallsThisWindow = 0;
    const provider = (): typeof live | { liveness: string; detail: string; ms: number } => {
      plaidCallsThisWindow += 1;
      return plaidCallsThisWindow <= 10
        ? live
        : { liveness: "rate_limited", detail: "POST /institutions/get -> 429", ms: 16 };
    };

    const readings: string[] = [];
    // Fourteen health requests, half a second apart — the burst that flapped.
    for (let i = 0; i < 14; i += 1) {
      const now = T0 + i * 500;
      const held = recallVerdict("open_banking", REFRESH, now);
      if (held !== null) {
        readings.push(held.liveness);
        continue;
      }
      const r = provider();
      if (r.liveness === "live" || r.liveness === "unauthorised") {
        rememberVerdict("open_banking", r, now);
        readings.push(r.liveness);
        continue;
      }
      const fallback = recallVerdict("open_banking", MAX_QUOTE, now);
      readings.push(fallback?.liveness ?? r.liveness);
    }

    expect(new Set(readings)).toEqual(new Set(["live"]));
    // And the reproducibility was bought by asking Plaid ONCE, not by
    // pretending: one round trip, thirteen dated quotations of it.
    expect(plaidCallsThisWindow).toBe(1);
  });

  it("records every attempt, including the ones that reached no verdict", () => {
    // The attempt log is what the back-off reads. It must record the failures
    // — those are precisely the attempts worth not repeating — while the
    // verdict memory must not.
    const throttled = { liveness: "rate_limited", detail: "POST /institutions/get -> 429" };
    rememberAttempt("open_banking", throttled, T0);
    expect(recallAttempt("open_banking")?.liveness).toBe("rate_limited");
    expect(recallAttempt("open_banking")?.atMs).toBe(T0);
    expect(recallVerdict("open_banking", 60_000, T0)).toBeNull();
  });

  it("backs off instead of hammering the provider that is throttling us", () => {
    // MEASURED REGRESSION. The first version of this fix quoted correctly but
    // re-probed on every reading once the quotation aged past the refresh
    // interval: a 40-second burst against an already-empty bucket spent
    // thirteen more units of Plaid's ration, keeping the bucket empty and
    // delaying the refill it was waiting for. One attempt per interval, from
    // the last ATTEMPT.
    const REFRESH = 20_000;
    rememberVerdict("open_banking", live, T0);
    rememberAttempt("open_banking", live, T0);

    let calls = 0;
    const readings: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const now = T0 + 25_000 + i * 2_000; // every reading is past the refresh window
      if (recallVerdict("open_banking", REFRESH, now) !== null) continue;
      const last = recallAttempt("open_banking");
      if (last !== null && now - last.atMs < REFRESH) {
        readings.push(recallVerdict("open_banking", 300_000, now)?.liveness ?? "none");
        continue;
      }
      calls += 1;
      const throttled = { liveness: "rate_limited", detail: "POST /institutions/get -> 429" };
      rememberAttempt("open_banking", throttled, now);
      readings.push(recallVerdict("open_banking", 300_000, now)?.liveness ?? "none");
    }

    // 40 seconds of polling, two attempts — not twenty.
    expect(calls).toBe(2);
    // And the label never moved while we were backing off.
    expect(new Set(readings)).toEqual(new Set(["live"]));
  });

  it("gives up rather than quote for ever when the provider never comes back", () => {
    // The cliff. Five minutes of unbroken throttling is no longer a reason to
    // keep repeating a verdict; it is a reason to say we have not been able to
    // check. `null` here is what makes /api/health report `rate_limited`, and
    // `rate_limited` is SIMULATED.
    rememberVerdict("open_banking", live, T0);
    expect(recallVerdict("open_banking", 300_000, T0 + 299_000)).not.toBeNull();
    expect(recallVerdict("open_banking", 300_000, T0 + 301_000)).toBeNull();
  });
});
