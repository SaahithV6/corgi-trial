import "server-only";

/**
 * The live read behind `/client/statements`.
 *
 * ===========================================================================
 * THE LIBRARY DOES THE WORK. THIS FILE ARRANGES IT.
 * ===========================================================================
 *
 * `src/lib/statements/**` already renders a statement, hashes it, compares an
 * issued document against the ledger and itemises the difference — and its
 * reproducibility claim is PROVEN, not aspirational:
 * `reproducibility.integration.test.ts` re-renders byte-identically at two
 * different instants and reproduces the Ridgeline 2026-09-08 correction.
 * Re-implementing any of that for a customer-facing skin would produce a
 * second definition of every figure on the page, and the second definition is
 * the one that is wrong in production.
 *
 * So this module calls, and does not compute:
 *
 *   listStatementDays()    the closed days this account has something on
 *   listStatementVersions() what was issued for one day, oldest first
 *   compareStatement()     the issued document, re-derived at its own frozen
 *                          watermark and checked against its stored hash
 *   readBookDay()          the close watermark for a day nothing was issued for
 *   renderStatement()      the document at a given (period, watermark)
 *   statementHash()        the canonical hash of a rendered document
 *   listLatePostings()     what has landed since, itemised
 *
 * The only arithmetic in this file is `Number(bigint)`, in `toCents`, which
 * refuses rather than rounds — copied in spirit from `screen.ts`, which makes
 * the same narrowing at the same kind of edge for the operator console.
 *
 * ===========================================================================
 * THE REPRODUCTION IS PERFORMED, ON THIS REQUEST
 * ===========================================================================
 *
 * `/statements` once printed HASH REPRODUCED with no database connection open,
 * because a fixture said so. Nothing on this screen can do that, and the
 * mechanism is not a promise:
 *
 *   - The reproduction fields are only ever produced by `reproduce()` below,
 *     which calls `renderStatement` TWICE against a live connection, at two
 *     instants, and hashes both. There is no fixture path that constructs a
 *     `ClientReproduction`; with no database the screen renders a refusal and
 *     `selected` is `null`, so there is no hash on the page to be wrong about.
 *   - `matchesStoredHash` is `null` when no statement was issued for the day.
 *     Not `false`, and not quietly `true`: there is no stored hash, so the
 *     honest answer is "nothing to check against", and the view prints that.
 *
 * ===========================================================================
 * ISOLATION IS A PREDICATE, AND THE PERIOD IS VALIDATED AGAINST IT
 * ===========================================================================
 *
 * `businessId` off the query string is a CLAIM. It is resolved by
 * `findBusiness()` — `WHERE b.id = $1` — and the deposit account comes off
 * that row, so every read below is keyed to an account that Postgres already
 * tied to the requested business. There is no `.filter()` anywhere in this
 * file deciding which customer a row belongs to.
 *
 * `businessDate` off the query string is also a claim, and it gets the same
 * treatment: `pickPeriod()` looks it up in THIS ACCOUNT's list of closed days
 * and falls back if it is not there. A date is not a capability, but it is an
 * argument to a `::date` cast, and the rule in this codebase is that nothing
 * from a form reaches a query unresolved. A day this account has nothing on
 * renders as the default period, not as an empty document with a stranger's
 * date on it.
 */

import type { BusinessRef, Loaded } from "@/components/client/contract";
import type {
  ClientCorrection,
  ClientLatePosting,
  ClientReproduction,
  ClientStatementDocument,
  ClientStatementLine,
  ClientStatementPeriod,
  ClientStatementsScreen,
} from "@/components/client/statements/contract";
import { findBusiness, listBusinesses, type Sql } from "@/lib/ledger/queries";
import { compareStatement } from "@/lib/statements/compare";
import {
  listLatePostings,
  listStatementDays,
  listStatementVersions,
  readBookDay,
  readStatementAccount,
  renderStatement,
  statementConnection,
  type StatementDay,
} from "@/lib/statements/read";
import { statementHash } from "@/lib/statements/render";
import type {
  LatePosting,
  PublishedStatement,
  StatementDocument,
  StatementLine,
} from "@/lib/statements/types";

