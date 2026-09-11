"use client";

import { useActionState, useId } from "react";

import {
  createClientPotAction,
  moveClientPotAction,
  transferBetweenClientPotsAction,
} from "@/app/(app)/client/pots/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

import {
  POT_ACTION_IDLE,
  type PotActionResult,
} from "./action-state";

/**
 * The customer's three pot forms.
 *
 * ===========================================================================
 * NO NUMBERS ON THESE PROPS
 * ===========================================================================
 *
 * Every figure arrives as a string the server already formatted through
 * `formatUsd` while it still held a `bigint`, and the amount leaves as the
 * literal characters somebody typed. There is no arithmetic in this file and
 * no `Number(...)` anywhere in it. Whether a move is allowed is decided by two
 * `bigint`s compared inside a Postgres transaction, behind
 * `lock_business_deposits()`, and the answer comes back on the receipt.
 * `ClientPaymentForm` holds the same line for the same reason.
 *
 * ===========================================================================
 * THE BUTTON IS NEVER DISABLED BY A BALANCE
 * ===========================================================================
 *
 * A form that greys itself out because the amount looks too large is asserting
 * a rule on the browser's copy of a figure that may already be stale. The
 * decision belongs to `decideMove()` behind the lock, and the refusal it
 * writes names the pot, the four terms and the shortfall. Letting somebody
 * press the button and read that sentence is more useful, and more honest,
 * than a disabled control that explains nothing.
 */

/** A pot as the forms need it: a name to choose and a balance to read. */
export type PotOption = {
  readonly potId: string;
  readonly name: string;
  /** "$1,250.00" — formatted by the server. */
  readonly balanceDisplay: string;
};

const FIELD = `w-full rounded border border-border-strong bg-surface px-2 py-1.5 text-sm ${FOCUS_RING}`;
const BUTTON = `rounded border border-border-strong px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:opacity-60`;

