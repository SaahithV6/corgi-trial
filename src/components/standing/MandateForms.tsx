"use client";

import { useActionState, useId, useState } from "react";

import {
  cancelStandingOrderAction,
  createStandingOrderAction,
  type CancelMandateResult,
  type CreateMandateResult,
  type MandateFieldIssue,
} from "@/app/(app)/standing-orders/actions";
import { FOCUS_RING, Note, Panel } from "@/components/ui/primitives";

import type { CancellableMandate, MandateAccountOption } from "./data-contract";

/**
 * The two forms that put a mandate on the schedule and take one off it.
 *
 * WHAT THEY ARE CAREFUL NOT TO DO.
 *
 * 1. THEY DO NOT FIRE ANYTHING. Submitting writes a `standing_order` row and
 *    stops. No journal line is written, no `payment_instruction` exists, and
 *    nothing is debited. The row is an authority for a cron tick to act on
 *    later, and the tick is `/api/cron/standing`.
 *
 * 2. THEY ARE NOT THE VALIDATION. The `required` attributes and the `pattern`s
 *    are conveniences for somebody filling this in at speed. Every one is
 *    re-decided on the server by the zod schemas in `actions.ts`, and by
 *    `destinationSchema` twice — once in the action and once inside
 *    `createStandingOrder()`. A POST assembled by hand with none of these
 *    fields reaches exactly the same named refusals.
 *
 * 3. THEY DO NO ARITHMETIC ON MONEY. The amount is the literal characters
 *    somebody typed, sent as text, and parsed to integer minor units on the
 *    server. `4000.10` is 400010 there and is never a float anywhere.
 *
 * 4. THE MANDATE KEY COMES FROM THE SERVER, not from `crypto.randomUUID()` in
 *    here. It is rendered into the hidden field by the panel that drew this
 *    form, so a double-press or a browser replaying the POST lands on the same
 *    key, hits `ON CONFLICT (mandate_key) DO NOTHING`, and reports that it
 *    replayed rather than creating a second mandate. Generating it in the
 *    browser would produce a fresh key on every attempt, which is exactly the
 *    duplicate this row's UNIQUE index exists to refuse.
 */

/**
 * The two idle states, declared HERE rather than beside the actions.
 *
 * A `"use server"` module may export async functions and nothing else — every
 * other value export is replaced at build time. Importing a plain constant
 * from `actions.ts` yields `undefined`, `useActionState` then starts with
 * `undefined`, and the form crashes on its first render reading a property of
 * it. Measured, not assumed: that is exactly how this file failed before the
 * constants moved. The TYPES still come from `actions.ts`, because types are
 * erased before any of that matters and the action is the thing that decides
 * their shape.
 */
const CREATE_MANDATE_IDLE: CreateMandateResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  standingOrderId: null,
  mandateKey: null,
};

