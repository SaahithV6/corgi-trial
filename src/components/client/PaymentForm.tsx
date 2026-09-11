"use client";

import Link from "next/link";
import type { Route } from "next";
import { useActionState, useId, useState } from "react";

import { raisePaymentAction, type RaiseResult } from "@/app/(app)/payments/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

/**
 * The customer's form for sending money.
 *
 * ===========================================================================
 * THIS IS NOT A SECOND MONEY-OUT PATH. IT IS THE SAME ONE.
 * ===========================================================================
 *
 * `raisePaymentAction` is imported from `src/app/(app)/payments/actions.ts` —
 * the staff console's own action, unchanged, not copied. It calls
 * `requestPayment()`, which runs the KYB gate inside its own transaction, pins
 * the approval policy version onto the row, runs the payee gate over the
 * destination, hashes the instruction over account, rail, amount, destination
 * and value date, and writes one `payment_instruction` row and one `requested`
 * event. NO MONEY MOVES HERE, from this form or from the staff one.
 *
 * The customer's form differs from the staff form in exactly two ways, and
 * neither is a rule:
 *
 *   1. The wording. "Who are you paying" rather than "destination"; "What is
 *      this for" rather than "reference".
 *   2. The account is not a field. The staff console picks from every deposit
 *      account on the book; here it is resolved on the SERVER from the business
 *      this page is scoped to and sent as a hidden input the customer never
 *      chooses from a list. A customer picking their own account id out of a
 *      dropdown of everyone's is the tenancy bug this whole surface exists to
 *      not have.
 *
 * The hidden `accountId` is not a security control — a hand-assembled POST can
 * carry any uuid. It does not need to be one: the id is checked by the same
 * gates whatever sends it, and this build's console is open anyway. It is here
 * because a form should not offer a choice that is not the customer's to make.
 *
 * ===========================================================================
 * NO NUMBERS ON THIS COMPONENT'S PROPS
 * ===========================================================================
 *
 * Every figure arrives as a string the server already formatted through
 * `formatUsd`, and the amount leaves as the literal characters somebody typed.
 * There is no arithmetic in this file and no `Number(...)` anywhere in it.
 * Whether the amount crosses the approval threshold is decided by two `bigint`s
 * compared inside a Postgres transaction, and the answer comes back on the
 * receipt.
 */

const IDLE: RaiseResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  receipt: null,
};

export type PayeeOption = {
  readonly payeeId: string;
  readonly label: string;
  readonly holderName: string;
  readonly rail: string;
  readonly routingNumber: string;
  readonly accountNumberLast4: string;
  readonly accountType: string;
  /** A standing warning nobody has signed for. The gate refuses these. */
  readonly warned: boolean;
};

export type RailOption = {
  readonly rail: string;
  readonly label: string;
  /** "$2,500.00" — formatted by the server. */
  readonly thresholdDisplay: string;
  readonly requiredApprovals: number;
  readonly note: string;
};

