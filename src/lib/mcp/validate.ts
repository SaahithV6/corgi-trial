/**
 * Argument parsing and money rendering shared by the four tools.
 *
 * TWO DECISIONS WORTH THE WORDS.
 *
 * 1. AMOUNTS CROSS THE WIRE AS DECIMAL STRINGS OF CENTS, never as JSON
 *    numbers. `JSON.parse` produces a double, and a double stops being able to
 *    represent consecutive integers above 2^53 — about $90 trillion in cents,
 *    which is not a fantasy figure for a gross settlement total. There is no
 *    warning when it happens; the number simply comes back different. The rest
 *    of this codebase is `bigint` cents end to end, and the wire format is the
 *    one place that discipline could be quietly dropped, so it is not dropped.
 *    Every money field in and out of these tools is a string.
 *
 * 2. EVERY INPUT SCHEMA IS STRICT (`additionalProperties: false`). An unknown
 *    argument is refused rather than ignored. A model that hallucinates
 *    `"business_id": "..."` should be told plainly that no such parameter
 *    exists, not silently served its own tenant's data and left believing the
 *    parameter worked — the next call it writes will be the dangerous one.
 */

import { z } from "zod";

import { formatUsd } from "@/lib/format/money";

import { ToolError } from "./types";

/** Parse tool arguments, converting a zod failure into a readable refusal. */
export function parseArgs<T>(schema: z.ZodType<T>, args: Record<string, unknown>): T {
  const result = schema.safeParse(args);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => ({
    field: issue.path.length === 0 ? "(root)" : issue.path.join("."),
    problem: issue.message,
  }));
  const first = problems[0];
  throw new ToolError(
    "INVALID_ARGUMENTS",
    first === undefined
      ? "arguments did not validate"
      : `invalid arguments: ${first.field} — ${first.problem}`,
    { problems },
  );
}

/** A positive integer count of cents, as a decimal string. Max 16 digits. */
export const centsString = z
  .string()
  .regex(/^[1-9][0-9]{0,15}$/, {
    error:
      "amount must be a positive integer number of CENTS as a decimal string, e.g. \"125000\" for $1,250.00 — not dollars, not a JSON number",
  });

export const isoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "expected a date as YYYY-MM-DD" })
  .refine(
    (v) => {
      const parsed = new Date(`${v}T00:00:00Z`);
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
    },
    { error: "not a real calendar date" },
  );

export const isoInstantString = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), {
    error: "expected an ISO 8601 instant, e.g. 2026-09-10T18:30:00Z",
  });

/** Chart-of-accounts code. Four digits, and never a uuid. */
export const accountCodeString = z
  .string()
  .regex(/^[0-9]{4}$/, {
    error:
      "account_code is a four-digit chart-of-accounts code such as \"2100\"; account uuids are not accepted by this surface",
  });

export interface Money {
  readonly cents: string;
  readonly display: string;
}

/** The one shape every money field in every tool result takes. */
export function money(cents: bigint): Money {
  return { cents: cents.toString(), display: formatUsd(cents) };
}

/** JSON Schema fragment for a `Money`, so output schemas stay consistent. */
export const MONEY_SCHEMA = {
  type: "object",
  properties: {
    cents: {
      type: "string",
      description: "Signed integer cents as a decimal string. Never a JSON number.",
    },
    display: { type: "string", description: "Formatted USD, e.g. -$1,234.56." },
  },
  required: ["cents", "display"],
  additionalProperties: false,
} as const;
