"use client";

import { useActionState, useId } from "react";

import { decideAction, type DecisionResult } from "@/app/(app)/approvals/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

import type { Gate } from "@/lib/approvals/gate";

/**
 * Approve, reject, release — one form, one server action, three submit buttons.
 *
 * ============================================================================
 * THE DISABLED BUTTON IS THE POINT OF THIS COMPONENT.
 *
 * When the signed-in actor is the payment's own initiator, the approve button
 * is `disabled`, visibly so, with the reason rendered beside it and wired to
 * the button through `aria-describedby` so a screen reader announces the
 * refusal with the control rather than leaving it to be discovered.
 *
 * It is NOT merely "fails on click". Learning that you cannot approve your own
 * payment by pressing a live-looking button and receiving an error is a worse
 * experience and a worse control: it teaches operators that the queue's buttons
 * are unreliable, and it puts a maker-checker refusal in the same visual
 * channel as a network blip.
 *
 * It is also not a substitute for the control. The server action ignores this
 * component entirely — a POST assembled by hand reaches the same trigger and is
 * refused by the same `RAISE EXCEPTION`. See the header of `actions.ts`.
 * ============================================================================
 *
 * `useActionState` rather than a plain `<form action>` so the refusal can be
 * rendered inline, next to the payment it belongs to, with `aria-live` — an
 * approver working a queue must not lose their place to an error page.
 */

const IDLE: DecisionResult = {
  status: "idle",
  code: null,
  message: "",
  instructionId: null,
};

export type DecisionFormProps = {
  readonly instructionId: string;
  readonly contentHash: string;
  readonly gate: Gate;
  readonly releaseGate: Gate;
  /**
   * False on the fixture demo states. A fixture row has no database row behind
   * it, and a button that pretended to write one would be lying about the only
   * thing this screen exists to demonstrate.
   */
  readonly live: boolean;
};

const FIXTURE_NOTE =
  "Demo fixture. Decisions are only recorded against the live queue — this row has no database row behind it, and the screen will not pretend otherwise.";

function buttonClass(tone: "approve" | "reject" | "release"): string {
  const base = `inline-flex items-center rounded border px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-45`;
  if (tone === "reject") {
    return `${base} border-negative/50 text-negative enabled:hover:bg-surface-raised`;
  }
  if (tone === "release") {
    return `${base} border-border-strong text-text enabled:hover:bg-surface-raised`;
  }
  return `${base} border-positive/60 text-positive enabled:hover:bg-surface-raised`;
}

export function DecisionForm({
  instructionId,
  contentHash,
  gate,
  releaseGate,
  live,
}: DecisionFormProps) {
  const [state, formAction, pending] = useActionState(decideAction, IDLE);
  const reasonId = useId();
  const gateId = useId();
  const releaseId = useId();

  // The gate always wins over the fixture note: on `?state=edge` an operator
  // must be told they raised the payment, not that the row is a fixture.
  const decisionBlocked = !gate.allowed || !live;
  const decisionReason = !gate.allowed ? gate.reason : live ? null : FIXTURE_NOTE;
  const releaseBlocked = !releaseGate.allowed || !live;
  const releaseReason = !releaseGate.allowed ? releaseGate.reason : live ? null : FIXTURE_NOTE;

  const mine = state.instructionId === instructionId ? state : IDLE;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="instructionId" value={instructionId} />
      {/*
        The hash the approver actually saw, carried back verbatim. If the
        payment on screen is not the payment in the database, these differ and
        assert_maker_checker() refuses the INSERT. This field is the whole
        mechanism, which is why it is never re-read on the server.
      */}
      <input type="hidden" name="contentHash" value={contentHash} />

      <div>
        <label htmlFor={reasonId} className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Reason
        </label>
        <textarea
          id={reasonId}
          name="reason"
          rows={2}
          maxLength={500}
          disabled={pending}
          placeholder="What did you check? Stored on the event, immutably."
          className={`mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-xs ${FOCUS_RING} disabled:opacity-60`}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="intent"
          value="approve"
          disabled={decisionBlocked || pending}
          aria-describedby={decisionReason === null ? undefined : gateId}
          className={buttonClass("approve")}
        >
          {pending ? "Working…" : "Approve"}
        </button>

        <button
          type="submit"
          name="intent"
          value="reject"
          disabled={decisionBlocked || pending}
          aria-describedby={decisionReason === null ? undefined : gateId}
          className={buttonClass("reject")}
        >
          Reject
        </button>

        <button
          type="submit"
          name="intent"
          value="release"
          disabled={releaseBlocked || pending}
          aria-describedby={releaseReason === null ? undefined : releaseId}
          className={buttonClass("release")}
        >
          Release
        </button>
      </div>

      {decisionReason === null ? null : (
        <p
          id={gateId}
          className={`max-w-prose text-[11px] leading-relaxed ${
            gate.code === "self_initiated" ? "text-negative" : "text-muted"
          }`}
        >
          <span className="font-semibold">
            {gate.code === "self_initiated" ? "Approve is disabled: " : "Disabled: "}
          </span>
          {decisionReason}
        </p>
      )}

      {releaseReason === null || releaseReason === decisionReason ? null : (
        <p id={releaseId} className="max-w-prose text-[11px] leading-relaxed text-muted">
          <span className="font-semibold">Release is disabled: </span>
          {releaseReason}
        </p>
      )}

      <p aria-live="polite" className="sr-only">
        {pending ? "Recording the decision" : mine.message}
      </p>

      {mine.status === "idle" ? null : (
        <div
          className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${
            mine.status === "ok"
              ? "border-positive/40 text-text"
              : "border-negative/50 text-text"
          }`}
        >
          <p className="font-semibold">
            {mine.status === "ok" ? "Recorded" : "Refused by the database"}
            {mine.code === null ? null : (
              <span className="ml-2 font-mono text-[11px] font-normal text-muted">{mine.code}</span>
            )}
          </p>
          <p className="mt-1 max-w-prose text-muted">{mine.message}</p>
        </div>
      )}
    </form>
  );
}
