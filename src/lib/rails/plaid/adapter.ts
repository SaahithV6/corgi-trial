import 'server-only';

/**
 * Link an external bank, fund the balance from it, and hold the money until the
 * return window says it is safe to spend.
 *
 * ===========================================================================
 * WHAT ACTUALLY HAPPENS, AND WHAT DOES NOT
 * ===========================================================================
 *
 * WHAT DOES:
 *   - Plaid really links a real Item at a real institution and really returns
 *     that account's ACH routing and account numbers. LIVE — every call in
 *     this file has been executed against the real sandbox and the request ids
 *     are in `docs/FUNDING.md`.
 *   - `postEntry()` really writes a balanced, double-entry, bigint-cents
 *     journal entry to the live Neon database, and a memo entry that withholds
 *     the same amount from available.
 *
 * WHAT DOES NOT:
 *   - **NO ACH ENTRY IS TRANSMITTED TO ANY NETWORK.** `POST /ach_transfers` is
 *     not called, from here or from anywhere on this path, and the ACH numbers
 *     Plaid returns are not registered with an originator either. The deposit
 *     is booked at ORIGINATION — the moment the pull is instructed — which is
 *     what account 1130 is for and is how a bank books a debit at file-cut,
 *     before the file goes out. The screen says so in those words, the entry's
 *     own description says so, and `docs/FUNDING.md` says so.
 *
 * That distinction is the whole reason 1110 is untouched here. 1130's charter
 * in `chart.ts` is "an inbound ACH credit we have been told about but whose
 * settlement has not yet funded the FBO account; cleared to 1110 on the
 * settlement date and reversed in full if the entry is returned". Debiting
 * 1110 would claim real dollars arrived at the sponsor bank. None did.
 *
 * ===========================================================================
 * THE TWO ENTRIES, AND WHY THE SECOND ONE IS THE POINT
 * ===========================================================================
 *
 * FINANCIAL BOOK — the ledger balance moves:
 *
 *     DEBIT   1130  ACH receivable — inbound in transit      + amount
 *     CREDIT  2100/<business>  the customer's money          − amount
 *
 * MEMO BOOK — available does NOT move:
 *
 *     CREDIT  9200/<business>  uncleared-credit holds        − amount
 *     DEBIT   9900  memo contra                              + amount
 *
 * `v_available_balance` is `ledger − active holds`, so the two entries
 * together mean the customer's ledger balance rises by the full amount and
 * their available balance does not move by a cent. That is not a limitation
 * being worked around; it is the correct answer for a credit that can still be
 * returned, and it is the reason `hold_kind` has an `uncleared_credit` member
 * and `funds_availability_policy` exists.
 *
 * ===========================================================================
 * IDEMPOTENCY, WITH NO `if` STATEMENT IN IT
 * ===========================================================================
 *
 * Three unique indexes decide, in this order:
 *
 *   hold_ref UNIQUE (kind, external_ref)   a second funding of the same
 *                                          reference reuses the same hold
 *   journal_entry.idempotency_key UNIQUE   the financial entry replays
 *   journal_entry.idempotency_key UNIQUE   the memo entry replays
 *
 * Every key is derived from the SOURCE FACT — the Plaid item id, the Plaid
 * account id and the caller's reference — never from a uuid generated on this
 * request. Submitting the same funding instruction twice books one deposit and
 * opens one hold, and Postgres decides that, not this file.
 *
 * ===========================================================================
 * AND THE LIMIT OF THAT, STATED RATHER THAN DISCOVERED
 * ===========================================================================
 *
 * THE ITEM ID IS PART OF THE KEY, AND THIS PATH LINKS A FRESH ITEM ON EVERY
 * RUN. There is nowhere to persist a Plaid `access_token` in this schema — no
 * `plaid_item` table, and adding one needs a migration this worker does not
 * own — so an Item cannot be re-read on a later request and `/funding` links a
 * new one each time. Two runs therefore carry two different `item_id`s, which
 * means two different external refs, which means two different idempotency
 * keys: the unique indexes above make a funding run replay-safe WITHIN one
 * linked Item, and they cannot see across two.
 *
 * That is a real hazard — it is the double-click that books twice — so it is
 * guarded rather than hoped about. `alreadyFundedReference()` below is a
 * SELECT the caller runs before linking, and the server action refuses
 * `ALREADY_FUNDED` when this business has already funded under this reference.
 * It is a GUARD AND NOT A GUARANTEE: two requests racing between the SELECT and
 * the INSERT both pass it. The guarantee is still the index, and the index's
 * reach is still one Item. Both facts are in `docs/FUNDING.md`.
 */

import { BANKING_TIME_ZONE } from '@/lib/format/datetime';
import { closeHold, ledgerPosterActorId, memoHoldBalance } from '@/lib/holds/store';
import { sql, type Sql } from '@/lib/ledger/db';
import { postEntry } from '@/lib/ledger/post';

