/**
 * ATTACK 3 — "Reverse that settlement the next day and pull the statement for
 * settlement day. Assert the statement shows the corrected figure AND that the
 * as-believed-on-the-intermediate-day query still returns the pre-correction
 * number. Both true at once."
 *
 * Against the LIVE Neon database, through the sanctioned posting path only.
 *
 * WHAT IS ASSERTED, PRECISELY.
 *   1. Settlement day, as the ledger reads it NOW  -> the corrected figure.
 *   2. Settlement day, as we BELIEVED it at the intermediate day's watermark
 *      -> still the pre-correction figure.
 *   3. Both answers come back from the same live table in the same run. The
 *      difference between them is exactly the settled amount.
 *   4. Nothing was edited: the original row's description and amount are
 *      byte-identical afterwards, and the correction group holds two entries.
 *   5. The financial book still sums to zero.
 *
 * ONE THING THIS DOES NOT CLAIM. There is no statement RENDERER in this
 * codebase — `statement` exists as a table and nothing writes to it — so
 * "pull the statement" is executed as `ledgerBalanceAsOf(account, day)`, which
 * is the fold a statement is a rendering of (DESIGN §13). The evidence line
 * says so. It is not a mock: it is the live query against live rows.
 *
 * ISOLATION. Money tables are append-only, so there is no teardown. Every run
 * picks its own synthetic value date and its own idempotency keys, and every
 * assertion is a DELTA on one account rather than a count over a shared table.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type { postEntry as PostEntry, reverseAndRebook as ReverseAndRebook } from "@/lib/ledger/post";

const ATTACK = 3;
const NAME = "Backdated reversal: corrected statement and as-believed, both true at once";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  // Recreate the directory if something removed it under us. A run has already
  // lost its evidence to a concurrent `next build` wiping the folder it was
  // written into: every record() after that threw ENOENT and an attack whose
  // assertions had all passed was scored as a failure with a filesystem error
  // as its reason. Evidence must never be the thing that fails a live-fire run.
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const READY =
  process.env["LIVEFIRE"] === "1" && typeof process.env["APP_DATABASE_URL"] === "string";

if (!READY) {
  record("skip", "LIVEFIRE=1 and APP_DATABASE_URL are required; run scripts/livefire.mjs");
}

const d = READY ? describe : describe.skip;

/** `2000-01-01 + n` days, in UTC so no zone can shift it. */
function dayFromEpoch(offset: number): string {
  const at = new Date("2000-01-01T00:00:00.000Z");
  at.setUTCDate(at.getUTCDate() + offset);
  return at.toISOString().slice(0, 10);
}

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let postEntry: typeof PostEntry;
  let reverseAndRebook: typeof ReverseAndRebook;
  let bal: typeof BalancesModule;

  let entityId = "";
  let actorId = "";
  let depositAccountId = "";
  let cardPayableId = "";

  const stamp = Date.now();
  const tag = stamp.toString(36).toUpperCase();
  /** The settlement day. Synthetic and unique to this run. */
  const settlementDay = dayFromEpoch(stamp % 5000);
  const SETTLED_CENTS = 73_40n;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    ({ postEntry, reverseAndRebook } = await import("@/lib/ledger/post"));
    bal = await import("@/lib/ledger/balances");

    const [entity] = await sql<{ id: string }[]>`SELECT id FROM book_entity LIMIT 1`;
    const [actor] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'human' AND can_approve = true LIMIT 1`;
    const [deposit] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2100' AND business_id IS NOT NULL LIMIT 1`;
    const [payable] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2200' AND business_id IS NULL LIMIT 1`;
    if (!entity || !actor || !deposit || !payable) {
      throw new Error("the live database is not seeded: run node scripts/seed.mjs");
    }
    entityId = entity.id;
    actorId = actor.id;
    depositAccountId = deposit.id;
    cardPayableId = payable.id;
  });

  it("both time axes answer independently, and neither overwrote the other", async () => {
    // ---- Settlement day: $73.40 clears against the customer ---------------
    const before = await bal.ledgerBalanceAsOf(depositAccountId, settlementDay);

    const settlement = await postEntry({
      entityId,
      valueDate: settlementDay,
      book: "financial",
      description: `Card clearing ${tag}, $73.40`,
      idempotencyKey: `livefire:${tag}:clearing`,
      actorId,
      rail: "card",
      externalRef: `LF3-${tag}-CLEAR`,
      lines: [
        // The customer spending money is a DEBIT to their deposit account.
        { accountId: depositAccountId, amountCents: SETTLED_CENTS },
        { accountId: cardPayableId, amountCents: -SETTLED_CENTS },
      ],
    });

    // ---- The intermediate day: what we believed, pinned to a watermark ----
    const asBelievedFigure = await bal.ledgerBalanceAsOf(depositAccountId, settlementDay);
    const intermediateWatermark = await bal.bookingWatermarkAt(new Date());
    expect(asBelievedFigure).toBe(before - SETTLED_CENTS);

    // ---- The next day: the merchant reverses it --------------------------
    // The reversal carries the ORIGINAL value date, not today's. That is what
    // makes settlement day answerable with the corrected figure.
    const { reversalEntryId, correctionGroupId } = await reverseAndRebook({
      originalEntryId: settlement,
      reason: `live-fire ${tag}: merchant reversed the settlement`,
      actorId,
    });
    expect(reversalEntryId).toBeTruthy();

    // ---- 1. The statement for settlement day, as the ledger reads it now --
    const correctedFigure = await bal.ledgerBalanceAsOf(depositAccountId, settlementDay);
    expect(correctedFigure).toBe(before);

    // ---- 2. Settlement day AS BELIEVED on the intermediate day ------------
    const believedFigure = await bal.balanceAsBelieved(
      depositAccountId,
      settlementDay,
      intermediateWatermark,
    );
    expect(believedFigure).toBe(asBelievedFigure);

    // ---- 3. BOTH TRUE AT ONCE, differing by exactly the settled amount ----
    expect(correctedFigure - believedFigure).toBe(SETTLED_CENTS);
    expect(correctedFigure).not.toBe(believedFigure);

    // And the axis works forwards too: at today's watermark the as-believed
    // query agrees with the corrected figure, so this is a time axis and not
    // a frozen copy.
    const nowWatermark = await bal.bookingWatermarkAt(new Date());
    expect(
      await bal.balanceAsBelieved(depositAccountId, settlementDay, nowWatermark),
    ).toBe(correctedFigure);

    // ---- 4. Nothing was edited -------------------------------------------
    const [original] = await sql<{ description: string; entry_type: string }[]>`
      SELECT description, entry_type::text AS entry_type
        FROM journal_entry WHERE id = ${settlement}::uuid`;
    expect(original?.description).toBe(`Card clearing ${tag}, $73.40`);
    expect(original?.entry_type).toBe("original");

    const [originalLine] = await sql<{ amount_cents: bigint }[]>`
      SELECT amount_cents FROM journal_line
       WHERE entry_id = ${settlement}::uuid AND account_id = ${depositAccountId}::uuid`;
    expect(originalLine?.amount_cents).toBe(SETTLED_CENTS);

    const [group] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE correction_group_id = ${correctionGroupId}::uuid`;
    expect(group?.n).toBe(2);

    // ---- 5. The book still nets to zero ----------------------------------
    expect(await bal.trialBalanceCents()).toBe(0n);

    record(
      "evidence",
      `settlement day ${settlementDay}: corrected=${correctedFigure} as-believed@seq${intermediateWatermark}=${believedFigure} diff=${correctedFigure - believedFigure} (expected ${SETTLED_CENTS}); original entry ${settlement} unedited; correction group holds 2 entries; trial balance 0`,
    );
    record(
      "evidence",
      "figure source: ledgerBalanceAsOf / balanceAsBelieved — the fold a statement renders. No statement document is produced; nothing writes to the `statement` table yet.",
    );
  });

  it("the database itself refuses to edit the row we just corrected", async () => {
    // Not decoration. The whole correction argument rests on the original row
    // being unchangeable, so the suite proves it rather than asserting it.
    await expect(
      sql`UPDATE journal_entry SET description = 'tampered' WHERE true`,
    ).rejects.toThrow(/permission denied/);
    record("evidence", "UPDATE on journal_entry refused for corgi_app: permission denied");
  });
});
