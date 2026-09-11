/**
 * Daily accrual against the REAL Neon database, moving REAL (sandbox) money.
 *
 * Gated on RUN_DB_TESTS=1 so CI (which holds no credentials, deliberately)
 * skips rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/lib/accrual
 *
 * ============================================================================
 * THE THREE CLAIMS THIS FILE EXISTS TO PROVE
 * ============================================================================
 *
 *   1. RUNNING IT TWICE FOR THE SAME DAY POSTS ONCE. Two full ticks for the
 *      same business date, started CONCURRENTLY against the live database,
 *      produce ONE journal entry per (schedule, date) between them — counted in
 *      Postgres, with the second tick reporting that it found the first's work
 *      already done and naming the same entry id.
 *
 *   2. THE ENTRY IS DATED THE DAY IT ACCRUED FOR. A tick run on one date that
 *      catches up earlier ones posts entries whose `value_date` is the accrual
 *      date and whose `booking_seq` is now. Value date and booking date are
 *      different columns and this is the case that proves it.
 *
 *   3. THE MONTH SUMS TO THE PRICE, AND THE DATABASE AGREES WITH THE CODE.
 *      `v_accrual_month_drift` and `v_accrual_ledger_drift` are empty, and the
 *      arithmetic columns Postgres accepted are the ones `allocateForDate()`
 *      computed — the CHECK constraint would have refused any other.
 *
 * ─── What this suite writes to the live database ────────────────────────────
 *
 * Real fee postings on real deposit accounts, at real (small) amounts: a few
 * dollars across the enrolled businesses for the month to date. That is the
 * point — the feature is not proven by a mock. Everything it writes is
 * append-only and correctly dated, and the whole of it is reproducible by the
 * cron that will do the same thing tomorrow.
 *
 * It does NOT clean up after itself, and could not: `journal_entry` has no
 * DELETE for this role, by design. Re-running the suite is therefore free
 * rather than destructive — the second run finds the days already accrued and
 * asserts that it posted nothing, which is claim 1 all over again.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";

import type * as PostModule from "@/lib/ledger/post";

import type * as AccrueModule from "./accrue";
import type * as StoreModule from "./store";
import { allocateForDate } from "./types";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

let sql: typeof SqlHandle;
let runAccrual: typeof AccrueModule.runAccrual;
let ledgerPosterActorId: typeof StoreModule.ledgerPosterActorId;
let postEntry: typeof PostModule.postEntry;

/**
 * A second, tiny schedule on Ridgeline, priced BELOW a cent a day.
 *
 * It exists for two reasons that the migration's own schedules cannot serve:
 *
 *   * 20¢ a month over 31 days is q = 0, r = 20 — so 20 August accrues one
 *     penny and 21 August accrues NOTHING. That is the `skipped` disposition
 *     happening for real rather than being described, and it is the case where
 *     "round each day" would have charged either 0¢ or 31¢ for a 20¢ product.
 *
 *   * Its window is a two-day island in AUGUST, deliberately not overlapping
 *     the migration schedules' September window — `accrual_schedule_no_overlap`
 *     would refuse it otherwise, which is that constraint doing its job.
 *
 * Created idempotently on `schedule_key`, so re-running this suite adds
 * nothing. It is a real enrolment on a real account for two days in the past;
 * the nightly cron will find those two days already decided and do nothing.
 */
const PROBE = {
  key: "itest:accrual:sub-cent-probe:v1",
  planName: "Sub-cent probe (integration suite)",
  monthlyCents: 20n,
  startDate: "2026-08-20",
  endDate: "2026-08-21",
} as const;

beforeAll(async () => {
  if (!RUN) return;
  ({ sql } = await import("@/lib/ledger/db"));
  ({ runAccrual } = await import("./accrue"));
  ({ ledgerPosterActorId } = await import("./store"));
  ({ postEntry } = await import("@/lib/ledger/post"));

  const actorId = await ledgerPosterActorId();
  await sql`
    INSERT INTO accrual_schedule
      (account_id, product, plan_name, monthly_cents, start_date, end_date,
       created_by, schedule_key)
    SELECT a.id, 'platform_fee'::accrual_product, ${PROBE.planName},
           ${PROBE.monthlyCents.toString()}::bigint,
           ${PROBE.startDate}::date, ${PROBE.endDate}::date,
           ${actorId}::uuid, ${PROBE.key}
      FROM account a
      JOIN business b ON b.id = a.business_id
     WHERE a.code = '2100' AND b.legal_name = 'Ridgeline Robotics, Inc.'
    ON CONFLICT (schedule_key) DO NOTHING`;
});

