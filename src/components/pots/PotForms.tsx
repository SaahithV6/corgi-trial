"use client";

import { useActionState, useId, useState } from "react";

import {
  movePotAction,
  openPotAction,
  type MovePotResult,
  type OpenPotResult,
} from "@/app/(app)/pots/actions";
import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";

import type { BusinessOption, PotView } from "./data-contract";

/**
 * The two forms, and what they are careful not to do.
 *
 * 1. THEY PERFORM NO ARITHMETIC ON MONEY. The amount is the literal characters
 *    somebody typed, sent as text. Whether it fits inside the available balance
 *    is decided by `decideMove()` comparing two `bigint`s inside a Postgres
 *    transaction, behind `lock_business_deposits()`, and the answer comes back
 *    on the receipt with all four figures on it. The browser is never told in
 *    advance, because a balance it read a second ago is not the balance the
 *    transaction will read.
 *
 * 2. THEY ARE NOT THE VALIDATION. The `required` attributes and the `pattern`s
 *    are conveniences for a person filling this in at speed. Every one of them
 *    is re-decided on the server by the zod schemas in `actions.ts`, and a POST
 *    assembled by hand with none of these fields reaches exactly the same
 *    refusals.
 *
 * 3. THE SUBMIT BUTTON IS NOT DISABLED WHEN THE AMOUNT LOOKS TOO BIG. Same
 *    reasoning as the payments form: the refusal is the most instructive thing
 *    this screen can show, and a greyed-out button demonstrates nothing.
 *    Pressing it sends a real request to a real transaction, which reads the
 *    balance under its own lock and refuses with a code and the subtraction.
 */

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";
const BUTTON_CLASS = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;

const OPEN_IDLE: OpenPotResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  potId: null,
  accountCode: null,
};

const MOVE_IDLE: MovePotResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  receipt: null,
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

