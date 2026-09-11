/**
 * ITEM 5, THE INBOUND HALF, END TO END ON THE REAL INCREASE SANDBOX.
 *
 * "An inbound payment is recalled. The corrected position appears on the day it
 * happened." That sentence was the one thing `docs/GAUNTLET.md` could not show:
 * the outbound bounce was real (a $6,000.00 R01), and the inbound leg booked
 * NOTHING, because every inbound credit named the programme's single shared FBO
 * account number and this build refuses to guess whose money it is.
 *
 * This test is the proof that it now can, and it is deliberately the whole
 * story in one `it` rather than five, because the story is the assertion: a
 * credit that arrives, binds under the availability policy, and is then taken
 * back on its own day.
 *
 *   1. a real inbound ACH credit to ONE BUSINESS'S OWN virtual account number
 *      (`POST /simulations/inbound_ach_transfers`)
 *   2. the real, signature-verified webhook deliveries that follow, drained
 *      through the real consumer
 *   3. the credit booked at `effective_date` — LEDGER moves, AVAILABLE does
 *      NOT, because the ach/new policy holds a stranger's credit for two
 *      banking days
 *   4. a real recall (`POST /inbound_ach_transfers/{id}/transfer_return`)
 *   5. the recall booked at `transfer_return.returned_at` — a NEW EVENT at the
 *      day it happened, with the arrival still standing on the arrival's day —
 *      and the hold closed, so the same money is not withheld twice
 *
 * ─── WHY IT IS GATED BEHIND ITS OWN FLAG ────────────────────────────────────
 *
 * It MOVES REAL SANDBOX MONEY and writes to the live book. Every run creates an
 * inbound transfer that did not exist and posts two journal entries that are
 * append-only for ever. `RUN_LIVE_PROBES=1` is not enough — that flag is for
 * read-only probes, and this is not one. Run it deliberately:
 *
 *   set -a; . ./.env; set +a; RUN_INBOUND_RECALL=1 pnpm vitest run \
 *     src/lib/rails/increase/inbound-recall.integration.test.ts
 *
 * ─── WHAT IT DOES NOT PRETEND ───────────────────────────────────────────────
 *
 * The webhook deliveries arrive at the DEPLOYED endpoint and are
 * signature-verified there — that part is not simulated and cannot be. The
 * DRAIN runs here, in this process, against the same live database, which is
 * how a consumer change is exercised before it is deployed. If the deployed
 * build is older than this one it will have parked the delivery first; the loop
 * below waits for the park's backoff and drains it here, which is exactly what
 * `scripts/redrive.mjs` does for the historical rows.
 */

import { describe, expect, it } from "vitest";

import { accountAvailability, mainDepositAccountId, readSnapshot } from "@/lib/ledger/balance-definitions";
import { sql } from "@/lib/ledger/db";
import { findEntryByIdempotencyKey } from "@/lib/ledger/readers";
// The same book-date conversion the consumer dates a posting with, so the
// expectation is "the day `transfer_return.returned_at` falls on in book time"
// rather than a second implementation of that arithmetic.
import { bookDateOfIso } from "@/lib/webhooks/consumers/payload";
import { drain } from "@/lib/webhooks/drain";

import { listVirtualAccountNumbers } from "./account-numbers";
import { IncreaseAchRail } from "./client";
import { inboundAchExternalRef, INBOUND_CREDIT_KEY_PREFIX } from "./inbound-ach-ledger";

const LIVE =
  process.env["RUN_INBOUND_RECALL"] === "1" &&
  (process.env["INCREASE_API_KEY"] ?? "") !== "" &&
  (process.env["DATABASE_URL"] ?? process.env["APP_DATABASE_URL"] ?? "") !== "";

/** Cents. Deliberately not round: a round number hides a units error. */
const AMOUNT_CENTS = 187_425;
/** A different amount for the second business, so a mix-up cannot balance. */
const KEEP_AMOUNT_CENTS = 94_318;

