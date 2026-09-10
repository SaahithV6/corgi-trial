/**
 * Plaid — the LIVE client.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HONESTY NOTE, and it is the opposite of the one on `../increase/`.       │
 * │ EVERY method below has been executed against the real Plaid sandbox with │
 * │ the credentials in `PLAID_CLIENT_ID` / `PLAID_SECRET`. The request ids,  │
 * │ the status codes and the ids that came back are in `docs/FUNDING.md`.    │
 * │ Nothing in this file is [DOCS]-only. Where the sandbox refused to do     │
 * │ something, the method is absent rather than present-and-untested.        │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * SERVER ONLY. Credentials are read at CALL time, never at import time, so a
 * rotated secret is picked up without a restart and the value is never captured
 * in module scope where a heap dump could find it. (`server-only` is
 * deliberately not imported so the module stays testable under vitest's node
 * environment; the modules that consume it carry that import.)
 *
 * No SDK. `fetch` and nothing else.
 *
 * Auth:        `PLAID-CLIENT-ID` / `PLAID-SECRET` headers, not body fields.
 *              Plaid accepts either. Headers are used so a payload dump — a
 *              log line, an error `raw`, a bug report — cannot contain the
 *              secret, which a body-style request makes almost inevitable.
 * Everything:  POST. There is not a single GET in the Plaid API.
 * Idempotency: THERE IS NONE. See `ONE ENDPOINT HAS NO IDEMPOTENCY KEY` below.
 * Errors:      `{error_type, error_code, error_message, display_message, …}`
 *              with a 4xx status. Mapped to `RailError` with `code` set to
 *              Plaid's `error_code` so callers branch on the code, not a string.
 *
 * Three things worth reading before touching this file:
 *
 *   1. THE LINK UI CANNOT BE SCRIPTED, AND THE SANDBOX ENDPOINT IS NOT A FAKE.
 *      See `createSandboxPublicToken`.
 *   2. THERE IS NO IDEMPOTENCY KEY, so `exchangePublicToken` is not safely
 *      retryable. See its note.
 *   3. `/auth/get` FAILS ON A BROKEN ITEM AND `/item/get` DOES NOT. That
 *      asymmetry is the whole of the error-state design. See `getItem`.
 */

import { RailError } from '../types';
import { RateLimiter } from '../lithic/ratelimit';
import {
  PLAID_EVIDENCE,
  PLAID_PRODUCTION_BASE_URL,
  PLAID_PROVIDER,
  PLAID_SANDBOX_BASE_URL,
  type PlaidAccountsResponse,
  type PlaidAuthResponse,
  type PlaidEnvironment,
  type PlaidErrorBody,
  type PlaidExchangeResponse,
  type PlaidItemResponse,
  type PlaidLinkToken,
  type PlaidResetLoginResponse,
  type PlaidSandboxPublicToken,
} from './types';

/**
 * Plaid's sandbox rate limits are generous and undocumented per-endpoint, so
 * this is headroom rather than a measured ceiling: it exists so a demo that
 * clicks the same button five times does not collect a `RATE_LIMIT_EXCEEDED`
 * in front of an audience.
 *
 * `RateLimiter` is imported from `../lithic/ratelimit` rather than copied. The
 * class holds nothing Lithic-specific — it is a FIFO token window with an
 * injectable clock — and the alternative is a fourth copy of the same
 * critical section, which is how one of them ends up with the concurrency bug
 * the others were fixed for.
 */
export const plaidLimiter = new RateLimiter({ limit: 8, windowMs: 1_000 });

export interface PlaidClientConfig {
  /** Defaults to `process.env.PLAID_CLIENT_ID`, read at call time. */
  readonly clientId?: string | undefined;
  /** Defaults to `process.env.PLAID_SECRET`, read at call time. */
  readonly secret?: string | undefined;
  /** Defaults to `PLAID_ENV`; anything but `production` is the sandbox. */
  readonly environment?: PlaidEnvironment | undefined;
  /** Per-attempt timeout in ms. Defaults to 15s. */
  readonly timeoutMs?: number | undefined;
  /** Injected in tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Injected in tests so the suite does not sleep. Defaults to `plaidLimiter`. */
  readonly limiter?: Pick<RateLimiter, 'run'> | undefined;
}

