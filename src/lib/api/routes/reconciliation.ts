/**
 * `GET /api/v1/reconciliation/breaks` — where the processor's file and this
 * ledger disagree, scoped to one business.
 *
 * ===========================================================================
 * THREE CATEGORIES, ONE DEFINITION
 * ===========================================================================
 *
 *   in_file_not_ledger   the scheme file has a row we never booked
 *   in_ledger_not_file   we booked something the file does not mention
 *   amount_mismatch      both have it, for different money
 *
 * The diff is NOT re-implemented here. `v_recon_break` is the single
 * definition of the three categories and `toReconBreak` applies the age bucket
 * and severity; `mcp/gateway.ts` adds the tenant predicate and pushes it into
 * the WHERE clause rather than filtering afterwards, because a filter applied
 * after the fetch is a filter someone can forget to apply. Membership is
 * decided by the CUSTOMER'S own leaf, never by the rail control account: a
 * settlement entry touches both, and keying on the control account would hand
 * every business every break on the rail.
 *
 * ===========================================================================
 * `unattributable_open_breaks` IS A COUNT AND NEVER A LIST
 * ===========================================================================
 *
 * A break with no journal entry has no account, so it has no business — an
 * in-file-not-ledger row we never matched belongs to nobody. Guessing an owner
 * would hand one customer a row about another customer's money.
 *
 * The count itself is a small cross-tenant disclosure and it is here anyway,
 * with the trade named rather than hidden: telling an integrator "no breaks"
 * when the truth is "none of yours, and five nobody owns" invites them to
 * reassure a customer that the books tie out. `docs/AGENT-LIMITS.md`'s
 * debatable list carries the same entry for the agent surface; this is the
 * same call, made the same way, for a wider audience.
 */

import { limitParam, money, page, rejectUnknownParams, enumParam, boolParam, stringParam } from "../http";
import { badRequest } from "../errors";
import type { ApiContext, RouteResult } from "../handle";

const CATEGORIES = ["in_file_not_ledger", "in_ledger_not_file", "amount_mismatch"] as const;

const ACCEPTED = ["category", "min_age_days", "include_explained", "limit"] as const;

export async function listBreaksRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ACCEPTED);

  const limit = limitParam(ctx.url, 50);
  const minAgeDays = intParam(ctx.url, "min_age_days");

  const result = await ctx.gateway.listReconBreaks(ctx.grant.businessId, {
    category: enumParam(ctx.url, "category", CATEGORIES),
    minAgeDays,
    includeExplained: boolParam(ctx.url, "include_explained") ?? false,
    limit,
  });

  const data = result.rows.map((row) => ({
    object: "reconciliation_break" as const,
    break_key: row.breakKey,
    category: row.category,
    reason_code: row.reasonCode,
    severity: row.severity,
    /** Days since the value date. The aging a breaks screen sorts on. */
    age_days: row.ageDays,
    age_bucket: row.ageBucket,
    value_date: row.valueDate,
    rail: row.rail,
    provider: row.provider,
    external_ref: row.externalRef,
    entry_id: row.entryId,
    /** Null when the side in question has nothing to report. */
    file_amount: row.fileAmountCents === null ? null : money(row.fileAmountCents),
    ledger_amount: row.ledgerAmountCents === null ? null : money(row.ledgerAmountCents),
    /** Signed on the FILE's axis: how much the file is out by. */
    break_amount: money(row.breakAmountCents),
    description: row.description,
    /** Set when a later entry accounts for the difference. Still a real break. */
    explained_by: row.explainedBy,
  }));

  return {
    status: 200,
    body: {
      ...page(data, limit, null),
      unattributable_open_breaks: result.unattributableOpenBreaks,
      unattributable_note:
        "Breaks with no journal entry have no account and therefore no business. They are counted, never listed: guessing an owner would hand one customer a row about another customer's money. A non-zero count means the books do not tie out platform-wide even if none of your rows appear above.",
      request_id: ctx.requestId,
    },
    audit: { rows: data.length, unattributable: result.unattributableOpenBreaks },
  };
}

function intParam(url: URL, name: string): number | null {
  const raw = stringParam(url, name);
  if (raw === null) return null;
  if (!/^[0-9]{1,5}$/.test(raw)) {
    throw badRequest(
      "INVALID_INTEGER",
      `${name}="${raw}" is not a non-negative whole number`,
      `${name} is an integer >= 0`,
      `Send a plain integer, e.g. ${name}=3 to see only breaks at least three days old.`,
      { parameter: name, received: raw },
    );
  }
  return Number.parseInt(raw, 10);
}
