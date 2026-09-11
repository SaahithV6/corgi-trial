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

import { parseAsaRequest } from "./asa";
import { decide } from "./decide";
import { asaPayload } from "./fixtures";
import { replayAuthorization } from "./harness";
import { decideUnderLock } from "./store";
import { sql } from "@/lib/ledger/db";

const RUN = process.env.RUN_RACE_PROBES === "1";

/** Fixture business "Live Fire — attack 7 (provider outage)", EIN 00-0000007. */
const CARD_TOKEN = "asa-default-mtx46zef-9dfdb680";

/**
 * A SECOND card on the same fixture business, same controls ($100.00 daily,
 * $25.00 per transaction), untouched today. The first card is where the race
 * was demonstrated and it is STILL $2.00 over its $100.00 limit — that row is
 * the "before" and it is not re-runnable, because a card already past its limit
 * has no headroom left to race for. So the locked path is proved on this one.
 */
const CARD_TOKEN_LOCKED = "asa-default-mtx4764d-84cb15d0";

type Velocity = { day_cents: bigint; daily_limit_cents: bigint };

async function velocity(token: string = CARD_TOKEN): Promise<Velocity> {
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
     WHERE c.provider = 'lithic' AND c.provider_card_token = ${token}`;
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

/** The same authorisation, down `decideUnderLock()` instead of the three steps. */
function oneLocked(tag: string, amountCents: bigint) {
  const request = parseAsaRequest(
    asaPayload({
      token: `lockrace-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      cardToken: CARD_TOKEN_LOCKED,
      amountCents: Number(amountCents),
      holdCents: Number(amountCents),
      mcc: "5812",
    }),
  );
  return decideUnderLock({
    provider: "lithic",
    providerCardToken: CARD_TOKEN_LOCKED,
    source: "harness",
    requestId: null,
    request,
    judge: (lookup) => decide(request, lookup),
  });
}

describe.runIf(RUN)("the same instant, behind the lock", () => {
  it("serialises the pair: the second leg reads the first leg's spend and is refused", async () => {
    await Promise.all([
      velocity(CARD_TOKEN_LOCKED),
      velocity(CARD_TOKEN_LOCKED),
      velocity(CARD_TOKEN_LOCKED),
    ]);

    const limit = BigInt((await velocity(CARD_TOKEN_LOCKED)).daily_limit_cents);
    const PER_TXN = 2500n;
    const SEED = 2000n;
    while (limit - BigInt((await velocity(CARD_TOKEN_LOCKED)).day_cents) >= 2n * PER_TXN) {
      const seeded = await oneLocked("seed", SEED);
      // eslint-disable-next-line no-console
      console.log(
        `[SEED ] ${seeded.verdict.outcome} ${seeded.verdict.rule} amount=${SEED} row=${seeded.decisionId}`,
      );
      if (seeded.verdict.outcome !== "approve") break;
    }

    const spent = BigInt((await velocity(CARD_TOKEN_LOCKED)).day_cents);
    const headroom = limit - spent;
    const amount = headroom / 2n + 100n;

    // eslint-disable-next-line no-console
    console.log(
      `[SETUP] card ${CARD_TOKEN_LOCKED}  daily_limit=${limit}  spent_today=${spent}  headroom=${headroom}  each leg=${amount}`,
    );
    expect(amount).toBeLessThanOrEqual(headroom);
    expect(amount * 2n).toBeGreaterThan(headroom);

    const started = process.hrtime.bigint();
    const [a, b] = await Promise.all([oneLocked("a", amount), oneLocked("b", amount)]);
    const wallUs = Number((process.hrtime.bigint() - started) / 1000n);

    const after = await velocity(CARD_TOKEN_LOCKED);

    // eslint-disable-next-line no-console
    console.log(
      [
        `[LEG A] outcome=${a.verdict.outcome} rule=${a.verdict.rule} spend_read=${a.lookup.status === "read" ? a.lookup.spend.dayCents : "n/a"} total_us=${a.totalUs} row=${a.decisionId}`,
        `[LEG B] outcome=${b.verdict.outcome} rule=${b.verdict.rule} spend_read=${b.lookup.status === "read" ? b.lookup.spend.dayCents : "n/a"} total_us=${b.totalUs} row=${b.decisionId}`,
        `[AFTER] spent_today=${after.day_cents}  daily_limit=${after.daily_limit_cents}  over_by=${BigInt(after.day_cents) - limit}`,
        `[WALL ] both legs, concurrent: ${wallUs} us`,
      ].join("\n"),
    );

    // Exactly one of the pair is approved, and the book is not over its limit.
    const approvals = [a, b].filter((r) => r.verdict.outcome === "approve");
    expect(approvals).toHaveLength(1);
    expect([a, b].some((r) => r.verdict.rule === "daily_limit_exceeded")).toBe(true);
    expect(BigInt(after.day_cents)).toBeLessThanOrEqual(limit);
  }, 60_000);
});
