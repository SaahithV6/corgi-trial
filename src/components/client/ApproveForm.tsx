"use client";

import { useActionState, useId } from "react";

import { decideAction, type DecisionResult } from "@/app/(app)/approvals/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

/**
 * Approve, turn down, or send — in the customer's words, on the bank's path.
 *
 * ===========================================================================
 * THE BUTTON IS DISABLED AND THAT IS NOT THE CONTROL
 * ===========================================================================
 *
 * `decideAction` is imported from `src/app/(app)/approvals/actions.ts`, the
 * staff console's own action. It resolves the actor from the session — never
 * from this form — and calls `approvePayment()` / `rejectPayment()` /
 * `releasePayment()`, which send an INSERT to Postgres. The rule that the
 * person who asked for a payment cannot approve it is enforced by
 * `assert_maker_checker()`, a trigger, which raises SQLSTATE 42501 and refuses
 * the row.
 *
 * So the disabled button is a courtesy, not a gate: it tells somebody in
 * advance what the database would do, because learning it by pressing a
 * live-looking button and getting an error teaches people that the buttons are
 * unreliable, and it puts a maker-checker refusal in the same visual channel as
 * a network blip. A POST assembled by hand with none of this markup reaches the
 * same trigger and is refused by the same exception.
 *
 * ===========================================================================
 * A SENTENCE, NOT A SQLSTATE
 * ===========================================================================
 *
 * `state.message` is `classifyRefusal()`'s translation of the exception, and
 * for the maker-checker case it reads: "You raised this payment, so you cannot
 * approve it. Maker-checker needs a second person: the initiator is never the
 * checker." The raw Postgres text never reaches a screen; it goes to the
 * structured log with the SQLSTATE attached. A customer is told what happened
 * and why, in a sentence, and the code is printed small beside it so a support
 * call has something exact to quote.
 *
 * THE CONTENT HASH IS THE WHOLE MECHANISM. It is carried back verbatim from
 * the payment the person actually read. If what is on screen is not what is in
 * the database, the two hashes differ and the approval is refused — so an
 * approval given for one amount can never apply to another.
 */

const IDLE: DecisionResult = {
  status: "idle",
  code: null,
  message: "",
  instructionId: null,
};

export function ApproveForm({
  instructionId,
  contentHash,
  canDecide,
  decideReason,
  canRelease,
  releaseReason,
}: {
  readonly instructionId: string;
  readonly contentHash: string;
  readonly canDecide: boolean;
  readonly decideReason: string | null;
  readonly canRelease: boolean;
  readonly releaseReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(decideAction, IDLE);
  const reasonId = useId();
  const whyId = useId();
  const whyReleaseId = useId();

  // A result for a different payment is not this form's result.
  const mine = state.instructionId === instructionId ? state : IDLE;

  const button = `inline-flex items-center rounded border px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-45`;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="instructionId" value={instructionId} />
      <input type="hidden" name="contentHash" value={contentHash} />

      <div>
        <label
          htmlFor={reasonId}
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
        >
          Add a note
        </label>
        <textarea
          id={reasonId}
          name="reason"
          rows={2}
          maxLength={500}
          disabled={pending}
          placeholder="What did you check before approving? This is kept on the payment and cannot be edited later."
          className={`mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs ${FOCUS_RING} disabled:opacity-60`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="intent"
          value="approve"
          disabled={!canDecide || pending}
          aria-describedby={decideReason === null ? undefined : whyId}
          className={`${button} border-positive/60 text-positive enabled:hover:bg-surface-raised`}
        >
          {pending ? "Working…" : "Approve this payment"}
        </button>

        <button
          type="submit"
          name="intent"
          value="reject"
          disabled={!canDecide || pending}
          aria-describedby={decideReason === null ? undefined : whyId}
          className={`${button} border-negative/50 text-negative enabled:hover:bg-surface-raised`}
        >
          Turn it down
        </button>

        <button
          type="submit"
          name="intent"
          value="release"
          disabled={!canRelease || pending}
          aria-describedby={releaseReason === null ? undefined : whyReleaseId}
          className={`${button} border-border-strong text-text enabled:hover:bg-surface-raised`}
        >
          Send it
        </button>
      </div>

      {decideReason === null ? null : (
        <p id={whyId} className="max-w-prose text-xs leading-relaxed text-muted">
          {decideReason}
        </p>
      )}
      {releaseReason === null || releaseReason === decideReason ? null : (
        <p id={whyReleaseId} className="max-w-prose text-xs leading-relaxed text-muted">
          <span className="font-medium text-text">Sending it: </span>
          {releaseReason}
        </p>
      )}

      {mine.status === "refused" ? (
        <div className="rounded-md border border-negative/40 bg-surface-raised px-4 py-3">
          <p className="text-xs font-semibold text-negative">
            Not recorded{mine.code === null ? "" : ` · ${mine.code}`}
          </p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {mine.message}
          </p>
        </div>
      ) : null}

      {mine.status === "ok" ? (
        <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
          <p className="text-xs font-semibold">Recorded</p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {mine.message}
          </p>
        </div>
      ) : null}
    </form>
  );
}
