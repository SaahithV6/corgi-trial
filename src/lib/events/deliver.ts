/**
 * The delivery worker: claim, sign, POST, interpret, retry or dead-letter.
 *
 * The mirror of `src/lib/webhooks/dispatch.ts`, with the arrows reversed, and
 * deliberately the same shape so that one set of operational instincts covers
 * both directions. Where the inbound dispatcher has a consumer that answers
 * processed / ignored / parked, this has an endpoint that answers 2xx / not-2xx
 * / nothing at all.
 *
 * ===========================================================================
 * WHY THE BACKOFF FUNCTION IS IMPORTED AND NOT COPIED
 * ===========================================================================
 *
 * `backoffDelayMs` comes from `dispatch.ts`. It is pure, it is already tested
 * against exact numbers with an injected `random`, and a second implementation
 * of exponential-backoff-with-jitter in the same repository is two places to
 * fix the day somebody discovers the jitter is one-sided. Nothing in
 * `src/lib/webhooks/**` is modified to make this import work — it was already
 * exported.
 *
 * The POLICY numbers are our own, because the question is different: inbound,
 * the budget is "how long before we admit a provider's event is never going
 * to process"; outbound, it is "how long do we keep knocking on a customer's
 * door". They happen to land on the same 8 attempts, and the reasoning is
 * written out below rather than inherited silently.
 *
 * ===========================================================================
 * WHAT THIS CANNOT DO
 * ===========================================================================
 *
 * It cannot post a journal entry, open a transaction on the money tables, or
 * take a lock anything on the posting path waits for. Every statement it
 * issues touches `outbound_*` tables only — checkable by reading `store.ts`,
 * which holds all of them. A customer's dead endpoint therefore burns eight
 * attempts of a background worker's time and nothing else; their payments
 * settle on a code path that has never heard of this file.
 */

import "server-only";

import { backoffDelayMs } from "@/lib/webhooks/dispatch";
import { logger, type Logger } from "@/lib/log";

import { signDelivery } from "./sign";
import {
  claimDeliveries,
  deadLetter,
  liveSecretsFor,
  markDelivered,
  recordAttempt,
  scheduleRetry,
} from "./store";
import { postSigned } from "./transport";

/**
 * Eight attempts, 5s doubling, capped at an hour.
 *
 * Eight because that is the number this system is itself held to by its own
 * providers (Lithic's delivery schedule is eight attempts) — if eight is
 * enough for a provider to conclude we are down, it is enough for us to
 * conclude a customer is. The full ladder with a 1h cap spans a little over
 * five hours, which covers an ordinary deploy, an ordinary incident and an
 * ordinary certificate expiry discovered in the morning; past that it is not
 * a blip, it is an endpoint that needs a human, and the dead letter is how a
 * human finds out.
 *
 * Jitter at 0.2 so a customer who goes down and comes back does not receive
 * their entire backlog in one synchronised thundering burst — which would be
 * our outage becoming their outage.
 */
export const OUTBOUND_RETRY_POLICY = {
  maxAttempts: 8,
  baseDelayMs: 5_000,
  maxDelayMs: 60 * 60_000,
  jitter: 0.2,
} as const;

export interface DeliverSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLettered: number;
}

const EMPTY: DeliverSummary = { claimed: 0, delivered: 0, retried: 0, deadLettered: 0 };

export interface DeliverDeps {
  readonly batchSize?: number | undefined;
  readonly leaseMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly random?: (() => number) | undefined;
  readonly log?: Pick<Logger, "info" | "warn" | "error"> | undefined;
}

/**
 * Claim one batch and deliver it.
 *
 * Sequential on purpose, for the reason `dispatchOnce` gives: a bounded,
 * boring, one-at-a-time loop is easier to reason about than a concurrency
 * limiter, and `batchSize` is the throughput knob. One endpoint failing never
 * stops the rest of the batch — every outcome below is recorded, never thrown
 * out of the loop.
 */