import { PlaidClient, type CreateSandboxPublicTokenRequest } from './client';
import {
  scheduleAvailability,
  type AvailabilityPolicy,
  type AvailabilitySchedule,
  type ValueDate,
} from './availability';
import {
  formatPlaidBalance,
  isFundable,
  plaidErrorBody,
  plaidExternalRef,
  PLAID_EVIDENCE,
  PLAID_PROVIDER,
  type PlaidAchNumbers,
  type PlaidEnvironment,
  type PlaidItem,
  type PlaidLinkedAccount,
} from './types';

/* -------------------------------------------------------------------------- */
/* Chart of accounts                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The house accounts this path posts to. Codes, not ids: the id is per-entity
 * and is resolved from the chart at posting time, so a re-seed cannot leave a
 * stale uuid compiled into this module.
 */
export const INBOUND_IN_TRANSIT_CODE = '1130';
export const MEMO_CONTRA_CODE = '9900';
export const DEPOSIT_CODE = '2100';
export const UNCLEARED_HOLD_CODE = '9200';

/** The institution the sandbox links against. Non-OAuth, so no browser redirect. */
export const SANDBOX_INSTITUTION_ID = 'ins_109508';

/* -------------------------------------------------------------------------- */
/* Where this deployment's Item webhooks go                                   */
/* -------------------------------------------------------------------------- */

export const PLAID_WEBHOOK_PATH = '/api/webhooks/plaid';

/**
 * The production origin, as a last resort when nothing in the environment says
 * otherwise. Repeated from `integrations/probes/lithic-webhooks.ts` rather than
 * imported so this package depends on nothing outside itself and the ledger.
 */
export const DEFAULT_DEPLOYMENT_ORIGIN = 'https://corgi-trial-psi.vercel.app';

/**
 * The URL a Plaid Item is told to send its webhooks to.
 *
 * SAME ORDERING AS THE LITHIC PROBE, AND FOR THE SAME REASON:
 * `VERCEL_URL` is deliberately not consulted. On Vercel it holds the
 * deployment-specific host, and an Item registered against one is an Item whose
 * `ITEM`/`ERROR` webhook lands on a deployment that will be superseded within
 * the hour — so the delivery would be real and unfindable.
 * `VERCEL_PROJECT_PRODUCTION_URL` is the stable production host, which is the
 * one the ES256 verifier in `webhooks/route-handler.ts` is actually reachable
 * at, and it is the one an Item should carry.
 *
 * Returns `null` only when a caller passes an environment with an explicitly
 * empty override, which is the way to say "create this Item with no webhook".
 */
export function plaidWebhookUrl(
  processEnv: Record<string, string | undefined> = process.env,
): string | null {
  const explicit = processEnv['PLAID_WEBHOOK_URL'];
  if (explicit !== undefined) return explicit.length === 0 ? null : explicit;

  const productionHost = processEnv['VERCEL_PROJECT_PRODUCTION_URL'];
  if (productionHost !== undefined && productionHost.length > 0) {
    return `https://${productionHost}${PLAID_WEBHOOK_PATH}`;
  }

  const base = processEnv['APP_BASE_URL'];
  if (base !== undefined && base.length > 0) {
    const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
    return `${trimmed}${PLAID_WEBHOOK_PATH}`;
  }

  return `${DEFAULT_DEPLOYMENT_ORIGIN}${PLAID_WEBHOOK_PATH}`;
}

/* -------------------------------------------------------------------------- */
/* Call records — the evidence the screen prints                              */
/* -------------------------------------------------------------------------- */

/**
 * One HTTP call to Plaid, recorded so the screen can show the endpoint, the
 * status code and Plaid's own `request_id`.
 *
 * This exists because of a specific failure in this project: four integration
 * probes once reported LIVE for capabilities that did not exist. A screen that
 * says "linked" proves nothing; a screen that says
 * `POST /auth/get -> 200 (request 7b37b33b3a55147)` can be checked against
 * Plaid's dashboard by somebody who does not trust us.
 */
export interface PlaidCall {
  readonly endpoint: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly ms: number;
  readonly ok: boolean;
  /** Plaid's `error_code`, verbatim, on failure. */
  readonly errorCode: string | null;
}

function callOk(endpoint: string, requestId: string | null, ms: number): PlaidCall {
  return { endpoint, status: 200, requestId, ms, ok: true, errorCode: null };
}

function callFailed(endpoint: string, thrown: unknown, ms: number): PlaidCall {
  const body = plaidErrorBody(thrown);
  const status =
    typeof thrown === 'object' && thrown !== null && 'httpStatus' in thrown
      ? ((thrown as { httpStatus?: number }).httpStatus ?? 0)
      : 0;
  return {
    endpoint,
    status,
    requestId: body?.request_id ?? null,
    ms,
    ok: false,
    errorCode: body?.error_code ?? null,
  };
}

async function record<T extends { request_id?: string }>(
  calls: PlaidCall[],
  endpoint: string,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    calls.push(callOk(endpoint, value.request_id ?? null, Date.now() - started));
    return value;
  } catch (thrown) {
    calls.push(callFailed(endpoint, thrown, Date.now() - started));
    throw thrown;
  }
}

