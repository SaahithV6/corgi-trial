import { Badge, MetaList, Panel } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import { AnchorPicker } from "./AnchorPicker";
import { AsCorrectedPanel } from "./AsCorrectedPanel";
import { BothReadings } from "./BothReadings";
import { Reproducibility } from "./Reproducibility";
import { StatementDocument } from "./StatementDocument";
import { StatementPdfLink } from "./StatementPdfLink";
import { StatementPicker } from "./StatementPicker";
import { StatementsErrorPanel } from "./StatementsErrorPanel";
import { StatementsSkeleton } from "./StatementsSkeleton";
import { VersionHistory } from "./VersionHistory";
import type { BothReadingsView, StatementsScreenSource } from "./data-contract";
import type { StatementFilter } from "./view-state";

export { StatementsSkeleton };

/**
 * The statements screen.
 *
 * An async server component behind the page's Suspense boundary, so the
 * skeleton is a real fallback rather than a mock. It reads through
 * `StatementsScreenSource` and knows nothing about where the numbers come from
 * — live query or fixture — except for the one thing it always shows: which of
 * the two it is looking at.
 *
 * THE ORDER OF THE SCREEN IS THE ARGUMENT:
 *
 *   1. both readings, side by side, neither subordinate, with the difference
 *      stated between them
 *   2. when they differ, WHAT corrected it and WHEN we learned
 *   3. why neither figure can change — the watermarks and the hashes
 *   4. the two documents themselves, so the figures are not asked to be
 *      believed
 *   5. every version issued, because a correction is a new document
 *
 * A reader who stops after (1) has the answer. A reader who reads to (5) can
 * check it.
 *
 * `noDatabase` is resolved ONCE, in `page.tsx`, and handed to the state bar as
 * well. It is not re-derived here. Two predicates answering three-quarters of
 * the same question is how a screen ends up badging LIVE above a document
 * badging FIXTURE. The flag chooses the refusal's wording and nothing else:
 * the refusal itself arrives as a failed read, from `./unreadable.ts`.
 */
export async function StatementsView({
  source,
  filter,
  noDatabase = false,
}: {
  readonly source: StatementsScreenSource;
  readonly filter: StatementFilter;
  readonly noDatabase?: boolean;
}) {
  const result = await source.load({
    ...(filter.accountId === null ? {} : { accountId: filter.accountId }),
    ...(filter.businessDate === null ? {} : { businessDate: filter.businessDate }),
    ...(filter.version === null ? {} : { version: filter.version }),
    ...(filter.anchor === null ? {} : { anchor: filter.anchor }),
    preferCorrected: filter.state === "edge",
  });

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        {noDatabase ? (
          <StatementsErrorPanel
            error={result.error}
            title="This screen cannot see the book"
            description="No database is configured for this deployment, so no value date was read, neither reading was derived and no hash was recomputed. Nothing here reproduces anything. A drawn statement claiming to have been re-derived on this page load would be the most misleading artefact this repository could produce, so none is drawn."
          />
        ) : (
          <StatementsErrorPanel error={result.error} />
        )}
      </div>
    );
  }

  const view = result.value;
  const readings = view.readings;

  return (
    <div className="space-y-6">
      <Header />

      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <MetaList
          items={[
            { label: "business", value: view.account?.legalName ?? "—" },
            {
              label: "value date",
              value: readings === null ? "—" : formatDate(readings.valueDate),
            },
            {
              label: "day close",
              value:
                readings === null || readings.closedAt === null
                  ? "not closed"
                  : `${formatTimestamp(readings.closedAt)} · seq ${readings.closeWatermark}`,
            },
            {
              label: "booking watermark now",
              value: readings === null ? "—" : `seq ${readings.corrected.bookingWatermark}`,
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
          These figures are a fixture. Either a demo state that does not read the
          database is selected, or no database is configured — see the state bar
          above. Nothing on this screen is a statement about a real book, and no
          hash here was taken over a real document.
        </p>
      ) : null}

      <StatementPicker
        accounts={view.accounts}
        days={view.days}
        filter={filter}
        selectedAccountId={view.account?.accountId ?? null}
        selectedDay={readings?.valueDate ?? null}
      />

      {readings === null ? (
        <NoAccounts />
      ) : (
        <>
          <AnchorPicker view={readings} filter={filter} />

          <BothReadings view={readings} />

          {/*
            Only on the live screen. The route behind this link reads the
            ledger and refuses to render from fixtures, so offering it beside
            fixture figures would promise a document that does not match the
            numbers above it.
          */}
          {view.source === "live" ? (
            <StatementPdfLink view={readings} filter={filter} />
          ) : null}

          {readings.differs ? (
            <AsCorrectedPanel view={readings} />
          ) : (
            <NothingChanged view={readings} />
          )}

          <Reproducibility view={readings} />

          <StatementDocument
            document={readings.believed.document}
            published={readings.published}
            reproduced={readings.reproduced}
            formatChanged={readings.formatChanged}
            recomputedHash={readings.believed.contentHash}
            title={
              readings.published === null
                ? `${formatDate(readings.valueDate)} as believed at watermark ${readings.believed.bookingWatermark}`
                : `Statement — ${formatDate(readings.valueDate)}, version ${readings.published.version}`
            }
            description={
              readings.published === null
                ? "The day as it read at the left-hand watermark. Re-derived from the ledger on this page load; nothing was issued against it."
                : "The document as issued. Re-derived from the ledger at its own frozen watermark on this page load."
            }
          />

          {readings.differs ? (
            <StatementDocument
              document={readings.corrected.document}
              published={null}
              title="The same day, as the ledger reads it now"
              description="Every posting with this value date, at today's watermark. The rows shaded and badged are the ones that landed after the left-hand reading was taken."
              highlightLate
            />
          ) : null}

          {readings.versions.length === 0 ? null : (
            <VersionHistory
              versions={readings.versions}
              selected={readings.published}
              filter={filter}
            />
          )}
        </>
      )}

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
        what lets a day&rsquo;s figures reproduce byte-for-byte forever while the
        same day, read today, shows the corrected position.
      </p>
    </header>
  );
}

