/**
 * Maker-checker, against the REAL Neon database.
 *
 * ============================================================================
 * WHY THESE TESTS ARE HERE AND NOT IN A UNIT TEST WITH A MOCK.
 *
 * Every control this feature is graded on lives in Postgres: a CHECK constraint
 * on `actor`, a trigger on `payment_instruction_event`, a unique index, and a
 * privilege model. A test that mocked the database would assert that the
 * application's copy of the rule works — and the whole design decision is that
 * the application has no copy. So these tests DO THE FORBIDDEN THING and assert
 * that the database refuses it, by SQLSTATE and by message.
 *
 * Gated on RUN_DB_TESTS=1 so CI, which holds no credentials on purpose, skips
 * rather than fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 * ============================================================================
 *
 * These tests write real rows to the demo bank, through the sanctioned write
 * path and no other. That is deliberate: the queue they leave behind is what
 * `/approvals` shows in its live default state, so the screen is populated by
 * the same code the tests exercise rather than by a fixture pretending to be
 * one.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type * as ApprovalsModule from "./index";
import type { sql as SqlHandle } from "@/lib/ledger/db";

const RUN = process.env.RUN_DB_TESTS === "1";
const d = RUN ? describe : describe.skip;

d("maker-checker, against the live database", () => {
  let sql: typeof SqlHandle;
  let A: typeof ApprovalsModule;

  /** Priya Raman — human, can_approve = false. The maker. */
  let maker: string;
  /** Dana Okonkwo — human, can_approve = true. */
  let checker: string;
  /** Miles Ferrara — the second, DISTINCT approver a wire needs. */
  let checker2: string;
  /** Corgi payments agent — kind = 'agent'. What the MCP write tool acts as. */
  let agent: string;
  let accountId: string;

  const run = Date.now();
  const key = (name: string) => `test:approvals:${run}:${name}`;
  const VALUE_DATE = "2026-09-11";

  const ACH_DESTINATION = {
    type: "ach",
    holderName: "Fairbanks Machining LLC",
    routingNumber: "021000021",
    accountNumberLast4: "4417",
    accountType: "checking",
  } as const;

  /** Raise one, through the same function the MCP write tool calls. */
  async function raise(args: {
    name: string;
    amountCents: bigint;
    actorId: string;
    destination?: typeof ACH_DESTINATION;
  }) {
    const result = await A.requestPayment({
      accountId,
      rail: "ach",
      amountCents: args.amountCents,
      destination: args.destination ?? ACH_DESTINATION,
      valueDate: VALUE_DATE,
      requestedByActorId: args.actorId,
      idempotencyKey: key(args.name),
    });
    if (!result.ok) throw new Error(`could not raise ${args.name}: ${result.error.message}`);
    return result.value;
  }

  beforeAll(async () => {
    // Imported dynamically so a missing APP_DATABASE_URL does not blow up at
    // module load when these tests are skipped.
    ({ sql } = await import("@/lib/ledger/db"));
    A = await import("./index");

    const humans = await sql<{ id: string; display_name: string; can_approve: boolean }[]>`
      SELECT id, display_name, can_approve FROM actor
       WHERE kind = 'human' AND business_id IS NULL ORDER BY display_name`;
    const [agentRow] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'agent' ORDER BY display_name LIMIT 1`;
    const [account] = await sql<{ id: string }[]>`
      SELECT id FROM account WHERE code = '2100' AND business_id IS NOT NULL LIMIT 1`;

    const approvers = humans.filter((h) => h.can_approve);
    const makers = humans.filter((h) => !h.can_approve);
    if (approvers.length < 2 || makers.length < 1 || !agentRow || !account) {
      throw new Error("seed first: node scripts/seed.mjs");
    }
    maker = makers[0]!.id;
    checker = approvers[0]!.id;
    checker2 = approvers[1]!.id;
    agent = agentRow.id;
    accountId = account.id;
  });

  /* ---------------------------------------------------------------------- */
  /* 1. The schema makes an approving agent unrepresentable                  */
  /* ---------------------------------------------------------------------- */

  it("cannot even STORE an agent that is allowed to approve", async () => {
    // The owner connection would be needed to insert an actor at all; corgi_app
    // holds only SELECT. So this asserts the constraint is present and armed,
    // by name, rather than by attempting an insert the app cannot express.
    const [check] = await sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conname = 'actor_only_humans_approve'`;
    expect(check?.definition).toMatch(/kind <> 'human'/);
    expect(check?.definition).toMatch(/can_approve/);

    const [rogue] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM actor WHERE kind <> 'human' AND can_approve`;
    expect(rogue?.n).toBe(0);

    // And the application genuinely cannot widen it: it holds no INSERT here.
    await expect(
      sql`INSERT INTO actor (kind, display_name, can_approve)
          VALUES ('agent', 'rogue', true)`,
    ).rejects.toThrow(/permission denied/);
  });

  /* ---------------------------------------------------------------------- */
  /* 2. THE SELF-APPROVAL REFUSAL — the control, exercised                   */
  /* ---------------------------------------------------------------------- */

  it("THE DATABASE refuses a self-approval, and the application only translates it", async () => {
    // Dana raises this one herself. She IS an approver — this is the hard case,
    // not the easy one, because nothing about her rights is wrong.
    const raised = await raise({ name: "self", amountCents: 420_000n, actorId: checker });

    // 1. Straight at the database, no application code in the way at all.
    const thrown = await sql`
      INSERT INTO payment_instruction_event
        (instruction_id, kind, actor_id, approved_content_hash, value_date)
      VALUES (${raised.instructionId}::uuid, 'approved', ${checker}::uuid,
              decode(${raised.contentHash}, 'hex'), ${VALUE_DATE}::date)
    `.catch((error: unknown) => error as { code: string; message: string });

    expect(thrown).toBeDefined();
    expect((thrown as { code: string }).code).toBe("42501");
    expect((thrown as { message: string }).message).toBe(
      `maker-checker: actor ${checker} initiated instruction ${raised.instructionId} and cannot approve it`,
    );

    // 2. And through the application, which sends the same INSERT and turns
    //    that exception into a refusal an operator can read.
    const refused = await A.approvePayment({
      instructionId: raised.instructionId,
      actorId: checker,
      contentHash: raised.contentHash,
      reason: "trying to approve my own payment",
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("SELF_APPROVAL");
      expect(refused.error.message).toMatch(/You raised this payment/);
      // The user-facing message must not carry the raw ids.
      expect(refused.error.message).not.toContain(raised.instructionId);
    }

    // 3. Nothing was written. The refusal is not a soft one.
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction_event
       WHERE instruction_id = ${raised.instructionId}::uuid AND kind = 'approved'`;
    expect(count?.n).toBe(0);

    // 4. Somebody else can. Same payment, same hash, different human.
    const allowed = await A.approvePayment({
      instructionId: raised.instructionId,
      actorId: checker2,
      contentHash: raised.contentHash,
      reason: "checked against invoice 22-8814",
    });
    expect(allowed.ok).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* 3. An agent's instruction lands in the queue and cannot self-approve     */
  /* ---------------------------------------------------------------------- */

  it("takes an agent's instruction into the same queue and refuses its approval", async () => {
    const raised = await raise({ name: "agent", amountCents: 380_000n, actorId: agent });

    const queue = await A.listQueue({ pendingOnly: true, limit: 200 });
    expect(queue.ok).toBe(true);
    if (queue.ok) {
      const mine = queue.value.find((item) => item.instruction.id === raised.instructionId);
      expect(mine).toBeDefined();
      expect(mine?.instruction.requestedByKind).toBe("agent");
      expect(mine?.state).toBe("requested");
      // Same policy version as a human's payment on the same rail and date.
      expect(mine?.instruction.policy.version).toBe(raised.policy.version);
    }

    const refused = await A.approvePayment({
      instructionId: raised.instructionId,
      actorId: agent,
      contentHash: raised.contentHash,
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe("NOT_AN_APPROVER");

    // The database's own words, for the record.
    const thrown = await sql`
      INSERT INTO payment_instruction_event
        (instruction_id, kind, actor_id, approved_content_hash, value_date)
      VALUES (${raised.instructionId}::uuid, 'approved', ${agent}::uuid,
              decode(${raised.contentHash}, 'hex'), ${VALUE_DATE}::date)
    `.catch((error: unknown) => error as { code: string; message: string });
    expect((thrown as { message: string }).message).toBe(
      `actor ${agent} (kind agent) is not an approver`,
    );
  });

  /* ---------------------------------------------------------------------- */
  /* 4. Approve-the-hash: a stale approval does not apply                    */
  /* ---------------------------------------------------------------------- */

  it("refuses an approval that cites another payment's content hash", async () => {
    // Two payments, identical but for the amount. $100 and $10,000 — the case
    // DESIGN §16 names: "you cannot approve $100 and submit $10,000".
    const small = await raise({ name: "hash-small", amountCents: 10_000n, actorId: maker });
    const large = await raise({ name: "hash-large", amountCents: 1_000_000n, actorId: maker });

    // Different payments, therefore different hashes. There is no way to make
    // them the same short of making them the same payment.
    expect(small.contentHash).not.toBe(large.contentHash);

    // The stale approval: approve the $10,000 row while citing the $100 hash.
    // Nothing was mutated to get here — `payment_instruction` is append-only
    // and carries a no-UPDATE trigger — so "the payment changed" is expressed
    // the only way it can be: as a second row.
    const stale = await A.approvePayment({
      instructionId: large.instructionId,
      actorId: checker,
      contentHash: small.contentHash,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("STALE_APPROVAL");

    const thrown = await sql`
      INSERT INTO payment_instruction_event
        (instruction_id, kind, actor_id, approved_content_hash, value_date)
      VALUES (${large.instructionId}::uuid, 'approved', ${checker}::uuid,
              decode(${small.contentHash}, 'hex'), ${VALUE_DATE}::date)
    `.catch((error: unknown) => error as { code: string; message: string });
    expect((thrown as { code: string }).code).toBe("42501");
    expect((thrown as { message: string }).message).toBe(
      `approval for ${large.instructionId} cites the wrong content hash`,
    );

    // An approval with no hash at all is refused the same way: `IS DISTINCT
    // FROM` means NULL never matches.
    const missing = await sql`
      INSERT INTO payment_instruction_event (instruction_id, kind, actor_id, value_date)
      VALUES (${large.instructionId}::uuid, 'approved', ${checker}::uuid, ${VALUE_DATE}::date)
    `.catch((error: unknown) => error as { message: string });
    expect((missing as { message: string }).message).toMatch(/wrong content hash/);

    // Citing the right hash works, and only for the payment it belongs to.
    expect(
      (
        await A.approvePayment({
          instructionId: large.instructionId,
          actorId: checker,
          contentHash: large.contentHash,
        })
      ).ok,
    ).toBe(true);

    // …and the stale approval never became a fact: the $10,000 payment holds
    // exactly one approval, the one that cites its own hash.
    const loaded = await A.getPayment(large.instructionId);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value.approvalsHeld).toBe(1);
      expect(
        loaded.value.events.filter((e) => e.approvedContentHash === small.contentHash),
      ).toHaveLength(0);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 5. One actor, one decision                                             */
  /* ---------------------------------------------------------------------- */

  it("will not let one approver approve twice to satisfy a two-approver rule", async () => {
    const raised = await raise({ name: "twice", amountCents: 500_000n, actorId: maker });

    const first = await A.approvePayment({
      instructionId: raised.instructionId,
      actorId: checker,
      contentHash: raised.contentHash,
    });
    expect(first.ok).toBe(true);

    const second = await A.approvePayment({
      instructionId: raised.instructionId,
      actorId: checker,
      contentHash: raised.contentHash,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("DUPLICATE_DECISION");

    const loaded = await A.getPayment(raised.instructionId);
    if (loaded.ok) expect(loaded.value.approvalsHeld).toBe(1);
  });

  /* ---------------------------------------------------------------------- */
  /* 6. The state machine, and the threshold that gates the release          */
  /* ---------------------------------------------------------------------- */

  it("refuses a release above the threshold until the approvals exist", async () => {
    const raised = await raise({ name: "gate", amountCents: 600_000n, actorId: maker });
    expect(raised.approvalsRequired).toBe(1);

    const early = await A.releasePayment({
      instructionId: raised.instructionId,
      actorId: checker,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.error.code).toBe("INSUFFICIENT_APPROVALS");

    // And no money moved on the failed attempt: the posting and the event are
    // one transaction, so the refusal rolled the journal entry back with it.
    const [posted] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM journal_entry
       WHERE idempotency_key = ${A.releaseIdempotencyKey(raised.instructionId)}`;
    expect(posted?.n).toBe(0);

    await A.approvePayment({
      instructionId: raised.instructionId,
      actorId: checker,
      contentHash: raised.contentHash,
    });

    const released = await A.releasePayment({
      instructionId: raised.instructionId,
      actorId: checker,
    });
    expect(released.ok).toBe(true);
    if (!released.ok) return;

    const loaded = await A.getPayment(raised.instructionId);
    if (loaded.ok) expect(loaded.value.state).toBe("released");

    // The money it moved: a debit to the customer's deposit liability and a
    // credit to ACH payable, summing to zero.
    const lines = await sql<{ amount_cents: bigint }[]>`
      SELECT amount_cents FROM journal_line WHERE entry_id = ${released.value.entryId}::uuid`;
    expect(lines).toHaveLength(2);
    expect(lines.reduce((sum, l) => sum + l.amount_cents, 0n)).toBe(0n);
  });

  it("releases a below-threshold payment with no approval — one mechanism, not two", async () => {
    const raised = await raise({ name: "small", amountCents: 12_500n, actorId: maker });
    expect(raised.approvalsRequired).toBe(0);

    const released = await A.releasePayment({
      instructionId: raised.instructionId,
      actorId: maker,
    });
    expect(released.ok).toBe(true);
  });

  it("makes a double release a no-op decided by Postgres", async () => {
    const raised = await raise({ name: "double", amountCents: 7_700n, actorId: maker });

    const first = await A.releasePayment({ instructionId: raised.instructionId, actorId: maker });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM journal_entry`;

    const second = await A.releasePayment({ instructionId: raised.instructionId, actorId: maker });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("ALREADY_RELEASED");

    // The entry count did not move. `ledger_append()` looked up the key
    // `payment:release:<id>`, found the original, and wrote nothing — and the
    // refused event rolled the whole transaction back regardless.
    const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM journal_entry`;
    expect(after?.n).toBe(before?.n);

    const [events] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction_event
       WHERE instruction_id = ${raised.instructionId}::uuid AND kind = 'released'`;
    expect(events?.n).toBe(1);
  });

  it("refuses a release after a rejection, for ever", async () => {
    const raised = await raise({ name: "rejected", amountCents: 900_000n, actorId: maker });

    const rejected = await A.rejectPayment({
      instructionId: raised.instructionId,
      actorId: checker,
      contentHash: raised.contentHash,
      reason: "beneficiary not on the approved supplier list",
    });
    expect(rejected.ok).toBe(true);

    const released = await A.releasePayment({
      instructionId: raised.instructionId,
      actorId: checker,
    });
    expect(released.ok).toBe(false);
    if (!released.ok) expect(released.error.code).toBe("ALREADY_DECIDED");

    const loaded = await A.getPayment(raised.instructionId);
    if (loaded.ok) {
      expect(loaded.value.state).toBe("rejected");
      // A rejected payment leaves the queue and never comes back.
      const queue = await A.listQueue({ pendingOnly: true, limit: 200 });
      if (queue.ok) {
        expect(queue.value.map((i) => i.instruction.id)).not.toContain(raised.instructionId);
      }
    }
  });

  it("refuses an outcome that precedes the release that would have caused it", async () => {
    const raised = await raise({ name: "outoforder", amountCents: 4_100n, actorId: maker });
    const thrown = await sql`
      INSERT INTO payment_instruction_event (instruction_id, kind, actor_id, value_date)
      VALUES (${raised.instructionId}::uuid, 'settled', ${maker}::uuid, ${VALUE_DATE}::date)
    `.catch((error: unknown) => error as { code: string; message: string });
    expect((thrown as { code: string }).code).toBe("55006");
    expect((thrown as { message: string }).message).toMatch(/has not been released/);
  });

  /* ---------------------------------------------------------------------- */
  /* 7. Versioned policy, and idempotency                                   */
  /* ---------------------------------------------------------------------- */

  it("stores the policy VERSION the payment was judged under", async () => {
    const raised = await raise({ name: "policy", amountCents: 300_000n, actorId: maker });
    const [row] = await sql<{ version: string; threshold_cents: bigint }[]>`
      SELECT ap.rail || '@' || ap.effective_from::text AS version, ap.threshold_cents
        FROM payment_instruction pi JOIN approval_policy ap ON ap.id = pi.policy_id
       WHERE pi.id = ${raised.instructionId}::uuid`;
    expect(row?.version).toBe(raised.policy.version);
    expect(row?.threshold_cents).toBe(raised.policy.thresholdCents);

    // The policy row itself cannot be edited, which is what makes the citation
    // meaningful: a threshold change is a new row with a later effective_from.
    await expect(
      sql`UPDATE approval_policy SET threshold_cents = 1 WHERE id = ${raised.policy.id}::uuid`,
    ).rejects.toThrow(/permission denied/);
  });

  it("replays a repeated request instead of raising the payment twice", async () => {
    const first = await A.requestPayment({
      accountId,
      rail: "ach",
      amountCents: 22_200n,
      destination: ACH_DESTINATION,
      valueDate: VALUE_DATE,
      requestedByActorId: agent,
      idempotencyKey: key("replay"),
    });
    const second = await A.requestPayment({
      accountId,
      rail: "ach",
      amountCents: 22_200n,
      destination: ACH_DESTINATION,
      valueDate: VALUE_DATE,
      requestedByActorId: agent,
      idempotencyKey: key("replay"),
    });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value.instructionId).toBe(first.value.instructionId);
      expect(second.value.created).toBe(false);
    }

    const [events] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction_event e
        JOIN payment_instruction pi ON pi.id = e.instruction_id
       WHERE pi.idempotency_key = ${key("replay")} AND e.kind = 'requested'`;
    expect(events?.n).toBe(1);
  });

  /* ---------------------------------------------------------------------- */
  /* 8. The lifecycle is append-only, at the privilege layer                 */
  /* ---------------------------------------------------------------------- */

  it("refuses UPDATE and DELETE on the lifecycle even when asked nicely", async () => {
    await expect(
      sql`UPDATE payment_instruction_event SET reason = 'tampered' WHERE true`,
    ).rejects.toThrow(/permission denied/);
    await expect(sql`DELETE FROM payment_instruction WHERE true`).rejects.toThrow(
      /permission denied/,
    );
  });
});
