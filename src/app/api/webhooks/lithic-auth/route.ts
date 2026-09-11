/**
 * POST /api/webhooks/lithic-auth — Lithic Auth Stream Access.
 *
 * THIS ROUTE IS DIFFERENT FROM EVERY OTHER WEBHOOK IN THIS SYSTEM AND THE
 * DIFFERENCE IS THE WHOLE FEATURE.
 *
 * `/api/webhooks/[provider]` is store-then-ack: verify, persist the raw event,
 * return 2xx, process later. It can afford that because the events it takes
 * report things that have already happened.
 *
 * ASA is decide-and-answer. Lithic is holding a cardholder's authorisation
 * open at a terminal while it waits for this function, and the RESPONSE BODY
 * IS THE SIDE EFFECT. There is no "process later". Measured behaviour of the
 * provider, from Lithic's documentation and their published OpenAPI document:
 *
 *   * hard timeout 6000 ms, and on timeout LITHIC DECLINES — it does not
 *     approve. The transaction is stamped `CUSTOMER_ASA_TIMEOUT`, which is a
 *     member of their `detailed_results` enum, so our own slowness is
 *     observable from the provider's side and does not have to be inferred.
 *   * their recommended ceiling is 3000 ms, because acquirer-side timeouts
 *     downstream can void a transaction Lithic itself would still have waited
 *     for.
 *   * a 5xx or a connection failure is retried immediately; a 4xx is not.
 *
 * So the shape of this handler is a latency budget (`@/lib/cards/budget`) and
 * everything else is arranged around it:
 *
 *   read raw bytes                        one `await request.text()`, once
 *   verify HMAC                           in process, ~0.1 ms
 *   parse                                 pure
 *   read controls + spend       <= 600 ms ONE round trip, ONE statement
 *   decide()                       < 1 ms pure; no I/O, no clock
 *   append the decision         <= 400 ms append-only, no journal, no locks
 *   respond
 *
 * NOTHING ON THIS PATH POSTS MONEY. Not a journal entry, not a hold, not a
 * `card_auth_event`. The verdict is a verdict; the money still moves on the
 * ordinary asynchronous `card_transaction.updated` delivery into
 * `/api/webhooks/lithic`, through the same inbox, dispatcher and consumer it
 * always did. A synchronous decision that writes to the journal is a
 * synchronous decision that can block on the journal's append lock, and a
 * blocked decision is a declined card.
 *
 * FAIL CLOSED. If the control store does not answer inside its deadline this
 * route DECLINES. The argument, and the argument for the other side, is in the
 * header of `@/lib/cards/decide.ts`. The short version: a wrong decline is
 * recoverable and recorded; a wrong approval on a card the customer froze
 * because it was stolen is not.
 */

import { after } from "next/server";

import {
  CONTROL_READ_BUDGET_MS,
  DECISION_APPEND_BUDGET_MS,
  HANDLER_BUDGET_MS,
  PROVIDER_RECOMMENDED_MS,
  PROVIDER_TIMEOUT_MS,
  stopwatch,
} from "@/lib/cards/budget";
import { AsaParseError, asaResponseBody, parseAsaRequest, verifyAsaSignature } from "@/lib/cards/asa";
import { decide } from "@/lib/cards/decide";
import { asaSecrets } from "@/lib/cards/provider";
import {
  awaitDecisionAppend,
  readControlsAndSpend,
  reappendDecisionIfMissing,
  startDecisionAppend,
} from "@/lib/cards/store";
import { logger, requestIdFrom } from "@/lib/log";
import { toHeaderLookup } from "@/lib/webhooks/rawbody";

/**
 * NODE RUNTIME, NOT EDGE. Signature verification is `node:crypto`'s
 * `createHmac` and `timingSafeEqual`, reached through the inbox's
 * `standardWebhooksVerifier`. On Edge this would not fail at build time — it
 * would fail at the first real authorisation, which is the worst possible
 * moment to discover it. Pinned rather than inherited from a default.
 */
export const runtime = "nodejs";

/** Never prerendered, never cached. A cached approval is an unthinkable bug. */
export const dynamic = "force-dynamic";

/**
 * The platform ceiling for this function, in seconds.
 *
 * Five, not the page default. It is a CEILING far above the budget, not a
 * target: every step here has its own deadline and gives up long before this.
 * It exists so that a pathological case dies inside Lithic's 6000 ms window
 * with a decline we chose, rather than at the platform's own limit with a
 * timeout Lithic chose for us.
 */
export const maxDuration = 5;

