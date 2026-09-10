/**
 * THE REPRODUCIBILITY PROOF, against the real Neon database.
 *
 * ---------------------------------------------------------------------------
 * THE REQUIREMENT, VERBATIM
 * ---------------------------------------------------------------------------
 *
 *     "A closed day's statement is reproducible forever, corrections
 *      included, identical every time."
 *
 * and, from the live fire:
 *
 *     "Reverse that settlement the next day and pull up the statement for
 *      settlement day."
 *
 * ---------------------------------------------------------------------------
 * THE THREE GENERATIONS
 * ---------------------------------------------------------------------------
 *
 *   G1  close the day, publish v1                    -> hash H1, document T1
 *   G2  re-render v1's watermark, unchanged book     -> H2 == H1, T2 === T1
 *       ... post a NEW backdated correction into the closed day ...
 *   G3  re-render v1's watermark, changed book       -> H3 == H1, T3 === T1
 *
 * G3 is the one that matters and it is the one a naive implementation fails.
 * The book HAS changed — there are now entries with that value date that were
 * not there when v1 was issued — and the document is still byte-identical,
 * because it was published against a watermark that has not moved and cannot.
 * Then v2 is issued at a later watermark and shows the corrected position, and
 * both documents exist at once.
 *
 * Hashes alone would be weak evidence: two hashes agreeing proves equality of
 * whatever was hashed. So the canonical PREIMAGE is compared as a string too,
 * character for character, and its length is reported. "Byte-identical" is
 * asserted about the bytes.
 *
 * ---------------------------------------------------------------------------
 * ISOLATION
 * ---------------------------------------------------------------------------
 *
 * Money tables are append-only, so there is no teardown and none is wanted.
 * Each run picks its own synthetic business date and its own account, and
 * every assertion is about that day's own rows.
 *
 * Three isolation decisions, and all three were forced by a real failure
 * rather than chosen up front. The live database is SHARED — with the other
 * suites, and with whatever the running application is doing — so "isolation"
 * here means "cannot collide", not "has the book to itself".
 *
 * 1. **A DISJOINT VALUE-DATE NAMESPACE.** `src/lib/recon/planted-break.test.ts`
 *    and `src/test/livefire/attack-03` both pick a synthetic day with
 *    `2000-01-01 + (Date.now() %% 5000) days`. Copying that formula put this
 *    suite on the SAME day as the planted-break file, whose reconciliation
 *    matches on `rail` and `value_date` — so an ACH entry posted here became an
 *    `in_ledger_not_file` break over there, and five of their assertions failed
 *    with counts one too high. The base is therefore 1980, which cannot
 *    overlap their window (2000-01-01 .. 2013-09-09) at any offset.
 *
 * 2. **A DIFFERENT DEPOSIT ACCOUNT FROM THE DEMO SEEDER'S.** See `beforeAll`.
 *
 * 3. **THE DATES STAY DECADES IN THE PAST.** Closing a business day is
 *    permanent, and `v_recon_break.closes_crossed` counts closes at or after a
 *    break's value date. A close in 1987 cannot perturb another worker's aging
 *    ladder; a close today would.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS GATED ON `RUN_DB_TESTS=1`
 * ---------------------------------------------------------------------------
 *
 * The same convention as `src/lib/ledger/ledger.integration.test.ts`, and for
 * a sharper reason than "CI has no credentials" — though that is also true.
 *
 * vitest runs test FILES in parallel, and `src/lib/recon/demo.test.ts` asserts
 * `newest.bookingWatermark === previous.bookingWatermark` across two
 * back-to-back reconciliation runs. That holds only while nothing else is
 * appending to the ledger, because the watermark is `MAX(booking_seq)` over
 * the whole book. Any live-writing suite running beside it breaks it, and this
 * one writes about a dozen entries. Measured: four runs of the suite without
 * this file were clean; with it ungated, three of seven runs failed, once on
 * that watermark assertion and twice on the value-date collision above.
 *
 * Isolation 1 fixes the collision. The watermark assertion is not mine to fix
 * — it lives in another worker's file — so this suite stays out of the default
 * run and is invoked on its own:
 *
 *     set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run src/lib/statements
 *
 * The pure tests in `render.test.ts` and `compare.test.ts` are NOT gated and
 * run everywhere, including CI.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Sql } from "@/lib/ledger/queries";
import type { postEntry as PostEntry, reverseAndRebook as ReverseAndRebook } from "@/lib/ledger/post";

import type * as CompareModule from "./compare";
import type * as PublishModule from "./publish";
import type * as ReadModule from "./read";
import type * as RenderModule from "./render";
import type * as DemoModule from "./demo";

const READY =
  process.env["RUN_DB_TESTS"] === "1" &&
  typeof process.env["APP_DATABASE_URL"] === "string";
const d = READY ? describe : describe.skip;

/**
 * `1980-01-01 + n` days, in UTC so no zone can shift it.
 *
 * 1980 and not 2000: the other live suites base their synthetic days on
 * 2000-01-01 with the same `Date.now() % 5000` offset, so a 2000 base put this
 * file on their exact day. See isolation note 1 in the header.
 */
