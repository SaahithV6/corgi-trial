import { createHash, timingSafeEqual } from "node:crypto";

import { logger } from "@/lib/log";

/**
 * Authentication for every scheduled job: `/api/drain` and `/api/cron/*`.
 *
 * ─── WHY THIS FILE EXISTS (D04x) ────────────────────────────────────────────
 *
 * All five scheduled routes used to authorise like this:
 *
 *     if (req.headers.get("x-vercel-cron")) return true;
 *
 * `x-vercel-cron` is set by the platform when it invokes a cron. It is NOT
 * stripped from an inbound request, and this was measured rather than assumed
 * — on 2026-09-11, against the deployed origin, from outside:
 *
 *     curl -i https://corgi-trial-psi.vercel.app/api/drain
 *       -> HTTP/2 401 {"error":{"code":"UNAUTHORISED",...}}
 *
 *     curl -i https://corgi-trial-psi.vercel.app/api/drain -H 'x-vercel-cron: 1'
 *       -> HTTP/2 200 {"claimed":21,"parked":20,"deadLettered":1,...}
 *
 * One header a client can type was the whole gate. Draining is idempotent so
 * the book could not be corrupted, but `/api/cron/accrual` and
 * `/api/cron/standing` POST MONEY, and a stranger who can make a bank's
 * scheduler run on demand chooses WHEN a fee is dated and when a standing
 * order lands. "When" is half of what those two jobs are.
 *
 * ─── THE RULE NOW ───────────────────────────────────────────────────────────
 *
 * A bearer token, always. `x-vercel-cron` grants NOTHING and is not read
 * anywhere in this repo any more — `src/middleware.ts` deletes it from the
 * request before a route handler ever sees it, so a future reader cannot be
 * fooled by it either.
 *
 * Two secrets are accepted, both operator-grade credentials for the same
 * privilege class:
 *
 *  - `CRON_SECRET` — Vercel's own mechanism. When this variable is set on the
 *    project, the platform sends `Authorization: Bearer $CRON_SECRET` on every
 *    cron invocation. That is a verifiable claim; the header alone never was.
 *  - `DRAIN_TOKEN` — the existing operator credential. The demo, `scripts/
 *    coreloop.mjs`, `scripts/redrive.mjs` and the live-fire tests all hold it,
 *    and none of them break.
 *
 * ─── THE DEPLOY REQUIREMENT, SAID LOUDLY ────────────────────────────────────
 *
 * `CRON_SECRET` was NOT set on the Vercel project when this was written
 * (`vercel env ls production` listed 17 variables and it was not among them).
 * Until it is set AND the project is redeployed, Vercel Cron sends no
 * Authorization header at all, and all five schedules will 401.
 *
 * RESOLVED, and re-measured on 2026-09-11 rather than assumed:
 * `vercel env ls production` now lists `CRON_SECRET` (Production, created 4h
 * before the check) and the live production deployment is 2h old — so the
 * running build carries it and the five schedules can authenticate. The
 * refusal side was re-proved from outside on the same day, against
 * https://corgi-trial-psi.vercel.app: all five scheduled paths answered 401
 * to an anonymous GET, to a forged `x-vercel-cron: 1`, and to a wrong bearer,
 * and every response carried `x-stripped-request-headers: x-vercel-cron`,
 * which is the middleware proving from outside that the header was deleted.
 * What is still NOT proved by a call is the ACCEPTING path in production:
 * that would mean running a money-posting cron on the real book on demand,
 * which is not a thing to do to demonstrate a header. It is proved locally
 * instead, by `_auth.test.ts`.
 *
 * That failure is deliberately not silent: every refusal that carries
 * `x-vercel-cron` logs at ERROR with the event `scheduled.auth.refused` and
 * `looksLikePlatformCron: true`, which is exactly the line to grep for in the
 * Vercel log if the queues stop moving. See `docs/SECURITY.md`.
 */

/** Which secret a request proved it held. Never the secret itself. */
export type ScheduledCredential = "CRON_SECRET" | "DRAIN_TOKEN";

