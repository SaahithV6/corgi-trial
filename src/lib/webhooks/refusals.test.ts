import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PROCESSING_VERDICTS } from '@/app/api/health/processing';
import { DELIVERY_VERDICTS } from '@/lib/integrations/delivery-health';

import { createMemoryInboxStore, type InboxStore, type NewInboxEvent } from './inbox';
import { toHeaderLookup } from './rawbody';
import {
  classifyRefusal,
  createMemoryRefusalStore,
  createRefusalRecorder,
  describeSignature,
  probeBody,
  readSourceAddress,
  refusalsUnavailable,
  REFUSAL_REASONS,
  REFUSAL_VERDICTS,
  webhookRefusalHealth,
  type RefusalObservation,
  type RefusalRateRow,
  type SignatureShape,
} from './refusals';
import { buildVerifierRegistry, handleWebhookRequest, type EnvBag } from './route-handler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The canonical Standard Webhooks secret, as in route-handler.test.ts. */
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const EVENT_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const TIMESTAMP = '1614265330';
const NOW = new Date(Number(TIMESTAMP) * 1000);
const BODY = '{"event_type": "card_transaction.updated", "token": "txn_1"}';
/** sha256 of BODY. Pinned, so a change to the digest is a failing test. */
const BODY_SHA256 = '47afc2d02215e390bfef2430beebcbc735002db5fec5051e9c0a0166173b7fed';

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

/** A delivery whose `json()` throws — the probe must not become a parser. */
function delivery(body: string, headers: Record<string, string>) {
  return {
    async text(): Promise<string> {
      return body;
    },
    headers: new Headers(headers),
    async json(): Promise<never> {
      throw new Error('nothing on the refusal path may parse the body');
    },
  };
}

function lithicDelivery(body: string, overrides: Record<string, string> = {}, signedBody = body) {
  return delivery(body, {
    'webhook-id': EVENT_ID,
    'webhook-timestamp': TIMESTAMP,
    'webhook-signature': signLithic(signedBody),
    'x-forwarded-for': '203.0.113.7',
    ...overrides,
  });
}

const lookup = (headers: Record<string, string>) => toHeaderLookup(new Headers(headers));

const SIG_PRESENT: SignatureShape = { present: true, shape: 'swh:v1x1', bytes: 47 };
const SIG_ABSENT: SignatureShape = { present: false, shape: 'absent', bytes: null };

function observation(overrides: Partial<RefusalObservation> = {}): RefusalObservation {
  return {
    provider: 'lithic',
    providerKnown: true,
    reasonCode: 'signature_mismatch',
    source: { ip: '203.0.113.7', header: 'x-forwarded-for' },
    signature: SIG_PRESENT,
    body: { sha256: BODY_SHA256, bytes: BODY.length },
    at: NOW,
    ...overrides,
  };
}

