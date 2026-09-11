import Link from "next/link";
import type { Route } from "next";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FieldLabel,
  FOCUS_RING,
  MetaList,
  Note,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";
import { formatUsd } from "@/lib/format/money";

import { CLIENT_SCREENS, clientHref, type ClientView } from "../view-state";
import type { PayoutsScreen } from "./contract";
import { QuoteDesk } from "./QuoteDesk";

/**
 * The customer's side of a cross-border payout.
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS FOR
 * ===========================================================================
 *
 * Nineteen screens in this build show an FX quote to the bank. This is the one
 * that shows it to the person whose money it is, and the difference is the
 * feature: a rate the customer never saw is a price we charged, not a price
 * they agreed to. The brief asks for "an FX quote the customer accepts", and
 * accepting is what turns the number into a commitment we are held to for a day
 * whatever the market does.
 *
 * ===========================================================================
 * THE TWO FIGURES AT THE TOP, AND WHY THEY DIFFER
 * ===========================================================================
 *
 * `availableCents` is `ledger_availability()`'s own answer, migration 0022, the
 * one definition of available balance on this book. It is not summed from the
 * commitments listed underneath and it is not clamped at zero.
 *
 * `committedCents` is what this customer's accepted, unsettled quotes are
 * holding. It is ALREADY inside the availability figure — an acceptance places
 * an ordinary `manual` hold on the `2100` leaf and the availability function
 * subtracts it through the hold term it has always had. The list exists so a
 * customer can see what took their money, not so anyone subtracts it twice.
 *
 * ===========================================================================
 * NO MONEY MOVES FROM THIS PAGE
 * ===========================================================================
 *
 * Asking for a rate writes two append-only rows and holds nothing. Accepting
 * writes an acceptance and a hold and posts a memo entry. Neither posts to the
 * financial ledger and neither sends anything: the transfer is settlement, it
 * is a different path, and it is not reachable from here. The page says so
 * rather than leaving a customer to assume their money has gone.
 */

/** How a quote's derived state reads to the person who asked for it. */
const STATE_WORDS: Record<string, { readonly label: string; readonly note: string }> = {
  open: {
    label: "Waiting for you",
    note: "The offer still stands. Nothing is committed and your balance is untouched.",
  },
  expired: {
    label: "Lapsed unaccepted",
    note: "Nobody accepted it in time. You committed nothing and it cost you nothing.",
  },
  accepted: {
    label: "Committed",
    note: "You accepted this rate. The amount is held against your account until it is paid out.",
  },
  lapsed: {
    label: "Commitment expired",
    note: "You accepted it, we honoured the rate for the whole window, and it was not paid out in time. The hold has come off.",
  },
  settled: {
    label: "Paid out",
    note: "The payout went out at the rate you accepted.",
  },
};

function QuoteStateBadge({ state }: { readonly state: string }) {
  const words = STATE_WORDS[state];
  const tone =
    state === "accepted" || state === "settled"
      ? "positive"
      : state === "expired" || state === "lapsed"
        ? "quiet"
        : "neutral";
  return <Badge tone={tone}>{words?.label ?? state}</Badge>;
}

