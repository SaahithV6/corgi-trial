/**
 * Plaid wire shapes, and the one thing this package is not.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ PLAID IS NOT A `PaymentRail`, AND THIS FILE DELIBERATELY DOES NOT MAKE   │
 * │ IT ONE.                                                                  │
 * │                                                                          │
 * │ `../types.ts` says a rail is "push money out, pull money in, ask,        │
 * │ interpret a callback". Plaid does none of those. It cannot move a cent.  │
 * │ What it does is turn a person's bank login into (a) a durable handle on   │
 * │ an Item and (b) a routing number and an account number that some OTHER   │
 * │ rail can originate against. That is an ACCOUNT-VERIFICATION adapter, and │
 * │ bolting it onto `PaymentRail` would mean four methods that all throw     │
 * │ plus a `capabilities` block claiming `supportsCredit`, which is exactly  │
 * │ the "adapter rots back into a schema" failure the rail interface's       │
 * │ header warns about.                                                      │
 * │                                                                          │
 * │ So this package exports its own small surface, and reuses `RailError`,   │
 * │ `Money` and `Evidence` from `../types` because those are cross-cutting   │
 * │ vocabulary rather than rail methods.                                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IS PROVEN AND WHAT IS NOT. Every shape in this file was observed
 * against the real Plaid sandbox on 2026-09-10 with the credentials in
 * `PLAID_CLIENT_ID` / `PLAID_SECRET` and is marked [MEASURED]. Nothing here is
 * marked [DOCS]; anything the sandbox did not return was deleted rather than
 * guessed. `docs/FUNDING.md` carries the request ids and the raw responses.
 *
 * NO `verifyWebhook` HERE, DELIBERATELY, for the same reason `../types.ts`
 * gives: `src/lib/webhooks/route-handler.ts` already registers a Plaid
 * verifier (ES256 JWT, `Plaid-Verification`, per-`kid` key cache, 5-minute
 * freshness, constant-time body hash). A second copy is how the fifth provider
 * gets verified differently from the first four.
 */

import { RailError, type Evidence } from '../types';

/** The slug persisted wherever a Plaid fact reaches the ledger. */
export const PLAID_PROVIDER = 'plaid';

export const PLAID_SANDBOX_BASE_URL = 'https://sandbox.plaid.com';
export const PLAID_PRODUCTION_BASE_URL = 'https://production.plaid.com';

/**
 * Unconditionally `live`, and a `const` rather than a constructor argument for
 * the same reason the Increase adapter's is: the sandbox is Plaid's own system
 * answering our fetch, so a fact from it IS live evidence, and no configuration
 * mistake should be able to make something else claim to be this.
 *
 * `environment` is what separates sandbox from production money — and Plaid
 * moves no money at all, so on this adapter it separates a sandbox Item from a
 * real customer's bank login, which matters just as much.
 */
export const PLAID_EVIDENCE: Evidence = 'live';

export type PlaidEnvironment = 'sandbox' | 'production';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Plaid's error body. [MEASURED] — this is exactly what a 400 returns.
 *
 * `error_code` is the field to branch on: `ITEM_LOGIN_REQUIRED`,
 * `ITEM_LOCKED`, `INVALID_CREDENTIALS`. `error_type` is the coarse bucket.
 * `display_message` is the only field Plaid intends a human to read, and it is
 * null on plenty of real errors — including `ITEM_LOGIN_REQUIRED`, the single
 * most common one a funding screen has to render. A UI that shows
 * `display_message` and nothing else shows a blank box on the error that
 * matters most, so `PLAID_ITEM_ERROR_COPY` below exists.
 */
export interface PlaidErrorBody {
  readonly error_type: string;
  readonly error_code: string;
  readonly error_message: string;
  readonly display_message: string | null;
  readonly documentation_url?: string;
  readonly suggested_action?: string | null;
  readonly request_id?: string;
}

