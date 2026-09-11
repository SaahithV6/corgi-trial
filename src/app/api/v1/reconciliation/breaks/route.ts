/** GET /api/v1/reconciliation/breaks — where the file and the ledger disagree. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { listBreaksRoute } from "@/lib/api/routes/reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "GET /api/v1/reconciliation/breaks",
    readOnly: true,
    run: listBreaksRoute,
  });
}
