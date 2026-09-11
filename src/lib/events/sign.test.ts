import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

// THE VERIFIER UNDER TEST IS NOT OURS.
//
// `standardWebhooksVerifier` is the function this deployment uses to check
// real Lithic and Increase deliveries. Nothing in `src/lib/webhooks/**` was
// modified to make these tests pass — it is imported exactly as the inbound
// route handler imports it. If our signature verifies here, it verifies in
// any Standard Webhooks implementation, because this one was written against
// the spec's own test vector and checks real provider traffic every day.
import { standardWebhooksVerifier } from "@/lib/webhooks/inbox";
import { toHeaderLookup } from "@/lib/webhooks/rawbody";

import { generateSecret, revealSecret, wrapSecret } from "./secret";
import { signDelivery } from "./sign";

/* -------------------------------------------------------------------------- */
/* A customer's verifier, built the way a customer would build it             */
/* -------------------------------------------------------------------------- */

/**
 * What a customer runs. `secretEncoding: 'base64'` is the Standard Webhooks
 * spec's key handling and the one `lithicVerifier` uses — the same argument
 * Lithic's own SDK passes.
 */
function customerVerifier(secret: string) {
  return standardWebhooksVerifier({
    provider: "corgi",
    secret,
    secretEncoding: "base64",
    identify: () => ({ providerEventId: "x", eventType: null }),
  });
}

const BODY = JSON.stringify({
  id: "e1b9e4a8-0000-4000-8000-000000000001",
  type: "transaction.posted",
  sequence: "3001",
  data: { net_amount: { currency: "USD", cents: "-7340" } },
});

const NOW = new Date("2026-09-10T22:00:00.000Z");