function Issues({ issues }: { readonly issues: readonly { path: string; message: string }[] }) {
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
/* Open a pot                                                                 */
/* -------------------------------------------------------------------------- */

export function OpenPotForm({
  business,
  disabled,
}: {
  readonly business: BusinessOption;
  readonly disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(openPotAction, OPEN_IDLE);
  const nameId = useId();
  const purposeId = useId();

  return (
    <Panel
      id="open-pot"
      title="Open a pot"
      description="Creates one account in the chart, parented on this customer's own 2100 deposit leaf. It holds $0.00 until money is moved into it."
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        <input type="hidden" name="businessId" value={business.businessId} />

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            hint="How somebody refers to this money out loud. Unique per customer — two pots called “Payroll” would make “move it to Payroll” ambiguous, which is the only thing a pot name is for."
          >
            <input
              id={nameId}
              name="name"
              type="text"
              required
              maxLength={60}
              placeholder="Payroll — October"
              disabled={disabled || pending}
              className={INPUT_CLASS}
            />
          </Field>

          <Field label="Purpose (optional)" hint="Why this money is set aside, in the customer's words.">
            <input
              id={purposeId}
              name="purpose"
              type="text"
              maxLength={280}
              placeholder="Wages and payroll taxes for the October run"
              disabled={disabled || pending}
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" disabled={disabled || pending} className={BUTTON_CLASS}>
            {pending ? "Opening…" : "Open pot"}
          </button>
          {disabled ? (
            <span className="text-[11px] text-muted">
              Fixture state — the form is inert here. Switch to Default to open a
              real account.
            </span>
          ) : null}
        </div>

        {state.status === "idle" ? null : (
          <Note
            emphasis={state.status === "refused"}
            title={state.status === "opened" ? "Opened" : `Refused — ${state.code}`}
          >
            <p>{state.message}</p>
            {state.issues === null ? null : <Issues issues={state.issues} />}
            {state.accountCode === null ? null : (
              <p className="mt-2">
                account code <span className="money">{state.accountCode}</span>
              </p>
            )}
          </Note>
        )}
      </form>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Move money                                                                 */
/* -------------------------------------------------------------------------- */

export function MoveForm({
  pots,
  disabled,
}: {
  readonly pots: readonly PotView[];
  readonly disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(movePotAction, MOVE_IDLE);
  const [potId, setPotId] = useState(pots[0]?.potId ?? "");
  const [direction, setDirection] = useState<"in" | "out">("in");

  const potFieldId = useId();
  const amountId = useId();
  const referenceId = useId();

  const selected = pots.find((pot) => pot.potId === potId) ?? null;

  return (
    <Panel
      id="move"
      title="Move money"
      description="One journal entry, two lines, rail = internal. Instant because nothing external is involved."
    >
      {pots.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          Open a pot first. There is nothing to transfer between.
        </p>
      ) : (
        <form action={formAction} className="space-y-4 px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Pot">
              <select
                id={potFieldId}
                name="potId"
                value={potId}
                onChange={(event) => setPotId(event.target.value)}
                disabled={disabled || pending}
                className={INPUT_CLASS}
              >
                {pots.map((pot) => (
                  <option key={pot.potId} value={pot.potId}>
                    {pot.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Direction"
              hint={
                direction === "in"
                  ? "Debits the main leaf, credits the pot. Capped by AVAILABLE, not by the ledger balance."
                  : "Debits the pot, credits the main leaf. Capped by the pot's own balance — a pot cannot be overdrawn."
              }
            >
              <select
                name="direction"
                value={direction}
                onChange={(event) =>
                  setDirection(event.target.value === "out" ? "out" : "in")
                }
                disabled={disabled || pending}
                className={INPUT_CLASS}
              >
                <option value="in">Into the pot — earmark</option>
                <option value="out">Out of the pot — release</option>
              </select>
            </Field>

            <Field label="Amount (USD)" hint="Cents. Two decimal places at most, no sign.">
              <input
                id={amountId}
                name="amount"
                type="text"
                inputMode="decimal"
                required
                placeholder="1200.00"
                pattern="^\$?\d{1,13}(\.\d{1,2})?$"
                disabled={disabled || pending}
                className={`${INPUT_CLASS} money`}
              />
            </Field>

            <Field
              label="Reference"
              hint="The source fact the idempotency key is built from. Send it twice and one transfer is booked — decided by a UNIQUE index, not by an if."
            >
              <input
                id={referenceId}
                name="reference"
                type="text"
                required
                minLength={3}
                maxLength={120}
                placeholder="payroll-2026-10"
                pattern="^[A-Za-z0-9._/#-]+$"
                disabled={disabled || pending}
                className={`${INPUT_CLASS} money`}
              />
            </Field>
          </div>

          {selected === null ? null : (
            <p className="text-[11px] text-muted">
              key will be{" "}
              <span className="money">
                pot:{selected.potId}:{direction}:&lt;reference&gt;
              </span>
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={disabled || pending} className={BUTTON_CLASS}>
              {pending ? "Posting…" : "Post internal transfer"}
            </button>
            {disabled ? (
              <span className="text-[11px] text-muted">
                Fixture state — the form is inert here. Switch to Default to post
                a real entry.
              </span>
            ) : null}
          </div>

          {state.status === "idle" ? null : (
            <Note
              emphasis={state.status === "refused"}
              title={
                state.status === "posted"
                  ? state.receipt?.replay === true
                    ? "Already posted — replay"
                    : "Posted"
                  : `Refused — ${state.code}`
              }
            >
              <p>{state.message}</p>
              {state.issues === null ? null : <Issues issues={state.issues} />}
              {state.receipt === null ? null : <Receipt receipt={state.receipt} />}
            </Note>
          )}
        </form>
      )}
    </Panel>
  );
}

/**
 * The receipt: the entry's identity, and every balance before and after.
 *
 * The "after" figures are a second read of the same views, taken once the entry
 * is in the transaction — not the "before" figures with the amount added to
 * them in TypeScript. That is the difference between showing the ledger and
 * showing what we expected the ledger to say.
 */
function Receipt({
  receipt,
}: {
  readonly receipt: NonNullable<MovePotResult["receipt"]>;
}) {
  const rows: readonly { label: string; before: string; after: string }[] = [
    { label: "main balance (2100)", before: receipt.before.main, after: receipt.after.main },
    { label: `pot “${receipt.potName}”`, before: receipt.before.pot, after: receipt.after.pot },
    { label: "Σ all pots", before: receipt.before.pots, after: receipt.after.pots },
    { label: "total deposit liability", before: receipt.before.total, after: receipt.after.total },
    { label: "card holds", before: receipt.before.holds, after: receipt.after.holds },
    { label: "uncleared credits", before: receipt.before.uncleared, after: receipt.after.uncleared },
    { label: "AVAILABLE", before: receipt.before.available, after: receipt.after.available },
  ];

  return (
    <div className="mt-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">rail {receipt.rail}</Badge>
        <Badge tone="quiet">seq {receipt.bookingSeq}</Badge>
        <Badge tone="quiet">value date {receipt.valueDate}</Badge>
        {receipt.replay ? <Badge tone="neutral">replay — nothing written</Badge> : null}
      </div>

      <p className="text-[11px]">
        entry <span className="money break-all">{receipt.entryId}</span>
      </p>
      <p className="text-[11px]">
        key <span className="money break-all">{receipt.idempotencyKey}</span>
      </p>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[11px]">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className="py-1 pr-4 text-left font-medium text-muted">
                Figure
              </th>
              <th scope="col" className="py-1 pr-4 text-right font-medium text-muted">
                Before
              </th>
              <th scope="col" className="py-1 text-right font-medium text-muted">
                After
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border/60">
                <td className="py-1 pr-4">{row.label}</td>
                <td className="money py-1 pr-4 text-right">{row.before}</td>
                <td className="money py-1 text-right font-medium">{row.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] leading-relaxed text-muted">
        The total is unchanged and available moved by exactly the amount:{" "}
        {receipt.amount}. That pair is the whole design decision — the customer
        still owns every cent they owned a moment ago, and{" "}
        {receipt.direction === "in" ? "less" : "more"} of it can be spent.
      </p>
    </div>
  );
}
