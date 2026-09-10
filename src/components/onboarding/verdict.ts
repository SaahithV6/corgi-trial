/**
 * WHO SAID NO, AND IN WHAT WORDS.
 *
 * ===========================================================================
 * A screen that renders `rejected` has told you the answer and hidden the
 * question. Two businesses on this book can both read `rejected` while one was
 * declined by a third party over an authenticated round trip and the other was
 * declined by a fixture we wrote — and if the only way to tell them apart is to
 * read the source, the screen is not evidence of anything.
 *
 * So the derived status is always shown WITH ITS SOURCE. This module computes
 * that attribution and nothing else:
 *
 *   sources  the legs whose own status EQUALS the derived one. `v_business_kyb`
 *            takes `max(status)`, so those are precisely the legs that set it;
 *            a leg sitting at a weaker status did not cause this verdict and
 *            must not be listed as if it had.
 *   origin   `third-party` when every source leg is live evidence,
 *            `simulated` when every source leg is ours,
 *            `mixed` when both kinds concur on the same verdict,
 *            `none` when there is nothing on file to attribute.
 *
 * Pure, and shared: `src/lib/kyb/wire.ts` calls it for live rows and
 * `fixtures.ts` for demo rows, so a fixture cannot describe itself in flattering
 * words a live row would not get. It DERIVES the attribution from the leg rows
 * and takes no argument that could assert one.
 * ===========================================================================
 */

import type { Evidence, KybStatus } from "@/lib/kyb";

import type { LegView, VerdictOrigin, VerdictSourceView, VerdictView } from "./data-contract";

/**
 * How each origin should read to somebody who has been looking at the screen
 * for four seconds. The words are deliberately blunt: "SIMULATED" in a badge is
 * worth more than a paragraph underneath it.
 */
export const VERDICT_ORIGIN_LABEL: Record<VerdictOrigin, string> = {
  "third-party": "third-party verdict",
  simulated: "SIMULATED verdict",
  mixed: "third-party + simulated",
  none: "nothing on file",
};

export function verdictOriginOf(sources: readonly VerdictSourceView[]): VerdictOrigin {
  if (sources.length === 0) return "none";
  const live = sources.filter((s) => s.evidence === "live").length;
  if (live === sources.length) return "third-party";
  if (live === 0) return "simulated";
  return "mixed";
}

/**
 * The sentence printed next to the status badge.
 *
 * It names the provider and, where there is one, quotes the provider's own
 * machine-readable code. `document_unverified_other` is checkable against
 * Stripe's docs and against the session itself; "verification failed" is not.
 */
function headlineFor(status: KybStatus, origin: VerdictOrigin, sources: readonly VerdictSourceView[]): string {
  if (origin === "none") {
    return "No verification has been started, so no provider has said anything and there is nothing to attribute this status to.";
  }
  const quoted = sources
    .map((s) => {
      const code = s.providerCode === null ? "" : ` · ${s.providerCode}`;
      return `${s.provider}${code}`;
    })
    .join(" and ");

  if (origin === "third-party") {
    return status === "approved"
      ? `Approved because ${quoted} said so — a third party we do not control, over an authenticated round trip.`
      : `${status} because ${quoted} said so. Not our verdict: a third party we do not control produced it and the code above is theirs.`;
  }
  if (origin === "simulated") {
    return `${status} because ${quoted} said so — and that is US. This verdict is SIMULATED: no third party was asked, and it is admissible as a demonstration and as nothing else.`;
  }
  return `${status} from two sources at the same strictness: ${quoted}. One of them is a third party and one of them is us — the per-leg rows below say which, and the composite is labelled simulated either way.`;
}

/** One leg, reduced to what the attribution needs. */
function toSource(leg: LegView): VerdictSourceView {
  return {
    leg: leg.leg,
    label: leg.label,
    provider: leg.provider,
    evidence: leg.evidence,
    status: leg.status,
    rawStatus: leg.rawStatus,
    reference: leg.reference,
    providerCode: leg.providerCode,
    citation: leg.citation,
  };
}

/**
 * Attribute a derived status to the legs that produced it.
 *
 * `status` is passed in rather than recomputed on purpose: it is the value
 * `v_business_kyb` derived, and re-deriving it here would create a second
 * opinion that could differ from the one the gate reads. This function's job is
 * to explain that value, never to second-guess it.
 */
export function verdictView(status: KybStatus, evidence: Evidence, legs: readonly LegView[]): VerdictView {
  const sources = legs.filter((leg) => leg.status === status).map(toSource);
  const origin = verdictOriginOf(sources);
  return {
    status,
    evidence,
    sources,
    origin,
    originLabel: VERDICT_ORIGIN_LABEL[origin],
    headline: headlineFor(status, origin, sources),
  };
}
