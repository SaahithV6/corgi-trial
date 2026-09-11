/**
 * The source `/events` uses on a deployment with no database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a delivery log. This is a refusal to draw one.
 * `page.tsx` answered "there is no database" with
 * `createFixtureEventsSource("empty")`, which draws the delivery counters —
 * delivered, pending, dead — and the queue cursor against the ledger head, all
 * reading nought.
 *
 * On this screen those counters ARE the screen. The audience is the person
 * whose server is not receiving our events, and the question they came to
 * settle is whether anything is stuck on our side. "0 pending, 0 dead" is the
 * answer that sends them back to their own logs, and it would have been given
 * by a deployment that opened no connection. The FIXTURE badge beside it does
 * not withdraw it: a badge on a delivery log tells a reader the ROWS are
 * invented, not that the COUNTS are unknown.
 *
 * It never actually reached that fallback. `page.tsx` asked
 * `live.hasDatabase()` after `const live = await import("./live-source")`, and
 * that module's `import { sql } from "@/lib/ledger/db"` throws without
 * `APP_DATABASE_URL`, so the render died and the operator got the framework
 * error page. Both halves were wrong, in the same way the six screens repaired
 * before it were wrong: the guard could not run, and what it would have done
 * was worse than the crash.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and `EventsError` draws no retry control when a failure says so.
 */

import { fail } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { EventsDataSource, EventsView } from "./data-contract";

export const EVENTS_LOG_UNREADABLE: ErrorShape = {
  code: "EVENTS_LOG_UNREADABLE",
  message:
    "No database is configured for this deployment, so no endpoint was listed, no delivery was read and no queue depth was measured. Nothing on this screen is a statement about whether a delivery is stuck. A counter reading nought here is not a queue with nothing in it, and an empty endpoint list is not a customer who has registered none.",
  details: {
    retryable: false,
    source: "events.live-source",
    operation: "the outbound delivery log",
  },
};

/**
 * A source that reads nothing and says so.
 *
 * It is an `EventsDataSource` rather than a branch in the page so the refusal
 * arrives through the same channel as every other failure: one component
 * renders the log, one component renders the refusal, and there is no second
 * path on which this screen could be drawn from nothing.
 */
export function createUnreadableEventsSource(
  error: ErrorShape = EVENTS_LOG_UNREADABLE,
): EventsDataSource {
  return {
    load(): Promise<Result<EventsView, ErrorShape>> {
      return Promise.resolve(fail(error.code, error.message, error.details));
    },
  };
}
