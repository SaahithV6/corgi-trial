/**
 * Tests for the availability arithmetic.
 *
 * NO NETWORK AND NO DATABASE. Everything in `./availability.ts` is a pure
 * function over a policy row and a `YYYY-MM-DD`, which is the whole reason the
 * policy is passed in as a structural type rather than read from a connection:
 * the decision that money is not spendable yet is the one decision on this path
 * that must be checkable without arranging a bank.
 *
 * The three that matter most, because each one is a way to release money EARLY:
 *
 *   - the Federal Reserve's Saturday rule (a fixed holiday on a Saturday is
 *     NOT observed on the Friday, unlike a federal office closure)
 *   - the release instant is 09:00 in New York, not 09:00Z
 *   - a zero-day policy does not roll a weekend forward
 */

import { describe, expect, it } from 'vitest';

import {
  addBankingDays,
  bankingInstant,
  describeSchedule,
  federalReserveHolidays,
  formatValueDate,
  isBankingDay,
  parseValueDate,
  scheduleAvailability,
  type AvailabilityPolicy,
} from './availability';

/** The seeded `ach`/`self` row, as `scripts/seed.mjs` writes it. */
const ACH_SELF: AvailabilityPolicy = {
  id: 'c2ada775-2384-54a8-9f9a-5efdd64f4390',
  rail: 'ach',
  counterpartyClass: 'self',
  bankingDaysHold: 1,
  releaseLocalTime: '09:00:00',
  note: "An ACH pull from the customer's own verified external account.",
};

const ACH_NEW: AvailabilityPolicy = {
  ...ACH_SELF,
  id: '3bae7e8b-ed81-5a50-9ea7-cd22c88e0ccd',
  counterpartyClass: 'new',
  bankingDaysHold: 2,
};

const IMMEDIATE: AvailabilityPolicy = {
  ...ACH_SELF,
  id: '50492935-f73e-586b-a55b-00b21ec13522',
  rail: 'wire',
  counterpartyClass: 'n/a',
  bankingDaysHold: 0,
};

// ---------------------------------------------------------------------------
// value dates
// ---------------------------------------------------------------------------

describe('parseValueDate', () => {
  it('reads a real date', () => {
    expect(parseValueDate('2026-09-10')).toEqual({ year: 2026, month: 9, day: 10 });
  });

  it('refuses a date the pattern accepts and the calendar does not', () => {
    // `Date.UTC` would roll this into 2 March without complaining, and a hold
    // released on the wrong day is not something anybody notices.
    expect(() => parseValueDate('2026-02-30')).toThrow(/not a real calendar date/);
  });

  it('refuses anything that is not YYYY-MM-DD', () => {
    expect(() => parseValueDate('10/09/2026')).toThrow(/not a YYYY-MM-DD/);
    expect(() => parseValueDate('2026-09-10T00:00:00Z')).toThrow(/not a YYYY-MM-DD/);
  });

  it('round-trips through formatValueDate', () => {
    expect(formatValueDate(parseValueDate('2026-01-01'))).toBe('2026-01-01');
  });
});

// ---------------------------------------------------------------------------
// the Federal Reserve calendar
// ---------------------------------------------------------------------------

describe('federalReserveHolidays', () => {
  it('lists the Bank Holidays the Fed actually closes for', () => {
    // TEN, not eleven, and the missing one is the point of the next test:
    // Independence Day 2026 is a Saturday, so the Federal Reserve never closes
    // for it at all. A calendar that reported eleven here would be one that had
    // observed it on the Friday.
    const holidays = federalReserveHolidays(2026);
    expect(holidays.size).toBe(10);
    for (const date of [
      '2026-01-01', // New Year's Day, a Thursday
      '2026-01-19', // MLK, 3rd Monday
      '2026-02-16', // Washington's Birthday, 3rd Monday
      '2026-05-25', // Memorial Day, last Monday
      '2026-06-19', // Juneteenth, a Friday
      '2026-09-07', // Labor Day
      '2026-10-12', // Columbus Day
      '2026-11-11', // Veterans Day, a Wednesday
      '2026-11-26', // Thanksgiving, 4th Thursday
      '2026-12-25', // Christmas, a Friday
    ]) {
      expect(holidays.has(date)).toBe(true);
    }
  });

  it('lists eleven in a year where no fixed holiday falls on a Saturday', () => {
    // 2028: New Year's Day is a Saturday... so take 2025, where every fixed
    // holiday lands on a weekday or a Sunday and all eleven are observed.
    expect(federalReserveHolidays(2025).size).toBe(11);
  });

  it('does NOT observe a Saturday holiday on the preceding Friday — the Fed is open', () => {
    // 4 July 2026 is a Saturday. Federal offices close on Friday 3 July; the
    // Federal Reserve does not, and ACH settles. Applying the federal-office
    // rule here would shorten every hold spanning that weekend by a day, in the
    // direction of releasing money before the return window closes.
    const holidays = federalReserveHolidays(2026);
    expect(holidays.has('2026-07-03')).toBe(false);
    expect(holidays.has('2026-07-04')).toBe(false);
    expect(isBankingDay('2026-07-03')).toBe(true);
  });

  it('observes a Sunday holiday on the following Monday', () => {
    // 4 July 2027 is a Sunday, so the Fed closes Monday 5 July.
    expect(federalReserveHolidays(2027).has('2027-07-05')).toBe(true);
    expect(isBankingDay('2027-07-05')).toBe(false);
  });
});

describe('isBankingDay', () => {
  it('is false at weekends', () => {
    expect(isBankingDay('2026-09-12')).toBe(false); // Saturday
    expect(isBankingDay('2026-09-13')).toBe(false); // Sunday
  });

  it('is true on an ordinary weekday', () => {
    expect(isBankingDay('2026-09-10')).toBe(true); // Thursday
  });

  it('is false on Labor Day', () => {
    expect(isBankingDay('2026-09-07')).toBe(false);
  });
});

