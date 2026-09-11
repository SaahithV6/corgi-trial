/**
 * TIME TRAVEL, DRIVEN AGAINST THE LIVE BOOK.
 *
 * `RUN_DB_TESTS=1` and a real `APP_DATABASE_URL`, or every case here skips.
 * That is the house pattern: the unit suites in this directory pin the rules
 * with no credentials, and this one pins the CLAIMS, which are only claims if
 * a real ledger agrees with them.
 *
 * What it proves, in order:
 *
 *   1. no parameter, no difference — the live point IS `readSnapshot()`
 *   2. the same business day reads DIFFERENTLY at two `asKnownAt` values
 *   3. the difference is accounted for, to the cent, by the acts in between
 *   4. the cut refuses to land inside an atomic write
 *   5. a future `asKnownAt` is refused before a connection is opened
 *
 * Nothing here writes. Every statement is a SELECT and the journal is
 * append-only, so this suite cannot disturb a book that twelve other workers
 * are writing to while it runs — which is also why every assertion is a
 * RELATION between two readings rather than a fixed figure. A test that
 * asserted "$134.56" would be red by the time it was committed.
 */

import { afterAll, describe, expect, it } from "vitest";

import { ledgerConnection, readSnapshot } from "@/lib/ledger/queries";
import type { Sql } from "@/lib/ledger/balance-definitions";

import { fixedClock, systemClock } from "./clock";
import { observableWatermark, straddle } from "./integrity";
import { bestDemonstration, correctionLandmarks } from "./landmarks";
import { parseTimeTravelParams } from "./params";
import { resolveTimePoint } from "./point";
import { readAccountAtPoint, foldClosing } from "./read";

const ENABLED =
  process.env["RUN_DB_TESTS"] === "1" &&
  typeof process.env["APP_DATABASE_URL"] === "string" &&
  process.env["APP_DATABASE_URL"] !== "";

const describeDb = ENABLED ? describe : describe.skip;

let shared: Sql | null = null;
async function conn(): Promise<Sql> {
  shared ??= await ledgerConnection();
  return shared;
}

afterAll(async () => {
  if (shared !== null) await shared.end({ timeout: 5 });
});

function request(overrides: {
  asOf?: string | null;
  asKnownAt?: Date | null;
}) {
  return {
    asOfValueDate: overrides.asOf ?? null,
    asKnownAt: overrides.asKnownAt ?? null,
    asKnownAtRaw: overrides.asKnownAt?.toISOString() ?? null,
    asOfRaw: overrides.asOf ?? null,
    absent: false,
    foresight: false,
  };
}

/* -------------------------------------------------------------------------- */

