/**
 * The outbound drain: generate, then deliver. One call, safe at any time.
 *
 * The mirror of `src/lib/webhooks/drain.ts`, and the same three-trigger
 * argument applies for the same reason:
 *
 *   1. A cron tick — the guarantee. Everything else is latency.
 *   2. A nudge after a posting, if some caller ever wants one. NOT required
 *      and deliberately not wired into anything on the money path (see below).
 *   3. By hand, from the events screen, because being able to say "watch, I
 *      will drain it now" beats waiting for a timer in front of a panel.
 *
 * ===========================================================================
 * THE ONE THING THAT MUST NEVER BE TRUE OF THIS FUNCTION
 * ===========================================================================
 *
 * Nothing on the money path may await it.
 *
 * `generateEvents()` reads committed journal entries from a watermark, so it
 * is correct no matter how late it runs; `deliverUntilIdle()` talks to
 * customer servers, so it is as slow as the slowest of them. Awaiting either
 * one inside a posting would put a third party's availability inside our
 * transaction, and the failure mode is the one this whole feature is fenced
 * against: a customer's broken server stops their own money moving.
 *
 * There is no import of this module anywhere under `src/lib/ledger/**`,
 * `src/lib/holds/**` or `src/lib/rails/**`, and there must not be. If a
 * low-latency nudge is ever wanted, the shape is `after(() => drainOutbound())`
 * in a route handler — AFTER the response is already on its way, exactly as
 * the inbound drain is nudged — never `await` inside a transaction.
 */

import "server-only";

import { logger } from "@/lib/log";

import { deliverUntilIdle, type DeliverSummary } from "./deliver";
import { generateEvents, type GenerateSummary } from "./store";

export interface OutboundDrainResult extends DeliverSummary {
  readonly generated: GenerateSummary;
  readonly durationMs: number;
  /** Non-null if generation failed. Delivery still ran; this is reported. */
  readonly generateError: string | null;
}

export async function drainOutbound(
  opts: { readonly generateLimit?: number | undefined; readonly maxBatches?: number | undefined } = {},
): Promise<OutboundDrainResult> {
  const started = Date.now();
  const log = logger({ requestId: `outbound-drain-${started}` });

  // Generation first, so an event booked a moment ago can be delivered on
  // this same tick rather than waiting a full cron period.
  //
  // A failure here must NOT stop delivery. Materialising new events and
  // delivering already-queued ones are independent jobs that happen to share
  // a trigger, and a generator that can block the queue is a worse bug than a
  // late event — the same argument `webhooks/drain.ts` makes about its credit
  // sweep, reached independently and landing in the same place.
  let generated: GenerateSummary = {
    entriesScanned: 0,
    eventsCreated: 0,
    deliveriesQueued: 0,
    cursorFrom: "0",
    cursorTo: "0",
  };
  let generateError: string | null = null;
  try {
    generated = await generateEvents({ limit: opts.generateLimit ?? 200 });
  } catch (thrown) {
    generateError = thrown instanceof Error ? thrown.message : String(thrown);
    log.warn("outbound.generate_failed", { error: generateError });
  }

  const summary = await deliverUntilIdle({ maxBatches: opts.maxBatches ?? 5, log });

  const result: OutboundDrainResult = {
    ...summary,
    generated,
    generateError,
    durationMs: Date.now() - started,
  };
  log.info("outbound.drain_complete", result as unknown as Record<string, unknown>);
  return result;
}
