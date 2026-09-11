/**
 * GET /api/v1/statements/{business_date} — as published AND as corrected.
 *
 * There is deliberately no POST here. Closing a day freezes the watermark
 * every statement for that day is derived from, and publishing is telling a
 * customer what their money did; both are acts of a named person. See
 * GET /api/v1/limits, refusal A7.
 */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { getStatementRoute } from "@/lib/api/routes/statements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ business_date: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { business_date: businessDate } = await context.params;
  return handle(request, apiDeps(), {
    name: "GET /api/v1/statements/{business_date}",
    readOnly: true,
    run: (ctx) => getStatementRoute(ctx, businessDate),
  });
}
