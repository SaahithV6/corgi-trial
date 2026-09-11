import { describe, expect, it } from "vitest";

import { buildEnvelope, EVENT_TYPES, eventTypeFor, type EnvelopeInput } from "./envelope";

const BASE: EnvelopeInput = {
  eventId: "3f0b1d2e-0000-4000-8000-000000000001",
  businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
  eventType: "transaction.posted",
  sequence: 3001n,
  occurredAt: new Date("2026-09-10T22:00:00.000Z"),
  valueDate: "2026-09-08",
  entryId: "aaaaaaaa-0000-4000-8000-000000000001",
  entryType: "original",
  book: "financial",
  description: "Card clearing 4829 — SHELL OIL 4432",
  rail: "card",
  externalRef: "txn_abc",
  reversesEntryId: null,
  correctionGroupId: null,
  netCents: -7340n,
  currency: "USD",
  lines: [
    {
      account_code: "2100",
      account_name: "Customer deposits — Ridgeline Robotics",
      amount_cents: "-7340",
      currency: "USD",
      memo: null,
    },
  ],
};

const parse = (input: EnvelopeInput): Record<string, unknown> =>
  JSON.parse(buildEnvelope(input)) as Record<string, unknown>;

describe("the entry-to-event mapping is total", () => {
  it("names an event type for all six (book, entry_type) pairs", () => {
    const produced = new Set<string>();
    for (const book of ["financial", "memo"] as const) {
      for (const entryType of ["original", "reversal", "rebook"] as const) {
        produced.add(eventTypeFor(book, entryType));
      }
    }
    expect([...produced].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("memo entries are hold events, not transactions — available moves, ledger does not", () => {
    expect(eventTypeFor("memo", "original")).toBe("hold.placed");
    expect(eventTypeFor("financial", "original")).toBe("transaction.posted");
  });
});

describe("ordering is carried in the row and said out loud", () => {
  it("publishes the ledger's booking_seq as `sequence`, as a string", () => {
    const body = parse(BASE);
    expect(body["sequence"]).toBe("3001");
  });

  it("says in band that delivery is unordered and how to order it", () => {
    const delivery = parse(BASE)["delivery"] as Record<string, unknown>;
    expect(delivery["ordered"]).toBe(false);
    expect(delivery["order_by"]).toBe("sequence");
    expect(String(delivery["note"])).toMatch(/at-least-once/);
    expect(String(delivery["note"])).toMatch(/Deduplicate on `id`/);
  });

  it("carries BOTH clocks, and they differ on a backdated correction", () => {
    const corrected = parse({
      ...BASE,
      eventType: "transaction.reversed",
      entryType: "reversal",
      reversesEntryId: BASE.entryId,
      correctionGroupId: "cccccccc-0000-4000-8000-000000000001",
      occurredAt: new Date("2026-09-10T22:00:00.000Z"),
      valueDate: "2026-09-08", // Tuesday's settlement, reversed on Thursday.
    });
    expect(corrected["value_date"]).toBe("2026-09-08");
    expect(corrected["occurred_at"]).toBe("2026-09-10T22:00:00.000Z");
    const data = corrected["data"] as Record<string, unknown>;
    expect(data["reverses_entry_id"]).toBe(BASE.entryId);
    expect(data["correction_group_id"]).not.toBeNull();
  });
});

describe("the body is a pointer", () => {
  it("links to the API resources that hold authoritative state", () => {
    const links = parse(BASE)["links"] as Record<string, unknown>;
    expect(links["balance"]).toBe("/api/v1/accounts/2100/balance");
    expect(String(links["transactions"])).toContain("account_code=2100");
    expect(String(links["transactions"])).toContain("value_date_from=2026-09-08");
  });

  it("survives an entry with no customer line without inventing a link", () => {
    const links = parse({ ...BASE, lines: [] })["links"] as Record<string, unknown>;
    expect(links["balance"]).toBeNull();
  });
});

describe("money", () => {
  it("is integer cents as a STRING, never a JSON number", () => {
    const raw = buildEnvelope(BASE);
    expect(raw).toContain('"cents":"-7340"');
    expect(raw).not.toContain('"cents":-7340');
  });

  it("survives an amount past Number.MAX_SAFE_INTEGER", () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const data = parse({ ...BASE, netCents: huge })["data"] as Record<string, unknown>;
    const amount = data["net_amount"] as Record<string, unknown>;
    expect(amount["cents"]).toBe("9007199254740993");
  });
});

describe("what is never in a body", () => {
  it("carries no secret, no account number, no card number", () => {
    const raw = buildEnvelope({
      ...BASE,
      description: "Card clearing 4829 — SHELL OIL 4432",
    }).toLowerCase();

    for (const forbidden of ["whsec_", "secret", "routing_number", "account_number", "pan", "cvv", "cvc", "ssn"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("has a fixed key set — there is no provider-payload passthrough", () => {
    expect(Object.keys(parse(BASE)).sort()).toEqual([
      "api_version",
      "business_id",
      "data",
      "delivery",
      "id",
      "links",
      "occurred_at",
      "sequence",
      "type",
      "value_date",
    ]);
  });
});

describe("the bytes are stable", () => {
  it("serialises identically every time, so a retry re-sends the same signature input", () => {
    expect(buildEnvelope(BASE)).toBe(buildEnvelope(BASE));
  });

  it("the id in the body is the id used as webhook-id", () => {
    expect(parse(BASE)["id"]).toBe(BASE.eventId);
  });
});
