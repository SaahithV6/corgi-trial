/**
 * The adapter between the journal and the account screen's data contract.
 *
 * Everything here runs against a fake connection, because what is being proven
 * is not that Postgres works. It is that the translation is honest: that money
 * narrows from `bigint` to `number` with an assertion rather than a hope, that
 * `available === ledger − holds − uncleared` holds by construction, that a
 * memo posting reports no ledger effect rather than a zero one, and that a
 * failed read names the real fault instead of borrowing the fixture's code.
 */
import { describe, expect, it } from "vitest";

import { isErr, isOk } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";
import type { HoldRow, LedgerSnapshot, PostingRow, Sql } from "@/lib/ledger/queries";

import {
  DEFAULT_POSTINGS_LIMIT,
  MAX_POSTINGS_LIMIT,
  accountHandleLast4,
  createLiveAccountDataSource,
  describePosting,
  formatPolicyRef,
  formatSourceRef,
  listLiveAccounts,
  shortAccountName,
  toCents,
  toHold,
  toPosting,
  toSummary,
} from "./live-data-source";

/* -------------------------------------------------------------------------- */
/* Fixtures for the fake connection                                           */
/* -------------------------------------------------------------------------- */

type Row = Record<string, unknown>;

const ACCOUNT_ID = "a0c41a37-2be1-5c30-bfe9-03455f048fac";
const AS_OF = new Date("2026-09-10T19:42:00.000Z");

const SNAPSHOT: LedgerSnapshot = {
  asOf: AS_OF,
  valueDate: "2026-09-10",
  bookingWatermark: 160n,
};

const SNAPSHOT_ROW: Row = {
  as_of: AS_OF,
  value_date: "2026-09-10",
  booking_watermark: 160n,
};

const ACCOUNT_ROW: Row = {
  account_id: ACCOUNT_ID,
  business_id: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
  account_name: "Ridgeline Robotics, Inc. — business current account",
  legal_name: "Ridgeline Robotics, Inc.",
  currency: "USD",
};

const ACCOUNT: {
  accountId: string;
  businessId: string;
  accountName: string;
  legalName: string;
  currency: string;
} = {
  accountId: ACCOUNT_ID,
  businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
  accountName: "Ridgeline Robotics, Inc. — business current account",
  legalName: "Ridgeline Robotics, Inc.",
  currency: "USD",
};

function holdRow(overrides: Partial<HoldRow> = {}): HoldRow {
  return {
    holdId: "11111111-1111-5111-9111-111111111111",
    kind: "card_auth",
    descriptor: "Card authorisation · SHELL OIL 1247",
    externalRef: "auth_01K9SHELL",
    authorisedCents: 5_000n,
    clearedCents: 0n,
    remainingCents: 5_000n,
    memoBalanceCents: 5_000n,
    closed: false,
    closedReason: null,
    placedAt: new Date("2026-09-10T18:41:30.000Z"),
    expiresAt: new Date("2026-09-17T18:41:30.000Z"),
    availableAt: null,
    policy: null,
    pending: false,
    authCount: 1,
    eventCount: 1,
    ...overrides,
  };
}

function postingRow(overrides: Partial<PostingRow> = {}): PostingRow {
  return {
    entryId: "22222222-2222-5222-9222-222222222222",
    book: "financial",
    description: "ACH credit · SQUARE INC daily payout",
    occurredAt: new Date("2026-09-10T13:05:00.000Z"),
    valueDate: "2026-09-10",
    bookingDate: "2026-09-10",
    backdated: false,
    backdatedByDays: 0,
    entryType: "original",
    bookingSeq: 158n,
    ledgerDeltaCents: 1_250_000n,
    availableDeltaCents: 1_250_000n,
    holdId: null,
    rail: "ach",
    externalRef: "091000015551234",
    ...overrides,
  };
}

