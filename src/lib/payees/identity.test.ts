import { describe, expect, it } from "vitest";

import { NO_IDENTITY_SOURCE, PlaidIdentityNameSource } from "./identity";
import { compareNames } from "./name-match";

/**
 * The name source. Scripted bodies are verbatim copies of live responses;
 * `RUN_LIVE_TESTS=1` runs the real thing.
 *
 *   set -a; . ./.env; set +a; RUN_LIVE_TESTS=1 pnpm test src/lib/payees
 */

const MATCH_BODY = {
  accounts: [
    {
      account_id: "3myo4NdrqMTvo88ev1nLHdg1qj5BEoC78xKaj",
      mask: "0000",
      name: "Plaid Checking",
      official_name: "Plaid Gold Standard 0% Interest Checking",
      holder_category: "personal",
      legal_name: {
        is_business_name_detected: false,
        is_first_name_or_last_name_match: true,
        is_nickname_match: false,
        score: 100,
      },
      address: { is_postal_code_match: null, score: null },
      email_address: { score: null },
      phone_number: { score: null },
    },
  ],
  request_id: "2e9e40e8e27ac2e",
};

const IDENTITY_BODY = {
  accounts: [
    {
      account_id: "3myo4NdrqMTvo88ev1nLHdg1qj5BEoC78xKaj",
      owners: [{ names: ["Alberta Bobbeth Charleson"] }],
    },
  ],
  request_id: "a1b2c3",
};

function scripted(byPath: Record<string, unknown>): typeof fetch {
  return ((url: string) => {
    const path = new URL(url).pathname;
    const body = byPath[path];
    if (body === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response);
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
  }) as unknown as typeof fetch;
}

