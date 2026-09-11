import "server-only";

import Link from "next/link";

import { formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { ledgerConnection, mostActiveDepositAccountId } from "@/lib/ledger/queries";
import { CutNotice } from "@/components/timetravel/CutNotice";
import { TimeTravelBar } from "@/components/timetravel/TimeTravelBar";
import { correctionLandmarks } from "@/lib/timetravel/landmarks";
import { withTimeTravel } from "@/lib/timetravel/params";
import { resolveTimePoint } from "@/lib/timetravel/point";
import { foldClosing, readAccountAtPoint } from "@/lib/timetravel/read";
import { systemClock } from "@/lib/timetravel/clock";
import type { TimeTravelRequest } from "@/lib/timetravel/params";

/**
 * THE URL'S POINT, ON THE STATEMENTS SCREEN.
 *
 * ===========================================================================
 * WHAT THIS SCREEN HONOURS, AND THE PART THAT IS DELIBERATELY SEPARATE
 * ===========================================================================
 *
 * `?asOf=` is honoured COMPLETELY and without a panel: the page maps it onto
 * the screen's own `?day=` filter, because they are the same axis under two
 * names — which value date this document is about. The whole statements screen
 * then renders that day: both its readings, its corrections, its hashes, its
 * versions.
 *
 * `?asKnownAt=` is honoured HERE, in its own panel, and NOT by folding it into
 * the screen's existing anchor control. That is a deliberate choice and it is
 * about labelling.
 *
 * The statements screen already has a booking-axis control — `?as=` — with
 * exactly four positions: `published`, `close`, `before`, `now`. Each is a
 * MEANINGFUL watermark with a name a reader can check: the watermark a
 * document was issued against, the watermark a day was frozen at. The type is
 * closed and lives in `src/components/statements/data-contract.ts`, which
 * belongs to another worker.
 *
 * An arbitrary instant is not one of those four. Squeezing it in would mean
 * either mislabelling the left-hand column with an anchor name that is not
 * where it stands, or silently snapping the reader's instant to the nearest
 * anchor and answering a different question. Both are the false-label failure
 * this feature exists to avoid, and this build fails harder for a false label
 * than for a missing feature.
 *
 * So the arbitrary instant gets its own reading, stated with its own watermark
 * on its face, above a screen whose four anchors keep meaning exactly what
 * they say. Two controls, two honest labels, no overlap.
 */
export async function StatementTimeTravel({
  request,
  accountId,
  basePath,
  liveHref,
}: {
  readonly request: TimeTravelRequest;
  readonly accountId: string | null;
  readonly basePath: string;
  readonly liveHref: string;
}) {
  const conn = await ledgerConnection();
  const point = await resolveTimePoint(request, conn, systemClock);

  // The same selector the statements screen itself uses, with the same period,
  // so the account this panel reads and the account the screen below renders
  // cannot be different customers under one heading.
  const chosen =
    accountId ??
    (await mostActiveDepositAccountId(
      { periodStart: point.snapshot.valueDate, periodEnd: point.snapshot.valueDate },
      conn,
    ));

  if (chosen === null) {
    return (
      <Note title="No customer deposit account to read">
        A business gets its 2100 account when KYB approves it, and not before.
      </Note>
    );
  }

  const at = await readAccountAtPoint(
    { accountId: chosen, point, window: "day" },
    conn,
  );
  const landmarks = await correctionLandmarks({ accountId: chosen }, conn);

  const closing = foldClosing(at.period);
  const delta = at.closingNowCents - closing;

  return (
    <div className="space-y-6">
      <TimeTravelBar
        point={point}
        basePath={basePath}
        landmarks={landmarks}
        liveHref={liveHref}
      />

      <CutNotice point={point} />

      <Panel
        title={`${at.account.name} — ${point.snapshot.valueDate}, read at the point in the URL`}
        description="This panel answers ?asKnownAt= at an arbitrary instant. The four anchors on the screen below answer the same axis at the watermarks that have names — a published document, a frozen day — and keep their own labels."
        actions={
          delta === 0n ? (
            <Badge tone="quiet">no change</Badge>
          ) : (
            <Badge tone="neutral">the belief changed</Badge>
          )
        }
      >
        <div className="grid gap-px bg-border sm:grid-cols-[1fr_auto_1fr]">
          <div className="bg-surface px-5 py-4">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
              As believed at the URL&rsquo;s instant
            </p>
            <Money cents={closing} className="mt-1 block text-2xl font-semibold" />
            <p className="mt-1 font-mono text-[11px] text-muted">
              booking watermark {point.snapshot.bookingWatermark.toString()}
            </p>
            {point.requestedKnownAt === null ? null : (
              <p className="font-mono text-[11px] text-muted">
                {formatTimestamp(point.requestedKnownAt.toISOString())}
              </p>
            )}
          </div>

          <div className="flex flex-col items-center justify-center bg-surface px-5 py-4">
            <span className="text-[11px] uppercase tracking-[0.08em] text-muted">
              Difference
            </span>
            <Money
              cents={delta}
              tone="direction"
              signed
              className="mt-1 text-lg font-semibold"
            />
            <span className="mt-1 text-center text-[11px] text-muted">
              {at.pending.length === 0
                ? "the two queries agree"
                : `over ${String(at.pending.length)} later act${at.pending.length === 1 ? "" : "s"}`}
            </span>
          </div>

          <div className="bg-surface px-5 py-4">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
              <Link
                href={withTimeTravel(basePath, { asKnownAt: null })}
                className={`underline underline-offset-4 ${FOCUS_RING}`}
              >
                As corrected — everything we know
              </Link>
            </p>
            <Money
              cents={at.closingNowCents}
              className="mt-1 block text-2xl font-semibold"
            />
            <p className="mt-1 font-mono text-[11px] text-muted">
              booking watermark {point.liveWatermark.toString()}
            </p>
          </div>
        </div>

        {at.late.length === 0 ? (
          <div className="border-t border-border px-5 py-4">
            <p className="max-w-prose text-xs leading-relaxed text-muted">
              Nothing value-dated on or before{" "}
              <span className="font-mono">{point.snapshot.valueDate}</span> was
              booked above watermark{" "}
              <span className="font-mono">
                {point.snapshot.bookingWatermark.toString()}
              </span>
              , so the two readings are the same reading. Two genuinely
              different queries that agree — which is the common case.
            </p>
          </div>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Entries learned after the URL&rsquo;s instant that affect this
                value date
              </caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH_CLASS}>
                    What we learned since
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
                {at.late.map((entry) => (
                  <tr key={entry.entryId}>
                    <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                      <span className="block max-w-prose">{entry.description}</span>
                      <span className="mt-0.5 block text-xs text-muted">
                        {entry.entryType}
                      </span>
                    </th>
                    <td className={`${TD_CLASS} font-mono text-xs`}>
                      {entry.valueDate}
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
                    Σ — must equal the difference above
                  </th>
                  <td className={`${TD_CLASS} text-right font-medium`}>
                    <Money cents={at.lateNetCents} tone="direction" signed />
                  </td>
                </tr>
              </tfoot>
            </table>
          </TableScroll>
        )}

        {at.explained ? null : (
          <div className="border-t border-border px-5 py-4">
            <p className="max-w-prose text-xs leading-relaxed text-negative">
              These two figures must be equal and they are not. One of the two
              readers disagrees with the other about what is above this
              watermark. Nothing is repaired — the number is reported.
            </p>
          </div>
        )}

        <div className="border-t border-border px-5 py-4">
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            The document below is rendered for the same value date. Its
            left-hand column stands at one of four NAMED watermarks chosen by{" "}
            <span className="font-mono">?as=</span> — a published document, the
            close of the day, the moment before the last correction — which is a
            different and stronger question than an arbitrary instant, and it
            keeps its own label.{" "}
            <Link
              href={withTimeTravel(`/transactions?account=${chosen}`, {
                asOf: point.valuePinned ? point.snapshot.valueDate : null,
                asKnownAt: point.requestedKnownAt,
              })}
              className={`underline underline-offset-4 ${FOCUS_RING}`}
            >
              Open this point on /transactions
            </Link>{" "}
            for the postings behind it.
          </p>
        </div>
      </Panel>
    </div>
  );
}
