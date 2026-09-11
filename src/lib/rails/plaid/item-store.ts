/**
 * Where a Plaid Item's state lives, and how it gets there.
 *
 * ===========================================================================
 * THE GAP THIS CLOSES, IN THE WORDS OF THE FILES THAT NAMED IT
 * ===========================================================================
 *
 * `adapter.ts`, header:
 *     "There is nowhere to persist a Plaid `access_token` in this schema — no
 *      `plaid_item` table … so an Item cannot be re-read on a later request and
 *      `/funding` links a new one each time."
 *
 * `webhooks/consumers/plaid-item.ts`, header:
 *     "There is no row to mark unhealthy, no customer to route a 'reconnect
 *      your bank' prompt to, and nothing a reconciliation would notice."
 *
 * Migration 0056 built the tables. This module is the only code that writes
 * them, and it exists so that the answer to "is this funding source usable"
 * comes from WHAT PLAID ACTUALLY TOLD US rather than from a probe standing in
 * for it.
 *
 * ===========================================================================
 * THE DISTINCTION THIS MODULE IS FOR
 * ===========================================================================
 *
 * Before 0056, `/api/health` reported the `open_banking` slot `live` on the
 * evidence `POST /institutions/get -> 200`. That call is a CATALOGUE lookup.
 * It is answerable with no Item in existence, so it is true of an account that
 * has never linked a bank and true of one whose every Item is broken. Measured
 * on 2026-09-11, this deployment was in the second state and read as the first.
 *
 * Four states were indistinguishable and are now four different words:
 *
 *   healthy       Plaid's own last word on this Item was "no error".
 *   needs_reauth  Plaid says a HUMAN must re-authenticate (Link update mode).
 *                 Reported, never alarmed on: its exit condition is a person.
 *   revoked       Consent withdrawn. Terminal — re-linking is a new Item.
 *   orphaned      Plaid named an Item we hold no live credential for. We
 *                 cannot read it, repair it or remove it.
 *
 * and the fifth is the absence of rows, which the health surface calls
 * `absent` and which means SILENCE FROM PLAID IS CORRECT.
 *
 * ===========================================================================
 * WRITES ARE APPENDS. ALL OF THEM.
 * ===========================================================================
 *
 * `plaid_item_event` has no UPDATE grant and a trigger that refuses one, so
 * every function below that records a state INSERTs. The sequence
 *
 *     link(healthy) -> webhook(ITEM_LOGIN_REQUIRED) -> item_get(repaired)
 *
 * is the evidence for "how long was this funding source broken", and an UPDATE
 * would destroy it. `v_plaid_item_state` folds the log; nothing stores a
 * current state that could drift from its own history.
 */

import 'server-only';

import { sql, type Sql } from '@/lib/ledger/db';

import type { PlaidClient } from './client';
import {
  looksLikePlaidAccessToken,
  revealAccessToken,
  wrapAccessToken,
  type PlaidAccessToken,
} from './secret';
import {
  isFundable,
  plaidErrorBody,
  type PlaidAccount,
  type PlaidAchNumbers,
  type PlaidEnvironment,
  type PlaidItem,
} from './types';

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What we can say about one Item, drawn from a vocabulary that shares no word
 * with the three `/api/health` already publishes — `live`/`simulated`/…
 * (liveness), `fresh`/`stale`/`quiet`/`never` (delivery) and
 * `consuming`/`dropping`/`refused`/… (processing). A reader who sees one of
 * these knows without checking which question it answers.
 */
export type PlaidItemState = 'healthy' | 'needs_reauth' | 'revoked' | 'orphaned';

/** Exported so a test can prove the four vocabularies stay disjoint. */
export const PLAID_ITEM_STATES: readonly PlaidItemState[] = [
  'healthy',
  'needs_reauth',
  'revoked',
  'orphaned',
];

/** How we came to know something about an Item. */
export type PlaidObservationSource = 'link' | 'webhook' | 'item_get';

/**
 * Plaid error codes that mean the customer withdrew consent, rather than that
 * the login merely needs refreshing. Terminal: there is no update-mode repair
 * for these, only a new Item.
 */