describe("round trip: what we sign, the inbound verifier accepts", () => {
  it("verifies a delivery we signed", () => {
    const secret = generateSecret(1);
    const signed = signDelivery({
      webhookId: "e1b9e4a8-0000-4000-8000-000000000001",
      body: BODY,
      secrets: [secret],
      now: NOW,
    });

    const outcome = customerVerifier(revealSecret(secret)).verify({
      raw: BODY,
      headers: toHeaderLookup(signed.headers as Record<string, string>),
      now: NOW,
    });

    expect(outcome).toEqual({ ok: true });
  });

  it("NEGATIVE CONTROL: one changed byte in the body fails", () => {
    const secret = generateSecret(1);
    const signed = signDelivery({
      webhookId: "e1b9e4a8-0000-4000-8000-000000000001",
      body: BODY,
      secrets: [secret],
      now: NOW,
    });

    // $73.40 becomes $73.41. One character. Nothing else about the delivery
    // changes — same headers, same signature, same secret, same instant.
    const tampered = BODY.replace('"-7340"', '"-7341"');
    expect(tampered).not.toBe(BODY);

    const outcome = customerVerifier(revealSecret(secret)).verify({
      raw: tampered,
      headers: toHeaderLookup(signed.headers as Record<string, string>),
      now: NOW,
    });

    expect(outcome).toEqual({ ok: false, reason: "no v1 signature matched" });
  });

  it("NEGATIVE CONTROL: a different secret fails", () => {
    const ours = generateSecret(1);
    const theirs = generateSecret(1);
    const signed = signDelivery({ webhookId: "evt_1", body: BODY, secrets: [ours], now: NOW });

    expect(
      customerVerifier(revealSecret(theirs)).verify({
        raw: BODY,
        headers: toHeaderLookup(signed.headers as Record<string, string>),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "no v1 signature matched" });
  });

  it("NEGATIVE CONTROL: a replayed delivery outside the window fails", async () => {
    const secret = generateSecret(1);
    const signed = signDelivery({ webhookId: "evt_1", body: BODY, secrets: [secret], now: NOW });

    // Same bytes, same signature, six minutes later. The ±300s window is what
    // stops a captured delivery being replayable for ever, and it is the
    // reason `webhook-timestamp` changes per attempt rather than being frozen
    // at queue time.
    const later = new Date(NOW.getTime() + 6 * 60_000);
    const outcome = await customerVerifier(revealSecret(secret)).verify({
      raw: BODY,
      headers: toHeaderLookup(signed.headers as Record<string, string>),
      now: later,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/timestamp too old/);
  });

  it("NEGATIVE CONTROL: re-serialising the body breaks the signature", () => {
    // The outbound spelling of the footgun `rawbody.ts` exists to prevent.
    // A customer (or a proxy) that parses and re-stringifies before verifying
    // gets a different byte sequence and therefore a different HMAC. This is
    // why `outbound_event.body` is `text` and never `jsonb`.
    const secret = generateSecret(1);
    const spaced = '{"test": 2432232314}';
    const signed = signDelivery({ webhookId: "evt_1", body: spaced, secrets: [secret], now: NOW });

    const reserialised = JSON.stringify(JSON.parse(spaced));
    expect(reserialised).toBe('{"test":2432232314}');

    expect(
      customerVerifier(revealSecret(secret)).verify({
        raw: reserialised,
        headers: toHeaderLookup(signed.headers as Record<string, string>),
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "no v1 signature matched" });
  });
});

describe("rotation", () => {
  it("sends one signature per live secret, and either one verifies", () => {
    const oldSecret = generateSecret(1);
    const newSecret = generateSecret(2);
    const signed = signDelivery({
      webhookId: "evt_rot",
      body: BODY,
      secrets: [newSecret, oldSecret],
      now: NOW,
    });

    const header = signed.headers["webhook-signature"] ?? "";
    expect(header.split(" ")).toHaveLength(2);
    expect(signed.secretVersions).toEqual([2, 1]);

    for (const secret of [oldSecret, newSecret]) {
      expect(
        customerVerifier(revealSecret(secret)).verify({
          raw: BODY,
          headers: toHeaderLookup(signed.headers as Record<string, string>),
          now: NOW,
        }),
      ).toEqual({ ok: true });
    }
  });

  it("refuses to sign with no live secret rather than sending unsigned", () => {
    expect(() => signDelivery({ webhookId: "e", body: BODY, secrets: [], now: NOW })).toThrow(
      /no live signing secret/,
    );
  });
});

describe("the signature is computed the way the spec says", () => {
  it("matches a hand-rolled HMAC over id.timestamp.body", () => {
    const material = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const secret = wrapSecret(material, 1);
    const signed = signDelivery({ webhookId: "msg_1", body: '{"a":1}', secrets: [secret], now: NOW });

    const key = Buffer.from(material.replace(/^whsec_/, ""), "base64");
    const expected = createHmac("sha256", key)
      .update(`msg_1.${signed.timestamp}.{"a":1}`, "utf8")
      .digest("base64");

    expect(signed.headers["webhook-signature"]).toBe(`v1,${expected}`);
    expect(signed.headers["webhook-id"]).toBe("msg_1");
    expect(signed.headers["webhook-timestamp"]).toBe(String(signed.timestamp));
  });
});

describe("the secret cannot leak by accident", () => {
  it("does not appear in JSON, template strings, or a spread", () => {
    const secret = generateSecret(3);
    const material = revealSecret(secret);

    expect(JSON.stringify(secret)).toBe('"[redacted]"');
    expect(JSON.stringify({ endpoint: "x", secret })).not.toContain(material);
    expect(`${secret}`).toBe("whsec_***");
    expect(String(secret)).not.toContain(material);
    expect(JSON.stringify({ ...secret })).not.toContain(material);
    expect(Object.keys(secret)).not.toContain("secret");
  });

  it("is not in the headers we send", () => {
    const secret = generateSecret(1);
    const signed = signDelivery({ webhookId: "e", body: BODY, secrets: [secret], now: NOW });
    expect(JSON.stringify(signed.headers)).not.toContain(revealSecret(secret));
  });
});
