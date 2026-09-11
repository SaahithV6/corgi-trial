/**
 * The loader `/audit` calls: one filter in, one renderable result out.
 *
 * Everything here is a read. See `./store.ts` for the argument.
 *
 * WHICH BUSINESS. `?business=<uuid>` picks one. With nothing in the URL the
 * loader takes the business with the MOST recorded actions rather than the
 * first by name, so the default state of a demo screen is never an empty one
 * — and it is a query, not a hardcoded id, so a reset book still lands
 * somewhere real.
 */

import "server-only";

import type { AuditFilter } from "@/components/audit/view-state";

import {
  PAGE_SIZE,
  countActions,
  countByKind,
  countBySource,
  findBusiness,
  listActions,
  listBusinessesWithActions,
  loadCompleteness,
} from "./store";
import { ACTOR_KINDS, type ActorKind, type TimelineResult } from "./types";

/**
 * The empty state is LIVE.
 *
 * No business on this book has zero actions, so a fixture would be the only
 * way to show an empty screen — and a fixture proves the component renders,
 * not that the count line tells the truth. This instead picks the business
 * with the FEWEST actions and filters it to agent actions, which genuinely
 * returns nothing: the panel then says "0 of 9 — none of this business's
 * actions were taken by an autonomous agent", which is a real sentence about
 * a real book rather than a placeholder.
 */
async function emptyFilter(filter: AuditFilter): Promise<AuditFilter> {
  const businesses = await listBusinessesWithActions();
  const quietest = [...businesses].sort((a, b) => a.actions - b.actions)[0];
  return {
    ...filter,
    businessId: quietest?.id ?? filter.businessId,
    kind: "agent",
    surface: null,
    source: null,
    page: 0,
  };
}

export async function loadTimeline(filter: AuditFilter): Promise<TimelineResult> {
  const effective = filter.state === "empty" ? await emptyFilter(filter) : filter;

  const businessId = effective.businessId ?? (await defaultBusinessId());
  if (!businessId) return emptyResult(effective, null);

  const business = await findBusiness(businessId);
  if (!business) return emptyResult(effective, null);

  const query = {
    businessId,
    kind: effective.kind,
    surface: effective.surface,
    source: effective.source,
    includeBookWide: effective.includeBookWide,
    page: effective.page,
    order: effective.order,
  };

  // Issued together. The count and the rows use the SAME predicate (see
  // `scope()` in ./store.ts) — that identity is what lets the screen print
  // "showing N of M, this screen hides none" without lying.
  const [actions, matched, byKind, bySource, completeness, bookWide] = await Promise.all([
    listActions(query),
    countActions(query),
    countByKind(businessId, effective.includeBookWide),
    countBySource(businessId, effective.includeBookWide),
    loadCompleteness(),
    countActions({ businessId: BOOK_WIDE, includeBookWide: true }),
  ]);

  const total = ACTOR_KINDS.reduce((sum, k) => sum + byKind[k], 0);

  return {
    business,
    actions,
    matched,
    total,
    byKind,
    bySource,
    bookWideAvailable: effective.includeBookWide ? 0 : bookWide,
    filterNote: describeFilter(effective),
    page: effective.page,
    pageSize: PAGE_SIZE,
    completeness,
    live: true,
  };
}

/**
 * A business id that matches nothing, so `(business_id = $1 OR business_id IS
 * NULL)` counts exactly the book-wide rows.
 *
 * The alternative — a second count function with `business_id IS NULL` in it —
 * is a second predicate that has to be kept in step with `scope()`, and a
 * count computed by a different WHERE clause than the rows is precisely how a
 * "this screen hides none" line starts being false.
 */
const BOOK_WIDE = "00000000-0000-0000-0000-000000000000";

function describeFilter(filter: AuditFilter): string | null {
  const parts: string[] = [];
  if (filter.kind) parts.push(`actor kind = ${filter.kind}`);
  if (filter.surface) parts.push(`surface = ${filter.surface}`);
  if (filter.source) parts.push(`source = ${filter.source}`);
  return parts.length ? parts.join(", ") : null;
}

async function defaultBusinessId(): Promise<string | null> {
  const businesses = await listBusinessesWithActions();
  return businesses[0]?.id ?? null;
}

async function emptyResult(
  filter: AuditFilter,
  business: { readonly id: string; readonly legalName: string } | null,
): Promise<TimelineResult> {
  return {
    business,
    actions: [],
    matched: 0,
    total: 0,
    byKind: Object.fromEntries(ACTOR_KINDS.map((k) => [k, 0])) as Record<ActorKind, number>,
    bySource: {},
    bookWideAvailable: 0,
    filterNote: describeFilter(filter),
    page: 0,
    pageSize: PAGE_SIZE,
    completeness: await loadCompleteness(),
    live: true,
  };
}

export { hasDatabase } from "./store";
