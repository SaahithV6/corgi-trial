"use server";

/**
 * The operator's half of standing orders — the half that did not exist.
 *
 * ============================================================================
 * WHAT THIS FILE CLOSES.
 *
 * `createStandingOrder()` and `cancelStandingOrder()` were written, tested and
 * exported from `src/lib/standing/index.ts`, and until this file was written
 * neither had a caller anywhere in `src/app/**`, `src/components/**` or the
 * seed. A mandate could be created by a test and by nothing else. The screen
 * at `/standing-orders` showed the schedule, the occurrences and the policy,
 * and offered no way to put a mandate on the schedule it was showing.
 *
 * That is the whole feature missing, not a rough edge on it: the requirement
 * is "scheduled payments that fire once and only once", and a scheduled
 * payment nobody can schedule fires zero times.
 *
 * ============================================================================
 * THIS ACTION DOES NOT MOVE MONEY, AND IT DOES NOT FIRE ANYTHING.
 *
 * It writes one `standing_order` row: an authority, on a schedule, for later.
 * Nothing is debited here and no `payment_instruction` exists yet. Firing is
 * `runStandingOrders()` behind the authenticated POST to `/api/cron/standing`,
 * on its own tick, and this file deliberately does not import it — a second
 * way to move money on a schedule is the thing `src/lib/standing/index.ts`
 * exists not to be.
 *
 * The same reasoning is why the form is a form and not a link. `StandingView`
 * says it in its header: a page that raised a payment because somebody hit
 * reload would be the worst bug in this repository. A server action runs on a
 * POST that a person pressed, never on a render.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT, so everything in the `FormData`
 * is a claim and is re-decided here:
 *
 *   accountId    re-read from `listDepositAccounts()` and refused unless it is
 *                one of them. The browser's `<option>` list is a convenience;
 *                this is the check. It also settles the currency, which is
 *                therefore never a field the caller can set.
 *   amount       the literal characters somebody typed, parsed to integer
 *                minor units by `parseMinorUnits` below. No floating point
 *                touches money at any point in this file.
 *   destination  parsed by `destinationSchema` here AND again inside
 *                `createStandingOrder()`, which refuses a counterparty that
 *                does not describe a payee this bank can pay. A mandate is a
 *                standing authority to pay with nobody watching; a destination
 *                that does not parse must never become one.
 *   dates        `YYYY-MM-DD`, and the range is checked against the book date
 *                and the catch-up window — see `describeFirstFire`.
 *
 * THE IDENTITY IS NOT TAKEN FROM THE FORM. The actor is resolved on the server
 * from the session. A caller who POSTs a `createdByActorId` field changes
 * nothing, because no field of that name is read.
 *
 * AND THE MANDATE KEY IS NOT A NONCE THIS FILE INVENTS. It is rendered into
 * the form by the server component that drew it, so pressing submit twice —
 * or a browser replaying the POST — reaches `ON CONFLICT (mandate_key) DO
 * NOTHING` and returns the mandate that already exists. Once and only once is
 * a unique index here for the same reason it is a unique index at firing time:
 * not because the caller behaves.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentActor } from "@/lib/approvals/session";
import { destinationSchema } from "@/lib/approvals/types";
import { sql } from "@/lib/ledger/db";
import { listDepositAccounts } from "@/lib/ledger/queries";
import { rootLogger } from "@/lib/log";
import {
  CATCH_UP_WINDOW_DAYS,
  bookToday,
  cancelStandingOrder,
  createStandingOrder,
} from "@/lib/standing";

import { assertOperatorAction } from "@/lib/authz/action-guard";

const log = rootLogger.child({ module: "standing-orders/actions" });

/* -------------------------------------------------------------------------- */
/* What the forms get back                                                    */
/* -------------------------------------------------------------------------- */

/** One field-level complaint, flattened. Never carries a row value. */
export type MandateFieldIssue = {
  readonly path: string;
  readonly message: string;
};

export type CreateMandateResult = {
  readonly status: "idle" | "created" | "replayed" | "refused";
  /** Named on every refusal. There is no unnamed failure in this file. */
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly MandateFieldIssue[] | null;
  readonly standingOrderId: string | null;
  readonly mandateKey: string | null;
};

export type CancelMandateResult = {
  readonly status: "idle" | "cancelled" | "already" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly MandateFieldIssue[] | null;
  readonly standingOrderId: string | null;
};

