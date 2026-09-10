import { formatCountdown, formatTimeOfDay } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import { Badge, FieldLabel, Note, TableScroll } from "@/components/ui/primitives";

import type { AccountSummary, Hold } from "./data-contract";
import { reconcileBalances } from "./derive";

/**
 * The screen's argument, rendered.
 *
 * Two balances side by side, then the arithmetic that connects them. A viewer
 * who has never heard of a memo book should be able to read this block and
 * understand why the two numbers differ, without anyone standing next to them
 * explaining it — which is why the deductions are itemised rather than
 * summarised, and why each one carries the reason it exists.
 */
export function BalanceHeadline({
  summary,
  holds,
  authPending,
}: {
  readonly summary: AccountSummary;
  readonly holds: readonly Hold[];
  readonly authPending: boolean;
}) {
  const reconciliation = reconcileBalances(summary);
  const withheldCents = summary.activeHoldsCents + summary.unclearedCreditsCents;

  const activeHoldCount = holds.filter(
    (hold) => hold.kind !== "uncleared_credit" && hold.remainingCents > 0,
  ).length;
  const unclearedCount = holds.filter(
    (hold) => hold.kind === "uncleared_credit" && hold.remainingCents > 0,
  ).length;

  const nextRelease = holds
    .flatMap((hold) =>
      hold.remainingCents > 0 && hold.availableAt !== null ? [hold.availableAt] : [],
    )
    .sort()[0];

  const holdsSummary =
    activeHoldCount === 0
      ? "none active"
      : `${activeHoldCount} hold${activeHoldCount === 1 ? "" : "s"}`;

  const unclearedSummary =
    unclearedCount === 0
      ? "none pending"
      : nextRelease === undefined
        ? `${unclearedCount} pending`
        : `${unclearedCount} pending · releases ${formatTimeOfDay(nextRelease)}, ${formatCountdown(nextRelease, summary.asOf)}`;

  return (
    <section
      aria-labelledby="balances-title"
      className="rounded-lg border border-border bg-surface"
    >
      <h2 id="balances-title" className="sr-only">
        Balances
      </h2>

      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
        <div className="px-5 py-5">
          <FieldLabel>Ledger balance</FieldLabel>
          <p className="mt-2">
            <Money cents={summary.ledgerCents} className="text-3xl font-semibold" />
          </p>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            Settled postings only, value date on or before today. A card
            authorisation never moves this number.
          </p>
          {authPending ? (
            <p className="mt-2">
              <Badge tone="quiet" title="An authorisation is a memo posting. It has no financial entry.">
                unchanged by the authorisation
              </Badge>
            </p>
          ) : null}
        </div>

        <div className="px-5 py-5">
          <FieldLabel>Available balance</FieldLabel>
          <p className="mt-2">
            <Money
              cents={summary.availableCents}
              className="text-3xl font-semibold"
            />
          </p>
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
            What the business can spend right now: the ledger balance minus
            everything currently withheld.
          </p>
          {authPending ? (
            <p className="mt-2">
              <Badge tone="negative" title="SHELL OIL 1247 · pump 4">
                <span aria-hidden="true">−$50.00</span>
                <span className="sr-only">down 50 dollars</span>
                <span className="ml-1 font-normal">
                  · SHELL OIL 1247 authorisation
                </span>
              </Badge>
            </p>
          ) : null}
        </div>
      </div>

      <div className="border-t border-border px-5 py-4">
        <p className="text-xs text-muted">
          {withheldCents === 0 ? (
            <>
              Nothing is being withheld — the two balances agree. Every posting
              on this account has settled and no authorisation is open.
            </>
          ) : (
            <>
              <Money cents={withheldCents} className="font-medium" /> of the
              ledger balance is not spendable. Here is exactly where it is:
            </>
          )}
        </p>

        <TableScroll>
          <table className="mt-3 w-full text-sm">
            <caption className="sr-only">
              How the available balance is derived from the ledger balance
            </caption>
            <thead>
              <tr>
                <th scope="col" className="sr-only">
                  Operator
                </th>
                <th scope="col" className="sr-only">
                  Component
                </th>
                <th scope="col" className="sr-only">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {reconciliation.lines.map((line) => {
                const isResult = line.operator === "=";
                return (
                  <tr
                    key={line.key}
                    className={isResult ? "border-t border-border-strong" : ""}
                  >
                    <td
                      aria-hidden="true"
                      className="w-6 py-1.5 pr-2 text-right align-top font-mono text-xs text-muted"
                    >
                      {line.operator === "+" ? "" : line.operator}
                    </td>
                    <th
                      scope="row"
                      className={`py-1.5 pr-4 text-left text-xs font-normal ${
                        isResult ? "font-medium text-text" : "text-text"
                      }`}
                    >
                      <span className={isResult ? "font-medium" : ""}>
                        {line.operator === "−" ? "less " : ""}
                        {line.label}
                      </span>
                      {line.key === "holds" ? (
                        <span className="ml-2 text-muted">({holdsSummary})</span>
                      ) : null}
                      {line.key === "uncleared" ? (
                        <span className="ml-2 text-muted">({unclearedSummary})</span>
                      ) : null}
                      <span className="mt-0.5 block max-w-prose text-[11px] leading-relaxed text-muted">
                        {line.hint}
                      </span>
                    </th>
                    <td className="py-1.5 text-right align-top">
                      <Money
                        cents={line.cents}
                        tone={isResult ? "auto" : "neutral"}
                        className={isResult ? "font-semibold" : ""}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>

        {reconciliation.reconciles ? null : (
          <div className="mt-4">
            <Note emphasis title="These balances do not reconcile">
              The ledger reports an available balance that is{" "}
              <Money cents={reconciliation.driftCents} signed /> away from{" "}
              <Money cents={reconciliation.derivedAvailableCents} /> — the value
              implied by its own holds. That is a ledger defect, not a display
              rounding issue, and it is shown rather than hidden because an
              operator acting on the wrong number is worse than an operator
              seeing a warning.
            </Note>
          </div>
        )}
      </div>
    </section>
  );
}
