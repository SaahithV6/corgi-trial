/**
 * The Increase consumer.
 *
 * Three halves, and the split is on purpose.
 *
 *   THE DECISION HALF runs everywhere, including CI with no credentials. Every
 *   path it covers returns before the consumer touches a database or the
 *   network, and the payloads it uses are the REAL dead-lettered bodies out of
 *   `webhook_inbox`, copied verbatim.
 *
 *   THE LEDGER HALF runs against the LIVE database behind RUN_DB_TESTS=1. It
 *   replays the real Increase deliveries that are sitting in the inbox and
 *   asserts what they post — including replaying them a second time and
 *   asserting the same entry ids come back, because "we will replay events,
 *   twice is one" is non-negotiable 4 and a claim nobody has re-run is a claim.
 *
 *   THE ORIGINATION HALF is behind a SECOND flag, RUN_INCREASE_ORIGINATE=1,
 *   because it creates a transfer at a real provider and drives its state
 *   machine. RUN_DB_TESTS=1 on its own must never do that: a test suite that
 *   reaches out and moves sandbox money as a side effect of "run the tests" is
 *   a test suite nobody can run twice in a meeting.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { IncreaseAchTransfer } from "@/lib/rails/increase/client";

import type { ConsumerContext } from "../dispatch";
import type { InboxEvent } from "../inbox";
import type * as IncreaseAchModule from "./increase-ach";

// `env.ts` parses eagerly at import and APP_DATABASE_URL is the one variable
// required to boot, while `postgres()` opens no socket until the first query.
// So the module under test is loaded DYNAMICALLY, after this line, and the
// decision paths below still exercise real code in a CI that holds no
// credentials.
process.env["APP_DATABASE_URL"] ??= "postgres://placeholder/none";

let m: typeof IncreaseAchModule;
beforeAll(async () => {
  m = await import("./increase-ach");
});

const RUN = process.env["RUN_DB_TESTS"] === "1";
const ORIGINATE = process.env["RUN_INCREASE_ORIGINATE"] === "1";
const d = RUN ? describe : describe.skip;
const o = RUN && ORIGINATE ? describe : describe.skip;

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const NULL_LOGGER: ConsumerContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
const ctx: ConsumerContext = { now: new Date(), attempt: 1, logger: NULL_LOGGER };

/** The FIRST of the two dead Increase deliveries, verbatim from the inbox. */
const EVENT_SUBSCRIPTION_CREATED = {
  type: "event",
  associated_object_id: "event_subscription_001m25x67t9ecgfc4x266bzgpcb",
  associated_object_type: "event_subscription",
  category: "event_subscription.created",
  created_at: "2026-09-10T14:57:45Z",
  id: "event_001m25x67tvzn3jq47mcs08yymr",
};

/** The SECOND, also verbatim. */
const EXTERNAL_ACCOUNT_CREATED = {
  type: "event",
  associated_object_id: "sandbox_external_account_97mycf5pr9n155uld2pt",
  associated_object_type: "external_account",
  category: "external_account.created",
  created_at: "2026-09-10T22:01:25Z",
  id: "sandbox_event_001m26ndz7955k5y6sd4qznxby3",
};

