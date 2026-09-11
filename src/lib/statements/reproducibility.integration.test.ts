/**
 * REPRODUCIBILITY, AGAINST WHAT WAS ACTUALLY PUBLISHED ON THIS BOOK.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS ALONGSIDE `statements.integration.test.ts`
 * ---------------------------------------------------------------------------
 *
 * That suite proves the property on a day it BUILDS: it closes a synthetic
 * 1980s day inside a rolled-back transaction, publishes v1, mutates the book
 * underneath it and shows the document does not move. That is the right way to
 * prove the mechanism and it is not the claim the brief makes.
 *
 * The brief's claim is about the documents this book has ALREADY ISSUED:
 *
 *     "A closed day's statement is reproducible forever, corrections
 *      included, identical every time."
 *
 * "Forever" is a claim about rows that were written weeks ago by code that has
 * changed since, not about a fixture minted four lines up. So this file takes
 * every `statement` row on the live database, re-derives it from scratch, and
 * asserts the result is byte-identical to what was published — and does it
 * TWICE, at two different instants, because "identical every time" is a claim
 * about repetition and one render cannot make it.
 *
 * ---------------------------------------------------------------------------
 * WHAT "BYTE-IDENTICAL" IS ASSERTED ABOUT
 * ---------------------------------------------------------------------------
 *
 * Hashes agreeing proves equality of whatever was hashed, which is weak on its
 * own. So all four are compared, in this order:
 *
 *   figures    opening, closing, line count, watermark
 *   ordering   the (value_date, booking_seq, ordinal) sequence, as a list
 *   preimage   `canonicalStatement()` — the netstring bytes themselves
 *   hash       `statementHash()` against the stored `content_hash`
 *
 * The preimage comparison is the load-bearing one. Two renders producing the
 * same digest from different bytes is a sha256 collision; two renders producing
 * different bytes that a weak comparison calls equal is a bug, and this file is
 * looking for the second.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE WRITES
 * ---------------------------------------------------------------------------
 *
 * No transaction, no rollback, no teardown, because there is nothing to tear
 * down: every call below is a SELECT. A closed day and a published statement
 * are both permanent on this book, so a reproducibility suite that had to
 * publish something in order to check reproducibility would add a permanent row
 * on every run — which is how this book acquired 62 statements and 101 book
 * days. It re-derives what is already there instead.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD THIS PAIRS WITH
 * ---------------------------------------------------------------------------
 *
 * `v_statement_content_drift` (migration 0059, gated in `scripts/dbcheck.mjs`
 * and `src/lib/chaos/invariants.ts`) owns the other half: it re-derives the
 * RECTANGLE — opening, line count, closing — from `journal_line` at each
 * statement's own watermark, in SQL, on every `pnpm db:check`. It deliberately
 * does not recompute the hash, because the canonical rendering has exactly one
 * definition and it is `render.ts`; a second one in SQL would be the defect
 * 0022 exists to have ended.
 *
 * So: the view says the rows have not moved, on every check, forever. This file
 * says the bytes are the same, against the one implementation of the bytes.
 * Neither is sufficient alone and the pair is the proof.
 *
 *     set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run src/lib/statements
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { Sql } from "@/lib/ledger/queries";

import type * as ReadModule from "./read";
import type * as RenderModule from "./render";
import type { StatementDocument } from "./types";

const READY =
  process.env["RUN_DB_TESTS"] === "1" &&
  typeof process.env["APP_DATABASE_URL"] === "string";
const d = READY ? describe : describe.skip;

/**
 * One published statement, as the table holds it.
 *
 * `content_hash` comes back as hex from the database rather than as a Buffer,
 * so the comparison below is string-to-string and no encoding step sits between
 * the two things being compared.
 */
interface PublishedRow {
  readonly statement_id: string;
  readonly account_id: string;
  readonly period_start: string;
  readonly period_end: string;
  readonly version: number;
  readonly booking_watermark: string;
  readonly opening_balance_cents: string;
  readonly closing_balance_cents: string;
  readonly line_count: number;
  readonly content_hash: string;
  readonly format: string;
  readonly correction_lines: string;
}

/** The ordering assertion, as a comparable list. Not a count — a sequence. */
function ordering(doc: StatementDocument): readonly string[] {
  return doc.lines.map(
    (l) => `${l.valueDate}/${l.bookingSeq}/${l.ordinal}/${l.signedCents}`,
  );
}

