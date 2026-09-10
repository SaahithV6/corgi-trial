"use client";

import { useActionState, useId } from "react";

import { onboardingAction, type OnboardingResult } from "@/app/(app)/onboarding/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

import type { TransactGateView } from "./data-contract";

/**
 * Four verbs on one business, one server action, one place the answer lands.
 *
 * ============================================================================
 * "TRY TO START A PAYMENT" IS NOT A DISABLED BUTTON.
 *
 * The gate's reason is rendered beside the control before anyone presses it —
 * that is the courtesy the approvals queue extends too — but the button stays
 * ENABLED on the live state, on purpose. Pressing it runs `canTransact()` on
 * the server against the derived state and returns the real denial code, so an
 * operator sees the actual refusal rather than a greyed-out control they have
 * to take on trust. A denial you can reproduce is a control; a disabled button
 * is a picture of one.
 *
 * `Start verification` and `Refresh` are different: both spend something real,
 * and starting a second verification for a business that already has evidence
 * on file would open a second session at Stripe for no new information. Those
 * two are disabled where they would be refused, with the reason stated, and the
 * server refuses them again regardless — `beginVerification()` checks the
 * evidence table itself.
 *
 * WHY `Re-check the registry` IS A FOURTH BUTTON AND NOT A PARAMETER ON REFRESH.
 *
 * The two legs cost different things. The director leg is a real POST that
 * creates an object in a Stripe account; the registry leg is a GET against a
 * public, key-less index that creates nothing and is free to repeat. More to
 * the point, this verb asks a DIFFERENT QUESTION: with an LEI in the box the
 * applicant has ASSERTED an identifier, and a registry can be asked about an
 * assertion directly — it confirms it, contradicts it, or has never heard of
 * it, and those are three different answers rather than three shades of one.
 * Without an LEI it re-runs the name search, whose miss is `needs_review` and
 * is correct and uninformative.
 *
 * THE CLAIM IS NOT STORED. `kyb_verification_leg` records what a PROVIDER said;
 * "the applicant says their LEI is X" is not that. What lands in the table is
 * GLEIF's answer, under GLEIF's name, with GLEIF's own code — and when the
 * identifier does not exist, a `gleif.notfound.` reference that says so in the
 * id itself. The row appends: the previous registry observation stays exactly
 * where it was, so a leg that went miss -> confirmed has both rows, in order.
 * ============================================================================
 */

/**
 * The idle value lives here, not in `actions.ts`: a `"use server"` module may
 * export only async functions, so a shared constant would break the build.
 */
const IDLE_RESULT: OnboardingResult = {
  status: "idle",
  intent: null,
  code: null,
  message: "",
  businessId: null,
  hostedUrl: null,
  directorReference: null,
  legs: [],
};

const FIXTURE_NOTE =
  "Demo fixture. Nothing is started, refreshed or checked against a fixture row: there is no database row behind it and no session at any provider, and the screen will not pretend otherwise.";

function buttonClass(tone: "primary" | "quiet" | "gate"): string {
  const base = `inline-flex items-center rounded border px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-45`;
  if (tone === "primary") return `${base} border-border-strong text-text enabled:hover:bg-surface-raised`;
  if (tone === "gate") return `${base} border-negative/50 text-negative enabled:hover:bg-surface-raised`;
  return `${base} border-border text-muted enabled:hover:bg-surface-raised enabled:hover:text-text`;
}

export type VerificationFormProps = {
  readonly businessId: string;
  readonly legalName: string;
  readonly legsOnFile: number;
  readonly gate: TransactGateView;
  /** False on the fixture demo states. */
  readonly live: boolean;
};

