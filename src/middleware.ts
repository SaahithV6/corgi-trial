import { NextResponse } from "next/server";

import type { NextRequest } from "next/server";

/**
 * Strip the platform headers a client can forge, before any route sees them.
 *
 * ─── WHY (D04x) ─────────────────────────────────────────────────────────────
 *
 * `x-vercel-cron` is set by Vercel when it invokes a cron. Nothing strips it
 * from an inbound request — measured, not assumed, on 2026-09-11 against the
 * deployed origin: the same GET to `/api/drain` returned 401 without the
 * header and 200 with `x-vercel-cron: 1`, having claimed 21 rows. Five routes
 * that move money or state authorised on exactly that header.
 *
 * The routes no longer read it (`src/app/api/cron/_auth.ts` requires a bearer
 * token, always). This file is the second layer: the header is DELETED from
 * the request, so a future reader cannot be fooled by it either, and the
 * guarantee does not rest on every author remembering why it is untrustworthy.
 *
 * ─── WHY IT IS DELETED UNCONDITIONALLY ──────────────────────────────────────
 *
 * Because it cannot be done conditionally. This code runs inside the
 * deployment, after the platform's ingress has already added the header for a
 * genuine cron — so a genuine invocation and a forged one are byte-identical
 * here. There is no rule this file could apply that keeps the real one and
 * drops the fake. That is precisely the reason the header was never evidence
 * of anything, and deleting it costs nothing now that no route wants it.
 *
 * Not stripped, deliberately: `x-vercel-id` (`requestIdFrom()` uses it to keep
 * a trace across the edge) and `x-vercel-forwarded-for` (`src/lib/webhooks/
 * refusals.ts` uses it to attribute a source IP). Both are equally forgeable
 * and both are used only for observability, never for a grant — but they are
 * also indistinguishable from the real thing here, so stripping them would
 * destroy real diagnostics to prevent a fake log line. Noted in
 * docs/SECURITY.md rather than silently "fixed".
 *
 * ─── MATCHER SCOPE ──────────────────────────────────────────────────────────
 *
 * The five scheduled paths only. The webhook routes verify provider
 * signatures over an exact raw body and are left entirely out of this
 * request's path. If a new route ever reads a platform header, add it here —
 * the Next.js docs warn that a matcher is exactly where coverage goes missing
 * without anyone noticing, which is why the bearer check in the route, not
 * this file, is the control that actually holds.
 *
 * ─── FILE NAME ──────────────────────────────────────────────────────────────
 *
 * Next.js 16 renamed this convention to `proxy.ts` and `middleware.ts` is
 * deprecated (it still resolves — `next/dist/build/index.js` accepts both and
 * emits a `warnOnce`; having BOTH files is a hard error). Renaming it is a
 * mechanical follow-up: `npx @next/codemod@canary middleware-to-proxy .`
 */

/** Headers the platform sets, which a client can also simply type. */
const FORGEABLE_PLATFORM_HEADERS = ["x-vercel-cron"] as const;

export function middleware(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);

  const stripped: string[] = [];
  for (const name of FORGEABLE_PLATFORM_HEADERS) {
    if (headers.has(name)) {
      headers.delete(name);
      stripped.push(name);
    }
  }

  if (stripped.length === 0) return NextResponse.next();

  const response = NextResponse.next({ request: { headers } });
  // So the control is provable from outside with one curl, rather than only
  // by reading this file and hoping the matcher matched.
  response.headers.set("x-stripped-request-headers", stripped.join(","));
  return response;
}

export const config = {
  matcher: ["/api/drain", "/api/cron/:path*"],
};
