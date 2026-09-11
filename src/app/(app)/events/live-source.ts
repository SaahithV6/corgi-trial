import "server-only";

/**
 * The live implementation of `EventsDataSource`.
 *
 * It reads `v_outbound_delivery` and `outbound_endpoint`, and it CANNOT read a
 * secret: the view does not join the secret table (migration 0034 §9) and
 * `listEndpoints` selects version numbers only. That is not a convention this
 * file follows — it is the shape of the SQL underneath it.
 */

import { sql } from "@/lib/ledger/db";
import { listDeliveryLog, listEndpoints, queueCounts } from "@/lib/events/store";
import { listBusinesses } from "@/lib/ledger/readers";
import { ok, err, type ErrorShape, type Result } from "@/lib/result";

import type { EventsDataSource, EventsView } from "@/components/events/data-contract";

export function hasDatabase(): boolean {
  return (process.env["APP_DATABASE_URL"] ?? "") !== "";
}

/**
 * The businesses the register form can scope an endpoint to.
 *
 * Through the ledger's own `listBusinesses` reader rather than a SELECT
 * written here — the reader exists precisely because four modules had their
 * own version of "every business on the book", and it already answers the
 * question this form needs (a business with no deposit account yet is present,
 * with `depositAccountId: null`, rather than silently missing).
 */
export async function listBusinessOptions(): Promise<readonly { id: string; name: string }[]> {
  const rows = await listBusinesses(sql);
  return rows
    .filter((b) => b.depositAccountId !== null)
    .map((b) => ({ id: b.businessId, name: b.legalName }));
}

export function createLiveEventsSource(): EventsDataSource {
  return {
    async load(): Promise<Result<EventsView, ErrorShape>> {
      try {
        const [endpoints, deliveries, queue] = await Promise.all([
          listEndpoints(null),
          listDeliveryLog({ limit: 60 }),
          queueCounts(null),
        ]);

        // Per-endpoint counts, from the same view the table below renders, so
        // the badge on an endpoint row and the rows underneath it can never
        // disagree about how many of anything there are.
        const perEndpoint = await sql<
          { endpoint_id: string; delivered: number; pending: number; dead: number }[]
        >`
          SELECT endpoint_id,
                 count(*) FILTER (WHERE state = 'delivered')::int AS delivered,
                 count(*) FILTER (WHERE state = 'pending')::int   AS pending,
                 count(*) FILTER (WHERE state = 'dead')::int      AS dead
            FROM v_outbound_delivery
           GROUP BY endpoint_id`;
        const counts = new Map(perEndpoint.map((r) => [r.endpoint_id, r]));

        return ok({
          source: "live",
          queue,
          endpoints: endpoints.map((ep) => {
            const c = counts.get(ep.id);
            return {
              id: ep.id,
              businessId: ep.businessId,
              businessName: ep.businessName,
              url: ep.url,
              description: ep.description,
              status: ep.status,
              eventTypes: ep.eventTypes,
              createdAt: ep.createdAt.toISOString(),
              disabledAt: ep.disabledAt === null ? null : ep.disabledAt.toISOString(),
              secretVersions: ep.secretVersions,
              delivered: c?.delivered ?? 0,
              pending: c?.pending ?? 0,
              dead: c?.dead ?? 0,
            };
          }),
          deliveries: deliveries.map((d) => ({
            deliveryId: d.deliveryId,
            state: d.state,
            attempts: d.attempts,
            nextAttemptAt: d.nextAttemptAt.toISOString(),
            queuedAt: d.queuedAt.toISOString(),
            deliveredAt: d.deliveredAt === null ? null : d.deliveredAt.toISOString(),
            deadAt: d.deadAt === null ? null : d.deadAt.toISOString(),
            deadReason: d.deadReason,
            eventId: d.eventId,
            eventType: d.eventType,
            sequence: d.sequence,
            occurredAt: d.occurredAt.toISOString(),
            valueDate: d.valueDate,
            bodyBytes: d.bodyBytes,
            endpointId: d.endpointId,
            url: d.url,
            endpointDescription: d.endpointDescription,
            lastStatus: d.lastStatus,
            lastError: d.lastError,
            lastAttemptAt: d.lastAttemptAt === null ? null : d.lastAttemptAt.toISOString(),
            lastResponseExcerpt: d.lastResponseExcerpt,
            lastDurationMs: d.lastDurationMs,
            lastResolvedIp: d.lastResolvedIp,
            lastWebhookId: d.lastWebhookId,
          })),
        });
      } catch (thrown) {
        return err({
          code: "EVENTS_READ_FAILED",
          message:
            "Could not read the delivery log. Nothing was sent and nothing was lost: every queued delivery " +
            `is a durable row that the next drain picks up. (${
              thrown instanceof Error ? thrown.message.slice(0, 160) : "unknown error"
            })`,
        });
      }
    },
  };
}