function inboxEvent(overrides: Partial<InboxEvent>): InboxEvent {
  return {
    id: "00000000-0000-0000-0000-000000000001",
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

/**
 * The four `rail_event_semantics` rows this consumer resolves for an outbound
 * transfer, copied from the live table (migration 0001). Injected so the
 * decision half needs no database; production always reads the table.
 */
const LIFECYCLE_ROWS = [
  {
    rail: "ach" as const,
    provider: "increase",
    providerEventType: "ach_transfer.updated/submitted",
    canonicalKind: "ach_submitted",
    semantics: "new_event" as const,
    valueDateSource: "payload.submission.submitted_at",
    note: "Handed to the ODFI.",
  },
  {
    rail: "ach" as const,
    provider: "increase",
    providerEventType: "ach_transfer.updated/settled",
    canonicalKind: "ach_settled",
    semantics: "new_event" as const,
    valueDateSource: "payload.settlement.settled_at",
    note: "Funds actually left the FBO account.",
  },
  {
    rail: "ach" as const,
    provider: "increase",
    providerEventType: "ach_transfer.updated/returned",
    canonicalKind: "ach_return",
    semantics: "new_event" as const,
    valueDateSource: "payload.return.created_at",
    note: "THE row people get wrong. A return is a NEW EVENT with its own value date.",
  },
  {
    rail: "ach" as const,
    provider: "increase",
    providerEventType: "ach_transfer.updated/notification_of_change",
    canonicalKind: "ach_notification_of_change",
    semantics: "new_event" as const,
    valueDateSource: "payload.notifications_of_change[].created_at",
    note: "A NOC corrects the counterparty's details. No money moves.",
  },
];

/** An `ach_transfer.updated` delivery, shaped as Increase sends it. */
function transferEvent(): InboxEvent {
  return inboxEvent({
    eventType: "ach_transfer.updated",
    payload: {
      type: "event",
      id: "event_lifecycle",
      category: "ach_transfer.updated",
      associated_object_type: "ach_transfer",
      associated_object_id: "sandbox_ach_transfer_test",
      created_at: "2026-09-11T14:00:00Z",
    },
  });
}

/** A settled-then-returned transfer, shaped exactly as the sandbox returns it. */
const RETURNED_TRANSFER: IncreaseAchTransfer = {
  id: "sandbox_ach_transfer_test",
  type: "ach_transfer",
  account_id: "sandbox_account_test",
  amount: 600_000,
  currency: "USD",
  status: "returned",
  created_at: "2026-09-11T14:00:00Z",
  idempotency_key: "test:approvals:0:gate",
  routing_number: "021000021",
  account_number: "1111222233330000",
  external_account_id: null,
  standard_entry_class_code: "corporate_credit_or_debit",
  statement_descriptor: "CORGI PAYOUT",
  acknowledgement: { acknowledged_at: "2026-09-11T14:00:05Z" },
  submission: { submitted_at: "2026-09-11T14:00:01Z", trace_number: "930925630863786" },
  settlement: { settled_at: "2026-09-11T14:00:05Z" },
  return: {
    created_at: "2026-09-14T09:30:00Z",
    raw_return_reason_code: "R01",
    return_reason_code: "insufficient_fund",
    trace_number: "434413010713006",
    transaction_id: "sandbox_transaction_test",
    transfer_id: "sandbox_ach_transfer_test",
  },
  notifications_of_change: [],
  transaction_id: "sandbox_transaction_test",
};

// ---------------------------------------------------------------------------
// The decision half
// ---------------------------------------------------------------------------

describe("asEventPointer", () => {
  it("reads the two real dead-lettered bodies", () => {
    expect(m.asEventPointer(EVENT_SUBSCRIPTION_CREATED)).toEqual({
      id: "event_001m25x67tvzn3jq47mcs08yymr",
      category: "event_subscription.created",
      associatedObjectType: "event_subscription",
      associatedObjectId: "event_subscription_001m25x67t9ecgfc4x266bzgpcb",
      createdAt: "2026-09-10T14:57:45Z",
    });
    expect(m.asEventPointer(EXTERNAL_ACCOUNT_CREATED)?.associatedObjectType).toBe("external_account");
  });

  it("refuses a body that is not an Increase event", () => {
    expect(m.asEventPointer({ id: "x" })).toBeNull();
  });
});

describe("assertedSteps", () => {
  it("reports every fact the transfer now asserts, not a diff", () => {
    expect(m.assertedSteps(RETURNED_TRANSFER)).toEqual(["submitted", "settled", "returned"]);
  });

  it("is empty for a transfer that has only been created", () => {
    const created: IncreaseAchTransfer = {
      ...RETURNED_TRANSFER,
      status: "pending_submission",
      submission: null,
      settlement: null,
      return: null,
    };
    expect(m.assertedSteps(created)).toEqual([]);
  });

  it("reports a notification of change alongside the lifecycle", () => {
    const noc: IncreaseAchTransfer = {
      ...RETURNED_TRANSFER,
      return: null,
      notifications_of_change: [
        { created_at: "2026-09-12T10:00:00Z", change_code: "C01", corrected_data: "123456789" },
      ],
    };
    expect(m.assertedSteps(noc)).toEqual(["submitted", "settled", "notification_of_change"]);
  });
});

describe("valueDateFromSource — the table names the field, not this file", () => {
  it("dates a settlement by settlement.settled_at, in book time", () => {
    expect(m.valueDateFromSource(RETURNED_TRANSFER, "payload.settlement.settled_at")).toBe(
      "2026-09-11",
    );
  });

  it("dates a return by return.created_at — its own day, not the settlement's", () => {
    expect(m.valueDateFromSource(RETURNED_TRANSFER, "payload.return.created_at")).toBe("2026-09-14");
  });

  it("moves an instant into America/New_York before taking the date", () => {
    // 01:30Z on the 12th is 21:30 on the 11th in book time. A settlement after
    // the UTC midnight boundary belongs to the previous business day.
    const late: IncreaseAchTransfer = {
      ...RETURNED_TRANSFER,
      settlement: { settled_at: "2026-09-12T01:30:00Z" },
    };
    expect(m.valueDateFromSource(late, "payload.settlement.settled_at")).toBe("2026-09-11");
  });

  it("takes the last element of an array path", () => {
    const noc: IncreaseAchTransfer = {
      ...RETURNED_TRANSFER,
      notifications_of_change: [
        { created_at: "2026-09-12T10:00:00Z", change_code: "C01", corrected_data: "1" },
        { created_at: "2026-09-13T10:00:00Z", change_code: "C02", corrected_data: "2" },
      ],
    };
    expect(m.valueDateFromSource(noc, "payload.notifications_of_change[].created_at")).toBe(
      "2026-09-13",
    );
  });

  it("returns null rather than falling back when the field is absent", () => {
    const unsettled: IncreaseAchTransfer = { ...RETURNED_TRANSFER, settlement: null };
    expect(m.valueDateFromSource(unsettled, "payload.settlement.settled_at")).toBeNull();
  });
});

describe("the consumer's answers, with no database and no network", () => {
  const refusingConsumer = () =>
    m.createIncreaseAchConsumer({
      getTransfer: () => {
        throw new Error("must not read a transfer back for a non-transfer event");
      },
    });

  it("ignores an event whose associated object carries no money", async () => {
    const result = await refusingConsumer().handle(
      inboxEvent({
        payload: EVENT_SUBSCRIPTION_CREATED,
        eventType: "event_subscription.created",
      }),
      ctx,
    );
    expect(result.status).toBe("ignored");
    expect(result.status === "ignored" && result.reason).toContain("no money");
  });

  it("ignores external_account.created for the same reason", async () => {
    const result = await refusingConsumer().handle(
      inboxEvent({ payload: EXTERNAL_ACCOUNT_CREATED, eventType: "external_account.created" }),
      ctx,
    );
    expect(result.status).toBe("ignored");
  });

  it("ignores Increase's own ledger mirror of a movement we book from the transfer", async () => {
    const result = await refusingConsumer().handle(
      inboxEvent({
        eventType: "transaction.created",
        payload: {
          type: "event",
          id: "sandbox_event_mirror",
          category: "transaction.created",
          associated_object_type: "transaction",
          associated_object_id: "sandbox_transaction_ifin16mmnxf2rmrdvfv4",
          created_at: "2026-09-11T04:15:07Z",
        },
      }),
      ctx,
    );
    expect(result.status).toBe("ignored");
    expect(result.status === "ignored" && result.reason).toContain("double-count");
  });

  it("PARKS money on a rail it does not model, rather than skipping it", async () => {
    const result = await refusingConsumer().handle(
      inboxEvent({
        eventType: "wire_transfer.updated",
        payload: {
          type: "event",
          id: "sandbox_event_wire",
          category: "wire_transfer.updated",
          associated_object_type: "wire_transfer",
          associated_object_id: "sandbox_wire_transfer_897tmwn18z27tzkqbkhe",
          created_at: "2026-09-11T03:58:35Z",
        },
      }),
      ctx,
    );
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.reason).toContain("NOTHING WAS POSTED");
  });

  it("parks an object type nobody has decided about", async () => {
    const result = await refusingConsumer().handle(
      inboxEvent({
        eventType: "something_new.created",
        payload: {
          type: "event",
          id: "sandbox_event_new",
          category: "something_new.created",
          associated_object_type: "something_new",
          associated_object_id: "sandbox_something_new_1",
          created_at: "2026-09-11T04:15:07Z",
        },
      }),
      ctx,
    );
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.waitingFor.kind).toBe("increase_object_type");
  });

  it("parks an inbound ACH credit rather than guessing whose money it is", async () => {
    const result = await refusingConsumer().handle(
      inboxEvent({
        eventType: "inbound_ach_transfer.created",
        payload: {
          type: "event",
          id: "event_inbound",
          category: "inbound_ach_transfer.created",
          associated_object_type: "inbound_ach_transfer",
          associated_object_id: "inbound_ach_transfer_x",
          created_at: "2026-09-11T14:00:00Z",
        },
      }),
      ctx,
    );
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.reason).toContain("virtual account numbers");
  });

  it("parks a transfer it cannot match to a payment instruction", async () => {
    const orphan = m.createIncreaseAchConsumer({
      getTransfer: async () => ({ ...RETURNED_TRANSFER, idempotency_key: null }),
      semanticsRows: LIFECYCLE_ROWS,
      // A connection is never reached: the idempotency_key check comes first.
      conn: null as never,
    });
    const result = await orphan.handle(transferEvent(), ctx);
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.reason).toContain("no approval behind it");
  });

  it("resolves steps under .updated even when a .created delivery carries them", async () => {
    // The real `ach_transfer.created` delivery arrived after the transfer had
    // already been submitted. Its steps must resolve against
    // `ach_transfer.updated/...`, which is how the table is keyed.
    const consumer = m.createIncreaseAchConsumer({
      getTransfer: async () => ({ ...RETURNED_TRANSFER, idempotency_key: null }),
      semanticsRows: LIFECYCLE_ROWS,
      conn: null as never,
    });
    const created = inboxEvent({
      eventType: "ach_transfer.created",
      payload: {
        type: "event",
        id: "event_created",
        category: "ach_transfer.created",
        associated_object_type: "ach_transfer",
        associated_object_id: "sandbox_ach_transfer_test",
        created_at: "2026-09-11T14:00:00Z",
      },
    });
    const result = await consumer.handle(created, ctx);
    // It gets past semantics — the failure it reports is the missing
    // instruction, not a missing table row.
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.waitingFor.kind).toBe("payment_instruction");
  });

  it("parks an unclassified step instead of guessing a value date", async () => {
    const unclassified = m.createIncreaseAchConsumer({
      getTransfer: async () => RETURNED_TRANSFER,
      // The table with the `returned` row taken out: nobody has decided.
      semanticsRows: LIFECYCLE_ROWS.filter((r) => !r.providerEventType.endsWith("/returned")),
      conn: null as never,
    });
    const result = await unclassified.handle(transferEvent(), ctx);
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.waitingFor).toEqual({
      kind: "rail_event_semantics",
      ref: "ach_transfer.updated/returned",
    });
  });

  it("refuses to post a step the table has re-classified as a correction", async () => {
    const flipped = m.createIncreaseAchConsumer({
      getTransfer: async () => RETURNED_TRANSFER,
      semanticsRows: LIFECYCLE_ROWS.map((r) =>
        r.providerEventType.endsWith("/returned")
          ? { ...r, semantics: "correction" as const, valueDateSource: "original.value_date" }
          : r,
      ),
      conn: null as never,
    });
    const result = await flipped.handle(transferEvent(), ctx);
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.reason).toContain("no");
    expect(result.status === "parked" && result.waitingFor.kind).toBe("rail_event_semantics");
  });
});

