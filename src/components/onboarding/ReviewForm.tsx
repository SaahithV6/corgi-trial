"use client";

import { useActionState, useId } from "react";

import { reviewAction, type OnboardingResult } from "@/app/(app)/onboarding/actions";
import { FOCUS_RING } from "@/components/ui/primitives";
import { MANUAL_MIN_REASON_LENGTH } from "@/lib/kyb/manual-review";

import type { LegView } from "./data-contract";
import { OpenedAccounts } from "./OpenedAccounts";

/**
 * ============================================================================
 * CLEAR THE QUEUE — the control that makes `needs_review` mean something.
 *
 * The business-registry leg runs on GLEIF, a real registry queried live, whose
 * population is financial-market participants. An ordinary small company is
 * simply absent from it, so the honest answer for most of this book is
 * `not_in_lei_registry`, and the honest status is `needs_review`.
 *
 * `needs_review` is a QUEUE. Before this control existed nothing could act on
 * it, which meant a correct check produced a permanently stuck account — and
 * because `canTransact()` runs inside `requestPayment()`, every outbound
 * payment on the book was refused. The fix was never to weaken the gate or to
 * invent an LEI for a demo company. It is the thing a real KYB operation does
 * with a registry miss: a named human reads the file and writes down what they
 * decided and why.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT LOOK LIKE.
 *
 *   It is not an "approve" button. The reason box is required, has a floor, and
 *   is the first thing in the form rather than an optional note after it — a
 *   reviewer should be typing their justification before they have chosen a
 *   verdict, not explaining one they already clicked.
 *
 *   It does not hide what it overrides. The registry's own answer is rendered
 *   above it and stays on the card afterwards, underneath the decision.
 *
 *   It does not promise a clean bill of health. The button says what the
 *   evidence label will become, because a person approving a business is a
 *   materially weaker claim than a registry confirming one and the operator
 *   pressing it should be told so at the moment they press it.
 * ============================================================================
 */

const IDLE: OnboardingResult = {
  status: "idle",
  intent: null,
  code: null,
  message: "",
  businessId: null,
  hostedUrl: null,
  directorReference: null,
  legs: [],
  accounts: null,
};

function buttonClass(tone: "approve" | "decline"): string {
  const base = `inline-flex items-center rounded border px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-45`;
  return tone === "approve"
    ? `${base} border-border-strong text-text enabled:hover:bg-surface-raised`
    : `${base} border-negative/50 text-negative enabled:hover:bg-surface-raised`;
}

export function ReviewForm({
  businessId,
  legalName,
  legs,
  live,
}: {
  readonly businessId: string;
  readonly legalName: string;
  readonly legs: readonly LegView[];
  readonly live: boolean;
}) {
  const [state, formAction, pending] = useActionState(reviewAction, IDLE);
  const reasonId = useId();
  const legId = useId();
  const helpId = useId();

  const mine: OnboardingResult = state.businessId === businessId ? state : IDLE;

  /**
   * Which legs a review could act on, and why the others are absent.
   *
   * `approved` legs are excluded because appending a manual approval to one
   * would only weaken its evidence from `live` to `manual` for no gain, and
   * `rejected` legs because a provider's decline is a decision about a fact
   * rather than a gap in coverage — `reviewRefusal()` refuses both on the
   * server, from the same rules, whatever this list contains.
   */
  const reviewable = legs.filter((leg) => leg.status === "pending" || leg.status === "needs_review");

  if (!live) {
    return (
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        <span className="font-semibold">Review is disabled on a fixture: </span>
        there is no evidence row behind it to append a decision to, and the screen will not pretend
        otherwise.
      </p>
    );
  }

  if (reviewable.length === 0) {
    return (
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        <span className="font-semibold">Nothing here is waiting on a human. </span>
        A leg is reviewable while it is <span className="font-mono">pending</span> or{" "}
        <span className="font-mono">needs_review</span>. An already-approved leg is not — appending
        a manual approval would weaken its evidence from <span className="font-mono">live</span> to{" "}
        <span className="font-mono">manual</span> for no gain — and neither is a{" "}
        <span className="font-mono">rejected</span> one, because a provider&rsquo;s decline is a
        decision about a fact rather than a gap in coverage, and this build has one operator role
        and no four-eyes on KYB.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="businessId" value={businessId} />

      <div className="space-y-1">
        <label
          htmlFor={legId}
          className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
        >
          Which leg
        </label>
        <select
          id={legId}
          name="leg"
          defaultValue={reviewable[0]?.leg}
          className={`w-full max-w-md rounded border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-text ${FOCUS_RING}`}
        >
          {reviewable.map((leg) => (
            <option key={leg.leg} value={leg.leg}>
              {leg.label} — currently {leg.status} ({leg.provider}
              {leg.providerCode === null ? "" : ` · ${leg.providerCode}`})
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label
          htmlFor={reasonId}
          className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted"
        >
          Reason — required, and it is the evidence
        </label>
        <textarea
          id={reasonId}
          name="reason"
          rows={3}
          minLength={MANUAL_MIN_REASON_LENGTH}
          maxLength={2000}
          required
          aria-describedby={helpId}
          placeholder="What did you look at, and what did you conclude? e.g. GLEIF holds no LEI for this entity, which is expected for a company of this size; incorporation certificate and EIN letter checked against the filing, both consistent."
          className={`w-full rounded border border-border bg-surface-raised px-2.5 py-1.5 text-xs leading-relaxed text-text placeholder:text-muted ${FOCUS_RING}`}
        />
        <p id={helpId} className="max-w-prose text-[11px] leading-relaxed text-muted">
          At least {MANUAL_MIN_REASON_LENGTH} characters, enforced here, again on the server, and a
          third time by a <span className="font-mono">CHECK</span> in the migration. Without it this
          row would say a person approved a business and nothing about why, which is worse than the
          registry answer it supersedes.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className={buttonClass("approve")}
        >
          {pending ? "Recording…" : "Approve on review"}
        </button>
        <button
          type="submit"
          name="decision"
          value="decline"
          disabled={pending}
          className={buttonClass("decline")}
        >
          Decline on review
        </button>
      </div>

      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        Either button appends <em>one row</em>. The provider&rsquo;s answer is not edited, flagged or
        removed — there is no <span className="font-mono">UPDATE</span> grant on that table to edit
        it with — and this becomes the latest thing anybody said about that leg. A reversal is a
        further row, with its own reason. The evidence label for the leg becomes{" "}
        <span className="font-mono">manual</span>, and because the composite takes the weakest label
        across both legs, this verification can never read <span className="font-mono">live</span>{" "}
        again.
      </p>

      <p aria-live="polite" className="sr-only">
        {pending ? `Recording a review for ${legalName}` : mine.message}
      </p>

      {mine.status === "idle" || mine.intent !== "review" ? null : (
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
          {/*
            The consequence, on the same response as the decision. An operator
            clearing this queue IS the approval event for a company the LEI
            registry has never heard of, so the account it opens belongs here,
            underneath the reason they typed, and not on some other screen they
            would have to go and check.
          */}
          {mine.accounts === null ? null : <OpenedAccounts accounts={mine.accounts} />}
        </div>
      )}
    </form>
  );
}
