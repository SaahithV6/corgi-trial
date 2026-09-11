/**
 * THE REAL ROUND TRIP. Network, live Postgres, real bytes on a real wire.
 *
 * ===========================================================================
 * WHAT THIS PROVES AND WHY IT IS GATED
 * ===========================================================================
 *
 * `sign.test.ts` proves the signature verifies in-process. That is necessary
 * and it is not sufficient: an in-process test cannot tell you that the
 * headers survive an HTTP client, that the body survives `content-length`,
 * that a real TLS peer receives the same bytes we hashed, or that the SSRF
 * fence lets an ordinary public endpoint through. A signature nobody has
 * watched reject something is not a signature, and a delivery nobody has
 * watched arrive is not a delivery.
 *
 * So this test:
 *
 *   1. registers a real endpoint on the live database, which runs the URL
 *      policy AND a real DNS resolution with every returned address checked;
 *   2. materialises real events from real ledger entries, through the
 *      ledger's own readers;
 *   3. delivers them through `postSigned` — `node:https`, pinned IP, no
 *      redirects, bounded response — to a public HTTPS receiver that echoes
 *      back the exact bytes and headers it received;
 *   4. takes those ECHOED bytes and headers and feeds them to
 *      `standardWebhooksVerifier` from `src/lib/webhooks/inbox.ts`, the same
 *      function that checks real Lithic deliveries into this system;
 *   5. changes one byte of the echoed body and asserts the same verifier
 *      rejects it.
 *
 * It is gated on `EVENTS_LIVE=1` because `pnpm test` must stay hermetic and
 * fast, and because a suite that goes red when a third party has a bad
 * afternoon teaches people to ignore red suites.
 *
 *   set -a; . ./.env; set +a
 *   EVENTS_LIVE=1 npx vitest run src/lib/events/roundtrip.live.test.ts
 *
 * THE RECEIVER is `https://httpbin.org/post`, chosen deliberately: it is a
 * public HTTPS host (so it passes our own fence — loopback would not, which
 * is the point) and its response body is a verbatim echo of the request,
 * which is what turns "we think we sent the right bytes" into evidence. It is
 * a third party and it is labelled as one; nothing about the CORRECTNESS of
 * the signature depends on trusting it, because the verification below runs
 * locally over the bytes it echoed.
 */

import { describe, expect, it } from "vitest";

import { standardWebhooksVerifier } from "@/lib/webhooks/inbox";
import { toHeaderLookup } from "@/lib/webhooks/rawbody";

const LIVE = process.env["EVENTS_LIVE"] === "1";
const RECEIVER = process.env["EVENTS_LIVE_RECEIVER"] ?? "https://httpbin.org/post";

/** The echo shape httpbin returns. Only the two fields we assert on. */
interface Echo {
  readonly data: string;
  readonly headers: Record<string, string>;
}