/* -------------------------------------------------------------------------- */
/* Linking                                                                    */
/* -------------------------------------------------------------------------- */

export interface LinkResult {
  /** Every call made, in order, with its status code and Plaid request id. */
  readonly calls: readonly PlaidCall[];
  /**
   * A REAL `link-sandbox-…` token from `/link/token/create` — the first step of
   * the production, browser-driven flow. It is minted and shown and then not
   * used, because completing Link needs a person in an iframe. See
   * `PlaidClient.createSandboxPublicToken`.
   */
  readonly linkToken: { readonly token: string; readonly expiresAt: string } | null;
  readonly item: PlaidItem;
  /** Every depository account on the Item that an ACH debit could be pulled from. */
  readonly fundable: readonly PlaidLinkedAccount[];
  /**
   * The full ACH numbers, keyed by Plaid account id.
   *
   * SEPARATED FROM `fundable` ON PURPOSE. `PlaidLinkedAccount` carries the last
   * four and the routing number and nothing else, so it is safe to hand to a
   * React tree. This map holds the full account number and must not leave the
   * server action that produced it.
   */
  readonly achNumbers: ReadonlyMap<string, PlaidAchNumbers>;
}

export interface LinkOptions {
  /** Our stable id for the customer. A uuid — never an email. Plaid is explicit. */
  readonly clientUserId: string;
  /** Where this Item's webhooks go. Absent means the Item gets none. */
  readonly webhook?: string | undefined;
  /** Force a link-time outcome, e.g. `error_ITEM_LOCKED`. */
  readonly overridePassword?: string | undefined;
  readonly institutionId?: string | undefined;
  readonly client?: PlaidClient | undefined;
  /** Skip `/link/token/create`. The error probes do, because it teaches nothing there. */
  readonly mintLinkToken?: boolean | undefined;
}

/**
 * The whole link flow, for real, in one call.
 *
 *   POST /link/token/create             the production first step, minted
 *   POST /sandbox/public_token/create   Link, without the browser
 *   POST /item/public_token/exchange    public token -> access token + item id
 *   POST /accounts/get                  what is on the Item
 *   POST /auth/get                      the routing and account numbers
 *
 * THE ACCESS TOKEN NEVER LEAVES THIS FUNCTION. It is used for the two reads
 * and then dropped on the floor. It is not returned, not logged and not
 * persisted — and it is not persisted because there is nowhere to persist it:
 * this schema has no `plaid_item` table and adding one needs a migration.
 * The consequence, stated rather than hidden: an Item cannot be re-read on a
 * later request, so `/funding` links a fresh Item per funding run and the
 * durable record of the linkage is the `external_ref` on the money rows.
 */
export async function linkExternalAccount(opts: LinkOptions): Promise<LinkResult> {
  const client = opts.client ?? new PlaidClient();
  const calls: PlaidCall[] = [];

  let linkToken: LinkResult['linkToken'] = null;
  if (opts.mintLinkToken !== false) {
    const minted = await record(calls, 'POST /link/token/create', () =>
      client.createLinkToken({
        clientUserId: opts.clientUserId,
        clientName: 'Corgi Business Banking',
        ...(opts.webhook === undefined ? {} : { webhook: opts.webhook }),
      }),
    );
    linkToken = { token: minted.link_token, expiresAt: minted.expiration };
  }

  const sandboxRequest: CreateSandboxPublicTokenRequest = {
    institutionId: opts.institutionId ?? SANDBOX_INSTITUTION_ID,
    initialProducts: ['auth'],
    ...(opts.webhook === undefined ? {} : { webhook: opts.webhook }),
    ...(opts.overridePassword === undefined ? {} : { overridePassword: opts.overridePassword }),
  };

  const publicToken = await record(calls, 'POST /sandbox/public_token/create', () =>
    client.createSandboxPublicToken(sandboxRequest),
  );

  const exchanged = await record(calls, 'POST /item/public_token/exchange', () =>
    client.exchangePublicToken(publicToken.public_token),
  );
  const accessToken = exchanged.access_token;

  const accounts = await record(calls, 'POST /accounts/get', () =>
    client.getAccounts(accessToken),
  );
  const auth = await record(calls, 'POST /auth/get', () => client.getAuth(accessToken));

  // `numbers.ach` is a FLAT ARRAY ACROSS ALL ACCOUNTS. Indexed, never [0].
  const achNumbers = new Map<string, PlaidAchNumbers>();
  for (const entry of auth.numbers.ach) achNumbers.set(entry.account_id, entry);

  const environment: PlaidEnvironment = client.environment;
  const fundable: PlaidLinkedAccount[] = [];
  for (const account of accounts.accounts) {
    if (!isFundable(account)) continue;
    const numbers = achNumbers.get(account.account_id);
    // A depository account Plaid could not produce ACH numbers for cannot be
    // funded from, whatever its subtype says. Silently listing it would offer a
    // funding source whose first entry is guaranteed to be returned.
    if (numbers === undefined) continue;
    fundable.push({
      itemId: accounts.item.item_id,
      accountId: account.account_id,
      institutionId: accounts.item.institution_id,
      institutionName: accounts.item.institution_name ?? null,
      accountName: account.name,
      officialName: account.official_name,
      accountMask: account.mask,
      subtype: account.subtype,
      routingNumber: numbers.routing,
      authMethod: auth.item.auth_method ?? accounts.item.auth_method ?? null,
      balanceDisplay: formatPlaidBalance(account.balances),
      evidence: PLAID_EVIDENCE,
      environment,
    });
  }

  return { calls, linkToken, item: accounts.item, fundable, achNumbers };
}