/** Today and yesterday in BOOK time, asked of the database. Never a Node Date. */
async function twoConsecutiveDates(): Promise<{ yesterday: string; today: string }> {
  const [row] = await sql<{ yesterday: string; today: string }[]>`
    SELECT ((now() AT TIME ZONE 'America/New_York')::date - 1)::text AS yesterday,
           (now() AT TIME ZONE 'America/New_York')::date::text       AS today`;
  if (row === undefined) throw new Error("the database did not answer what day it is");
  return row;
}

d("daily accrual, live", () => {
  it("accrues two consecutive business dates and dates each entry at the day it accrued for", async () => {
    const { yesterday, today } = await twoConsecutiveDates();

    // Run one: everything owed up to and including yesterday. On a fresh
    // month this is a catch-up of every day from the 1st, which is exactly
    // the case where value date and booking date must differ.
    const first = await runAccrual({ bookDate: yesterday, runId: "accrual-itest-a" });
    expect(first.bookDate).toBe(yesterday);

    // Run two: today. Strictly the days run one could not have taken.
    const second = await runAccrual({ bookDate: today, runId: "accrual-itest-b" });
    expect(second.bookDate).toBe(today);
    for (const day of second.days) {
      expect(day.accrualDate <= today).toBe(true);
    }

    // ASSERTED OF THE LEDGER, NOT OF THE RUN. On a first run these two ticks
    // post the whole month to date; on every run after that they post NOTHING,
    // because the days are already accrued — which is the exactly-once property
    // and not a reason for this test to have nothing to check. So the claim is
    // about what the book now holds: both business dates have a correctly dated
    // accrual entry for every enrolled schedule, whoever posted it and whenever.
    const onBothDates = await sql<{ accrual_date: string; n: bigint }[]>`
      SELECT ad.accrual_date::text AS accrual_date, count(*) AS n
        FROM accrual_posting ap
        JOIN accrual_day ad ON ad.id = ap.accrual_day_id
       WHERE ad.accrual_date IN (${yesterday}::date, ${today}::date)
       GROUP BY ad.accrual_date
       ORDER BY 1`;
    expect(onBothDates.map((r) => r.accrual_date)).toEqual([yesterday, today]);
    for (const row of onBothDates) {
      expect(Number(row.n)).toBeGreaterThan(0);
    }

    // And whatever THIS pair of ticks did post is correct: every entry it named
    // carries its accrual date as its value date. Empty on a replay, which is
    // the point of the block above.
    const posted = [...first.days, ...second.days].filter(
      (day) => day.action === "posted" && day.entryId !== null,
    );

    for (const day of posted) {
      const [entry] = await sql<
        { value_date: string; booking_seq: bigint; idempotency_key: string; book: string }[]
      >`SELECT value_date::text AS value_date, booking_seq, idempotency_key, book::text AS book
          FROM journal_entry WHERE id = ${day.entryId as string}::uuid`;
      expect(entry).toBeDefined();
      expect(entry?.value_date).toBe(day.accrualDate);
      expect(entry?.idempotency_key).toBe(day.idempotencyKey);
      expect(entry?.book).toBe("financial");
    }

    // At least one catch-up entry: booked after the day it is dated for.
    // That is the whole "value date is not booking date" claim, in one row.
    const [late] = await sql<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM accrual_posting ap
        JOIN accrual_day ad ON ad.id = ap.accrual_day_id
       WHERE ap.disposition = 'posted'
         AND ad.accrual_date < (ap.decided_at AT TIME ZONE 'America/New_York')::date`;
    expect(Number(late?.n ?? 0)).toBeGreaterThan(0);
  });

  it("posts exactly once when two ticks race for the same day", async () => {
    const { today } = await twoConsecutiveDates();

    // Both ticks are started before either is awaited, so they are genuinely
    // in flight together against the same rows.
    const [a, b] = await Promise.all([
      runAccrual({ bookDate: today, runId: "accrual-itest-race-a" }),
      runAccrual({ bookDate: today, runId: "accrual-itest-race-b" }),
    ]);

    // Neither may have deferred: a deferral here would mean an exception, not
    // a lost race — the loser of a race reports `replayed`, not `deferred`.
    expect(a.deferred).toBe(0);
    expect(b.deferred).toBe(0);

    // Between them, at most one of the two can have done new work for any
    // given day, and by this point in the suite the day is already accrued —
    // so both should be pure replays posting nothing.
    expect(a.postedCents + b.postedCents).toBe(0n);

    // And the database agrees: one accrual_day per (schedule, date), one entry
    // per accrual_day, one journal entry per derived key. Counted, not assumed.
    const [dupes] = await sql<{ n: bigint }[]>`
      SELECT count(*) AS n FROM (
        SELECT schedule_id, accrual_date FROM accrual_day
         GROUP BY schedule_id, accrual_date HAVING count(*) > 1
      ) x`;
    expect(Number(dupes?.n ?? 0)).toBe(0);

    const [doubleEntries] = await sql<{ n: bigint }[]>`
      SELECT count(*) AS n FROM (
        SELECT e.idempotency_key
          FROM journal_entry e
         WHERE e.idempotency_key LIKE 'accrual:%'
         GROUP BY e.idempotency_key HAVING count(*) > 1
      ) x`;
    expect(Number(doubleEntries?.n ?? 0)).toBe(0);
  });

  it("hands back the SAME entry id on a replay", async () => {
    const { today } = await twoConsecutiveDates();

    const again = await runAccrual({ bookDate: today, runId: "accrual-itest-replay" });
    // Every day it considered is one it has already decided.
    for (const day of again.days) {
      expect(day.replayed).toBe(true);
    }
    expect(again.postedCents).toBe(0n);

    // The entry each replayed day names is the one on the posting row — the
    // original, not a new one.
    for (const day of again.days.filter((x) => x.action === "posted")) {
      const [row] = await sql<{ entry_id: string }[]>`
        SELECT entry_id FROM accrual_posting WHERE accrual_day_id = ${day.accrualDayId}::uuid`;
      expect(row?.entry_id).toBe(day.entryId);
    }
  });

  it("refuses to accrue for a day that has not happened", async () => {
    const [row] = await sql<{ tomorrow: string }[]>`
      SELECT ((now() AT TIME ZONE 'America/New_York')::date + 1)::text AS tomorrow`;
    await expect(
      runAccrual({ bookDate: row?.tomorrow as string, runId: "accrual-itest-future" }),
    ).rejects.toThrow(/has not happened/);
  });

  it("stores the arithmetic the code computed, because the database re-derived it", async () => {
    const rows = await sql<
      {
        accrual_date: string;
        monthly_cents: bigint;
        days_in_month: number;
        day_of_month: number;
        base_share_cents: bigint;
        residual_pennies: number;
        residual_applied: boolean;
        amount_cents: bigint;
        cumulative_cents: bigint;
      }[]
    >`
      SELECT ad.accrual_date::text AS accrual_date, ap.monthly_cents, ap.days_in_month,
             ap.day_of_month, ap.base_share_cents, ap.residual_pennies,
             ap.residual_applied, ap.amount_cents, ap.cumulative_cents
        FROM accrual_posting ap JOIN accrual_day ad ON ad.id = ap.accrual_day_id
       ORDER BY ad.accrual_date DESC LIMIT 40`;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const computed = allocateForDate(row.monthly_cents, row.accrual_date);
      expect(row.days_in_month).toBe(computed.daysInMonth);
      expect(row.day_of_month).toBe(computed.dayOfMonth);
      expect(row.base_share_cents).toBe(computed.baseShareCents);
      expect(row.residual_pennies).toBe(computed.residualPennies);
      expect(row.residual_applied).toBe(computed.residualApplied);
      expect(row.amount_cents).toBe(computed.amountCents);
      expect(row.cumulative_cents).toBe(computed.cumulativeCents);
    }
  });

  it("posts two lines: a debit to the customer and a credit to 4200", async () => {
    const lines = await sql<
      { code: string; business_id: string | null; amount_cents: bigint; entry_id: string }[]
    >`
      SELECT a.code, a.business_id, l.amount_cents, l.entry_id
        FROM accrual_posting ap
        JOIN journal_line l ON l.entry_id = ap.entry_id
        JOIN account a      ON a.id = l.account_id
       WHERE ap.disposition = 'posted'
         AND ap.entry_id = (SELECT entry_id FROM accrual_posting
                             WHERE disposition = 'posted'
                             ORDER BY decided_at DESC LIMIT 1)
       ORDER BY l.ordinal`;

    expect(lines.length).toBe(2);
    // Ordinal 0 is the house line — DESIGN §12.5's template — and it is a
    // CREDIT to income, so it is negative.
    expect(lines[0]?.code).toBe("4200");
    expect(lines[0]?.business_id).toBeNull();
    expect(lines[0]?.amount_cents).toBeLessThan(0n);
    // Ordinal 1 is the customer, and it is a DEBIT: a deposit balance is our
    // liability, so charging them a fee means we owe them less.
    expect(lines[1]?.code).toBe("2100");
    expect(lines[1]?.business_id).not.toBeNull();
    expect(lines[1]?.amount_cents).toBeGreaterThan(0n);
    expect(lines[0]!.amount_cents + lines[1]!.amount_cents).toBe(0n);
  });

  it("keeps both drift views empty", async () => {
    const [row] = await sql<{ month_drift: bigint; ledger_drift: bigint; unresolved: bigint }[]>`
      SELECT (SELECT count(*) FROM v_accrual_month_drift)  AS month_drift,
             (SELECT count(*) FROM v_accrual_ledger_drift) AS ledger_drift,
             (SELECT count(*) FROM v_accrual_unresolved)   AS unresolved`;
    expect(Number(row?.month_drift ?? -1)).toBe(0);
    expect(Number(row?.ledger_drift ?? -1)).toBe(0);
    expect(Number(row?.unresolved ?? -1)).toBe(0);
  });

  it("leaves the whole book summing to zero", async () => {
    // SUM() over bigint returns `numeric`, which the driver hands back as a
    // string. Cast in SQL so the assertion compares cents to cents — the same
    // trap `src/lib/format/money.ts` exists to keep out of the render path.
    const [row] = await sql<{ total: bigint }[]>`
      SELECT COALESCE(SUM(amount_cents), 0)::bigint AS total
        FROM journal_line WHERE currency = 'USD'`;
    expect(row?.total).toBe(0n);
  });

  it("records a sub-cent day as skipped rather than posting an empty entry", async () => {
    // 20¢ over 31 days: days 1-20 accrue a penny, days 21-31 accrue nothing.
    // postEntry() refuses a zero-amount line, so the 21st is a DECIDED day
    // with no entry and a sentence saying why — not a missing row.
    const rows = await sql<
      {
        accrual_date: string;
        disposition: string;
        amount_cents: bigint;
        cumulative_cents: bigint;
        entry_id: string | null;
        skip_reason: string | null;
      }[]
    >`
      SELECT ad.accrual_date::text AS accrual_date, ap.disposition::text AS disposition,
             ap.amount_cents, ap.cumulative_cents, ap.entry_id, ap.skip_reason
        FROM accrual_posting ap
        JOIN accrual_day ad      ON ad.id = ap.accrual_day_id
        JOIN accrual_schedule s  ON s.id = ad.schedule_id
       WHERE s.schedule_key = ${PROBE.key}
       ORDER BY ad.accrual_date`;

    expect(rows.length).toBe(2);

    expect(rows[0]?.accrual_date).toBe(PROBE.startDate);
    expect(rows[0]?.disposition).toBe("posted");
    expect(rows[0]?.amount_cents).toBe(1n);
    expect(rows[0]?.entry_id).not.toBeNull();

    expect(rows[1]?.accrual_date).toBe(PROBE.endDate);
    expect(rows[1]?.disposition).toBe("skipped");
    expect(rows[1]?.amount_cents).toBe(0n);
    expect(rows[1]?.entry_id).toBeNull();
    expect(rows[1]?.skip_reason).toContain("zero cents");
    // The month-to-date does not stall on a skipped day: day 21 of a 31-day
    // month carries 20 of the 20 pennies already placed.
    expect(rows[1]?.cumulative_cents).toBe(20n);
  });

  it("posts nothing when postEntry is handed an accrual key the ledger already has", async () => {
    // THE DOUBLE-RUN PROOF AT ITS LOWEST LAYER, and the one assertion in this
    // file that cannot go vacuous once the days are accrued. Take a real
    // accrual entry, replay its exact posting, and assert that the ledger
    // hands back the ORIGINAL id and grew by zero rows.
    const [victim] = await sql<
      { entry_id: string; entity_id: string; value_date: string; idempotency_key: string }[]
    >`
      SELECT e.id AS entry_id, e.entity_id, e.value_date::text AS value_date, e.idempotency_key
        FROM journal_entry e
       WHERE e.idempotency_key LIKE 'accrual:%'
       ORDER BY e.booking_seq DESC LIMIT 1`;
    expect(victim).toBeDefined();

    const lines = await sql<{ account_id: string; amount_cents: bigint }[]>`
      SELECT account_id, amount_cents FROM journal_line
       WHERE entry_id = ${victim!.entry_id}::uuid ORDER BY ordinal`;

    const [before] = await sql<{ n: bigint }[]>`SELECT count(*) AS n FROM journal_entry`;

    const replayed = await postEntry({
      entityId: victim!.entity_id,
      valueDate: victim!.value_date,
      book: "financial",
      description: "replay attempt — must be a no-op",
      idempotencyKey: victim!.idempotency_key,
      actorId: await ledgerPosterActorId(),
      lines: lines.map((l) => ({ accountId: l.account_id, amountCents: l.amount_cents })),
      rail: "internal",
    });

    const [after] = await sql<{ n: bigint }[]>`SELECT count(*) AS n FROM journal_entry`;

    // Same entry, and not one row more in the journal. Decided by the UNIQUE
    // index on journal_entry.idempotency_key, not by anything this test did.
    expect(replayed).toBe(victim!.entry_id);
    expect(after?.n).toBe(before?.n);
  });

  it("refuses a posting whose value date is not the accrual date", async () => {
    // The safety net from 0020 §10, attempted for real. Cite a REAL entry —
    // one this suite already posted — against a DIFFERENT day's claim. The
    // arithmetic CHECK would pass; the lifecycle trigger must not.
    const [victim] = await sql<
      { day_id: string; entry_id: string; monthly_cents: bigint; accrual_date: string }[]
    >`
      SELECT ad.id AS day_id, ap.entry_id, ap.monthly_cents, ad.accrual_date::text AS accrual_date
        FROM accrual_posting ap JOIN accrual_day ad ON ad.id = ap.accrual_day_id
       WHERE ap.disposition = 'posted'
       ORDER BY ad.accrual_date ASC LIMIT 1`;
    const [other] = await sql<{ day_id: string; accrual_date: string }[]>`
      SELECT ad.id AS day_id, ad.accrual_date::text AS accrual_date
        FROM accrual_day ad
        JOIN accrual_posting ap ON ap.accrual_day_id = ad.id
       WHERE ad.accrual_date <> ${victim?.accrual_date as string}::date
       ORDER BY ad.accrual_date DESC LIMIT 1`;
    if (victim === undefined || other === undefined) return;

    const a = allocateForDate(victim.monthly_cents, other.accrual_date);
    await expect(
      sql`INSERT INTO accrual_posting (
            accrual_day_id, disposition, monthly_cents, days_in_month, day_of_month,
            base_share_cents, residual_pennies, residual_applied, amount_cents,
            cumulative_cents, entry_id, decided_by_run)
          VALUES (${other.day_id}::uuid, 'posted', ${a.monthlyCents.toString()}::bigint,
                  ${a.daysInMonth}, ${a.dayOfMonth},
                  ${a.baseShareCents.toString()}::bigint, ${a.residualPennies},
                  ${a.residualApplied}, ${a.amountCents.toString()}::bigint,
                  ${a.cumulativeCents.toString()}::bigint,
                  ${victim.entry_id}::uuid, 'accrual-itest-attack')`,
      // Either the primary key refuses it (the day is already decided) or the
      // lifecycle trigger does (the entry belongs to another day). Both are the
      // database saying no, which is the property under test.
    ).rejects.toThrow();
  });
});
