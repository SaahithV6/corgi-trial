/**
 * THE TWO PARAMETERS: what is accepted, what is refused, and what happens when
 * neither is there.
 *
 * The last of those is the one that matters most and it is the first test
 * below. "No parameter, no difference" is a promise every screen in this
 * feature makes, and a promise about ABSENCE is exactly the kind that decays
 * silently, because nothing on screen changes when it breaks.
 */

import { describe, expect, it } from "vitest";

import {
  AS_KNOWN_AT_PARAM,
  AS_OF_PARAM,
  bankingDayOf,
  endOfBankingDay,
  parseTimeTravelParams,
  startOfBankingDay,
  timeTravelQuery,
  withTimeTravel,
} from "./params";

const NOW = new Date("2026-09-11T06:00:00.000Z");

function parse(params: Record<string, string | string[] | undefined>) {
  return parseTimeTravelParams(params, NOW);
}

describe("absence — the default path", () => {
  it("reports absent when neither parameter is present", () => {
    const parsed = parse({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.absent).toBe(true);
    expect(parsed.request.asOfValueDate).toBeNull();
    expect(parsed.request.asKnownAt).toBeNull();
    expect(timeTravelQuery(parsed.request)).toBe("");
  });

  it("is still absent when unrelated query state is present", () => {
    const parsed = parse({ state: "edge", account: "abc", day: "2026-09-10" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.absent).toBe(true);
  });

  it("treats an empty string as absent, not as malformed", () => {
    // `?asOf=` is what a form submits for an unset field. Refusing it would
    // turn a cleared control into an error page.
    const parsed = parse({ [AS_OF_PARAM]: "", [AS_KNOWN_AT_PARAM]: "" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.absent).toBe(true);
  });

  it("is NOT absent when only one axis is pinned", () => {
    const parsed = parse({ [AS_OF_PARAM]: "2026-09-10" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.absent).toBe(false);
    expect(parsed.request.asOfValueDate).toBe("2026-09-10");
    expect(parsed.request.asKnownAt).toBeNull();
  });
});

describe("asOf — the value axis", () => {
  it("accepts a calendar date", () => {
    const parsed = parse({ [AS_OF_PARAM]: "2011-10-01" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.asOfValueDate).toBe("2011-10-01");
  });

  it("accepts a value date in the future — the book carries 2027 ones", () => {
    // Standing-order settlements are value-dated years ahead. Asking what the
    // book says about one is a real question with a real answer.
    const parsed = parse({ [AS_OF_PARAM]: "2027-12-02" });
    expect(parsed.ok).toBe(true);
  });

  it("refuses a timestamp on the value axis", () => {
    const parsed = parse({ [AS_OF_PARAM]: "2026-09-10T14:00:00Z" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("AS_OF_MALFORMED");
    expect(parsed.refusals[0]?.param).toBe(AS_OF_PARAM);
  });

  it("refuses a day that does not exist", () => {
    const parsed = parse({ [AS_OF_PARAM]: "2026-02-30" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("AS_OF_NOT_A_DATE");
  });

  it("refuses a year outside the book's possible range", () => {
    const parsed = parse({ [AS_OF_PARAM]: "1492-01-01" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("AS_OF_OUT_OF_RANGE");
  });
});

describe("asKnownAt — the booking axis", () => {
  it("accepts an explicit UTC instant", () => {
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-11T04:29:32.382Z" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.asKnownAt?.toISOString()).toBe("2026-09-11T04:29:32.382Z");
  });

  it("accepts an explicit offset", () => {
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-11T00:29:32.382-04:00" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.asKnownAt?.toISOString()).toBe("2026-09-11T04:29:32.382Z");
  });

  it("reads a zoneless time as BANKING time, not server time", () => {
    // A server zone is a deployment accident and must never change what a URL
    // means. 2026-09-11 is EDT, UTC−4.
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-11T00:29:32" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.asKnownAt?.toISOString()).toBe("2026-09-11T04:29:32.000Z");
  });

  it("reads a bare date as the END of that banking day", () => {
    // "What did we believe on Tuesday" means at the close of Tuesday. One
    // microsecond past midnight we believed almost nothing about it.
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-10" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.asKnownAt?.toISOString()).toBe("2026-09-11T03:59:59.999Z");
  });

  it("truncates sub-millisecond precision rather than rounding up", () => {
    // The watermark is "at or below", so truncating can only ever exclude an
    // entry. Rounding up could invent one.
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-11T04:29:32.3829Z" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.asKnownAt?.toISOString()).toBe("2026-09-11T04:29:32.382Z");
  });

  it("REFUSES an instant in the future", () => {
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-12T00:00:00Z" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("AS_KNOWN_AT_IN_FUTURE");
    expect(parsed.refusals[0]?.suggestion).toContain(AS_KNOWN_AT_PARAM);
  });

  it("tolerates a clock a few seconds fast", () => {
    // Two different machines. A URL minted from a browser clock 5s ahead must
    // not become an error page.
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-11T06:00:05.000Z" });
    expect(parsed.ok).toBe(true);
  });

  it("refuses a clock an hour fast — that is not skew", () => {
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "2026-09-11T07:00:00.000Z" });
    expect(parsed.ok).toBe(false);
  });

  it("refuses an unparseable instant rather than guessing", () => {
    const parsed = parse({ [AS_KNOWN_AT_PARAM]: "last tuesday" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals[0]?.code).toBe("AS_KNOWN_AT_MALFORMED");
  });
});

describe("both axes at once", () => {
  it("reports BOTH problems, so fixing one does not reveal the other", () => {
    const parsed = parse({
      [AS_OF_PARAM]: "not-a-date",
      [AS_KNOWN_AT_PARAM]: "2099-01-01T00:00:00Z",
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusals).toHaveLength(2);
    expect(parsed.refusals.map((r) => r.param)).toEqual([AS_OF_PARAM, AS_KNOWN_AT_PARAM]);
  });

  it("flags foresight when asKnownAt lands before asOf begins", () => {
    // "On Monday, what did we think Friday would close at?" — a coherent
    // question this book has real content for. Supported, and named.
    const parsed = parse({
      [AS_OF_PARAM]: "2027-12-02",
      [AS_KNOWN_AT_PARAM]: "2026-09-10T12:00:00Z",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.foresight).toBe(true);
  });

  it("is not foresight when asKnownAt is inside the value date", () => {
    const parsed = parse({
      [AS_OF_PARAM]: "2026-09-10",
      [AS_KNOWN_AT_PARAM]: "2026-09-10T18:00:00Z",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.foresight).toBe(false);
  });
});

describe("banking-day arithmetic", () => {
  it("brackets an EDT day at UTC−4", () => {
    expect(startOfBankingDay("2026-09-10").toISOString()).toBe("2026-09-10T04:00:00.000Z");
    expect(endOfBankingDay("2026-09-10").toISOString()).toBe("2026-09-11T03:59:59.999Z");
  });

  it("brackets an EST day at UTC−5", () => {
    // The second pass over the offset is what makes this right rather than
    // right-for-eight-months-a-year.
    expect(startOfBankingDay("2026-01-15").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });

  it("round-trips an instant back to its banking day", () => {
    // 03:30Z on the 11th is still the 10th in New York — the business-day
    // boundary this whole console is built on.
    expect(bankingDayOf(new Date("2026-09-11T03:30:00Z"))).toBe("2026-09-10");
    expect(bankingDayOf(new Date("2026-09-11T04:30:00Z"))).toBe("2026-09-11");
  });
});

describe("withTimeTravel — links that cannot drop an axis", () => {
  it("adds both axes to a bare path", () => {
    expect(
      withTimeTravel("/transactions", {
        asOf: "2011-10-01",
        asKnownAt: new Date("2026-09-11T04:29:32.382Z"),
      }),
    ).toBe("/transactions?asOf=2011-10-01&asKnownAt=2026-09-11T04%3A29%3A32.382Z");
  });

  it("preserves query state it did not put there", () => {
    const href = withTimeTravel("/transactions?account=abc&window=week", {
      asOf: "2011-10-01",
    });
    expect(href).toContain("account=abc");
    expect(href).toContain("window=week");
    expect(href).toContain("asOf=2011-10-01");
  });

  it("removes an axis on null — this is how you leave the time machine", () => {
    const href = withTimeTravel("/transactions?account=abc&asOf=2011-10-01", {
      asOf: null,
    });
    expect(href).toBe("/transactions?account=abc");
  });

  it("replaces rather than appends, so a URL cannot carry two of one axis", () => {
    const href = withTimeTravel("/transactions?asOf=2011-10-01", { asOf: "2012-01-01" });
    expect(href).toBe("/transactions?asOf=2012-01-01");
  });

  it("leaves an untouched axis alone", () => {
    const href = withTimeTravel("/transactions?asOf=2011-10-01", {
      asKnownAt: "2026-09-11T04:29:32.382Z",
    });
    expect(href).toContain("asOf=2011-10-01");
    expect(href).toContain("asKnownAt=");
  });
});