/**
 * The Plaid error carried by a `RailError`, or `null` when the failure was not
 * one Plaid described (a timeout, a socket reset, a non-JSON body).
 *
 * Callers branch like this and not on the message text:
 *
 *     const body = plaidErrorBody(caught);
 *     if (body?.error_code === 'ITEM_LOGIN_REQUIRED') { … }
 */
export function plaidErrorBody(thrown: unknown): PlaidErrorBody | null {
  if (!(thrown instanceof RailError)) return null;
  const raw = thrown.raw;
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Partial<PlaidErrorBody>;
  return typeof body.error_code === 'string' && typeof body.error_type === 'string'
    ? (body as PlaidErrorBody)
    : null;
}

/**
 * Error codes this package recognises well enough to say something useful
 * about. Anything else is still surfaced verbatim — an unrecognised code is
 * not an excuse to print "something went wrong".
 */
export const PLAID_ITEM_ERROR_COPY: Readonly<Record<string, string>> = {
  ITEM_LOGIN_REQUIRED:
    "The bank has invalidated this connection's credentials. Nothing is wrong with the account or with any money already booked against it — but no fresh routing or account number can be read until the customer re-authenticates through Link in update mode. Existing uncleared holds keep running on their own clock; they do not depend on the Item.",
  ITEM_LOCKED:
    'The bank has locked the account after too many failed logins. This fails at LINK time, so no Item exists and there is nothing to store. The customer has to unlock it on their bank\'s own site; retrying from here cannot help.',
  INVALID_CREDENTIALS:
    'The username or password was rejected by the bank. No Item was created.',
  ITEM_NOT_SUPPORTED: 'This institution does not support the products this Item was created for.',
  NO_ACCOUNTS: 'The login succeeded but the institution returned no accounts we can fund from.',
  PRODUCT_NOT_READY:
    "The Item is still being set up by Plaid. This is retryable and usually resolves within seconds.",
  RATE_LIMIT_EXCEEDED: 'Plaid is rate-limiting this client. Retryable after a short wait.',
};

/* -------------------------------------------------------------------------- */
/* Link                                                                       */
/* -------------------------------------------------------------------------- */

/** [MEASURED] `POST /link/token/create` -> 200. */
export interface PlaidLinkToken {
  readonly link_token: string;
  /** ISO 8601. Four hours out, and single-use for a completed Link session. */
  readonly expiration: string;
  readonly request_id: string;
}

/** [MEASURED] `POST /sandbox/public_token/create` -> 200. */
export interface PlaidSandboxPublicToken {
  readonly public_token: string;
  readonly request_id: string;
}

/** [MEASURED] `POST /item/public_token/exchange` -> 200. */
export interface PlaidExchangeResponse {
  /** LONG-LIVED CREDENTIAL. Never render it, never log it, never persist it in the journal. */
  readonly access_token: string;
  readonly item_id: string;
  readonly request_id: string;
}

/* -------------------------------------------------------------------------- */
/* Accounts, items, auth                                                      */
/* -------------------------------------------------------------------------- */

/**
 * [MEASURED] Balances as the sandbox returns them.
 *
 * NOTE THE TYPE: these are Plaid's DOLLARS as JSON numbers — `110`, `320.76`,
 * `23631.9805`. They are not cents and they are not exact. Nothing in this
 * codebase may turn one into `Money`: `23631.9805` is not a cent count and
 * multiplying it by 100 is the float bug the whole ledger is built to avoid.
 * They are carried through as strings for DISPLAY ONLY, by
 * `formatPlaidBalance`, and no arithmetic is ever done on them.
 */
export interface PlaidBalances {
  readonly available: number | null;
  readonly current: number | null;
  readonly limit: number | null;
  readonly iso_currency_code: string | null;
  readonly unofficial_currency_code: string | null;
}

export type PlaidAccountType = 'depository' | 'credit' | 'loan' | 'investment' | 'brokerage' | 'other';