describe("an account somebody linked to us", () => {
  it("returns the institution's own score and the holder name", async () => {
    const source = new PlaidIdentityNameSource({
      clientId: "id",
      secret: "secret",
      fetchImpl: scripted({ "/identity/match": MATCH_BODY, "/identity/get": IDENTITY_BODY }),
    });

    const result = await source.match({
      accessToken: "access-sandbox-x",
      legalName: "Alberta Bobbeth Charleson",
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.check.provider).toBe("plaid.identity_match");
    expect(result.check.providerScore).toBe(100);
    expect(result.check.holderName).toBe("Alberta Bobbeth Charleson");
    expect(result.check.accountMask).toBe("0000");
    expect(result.check.requestId).toBe("2e9e40e8e27ac2e");
  });

  it("skips the name fetch when asked to", async () => {
    const source = new PlaidIdentityNameSource({
      clientId: "id",
      secret: "secret",
      fetchHolderName: false,
      fetchImpl: scripted({ "/identity/match": MATCH_BODY }),
    });
    const result = await source.match({ accessToken: "t", legalName: "Alberta" });
    expect(result.available).toBe(true);
    if (result.available) expect(result.check.holderName).toBe(null);
  });
});

describe("a null score is 'not checked', not 'no match'", () => {
  it("reports unavailable when the institution holds no name", async () => {
    const source = new PlaidIdentityNameSource({
      clientId: "id",
      secret: "secret",
      fetchImpl: scripted({
        "/identity/match": {
          accounts: [{ account_id: "a", legal_name: { score: null } }],
          request_id: "r",
        },
      }),
    });
    const result = await source.match({ accessToken: "t", legalName: "Anyone" });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("holds no name");
  });
});

describe("degradation", () => {
  it("is unavailable with no credentials, and does not throw", async () => {
    const source = new PlaidIdentityNameSource({
      clientId: undefined,
      secret: undefined,
      fetchImpl: scripted({}),
    });
    // Guard against a real env leaking into the assertion.
    const savedId = process.env["PLAID_CLIENT_ID"];
    const savedSecret = process.env["PLAID_SECRET"];
    delete process.env["PLAID_CLIENT_ID"];
    delete process.env["PLAID_SECRET"];
    try {
      const result = await source.match({ accessToken: "t", legalName: "Anyone" });
      expect(result.available).toBe(false);
    } finally {
      if (savedId !== undefined) process.env["PLAID_CLIENT_ID"] = savedId;
      if (savedSecret !== undefined) process.env["PLAID_SECRET"] = savedSecret;
    }
  });

  it("is unavailable when Plaid errors, and does not throw", async () => {
    const source = new PlaidIdentityNameSource({
      clientId: "id",
      secret: "secret",
      fetchImpl: (() => Promise.reject(new Error("boom"))) as unknown as typeof fetch,
    });
    const result = await source.match({ accessToken: "t", legalName: "Anyone" });
    expect(result.available).toBe(false);
  });

  it("refuses to match an empty name", async () => {
    const source = new PlaidIdentityNameSource({ clientId: "id", secret: "secret" });
    const result = await source.match({ accessToken: "t", legalName: "   " });
    expect(result.available).toBe(false);
  });
});

describe("NO_IDENTITY_SOURCE", () => {
  it("says plainly that there is nobody to ask", async () => {
    const result = await NO_IDENTITY_SOURCE.match({ accessToken: "x", legalName: "y" });
    expect(result.available).toBe(false);
    if (!result.available) {
      expect(result.reason).toContain("no US provider");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Live                                                                       */
/* -------------------------------------------------------------------------- */

const live = process.env["RUN_LIVE_TESTS"] === "1" ? describe : describe.skip;

live("against the REAL Plaid sandbox", () => {
  /** Link, without the browser. The sandbox endpoint is not a fake. */
  async function sandboxAccessToken(): Promise<string> {
    const headers = {
      "Content-Type": "application/json",
      "PLAID-CLIENT-ID": process.env["PLAID_CLIENT_ID"] ?? "",
      "PLAID-SECRET": process.env["PLAID_SECRET"] ?? "",
    };
    const created = await fetch("https://sandbox.plaid.com/sandbox/public_token/create", {
      method: "POST",
      headers,
      body: JSON.stringify({
        institution_id: "ins_109508",
        initial_products: ["auth", "identity"],
      }),
    });
    const { public_token } = (await created.json()) as { public_token: string };
    const exchanged = await fetch("https://sandbox.plaid.com/item/public_token/exchange", {
      method: "POST",
      headers,
      body: JSON.stringify({ public_token }),
    });
    const { access_token } = (await exchanged.json()) as { access_token: string };
    return access_token;
  }

  it("scores the exact name at 100 and returns the holder name", async () => {
    const accessToken = await sandboxAccessToken();
    const source = new PlaidIdentityNameSource({});
    const result = await source.match({
      accessToken,
      legalName: "Alberta Bobbeth Charleson",
    });

    expect(result.available).toBe(true);
    if (!result.available) return;
    expect(result.check.providerScore).toBe(100);
    expect(result.check.holderName).toBe("Alberta Bobbeth Charleson");
  });

  it("and OUR comparison agrees with Plaid's on every band", async () => {
    // The calibration, run live. This is what makes the table in
    // name-match.ts's header a measurement rather than a claim.
    const accessToken = await sandboxAccessToken();
    const source = new PlaidIdentityNameSource({ fetchHolderName: false });

    const expected: readonly [string, number, "match" | "close_match" | "no_match"][] = [
      ["Alberta Bobbeth Charleson", 100, "match"],
      ["ALBERTA B CHARLESON", 99, "match"],
      ["Alberta Charleson", 99, "match"],
      ["Alberta Charlson", 93, "close_match"],
      ["Roberto Gonzalez", 28, "no_match"],
      ["Acme Widgets LLC", 0, "no_match"],
    ];

    for (const [typed, plaidScore, band] of expected) {
      const result = await source.match({ accessToken, legalName: typed });
      expect(result.available).toBe(true);
      if (!result.available) continue;
      expect(result.check.providerScore).toBe(plaidScore);
      expect(compareNames(typed, "Alberta Bobbeth Charleson").band).toBe(band);
    }
  });
});
