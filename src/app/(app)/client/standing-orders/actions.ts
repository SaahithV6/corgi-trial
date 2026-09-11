"use server";

/**
 * The customer setting up — and stopping — their own recurring payment.
 *
 * ===========================================================================
 * WHAT THIS CLOSES
 * ===========================================================================
 *
 * Gauntlet item 8 asks for "scheduled payments that fire once and only once
 * across restarts and retries, with a written policy for the day the balance
 * cannot cover them". All of that was built. Every bit of it was reachable from
 * the OPERATOR console only: `/standing-orders` is where a mandate is created,
 * which means a customer who wants to pay their rent every month has to ring
 * the bank and ask a member of staff to set it up on their behalf. That
 * polarity is backwards in the same way `/pots` was — paying your landlord on
 * the first of the month is the business's own arrangement; the bank needs to
 * SEE the mandate, not to be the only party who can write one.
 *
 * ===========================================================================
 * ONE WRITER, TWO SURFACES
 * ===========================================================================
 *
 * Both writes below go through `createStandingOrder()` and
 * `cancelStandingOrder()` in `@/lib/standing` — the same two functions the
 * operator's action calls, reached through the LIBRARY and not through the
 * other screen. `src/app/(app)/standing-orders/actions.ts` is not imported and
 * is not touched. Two surfaces calling one library function is correct; a
 * second copy of the rule is the defect.
 *
 * ===========================================================================
 * THIS FIRES NOTHING AND MOVES NOTHING
 * ===========================================================================
 *
 * Creating a mandate writes one `standing_order` row: an authority, on a
 * schedule, for later. No journal line, no `payment_instruction`, nothing
 * debited — migration 0012 §5 is explicit that standing orders write no journal
 * lines; each occurrence raises a payment instruction which goes through the
 * normal approvals path. Firing is `runStandingOrders()` behind the
 * authenticated POST to `/api/cron/standing`, on its own tick, and this file
 * deliberately does not import it.
 *
 * And it is a server action on a pressed button, never a render. A page that
 * raised a payment because somebody hit reload would be the worst bug in this
 * repository.
 *
 * ===========================================================================
 * ONCE AND ONLY ONCE IS A UNIQUE INDEX, NOT A CHECK IN HERE
 * ===========================================================================
 *
 * The `mandateKey` is minted by the SERVER COMPONENT that drew the form and
 * carried in a hidden field, so a double-press or a browser replaying the POST
 * lands on the same key, hits `ON CONFLICT (mandate_key) DO NOTHING` and gets
 * back the mandate that already exists. There is no second mechanism here and
 * there must not be one: adding an application-level "have I seen this before"
 * check would be a second definition of the same rule, and two definitions of
 * one rule cannot be fixed one at a time.
 *
 * ===========================================================================
 * NO GUARD BY ROLE, SO EVERY ID IS A PREDICATE
 * ===========================================================================
 *
 * `assertOperatorAction()` is deliberately NOT called: this is the customer's
 * own screen and a role check here would refuse the customer their own form.
 * `CUSTOMER_EXECUTABLE_ACTION_MODULES` explains why the `client/` tree is
 * exempt by shape rather than by name — every action in it carries a
 * both-column tenant predicate, and those predicates are what actually scope a
 * customer's rows. So:
 *
 *   businessId          a CLAIM off the demo switcher, resolved against the
 *                       book by `resolveBusiness()`; it can never widen to
 *                       "every business".
 *   accountId           NOT A FIELD. Resolved on the server from the business,
 *                       `WHERE business_id = $1 AND code = '2100'`, exactly as
 *                       `/client/pay` does. A POST carrying an `accountId`
 *                       changes nothing because no field of that name is read.
 *   payeeId             resolved with `loadPayeeBook({ businessId, payeeId })`
 *                       — both columns, one statement. Another customer's payee
 *                       is refused identically to a payee that does not exist.
 *   standingOrderId     `ownsMandate()`, `WHERE so.id = $1 AND
 *                       acc.business_id = $2`. Same shape, same reason.
 *
 * ===========================================================================
 * MONEY IS INTEGER MINOR UNITS FROM THE FIRST CHARACTER
 * ===========================================================================
 *
 * `parseMinorUnits()` splits what somebody typed on the decimal point as TEXT
 * and assembles a `bigint`. No `Number`, no `parseFloat`, no `* 100` anywhere
 * on this path, so there is no step at which $19.99 becomes 1998.9999999999998.
 *
 * ===========================================================================
 * ONLY ASYNC FUNCTIONS ARE EXPORTED FROM HERE
 * ===========================================================================
 *
 * A `"use server"` module may export async functions and nothing else: every
 * other value export is replaced at build time by a server reference, so
 * importing a plain constant from here yields `undefined`, `useActionState`
 * starts with `undefined`, and the form crashes on its FIRST RENDER reading a
 * property of it — typecheck stays clean throughout. The operator's standing
 * orders work hit exactly this. The idle states live beside the forms, in
 * `src/components/client/standing-orders/MandateForms.tsx`. Type exports are
 * fine; they are erased before any of it matters.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { destinationSchema } from "@/lib/approvals/types";
import { currentActor } from "@/lib/approvals/session";
import { sql } from "@/lib/ledger/db";
import { loadPayeeBook } from "@/lib/payees/store";
import { rootLogger } from "@/lib/log";
import {
  CATCH_UP_WINDOW_DAYS,
  bookToday,
  cancelStandingOrder,
  createStandingOrder,
} from "@/lib/standing";

import { accountForBusiness, ownsMandate, resolveBusiness } from "./reader";

const log = rootLogger.child({ module: "client/standing-orders/actions" });

/* -------------------------------------------------------------------------- */
/* What the forms get back                                                    */
/* -------------------------------------------------------------------------- */