/** [MEASURED] One entry of `accounts[]` from `/accounts/get` and `/auth/get`. */
export interface PlaidAccount {
  readonly account_id: string;
  readonly balances: PlaidBalances;
  readonly mask: string | null;
  readonly name: string;
  readonly official_name: string | null;
  readonly type: PlaidAccountType | string;
  readonly subtype: string | null;
  /** Present only while a micro-deposit flow is running. Absent on INSTANT_AUTH. */
  readonly verification_status?: string | null;
}

/** [MEASURED] One entry of `numbers.ach[]`. A FLAT array across all accounts. */
export interface PlaidAchNumbers {
  readonly account_id: string;
  /** The ACH routing number (ABA). Never `wire_routing` — see below. */
  readonly routing: string;
  /**
   * The Fedwire routing number. A DIFFERENT number at the same bank; the
   * sandbox returns `021000021` here against an ACH routing of `011401533`.
   * Substituting one for the other gets the entry returned R13, so the two are
   * separate fields all the way to the originator and are never coalesced.
   */
  readonly wire_routing: string | null;
  readonly account: string;
  readonly is_tokenized_account_number: boolean;
}

/** [MEASURED] The `item` object, from `/item/get`, `/accounts/get` and `/auth/get`. */
export interface PlaidItem {
  readonly item_id: string;
  readonly institution_id: string | null;
  readonly institution_name?: string | null;
  readonly webhook: string | null;
  readonly available_products: readonly string[];
  readonly billed_products: readonly string[];
  readonly products?: readonly string[];
  readonly consent_expiration_time: string | null;
  readonly update_type: string;
  /** How Auth got the numbers. `INSTANT_AUTH` is the strongest signal. */
  readonly auth_method?: string | null;
  /** Non-null when the Item is broken. This is where `ITEM_LOGIN_REQUIRED` lives. */
  readonly error: PlaidErrorBody | null;
}

/** [MEASURED] `POST /accounts/get` -> 200. */
export interface PlaidAccountsResponse {
  readonly accounts: readonly PlaidAccount[];
  readonly item: PlaidItem;
  readonly request_id: string;
}

/** [MEASURED] `POST /auth/get` -> 200. */
export interface PlaidAuthResponse {
  readonly accounts: readonly PlaidAccount[];
  readonly numbers: {
    readonly ach: readonly PlaidAchNumbers[];
    readonly eft?: readonly unknown[];
    readonly international?: readonly unknown[];
    readonly bacs?: readonly unknown[];
  };
  readonly item: PlaidItem;
  readonly request_id: string;
}

/** [MEASURED] `POST /item/get` -> 200, including on a BROKEN item. */
export interface PlaidItemResponse {
  readonly item: PlaidItem;
  readonly status?: {
    readonly last_webhook?: { readonly code_sent: string; readonly sent_at: string } | null;
  } | null;
  readonly request_id: string;
}

/** [MEASURED] `POST /sandbox/item/reset_login` -> 200. */
export interface PlaidResetLoginResponse {
  readonly reset_login: boolean;
  readonly request_id: string;
}

/* -------------------------------------------------------------------------- */
/* The normalised shape the rest of the app sees                              */
/* -------------------------------------------------------------------------- */

/**
 * One external bank account, verified by Plaid, ready to be handed to an ACH
 * originator.
 *
 * THE ACCOUNT NUMBER IS NOT ON THIS TYPE. `accountMask` is the last four and
 * that is all any screen, log line or ledger row in this codebase ever sees.
 * The full number exists for exactly as long as it takes to register the
 * account with the ACH originator, inside one server action, and is never
 * returned to a caller that did not ask for it explicitly — see
 * `LinkedExternalAccount.achNumbers`, which is separated for that reason.
 */
