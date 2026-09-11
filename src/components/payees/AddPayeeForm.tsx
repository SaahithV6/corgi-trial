"use client";

import { useActionState, useId, useMemo, useState } from "react";

import { addPayeeAction, type ConfirmResult } from "@/app/(app)/payees/actions";
import { FieldLabel, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";
import { explainRoutingNumber } from "@/lib/payees/explain";
import { accountNumberEntryAgrees } from "@/lib/payees/verify";

import { AbaWorking } from "./AbaWorking";
import { ConfirmationResult } from "./ConfirmationResult";

/**
 * Add a beneficiary to the payee book, and check it on the way in.
 *
 * ============================================================================
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DO, AND DOES NOT.
 *
 * 1. IT DOES NOT DECIDE ANYTHING. The arithmetic it draws as you type is a
 *    PREVIEW: `explainRoutingNumber()` is pure and runs in the browser so the
 *    working appears before a round trip, and then the server recomputes it
 *    from the string that was actually posted, `verifyPayee()` runs the whole
 *    ladder again, and `payee_routing_number_possible` — a CHECK constraint —
 *    has the last word. Three evaluations of one rule, and the browser's is
 *    the only one nothing depends on.
 *
 * 2. IT NEVER SENDS THE FULL ACCOUNT NUMBER. The number is typed twice because
 *    re-entry is the only defence the United States leaves against an
 *    account-number typo — there is no check digit on a US account number, no
 *    length rule, no character rule. The two typings are compared HERE, by the
 *    same `accountNumberEntryAgrees()` the library exports, and only the last
 *    four digits are posted. `payee` stores four digits and never more, so
 *    shipping the whole number to a server that would immediately discard it
 *    would put it in a request body and a platform log to buy nothing.
 *
 *    THE RE-ENTRY CHECK IS NOT A CONTROL, which is exactly why it is allowed
 *    to live in the browser. Two different strings are a contradiction in the
 *    FORM, not a fact about a bank; `verify.ts` keeps it out of the
 *    block/warn ladder for that reason, and a POST assembled by hand skips it
 *    and meets every check that matters unchanged.
 *
 * 3. IT SHOWS THE ARITHMETIC, NOT A VERDICT — and it shows no continue control
 *    in the blocked branch. Not disabled: absent. A disabled button says "you
 *    may not do this", which invites somebody to find out who can, and for
 *    arithmetic there is nobody. The submit button stays live while you type,
 *    because pressing it against an impossible number is how you see the
 *    database refuse it rather than a stylesheet.
 * ============================================================================
 */

const IDLE: ConfirmResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  receipt: null,
};

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

export type BusinessChoice = {
  readonly id: string;
  readonly legalName: string;
  readonly payeeCount: number;
};

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly htmlFor: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <label className={LABEL_CLASS} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint === undefined ? null : (
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">{hint}</p>
      )}
    </div>
  );
}

