"use client";

import { useActionState, useId } from "react";

import { registryProbeAction, type RegistryProbeResult } from "@/app/(app)/onboarding/actions";
import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";
import { GLEIF_MISS_HEADLINE } from "@/lib/kyb";

import type { LegWiringView } from "./data-contract";
import { LegRow } from "./LegRow";

/**
 * ============================================================================
 * ASK THE REGISTRY. THIS IS THE CONTROL THAT MAKES THE LEG CHECKABLE.
 *
 * Every business seeded on this book is fictional, so GLEIF answers `not in the
 * LEI registry` for all three, and `needs_review` is the correct outcome — a
 * miss is evidence of nothing and can never be an approval. It is also the ONLY
 * outcome those three can produce, which would leave a reviewer with no way to
 * tell a registry that works from one that always shrugs, and no reason to
 * believe the citation machinery does anything.
 *
 * The dishonest fix is to rename a demo row after a real company. This is the
 * honest one: the same live adapter, the same renderer, the same citation line,
 * asked about whatever a reviewer types — and labelled, in the type, in the
 * action and here on the screen, as a question about the registry rather than a
 * verification of anybody.
 *
 * IT WRITES NOTHING. No row, no leg, no status, no business. That is stated on
 * the panel because a control that queries a real third party and shows a green
 * `approved` badge should say, before anyone has to ask, that it did not just
 * approve something.
 *
 * THE BADGE IS DERIVED, NOT WRITTEN. An earlier draft printed a hard-coded
 * `live · api.gleif.org` on this panel. With `KYB_FORCE_SIMULATED=business_registry`
 * set — which the deployment's own environment carries today — the probe would
 * have run the SIMULATOR behind a badge claiming a live registry: the exact
 * forgery the rest of this module is built to make impossible, reintroduced by
 * a decorative span. So the panel takes the registry leg's wiring and describes
 * whatever is actually wired, refusing to name GLEIF when GLEIF is not answering.
 * ============================================================================
 */

const IDLE: RegistryProbeResult = { status: "idle", code: null, message: "", probe: null };

/**
 * Worked examples, each one measured against the live API on 2026-09-10.
 *
 * They are here so the interesting outcomes are one click away rather than
 * something a reviewer has to know an LEI to reach — and so the claims in
 * docs/KYB.md have a button next to them that re-runs the measurement.
 */
const EXAMPLES: readonly { readonly query: string; readonly outcome: string }[] = [
  {
    query: "Apple Inc.",
    outcome: "approved — cites California Secretary of State, entry 806592, FULLY_CORROBORATED",
  },
  {
    query: "254900ZT6ZFUC887FB87",
    outcome:
      "rejected — RESILIENCE PARENT, LLC: entity INACTIVE, registration RETIRED, successor named",
  },
  {
    query: "ZZZZZZZZZZZZZZZZZZZZ",
    outcome: "rejected — an asserted identifier the registry has never heard of (HTTP 404)",
  },
  {
    query: "5299000RS1SH8F7PJ323",
    outcome: "needs_review — registration LAPSED: the LEI was not renewed, the company is fine",
  },
  {
    query: "98450077CAFCB7A59084",
    outcome: "needs_review — PARTIALLY_CORROBORATED: the LOU did not fully validate the record",
  },
  {
    query: "Apple Computer, Inc.",
    outcome:
      "needs_review — an exact name match registered in IRELAND, which is not this US applicant",
  },
  {
    query: "Ridgeline Robotics, Inc.",
    outcome: "needs_review — a seeded demo business: not in the registry, which proves nothing",
  },
];

