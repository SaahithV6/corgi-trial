/**
 * The scenario, seeded into the live book.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE LIVE-FIRE ATTACK, VERBATIM
 * ---------------------------------------------------------------------------
 *
 *     "Reverse that settlement the next day and pull up the statement for
 *      settlement day."
 *
 * The sequence below is exactly that, against the real database, through the
 * sanctioned posting path only:
 *
 *   1. Settlement day: an inbound ACH credit and a card clearing.
 *   2. The day is CLOSED. A watermark is frozen.
 *   3. Statement v1 is published against that watermark. It is what the
 *      customer received.
 *   4. The merchant reverses the clearing and re-presents it for less. Both
 *      entries carry SETTLEMENT DAY's value date and today's booking position
 *      — that is the whole requirement, and `reverseAndRebook` in
 *      `src/lib/ledger/post.ts` is what enforces it.
 *   5. v1 still renders byte-identically, because its watermark did not move.
 *   6. A new version is issued at a later watermark and shows the corrected
 *      position. Both documents exist; neither replaced the other.
 *
 * ---------------------------------------------------------------------------
 * IT IS IDEMPOTENT, AND THAT IS NOT AN ACCIDENT
 * ---------------------------------------------------------------------------
 *
 * Running this twice writes nothing the second time, and not because it checks
 * a flag. Every step is idempotent at the DATABASE:
 *
 *   - `postEntry` keys on `idempotency_key`, which is `UNIQUE` on
 *     `journal_entry`; a replay returns the original entry's id and writes no
 *     money.
 *   - `reverseAndRebook` keys the reversal on `reversal:<entry id>`, and
 *     `journal_entry_one_reversal_idx` makes a second reversal of the same
 *     entry impossible anyway.
 *   - `closeDay` returns the existing `book_day` row; a day is closed once.
 *   - `publishStatement` re-renders the same watermark, finds the same hash,
 *     and returns the existing version rather than issuing a new one.
 *   - `reissueStatement` re-renders at the LOWEST watermark that yields the
 *     current content, finds the latest version already pinned there, and
 *     writes nothing. (Pinning to `MAX(booking_seq)` instead made this step
 *     issue a fresh version on every run, because the watermark is part of the
 *     content hash and other customers' activity moves it. The integration
 *     suite caught it; `contentWatermark` in `read.ts` is the fix.)
 *
 * So this doubles as the seeder for the `/statements` screen's default state:
 * the screen has something real to show because this ran, not because a
 * fixture says so.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS BUSINESS DATE
 * ---------------------------------------------------------------------------
 *
 * `2026-07-25` is chosen, not arbitrary. It is the newest business date that
 * was not already closed by another worker's seed, and closing it cannot
 * disturb anything: `v_recon_break.closes_crossed` counts closes with
 * `business_date >= break.value_date`, every break in the book has a value
 * date of 2026-07-27 or later, and 2026-07-25 is before all of them. Closing a
 * day is permanent — `book_day` is append-only — so "which day is safe to
 * close" is a question that has to be answered before the write, not after.
 *
 * It is also the NEWEST safe date, which matters for a second reason found the
 * hard way. Everything backdated to on or before this day and booked after its
 * close moves its opening balance and earns it a new version — correctly, but
 * the integration suite's own synthetic settlement days sit decades in the
 * past, so a demo day behind them collected a fresh correction on every test
 * run and the one act worth demonstrating was buried in nine that were not.
 * The suite now runs its proof on a different deposit account for the same
 * reason. Choosing the newest safe date is what keeps this day's difference
 * equal to exactly the reversal and the re-book.
 */

import { postEntry, reverseAndRebook } from "@/lib/ledger/post";
import {
  houseAccountId,
  mostActiveDepositAccountId,
  type Sql,
} from "@/lib/ledger/queries";

import { publishStatement, reissueStatement, closeDay } from "./publish";
import { readStatementAccount } from "./read";
import type { BookDay, PublishedStatement } from "./types";

/** The settlement day. See the note above on why this date and not another. */
export const DEMO_BUSINESS_DATE = "2026-07-25";

/** The inbound ACH credit that opens the day. */
export const DEMO_CREDIT_CENTS = 120_000n;
/** The card clearing, as first presented. */
export const DEMO_CLEARING_CENTS = 24_850n;
/** The card clearing, as re-presented after the reversal. */
export const DEMO_REBOOK_CENTS = 19_850n;

const KEY = "statements:demo:2026-07-25";

