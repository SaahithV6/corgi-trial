/**
 * The customer's two server actions, driven as the public POST endpoints they
 * are.
 *
 * WHY A TEST AND NOT A `curl`. A Next 16 server action is not addressable by
 * hand: the POST carries a `Next-Action` id minted at build time and an
 * encoded argument frame, so `curl` cannot drive one and a `curl` that appears
 * to work is hitting the page, not the action. The action is proved by
 * IMPORTING it — the same shape `src/components/home/actions.test.ts` uses —
 * which runs the real body, against the real book, with the real library
 * underneath.
 *
 * `next/headers` and `next/cache` are stubbed because they require a request
 * scope that a test process does not have. Nothing else is: `createStandingOrder`,
 * `cancelStandingOrder`, `loadPayeeBook`, `availableBalance` and every SQL
 * predicate in `reader.ts` run for real.
 */

import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as ActionsModule from "./actions";

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

const RUN = process.env["RUN_DB_TESTS"] === "1";

/** Fixture businesses only. EIN `00-000000N`; never a named customer. */
const FIXTURE_BUSINESS = "70747300-0000-5000-a000-000000000001";
const FIXTURE_PAYEE = "27249ad6-8aa0-4b14-8838-f72542dbcb56";

/** A different fixture's payee — used to prove the tenant predicate refuses. */
const OTHER_BUSINESS_PAYEE = "962d9549-ae2e-439a-9c1f-733438a1255b";

let actions: typeof ActionsModule;

beforeAll(async () => {
  if (!RUN) return;
  actions = await import("./actions");
});

function createForm(over: Record<string, string> = {}): FormData {
  const form = new FormData();
  const fields: Record<string, string> = {
    mandateKey: `client-test-${crypto.randomUUID()}`,
    businessId: FIXTURE_BUSINESS,
    payeeId: FIXTURE_PAYEE,
    reference: "Vitest — customer recurring payment",
    amount: "12.34",
    cadence: "monthly",
    dayOfMonth: "1",
    // Far enough AHEAD that no date this mandate describes has arrived, so the
    // test writes an authority and puts nothing on tonight's schedule. Ahead
    // rather than behind because a window that has already closed is refused by
    // this action's own WINDOW_CLOSED guard — the catch-up window extends
    // backwards only, and that guard is measured here too.
    startDate: "2027-01-01",
    endDate: "2027-01-31",
    ...over,
  };
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

const IDLE = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  standingOrderId: null,
} as const;

describe.skipIf(!RUN)("createClientStandingOrderAction", () => {
  it("refuses a payee that belongs to another business, by predicate", async () => {
    const result = await actions.createClientStandingOrderAction(
      IDLE,
      createForm({ payeeId: OTHER_BUSINESS_PAYEE }),
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("UNKNOWN_PAYEE");
    expect(result.standingOrderId).toBeNull();
  });

  it("refuses a window that has already closed", async () => {
    const result = await actions.createClientStandingOrderAction(
      IDLE,
      createForm({ startDate: "2024-01-01", endDate: "2024-02-01" }),
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("WINDOW_CLOSED");
  });

  it("refuses an amount that is not dollars and cents, without touching the book", async () => {
    const result = await actions.createClientStandingOrderAction(
      IDLE,
      createForm({ amount: "12.3456" }),
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("INVALID_AMOUNT");
  });

  it("writes one mandate, and a second press of the same form writes none", async () => {
    // Every date it describes is in the future, so the row is a real authority
    // and `listDue()` — which never looks past the book date — can raise
    // nothing from it tonight.
    const form = createForm();

    const first = await actions.createClientStandingOrderAction(IDLE, form);
    expect(first.status).toBe("created");
    expect(first.standingOrderId).not.toBeNull();

    // THE SAME FormData — therefore the same server-minted mandate key, which
    // is what a double-press or a replayed POST looks like.
    const second = await actions.createClientStandingOrderAction(IDLE, form);
    expect(second.status).toBe("replayed");
    expect(second.standingOrderId).toBe(first.standingOrderId);

    // And it can be stopped from the same surface that created it.
    const cancel = new FormData();
    cancel.set("businessId", FIXTURE_BUSINESS);
    cancel.set("standingOrderId", first.standingOrderId ?? "");
    cancel.set("reason", "Vitest — cleaning up after itself");
    const stopped = await actions.cancelClientStandingOrderAction(IDLE, cancel);
    expect(stopped.status).toBe("cancelled");

    const again = await actions.cancelClientStandingOrderAction(IDLE, cancel);
    expect(again.status).toBe("already");
  });
});

describe.skipIf(!RUN)("cancelClientStandingOrderAction", () => {
  it("refuses a mandate that is not on this business", async () => {
    const form = new FormData();
    form.set("businessId", FIXTURE_BUSINESS);
    // A well-formed uuid that names nothing on this business.
    form.set("standingOrderId", "00000000-0000-4000-8000-000000000000");
    form.set("reason", "Vitest — should never succeed");
    const result = await actions.cancelClientStandingOrderAction(IDLE, form);
    expect(result.status).toBe("refused");
    expect(result.code).toBe("UNKNOWN_MANDATE");
  });
});