/* -------------------------------------------------------------------------- */
/* The non-happy paths, driven for real                                       */
/* -------------------------------------------------------------------------- */

export interface ItemErrorProbe {
  readonly calls: readonly PlaidCall[];
  /** The Item that was deliberately broken, or null when it broke at link time. */
  readonly itemId: string | null;
  /** Plaid's own error code. Never a string this codebase made up. */
  readonly errorCode: string;
  readonly errorType: string;
  readonly errorMessage: string;
  readonly displayMessage: string | null;
  readonly documentationUrl: string | null;
  /** Set when `/item/get` still answered 200 and told us when Plaid last called. */
  readonly lastWebhook: { readonly code: string; readonly sentAt: string } | null;
  readonly stage: 'link' | 'after_link';
}

/**
 * `error_ITEM_LOCKED` at LINK time.
 *
 * The failure happens inside `/sandbox/public_token/create` itself: HTTP 400,
 * and NO ITEM IS CREATED. There is nothing to store, nothing to retry and
 * nothing to reconnect — the customer has to unlock the account at their own
 * bank. That is a structurally different failure from an Item that breaks
 * later, which is why the two are separate probes and are rendered separately.
 */
export async function probeLinkTimeFailure(
  errorCode: string,
  client: PlaidClient = new PlaidClient(),
): Promise<ItemErrorProbe> {
  const calls: PlaidCall[] = [];
  try {
    await record(calls, 'POST /sandbox/public_token/create', () =>
      client.createSandboxPublicToken({
        institutionId: SANDBOX_INSTITUTION_ID,
        initialProducts: ['auth'],
        overridePassword: `error_${errorCode}`,
      }),
    );
  } catch (thrown) {
    const body = plaidErrorBody(thrown);
    if (body !== null) {
      return {
        calls,
        itemId: null,
        errorCode: body.error_code,
        errorType: body.error_type,
        errorMessage: body.error_message,
        displayMessage: body.display_message,
        documentationUrl: body.documentation_url ?? null,
        lastWebhook: null,
        stage: 'link',
      };
    }
    throw thrown;
  }
  // Plaid accepted a password we asked it to reject. Not something to paper
  // over with a fake error: report it as the surprise it is.
  throw new Error(
    `expected Plaid to refuse error_${errorCode} at link time, but the Item was created`,
  );
}

/**
 * `ITEM_LOGIN_REQUIRED` AFTER a successful link, on a throwaway Item.
 *
 * The sequence is real and every step of it was observed:
 *
 *   create + exchange       an Item in good standing
 *   /sandbox/item/reset_login -> 200 {"reset_login": true}
 *   /auth/get                 -> 400 ITEM_LOGIN_REQUIRED
 *   /item/get                 -> 200, item.error.error_code = ITEM_LOGIN_REQUIRED
 *
 * THE DIAGNOSIS IS THE SUCCESSFUL CALL. `/auth/get` can only tell you that
 * something failed; `/item/get` tells you what broke, and — via
 * `status.last_webhook` — that Plaid already told us, at a timestamp. Both are
 * made here so the screen can show the failure and the diagnosis side by side.
 *
 * ALWAYS ON A FRESH ITEM. There is no un-reset: recovery is Link in update
 * mode, which needs a browser. An Item broken here stays broken, which is
 * exactly why it is not the Item anything was funded from.
 */
export async function probeItemLoginRequired(
  opts: { readonly webhook?: string | undefined; readonly client?: PlaidClient | undefined } = {},
): Promise<ItemErrorProbe> {
  const client = opts.client ?? new PlaidClient();
  const calls: PlaidCall[] = [];

  const publicToken = await record(calls, 'POST /sandbox/public_token/create', () =>
    client.createSandboxPublicToken({
      institutionId: SANDBOX_INSTITUTION_ID,
      initialProducts: ['auth'],
      ...(opts.webhook === undefined ? {} : { webhook: opts.webhook }),
    }),
  );
  const exchanged = await record(calls, 'POST /item/public_token/exchange', () =>
    client.exchangePublicToken(publicToken.public_token),
  );
  const accessToken = exchanged.access_token;

  await record(calls, 'POST /sandbox/item/reset_login', () =>
    client.sandboxResetLogin(accessToken),
  );

  // Expected to throw. The throw IS the demonstration.
  let productError = null as ReturnType<typeof plaidErrorBody>;
  try {
    await record(calls, 'POST /auth/get', () => client.getAuth(accessToken));
  } catch (thrown) {
    productError = plaidErrorBody(thrown);
    if (productError === null) throw thrown;
  }

  const item = await record(calls, 'POST /item/get', () => client.getItem(accessToken));
  const itemError = item.item.error ?? productError;

  if (itemError === null) {
    throw new Error(
      `reset_login returned true but item ${item.item.item_id} reports no error — refusing to render an error state Plaid does not agree with`,
    );
  }

  const lastWebhook = item.status?.last_webhook ?? null;
  return {
    calls,
    itemId: item.item.item_id,
    errorCode: itemError.error_code,
    errorType: itemError.error_type,
    errorMessage: itemError.error_message,
    displayMessage: itemError.display_message,
    documentationUrl: itemError.documentation_url ?? null,
    lastWebhook:
      lastWebhook === null || lastWebhook === undefined
        ? null
        : { code: lastWebhook.code_sent, sentAt: lastWebhook.sent_at },
    stage: 'after_link',
  };
}

