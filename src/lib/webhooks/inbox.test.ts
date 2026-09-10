import { describe, expect, it } from 'vitest';
import { createHmac, generateKeyPairSync, sign as signWithKey } from 'node:crypto';
import {
  createMemoryInboxStore,
  increaseVerifier,
  ingestWebhook,
  lithicVerifier,
  personaVerifier,
  plaidVerifier,
  stripeVerifier,
  VerifierRegistry,
  type PlaidJwk,
} from './inbox';
import { sha256Hex } from './rawbody';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function fakeRequest(body: string, headers: Record<string, string>) {
  return {
    async text() {
      return body;
    },
    headers,
  };
}

// The canonical Standard Webhooks test vector. Lithic prints this exact
// signature in its own docs, so reproducing it proves the verifier is
// byte-compatible with theirs rather than merely self-consistent.
const SW_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const SW_ID = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
const SW_TIMESTAMP = '1614265330';
const SW_BODY = '{"test": 2432232314}';
const SW_SIGNATURE = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=';
/** The clock at which that delivery is fresh. */
const SW_NOW = new Date(Number(SW_TIMESTAMP) * 1000);

function standardHeaders(overrides: Record<string, string> = {}) {
  return {
    'webhook-id': SW_ID,
    'webhook-timestamp': SW_TIMESTAMP,
    'webhook-signature': SW_SIGNATURE,
    ...overrides,
  };
}

function signStandard(secret: string, id: string, ts: string, body: string, encoding: 'base64' | 'utf8') {
  const key = encoding === 'base64' ? Buffer.from(secret.replace(/^whsec_/, ''), 'base64') : Buffer.from(secret, 'utf8');
  return `v1,${createHmac('sha256', key).update(`${id}.${ts}.${body}`, 'utf8').digest('base64')}`;
}