export interface PlaidLinkedAccount {
  readonly itemId: string;
  readonly accountId: string;
  readonly institutionId: string | null;
  readonly institutionName: string | null;
  readonly accountName: string;
  readonly officialName: string | null;
  /** Last four, or `null` when the institution does not publish one. */
  readonly accountMask: string | null;
  readonly subtype: string | null;
  /** The ACH routing number. Safe to display — it is public bank routing data. */
  readonly routingNumber: string;
  /** `INSTANT_AUTH`, `AUTOMATED_MICRODEPOSITS`, … Persisted for risk scoring. */
  readonly authMethod: string | null;
  /** Plaid's own balance strings, for display only. Never money. */
  readonly balanceDisplay: string | null;
  readonly evidence: Evidence;
  readonly environment: PlaidEnvironment;
}

/**
 * A stable, parseable identity for a linked account, used as the `external_ref`
 * on every ledger row and hold that this account funds.
 *
 * THIS IS THE ONLY PLACE THE LINKAGE IS PERSISTED, and that is a limitation
 * rather than a design: there is no `plaid_item` table in this schema and
 * creating one needs a migration. So the item and the account survive on the
 * money rows they produced — which is genuinely durable and genuinely
 * immutable, but means an Item that has never funded anything is not stored at
 * all, and the long-lived `access_token` has nowhere to live. See
 * `docs/FUNDING.md`, "What is not here".
 */
export function plaidExternalRef(
  itemId: string,
  accountId: string,
  reference: string,
): string {
  for (const [name, part] of [
    ['itemId', itemId],
    ['accountId', accountId],
    ['reference', reference],
  ] as const) {
    // A colon in any component would make the ref ambiguous to parse, and the
    // ref is what joins a hold to the entries that opened and released it.
    // Refusing here is cheaper than a hold nobody can attribute.
    if (part === '' || part.includes(':')) {
      throw new TypeError(`plaid external ref ${name} must be non-empty and contain no ':'`);
    }
  }
  return `${PLAID_PROVIDER}:${itemId}:${accountId}:${reference}`;
}

/** The exact inverse. `null` for anything that is not one of ours. */
export function parsePlaidExternalRef(ref: string): {
  readonly itemId: string;
  readonly accountId: string;
  readonly reference: string;
} | null {
  const parts = ref.split(':');
  if (parts.length !== 4) return null;
  const [prefix, itemId, accountId, reference] = parts;
  if (prefix !== PLAID_PROVIDER) return null;
  if (
    itemId === undefined ||
    itemId === '' ||
    accountId === undefined ||
    accountId === '' ||
    reference === undefined ||
    reference === ''
  ) {
    return null;
  }
  return { itemId, accountId, reference };
}

/**
 * Plaid's balance number, rendered for a human, with no arithmetic performed.
 *
 * `String(n)` and nothing else. The temptation is to tidy `23631.9805` into
 * `$23,631.98`, and doing so would require rounding a float that this codebase
 * has no business rounding. It is shown as Plaid sent it, labelled as Plaid's
 * figure, and never mistaken for a balance on our book.
 */
export function formatPlaidBalance(balances: PlaidBalances): string | null {
  const value = balances.current ?? balances.available;
  if (value === null) return null;
  const code = balances.iso_currency_code ?? balances.unofficial_currency_code ?? '';
  return code === '' ? String(value) : `${String(value)} ${code}`;
}

/**
 * Depository accounts an ACH debit can legitimately be pulled from.
 *
 * A credit card, a mortgage and a 401k are all in the sandbox Item's
 * `accounts[]` and none of them can fund a business current account. Filtering
 * on `type === 'depository'` alone still admits a CD, which cannot be debited
 * on demand either, so the subtype list is explicit.
 */
export const FUNDABLE_SUBTYPES: ReadonlySet<string> = new Set([
  'checking',
  'savings',
  'money market',
  'cash management',
]);

export function isFundable(account: PlaidAccount): boolean {
  return (
    account.type === 'depository' &&
    account.subtype !== null &&
    FUNDABLE_SUBTYPES.has(account.subtype)
  );
}
