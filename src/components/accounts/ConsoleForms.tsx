"use client";

/**
 * The controls. Everything on this screen that writes lives in this file.
 *
 * Three properties they all share, and each one is there because its absence
 * is a way to lie to an operator:
 *
 *   PENDING IS VISIBLE. `useFormStatus` disables the button and renames it
 *   while the action is in flight. A provider round trip plus a webhook is
 *   seconds, and a control that looks idle for seconds gets pressed twice.
 *
 *   THE RESULT IS ATTACHED TO THE CONTROL THAT PRODUCED IT. `useActionState`
 *   per form, rendered directly beneath it, so a refusal on the clearing form
 *   can never be read as a refusal of the authorisation.
 *
 *   THREE OUTCOMES, NOT TWO. `ok`, `failed`, and `pending` — the last meaning
 *   "the provider accepted it and the ledger has not shown it yet". That state
 *   is real: a simulation fires a webhook into the deployed system, and a
 *   console that only knew about success and failure would have to guess.
 *
 * Money crosses from the action as a decimal string of integer cents and is
 * turned back into `bigint` here. No amount in this file is ever a `number`.
 */

import Link from "next/link";
import { useActionState, useId } from "react";
import { useFormStatus } from "react-dom";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  IDLE_RESULT,
  balanceDelta,
  centsFrom,
  type BalanceFacts,
  type ConsoleActionResult,
} from "./action-result";

/* -------------------------------------------------------------------------- */
/* Shared chrome                                                              */
/* -------------------------------------------------------------------------- */

const INPUT_CLASS =
  "w-full rounded border border-border-strong bg-surface px-2.5 py-1.5 text-sm placeholder:text-muted";

const BUTTON_CLASS =
  "inline-flex items-center justify-center rounded border border-border-strong bg-surface-raised px-3 py-1.5 text-xs font-medium hover:bg-background disabled:cursor-not-allowed disabled:opacity-60";

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
    <label className="block">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      <span className="mt-1 block">{children}</span>
      {hint === undefined ? null : (
        <span className="mt-1 block text-[11px] leading-relaxed text-muted">{hint}</span>
      )}
    </label>
  );
}

/**
 * The submit button, with its own pending copy.
 *
 * `useFormStatus` has to be read by a component INSIDE the form, which is why
 * this is a component rather than a prop.
 */
function Submit({
  label,
  pendingLabel,
  disabled = false,
}: {
  readonly label: string;
  readonly pendingLabel: string;
  readonly disabled?: boolean;
}) {
  const status = useFormStatus();
  return (
    <button
      type="submit"
      disabled={status.pending || disabled}
      aria-disabled={status.pending || disabled}
      className={`${BUTTON_CLASS} ${FOCUS_RING}`}
    >
      {status.pending ? pendingLabel : label}
    </button>
  );
}

const STATUS_LABEL = {
  ok: "done",
  pending: "not yet in the ledger",
  failed: "refused",
  idle: "",
} as const;

/**
 * The outcome of one action.
 *
 * Deliberately not coloured. The palette in `globals.css` reserves green and
 * red for the direction money moved, so a red "failed" banner would compete
 * with a red balance for the same meaning. Status is carried by the word.
 */
