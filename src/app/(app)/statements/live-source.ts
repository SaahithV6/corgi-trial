import "server-only";

/**
 * BOTH TIME AXES, FOR ONE VALUE DATE, DERIVED AT REQUEST TIME.
 *
 * ===========================================================================
 * WHAT THIS MODULE IS
 * ===========================================================================
 *
 * The live implementation of `StatementsScreenSource`. It answers one
 * question, in the two ways the brief demands they be answerable at once:
 *
 *   as corrected   what this value date closes at using everything we have
 *                  learned — the reversal booked on Thursday counts towards
 *                  Tuesday, because the reversal carries Tuesday's value date.
 *   as believed    what the same value date closed at when read at an EARLIER
 *                  booking watermark — what we would have told you then.
 *
 * Both are `renderStatement()` — the same function, the same rows, the same
 * canonical form, the same hash — with one argument changed. That is the whole
 * design and the screen says so out loud: `value_date` chooses which business
 * days count, `booking_seq` chooses what we had learned by then, and moving
 * only the second is what produces the two figures.
 *
 * ===========================================================================
 * NOTHING HERE IS STORED
 * ===========================================================================
 *
 * Neither figure is read out of a column. `statement.closing_balance_cents`
 * exists and is honest — it is the as-published figure, and it must stay
 * queryable exactly as issued — but it is shown on this screen as a CROSS
 * CHECK beside the re-derived fold, never as the source. A stored statement
 * figure that the ledger can no longer reproduce is the stored lie this whole
 * track exists to avoid, so the screen's job is to re-derive and then show
 * that the two agree.
 *
 * ===========================================================================
 * WHY THE DAY DOES NOT HAVE TO BE CLOSED
 * ===========================================================================
 *
 * `src/lib/statements/screen.ts` answers for (closed day, published
 * statement), which is the right shape for the customer-facing document and
 * the wrong shape for the demo the brief actually describes. A merchant
 * reverses a settlement at 14:00 and the corrected position exists at 14:01,
 * on a day nobody has closed yet. A screen that could only show that tomorrow
 * would be a screen that cannot show the thing it is for.
 *
 * So the ANCHOR is resolved per day, strongest first:
 *
 *   published -> the watermark a document was issued at   (a closed, stated day)
 *   close     -> the watermark the day was frozen at      (a closed day)
 *   before    -> the sequence before this day's most recent correcting act
 *   now       -> nothing earlier exists; the two readings are the same reading
 *
 * `before` is the one that makes an open day answerable, and it is not a
 * weaker claim: `(period, watermark)` reproduces forever whether or not
 * anybody issued a document at it, because every row at or below a watermark
 * is immutable and no row can appear below it later.
 *
 * ===========================================================================
 * WHERE IT LIVES, AND WHAT IT MAY NOT DO
 * ===========================================================================
 *
 * Under `src/app/(app)/statements/` rather than in `src/lib/`, for the same
 * reason `funding/live-source.ts` and `payments/live-source.ts` are: those
 * modules are owned by other workers on this build. It therefore writes NO SQL
 * of its own — every read below is a named reader out of
 * `src/lib/statements/read.ts`, `src/lib/statements/compare.ts` or
 * `src/lib/ledger/**`, which is also what keeps `src/lib/ledger/boundary.test.ts`
 * green. Composition, not a fifth definition of a balance.
 */

import type {
  AccountOption,
  AnchorOptionView,
  BelievedAnchor,
  BothReadingsView,
  CorrectionGroupView,
  DayOption,
  DocumentView,
  LatePostingView,
  PublishedStatementView,
  ReadingView,
  StatementLineView,
  StatementsScreenQuery,
  StatementsScreenView,
} from "@/components/statements/data-contract";
import type { Sql } from "@/lib/ledger/db";
import { readSnapshot } from "@/lib/ledger/balance-definitions";
import { explainsDelta, groupLatePostings } from "@/lib/statements/compare";
import { verifyStatement } from "@/lib/statements/publish";
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
import { loadStatementsView } from "@/lib/statements/screen";
import type {
  LatePosting,
  PublishedStatement,
  StatementDocument,
  StatementLine,
} from "@/lib/statements/types";
import { fail, isErr, ok, type ErrorShape, type Result } from "@/lib/result";

