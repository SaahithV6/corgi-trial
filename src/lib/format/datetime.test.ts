import { describe, expect, it } from "vitest";

import {
  formatAge,
  formatCountdown,
  formatDate,
  formatTimeOfDay,
  formatTimestamp,
} from "@/lib/format/datetime";

const NOW = "2026-09-09T19:42:00.000Z"; // 15:42 ET

describe("formatAge", () => {
  it("collapses the first minute", () => {
    expect(formatAge("2026-09-09T19:41:58.000Z", NOW)).toBe("just now");
  });

  it("renders minutes under an hour", () => {
    expect(formatAge("2026-09-09T19:28:00.000Z", NOW)).toBe("14m");
  });

  it("renders hours and minutes under a day", () => {
    expect(formatAge("2026-09-09T16:30:00.000Z", NOW)).toBe("3h 12m");
    expect(formatAge("2026-09-09T16:42:00.000Z", NOW)).toBe("3h");
  });

  it("renders days and hours past a day", () => {
    expect(formatAge("2026-09-08T15:42:00.000Z", NOW)).toBe("1d 4h");
    expect(formatAge("2026-09-08T19:42:00.000Z", NOW)).toBe("1d");
  });

  it("drops the hours once an age is measured in weeks", () => {
    expect(formatAge("2026-08-28T04:00:00.000Z", NOW)).toBe("12d");
  });

  it("refuses to render a negative age or an unparseable instant", () => {
    expect(formatAge("2026-09-10T00:00:00.000Z", NOW)).toBe("—");
    expect(formatAge("not-a-date", NOW)).toBe("—");
  });
});

describe("formatCountdown", () => {
  it("counts forward to a release time", () => {
    expect(formatCountdown("2026-09-10T13:00:00.000Z", NOW)).toBe("in 17h 18m");
  });

  it("says due now once the instant has passed", () => {
    expect(formatCountdown("2026-09-09T09:00:00.000Z", NOW)).toBe("due now");
  });
});

describe("fixed banking timezone", () => {
  it("renders in ET regardless of the host timezone", () => {
    expect(formatTimestamp(NOW)).toBe("Sep 09, 2026 · 15:42 ET");
    expect(formatDate(NOW)).toBe("Sep 09, 2026");
    expect(formatTimeOfDay("2026-09-10T13:00:00.000Z")).toBe("09:00 ET");
  });
});
