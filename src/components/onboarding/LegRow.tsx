import { Badge, type BadgeTone } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import type { KybStatus } from "@/lib/kyb";

import type { LegView } from "./data-contract";

export const STATUS_TONE: Record<KybStatus, BadgeTone> = {
  approved: "positive",
  pending: "neutral",
  needs_review: "neutral",
  rejected: "negative",
};

/**
 * ONE LEG, RENDERED THE SAME WAY WHEREVER IT CAME FROM.
 *
 * Extracted so the entity card and the registry probe cannot drift apart. That
 * matters more than the duplication it saves: the probe asks the SAME live
 * adapter the same question a real verification asks, and if the two were drawn
 * by two components, the one that showed a probe could quietly acquire a
 * friendlier presentation than the one that shows evidence. Same renderer, same
 * badges, same citation line, no exceptions.
 *
 * THE CITATION IS THE PAYLOAD. `citation` is the string a reviewer can act on —
 * which register, which entry, at what corroboration level — so it is given its
 * own line rather than folded into the check list, and its absence is rendered
 * as an absence rather than left blank. A simulated leg cites nothing, and the
 * screen says so in words instead of showing an empty space that could pass for
 * a citation that failed to load.
 */
export function LegRow({ leg }: { readonly leg: LegView }) {
  return (
    <li className="rounded-md border border-border bg-surface-raised px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-medium">{leg.label}</span>
        <Badge tone={STATUS_TONE[leg.status]}>{leg.status}</Badge>
        <Badge tone={leg.evidence === "live" ? "positive" : "quiet"}>{leg.evidence}</Badge>
        <span className="font-mono text-[11px] text-muted">{leg.provider}</span>
        {leg.providerCode === null ? null : (
          <span className="font-mono text-[11px] text-muted">
            code: <span className="text-text">{leg.providerCode}</span>
          </span>
        )}
      </div>

      <p className="mt-1 break-all font-mono text-[11px] text-muted">
        {leg.reference}
        {leg.rawStatus === null ? null : (
          <span className="ml-2">· provider said &ldquo;{leg.rawStatus}&rdquo;</span>
        )}
      </p>

      <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed">
        <span className="font-medium uppercase tracking-[0.06em] text-muted">Citation </span>
        {leg.citation === null ? (
          <span className="text-muted">
            {leg.evidence === "live"
              ? "none — and the two reasons for that are different, so the label is not. A third party answered this leg; what it had was no record to point at. An absence, said plainly, rather than a citation-shaped sentence with nothing behind it."
              : "none. This leg cites nothing, because there is nothing to cite — which is what a leg nobody outside this system answered looks like when it is not dressed up."}
          </span>
        ) : (
          <span className="break-words text-text">{leg.citation}</span>
        )}
      </p>

      {leg.checks.length === 0 ? null : (
        <ul className="mt-1.5 space-y-0.5 text-[11px] leading-relaxed text-muted">
          {leg.checks.map((check) => (
            <li key={check.name}>
              <span className="font-mono">{check.name}</span>: {check.status}
              {check.reasons.length === 0 ? null : ` — ${check.reasons.join("; ")}`}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-1 text-[11px] text-muted">observed {formatTimestamp(leg.observedAt)}</p>
    </li>
  );
}
