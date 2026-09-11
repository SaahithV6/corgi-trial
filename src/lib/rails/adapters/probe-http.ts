/**
 * The one authenticated round trip every HTTP rail's `probe` is made of.
 *
 * Three of the four money adapters prove liveness the same way — one cheap
 * authenticated GET, a timeout, and a status mapped onto a verdict — and
 * before this file that code existed once per slot inside
 * `src/lib/integrations/probe.ts`. The fetches themselves must stay per-rail
 * (only the Lithic adapter knows Lithic sends the key bare in `Authorization`
 * while Increase wants `Bearer`), but the timing, the abort and the status
 * table are not per-rail and never were.
 *
 * ─── THE STATUS TABLE IS ENUMERATED, NOT BRACKETED ──────────────────────────
 *
 * Copied deliberately from probe.ts, whose comment records the measurements
 * that produced it and the five successive bugs in the bracketed version:
 *
 *   2xx            live — the credential was accepted
 *   400/409/422    live — the request was AUTHENTICATED, reached the
 *                  application and was rejected on its CONTENT. This is the
 *                  only 4xx shape that evidences a working credential.
 *   401/403        unauthorised — the credential exists and was refused. This
 *                  is the pasted-placeholder case and it must never read live.
 *   429            rate_limited — its own verdict. The credential was never
 *                  evaluated, and "the provider had a bad afternoon" and "we
 *                  are polling harder than the provider permits" call for
 *                  opposite responses.
 *   404/408        unreachable — measured at Lithic: `/v1/not_a_real_endpoint`
 *                  answers 404 WITH a valid key and 404 with no Authorization
 *                  header at all, so a typo in a URL used to read as live.
 *   anything else  unreachable — the verdict that claims least.
 *
 * The `Liveness` vocabulary and this table are asserted identical to probe.ts's
 * in `../contract.test.ts`, so the copy cannot quietly drift into a second
 * opinion about what a 429 means.
 */

import type { RailLiveness } from '../contract';

export const DEFAULT_PROBE_TIMEOUT_MS = 4000;

export function livenessFromStatus(status: number): RailLiveness {
  if (status >= 200 && status < 300) return 'live';
  if (status === 401 || status === 403) return 'unauthorised';
  if (status === 400 || status === 409 || status === 422) return 'live';
  if (status === 429) return 'rate_limited';
  return 'unreachable';
}

export interface TimedFetchResult {
  readonly res: Response | null;
  readonly ms: number;
  readonly err: string | null;
}

/**
 * Fetch with a hard ceiling, and never a rejection.
 *
 * A probe that throws is a probe that takes a health surface down with it, so
 * a network failure comes back as `{ res: null, err }` and the caller turns it
 * into `unreachable` — the honest verdict, which claims nothing in either
 * direction.
 *
 * The caller's own `signal` is honoured alongside the timeout: a request that
 * is aborted because the page was closed should not wait four seconds first.
 */
export async function timedFetch(
  url: string,
  init: RequestInit,
  opts: {
    readonly fetchImpl?: typeof fetch | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<TimedFetchResult> {
  const impl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const onOuterAbort = (): void => ac.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  const started = Date.now();
  try {
    const res = await impl(url, { ...init, signal: ac.signal });
    return { res, ms: Date.now() - started, err: null };
  } catch (error) {
    return {
      res: null,
      ms: Date.now() - started,
      err: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** Trimmed, or undefined. An empty string is a missing value, not a value. */
export function readEnvValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