/** What `/link/token/create` needs. `clientUserId` must not be PII. */
export interface CreateLinkTokenRequest {
  /** OUR stable id for the user. A uuid, never an email — Plaid is explicit. */
  readonly clientUserId: string;
  /** Shown in the Link UI. Plaid truncates past 30 characters. */
  readonly clientName: string;
  /** Where this Item's webhooks go. Absent means the Item gets none. */
  readonly webhook?: string | undefined;
  readonly products?: readonly string[] | undefined;
}

export interface CreateSandboxPublicTokenRequest {
  readonly institutionId: string;
  readonly initialProducts?: readonly string[] | undefined;
  readonly webhook?: string | undefined;
  /** `user_good` unless you are forcing an outcome. */
  readonly overrideUsername?: string | undefined;
  /** `pass_good`, or `error_<CODE>` to force a link-time failure. */
  readonly overridePassword?: string | undefined;
}

export class PlaidClient {
  private readonly cfg: PlaidClientConfig;

  constructor(cfg: PlaidClientConfig = {}) {
    this.cfg = cfg;
  }

  /** `sandbox` unless `PLAID_ENV=production`. Never inferred from anything else. */
  get environment(): PlaidEnvironment {
    return (
      this.cfg.environment ??
      (readEnv('PLAID_ENV') === 'production' ? 'production' : 'sandbox')
    );
  }

  get baseUrl(): string {
    return this.environment === 'production'
      ? PLAID_PRODUCTION_BASE_URL
      : PLAID_SANDBOX_BASE_URL;
  }

  /** True when both credentials are present. The screen asks before it offers a button. */
  get configured(): boolean {
    return (
      (this.cfg.clientId ?? readEnv('PLAID_CLIENT_ID')) !== undefined &&
      (this.cfg.secret ?? readEnv('PLAID_SECRET')) !== undefined
    );
  }

  // -- the real Link flow ---------------------------------------------------

