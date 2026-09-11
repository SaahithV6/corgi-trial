import "server-only";

/**
 * The live reads behind the card & hold console.
 *
 * Everything here is a SELECT. Not one statement in this file writes: the
 * console's writes go through the server actions in
 * `src/app/(app)/accounts/actions.ts`, which call the provider and then let the
 * existing webhook pipeline post the money. This module's only job is to show
 * what that pipeline did.
 *
 * The queries themselves are borrowed rather than rewritten. `listHoldRows()`
 * already computes A(E), C(E) and H(E) in SQL that `v_hold_drift` polices, and
 * `availableBalance()` already computes `ledger − holds − uncleared` the way
 * the live-fire suite asserts it. Re-deriving either here would give the screen
 * a second opinion, and a screen with a second opinion eventually contradicts
 * the ledger it is supposed to explain.
 */

import { fail, ok, type ErrorShape, type Result } from "@/lib/result";
import { availableBalance } from "@/lib/ledger/balances";
import {
  ledgerConnection,
  listHoldRows,
  readSnapshot,
  type Sql,
} from "@/lib/ledger/queries";
import { holdState, type CardEvent, type CardEventKind } from "@/lib/holds";
import type { HoldKindRow } from "@/lib/ledger/queries";

import { isUuid } from "./console-state";

import type {
  ConsoleBalances,
  ConsoleBusiness,
  ConsoleCard,
  ConsoleHold,
  ConsoleSnapshot,
  HoldDetail,
  HoldEventRow,
} from "./contract";

/** How many cards the console lists. The account has hundreds; a demo needs a page. */
export const CARD_PAGE_SIZE = 8;

/**
 * A read that threw.
 *
 * The message is the thrown one, truncated. That is a deliberate departure
 * from "never show provider text": this console is an operator tool on a
 * demo estate, and "relation card does not exist" is the sentence that ends
 * the investigation. Nothing here interpolates a secret.
 */
function readFailure(where: string, thrown: unknown): Result<never, ErrorShape> {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return fail(
    "LEDGER_READ_FAILED",
    `${where} could not be read: ${message.slice(0, 220)}`,
    { retryable: true, source: `accounts.console.${where}` },
  );
}

/* -------------------------------------------------------------------------- */
/* Businesses                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every business the console can operate on.
 *
 * The predicate is "has both leaves of the chart" — a 2100 deposit account and
 * a 9100 memo account — because that pair is exactly what `registerCard()`
 * needs and exactly what a hold needs somewhere to live. A business without
 * both cannot be given a card, so offering it in the selector would be an
 * invitation to a refusal.
 *
 * Ordered by most recent card activity so the default lands where the work is,
 * with legal name as the tie-break so the order is total and stable.
 */
