"use server";

/**
 * The payments screen's write path — the one route in this application from
 * which `requestPayment()` can be reached by a person.
 *
 * ============================================================================
 * WHAT THIS ACTION DOES AND DOES NOT DO.
 *
 * It writes ONE `payment_instruction` row and ONE `requested` event, inside one
 * transaction, through `src/lib/approvals/instructions.ts`. That is all. It
 * does not call `postEntry()`, it does not touch `journal_entry` or
 * `journal_line`, it does not import `src/lib/ledger/post.ts`, and it cannot
 * release anything. Raising an instruction is not posting money — the money
 * moves when a human presses Release on `/approvals`, and until then this
 * screen has produced a request in a queue and nothing else.
 *
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Everything in the `FormData` is a
 * claim, and every claim is re-validated on the way in:
 *
 *   accountId    a REFERENCE. The KYB gate is re-read from the database inside
 *                `requestPayment()`'s transaction against this id; nothing the
 *                browser said about the account's state is believed, and the
 *                browser is not asked.
 *   amount       parsed from a decimal string to `bigint` cents HERE, by
 *                integer string arithmetic. See `parseUsdToCents`. The client
 *                sends the characters a person typed and performs no
 *                arithmetic on them, because a client that can compute an
 *                amount is a client that can compute the wrong one.
 *   rail, dates, destination
 *                shaped here, then handed to `requestPaymentSchema`, which is
 *                the real validator and refuses in exactly the same way for
 *                this form as it does for the MCP write tool. There is one
 *                schema and one entry point; this screen is not a second path.
 *
 * The identity is NOT taken from the form. The actor id is resolved on the
 * server from the session (today: the demo role cookie, resolved by predicate
 * — see `lib/approvals/session.ts`). A caller who POSTs an `actorId` field
 * changes nothing, because no field of that name is read.
 *
 * NO REFUSAL IS SWALLOWED. Whatever `requestPayment()` returns — a zod
 * `INVALID_REQUEST` with its field paths, `POLICY_MISSING`, or a KYB gate code
 * (`KYB_NOT_STARTED`, `KYB_PENDING`, `KYB_NEEDS_REVIEW`, `KYB_REJECTED`,
 * `KYB_EVIDENCE_SIMULATED`, `KYB_STATE_UNREADABLE`) — is passed to the screen
 * with its code and its own sentence. A generic "something went wrong" on a
 * money screen is a bug report nobody can file.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { PAYOUT_RAILS, type PaymentDestination } from "@/lib/approvals/types";
import { formatUsd } from "@/lib/format/money";
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the module for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";
import { rootLogger } from "@/lib/log";

/**
 * WHY `instructions` AND `session` ARE NOT IMPORTED AT THE TOP OF THIS FILE.
 *
 * Both reach `@/lib/ledger/db` -> `@/lib/env`, which parses `process.env` at
 * module scope and throws `EnvironmentError` without `APP_DATABASE_URL`.
 * `PaymentForm` imports `raisePaymentAction` from here and `PaymentsView`
 * imports `PaymentForm` — so on a deployment with no database this module's
 * imports are a second static route from the page to a throw, beside the one
 * that was actually measured. Under the app router the client boundary at
 * `PaymentForm` usually stops the server from evaluating it; "usually" is not a
 * property a screen should depend on to render the words "no database
 * configured", and nothing outside a bundler stops it at all.
 *
 * They are imported inside the action instead, on the branch that has already
 * established there is a database to write to. The action is a POST, and a POST
 * to this screen on a deployment with no database is refused below with a code
 * rather than an exception — see `PAYMENTS_NO_DATABASE` — because a server
 * action that throws gives an operator an error boundary and no sentence.
 */

/* -------------------------------------------------------------------------- */
/* What the form gets back                                                    */
/* -------------------------------------------------------------------------- */

/** One field-level complaint from zod, flattened. Never contains a row value. */
export type FieldIssue = {
  readonly path: string;
  readonly message: string;
};

/**
 * The proof that something was queued.
 *
 * Every figure here is a string that the SERVER formatted from the values
 * `requestPayment()` returned. Nothing on this type is a number the browser
 * could be tempted to do arithmetic on.
 */