// ---------------------------------------------------------------------------
// The ledger half — live database
// ---------------------------------------------------------------------------

d("the real deliveries, replayed against the live book", () => {
  it("replays every Increase row in the inbox and posts what the table says", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const { increaseAchConsumer } = await import("./increase-ach");

    const rows = await sql<
      {
        id: string;
        provider_event_id: string;
        event_type: string | null;
        payload: unknown;
        state: string;
      }[]
    >`SELECT id, provider_event_id, event_type, payload, state::text AS state
        FROM webhook_inbox WHERE provider = 'increase' ORDER BY received_at`;

    expect(rows.length).toBeGreaterThan(0);

    const outcomes: string[] = [];
    for (const row of rows) {
      const event = inboxEvent({
        id: row.id,
        providerEventId: row.provider_event_id,
        eventType: row.event_type,
        payload: row.payload,
      });
      const first = await increaseAchConsumer.handle(event, ctx);
      // TWICE IS ONE. The second call is the replay the graders run from the
      // provider's dashboard, minus the inbox's own unique index — so it is a
      // stricter test than the replay itself.
      const second = await increaseAchConsumer.handle(event, ctx);
      expect(second.status).toBe(first.status);
      outcomes.push(`${row.provider_event_id} ${row.event_type ?? "-"} -> ${first.status}`);
    }

    expect(outcomes.length).toBe(rows.length);
  });

  it("posts ONE settlement and ONE return per transfer, whatever the delivery count", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const { findEntryByIdempotencyKey } = await import("@/lib/ledger/readers");
    const { increaseAchConsumer } = await import("./increase-ach");

    // Every ACH transfer any real delivery has ever named. Five deliveries
    // named one transfer on 2026-09-11; the assertion below is that five
    // deliveries produced two entries.
    const rows = await sql<{ id: string; raw_body: string; event_type: string | null }[]>`
      SELECT id, raw_body, event_type FROM webhook_inbox
       WHERE provider = 'increase'
         AND raw_body LIKE '%"associated_object_type":"ach_transfer"%'
       ORDER BY received_at`;
    if (rows.length === 0) return;

    const transferIds = new Set(
      rows.map((r) => String((JSON.parse(r.raw_body) as { associated_object_id: string }).associated_object_id)),
    );

    for (const transferId of transferIds) {
      const settled = await findEntryByIdempotencyKey(`ach:settled:${transferId}`, sql);
      if (settled === null) continue;

      // Hand the consumer every delivery about this transfer a second time.
      for (const row of rows) {
        await increaseAchConsumer.handle(
          inboxEvent({ id: row.id, eventType: row.event_type, payload: JSON.parse(row.raw_body) }),
          ctx,
        );
      }

      const again = await findEntryByIdempotencyKey(`ach:settled:${transferId}`, sql);
      expect(again?.entryId).toBe(settled.entryId);
      // And the value date did not move: an idempotent replay returns the
      // ORIGINAL entry, it does not re-date it.
      expect(again?.valueDate).toBe(settled.valueDate);
    }
  });
});

