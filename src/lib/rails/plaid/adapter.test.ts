/**
 * `linkExternalAccount` and the two error probes, against a fake Plaid.
 *
 * NO NETWORK AND NO DATABASE. The database handle is mocked at the module
 * boundary — `@/lib/ledger/db` parses `env` eagerly at import, and a unit test
 * of the LINK half has no business needing a connection string to run. The
 * FUNDING half of this adapter is not exercised here: it writes real money
 * through `postEntry()` and is proven by the live run recorded in
 * `docs/FUNDING.md`, not by a mock that would only ever agree with itself.
 *
 * Every response body below is verbatim from the real sandbox session in
 * `docs/FUNDING.md`, trimmed to the accounts that make a point.
 *
 * The assertion that matters most: `numbers.ach` is a FLAT ARRAY ACROSS ALL
 * ACCOUNTS. The sandbox Item has fourteen accounts and three ACH entries, and
 * `numbers.ach[0]` is a bug that happens to work on exactly the account a
 * developer tries first.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ledger/db', () => ({ sql: {} }));

import { linkExternalAccount, probeItemLoginRequired, probeLinkTimeFailure } from './adapter';
import { PlaidClient } from './client';

/* -------------------------------------------------------------------------- */
/* the real Item, trimmed                                                     */
/* -------------------------------------------------------------------------- */

const ITEM = {
  item_id: 'N5pKn4VqKMcgAJ9XNGGaUK4Kk77zL3UrVAJov',
  institution_id: 'ins_109508',
  institution_name: 'First Platypus Bank',
  webhook: 'https://corgi-trial-psi.vercel.app/api/webhooks/plaid',
  available_products: ['balance', 'identity'],
  billed_products: ['auth'],
  products: ['auth'],
  consent_expiration_time: null,
  update_type: 'background',
  auth_method: 'INSTANT_AUTH',
  error: null,
};

function balances(current: number) {
  return {
    available: current,
    current,
    limit: null,
    iso_currency_code: 'USD',
    unofficial_currency_code: null,
  };
}

const ACCOUNTS = [
  {
    account_id: 'Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6',
    balances: balances(110),
    mask: '0000',
    name: 'Plaid Checking',
    official_name: 'Plaid Gold Standard 0% Interest Checking',
    type: 'depository',
    subtype: 'checking',
  },
  {
    account_id: 'M5LqZa9lqRcjeXVqPddBf6aDPBpjZatG9mLbo',
    balances: balances(210),
    mask: '1111',
    name: 'Plaid Saving',
    official_name: 'Plaid Silver Standard 0.1% Interest Saving',
    type: 'depository',
    subtype: 'savings',
  },
  {
    // Depository, and NOT fundable: a CD cannot be debited on demand.
    account_id: '11vZworJZLuPbN5pB338HDr1bqWE7rtE5DpbJ',
    balances: balances(1000),
    mask: '2222',
    name: 'Plaid CD',
    official_name: 'Plaid Bronze Standard 0.2% Interest CD',
    type: 'depository',
    subtype: 'cd',
  },
  {
    account_id: 'L51lbdGMlQcRr6xlPaaqSDd9wVKRzdtdP3kgb',
    balances: balances(410),
    mask: '3333',
    name: 'Plaid Credit Card',
    official_name: 'Plaid Diamond 12.5% APR Interest Credit Card',
    type: 'credit',
    subtype: 'credit card',
  },
  {
    // Depository and fundable by subtype — but Plaid returns no ACH numbers
    // for it, so it must not be offered. See the test below.
    account_id: 'W5bN41wJNpcejmZRrnnEHp1Dx6Gea1cqlB6oV',
    balances: balances(6009),
    mask: '9001',
    name: 'Plaid HSA',
    official_name: null,
    type: 'depository',
    subtype: 'money market',
  },
  {
    account_id: 'ARdN9D51N4fgoMx6qvvnU1y4oqWdzyc31B9Rk',
    balances: balances(12060),
    mask: '9002',
    name: 'Plaid Cash Management',
    official_name: null,
    type: 'depository',
    subtype: 'cash management',
  },
];

