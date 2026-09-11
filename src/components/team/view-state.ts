/**
 * URL-driven state for the team screen.
 *
 * Everything this screen can show is reachable by editing the query string and
 * by nothing else: which demo state, which customer, which member is expanded.
 * No client state, no feature flag, no seeded row.
 *
 * The reason is a demo being watched rather than purity. Every state can be
 * shown live, in order, in front of a panel — and a screenshot of any of them
 * carries the URL that reproduces it, which for the edge state is the thing
 * somebody pastes into a ticket when a customer rings up asking why a card
 * belonging to a person who left is still holding fifty dollars of their money.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · removed, with money still in flight",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default:
    "The live team: real people, real roles, real cards issued through Lithic, and each person's own spend limits beside what they have actually spent today.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty:
    "A business with no members yet. Not an error: the first admin is created by Corgi ops at account opening, because a business's first admin cannot appoint themselves.",
  error:
    "The team read failed. Nothing was written; this path only reads. Note what a failure means HERE versus on the authorisation path, which would decline.",
  edge:
    "THE STATE MOST LIKELY TO RENDER WRONG: a member removed while an authorisation of theirs was still outstanding. Their card is closed at the issuer and declines; the hold is untouched and the money will still settle against this business. Live rows, not a fixture.",
};

export type TeamFilter = {
  readonly state: DemoState;
  /** `null` means "the first customer on the book". */
  readonly businessId: string | null;
  /** The member whose terms history and cards are expanded. */
  readonly memberId: string | null;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((s) => s === value);
}

/** A uuid and nothing else. Guards the `::uuid` casts in the query layer. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asId(value: string | undefined): string | null {
  return value !== undefined && UUID.test(value) ? value : null;
}

/**
 * Read the view out of `searchParams`.
 *
 * Anything unrecognised falls back rather than throwing: a mistyped business id
 * shows the first customer and a malformed URL shows the real screen. A 500 on
 * a bad query string is a worse answer than ignoring it.
 */
export function parseTeamFilter(
  searchParams: Record<string, string | string[] | undefined>,
): TeamFilter {
  const rawState = first(searchParams["state"]);
  return {
    state: isDemoState(rawState) ? rawState : "default",
    businessId: asId(first(searchParams["business"])),
    memberId: asId(first(searchParams["member"])),
  };
}

/** The query string for a view. Omits everything at its default. */
export function teamQuery(filter: Partial<TeamFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== "default") parts.push(`state=${filter.state}`);
  if (filter.businessId !== undefined && filter.businessId !== null) parts.push(`business=${filter.businessId}`);
  if (filter.memberId !== undefined && filter.memberId !== null) parts.push(`member=${filter.memberId}`);
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}
