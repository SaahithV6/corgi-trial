import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { logger } from '../log';
import { createMemoryInboxStore, type InboxStore, type NewInboxEvent } from './inbox';
import {
  buildVerifierRegistry,
  handleWebhookRequest,
  integrationReports,
  WEBHOOK_PROVIDERS,
  type EnvBag,
} from './route-handler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The canonical Standard Webhooks secret, the same one Lithic prints in its own
 * documentation. Using the real scheme rather than a stub verifier is the whole
 * point: these tests exercise the bytes-in, status-out path end to end.
 */
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const EVENT_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TIMESTAMP = '1614265330';
const NOW = new Date(Number(TIMESTAMP) * 1000);
const now = () => NOW;

/** Note the space after the colon. It is load-bearing; see the tamper tests. */
const BODY = '{"event_type": "card_transaction.updated", "token": "txn_1"}';

/**
 * A fully configured environment EXCEPT Stripe, which is left out on purpose so
 * the not-configured paths are exercised by the same fixture.
 */
const ENV: EnvBag = {
  LITHIC_API_KEY: 'lithic_api_key',
  LITHIC_WEBHOOK_SECRET: SECRET,
  PERSONA_API_KEY: 'persona_api_key',
  PERSONA_WEBHOOK_SECRET: 'persona_webhook_secret',
  PLAID_CLIENT_ID: 'plaid_client_id',
  PLAID_SECRET: 'plaid_secret',
  INCREASE_API_KEY: 'increase_api_key',
  INCREASE_WEBHOOK_SECRET: 'increase_webhook_secret',
};

const registry = buildVerifierRegistry(ENV);

