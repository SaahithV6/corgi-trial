import { Money } from "@/components/ui/Money";
import { Note, Panel, TableScroll, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";

import type { ClientMandate, ClientStandingScreen } from "@/app/(app)/client/standing-orders/reader";

import { CreateRecurringPaymentForm, StopRecurringPaymentForm } from "./MandateForms";

/**
 * `/client/standing-orders` — the customer's own recurring payments.
 *
 * Reads only. Rendering this page writes nothing, claims nothing and fires
 * nothing: the only two writes on the screen are server actions behind buttons
 * a person presses. That is not a style choice — `StandingView.tsx` puts it
 * plainly, a page that raised a payment because somebody hit reload would be
 * the worst bug in this repository, and it stays true here.
 */

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function ordinal(day: number): string {
  const rest = day % 100;
  if (rest >= 11 && rest <= 13) return `${day}th`;
  switch (day % 10) {
    case 1:
      return `${day}st`;
    case 2:
      return `${day}nd`;
    case 3:
      return `${day}rd`;
    default:
      return `${day}th`;
  }
}

/** The schedule in the customer's own words. No cadence enum on the screen. */
function scheduleWords(mandate: ClientMandate): string {
  if (mandate.cadence === "daily") return "Every day";
  if (mandate.cadence === "weekly") {
    return `Every ${WEEKDAYS[mandate.dayOfWeek ?? 0] ?? "week"}`;
  }
  return `The ${ordinal(mandate.dayOfMonth ?? 1)} of every month`;
}

export function ClientStandingOrdersView({
  screen,
}: {
  readonly screen: ClientStandingScreen;
}) {
  const live = screen.mandates.filter((m) => !m.cancelled);

  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-border bg-surface px-5 py-4">
        <h1 className="text-base font-semibold tracking-tight">Recurring payments</h1>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          Payments that go out on their own, on a date you choose, until you
          stop them. Setting one up takes nothing from your account today: it
          writes down an authority, and each time the date comes round that
          authority raises a payment which goes through the same checks and the
          same approvals as anything else you send.
        </p>
        <p className="mt-2 text-sm font-medium">{screen.legalName}</p>
        <p className="text-xs text-muted">
          {screen.accountName ?? "No current account has been opened yet."} · today is{" "}
          {screen.bookDate} · available{" "}
          <Money cents={BigInt(screen.availableCents)} tone="neutral" />
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* The policy, stated on the screen — half of what item 8 asks for.    */}
      {/* ------------------------------------------------------------------ */}
      <Panel
        title="If the money is not there on the day"
        description="Written down before it happens, so it is a rule and not a surprise."
      >
        <div className="space-y-3 px-5 py-5">
          <p className="max-w-prose text-sm leading-relaxed">
            <strong className="font-medium">
              That payment is refused and closed. It is not sent short, it is not
              carried over to a day when the money has arrived, and it does not
              join a queue.
            </strong>{" "}
            The next one is unaffected and comes round on its own date.
          </p>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            The check is against your <strong className="font-medium text-text">available</strong>{" "}
            balance, not your ledger balance — available is what is left after
            card authorisations that have not settled, credits that have not
            cleared, and money already booked to leave on a future date. Money
            committed to a card hold is not spendable even though no line has
            moved it yet, and an uncleared credit can still be taken back by the
            sender. So a payment can be refused on a day when the ledger figure
            looks like it covered it, and that is the refusal worth showing: both
            figures are recorded on the row, as observed on the day, and appear
            below.
          </p>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            Why not send part of it: a mandate says $4,000 on the 1st, and
            $2,613.44 is a different payment — it will not match the invoice, so
            it makes a mess at both ends and leaves you in default anyway. Why
            not carry it forward: the debit then lands on a day nobody chose, at
            a size nobody expected, possibly doubled against the next one. A
            refusal is loud, dated and bounded, and topping the account up and
            sending it again is a decision you make, not one made for you at 3am.
          </p>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            A payment more than five days late is also refused rather than sent
            unannounced — if nobody noticed it was missing for a week, it is a
            conversation, not an automatic debit.
          </p>
        </div>
      </Panel>

      {/* ------------------------------------------------------------------ */}
      <Panel
        title="Set up a recurring payment"
        description="Nothing leaves your account by filling this in. It writes down an instruction for later."
      >
        <div className="px-5 py-5">
          {screen.accountId === null ? (
            <p className="max-w-prose text-sm leading-relaxed text-muted">
              No current account has been opened for this business yet, so there
              is nothing to pay from. An account opens when the business passes
              its checks — not before, and not by hand.
            </p>
          ) : (
            <CreateRecurringPaymentForm
              businessId={screen.businessId}
              mandateKey={screen.mandateKey}
              payees={screen.payees}
              today={screen.bookDate}
              currency={screen.currency}
            />
          )}
        </div>
      </Panel>

      {/* ------------------------------------------------------------------ */}
      <Panel
        title="Yours"
        description="Every recurring payment on this account, running or stopped."
      >
        {screen.mandates.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            You have not set up any recurring payments.
          </p>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">Your recurring payments</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={TH_CLASS}>
                    What for
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    How much
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    When
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Next
                  </th>
                </tr>
              </thead>
              <tbody>
                {screen.mandates.map((m) => (
                  <tr key={m.id} className="border-b border-border">
                    <td className={TD_CLASS}>
                      <span className="font-medium">{m.reference}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">{m.payeeLabel}</span>
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                      <Money cents={BigInt(m.amountCents)} tone="neutral" />
                    </td>
                    <td className={TD_CLASS}>
                      <span className="text-sm">{scheduleWords(m)}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        from {m.startDate}
                        {m.endDate === null ? "" : ` to ${m.endDate}`}
                      </span>
                    </td>
                    <td className={`${TD_CLASS} text-xs`}>
                      {m.cancelled ? (
                        <>
                          <span className="font-medium text-muted">Stopped</span>
                          <span className="mt-0.5 block text-[11px] text-muted">
                            {m.cancellationReason ?? "no reason recorded"}
                          </span>
                        </>
                      ) : m.nextDueDate === null ? (
                        <span className="text-muted">no more dates</span>
                      ) : (
                        <span>{m.nextDueDate}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      {/* ------------------------------------------------------------------ */}
      <Panel
        title="Stop a recurring payment"
        description="As reachable as setting one up, because a payment you cannot stop is worse than one you cannot start."
      >
        <div className="px-5 py-5">
          <StopRecurringPaymentForm
            businessId={screen.businessId}
            mandates={live.map((m) => ({
              id: m.id,
              label: `${m.reference} — ${m.payeeLabel}`,
            }))}
          />
        </div>
      </Panel>

      {/* ------------------------------------------------------------------ */}
      <Panel
        title="What has happened"
        description="Every date that has come round, sent or refused. A refusal is a row here, never a silence."
      >
        {screen.occurrences.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            None of your recurring payments has come round yet.
          </p>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">Recurring payment history</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={TH_CLASS}>
                    Date
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    What for
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    How much
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    What happened
                  </th>
                </tr>
              </thead>
              <tbody>
                {screen.occurrences.map((o) => (
                  <tr key={o.occurrenceId} className="border-b border-border">
                    <td className={`${TD_CLASS} whitespace-nowrap`}>{o.scheduledDate}</td>
                    <td className={TD_CLASS}>{o.reference}</td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                      <Money cents={BigInt(o.amountCents)} tone="neutral" />
                    </td>
                    <td className={`${TD_CLASS} max-w-prose text-xs`}>
                      {o.disposition === "raised" ? (
                        <span className="font-medium">Sent for approval</span>
                      ) : o.disposition === "refused" ? (
                        <>
                          <span className="font-medium text-negative">Not sent</span>
                          <span className="mt-0.5 block text-[11px] text-muted">
                            {o.refusalReason ?? o.refusalCode ?? "no reason recorded"}
                          </span>
                          {o.observedAvailableCents === null ? null : (
                            <span className="mt-0.5 block text-[11px] text-muted">
                              On the day: ledger{" "}
                              <Money
                                cents={BigInt(o.observedLedgerCents ?? "0")}
                                tone="neutral"
                              />
                              , available{" "}
                              <Money
                                cents={BigInt(o.observedAvailableCents)}
                                tone="neutral"
                              />
                              {o.shortfallCents === null ? null : (
                                <>
                                  , short by{" "}
                                  <Money cents={BigInt(o.shortfallCents)} tone="neutral" />
                                </>
                              )}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-muted">still being decided</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Note title="Once, and only once">
        A date that has come round is claimed in the database under a key built
        from the payment and the date, and that key is UNIQUE. If the machine
        restarts halfway through, or the job runs twice, or two of them run at
        the same time, the second attempt collides with the first and does
        nothing. That is what stops you being charged twice — not the scheduler
        being careful, which is a thing software forgets to be.
      </Note>
    </div>
  );
}
