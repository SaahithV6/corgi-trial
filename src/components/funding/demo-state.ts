/**
 * URL-driven demo states for the funding screen.
 *
 * Same contract as every other screen: every state is reachable by editing the
 * query string, each has a URL that reproduces it, and switching between them
 * writes nothing.
 *
 * TWO STATES ARE LIVE, and `edge` is the one worth arguing about.
 *
 * The edge case here is not a picture of a boundary. It is the account as it
 * genuinely stands after a deposit has posted and before the return window has
 * closed: ledger UP by the full amount, available NOT MOVED by a cent, and the
 * uncleared-credit hold itemised with the banking date and the 09:00 New York
 * instant it releases on. That state is a real position in the live database —
 * `hold.kind = 'uncleared_credit'` with an `available_at` in the future — and a
 * fixture of it would demonstrate the arithmetic while proving nothing about
 * it. So `edge` reads Neon and shows the real hold, and if no such hold exists
 * right now it says so rather than drawing one.
 *
 * The other three stay fixtures, because `loading` has to be slow on demand,
 * `error` has to be showable without breaking Neon, and `empty` has to be
 * showable without closing the only deposit accounts on the book.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

/**
 * `?business=` PICKS THE CUSTOMER, exactly as it does on `/accounts`, `/pots`,
 * `/payouts` and `/disputes`. It is the convention this console already had and
 * this screen was the one route that ignored it.
 *
 * It is a REFERENCE and nothing more. The live source matches it against the
 * list of businesses it has just read; an id that is not on that list falls
 * back to the default rather than reaching a query, and a malformed one is
 * discarded before it is ever cast to `uuid`. Selecting a business is not a
 * permission: the KYB gate is read for whichever business is selected and is
 * re-read inside the write path, so pointing this screen at a business that may
 * not transact shows the refusal rather than granting anything.
 */
export type FundingView = {
  readonly state: DemoState;
  /** Which business the screen is pointed at. `null` = take the default. */
  readonly businessId: string | null;
};

/** `default` and `edge` read Neon; the rest are fixtures. */
export function isLiveState(state: DemoState): boolean {
  return state === "default" || state === "edge";
}

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default · live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · live · funded, not yet available",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default:
    "The real screen, against the live ledger and the live funds_availability_policy table.",
  loading: "Skeleton, held open long enough to see.",
  empty: "No deposit account on this book for an inbound credit to land in.",
  error: "The preflight read failed. Nothing was funded; retry is live.",
  edge:
    "Funded but not yet available: the ledger balance is up by the full deposit, available has not moved, and the uncleared-credit hold that explains the difference is itemised with the banking day and the 09:00 ET instant it releases on.",
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((state) => state === value);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when a string could be a business id. Guards every `::uuid` cast below it. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/**
 * Anything unrecognised falls back to the live screen, never to an error page —
 * and never to a business that is not a well-formed id.
 */
export function parseFundingView(
  searchParams: Record<string, string | string[] | undefined>,
): FundingView {
  const raw = first(searchParams["state"]);
  const rawBusiness = first(searchParams["business"]);
  return {
    state: isDemoState(raw) ? raw : "default",
    businessId: isUuid(rawBusiness) ? rawBusiness : null,
  };
}

/**
 * `?state=edge&business=…`, or `""` for the live default.
 *
 * Stable key order so two URLs for the same view compare equal as text, and so
 * the state bar's links carry the selected business forward instead of silently
 * dropping the reader back onto somebody else's account.
 */
export function demoQuery(view: Partial<FundingView>): string {
  const parts: string[] = [];
  if (view.state !== undefined && view.state !== "default") parts.push(`state=${view.state}`);
  if (view.businessId !== undefined && view.businessId !== null) {
    parts.push(`business=${encodeURIComponent(view.businessId)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}
