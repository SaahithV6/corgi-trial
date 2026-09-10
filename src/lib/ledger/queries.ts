import "server-only";

import type { Sql } from "./db";

/**
 * Re-exported so the adapter above this layer can name a connection without
 * importing `src/lib/ledger/db` — which `data-contract.ts` forbids anything
 * under `src/components/**` from doing. It is a type, so it is erased.
 */
export type { Sql };

/**
 * Read-only query helpers for the account screen.
 *
 * ---------------------------------------------------------------------------
 * What this module is
 * ---------------------------------------------------------------------------
 *
 * The three questions the account screen asks the journal, and nothing else:
 * what is this account, what is it worth, and what happened to it. Every one
 * of them is a SUM over immutable rows — there is no balance column in this
 * schema and this module does not create one. `research/ledger/queries.draft.sql`
 * is the source these are cut down from; §1 is `ledgerBalanceCents`, §2 is
 * `listHoldRows`, and the statement query in §4b is the shape of
 * `listPostingRows`.
 *
 * ---------------------------------------------------------------------------
 * Money is `bigint` here, and only here
 * ---------------------------------------------------------------------------
 *
 * `src/lib/ledger/db.ts` parses every `int8` into a JS `bigint` precisely so a
 * cent count cannot silently lose precision on the way out of Postgres. That
 * type survives all the way to the edge of this module: everything below
 * returns `bigint`, and the narrowing to the contract's `number` cents happens
 * once, at the boundary, in `src/components/account/live-data-source.ts`,
 * where it is asserted to be a safe integer.
 *
 * ---------------------------------------------------------------------------
 * Two bugs that have already been paid for once (see `balances.ts`)
 * ---------------------------------------------------------------------------
 *
 * 1. **The `hold` table has no `business_id`.** Tenancy is reached through
 *    `hold.account_id`, which is the customer's deposit account. Every query
 *    here is scoped by that column directly; nothing joins a column that does
 *    not exist and quietly returns zero rows.
 *
 * 2. **Summing every line of a hold's memo entries gives zero, always.**
 *    `assert_entry_balanced()` applies to the memo book exactly as it does to
 *    the financial book, so both legs of a memo entry — the customer's
 *    9100/9200 leaf and the 9900 contra — are in that sum and they cancel. The
 *    hold is one SIDE of that entry, so `listHoldRows` and `listPostingRows`
 *    both restrict the memo sum to `l.account_id = h.memo_account_id`.
 *
 * Both bugs produced a silent zero rather than an error, which is the class of
 * bug this file is most exposed to: an availability query that under-reports a
 * hold frees money that is still authorised.
 *
 * ---------------------------------------------------------------------------
 * The provider's opinion is not an input
 * ---------------------------------------------------------------------------
 *
 * `listHoldRows` derives A(E), C(E) and H(E) from `card_auth_event` and the
 * memo book. It reads no provider status field, because there is not one to
 * read: DECISIONS 006 measured Lithic reporting `SETTLED` while $4.00 of a
 * $10.00 authorisation was still live, so `card_authorization` deliberately
 * has no status column. A hold's size is a function of the event SET; its
 * closure is a predicate over that set, a clock, and a `hold_closure` row.
 */

/* -------------------------------------------------------------------------- */
/* The connection                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The application's pooled handle, resolved lazily.
 *
 * `import type { Sql }` above is erased at compile time and the import below
 * only runs when a caller asks for the default connection, so importing this
 * module does not open a socket and does not require `APP_DATABASE_URL` to be
 * set. That is what lets the tests exercise every query against a fake `Sql`
 * in an environment that holds no credentials — which is exactly the
 * environment CI runs in, deliberately.
 */
export async function ledgerConnection(): Promise<Sql> {
  const { sql } = await import("./db");
  return sql;
}