/**
 * How far back to look for a corrected day when the URL names none.
 *
 * Bounded on the VALUE axis, so the scan is one indexed range over one
 * account's lines rather than a walk of its history. Long enough to find the
 * correction a debrief just produced; short enough that the query stays a
 * query.
 */
const CORRECTION_LOOKBACK_DAYS = 45;

/** The one bigint -> number narrowing in this module. Refuses, never rounds. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} cents is past Number.MAX_SAFE_INTEGER; widen Cents to bigint before rendering it`,
    );
  }
  return Number(value);
}

/** `YYYY-MM-DD` minus n days, on the value axis. No timezone, no clock. */
function minusDays(valueDate: string, days: number): string {
  const [y, m, d] = valueDate.split("-").map((part) => Number.parseInt(part, 10));
  const shifted = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - days));
  return shifted.toISOString().slice(0, 10);
}

function toDocument(doc: StatementDocument, anchorWatermark: bigint): DocumentView {
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
        // On the as-believed document this is false for every line by
        // construction: nothing above the anchor is in it.
        late: l.bookingSeq > anchorWatermark,
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
 * The most recent value date this account reversed or re-booked, if any.
 *
 * One render over a bounded value-date window at the live watermark, then a
 * scan of its lines for an `entry_type` that is not `original`. The lines come
 * back in `(value date, booking seq, ordinal)` order — the same total order
 * the content hash is taken over — so the LAST such line is the latest
 * corrected day, and no second query is needed to find it.
 */
async function findCorrectedDay(
  args: {
    readonly accountId: string;
    readonly today: string;
    readonly watermark: bigint;
  },
  conn: Sql,
): Promise<string | null> {
  const doc = await renderStatement(
    {
      accountId: args.accountId,
      periodStart: minusDays(args.today, CORRECTION_LOOKBACK_DAYS),
      periodEnd: args.today,
      bookingWatermark: args.watermark,
    },
    conn,
  );

  let latest: string | null = null;
  for (const line of doc.lines) {
    if (line.entryType !== "original") latest = line.valueDate;
  }
  return latest;
}

/**
 * The sequence immediately before this day's MOST RECENT correcting act.
 *
 * `null` when the day carries no correction at all — in which case there is no
 * "before" to stand at, and the screen says the two readings are the same
 * reading rather than manufacturing a difference.
 *
 * MOST RECENT, NOT FIRST, AND THAT IS THE WHOLE CHOICE. "What did we believe
 * before the correction landed" is a question about the correction that just
 * landed. On a book with one correction a day the two readings of the phrase
 * coincide; on a demo book that has driven the same reversal twenty times,
 * anchoring at the first of them answers a question nobody asked and buries
 * the act being demonstrated under nineteen others. Anchoring at the last one
 * is also exactly what `coreloop.mjs` leg 6 asserts against: the balance read
 * at the ORIGINAL entry's sequence, one instant before its reversal.
 *
 * A correction is an ACT, not an entry — a reversal and its re-book are one —
 * so the anchor is placed before the FIRST correcting entry of the last act,
 * never between a reversal and the re-book that completes it. The act's own
 * original is deliberately left BELOW the anchor: it is what we believed, and
 * standing before it too would net the whole episode to nothing and show a
 * difference of zero for a day that was visibly corrected.
 *
 * Derived from the as-corrected document rather than from a second query, so
 * the anchor and the figure it is compared against are one read of one
 * rectangle. A correction BACKDATED to an earlier value date does not appear
 * in these lines — it moved the opening balance instead — and that case is
 * caught downstream: the acts list is value-date `<=` the period, and
 * `explainsDelta` fails loudly if the itemisation misses anything.
 */
function seqBeforeLatestCorrection(doc: StatementDocument): bigint | null {
  let latest: StatementLine | null = null;
  for (const line of doc.lines) {
    if (line.entryType === "original") continue;
    if (latest === null || line.bookingSeq > latest.bookingSeq) latest = line;
  }
  if (latest === null) return null;

  let first = latest.bookingSeq;
  if (latest.correctionGroupId !== null) {
    for (const line of doc.lines) {
      if (line.entryType === "original") continue;
      if (line.correctionGroupId !== latest.correctionGroupId) continue;
      if (line.bookingSeq < first) first = line.bookingSeq;
    }
  }
  return first - 1n;
}

function anchorOption(
  anchor: BelievedAnchor,
  label: string,
  watermark: bigint | null,
  note: string,
): AnchorOptionView {
  return {
    anchor,
    label,
    available: watermark !== null,
    bookingWatermark: watermark === null ? null : toCents(watermark),
    note,
  };
}

/**
 * Load the screen.
 *
 * One entry point, so the pickers, both documents and the itemised difference
 * are consistent as of ONE read rather than four that could interleave with a
 * webhook draining in another process. The live watermark in particular is
 * read once and used as the ceiling for the corrected document AND for the
 * acts that explain it — letting each take its own `MAX(booking_seq)` would
 * let an entry commit between them and appear in the explanation but not in
 * the figure it is supposed to explain, on a screen whose entire job is to
 * show that the two reconcile.
 */
export async function loadStatementsScreen(
  query: StatementsScreenQuery = {},
): Promise<Result<StatementsScreenView, ErrorShape>> {
  try {
    const conn = await statementConnection();

    // The account list and the default account come from the existing screen
    // module: "which books exist, and which one is worth opening on" is its
    // answer already, it is tested, and re-deriving it here would be a second
    // definition of the same thing.
    const base = await loadStatementsView({
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.businessDate === undefined ? {} : { businessDate: query.businessDate }),
    });
    if (isErr(base)) return base;

    const accounts: readonly AccountOption[] = base.value.accounts;
    const account = base.value.account;
    const snapshot = await readSnapshot(conn);
    const asOf = snapshot.asOf.toISOString();

    if (account === null) {
      return ok({ source: "live", asOf, accounts, account: null, days: [], readings: null });
    }

    const resolved = await readStatementAccount(account.accountId, conn);
    if (resolved === null) {
      return fail("STATEMENT_ACCOUNT_UNKNOWN", `no deposit account ${account.accountId}`);
    }

    const accountId = resolved.accountId;
    const now = snapshot.bookingWatermark;
    const closedDays = await listStatementDays(
      { accountId, entityId: resolved.entityId },
      conn,
    );

    const valueDate = await resolveValueDate(
      {
        accountId,
        today: snapshot.valueDate,
        watermark: now,
        closedDays,
        ...(query.businessDate === undefined ? {} : { businessDate: query.businessDate }),
        preferCorrected: query.preferCorrected === true,
      },
      conn,
    );

    const readings = await readBothAxes(
      {
        accountId,
        entityId: resolved.entityId,
        valueDate,
        watermark: now,
        ...(query.version === undefined ? {} : { version: query.version }),
        ...(query.anchor === undefined ? {} : { anchor: query.anchor }),
      },
      conn,
    );

    return ok({
      source: "live",
      asOf,
      accounts,
      account,
      days: closedDays.map(toDayOption),
      readings,
    });
  } catch (thrown) {
    // A read failure is a VALUE, so the screen's error state is a branch and
    // not a boundary. Nothing moved: this path holds no capability to write,
    // and the panel says so rather than asking for trust.
    return fail(
      "STATEMENT_READ_FAILED",
      thrown instanceof Error ? thrown.message : "the statement query failed",
    );
  }
}