d("a published statement re-derives identically, forever", () => {
  let sql: Sql;
  let read: typeof ReadModule;
  let render: typeof RenderModule;
  let published: readonly PublishedRow[] = [];

  beforeAll(async () => {
    ({ sql } = (await import("@/lib/ledger/db")) as unknown as { sql: Sql });
    read = await import("./read");
    render = await import("./render");

    // EVERY ROW, in a total order so two runs read the same list in the same
    // sequence. `correction_lines` comes from 0059's census rather than being
    // recounted here: the census is what `v_statement_content_drift` judges, so
    // this suite and the gated view agree on what "contains a correction" means
    // by construction instead of by two definitions that could drift apart.
    published = await sql.unsafe<PublishedRow[]>(`
      SELECT r.statement_id, r.account_id,
             to_char(r.period_start, 'YYYY-MM-DD')  AS period_start,
             to_char(r.period_end,   'YYYY-MM-DD')  AS period_end,
             r.version,
             r.booking_watermark::text              AS booking_watermark,
             r.published_opening_cents::text        AS opening_balance_cents,
             r.published_closing_cents::text        AS closing_balance_cents,
             r.published_line_count                 AS line_count,
             encode(s.content_hash, 'hex')          AS content_hash,
             r.format,
             r.correction_lines::text               AS correction_lines
        FROM v_statement_rederived r
        JOIN statement s ON s.id = r.statement_id
       ORDER BY r.account_id, r.period_start, r.version`);
  }, 60_000);

  it("has statements to re-derive, and says how many", () => {
    // A suite that silently passed over an empty list would be the shape this
    // whole build catalogues: a green tick standing for nothing.
    expect(published.length).toBeGreaterThan(0);
    const withCorrections = published.filter((r) => BigInt(r.correction_lines) > 0n);
    // eslint-disable-next-line no-console
    console.log(
      `  re-deriving ${published.length} published statement(s); ` +
        `${withCorrections.length} of them contain at least one correction line ` +
        `(${published.reduce((n, r) => n + BigInt(r.correction_lines), 0n)} lines in all)`,
    );
    // "Corrections included" is half the brief's clause. If nothing on this
    // book carried a correction, everything below would be green and the half
    // would still be unproven — so the coverage is asserted, not reported.
    expect(withCorrections.length).toBeGreaterThan(0);
  });

  it("re-renders byte-identically, twice, at two different instants", async () => {
    let compared = 0;
    for (const row of published) {
      const request = {
        accountId: row.account_id,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        bookingWatermark: BigInt(row.booking_watermark),
      };

      // TWO RENDERS, and the second is NOT a copy of the first: it is a second
      // round trip to the database, issued later, through the same code path.
      // Comparing a value to itself proves nothing.
      const first = await render_doc(request);
      const second = await render_doc(request);

      // 1. FIGURES.
      expect(String(first.openingBalanceCents)).toBe(row.opening_balance_cents);
      expect(String(first.closingBalanceCents)).toBe(row.closing_balance_cents);
      expect(first.lineCount).toBe(row.line_count);
      expect(String(first.bookingWatermark)).toBe(row.booking_watermark);

      // 2. ORDERING, as a sequence rather than a count.
      expect(ordering(second)).toEqual(ordering(first));

      // 3. THE PREIMAGE BYTES. The load-bearing comparison.
      const canonicalA = render.canonicalStatement(first);
      const canonicalB = render.canonicalStatement(second);
      expect(canonicalB).toBe(canonicalA);
      expect(Buffer.byteLength(canonicalB, "utf8")).toBe(
        Buffer.byteLength(canonicalA, "utf8"),
      );

      // 4. THE HASH, against what was published. `statement.format` is checked
      // first: a document rendered under a different format version is a
      // different artefact and must not be compared to this one at all — that
      // is the whole reason the format is the preimage's first field.
      expect(row.format).toBe(render.STATEMENT_FORMAT);
      expect(render.statementHash(first)).toBe(row.content_hash);
      expect(render.statementHash(second)).toBe(row.content_hash);

      compared += 1;
    }
    expect(compared).toBe(published.length);

    async function render_doc(request: ReadModule.RenderRequest) {
      return read.renderStatement(request, sql);
    }
  }, 300_000);

  it("reproduces the Ridgeline 2026-09-08 correction, and keeps reproducing it", async () => {
    // THE NAMED CORRECTION. A wrong settlement, its reversal and the re-book,
    // booked as one group into a day that was already closed. It is the case
    // the brief calls out by hand because it is the one a naive implementation
    // gets wrong in both directions: drop the correction and the statement is
    // stale, re-render at "now" instead of at the pinned watermark and the
    // statement is no longer the document that was issued.
    const GROUP_PREFIX = "e397837a";
    const VALUE_DATE = "2026-09-08";

    const [group] = await sql.unsafe<
      { account_id: string; seqs: string; net_cents: string; entries: string }[]
    >(`
      SELECT l.account_id,
             string_agg(DISTINCT e.booking_seq::text, ',' ORDER BY e.booking_seq::text) AS seqs,
             SUM(l.amount_cents * a.normal_side)::text                                  AS net_cents,
             count(DISTINCT e.id)::text                                                 AS entries
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN account       a ON a.id = l.account_id
       WHERE e.correction_group_id::text LIKE '${GROUP_PREFIX}%'
         AND a.code = '2100' AND a.business_id IS NOT NULL
       GROUP BY l.account_id`);

    // A missing group is a FAILURE, never a skip. The brief names this
    // correction by id; if it is not on the book, the thing being proved is not
    // the thing that was asked for and the suite must say so rather than pass.
    expect(group, `no correction group ${GROUP_PREFIX}… on a customer deposit account`)
      .toBeDefined();
    if (group === undefined) return;

    // eslint-disable-next-line no-console
    console.log(
      `  correction group ${GROUP_PREFIX}…: ${group.entries} entries at booking seqs ` +
        `${group.seqs}, net ${group.net_cents} cents on account ${group.account_id}`,
    );

    // The watermark a statement for that day WOULD pin: the highest booking_seq
    // affecting this account through the period end. Not `now()`, and not the
    // entity watermark — `contentWatermark()` is the one definition of it and
    // this test calls it rather than restating it.
    const watermark = await read.contentWatermark(
      { accountId: group.account_id, periodEnd: VALUE_DATE },
      sql,
    );

    const request = {
      accountId: group.account_id,
      periodStart: VALUE_DATE,
      periodEnd: VALUE_DATE,
      bookingWatermark: watermark,
    };

    const first = await read.renderStatement(request, sql);
    const second = await read.renderStatement(request, sql);

    // THE CORRECTION IS ON THE DOCUMENT. All three legs — the wrong
    // settlement, the reversal and the re-book — are inside the period and
    // below the watermark, so all three are lines, and the position the
    // statement shows is the corrected one because the three of them net to it.
    const seqs = new Set(first.lines.map((l) => String(l.bookingSeq)));
    for (const seq of group.seqs.split(",")) {
      expect(seqs.has(seq), `booking seq ${seq} is not on the ${VALUE_DATE} statement`).toBe(true);
    }
    expect(first.lines.some((l) => l.entryType === "reversal")).toBe(true);
    expect(first.lines.some((l) => l.entryType === "rebook")).toBe(true);

    // AND IT IS REPRODUCIBLE. Same four comparisons as above.
    expect(ordering(second)).toEqual(ordering(first));
    expect(render.canonicalStatement(second)).toBe(render.canonicalStatement(first));
    expect(render.statementHash(second)).toBe(render.statementHash(first));
    expect(String(second.closingBalanceCents)).toBe(String(first.closingBalanceCents));

    // eslint-disable-next-line no-console
    console.log(
      `  ${VALUE_DATE} statement at watermark ${watermark}: ${first.lineCount} line(s), ` +
        `closing ${first.closingBalanceCents} cents, hash ${render.statementHash(first)}`,
    );
  }, 120_000);

  it("the gated view agrees: nothing published has drifted", async () => {
    // The same claim, asked of the database rather than of the renderer. If
    // these two ever disagree, one of them is wrong and the disagreement is the
    // finding — which is why both exist.
    const [row] = await sql.unsafe<{ n: string; pop: string }[]>(`
      SELECT (SELECT count(*) FROM v_statement_content_drift)::text AS n,
             (SELECT count(*) FROM v_statement_rederived)::text     AS pop`);
    expect(row?.n).toBe("0");
    expect(row?.pop).toBe(String(published.length));
  }, 60_000);
});
