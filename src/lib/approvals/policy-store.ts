/**
 * Reading `approval_policy` rows.
 *
 * The half of `policy.ts` that touches a connection, kept separate so the
 * effective-dating logic stays testable without one. Nothing here decides
 * anything: it selects rows and maps them, and every judgement about which
 * version applies lives in `policy.ts`.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import { policyVersion, type ApprovalPolicy, type PaymentRail } from "./types";

type PolicyRow = {
  readonly id: string;
  readonly rail: PaymentRail;
  readonly effective_from: string;
  readonly threshold_cents: bigint;
  readonly required_approvals: number;
  readonly note: string;
};

function toPolicy(row: PolicyRow): ApprovalPolicy {
  return {
    id: row.id,
    rail: row.rail,
    effectiveFrom: row.effective_from,
    thresholdCents: row.threshold_cents,
    requiredApprovals: row.required_approvals,
    note: row.note,
    version: policyVersion(row.rail, row.effective_from),
  };
}

/** Every version, newest first. For an audit view and for `pickEffectivePolicy`. */
export async function listPolicies(conn: Sql = sql): Promise<readonly ApprovalPolicy[]> {
  const rows = await conn<PolicyRow[]>`
    SELECT id, rail::text AS rail, effective_from::text AS effective_from,
           threshold_cents, required_approvals, note
      FROM approval_policy
     ORDER BY rail, effective_from DESC`;
  return rows.map(toPolicy);
}

/**
 * The version to judge a NEW instruction under. Called once, at request time,
 * and its id is written onto the instruction — after which nothing re-picks.
 */
export async function effectivePolicyFor(
  rail: PaymentRail,
  asOf: string,
  conn: Sql = sql,
): Promise<ApprovalPolicy | null> {
  const rows = await conn<PolicyRow[]>`
    SELECT id, rail::text AS rail, effective_from::text AS effective_from,
           threshold_cents, required_approvals, note
      FROM approval_policy
     WHERE rail = ${rail}::rail
       AND effective_from <= ${asOf}::date
     ORDER BY effective_from DESC
     LIMIT 1`;
  const row = rows[0];
  return row === undefined ? null : toPolicy(row);
}

export { toPolicy as policyFromRow };
export type { PolicyRow };
