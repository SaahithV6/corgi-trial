"use client";

/**
 * The card control forms. Everything on this panel that writes lives here.
 *
 * Same three properties as `ConsoleForms.tsx`, for the same reasons:
 *
 *   PENDING IS VISIBLE. `useFormStatus` disables and renames the button while
 *   the action is in flight.
 *   THE RESULT IS ATTACHED TO THE CONTROL THAT PRODUCED IT. `useActionState`
 *   per form, rendered beneath it, so a refused limit can never be read as a
 *   refused replay.
 *   NO AMOUNT IS EVER A `number`. Limits are typed as dollars, parsed to
 *   `bigint` cents on the server by the same function the console uses, and
 *   come back as decimal strings.
 *
 * One property this file adds: THE FORM IS PRE-FILLED WITH THE CURRENT
 * VERSION. A control screen that opens blank invites an operator to save a
 * version that silently drops every limit they did not retype. Saving is
 * "here is the complete new control set", so the form has to show the complete
 * current one.
 */

import { useActionState, useId, useState } from "react";
import { useFormStatus } from "react-dom";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";
import { MCC_GROUPS, describeMcc } from "@/lib/cards/mcc";
import {
  IDLE_CONTROL_RESULT,
  type CardControlsActionResult,
} from "@/lib/cards/view-state";

import {
  replayAuthorizationAction,
  setCardControlsAction,
} from "./CardControlsActions";

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

function Submit({
  label,
  pendingLabel,
}: {
  readonly label: string;
  readonly pendingLabel: string;
}) {
  const status = useFormStatus();
  return (
    <button type="submit" disabled={status.pending} className={`${BUTTON_CLASS} ${FOCUS_RING}`}>
      {status.pending ? pendingLabel : label}
    </button>
  );
}

