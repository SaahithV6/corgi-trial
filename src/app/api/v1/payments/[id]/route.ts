/** GET /api/v1/payments/{id} — one instruction with its whole event stream. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { getPaymentRoute } from "@/lib/api/routes/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  const { id } = await context.params;
  return handle(request, apiDeps(), {
    name: "GET /api/v1/payments/{id}",
    readOnly: true,
    run: (ctx) => getPaymentRoute(ctx, id),
  });
}