export type Receipt = {
  readonly instructionId: string;
  readonly contentHash: string;
  /** The policy row the instruction PINS — `policy_id` on the row itself. */
  readonly policyId: string;
  readonly policyVersion: string;
  readonly thresholdDisplay: string;
  readonly policyNote: string;
  readonly amountDisplay: string;
  readonly rail: string;
  readonly valueDate: string;
  readonly approvalsRequired: number;
  /** `approvalsRequired > 0` — i.e. this payment needs a checker. */
  readonly needsApproval: boolean;
  /**
   * The pinned threshold is ZERO, so there is no band and nothing was
   * "reached".
   *
   * Computed on the server from `policy.thresholdCents === 0n`, because that
   * is where the `bigint` is. The receipt used to say "this amount reached the
   * {threshold} threshold" in every approval case, which on the wire rail
   * renders as "$42.00 reached the $0.00 threshold" — true, and nonsense. A
   * threshold prices the band BELOW which an agent may act unattended, and
   * that band exists only where a mistake inside it is recoverable: ACH draws
   * one at $2,500 because an ACH entry is recallable for two banking days. A
   * wire has no such mechanism at any amount, so the threshold is at the floor
   * and the reason is not the size of the payment.
   */
  readonly thresholdIsFloor: boolean;
  /** False when this idempotency key had already been queued. Nothing new was written. */
  readonly created: boolean;
};

export type RaiseResult = {
  readonly status: "idle" | "ok" | "refused";
  /** The refusal code verbatim, or `REQUESTED` on success. */
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly FieldIssue[] | null;
  readonly receipt: Receipt | null;
};

/* -------------------------------------------------------------------------- */
/* Money in, from a text field                                                */
/* -------------------------------------------------------------------------- */

/**
 * `"2,500.00"` -> `250000n`. The ONLY place a typed amount becomes money.
 *
 * Integer string arithmetic, on purpose and without apology: there is no
 * `parseFloat`, no `Number(...)`, no `* 100`. `Number("0.1") * 100` is
 * `10.000000000000002`, and a payments desk that rounds that has just invented
 * a cent. The whole part and the fractional part are separated as TEXT, padded
 * as TEXT, and each converted straight to `bigint`.
 *
 * Returns `null` for anything that is not a plain USD amount — a negative sign,
 * three decimal places, an exponent, a currency symbol, an empty string. The
 * caller renders that as a refusal rather than guessing what was meant.
 *
 * Not exported: a `"use server"` module may only export async functions, and
 * this one has no business being called from a browser anyway.
 */
function parseUsdToCents(raw: string): bigint | null {
  const cleaned = raw.trim().replaceAll(",", "").replace(/^\$/, "");
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(cleaned)) return null;

  const dot = cleaned.indexOf(".");
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fraction = dot === -1 ? "" : cleaned.slice(dot + 1);

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
}

/* -------------------------------------------------------------------------- */
/* The form's shape                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The FORM's schema, which is not the payment's schema.
 *
 * This one only has to get the browser's strings into the right slots.
 * `requestPaymentSchema` — the same object the MCP tool is validated against —
 * decides whether what came out is a payment this bank can make, and its
 * refusal is the one rendered. Duplicating its rules here would create a second
 * place they could drift.
 */
const formSchema = z.object({
  accountId: z.string().trim().min(1, { error: "choose the account the money leaves" }),
  rail: z.enum(PAYOUT_RAILS, { error: "choose a rail" }),
  amount: z.string().trim().min(1, { error: "enter an amount" }),
  valueDate: z.string().trim().min(1, { error: "enter a value date" }),
  /**
   * The SOURCE FACT. An invoice number, a payroll run id — the thing that
   * caused this payment to exist. It is not stored on the instruction (there is
   * no column for it); it is what the idempotency key is derived from, so
   * submitting the same invoice twice returns the first instruction instead of
   * queueing a second payment to the same supplier.
   */
  reference: z
    .string()
    .trim()
    .min(3, { error: "reference the invoice, payroll run or ticket this pays" })
    .max(120)
    .regex(/^[A-Za-z0-9._:/#-]+(?: [A-Za-z0-9._:/#-]+)*$/, {
      error: "letters, digits, spaces and . _ : / # - only",
    }),

  holderName: z.string().trim().max(140).optional(),
  routingNumber: z.string().trim().max(40).optional(),
  /**
   * The WIRE variant of the ABA, which is a different number from the same
   * bank's ACH variant — `021000021` versus `011401533` on the seeded Plaid
   * item. Carried under its own name rather than reusing `routingNumber`
   * because the mistake this rail actually suffers is substituting one for the
   * other, and a field that accepts both names accepts the substitution in
   * silence. Loose here, like every other field on this schema;
   * `destinationSchema` is the validator.
   */
  wireRoutingNumber: z.string().trim().max(40).optional(),
  accountNumberLast4: z.string().trim().max(10).optional(),
  accountType: z.string().trim().max(20).optional(),
  bic: z.string().trim().max(40).optional(),
  chain: z.string().trim().max(40).optional(),
  address: z.string().trim().max(200).optional(),
  internalAccountId: z.string().trim().max(80).optional(),
});

