"use client";

import { useActionState, useId } from "react";

import { fileDisputeAction } from "@/app/(app)/client/disputes/actions";
import { FOCUS_RING, Note } from "@/components/ui/primitives";

import { FILE_DISPUTE_IDLE, type FileDisputeResult } from "./file-state";

/**
 * The customer raising a claim on one of their own settled card transactions.
 *
 * ===========================================================================
 * THERE IS NO AMOUNT FIELD, ON PURPOSE
 * ===========================================================================
 *
 * The claim is whatever is still outstanding on the charge, and the action
 * reads that off the journal at the moment of the write. A customer cannot
 * type a number here, so there is no number to tamper with and no arithmetic
 * in this file — the amounts below are strings the server already formatted,
 * which is also the only way they could cross into a client component at all.
 *
 * ===========================================================================
 * NOTHING HERE IS DISABLED BY WHAT THIS SCREEN BELIEVES
 * ===========================================================================
 *
 * Whether the charge is theirs is decided by a `WHERE e.id = $1 AND
 * a.business_id = $2` inside the action. Whether it is a settled card
 * transaction is decided by the library's own query and then again by
 * `assert_dispute_intake()`. Whether a claim already stands on it is decided by
 * a query against `v_dispute_state`. Pressing the button shows the refusal from
 * the place that actually refuses, which is worth more than a greyed-out
 * control that demonstrates nothing — and the same discipline
 * `CardControlsForm` states for the same reason.
 *
 * ===========================================================================
 * WHAT THE BUTTON DOES NOT DO
 * ===========================================================================
 *
 * It does not move money. Filing raises a case and posts nothing. Whether the
 * bank advances the money while the network decides is a Corgi decision behind
 * maker-checker, and the sentence under the button says so before it is
 * pressed rather than after.
 */

const INPUT = `mt-1 w-full rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

/** One settled charge, as characters. No figure on this component's props. */
export type ChargeOption = {
  readonly entryId: string;
  readonly valueDate: string;
  readonly description: string;
  /** What is still unclaimed, already formatted. The claim will be this. */
  readonly outstandingDisplay: string;
  readonly cardWord: string;
};

export type ReasonChoice = {
  readonly reason: string;
  readonly label: string;
  readonly networkCode: string;
  readonly networkLabel: string;
};

function Receipt({ result }: { readonly result: FileDisputeResult }) {
  if (result.status === "idle") return null;
  const heading =
    result.status === "filed"
      ? "Claim raised"
      : result.status === "already_filed"
        ? result.code
        : result.code;
  return (
    <Note emphasis={result.status === "refused"} title={heading ?? "Result"}>
      <p>{result.message}</p>
      {result.facts.length === 0 ? null : (
        <dl className="mt-2 flex flex-col gap-1">
          {result.facts.map((fact) => (
            <div key={fact.label} className="flex flex-wrap items-baseline gap-2">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{fact.label}</dt>
              <dd
                className={
                  fact.mono === true
                    ? "font-mono text-[11px] text-text"
                    : "text-[11px] text-text"
                }
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Note>
  );
}

export function FileDisputeForm({
  businessId,
  charges,
  reasons,
}: {
  readonly businessId: string;
  readonly charges: readonly ChargeOption[];
  readonly reasons: readonly ReasonChoice[];
}) {
  const [result, action, pending] = useActionState(fileDisputeAction, FILE_DISPUTE_IDLE);
  const ids = useId();

  if (charges.length === 0) {
    return (
      <Note title="Nothing to dispute">
        <p>
          There are no settled card transactions on this account with money still unclaimed. A
          payment you can see on your card but not in this list is still an authorisation — it has
          not taken your money yet, so there is nothing to claim back. It will appear here when it
          settles, usually the next business day.
        </p>
      </Note>
    );
  }

  return (
    <form action={action} className="mt-4 space-y-4 border-t border-border pt-4">
      <input type="hidden" name="businessId" value={businessId} />

      <div>
        <label className={LABEL} htmlFor={`${ids}-entry`}>
          Which payment
        </label>
        <select
          id={`${ids}-entry`}
          name="disputedEntryId"
          className={INPUT}
          disabled={pending}
          defaultValue={charges[0]?.entryId ?? ""}
        >
          {charges.map((charge) => (
            <option key={charge.entryId} value={charge.entryId}>
              {charge.valueDate} · {charge.outstandingDisplay} · {charge.cardWord} ·{" "}
              {charge.description}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          Only settled card payments are listed, and only the part of each one nobody has claimed
          yet. You will be claiming the whole amount shown — there is nothing to type, so there is
          nothing to get wrong.
        </p>
      </div>

      <div>
        <label className={LABEL} htmlFor={`${ids}-reason`}>
          What went wrong
        </label>
        <select
          id={`${ids}-reason`}
          name="reason"
          className={INPUT}
          disabled={pending}
          defaultValue={reasons[0]?.reason ?? ""}
        >
          {reasons.map((choice) => (
            <option key={choice.reason} value={choice.reason}>
              {choice.label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          We turn this into the card network&apos;s own reason code when we file — you do not have
          to know theirs.
        </p>
      </div>

      <div>
        <label className={LABEL} htmlFor={`${ids}-narrative`}>
          In your own words
        </label>
        <textarea
          id={`${ids}-narrative`}
          name="narrative"
          rows={3}
          maxLength={500}
          className={INPUT}
          disabled={pending}
          placeholder="What happened, and what you have already tried with the merchant."
        />
        <p className="mt-1 text-[11px] leading-relaxed text-muted">
          At least a sentence. What you write is filed with the card network and kept on the case;
          it is the first thing anybody reads when the claim is decided.
        </p>
      </div>

      <Receipt result={result} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className={`rounded border border-border-strong px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:opacity-60`}
        >
          {pending ? "Raising the claim…" : "Raise this claim"}
        </button>
        <p className="text-[11px] leading-relaxed text-muted">
          This raises a case. It does not move money and it does not change what you can spend.
          Whether we advance you the money while the card network decides is our call, it needs a
          second Corgi approver to sign it off, and you will see it on this page either way.
        </p>
      </div>
    </form>
  );
}
