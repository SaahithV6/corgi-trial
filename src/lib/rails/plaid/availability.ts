/**
 * When does an inbound credit become spendable.
 *
 * ---------------------------------------------------------------------------
 * The claim this module makes, and why it is the interesting half of funding
 * ---------------------------------------------------------------------------
 *
 * Moving the balance is arithmetic. Deciding when the customer may SPEND the
 * balance is a risk position, and it is the one an inbound-credit path is
 * actually judged on: an ACH credit can be returned after it lands, so a
 * neobank that raises available at the same instant it raises ledger has lent
 * the customer money against an entry that can still come back. `../types.ts`
 * states it as an invariant of the whole rail interface — "THE RETURN WINDOW
 * OUTLIVES SETTLEMENT ... a balance is not spendable the moment it settles".
 *
 * ---------------------------------------------------------------------------
 * The policy is DATA. This module is the arithmetic and nothing else.
 * ---------------------------------------------------------------------------
 *
 * `funds_availability_policy` (migration 0001 §5) is append-only and
 * effective-dated, keyed `(rail, counterparty_class, effective_from)`, and
 * every `uncleared_credit` hold stores the `policy_id` it was created under.
 * That is what makes a hold opened in March still explainable in December
 * after the policy changed — the hold cites a row, and the row is still there.
 *
 * So nothing in this file decides how long to hold anything. It takes
 * `banking_days_hold` and `release_local_time` off a row and answers "which
 * instant is that". The seeded rows for ACH, from `research/ledger/DESIGN.md`
 * §10.1:
 *
 *   ach / self    1 banking day, 09:00 ET  — the customer's own verified
 *                                            external account. Still a hold,
 *                                            because a customer can overdraw
 *                                            their own outside bank as easily
 *                                            as anyone else can.
 *   ach / known   1 banking day, 09:00 ET  — seen >= 3 times over >= 60 days.
 *   ach / new     2 banking days, 09:00 ET — covers the unauthorised-return
 *                                            window for corporate CCD/CTX.
 *
 * ---------------------------------------------------------------------------
 * Banking days, not calendar days, and the two rules everyone gets wrong
 * ---------------------------------------------------------------------------
 *
 * 1. THE FEDERAL RESERVE'S SATURDAY RULE IS NOT THE FEDERAL GOVERNMENT'S.
 *    When a fixed-date holiday falls on a SATURDAY the Fed is OPEN on the
 *    preceding Friday — federal offices close, the Fed does not, and ACH
 *    settles. When it falls on a SUNDAY the Fed is closed the following
 *    Monday. Applying the federal-office rule shortens a hold by a day
 *    roughly twice a year, always in the direction of releasing money early.
 *
 * 2. THE CLOCK IS THE BANK'S, NOT THE SERVER'S. "09:00" is 09:00 in
 *    America/New_York — 13:00Z in summer and 14:00Z in winter. A release
 *    computed in UTC is an hour wrong for five months of the year, which on
 *    the 09:00 boundary means the money is spendable an hour before the policy
 *    says it is.
 *
 * Pure functions only: no `postgres`, no `process`, no `Date.now()` that is not
 * passed in. Everything here is testable without a database and is tested in
 * `./availability.test.ts`.
 */

import { BANKING_TIME_ZONE } from '@/lib/format/datetime';

/** `YYYY-MM-DD` in book time. A calendar date, never an instant. */
export type ValueDate = string;

/**
 * The `funds_availability_policy` columns this module needs, and no others.
 * A structural type rather than an import, so the arithmetic can be tested
 * against a literal and the module never reaches for a connection.
 */