/* -------------------------------------------------------------------------- */
/* The snapshot                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One instant, one watermark, one business day — taken once and passed into
 * every other query in this module.
 *
 * The data contract requires the three reads to be consistent as of a single
 * instant, so that the summary's ledger balance is a fold over exactly the
 * postings the screen lists and no others. Three queries each calling `now()`
 * would drift by however long the round trips took, and an entry booked in
 * that window would appear in one answer and not the other.
 *
 * `valueDate` comes from the database's own `book_date()`, so the business day
 * boundary is the Fed/ACH one (America/New_York) rather than the server's
 * locale, and there is one definition of it rather than two.
 */
export interface LedgerSnapshot {
  /** Wall clock at the moment the snapshot was taken (transaction time). */
  readonly asOf: Date;
  /** Today in book time, `YYYY-MM-DD`. The value axis of §5. */
  readonly valueDate: string;
  /** The highest `booking_seq` recorded by `asOf`. The booking axis of §5. */
  readonly bookingWatermark: bigint;
}

export async function readSnapshot(conn: Sql): Promise<LedgerSnapshot> {
  const rows = await conn<
    { as_of: Date; value_date: string; booking_watermark: bigint }[]
  >`
    SELECT now()                                           AS as_of,
           to_char(book_date(now()), 'YYYY-MM-DD')         AS value_date,
           COALESCE((SELECT MAX(e.booking_seq)
                       FROM journal_entry e
                      WHERE e.booking_time <= now()), 0)::bigint
                                                           AS booking_watermark`;

  const row = rows[0];
  if (row === undefined) {
    throw new Error("snapshot query returned no row");
  }
  return {
    asOf: row.as_of,
    valueDate: row.value_date,
    bookingWatermark: row.booking_watermark,
  };
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A customer deposit account, as the screen's header needs it.
 *
 * `2100` with a non-null `business_id` is the whole definition of "a
 * customer's money" (see `chart.ts`): the bare code is the control account and
 * is not postable, and the customer is identified by `business_id` rather than
 * by a qualified code in the `code` column.
 */
export interface DepositAccountRow {
  readonly accountId: string;
  readonly businessId: string;
  /** `account.name`, e.g. `Ridgeline Robotics, Inc. — business current account`. */
  readonly accountName: string;
  readonly legalName: string;
  readonly currency: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a string could be an account id. Guards the `::uuid` casts below. */
export function isAccountId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * One deposit account by id, or `null`.
 *
 * A non-uuid id — a fixture id such as `acct_operating_4417`, or a typo —
 * returns `null` rather than reaching Postgres and raising `22P02`. "No such
 * account" is an answer, not a failure, and the screen renders it as one.
 */
export async function findDepositAccount(
  accountId: string,
  conn: Sql,
): Promise<DepositAccountRow | null> {
  if (!isAccountId(accountId)) return null;

  const rows = await conn<
    {
      account_id: string;
      business_id: string;
      account_name: string;
      legal_name: string;
      currency: string;
    }[]
  >`
    SELECT a.id          AS account_id,
           a.business_id AS business_id,
           a.name        AS account_name,
           b.legal_name  AS legal_name,
           a.currency    AS currency
      FROM account a
      JOIN business b ON b.id = a.business_id
     WHERE a.id = ${accountId}::uuid
       AND a.code = '2100'
       AND a.book = 'financial'
       AND a.business_id IS NOT NULL`;

  return rows[0] === undefined
    ? null
    : {
        accountId: rows[0].account_id,
        businessId: rows[0].business_id,
        accountName: rows[0].account_name,
        legalName: rows[0].legal_name,
        currency: rows[0].currency,
      };
}

/** Every open customer deposit account, for the directory page. */
export async function listDepositAccounts(
  conn: Sql,
): Promise<readonly DepositAccountRow[]> {
  const rows = await conn<
    {
      account_id: string;
      business_id: string;
      account_name: string;
      legal_name: string;
      currency: string;
    }[]
  >`
    SELECT a.id          AS account_id,
           a.business_id AS business_id,
           a.name        AS account_name,
           b.legal_name  AS legal_name,
           a.currency    AS currency
      FROM account a
      JOIN business b ON b.id = a.business_id
     WHERE a.code = '2100'
       AND a.book = 'financial'
       AND a.business_id IS NOT NULL
       AND a.closed_at IS NULL
     ORDER BY b.legal_name, a.name`;

  return rows.map((row) => ({
    accountId: row.account_id,
    businessId: row.business_id,
    accountName: row.account_name,
    legalName: row.legal_name,
    currency: row.currency,
  }));
}

/* -------------------------------------------------------------------------- */
/* 1. Ledger balance                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The settled position: `Σ amount_cents × normal_side` over the account's
 * lines, on both axes of §5 at once.
 *
 * `value_date <= snapshot.valueDate` excludes future-dated entries — a
 * settlement booked today for tomorrow's business day is a fact we know and
 * not money the customer has — and `booking_seq <= snapshot.bookingWatermark`
 * pins what we had learned when the snapshot was taken.
 *
 * The `LEFT JOIN` from `account` is not decoration: an account with no lines
 * at all must return `0`, and an inner join would return no row and leave the
 * caller to guess whether that meant zero or missing.
 */
export async function ledgerBalanceCents(
  accountId: string,
  snapshot: LedgerSnapshot,
  conn: Sql,
): Promise<bigint> {
  const rows = await conn<{ balance_cents: bigint }[]>`
    SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side AS balance_cents
      FROM account a
      LEFT JOIN journal_line l
             ON l.account_id  = a.id
            AND l.value_date  <= ${snapshot.valueDate}::date
            AND l.booking_seq <= ${snapshot.bookingWatermark}
     WHERE a.id = ${accountId}::uuid
     GROUP BY a.normal_side`;

  return rows[0]?.balance_cents ?? 0n;
}

/* -------------------------------------------------------------------------- */
/* 2. Holds                                                                   */
/* -------------------------------------------------------------------------- */

export type HoldKindRow = "card_auth" | "uncleared_credit" | "manual";

/**
 * One hold with the terms of `H(E) = 0 if closed(E) else max(A(E) − C(E), 0)`
 * exposed separately, so the screen can show an operator the arithmetic rather
 * than a conclusion.
 */
export interface HoldRow {
  readonly holdId: string;
  readonly kind: HoldKindRow;
  /** The opening memo entry's description, falling back to the provider ref. */
  readonly descriptor: string;
  readonly externalRef: string;
  /** A(E): authorisations + increments − reversals. May be negative. */
  readonly authorisedCents: bigint;
  /** C(E): clearings + force posts. May exceed A(E) — that is over-capture. */
  readonly clearedCents: bigint;
  /** H(E): what is actually withheld from available. Never negative. */
  readonly remainingCents: bigint;
  /** What the memo book says this hold is worth right now. Provenance. */
  readonly memoBalanceCents: bigint;
  readonly closed: boolean;
  /** Which limb of `closed(E)` fired, for display. `null` when it is open. */
  readonly closedReason: HoldClosedReason | null;
  readonly placedAt: Date;
  readonly expiresAt: Date | null;
  readonly availableAt: Date | null;
  /** The `funds_availability_policy` row this hold was created under (§10.1). */
  readonly policy: HoldPolicyRow | null;
  /** How many `card_authorization` rows back this hold. 0 for non-card holds. */
  readonly authCount: number;
  /** How many `card_auth_event` rows the terms above were folded from. */
  readonly eventCount: number;
}

export type HoldClosedReason =
  | "closure_row"
  | "network_final"
  | "close_event"
  | "expired"
  | "fully_reversed"
  | "funds_available";

export interface HoldPolicyRow {
  readonly rail: string;
  readonly counterpartyClass: string;
  readonly bankingDaysHold: number;
  readonly releaseLocalTime: string;
}

/**
 * Every hold on an account, active first, with its arithmetic.
 *
 * Five CTEs, and each one is a different question:
 *
 *   `held`  — the holds themselves, and whether a `hold_closure` row exists.
 *             Closure is a PRIMARY KEY existence check, which is what makes
 *             release exactly-once by construction rather than by a flag.
 *   `memo`  — what the memo book says the hold is worth. Restricted to the
 *             hold's OWN memo account; see the note at the top of this file.
 *   `fold`  — A(E) and C(E), folded over `card_auth_event`. Never a status.
 *   `first` — the opening memo entry, for a descriptor an operator recognises.
 *   `state` — `closed(E)`, and which limb of it fired.
 *
 * The final SELECT is then the formula itself and nothing else.
 *
 * Non-card holds have no event stream, so A(E) is the memo balance and C(E) is
 * zero: an uncleared credit or a manual hold is worth what was posted to it
 * until something releases it. A card hold with no `card_authorization` row
 * behind it takes the same fallback rather than reporting `authorised = 0`,
 * because a zero there would silently stop withholding real money.
 */
export async function listHoldRows(
  accountId: string,
  snapshot: LedgerSnapshot,
  conn: Sql,
): Promise<readonly HoldRow[]> {
  if (!isAccountId(accountId)) return [];

  const rows = await conn<
    {
      hold_id: string;
      kind: HoldKindRow;
      descriptor: string;
      external_ref: string;
      authorised_cents: bigint;
      cleared_cents: bigint;
      remaining_cents: bigint;
      memo_cents: bigint;
      closed: boolean;
      closed_reason: HoldClosedReason | null;
      placed_at: Date;
      expires_at: Date | null;
      available_at: Date | null;
      policy_rail: string | null;
      policy_counterparty_class: string | null;
      policy_banking_days: number | null;
      policy_release_time: string | null;
      auth_count: string | number | bigint;
      event_count: string | number | bigint;
    }[]
  >`
    WITH held AS (
      SELECT h.id, h.kind, h.external_ref, h.created_at, h.expires_at,
             h.available_at, h.memo_account_id, h.policy_id,
             EXISTS (SELECT 1 FROM hold_closure hc WHERE hc.hold_id = h.id) AS has_closure
        FROM hold h
       WHERE h.account_id = ${accountId}::uuid
    ),
    memo AS (
      -- The hold is ONE SIDE of a balanced memo entry. Summing every line of
      -- its entries would include the 9900 contra leg and always yield zero.
      SELECT held.id AS hold_id,
             COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS memo_cents
        FROM held
        LEFT JOIN journal_entry e ON e.hold_id = held.id
                                 AND e.booking_seq <= ${snapshot.bookingWatermark}
        LEFT JOIN journal_line  l ON l.entry_id = e.id
                                 AND l.account_id = held.memo_account_id
        LEFT JOIN account       a ON a.id = l.account_id
       GROUP BY held.id
    ),
    fold AS (
      -- A(E) and C(E) over the event SET, which is what makes the answer
      -- independent of arrival order and immune to a replayed delivery.
      SELECT held.id AS hold_id,
             count(DISTINCT ca.id)                                            AS auth_count,
             count(ev.id)                                                     AS event_count,
             COALESCE(SUM(ev.amount_cents) FILTER (
               WHERE ev.kind IN ('authorization','incremental_authorization')), 0)::bigint
           - COALESCE(SUM(ev.amount_cents) FILTER (
               WHERE ev.kind = 'authorization_reversal'), 0)::bigint           AS auth_net_cents,
             COALESCE(SUM(ev.amount_cents) FILTER (
               WHERE ev.kind IN ('clearing','force_post')), 0)::bigint         AS captured_cents,
             COALESCE(bool_or(ev.is_final), false)                             AS saw_final,
             COALESCE(bool_or(ev.kind IN ('expiry','close')), false)           AS saw_close
        FROM held
        LEFT JOIN card_authorization ca ON ca.hold_id = held.id
        LEFT JOIN card_auth_event    ev ON ev.auth_id = ca.id
                                       AND ev.received_at <= ${snapshot.asOf}::timestamptz
       GROUP BY held.id
    ),
    opening AS (
      SELECT held.id AS hold_id, d.description
        FROM held
        LEFT JOIN LATERAL (
          SELECT e.description
            FROM journal_entry e
           WHERE e.hold_id = held.id
             AND e.booking_seq <= ${snapshot.bookingWatermark}
           ORDER BY e.booking_seq
           LIMIT 1
        ) d ON true
    ),
    state AS (
      SELECT held.*, memo.memo_cents, fold.auth_count, fold.event_count,
             fold.auth_net_cents, fold.captured_cents,
             opening.description,
             CASE
               WHEN held.has_closure THEN 'closure_row'
               WHEN held.kind = 'card_auth' AND fold.saw_final THEN 'network_final'
               WHEN held.kind = 'card_auth' AND fold.saw_close THEN 'close_event'
               WHEN held.kind = 'card_auth'
                    AND ${snapshot.asOf}::timestamptz >= held.expires_at THEN 'expired'
               WHEN held.kind = 'card_auth'
                    AND fold.event_count > 0
                    AND fold.auth_net_cents <= 0 THEN 'fully_reversed'
               WHEN held.kind = 'uncleared_credit'
                    AND ${snapshot.asOf}::timestamptz >= held.available_at THEN 'funds_available'
               ELSE NULL
             END AS closed_reason
        FROM held
        JOIN memo    ON memo.hold_id = held.id
        JOIN fold    ON fold.hold_id = held.id
        JOIN opening ON opening.hold_id = held.id
    ),
    terms AS (
      SELECT s.*,
             -- A(E). The event fold when there is an authorisation behind this
             -- hold; otherwise what the memo book posted, never a bare zero.
             CASE WHEN s.kind = 'card_auth' AND s.auth_count > 0
                  THEN s.auth_net_cents ELSE s.memo_cents END AS authorised_cents,
             -- C(E). Only a card authorisation can be cleared against.
             CASE WHEN s.kind = 'card_auth' AND s.auth_count > 0
                  THEN s.captured_cents ELSE 0::bigint END    AS cleared_cents
        FROM state s
    )
    SELECT t.id                                   AS hold_id,
           t.kind                                 AS kind,
           COALESCE(t.description, t.external_ref) AS descriptor,
           t.external_ref                         AS external_ref,
           t.authorised_cents                     AS authorised_cents,
           t.cleared_cents                        AS cleared_cents,
           -- H(E) = 0 if closed(E) else max(A(E) - C(E), 0). The whole model.
           CASE WHEN t.closed_reason IS NOT NULL THEN 0::bigint
                ELSE GREATEST(t.authorised_cents - t.cleared_cents, 0)
           END                                    AS remaining_cents,
           t.memo_cents                           AS memo_cents,
           (t.closed_reason IS NOT NULL)          AS closed,
           t.closed_reason                        AS closed_reason,
           t.created_at                           AS placed_at,
           t.expires_at                           AS expires_at,
           t.available_at                         AS available_at,
           p.rail::text                           AS policy_rail,
           p.counterparty_class                   AS policy_counterparty_class,
           p.banking_days_hold                    AS policy_banking_days,
           p.release_local_time::text             AS policy_release_time,
           t.auth_count                           AS auth_count,
           t.event_count                          AS event_count
      FROM terms t
      LEFT JOIN funds_availability_policy p ON p.id = t.policy_id
     ORDER BY (CASE WHEN t.closed_reason IS NOT NULL THEN 0::bigint
                    ELSE GREATEST(t.authorised_cents - t.cleared_cents, 0)
               END) > 0 DESC,
              t.created_at DESC,
              t.id`;

  return rows.map((row) => ({
    holdId: row.hold_id,
    kind: row.kind,
    descriptor: row.descriptor,
    externalRef: row.external_ref,
    authorisedCents: row.authorised_cents,
    clearedCents: row.cleared_cents,
    remainingCents: row.remaining_cents,
    memoBalanceCents: row.memo_cents,
    closed: row.closed,
    closedReason: row.closed_reason,
    placedAt: row.placed_at,
    expiresAt: row.expires_at,
    availableAt: row.available_at,
    policy:
      row.policy_rail === null ||
      row.policy_counterparty_class === null ||
      row.policy_banking_days === null ||
      row.policy_release_time === null
        ? null
        : {
            rail: row.policy_rail,
            counterpartyClass: row.policy_counterparty_class,
            bankingDaysHold: row.policy_banking_days,
            releaseLocalTime: row.policy_release_time,
          },
    authCount: Number(row.auth_count),
    eventCount: Number(row.event_count),
  }));
}

/**
 * `activeHoldsCents` and `unclearedCreditsCents`, folded from the rows the
 * screen will actually list.
 *
 * Deliberately a pure function over `listHoldRows` rather than a second SQL
 * aggregate. The data contract requires
 * `available === ledger − activeHolds − unclearedCredits` *exactly*, and the
 * cheapest way to guarantee that the headline agrees with the table beneath it
 * is for both to be the same numbers, added up in one place.
 *
 * Note that a manual hold counts towards `activeHoldsCents`, alongside card
 * authorisations. `availableBalance()` in `balances.ts` answers a different,
 * business-wide question and buckets only `card_auth` there; summing the
 * screen's own rows is what keeps this screen's decomposition closed.
 */
export function foldHoldTotals(rows: readonly HoldRow[]): {
  readonly activeHoldsCents: bigint;
  readonly unclearedCreditsCents: bigint;
} {
  let activeHoldsCents = 0n;
  let unclearedCreditsCents = 0n;

  for (const row of rows) {
    if (row.kind === "uncleared_credit") {
      unclearedCreditsCents += row.remainingCents;
    } else {
      activeHoldsCents += row.remainingCents;
    }
  }

  return { activeHoldsCents, unclearedCreditsCents };
}

/* -------------------------------------------------------------------------- */
/* 3. Postings                                                                */
/* -------------------------------------------------------------------------- */

export type PostingBookRow = "financial" | "memo";

/**
 * One posting, on both clocks.
 *
 * `valueDate` and `bookingDate` are the two axes of §5 and they are different
 * types for a reason: `valueDate` is the business day the money belongs to and
 * `bookingDate` is the business day we learned about it. When the first is
 * earlier than the second the entry was backdated — a correction landing on a
 * day that is already closed, or a settlement file arriving late — and that is
 * a fact an operator reading a statement needs to see rather than infer.
 */
export interface PostingRow {
  readonly entryId: string;
  readonly book: PostingBookRow;
  readonly description: string;
  readonly occurredAt: Date;
  readonly valueDate: string;
  readonly bookingDate: string;
  /** `value_date < book_date(booking_time)`. */
  readonly backdated: boolean;
  /** How many book days earlier the value date is. `0` when not backdated. */
  readonly backdatedByDays: number;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly bookingSeq: bigint;
  /** Signed from the customer's point of view. `null` for memo postings. */
  readonly ledgerDeltaCents: bigint | null;
  /** Signed from the customer's point of view. Always present. */
  readonly availableDeltaCents: bigint;
  readonly holdId: string | null;
  readonly rail: string | null;
  readonly externalRef: string | null;
}

/**
 * The account's activity, newest first, across both books.
 *
 * The union is the point. A customer's postings live in two places:
 *
 *   * the financial book, as lines on their own `2100` deposit account, and
 *   * the memo book, as lines on the `9100`/`9200` leaf of a hold that belongs
 *     to that deposit account.
 *
 * They cannot collide — `assert_entry_balanced()` refuses an entry that mixes
 * books, so an entry is in exactly one branch of this union — and taking only
 * the first branch would silently drop every authorisation, which is precisely
 * the posting that explains why available moved and ledger did not.
 *
 * Both amounts are signed from the customer's point of view by multiplying by
 * `normal_side` (§2.2 — the journal stores the bank's side). A memo entry has
 * no ledger effect at all, so `ledgerDeltaCents` is `null` and not `0`; its
 * availability effect is the negation of the hold's movement, because a hold
 * going up is availability going down.
 *
 * Both predicates from `ledgerBalanceCents` apply here too, and they must:
 * the data contract requires the summary's balance to be a fold over exactly
 * the postings this returns. Without the `value_date` cutoff a payment booked
 * today for tomorrow's business day would appear at the top of the table while
 * being absent from the headline balance, and the screen's running-balance
 * column — which walks that balance backwards through these rows — would be
 * wrong on every line beneath it.
 */
export async function listPostingRows(
  accountId: string,
  snapshot: LedgerSnapshot,
  limit: number,
  conn: Sql,
): Promise<readonly PostingRow[]> {
  if (!isAccountId(accountId)) return [];

  const rows = await conn<
    {
      entry_id: string;
      book: PostingBookRow;
      description: string;
      occurred_at: Date;
      value_date: string;
      booking_date: string;
      backdated_by_days: number;
      entry_type: "original" | "reversal" | "rebook";
      booking_seq: bigint;
      ledger_delta_cents: bigint | null;
      available_delta_cents: bigint;
      hold_id: string | null;
      rail: string | null;
      external_ref: string | null;
    }[]
  >`
    WITH entries AS (
      -- The financial book: lines on the customer's own deposit account.
      SELECT e.id, e.book, e.description, e.booking_time, e.value_date,
             e.booking_seq, e.entry_type, e.rail::text AS rail, e.external_ref,
             e.hold_id,
             SUM(l.amount_cents * a.normal_side)::bigint AS delta_cents
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN account       a ON a.id = l.account_id
       WHERE l.account_id = ${accountId}::uuid
         AND e.value_date  <= ${snapshot.valueDate}::date
         AND e.booking_seq <= ${snapshot.bookingWatermark}
       GROUP BY e.id

      UNION ALL

      -- The memo book: the hold leg on this account's 9100/9200 leaves. The
      -- 9900 contra is excluded by the account_id predicate, which is what
      -- stops the two legs cancelling to zero.
      SELECT e.id, e.book, e.description, e.booking_time, e.value_date,
             e.booking_seq, e.entry_type, e.rail::text AS rail, e.external_ref,
             e.hold_id,
             SUM(l.amount_cents * a.normal_side)::bigint AS delta_cents
        FROM hold h
        JOIN journal_entry e ON e.hold_id = h.id
        JOIN journal_line  l ON l.entry_id = e.id
                            AND l.account_id = h.memo_account_id
        JOIN account       a ON a.id = l.account_id
       WHERE h.account_id = ${accountId}::uuid
         AND e.value_date  <= ${snapshot.valueDate}::date
         AND e.booking_seq <= ${snapshot.bookingWatermark}
       GROUP BY e.id
    )
    SELECT en.id                                        AS entry_id,
           en.book::text                                AS book,
           en.description                               AS description,
           en.booking_time                              AS occurred_at,
           to_char(en.value_date, 'YYYY-MM-DD')         AS value_date,
           to_char(book_date(en.booking_time), 'YYYY-MM-DD') AS booking_date,
           -- Positive means the entry was backdated by that many book days.
           GREATEST(book_date(en.booking_time) - en.value_date, 0) AS backdated_by_days,
           en.entry_type::text                          AS entry_type,
           en.booking_seq                               AS booking_seq,
           CASE WHEN en.book = 'financial' THEN en.delta_cents END AS ledger_delta_cents,
           CASE WHEN en.book = 'financial' THEN en.delta_cents
                ELSE -en.delta_cents END                AS available_delta_cents,
           en.hold_id                                   AS hold_id,
           en.rail                                      AS rail,
           en.external_ref                              AS external_ref
      FROM entries en
     ORDER BY en.booking_seq DESC
     LIMIT ${limit}`;

  return rows.map((row) => ({
    entryId: row.entry_id,
    book: row.book,
    description: row.description,
    occurredAt: row.occurred_at,
    valueDate: row.value_date,
    bookingDate: row.booking_date,
    backdated: row.backdated_by_days > 0,
    backdatedByDays: row.backdated_by_days,
    entryType: row.entry_type,
    bookingSeq: row.booking_seq,
    ledgerDeltaCents: row.ledger_delta_cents,
    availableDeltaCents: row.available_delta_cents,
    holdId: row.hold_id,
    rail: row.rail,
    externalRef: row.external_ref,
  }));
}
