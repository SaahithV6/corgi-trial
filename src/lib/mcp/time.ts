/**
 * Book-time dates for the agent surface.
 *
 * Everything money-shaped in this system dates in America/New_York, because
 * that is the business day the ledger closes on. A tool that computed "today"
 * from the server's UTC clock would answer a question about Tuesday with
 * Wednesday's data for the five hours after 19:00 ET, every day, silently.
 *
 * `Intl.DateTimeFormat` with an explicit `timeZone` and `en-CA` (which formats
 * as YYYY-MM-DD) is used rather than arithmetic on epoch offsets: DST is a
 * table, not a formula, and Node already ships the table.
 */

import { BANKING_TIME_ZONE } from "@/lib/format/datetime";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const bookDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: BANKING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The business date, in book time, as YYYY-MM-DD. */
export function bookDate(at: Date): string {
  return bookDateFormat.format(at);
}

export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // Rejects 2026-02-30, which the regex happily accepts.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Whole days from `from` to `to`, both YYYY-MM-DD, never negative.
 *
 * Computed at UTC midnight on both ends so a DST transition between them
 * cannot produce 0.958 days and round to zero — the age of a reconciliation
 * break is read by a human deciding whether to escalate, and being a day out
 * on the wrong side of a settlement window is the difference between "expected
 * timing" and "someone lost a file".
 */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/** `2026-09-10` plus n days, in book-date space. */
export function addDays(date: string, days: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}
