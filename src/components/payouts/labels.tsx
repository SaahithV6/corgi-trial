import { Badge, type BadgeTone } from "@/components/ui/primitives";

import type { QuoteStateView } from "./data-contract";

/**
 * The five states, and the five different things they mean.
 *
 * The tones are chosen so a glance down the book answers the only question a
 * reader has — "are we on the hook for this one" — without reading a word:
 *
 *   open      quiet     an offer. We are committed to nothing yet.
 *   accepted  neutral   a live commitment. This is the one that carries risk.
 *   settled   positive  done, and the money moved.
 *   expired   quiet     nobody took it. Costless, and not a failure.
 *   lapsed    negative  we DID commit, and it was not sent in time. The only
 *                       one of the five where somebody has to explain
 *                       something to a customer.
 *
 * `expired` is deliberately quiet rather than red. An offer nobody accepted
 * is the system working — it is what an expiry is FOR — and colouring it as a
 * failure would teach an operator to treat lapsing quotes as incidents.
 */
export const QUOTE_STATE_TONE: Record<QuoteStateView, BadgeTone> = {
  open: "quiet",
  accepted: "neutral",
  settled: "positive",
  expired: "quiet",
  lapsed: "negative",
};

export const QUOTE_STATE_LABEL: Record<QuoteStateView, string> = {
  open: "OPEN",
  accepted: "ACCEPTED",
  settled: "SETTLED",
  expired: "EXPIRED",
  lapsed: "LAPSED",
};

export const QUOTE_STATE_MEANING: Record<QuoteStateView, string> = {
  open: "An offer that still stands. Nobody has accepted it, so we are committed to nothing.",
  accepted:
    "A live commitment. The rate is fixed at what the customer saw and we carry the market " +
    "risk until it settles.",
  settled: "A payout consumed this commitment. One accepted rate funds one transfer.",
  expired:
    "The offer lapsed before anybody accepted it. Nothing was committed and nothing was lost — " +
    "this is what an expiry is for.",
  lapsed:
    "Accepted, then not sent inside the settlement window the offer named. We held the rate for " +
    "the whole window; past it the commitment lapses and the customer must re-quote.",
};

export function QuoteStateBadge({ state }: { readonly state: QuoteStateView }) {
  return (
    <Badge tone={QUOTE_STATE_TONE[state]} title={QUOTE_STATE_MEANING[state]}>
      {QUOTE_STATE_LABEL[state]}
    </Badge>
  );
}

/**
 * Whether the rate behind a figure was measured or invented.
 *
 * Never collapsed into a tick. `live` means a third party answered a real call
 * and the HTTP status is on the row; `simulated` means the built-in fallback
 * table answered because the source could not be reached, and the badge is in
 * the negative colour so it cannot be mistaken for the other one at a glance.
 */
export function RateEvidenceBadge({
  evidence,
  title,
}: {
  readonly evidence: "live" | "simulated";
  readonly title?: string;
}) {
  return (
    <Badge
      tone={evidence === "live" ? "neutral" : "negative"}
      title={
        title ??
        (evidence === "live"
          ? "A real third party answered a real call. The status code and the literal it printed are on the row."
          : "The built-in fallback table answered because the live source could not be reached. This is not a market rate.")
      }
    >
      {evidence === "live" ? "LIVE RATE" : "SIMULATED RATE"}
    </Badge>
  );
}