export async function listConsoleBusinesses(
  conn: Sql,
): Promise<readonly ConsoleBusiness[]> {
  const rows = await conn<
    {
      business_id: string;
      legal_name: string;
      account_id: string;
      account_name: string;
      currency: string;
      card_count: string | number | bigint;
      last_card_at: Date | null;
    }[]
  >`
    SELECT dep.business_id                                   AS business_id,
           b.legal_name                                      AS legal_name,
           dep.id                                            AS account_id,
           dep.name                                          AS account_name,
           dep.currency                                      AS currency,
           (SELECT count(*) FROM card c WHERE c.business_id = dep.business_id)
                                                             AS card_count,
           (SELECT max(c.created_at) FROM card c WHERE c.business_id = dep.business_id)
                                                             AS last_card_at
      FROM account dep
      JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
      JOIN business b   ON b.id = dep.business_id
     WHERE dep.code = '2100'
       AND dep.book = 'financial'
       AND dep.business_id IS NOT NULL
       AND dep.closed_at IS NULL
     ORDER BY last_card_at DESC NULLS LAST, b.legal_name`;

  return rows.map((row) => ({
    businessId: row.business_id,
    legalName: row.legal_name,
    accountId: row.account_id,
    accountName: row.account_name,
    currency: row.currency,
    cardCount: Number(row.card_count),
  }));
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Registered cards for a business, newest first.
 *
 * `provider_card_token` and `last_four` and nothing else — the `card` table has
 * no PAN column and this console never asks for one. The PAN is fetched from
 * Lithic at the instant a simulation needs it and is never written down; see
 * the header of `actions.ts`.
 */
export async function listConsoleCards(
  businessId: string,
  limit: number,
  conn: Sql,
): Promise<readonly ConsoleCard[]> {
  const rows = await conn<
    {
      id: string;
      provider_card_token: string;
      last_four: string | null;
      nickname: string | null;
      created_at: Date;
    }[]
  >`
    SELECT id, provider_card_token, last_four, nickname, created_at
      FROM card
     WHERE business_id = ${businessId}::uuid
       AND provider = 'lithic'
     ORDER BY created_at DESC
     LIMIT ${limit}`;

  return rows.map((row) => ({
    cardId: row.id,
    providerCardToken: row.provider_card_token,
    lastFour: row.last_four,
    nickname: row.nickname,
    createdAt: row.created_at.toISOString(),
  }));
}

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

/** Which provider transaction, if any, is behind each hold on this account. */
async function providerAuthIds(
  accountId: string,
  conn: Sql,
): Promise<ReadonlyMap<string, string>> {
  const rows = await conn<{ hold_id: string; provider_auth_id: string }[]>`
    SELECT ca.hold_id, ca.provider_auth_id
      FROM card_authorization ca
      JOIN hold h ON h.id = ca.hold_id
     WHERE h.account_id = ${accountId}::uuid`;
  return new Map(rows.map((row) => [row.hold_id, row.provider_auth_id]));
}

/**
 * Holds whose `hold_closure` row has been un-written by a
 * `hold_closure_reversal`.
 *
 * Read separately because the two functions this screen folds together do not
 * agree about them. `availableBalance()` checks the reversal and keeps
 * withholding the money; `listHoldRows()` treats any closure row as final and
 * reports `H = 0`. That is a real disagreement between two library functions
 * over real money — three holds in this database are in exactly that state,
 * carrying $60.00 between them (migration 0011) — and the console's job is to
 * name it on the row rather than average it away.
 */
async function reversedClosures(
  accountId: string,
  conn: Sql,
): Promise<ReadonlySet<string>> {
  const rows = await conn<{ hold_id: string }[]>`
    SELECT hc.hold_id
      FROM hold_closure hc
      JOIN hold h ON h.id = hc.hold_id
     WHERE h.account_id = ${accountId}::uuid
       AND EXISTS (SELECT 1 FROM hold_closure_reversal r WHERE r.hold_id = hc.hold_id)`;
  return new Set(rows.map((row) => row.hold_id));
}

/**
 * The whole console for one business, folded as of one instant.
 *
 * The balances come from `availableBalance()` — the function the live-fire
 * suite asserts against — and the itemisation comes from `listHoldRows()`. The
 * two are separate queries answering related questions, so the fold of the
 * second is carried alongside for the screen to compare. Where they disagree
 * the screen reports both; it does not pick one and it does not average them.
 */
export async function loadConsoleSnapshot(
  business: ConsoleBusiness,
  conn: Sql,
): Promise<ConsoleSnapshot> {
  const snapshot = await readSnapshot(conn);

  const [balances, holdRows, cards, authIds, reversed] = await Promise.all([
    availableBalance(business.businessId, conn),
    listHoldRows(business.accountId, snapshot, conn),
    listConsoleCards(business.businessId, CARD_PAGE_SIZE, conn),
    providerAuthIds(business.accountId, conn),
    reversedClosures(business.accountId, conn),
  ]);

  const holds: ConsoleHold[] = holdRows.map((row) => ({
    holdId: row.holdId,
    kind: row.kind,
    descriptor: row.descriptor,
    externalRef: row.externalRef,
    providerAuthId: authIds.get(row.holdId) ?? null,
    authorisedCents: row.authorisedCents,
    clearedCents: row.clearedCents,
    remainingCents: row.remainingCents,
    memoBalanceCents: row.memoBalanceCents,
    closed: row.closed,
    closedReason: row.closedReason,
    closureReversed: reversed.has(row.holdId),
    placedAt: row.placedAt.toISOString(),
    expiresAt: row.expiresAt === null ? null : row.expiresAt.toISOString(),
    eventCount: row.eventCount,
  }));

  let foldedCardHoldsCents = 0n;
  for (const hold of holds) {
    if (hold.kind === "card_auth") foldedCardHoldsCents += hold.remainingCents;
  }

  const consoleBalances: ConsoleBalances = {
    ledgerCents: balances.ledgerCents,
    holdsCents: balances.holdsCents,
    unclearedCents: balances.unclearedCents,
    pendingOutboundCents: balances.pendingOutboundCents,
    availableCents: balances.availableCents,
  };

  return {
    business,
    balances: consoleBalances,
    cards,
    holds,
    asOf: snapshot.asOf.toISOString(),
    bookingWatermark: snapshot.bookingWatermark,
    foldedCardHoldsCents,
  };
}

export type ConsoleData = {
  readonly businesses: readonly ConsoleBusiness[];
  /** `null` when no business on the book has both leaves of the chart. */
  readonly snapshot: ConsoleSnapshot | null;
};

/**
 * The live console.
 *
 * `businessId` is a REFERENCE out of the query string and is never trusted for
 * anything but selection: it is matched against the list this function just
 * read, and an id that is not in that list falls back to the default rather
 * than reaching a query.
 */
export async function loadConsole(
  businessId: string | null,
): Promise<Result<ConsoleData, ErrorShape>> {
  try {
    const conn = await ledgerConnection();
    const businesses = await listConsoleBusinesses(conn);

    const chosen =
      (businessId === null
        ? undefined
        : businesses.find((b) => b.businessId === businessId)) ?? businesses[0];

    if (chosen === undefined) return ok({ businesses, snapshot: null });

    return ok({ businesses, snapshot: await loadConsoleSnapshot(chosen, conn) });
  } catch (thrown) {
    return readFailure("console", thrown);
  }
}

/** Just the five figures, for an action that wants a before and an after. */
export async function readBalances(
  businessId: string,
): Promise<ConsoleBalances> {
  const conn = await ledgerConnection();
  const balances = await availableBalance(businessId, conn);
  return {
    ledgerCents: balances.ledgerCents,
    holdsCents: balances.holdsCents,
    unclearedCents: balances.unclearedCents,
    pendingOutboundCents: balances.pendingOutboundCents,
    availableCents: balances.availableCents,
  };
}

/* -------------------------------------------------------------------------- */
/* The drill-down                                                             */
/* -------------------------------------------------------------------------- */

type HoldHeadRow = {
  hold_id: string;
  kind: HoldKindRow;
  external_ref: string;
  created_at: Date;
  expires_at: Date | null;
  memo_account_id: string;
  account_id: string;
  business_id: string;
  legal_name: string;
  descriptor: string | null;
  provider: string | null;
  provider_auth_id: string | null;
  origin: string | null;
  auth_expires_at: Date | null;
  first_seen_at: Date | null;
  closure_reason: string | null;
  closed_at: Date | null;
  memo_cents: bigint;
};

/**
 * One hold, its event set, and the fold that produces `H(E)`.
 *
 * The running totals are produced by calling `holdState()` on each PREFIX of
 * the set rather than by re-implementing the sums here. That is slightly
 * wasteful and entirely the point: what the screen prints is the model
 * executing, not a second copy of the model that could drift from it.
 *
 * `H` is a function of a SET, so the row order below is a presentational
 * choice and nothing more. Sorting by anything else would change every running
 * total and change none of the final answers — which is the property, and the
 * page says so.
 */
export async function loadHoldDetail(
  holdId: string,
): Promise<Result<HoldDetail | null, ErrorShape>> {
  if (!isUuid(holdId)) return ok(null);

  try {
    const conn = await ledgerConnection();

    const [head] = await conn<HoldHeadRow[]>`
      SELECT h.id                AS hold_id,
             h.kind              AS kind,
             h.external_ref      AS external_ref,
             h.created_at        AS created_at,
             h.expires_at        AS expires_at,
             h.memo_account_id   AS memo_account_id,
             h.account_id        AS account_id,
             a.business_id       AS business_id,
             b.legal_name        AS legal_name,
             (SELECT e.description FROM journal_entry e
               WHERE e.hold_id = h.id ORDER BY e.booking_seq LIMIT 1) AS descriptor,
             ca.provider         AS provider,
             ca.provider_auth_id AS provider_auth_id,
             ca.origin           AS origin,
             ca.expires_at       AS auth_expires_at,
             ca.first_seen_at    AS first_seen_at,
             -- A closure row that has been reversed is not a closure. Migration
             -- 0011: three holds carried a closure whose authorisation was
             -- never reversed, and un-writing an append-only row is an append.
             (SELECT hc.reason FROM hold_closure hc
               WHERE hc.hold_id = h.id
                 AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal r
                                  WHERE r.hold_id = hc.hold_id))       AS closure_reason,
             (SELECT hc.closed_at FROM hold_closure hc
               WHERE hc.hold_id = h.id
                 AND NOT EXISTS (SELECT 1 FROM hold_closure_reversal r
                                  WHERE r.hold_id = hc.hold_id))       AS closed_at,
             COALESCE((SELECT SUM(l.amount_cents * ac.normal_side)
                         FROM journal_entry e
                         JOIN journal_line  l  ON l.entry_id = e.id
                         JOIN account       ac ON ac.id = l.account_id
                        WHERE e.hold_id = h.id
                          AND l.account_id = h.memo_account_id), 0)::bigint
                                                                       AS memo_cents
        FROM hold h
        JOIN account  a ON a.id = h.account_id
        JOIN business b ON b.id = a.business_id
        LEFT JOIN card_authorization ca ON ca.hold_id = h.id
       WHERE h.id = ${holdId}::uuid`;

    if (head === undefined) return ok(null);

    const eventRows = await conn<
      {
        kind: CardEventKind;
        amount_cents: bigint;
        is_final: boolean;
        value_date: string;
        provider_event_id: string;
        received_at: Date;
      }[]
    >`
      SELECT ev.kind, ev.amount_cents, ev.is_final,
             ev.value_date::text AS value_date, ev.provider_event_id, ev.received_at
        FROM card_auth_event ev
        JOIN card_authorization ca ON ca.id = ev.auth_id
       WHERE ca.hold_id = ${holdId}::uuid
       ORDER BY ev.received_at, ev.provider_event_id`;

    const events: CardEvent[] = eventRows.map((row) => ({
      kind: row.kind,
      amountCents: row.amount_cents,
      isFinal: row.is_final,
      valueDate: row.value_date,
      providerEventId: row.provider_event_id,
    }));

    const now = new Date();
    // A non-card hold has no authorisation and therefore no expiry clock. The
    // far-future sentinel keeps `expired` false for it rather than inventing a
    // deadline the model would then act on.
    const expiresAt =
      head.auth_expires_at ?? head.expires_at ?? new Date(now.getTime() + 3_153_600_000_000);
    const clock = { expiresAt, now };

    const rows: HoldEventRow[] = events.map((event, index) => {
      const prefix = holdState(events.slice(0, index + 1), clock);
      const source = eventRows[index];
      return {
        providerEventId: event.providerEventId,
        kind: event.kind,
        amountCents: event.amountCents,
        isFinal: event.isFinal,
        valueDate: event.valueDate,
        receivedAt: (source?.received_at ?? now).toISOString(),
        runningAuthorisedCents: prefix.authorisedCents,
        runningCapturedCents: prefix.capturedCents,
        runningHoldCents: prefix.holdCents,
      };
    });

    return ok({
      holdId: head.hold_id,
      kind: head.kind,
      descriptor: head.descriptor ?? head.external_ref,
      externalRef: head.external_ref,
      accountId: head.account_id,
      businessId: head.business_id,
      businessName: head.legal_name,
      provider: head.provider,
      providerAuthId: head.provider_auth_id,
      origin: head.origin,
      placedAt: head.created_at.toISOString(),
      expiresAt: expiresAt.toISOString(),
      firstSeenAt: head.first_seen_at === null ? null : head.first_seen_at.toISOString(),
      closureRow:
        head.closure_reason === null || head.closed_at === null
          ? null
          : { reason: head.closure_reason, closedAt: head.closed_at.toISOString() },
      events: rows,
      state: holdState(events, clock),
      memoBalanceCents: head.memo_cents,
      evaluatedAt: now.toISOString(),
    });
  } catch (thrown) {
    return readFailure("hold", thrown);
  }
}
