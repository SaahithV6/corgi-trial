/**
 * `rail_event_semantics`, one test per ROW.
 *
 * DESIGN.md §6.1 calls this table the single highest-risk artefact in the
 * system, and §14 says why: get one row backwards and every past statement it
 * touches is silently corrupted while all five invariants keep passing, the
 * hash chain verifies, and reconciliation stays clean. Nothing goes red. There
 * is no alarm. The only defence is that somebody looked at the row, so the
 * defence has to be a test per row rather than a test per rail — a rail-level
 * test passes with twenty-one right rows and one wrong one, which is exactly
 * the failure being defended against.
 *
 * ─── Where the 22 expectations come from ────────────────────────────────────
 *
 * `EXPECTED` below is the REVIEWED answer, written out by hand, each with the
 * reason it is that way. It is then tied to the other two copies of the same
 * data so none of the three can drift alone:
 *
 *   seed  <-> EXPECTED   always. `scripts/seed.mjs` is parsed and compared row
 *                        for row, and the key SETS are compared, so seeding a
 *                        new row without adding a test here fails this suite —
 *                        in CI, with no database.
 *   live  <-> seed       behind RUN_DB_TESTS=1, against Neon: the deployed
 *                        table must equal the file that seeds it.
 *
 * Run the live half with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `env.ts` parses eagerly at import and APP_DATABASE_URL is the one variable
// required to boot, while `postgres()` opens no socket until the first query.
// Hoisted above the imports below, because `./semantics` reaches `env.ts`
// through `@/lib/ledger/db` at module load. Every test here either injects its
// own connection or is gated on a live one, so a placeholder is enough — and
// it means CI, which holds no credentials, still runs the 22 row assertions.
vi.hoisted(() => {
  process.env["APP_DATABASE_URL"] ??= "postgres://placeholder/none";
});

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type { Transaction, TransactionEvent, TransactionEventType } from "@/lib/rails/lithic/types";

import { deriveCardEvents } from "@/lib/holds/lithic-events";

import {
  checkedRow,
  clearRailSemanticsCache,
  describeResolutions,
  loadRailEventSemantics,
  ORIGINAL_VALUE_DATE,
  RailSemanticsIntegrityError,
  requireEventSemantics,
  resolveEventSemantics,
  resolveEventSemanticsBatch,
  semanticsKey,
  UnclassifiedRailEventError,
  valueDateAnchor,
  type EventSemantics,
  type RailEventSemantics,
  type SemanticsRail,
} from "./semantics";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

// ---------------------------------------------------------------------------
// The reviewed expectation — 22 rows, one per seeded row
// ---------------------------------------------------------------------------

interface Expected {
  readonly rail: SemanticsRail;
  readonly provider: string;
  /** The webhook type as the provider names it. */
  readonly eventType: string;
  /** The nested lifecycle step, or null when the webhook type is the whole key. */
  readonly step: string | null;
  readonly canonicalKind: string;
  readonly semantics: EventSemantics;
  readonly valueDateSource: string;
  /** Why it is that way. Read this before changing a row. */
  readonly why: string;
}