/** Three entries for fourteen accounts, and NOT in the accounts' order. */
const ACH_NUMBERS = [
  {
    account: '1111222233339002',
    account_id: 'ARdN9D51N4fgoMx6qvvnU1y4oqWdzyc31B9Rk',
    is_tokenized_account_number: false,
    routing: '011401533',
    wire_routing: '021000021',
  },
  {
    account: '1111222233330000',
    account_id: 'Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6',
    is_tokenized_account_number: false,
    routing: '011401533',
    wire_routing: '021000021',
  },
  {
    account: '1111222233331111',
    account_id: 'M5LqZa9lqRcjeXVqPddBf6aDPBpjZatG9mLbo',
    is_tokenized_account_number: false,
    routing: '011401533',
    wire_routing: '021000021',
  },
];

const ITEM_LOGIN_REQUIRED = {
  display_message: null,
  documentation_url: 'https://plaid.com/docs/errors/item/#item_login_required',
  error_code: 'ITEM_LOGIN_REQUIRED',
  error_message: 'the login details of this item have changed',
  error_type: 'ITEM_ERROR',
  request_id: 'a1c6d80c3ce0a55',
};

const ITEM_LOCKED = {
  display_message: 'The given account has been locked by the financial institution.',
  documentation_url: 'https://plaid.com/docs/errors/item/#item_locked',
  error_code: 'ITEM_LOCKED',
  error_message: 'the account is locked',
  error_type: 'ITEM_ERROR',
  request_id: '7a4721edf8434c8',
};

/* -------------------------------------------------------------------------- */
/* harness — a Plaid that answers by path                                     */
/* -------------------------------------------------------------------------- */

type Route = { status?: number; body: unknown };