function signLithic(body: string, id = EVENT_ID, timestamp = TIMESTAMP): string {
  const key = Buffer.from(SECRET.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`, 'utf8').digest('base64')}`;
}

/**
 * A delivery whose `json()` throws. If the handler ever parses the body itself
 * — instead of letting `ingestWebhook` verify the raw bytes first and call
 * `parseVerifiedJson` afterwards — every test in this file fails loudly.
 */
function delivery(body: string, headers: Record<string, string>) {
  return {
    async text(): Promise<string> {
      return body;
    },
    headers: new Headers(headers),
    async json(): Promise<never> {
      throw new Error('the route handler must never parse the body itself');
    },
  };
}

function lithicDelivery(
  body: string,
  overrides: Record<string, string> = {},
  signedBody = body,
) {
  return delivery(body, {
    'webhook-id': EVENT_ID,
    'webhook-timestamp': TIMESTAMP,
    'webhook-signature': signLithic(signedBody),
    ...overrides,
  });
}

/** A memory store that also counts the writes it was asked to make. */
function trackingStore(): InboxStore & { all(): unknown[]; writes: NewInboxEvent[] } {
  const inner = createMemoryInboxStore();
  const writes: NewInboxEvent[] = [];
  return {
    ...inner,
    writes,
    async insertIfNew(record) {
      writes.push(record);
      return inner.insertIfNew(record);
    },
  };
}

/** A store whose only behaviour is failing, for the 500 path. */
function brokenStore(): InboxStore {
  const inner = createMemoryInboxStore();
  return {
    ...inner,
    async insertIfNew() {
      throw new Error('connection terminated unexpectedly');
    },
  };
}

async function post(
  provider: string,
  req: ReturnType<typeof delivery>,
  store: InboxStore,
  log?: ReturnType<typeof logger>,
) {
  const response = await handleWebhookRequest(req, provider, {
    store,
    registry,
    env: ENV,
    now,
    ...(log === undefined ? {} : { log }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

const errorOf = (body: Record<string, unknown>) =>
  body['error'] as { code: string; message: string; details?: unknown } | undefined;

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/[provider]', () => {
  it('accepts a validly signed delivery with 202 and stores the exact bytes', async () => {
    const store = trackingStore();
    const { response, body } = await post('lithic', lithicDelivery(BODY), store);

    expect(response.status).toBe(202);
    expect(body['status']).toBe('accepted');
    expect(body['providerEventId']).toBe(EVENT_ID);
    expect(body['eventType']).toBe('card_transaction.updated');

    expect(store.writes).toHaveLength(1);
    // The bytes on the row are the bytes we verified — not a re-serialisation.
    expect(store.writes[0]?.rawBody).toBe(BODY);
    expect(store.writes[0]?.state ?? 'pending').toBe('pending');
  });

  it('carries the request id in both the body and the header', async () => {
    const store = trackingStore();
    const { response, body } = await post(
      'lithic',
      lithicDelivery(BODY, { 'x-request-id': 'req_fixed' }),
      store,
    );

    expect(body['requestId']).toBe('req_fixed');
    expect(response.headers.get('x-request-id')).toBe('req_fixed');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never parses the request body itself — the raw bytes come first', async () => {
    let parsed = false;
    const req = {
      async text(): Promise<string> {
        return BODY;
      },
      headers: new Headers({
        'webhook-id': EVENT_ID,
        'webhook-timestamp': TIMESTAMP,
        'webhook-signature': signLithic(BODY),
      }),
      async json(): Promise<unknown> {
        parsed = true;
        return JSON.parse(BODY);
      },
    };

    const { response } = await post('lithic', req, trackingStore());
    expect(response.status).toBe(202);
    expect(parsed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bad signatures: 401, and NOTHING reaches the store
// ---------------------------------------------------------------------------

describe('bad signature', () => {
  it('rejects a tampered body with 401 and never touches the store', async () => {
    const store = trackingStore();
    const tampered = '{"event_type": "card_transaction.updated", "token": "txn_STOLEN"}';
    const { response, body } = await post(
      'lithic',
      // signature computed over the ORIGINAL body, delivered with the tampered one
      lithicDelivery(tampered, {}, BODY),
      store,
    );

    expect(response.status).toBe(401);
    expect(errorOf(body)?.code).toBe('WEBHOOK_SIGNATURE_INVALID');

    // The assertion that matters: an unauthenticated body is not evidence of
    // anything, so it must not be able to put a row in the inbox.
    expect(store.writes).toHaveLength(0);
    expect(store.all()).toHaveLength(0);
  });

  it('rejects the same payload re-serialised — the raw-body footgun, as a status code', async () => {
    const store = trackingStore();
    const reserialised = JSON.stringify(JSON.parse(BODY)); // loses the space
    expect(reserialised).not.toBe(BODY);

    const { response } = await post('lithic', lithicDelivery(reserialised, {}, BODY), store);

    expect(response.status).toBe(401);
    expect(store.writes).toHaveLength(0);
  });

  it('rejects a stale timestamp with 401 and stores nothing', async () => {
    const store = trackingStore();
    const stale = String(Number(TIMESTAMP) - 3_600);
    const req = delivery(BODY, {
      'webhook-id': EVENT_ID,
      'webhook-timestamp': stale,
      'webhook-signature': signLithic(BODY, EVENT_ID, stale),
    });

    const { response, body } = await post('lithic', req, store);

    expect(response.status).toBe(401);
    expect(errorOf(body)?.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(store.writes).toHaveLength(0);
  });

  it('does not tell an unauthenticated caller why verification failed', async () => {
    const store = trackingStore();
    const stale = String(Number(TIMESTAMP) - 3_600);
    const { body } = await post(
      'lithic',
      delivery(BODY, {
        'webhook-id': EVENT_ID,
        'webhook-timestamp': stale,
        'webhook-signature': signLithic(BODY, EVENT_ID, stale),
      }),
      store,
    );

    // "timestamp too old" vs "no v1 signature matched" is free information for
    // someone probing the endpoint. It goes to the log, not to the response.
    expect(JSON.stringify(body)).not.toMatch(/timestamp|signature matched/i);
  });

  it('rejects a delivery with no signature headers at all', async () => {
    const store = trackingStore();
    const { response } = await post('lithic', delivery(BODY, {}), store);

    expect(response.status).toBe(401);
    expect(store.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unknown provider: 404, never 500
// ---------------------------------------------------------------------------

describe('unknown provider', () => {
  it('answers 404 for a provider with no verifier', async () => {
    const store = trackingStore();
    const { response, body } = await post('acme-bank', lithicDelivery(BODY), store);

    expect(response.status).toBe(404);
    expect(errorOf(body)?.code).toBe('UNKNOWN_PROVIDER');
    expect(body['requestId']).toEqual(expect.any(String));
    expect(store.writes).toHaveLength(0);
  });

  it('is still a 404 when the store is broken — the check happens first', async () => {
    // Proves the "never a 500" clause: an unknown segment is resolved by a Map
    // lookup before anything is constructed, so nothing downstream can throw.
    const { response } = await post('acme-bank', lithicDelivery(BODY), brokenStore());
    expect(response.status).toBe(404);
  });

  it('does not echo an unvalidated path segment back verbatim', async () => {
    const { body } = await post(
      '<script>alert(1)</script>',
      lithicDelivery(BODY),
      trackingStore(),
    );
    expect(JSON.stringify(body)).not.toContain('<script>');
  });

  it('answers 503, not 404, for a known provider whose secret is missing', async () => {
    // Stripe is in the catalogue but absent from ENV. 503 is retryable; a 404
    // would tell a real provider to give up on an event we could have kept.
    const { response, body } = await post('stripe', lithicDelivery(BODY), trackingStore());

    expect(response.status).toBe(503);
    expect(errorOf(body)?.code).toBe('WEBHOOK_PROVIDER_NOT_CONFIGURED');
    expect(body['retryable']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Replay: 200, never 409
// ---------------------------------------------------------------------------

describe('duplicate delivery', () => {
  it('answers 200 with a replay body and writes exactly one row', async () => {
    const store = trackingStore();

    const first = await post('lithic', lithicDelivery(BODY), store);
    const second = await post('lithic', lithicDelivery(BODY), store);

    expect(first.response.status).toBe(202);

    // 200, NOT 409: a provider that receives a 4xx on a replay retries the
    // replay, for ever.
    expect(second.response.status).toBe(200);
    expect(second.body['replay']).toBe(true);
    expect(second.body['status']).toBe('replay');
    expect(String(second.body['message'])).toMatch(/duplicate|already accepted/i);
    expect(second.body['providerEventId']).toBe(EVENT_ID);
    expect(second.body['requestId']).toEqual(expect.any(String));

    // The unique index decided this, not application code.
    expect(store.all()).toHaveLength(1);
  });

  it('is a replay even when the retry carries a fresh request id', async () => {
    const store = trackingStore();
    await post('lithic', lithicDelivery(BODY, { 'x-request-id': 'req_a' }), store);
    const { response, body } = await post(
      'lithic',
      lithicDelivery(BODY, { 'x-request-id': 'req_b' }),
      store,
    );

    expect(response.status).toBe(200);
    expect(body['requestId']).toBe('req_b');
    expect(store.all()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Malformed and unavailable
// ---------------------------------------------------------------------------

describe('malformed body that passes the signature', () => {
  it('answers 400 and still files the bytes as evidence', async () => {
    const store = trackingStore();
    const notJson = 'this is not json';
    const { response, body } = await post('lithic', lithicDelivery(notJson), store);

    expect(response.status).toBe(400);
    expect(errorOf(body)?.code).toBe('WEBHOOK_BODY_UNPARSEABLE');
    expect(body['filed']).toBe(true);

    // The signature verified, so these really are the provider's bytes and
    // throwing them away would be throwing away evidence.
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]?.state).toBe('dead');
    expect(store.writes[0]?.rawBody).toBe(notJson);
  });
});

describe('inbox write failure', () => {
  it('answers 500 so the provider retries', async () => {
    const { response, body } = await post('lithic', lithicDelivery(BODY), brokenStore());

    expect(response.status).toBe(500);
    expect(errorOf(body)?.code).toBe('WEBHOOK_INBOX_UNAVAILABLE');
    expect(body['retryable']).toBe(true);
    expect(body['requestId']).toEqual(expect.any(String));
    // Never leak the driver's message to the caller.
    expect(JSON.stringify(body)).not.toContain('connection terminated');
  });
});

// ---------------------------------------------------------------------------
// Structured logging
// ---------------------------------------------------------------------------

describe('logging', () => {
  function collector() {
    const lines: Record<string, unknown>[] = [];
    const log = logger({
      requestId: 'req_log',
      level: 'debug',
      emit: (line) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    });
    return { lines, log };
  }

  it('logs provider, event id, verified, outcome and duration on success', async () => {
    const { lines, log } = collector();
    await post('lithic', lithicDelivery(BODY), trackingStore(), log);

    const line = lines.find((l) => l['event'] === 'webhook.request');
    expect(line).toBeDefined();
    expect(line?.['provider']).toBe('lithic');
    expect(line?.['eventId']).toBe(EVENT_ID);
    expect(line?.['verified']).toBe(true);
    expect(line?.['outcome']).toBe('accepted');
    expect(line?.['httpStatus']).toBe(202);
    expect(typeof line?.['durationMs']).toBe('number');
    expect(line?.['requestId']).toBe('req_log');
  });

  it('logs verified:false and the real reason on a rejected signature', async () => {
    const { lines, log } = collector();
    await post('lithic', lithicDelivery('{"tampered": true}', {}, BODY), trackingStore(), log);

    const line = lines.find((l) => l['event'] === 'webhook.request');
    expect(line?.['verified']).toBe(false);
    expect(line?.['outcome']).toBe('signature_invalid');
    expect(line?.['level']).toBe('warn');
    // The reason the caller does not get is the reason the operator does.
    expect(String(line?.['reason'])).toMatch(/signature/i);
  });
});

// ---------------------------------------------------------------------------
// The catalogue: one source of truth for routing AND for /api/health
// ---------------------------------------------------------------------------

describe('integration catalogue', () => {
  it('routes exactly the five providers', () => {
    expect([...WEBHOOK_PROVIDERS]).toEqual(['lithic', 'persona', 'plaid', 'increase', 'stripe']);
  });

  it('registers a verifier only for providers whose credentials are present', () => {
    expect(registry.providers()).toEqual(['increase', 'lithic', 'persona', 'plaid']);
    expect(registry.get('stripe')).toBeUndefined();
  });

  it('never reports an integration as live when its API key is absent', () => {
    const withoutApiKey: EnvBag = { ...ENV, LITHIC_API_KEY: undefined };
    const lithic = integrationReports(withoutApiKey).find((i) => i.provider === 'lithic');

    expect(lithic?.status).toBe('not_configured');
    expect(lithic?.missingEnv).toContain('LITHIC_API_KEY');
    // The webhook secret is still there, so deliveries still verify — the
    // report says both things rather than collapsing them into one word.
    expect(lithic?.webhookVerifierRegistered).toBe(true);
  });

  it('treats an empty string as a missing key', () => {
    const blank: EnvBag = { ...ENV, LITHIC_API_KEY: '   ' };
    expect(integrationReports(blank).find((i) => i.provider === 'lithic')?.status).toBe(
      'not_configured',
    );
  });

  it('reports live only when every credential is present, and never leaks values', () => {
    const reports = integrationReports(ENV);
    const byProvider = Object.fromEntries(reports.map((r) => [r.provider, r]));

    expect(byProvider['lithic']?.status).toBe('live');
    expect(byProvider['lithic']?.evidence).toBe('credentials_present');
    expect(byProvider['plaid']?.status).toBe('live');
    expect(byProvider['stripe']?.status).toBe('not_configured');
    expect(byProvider['stripe']?.missingEnv).toEqual(
      expect.arrayContaining(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']),
    );

    // Env var NAMES only. A public endpoint must never carry a secret's value.
    expect(JSON.stringify(reports)).not.toContain(SECRET);
    expect(JSON.stringify(reports)).not.toContain('persona_webhook_secret');
  });

  it('gives every provider a webhook path under the one dynamic route', () => {
    for (const report of integrationReports(ENV)) {
      expect(report.webhookPath).toBe(`/api/webhooks/${report.provider}`);
    }
  });
});
