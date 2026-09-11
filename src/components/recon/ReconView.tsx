import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";
import { Badge, MetaList, Panel } from "@/components/ui/primitives";

import { BreakDetailPanel } from "./BreakDetailPanel";
import { BreakFilters } from "./BreakFilters";
import { BreaksTable } from "./BreaksTable";
import { ReconErrorPanel } from "./ReconErrorPanel";
import { ReconSkeleton } from "./ReconSkeleton";
import { RejectsPanel } from "./RejectsPanel";
import { RunControls } from "./RunControls";
import { RunHistory } from "./RunHistory";
import { SummaryTiles } from "./SummaryTiles";
import type { ReconDataSource } from "./data-contract";
import { applyFilter, breakHref, type BreakFilter } from "./view-state";

export { ReconSkeleton };

/**
 * The breaks screen.
 *
 * An async server component behind the page's Suspense boundary, so the
 * skeleton is a real fallback rather than a mock. It reads through
 * `ReconDataSource` and knows nothing about where the numbers come from — live
 * query or fixture — except for the one thing it always shows: which of the
 * two it is looking at.
 *
 * `noDatabase` is resolved ONCE, in `page.tsx`, and handed to the state bar as
 * well. It is not re-derived here. Two predicates answering three-quarters of
 * the same question is how a screen ends up badging LIVE above a board badging
 * FIXTURE, which is what `/dashboard` was doing until an hour ago. The flag
 * chooses the refusal's wording and nothing else: the refusal itself arrives
 * as a failed read, from `./unreadable.ts`, down the path below.
 */
export async function ReconView({
  source,
  filter,
  noDatabase = false,
}: {
  readonly source: ReconDataSource;
  readonly filter: BreakFilter;
  readonly noDatabase?: boolean;
}) {
  const result = await source.load({
    ...(filter.runId === null ? {} : { runId: filter.runId }),
    ...(filter.selected === null ? {} : { selectedBreak: filter.selected }),
  });

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        {noDatabase ? (
          <ReconErrorPanel
            error={result.error}
            title="This screen cannot see the file or the book"
            description="No database is configured for this deployment, so no run was read and no break list is drawn. Nothing here says the file reconciled; nothing here could. An empty break table would have said exactly that, which is why one is not shown."
          />
        ) : (
          <ReconErrorPanel error={result.error} />
        )}
      </div>
    );
  }

  const view = result.value;

  if (view.run === null) {
    return (
      <div className="space-y-6">
        <Header />
        <Panel
          title="Nothing has been reconciled yet"
          description="No settlement file has been imported and run against this book."
        >
          <div className="px-5 py-10 text-center">
            <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
              Import a file and run the reconciliation with the form below, and
              this screen fills in. There is nothing to show and nothing has
              gone wrong — a breaks screen with no runs behind it is an honest
              blank, not an error.
            </p>
          </div>
        </Panel>
        <RunControls runnable={view.source === "live"} current={null} />
      </div>
    );
  }

  const run = view.run;
  const visible = applyFilter(view.breaks, filter);

  return (
    <div className="space-y-6">
      <Header />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <MetaList
          items={[
            { label: "file", value: run.filename },
            { label: "business date", value: formatDate(run.businessDate) },
            { label: "run", value: `#${run.runNo}` },
            { label: "watermark", value: `seq ${run.bookingWatermark}` },
            { label: "read", value: formatTimestamp(view.asOf) },
          ]}
        />
        <Badge tone={view.source === "live" ? "neutral" : "quiet"}>
          {view.source === "live" ? "LIVE LEDGER" : "FIXTURE DATA"}
        </Badge>
      </div>

      {view.source === "fixture" ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          These figures are a fixture. Either a demo state other than{" "}
          <code>default</code> is selected, or no database is configured — see
          the state bar above. Nothing on this screen is a statement about a
          real book.
        </p>
      ) : null}

      <SummaryTiles run={run} breaks={view.breaks} />

      <Panel
        title="Breaks"
        description="Live, not the run's snapshot: a break corrected ten minutes ago reads as corrected. Worst first, then oldest, then largest."
      >
        <BreakFilters filter={filter} breaks={view.breaks} />
        <BreaksTable rows={visible} filter={filter} total={view.breaks.length} />
      </Panel>

      {view.detail === null ? (
        <p className="text-xs text-muted">
          Select a break to see the file row and the journal entry behind it.
        </p>
      ) : (
        <BreakDetailPanel detail={view.detail} filter={filter} />
      )}

      {view.rejects.length === 0 ? null : <RejectsPanel rejects={view.rejects} />}

      <RunHistory runs={view.history} current={run} filter={filter} />

      <RunControls
        runnable={view.source === "live"}
        current={{ fileId: run.fileId, filename: run.filename, runNo: run.runNo }}
      />

      <FooterNote filter={filter} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-tight">Reconciliation</h1>
      <p className="mt-0.5 max-w-prose text-sm text-muted">
        The provider&rsquo;s settlement file against our book, matched on the
        provider&rsquo;s own reference and on nothing else. Three break
        categories, no more and no fewer.
      </p>
    </header>
  );
}

function FooterNote({ filter }: { readonly filter: BreakFilter }) {
  return (
    <p className="max-w-prose text-[11px] leading-relaxed text-muted">
      Aging is measured from the value date and from day closes, not from when
      the job last ran — a break does not get younger because the nightly run
      was late. Severity escalates when a break has been open{" "}
      <em>across a day close</em>: somebody signed off a business day with it
      outstanding.{" "}
      <a
        href={breakHref(filter, { kind: null, age: null, selected: null })}
        className="underline underline-offset-4"
      >
        Clear filters
      </a>
      {" · "}
      <a href="/breaks" className="underline underline-offset-4">
        Why each break exists
      </a>{" "}
      &mdash; the same breaks with their correction group reconstructed as a
      timeline, on both time axes.
    </p>
  );
}