/**
 * Which businesses to send the money to.
 *
 * Named through the environment rather than hard-coded, because the whole point
 * is that the number decides the owner — a test that pinned one business id
 * would be asserting its own fixture. Default: the first two mapped numbers, in
 * whatever order the table returns them.
 *
 *   INBOUND_RECALL_BUSINESS=Kettle   the one that is credited and recalled
 *   INBOUND_KEEP_BUSINESS=Ridgeline  the one that is credited and keeps it
 */
function pick(
  mapped: readonly { readonly legalName: string }[],
  needle: string | undefined,
  fallbackIndex: number,
): number {
  if (needle === undefined || needle === "") return fallbackIndex;
  const i = mapped.findIndex((m) => m.legalName.toLowerCase().includes(needle.toLowerCase()));
  if (i < 0) throw new Error(`no mapped virtual account number for a business matching "${needle}"`);
  return i;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drain until the ledger says the fact is booked, or give up loudly.
 *
 * Polls rather than waits once: a parked delivery is re-checked on a 30s
 * backoff, and the deployed build may have parked it seconds before this test
 * started. Giving up returns null so the assertion names the missing entry
 * rather than timing out with nothing to read.
 */
async function drainUntil(
  key: string,
  timeoutMs: number,
): Promise<{ entryId: string; valueDate: string } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await drain({ maxBatches: 3 });
    const entry = await findEntryByIdempotencyKey(key, sql);
    if (entry !== null) return { entryId: entry.entryId, valueDate: entry.valueDate };
    if (Date.now() > deadline) return null;
    await sleep(5_000);
  }
}

