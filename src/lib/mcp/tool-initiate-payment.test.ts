import { describe, expect, it } from "vitest";

import { contentHash, contentPreimage } from "./approvals-port";
import { initiatePaymentTool } from "./tool-initiate-payment";
import {
  AGENT_ACTOR,
  BUSINESS_A,
  defaultState,
  fakeGateway,
  snapshotOf,
  testContext,
} from "./testing";
import { ToolError, type ToolContext } from "./types";

const ACH = {
  rail: "ach",
  amount_cents: "125000",
  destination: {
    type: "ach",
    holder_name: "Northwind Components LLC",
    routing_number: "021000021",
    account_number_last4: "6789",
    account_type: "checking",
  },
  reason: "Invoice INV-4471 for the September machining run",
  idempotency_key: "invoice-INV-4471",
} as const;

function ctxWith(overrides: Partial<ToolContext> = {}) {
  const { gateway, state } = fakeGateway();
  return { ctx: testContext({ gateway, ...overrides }), state };
}

async function call(args: Record<string, unknown>, ctx: ToolContext) {
  return initiatePaymentTool.run(initiatePaymentTool.parse(args) as never, ctx);
}

describe("initiate_payment: it queues, it does not pay", () => {
  it("returns a queued status and says no money moved, in the data and in the prose", async () => {
    const { ctx } = ctxWith();
    const outcome = await call({ ...ACH }, ctx);
    const data = outcome.data as Record<string, unknown>;

    expect(data["status"]).toBe("queued_for_human_approval");
    expect(data["money_moved"]).toBe(false);
    // The summary is what a model repeats to a person. It must be impossible
    // to paraphrase as "your payment has been sent".
    expect(outcome.summary.startsWith("NO MONEY HAS MOVED.")).toBe(true);
    expect(outcome.summary).toContain("approval queue");
    expect(outcome.summary).toContain("cannot approve it");
  });

  it("attributes the instruction to an agent that cannot approve", async () => {
    const { ctx, state } = ctxWith();
    const outcome = await call({ ...ACH }, ctx);
    const requestedBy = (outcome.data as Record<string, Record<string, unknown>>)["requested_by"];

    expect(requestedBy?.["actor_id"]).toBe(AGENT_ACTOR);
    expect(requestedBy?.["kind"]).toBe("agent");
    expect(requestedBy?.["can_approve"]).toBe(false);
    expect(state.queued[0]?.requestedByActorId).toBe(AGENT_ACTOR);
  });

  it("names the constraints that make self-approval unrepresentable", async () => {
    const { ctx } = ctxWith();
    const outcome = await call({ ...ACH }, ctx);
    const approval = (outcome.data as Record<string, Record<string, unknown>>)["approval"];

    expect(approval?.["self_approval_possible"]).toBe(false);
    const enforced = approval?.["enforced_by"] as string[];
    expect(enforced.join(" ")).toContain("actor_only_humans_approve");
    expect(enforced.join(" ")).toContain("assert_maker_checker");
    expect(enforced.join(" ")).toContain("pie_one_decision_per_actor");
  });

  it("applies the rail's policy and reports the approvals needed", async () => {
    const { ctx } = ctxWith();

    // $1,250 is below the $2,500 ACH threshold: no second human by policy,
    // but still unreleased, because releasing is not on this surface at all.
    const below = await call({ ...ACH }, ctx);
    const belowApproval = (below.data as Record<string, Record<string, unknown>>)["approval"];
    expect(belowApproval?.["above_threshold"]).toBe(false);
    expect(belowApproval?.["required_human_approvals"]).toBe(0);
    expect(String((below.data as Record<string, unknown>)["what_happens_next"])).toContain(
      "no operation that approves, submits or releases a payment",
    );

    const above = await call(
      { ...ACH, amount_cents: "300000", idempotency_key: "invoice-INV-4472" },
      ctx,
    );
    const aboveApproval = (above.data as Record<string, Record<string, unknown>>)["approval"];
    expect(aboveApproval?.["above_threshold"]).toBe(true);
    expect(aboveApproval?.["required_human_approvals"]).toBe(1);
  });

  it("requires two approvers on a wire at any amount", async () => {
    const state = defaultState();
    state.balances.set(`${BUSINESS_A}:a0c41a37-2be1-5c30-bfe9-03455f048fac`, snapshotOf(10_000_00n));
    const { gateway } = fakeGateway(state);
    const outcome = await call(
      {
        ...ACH,
        rail: "wire",
        amount_cents: "100",
        destination: {
          type: "wire",
          holder_name: "Northwind Components LLC",
          bic: "CHASUS33",
          account_number_last4: "6789",
        },
        idempotency_key: "wire-tiny-1",
      },
      testContext({ gateway }),
    );
    const approval = (outcome.data as Record<string, Record<string, unknown>>)["approval"];
    expect(approval?.["required_human_approvals"]).toBe(2);
    expect(outcome.summary).toContain("2 human approval(s)");
  });
});

