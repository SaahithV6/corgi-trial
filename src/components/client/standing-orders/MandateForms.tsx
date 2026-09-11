"use client";

import { useActionState, useId, useState } from "react";

import {
  cancelClientStandingOrderAction,
  createClientStandingOrderAction,
  type ClientCancelMandateResult,
  type ClientCreateMandateResult,
  type MandateIssue,
} from "@/app/(app)/client/standing-orders/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

/**
 * The two forms that set up a recurring payment and stop one.
 *
 * WHAT THEY ARE CAREFUL NOT TO DO.
 *
 * 1. THEY DO NOT SEND ANYTHING. Submitting writes one `standing_order` row and
 *    stops. No journal line, no `payment_instruction`, nothing debited. The row
 *    is an authority for a later cron tick to act on, and that tick is the
 *    authenticated POST to `/api/cron/standing`.
 *
 * 2. THEY ARE NOT THE VALIDATION. The `required` attributes and `pattern`s are
 *    conveniences. Every one is re-decided on the server by the zod schemas in
 *    `actions.ts`, and by `destinationSchema` twice — once in the action and
 *    once inside `createStandingOrder()`. A POST assembled by hand with none of
 *    these fields reaches exactly the same named refusals.
 *
 * 3. THEY DO NO ARITHMETIC ON MONEY. The amount is the literal characters
 *    somebody typed, sent as text, parsed to integer minor units on the server.
 *
 * 4. THEY DO NOT NAME THE ACCOUNT. There is no `accountId` field here, because
 *    the account is resolved on the server from the business this page is
 *    scoped to. The only ids that travel are the business (a demo claim, which
 *    is resolved and can never widen) and the payee or mandate, each re-checked
 *    against `business_id` in one SQL statement before anything is written.
 *
 * 5. THE MANDATE KEY COMES FROM THE SERVER, not from `crypto.randomUUID()` in
 *    here. It is rendered into the hidden field by the server component that
 *    drew this form, so a double-press or a browser replaying the POST lands on
 *    the SAME key, hits `ON CONFLICT (mandate_key) DO NOTHING`, and reports
 *    that it replayed rather than creating a second recurring payment.
 *    Generating it in the browser would mint a fresh key per attempt, which is
 *    exactly the duplicate that UNIQUE index exists to refuse.
 */

/**
 * The two idle states, declared HERE rather than beside the actions.
 *
 * A `"use server"` module may export async functions and nothing else — every
 * other value export is replaced at build time by a server reference. Importing
 * a plain constant from `actions.ts` yields `undefined`, `useActionState` then
 * starts with `undefined`, and the form crashes on its first render reading a
 * property of it, with typecheck clean the whole way. The TYPES still come from
 * `actions.ts`, because types are erased before any of that matters and the
 * action is the thing that decides their shape.
 */
const CREATE_IDLE: ClientCreateMandateResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  standingOrderId: null,
};

const CANCEL_IDLE: ClientCancelMandateResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  standingOrderId: null,
};

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";
const BUTTON_CLASS = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;

const WEEKDAY_OPTIONS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
] as const;

export type PayeeChoice = {
  readonly payeeId: string;
  readonly label: string;
};

export type StoppableMandate = {
  readonly id: string;
  readonly label: string;
};

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint === undefined ? null : (
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">{hint}</p>
      )}
    </div>
  );
}