/* -------------------------------------------------------------------------- */
/* Funding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How well we know the payer, which is the only input to how long the money is
 * held. Mirrors `funds_availability_policy.counterparty_class`.
 *
 * `self` is the honest default for a Plaid-linked account: it is the
 * customer's OWN external bank, verified by Plaid, and the seeded policy holds
 * it one banking day — "still a hold, because a customer can overdraw their own
 * outside bank as easily as anyone else can".
 */
export type CounterpartyClass = 'self' | 'known' | 'new';

export interface FundingRequest {
  readonly businessId: string;
  /** Integer minor units. Never a float, never dollars. */
  readonly amountCents: bigint;
  readonly linked: PlaidLinkedAccount;
  readonly counterpartyClass: CounterpartyClass;
  /** The value date the credit belongs to, `YYYY-MM-DD` in book time. */
  readonly valueDate: ValueDate;
  /**
   * The SOURCE FACT this funding run is identified by. The idempotency keys are
   * derived from it, so submitting the same reference twice books one deposit.
   */
  readonly reference: string;
  readonly actorId?: string | undefined;
  readonly conn?: Sql | undefined;
}

export interface FundingReceipt {
  readonly entryId: string;
  readonly memoEntryId: string;
  readonly holdId: string;
  readonly externalRef: string;
  readonly amountCents: bigint;
  readonly schedule: AvailabilitySchedule;
  readonly policy: AvailabilityPolicy;
  /** False when this reference had already funded — nothing new was written. */
  readonly created: boolean;
  readonly depositAccountId: string;
}

