import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  FieldLabel,
  MetaList,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { BREAK_KIND_LABELS, REASON_CODE_LABELS } from "@/lib/recon/types";

import type { BreakDetail, EntryView } from "./data-contract";
import { breakHref, type BreakFilter } from "./view-state";

const ENTRY_TYPE_LABEL: Record<EntryView["entryType"], string> = {
  original: "Original",
  reversal: "Reversal",
  rebook: "Re-book",
};

/**
 * Drill-through: from a break to the thing that produced it.
 *
 * A break is one of two shapes, and this panel shows whichever sides exist:
 * the file row exactly as it arrived, and the journal entry — or rather the
 * whole CORRECTION GROUP, oldest first.
 *
 * The group is the point, and it is what makes the edge state legible. A
 * single entry answers "what did we book". The group answers "and what did we
 * do about it", so a reversal-plus-rebook reads as a correction with a
 * timeline instead of three unrelated postings that happen to share a
 * reference. `CorrectionNote` puts the arithmetic on screen — booked, reversed,
 * re-booked, net — because an operator should be able to check it rather than
 * be told the answer.
 */
export function BreakDetailPanel({
  detail,
  filter,
}: {
  readonly detail: BreakDetail;
  readonly filter: BreakFilter;
}) {
  const { row, fileRow, correctionGroup, notes } = detail;

  return (
    <Panel
      id="break-detail"
      title={`${BREAK_KIND_LABELS[row.kind]} · ${row.externalRef}`}
      description={REASON_CODE_LABELS[row.reasonCode]}
      actions={
        <Link
          href={breakHref(filter, { selected: null })}
          className={`rounded px-2 py-1 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
        >
          Close
        </Link>
      }
    >
      <div className="space-y-6 px-5 py-5">
        <MetaList
          items={[
            { label: "value date", value: formatDate(row.valueDate) },
            { label: "age", value: `${row.ageDays} business day${row.ageDays === 1 ? "" : "s"}` },
            {
              label: "day closes crossed",
              value: String(row.closesCrossed),
            },
            { label: "rail", value: `${row.provider} · ${row.rail}` },
          ]}
        />

        <p className="max-w-prose text-xs leading-relaxed text-muted">
          {row.severityReason}
        </p>

        {row.explainedBy === "reversal_and_rebook" ? (
          <CorrectionNote detail={detail} />
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <FileSide detail={detail} />
          <LedgerSide detail={detail} />
        </div>

        {correctionGroup.length > 0 ? (
          <CorrectionGroupTable entries={correctionGroup} matchedEntryId={row.entryId} />
        ) : null}

        {fileRow === null ? null : (
          <section aria-labelledby="raw-row-title">
            <h3 id="raw-row-title" className="text-xs font-semibold">
              The row as it arrived
            </h3>
            <p className="mt-1 max-w-prose text-[11px] text-muted">
              Stored verbatim in <code>scheme_file_row.raw</code> and never
              re-encoded, so what the provider sent is still readable after
              anybody&rsquo;s interpretation of it turns out to be wrong.
            </p>
            <pre className="mt-2 overflow-x-auto rounded border border-border bg-surface-raised px-3 py-2 text-[11px] leading-relaxed">
              {JSON.stringify(fileRow.raw, null, 2)}
            </pre>
          </section>
        )}

        {notes.length === 0 ? null : <Adjudication notes={notes} />}
      </div>
    </Panel>
  );
}

/**
 * The edge state, spelled out.
 *
 * Rendered only when the correction group nets to the file's own amount, which
 * is the condition `v_recon_break` computes. The wording is careful on the one
 * point that matters: the break is REAL — we booked the wrong number and a run
 * recorded it — and it is ANSWERED. Neither fact cancels the other, and the
 * screen must not let it look like the mismatch never happened.
 */
function CorrectionNote({ detail }: { readonly detail: BreakDetail }) {
  const { row } = detail;
  const original = detail.correctionGroup.find((e) => e.entryType === "original");
  const rebook = detail.correctionGroup.find((e) => e.entryType === "rebook");

  return (
    <Note title="Real, and already answered — reversal plus re-book">
      <p>
        We booked <Money cents={row.ledgerAmountCents ?? 0} /> against this
        reference; the provider&rsquo;s file settled{" "}
        <Money cents={row.fileAmountCents ?? 0} />. That mismatch happened, and
        the run that found it recorded it — the snapshot in{" "}
        <code>recon_run_break</code> is immutable and still says so.
      </p>
      <p className="mt-2">
        It was then corrected the only way a ledger may be corrected: the
        original entry was <strong>reversed</strong> at its own value date and{" "}
        <strong>re-booked</strong> at the settled amount. Nothing was edited.
        The correction group now nets to{" "}
        <Money cents={row.ledgerNetCents ?? 0} />, which is exactly what the
        file said, so there is nothing left to chase.
      </p>
      <p className="mt-2 text-[11px]">
        {original === undefined ? null : (
          <>
            Booked at seq {original.bookingSeq}
            {rebook === undefined ? null : <>, re-booked at seq {rebook.bookingSeq}</>}
            . The break stays on this screen with a severity of{" "}
            <strong>explained</strong> rather than disappearing, because a
            resolved break keeps its history.
          </>
        )}
      </p>
    </Note>
  );
}

function FileSide({ detail }: { readonly detail: BreakDetail }) {
  const { fileRow, row } = detail;

  return (
    <section aria-labelledby="file-side-title" className="space-y-2">
      <h3 id="file-side-title" className="text-xs font-semibold">
        The provider&rsquo;s file
      </h3>
      {fileRow === null ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          This reference is not in the file at all. That is the break: we booked
          it and the provider does not carry it — a duplicate posting, a timing
          difference across the file cutoff, or a row that was dropped between
          two versions of the file.
        </p>
      ) : (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-xs">
          <Field label="row">#{fileRow.rowNo}</Field>
          <Field label="amount">
            <Money cents={fileRow.amountCents} tone="neutral" />
          </Field>
          <Field label="value date">{formatDate(fileRow.valueDate)}</Field>
          <Field label="file">{fileRow.filename}</Field>
          <Field label="sha256">
            <span className="font-mono text-[10px] break-all">
              {fileRow.fileSha256}
            </span>
          </Field>
          <Field label="imported">{formatTimestamp(fileRow.importedAt)}</Field>
        </dl>
      )}
      <p className="text-[11px] text-muted">
        Break amount on the file&rsquo;s axis:{" "}
        <Money cents={row.breakAmountCents} tone="direction" signed />
      </p>
    </section>
  );
}

function LedgerSide({ detail }: { readonly detail: BreakDetail }) {
  const { correctionGroup, row } = detail;

  return (
    <section aria-labelledby="ledger-side-title" className="space-y-2">
      <h3 id="ledger-side-title" className="text-xs font-semibold">
        The book
      </h3>
      {correctionGroup.length === 0 ? (
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          No journal entry carries this reference on{" "}
          {row.rail.toUpperCase()} for {formatDate(row.businessDate)}. Either a
          webhook never arrived, one arrived and failed processing, or this is a
          force post nobody has booked yet.
        </p>
      ) : (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-xs">
          <Field label="booked">
            <Money cents={row.ledgerAmountCents ?? 0} tone="neutral" />
          </Field>
          {row.ledgerNetCents === row.ledgerAmountCents ? null : (
            <Field label="net now">
              <Money cents={row.ledgerNetCents ?? 0} tone="neutral" />
            </Field>
          )}
          <Field label="entries">
            {correctionGroup.length} in the correction group
          </Field>
          <Field label="entry id">
            <span className="font-mono text-[10px] break-all">{row.entryId}</span>
          </Field>
        </dl>
      )}
    </section>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <>
      <dt className="text-muted">
        <FieldLabel>{label}</FieldLabel>
      </dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * Every entry that shares the break's correction group, oldest first.
 *
 * The rail-facing leg is badged, because that single line is what
 * reconciliation compares against — and an operator looking at four lines
 * should not have to remember which of 1130 and 2100 is the one the file is
 * talking about.
 */
function CorrectionGroupTable({
  entries,
  matchedEntryId,
}: {
  readonly entries: readonly EntryView[];
  readonly matchedEntryId: string | null;
}) {
  return (
    <section aria-labelledby="group-title">
      <h3 id="group-title" className="text-xs font-semibold">
        The journal entry, and its correction group
      </h3>
      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
        Oldest first. A reversal carries the ORIGINAL&rsquo;s value date and its
        own booking position, which is what lets the corrected day be right
        without rewriting what we believed on the day we booked it.
      </p>

      <TableScroll>
        <table className="mt-2 w-full border-collapse text-xs">
          <caption className="sr-only">
            Journal entries in this break&rsquo;s correction group
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Seq
              </th>
              <th scope="col" className={TH_CLASS}>
                Type
              </th>
              <th scope="col" className={TH_CLASS}>
                Booked
              </th>
              <th scope="col" className={TH_CLASS}>
                Lines
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {entries.map((entry) => (
              <tr key={entry.entryId}>
                <th scope="row" className={`${TD_CLASS} text-left font-normal tabular-nums`}>
                  {entry.bookingSeq}
                  {entry.entryId === matchedEntryId ? (
                    <span className="mt-1 block">
                      <Badge tone="neutral">matched</Badge>
                    </span>
                  ) : null}
                </th>
                <td className={TD_CLASS}>
                  {ENTRY_TYPE_LABEL[entry.entryType]}
                  <span className="mt-0.5 block max-w-xs text-muted">
                    {entry.description}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  {formatTimestamp(entry.bookingTime)}
                  <span className="mt-0.5 block text-muted">
                    value {formatDate(entry.valueDate)}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  <ul className="space-y-1">
                    {entry.lines.map((line) => (
                      <li
                        key={line.ordinal}
                        className="flex items-baseline justify-between gap-4"
                      >
                        <span>
                          <span className="font-mono">{line.accountCode}</span>{" "}
                          <span className="text-muted">{line.accountName}</span>
                          {line.railControl === null ? null : (
                            <span className="ml-1.5">
                              <Badge tone="neutral" title="the leg reconciliation compares">
                                {line.railControl} control
                              </Badge>
                            </span>
                          )}
                        </span>
                        <Money cents={line.amountCents} tone="direction" signed />
                      </li>
                    ))}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </section>
  );
}

function Adjudication({
  notes,
}: {
  readonly notes: BreakDetail["notes"];
}) {
  return (
    <section aria-labelledby="notes-title">
      <h3 id="notes-title" className="text-xs font-semibold">
        Adjudication
      </h3>
      <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
        Append-only. A resolved break keeps its history instead of disappearing
        from this screen.
      </p>
      <ol className="mt-2 space-y-2">
        {notes.map((note) => (
          <li
            key={`${note.createdAt}:${note.note}`}
            className="rounded border border-border bg-surface-raised px-3 py-2 text-xs"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{note.createdBy}</span>
              <span className="text-[11px] text-muted">
                {formatTimestamp(note.createdAt)}
              </span>
            </div>
            <p className="mt-1 max-w-prose leading-relaxed text-muted">{note.note}</p>
            {note.resolution === null ? null : (
              <span className="mt-1.5 inline-flex">
                <Badge tone="quiet">{note.resolution.replaceAll("_", " ")}</Badge>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