function fakePlaid(routes: Record<string, Route | Route[]>): {
  plaid: PlaidClient;
  paths: string[];
} {
  const paths: string[] = [];
  const cursors = new Map<string, number>();

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    const route = routes[path];
    if (route === undefined) throw new Error(`no fake route for ${path}`);
    let chosen: Route;
    if (Array.isArray(route)) {
      const index = cursors.get(path) ?? 0;
      cursors.set(path, index + 1);
      chosen = route[Math.min(index, route.length - 1)] as Route;
    } else {
      chosen = route;
    }
    return new Response(JSON.stringify(chosen.body), {
      status: chosen.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return {
    paths,
    plaid: new PlaidClient({
      clientId: 'id',
      secret: 'secret',
      environment: 'sandbox',
      fetchImpl,
      limiter: { run: <T>(fn: () => Promise<T>) => fn() },
    }),
  };
}

const HAPPY_ROUTES: Record<string, Route> = {
  '/link/token/create': {
    body: {
      link_token: 'link-sandbox-0000',
      expiration: '2026-09-11T02:15:00Z',
      request_id: 'link-req',
    },
  },
  '/sandbox/public_token/create': {
    body: { public_token: 'public-sandbox-0000', request_id: 'pub-req' },
  },
  '/item/public_token/exchange': {
    body: {
      access_token: 'access-sandbox-0000',
      item_id: ITEM.item_id,
      request_id: 'exch-req',
    },
  },
  '/accounts/get': { body: { accounts: ACCOUNTS, item: ITEM, request_id: 'acct-req' } },
  '/auth/get': {
    body: {
      accounts: ACCOUNTS,
      numbers: { ach: ACH_NUMBERS, eft: [], international: [], bacs: [] },
      item: ITEM,
      request_id: 'auth-req',
    },
  },
};

/* -------------------------------------------------------------------------- */
/* linking                                                                    */
/* -------------------------------------------------------------------------- */

describe('linkExternalAccount', () => {
  it('runs the five calls of the real flow, in order', async () => {
    const { plaid, paths } = fakePlaid(HAPPY_ROUTES);
    const result = await linkExternalAccount({ clientUserId: 'u-1', client: plaid });

    expect(paths).toEqual([
      '/link/token/create',
      '/sandbox/public_token/create',
      '/item/public_token/exchange',
      '/accounts/get',
      '/auth/get',
    ]);
    expect(result.calls.map((c) => c.endpoint)).toEqual([
      'POST /link/token/create',
      'POST /sandbox/public_token/create',
      'POST /item/public_token/exchange',
      'POST /accounts/get',
      'POST /auth/get',
    ]);
    expect(result.calls.every((c) => c.ok && c.status === 200)).toBe(true);
  });

  it('mints a REAL link token and reports its expiry, then does not use it', async () => {
    // The first step of the production, browser-driven flow is real. Step two
    // is an iframe a person clicks, which a server action cannot do — so the
    // token is shown and the flow continues through the sandbox endpoint. The
    // screen says exactly that; this test pins that the token is genuinely
    // fetched rather than skipped.
    const { plaid } = fakePlaid(HAPPY_ROUTES);
    const result = await linkExternalAccount({ clientUserId: 'u-1', client: plaid });
    expect(result.linkToken).toEqual({
      token: 'link-sandbox-0000',
      expiresAt: '2026-09-11T02:15:00Z',
    });
  });

  it('skips /link/token/create when asked, because on an error probe it teaches nothing', async () => {
    const { plaid, paths } = fakePlaid(HAPPY_ROUTES);
    const result = await linkExternalAccount({
      clientUserId: 'u-1',
      client: plaid,
      mintLinkToken: false,
    });
    expect(paths).not.toContain('/link/token/create');
    expect(result.linkToken).toBeNull();
  });

  it('indexes numbers.ach BY ACCOUNT ID, not by position', async () => {
    // The ACH array is ordered differently from the accounts array on purpose
    // in this fixture. `numbers.ach[0]` would attach the cash-management
    // account's number to the checking account — a funding entry against the
    // wrong account at the same bank, which settles and is only discovered by
    // the customer.
    const { plaid } = fakePlaid(HAPPY_ROUTES);
    const result = await linkExternalAccount({ clientUserId: 'u-1', client: plaid });

    expect(result.achNumbers.get('Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6')?.account).toBe(
      '1111222233330000',
    );
    expect(result.achNumbers.get('M5LqZa9lqRcjeXVqPddBf6aDPBpjZatG9mLbo')?.account).toBe(
      '1111222233331111',
    );
  });

  it('offers only depository accounts that Plaid produced ACH numbers for', async () => {
    const { plaid } = fakePlaid(HAPPY_ROUTES);
    const result = await linkExternalAccount({ clientUserId: 'u-1', client: plaid });

    expect(result.fundable.map((a) => a.accountId)).toEqual([
      'Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6', // checking
      'M5LqZa9lqRcjeXVqPddBf6aDPBpjZatG9mLbo', // savings
      'ARdN9D51N4fgoMx6qvvnU1y4oqWdzyc31B9Rk', // cash management
    ]);

    // The CD and the credit card are filtered by subtype. The HSA is a
    // `money market` subtype — fundable by the rule — and is dropped anyway
    // because `/auth/get` returned no numbers for it. Offering it would offer a
    // funding source whose first entry is guaranteed to be returned.
    const ids = result.fundable.map((a) => a.accountId);
    expect(ids).not.toContain('W5bN41wJNpcejmZRrnnEHp1Dx6Gea1cqlB6oV');
    expect(ids).not.toContain('L51lbdGMlQcRr6xlPaaqSDd9wVKRzdtdP3kgb');
  });

  it('carries the routing number and the mask, and NEVER the account number', async () => {
    const { plaid } = fakePlaid(HAPPY_ROUTES);
    const result = await linkExternalAccount({ clientUserId: 'u-1', client: plaid });
    const checking = result.fundable[0];

    expect(checking?.routingNumber).toBe('011401533');
    expect(checking?.accountMask).toBe('0000');
    expect(checking?.authMethod).toBe('INSTANT_AUTH');
    expect(checking?.institutionName).toBe('First Platypus Bank');
    expect(checking?.evidence).toBe('live');
    expect(checking?.environment).toBe('sandbox');

    // The full number exists only in `achNumbers`, which is deliberately a
    // separate map so that handing `fundable` to a React tree cannot leak it.
    expect(JSON.stringify(checking)).not.toContain('1111222233330000');
  });

  it('keeps the wire routing number separate from the ACH one', async () => {
    // Same bank, different numbers: 011401533 for ACH, 021000021 for Fedwire.
    // Substituting one for the other gets the entry returned R13.
    const { plaid } = fakePlaid(HAPPY_ROUTES);
    const result = await linkExternalAccount({ clientUserId: 'u-1', client: plaid });
    const numbers = result.achNumbers.get('Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6');
    expect(numbers?.routing).toBe('011401533');
    expect(numbers?.wire_routing).toBe('021000021');
    expect(result.fundable[0]?.routingNumber).toBe(numbers?.routing);
  });

  it('records the failed call before it rethrows, so the screen can show the attempt', async () => {
    const { plaid } = fakePlaid({
      ...HAPPY_ROUTES,
      '/auth/get': { status: 400, body: ITEM_LOGIN_REQUIRED },
    });

    await expect(
      linkExternalAccount({ clientUserId: 'u-1', client: plaid }),
    ).rejects.toMatchObject({ code: 'ITEM_LOGIN_REQUIRED' });
  });
});

/* -------------------------------------------------------------------------- */
/* the non-happy paths                                                        */
/* -------------------------------------------------------------------------- */

describe('probeLinkTimeFailure', () => {
  it('reports a failure that happened at LINK time, with no item to store', async () => {
    const { plaid, paths } = fakePlaid({
      '/sandbox/public_token/create': { status: 400, body: ITEM_LOCKED },
    });

    const probe = await probeLinkTimeFailure('ITEM_LOCKED', plaid);

    expect(probe.stage).toBe('link');
    expect(probe.itemId).toBeNull();
    expect(probe.errorCode).toBe('ITEM_LOCKED');
    expect(probe.errorType).toBe('ITEM_ERROR');
    expect(probe.displayMessage).toContain('locked by the financial institution');
    expect(probe.documentationUrl).toBe('https://plaid.com/docs/errors/item/#item_locked');
    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0]?.status).toBe(400);
    expect(probe.calls[0]?.errorCode).toBe('ITEM_LOCKED');
    // No exchange was attempted: there is no public token to exchange.
    expect(paths).toEqual(['/sandbox/public_token/create']);
  });

  it('refuses to invent a failure when Plaid accepts the override', async () => {
    // If the sandbox ever stops honouring `error_…`, this must surface as the
    // surprise it is rather than as a rendered error state nobody drove.
    const { plaid } = fakePlaid({
      '/sandbox/public_token/create': { body: { public_token: 'public-sandbox-0000' } },
    });
    await expect(probeLinkTimeFailure('ITEM_LOCKED', plaid)).rejects.toThrow(
      /expected Plaid to refuse/,
    );
  });
});

