import { Money } from "@/components/ui/Money";
import { FieldLabel } from "@/components/ui/primitives";

import type { AccrualInvariants, DayRow, MonthRow, ScheduleRow } from "./data-contract";

/**
 * The four numbers at the top of the screen.
 *
 * Counted over every day on the page, never over a filtered subset — a tile
 * that changed when somebody drilled into one plan would make "how much did we
 * bill this month" unanswerable without clearing the filter first, which is the
 * opposite of what a summary is for.
 *
 * The third and fourth tiles are the ones worth defending.
 *
 * RESIDUAL PENNIES is not a rounding ERROR count. It is the number of days on
 * which a leftover penny was deliberately placed, and it is on the screen
 * because the alternative — a number that silently changes by a cent partway
 * through a month — is the shape of a support ticket. Placing them is the
 * feature; hiding them would be the bug.
 *
 * EXACTNESS is `v_accrual_month_drift` and `v_accrual_ledger_drift`, both of
 * which must be zero forever. They are on a screen rather than only in a test
 * because a test proves a thing once and a screen proves it while somebody is
 * watching.
 */
export function SummaryTiles({
  schedules,
  days,
  months,
  invariants,
}: {
  readonly schedules: readonly ScheduleRow[];
  readonly days: readonly DayRow[];
  readonly months: readonly MonthRow[];
  readonly invariants: AccrualInvariants;
}) {
  const posted = days.filter((d) => d.disposition === "posted");
  const accrued = posted.reduce((acc, d) => acc + (d.arithmetic?.amountCents ?? 0), 0);
  const withResidual = posted.filter((d) => d.arithmetic?.residualApplied === true).length;
  const clean = invariants.monthDrift === 0 && invariants.ledgerDrift === 0;
  const openMonths = months.filter((m) => !m.monthComplete).length;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      <Tile
        label="Enrolled accounts"
        value={String(schedules.length)}
        note={
          schedules.length === 0
            ? "nobody is being charged a daily-accrued fee"
            : `${openMonths} month${openMonths === 1 ? "" : "s"} still accruing`
        }
      />
      <Tile
        label="Accrued on screen"
        value={<Money cents={accrued} tone="neutral" />}
        note={`${posted.length} day${posted.length === 1 ? "" : "s"} posted to the ledger, each at the date it accrued for`}
      />
      <Tile
        label="Residual pennies placed"
        value={String(withResidual)}
        note="days that carried a leftover penny so the month sums to the price exactly"
      />
      <Tile
        label="Exactness"
        value={clean ? "EXACT" : `${invariants.monthDrift + invariants.ledgerDrift} DRIFT`}
        note={
          clean
            ? invariants.unresolved === 0
              ? "no closed month is a cent out · 0 claimed and undecided"
              : `no closed month is a cent out · ${invariants.unresolved} claimed and undecided`
            : "a closed month does not sum to its price, or a posting disagrees with its entry"
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
      <p className="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}
