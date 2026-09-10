/**
 * GET /api/health — the endpoint that proves this deployment is up.
 *
 * Three facts, and nothing that could make answering them fail:
 *
 *   1. WHICH BUILD is running (git sha from the platform's env, if it set one).
 *   2. WHETHER THE DATABASE IS REACHABLE — a real `select 1` as the restricted
 *      application role, with a hard timeout so a wedged connection cannot make
 *      the health check itself the outage.
 *   3. PER-PROVIDER INTEGRATION STATUS, read from the single catalogue in
 *      `@/lib/webhooks/route-handler` that also builds the verifier registry.
 *      An integration is `live` only when every credential it needs is present;
 *      a missing API key is `not_configured`, always, with no path by which it
 *      could be reported otherwise. Claiming an integration is live when it is
 *      a simulator or a missing key is the fastest way to fail the trial, so
 *      this endpoint reports what it can check and names what it cannot.
 *
 * IT MUST NOT THROW. A monitor that gets a 500 from the health endpoint learns
 * only that the health endpoint is broken. Every failure inside is caught and
 * reported as a 200 with `status: "degraded"` and the reason in the body — the
 * status code says "the process is answering", the body says how well.
 */

import postgres from 'postgres';

import { newRequestId, requestIdFrom } from '@/lib/log';
import { integrationReports, readEnv, type EnvBag } from '@/lib/webhooks/route-handler';

/**
 * Node runtime: this route opens a Postgres connection through `postgres`,
 * which is a TCP driver and needs `node:net`/`node:tls`. It also shares the
 * webhook catalogue module, which pulls in `node:crypto`.
 */
export const runtime = 'nodejs';

/** A cached health answer is a lie about the present. */
export const dynamic = 'force-dynamic';

/**
 * The database probe budget. Short on purpose: this endpoint is polled by
 * uptime monitors and by the deploy pipeline, and a health check that blocks
 * for 30s on a dead database has become the incident.
 */
const DB_TIMEOUT_MS = 2_000;

/**
 * Where each platform puts the commit sha, in the order we trust them. Vercel
 * first because that is where this deploys.
 */
const COMMIT_SHA_ENV = [
  'VERCEL_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'GITHUB_SHA',
  'RAILWAY_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
  'SOURCE_VERSION',
  'HEROKU_SLUG_COMMIT',
] as const;

type CommitReport =
  | { sha: string; shortSha: string; source: string }
  | { sha: null; source: null; note: string };

type DatabaseReport = {
  reachable: boolean;
  /** Env var NAME, never the connection string. */
  urlEnv: 'APP_DATABASE_URL';
  timeoutMs: number;
  latencyMs: number | null;
  error?: string;
};

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
  // Even the request id is defensive: a caller can send anything as
  // x-request-id, and this endpoint must answer regardless.
  let requestId: string;
  try {
    requestId = requestIdFrom(request.headers);
  } catch {
    requestId = newRequestId();
  }

  try {
    const env: EnvBag = process.env;
    const database = await checkDatabase(env);
    const integrations = integrationReports(env);

    // `not_configured` integrations do NOT make the deployment degraded: a
    // provider we have not wired is a scope decision, not an outage. An
    // unreachable database is, because nothing can be stored without it.
    const status = database.reachable ? 'ok' : 'degraded';

    return healthResponse(requestId, {
      status,
      service: 'corgi-neobank',
      checkedAt: new Date().toISOString(),
      commit: commitReport(env),
      runtime: {
        node: process.version,
        nodeEnv: readEnv(env, 'NODE_ENV') ?? 'development',
        uptimeSeconds: Math.round(process.uptime()),
      },
      database,
      integrations: {
        live: integrations.filter((i) => i.status === 'live').length,
        total: integrations.length,
        providers: integrations,
      },
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    // Belt and braces. Nothing above is expected to throw — checkDatabase
    // catches its own failures — but "expected" is not a guarantee, and a
    // health endpoint that 500s tells a monitor nothing useful.
    return healthResponse(requestId, {
      status: 'degraded',
      service: 'corgi-neobank',
      checkedAt: new Date().toISOString(),
      error: {
        code: 'HEALTH_CHECK_FAILED',
        message: error instanceof Error ? error.message : String(error),
      },
      durationMs: Date.now() - startedAt,
    });
  }
}

/** Always 200, never cached, always carrying the request id. */
function healthResponse(requestId: string, body: Record<string, unknown>): Response {
  return Response.json(
    { requestId, ...body },
    {
      // 200 even when degraded: see the module comment. The body is the signal.
      status: 200,
      headers: { 'x-request-id': requestId, 'cache-control': 'no-store' },
    },
  );
}

function commitReport(env: EnvBag): CommitReport {
  for (const key of COMMIT_SHA_ENV) {
    const sha = readEnv(env, key);
    if (sha !== undefined) {
      return { sha, shortSha: sha.slice(0, 7), source: key };
    }
  }
  // Absent locally, and saying so is more useful than inventing a value or
  // shelling out to git from inside a serverless function.
  return {
    sha: null,
    source: null,
    note: `no commit sha in the environment (looked for ${COMMIT_SHA_ENV.join(', ')})`,
  };
}

/**
 * One connection, reused across invocations, connecting as the RESTRICTED
 * `corgi_app` role — `APP_DATABASE_URL`, never `DATABASE_URL`. DECISIONS 008:
 * privileges never bind the table owner, so a health check that proves the
 * OWNER url works has proved the wrong thing.
 */
let cached: { url: string; sql: ReturnType<typeof postgres> } | null = null;

function client(url: string): ReturnType<typeof postgres> {
  if (cached && cached.url === url) return cached.sql;
  const sql = postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: Math.ceil(DB_TIMEOUT_MS / 1000),
    idle_timeout: 20,
    onnotice: () => {},
  });
  cached = { url, sql };
  return sql;
}

async function checkDatabase(env: EnvBag): Promise<DatabaseReport> {
  const base: Omit<DatabaseReport, 'reachable' | 'latencyMs'> = {
    urlEnv: 'APP_DATABASE_URL',
    timeoutMs: DB_TIMEOUT_MS,
  };
  const url = readEnv(env, 'APP_DATABASE_URL');
  if (url === undefined) {
    return {
      ...base,
      reachable: false,
      latencyMs: null,
      error: 'APP_DATABASE_URL is not set',
    };
  }

  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const sql = client(url);
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`database probe exceeded ${DB_TIMEOUT_MS}ms`)),
        DB_TIMEOUT_MS,
      );
    });
    // The cheapest statement that proves a round trip actually happened.
    await Promise.race([sql`select 1 as ok`, timeout]);
    return { ...base, reachable: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    // A dead database degrades the body, never the status code.
    return {
      ...base,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
