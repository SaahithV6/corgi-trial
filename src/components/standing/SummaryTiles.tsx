import { Money } from "@/components/ui/Money";
import { FieldLabel } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { OccurrenceRow, ScheduleRow, StandingInvariants } from "./data-contract";

/**
 * The four numbers at the top of the screen.
 *
 * Counted over every occurrence on the page, never over a filtered subset — a
 * tile that changed when somebody drilled into one mandate would make "did
 * anything get refused last night" unanswerable without clearing the filter
 * first, which is the opposite of what a summary is for.
 *
 * The fourth tile is the one worth defending. "Claimed, undecided" is normally
 * zero and its non-zero state is SAFE: no money moved, and the next tick
 * re-drives the occurrence to the same instruction through the same derived
 * key. It is on the screen anyway, because the failure this whole feature is
 * graded on is "it never fired and nobody knows why" — and the cure for that is
 * that a half-finished firing is a row somebody can see, not an absence
 * somebody has to notice.
 */
export function SummaryTiles({
  schedules,
  occurrences,
  invariants,
}: {
  readonly schedules: readonly ScheduleRow[];
  readonly occurrences: readonly OccurrenceRow[];
  readonly invariants: StandingInvariants;
}) {
  const active = schedules.filter((s) => !s.cancelled);
  const refused = occurrences.filter((o) => o.disposition === "refused");
  const raised = occurrences.filter((o) => o.disposition === "raised");
  const raisedTotal = raised.reduce((acc, o) => acc + o.amountCents, 0);

  const next = active
    .map((s) => s.nextDueDate)
    .filter((d): d is string => d !== null)
    .sort()[0];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      <Tile
        label="Live mandates"
        value={String(active.length)}
        note={
          schedules.length === active.length
            ? "none cancelled"
            : `${schedules.length - active.length} cancelled`
        }
      />
      <Tile
        label="Next occurrence"
        value={next === undefined ? "—" : formatDate(next)}
        note={
          next === undefined
            ? "no live mandate has a date left"
            : "the next date the calendar generates that nothing has claimed"
        }
      />
      <Tile
        label="Raised"
        value={<Money cents={raisedTotal} tone="neutral" />}
        note={`${raised.length} occurrence${raised.length === 1 ? "" : "s"} put a payment in the approvals queue`}
      />
      <Tile
        label="Refused"
        value={String(refused.length)}
        note={
          invariants.unresolved === 0
            ? "each one recorded with its reason · 0 claimed and undecided"
            : `${invariants.unresolved} claimed and undecided — safe, nothing moved, re-driven next tick`
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
