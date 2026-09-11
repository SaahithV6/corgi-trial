/**
 * The two things this system needs from Lithic about ASA itself: the HMAC
 * secret it signs with, and whether it is enrolled to call us at all.
 *
 * SERVER ONLY by convention — it reads `LITHIC_API_KEY` at call time, never at
 * import. (`server-only` is deliberately not imported, matching
 * `src/lib/rails/lithic/client.ts`, so the module stays testable under
 * vitest's node environment.)
 *
 * ─── Why this does not go through `rails/lithic/client.ts` ──────────────────
 *
 * That client is the right thing for every other Lithic call and it is used
 * unchanged everywhere else. It is the wrong thing HERE for one reason: it
 * paces every request through `./ratelimit.ts`, because the sandbox simulate
 * endpoints 429 the moment two calls race. Pacing is exactly right for a
 * background job and exactly wrong on a path where a cardholder is standing at
 * a terminal — a shared limiter turns "one extra request" into "queue behind
 * whatever else the instance was doing". So the secret fetch is a bare `fetch`
 * with its own deadline, it happens at most once per instance per TTL, and it
 * is on the critical path only on a cold start.
 *
 * ─── Why the secret is fetched and not configured ───────────────────────────
 *
 * ASA has its own HMAC secret, distinct from `LITHIC_WEBHOOK_SECRET`, and it
 * is not in the environment. It could have been added there; it was not, and
 * the reason is worth stating because "we could not edit .env" is not one. A
 * secret retrieved with the API key we already hold is one fewer secret to
 * distribute, one fewer thing to forget during a rotation, and — because
 * `POST /v1/auth_stream/secret/rotate` deactivates the old key 24 hours later
 * rather than instantly — a cache with a TTL picks a rotation up on its own
 * inside that window. An environment variable would need a redeploy.
 *
 * The cost is a dependency: if Lithic's API is unreachable on a cold instance
 * we cannot verify a signature, and an unverifiable request must not be
 * allowed to approve a card payment. That is a decline, recorded with the
 * reason. It is the same fail-closed argument as `./decide.ts` rule 1, applied
 * to authentication rather than to authorisation.
 */

import { SECRET_FETCH_BUDGET_MS, withDeadline } from "./budget";

const SANDBOX_BASE = "https://sandbox.lithic.com/v1";

/**
 * Ten minutes. Long enough that a busy instance fetches once an hour rather
 * than once a minute; short enough that a rotation is picked up well inside
 * the 24 hours Lithic keeps the old secret alive.
 */
const SECRET_TTL_MS = 10 * 60 * 1000;

function baseUrl(): string {
  return process.env["LITHIC_BASE_URL"] ?? SANDBOX_BASE;
}

function apiKey(): string | null {
  const key = process.env["LITHIC_API_KEY"];
  return key === undefined || key === "" ? null : key;
}

type SecretCache = {
  readonly value: readonly string[];
  readonly fetchedAt: number;
};

let cache: SecretCache | null = null;
/** In-flight dedupe: a cold instance taking two ASA calls fetches once. */
let inflight: Promise<readonly string[]> | null = null;

/** Test seam. Never called in production code. */
export function __resetAsaSecretCache(): void {
  cache = null;
  inflight = null;
}

/**
 * The secrets an ASA signature may be verified against, newest first.
 *
 * Returns a LIST, not a value, because `standardWebhooksVerifier` accepts
 * several and a rotation window is exactly when a single-secret verifier
 * starts rejecting real deliveries. Today the list is Lithic's ASA secret
 * alone; during a rotation it is whatever `GET /v1/auth_stream/secret` returns
 * plus whatever we still had cached.
 *
 * Never logs, never returns the value in an error, and never throws a string
 * containing it.
 */
export async function asaSecrets(now: number = Date.now()): Promise<readonly string[]> {
  if (cache !== null && now - cache.fetchedAt < SECRET_TTL_MS) return cache.value;
  if (inflight !== null) return inflight;

  const previous = cache?.value ?? [];

  inflight = (async () => {
    try {
      const fetched = await withDeadline(
        fetchAsaSecret(),
        SECRET_FETCH_BUDGET_MS,
        "ASA secret fetch",
      );
      const merged = [fetched, ...previous.filter((s) => s !== fetched)].slice(0, 2);
      cache = { value: merged, fetchedAt: Date.now() };
      return merged;
    } catch {
      // A stale secret is still a real secret: Lithic keeps a rotated one alive
      // for 24 hours, so serving the cached list through a brief API outage is
      // strictly better than refusing to verify. If there is no cache at all
      // the empty list propagates and `verifyAsaSignature` refuses, which is
      // the fail-closed answer.
      if (previous.length > 0) return previous;
      return [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

async function fetchAsaSecret(): Promise<string> {
  const key = apiKey();
  if (key === null) throw new Error("LITHIC_API_KEY is not set");

  const response = await fetch(`${baseUrl()}/auth_stream/secret`, {
    method: "GET",
    headers: { authorization: key, accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GET /v1/auth_stream/secret returned ${response.status}`);
  }
  const body: unknown = await response.json();
  const secret =
    typeof body === "object" && body !== null && "secret" in body
      ? (body as { secret: unknown }).secret
      : null;
  if (typeof secret !== "string" || secret === "") {
    throw new Error("GET /v1/auth_stream/secret returned no secret");
  }
  return secret;
}

/* -------------------------------------------------------------------------- */
/* Enrollment                                                                 */
/* -------------------------------------------------------------------------- */

export type AsaEnrollment =
  | { readonly status: "enrolled"; readonly url: string | null }
  | { readonly status: "not_enrolled" }
  | { readonly status: "unknown"; readonly detail: string };

/**
 * Is Lithic actually configured to call us?
 *
 * This exists so the console can state the answer instead of implying it. A
 * screen that renders a decision history is indistinguishable, to a reader,
 * from a screen that renders a decision history the provider drove — unless it
 * says which, from the provider's own mouth. `GET
 * /v1/responder_endpoints?type=AUTH_STREAM_ACCESS` is the provider's mouth.
 *
 * NOT on the ASA hot path. It is called from a page render, behind its own
 * Suspense boundary, with its own short deadline, and `unknown` is a rendered
 * state rather than an error — a provider we cannot reach must not blank a
 * screen whose subject is what happens when a provider cannot be reached.
 */
export async function readAsaEnrollment(timeoutMs = 3_000): Promise<AsaEnrollment> {
  const key = apiKey();
  if (key === null) return { status: "unknown", detail: "LITHIC_API_KEY is not set" };

  try {
    const response = await fetch(
      `${baseUrl()}/responder_endpoints?type=AUTH_STREAM_ACCESS`,
      {
        method: "GET",
        headers: { authorization: key, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      return {
        status: "unknown",
        detail: `GET /v1/responder_endpoints returned ${response.status}`,
      };
    }
    const body = (await response.json()) as { enrolled?: unknown; url?: unknown };
    if (body.enrolled !== true) return { status: "not_enrolled" };
    return { status: "enrolled", url: typeof body.url === "string" ? body.url : null };
  } catch (thrown) {
    return {
      status: "unknown",
      detail: thrown instanceof Error ? thrown.message : "the enrollment probe failed",
    };
  }
}