export function PayoutsView({
  screen,
  view,
}: {
  readonly screen: PayoutsScreen;
  readonly view: ClientView;
}) {
  // Formatted from the `bigint` by the shared formatter. There is no
  // `Number(cents) / 100` on this page: a cent that goes through a double is a
  // cent that can come back wrong, and this one is printed under a form.
  const availableDisplay = formatUsd(screen.availableCents);

  return (
    <div className="space-y-6">
      <nav aria-label="Your account" className="flex flex-wrap items-center gap-1">
        {/* `CLIENT_SCREENS` CONTAINS THIS SCREEN. The trailing "you are here"
            pill that used to follow this map put a second Send abroad control
            beside the one in the list — two pills for one screen, one of them a
            link to the page already open. The current screen is marked inside
            the map instead. */}
        {CLIENT_SCREENS.map((item) => {
          const active = item.href === "/client/payouts";
          return (
            <Link
              key={item.href}
              href={clientHref(item.href, { state: view.state, businessId: view.businessId }) as Route}
              aria-current={active ? "page" : undefined}
              className={`rounded px-3 py-1.5 text-sm ${FOCUS_RING} ${
                active
                  ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border)]"
                  : "text-muted hover:text-text"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <header className="rounded-lg border border-border bg-surface px-5 py-6">
        <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
          <div>
            <h1 className="text-xl font-semibold">Send money abroad</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted">
              We show you the market rate, what we charge on top of it, and exactly what your
              beneficiary receives. If you accept, that rate is ours to honour for a day — it does
              not move if the market does.
            </p>
          </div>

          <form action="/client/payouts" method="get" className="flex flex-wrap items-end gap-2">
            {view.state === "default" ? null : (
              <input type="hidden" name="state" value={view.state} />
            )}
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                Signed in as
              </span>
              <select
                name="business"
                defaultValue={screen.businessId}
                className={`rounded border border-border-strong bg-surface px-2 py-1.5 text-sm ${FOCUS_RING}`}
              >
                {screen.businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.legalName}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className={`rounded border border-border-strong px-2.5 py-1.5 text-xs font-medium ${FOCUS_RING}`}
            >
              Switch
            </button>
          </form>
        </div>

        <div className="mt-6 flex flex-wrap items-end gap-x-12 gap-y-6">
          <div>
            <FieldLabel>You can commit right now</FieldLabel>
            <p className="mt-1.5">
              <Money cents={screen.availableCents} className="text-3xl font-semibold" />
            </p>
            <p className="mt-1 max-w-md text-xs text-muted">
              Your spendable balance. A quote you accept cannot exceed it, and accepting one
              lowers it by what you committed.
            </p>
          </div>

          <div>
            <FieldLabel>Already committed to quotes</FieldLabel>
            <p className="mt-1.5">
              <Money cents={screen.committedCents} className="text-2xl font-medium" tone="neutral" />
            </p>
            <p className="mt-1 max-w-md text-xs text-muted">
              Held against rates you have accepted and we have not paid out yet. This is already
              taken out of the figure on the left; it is not a second subtraction.
            </p>
          </div>

          <div>
            <FieldLabel>In your account</FieldLabel>
            <p className="mt-1.5">
              <Money cents={screen.ledgerCents} className="text-2xl font-medium" tone="neutral" />
            </p>
            <p className="mt-1 max-w-md text-xs text-muted">
              Every payment in and out that has been booked. A commitment is not a payment, so
              this figure does not move when you accept a rate.
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-border pt-3">
          <MetaList
            items={[
              { label: "account", value: screen.legalName },
              { label: "as of", value: screen.asOf },
            ]}
          />
        </div>
      </header>

      <QuoteDesk
        businessId={screen.businessId}
        corridors={screen.corridors}
        availableDisplay={availableDisplay}
      />

      {screen.standing.length === 0 ? null : (
        <section
          aria-labelledby="standing"
          className="rounded-lg border border-border bg-surface px-5 py-5"
        >
          <h2 id="standing" className="text-base font-semibold">
            What your accepted rates are holding
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Each of these is money reserved against a rate you accepted and we have not paid out
            yet. It is still in your account and you cannot commit it to a second payout. When one
            is paid out, or when its window closes without a payout, the hold comes off and the
            amount returns to what you can commit.
          </p>
          <div className="mt-4">
            <TableScroll>
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-border">
                    <th className={TH_CLASS}>Quote</th>
                    <th className={TH_CLASS}>Beneficiary</th>
                    <th className={TH_CLASS}>Held</th>
                    <th className={TH_CLASS}>They receive</th>
                    <th className={TH_CLASS}>We must pay by</th>
                  </tr>
                </thead>
                <tbody>
                  {screen.standing.map((c) => (
                    <tr key={c.quoteRef} className="border-b border-border last:border-b-0">
                      <td className={`${TD_CLASS} font-mono`}>{c.quoteRef}</td>
                      <td className={TD_CLASS}>{c.beneficiaryRef}</td>
                      <td className={TD_CLASS}>
                        <Money cents={c.withheldCents} />
                      </td>
                      <td className={`${TD_CLASS} money`}>{c.deliveryDisplay}</td>
                      <td className={`${TD_CLASS} font-mono text-xs`}>{c.settleBy ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        </section>
      )}

      <section
        aria-labelledby="history"
        className="rounded-lg border border-border bg-surface px-5 py-5"
      >
        <h2 id="history" className="text-base font-semibold">
          Rates you have been quoted
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Your last {screen.quotes.length === 1 ? "quote" : `${screen.quotes.length} quotes`},
          newest first. Offers you did not take are kept as well as the ones you did — a rate you
          declined is part of the record of what you were charged.
        </p>

        {screen.quotes.length === 0 ? (
          <div className="mt-4">
            <Note title="No quotes yet">
              You have not asked for a rate on this account. Asking costs nothing, commits nothing
              and does not touch your balance.
            </Note>
          </div>
        ) : (
          <div className="mt-4">
            <TableScroll>
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-border">
                    <th className={TH_CLASS}>Quote</th>
                    <th className={TH_CLASS}>Where</th>
                    <th className={TH_CLASS}>You send</th>
                    <th className={TH_CLASS}>They receive</th>
                    <th className={TH_CLASS}>Your rate</th>
                    <th className={TH_CLASS}>Where it stands</th>
                  </tr>
                </thead>
                <tbody>
                  {screen.quotes.map((q) => (
                    <tr key={q.quoteRef} className="border-b border-border last:border-b-0">
                      <td className={`${TD_CLASS} font-mono`}>
                        {q.quoteRef}
                        {q.isFixture ? (
                          <span className="ml-2 align-middle">
                            <Badge tone="quiet">test row</Badge>
                          </span>
                        ) : null}
                        <span className="mt-0.5 block font-sans text-xs text-muted">
                          {q.beneficiaryRef}
                        </span>
                      </td>
                      <td className={`${TD_CLASS} text-xs`}>{q.destination}</td>
                      <td className={TD_CLASS}>
                        <Money cents={q.sellCents} />
                      </td>
                      <td className={`${TD_CLASS} money`}>{q.deliveryDisplay}</td>
                      <td className={`${TD_CLASS} money`}>{q.rateDisplay}</td>
                      <td className={TD_CLASS}>
                        <QuoteStateBadge state={q.state} />
                        <span className="mt-1 block max-w-xs text-xs text-muted">
                          {STATE_WORDS[q.state]?.note ?? ""}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          </div>
        )}
      </section>

      <Note title="What this page does not do">
        <p>
          Accepting a rate commits money; it does not move any. No payment is made from this page
          and nothing is sent. When the payout goes out it is a separate step, it happens at the
          rate you accepted, and it will appear on your activity with the transaction behind it.
        </p>
      </Note>
    </div>
  );
}
