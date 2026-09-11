/** GET /api/v1/accounts/{code} — one account, by four-digit chart code. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { getAccountRoute } from "@/lib/api/routes/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Params are a Promise in the App Router (Next 15+). */
type Context = { params: Promise<{ code: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { code } = await context.params;
  return handle(request, apiDeps(), {
    name: "GET /api/v1/accounts/{code}",
    readOnly: true,
    run: (ctx) => getAccountRoute(ctx, code),
  });
}
