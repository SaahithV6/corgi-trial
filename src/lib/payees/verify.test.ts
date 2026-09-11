import { describe, expect, it } from "vitest";

import { NOT_CHECKED, type DirectoryLookup, type RoutingDirectory } from "./directory";
import { NO_IDENTITY_SOURCE, type IdentityNameSource } from "./identity";
import type { BookEntry, PayeeCandidate, PayeeFinding } from "./types";
import {
  accountNumberEntryAgrees,
  assertBlockIsArithmetic,
  decide,
  findConflictingTwin,
  verifyPayee,
} from "./verify";

/**
 * The confirmation step, and above all the block/warn line.
 *
 * The two tests that matter most in this file are
 * "ONLY arithmetic blocks" and "a name mismatch never blocks". Everything
 * else is the machinery that makes them true.
 */

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function candidate(over: Partial<PayeeCandidate> = {}): PayeeCandidate {
  return {
    businessId: BUSINESS,
    displayName: "Green coffee supplier",
    holderName: "Ridgeline Coffee Roasters LLC",
    rail: "ach",
    routingNumber: "011401533",
    accountNumberLast4: "4417",
    accountType: "checking",
    ...over,
  };
}

function directoryReturning(lookup: Partial<DirectoryLookup>): RoutingDirectory {
  const full: DirectoryLookup = { ...NOT_CHECKED, ...lookup };
  return { environment: full.environment, lookup: () => Promise.resolve(full) };
}

const FOUND = directoryReturning({
  status: "found",
  provider: "increase.routing_numbers",
  institutionName: "First Bank of the United States",
  achSupported: true,
  wireSupported: true,
  environment: "sandbox",
});

function codes(findings: readonly PayeeFinding[]): readonly string[] {
  return findings.map((f) => f.code);
}

/* -------------------------------------------------------------------------- */

describe("ONLY arithmetic blocks", () => {
  it("a failed check digit blocks, and cannot be acknowledged", async () => {
    const check = await verifyPayee(candidate({ routingNumber: "011401534" }));

    expect(check.decision).toBe("blocked");
    expect(check.acknowledgeable).toBe(false);
    expect(check.checksumOk).toBe(false);
    expect(codes(check.findings)).toContain("ROUTING_CHECKSUM_FAILED");
    expect(check.findings.filter((f) => f.severity === "block")).toHaveLength(1);
  });

  it("names a transposition when one explains the failure, and never applies it", async () => {
    // 101401533 is 011401533 with the first two digits swapped.
    const check = await verifyPayee(candidate({ routingNumber: "101401533" }));
    expect(check.decision).toBe("blocked");
    expect(check.nearMisses.map((m) => m.candidate)).toContain("011401533");
    expect(check.nearMisses.every((m) => m.kind === "transposition")).toBe(true);
    const blocking = check.findings.find((f) => f.severity === "block");
    expect(blocking?.detail).toContain("011401533");
    // And it tells the reader not to take our word for it.
    expect(blocking?.detail).toContain("paperwork");
  });

  it("does NOT offer single-digit suggestions, because there are always exactly nine", async () => {
    const check = await verifyPayee(candidate({ routingNumber: "011401534" }));
    expect(check.decision).toBe("blocked");
    // No adjacent swap explains this one, so there is nothing to suggest.
    expect(check.nearMisses).toEqual([]);
    const blocking = check.findings.find((f) => f.severity === "block");
    expect(blocking?.detail).toContain("wrong document");
    expect(blocking?.detail).not.toContain("011401533");
  });

  it("does not ask the directory about a number that cannot exist", async () => {
    let asked = false;
    const spy: RoutingDirectory = {
      environment: "sandbox",
      lookup: () => {
        asked = true;
        return Promise.resolve(NOT_CHECKED);
      },
    };
    await verifyPayee(candidate({ routingNumber: "011401534" }), { directory: spy });
    expect(asked).toBe(false);
  });

  it("the assertion refuses a block that is not arithmetic", () => {
    // The guard against the easiest possible future mistake: one word in an
    // object literal turning a warning into a wall nobody can override.
    const smuggled: PayeeFinding[] = [
      { code: "NAME_NO_MATCH", severity: "block", title: "x", detail: "y" },
    ];
    expect(() => assertBlockIsArithmetic("blocked", smuggled)).toThrow(/Only ROUTING_CHECKSUM_FAILED/);
  });

  it("the assertion refuses a decision that disagrees with its findings", () => {
    expect(() => assertBlockIsArithmetic("blocked", [])).toThrow(/disagrees/);
    expect(() =>
      assertBlockIsArithmetic("warned", [
        { code: "ROUTING_CHECKSUM_FAILED", severity: "block", title: "x", detail: "y" },
      ]),
    ).toThrow(/disagrees/);
  });
});

