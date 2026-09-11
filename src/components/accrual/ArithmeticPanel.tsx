import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import type { DayRow } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

/**
 * One day's accrual, worked out on screen.
 *
 * This panel is the feature. The requirement it answers is
 *
 *   "Show the arithmetic on screen: rate, basis, days, the exact fraction, and
 *    where the residual landed. A number a customer cannot reproduce by hand is
 *    a number they will dispute."
 *
 * so it shows the division as a division and not as a result:
 *
 *     basis          $25.00 a month          ← the price, the only money input
 *     days           30                      ← September, from the calendar
 *     fraction       $25.00 ÷ 30
 *     base share     83¢                     ← 2500 div 30, floor
 *     left over      10¢                     ← 2500 mod 30
 *     this day       day 10 of 30 → carries one of the 10 → 84¢
 *     month to date  $8.40                   ← 83 × 10 + min(10, 10)
 *     still to come  $16.60                  ← and 840 + 1660 = 2500, exactly
 *
 * Every figure is a column on `accrual_posting` that migration 0020's CHECK
 * constraint re-derived with `accrual_daily_share()` before Postgres would
 * store the row. So this is not the screen's paraphrase of the calculation —
 * it is the operands the database checked.
 *
 * WHERE THE RESIDUAL LANDED is a first-class line rather than a footnote,
 * because it is the one figure a customer will phone about: two consecutive
 * days differ by a cent and nothing about the plan changed. The answer is that
 * a monthly price does not divide into days, someone has to carry the
 * remainder, and DESIGN §12.4 decided in advance that it is the earliest days —
 * so the month sums to the price exactly and nobody is a cent out at the end
 * of it.
 */