type FormFields = z.infer<typeof formSchema>;

/**
 * Assemble the `counterparty` jsonb from the fields the chosen rail uses.
 *
 * Deliberately unvalidated beyond "put the strings in the right keys".
 * `destinationSchema` is a discriminated union with real rules — nine digits of
 * routing number, four of account number, a chain from a fixed list — and it
 * runs inside `requestPayment()`. Pre-checking here would either duplicate
 * those rules or, worse, quietly repair a value before the real validator saw
 * it. A malformed destination must be REFUSED, not fixed.
 */
function buildDestination(fields: FormFields): unknown {
  const holderName = fields.holderName ?? "";
  switch (fields.rail) {
    case "ach":
      return {
        type: "ach",
        holderName,
        routingNumber: fields.routingNumber ?? "",
        accountNumberLast4: fields.accountNumberLast4 ?? "",
        accountType: fields.accountType ?? "",
      };
    case "wire":
      // THE WIRE ABA IS THE ADDRESS; THE BIC IS AN EXTRA, AND IT USED TO BE
      // THE ONLY ONE. A BIC identifies a bank on the SWIFT network and Fedwire
      // does not read it, so with only a BIC on the destination there was
      // nothing for `gatePaymentOnPayee()` to run the check digit over and
      // nothing to match against the payee book — a wire got neither check, on
      // the one rail that cannot recall money.
      //
      // Both keys are OMITTED rather than sent empty when the form did not
      // supply them, because both are optional on `destinationSchema` and an
      // empty string is not a missing value: `""` fails the nine-digit regex
      // and would surface as a field error, while `undefined` reaches the
      // gate's own refusal, which says which number is missing and why a BIC
      // is not a substitute for it.
      return {
        type: "wire",
        holderName,
        ...(fields.wireRoutingNumber === undefined || fields.wireRoutingNumber === ""
          ? {}
          : { wireRoutingNumber: fields.wireRoutingNumber }),
        ...(fields.bic === undefined || fields.bic === "" ? {} : { bic: fields.bic }),
        accountNumberLast4: fields.accountNumberLast4 ?? "",
      };
    case "usdc":
      return { type: "usdc", chain: fields.chain ?? "", address: fields.address ?? "" };
    case "internal":
      return { type: "internal", accountId: fields.internalAccountId ?? "", holderName };
  }
}

/** `{path, message}` pairs, if the failure carried any. Never invented. */
function readIssues(details: unknown): readonly FieldIssue[] | null {
  if (!Array.isArray(details)) return null;
  const issues: FieldIssue[] = [];
  for (const item of details) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["path"] !== "string" || typeof record["message"] !== "string") continue;
    issues.push({ path: record["path"], message: record["message"] });
  }
  return issues.length === 0 ? null : issues;
}

/* -------------------------------------------------------------------------- */
/* The action                                                                 */
/* -------------------------------------------------------------------------- */

const QUEUED =
  "Queued for a checker. NO MONEY HAS MOVED and no journal entry exists: this wrote one payment_instruction row and one 'requested' event. Money leaves only when a human presses Release on /approvals, and that is a different call by a different person.";

const REPLAYED =
  "Nothing new was written. This reference had already been queued, so the idempotency key matched an existing instruction and the ORIGINAL was returned — the unique index decided that, not an `if`. Submitting the same invoice twice does not pay a supplier twice.";

/**
 * Raise a payment instruction.
 *
 * Shaped for `useActionState`, so a refusal renders inline under the form with
 * its code, next to the fields that caused it, instead of throwing an
 * unexplained error boundary at somebody halfway through a payment run.
 */