export async function deliverOnce(deps: DeliverDeps = {}): Promise<DeliverSummary> {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? Math.random;
  const log = deps.log ?? logger({ requestId: `outbound-${Date.now()}` });
  const batchSize = deps.batchSize ?? 20;
  const leaseMs = deps.leaseMs ?? 60_000;

  const batch = await claimDeliveries({ limit: batchSize, now: now(), leaseMs });
  let delivered = 0;
  let retried = 0;
  let deadLettered = 0;

  for (const claim of batch) {
    const at = now();

    // DISABLING AN ENDPOINT MUST STOP DELIVERIES ALREADY IN THE QUEUE.
    //
    // Fan-out only queues for active endpoints, so this looks unreachable —
    // and it is not, because disabling does nothing to the rows already
    // queued. Without this they keep knocking on a door somebody explicitly
    // closed, eight attempts each, while the screen reads "nothing further is
    // queued for it". Dead rather than left pending: a queue that can never
    // drain is a pending count nobody can trust, and the reason names why.
    if (claim.endpointStatus === "disabled") {
      await deadLetter({
        deliveryId: claim.deliveryId,
        status: null,
        reason: "endpoint was disabled before this delivery was attempted; nothing was sent",
        now: at,
      });
      deadLettered += 1;
      continue;
    }

    // The secret is fetched per delivery rather than cached in the process.
    // A rotation or a disable must take effect on the NEXT attempt, not on
    // the next deploy, and a process-lifetime cache of key material is also
    // a process-lifetime window in a heap dump.
    const secrets = await liveSecretsFor(claim.endpointId);
    if (secrets.length === 0) {
      // Names the missing thing. "invalid request" is what the inbound dead
      // letter used to say and the reason nobody could act on it.
      await deadLetter({
        deliveryId: claim.deliveryId,
        status: null,
        reason:
          "no live signing secret for this endpoint — every secret version has been retired. " +
          "Rotate the endpoint to issue a new one; nothing is sent unsigned.",
        now: at,
      });
      deadLettered += 1;
      continue;
    }

    const signed = signDelivery({
      webhookId: claim.eventId,
      body: claim.body,
      secrets,
      now: at,
    });

    const outcome = await postSigned({
      url: claim.url,
      body: claim.body,
      headers: signed.headers,
    });

    const status = outcome.kind === "response" ? outcome.status : null;
    const excerpt = outcome.kind === "response" ? outcome.excerpt : null;
    const error = outcome.kind === "response" ? outcome.error : outcome.error;
    const resolvedIp = outcome.kind === "response" ? outcome.resolvedIp : outcome.resolvedIp;

    await recordAttempt({
      deliveryId: claim.deliveryId,
      attemptNo: claim.attempts,
      durationMs: outcome.durationMs,
      responseStatus: status,
      responseExcerpt: excerpt,
      error,
      webhookId: signed.webhookId,
      webhookTimestamp: signed.timestamp,
      // The newest live version, which is the one a customer who has finished
      // rotating will be verifying with.
      secretVersion: signed.secretVersions[0] ?? 1,
      resolvedIp,
    });

    const reason = outcome.error ?? "delivery failed with no further detail";

    // A BOUND WAS HIT, SO THIS DELIVERY IS OVER.
    //
    // Two cases, both terminal and neither retryable:
    //
    //   response_too_large — the endpoint answered with a body past the 8 KiB
    //     read cap. The next attempt would read the same page off the same
    //     server, so eight of them buy nothing but eight more truncated reads.
    //   attempt_deadline — the transport's own hard wall-clock deadline fired,
    //     which means the socket-level timeout did not. That is the failure
    //     that used to be a permanently-pending promise and a queue that
    //     stopped; it is now a dead letter naming the deadline.
    //
    // Terminal BEFORE the `ok` branch: a 200 with a 40 KiB body is still a
    // delivery we could not finish reading, and the status is recorded on the
    // dead letter so the customer can see their own server answered.
    if (outcome.limit !== null) {
      await deadLetter({
        deliveryId: claim.deliveryId,
        status,
        reason: `dead-lettered without retrying (${outcome.limit}): ${reason}`,
        now: at,
      });
      deadLettered += 1;
      log.error("outbound.dead_letter", {
        deliveryId: claim.deliveryId,
        endpointId: claim.endpointId,
        webhookId: signed.webhookId,
        attempts: claim.attempts,
        limit: outcome.limit,
        status,
        error: reason,
      });
      continue;
    }

    if (outcome.kind === "response" && outcome.ok) {
      await markDelivered({ deliveryId: claim.deliveryId, status: outcome.status, now: at });
      delivered += 1;
      // `webhookId` is the event id and is not a secret; the endpoint id is
      // logged instead of the URL, because a URL can carry a token in a query
      // parameter and a log drain keeps things for years.
      log.info("outbound.delivered", {
        deliveryId: claim.deliveryId,
        endpointId: claim.endpointId,
        webhookId: signed.webhookId,
        status: outcome.status,
        durationMs: outcome.durationMs,
      });
      continue;
    }

    if (claim.attempts >= OUTBOUND_RETRY_POLICY.maxAttempts) {
      await deadLetter({
        deliveryId: claim.deliveryId,
        status,
        reason: `dead-lettered after ${claim.attempts} attempts: ${reason}`,
        now: at,
      });
      deadLettered += 1;
      log.error("outbound.dead_letter", {
        deliveryId: claim.deliveryId,
        endpointId: claim.endpointId,
        webhookId: signed.webhookId,
        attempts: claim.attempts,
        status,
        error: reason,
      });
      continue;
    }

    const delay = backoffDelayMs(claim.attempts, OUTBOUND_RETRY_POLICY, random);
    await scheduleRetry({
      deliveryId: claim.deliveryId,
      status,
      error: reason,
      nextAttemptAt: new Date(at.getTime() + delay),
      now: at,
    });
    retried += 1;
    log.warn("outbound.retry_scheduled", {
      deliveryId: claim.deliveryId,
      endpointId: claim.endpointId,
      attempt: claim.attempts,
      retryInMs: delay,
      status,
      error: reason,
    });
  }

  return { claimed: batch.length, delivered, retried, deadLettered };
}

/** Deliver in batches until a batch comes back empty, or the cap is reached.
 *  The cap is what keeps a serverless invocation inside its budget. */
export async function deliverUntilIdle(
  deps: DeliverDeps & { readonly maxBatches?: number | undefined } = {},
): Promise<DeliverSummary> {
  const maxBatches = deps.maxBatches ?? 5;
  let total: DeliverSummary = { ...EMPTY };
  for (let i = 0; i < maxBatches; i++) {
    const summary = await deliverOnce(deps);
    total = {
      claimed: total.claimed + summary.claimed,
      delivered: total.delivered + summary.delivered,
      retried: total.retried + summary.retried,
      deadLettered: total.deadLettered + summary.deadLettered,
    };
    if (summary.claimed === 0) break;
  }
  return total;
}
