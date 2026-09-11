/**
 * `/audit`'s URL state, parsed once.
 *
 * Pure: no React, no database, no `server-only`. The page, the state bar and
 * the tests all read the same parser, so "what does `?state=edge&kind=human`
 * mean" has exactly one answer.
 *
 * FIVE STATES, ALL REACHABLE FROM THE QUERY STRING:
 *
 *   (none)          the live trail for one business, read from the book
 *   ?state=loading  the skeleton, held open by a genuinely slow read
 *   ?state=empty    a business with no recorded actions at all
 *   ?state=error    the read failed; nothing moved, retry is live
 *   ?state=edge     ACTIONS TAKEN BY AN AUTONOMOUS AGENT, live from the book
 *
 * WHY THE EDGE STATE IS THE AGENT. It is the row a reviewer looks at hardest
 * and the one most likely to be rendered wrong, because every other row on
 * this screen is a person and the template that reads well for a person reads
 * *reassuringly* for a model. `docs/AGENT-LIMITS.md` is the written statement
 * of the boundary between what an agent may do and what it may not; this is
 * its observable half, and an observable half that looks identical to a human
 * action is not one.
 *
 * `?state=edge` is LIVE, not a fixture: it filters the real book to
 * `actor_kind = 'agent'`. Ridgeline Robotics carries 64 of them, including a
 * $4,990.00 ACH the agent raised and could not approve. A fixture would prove
 * the component renders; only the book proves the agent is distinguishable in
 * data we did not write for the demo.
 */

import { ACTOR_KINDS, type ActorKind } from "@/lib/audit/types";

export type AuditViewState = "default" | "loading" | "empty" | "error" | "edge";

/**
 * Which clock the timeline is ordered by.
 *
 * `recorded` (the default) walks the book's own clock backwards, which is what
 * an incident review does: the most recently LEARNED fact first. `occurred`
 * walks the world's clock, which is what a regulator asking "what happened on
 * Tuesday" wants.
 *
 * They are genuinely different orderings on this book — 1,026 of Ridgeline's
 * 2,209 actions have two clocks that disagree, including a live-fire
 * settlement value-dated 2027-12-07 that was recorded on 2026-09-11. Ordering
 * by a single derived `GREATEST(occurred_at, recorded_at)` would silently
 * merge the two questions and answer neither; making the axis explicit is the
 * whole point of keeping two columns.
 */
export type TimeAxis = "recorded" | "occurred";

const VIEW_STATES: readonly AuditViewState[] = [
  "default",
  "loading",
  "empty",
  "error",
  "edge",
] as const;

export type AuditFilter = {
  readonly state: AuditViewState;
  /** Which business's timeline. `null` means "pick the busiest one". */
  readonly businessId: string | null;
  readonly kind: ActorKind | null;
  readonly surface: string | null;
  readonly source: string | null;
  /** Include actions that belong to the whole book, not one business. */
  readonly includeBookWide: boolean;
  readonly page: number;
  /** The drill-through: which action's underlying record is open. */
  readonly selected: string | null;
  /** Which of the two clocks the list is ordered by. */
  readonly order: TimeAxis;
};

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | null {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * A uuid, or nothing.
 *
 * Validated here rather than in the query so a hand-typed URL produces the
 * empty state instead of a database error the screen would have to render as
 * a crash. The query is parameterised regardless — this is a usability guard,
 * not the injection defence.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `source:pk`, the shape `v_actor_action.action_id` produces. */
const ACTION_ID = /^[a-z_]+:[A-Za-z0-9:_.-]+$/;

export function parseAuditFilter(params: Params): AuditFilter {
  const rawState = one(params, "state");
  const state = VIEW_STATES.includes(rawState as AuditViewState)
    ? (rawState as AuditViewState)
    : "default";

  const business = one(params, "business");
  const rawKind = one(params, "kind");
  const kind = (ACTOR_KINDS as readonly string[]).includes(rawKind ?? "")
    ? (rawKind as ActorKind)
    : null;

  const rawPage = Number.parseInt(one(params, "page") ?? "0", 10);
  const selected = one(params, "action");

  return {
    state,
    businessId: business && UUID.test(business) ? business : null,
    // `?state=edge` IS `?kind=agent`, and an explicit `kind` does not override
    // it. The edge state exists to be shown in a demo by typing one word into
    // the URL bar; a stale `kind` left over from the previous click silently
    // turning it into something else is exactly the kind of near-miss this
    // screen is supposed to make impossible.
    kind: state === "edge" ? "agent" : kind,
    surface: one(params, "surface"),
    source: one(params, "source"),
    includeBookWide: one(params, "scope") === "all",
    page: Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 0,
    selected: selected && ACTION_ID.test(selected) ? selected : null,
    order: one(params, "order") === "occurred" ? "occurred" : "recorded",
  };
}

/** Rebuild the URL with one field changed. Used by every link on the screen. */
export function auditHref(filter: AuditFilter, patch: Partial<AuditFilter>): string {
  const next = { ...filter, ...patch };
  const params = new URLSearchParams();
  if (next.state !== "default") params.set("state", next.state);
  if (next.businessId) params.set("business", next.businessId);
  // `state=edge` already means `kind=agent`; printing both would invite
  // someone to change one of them and wonder why nothing happened.
  if (next.kind && next.state !== "edge") params.set("kind", next.kind);
  if (next.surface) params.set("surface", next.surface);
  if (next.source) params.set("source", next.source);
  if (next.includeBookWide) params.set("scope", "all");
  if (next.page > 0) params.set("page", String(next.page));
  if (next.selected) params.set("action", next.selected);
  if (next.order !== "recorded") params.set("order", next.order);
  const qs = params.toString();
  return qs ? `/audit?${qs}` : "/audit";
}

export const AXIS_LABEL: Record<TimeAxis, string> = {
  recorded: "when we learned",
  occurred: "when it happened",
};

export const STATE_LABEL: Record<AuditViewState, string> = {
  default: "Live",
  loading: "Loading",
  empty: "Empty",
  error: "Error",
  edge: "Edge · autonomous agent",
};

export const STATE_NOTE: Record<AuditViewState, string> = {
  default: "The whole trail for one business, read live from the book.",
  loading: "The skeleton, held open by a deliberately slow read.",
  empty: "A business that exists and has had nothing done to it.",
  error: "The read failed. Nothing moved; the retry is live.",
  edge: "Live, filtered to actions a non-human principal took on its own.",
};
