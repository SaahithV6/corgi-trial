/**
 * The public HTTP API against the REAL Neon database.
 *
 * Gated on RUN_DB_TESTS=1 so CI, which holds no credentials on purpose, skips
 * rather than fails:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 *
 * Two claims are being PROVED here rather than asserted in prose, and they are
 * the two the brief says must be enforceable:
 *
 *   1. A CROSS-BUSINESS READ IS A DATA BREACH, NOT A BUG. A token scoped to
 *      business B asks for a payment instruction that genuinely exists and
 *      belongs to business A, by its real uuid, and is told it does not exist.
 *      Not a 403 — a 403 confirms the id is real, and confirming that is the
 *      first half of an enumeration attack.
 *
 *   2. THE SAME KEY, THE SAME ANSWER, NO SECOND EFFECT. A real double-POST
 *      with one Idempotency-Key produces one row in `payment_instruction`, two
 *      identical bodies, a 201 then a 200, and `replayed: false` then `true`.
 *      The same key with a DIFFERENT amount is a 409 and still one row.
 *
 * These tests write real rows. `payment_instruction` is append-only and
 * `corgi_app` holds no DELETE on it, so the rows stay — which is correct: they
 * are the evidence. Idempotency keys carry a run stamp so a re-run raises new
 * instructions instead of colliding with the last run's.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { MemoryAuditSink, RateLimiter, parseTokenConfig } from "@/lib/mcp";
import type { Gateway } from "@/lib/mcp";
// Type-only, so this does NOT pull the Postgres handle in at module load.
import type { sql as SqlHandle } from "@/lib/ledger/db";

import { ActorVerificationCache } from "./auth";
import { handle, type ApiDeps, type RouteSpec } from "./handle";
// Type-only namespace imports: erased at compile time, so naming the modules
// here costs nothing at runtime and the dynamic imports below stay typed.
import type * as AccountRoutes from "./routes/accounts";
import type * as MetaRoutes from "./routes/meta";
import type * as PaymentRoutes from "./routes/payments";
import type * as PayeeRoutes from "./routes/payees";
import type * as ReconRoutes from "./routes/reconciliation";
import type * as StatementRoutes from "./routes/statements";
import type * as TransactionRoutes from "./routes/transactions";

/**
 * THE ROUTE MODULES ARE IMPORTED DYNAMICALLY, INSIDE `beforeAll`.
 *
 * `routes/payments.ts` reaches `@/lib/approvals/instructions`, which holds a
 * module-level `postgres(env.APP_DATABASE_URL)`. A static import here would
 * construct that handle — and therefore parse the environment — at module
 * load, which happens even when this suite is SKIPPED. CI holds no database
 * credentials on purpose, so the file would fail to collect rather than skip,
 * and a suite that turns the build red when it is switched off is worse than
 * no suite. `mcp.integration.test.ts` makes the same move for `gateway.ts`.
 */
type Routes = {
  readonly accounts: typeof AccountRoutes;
  readonly meta: typeof MetaRoutes;
  readonly payments: typeof PaymentRoutes;
  readonly payees: typeof PayeeRoutes;
  readonly reconciliation: typeof ReconRoutes;
  readonly statements: typeof StatementRoutes;
  readonly transactions: typeof TransactionRoutes;
};

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

const TOKEN_A = "corgi_api_integration_ridgeline_01";
const TOKEN_B = "corgi_api_integration_kettle_00002";

const BASE = "https://api.test.local";

