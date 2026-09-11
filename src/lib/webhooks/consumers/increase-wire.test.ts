/**
 * The Increase router — the consumer that turns one signed vendor delivery into
 * a decision about which of two rails it belongs to.
 *
 * EVERY PAYLOAD HERE IS REAL. The wire bodies are the exact verified bytes that
 * reached the deployed endpoint on 2026-09-11 and sat in `webhook_inbox` as
 * pending, copied out of `measured.ts`; the ACH-side bodies are the ones the
 * ACH consumer's own test uses, also verbatim. Nothing in this file is a
 * fixture shaped like a delivery.
 *
 * THE WHOLE DECISION HALF RUNS WITH NO CREDENTIALS AND NO DATABASE. Every path
 * asserted below returns before the consumer opens a connection, or reaches a
 * stub in place of one, which is what makes these assertions re-runnable in a
 * CI that holds nothing.
 *
 * The one test worth reading first is
 * **"routes on `category`, never on an id prefix"**. That is the bug that
 * already cost this repository its entire ACH rail — `parseEvent()` gated on
 * `associated_object_id.startsWith('ach_transfer_')` while every sandbox id is
 * `sandbox_ach_transfer_...`, so every settlement and every return was dropped
 * with a 200. These ids carry the `sandbox_` prefix on purpose.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  MEASURED_INBOUND_DELIVERY,
  MEASURED_OUTBOUND_DELIVERY,
  MEASURED_OUTBOUND_WIRE,
} from "@/lib/rails/wire/measured";
import type { IncreaseWireTransfer } from "@/lib/rails/wire/types";
import type { RailEventSemantics } from "@/lib/rails/semantics";

import type { ConsumerContext, ConsumerResult, WebhookConsumer } from "../dispatch";
import type { InboxEvent } from "../inbox";
import type * as IncreaseWireModule from "./increase-wire";

// `env.ts` parses eagerly at import and APP_DATABASE_URL is the one variable
// required to boot, while `postgres()` opens no socket until the first query.
// So the module under test is loaded DYNAMICALLY, after this line.
process.env["APP_DATABASE_URL"] ??= "postgres://placeholder/none";

let m: typeof IncreaseWireModule;
beforeAll(async () => {
  m = await import("./increase-wire");
});

const NULL_LOGGER: ConsumerContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
const ctx: ConsumerContext = { now: new Date(), attempt: 1, logger: NULL_LOGGER };

// The redrive in section 5 drains the WHOLE inbox through the real dispatcher,
// which means one authenticated round trip to Increase per outbound wire
// delivery under a rate limit. 30s is the vitest default and it fails that with
// "Test timed out" and nothing else — a red suite that says nothing about the
// system under test. Everything above this line runs in milliseconds.
vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

function inboxEvent(overrides: Partial<InboxEvent>): InboxEvent {
  return {
    id: "00000000-0000-0000-0000-0000000000a1",
    provider: "increase",
    providerEventId: "event_test",
    eventType: null,
    payload: {},
    headers: {},
    rawBody: "{}",
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
    ...overrides,
  };
}

/** A delivery whose payload is one of the measured pointer bodies. */
function delivery(rawBody: string): InboxEvent {
  return inboxEvent({ payload: JSON.parse(rawBody) as Record<string, unknown>, rawBody });
}

/**
 * The ACH consumer, replaced by a spy.
 *
 * The point of every fallthrough assertion below is that the ACH path is
 * REACHED and its answer is returned verbatim — not that this file re-derives
 * what the ACH consumer would have said. `increase-ach.test.ts` owns that.
 */
function achSpy(): { consumer: WebhookConsumer; seen: InboxEvent[] } {
  const seen: InboxEvent[] = [];
  return {
    seen,
    consumer: {
      provider: "increase",
      handle(event: InboxEvent): ConsumerResult {
        seen.push(event);
        return { status: "ignored", reason: "ACH CONSUMER ANSWERED" };
      },
    },
  };
}