export class FundingRefused extends Error {
  override readonly name = 'FundingRefused';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface Chart {
  readonly entityId: string;
  readonly depositAccountId: string;
  readonly memoAccountId: string;
  readonly inTransitAccountId: string;
  readonly memoContraAccountId: string;
}

async function resolveChart(businessId: string, conn: Sql): Promise<Chart> {
  const [row] = await conn<
    {
      entity_id: string;
      deposit_id: string;
      memo_id: string;
      in_transit_id: string;
      contra_id: string;
    }[]
  >`
    SELECT dep.entity_id                        AS entity_id,
           dep.id                               AS deposit_id,
           memo.id                              AS memo_id,
           transit.id                           AS in_transit_id,
           contra.id                            AS contra_id
      FROM account dep
      JOIN account memo    ON memo.business_id = dep.business_id
                          AND memo.code = ${UNCLEARED_HOLD_CODE}
      JOIN account transit ON transit.entity_id = dep.entity_id
                          AND transit.code = ${INBOUND_IN_TRANSIT_CODE}
                          AND transit.business_id IS NULL
      JOIN account contra  ON contra.entity_id = dep.entity_id
                          AND contra.code = ${MEMO_CONTRA_CODE}
                          AND contra.business_id IS NULL
     WHERE dep.code = ${DEPOSIT_CODE}
       AND dep.business_id = ${businessId}::uuid
       AND dep.book = 'financial'`;

  if (row === undefined) {
    throw new FundingRefused(
      'NO_DEPOSIT_ACCOUNT',
      `Business ${businessId} has no 2100 deposit account and 9200 uncleared-credit hold account on this book, so there is nowhere for an inbound credit to land and no account to withhold it in. A business gets both when it is onboarded.`,
    );
  }
  return {
    entityId: row.entity_id,
    depositAccountId: row.deposit_id,
    memoAccountId: row.memo_id,
    inTransitAccountId: row.in_transit_id,
    memoContraAccountId: row.contra_id,
  };
}

/**
 * The `funds_availability_policy` row in force for this rail, this counterparty
 * class and this VALUE DATE.
 *
 * `effective_from <= valueDate ORDER BY effective_from DESC LIMIT 1` — chosen
 * by the value date and never by today, for the same reason the approval
 * threshold is: raising the hold period tomorrow must not retroactively change
 * how long a credit booked today was held. The hold stores the row's id, so
 * the answer stays explainable after the table changes.
 */
export async function effectiveAvailabilityPolicy(
  args: {
    readonly rail: string;
    readonly counterpartyClass: string;
    readonly valueDate: ValueDate;
  },
  conn: Sql,
): Promise<AvailabilityPolicy | null> {
  const [row] = await conn<
    {
      id: string;
      rail: string;
      counterparty_class: string;
      banking_days_hold: number;
      release_local_time: string;
      note: string;
    }[]
  >`
    SELECT id, rail::text AS rail, counterparty_class, banking_days_hold,
           release_local_time::text AS release_local_time, note
      FROM funds_availability_policy
     WHERE rail = ${args.rail}::rail
       AND counterparty_class = ${args.counterpartyClass}
       AND effective_from <= ${args.valueDate}::date
     ORDER BY effective_from DESC
     LIMIT 1`;

  return row === undefined
    ? null
    : {
        id: row.id,
        rail: row.rail,
        counterpartyClass: row.counterparty_class,
        bankingDaysHold: row.banking_days_hold,
        releaseLocalTime: row.release_local_time,
        note: row.note,
      };
}

/** Every ACH availability policy version, for the screen's policy table. */
export async function listAvailabilityPolicies(conn: Sql): Promise<readonly AvailabilityPolicy[]> {
  const rows = await conn<
    {
      id: string;
      rail: string;
      counterparty_class: string;
      banking_days_hold: number;
      release_local_time: string;
      note: string;
    }[]
  >`
    SELECT id, rail::text AS rail, counterparty_class, banking_days_hold,
           release_local_time::text AS release_local_time, note
      FROM funds_availability_policy
     ORDER BY rail, banking_days_hold DESC, counterparty_class`;

  return rows.map((row) => ({
    id: row.id,
    rail: row.rail,
    counterpartyClass: row.counterparty_class,
    bankingDaysHold: row.banking_days_hold,
    releaseLocalTime: row.release_local_time,
    note: row.note,
  }));
}

/**
 * Has this business already funded under this reference?
 *
 * A GUARD, NOT A GUARANTEE, and the difference matters enough to be in the
 * name of this comment. Two requests racing between this SELECT and the INSERT
 * that follows it both see nothing and both proceed; what stops the second from
 * booking is the unique index, and the unique index cannot see across two
 * separately linked Items. See the header of this file.
 *
 * What it does stop is the failure that actually happens: a person pressing
 * "fund" twice because the first press took four seconds of Plaid round trips
 * and looked like nothing happened. That is worth a query.
 *
 * `split_part(external_ref, ':', 4)` reads the reference back out of
 * `plaid:<item>:<account>:<reference>`. It is exact rather than a `LIKE`
 * because a reference is forbidden from containing a colon at construction
 * time (`plaidExternalRef`), so the fourth segment IS the reference and a
 * pattern match would only add a way to be wrong about it.
 */
export async function alreadyFundedReference(
  businessId: string,
  reference: string,
  conn: Sql = sql,
): Promise<{ readonly holdId: string; readonly externalRef: string } | null> {
  const [row] = await conn<{ id: string; external_ref: string }[]>`
    SELECT h.id, h.external_ref
      FROM hold h
      JOIN account a ON a.id = h.account_id
     WHERE a.business_id = ${businessId}::uuid
       AND h.kind = 'uncleared_credit'
       AND split_part(h.external_ref, ':', 1) = ${PLAID_PROVIDER}
       AND split_part(h.external_ref, ':', 4) = ${reference}
     ORDER BY h.created_at
     LIMIT 1`;

  return row === undefined ? null : { holdId: row.id, externalRef: row.external_ref };
}

/**
 * Book the deposit and open the availability hold.
 *
 * One transaction: the hold row, the financial entry and the memo entry commit
 * together or not at all. A crash between the financial entry and the memo one
 * would leave the customer able to spend money that has not cleared, which is
 * the exact failure the hold exists to prevent — so it is not a window that is
 * made small, it is a window that does not exist.
 */
export async function fundFromLinkedAccount(req: FundingRequest): Promise<FundingReceipt> {
  const conn = req.conn ?? sql;

  if (req.amountCents <= 0n) {
    throw new FundingRefused(
      'INVALID_AMOUNT',
      'A funding amount must be a positive integer number of cents. Zero is not a deposit and a negative one is a withdrawal wearing a deposit’s clothes.',
    );
  }

  const externalRef = plaidExternalRef(
    req.linked.itemId,
    req.linked.accountId,
    req.reference,
  );
  const actorId = req.actorId ?? (await ledgerPosterActorId(conn));
  const chart = await resolveChart(req.businessId, conn);

  const policy = await effectiveAvailabilityPolicy(
    { rail: 'ach', counterpartyClass: req.counterpartyClass, valueDate: req.valueDate },
    conn,
  );
  if (policy === null) {
    // NOT a default of "release immediately". A missing policy means nobody has
    // decided how long this money is at risk for, and guessing zero is the one
    // answer that can lose money.
    throw new FundingRefused(
      'NO_AVAILABILITY_POLICY',
      `No funds_availability_policy row covers rail 'ach' / counterparty class '${req.counterpartyClass}' at value date ${req.valueDate}. Nothing was booked: a credit whose availability nobody has decided is not one this system will make spendable by default.`,
    );
  }

  const schedule = scheduleAvailability(policy, req.valueDate);

  return conn.begin(async (raw) => {
    const tx = raw as unknown as Sql;

    // `hold_ref UNIQUE (kind, external_ref)` decides whether this is the first
    // funding of this reference. Not a SELECT-then-INSERT: the index decides.
    const inserted = await tx<{ id: string }[]>`
      INSERT INTO hold (account_id, memo_account_id, kind, external_ref,
                        value_date, available_at, policy_id)
      VALUES (${chart.depositAccountId}::uuid, ${chart.memoAccountId}::uuid,
              'uncleared_credit', ${externalRef}, ${req.valueDate}::date,
              ${schedule.availableAt.toISOString()}::timestamptz, ${policy.id}::uuid)
      ON CONFLICT (kind, external_ref) DO NOTHING
      RETURNING id`;

    const created = inserted.length > 0;
    const holdId =
      inserted[0]?.id ??
      (
        await tx<{ id: string }[]>`
          SELECT id FROM hold
           WHERE kind = 'uncleared_credit' AND external_ref = ${externalRef}`
      )[0]?.id;

    if (holdId === undefined) {
      throw new Error(`failed to create or find the uncleared-credit hold for ${externalRef}`);
    }

    const where =
      req.linked.institutionName === null
        ? `Plaid item ${req.linked.itemId}`
        : `${req.linked.institutionName} ${req.linked.accountMask ?? ''}`.trim();

    // The description says what did NOT happen, on the row itself, for ever.
    // A ledger line that reads "in transit" while nothing was transmitted is a
    // false statement unless the row itself carries the qualification.
    const entryId = await postEntry(
      {
        entityId: chart.entityId,
        valueDate: req.valueDate,
        book: 'financial',
        description: `Inbound ACH funding from ${where} via Plaid — ORIGINATED, NOT TRANSMITTED (no ACH entry was sent to any network)`,
        idempotencyKey: `plaid:funding:${externalRef}`,
        actorId,
        rail: 'ach',
        externalRef,
        lines: [
          // Debit the receivable: the counterparty bank owes us this.
          { accountId: chart.inTransitAccountId, amountCents: req.amountCents },
          // Credit the customer: money in is a CREDIT to a deposit account,
          // because the customer having money is the bank owing money.
          { accountId: chart.depositAccountId, amountCents: -req.amountCents },
        ],
      },
      tx,
    );

    const memoEntryId = await postEntry(
      {
        entityId: chart.entityId,
        valueDate: req.valueDate,
        book: 'memo',
        description: `Uncleared credit held to ${schedule.releaseDate} ${policy.releaseLocalTime} ET (${policy.rail}/${policy.counterpartyClass}, ${policy.bankingDaysHold} banking day${policy.bankingDaysHold === 1 ? '' : 's'})`,
        idempotencyKey: `hold:${holdId}:after:${externalRef}`,
        actorId,
        rail: 'ach',
        externalRef,
        holdId,
        lines: [
          // Credit the customer's 9200 leaf: more held is a bigger obligation.
          // The leaf is credit-normal, so a POSITIVE hold is a NEGATIVE
          // amount_cents. Getting that inversion wrong is the classic error.
          { accountId: chart.memoAccountId, amountCents: -req.amountCents },
          // Debit the contra, so the memo book nets to zero on its own.
          { accountId: chart.memoContraAccountId, amountCents: req.amountCents },
        ],
      },
      tx,
    );

    return {
      entryId,
      memoEntryId,
      holdId,
      externalRef,
      amountCents: req.amountCents,
      schedule,
      policy,
      created,
      depositAccountId: chart.depositAccountId,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Release                                                                    */
/* -------------------------------------------------------------------------- */

export interface ReleaseResult {
  readonly examined: number;
  readonly closed: number;
  readonly released: number;
  readonly releasedCents: bigint;
  readonly holdIds: readonly string[];
}

/**
 * The availability sweep. The exact sibling of `holds/expiry.ts`, for the other
 * kind of clock-released hold.
 *
 * IT COMPUTES NOTHING THE DATABASE DID NOT ALREADY KNOW. `v_hold_state`'s
 * release predicate already contains `h.kind = 'uncleared_credit' AND now() >=
 * h.available_at`, so `v_available_balance` frees the money on the clock with
 * nothing running at all. RUNNING THIS NEVER IS SAFE; the customer's available
 * balance is already correct.
 *
 * What it does is the two things the database cannot do for itself:
 *
 *   1. writes the `hold_closure` row, so every reader agrees — including
 *      `availableBalance()` in `ledger/balances.ts`, whose predicate is
 *      closure-only and does NOT know about `available_at`. Until this row
 *      exists those two functions give different answers for the same hold,
 *      which is the shape of the bug migration 0011 was written for;
 *   2. appends the memo entry that drives the 9200 leaf back to zero, so the
 *      memo book agrees with the predicate and `v_hold_release_drift` — which
 *      asserts that a released hold withholds nothing — stays empty.
 *
 * EXACTLY-ONCE WITHOUT A LOCK. There is no row lock here and there cannot be:
 * `corgi_app` holds no UPDATE on `hold`, so `FOR UPDATE` is not expressible,
 * and unlike a card authorisation there is no SECURITY DEFINER helper for one.
 * The guarantee comes from the two places it comes from everywhere else in
 * this codebase — `hold_closure` has `PRIMARY KEY (hold_id)`, and the release
 * entry's idempotency key is derived from the hold id and its `available_at`,
 * which are both immutable. Two sweeps racing the same hold compute the same
 * key, and Postgres refuses the second. A third sweep after the release reads a
 * memo balance of zero and posts nothing at all.
 */
export async function releaseAvailableCredits(
  opts: {
    readonly now?: Date | undefined;
    readonly limit?: number | undefined;
    readonly actorId?: string | undefined;
    readonly conn?: Sql | undefined;
  } = {},
): Promise<ReleaseResult> {
  const conn = opts.conn ?? sql;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 100;
  const actorId = opts.actorId ?? (await ledgerPosterActorId(conn));

  const due = await conn<
    {
      id: string;
      memo_account_id: string;
      available_at: Date;
      entity_id: string;
      external_ref: string;
    }[]
  >`
    SELECT h.id, h.memo_account_id, h.available_at, a.entity_id, h.external_ref
      FROM hold h
      JOIN account a ON a.id = h.account_id
     WHERE h.kind = 'uncleared_credit'
       AND h.available_at <= ${now.toISOString()}::timestamptz
       -- A closure that has been reversed is not a closure, so a hold whose
       -- wrong closure was corrected is visible to the sweeper again. Same
       -- predicate as v_hold_state.is_released; they must not drift.
       AND NOT EXISTS (
             SELECT 1 FROM hold_closure hc
              WHERE hc.hold_id = h.id
                AND NOT EXISTS (
                      SELECT 1 FROM hold_closure_reversal hr WHERE hr.hold_id = hc.hold_id
                    ))
     ORDER BY h.available_at
     LIMIT ${limit}`;

  let closed = 0;
  let released = 0;
  let releasedCents = 0n;
  const holdIds: string[] = [];

  for (const hold of due) {
    const outcome = await conn.begin(async (raw) => {
      const tx = raw as unknown as Sql;

      // Closure FIRST, posting second. That order is the crash-safety argument:
      // `availableBalance()` reads "released" as this row existing, so a
      // process that dies in between leaves the customer's available balance
      // already correct and the posting lands on the next sweep.
      const closurePosted = await closeHold(
        hold.id,
        `funds availability reached at ${hold.available_at.toISOString()}`,
        actorId,
        tx,
      );

      const balance = await memoHoldBalance(hold.id, hold.memo_account_id, tx);
      if (balance === 0n) return { closurePosted, delta: 0n };

      const [contra] = await tx<{ id: string }[]>`
        SELECT id FROM account
         WHERE code = ${MEMO_CONTRA_CODE}
           AND business_id IS NULL
           AND entity_id = ${hold.entity_id}::uuid
         LIMIT 1`;
      if (contra === undefined) {
        throw new Error(`house account ${MEMO_CONTRA_CODE} is missing from the chart`);
      }

      await postEntry(
        {
          entityId: hold.entity_id,
          // Book time, not the original value date: the money becoming
          // available is a NEW EVENT that really happened today, not a
          // correction to a statement about the day the credit landed. See
          // `rail_event_semantics` in migration 0001 for the same distinction
          // drawn for ACH returns.
          valueDate: bookDateOf(now),
          book: 'memo',
          description: 'Uncleared credit released — funds availability reached',
          idempotencyKey: `hold:${hold.id}:after:availability:${hold.available_at.toISOString()}`,
          actorId,
          rail: 'ach',
          externalRef: hold.external_ref,
          holdId: hold.id,
          lines: [
            // Debit the customer's 9200 leaf back down to zero.
            { accountId: hold.memo_account_id, amountCents: balance },
            { accountId: contra.id, amountCents: -balance },
          ],
        },
        tx,
      );

      return { closurePosted, delta: balance };
    });

    if (outcome.closurePosted) closed += 1;
    if (outcome.delta !== 0n) {
      released += 1;
      releasedCents += outcome.delta;
      holdIds.push(hold.id);
    }
  }

  return { examined: due.length, closed, released, releasedCents, holdIds };
}

/**
 * Today in book time (America/New_York), `YYYY-MM-DD`.
 *
 * Not `toISOString().slice(0, 10)`: after 20:00 in New York that is already
 * tomorrow in UTC, and a release posted with tomorrow's value date is a
 * future-dated entry that `ledgerBalanceCents` deliberately excludes — so the
 * memo book would look un-flat until midnight.
 */
export function bookDateOf(now: Date = new Date()): ValueDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BANKING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const find = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${find('year')}-${find('month')}-${find('day')}`;
}
