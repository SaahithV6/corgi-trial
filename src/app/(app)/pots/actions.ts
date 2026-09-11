"use server";

/**
 * The pots screen's two write paths.
 *
 * ============================================================================
 * WHAT THESE ACTIONS DO, AND WHAT THEY DO NOT.
 *
 * THEY DO:
 *   - open a real ledger account under the customer's own deposit leaf, through
 *     `pot_open()`, and
 *   - post ONE real journal entry through `postEntry()` — two lines, `bigint`
 *     cents, double-entry, append-only, hash-chained, to the live database.
 *
 * THEY DO NOT:
 *   - call any provider, transmit anything to any rail, or create anything
 *     that a webhook could later contradict. An internal transfer's whole
 *     nature is that there is no third party: `rail = 'internal'`,
 *     `external_ref` NULL, `inbox_id` NULL, `hold_id` NULL. It is instant
 *     because nothing is being waited for, not because anything was skipped.
 *   - go through maker-checker. §16's threshold is on the MONEY-OUT path and
 *     this path has none: after the entry the bank owes the customer exactly
 *     what it owed before, to the cent, and they can move it straight back.
 *     Requiring a second approver for a transfer that cannot lose anybody money
 *     trains people to click through approvals, which is the failure mode
 *     maker-checker exists to prevent.
 *
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Everything in the `FormData` is a
 * claim and every claim is re-validated here and again in the database:
 *
 *   potId       a REFERENCE. Resolved against `pot` by `findPot()`, which
 *               returns null rather than reaching Postgres with a non-uuid.
 *               The two account ids the transfer hits are taken from the row
 *               it returns and from `account.parent_id` — never from the form.
 *   businessId  likewise a reference, resolved inside `pot_open()`, which
 *               reads the entity, the currency and the parent from the
 *               customer's own deposit leaf so a pot cannot be opened in the
 *               wrong book or under somebody else's business.
 *   amount      parsed from a decimal string to `bigint` cents HERE, by
 *               integer string arithmetic. No `parseFloat`, no `* 100`.
 *   reference   the SOURCE FACT the idempotency key is built from. Submitting
 *               the same reference twice books ONE transfer, decided by a
 *               UNIQUE index rather than by an `if`.
 *
 * The posting identity is NOT taken from the form: the actor is the
 * `ledger-poster` system actor, resolved by name in the store. The console's
 * role cookie is documented as a demo affordance and not an authorisation
 * boundary, and attributing a journal entry to a human this endpoint cannot
 * authenticate would put a lie in the audit trail.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formatUsd } from "@/lib/format/money";
import { MOVE_DIRECTIONS, type MoveDirection } from "@/lib/pots/model";
import { movePotFunds, openPot } from "@/lib/pots/transfer";

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type Issue = { readonly path: string; readonly message: string };

export type OpenPotResult = {
  readonly status: "idle" | "opened" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  readonly potId: string | null;
  readonly accountCode: string | null;
};

export type MovePotResult = {
  readonly status: "idle" | "posted" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  readonly receipt: MoveReceiptView | null;
};

/** The receipt, as strings. Formatted on the server; the browser does no maths. */
export type MoveReceiptView = {
  readonly entryId: string;
  readonly bookingSeq: string;
  readonly valueDate: string;
  readonly idempotencyKey: string;
  readonly rail: string;
  readonly potName: string;
  readonly direction: MoveDirection;
  readonly amount: string;
  readonly replay: boolean;
  readonly before: BalanceLineView;
  readonly after: BalanceLineView;
};

export type BalanceLineView = {
  readonly main: string;
  readonly pot: string;
  readonly pots: string;
  readonly total: string;
  readonly available: string;
  readonly holds: string;
  readonly uncleared: string;
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A plain USD amount to `bigint` cents, by integer string arithmetic.
 *
 * Returns `null` for anything that is not one — a negative sign, three decimal
 * places, an exponent, an empty string. The caller renders that as a refusal
 * rather than guessing what was meant.
 *
 * Not exported: a `"use server"` module may only export async functions, and
 * this one has no business being reachable from a browser anyway.
 */
function parseUsdToCents(raw: string): bigint | null {
  const cleaned = raw.trim().replaceAll(",", "").replace(/^\$/, "");
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(cleaned)) return null;

  const dot = cleaned.indexOf(".");
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fraction = dot === -1 ? "" : cleaned.slice(dot + 1);

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
}

const openSchema = z.object({
  businessId: z.string().trim().min(1, { error: "choose the customer" }),
  name: z
    .string()
    .trim()
    .min(1, { error: "name the pot — it is how somebody refers to this money" })
    .max(60, { error: "60 characters at most" }),
  purpose: z.string().trim().max(280).optional(),
});

