/**
 * The four non-live states, without a database.
 *
 * `default` reads the live book; everything here exists so that loading,
 * empty, error and the edge state can be shown in order in front of a panel.
 *
 * THE EDGE STATE IS THE DEAD LETTER WITH A REASON NOBODY EXPECTS. Not "the
 * customer's server returned 500" — that one is obvious and everybody's
 * dashboard shows it. It is the delivery refused BEFORE a packet was sent,
 * because the customer's DNS record started resolving to a private address.
 * That is the state this screen most needs to render well, because every
 * signal a customer has says their server is fine: it is up, it is reachable
 * from their laptop, and our log says we never called it. If the screen does
 * not print the address and the reason, the support conversation is
 * unresolvable.
 */

import { ok } from "@/lib/result";
import { err } from "@/lib/result";

import type { EventsDataSource, EventsView } from "./data-contract";

export type FixtureState = "loading" | "empty" | "error" | "edge" | "default";

const T = (offsetMinutes: number): string =>
  new Date(Date.UTC(2026, 8, 10, 21, 0, 0) + offsetMinutes * 60_000).toISOString();

const EMPTY: EventsView = {
  endpoints: [],
  deliveries: [],
  queue: { pending: 0, delivered: 0, dead: 0, dueNow: 0, cursor: "3013", ledgerHead: "3013" },
  source: "fixture",
};

const POPULATED: EventsView = {
  source: "fixture",
  queue: { pending: 2, delivered: 41, dead: 1, dueNow: 1, cursor: "3011", ledgerHead: "3013" },
  endpoints: [
    {
      id: "11111111-0000-4000-8000-000000000001",
      businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
      businessName: "Ridgeline Robotics, Inc.",
      url: "https://hooks.ridgeline.example/corgi",
      description: "Production ledger sync",
      status: "active",
      eventTypes: [],
      createdAt: T(-4000),
      disabledAt: null,
      secretVersions: [2, 1],
      delivered: 39,
      pending: 1,
      dead: 0,
    },
    {
      id: "11111111-0000-4000-8000-000000000002",
      businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
      businessName: "Ridgeline Robotics, Inc.",
      url: "https://alerts.ridgeline.example/holds",
      description: "Slack alerting — card holds only",
      status: "active",
      eventTypes: ["hold.placed", "hold.released"],
      createdAt: T(-2000),
      disabledAt: null,
      secretVersions: [1],
      delivered: 2,
      pending: 1,
      dead: 1,
    },
  ],
  deliveries: [
    {
      deliveryId: "22222222-0000-4000-8000-000000000001",
      state: "delivered",
      attempts: 1,
      nextAttemptAt: T(-3),
      queuedAt: T(-4),
      deliveredAt: T(-3),
      deadAt: null,
      deadReason: null,
      eventId: "33333333-0000-4000-8000-000000000001",
      eventType: "transaction.posted",
      sequence: "3011",
      occurredAt: T(-4),
      valueDate: "2026-09-08",
      bodyBytes: 1216,
      endpointId: "11111111-0000-4000-8000-000000000001",
      url: "https://hooks.ridgeline.example/corgi",
      endpointDescription: "Production ledger sync",
      lastStatus: 200,
      lastError: null,
      lastAttemptAt: T(-3),
      lastResponseExcerpt: '{"received":true}',
      lastDurationMs: 118,
      lastResolvedIp: "203.0.113.9",
      lastWebhookId: "33333333-0000-4000-8000-000000000001",
    },
    {
      deliveryId: "22222222-0000-4000-8000-000000000002",
      state: "pending",
      attempts: 3,
      nextAttemptAt: T(12),
      queuedAt: T(-30),
      deliveredAt: null,
      deadAt: null,
      deadReason: null,
      eventId: "33333333-0000-4000-8000-000000000002",
      eventType: "hold.placed",
      sequence: "3009",
      occurredAt: T(-30),
      valueDate: "2026-09-10",
      bodyBytes: 1104,
      endpointId: "11111111-0000-4000-8000-000000000002",
      url: "https://alerts.ridgeline.example/holds",
      endpointDescription: "Slack alerting — card holds only",
      lastStatus: 502,
      lastError: "HTTP 502 from alerts.ridgeline.example",
      lastAttemptAt: T(-8),
      lastResponseExcerpt: "<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1>",
      lastDurationMs: 341,
      lastResolvedIp: "203.0.113.41",
      lastWebhookId: "33333333-0000-4000-8000-000000000002",
    },
  ],
};

const EDGE: EventsView = {
  ...POPULATED,
  queue: { pending: 0, delivered: 41, dead: 2, dueNow: 0, cursor: "3013", ledgerHead: "3013" },
  deliveries: [
    {
      deliveryId: "22222222-0000-4000-8000-000000000009",
      state: "dead",
      attempts: 8,
      nextAttemptAt: T(-1),
      queuedAt: T(-320),
      deliveredAt: null,
      deadAt: T(-1),
      deadReason:
        "dead-lettered after 8 attempts: refused before connecting: 'alerts.ridgeline.example' resolves to " +
        "10.4.19.6, which is a private address (10.0.0.0/8, RFC 1918). Every address a name answers with is " +
        "checked, not just the first — a name with one public record and one internal one is a bypass, not a " +
        "coincidence.",
      eventId: "33333333-0000-4000-8000-000000000009",
      eventType: "transaction.reversed",
      sequence: "3007",
      occurredAt: T(-320),
      valueDate: "2026-09-08",
      bodyBytes: 1288,
      endpointId: "11111111-0000-4000-8000-000000000002",
      url: "https://alerts.ridgeline.example/holds",
      endpointDescription: "Slack alerting — card holds only",
      lastStatus: null,
      lastError:
        "refused before connecting: 'alerts.ridgeline.example' resolves to 10.4.19.6, which is a private " +
        "address (10.0.0.0/8, RFC 1918).",
      lastAttemptAt: T(-1),
      lastResponseExcerpt: null,
      lastDurationMs: 4,
      // Never connected, so there is no address to report. The screen must
      // render that difference rather than printing a plausible blank.
      lastResolvedIp: null,
      lastWebhookId: "33333333-0000-4000-8000-000000000009",
    },
    ...POPULATED.deliveries,
  ],
};

export function createFixtureEventsSource(state: FixtureState): EventsDataSource {
  return {
    async load() {
      if (state === "loading") {
        // Held open long enough that the skeleton is visible on purpose
        // rather than by luck.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        return ok(EMPTY);
      }
      if (state === "error") {
        return err({
          code: "EVENTS_READ_FAILED",
          message:
            "Could not read the delivery log. Nothing was sent and nothing was lost: every queued delivery " +
            "is a durable row and the next drain picks it up where this read stopped.",
        });
      }
      if (state === "empty") return ok(EMPTY);
      if (state === "edge") return ok(EDGE);
      return ok(POPULATED);
    },
  };
}
