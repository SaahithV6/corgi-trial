import { NextResponse } from "next/server";

import { authoriseScheduled, REFUSAL_HEADERS, unauthorisedBody } from "@/app/api/cron/_auth";
import { sweepIncompleteHoldPostings } from "@/lib/holds/completion";
import { sweepExpiredHolds } from "@/lib/holds/expiry";
import { newRequestId, requestIdFrom } from "@/lib/log";

// Both sweeps post through `ledger_append()` and hold a database connection.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The two hold sweeps, on one schedule.
 *
 * Both existed and **neither was scheduled** — `sweepExpiredHolds()` since
 * DECISIONS 046, `sweepIncompleteHoldPostings()` since migration 0036. A sweep
 * nothing calls is a comment, which is the same failure as an invariant nothing
 * queries: 0022's `v_balance_definition_drift` sat unrun for a day, and 0025's
 * `v_wire_availability_drift` for a night.
 *
 * They run together because they are the two halves of one question — "is any
 * hold in a state the model says it should not stay in?" — and separating them
 * means one gets a cron and the other is forgotten again.
 *
 * ORDER MATTERS, and it is completion first.
 *
 * `sweepExpiredHolds()` releases a hold whose `expires_at` has passed. If it
 * ran first it would retire an authorisation whose withholding had never been
 * posted, and the money would simply never have been withheld — the evidence
 * heals on the clock while the customer's balance was wrong for seven days.
 * Completing first means every hold is withholding what the fold says before
 * anything is allowed to expire.
 *
 * Auth is `/api/drain`'s: a bearer token, `CRON_SECRET` or `DRAIN_TOKEN`,
 * checked by `../_auth.ts`. Not `x-vercel-cron` — see D04x and
 * `docs/SECURITY.md`. A sweep that releases holds and posts through
 * `ledger_append()` is not something a stranger gets to time.
 *
 * Neither sweep narrows a guard to succeed. `v_hold_posting_incomplete` is
 * defined `FROM v_hold_drift`, so the repair cannot range over fewer rows than
 * the alarm — and migration 0036 asserts that equality in both directions at
 * apply time. Completion deliberately does NOT touch `v_hold_release_drift`:
 * posting a release there would silence 0011's alarm while leaving a false
 * closure standing.
 */

async function run(req: Request): Promise<NextResponse> {
  const requestId = requestIdFrom(req.headers) ?? newRequestId();
  if (!authoriseScheduled(req, "holds", requestId).ok) {
    return NextResponse.json(unauthorisedBody(requestId, "the hold sweep"), {
      status: 401,
      headers: REFUSAL_HEADERS,
    });
  }
  try {
    const completion = await sweepIncompleteHoldPostings();
    const expiry = await sweepExpiredHolds();
    return NextResponse.json(
      {
        requestId,
        // bigint does not survive JSON.stringify, and money is bigint cents
        // everywhere below this line. Narrowed here, at the edge, as decimal
        // strings — never as numbers, which is how a cent goes missing. The
        // same narrowing `/api/cron/accrual` and `/api/cron/standing` do.
        //
        // FOUND BY MEASUREMENT, D04x. Without this the route threw
        // "Do not know how to serialize a BigInt" on EVERY call — inside the
        // try, after both sweeps had already committed — so a healthy sweep
        // answered `500 HOLD_SWEEP_FAILED`. The header on `catch` below says a
        // silent 500 would look like a book with nothing to sweep; this was
        // the inverse, an alarm that fired every night on a job that worked,
        // and it had never returned 200 since the schedule was added.
        completion: { ...completion, withheldCents: completion.withheldCents.toString() },
        expiry: { ...expiry, releasedCents: expiry.releasedCents.toString() },
      },
      { status: 200, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (e) {
    // A failed sweep must be visible. Nothing is lost — the rows stay in
    // `v_hold_drift` and the next tick finds them — but a silent 500 would
    // look exactly like a book with nothing to sweep.
    return NextResponse.json(
      {
        requestId,
        error: {
          code: "HOLD_SWEEP_FAILED",
          message: e instanceof Error ? e.message : "unknown",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(req: Request) {
  return run(req);
}
export async function POST(req: Request) {
  return run(req);
}