const REVOKED_CODES: ReadonlySet<string> = new Set([
  'USER_PERMISSION_REVOKED',
  'USER_ACCOUNT_REVOKED',
]);

/** Kept in step with 0056 §11's CASE. A test asserts the two agree. */
export function foldItemState(args: {
  readonly hasLiveToken: boolean;
  readonly lastErrorCode: string | null;
  readonly lastWebhookCode: string | null;
}): PlaidItemState {
  if (!args.hasLiveToken) return 'orphaned';
  if (
    (args.lastErrorCode !== null && REVOKED_CODES.has(args.lastErrorCode)) ||
    (args.lastWebhookCode !== null && REVOKED_CODES.has(args.lastWebhookCode))
  ) {
    return 'revoked';
  }
  return args.lastErrorCode === null ? 'healthy' : 'needs_reauth';
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export interface PlaidItemStateRow {
  readonly itemId: string;
  readonly institutionId: string | null;
  readonly institutionName: string | null;
  readonly environment: PlaidEnvironment | null;
  readonly businessId: string | null;
  readonly purpose: string | null;
  readonly linkedAt: string | null;
  readonly lastObservedAt: string;
  readonly lastSource: PlaidObservationSource;
  readonly lastWebhookCode: string | null;
  readonly lastErrorCode: string | null;
  readonly lastErrorMessage: string | null;
  readonly observations: number;
  readonly errorObservations: number;
  readonly firstObservedAt: string | null;
  readonly hasLiveToken: boolean;
  readonly accountCount: number;
  readonly state: PlaidItemState;
}

/**
 * Every Item this deployment has ever been told about, with its current state.
 *
 * Reads `v_plaid_item_state` rather than re-deriving the fold in TypeScript.
 * Two derivations of one answer is the bug DECISIONS 021 records; the view is
 * the definition and `foldItemState()` above exists only so a unit test can
 * hold the two to each other without a database.
 */
export async function readItemStates(conn: Sql = sql): Promise<readonly PlaidItemStateRow[]> {
  const rows = await conn<
    {
      item_id: string;
      institution_id: string | null;
      institution_name: string | null;
      environment: string | null;
      business_id: string | null;
      purpose: string | null;
      linked_at: Date | null;
      last_observed_at: Date;
      last_source: string;
      last_webhook_code: string | null;
      last_error_code: string | null;
      last_error_message: string | null;
      observations: string;
      error_observations: string;
      first_observed_at: Date | null;
      has_live_token: boolean;
      account_count: string;
      state: string;
    }[]
  >`
    SELECT item_id, institution_id, institution_name, environment, business_id,
           purpose, linked_at, last_observed_at, last_source, last_webhook_code,
           last_error_code, last_error_message, observations, error_observations,
           first_observed_at, has_live_token, account_count, state
      FROM v_plaid_item_state
     ORDER BY last_observed_at DESC`;

  return rows.map((row) => ({
    itemId: row.item_id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    environment:
      row.environment === 'sandbox' || row.environment === 'production'
        ? row.environment
        : null,
    businessId: row.business_id,
    purpose: row.purpose,
    linkedAt: row.linked_at === null ? null : row.linked_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
    lastSource: row.last_source as PlaidObservationSource,
    lastWebhookCode: row.last_webhook_code,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    observations: Number(row.observations),
    errorObservations: Number(row.error_observations),
    firstObservedAt: row.first_observed_at === null ? null : row.first_observed_at.toISOString(),
    hasLiveToken: row.has_live_token,
    accountCount: Number(row.account_count),
    state: row.state as PlaidItemState,
  }));
}

/**
 * The live access token for one Item, or null.
 *
 * THE ONE SELECT IN THIS CODEBASE THAT READS PLAID KEY MATERIAL. The value is
 * wrapped before it leaves this function, and `looksLikePlaidAccessToken`
 * rejects a mangled row HERE rather than letting it become an opaque
 * `INVALID_ACCESS_TOKEN` from Plaid three calls later.
 */
export async function liveAccessTokenFor(
  itemId: string,
  conn: Sql = sql,
): Promise<PlaidAccessToken | null> {
  const [row] = await conn<{ access_token: string; version: number }[]>`
    SELECT access_token, version
      FROM plaid_item_secret
     WHERE item_id = ${itemId} AND retired_at IS NULL
     ORDER BY version DESC
     LIMIT 1`;

  if (row === undefined) return null;
  if (!looksLikePlaidAccessToken(row.access_token)) {
    // Fail closed with a named code. A token that does not look like a token
    // is a corrupted row, and using it would produce a confusing 400 from
    // Plaid attributed to the wrong cause.
    throw new PlaidItemStoreError(
      'MALFORMED_ACCESS_TOKEN',
      `the stored access token for item ${itemId} (version ${row.version}) is not shaped like a Plaid access token. It is not being sent to Plaid. Re-link the Item; the stored value cannot be repaired in place because plaid_item_secret is immutable by design.`,
    );
  }
  return wrapAccessToken(row.access_token, row.version);
}

export class PlaidItemStoreError extends Error {
  override readonly name = 'PlaidItemStoreError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

export interface RecordObservationArgs {
  readonly itemId: string;
  readonly source: PlaidObservationSource;
  readonly webhookCode?: string | null | undefined;
  readonly errorCode?: string | null | undefined;
  readonly errorType?: string | null | undefined;
  readonly errorMessage?: string | null | undefined;
  /** The `webhook_inbox` row this was read out of. Provenance, and idempotency. */
  readonly inboxId?: string | null | undefined;
  readonly observedAt?: Date | undefined;
}

/**
 * Append one observation.
 *
 * IDEMPOTENT BY INDEX, NOT BY `if`. `plaid_item_event_one_per_delivery` is a
 * UNIQUE on `inbox_id`, so a redelivered webhook — which the dispatcher's
 * contract explicitly permits — writes nothing the second time and this
 * returns `false`. Postgres decides, not a SELECT-then-INSERT that two
 * concurrent drains would both pass.
 *
 * Observations we made ourselves carry a NULL `inbox_id`, and Postgres permits
 * many NULLs in a UNIQUE, so polling `/item/get` is never blocked by it.
 */
export async function recordItemObservation(
  args: RecordObservationArgs,
  conn: Sql = sql,
): Promise<boolean> {
  const observedAt = args.observedAt ?? new Date();
  const inserted = await conn<{ id: string }[]>`
    INSERT INTO plaid_item_event
      (item_id, source, webhook_code, error_code, error_type, error_message,
       inbox_id, observed_at)
    VALUES
      (${args.itemId}, ${args.source}, ${args.webhookCode ?? null},
       ${args.errorCode ?? null}, ${args.errorType ?? null},
       ${args.errorMessage ?? null}, ${args.inboxId ?? null}::uuid,
       ${observedAt.toISOString()}::timestamptz)
    ON CONFLICT (inbox_id) DO NOTHING
    RETURNING id`;

  return inserted.length > 0;
}

export interface RecordLinkedItemArgs {
  readonly item: PlaidItem;
  readonly accounts: readonly PlaidAccount[];
  readonly achNumbers: ReadonlyMap<string, PlaidAchNumbers>;
  readonly accessToken: PlaidAccessToken;
  readonly environment: PlaidEnvironment;
  readonly businessId?: string | null | undefined;
  readonly webhookUrl?: string | null | undefined;
  /** `diagnostic` Items are deliberately broken and must never be offered. */
  readonly purpose?: 'funding' | 'diagnostic' | undefined;
  readonly observedAt?: Date | undefined;
}

/**
 * Persist a freshly linked Item: identity, token, accounts, and the `link`
 * observation that says Plaid reported it healthy at this instant.
 *
 * ONE TRANSACTION. An Item row with no token is an Item we can never read
 * again — it would fold to `orphaned` and be indistinguishable from the three
 * genuinely abandoned ones — so the four writes commit together or not at all.
 *
 * RE-LINKING IS AN APPEND, NOT AN OVERWRITE. Plaid can hand back an Item id we
 * already hold (re-running Link against the same institution and credentials
 * does not always mint a new one). When that happens the identity row is left
 * exactly as it is, the previous token is RETIRED rather than edited — 0056's
 * trigger refuses an edit — and the new one is inserted at the next version.
 * The old token stays readable so that "which credential was live when this
 * deposit was booked" remains answerable.
 */
export async function recordLinkedItem(
  args: RecordLinkedItemArgs,
  conn: Sql = sql,
): Promise<{ readonly created: boolean; readonly tokenVersion: number }> {
  const observedAt = args.observedAt ?? new Date();
  const itemId = args.item.item_id;

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    const insertedItem = await tx<{ item_id: string }[]>`
      INSERT INTO plaid_item
        (item_id, institution_id, institution_name, environment, business_id,
         webhook_url, linked_at, purpose)
      VALUES
        (${itemId}, ${args.item.institution_id ?? 'unknown'},
         ${args.item.institution_name ?? null}, ${args.environment},
         ${args.businessId ?? null}::uuid, ${args.webhookUrl ?? args.item.webhook ?? null},
         ${observedAt.toISOString()}::timestamptz, ${args.purpose ?? 'funding'})
      ON CONFLICT (item_id) DO NOTHING
      RETURNING item_id`;

    const created = insertedItem.length > 0;

    // Retire any live token before inserting the new one, so the partial index
    // `WHERE retired_at IS NULL` continues to name exactly one row per Item.
    // `retired_at` is the only column `corgi_app` may UPDATE here.
    await tx`
      UPDATE plaid_item_secret
         SET retired_at = ${observedAt.toISOString()}::timestamptz
       WHERE item_id = ${itemId} AND retired_at IS NULL`;

    const [versionRow] = await tx<{ next: number }[]>`
      SELECT COALESCE(MAX(version), 0) + 1 AS next
        FROM plaid_item_secret
       WHERE item_id = ${itemId}`;
    const tokenVersion = versionRow?.next ?? 1;

    await tx`
      INSERT INTO plaid_item_secret (item_id, version, access_token)
      VALUES (${itemId}, ${tokenVersion}, ${revealAccessToken(args.accessToken)})`;

    for (const account of args.accounts) {
      const numbers = args.achNumbers.get(account.account_id);
      // `fundable` records BOTH facts: that Plaid returned the account, and
      // whether an ACH debit could actually be pulled from it. Filtering the
      // unfundable ones out here would make "we saw no fundable account" and
      // "we never looked" the same row, which is the shape of bug this whole
      // file exists to stop.
      const fundable = isFundable(account) && numbers !== undefined;
      await tx`
        INSERT INTO plaid_item_account
          (item_id, account_id, name, official_name, mask, subtype,
           routing_number, auth_method, fundable, observed_at)
        VALUES
          (${itemId}, ${account.account_id}, ${account.name},
           ${account.official_name ?? null}, ${account.mask ?? null},
           ${account.subtype ?? null}, ${numbers?.routing ?? null},
           ${args.item.auth_method ?? null}, ${fundable},
           ${observedAt.toISOString()}::timestamptz)
        ON CONFLICT (item_id, account_id) DO NOTHING`;
    }

    // Plaid's own word at the moment of linking. `item.error` is null on a
    // healthy Item — measured — so this mirrors it rather than inventing a
    // sentinel for "fine".
    const error = args.item.error;
    await recordItemObservation(
      {
        itemId,
        source: 'link',
        errorCode: error?.error_code ?? null,
        errorType: error?.error_type ?? null,
        errorMessage: error?.error_message ?? null,
        observedAt,
      },
      tx,
    );

    return { created, tokenVersion };
  });
}