/**
 * The wire rows from `rail_event_semantics`, copied from the live table
 * (migration 0025). Injected so the decision half needs no database;
 * production always reads the table, and `resolveEventSemantics`'s own
 * `opts.rows` seam is what is used rather than a new one.
 */
const WIRE_ROWS: readonly RailEventSemantics[] = [
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.created",
    canonicalKind: "wire_originated",
    semantics: "new_event",
    valueDateSource: "payload.created_at",
    note: "The instruction exists and nothing has been put on a wire.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/submitted",
    canonicalKind: "wire_submitted",
    semantics: "new_event",
    valueDateSource: "payload.submission.submitted_at",
    note: "Handed to Fedwire, IMAD issued.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/complete",
    canonicalKind: "wire_settled",
    semantics: "new_event",
    valueDateSource: "payload.submission.submitted_at",
    note: "THE SETTLEMENT, dated from the SUBMISSION timestamp: a wire has no settlement object.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/reversed",
    canonicalKind: "wire_return_of_funds",
    semantics: "new_event",
    valueDateSource: "payload.reversal.created_at",
    note: "A SECOND PAYMENT the beneficiary's bank chose to send, not an unwinding of ours.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/canceled",
    canonicalKind: "wire_canceled",
    semantics: "new_event",
    valueDateSource: "payload.cancellation.canceled_at",
    note: "Cancelled BEFORE submission. No money moved.",
  },
  {
    rail: "wire",
    provider: "increase",
    providerEventType: "wire_transfer.updated/rejected",
    canonicalKind: "wire_rejected",
    semantics: "new_event",
    valueDateSource: "payload.created_at",
    note: "Refused before it left. No IMAD was ever issued.",
  },
];

/** A stub adapter whose read-back returns exactly this transfer. */
function adapterReturning(transfer: IncreaseWireTransfer): {
  readonly client: { getTransfer: (id: string) => Promise<IncreaseWireTransfer> };
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    client: {
      getTransfer: (id: string) => {
        asked.push(id);
        return Promise.resolve(transfer);
      },
    },
  };
}

/** `MEASURED_OUTBOUND_WIRE` with one field changed. Never a hand-built object. */
function measuredWith(overrides: Partial<IncreaseWireTransfer>): IncreaseWireTransfer {
  return { ...MEASURED_OUTBOUND_WIRE, ...overrides } as IncreaseWireTransfer;
}

type Deps = Parameters<typeof IncreaseWireModule.createIncreaseWireConsumer>[0];

function consumerWith(
  transfer: IncreaseWireTransfer,
  extra: Partial<NonNullable<Deps>> = {},
): { consumer: WebhookConsumer; ach: ReturnType<typeof achSpy>; asked: string[] } {
  const ach = achSpy();
  const adapter = adapterReturning(transfer);
  const consumer = m.createIncreaseWireConsumer({
    ach: ach.consumer,
    adapter: adapter as unknown as NonNullable<Deps>["adapter"],
    semanticsRows: WIRE_ROWS,
    ...extra,
  });
  return { consumer, ach, asked: adapter.asked };
}

/* ========================================================================== */
/* 1. The routing decision                                                    */
/* ========================================================================== */

