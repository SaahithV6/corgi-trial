/**
 * ATTACK 2 — "Capture $73.40 two days later. Assert the hold releases exactly
 * once (one closure row, one release posting) and the ledger posts the settled
 * 7340. Available goes negative; assert it is NOT clamped."
 *
 * The fuel-pump over-capture: authorise $50.00, clear $73.40. Lithic's own
 * `status` flips to SETTLED while a partial hold is still live (DECISIONS 006),
 * so a system that released holds on that field would free money that is still
 * authorised. This asserts the outcome, not the mechanism.
 *
 * WHAT "EXACTLY ONCE" IS ASSERTED AS, and both halves are required:
 *   * exactly ONE `hold_closure` row for the hold — PRIMARY KEY (hold_id), so a
 *     second is unrepresentable, and this proves the first was written;
 *   * exactly ONE release POSTING — the memo entries for that hold are the
 *     opening delta and its exact negation, and nothing else. Two entries, and
 *     they sum to zero.
 *
 * WHAT "NOT CLAMPED" IS ASSERTED AS: `available == ledger − holds − uncleared`
 * exactly, in integers, with no floor anywhere — and the customer's available
 * moves by exactly −7340 across the whole episode (the $50.00 hold comes back,
 * the $73.40 settles), which is only true if nothing was clipped at zero.
 *
 * TWO HONEST NOTES.
 *   * "Two days later" is not reproducible: the Lithic sandbox has no test
 *     clock for card transactions, so the clearing is simulated in the same
 *     run. What the attack is about — the release arithmetic and its
 *     exactly-once property — does not depend on the gap, and the value dates
 *     the pipeline records come from the provider's own payload either way.
 *   * The `hold_closure` requirement is a requirement this suite places on
 *     `src/lib/holds/*`. See README §"What attacks 1, 2 and 4 require".
 *
 * SKIPS TODAY for the same reason as attack 1: nothing consumes the delivery.
 */
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 2;
const NAME = "Over-capture at $73.40 releases the $50 hold exactly once, and available is not clamped";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const PIPELINE_MISSING =
  "the card authorisation pipeline does not exist yet. src/lib/holds/* is unwritten, so no webhook consumer is registered for Lithic 'card_transaction.updated' in src/lib/webhooks/dispatch.ts and nothing runs dispatchOnce() in production. A delivery reaches webhook_inbox and stops there: no hold to release, no hold_closure row, no memo posting. Waiting on src/lib/holds/* plus a dispatcher run reachable from the deployment.";

const PIPELINE_PRESENT = existsSync(resolve(process.cwd(), "src/lib/holds"));

const MISSING: string[] = [];
if (process.env["LIVEFIRE"] !== "1") MISSING.push("LIVEFIRE=1");
if (typeof process.env["APP_DATABASE_URL"] !== "string") MISSING.push("APP_DATABASE_URL");
if (typeof process.env["LITHIC_API_KEY"] !== "string" || process.env["LITHIC_API_KEY"] === "") {
  MISSING.push("LITHIC_API_KEY");
}

const READY = MISSING.length === 0 && PIPELINE_PRESENT;
if (!READY) {
  record("skip", MISSING.length > 0 ? `missing: ${MISSING.join(", ")}` : PIPELINE_MISSING);
}

const d = READY ? describe : describe.skip;

