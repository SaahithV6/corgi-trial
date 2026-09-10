/**
 * The rule this suite exists to enforce, from DECISIONS 017:
 *
 *   "A probe nobody has watched fail is not a probe."
 *
 * Four probes in this repo shipped green and lying. Each was caught only by
 * making the capability absent and looking. So every branch below that must NOT
 * report live is exercised against the exact provider payloads measured from
 * the sandbox, and `expect(...liveness).not.toBe('live')` is asserted for all of
 * them together at the end — a single guard that fails if any future edit lets
 * a degraded state slip into LIVE.
 *
 * Fixtures are copied from real responses:
 *   GET /v1/event_subscriptions                  -> 200
 *   GET /v1/event_subscriptions/{tok}/attempts   -> 200
 * including the two FAILED 500 attempts from the DECISIONS 020 inbox bug.
 */

import { describe, expect, it } from 'vitest';

import type {
  EventSubscription,
  EventSubscriptionAttempt,
} from '@/lib/rails/lithic/client';

import {
  ATTEMPT_SAMPLE_SIZE,
  DEFAULT_DEPLOYMENT_ORIGIN,
  LITHIC_WEBHOOK_PATH,
  judgeWebhookSubscription,
  probeLithicWebhooks,
  resolveWebhookUrl,
  sameEndpoint,
  type WebhookProbeFacts,
} from './lithic-webhooks';

const OUR_URL = `${DEFAULT_DEPLOYMENT_ORIGIN}${LITHIC_WEBHOOK_PATH}`;
const SUB_TOKEN = 'ep_3J8yb9xommtOdKee1FzpUA4GBrW';

/** Verbatim from `GET /v1/event_subscriptions -> 200`. */
const REAL_SUBSCRIPTION: EventSubscription = {
  description: 'Corgi work trial - card auth and clearing',
  token: SUB_TOKEN,
  event_types: null,
  disabled: false,
  url: OUR_URL,
  version: null,
};

/** Verbatim from `GET /v1/event_subscriptions/{tok}/attempts -> 200`. */
const REAL_SUCCESS: EventSubscriptionAttempt = {
  created: '2026-09-10T18:40:36.424Z',
  event_subscription_token: SUB_TOKEN,
  event_token: 'msg_3J9Fz7kFDwIaUticLgDfrR93qDn',
  response: '{"status":"accepted","message":"stored; processing happens out of band"}',
  response_status_code: 202,
  status: 'SUCCESS',
  token: 'atmpt_3J9Fz7tifJ0ixYrzmU5diJcclax',
  url: OUR_URL,
};

/** The DECISIONS 020 inbox bug, as Lithic recorded it. */
const REAL_FAILURE: EventSubscriptionAttempt = {
  created: '2026-09-10T16:18:47.680Z',
  event_subscription_token: SUB_TOKEN,
  event_token: 'msg_3J8yjFYaE5cor4TGss6aEwWmVeJ',
  response: '{"error":{"code":"WEBHOOK_INBOX_UNAVAILABLE","message":"could not record the event; please retry"}}',
  response_status_code: 500,
  status: 'FAILED',
  token: 'atmpt_3J8yjr4lSnKrlBVjoaKFpFgJYjf',
  url: OUR_URL,
};

function facts(over: Partial<WebhookProbeFacts> = {}): WebhookProbeFacts {
  return {
    expected: { url: OUR_URL, source: 'built-in default' },
    subscriptions: [REAL_SUBSCRIPTION],
    attempts: [REAL_SUCCESS],
    subscriptionsStatus: 200,
    attemptsStatus: 200,
    ...over,
  };
}