function ResultPanel({ result }: { readonly result: ConsoleActionResult }) {
  if (result.status === "idle") return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={`mt-3 rounded-md border px-4 py-3 ${
        result.status === "failed" ? "border-border-strong" : "border-border"
      } bg-surface-raised`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.status === "ok" ? "neutral" : "quiet"}>
          {STATUS_LABEL[result.status]}
        </Badge>
        {result.code === null ? null : (
          <span className="font-mono text-[11px] text-muted">{result.code}</span>
        )}
      </div>

      <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
        {result.message}
      </p>

      {result.facts.length === 0 ? null : (
        <dl className="mt-3 grid gap-x-4 gap-y-1 sm:grid-cols-[12rem_1fr]">
          {result.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">
                {fact.label}
              </dt>
              <dd
                className={`text-xs break-all ${fact.mono === true ? "font-mono" : ""}`}
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {result.balances === null ? null : (
        <BalanceMoveTable
          before={result.balances.before}
          after={result.balances.after}
        />
      )}

      {result.holdId === null ? null : (
        <p className="mt-3 text-xs">
          <Link
            href={`/accounts/holds/${result.holdId}`}
            className={`underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
          >
            Open this hold&rsquo;s event set and the fold that produces H(E)
          </Link>
        </p>
      )}
    </div>
  );
}

const MOVE_ROWS: readonly {
  readonly field: keyof BalanceFacts;
  readonly label: string;
}[] = [
  { field: "ledgerCents", label: "Ledger balance" },
  { field: "holdsCents", label: "Card-auth holds" },
  { field: "unclearedCents", label: "Uncleared credits" },
  { field: "availableCents", label: "Available balance" },
];

/**
 * Before, after, and the difference — measured by the action itself, on either
 * side of the provider call.
 *
 * This is the whole argument of the screen in four rows. An authorisation
 * moves the third and fourth and leaves the first alone; a clearing moves the
 * first. The delta column is the only place on this screen where a `+` is
 * rendered, because a delta is the one figure whose direction is its meaning.
 */
function BalanceMoveTable({
  before,
  after,
}: {
  readonly before: BalanceFacts;
  readonly after: BalanceFacts;
}) {
  const move = { before, after };

  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <caption className="sr-only">
          Balances measured immediately before and immediately after this action
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className="py-1.5 pr-4 text-left font-medium text-muted">
              Figure
            </th>
            <th scope="col" className="py-1.5 pr-4 text-right font-medium text-muted">
              Before
            </th>
            <th scope="col" className="py-1.5 pr-4 text-right font-medium text-muted">
              After
            </th>
            <th scope="col" className="py-1.5 text-right font-medium text-muted">
              Change
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {MOVE_ROWS.map((row) => {
            const delta = balanceDelta(move, row.field);
            return (
              <tr key={row.field}>
                <th scope="row" className="py-1.5 pr-4 text-left font-normal">
                  {row.label}
                </th>
                <td className="py-1.5 pr-4 text-right">
                  <Money cents={centsFrom(before[row.field])} />
                </td>
                <td className="py-1.5 pr-4 text-right">
                  <Money cents={centsFrom(after[row.field])} />
                </td>
                <td className="py-1.5 text-right">
                  {delta === 0n ? (
                    <span className="text-muted">unchanged</span>
                  ) : (
                    <Money cents={delta} tone="direction" signed />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Issue a card                                                            */
/* -------------------------------------------------------------------------- */

export type ConsoleAction = (
  previous: ConsoleActionResult,
  formData: FormData,
) => Promise<ConsoleActionResult>;

/**
 * Create a real card on Lithic.
 *
 * The button is the only path to it. Nothing on this route calls the action on
 * render, and it could not: a server action is invoked by a POST, and this
 * page issues none.
 */
export function IssueCardForm({
  action,
  businessId,
  businessName,
  formKey,
}: {
  readonly action: ConsoleAction;
  readonly businessId: string;
  readonly businessName: string;
  /** Generated per render; Lithic's `Idempotency-Key`, so a double-press is one card. */
  readonly formKey: string;
}) {
  const [result, dispatch] = useActionState(action, IDLE_RESULT);
  const nicknameId = useId();

  return (
    <div className="px-5 py-4">
      <form action={dispatch} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="formKey" value={formKey} />

        <div className="min-w-[16rem] flex-1">
          <Field
            label="Nickname (optional)"
            hint="Stored on the card row here. Lithic gets its own memo."
          >
            <input
              id={nicknameId}
              name="nickname"
              type="text"
              maxLength={60}
              placeholder={`${businessName} · console`}
              className={`${INPUT_CLASS} ${FOCUS_RING}`}
            />
          </Field>
        </div>

        <Submit
          label="Issue a real Lithic card"
          pendingLabel="Creating at Lithic…"
        />
      </form>

      <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
        This calls <span className="font-mono">POST /v1/cards</span> against the
        live Lithic API and then binds the returned token to{" "}
        {businessName}&rsquo;s 2100 deposit account and 9100 memo account
        through <span className="font-mono">registerCard()</span>. It runs only
        when this button is pressed — never on render, because a page that
        issued a card per page load would litter the card program.
      </p>

      <ResultPanel result={result} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Simulate an authorisation                                               */
/* -------------------------------------------------------------------------- */

export type CardOption = {
  readonly token: string;
  readonly label: string;
};

/**
 * Put an authorisation on a card.
 *
 * The copy on this control is the honest-labelling requirement made literal,
 * and it is four separate claims because they have four separate truth values:
 * the card is real, the transaction and its webhook are real, the endpoint is
 * Lithic's SANDBOX SIMULATOR, and no purchase happened anywhere.
 */
export function AuthorizeForm({
  action,
  businessId,
  cards,
}: {
  readonly action: ConsoleAction;
  readonly businessId: string;
  readonly cards: readonly CardOption[];
}) {
  const [result, dispatch] = useActionState(action, IDLE_RESULT);
  const first = cards[0];

  return (
    <div className="px-5 py-4">
      {first === undefined ? (
        <p className="text-sm text-muted">
          No card is registered to this customer, so there is nothing to
          authorise against. Issue one above first — an authorisation on an
          unregistered card parks in the inbox rather than posting to anybody.
        </p>
      ) : (
        <form action={dispatch} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input type="hidden" name="businessId" value={businessId} />

          <div className="sm:col-span-2">
            <Field label="Card">
              <select
                name="cardToken"
                defaultValue={first.token}
                className={`${INPUT_CLASS} ${FOCUS_RING}`}
              >
                {cards.map((card) => (
                  <option key={card.token} value={card.token}>
                    {card.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Amount (USD)" hint="Integer cents on the wire. 50.00 → 5000.">
            <input
              name="amount"
              type="text"
              inputMode="decimal"
              defaultValue="50.00"
              className={`${INPUT_CLASS} ${FOCUS_RING} money`}
            />
          </Field>

          <Field label="MCC" hint="5542 is an automated fuel dispenser.">
            <input
              name="mcc"
              type="text"
              inputMode="numeric"
              defaultValue="5542"
              maxLength={4}
              className={`${INPUT_CLASS} ${FOCUS_RING} font-mono`}
            />
          </Field>

          <div className="sm:col-span-2 lg:col-span-3">
            <Field label="Descriptor" hint="1–25 characters, as the network carries it.">
              <input
                name="descriptor"
                type="text"
                maxLength={25}
                defaultValue="CORGI FUEL PUMP 4"
                className={`${INPUT_CLASS} ${FOCUS_RING}`}
              />
            </Field>
          </div>

          <div className="flex items-end lg:col-span-1">
            <Submit
              label="Simulate authorisation (Lithic sandbox)"
              pendingLabel="Simulating, then waiting for the webhook…"
            />
          </div>
        </form>
      )}

      <ResultPanel result={result} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. Simulate a clearing                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Settle an outstanding authorisation, in whole or in part.
 *
 * Blank means "the full authorised amount", which is Lithic's own default and
 * not a value this form invents. A figure larger than the authorisation is
 * allowed through on purpose: over-capture is the interesting case, and a form
 * that refused it would be hiding the behaviour the screen exists to show.
 */
export function ClearingForm({
  action,
  businessId,
  transactionToken,
  suggestion,
  outstanding,
}: {
  readonly action: ConsoleAction;
  readonly businessId: string;
  readonly transactionToken: string;
  /** Pre-filled amount, as a plain dollar string. Blank clears in full. */
  readonly suggestion: string;
  /** Whether this authorisation still has an outstanding hold. */
  readonly outstanding: boolean;
}) {
  const [result, dispatch] = useActionState(action, IDLE_RESULT);

  return (
    <div>
      <form action={dispatch} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="businessId" value={businessId} />
        <input type="hidden" name="transactionToken" value={transactionToken} />

        <label className="block">
          <span className="sr-only">Amount to clear, in USD</span>
          <input
            name="amount"
            type="text"
            inputMode="decimal"
            defaultValue={suggestion}
            placeholder="full amount"
            aria-label="Amount to clear, in USD"
            className={`w-32 rounded border border-border-strong bg-surface px-2 py-1 text-xs placeholder:text-muted ${FOCUS_RING} money`}
          />
        </label>

        <Submit
          label={outstanding ? "Simulate clearing" : "Capture again"}
          pendingLabel="Clearing…"
        />
      </form>

      {outstanding ? null : (
        <p className="mt-1 max-w-[16rem] text-[11px] leading-relaxed text-muted">
          Nothing is outstanding on this authorisation. A further capture is an
          OVER-CAPTURE: it moves the ledger and cannot move the hold, because{" "}
          <span className="font-mono">max(A − C, 0)</span> is already zero.
          Leaving the box empty clears the full authorised amount again.
        </p>
      )}

      <ResultPanel result={result} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. Drain and re-read                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Run the webhook pipeline now.
 *
 * The same `drain()` the 04:17 cron and `/api/drain` call. It exists as a
 * button because "watch, I will drain it now" beats waiting for a timer, and
 * because it is the honest answer to a `pending` result: the delivery is
 * durable in the inbox, so the effect is late rather than lost.
 */
export function DrainForm({
  action,
  businessId,
}: {
  readonly action: ConsoleAction;
  readonly businessId: string;
}) {
  const [result, dispatch] = useActionState(action, IDLE_RESULT);

  return (
    <div className="px-5 py-4">
      <form action={dispatch} className="flex flex-wrap items-center gap-3">
        <input type="hidden" name="businessId" value={businessId} />
        <Submit label="Drain and re-read" pendingLabel="Draining…" />
        <span className="text-xs text-muted">
          Processes every stored webhook delivery through the deployed
          consumers. Idempotent at three unique indexes, so pressing it twice
          posts nothing the second time.
        </span>
      </form>

      <ResultPanel result={result} />
    </div>
  );
}
