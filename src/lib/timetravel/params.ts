/**
 * THE TWO URL PARAMETERS, PARSED ONCE.
 *
 * ===========================================================================
 * WHAT THIS IS
 * ===========================================================================
 *
 * `?asOf=<date>&asKnownAt=<timestamp>` is the console's time machine, and the
 * two parameters are the two columns of the bitemporal model:
 *
 *     asOf       VALUE   date — which business day we are asking about
 *     asKnownAt  BOOKING time — what we had learned when we asked
 *
 * They are independent. Holding one still and moving the other is the whole
 * demonstration: the same business day reads differently at two `asKnownAt`
 * values, because a correction posted at the ORIGINAL value date with a
 * strictly later booking sequence, and nothing was ever edited.
 *
 * ===========================================================================
 * WHY THIS FILE TOUCHES NO DATABASE
 * ===========================================================================
 *
 * Parsing is a pure function of a query string and a clock. Resolving those
 * into a ledger snapshot is `./point.ts`, which does. Keeping them apart means
 * every validation rule below is testable without credentials — which is what
 * CI is — and means a screen can refuse an impossible coordinate BEFORE it
 * opens a connection.
 *
 * ===========================================================================
 * THE RULES, AND WHY EACH ONE IS A REFUSAL RATHER THAN A COERCION
 * ===========================================================================
 *
 * The house rule everywhere else in this console is that a malformed query
 * parameter falls back to the default rather than throwing: a mistyped day on
 * `/statements` shows the default day, because a 500 on a bad URL is a worse
 * answer than ignoring it.
 *
 * THAT RULE IS INVERTED HERE, DELIBERATELY.
 *
 * Ignoring `?day=` shows you a different day, and the day picker on the screen
 * tells you which. Ignoring `?asKnownAt=` shows you TODAY'S BELIEF wearing the
 * label of a past one. The failure is invisible, it is a number, and the
 * entire claim of the screen is that the number is what we believed at that
 * moment. So a coordinate this module cannot honour is REFUSED, with the
 * parameter named and the reason stated, and nothing is rendered in its place.
 *
 * ===========================================================================
 * `asKnownAt` BEFORE `asOf`: SUPPORTED, AND LABELLED
 * ===========================================================================
 *
 * "What did we believe, on Monday, about Friday?" is a coherent bitemporal
 * question and this build can answer it exactly. A book that already carries
 * value dates in 2027 (standing-order settlements) has real content in that
 * quadrant: on Monday we had already booked Friday's settlement, so Monday's
 * belief about Friday is a fact, not a forecast.
 *
 * It is supported. It is also the quadrant a reader is most likely to land in
 * by accident, so it is NAMED — `foresight` — and the screen says so on its
 * face rather than letting a reader assume every reading is retrospective.
 *
 * ===========================================================================
 * A FUTURE `asKnownAt` IS NOT
 * ===========================================================================
 *
 * There is no watermark for an instant that has not happened. Resolving one
 * would silently return the live watermark, and the screen would print today's
 * belief under a heading claiming it was tomorrow's. That is the exact shape
 * of lie this module exists to prevent, so it is refused.
 *
 * The tolerance is sixty seconds and it is a tolerance, not a licence: the
 * reader's browser clock and this server's clock are different machines, and a
 * URL minted from a clock a few seconds fast must not become an error page.
 */

import { BANKING_TIME_ZONE } from "@/lib/format/datetime";

/* -------------------------------------------------------------------------- */
/* The names                                                                  */
/* -------------------------------------------------------------------------- */

/** The value-date axis. `YYYY-MM-DD`. */
export const AS_OF_PARAM = "asOf";
/** The booking-time axis. An instant. */
export const AS_KNOWN_AT_PARAM = "asKnownAt";

/**
 * How far ahead of this server's clock an `asKnownAt` may sit before it is
 * refused. See the header: a tolerance for clock skew between machines, not a
 * window in which the future may be queried.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** The earliest year either axis accepts. The book's oldest value date is 1980. */