const CANCEL_MANDATE_IDLE: CancelMandateResult = {
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

function Issues({ issues }: { readonly issues: readonly MandateFieldIssue[] }) {
  return (
    <ul className="mt-2 space-y-0.5 text-[11px] text-muted">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`}>
          <span className="money">{issue.path}</span> — {issue.message}
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export function CreateMandateForm({
  accounts,
  mandateKey,
  bookDate,
}: {
  readonly accounts: readonly MandateAccountOption[];
  readonly mandateKey: string;
  readonly bookDate: string;
}) {
  const [state, formAction, pending] = useActionState(
    createStandingOrderAction,
    CREATE_MANDATE_IDLE,
  );
  const [cadence, setCadence] = useState<"daily" | "weekly" | "monthly">("monthly");
  const [rail, setRail] = useState<"ach" | "internal">("ach");
  const referenceId = useId();
  const amountId = useId();

  const dayOfMonth = String(Number(bookDate.slice(8, 10)));
  const noAccounts = accounts.length === 0;

  return (
    <Panel
      id="create-mandate"
      title="Authorise a standing order"
      description="Writes one mandate row. It moves no money and fires nothing — each occurrence is raised on its own scheduled date by the cron tick, and goes through the normal approvals path from there."
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        <input type="hidden" name="mandateKey" value={mandateKey} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Paid from"
            hint="An open customer deposit account. The mandate is funds-checked against this account's AVAILABLE balance on the day, not against its ledger balance."
          >
            <select name="accountId" required disabled={pending || noAccounts} className={INPUT_CLASS}>
              {accounts.map((account) => (
                <option key={account.accountId} value={account.accountId}>
                  {account.legalName} — {account.currency}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Reference"
            hint="What this payment is, in the words the payee and the customer both use. It is carried onto every instruction the mandate raises."
          >
            <input
              id={referenceId}
              name="reference"
              type="text"
              required
              maxLength={120}
              defaultValue="Rent — Unit 4, Ridgeline Works"
              disabled={pending}
              className={INPUT_CLASS}
            />
          </Field>

          <Field
            label="Amount"
            hint="Dollars and cents. Stored as integer minor units; the exact figure leaves on every occurrence, because a mandate that pays a different number is a different payment."
          >
            <input
              id={amountId}
              name="amount"
              type="text"
              inputMode="decimal"
              required
              pattern="\d{1,13}(\.\d{1,2})?"
              defaultValue="4000.00"
              disabled={pending}
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Rail" hint="Which network carries it. The destination fields below follow from this.">
            <select
              name="rail"
              value={rail}
              onChange={(event) => setRail(event.target.value === "internal" ? "internal" : "ach")}
              disabled={pending}
              className={INPUT_CLASS}
            >
              <option value="ach">ACH</option>
              <option value="internal">Internal book transfer</option>
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Cadence">
            <select
              name="cadence"
              value={cadence}
              onChange={(event) => {
                const next = event.target.value;
                setCadence(next === "daily" ? "daily" : next === "weekly" ? "weekly" : "monthly");
              }}
              disabled={pending}
              className={INPUT_CLASS}
            >
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
              <option value="daily">Daily</option>
            </select>
          </Field>

          {cadence === "monthly" ? (
            <Field
              label="Day of month"
              hint="A day past the 28th is clamped to the last day of shorter months — never skipped. The clamp is in SQL, in standing_order_due_dates()."
            >
              <input
                name="dayOfMonth"
                type="number"
                min={1}
                max={31}
                required
                defaultValue={dayOfMonth}
                disabled={pending}
                className={INPUT_CLASS}
              />
            </Field>
          ) : null}

          {cadence === "weekly" ? (
            <Field label="Weekday">
              <select name="dayOfWeek" required disabled={pending} className={INPUT_CLASS}>
                {WEEKDAY_OPTIONS.map((day) => (
                  <option key={day.value} value={day.value}>
                    {day.label}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}

          <Field
            label="Start date"
            hint={`Defaults to the book date, ${bookDate}. A later date is allowed and simply waits: the firing routine claims dates on or before the book date and never looks past it, so a mandate cannot fire into the future.`}
          >
            <input
              name="startDate"
              type="date"
              required
              defaultValue={bookDate}
              disabled={pending}
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="End date (optional)" hint="Blank means open-ended. The last date it may produce, inclusive.">
            <input name="endDate" type="date" disabled={pending} className={INPUT_CLASS} />
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Beneficiary name">
            <input
              name="holderName"
              type="text"
              required
              maxLength={140}
              defaultValue="Ridgeline Works Property LLC"
              disabled={pending}
              className={INPUT_CLASS}
            />
          </Field>

          {rail === "ach" ? (
            <>
              <Field label="Routing number" hint="Nine digits. Re-checked on the server.">
                <input
                  name="routingNumber"
                  type="text"
                  required
                  inputMode="numeric"
                  pattern="\d{9}"
                  defaultValue="011401533"
                  disabled={pending}
                  className={INPUT_CLASS}
                />
              </Field>
              <Field
                label="Account number — last four"
                hint="Four digits and never more. An approver needs to recognise a beneficiary, not to be able to re-key the payment somewhere else."
              >
                <input
                  name="accountNumberLast4"
                  type="text"
                  required
                  inputMode="numeric"
                  pattern="\d{4}"
                  defaultValue="4417"
                  disabled={pending}
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Account type">
                <select name="accountType" disabled={pending} className={INPUT_CLASS}>
                  <option value="checking">Checking</option>
                  <option value="savings">Savings</option>
                </select>
              </Field>
            </>
          ) : (
            <Field label="Beneficiary account" hint="Both legs stay on our own book.">
              <select
                name="beneficiaryAccountId"
                required
                disabled={pending || noAccounts}
                className={INPUT_CLASS}
              >
                {accounts.map((account) => (
                  <option key={account.accountId} value={account.accountId}>
                    {account.legalName}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={pending || noAccounts} className={BUTTON_CLASS}>
            {pending ? "Writing the mandate…" : "Authorise standing order"}
          </button>
          <span className="text-[11px] text-muted">
            Nothing is debited by pressing this. mandate key{" "}
            <span className="money">{mandateKey}</span>
          </span>
        </div>

        {noAccounts ? (
          <Note emphasis title="No customer deposit account to pay from">
            <p>
              This book holds no open 2100 deposit leaf, so there is no account
              with an available balance a mandate could be checked against. The
              form is inert rather than offering a choice it cannot honour.
            </p>
          </Note>
        ) : null}

        {state.status === "idle" ? null : (
          <Note
            emphasis={state.status === "refused"}
            title={
              state.status === "refused"
                ? `Refused — ${state.code ?? "UNNAMED"}`
                : state.status === "replayed"
                  ? "Already created — nothing written twice"
                  : "Mandate authorised"
            }
          >
            <p>{state.message}</p>
            {state.issues === null ? null : <Issues issues={state.issues} />}
            {state.standingOrderId === null ? null : (
              <p className="mt-2">
                standing order <span className="money">{state.standingOrderId}</span>
              </p>
            )}
          </Note>
        )}
      </form>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Cancel                                                                     */
/* -------------------------------------------------------------------------- */

export function CancelMandateForm({ mandates }: { readonly mandates: readonly CancellableMandate[] }) {
  const [state, formAction, pending] = useActionState(
    cancelStandingOrderAction,
    CANCEL_MANDATE_IDLE,
  );
  const reasonId = useId();
  const none = mandates.length === 0;

  return (
    <Panel
      title="Stop a standing order"
      description="Records one cancellation row against the mandate. It stops the schedule producing further occurrences; occurrences it has already raised are payment instructions and are stopped in the approvals queue instead."
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mandate">
            <select name="standingOrderId" required disabled={pending || none} className={INPUT_CLASS}>
              {mandates.map((mandate) => (
                <option key={mandate.id} value={mandate.id}>
                  {mandate.reference} — {mandate.cadence}, next {mandate.nextDueDate ?? "no further date"}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Reason" hint="Why it stopped, for whoever reads this row in six months.">
            <input
              id={reasonId}
              name="reason"
              type="text"
              required
              minLength={3}
              maxLength={280}
              placeholder="Lease ended; payee confirmed by phone"
              disabled={pending || none}
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        <button type="submit" disabled={pending || none} className={BUTTON_CLASS}>
          {pending ? "Stopping…" : "Stop this mandate"}
        </button>

        {none ? (
          <p className="text-[11px] text-muted">
            Every mandate on this book is already cancelled, so there is nothing
            to stop.
          </p>
        ) : null}

        {state.status === "idle" ? null : (
          <Note
            emphasis={state.status === "refused"}
            title={
              state.status === "refused"
                ? `Refused — ${state.code ?? "UNNAMED"}`
                : state.status === "already"
                  ? "Already cancelled"
                  : "Stopped"
            }
          >
            <p>{state.message}</p>
            {state.issues === null ? null : <Issues issues={state.issues} />}
          </Note>
        )}
      </form>
    </Panel>
  );
}
