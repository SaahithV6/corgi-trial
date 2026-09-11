import Link from "next/link";

import { Badge, FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";
import { ACTOR_KINDS, ACTOR_KIND_LABEL, type ActorKind } from "@/lib/audit/types";

import { ActionDetailPanel } from "./ActionDetailPanel";
import { AuditErrorPanel } from "./AuditErrorPanel";
import { CompletenessPanel } from "./CompletenessPanel";
import { TimelineTable } from "./TimelineTable";
import type { AuditDataSource } from "./contract";
import { AXIS_LABEL, auditHref, type AuditFilter, type TimeAxis } from "./view-state";

/**
 * `/audit`'s body: one business, everything that happened to it, in order.
 *
 * An async server component, so the Suspense boundary in the page owns the
 * loading state and this file never has to model one. The error state is
 * caught here rather than thrown, because a screen whose job is to answer
 * "what happened" must be able to say "the read failed" without a crash page.
 */
export async function TimelineView({
  source,
  filter,
}: {
  readonly source: AuditDataSource;
  readonly filter: AuditFilter;
}) {
  let result;
  try {
    result = await source.load(filter);
  } catch (error) {
    return <AuditErrorPanel message={error instanceof Error ? error.message : String(error)} />;
  }

  const { business, actions, matched, total, byKind, bySource, completeness } = result;
  const selected = filter.selected
    ? (actions.find((a) => a.actionId === filter.selected) ?? null)
    : null;
  const pages = Math.max(1, Math.ceil(matched / result.pageSize));

  return (
    <div className="space-y-6">
      <Panel
        title={business ? business.legalName : "No business selected"}
        description={
          business
            ? "Every action recorded against this business, from every append-only store on the book, in order."
            : "Nothing to show. Pass ?business=<uuid>."
        }
        actions={
          result.live ? (
            <Badge tone="positive" title="Read from the live book, not a fixture.">
              live
            </Badge>
          ) : (
            <Badge tone="neutral">fixture</Badge>
          )
        }
      >
        <div className="space-y-4 px-5 py-4">
          {/* ---- the count line ------------------------------------------
              The equivalent of /breaks' "showing 7 of 7, the engine reported
              7, this screen hides none". Every number on it comes from the
              same predicate as the rows above it. */}
          <MetaList
            items={[
              {
                label: "showing",
                value: `${actions.length.toLocaleString()} of ${matched.toLocaleString()} matching`,
              },
              { label: "business total", value: total.toLocaleString() },
              { label: "page", value: `${result.page + 1} of ${pages}` },
              { label: "sources", value: `${completeness.sources.length} reconciled` },
              {
                label: "dropped",
                value: completeness.sources
                  .reduce((n, s) => n + s.droppedRows, 0n)
                  .toLocaleString(),
              },
            ]}
          />

          <p className="max-w-prose text-xs text-muted">
            {result.filterNote
              ? `Filtered to ${result.filterNote}. `
              : "No filter: this is every action on the business. "}
            {matched === total
              ? "This screen hides none of them."
              : `The ${(total - matched).toLocaleString()} not shown are excluded by the filter above, not by the trail.`}
            {result.bookWideAvailable > 0 ? (
              <>
                {" "}
                A further {result.bookWideAvailable.toLocaleString()} actions belong to the whole
                book rather than to any business — day closes, reconciliation runs, rate-card
                changes.{" "}
                <Link
                  href={auditHref(filter, { includeBookWide: true, page: 0 })}
                  className={`underline ${FOCUS_RING} rounded`}
                >
                  Show those too
                </Link>
                .
              </>
            ) : null}
          </p>

          {/* ---- which clock ---------------------------------------------
              Two columns are only worth keeping if the screen will commit to
              one of them at a time and say which. `recorded` is an incident
              review walking backwards through what we learned; `occurred` is
              a regulator asking what happened on Tuesday. */}
          <nav aria-label="Order by" className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              in order of
            </span>
            {(["recorded", "occurred"] as readonly TimeAxis[]).map((axis) => {
              const active = filter.order === axis;
              return (
                <Link
                  key={axis}
                  href={auditHref(filter, { order: axis, page: 0, selected: null })}
                  {...(active ? { "aria-current": "true" as const } : {})}
                  className={`rounded border px-2.5 py-1 text-xs ${FOCUS_RING} ${
                    active
                      ? "border-border-strong bg-surface-raised text-text"
                      : "border-border text-muted hover:text-text"
                  }`}
                >
                  {AXIS_LABEL[axis]}
                </Link>
              );
            })}
          </nav>

          {/* ---- actor facets -------------------------------------------- */}
          <nav aria-label="Filter by actor kind" className="flex flex-wrap items-center gap-2">
            <FacetLink filter={filter} kind={null} count={total} active={filter.kind === null} />
            {ACTOR_KINDS.map((kind) => (
              <FacetLink
                key={kind}
                filter={filter}
                kind={kind}
                count={byKind[kind]}
                active={filter.kind === kind}
              />
            ))}
          </nav>

          {byKind.agent > 0 ? (
            <Note title={`${byKind.agent.toLocaleString()} of these actions were taken by an autonomous agent`}>
              An agent can raise work and can never approve it — the{" "}
              <code>actor_only_humans_approve</code> constraint makes an approving non-human
              unrepresentable, so every one of these is followed by a human decision or by nothing
              at all. They are drawn in the negative colour and labelled AGENT so a reviewer cannot
              mistake one for a person.{" "}
              <Link
                href={auditHref(filter, { state: "edge", kind: "agent", page: 0, selected: null })}
                className={`underline ${FOCUS_RING} rounded`}
              >
                Show only those
              </Link>
              .
            </Note>
          ) : null}

          {byKind.unattributed > 0 ? (
            <Note
              emphasis
              title={`${byKind.unattributed.toLocaleString()} actions have no recorded actor`}
            >
              The store recorded that the thing happened and not who did it. These are rendered as{" "}
              <em>no actor recorded</em> rather than attributed to the system, because guessing is
              how a hole becomes invisible. The columns each one needs are listed in{" "}
              <code>docs/AUDIT.md</code>.
            </Note>
          ) : null}

          {actions.length === 0 ? (
            <Note title="Nothing matches">
              {total === 0
                ? "This business has no recorded actions at all."
                : `${total.toLocaleString()} actions exist for this business; none of them match ${result.filterNote ?? "this filter"}.`}{" "}
              That is a real query against the live book returning nothing, not a placeholder.
            </Note>
          ) : (
            <TimelineTable actions={actions} filter={filter} />
          )}

          {pages > 1 ? (
            <nav aria-label="Pagination" className="flex items-center gap-3 text-xs">
              {result.page > 0 ? (
                <Link
                  href={auditHref(filter, { page: result.page - 1, selected: null })}
                  className={`rounded border border-border px-2 py-1 ${FOCUS_RING}`}
                >
                  ← Newer
                </Link>
              ) : null}
              {result.page + 1 < pages ? (
                <Link
                  href={auditHref(filter, { page: result.page + 1, selected: null })}
                  className={`rounded border border-border px-2 py-1 ${FOCUS_RING}`}
                >
                  Older →
                </Link>
              ) : null}
            </nav>
          ) : null}
        </div>
      </Panel>

      {selected ? <ActionDetailPanel action={selected} /> : null}

      <CompletenessPanel completeness={completeness} bySource={bySource} filter={filter} />
    </div>
  );
}

function FacetLink({
  filter,
  kind,
  count,
  active,
}: {
  readonly filter: AuditFilter;
  readonly kind: ActorKind | null;
  readonly count: number;
  readonly active: boolean;
}) {
  const emphasise = kind === "agent" || kind === "unattributed";
  return (
    <Link
      href={auditHref(filter, {
        // Leaving `state=edge` on while choosing a different actor kind would
        // put the screen in a state whose label contradicts its contents.
        state: filter.state === "edge" && kind !== "agent" ? "default" : filter.state,
        kind,
        page: 0,
        selected: null,
      })}
      {...(active ? { "aria-current": "true" as const } : {})}
      className={`rounded border px-2.5 py-1 text-xs ${FOCUS_RING} ${
        active
          ? "border-border-strong bg-surface-raised text-text"
          : emphasise && count > 0
            ? "border-negative/50 text-negative"
            : "border-border text-muted hover:text-text"
      }`}
    >
      {kind === null ? "All actors" : ACTOR_KIND_LABEL[kind]} · {count.toLocaleString()}
    </Link>
  );
}
