import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import type { InterestDayRow } from "./data-contract";
import { accrualHref, type AccrualFilter } from "./view-state";

/**
 * One day's interest, worked out on screen.
 *
 * The requirement, verbatim: *"Show the arithmetic: balance, rate, day-count
 * convention, the exact fraction, and where any residual landed. A customer
 * who cannot reproduce the number by hand will dispute it."* So this panel
 * shows the division as a division:
 *
 *     balance        $2,003.16      ← settled ledger, end of the business date
 *     watermark      2253           ← what we had LEARNED when we priced it
 *     rate           125 bps        ← the card effective on THAT date
 *     day count      ACT/365 fixed
 *     fraction       200316 × 125 ÷ (10000 × 365) = 25039500 ÷ 3650000
 *     whole cents    6
 *     remainder      3139500 / 3650000 of a cent
 *     rounding       2 × 3139500 = 6279000 > 3650000, so up → 7¢
 *
 * WHERE THE RESIDUAL WENT is a first-class line here as it is on the fee
 * panel, and the answer is different — which is the point. The fee's residual
 * penny is REAL MONEY that must land on a day, because §12.3's shares have to
 * sum to the month's price. Interest has no total to sum to, so §12.2 leaves
 * no residual to place: the sub-cent fraction was never money, nobody was
 * credited with it, and the entry is two equal and opposite lines. The panel
 * says that out loud, because the obvious question after reading "3139500 left
 * over" is "so who got it", and the honest answer is "nobody, and here is why
 * that is not the same as losing it".
 */
