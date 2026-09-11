import { describe, expect, it } from "vitest";

import { logger } from "@/lib/log";

import { MemoryAuditSink } from "./audit";
import { ActorVerificationCache, parseTokenConfig } from "./auth";
import {
  FORBIDDEN,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  RATE_LIMITED,
  UNAUTHORIZED,
} from "./jsonrpc";
import { LATEST_PROTOCOL_VERSION } from "./protocol";
import { RateLimiter, WRITE_LIMIT_PER_MINUTE } from "./ratelimit";
import { createMcpServer, originAllowed } from "./server";
import {
  AGENT_ACTOR,
  BUSINESS_A,
  BUSINESS_B,
  HUMAN_APPROVER,
  SYSTEM_ACTOR,
  defaultState,
  fakeGateway,
  txRow,
} from "./testing";
import type { Gateway } from "./types";

const TOKEN_A = "corgi_mcp_ridgeline_0123456789abcdef";
const TOKEN_B = "corgi_mcp_kettle_fedcba98765432100";
const URL = "http://localhost:3000/api/mcp";

function tokens(extra: Record<string, unknown>[] = []): string {
  return JSON.stringify([
    { label: "ridgeline-agent", token: TOKEN_A, actorId: AGENT_ACTOR, businessId: BUSINESS_A },
    { label: "kettle-agent", token: TOKEN_B, actorId: AGENT_ACTOR, businessId: BUSINESS_B },
    ...extra,
  ]);
}

interface Harness {
  post(body: unknown, init?: { token?: string | null; headers?: Record<string, string> }): Promise<Response>;
  call(tool: string, args: Record<string, unknown>, token?: string): Promise<Record<string, unknown>>;
  audit: MemoryAuditSink;
  limiter: RateLimiter;
  gateway: Gateway;
}

function harness(options: { gateway?: Gateway; config?: string } = {}): Harness {
  const gateway = options.gateway ?? fakeGateway().gateway;
  const audit = new MemoryAuditSink();
  const limiter = new RateLimiter();
  const server = createMcpServer({
    gateway,
    config: parseTokenConfig(options.config ?? tokens()),
    audit,
    limiter,
    cache: new ActorVerificationCache(),
    log: logger({ level: "error", emit: () => {} }),
    now: () => new Date("2026-09-10T18:00:00.000Z"),
  });

  let id = 0;

  return {
    gateway,
    audit,
    limiter,
    async post(body, init = {}) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      };
      const token = init.token === undefined ? TOKEN_A : init.token;
      if (token !== null) headers["authorization"] = `Bearer ${token}`;
      return server.handlePost(
        new Request(URL, { method: "POST", headers, body: JSON.stringify(body) }),
      );
    },
    async call(tool, args, token = TOKEN_A) {
      id += 1;
      const response = await this.post(
        { jsonrpc: "2.0", id, method: "tools/call", params: { name: tool, arguments: args } },
        { token },
      );
      return (await response.json()) as Record<string, unknown>;
    },
  };
}

function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  return body["result"] as Record<string, unknown>;
}

function structured(body: Record<string, unknown>): Record<string, unknown> {
  return resultOf(body)["structuredContent"] as Record<string, unknown>;
}

// ---------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------

