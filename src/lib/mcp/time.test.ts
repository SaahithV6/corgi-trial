import { describe, expect, it } from "vitest";

import { addDays, bookDate, daysBetween, isIsoDate } from "./time";

describe("bookDate", () => {
  it("is the New York business day, not the UTC one", () => {
    // 01:30 UTC on the 11th is still the evening of the 10th in New York, and
    // a ledger that answered "the 11th" here would date a payment a day early
    // for five hours out of every twenty-four.
    expect(bookDate(new Date("2026-09-11T01:30:00Z"))).toBe("2026-09-10");
    expect(bookDate(new Date("2026-09-10T18:00:00Z"))).toBe("2026-09-10");
  });

  it("handles the winter offset too", () => {
    // EST is UTC-5, so 04:30 UTC on 1 Jan is 23:30 on 31 Dec.
    expect(bookDate(new Date("2026-01-01T04:30:00Z"))).toBe("2025-12-31");
  });
});

describe("isIsoDate", () => {
  it("accepts real dates and refuses plausible fakes", () => {
    expect(isIsoDate("2026-09-10")).toBe(true);
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("10-09-2026")).toBe(false);
    expect(isIsoDate("2026-9-10")).toBe(false);
  });
});

describe("daysBetween", () => {
  it("counts whole days and never goes negative", () => {
    expect(daysBetween("2026-09-01", "2026-09-10")).toBe(9);
    expect(daysBetween("2026-09-10", "2026-09-10")).toBe(0);
    expect(daysBetween("2026-09-10", "2026-09-01")).toBe(0);
  });

  it("is exact across a DST transition", () => {
    // 1 Nov 2026 is the US fall-back. Measured at UTC midnight so the extra
    // hour cannot round a nine-day-old break down to eight.
    expect(daysBetween("2026-10-28", "2026-11-06")).toBe(9);
  });
});

describe("addDays", () => {
  it("moves forward across a month boundary", () => {
    expect(addDays("2026-09-10", 90)).toBe("2026-12-09");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});
