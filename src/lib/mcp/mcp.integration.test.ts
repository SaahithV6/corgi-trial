/**
 * The MCP surface against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI, which holds no credentials on purpose, skips
 * rather than fails. Run locally with:
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 *
 * What is being proved here is not that the code compiles — `server.test.ts`
 * covers the protocol against an in-memory gateway. It is:
 *
 *   1. that the SQL in `gateway.ts` runs, against this schema, with these
 *      column names;
 *   2. that the tenant predicate holds against real rows;
 *   3. and the one that matters most: that a payment queued by the agent
 *      CANNOT BE APPROVED BY THAT AGENT, because the database refuses. The
 *      test attempts the approval for real and asserts SQLSTATE 42501. A
 *      claim of maker-checker that has never been attempted is a claim.
 *
 * These tests write real rows. `payment_instruction` is append-only and
 * `corgi_app` holds no DELETE on it, so the rows stay — which is correct: they
 * are the evidence. Idempotency keys carry a run stamp so a re-run raises new
 * instructions instead of colliding.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { MemoryAuditSink } from "./audit";
import { parseTokenConfig } from "./auth";
import { createMcpServer, type McpServer } from "./server";
// Type-only, so this does NOT pull the Postgres handle in at module load; the
// value is imported dynamically inside beforeAll.
import type { sql as SqlHandle } from "@/lib/ledger/db";
import type { Gateway } from "./types";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

const TOKEN_A = "corgi_mcp_integration_ridgeline_0001";
const TOKEN_B = "corgi_mcp_integration_kettle_000002";
/**
 * A third grant, scoped to whichever business actually has dispute cases and
 * accrual postings.
 *
 * `businessA` is "the first KYB-approved business with a 2100 leaf, by legal
 * name", which is the right fixture for balances and payments and is not
 * necessarily the one carrying disputes. Asserting the shape of an empty list
 * proves nothing, and loosening the assertion to `>= 0` would be a test that
 * passes whether or not the query works. So the data is found first and the
 * token is pointed at it.
 */
const TOKEN_C = "corgi_mcp_integration_disputes_003";
const URL = "http://localhost:3000/api/mcp";

