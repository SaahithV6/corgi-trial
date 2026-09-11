"use client";

import { useActionState, useId } from "react";

import {
  acceptQuoteAction,
  requestQuoteAction,
  sendPayoutAction,
  type AcceptActionResult,
  type Issue,
  type QuoteActionResult,
  type SendActionResult,
} from "@/app/(app)/payouts/actions";
import { FOCUS_RING, Note, Panel } from "@/components/ui/primitives";

import type { BusinessOptionView, CorridorOptionView, QuoteView } from "./data-contract";

/**
 * The three steps, as three forms: quote, accept, send.
 *
 * ── FOUR THINGS THESE FORMS ARE CAREFUL NOT TO DO ───────────────────────────
 *
 * 1. THEY PERFORM NO ARITHMETIC ON MONEY. The amount is the literal characters
 *    somebody typed, sent as text. Every figure that comes back — the fee, the
 *    rate, the delivery amount — was computed on the server in `bigint` cents
 *    and integer-scaled rates, and by the database itself for the commitment.
 *    The browser renders characters.
 *
 * 2. THEY ARE NOT THE VALIDATION. The `required`s and the `pattern`s are
 *    conveniences for somebody filling this in at speed. Every one is
 *    re-decided by the zod schemas in `actions.ts`, and a POST assembled by
 *    hand with none of these fields reaches exactly the same refusals.
 *
 * 3. THE ACCEPT BUTTON IS NEVER DISABLED BY THE COUNTDOWN. Same reasoning the
 *    payments and pots forms give for not disabling on balance: the refusal is
 *    the most instructive thing this screen can show, and a greyed-out button
 *    demonstrates nothing. Pressing accept on an expired offer sends a real
 *    request, and `fx_quote_acceptance_guard()` in the database refuses it
 *    with a real code. A client-side clock is not a control.
 *
 * 4. THE SEND BUTTON DOES NOT SEND. It runs the gate and reports the verdict.
 *    The panel says so above the button, not in a tooltip — see actions.ts for
 *    why signing lives in the operator CLI and not on a public URL.
 */

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";
const BUTTON_CLASS = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;

const QUOTE_IDLE: QuoteActionResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  quoteRef: null,
};

const ACCEPT_IDLE: AcceptActionResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  quoteRef: null,
};

const SEND_IDLE: SendActionResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  command: null,
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

