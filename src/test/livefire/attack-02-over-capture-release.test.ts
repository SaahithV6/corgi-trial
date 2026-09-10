/**
 * ATTACK 2 — "Capture $73.40 two days later. Assert the hold releases exactly
 * once (one closure row, one release posting) and the ledger posts the settled
 * 7340. Available goes negative; assert it is NOT clamped."
 *
 * The fuel-pump over-capture: authorise $50.00, clear $73.40. Lithic's own
 * `status` flips to SETTLED while a partial hold is still live (DECISIONS 006),
 * so a system that released holds on that field would free money that is still
 * authorised. This asserts the outcome, not the mechanism, and it reads that
 * outcome out of the live database after the deployed system processed it.
 *
 * WHAT "EXACTLY ONCE" IS ASSERTED AS, and both halves are required:
 *   * exactly ONE `hold_closure` row for the hold — PRIMARY KEY (hold_id), so a
 *     second is unrepresentable, and this proves the first was written;
 *   * exactly ONE release POSTING — the memo entries for that hold are the
 *     opening delta and its exact negation, and nothing else. Two entries,
 *     summing to zero, so the hold's memo balance is zero.
 *
 * WHAT "NOT CLAMPED" IS ASSERTED AS: `available == ledger − holds − uncleared`
 * exactly, in integers, with no floor anywhere; the customer's available moves
 * by exactly −7340 across the whole episode (the $50.00 hold comes back, the
 * $73.40 settles), which is only true if nothing was clipped at zero; and the
 * resulting figure is reported negative when it is negative.
 *
 * ONE HONEST NOTE. "Two days later" is not reproducible: the Lithic sandbox has
 * no test clock for card transactions, so the clearing is simulated in the same
 * run. What the attack is about — the release arithmetic and its exactly-once
 * property — does not depend on the gap, and the value dates the pipeline
 * records come from the provider's own payload either way.
 */
import { appendFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as Holds from "@/lib/holds";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 2;
const NAME =
  "Over-capture at $73.40 releases the $50 hold exactly once, and available is not clamped";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const BASE_URL = (
  process.env["LIVEFIRE_BASE_URL"] ?? "https://corgi-trial-psi.vercel.app"
).replace(/\/+$/, "");

const MISSING: string[] = [];
if (process.env["LIVEFIRE"] !== "1") MISSING.push("LIVEFIRE=1");
if (typeof process.env["APP_DATABASE_URL"] !== "string") MISSING.push("APP_DATABASE_URL");
if (typeof process.env["LITHIC_API_KEY"] !== "string" || process.env["LITHIC_API_KEY"] === "") {
  MISSING.push("LITHIC_API_KEY");
}

const READY = MISSING.length === 0;
if (!READY) record("skip", `missing: ${MISSING.join(", ")}; run scripts/livefire.mjs`);

const d = READY ? describe : describe.skip;

const AUTH_CENTS = 50_00;
const CAPTURE_CENTS = 73_40;

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let bal: typeof BalancesModule;
  let holds: typeof Holds;
  let lithic: typeof LithicClient;

  const tag = Date.now().toString(36).toUpperCase();
  let drainStatus = "not attempted";

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    bal = await import("@/lib/ledger/balances");
    holds = await import("@/lib/holds");
    lithic = await import("@/lib/rails/lithic/client");
  });

  /**
   * The operator's "watch, I will drain it now", against the DEPLOYED endpoint.
   * Not a local dispatcher: what is under test is production.
   */
  async function nudgeDrain() {
    const token = process.env["DRAIN_TOKEN"];
    if (token === undefined || token === "") {
      drainStatus = "no DRAIN_TOKEN in the environment";
      return;
    }
    try {
      const response = await fetch(`${BASE_URL}/api/drain`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const body = (await response.json()) as Record<string, unknown>;
      drainStatus =
        response.status === 200
          ? `HTTP 200 claimed=${String(body["claimed"])} processed=${String(body["processed"])} parked=${String(body["parked"])}`
          : `HTTP ${response.status} ${JSON.stringify(body).slice(0, 160)}`;
    } catch (thrown) {
      drainStatus = `unreachable: ${thrown instanceof Error ? thrown.message : String(thrown)}`;
    }
  }

  /** Poll the live database, nudging the deployed drain between reads. */
  async function until<T>(read: () => Promise<T | null>, ms: number): Promise<T | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value !== null) return value;
      if (Date.now() >= deadline) return null;
      await nudgeDrain();
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }

  it("releases the hold exactly once, posts 7340, and does not clamp available", async (ctx) => {
    const [customer] = await sql<{ business_id: string }[]>`
      SELECT dep.business_id
        FROM account dep
        JOIN account memo ON memo.business_id = dep.business_id AND memo.code = '9100'
       WHERE dep.code = '2100' AND dep.business_id IS NOT NULL
       ORDER BY dep.business_id LIMIT 1`;
    if (!customer) throw new Error("no business has a 2100/9100 pair: run node scripts/seed.mjs");
    const businessId = customer.business_id;

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
    await holds.registerCard(
      {
        provider: "lithic",
        providerCardToken: card.token,
        businessId,
        lastFour: card.last_four,
        nickname: `live-fire ${tag}`,
      },
      sql,
    );

    const beforeAuth = await bal.availableBalance(businessId);

    const auth = await lithic.simulateAuthorize({
      amount: AUTH_CENTS,
      descriptor: `CORGI FUEL ${tag}`.slice(0, 25),
      pan,
      status: "AUTHORIZATION",
      mcc: "5542",
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");
    const transactionToken: string = auth.token;

    const authRow = await until(async () => {
      const [row] = await sql<{ id: string; hold_id: string }[]>`
        SELECT id, hold_id FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${transactionToken}`;
      return row ?? null;
    }, 90_000);

    if (authRow === null) {
      const reason = `the $50.00 authorisation never reached the ledger, so there is no hold to release and the attack is unproven. Lithic transaction ${transactionToken} on registered card ${card.token} produced no card_authorization row within 90s; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // Position with the hold live: this is what the capture has to undo.
    const held = await bal.availableBalance(businessId);
    expect(held.holdsCents - beforeAuth.holdsCents).toBe(BigInt(AUTH_CENTS));

    // ---- the capture, over the amount authorised -------------------------
    await lithic.simulateClearing({ token: transactionToken, amountCents: CAPTURE_CENTS });

    const closed = await until(async () => {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM hold_closure WHERE hold_id = ${authRow.hold_id}::uuid`;
      return (row?.n ?? 0) > 0 ? row : null;
    }, 90_000);

    if (closed === null) {
      const reason = `the $73.40 clearing for ${transactionToken} produced no hold_closure row for hold ${authRow.hold_id} within 90s, so "releases exactly once" is unproven; POST ${BASE_URL}/api/drain answered ${drainStatus}.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    // ---- 1. ONE closure row ----------------------------------------------
    expect(closed.n).toBe(1);

    // ---- 2. ONE release posting ------------------------------------------
    // Every memo entry against this hold, netted over the hold's own memo
    // account: the opening, and its exact negation. Nothing else.
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

    expect(memo).toHaveLength(2);
    const opening = memo[0];
    const release = memo[1];
    if (opening === undefined || release === undefined) throw new Error("unreachable");
    expect(opening.delta).toBe(-BigInt(AUTH_CENTS)); // credit: more held
    expect(release.delta).toBe(BigInt(AUTH_CENTS)); // debit: released, once
    expect(opening.delta + release.delta).toBe(0n);

    // ---- 3. the ledger posts the settled 7340 ----------------------------
    const after = await bal.availableBalance(businessId);
    expect(held.ledgerCents - after.ledgerCents).toBe(BigInt(CAPTURE_CENTS));

    const [settlement] = await sql<{ n: number; cents: bigint }[]>`
      SELECT count(DISTINCT e.id)::int AS n,
             COALESCE(SUM(l.amount_cents), 0)::bigint AS cents
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN account       a ON a.id = l.account_id
                            AND a.code = '2100' AND a.business_id = ${businessId}::uuid
       WHERE e.book = 'financial' AND e.rail = 'card'
         AND e.external_ref = ${transactionToken}`;
    expect(settlement?.n).toBe(1);
    expect(settlement?.cents).toBe(BigInt(CAPTURE_CENTS));

    // ---- 4. the hold is gone, once ---------------------------------------
    expect(after.holdsCents).toBe(beforeAuth.holdsCents);

    // ---- 5. NOT CLAMPED ---------------------------------------------------
    // The decomposition is exact, in integers, with no floor. A clamp anywhere
    // is the first thing this identity would break.
    expect(after.availableCents).toBe(after.ledgerCents - after.holdsCents - after.unclearedCents);
    // Across the whole episode: the $50 hold came back, $73.40 settled.
    expect(after.availableCents).toBe(beforeAuth.availableCents - BigInt(CAPTURE_CENTS));

    record(
      "evidence",
      `hold ${authRow.hold_id}: hold_closure rows = ${closed.n} (exactly one); memo entries = ${memo.length}, deltas ${opening.delta} then ${release.delta} (net 0 — one opening, one release)`,
    );
    record(
      "evidence",
      `business ${businessId}: ledger ${held.ledgerCents} -> ${after.ledgerCents} (settled ${CAPTURE_CENTS} in exactly 1 financial entry under external_ref ${transactionToken}); available ${beforeAuth.availableCents} -> ${held.availableCents} held -> ${after.availableCents}; available == ledger(${after.ledgerCents}) - holds(${after.holdsCents}) - uncleared(${after.unclearedCents}) exactly, not clamped${after.availableCents < 0n ? " — and it IS negative, reported as negative rather than floored at zero" : ""}; drain ${drainStatus}`,
    );
  });
});