/** The one bigint -> number narrowing on this screen. Refuses, never rounds. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} cents is past Number.MAX_SAFE_INTEGER; widen before rendering it`,
    );
  }
  return Number(value);
}

function toLine(line: StatementLine): ClientStatementLine {
  return {
    id: `${line.bookingSeq}:${line.ordinal}`,
    entryId: line.entryId,
    valueDate: line.valueDate,
    entryType: line.entryType,
    description: line.description,
    reversesEntryId: line.reversesEntryId,
    correctionGroupId: line.correctionGroupId,
    amountCents: toCents(line.signedCents),
    runningBalanceCents: toCents(line.runningBalanceCents),
  };
}

function toPeriod(day: StatementDay): ClientStatementPeriod {
  return {
    businessDate: day.businessDate,
    closedAt: day.closedAt,
    closeWatermark: toCents(day.bookingWatermark),
    versionCount: day.versionCount,
    lineCount: day.lineCount,
    latePostingCount: day.latePostingCount,
  };
}

function toLatePosting(posting: LatePosting): ClientLatePosting {
  return {
    entryId: posting.entryId,
    valueDate: posting.valueDate,
    description: posting.description,
    amountCents: toCents(posting.signedCents),
    affectsOpening: posting.affectsOpening,
  };
}

/**
 * The corrections visible ON this document, in the document's own order.
 *
 * A grouping of lines the library rendered, keyed by the ledger's own
 * `correction_group_id`. A group is a correction when it contains at least one
 * line that is not an `original` — that is, a reversal or a re-book actually
 * landed. Every ordinary entry carries a group id too (it is the entry's own
 * lineage handle), so without that test every line on the statement would be
 * announced as a correction.
 *
 * No amounts are added here. The three lines carry the library's own figures
 * and the running balance beside them is the library's fold; the net effect is
 * already in the closing balance.
 */
function correctionsIn(doc: StatementDocument): readonly ClientCorrection[] {
  const groups = new Map<string, StatementLine[]>();
  for (const line of doc.lines) {
    if (line.correctionGroupId === null) continue;
    const bucket = groups.get(line.correctionGroupId);
    if (bucket === undefined) groups.set(line.correctionGroupId, [line]);
    else bucket.push(line);
  }

  const out: ClientCorrection[] = [];
  for (const [correctionGroupId, lines] of groups) {
    if (!lines.some((l) => l.entryType !== "original")) continue;
    out.push({ correctionGroupId, lines: lines.map(toLine) });
  }
  return out;
}

/**
 * Render the same rectangle twice, at two instants, and hash both.
 *
 * This is the gauntlet's item 7 done on the page rather than described on it.
 * Two independent round trips to Postgres, two independent renderings, two
 * hashes taken by the library's canonical hasher. If they differ, the screen
 * says so — which would mean the frozen watermark was not frozen, and that is
 * a P1, not a number to print with a checkmark next to it.
 */
async function reproduce(
  args: {
    readonly accountId: string;
    readonly businessDate: string;
    readonly watermark: bigint;
    readonly firstRendering: StatementDocument;
    readonly storedHash: string | null;
    readonly formatChanged: boolean;
  },
  conn: Sql,
): Promise<ClientReproduction> {
  const firstAt = new Date().toISOString();
  const renderedHash = statementHash(args.firstRendering);

  const again = await renderStatement(
    {
      accountId: args.accountId,
      periodStart: args.businessDate,
      periodEnd: args.businessDate,
      bookingWatermark: args.watermark,
    },
    conn,
  );
  const secondAt = new Date().toISOString();
  const renderedAgainHash = statementHash(again);

  return {
    firstAt,
    secondAt,
    renderedHash,
    renderedAgainHash,
    identical: renderedHash === renderedAgainHash,
    storedHash: args.storedHash,
    matchesStoredHash:
      args.storedHash === null ? null : args.storedHash === renderedHash,
    formatChanged: args.formatChanged,
  };
}