export function VerificationForm({
  businessId,
  legalName,
  legsOnFile,
  gate,
  live,
}: VerificationFormProps) {
  const [state, formAction, pending] = useActionState(onboardingAction, IDLE_RESULT);
  const startId = useId();
  const refreshId = useId();
  const gateId = useId();
  const leiId = useId();
  const recheckId = useId();

  const started = legsOnFile > 0;

  const startReason = !live
    ? FIXTURE_NOTE
    : started
      ? "A verification is already on file. Starting again would create a second identity session at the provider and tell us nothing new — refresh it instead."
      : null;

  const refreshReason = !live
    ? FIXTURE_NOTE
    : !started
      ? "Nothing to re-read: no verification has been started for this business."
      : null;

  const recheckReason = !live
    ? FIXTURE_NOTE
    : !started
      ? "Nothing to re-check against: a registry answer on its own is one leg, and the view reads a single leg as pending however good that leg is. Start a verification first."
      : null;

  const mine: OnboardingResult = state.businessId === businessId ? state : IDLE_RESULT;

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="businessId" value={businessId} />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="intent"
          value="begin"
          disabled={startReason !== null || pending}
          aria-describedby={startReason === null ? undefined : startId}
          className={buttonClass("primary")}
        >
          {pending ? "Working…" : "Start verification"}
        </button>

        <button
          type="submit"
          name="intent"
          value="refresh"
          disabled={refreshReason !== null || pending}
          aria-describedby={refreshReason === null ? undefined : refreshId}
          className={buttonClass("quiet")}
        >
          Refresh from the provider
        </button>

        <button
          type="submit"
          name="intent"
          value="recheck"
          disabled={recheckReason !== null || pending}
          aria-describedby={recheckId}
          className={buttonClass("quiet")}
        >
          Re-check the registry
        </button>

        <button
          type="submit"
          name="intent"
          value="gate"
          disabled={!live || pending}
          aria-describedby={gateId}
          className={buttonClass("gate")}
        >
          Try to start a payment
        </button>
      </div>

      <div className="space-y-1">
        <label
          htmlFor={leiId}
          className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
        >
          Asserted Legal Entity Identifier — optional
        </label>
        <input
          id={leiId}
          name="lei"
          type="text"
          inputMode="text"
          maxLength={20}
          placeholder="20 characters, ISO 17442 — leave blank to search by name"
          aria-describedby={recheckId}
          className={`w-full max-w-md rounded border border-border bg-surface-raised px-2.5 py-1.5 font-mono text-xs uppercase text-text placeholder:normal-case placeholder:text-muted ${FOCUS_RING}`}
        />
      </div>

      <p id={recheckId} className="max-w-prose text-[11px] leading-relaxed text-muted">
        {recheckReason === null ? (
          <>
            <span className="font-semibold">Re-check the registry: </span>a live GLEIF read, which
            creates nothing and is free to repeat. With an identifier in the box the applicant has
            ASSERTED one, and the registry either confirms it, contradicts it, or has never heard of
            it — and an identifier that does not exist is a decline rather than a shrug. Without one
            it searches by name, whose miss is <span className="font-mono">needs_review</span> and
            can never be an approval. The claim is not stored; GLEIF&rsquo;s answer is.
          </>
        ) : (
          <>
            <span className="font-semibold">Re-check is disabled: </span>
            {recheckReason}
          </>
        )}
      </p>

      {startReason === null ? null : (
        <p id={startId} className="max-w-prose text-[11px] leading-relaxed text-muted">
          <span className="font-semibold">Start is disabled: </span>
          {startReason}
        </p>
      )}

      {refreshReason === null || refreshReason === startReason ? null : (
        <p id={refreshId} className="max-w-prose text-[11px] leading-relaxed text-muted">
          <span className="font-semibold">Refresh is disabled: </span>
          {refreshReason}
        </p>
      )}

      <p
        id={gateId}
        className={`max-w-prose text-[11px] leading-relaxed ${
          gate.allowed ? "text-muted" : "text-negative"
        }`}
      >
        <span className="font-semibold">
          {gate.allowed ? "The gate allows this: " : `The gate refuses this (${gate.code}): `}
        </span>
        {gate.message}
        {live ? " Press it anyway — the same predicate runs on the server and answers for itself." : ` ${FIXTURE_NOTE}`}
      </p>

      <p aria-live="polite" className="sr-only">
        {pending ? `Working on ${legalName}` : mine.message}
      </p>

      {mine.status === "idle" ? null : (
        <div
          className={`rounded-md border px-3 py-2 text-xs leading-relaxed ${
            mine.status === "ok" ? "border-positive/40 text-text" : "border-negative/50 text-text"
          }`}
        >
          <p className="font-semibold">
            {mine.status === "ok" ? "Recorded" : "Refused"}
            {mine.code === null ? null : (
              <span className="ml-2 font-mono text-[11px] font-normal text-muted">{mine.code}</span>
            )}
          </p>
          <p className="mt-1 max-w-prose text-muted">{mine.message}</p>

          {mine.directorReference === null ? null : (
            <p className="mt-2 text-[11px] text-muted">
              Director KYC session:{" "}
              <code className="font-mono text-text">{mine.directorReference}</code> — a real object
              in a real Stripe account, quotable in a debrief and checkable in their dashboard.
            </p>
          )}

          {mine.hostedUrl === null ? null : (
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              Hosted flow:{" "}
              <a
                href={mine.hostedUrl}
                target="_blank"
                rel="noreferrer"
                className={`break-all font-mono text-text underline underline-offset-4 ${FOCUS_RING}`}
              >
                {mine.hostedUrl}
              </a>
              <span className="mt-1 block">
                Stripe issues this once, and it is short-lived and single-use — which is why it is
                handed back by the action and never stored in a column.
              </span>
            </p>
          )}

          {mine.legs.length === 0 ? null : (
            <ul className="mt-2 space-y-1 text-[11px] text-muted">
              {mine.legs.map((leg) => (
                <li key={leg.leg}>
                  <span className="font-medium text-text">{leg.label}</span> — {leg.status} ·{" "}
                  {leg.evidence} · <code className="font-mono">{leg.provider}</code>{" "}
                  <code className="font-mono break-all">{leg.reference}</code>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
