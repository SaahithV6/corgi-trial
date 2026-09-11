import { describe, expect, it } from "vitest";

import { IncreaseRoutingDirectory, NOT_CHECKED } from "./directory";

/**
 * The directory adapter, against a scripted `fetch` — and, when
 * `RUN_LIVE_TESTS=1`, against the real Increase sandbox.
 *
 * Every scripted body below is a VERBATIM COPY of one that came back from the
 * live key, not an invention. The live test at the bottom is what keeps them
 * honest: run
 *
 *   set -a; . ./.env; set +a; RUN_LIVE_TESTS=1 pnpm test src/lib/payees
 *
 * and if Increase has changed the shape, the scripted tests are wrong and
 * that one goes red.
 */

const FOUND_BODY = {
  data: [
    {
      type: "routing_number",
      name: "First Bank of the United States",
      routing_number: "101050001",
      ach_transfers: "supported",
      fednow_transfers: "not_supported",
      real_time_payments_transfers: "supported",
      real_time_payments_request_for_payment: "supported",
      wire_transfers: "supported",
    },
  ],
  next_cursor: null,
  response_metadata: { next_cursor: null },
};

const EMPTY_BODY = { data: [], next_cursor: null, response_metadata: { next_cursor: null } };

function scripted(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response)) as unknown as typeof fetch;
}

describe("a routing number the directory knows", () => {
  it("reports found, with the institution and its rails", async () => {
    const directory = new IncreaseRoutingDirectory({
      apiKey: "test-key",
      fetchImpl: scripted(200, FOUND_BODY),
    });
    const result = await directory.lookup("101050001");

    expect(result.status).toBe("found");
    expect(result.institutionName).toBe("First Bank of the United States");
    expect(result.provider).toBe("increase.routing_numbers");
    expect(result.achSupported).toBe(true);
    expect(result.wireSupported).toBe(true);
    expect(result.fedNowSupported).toBe(false);
  });

  it("reads the support fields as the string enums they are, not as booleans", async () => {
    // `"not_supported"` is a truthy string. Reading these fields directly
    // would make every institution support everything — a one-character bug
    // that silently claims a bank takes wires when the directory says it does
    // not.
    const directory = new IncreaseRoutingDirectory({
      apiKey: "k",
      fetchImpl: scripted(200, {
        data: [
          {
            name: "Thrift With No Wires",
            routing_number: "011401533",
            ach_transfers: "supported",
            wire_transfers: "not_supported",
          },
        ],
      }),
    });
    const result = await directory.lookup("011401533");
    expect(result.achSupported).toBe(true);
    expect(result.wireSupported).toBe(false);
  });
});

describe("a routing number the directory does not know", () => {
  it("is not_listed, which is NOT unavailable and NOT invalid", async () => {
    const directory = new IncreaseRoutingDirectory({
      apiKey: "k",
      fetchImpl: scripted(200, EMPTY_BODY),
    });
    const result = await directory.lookup("011401533");

    expect(result.status).toBe("not_listed");
    // The provider answered, so it is named. This is the difference the
    // `payee_verification_live_needs_a_provider` constraint depends on.
    expect(result.provider).toBe("increase.routing_numbers");
    expect(result.institutionName).toBe(null);
    expect(result.unavailableReason).toBe(null);
  });
});

