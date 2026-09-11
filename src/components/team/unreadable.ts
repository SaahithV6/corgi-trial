/**
 * The two shapes `/team`'s failures take.
 *
 * ============================================================================
 * NEITHER IS A FIXTURE, AND THAT IS WHY THEY ARE NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a team. These are refusals to draw one.
 *
 * WHAT THIS SCREEN CARRIED WAS NOT AN UNREACHABLE GUARD. It was no guard at
 * all. `page.tsx` imported `@/lib/approvals/session`, `@/lib/team/screen` and
 * `@/lib/team/store` at the top of the file; all three reach
 * `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env` at module scope
 * and throws `EnvironmentError` without `APP_DATABASE_URL`. The page MODULE
 * failed to load, so the operator got the framework's error page and this
 * screen never ran — not the live states, and not the two fixture states,
 * which need no database and had no reason to fail with it absent.
 *
 * WHAT A REFUSAL HERE HAS TO BE CAREFUL ABOUT. This screen's subject is who
 * may spend, and its strongest claim is the invariant panel: named database
 * views, each counted on the request, each badged green at nought. "No
 * purchase was approved under member terms that were suspended at the instant
 * it was decided" is a sentence about a book. From an unread one it is the
 * same green badge saying something nobody checked, which is why the refusal
 * draws no invariant row rather than a row reading nought.
 *
 * AND IT IS NOT A CLAIM ABOUT THE AUTHORISATION PATH. A card decision that
 * cannot reach the database DECLINES, and it does so without this screen. What
 * is missing with no database is the read, never the revocation — the two fail
 * in opposite directions on purpose.
 *
 * `retryable: false` on the refusal because it is true: a refresh does not
 * configure a database, and `TeamErrorPanel` drops the retry control when a
 * failure says so. `retryable: true` on a failed read because that one is the
 * ordinary case — a query that timed out, a connection that dropped — and
 * trying again is the intended recovery.
 */

import type { ErrorShape } from "@/lib/result";

export const TEAM_BOOK_UNREADABLE: ErrorShape = {
  code: "TEAM_BOOK_UNREADABLE",
  message:
    "No database is configured for this deployment, so no member, no role, no card and no outstanding authorisation was read, and no invariant was counted. Nothing on this screen is a statement about who is on a team or about what their card may do. An empty team here is not a business nobody has been added to.",
  details: {
    retryable: false,
    source: "team.screen",
    operation: "the team screen",
  },
};

/**
 * A failed read, in the shape the panel can render.
 *
 * `readTeamScreen()` in `@/lib/team/screen` returns `{ ok: false, message }`
 * and nothing else — no code, no `retryable` — and that module is not this
 * screen's to change. So the adaptation happens here, at the page's own
 * boundary, rather than by teaching every component to read a second failure
 * shape. The page used to render that bare message in a `<Note>`: an operator
 * could not tell a transient timeout from a book with no business on it, and
 * had nothing to press either way.
 */
export function teamReadFailure(message: string): ErrorShape {
  return {
    code: "TEAM_READ_FAILED",
    message,
    details: {
      retryable: true,
      source: "team.screen",
      operation: "the team screen",
    },
  };
}
