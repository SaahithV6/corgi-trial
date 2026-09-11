/**
 * The Stripe consumer.
 *
 * The decision half runs everywhere and uses the REAL dead-lettered identity
 * bodies out of `webhook_inbox`, copied verbatim — including the two shapes
 * that matter: one with `metadata.reference_id` naming a business, and one
 * from a shape probe that names nobody.
 *
 * The recording half runs against the LIVE database behind RUN_DB_TESTS=1 and
 * replays the real deliveries, twice, asserting that the second replay appends
 * no second evidence row.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ConsumerContext } from "../dispatch";
import type { InboxEvent } from "../inbox";
import type * as StripeIdentityModule from "./stripe-identity";

process.env["APP_DATABASE_URL"] ??= "postgres://placeholder/none";

let m: typeof StripeIdentityModule;
beforeAll(async () => {
  m = await import("./stripe-identity");
});

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NULL_LOGGER: ConsumerContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
const ctx: ConsumerContext = { now: new Date(), attempt: 1, logger: NULL_LOGGER };

/** Verbatim: a verified session carrying the business id in its metadata. */
const VERIFIED = {
  id: "evt_1UEDOXDgSL5WTGpmUQEe9bmm",
  object: "event",
  type: "identity.verification_session.verified",
  created: 1789067545,
  data: {
    object: {
      id: "vs_1UEDLcDgSL5WTGpmif87HEZ7",
      object: "identity.verification_session",
      status: "verified",
      last_error: null,
      last_verification_report: "vr_1UEDOXDgSL5WTGpmhD0Xnb3L",
      livemode: false,
      created: 1789067364,
      metadata: {
        reference_id: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
        business_name: "Ridgeline Robotics, Inc.",
      },
      type: "document",
    },
  },
};

/** Verbatim: a shape probe. No reference_id, and no leg cites it. */
const PROBE = {
  id: "evt_1UEForDgSL5WTGpm4D7eGnim",
  object: "event",
  type: "identity.verification_session.canceled",
  created: 1789076865,
  data: {
    object: {
      id: "vs_1UEFoFDgSL5WTGpmA3tuXGoF",
      object: "identity.verification_session",
      status: "canceled",
      last_error: null,
      created: 1789076827,
      metadata: { probe: "cancel" },
      type: "document",
    },
  },
};

function inboxEvent(payload: unknown, eventType: string): InboxEvent {
  return {
    id: "00000000-0000-0000-0000-000000000003",
    provider: "stripe",
    providerEventId: "evt_test",
    eventType,
    payload,
    headers: {},
    rawBody: JSON.stringify(payload),
    receivedAt: new Date(),
    signatureVerifiedAt: new Date(),
    state: "pending",
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

describe("asIdentityPointer", () => {
  it("reads the session id, the reference and the delivered status", () => {
    expect(m.asIdentityPointer(VERIFIED)).toEqual({
      sessionId: "vs_1UEDLcDgSL5WTGpmif87HEZ7",
      referenceId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
      deliveredStatus: "verified",
    });
  });

  it("reads a probe session, which names no business", () => {
    expect(m.asIdentityPointer(PROBE)?.referenceId).toBeNull();
  });

  it("refuses a body with no verification session in it", () => {
    expect(m.asIdentityPointer({ data: { object: { id: "acct_123" } } })).toBeNull();
  });
});

describe("findBusinessForSession", () => {
  it("does not hand a non-uuid reference to Postgres", async () => {
    // The real probe delivery carried `reference_id: "probe-shape"`. Casting
    // that to ::uuid raises, and a raise here is eight retries and a dead
    // letter whose message is a type error. The conn below would throw if it
    // were reached.
    const pointer = { sessionId: "vs_probe", referenceId: "probe-shape", deliveredStatus: null };
    const queries: string[] = [];
    const conn = ((strings: TemplateStringsArray) => {
      queries.push(strings.join(" ? "));
      return Promise.resolve([]);
    }) as never;

    await expect(m.findBusinessForSession(pointer, conn)).resolves.toBeNull();
    expect(queries.some((q) => q.includes("FROM business"))).toBe(false);
    expect(queries.some((q) => q.includes("kyb_verification_leg"))).toBe(true);
  });
});

describe("the consumer's answers, with no database and no network", () => {
  it("ignores a Stripe event from outside the identity family", async () => {
    const consumer = m.createStripeIdentityConsumer({
      readLeg: () => {
        throw new Error("must not call Stripe for an event we do not handle");
      },
    });
    const result = await consumer.handle(
      inboxEvent({ id: "evt_x", type: "charge.succeeded" }, "charge.succeeded"),
      ctx,
    );
    expect(result.status).toBe("ignored");
    expect(result.status === "ignored" && result.reason).toContain("identity.verification_session");
  });
});

// ---------------------------------------------------------------------------
// The recording half — live database, live Stripe read-back
// ---------------------------------------------------------------------------

d("the real deliveries, replayed", () => {
  it("records one evidence row per delivery and none on a replay", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const consumer = m.stripeIdentityConsumer;

    const rows = await sql<
      { id: string; provider_event_id: string; event_type: string | null; payload: unknown }[]
    >`SELECT id, provider_event_id, event_type, payload
        FROM webhook_inbox WHERE provider = 'stripe' ORDER BY received_at`;
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      const event: InboxEvent = {
        ...inboxEvent(row.payload, row.event_type ?? ""),
        id: row.id,
        providerEventId: row.provider_event_id,
      };
      const first = await consumer.handle(event, ctx);
      const second = await consumer.handle(event, ctx);
      expect(second.status).toBe(first.status);
    }

    // The guard, proven: one evidence row per inbox row, never two.
    const dupes = await sql<{ inbox_id: string; n: string }[]>`
      SELECT inbox_id, count(*)::text AS n
        FROM kyb_verification_leg
       WHERE inbox_id IS NOT NULL
       GROUP BY inbox_id HAVING count(*) > 1`;
    expect(dupes).toEqual([]);
  });
});
