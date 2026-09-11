import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FieldLabel,
  FOCUS_RING,
  MetaList,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
  type BadgeTone,
} from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import {
  AGING_AXIS_LABELS,
  CORRECTION_CLASS_LABELS,
  CORRECTION_CLASS_MEANINGS,
  type CorrectionClass,
} from "@/lib/recon/explain";
import {
  BREAK_KIND_LABELS,
  REASON_CODE_LABELS,
  SEVERITY_LABELS,
  type Severity,
} from "@/lib/recon/types";
import { isErr } from "@/lib/result";

import { CorrectionTimeline } from "./CorrectionTimeline";
import { ReconErrorPanel } from "./ReconErrorPanel";
import type {
  ExplainedBreakRow,
  ExplainedDataSource,
  ExplainedView as ExplainedViewData,
  SilentCorrectionRow,
} from "./explain-contract";
import {
  ALL_BREAK_KINDS,
  ALL_CORRECTION_CLASSES,
  applyExplainFilter,
  explainHref,
  type ExplainFilter,
} from "./explain-view-state";

/**
 * `/breaks` — the reconciliation break that explains itself.
 *
 * An async server component behind the page's Suspense boundary. It reads
 * through `ExplainedDataSource` and knows nothing about where the numbers come
 * from except the one thing it always shows: which of live and fixture it is
 * looking at.
 *
 * The screen is a second READING of the same breaks `/reconciliation` lists,
 * never a second LIST. Its row count equals the engine's, always, and the
 * header says so with the number printed rather than claimed.
 */