describe.skipIf(!LIVE)("an inbound ACH credit, attributed through a virtual account number, then recalled", () => {
  it(
    "credits the business that owns the number, holds it, and takes it back on the day it happened",
    async () => {
      const rail = new IncreaseAchRail({});

      // ---- who are we crediting, and through which number ------------------
      const mapped = await listVirtualAccountNumbers(sql);
      expect(mapped.length).toBeGreaterThan(0);
      const owner = mapped[pick(mapped, process.env["INBOUND_RECALL_BUSINESS"], 0)]!;

      const depositAccountId = await mainDepositAccountId(owner.businessId, sql);
      expect(depositAccountId).not.toBeNull();

      const before = await accountAvailability(depositAccountId!, await readSnapshot(sql), sql);

      // ---- 1. a stranger sends money to THAT number ------------------------
      const created = await rail.simulateInboundAchTransfer({
        accountNumberId: owner.providerAccountNumberId,
        amountCents: AMOUNT_CENTS,
        companyName: "ITEM FIVE SUPPLY",
        companyEntryDescription: "INVOICE",
      });
      expect(created.account_number_id).toBe(owner.providerAccountNumberId);
      expect(created.status).not.toBe("declined");

      // ---- 2-3. the deliveries, drained, and the credit booked -------------
      const creditKey = `${INBOUND_CREDIT_KEY_PREFIX}${created.id}`;
      const credit = await drainUntil(creditKey, 180_000);
      expect(credit, `no entry under ${creditKey}`).not.toBeNull();
      // THE DAY THE ORIGINATOR CHOSE, from the field the table names
      // (`payload.effective_date`), never this process's clock.
      expect(credit?.valueDate).toBe(created.effective_date);

      const afterCredit = await accountAvailability(depositAccountId!, await readSnapshot(sql), sql);

      // The ledger moved by exactly the credit.
      expect(afterCredit.ledgerCents - before.ledgerCents).toBe(BigInt(AMOUNT_CENTS));
      // And available did NOT: the ach/new policy holds a stranger's credit for
      // two banking days, so the uncleared hold binds. This is the half of the
      // availability contrast that the wire rail does not have — there the same
      // code, reading a zero-day policy row, releases on arrival.
      expect(afterCredit.availableCents).toBe(before.availableCents);
      expect(afterCredit.unclearedCents - before.unclearedCents).toBe(BigInt(AMOUNT_CENTS));

      const [hold] = await sql<{ id: string; closures: number }[]>`
        SELECT h.id,
               (SELECT count(*)::int FROM hold_closure c WHERE c.hold_id = h.id) AS closures
          FROM hold h
         WHERE h.kind = 'uncleared_credit'
           AND h.external_ref = ${inboundAchExternalRef(created.id)}`;
      expect(hold, "the arrival opened no availability hold").toBeDefined();
      expect(hold?.closures).toBe(0);

      // ---- 4. and it is recalled -------------------------------------------
      const returned = await rail.returnInboundAchTransfer(created.id, "credit_entry_refused_by_receiver");
      expect(returned.status).toBe("returned");
      expect(returned.transfer_return?.returned_at).toBeTruthy();

      // ---- 5. booked at the day it happened, and the hold closed -----------
      const recallKey = `${INBOUND_CREDIT_KEY_PREFIX}recall:${created.id}:${
        returned.transfer_return?.transaction_id ?? "no-transaction"
      }`;
      const recall = await drainUntil(recallKey, 180_000);
      expect(recall, `no entry under ${recallKey}`).not.toBeNull();
      // DATED FROM `transfer_return.returned_at`, which is what makes it a new
      // event at the day it happened rather than a correction at the arrival's
      // day. Both are asserted: this one moved, and the arrival did not.
      expect(recall?.valueDate).toBe(bookDateOfIso(returned.transfer_return!.returned_at!));

      const afterRecall = await accountAvailability(depositAccountId!, await readSnapshot(sql), sql);
      // The position is corrected: ledger back where it started.
      expect(afterRecall.ledgerCents).toBe(before.ledgerCents);
      // And available is too — NOT down by twice the credit, which is what
      // would happen if the recall debited the customer and left the hold
      // standing over money that has gone back.
      expect(afterRecall.availableCents).toBe(before.availableCents);
      expect(afterRecall.unclearedCents).toBe(before.unclearedCents);

      const [closed] = await sql<{ closures: number }[]>`
        SELECT count(*)::int AS closures FROM hold_closure WHERE hold_id = ${hold!.id}::uuid`;
      expect(closed?.closures).toBe(1);

      // The arrival is STILL on the arrival's day. This is the sentence the
      // brief actually asks for, read back rather than argued: two entries,
      // each at its own value date, and the earlier one untouched by the later.
      const stillThere = await findEntryByIdempotencyKey(creditKey, sql);
      expect(stillThere?.valueDate).toBe(created.effective_date);
      expect(stillThere?.entryId).toBe(credit?.entryId);
    },
    600_000,
  );

  it(
    "credits the business that owns the number and NOT the one that does not",
    async () => {
      // The other half of the claim, and the one a refusal alone never proves:
      // that the mapping DISCRIMINATES. A build that credited "the only
      // business on the book" would pass every assertion in the test above and
      // fail this one on its first line.
      const rail = new IncreaseAchRail({});
      const mapped = await listVirtualAccountNumbers(sql);
      expect(mapped.length).toBeGreaterThan(1);

      const keepIndex = pick(mapped, process.env["INBOUND_KEEP_BUSINESS"], 1);
      const other = mapped[keepIndex === 0 ? 1 : 0]!;
      const owner = mapped[keepIndex]!;
      expect(owner.businessId).not.toBe(other.businessId);

      const ownerAccount = await mainDepositAccountId(owner.businessId, sql);
      const otherAccount = await mainDepositAccountId(other.businessId, sql);
      const ownerBefore = await accountAvailability(ownerAccount!, await readSnapshot(sql), sql);
      const otherBefore = await accountAvailability(otherAccount!, await readSnapshot(sql), sql);

      // MEASURED: `company_name` longer than 16 characters is rejected with
      // `Your request contains invalid parameters` — the NACHA Company Name
      // field is 16 bytes, and Increase enforces it rather than truncating.
      const created = await rail.simulateInboundAchTransfer({
        accountNumberId: owner.providerAccountNumberId,
        amountCents: KEEP_AMOUNT_CENTS,
        companyName: "ITEM FIVE BUYER",
        companyEntryDescription: "PAYMENT",
      });

      const creditKey = `${INBOUND_CREDIT_KEY_PREFIX}${created.id}`;
      const credit = await drainUntil(creditKey, 180_000);
      expect(credit, `no entry under ${creditKey}`).not.toBeNull();

      const ownerAfter = await accountAvailability(ownerAccount!, await readSnapshot(sql), sql);
      const otherAfter = await accountAvailability(otherAccount!, await readSnapshot(sql), sql);

      // The money went to the business whose account number was addressed.
      expect(ownerAfter.ledgerCents - ownerBefore.ledgerCents).toBe(BigInt(KEEP_AMOUNT_CENTS));
      // And to nobody else. Every other assertion in this file would hold for a
      // build that guessed; this one would not.
      expect(otherAfter.ledgerCents).toBe(otherBefore.ledgerCents);
      expect(otherAfter.availableCents).toBe(otherBefore.availableCents);

      // Nobody recalls it, so it stays — and stays UNAVAILABLE until the
      // availability sweep reaches its release instant, which is two banking
      // days out. The hold is the reason, and it is still open.
      expect(ownerAfter.availableCents).toBe(ownerBefore.availableCents);
      const [hold] = await sql<{ available_at: Date; closures: number }[]>`
        SELECT h.available_at,
               (SELECT count(*)::int FROM hold_closure c WHERE c.hold_id = h.id) AS closures
          FROM hold h
         WHERE h.kind = 'uncleared_credit'
           AND h.external_ref = ${inboundAchExternalRef(created.id)}`;
      expect(hold?.closures).toBe(0);
      expect(hold!.available_at.getTime()).toBeGreaterThan(Date.now());
    },
    600_000,
  );

  /**
   * THE REDRIVE, and the reason it is an assertion rather than a chore.
   *
   * Issuing account numbers changes what a PAST refusal means. Every delivery
   * parked on `inbound_ach_account_mapping` was parked because nothing on this
   * book could say whose the number was; some of those numbers have owners now
   * and some never will. A build that quietly left them parked would be hiding
   * money it can suddenly attribute, and a build that force-posted them would
   * be attributing money addressed to the programme's shared number. So: drive
   * every one of them through the CURRENT consumer and let each land where it
   * lands.
   *
   * `A ROW THAT POSTS NOTHING IS A RESULT.` The assertion is not "they all
   * post" — it is that every one of them ends in a state that says which, with
   * a reason that is true today.
   *
   * Gated separately because it WRITES: it makes parked rows due now, which is
   * an operator action (`scripts/redrive.mjs` does the same for dead letters,
   * as the same role, for the same reason — the guard in migration 0002 permits
   * exactly the processing columns and refuses everything else).
   */
  it.skipIf(process.env["RUN_INBOUND_REDRIVE"] !== "1")(
    "redrives every delivery parked for want of an account-number mapping",
    async () => {
      const due = await sql<{ id: string }[]>`
        UPDATE webhook_inbox
           SET next_attempt_at = now()
         WHERE state = 'parked'
           AND parked_on_kind IN ('inbound_ach_account_mapping', 'inbound_wire_account_mapping')
        RETURNING id`;

      for (let i = 0; i < 6; i += 1) {
        const result = await drain({ maxBatches: 5 });
        if (result.claimed === 0) break;
      }

      const after = await sql<
        {
          parked_on_kind: string;
          state: string;
          n: number;
        }[]
      >`
        SELECT parked_on_kind, state, count(*)::int AS n
          FROM webhook_inbox
         WHERE parked_on_kind IN ('inbound_ach_account_mapping', 'inbound_wire_account_mapping')
         GROUP BY 1, 2 ORDER BY 1, 2`;
      // eslint-disable-next-line no-console -- the redrive's whole output is its report
      console.log(`redriven ${due.length} row(s):`, JSON.stringify(after));

      // Nothing was lost and nothing was dead-lettered by the redrive: every
      // delivery is either finished or still parked in front of a person.
      expect(after.every((r) => r.state === "done" || r.state === "parked")).toBe(true);

      // And every row still parked says why, naming the number it could not
      // map — not a reason from a build that no longer exists.
      const stale = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM webhook_inbox
         WHERE state = 'parked'
           AND parked_on_kind = 'inbound_ach_account_mapping'
           AND parked_reason NOT LIKE '%account_number_id%'`;
      expect(stale[0]?.n).toBe(0);
    },
    600_000,
  );
});
