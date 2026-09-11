import Link from "next/link";

import { formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  MetaList,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { withTimeTravel } from "@/lib/timetravel/params";
import { prefixLeak } from "@/lib/timetravel/point";
import { WINDOWS, WINDOW_LABELS } from "@/lib/timetravel/read";

import { BookingAxis } from "./BookingAxis";
import { CutNotice, PrefixLeakNotice } from "./CutNotice";
import { TimeTravelBar } from "./TimeTravelBar";
import type { TransactionsView as View } from "./contract";

/**
 * `/transactions` — one account, one business day, read at a point on both
 * clocks.
 *
 * The order of the page is the argument:
 *
 *   1. the control, so the reader can move before they are told what moved
 *   2. the guard, when it fired
 *   3. THE TWO READINGS and the difference between them — the headline
 *   4. the acts that account for the difference, entry by entry, with the
 *      identity stated and checked
 *   5. the booking axis drawn, so "same day, later knowledge" is visible
 *   6. the day's postings AT the cut, both clocks on every row
 *   7. availability at the cut, all five terms
 *
 * Nothing on this screen is stored. Every figure is a fold over journal lines
 * with `point.snapshot` passed in, and the travelled figure and the live one
 * come out of the SAME function with one argument changed.
 */
export function TransactionsView({
  view,
  basePath,
  liveHref,
}: {
  readonly view: View;
  readonly basePath: string;
  readonly liveHref: string;
}) {
  const leak = prefixLeak(view.point);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">
          {view.account.name}
        </h1>
        <p className="mt-0.5 max-w-prose text-sm text-muted">
          The same business day, read at two points in transaction time. A
          correction posts at the original value date with a strictly later
          booking sequence and never edits a row — so what we believed then and
          what we know now are both still derivable, exactly.
        </p>
        <div className="mt-3">
          <MetaList
            items={[
              { label: "Value date", value: view.point.snapshot.valueDate },
              {
                label: "Booking watermark",
                value: view.point.snapshot.bookingWatermark.toString(),
              },
              {
                label: "Read at",
                value: formatTimestamp(view.point.resolvedAt.toISOString()),
              },
              {
                label: "Source",
                value:
                  view.source === "live" ? (
                    <Badge tone="positive">live ledger</Badge>
                  ) : (
                    <Badge tone="quiet">fixture</Badge>
                  ),
              },
            ]}
          />
        </div>
      </header>

      <TimeTravelBar
        point={view.point}
        basePath={basePath}
        landmarks={view.landmarks}
        liveHref={liveHref}
      />

      {leak === null ? null : <PrefixLeakNotice overshootMs={leak} />}
      <CutNotice point={view.point} />

      {view.point.foresight ? (
        <Note title="You are asking what we believed about a day that had not happened">
          <p>
            <span className="font-mono text-text">asKnownAt</span> lands before{" "}
            <span className="font-mono text-text">asOf</span> begins. That is a
            coherent bitemporal question and this book has real content for it:
            standing-order settlements are value-dated years ahead, so a
            belief held in 2026 about a 2027 business day is a fact we had
            already booked, not a forecast. It is supported, and it is named
            here so no reader assumes every reading on this screen is
            retrospective.
          </p>
        </Note>
      ) : null}

      <TwoReadings view={view} basePath={basePath} />

      <WhatChanged view={view} />

      <BookingAxis
        point={view.point}
        pending={view.pending}
        valueDate={view.point.snapshot.valueDate}
      />

      <Postings view={view} basePath={basePath} />

      <AvailabilityPanel view={view} />
    </div>
  );
}


/**
 * Set one query parameter on an href, preserving the rest.
 *
 * The same shape as `withTimeTravel` and deliberately separate from it: that
 * function owns the two time axes and nothing else, so a change to how the
 * window is encoded can never reach into how a time coordinate is.
 */
function withParam(href: string, key: string, value: string): string {
  const [path, query = ""] = href.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(key, value);
  const rendered = params.toString();
  return rendered === "" ? (path ?? "") : `${path ?? ""}?${rendered}`;
}

