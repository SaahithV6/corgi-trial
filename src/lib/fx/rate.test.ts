import { describe, expect, it } from "vitest";

import {
  FIXED_RATE_TABLE,
  FIXED_TABLE_DATE,
  FRANKFURTER_SOURCE,
  extractRateLiteral,
  fetchMidRate,
  fixedRate,
  frankfurterUrl,
  observeRate,
  parseDecimalToScaled,
  rateAgeDays,
} from "./rate";
import { CORRIDOR_CODES, RATE_SCALE } from "./types";

/** The exact body measured from the live endpoint on 2026-09-10. */
const REAL_BODY =
  '{"amount":1.0,"base":"USD","date":"2026-09-10",' +
  '"rates":{"BRL":5.1247,"INR":95.44,"JPY":154.18,"MXN":16.9435,"PHP":62.576}}';

function respond(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

function rejectWith(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe("parseDecimalToScaled — the whole no-floats claim in one function", () => {
  it("scales by string surgery, not by multiplication", () => {
    expect(parseDecimalToScaled("16.9435")).toBe(1_694_350_000n);
    expect(parseDecimalToScaled("95.44")).toBe(9_544_000_000n);
    expect(parseDecimalToScaled("154.18")).toBe(15_418_000_000n);
    expect(parseDecimalToScaled("1")).toBe(100_000_000n);
  });

  it("is exact where the float route is not", () => {
    // 0.1 + 0.2 !== 0.3 in a double, and Math.round(0.145 * 1e8) is not what
    // anyone predicts either. The string route has no such surprises.
    expect(parseDecimalToScaled("0.1")).toBe(10_000_000n);
    expect(parseDecimalToScaled("0.145")).toBe(14_500_000n);
    expect(parseDecimalToScaled("1.005")).toBe(100_500_000n);
  });

  it("truncates past the scale rather than rounding to an unnamed direction", () => {
    // Ten decimals at a scale of eight.
    expect(parseDecimalToScaled("1.2345678999")).toBe(123_456_789n);
  });

  it("refuses anything that is not a plain decimal", () => {
    for (const bad of ["", "  ", "-1.5", "1.6e1", "1,5", "abc", "1.2.3", "0", "0.0"]) {
      expect(parseDecimalToScaled(bad)).toBeNull();
    }
  });

  it("refuses a scale that is not a power of ten", () => {
    expect(() => parseDecimalToScaled("1.5", 3n)).toThrow(/power of ten/);
  });
});

describe("extractRateLiteral — reading the response as text", () => {
  it("lifts the literal characters out of the real body", () => {
    expect(extractRateLiteral(REAL_BODY, "MXN")).toBe("16.9435");
    expect(extractRateLiteral(REAL_BODY, "JPY")).toBe("154.18");
    expect(extractRateLiteral(REAL_BODY, "PHP")).toBe("62.576");
  });

  it("returns null for a currency the response does not carry", () => {
    expect(extractRateLiteral(REAL_BODY, "ZAR")).toBeNull();
  });

  it("only reads inside the rates object", () => {
    // `USD` appears as the base, not as a rate. It must not be readable as one.
    expect(extractRateLiteral(REAL_BODY, "USD")).toBeNull();
  });

  it("does not match a code embedded in a longer key", () => {
    const body = '{"date":"2026-09-10","rates":{"XINR":1.5}}';
    expect(extractRateLiteral(body, "INR")).toBeNull();
  });

  it("returns null for a body with no rates object at all", () => {
    expect(extractRateLiteral('{"error":"nope"}', "MXN")).toBeNull();
  });
});

describe("fetchMidRate", () => {
  it("builds the call the docs quote", () => {
    expect(frankfurterUrl(["MXN"])).toBe(
      "https://api.frankfurter.dev/v1/latest?base=USD&symbols=MXN",
    );
    expect(frankfurterUrl()).toContain(CORRIDOR_CODES.join(","));
  });

  it("returns a live observation carrying its own evidence", async () => {
    const observation = await fetchMidRate("MXN", { fetchImpl: respond(REAL_BODY) });
    expect(observation.evidence).toBe("live");
    expect(observation.source).toBe(FRANKFURTER_SOURCE);
    expect(observation.httpStatus).toBe(200);
    expect(observation.rateScaled).toBe(1_694_350_000n);
    expect(observation.rateScale).toBe(RATE_SCALE);
    expect(observation.literal).toBe("16.9435");
    // The SOURCE's date, not today's.
    expect(observation.rateDate).toBe("2026-09-10");
    expect(observation.fallbackReason).toBeNull();
  });

  it("throws rather than falling back on its own", async () => {
    await expect(fetchMidRate("MXN", { fetchImpl: respond("nope", 503) })).rejects.toThrow(/503/);
    await expect(fetchMidRate("MXN", { fetchImpl: rejectWith("ECONNRESET") })).rejects.toThrow(
      /did not answer/,
    );
  });

  it("refuses a 200 that carries no usable rate", async () => {
    await expect(
      fetchMidRate("MXN", { fetchImpl: respond('{"date":"2026-09-10","rates":{}}') }),
    ).rejects.toThrow(/no plain decimal/);
  });

  it("refuses a 200 that carries no rate date", async () => {
    // Without the source's own date the screen cannot say "this is Friday's
    // rate, fetched on Saturday", which on a daily reference feed is the
    // difference between a fact and a misrepresentation.
    await expect(
      fetchMidRate("MXN", { fetchImpl: respond('{"rates":{"MXN":16.9435}}') }),
    ).rejects.toThrow(/without a rate date/);
  });
});

describe("the labelled fallback", () => {
  it("is simulated, carries its reason, and never claims today's date", () => {
    const observation = fixedRate("MXN", "the source returned 503");
    expect(observation.evidence).toBe("simulated");
    expect(observation.source).toBe("fixed-table");
    expect(observation.fallbackReason).toBe("the source returned 503");
    expect(observation.rateDate).toBe(FIXED_TABLE_DATE);
  });

  it("holds a parseable literal for every corridor", () => {
    for (const code of CORRIDOR_CODES) {
      const literal = FIXED_RATE_TABLE.get(code);
      expect(literal, `no fixed rate for ${code}`).toBeDefined();
      expect(parseDecimalToScaled(literal ?? "")).not.toBeNull();
    }
  });
});

describe("observeRate — degrade, labelled, never silently", () => {
  it("prefers the live source", async () => {
    const observation = await observeRate("MXN", { fetchImpl: respond(REAL_BODY) });
    expect(observation.evidence).toBe("live");
  });

  it("falls back with the reason attached when the source is down", async () => {
    const observation = await observeRate("MXN", { fetchImpl: respond("boom", 500) });
    expect(observation.evidence).toBe("simulated");
    expect(observation.httpStatus).toBe(500);
    expect(observation.fallbackReason).toMatch(/500/);
    expect(observation.rateScaled).toBe(1_694_350_000n);
  });

  it("falls back when there is no network at all", async () => {
    const observation = await observeRate("PHP", { fetchImpl: rejectWith("getaddrinfo ENOTFOUND") });
    expect(observation.evidence).toBe("simulated");
    expect(observation.httpStatus).toBeNull();
    expect(observation.fallbackReason).toMatch(/ENOTFOUND/);
  });

  it("never returns a live label without an HTTP status behind it", async () => {
    for (const impl of [respond(REAL_BODY), respond("x", 404), rejectWith("nope")]) {
      const observation = await observeRate("MXN", { fetchImpl: impl });
      if (observation.evidence === "live") expect(observation.httpStatus).not.toBeNull();
    }
  });
});

describe("rateAgeDays", () => {
  it("measures against an explicit now, never Date.now()", () => {
    expect(rateAgeDays("2026-09-10", "2026-09-10T18:00:00.000Z")).toBe(0);
    expect(rateAgeDays("2026-09-10", "2026-09-12T00:30:00.000Z")).toBe(2);
  });

  it("clamps a future date to zero rather than printing a negative age", () => {
    expect(rateAgeDays("2026-09-20", "2026-09-10T00:00:00.000Z")).toBe(0);
  });

  it("returns null for an unparseable instant", () => {
    expect(rateAgeDays("not-a-date", "2026-09-10T00:00:00.000Z")).toBeNull();
  });
});
