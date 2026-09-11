/**
 * GET /api/v1 — the service index.
 *
 * Every file under `src/app/api/v1/**` is this shape: parse the path segment,
 * hand the request to `handle()` with a `RouteSpec`, and nothing else. The
 * gate — body size, authentication, rate limiting, the audit record written in
 * a `finally` on every path out — lives in exactly one place, which is the
 * only way to be sure there is no route that skips it.
 */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { indexRoute } from "@/lib/api/routes/meta";

/** Node runtime: the ledger driver is a TCP Postgres client and the token
 *  comparison uses `node:crypto`'s `timingSafeEqual`. */
export const runtime = "nodejs";

/** A cached answer about someone's money is a wrong answer about it. */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "GET /api/v1",
    readOnly: true,
    run: indexRoute,
  });
}
