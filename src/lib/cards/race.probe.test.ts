/**
 * THE ASA PATH UNDER HOSTILE CONCURRENCY.
 *
 * Sequencing on this build has been tested for ARRIVAL ORDER. This file tests
 * the other axis: two writers at the same instant.
 *
 * The claim under test is the card daily limit. `readControlsAndSpend()` sums
 * today's approved decisions, `decide()` compares `spend + amount > limit`, and
 * `startDecisionAppend()` writes the row. Those are three steps with nothing
 * holding the sum still between them, so two authorisations that arrive
 * together both read the PRE-state, both find room, and both approve.
 *
 * Opt-in: `RUN_RACE_PROBES=1`. It writes `card_auth_decision` rows with
 * `source = 'harness'` on a FIXTURE card, which is the lane that column exists
 * to keep separate — the velocity query sums within one source, so this can
 * never eat a real card's limit.
 */

import { describe, expect, it } from "vitest";

import { replayAuthorization } from "./harness";
import { sql } from "@/lib/ledger/db";

const RUN = process.env.RUN_RACE_PROBES === "1";

/** Fixture business "Live Fire — attack 7 (provider outage)", EIN 00-0000007. */
const CARD_TOKEN = "asa-default-mtx46zef-9dfdb680";

type Velocity = { day_cents: bigint; daily_limit_cents: bigint };

async function velocity(): Promise<Velocity> {
  const [row] = await sql<Velocity[]>`
    SELECT COALESCE(SUM(d.amount_cents) FILTER (
             WHERE d.outcome = 'approve'
               AND d.source = 'harness'
               AND book_date(d.decided_at) = book_date(now())
           ), 0)::bigint AS day_cents,
           MAX(cc.daily_limit_cents)     AS daily_limit_cents
      FROM card c
      JOIN v_card_control_current cc ON cc.card_id = c.id
      LEFT JOIN card_auth_decision d ON d.card_id = c.id
     WHERE c.provider = 'lithic' AND c.provider_card_token = ${CARD_TOKEN}`;
  return row as Velocity;
}

/** One authorisation down the real path. MCC 5812 — 5542 is blocked here. */
function one(tag: string, amountCents: bigint) {
  return replayAuthorization({
    overrides: {
      token: `race-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cardToken: CARD_TOKEN,
      amountCents: Number(amountCents),
      holdCents: Number(amountCents),
      mcc: "5812",
    },
  });
}

describe.runIf(RUN)("ASA path — two authorisations at the same instant", () => {
  it("both read the pre-state and both approve past the daily limit", async () => {
    // Warm the pool: a cold TLS handshake costs more than the 600 ms control
    // read budget and turns the probe into a `control_store_unavailable` test.
    await Promise.all([velocity(), velocity(), velocity()]);

    const limit = BigInt((await velocity()).daily_limit_cents);
    // Per-transaction limit caps each leg, so the pair can only exceed the
    // daily limit once the headroom is under 2x the per-transaction limit.
    // Seed that headroom SEQUENTIALLY, through the same real path — each of
    // these is an ordinary, uncontended approval.
    const PER_TXN = 2500n;
    const SEED = 2000n;
    while (limit - BigInt((await velocity()).day_cents) >= 2n * PER_TXN) {
      const seeded = await one("seed", SEED);
      // eslint-disable-next-line no-console
      console.log(
        `[SEED ] ${seeded.verdict.outcome} ${seeded.verdict.rule} amount=${SEED} row=${seeded.decisionId}`,
      );
      if (seeded.verdict.outcome !== "approve") break;
    }

    const spent = BigInt((await velocity()).day_cents);
    const headroom = limit - spent;
    const amount = headroom / 2n + 100n;

    // eslint-disable-next-line no-console
    console.log(
      `[SETUP] card ${CARD_TOKEN}  daily_limit=${limit}  spent_today=${spent}  headroom=${headroom}  each leg=${amount}`,
    );
    expect(amount).toBeLessThanOrEqual(headroom); // each leg affordable alone
    expect(amount * 2n).toBeGreaterThan(headroom); // the pair is not

    const started = process.hrtime.bigint();
    const [a, b] = await Promise.all([one("a", amount), one("b", amount)]);
    const wallUs = Number((process.hrtime.bigint() - started) / 1000n);

    const after = await velocity();

    // eslint-disable-next-line no-console
    console.log(
      [
        `[LEG A] outcome=${a.verdict.outcome} rule=${a.verdict.rule} spend_read=${a.lookup.status === "read" ? a.lookup.spend.dayCents : "n/a"} latency_us=${a.decisionLatencyUs} row=${a.decisionId}`,
        `[LEG B] outcome=${b.verdict.outcome} rule=${b.verdict.rule} spend_read=${b.lookup.status === "read" ? b.lookup.spend.dayCents : "n/a"} latency_us=${b.decisionLatencyUs} row=${b.decisionId}`,
        `[AFTER] spent_today=${after.day_cents}  daily_limit=${after.daily_limit_cents}  over_by=${BigInt(after.day_cents) - limit}`,
        `[WALL ] both legs, concurrent: ${wallUs} us`,
      ].join("\n"),
    );

    expect(BigInt(after.day_cents)).toBeLessThanOrEqual(limit);
  }, 60_000);
});