/** Routes by a fragment of the statement, like the query layer's own tests. */
function fakeSql(routes: readonly (readonly [string, readonly Row[]])[]): {
  readonly conn: Sql;
  readonly count: () => number;
} {
  let count = 0;

  const conn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    void values;
    count += 1;
    const text = strings.join(" ? ");
    const route = routes.find(([fragment]) => text.includes(fragment));
    return Promise.resolve(route === undefined ? [] : route[1]);
  };

  return { conn: conn as unknown as Sql, count: () => count };
}

/** A connection that fails the way Postgres does, with a SQLSTATE. */
function failingSql(code: string, message: string): Sql {
  const conn = () =>
    Promise.reject(Object.assign(new Error(message), { code }));
  return conn as unknown as Sql;
}

const HOLDS_ROW: Row = {
  hold_id: "11111111-1111-5111-9111-111111111111",
  kind: "card_auth",
  descriptor: "Card authorisation · SHELL OIL 1247",
  external_ref: "auth_01K9SHELL",
  authorised_cents: 5_000n,
  cleared_cents: 0n,
  remaining_cents: 5_000n,
  memo_cents: 5_000n,
  closed: false,
  closed_reason: null,
  placed_at: new Date("2026-09-10T18:41:30.000Z"),
  expires_at: new Date("2026-09-17T18:41:30.000Z"),
  available_at: null,
  policy_rail: null,
  policy_counterparty_class: null,
  policy_banking_days: null,
  policy_release_time: null,
  auth_count: 1n,
  event_count: 1n,
};

const POSTING_ROW: Row = {
  entry_id: "22222222-2222-5222-9222-222222222222",
  book: "memo",
  description: "Card authorisation · SHELL OIL 1247",
  occurred_at: new Date("2026-09-10T18:41:30.000Z"),
  value_date: "2026-09-10",
  booking_date: "2026-09-10",
  backdated_by_days: 0,
  entry_type: "original",
  booking_seq: 161n,
  ledger_delta_cents: null,
  available_delta_cents: -5_000n,
  hold_id: "11111111-1111-5111-9111-111111111111",
  rail: "card",
  external_ref: "evt_01K9F3Q2M7X",
};

function liveSource(routes: readonly (readonly [string, readonly Row[]])[] = []) {
  const { conn, count } = fakeSql([
    ["book_date(clock_timestamp())", [SNAPSHOT_ROW]],
    ["JOIN business b", [ACCOUNT_ROW]],
    [
      "ledger_availability",
      [
        {
          ledger_cents: 3_329_289n,
          hold_cents: 0n,
          uncleared_cents: 0n,
          pending_outbound_cents: 0n,
          available_cents: 3_329_289n,
        },
      ],
    ],
    ["WITH held", [HOLDS_ROW]],
    ["WITH entries", [POSTING_ROW]],
    ...routes,
  ]);
  return { source: createLiveAccountDataSource({ conn }), conn, count };
}

/* -------------------------------------------------------------------------- */
/* Narrowing money                                                            */
/* -------------------------------------------------------------------------- */

