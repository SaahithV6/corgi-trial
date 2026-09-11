/**
 * The error envelope, and the register of what every code means.
 *
 * ===========================================================================
 * ONE SHAPE, ALWAYS, AND IT NAMES THE MISSING THING
 * ===========================================================================
 *
 * Every non-2xx response from `/api/v1/**` is this object and nothing else:
 *
 *     {
 *       "error": {
 *         "type":       "invalid_request" | ... ,   coarse class, for retries
 *         "code":       "PAYEE_WARNING_UNACKNOWLEDGED",
 *         "message":    one sentence a human reads,
 *         "condition":  the predicate that was false,
 *         "resolution": what would make it true,
 *         "details":    { machine-readable specifics }   (optional)
 *       },
 *       "request_id": "..."
 *     }
 *
 * `condition` and `resolution` are the two fields that make this different
 * from an ordinary API error, and they are here because of the register the
 * rest of this build already writes in. The dead-letter messages on the
 * webhook path do not say "invalid request" — they say which field was absent
 * and which value would have been accepted. An integrator hitting the KYB
 * gate, the approval threshold or the payee confirmation check gets the same
 * treatment: the condition that failed, in the vocabulary of this bank, and
 * the specific act that would satisfy it.
 *
 * A refusal with no forward path is how an integrator ends up inventing one —
 * retrying the same call in a loop, or worse, telling their customer the bank
 * is broken. Both of those are outcomes this file exists to prevent.
 *
 * ===========================================================================
 * WHY THE REGISTER IS DATA
 * ===========================================================================
 *
 * The upstream modules (`@/lib/approvals`, `@/lib/kyb`, `@/lib/payees`,
 * `@/lib/mcp`) already produce good codes and good messages. This file does
 * NOT rewrite them — rewriting an upstream message here would be a second
 * opinion about why a payment was refused, which is exactly the class of bug
 * this build has hit before with available balance. What it adds is the HTTP
 * status, the condition and the resolution, keyed by the upstream code, as a
 * table a reviewer can read in one sitting.
 *
 * A code with no entry is not a crash and is not silently a 400: it maps to
 * `UNMAPPED_REFUSAL` with a 422, the upstream message intact, and a resolution
 * that tells the caller to send the request id. Being honest about "we refused
 * you and this layer does not know the remedy" beats guessing one.
 */

/** The coarse class. An integrator branches on this before reading `code`. */
export type ApiErrorType =
  /** The request itself is malformed or contradicts a schema. Do not retry as-is. */
  | "invalid_request"
  /** No token, unknown token, or a token this deployment will not accept. */
  | "authentication"
  /** Authenticated, but this surface does not offer the operation. Never retry. */
  | "refused"
  /** The named thing does not exist inside this token's business. */
  | "not_found"
  /** The request was well-formed and the bank's rules said no. */
  | "unprocessable"
  /** Same idempotency key, different body. Resolve the conflict, then retry. */
  | "conflict"
  /** Slow down. `Retry-After` is set. */
  | "rate_limit"
  /** Our fault. Safe to retry with the SAME idempotency key. */
  | "internal";

export interface ApiErrorPayload {
  readonly type: ApiErrorType;
  readonly code: string;
  readonly message: string;
  /** The predicate that was false, written as a predicate. */
  readonly condition: string;
  /** The specific act that would make it true. Never "try again". */
  readonly resolution: string;
  readonly details?: Record<string, unknown>;
}

