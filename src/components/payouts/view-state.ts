/**
 * URL-driven state for the payouts screen.
 *
 * Every state the screen can show is reachable by editing the query string and
 * by nothing else. No client state, no feature flag, no seeded row — the same
 * rule the payees, pots and standing-orders screens keep, and for the same
 * reason: every state can be shown live, in order, in front of a panel without
 * raising a quote or writing a row, and a screenshot of any state carries the
 * URL that reproduces it.
 *
 * ── THE EDGE STATE, WHICH IS THE ONE TO PAUSE ON ────────────────────────────
 *
 * AN EXPIRED QUOTE. The customer looked at a rate, thought about it, and came
 * back after the offer had lapsed. That is the state this whole feature turns
 * on, because it is the moment the commitment does NOT exist:
 *
 *   * the rate on the screen is the rate they were shown, and it is no longer
 *     available to them;
 *   * the acceptance they try to make is refused BY THE DATABASE, not by a
 *     disabled button — `fx_quote_acceptance_guard()` in 0017 reads the
 *     quote's own `expires_at` and raises;
 *   * the expired quote stays on file forever, because nothing in this feature
 *     is ever edited or deleted;
 *   * and the remedy is one click, not a support ticket.
 *
 * A feature that only ever demonstrates the happy path has not demonstrated
 * the expiry, and the expiry is the only thing that makes a quote an offer
 * rather than a number on a screen.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · expired quote",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "The live quote book and the live rate source, from the database.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "No quote has been raised. Nothing to show, nothing wrong.",
  error:
    "The quote book could not be read. No quote was raised, nothing was committed and " +
    "nothing was written; retry is live.",
  edge:
    "A quote the customer came back to too late. The offer lapsed unaccepted, the rate they " +
    "saw is gone, and the acceptance is refused by the database rather than by a greyed-out " +
    "button — the expired quote stays on file and the remedy is to re-quote.",
};

export type PayoutFilter = {
  readonly state: DemoState;
  /** `null` means no quote is in focus. */
  readonly quoteRef: string | null;
  /** `null` means every customer. */
  readonly businessId: string | null;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((s) => s === value);
}

/** A uuid and nothing else. Guards the `::uuid` casts in the query layer. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The shape `fx_quote.quote_ref` is CHECKed to be. Guards the `text` comparison. */
const QUOTE_REF = /^FXQ-[0-9A-HJKMNP-TV-Z]{8}$/;

function asId(value: string | undefined): string | null {
  return value !== undefined && UUID.test(value) ? value : null;
}

function asQuoteRef(value: string | undefined): string | null {
  const upper = value?.toUpperCase();
  return upper !== undefined && QUOTE_REF.test(upper) ? upper : null;
}

/**
 * Read the view out of `searchParams`.
 *
 * Anything unrecognised falls back rather than throwing: a mistyped quote
 * reference shows the book, and a malformed URL shows the real screen. A 500
 * on a bad query string is a worse answer than ignoring it.
 */
export function parsePayoutFilter(
  searchParams: Record<string, string | string[] | undefined>,
): PayoutFilter {
  const rawState = first(searchParams["state"]);
  return {
    state: isDemoState(rawState) ? rawState : "default",
    quoteRef: asQuoteRef(first(searchParams["quote"])),
    businessId: asId(first(searchParams["business"])),
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the links honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function payoutQuery(filter: Partial<PayoutFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.quoteRef !== undefined && filter.quoteRef !== null) {
    parts.push(`quote=${encodeURIComponent(filter.quoteRef)}`);
  }
  if (filter.businessId !== undefined && filter.businessId !== null) {
    parts.push(`business=${encodeURIComponent(filter.businessId)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** The href for a view of the payouts screen. The route is named in one place. */
export function payoutHref(filter: Partial<PayoutFilter>): string {
  return `/payouts${payoutQuery(filter)}`;
}
