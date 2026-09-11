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
import type { Sql } from "@/lib/ledger/queries";

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
 * The busiest one, so the statement has an opening balance with history behind
 * it rather than a suspiciously round zero. Passing an explicit id overrides
 * this; the test does not, because picking the account by activity is also a
 * check that the query works on an account with real depth.
 */
export async function pickDemoAccount(conn: Sql): Promise<string> {
  const rows = await conn<{ account_id: string }[]>`
    SELECT a.id AS account_id
      FROM account a
      LEFT JOIN journal_line l ON l.account_id = a.id
     WHERE a.code = '2100'
       AND a.book = 'financial'
       AND a.business_id IS NOT NULL
       AND a.closed_at IS NULL
     GROUP BY a.id
     ORDER BY count(l.*) DESC, a.id
     LIMIT 1`;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("no customer deposit account: run node scripts/seed.mjs");
  }
  return row.account_id;
}

async function pickActor(conn: Sql): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE kind = 'human' AND can_approve = true ORDER BY id LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error("no approving actor: run node scripts/seed.mjs");
  return row.id;
}

async function pickControlAccount(code: string, conn: Sql): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM account WHERE code = ${code} AND business_id IS NULL LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no ${code} control account: run node scripts/seed.mjs`);
  return row.id;
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