export function ArithmeticPanel({
  row,
  filter,
}: {
  readonly row: DayRow;
  readonly filter: AccrualFilter;
}) {
  const a = row.arithmetic;

  return (
    <Panel
      id="day"
      title={`${row.planName} · ${formatDate(row.accrualDate)}`}
      description={
        row.disposition === "posted"
          ? "Posted to the ledger at this value date — the day it accrued for, not the day the job ran."
          : row.disposition === "skipped"
            ? "Decided, with nothing posted: this day's share of the price is zero cents."
            : "Claimed and not yet decided. Nothing posted."
      }
      actions={
        <Link
          href={accrualHref(filter, { accrualDayId: null })}
          className={`rounded px-2 py-1 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
        >
          Close
        </Link>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <MetaList
          items={[
            { label: "business", value: row.businessName ?? "—" },
            {
              label: "idempotency key",
              value: <span className="font-mono text-[11px]">{row.idempotencyKey}</span>,
            },
            {
              label: "journal entry",
              value:
                row.entryId === null ? (
                  "—"
                ) : (
                  <span className="font-mono text-[11px]">{row.entryId}</span>
                ),
            },
            { label: "claimed", value: formatTimestamp(row.claimedAt) },
            {
              label: "decided",
              value: row.decidedAt === null ? "—" : formatTimestamp(row.decidedAt),
            },
            {
              label: "run",
              value: (
                <span className="font-mono text-[11px]">{row.decidedByRun ?? row.claimedBy}</span>
              ),
            },
          ]}
        />

        {a === null ? (
          <Note title="Claimed, not decided">
            <p>
              A tick took this day and did not finish. Nothing posted and no
              money moved. The next tick re-derives the same date from the
              calendar and the same key from the database, so re-running is the
              recovery.
            </p>
          </Note>
        ) : (
          <>
            <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
              <p className="text-xs font-semibold">The arithmetic, in full</p>

              <dl className="mt-3 grid max-w-lg gap-y-1.5 text-sm">
                <Line
                  label="Basis — the quoted price"
                  value={<Money cents={a.monthlyCents} tone="neutral" />}
                  note="a month, not a day. The only money input to the whole calculation."
                />
                <Line
                  label="Days in the month"
                  value={<span className="money">{a.daysInMonth}</span>}
                  note="from the calendar, not from a constant. February gets 28 or 29."
                />
                <Line
                  label="The exact fraction"
                  value={
                    <span className="money">
                      {a.monthlyCents}¢ ÷ {a.daysInMonth}
                    </span>
                  }
                  note="integer division on cents. Nothing here is ever a float."
                />
                <Line
                  label="Base share — every day gets this"
                  value={<span className="money">{a.baseShareCents}¢</span>}
                  note={`${a.monthlyCents} div ${a.daysInMonth}, floored`}
                />
                <Line
                  label="Left over — the residual"
                  value={<span className="money">{a.residualPennies}¢</span>}
                  note={`${a.monthlyCents} mod ${a.daysInMonth}. Pennies that will not divide, one for each of the first ${a.residualPennies} days.`}
                />

                <div className="my-1 border-t border-border" />

                <Line
                  label={`This day — day ${a.dayOfMonth} of ${a.daysInMonth}`}
                  value={
                    <span className="flex items-center gap-2">
                      <Money cents={a.amountCents} tone="neutral" />
                      {a.residualApplied ? (
                        <Badge tone="neutral" title="One of the residual pennies landed here">
                          + 1¢ RESIDUAL
                        </Badge>
                      ) : (
                        <Badge tone="quiet">base share only</Badge>
                      )}
                    </span>
                  }
                  note={
                    a.residualApplied
                      ? `day ${a.dayOfMonth} ≤ ${a.residualPennies}, so it carries one of the residual pennies`
                      : `day ${a.dayOfMonth} > ${a.residualPennies}, so it carries none`
                  }
                />

                <div className="my-1 border-t border-border" />

                <Line
                  label="Month to date, including today"
                  value={<Money cents={a.cumulativeCents} tone="neutral" />}
                  note={`${a.baseShareCents} × ${a.dayOfMonth} + min(${a.dayOfMonth}, ${a.residualPennies})`}
                />
                <Line
                  label="Still to come this month"
                  value={<Money cents={a.remainingCents} tone="neutral" />}
                  note={`and ${a.cumulativeCents} + ${a.remainingCents} = ${a.monthlyCents}, exactly`}
                />
              </dl>

              <p className="mt-4 max-w-prose border-t border-border pt-3 text-xs leading-relaxed">
                {a.explanation}
              </p>
            </div>

            {a.residualApplied ? (
              <Note title="Where the residual penny went, and why it is not an error">
                <p>
                  {a.monthlyCents}¢ does not divide by {a.daysInMonth}. Rounding
                  each day on its own — {a.baseShareCents}¢ every day — would
                  bill {a.baseShareCents * a.daysInMonth}¢ for a{" "}
                  {a.monthlyCents}¢ product and leave the customer{" "}
                  {a.residualPennies}¢ better off every month, which over a year
                  is a real number and a support ticket. So the month is
                  ALLOCATED rather than the days ROUNDED: the {a.residualPennies}{" "}
                  leftover pennies go one each to the first {a.residualPennies}{" "}
                  days, by ordinal ascending, which is the rule
                  research/ledger/DESIGN.md §12.4 already fixed for every other
                  allocation in this ledger. The month then sums to exactly{" "}
                  {a.monthlyCents}¢ — not within a penny, exactly — and{" "}
                  <code>v_accrual_month_drift</code> is the query that proves it.
                </p>
              </Note>
            ) : null}

            {row.disposition === "skipped" && row.skipReason !== null ? (
              <Note title="Nothing was posted for this day">
                <p>{row.skipReason}</p>
                <p className="mt-2">
                  <code>postEntry()</code> refuses a zero-amount line — it is
                  always an allocation bug — so a day whose share is genuinely
                  zero is recorded as a decided day with no entry rather than as
                  an entry that says nothing.
                </p>
              </Note>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

function Line({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly note: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-x-6">
      <dt className="text-sm">
        {label}
        <span className="mt-0.5 block text-[11px] leading-relaxed text-muted">{note}</span>
      </dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}