export function AddPayeeForm({ businesses }: { readonly businesses: readonly BusinessChoice[] }) {
  const [state, formAction, pending] = useActionState(addPayeeAction, IDLE);
  const ids = useId();

  const [businessId, setBusinessId] = useState<string>(businesses[0]?.id ?? "");
  const [rail, setRail] = useState<"ach" | "wire">("ach");
  const [routingNumber, setRoutingNumber] = useState("");
  const [accountNumber, setAccountNumber] = useState("");
  const [accountNumberAgain, setAccountNumberAgain] = useState("");

  const explanation = useMemo(() => explainRoutingNumber(routingNumber), [routingNumber]);

  const entriesAgree = accountNumberEntryAgrees(accountNumber, accountNumberAgain);
  const digitsOnly = accountNumber.replace(/[\s-]/g, "");
  const last4 = entriesAgree && digitsOnly.length >= 4 ? digitsOnly.slice(-4) : "";

  const chosen = businesses.find((b) => b.id === businessId) ?? null;

  return (
    <div className="space-y-6">
      <Panel
        title="Add a payee"
        description="A beneficiary, and the check that runs before they are on the book. No money moves here and no journal entry is written — a payee is not a payment."
      >
        <form action={formAction} className="space-y-5 px-5 py-4">
          <input type="hidden" name="accountNumberLast4" value={last4} />

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="business"
              htmlFor={`${ids}-business`}
              hint={
                chosen === null
                  ? undefined
                  : chosen.payeeCount === 0
                    ? "This book has no payees yet, so the twin probe — the only account-number check a book of last-four digits can perform — has nothing to compare against. A clean check here is a weaker statement than a clean check on an established book, and the findings below will say so."
                    : `${chosen.payeeCount} payee${chosen.payeeCount === 1 ? "" : "s"} already on this book. The twin probe compares the name you type against every one of them.`
              }
            >
              <select
                id={`${ids}-business`}
                name="businessId"
                required
                value={businessId}
                onChange={(event) => setBusinessId(event.target.value)}
                className={INPUT_CLASS}
              >
                {businesses.map((business) => (
                  <option key={business.id} value={business.id}>
                    {business.legalName}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="source reference"
              htmlFor={`${ids}-reference`}
              hint="The supplier record, invoice or ticket this beneficiary comes from. The idempotency key is derived from it, so keying the same supplier twice returns the payee that already exists instead of putting a second copy of one bank detail on the book."
            >
              <input
                id={`${ids}-reference`}
                name="reference"
                required
                maxLength={120}
                placeholder="SUP-2026-0412"
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="what you call them"
              htmlFor={`${ids}-display`}
              hint="A folder name for your own book. Never sent anywhere, and never the thing asserted to a bank."
            >
              <input
                id={`${ids}-display`}
                name="displayName"
                required
                maxLength={200}
                placeholder="Green coffee — monthly"
                className={INPUT_CLASS}
              />
            </Field>

            <Field
              label="beneficiary name"
              htmlFor={`${ids}-holder`}
              hint="The name that goes on the payment, and the string the name check compares. This is the name on the invoice, not the nickname."
            >
              <input
                id={`${ids}-holder`}
                name="holderName"
                required
                maxLength={200}
                placeholder="Ridgeline Coffee Roasters LLC"
                className={INPUT_CLASS}
              />
            </Field>
          </div>

          <fieldset>
            <legend className={LABEL_CLASS}>rail</legend>
            <div className="mt-1 flex flex-wrap gap-4">
              {(["ach", "wire"] as const).map((option) => (
                <label key={option} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="rail"
                    value={option}
                    checked={rail === option}
                    onChange={() => setRail(option)}
                    className={FOCUS_RING}
                  />
                  {option === "ach" ? "ACH" : "Wire (Fedwire)"}
                </label>
              ))}
            </div>
            <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
              ACH and wire are the two rails addressed by a nine-digit ABA, so they are the two
              rails this form has anything to check. USDC carries its own EIP-55 checksum and an
              internal transfer never leaves this book; putting either behind this panel would be
              a confirmation step that confirms nothing, wearing the same frame as one that does.
            </p>
          </fieldset>

          <Field
            label={rail === "wire" ? "wire routing number" : "ACH routing number"}
            htmlFor={`${ids}-routing`}
            hint={
              rail === "wire"
                ? "A bank's WIRE ABA is a DIFFERENT NUMBER from its ACH ABA — 021000021 against 011401533 on the seeded Plaid item — and substituting one for the other is an R13 days later. Take it from the beneficiary's own wire instructions, not from a cheque."
                : "Printed on the bottom left of a cheque. Published, not secret, which is why it is shown here in full: masking it would protect nothing and hide the only thing that makes a transposition legible."
            }
          >
            <input
              id={`${ids}-routing`}
              name="routingNumber"
              required
              inputMode="numeric"
              maxLength={40}
              autoComplete="off"
              value={routingNumber}
              onChange={(event) => setRoutingNumber(event.target.value)}
              placeholder="011401533"
              className={`${INPUT_CLASS} font-mono tracking-[0.2em]`}
            />
          </Field>

          <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              the check digit, as it is computed
            </p>
            <AbaWorking
              explanation={explanation}
              railLabel={rail === "wire" ? "WIRE ABA" : "ACH ABA"}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="account number"
              htmlFor={`${ids}-account`}
              hint="Typed twice, and compared in this browser. Only the last four digits are posted — the full number is never sent to the server and there is nowhere in this schema to put one."
            >
              <input
                id={`${ids}-account`}
                type="password"
                inputMode="numeric"
                autoComplete="off"
                maxLength={40}
                required
                value={accountNumber}
                onChange={(event) => setAccountNumber(event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>

            <Field label="account number again" htmlFor={`${ids}-account-again`}>
              <input
                id={`${ids}-account-again`}
                type="text"
                inputMode="numeric"
                autoComplete="off"
                maxLength={40}
                required
                value={accountNumberAgain}
                onChange={(event) => setAccountNumberAgain(event.target.value)}
                className={`${INPUT_CLASS} font-mono`}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-muted" aria-live="polite">
                {accountNumber.length === 0 && accountNumberAgain.length === 0
                  ? "The United States puts no check digit on an account number: no length rule, no character rule, no checksum. The arithmetic that saves the routing number saves nothing here, and re-entry is what is left."
                  : entriesAgree
                    ? `The two entries agree. ••${last4} is what goes on the book.`
                    : "The two entries do not agree. That is a contradiction in this form rather than a fact about a bank, so it is not a finding and it never reaches the check — it just has to be resolved before there is a number to post."}
              </p>
            </Field>
          </div>

          {rail === "ach" ? (
            <Field
              label="account type"
              htmlFor={`${ids}-type`}
              hint="ACH carries one and a wire does not. `payee_rail_fields` is a CHECK constraint: a wire row with an account type on it cannot be stored."
            >
              <select id={`${ids}-type`} name="accountType" className={INPUT_CLASS}>
                <option value="checking">checking</option>
                <option value="savings">savings</option>
              </select>
            </Field>
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <button
              type="submit"
              disabled={pending || last4.length !== 4}
              className={`rounded border border-border-strong px-3 py-1.5 text-sm font-medium ${FOCUS_RING} disabled:opacity-50`}
            >
              {pending ? "Running the check" : "Check and add"}
            </button>
            <p className="text-[11px] leading-relaxed text-muted" aria-live="polite">
              {last4.length === 4
                ? "Runs the arithmetic, then Increase's routing-number directory on a live call, then the twin probe against this book. One row at the end of it, whichever way it goes."
                : "Enter the account number twice to enable this. The button is disabled for a missing field, never for a failing check — a failing check has to be seen refusing."}
            </p>
          </div>

          {state.issues === null ? null : (
            <ul className="space-y-1">
              {state.issues.map((issue) => (
                <li key={`${issue.path}:${issue.message}`} className="text-[11px] text-muted">
                  <span className="font-mono text-text">{issue.path}</span> — {issue.message}
                </li>
              ))}
            </ul>
          )}

          {state.status === "refused" && state.receipt === null ? (
            <Note emphasis title={state.code ?? "Refused"}>
              <p>{state.message}</p>
            </Note>
          ) : null}
        </form>
      </Panel>

      {state.receipt === null ? null : (
        <ConfirmationResult
          receipt={state.receipt}
          headline={state.message}
          code={state.code}
          refused={state.status === "refused"}
        />
      )}

      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        <FieldLabel>what a clean answer here does not mean</FieldLabel> The arithmetic proves the
        routing number is possible and the directory can confirm the institution exists. Neither
        says anything about the account number, and no provider in this system can tell you the
        name on a third party&rsquo;s US account — so a check with no findings is a check that
        found nothing, which is not the same as somebody confirming the beneficiary.
      </p>
    </div>
  );
}