function Result({ state }: { readonly state: PotActionResult }) {
  if (state.status === "idle") return null;
  const refused = state.status === "refused";
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-md border px-4 py-3 ${
        refused ? "border-negative/40 bg-surface-raised" : "border-border bg-surface-raised"
      }`}
    >
      <p className={`text-xs font-semibold ${refused ? "text-negative" : "text-text"}`}>
        {refused ? (state.code ?? "Refused") : "Done"}
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>
      {state.facts.length === 0 ? null : (
        <dl className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          {state.facts.map((fact) => (
            <div key={fact.label} className="flex items-baseline justify-between gap-3">
              <dt className="text-[11px] text-muted">{fact.label}</dt>
              <dd className={`text-xs ${fact.mono === true ? "money break-all" : "money"}`}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Open a pot                                                              */
/* -------------------------------------------------------------------------- */

export function OpenPotForm({ businessId }: { readonly businessId: string }) {
  const [state, formAction, pending] = useActionState(
    createClientPotAction,
    POT_ACTION_IDLE,
  );
  const ids = useId();

  return (
    <div className="space-y-4 px-5 py-5">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="businessId" value={businessId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${ids}-name`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              What do you call it
            </span>
            <input
              id={`${ids}-name`}
              name="name"
              required
              maxLength={60}
              placeholder="Payroll"
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-purpose`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              What is it for (optional)
            </span>
            <input
              id={`${ids}-purpose`}
              name="purpose"
              maxLength={200}
              placeholder="Wages, the 28th of each month"
              className={FIELD}
            />
          </label>
        </div>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          The name is how you will refer to this money out loud, so it has to be
          unique on your account &mdash; two pots called Payroll would make
          &ldquo;move it to Payroll&rdquo; ambiguous, which is the only thing a
          pot name is for.
        </p>
        <button type="submit" disabled={pending} className={BUTTON}>
          {pending ? "Opening…" : "Open this pot"}
        </button>
      </form>
      <Result state={state} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Move money in, or back out                                              */
/* -------------------------------------------------------------------------- */

export function MovePotForm({
  businessId,
  pots,
  availableDisplay,
}: {
  readonly businessId: string;
  readonly pots: readonly PotOption[];
  readonly availableDisplay: string;
}) {
  const [state, formAction, pending] = useActionState(
    moveClientPotAction,
    POT_ACTION_IDLE,
  );
  const ids = useId();

  return (
    <div className="space-y-4 px-5 py-5">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="businessId" value={businessId} />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1" htmlFor={`${ids}-pot`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              Which pot
            </span>
            <select id={`${ids}-pot`} name="potId" className={FIELD}>
              {pots.map((pot) => (
                <option key={pot.potId} value={pot.potId}>
                  {pot.name} — {pot.balanceDisplay}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-amount`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              How much
            </span>
            <input
              id={`${ids}-amount`}
              name="amount"
              required
              inputMode="decimal"
              placeholder="250.00"
              className={`${FIELD} money`}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-reference`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              What is this for
            </span>
            <input
              id={`${ids}-reference`}
              name="reference"
              required
              maxLength={80}
              placeholder="payroll-2026-09"
              className={FIELD}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            name="direction"
            value="in"
            disabled={pending}
            className={BUTTON}
          >
            {pending ? "Working…" : "Set aside in this pot"}
          </button>
          <button
            type="submit"
            name="direction"
            value="out"
            disabled={pending}
            className={BUTTON}
          >
            {pending ? "Working…" : "Release back to my balance"}
          </button>
        </div>
        {/* SAID OUT LOUD, because the browser decides this and the screen was
            letting it decide silently. Two buttons that move money in opposite
            directions, and pressing Enter in either box performs the FIRST one
            — measured, not assumed: typing an amount and a reference and
            pressing Enter set $10.00 aside without anybody having pressed a
            button. Standard HTML, and a fine default; a money form must not
            leave it to be discovered. */}
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Pressing Enter in either box does the same as{" "}
          <strong className="font-medium text-text">Set aside in this pot</strong>.
          To take money back out, press{" "}
          <strong className="font-medium text-text">
            Release back to my balance
          </strong>{" "}
          yourself.
        </p>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          You have {availableDisplay} available to set aside. Available is your
          ledger balance less card holds, credits that have not cleared, and
          payments already committed &mdash; money a pot is not allowed to
          earmark, because a card settlement is about to take it. Releasing is
          capped by the pot instead: a pot may be drained to exactly $0.00, and
          one cent past that is refused.
        </p>
      </form>
      <Result state={state} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Move money from one pot to another                                      */
/* -------------------------------------------------------------------------- */

export function PotToPotForm({
  businessId,
  pots,
}: {
  readonly businessId: string;
  readonly pots: readonly PotOption[];
}) {
  const [state, formAction, pending] = useActionState(
    transferBetweenClientPotsAction,
    POT_ACTION_IDLE,
  );
  const ids = useId();

  return (
    <div className="space-y-4 px-5 py-5">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="businessId" value={businessId} />
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${ids}-from`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              Out of
            </span>
            <select id={`${ids}-from`} name="fromPotId" className={FIELD}>
              {pots.map((pot) => (
                <option key={pot.potId} value={pot.potId}>
                  {pot.name} — {pot.balanceDisplay}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-to`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              Into
            </span>
            <select
              id={`${ids}-to`}
              name="toPotId"
              defaultValue={pots[1]?.potId ?? ""}
              className={FIELD}
            >
              {pots.map((pot) => (
                <option key={pot.potId} value={pot.potId}>
                  {pot.name} — {pot.balanceDisplay}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1" htmlFor={`${ids}-amount`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              How much
            </span>
            <input
              id={`${ids}-amount`}
              name="amount"
              required
              inputMode="decimal"
              placeholder="250.00"
              className={`${FIELD} money`}
            />
          </label>
          <label className="flex flex-col gap-1" htmlFor={`${ids}-reference`}>
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              What is this for
            </span>
            <input
              id={`${ids}-reference`}
              name="reference"
              required
              maxLength={80}
              placeholder="moving-vat-to-payroll"
              className={FIELD}
            />
          </label>
        </div>
        <button type="submit" disabled={pending} className={BUTTON}>
          {pending ? "Working…" : "Move it"}
        </button>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          This is two entries, not one: the money is released out of the first
          pot and then earmarked into the second. If the second half is refused
          the money is sitting in your main balance, spendable, and this form
          says so with both figures on it. Nothing is lost either way &mdash;
          your total never changes, because the money never leaves your account.
        </p>
      </form>
      <Result state={state} />
    </div>
  );
}