export type MandateIssue = {
  readonly path: string;
  readonly message: string;
};

export type ClientCreateMandateResult = {
  readonly status: "idle" | "created" | "replayed" | "refused";
  /** Named on every refusal. There is no unnamed failure in this file. */
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly MandateIssue[] | null;
  readonly standingOrderId: string | null;
};

export type ClientCancelMandateResult = {
  readonly status: "idle" | "cancelled" | "already" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly MandateIssue[] | null;
  readonly standingOrderId: string | null;
};

function issuesOf(error: z.ZodError): readonly MandateIssue[] {
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
 * Refuses rather than rounds, and never sees a `number`. `"4000"` is 400000 and
 * `"4000.5"` is 400050 — the fractional part is padded on the RIGHT, because
 * `.5` of a dollar is fifty cents and not five.
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
  const whole = (cents / 100n).toString();
  const rest = (cents % 100n).toString().padStart(2, "0");
  return `${whole}.${rest} ${currency}`;
}

/** Whole days between two `YYYY-MM-DD` dates. Calendar dates, never instants. */
function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/* -------------------------------------------------------------------------- */
/* The submitted forms                                                        */
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
    businessId: z.uuid({ error: "which business this is for" }),
    payeeId: z.uuid({ error: "pick somebody you have already paid" }),
    reference: z.string().trim().min(1).max(120),
    amount: z.string().min(1),
    cadence: z.enum(["daily", "weekly", "monthly"]),
    dayOfWeek: z.string().optional(),
    dayOfMonth: z.string().optional(),
    startDate: dateField,
    endDate: z.union([dateField, z.literal("")]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.cadence === "weekly") {
      const day = Number(value.dayOfWeek ?? "");
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        ctx.addIssue({
          code: "custom",
          path: ["dayOfWeek"],
          message: "a weekly payment needs a day of the week",
        });
      }
    }
    if (value.cadence === "monthly") {
      const day = Number(value.dayOfMonth ?? "");
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        ctx.addIssue({
          code: "custom",
          path: ["dayOfMonth"],
          message: "a monthly payment needs a day of the month, 1 to 31",
        });
      }
    }
  });

const cancelSchema = z.object({
  businessId: z.uuid({ error: "which business this is for" }),
  standingOrderId: z.uuid({ error: "pick the payment to stop" }),
  reason: z.string().trim().min(3).max(280),
});

function refused(
  code: string,
  message: string,
  issues: readonly MandateIssue[] | null = null,
): ClientCreateMandateResult {
  return { status: "refused", code, message, issues, standingOrderId: null };
}

/**
 * What this mandate will actually do next, said out loud on the receipt.
 *
 * `listDue()` caps the due-date window at the BOOK DATE and the catch-up window
 * extends BACKWARDS only, so a mandate cannot fire into the future: a start
 * date after today is a mandate that sits there until the tick on that day.
 * People guess wrong about this — they set one up for next month, watch tonight
 * go by, and conclude it is broken. So the receipt says which of the two it is
 * rather than leaving it to be discovered.
 */
