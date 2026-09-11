/**
 * Plaid ITEM health — a fourth question, and the one the slot table could not
 * ask.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT THAT FORCED THIS FILE
 * ---------------------------------------------------------------------------
 * Measured against the production database and the live Plaid sandbox at
 * 2026-09-11T16:47Z:
 *
 *   `/api/health` reported the `open_banking` slot **live**, evidence
 *   `POST /institutions/get -> 200`, and the Plaid webhook feed **stale** at
 *   64,899 seconds.
 *
 *   Plaid had delivered exactly THREE webhooks, ever. All three `ITEM`/`ERROR`
 *   carrying `ITEM_LOGIN_REQUIRED`. All three `state = 'done'`, consumed
 *   cleanly, with nowhere to record what they said.
 *
 *   The three deliveries carry THREE DIFFERENT `item_id`s, and all three were
 *   re-checked against Plaid: `POST /item/get -> 400 INVALID_ACCESS_TOKEN`, on
 *   every one. We hold no credential for any of them.
 *
 * Neither published reading was false. `/institutions/get` really did answer
 * 200, and `MAX(received_at)` really was eighteen hours old. Together they read
 * as "a working integration that has gone quiet", and the truth was "a valid
 * credential, and not one usable funding source in existence".
 *
 * ---------------------------------------------------------------------------
 * WHY THE PROBE CANNOT ANSWER THIS, AND IS NOT BEING BLAMED FOR IT
 * ---------------------------------------------------------------------------
 * `/institutions/get` is a CATALOGUE lookup. It is answerable with no Item in
 * existence; it would answer 200 on an account that has never linked a bank.
 * It is a perfectly good credential probe and `probe.ts` is not changed by this
 * file — its verdict, `live`, is TRUE and is about credentials.
 *
 * The bug was never that the probe lied. It is that the slot is called
 * `open_banking`, the webhook route's own purpose string is "open banking —
 * account funding and item health", and a reader takes `live` to mean "we can
 * fund from a linked bank". THE EVIDENCE WAS CHOSEN BY SOMETHING OTHER THAN
 * THE CAPABILITY IT STANDS FOR — this build's recurring shape, and the reason
 * the repair is a new question rather than a rewritten probe.
 *
 * ---------------------------------------------------------------------------
 * A FOURTH DISJOINT VOCABULARY
 * ---------------------------------------------------------------------------
 * `/api/health` already keeps three verdict vocabularies apart so that no
 * reader has to reconcile them:
 *
 *   liveness    live / simulated / unauthorised / unreachable /
 *               rate_limited / not_configured          — does the key work
 *   delivery    fresh / stale / quiet / never / unknown — are they talking
 *   processing  consuming / backlogged / dropping / refused / superseded /
 *               never_consumed / unmeasured            — did we act on it
 *
 * This is "CAN WE ACTUALLY DO THE THING", and it shares no word with any of
 * them:
 *
 *   healthy       Plaid's own last word on this Item was "no error".
 *   needs_reauth  Plaid says a HUMAN must re-authenticate in Link update mode.
 *   revoked       The customer withdrew consent. Terminal.
 *   orphaned      Plaid named an Item we hold no live credential for.
 *   absent        No Item at all — so silence from Plaid is CORRECT.
 *   unread        The query did not run. Stated, never guessed.
 *
 * `absent` is the one that fixes the reading at the top of this file. "We have
 * never linked a bank" and "our linked bank is broken" were the same reading,
 * and they are opposite operational facts.
 *
 * ---------------------------------------------------------------------------
 * AND IT DOES NOT DEGRADE THE DEPLOYMENT
 * ---------------------------------------------------------------------------
 * `route.ts` records the house rule: "A status that cannot go back to `ok` is a
 * status people stop reading", and this endpoint already learned once not to
 * report degraded overnight because nobody swiped a card.
 *
 * `needs_reauth` is a state whose exit condition is A PERSON DOING SOMETHING.
 * Degrading on it would mean the deployment is degraded from the moment a
 * customer's bank rotates its MFA until that customer next logs in — days,
 * legitimately, with nothing broken on our side and nothing an operator can do.
 * That is precisely the alarm nobody reads.
 *
 * So this module publishes a TRUER reading, not a louder one. Every field below
 * is a fact Plaid stated, with the instant it stated it attached, so a reader
 * can discount it — the same discipline `probe.ts` applies to a quoted verdict.
 */