const EXPECTED: readonly Expected[] = [
  // ---- Lithic (card) ------------------------------------------------------
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "AUTHORIZATION",
    canonicalKind: "authorization",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    why: "the cardholder really did present the card at that moment; nothing earlier was false",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "AUTHORIZATION_ADVICE",
    canonicalKind: "incremental_authorization",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    why: "an advice REPLACES the authorised amount at its own moment; the earlier figure was true when it was made",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "AUTHORIZATION_EXPIRY",
    canonicalKind: "expiry",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    why: "the network aged the authorisation out later; the authorisation itself was real",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "AUTHORIZATION_REVERSAL",
    canonicalKind: "authorization_reversal",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    why: "the merchant genuinely released the hold later; the hold shrinks from the reversal's own date",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "CLEARING",
    canonicalKind: "clearing",
    semantics: "new_event",
    valueDateSource: "payload.created",
    why: "value date is the LOCAL TRANSACTION date, not the settlement date: a Friday dinner clearing on Monday is Friday's spend",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "CORRECTION_CREDIT",
    canonicalKind: "correction_credit",
    semantics: "correction",
    valueDateSource: ORIGINAL_VALUE_DATE,
    why: "the network correcting its own earlier figure: by definition the original was wrong about its own date",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "CORRECTION_DEBIT",
    canonicalKind: "correction_debit",
    semantics: "correction",
    valueDateSource: ORIGINAL_VALUE_DATE,
    why: "as CORRECTION_CREDIT, in the other direction; same correction group as the entry it fixes",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "FINANCIAL_AUTHORIZATION",
    canonicalKind: "force_post",
    semantics: "new_event",
    valueDateSource: "payload.created",
    why: "a single-message clearing that never had an authorisation; it happened when it happened",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "RETURN",
    canonicalKind: "refund",
    semantics: "new_event",
    valueDateSource: "payload.events[].created",
    why: "a merchant refund is a new economic event on its own date, NOT an unwinding of the purchase",
  },
  {
    rail: "card",
    provider: "lithic",
    eventType: "card_transaction.updated",
    step: "RETURN_REVERSAL",
    canonicalKind: "refund_reversal",
    semantics: "correction",
    valueDateSource: ORIGINAL_VALUE_DATE,
    why: "the refund was a false statement about its own date — the money never came back — so that day is made whole",
  },

  // ---- Increase (ACH) -----------------------------------------------------
  {
    rail: "ach",
    provider: "increase",
    eventType: "ach_transfer.created",
    step: null,
    canonicalKind: "ach_originated",
    semantics: "new_event",
    valueDateSource: "payload.created_at",
    why: "an outbound entry has been created; no money has moved and nothing posts to the financial book",
  },
  {
    rail: "ach",
    provider: "increase",
    eventType: "ach_transfer.updated",
    step: "notification_of_change",
    canonicalKind: "ach_notification_of_change",
    semantics: "new_event",
    valueDateSource: "payload.notifications_of_change[].created_at",
    why: "a NOC corrects the COUNTERPARTY's details, not our posting; no money moves and nothing is made whole",
  },
  {
    rail: "ach",
    provider: "increase",
    eventType: "ach_transfer.updated",
    step: "returned",
    canonicalKind: "ach_return",
    semantics: "new_event",
    valueDateSource: "payload.return.created_at",
    why: "THE row people get wrong. MEASURED (DECISIONS 019): after a return, settlement.settled_at is STILL populated and the transfer id is unchanged. The money really did leave on the settle date and really did come back later, so the settle date's statement must still show the payment",
  },
  {
    rail: "ach",
    provider: "increase",
    eventType: "ach_transfer.updated",
    step: "settled",
    canonicalKind: "ach_settled",
    semantics: "new_event",
    valueDateSource: "payload.settlement.settled_at",
    why: "funds actually left the FBO account on the settlement date",
  },
  {
    rail: "ach",
    provider: "increase",
    eventType: "ach_transfer.updated",
    step: "submitted",
    canonicalKind: "ach_submitted",
    semantics: "new_event",
    valueDateSource: "payload.submission.submitted_at",
    why: "handed to the ODFI: the customer's money is committed on that date and our cash has not left yet",
  },
  {
    rail: "ach",
    provider: "increase",
    eventType: "inbound_ach_transfer.created",
    step: null,
    canonicalKind: "inbound_ach_credit",
    semantics: "new_event",
    valueDateSource: "payload.effective_date",
    why: "someone is sending our customer money, effective on the date the originator chose",
  },
  {
    rail: "ach",
    provider: "increase",
    eventType: "inbound_ach_transfer.updated",
    step: "returned",
    canonicalKind: "inbound_ach_return",
    semantics: "new_event",
    valueDateSource: "payload.return.created_at",
    why: "an inbound credit we already posted has been returned — its own date again, and the 9200 hold is closed explicitly",
  },

  // ---- Base (USDC) --------------------------------------------------------
  {
    rail: "usdc",
    provider: "base",
    eventType: "usdc.deposit.observed",
    step: null,
    canonicalKind: "inbound_usdc_credit",
    semantics: "new_event",
    valueDateSource: "payload.block_timestamp",
    why: "inbound USDC seen at our omnibus address, dated by the block that carried it",
  },
  {
    rail: "usdc",
    provider: "base",
    eventType: "usdc.transfer.confirmed",
    step: null,
    canonicalKind: "usdc_payout_confirmed",
    semantics: "new_event",
    valueDateSource: "payload.block_timestamp",
    why: "the transfer reached the confirmation bar at that block; the earlier pending posting was true when made",
  },
  {
    rail: "usdc",
    provider: "base",
    eventType: "usdc.transfer.failed",
    step: null,
    canonicalKind: "usdc_payout_failed",
    semantics: "correction",
    valueDateSource: ORIGINAL_VALUE_DATE,
    why: "a reverted transaction moved no money AT ALL, so the pending posting was a false statement about its own date",
  },
  {
    rail: "usdc",
    provider: "base",
    eventType: "usdc.transfer.pending",
    step: null,
    canonicalKind: "usdc_payout_pending",
    semantics: "new_event",
    valueDateSource: "payload.broadcast_at",
    why: "broadcast really happened at that moment, confirmed or not",
  },
  {
    rail: "usdc",
    provider: "base",
    eventType: "usdc.transfer.reorged",
    step: null,
    canonicalKind: "usdc_payout_reorged",
    semantics: "correction",
    valueDateSource: ORIGINAL_VALUE_DATE,
    why: "the block that carried the transfer is no longer canonical, so it never happened on that date",
  },
];

