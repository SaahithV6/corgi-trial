/** GET /api/v1/transactions — the ledger, filtered, newest first. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { listTransactionsRoute } from "@/lib/api/routes/transactions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "GET /api/v1/transactions",
    readOnly: true,
    run: listTransactionsRoute,
  });
}