describe("a name mismatch NEVER blocks", () => {
  const linkedSource = (holderName: string, score: number): IdentityNameSource => ({
    match: () =>
      Promise.resolve({
        available: true,
        check: {
          provider: "plaid.identity_match",
          providerScore: score,
          holderName,
          accountId: "acct",
          accountMask: "4417",
          isFirstOrLastNameMatch: null,
          isNicknameMatch: null,
          isBusinessNameDetected: null,
          requestId: "req",
        },
      }),
  });

  it("a total mismatch warns, and stays acknowledgeable", async () => {
    const check = await verifyPayee(
      candidate({ plaidAccessToken: "access-sandbox-x" }),
      { directory: FOUND, identity: linkedSource("Quartermain Logistics Inc", 12) },
    );

    expect(check.decision).toBe("warned");
    expect(check.acknowledgeable).toBe(true);
    expect(check.name.outcome).toBe("no_match");
    expect(codes(check.findings)).toContain("NAME_NO_MATCH");
    expect(check.findings.every((f) => f.severity !== "block")).toBe(true);
  });

  it("a close match warns and says which two names differ", async () => {
    const check = await verifyPayee(
      candidate({ plaidAccessToken: "t", holderName: "Ridgeline Coffee Roastery LLC" }),
      { directory: FOUND, identity: linkedSource("Ridgeline Coffee Roasters LLC", 93) },
    );

    expect(check.decision).toBe("warned");
    expect(check.name.outcome).toBe("close_match");
    const finding = check.findings.find((f) => f.code === "NAME_CLOSE_MATCH");
    expect(finding?.detail).toContain("Ridgeline Coffee Roastery LLC");
    expect(finding?.detail).toContain("Ridgeline Coffee Roasters LLC");
  });

  it("two opinions that disagree drop the band rather than averaging", async () => {
    // Plaid says 100; our structural comparison says the terminal word is
    // different. That disagreement is exactly the case a human should see,
    // and an average would hide it.
    const check = await verifyPayee(
      candidate({ plaidAccessToken: "t", holderName: "Ridgeline Coffee" }),
      { directory: FOUND, identity: linkedSource("Ridgeline Coffee Roasters LLC", 100) },
    );
    expect(check.name.outcome).not.toBe("match");
    expect(check.name.providerScore).toBe(100);
    expect(check.decision).toBe("warned");
  });

  it("a real match from a linked account is a note, not a warning", async () => {
    const check = await verifyPayee(
      candidate({ plaidAccessToken: "t" }),
      { directory: FOUND, identity: linkedSource("Ridgeline Coffee Roasters, L.L.C.", 100) },
    );
    expect(check.decision).toBe("verified");
    expect(check.name.outcome).toBe("match");
    expect(check.name.source).toBe("linked_account_holder");
    expect(check.name.provider).toBe("plaid.identity_match");
    expect(check.name.counterpartyName).toBe("Ridgeline Coffee Roasters, L.L.C.");
  });
});

describe("the honest default: nobody can be asked", () => {
  it("says so on its face, as a note, and does not warn", async () => {
    const check = await verifyPayee(candidate(), { directory: FOUND });

    expect(check.name.outcome).toBe("unavailable");
    expect(check.name.source).toBe("payer_asserted");
    expect(check.name.provider).toBe(null);
    expect(check.name.counterpartyName).toBe(null);
    const finding = check.findings.find((f) => f.code === "NAME_NOT_VERIFIABLE");
    expect(finding?.severity).toBe("note");
    expect(finding?.detail).toContain("no Confirmation of Payee network");
    // A note stops nothing.
    expect(check.decision).toBe("verified");
  });

  it("a linked account we could not reach does NOT silently become payer_asserted with a score", async () => {
    const broken: IdentityNameSource = {
      match: () => Promise.resolve({ available: false, reason: "Plaid is down." }),
    };
    const check = await verifyPayee(candidate({ plaidAccessToken: "t" }), {
      directory: FOUND,
      identity: broken,
    });
    expect(check.name.outcome).toBe("unavailable");
    expect(check.name.score).toBe(null);
    expect(check.name.provider).toBe(null);
  });
});