/** The primary key, as the database holds it. */
function keyOf(e: Pick<Expected, "provider" | "eventType" | "step">): string {
  return `${e.provider} ${semanticsKey(e.eventType, e.step)}`;
}

/** The reviewed expectation as a `RailEventSemantics` row. */
function asRow(e: Expected): RailEventSemantics {
  return {
    rail: e.rail,
    provider: e.provider,
    providerEventType: semanticsKey(e.eventType, e.step),
    canonicalKind: e.canonicalKind,
    semantics: e.semantics,
    valueDateSource: e.valueDateSource,
    note: e.why,
  };
}

const EXPECTED_ROWS: readonly RailEventSemantics[] = EXPECTED.map(asRow);

// ---------------------------------------------------------------------------
// The seed, parsed
// ---------------------------------------------------------------------------

/**
 * `RAIL_EVENT_SEMANTICS` out of `scripts/seed.mjs`, without importing it.
 *
 * The seed opens a database connection at module scope and exits the process
 * on a missing URL, so it cannot be imported; it is read as text instead. The
 * extractor asserts it found the array and 22 uniformly-shaped entries, so a
 * reformat of the seed fails this suite loudly rather than silently matching
 * fewer rows and declaring everything fine.
 */
function seededRows(): RailEventSemantics[] {
  const path = fileURLToPath(new URL("../../../scripts/seed.mjs", import.meta.url));
  const source = readFileSync(path, "utf8");

  const start = source.indexOf("const RAIL_EVENT_SEMANTICS = [");
  expect(start, "scripts/seed.mjs no longer declares RAIL_EVENT_SEMANTICS").toBeGreaterThan(-1);
  const end = source.indexOf("\n];", start);
  expect(end, "could not find the end of RAIL_EVENT_SEMANTICS").toBeGreaterThan(start);
  const block = source.slice(start, end);

  const entry =
    /\{\s*rail:\s*"([^"]+)",\s*provider:\s*"([^"]+)",\s*providerEventType:\s*"([^"]+)",\s*canonicalKind:\s*"([^"]+)",\s*semantics:\s*"([^"]+)",\s*valueDateSource:\s*"([^"]+)",\s*note:\s*"([^"]*)"/g;

  const rows: RailEventSemantics[] = [];
  for (const m of block.matchAll(entry)) {
    rows.push(
      checkedRow({
        rail: m[1] ?? "",
        provider: m[2] ?? "",
        providerEventType: m[3] ?? "",
        canonicalKind: m[4] ?? "",
        semantics: m[5] ?? "",
        valueDateSource: m[6] ?? "",
        note: m[7] ?? "",
      }),
    );
  }
  return rows;
}

const SEEDED = seededRows();

function seededByKey(): Map<string, RailEventSemantics> {
  return new Map(SEEDED.map((r) => [`${r.provider} ${r.providerEventType}`, r]));
}

// ---------------------------------------------------------------------------
// 1. A test per row
// ---------------------------------------------------------------------------