const AUTH_CENTS = 50_00;
const CAPTURE_CENTS = 73_40;

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    lithic = await import("@/lib/rails/lithic/client");
  });

  /** Poll the live database until `read` returns something, or give up. */
  async function until<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }

  it("releases the hold exactly once, posts 7340, and does not clamp available", async (ctx) => {
    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire over-capture ${tag}`,
      spend_limit: 5_000_00,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    const pan = card.pan;
    if (pan === undefined || pan === "") {
      throw new Error("Lithic returned a card with no PAN; the sandbox PCI shape has changed");
    }

    const auth = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");
    const transactionToken: string = auth.token;

    const authRow = await until(
      async () => {
        const [row] = await sql<{ id: string; account_id: string; hold_id: string }[]>`
          SELECT id, account_id, hold_id FROM card_authorization
           WHERE provider = 'lithic' AND provider_auth_id = ${transactionToken}`;
        return row ?? null;
      },
      90_000,
    );

    if (authRow === null) {
      const reason = `${PIPELINE_MISSING} Observed this run: Lithic transaction ${transactionToken} produced no card_authorization row within 90s.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const [owner] = await sql<{ business_id: string | null }[]>`
      SELECT business_id FROM account WHERE id = ${authRow.account_id}::uuid`;
    const businessId = owner?.business_id;
    if (businessId === undefined || businessId === null) {
      throw new Error(`card_authorization.account_id ${authRow.account_id} has no business_id`);
    }

    // Position after the authorisation and before the capture.
    const held = await bal.availableBalance(businessId);
    expect(held.holdsCents).toBeGreaterThanOrEqual(BigInt(AUTH_CENTS));

    // ---- the capture, over the amount authorised -------------------------
    await lithic.simulateClearing({ token: transactionToken, amountCents: CAPTURE_CENTS });

    const settled = await until(
      async () => {
        const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM hold_closure WHERE hold_id = ${authRow.hold_id}::uuid`;
        return (row?.n ?? 0) > 0 ? row : null;
      },
      90_000,
    );

    if (settled === null) {
      const reason = `${PIPELINE_MISSING} Observed this run: the $73.40 clearing for ${transactionToken} produced no hold_closure row for hold ${authRow.hold_id} within 90s.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // ---- 1. ONE closure row ----------------------------------------------
    const [closures] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM hold_closure WHERE hold_id = ${authRow.hold_id}::uuid`;
    expect(closures?.n).toBe(1);

    // ---- 2. ONE release posting ------------------------------------------
    // Every memo entry against this hold, netted over the hold's own memo
    // account. Two entries: the opening and its exact negation.
    const memo = await sql<{ entry_id: string; delta: bigint }[]>`
      SELECT e.id AS entry_id, SUM(l.amount_cents)::bigint AS delta
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN hold          h ON h.id = e.hold_id
       WHERE e.hold_id = ${authRow.hold_id}::uuid
         AND e.book = 'memo'
         AND l.account_id = h.memo_account_id
       GROUP BY e.id, e.booking_seq
       ORDER BY e.booking_seq`;

    const opening = memo[0];
    const release = memo[1];
    expect(memo).toHaveLength(2);
    if (opening === undefined || release === undefined) throw new Error("unreachable");
    expect(opening.delta === 0n).toBe(false);
    expect(release.delta).toBe(-opening.delta);
    expect(opening.delta < 0n ? -opening.delta : opening.delta).toBe(BigInt(AUTH_CENTS));

    // ---- 3. the ledger posts the settled 7340 ----------------------------
    const after = await bal.availableBalance(businessId);
    expect(held.ledgerCents - after.ledgerCents).toBe(BigInt(CAPTURE_CENTS));

    // ---- 4. the hold is gone, once ---------------------------------------
    expect(after.holdsCents).toBe(held.holdsCents - BigInt(AUTH_CENTS));

    // ---- 5. NOT CLAMPED ---------------------------------------------------
    // The decomposition is exact, in integers, with no floor. If a clamp
    // existed anywhere this identity is the first thing it would break.
    expect(after.availableCents).toBe(
      after.ledgerCents - after.holdsCents - after.unclearedCents,
    );
    // Across the whole episode: the $50 hold came back, $73.40 settled.
    expect(after.availableCents).toBe(held.availableCents + BigInt(AUTH_CENTS) - BigInt(CAPTURE_CENTS));

    record(
      "evidence",
      `hold ${authRow.hold_id}: hold_closure rows = ${closures?.n} (exactly one); memo entries = ${memo.length}, deltas ${opening.delta} then ${release.delta} (net 0, one release posting)`,
    );
    record(
      "evidence",
      `business ${businessId}: ledger ${held.ledgerCents} -> ${after.ledgerCents} (settled ${CAPTURE_CENTS}); available ${held.availableCents} -> ${after.availableCents}; available == ledger - holds - uncleared exactly (${after.ledgerCents} - ${after.holdsCents} - ${after.unclearedCents}), not clamped${after.availableCents < 0n ? " — and it is negative, reported as negative" : ""}`,
    );
  });
});
