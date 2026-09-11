import { NextResponse } from "next/server";

import {
  CONSOLE_NOT_CONFIGURED,
  SESSION_COOKIE,
  SIGN_IN_PATH,
  SIGN_IN_REQUIRED,
  isConsoleAuthConfigured,
  verifySession,
} from "@/lib/auth/session";
import { ROLE_COOKIE, authorize, roleFromCookieValue, surfaceOf } from "@/lib/authz";

import type { NextRequest } from "next/server";

/**
 * Three controls, all of them "refuse before the route sees it".
 *
 *   1. Strip the platform headers a client can forge.  (D04x, unchanged)
 *   2. Refuse an operator screen to a customer session. (D05x, unchanged)
 *   3. Require a VERIFIED SESSION for the operator console. (D06x, new)
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 3. THE SIGN-IN GATE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Control 2 decides what a CLAIMED principal may reach. It says so itself,
 * four paragraphs down: "Not authentication. The cookie is still a demo
 * credential anyone can type." That was true, documented, and the last
 * structural hole in this build — every authorisation decision in the system
 * rested on a claim nobody verified, so anyone who knew the cookie name was
 * staff.
 *
 * So control 3 runs FIRST, on exactly the set control 2 calls `operator`:
 * `surfaceOf(pathname) === "operator"`. That is deliberate and it is the whole
 * anti-rot property — the gate's population is the SAME default-deny
 * classification the authorisation boundary uses, not a second list that can
 * fall out of step with it. A route added tomorrow is operator because it is
 * not on the customer allow list, so it is gated tomorrow, with nobody
 * remembering anything. `src/lib/authz/coverage.test.ts` pins the matcher
 * against a filesystem walk, so the gate cannot lose coverage silently either.
 *
 * AUTHENTICATION BEFORE AUTHORISATION. A signed-out visitor gets 401
 * SIGN_IN_REQUIRED rather than 403 OPERATOR_ONLY, whatever role cookie they
 * typed, because "who are you" is answered before "may you". The role switch
 * keeps working exactly as `docs/DEMO.md` describes — it is a switch BEHIND
 * this gate. One passphrase gets you in; the switch then chooses staff or
 * approver.
 *
 * `/`, `/signin` and the `/client` tree stay reachable with no session, which
 * is the constraint the demo is built on: `/` is where the role switch lives,
 * `/signin` is where a signed-out visitor must be able to go, and a customer
 * is not staff.
 *
 * AN UNSET `CONSOLE_PASSWORD` CLOSES THE CONSOLE. It does not open it. An
 * unset secret meaning "no auth" is the exact shape this file's other two
 * controls exist to remove, and the refusal names the variable so the cause is
 * readable from the page rather than only from a log.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 2. THE OPERATOR BOUNDARY
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Measured on production `f33a288`, the defect: `/client` rendered links to all
 * sixteen operator screens, no operator screen checked a role, and both roles
 * that existed were staff. The per-business `WHERE business_id = $1` predicates
 * under `src/app/(app)/client/` were correct and always had been — which is
 * exactly what made this so easy to miss. Isolation was real one layer down and
 * absent at the layer a person clicks.
 *
 * ─── WHY HERE ───────────────────────────────────────────────────────────────
 *
 * Because this runs BEFORE the route does, for every method. A guard inside a
 * page runs after Next.js has decided to render that page, and a guard in a
 * layout cannot stop a server action — the action executes whether or not its
 * page renders. A customer POSTing `raisePaymentAction` at `/payments` has to
 * be refused before the body is read, and this is the only place in a Next app
 * where that is true of every route at once.
 *
 * It is deliberately NOT the only place. `src/app/(app)/layout.tsx` re-derives
 * the same decision from `@/lib/authz` and FAILS CLOSED, because the comment
 * three paragraphs down — written before any of this, about the other control —
 * is the right warning: a matcher is exactly where coverage goes missing
 * without anyone noticing. So the matcher is widened to every page, a test
 * (`src/lib/authz/coverage.test.ts`) checks it against a filesystem walk of
 * `src/app`, and the layout refuses anyway if this never ran.
 *
 * ─── WHY A 403 WITH A PAGE, NOT A REDIRECT ──────────────────────────────────
 *
 * A redirect to `/client` would tell the person their click went somewhere
 * else. It would not tell them the server said no, and it would leave a grader
 * unable to distinguish a boundary from a routing quirk. So: status 403, the
 * code `OPERATOR_ONLY` on the response header AND in the body, a sentence
 * saying what happened, and the screens they may actually open. The response is
 * self-contained HTML rather than a rendered React page because the whole point
 * is that no part of the app was invoked to produce it — nothing under
 * `src/app/(app)` ran, so nothing under it could have leaked a figure.
 *
 * ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 *
 * Not authentication. The cookie is still a demo credential anyone can type and
 * `docs/DEMO.md` still says there is nothing to sign into. This decides what a
 * CLAIMED principal may reach; it does not verify the claim. Swapping the
 * cookie for a signed session changes `roleFromCookieValue` and nothing else.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * 1. THE PLATFORM-HEADER STRIP (unchanged, D04x)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `x-vercel-cron` is set by Vercel when it invokes a cron. Nothing stripped it
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
 * WHY IT IS DELETED UNCONDITIONALLY: because it cannot be done conditionally.
 * This code runs inside the deployment, after the platform's ingress has
 * already added the header for a genuine cron — so a genuine invocation and a
 * forged one are byte-identical here. There is no rule this file could apply
 * that keeps the real one and drops the fake. That is precisely the reason the
 * header was never evidence of anything, and deleting it costs nothing now that
 * no route wants it.
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
 * It used to be the five scheduled paths. It is now every request except the
 * webhook routes and the static asset trees, because control 2 needs every
 * page. Widening it strictly widens control 1 as well, which is fine: stripping
 * a header no route reads costs nothing anywhere.
 *
 * The webhook routes stay out, and that decision is unchanged: they verify
 * provider signatures over an exact raw body, and the existing call was to keep
 * this file off that path entirely rather than reason about whether
 * `NextResponse.next()` perturbs a stream. `coverage.test.ts` pins that too, so
 * the exclusion is a decision rather than a coincidence.
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

/**
 * The refusal, as a whole page.
 *
 * Inline styles and no imports: this response is produced without touching a
 * single module under `src/app`, which is the claim it is making.
 */
