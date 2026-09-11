/**
 * THE MOMENTS ON THE BOOKING AXIS WORTH STANDING AT.
 *
 * ===========================================================================
 * WHY A CONTROL NEEDS THESE
 * ===========================================================================
 *
 * A slider over transaction time sounds like the feature and is not. The
 * booking axis of this book is nineteen hours long and almost all of it is
 * identical: nothing about a business day changes except at the instants
 * something was learned about it. A reader dragging uniformly across that axis
 * sees one number, then one number, then one number, and concludes the
 * parameter does nothing.
 *
 * What makes the two axes legible is landing on the instants that bracket a
 * single correction:
 *
 *     before    the original stands; we have not learned otherwise
 *     after     the act is complete and the day reads its corrected figure
 *
 * Hold `asOf` still, click those two, and the same business day prints two
 * different closing balances without one row having been edited. That is the
 * demonstration, and it is one query away, so the screen offers it rather than
 * asking a panel to type microseconds into a URL.
 *
 * ===========================================================================
 * AND A THIRD, WHICH IS THE TRAP ON A PLATE
 * ===========================================================================
 *
 * `midWrite` is the instant BETWEEN the reversal and the re-book. A reader
 * clicking it is asking for a state that never existed — the two entries were
 * written by one transaction (`./integrity.ts` has the `xmin` measurement) —
 * and the screen answers by SNAPPING the cut below the whole act and saying so.
 *
 * It is offered deliberately, and it is labelled for what it is. A guard
 * nobody can exercise is a guard nobody can check, and the fastest way to show
 * a panel that the trap is handled is to hand them the coordinate that springs
 * it.
 *
 * ===========================================================================
 * HOW THEY ARE FOUND
 * ===========================================================================
 *
 * One named reader. `listEntriesAboveWatermark` with `sinceWatermark = 0` and
 * an open value-date ceiling is "every entry that ever touched this account,
 * rolled up per entry, with its booking position and time" — which is exactly
 * the axis. Acts are the entries carrying a `correction_group_id`, grouped.
 *
 * No new SQL, and therefore no second opinion about what a correction is.
 */

import "server-only";

import {
  listEntriesAboveWatermark,
  listDepositAccounts,
  type LateEntry,
} from "@/lib/ledger/queries";
import type { Sql } from "@/lib/ledger/balance-definitions";

/** The value-date ceiling that means "no ceiling". The book's max is 2027. */
const ALL_VALUE_DATES = "9999-12-31";

export type LandmarkKind = "before" | "midWrite" | "after";

export interface Landmark {
  readonly kind: LandmarkKind;
  /** The instant to put in `?asKnownAt=`. */
  readonly at: string;
  readonly label: string;
  readonly note: string;
}

