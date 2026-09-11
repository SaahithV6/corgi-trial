/**
 * WHAT THE LOCK COSTS, MEASURED ON THE REAL PATH.
 *
 * The race in `race.probe.test.ts` is closed by taking a lock before the
 * velocity sum is read and holding it to COMMIT. That turns three independent
 * round trips into one transaction of five — BEGIN, lock, read, insert, COMMIT
 * — and the question this file answers is what those extra trips cost against
 * the 6000 ms provider ceiling, where a timeout is a declined card.
 *
 * Three arms, all driving the SAME real code, all rolled back so nothing is
 * committed and no fixture card's daily limit is consumed:
 *
 *   unlocked   BEGIN, read, insert, ROLLBACK          — the transaction alone
 *   locked     BEGIN, lock, read, insert, ROLLBACK    — plus the lock
 *   contended  two `locked` arms on the SAME card at the same instant
 *
 * `unlocked` is here so the lock is priced against the transaction rather than
 * against today's three-autocommit-statement path; the difference between the
 * two arms IS the lock. The unlocked-and-untransacted baseline is not simulated
 * here at all — it is the 96 committed `source = 'provider'` rows in
 * `card_auth_decision`, printed below from `decision_latency_us`.
 *
 * Opt-in: `RUN_LOCK_BENCH=1`. Fixture card only, `source = 'harness'`, every
 * transaction rolled back.
 */

import { describe, expect, it } from "vitest";

import { parseAsaRequest } from "./asa";
import { decide } from "./decide";
import { asaPayload } from "./fixtures";
import { decideUnderLock } from "./store";
import { sql } from "@/lib/ledger/db";

const RUN = process.env.RUN_LOCK_BENCH === "1";

/** Fixture business "Live Fire — attack 7 (provider outage)", EIN 00-0000007. */
const CARD_TOKEN = "asa-default-mtx46zef-9dfdb680";
const N = 25;

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i] as number;
}

function summary(label: string, samplesUs: readonly number[]): string {
  const ms = [...samplesUs].map((u) => u / 1000).sort((a, b) => a - b);
  return (
    `${label.padEnd(11)} n=${ms.length}  ` +
    `p50=${pct(ms, 50).toFixed(1)}ms  p95=${pct(ms, 95).toFixed(1)}ms  ` +
    `min=${ms[0]?.toFixed(1)}ms  max=${ms.at(-1)?.toFixed(1)}ms`
  );
}

/** One authorisation down the real path, in a transaction, always rolled back. */
function one(tag: string, lock: boolean) {
  const request = parseAsaRequest(
    asaPayload({
      token: `bench-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cardToken: CARD_TOKEN,
      amountCents: 100,
      holdCents: 100,
      mcc: "5812",
    }),
  );
  return decideUnderLock({
    provider: "lithic",
    providerCardToken: CARD_TOKEN,
    source: "harness",
    requestId: null,
    request,
    judge: (lookup) => decide(request, lookup),
    lock,
    rollback: true,
  });
}

describe.runIf(RUN)("what the authorisation lock costs", () => {
  it("prices the locked decision path against the 6000 ms provider ceiling", async () => {
    // The committed baseline. Not simulated — the rows the provider wrote.
    const base = await sql<{ source: string; n: bigint; p50: number; p95: number }[]>`
      SELECT source,
             count(*)                                                            AS n,
             percentile_disc(0.50) WITHIN GROUP (ORDER BY decision_latency_us)   AS p50,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY decision_latency_us)   AS p95
        FROM card_auth_decision
       WHERE decision_latency_us IS NOT NULL
       GROUP BY source ORDER BY source`;

    // Warm the pool. A cold TLS handshake is not what is being measured.
    await Promise.all([one("warm", false), one("warm", false), one("warm", false)]);

    const unlocked: number[] = [];
    const locked: number[] = [];
    for (let i = 0; i < N; i += 1) unlocked.push((await one(`u${i}`, false)).totalUs);
    for (let i = 0; i < N; i += 1) locked.push((await one(`l${i}`, true)).totalUs);

    // Contended: both legs want the same card at the same instant, which is the
    // case the lock exists for and the only case where it makes anyone wait.
    const contended: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const pair = await Promise.all([one(`ca${i}`, true), one(`cb${i}`, true)]);
      contended.push(pair[0].totalUs, pair[1].totalUs);
    }

    /* eslint-disable no-console */
    console.log("\n[COMMITTED BASELINE] read+judge only, decision_latency_us:");
    for (const r of base) {
      console.log(
        `  ${r.source.padEnd(9)} n=${r.n}  p50=${(Number(r.p50) / 1000).toFixed(1)}ms  p95=${(Number(r.p95) / 1000).toFixed(1)}ms`,
      );
    }
    console.log("\n[MEASURED] full transaction, wall clock, rolled back:");
    console.log("  " + summary("unlocked", unlocked));
    console.log("  " + summary("locked", locked));
    console.log("  " + summary("contended", contended));
    const d50 = (pct([...locked].sort((a, b) => a - b), 50) - pct([...unlocked].sort((a, b) => a - b), 50)) / 1000;
    const d95 = (pct([...locked].sort((a, b) => a - b), 95) - pct([...unlocked].sort((a, b) => a - b), 95)) / 1000;
    console.log(`\n[THE LOCK ITSELF] p50 ${d50 >= 0 ? "+" : ""}${d50.toFixed(1)}ms   p95 ${d95 >= 0 ? "+" : ""}${d95.toFixed(1)}ms`);
    console.log(`[CEILING] provider timeout 6000ms; locked p95 uses ${((pct([...locked].sort((a, b) => a - b), 95) / 1000 / 6000) * 100).toFixed(1)}% of it\n`);
    /* eslint-enable no-console */

    // Nothing was committed by any arm of this bench.
    expect(locked.length).toBe(N);
    expect(pct([...locked].sort((a, b) => a - b), 95) / 1000).toBeLessThan(6000);
  }, 180_000);
});
