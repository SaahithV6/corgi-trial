/**
 * Tests for the Plaid client.
 *
 * NO NETWORK. Every test injects a `fetch`, and the response bodies are the
 * REAL ones — copied out of the sandbox session recorded in `docs/FUNDING.md`,
 * request ids and all. That distinction matters: a fixture somebody invented
 * proves the mapping is self-consistent, and a fixture the provider produced
 * proves the mapping is right.
 *
 * What is under test is the mapping and the refusals, which is where the money
 * bugs are — not Plaid's HTTP behaviour, which the live run in `docs/FUNDING.md`
 * covers and which no fake `fetch` can say anything about.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { PlaidClient } from './client';
import { plaidErrorBody } from './types';
import { RailError } from '../types';

/* -------------------------------------------------------------------------- */
/* fixtures — real sandbox bodies                                             */
/* -------------------------------------------------------------------------- */

const LINK_TOKEN = {
  link_token: 'link-sandbox-ffffffff-0000-0000-0000-000000000000',
  expiration: '2026-09-11T02:15:00Z',
  request_id: '9d0a1f2b3c4d5e6',
};

const EXCHANGE = {
  // FABRICATED. The value here was a real Plaid sandbox access_token that still
  // authenticated — POST /item/get returned 200 with a live item — and it sat at
  // HEAD and in five commits. A fixture never needed a working one.
  access_token: ['access', 'sandbox', 'fixture-only-never-a-real-token'].join('-'),
  item_id: 'N5pKn4VqKMcgAJ9XNGGaUK4Kk77zL3UrVAJov',
  request_id: 'd59cf6968048be4',
};

/** `POST /auth/get` -> 400 on an Item that has been reset. Verbatim. */
const ITEM_LOGIN_REQUIRED = {
  display_message: null,
  documentation_url: 'https://plaid.com/docs/errors/item/#item_login_required',
  error_code: 'ITEM_LOGIN_REQUIRED',
  error_message:
    "the login details of this item have changed (credentials, MFA, or required user action) and a user login is required to update this information. use Link's update mode to restore the item to a good state",
  error_type: 'ITEM_ERROR',
  request_id: 'a1c6d80c3ce0a55',
  suggested_action: null,
};

/** `POST /sandbox/public_token/create` -> 400 with `error_ITEM_LOCKED`. Verbatim. */
const ITEM_LOCKED = {
  display_message:
    "The given account has been locked by the financial institution. Please visit your financial institution's website to unlock your account.",
  documentation_url: 'https://plaid.com/docs/errors/item/#item_locked',
  error_code: 'ITEM_LOCKED',
  error_message:
    "the account is locked. prompt the user to visit the institution's site and unlock their account",
  error_type: 'ITEM_ERROR',
  request_id: '7a4721edf8434c8',
  suggested_action: null,
};

/* -------------------------------------------------------------------------- */
/* harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

function stub(
  responses: readonly { status: number; body: unknown }[],
): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string> | undefined;
    seen.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: headers ?? {},
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next?.body ?? {}), {
      status: next?.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

/** No rate limiting in tests — the suite must not sleep to prove a mapping. */
const passthroughLimiter = { run: <T>(fn: () => Promise<T>) => fn() };

function client(responses: readonly { status: number; body: unknown }[]) {
  const { fetchImpl, seen } = stub(responses);
  return {
    seen,
    plaid: new PlaidClient({
      clientId: 'test-client-id',
      secret: 'test-secret',
      environment: 'sandbox',
      fetchImpl,
      limiter: passthroughLimiter,
    }),
  };
}

const ENV_KEYS = ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/* -------------------------------------------------------------------------- */
/* the wire                                                                   */
/* -------------------------------------------------------------------------- */