describe("the Increase router: one vendor, two rails", () => {
  it("registers for the VENDOR, because the vendor is what signs the request", () => {
    expect(m.increaseWireConsumer.provider).toBe("increase");
    expect(m.INCREASE_WEBHOOK_PROVIDER).toBe("increase");
  });

  it("routes on `category`, never on an id prefix", async () => {
    // THE BUG THIS ASSERTION EXISTS FOR. `parseEvent()` on the ACH side gated
    // on `associated_object_id.startsWith('ach_transfer_')` while EVERY sandbox
    // id is `sandbox_ach_transfer_...`, so the whole rail was silently dropped
    // with a 200. Both ids below carry the `sandbox_` prefix, so a router that
    // sniffed prefixes would send both to the wrong place.
    const wire = delivery(MEASURED_OUTBOUND_DELIVERY);
    expect(JSON.parse(wire.rawBody)["associated_object_id"]).toMatch(/^sandbox_wire_transfer_/);

    const { consumer, ach, asked } = consumerWith(
      measuredWith({ status: "complete", idempotency_key: null }),
    );
    await consumer.handle(wire, ctx);
    // It went to the wire path: the object was read back, and the ACH consumer
    // never saw it.
    expect(asked).toEqual(["sandbox_wire_transfer_897tmwn18z27tzkqbkhe"]);
    expect(ach.seen).toHaveLength(0);
  });

  it("hands every non-wire Increase category to the ACH consumer, verbatim", async () => {
    const { consumer, ach, asked } = consumerWith(MEASURED_OUTBOUND_WIRE);

    // A real sandbox ACH id — again with the prefix that broke the old gate.
    const ach_ = inboxEvent({
      payload: {
        type: "event",
        associated_object_id: "sandbox_ach_transfer_x5vdo5m7b6k924sszlms",
        associated_object_type: "ach_transfer",
        category: "ach_transfer.updated",
        created_at: "2026-09-11T02:00:00Z",
        id: "sandbox_event_ach_1",
      },
    });
    const result = await consumer.handle(ach_, ctx);

    expect(result).toEqual({ status: "ignored", reason: "ACH CONSUMER ANSWERED" });
    expect(ach.seen).toEqual([ach_]);
    // And the wire adapter was never asked anything — a rail must not answer
    // for a movement it did not see.
    expect(asked).toHaveLength(0);
  });

  it("hands the vendor's own configuration and ledger-mirror events to ACH too", async () => {
    for (const category of [
      "transaction.created",
      "pending_transaction.created",
      "pending_transaction.updated",
      "event_subscription.created",
      "external_account.created",
      "inbound_ach_transfer.created",
    ]) {
      const { consumer, ach } = consumerWith(MEASURED_OUTBOUND_WIRE);
      await consumer.handle(
        inboxEvent({
          payload: {
            type: "event",
            associated_object_id: "sandbox_x_1",
            associated_object_type: category.split(".")[0] ?? "",
            category,
            created_at: "2026-09-11T02:00:00Z",
            id: "sandbox_event_x_1",
          },
        }),
        ctx,
      );
      expect(ach.seen, category).toHaveLength(1);
    }
  });

  it("hands an unreadable payload to ACH rather than inventing a second wording", async () => {
    const { consumer, ach } = consumerWith(MEASURED_OUTBOUND_WIRE);
    const result = await consumer.handle(inboxEvent({ payload: 42 as unknown as object }), ctx);
    expect(result).toEqual({ status: "ignored", reason: "ACH CONSUMER ANSWERED" });
    expect(ach.seen).toHaveLength(1);
  });
});

/* ========================================================================== */
/* 2. Inbound wires — the refusal, and why it is a park                       */
/* ========================================================================== */

describe("an inbound wire nobody can attribute", () => {
  it("parks on the account mapping and posts nothing", async () => {
    const { consumer, asked } = consumerWith(MEASURED_OUTBOUND_WIRE);
    const result = await consumer.handle(delivery(MEASURED_INBOUND_DELIVERY), ctx);

    expect(result.status).toBe("parked");
    if (result.status !== "parked") throw new Error("unreachable");
    expect(result.waitingFor.kind).toBe("inbound_wire_account_mapping");
    expect(result.waitingFor.ref).toBe("sandbox_inbound_wire_transfer_00lkxr57i04x31blx06x");
    // The refusal has to SAY that nothing was posted, because "recognised" and
    // "booked" are the two things an operator must never have to guess between.
    expect(result.reason).toContain("NOTHING WAS POSTED");
    expect(result.reason).toContain("virtual account numbers");
    // PARKED, not ignored: a credit nobody can attribute is exactly what an
    // operator should be shown, and `ignored` would file somebody's money under
    // "recognised and skipped".
    expect(result.status).not.toBe("ignored");
    // And it did not call the provider: there is nothing a read-back could tell
    // us that would make the money attributable.
    expect(asked).toHaveLength(0);
  });
});

