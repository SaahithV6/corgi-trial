/**
 * `card_webhooks` — the probe that slot did not have.
 *
 * WHAT THIS SLOT ACTUALLY CLAIMS
 * ------------------------------
 * Not "we hold a signing secret". The claim is: *Lithic is registered to
 * deliver card events to THIS deployment, and those deliveries are landing.*
 * DECISIONS 015/016/017 state the rule three times and it is the one that
 * matters here — probe with the call the slot's real work depends on, and
 * confirm it fails when the capability is absent. `LITHIC_WEBHOOK_SECRET`
 * being a non-empty string is not that call. It was what made this slot read
 * LIVE in the first place (DECISIONS 026), and `unprobed` was the right answer
 * for as long as no round trip existed. This module is that round trip.
 *
 * TWO CALLS, MEASURED AGAINST THE SANDBOX BEFORE A LINE OF THIS WAS WRITTEN
 * ------------------------------------------------------------------------
 *   GET /v1/event_subscriptions                       -> 200
 *   GET /v1/event_subscriptions/{token}/attempts      -> 200
 *
 * The first proves a subscription exists, is not disabled, and — the part that
 * makes this a fact about OUR system rather than about the Lithic account —
 * points at our own webhook URL. The second is Lithic's own record of what
 * happened when it tried to deliver: the status it got back from our endpoint,
 * for every attempt, newest first.
 *
 * That second call is the whole reason this probe can say something true. Every
 * other probe in this module reaches OUTWARD and proves a credential is
 * accepted. The webhook leg runs the other way, and nothing on our side of the
 * wire can distinguish "Lithic never sent it" from "Lithic sent it and we
 * answered 500". Lithic's attempt log distinguishes them exactly, and it has
 * the receipts for the DECISIONS 020 inbox bug to prove it:
 *
 *   2026-09-10T16:18:43.004Z  FAILED   500  WEBHOOK_INBOX_UNAVAILABLE
 *   2026-09-10T16:18:47.680Z  FAILED   500  WEBHOOK_INBOX_UNAVAILABLE
 *   2026-09-10T18:40:36.424Z  SUCCESS  202  {"status":"accepted", ...}
 *
 * WHY THE SUCCESSFUL ATTEMPT IS END-TO-END PROOF, NOT JUST A PING
 * --------------------------------------------------------------
 * `/api/webhooks/lithic` verifies the Standard Webhooks signature before it
 * does anything else and answers 401 when it cannot (measured in DECISIONS 020,
 * where two replays with stripped headers were refused). So a `SUCCESS` attempt
 * carrying a 2xx from our own URL is a delivery that Lithic signed with the
 * secret it holds and our deployment verified with the secret WE hold. Both
 * halves of the pair are exercised by a third party. That is a materially
 * stronger claim than any outbound call could make.
 *
 * WHAT THIS PROBE DELIBERATELY DOES NOT ANSWER
 * --------------------------------------------
 * Freshness. `./delivery-health.ts` owns "when did we last accept a delivery",
 * reads it from `webhook_inbox.received_at`, and has a per-provider threshold
 * ladder (Lithic: stale after 180s, quiet after 900s) with an argument behind
 * every number. DECISIONS 021 is what happens when `/api/health` grows two
 * opinions about one question, so this probe has no clock and no recency rule:
 * it asks whether the subscription is wired and whether Lithic's attempts are
 * being accepted, never how long ago. The two compose into the distinction
 * neither can draw alone:
 *
 *   probe live     + delivery fresh  loop healthy
 *   probe live     + delivery stale  Lithic has gone quiet; we are ready
 *   probe degraded + delivery stale  Lithic is DELIVERING and we are REFUSING
 *   probe degraded + delivery never  never wired up (or wired elsewhere)
 *
 * Row three is the 16:18 outage above, and delivery-health alone renders it
 * identically to row two.
 *
 * It also does not re-derive whether a verifier is registered. `/api/health`
 * already computes that from the webhook catalogue and hands it to
 * delivery-health; a second derivation here would be the same fact stated twice
 * in different words, which is precisely the DECISIONS 021 shape.
 *
 * THE ASYMMETRY IS PRESERVED
 * --------------------------
 * Every branch below that is not a proven, accepted delivery degrades to
 * SIMULATED with the reason stated. Over-claiming is the automatic fail;
 * under-claiming is only pessimistic.
 */

import {
  LithicApiError,
  listEventSubscriptionAttempts,
  listEventSubscriptions,
  type EventSubscription,
  type EventSubscriptionAttempt,
} from '@/lib/rails/lithic/client';