d("the public HTTP API, against the live database", () => {
  let sql: typeof SqlHandle;
  let r: Routes;
  let deps: ApiDeps;
  let businessA: string;
  let businessB: string;
  let run: number;

  /** Drive one route the way the Next route file does. */
  async function call(
    spec: Omit<RouteSpec, "name">,
    path: string,
    init: RequestInit & { readonly token?: string | null } = {},
  ): Promise<{ readonly status: number; readonly body: Record<string, unknown>; readonly headers: Headers }> {
    const headers = new Headers(init.headers ?? {});
    const token = init.token === undefined ? TOKEN_A : init.token;
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");

    const request = new Request(`${BASE}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const response = await handle(request, deps, { name: `TEST ${path}`, ...spec });
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
      headers: response.headers,
    };
  }

  const READ = (run_: RouteSpec["run"]): Omit<RouteSpec, "name"> => ({ readOnly: true, run: run_ });
  const WRITE = (run_: RouteSpec["run"]): Omit<RouteSpec, "name"> => ({ readOnly: false, run: run_ });

  /**
   * Refill the write bucket.
   *
   * WRITE_LIMIT_PER_MINUTE is 6, deliberately small — a queued payment costs a
   * human's attention and sixty a minute is an attack on the approver. This
   * suite makes more than six write attempts, so it spends the budget the way
   * a real integration in a retry loop would; the budget itself is asserted in
   * its own test below, and reset here so the refusal tests are testing the
   * refusal they name rather than the throttle.
   */
  function refillWriteBudget(): void {
    deps.limiter.reset();
  }

  beforeAll(async () => {
    ({ sql } = await import("@/lib/ledger/db"));
    const { liveGateway } = await import("@/lib/mcp/gateway");
    const { listBusinesses } = await import("@/lib/ledger/queries");

    r = {
      accounts: await import("./routes/accounts"),
      meta: await import("./routes/meta"),
      payments: await import("./routes/payments"),
      payees: await import("./routes/payees"),
      reconciliation: await import("./routes/reconciliation"),
      statements: await import("./routes/statements"),
      transactions: await import("./routes/transactions"),
    };

    // WHICH BUSINESSES ARE ON THE BOOK IS THE LEDGER'S QUESTION, and it is
    // asked of `listBusinesses()` rather than of a join this file writes.
    // `boundary.test.ts` holds integration tests to the same rule as modules,
    // deliberately: a test that reaches into `account` to decide which
    // business has money has its own opinion about what a customer's account
    // is, which is the exact failure the boundary exists to stop.
    //
    // A is a business that can actually transact: `requestPayment()` runs the
    // KYB gate before it writes, so a business whose verification is pending
    // refuses the write path for a reason that has nothing to do with this
    // surface. B is any OTHER business — deliberately allowed to be one with
    // no accounts, which is the sharper scoping test.
    const businesses = await listBusinesses(sql);
    const funded = businesses.filter((b) => b.depositOpen && b.depositAccountId !== null);
    const approved = await sql<{ business_id: string }[]>`
      SELECT k.business_id
        FROM v_business_kyb k
       WHERE k.kyb_status = 'approved'`;
    const approvedIds = new Set(approved.map((row) => row.business_id));

    const withAccounts = funded.find((b) => approvedIds.has(b.businessId));
    if (withAccounts === undefined) {
      throw new Error("seed first: node scripts/seed.mjs (need a KYB-approved business with 2100)");
    }
    businessA = withAccounts.businessId;

    const other = businesses.find((b) => b.businessId !== businessA);
    if (other === undefined) throw new Error("seed first: need a second business");
    businessB = other.businessId;

    const [agent] = await sql<{ id: string }[]>`
      SELECT id FROM actor WHERE kind = 'agent' ORDER BY display_name LIMIT 1`;
    if (agent === undefined) throw new Error("seed first: need an agent actor");

    const gateway: Gateway = liveGateway();
    deps = {
      gateway,
      config: parseTokenConfig(
        JSON.stringify([
          { label: "api-it-a", token: TOKEN_A, actorId: agent.id, businessId: businessA },
          { label: "api-it-b", token: TOKEN_B, actorId: agent.id, businessId: businessB },
        ]),
      ),
      audit: new MemoryAuditSink(),
      limiter: new RateLimiter(),
      cache: new ActorVerificationCache(),
    };

    run = Date.now();
  });

  /* ---------------------------------------------------------------- */
  /* Authentication                                                    */
  /* ---------------------------------------------------------------- */

  it("refuses an unauthenticated call with 401 and a WWW-Authenticate challenge", async () => {
    const { status, body, headers } = await call(READ(r.meta.indexRoute), "/api/v1", { token: null });
    expect(status).toBe(401);
    expect(headers.get("www-authenticate")).toContain("Bearer");
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("MISSING_BEARER_TOKEN");
  });

  it("gives the same answer for an unknown token as for a revoked one", async () => {
    const { status, body } = await call(READ(r.meta.indexRoute), "/api/v1", { token: "definitely-not-a-token" });
    expect(status).toBe(401);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("UNKNOWN_TOKEN");
  });

  it("echoes the business the credential is scoped to", async () => {
    const { status, body } = await call(READ(r.meta.indexRoute), "/api/v1");
    expect(status).toBe(200);
    expect((body["business"] as Record<string, unknown>)["id"]).toBe(businessA);
    expect((body["credential"] as Record<string, unknown>)["can_approve"]).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* Reads                                                             */
  /* ---------------------------------------------------------------- */

  it("lists accounts and reports the KYB gate on money-out", async () => {
    const { status, body } = await call(READ(r.accounts.listAccountsRoute), "/api/v1/accounts");
    expect(status).toBe(200);
    const data = body["data"] as Record<string, unknown>[];
    expect(data.length).toBeGreaterThan(0);
    expect(data.map((a) => a["code"])).toContain("2100");
    // The gate is the same predicate requestPayment() will consult.
    expect(body["gate"]).toMatchObject({ can_transact: true });
  });

  it("returns a balance whose terms are strings of integer cents", async () => {
    const { status, body } = await call(READ((c) => r.accounts.getBalanceRoute(c, "2100")), "/api/v1/accounts/2100/balance");
    expect(status).toBe(200);

    const ledger = body["ledger_balance"] as Record<string, string>;
    const available = body["available_balance"] as Record<string, string>;
    expect(typeof ledger["cents"]).toBe("string");
    expect(ledger["cents"]).toMatch(/^-?[0-9]+$/);

    // available = ledger + Σ components. The identity, checked on live data.
    const components = (body["difference"] as Record<string, unknown>)["components"] as Record<
      string,
      Record<string, string>
    >[];
    const sum = components.reduce((acc, c) => acc + BigInt(c["amount"]?.["cents"] ?? "0"), 0n);
    expect(BigInt(ledger["cents"] ?? "0") + sum).toBe(BigInt(available["cents"] ?? "0"));
  });

  it("answers the bitemporal question on both axes", async () => {
    const current = await call(
      READ((c) => r.accounts.getBalanceRoute(c, "2100")),
      "/api/v1/accounts/2100/balance",
    );
    expect((current.body["as_of"] as Record<string, unknown>)["basis"]).toBe("current");

    const believed = await call(
      READ((c) => r.accounts.getBalanceRoute(c, "2100")),
      "/api/v1/accounts/2100/balance?as_of_value_date=2026-01-31&as_of_booking_time=2026-02-01T00:00:00Z",
    );
    expect(believed.status).toBe(200);
    const asOf = believed.body["as_of"] as Record<string, unknown>;
    expect(asOf["basis"]).toBe("as_believed");
    expect(asOf["booking_watermark"]).toMatch(/^[0-9]+$/);
  });

  it("pages transactions with an opaque cursor that walks backwards", async () => {
    const first = await call(READ(r.transactions.listTransactionsRoute), "/api/v1/transactions?limit=2");
    expect(first.status).toBe(200);
    const rows = first.body["data"] as Record<string, unknown>[];
    expect(rows.length).toBeLessThanOrEqual(2);

    const cursor = (first.body["page"] as Record<string, unknown>)["next_cursor"];
    if (typeof cursor === "string") {
      // The cursor is base64url of a versioned object, not the sequence.
      expect(cursor).not.toMatch(/^[0-9]+$/);
      const second = await call(
        READ(r.transactions.listTransactionsRoute),
        `/api/v1/transactions?limit=2&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(second.status).toBe(200);
      const firstSeqs = rows.map((r) => BigInt(String(r["booking_seq"])));
      const secondSeqs = (second.body["data"] as Record<string, unknown>[]).map((r) =>
        BigInt(String(r["booking_seq"])),
      );
      for (const s of secondSeqs) {
        for (const f of firstSeqs) expect(s).toBeLessThan(f);
      }
    }
  });

  it("serves the payee book, the breaks and the statement days", async () => {
    const payees = await call(READ(r.payees.listPayeesRoute), "/api/v1/payees?limit=5");
    expect(payees.status).toBe(200);
    expect(payees.body["object"]).toBe("list");

    const breaks = await call(READ(r.reconciliation.listBreaksRoute), "/api/v1/reconciliation/breaks?limit=5");
    expect(breaks.status).toBe(200);
    expect(typeof breaks.body["unattributable_open_breaks"]).toBe("number");

    const statements = await call(READ(r.statements.listStatementsRoute), "/api/v1/statements?limit=5");
    expect(statements.status).toBe(200);
  });

  it("serves its own refusal list without touching a table", async () => {
    const { status, body } = await call(READ(r.meta.limitsRoute), "/api/v1/limits");
    expect(status).toBe(200);
    expect((body["http_specific"] as unknown[]).length).toBeGreaterThanOrEqual(8);
    expect((body["inherited_from_agent_limits"] as unknown[]).length).toBeGreaterThanOrEqual(20);
    expect((body["missing_readers"] as unknown[]).length).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- */
  /* Idempotency — a real double-POST                                  */
  /* ---------------------------------------------------------------- */

  function paymentBody(amountCents: string): string {
    return JSON.stringify({
      rail: "ach",
      amount_cents: amountCents,
      destination: {
        type: "ach",
        holder_name: "Ridgeline Supply Co",
        routing_number: "011401533",
        account_number_last4: "4321",
        account_type: "checking",
      },
      reason: "integration test: proving a replay has no second effect",
    });
  }

  it("queues a payment, and the same key twice produces exactly one row", async () => {
    refillWriteBudget();
    const key = `api-it-${run}-double`;

    const first = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: paymentBody("100"),
    });
    expect(first.status).toBe(201);
    expect(first.body["money_moved"]).toBe(false);
    expect(first.body["status"]).toBe("queued_for_human_approval");
    expect(first.body["replayed"]).toBe(false);
    expect(first.headers.get("idempotency-replayed")).toBe("false");

    const second = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: paymentBody("100"),
    });
    // 200 rather than 201: nothing was written the second time.
    expect(second.status).toBe(200);
    expect(second.body["replayed"]).toBe(true);
    expect(second.headers.get("idempotency-replayed")).toBe("true");

    // SAME ANSWER. Everything except the two fields whose whole job is to
    // distinguish a replay from an original.
    expect(second.body["id"]).toBe(first.body["id"]);
    expect(second.body["content_hash"]).toBe(first.body["content_hash"]);
    expect(second.body["requested_at"]).toBe(first.body["requested_at"]);
    expect(second.body["amount"]).toEqual(first.body["amount"]);

    // NO SECOND EFFECT, asked of the database rather than inferred from the
    // response. The unique index decided this, not an `if`.
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM payment_instruction
       WHERE idempotency_key LIKE ${`api:%:%:${key}`}`;
    expect(count?.n).toBe(1);

    // And exactly one `requested` event: an instruction with two would be a
    // payment that appears twice in the queue.
    const [events] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM payment_instruction_event
       WHERE instruction_id = ${String(first.body["id"])}::uuid
         AND kind = 'requested'`;
    expect(events?.n).toBe(1);
  });

  it("refuses the same key with a different body, and writes nothing", async () => {
    refillWriteBudget();
    const key = `api-it-${run}-conflict`;

    const first = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: paymentBody("100"),
    });
    expect(first.status).toBe(201);

    const reused = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: paymentBody("999999"),
    });

    // The case that matters most on a machine-to-machine surface: without
    // this, the caller would get a confident 200 describing a payment they did
    // not ask for, and would reconcile against it.
    expect(reused.status).toBe(409);
    const error = reused.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("IDEMPOTENCY_KEY_REUSED");
    const details = error["details"] as Record<string, unknown>;
    expect(details["existing_content_hash"]).toBe(first.body["content_hash"]);
    expect(details["requested_content_hash"]).not.toBe(first.body["content_hash"]);

    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM payment_instruction
       WHERE idempotency_key LIKE ${`api:%:%:${key}`}`;
    expect(count?.n).toBe(1);
  });

  it("throttles writes far harder than reads, and says how long to wait", async () => {
    // WRITE_LIMIT_PER_MINUTE is 6. Sixty reads a minute is a busy integration;
    // sixty queued payments a minute is a denial-of-service attack on the
    // approver, who is the control this whole design rests on. Spent here with
    // requests that are refused on their own merits anyway, so the budget is
    // proved without queueing six real instructions.
    refillWriteBudget();
    const attempt = (n: number) =>
      call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
        method: "POST",
        headers: { "idempotency-key": `api-it-${run}-budget-${n}` },
        body: JSON.stringify({ rail: "ach" }),
      });

    for (let n = 0; n < 6; n += 1) {
      expect((await attempt(n)).status).toBe(400);
    }
    const throttled = await attempt(6);
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).toMatch(/^[0-9]+$/);
    const error = throttled.body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("WRITE_RATE_LIMITED");
    expect(String(error["resolution"])).toContain("SAME Idempotency-Key");

    // A read is unaffected: the two budgets are separate buckets.
    refillWriteBudget();
  });

  it("requires an Idempotency-Key at all", async () => {
    refillWriteBudget();
    const { status, body } = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      body: paymentBody("100"),
    });
    expect(status).toBe(400);
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(String(error["resolution"])).toContain("invoice");
  });

  /* ---------------------------------------------------------------- */
  /* Cross-business isolation                                          */
  /* ---------------------------------------------------------------- */

  it("refuses a cross-business read of a REAL instruction id, as a 404 and not a 403", async () => {
    refillWriteBudget();
    const key = `api-it-${run}-isolation`;
    const created = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": key },
      body: paymentBody("100"),
    });
    expect(created.status).toBe(201);
    const id = String(created.body["id"]);

    // Business A can read its own.
    const mine = await call(READ((c) => r.payments.getPaymentRoute(c, id)), `/api/v1/payments/${id}`);
    expect(mine.status).toBe(200);
    expect(mine.body["id"]).toBe(id);

    // Business B, presenting a valid token, asking for an id that genuinely
    // exists, gets the answer for an id that does not. A 403 here would
    // confirm the id is real.
    const theirs = await call(READ((c) => r.payments.getPaymentRoute(c, id)), `/api/v1/payments/${id}`, {
      token: TOKEN_B,
    });
    expect(theirs.status).toBe(404);
    expect((theirs.body["error"] as Record<string, unknown>)["code"]).toBe("NO_SUCH_INSTRUCTION");
    expect(JSON.stringify(theirs.body)).not.toContain(businessA);
  });

  it("cannot be widened by a query parameter", async () => {
    // The other half of isolation: scope comes from the token, and there is no
    // parameter that changes it. An unknown parameter is refused rather than
    // ignored, so a caller never believes one took effect.
    const { status, body } = await call(
      READ(r.transactions.listTransactionsRoute),
      `/api/v1/transactions?business_id=${businessA}`,
      { token: TOKEN_B },
    );
    expect(status).toBe(400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("UNKNOWN_QUERY_PARAMETER");
  });

  it("hands two tokens two disjoint sets of ledger rows", async () => {
    const a = await call(READ(r.transactions.listTransactionsRoute), "/api/v1/transactions?limit=50");
    const b = await call(READ(r.transactions.listTransactionsRoute), "/api/v1/transactions?limit=50", {
      token: TOKEN_B,
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const idsA = new Set(
      (a.body["data"] as Record<string, unknown>[]).map((r) => String(r["entry_id"])),
    );
    const rowsB = b.body["data"] as Record<string, unknown>[];
    expect(idsA.size).toBeGreaterThan(0);
    for (const row of rowsB) {
      expect(idsA.has(String(row["entry_id"])), "a ledger row reached both tokens").toBe(false);
    }
  });

  it("does not make a house account addressable", async () => {
    // 1110 is the FBO cash account: every customer's money pooled. The
    // gateway's predicate is `business_id = $1` with no IS NULL disjunct, so
    // this is not filtered out — it is not addressable.
    const { status, body } = await call(
      READ((c) => r.accounts.getBalanceRoute(c, "1110")),
      "/api/v1/accounts/1110/balance",
    );
    expect(status).toBe(404);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("ACCOUNT_NOT_FOUND");
  });

  /* ---------------------------------------------------------------- */
  /* Refusals that name the condition                                  */
  /* ---------------------------------------------------------------- */

  it("refuses an impossible routing number with the transposition named", async () => {
    refillWriteBudget();
    const { status, body } = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": `api-it-${run}-aba` },
      body: JSON.stringify({
        rail: "ach",
        amount_cents: "100",
        destination: {
          type: "ach",
          holder_name: "Ridgeline Supply Co",
          // 011401533 with two adjacent digits swapped.
          routing_number: "011401353",
          account_number_last4: "4321",
          account_type: "checking",
        },
        reason: "integration test: an ABA check digit that cannot be right",
      }),
    });
    expect(status).toBe(400);
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("PAYEE_ROUTING_NUMBER_IMPOSSIBLE");
    expect(String(error["condition"])).toContain("check digit");
    expect(String(error["resolution"])).toContain("no override");
  });

  it("refuses an amount above the available balance and itemises why", async () => {
    refillWriteBudget();
    const { status, body } = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": `api-it-${run}-funds` },
      body: paymentBody("999999999999"),
    });
    expect(status).toBe(422);
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("INSUFFICIENT_AVAILABLE_FUNDS");
    const details = error["details"] as Record<string, Record<string, string>>;
    for (const field of ["requested", "available", "ledger", "held"]) {
      expect(details[field]?.["cents"]).toMatch(/^-?[0-9]+$/);
    }
  });

  it("refuses a backdated value date in the vocabulary of a correction", async () => {
    refillWriteBudget();
    const { status, body } = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": `api-it-${run}-backdate` },
      body: JSON.stringify({
        rail: "ach",
        amount_cents: "100",
        value_date: "2020-01-01",
        destination: {
          type: "ach",
          holder_name: "Ridgeline Supply Co",
          routing_number: "011401533",
          account_number_last4: "4321",
          account_type: "checking",
        },
        reason: "integration test: backdating money out is not a correction",
      }),
    });
    expect(status).toBe(400);
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("VALUE_DATE_IN_THE_PAST");
    expect(String(error["resolution"])).toContain("reversal");
  });

  it("refuses an unknown field rather than ignoring it", async () => {
    refillWriteBudget();
    const { status, body } = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": `api-it-${run}-unknown` },
      body: JSON.stringify({
        rail: "ach",
        amount_cents: "100",
        approve: true,
        destination: {
          type: "ach",
          holder_name: "Ridgeline Supply Co",
          routing_number: "011401533",
          account_number_last4: "4321",
          account_type: "checking",
        },
        reason: "integration test: an unknown field must not be silently dropped",
      }),
    });
    expect(status).toBe(400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_ARGUMENTS");
  });

  it("refuses a JSON number for an amount", async () => {
    refillWriteBudget();
    // The single most likely integration mistake, and the one with no warning
    // if it were accepted: a double cannot represent every cent value.
    const { status, body } = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": `api-it-${run}-float` },
      body: JSON.stringify({
        rail: "ach",
        amount_cents: 100,
        destination: {
          type: "ach",
          holder_name: "Ridgeline Supply Co",
          routing_number: "011401533",
          account_number_last4: "4321",
          account_type: "checking",
        },
        reason: "integration test: amounts are decimal strings of cents",
      }),
    });
    expect(status).toBe(400);
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe("INVALID_ARGUMENTS");
    expect(JSON.stringify(error["details"])).toContain("CENTS");
  });

  it("refuses the internal rail, which would be releasable with no approver", async () => {
    refillWriteBudget();
    const { status, body } = await call(WRITE(r.payments.createPaymentRoute), "/api/v1/payments", {
      method: "POST",
      headers: { "idempotency-key": `api-it-${run}-internal` },
      body: JSON.stringify({
        rail: "internal",
        amount_cents: "100",
        destination: { type: "ach", holder_name: "x", routing_number: "011401533", account_number_last4: "4321", account_type: "checking" },
        reason: "integration test: the internal rail is absent from this surface",
      }),
    });
    expect(status).toBe(400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_ARGUMENTS");
  });
});