function describeFirstFire(startDate: string, bookDate: string): string {
  const daysAhead = daysBetween(bookDate, startDate);
  if (daysAhead > 0) {
    return (
      `It will not go out tonight. The first date it can produce is ${startDate}, ${daysAhead} day` +
      `${daysAhead === 1 ? "" : "s"} from today (${bookDate}), and the routine that sends these ` +
      `never looks past today — it sends dates that have arrived, never dates that have not.`
    );
  }
  return (
    `It is eligible from the next run: dates on or before today (${bookDate}) are claimed, and ` +
    `dates up to ${CATCH_UP_WINDOW_DAYS} days back that have never been claimed. Nothing has been ` +
    `taken from your account by setting this up.`
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export async function createClientStandingOrderAction(
  _previous: ClientCreateMandateResult,
  formData: FormData,
): Promise<ClientCreateMandateResult> {
  const parsed = createSchema.safeParse({
    mandateKey: formData.get("mandateKey") ?? "",
    businessId: formData.get("businessId") ?? "",
    payeeId: formData.get("payeeId") ?? "",
    reference: formData.get("reference") ?? "",
    amount: formData.get("amount") ?? "",
    cadence: formData.get("cadence") ?? "",
    dayOfWeek: formData.get("dayOfWeek") ?? undefined,
    dayOfMonth: formData.get("dayOfMonth") ?? undefined,
    startDate: formData.get("startDate") ?? "",
    endDate: formData.get("endDate") ?? "",
  });

  if (!parsed.success) {
    return refused(
      "INVALID_FORM",
      "The form could not be read, so nothing reached the database and no recurring payment exists.",
      issuesOf(parsed.error),
    );
  }

  const form = parsed.data;

  const amountCents = parseMinorUnits(form.amount);
  if (amountCents === null) {
    return refused(
      "INVALID_AMOUNT",
      "That is not a positive figure in dollars and cents, so nothing was written.",
      [{ path: "amount", message: "for example 4000 or 4000.00" }],
    );
  }

  // The business id is a claim off the demo switcher. Resolved, never widened.
  const subject = await resolveBusiness(form.businessId, sql);
  if (!subject.ok) {
    return refused("NO_BUSINESS", subject.message);
  }
  const businessId = subject.value.id;

  // THE ACCOUNT IS NOT A FIELD. It is resolved from the business.
  const account = await accountForBusiness(businessId, sql);
  if (account === null) {
    return refused(
      "NO_ACCOUNT",
      "No current account has been opened for this business yet, so there is nothing to pay from. An account opens when the business passes its checks.",
    );
  }

  const actor = await currentActor(sql);
  if (actor === null) {
    return refused(
      "NO_ACTOR",
      "This session does not resolve to an actor on the book, and a recurring payment records who authorised it. Nothing was written.",
    );
  }

  // BOTH COLUMNS, ONE STATEMENT. Another customer's payee is refused exactly as
  // a payee that does not exist, so this form cannot be used to discover ids.
  const [payee] = await loadPayeeBook({ businessId, payeeId: form.payeeId }, sql);
  if (payee === undefined || payee.archived) {
    return refused(
      "UNKNOWN_PAYEE",
      "That is not somebody you have confirmed as a payee. A recurring payment is a standing authority to pay with nobody watching, so it can only be set up to a payee already on your own list.",
      [{ path: "payeeId", message: "not a live payee on this business" }],
    );
  }

  // Parsed here AND again inside `createStandingOrder()`. A destination that
  // does not describe a payee this bank can pay must never become a standing
  // authority to pay one.
  const destination = destinationSchema.safeParse({
    type: "ach",
    holderName: payee.holderName,
    routingNumber: payee.routingNumber ?? "",
    accountNumberLast4: payee.accountNumberLast4 ?? "",
    accountType: payee.accountType ?? "",
  });
  if (!destination.success) {
    return refused(
      "INVALID_DESTINATION",
      "That payee's details no longer describe an account this bank can pay, so they are not becoming a standing authority to pay one. Nothing was written.",
      issuesOf(destination.error),
    );
  }

  const endDate = form.endDate === undefined || form.endDate === "" ? null : form.endDate;
  if (endDate !== null && daysBetween(form.startDate, endDate) < 0) {
    return refused(
      "EMPTY_DATE_RANGE",
      `This ends on ${endDate}, before it starts on ${form.startDate}. That range contains no date, so it could never pay anybody.`,
      [{ path: "endDate", message: "must be on or after the start date" }],
    );
  }

  const bookDate = await bookToday(sql);
  if (endDate !== null && daysBetween(endDate, bookDate) > CATCH_UP_WINDOW_DAYS) {
    return refused(
      "WINDOW_CLOSED",
      `This ends on ${endDate}, more than ${CATCH_UP_WINDOW_DAYS} days ago. The routine that sends these never reaches back further than that, so every date it describes is already out of reach and it would sit there forever doing nothing.`,
      [{ path: "endDate", message: `outside the ${CATCH_UP_WINDOW_DAYS}-day catch-up window` }],
    );
  }

  let written: { id: string; created: boolean };
  try {
    written = await createStandingOrder({
      accountId: account.accountId,
      reference: form.reference,
      rail: "ach",
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
    // silence: somebody who pressed set-up and saw nothing would press it
    // again, and the mandate key is the only reason that is safe.
    log.error("client standing order create failed", {
      mandateKey: form.mandateKey,
      reason: error instanceof Error ? error.message : String(error),
    });
    return refused(
      "WRITE_FAILED",
      `The database refused to write this: ${error instanceof Error ? error.message : String(error)}. Nothing exists under this key, and pressing set-up again is safe — the key is UNIQUE, so a repeat returns the same row rather than a second one.`,
    );
  }

  revalidatePath("/client/standing-orders");

  if (!written.created) {
    return {
      status: "replayed",
      code: null,
      message:
        "This form was already submitted and nothing was written a second time — the UNIQUE index on the mandate key decided that, not a check in the application. Reload the page for a fresh key if you meant to set up a second payment.",
      issues: null,
      standingOrderId: written.id,
    };
  }

  return {
    status: "created",
    code: null,
    message:
      `Set up: ${formatMinorUnits(amountCents, account.currency)} to ${payee.displayName}, ` +
      `${form.cadence}, from ${form.startDate}` +
      `${endDate === null ? " with no end date" : ` to ${endDate}`}. ` +
      `Nothing has moved and nothing has been debited — each time it comes round it raises a ` +
      `payment that goes through the same approvals path as any other payment you send. ` +
      describeFirstFire(form.startDate, bookDate),
    issues: null,
    standingOrderId: written.id,
  };
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Stop a recurring payment.
 *
 * AS REACHABLE AS SETTING ONE UP, and on the same screen, because a recurring
 * payment a customer cannot stop is worse than one they cannot start. One row
 * in `standing_order_cancellation`, PRIMARY KEY on the order id, so a second
 * press is a no-op that says so rather than pretending.
 *
 * Cancelling does NOT retract payments this mandate has already raised: those
 * are payment instructions, they are in the approvals queue or past it, and
 * they are stopped there. This stops any more from being raised.
 */
export async function cancelClientStandingOrderAction(
  _previous: ClientCancelMandateResult,
  formData: FormData,
): Promise<ClientCancelMandateResult> {
  const parsed = cancelSchema.safeParse({
    businessId: formData.get("businessId") ?? "",
    standingOrderId: formData.get("standingOrderId") ?? "",
    reason: formData.get("reason") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so nothing reached the database and the payment is untouched.",
      issues: issuesOf(parsed.error),
      standingOrderId: null,
    };
  }

  const subject = await resolveBusiness(parsed.data.businessId, sql);
  if (!subject.ok) {
    return {
      status: "refused",
      code: "NO_BUSINESS",
      message: subject.message,
      issues: null,
      standingOrderId: null,
    };
  }

  // The id came off a form, so it is worth nothing until Postgres agrees it is
  // on this business. Not a `.find()` over a list read earlier.
  if (!(await ownsMandate(parsed.data.standingOrderId, subject.value.id, sql))) {
    return {
      status: "refused",
      code: "UNKNOWN_MANDATE",
      message:
        "There is no recurring payment with that reference on this account. Nothing was written.",
      issues: null,
      standingOrderId: null,
    };
  }

  const actor = await currentActor(sql);
  if (actor === null) {
    return {
      status: "refused",
      code: "NO_ACTOR",
      message:
        "This session does not resolve to an actor on the book, and a cancellation records who stopped it. Nothing was written.",
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
    log.error("client standing order cancel failed", {
      standingOrderId: parsed.data.standingOrderId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return {
      status: "refused",
      code: "WRITE_FAILED",
      message: `The database refused to record this: ${error instanceof Error ? error.message : String(error)}. The payment is still live and will still come round.`,
      issues: null,
      standingOrderId: null,
    };
  }

  revalidatePath("/client/standing-orders");

  return stopped
    ? {
        status: "cancelled",
        code: null,
        message:
          "Stopped. Nothing further will be raised from this. Payments it has already raised are unaffected — those are in your approvals queue and are stopped there.",
        issues: null,
        standingOrderId: parsed.data.standingOrderId,
      }
    : {
        status: "already",
        code: null,
        message:
          "This was already stopped and nothing was written a second time. The PRIMARY KEY on the cancellation row decided that, not a check in the application.",
        issues: null,
        standingOrderId: parsed.data.standingOrderId,
      };
}