/* -------------------------------------------------------------------------- */
/* Asking Plaid, rather than guessing                                         */
/* -------------------------------------------------------------------------- */

export interface RefreshResult {
  readonly itemId: string;
  readonly state: PlaidItemState;
  readonly errorCode: string | null;
  /** Plaid's `status.last_webhook`, when it answered with one. */
  readonly lastWebhook: { readonly code: string; readonly sentAt: string } | null;
  /** False when we hold no credential, so nothing was asked. */
  readonly asked: boolean;
}

/**
 * Re-read one Item from Plaid and append what it says.
 *
 * THIS IS THE CALL THE HEALTH SURFACE WAS MISSING. `/institutions/get` proves
 * a credential; `POST /item/get` proves a CAPABILITY, and it is the only Plaid
 * endpoint that answers 200 on a broken Item — measured:
 *
 *     /auth/get  on a reset Item -> 400 ITEM_LOGIN_REQUIRED
 *     /item/get  on the SAME Item -> 200, item.error.error_code =
 *                'ITEM_LOGIN_REQUIRED', plus status.last_webhook
 *
 * So the diagnosis is a SUCCESSFUL call. A funding screen that only ever calls
 * product endpoints can tell you that something failed; this tells you what
 * broke and when Plaid last said so.
 *
 * An Item we hold no live token for is NOT an error and is not retried: it is
 * `orphaned`, it is reported as such, and there is nothing to ask with. That
 * is the state the three 2026-09-10 deliveries left this deployment in.
 */