describe("the directory leg", () => {
  it("a hit is a note that says what it does and does not prove", async () => {
    const check = await verifyPayee(candidate(), { directory: FOUND });
    const finding = check.findings.find((f) => f.code === "DIRECTORY_CONFIRMED");
    expect(finding?.severity).toBe("note");
    expect(finding?.detail).toContain("nothing about the account number");
    expect(check.institutionName).toBe("First Bank of the United States");
  });

  it("a miss in SANDBOX is a note, because every real routing number misses", async () => {
    const check = await verifyPayee(candidate(), {
      directory: directoryReturning({
        status: "not_listed",
        provider: "increase.routing_numbers",
        environment: "sandbox",
      }),
    });
    expect(check.findings.find((f) => f.code === "DIRECTORY_NOT_LISTED")?.severity).toBe("note");
    expect(check.decision).toBe("verified");
  });

  it("the same miss in PRODUCTION is a warning", async () => {
    const check = await verifyPayee(candidate(), {
      directory: directoryReturning({
        status: "not_listed",
        provider: "increase.routing_numbers",
        environment: "production",
      }),
    });
    expect(check.findings.find((f) => f.code === "DIRECTORY_NOT_LISTED")?.severity).toBe("warn");
    expect(check.decision).toBe("warned");
  });

  it("an institution that does not take the chosen rail warns", async () => {
    const check = await verifyPayee(candidate({ rail: "ach" }), {
      directory: directoryReturning({
        status: "found",
        provider: "increase.routing_numbers",
        institutionName: "Wires Only Bank",
        achSupported: false,
        wireSupported: true,
      }),
    });
    expect(codes(check.findings)).toContain("DIRECTORY_RAIL_UNSUPPORTED");
    expect(check.decision).toBe("warned");
    expect(check.findings.find((f) => f.code === "DIRECTORY_RAIL_UNSUPPORTED")?.detail).toContain(
      "wire routing number",
    );
  });

  it("an unreachable directory is a note, not a warning and not an outage", async () => {
    const check = await verifyPayee(candidate(), {
      directory: directoryReturning({ status: "unavailable", unavailableReason: "ECONNRESET" }),
    });
    const finding = check.findings.find((f) => f.code === "DIRECTORY_UNAVAILABLE");
    expect(finding?.severity).toBe("note");
    expect(finding?.detail).toContain("ECONNRESET");
    expect(check.decision).toBe("verified");
  });

  it("no directory at all is not_checked, and evidence is simulated", async () => {
    const check = await verifyPayee(candidate());
    expect(check.directory).toBe("not_checked");
    expect(check.evidence).toBe("simulated");
  });

  it("evidence is live only when a provider actually answered", async () => {
    expect((await verifyPayee(candidate(), { directory: FOUND })).evidence).toBe("live");
    expect(
      (
        await verifyPayee(candidate(), {
          directory: directoryReturning({ status: "unavailable", unavailableReason: "down" }),
        })
      ).evidence,
    ).toBe("simulated");
  });
});

describe("the unallocated-prefix warning", () => {
  it("warns and does not block, because the allocation is a registry not arithmetic", async () => {
    // 450000003: check digit holds, prefix 45 was never allocated.
    const check = await verifyPayee(candidate({ routingNumber: "450000003" }));
    expect(check.checksumOk).toBe(true);
    expect(check.prefixAssigned).toBe(false);
    expect(check.decision).toBe("warned");
    expect(check.acknowledgeable).toBe(true);
    const finding = check.findings.find((f) => f.code === "ROUTING_PREFIX_UNALLOCATED");
    expect(finding?.severity).toBe("warn");
    expect(finding?.detail).toContain("registry");
  });
});

