import Link from "next/link";
import type { Route } from "next";

import { BusinessPicker } from "@/components/client/Chrome";
import { CLIENT_SCREENS, clientHref, type ClientView } from "@/components/client/view-state";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";
import { formatUsd } from "@/lib/format/money";

import { MovePotForm, OpenPotForm, PotToPotForm, type PotOption } from "./PotForms";
import type { ClientPotsScreen } from "./contract";

/**
 * `/client/pots` — the customer's own sub-accounts.
 *
 * A pure function of `ClientPotsScreen`. Every figure on it is a `bigint` all
 * the way to `<Money>`, which does integer arithmetic; the only strings are
 * the ones handed to the forms, which cross into the browser and are formatted
 * by `formatUsd` on this side of that line.
 *
 * ===========================================================================
 * WHAT A POT IS, SAID ON THE PAGE
 * ===========================================================================
 *
 * A pot is a real account under the customer's own deposit leaf, coded
 * `2100.<uuid>`, and a transfer into one is two journal lines summing to zero
 * inside that one customer's own money. Nothing leaves the bank, no rail is
 * touched, no provider is called and nothing can be returned three days later
 * — which is why it is instant. Not "we made it fast": there is nothing to
 * wait for.
 *
 * The screen therefore shows the identity rather than asserting it. `main +
 * Σ pots` is printed beside `v_pot_subtree`'s recursive walk of the account
 * tree, and the difference between them is printed too. Two independent routes
 * to one number, not the same SUM shown twice.
 */

/** The five screens plus this one. The business travels across every link. */
function PotsNav({ view }: { readonly view: ClientView }) {
  return (
    <nav aria-label="Your account" className="flex flex-wrap items-center gap-1">
      {CLIENT_SCREENS.map((item) => (
        <Link
          key={item.href}
          href={
            clientHref(item.href, {
              state: view.state,
              businessId: view.businessId,
            }) as Route
          }
          className={`rounded px-3 py-1.5 text-sm text-muted hover:text-text ${FOCUS_RING}`}
        >
          {item.label}
        </Link>
      ))}
      <span
        aria-current="page"
        className="rounded bg-surface-raised px-3 py-1.5 text-sm font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border)]"
      >
        Pots
      </span>
    </nav>
  );
}

function Term({
  label,
  cents,
  note,
}: {
  readonly label: string;
  readonly cents: bigint;
  readonly note: string;
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </p>
      <p className="mt-1 text-lg">
        <Money cents={cents} />
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{note}</p>
    </div>
  );
}