import type postgres from 'postgres';

/**
 * The client this module needs. Deliberately the same type `/api/health`
 * already holds, so the route hands over the connection its `select 1` has
 * already warmed rather than opening another.
 */
export type ItemSql = ReturnType<typeof postgres>;

// ---------------------------------------------------------------------------
// 1. The verdict vocabulary
// ---------------------------------------------------------------------------

export type ItemVerdict =
  | 'healthy'
  | 'needs_reauth'
  | 'revoked'
  | 'orphaned'
  | 'absent'
  | 'unread';

/** Exported so a test can prove all four vocabularies stay disjoint. */
export const ITEM_VERDICTS: readonly ItemVerdict[] = [
  'healthy',
  'needs_reauth',
  'revoked',
  'orphaned',
  'absent',
  'unread',
];

/** Budget for the item query. Sized like the other two enrichment reads. */
export const ITEM_QUERY_TIMEOUT_MS = 2_500;

// ---------------------------------------------------------------------------
// 2. Reading
// ---------------------------------------------------------------------------

export interface ItemRow {
  readonly itemId: string;
  readonly institutionName: string | null;
  readonly environment: string | null;
  readonly purpose: string | null;
  readonly state: ItemVerdict;
  readonly lastObservedAt: Date | null;
  readonly lastSource: string | null;
  readonly lastErrorCode: string | null;
  readonly observations: number;
  readonly errorObservations: number;
  readonly hasLiveToken: boolean;
  readonly accountCount: number;
}

export type ItemRead =
  | { readonly ok: true; readonly rows: readonly ItemRow[]; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number | null };

/** A read that never happened, for the paths where there is nothing to query. */
export function itemsUnavailable(error: string): ItemRead {
  return { ok: false, error, latencyMs: null };
}

/**
 * One round trip. Never throws — a health endpoint that cannot answer because
 * its own enrichment query failed has become the outage.
 *
 * READS THE VIEW, NOT THE TABLES. `v_plaid_item_state` is the definition of the
 * fold (migration 0056 §11) and re-deriving it here in SQL or in TypeScript
 * would be a second opinion about the same question — the bug DECISIONS 021
 * records, one module further along.
 */
export async function readPlaidItems(
  sql: ItemSql,
  timeoutMs: number = ITEM_QUERY_TIMEOUT_MS,
): Promise<ItemRead> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`plaid item state query exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const query = sql`
      select item_id, institution_name, environment, purpose, state,
             last_observed_at, last_source, last_error_code,
             observations, error_observations, has_live_token, account_count
        from v_plaid_item_state
       order by last_observed_at desc`;
    const result = (await Promise.race([query, timeout])) as readonly unknown[];
    return { ok: true, rows: result.map(toRow), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Rows arrive as `unknown` on purpose — the same defence
 * `delivery-health.ts#toRow` takes, and for the same reason: this driver has
 * previously handed timestamps back as strings and bigints as strings, and a
 * health endpoint must not throw on one.
 */
function toRow(raw: unknown): ItemRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  const state = typeof row['state'] === 'string' ? row['state'] : '';
  return {
    itemId: typeof row['item_id'] === 'string' ? row['item_id'] : '',
    institutionName: asStringOrNull(row['institution_name']),
    environment: asStringOrNull(row['environment']),
    purpose: asStringOrNull(row['purpose']),
    // A state the view produced that this module does not know about is
    // `unread`, never silently coerced to `healthy`.
    state: isItemVerdict(state) ? state : 'unread',
    lastObservedAt: toDate(row['last_observed_at']),
    lastSource: asStringOrNull(row['last_source']),
    lastErrorCode: asStringOrNull(row['last_error_code']),
    observations: toInt(row['observations']),
    errorObservations: toInt(row['error_observations']),
    hasLiveToken: row['has_live_token'] === true,
    accountCount: toInt(row['account_count']),
  };
}