export function ClientPaymentForm({
  accountId,
  rails,
  payees,
  today,
  availableDisplay,
  approvalsHref,
  amountPrefill,
}: {
  readonly accountId: string;
  readonly rails: readonly RailOption[];
  readonly payees: readonly PayeeOption[];
  readonly today: string;
  readonly availableDisplay: string;
  readonly approvalsHref: string;
  /** `?state=edge` prefills exactly the threshold. A string, never a number. */
  readonly amountPrefill: string | null;
}) {
  const [state, formAction, pending] = useActionState(raisePaymentAction, IDLE);
  const ids = useId();

  const firstRail = rails[0]?.rail ?? "ach";
  const [rail, setRail] = useState(firstRail);
  const [payeeId, setPayeeId] = useState(payees[0]?.payeeId ?? "");

  const payee = payees.find((p) => p.payeeId === payeeId);
  const railOption = rails.find((r) => r.rail === rail);

  const issueFor = (path: string) =>
    state.issues?.find((issue) => issue.path === path)?.message ?? null;

  return (
    <div className="space-y-4">
      {/*
        THE KYB REFUSAL IS RENDERED BY `PayView`, ABOVE THIS FORM, AND THE
        BUTTON IS NOT DISABLED BY IT.

        This is the opposite of the approvals screen's disabled Approve button
        and the difference is deliberate. There, the refusal is a fact about
        YOU — you raised this payment — and it is settled before you press
        anything. Here it is a fact about the BUSINESS, read outside any
        transaction, seconds ago; the decision is re-taken inside
        `requestPayment()`'s own transaction. A form that pre-empted it would
        be the screen claiming to know an answer only the database has.
      */}
      <form action={formAction} className="space-y-5">
        {/* Resolved on the server from the business this page is scoped to. */}
        <input type="hidden" name="accountId" value={accountId} />

        {/* The destination fields the action expects, filled from the payee the
            customer chose. Assembled here and validated NOWHERE here:
            `destinationSchema` inside `requestPayment()` is the validator, and
            pre-repairing a value before the real validator sees it is worse
            than sending it wrong. */}
        <input type="hidden" name="holderName" value={payee?.holderName ?? ""} />
        <input
          type="hidden"
          name="routingNumber"
          value={rail === "ach" ? (payee?.routingNumber ?? "") : ""}
        />
        <input
          type="hidden"
          name="wireRoutingNumber"
          value={rail === "wire" ? (payee?.routingNumber ?? "") : ""}
        />
        <input
          type="hidden"
          name="accountNumberLast4"
          value={payee?.accountNumberLast4 ?? ""}
        />
        <input type="hidden" name="accountType" value={payee?.accountType ?? ""} />

        <div className="grid gap-5 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Who are you paying?</span>
            <select
              value={payeeId}
              onChange={(event) => setPayeeId(event.target.value)}
              className={`rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING}`}
            >
              {payees.length === 0 ? (
                <option value="">No confirmed payees yet</option>
              ) : (
                payees.map((option) => (
                  <option key={option.payeeId} value={option.payeeId}>
                    {option.label}
                  </option>
                ))
              )}
            </select>
            <span className="text-xs text-muted">
              {payees.length === 0
                ? "A payee has to be confirmed before you can pay them — the account number is checked before any money leaves."
                : payee?.warned === true
                  ? "This payee raised a warning when we checked them and nobody has signed for it. Sending will be refused until somebody does."
                  : "We checked this account number when it was added. Paying someone new starts with that check."}
            </span>
          </label>

          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium">How should it go?</legend>
            <select
              name="rail"
              value={rail}
              onChange={(event) => setRail(event.target.value)}
              className={`rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING}`}
            >
              {rails.map((option) => (
                <option key={option.rail} value={option.rail}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted">
              {railOption === undefined
                ? "Choose how the money should travel."
                : railOption.requiredApprovals === 0
                  ? railOption.note
                  : `${railOption.thresholdDisplay} or more needs ${railOption.requiredApprovals} other person to approve it. ${railOption.note}`}
            </span>
          </fieldset>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">How much?</span>
            <input
              name="amount"
              inputMode="decimal"
              defaultValue={amountPrefill ?? ""}
              placeholder="0.00"
              aria-describedby={`${ids}-amount-hint`}
              className={`money rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING}`}
            />
            <span id={`${ids}-amount-hint`} className="text-xs text-muted">
              In dollars and cents. You can spend {availableDisplay} right now.
            </span>
            {issueFor("amount") === null ? null : (
              <span className="text-xs text-negative">{issueFor("amount")}</span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">When should it leave?</span>
            <input
              name="valueDate"
              type="date"
              defaultValue={today}
              className={`rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING}`}
            />
            <span className="text-xs text-muted">
              Today is {today} on your bank&rsquo;s calendar, which is not always
              the same as your computer&rsquo;s.
            </span>
          </label>

          <label className="flex flex-col gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium">What is this for?</span>
            <input
              name="reference"
              placeholder="INV-2041, payroll 2026-09, ticket 88"
              className={`rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING}`}
            />
            <span className="text-xs text-muted">
              The invoice or run this pays. Send the same one twice and you get
              the first payment back rather than a second payment — so a
              double-click cannot pay a supplier twice.
            </span>
            {issueFor("reference") === null ? null : (
              <span className="text-xs text-negative">{issueFor("reference")}</span>
            )}
          </label>
        </div>

        <button
          type="submit"
          disabled={pending}
          className={`rounded border border-border-strong bg-surface-raised px-4 py-2 text-sm font-medium ${FOCUS_RING} disabled:opacity-60`}
        >
          {pending ? "Sending…" : "Send for approval"}
        </button>
      </form>

      {state.status === "refused" ? (
        <div className="rounded-md border border-negative/40 bg-surface-raised px-4 py-3">
          <p className="text-xs font-semibold text-negative">
            Not sent{state.code === null ? "" : ` · ${state.code}`}
          </p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {state.message}
          </p>
          <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
            Nothing was written. Your balance has not changed.
          </p>
        </div>
      ) : null}

      {state.status === "ok" && state.receipt !== null ? (
        <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
          <p className="text-xs font-semibold">
            {state.receipt.created
              ? "Sent for approval"
              : "You had already asked for this one"}
          </p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {state.receipt.amountDisplay} to your payee, dated{" "}
            {state.receipt.valueDate}.{" "}
            {state.receipt.needsApproval
              ? `It needs ${state.receipt.approvalsRequired} other person to approve it before it leaves. No money has moved.`
              : "It is under the amount that needs a second person, so nobody else has to approve it. No money has moved yet."}
          </p>
          <p className="mt-2 text-[11px] text-muted">
            Reference <code>{state.receipt.instructionId}</code>
          </p>
          <p className="mt-2">
            <Link
              href={`${approvalsHref}${approvalsHref.includes("?") ? "&" : "?"}payment=${state.receipt.instructionId}` as Route}
              className={`text-xs underline underline-offset-4 ${FOCUS_RING}`}
            >
              Track this payment
            </Link>
          </p>
        </div>
      ) : null}
    </div>
  );
}
