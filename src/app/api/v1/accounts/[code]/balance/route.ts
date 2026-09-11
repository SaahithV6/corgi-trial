/**
 * GET /api/v1/accounts/{code}/balance — ledger, available, and the difference
 * itemised, at any point on either time axis.
 */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { getBalanceRoute } from "@/lib/api/routes/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ code: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { code } = await context.params;
  return handle(request, apiDeps(), {
    name: "GET /api/v1/accounts/{code}/balance",
    readOnly: true,
    run: (ctx) => getBalanceRoute(ctx, code),
  });
}