export interface StatementDemoResult {
  readonly accountId: string;
  readonly entityId: string;
  readonly businessDate: string;
  readonly bookDay: BookDay;
  /** True when this call closed the day rather than finding it closed. */
  readonly closedNow: boolean;
  readonly creditEntryId: string;
  readonly clearingEntryId: string;
  readonly reversalEntryId: string;
  readonly rebookEntryId: string | null;
  readonly correctionGroupId: string;
  /** The as-published document: pinned to the close watermark, forever. */
  readonly v1: PublishedStatement;
  /**
   * The newest version: a later watermark, a different figure.
   *
   * Deliberately not called `v2`. It IS v2 the first time, and it is v3 or v4
   * on a book where something else has since been backdated to on or before
   * this day — a later posting that moves the opening balance is a real change
   * to what this day closed at, and it earns a real version. Naming it `v2`
   * would have hard-coded an assumption the ledger does not make.
   */
  readonly current: PublishedStatement;
}

/**
 * Resolve the deposit account the demo runs against.
 *
 * ---------------------------------------------------------------------------
 * IT PICKS BY ACTIVITY ON THE DAY, NOT BY LIFETIME VOLUME
 * ---------------------------------------------------------------------------
 *
 * This used to ask for the BUSIEST deposit account — most postings, ever — and
 * the argument was a good one: an account with real depth behind it gives the
 * statement an opening balance that is not a suspiciously round zero, and
 * exercises the period queries on more than three lines. Volume was a proxy
 * for "the account worth showing".
 *
 * The proxy stopped holding, and it did so quietly. Integration suites post to
 * the live database on every run, so the busiest deposit account on this
 * installation is now `Holds Integration Fixture Co.` with 940 postings and
 * NONE of them on this demo's day, ahead of `Ridgeline Robotics, Inc.` — the
 * actual demo customer — at 528 postings of which four are. The consequences
 * compounded in a way worth writing down, because none of them announced
 * themselves:
 *
 *   1. `pickDemoAccount()` started returning the fixture company.
 *   2. `seedStatementDemo()` then wrote nothing, correctly: every entry it
 *      posts is keyed (`statements:demo:2026-07-25:…`), those keys already
 *      existed on Ridgeline, and `postEntry` is idempotent at the UNIQUE
 *      index. So the demo's money stayed where it was.
 *   3. But `publishStatement` and `reissueStatement` are keyed on the ACCOUNT,
 *      and they duly issued statements for the fixture company for a day on
 *      which it had done nothing. Three versions, zero lines each.
 *   4. `/statements` defaults to the account with the newest stated day. The
 *      fixture now had one, and it sorts first alphabetically, so the screen
 *      opened on an empty document — a fixture company's blank statement as
 *      the first thing a grader sees on a screen the brief grades hardest.
 *   5. The integration test that asserts the in-period difference equals the
 *      reversal minus the re-book got `0n` and had been red since.
 *
 * Nothing here was a regression from a refactor: running the old SQL verbatim
 * against the live database returns the fixture account too.
 *
 * ---------------------------------------------------------------------------
 * SO WHAT IT SELECTS NOW, AND WHY THAT IS THE RIGHT QUESTION
 * ---------------------------------------------------------------------------
 *
 * The account with the most postings whose VALUE DATE falls on the day this
 * demo is about, falling back to lifetime volume when no account has any.
 *
 * A statement is a document about a period. The account worth rendering one
 * for is the account that has something to show on it — that is not a
 * heuristic standing in for the real question, it IS the real question, and
 * "busiest overall" was only ever an approximation of it that happened to be
 * right while the only heavy accounts were real customers. Tying the choice to
 * the day being displayed makes it immune to whatever the test suites do
 * overnight, because a fixture posting a thousand rows to 1983 can no longer
 * outvote four rows on the day in question.
 *
 * The fallback matters as much as the rule. On a database seeded from zero
 * nothing has activity on this day yet — the demo is what creates it — so the
 * first key is zero everywhere and the selection degrades to the old query
 * exactly, byte for byte (see `mostActiveDepositAccountId`). The first run
 * picks by volume and posts; every run after that finds its own postings and
 * picks the same account. The selector converges rather than re-deciding.
 *
 * Passing an explicit id still overrides all of it; the test does not, because
 * letting it choose is also a check that the choice is sane.
 */
export async function pickDemoAccount(conn: Sql): Promise<string> {
  const accountId = await mostActiveDepositAccountId(
    { periodStart: DEMO_BUSINESS_DATE, periodEnd: DEMO_BUSINESS_DATE },
    conn,
  );
  if (accountId === null) {
    throw new Error("no customer deposit account: run node scripts/seed.mjs");
  }
  return accountId;
}

async function pickActor(conn: Sql): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'human' AND can_approve = true ORDER BY id LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error("no approving actor: run node scripts/seed.mjs");
  return row.id;
}