describe("initialize", () => {
  it("echoes a supported protocol version and declares only tools", async () => {
    const h = harness();
    const response = await h.post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    const result = resultOf(body);
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["capabilities"]).toEqual({ tools: { listChanged: false } });
    expect((result["serverInfo"] as Record<string, unknown>)["name"]).toBe("corgi-neobank");
  });

  it("answers an older client with the revision it asked for", async () => {
    const h = harness();
    const body = (await (
      await h.post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      })
    ).json()) as Record<string, unknown>;
    expect(resultOf(body)["protocolVersion"]).toBe("2024-11-05");
  });

  it("answers a client from the future with its own latest rather than refusing", async () => {
    const h = harness();
    const body = (await (
      await h.post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2099-01-01" },
      })
    ).json()) as Record<string, unknown>;
    expect(resultOf(body)["protocolVersion"]).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("tells the model in its instructions that queuing is not paying", async () => {
    const h = harness();
    const body = (await (
      await h.post({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    ).json()) as Record<string, unknown>;
    const instructions = String(resultOf(body)["instructions"]);
    expect(instructions).toContain("NOTHING HAS BEEN PAID");
    expect(instructions).toContain("scoped to exactly one business");
  });

  it("refuses an unsupported MCP-Protocol-Version header", async () => {
    const h = harness();
    const response = await h.post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { "mcp-protocol-version": "1999-01-01" } },
    );
    expect(response.status).toBe(400);
  });
});

describe("tools/list", () => {
  it("lists eight tools with schemas and annotations", async () => {
    const h = harness();
    const body = (await (
      await h.post({ jsonrpc: "2.0", id: 2, method: "tools/list" })
    ).json()) as Record<string, unknown>;
    const tools = resultOf(body)["tools"] as Record<string, unknown>[];
    expect(tools.map((t) => t["name"])).toEqual([
      "get_balance",
      "list_pots",
      "list_transactions",
      "list_payees",
      "list_standing_orders",
      "list_card_controls",
      "list_recon_breaks",
      "initiate_payment",
    ]);
    for (const tool of tools) {
      expect(tool["inputSchema"]).toBeDefined();
      expect(tool["outputSchema"]).toBeDefined();
      expect(tool["annotations"]).toBeDefined();
    }
  });
});

