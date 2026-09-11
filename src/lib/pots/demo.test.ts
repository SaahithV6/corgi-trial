/**
 * Stand up the demo pots on the live database, and prove the identity after.
 *
 * Gated on RUN_POT_DEMO=1 — separately from RUN_DB_TESTS, because this one
 * MOVES REAL MONEY on the demo business rather than on a fixture company, and
 * a suite that does that must be opted into deliberately every time.
 *
 *   set -a; . ./.env; set +a; RUN_POT_DEMO=1 pnpm vitest run src/lib/pots/demo
 *
 * It is safe to run repeatedly: both writes are idempotent by a UNIQUE index
 * (`pot(business_id, name)` and `journal_entry.idempotency_key`), so a second
 * run opens nothing and posts nothing. That property is asserted below rather
 * than assumed — the second pass through `seedDemoPots` in the same test must
 * leave every balance identical.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { sql as SqlHandle } from "@/lib/ledger/db";

import type * as DemoModule from "./demo";
import type * as StoreModule from "./store";

const RUN = process.env["RUN_POT_DEMO"] === "1";
const d = RUN ? describe : describe.skip;

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

d("demo pots, on the live database", () => {
  let sql: typeof SqlHandle;
  let demo: typeof DemoModule;
  let store: typeof StoreModule;
  let businessId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    demo = await import("./demo");
    store = await import("./store");

    // The demo customer: the one with real card holds and real uncleared
    // credits on it, so "available is not the ledger balance" is visible on
    // the screen without arranging anything.
    const businesses = await store.listPotBusinesses(sql);
    const ridgeline = businesses.find((b) =>
      b.legalName.toLowerCase().includes("ridgeline"),
    );
    const chosen = ridgeline ?? businesses[0];
    if (chosen === undefined) throw new Error("no customer with a deposit account");
    businessId = chosen.businessId;
  });

  it("seeds the demo pots and leaves every invariant empty", async () => {
    const outcome = await demo.seedDemoPots(businessId, sql);

    // Printed rather than only asserted: these are the real entry ids and the
    // real before/after figures, and they belong in the run log where they can
    // be pasted into a report. `process.stdout` rather than `console`, which
    // this repo's eslint config bans — for good reasons that do not apply to a
    // suite whose entire output is the evidence.
    process.stdout.write(`\nBEFORE  ${outcome.before}\n`);
    for (const step of outcome.steps) {
      process.stdout.write(`  ${step.step}\n    ${step.detail}\n`);
    }
    process.stdout.write(`AFTER   ${outcome.after}\n\n`);

    for (const view of [
      "v_deposit_control_drift",
      "v_pot_identity_drift",
      "v_pot_negative",
      "v_pot_orphan",
      "v_internal_transfer_impure",
      "v_entry_unbalanced",
      "v_book_not_zero",
      "v_line_denorm_drift",
      "v_hold_drift",
    ] as const) {
      const rows = await sql.unsafe(`SELECT * FROM ${view}`);
      expect({ view, rows: rows.length }).toEqual({ view, rows: 0 });
    }

    const identity = await store.readIdentity(businessId, sql);
    const pots = await store.listPots(businessId, sql);
    const summed = pots.reduce((a, p) => a + p.balanceCents, 0n);

    // main + Σ pots = total = the recursive subtree walk. Three ways, one
    // number, and the last one shares no code with the first two.
    expect(identity).not.toBeNull();
    expect(identity?.potsCents).toBe(summed);
    expect((identity?.mainCents ?? 0n) + summed).toBe(identity?.totalCents);
    expect(identity?.totalCents).toBe(identity?.subtreeCents);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const [before] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM journal_entry`;
    const identityBefore = await store.readIdentity(businessId, sql);

    await demo.seedDemoPots(businessId, sql);

    const [after] = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM journal_entry`;
    const identityAfter = await store.readIdentity(businessId, sql);

    expect(after?.n).toBe(before?.n);
    expect(identityAfter).toEqual(identityBefore);
  });
});