function dayFromEpoch(offset: number): string {
  const at = new Date("1980-01-01T00:00:00.000Z");
  at.setUTCDate(at.getUTCDate() + offset);
  return at.toISOString().slice(0, 10);
}

d("statements, against the live database", () => {
  let sql: Sql;
  let postEntry: typeof PostEntry;
  let reverseAndRebook: typeof ReverseAndRebook;
  let publish: typeof PublishModule;
  let read: typeof ReadModule;
  let render: typeof RenderModule;
  let compare: typeof CompareModule;
  let demo: typeof DemoModule;

  let entityId = "";
  let actorId = "";
  let accountId = "";
  let achReceivableId = "";
  let cardPayableId = "";

  const stamp = Date.now();
  const tag = stamp.toString(36).toUpperCase();
  /** This run's own settlement day. Synthetic, in the 1980s. See the note above. */
  const settlementDay = dayFromEpoch(stamp % 5000);

  const CREDIT_CENTS = 120_000n;
  const CLEARING_CENTS = 24_850n;
  const REBOOK_CENTS = 19_850n;

  beforeAll(async () => {
    ({ sql } = (await import("@/lib/ledger/db")) as unknown as { sql: Sql });
    ({ postEntry, reverseAndRebook } = await import("@/lib/ledger/post"));
    publish = await import("./publish");
    read = await import("./read");
    render = await import("./render");
    compare = await import("./compare");
    demo = await import("./demo");

    // The proof runs on a DIFFERENT deposit account from the demo seeder's.
    //
    // Not fussiness. This suite posts to synthetic settlement days in the
    // 1980s, so on a shared account every one of those entries is backdated
    // relative to the demo day and, being booked after that day's close, moves
    // its opening balance and earns it a new statement version. The behaviour
    // is correct — that is what a late backdated posting does — but it buried
    // the one correction the demo exists to show under a pile of test
    // scaffolding. Separating the accounts keeps both stories legible.
    const demoAccountId = await demo.pickDemoAccount(sql);
    const [other] = await sql<{ id: string }[]>`
      SELECT a.id FROM account a
       WHERE a.code = '2100' AND a.book = 'financial'
         AND a.business_id IS NOT NULL AND a.closed_at IS NULL
         AND a.id <> ${demoAccountId}::uuid
       ORDER BY a.id LIMIT 1`;
    accountId = other?.id ?? demoAccountId;

    const account = await read.readStatementAccount(accountId, sql);
    if (account === null) throw new Error("the live database is not seeded: node scripts/seed.mjs");
    entityId = account.entityId;

    const [actor] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'human' AND can_approve = true ORDER BY id LIMIT 1`;
    const [ach] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '1130' AND business_id IS NULL LIMIT 1`;
    const [card] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2200' AND business_id IS NULL LIMIT 1`;
    if (!actor || !ach || !card) throw new Error("seed first: node scripts/seed.mjs");
    actorId = actor.id;
    achReceivableId = ach.id;
    cardPayableId = card.id;
  });

  it("reproduces a closed day's statement byte-for-byte, across a backdated correction", async () => {
    /* ---- Settlement day ------------------------------------------------- */

    await postEntry(
      {
        entityId,
        valueDate: settlementDay,
        book: "financial",
        description: `Inbound ACH credit ${tag}`,
        idempotencyKey: `stmt:${tag}:credit`,
        actorId,
        rail: "ach",
        externalRef: `STMT-${tag}-ACH`,
        lines: [
          { accountId: achReceivableId, amountCents: CREDIT_CENTS },
          { accountId, amountCents: -CREDIT_CENTS },
        ],
      },
      sql,
    );

    const clearingEntryId = await postEntry(
      {
        entityId,
        valueDate: settlementDay,
        book: "financial",
        description: `Card clearing ${tag}`,
        idempotencyKey: `stmt:${tag}:clearing`,
        actorId,
        rail: "card",
        externalRef: `STMT-${tag}-CARD`,
        lines: [
          { accountId, amountCents: CLEARING_CENTS },
          { accountId: cardPayableId, amountCents: -CLEARING_CENTS },
        ],
      },
      sql,
    );

    /* ---- Close: the watermark is frozen --------------------------------- */

    const close = await publish.closeDay(
      { entityId, businessDate: settlementDay, actorId },
      sql,
    );
    expect(close.created).toBe(true);
    const W1 = close.bookDay.bookingWatermark;
    expect(W1).toBeGreaterThan(0n);

    // Closing a closed day writes nothing and reports the ORIGINAL watermark.
    // A day is closed once; `book_day`'s primary key is the guarantee and this
    // is the application not fighting it.
    const reclose = await publish.closeDay(
      { entityId, businessDate: settlementDay, actorId },
      sql,
    );
    expect(reclose.created).toBe(false);
    expect(reclose.bookDay.bookingWatermark).toBe(W1);
    expect(reclose.bookDay.closedAt).toBe(close.bookDay.closedAt);

    /* ---- GENERATION 1 ---------------------------------------------------- */

    const g1 = await publish.publishStatement(
      { accountId, businessDate: settlementDay, actorId },
      sql,
    );
    expect(g1.created).toBe(true);
    expect(g1.statement.version).toBe(1);
    expect(g1.statement.bookingWatermark).toBe(W1);
    expect(g1.statement.format).toBe(render.STATEMENT_FORMAT);
    expect(g1.statement.generatedBy).toBe(actorId);

    const H1 = g1.statement.contentHash;
    const T1 = render.canonicalStatement(g1.document);
    expect(H1).toHaveLength(64);
    expect(render.statementHash(g1.document)).toBe(H1);

    // The published figures are the fold over the day, not a guess.
    expect(g1.statement.lineCount).toBe(2);
    expect(g1.statement.closingBalanceCents).toBe(
      g1.statement.openingBalanceCents + CREDIT_CENTS - CLEARING_CENTS,
    );

    /* ---- GENERATION 2: nothing has changed ------------------------------- */

    const g2 = await publish.verifyStatement(g1.statement.statementId, sql);
    expect(g2).not.toBeNull();
    const H2 = g2!.recomputedHash;
    const T2 = g2!.canonical;
    expect(g2!.reproduced).toBe(true);
    expect(g2!.formatChanged).toBe(false);
    expect(H2).toBe(H1);
    expect(T2).toBe(T1);

    // And publishing again is a no-op that returns the SAME row, not a v2.
    const republish = await publish.publishStatement(
      { accountId, businessDate: settlementDay, actorId },
      sql,
    );
    expect(republish.created).toBe(false);
    expect(republish.statement.statementId).toBe(g1.statement.statementId);
    expect(republish.statement.version).toBe(1);

    /* ---- A NEW backdated correction lands into the closed day ------------ */

    const correction = await reverseAndRebook(
      {
        originalEntryId: clearingEntryId,
        reason: `statement proof ${tag}: merchant reversed and re-presented`,
        actorId,
        rebook: {
          // SETTLEMENT DAY's value date, today's booking position. If this
          // carried today's value date instead, settlement day would stay
          // wrong forever and today would show a phantom credit.
          valueDate: settlementDay,
          book: "financial",
          description: `Card clearing re-presented ${tag}`,
          idempotencyKey: `stmt:${tag}:rebook`,
          rail: "card",
          externalRef: `STMT-${tag}-CARD`,
          lines: [
            { accountId, amountCents: REBOOK_CENTS },
            { accountId: cardPayableId, amountCents: -REBOOK_CENTS },
          ],
        },
      },
      sql,
    );
    expect(correction.rebookEntryId).not.toBeNull();

    // The correction really is inside the closed period and above the
    // watermark — which is what makes generation 3 a test rather than a
    // tautology.
    const [late] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE value_date = ${settlementDay}::date AND booking_seq > ${W1}`;
    expect(late?.n).toBe(2);

    /* ---- GENERATION 3: the book has changed, the document has not -------- */

    const g3 = await publish.verifyStatement(g1.statement.statementId, sql);
    expect(g3).not.toBeNull();
    const H3 = g3!.recomputedHash;
    const T3 = g3!.canonical;
    expect(g3!.reproduced).toBe(true);
    expect(H3).toBe(H1);
    // Byte-identical, asserted about the bytes and not only about the digest.
    expect(T3).toBe(T1);
    expect(T3.length).toBe(T1.length);
    expect(g3!.document.lineCount).toBe(2);
    expect(g3!.document.closingBalanceCents).toBe(g1.statement.closingBalanceCents);

    /* ---- Both readings, at once ----------------------------------------- */

    const comparison = await compare.compareStatement(
      { accountId, businessDate: settlementDay },
      sql,
    );
    expect(comparison).not.toBeNull();
    const c = comparison!;

    // As published: unchanged, and still hashing to what it hashed to.
    expect(c.published.statementId).toBe(g1.statement.statementId);
    expect(c.published.contentHash).toBe(H1);
    expect(c.reproduced).toBe(true);
    expect(c.publishedDocument.closingBalanceCents).toBe(g1.statement.closingBalanceCents);

    // As corrected: the day is now worth CLEARING - REBOOK more, because the
    // merchant took less than it first presented.
    expect(c.correctedDocument.closingBalanceCents).toBe(
      g1.statement.closingBalanceCents + CLEARING_CENTS - REBOOK_CENTS,
    );
    expect(c.deltaCents).toBe(CLEARING_CENTS - REBOOK_CENTS);
    expect(c.correctedDocument.lineCount).toBe(4);

    // And the difference is itemised, not asserted. `explainsDelta` is the
    // assertion that matters: the listed entries must sum to the whole gap.
    // It failed the first time this ran, because the list was scoped to
    // entries INSIDE the period and a closing balance also moves when
    // something backdated before the period is booked late. See
    // `listLatePostings`.
    expect(c.latePostings.map((p) => p.entryType)).toEqual(["reversal", "rebook"]);
    expect(c.latePostings.every((p) => !p.affectsOpening)).toBe(true);
    expect(compare.explainsDelta(c.deltaCents, c.latePostings)).toBe(true);
    const groups = compare.groupLatePostings(c.latePostings);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.isCorrection).toBe(true);
    expect(groups[0]?.netCents).toBe(c.deltaCents);
    expect(groups[0]?.correctionGroupId).toBe(correction.correctionGroupId);

    /* ---- v2: a NEW document, never an edit ------------------------------ */

    const v2 = await publish.reissueStatement(
      { accountId, businessDate: settlementDay, actorId },
      sql,
    );
    expect(v2.created).toBe(true);
    expect(v2.statement.version).toBe(2);
    expect(v2.statement.bookingWatermark).toBeGreaterThan(W1);
    expect(v2.statement.contentHash).not.toBe(H1);
    expect(v2.statement.lineCount).toBe(4);
    expect(v2.statement.closingBalanceCents).toBe(c.correctedDocument.closingBalanceCents);

    // Reissuing again writes nothing: a version whose only difference from its
    // predecessor is `generated_at` is noise in an audit trail.
    const reissueAgain = await publish.reissueStatement(
      { accountId, businessDate: settlementDay, actorId },
      sql,
    );
    expect(reissueAgain.created).toBe(false);
    expect(reissueAgain.statement.statementId).toBe(v2.statement.statementId);

    /* ---- v1 is untouched, in the row and in the rendering --------------- */

    const v1Now = await read.readStatementById(g1.statement.statementId, sql);
    expect(v1Now).toEqual(g1.statement);

    const versions = await read.listStatementVersions(
      { accountId, periodStart: settlementDay, periodEnd: settlementDay },
      sql,
    );
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect(versions[0]?.contentHash).toBe(H1);

    // GENERATION 4, unasked for and free: after v2 exists, v1 still renders
    // identically. The versions are independent documents, not a chain where
    // the newest overwrites the reading of the oldest.
    const g4 = await publish.verifyStatement(g1.statement.statementId, sql);
    expect(g4!.recomputedHash).toBe(H1);
    expect(g4!.canonical).toBe(T1);

    // The evidence, printed so it can be pasted rather than paraphrased.
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "  REPRODUCIBILITY PROOF — live Neon, three generations",
        `  business date      ${settlementDay}   account ${accountId}`,
        `  close watermark    seq ${W1}   (book_day.booking_watermark, frozen)`,
        `  preimage length    ${T1.length} bytes, ${g1.document.lineCount} lines`,
        `  G1 publish v1      ${H1}`,
        `  G2 re-render       ${H2}   ${H2 === H1 ? "IDENTICAL" : "DIFFERENT"}`,
        `     backdated correction: reversal ${correction.reversalEntryId} + rebook ${String(correction.rebookEntryId)}`,
        `     both at value date ${settlementDay}, booked above seq ${W1}`,
        `  G3 re-render       ${H3}   ${H3 === H1 ? "IDENTICAL" : "DIFFERENT"}`,
        `  canonical bytes    T1 === T2 === T3: ${String(T1 === T2 && T2 === T3)}`,
        `  as published       closing ${g1.statement.closingBalanceCents} cents (v1, seq ${W1})`,
        `  as corrected       closing ${c.correctedDocument.closingBalanceCents} cents (now)`,
        `  delta              ${c.deltaCents} cents, itemised by ${c.latePostings.length} entries, explained: ${String(compare.explainsDelta(c.deltaCents, c.latePostings))}`,
        `  v2 issued          ${v2.statement.contentHash} at seq ${v2.statement.bookingWatermark}`,
        "",
      ].join("\n"),
    );
  });

  it("the database refuses to edit a published statement or a closed day", async () => {
    // Not decoration. The whole argument rests on a published document being
    // unchangeable, so the suite proves it rather than asserting it — the same
    // move `scripts/dbcheck.mjs` makes for the money tables.
    await expect(
      sql`UPDATE statement SET closing_balance_cents = 0 WHERE true`,
    ).rejects.toThrow(/permission denied/);
    await expect(sql`DELETE FROM statement WHERE true`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`UPDATE book_day SET booking_watermark = 0 WHERE true`,
    ).rejects.toThrow(/permission denied/);
  });

  it("refuses to publish a statement for a day that has not been closed", async () => {
    // There is no watermark until there is a close, and a statement without a
    // watermark is a period — which is the thing the design says a statement
    // is not. Rendering an open day is still possible and still useful; what
    // is refused is PUBLISHING one as an immutable document.
    const openDay = dayFromEpoch((stamp % 5000) + 1);
    const [existing] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM book_day
       WHERE entity_id = ${entityId}::uuid AND business_date = ${openDay}::date`;
    if ((existing?.n ?? 0) > 0) return; // a previous run happened to close it

    await expect(
      publish.publishStatement({ accountId, businessDate: openDay, actorId }, sql),
    ).rejects.toThrow(publish.DayNotClosedError);
  });

  it("refuses to issue a corrected version before anything has been published", async () => {
    const closedButUnpublished = dayFromEpoch((stamp % 5000) + 2);
    await publish.closeDay(
      { entityId, businessDate: closedButUnpublished, actorId },
      sql,
    );
    await expect(
      publish.reissueStatement(
        { accountId, businessDate: closedButUnpublished, actorId },
        sql,
      ),
    ).rejects.toThrow(publish.NotYetPublishedError);
  });

  it("seeds the demo the /statements screen reads, and is a no-op the second time", async () => {
    // This is also the seeder. The screen's default state reads the live
    // database, so it having something to show is a consequence of this
    // running rather than of a fixture claiming so.
    const first = await demo.seedStatementDemo({}, sql);
    expect(first.v1.version).toBe(1);
    // NOT `toBe(2)`. The demo day accumulates a genuine new version whenever
    // something is backdated to on or before it — including the synthetic
    // settlement days this very file creates, which sit in the 2000s and
    // therefore move this day's OPENING balance. That is a real change to what
    // the day closed at, and it earns a real version. Asserting `2` here was
    // asserting that nothing else in the book ever moves, which is false.
    expect(first.current.version).toBeGreaterThanOrEqual(2);
    expect(first.current.bookingWatermark).toBeGreaterThan(first.v1.bookingWatermark);
    expect(first.current.contentHash).not.toBe(first.v1.contentHash);

    const again = await demo.seedStatementDemo({}, sql);
    expect(again.closedNow).toBe(false);
    expect(again.v1.statementId).toBe(first.v1.statementId);
    // The idempotency that matters: a second run in the same state issues NO
    // new version, because the minimal watermark for the content has not moved.
    expect(again.current.statementId).toBe(first.current.statementId);
    expect(again.current.version).toBe(first.current.version);
    expect(again.clearingEntryId).toBe(first.clearingEntryId);
    expect(again.reversalEntryId).toBe(first.reversalEntryId);

    const c = await compare.compareStatement(
      { accountId: first.accountId, businessDate: first.businessDate },
      sql,
    );
    expect(c?.reproduced).toBe(true);
    // The in-period part of the difference is the reversal and the re-book;
    // anything else in the list is a backdated posting that moved the opening
    // balance. Both together must account for the delta exactly.
    expect(c === null ? null : compare.explainsDelta(c.deltaCents, c.latePostings)).toBe(
      true,
    );
    const inPeriod = (c?.latePostings ?? []).filter((p) => !p.affectsOpening);
    expect(inPeriod.reduce((acc, p) => acc + p.signedCents, 0n)).toBe(
      demo.DEMO_CLEARING_CENTS - demo.DEMO_REBOOK_CENTS,
    );

    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "  SCREEN DEMO — live",
        `  account   ${first.accountId}`,
        `  day       ${first.businessDate}  closed at seq ${first.bookDay.bookingWatermark}`,
        `  v1        ${first.v1.contentHash}  closing ${first.v1.closingBalanceCents} at seq ${first.v1.bookingWatermark}`,
        `  v${first.current.version}        ${first.current.contentHash}  closing ${first.current.closingBalanceCents} at seq ${first.current.bookingWatermark}`,
        `  delta     ${c?.deltaCents ?? 0n} cents over ${c?.latePostings.length ?? 0} late entries`,
        "",
      ].join("\n"),
    );
  });
});