const MIN_YEAR = 1900;
/** The latest year the value axis accepts. The book carries 2027 value dates. */
const MAX_YEAR = 2999;

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

export type RefusalCode =
  | "AS_OF_MALFORMED"
  | "AS_OF_NOT_A_DATE"
  | "AS_OF_OUT_OF_RANGE"
  | "AS_KNOWN_AT_MALFORMED"
  | "AS_KNOWN_AT_OUT_OF_RANGE"
  | "AS_KNOWN_AT_IN_FUTURE";

/**
 * A coordinate this module will not render.
 *
 * `because` is separate from `what` on purpose. "asKnownAt is in the future"
 * is what is wrong; "there is no watermark for an instant that has not
 * happened, and resolving one would print today's belief under yesterday's
 * heading" is why it is refused instead of clamped, and a reader who disagrees
 * with the second sentence is disagreeing with a decision rather than with a
 * validator.
 */
export type TimeTravelRefusal = {
  readonly code: RefusalCode;
  readonly param: typeof AS_OF_PARAM | typeof AS_KNOWN_AT_PARAM;
  /** Exactly what the URL said, truncated. Never re-interpreted. */
  readonly given: string;
  readonly what: string;
  readonly because: string;
  /** A URL that IS answerable, when an obvious one exists. */
  readonly suggestion: string | null;
};

/* -------------------------------------------------------------------------- */
/* The request                                                                */
/* -------------------------------------------------------------------------- */

export type TimeTravelRequest = {
  /** `YYYY-MM-DD`, or `null` for "the book's own today". */
  readonly asOfValueDate: string | null;
  /** The instant, or `null` for "everything we have learned". */
  readonly asKnownAt: Date | null;
  /** Exactly what the URL said, for display beside what it resolved to. */
  readonly asKnownAtRaw: string | null;
  readonly asOfRaw: string | null;
  /**
   * NEITHER parameter was supplied.
   *
   * Load-bearing: every screen branches on this and takes its ORIGINAL,
   * untouched data path when it is true. No parameter, no difference — same
   * queries, same output. `params.test.ts` and `point.test.ts` both pin it.
   */
  readonly absent: boolean;
  /**
   * `asKnownAt` lands before the start of `asOf`: a question about the future
   * of a past belief. Supported; see the header.
   */
  readonly foresight: boolean;
};

export type ParsedTimeTravel =
  | { readonly ok: true; readonly request: TimeTravelRequest }
  | { readonly ok: false; readonly refusals: readonly TimeTravelRefusal[] };

/* -------------------------------------------------------------------------- */
/* Time zone arithmetic, without a dependency                                 */
/* -------------------------------------------------------------------------- */

const ZONE_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: BANKING_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/**
 * The banking zone's offset from UTC, in minutes, at a given instant.
 *
 * Format the instant in the zone, read the wall-clock fields back as though
 * they were UTC, and take the difference. This is the standard trick and it is
 * here rather than in a dependency because it is nine lines and because the
 * one thing this console must never do is get a business-day boundary from a
 * library whose zone database disagrees with Postgres's.
 */
function zoneOffsetMinutes(instantMs: number): number {
  const parts = ZONE_FORMAT.formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found === undefined ? 0 : Number(found.value);
  };
  // `hourCycle: "h23"` should never produce 24, but some engines have; treat
  // it as midnight rather than as an hour that does not exist.
  const hour = field("hour") % 24;
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    hour,
    field("minute"),
    field("second"),
  );
  return (asIfUtc - instantMs) / 60_000;
}

/**
 * A wall-clock reading in the banking zone, turned into an instant.
 *
 * Two passes. The first guesses the offset by pretending the fields are UTC;
 * the second re-reads the offset AT the candidate instant, which is what makes
 * the hour either side of a DST transition come out right. A single pass is
 * wrong for one hour twice a year, and "wrong for one hour twice a year" is
 * how a settlement ends up on the wrong business day.
 */
