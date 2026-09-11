import { NextResponse } from "next/server";

import { authoriseScheduled, REFUSAL_HEADERS, unauthorisedBody } from "@/app/api/cron/_auth";
import { sweepLapsedCommitments } from "@/lib/fx/hold";
import { sweepMaturedUnclearedCredits } from "@/lib/holds/availability";
import { sweepIncompleteHoldPostings } from "@/lib/holds/completion";
import { sweepExpiredHolds } from "@/lib/holds/expiry";
import { newRequestId, requestIdFrom } from "@/lib/log";

// Every sweep here posts through `ledger_append()` and holds a database connection.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The four hold sweeps, on one schedule.
 *
 * The first two existed and **neither was scheduled** — `sweepExpiredHolds()` since
 * DECISIONS 046, `sweepIncompleteHoldPostings()` since migration 0036. A sweep
 * nothing calls is a comment, which is the same failure as an invariant nothing
 * queries: 0022's `v_balance_definition_drift` sat unrun for a day, and 0025's
 * `v_wire_availability_drift` for a night.
 *
 * They run together because they are the halves of one question — "is any
 * hold in a state the model says it should not stay in?" — and separating them
 * means one gets a cron and the other is forgotten again.
 *
 * THE SCHEDULE IS PART OF THE CORRECTNESS, not a deployment detail.
 *
 * This ran at 08:11Z and could never have done its job. Every ACH uncleared
 * credit on this book matures at 09:00 ET — 13:00Z — so an 08:11Z sweep fired
 * BEFORE maturity every day, and `/api/drain` at 04:17Z did the same. A
 * same-day release was impossible by construction and the memo book ran about
 * nineteen hours behind permanently. The evidence sat there the whole time and
 * nothing read it: `hold_closure.source = 'availability_sweep'` had ZERO rows.
 *
 * Moved to 14:23Z, after 09:00 ET in both EST and EDT, shrinking the window
 * from ~19h to ~1h. It cannot be closed by scheduling — a cron is a clock and
 * maturity is a clock, and two clocks always leave a gap — which is why the
 * sweep books at `book_date(hold.available_at)` and not at the run date. The
 * DATE comes from immutable data; only the moment of discovery depends on when
 * this route happens to fire.
 *
 * ORDER MATTERS, and it is completion first, then the two releases.
 *
 * `sweepExpiredHolds()` releases a hold whose `expires_at` has passed. If it
 * ran first it would retire an authorisation whose withholding had never been
 * posted, and the money would simply never have been withheld — the evidence
 * heals on the clock while the customer's balance was wrong for seven days.
 * Completing first means every hold is withholding what the fold says before
 * anything is allowed to expire.
 *
 * `sweepMaturedUnclearedCredits()` (migration 0048) is the third, and it is a
 * RELEASE, so the same rule puts it after completion. Its position relative to
 * expiry is free, and it is written last rather than second on purpose: the two
 * releases touch disjoint hold kinds — `card_auth` and `uncleared_credit` — so
 * neither can see the other's work, and leaving "completion first" as the only
 * ordering claim in this file keeps the rule that has to be remembered down to
 * one. It closes the funding path's half of the same question: an inbound
 * credit whose `funds_availability_policy` instant has passed becomes spendable
 * on the clock, correctly, through `ledger_availability()` — while the memo
 * book is still carrying the withholding, which is exactly what
 * `v_hold_release_drift` exists to report. Measured on 2026-09-11: the guard was
 * empty at 12:47Z and held thirteen rows at 13:17Z with nobody having written a
 * thing.
 *
 * A NOTE ON THE SCHEDULE, because it is why that drift is guaranteed rather
 * than occasional. Every uncleared credit on the ACH rail matures at 09:00
 * America/New_York. This route is scheduled 08:11Z (04:11 ET), and `/api/drain`
 * — which already calls the rails adapter's older `releaseAvailableCredits()`
 * — at 04:17Z (00:17 ET). BOTH fire before the maturity, every day, so a
 * same-day release is impossible from either trigger and the memo book is
 * behind by roughly nineteen hours by construction. Moving this cron to after
 * 14:00Z in `vercel.json` shrinks that to about an hour year-round; that file is
 * outside this change's write scope, so the number is written down here rather
 * than silently assumed.
 *
 * Auth is `/api/drain`'s: a bearer token, `CRON_SECRET` or `DRAIN_TOKEN`,
 * checked by `../_auth.ts`. Not `x-vercel-cron` — see D04x and
 * `docs/SECURITY.md`. A sweep that releases holds and posts through
 * `ledger_append()` is not something a stranger gets to time.
 *
 * No sweep narrows a guard to succeed. `v_hold_posting_incomplete` is defined
 * `FROM v_hold_drift` and `v_uncleared_release_due` is defined `FROM
 * v_hold_release_drift`, so neither repair can range over rows its alarm cannot
 * see — and migrations 0036 and 0048 assert those equalities in both
 * directions at apply time.
 *
 * Completion still deliberately does NOT touch `v_hold_release_drift`: posting a
 * release there would silence 0011's alarm while leaving a false closure
 * standing. The third sweep does not overturn that — it carves out the one
 * sub-population where the question 0036 §3 protects cannot be asked, because
 * there is no closure to adjudicate. `v_uncleared_release_due` admits only
 * `uncleared_credit` holds with NO `hold_closure` row at all: `is_released` came
 * from `now() >= hold.available_at`, a predicate over a column written once at
 * funding on a table nothing may UPDATE. Nobody decided anything, so there is
 * nothing for a human to decide. A card hold, or any hold carrying a closure
 * somebody wrote, stays with the guard and with
 * `scripts/repair-0011-spurious-closures.mjs`.
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
    const availability = await sweepMaturedUnclearedCredits();
    const fxCommitments = await sweepLapsedCommitments();
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
        availability: { ...availability, releasedCents: availability.releasedCents.toString() },
        fxCommitments: {
          ...fxCommitments,
          releasedCents: fxCommitments.releasedCents.toString(),
        },
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
