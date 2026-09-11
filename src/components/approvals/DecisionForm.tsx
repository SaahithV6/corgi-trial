"use client";

import { useActionState, useId, useState } from "react";

import { decideAction, type DecisionResult } from "@/app/(app)/approvals/actions";
import { Money } from "@/components/ui/Money";
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
 *
 * RELEASE IS THE ONLY CONTROL ON THIS SCREEN THAT MOVES MONEY, so it is the
 * only one behind a second deliberate act. Approve and Reject both add an event
 * and stop; Release posts the journal entry and hands the instruction to a rail,
 * and on an irreversible rail there is nothing after it. The checkbox names the
 * amount and the destination, and the server action refuses a release that did
 * not carry it — so this is a control, not a courtesy. See `actions.ts`.
 */

const IDLE: DecisionResult = {
  status: "idle",
  code: null,
  message: "",
  instructionId: null,
};

/**
 * What to do next about each refusal, as a sentence the operator can act on.
 *
 * The codes and their explanations come from `src/lib/approvals/refusal.ts`,
 * which says accurately what the database refused and — being a library with no
 * screen under it — cannot say where to go. This map is that half. A code with
 * no next step is a dead end, so every code that reaches this form has one.
 *
 * Roles are switched with the "Acting as" control in the page header; there is
 * no URL that sets one, so the remedy names the control rather than inventing a
 * link that would not work.
 */
const REMEDY: Record<string, string> = {
  SELF_APPROVAL:
    "Next: hand this payment to another human. It stays in this queue until one of them approves it; nothing expires and nothing is lost.",
  NOT_AN_APPROVER:
    "Next: switch to Approver with the “Acting as” control in the page header, or ask someone who holds that role. Staff may raise a payment and may never check one.",
  AGENT_CANNOT_APPROVE:
    "Next: a human has to approve this one. Switch to Approver with the “Acting as” control in the page header.",
  STALE_APPROVAL:
    "Next: reload /approvals and read the row again. The amount, destination or rail moved under you, and the approval you are holding was for the old one.",
  INSUFFICIENT_APPROVALS:
    "Next: collect the approvals the policy version on this row names — the “x of y approvals held” line above counts them — then release it.",
  ALREADY_RELEASED:
    "Next: nothing. The money is already out. The journal entry it posted is on the paying account’s Activity table, under the release timestamp in the lifecycle list above.",
  ALREADY_DECIDED:
    "Next: nothing on this row. Raise a fresh instruction on /payments if the money still needs to move.",
  NOT_RELEASED:
    "Next: release it first. Release is the step that posts the entry; everything downstream of the money is keyed on that.",
  DUPLICATE_DECISION:
    "Next: a second approval has to come from a different person. Two approvals from one actor never satisfy a two-approver rule.",
  IMMUTABLE:
    "Next: append a new event rather than changing this one. Reject or cancel, then raise a corrected instruction on /payments.",
  FORBIDDEN:
    "Next: this is not fixable from the console. The application role holds no UPDATE or DELETE on any money table; if this step genuinely needs to happen it needs a migration, not a retry.",
  NO_SUCH_INSTRUCTION:
    "Next: reload /approvals. The row you were looking at is not the row the database was asked about — usually a stale tab.",
  UNAVAILABLE:
    "Next: retry. Nothing was written — the whole step is one transaction — so a second attempt cannot double anything.",
  INVALID_REQUEST:
    "Next: reload /approvals and press the button on the row itself. Nothing was written.",
  RELEASE_NOT_CONFIRMED:
    "Next: tick the release confirmation beside the button, which names the amount and the destination, then press Release again.",
  APPROVALS_NO_DATABASE:
    "Next: this deployment has no APP_DATABASE_URL. Nothing can be approved or released here at all; there is no retry that changes that.",
  NO_ACTOR:
    "Next: pick an identity with the “Acting as” control in the page header. Every event on a payment is attributed to an actor row, so a decision with nobody behind it is not writable.",
};

export type DecisionFormProps = {
  readonly instructionId: string;
  readonly contentHash: string;
  readonly gate: Gate;
  readonly releaseGate: Gate;
  /**
   * Named on the release confirmation, so the second act is about THIS payment
   * rather than about a button. Optional because `NeedsAHuman` on the dashboard
   * renders this same form and belongs to another worker on this build; when
   * they are absent the confirmation still gates the button and says what it
   * can say, which is that release posts the entry and hands it to the rail.
   */
  readonly amountCents?: number;
  readonly destination?: string;
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
  amountCents,
  destination,
  live,
}: DecisionFormProps) {
  const [state, formAction, pending] = useActionState(decideAction, IDLE);
  const [releaseConfirmed, setReleaseConfirmed] = useState(false);
  const reasonId = useId();
  const gateId = useId();
  const releaseId = useId();
  const confirmId = useId();

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
          disabled={releaseBlocked || pending || !releaseConfirmed}
          aria-describedby={releaseReason === null ? confirmId : `${releaseId} ${confirmId}`}
          className={buttonClass("release")}
        >
          Release
        </button>
      </div>

      <div className="flex max-w-prose items-start gap-2">
        <input
          type="checkbox"
          id={confirmId}
          name="releaseConfirmed"
          value="yes"
          checked={releaseConfirmed}
          onChange={(event) => setReleaseConfirmed(event.target.checked)}
          disabled={releaseBlocked || pending}
          className={`mt-0.5 ${FOCUS_RING}`}
        />
        <label htmlFor={confirmId} className="text-[11px] leading-relaxed text-muted">
          Release sends{" "}
          {amountCents === undefined ? (
            "this payment"
          ) : (
            <Money cents={amountCents} tone="neutral" />
          )}
          {destination === undefined ? null : (
            <>
              {" "}to <span className="text-text">{destination}</span>
            </>
          )}
          . It posts the journal entry and hands the instruction to the rail; on a wire or a USDC
          transfer there is no step after it. Approve and Reject only add an event, so neither
          needs this box.
        </label>
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
          {mine.status === "refused" && mine.code !== null && REMEDY[mine.code] !== undefined ? (
            <p className="mt-1.5 max-w-prose text-text">{REMEDY[mine.code]}</p>
          ) : null}
        </div>
      )}
    </form>
  );
}