function signHex(secret: string, ts: string, body: string) {
  return createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Standard Webhooks (Lithic, Increase)
// ---------------------------------------------------------------------------

describe('lithicVerifier (Standard Webhooks)', () => {
  const verifier = lithicVerifier({ secret: SW_SECRET });

  const verify = (body: string, headers: Record<string, string>, now = SW_NOW) =>
    verifier.verify({ raw: body, headers: (n) => headers[n.toLowerCase()] ?? null, now });

  it('reproduces the canonical test vector', async () => {
    expect(await verify(SW_BODY, standardHeaders())).toEqual({ ok: true });
  });

  it('rejects the same payload re-serialised — the raw-body footgun, as a test', async () => {
    const restringified = JSON.stringify(JSON.parse(SW_BODY));
    const outcome = await verify(restringified, standardHeaders());
    expect(outcome.ok).toBe(false);
  });

  it('rejects a tampered body', async () => {
    expect((await verify('{"test": 9999999999}', standardHeaders())).ok).toBe(false);
  });

  it('accepts when one of several rotation signatures matches', async () => {
    const headers = standardHeaders({
      'webhook-signature': `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${SW_SIGNATURE}`,
    });
    expect(await verify(SW_BODY, headers)).toEqual({ ok: true });
  });

  it('ignores signature versions it does not know', async () => {
    const headers = standardHeaders({ 'webhook-signature': SW_SIGNATURE.replace('v1,', 'v2,') });
    expect((await verify(SW_BODY, headers)).ok).toBe(false);
  });

  it('rejects a stale delivery (replay window)', async () => {
    const tooLate = new Date(SW_NOW.getTime() + 301_000);
    const outcome = await verify(SW_BODY, standardHeaders(), tooLate);
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain('too old');
  });

  it('rejects a delivery from the future', async () => {
    const tooEarly = new Date(SW_NOW.getTime() - 301_000);
    expect((await verify(SW_BODY, standardHeaders(), tooEarly)).ok).toBe(false);
  });

  it('rejects when a signature header is missing', async () => {
    const rest: Record<string, string> = standardHeaders();
    delete rest['webhook-signature'];
    expect((await verify(SW_BODY, rest)).ok).toBe(false);
  });

  it('takes the event id from the webhook-id header', () => {
    const headers: Record<string, string> = standardHeaders();
    const identity = verifier.identify({
      raw: SW_BODY,
      headers: (n) => headers[n.toLowerCase()] ?? null,
      payload: { event_type: 'card_transaction.updated' },
    });
    expect(identity).toEqual({ providerEventId: SW_ID, eventType: 'card_transaction.updated' });
  });
});

describe('increaseVerifier (Standard Webhooks, raw shared secret)', () => {
  const secret = 'a-shared-secret-from-the-event-subscription';
  const verifier = increaseVerifier({ secret });
  const body = JSON.stringify({
    id: 'event_123abc',
    category: 'ach_transfer.updated',
    associated_object_id: 'ach_transfer_uoxatyh3lt5evrsdvo7q',
  });
  const ts = '1757000000';
  const now = new Date(Number(ts) * 1000);
  const headers = {
    'webhook-id': 'msg_increase_1',
    'webhook-timestamp': ts,
    'webhook-signature': signStandard(secret, 'msg_increase_1', ts, body, 'utf8'),
  };

  it('verifies with the secret used as raw bytes, not base64-decoded', async () => {
    const outcome = await verifier.verify({ raw: body, headers: (n) => headers[n as keyof typeof headers] ?? null, now });
    expect(outcome).toEqual({ ok: true });
  });

  it('prefers the Event object id over the transport id', () => {
    const identity = verifier.identify({
      raw: body,
      headers: (n) => headers[n as keyof typeof headers] ?? null,
      payload: JSON.parse(body),
    });
    expect(identity).toEqual({ providerEventId: 'event_123abc', eventType: 'ach_transfer.updated' });
  });
});

// ---------------------------------------------------------------------------
// Timestamped hex HMAC (Persona, Stripe)
// ---------------------------------------------------------------------------

describe('personaVerifier', () => {
  const secret = 'wbhsec_abcdefgh-1234-5678-9ijk-lmnopqrstuvw';
  const verifier = personaVerifier({ secret });
  const body = JSON.stringify({
    data: { type: 'event', id: 'evt_XGuYWp7WuDzNxie5z16s7sGJ', attributes: { name: 'inquiry.approved' } },
  });
  const ts = '1757000000';
  const now = new Date(Number(ts) * 1000);
  const verify = (raw: string, header: string, at = now) =>
    verifier.verify({ raw, headers: (n) => (n === 'persona-signature' ? header : null), now: at });

  it('verifies t=<unix>,v1=<hex> over `${t}.${rawBody}`', async () => {
    expect(await verify(body, `t=${ts},v1=${signHex(secret, ts, body)}`)).toEqual({ ok: true });
  });

  it('accepts the second of two space-separated rotation groups', async () => {
    const header = `t=${ts},v1=deadbeef t=${ts},v1=${signHex(secret, ts, body)}`;
    expect(await verify(body, header)).toEqual({ ok: true });
  });

  it('rejects a tampered body', async () => {
    const header = `t=${ts},v1=${signHex(secret, ts, body)}`;
    expect((await verify(body.replace('approved', 'declined'), header)).ok).toBe(false);
  });

  it('applies our own 300s tolerance, which Persona does not publish', async () => {
    const header = `t=${ts},v1=${signHex(secret, ts, body)}`;
    expect((await verify(body, header, new Date(now.getTime() + 301_000))).ok).toBe(false);
  });

  it('pulls the event id and name out of the JSON:API envelope', () => {
    expect(verifier.identify({ raw: body, headers: () => null, payload: JSON.parse(body) })).toEqual({
      providerEventId: 'evt_XGuYWp7WuDzNxie5z16s7sGJ',
      eventType: 'inquiry.approved',
    });
  });
});

describe('stripeVerifier (the fifth provider, added without touching the dispatcher)', () => {
  const secret = 'whsec_stripe_test';
  const verifier = stripeVerifier({ secret });
  const body = JSON.stringify({ id: 'evt_1', type: 'account.updated' });
  const ts = '1757000000';
  const now = new Date(Number(ts) * 1000);

  it('parses one group with several comma-separated signatures', async () => {
    const header = `t=${ts},v1=${signHex(secret, ts, body)},v0=ignored`;
    const outcome = await verifier.verify({
      raw: body,
      headers: (n) => (n === 'stripe-signature' ? header : null),
      now,
    });
    expect(outcome).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Plaid: ES256 JWT over a hash of the raw body
// ---------------------------------------------------------------------------

describe('plaidVerifier', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as unknown as PlaidJwk;
  const kid = 'bfbd5111-8e33-4643-8ced-b2e642a72f3c';
  const body = JSON.stringify({
    webhook_type: 'ITEM',
    webhook_code: 'ERROR',
    item_id: 'wz666MBjYWTp2PDzzggYhM6oWWmBb',
    environment: 'sandbox',
  });
  const iat = 1757000000;
  const now = new Date(iat * 1000);

  const b64u = (obj: unknown) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');

  function makeJwt(opts: { alg?: string; iat?: number; bodyHash?: string; badSignature?: boolean }) {
    const header = b64u({ alg: opts.alg ?? 'ES256', kid, typ: 'JWT' });
    const payload = b64u({ iat: opts.iat ?? iat, request_body_sha256: opts.bodyHash ?? sha256Hex(body) });
    const signature = signWithKey('sha256', Buffer.from(`${header}.${payload}`, 'utf8'), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    return `${header}.${payload}.${opts.badSignature ? 'AAAA' + signature.slice(4) : signature}`;
  }

  const verifier = plaidVerifier({
    fetchVerificationKey: async (k) => (k === kid ? { ...jwk, kid, alg: 'ES256', expired_at: null } : null),
    expectedEnvironment: 'sandbox',
  });
  const verify = (raw: string, token: string, at = now) =>
    verifier.verify({ raw, headers: (n) => (n === 'plaid-verification' ? token : null), now: at });

  it('verifies a genuine delivery', async () => {
    expect(await verify(body, makeJwt({}))).toEqual({ ok: true });
  });

  it('rejects alg confusion (the "none"/HS256 attack)', async () => {
    const outcome = await verify(body, makeJwt({ alg: 'none' }));
    expect(outcome).toMatchObject({ ok: false });
    expect((outcome as { reason: string }).reason).toContain('alg');
  });

  it('rejects a forged signature', async () => {
    expect((await verify(body, makeJwt({ badSignature: true }))).ok).toBe(false);
  });

  it('rejects when the body hash does not match the claim', async () => {
    expect((await verify(body + ' ', makeJwt({}))).ok).toBe(false);
  });

  it('rejects a stale JWT', async () => {
    expect((await verify(body, makeJwt({}), new Date((iat + 301) * 1000))).ok).toBe(false);
  });

  it('rejects an unknown kid', async () => {
    const other = plaidVerifier({ fetchVerificationKey: async () => null });
    const outcome = await other.verify({
      raw: body,
      headers: (n) => (n === 'plaid-verification' ? makeJwt({}) : null),
      now,
    });
    expect(outcome.ok).toBe(false);
  });

  it('derives a dedupe key from the body hash, because Plaid ships no event id', () => {
    const identity = verifier.identify({ raw: body, headers: () => null, payload: JSON.parse(body) });
    expect(identity.providerEventId).toBe(`sha256:${sha256Hex(body)}`);
    expect(identity.eventType).toBe('ITEM.ERROR');
  });

  it('refuses a production webhook on a sandbox deployment', () => {
    const outcome = verifier.accept!({
      raw: body,
      headers: () => null,
      payload: { ...JSON.parse(body), environment: 'production' },
    });
    expect(outcome.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('VerifierRegistry', () => {
  it('refuses a silent second registration for the same provider', () => {
    const registry = new VerifierRegistry();
    registry.register(lithicVerifier({ secret: SW_SECRET }));
    expect(() => registry.register(lithicVerifier({ secret: SW_SECRET }))).toThrow(/already registered/);
    expect(() => registry.register(lithicVerifier({ secret: SW_SECRET }), { replace: true })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Ingestion: verify -> persist -> ack. And replay.
// ---------------------------------------------------------------------------

function registryWithLithic() {
  return new VerifierRegistry().register(lithicVerifier({ secret: SW_SECRET }));
}

describe('ingestWebhook', () => {
  it('accepts a first delivery and stores the raw bytes it verified', async () => {
    const store = createMemoryInboxStore();
    const result = await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), {
      store,
      registry: registryWithLithic(),
      now: () => SW_NOW,
    });

    expect(result).toMatchObject({ status: 'accepted', httpStatus: 202, providerEventId: SW_ID });
    const rows = store.all();
    expect(rows).toHaveLength(1);
    const row = rows[0]!; // asserted non-null: the line above proves there is one
    expect(row.rawBody).toBe(SW_BODY);
    expect(row.state).toBe('pending');
    expect(row.processedAt).toBeNull();
    // Only the signature headers are kept — never anything else on the request.
    expect(Object.keys(row.headers).sort()).toEqual(['webhook-id', 'webhook-signature', 'webhook-timestamp']);
  });

  it('REPLAY: the same event delivered twice leaves exactly one row', async () => {
    const store = createMemoryInboxStore();
    const deps = { store, registry: registryWithLithic(), now: () => SW_NOW };

    const first = await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), deps);
    const second = await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), deps);

    expect(first.status).toBe('accepted');
    // Decided by the unique index, not by an if-statement in the handler.
    expect(second.status).toBe('replay');
    expect(second.httpStatus).toBe(200); // still 2xx: a replay is not an error
    expect(store.all()).toHaveLength(1);
    expect((first as { id: string }).id).toBe((second as { id: string }).id);
    expect(store.all()[0]!.providerEventId).toBe(SW_ID);
  });

  it('a replay of an already-processed event does not resurrect it', async () => {
    const store = createMemoryInboxStore();
    const deps = { store, registry: registryWithLithic(), now: () => SW_NOW };
    const first = await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), deps);
    await store.markProcessed((first as { id: string }).id, SW_NOW);

    const replay = await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), deps);

    expect(replay.status).toBe('replay');
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.state).toBe('done');
  });

  it('rejects a bad signature with 401 and persists nothing', async () => {
    const store = createMemoryInboxStore();
    const result = await ingestWebhook(
      'lithic',
      fakeRequest('{"test": 1}', standardHeaders()),
      { store, registry: registryWithLithic(), now: () => SW_NOW },
    );
    expect(result).toMatchObject({ status: 'rejected', httpStatus: 401 });
    expect(store.all()).toHaveLength(0);
  });

  it('404s an unknown provider instead of storing an unverifiable event', async () => {
    const store = createMemoryInboxStore();
    const result = await ingestWebhook('acme', fakeRequest('{}', {}), {
      store,
      registry: registryWithLithic(),
      now: () => SW_NOW,
    });
    expect(result).toMatchObject({ status: 'rejected', httpStatus: 404 });
    expect(store.all()).toHaveLength(0);
  });

  it('files a verified-but-unparseable body as dead on arrival rather than losing it', async () => {
    const store = createMemoryInboxStore();
    const body = 'not json at all';
    const headers = standardHeaders({
      'webhook-signature': signStandard(SW_SECRET, SW_ID, SW_TIMESTAMP, body, 'base64'),
    });
    const result = await ingestWebhook('lithic', fakeRequest(body, headers), {
      store,
      registry: registryWithLithic(),
      now: () => SW_NOW,
    });

    expect(result).toMatchObject({ status: 'dead_on_arrival', httpStatus: 202 });
    const rows = store.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('dead');
    expect(rows[0]!.rawBody).toBe(body);
  });

  it('never processes inline: an accepted event is still pending afterwards', async () => {
    const store = createMemoryInboxStore();
    await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), {
      store,
      registry: registryWithLithic(),
      now: () => SW_NOW,
    });
    expect(store.all()[0]!.processedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The same replay assertion, against real Postgres.
//
// The in-memory store is a test double: it mirrors the unique constraint, it
// does not prove it. This block is the authoritative version and runs when
// WEBHOOK_INBOX_TEST_DATABASE_URL points at a throwaway database. It applies
// 0002_webhook_inbox.sql itself, so it also proves the migration parses.
// ---------------------------------------------------------------------------

const TEST_DATABASE_URL = process.env.WEBHOOK_INBOX_TEST_DATABASE_URL;

(TEST_DATABASE_URL ? describe : describe.skip)('replay, against real Postgres', () => {
  it('ON CONFLICT DO NOTHING makes the second delivery a no-op', async () => {
    const { readFileSync } = await import('node:fs');
    const postgres = (await import('postgres')).default;
    const { createPostgresInboxStore, sqlExecutorFromPostgresJs } = await import('./inbox');

    const sql = postgres(TEST_DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      // 0001 creates the table; 0002 finishes it. Both are applied here so the
      // test also proves both files parse.
      const migrations = ['0001_ledger.sql', '0002_webhook_inbox.sql'].map((f) =>
        readFileSync(new URL(`../../../db/migrations/${f}`, import.meta.url), 'utf8'),
      );
      await sql.unsafe('drop schema public cascade; create schema public;');
      for (const body of migrations) await sql.unsafe(body);

      const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));
      const deps = { store, registry: registryWithLithic(), now: () => SW_NOW };
      const first = await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), deps);
      const second = await ingestWebhook('lithic', fakeRequest(SW_BODY, standardHeaders()), deps);

      expect(first.status).toBe('accepted');
      expect(second.status).toBe('replay');

      const counted = await sql.unsafe('select count(*)::int as n from webhook_inbox');
      expect((counted as unknown as { n: number }[])[0]!.n).toBe(1);

      // ...and the row still holds the exact bytes we verified.
      const stored = await store.findByProviderEventId('lithic', SW_ID);
      expect(stored?.rawBody).toBe(SW_BODY);
    } finally {
      await sql.end();
    }
  });
});
