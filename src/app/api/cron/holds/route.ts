import { NextResponse } from "next/server";

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
 * Neither sweep narrows a guard to succeed. `v_hold_posting_incomplete` is
 * defined `FROM v_hold_drift`, so the repair cannot range over fewer rows than
 * the alarm — and migration 0036 asserts that equality in both directions at
 * apply time. Completion deliberately does NOT touch `v_hold_release_drift`:
 * posting a release there would silence 0011's alarm while leaving a false
 * closure standing.
 */
function authorised(req: Request): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.DRAIN_TOKEN;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function run(req: Request): Promise<NextResponse> {
  const requestId = requestIdFrom(req.headers) ?? newRequestId();
  if (!authorised(req)) {
    return NextResponse.json(
      {
        requestId,
        error: {
          code: "UNAUTHORISED",
          message: "the hold sweep requires the cron header or a bearer token",
        },
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const completion = await sweepIncompleteHoldPostings();
    const expiry = await sweepExpiredHolds();
    return NextResponse.json(
      { requestId, completion, expiry },
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