describe("initiate_payment: idempotency", () => {
  it("replays to the same instruction and writes nothing new", async () => {
    const { ctx, state } = ctxWith();
    const first = await call({ ...ACH }, ctx);
    const second = await call({ ...ACH }, ctx);

    expect((second.data as Record<string, unknown>)["instruction_id"]).toBe(
      (first.data as Record<string, unknown>)["instruction_id"],
    );
    expect((second.data as Record<string, unknown>)["replayed"]).toBe(true);
    expect(state.queued).toHaveLength(1);
    expect(second.summary).toContain("already queued");
  });

  it("namespaces the key by tenant and agent so keys cannot collide across tokens", async () => {
    const { ctx, state } = ctxWith();
    await call({ ...ACH }, ctx);
    expect(state.queued[0]?.idempotencyKey).toBe(
      `mcp:${BUSINESS_A}:${AGENT_ACTOR}:invoice-INV-4471`,
    );
  });
});

describe("initiate_payment: refusals", () => {
  it("refuses more than the available balance, and says nothing was queued", async () => {
    const { ctx, state } = ctxWith();
    // Available is $9,587.40 in the default fixture.
    await expect(call({ ...ACH, amount_cents: "1000000" }, ctx)).rejects.toThrow(
      /exceeds the available balance/,
    );
    expect(state.queued).toHaveLength(0);
  });

  it("refuses above the per-token ceiling", async () => {
    const { gateway } = fakeGateway();
    const ctx = testContext({
      gateway,
      grant: { ...testContext().grant, maxInstructionCents: 50_000n },
    });
    await expect(call({ ...ACH }, ctx)).rejects.toThrow(/may queue at most \$500\.00 per instruction/);
  });

  it("refuses a backdated value date", async () => {
    const { ctx } = ctxWith();
    await expect(call({ ...ACH, value_date: "2026-09-01" }, ctx)).rejects.toThrow(
      /cannot be backdated/,
    );
  });

  it("refuses a value date more than 90 days out", async () => {
    const { ctx } = ctxWith();
    await expect(call({ ...ACH, value_date: "2027-06-01" }, ctx)).rejects.toThrow(
      /no standing orders/,
    );
  });

  it("refuses when no approval policy is in force for the rail", async () => {
    // Not "assume zero approvers". An undefined approval requirement is a
    // refusal, because the safe default is not a permissive one.
    const state = defaultState();
    state.policies = [];
    const { gateway } = fakeGateway(state);
    await expect(call({ ...ACH }, testContext({ gateway }))).rejects.toThrow(
      /No approval policy is in force/,
    );
  });

  it("refuses an account this business does not own", async () => {
    const { ctx } = ctxWith();
    await expect(call({ ...ACH, account_code: "1110" }, ctx)).rejects.toThrow(ToolError);
  });

  it("refuses a memo-book or non-postable account", async () => {
    const state = defaultState();
    state.accounts.set(`${BUSINESS_A}:9100`, {
      accountId: "9100-acc",
      code: "9100",
      name: "Card authorisation holds",
      currency: "USD",
      book: "memo",
      isPostable: true,
    });
    const { gateway } = fakeGateway(state);
    await expect(
      call({ ...ACH, account_code: "9100" }, testContext({ gateway })),
    ).rejects.toThrow(/cannot fund a payment/);
  });
});

describe("content hash", () => {
  it("is the approvals module's own hash over the five fields an approval cites", async () => {
    const { ctx } = ctxWith();
    const outcome = await call({ ...ACH }, ctx);

    const expected = contentHash({
      accountId: "a0c41a37-2be1-5c30-bfe9-03455f048fac",
      rail: "ach",
      amountCents: 125_000n,
      currency: "USD",
      destination: {
        type: "ach",
        holderName: "Northwind Components LLC",
        routingNumber: "021000021",
        accountNumberLast4: "6789",
        accountType: "checking",
      },
      valueDate: "2026-09-10",
    });

    expect((outcome.data as Record<string, unknown>)["content_hash"]).toBe(expected);
  });

  it("changes when any bound field changes, so an approval cannot be reused", () => {
    const base = {
      accountId: "acc",
      rail: "ach" as const,
      amountCents: 100n,
      currency: "USD",
      destination: {
        type: "ach" as const,
        holderName: "A",
        routingNumber: "021000021",
        accountNumberLast4: "1111",
        accountType: "checking" as const,
      },
      valueDate: "2026-09-10",
    };

    expect(contentHash(base)).not.toBe(contentHash({ ...base, amountCents: 101n }));
    expect(contentHash(base)).not.toBe(contentHash({ ...base, valueDate: "2026-09-11" }));
    expect(contentHash(base)).not.toBe(
      contentHash({
        ...base,
        destination: { ...base.destination, accountNumberLast4: "2222" },
      }),
    );
  });

  it("hashes a preimage a human could reconstruct by hand", () => {
    // Not a tautology test: assert the bytes, not just that the function is
    // deterministic. A hash test that only checks "same in, same out" passes
    // on a function that hashes nothing.
    const preimage = contentPreimage({
      accountId: "acc",
      rail: "ach",
      amountCents: 125_000n,
      currency: "USD",
      destination: {
        type: "ach",
        holderName: "A",
        routingNumber: "021000021",
        accountNumberLast4: "1111",
        accountType: "checking",
      },
      valueDate: "2026-09-10",
    });
    expect(preimage).toContain("amount=125000");
    expect(preimage).toContain("value_date=2026-09-10");
    expect(preimage).toContain("rail=ach");
  });
});