describe('addBankingDays', () => {
  it('advances one banking day', () => {
    expect(addBankingDays('2026-09-10', 1)).toBe('2026-09-11');
  });

  it('skips the weekend', () => {
    // Friday + 1 banking day is Monday, not Saturday.
    expect(addBankingDays('2026-09-11', 1)).toBe('2026-09-14');
  });

  it('skips a holiday as well as the weekend', () => {
    // Friday 4 September + 1 -> Monday 7 September is Labor Day -> Tuesday.
    expect(addBankingDays('2026-09-04', 1)).toBe('2026-09-08');
  });

  it('returns the date UNCHANGED for a zero-day policy, even on a Saturday', () => {
    // "Available immediately" must not be quietly turned into "available
    // Monday" by a rolling rule that only exists for non-zero counts.
    expect(addBankingDays('2026-09-12', 0)).toBe('2026-09-12');
  });

  it('refuses a negative or fractional count', () => {
    expect(() => addBankingDays('2026-09-10', -1)).toThrow(RangeError);
    expect(() => addBankingDays('2026-09-10', 1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// the banking clock
// ---------------------------------------------------------------------------

describe('bankingInstant', () => {
  it('reads 09:00 as New York time in summer (EDT, UTC-4)', () => {
    expect(bankingInstant('2026-09-11', '09:00:00').toISOString()).toBe(
      '2026-09-11T13:00:00.000Z',
    );
  });

  it('reads 09:00 as New York time in winter (EST, UTC-5)', () => {
    expect(bankingInstant('2026-01-15', '09:00:00').toISOString()).toBe(
      '2026-01-15T14:00:00.000Z',
    );
  });

  it('lands on the correct side of the spring DST boundary', () => {
    // US DST begins 08 March 2026 at 02:00. 09:00 that morning is EDT.
    expect(bankingInstant('2026-03-08', '09:00:00').toISOString()).toBe(
      '2026-03-08T13:00:00.000Z',
    );
    // The day before is still EST.
    expect(bankingInstant('2026-03-07', '09:00:00').toISOString()).toBe(
      '2026-03-07T14:00:00.000Z',
    );
  });

  it('accepts HH:MM as well as HH:MM:SS', () => {
    expect(bankingInstant('2026-09-11', '09:00').toISOString()).toBe(
      '2026-09-11T13:00:00.000Z',
    );
  });

  it('refuses a time that is not HH:MM[:SS]', () => {
    expect(() => bankingInstant('2026-09-11', '9am')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// the answer
// ---------------------------------------------------------------------------

describe('scheduleAvailability', () => {
  it('holds an ACH self-funding credit to the next banking morning', () => {
    const schedule = scheduleAvailability(ACH_SELF, '2026-09-10');
    expect(schedule.releaseDate).toBe('2026-09-11');
    expect(schedule.availableAt.toISOString()).toBe('2026-09-11T13:00:00.000Z');
    expect(schedule.calendarDaysHeld).toBe(1);
    expect(schedule.skipped).toEqual([]);
    // The hold cites the row it was computed from, for ever.
    expect(schedule.policyId).toBe(ACH_SELF.id);
  });

  it('reports the weekend it skipped, so "one banking day" can be read as three', () => {
    // Friday value date, one banking day: releases Monday, three calendar days
    // later. A customer told "one day" who waits three has been misled by a
    // true statement, which is what `skipped` exists to prevent.
    const schedule = scheduleAvailability(ACH_SELF, '2026-09-11');
    expect(schedule.releaseDate).toBe('2026-09-14');
    expect(schedule.calendarDaysHeld).toBe(3);
    expect(schedule.skipped).toEqual([
      { date: '2026-09-12', reason: 'weekend' },
      { date: '2026-09-13', reason: 'weekend' },
    ]);
  });

  it('names a Federal Reserve holiday as the reason, not just "weekend"', () => {
    // Thursday 3 September + 2 banking days: Friday is one, Monday is Labor
    // Day, so the second is Tuesday 8 September.
    const schedule = scheduleAvailability(ACH_NEW, '2026-09-03');
    expect(schedule.releaseDate).toBe('2026-09-08');
    expect(schedule.skipped).toEqual([
      { date: '2026-09-05', reason: 'weekend' },
      { date: '2026-09-06', reason: 'weekend' },
      { date: '2026-09-07', reason: 'federal_reserve_holiday' },
    ]);
  });

  it('releases a zero-day policy on the value date itself', () => {
    const schedule = scheduleAvailability(IMMEDIATE, '2026-09-12');
    expect(schedule.releaseDate).toBe('2026-09-12');
    expect(schedule.calendarDaysHeld).toBe(0);
  });
});

describe('describeSchedule', () => {
  it('says "banking day" singular and prints the release date and time', () => {
    const text = describeSchedule(scheduleAvailability(ACH_SELF, '2026-09-10'));
    expect(text).toContain('Held 1 banking day');
    expect(text).toContain('releasing 2026-09-11 at 09:00:00 ET');
    // No calendar clause when the two counts agree.
    expect(text).not.toContain('calendar days');
  });

  it('explains the gap when calendar days and banking days disagree', () => {
    const text = describeSchedule(scheduleAvailability(ACH_SELF, '2026-09-11'));
    expect(text).toContain('3 calendar days');
    expect(text).toContain('2026-09-12 is a weekend');
  });

  it('says so plainly when nothing is held', () => {
    expect(describeSchedule(scheduleAvailability(IMMEDIATE, '2026-09-12'))).toContain(
      'Available immediately',
    );
  });
});
