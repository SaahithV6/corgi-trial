/** GET /api/v1/payees — the payee book. Read-only; see GET /api/v1/limits A8. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { listPayeesRoute } from "@/lib/api/routes/payees";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "GET /api/v1/payees",
    readOnly: true,
    run: listPayeesRoute,
  });
}