function Issues({ issues }: { readonly issues: readonly MandateIssue[] }) {
  return (
    <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`}>
          <code>{issue.path}</code> — {issue.message}
        </li>
      ))}
    </ul>
  );
}

function Receipt({
  tone,
  message,
  issues,
}: {
  readonly tone: "good" | "bad" | "quiet";
  readonly message: string;
  readonly issues: readonly MandateIssue[] | null;
}) {
  if (message === "") return null;
  const border =
    tone === "bad" ? "border-negative/40" : tone === "good" ? "border-positive/40" : "border-border";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-4 rounded-md border ${border} bg-surface-raised px-4 py-3`}
    >
      <p className="max-w-prose text-xs leading-relaxed text-muted">{message}</p>
      {issues === null || issues.length === 0 ? null : <Issues issues={issues} />}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Set one up                                                                 */
/* -------------------------------------------------------------------------- */

export function CreateRecurringPaymentForm({
  businessId,
  mandateKey,
  payees,
  today,
  currency,
}: {
  readonly businessId: string;
  readonly mandateKey: string;
  readonly payees: readonly PayeeChoice[];
  readonly today: string;
  readonly currency: string;
}) {
  const [state, formAction, pending] = useActionState(
    createClientStandingOrderAction,
    CREATE_IDLE,
  );
  const [cadence, setCadence] = useState<"daily" | "weekly" | "monthly">("monthly");
  const ids = useId();

  if (payees.length === 0) {
    return (
      <p className="max-w-prose text-sm leading-relaxed text-muted">
        You have not confirmed anybody to pay by ACH yet. A recurring payment is
        a standing authority to pay somebody with nobody watching, so it can
        only be set up to a payee already on your own list — add one on{" "}
        <strong className="font-medium text-text">Send a payment</strong> first.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      {/* Minted on the server, once per render. This is the once-and-only-once. */}
      <input type="hidden" name="mandateKey" value={mandateKey} />
      {/* Which customer. Resolved against the book on the server; it is a claim
          this form makes, never a permission it grants. */}
      <input type="hidden" name="businessId" value={businessId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who gets paid" hint="Only payees you have already confirmed.">
          <select
            id={`${ids}-payee`}
            name="payeeId"
            required
            defaultValue={payees[0]?.payeeId ?? ""}
            className={INPUT_CLASS}
          >
            {payees.map((p) => (
              <option key={p.payeeId} value={p.payeeId}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="What it is for" hint="Shown to you and carried onto each payment.">
          <input
            id={`${ids}-reference`}
            name="reference"
            required
            maxLength={120}
            placeholder="Rent — Unit 4"
            className={INPUT_CLASS}
          />
        </Field>

        <Field label={`How much (${currency})`} hint="Dollars and cents, e.g. 4000 or 4000.00.">
          <input
            id={`${ids}-amount`}
            name="amount"
            required
            inputMode="decimal"
            pattern="\d{1,13}(\.\d{1,2})?"
            placeholder="4000.00"
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="How often">
          <select
            id={`${ids}-cadence`}
            name="cadence"
            value={cadence}
            onChange={(event) =>
              setCadence(event.target.value as "daily" | "weekly" | "monthly")
            }
            className={INPUT_CLASS}
          >
            <option value="monthly">Every month</option>
            <option value="weekly">Every week</option>
            <option value="daily">Every day</option>
          </select>
        </Field>

        {cadence === "weekly" ? (
          <Field label="Which day">
            <select name="dayOfWeek" defaultValue="1" className={INPUT_CLASS}>
              {WEEKDAY_OPTIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {cadence === "monthly" ? (
          <Field
            label="Day of the month"
            hint="A month that is too short has no such date, and that month is simply skipped — the date is not moved."
          >
            <input
              name="dayOfMonth"
              type="number"
              min={1}
              max={31}
              defaultValue={1}
              className={INPUT_CLASS}
            />
          </Field>
        ) : null}

        <Field
          label="First payment on"
          hint="A date in the future sits there until that day arrives. Nothing goes out before it."
        >
          <input
            name="startDate"
            type="date"
            required
            defaultValue={today}
            className={INPUT_CLASS}
          />
        </Field>

        <Field label="Stop after (optional)" hint="Leave blank to keep going until you stop it.">
          <input name="endDate" type="date" className={INPUT_CLASS} />
        </Field>
      </div>

      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? "Setting up…" : "Set up this recurring payment"}
      </button>

      <Receipt
        tone={
          state.status === "created"
            ? "good"
            : state.status === "refused"
              ? "bad"
              : "quiet"
        }
        message={state.message}
        issues={state.issues}
      />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Stop one                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The stop form, on the same screen as the set-up form and no further down it.
 *
 * A recurring payment a customer cannot stop is worse than one they cannot
 * start, so this is not a link to somewhere else and not an operator errand.
 */
export function StopRecurringPaymentForm({
  businessId,
  mandates,
}: {
  readonly businessId: string;
  readonly mandates: readonly StoppableMandate[];
}) {
  const [state, formAction, pending] = useActionState(
    cancelClientStandingOrderAction,
    CANCEL_IDLE,
  );

  if (mandates.length === 0) {
    return (
      <p className="max-w-prose text-sm leading-relaxed text-muted">
        You have no recurring payments running, so there is nothing to stop.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="businessId" value={businessId} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Which one">
          <select
            name="standingOrderId"
            required
            defaultValue={mandates[0]?.id ?? ""}
            className={INPUT_CLASS}
          >
            {mandates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Why" hint="Kept on the record beside the cancellation.">
          <input
            name="reason"
            required
            minLength={3}
            maxLength={280}
            placeholder="Moved out — no longer renting"
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      <button type="submit" disabled={pending} className={BUTTON_CLASS}>
        {pending ? "Stopping…" : "Stop this recurring payment"}
      </button>

      <Receipt
        tone={
          state.status === "cancelled"
            ? "good"
            : state.status === "refused"
              ? "bad"
              : "quiet"
        }
        message={state.message}
        issues={state.issues}
      />
    </form>
  );
}