  /**
   * `POST /link/token/create`.
   *
   * This is the FIRST call of the real, production, browser-driven flow, and it
   * is a real call here: the token that comes back is the one you would hand to
   * `react-plaid-link`. What this codebase cannot do from a server action is
   * step two — Link is an iframe a person clicks through, and there is no
   * server-side way to complete it.
   *
   * So the token is created, shown, and its four-hour expiry is printed, and
   * the flow then continues through `createSandboxPublicToken` instead. Saying
   * that out loud is the point: the screen shows a real `link-sandbox-…` token
   * next to the sentence explaining why the demo does not open it.
   */
  createLinkToken(req: CreateLinkTokenRequest): Promise<PlaidLinkToken> {
    return this.post<PlaidLinkToken>('/link/token/create', {
      client_name: req.clientName.slice(0, 30),
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: req.clientUserId },
      products: req.products ?? ['auth'],
      // Depository only. Without this a customer can pick a credit card as a
      // funding source, and an ACH debit against a credit card line is an
      // entry that will be returned.
      account_filters: {
        depository: { account_subtypes: ['checking', 'savings'] },
      },
      ...(req.webhook === undefined ? {} : { webhook: req.webhook }),
    });
  }

  /**
   * `POST /sandbox/public_token/create` — Link, without the browser.
   *
   * THIS IS NOT A MOCK AND IT IS NOT OUR SIMULATOR. It is Plaid's own endpoint,
   * on Plaid's own servers, and the Item it creates is indistinguishable from
   * one a person made by clicking through Link: the same `item_id` space, the
   * same access token, the same webhooks, the same `/auth/get` numbers, the
   * same `ITEM_LOGIN_REQUIRED` failure modes. Everything it returns is
   * therefore `evidence: 'live'`, exactly as `../increase/client.ts`'s
   * `simulate*` methods are, and for the identical reason: it drives the REAL
   * provider's state machine.
   *
   * What it cannot do is prove that our Link UI works, because it does not open
   * one. That is the honest limit and `docs/FUNDING.md` states it.
   *
   * `overridePassword: 'error_ITEM_LOCKED'` makes this call itself return a
   * 400 — the failure happens at link time and no Item is created, which is a
   * genuinely different shape from an Item that breaks later, and both are
   * rendered separately on `/funding`.
   */
  createSandboxPublicToken(
    req: CreateSandboxPublicTokenRequest,
  ): Promise<PlaidSandboxPublicToken> {
    return this.post<PlaidSandboxPublicToken>('/sandbox/public_token/create', {
      institution_id: req.institutionId,
      initial_products: req.initialProducts ?? ['auth'],
      options: {
        ...(req.webhook === undefined ? {} : { webhook: req.webhook }),
        override_username: req.overrideUsername ?? 'user_good',
        override_password: req.overridePassword ?? 'pass_good',
      },
    });
  }

  /**
   * `POST /item/public_token/exchange`.
   *
   * ONE ENDPOINT HAS NO IDEMPOTENCY KEY — and it is this one, and Plaid has no
   * idempotency mechanism anywhere in the API. `../increase/client.ts` sends
   * `Idempotency-Key: <clientReferenceId>` on every write and gets the original
   * object back on a replay; there is no equivalent here.
   *
   * The consequence, stated so nobody has to discover it: a `public_token` is
   * SINGLE USE. A retry after a successful exchange whose response was lost
   * fails with `INVALID_PUBLIC_TOKEN` and the access token is gone. The caller
   * must therefore treat exchange as non-retryable — `funding/actions.ts` mints
   * a fresh public token instead of retrying an exchange, which costs one extra
   * sandbox call and cannot strand an Item.
   *
   * The `access_token` in the response is a long-lived credential. It is
   * returned to the caller and immediately used; it is never logged, never
   * rendered, and never written to the journal.
   */
  exchangePublicToken(publicToken: string): Promise<PlaidExchangeResponse> {
    return this.post<PlaidExchangeResponse>('/item/public_token/exchange', {
      public_token: publicToken,
    });
  }

  // -- reads ----------------------------------------------------------------

  /** `POST /accounts/get`. Every account on the Item, with Plaid's own balances. */
  getAccounts(accessToken: string): Promise<PlaidAccountsResponse> {
    return this.post<PlaidAccountsResponse>('/accounts/get', { access_token: accessToken });
  }

  /**
   * `POST /auth/get`. The routing and account numbers.
   *
   * `numbers.ach` is a FLAT ARRAY ACROSS ALL ACCOUNTS, not one entry per
   * account and not nested under each account. The sandbox Item used here has
   * fourteen accounts and three ACH entries. Always index by `account_id`;
   * `numbers.ach[0]` is a bug that happens to work.
   *
   * THIS IS THE CALL THAT FAILS ON A BROKEN ITEM. See `getItem`.
   */
  getAuth(accessToken: string): Promise<PlaidAuthResponse> {
    return this.post<PlaidAuthResponse>('/auth/get', { access_token: accessToken });
  }

  /**
   * `POST /item/get`.
   *
   * THE ASYMMETRY THIS WHOLE ERROR DESIGN HANGS ON, and it is measured:
   *
   *   /auth/get  on a reset Item -> HTTP 400, ITEM_LOGIN_REQUIRED
   *   /item/get  on the SAME Item -> HTTP 200, item.error.error_code =
   *              'ITEM_LOGIN_REQUIRED', plus status.last_webhook
   *
   * So the diagnosis of a broken Item is a SUCCESSFUL call, not a failed one.
   * A funding screen that only ever calls product endpoints can tell you that
   * something failed; only this one can tell you what, when Plaid last told us,
   * and whether the Item is broken or merely unreachable. `/funding` renders
   * the error state out of this response and not out of a caught exception.
   */
  getItem(accessToken: string): Promise<PlaidItemResponse> {
    return this.post<PlaidItemResponse>('/item/get', { access_token: accessToken });
  }

  // -- sandbox-only affordances --------------------------------------------
  //
  // Not on any shared interface, on purpose: test affordances do not belong in
  // a production surface. These exist only in Plaid's sandbox and 404 (or
  // refuse) in production. They drive the REAL provider's state machine, so
  // what comes back is live evidence — an Item really is in
  // ITEM_LOGIN_REQUIRED afterwards, and Plaid really does fire the webhook.

  /**
   * `POST /sandbox/item/reset_login` — force `ITEM_LOGIN_REQUIRED`.
   *
   * Two effects, both real and both observed: every subsequent product call on
   * the Item fails with `ITEM_LOGIN_REQUIRED`, and Plaid fires an `ITEM`/`ERROR`
   * webhook at the Item's configured URL. That webhook arrived at this
   * deployment's `/api/webhooks/plaid`, passed ES256 verification, and is in
   * `webhook_inbox` — see `docs/FUNDING.md`.
   *
   * There is no un-reset. Recovery is Link in update mode, which needs a
   * browser, so an Item reset here stays broken. Always call it on a
   * throwaway Item.
   */
  sandboxResetLogin(accessToken: string): Promise<PlaidResetLoginResponse> {
    return this.post<PlaidResetLoginResponse>('/sandbox/item/reset_login', {
      access_token: accessToken,
    });
  }

  // -- plumbing -------------------------------------------------------------

  private credentials(): { clientId: string; secret: string } {
    const clientId = this.cfg.clientId ?? readEnv('PLAID_CLIENT_ID');
    const secret = this.cfg.secret ?? readEnv('PLAID_SECRET');
    if (clientId === undefined || secret === undefined) {
      throw this.error(
        'PLAID_CLIENT_ID and PLAID_SECRET are not both set, so no Plaid call can be made. There is no simulator behind this slot: an unconfigured Plaid is an absent capability, and the funding screen says so rather than inventing a linked bank.',
        { code: 'not_configured', retryable: false },
      );
    }
    return { clientId, secret };
  }

  private error(
    message: string,
    opts: { code: string; retryable: boolean; httpStatus?: number; raw?: unknown },
  ): RailError {
    return new RailError(message, {
      provider: PLAID_PROVIDER,
      evidence: PLAID_EVIDENCE,
      ...opts,
    });
  }

  /**
   * Every Plaid call, in one place.
   *
   * Rate-limited, timed out, and — the part that matters — mapped so that
   * `RailError.code` is Plaid's `error_code` verbatim. A caller writes
   * `err.code === 'ITEM_LOGIN_REQUIRED'`; nothing anywhere greps a message.
   */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const { clientId, secret } = this.credentials();
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    const limiter = this.cfg.limiter ?? plaidLimiter;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.cfg.timeoutMs ?? 15_000);

    let res: Response;
    try {
      res = await limiter.run(() =>
        fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'PLAID-CLIENT-ID': clientId,
            'PLAID-SECRET': secret,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          signal: controller.signal,
          body: JSON.stringify(body),
        }),
      );
    } catch (cause) {
      // Retryable — but NOT safely so for `/item/public_token/exchange`, which
      // has no idempotency key. See the note on that method.
      throw this.error(`network error calling POST ${path}`, {
        code: 'network_error',
        retryable: true,
        raw: cause,
      });
    } finally {
      clearTimeout(timeout);
    }

    const text = await res.text();

    if (!res.ok) {
      let parsed: Partial<PlaidErrorBody> = {};
      try {
        parsed = JSON.parse(text) as Partial<PlaidErrorBody>;
      } catch {
        /* keep the raw text below */
      }
      const code = parsed.error_code ?? `http_${res.status}`;
      throw this.error(parsed.error_message ?? `Plaid ${res.status} on ${path}`, {
        code,
        httpStatus: res.status,
        // 429 and 5xx are transport-shaped. `RATE_LIMIT_EXCEEDED` and
        // `PRODUCT_NOT_READY` are Plaid telling us to come back — everything
        // else (a locked account, a dead Item, a bad token) fails again
        // identically on a retry, more expensively.
        retryable:
          res.status === 429 ||
          res.status >= 500 ||
          code === 'RATE_LIMIT_EXCEEDED' ||
          code === 'PRODUCT_NOT_READY',
        raw: parsed.error_code === undefined ? text : parsed,
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw this.error(`Plaid returned a non-JSON body for POST ${path}`, {
        code: 'malformed_response',
        retryable: true,
        raw: cause,
      });
    }
  }
}

/** Trimmed, or undefined. An empty string is a missing value, not a value. */
function readEnv(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}