/* -------------------------------------------------------------------------- */
/* 3. The headline                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Two figures of equal weight, with the difference stated between them.
 *
 * Neither is the correction of the other. They are answers to two different
 * questions about the same immutable rows, and rendering one as subordinate —
 * smaller, greyed, in a footnote — would make a claim about which one is real.
 * The difference is printed, signed, rather than left to be subtracted by eye.
 *
 * Each column carries its own booking watermark on its face, because a
 * bitemporal figure without its watermark is half a fact.
 */
function TwoReadings({
  view,
  basePath,
}: {
  readonly view: View;
  readonly basePath: string;
}) {
  const differs = view.deltaCents !== 0n;

  return (
    <Panel
      title={`${view.point.snapshot.valueDate} — closing balance, read twice`}
      description="Same value date. Same rows. One argument changed."
      actions={
        differs ? (
          <Badge tone="neutral">the belief changed</Badge>
        ) : (
          <Badge tone="quiet">no change</Badge>
        )
      }
    >
      <div className="grid gap-px bg-border sm:grid-cols-[1fr_auto_1fr]">
        <Reading
          label={
            view.point.bookingPinned ? "As believed then" : "As we know it now"
          }
          cents={view.closingCents}
          watermark={view.point.snapshot.bookingWatermark}
          instant={
            view.point.requestedKnownAt === null
              ? null
              : view.point.requestedKnownAt.toISOString()
          }
        />

        <div className="flex flex-col items-center justify-center bg-surface px-5 py-4">
          <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
            Difference
          </span>
          <Money
            cents={view.deltaCents}
            tone="direction"
            signed
            className="mt-1 text-lg font-semibold"
          />
          <span className="mt-1 text-center text-[11px] text-muted">
            {differs
              ? `over ${String(view.pending.length)} later act${view.pending.length === 1 ? "" : "s"}`
              : "the two queries agree"}
          </span>
        </div>

        <Reading
          label="As corrected — everything we know"
          cents={view.closingNowCents}
          watermark={view.point.liveWatermark}
          instant={null}
          href={
            view.point.bookingPinned
              ? withTimeTravel(basePath, { asKnownAt: null })
              : null
          }
        />
      </div>

      {differs ? null : (
        <div className="border-t border-border px-5 py-4">
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            The two columns are two genuinely different queries that happen to
            return the same number for this day. They would separate the moment
            anything value-dated on or before{" "}
            <span className="font-mono">{view.point.snapshot.valueDate}</span>{" "}
            were booked above watermark{" "}
            <span className="font-mono">
              {view.point.snapshot.bookingWatermark.toString()}
            </span>{" "}
            — a reversal, a re-book, a late settlement. A screen that only made
            sense on corrected days would be worse than one that reads well on
            both.
          </p>
        </div>
      )}
    </Panel>
  );
}

