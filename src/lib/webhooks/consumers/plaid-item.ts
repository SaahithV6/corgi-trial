/**
 * The Plaid consumer: item health, and what is now done with it.
 *
 * ─── WHAT THIS FILE USED TO SAY, AND WHY IT CHANGED ─────────────────────────
 *
 * Three verified Plaid deliveries reached this consumer. All three are
 * `ITEM`/`ERROR` with `ITEM_LOGIN_REQUIRED`: the linked bank account needs the
 * customer to log in again. No money moves on a Plaid webhook in this build —
 * funding posts from `rails/plaid/adapter.ts` at the moment the customer
 * funds, and Plaid is the open-banking slot, not a payment rail.
 *
 * Until migration 0056 the honest answer to "what should an
 * `ITEM_LOGIN_REQUIRED` do" was constrained by a fact in the schema rather
 * than by taste: THERE WAS NO `plaid_item` TABLE, so the `item_id` in the
 * delivery named something that existed only inside the request that created
 * it. There was no row to mark unhealthy and nothing a reconciliation would
 * notice. This file therefore recognised those three deliveries, wrote a
 * sentence about them to the log, and returned `ignored`.
 *
 * THE SENTENCE WENT NOWHERE. `markProcessed()` takes `(id, now)` and sets
 * `processing_error` to NULL, so the reason string never reached the database.
 * Measured on 2026-09-11: all three rows are `state = 'done'` with no
 * `processing_error`, which is INDISTINGUISHABLE from "a consumer acted on
 * this". Three times, Plaid told this system a funding source was broken, the
 * system understood, and then forgot.
 *
 * ─── WHAT IT DOES NOW ───────────────────────────────────────────────────────
 *
 * 0056 gives item state somewhere to live, so the item-health branch APPENDS
 * to `plaid_item_event` before it returns. The health surface then reads the
 * provider's own words instead of a probe standing in for them.
 *
 * The write is idempotent BY INDEX: `plaid_item_event_one_per_delivery` is a
 * UNIQUE on `inbox_id`, which is exactly what this consumer's contract
 * requires — "the same event may be handed to you again after a crash, a lease
 * expiry, or a park/unpark round trip … Make the effect a function of a set (a
 * unique key on the write), not an increment."
 *
 * IT IS STILL `ignored`, NOT `processed`, and that distinction is deliberate.
 * `processed` means money was booked. Nothing here books money: an
 * `ITEM_LOGIN_REQUIRED` is news about a funding source, not a transaction. The
 * row is now recorded AND the word stays honest.
 *
 * WHAT IT STILL REFUSES TO DO IS PRETEND. An unrecognised Plaid webhook type
 * PARKS rather than being waved through, because the one that is waved through
 * will be the one Plaid adds next, and `TRANSFER`/`ITEM` are not the same kind
 * of news.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import {
  recordItemObservation,
  type RecordObservationArgs,
} from "@/lib/rails/plaid/item-store";

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
  readonly errorType: string | null;
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
    errorType: readString(payload, ["error", "error_type"]),
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

/**
 * The sentence appended to every item-health outcome that was RECORDED.
 *
 * It names the table, because the previous version of this constant named the
 * table's absence and was the most-quoted sentence in the build's own
 * documentation of what Plaid could not do.
 */
const ITEM_STATE_RECORDED =
  "Recorded in plaid_item_event (migration 0056), so /api/health reports this item's state from " +
  "Plaid's own words rather than from a credential probe standing in for them. No money is " +
  "affected and nothing posted.";

/**
 * THE RECORDER IS INJECTED, NOT THE CONNECTION.
 *
 * `plaid_item_event.inbox_id` is a real foreign key to `webhook_inbox`, which
 * is exactly right in production — an observation cites the delivery it was
 * read out of, and a citation of a row that does not exist is not provenance.
 * It also means a unit test cannot hand this consumer a synthetic delivery id
 * without either inserting a real inbox row first or stubbing a Postgres
 * driver's tagged template, and neither of those is a test of THIS file.
 *
 * So the seam is the function, and the default is the real one bound to the
 * real connection. `item-store.test.ts` proves the write against a live
 * database; the tests here prove the DECISIONS — which webhook families are
 * recognised, what an operator is told, and that a redelivery is not written
 * twice — with no database at all.
 */
export type ItemObservationRecorder = (args: RecordObservationArgs) => Promise<boolean>;

export interface PlaidItemConsumerDeps {
  readonly record?: ItemObservationRecorder | undefined;
  readonly conn?: Sql | undefined;
}

export function createPlaidItemConsumer(deps: PlaidItemConsumerDeps = {}): WebhookConsumer {
  const record: ItemObservationRecorder =
    deps.record ?? ((args) => recordItemObservation(args, deps.conn ?? sql));
  return {
    provider: PLAID_WEBHOOK_PROVIDER,

    async handle(event: InboxEvent, ctx: ConsumerContext): Promise<ConsumerResult> {
      const payload = readStoredPayload(event.payload);
      if (payload === null) return ignored("payload is not a JSON object");

      const facts = asPlaidFacts(payload);
      if (facts === null) {
        return ignored("payload carries no webhook_type / webhook_code");
      }

      if (facts.webhookType === "ITEM" && ITEM_CODES.has(facts.webhookCode)) {
        const description = describeItemEvent(facts);

        // A delivery with no `item_id` cannot be recorded against an item, and
        // inventing a placeholder id would put a row in the state view that
        // refers to nothing. Say so rather than writing it.
        if (facts.itemId === null) {
          ctx.logger.warn("plaid.item.health", {
            inboxId: event.id,
            webhookCode: facts.webhookCode,
            errorCode: facts.errorCode,
            recorded: false,
          });
          return ignored(
            `${description} It carries no item_id, so there is nothing to record it against.`,
          );
        }

        // THE APPEND. Idempotent by `UNIQUE (inbox_id)`, so a redelivery of
        // this same row writes nothing and returns false. No `catch` that
        // swallows: a failure here must fail the delivery so the dispatcher
        // retries it, because an item-health event we silently dropped is
        // exactly the thing this file was rewritten to stop.
        const recorded = await record({
          itemId: facts.itemId,
          source: "webhook",
          webhookCode: facts.webhookCode,
          errorCode: facts.errorCode,
          errorType: facts.errorType,
          errorMessage: facts.errorMessage,
          inboxId: event.id,
          observedAt: ctx.now,
        });

        ctx.logger.warn("plaid.item.health", {
          inboxId: event.id,
          itemId: facts.itemId,
          webhookCode: facts.webhookCode,
          errorCode: facts.errorCode,
          errorMessage: facts.errorMessage,
          recorded,
          description,
        });

        // `ignored`, not `processed`: `processed` means money was booked and
        // none was. The word stays honest; the row is now durable either way.
        return ignored(
          recorded
            ? `${description} ${ITEM_STATE_RECORDED}`
            : `${description} Already recorded on an earlier delivery of this same webhook; nothing was written twice.`,
        );
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
