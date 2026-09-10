import { describe, expect, it } from "vitest";

import { isErr, isOk, unwrap } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import type { Hold, Posting } from "./data-contract";
import { DEMO_ACCOUNTS, getAccountDataSource } from "./fixtures";
import { demoQuery, parseDemoView } from "./demo-state";
import {
  expectedRemainingCents,
  holdStatus,
  isOverCaptured,
  overCaptureCents,
  providerStatusDisagrees,
  reconcileBalances,
  runningLedgerBalances,
  sortHolds,
} from "./derive";

const ACCOUNT_ID = "acct_operating_4417";

async function load(state: "default" | "empty" | "edge", authPending = false) {
  const source = getAccountDataSource({ state, authPending });
  const [summary, holds, postings] = await Promise.all([
    source.getAccountSummary({ accountId: ACCOUNT_ID }),
    source.listHolds({ accountId: ACCOUNT_ID }),
    source.listPostings({ accountId: ACCOUNT_ID }),
  ]);
  return {
    summary: unwrap(summary),
    holds: unwrap(holds),
    postings: unwrap(postings),
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/* -------------------------------------------------------------------------- */

describe("expectedRemainingCents — H(E) = 0 if closed else max(A − C, 0)", () => {
  it("reproduces the Lithic sandbox arithmetic measured in DECISIONS 006", () => {
    // authorize 1000, clearing 600 (partial): hold 400 while status says SETTLED.
    expect(
      expectedRemainingCents({
        authorisedCents: 1_000,
        clearedCents: 600,
        closed: false,
      }),
    ).toBe(400);

    // second partial clearing 300: hold 100.
    expect(
      expectedRemainingCents({
        authorisedCents: 1_000,
        clearedCents: 900,
        closed: false,
      }),
    ).toBe(100);

    // authorize 5000, clearing 7340 (over-capture): hold 0, never negative.
    expect(
      expectedRemainingCents({
        authorisedCents: 5_000,
        clearedCents: 7_340,
        closed: true,
      }),
    ).toBe(0);
    expect(
      expectedRemainingCents({
        authorisedCents: 5_000,
        clearedCents: 7_340,
        closed: false,
      }),
    ).toBe(0);
  });

  it("zeroes a closed hold whatever the arithmetic says", () => {
    expect(
      expectedRemainingCents({
        authorisedCents: 5_000,
        clearedCents: 0,
        closed: true,
      }),
    ).toBe(0);
  });
});

describe("over-capture", () => {
  const overCaptured = { authorisedCents: 5_000, clearedCents: 7_340 };

  it("is detected", () => {
    expect(isOverCaptured(overCaptured)).toBe(true);
    expect(isOverCaptured({ authorisedCents: 5_000, clearedCents: 5_000 })).toBe(
      false,
    );
  });

  it("reports the amount that was never held", () => {
    expect(overCaptureCents(overCaptured)).toBe(2_340);
    expect(
      overCaptureCents({ authorisedCents: 5_000, clearedCents: 600 }),
    ).toBe(0);
  });
});

describe("fixtures satisfy the ledger's own invariants", () => {
  it("every hold's remaining amount is the derived H(E)", async () => {
    for (const state of ["default", "edge"] as const) {
      const { holds } = await load(state);
      for (const hold of holds) {
        expect(
          hold.remainingCents,
          `${state}/${hold.descriptor} disagrees with H(E)`,
        ).toBe(expectedRemainingCents(hold));
      }
    }
  });

  it("available = ledger − active holds − uncleared credits, exactly", async () => {
    for (const state of ["default", "empty", "edge"] as const) {
      const { summary } = await load(state);
      const reconciliation = reconcileBalances(summary);
      expect(reconciliation.reconciles, `${state} does not reconcile`).toBe(true);
      expect(reconciliation.driftCents).toBe(0);
    }
  });

  it("the summary's hold totals are the sum of the holds it lists", async () => {
    for (const state of ["default", "edge"] as const) {
      const { summary, holds } = await load(state);

      const uncleared = sum(
        holds
          .filter((hold) => hold.kind === "uncleared_credit")
          .map((hold) => hold.remainingCents),
      );
      const active = sum(
        holds
          .filter((hold) => hold.kind !== "uncleared_credit")
          .map((hold) => hold.remainingCents),
      );

      expect(summary.unclearedCreditsCents).toBe(uncleared);
      expect(summary.activeHoldsCents).toBe(active);
    }
  });

  it("never lists a negative remaining hold", async () => {
    for (const state of ["default", "edge"] as const) {
      const { holds } = await load(state);
      for (const hold of holds) expect(hold.remainingCents).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the demo: an authorisation moves available and not ledger", () => {
  it("drops available by exactly $50.00 and leaves the ledger balance untouched", async () => {
    const before = await load("default", false);
    const after = await load("default", true);

    expect(after.summary.ledgerCents).toBe(before.summary.ledgerCents);
    expect(before.summary.availableCents - after.summary.availableCents).toBe(
      5_000,
    );
    expect(after.summary.activeHoldsCents - before.summary.activeHoldsCents).toBe(
      5_000,
    );
  });

  it("records the authorisation as a memo posting with no ledger effect", async () => {
    const { postings } = await load("default", true);
    const auth = postings[0];

    expect(auth?.book).toBe("memo");
    expect(auth?.ledgerDeltaCents).toBeNull();
    expect(auth?.availableDeltaCents).toBe(-5_000);
  });
});

describe("the edge state is a correct ledger, not a bug", () => {
  it("shows a negative available balance driven by an over-capture", async () => {
    const { summary, holds } = await load("edge");

    expect(summary.availableCents).toBeLessThan(0);

    const fuel = holds.find((hold) => hold.descriptor.startsWith("SHELL OIL"));
    expect(fuel).toBeDefined();
    expect(fuel && isOverCaptured(fuel)).toBe(true);
    expect(fuel?.remainingCents).toBe(0);
    expect(fuel && holdStatus(fuel)).toBe("over_captured");
    expect(fuel && overCaptureCents(fuel)).toBe(2_340);
  });

  it("would have stayed positive had the pump captured what it authorised", async () => {
    const { summary, holds } = await load("edge");
    const excess = sum(holds.map((hold) => overCaptureCents(hold)));
    expect(summary.availableCents + excess).toBeGreaterThanOrEqual(0);
  });
});

describe("provider status", () => {
  it("flags a rail that claims SETTLED while money is still held", async () => {
    const { holds } = await load("default");
    const sysco = holds.find((hold) => hold.descriptor.startsWith("SYSCO"));

    expect(sysco?.providerStatus).toBe("SETTLED");
    expect(sysco?.remainingCents).toBe(26_000);
    expect(sysco && providerStatusDisagrees(sysco)).toBe(true);
  });

  it("does not flag a settled status on a released hold", async () => {
    const { holds } = await load("edge");
    const fuel = holds.find((hold) => hold.descriptor.startsWith("SHELL OIL"));
    expect(fuel && providerStatusDisagrees(fuel)).toBe(false);
  });
});

describe("sortHolds", () => {
  it("puts active holds first, newest first within a group", () => {
    const base: Omit<Hold, "id" | "remainingCents" | "placedAt"> = {
      kind: "card_auth",
      descriptor: "x",
      authorisedCents: 100,
      clearedCents: 0,
      closed: false,
      expiresAt: null,
      availableAt: null,
      policyRef: null,
      providerStatus: null,
    };

    const sorted = sortHolds([
      { ...base, id: "closed_new", remainingCents: 0, placedAt: "2026-09-09T10:00:00Z" },
      { ...base, id: "active_old", remainingCents: 100, placedAt: "2026-09-01T10:00:00Z" },
      { ...base, id: "active_new", remainingCents: 100, placedAt: "2026-09-08T10:00:00Z" },
    ]);

    expect(sorted.map((hold) => hold.id)).toEqual([
      "active_new",
      "active_old",
      "closed_new",
    ]);
  });
});

describe("runningLedgerBalances", () => {
  const posting = (
    id: string,
    ledgerDeltaCents: number | null,
  ): Posting => ({
    id,
    book: ledgerDeltaCents === null ? "memo" : "financial",
    description: id,
    counterparty: null,
    occurredAt: "2026-09-09T00:00:00.000Z",
    valueDate: "2026-09-09",
    ledgerDeltaCents,
    availableDeltaCents: 0,
    holdId: null,
    sourceRef: null,
  });

  it("walks the balance backwards through a newest-first list", () => {
    // Current balance 1000. Newest posting was +250, before it −100.
    const balances = runningLedgerBalances(
      [posting("a", 250), posting("b", -100)],
      1_000,
    );
    expect(balances).toEqual([1_000, 750]);
  });

  it("gives memo postings no balance at all, rather than an unchanged one", () => {
    const balances = runningLedgerBalances(
      [posting("memo", null), posting("a", 250)],
      1_000,
    );
    expect(balances).toEqual([null, 1_000]);
  });

  it("reconciles the fixture ledger back to its opening balance", async () => {
    const { summary, postings } = await load("default");
    const balances = runningLedgerBalances(postings, summary.ledgerCents);

    expect(balances[0]).toBe(summary.ledgerCents);

    const financialTotal = sum(
      postings.map((row) => row.ledgerDeltaCents ?? 0),
    );
    const oldest = postings[postings.length - 1];
    const oldestBalance = balances[balances.length - 1];
    expect(oldest?.ledgerDeltaCents).not.toBeNull();
    // The balance shown beside the oldest row, minus everything above it,
    // is the opening balance the page implies.
    expect(summary.ledgerCents - financialTotal).toBe(
      (oldestBalance ?? 0) - (oldest?.ledgerDeltaCents ?? 0),
    );
  });
});

describe("reconcileBalances", () => {
  it("reports drift instead of hiding it", async () => {
    const { summary } = await load("default");
    const broken = { ...summary, availableCents: summary.availableCents + 1 };
    const reconciliation = reconcileBalances(broken);

    expect(reconciliation.reconciles).toBe(false);
    expect(reconciliation.driftCents).toBe(1);
  });

  it("notices when nothing is being withheld", async () => {
    const { summary } = await load("empty");
    expect(reconcileBalances(summary).balancesAgree).toBe(true);
  });
});

describe("the error state", () => {
  it("fails as a value on every method, with a stable code", async () => {
    const source = getAccountDataSource({ state: "error", authPending: false });
    const results: readonly Result<unknown, ErrorShape>[] = await Promise.all([
      source.getAccountSummary({ accountId: ACCOUNT_ID }),
      source.listHolds({ accountId: ACCOUNT_ID }),
      source.listPostings({ accountId: ACCOUNT_ID }),
    ]);

    for (const result of results) {
      expect(isOk(result)).toBe(false);
      if (isErr(result)) expect(result.error.code).toBe("LEDGER_QUERY_FAILED");
    }
  });
});

describe("demo state parsing", () => {
  it("falls back to the real screen on anything unrecognised", () => {
    expect(parseDemoView({}).state).toBe("default");
    expect(parseDemoView({ state: "nonsense" }).state).toBe("default");
    expect(parseDemoView({ state: ["edge", "empty"] }).state).toBe("edge");
    expect(parseDemoView({ state: "error" }).state).toBe("error");
  });

  it("reads the authorisation toggle", () => {
    expect(parseDemoView({ auth: "pending" }).authPending).toBe(true);
    expect(parseDemoView({ auth: "no" }).authPending).toBe(false);
    expect(parseDemoView({}).authPending).toBe(false);
  });

  it("round-trips through demoQuery", () => {
    expect(demoQuery({ state: "default" })).toBe("");
    expect(demoQuery({ state: "edge" })).toBe("?state=edge");
    expect(demoQuery({ state: "default", authPending: true })).toBe("?auth=pending");
    expect(parseDemoView({ state: "empty" })).toEqual({
      state: "empty",
      authPending: false,
    });
  });
});

describe("the account directory", () => {
  it("quotes figures that match the state each row opens in", async () => {
    for (const account of DEMO_ACCOUNTS) {
      if (account.state === "loading" || account.state === "error") continue;
      const { summary } = await load(account.state);
      expect(summary.ledgerCents, account.accountName).toBe(account.ledgerCents);
      expect(summary.availableCents, account.accountName).toBe(
        account.availableCents,
      );
      expect(summary.accountNumberLast4).toBe(account.last4);
    }
  });
});