export function InterestArithmeticPanel({
  row,
  filter,
}: {
  readonly row: InterestDayRow;
  readonly filter: AccrualFilter;
}) {
  const a = row.arithmetic;
  const paying = a?.side === "credit";

  return (
    <Panel
      id="interest-day"
      title={`Interest · ${row.businessName ?? row.accountId} · ${formatDate(row.accrualDate)}`}
      description={
        row.disposition === "posted"
          ? paying
            ? "Paid to the customer and posted at this value date — the day it accrued for, not the day the job ran."
            : "Charged to the customer and posted at this value date — the day it accrued for, not the day the job ran."
          : row.disposition === "skipped"
            ? "Decided, with nothing posted: this day priced at zero cents."
            : "Claimed and not yet decided. Nothing posted."
      }
      actions={
        <Link
          href={accrualHref(filter, { interestDayId: null })}
          className={`rounded px-2 py-1 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
        >
          Close
        </Link>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <MetaList
          items={[
            { label: "rate card", value: row.rateTier },
            {
              label: "card effective from",
              value:
                row.policyEffectiveFrom === null ? "—" : formatDate(row.policyEffectiveFrom),
            },
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

              <dl className="mt-3 grid max-w-xl gap-y-1.5 text-sm">
                <Line
                  label="Basis — the balance this day was priced on"
                  value={<Money cents={a.basisBalanceCents} tone="auto" />}
                  note="the SETTLED ledger balance at the end of this business date, from ledger_settled_cents() — not the available balance, because a hold is money the customer still has and we still owe."
                />
                <Line
                  label="Booking watermark it was true at"
                  value={
                    <span className="money">{row.observedBookingSeq ?? "—"}</span>
                  }
                  note="what we had LEARNED when we priced it. Without this the figure is not reproducible: a later correction changes what the settled balance of a past value date is."
                />
                <Line
                  label="Rate — for this side, on this date"
                  value={<span className="money">{a.rateBps} bps</span>}
                  note={
                    paying
                      ? "what we pay on a credit balance, from the rate card effective on the ACCRUAL date"
                      : a.side === "overdraft"
                        ? "what we charge on an overdrawn balance, from the rate card effective on the ACCRUAL date"
                        : "a balance of exactly zero has no side and is priced at nothing"
                  }
                />
                <Line
                  label="Day-count convention"
                  value={<span className="money">ACT/{a.dayCount}</span>}
                  note={
                    a.dayCount === 365
                      ? "ACT/365 FIXED — the US deposit convention. Reg DD Appendix A computes the daily periodic rate as the annual rate over 365; ACT/360 would pay and charge 1.389% more a year for the same quoted rate."
                      : "ACT/360 — the money-market convention. 1.389% more a year than /365 for the same quoted rate."
                  }
                />

                <div className="my-1 border-t border-border" />

                <Line
                  label="The exact fraction"
                  value={
                    <span className="money">
                      {a.numerator} ÷ {a.denominator}
                    </span>
                  }
                  note={`|${a.basisBalanceCents}| × ${a.rateBps} ÷ (10000 × ${a.dayCount}). Integer arithmetic on the MAGNITUDE; the sign picks the account, so the rounding is symmetric between the two sides.`}
                />
                <Line
                  label="Whole cents"
                  value={<span className="money">{a.wholeCents}¢</span>}
                  note={`${a.numerator} div ${a.denominator}, floored`}
                />
                <Line
                  label="Left over — the sub-cent fraction"
                  value={
                    <span className="money">
                      {a.remainderUnits} / {a.denominator}
                    </span>
                  }
                  note={`${a.numerator} mod ${a.denominator}. This never existed as money; see the note below.`}
                />

                <div className="my-1 border-t border-border" />

                <Line
                  label="The rounding decision (DESIGN §12.2)"
                  value={
                    <span className="flex items-center gap-2">
                      <span className="money">{a.amountCents}¢</span>
                      <RoundingBadge rounding={a.rounding} />
                    </span>
                  }
                  note={roundingNote(a)}
                />
                <Line
                  label="Effect on the customer's balance"
                  value={<Money cents={a.customerEffectCents} tone="direction" signed />}
                  note={
                    paying
                      ? "a CREDIT to their deposit account (we owe them more) and a debit to 5400 Interest expense — credit balances"
                      : a.side === "overdraft"
                        ? "a DEBIT to their deposit account (we owe them less) and a credit to 4400 Interest income — overdraft"
                        : "nothing posted"
                  }
                />
              </dl>

              <p className="mt-4 max-w-prose border-t border-border pt-3 text-xs leading-relaxed">
                {a.explanation}
              </p>
            </div>

            <Note title="Where the fraction went, and why nobody eats a penny here">
              <p>
                The fee panel on this screen has a residual penny with an
                address. This one does not, and the difference is which clause
                of <code>research/ledger/DESIGN.md</code> §12 applies.
              </p>
              <p className="mt-2">
                §12.3 — largest remainder — is for ONE AMOUNT SPLIT ACROSS N
                SHARES. It leaves a real penny that must land on one of the
                shares, because the shares have to sum back to the source
                exactly. A monthly fee across the days of its month is that.
              </p>
              <p className="mt-2">
                Daily interest is §12.2 — ONE VALUE TO ONE CENT AMOUNT — and
                §12.3 is not merely worse here, it is <em>undefined</em>: there
                is no source amount to distribute, because the month&apos;s
                interest is not a known number until the month has happened and
                the balance changes every day. So the{" "}
                <span className="money">
                  {a.remainderUnits}/{a.denominator}
                </span>{" "}
                of a cent above is not a residual anyone has to eat. It never
                existed as money, no party was credited with it, and the entry
                is two equal and opposite lines summing to zero. That is also
                why §12.6&apos;s dust account <code>2900</code> is not engaged:
                2900 exists for dust that arrived as a real external amount —
                a USDC transfer with six decimals — where truncating would break
                the identity between customer balances and our obligation.
              </p>
              <p className="mt-2">
                The bound is half a cent per account per day and it is unbiased
                by construction, which is the whole reason §12.2 says half to
                EVEN rather than half up: half-up would hand every exact
                half-cent to the same party, forever — to us on an overdraft, to
                the customer on a credit balance.
              </p>
            </Note>

            {row.disposition === "skipped" && row.skipReason !== null ? (
              <Note title="Nothing was posted for this day">
                <p>{row.skipReason}</p>
                <p className="mt-2">
                  <code>postEntry()</code> refuses a zero-amount line — it is
                  always an allocation bug — so a day that prices at zero is
                  recorded as a decided day with no entry rather than as an
                  entry that says nothing, or as a missing row.
                </p>
              </Note>
            ) : null}
          </>
        )}
      </div>
    </Panel>
  );
}

function roundingNote(a: {
  readonly rounding: "exact" | "down" | "up" | "tie_to_even";
  readonly remainderUnits: number;
  readonly denominator: number;
  readonly wholeCents: number;
  readonly amountCents: number;
}): string {
  const twice = a.remainderUnits * 2;
  switch (a.rounding) {
    case "exact":
      return `${a.remainderUnits} left over, so it divided exactly and there was nothing to round.`;
    case "up":
      return `2 × ${a.remainderUnits} = ${twice}, which is MORE than ${a.denominator}, so the fraction is past half a cent and rounds up.`;
    case "down":
      return `2 × ${a.remainderUnits} = ${twice}, which is LESS than ${a.denominator}, so the fraction is short of half a cent and rounds down.`;
    case "tie_to_even":
      return `2 × ${a.remainderUnits} = ${a.denominator} exactly — the fraction is precisely half a cent. §12.2 breaks that tie to the EVEN cent: ${a.wholeCents} is ${a.wholeCents % 2 === 0 ? `even, so it stays at ${a.amountCents}` : `odd, so it goes up to ${a.amountCents}`}. Half-up would have said ${a.wholeCents + 1} every time.`;
  }
}

function RoundingBadge({
  rounding,
}: {
  readonly rounding: "exact" | "down" | "up" | "tie_to_even";
}) {
  if (rounding === "tie_to_even") return <Badge tone="neutral">TIE → EVEN</Badge>;
  if (rounding === "up") return <Badge tone="neutral">ROUNDED UP</Badge>;
  if (rounding === "down") return <Badge tone="quiet">ROUNDED DOWN</Badge>;
  return <Badge tone="quiet">EXACT</Badge>;
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
