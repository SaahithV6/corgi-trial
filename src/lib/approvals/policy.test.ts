import { describe, expect, it } from "vitest";

import { approvalsRequired, pickEffectivePolicy, requiresApproval } from "./policy";
import { policyVersion, type ApprovalPolicy } from "./types";

function policy(
  rail: ApprovalPolicy["rail"],
  effectiveFrom: string,
  thresholdCents: bigint,
  requiredApprovals: number,
): ApprovalPolicy {
  return {
    id: `${rail}-${effectiveFrom}`,
    rail,
    effectiveFrom,
    thresholdCents,
    requiredApprovals,
    note: "",
    version: policyVersion(rail, effectiveFrom),
  };
}

/**
 * Two versions of the ACH policy: the seeded one, and a tightening that lands
 * in the middle of the year. Both rows exist for ever — `approval_policy` is
 * append-only — so every question below has a date in it.
 */
const ACH_2026 = policy("ach", "2026-01-01", 250_000n, 1);
const ACH_JULY = policy("ach", "2026-07-01", 50_000n, 2);
const WIRE = policy("wire", "2026-01-01", 0n, 2);
const FUTURE = policy("ach", "2027-01-01", 0n, 3);
const ALL = [ACH_JULY, ACH_2026, WIRE, FUTURE];

describe("pickEffectivePolicy", () => {
  it("takes the latest version whose effective_from has arrived", () => {
    expect(pickEffectivePolicy(ALL, "ach", "2026-03-15")).toBe(ACH_2026);
    expect(pickEffectivePolicy(ALL, "ach", "2026-09-10")).toBe(ACH_JULY);
  });

  it("applies a version on its first day and not the day before", () => {
    expect(pickEffectivePolicy(ALL, "ach", "2026-06-30")).toBe(ACH_2026);
    expect(pickEffectivePolicy(ALL, "ach", "2026-07-01")).toBe(ACH_JULY);
  });

  /**
   * The bug this test exists to prevent: comparing dates as `Date` objects.
   * `new Date("2026-01-01")` is midnight UTC, which is 19:00 the previous
   * evening in the banking timezone — so a Date-based comparison applies the
   * January policy to a payment dated 31 December. Strings sort in calendar
   * order and have no timezone to get wrong.
   */
  it("does not shift a boundary by a timezone", () => {
    expect(pickEffectivePolicy(ALL, "ach", "2025-12-31")).toBeNull();
    expect(pickEffectivePolicy(ALL, "ach", "2026-01-01")).toBe(ACH_2026);
  });

  it("ignores a version written ahead of time until its date arrives", () => {
    expect(pickEffectivePolicy(ALL, "ach", "2026-12-31")).toBe(ACH_JULY);
    expect(pickEffectivePolicy(ALL, "ach", "2027-01-01")).toBe(FUTURE);
  });

  it("never returns another rail's policy", () => {
    expect(pickEffectivePolicy(ALL, "wire", "2026-09-10")).toBe(WIRE);
    expect(pickEffectivePolicy([WIRE], "ach", "2026-09-10")).toBeNull();
  });
});

describe("the threshold, under a specific version", () => {
  it("needs an approver at and above the threshold, not just above it", () => {
    expect(requiresApproval(ACH_2026, 249_999n)).toBe(false);
    expect(requiresApproval(ACH_2026, 250_000n)).toBe(true);
    expect(requiresApproval(ACH_2026, 250_001n)).toBe(true);
  });

  it("runs the same path below threshold, with a required count of zero", () => {
    expect(approvalsRequired(ACH_2026, 100_000n)).toBe(0);
    expect(approvalsRequired(ACH_2026, 250_000n)).toBe(1);
  });

  it("needs two approvers on every wire, at any amount — threshold zero", () => {
    expect(approvalsRequired(WIRE, 1n)).toBe(2);
    expect(requiresApproval(WIRE, 1n)).toBe(true);
  });

  /**
   * THE PROPERTY THE WHOLE VERSIONING SCHEME EXISTS FOR.
   *
   * A $1,200 ACH raised in March needed no approval. In July the threshold
   * drops to $500 and the count rises to two. The March payment must still be
   * judged by the version it cited — otherwise a policy change would
   * retroactively turn a correct, unapproved payment into a control breach, and
   * every audit of the past would depend on the present.
   */
  it("judges a past payment by the version it cited, not by today's rule", () => {
    const march = pickEffectivePolicy(ALL, "ach", "2026-03-15");
    const september = pickEffectivePolicy(ALL, "ach", "2026-09-10");
    expect(march).not.toBe(september);

    const amount = 120_000n; // $1,200
    expect(approvalsRequired(march as ApprovalPolicy, amount)).toBe(0);
    expect(approvalsRequired(september as ApprovalPolicy, amount)).toBe(2);

    // The instruction stores `policy_id`, so the March row keeps citing
    // ach@2026-01-01 for ever and this stays 0 no matter what July did.
    expect((march as ApprovalPolicy).version).toBe("ach@2026-01-01");
  });
});
