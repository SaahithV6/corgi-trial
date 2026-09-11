/**
 * The Plaid consumer.
 *
 * Entirely decision-half, and it stays that way after migration 0056: the
 * consumer now WRITES item state, but the recorder is injected (see
 * `ItemObservationRecorder` in ./plaid-item.ts), so these tests prove the
 * decisions — which families are recognised, what an operator is told, what
 * reaches storage and what deliberately does not — with no database and no
 * network. The write itself is proven against a live database by
 * `src/lib/rails/plaid/item-store.test.ts`.
 *
 * The payloads are the REAL `ITEM`/`ERROR` bodies out of `webhook_inbox`,
 * copied verbatim.
 */
import { describe, expect, it } from "vitest";

import type { RecordObservationArgs } from "@/lib/rails/plaid/item-store";

import type { ConsumerContext, WebhookConsumer } from "../dispatch";
import type { InboxEvent } from "../inbox";
import {
  asPlaidFacts,
  createPlaidItemConsumer,
  describeItemEvent,
  plaidItemConsumer,
} from "./plaid-item";

const NULL_LOGGER: ConsumerContext["logger"] = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
const ctx: ConsumerContext = { now: new Date(), attempt: 1, logger: NULL_LOGGER };

/** Verbatim, one of the three deliveries that were dead-lettered. */
const ITEM_ERROR = {
  environment: "sandbox",
  error: {
    display_message: null,
    error_code: "ITEM_LOGIN_REQUIRED",
    error_message:
      "the login details of this item have changed (credentials, MFA, or required user action) and a user login is required to update this information. use Link's update mode to restore the item to a good state",
    error_type: "ITEM_ERROR",
    status: 400,
  },
  item_id: "8MppL6n1rKTdJXD5Dkd8sRjPd5dm4vixgGNRZ",
  webhook_code: "ERROR",
  webhook_type: "ITEM",
};

function inboxEvent(payload: unknown, eventType: string): InboxEvent {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    provider: "plaid",
    providerEventId: "sha256:test",
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

describe("asPlaidFacts", () => {
  it("reads the real ITEM/ERROR body", () => {
    expect(asPlaidFacts(ITEM_ERROR)).toEqual({
      webhookType: "ITEM",
      webhookCode: "ERROR",
      itemId: "8MppL6n1rKTdJXD5Dkd8sRjPd5dm4vixgGNRZ",
      errorCode: "ITEM_LOGIN_REQUIRED",
      errorType: "ITEM_ERROR",
      errorMessage: expect.stringContaining("login details of this item have changed"),
    });
  });
});

describe("describeItemEvent — written for an operator, not for Plaid", () => {
  it("says what a human has to do, and that no money is affected", () => {
    const facts = asPlaidFacts(ITEM_ERROR);
    expect(facts).not.toBeNull();
    const text = describeItemEvent(facts!);
    expect(text).toContain("re-authenticate");
    expect(text).toContain("No money is affected");
  });
});

describe("the consumer", () => {
  /**
   * A recorder that remembers what it was asked to write and answers the way
   * `UNIQUE (inbox_id)` does: true the first time, false on a redelivery.
   */
  function spyRecorder(): {
    readonly consumer: WebhookConsumer;
    readonly writes: RecordObservationArgs[];
  } {
    const writes: RecordObservationArgs[] = [];
    const seen = new Set<string>();
    const consumer = createPlaidItemConsumer({
      record: (args) => {
        writes.push(args);
        const key = args.inboxId ?? "";
        if (seen.has(key)) return Promise.resolve(false);
        seen.add(key);
        return Promise.resolve(true);
      },
    });
    return { consumer, writes };
  }

  it("RECORDS the item state instead of describing it and forgetting", async () => {
    const { consumer, writes } = spyRecorder();
    const event = inboxEvent(ITEM_ERROR, "ITEM.ERROR");

    const result = await consumer.handle(event, ctx);

    expect(result.status).toBe("ignored");
    expect(result.status === "ignored" && result.reason).toContain("plaid_item_event");
    // The whole point: Plaid's own words reached durable storage, with the
    // delivery they came from cited.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      itemId: "8MppL6n1rKTdJXD5Dkd8sRjPd5dm4vixgGNRZ",
      source: "webhook",
      webhookCode: "ERROR",
      errorCode: "ITEM_LOGIN_REQUIRED",
      errorType: "ITEM_ERROR",
      inboxId: event.id,
    });
  });

  it("no longer claims there is nowhere to put an item's state", async () => {
    const { consumer } = spyRecorder();
    const result = await consumer.handle(inboxEvent(ITEM_ERROR, "ITEM.ERROR"), ctx);
    // The sentence migration 0056 removed. If this ever comes back, the
    // consumer has stopped recording and the health surface has gone blind
    // again without anything else failing.
    expect(result.status === "ignored" && result.reason).not.toContain("no plaid_item table");
  });

  it("a redelivery writes nothing twice and says so", async () => {
    const { consumer, writes } = spyRecorder();
    const event = inboxEvent(ITEM_ERROR, "ITEM.ERROR");

    const first = await consumer.handle(event, ctx);
    const second = await consumer.handle(event, ctx);

    expect(first.status).toBe("ignored");
    expect(second.status).toBe("ignored");
    expect(first.status === "ignored" && first.reason).toContain("Recorded in plaid_item_event");
    expect(second.status === "ignored" && second.reason).toContain("Already recorded");
    // Both attempts reached the recorder — the index decides, not an `if`.
    expect(writes).toHaveLength(2);
  });

  it("refuses to record a delivery that names no item", async () => {
    const { consumer, writes } = spyRecorder();
    const noItem = { webhook_type: "ITEM", webhook_code: "ERROR", environment: "sandbox" };

    const result = await consumer.handle(inboxEvent(noItem, "ITEM.ERROR"), ctx);

    expect(result.status).toBe("ignored");
    expect(result.status === "ignored" && result.reason).toContain("no item_id");
    // Inventing a placeholder id would put a row in v_plaid_item_state that
    // refers to nothing.
    expect(writes).toHaveLength(0);
  });

  it("parks a family nobody has decided about, rather than waving it through", async () => {
    const transfer = {
      webhook_type: "TRANSFER",
      webhook_code: "TRANSFER_EVENTS_UPDATE",
      environment: "sandbox",
    };
    const result = await plaidItemConsumer.handle(
      inboxEvent(transfer, "TRANSFER.TRANSFER_EVENTS_UPDATE"),
      ctx,
    );
    expect(result.status).toBe("parked");
    expect(result.status === "parked" && result.waitingFor).toEqual({
      kind: "plaid_webhook_type",
      ref: "TRANSFER.TRANSFER_EVENTS_UPDATE",
    });
    expect(result.status === "parked" && result.reason).toContain("rail_event_semantics");
  });

  it("reads a double-encoded payload written before the ::text::jsonb fix", async () => {
    const { consumer, writes } = spyRecorder();
    const result = await consumer.handle(
      inboxEvent(JSON.stringify(ITEM_ERROR), "ITEM.ERROR"),
      ctx,
    );
    expect(result.status).toBe("ignored");
    // And it is recorded, not merely parsed: a delivery stored in the older
    // encoding still reaches the item log.
    expect(writes).toHaveLength(1);
  });
});
