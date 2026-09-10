import { describe, expect, it } from "vitest";

import { FORBIDDEN_PARAMETER_NAMES, READ_TOOLS, TOOLS, WRITE_TOOLS, findTool } from "./tools";
import { ToolError, type JsonSchemaObject } from "./types";

/** Every property name anywhere in a schema, however deeply nested. */
function propertyNames(schema: unknown, found: string[] = []): string[] {
  if (schema === null || typeof schema !== "object") return found;
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, found);
    return found;
  }
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      found.push(...Object.keys(value as Record<string, unknown>));
    }
    propertyNames(value, found);
  }
  return found;
}

describe("the registry", () => {
  it("is exactly three read tools and one write tool", () => {
    expect(TOOLS).toHaveLength(4);
    expect(READ_TOOLS.map((t) => t.name)).toEqual([
      "get_balance",
      "list_transactions",
      "list_recon_breaks",
    ]);
    expect(WRITE_TOOLS.map((t) => t.name)).toEqual(["initiate_payment"]);
  });

  it("has unique names and finds them", () => {
    expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    expect(findTool("get_balance")?.name).toBe("get_balance");
    expect(findTool("approve_payment")).toBeUndefined();
    expect(findTool("release_payment")).toBeUndefined();
  });

  it("exposes no approval, release or ledger-write operation", () => {
    // The interesting property of this surface is the size of the set. If a
    // fifth tool arrives, it must be argued for in docs/AGENT-LIMITS.md first.
    const banned = [
      "approve",
      "reject",
      "release",
      "submit",
      "cancel",
      "post_entry",
      "post_journal",
      "adjust",
      "close_book",
      "rotate",
      "freeze",
      "unfreeze",
      "issue_card",
      "set_threshold",
    ];
    for (const tool of TOOLS) {
      for (const word of banned) {
        expect(tool.name.includes(word)).toBe(false);
      }
    }
  });
});

describe("annotations are honest", () => {
  it("marks the three readers read-only and the writer not", () => {
    for (const tool of READ_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.readOnly).toBe(true);
    }
    for (const tool of WRITE_TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(false);
      expect(tool.readOnly).toBe(false);
    }
  });

  it("marks nothing destructive and nothing open-world", () => {
    for (const tool of TOOLS) {
      // Nothing here overwrites or deletes: the write tool appends a request
      // to an append-only queue, and the ledger is unreachable from here.
      expect(tool.annotations.destructiveHint).toBe(false);
      // No tool reaches a third party. Every one of them talks to our own
      // Postgres and nothing else.
      expect(tool.annotations.openWorldHint).toBe(false);
      expect(tool.annotations.idempotentHint).toBe(true);
    }
  });

  it("keeps the annotation title and the tool title in step", () => {
    for (const tool of TOOLS) expect(tool.annotations.title).toBe(tool.title);
  });
});

describe("the tenant boundary, asserted over every schema", () => {
  it("declares no parameter that could name another business, account or actor", () => {
    // This is the scoping guarantee written as a test. Scope comes from the
    // token; if a future tool adds an `account_id` or a `business_id`, it
    // fails here rather than in production.
    for (const tool of TOOLS) {
      const names = propertyNames(tool.inputSchema);
      for (const forbidden of FORBIDDEN_PARAMETER_NAMES) {
        expect(
          names.includes(forbidden),
          `${tool.name} must not accept "${forbidden}"`,
        ).toBe(false);
      }
    }
  });

  it("accepts account_code, which is scoped by construction", () => {
    // A four-digit chart code is only meaningful inside one business's chart,
    // so it cannot address another tenant's row even if guessed.
    const names = propertyNames(findTool("get_balance")?.inputSchema);
    expect(names).toContain("account_code");
  });
});

