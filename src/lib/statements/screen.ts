/**
 * The live implementation of the statements screen's data contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE SCREEN SHOWS
 * ---------------------------------------------------------------------------
 *
 * One (account, closed day), and for it BOTH readings at once:
 *
 *   as published  the document that was issued, re-derived from the ledger at
 *                 its own frozen watermark and checked against its stored
 *                 hash, on this read.
 *   as corrected  the same day at today's watermark.
 *
 * The published side is deliberately NOT read out of `statement`'s stored
 * `opening_balance_cents` / `closing_balance_cents`. Those columns exist and
 * are honest (DECISIONS 008: a published figure must stay queryable exactly as
 * published), but rendering them would prove nothing. Re-deriving the document
 * and finding it hashes to the stored value is the claim; the stored figures
 * are then a cross-check, and if the two ever disagreed the screen would say
 * so rather than print the one that happened to be handy.
 *
 * ---------------------------------------------------------------------------
 * `bigint` NARROWS HERE, ONCE
 * ---------------------------------------------------------------------------
 *
 * Everything in `src/lib/statements/**` is `bigint` cents. The contract is
 * `number` cents, because these values cross to the client and `bigint` does
 * not survive JSON. `toCents` is the single conversion site and it refuses
 * rather than silently rounds: a balance past 2^53 is a bug worth crashing on,
 * not a number to approximate on a customer's statement.
 */

import "server-only";

import type {
  AccountOption,
  CorrectionGroupView,
  DayOption,
  DocumentView,
  LatePostingView,
  PublishedStatementView,
  StatementDetailView,
  StatementLineView,
  StatementsQuery,
  StatementsView,
} from "@/components/statements/data-contract";
import { listBusinesses, type Sql } from "@/lib/ledger/queries";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import { compareStatement, explainsDelta, groupLatePostings } from "./compare";
import {
  listStatementDays,
  readStatementAccount,
  statementConnection,
  type StatementDay,
} from "./read";
import type {
  LatePosting,
  PublishedStatement,
  StatementComparison,
  StatementDocument,
} from "./types";

/** The one bigint -> number narrowing in the read path. Refuses, never rounds. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} cents is past Number.MAX_SAFE_INTEGER; widen Cents to bigint before rendering it`,
    );
  }
  return Number(value);
}

function toDocument(doc: StatementDocument, publishedWatermark: bigint): DocumentView {
  return {
    periodStart: doc.periodStart,
    periodEnd: doc.periodEnd,
    bookingWatermark: toCents(doc.bookingWatermark),
    openingBalanceCents: toCents(doc.openingBalanceCents),
    closingBalanceCents: toCents(doc.closingBalanceCents),
    lineCount: doc.lineCount,
    lines: doc.lines.map(
      (l): StatementLineView => ({
        id: `${l.bookingSeq}:${l.ordinal}`,
        entryId: l.entryId,
        valueDate: l.valueDate,
        bookingSeq: toCents(l.bookingSeq),
        ordinal: l.ordinal,
        entryType: l.entryType,
        description: l.description,
        externalRef: l.externalRef,
        rail: l.rail,
        reversesEntryId: l.reversesEntryId,
        correctionGroupId: l.correctionGroupId,
        amountCents: toCents(l.signedCents),
        runningBalanceCents: toCents(l.runningBalanceCents),
        // On the published document this is false for every line, by
        // construction: nothing above the watermark is in it.
        late: l.bookingSeq > publishedWatermark,
      }),
    ),
  };
}

function toLatePosting(p: LatePosting): LatePostingView {
  return {
    entryId: p.entryId,
    valueDate: p.valueDate,
    bookingSeq: toCents(p.bookingSeq),
    bookingTime: p.bookingTime,
    entryType: p.entryType,
    description: p.description,
    externalRef: p.externalRef,
    reversesEntryId: p.reversesEntryId,
    amountCents: toCents(p.signedCents),
    affectsOpening: p.affectsOpening,
  };
}

function toPublishedView(
  s: PublishedStatement,
  actorNames: ReadonlyMap<string, string>,
): PublishedStatementView {
  return {
    statementId: s.statementId,
    version: s.version,
    bookingWatermark: toCents(s.bookingWatermark),
    openingBalanceCents: toCents(s.openingBalanceCents),
    closingBalanceCents: toCents(s.closingBalanceCents),
    lineCount: s.lineCount,
    contentHash: s.contentHash,
    format: s.format,
    generatedAt: s.generatedAt,
    generatedBy: actorNames.get(s.generatedBy) ?? s.generatedBy,
  };
}

function toDayOption(day: StatementDay): DayOption {
  return {
    businessDate: day.businessDate,
    closedAt: day.closedAt,
    bookingWatermark: toCents(day.bookingWatermark),
    versionCount: day.versionCount,
    lineCount: day.lineCount,
    latePostingCount: day.latePostingCount,
  };
}

interface AccountRow extends AccountOption {
  /** Newest period this account has a published statement for, or `null`. */
  readonly newestStatementPeriod: string | null;
  /**
   * The same, restricted to statements that have LINES ON THEM.
   *
   * A statement with no lines is a real and correct document — it says this
   * customer did nothing that day — but it is the wrong thing to open a screen
   * on, and `pickAccount` ranks on this column first for that reason. See the
   * note there.
   */
  readonly newestStatedPeriodWithLines: string | null;
}