describe("the twin probe — the only account-number check we have", () => {
  const book: readonly BookEntry[] = [
    {
      id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      holderName: "RIDGELINE COFFEE ROASTERS, L.L.C.",
      rail: "ach",
      routingNumber: "011401533",
      accountNumberLast4: "4417",
    },
  ];

  it("finds the same payee at different bank details", async () => {
    const check = await verifyPayee(candidate({ accountNumberLast4: "9002" }), { book });
    expect(codes(check.findings)).toContain("TWIN_WITH_DIFFERENT_DETAILS");
    expect(check.decision).toBe("warned");
    expect(
      check.findings.find((f) => f.code === "TWIN_WITH_DIFFERENT_DETAILS")?.detail,
    ).toContain("channel you already had");
  });

  it("matches through normalisation, which is how the duplicate got there", async () => {
    // The book row is spelled `RIDGELINE COFFEE ROASTERS, L.L.C.` and the
    // candidate `Ridgeline Coffee Roasters LLC`. A byte comparison would miss
    // this, and a slightly different spelling is exactly WHY a second record
    // exists.
    expect(findConflictingTwin(candidate({ accountNumberLast4: "9002" }), book)).not.toBe(null);
  });

  it("says nothing when the details are the same", async () => {
    const check = await verifyPayee(candidate(), { book });
    expect(codes(check.findings)).not.toContain("TWIN_WITH_DIFFERENT_DETAILS");
  });

  it("says nothing for a genuinely different payee", () => {
    expect(findConflictingTwin(candidate({ holderName: "Quartermain Logistics" }), book)).toBe(
      null,
    );
  });
});

describe("rails with nothing to check", () => {
  it("a USDC payout has no routing number and is not warned about", async () => {
    const check = await verifyPayee(
      candidate({
        rail: "usdc",
        routingNumber: undefined,
        accountNumberLast4: undefined,
        accountType: undefined,
      }),
      { directory: FOUND },
    );
    expect(check.checksumOk).toBe(true);
    expect(check.routingNumber).toBe(null);
    expect(check.directory).toBe("not_checked");
    expect(check.decision).toBe("verified");
  });
});

describe("account-number re-entry, which is not verification", () => {
  it("agrees on identical entries, ignoring separators", () => {
    expect(accountNumberEntryAgrees("123456789", "1234 5678 9")).toBe(true);
    expect(accountNumberEntryAgrees("1234-5678-9", "123456789")).toBe(true);
  });

  it("disagrees on a single wrong digit and on empty input", () => {
    expect(accountNumberEntryAgrees("123456789", "123456798")).toBe(false);
    expect(accountNumberEntryAgrees("", "")).toBe(false);
  });
});

describe("decide()", () => {
  it("is worst-severity-wins and nothing else", () => {
    const note: PayeeFinding = { code: "DIRECTORY_CONFIRMED", severity: "note", title: "", detail: "" };
    const warn: PayeeFinding = { code: "NAME_NO_MATCH", severity: "warn", title: "", detail: "" };
    const block: PayeeFinding = {
      code: "ROUTING_CHECKSUM_FAILED",
      severity: "block",
      title: "",
      detail: "",
    };
    expect(decide([])).toBe("verified");
    expect(decide([note, note])).toBe("verified");
    expect(decide([note, warn])).toBe("warned");
    expect(decide([note, warn, block])).toBe("blocked");
  });
});

describe("it never throws and never moves money", () => {
  it("survives hostile input on every field", async () => {
    for (const routingNumber of ["", "x".repeat(500), "٠١٢٣٤٥٦٧٨", "000000000"]) {
      await expect(
        verifyPayee(candidate({ routingNumber }), {
          directory: FOUND,
          identity: NO_IDENTITY_SOURCE,
        }),
      ).resolves.toBeDefined();
    }
  });

  it("survives a directory that throws", async () => {
    const exploding: RoutingDirectory = {
      environment: "sandbox",
      lookup: () => Promise.reject(new Error("boom")),
    };
    // A directory adapter is contracted never to throw; if one does, the
    // rejection surfaces here rather than being swallowed into a fake
    // "verified". A silent pass is the one outcome this feature must not
    // produce.
    await expect(verifyPayee(candidate(), { directory: exploding })).rejects.toThrow("boom");
  });
});
