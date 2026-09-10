/**
 * ATTACK 8 — DEDUPE AGAINST A REAL PROVIDER REPLAY.
 *
 * "Replay the payment webhook from the provider dashboard. Twice is one."
 *
 * ============================================================================
 * WHY THIS TEST IS WRITTEN THE WAY IT IS.
 *
 * An earlier attempt at this claim APPEARED to pass and did not (DECISIONS 020).
 * The stored headers were double-encoded, so the replayed requests carried no
 * usable signature and production answered 401. The inbox row count held at one
 * — but because the requests were REJECTED BEFORE THE INBOX, not because the
 * unique index deduped them. A test that passes for the wrong reason is worse
 * than one that fails.
 *
 * So this test refuses to accept a row count as evidence on its own. It proves
 * four things, and all four are required:
 *
 *   A. the delivery being replayed is a REAL Lithic delivery — it carries a
 *      `webhook-signature` header that Lithic itself produced, and it arrived
 *      at production over the internet (this run creates it, so it cannot be a
 *      stale hand-made probe row);
 *   B. both replays are ACCEPTED — HTTP 200 with `status: "replay"`, which is
 *      only reachable AFTER signature verification succeeds. A 401 carries
 *      `WEBHOOK_SIGNATURE_INVALID` and is a different body entirely;
 *   C. the inbox id echoed back by both replays is the id of the row the
 *      ORIGINAL delivery created, so the replays reached the same row;
 *   D. a NEGATIVE CONTROL: the same body with one character of the signature
 *      changed is answered 401. Without this, (B) could be a system that
 *      accepts anything.
 *
 * Only then does the row count mean what it looks like it means.
 * ============================================================================
 *
 * The five-minute Standard Webhooks replay window is real and is why this test
 * generates its own delivery rather than replaying an old row: a delivery older
 * than `DEFAULT_TOLERANCE_SECONDS` is correctly rejected as stale, and that
 * rejection would look exactly like a pass.
 */
import { appendFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 8;
const NAME = "Dedupe against a genuinely signed provider replay";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const BASE_URL = (
  process.env["LIVEFIRE_BASE_URL"] ?? "https://corgi-trial-psi.vercel.app"
).replace(/\/+$/, "");

const MISSING: string[] = [];
if (process.env["LIVEFIRE"] !== "1") MISSING.push("LIVEFIRE=1");
if (typeof process.env["APP_DATABASE_URL"] !== "string") MISSING.push("APP_DATABASE_URL");
if (typeof process.env["LITHIC_API_KEY"] !== "string" || process.env["LITHIC_API_KEY"] === "") {
  MISSING.push("LITHIC_API_KEY (needed to make Lithic emit a real signed delivery)");
}

const READY = MISSING.length === 0;
if (!READY) {
  record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);
}

const d = READY ? describe : describe.skip;