export async function refreshItemState(
  itemId: string,
  deps: { readonly client: PlaidClient; readonly conn?: Sql | undefined },
): Promise<RefreshResult> {
  const conn = deps.conn ?? sql;
  const token = await liveAccessTokenFor(itemId, conn);
  if (token === null) {
    return { itemId, state: 'orphaned', errorCode: null, lastWebhook: null, asked: false };
  }

  const observedAt = new Date();
  let errorCode: string | null = null;
  let errorType: string | null = null;
  let errorMessage: string | null = null;
  let lastWebhook: RefreshResult['lastWebhook'] = null;

  try {
    const response = await deps.client.getItem(revealAccessToken(token));
    const error = response.item.error;
    errorCode = error?.error_code ?? null;
    errorType = error?.error_type ?? null;
    errorMessage = error?.error_message ?? null;
    const seen = response.status?.last_webhook ?? null;
    lastWebhook =
      seen === null || seen === undefined
        ? null
        : { code: seen.code_sent, sentAt: seen.sent_at };
  } catch (thrown) {
    // `/item/get` answering 200 with an embedded error is the NORMAL broken
    // shape, so a THROW here is something else: a dead credential, a removed
    // Item, or Plaid being down. Record Plaid's own code rather than swallowing
    // it — an observation we could not make is not an observation that the
    // Item is fine.
    const body = plaidErrorBody(thrown);
    if (body === null) throw thrown;
    errorCode = body.error_code;
    errorType = body.error_type;
    errorMessage = body.error_message;
  }

  await recordItemObservation(
    { itemId, source: 'item_get', errorCode, errorType, errorMessage, observedAt },
    conn,
  );

  return {
    itemId,
    state: foldItemState({
      hasLiveToken: true,
      lastErrorCode: errorCode,
      lastWebhookCode: null,
    }),
    errorCode,
    lastWebhook,
    asked: true,
  };
}