function zonedFieldsToInstant(fields: {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly ms: number;
}): Date {
  // WHOLE SECONDS ONLY for the offset probe. `zoneOffsetMinutes` formats to
  // second precision and reads the fields back, so a sub-second component in
  // the input is discarded on the way out and reappears as an error in the
  // offset — which made `endOfBankingDay` land at 04:00:00.997Z instead of
  // 03:59:59.999Z. A zone offset does not depend on milliseconds, so the
  // milliseconds are held back and added to the resolved instant.
  const asIfUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  let instant = asIfUtc - zoneOffsetMinutes(asIfUtc) * 60_000;
  instant = asIfUtc - zoneOffsetMinutes(instant) * 60_000;
  return new Date(instant + fields.ms);
}

/** The last representable instant of a banking-zone calendar day. */
export function endOfBankingDay(valueDate: string): Date {
  const [year, month, day] = valueDate.split("-").map(Number) as [number, number, number];
  return zonedFieldsToInstant({
    year,
    month,
    day,
    hour: 23,
    minute: 59,
    second: 59,
    ms: 999,
  });
}

/** The first instant of a banking-zone calendar day. */
export function startOfBankingDay(valueDate: string): Date {
  const [year, month, day] = valueDate.split("-").map(Number) as [number, number, number];
  return zonedFieldsToInstant({ year, month, day, hour: 0, minute: 0, second: 0, ms: 0 });
}

/** `YYYY-MM-DD` for an instant, in the banking zone. */
export function bankingDayOf(instant: Date): string {
  const parts = ZONE_FORMAT.formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined || raw === "" ? undefined : raw;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * An instant, with or without a zone, with or without a time.
 *
 * Three shapes are accepted and the third is the one that needs an argument:
 *
 *   `2026-09-10T14:32:00Z`        explicit UTC
 *   `2026-09-10T10:32:00-04:00`   explicit offset
 *   `2026-09-10T10:32`            NO zone — read as BANKING time
 *   `2026-09-10`                  no time at all — read as the END of that
 *                                 banking day
 *
 * A bare local time is read in `America/New_York` and not in the server's
 * zone, because this is a US banking console whose business-day boundary is
 * already the Fed's, and because a server zone is a deployment accident that
 * must never change what a URL means. A bare DATE resolves to the end of the
 * day for the same reason "what did we believe on Tuesday" means at the close
 * of Tuesday and not one microsecond past midnight, when we believed almost
 * nothing about it yet.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,6}))?(Z|[+-]\d{2}:?\d{2})?$/;

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function clip(value: string): string {
  return value.length > 64 ? `${value.slice(0, 61)}...` : value;
}

type DateParse =
  | { readonly ok: true; readonly valueDate: string }
  | { readonly ok: false; readonly refusal: TimeTravelRefusal };

function parseAsOf(raw: string): DateParse {
  const match = DATE_ONLY.exec(raw);
  if (match === null) {
    return {
      ok: false,
      refusal: {
        code: "AS_OF_MALFORMED",
        param: AS_OF_PARAM,
        given: clip(raw),
        what: "asOf is not a calendar date in YYYY-MM-DD form.",
        because:
          "The value axis is a business day, not an instant. Accepting a timestamp here would invite the two axes to be confused, which is the one confusion this screen exists to remove.",
        suggestion: null,
      },
    };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!isRealDate(year, month, day)) {
    return {
      ok: false,
      refusal: {
        code: "AS_OF_NOT_A_DATE",
        param: AS_OF_PARAM,
        given: clip(raw),
        what: "asOf is well-formed but is not a day that exists.",
        because:
          "A date that does not exist has no postings, and rendering an empty day for it would look exactly like a day on which nothing happened.",
        suggestion: null,
      },
    };
  }

  if (year < MIN_YEAR || year > MAX_YEAR) {
    return {
      ok: false,
      refusal: {
        code: "AS_OF_OUT_OF_RANGE",
        param: AS_OF_PARAM,
        given: clip(raw),
        what: `asOf is outside ${String(MIN_YEAR)}–${String(MAX_YEAR)}.`,
        because:
          "Outside that range the answer is certainly an empty ledger, and an empty ledger rendered without comment reads as a real position of zero.",
        suggestion: null,
      },
    };
  }

  return { ok: true, valueDate: `${match[1]}-${match[2]}-${match[3]}` };
}