export type ScheduledAuthRefusal =
  /** No `Authorization: Bearer …` on the request. */
  | "NO_BEARER"
  /** A bearer was presented and matched neither secret. */
  | "WRONG_BEARER"
  /** Neither `CRON_SECRET` nor `DRAIN_TOKEN` is set in this environment. */
  | "NOT_CONFIGURED";

export type ScheduledAuthVerdict =
  | { readonly ok: true; readonly credential: ScheduledCredential }
  | { readonly ok: false; readonly reason: ScheduledAuthRefusal };

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Both sides are hashed to a fixed 32 bytes first, the same shape
 * `src/lib/mcp/auth.ts` uses: `timingSafeEqual` throws on a length mismatch,
 * and catching that throw would itself be the length oracle.
 */
function holds(presented: string, expected: string | undefined): boolean {
  if (expected === undefined || expected === "") return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Pull the token out of `Authorization: Bearer <token>`, or null. */
function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Decide whether a scheduled job may run, and say so in the log.
 *
 * `job` names the schedule ("drain", "standing", …) and appears on every line
 * so a 401 storm can be attributed to one cron rather than to "the crons".
 */
export function authoriseScheduled(
  req: Request,
  job: string,
  requestId: string,
): ScheduledAuthVerdict {
  const log = logger({ requestId, base: { job } });

  // Recorded only so a misconfiguration is diagnosable. It is never a grant:
  // `src/middleware.ts` strips this header, so on a deployed request it is
  // absent whether the caller is Vercel Cron or a stranger with curl.
  const looksLikePlatformCron = req.headers.get("x-vercel-cron") !== null;

  const cronSecret = process.env.CRON_SECRET;
  const drainToken = process.env.DRAIN_TOKEN;

  const presented = bearer(req);

  let verdict: ScheduledAuthVerdict;
  if (cronSecret === undefined && drainToken === undefined) {
    // Fail closed. An unconfigured environment is not an open one.
    verdict = { ok: false, reason: "NOT_CONFIGURED" };
  } else if (presented === null) {
    verdict = { ok: false, reason: "NO_BEARER" };
  } else if (holds(presented, cronSecret)) {
    verdict = { ok: true, credential: "CRON_SECRET" };
  } else if (holds(presented, drainToken)) {
    verdict = { ok: true, credential: "DRAIN_TOKEN" };
  } else {
    verdict = { ok: false, reason: "WRONG_BEARER" };
  }

  if (verdict.ok) {
    log.info("scheduled.auth.accepted", { credential: verdict.credential });
    return verdict;
  }

  // ERROR, not WARN, when the request looks like the platform's own cron:
  // that combination means the schedule is now a no-op and somebody has to
  // know. A stranger probing the endpoint cannot manufacture this line,
  // because the middleware removed the header before the route ran.
  const fields = {
    reason: verdict.reason,
    looksLikePlatformCron,
    // Named to dodge the logger's own redaction list: a key containing
    // "secret" or "token" has its value replaced with "[redacted]", which
    // would turn these two diagnostics into noise.
    cronCredentialConfigured: cronSecret !== undefined,
    operatorCredentialConfigured: drainToken !== undefined,
    ...(looksLikePlatformCron || verdict.reason === "NOT_CONFIGURED"
      ? {
          hint:
            "Vercel Cron only sends Authorization: Bearer $CRON_SECRET when CRON_SECRET " +
            "is set on the project. Set it and redeploy, or this schedule will not run. " +
            "See docs/SECURITY.md.",
        }
      : {}),
  };
  if (looksLikePlatformCron || verdict.reason === "NOT_CONFIGURED") {
    log.error("scheduled.auth.refused", fields);
  } else {
    log.warn("scheduled.auth.refused", fields);
  }
  return verdict;
}

/**
 * The refusal body. Deliberately says nothing about which secret is set or
 * missing: the operator learns that from the log line above, and the internet
 * does not learn it at all.
 */
export function unauthorisedBody(requestId: string, what: string): {
  requestId: string;
  error: { code: "UNAUTHORISED"; message: string };
} {
  return {
    requestId,
    error: { code: "UNAUTHORISED", message: `${what} requires a bearer token` },
  };
}

/** The headers every refusal carries. */
export const REFUSAL_HEADERS = {
  "cache-control": "no-store",
  "www-authenticate": 'Bearer realm="scheduled-jobs"',
} as const;
