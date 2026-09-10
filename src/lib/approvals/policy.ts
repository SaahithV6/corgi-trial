/**
 * Threshold policy, versioned.
 *
 * ============================================================================
 * THE PROPERTY THIS FILE EXISTS FOR: a policy change must never make a past
 * approval look wrong.
 *
 * `approval_policy` is append-only (0001 §13 puts the no-UPDATE trigger on it)
 * and effective-dated: raising the ACH threshold from $2,500 to $10,000 is an
 * INSERT of a new row with a later `effective_from`, never an edit of the old
 * one. Both rows exist for ever.
 *
 * A `payment_instruction` stores `policy_id` — the specific row it was judged
 * under — so "was this payment approved correctly?" is answered by joining to
 * the version that was in force at the time, not by re-reading today's policy.
 * Without that column, tightening the threshold in December would make every
 * unapproved sub-threshold payment from March retroactively look like a control
 * failure, and loosening it would make a genuine breach disappear.
 *
 * This module is the PURE half: pick the version in force on a date, and say
 * what that version demands of an amount. It holds no database handle and no
 * `server-only` guard, so `policy.test.ts` can walk every boundary case — the
 * day a version takes effect, the day before, a version written ahead of time —
 * in a plain Node process. `policy-store.ts` is the half that reads rows.
 * ============================================================================
 */

import type { ApprovalPolicy, PaymentRail } from "./types";

/**
 * The version in force for a rail on a given date.
 *
 * `effective_from <= asOf`, latest wins. A policy dated in the future is
 * visible in the table and does not apply — which is the point of writing it
 * ahead of time.
 *
 * Comparison is on the `YYYY-MM-DD` strings, not on `Date` objects, and that is
 * deliberate: `new Date("2026-01-01")` is midnight UTC, which is the previous
 * evening in the banking timezone, so a Date-based comparison would apply a
 * January policy to a payment dated 31 December. ISO date strings sort
 * lexicographically in calendar order; there is no timezone to get wrong.
 */
export function pickEffectivePolicy(
  policies: readonly ApprovalPolicy[],
  rail: PaymentRail,
  asOf: string,
): ApprovalPolicy | null {
  let best: ApprovalPolicy | null = null;
  for (const candidate of policies) {
    if (candidate.rail !== rail) continue;
    if (candidate.effectiveFrom > asOf) continue;
    if (best === null || candidate.effectiveFrom > best.effectiveFrom) best = candidate;
  }
  return best;
}

/** Does this amount need a checker under this version? */
export function requiresApproval(policy: ApprovalPolicy, amountCents: bigint): boolean {
  return amountCents >= policy.thresholdCents && policy.requiredApprovals > 0;
}

/**
 * How many approvals this payment needs under the version it cites.
 *
 * Below threshold the answer is 0, and the same release path runs with no
 * approval — one mechanism, not two. That is DESIGN §16 verbatim, and it is why
 * the trigger has a single gate rather than a fast path someone could widen.
 */
export function approvalsRequired(policy: ApprovalPolicy, amountCents: bigint): number {
  return amountCents >= policy.thresholdCents ? policy.requiredApprovals : 0;
}
