import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { toHeaderLookup } from "@/lib/webhooks/rawbody";

import { AsaParseError, asaResponseBody, parseAsaRequest, verifyAsaSignature } from "./asa";
import { decide } from "./decide";
import { asaPayload } from "./fixtures";

/* -------------------------------------------------------------------------- */
/* Signing, the way Lithic does it                                            */
/* -------------------------------------------------------------------------- */

const SECRET = "whsec_PURGED";

/**
 * Sign exactly as Standard Webhooks specifies and as Lithic's SDK does:
 * HMAC-SHA256 over `id.timestamp.rawbody`, key = base64-decode(secret minus
 * the `whsec_` prefix), signature base64, header entry `v1,<sig>`.
 */
function sign(raw: string, id: string, timestampSeconds: number, secret = SECRET): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const digest = createHmac("sha256", key)
    .update(`${id}.${timestampSeconds}.${raw}`, "utf8")
    .digest("base64");
  return `v1,${digest}`;
}

function headersFor(raw: string, now: Date, opts: { id?: string; secret?: string } = {}) {
  const id = opts.id ?? "msg_2xJ9v0";
  const ts = Math.floor(now.getTime() / 1000);
  return toHeaderLookup(
    new Headers({
      "webhook-id": id,
      "webhook-timestamp": String(ts),
      "webhook-signature": sign(raw, id, ts, opts.secret),
    }),
  );
}

describe("verifyAsaSignature", () => {
  const now = new Date("2026-09-10T23:41:02Z");
  const raw = JSON.stringify(asaPayload());

  it("accepts a correctly signed request", () => {
    const check = verifyAsaSignature({ raw, headers: headersFor(raw, now), secrets: [SECRET], now });
    expect(check.ok).toBe(true);
  });

  it("refuses a request with no signature headers at all", () => {
    // Lithic documents that ASA requests carry NO signature headers until the
    // HMAC secret has been retrieved. An unauthenticated request must never be
    // able to approve a card payment, so absent is a refusal.
    const check = verifyAsaSignature({
      raw,
      headers: toHeaderLookup(new Headers({})),
      secrets: [SECRET],
      now,
    });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.headersPresent).toBe(false);
  });

  it("refuses when there is no secret to verify against", () => {
    // If the ASA secret could not be fetched we cannot authenticate anything,
    // and we decline rather than trusting the request. Same fail-closed
    // argument as the control store, applied to authentication.
    const check = verifyAsaSignature({ raw, headers: headersFor(raw, now), secrets: [], now });
    expect(check.ok).toBe(false);
  });

  it("refuses a signature made with the wrong secret", () => {
    const other = "whsec_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const check = verifyAsaSignature({
      raw,
      headers: headersFor(raw, now, { secret: other }),
      secrets: [SECRET],
      now,
    });
    expect(check.ok).toBe(false);
  });

  it("refuses when a byte of the body changed after signing", () => {
    const headers = headersFor(raw, now);
    const tampered = raw.replace('"amount":5000', '"amount":5001');
    expect(tampered).not.toBe(raw); // the tamper must actually have happened
    const check = verifyAsaSignature({ raw: tampered, headers, secrets: [SECRET], now });
    expect(check.ok).toBe(false);
  });

  it("refuses a replay outside the tolerance window", () => {
    const signedAt = new Date("2026-09-10T23:00:00Z");
    const check = verifyAsaSignature({
      raw,
      headers: headersFor(raw, signedAt),
      secrets: [SECRET],
      now: new Date("2026-09-10T23:41:02Z"),
    });
    expect(check.ok).toBe(false);
  });

  it("accepts either secret during a rotation window", () => {
    // Lithic keeps a rotated secret alive for 24 hours. A single-secret
    // verifier starts rejecting real deliveries exactly when a rotation
    // begins, which is the worst possible time to find out.
    const rotated = "whsec_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
    const check = verifyAsaSignature({
      raw,
      headers: headersFor(raw, now, { secret: rotated }),
      secrets: [rotated, SECRET],
      now,
    });
    expect(check.ok).toBe(true);
  });

  it("returns the webhook id so the decision row can cite the delivery", () => {
    const check = verifyAsaSignature({
      raw,
      headers: headersFor(raw, now, { id: "msg_abc123" }),
      secrets: [SECRET],
      now,
    });
    expect(check.ok && check.webhookId).toBe("msg_abc123");
  });
});

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

