/**
 * URL state for the client surface.
 *
 * Pure. No `server-only`, no database, no React — it is imported by the app
 * shell's nav (a client component), by five server pages and by the fixtures,
 * and all three need the same answer to "which business, which state".
 *
 * TWO THINGS LIVE IN THE QUERY STRING AND THEY ARE NOT THE SAME KIND OF THING.
 *
 *   `?state=`     which of the five demo states to render. A demo control.
 *   `?business=`  WHOSE BOOK. In this build that is also a demo control,
 *                 because this build has no customer authentication at all
 *                 (`docs/DEMO.md` §1: "There is nothing to sign into"). It is
 *                 written down here, loudly, because it is the one parameter on
 *                 this surface that would be an authorisation decision in
 *                 production and must never become one by accident.
 *
 * What makes that safe to ship TODAY is that the business id is not a filter
 * applied after the fact. It is passed into the reader and becomes a `WHERE
 * business_id = $1` inside Postgres, so the query cannot return another
 * customer's row for a component to drop. When a session claim replaces the
 * query parameter, the only line that changes is where `businessId` comes
 * from; every read below it is already scoped. See `docs/CLIENT.md`.
 */

export const CLIENT_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type ClientState = (typeof CLIENT_STATES)[number];

export const CLIENT_STATE_LABELS: Record<ClientState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge",
};

/**
 * The five screens, in the order the brief asks for them.
 *
 * Exported from here rather than from a component so that
 * `src/components/home/ScreenLinks.tsx` and
 * `src/components/app-shell/NavLinks.tsx` can both name the same list. Those
 * two files are checked against each other and against a filesystem walk of
 * `src/app` by `ScreenLinks.test.ts` and `NavLinks.test.ts`; adding a screen
 * here and forgetting one of them is a failing test rather than a screen
 * linked from nowhere, which is this codebase's recurring defect.
 */
export const CLIENT_SCREENS = [
  { href: "/client", label: "Balance" },
  { href: "/client/activity", label: "Activity" },
  { href: "/client/cards", label: "Cards" },
  { href: "/client/pay", label: "Send a payment" },
  { href: "/client/approvals", label: "Approve" },
] as const;

export type ClientScreenHref = (typeof CLIENT_SCREENS)[number]["href"];

export type ClientView = {
  readonly state: ClientState;
  /** `null` means "the first business on the book". Never "all businesses". */
  readonly businessId: string | null;
  /**
   * One payment, by id, on `/client/approvals`.
   *
   * The approvals screen is addressed by instruction id rather than listed,
   * and the reason is not a design preference — see
   * `src/components/client/ApproveView.tsx` and `docs/CLIENT.md`. There is no
   * business-scoped queue reader on this book.
   */
  readonly paymentId: string | null;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isClientState(value: string | undefined): value is ClientState {
  return CLIENT_STATES.some((state) => state === value);
}

/** A uuid and nothing else. Guards every `::uuid` cast downstream. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asId(value: string | undefined): string | null {
  return value !== undefined && UUID.test(value) ? value : null;
}

/**
 * Read the view out of `searchParams`.
 *
 * Anything unrecognised falls back rather than throwing. A mistyped business id
 * lands on the default business; it does NOT land on "every business", which is
 * the failure mode that matters here — an unparseable tenant must never widen
 * the scope of a read.
 */
export function parseClientView(
  searchParams: Record<string, string | string[] | undefined>,
): ClientView {
  const rawState = first(searchParams["state"]);
  return {
    state: isClientState(rawState) ? rawState : "default",
    businessId: asId(first(searchParams["business"])),
    paymentId: asId(first(searchParams["payment"])),
  };
}

/** A query string from a view, dropping defaults, in a stable key order. */
export function clientQuery(view: Partial<ClientView>): string {
  const parts: string[] = [];
  if (view.state !== undefined && view.state !== null && view.state !== "default") {
    parts.push(`state=${encodeURIComponent(view.state)}`);
  }
  if (view.businessId !== undefined && view.businessId !== null) {
    parts.push(`business=${encodeURIComponent(view.businessId)}`);
  }
  if (view.paymentId !== undefined && view.paymentId !== null) {
    parts.push(`payment=${encodeURIComponent(view.paymentId)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/**
 * `/client/...?...` for one screen.
 *
 * The business travels across every link on this surface. Dropping it on a nav
 * click would answer a question nobody asked — and on a screen whose whole
 * subject is one customer, silently changing customer is the worst possible
 * navigation bug.
 */
export function clientHref(
  href: ClientScreenHref,
  view: Partial<ClientView>,
): string {
  return `${href}${clientQuery(view)}`;
}