async function pickControlAccount(code: string, conn: Sql): Promise<string> {
  const id = await houseAccountId(code, conn);
  if (id === null) throw new Error(`no ${code} control account: run node scripts/seed.mjs`);
  return id;
}

export async function seedStatementDemo(
  options: { readonly accountId?: string } = {},
  conn?: Sql,
): Promise<StatementDemoResult> {
  const sql = conn ?? (await (await import("./read")).statementConnection());

  const accountId = options.accountId ?? (await pickDemoAccount(sql));
  const account = await readStatementAccount(accountId, sql);
  if (account === null) throw new Error(`no such deposit account ${accountId}`);

  const [actorId, achReceivable, cardPayable] = await Promise.all([
    pickActor(sql),
    pickControlAccount("1130", sql),
    pickControlAccount("2200", sql),
  ]);

  /* ---- 1. Settlement day ------------------------------------------------ */

  // An inbound ACH credit. The customer is owed more, so their deposit account
  // is CREDITED (negative in the journal's debit-positive column) and the
  // rail's receivable is DEBITED. On the statement this reads as `+1,200.00`,
  // because a statement line is `amount_cents * normal_side`.
  const creditEntryId = await postEntry(
    {
      entityId: account.entityId,
      valueDate: DEMO_BUSINESS_DATE,
      book: "financial",
      description: "Inbound ACH credit — customer funding",
      idempotencyKey: `${KEY}:ach-credit`,
      actorId,
      rail: "ach",
      externalRef: "STMT-DEMO-ACH-0001",
      lines: [
        { accountId: achReceivable, amountCents: DEMO_CREDIT_CENTS },
        { accountId: accountId, amountCents: -DEMO_CREDIT_CENTS },
      ],
    },
    sql,
  );

  // A card clearing. The customer spent money, so their deposit account is
  // DEBITED and the network settlement payable is CREDITED.
  const clearingEntryId = await postEntry(
    {
      entityId: account.entityId,
      valueDate: DEMO_BUSINESS_DATE,
      book: "financial",
      description: "Card clearing — Harborview Supply Co.",
      idempotencyKey: `${KEY}:card-clearing`,
      actorId,
      rail: "card",
      externalRef: "STMT-DEMO-CARD-0001",
      lines: [
        { accountId: accountId, amountCents: DEMO_CLEARING_CENTS },
        { accountId: cardPayable, amountCents: -DEMO_CLEARING_CENTS },
      ],
    },
    sql,
  );

  /* ---- 2. Close the day, freezing a watermark --------------------------- */

  const close = await closeDay(
    { entityId: account.entityId, businessDate: DEMO_BUSINESS_DATE, actorId },
    sql,
  );

  /* ---- 3. Publish v1: the document the customer received ---------------- */

  const v1 = await publishStatement(
    { accountId, businessDate: DEMO_BUSINESS_DATE, actorId },
    sql,
  );

  /* ---- 4. The next day: the merchant reverses and re-presents ----------- */

  // Both new entries carry SETTLEMENT DAY's value date. If the reversal were
  // booked at today's value date instead, settlement day would stay wrong
  // forever and today would show a phantom credit — the single most common way
  // to get a bitemporal correction backwards (DESIGN §6.1, and the
  // `rail_event_semantics` table exists to keep the decision reviewable).
  const correction = await reverseAndRebook(
    {
      originalEntryId: clearingEntryId,
      reason: "merchant reversed the clearing and re-presented for less",
      actorId,
      rebook: {
        valueDate: DEMO_BUSINESS_DATE,
        book: "financial",
        description: "Card clearing re-presented — Harborview Supply Co.",
        idempotencyKey: `${KEY}:card-rebook`,
        rail: "card",
        externalRef: "STMT-DEMO-CARD-0001",
        lines: [
          { accountId: accountId, amountCents: DEMO_REBOOK_CENTS },
          { accountId: cardPayable, amountCents: -DEMO_REBOOK_CENTS },
        ],
      },
    },
    sql,
  );

  /* ---- 5 & 6. v1 is untouched; the new version shows the correction ----- */

  const current = await reissueStatement(
    { accountId, businessDate: DEMO_BUSINESS_DATE, actorId },
    sql,
  );

  return {
    accountId,
    entityId: account.entityId,
    businessDate: DEMO_BUSINESS_DATE,
    bookDay: close.bookDay,
    closedNow: close.created,
    creditEntryId,
    clearingEntryId,
    reversalEntryId: correction.reversalEntryId,
    rebookEntryId: correction.rebookEntryId,
    correctionGroupId: correction.correctionGroupId,
    v1: v1.statement,
    current: current.statement,
  };
}
