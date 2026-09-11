import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";
import { Badge, MetaList, Note, Panel } from "@/components/ui/primitives";

import { AccrualErrorPanel } from "./AccrualErrorPanel";
import { AccrualSkeleton } from "./AccrualSkeleton";
import { ArithmeticPanel } from "./ArithmeticPanel";
import { DayTable } from "./DayTable";
import { InterestSection } from "./InterestSection";
import { MonthTable } from "./MonthTable";
import { PolicyPanel } from "./PolicyPanel";
import { ScheduleTable } from "./ScheduleTable";
import { SummaryTiles } from "./SummaryTiles";
import type { AccrualDataSource } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

export { AccrualSkeleton };

/**
 * The accruals screen.
 *
 * An async server component behind the page's Suspense boundary, so the
 * skeleton is a real fallback rather than a mock. It reads through
 * `AccrualDataSource` and knows nothing about where the numbers come from —
 * live query or fixture — except for the one thing it always shows: which of
 * the two it is looking at.
 *
 * It never accrues anything. Accruing is a cron and an authenticated POST to
 * `/api/cron/accrual`; a render is not an operator action, and this is the one
 * job on this console that posts money with no human in between, so a page that
 * billed a customer because somebody hit reload would be the worst bug in this
 * repository.
 */
export async function AccrualView({
  source,
  filter,
}: {
  readonly source: AccrualDataSource;
  readonly filter: AccrualFilter;
}) {
  const result = await source.load({
    ...(filter.scheduleId === null ? {} : { scheduleId: filter.scheduleId }),
    ...(filter.accrualDayId === null ? {} : { accrualDayId: filter.accrualDayId }),
    ...(filter.interestDayId === null ? {} : { interestDayId: filter.interestDayId }),
  });

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        <AccrualErrorPanel error={result.error} />
      </div>
    );
  }

  const view = result.value;
  const selectedSchedule =
    filter.scheduleId === null
      ? null
      : (view.schedules.find((s) => s.id === filter.scheduleId) ?? null);

  return (
    <div className="space-y-6">
      <Header />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <MetaList
          items={[
            { label: "book date", value: formatDate(view.bookDate) },
            { label: "schedules", value: String(view.schedules.length) },
            { label: "days", value: String(view.days.length) },
            { label: "read", value: formatTimestamp(view.asOf) },
          ]}
        />
        <Badge tone={view.source === "live" ? "neutral" : "quiet"}>
          {view.source === "live" ? "LIVE DATABASE" : "FIXTURE DATA"}
        </Badge>
      </div>

      {view.source === "fixture" ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          These figures are a fixture, because a demo state other than{" "}
          <code>default</code> is selected — see the state bar above. A
          deployment with no database does not land here: it refuses, and says
          so. The arithmetic is still real: the fixture calls the same{" "}
          <code>allocateForDate()</code> the ledger does, so it cannot disagree
          with the rule. What is not real is that any of it was posted.
        </p>
      ) : null}

      {view.invariants.monthDrift > 0 ? (
        <Note emphasis title="A closed month does not sum to its price">
          <p>
            {view.invariants.monthDrift} row
            {view.invariants.monthDrift === 1 ? "" : "s"} in{" "}
            <code>v_accrual_month_drift</code>. Largest-remainder allocation
            guarantees a complete month sums to the monthly price EXACTLY — not
            within a penny — so a non-zero count here means the allocation is
            wrong, not that it is imprecise. Stop the cron before the next tick.
          </p>
        </Note>
      ) : null}

      {view.invariants.ledgerDrift > 0 ? (
        <Note emphasis title="A posting disagrees with the journal entry it cites">
          <p>
            {view.invariants.ledgerDrift} row
            {view.invariants.ledgerDrift === 1 ? "" : "s"} in{" "}
            <code>v_accrual_ledger_drift</code>: the amount or the value date on
            an <code>accrual_posting</code> is not the amount or the value date
            on its journal entry. <code>assert_accrual_posting()</code> refuses
            that combination at insert, so a row here means the trigger is gone.
          </p>
        </Note>
      ) : null}

      {view.invariants.gap > 0 ? (
        <Note title="Days are owed that nothing has claimed">
          <p>
            {view.invariants.gap} (schedule, date) pair
            {view.invariants.gap === 1 ? " is" : "s are"} due and unclaimed up to
            the book date. Normal for a few minutes after a schedule is created
            and before the first tick; persistent means{" "}
            <code>/api/cron/accrual</code> is not running. Nothing is lost —
            <code>accrual_due_dates()</code> keeps yielding them and each entry
            carries the date it accrued for — but the customer&apos;s balance is
            ahead of their bill until it catches up.
          </p>
        </Note>
      ) : null}

      <SummaryTiles
        schedules={view.schedules}
        days={view.days}
        months={view.months}
        invariants={view.invariants}
      />

      <Panel
        title="Enrolled accounts"
        description="Who is charged a daily-accrued fee, at what monthly price, and the allocation that price produces before a single day is looked at."
      >
        <ScheduleTable rows={view.schedules} filter={filter} />
      </Panel>

      <Panel
        title="By month"
        description="Price against accrued, and how many of the month's residual pennies have been placed. A closed month must equal its price exactly."
      >
        <MonthTable rows={view.months} filter={filter} />
      </Panel>

      <Panel
        title={selectedSchedule === null ? "By day" : `By day · ${selectedSchedule.planName}`}
        description="One row per accrual date, newest first, with the division that produced it. Add the Accrued column over a whole month and it is the price."
      >
        <DayTable rows={view.days} filter={filter} scheduleCount={view.schedules.length} />
      </Panel>

      {view.selected === null ? (
        <p className="text-xs text-muted">
          Select a date to see the full working — basis, days, the exact
          fraction, and where the residual penny landed.
        </p>
      ) : (
        <ArithmeticPanel row={view.selected} filter={filter} />
      )}

      <hr className="border-border" />

      <InterestSection view={view.interest} filter={filter} bookDate={view.bookDate} />

      <hr className="border-border" />

      <PolicyPanel invariants={view.invariants} interest={view.interest.invariants} />

      <FooterNote filter={filter} />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-tight">Accruals</h1>
      <p className="mt-0.5 max-w-prose text-sm text-muted">
        Two things accrue daily on one tick, and they round by two different
        rules for a stated reason. <strong>The platform fee</strong> is one
        monthly price split across the days of its month, so DESIGN §12.3
        allocates it by largest remainder and the month sums to the price to the
        cent. <strong>Interest</strong> is a fresh calculation each day on a
        balance that changes, so there is no total to allocate and §12.2 rounds
        it half to even. This screen shows both, with the working, and says
        which clause governs each.
      </p>
    </header>
  );
}

function FooterNote({ filter }: { readonly filter: AccrualFilter }) {
  return (
    <p className="max-w-prose text-[11px] leading-relaxed text-muted">
      Ticks run from <code>/api/cron/accrual</code>, which is a daily Vercel cron
      on the Hobby plan — that is the tightest schedule the platform runs, so a
      day is accrued by the first tick on or after it rather than at midnight on
      it. &ldquo;End of day&rdquo; here means <em>for the business date</em>, not{" "}
      <em>at 23:59</em>: the entry carries the accrual date as its value date, so
      a tick that runs late still posts to the right day and a tick that missed a
      week posts seven correctly dated entries. Nothing on this screen accrues
      anything.{" "}
      {filter.scheduleId === null && filter.accrualDayId === null ? null : (
        <a
          href={accrualHref(filter, { scheduleId: null, accrualDayId: null })}
          className="underline underline-offset-4"
        >
          Clear filters
        </a>
      )}
    </p>
  );
}