function toEarlierVersions(
  versions: readonly PublishedStatement[],
  current: number,
): ClientStatementDocument["earlierVersions"] {
  return versions
    .filter((v) => v.version < current)
    .map((v) => ({
      version: v.version,
      issuedAt: v.generatedAt,
      closingBalanceCents: toCents(v.closingBalanceCents),
    }));
}

/**
 * The document for one closed day.
 *
 * Two anchors and the screen never blurs them — see the contract's note.
 * `"issued"` goes through `compareStatement`, which re-derives the published
 * document at its own watermark and verifies the stored hash; `"closed"`
 * renders at the close watermark and reports that nothing was issued.
 *
 * The version chosen for `"issued"` is the LATEST, not v1. The operator
 * console defaults to v1 deliberately — the divergence from today is its story.
 * A customer's story is the opposite one: the statement for this day is the
 * most recent one their bank issued, and the earlier versions are its lineage,
 * listed underneath.
 */
async function readDocument(
  args: {
    readonly accountId: string;
    readonly entityId: string;
    readonly period: ClientStatementPeriod;
  },
  conn: Sql,
): Promise<ClientStatementDocument> {
  const { accountId, period } = args;
  const businessDate = period.businessDate;

  const versions = await listStatementVersions(
    { accountId, periodStart: businessDate, periodEnd: businessDate },
    conn,
  );
  const latest = versions[versions.length - 1];

  if (latest !== undefined) {
    const comparison = await compareStatement(
      { accountId, businessDate, version: latest.version },
      conn,
    );
    if (comparison === null) {
      throw new Error(
        `statement versions for ${businessDate} vanished between two reads`,
      );
    }

    const doc = comparison.publishedDocument;
    return {
      businessDate,
      anchor: "issued",
      watermark: toCents(comparison.published.bookingWatermark),
      closedAt: period.closedAt,
      version: comparison.published.version,
      issuedAt: comparison.published.generatedAt,
      openingBalanceCents: toCents(doc.openingBalanceCents),
      closingBalanceCents: toCents(doc.closingBalanceCents),
      lineCount: doc.lineCount,
      lines: doc.lines.map(toLine),
      corrections: correctionsIn(doc),
      reproduction: await reproduce(
        {
          accountId,
          businessDate,
          watermark: comparison.published.bookingWatermark,
          firstRendering: doc,
          storedHash: comparison.published.contentHash,
          formatChanged: comparison.formatChanged,
        },
        conn,
      ),
      earlierVersions: toEarlierVersions(comparison.versions, comparison.published.version),
      movedSince: comparison.latePostings.map(toLatePosting),
      movedSinceCents: toCents(comparison.deltaCents),
    };
  }

  // Closed, never issued. The watermark is still frozen, so the document is
  // still reproducible forever — it was simply never sent, and the screen says
  // exactly that instead of presenting a derivation as a published statement.
  const bookDay = await readBookDay(args.entityId, businessDate, conn);
  if (bookDay === null) {
    throw new Error(`${businessDate} is not a closed day on this book`);
  }

  const doc = await renderStatement(
    {
      accountId,
      periodStart: businessDate,
      periodEnd: businessDate,
      bookingWatermark: bookDay.bookingWatermark,
    },
    conn,
  );
  const late = await listLatePostings(
    {
      accountId,
      periodStart: businessDate,
      periodEnd: businessDate,
      sinceWatermark: bookDay.bookingWatermark,
    },
    conn,
  );

  return {
    businessDate,
    anchor: "closed",
    watermark: toCents(bookDay.bookingWatermark),
    closedAt: bookDay.closedAt,
    version: null,
    issuedAt: null,
    openingBalanceCents: toCents(doc.openingBalanceCents),
    closingBalanceCents: toCents(doc.closingBalanceCents),
    lineCount: doc.lineCount,
    lines: doc.lines.map(toLine),
    corrections: correctionsIn(doc),
    reproduction: await reproduce(
      {
        accountId,
        businessDate,
        watermark: bookDay.bookingWatermark,
        firstRendering: doc,
        storedHash: null,
        formatChanged: false,
      },
      conn,
    ),
    earlierVersions: [],
    movedSince: late.map(toLatePosting),
    // Not computed. `compareStatement` was not asked for this anchor, and this
    // module does not subtract two closing balances and call the answer a
    // library figure.
    movedSinceCents: null,
  };
}

