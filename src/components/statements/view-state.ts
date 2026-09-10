/**
 * URL-driven state for the statements screen.
 *
 * Everything the screen can show is reachable by editing the query string and
 * by nothing else: which demo state, which account, which closed day, which
 * published version is the as-published side. No client state, no feature
 * flag, no seeded row.
 *
 * The reason is the same as on the breaks screen and it is about a demo being
 * watched rather than about purity. Every state can be shown live, in order,
 * in front of a panel. And a screenshot of any state carries the URL that
 * reproduces it — which for a statement is not a convenience, it is the point:
 * "the document at this URL is the document we issued" is a claim somebody may
 * need to check next year.
 */

export const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;

export type DemoState = (typeof DEMO_STATES)[number];

export const DEMO_STATE_LABELS: Record<DemoState, string> = {
  default: "Default",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · corrected after publication",
};

export const DEMO_STATE_HINTS: Record<DemoState, string> = {
  default: "A closed day's published statement. Live from the ledger.",
  loading: "Skeleton, held open by a genuinely slow read.",
  empty: "A day that was closed with no statement issued yet. Nothing to show, nothing wrong.",
  error: "The statement query failed. Nothing moved; retry is live.",
  edge: "Published, then corrected by a reversal and re-book at that day's value date. Both figures true at once.",
};

export type StatementFilter = {
  readonly state: DemoState;
  /** `null` means "the first account with a published statement". */
  readonly accountId: string | null;
  /** `null` means "the newest closed day that has one". */
  readonly businessDate: string | null;
  /**
   * Which published version is the as-published side. `null` means v1.
   *
   * v1 is the default deliberately: it is the document that went out, and its
   * divergence from today is the thing worth looking at. Selecting the newest
   * version is the honest way to show a reissue closed the gap — the delta
   * goes to zero and the corrections list empties.
   */
  readonly version: number | null;
};

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isDemoState(value: string | undefined): value is DemoState {
  return DEMO_STATES.some((s) => s === value);
}

/** `YYYY-MM-DD` and nothing else. Guards the `::date` cast in the query layer. */
export function isBusinessDate(value: string | undefined): value is string {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Read the view out of `searchParams`.
 *
 * Anything unrecognised falls back rather than throwing: a mistyped date shows
 * the default day, an unknown version shows v1, and a malformed URL shows the
 * real screen. A 500 on a bad query string is a worse answer than ignoring it.
 */
export function parseStatementFilter(
  searchParams: Record<string, string | string[] | undefined>,
): StatementFilter {
  const rawState = first(searchParams["state"]);
  const rawAccount = first(searchParams["account"]);
  const rawDay = first(searchParams["day"]);
  const rawVersion = first(searchParams["v"]);

  const version = rawVersion === undefined ? Number.NaN : Number.parseInt(rawVersion, 10);

  return {
    state: isDemoState(rawState) ? rawState : "default",
    accountId: rawAccount !== undefined && rawAccount !== "" ? rawAccount : null,
    businessDate: isBusinessDate(rawDay) ? rawDay : null,
    version: Number.isInteger(version) && version >= 1 ? version : null,
  };
}

/**
 * Build a query string from a filter, dropping defaults.
 *
 * Stable key order so two URLs for the same view compare equal — which is what
 * makes `aria-current` on the pickers honest and what stops the browser
 * accumulating near-identical history entries.
 */
export function statementQuery(filter: Partial<StatementFilter>): string {
  const parts: string[] = [];
  if (filter.state !== undefined && filter.state !== null && filter.state !== "default") {
    parts.push(`state=${encodeURIComponent(filter.state)}`);
  }
  if (filter.accountId !== undefined && filter.accountId !== null) {
    parts.push(`account=${encodeURIComponent(filter.accountId)}`);
  }
  if (filter.businessDate !== undefined && filter.businessDate !== null) {
    parts.push(`day=${encodeURIComponent(filter.businessDate)}`);
  }
  if (filter.version !== undefined && filter.version !== null) {
    parts.push(`v=${String(filter.version)}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

/** `/statements?...` for a filter, with the current one as the base. */
export function statementHref(
  current: StatementFilter,
  patch: Partial<StatementFilter>,
): string {
  return `/statements${statementQuery({ ...current, ...patch })}`;
}