type InstantParse =
  | { readonly ok: true; readonly at: Date }
  | { readonly ok: false; readonly refusal: TimeTravelRefusal };

function parseAsKnownAt(raw: string, now: Date): InstantParse {
  const dateOnly = DATE_ONLY.exec(raw);
  let at: Date | null = null;

  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    if (isRealDate(year, month, day)) at = endOfBankingDay(raw);
  } else {
    const match = ISO_INSTANT.exec(raw);
    if (match !== null) {
      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      const second = match[6] === undefined ? 0 : Number(match[6]);
      const fraction = match[7];
      const zone = match[8];

      // Fractional seconds are padded, never rounded: `.5` is 500ms and `.5001`
      // truncates to 500ms rather than becoming 5001. Truncation is the right
      // direction because a watermark is "at or below", so truncating can only
      // ever exclude an entry, never invent one.
      const ms =
        fraction === undefined ? 0 : Number(`${fraction}000`.slice(0, 3));

      const valid =
        isRealDate(year, month, day) &&
        hour <= 23 &&
        minute <= 59 &&
        second <= 60 &&
        year >= MIN_YEAR &&
        year <= MAX_YEAR;

      if (valid) {
        if (zone === undefined) {
          at = zonedFieldsToInstant({ year, month, day, hour, minute, second, ms });
        } else {
          const normalised = zone === "Z" ? "Z" : zone.replace(/^([+-]\d{2})(\d{2})$/, "$1:$2");
          const parsed = Date.parse(
            `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${String(second).padStart(2, "0")}.${String(ms).padStart(3, "0")}${normalised}`,
          );
          if (!Number.isNaN(parsed)) at = new Date(parsed);
        }
      }
    }
  }

  if (at === null || Number.isNaN(at.getTime())) {
    return {
      ok: false,
      refusal: {
        code: "AS_KNOWN_AT_MALFORMED",
        param: AS_KNOWN_AT_PARAM,
        given: clip(raw),
        what: "asKnownAt is not an instant this console can resolve.",
        because:
          "It resolves to a booking watermark, and a watermark is a position in the ledger's total order. Guessing at what an unparseable string meant would put a real, checkable number under a heading nobody chose.",
        suggestion: null,
      },
    };
  }

  if (at.getTime() > now.getTime() + CLOCK_SKEW_TOLERANCE_MS) {
    return {
      ok: false,
      refusal: {
        code: "AS_KNOWN_AT_IN_FUTURE",
        param: AS_KNOWN_AT_PARAM,
        given: clip(raw),
        what: "asKnownAt is in the future.",
        because:
          "There is no booking watermark for an instant that has not happened. Resolving one returns the live watermark, and the screen would then print today's belief under a heading claiming it was a future one — which is the precise failure this parameter exists to make impossible.",
        suggestion: `${AS_KNOWN_AT_PARAM}=${now.toISOString()}`,
      },
    };
  }

  if (at.getUTCFullYear() < MIN_YEAR) {
    return {
      ok: false,
      refusal: {
        code: "AS_KNOWN_AT_OUT_OF_RANGE",
        param: AS_KNOWN_AT_PARAM,
        given: clip(raw),
        what: `asKnownAt is before ${String(MIN_YEAR)}.`,
        because:
          "Before the book's first entry the watermark is zero and every figure is zero. That is a true answer and an unreadable one, so it is refused rather than rendered as a position.",
        suggestion: null,
      },
    };
  }

  return { ok: true, at };
}

