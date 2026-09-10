import { Badge, Note, Panel, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";

import type { LegWiringView, WiringView } from "./data-contract";

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
              <th className={TH_CLASS}>Why</th>
            </tr>
          </thead>
          <tbody>
            <LegRow leg={wiring.director} />
            <LegRow leg={wiring.registry} />
          </tbody>
        </table>
      </TableScroll>

      <div className="border-t border-border px-5 py-4">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          The director leg is a real third-party call:{" "}
          <code className="font-mono">POST /v1/identity/verification_sessions</code> against Stripe,
          returning a hosted <code className="font-mono">verify.stripe.com</code> URL. It is made
          only when someone presses <em>Start verification</em> — never on render, because a render
          path that creates provider objects litters a real account on every page load.
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
