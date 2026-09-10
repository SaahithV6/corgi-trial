/**
 * The standing-orders screen without a database.
 *
 * Two jobs, and they are different:
 *
 * 1. THE FOUR NON-DEFAULT STATES. `loading`, `empty`, `error` and `edge` have
 *    to be reachable in front of a panel without firing a payment, so they are
 *    fixtures even when a database is configured. `default` is always the live
 *    query — that is the state where the real occurrences, the real refusals
 *    and the real invariant counts are.
 *
 * 2. NO DATABASE AT ALL. `pnpm dev` with no `.env` still renders a real
 *    screen, labelled `fixture` on its face. The label is not decoration: a
 *    figure without provenance is a rumour, and a screen that quietly showed
 *    made-up money as a fired payment would be the worst place in this
 *    codebase to start.
 *
 * THE EDGE STATE IS THE POINT OF THE TRACK. An occurrence refused for
 * insufficient AVAILABLE balance on a day the LEDGER balance covered it twice
 * over. The numbers below are chosen so the arithmetic is visible on the face
 * of the screen:
 *
 *     ledger      $18,240.00
 *     card holds  −$4,850.00   a fuel-pump authorisation and two card holds
 *     uncleared   −$9,500.00   an ACH credit still inside its return window
 *     available   $3,890.00
 *     due         $4,000.00    refused, short by $110.00
 *
 * Every one of those figures is stored on the outcome row as observed at the
 * moment of the decision, so this fixture is shaped exactly like the live row
 * it stands in for.
 */

import { fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type {
  OccurrenceRow,
  ScheduleRow,
  StandingDataSource,
  StandingQuery,
  StandingView,
} from "./data-contract";
import type { DemoState } from "./view-state";

/**
 * The instant every fixture is read as-of.
 *
 * Fixed rather than `Date.now()`, so ages are reproducible, the screen is a
 * pure function of the URL, and the server render cannot disagree with the
 * client hydration.
 */
export const DEMO_NOW = "2026-09-10T13:20:00.000Z"; // 09:20 ET, after the nightly tick

export const DEMO_BOOK_DATE = "2026-09-10";

/** How long the `loading` state holds the skeleton open. Long enough to see. */
export const DEMO_LOADING_MS = 6_000;

const RENT_ID = "3f2a1c40-8b1e-4c77-9d02-6b5a1e4d0011";
const PAYROLL_ID = "3f2a1c40-8b1e-4c77-9d02-6b5a1e4d0022";
const LEASE_ID = "3f2a1c40-8b1e-4c77-9d02-6b5a1e4d0033";

const SCHEDULES: readonly ScheduleRow[] = [
  {
    id: RENT_ID,
    reference: "Rent — Unit 4, Ridgeline Works",
    accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    accountName: "Ridgeline Robotics, Inc. — business current account",
    businessName: "Ridgeline Robotics, Inc.",
    rail: "ach",
    amountCents: 400_000,
    currency: "USD",
    destination: "Cascade Property Partners LLC · ACH 021000021 ••4417 (checking)",
    cadence: "monthly",
    cadenceLabel: "Monthly on the 1st",
    startDate: "2026-07-01",
    endDate: null,
    mandateKey: "lease:CPP-2026-0417:rent",
    createdByName: "Priya Raman",
    createdAt: "2026-06-28T14:02:00.000Z",
    cancelled: false,
    cancelledAt: null,
    cancellationReason: null,
    nextDueDate: "2026-10-01",
  },
  {
    id: PAYROLL_ID,
    reference: "Contractor retainer — Vale Design",
    accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    accountName: "Ridgeline Robotics, Inc. — business current account",
    businessName: "Ridgeline Robotics, Inc.",
    rail: "ach",
    amountCents: 120_000,
    currency: "USD",
    destination: "Vale Design Studio · ACH 011401533 ••8830 (checking)",
    cadence: "weekly",
    cadenceLabel: "Weekly on Friday",
    startDate: "2026-08-07",
    endDate: null,
    mandateKey: "contract:VALE-2026-11:retainer",
    createdByName: "Priya Raman",
    createdAt: "2026-08-05T09:40:00.000Z",
    cancelled: false,
    cancelledAt: null,
    cancellationReason: null,
    nextDueDate: "2026-09-11",
  },
  {
    id: LEASE_ID,
    reference: "Equipment lease — Northgate",
    accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
    accountName: "Ridgeline Robotics, Inc. — business current account",
    businessName: "Ridgeline Robotics, Inc.",
    rail: "wire",
    amountCents: 250_000,
    currency: "USD",
    destination: "Northgate Equipment Finance · wire CHASUS33 ••9012",
    cadence: "monthly",
    cadenceLabel: "Monthly on the 31st, clamped to the last day of shorter months",
    startDate: "2026-01-31",
    endDate: "2026-08-31",
    mandateKey: "lease:NGE-88213:quarterly",
    createdByName: "Miles Ferrara",
    createdAt: "2026-01-28T16:15:00.000Z",
    cancelled: true,
    cancelledAt: "2026-08-14T18:30:00.000Z",
    cancellationReason: "Equipment returned; lease settled in full on 14 Aug.",
    nextDueDate: null,
  },
];

/** The edge row. Refused for available, on a day the ledger covered it. */
const EDGE: OccurrenceRow = {
  occurrenceId: "7c1d55e0-2b90-4a63-8f11-0d9c3e5a7001",
  standingOrderId: RENT_ID,
  reference: "Rent — Unit 4, Ridgeline Works",
  scheduledDate: "2026-09-01",
  idempotencyKey: `standing:${RENT_ID}:2026-09-01`,
  claimedAt: "2026-09-01T08:17:03.000Z",
  claimedBy: "standing-1756713423000-4a91c2",
  amountCents: 400_000,
  currency: "USD",
  rail: "ach",
  disposition: "refused",
  instructionId: null,
  refusalCode: "INSUFFICIENT_AVAILABLE_FUNDS",
  refusalReason:
    "Refused: the ledger balance covers this payment but the available balance does not. " +
    "The difference is money already committed to card authorisations or to credits that have " +
    "not cleared, and neither is spendable. This occurrence is closed; the next one is unaffected.",
  observedLedgerCents: 1_824_000,
  observedHoldsCents: 485_000,
  observedUnclearedCents: 950_000,
  observedAvailableCents: 389_000,
  shortfallCents: 11_000,
  ledgerWouldHaveCovered: true,
  decidedAt: "2026-09-01T08:17:03.000Z",
  decidedByRun: "standing-1756713423000-4a91c2",
};

const OCCURRENCES: readonly OccurrenceRow[] = [
  {
    occurrenceId: "7c1d55e0-2b90-4a63-8f11-0d9c3e5a7005",
    standingOrderId: PAYROLL_ID,
    reference: "Contractor retainer — Vale Design",
    scheduledDate: "2026-09-04",
    idempotencyKey: `standing:${PAYROLL_ID}:2026-09-04`,
    claimedAt: "2026-09-04T08:17:01.000Z",
    claimedBy: "standing-1757060221000-b3f7de",
    amountCents: 120_000,
    currency: "USD",
    rail: "ach",
    disposition: "raised",
    instructionId: "b81f0c92-77a4-4a1d-9c33-2ea5b0d61f44",
    refusalCode: null,
    refusalReason: null,
    observedLedgerCents: null,
    observedHoldsCents: null,
    observedUnclearedCents: null,
    observedAvailableCents: null,
    shortfallCents: null,
    ledgerWouldHaveCovered: false,
    decidedAt: "2026-09-04T08:17:01.000Z",
    decidedByRun: "standing-1757060221000-b3f7de",
  },
  EDGE,
  {
    occurrenceId: "7c1d55e0-2b90-4a63-8f11-0d9c3e5a7009",
    standingOrderId: PAYROLL_ID,
    reference: "Contractor retainer — Vale Design",
    scheduledDate: "2026-08-28",
    idempotencyKey: `standing:${PAYROLL_ID}:2026-08-28`,
    claimedAt: "2026-08-28T08:17:02.000Z",
    claimedBy: "standing-1756369022000-19cc4a",
    amountCents: 120_000,
    currency: "USD",
    rail: "ach",
    disposition: "raised",
    instructionId: "c04a7e11-3d5b-4a90-8e77-91b2f6c0aa31",
    refusalCode: null,
    refusalReason: null,
    observedLedgerCents: null,
    observedHoldsCents: null,
    observedUnclearedCents: null,
    observedAvailableCents: null,
    shortfallCents: null,
    ledgerWouldHaveCovered: false,
    decidedAt: "2026-08-28T08:17:02.000Z",
    decidedByRun: "standing-1756369022000-19cc4a",
  },
  {
    occurrenceId: "7c1d55e0-2b90-4a63-8f11-0d9c3e5a7011",
    standingOrderId: LEASE_ID,
    reference: "Equipment lease — Northgate",
    scheduledDate: "2026-07-31",
    idempotencyKey: `standing:${LEASE_ID}:2026-07-31`,
    claimedAt: "2026-07-31T08:17:00.000Z",
    claimedBy: "standing-1753950220000-77aa10",
    amountCents: 250_000,
    currency: "USD",
    rail: "wire",
    disposition: "raised",
    instructionId: "d17b3a55-9c02-4e88-b0f1-55a3e9d47c60",
    refusalCode: null,
    refusalReason: null,
    observedLedgerCents: null,
    observedHoldsCents: null,
    observedUnclearedCents: null,
    observedAvailableCents: null,
    shortfallCents: null,
    ledgerWouldHaveCovered: false,
    decidedAt: "2026-07-31T08:17:00.000Z",
    decidedByRun: "standing-1753950220000-77aa10",
  },
];

function view(overrides: Partial<StandingView> = {}): StandingView {
  return {
    source: "fixture",
    asOf: DEMO_NOW,
    bookDate: DEMO_BOOK_DATE,
    schedules: SCHEDULES,
    occurrences: OCCURRENCES,
    invariants: { unresolved: 0, doubleFires: 0 },
    selected: null,
    ...overrides,
  };
}

/**
 * The fixture data source for one demo state.
 *
 * `loading` genuinely waits, so the Suspense boundary on the page is real
 * rather than decorative: the skeleton that renders is the one a slow database
 * would produce.
 */
export function createFixtureStandingSource(state: DemoState): StandingDataSource {
  return {
    async load(query: StandingQuery): Promise<Result<StandingView, ErrorShape>> {
      if (state === "loading") {
        await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
        return ok(view());
      }

      if (state === "empty") {
        return ok(view({ schedules: [], occurrences: [] }));
      }

      if (state === "error") {
        return fail(
          "STANDING_READ_FAILED",
          "the standing-orders query failed: connection terminated unexpectedly",
        );
      }

      if (state === "edge") {
        // Only the refused occurrence, already drilled into, because the point
        // of the state is the four figures and not the list.
        return ok(view({ occurrences: [EDGE], selected: EDGE }));
      }

      const selected =
        query.occurrenceId === undefined
          ? null
          : (OCCURRENCES.find((row) => row.occurrenceId === query.occurrenceId) ?? null);

      return ok(
        view({
          selected,
          occurrences:
            query.standingOrderId === undefined
              ? OCCURRENCES
              : OCCURRENCES.filter((row) => row.standingOrderId === query.standingOrderId),
        }),
      );
    },
  };
}
