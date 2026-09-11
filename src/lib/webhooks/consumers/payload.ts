/**
 * Two things every consumer written after Lithic needs, and neither of them is
 * worth writing three times.
 *
 * `lithic-card.ts` carries its own copy of `parseStoredPayload`. It is NOT
 * refactored to import this one: 414 deliveries have been processed by that
 * file, a refactor of a working money path buys nothing, and "a refactor that
 * changes Lithic's behaviour is a bug" is the rule this directory is held to.
 * So this module is additive — new consumers use it, the old one is left
 * alone — and the duplication is deliberate and recorded rather than tidy and
 * silent.
 */

import "server-only";

import { BANKING_TIME_ZONE } from "@/lib/format/datetime";

/**
 * Read a stored `webhook_inbox.payload` as an object.
 *
 * The column is `jsonb` and holds an OBJECT for everything stored since the
 * `::text::jsonb` fix in DECISIONS 020. Rows written before it hold a jsonb
 * STRING — the body arrived already stringified and a bare `::jsonb` quoted it
 * a second time. Parsing a string here is therefore the difference between
 * replaying history and losing it, and it is strictly safe: a double-encoded
 * object parses to the object, a genuine object is returned untouched.
 */
export function readStoredPayload(payload: unknown): Record<string, unknown> | null {
  if (typeof payload === "string") {
    try {
      const parsed: unknown = JSON.parse(payload);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof payload === "object" && payload !== null) {
    return payload as Record<string, unknown>;
  }
  return null;
}

/** A non-empty string at `path`, or null. Never coerces. */
export function readString(source: unknown, path: readonly string[]): string | null {
  let cursor: unknown = source;
  for (const segment of path) {
    if (typeof cursor !== "object" || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}

const bookDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: BANKING_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * An instant -> the business day it belongs to, `YYYY-MM-DD`.
 *
 * The book closes in America/New_York, so a settlement stamped 01:30Z on the
 * 12th is the 11th's money. `Intl` with an explicit zone rather than arithmetic
 * on offsets: DST is a table, not a formula, and Node already ships the table.
 */
export function bookDateOf(at: Date): string {
  return bookDateFormat.format(at);
}

/** The same, from an ISO-8601 string. Returns null if it is not a date. */
export function bookDateOfIso(iso: string): string | null {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : bookDateOf(new Date(ms));
}