function Reading({
  label,
  cents,
  watermark,
  instant,
  href = null,
}: {
  readonly label: string;
  readonly cents: bigint;
  readonly watermark: bigint;
  readonly instant: string | null;
  readonly href?: string | null;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
        {href === null ? (
          label
        ) : (
          <Link href={href} className={`underline underline-offset-4 ${FOCUS_RING}`}>
            {label}
          </Link>
        )}
      </p>
      <Money cents={cents} className="mt-1 block text-2xl font-semibold" />
      <p className="mt-1 font-mono text-[11px] text-muted">
        booking watermark {watermark.toString()}
      </p>
      {instant === null ? null : (
        <p className="font-mono text-[11px] text-muted">
          {formatTimestamp(instant)}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. The identity                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The acts that account for the difference, and whether they account for ALL
 * of it.
 *
 *     closing(now) − closing(asKnownAt) = Σ (entries booked above the cut)
 *
 * Both sides are printed and compared. When they disagree the screen says so
 * in the negative colour rather than printing the delta and moving on — an
 * unexplained difference between two readings of an immutable ledger is not a
 * rounding artefact, it is a bug in one of the two readers, and this is the
 * only place it would ever be visible.
 */
function WhatChanged({ view }: { readonly view: View }) {
  if (view.late.length === 0) return null;

  return (
    <Panel
      title="What we learned after that point, and when"
      description="Rolled up per entry, because a reversal is one act even when it moves four lines. Every row carries both clocks: the value date it belongs to, and the booking position it arrived at."
      actions={
        view.explained ? (
          <Badge tone="positive">fully accounted for</Badge>
        ) : (
          <Badge tone="negative">does not reconcile</Badge>
        )
      }
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Entries booked above the cut that affect this value date
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Entry
              </th>
              <th scope="col" className={TH_CLASS}>
                Value date
              </th>
              <th scope="col" className={TH_CLASS}>
                Booked
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {view.late.map((entry) => (
              <tr key={entry.entryId}>
                <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                  <span className="block max-w-prose">{entry.description}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {entry.entryType}
                    {entry.correctionGroupId === null
                      ? null
                      : ` · act ${entry.correctionGroupId.slice(0, 8)}`}
                  </span>
                </th>
                <td className={`${TD_CLASS} font-mono text-xs`}>
                  {entry.valueDate}
                  {entry.valueDate < view.point.snapshot.valueDate ? (
                    <span className="mt-0.5 block text-[10px] uppercase tracking-[0.08em] text-muted">
                      moves the opening balance
                    </span>
                  ) : null}
                </td>
                <td className={`${TD_CLASS} font-mono text-xs text-muted`}>
                  seq {entry.bookingSeq.toString()}
                  <span className="mt-0.5 block">
                    {formatTimestamp(entry.bookingTime.toISOString())}
                  </span>
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={entry.signedCents} tone="direction" signed />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border-strong">
            <tr>
              <th scope="row" colSpan={3} className={`${TD_CLASS} text-left`}>
                Σ of the acts above
              </th>
              <td className={`${TD_CLASS} text-right font-medium`}>
                <Money cents={view.lateNetCents} tone="direction" signed />
              </td>
            </tr>
            <tr>
              <th scope="row" colSpan={3} className={`${TD_CLASS} text-left`}>
                Difference between the two readings
              </th>
              <td className={`${TD_CLASS} text-right font-medium`}>
                <Money cents={view.deltaCents} tone="direction" signed />
              </td>
            </tr>
          </tfoot>
        </table>
      </TableScroll>

      <div className="border-t border-border px-5 py-4">
        {view.explained ? (
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            The two agree, so every cent of the difference between the two
            readings is accounted for by the entries listed above — and by
            nothing else. No row was edited to produce it.
          </p>
        ) : (
          <p className="max-w-prose text-xs leading-relaxed text-negative">
            These two figures must be equal and they are not. That is not a
            rounding artefact: it means one of the two readers disagrees with
            the other about what is above this watermark. Nothing here is
            repaired — the number is reported so it can be diagnosed.
          </p>
        )}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 6. The day itself                                                          */
/* -------------------------------------------------------------------------- */

function Postings({
  view,
  basePath,
}: {
  readonly view: View;
  readonly basePath: string;
}) {
  return (
    <Panel
      title="The postings, as they stood at that point"
      description="Opening balance plus these lines equals the closing figure above. Every row carries its booking sequence, which is the axis the cut is actually defined on."
      actions={
        <div className="flex flex-wrap items-center gap-1">
          {WINDOWS.map((window) => {
            const href = withParam(basePath, "window", window);
            const current = view.window === window;
            return (
              <Link
                key={window}
                href={href}
                aria-current={current ? "page" : undefined}
                title={WINDOW_LABELS[window]}
                className={`rounded px-2 py-1 text-[11px] ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {window}
              </Link>
            );
          })}
        </div>
      }
    >
      {view.postings.length === 0 ? (
        <div className="px-5 py-8">
          <p className="max-w-prose text-sm text-muted">
            Nothing was value-dated{" "}
            {view.from === view.to ? (
              <>
                on <span className="font-mono">{view.to}</span>
              </>
            ) : (
              <>
                between <span className="font-mono">{view.from}</span> and{" "}
                <span className="font-mono">{view.to}</span>
              </>
            )}{" "}
            as at booking watermark{" "}
            <span className="font-mono">
              {view.point.snapshot.bookingWatermark.toString()}
            </span>
            .
          </p>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            An empty day and a day we had not learned about yet look identical
            in a table and are different facts, so the opening balance below is
            shown either way: it is what this account was carrying into the
            window at that point.
          </p>
          <dl className="mt-3 grid gap-2 sm:grid-cols-[10rem_1fr]">
            <dt className="text-xs uppercase tracking-[0.08em] text-muted">
              Opening
            </dt>
            <dd>
              <Money cents={view.openingCents} />
            </dd>
          </dl>
        </div>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Postings on this account in the window, at the booking watermark
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>
                  Value date
                </th>
                <th scope="col" className={TH_CLASS}>
                  Description
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Booking seq
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Amount
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Balance
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr className="bg-surface-raised">
                <th scope="row" colSpan={4} className={`${TD_CLASS} text-left text-xs text-muted`}>
                  Opening balance, everything before {view.from}
                </th>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={view.openingCents} />
                </td>
              </tr>
              {view.postings.map((row) => (
                <tr key={`${row.line.bookingSeq.toString()}:${String(row.line.ordinal)}`}>
                  <td className={`${TD_CLASS} font-mono text-xs`}>
                    {row.line.valueDate}
                  </td>
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <span className="block max-w-prose">{row.line.description}</span>
                    {row.line.entryType === "original" ? null : (
                      <span className="mt-0.5 block text-xs text-muted">
                        {row.line.entryType}
                        {row.line.correctionGroupId === null
                          ? null
                          : ` · act ${row.line.correctionGroupId.slice(0, 8)}`}
                      </span>
                    )}
                  </th>
                  <td className={`${TD_CLASS} text-right font-mono text-xs text-muted`}>
                    {row.line.bookingSeq.toString()}
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={row.line.signedCents} tone="direction" signed />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={row.runningCents} />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="border-t-2 border-border-strong">
              <tr>
                <th scope="row" colSpan={4} className={`${TD_CLASS} text-left`}>
                  Closing at watermark{" "}
                  {view.point.snapshot.bookingWatermark.toString()}
                </th>
                <td className={`${TD_CLASS} text-right font-medium`}>
                  <Money cents={view.closingCents} />
                </td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* 7. Availability                                                            */
/* -------------------------------------------------------------------------- */

/**
 * All five terms, because "available is $X" is not an answer an operator can
 * check and "ledger $A less holds $B less uncleared $C less committed $D" is.
 *
 * This is `accountAvailability()` — THE definition — called with the travelled
 * snapshot. Its hold-release predicate is evaluated at `snapshot.asOf`, which
 * this feature sets to the instant asked about, so the hold terms are cut on
 * the same instant as the ledger term is cut on its sequence.
 */
function AvailabilityPanel({ view }: { readonly view: View }) {
  const a = view.availability;

  return (
    <Panel
      title="Available balance at that point, itemised"
      description="The same function the live screens call, with the travelled snapshot passed in. Holds are released against the instant you asked about, because a hold closure carries a timestamp and no booking sequence."
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            The five terms of available balance at the travelled point
          </caption>
          <tbody className="divide-y divide-border">
            <Term label="Settled ledger balance" cents={a.ledgerCents} />
            <Term label="less active holds" cents={-a.holdsCents} />
            <Term label="less uncleared credits" cents={-a.unclearedCents} />
            <Term label="less committed outflows" cents={-a.pendingOutboundCents} />
          </tbody>
          <tfoot className="border-t-2 border-border-strong">
            <tr>
              <th scope="row" className={`${TD_CLASS} text-left font-medium`}>
                Available
              </th>
              <td className={`${TD_CLASS} text-right font-medium`}>
                <Money cents={a.availableCents} />
              </td>
            </tr>
          </tfoot>
        </table>
      </TableScroll>
      {a.availableCents < 0n ? (
        <div className="border-t border-border px-5 py-4">
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            Negative, and not clamped. An over-capture settles above what was
            authorised, and hiding an overdraft behind a cosmetic floor loses
            money.
          </p>
        </div>
      ) : null}
    </Panel>
  );
}

function Term({ label, cents }: { readonly label: string; readonly cents: bigint }) {
  return (
    <tr>
      <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
        {label}
      </th>
      <td className={`${TD_CLASS} text-right`}>
        <Money cents={cents} tone="neutral" />
      </td>
    </tr>
  );
}