/** No customer deposit account on this book at all. */
function NoAccounts() {
  return (
    <Panel
      title="There is no customer account to read"
      description="A statement is scoped to an account, and this book has none open."
    >
      <div className="px-5 py-10 text-center">
        <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
          Open an account through onboarding and this screen fills in. Nothing has
          gone wrong — a statements screen with no accounts behind it is an honest
          blank, not an error.
        </p>
      </div>
    </Panel>
  );
}

/**
 * The common case, said plainly.
 *
 * Most days are never corrected, and a screen that only makes sense on the
 * ones that were is a screen nobody trusts on the ones that were not. So this
 * panel does two things: it says the two readings agree, and it says what
 * would have to happen for them not to — which is also the clearest short
 * statement of how the correction machinery works.
 */
function NothingChanged({ view }: { readonly view: BothReadingsView }) {
  return (
    <Panel
      title="Nothing has corrected this day"
      description={`No posting with this value date has been booked above watermark ${view.believed.bookingWatermark}, so both readings return the same figure.`}
    >
      <div className="px-5 py-8">
        <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
          The two columns above are not a coincidence and they are not a fallback:
          they are two genuinely different queries —{" "}
          <code>value_date = {view.valueDate}</code> with{" "}
          <code>booking_seq &lt;= {view.believed.bookingWatermark}</code>, and the
          same thing with <code>booking_seq &lt;= {view.corrected.bookingWatermark}</code>{" "}
          — that happen to return the same number today, because nothing landed in
          between.
        </p>
        <p className="mx-auto mt-3 max-w-prose text-xs leading-relaxed text-muted">
          That is not a guarantee about tomorrow, and the screen does not pretend
          it is. A backdated entry with this value date is legal at any time. It
          would be appended above the watermark, the right-hand figure would move,
          the left-hand one would not, and the difference would appear here
          itemised by act — without a single row of this day&rsquo;s record being
          altered.
        </p>
      </div>
    </Panel>
  );
}

function FooterNote() {
  return (
    <p className="max-w-prose text-[11px] leading-relaxed text-muted">
      Both readings are true and neither overwrote the other. The as-published
      figure is what we told the customer; the as-corrected figure is what the
      ledger says that day was. They are two predicates over the same immutable
      rows — <code>value_date</code> for which business days count and{" "}
      <code>booking_seq</code> for what we had learned by then — and the only
      difference between the two documents on this screen is where the second
      predicate is fixed. Neither is stored: both are derived, on this request,
      from the journal.
    </p>
  );
}
