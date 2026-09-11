/**
 * Every database statement the hold machinery issues, and nothing else.
 *
 * Two rules hold throughout this file and are worth stating before the code:
 *
 *   1. NOTHING here inserts into `journal_entry` or `journal_line`. Money is
 *      written by `postEntry()` → `ledger_append()` and by nothing else, so
 *      every posting gets the advisory lock, the serialised `booking_seq`, the
 *      monotonic `booking_time`, the hash chain and the idempotent replay.
 *      `corgi_app` legitimately holds INSERT on those tables and the database
 *      would not stop a raw INSERT — the discipline is the guarantee.
 *
 *   2. Nothing here UPDATEs anything. Not because it is polite, but because the
 *      role cannot express it: `hold`, `hold_closure`, `card_authorization`,
 *      `card_auth_event` and `card` are all SELECT+INSERT for `corgi_app`, with
 *      append-only triggers behind that for the owner. Every "change" below is
 *      an INSERT that some unique index may refuse, and a refusal is the
 *      answer, not an error to work around.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";

import {
  financialPostingKey,
  holdPostingKey,
  movesFinancialBook,
  type CardEvent,
  type CardEventKind,
} from "./model";

/** How long a card authorisation lives before the clock releases it. */
export const CARD_AUTH_EXPIRY_DAYS = 7;

/** House account: what we owe the card network for cleared spend. */
export const CARD_SETTLEMENT_CODE = "2200";
/** House account: the other side of every memo entry. */
export const MEMO_CONTRA_CODE = "9900";

export interface CardBinding {
  readonly cardId: string;
  readonly providerCardToken: string;
  readonly businessId: string;
  readonly entityId: string;
  /** The customer's 2100 leaf, financial book. */
  readonly accountId: string;
  /** The customer's 9100 leaf, memo book. */
  readonly memoAccountId: string;
}

export interface AuthorizationIdentity {
  readonly authId: string;
  readonly holdId: string;
  readonly accountId: string;
  readonly memoAccountId: string;
  readonly entityId: string;
  readonly expiresAt: Date;
  readonly origin: string;
}

/**
 * Resolve a provider card token to the customer whose money it spends.
 *
 * Returns `null` for an unknown card. The caller PARKS on that — it does not
 * guess, and it does not open an account. A card we have never registered is
 * either a race with card creation (park and retry) or a card belonging to
 * someone else's program (park, then dead-letter in front of a human). Both are
 * better than posting a stranger's fuel to a customer we happen to have.
 */
export async function resolveCard(
  provider: string,
  providerCardToken: string,
  conn: Sql = sql,
): Promise<CardBinding | null> {
  const [row] = await conn<
    {
      id: string;
      provider_card_token: string;
      business_id: string;
      account_id: string;
      memo_account_id: string;
      entity_id: string;
    }[]
  >`
    SELECT c.id, c.provider_card_token, c.business_id, c.account_id,
           c.memo_account_id, a.entity_id
      FROM card c
      JOIN account a ON a.id = c.account_id
     WHERE c.provider = ${provider}
       AND c.provider_card_token = ${providerCardToken}`;
  if (!row) return null;
  return {
    cardId: row.id,
    providerCardToken: row.provider_card_token,
    businessId: row.business_id,
    entityId: row.entity_id,
    accountId: row.account_id,
    memoAccountId: row.memo_account_id,
  };
}

/**
 * Register a card. Idempotent on `(provider, provider_card_token)`.
 *
 * Used by the card-issuing path and by the tests. It resolves the customer's
 * two leaves by `(code, business_id)` rather than taking them as arguments,
 * because "which account does a card spend from" is a property of the chart,
 * not a decision the caller gets to make.
 */
