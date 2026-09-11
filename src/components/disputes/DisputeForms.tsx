"use client";

import { useActionState, useId, useState } from "react";

import {
  disputeTransitionAction,
  raiseDisputeAction,
  type Issue,
  type RaiseResult,
  type TransitionResult,
} from "@/app/(app)/disputes/actions";
import { formatUsd } from "@/lib/format/money";
import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";

import type { CaseView, ChargeView, PolicyView, ReasonCodeView } from "./data-contract";

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";
const BUTTON_CLASS = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;

const RAISE_IDLE: RaiseResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  caseRef: null,
  disputeId: null,
};

const TRANSITION_IDLE: TransitionResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  entryIds: [],
  newStatus: null,
};

function Issues({ issues }: { readonly issues: readonly Issue[] }) {
  return (
    <ul className="mt-2 space-y-1 text-xs">
      {issues.map((issue) => (
        <li key={`${issue.path}:${issue.message}`}>
          <span className="money">{issue.path}</span> — {issue.message}
        </li>
      ))}
    </ul>
  );
}

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
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="mt-1 block text-[11px] leading-relaxed text-muted">{hint}</span>
      )}
    </label>
  );
}

function Receipt({ state }: { readonly state: TransitionResult | RaiseResult }) {
  if (state.status === "idle") return null;
  const refused = state.status === "refused";
  return (
    <Note emphasis={refused} title={refused ? `Refused — ${state.code ?? "?"}` : "Recorded"}>
      <p>{state.message}</p>
      {state.issues === null ? null : <Issues issues={state.issues} />}
      {"entryIds" in state && state.entryIds.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {state.entryIds.map((id) => (
            <li key={id} className="text-[11px]">
              entry <span className="money">{id}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {"caseRef" in state && state.caseRef !== null ? (
        <p className="mt-2 text-[11px]">
          case <span className="money">{state.caseRef}</span>
        </p>
      ) : null}
    </Note>
  );
}

/* -------------------------------------------------------------------------- */
/* Intake                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Raise a dispute against a SETTLED CARD CHARGE.
 *
 * The subject is picked from a list of real entries, never typed: the select
 * carries `journal_entry.id`, and everything about whose money it was and how
 * much of it is still unclaimed is read off the journal. There is no free-text
 * amount field that could name money nobody was ever charged — the amount is
 * bounded by the charge, and the database bounds it again.
 */
export function RaiseDisputeForm({
  charges,
  reasonCodes,
  policy,
  disabled,
}: {
  readonly charges: readonly ChargeView[];
  readonly reasonCodes: readonly ReasonCodeView[];
  readonly policy: PolicyView | null;
  readonly disabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(raiseDisputeAction, RAISE_IDLE);
  const [entryId, setEntryId] = useState<string>(charges[0]?.entryId ?? "");
  const [networkCode, setNetworkCode] = useState<string>(
    reasonCodes[0] === undefined ? "" : `${reasonCodes[0].network}/${reasonCodes[0].networkCode}`,
  );
  const chargeId = useId();
  const amountId = useId();
  const narrativeId = useId();

  const charge = charges.find((c) => c.entryId === entryId) ?? charges[0];
  const selectedCode = reasonCodes.find((r) => `${r.network}/${r.networkCode}` === networkCode);

  return (
    <Panel
      id="raise"
      title="Raise a dispute"
      description="Against a settled card transaction — one that already cleared, where the money has gone. An authorisation never reaches the financial book, so a hold cannot be disputed here and the list below cannot offer one."
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        {charges.length === 0 ? (
          <p className="max-w-prose text-sm text-muted">
            This customer has no settled card charge with money still outstanding
            on it. A charge the merchant already reversed has given the money
            back, so there is nothing left to claim and it is not offered.
          </p>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Settled charge"
                hint="Real journal entries. The amount claimed cannot exceed what is still outstanding on the one you pick."
              >
                <select
                  id={chargeId}
                  name="disputedEntryId"
                  value={entryId}
                  onChange={(event) => {
                    setEntryId(event.target.value);
                  }}
                  disabled={disabled || pending}
                  className={INPUT_CLASS}
                >
                  {charges.map((c) => (
                    <option key={c.entryId} value={c.entryId}>
                      {c.valueDate} · {formatUsd(c.disputableCents)} ·{" "}
                      {c.cardLastFour === null ? c.description : `card ••${c.cardLastFour}`}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Amount claimed"
                hint="Integer cents on the wire. A partial claim is legitimate — an incorrect-amount dispute is usually only the difference."
              >
                <input
                  id={amountId}
                  name="amount"
                  type="text"
                  inputMode="decimal"
                  required
                  defaultValue={
                    charge === undefined
                      ? ""
                      : formatUsd(charge.disputableCents, { symbol: false, group: false })
                  }
                  disabled={disabled || pending}
                  className={INPUT_CLASS}
                />
              </Field>

              <Field label="Our reason" hint="Our vocabulary; the network's code is separate.">
                <select
                  name="reason"
                  defaultValue={selectedCode?.reason ?? "fraud"}
                  disabled={disabled || pending}
                  className={INPUT_CLASS}
                >
                  {[...new Set(reasonCodes.map((r) => r.reason))].map((reason) => (
                    <option key={reason} value={reason}>
                      {reason.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Network reason code"
                hint="Visa and Mastercard number these differently and draw the boundaries differently, which is why they live in a lookup table and not in our enum."
              >
                <select
                  name="networkCode"
                  value={networkCode}
                  onChange={(event) => {
                    setNetworkCode(event.target.value);
                  }}
                  disabled={disabled || pending}
                  className={INPUT_CLASS}
                >
                  {reasonCodes.map((r) => (
                    <option key={`${r.network}/${r.networkCode}`} value={`${r.network}/${r.networkCode}`}>
                      {r.network} {r.networkCode} — {r.networkLabel}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            {selectedCode === undefined ? null : (
              <Note title={`What ${selectedCode.network} ${selectedCode.networkCode} requires`}>
                <p>{selectedCode.evidenceNote}</p>
              </Note>
            )}

            <Field
              label="What the customer said"
              hint="Their words, recorded once. This is the narrative the evidence is built from and it is never edited."
            >
              <textarea
                id={narrativeId}
                name="narrative"
                rows={3}
                required
                minLength={10}
                maxLength={500}
                placeholder="Cardholder states the card was in their possession and they did not make this purchase."
                disabled={disabled || pending}
                className={INPUT_CLASS}
              />
            </Field>

            <div className="flex flex-wrap items-center gap-3">
              <button type="submit" disabled={disabled || pending} className={BUTTON_CLASS}>
                {pending ? "Opening…" : "Open the case"}
              </button>
              {policy === null ? null : (
                <span className="text-[11px] text-muted">
                  Provisional credit of <Money cents={policy.thresholdCents} /> or more needs{" "}
                  {policy.requiredApprovals} Corgi approver
                  {policy.requiredApprovals === 1 ? "" : "s"} who did not raise the case.
                </span>
              )}
              {disabled ? (
                <span className="text-[11px] text-muted">
                  Fixture state — the form is inert here. Switch to Default to open a real case.
                </span>
              ) : null}
            </div>
          </>
        )}

        <Receipt state={state} />
      </form>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Everything after intake                                                    */
/* -------------------------------------------------------------------------- */

type Step = {
  readonly intent: string;
  readonly label: string;
  readonly why: string;
  readonly movesMoney: boolean;
};

/**
 * Which controls a case can be offered, given where it is.
 *
 * This is a MIRROR of `canTransition()` in `src/lib/disputes/model.ts`, which
 * is itself a mirror of the trigger. Three copies sounds like two too many, and
 * each one is doing a different job: the trigger is the law, the model produces
 * a sentence instead of a SQLSTATE, and this decides what to put on a screen.
 * Pressing a button this function hid would still be refused by the other two.
 */
function stepsFor(c: CaseView): readonly Step[] {
  if (c.isClosed) return [];

  const steps: Step[] = [];
  const decided =
    c.status === "won_pending_finalization" || c.status === "lost_pending_recovery";
  const creditSettled =
    c.advancedCents > 0 ||
    c.heldCents > 0 ||
    c.status === "provisional_credit_granted" ||
    c.status === "provisional_credit_declined";

  // ---- the advance --------------------------------------------------
  if (!creditSettled && !decided) {
    steps.push({
      intent: "authorize",
      label: "Authorise the advance",
      why: "A second Corgi human signs off. Not the raiser, and never somebody who works for the customer being paid.",
      movesMoney: false,
    });

    const blocked = c.needsAuthorization && c.authorizations < c.requiredApprovals;
    steps.push({
      intent: "grant",
      label: blocked ? "Grant provisional credit (will be refused)" : "Grant provisional credit",
      why: blocked
        ? `At or above the threshold with ${String(c.authorizations)}/${String(c.requiredApprovals)} authorisations. Press it anyway: the database refuses and nothing posts.`
        : "Posts the credit to the customer's ledger AND opens the hold that stops them spending it.",
      movesMoney: !blocked,
    });

    steps.push({
      intent: "decline",
      label: "Decline the advance",
      why: "We will not advance. The customer is made whole on the decision, not before it.",
      movesMoney: false,
    });
  }

  // ---- the case ------------------------------------------------------
  if (!decided) {
    steps.push(
      {
        intent: "evidence",
        label: "File evidence",
        why: "Recorded against the case. Operator-driven: there is no sandbox endpoint to file it to.",
        movesMoney: false,
      },
      {
        intent: "won",
        label: "Record: network found for the customer",
        why: "OPERATOR ACTION. Lithic's sandbox has no dispute simulator, so somebody types the verdict.",
        movesMoney: false,
      },
      {
        intent: "lost",
        label: "Record: network found for the merchant",
        why: "OPERATOR ACTION. The value date is the day the NETWORK decided — the clawback will carry it.",
        movesMoney: false,
      },
      {
        intent: "withdraw",
        label: "Customer withdrew",
        why: "Only while nothing has been advanced. After a grant this is a loss, not a withdrawal, and it is refused.",
        movesMoney: false,
      },
    );
  }

  // ---- resolution ----------------------------------------------------
  if (c.status === "won_pending_finalization") {
    steps.push({
      intent: "finalize",
      label: "Make the credit final",
      why: "Releases the hold. Nothing moves in the financial book: winning does not credit the customer twice, and no cash has arrived to debit 1110 for.",
      movesMoney: true,
    });
  }

  if (c.status === "lost_pending_recovery") {
    steps.push(
      {
        intent: "clawback",
        label: "Claw the advance back",
        why: "A NEW entry on the decision day, not a reversal of the grant. The hold has withheld the money the whole time, so this cannot overdraw them.",
        movesMoney: true,
      },
      {
        intent: "writeoff",
        label: "Write it off to 5200",
        why: "We absorb it instead. The customer keeps the money; the loss is ours and it is visible.",
        movesMoney: true,
      },
    );
  }

  return steps;
}

export function CaseActions({
  cases,
  disabled,
  actorName,
  canApprove,
}: {
  readonly cases: readonly CaseView[];
  readonly disabled: boolean;
  readonly actorName: string | null;
  readonly canApprove: boolean;
}) {
  const [state, formAction, pending] = useActionState(disputeTransitionAction, TRANSITION_IDLE);
  const open = cases.filter((c) => !c.isClosed);
  const [caseId, setCaseId] = useState<string>(open[0]?.disputeId ?? "");
  const selected = open.find((c) => c.disputeId === caseId) ?? open[0];

  if (open.length === 0) {
    return (
      <Panel title="Work a case" description="Every case on this customer is closed.">
        <div className="px-5 py-6">
          <p className="max-w-prose text-sm text-muted">
            Nothing is open. A resolved case is terminal — the trigger refuses
            every event that would follow one, so there is no control here that
            could reopen it.
          </p>
        </div>
      </Panel>
    );
  }

  const steps = selected === undefined ? [] : stepsFor(selected);

  return (
    <Panel
      id="work"
      title="Work a case"
      description="Acting as the current console role. Maker-checker is enforced in the database, so a control you are not entitled to press is shown and refused rather than hidden."
      actions={
        actorName === null ? null : (
          <Badge tone={canApprove ? "positive" : "quiet"}>
            {actorName} · {canApprove ? "approver" : "cannot approve"}
          </Badge>
        )
      }
    >
      <form action={formAction} className="space-y-4 px-5 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Case">
            <select
              name="disputeId"
              value={caseId}
              onChange={(event) => {
                setCaseId(event.target.value);
              }}
              disabled={disabled || pending}
              className={INPUT_CLASS}
            >
              {open.map((c) => (
                <option key={c.disputeId} value={c.disputeId}>
                  {c.caseRef} · {formatUsd(c.amountCents)} · {c.status.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Value date (optional)"
            hint="The day the FACT happened. Leave blank for today's business date. On a clawback this is the day the network decided — never the day the credit was granted, because the grant was not wrong."
          >
            <input
              name="valueDate"
              type="date"
              disabled={disabled || pending}
              className={INPUT_CLASS}
            />
          </Field>
        </div>

        <Field label="Detail" hint="Recorded on the event, immutably.">
          <input
            name="detail"
            type="text"
            maxLength={500}
            placeholder="Network found for the merchant on representment."
            disabled={disabled || pending}
            className={INPUT_CLASS}
          />
        </Field>

        <div className="space-y-2">
          {steps.map((step) => (
            <div key={step.intent} className="flex flex-wrap items-start gap-3">
              <button
                type="submit"
                name="intent"
                value={step.intent}
                disabled={disabled || pending}
                className={BUTTON_CLASS}
              >
                {pending ? "Working…" : step.label}
              </button>
              <span className="max-w-prose flex-1 text-[11px] leading-relaxed text-muted">
                {step.movesMoney ? (
                  <Badge tone="neutral">posts money</Badge>
                ) : (
                  <Badge tone="quiet">no posting</Badge>
                )}{" "}
                {step.why}
              </span>
            </div>
          ))}
        </div>

        {disabled ? (
          <p className="text-[11px] text-muted">
            Fixture state — the controls are inert here. Switch to Default to work
            a real case.
          </p>
        ) : null}

        <Receipt state={state} />
      </form>
    </Panel>
  );
}