/** The action's answer, rendered under the control that produced it. */
function ResultPanel({ result }: { readonly result: CardControlsActionResult }) {
  if (result.status === "idle") return null;

  const tone = result.status === "ok" ? "positive" : "negative";
  return (
    <div
      className="mt-3 rounded border border-border bg-surface px-3 py-2.5"
      // Announced, because an operator who has just frozen a card needs to know
      // it took, and a screen reader user gets no visual cue that it did.
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center gap-2">
        <Badge tone={tone}>{result.status === "ok" ? "applied" : "refused"}</Badge>
        {result.code === null ? null : (
          <span className="font-mono text-[11px] text-muted">{result.code}</span>
        )}
      </div>
      <p className="mt-1.5 max-w-prose text-xs leading-relaxed">{result.message}</p>
      {result.facts.length === 0 ? null : (
        <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[10rem_1fr]">
          {result.facts.map((fact) => (
            <div key={fact.label} className="contents">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{fact.label}</dt>
              <dd className={`text-xs ${fact.mono === true ? "font-mono" : ""}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Setting controls                                                           */
/* -------------------------------------------------------------------------- */

export type ControlsFormProps = {
  readonly cardId: string;
  readonly cardLabel: string;
  /** Dollars, pre-filled from the current version. `""` means no limit. */
  readonly perTxn: string;
  readonly daily: string;
  readonly monthly: string;
  readonly blockedMccs: readonly string[];
  readonly frozen: boolean;
  /** False on the fixture states, which must not be able to write. */
  readonly live: boolean;
};

export function CardControlsForm(props: ControlsFormProps) {
  const [result, action] = useActionState(setCardControlsAction, IDLE_CONTROL_RESULT);
  const ids = useId();
  // Local state only so the quick-block buttons can add to the textarea. The
  // authoritative value is whatever the field holds at submit; nothing here is
  // a second copy of the control set.
  const [mccs, setMccs] = useState(props.blockedMccs.join(", "));
  const [frozen, setFrozen] = useState(props.frozen);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="cardId" value={props.cardId} />
      <input type="hidden" name="cardState" value={frozen ? "frozen" : "active"} />

      <div className="flex items-center justify-between gap-3 rounded border border-border bg-surface px-3 py-2">
        <div>
          <p className="text-xs font-medium">Card is {frozen ? "frozen" : "on"}</p>
          <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-muted">
            Freeze is checked before every limit and before the category list. A
            frozen card declines with <span className="font-mono">CARD_PAUSED</span>,
            and it declines even when the control store is unreachable — that is
            the fail-closed default, and it is the promise this feature makes.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setFrozen((v) => !v)}
          disabled={!props.live}
          className={`${BUTTON_CLASS} ${FOCUS_RING} shrink-0`}
          aria-pressed={frozen}
        >
          {frozen ? "Unfreeze" : "Freeze"}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Per transaction" hint="Blank = no limit. 0 = may spend nothing.">
          <input
            id={`${ids}-pertxn`}
            name="perTxn"
            defaultValue={props.perTxn}
            inputMode="decimal"
            placeholder="10.00"
            disabled={!props.live}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Daily" hint="Book day, America/New_York.">
          <input
            id={`${ids}-daily`}
            name="daily"
            defaultValue={props.daily}
            inputMode="decimal"
            placeholder="250.00"
            disabled={!props.live}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="Monthly" hint="Book month, same clock.">
          <input
            id={`${ids}-monthly`}
            name="monthly"
            defaultValue={props.monthly}
            inputMode="decimal"
            placeholder="5000.00"
            disabled={!props.live}
            className={INPUT_CLASS}
          />
        </Field>
      </div>

      <Field
        label="Blocked merchant categories"
        hint="Four-digit ISO 18245 codes. A code that is not four digits is refused, never padded — '763' padded to '0763' would block agricultural co-operatives nobody chose."
      >
        <textarea
          id={`${ids}-mcc`}
          name="blockedMccs"
          value={mccs}
          onChange={(event) => setMccs(event.target.value)}
          rows={2}
          disabled={!props.live}
          placeholder="5542, 7995"
          className={`${INPUT_CLASS} font-mono`}
        />
      </Field>

      <div className="flex flex-wrap gap-1.5">
        {MCC_GROUPS.map((group) => (
          <button
            key={group.id}
            type="button"
            disabled={!props.live}
            title={group.description}
            onClick={() =>
              setMccs((current) => {
                const existing = current
                  .split(/[\s,;]+/)
                  .map((t) => t.trim())
                  .filter((t) => t !== "");
                return [...new Set([...existing, ...group.codes])].sort().join(", ");
              })
            }
            className={`${BUTTON_CLASS} ${FOCUS_RING} text-[11px]`}
          >
            + {group.label}
          </button>
        ))}
      </div>

      <Field
        label="Why"
        hint="Required. This version is permanent and the note is the first thing read when a decline is disputed."
      >
        <input
          id={`${ids}-note`}
          name="note"
          placeholder="Card issued to a contractor; fuel and gambling blocked."
          disabled={!props.live}
          className={INPUT_CLASS}
        />
      </Field>

      <div className="flex items-center gap-3">
        <Submit label="Append control version" pendingLabel="Appending…" />
        <span className="text-[11px] leading-relaxed text-muted">
          Appends a new version. Nothing is edited and nothing is deleted — the
          version a past decision cited still says what it said.
        </span>
      </div>

      <ResultPanel result={result} />
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Replaying an authorisation through the decision function                   */
/* -------------------------------------------------------------------------- */

export type ReplayFormProps = {
  readonly cardId: string;
  readonly cardToken: string;
  readonly live: boolean;
};

export function ReplayAuthorizationForm(props: ReplayFormProps) {
  const [result, action] = useActionState(replayAuthorizationAction, IDLE_CONTROL_RESULT);
  const ids = useId();

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="cardId" value={props.cardId} />
      <input type="hidden" name="cardToken" value={props.cardToken} />

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Amount">
          <input
            id={`${ids}-amount`}
            name="amount"
            defaultValue="50.00"
            inputMode="decimal"
            disabled={!props.live}
            className={INPUT_CLASS}
          />
        </Field>
        <Field label="MCC" hint={describeMcc("5542")}>
          <input
            id={`${ids}-mcc`}
            name="mcc"
            defaultValue="5542"
            inputMode="numeric"
            disabled={!props.live}
            className={`${INPUT_CLASS} font-mono`}
          />
        </Field>
        <Field label="Message type">
          <select
            id={`${ids}-status`}
            name="requestStatus"
            defaultValue="AUTHORIZATION"
            disabled={!props.live}
            className={INPUT_CLASS}
          >
            <option value="AUTHORIZATION">AUTHORIZATION</option>
            <option value="FINANCIAL_AUTHORIZATION">FINANCIAL_AUTHORIZATION</option>
            <option value="CREDIT_AUTHORIZATION">CREDIT_AUTHORIZATION</option>
            <option value="BALANCE_INQUIRY">BALANCE_INQUIRY</option>
          </select>
        </Field>
      </div>

      <div className="flex items-center gap-3">
        <Submit label="Replay through the decision function" pendingLabel="Deciding…" />
        <Badge tone="quiet">harness — not a provider call</Badge>
      </div>

      <ResultPanel result={result} />
    </form>
  );
}