/**
 * The picker's accounts: the ledger's list of who has money, decorated with
 * this module's own `statement` table.
 *
 * The join used to be one query and it re-stated the ledger's definition of a
 * customer deposit account — `2100`, financial book, non-null business, not
 * closed — which is four predicates that must agree with `listDepositAccounts`
 * and had no mechanism making them. `listBusinesses()` is that mechanism.
 *
 * ORDER comes back from Postgres as `legal_name, id`; the accounts are then
 * re-keyed by deposit account and the newest published period attached. The
 * original ordered by `legal_name, a.name`, and a business has exactly one
 * `2100` leaf, so within a legal name there is exactly one row and the two
 * orders are the same list.
 */
async function listAccounts(conn: Sql): Promise<readonly AccountRow[]> {
  const businesses = (await listBusinesses(conn)).filter(
    (b) => b.depositOpen && b.depositAccountId !== null,
  );
  if (businesses.length === 0) return [];

  const newest = await conn<
    {
      account_id: string;
      newest_statement: string | null;
      newest_with_lines: string | null;
    }[]
  >`
    SELECT s.account_id,
           to_char(MAX(s.period_end), 'YYYY-MM-DD') AS newest_statement,
           to_char(MAX(s.period_end) FILTER (WHERE s.line_count > 0), 'YYYY-MM-DD')
             AS newest_with_lines
      FROM statement s
     WHERE s.account_id = ANY(${businesses.map((b) => b.depositAccountId as string)}::uuid[])
     GROUP BY s.account_id`;
  const byAccount = new Map(newest.map((r) => [r.account_id, r]));

  return businesses.map((b) => {
    const row = byAccount.get(b.depositAccountId as string);
    return {
      accountId: b.depositAccountId as string,
      legalName: b.legalName,
      accountName: b.depositAccountName as string,
      newestStatementPeriod: row?.newest_statement ?? null,
      newestStatedPeriodWithLines: row?.newest_with_lines ?? null,
    };
  });
}

/**
 * Which account to open on, when the URL does not say.
 *
 * ---------------------------------------------------------------------------
 * The most recently stated day THAT HAS TRANSACTIONS ON IT
 * ---------------------------------------------------------------------------
 *
 * Two versions of this rule have now been wrong, and both were wrong the same
 * way — they ranked on something that correlated with "worth opening" until it
 * stopped.
 *
 *   v1: first alphabetically. Landed on a suite's fixture company whose newest
 *       statement was for a synthetic day in 2011. A real document, correctly
 *       rendered, and the wrong thing to open a statements screen on.
 *   v2: the most recently STATED business day. Better, and it held right up
 *       until a fixture company acquired a statement for the demo day with
 *       ZERO LINES on it — see `pickDemoAccount` for how it got one — at which
 *       point it tied with the real customer on the date and won on the
 *       alphabet. The screen's default state became a blank document.
 *
 * A statement with no lines is not a bug and is not hidden: it is the correct
 * document for a day on which a customer did nothing, and a customer who wants
 * it can select it. It is simply never the right thing to LAND on, because the
 * first thing the screen has to demonstrate is that a day can be published,
 * corrected and still reconcile — and nothing demonstrates that on an empty
 * page.
 *
 * So the keys are:
 *
 *   1. newest published period with at least one line on it
 *   2. newest published period at all              (an account may only have
 *                                                   empty ones; still rankable)
 *   3. legal name                                  (deterministic)
 *
 * Note that this cannot be fixed by deleting the empty statements. The
 * `statement` table is append-only like everything else that records what a
 * customer was told, and those three versions genuinely were issued. The fix
 * has to be in what the screen chooses to open, which is a judgement, which is
 * why it is here in code with an argument attached rather than in a WHERE
 * clause.
 *
 * Accounts with no published statement sort last but are still LISTED. Hiding
 * them would be the wrong fix: "this customer has no statements" is an answer
 * the picker should be able to give.
 */
function pickAccount(
  accounts: readonly AccountRow[],
  wanted: string | undefined,
): AccountRow | undefined {
  if (wanted !== undefined) {
    const named = accounts.find((a) => a.accountId === wanted);
    if (named !== undefined) return named;
  }
  return [...accounts].sort((a, b) => {
    const byLines = descending(
      a.newestStatedPeriodWithLines,
      b.newestStatedPeriodWithLines,
    );
    if (byLines !== 0) return byLines;
    const byAny = descending(a.newestStatementPeriod, b.newestStatementPeriod);
    if (byAny !== 0) return byAny;
    return a.legalName < b.legalName ? -1 : a.legalName > b.legalName ? 1 : 0;
  })[0];
}

/** Newest first, with `null` (never stated) sorting last. */
function descending(left: string | null, right: string | null): number {
  const l = left ?? "";
  const r = right ?? "";
  if (l === r) return 0;
  return l < r ? 1 : -1;
}