/**
 * Which period to open on, when the URL does not name a valid one.
 *
 * Newest ISSUED day first, because a customer opening their statements wants
 * the statement they were last sent. Then the newest closed day with activity,
 * then the newest closed day at all. The requested date wins only if it is
 * ON THIS ACCOUNT'S LIST — a date from a query string is never passed through.
 */
function pickPeriod(
  periods: readonly ClientStatementPeriod[],
  wanted: string | null,
): ClientStatementPeriod | null {
  if (wanted !== null) {
    const named = periods.find((p) => p.businessDate === wanted);
    if (named !== undefined) return named;
  }
  return (
    periods.find((p) => p.versionCount > 0) ??
    periods.find((p) => p.lineCount > 0) ??
    periods[0] ??
    null
  );
}

/** Names only, for the demo switcher. No figure on this screen comes from it. */
async function businessRefs(conn: Sql): Promise<readonly BusinessRef[]> {
  const rows = await listBusinesses(conn);
  return rows.map((b) => ({
    id: b.businessId,
    legalName: b.legalName,
    hasAccount: b.depositAccountId !== null,
  }));
}

export async function readClientStatements(
  businessId: string | null,
  businessDate: string | null,
): Promise<Loaded<ClientStatementsScreen>> {
  const conn = await statementConnection();
  const asOf = new Date().toISOString();

  const businesses = await businessRefs(conn);
  const wanted =
    (businessId === null ? null : await findBusiness(businessId, conn)) ??
    // A uuid that names nothing falls back to a customer; it never widens to
    // "every business", which is the failure mode that matters here.
    (await firstWithAccount(businesses, conn));

  if (wanted === null) {
    return {
      ok: false,
      code: "NO_BUSINESS",
      message: "There is no business on this book yet.",
    };
  }

  const accountId = wanted.depositAccountId;
  if (accountId === null || !wanted.depositOpen) {
    return {
      ok: true,
      value: {
        live: true,
        asOf,
        businesses,
        businessId: wanted.businessId,
        legalName: wanted.legalName,
        accountName: null,
        periods: [],
        selected: null,
        notice:
          "This business has no open account yet, so there are no statements to show.",
      },
    };
  }

  const account = await readStatementAccount(accountId, conn);
  if (account === null) {
    return {
      ok: false,
      code: "NO_ACCOUNT",
      message: "That account could not be read.",
    };
  }

  const days = await listStatementDays(
    { accountId: account.accountId, entityId: account.entityId },
    conn,
  );
  const periods = days.map(toPeriod);
  const period = pickPeriod(periods, businessDate);

  const selected =
    period === null
      ? null
      : await readDocument(
          { accountId: account.accountId, entityId: account.entityId, period },
          conn,
        );

  return {
    ok: true,
    value: {
      live: true,
      asOf,
      businesses,
      businessId: wanted.businessId,
      legalName: account.legalName,
      accountName: account.accountName,
      periods,
      selected,
      notice:
        periods.length === 0
          ? "No business day has been closed yet for this account, so no statement exists."
          : null,
    },
  };
}

/** The first customer with money, resolved by id so the read stays scoped. */
async function firstWithAccount(
  businesses: readonly BusinessRef[],
  conn: Sql,
): Promise<Awaited<ReturnType<typeof findBusiness>>> {
  const candidate = businesses.find((b) => b.hasAccount) ?? businesses[0];
  if (candidate === undefined) return null;
  return findBusiness(candidate.id, conn);
}
