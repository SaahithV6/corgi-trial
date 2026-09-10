import { Badge, MetaList, Panel } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import { AsCorrectedPanel } from "./AsCorrectedPanel";
import { BothReadings } from "./BothReadings";
import { StatementDocument } from "./StatementDocument";
import { StatementPicker } from "./StatementPicker";
import { StatementsErrorPanel } from "./StatementsErrorPanel";
import { StatementsSkeleton } from "./StatementsSkeleton";
import { VersionHistory } from "./VersionHistory";
import type { StatementsDataSource } from "./data-contract";
import type { StatementFilter } from "./view-state";

export { StatementsSkeleton };

/**
 * The statements screen.
 *
 * An async server component behind the page's Suspense boundary, so the
 * skeleton is a real fallback rather than a mock. It reads through
 * `StatementsDataSource` and knows nothing about where the numbers come from —
 * live query or fixture — except for the one thing it always shows: which of
 * the two it is looking at.
 *
 * The order of the screen is the argument:
 *
 *   1. both readings, side by side, neither subordinate
 *   2. the published document, with the hash re-derived on this load
 *   3. why the two differ, itemised by act
 *   4. every version issued, because a correction is a new document
 */
export async function StatementsView({
  source,
  filter,
}: {
  readonly source: StatementsDataSource;
  readonly filter: StatementFilter;
}) {
  const result = await source.load({
    ...(filter.accountId === null ? {} : { accountId: filter.accountId }),
    ...(filter.businessDate === null ? {} : { businessDate: filter.businessDate }),
    ...(filter.version === null ? {} : { version: filter.version }),
  });

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        <StatementsErrorPanel error={result.error} />
      </div>
    );
  }

  const view = result.value;

  return (
    <div className="space-y-6">
      <Header />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <MetaList
          items={[
            { label: "business", value: view.account?.legalName ?? "—" },
            {
              label: "business day",
              value: view.day === null ? "—" : formatDate(view.day.businessDate),
            },
            {
              label: "closed",
              value:
                view.day === null ? "—" : `${formatTimestamp(view.day.closedAt)}`,
            },
            {
              label: "close watermark",
              value: view.day === null ? "—" : `seq ${view.day.bookingWatermark}`,
            },
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
          real book, and no hash here was taken over a real document.
        </p>
      ) : null}

      <StatementPicker
        accounts={view.accounts}
        days={view.days}
        filter={filter}
        selectedAccountId={view.account?.accountId ?? null}
        selectedDay={view.day?.businessDate ?? null}
      />

      {view.day === null ? <NoClosedDay /> : null}

      {view.day !== null && view.statement === null ? (
        <NotPublished
          businessDate={view.day.businessDate}
          bookingWatermark={view.day.bookingWatermark}
          lineCount={view.day.lineCount}
        />
      ) : null}

      {view.day !== null && view.statement !== null ? (
        <>
          <BothReadings detail={view.statement} businessDate={view.day.businessDate} />

          <StatementDocument
            document={view.statement.publishedDocument}
            published={view.statement.published}
            reproduced={view.statement.reproduced}
            formatChanged={view.statement.formatChanged}
            recomputedHash={view.statement.recomputedHash}
            title={`Statement — ${formatDate(view.day.businessDate)}, version ${view.statement.published.version}`}
            description="The document as issued. Re-derived from the ledger at its own frozen watermark on this page load."
          />

          {view.statement.differs ? (
            <>
              <AsCorrectedPanel
                detail={view.statement}
                businessDate={view.day.businessDate}
              />

              <StatementDocument
                document={view.statement.correctedDocument}
                published={null}
                title={`The same day, as the ledger reads it now`}
                description="Every posting with this value date, at today's watermark. The rows shaded and badged are the ones that landed after the close."
                highlightLate
              />
            </>
          ) : (
            <Panel
              title="Nothing has changed since this statement was issued"
              description="No posting with this value date has been booked above the close watermark."
            >
              <div className="px-5 py-8 text-center">
                <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
                  The as-published and as-corrected readings agree, so there is
                  no second document to show. That is not the same as saying
                  corrections are impossible: a backdated entry with this value
                  date is legal at any time, would land above the watermark, and
                  would appear here as a difference the moment it did — without
                  altering the version above.
                </p>
              </div>
            </Panel>
          )}

          <VersionHistory
            versions={view.statement.versions}
            selected={view.statement.published}
            filter={filter}
          />
        </>
      ) : null}

      <FooterNote />
    </div>
  );
}

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-tight">Statements</h1>
      <p className="mt-0.5 max-w-prose text-sm text-muted">
        A statement is a period AND a booking watermark, not a period. That is
        what lets a closed day&rsquo;s document reproduce byte-for-byte forever
        while the same day, read today, shows the corrected position.
      </p>
    </header>
  );
}

/** No `book_day` row at all for this book. */
function NoClosedDay() {
  return (
    <Panel
      title="No business day has been closed yet"
      description="A statement is pinned to the watermark a close freezes, so there is nothing to pin one to."
    >
      <div className="px-5 py-10 text-center">
        <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
          Close a business day and this screen fills in. Nothing has gone wrong
          — a statements screen with no closes behind it is an honest blank, not
          an error. Note that closing does not stop later postings with that
          value date: they land above the watermark, which is exactly what makes
          the two readings on this screen differ.
        </p>
      </div>
    </Panel>
  );
}

/** The day was closed, and nobody issued the document. A state, not an error. */
function NotPublished({
  businessDate,
  bookingWatermark,
  lineCount,
}: {
  readonly businessDate: string;
  readonly bookingWatermark: number;
  readonly lineCount: number;
}) {
  return (
    <Panel
      title={`${formatDate(businessDate)} was closed, but no statement has been issued`}
      description={`The watermark exists — seq ${bookingWatermark} — so the document is derivable. Nobody has published it.`}
    >
      <div className="px-5 py-10 text-center">
        <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
          {lineCount === 0
            ? "This account had no postings on that day, so the statement would be an opening balance, no lines, and the same closing balance. Still a real document, and still worth issuing — a customer is entitled to a statement that says nothing happened."
            : `This account has ${lineCount} posting${lineCount === 1 ? "" : "s"} on that day. Rendering them is a query; issuing the document is an operator action with an actor attached, and this screen does not take one.`}
        </p>
      </div>
    </Panel>
  );
}

function FooterNote() {
  return (
    <p className="max-w-prose text-[11px] leading-relaxed text-muted">
      Both readings are true and neither overwrote the other. The published
      figure is what we told the customer; the corrected figure is what the
      ledger says that day was. They are two predicates over the same immutable
      rows — <code>value_date</code> for which business days count and{" "}
      <code>booking_seq</code> for what we had learned by then — and the only
      difference between the two documents on this screen is where the second
      predicate is fixed.
    </p>
  );
}