const moveSchema = z.object({
  potId: z.string().trim().min(1, { error: "choose a pot" }),
  direction: z.enum(MOVE_DIRECTIONS, { error: "choose a direction" }),
  amount: z.string().trim().min(1, { error: "enter an amount" }),
  /**
   * The SOURCE FACT. The idempotency key is derived from it, so submitting the
   * same reference twice books ONE transfer. Constrained to a shape that
   * survives being pasted into a log line and a URL.
   */
  reference: z
    .string()
    .trim()
    .min(3, { error: "reference what this transfer is for" })
    .max(120)
    .regex(/^[A-Za-z0-9._/#-]+$/, {
      error: "letters, digits and . _ / # - only, and no spaces or colons",
    }),
});

function issuesOf(error: z.ZodError): readonly Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(form)",
    message: issue.message,
  }));
}

/* -------------------------------------------------------------------------- */
/* Open a pot                                                                 */
/* -------------------------------------------------------------------------- */

export async function openPotAction(
  _previous: OpenPotResult,
  formData: FormData,
): Promise<OpenPotResult> {
  const parsed = openSchema.safeParse({
    businessId: formData.get("businessId") ?? "",
    name: formData.get("name") ?? "",
    purpose: formData.get("purpose") ?? undefined,
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message:
        "The form could not be read, so nothing was sent to the database and no account was opened.",
      issues: issuesOf(parsed.error),
      potId: null,
      accountCode: null,
    };
  }

  const result = await openPot({
    businessId: parsed.data.businessId,
    name: parsed.data.name,
    purpose: parsed.data.purpose ?? null,
  });

  if (result.kind === "refused") {
    return {
      status: "refused",
      code: result.code,
      message: result.reason,
      issues: null,
      potId: null,
      accountCode: null,
    };
  }

  revalidatePath("/pots");
  return {
    status: "opened",
    code: null,
    message: `Pot “${parsed.data.name}” opened. It is a real account in the chart, coded ${result.accountCode}, parented on this customer's own 2100 deposit leaf — and it holds $0.00 until an internal transfer puts something in it.`,
    issues: null,
    potId: result.potId,
    accountCode: result.accountCode,
  };
}

/* -------------------------------------------------------------------------- */
/* Move money                                                                 */
/* -------------------------------------------------------------------------- */

export async function movePotAction(
  _previous: MovePotResult,
  formData: FormData,
): Promise<MovePotResult> {
  const parsed = moveSchema.safeParse({
    potId: formData.get("potId") ?? "",
    direction: formData.get("direction") ?? "",
    amount: formData.get("amount") ?? "",
    reference: formData.get("reference") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message:
        "The form could not be read, so nothing was sent to the database and no entry was posted.",
      issues: issuesOf(parsed.error),
      receipt: null,
    };
  }

  const amountCents = parseUsdToCents(parsed.data.amount);
  if (amountCents === null) {
    return {
      status: "refused",
      code: "BAD_AMOUNT",
      message:
        "That is not a plain USD amount. Cents, two decimal places at most, no sign — the direction says which way the money goes.",
      issues: [{ path: "amount", message: "e.g. 12000.00" }],
      receipt: null,
    };
  }

  const result = await movePotFunds({
    potId: parsed.data.potId,
    direction: parsed.data.direction,
    amountCents,
    reference: parsed.data.reference,
  });

  if (result.kind === "refused") {
    return {
      status: "refused",
      code: result.code,
      message: result.reason,
      issues: null,
      receipt: null,
    };
  }

  revalidatePath("/pots");

  const r = result.receipt;
  return {
    status: "posted",
    code: null,
    message: r.replay
      ? `Already posted. The idempotency key ${r.idempotencyKey} is UNIQUE on journal_entry, so this submission wrote nothing and the entry below is the one that already existed. Twice is one.`
      : `Posted. One journal entry, two lines, rail = internal. No provider was called and nothing is pending: the balances below are already final.`,
    issues: null,
    receipt: {
      entryId: r.entryId,
      bookingSeq: r.bookingSeq,
      valueDate: r.valueDate,
      idempotencyKey: r.idempotencyKey,
      rail: r.rail,
      potName: r.potName,
      direction: r.direction,
      amount: formatUsd(r.amountCents),
      replay: r.replay,
      before: {
        main: formatUsd(r.before.mainCents),
        pot: formatUsd(r.before.potCents),
        pots: formatUsd(r.before.potsCents),
        total: formatUsd(r.before.totalCents),
        available: formatUsd(r.before.availableCents),
        holds: formatUsd(r.before.holdsCents),
        uncleared: formatUsd(r.before.unclearedCents),
      },
      after: {
        main: formatUsd(r.after.mainCents),
        pot: formatUsd(r.after.potCents),
        pots: formatUsd(r.after.potsCents),
        total: formatUsd(r.after.totalCents),
        available: formatUsd(r.after.availableCents),
        holds: formatUsd(r.after.holdsCents),
        uncleared: formatUsd(r.after.unclearedCents),
      },
    },
  };
}