/**
 * Thrown by a handler, caught once by `handle()`, rendered once.
 *
 * Carries its own status so that the mapping from a bank refusal to an HTTP
 * code is decided at the place that knows the refusal, not in a switch far
 * away from it.
 */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly type: ApiErrorType;
  readonly code: string;
  readonly condition: string;
  readonly resolution: string;
  readonly details: Record<string, unknown> | undefined;
  /** Extra response headers this refusal requires (`Retry-After`, `WWW-Authenticate`). */
  readonly headers: Readonly<Record<string, string>>;

  constructor(init: {
    readonly status: number;
    readonly type: ApiErrorType;
    readonly code: string;
    readonly message: string;
    readonly condition: string;
    readonly resolution: string;
    readonly details?: Record<string, unknown>;
    readonly headers?: Record<string, string>;
  }) {
    super(init.message);
    this.status = init.status;
    this.type = init.type;
    this.code = init.code;
    this.condition = init.condition;
    this.resolution = init.resolution;
    this.details = init.details;
    this.headers = init.headers ?? {};
  }

  payload(): ApiErrorPayload {
    // An EMPTY `details` is omitted, not rendered as `{}`. Upstream modules
    // pass `{ details: error.details }` whether or not there were any, so a
    // refusal with nothing structured to add would otherwise ship an empty
    // object — which reads like a field that failed to populate rather than a
    // field that had nothing to say.
    const hasDetails = this.details !== undefined && Object.keys(this.details).length > 0;
    return {
      type: this.type,
      code: this.code,
      message: this.message,
      condition: this.condition,
      resolution: this.resolution,
      ...(hasDetails ? { details: this.details as Record<string, unknown> } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Constructors for the refusals this layer raises itself                     */
/* -------------------------------------------------------------------------- */

export function badRequest(
  code: string,
  message: string,
  condition: string,
  resolution: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError({
    status: 400,
    type: "invalid_request",
    code,
    message,
    condition,
    resolution,
    ...(details === undefined ? {} : { details }),
  });
}

export function notFound(
  code: string,
  message: string,
  condition: string,
  resolution: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError({
    status: 404,
    type: "not_found",
    code,
    message,
    condition,
    resolution,
    ...(details === undefined ? {} : { details }),
  });
}

export function refused(
  code: string,
  message: string,
  condition: string,
  resolution: string,
  details?: Record<string, unknown>,
): ApiError {
  return new ApiError({
    status: 403,
    type: "refused",
    code,
    message,
    condition,
    resolution,
    ...(details === undefined ? {} : { details }),
  });
}

/* -------------------------------------------------------------------------- */
/* The register                                                               */
/* -------------------------------------------------------------------------- */

interface Mapping {
  readonly status: number;
  readonly type: ApiErrorType;
  readonly condition: string;
  readonly resolution: string;
}

/**
 * Upstream refusal code -> HTTP status, the condition, and the remedy.
 *
 * The MESSAGE is never in this table. It comes from the module that refused,
 * because that module knows the amounts, the names and the dates involved and
 * this one does not. Duplicating the sentence here is how the two drift and
 * how an integrator ends up reading a generic message while the log holds the
 * specific one.
 *
 * Three families are represented, and it is worth naming them because an
 * integrator debugging at 3am wants to know which wall they hit:
 *
 *   KYB_*     the account is not cleared to transact. §Gate in docs/API.md.
 *   PAYEE_*   the destination did not survive confirmation of payee.
 *   the rest  approvals, funds, validation and the per-token ceiling.
 */
const REGISTER: Readonly<Record<string, Mapping>> = {
  /* ---- KYB gate: "unverified entities can look but not transact" -------- */
  KYB_NOT_STARTED: {
    status: 422,
    type: "unprocessable",
    condition: "business.kyb_status = 'approved'",
    resolution:
      "No verification has been started for this business. A person starts it from the onboarding screen in the console; this API has no endpoint that starts, advances or approves a KYB check. Reads on this account keep working while it is pending — only money-out is gated.",
  },
  KYB_PENDING: {
    status: 422,
    type: "unprocessable",
    condition: "business.kyb_status = 'approved'",
    resolution:
      "A provider has the case and has not answered. This one clears itself: poll GET /api/v1/accounts and retry the payment when the account reports can_transact true. Do not retry in a tight loop — provider decisions are minutes, not milliseconds.",
  },
  KYB_NEEDS_REVIEW: {
    status: 422,
    type: "unprocessable",
    condition: "business.kyb_status = 'approved'",
    resolution:
      "A named human has to clear this case in the console. No API call can do it — see docs/API.md §Refused operations, KYB decisions. Retry the payment once the account reports can_transact true.",
  },
  KYB_REJECTED: {
    status: 422,
    type: "unprocessable",
    condition: "business.kyb_status = 'approved'",
    resolution:
      "Terminal. This business cannot move money and no retry will change that. Contact the operator; a rejected KYB is reopened by a person with evidence, not by an API call.",
  },
  KYB_EVIDENCE_SIMULATED: {
    status: 422,
    type: "unprocessable",
    condition: "business.kyb_evidence in the set this deployment accepts as real",
    resolution:
      "The business is approved, but approved by a simulator on a deployment configured to require a real third-party decision. Re-run the check against the live provider; the console's onboarding screen shows which leg is simulated and why.",
  },
  KYB_EVIDENCE_MANUAL: {
    status: 422,
    type: "unprocessable",
    condition: "business.kyb_evidence in the set this deployment accepts as real",
    resolution:
      "A person approved this business by hand under a policy that wants a third party. The named approver and their reason are on the onboarding screen. Re-run the provider leg to clear it.",
  },
  KYB_STATE_UNREADABLE: {
    status: 422,
    type: "unprocessable",
    condition: "business.kyb_status parses to a status this build understands",
    resolution:
      "The stored verification state is not a value this build recognises, so the gate failed closed. This is an operator problem, not a caller problem: send the request_id.",
  },

  /* ---- Confirmation of payee ------------------------------------------- */
  PAYEE_ROUTING_NUMBER_IMPOSSIBLE: {
    status: 400,
    type: "invalid_request",
    condition: "ABA check digit of destination.routing_number is correct",
    resolution:
      "The routing number cannot exist — this is arithmetic, not a policy, so no override is offered and none would be right. The message names the transposed digits when two adjacent ones look swapped. Re-read the payee's paperwork and send the correct number.",
  },
  PAYEE_WIRE_ROUTING_NUMBER_MISSING: {
    status: 400,
    type: "invalid_request",
    condition: "a wire destination carries a 9-digit wire_routing_number",
    resolution:
      "A BIC is not a substitute: it identifies a bank on the SWIFT network, and a domestic wire is routed on the receiving bank's WIRE ABA — a different number from the same bank's ACH ABA. Without it the check digit has nothing to compute over and the payee book has nothing to match, so both checks in front of the payment would be skipped. Take the number from the payee book, where it has already been checked.",
  },
  PAYEE_STANDING_CHECK_UNAVAILABLE: {
    status: 503,
    type: "internal",
    condition: "the payee book can be read inside the payment's transaction",
    resolution:
      "The check could not run, so the payment was refused rather than passed. Nothing was written. Retry with the SAME Idempotency-Key — a payment that could not be checked is not a payment that has been checked, and the failure that hides this lookup is the failure that would hide a standing warning on the beneficiary.",
  },
  PAYEE_WARNING_UNACKNOWLEDGED: {
    status: 422,
    type: "unprocessable",
    condition:
      "the payee book has no unsigned warning against (routing_number, account_number_last4)",
    resolution:
      "A previous check on this destination raised a name-match warning that nobody has signed for. A person opens the payee in the console, reads the finding and records why it is right to pay it; the payment can then be raised unchanged. The warning does not block the payment — an unsigned warning does. This API deliberately has no endpoint that signs one: see docs/API.md §Refused operations.",
  },

  /* ---- Approvals, funds, policy ---------------------------------------- */
  INSUFFICIENT_AVAILABLE_FUNDS: {
    status: 422,
    type: "unprocessable",
    condition: "amount_cents <= available_cents on the debit account",
    resolution:
      "Nothing was queued. `details` carries the four figures the check was made against: requested, available, ledger and held. Available is ledger minus holds minus uncleared credits minus already-booked future debits — GET /api/v1/accounts/{code}/balance returns the same itemisation. Either reduce the amount or wait for a hold to release.",
  },
  ABOVE_TOKEN_CEILING: {
    status: 422,
    type: "unprocessable",
    condition: "amount_cents <= the per-instruction ceiling on this token",
    resolution:
      "The ceiling is a property of the credential, not of the account: it bounds how large a thing this integration may put in front of a human approver. `details` carries both figures. A larger ceiling is an operator decision made when the token is issued.",
  },
  VALUE_DATE_IN_THE_PAST: {
    status: 400,
    type: "invalid_request",
    condition: "value_date >= today (book time, America/New_York)",
    resolution:
      "Backdating money out is not a correction, it is a claim that a payment already happened. Send today's date or a future one. A genuine correction is a reversal plus a re-book, performed by a person — this API cannot post either.",
  },
  VALUE_DATE_TOO_FAR_AHEAD: {
    status: 400,
    type: "invalid_request",
    condition: "value_date <= today + 90 days",
    resolution:
      "Beyond 90 days this is a standing order, which is a mandate rather than a payment, and mandates are not writable through this API. The message names the latest acceptable date.",
  },
  ACCOUNT_NOT_FOUND: {
    status: 404,
    type: "not_found",
    condition: "the chart code names an open account belonging to this token's business",
    resolution:
      "GET /api/v1/accounts lists every code this token can name. House accounts (the pooled FBO cash account, the rail control accounts) are deliberately not addressable — see docs/API.md §Refused operations.",
  },
  ACCOUNT_NOT_PAYABLE: {
    status: 422,
    type: "unprocessable",
    condition: "the account is postable and on the financial book",
    resolution:
      "Memo-book accounts carry holds, not money, and cannot fund a payment. Use the business current account (code 2100), which GET /api/v1/accounts marks as payable.",
  },
  POLICY_MISSING: {
    status: 422,
    type: "unprocessable",
    condition: "an approval_policy version is in force for this rail on this value date",
    resolution:
      "A payment with no policy version to cite is a payment nobody agreed the rules for, so it is refused rather than given a default threshold. This is an operator problem: send the request_id and the rail.",
  },
  INVALID_REQUEST: {
    status: 400,
    type: "invalid_request",
    condition: "the request body describes a payment this bank can make",
    resolution:
      "`details.problems` names each field and what was wrong with it. Amounts are integer cents as decimal strings, dates are YYYY-MM-DD, and the destination shape must match the rail.",
  },
  INVALID_ARGUMENTS: {
    status: 400,
    type: "invalid_request",
    condition: "the request body validates against the endpoint's schema",
    resolution:
      "`details.problems` names each field and what was wrong with it. Unknown fields are refused rather than ignored, deliberately: a field that is silently dropped is a field the next caller will rely on.",
  },
  NO_SUCH_INSTRUCTION: {
    status: 404,
    type: "not_found",
    condition: "the instruction exists and belongs to this token's business",
    resolution:
      "Identical to the answer for another business's instruction, deliberately: a distinguishable 403 would let a caller enumerate which ids exist. Check the id returned by POST /api/v1/payments.",
  },
  UNAVAILABLE: {
    status: 503,
    type: "internal",
    condition: "the database is reachable",
    resolution:
      "Transient. Retry with the SAME Idempotency-Key — a replay is a no-op that returns the original response, so a retry cannot double-pay.",
  },
  IMMUTABLE: {
    status: 409,
    type: "conflict",
    condition: "the write is an append, not an edit",
    resolution:
      "The database refused an UPDATE or DELETE on a money row. Nothing in this API should be able to produce this; send the request_id.",
  },
  FORBIDDEN: {
    status: 403,
    type: "refused",
    condition: "the application role holds the privilege the statement needed",
    resolution:
      "The connection this API uses holds SELECT and INSERT on money tables and nothing else. This is the database refusing an operation the API should never have attempted; send the request_id.",
  },
};

/**
 * Map an upstream refusal onto the envelope.
 *
 * The message is passed through untouched. See the header: this layer adds the
 * status, the condition and the remedy, and never a second opinion about why.
 */
export function fromRefusal(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  const mapping = REGISTER[code];
  if (mapping === undefined) {
    return new ApiError({
      status: 422,
      type: "unprocessable",
      code,
      message,
      condition: `${code} (this layer holds no entry for that code)`,
      resolution:
        "The bank refused this request and the API layer does not carry a remedy for that refusal code. The message above is the upstream module's own and is accurate. Send the request_id and the code.",
      ...(details === undefined ? {} : { details }),
    });
  }
  return new ApiError({
    status: mapping.status,
    type: mapping.type,
    code,
    message,
    condition: mapping.condition,
    resolution: mapping.resolution,
    ...(details === undefined ? {} : { details }),
  });
}

/** Every code the register knows. Used by the docs endpoint and by its test. */
export function registeredErrorCodes(): readonly string[] {
  return Object.keys(REGISTER).sort();
}

/** One register entry, for `GET /api/v1/errors`. */
export function describeErrorCode(
  code: string,
): { readonly code: string; readonly status: number; readonly type: ApiErrorType; readonly condition: string; readonly resolution: string } | null {
  const mapping = REGISTER[code];
  if (mapping === undefined) return null;
  return {
    code,
    status: mapping.status,
    type: mapping.type,
    condition: mapping.condition,
    resolution: mapping.resolution,
  };
}