export async function registerCard(
  args: {
    readonly provider: string;
    readonly providerCardToken: string;
    readonly businessId: string;
    readonly lastFour?: string;
    readonly nickname?: string;
  },
  conn: Sql = sql,
): Promise<CardBinding> {
  await conn`
    INSERT INTO card (provider, provider_card_token, business_id,
                      account_id, memo_account_id, last_four, nickname)
    SELECT ${args.provider}, ${args.providerCardToken}, ${args.businessId}::uuid,
           dep.id, memo.id, ${args.lastFour ?? null}, ${args.nickname ?? null}
      FROM account dep
      JOIN account memo
        ON memo.business_id = dep.business_id AND memo.code = '9100'
     WHERE dep.code = '2100' AND dep.business_id = ${args.businessId}::uuid
    ON CONFLICT (provider, provider_card_token) DO NOTHING`;

  const binding = await resolveCard(args.provider, args.providerCardToken, conn);
  if (!binding) {
    throw new Error(
      `cannot register card ${args.providerCardToken}: business ${args.businessId} has no 2100/9100 account pair`,
    );
  }
  return binding;
}

/**
 * The system actor money posts under. Resolved by name, not hard-coded as a
 * uuid, so a re-seed cannot leave a dangling foreign key in this module.
 */
export async function ledgerPosterActorId(conn: Sql = sql): Promise<string> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'system' AND display_name = 'ledger-poster' LIMIT 1`;
  if (!row) throw new Error("no 'ledger-poster' system actor; run scripts/seed.mjs");
  return row.id;
}

async function houseAccountId(code: string, entityId: string, conn: Sql): Promise<string> {
  const [row] = await conn<{ id: string }[]>`
    SELECT id FROM account
     WHERE code = ${code} AND business_id IS NULL AND entity_id = ${entityId}::uuid
     LIMIT 1`;
  if (!row) throw new Error(`house account ${code} is missing from the chart`);
  return row.id;
}

/**
 * Find, or create, the immutable identity for one provider authorisation.
 *
 * The hold and the authorisation are created together and neither is ever
 * updated. Two workers racing the same unseen authorisation both attempt both
 * inserts; `hold_ref UNIQUE (kind, external_ref)` and
 * `card_auth_provider_key UNIQUE (provider, provider_auth_id)` decide, one
 * loser's `hold` row never exists, and both then read the same identity back.
 * There is no SELECT-then-INSERT window here because the SELECT is not the
 * decision — the unique index is.
 *
 * `origin` is recorded for reporting and NOTHING branches on it. A settlement
 * that beats its authorisation creates the identity with `clearing_first`, and
 * the arithmetic that follows is identical to the in-order case.
 */
export async function ensureAuthorization(
  args: {
    readonly provider: string;
    readonly providerAuthId: string;
    readonly card: CardBinding;
    readonly origin: string;
    readonly valueDate: string;
    readonly expiresAt: Date;
  },
  conn: Sql = sql,
): Promise<AuthorizationIdentity> {
  const externalRef = `${args.provider}:${args.providerAuthId}`;

  await conn`
    INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, expires_at)
    VALUES (${args.card.accountId}::uuid, ${args.card.memoAccountId}::uuid, 'card_auth',
            ${externalRef}, ${args.valueDate}::date, ${args.expiresAt.toISOString()}::timestamptz)
    ON CONFLICT (kind, external_ref) DO NOTHING`;

  await conn`
    INSERT INTO card_authorization (provider, provider_auth_id, card_id, account_id,
                                    hold_id, origin, expires_at)
    SELECT ${args.provider}, ${args.providerAuthId}, ${args.card.cardId}::uuid,
           ${args.card.accountId}::uuid, h.id, ${args.origin},
           ${args.expiresAt.toISOString()}::timestamptz
      FROM hold h
     WHERE h.kind = 'card_auth' AND h.external_ref = ${externalRef}
    ON CONFLICT (provider, provider_auth_id) DO NOTHING`;

  const identity = await findAuthorization(args.provider, args.providerAuthId, conn);
  if (!identity) {
    throw new Error(
      `failed to create the identity for ${args.provider}:${args.providerAuthId}`,
    );
  }
  return identity;
}

export async function findAuthorization(
  provider: string,
  providerAuthId: string,
  conn: Sql = sql,
): Promise<AuthorizationIdentity | null> {
  const [row] = await conn<
    {
      id: string;
      hold_id: string;
      account_id: string;
      memo_account_id: string;
      entity_id: string;
      expires_at: Date;
      origin: string;
    }[]
  >`
    SELECT ca.id, ca.hold_id, ca.account_id, h.memo_account_id,
           a.entity_id, ca.expires_at, ca.origin
      FROM card_authorization ca
      JOIN hold    h ON h.id = ca.hold_id
      JOIN account a ON a.id = ca.account_id
     WHERE ca.provider = ${provider} AND ca.provider_auth_id = ${providerAuthId}`;
  if (!row) return null;
  return {
    authId: row.id,
    holdId: row.hold_id,
    accountId: row.account_id,
    memoAccountId: row.memo_account_id,
    entityId: row.entity_id,
    expiresAt: new Date(row.expires_at),
    origin: row.origin,
  };
}

/**
 * `SELECT ... FROM card_authorization WHERE id = :a FOR UPDATE`, taken through
 * a SECURITY DEFINER function because `corgi_app` deliberately holds no UPDATE
 * privilege and Postgres requires one for `FOR UPDATE` (migration 0008 §2).
 *
 * The lock lives in the CALLER's transaction and is released at its COMMIT, so
 * this must be called inside `conn.begin(...)` or it locks nothing. It is what
 * serialises every processor of one authorisation, which is what turns the
 * hold posting into a compare-and-append rather than a read-then-write race.
 */
export async function lockAuthorization(authId: string, conn: Sql): Promise<boolean> {
  const [row] = await conn<{ locked: boolean }[]>`
    SELECT lock_card_authorization(${authId}::uuid) AS locked`;
  return row?.locked === true;
}

/**
 * Append facts to the event stream. Returns how many were NEW.
 *
 * `ON CONFLICT DO NOTHING` against `UNIQUE (auth_id, provider_event_id)` is the
 * whole of the deduplication story: a redelivered webhook cannot enter `E`, and
 * that is decided by Postgres rather than by an `if` statement in this process.
 * It is also what makes `E` a set rather than a multiset, which is what makes
 * `H(E)` invariant under arrival order.
 */
export async function insertCardEvents(
  authId: string,
  events: readonly CardEvent[],
  inboxId: string | null,
  conn: Sql,
): Promise<number> {
  let inserted = 0;
  for (const event of events) {
    const rows = await conn`
      INSERT INTO card_auth_event (auth_id, kind, amount_cents, is_final,
                                   value_date, provider_event_id, inbox_id)
      VALUES (${authId}::uuid, ${event.kind}::card_event_kind, ${event.amountCents},
              ${event.isFinal}, ${event.valueDate}::date, ${event.providerEventId},
              ${inboxId}::uuid)
      ON CONFLICT (auth_id, provider_event_id) DO NOTHING
      RETURNING id`;
    if (rows.length > 0) inserted += 1;
  }
  return inserted;
}

/** The event SET for one authorisation, read back out of the database. */
export async function loadCardEvents(authId: string, conn: Sql = sql): Promise<CardEvent[]> {
  const rows = await conn<
    {
      kind: CardEventKind;
      amount_cents: bigint;
      is_final: boolean;
      value_date: string;
      provider_event_id: string;
    }[]
  >`
    SELECT kind, amount_cents, is_final, value_date::text AS value_date, provider_event_id
      FROM card_auth_event
     WHERE auth_id = ${authId}::uuid
     ORDER BY received_at, provider_event_id`;
  return rows.map((r) => ({
    kind: r.kind,
    amountCents: r.amount_cents,
    isFinal: r.is_final,
    valueDate: r.value_date,
    providerEventId: r.provider_event_id,
  }));
}

/**
 * The memo book's own answer: how much is currently held, in natural (positive)
 * terms.
 *
 * Restricted to lines hitting the hold's OWN memo account. Summing every line
 * of the hold's entries gives zero, always — `assert_entry_balanced()` applies
 * to the memo book exactly as it does to the financial one, so both legs are in
 * that sum and they cancel. `* normal_side` turns the stored credit into the
 * positive number a human means by "held".
 */
export async function memoHoldBalance(
  holdId: string,
  memoAccountId: string,
  conn: Sql = sql,
): Promise<bigint> {
  const [row] = await conn<{ cents: bigint }[]>`
    SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS cents
      FROM journal_entry e
      JOIN journal_line  l ON l.entry_id = e.id
      JOIN account       a ON a.id = l.account_id
     WHERE e.hold_id = ${holdId}::uuid
       AND l.account_id = ${memoAccountId}::uuid`;
  return row?.cents ?? 0n;
}

/**
 * Close a hold. `PRIMARY KEY (hold_id)` makes this exactly-once BY
 * CONSTRUCTION: there is no second row to write, so there is no flag anyone can
 * set twice and no counter anyone can double-increment.
 *
 * Returns true if this call was the one that closed it.
 *
 * The order matters and is the crash-safety argument in one line: the closure
 * lands BEFORE the release posting, and `availableBalance()` reads "released"
 * as this row existing. So if the process dies between the two, the customer's
 * available balance is already correct and the posting is bookkeeping that
 * lands on the next event or on the expiry sweep.
 */
export async function closeHold(
  holdId: string,
  reason: string,
  actorId: string,
  conn: Sql,
): Promise<boolean> {
  const rows = await conn`
    INSERT INTO hold_closure (hold_id, reason, actor_id)
    VALUES (${holdId}::uuid, ${reason}, ${actorId}::uuid)
    ON CONFLICT (hold_id) DO NOTHING
    RETURNING hold_id`;
  return rows.length > 0;
}

export async function isHoldClosed(holdId: string, conn: Sql = sql): Promise<boolean> {
  const [row] = await conn<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM hold_closure WHERE hold_id = ${holdId}::uuid`;
  return (row?.n ?? 0n) > 0n;
}

