/**
 * The source `/audit` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one, and on an
 * AUDIT screen the difference is the whole feature. `page.tsx` answered "there
 * is no database" with `createFixtureSource()` — a named business, two
 * actions, a count line and a completeness figure — on a deployment that had
 * not read a single row.
 *
 * It never actually reached that fallback. The `await import("@/lib/audit/view")`
 * on the line above it reaches `@/lib/ledger/db` -> `@/lib/env`, which throws
 * `EnvironmentError` without `APP_DATABASE_URL`, so the render died and the
 * operator got the framework error page. Both halves were wrong: the guard
 * could not run, and what it would have done was worse than the crash.
 *
 * WHY COMPLETENESS IS THE POINT. This screen is a PROJECTION over thirty-nine
 * append-only stores, and its claim is not "here are some actions" but "here is
 * every action, and here is the reconciliation of each store against what was
 * projected out of it". The fixture carried `completeness: { sources: [] }`,
 * which the count line renders as `sources 0 reconciled` and `dropped 0`. From
 * an unread book those are not small numbers, they are absent ones: nought
 * stores reconciled reads as a clean bill from a screen that checked nothing,
 * and nought rows dropped reads as a guarantee nobody obtained.
 *
 * WHY IT THROWS RATHER THAN RETURNING A RESULT. `AuditDataSource.load` returns
 * a bare `TimelineResult`, not a `Result<...>` — this screen's contract was
 * written that way and `src/components/audit/contract.ts` belongs to the same
 * seam every other component here reads through. `TimelineView` already
 * catches, so the refusal arrives down the path that failures already take,
 * and there is no second path on which this screen could be drawn from
 * nothing. The `ErrorShape` is exported separately because the view needs the
 * code and the `retryable` flag, and a thrown `Error` carries neither.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `AuditErrorPanel` drops the retry control when a failure says
 * so. It used to offer "Retry the read" unconditionally, on every failure this
 * screen can have.
 */

import type { ErrorShape } from "@/lib/result";

import type { AuditDataSource } from "./contract";

export const AUDIT_NO_DATABASE: ErrorShape = {
  code: "AUDIT_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no store was projected, no action was read and no source was reconciled. Nothing on this screen is a statement about what anyone did. An empty timeline here is not a business nothing happened to, and a completeness panel showing no gaps would be reporting on thirty-nine stores nobody opened.",
  details: {
    retryable: false,
    source: "audit.view",
    operation: "the audit trail",
  },
};

/**
 * The error a failed read reports when the read failed because there was
 * nothing to read from.
 *
 * A named class rather than a bare `Error` so `TimelineView` can tell this
 * apart from a Neon timeout without matching on message text, and so the code
 * and the `retryable` flag survive the throw.
 */
export class AuditUnreadableError extends Error {
  readonly shape: ErrorShape;

  constructor(shape: ErrorShape = AUDIT_NO_DATABASE) {
    super(shape.message);
    this.name = "AuditUnreadableError";
    this.shape = shape;
  }
}

/** A source that reads nothing and says so. */
export function createUnreadableAuditSource(
  shape: ErrorShape = AUDIT_NO_DATABASE,
): AuditDataSource {
  return {
    load: () => Promise.reject(new AuditUnreadableError(shape)),
  };
}