/*
 * THE IDLE STATES ARE NOT DECLARED HERE, and the reason is worth writing down
 * because it failed silently once. A `"use server"` module may export async
 * functions and nothing else: every other value export is replaced at build
 * time, so `import { CREATE_MANDATE_IDLE }` from this file yields `undefined`,
 * `useActionState` starts with `undefined` as its state, and the form crashes
 * on its FIRST RENDER reading a property of it. Type exports are fine — they
 * are erased before any of that. The two constants live beside the forms that
 * use them, in `src/components/standing/MandateForms.tsx`.
 */

function issuesOf(error: z.ZodError): readonly MandateFieldIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length === 0 ? "(form)" : issue.path.join("."),
    message: issue.message,
  }));
}

/* -------------------------------------------------------------------------- */
/* Money, as characters                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Dollars-and-cents text to integer minor units.
 *
 * Refuses rather than rounds, and never sees a `number`. `"4000"` is
 * 400000 minor units and `"4000.5"` is 400050 — the fractional part is padded
 * on the right, because `.5` of a dollar is fifty cents and not five.
 */
const MINOR_UNITS = /^(\d{1,13})(?:\.(\d{1,2}))?$/;

function parseMinorUnits(text: string): bigint | null {
  const match = MINOR_UNITS.exec(text.trim());
  if (match === null) return null;
  const whole = match[1] ?? "0";
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = BigInt(whole) * 100n + BigInt(fraction);
  return cents <= 0n ? null : cents;
}

