/**
 * Fixture sources for the states that must not touch the database.
 *
 * `loading`, `empty` and `error` are the three states a live read cannot be
 * asked to produce on demand without either faking a delay in the query layer
 * or breaking something real. They are fixtures, they say so on the screen in
 * red, and `default` and `edge` are live.
 *
 * The numbers below are deliberately NOT the live book's numbers. A fixture
 * that looks like production is a fixture somebody will screenshot and quote.
 */

import { fail, ok } from "@/lib/result";

import type {
  DisputesDataSource,
  DisputesResult,
  DisputesView,
  ProvenanceView,
} from "./data-contract";
import type { DemoState } from "./view-state";

const PROVENANCE: ProvenanceView = [
  {
    line: "FIXTURE. Nothing on this screen was read from the ledger.",
    provider: "operator",
  },
];

const FIXTURE_BASE: DisputesView = {
  source: "fixture",
  asOf: "2026-09-10T00:00:00.000Z",
  bookDate: "2026-09-10",
  provenance: PROVENANCE,
  policy: {
    thresholdCents: 5000,
    requiredApprovals: 1,
    note: "Fixture policy. The live one is read from approval_policy, which is effective-dated and append-only.",
  },
  businesses: [{ businessId: "00000000-0000-4000-8000-000000000001", legalName: "Fixture Co." }],
  selected: {
    businessId: "00000000-0000-4000-8000-000000000001",
    legalName: "Fixture Co.",
    ledgerCents: 1_234_500,
    holdsCents: 0,
    availableCents: 1_234_500,
  },
  cases: [],
  charges: [],
  reasonCodes: [],
  episode: null,
  episodeMissing: null,
};

function emptyView(): DisputesView {
  return FIXTURE_BASE;
}

function defaultView(): DisputesView {
  return {
    ...FIXTURE_BASE,
    cases: [
      {
        disputeId: "00000000-0000-4000-8000-0000000000a1",
        caseRef: "DSP-20260910-FIXTUR",
        businessId: "00000000-0000-4000-8000-000000000001",
        legalName: "Fixture Co.",
        disputedEntryId: "00000000-0000-4000-8000-0000000000b1",
        reason: "goods_not_received",
        network: "visa",
        networkCode: "13.1",
        networkLabel: "Merchandise/Services Not Received",
        narrative: "Fixture narrative. No customer said this.",
        amountCents: 24_900,
        status: "provisional_credit_granted",
        statusMeaning:
          "We have advanced the customer their money. It is in their ledger balance and it is held.",
        isClosed: false,
        raisedBy: "Fixture operator",
        raisedAt: "2026-09-10T00:00:00.000Z",
        valueDate: "2026-09-10",
        decidedOn: null,
        networkOutsideDate: "2027-01-08",
        daysToOutsideDate: 120,
        advancedCents: 24_900,
        heldCents: 24_900,
        holdReleased: false,
        needsAuthorization: true,
        authorizations: 1,
        requiredApprovals: 1,
        thresholdCents: 5000,
      },
    ],
  };
}

/**
 * `loading` holds the boundary open for long enough to see the skeleton, then
 * renders the default view. The delay is in the SOURCE, not in the component,
 * so the skeleton on screen is the one a genuinely slow database produces.
 */
async function loadingView(): Promise<DisputesView> {
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  return defaultView();
}

export function createFixtureDisputesSource(state: DemoState): DisputesDataSource {
  return {
    async load(): Promise<DisputesResult> {
      switch (state) {
        case "loading":
          return ok(await loadingView());
        case "empty":
          return ok(emptyView());
        case "error":
          return fail(
            "DISPUTES_READ_FAILED",
            "The disputes read failed. Nothing was posted — this path only reads.",
            { detail: "fixture: connection to the ledger was refused" },
          );
        default:
          return ok(defaultView());
      }
    },
  };
}