import type { Liveness } from '../probe';

/** The route Lithic was registered against. One path, one place. */
export const LITHIC_WEBHOOK_PATH = '/api/webhooks/lithic';

/**
 * The production origin, as a last resort when nothing in the environment says
 * otherwise. Already hardcoded in `scripts/audit-claims.mjs`, `scripts/livefire.mjs`
 * and `scripts/verify-demo.mjs`; repeated rather than imported because those are
 * `.mjs` operator CLIs outside the app's module graph.
 */
export const DEFAULT_DEPLOYMENT_ORIGIN = 'https://corgi-trial-psi.vercel.app';

/** Total wall-clock budget for BOTH calls, matching `probe.ts`'s per-slot 4s. */
export const WEBHOOK_PROBE_TIMEOUT_MS = 4_000;

/** How much delivery history to sample. Newest first, so 10 is plenty. */
export const ATTEMPT_SAMPLE_SIZE = 10;

export interface WebhookUrlResolution {
  readonly url: string;
  /** Which variable decided it. Shipped in the evidence so it can be challenged. */
  readonly source: string;
}

/**
 * Which URL do we believe is ours?
 *
 * `VERCEL_URL` is DELIBERATELY NOT CONSULTED, and this is the subtle one.
 * On Vercel it holds the *deployment-specific* host (`corgi-trial-<hash>.vercel.app`),
 * which is not the host any webhook was ever registered against. Matching on it
 * would report "no subscription points at us" on every preview and on every
 * production deployment that happens to be addressed by its immutable URL —
 * a false degraded, produced by the probe misidentifying its own system.
 * `VERCEL_PROJECT_PRODUCTION_URL` is the stable production host and is the one
 * Lithic actually holds.
 *
 * `ProviderHealthBanner` prefers `VERCEL_URL` because it is fetching ITSELF,
 * where addressing this exact deployment is the correct behaviour. Here the
 * question is the opposite one, so the order is too.
 */
export function resolveWebhookUrl(
  processEnv: Record<string, string | undefined> = process.env,
): WebhookUrlResolution {
  const explicit = processEnv['LITHIC_WEBHOOK_URL'];
  if (explicit !== undefined && explicit.length > 0) {
    return { url: explicit, source: 'LITHIC_WEBHOOK_URL' };
  }
  const productionHost = processEnv['VERCEL_PROJECT_PRODUCTION_URL'];
  if (productionHost !== undefined && productionHost.length > 0) {
    return {
      url: `https://${productionHost}${LITHIC_WEBHOOK_PATH}`,
      source: 'VERCEL_PROJECT_PRODUCTION_URL',
    };
  }
  const base = processEnv['APP_BASE_URL'];
  if (base !== undefined && base.length > 0) {
    return { url: `${trimSlash(base)}${LITHIC_WEBHOOK_PATH}`, source: 'APP_BASE_URL' };
  }
  return { url: `${DEFAULT_DEPLOYMENT_ORIGIN}${LITHIC_WEBHOOK_PATH}`, source: 'built-in default' };
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Compare two endpoint URLs the way an operator would: scheme, host and path,
 * case-insensitively on the host, indifferent to a trailing slash and to query
 * or fragment noise. Falls back to a trimmed string compare for anything that
 * will not parse, rather than throwing inside a health check.
 */
export function sameEndpoint(a: string, b: string): boolean {
  const norm = (value: string): string => {
    try {
      const u = new URL(value);
      return `${u.protocol}//${u.host.toLowerCase()}${trimSlash(u.pathname)}`;
    } catch {
      return trimSlash(value.trim().toLowerCase());
    }
  };
  return norm(a) === norm(b);
}

/* ────────────────────────────────────────────────────────────────────────────
 * The verdict — pure, so every branch is reachable from a test rather than
 * from an outage. `probe.ts` learned that lesson the expensive way: four
 * probes shipped green and lying because nobody had watched them fail.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface WebhookProbeFacts {
  /** The URL we believe is ours, and how we decided. */
  readonly expected: WebhookUrlResolution;
  /** Everything `GET /v1/event_subscriptions` returned. */
  readonly subscriptions: readonly EventSubscription[];
  /**
   * The matched subscription's attempts, NEWEST FIRST — null when we did not
   * get as far as asking.
   */
  readonly attempts: readonly EventSubscriptionAttempt[] | null;
  /** Statuses, verbatim, for the evidence string. */
  readonly subscriptionsStatus: number;
  readonly attemptsStatus: number | null;
}

export interface WebhookVerdict {
  readonly liveness: Liveness;
  readonly detail: string;
  /** The subscription this verdict is about, when one was found. */
  readonly subscriptionToken: string | null;
}