export function PotsClientView({
  screen,
  view,
}: {
  readonly screen: ClientPotsScreen;
  readonly view: ClientView;
}) {
  const { subject, pots, terms, identity } = screen;

  const options: readonly PotOption[] = pots.map((pot) => ({
    potId: pot.potId,
    name: pot.name,
    balanceDisplay: formatUsd(pot.balanceCents),
  }));

  return (
    <div className="space-y-6">
      <PotsNav view={view} />

      <header className="rounded-lg border border-border bg-surface px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">Your pots</h1>
              {subject.live ? (
                <Badge tone="positive">live</Badge>
              ) : (
                <Badge tone="negative">fixture</Badge>
              )}
            </div>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              Money you have set aside for something. A pot is a real account
              under your current account, not a label on a screen, and moving
              money into one is instant because nothing leaves the bank &mdash;
              there is no third party to wait for.
            </p>
            <p className="mt-2 text-sm font-medium">{subject.legalName}</p>
            <p className="text-xs text-muted">
              {subject.accountName ?? "No current account has been opened yet."}
            </p>
          </div>
          <BusinessPicker
            screen="/client"
            view={view}
            header={{
              businessId: subject.businessId,
              legalName: subject.legalName,
              accountId: null,
              accountName: subject.accountName,
              currency: "USD",
              asOf: subject.asOf,
              valueDate: "",
              bookingWatermark: "",
              live: subject.live,
              businesses: subject.businesses,
            }}
          />
        </div>
      </header>

      <Panel
        title="What you can set aside"
        description="Available is the one figure a pot may draw on, and it is ledger_availability() — the same five terms the rest of your account is read through. Nothing on this page computes a balance of its own."
      >
        <div className="grid divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          <Term
            label="In your account today"
            cents={terms.ledgerCents}
            note="Your ledger balance folded to today's value date, including money that is already spoken for. Entries dated ahead of today are not in it."
          />
          <Term
            label="Set aside in pots"
            cents={identity?.potsCents ?? 0n}
            note="Still yours and still on your account. Not counted as available to spend."
          />
          <Term
            label="Available to spend"
            cents={terms.availableCents}
            note={`Ledger ${formatUsd(terms.ledgerCents)} − card holds ${formatUsd(terms.holdsCents)} − credits not yet cleared ${formatUsd(terms.unclearedCents)} − payments already committed ${formatUsd(terms.pendingOutboundCents)}.`}
          />
        </div>
      </Panel>

      <Panel
        title="Your pots"
        description="Each one is an account of its own, coded under your current account. A pot may sit at exactly $0.00 — that is a normal state, not an empty slot."
      >
        {pots.length === 0 ? (
          <div className="px-5 py-5">
            <Note title="You have no pots yet">
              Nothing is set aside, so everything on your account is available
              to spend. Open one below and it starts at $0.00; your balance does
              not change until you move money into it.
            </Note>
          </div>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className={TH_CLASS}>Pot</th>
                  <th className={TH_CLASS}>What it is for</th>
                  <th className={TH_CLASS}>Account</th>
                  <th className={`${TH_CLASS} text-right`}>Holds</th>
                </tr>
              </thead>
              <tbody>
                {pots.map((pot) => (
                  <tr key={pot.potId} className="border-b border-border last:border-b-0">
                    <td className={`${TD_CLASS} font-medium`}>{pot.name}</td>
                    <td className={`${TD_CLASS} text-muted`}>
                      {pot.purpose ?? "—"}
                    </td>
                    <td className={`${TD_CLASS} money break-all text-xs text-muted`}>
                      {pot.accountCode}
                    </td>
                    <td className={`${TD_CLASS} text-right`}>
                      <Money cents={pot.balanceCents} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Open a pot"
        description="One account, opened under your own current account. It starts empty."
        as="h2"
      >
        <OpenPotForm businessId={subject.businessId} />
      </Panel>

      {pots.length === 0 ? null : (
        <>
          <Panel
            title="Set money aside, or take it back"
            description="Instant, both ways. Two journal lines that sum to zero inside your own money — no rail, no provider, nothing to wait for."
          >
            <MovePotForm
              businessId={subject.businessId}
              pots={options}
              availableDisplay={formatUsd(terms.availableCents)}
            />
          </Panel>

          {pots.length < 2 ? null : (
            <Panel
              title="Move money between pots"
              description="A release followed by an earmark: two entries, each decided on its own."
            >
              <PotToPotForm businessId={subject.businessId} pots={options} />
            </Panel>
          )}
        </>
      )}

      {identity === null ? null : (
        <Panel
          title="The arithmetic, checked"
          description="Your main balance plus your pots is your total. The second figure is the same total reached a different way — by walking the account tree rather than by reading the pot list — so the two agreeing means something. These four figures count EVERY entry on your book, including ones dated ahead of today, so the main balance here is larger than the figure above whenever something is booked for a future date."
        >
          <div className="space-y-3 px-5 py-5">
            <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted">Main balance, every entry</dt>
                <dd className="text-sm">
                  <Money cents={identity.mainCents} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted">Plus your pots</dt>
                <dd className="text-sm">
                  <Money cents={identity.potsCents} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted">Total</dt>
                <dd className="text-sm">
                  <Money cents={identity.totalCents} />
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-muted">The account tree, walked</dt>
                <dd className="text-sm">
                  <Money cents={identity.subtreeCents} />
                </dd>
              </div>
            </dl>
            {identity.holds ? (
              <Note title="The two agree, to the cent">
                Difference {formatUsd(identity.totalCents - identity.subtreeCents)}.
                Setting money aside never changes what the bank owes you; it
                changes only how much of it you can spend today.
              </Note>
            ) : (
              <Note emphasis title="The two do not agree">
                Difference {formatUsd(identity.totalCents - identity.subtreeCents)}.
                That is a defect and it is shown rather than hidden. No transfer
                on this screen caused it — every one of them posts two lines
                that sum to zero.
              </Note>
            )}
          </div>
        </Panel>
      )}
    </div>
  );
}