/**
 * Read both axes out of `searchParams`.
 *
 * `now` is injected rather than read: the future check is the one rule in this
 * file that depends on the wall clock, and a validator that reads the clock
 * itself is a validator that cannot be tested. See `./clock.ts` for why "what
 * is now" is a parameter everywhere in this feature.
 *
 * Both parameters are checked even when the first fails, so a URL with two
 * problems reports two problems. Fixing one and rediscovering the other is how
 * a reader concludes the feature is broken.
 */
export function parseTimeTravelParams(
  searchParams: Record<string, string | string[] | undefined>,
  now: Date,
): ParsedTimeTravel {
  const rawAsOf = first(searchParams[AS_OF_PARAM]);
  const rawAsKnownAt = first(searchParams[AS_KNOWN_AT_PARAM]);

  if (rawAsOf === undefined && rawAsKnownAt === undefined) {
    return {
      ok: true,
      request: {
        asOfValueDate: null,
        asKnownAt: null,
        asKnownAtRaw: null,
        asOfRaw: null,
        absent: true,
        foresight: false,
      },
    };
  }

  const refusals: TimeTravelRefusal[] = [];

  let asOfValueDate: string | null = null;
  if (rawAsOf !== undefined) {
    const parsed = parseAsOf(rawAsOf);
    if (parsed.ok) asOfValueDate = parsed.valueDate;
    else refusals.push(parsed.refusal);
  }

  let asKnownAt: Date | null = null;
  if (rawAsKnownAt !== undefined) {
    const parsed = parseAsKnownAt(rawAsKnownAt, now);
    if (parsed.ok) asKnownAt = parsed.at;
    else refusals.push(parsed.refusal);
  }

  if (refusals.length > 0) return { ok: false, refusals };

  const foresight =
    asOfValueDate !== null &&
    asKnownAt !== null &&
    asKnownAt.getTime() < startOfBankingDay(asOfValueDate).getTime();

  return {
    ok: true,
    request: {
      asOfValueDate,
      asKnownAt,
      asKnownAtRaw: rawAsKnownAt ?? null,
      asOfRaw: rawAsOf ?? null,
      absent: false,
      foresight,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Serialising                                                                */
/* -------------------------------------------------------------------------- */

export type TimeTravelPatch = {
  readonly asOf?: string | null;
  readonly asKnownAt?: Date | string | null;
};

function serialiseKnownAt(value: Date | string): string {
  return typeof value === "string" ? value : value.toISOString();
}

/**
 * Put the two axes onto an existing href, preserving everything already on it.
 *
 * Every link this feature renders goes through here, so a screen cannot
 * accidentally drop an axis while navigating — which would silently return the
 * reader to the present under the heading they were already reading.
 *
 * A `null` in the patch REMOVES that axis. That is how "exit the time machine"
 * is expressed, and it is expressed as a link rather than as a button because
 * every state on this console has to be reachable by URL.
 */
export function withTimeTravel(href: string, patch: TimeTravelPatch): string {
  const [path, query = ""] = href.split("?", 2);
  const params = new URLSearchParams(query);

  if (patch.asOf !== undefined) {
    if (patch.asOf === null) params.delete(AS_OF_PARAM);
    else params.set(AS_OF_PARAM, patch.asOf);
  }
  if (patch.asKnownAt !== undefined) {
    if (patch.asKnownAt === null) params.delete(AS_KNOWN_AT_PARAM);
    else params.set(AS_KNOWN_AT_PARAM, serialiseKnownAt(patch.asKnownAt));
  }

  const rendered = params.toString();
  return rendered === "" ? (path ?? "") : `${path ?? ""}?${rendered}`;
}

/** The canonical `?asOf=…&asKnownAt=…` for a request, or `""` when it is live. */
export function timeTravelQuery(request: TimeTravelRequest): string {
  if (request.absent) return "";
  return withTimeTravel("", {
    asOf: request.asOfValueDate,
    asKnownAt: request.asKnownAt,
  });
}