/**
 * The fundable accounts on an Item, read back from storage.
 *
 * The point of the whole migration, in one function: BEFORE 0056 this could
 * not exist, because the Item did not survive the request that created it and
 * `/funding` had to link a fresh one on every run — which is why two funding
 * runs carried two different `item_id`s, two different external refs and two
 * different idempotency keys, and why `alreadyFundedReference()` had to be a
 * guard rather than a guarantee.
 */
export async function fundableAccountsFor(
  itemId: string,
  conn: Sql = sql,
): Promise<
  readonly {
    readonly accountId: string;
    readonly name: string;
    readonly mask: string | null;
    readonly subtype: string | null;
    readonly routingNumber: string | null;
    readonly authMethod: string | null;
  }[]
> {
  const rows = await conn<
    {
      account_id: string;
      name: string;
      mask: string | null;
      subtype: string | null;
      routing_number: string | null;
      auth_method: string | null;
    }[]
  >`
    SELECT account_id, name, mask, subtype, routing_number, auth_method
      FROM plaid_item_account
     WHERE item_id = ${itemId} AND fundable
     ORDER BY name`;

  return rows.map((row) => ({
    accountId: row.account_id,
    name: row.name,
    mask: row.mask,
    subtype: row.subtype,
    routingNumber: row.routing_number,
    authMethod: row.auth_method,
  }));
}
