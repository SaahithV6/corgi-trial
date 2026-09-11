/**
 * The events screen's data contract.
 *
 * Same seam every other screen in this console uses: nothing under
 * `src/components/**` opens a connection or imports `postgres`.
 * `src/app/(app)/events/live-source.ts` implements this against the live
 * database and `./fixtures.ts` implements it without one, which is what makes
 * the loading / empty / error / edge states demonstrable in front of a panel
 * without writing a row.
 *
 * ONE RULE ABOUT THIS FILE IN PARTICULAR: there is no field anywhere in it
 * that could hold a signing secret, and there is no shape a live source could
 * put one in. The one-time reveal travels on the RESULT of the create action
 * (`RegisterResult.secret`) and lives in React state on the client for the
 * length of one page view. It is never part of the screen's data.
 */

import type { ErrorShape, Result } from "@/lib/result";

export type Instant = string;

export type DeliveryState = "pending" | "delivered" | "dead";

/** A registered destination. Note the absence of a `secret` field. */
export type EndpointView = {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly url: string;
  readonly description: string;
  readonly status: "active" | "disabled";
  /** Empty means every event type. */
  readonly eventTypes: readonly string[];
  readonly createdAt: Instant;
  readonly disabledAt: Instant | null;
  /** Version numbers only. Identifies a key; does not authenticate with it. */
  readonly secretVersions: readonly number[];
  /** Counts from the delivery log, for the endpoint row's at-a-glance health. */
  readonly delivered: number;
  readonly pending: number;
  readonly dead: number;
};

/** One row of the delivery log: what we sent, what came back, what is next. */
export type DeliveryView = {
  readonly deliveryId: string;
  readonly state: DeliveryState;
  readonly attempts: number;
  readonly nextAttemptAt: Instant;
  readonly queuedAt: Instant;
  readonly deliveredAt: Instant | null;
  readonly deadAt: Instant | null;
  readonly deadReason: string | null;

  readonly eventId: string;
  readonly eventType: string;
  /** The ledger's total order, as a string. What a customer sorts on. */
  readonly sequence: string;
  /** When we learned it. */
  readonly occurredAt: Instant;
  /** When it happened. Different from the above after a backdated correction. */
  readonly valueDate: string;
  readonly bodyBytes: number;

  readonly endpointId: string;
  readonly url: string;
  readonly endpointDescription: string;

  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly lastAttemptAt: Instant | null;
  readonly lastResponseExcerpt: string | null;
  readonly lastDurationMs: number | null;
  /** The address the socket actually connected to. The SSRF audit trail. */
  readonly lastResolvedIp: string | null;
  /** The `webhook-id` header we signed under — the customer's dedup key. */
  readonly lastWebhookId: string | null;
};

export type QueueView = {
  readonly pending: number;
  readonly delivered: number;
  readonly dead: number;
  readonly dueNow: number;
  /**
   * The generator watermark and the ledger head. The gap between them is the
   * only "are we behind?" number on this screen, and it is two facts rather
   * than a derived lag, because a single number would hide which half moved.
   */
  readonly cursor: string;
  readonly ledgerHead: string;
};

export type EventsView = {
  readonly endpoints: readonly EndpointView[];
  readonly deliveries: readonly DeliveryView[];
  readonly queue: QueueView;
  /** FIXTURE or LIVE, printed on the screen's face. Never inferred by the reader. */
  readonly source: "live" | "fixture";
};

export type EventsDataSource = {
  load(): Promise<Result<EventsView, ErrorShape>>;
};
