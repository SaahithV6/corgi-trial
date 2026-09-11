/**
 * The Plaid consumer.
 *
 * Entirely decision-half: this consumer touches no database and no network by
 * design, because there is nothing for it to touch (see its header). The
 * payloads are the REAL dead-lettered `ITEM`/`ERROR` bodies out of
 * `webhook_inbox`, copied verbatim.
 */
import { describe, expect, it } from "vitest";

import type { ConsumerContext } from "../dispatch";
import type { InboxEvent } from "../inbox";
import { asPlaidFacts, describeItemEvent, plaidItemConsumer } from "./plaid-item";

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
  it("acknowledges item health and says why nothing could be done with it", async () => {
    const result = await plaidItemConsumer.handle(inboxEvent(ITEM_ERROR, "ITEM.ERROR"), ctx);
    expect(result.status).toBe("ignored");
    expect(result.status === "ignored" && result.reason).toContain("no plaid_item table");
  });

  it("is idempotent for free: the same delivery twice is the same answer", async () => {
    const event = inboxEvent(ITEM_ERROR, "ITEM.ERROR");
    const first = await plaidItemConsumer.handle(event, ctx);
    const second = await plaidItemConsumer.handle(event, ctx);
    expect(second).toEqual(first);
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
    const result = await plaidItemConsumer.handle(
      inboxEvent(JSON.stringify(ITEM_ERROR), "ITEM.ERROR"),
      ctx,
    );
    expect(result.status).toBe("ignored");
  });
});