type InboxRow = {
  id: string;
  provider_event_id: string;
  headers: Record<string, string>;
  raw_body: string;
  state: string;
  signature_verified_at: Date;
};

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();
  let authToken = "";
  let delivery: InboxRow | null = null;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    lithic = await import("@/lib/rails/lithic/client");
  });

  it("makes Lithic emit a real, signed delivery to production", async () => {
    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire replay ${tag}`,
      spend_limit: 5_000_00,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    const pan = card.pan;
    if (pan === undefined || pan === "") {
      throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
    }

    const auth = await lithic.simulateAuthorize({
      amount: 50_00,
      descriptor: `CORGI REPLAY ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    if (auth.token === undefined || auth.token === "") {
      throw new Error(`Lithic returned no transaction token: ${JSON.stringify(auth)}`);
    }
    authToken = auth.token;

    // Wait for Lithic to deliver it to the deployed endpoint. Measured at
    // roughly one second; 60s is head-room, not an expectation.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const [row] = await sql<InboxRow[]>`
        SELECT id, provider_event_id, headers, raw_body, state::text AS state,
               signature_verified_at
          FROM webhook_inbox
         WHERE provider = 'lithic'
           AND payload->>'token' = ${authToken}
         ORDER BY received_at DESC
         LIMIT 1`;
      if (row) {
        delivery = row;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    if (delivery === null) {
      throw new Error(
        `no webhook_inbox row for Lithic transaction ${authToken} within 60s — the event subscription may not point at ${BASE_URL}`,
      );
    }

    // (A) It is a REAL delivery: Lithic's own signature is on it, stored as a
    // jsonb object rather than a double-encoded string (DECISIONS 020).
    expect(typeof delivery.headers).toBe("object");
    expect(delivery.headers["webhook-signature"]).toMatch(/^v1,/);
    expect(delivery.headers["webhook-id"]).toBe(delivery.provider_event_id);
    expect(delivery.headers["webhook-timestamp"]).toMatch(/^\d+$/);
    expect(delivery.raw_body.length).toBeGreaterThan(500);

    const ageSeconds =
      Math.floor(Date.now() / 1000) - Number(delivery.headers["webhook-timestamp"]);
    expect(ageSeconds).toBeLessThan(240); // inside the 300s Standard Webhooks window

    record(
      "evidence",
      `real Lithic delivery ${delivery.provider_event_id} landed at ${BASE_URL} for transaction ${authToken}: raw body ${delivery.raw_body.length} bytes, signature ${delivery.headers["webhook-signature"]}, age ${ageSeconds}s`,
    );
  });

  it("both replays are ACCEPTED (2xx), and land on the original row", async () => {
    const row = delivery;
    if (row === null) throw new Error("no delivery captured");

    const responses: { status: number; body: Record<string, unknown> }[] = [];
    for (let i = 0; i < 2; i += 1) {
      const response = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
        method: "POST",
        headers: { ...row.headers, "content-type": "application/json" },
        body: row.raw_body,
      });
      responses.push({
        status: response.status,
        body: (await response.json()) as Record<string, unknown>,
      });
    }

    for (const response of responses) {
      // (B) 2xx, and specifically the REPLAY body. A 401 would carry
      // `error.code = WEBHOOK_SIGNATURE_INVALID`, which is the failure mode
      // that made the earlier attempt at this claim a false pass.
      expect(response.status).toBe(200);
      expect(response.body["status"]).toBe("replay");
      expect(response.body["replay"]).toBe(true);
      expect(response.body["error"]).toBeUndefined();
      expect(response.body["providerEventId"]).toBe(row.provider_event_id);
      // (C) Same row, not a second one.
      expect(response.body["inboxId"]).toBe(row.id);
    }

    record(
      "evidence",
      `two replays of ${row.provider_event_id}: HTTP ${responses.map((r) => r.status).join(" and ")}, both status="replay", both inboxId=${row.id}`,
    );
  });

  it("a tampered signature on the same bytes is refused — the negative control", async () => {
    const row = delivery;
    if (row === null) throw new Error("no delivery captured");

    const genuine = row.headers["webhook-signature"] ?? "";
    // Same shape, same length, different bytes. Base64 alphabet only.
    const tampered = `v1,${"A".repeat(Math.max(genuine.length - 3, 8))}=`;
    expect(tampered).not.toBe(genuine);

    const response = await fetch(`${BASE_URL}/api/webhooks/lithic`, {
      method: "POST",
      headers: {
        ...row.headers,
        "webhook-signature": tampered,
        "content-type": "application/json",
      },
      body: row.raw_body,
    });
    const body = (await response.json()) as { error?: { code?: string } };

    // (D) Without this, the 200s above would prove nothing about verification.
    expect(response.status).toBe(401);
    expect(body.error?.code).toBe("WEBHOOK_SIGNATURE_INVALID");

    record(
      "evidence",
      `negative control: same bytes with a tampered signature -> HTTP 401 ${body.error?.code}. The 200s above therefore mean the signature verified.`,
    );
  });

  it("exactly ONE inbox row exists for that provider_event_id", async () => {
    const row = delivery;
    if (row === null) throw new Error("no delivery captured");

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic' AND provider_event_id = ${row.provider_event_id}`;
    expect(count?.n).toBe(1);

    // And the row still carries the id both replays echoed, so "one row" is
    // the same one row, not a replacement.
    const [same] = await sql<{ id: string }[]>`
      SELECT id FROM webhook_inbox
       WHERE provider = 'lithic' AND provider_event_id = ${row.provider_event_id}`;
    expect(same?.id).toBe(row.id);

    record(
      "evidence",
      `webhook_inbox rows for (lithic, ${row.provider_event_id}) after 1 delivery + 2 signed replays + 1 tampered replay: ${count?.n} (id ${same?.id}). Deduped by UNIQUE (provider, provider_event_id), not by a 401.`,
    );
  });
});
