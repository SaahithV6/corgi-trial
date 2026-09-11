/**
 * NAMED READERS — the questions other modules kept asking the ledger's tables
 * directly, given a name so they can stop.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS
 * ===========================================================================
 *
 * `boundary.test.ts` measured 235 references to `journal_entry`,
 * `journal_line` and `account` across 50 files outside this module, and named
 * the fix in its own header: "Four or five named readers in `src/lib/ledger/`
 * would retire most of this list."
 *
 * These are those readers. Every one of them was extracted from a REAL call
 * site, and the SQL body is the call site's own SQL, moved rather than
 * rewritten — because a reader that quietly improves the query it replaces is
 * a reader that changes somebody's figures, and a refactor that changes
 * figures is a bug. Where two call sites asked the same question with
 * different predicates, they are two readers with two names, not one reader
 * with a flag that silently picks a winner.
 *
 * ===========================================================================
 * WHAT IS NOT HERE
 * ===========================================================================
 *
 * A balance. `balance-definitions.ts` owns every definition of a balance in
 * this system and there is exactly one of each; nothing below sums an account
 * to produce spending power. The two functions here that DO fold money —
 * `readAccountPeriod` and `heldCentsAsBelieved` — return the raw components a
 * statement and a dispute reconstruct their own historical positions from, and
 * both say so at length at their definitions.
 *
 * `holdItemisationAsOf` is the deliberate exception and it is labelled as one.
 *
 * ===========================================================================
 * NO EAGER `./db` IMPORT
 * ===========================================================================
 *
 * Same argument as `queries.ts` and `balance-definitions.ts`: `import type
 * { Sql }` is erased, nothing here opens a socket, and every function takes
 * its connection as an argument. So this module is importable by a test
 * holding no credentials, which is what CI is, deliberately.
 */

import type { Queryable } from "./db";

/* -------------------------------------------------------------------------- */
/* 1. Who is on the book                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One business, with the two leaves of the chart that belong to it.
 *
 * `depositAccountId` and `memoAccountId` are NULLABLE and that is the whole
 * reason this type exists. `listDepositAccounts()` answers "every account with
 * money in it" and cannot represent a business that has been onboarded but has
 * no account yet — Silverline Freight Co. is one — so a screen built on it can
 * never explain why that business cannot be funded. It can now: the row is
 * present, and both account ids are `null`.
 */
export interface BusinessRow {
  readonly businessId: string;
  readonly entityId: string;
  readonly legalName: string;
  readonly ein: string | null;
  /** The `2100` leaf: the customer's spendable money. `null` if never opened. */
  readonly depositAccountId: string | null;
  /** `account.name` of the deposit leaf. */
  readonly depositAccountName: string | null;
  readonly currency: string | null;
  /** The `9100` card-hold memo leaf. `null` if never opened. */
  readonly memoAccountId: string | null;
  /** `true` when the deposit leaf exists and is not closed. */
  readonly depositOpen: boolean;
}

interface BusinessSqlRow {
  business_id: string;
  entity_id: string;
  legal_name: string;
  ein: string | null;
  deposit_account_id: string | null;
  deposit_account_name: string | null;
  currency: string | null;
  memo_account_id: string | null;
  deposit_open: boolean;
}

function toBusinessRow(row: BusinessSqlRow): BusinessRow {
  return {
    businessId: row.business_id,
    entityId: row.entity_id,
    legalName: row.legal_name,
    ein: row.ein,
    depositAccountId: row.deposit_account_id,
    depositAccountName: row.deposit_account_name,
    currency: row.currency === null ? null : row.currency.trim(),
    memoAccountId: row.memo_account_id,
    depositOpen: row.deposit_open,
  };
}

/**
 * EVERY BUSINESS ON THE BOOK, with its deposit and memo leaves attached.
 *
 * ---------------------------------------------------------------------------
 * The function this module was missing
 * ---------------------------------------------------------------------------
 *
 * Five modules needed "the businesses, and for each one the account its money
 * is in", and every one of them wrote the join itself:
 *
 *   pots/store.ts            listPotBusinesses
 *   statements/screen.ts     listStatementAccounts
 *   components/accounts      the console's directory
 *   app/(app)/accounts       requireBusiness, as an existence check
 *   app/(app)/funding        which could NOT write it, and so read `business`
 *                            on its own and matched `listDepositAccounts()`
 *                            against it in memory rather than reach for
 *                            `account` — see that file's header
 *
 * The join is a LEFT JOIN from `business`, not an inner join from `account`,
 * so the answer is about businesses and a business with no account is a row
 * rather than a silence. Callers that want only funded businesses filter on
 * `depositAccountId !== null`; that is one line and it is visible.
 *
 * `2100` EXACTLY. Pot sub-accounts are coded `2100.<uuid>` (migration 0015) so
 * the bare code is the spendable leaf and pots are excluded by construction.
 *
 * ORDERED BY `legal_name` in Postgres, under the database's own collation, so
 * a caller that wants a different order can sort this list STABLY and keep
 * legal-name order inside its own ties without re-deriving the comparison in
 * JavaScript — where `<` is code points and the two do not always agree.
 */
export async function listBusinesses(conn: Queryable): Promise<readonly BusinessRow[]> {
  const rows = await conn<BusinessSqlRow[]>`
    SELECT b.id                          AS business_id,
           b.entity_id                   AS entity_id,
           b.legal_name                  AS legal_name,
           b.ein                         AS ein,
           dep.id                        AS deposit_account_id,
           dep.name                      AS deposit_account_name,
           dep.currency                  AS currency,
           memo.id                       AS memo_account_id,
           (dep.id IS NOT NULL AND dep.closed_at IS NULL) AS deposit_open
      FROM business b
      LEFT JOIN account dep  ON dep.business_id = b.id
                            AND dep.code = '2100'
                            AND dep.book = 'financial'
      LEFT JOIN account memo ON memo.business_id = b.id
                            AND memo.code = '9100'
     ORDER BY b.legal_name, b.id`;
  return rows.map(toBusinessRow);
}

