import { NextResponse } from "next/server";

import { env } from "@/lib/env";
import { newRequestId, requestIdFrom } from "@/lib/log";
import { drain } from "@/lib/webhooks/drain";

// node:crypto is reached through the ledger and the consumers, and the drain
// holds a database connection. Neither survives the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Drain the webhook inbox.
 *
 * Three callers, and they need different auth:
 *
 *  - Vercel Cron sends `x-vercel-cron`. It is the guarantee that a row is
 *    eventually processed even if every opportunistic nudge is lost.
 *  - An operator, or the demo, sends the bearer token. This is what gets used
 *    in the debrief: "watch, I will drain it now" beats waiting for a timer.
 *  - `after()` in the webhook route calls drain() directly and never comes
 *    through here at all.
 *
 * Draining is idempotent by construction — the dispatcher claims rows under a
 * lease and every consumer is idempotent — so an unauthenticated caller could
 * not corrupt anything. It is still authenticated, because an open endpoint
 * that does real work is free load for anyone who finds it.
 */
function authorised(req: Request): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.DRAIN_TOKEN;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

async function run(req: Request): Promise<NextResponse> {
  const requestId = requestIdFrom(req.headers) ?? newRequestId();
  if (!authorised(req)) {
    return NextResponse.json(
      { requestId, error: { code: "UNAUTHORISED", message: "drain requires the cron header or a bearer token" } },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const result = await drain();
    return NextResponse.json(
      { requestId, ...result },
      { status: 200, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (e) {
    // A failed drain must be visible. The rows stay claimed until their lease
    // expires and are then picked up again, so nothing is lost — but a silent
    // 500 here would look exactly like a quiet, healthy system.
    return NextResponse.json(
      {
        requestId,
        error: { code: "DRAIN_FAILED", message: e instanceof Error ? e.message : "unknown" },
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
