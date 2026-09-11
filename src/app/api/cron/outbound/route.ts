import { NextResponse } from "next/server";

import { drainOutbound } from "@/lib/events/drain";
import { newRequestId, requestIdFrom } from "@/lib/log";

// The deliverer opens TLS sockets with a pinned `lookup` and holds a database
// connection. Neither survives the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drain the OUTBOUND queue: materialise new events from the ledger, then
 * deliver whatever is waiting.
 *
 * Deliberately a mirror of `/api/drain`, including its auth, because the two
 * are the same job in opposite directions and an operator under pressure
 * should not have to remember which one takes a bearer token.
 *
 * Without this route the queue drains only when somebody presses "Drain now"
 * on `/events`. A customer's webhook arriving because a human clicked a button
 * is not a webhook — it is a report. This is the guarantee that an event
 * materialises and is attempted even when nobody is watching.
 *
 * Note what is NOT here: no `await` on anything inside a money transaction.
 * `drainOutbound()` walks `outbound_cursor` over `booking_seq` AFTER commit,
 * every foreign key points outbound -> ledger and never the reverse, and no
 * module under `src/lib/{ledger,holds,rails}` imports `lib/events` at all. A
 * customer's dead endpoint cannot reach back and stop their own money moving,
 * and that property is structural rather than careful.
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
          message: "the outbound drain requires the cron header or a bearer token",
        },
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const result = await drainOutbound();
    return NextResponse.json(
      { requestId, ...result },
      { status: 200, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (e) {
    // A failed outbound drain must be visible. Undelivered rows stay queued
    // and are retried with backoff, so nothing is lost — but a silent 500
    // here would look exactly like a quiet, healthy queue.
    return NextResponse.json(
      {
        requestId,
        error: {
          code: "OUTBOUND_DRAIN_FAILED",
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