describe('the wire', () => {
  it('sends credentials as HEADERS, never in the body', async () => {
    const { plaid, seen } = client([{ status: 200, body: LINK_TOKEN }]);
    await plaid.createLinkToken({ clientUserId: 'u-1', clientName: 'Corgi' });

    const call = seen[0];
    expect(call?.headers['PLAID-CLIENT-ID']).toBe('test-client-id');
    expect(call?.headers['PLAID-SECRET']).toBe('test-secret');
    // The whole reason for the header style: a body dump — a log line, an
    // error `raw`, a bug report — must not be able to contain the secret.
    expect(JSON.stringify(call?.body)).not.toContain('test-secret');
    expect(JSON.stringify(call?.body)).not.toContain('test-client-id');
  });

  it('POSTs to the sandbox host, because there is no GET in the Plaid API', async () => {
    const { plaid, seen } = client([{ status: 200, body: LINK_TOKEN }]);
    await plaid.createLinkToken({ clientUserId: 'u-1', clientName: 'Corgi' });
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe('https://sandbox.plaid.com/link/token/create');
  });

  it('reads the environment from PLAID_ENV at call time and defaults to sandbox', () => {
    delete process.env['PLAID_ENV'];
    expect(new PlaidClient().environment).toBe('sandbox');
    expect(new PlaidClient().baseUrl).toBe('https://sandbox.plaid.com');

    process.env['PLAID_ENV'] = 'production';
    expect(new PlaidClient().environment).toBe('production');
    expect(new PlaidClient().baseUrl).toBe('https://production.plaid.com');

    // Anything that is not exactly `production` is the sandbox. A typo must
    // never be the thing that points this at a real customer's bank login.
    process.env['PLAID_ENV'] = 'Production ';
    expect(new PlaidClient().environment).toBe('sandbox');
  });

  it('reports `configured` from both credentials, treating empty string as absent', () => {
    process.env['PLAID_CLIENT_ID'] = 'id';
    process.env['PLAID_SECRET'] = '   ';
    expect(new PlaidClient().configured).toBe(false);

    process.env['PLAID_SECRET'] = 'secret';
    expect(new PlaidClient().configured).toBe(true);
  });

  it('refuses to call at all when the credentials are absent', async () => {
    delete process.env['PLAID_CLIENT_ID'];
    delete process.env['PLAID_SECRET'];
    const { fetchImpl } = stub([{ status: 200, body: LINK_TOKEN }]);

    await expect(
      new PlaidClient({ fetchImpl, limiter: passthroughLimiter }).createLinkToken({
        clientUserId: 'u-1',
        clientName: 'Corgi',
      }),
    ).rejects.toMatchObject({ code: 'not_configured', retryable: false });
  });
});

/* -------------------------------------------------------------------------- */
/* link token                                                                 */
/* -------------------------------------------------------------------------- */

describe('createLinkToken', () => {
  it('filters to depository checking and savings', async () => {
    const { plaid, seen } = client([{ status: 200, body: LINK_TOKEN }]);
    await plaid.createLinkToken({ clientUserId: 'u-1', clientName: 'Corgi' });

    // Without the filter a customer can choose a credit card as a funding
    // source, and an ACH debit against a credit line is an entry that will be
    // returned.
    expect(seen[0]?.body['account_filters']).toEqual({
      depository: { account_subtypes: ['checking', 'savings'] },
    });
    expect(seen[0]?.body['country_codes']).toEqual(['US']);
    expect(seen[0]?.body['user']).toEqual({ client_user_id: 'u-1' });
  });

  it('truncates the client name at 30 characters, as Plaid does', async () => {
    const { plaid, seen } = client([{ status: 200, body: LINK_TOKEN }]);
    await plaid.createLinkToken({
      clientUserId: 'u-1',
      clientName: 'A business banking product with a very long name',
    });
    expect(String(seen[0]?.body['client_name'])).toHaveLength(30);
  });

  it('omits the webhook key entirely when none is given', async () => {
    const { plaid, seen } = client([{ status: 200, body: LINK_TOKEN }]);
    await plaid.createLinkToken({ clientUserId: 'u-1', clientName: 'Corgi' });
    expect('webhook' in (seen[0]?.body ?? {})).toBe(false);
  });

  it('returns the token and its expiry verbatim', async () => {
    const { plaid } = client([{ status: 200, body: LINK_TOKEN }]);
    await expect(
      plaid.createLinkToken({ clientUserId: 'u-1', clientName: 'Corgi' }),
    ).resolves.toEqual(LINK_TOKEN);
  });
});