function isItemVerdict(value: string): value is ItemVerdict {
  return (ITEM_VERDICTS as readonly string[]).includes(value);
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toInt(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. The published shape
// ---------------------------------------------------------------------------

export interface ItemReport {
  readonly itemId: string;
  readonly institutionName: string | null;
  readonly environment: string | null;
  /** `diagnostic` items are deliberately broken fixtures, never funding sources. */
  readonly purpose: string | null;
  readonly verdict: ItemVerdict;
  readonly lastObservedAt: string | null;
  readonly ageSeconds: number | null;
  /** How we last heard: `link`, `webhook` or `item_get`. */
  readonly lastSource: string | null;
  readonly lastErrorCode: string | null;
  /**
   * How many accounts are STORED for this item, fundable or not.
   *
   * Not "fundable": `plaid_item_account` deliberately keeps the accounts Plaid
   * returned that could NOT produce ACH numbers, so that "we saw no fundable
   * account" and "we never looked" stay different facts. Calling this number
   * fundable would be a small version of exactly the over-claim this module
   * exists to remove.
   */
  readonly storedAccounts: number;
  readonly note: string;
}

export interface PlaidItemHealth {
  /** Where the numbers come from. One view, no derived table to drift. */
  readonly source: 'v_plaid_item_state';
  readonly measuredAt: string;
  /** False means the verdict is `unread` and `error` says why. */
  readonly measured: boolean;
  readonly error: string | null;
  readonly queryLatencyMs: number | null;

  /** The provider-level answer to "can we fund from a linked bank right now". */
  readonly verdict: ItemVerdict;

  readonly items: readonly ItemReport[];
  readonly counts: Readonly<Record<ItemVerdict, number>>;

  /**
   * THE FIELD THE DELIVERY VOCABULARY HAD NO WORD FOR.
   *
   * `stale` means "this provider has gone quiet", which implies it once worked.
   * When every observation this system has ever recorded from Plaid was an
   * error, that implication is false, and this says so in one boolean rather
   * than leaving a reader to infer it from a lag in seconds.
   */
  readonly heardOnlyErrors: boolean;
  readonly observations: number;
  readonly errorObservations: number;

  /**
   * Whether Plaid's silence is the EXPECTED steady state.
   *
   * True when there is no item capable of producing a webhook. When this is
   * true, a `stale` delivery verdict is not evidence of anything and the
   * delivery field says so rather than reading as an anomaly.
   */
  readonly silenceIsExpected: boolean;

  /** Always false, and the argument is in this file's header. */
  readonly degradesDeployment: false;

  readonly note: string;
}

// ---------------------------------------------------------------------------
// 4. The fold
// ---------------------------------------------------------------------------

/**
 * Pure: no clock of its own, no database, no network — so every branch is
 * reachable from a test rather than from an outage.
 */
export function plaidItemHealth(read: ItemRead, now: Date): PlaidItemHealth {
  if (!read.ok) {
    return {
      source: 'v_plaid_item_state',
      measuredAt: now.toISOString(),
      measured: false,
      error: read.error,
      queryLatencyMs: read.latencyMs,
      verdict: 'unread',
      items: [],
      counts: emptyCounts(),
      heardOnlyErrors: false,
      observations: 0,
      errorObservations: 0,
      silenceIsExpected: false,
      degradesDeployment: false,
      note: 'plaid item state could not be read; this is not a verdict about any funding source',
    };
  }

  const items = read.rows.map((row) => reportFor(row, now));
  const counts = emptyCounts();
  for (const item of items) counts[item.verdict] += 1;

  const observations = read.rows.reduce((sum, row) => sum + row.observations, 0);
  const errorObservations = read.rows.reduce((sum, row) => sum + row.errorObservations, 0);

  // "Everything we ever heard was an error." Requires at least one
  // observation: zero out of zero is not a finding, it is an empty set.
  const heardOnlyErrors = observations > 0 && errorObservations === observations;

  // Only an item we hold a credential for can generate further webhooks. An
  // orphan cannot — Plaid still has it, but nothing here can act on what it
  // says, and it is not a funding source that is about to start working.
  const usable = read.rows.filter((row) => row.state !== 'orphaned');
  const silenceIsExpected = usable.length === 0;

  const verdict = rollUp(items);

  return {
    source: 'v_plaid_item_state',
    measuredAt: now.toISOString(),
    measured: true,
    error: null,
    queryLatencyMs: read.latencyMs,
    verdict,
    items,
    counts,
    heardOnlyErrors,
    observations,
    errorObservations,
    silenceIsExpected,
    degradesDeployment: false,
    note: providerNote(verdict, counts, heardOnlyErrors, silenceIsExpected),
  };
}

/**
 * The provider-level verdict.
 *
 * BEST-CASE, DELIBERATELY: one healthy item means this deployment CAN fund
 * from a linked bank, whatever else is lying around broken. A build that keeps
 * a deliberately-broken diagnostic item as a test fixture — this one does —
 * must not report itself unable to fund because that fixture exists.
 *
 * The worse states are not hidden by it. They are each counted in `counts` and
 * named per item in `items`, so the rollup is a summary and never the only
 * place a broken funding source appears.
 */
function rollUp(items: readonly ItemReport[]): ItemVerdict {
  if (items.length === 0) return 'absent';
  const order: readonly ItemVerdict[] = ['healthy', 'needs_reauth', 'revoked', 'orphaned'];
  for (const verdict of order) {
    if (items.some((item) => item.verdict === verdict)) return verdict;
  }
  return 'unread';
}

function emptyCounts(): Record<ItemVerdict, number> {
  return { healthy: 0, needs_reauth: 0, revoked: 0, orphaned: 0, absent: 0, unread: 0 };
}

function reportFor(row: ItemRow, now: Date): ItemReport {
  const ageSeconds =
    row.lastObservedAt === null
      ? null
      : // Floor at zero: clock skew between the database and this function
        // must not publish a negative age, which reads as corruption.
        Math.max(0, Math.floor((now.getTime() - row.lastObservedAt.getTime()) / 1000));

  return {
    itemId: row.itemId,
    institutionName: row.institutionName,
    environment: row.environment,
    purpose: row.purpose,
    verdict: row.state,
    lastObservedAt: row.lastObservedAt === null ? null : row.lastObservedAt.toISOString(),
    ageSeconds,
    lastSource: row.lastSource,
    lastErrorCode: row.lastErrorCode,
    storedAccounts: row.accountCount,
    note: itemNote(row),
  };
}

function itemNote(row: ItemRow): string {
  switch (row.state) {
    case 'healthy':
      return `Plaid's last word on this item was "no error" (via ${row.lastSource ?? 'an observation'}); ${row.accountCount} account(s) stored`;
    case 'needs_reauth':
      return `Plaid reports ${row.lastErrorCode ?? 'an item error'}: a HUMAN must re-authenticate in Link update mode. Nothing is broken on our side and nothing is being lost, so this is reported and not alarmed on`;
    case 'revoked':
      return `the customer withdrew consent (${row.lastErrorCode ?? 'revoked'}); this item is terminal and re-linking creates a new one, it does not repair this`;
    case 'orphaned':
      return 'Plaid named this item but we hold no live access token for it, so it cannot be read, repaired or removed by us — it is not a broken funding source, it is one we cannot reach';
    case 'absent':
    case 'unread':
      return 'no state recorded for this item';
  }
}

function providerNote(
  verdict: ItemVerdict,
  counts: Readonly<Record<ItemVerdict, number>>,
  heardOnlyErrors: boolean,
  silenceIsExpected: boolean,
): string {
  const tail = heardOnlyErrors
    ? ' Every observation ever recorded from Plaid was an error, so a `stale` delivery verdict here does NOT mean a working feed went quiet.'
    : '';
  const silence = silenceIsExpected
    ? ' No item can produce a webhook, so silence from Plaid is the correct steady state and is not an anomaly.'
    : '';

  switch (verdict) {
    case 'healthy':
      return `${counts.healthy} usable funding source(s); this deployment can fund from a linked bank.${silence}${tail}`;
    case 'needs_reauth':
      return `no usable funding source: ${counts.needs_reauth} item(s) need a human to re-authenticate in Link update mode. Reported, not alarmed on — the exit condition is a person, not an operator.${silence}${tail}`;
    case 'revoked':
      return `no usable funding source: consent was withdrawn on ${counts.revoked} item(s).${silence}${tail}`;
    case 'orphaned':
      return `no usable funding source: ${counts.orphaned} item(s) are known only as ids Plaid named, with no stored credential.${silence}${tail}`;
    case 'absent':
      return 'no Plaid item has ever been recorded. The credential may be perfectly valid — that is a different question, answered by the open_banking slot — but nothing is linked, so silence from Plaid is correct and there is no funding source to be broken.';
    case 'unread':
      return 'plaid item state could not be read';
  }
}
