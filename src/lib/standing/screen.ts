import "server-only";

import { describeDestination } from "@/lib/approvals/types";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";
import type {
  OccurrenceRow,
  ScheduleRow,
  StandingQuery,
  StandingView,
} from "@/components/standing/data-contract";

import {
  bookToday,
  countDoubleFires,
  countUnresolved,
  listOccurrences,
  listStandingOrders,
} from "./store";
import { INSUFFICIENT_FUNDS_CODE, type StandingOrder, type StandingOrderOccurrence } from "./types";

/**
 * The live implementation of the standing-orders screen's data contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCREEN SHOWS
 * ---------------------------------------------------------------------------
 *
 * Three things, and the third is the one that matters:
 *
 *   the mandates        what is authorised, and when it next comes round
 *   the history         every occurrence, decided or not, newest first
 *   the invariants      claimed-and-undecided, and double fires
 *
 * The history is the requirement's own answer to its own question. "It never
 * fired and nobody knows why" is a missing row; an occurrence that was refused
 * is a PRESENT row carrying a code, a sentence, and the four figures the
 * decision was made against. Nobody has to notice an absence.
 *
 * ---------------------------------------------------------------------------
 * `bigint` NARROWS HERE, ONCE
 * ---------------------------------------------------------------------------
 *
 * Everything in `src/lib/standing/**` is `bigint` cents. The contract is
 * `number` cents, because these values cross to the client and `bigint` does
 * not survive JSON. `toCents` is the single conversion site and it refuses
 * rather than silently rounds: an amount past 2^53 is a bug worth crashing on,
 * not a number to approximate in front of an operator.
 */

/** The one bigint -> number narrowing in the read path. Refuses, never rounds. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} cents is past Number.MAX_SAFE_INTEGER; widen Cents to bigint before rendering it`,
    );
  }
  return Number(value);
}

function toCentsOrNull(value: bigint | null): number | null {
  return value === null ? null : toCents(value);
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function ordinal(day: number): string {
  const rem100 = day % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/**
 * The cadence in English, including the clamp.
 *
 * A mandate for the 31st is due on 30 April and on 28 February — never skipped
 * — and that rule lives in `standing_order_due_dates()` in SQL, not here. This
 * function only SAYS so, because an operator reading "monthly on the 31st"
 * will otherwise wonder what happens in February and go looking.
 */
function cadenceLabel(order: StandingOrder): string {
  switch (order.cadence) {
    case "daily":
      return "Every day";
    case "weekly":
      return `Weekly on ${WEEKDAYS[order.dayOfWeek ?? 0] ?? "Sunday"}`;
    case "monthly": {
      const day = order.dayOfMonth ?? 1;
      const clamp = day > 28 ? ", clamped to the last day of shorter months" : "";
      return `Monthly on the ${ordinal(day)}${clamp}`;
    }
  }
}

function toScheduleRow(order: StandingOrder): ScheduleRow {
  return {
    id: order.id,
    reference: order.reference,
    accountId: order.accountId,
    accountName: order.accountName,
    businessName: order.businessName,
    rail: order.rail,
    amountCents: toCents(order.amountCents),
    currency: order.currency,
    destination:
      order.destination === null
        ? "Unrecognised destination — this mandate will refuse rather than pay"
        : describeDestination(order.destination),
    cadence: order.cadence,
    cadenceLabel: cadenceLabel(order),
    startDate: order.startDate,
    endDate: order.endDate,
    mandateKey: order.mandateKey,
    createdByName: order.createdByName,
    createdAt: order.createdAt,
    cancelled: order.cancelled,
    cancelledAt: order.cancelledAt,
    cancellationReason: order.cancellationReason,
    nextDueDate: order.nextDueDate,
  };
}

function toOccurrenceRow(occurrence: StandingOrderOccurrence): OccurrenceRow {
  const ledger = occurrence.observedLedgerCents;
  return {
    occurrenceId: occurrence.occurrenceId,
    standingOrderId: occurrence.standingOrderId,
    reference: occurrence.reference,
    scheduledDate: occurrence.scheduledDate,
    idempotencyKey: occurrence.idempotencyKey,
    claimedAt: occurrence.claimedAt,
    claimedBy: occurrence.claimedBy,
    amountCents: toCents(occurrence.amountCents),
    currency: occurrence.currency,
    rail: occurrence.rail,
    disposition: occurrence.disposition,
    instructionId: occurrence.instructionId,
    refusalCode: occurrence.refusalCode,
    refusalReason: occurrence.refusalReason,
    observedLedgerCents: toCentsOrNull(occurrence.observedLedgerCents),
    observedHoldsCents: toCentsOrNull(occurrence.observedHoldsCents),
    observedUnclearedCents: toCentsOrNull(occurrence.observedUnclearedCents),
    observedAvailableCents: toCentsOrNull(occurrence.observedAvailableCents),
    shortfallCents: toCentsOrNull(occurrence.shortfallCents),
    // Derived from the AS-OBSERVED figures on the row, never from today's
    // balance. The question is "was the ledger enough at the moment we
    // refused", and re-deriving it tomorrow answers a different one.
    ledgerWouldHaveCovered:
      occurrence.refusalCode === INSUFFICIENT_FUNDS_CODE &&
      ledger !== null &&
      ledger >= occurrence.amountCents,
    decidedAt: occurrence.decidedAt,
    decidedByRun: occurrence.decidedByRun,
  };
}

/**
 * Load the screen.
 *
 * One entry point, so the mandates, the history and the invariants are
 * consistent as of one read rather than three that could interleave with a
 * concurrent tick of the firing routine.
 */
export async function loadStandingView(
  query: StandingQuery = {},
): Promise<Result<StandingView, ErrorShape>> {
  try {
    const asOf = new Date().toISOString();

    const [bookDate, orders, occurrences, unresolved, doubleFires] = await Promise.all([
      bookToday(),
      listStandingOrders(50),
      listOccurrences(200),
      countUnresolved(),
      countDoubleFires(),
    ]);

    const schedules = orders.map(toScheduleRow);
    const allRows = occurrences.map(toOccurrenceRow);

    // Filtered here rather than in SQL: the whole history is tens of rows, and
    // a filtered query would make the tiles disagree with the table because
    // the tiles have to count what the filter is hiding.
    const rows =
      query.standingOrderId === undefined
        ? allRows
        : allRows.filter((row) => row.standingOrderId === query.standingOrderId);

    const selected =
      query.occurrenceId === undefined
        ? null
        : (allRows.find((row) => row.occurrenceId === query.occurrenceId) ?? null);

    return ok({
      source: "live",
      asOf,
      bookDate,
      schedules,
      occurrences: rows,
      invariants: { unresolved, doubleFires },
      selected,
    });
  } catch (thrown) {
    // A read failure is a VALUE here, so the screen's error state is a branch
    // and not a boundary. Nothing moved: this screen only reads, and the
    // firing routine is a cron and a POST, never a render.
    return fail(
      "STANDING_READ_FAILED",
      thrown instanceof Error ? thrown.message : "the standing-orders query failed",
    );
  }
}

/**
 * Whether a database is configured at all.
 *
 * Used by the page to choose between the live source and the fixture, and to
 * label which one the operator is looking at. Reads the raw env rather than
 * `src/lib/env.ts`, because that module throws on a missing key at import time
 * and "no database configured" must be a renderable state, not a crash.
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.trim() !== "";
}
