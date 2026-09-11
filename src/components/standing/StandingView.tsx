import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";
import { Badge, MetaList, Note, Panel } from "@/components/ui/primitives";

import { OccurrenceDetail } from "./OccurrenceDetail";
import { OccurrenceTable } from "./OccurrenceTable";
import { PolicyPanel } from "./PolicyPanel";
import { ScheduleTable } from "./ScheduleTable";
import { StandingErrorPanel } from "./StandingErrorPanel";
import { StandingSkeleton } from "./StandingSkeleton";
import { SummaryTiles } from "./SummaryTiles";
import type { StandingDataSource } from "./data-contract";
import { standingHref, type StandingFilter } from "./view-state";

export { StandingSkeleton };

/**
 * The standing-orders screen.
 *
 * An async server component behind the page's Suspense boundary, so the
 * skeleton is a real fallback rather than a mock. It reads through
 * `StandingDataSource` and knows nothing about where the numbers come from —
 * live query or fixture — except for the one thing it always shows: which of
 * the two it is looking at.
 *
 * It never fires anything. Firing is a cron and an authenticated POST to
 * `/api/cron/standing`; a render is not an operator action, and a page that
 * raised a payment because somebody hit reload would be the worst bug in this
 * repository.
 */
export async function StandingView({
  source,
  filter,
  noDatabase = false,
}: {
  readonly source: StandingDataSource;
  readonly filter: StandingFilter;
  readonly noDatabase?: boolean;
}) {
  const result = await source.load({
    ...(filter.standingOrderId === null ? {} : { standingOrderId: filter.standingOrderId }),
    ...(filter.occurrenceId === null ? {} : { occurrenceId: filter.occurrenceId }),
  });

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        {noDatabase ? (
          <StandingErrorPanel
            error={result.error}
            title="This screen cannot see the schedule"
            description="No database is configured for this deployment, so no mandate was listed, no occurrence was read and no invariant was counted. Nothing here says the schedule is healthy; nothing here could. An invariant tile reading zero would have said exactly that, which is why none is shown."
          />
        ) : (
          <StandingErrorPanel error={result.error} />
        )}
      </div>
    );
  }

  const view = result.value;
  const selectedSchedule =
    filter.standingOrderId === null
      ? null
      : (view.schedules.find((s) => s.id === filter.standingOrderId) ?? null);

  return (
    <div className="space-y-6">
      <Header />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <MetaList
          items={[
            { label: "book date", value: formatDate(view.bookDate) },
            { label: "mandates", value: String(view.schedules.length) },
            { label: "occurrences", value: String(view.occurrences.length) },
            { label: "read", value: formatTimestamp(view.asOf) },
          ]}
        />
        <Badge tone={view.source === "live" ? "neutral" : "quiet"}>
          {view.source === "live" ? "LIVE DATABASE" : "FIXTURE DATA"}
        </Badge>
      </div>

      {/* "or no database is configured" used to be the second half of the
          sentence below. It stopped being true when the refusal landed: with no
          database this screen draws no board at all, so a fixture here means
          one thing and the sentence now says only that thing. A note offering a
          reader two possible causes when the code can produce one is a small
          version of the defect the refusal was written for. */}
      {view.source === "fixture" ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          These figures are a fixture, because a demo state other than{" "}
          <code>default</code> is selected — see the state bar above. Nothing on
          this screen is a statement about a real mandate.
        </p>
      ) : null}

      {view.invariants.doubleFires > 0 ? (
        <Note emphasis title="A scheduled date names more than one payment instruction">
          <p>
            {view.invariants.doubleFires} occurrence
            {view.invariants.doubleFires === 1 ? "" : "s"} in{" "}
            <code>v_standing_order_double_fire</code>. The view matches
            instructions to a mandate by its <em>keyspace</em> rather than by one
            exact key, so this fires on the failure the UNIQUE index cannot see:
            a second instruction for the same mandate and date under a different
            spelling of the key. Read <code>instruction_keys</code> on the row to
            see which two, then stop the cron before the next tick.
          </p>
        </Note>
      ) : null}

      <SummaryTiles
        schedules={view.schedules}
        occurrences={view.occurrences}
        invariants={view.invariants}
      />

      <Panel
        title="Mandates"
        description="What is authorised, how often, and the next date the calendar generates that nothing has claimed."
      >
        <ScheduleTable rows={view.schedules} filter={filter} />
      </Panel>

      <Panel
        title={
          selectedSchedule === null
            ? "History"
            : `History · ${selectedSchedule.reference}`
        }
        description="Every occurrence, decided or not, newest first. A refusal is a row here; that is the point."
      >
        <OccurrenceTable
          rows={view.occurrences}
          filter={filter}
          total={view.schedules.length}
        />
      </Panel>

      {view.selected === null ? (
        <p className="text-xs text-muted">
          Select an occurrence to see the balances its decision was made
          against.
        </p>
      ) : (
        <OccurrenceDetail row={view.selected} filter={filter} />
      )}

      <PolicyPanel invariants={view.invariants} />

      <FooterNote filter={filter} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-tight">Standing orders</h1>
      <p className="mt-0.5 max-w-prose text-sm text-muted">
        Scheduled payments that fire once and only once across restarts and
        retries. The unit is the occurrence — one mandate on one date — and its
        identity comes from those two facts, so a double fire is refused by a
        unique index rather than by the scheduler behaving.
      </p>
    </header>
  );
}

function FooterNote({ filter }: { readonly filter: StandingFilter }) {
  return (
    <p className="max-w-prose text-[11px] leading-relaxed text-muted">
      A firing occurrence raises a payment instruction through the same function
      a person does, so it lands in the approvals queue under the same policy
      version and the same maker-checker rule. Nothing on this screen moves
      money; a second human releases the payment. Ticks run from{" "}
      <code>/api/cron/standing</code>, which is a daily Vercel cron on the Hobby
      plan — that is the tightest schedule the platform runs, so an occurrence
      is claimed on the next tick after its date rather than at midnight on it.{" "}
      {filter.standingOrderId === null && filter.occurrenceId === null ? null : (
        <a
          href={standingHref(filter, { standingOrderId: null, occurrenceId: null })}
          className="underline underline-offset-4"
        >
          Clear filters
        </a>
      )}
    </p>
  );
}
