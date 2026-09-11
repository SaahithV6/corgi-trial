/** GET /api/v1/accounts — every account this token can name. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { listAccountsRoute } from "@/lib/api/routes/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "GET /api/v1/accounts",
    readOnly: true,
    run: listAccountsRoute,
  });
}