/* ========================================================================== */
/* 3. The lifecycle, against the real object                                  */
/* ========================================================================== */

describe("an outbound wire, classified by the table and not by an if", () => {
  const LINKED = `payment:${INSTRUCTION}`;

  it("parks when the transfer names no instruction on this book", async () => {
    const { consumer } = consumerWith(
      measuredWith({ status: "complete", idempotency_key: "corgi-wire-27138-12782" }),
    );
    const result = await consumer.handle(delivery(MEASURED_OUTBOUND_DELIVERY), ctx);

    expect(result.status).toBe("parked");
    if (result.status !== "parked") throw new Error("unreachable");
    expect(result.waitingFor.kind).toBe("payment_instruction");
    // The MEASURED transfer's own key. It was originated by an integration
    // test, not by `originateApprovedWire()`, so it carries no `payment:`
    // prefix — and a wire with no approval behind it is an incident for a
    // person, not a row for a consumer.
    expect(result.waitingFor.ref).toBe("corgi-wire-27138-12782");
    expect(result.reason).toContain("NOTHING WAS POSTED");
  });

  it("refuses a key that is not a uuid BEFORE the query, rather than raising 22P02", async () => {
    // A `::uuid` cast on a malformed string raises 22P02, which the dispatcher
    // would retry eight times and dead-letter as a provider problem. It is not
    // one: it is "this is not one of ours", and the shape check says so before
    // the query. The connection here THROWS if it is touched, so passing is the
    // proof that it was not.
    const forbidden = (() => {
      throw new Error("the connection must never be reached for a malformed id");
    }) as never;

    expect(await m.findWireOutboundLink("payment:not-a-uuid", forbidden)).toBe(null);
    // Not a payment reference at all: the measured transfer's own key, which
    // was set by an integration test rather than by originateApprovedWire().
    expect(await m.findWireOutboundLink("corgi-wire-27138-12782", forbidden)).toBe(null);
    expect(await m.findWireOutboundLink(null, forbidden)).toBe(null);
  });

  it("resolves `wire_transfer.created` to wire_originated and posts nothing", async () => {
    const { consumer } = consumerWith(
      measuredWith({ status: "pending_creating", idempotency_key: LINKED }),
      { conn: stubLink({ releaseEntryId: null }) },
    );
    const result = await consumer.handle(
      delivery(
        JSON.stringify({
          ...JSON.parse(MEASURED_OUTBOUND_DELIVERY),
          category: "wire_transfer.created",
        }),
      ),
      ctx,
    );
    // Nothing about the money has happened yet, so nothing posts — and this is
    // `processed`, not `parked`: a missing release entry is not yet an incident
    // when the wire has not been submitted.
    expect(result.status).toBe("processed");
  });

  it("parks a submitted wire whose instruction was never released — that is an incident", async () => {
    const { consumer } = consumerWith(
      measuredWith({ status: "complete", idempotency_key: LINKED }),
      { conn: stubLink({ releaseEntryId: null }) },
    );
    const result = await consumer.handle(delivery(MEASURED_OUTBOUND_DELIVERY), ctx);

    expect(result.status).toBe("parked");
    if (result.status !== "parked") throw new Error("unreachable");
    expect(result.waitingFor.kind).toBe("payment_instruction_release");
    expect(result.reason).toContain("outside maker-checker");
  });

  it("settles without posting: submission IS settlement, and release already booked it", async () => {
    const { consumer } = consumerWith(
      measuredWith({ status: "complete", idempotency_key: LINKED }),
      { conn: stubLink({ releaseEntryId: "a54424b2-deda-42b9-a140-de9b77041b6d" }) },
    );
    const result = await consumer.handle(delivery(MEASURED_OUTBOUND_DELIVERY), ctx);

    expect(result.status).toBe("processed");
    if (result.status !== "processed") throw new Error("unreachable");
    // Naming both is what wakes anything parked on either.
    expect(result.produced).toEqual([
      { kind: "wire_transfer", ref: "sandbox_wire_transfer_897tmwn18z27tzkqbkhe" },
      { kind: "payment_instruction", ref: INSTRUCTION },
    ]);
  });

  it("parks a cancelled wire, because the release entry says money left and it did not", async () => {
    const { consumer } = consumerWith(
      measuredWith({ status: "canceled", idempotency_key: LINKED }),
      { conn: stubLink({ releaseEntryId: "a54424b2-deda-42b9-a140-de9b77041b6d" }) },
    );
    const result = await consumer.handle(delivery(MEASURED_OUTBOUND_DELIVERY), ctx);

    expect(result.status).toBe("parked");
    if (result.status !== "parked") throw new Error("unreachable");
    expect(result.waitingFor.kind).toBe("wire_release_reversal");
    expect(result.reason).toContain("NOTHING WAS POSTED");
    expect(result.reason).toContain("understated");
  });

  it("parks a step the table has never classified, rather than guessing a value date", async () => {
    const { consumer } = consumerWith(
      measuredWith({
        status: "requires_attention" as IncreaseWireTransfer["status"],
        idempotency_key: LINKED,
      }),
      { conn: stubLink({ releaseEntryId: "e1" }) },
    );
    const result = await consumer.handle(delivery(MEASURED_OUTBOUND_DELIVERY), ctx);

    expect(result.status).toBe("parked");
    if (result.status !== "parked") throw new Error("unreachable");
    expect(result.waitingFor.kind).toBe("rail_event_semantics");
    expect(result.waitingFor.ref).toBe("wire_transfer.updated/requires_attention");
  });

  it("NEVER reads a settlement field — there is none, at any point", () => {
    // The mirror of the ACH trap, asserted as the absence it is. An adapter or
    // a consumer that waited for `settlement.settled_at` here would wait for
    // ever and release nothing.
    expect("settlement" in MEASURED_OUTBOUND_WIRE).toBe(false);
    expect(MEASURED_OUTBOUND_WIRE.submission?.submitted_at).toBe("2026-09-11T03:58:34Z");
  });
});

