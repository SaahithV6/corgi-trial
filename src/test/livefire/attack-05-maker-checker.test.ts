/**
 * ATTACK 5 — "Have the payment initiator try to approve their own
 * above-threshold payment. Assert the DATABASE refuses it (SQLSTATE 42501 from
 * assert_maker_checker), not application code."
 *
 * The refusal is exercised TWICE, in this order, and the order is the point:
 *
 *   1. straight at the live database with a raw INSERT, no application code in
 *      the call stack at all. This is the assertion the attack actually makes:
 *      the control is in Postgres. SQLSTATE 42501 from assert_maker_checker().
 *   2. then through `approvePayment()`, to show the application does not carry
 *      a second copy of the rule — it translates the exception into a sentence.
 *
 * The initiator chosen is a human who IS an approver (can_approve = true). That
 * is deliberately the hard case: nothing about their rights is wrong, so a 42501
 * can only be the maker-checker rule and not a permissions accident.
 *
 * ISOLATION. Every run raises its own instruction under its own idempotency key
 * and asserts by that instruction id. Nothing is counted across the table.
 */
import { appendFileSync } from "node:fs";

import { beforeAll, describe, expect, it } from "vitest";

import type * as ApprovalsModule from "@/lib/approvals";
import type { sql as SqlHandle } from "@/lib/ledger/db";

const ATTACK = 5;
const NAME = "Self-approval refused by the database, not by application code";

/** Append one evidence line for scripts/livefire.mjs. Silent when unset. */
function record(kind: "evidence" | "skip", text: string): void {
  const path = process.env["LIVEFIRE_EVIDENCE"];
  if (path === undefined || path === "") return;
  appendFileSync(path, `${JSON.stringify({ attack: ATTACK, name: NAME, kind, text })}\n`, "utf8");
}

const READY =
  process.env["LIVEFIRE"] === "1" && typeof process.env["APP_DATABASE_URL"] === "string";

if (!READY) {
  record("skip", "LIVEFIRE=1 and APP_DATABASE_URL are required; run scripts/livefire.mjs");
}

const d = READY ? describe : describe.skip;

d(`ATTACK ${ATTACK} — ${NAME}`, () => {
  let sql: typeof SqlHandle;
  let A: typeof ApprovalsModule;

  /** A human who can approve, and who will raise this payment themselves. */
  let initiator = "";
  /** A different human who can approve. */
  let otherApprover = "";
  let accountId = "";

  const tag = Date.now().toString(36).toUpperCase();
  const VALUE_DATE = "2026-09-11";
  /** $4,200.00 — comfortably over the ACH policy threshold of $2,500.00. */
  const AMOUNT_CENTS = 420_000n;

  let instructionId = "";
  let contentHash = "";
  let thresholdCents = 0n;

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    A = await import("@/lib/approvals");

    const approvers = await sql<{ id: string; display_name: string }[]>`
      SELECT id, display_name FROM actor
       WHERE kind = 'human' AND can_approve = true AND business_id IS NULL
       ORDER BY display_name`;
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2100' AND business_id IS NOT NULL LIMIT 1`;
    const [policy] = await sql<{ threshold_cents: bigint }[]>`
      SELECT threshold_cents FROM approval_policy
       WHERE rail = 'ach' AND effective_from <= ${VALUE_DATE}::date
       ORDER BY effective_from DESC LIMIT 1`;

    const first = approvers[0];
    const second = approvers[1];
    if (!first || !second || !account || !policy) {
      throw new Error("the live database is not seeded: run node scripts/seed.mjs");
    }
    initiator = first.id;
    otherApprover = second.id;
    accountId = account.id;
    thresholdCents = policy.threshold_cents;
  });

  it("raises an above-threshold payment as the initiator", async () => {
    expect(AMOUNT_CENTS).toBeGreaterThan(thresholdCents);

    const raised = await A.requestPayment({
      accountId,
      rail: "ach",
      amountCents: AMOUNT_CENTS,
      destination: {
        type: "ach",
        holderName: "Fairbanks Machining LLC",
        routingNumber: "021000021",
        accountNumberLast4: "4417",
        accountType: "checking",
      },
      valueDate: VALUE_DATE,
      requestedByActorId: initiator,
      idempotencyKey: `livefire:${tag}:self-approval`,
    });
    if (!raised.ok) throw new Error(`could not raise the payment: ${raised.error.message}`);

    instructionId = raised.value.instructionId;
    contentHash = raised.value.contentHash;
    expect(raised.value.approvalsRequired).toBeGreaterThan(0);
    record(
      "evidence",
      `instruction ${instructionId} raised for ${AMOUNT_CENTS} cents (policy threshold ${thresholdCents}), approvals required ${raised.value.approvalsRequired}`,
    );
  });

  it("THE DATABASE refuses the self-approval with SQLSTATE 42501", async () => {
    // No application code in this call stack. Just the INSERT the application
    // would have sent, sent by the test instead.
    const thrown = (await sql`
      INSERT INTO payment_instruction_event
        (instruction_id, kind, actor_id, approved_content_hash, value_date)
      VALUES (${instructionId}::uuid, 'approved', ${initiator}::uuid,
              decode(${contentHash}, 'hex'), ${VALUE_DATE}::date)
    `.then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    )) as { code?: string; message?: string } | null;

    // A null here means the INSERT SUCCEEDED — the control is not armed.
    expect(thrown).not.toBeNull();
    expect(thrown?.code).toBe("42501");
    expect(thrown?.message).toContain("maker-checker");
    expect(thrown?.message).toContain(initiator);
    expect(thrown?.message).toContain(instructionId);

    record(
      "evidence",
      `raw INSERT of an 'approved' event by the initiator -> SQLSTATE ${thrown?.code} from assert_maker_checker(): "${thrown?.message}"`,
    );
  });

  it("nothing was written, and the application only translates the refusal", async () => {
    const [approved] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction_event
       WHERE instruction_id = ${instructionId}::uuid AND kind = 'approved'`;
    expect(approved?.n).toBe(0);

    const refused = await A.approvePayment({
      instructionId,
      actorId: initiator,
      contentHash,
      reason: "live-fire: trying to approve my own payment",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("SELF_APPROVAL");
      // The operator-facing message must not leak raw ids.
      expect(refused.error.message).not.toContain(instructionId);
    }

    const [stillNone] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction_event
       WHERE instruction_id = ${instructionId}::uuid AND kind = 'approved'`;
    expect(stillNone?.n).toBe(0);

    record(
      "evidence",
      `approved events for ${instructionId}: 0 after both attempts; application refusal code SELF_APPROVAL`,
    );
  });

  it("a different human can approve the same payment, so the refusal is specific", async () => {
    // Without this the previous assertions are also satisfied by a system that
    // refuses every approval.
    const allowed = await A.approvePayment({
      instructionId,
      actorId: otherApprover,
      contentHash,
      reason: "live-fire: second human approves",
    });
    expect(allowed.ok).toBe(true);

    const [approved] = await sql<{ n: number; actor: string }[]>`
      SELECT count(*)::int AS n, MIN(actor_id::text) AS actor
        FROM payment_instruction_event
       WHERE instruction_id = ${instructionId}::uuid AND kind = 'approved'`;
    expect(approved?.n).toBe(1);
    expect(approved?.actor).toBe(otherApprover);

    record(
      "evidence",
      `a second human approved the same instruction: 1 approved event, actor ${otherApprover} (not the initiator)`,
    );
  });
});
