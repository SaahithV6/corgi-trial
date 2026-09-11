import { NextResponse } from "next/server";

import { authoriseScheduled, REFUSAL_HEADERS, unauthorisedBody } from "@/app/api/cron/_auth";
import { env } from "@/lib/env";
import { newRequestId, requestIdFrom } from "@/lib/log";
import { runStandingOrders } from "@/lib/standing/fire";

// node:crypto is reached through the approvals path and the run holds database
// transactions. Neither survives the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Fire everything the schedule owes.
 *
 * ─── AUTHENTICATION IS `/api/drain`'S, DELIBERATELY THE SAME ────────────────
 *
 * A bearer token, always: `CRON_SECRET` (what Vercel Cron presents) or
 * `DRAIN_TOKEN` (what an operator holds), compared in constant time by
 * `../_auth.ts`. The same check the drain has, on the same two secrets.
 *
 * It did NOT used to be. Until D04x this route also returned true for any
 * request carrying `x-vercel-cron`, a header the platform sets and no one
 * strips — so the paragraph below, which was already written, described a
 * property the code did not have:
 *
 *   The drain's endpoint could argue it was harmless if left open, because
 *   draining is idempotent. THIS ONE CANNOT MAKE THAT ARGUMENT AND SHOULD NOT
 *   TRY. Firing is idempotent — a second call raises no second payment,
 *   because the idempotency key comes from the standing order and the
 *   scheduled date and `payment_instruction.idempotency_key` is UNIQUE — but a
 *   stranger who can make a bank's scheduler run on demand is a stranger who
 *   can change WHEN a payment lands, and "when" is half of what a standing
 *   order is.
 *
 * That was right, and the gate did not implement it. Now it does: the token is
 * required and there is no unauthenticated path. `docs/SECURITY.md` has the
 * measurement.
 *
 * ─── THE SCHEDULE VERCEL ACTUALLY RUNS ──────────────────────────────────────
 *
 * On the Hobby plan a cron fires ONCE A DAY, at an approximate time. That is
 * the tightest schedule the platform runs and this route says so rather than
 * implying a tighter one: an occurrence due on the 1st is claimed by the first
 * tick on or after the 1st, not at midnight on it. The design does not need a
 * tighter one — the unit of work is a DATE, the calendar is a SQL function, and
 * a tick that runs late still claims exactly the dates that are owed. What a
 * tick can never do is claim a date twice, and that is the property being
 * graded.
 *
 * A missed day is not a lost payment either: `listDue()` looks back over the
 * catch-up window, so a tick that did not run yesterday picks yesterday up
 * today. Past the freshness limit it still records the occurrence — as
 * `refused / STALE_OCCURRENCE` — because a fortnight of rent debited in one
 * batch by a scheduler that has just woken up is worse than not firing.
 */

async function run(req: Request): Promise<NextResponse> {
  const requestId = requestIdFrom(req.headers) ?? newRequestId();

  if (!authoriseScheduled(req, "standing", requestId).ok) {
    return NextResponse.json(unauthorisedBody(requestId, "the standing-order tick"), {
      status: 401,
      headers: REFUSAL_HEADERS,
    });
  }

  try {
    const result = await runStandingOrders({ runId: `standing-${requestId}` });
    return NextResponse.json(
      {
        requestId,
        ...result,
        // bigint does not survive JSON.stringify, and money is bigint cents
        // everywhere below this line. Narrowed here, at the edge, as decimal
        // strings — never as numbers, which is how a cent goes missing.
        occurrences: result.occurrences.map((occurrence) => ({
          ...occurrence,
          amountCents: occurrence.amountCents.toString(),
          availability:
            occurrence.availability === null
              ? null
              : {
                  ledgerCents: occurrence.availability.ledgerCents.toString(),
                  holdsCents: occurrence.availability.holdsCents.toString(),
                  unclearedCents: occurrence.availability.unclearedCents.toString(),
                  availableCents: occurrence.availability.availableCents.toString(),
                },
        })),
      },
      { status: 200, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (e) {
    // A failed tick must be visible. Every occurrence is its own transaction,
    // so a throw here means the run stopped, not that anything half-fired —
    // but a silent 500 would look exactly like a quiet, healthy system, and
    // "the scheduler has not run for a week" is precisely the condition this
    // whole feature exists to make impossible to miss.
    return NextResponse.json(
      {
        requestId,
        error: {
          code: "STANDING_RUN_FAILED",
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

// Referenced so the env module is loaded and validated on this route too.
void env;