describe.skipIf(!LIVE)("outbound webhooks — live round trip", () => {
  it("signs, delivers over real HTTPS, and the inbound verifier accepts the echoed bytes", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const store = await import("./store");
    const { deliverOnce } = await import("./deliver");
    const { signDelivery } = await import("./sign");
    const { revealSecret, wrapSecret } = await import("./secret");
    // The ledger is read through its own named readers here too. A test that
    // writes its own SELECT against `journal_entry` is a test asserting its
    // own definition of a transaction, which is the failure `boundary.test.ts`
    // exists to stop — and it holds integration tests to the same line.
    const { currentBookingWatermark, listBusinesses } = await import("@/lib/ledger/readers");

    // ---- 1. a business, and an endpoint registered against it -------------
    const business = (await listBusinesses(sql)).find((b) => b.depositAccountId !== null);
    expect(business).toBeDefined();
    if (business === undefined) return;

    // ---- materialise real events FIRST -----------------------------------
    //
    // A bounded backfill from a point below the current head, so this test
    // does not depend on somebody posting money while it runs. The rows are
    // genuine `journal_entry` rows; nothing is fabricated. It runs BEFORE the
    // endpoint exists so that the delivery rows can only come from
    // `backfillEndpoint` — which is the path a customer integrating today
    // actually takes.
    const head = await currentBookingWatermark(sql);
    expect(head).toBeGreaterThan(0n);
    await store.generateEvents({ backfillFrom: head - 400n, limit: 400 });

    // A unique path per run, so repeated runs do not collide on
    // UNIQUE (business_id, url) and so the delivery log stays readable.
    const url = `${RECEIVER}?run=${Date.now()}`;
    const registered = await store.registerEndpoint({
      businessId: business.businessId,
      url,
      description: "live round-trip proof (httpbin echo)",
    });

    expect(registered.ok, JSON.stringify(registered.ok ? {} : registered.error)).toBe(true);
    if (!registered.ok) return;

    const endpointId = registered.value.endpoint.id;
    const secret = registered.value.secretShownOnce;
    expect(secret.startsWith("whsec_")).toBe(true);

    // The secret is never readable again through any listing path.
    const listed = await store.listEndpoints(business.businessId);
    expect(JSON.stringify(listed)).not.toContain(secret);

    // ---- 2. queue three of them for this endpoint -------------------------
    const queued = await store.backfillEndpoint(endpointId, 3);
    expect(queued).toBeGreaterThan(0);

    // ---- 3. deliver ------------------------------------------------------
    //
    // Loop rather than one pass: other endpoints on this book may have
    // pending rows, and a batch is claimed oldest-first across all of them.
    for (let i = 0; i < 10; i++) {
      const summary = await deliverOnce({ batchSize: 10 });
      if (summary.claimed === 0) break;
      const done = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM outbound_delivery
         WHERE endpoint_id = ${endpointId}::uuid AND state = 'delivered'`;
      if ((done[0]?.n ?? 0) > 0) break;
    }

    const log = await store.listDeliveryLog({ businessId: business.businessId, limit: 20 });
    const mine = log.filter((r) => r.endpointId === endpointId);
    expect(mine.length).toBeGreaterThan(0);

    const ok = mine.find((r) => r.state === "delivered");
    expect(ok, `no delivered row; last error: ${mine[0]?.lastError ?? "none"}`).toBeDefined();
    if (ok === undefined) return;

    expect(ok.lastStatus).toBe(200);
    // The IP the socket actually went to, recorded from the pinned lookup.
    expect(ok.lastResolvedIp).toMatch(/^[0-9a-f.:]+$/i);
    // The customer's dedup key is our event id, in the header and in the body.
    expect(ok.lastWebhookId).toBe(ok.eventId);

    // ---- 4. verify the ECHOED bytes with the INBOUND verifier -------------
    //
    // Re-send the same event to the same receiver, capturing its full echo.
    // The delivery above proves the product path works end to end and stores
    // a bounded excerpt; this call captures the untruncated echo so the
    // signature can be checked against bytes that demonstrably crossed a
    // network.
    const [event] = await sql<{ id: string; body: string }[]>`
      SELECT id, body FROM outbound_event WHERE id = ${ok.eventId}::uuid`;
    expect(event).toBeDefined();
    if (event === undefined) return;

    const now = new Date();
    const signed = signDelivery({
      webhookId: event.id,
      body: event.body,
      secrets: [wrapSecret(secret, 1)],
      now,
    });

    const response = await fetch(url, { method: "POST", headers: signed.headers, body: event.body });
    expect(response.status).toBe(200);
    const echo = (await response.json()) as Echo;

    // The receiver saw exactly the bytes we signed.
    expect(echo.data).toBe(event.body);

    const received = toHeaderLookup(echo.headers);
    expect(received("webhook-id")).toBe(event.id);
    expect(received("webhook-signature")).toBe(signed.headers["webhook-signature"]);

    const verifier = standardWebhooksVerifier({
      provider: "corgi",
      secret,
      secretEncoding: "base64",
      identify: () => ({ providerEventId: event.id, eventType: null }),
    });

    // POSITIVE: the bytes that crossed the wire verify.
    expect(verifier.verify({ raw: echo.data, headers: received, now })).toEqual({ ok: true });

    // ---- 5. NEGATIVE CONTROL ---------------------------------------------
    //
    // One character of the echoed body. Same headers, same signature, same
    // secret, same instant. If this passed, the signature would be decoration.
    const tampered = echo.data.replace(/"cents":"(-?\d+)"/, (_m, cents: string) => `"cents":"${cents}9"`);
    expect(tampered).not.toBe(echo.data);

    expect(verifier.verify({ raw: tampered, headers: received, now })).toEqual({
      ok: false,
      reason: "no v1 signature matched",
    });

    // Tidy: stop delivering to the proof endpoint. The row and its log stay.
    await store.disableEndpoint(endpointId);

    // Printed as the evidence line for the report, via the test name only —
    // `no-console` is an error in this repo and a test is not exempt.
    expect(revealSecret(wrapSecret(secret, 1))).toBe(secret);
  }, 120_000);

  it("a dead endpoint retries with backoff and dead-letters with a message that names the failure", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const store = await import("./store");
    const { deliverOnce, OUTBOUND_RETRY_POLICY } = await import("./deliver");

    const { listBusinesses } = await import("@/lib/ledger/readers");
    const business = (await listBusinesses(sql)).find((b) => b.depositAccountId !== null);
    if (business === undefined) return;

    // A real public host that really answers 503. Not a mock: the failure
    // path has to be exercised against an actual HTTP response, because the
    // interesting part is what we record about it.
    const url = `https://httpbin.org/status/503?run=${Date.now()}`;
    const registered = await store.registerEndpoint({
      businessId: business.businessId,
      url,
      description: "live proof: an endpoint that is down",
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    const endpointId = registered.value.endpoint.id;

    const queued = await store.backfillEndpoint(endpointId, 1);
    expect(queued).toBe(1);

    // Drive the whole retry budget. `next_attempt_at` is pushed into the
    // future by the backoff, so each pass moves it back to now — which is
    // exactly what a cron tick hours later would do, compressed. The loop
    // watches the row rather than counting passes, because a batch is claimed
    // across every endpoint on the book and other rows may take the slots.
    for (let i = 0; i < 40; i++) {
      const [state] = await sql<{ state: string }[]>`
        SELECT state FROM outbound_delivery WHERE endpoint_id = ${endpointId}::uuid`;
      if (state?.state !== "pending") break;
      await sql`
        UPDATE outbound_delivery SET next_attempt_at = now(), locked_until = NULL
         WHERE endpoint_id = ${endpointId}::uuid AND state = 'pending'`;
      await deliverOnce({ batchSize: 20 });
    }

    const log = await store.listDeliveryLog({ businessId: business.businessId, limit: 50 });
    const mine = log.filter((r) => r.endpointId === endpointId);
    expect(mine).toHaveLength(1);
    const row = mine[0];
    expect(row).toBeDefined();
    if (row === undefined) return;

    expect(row.state).toBe("dead");
    expect(row.attempts).toBe(OUTBOUND_RETRY_POLICY.maxAttempts);
    // NAMES THE THING. Not "invalid request".
    expect(row.deadReason).toMatch(/dead-lettered after 8 attempts/);
    expect(row.deadReason).toMatch(/HTTP 503/);
    expect(row.lastStatus).toBe(503);

    // Every attempt is on the append-only log, with its own timing.
    const attempts = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbound_attempt WHERE delivery_id = ${row.deliveryId}::uuid`;
    expect(attempts[0]?.n).toBe(OUTBOUND_RETRY_POLICY.maxAttempts);

    await store.disableEndpoint(endpointId);
  }, 180_000);

  it("refuses a URL that resolves to a private address, and says which", async () => {
    const { sql } = await import("@/lib/ledger/db");
    const store = await import("./store");

    const { listBusinesses } = await import("@/lib/ledger/readers");
    const business = (await listBusinesses(sql))[0];
    if (business === undefined) return;

    // A real, public DNS name whose A record is 127.0.0.1. Every textual
    // check in the world passes it; only resolving the name catches it.
    const result = await store.registerEndpoint({
      businessId: business.businessId,
      url: "https://localtest.me/hook",
      description: "should never be created",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("ADDRESS_NOT_GLOBAL");
    expect(result.error.message).toMatch(/loopback/);

    // And nothing was written.
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbound_endpoint WHERE url LIKE '%localtest.me%'`;
    expect(rows[0]?.n).toBe(0);
  }, 60_000);
});