describe("parseAsaRequest", () => {
  it("reads the six facts a control decision needs", () => {
    const parsed = parseAsaRequest(asaPayload());
    expect(parsed.providerAuthToken).toBe("3fa85f64-5717-4562-b3fc-2c963f66afa6");
    expect(parsed.card.token).toBe("c6d49cfe-2758-4b4b-85de-2eaba92d6713");
    expect(parsed.amountCents).toBe(5_000n);
    expect(parsed.mcc).toBe("5542");
    expect(parsed.merchantDescriptor).toBe("CORGI FUEL PUMP 14");
    expect(parsed.requestStatus).toBe("AUTHORIZATION");
  });

  it("judges the CARDHOLDER amount, not the fuel-pump hold", () => {
    // The fixture carries amounts.hold = 10000 against a cardholder amount of
    // 5000, exactly as Lithic's schema says a fuel or tipping MCC will. A
    // parser that read the hold would decline a $50 purchase against a $60
    // per-transaction limit, for a $100 anticipated fill.
    const parsed = parseAsaRequest(asaPayload({ amountCents: 5_000, holdCents: 10_000 }));
    expect(parsed.amountCents).toBe(5_000n);
  });

  it("falls back through the deprecated amount fields in the provider's order", () => {
    const payload = asaPayload();
    delete (payload as Record<string, unknown>)["amounts"];
    expect(parseAsaRequest(payload).amountCents).toBe(5_000n);

    const bare = asaPayload();
    delete (bare as Record<string, unknown>)["amounts"];
    delete (bare as Record<string, unknown>)["authorization_amount"];
    expect(parseAsaRequest(bare).amountCents).toBe(5_000n);
  });

  it("returns bigint, never a number", () => {
    expect(typeof parseAsaRequest(asaPayload()).amountCents).toBe("bigint");
  });

  it("refuses an amount that JSON.parse already mangled", () => {
    // Past 2^53 the true figure is unrecoverable. Refusing is the only honest
    // option; it becomes a fail-closed decline with the reason recorded.
    expect(() => parseAsaRequest(asaPayload({ amountCents: 2 ** 53 + 2 }))).toThrow(AsaParseError);
  });

  it("treats a non-four-digit MCC as absent rather than coercing it", () => {
    expect(parseAsaRequest(asaPayload({ mcc: "554" })).mcc).toBeNull();
    expect(parseAsaRequest(asaPayload({ mcc: "" })).mcc).toBeNull();
  });

  it("keeps a leading zero on an MCC", () => {
    expect(parseAsaRequest(asaPayload({ mcc: "0742" })).mcc).toBe("0742");
  });

  it("refuses a status Lithic does not document", () => {
    // Fail closed on an unrecognised message type: we do not approve messages
    // we do not understand.
    expect(() => parseAsaRequest(asaPayload({ status: "SOMETHING_NEW" }))).toThrow(AsaParseError);
  });

  it("accepts every status Lithic does document", () => {
    for (const status of [
      "AUTHORIZATION",
      "CREDIT_AUTHORIZATION",
      "FINANCIAL_AUTHORIZATION",
      "FINANCIAL_CREDIT_AUTHORIZATION",
      "BALANCE_INQUIRY",
    ]) {
      expect(parseAsaRequest(asaPayload({ status })).requestStatus).toBe(status);
    }
  });

  it("refuses a payload with no card token", () => {
    const payload = asaPayload();
    delete (payload["card"] as Record<string, unknown>)["token"];
    expect(() => parseAsaRequest(payload)).toThrow(AsaParseError);
  });

  it("refuses a payload with no transaction token", () => {
    const payload = asaPayload();
    delete (payload as Record<string, unknown>)["token"];
    expect(() => parseAsaRequest(payload)).toThrow(AsaParseError);
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseAsaRequest("[]")).toThrow(AsaParseError);
    expect(() => parseAsaRequest(null)).toThrow(AsaParseError);
  });
});

/* -------------------------------------------------------------------------- */
/* The response                                                               */
/* -------------------------------------------------------------------------- */

describe("asaResponseBody", () => {
  const parsed = parseAsaRequest(asaPayload());

  it("sends result and the echoed token, and nothing else", () => {
    const verdict = decide(parsed, {
      status: "read",
      cardId: "card-id",
      controls: null,
      spend: { dayCents: 0n, monthCents: 0n },
    });
    const body = asaResponseBody(verdict, parsed);
    expect(Object.keys(body).sort()).toEqual(["result", "token"]);
    expect(body.result).toBe("APPROVED");
    expect(body.token).toBe(parsed.providerAuthToken);
  });

  it("never sends approved_amount, because a limit is a refusal not a haggle", () => {
    const verdict = decide(parsed, {
      status: "read",
      cardId: "card-id",
      controls: {
        cardId: "card-id",
        controlVersionId: "v",
        version: 1,
        effectiveFrom: "2026-09-10T00:00:00.000Z",
        cardState: "active",
        perTxnLimitCents: 1_000n,
        dailyLimitCents: null,
        monthlyLimitCents: null,
        blockedMccs: [],
        note: "",
      },
      spend: { dayCents: 0n, monthCents: 0n },
    });
    const body = asaResponseBody(verdict, parsed) as Record<string, unknown>;
    expect(body["approved_amount"]).toBeUndefined();
    expect(body["result"]).toBe("VELOCITY_EXCEEDED");
  });
});