describe('resolveWebhookUrl', () => {
  it('prefers an explicit LITHIC_WEBHOOK_URL', () => {
    const r = resolveWebhookUrl({ LITHIC_WEBHOOK_URL: 'https://x.test/hook' });
    expect(r).toEqual({ url: 'https://x.test/hook', source: 'LITHIC_WEBHOOK_URL' });
  });

  it('uses the STABLE Vercel production host, never the per-deployment VERCEL_URL', () => {
    // The subtle false-degraded this ordering exists to prevent: VERCEL_URL is
    // `corgi-trial-<hash>.vercel.app`, which no webhook was ever registered
    // against. Matching on it would make the probe fail to recognise its own
    // system on every deployment addressed by its immutable URL.
    const r = resolveWebhookUrl({
      VERCEL_URL: 'corgi-trial-9fh3kd-lain.vercel.app',
      VERCEL_PROJECT_PRODUCTION_URL: 'corgi-trial-psi.vercel.app',
    });
    expect(r.source).toBe('VERCEL_PROJECT_PRODUCTION_URL');
    expect(r.url).toBe(OUR_URL);
  });

  it('ignores VERCEL_URL entirely when it is the only Vercel variable set', () => {
    const r = resolveWebhookUrl({ VERCEL_URL: 'corgi-trial-9fh3kd-lain.vercel.app' });
    expect(r.url).toBe(OUR_URL);
    expect(r.source).toBe('built-in default');
  });

  it('honours APP_BASE_URL, trailing slash and all', () => {
    expect(resolveWebhookUrl({ APP_BASE_URL: 'http://localhost:3000/' })).toEqual({
      url: `http://localhost:3000${LITHIC_WEBHOOK_PATH}`,
      source: 'APP_BASE_URL',
    });
  });

  it('falls back to the known production origin', () => {
    expect(resolveWebhookUrl({}).url).toBe(OUR_URL);
  });
});

describe('sameEndpoint', () => {
  it('ignores host case, trailing slash and query noise', () => {
    expect(sameEndpoint(OUR_URL, `${OUR_URL}/`)).toBe(true);
    expect(sameEndpoint(OUR_URL, OUR_URL.replace('corgi', 'CORGI'))).toBe(true);
    expect(sameEndpoint(OUR_URL, `${OUR_URL}?v=1`)).toBe(true);
  });

  it('does NOT confuse a different host or a different path', () => {
    expect(sameEndpoint(OUR_URL, 'https://someone-else.vercel.app/api/webhooks/lithic')).toBe(false);
    expect(sameEndpoint(OUR_URL, `${DEFAULT_DEPLOYMENT_ORIGIN}/api/webhooks/increase`)).toBe(false);
    expect(sameEndpoint(OUR_URL, `http://corgi-trial-psi.vercel.app${LITHIC_WEBHOOK_PATH}`)).toBe(false);
  });

  it('degrades to a string compare rather than throwing on junk', () => {
    expect(sameEndpoint('not a url', 'not a url')).toBe(true);
    expect(sameEndpoint('not a url', 'other junk')).toBe(false);
  });
});

describe('judgeWebhookSubscription — the only branch that earns LIVE', () => {
  it('is live when our own URL is registered, enabled, and its latest delivery was accepted', () => {
    const v = judgeWebhookSubscription(facts());
    expect(v.liveness).toBe('live');
    expect(v.subscriptionToken).toBe(SUB_TOKEN);
    // The evidence names both calls, both statuses, and the URL it matched.
    expect(v.detail).toContain('GET /v1/event_subscriptions -> 200');
    expect(v.detail).toContain(`GET /v1/event_subscriptions/${SUB_TOKEN}/attempts -> 200`);
    expect(v.detail).toContain(OUR_URL);
    expect(v.detail).toContain('HTTP 202');
  });

  it('stays live when a retry is in flight above an accepted delivery', () => {
    const pending: EventSubscriptionAttempt = {
      ...REAL_SUCCESS,
      status: 'PENDING',
      response_status_code: null,
      created: '2026-09-10T18:41:00.000Z',
    };
    const v = judgeWebhookSubscription(facts({ attempts: [pending, REAL_SUCCESS] }));
    expect(v.liveness).toBe('live');
    expect(v.detail).toContain('retry outstanding');
  });
});

