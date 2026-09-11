"use client";

import { useActionState, useId, useState } from "react";

import { signWarningAction, type CheckFindingView, type SignResult } from "@/app/(app)/payees/actions";
import { Badge, FOCUS_RING, Note } from "@/components/ui/primitives";
import { composeAcknowledgement, REASON_MIN_LENGTH } from "@/lib/payees/acknowledge-text";

/**
 * The signature — the act that makes a warning a warning.
 *
 * ============================================================================
 * WHAT IT IS NOT.
 *
 * Not an exception, not an override flag, not permission. The payment gate
 * refuses a payee whose standing warning nobody has signed for, and that is
 * not a block on the warning: the warning is overridable, by anybody, at any
 * time, in one step. It is a refusal to let the override be IMPLICIT. This is
 * the one step, and it costs a sentence.
 *
 * A hard block on a name mismatch does not stop fraud. It stops legitimate
 * payments — trading names, subsidiaries paid into a parent's account, a
 * factoring company paid instead of the supplier who raised the invoice — and
 * then it gets switched off. Every mature Confirmation of Payee scheme lets
 * the payer proceed after an explicit acknowledgement, for exactly these
 * reasons. So the warning is made to COST something instead.
 *
 * ============================================================================
 * WHY EVERY FINDING IS TICKED SEPARATELY, AND WHY THEY ARE ALL REQUIRED.
 *
 * Acknowledging "a warning" and acknowledging "this beneficiary is at a
 * different bank from the one already on your book" are different acts. Six
 * months from now the row has to say which one happened — otherwise the
 * audit trail records that somebody clicked, which is the checkbox this
 * feature exists not to be. So each warn-level finding is a checkbox with its
 * own code and its own title, the stored sentence names them, and the preview
 * below shows the operator the exact text before it is written.
 *
 * ALL of them are required, and that is not tidiness. A signature answering
 * one of two warnings, with the payment then proceeding, is the implicit
 * override again wearing a form. The server refuses a set that is not exactly
 * the warn set on the check — and it re-reads that set from
 * `payee_verification` rather than believing what this form posts, because a
 * re-check can land between the render and the submit and then the warning on
 * screen is not the warning standing against the payee.
 *
 * ============================================================================
 * AND IT CANNOT BE TAKEN BACK.
 *
 * `payee_acknowledgement` is append-only by grant, by explicit REVOKE of
 * UPDATE/DELETE, and by 0001's `ledger_row_is_immutable()` trigger, which
 * binds the table owner too. A trigger also refuses one against a check that
 * was not `warned`. The row is attached to THAT check and not to the payee, so
 * a later check raises a new warning and needs a new signature — an
 * acknowledgement from June says nothing about what was found this morning.
 * ============================================================================
 */

const IDLE: SignResult = { status: "idle", code: null, message: "", signature: null };

export function SignWarningForm({
  verificationId,
  findings,
  beneficiaryName,
}: {
  readonly verificationId: string;
  readonly findings: readonly CheckFindingView[];
  readonly beneficiaryName: string;
}) {
  const [state, formAction, pending] = useActionState(signWarningAction, IDLE);
  const ids = useId();
  const [reason, setReason] = useState("");
  const [ticked, setTicked] = useState<readonly string[]>([]);

  const allTicked = findings.length > 0 && ticked.length === findings.length;
  const reasonLongEnough = reason.trim().length >= REASON_MIN_LENGTH;

  const preview = composeAcknowledgement(
    reason.trim().length === 0 ? "…" : reason,
    findings.map((finding) => ({ code: finding.code, title: finding.title })),
  );

  if (state.status === "signed" && state.signature !== null) {
    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">SIGNED</Badge>
          <span className="text-sm font-medium">{state.signature.signedByName}</span>
        </div>
        <p className="max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>
        <p className="max-w-prose rounded border border-border bg-surface-raised px-3 py-2 text-xs leading-relaxed">
          {state.signature.reason}
        </p>
        <p className="font-mono text-[11px] text-muted">
          payee_acknowledgement {state.signature.acknowledgementId} · verification{" "}
          {state.signature.verificationId}
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="verificationId" value={verificationId} />

      <fieldset className="space-y-2">
        <legend className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          what you are signing for
        </legend>
        {findings.map((finding) => {
          const checked = ticked.includes(finding.code);
          return (
            <label
              key={finding.code}
              className="flex gap-3 rounded border border-border bg-surface-raised px-3 py-2"
            >
              <input
                type="checkbox"
                name="code"
                value={finding.code}
                checked={checked}
                onChange={(event) =>
                  setTicked((current) =>
                    event.target.checked
                      ? [...current, finding.code]
                      : current.filter((code) => code !== finding.code),
                  )
                }
                className={`mt-0.5 ${FOCUS_RING}`}
              />
              <span>
                <span className="block text-sm font-medium">{finding.title}</span>
                <code className="text-[11px] text-muted">{finding.code}</code>
                <span className="mt-1 block max-w-prose text-xs leading-relaxed text-muted">
                  {finding.detail}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <div>
        <label
          htmlFor={`${ids}-reason`}
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
        >
          why it is right to pay {beneficiaryName}
        </label>
        <textarea
          id={`${ids}-reason`}
          name="reason"
          required
          rows={3}
          maxLength={2000}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Called the supplier's finance line on the number from last year's contract, not the one in the email. They confirmed the account change."
          className={`mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING}`}
        />
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
          Name the channel you confirmed through, not the fact that you confirmed. &ldquo;Checked
          with the supplier&rdquo; is what somebody writes after replying to the email that asked
          for the change. At least {REASON_MIN_LENGTH} characters.
        </p>
      </div>

      <div className="rounded border border-dashed border-border-strong px-3 py-2">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          exactly what will be written
        </p>
        <p className="mt-1 max-w-prose text-xs leading-relaxed">{preview}</p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending || !allTicked || !reasonLongEnough}
          className={`rounded border border-border-strong px-3 py-1.5 text-sm font-medium ${FOCUS_RING} disabled:opacity-50`}
        >
          {pending ? "Recording the signature" : "Sign and record"}
        </button>
        <p className="text-[11px] leading-relaxed text-muted" aria-live="polite">
          {allTicked
            ? reasonLongEnough
              ? "This writes one append-only row naming you, the instant, and the findings above. It cannot be edited or withdrawn."
              : "The sentence is the point. Without one there is nothing for a later reader to weigh."
            : `Every warning on this check has to be answered — ${ticked.length} of ${findings.length} ticked. Signing for one of two and letting the payment through is the implicit override the gate refuses.`}
        </p>
      </div>

      {state.status === "refused" ? (
        <Note emphasis title={state.code ?? "Refused"}>
          <p>{state.message}</p>
        </Note>
      ) : null}
    </form>
  );
}