/**
 * Move the memo book by `deltaCents`, in natural terms: positive opens or grows
 * the hold, negative releases it.
 *
 * Two lines, memo book, never the financial one: credit the customer's 9100
 * leaf, debit 9900 memo contra. The 9100 leaf is credit-normal, so a POSITIVE
 * delta is a NEGATIVE `amount_cents` on that line. Getting that inversion wrong
 * is the classic error and it is why the sign lives in exactly this one place.
 *
 * A zero delta posts nothing at all — not a zero entry, which the schema
 * forbids, and not an empty one. `Δ = 0` is the answer for a replay, and the
 * answer for the loser of a race, and in both cases the right amount of
 * bookkeeping is none.
 */
export async function postHoldDelta(
  args: {
    readonly identity: AuthorizationIdentity;
    readonly deltaCents: bigint;
    readonly valueDate: string;
    readonly providerEventId: string;
    readonly description: string;
    readonly actorId: string;
    readonly externalRef: string;
    readonly inboxId: string | null;
  },
  conn: Sql,
): Promise<string | null> {
  if (args.deltaCents === 0n) return null;

  const contraId = await houseAccountId(MEMO_CONTRA_CODE, args.identity.entityId, conn);

  return postEntry(
    {
      entityId: args.identity.entityId,
      valueDate: args.valueDate,
      book: "memo",
      description: args.description,
      idempotencyKey: holdPostingKey(args.identity.holdId, args.providerEventId),
      actorId: args.actorId,
      rail: "card",
      externalRef: args.externalRef,
      holdId: args.identity.holdId,
      ...(args.inboxId !== null ? { inboxId: args.inboxId } : {}),
      lines: [
        // Credit the customer's hold account: more held is a bigger obligation.
        { accountId: args.identity.memoAccountId, amountCents: -args.deltaCents },
        // Debit the contra, so the memo book nets to zero on its own.
        { accountId: contraId, amountCents: args.deltaCents },
      ],
    },
    conn,
  );
}