export function RegistryProbe({ registry }: { readonly registry: LegWiringView }) {
  const [state, formAction, pending] = useActionState(registryProbeAction, IDLE);
  const inputId = useId();
  const helpId = useId();
  const live = registry.mode === "live";

  return (
    <Panel
      id="registry-probe"
      title="Ask the registry"
      description={
        live
          ? `The same adapter that answers the business-registry leg — ${registry.provider} — asked about any legal name or LEI. It reads; it writes nothing, about anybody.`
          : `The business-registry leg is currently wired to ${registry.provider}, so this panel asks THAT, not a registry. Nothing here is a third party's answer.`
      }
      actions={
        <Badge tone={live ? "positive" : "quiet"}>
          {live ? `live · ${registry.provider}` : `SIMULATED · ${registry.provider}`}
        </Badge>
      }
    >
      {live ? null : (
        <div className="px-5 pt-4">
          <Note emphasis title="This panel is not asking a registry">
            <p>{registry.reason}</p>
            <p className="mt-2">
              The worked examples below describe what the LIVE adapter returns for each query.
              While this leg is forced to the simulator they describe something that is not
              happening, and the answer underneath will say <span className="font-mono">simulated</span>.
            </p>
          </Note>
        </div>
      )}
      <div className="border-b border-border px-5 py-4">
        <form action={formAction} className="space-y-2">
          <label htmlFor={inputId} className="block text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            Legal name, or a 20-character LEI
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id={inputId}
              name="query"
              type="text"
              maxLength={200}
              defaultValue="Apple Inc."
              aria-describedby={helpId}
              className={`min-w-0 flex-1 rounded border border-border bg-surface-raised px-2.5 py-1.5 font-mono text-xs text-text ${FOCUS_RING}`}
            />
            <button
              type="submit"
              disabled={pending}
              className={`inline-flex items-center rounded border border-border-strong px-3 py-1.5 text-xs font-medium text-text enabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-45 ${FOCUS_RING}`}
            >
              {pending ? "Asking…" : live ? "Ask the registry" : "Ask the simulator"}
            </button>
          </div>
          <p id={helpId} className="max-w-prose text-[11px] leading-relaxed text-muted">
            Twenty letters and digits is read as an exact identifier lookup; anything else becomes a
            name search, which runs the autocompletion index and the fuzzy legal-name filter
            together and then re-verifies every candidate&rsquo;s name in our own code. The fuzzy
            filter is an OR over tokens — <span className="font-mono">Stripe, Inc.</span> matches
            76,770 records and the first is <span className="font-mono">ACCENT STRIPE, INC.</span> —
            so it generates candidates and never decides.
          </p>
        </form>

        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {EXAMPLES.map((example) => (
            <li key={example.query} className="text-[11px] leading-relaxed text-muted">
              <form action={formAction} className="inline">
                <input type="hidden" name="query" value={example.query} />
                <button
                  type="submit"
                  disabled={pending}
                  className={`font-mono text-text underline underline-offset-4 disabled:opacity-45 ${FOCUS_RING}`}
                >
                  {example.query}
                </button>
              </form>
              <span className="ml-1.5">{example.outcome}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="px-5 py-4">
        <p aria-live="polite" className="sr-only">
          {pending ? "Asking the registry" : state.message}
        </p>

        {state.status === "idle" ? (
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            Nothing asked yet. Whatever comes back is a statement about that identifier and about
            nothing on this book — and a miss is the honest non-answer it looks like:{" "}
            <em>{GLEIF_MISS_HEADLINE}</em>.
          </p>
        ) : state.status === "refused" || state.probe === null ? (
          <Note emphasis title={`Refused${state.code === null ? "" : ` · ${state.code}`}`}>
            <p>{state.message}</p>
          </Note>
        ) : (
          <div className="space-y-3">
            <p className="max-w-prose text-xs leading-relaxed text-muted">
              Asked as{" "}
              <span className="font-medium text-text">
                {state.probe.kind === "lei" ? "an exact LEI lookup" : "a legal-name search"}
              </span>{" "}
              for <span className="font-mono text-text">{state.probe.query}</span>. {state.message}
            </p>
            <ul>
              <LegRow leg={state.probe.leg} />
            </ul>
            {state.probe.leg.status === "needs_review" &&
            state.probe.leg.rawStatus === "not_in_lei_registry" ? (
              <Note title="A miss is not a decline, and it is not a failure of this check">
                <p>{GLEIF_MISS_HEADLINE}.</p>
                <p className="mt-2">
                  GLEIF holds 3,426,836 records, 360,275 of them with a US legal address, against
                  tens of millions of US entities — its population is financial-market participants,
                  not every company that exists. GRACE SEAFOOD CORP. is a real, active New York
                  corporation (NY DOS 4072354) and it returns nothing here too. So a hit is strong
                  evidence and an absence is evidence of nothing, which is exactly why an absence
                  can never be an approval on this screen.
                </p>
              </Note>
            ) : null}
          </div>
        )}
      </div>
    </Panel>
  );
}