describe("other methods", () => {
  it("answers ping", async () => {
    const h = harness();
    const body = (await (
      await h.post({ jsonrpc: "2.0", id: 3, method: "ping" })
    ).json()) as Record<string, unknown>;
    expect(resultOf(body)).toEqual({});
  });

  it("returns 202 and no body for a notification", async () => {
    const h = harness();
    const response = await h.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("says method-not-found for capabilities it does not declare", async () => {
    const h = harness();
    for (const method of ["resources/list", "prompts/list", "sampling/createMessage"]) {
      const body = (await (
        await h.post({ jsonrpc: "2.0", id: 4, method })
      ).json()) as Record<string, unknown>;
      expect((body["error"] as Record<string, unknown>)["code"]).toBe(METHOD_NOT_FOUND);
    }
  });
});

// ---------------------------------------------------------------------
// Authentication and scoping
// ---------------------------------------------------------------------

describe("authentication", () => {
  it("refuses a call with no token, with 401 and a WWW-Authenticate header", async () => {
    const h = harness();
    const response = await h.post({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { token: null });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    const body = (await response.json()) as Record<string, unknown>;
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(UNAUTHORIZED);
  });

  it("refuses tools/list, not just tools/call — nothing is public", async () => {
    const h = harness();
    for (const method of ["initialize", "ping", "tools/list"]) {
      const response = await h.post({ jsonrpc: "2.0", id: 6, method }, { token: null });
      expect(response.status).toBe(401);
    }
  });

  it("refuses an unknown token with the same words as a revoked one", async () => {
    const h = harness();
    const response = await h.post(
      { jsonrpc: "2.0", id: 7, method: "ping" },
      { token: "corgi_mcp_not_a_real_token_000000" },
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body["error"] as Record<string, unknown>)["message"]).toBe("token is not recognised");
  });

  it("refuses every call when no tokens are configured", async () => {
    const h = harness({ config: "" });
    const response = await h.post({ jsonrpc: "2.0", id: 8, method: "ping" });
    expect(response.status).toBe(401);
  });

  it("refuses a token pointed at a human approver, with 403", async () => {
    const h = harness({
      config: tokens([
        {
          label: "impersonator",
          token: "corgi_mcp_impersonator_00000000000",
          actorId: HUMAN_APPROVER,
          businessId: BUSINESS_A,
        },
      ]),
    });
    const response = await h.post(
      { jsonrpc: "2.0", id: 9, method: "ping" },
      { token: "corgi_mcp_impersonator_00000000000" },
    );
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(FORBIDDEN);
    expect(String((body["error"] as Record<string, unknown>)["message"])).toContain("kind \"human\"");
  });

  it("refuses a token pointed at a system principal", async () => {
    const h = harness({
      config: tokens([
        {
          label: "poster",
          token: "corgi_mcp_systemactor_0000000000000",
          actorId: SYSTEM_ACTOR,
          businessId: BUSINESS_A,
        },
      ]),
    });
    const response = await h.post(
      { jsonrpc: "2.0", id: 10, method: "ping" },
      { token: "corgi_mcp_systemactor_0000000000000" },
    );
    expect(response.status).toBe(403);
  });
});

describe("tenant scoping", () => {
  it("gives each token only its own business's money", async () => {
    const h = harness();

    const a = await h.call("get_balance", {}, TOKEN_A);
    expect((structured(a)["business"] as Record<string, unknown>)["id"]).toBe(BUSINESS_A);
    expect((structured(a)["ledger_balance"] as Record<string, unknown>)["cents"]).toBe("1000000");

    const b = await h.call("get_balance", {}, TOKEN_B);
    expect((structured(b)["business"] as Record<string, unknown>)["id"]).toBe(BUSINESS_B);
    expect((structured(b)["ledger_balance"] as Record<string, unknown>)["cents"]).toBe("750000");
  });

  it("cannot be widened by an argument, because no such argument parses", async () => {
    const h = harness();
    const body = await h.call("get_balance", { business_id: BUSINESS_B }, TOKEN_A);
    // Refused as INVALID_PARAMS rather than quietly ignored: a model that
    // believes the parameter worked will write a worse call next.
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(INVALID_PARAMS);
  });

  it("keeps transactions apart between tenants", async () => {
    const state = defaultState();
    state.transactions.set(BUSINESS_A, [txRow({ entryId: "ridgeline-1" })]);
    state.transactions.set(BUSINESS_B, [txRow({ entryId: "kettle-1" })]);
    const h = harness({ gateway: fakeGateway(state).gateway });

    const a = await h.call("list_transactions", {}, TOKEN_A);
    expect(
      (structured(a)["transactions"] as Record<string, unknown>[])[0]?.["entry_id"],
    ).toBe("ridgeline-1");

    const b = await h.call("list_transactions", {}, TOKEN_B);
    expect(
      (structured(b)["transactions"] as Record<string, unknown>[])[0]?.["entry_id"],
    ).toBe("kettle-1");
  });
});

// ---------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------

describe("tools/call", () => {
  it("returns both a text summary and structured content", async () => {
    const h = harness();
    const body = await h.call("get_balance", {});
    const result = resultOf(body);
    expect(result["isError"]).toBe(false);
    const content = result["content"] as Record<string, unknown>[];
    expect(content[0]?.["type"]).toBe("text");
    expect(String(content[0]?.["text"])).toContain("ledger balance");
    expect(structured(body)["available_balance"]).toBeDefined();
  });

  it("reports a business refusal as isError, not as a protocol error", async () => {
    // A model that gets a JSON-RPC error usually stops. One that gets a
    // readable refusal can go and ask a better question.
    const h = harness();
    const body = await h.call("get_balance", { account_code: "1110" });
    const result = resultOf(body);
    expect(body["error"]).toBeUndefined();
    expect(result["isError"]).toBe(true);
    expect(structured(body)["error"]).toBe("ACCOUNT_NOT_FOUND");
  });

  it("reports bad arguments as a protocol error, because the tool never ran", async () => {
    const h = harness();
    const body = await h.call("get_balance", { as_of_value_date: "not-a-date" });
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(INVALID_PARAMS);
  });

  it("refuses an unknown tool and names the ones that exist", async () => {
    const h = harness();
    const body = await h.call("approve_payment", {});
    const error = body["error"] as Record<string, unknown>;
    expect(error["code"]).toBe(INVALID_PARAMS);
    expect(JSON.stringify(error["data"])).toContain("initiate_payment");
  });

  it("queues a payment end to end and never reports it as paid", async () => {
    const h = harness();
    const body = await h.call("initiate_payment", {
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
    });
    const data = structured(body);
    expect(data["status"]).toBe("queued_for_human_approval");
    expect(data["money_moved"]).toBe(false);
    expect(String((resultOf(body)["content"] as Record<string, unknown>[])[0]?.["text"])).toContain(
      "NO MONEY HAS MOVED",
    );
  });
});

// ---------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------

describe("rate limiting", () => {
  it("throttles a token past its budget with 429 and Retry-After", async () => {
    const h = harness({
      config: JSON.stringify([
        {
          label: "slow",
          token: TOKEN_A,
          actorId: AGENT_ACTOR,
          businessId: BUSINESS_A,
          rateLimitPerMinute: 3,
        },
      ]),
    });
    for (let i = 0; i < 3; i += 1) {
      expect((await h.post({ jsonrpc: "2.0", id: i, method: "ping" })).status).toBe(200);
    }
    const throttled = await h.post({ jsonrpc: "2.0", id: 99, method: "ping" });
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await throttled.json()) as Record<string, unknown>;
    expect((body["error"] as Record<string, unknown>)["code"]).toBe(RATE_LIMITED);
  });

  it("holds the write budget far below the read budget", async () => {
    const h = harness();
    const payment = (n: number) => ({
      rail: "ach",
      amount_cents: "1000",
      destination: {
        type: "ach",
        holder_name: "Northwind Components LLC",
        routing_number: "021000021",
        account_number_last4: "6789",
        account_type: "checking",
      },
      reason: `Invoice INV-${n} for the September machining run`,
      idempotency_key: `invoice-INV-${n}`,
    });

    for (let i = 0; i < WRITE_LIMIT_PER_MINUTE; i += 1) {
      const body = await h.call("initiate_payment", payment(i));
      expect(resultOf(body)["isError"]).toBe(false);
    }
    const refused = await h.call("initiate_payment", payment(999));
    expect((refused["error"] as Record<string, unknown>)["code"]).toBe(RATE_LIMITED);

    // Reads keep working: the write budget is about the approver's attention,
    // not about the token being untrusted.
    const read = await h.call("get_balance", {});
    expect(resultOf(read)["isError"]).toBe(false);
  });

  it("brakes repeated failed authentication by client address", async () => {
    const h = harness();
    let sawThrottle = false;
    for (let i = 0; i < 25; i += 1) {
      const response = await h.post(
        { jsonrpc: "2.0", id: i, method: "ping" },
        { token: `corgi_mcp_guess_${String(i).padStart(16, "0")}` },
      );
      if (response.status === 429) sawThrottle = true;
    }
    expect(sawThrottle).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

describe("the audit log", () => {
  it("records every successful call with tool, arguments, actor and outcome", async () => {
    const h = harness();
    await h.call("get_balance", { account_code: "2100" });

    const record = h.audit.records.at(-1);
    expect(record?.method).toBe("tools/call");
    expect(record?.tool).toBe("get_balance");
    expect(record?.outcome).toBe("ok");
    expect(record?.actorId).toBe(AGENT_ACTOR);
    expect(record?.businessId).toBe(BUSINESS_A);
    expect(record?.grantLabel).toBe("ridgeline-agent");
    expect(record?.argumentsRedacted).toEqual({ account_code: "2100" });
    expect(record?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("records refusals too, including the ones that never reached a tool", async () => {
    const h = harness();
    await h.post({ jsonrpc: "2.0", id: 1, method: "ping" }, { token: null });
    const record = h.audit.records.at(-1);
    expect(record?.outcome).toBe("refused");
    expect(record?.errorCode).toBe("NO_TOKEN");
    expect(record?.actorId).toBeNull();
  });

  it("records a malformed body", async () => {
    const h = harness();
    const server = createMcpServer({
      gateway: h.gateway,
      config: parseTokenConfig(tokens()),
      audit: h.audit,
      log: logger({ level: "error", emit: () => {} }),
    });
    await server.handlePost(
      new Request(URL, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN_A}`, "content-type": "application/json" },
        body: "{oops",
      }),
    );
    const record = h.audit.records.at(-1);
    expect(record?.outcome).toBe("protocol_error");
  });

  it("redacts the account number and keeps the routing number", async () => {
    const h = harness();
    await h.call("initiate_payment", {
      rail: "ach",
      amount_cents: "1000",
      destination: {
        type: "ach",
        holder_name: "Northwind Components LLC",
        routing_number: "021000021",
        account_number_last4: "9012",
        account_type: "checking",
      },
      reason: "Invoice INV-9001 for the September machining run",
      idempotency_key: "invoice-INV-9001",
    });
    const record = h.audit.records.at(-1);
    const destination = (record?.argumentsRedacted?.["destination"] ?? {}) as Record<string, unknown>;
    // The surface never receives a full account number in the first place, so
    // the redactor's job here is only to keep the last four legible.
    expect(destination["account_number_last4"]).toBe("9012");
    expect(destination["routing_number"]).toBe("021000021");
    expect(destination["holder_name"]).toBe("Northwind Components LLC");
  });

  it("carries the instruction id on a write so the log walks to the queue", async () => {
    const h = harness();
    const body = await h.call("initiate_payment", {
      rail: "ach",
      amount_cents: "1000",
      destination: {
        type: "ach",
        holder_name: "Northwind Components LLC",
        routing_number: "021000021",
        account_number_last4: "9012",
        account_type: "checking",
      },
      reason: "Invoice INV-9002 for the September machining run",
      idempotency_key: "invoice-INV-9002",
    });
    const record = h.audit.records.at(-1);
    expect(record?.result?.["instruction_id"]).toBe(structured(body)["instruction_id"]);
    expect(record?.result?.["money_moved"]).toBe(false);
  });

  it("records a tool refusal with its code", async () => {
    const h = harness();
    await h.call("get_balance", { account_code: "1110" });
    const record = h.audit.records.at(-1);
    expect(record?.outcome).toBe("tool_error");
    expect(record?.errorCode).toBe("ACCOUNT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------
// Transport hardening
// ---------------------------------------------------------------------

describe("transport", () => {
  it("refuses a cross-site Origin", async () => {
    const h = harness();
    const response = await h.post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { origin: "https://evil.example" } },
    );
    expect(response.status).toBe(403);
  });

  it("allows same origin and loopback", () => {
    expect(originAllowed("http://localhost:3000", URL)).toBe(true);
    expect(originAllowed("http://127.0.0.1:5173", URL)).toBe(true);
    expect(originAllowed("https://evil.example", URL)).toBe(false);
    expect(originAllowed("not a url", URL)).toBe(false);
  });

  it("refuses an oversized body before reading it", async () => {
    const h = harness();
    const response = await h.post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { "content-length": String(10 * 1024 * 1024) } },
    );
    expect(response.status).toBe(413);
  });

  it("always answers with no-store and a request id", async () => {
    const h = harness();
    const response = await h.post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    expect(response.headers.get("mcp-protocol-version")).toBe(LATEST_PROTOCOL_VERSION);
  });

  it("honours an inbound x-request-id so a trace survives the edge", async () => {
    const h = harness();
    const response = await h.post(
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { headers: { "x-request-id": "req_from_client" } },
    );
    expect(response.headers.get("x-request-id")).toBe("req_from_client");
  });
});