function formatMinorUnits(cents: bigint, currency: string): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString();
  const rest = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${rest} ${currency}`;
}

/* -------------------------------------------------------------------------- */
/* The submitted form                                                         */
/* -------------------------------------------------------------------------- */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateField = z
  .string()
  .regex(ISO_DATE, { error: "a calendar date, YYYY-MM-DD" })
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), {
    error: "not a date on any calendar",
  });

const createSchema = z
  .object({
    mandateKey: z.string().min(8).max(120),
    accountId: z.uuid({ error: "pick the account this is paid from" }),
    reference: z.string().trim().min(1).max(120),
    amount: z.string().min(1),
    rail: z.enum(["ach", "internal"]),
    cadence: z.enum(["daily", "weekly", "monthly"]),
    dayOfWeek: z.string().optional(),
    dayOfMonth: z.string().optional(),
    startDate: dateField,
    endDate: z.union([dateField, z.literal("")]).optional(),
    holderName: z.string().trim().max(140).optional(),
    routingNumber: z.string().trim().optional(),
    accountNumberLast4: z.string().trim().optional(),
    accountType: z.string().trim().optional(),
    beneficiaryAccountId: z.string().trim().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.cadence === "weekly") {
      const day = Number(value.dayOfWeek ?? "");
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        ctx.addIssue({
          code: "custom",
          path: ["dayOfWeek"],
          message: "a weekly mandate needs a weekday, Sunday (0) to Saturday (6)",
        });
      }
    }
    if (value.cadence === "monthly") {
      const day = Number(value.dayOfMonth ?? "");
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        ctx.addIssue({
          code: "custom",
          path: ["dayOfMonth"],
          message: "a monthly mandate needs a day of the month, 1 to 31",
        });
      }
    }
  });

const cancelSchema = z.object({
  standingOrderId: z.uuid({ error: "pick the mandate to stop" }),
  reason: z.string().trim().min(3).max(280),
});

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

function refused(
  code: string,
  message: string,
  issues: readonly MandateFieldIssue[] | null = null,
): CreateMandateResult {
  return { status: "refused", code, message, issues, standingOrderId: null, mandateKey: null };
}

/**
 * Whole days between two `YYYY-MM-DD` dates. Calendar dates, never instants —
 * the same arithmetic `src/lib/standing/types.ts` does, for the same reason.
 */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/**
 * What this mandate will actually do next, said out loud on the receipt.
 *
 * `listDue()` caps the due-date window at the BOOK DATE and extends the
 * catch-up window backwards only, so a mandate cannot fire into the future: a
 * start date after today is a mandate that sits there until the tick on that
 * day. Operators guess wrong about this — they create a mandate dated next
 * month, watch the cron run tonight, and conclude the feature is broken. So
 * the receipt says which of the two this is rather than leaving it to be
 * discovered.
 */
function describeFirstFire(startDate: string, bookDate: string): string {
  const daysAhead = daysBetween(bookDate, startDate);
  if (daysAhead > 0) {
    return (
      `It will not fire tonight. The first date it can produce is ${startDate}, ${daysAhead} day` +
      `${daysAhead === 1 ? "" : "s"} from the book date of ${bookDate}, and the firing routine ` +
      `never looks past the book date — it fires dates that have arrived, never dates that have not.`
    );
  }
  return (
    `It is eligible from the next tick: the firing routine claims dates on or before the book ` +
    `date of ${bookDate}, and looks back up to ${CATCH_UP_WINDOW_DAYS} days for dates it has ` +
    `never claimed. Nothing has been debited by writing this row.`
  );
}

export async function createStandingOrderAction(
  _previous: CreateMandateResult,
  formData: FormData,
): Promise<CreateMandateResult> {
  await assertOperatorAction("createStandingOrderAction");

  const parsed = createSchema.safeParse({
    mandateKey: formData.get("mandateKey") ?? "",
    accountId: formData.get("accountId") ?? "",
    reference: formData.get("reference") ?? "",
    amount: formData.get("amount") ?? "",
    rail: formData.get("rail") ?? "",
    cadence: formData.get("cadence") ?? "",
    dayOfWeek: formData.get("dayOfWeek") ?? undefined,
    dayOfMonth: formData.get("dayOfMonth") ?? undefined,
    startDate: formData.get("startDate") ?? "",
    endDate: formData.get("endDate") ?? "",
    holderName: formData.get("holderName") ?? undefined,
    routingNumber: formData.get("routingNumber") ?? undefined,
    accountNumberLast4: formData.get("accountNumberLast4") ?? undefined,
    accountType: formData.get("accountType") ?? undefined,
    beneficiaryAccountId: formData.get("beneficiaryAccountId") ?? undefined,
  });

  if (!parsed.success) {
    return refused(
      "INVALID_FORM",
      "The form could not be read, so nothing reached the database and no mandate exists.",
      issuesOf(parsed.error),
    );
  }

  const form = parsed.data;

  const amountCents = parseMinorUnits(form.amount);
  if (amountCents === null) {
    return refused(
      "INVALID_AMOUNT",
      "The amount is not a positive figure in dollars and cents. Money is integer minor units here and this string could not be read as one, so nothing was written.",
      [{ path: "amount", message: "for example 4000 or 4000.00" }],
    );
  }

  const actor = await currentActor();
  if (actor === null) {
    return refused(
      "NO_ACTOR",
      "The session does not resolve to a seeded actor, and a mandate records who authorised it. Nothing was written.",
    );
  }

  // The account list is the check, not the <option> list the browser drew. It
  // also settles the currency, which is why currency is not a form field.
  const accounts = await listDepositAccounts(sql);
  const account = accounts.find((row) => row.accountId === form.accountId);
  if (account === undefined) {
    return refused(
      "UNKNOWN_ACCOUNT",
      "That is not an open customer deposit account on this book. A mandate is checked against a customer's AVAILABLE balance, so it has to name an account that has one.",
      [{ path: "accountId", message: "not an open 2100 deposit leaf" }],
    );
  }

  const destinationInput =
    form.rail === "internal"
      ? {
          type: "internal",
          accountId: form.beneficiaryAccountId ?? "",
          holderName: form.holderName ?? "",
        }
      : {
          type: "ach",
          holderName: form.holderName ?? "",
          routingNumber: form.routingNumber ?? "",
          accountNumberLast4: form.accountNumberLast4 ?? "",
          accountType: form.accountType ?? "",
        };

  const destination = destinationSchema.safeParse(destinationInput);
  if (!destination.success) {
    return refused(
      "INVALID_DESTINATION",
      "The destination does not describe a payee this bank can pay, so it is not becoming a standing authority to pay one. Nothing was written.",
      issuesOf(destination.error),
    );
  }

  const endDate = form.endDate === undefined || form.endDate === "" ? null : form.endDate;
  if (endDate !== null && daysBetween(form.startDate, endDate) < 0) {
    return refused(
      "EMPTY_DATE_RANGE",
      `The mandate ends on ${endDate}, before it starts on ${form.startDate}. That range contains no date, so this mandate could never produce an occurrence and is not worth writing.`,
      [{ path: "endDate", message: "must be on or after the start date" }],
    );
  }

  const bookDate = await bookToday();
  if (endDate !== null && daysBetween(endDate, bookDate) > CATCH_UP_WINDOW_DAYS) {
    return refused(
      "WINDOW_CLOSED",
      `The mandate ends on ${endDate}, more than ${CATCH_UP_WINDOW_DAYS} days before the book date of ${bookDate}. The firing routine never materialises a date older than that, so every date this mandate describes is already out of reach and it would sit on the schedule forever doing nothing.`,
      [{ path: "endDate", message: `outside the ${CATCH_UP_WINDOW_DAYS}-day catch-up window` }],
    );
  }

  let written: { id: string; created: boolean };
  try {
    written = await createStandingOrder({
      accountId: account.accountId,
      reference: form.reference,
      rail: form.rail,
      amountCents,
      currency: account.currency,
      destination: destination.data,
      cadence: form.cadence,
      dayOfMonth: form.cadence === "monthly" ? Number(form.dayOfMonth ?? "1") : null,
      dayOfWeek: form.cadence === "weekly" ? Number(form.dayOfWeek ?? "0") : null,
      startDate: form.startDate,
      endDate,
      createdByActorId: actor.id,
      mandateKey: form.mandateKey,
    });
  } catch (error) {
    // Named, logged and returned. The one thing this must never be is a
    // silence: an operator who pressed create and saw nothing would press it
    // again, and the mandate key is the only reason that is safe.
    log.error("standing order create failed", {
      mandateKey: form.mandateKey,
      reason: error instanceof Error ? error.message : String(error),
    });
    return refused(
      "WRITE_FAILED",
      `The database refused to write this mandate: ${error instanceof Error ? error.message : String(error)}. No mandate exists under this key, and pressing create again is safe — the key is UNIQUE, so a replay returns the same row rather than a second one.`,
    );
  }

  revalidatePath("/standing-orders");

  const money = formatMinorUnits(amountCents, account.currency);
  if (!written.created) {
    return {
      status: "replayed",
      code: null,
      message: `This form was already submitted. A mandate under key ${form.mandateKey} exists and nothing was written a second time — ON CONFLICT (mandate_key) DO NOTHING decided that, not a check in the application. Reload the page for a fresh key if you meant to create a second mandate.`,
      issues: null,
      standingOrderId: written.id,
      mandateKey: form.mandateKey,
    };
  }

  return {
    status: "created",
    code: null,
    message:
      `Mandate written: ${money} on ${account.accountName}, ${form.cadence}, from ${form.startDate}` +
      `${endDate === null ? " with no end date" : ` to ${endDate}`}. ` +
      `It writes no journal line and moves nothing on its own — each occurrence raises a ` +
      `payment_instruction that goes through the normal approvals path. ` +
      describeFirstFire(form.startDate, bookDate),
    issues: null,
    standingOrderId: written.id,
    mandateKey: form.mandateKey,
  };
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stop a mandate.
 *
 * One row in `standing_order_cancellation`, PRIMARY KEY on the order id, so a
 * second press is a no-op and says so rather than pretending to have done
 * something. Cancelling does NOT retract occurrences the mandate has already
 * produced: those are payment instructions, they are in the approvals queue or
 * past it, and they are stopped there. This stops the schedule from producing
 * any more.
 */
export async function cancelStandingOrderAction(
  _previous: CancelMandateResult,
  formData: FormData,
): Promise<CancelMandateResult> {
  await assertOperatorAction("cancelStandingOrderAction");

  const parsed = cancelSchema.safeParse({
    standingOrderId: formData.get("standingOrderId") ?? "",
    reason: formData.get("reason") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so nothing reached the database and the mandate is untouched.",
      issues: issuesOf(parsed.error),
      standingOrderId: null,
    };
  }

  const actor = await currentActor();
  if (actor === null) {
    return {
      status: "refused",
      code: "NO_ACTOR",
      message:
        "The session does not resolve to a seeded actor, and a cancellation records who stopped the mandate. Nothing was written.",
      issues: null,
      standingOrderId: null,
    };
  }

  let stopped: boolean;
  try {
    stopped = await cancelStandingOrder({
      standingOrderId: parsed.data.standingOrderId,
      actorId: actor.id,
      reason: parsed.data.reason,
    });
  } catch (error) {
    log.error("standing order cancel failed", {
      standingOrderId: parsed.data.standingOrderId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "refused",
      code: "WRITE_FAILED",
      message: `The database refused to record this cancellation: ${error instanceof Error ? error.message : String(error)}. The mandate is still live and will still produce occurrences.`,
      issues: null,
      standingOrderId: null,
    };
  }

  revalidatePath("/standing-orders");

  return stopped
    ? {
        status: "cancelled",
        code: null,
        message: `Stopped by ${actor.displayName}. This mandate produces no further occurrences. Occurrences it has already raised are payment instructions and are unaffected — stop those in the approvals queue.`,
        issues: null,
        standingOrderId: parsed.data.standingOrderId,
      }
    : {
        status: "already",
        code: null,
        message:
          "This mandate was already cancelled and nothing was written a second time. The PRIMARY KEY on the cancellation row decided that, not a check in the application.",
        issues: null,
        standingOrderId: parsed.data.standingOrderId,
      };
}
