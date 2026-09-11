/**
 * What the two writes on `/client/payouts` come back as, and their idle values.
 *
 * These live here rather than beside the actions because a `"use server"`
 * module may export nothing but async functions. `src/app/(app)/team/actions.ts`
 * exported a plain idle object from one and the whole `/team` screen dies on it
 * at render time — the import resolves to a server reference rather than to the
 * literal. `@/components/client/card-controls-state` is the same file for the
 * card-controls write, and this is the same shape for the same reason.
 *
 * ── EVERY FIGURE HERE IS A STRING THE SERVER ALREADY FORMATTED ──────────────
 *
 * No `bigint` crosses this boundary and no component downstream does
 * arithmetic. The rate, the fee, the spread and the delivery amount are
 * computed by `GENERATED ALWAYS ... STORED` columns on `fx_quote` and read back
 * off the row; what travels here is what those columns said, rendered. A screen
 * that recomputed any of them could disagree with the commitment it is
 * describing, and the whole point of an accepted quote is that it cannot.
 *
 * Pure. No `server-only`, no database — a server action and a client component
 * both import it.
 */

/** One line of the price breakdown, or of an acceptance receipt. */
export type QuoteLine = {
  readonly label: string;
  /** Already formatted. `"$1,000.00"`, `"16.9435"`, `"MXN 16,772.40"`. */
  readonly value: string;
  /** What the number means and what it excludes. Shown under the value. */
  readonly note: string;
  /** The three figures a person actually decides on. */
  readonly emphasis?: boolean;
};

/**
 * The offer, as the customer is shown it.
 *
 * `quoteRef` is the only field that goes back to the server when they accept.
 * There is no rate on the accept form and there is no amount on it: a form that
 * could name its own rate would be the whole feature undone.
 */
export type QuoteOffer = {
  readonly quoteRef: string;
  readonly destination: string;
  readonly beneficiaryRef: string;
  /** `"$1,000.00"` — what leaves the account if this is accepted. */
  readonly costDisplay: string;
  /** `"MXN 16,772.40"` — what the beneficiary is promised. */
  readonly deliveryDisplay: string;
  /** ISO 8601. The instant after which this offer is no longer on the table. */
  readonly expiresAt: string;
  /** Whole seconds the offer had left when the server rendered it. */
  readonly expiresInSeconds: number;
  /** `"live"` only when a third party answered a real call. */
  readonly rateEvidence: "live" | "simulated";
  readonly lines: readonly QuoteLine[];
};

export type QuoteRequestResult = {
  readonly status: "idle" | "quoted" | "refused";
  /** A named code on every refusal. Nothing on this path fails silently. */
  readonly code: string | null;
  readonly message: string;
  /** Field-level messages, keyed by input name. `null` when the form parsed. */
  readonly issues: readonly { readonly path: string; readonly message: string }[] | null;
  readonly offer: QuoteOffer | null;
};

export const QUOTE_REQUEST_IDLE: QuoteRequestResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  offer: null,
};

export type AcceptResult = {
  readonly status: "idle" | "accepted" | "refused";
  readonly code: string | null;
  readonly message: string;
  /** Which quote the result belongs to, so a receipt cannot land on a sibling. */
  readonly quoteRef: string | null;
  /** The commitment, once it stands. Empty on a refusal. */
  readonly lines: readonly QuoteLine[];
};

export const ACCEPT_IDLE: AcceptResult = {
  status: "idle",
  code: null,
  message: "",
  quoteRef: null,
  lines: [],
};