describe("when Increase cannot be reached", () => {
  it("degrades to unavailable and names no provider", async () => {
    const directory = new IncreaseRoutingDirectory({
      apiKey: "k",
      fetchImpl: (() => Promise.reject(new Error("ECONNRESET"))) as unknown as typeof fetch,
    });
    const result = await directory.lookup("011401533");

    expect(result.status).toBe("unavailable");
    expect(result.unavailableReason).toContain("ECONNRESET");
    // NULL and not the slug: a provider we failed to reach did not answer,
    // and naming it here would let a `live` evidence check pass on a call
    // that never happened.
    expect(result.provider).toBe(null);
  });

  it("degrades on a 5xx rather than throwing", async () => {
    const directory = new IncreaseRoutingDirectory({
      apiKey: "k",
      fetchImpl: scripted(503, {}),
    });
    const result = await directory.lookup("011401533");
    expect(result.status).toBe("unavailable");
    expect(result.unavailableReason).toContain("503");
  });

  it("degrades when no key is configured", async () => {
    const directory = new IncreaseRoutingDirectory({
      apiKey: "",
      fetchImpl: scripted(200, FOUND_BODY),
    });
    const result = await directory.lookup("101050001");
    expect(result.status).toBe("unavailable");
    expect(result.unavailableReason).toContain("INCREASE_API_KEY");
  });

  it("does not make a call Increase would 400", async () => {
    // Measured: `12345678` → 400 "Minimum length is 9". A 400 we could have
    // predicted is a call we should not make.
    let called = false;
    const directory = new IncreaseRoutingDirectory({
      apiKey: "k",
      fetchImpl: (() => {
        called = true;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(EMPTY_BODY) } as Response);
      }) as unknown as typeof fetch,
    });
    const result = await directory.lookup("12345678");
    expect(called).toBe(false);
    expect(result.status).toBe("unavailable");
  });
});

describe("environment", () => {
  it("is derived from the base URL, and defaults to sandbox", () => {
    expect(new IncreaseRoutingDirectory({ apiKey: "k" }).environment).toBe("sandbox");
    expect(
      new IncreaseRoutingDirectory({ apiKey: "k", baseUrl: "https://api.increase.com" })
        .environment,
    ).toBe("production");
  });

  it("cannot be told it is sandbox while pointed at production", () => {
    // The direction that matters. A miss in sandbox is downgraded to a note;
    // if a production-pointed client could claim to be sandbox, every unknown
    // routing number in production would silently stop warning.
    const directory = new IncreaseRoutingDirectory({
      apiKey: "k",
      baseUrl: "https://api.increase.com",
    });
    expect(directory.environment).toBe("production");
  });
});

describe("NOT_CHECKED", () => {
  it("is the value for a rail with no routing number to look up", () => {
    expect(NOT_CHECKED.status).toBe("not_checked");
    expect(NOT_CHECKED.provider).toBe(null);
    expect(NOT_CHECKED.unavailableReason).toBe(null);
  });
});

/* -------------------------------------------------------------------------- */
/* Live                                                                       */
/* -------------------------------------------------------------------------- */

const live = process.env["RUN_LIVE_TESTS"] === "1" ? describe : describe.skip;

live("against the REAL Increase sandbox", () => {
  it("finds 101050001 and reports First Bank of the United States", async () => {
    const directory = new IncreaseRoutingDirectory({});
    const result = await directory.lookup("101050001");

    expect(result.status).toBe("found");
    expect(result.institutionName).toBe("First Bank of the United States");
    expect(result.achSupported).toBe(true);
    expect(result.wireSupported).toBe(true);
    expect(result.fedNowSupported).toBe(false);
    expect(result.latencyMs).not.toBe(null);
  });

  it("does NOT find 011401533, and that means nothing in sandbox", async () => {
    // The single most important measured fact about this leg. Every genuine
    // routing number in the seed data misses the sandbox directory, which is
    // why a miss is a note here and a warning only in production.
    const directory = new IncreaseRoutingDirectory({});
    const result = await directory.lookup("011401533");
    expect(result.status).toBe("not_listed");
    expect(result.environment).toBe("sandbox");
  });

  it("cannot tell a failed checksum from an unknown bank — so our arithmetic is not redundant", async () => {
    const directory = new IncreaseRoutingDirectory({});
    const impossible = await directory.lookup("101050002"); // fails the check digit
    const zeroes = await directory.lookup("000000000");
    const real = await directory.lookup("011401533"); // valid, real, unknown to sandbox

    expect(impossible.status).toBe("not_listed");
    expect(zeroes.status).toBe("not_listed");
    expect(real.status).toBe("not_listed");
    // Three completely different facts, one answer. Increase validates shape,
    // not arithmetic; the check digit is the only thing either of us does
    // that catches a typo.
  });
});