/**
 * Which value date to open on.
 *
 * The URL wins, always and verbatim, including for a day nobody has closed —
 * that is the entire point, and it is what makes a correction that landed this
 * morning linkable. Otherwise, in order: the corrected day when the caller
 * asked for one (`?state=edge`), the newest closed day with a statement, the
 * newest closed day with activity, the most recently corrected day, and
 * finally today in book time.
 */
async function resolveValueDate(
  args: {
    readonly accountId: string;
    readonly today: string;
    readonly watermark: bigint;
    readonly closedDays: readonly StatementDay[];
    readonly businessDate?: string;
    readonly preferCorrected: boolean;
  },
  conn: Sql,
): Promise<string> {
  if (args.businessDate !== undefined) return args.businessDate;

  const corrected = args.preferCorrected
    ? await findCorrectedDay(
        { accountId: args.accountId, today: args.today, watermark: args.watermark },
        conn,
      )
    : null;
  if (corrected !== null) return corrected;

  const stated = args.closedDays.find((d) => d.versionCount > 0);
  if (stated !== undefined) return stated.businessDate;

  const active = args.closedDays.find((d) => d.lineCount > 0);
  if (active !== undefined) return active.businessDate;

  const anyCorrection = await findCorrectedDay(
    { accountId: args.accountId, today: args.today, watermark: args.watermark },
    conn,
  );
  return anyCorrection ?? args.closedDays[0]?.businessDate ?? args.today;
}

