/**
 * `GET /api/v1` and `GET /api/v1/limits`.
 *
 * ===========================================================================
 * WHY THE REFUSAL LIST IS ITSELF AN ENDPOINT
 * ===========================================================================
 *
 * The same argument `list_agent_limits` makes on the MCP surface, transposed.
 * A written policy the caller cannot read is a policy enforced only by
 * refusals the caller cannot interpret. An integrator discovers what this API
 * CAN do from the index and discovers what it CANNOT do by guessing a path,
 * getting a 404, and guessing again — and "404" is the worst possible answer
 * to that question, because it is indistinguishable from a typo, from a
 * version skew, and from a capability that exists under a different name. So
 * the integrator retries, invents a workaround, or tells their customer the
 * bank's API is broken.
 *
 * `GET /api/v1/limits` is that document served from the same data the refusals
 * are written in, so it cannot drift from them. It reads no customer data and
 * touches no table: it is the only endpoint on this surface whose subject is
 * the surface rather than the bank.
 */

import { API_REFUSALS, MISSING_READERS, PRINCIPLE, inheritedRefusals } from "../limits";
import { registeredErrorCodes, describeErrorCode } from "../errors";
import { rejectUnknownParams, stringParam } from "../http";
import type { ApiContext, RouteResult } from "../handle";

export async function indexRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, []);
  return Promise.resolve({
    status: 200,
    body: {
      object: "api",
      version: "v1",
      // Echoed so an integrator never has to guess which tenant a credential
      // is scoped to, and so a token accidentally pointed at the wrong
      // business is visible on the first call rather than on the first
      // payment.
      business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
      credential: {
        label: ctx.grant.label,
        fingerprint: ctx.grant.tokenFingerprint,
        rate_limit_per_minute: ctx.grant.rateLimitPerMinute,
        max_instruction_cents:
          ctx.grant.maxInstructionCents === null
            ? null
            : ctx.grant.maxInstructionCents.toString(),
        can_approve: false,
        scope: "exactly one business; no parameter on any endpoint can widen it",
      },
      endpoints: [
        { method: "GET", path: "/api/v1", description: "This document." },
        {
          method: "GET",
          path: "/api/v1/accounts",
          description: "Every account this token can name, plus the KYB gate on money-out.",
        },
        { method: "GET", path: "/api/v1/accounts/{code}", description: "One account." },
        {
          method: "GET",
          path: "/api/v1/accounts/{code}/balance",
          description:
            "Ledger and available balance with the difference itemised. Bitemporal: as_of_value_date and as_of_booking_time.",
        },
        {
          method: "GET",
          path: "/api/v1/transactions",
          description:
            "The ledger, newest first, cursor-paged. Filters on both date axes independently.",
        },
        {
          method: "POST",
          path: "/api/v1/payments",
          description:
            "Queue a payment for HUMAN approval. Requires Idempotency-Key. Moves no money and cannot.",
        },
        {
          method: "GET",
          path: "/api/v1/payments/{id}",
          description: "One instruction with its whole event stream.",
        },
        {
          method: "GET",
          path: "/api/v1/payees",
          description: "The payee book and every confirmation-of-payee finding. Read-only.",
        },
        {
          method: "GET",
          path: "/api/v1/statements",
          description: "Closed business days this account has something to show for.",
        },
        {
          method: "GET",
          path: "/api/v1/statements/{business_date}",
          description:
            "As published AND as corrected, with the delta itemised and the published hash re-verified.",
        },
        {
          method: "GET",
          path: "/api/v1/reconciliation/breaks",
          description: "Where the processor's file and this ledger disagree, with aging.",
        },
        {
          method: "GET",
          path: "/api/v1/limits",
          description: "What this API refuses to do, and the argument for each.",
        },
      ],
      conventions: {
        money:
          'Every amount is {"cents":"<signed integer as a decimal STRING>","display":"$0.00"}. Never a JSON number: JSON.parse produces a double, and a double stops representing consecutive integers above 2^53 — about $90 trillion in cents — with no warning.',
        dates:
          "Business dates are YYYY-MM-DD in book time (America/New_York). Instants are ISO 8601 with a zone. Every row carries BOTH value_date (when it happened) and booking_time (when we learned it), and they are filtered independently.",
        pagination:
          "Cursor, never offset. Follow page.next_cursor verbatim; it is opaque and a constructed one is refused rather than silently paged from the top.",
        idempotency:
          "Idempotency-Key is REQUIRED on every write and must be derived from the fact that caused it, not generated per attempt. A replay returns the original response with replayed:true and HTTP 200 rather than 201. The same key with a different body is 409 IDEMPOTENCY_KEY_REUSED and queues nothing.",
        errors:
          "Every non-2xx body is {error:{type,code,message,condition,resolution,details?},request_id}. `condition` names the predicate that was false; `resolution` names what would make it true. GET /api/v1/limits lists every registered code.",
        unknown_parameters:
          "Refused, never ignored. A caller who is quietly served their own data after sending a filter that did nothing walks away believing the filter worked.",
      },
      safety:
        "Every write on this API lands in the same approval queue a person's request lands in, under the same policy version, with the same content hash. Nothing here approves, releases, posts to the journal, or changes the rules that decide what is final. See GET /api/v1/limits.",
      request_id: ctx.requestId,
    },
    audit: null,
  });
}

export async function limitsRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ["error_code"]);

  const wanted = stringParam(ctx.url, "error_code");
  const errorDetail = wanted === null ? null : describeErrorCode(wanted);

  return Promise.resolve({
    status: 200,
    body: {
      object: "limits",
      principle: PRINCIPLE,
      http_specific: API_REFUSALS.map((r) => ({
        ref: r.ref,
        operation: r.operation,
        absent_endpoints: r.absentEndpoints,
        why: r.why,
        guarantee: r.guarantee,
        enforced_by: r.enforcedBy,
        instead: r.instead,
        sharpens_agent_limits_sections: r.sharpens,
      })),
      inherited_from_agent_limits: inheritedRefusals().map((r) => ({
        section: r.section,
        operation: r.operation,
        absent_tools: r.absentTools,
        why: r.why,
        guarantee: r.guarantee,
        enforced_by: r.enforcedBy,
        instead: r.instead,
      })),
      guarantee_legend: {
        unrepresentable:
          "Postgres will not store the row, from any connection, with or without our application code in the path. Proved by attempting it: dbcheck.mjs and the integration tests make the forbidden write on every run and assert the SQLSTATE.",
        "capability-absent":
          "The function that performs it is not imported by src/lib/api/** or src/app/api/v1/**, and no-write-imports.test.ts fails the build if anyone adds it. Real, and conditional on a test surviving.",
      },
      missing_readers: MISSING_READERS.map((m) => ({
        question: m.question,
        wanted: m.wanted,
        why_not_worked_around: m.whyNotWorkedAround,
      })),
      error_codes: registeredErrorCodes(),
      ...(wanted === null
        ? {}
        : {
            error_code: errorDetail ?? {
              code: wanted,
              note: "not a registered code; an unregistered refusal is returned as a 422 with the upstream message intact",
            },
          }),
      request_id: ctx.requestId,
    },
    audit: { query: wanted },
  });
}