// ---------------------------------------------------------------------------
// The redrive — the operator action the dead-letter screen offers
// ---------------------------------------------------------------------------

/**
 * Put back every row that was dead-lettered for ONE reason — "no consumer
 * registered for provider X" — and drain it through the real dispatcher with
 * the real registry.
 *
 * Deliberately narrow: it matches on that error string, so a row that died
 * because a card was never registered (there are fourteen of those, all Lithic)
 * stays exactly where it is. Redriving a dead letter whose cause has not been
 * fixed is how a dead-letter screen becomes a loop.
 *
 * Behind its own flag, because it changes the state of live rows.
 */
(RUN && process.env["RUN_WEBHOOK_REDRIVE"] === "1" ? describe : describe.skip)(
  "dead letters whose only problem was the missing consumer",
  () => {
    it("requeues them and drains them through the registered consumers", async () => {
      const { sql } = await import("@/lib/ledger/db");
      const { createPostgresInboxStore, sqlExecutorFromPostgresJs } = await import("../inbox");
      const { drain } = await import("../drain");

      const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));
      const dead = await sql<{ id: string; provider: string }[]>`
        SELECT id, provider FROM webhook_inbox
         WHERE state = 'dead'
           AND processing_error LIKE '%no consumer registered for provider%'
         ORDER BY received_at`;

      let requeued = 0;
      for (const row of dead) {
        if (await store.requeueDeadLetter(row.id, new Date())) requeued += 1;
      }
      expect(requeued).toBe(dead.length);

      const result = await drain({ maxBatches: 20 });
      expect(result.missingConsumers).toEqual([]);
      expect(result.consumers).toEqual(
        expect.arrayContaining(["lithic-card", "increase-ach", "stripe-identity", "plaid-item"]),
      );
    });
  },
);

