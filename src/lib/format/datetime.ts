/**
 * Time formatting for the ops console.
 *
 * Two rules:
 *
 * 1. **Everything renders in one fixed banking timezone (America/New_York).**
 *    Not the viewer's locale. A funds-availability policy that says "09:00 ET"
 *    has to be checkable against what the screen says, and an operator in
 *    Denver comparing a hold's release time against a Nacha window must not be
 *    reading a different clock than the person next to them. A fixed timezone
 *    also means the server render and the client hydration agree, which a
 *    locale-derived one does not.
 * 2. **Ages are computed against an explicit `now`,** never `Date.now()` deep
 *    inside a component. The caller passes the instant the data was read as-of,
 *    so a page is a pure function of its inputs and a fixture is reproducible.
 */

export const BANKING_TIME_ZONE = "America/New_York";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: BANKING_TIME_ZONE,
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/**
 * A calendar date is not an instant, and shifting one by a timezone is how a
 * value date lands on the wrong business day.
 *
 * `new Date("2026-09-09")` is midnight **UTC**, which is 20:00 the previous
 * evening in New York — so formatting a bare `YYYY-MM-DD` in the banking
 * timezone would print `Sep 08` for a posting whose value date is the 9th, and
 * every daily statement would be off by one. Date-only strings are therefore
 * formatted in UTC, which is a no-op that returns the digits that were given.
 */
const calendarDateFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: BANKING_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function parse(iso: string): Date | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** `Sep 09, 2026 · 15:42 ET`. */
export function formatTimestamp(iso: string): string {
  const at = parse(iso);
  if (at === null) return "—";
  return `${dateFormat.format(at)} · ${timeFormat.format(at)} ET`;
}

/** `Sep 09, 2026`. Used for value dates, which are dates and never instants. */
export function formatDate(iso: string): string {
  const at = parse(iso);
  if (at === null) return "—";
  return DATE_ONLY.test(iso)
    ? calendarDateFormat.format(at)
    : dateFormat.format(at);
}

/** `09:00 ET`. */
export function formatTimeOfDay(iso: string): string {
  const at = parse(iso);
  if (at === null) return "—";
  return `${timeFormat.format(at)} ET`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Compact elapsed time: `just now`, `14m`, `3h 12m`, `1d 4h`, `12d`.
 *
 * Age is load-bearing on this screen. A card authorisation that has been open
 * for six days is about to expire; an uncleared credit that has been held for
 * three is a customer-service call. The unit is deliberately coarse — nobody
 * acts on seconds — but it never rounds an age down across a day boundary.
 */
export function formatAge(fromIso: string, nowIso: string): string {
  const from = parse(fromIso);
  const now = parse(nowIso);
  if (from === null || now === null) return "—";

  const elapsed = now.getTime() - from.getTime();
  if (elapsed < 0) return "—";
  if (elapsed < MINUTE_MS) return "just now";

  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)}m`;
  }
  if (elapsed < DAY_MS) {
    const hours = Math.floor(elapsed / HOUR_MS);
    const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }

  const days = Math.floor(elapsed / DAY_MS);
  const hours = Math.floor((elapsed % DAY_MS) / HOUR_MS);
  if (days >= 10 || hours === 0) return `${days}d`;
  return `${days}d ${hours}h`;
}

/**
 * How long until an instant, phrased for a release time: `in 17h`, `due now`.
 */
export function formatCountdown(toIso: string, nowIso: string): string {
  const to = parse(toIso);
  const now = parse(nowIso);
  if (to === null || now === null) return "—";
  if (to.getTime() <= now.getTime()) return "due now";
  return `in ${formatAge(now.toISOString(), to.toISOString())}`;
}
