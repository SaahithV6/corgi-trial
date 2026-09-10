import "server-only";

/**
 * The Lithic consumer: the thing `dispatch.ts` hands a card event to.
 *
 * It implements `WebhookConsumer` and answers with exactly one of the three
 * things a consumer may say:
 *
 *   processed(produced)   the effects are in the ledger. `produced` names the
 *                         entities this event brought into existence, which is
 *                         what wakes anything parked waiting for them.
 *   ignored(reason)       a well-formed event we deliberately do not act on.
 *                         Ends the row's life like `processed`; it exists so
 *                         the logs can tell "handled" from "recognised and
 *                         skipped".
 *   parked(kind, ref)     the event refers to something we have not seen. Not
 *                         an error and not a drop.
 *
 * It has no retry logic, no backoff, no dead-letter policy and no idea how many
 * times it has been called. All of that is the dispatcher's, and the contract
 * it must honour in return is the one at the top of `dispatch.ts`: BE
 * IDEMPOTENT. The same event will be handed to it again after a crash, a lease
 * expiry, or a park/unpark round trip.
 *
 * It is, and the idempotence is not implemented here either — it is inherited
 * from three unique indexes, one per layer:
 *
 *   webhook_inbox      UNIQUE (provider, provider_event_id)   the envelope
 *   card_auth_event    UNIQUE (auth_id, provider_event_id)    the fact
 *   journal_entry      UNIQUE (idempotency_key)               the money
 *
 * Replaying the payment webhook from the provider's dashboard — the graders'
 * published attack — is refused at the first of those before this file runs at
 * all. Replaying it PAST the inbox (a lease expiry, a redelivery under a new
 * envelope id) is refused at the second and third. Twice is one, three times
 * over, and none of the three is an `if` statement in this process.
 */

import { applyCardTransaction, LITHIC_PROVIDER } from "@/lib/holds";
import type { Transaction } from "@/lib/rails/lithic/types";

import {
  consumers,
  ignored,
  parked,
  processed,
  type ConsumerContext,
  type ConsumerRegistry,
  type ConsumerResult,
  type WebhookConsumer,
} from "../dispatch";
import type { InboxEvent } from "../inbox";

/** The only Lithic event that carries the authorisation/clearing lifecycle. */
const LIFECYCLE_EVENT = "card_transaction.updated";

/**
 * Read the stored payload as an object.
 *
 * `webhook_inbox.payload` is `jsonb`, and it holds an OBJECT for everything
 * stored since the `::text::jsonb` fix in DECISIONS 020. Rows written before
 * that fix hold a jsonb STRING — the body arrived already `JSON.stringify`'d
 * and a bare `::jsonb` made Postgres quote it a second time. There are such
 * rows in the live table right now, and they are real Lithic deliveries of a
 * real $50 authorisation, so they are worth processing rather than writing off.
 *
 * Parsing a string payload here is therefore not defensive programming against
 * a hypothetical — it is the difference between replaying history and losing
 * it. It is also strictly safe: a double-encoded object parses to the object,
 * and a genuine object is returned untouched.
 */
function payloadObject(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof payload === "object" && payload !== null) {
    return payload as Record<string, unknown>;
  }
  return null;
}

/**
 * Is this payload usable as a Lithic transaction?
 *
 * Three fields and no more: the transaction token (our authorisation id), the
 * card token (whose money it is), and `created` (the value date). Everything
 * else the hold model needs is in `events[]`, and a transaction with no
 * `events[]` yet is legitimate — it creates the identity and holds nothing.
 *
 * Deliberately NOT checked: `status`, `amounts.hold`, `settled_amount`. This
 * consumer never reads them, so requiring them would reject payloads it can
 * process perfectly well.
 */
function asTransaction(payload: Record<string, unknown>): Transaction | null {
  const token = payload["token"];
  const cardToken = payload["card_token"];
  const created = payload["created"];
  if (typeof token !== "string" || token.length === 0) return null;
  if (typeof cardToken !== "string" || cardToken.length === 0) return null;
  if (typeof created !== "string" || Number.isNaN(Date.parse(created))) return null;
  return payload as unknown as Transaction;
}