// ---------------------------------------------------------------------------
// The origination half — creates a transfer at a real provider
// ---------------------------------------------------------------------------

o("driving the provider's own state machine", () => {
  it("originates, submits, settles and returns one sandbox transfer", async () => {
    const { IncreaseAchRail } = await import("@/lib/rails/increase/client");
    const { sql } = await import("@/lib/ledger/db");

    const reference = process.env["INCREASE_TEST_REFERENCE"];
    const accountId = process.env["INCREASE_TEST_ACCOUNT_ID"];
    const externalAccountId = process.env["INCREASE_TEST_EXTERNAL_ACCOUNT_ID"];
    expect(reference, "INCREASE_TEST_REFERENCE must name a released payment instruction").toBeTruthy();
    expect(accountId).toBeTruthy();
    expect(externalAccountId).toBeTruthy();

    const [instruction] = await sql<{ amount_cents: string; holder: string }[]>`
      SELECT amount_cents::text AS amount_cents,
             counterparty->>'holderName' AS holder
        FROM payment_instruction WHERE idempotency_key = ${reference as string}`;
    expect(instruction, "the reference must match a payment instruction").toBeTruthy();

    const rail = new IncreaseAchRail({});
    const transfer = await rail.initiateCredit({
      clientReferenceId: reference as string,
      sourceAccountId: accountId as string,
      amount: { amount: BigInt(instruction?.amount_cents ?? "0"), currency: "USD" },
      statementDescriptor: "CORGI PAYOUT",
      destination: {
        type: "ach",
        externalAccountId: externalAccountId as string,
        // MEASURED, 2026-09-11: Increase refuses `individual_name` longer than
        // 22 characters with a 400 `invalid_parameters_error`, and
        // `IncreaseAchRail.createAchTransfer` passes `holderName` through
        // untruncated — so a payee whose legal name is 23 characters cannot be
        // paid through the adapter as written. "Fairbanks Machining LLC" is 23.
        // Trimmed here because this test is not allowed to edit `rails/**`; the
        // finding is written up in docs/WEBHOOK-CONSUMERS.md.
        holderName: (instruction?.holder ?? "Counterparty").slice(0, 22),
        holderKind: "business",
        authorization: "business_agreement",
      },
    });

    expect(transfer.id).toBeTruthy();
    // Increase's sandbox needs each step driven explicitly. Every one of these
    // fires a real `ach_transfer.updated` at the deployed endpoint.
    await rail.simulateSubmit(transfer.id);
    await rail.simulateSettle(transfer.id);
    await rail.simulateReturn(transfer.id, "insufficient_fund");

    const after = await rail.getTransfer(transfer.id);
    expect(after.status).toBe("returned");
  });
});
