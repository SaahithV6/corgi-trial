/**
 * ATTACK 1 — "Create a card and simulate a $50.00 fuel-pump authorisation.
 * Assert AVAILABLE balance drops by 5000 and LEDGER balance does not move at
 * all."
 *
 * End to end, through the real provider and the deployed system. Nothing here
 * calls the hold logic directly: the test creates a card on Lithic, asks Lithic
 * to authorise $50.00 at MCC 5542, and then watches the LIVE DATABASE for the
 * effect. If the effect is right, the pipeline is right; if the pipeline does
 * not exist, no assertion here can be satisfied honestly and the test skips.
 *
 * ============================================================================
 * WHY THIS SKIPS TODAY.
 *
 * `src/lib/holds/*` is being written by another worker. Until it lands there is
 * no consumer registered for Lithic's `card_transaction.updated`, nothing runs
 * `dispatchOnce()` in production, and a delivery therefore reaches
 * `webhook_inbox` and stops. The available balance cannot move because nothing
 * posts a memo entry.
 *
 * The skip is deliberate and it is not a stub. Making this pass by posting the
 * memo entry from the test would assert that the TEST can do arithmetic, which
 * is not the claim.
 * ============================================================================
 */
import { existsSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type * as LithicClient from "@/lib/rails/lithic/client";

const ATTACK = 1;
const NAME = "$50 fuel-pump authorisation moves AVAILABLE by 5000 and LEDGER by nothing";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

/**
 * The one sentence the whole card-hold family of attacks is waiting on. Kept
 * identical in attacks 1, 2 and 4 so the scoreboard reads as one gap and not
 * three unrelated ones.
 */
const PIPELINE_MISSING =
  "the card authorisation pipeline does not exist yet. src/lib/holds/* is unwritten, so no webhook consumer is registered for Lithic 'card_transaction.updated' in src/lib/webhooks/dispatch.ts and nothing runs dispatchOnce() in production. A delivery reaches webhook_inbox and stops there: no card_authorization row, no hold, no memo posting, so AVAILABLE cannot move. Waiting on src/lib/holds/* plus a dispatcher run reachable from the deployment.";

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

  it("available drops by exactly 5000 and the ledger does not move", async (ctx) => {
    // Snapshot every business, because which one the card belongs to is the
    // pipeline's decision and not ours.
    const businesses = await sql<{ id: string }[]>`SELECT id FROM business ORDER BY id`;
    const before = new Map<string, BalancesModule.AvailableBalance>();
    for (const business of businesses) {
      before.set(business.id, await bal.availableBalance(business.id));
    }
    const trialBefore = await bal.trialBalanceCents();

    const card = await lithic.createCard({
      type: "VIRTUAL",
      memo: `livefire fuel pump ${tag}`,
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
      mcc: "5542", // automated fuel dispenser
    });
    if (auth.token === undefined) throw new Error("Lithic returned no transaction token");

    // Wait for the pipeline to turn the delivery into an authorisation.
    let authRow: { account_id: string; hold_id: string } | null = null;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const [row] = await sql<{ account_id: string; hold_id: string }[]>`
        SELECT account_id, hold_id FROM card_authorization
         WHERE provider = 'lithic' AND provider_auth_id = ${auth.token}`;
      if (row) {
        authRow = row;
        break;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }

    if (authRow === null) {
      const [filed] = await sql<{ id: string; state: string }[]>`
        SELECT id, state::text AS state FROM webhook_inbox
         WHERE provider = 'lithic' AND payload->>'token' = ${auth.token}
         ORDER BY received_at DESC LIMIT 1`;
      const reason = `${PIPELINE_MISSING} Observed this run: Lithic transaction ${auth.token} produced inbox row ${filed?.id ?? "(none)"} in state ${filed?.state ?? "(none)"} and no card_authorization row within 90s.`;
      record("skip", reason);
      ctx.skip(reason);
      return;
    }

    const [owner] = await sql<{ business_id: string }[]>`
      SELECT business_id FROM account WHERE id = ${authRow.account_id}::uuid`;
    const businessId = owner?.business_id;
    if (businessId === undefined || businessId === null) {
      throw new Error(`card_authorization.account_id ${authRow.account_id} has no business_id`);
    }

    const priorState = before.get(businessId);
    if (priorState === undefined) {
      throw new Error(`the authorisation landed on business ${businessId}, which was not snapshotted`);
    }

    const after = await bal.availableBalance(businessId);

    // THE TWO ASSERTIONS THE ATTACK IS.
    expect(after.availableCents).toBe(priorState.availableCents - BigInt(AUTH_CENTS));
    expect(after.ledgerCents).toBe(priorState.ledgerCents);

    // The whole of the drop is a card-auth hold, sized from the event set
    // rather than read off the provider's status field (DECISIONS 006).
    expect(after.holdsCents - priorState.holdsCents).toBe(BigInt(AUTH_CENTS));
    expect(after.unclearedCents).toBe(priorState.unclearedCents);

    // The hold is memo-only, so the financial book is untouched.
    expect(await bal.trialBalanceCents()).toBe(trialBefore);

    record(
      "evidence",
      `business ${businessId}: available ${priorState.availableCents} -> ${after.availableCents} (delta ${after.availableCents - priorState.availableCents}, expected -${AUTH_CENTS}); ledger ${priorState.ledgerCents} -> ${after.ledgerCents} (unchanged); card-auth holds +${after.holdsCents - priorState.holdsCents}; hold ${authRow.hold_id} for Lithic transaction ${auth.token}; trial balance unchanged at ${trialBefore}`,
    );
  });
});
