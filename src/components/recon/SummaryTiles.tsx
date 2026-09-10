import { Money } from "@/components/ui/Money";
import { FieldLabel } from "@/components/ui/primitives";

import type { BreakRow, RunRow } from "./data-contract";

/**
 * The four numbers at the top of the screen.
 *
 * Counted over the WHOLE run, never over the filtered table — a tile that
 * changed when somebody clicked a filter chip would make "how bad is tonight"
 * unanswerable without clearing the filters first, which is the opposite of
 * what a summary is for.
 *
 * The net figure is signed and it is deliberately not an absolute value. A
 * night whose breaks cancel to zero is a different fact from a night with no
 * breaks, and reading `$0.00` beside "4 breaks" is exactly the prompt an
 * operator needs to go and look.
 */
export function SummaryTiles({
  run,
  breaks,
}: {
  readonly run: RunRow;
  readonly breaks: readonly BreakRow[];
}) {
  const net = breaks.reduce((acc, b) => acc + b.breakAmountCents, 0);
  const unexplained = breaks.filter((b) => b.explainedBy === null).length;
  const worst = breaks.filter(
    (b) => b.severity === "stale" || b.severity === "critical",
  ).length;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      <Tile
        label="Matched"
        value={`${run.matchedCount} / ${run.fileRowCount}`}
        note={
          run.rejectedRows === 0
            ? "file rows paired by reference"
            : `${run.rejectedRows} line${run.rejectedRows === 1 ? "" : "s"} could not be read`
        }
      />
      <Tile
        label="Breaks"
        value={String(breaks.length)}
        note={
          breaks.length === 0
            ? "the file and the book agree"
            : unexplained === breaks.length
              ? "none of them answered yet"
              : `${unexplained} still unanswered`
        }
      />
      <Tile
        label="Net difference"
        value={<Money cents={net} tone="direction" signed />}
        note="signed, on the file's own axis"
      />
      <Tile
        label="Past a close"
        value={String(worst)}
        note={
          worst === 0
            ? "nothing has survived two closes"
            : "open across two or more day closes"
        }
      />
    </div>
  );
}

function Tile({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly note: string;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <FieldLabel>{label}</FieldLabel>
      <p className="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}