/** One correction act on one account, with the three places to stand. */
export interface CorrectionLandmark {
  readonly correctionGroupId: string;
  readonly accountId: string;
  /** The value date the act carries — what `?asOf=` should be pinned to. */
  readonly valueDate: string;
  /** Members in booking order. At least two, or the act is not a landmark. */
  readonly members: readonly LateEntry[];
  /** Net effect of the correcting members on this account. */
  readonly netCents: bigint;
  readonly landmarks: readonly Landmark[];
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/**
 * Build the instants around an act.
 *
 * ===========================================================================
 * MICROSECONDS, AND WHY EVERY LANDMARK IS OFFSET BY A MILLISECOND
 * ===========================================================================
 *
 * `booking_time` is a Postgres `timestamptz` with MICROSECOND precision. A JS
 * `Date` has milliseconds, so `bookingTime.getTime()` is the entry's real
 * stamp TRUNCATED — always at or below it, by up to 999µs.
 *
 * That asymmetry bites in one direction and it bit here. An `after` landmark
 * at the raw truncated stamp resolves to `booking_time <= floor(T)`, which
 * EXCLUDES the very entry it exists to include when T has any sub-millisecond
 * component — so "after it landed" rendered the state before it landed, and
 * the two readings of the day came back identical. Caught by the integration
 * suite against the live book, not by reasoning.
 *
 * So each landmark is offset one millisecond in the safe direction:
 *
 *   before    floor(first) − 1   strictly below the real first stamp
 *   midWrite  floor(first) + 1   strictly above the first, and below the last
 *                                (which is why a 2ms gap is required)
 *   after     floor(last) + 1    strictly above the real last stamp
 *
 * One millisecond is the finest a `Date` can express, and truncation is at
 * most 999µs, so each offset is guaranteed to land on the intended side.
 */
function landmarksFor(members: readonly LateEntry[]): readonly Landmark[] {
  const correcting = members.filter((member) => member.entryType !== "original");
  const first = correcting[0];
  const last = correcting[correcting.length - 1];
  if (first === undefined || last === undefined) return [];

  const firstMs = first.bookingTime.getTime();
  const lastMs = last.bookingTime.getTime();

  const out: Landmark[] = [
    {
      kind: "before",
      at: iso(firstMs - 1),
      label: "Before we learned",
      note: "One millisecond before the first correcting entry was booked. The original stands and nothing has contradicted it. A real, observable position: the correcting write had not started.",
    },
  ];

  if (correcting.length > 1 && lastMs - firstMs >= 2) {
    out.push({
      kind: "midWrite",
      at: iso(firstMs + 1),
      label: "Mid-write (springs the guard)",
      note: `Inside the atomic write that booked all ${String(correcting.length)} correcting entries. No reader ever saw this state — the transaction had not committed — so the cut is snapped below the whole act and the screen says so. The ${String(lastMs - firstMs)}ms gap is two clock_timestamp() calls, not a window of visibility.`,
    });
  }

  out.push({
    kind: "after",
    at: iso(lastMs + 1),
    label: "After it landed",
    note: "One millisecond past the last entry of the act — past it, because the stored stamp has microsecond precision this instant cannot express. The day now reads its corrected figure.",
  });

  return out;
}

/**
 * Every correction act that touched one account, newest first.
 *
 * `limit` bounds what the control renders, not what is read: the reader is one
 * query either way, and truncating in SQL would mean the newest act on a busy
 * account could be missed because the reader's own ordering is by booking
 * position rather than by act.
 */
export async function correctionLandmarks(
  args: { readonly accountId: string; readonly limit?: number },
  conn: Sql,
): Promise<readonly CorrectionLandmark[]> {
  const entries = await listEntriesAboveWatermark(
    {
      accountId: args.accountId,
      throughValueDate: ALL_VALUE_DATES,
      sinceWatermark: 0n,
    },
    conn,
  );

  const byGroup = new Map<string, LateEntry[]>();
  for (const entry of entries) {
    if (entry.correctionGroupId === null) continue;
    const bucket = byGroup.get(entry.correctionGroupId);
    if (bucket === undefined) byGroup.set(entry.correctionGroupId, [entry]);
    else bucket.push(entry);
  }

  const acts: CorrectionLandmark[] = [];
  for (const [groupId, members] of byGroup) {
    members.sort((a, b) => (a.bookingSeq < b.bookingSeq ? -1 : 1));

    // A group with no CORRECTING member on this account is a correction that
    // moved money somewhere else — a reversal whose counterpart is a house
    // account, say. There is no "before and after" to stand between on this
    // account, so it is not a landmark here.
    if (members.every((member) => member.entryType === "original")) continue;

    let netCents = 0n;
    for (const member of members) {
      if (member.entryType !== "original") netCents += member.signedCents;
    }

    const valueDate = members[0]?.valueDate ?? "";

    acts.push({
      correctionGroupId: groupId,
      accountId: args.accountId,
      valueDate,
      members,
      netCents,
      landmarks: landmarksFor(members),
    });
  }

  acts.sort((a, b) => {
    const left = a.members[a.members.length - 1]?.bookingSeq ?? 0n;
    const right = b.members[b.members.length - 1]?.bookingSeq ?? 0n;
    return left < right ? 1 : left > right ? -1 : 0;
  });

  const limit = args.limit ?? 6;
  return acts.slice(0, limit);
}

/**
 * The best demonstration on the whole book: the most recently completed
 * correction act on any customer deposit account.
 *
 * What `?state=edge` resolves to on `/transactions`. It is LIVE on purpose —
 * the edge case IS the corrected day, and a corrected day rendered from
 * typed-in numbers would be the one thing on that screen worth nothing. When
 * the book has no completed act it returns `null` and the screen says so,
 * rather than inventing one.
 */
export async function bestDemonstration(
  conn: Sql,
): Promise<CorrectionLandmark | null> {
  const accounts = await listDepositAccounts(conn);

  let best: CorrectionLandmark | null = null;
  let bestSeq = -1n;

  for (const account of accounts) {
    const acts = await correctionLandmarks({ accountId: account.accountId, limit: 1 }, conn);
    const act = acts[0];
    if (act === undefined) continue;

    const seq = act.members[act.members.length - 1]?.bookingSeq ?? 0n;
    if (seq > bestSeq) {
      bestSeq = seq;
      best = act;
    }
  }

  return best;
}