describeDb("1. no parameter, no difference", () => {
  it("the live point is readSnapshot(), field for field", async () => {
    const c = await conn();

    const absent = parseTimeTravelParams({}, systemClock.now());
    expect(absent.ok).toBe(true);
    if (!absent.ok) return;
    expect(absent.request.absent).toBe(true);

    const point = await resolveTimePoint(absent.request, c, systemClock);
    const direct = await readSnapshot(c);

    expect(point.mode).toBe("live");
    expect(point.snapshot.valueDate).toBe(direct.valueDate);
    expect(point.valuePinned).toBe(false);
    expect(point.bookingPinned).toBe(false);
    expect(point.cut.snapped).toBe(false);

    // The book is written to continuously by other workers, so the watermark
    // can legitimately advance BETWEEN these two reads. What must hold is that
    // the live point never trails the book, and never skips ahead of it.
    expect(point.snapshot.bookingWatermark).toBeLessThanOrEqual(direct.bookingWatermark);
    expect(direct.bookingWatermark - point.snapshot.bookingWatermark).toBeLessThan(200n);
  });

  it("unrelated query state does not switch the screen into travel mode", async () => {
    const c = await conn();
    const parsed = parseTimeTravelParams(
      { state: "edge", account: "abc", window: "week" },
      systemClock.now(),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const point = await resolveTimePoint(parsed.request, c, systemClock);
    expect(point.mode).toBe("live");
    expect(point.query).toBe("");
  });
});

/* -------------------------------------------------------------------------- */

describeDb("2 & 3. the same day, read at two points on the booking axis", () => {
  it("changes its closing balance, and the difference is accounted for", async () => {
    const c = await conn();

    const act = await bestDemonstration(c);
    if (act === null) {
      // A book with no completed correction act cannot demonstrate this, and
      // saying so is better than asserting something weaker and calling it a
      // pass. The seed and the live-fire suite both produce acts.
      expect(act).toBeNull();
      return;
    }

    const before = act.landmarks.find((l) => l.kind === "before");
    const after = act.landmarks.find((l) => l.kind === "after");
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    if (before === undefined || after === undefined) return;

    // ONE value date. TWO instants on the booking axis. Nothing else changes.
    const read = async (asKnownAt: string) => {
      const point = await resolveTimePoint(
        request({ asOf: act.valueDate, asKnownAt: new Date(asKnownAt) }),
        c,
        systemClock,
      );
      const at = await readAccountAtPoint(
        { accountId: act.accountId, point, window: "day" },
        c,
      );
      return { point, at, closing: foldClosing(at.period) };
    };

    const then = await read(before.at);
    const now = await read(after.at);

    expect(then.point.snapshot.valueDate).toBe(now.point.snapshot.valueDate);
    expect(then.point.snapshot.bookingWatermark).toBeLessThan(
      now.point.snapshot.bookingWatermark,
    );

    // THE CLAIM: same day, different belief.
    expect(then.closing).not.toBe(now.closing);
    expect(now.closing - then.closing).toBe(act.netCents);

    // THE IDENTITY: closing(now) − closing(then) = Σ entries booked above the
    // earlier cut. Asserted at the earlier point, whose `late` list is exactly
    // those entries.
    expect(then.at.explained).toBe(true);
    expect(then.at.closingNowCents - then.closing).toBe(then.at.lateNetCents);

    // And the acts are named, not merely summed.
    expect(then.at.pending.length).toBeGreaterThan(0);
  });

  it("holds the value axis still: a different day does not move with the cut", async () => {
    const c = await conn();
    const act = await bestDemonstration(c);
    if (act === null) return;

    const before = act.landmarks.find((l) => l.kind === "before");
    const after = act.landmarks.find((l) => l.kind === "after");
    if (before === undefined || after === undefined) return;

    // A value date years before the act's own. The correction carries the
    // ORIGINAL value date, so it cannot reach a day before it.
    const other = "1979-01-02";

    const closingAt = async (asKnownAt: string) => {
      const point = await resolveTimePoint(
        request({ asOf: other, asKnownAt: new Date(asKnownAt) }),
        c,
        systemClock,
      );
      const at = await readAccountAtPoint(
        { accountId: act.accountId, point, window: "day" },
        c,
      );
      return foldClosing(at.period);
    };

    expect(await closingAt(before.at)).toBe(await closingAt(after.at));
  });
});

/* -------------------------------------------------------------------------- */

describeDb("4. the cut never lands inside an atomic write", () => {
  it("snaps below a correction act rather than showing half of it", async () => {
    const c = await conn();
    const act = await bestDemonstration(c);
    if (act === null) return;

    const mid = act.landmarks.find((l) => l.kind === "midWrite");
    if (mid === undefined) {
      // The act's correcting entries were stamped less than 2ms apart, so no
      // millisecond-resolution instant lands inside it. Not a failure of the
      // guard — there is nothing for it to catch at this resolution.
      return;
    }

    const point = await resolveTimePoint(
      request({ asOf: act.valueDate, asKnownAt: new Date(mid.at) }),
      c,
      systemClock,
    );

    // The raw watermark DID land inside the act, and the guard moved it down.
    expect(point.cut.snapped).toBe(true);
    expect(point.cut.effective).toBeLessThan(point.cut.requested);
    expect(point.cut.straddled.length).toBeGreaterThan(0);

    // And the resulting cut is clean: re-running the check on the effective
    // watermark finds nothing to move.
    const recheck = await observableWatermark(point.cut.effective, c);
    expect(recheck.snapped).toBe(false);

    // The state that was refused is the half-landed one: the act's correcting
    // entries are now ENTIRELY above the cut, never partly below it.
    const correcting = act.members.filter((m) => m.entryType !== "original");
    for (const member of correcting) {
      expect(member.bookingSeq).toBeGreaterThan(point.cut.effective);
    }
  });

  it("still allows the cut BETWEEN an original and its correction", async () => {
    const c = await conn();
    const act = await bestDemonstration(c);
    if (act === null) return;

    const before = act.landmarks.find((l) => l.kind === "before");
    if (before === undefined) return;

    const point = await resolveTimePoint(
      request({ asOf: act.valueDate, asKnownAt: new Date(before.at) }),
      c,
      systemClock,
    );

    // This boundary is between two different transactions, hours apart. It was
    // genuinely observable and standing on it is the whole feature — a rule
    // phrased as "never split a correction group" would have destroyed it.
    expect(point.cut.snapped).toBe(false);
    expect(straddle([], point.cut.effective)).toBeNull();
  });

  it("agrees with the ledger's own watermark reader at a clean instant", async () => {
    const c = await conn();
    const { bookingWatermarkAt } = await import("@/lib/ledger/balance-definitions");

    const snapshot = await readSnapshot(c);
    const point = await resolveTimePoint(
      request({ asKnownAt: snapshot.asOf }),
      c,
      systemClock,
    );

    // The top of the book is never inside a write that has more above it.
    const direct = await bookingWatermarkAt(snapshot.asOf, c);
    expect(point.cut.requested).toBe(direct);
  });
});

/* -------------------------------------------------------------------------- */

describeDb("5. impossible coordinates are refused before a connection opens", () => {
  it("refuses a future asKnownAt", () => {
    const clock = fixedClock(new Date("2026-09-11T06:00:00Z"));
    const parsed = parseTimeTravelParams(
      { asKnownAt: "2027-01-01T00:00:00Z" },
      clock.now(),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("AS_KNOWN_AT_IN_FUTURE");
  });

  it("accepts a future asOf, because the book carries future value dates", async () => {
    const c = await conn();
    const act = await bestDemonstration(c);
    if (act === null) return;

    // Standing orders settle years ahead. Asking what the book already says
    // about 2027 is a real question, and the answer is at least the answer for
    // today — value dates accumulate.
    const point = await resolveTimePoint(request({ asOf: "2027-12-31" }), c, systemClock);
    expect(point.snapshot.valueDate).toBe("2027-12-31");
    expect(point.mode).toBe("travelled");
  });

  it("an instant before the book began is a real answer, not a refusal", async () => {
    const c = await conn();
    const point = await resolveTimePoint(
      request({ asKnownAt: new Date("1990-01-01T00:00:00Z") }),
      c,
      systemClock,
    );
    // We had learned nothing. Watermark zero, and every figure zero.
    expect(point.snapshot.bookingWatermark).toBe(0n);
  });
});

/* -------------------------------------------------------------------------- */

describeDb("landmarks come off the real book", () => {
  it("finds correction acts with at least two places to stand", async () => {
    const c = await conn();
    const act = await bestDemonstration(c);
    if (act === null) return;

    const acts = await correctionLandmarks({ accountId: act.accountId }, c);
    expect(acts.length).toBeGreaterThan(0);

    for (const found of acts) {
      expect(found.landmarks.length).toBeGreaterThanOrEqual(2);
      expect(found.landmarks.some((l) => l.kind === "before")).toBe(true);
      expect(found.landmarks.some((l) => l.kind === "after")).toBe(true);
      // A landmark's value date is the act's, which is the ORIGINAL's — that
      // is what makes "hold the day still and move the other axis" possible.
      expect(found.valueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
