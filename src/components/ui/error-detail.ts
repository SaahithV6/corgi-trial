/**
 * Reading the optional fields off an `ErrorShape`, defensively.
 *
 * `ErrorShape.details` is deliberately `unknown` — the type is shared by every
 * route in this build and a per-caller shape does not belong in it. Every
 * source in this console puts `{ retryable, source, operation }` there; this
 * reads them back without casting, so a failure whose details came from
 * somewhere else renders as a dash instead of throwing inside the panel that
 * exists to report a throw.
 *
 * `/dashboard` has the same two functions privately inside `TriageView.tsx`.
 * They live here as well rather than being imported from there because
 * `src/components/dashboard/**` belongs to another worker on this build; the
 * five screens that share this module are the five that needed it at once.
 *
 * WHY `isRetryable` DEFAULTS TO TRUE. A failure that says nothing about
 * retrying is the ordinary case — a query that timed out, a connection that
 * dropped — and the retry control has always been offered for those. Only a
 * failure that explicitly says `retryable: false` loses the button, which
 * makes the absence of the control mean something: this cannot be cleared by
 * trying again.
 */

import type { ErrorShape } from "@/lib/result";

/** One `details` field, as a string, or `null` when it is not usable. */
export function errorDetail(error: ErrorShape, key: string): string | null {
  const details: unknown = error.details;
  if (typeof details !== "object" || details === null) return null;
  const value: unknown = (details as Record<string, unknown>)[key];
  if (typeof value === "boolean") return value ? "yes" : "no";
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Would trying again have any chance of a different answer?
 *
 * A Retry button beside the words "retryable: no" is a contradiction on the
 * face of one panel, and the reader has no way to tell which of the two the
 * screen means. There is no database to refresh into existence.
 */
export function isRetryable(error: ErrorShape): boolean {
  return errorDetail(error, "retryable") !== "no";
}