/* ========================================================================== */
/* 4. The reversal — a second payment, not an unwinding                       */
/* ========================================================================== */

describe("money that came back", () => {
  it("is classified as an ARRIVAL, with the reversal's own IMAD and value date", async () => {
    // The measured object is already `status: 'reversed'`. The four lines that
    // make the argument: a different IMAD, a different transaction, class_name
    // `inbound_wire_reversal`, and a NULL return reason code — null because
    // Fedwire has no return-code table to fill it from.
    const reversal = MEASURED_OUTBOUND_WIRE.reversal;
    expect(reversal?.class_name).toBe("inbound_wire_reversal");
    expect(reversal?.return_reason_code).toBe(null);
    expect(reversal?.input_message_accountability_data).toBe("20260911apvdjfqt599399");
    expect(MEASURED_OUTBOUND_WIRE.submission?.input_message_accountability_data).toBe(
      "20260911sgzamiaa787670",
    );
    expect(reversal?.transaction_id).not.toBe(MEASURED_OUTBOUND_WIRE.transaction_id);
  });

  it("parks when the account behind the instruction has no business to credit", async () => {
    const { consumer } = consumerWith(
      measuredWith({ idempotency_key: `payment:${INSTRUCTION}` }),
      { conn: stubLink({ releaseEntryId: "e1", businessId: null }) },
    );
    const result = await consumer.handle(delivery(MEASURED_OUTBOUND_DELIVERY), ctx);

    expect(result.status).toBe("parked");
    if (result.status !== "parked") throw new Error("unreachable");
    expect(result.waitingFor.kind).toBe("account_business");
    expect(result.reason).toContain("NOTHING WAS POSTED");
  });
});

