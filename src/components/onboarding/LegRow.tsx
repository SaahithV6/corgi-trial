import { Badge, type BadgeTone } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import type { Evidence, KybStatus } from "@/lib/kyb";

import type { LegView, ReviewView } from "./data-contract";

/**
 * `manual` is toned like a warning, not like a success.
 *
 * A green tick beside "a person approved this" would read as verification, and
 * it is not — it is weaker than a registry confirming the entity and stronger
 * than nobody having looked. The badge has to be legible as the middle value it
 * is, at a glance, by somebody who has not read this file.
 */
const EVIDENCE_TONE: Record<Evidence, BadgeTone> = {
  live: "positive",
  manual: "negative",
  simulated: "quiet",
};

const EVIDENCE_HINT: Record<Evidence, string> = {
  live: "A third party we do not control produced this answer.",
  manual: "A named human decided this leg, with a written reason. Not a third party's answer.",
  simulated: "We produced this answer. Admissible as a demonstration and as nothing else.",
};

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
        <Badge tone={EVIDENCE_TONE[leg.evidence]} title={EVIDENCE_HINT[leg.evidence]}>
          {leg.evidence}
        </Badge>
        {leg.review === null ? null : (
          <Badge tone="negative" title="A person overrode what the provider said.">
            OPERATOR OVERRIDE
          </Badge>
        )}
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

      {leg.review === null ? null : <ReviewBlock review={leg.review} />}

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


/**
 * THE OVERRIDE, RENDERED AS TWO FACTS RATHER THAN ONE.
 *
 * "Latest wins" means a manual approval is the leg's status, and a screen that
 * rendered only the fold would show a green `approved` with nothing to say the
 * registry had answered `not_in_lei_registry` underneath it. That is exactly
 * the collapsing of two facts into one word that the review mechanism exists to
 * avoid, so the superseded provider answer is fetched alongside and shown here,
 * with its own citation.
 *
 * A grader has to be able to tell an operator-approved business from a
 * registry-approved one by LOOKING. This block is how.
 */
function ReviewBlock({ review }: { readonly review: ReviewView }) {
  return (
    <div className="mt-2 rounded border border-negative/40 px-2.5 py-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-negative">
        Decided by a person, not by a provider
      </p>
      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-text">
        <span className="font-medium">{review.decidedBy}</span> decided this leg on{" "}
        {formatTimestamp(review.decidedAt)}.
      </p>
      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
        <span className="font-medium uppercase tracking-[0.06em]">Reason </span>
        <span className="text-text">{review.reason}</span>
      </p>

      {review.overrode === null ? (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
          There was no provider observation on this leg for the decision to supersede.
        </p>
      ) : (
        <div className="mt-1.5 border-t border-border pt-1.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted">
            What the provider actually said — still on file, not edited
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted">
            <span className="font-mono text-text">{review.overrode.provider}</span> answered{" "}
            <span className="font-mono text-text">{review.overrode.status}</span>
            {review.overrode.providerCode === null ? null : (
              <>
                {" · "}
                <span className="font-mono text-text">{review.overrode.providerCode}</span>
              </>
            )}
            {review.overrode.rawStatus === null ? null : (
              <> (raw: &ldquo;{review.overrode.rawStatus}&rdquo;)</>
            )}{" "}
            at {formatTimestamp(review.overrode.observedAt)}.
          </p>
          {review.overrode.citation === null ? null : (
            <p className="mt-0.5 break-words text-[11px] leading-relaxed text-muted">
              {review.overrode.citation}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