/**
 * The FINANCIAL entry for a card event that actually moves money.
 *
 * A capture debits the customer's deposit account — a liability of the bank, so
 * a debit REDUCES what we owe them — and credits 2200, what we now owe the
 * network until the settlement window funds. A refund is the same entry with
 * the signs swapped.
 *
 * Authorisations, incrementals, reversals and expiries never reach this
 * function. That separation is structural rather than a rule someone has to
 * remember: "the ledger balance does not move on an authorisation" is true
 * because there is no code path from an authorisation to a financial posting.
 */
export async function postCardMovement(
  args: {
    readonly identity: AuthorizationIdentity;
    readonly event: CardEvent;
    readonly actorId: string;
    readonly externalRef: string;
    readonly inboxId: string | null;
  },
  conn: Sql,
): Promise<string | null> {
  const { event } = args;
  if (!movesFinancialBook(event.kind)) return null;
  if (event.amountCents === 0n) return null;

  const settlementId = await houseAccountId(
    CARD_SETTLEMENT_CODE,
    args.identity.entityId,
    conn,
  );

  // A refund moves money towards the customer; everything else moves it away.
  const customerDebit = event.kind === "refund" ? -event.amountCents : event.amountCents;

  return postEntry(
    {
      entityId: args.identity.entityId,
      valueDate: event.valueDate,
      book: "financial",
      description:
        event.kind === "refund"
          ? `Card refund ${args.externalRef}`
          : `Card ${event.kind.replace("_", " ")} ${args.externalRef}`,
      idempotencyKey: financialPostingKey(event.kind, event.providerEventId),
      actorId: args.actorId,
      rail: "card",
      externalRef: args.externalRef,
      ...(args.inboxId !== null ? { inboxId: args.inboxId } : {}),
      lines: [
        { accountId: args.identity.accountId, amountCents: customerDebit },
        { accountId: settlementId, amountCents: -customerDebit },
      ],
    },
    conn,
  );
}