/** Strip the ordering hint before the row crosses the contract. */
function toAccountOption(row: AccountRow): AccountOption {
  return {
    accountId: row.accountId,
    legalName: row.legalName,
    accountName: row.accountName,
  };
}

async function readActorNames(
  ids: readonly string[],
  conn: Sql,
): Promise<ReadonlyMap<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await conn<{ id: string; display_name: string }[]>`
    SELECT id, display_name FROM actor
     WHERE id = ANY(${[...new Set(ids)]}::uuid[])`;
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

/**
 * Which day to open on, when the URL does not say.
 *
 * The newest closed day that has a published statement — because a screen
 * whose default state is "nothing has been published for this day" teaches
 * nobody anything. If none has, fall back to the newest closed day with
 * activity, and let the screen say plainly that it was closed and never
 * issued. Only if there are no closed days at all is there genuinely nothing.
 */
function pickDay(days: readonly StatementDay[]): StatementDay | null {
  return (
    days.find((d) => d.versionCount > 0) ??
    days.find((d) => d.lineCount > 0) ??
    days[0] ??
    null
  );
}

/**
 * Load the screen.
 *
 * One entry point, so the pickers, the document and the comparison are
 * consistent as of one read rather than four that could interleave with a
 * publish running in another tab.
 */
export async function loadStatementsView(
  query: StatementsQuery = {},
): Promise<Result<StatementsView, ErrorShape>> {
  try {
    const conn = await statementConnection();
    const asOf = new Date().toISOString();

    const accountRows = await listAccounts(conn);
    const accounts = accountRows.map(toAccountOption);
    const selected = pickAccount(accountRows, query.accountId);

    if (selected === undefined) {
      return ok({
        source: "live",
        asOf,
        accounts,
        account: null,
        days: [],
        day: null,
        statement: null,
      });
    }

    const accountId = selected.accountId;
    const account = toAccountOption(selected);
    const resolved = await readStatementAccount(accountId, conn);
    if (resolved === null) {
      return fail("STATEMENT_ACCOUNT_UNKNOWN", `no deposit account ${accountId}`);
    }

    const allDays = await listStatementDays(
      { accountId, entityId: resolved.entityId },
      conn,
    );
    const named =
      query.businessDate === undefined
        ? undefined
        : allDays.find((d) => d.businessDate === query.businessDate);
    const day = named ?? pickDay(allDays);

    if (day === undefined || day === null) {
      return ok({
        source: "live",
        asOf,
        accounts,
        account,
        days: allDays.map(toDayOption),
        day: null,
        statement: null,
      });
    }

    const comparison = await compareStatement(
      {
        accountId,
        businessDate: day.businessDate,
        ...(query.version === undefined ? {} : { version: query.version }),
      },
      conn,
    );

    const statement =
      comparison === null ? null : await toDetail(comparison, conn);

    return ok({
      source: "live",
      asOf,
      accounts,
      account,
      days: allDays.map(toDayOption),
      day: toDayOption(day),
      statement,
    });
  } catch (thrown) {
    // A read failure is a VALUE here, so the screen's error state is a branch
    // and not a boundary. Nothing moved: this path is read-only, the ledger is
    // append-only, and the panel says so.
    return fail(
      "STATEMENT_READ_FAILED",
      thrown instanceof Error ? thrown.message : "the statement query failed",
    );
  }
}

async function toDetail(
  comparison: StatementComparison,
  conn: Sql,
): Promise<StatementDetailView> {
  const actorNames = await readActorNames(
    comparison.versions.map((v) => v.generatedBy),
    conn,
  );

  const publishedWatermark = comparison.published.bookingWatermark;
  const deltaCents = comparison.deltaCents;

  const corrections = groupLatePostings(comparison.latePostings).map(
    (g, index): CorrectionGroupView => ({
      id: g.correctionGroupId ?? `entry:${g.postings[0]?.entryId ?? index}`,
      correctionGroupId: g.correctionGroupId,
      isCorrection: g.isCorrection,
      netCents: toCents(g.netCents),
      postings: g.postings.map(toLatePosting),
    }),
  );

  return {
    published: toPublishedView(comparison.published, actorNames),
    publishedDocument: toDocument(comparison.publishedDocument, publishedWatermark),
    reproduced: comparison.reproduced,
    // Re-derived on this read, not read from the row. See the module note.
    recomputedHash: comparison.recomputedHash,
    formatChanged: comparison.formatChanged,
    correctedDocument: toDocument(comparison.correctedDocument, publishedWatermark),
    deltaCents: toCents(deltaCents),
    differs: deltaCents !== 0n,
    explained: explainsDelta(deltaCents, comparison.latePostings),
    corrections,
    versions: comparison.versions.map((v) => toPublishedView(v, actorNames)),
  };
}

/**
 * Whether a database is configured at all.
 *
 * Used by the page to choose between the live source and the fixture, and to
 * label which one the operator is looking at. Reads the raw env rather than
 * `src/lib/env.ts`, because that module throws on a missing key at import time
 * and "no database configured" must be a renderable state, not a crash.
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.trim() !== "";
}