describe("rail_event_semantics — one assertion per seeded row", () => {
  it("the seed carries exactly the 22 rows this suite reviews, and no others", () => {
    // The whole point of the per-row rule: adding a row without adding a test
    // here fails, so an unreviewed row cannot reach the database quietly.
    expect(SEEDED).toHaveLength(22);
    expect(EXPECTED).toHaveLength(22);
    expect([...seededByKey().keys()].sort()).toEqual(EXPECTED.map(keyOf).sort());
  });

  for (const expected of EXPECTED) {
    const key = keyOf(expected);

    it(`${key} is ${expected.semantics} @ ${expected.valueDateSource} — ${expected.why}`, async () => {
      const seeded = seededByKey().get(key);
      expect(seeded, `no seeded row for ${key}`).toBeDefined();
      if (seeded === undefined) return;

      // The seed says what the review says.
      expect(seeded.rail).toBe(expected.rail);
      expect(seeded.canonicalKind).toBe(expected.canonicalKind);
      expect(seeded.semantics).toBe(expected.semantics);
      expect(seeded.valueDateSource).toBe(expected.valueDateSource);

      // And the reader resolves the composed key to that same answer.
      const resolution = await resolveEventSemantics(
        {
          provider: expected.provider,
          eventType: expected.eventType,
          nestedStep: expected.step,
        },
        { rows: SEEDED },
      );
      expect(resolution.status).toBe("classified");
      if (resolution.status !== "classified") return;
      expect(resolution.row.semantics).toBe(expected.semantics);
      expect(resolution.row.valueDateSource).toBe(expected.valueDateSource);
      expect(resolution.valueDateAnchor).toBe(
        expected.semantics === "correction" ? "original" : "event",
      );
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The two rows the whole distinction rests on
// ---------------------------------------------------------------------------

describe("the distinction, stated as the two rows that are opposite", () => {
  it("an ACH return is a NEW EVENT at a NEW value date (measured, DECISIONS 019)", async () => {
    const r = await requireEventSemantics(
      { provider: "increase", eventType: "ach_transfer.updated", nestedStep: "returned" },
      { rows: SEEDED },
    );
    expect(r.row.semantics).toBe("new_event");
    expect(r.valueDateAnchor).toBe("event");
    expect(r.row.valueDateSource).toBe("payload.return.created_at");
    // The settlement is NOT erased: it keeps its own date and its own posting.
    expect(r.row.valueDateSource).not.toBe(ORIGINAL_VALUE_DATE);
  });

  it("a card clearing reversal is a CORRECTION at the ORIGINAL value date", async () => {
    const r = await requireEventSemantics(
      {
        provider: "lithic",
        eventType: "card_transaction.updated",
        nestedStep: "RETURN_REVERSAL",
      },
      { rows: SEEDED },
    );
    expect(r.row.semantics).toBe("correction");
    expect(r.valueDateAnchor).toBe("original");
    expect(r.row.valueDateSource).toBe(ORIGINAL_VALUE_DATE);
  });

  it("every correction row anchors on the original and every new_event row does not", () => {
    for (const row of SEEDED) {
      expect(valueDateAnchor(row)).toBe(row.semantics === "correction" ? "original" : "event");
      expect(row.valueDateSource === ORIGINAL_VALUE_DATE).toBe(row.semantics === "correction");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. The key, and the failures
// ---------------------------------------------------------------------------

describe("semanticsKey", () => {
  it("composes the nested step onto the webhook type", () => {
    expect(semanticsKey("card_transaction.updated", "CLEARING")).toBe(
      "card_transaction.updated/CLEARING",
    );
    expect(semanticsKey("ach_transfer.updated", "returned")).toBe("ach_transfer.updated/returned");
  });

  it("is the bare webhook type when there is no step", () => {
    expect(semanticsKey("ach_transfer.created")).toBe("ach_transfer.created");
    expect(semanticsKey("ach_transfer.created", null)).toBe("ach_transfer.created");
    expect(semanticsKey("ach_transfer.created", "  ")).toBe("ach_transfer.created");
  });

  it("round-trips every seeded key", () => {
    for (const e of EXPECTED) {
      expect(semanticsKey(e.eventType, e.step)).toBe(
        seededByKey().get(keyOf(e))?.providerEventType,
      );
    }
  });
});

describe("an incoherent row is refused, not served", () => {
  const base = {
    rail: "card",
    provider: "lithic",
    providerEventType: "card_transaction.updated/EXAMPLE",
    canonicalKind: "example",
    valueDateSource: "payload.created",
    note: "n",
  };

  it("rejects a correction that names a payload field", () => {
    expect(() => checkedRow({ ...base, semantics: "correction" })).toThrow(
      RailSemanticsIntegrityError,
    );
  });

  it("rejects a new_event anchored on the original's value date", () => {
    expect(() =>
      checkedRow({ ...base, semantics: "new_event", valueDateSource: ORIGINAL_VALUE_DATE }),
    ).toThrow(RailSemanticsIntegrityError);
  });

  it("rejects a rail the enum does not have and a semantics the enum does not have", () => {
    expect(() => checkedRow({ ...base, rail: "rtp", semantics: "new_event" })).toThrow(
      RailSemanticsIntegrityError,
    );
    expect(() => checkedRow({ ...base, semantics: "probably_fine" })).toThrow(
      RailSemanticsIntegrityError,
    );
  });

  it("accepts the coherent pair in both directions", () => {
    expect(checkedRow({ ...base, semantics: "new_event" }).semantics).toBe("new_event");
    const correction = checkedRow({
      ...base,
      semantics: "correction",
      valueDateSource: ORIGINAL_VALUE_DATE,
    });
    expect(valueDateAnchor(correction)).toBe("original");
  });
});

describe("an unknown key fails loudly — there is no default", () => {
  it("resolves to 'unclassified', never to a guessed side", async () => {
    const r = await resolveEventSemantics(
      {
        provider: "lithic",
        eventType: "card_transaction.updated",
        nestedStep: "SOMETHING_LITHIC_SHIPPED_ON_TUESDAY",
      },
      { rows: SEEDED },
    );
    expect(r.status).toBe("unclassified");
    if (r.status !== "unclassified") return;
    expect(r.key).toBe("card_transaction.updated/SOMETHING_LITHIC_SHIPPED_ON_TUESDAY");
  });

  it("throws for callers that want the event dead-lettered", async () => {
    await expect(
      requireEventSemantics(
        { provider: "increase", eventType: "ach_transfer.updated", nestedStep: "clawed_back" },
        { rows: SEEDED },
      ),
    ).rejects.toBeInstanceOf(UnclassifiedRailEventError);
  });

  it("does not fall back to a same-provider row, a same-rail row, or the bare event type", async () => {
    // `ach_transfer.updated` alone has no row: only its steps do. A reader that
    // stripped the step to 'find something' would answer for the wrong event.
    const bare = await resolveEventSemantics(
      { provider: "increase", eventType: "ach_transfer.updated" },
      { rows: SEEDED },
    );
    expect(bare.status).toBe("unclassified");

    // Right key, wrong provider.
    const wrongProvider = await resolveEventSemantics(
      { provider: "stripe", eventType: "ach_transfer.updated", nestedStep: "returned" },
      { rows: SEEDED },
    );
    expect(wrongProvider.status).toBe("unclassified");
  });

  it("refuses the WHOLE payload when any one step is unclassified", async () => {
    const batch = await resolveEventSemanticsBatch(
      {
        provider: "lithic",
        eventType: "card_transaction.updated",
        nestedSteps: ["AUTHORIZATION", "CLEARING", "NEW_LITHIC_STEP"],
      },
      { rows: SEEDED },
    );
    expect(batch.status).toBe("unclassified");
    if (batch.status !== "unclassified") return;
    expect(batch.key).toBe("card_transaction.updated/NEW_LITHIC_STEP");
  });

  it("resolves a payload of known steps, deduplicated, in order", async () => {
    const batch = await resolveEventSemanticsBatch(
      {
        provider: "lithic",
        eventType: "card_transaction.updated",
        nestedSteps: ["AUTHORIZATION", "CLEARING", "CLEARING"],
      },
      { rows: SEEDED },
    );
    expect(batch.status).toBe("classified");
    if (batch.status !== "classified") return;
    expect(describeResolutions(batch.resolved)).toEqual([
      "card_transaction.updated/AUTHORIZATION -> new_event @ payload.events[].created (authorization)",
      "card_transaction.updated/CLEARING -> new_event @ payload.created (clearing)",
    ]);
  });

  it("an empty payload asserts nothing and classifies as nothing", async () => {
    const batch = await resolveEventSemanticsBatch(
      { provider: "lithic", eventType: "card_transaction.updated", nestedSteps: [] },
      { rows: SEEDED },
    );
    expect(batch.status).toBe("classified");
    if (batch.status !== "classified") return;
    expect(batch.resolved).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. The cache, and the miss that re-reads
// ---------------------------------------------------------------------------

describe("the cache never hides a row that has just been added", () => {
  function fakeConn(rows: () => RailEventSemantics[], counter: { reads: number }): typeof SqlHandle {
    const fn = (): Promise<unknown[]> => {
      counter.reads += 1;
      return Promise.resolve(
        rows().map((r) => ({
          rail: r.rail,
          provider: r.provider,
          provider_event_type: r.providerEventType,
          canonical_kind: r.canonicalKind,
          semantics: r.semantics,
          value_date_source: r.valueDateSource,
          note: r.note,
        })),
      );
    };
    return fn as unknown as typeof SqlHandle;
  }

  beforeEach(() => clearRailSemanticsCache());
  afterEach(() => clearRailSemanticsCache());

  it("serves repeated hits from one read", async () => {
    const counter = { reads: 0 };
    const conn = fakeConn(() => [...EXPECTED_ROWS], counter);
    const input = {
      provider: "lithic",
      eventType: "card_transaction.updated",
      nestedStep: "CLEARING",
    };
    await resolveEventSemantics(input, { conn, now: 1_000 });
    await resolveEventSemantics(input, { conn, now: 1_500 });
    expect(counter.reads).toBe(1);
  });

  it("re-reads on a MISS, so a row added a moment ago is not hidden by a stale negative", async () => {
    const counter = { reads: 0 };
    let table = EXPECTED_ROWS.filter((r) => r.providerEventType !== "usdc.transfer.reorged");
    const conn = fakeConn(() => [...table], counter);
    const input = { provider: "base", eventType: "usdc.transfer.reorged" };

    const before = await resolveEventSemantics(input, { conn, now: 1_000 });
    expect(before.status).toBe("unclassified");

    table = [...EXPECTED_ROWS];
    const after = await resolveEventSemantics(input, { conn, now: 1_100 });
    expect(after.status).toBe("classified");
    expect(counter.reads).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// 5. The consumer asks the table
// ---------------------------------------------------------------------------

describe("the Lithic consumer parks a step nobody has classified", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/ledger/db");
    vi.resetModules();
    clearRailSemanticsCache();
  });

  async function consumerWithTable(rows: readonly RailEventSemantics[]) {
    vi.resetModules();
    vi.doMock("@/lib/ledger/db", () => ({
      sql: () =>
        Promise.resolve(
          rows.map((r) => ({
            rail: r.rail,
            provider: r.provider,
            provider_event_type: r.providerEventType,
            canonical_kind: r.canonicalKind,
            semantics: r.semantics,
            value_date_source: r.valueDateSource,
            note: r.note,
          })),
        ),
    }));
    const mod = await import("@/lib/webhooks/consumers/lithic-card");
    const semantics = await import("./semantics");
    semantics.clearRailSemanticsCache();
    return mod;
  }

  function delivery(steps: string[]) {
    return {
      id: "00000000-0000-0000-0000-0000000000aa",
      provider: "lithic" as const,
      providerEventId: "msg_semantics",
      eventType: "card_transaction.updated",
      payload: {
        token: "69d2f4f3-8101-4a08-9524-98ae5edd96c8",
        card_token: "56db7b80-a103-4adf-acdd-4cab460c2963",
        created: "2026-09-10T16:23:11Z",
        events: steps.map((type, i) => ({ token: `e${i}`, type, created: "2026-09-10T16:23:11Z" })),
      },
      headers: {},
      rawBody: "{}",
      receivedAt: new Date(),
      signatureVerifiedAt: new Date(),
      state: "pending" as const,
      attempts: 1,
      parkAttempts: 0,
      nextAttemptAt: new Date(),
      lockedUntil: null,
      processedAt: null,
      parkedOnKind: null,
      parkedOnRef: null,
      parkedReason: null,
      processingError: null,
      deadLetteredAt: null,
    };
  }

  const ctx = {
    now: new Date("2026-09-10T18:00:00Z"),
    attempt: 1,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  it("reads the step types out of the payload, including an unreadable one", async () => {
    const { cardTransactionStepTypes } = await import("@/lib/webhooks/consumers/lithic-card");
    expect(cardTransactionStepTypes({ events: [{ type: "CLEARING" }, { type: 7 }, null] })).toEqual([
      "CLEARING",
      null,
      null,
    ]);
    expect(cardTransactionStepTypes({})).toEqual([]);
  });

  it("PARKS on rail_event_semantics rather than guessing the value-date rule", async () => {
    const mod = await consumerWithTable(EXPECTED_ROWS);
    const result = await mod.lithicCardConsumer.handle(
      delivery(["AUTHORIZATION", "SOME_NEW_LITHIC_STEP"]),
      ctx,
    );
    expect(result.status).toBe("parked");
    if (result.status !== "parked") return;
    expect(result.waitingFor).toEqual({
      kind: "rail_event_semantics",
      ref: "card_transaction.updated/SOME_NEW_LITHIC_STEP",
    });
  });

  it("parks if the row it needs is DELETED — the table is load-bearing, not decorative", async () => {
    const withoutClearing = EXPECTED_ROWS.filter(
      (r) => r.providerEventType !== "card_transaction.updated/CLEARING",
    );
    const mod = await consumerWithTable(withoutClearing);
    const result = await mod.lithicCardConsumer.handle(delivery(["CLEARING"]), ctx);
    expect(result.status).toBe("parked");
    if (result.status !== "parked") return;
    expect(result.waitingFor.ref).toBe("card_transaction.updated/CLEARING");
  });
});

// ---------------------------------------------------------------------------
// 6. What the table says vs. what the code does, today
// ---------------------------------------------------------------------------

/**
 * The table is a set of claims. This is the only test that checks any of them
 * against the code that actually posts, and it is a CHARACTERISATION test: it
 * pins the current divergences rather than asserting they are absent, because
 * closing them means changing `src/lib/holds/*` and that is out of scope here.
 *
 * Every `false` below is a real, reviewable gap between what the table says and
 * where the money is dated. Fixing one of them turns this test red, which is
 * the point: nobody closes a gap without being told the table already agreed
 * with the fix.
 */
describe("table vs. consumer behaviour, as it stands (characterisation)", () => {
  const TXN_CREATED = "2026-09-04T18:00:00Z"; // Friday, 14:00 in book tz
  const EVENT_CREATED = "2026-09-07T18:00:00Z"; // Monday, 14:00 in book tz

  function oneStep(type: TransactionEventType, polarity?: "CREDIT" | "DEBIT"): Transaction {
    const event: TransactionEvent = {
      token: `tok-${type}`,
      type,
      created: EVENT_CREATED,
      amount: 5000,
      amounts: {
        cardholder: { amount: 5000, conversion_rate: "1.000000", currency: "USD" },
        merchant: { amount: 5000, currency: "USD" },
        settlement: { amount: 5000, currency: "USD" },
      },
      ...(polarity !== undefined ? { effective_polarity: polarity } : {}),
    };
    return {
      token: "txn-characterisation",
      account_token: "2742964f-478f-47ef-a4e9-852dc50d9c44",
      card_token: "56db7b80-a103-4adf-acdd-4cab460c2963",
      created: TXN_CREATED,
      updated: EVENT_CREATED,
      status: "PENDING",
      result: "APPROVED",
      amounts: {
        cardholder: { amount: 0, conversion_rate: "1.000000", currency: "USD" },
        hold: { amount: 0, currency: "USD" },
        merchant: { amount: 0, currency: "USD" },
        settlement: { amount: 5000, currency: "USD" },
      },
      events: [event],
    };
  }

  /**
   * step -> [does the code's canonical kind match the table's?,
   *          does the code date it the way the table says?]
   *
   * The code dates EVERY card event at that event's own `created`
   * (`deriveCardEvents`), and posts every one of them as an ordinary entry
   * (`postCardMovement`) — it has no correction path at all.
   */
  const CURRENT: Record<string, { kindMatches: boolean; datedAsTableSays: boolean }> = {
    AUTHORIZATION: { kindMatches: true, datedAsTableSays: true },
    AUTHORIZATION_ADVICE: { kindMatches: true, datedAsTableSays: true },
    AUTHORIZATION_EXPIRY: { kindMatches: true, datedAsTableSays: true },
    AUTHORIZATION_REVERSAL: { kindMatches: true, datedAsTableSays: true },
    RETURN: { kindMatches: true, datedAsTableSays: true },
    // Table: payload.created (the LOCAL transaction date). Code: the event's
    // own date. Identical in the sandbox, where a transaction clears the same
    // day it is authorised; different for a Friday dinner clearing on Monday.
    CLEARING: { kindMatches: true, datedAsTableSays: false },
    FINANCIAL_AUTHORIZATION: { kindMatches: true, datedAsTableSays: false },
    // Table: correction at the ORIGINAL value date. Code: an ordinary posting
    // at the event's own date, under a different canonical name.
    RETURN_REVERSAL: { kindMatches: false, datedAsTableSays: false },
    CORRECTION_DEBIT: { kindMatches: false, datedAsTableSays: false },
    CORRECTION_CREDIT: { kindMatches: false, datedAsTableSays: false },
  };

  const CARD_ROWS = EXPECTED.filter((e) => e.provider === "lithic");

  it("covers every Lithic step the table classifies", () => {
    expect(Object.keys(CURRENT).sort()).toEqual(CARD_ROWS.map((e) => e.step ?? "").sort());
  });

  for (const e of CARD_ROWS) {
    const step = e.step ?? "";
    const current = CURRENT[step];

    it(`${step}: code ${current?.kindMatches ? "agrees with" : "DIVERGES from"} the table's canonical kind, and ${current?.datedAsTableSays ? "dates it" : "does NOT date it"} as the table says`, () => {
      const derived = deriveCardEvents(
        oneStep(step as TransactionEventType, step === "CORRECTION_CREDIT" ? "CREDIT" : "DEBIT"),
      );
      const produced = derived.events[0];
      expect(produced, `${step} produced no canonical event`).toBeDefined();
      if (produced === undefined) return;

      expect(produced.kind === e.canonicalKind).toBe(current?.kindMatches);

      // The table's date for this step, computed the way the table names it.
      const tableDate =
        e.semantics === "correction"
          ? ORIGINAL_VALUE_DATE // no payload field at all
          : e.valueDateSource === "payload.created"
            ? "2026-09-04"
            : "2026-09-07";
      expect(produced.valueDate === tableDate).toBe(current?.datedAsTableSays);
    });
  }
});

// ---------------------------------------------------------------------------
// 7. The live table
// ---------------------------------------------------------------------------

d("against the live database", () => {
  it("the deployed table is exactly what scripts/seed.mjs seeds", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const live = await loadRailEventSemantics(sql);

    const norm = (rows: readonly RailEventSemantics[]) =>
      [...rows]
        .map((r) => [
          r.provider,
          r.providerEventType,
          r.rail,
          r.canonicalKind,
          r.semantics,
          r.valueDateSource,
        ])
        .sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));

    expect(live).toHaveLength(22);
    expect(norm(live)).toEqual(norm(EXPECTED_ROWS));
  });

  it("resolves a Lithic clearing, a Lithic clearing reversal and an Increase return off the live table", async () => {
    clearRailSemanticsCache();
    const { sql } = await import("@/lib/ledger/db");

    const clearing = await requireEventSemantics(
      { provider: "lithic", eventType: "card_transaction.updated", nestedStep: "CLEARING" },
      { conn: sql },
    );
    expect(clearing.row.semantics).toBe("new_event");
    expect(clearing.valueDateAnchor).toBe("event");

    const reversal = await requireEventSemantics(
      { provider: "lithic", eventType: "card_transaction.updated", nestedStep: "RETURN_REVERSAL" },
      { conn: sql },
    );
    expect(reversal.row.semantics).toBe("correction");
    expect(reversal.valueDateAnchor).toBe("original");

    const achReturn = await requireEventSemantics(
      { provider: "increase", eventType: "ach_transfer.updated", nestedStep: "returned" },
      { conn: sql },
    );
    expect(achReturn.row.semantics).toBe("new_event");
    expect(achReturn.valueDateAnchor).toBe("event");
    expect(achReturn.row.valueDateSource).toBe("payload.return.created_at");
  });

  it("an unknown key is unclassified against the live table too", async () => {
    clearRailSemanticsCache();
    const { sql } = await import("@/lib/ledger/db");
    const r = await resolveEventSemantics(
      { provider: "lithic", eventType: "card_transaction.updated", nestedStep: "NOT_A_REAL_STEP" },
      { conn: sql },
    );
    expect(r.status).toBe("unclassified");
  });
});