describe('probeItemLoginRequired', () => {
  it('breaks a throwaway Item and diagnoses it through the call that SUCCEEDS', async () => {
    const { plaid, paths } = fakePlaid({
      '/sandbox/public_token/create': {
        body: { public_token: 'public-sandbox-throwaway', request_id: 'pub' },
      },
      '/item/public_token/exchange': {
        body: {
          access_token: 'access-sandbox-throwaway',
          item_id: 'xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7',
          request_id: 'exch',
        },
      },
      '/sandbox/item/reset_login': { body: { reset_login: true, request_id: 'reset' } },
      '/auth/get': { status: 400, body: ITEM_LOGIN_REQUIRED },
      '/item/get': {
        body: {
          item: { ...ITEM, item_id: 'xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7', error: ITEM_LOGIN_REQUIRED },
          status: { last_webhook: { code_sent: 'ERROR', sent_at: '2026-09-10T22:15:13.382Z' } },
          request_id: 'item',
        },
      },
    });

    const probe = await probeItemLoginRequired({ client: plaid });

    expect(paths).toEqual([
      '/sandbox/public_token/create',
      '/item/public_token/exchange',
      '/sandbox/item/reset_login',
      '/auth/get',
      '/item/get',
    ]);
    expect(probe.stage).toBe('after_link');
    expect(probe.itemId).toBe('xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7');
    expect(probe.errorCode).toBe('ITEM_LOGIN_REQUIRED');
    // `display_message` is null on this error — the reason the package carries
    // its own copy for it.
    expect(probe.displayMessage).toBeNull();
    // The diagnosis is the 200, and it is the only thing that knows Plaid had
    // already told us, and when.
    expect(probe.lastWebhook).toEqual({ code: 'ERROR', sentAt: '2026-09-10T22:15:13.382Z' });

    // Both the failed product call and the successful diagnosis are on the
    // record, side by side.
    const authCall = probe.calls.find((c) => c.endpoint === 'POST /auth/get');
    const itemCall = probe.calls.find((c) => c.endpoint === 'POST /item/get');
    expect(authCall?.ok).toBe(false);
    expect(authCall?.status).toBe(400);
    expect(itemCall?.ok).toBe(true);
    expect(itemCall?.status).toBe(200);
  });

  it('refuses to render an error state Plaid does not agree with', async () => {
    const { plaid } = fakePlaid({
      '/sandbox/public_token/create': { body: { public_token: 'p' } },
      '/item/public_token/exchange': { body: { access_token: 'a', item_id: 'i' } },
      '/sandbox/item/reset_login': { body: { reset_login: true } },
      '/auth/get': { body: { accounts: [], numbers: { ach: [] }, item: ITEM } },
      '/item/get': { body: { item: { ...ITEM, error: null } } },
    });

    await expect(probeItemLoginRequired({ client: plaid })).rejects.toThrow(
      /reports no error/,
    );
  });
});
