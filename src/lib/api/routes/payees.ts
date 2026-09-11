/**
 * `GET /api/v1/payees` — the payee book, read-only.
 *
 * ===========================================================================
 * READ-ONLY, AND THAT IS THE POINT OF THE ENDPOINT
 * ===========================================================================
 *
 * There is no `POST /api/v1/payees`, no re-check and no acknowledgement. The
 * argument is in docs/API.md §Refused operations and it is short: confirmation
 * of payee exists to catch the mistyped account before the money leaves, and a
 * caller that can both propose a destination AND sign off the warning raised
 * against it has been handed both halves of the control. The signature on a
 * name-match warning is a person putting their name to a judgement about a
 * beneficiary; an integration signing it records a second opinion that is
 * guaranteed to agree with the first.
 *
 * What the READ is for: an integrator composing a destination from an invoice
 * has nothing to check it against without this. With it, "this routing number
 * and last four are already on the book as ACME LOGISTICS LLC, checked four
 * days ago, name match exact" is an answer that prevents the payment the
 * confirmation step exists to catch — one step earlier, and without needing
 * anybody to sign anything.
 *
 * The `findings` on each row are RENDERED, never re-decided. `outcome`,
 * `name_match` and `checksum_ok` beside them are the decision, and a findings
 * blob of an unexpected shape shows as no findings rather than costing the
 * caller the row.
 */

import { limitParam, page, rejectUnknownParams, enumParam, stringParam, boolParam } from "../http";
import type { ApiContext, RouteResult } from "../handle";

const RAILS = ["ach", "wire", "usdc", "internal"] as const;
const OUTCOMES = ["verified", "warned", "blocked"] as const;
const FRESHNESS = ["fresh", "ageing", "stale", "never"] as const;

const ACCEPTED = [
  "rail",
  "outcome",
  "freshness",
  "holder_name_contains",
  "include_archived",
  "limit",
] as const;

export async function listPayeesRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ACCEPTED);

  const limit = limitParam(ctx.url, 50);

  const rows = await ctx.gateway.listPayees(ctx.grant.businessId, {
    rail: enumParam(ctx.url, "rail", RAILS),
    outcome: enumParam(ctx.url, "outcome", OUTCOMES),
    freshness: enumParam(ctx.url, "freshness", FRESHNESS),
    holderNameContains: stringParam(ctx.url, "holder_name_contains"),
    includeArchived: boolParam(ctx.url, "include_archived") ?? false,
    limit,
  });

  const data = rows.map((row) => ({
    object: "payee" as const,
    id: row.payeeId,
    display_name: row.displayName,
    holder_name: row.holderName,
    rail: row.rail,
    routing_number: row.routingNumber,
    account_number_last4: row.accountNumberLast4,
    account_type: row.accountType,
    created_at: row.createdAt,
    created_by: row.createdByName,
    archived: row.archived,
    archived_at: row.archivedAt,
    /**
     * The check, and everything it decided on. A payment to a destination
     * whose `outcome` is "warned" and whose `acknowledged` is false will be
     * refused by POST /api/v1/payments with PAYEE_WARNING_UNACKNOWLEDGED —
     * which is checkable here BEFORE the payment is attempted.
     */
    verification: {
      checked_at: row.checkedAt,
      checked_by: row.checkedByName,
      checked_days_ago: row.checkedDaysAgo,
      outcome: row.outcome,
      freshness: row.freshness,
      checksum_ok: row.checksumOk,
      prefix_assigned: row.prefixAssigned,
      directory: row.directory,
      directory_provider: row.directoryProvider,
      institution_name: row.institutionName,
      name_match: row.nameMatch,
      name_match_score: row.nameMatchScore,
      name_source: row.nameSource,
      counterparty_name: row.counterpartyName,
      evidence: row.evidence,
      findings: row.findings.map((f) => ({
        code: f.code,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
      })),
    },
    acknowledgement: {
      acknowledged: row.acknowledged,
      acknowledged_at: row.acknowledgedAt,
      acknowledged_by: row.acknowledgedByName,
      reason: row.acknowledgementReason,
    },
    /** Two live payees on the same account number with different holder names. */
    has_conflicting_twin: row.hasConflictingTwin,
  }));

  return {
    status: 200,
    body: {
      ...page(data, limit, null),
      writes_refused: {
        create: "POST /api/v1/payees does not exist — see docs/API.md §Refused operations",
        acknowledge:
          "signing off a name-match warning is a person putting their name to a judgement; an integration cannot",
        archive: "archiving changes where future payments can go, with no approval step behind it",
      },
      request_id: ctx.requestId,
    },
    audit: { rows: data.length },
  };
}
