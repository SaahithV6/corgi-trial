"use client";

/**
 * The two forms: link a bank, and pull money in from one.
 *
 * Both are `useActionState`, so a refusal renders inline under the form with
 * the code the decision carried, instead of throwing an unexplained error
 * boundary at somebody halfway through funding their account.
 *
 * `FUNDING_IDLE` is imported from `@/components/client/funding/action-state`, a
 * PLAIN module — not from the `"use server"` module beside the actions. That is
 * not a style preference: everything exported from a `"use server"` module
 * becomes a server reference, so importing a `const` from one hands this
 * component a callable stub, `useActionState` seeds the form with it, and the
 * first render throws while typecheck stays green.
 *
 * There is no arithmetic on this side of the line. Every figure arrives already
 * formatted as text, because `bigint` does not survive serialisation into a
 * client component and converting cents to a `number` on the way is the defect
 * this codebase has already shipped once.
 */

import { useActionState, useState } from "react";

import {
  FUNDING_IDLE,
  type FundingActionResult,
} from "@/components/client/funding/action-state";

type Action = (
  previous: FundingActionResult,
  formData: FormData,
) => Promise<FundingActionResult>;

/* -------------------------------------------------------------------------- */
/* The answer panel                                                           */
/* -------------------------------------------------------------------------- */

function Answer({ result }: { readonly result: FundingActionResult }) {
  if (result.status === "idle") return null;

  const refused = result.status === "refused";
  return (
    <div
      role="status"
      className={`mt-3 rounded-md border px-3 py-2.5 text-xs leading-relaxed ${
        refused
          ? "border-amber-500/40 bg-amber-500/5"
          : "border-emerald-500/40 bg-emerald-500/5"
      }`}
    >
      <p className="flex flex-wrap items-baseline gap-x-2">
        <strong className="font-medium">
          {refused ? "Nothing moved" : "Done"}
        </strong>
        {result.code === null ? null : (
          <code className="rounded bg-black/10 px-1 py-0.5 text-[10px] tracking-wide">
            {result.code}
          </code>
        )}
        {result.at === null ? null : (
          <span className="text-[10px] text-muted">{result.at}</span>
        )}
      </p>
      <p className="mt-1.5 max-w-prose text-muted">{result.message}</p>
      {result.facts.length === 0 ? null : (
        <dl className="mt-2.5 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          {result.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-[11px] text-muted">{fact.label}</dt>
              <dd className={fact.mono ? "break-all font-mono text-[11px]" : "text-[11px]"}>
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
/* 1. Link a bank                                                             */
/* -------------------------------------------------------------------------- */

export function LinkBankForm({
  businessId,
  action,
  configured,
}: {
  readonly businessId: string;
  readonly action: Action;
  readonly configured: boolean;
}) {
  const [state, submit, pending] = useActionState(action, FUNDING_IDLE);

  return (
    <form action={submit} className="rounded-lg border border-border-strong p-4">
      <input type="hidden" name="businessId" value={businessId} />
      <h2 className="text-sm font-medium">Link a bank</h2>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        Connect an account you already hold somewhere else, so you can move money
        into this one. We keep the connection, never your bank password, and you
        can see every account it lets us pull from before anything moves.
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        Linking does not move money. It is consent, and nothing else.
      </p>
      <button
        type="submit"
        disabled={pending || !configured}
        className="mt-3 rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium disabled:opacity-50"
      >
        {pending ? "Connecting to your bank…" : "Link a bank"}
      </button>
      {configured ? null : (
        <p className="mt-2 text-[11px] text-muted">
          This deployment has no bank-linking credentials configured, so no bank
          can be linked right now. Nothing is being simulated in its place.
        </p>
      )}
      <Answer result={state} />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Fund from a linked bank                                                 */
/* -------------------------------------------------------------------------- */

export type FundChoice = {
  readonly itemId: string;
  readonly plaidAccountId: string;
  readonly label: string;
};

export function FundForm({
  businessId,
  choices,
  action,
  today,
}: {
  readonly businessId: string;
  readonly choices: readonly FundChoice[];
  readonly action: Action;
  readonly today: string;
}) {
  const [state, submit, pending] = useActionState(action, FUNDING_IDLE);
  const first = choices[0];
  // ONE piece of state, and the two fields the action reads are derived from
  // it. An account belongs to exactly one connection, so the pair is a single
  // choice; keeping two independent `<select>`s would let the form offer a
  // pairing that cannot exist. The server re-checks both halves against the
  // business in one statement regardless — this is a convenience, never a
  // constraint.
  const [pair, setPair] = useState<string>(
    first === undefined ? "" : `${first.itemId}|${first.plaidAccountId}`,
  );
  const [chosenItemId = "", chosenAccountId = ""] = pair.split("|");

  return (
    <form action={submit} className="rounded-lg border border-border-strong p-4">
      <input type="hidden" name="businessId" value={businessId} />
      <h2 className="text-sm font-medium">Move money in</h2>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        Pull money from a bank you have linked. It lands on your account today,
        dated {today} — and it is held back from your spendable balance for a
        short period first, because a deposit can still be returned by the bank
        it came from. You will be told exactly when it becomes spendable.
      </p>

      {first === undefined ? (
        <p className="mt-3 text-xs text-muted">
          There is no linked account money can be pulled from yet. Link a bank
          above, or — if one is listed below as needing attention — sort that out
          first.
        </p>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-xs">
              <span className="block text-muted">From</span>
              <select
                value={pair}
                onChange={(event) => setPair(event.target.value)}
                className="mt-1 w-full rounded-md border border-border-strong bg-transparent px-2 py-1.5 text-xs"
              >
                {choices.map((choice) => (
                  <option
                    key={`${choice.itemId}|${choice.plaidAccountId}`}
                    value={`${choice.itemId}|${choice.plaidAccountId}`}
                  >
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              <span className="block text-muted">Amount</span>
              <input
                name="amount"
                inputMode="decimal"
                placeholder="2500.00"
                className="mt-1 w-full rounded-md border border-border-strong bg-transparent px-2 py-1.5 text-xs"
              />
            </label>
            <label className="text-xs">
              <span className="block text-muted">What it is for</span>
              <input
                name="reference"
                placeholder="opening-float"
                className="mt-1 w-full rounded-md border border-border-strong bg-transparent px-2 py-1.5 text-xs"
              />
            </label>
          </div>

          <input type="hidden" name="itemId" value={chosenItemId} />
          <input type="hidden" name="plaidAccountId" value={chosenAccountId} />

          <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
            Give each deposit its own reference. Sending the same one twice books
            one deposit, not two — the database decides that, so a double-click
            cannot cost you money.
          </p>
          <button
            type="submit"
            disabled={pending}
            className="mt-3 rounded-md border border-border-strong px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {pending ? "Instructing your bank…" : "Move money in"}
          </button>
        </>
      )}
      <Answer result={state} />
    </form>
  );
}
