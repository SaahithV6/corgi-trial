import { Badge, Note, Panel, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { KYB_STATUSES } from "@/lib/kyb";

import type { LegCompliance, LegWiringView, WiringView } from "./data-contract";

/**
 * THE BADGE THAT REFUSES TO AVERAGE THE TWO LEGS.
 *
 * Both legs are live. They are not equally compliant with the brief, and a
 * single "live" badge across the row would quietly claim that they were.
 *
 *   on-brief     Stripe Identity is on the brief's own KYC identity menu
 *                (Persona, Sumsub, Stripe Identity, Onfido). Compliant. No
 *                apology owed, and offering one would be its own inaccuracy.
 *   substituted  GLEIF is a real third-party registry, queried live — and it is
 *                NOT one of the three vendors the brief names for this slot.
 *                Both facts, in that order, wherever the leg is named.
 *   simulated    nobody was asked.
 *
 * `substituted` is deliberately toned NEGATIVE rather than positive. It is the
 * one row on this screen where a reviewer is most likely to be told what they
 * want to hear, so it is drawn to be read rather than skimmed past.
 */
const COMPLIANCE_TONE: Record<LegCompliance, "positive" | "negative" | "quiet"> = {
  "on-brief": "positive",
  substituted: "negative",
  simulated: "quiet",
};

/**
 * Which adapter answers each leg in THIS deployment, and what that caps the
 * evidence at.
 *
 * `evidenceCeiling` is named a ceiling on purpose: it is a statement about the
 * wiring, not a claim that anything has been verified. A live ceiling means a
 * verification COULD be labelled live; it never means one was.
 *
 * The disagreement banner is the important part of this component. The health
 * endpoint derives its answer from which keys are present, and a key being
 * present is not the same sentence as a capability existing — that mistake has
 * been made and caught four separate times in this build (DECISIONS 011, 015,
 * 016, 017, 026). So where the two surfaces would describe the same leg
 * differently, this screen says so rather than picking the flattering one.
 */
export function WiringPanel({ wiring }: { readonly wiring: WiringView }) {
  return (
    <Panel
      id="kyb-wiring"
      title="How this deployment verifies"
      description="Two legs, chosen independently from the environment. A composite is live only if every leg was; there is no third label."
      actions={
        <Badge tone={wiring.evidenceCeiling === "live" ? "positive" : "quiet"}>
          evidence ceiling · {wiring.evidenceCeiling}
        </Badge>
      }
    >
      {wiring.healthDisagreement === null ? null : (
        <div className="px-5 pt-4">
          <Note emphasis title="This screen and /api/health describe a leg differently">
            <p>{wiring.healthDisagreement}</p>
            <p className="mt-2">
              Reported rather than smoothed over: a slot that reads live on one surface and
              simulated on another is how a simulated integration ends up presented as a live one,
              which the brief calls the fastest way to fail outright.
            </p>
          </Note>
        </div>
      )}

      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className={TH_CLASS}>Leg</th>
              <th className={TH_CLASS}>Adapter</th>
              <th className={TH_CLASS}>Evidence</th>
              <th className={TH_CLASS}>Against the brief</th>
              <th className={TH_CLASS}>Why</th>
            </tr>
          </thead>
          <tbody>
            <LegRow leg={wiring.director} />
            <LegRow leg={wiring.registry} />
          </tbody>
        </table>
      </TableScroll>

      <div className="grid gap-x-8 gap-y-5 border-t border-border px-5 py-4 sm:grid-cols-2">
        <LegDetail leg={wiring.director} />
        <LegDetail leg={wiring.registry} />
      </div>

      <div className="border-t border-border px-5 py-4">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Neither call happens on render. The director leg is a real third-party write —{" "}
          <code className="font-mono">POST /v1/identity/verification_sessions</code> against Stripe,
          returning a hosted <code className="font-mono">verify.stripe.com</code> URL — and is made
          only when someone presses <em>Start verification</em>, because a render path that creates
          provider objects litters a real account on every page load, prefetch and bot. The registry
          leg is a read against a public, key-less, CC0 index, so repeating it costs nothing and
          creates nothing; it still runs from an explicit action, so the screen never quietly
          re-asks a question on somebody else&rsquo;s server.
        </p>
      </div>
    </Panel>
  );
}

function LegRow({ leg }: { readonly leg: LegWiringView }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className={TD_CLASS}>
        <span className="font-medium">{leg.label}</span>
        <span className="mt-0.5 block font-mono text-[11px] text-muted">{leg.leg}</span>
      </td>
      <td className={`${TD_CLASS} font-mono text-xs`}>{leg.provider}</td>
      <td className={TD_CLASS}>
        <Badge tone={leg.evidence === "live" ? "positive" : "quiet"}>{leg.evidence}</Badge>
      </td>
      <td className={TD_CLASS}>
        <Badge tone={COMPLIANCE_TONE[leg.compliance]} title={leg.complianceNote}>
          {leg.complianceLabel}
        </Badge>
      </td>
      <td className={`${TD_CLASS} max-w-prose text-xs text-muted`}>
        {leg.reason}
        {leg.missingEnv.length === 0 ? null : (
          <span className="mt-1 block font-mono text-[11px]">
            missing: {leg.missingEnv.join(", ")}
          </span>
        )}
      </td>
    </tr>
  );
}

/**
 * What this leg does NOT prove, and which statuses it can actually reach.
 *
 * Printed beside the leg rather than filed in a document nobody opens. The
 * limits are the first thing a hostile reviewer should be told, not the first
 * thing they get to discover; and `reachableStatuses` is the difference between
 * a mapping table and a capability — Stripe Identity's table contains a
 * `rejected` that their API will not produce, and a screen that listed it
 * without saying so would be advertising a refusal nobody can make.
 */
function LegDetail({ leg }: { readonly leg: LegWiringView }) {
  const unreachable = KYB_STATUSES.filter((s) => !leg.reachableStatuses.includes(s));

  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {leg.label} · <span className="font-mono normal-case">{leg.provider}</span>
      </h3>

      <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
        {leg.complianceNote}
      </p>

      <p className="mt-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        What this does not prove
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-muted">
        {leg.limits.map((limit) => (
          <li key={limit}>{limit}</li>
        ))}
      </ul>

      <p className="mt-2.5 flex flex-wrap items-baseline gap-1.5 text-[11px] text-muted">
        <span className="font-medium uppercase tracking-[0.08em]">Reachable</span>
        {leg.reachableStatuses.map((status) => (
          <span key={status} className="font-mono text-text">
            {status}
          </span>
        ))}
        {unreachable.map((status) => (
          <span key={status} className="font-mono line-through">
            {status}
          </span>
        ))}
      </p>
      {leg.reachabilityNote === null ? null : (
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
          {leg.reachabilityNote}
        </p>
      )}
    </div>
  );
}