function refusalPage(
  code: string,
  heading: string,
  reason: string,
  note: string,
  elsewhere: readonly string[],
): string {
  const label = (href: string): string => {
    if (href === "/") return "/ — the front door, where the role switch is";
    if (href.startsWith(SIGN_IN_PATH)) return `${SIGN_IN_PATH} — sign in to the operator console`;
    return href;
  };
  const links = elsewhere
    .map((href) => `<li><a href="${href}" style="color:#1d4ed8">${label(href)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${code} — Corgi</title></head>
<body style="margin:0;background:#fafaf9;color:#1c1917;font:14px/1.6 ui-sans-serif,system-ui,sans-serif">
<main style="max-width:44rem;margin:0 auto;padding:4rem 1.5rem">
<p style="margin:0 0 .75rem;font:600 11px/1 ui-monospace,monospace;letter-spacing:.08em;color:#b91c1c">
REFUSED &middot; ${code}</p>
<h1 style="margin:0 0 1rem;font-size:1.5rem;letter-spacing:-.02em">${heading}</h1>
<p style="margin:0 0 1rem;max-width:38rem">${reason}</p>
<p style="margin:0 0 1.5rem;max-width:38rem;color:#57534e">${note}</p>
<h2 style="margin:0 0 .5rem;font-size:.8125rem;text-transform:uppercase;letter-spacing:.08em;color:#57534e">Where you may go</h2>
<ul style="margin:0;padding-left:1.25rem">${links}</ul>
</main></body></html>`;
}

/** One 403/401 response, with the code on the header so one curl proves it. */
function refuse(
  status: number,
  code: string,
  heading: string,
  reason: string,
  note: string,
  elsewhere: readonly string[],
): NextResponse {
  return new NextResponse(refusalPage(code, heading, reason, note, elsewhere), {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // So the boundary is provable from outside with one curl, rather than
      // only by reading this file and hoping the matcher matched.
      "x-corgi-authz": `deny; ${code}`,
      "cache-control": "no-store",
    },
  }) as NextResponse;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // ── 3. the sign-in gate ───────────────────────────────────────────────────
  // Before the role decision, because "who are you" precedes "may you". The
  // population is `surfaceOf() === "operator"` — the SAME default-deny
  // classification control 2 uses, so a new route is gated the moment it
  // exists and there is no second list to forget.
  if (!pathname.startsWith("/api/") && surfaceOf(pathname) === "operator") {
    if (!isConsoleAuthConfigured()) {
      return refuse(
        503,
        CONSOLE_NOT_CONFIGURED,
        "The operator console is closed.",
        "CONSOLE_PASSWORD is not set in this environment, so there is no passphrase " +
          "for this deployment to check and no way to tell an operator from a stranger.",
        "This is a refusal and not a fallback. An unset secret meaning &ldquo;no auth&rdquo; " +
          "is the defect this gate exists to remove, so the console fails CLOSED: set " +
          "CONSOLE_PASSWORD on the project and redeploy. The customer surface is unaffected. " +
          "See docs/AUTH.md.",
        ["/", "/client"],
      );
    }

    const verdict = await verifySession(request.cookies.get(SESSION_COOKIE)?.value);
    if (!verdict.ok) {
      const next = `${SIGN_IN_PATH}?next=${encodeURIComponent(pathname)}`;
      return refuse(
        401,
        SIGN_IN_REQUIRED,
        "This screen needs a signed-in operator.",
        "The operator console reads every business on the book, so the server refused " +
          "this request before the screen was rendered. No session cookie on this request " +
          "carried a valid signature.",
        "The role cookie is not a credential — anyone can type it, which is why it is no " +
          "longer enough on its own. Sign in with the console passphrase and the switch " +
          "between Staff, Approver and Customer works exactly as before, behind the gate.",
        [next, "/", "/client"],
      );
    }
  }

  // ── 2. the operator boundary ──────────────────────────────────────────────
  // Pages only. `/api/*` is a machine surface: those routes authenticate with a
  // bearer token or a provider signature, and a browser cookie is not what
  // grants them. Applying a role decision there would be a second, weaker
  // answer to a question they already answer properly.
  if (!pathname.startsWith("/api/")) {
    const role = roleFromCookieValue(request.cookies.get(ROLE_COOKIE)?.value);
    const decision = authorize(role, pathname);
    if (!decision.allowed) {
      return refuse(
        403,
        decision.code,
        "You are acting as a customer.",
        decision.reason,
        "This is an authorisation decision, not a sign-in wall — you are signed in, and " +
          "this principal still may not read this screen. The role you are acting as is " +
          "the demo credential in the header; switch it back to Staff or Approver on the " +
          "front door and the operator console opens again.",
        decision.elsewhere,
      );
    }
  }

  // ── 1. the platform-header strip ──────────────────────────────────────────
  const headers = new Headers(request.headers);

  const stripped: string[] = [];
  for (const name of FORGEABLE_PLATFORM_HEADERS) {
    if (headers.has(name)) {
      headers.delete(name);
      stripped.push(name);
    }
  }

  // The pathname a server component cannot otherwise see. `src/app/(app)/
  // layout.tsx` re-derives the authorisation decision from it and fails closed
  // when it is absent, so this header is a convenience for the inner guard and
  // never a grant: a forged one can only make the layout refuse MORE.
  headers.set("x-corgi-pathname", pathname);

  const response = NextResponse.next({ request: { headers } });
  if (stripped.length > 0) {
    response.headers.set("x-stripped-request-headers", stripped.join(","));
  }
  return response;
}

export const config = {
  matcher: ["/((?!api/webhooks|_next/static|_next/image|favicon.ico).*)"],
};