describe("input schemas", () => {
  it("are strict objects with a declared draft", () => {
    for (const tool of TOOLS) {
      const schema = tool.inputSchema as JsonSchemaObject;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema.$schema).toContain("json-schema.org");
    }
  });

  it("refuse an unknown argument at parse time, not just in the schema text", () => {
    for (const tool of TOOLS) {
      expect(() => tool.parse({ business_id: "e274546d-6bdd-5266-b0fb-cc839a7811f9" })).toThrow(
        ToolError,
      );
    }
  });

  it("describe every declared property", () => {
    for (const tool of TOOLS) {
      for (const [name, spec] of Object.entries(tool.inputSchema.properties)) {
        const described =
          typeof spec === "object" &&
          spec !== null &&
          ("description" in spec || "oneOf" in spec || "anyOf" in spec);
        expect(described, `${tool.name}.${name} needs a description`).toBe(true);
      }
    }
  });

  it("declares an output schema for every tool", () => {
    for (const tool of TOOLS) {
      expect(tool.outputSchema, `${tool.name} needs an outputSchema`).toBeDefined();
    }
  });
});

describe("descriptions tell a model the things it will otherwise get wrong", () => {
  it("says plainly that the write tool does not pay", () => {
    const tool = findTool("initiate_payment");
    expect(tool?.description).toMatch(/HUMAN APPROVAL/);
    expect(tool?.description).toMatch(/does not pay/i);
    expect(tool?.description).toMatch(/cannot approve/i);
  });

  it("says the readers are scoped to one business", () => {
    for (const tool of READ_TOOLS) {
      expect(tool.description).toMatch(/scoped to the single business/i);
    }
  });
});

describe("initiate_payment argument validation", () => {
  const tool = findTool("initiate_payment");

  const valid = {
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
  };

  it("accepts a well-formed ACH instruction", () => {
    expect(() => tool?.parse(valid)).not.toThrow();
  });

  it("refuses the card and internal rails", () => {
    // card is not an origination rail; internal book transfers carry a
    // zero-approval policy, which would make them the one thing on this
    // surface that could move without a human.
    for (const rail of ["card", "internal"]) {
      expect(() => tool?.parse({ ...valid, rail })).toThrow(ToolError);
    }
  });

  it("refuses an amount expressed in dollars or as a number", () => {
    expect(() => tool?.parse({ ...valid, amount_cents: "1250.00" })).toThrow(ToolError);
    expect(() => tool?.parse({ ...valid, amount_cents: 125000 })).toThrow(ToolError);
    expect(() => tool?.parse({ ...valid, amount_cents: "0" })).toThrow(ToolError);
    expect(() => tool?.parse({ ...valid, amount_cents: "-500" })).toThrow(ToolError);
  });

  it("refuses a destination of the wrong shape for the rail", () => {
    expect(() => tool?.parse({ ...valid, rail: "usdc" })).toThrow(ToolError);

    expect(() =>
      tool?.parse({
        ...valid,
        rail: "ach",
        destination: {
          type: "usdc",
          address: "0x0000000000000000000000000000000000000001",
          chain: "base-sepolia",
        },
      }),
    ).toThrow(ToolError);
  });

  it("refuses a FULL account number — only the last four are accepted", () => {
    // The approver checks a beneficiary against the last four. Handing an
    // agent the other digits creates exfiltration risk and buys nothing.
    expect(() =>
      tool?.parse({
        ...valid,
        destination: { ...valid.destination, account_number_last4: "123456789" },
      }),
    ).toThrow(ToolError);
    expect(() =>
      tool?.parse({
        ...valid,
        destination: { ...valid.destination, account_number: "123456789" },
      }),
    ).toThrow(ToolError);
  });

  it("refuses a malformed routing number or EVM address", () => {
    expect(() =>
      tool?.parse({
        ...valid,
        destination: { ...valid.destination, routing_number: "12345" },
      }),
    ).toThrow(ToolError);

    expect(() =>
      tool?.parse({
        ...valid,
        rail: "usdc",
        destination: { type: "usdc", address: "0xnope", chain: "base-sepolia" },
      }),
    ).toThrow(ToolError);
  });

  it("requires a reason a human can act on", () => {
    expect(() => tool?.parse({ ...valid, reason: "pay" })).toThrow(ToolError);
  });

  it("requires an idempotency key", () => {
    const { idempotency_key: _dropped, ...withoutKey } = valid;
    expect(() => tool?.parse(withoutKey)).toThrow(ToolError);
  });
});