/** Authorisations whose clock has run out and whose hold has not been closed. */
export async function findExpiredAuthorizations(
  now: Date,
  limit: number,
  conn: Sql = sql,
): Promise<AuthorizationIdentity[]> {
  const rows = await conn<
    {
      id: string;
      hold_id: string;
      account_id: string;
      memo_account_id: string;
      entity_id: string;
      expires_at: Date;
      origin: string;
    }[]
  >`
    SELECT ca.id, ca.hold_id, ca.account_id, h.memo_account_id,
           a.entity_id, ca.expires_at, ca.origin
      FROM card_authorization ca
      JOIN hold    h ON h.id = ca.hold_id
      JOIN account a ON a.id = ca.account_id
     WHERE ca.expires_at <= ${now.toISOString()}::timestamptz
       -- A hold whose closure was reversed is OPEN again, so the expiry
       -- sweeper must be able to see it. Otherwise a wrong closure, once
       -- corrected, leaves a hold nothing will ever close. See migration 0011.
       AND NOT EXISTS (
             SELECT 1 FROM hold_closure hc
              WHERE hc.hold_id = ca.hold_id
                AND NOT EXISTS (
                      SELECT 1 FROM hold_closure_reversal hr WHERE hr.hold_id = hc.hold_id
                    ))
     ORDER BY ca.expires_at
     LIMIT ${limit}`;
  return rows.map((row) => ({
    authId: row.id,
    holdId: row.hold_id,
    accountId: row.account_id,
    memoAccountId: row.memo_account_id,
    entityId: row.entity_id,
    expiresAt: new Date(row.expires_at),
    origin: row.origin,
  }));
}