/* ========================================================================== */
/* 5. THE REDRIVE — the real rows, the real dispatcher, the real registry     */
/* ========================================================================== */

/**
 * Put back the wire deliveries that were dead-lettered for ONE reason — "no
 * consumer registered for provider 'increase'" — and drain them through the
 * real dispatcher with the real registry.
 *
 * This is the test that proves the gap is closed, because the gap was never in
 * the adapter: `observe()` was written, tested against real bytes, and CALLED
 * BY NOTHING in the deployed system. Thirteen signature-verified wire
 * deliveries reached the endpoint on 2026-09-11 and every one of them sat in
 * `webhook_inbox` with `signature_verified_at` set and
 * `processing_error = "no consumer registered for provider 'increase'"`, until
 * the retry cap dead-lettered them.
 *
 * DELIBERATELY NARROW, for the reason the ACH redrive states: it matches on
 * that error string AND on a wire category, so a row that died for any other
 * cause stays exactly where it is. Redriving a dead letter whose cause has not
 * been fixed is how a dead-letter screen becomes a loop.
 *
 * Behind TWO flags, because it changes the state of live rows and because
 * `RUN_DB_TESTS=1` on its own must never do that.
 *
 *     set -a; . ./.env; set +a
 *     RUN_DB_TESTS=1 RUN_WEBHOOK_REDRIVE=1 pnpm vitest run \\
 *       src/lib/webhooks/consumers/increase-wire.test.ts
 */
(process.env["RUN_DB_TESTS"] === "1" && process.env["RUN_WEBHOOK_REDRIVE"] === "1"
  ? describe
  : describe.skip)("the wire deliveries that had nowhere to go", () => {
  it("requeues them and drains them through the registered consumers", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const { createPostgresInboxStore, sqlExecutorFromPostgresJs } = await import("../inbox");
    const { drain } = await import("../drain");

    const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));

    // EVERY wire delivery that was ever orphaned, whatever state the retry
    // loop has since moved it to. `processing_error` is NOT cleared when a row
    // parks or dies — it is the last thing that went wrong, kept on purpose —
    // so it is the durable mark of "this delivery had no consumer", and it is
    // what selects the set. The dead ones among them are requeued; the rest
    // are already in the queue.
    const orphaned = await sql<{ id: string; event_type: string | null; state: string }[]>`
      SELECT id, event_type, state::text AS state FROM webhook_inbox
       WHERE provider = 'increase'
         AND processing_error LIKE '%no consumer registered for provider%'
         AND payload->>'category' IN (
           'wire_transfer.created', 'wire_transfer.updated',
           'inbound_wire_transfer.created', 'inbound_wire_transfer.updated')
       ORDER BY received_at`;
    expect(orphaned.length).toBeGreaterThan(0);

    const dead = orphaned.filter((row) => row.state === "dead");
    let requeued = 0;
    for (const row of dead) {
      if (await store.requeueDeadLetter(row.id, new Date())) requeued += 1;
    }
    expect(requeued).toBe(dead.length);

    const result = await drain({ maxBatches: 40 });

    // THE ASSERTION THAT MATTERS. `drain.ts` imports every consumer by a
    // VARIABLE specifier so a module still being written cannot break the
    // build — which means a consumer that fails to load is a runtime warning
    // and not a red build. An empty `missingConsumers` is the only proof that
    // this one actually loaded.
    expect(result.missingConsumers).toEqual([]);
    expect(result.consumers).toContain("increase-wire");

    // NOT ONE OF THEM IS STILL IN THE QUEUE OR STILL DEAD. Every one reached a
    // state a human can act on: `done`, or `parked` with a referent naming the
    // exact thing that is missing. `pending` would mean the drain never got to
    // it; `dead` would mean it failed again.
    const ids = orphaned.map((d) => d.id);
    const outcomes = await sql<
      { state: string; parked_on_kind: string | null; n: number }[]
    >`
      SELECT state::text AS state, parked_on_kind, count(*)::int AS n
        FROM webhook_inbox
       WHERE id = ANY(${ids}::uuid[])
       GROUP BY 1, 2 ORDER BY 3 DESC`;
    for (const row of outcomes) {
      expect(["done", "parked"], JSON.stringify(row)).toContain(row.state);
      if (row.state === "parked") expect(row.parked_on_kind).not.toBe(null);
    }

    // And the two referents they park on are the two refusals this consumer
    // declares, not some third thing nobody wrote down.
    const kinds = new Set(
      outcomes.map((row) => row.parked_on_kind).filter((kind): kind is string => kind !== null),
    );
    for (const kind of kinds) {
      expect(
        ["payment_instruction", "inbound_wire_account_mapping", "payment_instruction_release"],
        kind,
      ).toContain(kind);
    }

    // Printed rather than only asserted: "what did the drain actually do" is
    // the question this exists to answer, and a count in a log beats a green
    // tick that says nothing.
    // eslint-disable-next-line no-console
    console.log("redrive:", JSON.stringify({ requeued, outcomes }, null, 2));
  });
});

