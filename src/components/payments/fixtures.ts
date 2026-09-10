/**
 * The three fixture states behind the payments screen's data contract.
 *
 * `default` and `edge` are not here: both read Neon (see `demo-state.ts` for
 * why the edge case in particular has to be live). These three exist so
 * `loading`, `error` and `empty` can be shown on demand, in order, in front of
 * a panel, without slowing the real database down, breaking it, or closing the
 * only deposit accounts on the book.
 *
 * The numbers are the seeded policy's numbers — the ACH threshold really is
 * $2,500 with one approver, the wire policy really is $0 with two, and internal
 * really is $0 with none — so a fixture form and a live form quote the same
 * table. A fixture that invented a threshold would be teaching a rule this bank
 * does not have.
 */

import { fail, ok } from "@/lib/result";

import type { PaymentsDataSource, PaymentsSnapshot, PolicyOptionView } from "./data-contract";
import type { DemoState } from "./demo-state";

/** Fixed, so ages and screenshots are reproducible. */
export const DEMO_NOW = "2026-09-10T18:20:00.000Z"; // 14:20 ET
export const DEMO_VALUE_DATE = "2026-09-11";

/** How long `?state=loading` holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const POLICIES: readonly PolicyOptionView[] = [
  {
    id: "9315dd14-5e7f-5703-b37a-236a2531b968",
    version: "ach@2026-01-01",
    rail: "ach",
    effectiveFrom: "2026-01-01",
    thresholdDisplay: "$2,500.00",
    requiredApprovals: 1,
    note: "ACH debits of $2,500 or more need one approver who is not the initiator. Below that the agent may submit unattended; an ACH entry is recallable for two banking days, which bounds the damage.",
  },
  {
    id: "161827bf-8c19-54f3-9b0f-a24834b59ec3",
    version: "internal@2026-01-01",
    rail: "internal",
    effectiveFrom: "2026-01-01",
    thresholdDisplay: "$0.00",
    requiredApprovals: 0,
    note: "Book transfers between accounts on our own ledger need no approval: both legs are ours, nothing leaves the FBO account, and a mistake is correctable by a reversal.",
  },
  {
    id: "787eb2f6-e05b-5dbf-bb5a-56cc6242b105",
    version: "usdc@2026-01-01",
    rail: "usdc",
    effectiveFrom: "2026-01-01",
    thresholdDisplay: "$1,000.00",
    requiredApprovals: 1,
    note: "USDC from $1,000 up needs an approver. The threshold is lower than ACH because an on-chain transfer is irreversible the moment it confirms — there is no recall window to fall back on.",
  },
  {
    id: "d0aaa278-d28b-502c-9e4f-4eddda0af506",
    version: "wire@2026-01-01",
    rail: "wire",
    effectiveFrom: "2026-01-01",
    thresholdDisplay: "$0.00",
    requiredApprovals: 2,
    note: "Every wire, at any amount, needs two distinct human approvers. Wires are irrevocable on receipt and are the rail business-email-compromise actually uses.",
  },
];

function snapshot(
  actor: PaymentsSnapshot["actor"],
  accounts: PaymentsSnapshot["accounts"],
): PaymentsSnapshot {
  return {
    actor,
    accounts,
    policies: POLICIES,
    defaultValueDate: DEMO_VALUE_DATE,
    asOf: DEMO_NOW,
  };
}

/** One verified account and one that the gate will refuse, as the seed has it. */
const LOADING_ACCOUNTS: PaymentsSnapshot["accounts"] = [
  {
    id: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    name: "Ridgeline Robotics, Inc. — business current account",
    businessId: "e274546d-6bdd-5266-b0fb-cc839a7811f9",
    businessName: "Ridgeline Robotics, Inc.",
    currency: "USD",
    gate: {
      allowed: true,
      code: null,
      message:
        "Verification is approved and this deployment's policy accepts the evidence on file.",
      status: "approved",
      evidence: "simulated",
    },
    gateIfLiveRequired: {
      allowed: false,
      code: "KYB_EVIDENCE_SIMULATED",
      message:
        "Verification passed on simulated evidence, which this deployment does not accept for transacting.",
      status: "approved",
      evidence: "simulated",
    },
  },
];

const PREFLIGHT_FAILED = {
  code: "PAYMENTS_PREFLIGHT_FAILED",
  message:
    "The account list and threshold policy could not be read, so the form cannot be drawn honestly and is not drawn at all. Nothing was raised — this is a read, and a read cannot queue a payment.",
} as const;

/**
 * The fixture source for one non-live demo state.
 *
 * `loading` is not a rendered mock — it genuinely does not resolve for six
 * seconds, so the Suspense fallback on the page is the real loading state and
 * not a picture of one.
 */
export function createFixtureSource(
  state: Exclude<DemoState, "default" | "edge">,
): PaymentsDataSource {
  return {
    async getFormData(actor) {
      switch (state) {
        case "loading":
          await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
          return ok(snapshot(actor, LOADING_ACCOUNTS));
        case "empty":
          return ok(snapshot(actor, []));
        case "error":
          return fail(PREFLIGHT_FAILED.code, PREFLIGHT_FAILED.message);
      }
    },
  };
}