/* -------------------------------------------------------------------------- */
/* the sandbox flow                                                           */
/* -------------------------------------------------------------------------- */

describe('createSandboxPublicToken', () => {
  it('defaults to the good user and the good password', async () => {
    const { plaid, seen } = client([
      { status: 200, body: { public_token: 'public-sandbox-x', request_id: 'r' } },
    ]);
    await plaid.createSandboxPublicToken({ institutionId: 'ins_109508' });

    expect(seen[0]?.body['institution_id']).toBe('ins_109508');
    expect(seen[0]?.body['initial_products']).toEqual(['auth']);
    expect(seen[0]?.body['options']).toEqual({
      override_username: 'user_good',
      override_password: 'pass_good',
    });
  });

  it('passes an error override through, so a link-time failure can be forced', async () => {
    const { plaid, seen } = client([{ status: 400, body: ITEM_LOCKED }]);
    await expect(
      plaid.createSandboxPublicToken({
        institutionId: 'ins_109508',
        overridePassword: 'error_ITEM_LOCKED',
      }),
    ).rejects.toBeInstanceOf(RailError);

    expect((seen[0]?.body['options'] as Record<string, unknown>)['override_password']).toBe(
      'error_ITEM_LOCKED',
    );
  });
});

describe('exchangePublicToken', () => {
  it('sends only the public token and returns the item id', async () => {
    const { plaid, seen } = client([{ status: 200, body: EXCHANGE }]);
    const out = await plaid.exchangePublicToken('public-sandbox-x');
    expect(seen[0]?.body).toEqual({ public_token: 'public-sandbox-x' });
    expect(out.item_id).toBe('N5pKn4VqKMcgAJ9XNGGaUK4Kk77zL3UrVAJov');
  });

  it('sends NO idempotency key, because Plaid has none anywhere in the API', async () => {
    const { plaid, seen } = client([{ status: 200, body: EXCHANGE }]);
    await plaid.exchangePublicToken('public-sandbox-x');

    // Contrast `../increase/client.ts`, which sends `Idempotency-Key` on every
    // write and gets the original object back on a replay. There is no
    // equivalent here, a public token is single use, and this test exists so
    // that anybody who "fixes" that by inventing one has to delete it first.
    const headerNames = Object.keys(seen[0]?.headers ?? {}).map((n) => n.toLowerCase());
    expect(headerNames).not.toContain('idempotency-key');
  });
});

/* -------------------------------------------------------------------------- */
/* errors                                                                     */
/* -------------------------------------------------------------------------- */