const SUBS_CALL = 'GET /v1/event_subscriptions';

function attemptsCall(token: string): string {
  return `GET /v1/event_subscriptions/${token}/attempts`;
}

/** `PENDING` and `SENDING` are a delivery in flight, not an outcome. */
function isTerminal(attempt: EventSubscriptionAttempt): boolean {
  return attempt.status === 'SUCCESS' || attempt.status === 'FAILED';
}

export function judgeWebhookSubscription(facts: WebhookProbeFacts): WebhookVerdict {
  const { expected, subscriptions } = facts;
  const subs = `${SUBS_CALL} -> ${facts.subscriptionsStatus}`;

  const mine = subscriptions.find((s) => sameEndpoint(s.url, expected.url));
  if (mine === undefined) {
    // The check that makes this a proof about THIS system. A Lithic account can
    // carry any number of subscriptions belonging to anyone; none of them is
    // evidence that events reach us.
    const detail =
      subscriptions.length === 0
        ? `${subs} but no webhook endpoint is registered on this account — nothing will ever be delivered to ${expected.url} (${expected.source})`
        : `${subs}: ${subscriptions.length} subscription(s) registered, none at ${expected.url} (${expected.source}) — the account has webhooks, this deployment does not`;
    return { liveness: 'unauthorised', detail, subscriptionToken: null };
  }

  if (mine.disabled) {
    return {
      liveness: 'unauthorised',
      detail: `${subs}: subscription ${mine.token} is registered at ${expected.url} but DISABLED — Lithic delivers nothing to it`,
      subscriptionToken: mine.token,
    };
  }

  const attempts = facts.attempts;
  if (attempts === null || facts.attemptsStatus === null) {
    return {
      liveness: 'unreachable',
      detail: `${subs}: subscription ${mine.token} is enabled at ${expected.url}, but its delivery history could not be read — registration alone is not delivery`,
      subscriptionToken: mine.token,
    };
  }

  const att = `${attemptsCall(mine.token)} -> ${facts.attemptsStatus}`;

  if (attempts.length === 0) {
    // Registered, enabled, and never once used. Honest and NOT live: a
    // subscription that has never delivered has proven nothing about the
    // inbound leg. This is the row delivery-health reports as `never`, seen
    // from the provider's side, and the two agree by construction.
    return {
      liveness: 'unauthorised',
      detail: `${subs}, ${att}: enabled at ${expected.url} but Lithic has recorded NO delivery attempt — registration is not delivery`,
      subscriptionToken: mine.token,
    };
  }

  const newestTerminal = attempts.find(isTerminal);
  const inFlight = attempts[0] !== undefined && !isTerminal(attempts[0]);

  if (newestTerminal === undefined) {
    // Every sampled attempt is still PENDING/SENDING. Nothing has come back
    // yet, so nothing is proven yet.
    return {
      liveness: 'unreachable',
      detail: `${subs}, ${att}: enabled at ${expected.url}; all ${attempts.length} recent attempts are still in flight (${attempts[0]?.status ?? 'unknown'}) — no outcome to judge`,
      subscriptionToken: mine.token,
    };
  }

  if (newestTerminal.status === 'FAILED') {
    // The case that makes the whole probe worth having. Lithic is holding up
    // its end and OUR endpoint is refusing the delivery — which from
    // `webhook_inbox` is indistinguishable from Lithic having gone silent.
    const code = newestTerminal.response_status_code;
    return {
      liveness: 'unauthorised',
      detail: `${subs}, ${att}: enabled at ${expected.url} but Lithic's most recent delivery was REJECTED by us (HTTP ${code ?? 'no response'}) at ${newestTerminal.created} — the subscription works, our endpoint does not`,
      subscriptionToken: mine.token,
    };
  }

  const code = newestTerminal.response_status_code;
  const flight = inFlight ? `, ${attempts[0]?.status.toLowerCase() ?? 'in-flight'} retry outstanding` : '';
  return {
    liveness: 'live',
    detail: `${subs}, ${att}: subscription ${mine.token} enabled at ${expected.url} (${expected.source}); latest delivery SUCCESS, our endpoint answered HTTP ${code ?? '2xx'} at ${newestTerminal.created}${flight}`,
    subscriptionToken: mine.token,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * The round trip
 * ──────────────────────────────────────────────────────────────────────────── */

export interface WebhookProbeOptions {
  readonly apiKey?: string | undefined;
  /** Only consulted to choose between `unprobed` and `not_configured`. */
  readonly webhookSecret?: string | undefined;
  readonly processEnv?: Record<string, string | undefined> | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface WebhookProbeResult {
  readonly liveness: Liveness;
  readonly detail: string;
  readonly ms: number;
}

function statusOf(error: unknown): number | null {
  return error instanceof LithicApiError ? error.status : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Two GETs under ONE shared 4s budget, because `/api/health` gives the whole
 * probe set 4s and two independent 4s timeouts would quietly double it.
 * `maxRateLimitRetries: 0` for the same reason: a 429 back-off inside a health
 * check spends the budget it was given to answer with.
 */
export async function probeLithicWebhooks(
  options: WebhookProbeOptions = {},
): Promise<WebhookProbeResult> {
  const processEnv = options.processEnv ?? process.env;
  const apiKey = options.apiKey ?? processEnv['LITHIC_API_KEY'];
  const secret = options.webhookSecret ?? processEnv['LITHIC_WEBHOOK_SECRET'];

  if (apiKey === undefined || apiKey.length === 0) {
    // The slot's declared key is LITHIC_WEBHOOK_SECRET, but the subscription is
    // readable only with the API key. With the secret and no key we are exactly
    // where DECISIONS 026 left this slot — a credential present and nothing
    // proven — so we say so instead of inheriting a status from a string.
    return secret !== undefined && secret.length > 0
      ? {
          liveness: 'unprobed',
          detail:
            'LITHIC_WEBHOOK_SECRET present but LITHIC_API_KEY absent — the subscription cannot be read, so no round trip proves this slot works',
          ms: 0,
        }
      : { liveness: 'not_configured', detail: 'LITHIC_WEBHOOK_SECRET absent', ms: 0 };
  }

  const budget = options.timeoutMs ?? WEBHOOK_PROBE_TIMEOUT_MS;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);
  const remaining = (): number => Math.max(budget - (Date.now() - started), 1);

  const base = {
    apiKey,
    signal: controller.signal,
    maxRateLimitRetries: 0,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  };

  try {
    let subscriptions: readonly EventSubscription[];
    try {
      const page = await listEventSubscriptions(
        { page_size: 100 },
        { ...base, timeoutMs: remaining() },
      );
      subscriptions = page.data ?? [];
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        return {
          liveness: 'unauthorised',
          detail: `${SUBS_CALL} -> ${status} (credential rejected)`,
          ms: Date.now() - started,
        };
      }
      return {
        liveness: 'unreachable',
        detail:
          // 0 IS NOT A STATUS. `LithicTransportError` uses it to mean WE DO NOT
          // KNOW WHAT THE PROVIDER DID — DNS failure, reset connection, our own
          // timeout — which is a different fact from "Lithic said no" and is
          // deliberately kept different. It arrived here when that error class
          // was introduced: `statusOf()` began returning 0 where it used to
          // return null, so this branch stopped printing the cause and started
          // printing `-> 0`, a number that looks like a status and answers
          // nothing. A probe whose evidence cannot say WHY it failed is the
          // shape this repository has spent two days removing.
          status === null || status === 0
            ? `${SUBS_CALL} failed: ${messageOf(error)}`
            : `${SUBS_CALL} -> ${status}`,
        ms: Date.now() - started,
      };
    }

    const expected = resolveWebhookUrl(processEnv);
    const mine = subscriptions.find((s) => sameEndpoint(s.url, expected.url));

    // Only fetch the delivery history once a subscription of OURS is in hand:
    // a second call about somebody else's endpoint would prove nothing and
    // spend the budget doing it.
    let attempts: readonly EventSubscriptionAttempt[] | null = null;
    let attemptsStatus: number | null = null;
    if (mine !== undefined && !mine.disabled) {
      try {
        const page = await listEventSubscriptionAttempts(
          mine.token,
          { page_size: ATTEMPT_SAMPLE_SIZE },
          { ...base, timeoutMs: remaining() },
        );
        attempts = page.data ?? [];
        attemptsStatus = 200;
      } catch (error) {
        const status = statusOf(error);
        if (status === 401 || status === 403) {
          return {
            liveness: 'unauthorised',
            detail: `${SUBS_CALL} -> 200, ${attemptsCall(mine.token)} -> ${status} (credential rejected)`,
            ms: Date.now() - started,
          };
        }
        attempts = null;
        attemptsStatus = null;
      }
    }

    const verdict = judgeWebhookSubscription({
      expected,
      subscriptions,
      attempts,
      subscriptionsStatus: 200,
      attemptsStatus,
    });
    return { liveness: verdict.liveness, detail: verdict.detail, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}