export async function raisePaymentAction(
  _previous: RaiseResult,
  formData: FormData,
): Promise<RaiseResult> {
  const parsed = formSchema.safeParse({
    accountId: formData.get("accountId") ?? "",
    rail: formData.get("rail") ?? "",
    amount: formData.get("amount") ?? "",
    valueDate: formData.get("valueDate") ?? "",
    reference: formData.get("reference") ?? "",
    holderName: formData.get("holderName") ?? undefined,
    routingNumber: formData.get("routingNumber") ?? undefined,
    wireRoutingNumber: formData.get("wireRoutingNumber") ?? undefined,
    accountNumberLast4: formData.get("accountNumberLast4") ?? undefined,
    accountType: formData.get("accountType") ?? undefined,
    bic: formData.get("bic") ?? undefined,
    chain: formData.get("chain") ?? undefined,
    address: formData.get("address") ?? undefined,
    internalAccountId: formData.get("internalAccountId") ?? undefined,
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message:
        "The form could not be read, so nothing was sent to the database and no instruction was raised. Every field below is checked again on the server after this one passes — this is the outer of two gates, not the only one.",
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(form)",
        message: issue.message,
      })),
      receipt: null,
    };
  }

  const fields = parsed.data;
  const log = rootLogger.child({ screen: "payments", rail: fields.rail });

  const amountCents = parseUsdToCents(fields.amount);
  if (amountCents === null) {
    return {
      status: "refused",
      code: "INVALID_AMOUNT",
      message:
        "That is not an amount this system will convert to cents. Amounts are integer minor units; the text you type is turned into a bigint by string arithmetic, and anything with more than two decimal places, a sign, an exponent or a stray character is refused here rather than rounded somewhere further down.",
      issues: [{ path: "amount", message: `could not read "${fields.amount}" as USD` }],
      receipt: null,
    };
  }

  if (!hasDatabase()) {
    // Unreachable from the screen — with no database `/payments` draws the
    // refusal panel and no form, so there is no button to press. It is
    // reachable by a hand-assembled POST, which is the whole reason a server
    // action re-checks everything, and the honest answer is that nothing was
    // written because there was nowhere to write it.
    return {
      status: "refused",
      code: "PAYMENTS_NO_DATABASE",
      message:
        "No database is configured for this deployment, so no instruction was raised, no account was checked against the KYB gate and no policy version was pinned. Nothing was written.",
      issues: null,
      receipt: null,
    };
  }

  const [{ requestPayment }, { currentActor }] = await Promise.all([
    import("@/lib/approvals/instructions"),
    import("@/lib/approvals/session"),
  ]);

  const actor = await currentActor();
  if (actor === null) {
    return {
      status: "refused",
      code: "NO_ACTOR",
      message:
        "No actor could be resolved for this session, so the instruction has nobody to attribute it to and was not written. Every payment_instruction carries a requested_by; an unattributable request is not one this system will raise.",
      issues: null,
      receipt: null,
    };
  }

  // Derived from the source fact and scoped to the account, exactly as the MCP
  // tool derives its own from the grant plus the caller's key. Never a uuid we
  // just generated: a key that is fresh on every attempt is not an idempotency
  // key, it is a retry that pays twice.
  const idempotencyKey = `console:${fields.accountId}:${fields.reference}`.slice(0, 200);

  const result = await requestPayment({
    accountId: fields.accountId,
    rail: fields.rail,
    amountCents,
    currency: "USD",
    destination: buildDestination(fields) as PaymentDestination,
    valueDate: fields.valueDate,
    requestedByActorId: actor.id,
    idempotencyKey,
  });

  if (!result.ok) {
    log.warn("payments.refused", {
      actorId: actor.id,
      code: result.error.code,
      detail: result.error.details,
    });
    return {
      status: "refused",
      code: result.error.code,
      message: result.error.message,
      issues: readIssues(result.error.details),
      receipt: null,
    };
  }

  const { instructionId, contentHash, policy, approvalsRequired, created } = result.value;

  log.info("payments.raised", { actorId: actor.id, instructionId, created });

  // The queue on /approvals now has a row it did not have a moment ago, and
  // this screen's own preflight was read before the write.
  revalidatePath("/approvals");
  revalidatePath("/payments");

  return {
    status: "ok",
    code: "REQUESTED",
    message: created ? QUEUED : REPLAYED,
    issues: null,
    receipt: {
      instructionId,
      contentHash,
      policyId: policy.id,
      policyVersion: policy.version,
      thresholdDisplay: formatUsd(policy.thresholdCents),
      policyNote: policy.note,
      amountDisplay: formatUsd(amountCents),
      rail: fields.rail,
      valueDate: fields.valueDate,
      approvalsRequired,
      needsApproval: approvalsRequired > 0,
      thresholdIsFloor: policy.thresholdCents === 0n,
      created,
    },
  };
}