describe("toCents", () => {
  it("narrows an ordinary balance exactly", () => {
    expect(toCents(3_329_289n, "ledger")).toBe(3_329_289);
    expect(toCents(-84_000n, "ledger")).toBe(-84_000);
    expect(toCents(0n, "ledger")).toBe(0);
  });

  it("carries the boundary of exact representation", () => {
    expect(toCents(9_007_199_254_740_991n, "ledger")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("refuses to round a figure it cannot represent", () => {
    // Number(9007199254740993n) is 9007199254740992 — a silent, arbitrary
    // change to a money figure. It fails loudly instead.
    expect(() => toCents(9_007_199_254_740_993n, "ledger balance")).toThrow(
      /ledger balance/,
    );
    expect(() => toCents(-9_007_199_254_740_993n, "ledger")).toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Presentation                                                               */
/* -------------------------------------------------------------------------- */

describe("shortAccountName", () => {
  it("drops the legal-name prefix the seeder writes in", () => {
    expect(
      shortAccountName(
        "Ridgeline Robotics, Inc. — business current account",
        "Ridgeline Robotics, Inc.",
      ),
    ).toBe("Business current account");
  });

  it("leaves a name it did not recognise alone", () => {
    expect(shortAccountName("Operating", "Ridgeline Robotics, Inc.")).toBe(
      "Operating",
    );
  });
});

describe("accountHandleLast4", () => {
  it("shows four characters of the id and never the whole thing", () => {
    expect(accountHandleLast4(ACCOUNT_ID)).toBe("8fac");
    expect(accountHandleLast4(ACCOUNT_ID)).toHaveLength(4);
  });
});

describe("formatPolicyRef", () => {
  it("names the funds-availability policy row a hold was created under", () => {
    expect(
      formatPolicyRef({
        rail: "ach",
        counterpartyClass: "known",
        bankingDaysHold: 2,
        releaseLocalTime: "09:00:00",
      }),
    ).toBe("fap · ach/known, 2 banking days, release 09:00");
  });

  it("says one banking day rather than 1 banking days", () => {
    expect(
      formatPolicyRef({
        rail: "ach",
        counterpartyClass: "new",
        bankingDaysHold: 1,
        releaseLocalTime: "09:00:00",
      }),
    ).toContain("1 banking day,");
  });

  it("is null when a hold carries no policy", () => {
    expect(formatPolicyRef(null)).toBeNull();
  });
});

describe("formatSourceRef", () => {
  it("qualifies the provider's id with the rail it came from", () => {
    expect(formatSourceRef("card", "evt_01K9F3Q2M7X")).toBe(
      "card:evt_01K9F3Q2M7X",
    );
    expect(formatSourceRef(null, "evt_1")).toBe("evt_1");
    expect(formatSourceRef("ach", null)).toBeNull();
  });
});

describe("describePosting", () => {
  it("says a correction was backdated rather than leaving it to be inferred", () => {
    expect(
      describePosting({
        description: "Planted settlement PLANT-2, re-booked",
        backdated: true,
        valueDate: "2011-04-26",
      }),
    ).toBe("Planted settlement PLANT-2, re-booked · backdated to 2011-04-26");
  });

  it("leaves a same-day posting untouched", () => {
    expect(
      describePosting({
        description: "ACH credit · SQUARE INC",
        backdated: false,
        valueDate: "2026-09-10",
      }),
    ).toBe("ACH credit · SQUARE INC");
  });
});

/* -------------------------------------------------------------------------- */
/* Row → contract                                                             */
/* -------------------------------------------------------------------------- */

describe("toHold", () => {
  it("carries A(E), C(E) and H(E) across as separate terms", () => {
    const hold = toHold(
      holdRow({ authorisedCents: 90_000n, clearedCents: 64_000n, remainingCents: 26_000n }),
    );
    expect(hold.authorisedCents).toBe(90_000);
    expect(hold.clearedCents).toBe(64_000);
    expect(hold.remainingCents).toBe(26_000);
    expect(hold.closed).toBe(false);
  });

  it("represents an over-capture rather than treating it as invalid", () => {
    // DECISIONS 006: authorise $50.00, the pump captures $73.40. The hold is
    // $0.00 because max(A − C, 0) is zero, not because anything failed.
    const hold = toHold(
      holdRow({
        authorisedCents: 5_000n,
        clearedCents: 7_340n,
        remainingCents: 0n,
        closed: true,
        closedReason: "network_final",
      }),
    );
    expect(hold.clearedCents).toBeGreaterThan(hold.authorisedCents);
    expect(hold.remainingCents).toBe(0);
    expect(hold.closed).toBe(true);
  });

  it("reports no provider status, because none is stored to report", () => {
    // The rail's status field is not a description of the hold and the schema
    // deliberately has no column for it. Null here is the design, not a gap.
    expect(toHold(holdRow()).providerStatus).toBeNull();
  });

  it("renders instants as ISO 8601 UTC, and absent clocks as null", () => {
    const hold = toHold(holdRow());
    expect(hold.placedAt).toBe("2026-09-10T18:41:30.000Z");
    expect(hold.expiresAt).toBe("2026-09-17T18:41:30.000Z");
    expect(hold.availableAt).toBeNull();
  });
});

describe("toPosting", () => {
  it("gives a memo posting no ledger effect at all, rather than zero", () => {
    const posting = toPosting(
      postingRow({ book: "memo", ledgerDeltaCents: null, availableDeltaCents: -5_000n }),
    );
    expect(posting.ledgerDeltaCents).toBeNull();
    expect(posting.availableDeltaCents).toBe(-5_000);
  });

  it("keeps both clocks, and marks the entries that were backdated", () => {
    const posting = toPosting(
      postingRow({
        valueDate: "2011-04-26",
        bookingDate: "2026-09-10",
        backdated: true,
        backdatedByDays: 5_616,
        entryType: "rebook",
      }),
    );
    expect(posting.valueDate).toBe("2011-04-26");
    expect(posting.bookingDate).toBe("2026-09-10");
    expect(posting.backdated).toBe(true);
    expect(posting.backdatedByDays).toBe(5_616);
    expect(posting.description).toContain("backdated to 2011-04-26");
  });

  it("passes the provider's reference through as provenance", () => {
    expect(toPosting(postingRow()).sourceRef).toBe("ach:091000015551234");
  });
});

describe("toSummary", () => {
  it("closes the identity the contract demands, exactly", () => {
    const summary = toSummary({
      account: ACCOUNT,
      snapshot: SNAPSHOT,
      ledgerCents: 4_821_560n,
      pendingOutboundCents: 0n,
      holds: [
        holdRow({ kind: "card_auth", remainingCents: 124_000n }),
        holdRow({ kind: "manual", remainingCents: 50_000n }),
        holdRow({ kind: "uncleared_credit", remainingCents: 1_250_000n }),
      ],
    });

    expect(summary.activeHoldsCents).toBe(174_000);
    expect(summary.unclearedCreditsCents).toBe(1_250_000);
    expect(summary.availableCents).toBe(
      summary.ledgerCents -
        summary.activeHoldsCents -
        summary.unclearedCreditsCents -
        summary.pendingOutboundCents,
    );
  });

  it("does not clamp a negative available balance", () => {
    // An over-capture settles above what was authorised. The honest answer is
    // that the customer is overdrawn; a cosmetic floor would hide it.
    const summary = toSummary({
      account: ACCOUNT,
      snapshot: SNAPSHOT,
      ledgerCents: -840n,
      pendingOutboundCents: 0n,
      holds: [holdRow({ remainingCents: 1_200n })],
    });
    expect(summary.availableCents).toBe(-2_040);
  });

  it("takes committed outflows off available, though they have no hold row", () => {
    // An outbound ACH originated today for tomorrow's settlement: it has not
    // moved the settled ledger and it appears in no holds table, and it is
    // still gone as far as spending power is concerned. $37,212.00 of these
    // sit on the demo account; the account screen used to spend them twice.
    const summary = toSummary({
      account: ACCOUNT,
      snapshot: SNAPSHOT,
      ledgerCents: 4_968_953n,
      pendingOutboundCents: 3_721_200n,
      holds: [],
    });

    expect(summary.pendingOutboundCents).toBe(3_721_200);
    expect(summary.availableCents).toBe(4_968_953 - 3_721_200);
    // And the ledger balance itself did NOT move: that is the whole point of
    // keeping this a separate term rather than folding it into the sum.
    expect(summary.ledgerCents).toBe(4_968_953);
  });

  it("equals the ledger balance when nothing is being withheld", () => {
    const summary = toSummary({
      account: ACCOUNT,
      snapshot: SNAPSHOT,
      ledgerCents: 3_329_289n,
      pendingOutboundCents: 0n,
      holds: [],
    });
    expect(summary.availableCents).toBe(summary.ledgerCents);
    expect(summary.activeHoldsCents).toBe(0);
    expect(summary.unclearedCreditsCents).toBe(0);
  });

  it("carries the provenance a screenshot needs to be reproducible", () => {
    const summary = toSummary({
      account: ACCOUNT,
      snapshot: SNAPSHOT,
      ledgerCents: 0n,
      pendingOutboundCents: 0n,
      holds: [],
    });
    expect(summary.asOf).toBe("2026-09-10T19:42:00.000Z");
    expect(summary.bookingWatermark).toBe(160);
    expect(summary.accountName).toBe("Business current account");
    expect(summary.businessName).toBe("Ridgeline Robotics, Inc.");
    expect(summary.currency).toBe("USD");
  });
});

/* -------------------------------------------------------------------------- */
/* The data source                                                            */
/* -------------------------------------------------------------------------- */

describe("createLiveAccountDataSource", () => {
  it("answers all three methods from one snapshot", async () => {
    const { source, count } = liveSource();

    const [summary, holds, postings] = await Promise.all([
      source.getAccountSummary({ accountId: ACCOUNT_ID }),
      source.listHolds({ accountId: ACCOUNT_ID }),
      source.listPostings({ accountId: ACCOUNT_ID, limit: 25 }),
    ]);

    expect(isOk(summary)).toBe(true);
    expect(isOk(holds)).toBe(true);
    expect(isOk(postings)).toBe(true);

    if (isOk(summary)) {
      expect(summary.value.ledgerCents).toBe(3_329_289);
      expect(summary.value.activeHoldsCents).toBe(5_000);
      expect(summary.value.availableCents).toBe(3_324_289);
      expect(summary.value.bookingWatermark).toBe(160);
    }
    if (isOk(holds)) expect(holds.value).toHaveLength(1);
    if (isOk(postings)) expect(postings.value[0]?.book).toBe("memo");

    // One snapshot and one identity read shared across the three methods: 5
    // statements, not the 9 three independent reads would have sent, and —
    // more importantly — one instant, so the balance is a fold over exactly
    // the postings the table lists.
    expect(count()).toBe(5);
  });

  it("says which account is missing instead of failing as an outage", async () => {
    const { conn } = fakeSql([
      ["book_date(clock_timestamp())", [SNAPSHOT_ROW]],
      ["JOIN business b", []],
    ]);
    const source = createLiveAccountDataSource({ conn });

    const summary = await source.getAccountSummary({ accountId: ACCOUNT_ID });
    expect(isErr(summary)).toBe(true);
    if (isErr(summary)) {
      expect(summary.error.code).toBe("ACCOUNT_NOT_FOUND");
      expect(summary.error.message).toContain(ACCOUNT_ID);
    }
  });

  it("refuses a fixture id without pretending it is a database fault", async () => {
    const { conn } = fakeSql([["book_date(clock_timestamp())", [SNAPSHOT_ROW]]]);
    const source = createLiveAccountDataSource({ conn });

    const result = await source.listHolds({ accountId: "acct_operating_4417" });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("reports the real failure code, never the fixture's", async () => {
    const source = createLiveAccountDataSource({
      conn: failingSql("42P01", 'relation "journal_line" does not exist'),
    });

    const results: readonly Result<unknown, ErrorShape>[] = await Promise.all([
      source.getAccountSummary({ accountId: ACCOUNT_ID }),
      source.listHolds({ accountId: ACCOUNT_ID }),
      source.listPostings({ accountId: ACCOUNT_ID }),
    ]);

    for (const result of results) {
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) continue;
      // The fixture's code is LEDGER_QUERY_FAILED. A live failure that was
      // indistinguishable from a demo would not be a diagnosis.
      expect(result.error.code).toBe("LEDGER_42P01");
      expect(result.error.code).not.toBe("LEDGER_QUERY_FAILED");
      expect(result.error.message).toContain("journal_line");
      expect(result.error.details).toMatchObject({ retryable: true });
    }
  });

  it("names a connection failure by the driver's own code", async () => {
    const source = createLiveAccountDataSource({
      conn: failingSql("ECONNREFUSED", "write CONNECT_TIMEOUT"),
    });
    const result = await source.getAccountSummary({ accountId: ACCOUNT_ID });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("LEDGER_ECONNREFUSED");
  });

  it("falls back to a named code when a throw carries none", async () => {
    const conn = (() => Promise.reject(new Error("boom"))) as unknown as Sql;
    const source = createLiveAccountDataSource({ conn });
    const result = await source.listPostings({ accountId: ACCOUNT_ID });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("LEDGER_READ_FAILED");
  });

  it("fails loudly rather than rounding a balance it cannot represent", async () => {
    const { conn } = fakeSql([
      ["book_date(clock_timestamp())", [SNAPSHOT_ROW]],
      ["JOIN business b", [ACCOUNT_ROW]],
      [
        "ledger_availability",
        [
          {
            ledger_cents: 9_007_199_254_740_993n,
            hold_cents: 0n,
            uncleared_cents: 0n,
            pending_outbound_cents: 0n,
            available_cents: 9_007_199_254_740_993n,
          },
        ],
      ],
      ["WITH held", []],
    ]);
    const source = createLiveAccountDataSource({ conn });

    const summary = await source.getAccountSummary({ accountId: ACCOUNT_ID });
    expect(isErr(summary)).toBe(true);
    if (isErr(summary)) {
      expect(summary.error.code).toBe("LEDGER_CENTS_NOT_SAFE_INTEGER");
    }
  });

  it("bounds the page size a URL can ask for", async () => {
    let asked: unknown = null;
    const conn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(" ? ");
      if (text.includes("book_date(clock_timestamp())")) return Promise.resolve([SNAPSHOT_ROW]);
      if (text.includes("JOIN business b")) return Promise.resolve([ACCOUNT_ROW]);
      if (text.includes("WITH entries")) asked = values[values.length - 1];
      return Promise.resolve([]);
    }) as unknown as Sql;

    const source = createLiveAccountDataSource({ conn });
    await source.listPostings({ accountId: ACCOUNT_ID });
    expect(asked).toBe(DEFAULT_POSTINGS_LIMIT);

    await createLiveAccountDataSource({ conn }).listPostings({
      accountId: ACCOUNT_ID,
      limit: 10_000,
    });
    expect(asked).toBe(MAX_POSTINGS_LIMIT);

    await createLiveAccountDataSource({ conn }).listPostings({
      accountId: ACCOUNT_ID,
      limit: -3,
    });
    expect(asked).toBe(1);
  });
});

describe("listLiveAccounts", () => {
  it("quotes the same fold the account screen renders", async () => {
    const { conn } = fakeSql([
      ["ORDER BY b.legal_name", [ACCOUNT_ROW]],
      ["book_date(clock_timestamp())", [SNAPSHOT_ROW]],
      ["JOIN business b", [ACCOUNT_ROW]],
      [
      "ledger_availability",
      [
        {
          ledger_cents: 3_329_289n,
          hold_cents: 0n,
          uncleared_cents: 0n,
          pending_outbound_cents: 0n,
          available_cents: 3_329_289n,
        },
      ],
    ],
      ["WITH held", [HOLDS_ROW]],
    ]);

    const result = await listLiveAccounts({ conn });
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.ledgerCents).toBe(3_329_289);
    expect(result.value[0]?.availableCents).toBe(3_324_289);
    expect(result.value[0]?.last4).toBe("8fac");
  });

  it("hands the failure back rather than rendering a partial list", async () => {
    const result = await listLiveAccounts({
      conn: failingSql("57P01", "terminating connection due to administrator command"),
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.code).toBe("LEDGER_57P01");
  });
});