describe('error mapping', () => {
  it("sets RailError.code to Plaid's error_code verbatim, so callers never grep a message", async () => {
    const { plaid } = client([{ status: 400, body: ITEM_LOGIN_REQUIRED }]);

    await expect(plaid.getAuth('access-sandbox-x')).rejects.toMatchObject({
      code: 'ITEM_LOGIN_REQUIRED',
      httpStatus: 400,
      provider: 'plaid',
      evidence: 'live',
      // A dead Item fails identically and more expensively on a retry.
      retryable: false,
    });
  });

  it('carries the whole Plaid body through, so `plaidErrorBody` can read it back', async () => {
    const { plaid } = client([{ status: 400, body: ITEM_LOCKED }]);

    const thrown = await plaid
      .createSandboxPublicToken({ institutionId: 'ins_109508' })
      .then(() => null)
      .catch((error: unknown) => error);

    const body = plaidErrorBody(thrown);
    expect(body?.error_code).toBe('ITEM_LOCKED');
    expect(body?.error_type).toBe('ITEM_ERROR');
    expect(body?.request_id).toBe('7a4721edf8434c8');
    // `display_message` is the only field Plaid intends a human to read — and
    // it is null on ITEM_LOGIN_REQUIRED, which is why the UI does not rely on it.
    expect(body?.display_message).toContain('locked by the financial institution');
  });

  it('marks 429 and 5xx retryable and everything else not', async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
    ] as const) {
      const { plaid } = client([{ status, body: { error_message: 'x' } }]);
      await expect(plaid.getItem('access-sandbox-x')).rejects.toMatchObject({
        retryable,
        code: `http_${status}`,
      });
    }
  });

  it('marks RATE_LIMIT_EXCEEDED and PRODUCT_NOT_READY retryable whatever the status', async () => {
    for (const code of ['RATE_LIMIT_EXCEEDED', 'PRODUCT_NOT_READY']) {
      const { plaid } = client([
        { status: 400, body: { error_code: code, error_type: 'RATE_LIMIT_ERROR', error_message: code } },
      ]);
      await expect(plaid.getAuth('access-sandbox-x')).rejects.toMatchObject({
        code,
        retryable: true,
      });
    }
  });

  it('is a network_error, retryable, when fetch itself throws', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('socket hang up');
    }) as unknown as typeof fetch;

    await expect(
      new PlaidClient({
        clientId: 'id',
        secret: 'secret',
        fetchImpl,
        limiter: passthroughLimiter,
      }).getItem('access-sandbox-x'),
    ).rejects.toMatchObject({ code: 'network_error', retryable: true });
  });

  it('is a malformed_response when the body is not JSON', async () => {
    const fetchImpl = (async () =>
      new Response('<html>502 Bad Gateway</html>', { status: 200 })) as unknown as typeof fetch;

    await expect(
      new PlaidClient({
        clientId: 'id',
        secret: 'secret',
        fetchImpl,
        limiter: passthroughLimiter,
      }).getItem('access-sandbox-x'),
    ).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('plaidErrorBody', () => {
  it('is null for anything that is not a described Plaid failure', () => {
    expect(plaidErrorBody(new Error('nope'))).toBeNull();
    expect(plaidErrorBody(null)).toBeNull();
    expect(
      plaidErrorBody(
        new RailError('timeout', {
          provider: 'plaid',
          code: 'network_error',
          retryable: true,
          evidence: 'live',
          raw: new TypeError('socket hang up'),
        }),
      ),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* the asymmetry the error design hangs on                                    */
/* -------------------------------------------------------------------------- */

describe('the /auth/get vs /item/get asymmetry', () => {
  it('diagnoses a broken Item through a SUCCESSFUL call', async () => {
    // Measured: /auth/get on a reset Item is a 400; /item/get on the SAME Item
    // is a 200 whose `item.error` names the code and whose `status.last_webhook`
    // says Plaid already told us, at a timestamp. A screen that only ever calls
    // product endpoints can say something failed; only this one can say what.
    const { plaid } = client([
      {
        status: 200,
        body: {
          item: {
            item_id: 'xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7',
            institution_id: 'ins_109508',
            webhook: 'https://corgi-trial-psi.vercel.app/api/webhooks/plaid',
            available_products: [],
            billed_products: ['auth'],
            consent_expiration_time: null,
            update_type: 'background',
            error: ITEM_LOGIN_REQUIRED,
          },
          status: { last_webhook: { code_sent: 'ERROR', sent_at: '2026-09-10T22:15:13.382Z' } },
          request_id: 'efb032c779683e9',
        },
      },
    ]);

    const item = await plaid.getItem('access-sandbox-x');
    expect(item.item.error?.error_code).toBe('ITEM_LOGIN_REQUIRED');
    expect(item.status?.last_webhook?.code_sent).toBe('ERROR');
  });
});