export async function ExplainedBreaksView({
  source,
  filter,
}: {
  readonly source: ExplainedDataSource;
  readonly filter: ExplainFilter;
}) {
  const result = await source.load({
    ...(filter.runId === null ? {} : { runId: filter.runId }),
    ...(filter.selected === null ? {} : { selected: filter.selected }),
  });

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header />
        <ReconErrorPanel error={result.error} />
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
          <p className="mx-auto max-w-prose px-5 py-10 text-center text-xs leading-relaxed text-muted">
            There is nothing to explain and nothing has gone wrong. A breaks
            screen with no runs behind it is an honest blank.
          </p>
        </Panel>
      </div>
    );
  }

  const run = view.run;
  const visible = applyExplainFilter(view.rows, filter);
  // The URL wins; the fixture's own `selected` is the fallback, which is what
  // lets `?state=edge` open its timeline without also having to carry a break
  // id nobody could have guessed.
  const selectedId = filter.selected ?? view.selected;
  const selected = view.rows.find((r) => r.id === selectedId) ?? null;

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
        <Note title="These figures are a fixture">
          Either a demo state other than <code>default</code> is selected, or no
          database is configured. Nothing on this screen is a statement about
          the current position of a real book.
          {view.provenance === undefined ? null : (
            <span className="mt-2 block">{view.provenance}</span>
          )}
        </Note>
      ) : null}

      <ClassTiles rows={view.rows} filter={filter} />

      <Panel
        title="Breaks, classified"
        description="Every break the engine reports, with what the book can say about each. Worst first. Nothing is hidden and nothing is collapsed."
        actions={<RunPicker view={view} filter={filter} />}
      >
        <Filters rows={view.rows} filter={filter} />
        <BreaksTable rows={visible} total={view.rows.length} filter={filter} />
      </Panel>

      {selected === null ? (
        <p className="text-xs text-muted">
          Select a break to reconstruct its history from the journal.
        </p>
      ) : (
        <TimelinePanel row={selected} filter={filter} />
      )}

      <SilentPanel rows={view.silent} />

      <FooterNote filter={filter} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function Header() {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-tight">
        Breaks, and why they exist
      </h1>
      <p className="mt-0.5 max-w-prose text-sm text-muted">
        The same three break categories <code>/reconciliation</code> lists, each
        one asked a further question: does the book already explain this? A
        break the system can narrate is still a break — it is ranked
        differently, never hidden.
      </p>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* The four classes, as a summary                                             */
/* -------------------------------------------------------------------------- */

const CLASS_TONE: Record<CorrectionClass, BadgeTone> = {
  not_a_correction: "neutral",
  correction_open: "negative",
  correction_closed: "quiet",
  correction_residual: "negative",
};

function ClassTiles({
  rows,
  filter,
}: {
  readonly rows: readonly ExplainedBreakRow[];
  readonly filter: ExplainFilter;
}) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {ALL_CORRECTION_CLASSES.map((cls) => {
        const matching = rows.filter((r) => r.correctionClass === cls);
        // Integer cents throughout: `reduce` over `number` cents adds exact
        // integers and never divides. No float reaches this screen.
        const outstanding = matching.reduce((sum, r) => sum + Math.abs(r.residualCents), 0);
        const active = filter.correctionClass === cls;

        return (
          <div
            key={cls}
            className={`rounded-lg border p-4 ${
              active ? "border-border-strong bg-surface-raised" : "border-border bg-surface"
            }`}
          >
            <dt className="flex items-baseline justify-between gap-2">
              <FieldLabel>{CORRECTION_CLASS_LABELS[cls]}</FieldLabel>
              <Badge tone={CLASS_TONE[cls]}>{matching.length}</Badge>
            </dt>
            <dd className="mt-2">
              <span className="block text-sm">
                <Money cents={outstanding} tone="neutral" /> outstanding
              </span>
              <span className="mt-1 block max-w-prose text-[11px] leading-relaxed text-muted">
                {CORRECTION_CLASS_MEANINGS[cls]}
              </span>
              <Link
                href={explainHref(filter, {
                  correctionClass: active ? null : cls,
                  selected: null,
                })}
                className={`mt-2 inline-block text-[11px] underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
              >
                {active ? "clear filter" : "show only these"}
              </Link>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/* -------------------------------------------------------------------------- */
/* Filters and run picker                                                     */
/* -------------------------------------------------------------------------- */

function Filters({
  rows,
  filter,
}: {
  readonly rows: readonly ExplainedBreakRow[];
  readonly filter: ExplainFilter;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <FieldLabel>Category</FieldLabel>
      <Chip href={explainHref(filter, { kind: null, selected: null })} active={filter.kind === null}>
        All {rows.length}
      </Chip>
      {ALL_BREAK_KINDS.map((kind) => (
        <Chip
          key={kind}
          href={explainHref(filter, { kind, selected: null })}
          active={filter.kind === kind}
        >
          {BREAK_KIND_LABELS[kind]} {rows.filter((r) => r.kind === kind).length}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  href,
  active,
  children,
}: {
  readonly href: string;
  readonly active: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`rounded border px-2 py-1 text-[11px] ${FOCUS_RING} ${
        active ? "border-border-strong text-text" : "border-border text-muted hover:text-text"
      }`}
    >
      {children}
    </Link>
  );
}

/**
 * Enough of the filename to tell two runs apart.
 *
 * Two files routinely share one business date — a provider re-issue, and the
 * four `planted-*.csv` versions a live-fire attack imports in sequence — so a
 * chip labelled only with the date and a run number showed as four identical
 * chips. The date is what an operator thinks in; the filename is what
 * distinguishes.
 */
function shortFilename(name: string): string {
  const base = name.replace(/\.csv$/i, "");
  return base.length <= 22 ? base : `${base.slice(0, 21)}\u2026`;
}

function RunPicker({
  view,
  filter,
}: {
  readonly view: ExplainedViewData;
  readonly filter: ExplainFilter;
}) {
  if (view.history.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FieldLabel>Run</FieldLabel>
      {view.history.slice(0, 6).map((r) => (
        <Chip
          key={r.runId}
          href={explainHref(filter, { runId: r.runId, selected: null })}
          active={view.run?.runId === r.runId}
        >
          {formatDate(r.businessDate)} · {shortFilename(r.filename)} #{r.runNo}
        </Chip>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

const SEVERITY_TONE: Record<Severity, BadgeTone> = {
  explained: "quiet",
  open: "neutral",
  aged: "neutral",
  stale: "negative",
  critical: "negative",
};

function BreaksTable({
  rows,
  total,
  filter,
}: {
  readonly rows: readonly ExplainedBreakRow[];
  readonly total: number;
  readonly filter: ExplainFilter;
}) {
  if (rows.length === 0) {
    return (
      <div className="px-5 py-10 text-center">
        <p className="mx-auto max-w-prose text-xs leading-relaxed text-muted">
          {total > 0 ? (
            <>
              No break matches this filter. {total} are hidden by it.{" "}
              <Link
                href={explainHref(filter, { kind: null, correctionClass: null, selected: null })}
                className="underline underline-offset-4"
              >
                Clear filters
              </Link>
              .
            </>
          ) : (
            <>
              This file reconciled clean: every reference on it matched an entry
              and every amount agreed. Nothing to explain.
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <>
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Breaks with their correction class, what is still outstanding, and
            the time axis each is aged on
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Break
              </th>
              <th scope="col" className={TH_CLASS}>
                What the book says
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                File
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Booked → now
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Outstanding
              </th>
              <th scope="col" className={TH_CLASS}>
                Age
              </th>
              <th scope="col" className={TH_CLASS}>
                Severity
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => {
              const open = filter.selected === row.id;
              return (
                <tr
                  key={row.id}
                  className={open ? "bg-surface-raised" : undefined}
                  aria-current={open ? "true" : undefined}
                >
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <Link
                      href={explainHref(filter, { selected: open ? null : row.id })}
                      className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                    >
                      {BREAK_KIND_LABELS[row.kind]}
                    </Link>
                    <span className="mt-0.5 block text-xs text-muted">
                      {REASON_CODE_LABELS[row.reasonCode]}
                    </span>
                    <span className="mt-0.5 block font-mono text-[11px] text-muted">
                      {row.externalRef}
                    </span>
                  </th>

                  <td className={TD_CLASS}>
                    <Badge tone={CLASS_TONE[row.correctionClass]}>
                      {CORRECTION_CLASS_LABELS[row.correctionClass]}
                    </Badge>
                    {row.explainedBy === "adjudicated" ? (
                      <span className="ml-1 inline-block">
                        <Badge tone="quiet">adjudicated</Badge>
                      </span>
                    ) : null}
                    <span className="mt-1 block max-w-[34ch] text-[11px] leading-relaxed text-muted">
                      {row.steps.length === 0
                        ? "No journal entry behind it."
                        : `${row.steps.length} ${row.steps.length === 1 ? "entry" : "entries"} in the correction group.`}
                    </span>
                  </td>

                  <td className={`${TD_CLASS} text-right`}>
                    <Absent value={row.fileAmountCents} title="not on the file" />
                  </td>

                  <td className={`${TD_CLASS} text-right`}>
                    <Absent value={row.ledgerAmountCents} title="not on the book" />
                    {row.ledgerNetCents !== null &&
                    row.ledgerAmountCents !== null &&
                    row.ledgerNetCents !== row.ledgerAmountCents ? (
                      <span className="mt-0.5 block text-[11px] text-muted">
                        now <Money cents={row.ledgerNetCents} />
                      </span>
                    ) : null}
                  </td>

                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={row.residualCents} tone="direction" signed />
                    {row.residualCents !== row.breakAmountCents ? (
                      <span className="mt-0.5 block text-[11px] text-muted">
                        file disagreed by{" "}
                        <Money cents={row.breakAmountCents} tone="neutral" signed />
                      </span>
                    ) : null}
                  </td>

                  <td className={TD_CLASS}>
                    <span className="tabular-nums">
                      {row.ageDays === 0 ? "today" : `${row.ageDays}d`}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      from {AGING_AXIS_LABELS[row.agingAxis]}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted">
                      {row.closesCrossed} {row.closesCrossed === 1 ? "close" : "closes"}
                    </span>
                  </td>

                  <td className={TD_CLASS}>
                    <Badge tone={SEVERITY_TONE[row.severity]}>
                      {SEVERITY_LABELS[row.severity]}
                    </Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
      <p className="border-t border-border px-5 py-2 text-[11px] text-muted">
        Showing {rows.length} of {total}. The engine reported {total}; this
        screen classifies them and hides none.
      </p>
    </>
  );
}

function Absent({
  value,
  title,
}: {
  readonly value: number | null;
  readonly title: string;
}) {
  if (value === null) {
    return (
      <span className="text-muted" title={title}>
        &mdash;
      </span>
    );
  }
  return <Money cents={value} tone="neutral" />;
}

/* -------------------------------------------------------------------------- */
/* The drill-through                                                          */
/* -------------------------------------------------------------------------- */

function TimelinePanel({
  row,
  filter,
}: {
  readonly row: ExplainedBreakRow;
  readonly filter: ExplainFilter;
}) {
  const incomplete = row.correctionClass === "correction_open";

  return (
    <Panel
      title={`${BREAK_KIND_LABELS[row.kind]} · ${row.externalRef}`}
      description={CORRECTION_CLASS_MEANINGS[row.correctionClass]}
      actions={
        <Link
          href={explainHref(filter, { selected: null })}
          className={`text-[11px] underline underline-offset-4 ${FOCUS_RING}`}
        >
          Close
        </Link>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap gap-2">
          <Badge tone={CLASS_TONE[row.correctionClass]}>
            {CORRECTION_CLASS_LABELS[row.correctionClass]}
          </Badge>
          <Badge tone={SEVERITY_TONE[row.severity]}>{SEVERITY_LABELS[row.severity]}</Badge>
          <Badge tone="quiet">aged from {AGING_AXIS_LABELS[row.agingAxis]}</Badge>
          {row.correctionGroupId === null ? null : (
            <Badge tone="quiet" title="correction group">
              group {row.correctionGroupId.slice(0, 8)}
            </Badge>
          )}
        </div>

        <TwoAxisAges row={row} />

        <Note title="Why this row is aged the way it is">{row.axisRationale}</Note>
      </div>

      <CorrectionTimeline
        steps={row.steps}
        fileAmountCents={row.fileAmountCents}
        incomplete={incomplete}
      />

      <div className="border-t border-border px-5 py-4">
        <Note
          emphasis={row.correctionClass === "correction_closed"}
          title="What believing this classification could hide"
        >
          {row.exclusionRisk}
        </Note>
      </div>
    </Panel>
  );
}

/**
 * Both clocks, side by side, with the one in use marked.
 *
 * The screen ages each row on one axis and prints the other anyway, because
 * the number it chose not to use is exactly the number somebody will ask about
 * — and "why does this say today when the settlement was three weeks ago" has
 * to be answerable from the screen rather than from this file.
 */
function TwoAxisAges({ row }: { readonly row: ExplainedBreakRow }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      <AxisCard
        label="Value date"
        caption="how long the book has been wrong"
        ageDays={row.valueAxis.ageDays}
        closes={row.valueAxis.closesCrossed}
        inUse={row.agingAxis === "value_date"}
        detail={`value date ${formatDate(row.valueDate)}`}
      />
      {row.bookingAxis === null ? (
        <div className="rounded-lg border border-border bg-surface p-4">
          <FieldLabel>When we learned</FieldLabel>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            No correction group stands behind this break, so there is no second
            clock. The only thing that ever happened to this reference is the
            entry we booked, or the absence of one.
          </p>
        </div>
      ) : (
        <AxisCard
          label="When we learned"
          caption="how long this has been somebody's open item"
          ageDays={row.bookingAxis.ageDays}
          closes={row.bookingAxis.closesCrossed}
          inUse={row.agingAxis === "booking_time"}
          detail={
            row.learnedAt === null
              ? "no booking recorded"
              : `last booked ${formatTimestamp(row.learnedAt)}`
          }
        />
      )}
    </dl>
  );
}

function AxisCard({
  label,
  caption,
  ageDays,
  closes,
  inUse,
  detail,
}: {
  readonly label: string;
  readonly caption: string;
  readonly ageDays: number;
  readonly closes: number;
  readonly inUse: boolean;
  readonly detail: string;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        inUse ? "border-border-strong bg-surface-raised" : "border-border bg-surface"
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel>{label}</FieldLabel>
        {inUse ? <Badge tone="neutral">aged on this</Badge> : <Badge tone="quiet">not used</Badge>}
      </div>
      <p className="mt-2 text-sm tabular-nums">
        {ageDays === 0 ? "today" : `${ageDays} days`} · {closes}{" "}
        {closes === 1 ? "close" : "closes"}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">
        {caption}
        <span className="mt-0.5 block">{detail}</span>
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The advisory list                                                          */
/* -------------------------------------------------------------------------- */

function SilentPanel({ rows }: { readonly rows: readonly SilentCorrectionRow[] }) {
  return (
    <Panel
      title="Corrections the file has not caught up with"
      description="Matched clean against the entry we had booked, and our position on the reference has moved since. These are NOT breaks — no break list anywhere reports them, which is the point of showing them."
    >
      {rows.length === 0 ? (
        <p className="max-w-prose px-5 py-6 text-xs leading-relaxed text-muted">
          None on this file. Every reference the diff matched still nets to the
          amount the file carries.
        </p>
      ) : (
        <>
          <TableScroll>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                File rows that matched the anchor entry and whose correction
                group has since moved away from it
              </caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH_CLASS}>
                    Reference
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    File
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Group nets to
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Drift
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Group
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((r) => (
                  <tr key={r.fileRowId}>
                    <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                      <span className="font-mono text-xs">{r.externalRef}</span>
                      <span className="mt-0.5 block text-xs text-muted">
                        row {r.rowNo} · {formatDate(r.valueDate)} · {r.rail}
                      </span>
                    </th>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={r.fileAmountCents} tone="neutral" />
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={r.ledgerNetCents} tone="neutral" />
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={r.driftCents} tone="direction" signed />
                    </td>
                    <td className={TD_CLASS}>
                      <span className="font-mono text-[11px] text-muted">
                        {r.correctionGroupId.slice(0, 8)}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        {r.entryCount} entries
                        {r.hasReversal ? ", reversed" : ""}
                        {r.hasRebook ? " and re-booked" : ""}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
          <div className="border-t border-border px-5 py-4">
            <Note emphasis title="Why the breaks screen cannot see these">
              The diff matches the file against the ANCHOR entry — what we had
              booked when the provider produced the file — which is the right
              anchor for &ldquo;was the provider disagreeing with us&rdquo;. When
              the file carries the pre-correction amount, file and anchor agree,
              the row matches, and no break is raised even though our position
              has moved. The same $50.00 DOES surface, as an explained amount
              mismatch, on a re-issued file that carries the corrected figure —
              so which of the two an operator sees depends on whether the
              provider happened to restate the row. This list is additive: it
              removes nothing from any break count.
            </Note>
          </div>
        </>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Footer                                                                     */
/* -------------------------------------------------------------------------- */

function FooterNote({ filter }: { readonly filter: ExplainFilter }) {
  return (
    <div className="space-y-2">
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        <strong className="font-medium text-text">Two clocks.</strong> An
        unexplained break is aged from its <em>value date</em>, because its age
        measures how long the book has been wrong and every statement issued
        since that day carries the error. A break whose correction group is in
        flight or already closed is aged from <em>when we learned</em>, because a
        reversal carries the original&rsquo;s value date and aging it on the
        value axis would print the age of the settlement and call it the age of
        the correction. A correction that left money outstanding goes back to
        the value axis: the remainder has been missing since the business day
        and the correction did not touch it.
      </p>
      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        Nothing on this screen is filtered by default, and{" "}
        <em>explainable</em> is never <em>resolved</em>: only a group that was
        reversed, re-booked, and nets to the file&rsquo;s amount to the cent
        reads as answered.{" "}
        <Link
          href={explainHref(filter, { kind: null, correctionClass: null, selected: null })}
          className="underline underline-offset-4"
        >
          Clear filters
        </Link>
        {" · "}
        <Link href="/reconciliation" className="underline underline-offset-4">
          The run history and the file rows
        </Link>
      </p>
    </div>
  );
}