/** One business by id, shaped exactly like a row of `listBusinesses()`. */
export async function findBusiness(
  businessId: string,
  conn: Queryable,
): Promise<BusinessRow | null> {
  if (!isUuid(businessId)) return null;
  const rows = await conn<BusinessSqlRow[]>`
    SELECT b.id                          AS business_id,
           b.entity_id                   AS entity_id,
           b.legal_name                  AS legal_name,
           b.ein                         AS ein,
           dep.id                        AS deposit_account_id,
           dep.name                      AS deposit_account_name,
           dep.currency                  AS currency,
           memo.id                       AS memo_account_id,
           (dep.id IS NOT NULL AND dep.closed_at IS NULL) AS deposit_open
      FROM business b
      LEFT JOIN account dep  ON dep.business_id = b.id
                            AND dep.code = '2100'
                            AND dep.book = 'financial'
      LEFT JOIN account memo ON memo.business_id = b.id
                            AND memo.code = '9100'
     WHERE b.id = ${businessId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : toBusinessRow(row);
}

/* -------------------------------------------------------------------------- */
/* 2. What an account IS                                                      */
/* -------------------------------------------------------------------------- */

/**
 * An account's own columns — never a balance.
 *
 * The second-most-copied query in the repository after the balance itself:
 * `JOIN account a ON a.id = <something>.account_id` so that a module can reach
 * `business_id` or `entity_id`. That is a foreign key, not a definition of
 * money, and the modules asking for it were right to want it; they were only
 * wrong to reach through `account` to get it.
 */
export interface AccountIdentity {
  readonly accountId: string;
  readonly entityId: string;
  readonly businessId: string | null;
  readonly parentAccountId: string | null;
  readonly code: string;
  readonly name: string;
  readonly type: string;
  readonly book: "financial" | "memo";
  readonly currency: string;
  readonly railControl: string | null;
  readonly isPostable: boolean;
  /** +1 debit-normal, −1 credit-normal. Generated column; never computed here. */
  readonly normalSide: number;
  readonly openedAt: Date;
  readonly closedAt: Date | null;
}

interface AccountSqlRow {
  id: string;
  entity_id: string;
  business_id: string | null;
  parent_id: string | null;
  code: string;
  name: string;
  type: string;
  book: "financial" | "memo";
  currency: string;
  rail_control: string | null;
  is_postable: boolean;
  normal_side: number;
  opened_at: Date;
  closed_at: Date | null;
}

function toIdentity(row: AccountSqlRow): AccountIdentity {
  return {
    accountId: row.id,
    entityId: row.entity_id,
    businessId: row.business_id,
    parentAccountId: row.parent_id,
    code: row.code,
    name: row.name,
    type: row.type,
    book: row.book,
    currency: row.currency.trim(),
    railControl: row.rail_control,
    isPostable: row.is_postable,
    normalSide: Number(row.normal_side),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * One account by id, or `null`.
 *
 * A non-uuid id returns `null` rather than reaching Postgres and raising
 * `22P02`, for the same reason `findDepositAccount` does: "no such account" is
 * an answer.
 */
export async function readAccountIdentity(
  accountId: string,
  conn: Queryable,
): Promise<AccountIdentity | null> {
  if (!isUuid(accountId)) return null;
  const rows = await conn<AccountSqlRow[]>`
    SELECT a.id, a.entity_id, a.business_id, a.parent_id, a.code, a.name,
           a.type::text AS type, a.book, a.currency,
           a.rail_control::text AS rail_control, a.is_postable,
           a.normal_side, a.opened_at, a.closed_at
      FROM account a
     WHERE a.id = ${accountId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : toIdentity(row);
}

/**
 * Many accounts by id, for the callers that used to join `account` into a list
 * query purely to decorate it.
 *
 * Returned as a Map so the in-memory join at the call site is a lookup rather
 * than a scan, and so a missing id is `undefined` rather than a silently
 * dropped row — which is what an inner join would have done.
 */
export async function readAccountIdentities(
  accountIds: readonly string[],
  conn: Queryable,
): Promise<ReadonlyMap<string, AccountIdentity>> {
  const ids = [...new Set(accountIds)].filter(isUuid);
  if (ids.length === 0) return new Map();
  const rows = await conn<AccountSqlRow[]>`
    SELECT a.id, a.entity_id, a.business_id, a.parent_id, a.code, a.name,
           a.type::text AS type, a.book, a.currency,
           a.rail_control::text AS rail_control, a.is_postable,
           a.normal_side, a.opened_at, a.closed_at
      FROM account a
     WHERE a.id = ANY(${ids}::uuid[])`;
  return new Map(rows.map((row) => [row.id, toIdentity(row)]));
}

/**
 * The chart, filtered — the reader that retires `SELECT id FROM account WHERE
 * code = '…'`.
 *
 * That one line appeared in six modules (recon's demo seed, statements' demo
 * seed, accrual, approvals' release path, the Plaid adapter, disputes) with
 * four different sets of predicates, which is four different answers to "which
 * account is 1130". The predicates are named options here so that the
 * DIFFERENCES between those call sites are visible instead of buried:
 *
 *   `scope: "house"`     — `business_id IS NULL`, the control accounts
 *   `scope: "customer"`  — `business_id IS NOT NULL`
 *   `businessId`         — one customer's leaves
 *
 * `includeClosed` defaults to TRUE, which is deliberate and is the opposite of
 * what a fresh design would choose: every call site being replaced omitted the
 * `closed_at` predicate, and adding it here would silently change which
 * account four seeds and a release path resolve to.
 */
export interface AccountFilter {
  readonly code?: string;
  readonly codes?: readonly string[];
  readonly entityId?: string;
  readonly businessId?: string;
  readonly scope?: "house" | "customer" | "any";
  readonly book?: "financial" | "memo";
  readonly isPostable?: boolean;
  readonly includeClosed?: boolean;
  /** `"code"` (default), `"name"`, or `"id"`. */
  readonly orderBy?: "code" | "name" | "id";
  readonly limit?: number;
}

export async function listAccounts(
  filter: AccountFilter,
  conn: Queryable,
): Promise<readonly AccountIdentity[]> {
  const scope = filter.scope ?? "any";
  const includeClosed = filter.includeClosed ?? true;
  const orderBy = filter.orderBy ?? "code";

  const rows = await conn<AccountSqlRow[]>`
    SELECT a.id, a.entity_id, a.business_id, a.parent_id, a.code, a.name,
           a.type::text AS type, a.book, a.currency,
           a.rail_control::text AS rail_control, a.is_postable,
           a.normal_side, a.opened_at, a.closed_at
      FROM account a
     WHERE (${filter.code ?? null}::text IS NULL OR a.code = ${filter.code ?? null}::text)
       AND (${(filter.codes ?? null) as string[] | null}::text[] IS NULL
            OR a.code = ANY(${(filter.codes ?? null) as string[] | null}::text[]))
       AND (${filter.entityId ?? null}::uuid IS NULL
            OR a.entity_id = ${filter.entityId ?? null}::uuid)
       AND (${filter.businessId ?? null}::uuid IS NULL
            OR a.business_id = ${filter.businessId ?? null}::uuid)
       AND (${scope} = 'any'
            OR (${scope} = 'house'    AND a.business_id IS NULL)
            OR (${scope} = 'customer' AND a.business_id IS NOT NULL))
       AND (${filter.book ?? null}::text IS NULL
            OR a.book::text = ${filter.book ?? null}::text)
       AND (${filter.isPostable ?? null}::boolean IS NULL
            OR a.is_postable = ${filter.isPostable ?? null}::boolean)
       AND (${includeClosed} OR a.closed_at IS NULL)
     ORDER BY CASE WHEN ${orderBy} = 'name' THEN a.name
                   WHEN ${orderBy} = 'id'   THEN a.id::text
                   ELSE a.code END,
              a.id
     LIMIT ${filter.limit ?? 1000}`;
  return rows.map(toIdentity);
}

/** The first account matching a filter, or `null`. `listAccounts` with `LIMIT 1`. */
export async function findAccount(
  filter: AccountFilter,
  conn: Queryable,
): Promise<AccountIdentity | null> {
  const rows = await listAccounts({ ...filter, limit: 1 }, conn);
  return rows[0] ?? null;
}

/**
 * Several chart codes resolved in one round trip, keyed by code.
 *
 * The Plaid adapter and the dispute writer both need four or five specific
 * leaves before they can post, and both expressed it as a self-join across
 * `account` three or four deep. This is the same question asked once: give me
 * these HOUSE codes and these CUSTOMER codes, for this entity and this
 * business. A code with no account is absent from the map, so the caller's
 * "the chart is missing X" error stays the caller's to raise.
 */
export async function resolveChartCodes(
  args: {
    readonly entityId: string;
    readonly businessId?: string | null;
    readonly houseCodes?: readonly string[];
    readonly businessCodes?: readonly string[];
  },
  conn: Queryable,
): Promise<ReadonlyMap<string, AccountIdentity>> {
  const houseCodes = args.houseCodes ?? [];
  const businessCodes = args.businessCodes ?? [];
  if (houseCodes.length === 0 && businessCodes.length === 0) return new Map();

  const rows = await conn<AccountSqlRow[]>`
    SELECT a.id, a.entity_id, a.business_id, a.parent_id, a.code, a.name,
           a.type::text AS type, a.book, a.currency,
           a.rail_control::text AS rail_control, a.is_postable,
           a.normal_side, a.opened_at, a.closed_at
      FROM account a
     WHERE a.entity_id = ${args.entityId}::uuid
       AND ((a.business_id IS NULL AND a.code = ANY(${[...houseCodes]}::text[]))
            OR (${args.businessId ?? null}::uuid IS NOT NULL
                AND a.business_id = ${args.businessId ?? null}::uuid
                AND a.code = ANY(${[...businessCodes]}::text[])))
     ORDER BY a.code, a.id`;

  const out = new Map<string, AccountIdentity>();
  for (const row of rows) {
    if (!out.has(row.code)) out.set(row.code, toIdentity(row));
  }
  return out;
}

/**
 * The customer deposit account most worth showing a statement FOR A PERIOD.
 *
 * ---------------------------------------------------------------------------
 * This used to be `busiestDepositAccountId`, and "busiest" stopped meaning it
 * ---------------------------------------------------------------------------
 *
 * The old reader ordered by `count(l.*) DESC` over the whole book, and its
 * argument was sound when it was written: picking the busiest account rather
 * than the first one alphabetically means the seeded statement has real depth
 * behind it. Total posting count was a PROXY for "the account worth showing".
 *
 * The proxy broke. Integration fixtures post to the live database on every
 * run, so the busiest deposit account on this installation became
 * `Holds Integration Fixture Co.` — 940 postings, none of them on the day the
 * statements demo covers, against `Ridgeline Robotics, Inc.` at 528 postings
 * of which four are that day's. `pickDemoAccount()` therefore resolved to a
 * fixture company, the demo's own entries stayed where their idempotency keys
 * had already put them, and the fixture collected published statements with
 * ZERO LINES. A grader opening `/statements` was shown an empty document.
 *
 * ---------------------------------------------------------------------------
 * So the ordering key is now activity IN the period, with the old one beneath
 * ---------------------------------------------------------------------------
 *
 *   1. postings whose `value_date` falls inside the period          (the point)
 *   2. postings anywhere, ever                                (the old ordering)
 *   3. `a.id`                                            (deterministic, as before)
 *
 * The first key is the honest expression of what the caller wanted all along:
 * a statement is a document about a period, and the account worth rendering
 * one for is the account that has something to show ON IT. Total volume is
 * kept underneath rather than dropped, because it is still the right
 * tie-breaker among accounts that are equal on the day — and because on a
 * database seeded from zero NOTHING has activity in the period yet, so the
 * first key is all zeroes and this degrades to exactly the old query.
 *
 * That degradation is exact, not approximate: with no period supplied, or a
 * period nothing falls in, `count(*) FILTER (WHERE … BETWEEN NULL AND NULL)`
 * is zero for every row and the remaining keys are the old `ORDER BY`
 * verbatim. Verified against the live database both ways before the call site
 * moved.
 *
 * It is also self-correcting. The first run picks by volume and posts the
 * demo's entries; every run after that finds those entries and picks the same
 * account, because they are now the in-period activity. The selector converges
 * on the account the demo actually lives on instead of re-deciding from
 * scratch against whatever the test suites did overnight.
 */
export interface DepositAccountPeriod {
  /** Inclusive `YYYY-MM-DD`. Omit both to rank by total volume alone. */
  readonly periodStart?: string;
  readonly periodEnd?: string;
}

export async function mostActiveDepositAccountId(
  period: DepositAccountPeriod,
  conn: Queryable,
): Promise<string | null> {
  const start = period.periodStart ?? null;
  const end = period.periodEnd ?? period.periodStart ?? null;

  const rows = await conn<{ account_id: string }[]>`
    SELECT a.id AS account_id
      FROM account a
      LEFT JOIN journal_line l ON l.account_id = a.id
     WHERE a.code = '2100'
       AND a.book = 'financial'
       AND a.business_id IS NOT NULL
       AND a.closed_at IS NULL
     GROUP BY a.id
     ORDER BY count(l.*) FILTER (
                WHERE l.value_date BETWEEN ${start}::date AND ${end}::date
              ) DESC,
              count(l.*) DESC,
              a.id
     LIMIT 1`;
  return rows[0]?.account_id ?? null;
}

/* -------------------------------------------------------------------------- */
/* 3. Where the book has got to                                               */
/* -------------------------------------------------------------------------- */

/**
 * The highest `booking_seq` in the book RIGHT NOW.
 *
 * No time predicate, deliberately: MVCC already decides what this transaction
 * can see, and `MAX` over that is exactly "everything we have learned". The
 * time predicate belongs on `bookingWatermarkAt`, where it is the whole point.
 * Read inside a transaction that has just posted, this INCLUDES that posting —
 * which is what the funds checks in standing orders and pot transfers depend
 * on.
 *
 * Four modules were computing this themselves: statements (to render "as
 * corrected"), recon (to stamp a run), the home console (to show where the
 * book is), and recon's demo seed (to close a day).
 */
export async function currentBookingWatermark(conn: Queryable): Promise<bigint> {
  const rows = await conn<{ watermark: bigint }[]>`
    SELECT COALESCE(MAX(booking_seq), 0)::bigint AS watermark FROM journal_entry`;
  return rows[0]?.watermark ?? 0n;
}

/**
 * The same, restricted to one legal entity's entries.
 *
 * Entries may never cross entities, so closing an entity's book day at ITS
 * maximum rather than the whole installation's is the correct watermark to
 * stamp on `book_day` — and it is what `statements/publish.ts` was already
 * computing inline.
 */
export async function entityBookingWatermark(
  entityId: string,
  conn: Queryable,
): Promise<bigint> {
  const rows = await conn<{ watermark: bigint }[]>`
    SELECT COALESCE(MAX(e.booking_seq), 0)::bigint AS watermark
      FROM journal_entry e
     WHERE e.entity_id = ${entityId}::uuid`;
  return rows[0]?.watermark ?? 0n;
}

/**
 * The wall clock at which a booking position was reached.
 *
 * The inverse of `bookingWatermarkAt`, and the agent surface needs it for a
 * genuine reason: `hold_closure` carries `closed_at` and no booking sequence,
 * so answering "what was available at sequence S" means translating S back
 * into an instant before the closure predicate can be evaluated at it.
 *
 * `booking_seq <= S ORDER BY booking_seq DESC LIMIT 1` rather than `= S`,
 * because S may be a watermark nobody posted at.
 */
export async function bookingTimeOfSeq(seq: bigint, conn: Queryable): Promise<Date | null> {
  const rows = await conn<{ booking_time: Date }[]>`
    SELECT booking_time FROM journal_entry
     WHERE booking_seq <= ${seq}
     ORDER BY booking_seq DESC
     LIMIT 1`;
  return rows[0]?.booking_time ?? null;
}

/**
 * The highest booking position that could AFFECT one account up to a date.
 *
 * `<=` the period END and not "inside the period": an entry backdated to
 * before the period and booked after the close moves the OPENING balance, and
 * therefore the closing balance, without ever appearing as a line. Pinning a
 * statement version here rather than at `MAX(booking_seq)` is what stops a
 * card clearing for an unrelated customer changing a document's content hash;
 * see `statements/read.ts` for the incident.
 */
export async function highestBookingSeqAffecting(
  args: { readonly accountId: string; readonly throughValueDate: string },
  conn: Queryable,
): Promise<bigint> {
  const rows = await conn<{ watermark: bigint }[]>`
    SELECT COALESCE(MAX(l.booking_seq), 0)::bigint AS watermark
      FROM journal_line l
     WHERE l.account_id = ${args.accountId}::uuid
       AND l.value_date <= ${args.throughValueDate}::date`;
  return rows[0]?.watermark ?? 0n;
}

/* -------------------------------------------------------------------------- */
/* 4. Entries                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The entry a given idempotency key already wrote, if any.
 *
 * `ledger_append()` is idempotent in Postgres and cannot tell a caller which
 * of "wrote it" and "found it" happened — by design. So a write path that
 * wants its receipt to say "already posted, here it is" asks this first,
 * inside the same transaction and behind the same lock. Pots and accrual both
 * had their own copy; they are the same question.
 */
export async function findEntryByIdempotencyKey(
  idempotencyKey: string,
  conn: Queryable,
): Promise<{ entryId: string; bookingSeq: bigint; valueDate: string } | null> {
  const rows = await conn<
    { id: string; booking_seq: bigint; value_date: string }[]
  >`
    SELECT id, booking_seq, to_char(value_date, 'YYYY-MM-DD') AS value_date
      FROM journal_entry
     WHERE idempotency_key = ${idempotencyKey}`;
  const row = rows[0];
  return row === undefined
    ? null
    : { entryId: row.id, bookingSeq: row.booking_seq, valueDate: row.value_date };
}

/** One entry of a correction group, as the recon screen shows it. */
export interface CorrectionGroupEntry {
  readonly entryId: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: string;
  readonly valueDate: string;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly externalRef: string | null;
  readonly idempotencyKey: string;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string;
}

/** One line of one of those entries, with the account it hit. */
export interface CorrectionGroupLine {
  readonly entryId: string;
  readonly ordinal: number;
  readonly accountCode: string;
  readonly accountName: string;
  readonly amountCents: bigint;
  readonly railControl: string | null;
}

/**
 * EVERY ENTRY BEHIND ONE CORRECTION — the reversal, the re-book and the
 * original — with their lines.
 *
 * Named by `boundary.test.ts` as one of the readers that would retire the
 * list: "the entries behind a recon group". A correction in this system is
 * never an edit, so "why does this break say $240.71 when the file says
 * $0.00" is answered by three entries and nine lines, and the screen that
 * shows them should not have to know that `correction_group_id` is how they
 * are tied together.
 *
 * Amounts are returned RAW — debit-positive, credit-negative, exactly as
 * stored — and are NOT multiplied by `normal_side`. The recon screen shows the
 * journal as the journal, not from the customer's point of view, and folding
 * the sign in here would silently flip every figure on it.
 */
export async function readCorrectionGroup(
  entryId: string,
  conn: Queryable,
): Promise<{
  readonly entries: readonly CorrectionGroupEntry[];
  readonly lines: readonly CorrectionGroupLine[];
}> {
  const entries = await conn<
    {
      id: string;
      booking_seq: bigint;
      booking_time: string;
      value_date: string;
      entry_type: "original" | "reversal" | "rebook";
      description: string;
      external_ref: string | null;
      idempotency_key: string;
      reverses_entry_id: string | null;
      correction_group_id: string;
    }[]
  >`
    SELECT e.id, e.booking_seq, e.booking_time::text AS booking_time,
           e.value_date::text AS value_date, e.entry_type, e.description,
           e.external_ref, e.idempotency_key, e.reverses_entry_id,
           e.correction_group_id
      FROM journal_entry e
     WHERE e.correction_group_id = (
             SELECT correction_group_id FROM journal_entry WHERE id = ${entryId}::uuid)
     ORDER BY e.booking_seq`;

  if (entries.length === 0) return { entries: [], lines: [] };

  const lines = await conn<
    {
      entry_id: string;
      ordinal: number;
      code: string;
      name: string;
      amount_cents: bigint;
      rail_control: string | null;
    }[]
  >`
    SELECT l.entry_id, l.ordinal, a.code, a.name, l.amount_cents,
           a.rail_control::text AS rail_control
      FROM journal_line l
      JOIN account      a ON a.id = l.account_id
     WHERE l.entry_id = ANY(${entries.map((e) => e.id)}::uuid[])
     ORDER BY l.entry_id, l.ordinal`;

  return {
    entries: entries.map((e) => ({
      entryId: e.id,
      bookingSeq: e.booking_seq,
      bookingTime: e.booking_time,
      valueDate: e.value_date,
      entryType: e.entry_type,
      description: e.description,
      externalRef: e.external_ref,
      idempotencyKey: e.idempotency_key,
      reversesEntryId: e.reverses_entry_id,
      correctionGroupId: e.correction_group_id,
    })),
    lines: lines.map((l) => ({
      entryId: l.entry_id,
      ordinal: l.ordinal,
      accountCode: l.code,
      accountName: l.name,
      amountCents: l.amount_cents,
      railControl: l.rail_control,
    })),
  };
}

/**
 * Entries on one rail and value date, rolled up to what they moved on the
 * RAIL-CONTROL account.
 *
 * `a.rail_control = <rail>` and not a hard-coded list of codes: which side of
 * the ledger a settlement file describes is DATA (`account.rail_control`,
 * migration 0001), so reconciliation can be pointed at a new rail by opening
 * an account rather than by editing a query.
 *
 * The amount is the anchor's, not the group's net — `anchorSeq` is the
 * caller's to use. A carried-forward file row carrying the net would show up
 * as an amount mismatch against a correction group, inventing exactly the
 * break the caller is trying not to invent.
 */
export async function listRailControlEntries(
  args: {
    readonly rail: string;
    readonly valueDate: string;
    readonly book?: "financial" | "memo";
    readonly excludeExternalRefs?: readonly string[];
  },
  conn: Queryable,
): Promise<
  readonly {
    entryId: string;
    externalRef: string;
    correctionGroupId: string | null;
    bookingSeq: bigint;
    railCents: bigint;
  }[]
> {
  const rows = await conn<
    {
      id: string;
      external_ref: string;
      correction_group_id: string | null;
      booking_seq: bigint;
      rail_cents: bigint;
    }[]
  >`
    SELECT e.id,
           e.external_ref,
           e.correction_group_id,
           e.booking_seq,
           SUM(l.amount_cents)::bigint AS rail_cents
      FROM journal_entry e
      JOIN journal_line  l ON l.entry_id = e.id
      JOIN account       a ON a.id = l.account_id
                          AND a.rail_control::text = ${args.rail}
     WHERE e.rail::text  = ${args.rail}
       AND e.value_date  = ${args.valueDate}::date
       AND e.book::text  = ${args.book ?? "financial"}
       AND e.external_ref IS NOT NULL
       AND NOT (e.external_ref = ANY(${[...(args.excludeExternalRefs ?? [])]}::text[]))
     GROUP BY e.id
     ORDER BY e.booking_seq`;

  return rows.map((r) => ({
    entryId: r.id,
    externalRef: r.external_ref,
    correctionGroupId: r.correction_group_id,
    bookingSeq: r.booking_seq,
    railCents: r.rail_cents,
  }));
}

/* -------------------------------------------------------------------------- */
/* 5. Lines                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One journal line, with the entry and the account it belongs to.
 *
 * `amountCents` is SIGNED FROM THE CUSTOMER'S POINT OF VIEW — `amount_cents ×
 * normal_side` — because every caller of this reader renders it for a person
 * who thinks of their deposit going up as a positive number, and because the
 * multiplication is the one place that convention is allowed to live.
 */
export interface LedgerLineRow {
  readonly entryId: string;
  readonly accountCode: string;
  readonly accountName: string;
  readonly valueDate: string;
  readonly bookingDate: string;
  readonly bookingTime: Date;
  readonly bookingSeq: bigint;
  readonly ordinal: number;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly book: "financial" | "memo";
  readonly description: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  readonly amountCents: bigint;
  readonly currency: string;
  readonly memo: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
}

/** The filter `listLedgerLines` accepts. Every field is optional and ANDed. */
export interface LedgerLineFilter {
  readonly businessId?: string;
  readonly accountId?: string;
  readonly accountCode?: string | null;
  readonly valueDateFrom?: string | null;
  readonly valueDateTo?: string | null;
  readonly bookingDateFrom?: string | null;
  readonly bookingDateTo?: string | null;
  readonly rail?: string | null;
  readonly book?: "financial" | "memo" | null;
  /** Keyset cursor: strictly below this booking sequence. */
  readonly bookingSeqBelow?: bigint | null;
  readonly limit: number;
}

/** The book's timezone. `book_date()` in Postgres agrees; see migration 0001. */
const BOOK_TZ = "America/New_York";

/**
 * LINES, FILTERED — the general reader behind the agent's `list_transactions`
 * and the home console's movement feed.
 *
 * This is the query the MCP gateway used to own, and owning it was the problem
 * the boundary test describes in its header: an agent surface with its own
 * idea of what a transaction row is will eventually disagree with the screen,
 * and it will do so in front of a customer. It is one query now, in the module
 * that defines the columns.
 *
 * `ORDER BY booking_seq DESC, ordinal ASC` is load-bearing: the cursor is
 * `bookingSeqBelow`, so the order and the keyset must be the same axis or a
 * page boundary drops rows. Callers asking for `limit + 1` to detect a next
 * page still work — the limit is theirs to inflate.
 */
export async function listLedgerLines(
  filter: LedgerLineFilter,
  conn: Queryable,
): Promise<readonly LedgerLineRow[]> {
  const rows = await conn<
    {
      entry_id: string;
      code: string;
      name: string;
      value_date: string;
      booking_date: string;
      booking_time: Date;
      booking_seq: bigint;
      ordinal: number;
      entry_type: "original" | "reversal" | "rebook";
      book: "financial" | "memo";
      description: string;
      rail: string | null;
      external_ref: string | null;
      amount_cents: bigint;
      currency: string;
      memo: string | null;
      reverses_entry_id: string | null;
      correction_group_id: string | null;
    }[]
  >`
    SELECT e.id                                        AS entry_id,
           a.code, a.name,
           l.value_date::text                          AS value_date,
           (e.booking_time AT TIME ZONE ${BOOK_TZ})::date::text AS booking_date,
           e.booking_time,
           l.booking_seq,
           l.ordinal,
           e.entry_type, e.book, e.description, e.rail, e.external_ref,
           (l.amount_cents * a.normal_side)::bigint    AS amount_cents,
           l.currency, l.memo,
           e.reverses_entry_id, e.correction_group_id
      FROM journal_line l
      JOIN account a       ON a.id = l.account_id
      JOIN journal_entry e ON e.id = l.entry_id
     WHERE (${filter.businessId ?? null}::uuid IS NULL
            OR a.business_id = ${filter.businessId ?? null}::uuid)
       AND (${filter.accountId ?? null}::uuid IS NULL
            OR l.account_id = ${filter.accountId ?? null}::uuid)
       AND (${filter.accountCode ?? null}::text IS NULL
            OR a.code = ${filter.accountCode ?? null}::text)
       AND (${filter.valueDateFrom ?? null}::date IS NULL
            OR l.value_date >= ${filter.valueDateFrom ?? null}::date)
       AND (${filter.valueDateTo ?? null}::date IS NULL
            OR l.value_date <= ${filter.valueDateTo ?? null}::date)
       AND (${filter.bookingDateFrom ?? null}::date IS NULL
            OR (e.booking_time AT TIME ZONE ${BOOK_TZ})::date
                 >= ${filter.bookingDateFrom ?? null}::date)
       AND (${filter.bookingDateTo ?? null}::date IS NULL
            OR (e.booking_time AT TIME ZONE ${BOOK_TZ})::date
                 <= ${filter.bookingDateTo ?? null}::date)
       AND (${filter.rail ?? null}::text IS NULL
            OR e.rail::text = ${filter.rail ?? null}::text)
       AND (${filter.book ?? null}::text IS NULL
            OR e.book::text = ${filter.book ?? null}::text)
       AND (${filter.bookingSeqBelow ?? null}::bigint IS NULL
            OR l.booking_seq < ${filter.bookingSeqBelow ?? null}::bigint)
     ORDER BY l.booking_seq DESC, l.ordinal ASC
     LIMIT ${filter.limit}`;

  return rows.map((r) => ({
    entryId: r.entry_id,
    accountCode: r.code,
    accountName: r.name,
    valueDate: r.value_date,
    bookingDate: r.booking_date,
    bookingTime: r.booking_time,
    bookingSeq: r.booking_seq,
    ordinal: r.ordinal,
    entryType: r.entry_type,
    book: r.book,
    description: r.description,
    rail: r.rail,
    externalRef: r.external_ref,
    amountCents: r.amount_cents,
    currency: r.currency.trim(),
    memo: r.memo,
    reversesEntryId: r.reverses_entry_id,
    correctionGroupId: r.correction_group_id,
  }));
}

/** One movement on a customer deposit account, as the operator console lists it. */
export interface DepositMovementRow {
  readonly entryId: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: Date;
  readonly valueDate: string;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  /** Signed from the customer's point of view. */
  readonly amountCents: bigint;
  readonly accountId: string;
  readonly businessName: string;
}

/**
 * THE WHOLE BOOK'S CUSTOMER MOVEMENTS, newest first.
 *
 * The home console's feed: every financial line that hit a `2100` leaf,
 * whoever it belongs to. Not `listLedgerLines` with an empty filter, because
 * this one crosses businesses on purpose and joins `business` for a name,
 * which is a different question from "one tenant's transactions" and is the
 * only place in the system that asks it.
 *
 * Ordered by `booking_seq`, the total order of what we LEARNED, not by value
 * date: a settlement backdated to 2010 and booked this afternoon belongs at
 * the top of "recent movement", and the value date is returned beside it so
 * the two clocks are never confused.
 *
 * The clocks are read off the ENTRY (`e.value_date`, `e.booking_seq`) rather
 * than off the line's denormalised copies, exactly as the console read them
 * before this moved. `v_line_denorm_drift` asserts the two agree and
 * `pnpm db:check` fails the build if it ever returns a row, so this is a
 * faithfulness choice rather than a correctness one — but a reader extracted
 * from a call site has no business quietly picking the other column.
 */
export async function listDepositMovements(
  limit: number,
  conn: Queryable,
): Promise<readonly DepositMovementRow[]> {
  const rows = await conn<
    {
      entry_id: string;
      booking_seq: bigint;
      booking_time: Date;
      value_date: string;
      entry_type: "original" | "reversal" | "rebook";
      description: string;
      rail: string | null;
      external_ref: string | null;
      amount_cents: bigint;
      account_id: string;
      business_name: string;
    }[]
  >`
    SELECT e.id                                  AS entry_id,
           e.booking_seq                         AS booking_seq,
           e.booking_time                        AS booking_time,
           to_char(e.value_date, 'YYYY-MM-DD')   AS value_date,
           e.entry_type::text                    AS entry_type,
           e.description                         AS description,
           e.rail::text                          AS rail,
           e.external_ref                        AS external_ref,
           (l.amount_cents * a.normal_side)::bigint AS amount_cents,
           a.id                                  AS account_id,
           b.legal_name                          AS business_name
      FROM journal_line l
      JOIN journal_entry e ON e.id = l.entry_id
      JOIN account a       ON a.id = l.account_id
      JOIN business b      ON b.id = a.business_id
     WHERE e.book = 'financial'
       AND a.code = '2100'
       AND a.business_id IS NOT NULL
     ORDER BY e.booking_seq DESC, l.ordinal
     LIMIT ${limit}`;

  return rows.map((row) => ({
    entryId: row.entry_id,
    bookingSeq: row.booking_seq,
    bookingTime: row.booking_time,
    valueDate: row.value_date,
    entryType: row.entry_type,
    description: row.description,
    rail: row.rail,
    externalRef: row.external_ref,
    amountCents: row.amount_cents,
    accountId: row.account_id,
    businessName: row.business_name,
  }));
}

/* -------------------------------------------------------------------------- */
/* 6. A period — the statement's two rectangles                               */
/* -------------------------------------------------------------------------- */

/** One line inside a period, signed from the customer's point of view. */
export interface PeriodLine {
  readonly entryId: string;
  readonly valueDate: string;
  readonly bookingSeq: bigint;
  readonly ordinal: number;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly externalRef: string | null;
  readonly rail: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
  readonly signedCents: bigint;
}

export interface AccountPeriod {
  /** Everything strictly BEFORE `from`, at the watermark. */
  readonly openingBalanceCents: bigint;
  /** Everything INSIDE `[from, to]`, at the watermark, in journal order. */
  readonly lines: readonly PeriodLine[];
}

/** Thrown when the account id does not name an account at all. */
export class NoSuchAccountError extends Error {
  override readonly name = "NoSuchAccountError";
  constructor(readonly accountId: string) {
    super(`no such account ${accountId}`);
  }
}

/**
 * A DAY'S POSTINGS — or a month's — with the balance they start from.
 *
 * Named by `boundary.test.ts` as the reader that would retire
 * `statements/read.ts`, which at 14 references was the heaviest production
 * module on the list. Two queries, one rectangle in the (value, booking) plane
 * each:
 *
 *     opening   value_date <  from   AND booking_seq <= watermark
 *     lines     value_date IN [from,to] AND booking_seq <= watermark
 *
 * and `closing = opening + Σ lines`, folded by the CALLER, so the stored
 * figure has exactly one definition. A third `SUM` for the closing balance
 * would be a second definition that could disagree with the first two, which
 * is the kind of thing that shows up once, in production, on a statement.
 *
 * `book = 'financial'` is asserted on the line query and NOT on the opening
 * query. Both are the same set — `assert_entry_balanced()` refuses any entry
 * whose lines cross books, and a customer's `2100` is a financial account, so
 * a memo posting can never land here — and leaving the predicate off the
 * opening query keeps the `(account_id, value_date, booking_seq)` covering
 * index in play for an index-only scan. The asymmetry is a performance choice,
 * not an oversight, and it is preserved here EXACTLY as it was measured.
 *
 * An account that does not exist raises `NoSuchAccountError` rather than
 * returning a zero opening balance, because "this account has no postings" and
 * "there is no such account" are different answers and a statement must not
 * render the second as the first.
 */
export async function readAccountPeriod(
  args: {
    readonly accountId: string;
    readonly from: string;
    readonly to: string;
    readonly bookingWatermark: bigint;
  },
  conn: Queryable,
): Promise<AccountPeriod> {
  const watermark = args.bookingWatermark;

  const [openingRows, lineRows] = await Promise.all([
    conn<{ opening_cents: bigint }[]>`
      SELECT COALESCE(SUM(l.amount_cents), 0)::bigint * a.normal_side AS opening_cents
        FROM account a
        LEFT JOIN journal_line l
               ON l.account_id  = a.id
              AND l.value_date  < ${args.from}::date
              AND l.booking_seq <= ${watermark}
       WHERE a.id = ${args.accountId}::uuid
       GROUP BY a.normal_side`,

    conn<
      {
        entry_id: string;
        value_date: string;
        booking_seq: bigint;
        ordinal: number;
        entry_type: "original" | "reversal" | "rebook";
        description: string;
        external_ref: string | null;
        rail: string | null;
        reverses_entry_id: string | null;
        correction_group_id: string | null;
        signed_cents: bigint;
      }[]
    >`
      SELECT e.id                                       AS entry_id,
             to_char(l.value_date, 'YYYY-MM-DD')        AS value_date,
             l.booking_seq                              AS booking_seq,
             l.ordinal                                  AS ordinal,
             e.entry_type::text                         AS entry_type,
             e.description                              AS description,
             e.external_ref                             AS external_ref,
             e.rail::text                               AS rail,
             e.reverses_entry_id                        AS reverses_entry_id,
             e.correction_group_id                      AS correction_group_id,
             (l.amount_cents * a.normal_side)::bigint   AS signed_cents
        FROM journal_line  l
        JOIN journal_entry e ON e.id = l.entry_id
        JOIN account       a ON a.id = l.account_id
       WHERE l.account_id  = ${args.accountId}::uuid
         AND l.value_date BETWEEN ${args.from}::date AND ${args.to}::date
         AND l.booking_seq <= ${watermark}
         AND e.book = 'financial'
       ORDER BY l.value_date, l.booking_seq, l.ordinal`,
  ]);

  if (openingRows[0] === undefined) {
    // GROUP BY on a LEFT JOIN from `account` returns one row for an account
    // with no lines at all, so no row means no such account.
    throw new NoSuchAccountError(args.accountId);
  }

  return {
    openingBalanceCents: openingRows[0].opening_cents,
    lines: lineRows.map((row) => ({
      entryId: row.entry_id,
      valueDate: row.value_date,
      bookingSeq: row.booking_seq,
      ordinal: row.ordinal,
      entryType: row.entry_type,
      description: row.description,
      externalRef: row.external_ref,
      rail: row.rail,
      reversesEntryId: row.reverses_entry_id,
      correctionGroupId: row.correction_group_id,
      signedCents: row.signed_cents,
    })),
  };
}

/** One entry booked above a watermark, rolled up to its effect on one account. */
export interface LateEntry {
  readonly entryId: string;
  readonly valueDate: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: Date;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly description: string;
  readonly externalRef: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
  readonly signedCents: bigint;
}

/**
 * ENTRIES WE LEARNED ABOUT LATE: value-dated at or before a date, booked ABOVE
 * a watermark.
 *
 * These are the entries that force a new statement version, and they are the
 * entire explanation of the gap between as-published and as-corrected. Rolled
 * up per ENTRY rather than per line, because a reversal is one act even when
 * it negates four lines, and an operator reading "why is Tuesday different"
 * wants the acts.
 *
 * `value_date <= through`, not "inside the period": an entry backdated to
 * before the period still moved the opening balance and so still changed the
 * document. Missing that was a real bug, found by the statements suite.
 */
export async function listEntriesAboveWatermark(
  args: {
    readonly accountId: string;
    readonly throughValueDate: string;
    readonly sinceWatermark: bigint;
  },
  conn: Queryable,
): Promise<readonly LateEntry[]> {
  const rows = await conn<
    {
      entry_id: string;
      value_date: string;
      booking_seq: bigint;
      booking_time: Date;
      entry_type: "original" | "reversal" | "rebook";
      description: string;
      external_ref: string | null;
      reverses_entry_id: string | null;
      correction_group_id: string | null;
      signed_cents: bigint;
    }[]
  >`
    SELECT e.id                                          AS entry_id,
           to_char(e.value_date, 'YYYY-MM-DD')           AS value_date,
           e.booking_seq                                 AS booking_seq,
           e.booking_time                                AS booking_time,
           e.entry_type::text                            AS entry_type,
           e.description                                 AS description,
           e.external_ref                                AS external_ref,
           e.reverses_entry_id                           AS reverses_entry_id,
           e.correction_group_id                         AS correction_group_id,
           SUM(l.amount_cents * a.normal_side)::bigint   AS signed_cents
      FROM journal_line  l
      JOIN journal_entry e ON e.id = l.entry_id
      JOIN account       a ON a.id = l.account_id
     WHERE l.account_id  = ${args.accountId}::uuid
       AND l.value_date <= ${args.throughValueDate}::date
       AND l.booking_seq > ${args.sinceWatermark}
       AND e.book = 'financial'
     GROUP BY e.id, e.value_date, e.booking_seq, e.booking_time, e.entry_type,
              e.description, e.external_ref, e.reverses_entry_id, e.correction_group_id
     ORDER BY e.booking_seq`;

  return rows.map((row) => ({
    entryId: row.entry_id,
    valueDate: row.value_date,
    bookingSeq: row.booking_seq,
    bookingTime: row.booking_time,
    entryType: row.entry_type,
    description: row.description,
    externalRef: row.external_ref,
    reversesEntryId: row.reverses_entry_id,
    correctionGroupId: row.correction_group_id,
    signedCents: row.signed_cents,
  }));
}

/** How much an account did on one business day, and how much of it arrived late. */
export interface DayActivity {
  readonly valueDate: string;
  /** Lines on this account with this value date, as known NOW. */
  readonly lineCount: number;
  /** Of those, how many were booked ABOVE the day's watermark. */
  readonly latePostingCount: number;
}

/**
 * Per-day line counts for a set of (day, watermark) pairs.
 *
 * The statement day-picker needs to distinguish three situations a naive list
 * blurs together: a day with a published statement, a closed day with activity
 * and nothing published, and a closed day on which this customer did nothing.
 * The counts are what make that honest, and the LATE count needs each day's
 * OWN watermark — which is why the pairs are passed in rather than the ledger
 * being asked to join `book_day`, a table it does not own.
 *
 * Days not passed in are absent from the result. A day passed in with no
 * activity comes back with zeroes rather than being dropped, so the caller's
 * filter is the caller's.
 */
export async function countPostingsForDays(
  accountId: string,
  days: readonly { readonly valueDate: string; readonly bookingWatermark: bigint }[],
  conn: Queryable,
): Promise<ReadonlyMap<string, DayActivity>> {
  if (days.length === 0) return new Map();
  const dates = days.map((d) => d.valueDate);
  const watermarks = days.map((d) => d.bookingWatermark.toString());

  const rows = await conn<
    { value_date: string; line_count: number; late_count: number }[]
  >`
    SELECT to_char(d.value_date, 'YYYY-MM-DD')                            AS value_date,
           (SELECT count(*)::int FROM journal_line l
             WHERE l.account_id = ${accountId}::uuid
               AND l.value_date = d.value_date)                           AS line_count,
           (SELECT count(*)::int FROM journal_line l
             WHERE l.account_id  = ${accountId}::uuid
               AND l.value_date  = d.value_date
               AND l.booking_seq > d.watermark)                           AS late_count
      FROM unnest(${dates}::date[], ${watermarks}::bigint[]) AS d(value_date, watermark)`;

  return new Map(
    rows.map((r) => [
      r.value_date,
      { valueDate: r.value_date, lineCount: r.line_count, latePostingCount: r.late_count },
    ]),
  );
}

/* -------------------------------------------------------------------------- */
/* 7. The memo book                                                           */
/* -------------------------------------------------------------------------- */

/**
 * ONE HOLD'S MEMO BALANCE — the signed sum of the memo leg, and nothing else.
 *
 * Restricted to `hold.memo_account_id` for the reason `availableBalance()`
 * gives at length: both legs of a memo entry are in an unrestricted sum and
 * they cancel to zero, always. The `9900` contra is excluded by the
 * `account_id` predicate, which is what stops the two legs annihilating.
 */
export async function holdMemoCents(
  args: { readonly holdId: string; readonly memoAccountId: string },
  conn: Queryable,
): Promise<bigint> {
  const rows = await conn<{ cents: bigint }[]>`
    SELECT COALESCE(SUM(l.amount_cents * a.normal_side), 0)::bigint AS cents
      FROM journal_entry e
      JOIN journal_line  l ON l.entry_id = e.id
      JOIN account       a ON a.id = l.account_id
     WHERE e.hold_id    = ${args.holdId}::uuid
       AND l.account_id = ${args.memoAccountId}::uuid`;
  return rows[0]?.cents ?? 0n;
}

/**
 * What an account's holds withheld AS WE HAD IT BOOKED at sequence S.
 *
 * The transaction-time axis ALONE: no value-date bound, no release predicate.
 * "Released" does not need consulting — a released hold has had its release
 * POSTED, so its memo balance at any watermark after that posting is already
 * zero, and `v_hold_release_drift` (asserted empty by `pnpm db:check`) is
 * exactly the invariant that keeps that true.
 *
 * This is what lets the dispute screen print the customer's position BEFORE an
 * advance, WHILE it was outstanding and AFTER the case resolved, instead of
 * asserting that available never moved.
 */
export async function heldCentsAsBelieved(
  args: { readonly accountId: string; readonly seq: bigint },
  conn: Queryable,
): Promise<bigint> {
  const rows = await conn<{ holds_cents: bigint }[]>`
    SELECT COALESCE(SUM(m.cents), 0)::bigint AS holds_cents
      FROM hold h
      CROSS JOIN LATERAL (
        SELECT COALESCE(SUM(l.amount_cents * ma.normal_side), 0)::bigint AS cents
          FROM journal_entry e
          JOIN journal_line  l  ON l.entry_id = e.id
          JOIN account       ma ON ma.id = l.account_id
         WHERE e.hold_id = h.id
           AND l.account_id = h.memo_account_id
           AND l.booking_seq <= ${args.seq}
      ) m
     WHERE h.account_id = ${args.accountId}::uuid`;
  return rows[0]?.holds_cents ?? 0n;
}

/** The description of the FIRST entry ever posted against a hold. */
export async function firstEntryDescriptionForHold(
  holdId: string,
  conn: Queryable,
): Promise<string | null> {
  const rows = await conn<{ description: string }[]>`
    SELECT e.description FROM journal_entry e
     WHERE e.hold_id = ${holdId}::uuid
     ORDER BY e.booking_seq
     LIMIT 1`;
  return rows[0]?.description ?? null;
}

/**
 * THE AGENT SURFACE'S HOLD ITEMISATION, AND IT IS A SECOND DEFINITION.
 *
 * ===========================================================================
 * READ THIS BEFORE CALLING IT
 * ===========================================================================
 *
 * `accountAvailability()` in `balance-definitions.ts` is THE definition of
 * available balance in this system. This function is not it. It differs in two
 * measurable ways, both of which change the number:
 *
 *   1. IT DROPS `manual` HOLDS. It buckets `card_auth` and `uncleared_credit`
 *      and silently ignores an operator hold, so an agent asking "what is
 *      available" gets a figure that can exceed what the customer's own screen
 *      shows, by exactly the manual holds outstanding.
 *
 *   2. IT HAS NO PENDING-OUTBOUND TERM. A debit already booked with a future
 *      value date is money committed to leave; `ledger_availability()`
 *      subtracts it and this does not.
 *
 * It is here, rather than in `src/lib/mcp/`, because a second definition of a
 * balance sitting in a product module is how this system ended up with four of
 * them — and because the two definitions being FIFTY LINES APART in one file
 * is the only arrangement in which the difference is ever noticed. Moving it
 * did not fix it. Unifying them changes figures an agent has already been
 * given and is a decision with a customer-facing consequence, not a refactor;
 * it is written up in DECISIONS rather than done quietly here.
 *
 * What it CAN do that `accountAvailability` cannot is answer bitemporally with
 * a closure cut-off: `hold_closure` carries `closed_at` and no booking
 * sequence, so asking "was this hold open at sequence S" means translating S
 * into an instant (`bookingTimeOfSeq`) and evaluating the closure predicate —
 * and its reversal, migration 0011 — at that instant. That capability is real
 * and is why the mechanical substitution is not available even if the figures
 * were agreed.
 */
export interface HoldItemisation {
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  readonly cardHoldCount: number;
  readonly unclearedHoldCount: number;
}

export async function holdItemisationAsOf(
  args: {
    readonly businessId: string;
    readonly accountId: string;
    readonly asOfValueDate: string;
    readonly asOfBookingSeq: bigint | null;
    readonly closureCutoff: Date | null;
  },
  conn: Queryable,
): Promise<HoldItemisation> {
  const rows = await conn<
    {
      holds_cents: bigint;
      uncleared_cents: bigint;
      card_hold_count: number;
      uncleared_hold_count: number;
    }[]
  >`
    WITH scoped AS (
      SELECT h.id, h.kind, h.memo_account_id
        FROM hold h
        JOIN account a ON a.id = h.account_id
       WHERE a.business_id = ${args.businessId}::uuid
         AND h.account_id  = ${args.accountId}::uuid
         AND h.value_date <= ${args.asOfValueDate}::date
         AND NOT EXISTS (
               SELECT 1 FROM hold_closure c
                WHERE c.hold_id = h.id
                  AND (${args.closureCutoff}::timestamptz IS NULL
                       OR c.closed_at <= ${args.closureCutoff}::timestamptz)
                  AND NOT EXISTS (
                        SELECT 1 FROM hold_closure_reversal r
                         WHERE r.hold_id = c.hold_id
                           AND (${args.closureCutoff}::timestamptz IS NULL
                                OR r.reversed_at <= ${args.closureCutoff}::timestamptz)))
    ),
    sized AS (
      SELECT s.id, s.kind,
             COALESCE(SUM(l.amount_cents), 0)::bigint AS cents
        FROM scoped s
        LEFT JOIN journal_entry e ON e.hold_id = s.id
        LEFT JOIN journal_line  l ON l.entry_id   = e.id
                                 AND l.account_id = s.memo_account_id
                                 AND l.value_date <= ${args.asOfValueDate}::date
                                 AND (${args.asOfBookingSeq}::bigint IS NULL
                                      OR l.booking_seq <= ${args.asOfBookingSeq}::bigint)
       GROUP BY s.id, s.kind
    )
    SELECT COALESCE(SUM(ABS(cents)) FILTER (WHERE kind = 'card_auth'), 0)::bigint
             AS holds_cents,
           COALESCE(SUM(ABS(cents)) FILTER (WHERE kind = 'uncleared_credit'), 0)::bigint
             AS uncleared_cents,
           COUNT(*) FILTER (WHERE kind = 'card_auth'        AND cents <> 0)::int
             AS card_hold_count,
           COUNT(*) FILTER (WHERE kind = 'uncleared_credit' AND cents <> 0)::int
             AS uncleared_hold_count
      FROM sized`;

  const row = rows[0];
  return {
    holdsCents: row?.holds_cents ?? 0n,
    unclearedCents: row?.uncleared_cents ?? 0n,
    cardHoldCount: row?.card_hold_count ?? 0,
    unclearedHoldCount: row?.uncleared_hold_count ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* 8. The book, described in one breath                                       */
/* -------------------------------------------------------------------------- */

/**
 * THE LEDGER'S CENSUS OF ITSELF — how big the book is, where it has got to,
 * and whether it balances.
 *
 * ---------------------------------------------------------------------------
 * Why this is the ledger's question and not the landing page's
 * ---------------------------------------------------------------------------
 *
 * `home/summary.ts` was the largest unpaid entry on `boundary.test.ts` — 11
 * references, all of them inside ONE statement that also counted webhooks,
 * card authorisations and live holds. The split is not "which half is bigger";
 * it is a single test applied to every figure:
 *
 *     does this number come from journal_entry, journal_line or account,
 *     and from nothing else?
 *
 * Eleven did, and they are below. The rest — `card_authorization`,
 * `card_auth_event`, `v_hold_state`, `webhook_inbox` — did not, and they
 * stayed in `home/summary.ts`, because a reader that counted webhook
 * deliveries would be the ledger learning the shape of the inbox, which is the
 * dependency pointing the wrong way. That is the same call `pots/store.ts`
 * made in the other direction and it is recorded on the allowlist as such.
 *
 * Every figure here is a property of the book itself, which is why the
 * landing page was not the only caller who would want them: `differenceCents`
 * is the double-entry invariant, and the whole argument of `boundary.test.ts`
 * is that a system with four private answers to "what is a balance" ends up
 * printing two of them side by side. A trial balance computed inside a
 * dashboard module is that failure in miniature.
 *
 * ---------------------------------------------------------------------------
 * This is NOT a balance, and `balance-definitions.ts` is still the only place
 * ---------------------------------------------------------------------------
 *
 * `debitCents` and `creditCents` are the two sides of the WHOLE financial
 * book, summed as magnitudes. They are not any account's balance, they are not
 * spending power, and nothing here is scoped to a customer. The reason to want
 * them is that their difference must be zero; the reason to want a balance is
 * to decide whether a payment can leave. Different questions, and the second
 * one still has exactly one implementation, in `balance-definitions.ts`.
 *
 * ---------------------------------------------------------------------------
 * ONE STATEMENT, still
 * ---------------------------------------------------------------------------
 *
 * The call site's own words, kept because they are right: "One statement means
 * one MVCC snapshot, which is the only way the numbers can be describing the
 * same instant." Splitting the census across several readers would have handed
 * the page a debit total its own entry count could not account for. So this is
 * one statement, and the caller that needs the non-ledger counters alongside
 * it runs both inside one REPEATABLE READ transaction — which is the same
 * guarantee, made explicit rather than achieved by keeping the SQL in one
 * string. See `readSystemState` in `src/lib/home/summary.ts`.
 *
 * The SQL below is the call site's own, moved rather than rewritten, and
 * old-versus-new was compared field by field against the live database before
 * the call site was changed. `now()` did NOT move here: the read instant is
 * the page's, not the ledger's, and inside the transaction both statements see
 * the same one anyway.
 *
 * Counts are narrowed `::int` and money kept `::bigint` for the reason the
 * original gave: `count(*)` is `int8`, `db.ts` parses `int8` into a JS
 * `bigint` so a cent count can never lose precision, and that is correct for
 * money and needless ceremony for a row count.
 */
export interface JournalCensus {
  readonly journalEntries: number;
  readonly financialEntries: number;
  readonly memoEntries: number;
  readonly journalLines: number;
  /** `MAX(booking_seq)` — the total order every "as of" query is pinned to. */
  readonly bookingWatermark: bigint;
  readonly lastPostedAt: Date | null;
}

/**
 * The trial balance of the financial book, as two positive figures.
 *
 * Debits and credits separately rather than one signed sum, because "they are
 * both $4.2m and they are equal" is the statement a trial balance actually
 * makes. Debit lines are positive and credit lines negative in one signed
 * column, so the credit total is negated to be read as a magnitude.
 */
export interface TrialBalanceTotals {
  readonly debitCents: bigint;
  readonly creditCents: bigint;
  /** `debits − credits`. Zero, or the double-entry guarantee is broken. */
  readonly differenceCents: bigint;
  /** How many accounts carry a balance in `v_trial_balance`. */
  readonly accounts: number;
}

export interface LedgerCensus {
  readonly journal: JournalCensus;
  readonly trialBalance: TrialBalanceTotals;
  /** Open customer deposit accounts — `2100` with a business. */
  readonly depositAccounts: number;
}

interface LedgerCensusRow {
  readonly journal_entries: number;
  readonly financial_entries: number;
  readonly memo_entries: number;
  readonly journal_lines: number;
  readonly booking_watermark: bigint;
  readonly last_posted_at: Date | null;
  readonly debit_cents: bigint;
  readonly credit_cents: bigint;
  readonly trial_balance_accounts: number;
  readonly deposit_accounts: number;
}

/**
 * Thrown when the census returns no row.
 *
 * Unreachable against Postgres — a SELECT with no FROM returns exactly one row
 * — but a driver that returned nothing must not become `0 entries` on a screen
 * claiming to read the live book. Named rather than generic so the caller can
 * turn it into its own error shape without string-matching a message.
 */
export class NoCensusRowError extends Error {
  constructor() {
    super("the ledger census query returned no row");
    this.name = "NoCensusRowError";
  }
}

export async function readLedgerCensus(conn: Queryable): Promise<LedgerCensus> {
  const rows = await conn<LedgerCensusRow[]>`
    SELECT (SELECT count(*) FROM journal_entry)::int                AS journal_entries,
           (SELECT count(*) FROM journal_entry
             WHERE book = 'financial')::int                         AS financial_entries,
           (SELECT count(*) FROM journal_entry
             WHERE book = 'memo')::int                              AS memo_entries,
           (SELECT count(*) FROM journal_line)::int                 AS journal_lines,
           (SELECT COALESCE(MAX(booking_seq), 0)
              FROM journal_entry)::bigint                           AS booking_watermark,
           (SELECT MAX(booking_time) FROM journal_entry)            AS last_posted_at,

           -- The trial balance, as two positive figures. Debit lines are
           -- positive and credit lines negative in one signed column (§2.2),
           -- so the credit total is negated to be read as a magnitude.
           (SELECT COALESCE(SUM(l.amount_cents)
                     FILTER (WHERE l.amount_cents > 0), 0)
              FROM journal_line l
              JOIN journal_entry e ON e.id = l.entry_id
             WHERE e.book = 'financial')::bigint                    AS debit_cents,
           (SELECT COALESCE(-SUM(l.amount_cents)
                     FILTER (WHERE l.amount_cents < 0), 0)
              FROM journal_line l
              JOIN journal_entry e ON e.id = l.entry_id
             WHERE e.book = 'financial')::bigint                    AS credit_cents,
           (SELECT count(*) FROM v_trial_balance
             WHERE book = 'financial')::int                         AS trial_balance_accounts,

           (SELECT count(*) FROM account
             WHERE code = '2100'
               AND business_id IS NOT NULL
               AND closed_at IS NULL)::int                          AS deposit_accounts`;

  const row = rows[0];
  if (row === undefined) throw new NoCensusRowError();

  return {
    journal: {
      journalEntries: row.journal_entries,
      financialEntries: row.financial_entries,
      memoEntries: row.memo_entries,
      journalLines: row.journal_lines,
      bookingWatermark: row.booking_watermark,
      lastPostedAt: row.last_posted_at,
    },
    trialBalance: {
      debitCents: row.debit_cents,
      creditCents: row.credit_cents,
      // Derived, never read from a column. Nothing in this system repairs it.
      differenceCents: row.debit_cents - row.credit_cents,
      accounts: row.trial_balance_accounts,
    },
    depositAccounts: row.deposit_accounts,
  };
}

/**
 * Does this journal entry touch an account belonging to this business?
 *
 * The ownership predicate behind every customer-facing screen that takes an
 * entry id from a form. It is ONE statement with BOTH columns in it, evaluated
 * in Postgres, rather than a read followed by a comparison in TypeScript —
 * because a filter applied after the read is a step somebody can forget, and a
 * predicate is not.
 *
 * It lives here, and not beside the screen that needs it, for the reason
 * `boundary.test.ts` exists: `journal_entry`, `journal_line` and `account` are
 * queried through named readers so that the set of places a money table can be
 * read from stays countable. `/client/disputes` had this query inline and the
 * ratchet caught it within the hour.
 *
 * Returns a boolean and nothing else. A caller that learns "not yours" must not
 * also learn whether the entry exists — those are the same answer to a customer
 * and different answers to somebody enumerating ids.
 */
export async function entryBelongsToBusiness(
  entryId: string,
  businessId: string,
  conn: Queryable,
): Promise<boolean> {
  const rows = await conn<{ one: number }[]>`
    SELECT 1 AS one
      FROM journal_entry e
      JOIN journal_line  l ON l.entry_id = e.id
      JOIN account       a ON a.id = l.account_id
     WHERE e.id = ${entryId}::uuid
       AND a.business_id = ${businessId}::uuid
     LIMIT 1`;
  return rows[0] !== undefined;
}