describe('judgeWebhookSubscription — every way the capability can be absent', () => {
  it('a subscription pointing somewhere else is NOT our subscription', () => {
    const theirs: EventSubscription = { ...REAL_SUBSCRIPTION, url: 'https://someone-else.test/hook' };
    const v = judgeWebhookSubscription(facts({ subscriptions: [theirs] }));
    expect(v.liveness).toBe('unauthorised');
    expect(v.detail).toContain('none at');
    expect(v.detail).toContain('the account has webhooks, this deployment does not');
  });

  it('an account with no subscriptions at all', () => {
    const v = judgeWebhookSubscription(facts({ subscriptions: [] }));
    expect(v.liveness).toBe('unauthorised');
    expect(v.detail).toContain('no webhook endpoint is registered');
  });

  it('registered at our URL but DISABLED', () => {
    const off: EventSubscription = { ...REAL_SUBSCRIPTION, disabled: true };
    const v = judgeWebhookSubscription(facts({ subscriptions: [off] }));
    expect(v.liveness).toBe('unauthorised');
    expect(v.detail).toContain('DISABLED');
  });

  it('registered and enabled but Lithic has never attempted a delivery', () => {
    const v = judgeWebhookSubscription(facts({ attempts: [] }));
    expect(v.liveness).toBe('unauthorised');
    expect(v.detail).toContain('NO delivery attempt');
    expect(v.detail).toContain('registration is not delivery');
  });

  it('the case only this probe can see: Lithic delivering, our endpoint refusing', () => {
    // Both real 500s from DECISIONS 020, newest first, with no success above.
    const v = judgeWebhookSubscription({
      ...facts(),
      attempts: [REAL_FAILURE, { ...REAL_FAILURE, created: '2026-09-10T16:18:43.004Z' }],
    });
    expect(v.liveness).toBe('unauthorised');
    expect(v.detail).toContain('REJECTED by us (HTTP 500)');
    expect(v.detail).toContain('the subscription works, our endpoint does not');
  });

  it('a fresh failure above an older success is still a failure', () => {
    // Under-claiming on a transient is only pessimistic; the alternative is
    // reporting LIVE while every current delivery is being dropped.
    const newerFailure: EventSubscriptionAttempt = {
      ...REAL_FAILURE,
      created: '2026-09-10T19:00:00.000Z',
    };
    const v = judgeWebhookSubscription(facts({ attempts: [newerFailure, REAL_SUCCESS] }));
    expect(v.liveness).toBe('unauthorised');
    expect(v.detail).toContain('REJECTED by us');
  });

  it('declines to judge when nothing has come back yet', () => {
    const inFlight: EventSubscriptionAttempt = {
      ...REAL_SUCCESS,
      status: 'SENDING',
      response_status_code: null,
    };
    const v = judgeWebhookSubscription(facts({ attempts: [inFlight] }));
    expect(v.liveness).toBe('unreachable');
    expect(v.detail).toContain('still in flight');
  });

  it('declines to judge when the delivery history could not be read', () => {
    const v = judgeWebhookSubscription(facts({ attempts: null, attemptsStatus: null }));
    expect(v.liveness).toBe('unreachable');
    expect(v.detail).toContain('registration alone is not delivery');
  });

  it('NONE of the degraded branches reports live', () => {
    const off: EventSubscription = { ...REAL_SUBSCRIPTION, disabled: true };
    const theirs: EventSubscription = { ...REAL_SUBSCRIPTION, url: 'https://someone-else.test/hook' };
    const degraded: WebhookProbeFacts[] = [
      facts({ subscriptions: [] }),
      facts({ subscriptions: [theirs] }),
      facts({ subscriptions: [off] }),
      facts({ attempts: [] }),
      facts({ attempts: [REAL_FAILURE] }),
      facts({ attempts: null, attemptsStatus: null }),
      facts({ expected: { url: 'https://localhost:3000/api/webhooks/lithic', source: 'APP_BASE_URL' } }),
    ];
    for (const f of degraded) {
      expect(judgeWebhookSubscription(f).liveness).not.toBe('live');
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * The round trip itself, with a fake `fetch`. This exercises client.ts's real
 * request building and error mapping, so a wrong path or a mishandled 401
 * fails here rather than in production.
 * ──────────────────────────────────────────────────────────────────────────── */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordingFetch(
  handler: (url: string) => Response,
): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe('probeLithicWebhooks', () => {
  const withKey = { apiKey: 'test-key', processEnv: {} as Record<string, string | undefined> };

  it('is unprobed — not live, not not_configured — when the secret is set but the API key is not', async () => {
    // This is exactly the state DECISIONS 026 fixed. It must survive the fix.
    const r = await probeLithicWebhooks({
      apiKey: undefined,
      webhookSecret: 'whsec_something',
      processEnv: {},
    });
    expect(r.liveness).toBe('unprobed');
    expect(r.detail).toContain('no round trip proves this slot works');
  });

  it('is not_configured when nothing is set', async () => {
    const r = await probeLithicWebhooks({ apiKey: undefined, webhookSecret: undefined, processEnv: {} });
    expect(r.liveness).toBe('not_configured');
  });

  it('hits the two measured endpoints, in order, and reports live', async () => {
    const { fetchImpl, urls } = recordingFetch((url) =>
      url.includes('/attempts')
        ? json({ data: [REAL_SUCCESS], has_more: true })
        : json({ data: [REAL_SUBSCRIPTION], has_more: false }),
    );
    const r = await probeLithicWebhooks({ ...withKey, fetchImpl });
    expect(r.liveness).toBe('live');
    expect(urls[0]).toBe('https://sandbox.lithic.com/v1/event_subscriptions?page_size=100');
    expect(urls[1]).toBe(
      `https://sandbox.lithic.com/v1/event_subscriptions/${SUB_TOKEN}/attempts?page_size=${ATTEMPT_SAMPLE_SIZE}`,
    );
  });

  it('reports unauthorised on the measured 401 body, and never asks for attempts', async () => {
    // Measured: a wrong key answers 401 {"message":"Could not find the provided API key"}.
    const { fetchImpl, urls } = recordingFetch(() =>
      json({ message: 'Could not find the provided API key' }, 401),
    );
    const r = await probeLithicWebhooks({ ...withKey, fetchImpl });
    expect(r.liveness).toBe('unauthorised');
    expect(r.detail).toBe('GET /v1/event_subscriptions -> 401 (credential rejected)');
    expect(urls).toHaveLength(1);
  });

  it('does not spend a second call on a subscription that is not ours', async () => {
    const theirs: EventSubscription = { ...REAL_SUBSCRIPTION, url: 'https://someone-else.test/hook' };
    const { fetchImpl, urls } = recordingFetch(() => json({ data: [theirs], has_more: false }));
    const r = await probeLithicWebhooks({ ...withKey, fetchImpl });
    expect(r.liveness).toBe('unauthorised');
    expect(urls).toHaveLength(1);
  });

  it('is unreachable, never live, when the network fails', async () => {
    const fetchImpl = (() => Promise.reject(new Error('getaddrinfo ENOTFOUND'))) as typeof fetch;
    const r = await probeLithicWebhooks({ ...withKey, fetchImpl });
    expect(r.liveness).toBe('unreachable');
    expect(r.detail).toContain('ENOTFOUND');
  });

  it('degrades rather than claiming, when the attempts call alone fails', async () => {
    const { fetchImpl } = recordingFetch((url) =>
      url.includes('/attempts')
        ? json({ message: 'Internal Server Error' }, 500)
        : json({ data: [REAL_SUBSCRIPTION], has_more: false }),
    );
    const r = await probeLithicWebhooks({ ...withKey, fetchImpl, timeoutMs: 500 });
    expect(r.liveness).toBe('unreachable');
    expect(r.detail).toContain('registration alone is not delivery');
  });

  it('matches on the URL the environment names, so a different deployment does not count', async () => {
    const { fetchImpl } = recordingFetch(() => json({ data: [REAL_SUBSCRIPTION], has_more: false }));
    const r = await probeLithicWebhooks({
      apiKey: 'test-key',
      processEnv: { VERCEL_PROJECT_PRODUCTION_URL: 'some-other-project.vercel.app' },
      fetchImpl,
    });
    expect(r.liveness).toBe('unauthorised');
    expect(r.detail).toContain('some-other-project.vercel.app');
  });
});
