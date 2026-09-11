/**
 * The Plaid consumer: item health, and the honest limit of what this build can
 * do with it.
 *
 * ─── THE DECISION, AND THE ARGUMENT FOR IT ──────────────────────────────────
 *
 * Three verified Plaid deliveries were dead-lettered as "no consumer
 * registered". All three are `ITEM`/`ERROR` with `ITEM_LOGIN_REQUIRED`: the
 * linked bank account needs the customer to log in again. No money moves on a
 * Plaid webhook in this build — funding posts from
 * `rails/plaid/adapter.ts` at the moment the customer funds, and Plaid is the
 * open-banking slot, not a payment rail.
 *
 * SO WHAT SHOULD AN `ITEM_LOGIN_REQUIRED` DO? The answer this build is allowed
 * to give is constrained by a fact in the schema rather than by taste:
 *
 *   THERE IS NO `plaid_item` TABLE. The adapter says so in its own header — an
 *   access token is never persisted, and `/funding` links a FRESH Item on every
 *   run. So the `item_id` in this delivery names something that exists only
 *   inside the request that created it. There is no row to mark unhealthy, no
 *   customer to route a "reconnect your bank" prompt to, and nothing a
 *   reconciliation would notice.
 *
 * Given that, the choice was between leaving these dead-lettering and
 * acknowledging them with a reason. This file acknowledges them, for the same
 * reason the Stripe consumer does: the dead-letter screen is an ALARM. An alarm
 * that rings for an event nobody can act on is an alarm an operator learns to
 * silence, and the next thing it rings for is a returned payment.
 *
 * WHAT IT REFUSES TO DO IS PRETEND. It does not post, does not invent an item
 * store, and does not mark anything "handled" that it has not looked at: an
 * unrecognised Plaid webhook type PARKS rather than being waved through,
 * because the one that is waved through will be the one Plaid adds next, and
 * `TRANSFER`/`ITEM` are not the same kind of news.
 */

import "server-only";

import {
  consumers,
  ignored,
  parked,
  type ConsumerContext,
  type ConsumerRegistry,
  type ConsumerResult,
  type WebhookConsumer,
} from "../dispatch";
import type { InboxEvent } from "../inbox";
import { readStoredPayload, readString } from "./payload";

export const PLAID_WEBHOOK_PROVIDER = "plaid";

/**
 * The Plaid webhook families this build has decided about.
 *
 * `ITEM` is item health: a link that broke, a consent that is expiring, a
 * permission the customer revoked. None of it is money and all of it is worth
 * an operator's attention — in a build that stores Items, which this one does
 * not (see the header).
 *
 * The list is explicit rather than a prefix match, because "starts with ITEM"
 * would also swallow a family Plaid invents next year with the same first four
 * letters and a very different meaning.
 */
const ITEM_CODES: ReadonlySet<string> = new Set([
  "ERROR",
  "LOGIN_REPAIRED",
  "PENDING_EXPIRATION",
  "PENDING_DISCONNECT",
  "USER_PERMISSION_REVOKED",
  "USER_ACCOUNT_REVOKED",
  "NEW_ACCOUNTS_AVAILABLE",
  "WEBHOOK_UPDATE_ACKNOWLEDGED",
]);