/* -------------------------------------------------------------------------- */
/* The stub connection                                                        */
/* -------------------------------------------------------------------------- */

const BUSINESS = "e274546d-6bdd-5266-b0fb-cc839a7811f9";
const ACCOUNT = "a0c41a37-2be1-5c30-bfe9-03455f048fac";
const ENTITY = "00000000-0000-0000-0000-0000000000e1";
const INSTRUCTION = "f087aacb-860f-4565-8ca0-bca9f31abeec";

/**
 * A `Sql`-shaped tag that answers the two queries this path makes, and throws
 * on a third.
 *
 * Deliberately NOT a mock of `postgres`. It answers `findWireOutboundLink()`'s
 * own SELECT and the one `readAccountIdentity()` makes through the same tag,
 * and throws on anything else — so a future edit that adds a query to this
 * path fails here loudly rather than silently reading nothing.
 *
 * The two are told apart by a column that only one of them selects, NOT by the
 * table each reads. `src/lib/ledger/boundary.test.ts` scans this file too, and
 * a test that spelled the ledger's table names would be adding a reference to
 * the ledger's schema from outside it — which is the debt that test is a
 * ratchet against, and it is right to be scanned.
 */
function stubLink(opts: {
  releaseEntryId: string | null;
  businessId?: string | null;
}): never {
  const businessId = opts.businessId === undefined ? BUSINESS : opts.businessId;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join("?");
    // `release_entry_id` is selected by findWireOutboundLink() and by nothing
    // else on this path.
    if (text.includes("release_entry_id")) {
      return Promise.resolve([
        {
          id: String(values[0]),
          account_id: ACCOUNT,
          amount_cents: "4200",
          release_entry_id: opts.releaseEntryId,
        },
      ]);
    }
    // `rail_control` is selected by readAccountIdentity() and by nothing else.
    if (text.includes("rail_control")) {
      return Promise.resolve([
        {
          id: ACCOUNT,
          entity_id: ENTITY,
          business_id: businessId,
          parent_id: null,
          code: "2100",
          name: "Ridgeline Robotics, Inc. — business current account",
          type: "liability",
          book: "financial",
          currency: "USD",
          rail_control: null,
          is_postable: true,
          normal_side: "credit",
          opened_at: new Date("2026-01-01T00:00:00Z"),
          closed_at: null,
        },
      ]);
    }
    throw new Error(`the stub connection was asked an unexpected query: ${text.slice(0, 120)}`);
  };
  return tag as never;
}
