/** GET /api/v1/limits — what this API refuses to do, and why. */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { limitsRoute } from "@/lib/api/routes/meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "GET /api/v1/limits",
    readOnly: true,
    run: limitsRoute,
  });
}