/** A memory inbox that records every write it was asked to make. */
function trackingStore(): InboxStore & { writes: NewInboxEvent[] } {
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

// ---------------------------------------------------------------------------
// 1. The source address — the type is the validator
// ---------------------------------------------------------------------------

describe('readSourceAddress', () => {
  it('prefers the platform header over the caller-settable one', () => {
    const source = readSourceAddress(
      lookup({ 'x-vercel-forwarded-for': '198.51.100.4', 'x-forwarded-for': '10.0.0.1' }),
    );
    expect(source).toEqual({ ip: '198.51.100.4', header: 'x-vercel-forwarded-for' });
  });

  it('takes the LEFTMOST entry of a forwarded chain', () => {
    expect(readSourceAddress(lookup({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }))).toEqual({
      ip: '203.0.113.7',
      header: 'x-forwarded-for',
    });
  });

  it('strips a port and IPv6 brackets', () => {
    expect(readSourceAddress(lookup({ 'x-real-ip': '203.0.113.7:41234' })).ip).toBe('203.0.113.7');
    expect(readSourceAddress(lookup({ 'x-real-ip': '[2001:db8::1]:443' })).ip).toBe('2001:db8::1');
  });

  it('records no address at all when the header is nonsense', () => {
    // THE POINT: a hostile forwarded-for must never survive as text. It is
    // either something `inet` will accept or it is nothing.
    for (const hostile of [
      '<script>alert(1)</script>',
      "1.2.3.4'; DROP TABLE webhook_refusal; --",
      'localhost',
      'x'.repeat(500),
    ]) {
      expect(readSourceAddress(lookup({ 'x-forwarded-for': hostile }))).toEqual({
        ip: null,
        header: 'unparseable',
      });
    }
  });

  it('distinguishes "no header" from "a header we could not read"', () => {
    expect(readSourceAddress(lookup({})).header).toBe('none');
    expect(readSourceAddress(lookup({ 'x-forwarded-for': 'nope' })).header).toBe('unparseable');
  });
});

// ---------------------------------------------------------------------------
// 2. The signature shape — structure, never bytes
// ---------------------------------------------------------------------------

describe('describeSignature', () => {
  const swh = ['webhook-id', 'webhook-timestamp', 'webhook-signature'];

  it('describes a Standard Webhooks signature by scheme and entry count', () => {
    expect(describeSignature(lookup({ 'webhook-signature': 'v1,abc' }), swh).shape).toBe('swh:v1x1');
    expect(
      describeSignature(lookup({ 'webhook-signature': 'v1,abc v1,def' }), swh).shape,
    ).toBe('swh:v1x2');
  });

  it('describes Persona/Stripe as t+v1 and Plaid as a JWT', () => {
    expect(
      describeSignature(lookup({ 'persona-signature': 't=1,v1=deadbeef' }), ['persona-signature']).shape,
    ).toBe('tshmac:t+v1x1');
    expect(
      describeSignature(lookup({ 'stripe-signature': 'v1=deadbeef' }), ['stripe-signature']).shape,
    ).toBe('tshmac:v1x1');
    expect(
      describeSignature(lookup({ 'plaid-verification': 'a.b.c' }), ['plaid-verification']).shape,
    ).toBe('jwt:3part');
  });

  it('says absent when the scheme headers are not there, and nosig when only the envelope is', () => {
    expect(describeSignature(lookup({}), swh)).toEqual({ present: false, shape: 'absent', bytes: null });
    expect(describeSignature(lookup({ 'webhook-id': EVENT_ID }), swh).shape).toBe('swh:nosig');
  });

  it('bounds its own output rather than trusting the input', () => {
    // Four hundred v1 entries must not become a four-hundred-character column
    // value: the count is clamped, and the token still matches the CHECK in
    // 0038_webhook_refusals.sql.
    const flood = Array.from({ length: 400 }, () => 'v1,x').join(' ');
    const shape = describeSignature(lookup({ 'webhook-signature': flood }), swh).shape;
    expect(shape).toBe('swh:v1x9');
    expect(shape).toMatch(/^[a-z]+(:[a-z0-9+_-]{1,24})?$/);
  });

  it('emits only tokens the database CHECK constraint accepts', () => {
    const cases = [
      describeSignature(lookup({}), swh),
      describeSignature(lookup({ 'webhook-signature': 'garbage' }), swh),
      describeSignature(lookup({ 'webhook-id': 'x' }), swh),
      describeSignature(lookup({ 'persona-signature': 'garbage' }), ['persona-signature']),
      describeSignature(lookup({ 'plaid-verification': 'a.b' }), ['plaid-verification']),
    ];
    for (const c of cases) {
      expect(c.shape).toMatch(/^[a-z]+(:[a-z0-9+_-]{1,24})?$/);
      expect(c.shape.length).toBeLessThanOrEqual(32);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Classification — pinned against every reason the verifiers can produce
// ---------------------------------------------------------------------------

describe('classifyRefusal', () => {
  /**
   * EVERY reason string the shipped verifiers in `inbox.ts` can return, with
   * the code each must land in. This is the drift catcher: classification reads
   * our own prose, and prose changes. If someone rewords a verifier, this table
   * fails rather than the reason quietly falling into the catch-all.
   */
  const PINNED: readonly [string, SignatureShape, string][] = [
    // --- standardWebhooksVerifier (Lithic, Increase) ------------------------
    ['missing webhook-id / webhook-timestamp / webhook-signature', SIG_ABSENT, 'signature_absent'],
    ['missing webhook-id / webhook-timestamp / webhook-signature', SIG_PRESENT, 'signature_malformed'],
    ['webhook-timestamp is not a unix second count', SIG_PRESENT, 'timestamp_outside_window'],
    ['timestamp too old (400s > 300s)', SIG_PRESENT, 'timestamp_outside_window'],
    ['timestamp too far in the future (400s)', SIG_PRESENT, 'timestamp_outside_window'],
    ['no v1 signature matched', SIG_PRESENT, 'signature_mismatch'],
    // --- timestampedHmacVerifier (Persona, Stripe) --------------------------
    ['missing persona-signature', SIG_ABSENT, 'signature_absent'],
    ['malformed persona-signature', SIG_PRESENT, 'signature_malformed'],
    ['timestamp is not a unix second count', SIG_PRESENT, 'timestamp_outside_window'],
    // --- plaidVerifier ------------------------------------------------------
    ['missing plaid-verification', SIG_ABSENT, 'signature_absent'],
    ['malformed JWT', SIG_PRESENT, 'signature_malformed'],
    ['JWT header/payload is not JSON', SIG_PRESENT, 'signature_malformed'],
    ["unexpected alg 'none'", SIG_PRESENT, 'signature_malformed'],
    ['JWT has no kid', SIG_PRESENT, 'signature_malformed'],
    ['no verification key for kid abc', SIG_PRESENT, 'signature_malformed'],
    ['verification key is expired', SIG_PRESENT, 'signature_mismatch'],
    ['JWT signature check failed: Error: boom', SIG_PRESENT, 'signature_mismatch'],
    ['JWT signature does not verify', SIG_PRESENT, 'signature_mismatch'],
    ['JWT has no iat', SIG_PRESENT, 'timestamp_outside_window'],
    ['JWT too old (900s)', SIG_PRESENT, 'timestamp_outside_window'],
    ['body hash does not match request_body_sha256', SIG_PRESENT, 'signature_mismatch'],
  ];

  it.each(PINNED)('classifies %j', (reason, signature, expected) => {
    expect(classifyRefusal({ verifierFound: true, signature, reason })).toBe(expected);
  });

  it('calls a path segment with no verifier unknown_provider, whatever the reason says', () => {
    expect(
      classifyRefusal({
        verifierFound: false,
        signature: SIG_ABSENT,
        reason: 'no verifier registered for this path segment',
      }),
    ).toBe('unknown_provider');
  });

  it('falls back to the LOUDEST bucket, not the quietest', () => {
    // A reason nobody recognises is reported as a forgery, which someone
    // investigates, rather than as a formatting problem, which nobody does.
    expect(
      classifyRefusal({ verifierFound: true, signature: SIG_PRESENT, reason: 'something new' }),
    ).toBe('signature_mismatch');
  });

  it('reports a stale timestamp even when the signature is missing entirely', () => {
    expect(
      classifyRefusal({ verifierFound: true, signature: SIG_ABSENT, reason: 'timestamp too old (900s > 300s)' }),
    ).toBe('timestamp_outside_window');
  });
});

// ---------------------------------------------------------------------------
// 4. The probe — a tee, not a second read
// ---------------------------------------------------------------------------

describe('probeBody', () => {
  it('observes nothing until the body is actually read', () => {
    const probe = probeBody(lithicDelivery(BODY));
    expect(probe.observed()).toBeNull();
  });

  it('yields the digest and byte length of the exact bytes, once', () => {
    const source = lithicDelivery(BODY);
    let reads = 0;
    const counted = {
      headers: source.headers,
      async text() {
        reads += 1;
        return BODY;
      },
    };
    const probe = probeBody(counted);
    return probe.request.text().then((raw) => {
      expect(raw).toBe(BODY);
      expect(reads).toBe(1);
      expect(probe.observed()).toEqual({ sha256: BODY_SHA256, bytes: Buffer.byteLength(BODY) });
    });
  });

  it('measures BYTES, not characters', async () => {
    const emoji = '{"note":"☕"}';
    const probe = probeBody({ headers: new Headers(), async text() { return emoji; } });
    await probe.request.text();
    expect(probe.observed()?.bytes).toBe(Buffer.byteLength(emoji, 'utf8'));
    expect(probe.observed()?.bytes).toBeGreaterThan(emoji.length);
  });
});

// ---------------------------------------------------------------------------
// 5. The recorder — aggregation and the write budget
// ---------------------------------------------------------------------------

describe('the refusal recorder', () => {
  it('collapses repeated refusals in one minute into ONE row with a count', async () => {
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store });
    for (let i = 0; i < 25; i += 1) {
      await recorder.observe(observation({ at: new Date(NOW.getTime() + i * 1000) }));
    }
    await recorder.flush();

    expect(store.all()).toHaveLength(1);
    const row = store.all()[0]!;
    expect(row.refusals).toBe(25);
    expect(row.firstSeenAt).toEqual(NOW);
    expect(row.lastSeenAt).toEqual(new Date(NOW.getTime() + 24 * 1000));
    expect(row.minuteBucket).toEqual(new Date(Math.floor(NOW.getTime() / 60_000) * 60_000));
  });

  it('opens a new row when the minute rolls', async () => {
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store });
    await recorder.observe(observation());
    await recorder.observe(observation({ at: new Date(NOW.getTime() + 61_000) }));
    await recorder.flush();
    expect(store.all()).toHaveLength(2);
  });

  it('separates the reasons, the providers and the sources', async () => {
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store });
    await recorder.observe(observation());
    await recorder.observe(observation({ reasonCode: 'signature_absent' }));
    await recorder.observe(observation({ provider: 'increase' }));
    await recorder.observe(observation({ source: { ip: '198.51.100.9', header: 'x-real-ip' } }));
    await recorder.flush();
    expect(store.all()).toHaveLength(4);
  });

  it('flags a bucket whose bodies differ, and leaves a pure replay unflagged', async () => {
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store });
    await recorder.observe(observation());
    await recorder.observe(observation());
    await recorder.flush();
    expect(store.all()[0]!.bodyVaried).toBe(false);

    const varied = createMemoryRefusalStore();
    const second = createRefusalRecorder({ store: varied });
    await second.observe(observation());
    await second.observe(observation({ body: { sha256: 'f'.repeat(64), bytes: 12 } }));
    await second.flush();
    expect(varied.all()[0]!.bodyVaried).toBe(true);
  });

  it('NEVER writes more rows per minute than its budget, however many sources attack', async () => {
    // The DoS test. 500 distinct source addresses in one minute, budget 5.
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store, maxRowsPerMinute: 5 });
    for (let i = 0; i < 500; i += 1) {
      await recorder.observe(
        observation({ source: { ip: `198.51.100.${i % 256}`, header: 'x-forwarded-for' } }),
      );
    }
    await recorder.flush();

    const rows = store.all();
    expect(rows.length).toBeLessThanOrEqual(6); // 5 attributed + the fold
    // And nothing is lost: every refusal is counted somewhere.
    expect(rows.reduce((n, r) => n + r.refusals, 0)).toBe(500);
    const folded = rows.filter((r) => r.sourceHeader === 'folded');
    expect(folded).toHaveLength(1);
    expect(folded[0]!.sourceIp).toBeNull();
  });

  it('drops an attacker-chosen path segment when it folds, because the segment is unbounded', async () => {
    // /api/webhooks/aaa1, aaa2, … is an unbounded cardinality dimension. Past
    // the budget the fold keeps the reason and the count and throws the segment
    // away rather than letting it open a row each.
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store, maxRowsPerMinute: 3 });
    for (let i = 0; i < 200; i += 1) {
      await recorder.observe(
        observation({
          provider: `probe${i}`,
          providerKnown: false,
          reasonCode: 'unknown_provider',
          body: null,
          source: { ip: null, header: 'none' },
        }),
      );
    }
    await recorder.flush();

    const rows = store.all();
    expect(rows.length).toBeLessThanOrEqual(4);
    const folded = rows.find((r) => r.sourceHeader === 'folded')!;
    expect(folded.provider).toBe('');
    expect(folded.endpoint).toBe('/api/webhooks/');
    expect(rows.reduce((n, r) => n + r.refusals, 0)).toBe(200);
  });

  it('keeps a known provider on the fold, because that dimension IS bounded', async () => {
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store, maxRowsPerMinute: 2 });
    for (let i = 0; i < 50; i += 1) {
      await recorder.observe(
        observation({ source: { ip: `198.51.100.${i}`, header: 'x-forwarded-for' } }),
      );
    }
    await recorder.flush();
    const folded = store.all().find((r) => r.sourceHeader === 'folded')!;
    expect(folded.provider).toBe('lithic');
  });

  it('refills the budget when the minute rolls', async () => {
    const store = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store, maxRowsPerMinute: 2 });
    for (let minute = 0; minute < 3; minute += 1) {
      for (let i = 0; i < 10; i += 1) {
        await recorder.observe(
          observation({
            source: { ip: `198.51.100.${i}`, header: 'x-forwarded-for' },
            at: new Date(NOW.getTime() + minute * 60_000),
          }),
        );
      }
    }
    await recorder.flush();
    const perMinute = new Map<number, number>();
    for (const row of store.all()) {
      perMinute.set(row.minuteBucket.getTime(), (perMinute.get(row.minuteBucket.getTime()) ?? 0) + 1);
    }
    expect([...perMinute.values()].every((n) => n <= 3)).toBe(true);
    expect(perMinute.size).toBe(3);
  });

  it('never lets a failing write reach the caller', async () => {
    const errors: unknown[] = [];
    const recorder = createRefusalRecorder({
      store: {
        async record() {
          throw new Error('connection terminated unexpectedly');
        },
      },
      onError: (e) => errors.push(e),
    });
    await expect(recorder.observe(observation())).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 6. End to end through the route handler
// ---------------------------------------------------------------------------

describe('handleWebhookRequest records refusals without softening them', () => {
  const post = async (provider: string, req: ReturnType<typeof delivery>) => {
    const inbox = trackingStore();
    const refusals = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store: refusals });
    const response = await handleWebhookRequest(req, provider, {
      store: inbox,
      registry,
      env: ENV,
      now: () => NOW,
      recorder,
    });
    await recorder.flush();
    return { response, body: (await response.json()) as Record<string, unknown>, inbox, refusals };
  };

  it('files a forged signature as signature_mismatch and ingests nothing', async () => {
    const { response, inbox, refusals } = await post(
      'lithic',
      lithicDelivery(BODY, { 'webhook-signature': 'v1,ZGVhZGJlZWY=' }),
    );

    expect(response.status).toBe(401);
    expect(inbox.writes).toHaveLength(0);

    const rows = refusals.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'lithic',
      endpoint: '/api/webhooks/lithic',
      reasonCode: 'signature_mismatch',
      sourceIp: '203.0.113.7',
      sourceHeader: 'x-forwarded-for',
      refusals: 1,
      signaturePresent: true,
      signatureShape: 'swh:v1x1',
      bodySha256: BODY_SHA256,
      bodyBytes: Buffer.byteLength(BODY),
    });
  });

  it('files a missing signature header as signature_absent', async () => {
    const req = delivery(BODY, { 'webhook-id': EVENT_ID, 'webhook-timestamp': TIMESTAMP });
    const { response, refusals } = await post('lithic', req);
    expect(response.status).toBe(401);
    expect(refusals.all()[0]).toMatchObject({
      reasonCode: 'signature_absent',
      signaturePresent: false,
      signatureShape: 'swh:nosig',
      sourceHeader: 'none',
      sourceIp: null,
    });
  });

  it('files a stale timestamp as timestamp_outside_window, not as a forgery', async () => {
    const stale = String(Number(TIMESTAMP) - 4000);
    const req = lithicDelivery(BODY, {
      'webhook-timestamp': stale,
      'webhook-signature': signLithic(BODY, EVENT_ID, stale),
    });
    const { response, refusals } = await post('lithic', req);
    expect(response.status).toBe(401);
    expect(refusals.all()[0]!.reasonCode).toBe('timestamp_outside_window');
  });

  it('files an unknown provider WITHOUT reading the body', async () => {
    const { response, refusals } = await post('shopify', lithicDelivery(BODY));
    expect(response.status).toBe(404);
    const row = refusals.all()[0]!;
    expect(row.reasonCode).toBe('unknown_provider');
    // The database says the same thing:
    // webhook_refusal_body_read_iff_there_was_a_verifier.
    expect(row.bodySha256).toBeNull();
    expect(row.bodyBytes).toBeNull();
  });

  it('sanitises the path segment before it can reach a row', async () => {
    const { refusals } = await post('<script>alert(1)</script>', lithicDelivery(BODY));
    const row = refusals.all()[0]!;
    expect(row.provider).toBe('scriptalert1script');
    expect(row.provider).toMatch(/^[A-Za-z0-9_-]{0,40}$/);
    expect(row.endpoint).toMatch(/^\/api\/webhooks\/[A-Za-z0-9_-]{0,40}$/);
  });

  it('stores NOTHING an attacker authored, even when the body is hostile', async () => {
    const hostile = '{"note":"<img src=x onerror=alert(1)>","drop":"; DROP TABLE webhook_refusal"}';
    const { refusals } = await post(
      'lithic',
      delivery(hostile, {
        'webhook-id': EVENT_ID,
        'webhook-timestamp': TIMESTAMP,
        'webhook-signature': 'v1,ZGVhZGJlZWY=',
        'user-agent': '<script>alert(2)</script>',
        'x-request-id': '<script>alert(3)</script>',
      }),
    );
    const row = refusals.all()[0]!;
    const serialised = JSON.stringify(row);
    for (const marker of ['script', 'onerror', 'DROP TABLE', 'img src']) {
      expect(serialised).not.toContain(marker);
    }
    // What IS kept is the hash, which is how you recognise the same forgery
    // again without holding a copy of it.
    expect(row.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.bodyBytes).toBe(Buffer.byteLength(hostile));
  });

  it('NEGATIVE CONTROL: a genuine delivery ingests and leaves no refusal row', async () => {
    const { response, inbox, refusals } = await post('lithic', lithicDelivery(BODY));
    expect(response.status).toBe(202);
    expect(inbox.writes).toHaveLength(1);
    expect(inbox.writes[0]!.rawBody).toBe(BODY);
    expect(refusals.all()).toHaveLength(0);
  });

  it('NEGATIVE CONTROL: a replay is still a 200 and still not a refusal', async () => {
    const inbox = trackingStore();
    const refusals = createMemoryRefusalStore();
    const recorder = createRefusalRecorder({ store: refusals });
    const opts = { store: inbox, registry, env: ENV, now: () => NOW, recorder };
    await handleWebhookRequest(lithicDelivery(BODY), 'lithic', opts);
    const second = await handleWebhookRequest(lithicDelivery(BODY), 'lithic', opts);
    await recorder.flush();
    expect(second.status).toBe(200);
    expect(refusals.all()).toHaveLength(0);
  });

  it('does not file a 503 not_configured as a refusal', async () => {
    // Stripe is deliberately absent from ENV. A secret we forgot to set is a
    // fact about our deployment — already published by /api/health — not a
    // refusal of the caller, and a stranger must not be able to inflate our
    // refusal rate by POSTing at it.
    const { response, refusals } = await post('stripe', lithicDelivery(BODY));
    expect(response.status).toBe(503);
    expect(refusals.all()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. The health field
// ---------------------------------------------------------------------------

function rate(overrides: Partial<RefusalRateRow> = {}): RefusalRateRow {
  return {
    provider: 'lithic',
    reasonCode: 'signature_mismatch',
    refusals15m: 1,
    refusals24h: 1,
    distinctSources24h: 1,
    foldedRows24h: 0,
    lastSeenAt: NOW,
    ...overrides,
  };
}

const read = (...rows: RefusalRateRow[]) => ({ ok: true as const, rows, latencyMs: 3 });

describe('webhookRefusalHealth', () => {
  it('shares no word with the other three health vocabularies', () => {
    // DECISIONS 021: one opinion per question, and `live` + `fresh` +
    // `consuming` + `forged` must read as four facts, never a contradiction.
    const others = new Set<string>([
      ...DELIVERY_VERDICTS,
      ...PROCESSING_VERDICTS,
      'live',
      'simulated',
      'unauthorised',
      'unreachable',
      'not_configured',
      'unprobed',
      'rate_limited',
    ]);
    for (const verdict of REFUSAL_VERDICTS) expect(others.has(verdict)).toBe(false);
  });

  it('says clean when nothing was refused', () => {
    const health = webhookRefusalHealth(read(), NOW);
    expect(health.providers.every((p) => p.verdict === 'clean')).toBe(true);
    expect(health.needsAttention).toEqual([]);
  });

  it('says forged, and names the provider, when a well-formed signature did not verify', () => {
    const health = webhookRefusalHealth(read(rate()), NOW);
    const lithic = health.providers.find((p) => p.provider === 'lithic')!;
    expect(lithic.verdict).toBe('forged');
    expect(lithic.byReason.signature_mismatch).toBe(1);
    expect(health.needsAttention).toEqual(['lithic']);
  });

  it('says stale_clock rather than forged when only timestamps failed', () => {
    const health = webhookRefusalHealth(read(rate({ reasonCode: 'timestamp_outside_window' })), NOW);
    expect(health.providers.find((p) => p.provider === 'lithic')!.verdict).toBe('stale_clock');
    expect(health.needsAttention).toEqual([]);
  });

  it('says probed for unsigned and malformed traffic', () => {
    const health = webhookRefusalHealth(
      read(rate({ reasonCode: 'signature_absent' }), rate({ reasonCode: 'signature_malformed' })),
      NOW,
    );
    expect(health.providers.find((p) => p.provider === 'lithic')!.verdict).toBe('probed');
  });

  it('counts unroutable segments and NEVER lists them', () => {
    const health = webhookRefusalHealth(
      read(
        rate({ provider: 'shopify', reasonCode: 'unknown_provider', refusals24h: 9 }),
        rate({ provider: 'wordpress', reasonCode: 'unknown_provider', refusals24h: 4 }),
      ),
      NOW,
    );
    expect(health.unroutable).toEqual({
      refusals15m: 2,
      refusals24h: 13,
      distinctSegments24h: 2,
    });
    // The segment is attacker-authored text and a health endpoint is a screen.
    expect(JSON.stringify(health)).not.toContain('shopify');
  });

  it('surfaces folded rows so a spent write budget is never silent', () => {
    const health = webhookRefusalHealth(read(rate({ foldedRows24h: 7 })), NOW);
    expect(health.foldedRows24h).toBe(7);
  });

  it('says uncounted, never clean, when the query did not run', () => {
    const health = webhookRefusalHealth(refusalsUnavailable('database unreachable'), NOW);
    expect(health.measured).toBe(false);
    expect(health.providers.every((p) => p.verdict === 'uncounted')).toBe(true);
    expect(health.error).toBe('database unreachable');
    // A refusal count that could not be read must not mark the deployment
    // degraded, and neither must one that could.
    expect(health.needsAttention).toEqual([]);
  });

  it('reports every reason code it might be handed', () => {
    const health = webhookRefusalHealth(
      read(...REFUSAL_REASONS.map((reasonCode) => rate({ reasonCode }))),
      NOW,
    );
    const lithic = health.providers.find((p) => p.provider === 'lithic')!;
    expect(Object.values(lithic.byReason).every((n) => n === 1)).toBe(true);
    expect(lithic.refusals24h).toBe(REFUSAL_REASONS.length);
  });
});

// ---------------------------------------------------------------------------
// 8. The real statement, against real Postgres
//
// The memory store is a test double: it mirrors the unique index, it does not
// prove it. The statement in `createPostgresRefusalStore` is a multi-row
// INSERT ... ON CONFLICT DO UPDATE with a cast at every use site, and inbox.ts
// carries two scars from exactly this shape — a jsonb double-encode and an
// ambiguous `id` — both of which passed every in-memory test and failed only
// against a real database, because a double never parses SQL.
//
// Runs when WEBHOOK_REFUSAL_TEST_DATABASE_URL is set. Everything happens inside
// a transaction that is ALWAYS rolled back, so it is safe to point at a live
// branch: it writes nothing that survives the test.
// ---------------------------------------------------------------------------

const REFUSAL_DB = process.env.WEBHOOK_REFUSAL_TEST_DATABASE_URL;

(REFUSAL_DB ? describe : describe.skip)('the upsert, against real Postgres', () => {
  it('opens a bucket, then counts into it, and never rewrites its facts', async () => {
    const postgres = (await import('postgres')).default;
    const { createPostgresRefusalStore, sqlExecutorFromPostgresJs } = {
      ...(await import('./refusals')),
      ...(await import('./inbox')),
    };

    const sql = postgres(REFUSAL_DB!, { max: 1, prepare: false, onnotice: () => {} });
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const bucket = {
      provider: 'lithic',
      endpoint: '/api/webhooks/lithic',
      reasonCode: 'signature_mismatch' as const,
      sourceIp: '198.51.100.77',
      sourceHeader: 'x-forwarded-for' as const,
      minuteBucket: minute,
      firstSeenAt: minute,
      lastSeenAt: minute,
      refusals: 4,
      signaturePresent: true,
      signatureShape: 'swh:v1x1',
      signatureBytes: 47,
      bodyBytes: 60,
      bodySha256: 'a'.repeat(64),
      bodyVaried: false,
    };

    try {
      await expect(
        sql.begin(async (tx) => {
          const store = createPostgresRefusalStore(sqlExecutorFromPostgresJs(tx));

          // Two rows in ONE statement: the batch path, not a loop.
          await store.record([
            bucket,
            { ...bucket, reasonCode: 'unknown_provider', bodySha256: null, bodyBytes: null },
          ]);
          // The same bucket again, with a DIFFERENT body: the count adds and
          // the variation is noticed, in SQL, against a row this process may
          // never have seen.
          await store.record([
            { ...bucket, refusals: 6, bodySha256: 'b'.repeat(64), lastSeenAt: new Date(minute.getTime() + 30_000) },
          ]);

          const rows = (await tx.unsafe(
            `select reason_code, refusals, body_varied, body_sha256, last_seen_at
               from webhook_refusal
              where source_ip = '198.51.100.77' order by reason_code`,
          )) as unknown as Record<string, unknown>[];

          expect(rows).toHaveLength(2);
          const mismatch = rows.find((r) => r['reason_code'] === 'signature_mismatch')!;
          expect(Number(mismatch['refusals'])).toBe(10);
          expect(mismatch['body_varied']).toBe(true);
          // The exemplar is the FIRST body, never overwritten by a later one.
          expect(mismatch['body_sha256']).toBe('a'.repeat(64));

          // The unknown_provider row really did land with null body columns,
          // which is what webhook_refusal_body_read_iff_there_was_a_verifier
          // demands and what proves the constraint is satisfiable both ways.
          const unknown = rows.find((r) => r['reason_code'] === 'unknown_provider')!;
          expect(unknown['body_sha256']).toBeNull();

          throw new Error('rollback: this test writes nothing that survives it');
        }),
      ).rejects.toThrow('rollback');

      const survivors = (await sql.unsafe(
        `select count(*)::int as n from webhook_refusal where source_ip = '198.51.100.77'`,
      )) as unknown as { n: number }[];
      expect(survivors[0]!.n).toBe(0);
    } finally {
      await sql.end();
    }
  });
});