const PROVIDER = "lithic";

export async function POST(request: Request): Promise<Response> {
  const total = stopwatch();
  const requestId = requestIdFrom(request.headers);
  // `base` fields ride on every line this handler writes. Note the field
  // names below: `@/lib/log` redacts any key whose name contains "token", so a
  // field called `providerAuthToken` would log as "[redacted]" and the one
  // identifier that makes a decision traceable back to Lithic would be gone.
  // `authRef` / `cardRef` are the same values under names the redactor leaves
  // alone — these are provider transaction references, not credentials.
  const log = logger({ requestId, base: { route: "lithic-auth" } });

  // 1. THE RAW BYTES, ONCE. A signature is over the bytes as sent; anything
  //    that re-serialises a parsed body changes key order and whitespace and
  //    fails every signature. The body is a one-shot stream, so consuming it
  //    here means nothing downstream *can* re-read it.
  const raw = await request.text();
  const headers = toHeaderLookup(request.headers);

  // 2. AUTHENTICATE. An ASA request we cannot authenticate must never be
  //    allowed to approve a card payment, so this is a refusal and not a
  //    decision — no `card_auth_decision` row is written, because nothing was
  //    decided. 401 is deliberate: Lithic does not retry a 4xx, and retrying a
  //    signature failure would only repeat it. Lithic's own behaviour on a
  //    refusal is to decline the authorisation, which is the outcome we want.
  const secrets = await asaSecrets();
  const signature = verifyAsaSignature({ raw, headers, secrets, now: new Date() });
  if (!signature.ok) {
    log.warn("asa.refused", {
      reason: signature.reason,
      signatureHeadersPresent: signature.headersPresent,
      secretsAvailable: secrets.length,
      bytes: raw.length,
      elapsedUs: total(),
    });
    return json(
      { error: { code: "SIGNATURE_INVALID", message: "ASA request signature did not verify" } },
      401,
    );
  }

  // 3. PARSE. A payload we cannot read is a payload we cannot judge, and 422
  //    is the honest answer: it is permanent, so Lithic must not retry it, and
  //    Lithic declines on invalid content. Fail-closed on an unrecognised
  //    message type is deliberate — we do not approve messages we do not
  //    understand.
  let asaRequest;
  try {
    asaRequest = parseAsaRequest(JSON.parse(raw));
  } catch (thrown) {
    const parseError = thrown instanceof AsaParseError || thrown instanceof SyntaxError;
    log.error("asa.unparseable", {
      error: thrown,
      bytes: raw.length,
      elapsedUs: total(),
    });
    return json(
      {
        error: {
          code: parseError ? "ASA_PAYLOAD_INVALID" : "ASA_PAYLOAD_UNREADABLE",
          message: "ASA request could not be read as an authorisation",
        },
      },
      422,
    );
  }

  // 4. THE ONE READ. Card, current control version, both velocity windows, in
  //    a single statement with a 600 ms deadline. Its failure mode is a value
  //    (`status: 'unavailable'`), not an exception, because the fail-closed
  //    argument belongs in `decide()` where it can be read and tested — not in
  //    a catch block.
  const decisionClock = stopwatch();
  const lookup = await readControlsAndSpend({
    provider: PROVIDER,
    providerCardToken: asaRequest.card.token,
    source: "provider",
  });

  // 5. DECIDE. Pure. No I/O, no clock, no database handle in scope.
  const verdict = decide(asaRequest, lookup);
  const decisionLatencyUs = decisionClock();

  // 6. RECORD, BEFORE RESPONDING. This costs a round trip and it is chosen on
  //    purpose: a decline a customer disputes in March has to be explainable
  //    in September, and best-effort audit is not audit. The store answered a
  //    line ago, so the marginal risk is small and the marginal evidence is
  //    total. If the append misses ITS deadline the response still goes out
  //    and `after()` finishes the row off the critical path — the cardholder's
  //    purchase must not fail because our audit trail was slow.
  const appendParams = {
    provider: PROVIDER,
    request: asaRequest,
    lookup,
    verdict,
    latencyUs: decisionLatencyUs,
    source: "provider" as const,
    requestId: signature.webhookId ?? requestId,
  };
  //
  //    THE DEADLINE STOPS US WAITING; IT DOES NOT STOP THE INSERT.
  //    `withDeadline()` races, it does not cancel, so a null here means "not
  //    known to be written" and NOT "not written". Re-issuing the insert on
  //    that null is how one authorisation became two rows in the decision log
  //    on 2026-09-11T14:09:08Z: transaction
  //    8025729c-f3a8-4aa1-bfd5-b42405e16f9a appears twice with one Lithic
  //    webhook id and one 600,390 µs latency, because the first insert lost
  //    the 400 ms race and then committed 355 ms later anyway. On a DECLINE
  //    that is a lie in an append-only table; on an APPROVE it would have been
  //    worse, because the velocity sum is SUM(amount_cents) over approvals and
  //    a $200 authorisation recorded twice eats $400 of the cardholder's day.
  //
  //    So `after()` awaits THE SAME PROMISE rather than starting another one,
  //    and only re-appends if that promise genuinely rejected — through a
  //    `WHERE NOT EXISTS` guard, for the case where it committed and lost its
  //    connection before `RETURNING` came back.
  const pending = startDecisionAppend(appendParams);
  const decisionId = await awaitDecisionAppend(pending, DECISION_APPEND_BUDGET_MS);
  if (decisionId === null) {
    log.error("asa.decision_not_recorded", {
      authRef: asaRequest.providerAuthToken,
      rule: verdict.rule,
      outcome: verdict.outcome,
    });
    after(async () => {
      const late = await pending;
      if (late !== null) {
        log.warn("asa.decision_recorded_late", {
          authRef: asaRequest.providerAuthToken,
          decisionId: late,
        });
        return;
      }
      const retried = await reappendDecisionIfMissing(appendParams, DECISION_APPEND_BUDGET_MS * 4);
      if (retried.status === "failed") {
        log.error("asa.decision_lost", { authRef: asaRequest.providerAuthToken });
      } else {
        log.warn("asa.decision_recorded_late", {
          authRef: asaRequest.providerAuthToken,
          decisionId: retried.status === "appended" ? retried.id : null,
          reappend: retried.status,
        });
      }
    });
  }

  const elapsedUs = total();
  const elapsedMs = elapsedUs / 1000;

  // One structured line per authorisation. It carries the budget as well as
  // the elapsed time, so a reader of a log drain six months from now can see
  // whether a slow decision was slow against the target or merely slow.
  log.info("asa.decided", {
    authRef: asaRequest.providerAuthToken,
    cardRef: asaRequest.card.token,
    amountCents: asaRequest.amountCents,
    mcc: asaRequest.mcc,
    requestStatus: asaRequest.requestStatus,
    outcome: verdict.outcome,
    result: verdict.result,
    rule: verdict.rule,
    controlVersion: lookup.status === "read" ? (lookup.controls?.version ?? null) : null,
    storeStatus: lookup.status,
    decisionLatencyUs,
    elapsedUs,
    handlerBudgetMs: HANDLER_BUDGET_MS,
    overBudget: elapsedMs > HANDLER_BUDGET_MS,
    overProviderRecommendation: elapsedMs > PROVIDER_RECOMMENDED_MS,
    decisionId,
  });

  // 7. ANSWER. `result` is the only field Lithic requires; `token` is echoed
  //    so a network trace names the transaction it answers. `approved_amount`
  //    is deliberately never sent — see `asaResponseBody`.
  return json(asaResponseBody(verdict, asaRequest), 200, {
    // Not required by the provider. Present because a decision a human is
    // debugging at 2am should be greppable from the response alone.
    "x-corgi-rule": verdict.rule,
    "x-corgi-decision-latency-us": String(decisionLatencyUs),
  });
}

/**
 * A GET here is a human, a health probe, or someone checking the URL they just
 * pasted into Lithic's responder-endpoint enrollment. Answer it honestly: the
 * budget this endpoint runs to, and the provider facts it was derived from.
 *
 * Deliberately free of anything secret and anything per-card. It states the
 * contract, not the data.
 */
export function GET(): Response {
  return Response.json(
    {
      error: { code: "METHOD_NOT_ALLOWED", message: "the ASA responder accepts POST only" },
      endpoint: "lithic auth stream access (ASA)",
      posts_money: false,
      budget_ms: {
        provider_hard_timeout: PROVIDER_TIMEOUT_MS,
        provider_recommended: PROVIDER_RECOMMENDED_MS,
        control_read: CONTROL_READ_BUDGET_MS,
        decision_append: DECISION_APPEND_BUDGET_MS,
        handler: HANDLER_BUDGET_MS,
      },
      on_store_unavailable: "decline (fail closed)",
      on_unknown_card_token: "approve (out of scope; this book holds no controls for it)",
      on_provider_timeout: "lithic declines and stamps CUSTOMER_ASA_TIMEOUT",
    },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}