function Issues({ issues }: { readonly issues: readonly Issue[] }) {
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

function Outcome({
  code,
  message,
  refused,
}: {
  readonly code: string | null;
  readonly message: string;
  readonly refused: boolean;
}) {
  return (
    <Note emphasis={refused} title={refused ? (code ?? "Refused") : "Done"}>
      <p>{message}</p>
    </Note>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Request a quote                                                         */
/* -------------------------------------------------------------------------- */

export function RequestQuoteForm({
  businesses,
  corridors,
  terms,
  disabled,
}: {
  readonly businesses: readonly BusinessOptionView[];
  readonly corridors: readonly CorridorOptionView[];
  readonly terms: {
    readonly feeFlatLabel: string;
    readonly feeBpsLabel: string;
    readonly spreadBpsLabel: string;
    readonly ttlSeconds: number;
  };
  readonly disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(requestQuoteAction, QUOTE_IDLE);
  const businessId = useId();
  const currencyId = useId();
  const amountId = useId();
  const beneficiaryId = useId();
  const addressId = useId();

  return (
    <Panel
      id="request-quote"
      title="1 · Request a quote"
      description={`Fetches a mid rate from a real, free, keyless source and writes an offer that stands for ${terms.ttlSeconds} seconds. Nothing is committed by this step.`}
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Customer">
            <select id={businessId} name="businessId" className={INPUT_CLASS} disabled={disabled} required>
              {businesses.map((b) => (
                <option key={b.businessId} value={b.businessId}>
                  {b.legalName}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Destination currency"
            hint="A short, closed list. We do not quote a currency nobody at the far end could pay a beneficiary in."
          >
            <select id={currencyId} name="buyCurrency" className={INPUT_CLASS} disabled={disabled} required>
              {corridors.map((c) => (
                <option key={c.currency} value={c.currency}>
                  {c.currency} — {c.name}, {c.destination}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Amount in (USD)"
            hint={`Cents, two decimal places at most. The fee is ${terms.feeFlatLabel} plus ${terms.feeBpsLabel}, and our spread is ${terms.spreadBpsLabel} off the mid — both are shown as their own lines on the quote.`}
          >
            <input
              id={amountId}
              name="amount"
              className={INPUT_CLASS}
              inputMode="decimal"
              placeholder="1000.00"
              defaultValue="1000.00"
              disabled={disabled}
              required
            />
          </Field>

          <Field label="Beneficiary" hint="What the customer calls them. Never a bank account number.">
            <input
              id={beneficiaryId}
              name="beneficiaryRef"
              className={INPUT_CLASS}
              placeholder="Guadalajara parts supplier"
              disabled={disabled}
              required
            />
          </Field>
        </div>

        <Field
          label="Destination address (optional)"
          hint="The wallet the USDC leg pays. When a quote names one, the gate refuses a payout to anywhere else — a commitment is to pay a particular beneficiary, not a bearer instrument. Leave it empty to agree the price now and arrange the plumbing afterwards."
        >
          <input
            id={addressId}
            name="destinationAddress"
            className={INPUT_CLASS}
            placeholder="0x…"
            pattern="^0x[0-9a-fA-F]{40}$"
            disabled={disabled}
          />
        </Field>

        <button type="submit" className={BUTTON_CLASS} disabled={disabled || pending}>
          {pending ? "Fetching the rate…" : "Request a quote"}
        </button>

        {state.issues === null ? null : <Issues issues={state.issues} />}
        {state.status === "idle" ? null : (
          <Outcome code={state.code} message={state.message} refused={state.status === "refused"} />
        )}
      </form>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Accept it                                                               */
/* -------------------------------------------------------------------------- */

export function AcceptQuoteForm({
  quote,
  disabled,
  description,
  children,
}: {
  readonly quote: QuoteView;
  readonly disabled: boolean;
  /** Overridden on an expired offer, where the panel has a different thing to say. */
  readonly description?: string;
  /** Shown above the form. The expired state puts its explanation here. */
  readonly children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState(acceptQuoteAction, ACCEPT_IDLE);
  const referenceId = useId();

  return (
    <Panel
      id="accept-quote"
      title="2 · Accept the rate"
      description={
        description ??
        "Acceptance is a row, not an edit. Whether it is allowed is decided by a trigger in the database against the quote's own expiry — not by this button and not by the countdown."
      }
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        {children}
        <input type="hidden" name="quoteRef" value={quote.quoteRef} />

        <Field
          label="Your reference (optional)"
          hint="What this payout settles. Recorded on the acceptance, so the commitment can be tied back to the invoice it paid."
        >
          <input
            id={referenceId}
            name="reference"
            className={INPUT_CLASS}
            placeholder="INV-2291"
            disabled={disabled}
          />
        </Field>

        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Accepting fixes <span className="money">{quote.buyLabel}</span> as the amount the
          beneficiary receives, for <span className="money">{quote.sellLabel}</span>, for the next{" "}
          {Math.round(quote.settlementWindowSeconds / 3600)} hours — whatever the market does in
          between. That difference is ours, in both directions.
        </p>

        <button type="submit" className={BUTTON_CLASS} disabled={disabled || pending}>
          {pending ? "Accepting…" : `Accept ${quote.quoteRef}`}
        </button>

        {state.issues === null ? null : <Issues issues={state.issues} />}
        {state.status === "idle" ? null : (
          <Outcome code={state.code} message={state.message} refused={state.status === "refused"} />
        )}
      </form>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Send it — the gate, and only the gate                                   */
/* -------------------------------------------------------------------------- */

export function SendPayoutForm({
  quote,
  disabled,
}: {
  readonly quote: QuoteView;
  readonly disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(sendPayoutAction, SEND_IDLE);
  const amountId = useId();
  const toId = useId();

  return (
    <Panel
      id="send-payout"
      title="3 · Send it"
      description="Runs the gate that stands in front of every cross-border payout. It does not broadcast."
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        <input type="hidden" name="quoteRef" value={quote.quoteRef} />

        <Note title="This button does not move money, and here is exactly why">
          <p>
            Signing a Base Sepolia transfer needs the wallet key, and the sanctioned path for that
            is <code>scripts/payout-usdc.mjs</code> — an operator CLI that prints the transaction
            hash <strong>before</strong> it broadcasts, so a crash between the two is recoverable.
            A button on a public URL that signs on every click is a worse design, and a
            three-minute wait for a receipt does not fit in a serverless function anyway.
          </p>
          <p className="mt-2">
            What this button does run is the real predicate, against the real database:{" "}
            <code>requireAcceptedQuote()</code>. An unaccepted or expired quote gets a genuine
            refusal with a genuine code. A cleared one gets the command that will send it.
          </p>
        </Note>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="USDC this payout would send"
            hint="Six decimal places at most. What actually leaves is decided at settlement by the market — the gate only refuses more than the customer authorised."
          >
            <input
              id={amountId}
              name="amountUsdc"
              className={INPUT_CLASS}
              inputMode="decimal"
              placeholder="996.50"
              disabled={disabled}
              required
            />
          </Field>

          <Field label="To" hint="Checked against the quote when the quote names a destination.">
            <input
              id={toId}
              name="toAddress"
              className={INPUT_CLASS}
              placeholder="0x…"
              defaultValue={quote.destinationAddress ?? ""}
              pattern="^0x[0-9a-fA-F]{40}$"
              disabled={disabled}
            />
          </Field>
        </div>

        <button type="submit" className={BUTTON_CLASS} disabled={disabled || pending}>
          {pending ? "Running the gate…" : "Run the payout gate"}
        </button>

        {state.issues === null ? null : <Issues issues={state.issues} />}
        {state.status === "idle" ? null : (
          <Outcome code={state.code} message={state.message} refused={state.status === "refused"} />
        )}
        {state.command === null ? null : (
          <pre className="overflow-x-auto rounded border border-border bg-surface-raised px-4 py-3 text-[11px] leading-relaxed">
            {state.command}
          </pre>
        )}
      </form>
    </Panel>
  );
}
