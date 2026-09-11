/** GET /api/v1/statements — closed business days worth opening. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { listStatementsRoute } from "@/lib/api/routes/statements";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "GET /api/v1/statements",
    readOnly: true,
    run: listStatementsRoute,
  });
}