d("the MCP surface, against the live database", () => {
  let sql: typeof SqlHandle;
  let gateway: Gateway;
  let server: McpServer;
  let audit: MemoryAuditSink;

  let businessA: string;
  let businessB: string;
  let agentActorId: string;
  let humanApproverId: string;
  let businessWithDisputes: string | null;
  let businessWithAccrual: string | null;
  let run: number;

  async function post(body: unknown, token: string | null = TOKEN_A): Promise<Response> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    return server.handlePost(
      new Request(URL, { method: "POST", headers, body: JSON.stringify(body) }),
    );
  }

  let nextId = 0;
  async function call(
    tool: string,
    args: Record<string, unknown>,
    token: string = TOKEN_A,
  ): Promise<Record<string, unknown>> {
    nextId += 1;
    const response = await post(
      { jsonrpc: "2.0", id: nextId, method: "tools/call", params: { name: tool, arguments: args } },
      token,
    );
    return (await response.json()) as Record<string, unknown>;
  }

  function structured(body: Record<string, unknown>): Record<string, unknown> {
    const result = body["result"] as Record<string, unknown> | undefined;
    if (result === undefined) {
      throw new Error(`expected a result, got ${JSON.stringify(body["error"])}`);
    }
    return result["structuredContent"] as Record<string, unknown>;
  }

  beforeAll(async () => {
    // Imported dynamically so a missing APP_DATABASE_URL does not blow up at
    // module load when these tests are skipped.
    ({ sql } = await import("@/lib/ledger/db"));
    const { liveGateway } = await import("./gateway");

    // A is a business with a real deposit leaf; B is any OTHER business. B is
    // deliberately allowed to be one with no accounts yet — that is the
    // sharper scoping test, because a token scoped to B must then find that
    // A's account does not exist rather than finding it and being refused.
    // A DEPOSIT LEAF IS NOT ENOUGH — the business must also be able to
    // transact. `requestPayment()` runs the KYB gate before it writes an
    // instruction, so a business whose verification is still pending refuses
    // the write path with KYB_PENDING and every assertion below it fails for a
    // reason that has nothing to do with the agent surface. Two integration
    // fixtures added since this file was written (holds, pots) sort ahead of
    // the seeded customer alphabetically and are both `pending`, which is what
    // made "the first business with a 2100 leaf" the wrong query.
    const [withAccounts] = await sql<{ id: string }[]>`
      SELECT b.id
        FROM business b
        JOIN account a       ON a.business_id = b.id AND a.code = '2100'
        JOIN v_business_kyb k ON k.business_id = b.id
       WHERE k.kyb_status = 'approved'
       ORDER BY b.legal_name
       LIMIT 1`;
    if (withAccounts === undefined) {
      throw new Error(
        "seed first: node scripts/seed.mjs (need a KYB-approved business with a 2100 leaf)",
      );
    }
    businessA = withAccounts.id;

    const [other] = await sql<{ id: string }[]>`
      SELECT id FROM business WHERE id <> ${businessA}::uuid ORDER BY legal_name LIMIT 1`;
    if (other === undefined) throw new Error("seed first: need a second business");
    businessB = other.id;

    const [agent] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'agent' ORDER BY display_name LIMIT 1`;
    const [human] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'human' AND can_approve = true ORDER BY display_name LIMIT 1`;
    if (agent === undefined || human === undefined) throw new Error("seed first");
    agentActorId = agent.id;
    humanApproverId = human.id;

    const [disputed] = await sql<{ business_id: string }[]>`
      SELECT business_id FROM v_dispute_state GROUP BY business_id ORDER BY count(*) DESC LIMIT 1`;
    businessWithDisputes = disputed?.business_id ?? null;

    // Asked of `v_accrual_month`, which carries its own `business_id`, rather
    // than by joining `account` — `ledger/boundary.test.ts` is a ratchet on
    // direct references to the ledger's tables from outside `src/lib/ledger/`,
    // and integration tests are deliberately held to it too: a test that
    // reaches into `account` to find a business is a test with its own opinion
    // about what a business's accounts are.
    const [accrued] = await sql<{ business_id: string }[]>`
      SELECT m.business_id
        FROM v_accrual_month m
       WHERE m.business_id IS NOT NULL AND m.days_posted > 0
       GROUP BY m.business_id
       ORDER BY sum(m.days_posted) DESC
       LIMIT 1`;
    businessWithAccrual = accrued?.business_id ?? null;

    gateway = liveGateway();
    audit = new MemoryAuditSink();
    server = createMcpServer({
      gateway,
      config: parseTokenConfig(
        JSON.stringify([
          { label: "it-a", token: TOKEN_A, actorId: agentActorId, businessId: businessA },
          { label: "it-b", token: TOKEN_B, actorId: agentActorId, businessId: businessB },
          {
            label: "it-c",
            token: TOKEN_C,
            actorId: agentActorId,
            businessId: businessWithDisputes ?? businessA,
          },
        ]),
      ),
      audit,
    });

    run = Date.now();
  });

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  it("resolves the seeded agent actor and refuses to speak as a human", async () => {
    const actor = await gateway.resolveActor(agentActorId, businessA);
    expect(actor?.kind).toBe("agent");
    expect(actor?.canApprove).toBe(false);

    const impostor = createMcpServer({
      gateway,
      config: parseTokenConfig(
        JSON.stringify([
          { label: "impostor", token: TOKEN_A, actorId: humanApproverId, businessId: businessA },
        ]),
      ),
      audit: new MemoryAuditSink(),
    });
    const response = await impostor.handlePost(
      new Request(URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN_A}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it("runs get_balance against the real ledger", async () => {
    const body = await call("get_balance", {});
    const data = structured(body);

    expect((data["business"] as Record<string, unknown>)["id"]).toBe(businessA);
    expect((data["account"] as Record<string, unknown>)["code"]).toBe("2100");

    const ledger = BigInt(String((data["ledger_balance"] as Record<string, unknown>)["cents"]));
    const available = BigInt(String((data["available_balance"] as Record<string, unknown>)["cents"]));
    const items = (data["difference"] as { items: { amount: { cents: string } }[] }).items;
    const encumbered = items.reduce((acc, i) => acc + BigInt(i.amount.cents), 0n);

    // available = ledger - holds - uncleared, exactly, with no rounding.
    expect(available).toBe(ledger + encumbered);
  });

  it("answers the bitemporal question on both axes", async () => {
    // "Everything we know now" and "what we believed at the epoch" are
    // different questions; the second must include nothing.
    const now = await call("get_balance", {});
    const believedAtDawnOfTime = await call("get_balance", {
      as_of_value_date: "2026-12-31",
      as_of_booking_time: "2000-01-01T00:00:00Z",
    });

    expect((structured(now)["as_of"] as Record<string, unknown>)["basis"]).toBe("current");
    const past = structured(believedAtDawnOfTime);
    expect((past["as_of"] as Record<string, unknown>)["basis"]).toBe("as_believed");
    expect((past["as_of"] as Record<string, unknown>)["booking_watermark"]).toBe("0");
    expect((past["ledger_balance"] as Record<string, unknown>)["cents"]).toBe("0");
  });

  it("runs list_transactions and keeps the two date columns apart", async () => {
    const body = await call("list_transactions", { limit: 25 });
    const data = structured(body);
    const rows = data["transactions"] as Record<string, unknown>[];

    for (const row of rows) {
      expect(typeof row["value_date"]).toBe("string");
      expect(typeof row["booking_date"]).toBe("string");
      expect(typeof row["booking_seq"]).toBe("string");
      expect(String(row["value_date"])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(String(row["booking_date"])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // THE TWO COLUMNS ARE INDEPENDENT, IN BOTH DIRECTIONS, and this assertion
    // used to say otherwise: it required booking_date >= value_date, on the
    // reasoning that nothing can be learned before it happened. That is true
    // of a settlement and false of a credit. An inbound ACH accepted today
    // with a value date of tomorrow books now and values then — the funding
    // path raises exactly that row, and a forward-dated settlement in the
    // live-fire script values in 2027. Both are correct, and a surface that
    // refused to return them would be hiding the money that is on its way.
    //
    // What the tool must never do is COLLAPSE the two into one column, so what
    // is asserted is that they are separately present and separately filtered.
    const future = await call("list_transactions", {
      value_date_from: "2026-09-11",
      limit: 5,
    });
    for (const row of structured(future)["transactions"] as Record<string, unknown>[]) {
      expect(String(row["value_date"]) >= "2026-09-11").toBe(true);
    }
  });

  // 20s: `v_recon_break` recomputes the whole diff, and this branch is
  // cross-region from here. Measured at ~0.2-0.7s warm; the margin is for a
  // Neon compute that has scaled to zero.
  it("runs list_recon_breaks against the reconciliation engine's own view", { timeout: 20_000 }, async () => {
    const body = await call("list_recon_breaks", { limit: 25 });
    const data = structured(body);
    expect(Array.isArray(data["open_breaks"])).toBe(true);
    expect(typeof data["unattributable_open_breaks"]).toBe("number");
    for (const row of data["open_breaks"] as Record<string, unknown>[]) {
      expect(["in_file_not_ledger", "in_ledger_not_file", "amount_mismatch"]).toContain(
        row["category"],
      );
      expect(typeof row["age_days"]).toBe("number");
    }
  });

  it("runs list_pots against the pot views and proves the identity on real rows", async () => {
    const data = structured(await call("list_pots", {}));
    const totals = data["totals"] as Record<string, Record<string, string>>;

    // main + Σ pots against a recursive walk of the deposit subtree. This is
    // the one assertion here that could fail for a reason worth knowing about.
    expect(totals["identity_holds"]).toBe(true);
    expect(totals["identity_difference"]?.["cents"]).toBe("0");

    const main = BigInt(
      String((data["main_account"] as Record<string, Record<string, string>>)["ledger_balance"]?.["cents"]),
    );
    const pots = BigInt(String(totals["pots_total"]?.["cents"]));
    expect(BigInt(String(totals["main_plus_pots"]?.["cents"]))).toBe(main + pots);

    for (const pot of data["pots"] as Record<string, unknown>[]) {
      // A pot's account code is the main leaf plus its own id, which is what
      // makes it invisible to every `code = '2100'` query in the codebase.
      expect(String(pot["account_code"])).toMatch(/^2100\./);
      expect(typeof (pot["balance"] as Record<string, unknown>)["cents"]).toBe("string");
    }
  });

  it("runs list_payees against the payee book view", async () => {
    const data = structured(await call("list_payees", { limit: 25 }));
    const rows = data["payees"] as Record<string, Record<string, unknown>>[];
    expect(Array.isArray(rows)).toBe(true);

    for (const row of rows) {
      expect(["fresh", "ageing", "stale", "never"]).toContain(
        row["verification"]?.["freshness"],
      );
      const last4 = row["account_number_last4"];
      if (last4 !== null) expect(String(last4)).toMatch(/^\d{4}$/);
      // Archived payees are excluded unless asked for.
      expect(row["archived"]).toBe(false);
    }
  });

  it("runs list_standing_orders and returns refusals as rows", async () => {
    const data = structured(await call("list_standing_orders", { occurrences_per_order: 5 }));
    const mandates = data["mandates"] as Record<string, unknown>[];

    for (const mandate of mandates) {
      expect(typeof mandate["reference"]).toBe("string");
      for (const occurrence of mandate["recent_occurrences"] as Record<string, unknown>[]) {
        expect([null, "raised", "refused"]).toContain(occurrence["disposition"]);
        // The generated key, straight off the row. This is the exactly-once
        // mechanism, and it is a column rather than something we compute.
        expect(String(occurrence["idempotency_key"])).toMatch(
          /^standing:[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/,
        );
        if (occurrence["disposition"] === "refused") {
          expect(typeof occurrence["refusal_code"]).toBe("string");
        }
      }
    }

    expect((data["policy"] as Record<string, unknown>)["stale_after_days"]).toBe(5);
  });

  it("runs list_card_controls and never returns a provider token", async () => {
    const data = structured(await call("list_card_controls", { decision_limit: 10 }));

    for (const card of data["cards"] as Record<string, unknown>[]) {
      const controls = card["controls"] as Record<string, unknown> | null;
      if (controls !== null) {
        expect(["active", "frozen"]).toContain(controls["card_state"]);
        for (const blocked of controls["blocked_mccs"] as Record<string, unknown>[]) {
          expect(String(blocked["mcc"])).toMatch(/^\d{4}$/);
        }
      }
    }

    // The handles that address a card at Lithic are dropped in the gateway,
    // before anything downstream could log or return them.
    const rendered = JSON.stringify(data);
    expect(rendered).not.toContain("provider_card_token");
    expect(rendered).not.toContain("provider_auth_token");
    expect(rendered).not.toMatch(/"card_[A-Za-z0-9]{12,}"/);
  });

  it("keeps two tenants apart on every reader that touches customer data", async () => {
    // Same argument as the balance test: scope comes from the token, so the
    // same call under B's token cannot reach A's rows. Asserted per tool
    // because each one is a different query — and the list is every reader
    // rather than a sample, because the one that gets forgotten is the one
    // that leaks.
    for (const tool of [
      "list_pots",
      "list_payees",
      "list_standing_orders",
      "list_card_controls",
      "list_disputes",
      "list_accruals",
    ]) {
      const body = await call(tool, {}, TOKEN_B);
      const result = body["result"] as Record<string, unknown>;
      const data = result["structuredContent"] as Record<string, unknown>;
      if (result["isError"] === true) continue;
      expect((data["business"] as Record<string, unknown>)["id"]).toBe(businessB);
    }
  });

  it("runs list_disputes against the live case fold", async () => {
    expect(businessWithDisputes, "seed first: no dispute cases on the book").not.toBeNull();

    const data = structured(
      await call("list_disputes", { open_only: false, limit: 5 }, TOKEN_C),
    );
    const counts = data["counts"] as Record<string, number | undefined>;
    expect((counts["open"] ?? 0) + (counts["closed"] ?? 0)).toBeGreaterThan(0);
    expect((data["cases"] as unknown[]).length).toBeGreaterThan(0);

    for (const row of data["cases"] as Record<string, unknown>[]) {
      // Status is a fold over the event stream, so it must be one the model
      // knows; and the money must be a cent string, never a JSON number.
      expect(String(row["status_meaning"]).length).toBeGreaterThan(10);
      expect(typeof (row["amount_claimed"] as Record<string, unknown>)["cents"]).toBe("string");
      expect(typeof (row["held"] as Record<string, unknown>)["cents"]).toBe("string");
      // Every transition that moved money was made by a named human. This is
      // assert_dispute_lifecycle()'s guarantee, read back off real rows.
      for (const event of row["events"] as Record<string, unknown>[]) {
        if (event["kind"] === "provisional_credit_authorized") {
          expect(event["actor_kind"]).toBe("human");
        }
      }
    }
  });

  it("runs list_accruals and the stored arithmetic re-derives", async () => {
    // Whichever business actually has postings; the point of this test is the
    // arithmetic on real rows, and an empty list would assert nothing.
    const token = businessWithAccrual === businessWithDisputes ? TOKEN_C : TOKEN_A;
    const data = structured(await call("list_accruals", { days: 40, months: 3 }, token));
    expect((data["days"] as unknown[]).length).toBeGreaterThan(0);

    for (const day of data["days"] as Record<string, unknown>[]) {
      const maths = day["arithmetic"] as Record<string, unknown> | null;
      if (maths === null) continue;

      const price = BigInt(String((maths["monthly_price"] as Record<string, string>)["cents"]));
      const n = BigInt(maths["days_in_month"] as number);
      const d = BigInt(maths["day_of_month"] as number);
      const amount = BigInt(String((maths["amount"] as Record<string, string>)["cents"]));

      // Largest remainder, recomputed here in bigint from the three inputs the
      // row stored. If this file and `accrual_daily_share()` ever disagreed,
      // the row could not have been written — so this asserts that the tool
      // PROJECTED the stored columns rather than recomputing them wrongly.
      expect(amount).toBe(price / n + (d <= price % n ? 1n : 0n));
    }

    // The two that must be zero forever, scoped to this business.
    expect(data["invariants"]).toMatchObject({ month_drift: 0, ledger_drift: 0 });
  });

  it("tells an agent what it is refused, and why, rather than 'unknown tool'", async () => {
    const data = structured(await call("list_agent_limits", { operation: "approve_payment" }));
    const first = (data["refusals"] as Record<string, unknown>[])[0];
    expect(first?.["section"]).toBe(2);
    expect(first?.["guarantee"]).toBe("unrepresentable");

    // And the guessed tool name itself is answered as a refusal rather than a
    // typo — the error carries the reason and points at the explaining tool.
    const guess = await call("approve_payment", {});
    const error = guess["error"] as Record<string, unknown>;
    const detail = error["data"] as Record<string, unknown>;
    expect(detail["refused"]).toBe(true);
    expect(String(detail["reason"])).toMatch(/refused operation/);
    expect(detail["explain_with"]).toBe("list_agent_limits");
  });

  it("keeps two tenants apart on real rows", async () => {
    const a = structured(await call("get_balance", {}, TOKEN_A));
    expect((a["business"] as Record<string, unknown>)["id"]).toBe(businessA);
    const accountName = String((a["account"] as Record<string, unknown>)["name"]);

    // The same call, same arguments, a different token. There is no argument
    // that could carry business A's account across; the resolution happens
    // inside the grant's business, so from B the account is simply absent.
    const b = await call("get_balance", {}, TOKEN_B);
    const result = b["result"] as Record<string, unknown>;
    const bData = result["structuredContent"] as Record<string, unknown>;

    if (result["isError"] === true) {
      expect(String(bData["message"])).toMatch(/no open account with code 2100/);
    } else {
      expect((bData["business"] as Record<string, unknown>)["id"]).toBe(businessB);
      expect((bData["account"] as Record<string, unknown>)["name"]).not.toBe(accountName);
    }

    // Whichever branch ran, business A's figures were never in B's answer.
    expect(JSON.stringify(bData)).not.toContain(accountName);
  });

  it("cannot address a house account from a tenant token", async () => {
    // 1110 is the FBO settlement account: every customer's money, pooled.
    const body = await call("get_balance", { account_code: "1110" });
    const result = body["result"] as Record<string, unknown>;
    expect(result["isError"]).toBe(true);
  });

  // -------------------------------------------------------------------
  // The write, and the refusal that makes it safe
  // -------------------------------------------------------------------

  it("queues a real payment instruction that no money depends on", async () => {
    const key = `it-queue-${run}`;
    const body = await call("initiate_payment", {
      rail: "ach",
      amount_cents: "1500",
      destination: {
        type: "ach",
        holder_name: "Northwind Components LLC",
        routing_number: "021000021",
        account_number_last4: "6789",
        account_type: "checking",
      },
      reason: `Integration test ${run}: proving the queue path end to end`,
      idempotency_key: key,
    });

    const data = structured(body);
    expect(data["status"]).toBe("queued_for_human_approval");
    expect(data["money_moved"]).toBe(false);
    expect(data["state"]).toBe("requested");

    const instructionId = String(data["instruction_id"]);

    // The row exists, is attributed to the AGENT, and cites a policy.
    const [row] = await sql<
      { requested_by: string; kind: string; can_approve: boolean; policy_id: string }[]
    >`
      SELECT pi.requested_by, a.kind::text AS kind, a.can_approve, pi.policy_id
        FROM payment_instruction pi
        JOIN actor a ON a.id = pi.requested_by
       WHERE pi.id = ${instructionId}::uuid`;
    expect(row?.requested_by).toBe(agentActorId);
    expect(row?.kind).toBe("agent");
    expect(row?.can_approve).toBe(false);
    expect(row?.policy_id).toBeTruthy();

    // A `requested` event exists and nothing else does.
    const events = await sql<{ kind: string }[]>`
      SELECT kind::text AS kind FROM payment_instruction_event
       WHERE instruction_id = ${instructionId}::uuid`;
    expect(events.map((e) => e.kind)).toEqual(["requested"]);

    // AND NO MONEY MOVED. No journal entry references this instruction by any
    // route: not through an event, not through the external ref.
    const [posted] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count
        FROM payment_instruction_event
       WHERE instruction_id = ${instructionId}::uuid
         AND entry_id IS NOT NULL`;
    expect(posted?.count).toBe(0);
  });

  it("REFUSES to let the agent approve what the agent queued", async () => {
    const key = `it-selfapprove-${run}`;
    const body = await call("initiate_payment", {
      rail: "ach",
      amount_cents: "1500",
      destination: {
        type: "ach",
        holder_name: "Northwind Components LLC",
        routing_number: "021000021",
        account_number_last4: "6789",
        account_type: "checking",
      },
      reason: `Integration test ${run}: attempting self-approval, which must fail`,
      idempotency_key: key,
    });
    const data = structured(body);
    const instructionId = String(data["instruction_id"]);
    const contentHash = String(data["content_hash"]);

    // Go around the application entirely and try to write the approval
    // directly, as the agent, citing the correct hash. This is the strongest
    // form of the attack: no TypeScript is in the way.
    let raised: unknown = null;
    try {
      await sql`
        INSERT INTO payment_instruction_event
          (instruction_id, kind, actor_id, approved_content_hash, value_date)
        VALUES
          (${instructionId}::uuid, 'approved', ${agentActorId}::uuid,
           decode(${contentHash}, 'hex'), CURRENT_DATE)`;
    } catch (error) {
      raised = error;
    }

    expect(raised, "the database MUST refuse an approval by an agent").not.toBeNull();
    const code = (raised as { code?: string }).code;
    // 42501 insufficient_privilege, raised by assert_maker_checker().
    expect(code).toBe("42501");
    expect(String((raised as Error).message)).toMatch(/not an approver|maker-checker/i);

    // And the row really is not there.
    const approvals = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM payment_instruction_event
       WHERE instruction_id = ${instructionId}::uuid AND kind = 'approved'`;
    expect(approvals[0]?.count).toBe(0);
  });

  it("REFUSES an approving agent as a row at all", async () => {
    // The constraint underneath everything: `actor_only_humans_approve`.
    // Nothing above this line would matter if this row were storable.
    let raised: unknown = null;
    try {
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO actor (kind, display_name, can_approve)
          VALUES ('agent', 'impossible approver', true)`;
      });
    } catch (error) {
      raised = error;
    }
    expect(raised).not.toBeNull();
    expect(String((raised as Error).message)).toMatch(
      /actor_only_humans_approve|violates check constraint|permission denied/i,
    );
  });

  it("replays an idempotency key to the same instruction", async () => {
    const key = `it-replay-${run}`;
    const args = {
      rail: "ach",
      amount_cents: "1200",
      destination: {
        type: "ach",
        holder_name: "Northwind Components LLC",
        routing_number: "021000021",
        account_number_last4: "6789",
        account_type: "checking",
      },
      reason: `Integration test ${run}: a retry must not queue a second payment`,
      idempotency_key: key,
    };

    const first = structured(await call("initiate_payment", args));
    const second = structured(await call("initiate_payment", args));

    expect(second["instruction_id"]).toBe(first["instruction_id"]);
    expect(second["replayed"]).toBe(true);
    expect(first["content_hash"]).toBe(second["content_hash"]);

    const [count] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM payment_instruction
       WHERE idempotency_key LIKE ${`%${key}`}`;
    expect(count?.count).toBe(1);
  });

  it("audits every call it just made, with actor and outcome", async () => {
    const writes = audit.records.filter(
      (r) => r.tool === "initiate_payment" && r.outcome === "ok",
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const record of writes) {
      expect(record.actorId).toBe(agentActorId);
      expect([businessA, businessB]).toContain(record.businessId);
      expect(record.argumentsRedacted).not.toBeNull();
    }
    const refusals = audit.records.filter((r) => r.outcome !== "ok");
    // The house-account call above was refused and must appear.
    expect(refusals.some((r) => r.errorCode === "ACCOUNT_NOT_FOUND")).toBe(true);
  });
});