export interface AvailabilityPolicy {
  readonly id: string;
  readonly rail: string;
  readonly counterpartyClass: string;
  readonly bankingDaysHold: number;
  /** `HH:MM:SS` in `BANKING_TIME_ZONE`. */
  readonly releaseLocalTime: string;
  readonly note: string;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ONLY = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/* -------------------------------------------------------------------------- */
/* Calendar arithmetic on `YYYY-MM-DD`, with no timezone anywhere near it     */
/* -------------------------------------------------------------------------- */

export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * `YYYY-MM-DD` -> its three fields.
 *
 * Sliced rather than read out of the regex's capture groups, because under
 * `noUncheckedIndexedAccess` every group is `string | undefined` and the two
 * ways out of that are a non-null assertion or a `?? ''` that turns a
 * malformed date into the year zero. Slicing a string that has already matched
 * a fully anchored pattern needs neither.
 *
 * The round-trip check at the end rejects `2026-02-30`, which the pattern
 * happily accepts and which `Date.UTC` would silently roll into March.
 */
export function parseValueDate(date: ValueDate): CivilDate {
  if (!DATE_ONLY.test(date)) throw new TypeError(`not a YYYY-MM-DD value date: ${date}`);
  const civil = {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
  if (formatValueDate(fromEpochDay(toEpochDay(civil))) !== date) {
    throw new TypeError(`not a real calendar date: ${date}`);
  }
  return civil;
}

function toEpochDay(date: CivilDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

function fromEpochDay(epochDay: number): CivilDate {
  const at = new Date(epochDay * 86_400_000);
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

export function formatValueDate(date: CivilDate): ValueDate {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

/** 0 = Sunday … 6 = Saturday. Computed in UTC, which for a bare date is exact. */
function dayOfWeek(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** The `n`th `weekday` of a month, e.g. the 3rd Monday of January. */
function nthWeekdayOf(year: number, month: number, weekday: number, n: number): CivilDate {
  const first = { year, month, day: 1 };
  const shift = (weekday - dayOfWeek(first) + 7) % 7;
  return { year, month, day: 1 + shift + (n - 1) * 7 };
}

/** The last `weekday` of a month, e.g. the last Monday of May. */
function lastWeekdayOf(year: number, month: number, weekday: number): CivilDate {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = { year, month, day: daysInMonth };
  const shift = (dayOfWeek(last) - weekday + 7) % 7;
  return { year, month, day: daysInMonth - shift };
}

/**
 * A fixed-date holiday, moved to its OBSERVED day under the Federal Reserve's
 * rule — Sunday shifts forward to Monday, Saturday does NOT shift back.
 *
 * This is rule 1 from the header, in three lines, and it is the only place the
 * distinction lives.
 */
function observedFixed(year: number, month: number, day: number): CivilDate | null {
  const date = { year, month, day };
  const dow = dayOfWeek(date);
  if (dow === 0) return fromEpochDay(toEpochDay(date) + 1); // Sunday -> Monday
  if (dow === 6) return null; // Saturday -> the Fed stays open. Not a holiday.
  return date;
}

/**
 * The eleven Federal Reserve Bank holidays for a year, as `YYYY-MM-DD`.
 *
 * Source: the Federal Reserve Board's published Bank Holiday schedule. Fed
 * banks are closed on these days, so ACH does not settle and they are not
 * banking days.
 */
export function federalReserveHolidays(year: number): ReadonlySet<ValueDate> {
  const dates: (CivilDate | null)[] = [
    observedFixed(year, 1, 1), //                          New Year's Day
    nthWeekdayOf(year, 1, 1, 3), //                        Martin Luther King, Jr. Day
    nthWeekdayOf(year, 2, 1, 3), //                        Washington's Birthday
    lastWeekdayOf(year, 5, 1), //                          Memorial Day
    observedFixed(year, 6, 19), //                         Juneteenth
    observedFixed(year, 7, 4), //                          Independence Day
    nthWeekdayOf(year, 9, 1, 1), //                        Labor Day
    nthWeekdayOf(year, 10, 1, 2), //                       Columbus Day
    observedFixed(year, 11, 11), //                        Veterans Day
    nthWeekdayOf(year, 11, 4, 4), //                       Thanksgiving Day
    observedFixed(year, 12, 25), //                        Christmas Day
  ];
  const out = new Set<ValueDate>();
  for (const date of dates) {
    if (date !== null) out.add(formatValueDate(date));
  }
  return out;
}

/** Monday to Friday, and not a Federal Reserve holiday. */
export function isBankingDay(date: ValueDate): boolean {
  const civil = parseValueDate(date);
  const dow = dayOfWeek(civil);
  if (dow === 0 || dow === 6) return false;
  return !federalReserveHolidays(civil.year).has(date);
}

/**
 * Advance `count` banking days from `date`.
 *
 * `count === 0` returns `date` UNCHANGED, even when `date` is a Saturday. That
 * is deliberate and it is the conservative direction: a zero-day policy (wire,
 * internal, card refund) means "available immediately", and rolling a Saturday
 * forward to Monday would withhold money the policy says is not withheld.
 * Every non-zero count lands on a banking day by construction.
 */
export function addBankingDays(date: ValueDate, count: number): ValueDate {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`banking-day count must be a non-negative integer, got ${count}`);
  }
  if (count === 0) return date;

  let epochDay = toEpochDay(parseValueDate(date));
  let remaining = count;
  while (remaining > 0) {
    epochDay += 1;
    if (isBankingDay(formatValueDate(fromEpochDay(epochDay)))) remaining -= 1;
  }
  return formatValueDate(fromEpochDay(epochDay));
}

/* -------------------------------------------------------------------------- */
/* The banking clock                                                          */
/* -------------------------------------------------------------------------- */

const zoneParts = new Intl.DateTimeFormat('en-US', {
  timeZone: BANKING_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Milliseconds the banking zone is ahead of UTC at `at`. Negative for ET. */
function zoneOffsetMs(at: Date): number {
  const parts = zoneParts.formatToParts(at);
  const read = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? '0');
  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
  return asIfUtc - at.getTime();
}

/**
 * `2026-09-11` + `09:00:00` in America/New_York -> the UTC instant.
 *
 * Two passes, because the offset depends on the instant we are trying to
 * compute. The first pass guesses with the offset at the naive instant and the
 * second corrects it if the guess landed on the other side of a DST boundary.
 * 09:00 is never inside a transition gap — US transitions happen at 02:00 —
 * so two passes converge exactly, and this is not the general-purpose case
 * that would need a third.
 */
export function bankingInstant(date: ValueDate, localTime: string): Date {
  const civil = parseValueDate(date);
  if (!TIME_ONLY.test(localTime)) {
    throw new TypeError(`not an HH:MM[:SS] local time: ${localTime}`);
  }

  const naive = Date.UTC(
    civil.year,
    civil.month - 1,
    civil.day,
    Number(localTime.slice(0, 2)),
    Number(localTime.slice(3, 5)),
    localTime.length >= 8 ? Number(localTime.slice(6, 8)) : 0,
  );

  const firstGuess = naive - zoneOffsetMs(new Date(naive));
  const corrected = naive - zoneOffsetMs(new Date(firstGuess));
  return new Date(corrected);
}

/* -------------------------------------------------------------------------- */
/* The answer                                                                 */
/* -------------------------------------------------------------------------- */

export interface AvailabilitySchedule {
  /** The policy row this schedule was computed from. Persisted on the hold. */
  readonly policyId: string;
  /** The credit's value date — the day the money belongs to. */
  readonly valueDate: ValueDate;
  /** The banking day the hold releases on. */
  readonly releaseDate: ValueDate;
  /** The instant `available_at` is set to. */
  readonly availableAt: Date;
  readonly bankingDaysHold: number;
  readonly releaseLocalTime: string;
  /**
   * Calendar days between value date and release date. Shown next to the
   * banking-day count because a 1-banking-day hold over a long weekend is four
   * calendar days, and a customer who is told "one day" and waits four has been
   * misled by a true statement.
   */
  readonly calendarDaysHeld: number;
  /** The banking days that were skipped, so the screen can say WHY it is four. */
  readonly skipped: readonly SkippedDay[];
}

export interface SkippedDay {
  readonly date: ValueDate;
  readonly reason: 'weekend' | 'federal_reserve_holiday';
}

/**
 * Turn a policy row and a value date into the moment the money is spendable,
 * with the working shown.
 *
 * The `skipped` list is not decoration. "Available Tuesday" is an answer;
 * "available Tuesday, because Saturday and Sunday are not banking days and
 * Monday is Labor Day" is an answer an operator can check, and checking it is
 * the only way anyone ever notices that the holiday table is wrong.
 */
export function scheduleAvailability(
  policy: AvailabilityPolicy,
  valueDate: ValueDate,
): AvailabilitySchedule {
  const releaseDate = addBankingDays(valueDate, policy.bankingDaysHold);

  const skipped: SkippedDay[] = [];
  const start = toEpochDay(parseValueDate(valueDate));
  const end = toEpochDay(parseValueDate(releaseDate));
  for (let day = start + 1; day < end; day += 1) {
    const date = formatValueDate(fromEpochDay(day));
    if (isBankingDay(date)) continue;
    const dow = dayOfWeek(parseValueDate(date));
    skipped.push({
      date,
      reason: dow === 0 || dow === 6 ? 'weekend' : 'federal_reserve_holiday',
    });
  }

  return {
    policyId: policy.id,
    valueDate,
    releaseDate,
    availableAt: bankingInstant(releaseDate, policy.releaseLocalTime),
    bankingDaysHold: policy.bankingDaysHold,
    releaseLocalTime: policy.releaseLocalTime,
    calendarDaysHeld: end - start,
    skipped,
  };
}

/** One sentence a person can read on a receipt. Never invents a number. */
export function describeSchedule(schedule: AvailabilitySchedule): string {
  const days = schedule.bankingDaysHold;
  if (days === 0) {
    return `Available immediately: the policy holds this rail for zero banking days.`;
  }
  const unit = days === 1 ? 'banking day' : 'banking days';
  const calendar =
    schedule.calendarDaysHeld === days
      ? ''
      : ` — ${schedule.calendarDaysHeld} calendar days, because ${schedule.skipped
          .map((s) =>
            s.reason === 'weekend'
              ? `${s.date} is a weekend`
              : `${s.date} is a Federal Reserve holiday`,
          )
          .join(' and ')}`;
  return `Held ${days} ${unit} from a value date of ${schedule.valueDate}, releasing ${schedule.releaseDate} at ${schedule.releaseLocalTime} ET${calendar}.`;
}