export interface PlaidWebhookFacts {
  readonly webhookType: string;
  readonly webhookCode: string;
  readonly itemId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export function asPlaidFacts(payload: Record<string, unknown>): PlaidWebhookFacts | null {
  const webhookType = readString(payload, ["webhook_type"]);
  const webhookCode = readString(payload, ["webhook_code"]);
  if (webhookType === null || webhookCode === null) return null;
  return {
    webhookType,
    webhookCode,
    itemId: readString(payload, ["item_id"]),
    errorCode: readString(payload, ["error", "error_code"]),
    errorMessage: readString(payload, ["error", "error_message"]),
  };
}

/**
 * What an operator should be told about one item-health delivery.
 *
 * Written as a sentence about the CUSTOMER's world, not Plaid's: "this funding
 * source is broken and a human has to re-link it" is actionable, and
 * `ITEM_LOGIN_REQUIRED` on its own is a string.
 */
export function describeItemEvent(facts: PlaidWebhookFacts): string {
  const item = facts.itemId ?? "(no item id)";
  switch (facts.webhookCode) {
    case "ERROR":
      return (
        `Plaid item ${item} is broken (${facts.errorCode ?? "no error code"}): the customer must ` +
        `re-authenticate in Link update mode before this funding source works again. No money is ` +
        `affected and nothing posted.`
      );
    case "PENDING_EXPIRATION":
    case "PENDING_DISCONNECT":
      return (
        `Plaid item ${item} will stop working soon (${facts.webhookCode}); the customer must ` +
        `re-consent. No money is affected and nothing posted.`
      );
    case "USER_PERMISSION_REVOKED":
    case "USER_ACCOUNT_REVOKED":
      return (
        `The customer revoked access to Plaid item ${item}. The link is dead; any standing funding ` +
        `from it will fail. No money is affected and nothing posted.`
      );
    case "LOGIN_REPAIRED":
      return `Plaid item ${item} was repaired by the customer and works again. Nothing posted.`;
    default:
      return `Plaid item ${item}: ${facts.webhookCode}. Item health only; nothing posted.`;
  }
}

/** The sentence appended to every item-health outcome. It is the whole reason. */
const NO_ITEM_STORE =
  "This deployment persists no Plaid Item — there is no plaid_item table and the access token is " +
  "never stored, so /funding links a fresh Item per run and this id refers to nothing durable. " +
  "The delivery is recorded in webhook_inbox and that is the whole of what can honestly be done " +
  "with it until an item store exists.";

export function createPlaidItemConsumer(): WebhookConsumer {
  return {
    provider: PLAID_WEBHOOK_PROVIDER,

    handle(event: InboxEvent, ctx: ConsumerContext): ConsumerResult {
      const payload = readStoredPayload(event.payload);
      if (payload === null) return ignored("payload is not a JSON object");

      const facts = asPlaidFacts(payload);
      if (facts === null) {
        return ignored("payload carries no webhook_type / webhook_code");
      }

      if (facts.webhookType === "ITEM" && ITEM_CODES.has(facts.webhookCode)) {
        const description = describeItemEvent(facts);
        ctx.logger.warn("plaid.item.health", {
          inboxId: event.id,
          itemId: facts.itemId,
          webhookCode: facts.webhookCode,
          errorCode: facts.errorCode,
          errorMessage: facts.errorMessage,
          description,
        });
        // `ignored`, not `processed`: the row's life ends either way, and the
        // word is the difference between "we acted on this" and "we recognised
        // it and deliberately did not". Nothing was acted on.
        return ignored(`${description} ${NO_ITEM_STORE}`);
      }

      // Anything else — a family this build has never decided about. PARK.
      // Bounded at twelve re-checks and then a dead letter in front of a human,
      // which is the correct home for "Plaid started sending us something new".
      // Ignoring it would be the fast path to dropping a money event on the day
      // this build grows a Plaid Transfer leg.
      return parked(
        "plaid_webhook_type",
        `${facts.webhookType}.${facts.webhookCode}`,
        `nobody has decided what Plaid's ${facts.webhookType}/${facts.webhookCode} means for this ` +
          `book. It was verified and stored, and it is NOT being acted on. If it is item health, ` +
          `add it to ITEM_CODES; if it moves money, it needs a rail_event_semantics row and a ` +
          `posting rule before anything is booked from it.`,
      );
    },
  };
}

export const plaidItemConsumer: WebhookConsumer = createPlaidItemConsumer();

export function registerPlaidItemConsumer(
  registry: ConsumerRegistry = consumers,
  opts: { replace?: boolean } = {},
): ConsumerRegistry {
  return registry.register(plaidItemConsumer, opts);
}