/**
 * The two readings of one value date.
 *
 * Order of operations matters and is worth stating: the corrected document is
 * rendered FIRST, because the anchor for an open day is derived from it, and
 * then the believed document is rendered at that anchor. Both are the same
 * call with a different watermark.
 */
async function readBothAxes(
  args: {
    readonly accountId: string;
    readonly entityId: string;
    readonly valueDate: string;
    readonly watermark: bigint;
    readonly version?: number;
    readonly anchor?: BelievedAnchor;
  },
  conn: Sql,
): Promise<BothReadingsView> {
  const period = {
    accountId: args.accountId,
    periodStart: args.valueDate,
    periodEnd: args.valueDate,
  };

  const [correctedDoc, bookDay, versionRows] = await Promise.all([
    renderStatement({ ...period, bookingWatermark: args.watermark }, conn),
    readBookDay(args.entityId, args.valueDate, conn),
    listStatementVersions(period, conn),
  ]);

  // v1 by default: it is the document that went out, the one a customer could
  // be holding, and the one whose divergence from today is the story. A named
  // version that does not exist falls back rather than throwing, for the same
  // reason a mistyped date does.
  const selectedVersion =
    (args.version === undefined
      ? undefined
      : versionRows.find((v) => v.version === args.version)) ?? versionRows[0];

  const beforeSeq = seqBeforeLatestCorrection(correctedDoc);

  const anchors: readonly AnchorOptionView[] = [
    anchorOption(
      "published",
      "As published",
      selectedVersion?.bookingWatermark ?? null,
      selectedVersion === undefined
        ? "No statement has been issued for this day, so there is no as-published document to stand on."
        : `The booking watermark v${selectedVersion.version} was issued against. Its stored hash makes this reading checkable by somebody who does not trust us.`,
    ),
    anchorOption(
      "close",
      "At the close",
      bookDay?.bookingWatermark ?? null,
      bookDay === null
        ? "This business day has not been closed, so no watermark was frozen for it."
        : "The watermark this business day was frozen at. Everything after it is a late posting by definition.",
    ),
    anchorOption(
      "before",
      "Before the correction",
      beforeSeq,
      beforeSeq === null
        ? "Nothing with this value date has been reversed or re-booked, so there is no moment before a correction."
        : "The sequence immediately before this day's most recent correcting act landed — what we believed one instant earlier.",
    ),
    anchorOption(
      "now",
      "Everything we know",
      args.watermark,
      "The same watermark as the right-hand column. Both readings become one reading, which is the honest answer when nothing has corrected this day.",
    ),
  ];

  const requested = args.anchor === undefined ? undefined : anchors.find((a) => a.anchor === args.anchor);
  const chosen =
    (requested?.available === true ? requested : undefined) ??
    anchors.find((a) => a.available) ??
    anchors[anchors.length - 1];

  const anchor: BelievedAnchor = chosen?.anchor ?? "now";
  const anchorSeq =
    anchor === "published"
      ? (selectedVersion?.bookingWatermark ?? args.watermark)
      : anchor === "close"
        ? (bookDay?.bookingWatermark ?? args.watermark)
        : anchor === "before"
          ? (beforeSeq ?? args.watermark)
          : args.watermark;

  // When the anchor is a published document, the as-believed side is not
  // rendered a second time: `verifyStatement` re-derives it from the ledger at
  // its own frozen watermark and hands back the document AND whether it hashed
  // to the stored value. Re-deriving it separately would be the same rows and
  // one fewer piece of evidence.
  const verification =
    anchor === "published" && selectedVersion !== undefined
      ? await verifyStatement(selectedVersion.statementId, conn)
      : null;

  const believedDoc =
    verification?.document ??
    (await renderStatement({ ...period, bookingWatermark: anchorSeq }, conn));

  const allActs = await listLatePostings({ ...period, sinceWatermark: anchorSeq }, conn);
  const acts = allActs.filter((p) => p.bookingSeq <= args.watermark);

  const deltaCents = correctedDoc.closingBalanceCents - believedDoc.closingBalanceCents;

  const actorNames = await readActorNames(
    versionRows.map((v) => v.generatedBy),
    conn,
  );

  const learnedAt = acts.reduce<string | null>(
    (earliest, p) => (earliest === null || p.bookingTime < earliest ? p.bookingTime : earliest),
    null,
  );

  const believed: ReadingView = {
    label: anchor === "published" ? "As published" : "As believed",
    bookingWatermark: toCents(believedDoc.bookingWatermark),
    closingBalanceCents: toCents(believedDoc.closingBalanceCents),
    document: toDocument(believedDoc, anchorSeq),
    contentHash: verification?.recomputedHash ?? statementHash(believedDoc),
  };

  const corrected: ReadingView = {
    label: "As corrected",
    bookingWatermark: toCents(correctedDoc.bookingWatermark),
    closingBalanceCents: toCents(correctedDoc.closingBalanceCents),
    document: toDocument(correctedDoc, anchorSeq),
    contentHash: statementHash(correctedDoc),
  };

  const groups: readonly CorrectionGroupView[] = groupLatePostings(acts).map(
    (g, index): CorrectionGroupView => ({
      id: g.correctionGroupId ?? `entry:${g.postings[0]?.entryId ?? index}`,
      correctionGroupId: g.correctionGroupId,
      isCorrection: g.isCorrection,
      netCents: toCents(g.netCents),
      postings: g.postings.map(toLatePosting),
    }),
  );

  return {
    valueDate: args.valueDate,
    closedAt: bookDay?.closedAt ?? null,
    closeWatermark: bookDay === null ? null : toCents(bookDay.bookingWatermark),
    anchor,
    anchors,
    believed,
    corrected,
    deltaCents: toCents(deltaCents),
    differs: deltaCents !== 0n,
    explained: explainsDelta(deltaCents, acts),
    acts: groups,
    learnedAt,
    published:
      anchor === "published" && selectedVersion !== undefined
        ? toPublishedView(selectedVersion, actorNames)
        : null,
    reproduced: verification?.reproduced ?? false,
    formatChanged: verification?.formatChanged ?? false,
    versions: versionRows.map((v) => toPublishedView(v, actorNames)),
  };
}

/**
 * Whether a database is configured at all.
 *
 * Read off the raw env rather than `src/lib/env.ts`, which throws on a missing
 * key at import time — "no database configured" has to be a renderable state,
 * not a crash.
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.trim() !== "";
}