export const lithicCardConsumer: WebhookConsumer = {
  provider: LITHIC_PROVIDER,

  async handle(event: InboxEvent, ctx: ConsumerContext): Promise<ConsumerResult> {
    if (event.eventType !== LIFECYCLE_EVENT) {
      // card.created, card.updated, balance.updated, and everything Lithic adds
      // next. Recognised and not ours; ending the row here is correct and is
      // NOT the same answer as a failure, which would retry eight times and
      // then dead-letter something that was never a problem.
      return ignored(`not ${LIFECYCLE_EVENT} (${event.eventType ?? "no event type"})`);
    }

    const payload = payloadObject(event.payload);
    if (payload === null) {
      return ignored("payload is not a JSON object");
    }

    const txn = asTransaction(payload);
    if (txn === null) {
      // A verified body we cannot use. Throwing would burn the retry budget on
      // something that will never parse; the honest answer is that we looked at
      // it and it was not a transaction.
      return ignored("payload has no usable token / card_token / created");
    }

    const result = await applyCardTransaction(txn, {
      provider: LITHIC_PROVIDER,
      inboxId: event.id,
      now: ctx.now,
    });

    if (result.status === "unknown_card") {
      // The card is not registered to any customer. PARK — do not guess an
      // account, and do not drop the event. This is the same mechanism that
      // handles a settlement arriving before its authorisation, and it is
      // bounded: twelve parks over about five hours, then a dead letter in
      // front of a human, because a card that never arrives is a missing
      // registration and not a late one.
      return parked(
        "card",
        result.providerCardToken,
        `card ${result.providerCardToken} is not registered to a customer`,
      );
    }

    ctx.logger.info("lithic.card_transaction.applied", {
      inboxId: event.id,
      authId: result.authId,
      holdId: result.holdId,
      providerAuthId: result.providerAuthId,
      newEvents: result.newEvents,
      // The whole state, in the log line, because "why is the hold 400" is the
      // question this system will be asked and A, C and closed are the answer.
      authorisedCents: result.state.authorisedCents.toString(),
      capturedCents: result.state.capturedCents.toString(),
      holdCents: result.state.holdCents.toString(),
      closed: result.state.closed,
      closurePosted: result.closurePosted,
      holdDeltaCents: result.deltaCents.toString(),
      memoEntryId: result.memoEntryId,
      financialEntries: result.financialEntryIds.length,
      providerDisagrees: result.providerDisagrees,
    });

    if (result.providerDisagrees) {
      // Surfaced, never resolved. The ledger cannot tell a genuine divergence
      // from a provider bug, and picking a side in a webhook handler is how a
      // wrong number becomes a permanent one.
      ctx.logger.warn("lithic.card_transaction.provider_divergence", {
        inboxId: event.id,
        authId: result.authId,
        ledgerHoldCents: result.state.holdCents.toString(),
      });
    }

    // Naming the authorisation is what unparks a clearing that arrived first
    // and is waiting on it. The card is named too: a `card.created` we have not
    // yet processed can leave a transaction parked on `card:<token>`, and this
    // is the fast path that wakes it.
    return processed([
      { kind: "card_authorization", ref: result.providerAuthId },
      { kind: "card", ref: txn.card_token },
    ]);
  },
};

/**
 * Register the consumer.
 *
 * A module-level side effect would make importing this file for a type change
 * behaviour, and would make the registration order depend on import order —
 * which is how two people ship two consumers for one provider and nobody
 * notices which is live. So it is an explicit call, and the registry refuses a
 * second registration unless `replace` is passed.
 */
export function registerLithicCardConsumer(
  registry: ConsumerRegistry = consumers,
  opts: { replace?: boolean } = {},
): ConsumerRegistry {
  return registry.register(lithicCardConsumer, opts);
}
