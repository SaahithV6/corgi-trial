import Link from "next/link";

import { formatUsd } from "@/lib/format/money";
import { formatAge, formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FieldLabel,
  FOCUS_RING,
  MetaList,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import { BusinessSelector } from "./ConsoleChrome";
import { AuthorizeForm, ClearingForm, DrainForm, IssueCardForm } from "./ConsoleForms";
import type { ConsoleAction, CardOption } from "./ConsoleForms";
import type { ConsoleView as ConsoleViewState } from "./console-state";
import type { ConsoleBusiness, ConsoleHold, ConsoleSnapshot } from "./contract";

export type ConsoleActions = {
  readonly issueCard: ConsoleAction;
  readonly authorize: ConsoleAction;
  readonly clearing: ConsoleAction;
  readonly drain: ConsoleAction;
};

/* -------------------------------------------------------------------------- */
/* Balances                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The four figures, and the subtraction that relates them.
 *
 * This is the idea the whole screen exists for. The ledger balance is what the
 * journal says the customer has; the available balance is what they can spend;
 * the holds are the entire difference and each one is itemised below with the
 * arithmetic that sized it. Neither number is stored — `pnpm db:check` fails
 * the build if a balance column ever appears — so both are folds, taken as of
 * the one instant printed in the header.
 */
function BalancePanel({ snapshot }: { readonly snapshot: ConsoleSnapshot }) {
  const { balances } = snapshot;
  const negative = balances.availableCents < 0n;
  const drift = balances.holdsCents - snapshot.foldedCardHoldsCents;
  // How much of the gap is a closure row that has been reversed — the case the
  // two library functions genuinely disagree about, rather than the benign
  // business-wide-versus-one-account case.
  let reversedCents = 0n;
  for (const hold of snapshot.holds) {
    if (hold.closureReversed) reversedCents += hold.memoBalanceCents < 0n
      ? -hold.memoBalanceCents
      : hold.memoBalanceCents;
  }

  const tiles: readonly {
    readonly label: string;
    readonly cents: bigint;
    readonly note: string;
  }[] = [
    {
      label: "Ledger balance",
      cents: balances.ledgerCents,
      note: "Σ amount_cents × normal_side, value date ≤ today, booking_seq ≤ watermark.",
    },
    {
      label: "Holds",
      cents: balances.holdsCents,
      note: "Σ H(E) over every live card and manual hold whose value date has arrived.",
    },
    {
      label: "Uncleared credits",
      cents: balances.unclearedCents,
      note: "Deposits inside their funds-availability window.",
    },
    {
      label: "Committed out",
      cents: balances.pendingOutboundCents,
      note: "Debits booked for a future value date. No hold row — a journal entry.",
    },
    {
      label: "Available balance",
      cents: balances.availableCents,
      note: "ledger − holds − uncleared − committed. Never clamped at zero.",
    },
  ];

  return (
    <Panel
      id="balances"
      title="Ledger balance versus available balance"
      description="Two different questions. The ledger says what the journal has booked; available says what can be spent right now. The holds below are the whole of the difference."
      actions={
        <span className="font-mono text-[11px] text-muted">
          available = ledger − holds − uncleared − committed
        </span>
      }
    >
      <div className="grid gap-px bg-border sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((tile) => (
          <div key={tile.label} className="bg-surface px-5 py-4">
            <FieldLabel>{tile.label}</FieldLabel>
            <p className="mt-1">
              <Money cents={tile.cents} className="text-xl" />
            </p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{tile.note}</p>
          </div>
        ))}
      </div>

      <div className="border-t border-border px-5 py-4">
        <p className="font-mono text-xs text-muted">
          {formatUsd(balances.ledgerCents)} − {formatUsd(balances.holdsCents)} −{" "}
          {formatUsd(balances.unclearedCents)} −{" "}
          {formatUsd(balances.pendingOutboundCents)} ={" "}
          <span className="text-text">{formatUsd(balances.availableCents)}</span>
        </p>

        {negative ? (
          <div className="mt-3">
            <Note
              emphasis
              title="Available is negative, and it has not been clamped"
            >
              A capture larger than its authorisation settles for more than was
              ever withheld, so the excess was never protected and the customer
              is overdrawn. <span className="font-mono">max(A − C, 0)</span> is
              the hold, not the overdraft — the hold is correctly zero and the
              money is correctly owed. Clamping this figure at{" "}
              <span className="font-mono">$0.00</span> would hide a real
              overdraft behind a cosmetic floor, and an operator would act on
              the floor.
            </Note>
          </div>
        ) : null}

        {drift === 0n ? null : (
          <div className="mt-3">
            <Note title="Two queries, two answers — both shown, neither preferred">
              <p>
                <span className="font-mono">availableBalance()</span> puts card
                holds at <Money cents={balances.holdsCents} tone="neutral" />;
                folding the <span className="font-mono">Remaining H(E)</span>{" "}
                column below gives{" "}
                <Money cents={snapshot.foldedCardHoldsCents} tone="neutral" />, a
                difference of <Money cents={drift} tone="neutral" />.
              </p>
              {reversedCents === 0n ? (
                <p className="mt-1.5">
                  The first is a business-wide aggregate and the second is this
                  account only, so a customer with a second deposit account will
                  legitimately show a gap.
                </p>
              ) : (
                <p className="mt-1.5">
                  <Money cents={reversedCents} tone="neutral" /> of it is the
                  migration-0011 residue, marked{" "}
                  <span className="font-medium text-text">closure reversed</span>{" "}
                  in the table: a{" "}
                  <span className="font-mono">hold_closure</span> row that should
                  never have been written, un-written by an append to{" "}
                  <span className="font-mono">hold_closure_reversal</span>.
                  Availability reads that reversal and keeps the money withheld;{" "}
                  <span className="font-mono">listHoldRows()</span> treats any
                  closure row as final and reports the hold at{" "}
                  <span className="font-mono">$0.00</span>. Availability is the
                  one the customer feels.
                </p>
              )}
              <p className="mt-1.5">
                It is reported rather than reconciled. Picking a favourite is how
                a screen starts disagreeing with the ledger it exists to explain.
              </p>
            </Note>
          </div>
        )}
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

function CardsPanel({
  snapshot,
  live,
  actions,
  formKey,
}: {
  readonly snapshot: ConsoleSnapshot;
  readonly live: boolean;
  readonly actions: ConsoleActions;
  readonly formKey: string;
}) {
  const { cards, business } = snapshot;

  return (
    <Panel
      id="cards"
      title="Cards"
      description="Every card here is a real object on a real Lithic card program. The row stores the provider token, the last four and which accounts it spends from — there is no PAN column, and the console never asks for one except at the instant a simulation needs it."
      actions={
        <span className="text-xs text-muted">
          {business.cardCount} registered · {cards.length} shown
        </span>
      }
    >
      {live ? (
        <IssueCardForm
          action={actions.issueCard}
          businessId={business.businessId}
          businessName={business.legalName}
          formKey={formKey}
        />
      ) : null}

      {cards.length === 0 ? (
        <p className="border-t border-border px-5 py-8 text-sm text-muted">
          No card is registered to this customer. An authorisation on a card we
          have never registered parks in the inbox rather than posting — it is
          either a race with card creation or somebody else&rsquo;s program, and
          both are better than posting a stranger&rsquo;s fuel to a customer we
          happen to have.
        </p>
      ) : (
        <div className="border-t border-border">
          <TableScroll>
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Cards registered to this customer, newest first
              </caption>
              <thead className="border-b border-border">
                <tr>
                  <th scope="col" className={TH_CLASS}>
                    Lithic card token
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Last four
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Nickname
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Registered
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {cards.map((card) => (
                  <tr key={card.cardId}>
                    <th
                      scope="row"
                      className={`${TD_CLASS} text-left font-mono text-xs font-normal break-all`}
                    >
                      {card.providerCardToken}
                    </th>
                    <td className={`${TD_CLASS} font-mono text-xs`}>
                      {card.lastFour === null ? "—" : `••${card.lastFour}`}
                    </td>
                    <td className={TD_CLASS}>{card.nickname ?? "—"}</td>
                    <td className={`${TD_CLASS} text-right whitespace-nowrap text-xs text-muted`}>
                      {formatTimestamp(card.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* The simulator                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The authorisation control, with the label the requirement asks for stated
 * where the finger is about to press.
 */
function SimulatorPanel({
  snapshot,
  actions,
}: {
  readonly snapshot: ConsoleSnapshot;
  readonly actions: ConsoleActions;
}) {
  const options: CardOption[] = snapshot.cards.map((card) => ({
    token: card.providerCardToken,
    label: `${card.lastFour === null ? "card" : `••${card.lastFour}`}${
      card.nickname === null ? "" : ` · ${card.nickname}`
    } · ${card.providerCardToken.slice(0, 8)}…`,
  }));

  return (
    <Panel
      id="authorise"
      title="Simulate an authorisation"
      description="Watch the available balance drop and the ledger balance stay exactly where it is. An authorisation is a memo posting; there is no code path in this system from an authorisation to a financial entry."
      actions={<Badge tone="neutral">sandbox simulation</Badge>}
    >
      <div className="border-b border-border px-5 py-4">
        <Note title="What is real here, and what is not">
          <ul className="list-disc space-y-1 pl-4">
            <li>
              <span className="font-medium text-text">The card is real.</span> It
              was created by <span className="font-mono">POST /v1/cards</span>{" "}
              on a live Lithic card program and its token resolves at{" "}
              <span className="font-mono">GET /v1/cards</span>.
            </li>
            <li>
              <span className="font-medium text-text">
                The authorisation is a SANDBOX SIMULATION.
              </span>{" "}
              This button calls{" "}
              <span className="font-mono">POST /v1/simulate/authorize</span> —
              Lithic&rsquo;s own simulator. No merchant was paid, no card was
              presented anywhere, and no purchase occurred.
            </li>
            <li>
              <span className="font-medium text-text">
                The webhook that comes back is real.
              </span>{" "}
              Lithic delivers{" "}
              <span className="font-mono">card_transaction.updated</span> to the
              deployed endpoint, it is signature-verified, stored in the inbox
              and posted by the same consumer that would handle a live
              authorisation.
            </li>
            <li>
              <span className="font-medium text-text">The money is not real.</span>{" "}
              The balances that move are this system&rsquo;s ledger, on a demo
              estate. Nothing left any bank.
            </li>
          </ul>
        </Note>
      </div>

      <AuthorizeForm
        action={actions.authorize}
        businessId={snapshot.business.businessId}
        cards={options}
      />

      <div className="border-t border-border">
        <DrainForm action={actions.drain} businessId={snapshot.business.businessId} />
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Holds                                                                      */
/* -------------------------------------------------------------------------- */

const KIND_LABEL: Record<ConsoleHold["kind"], string> = {
  card_auth: "Card auth",
  uncleared_credit: "Uncleared credit",
  manual: "Manual",
};

const CLOSED_REASON_LABEL: Record<string, string> = {
  closure_row: "closure row written",
  network_final: "network said final",
  close_event: "closed by the network",
  expired: "expiry clock reached",
  fully_reversed: "fully reversed",
  funds_available: "funds became available",
};

function HoldsPanel({
  snapshot,
  live,
  actions,
}: {
  readonly snapshot: ConsoleSnapshot;
  readonly live: boolean;
  readonly actions: ConsoleActions;
}) {
  const { holds } = snapshot;
  const active = holds.filter((hold) => hold.remainingCents > 0n).length;

  return (
    <Panel
      id="holds"
      title="Holds, itemised"
      description="The columns are the terms of the model, kept apart rather than pre-added: A(E) authorised, C(E) cleared, H(E) remaining. Every one of these is a memo posting — not one of them touched the ledger balance."
      actions={
        <span className="font-mono text-[11px] text-muted">
          H(E) = 0 if closed(E) else max(A(E) − C(E), 0)
        </span>
      }
    >
      {holds.length === 0 ? (
        <p className="px-5 py-8 text-sm text-muted">
          Nothing is being withheld, so the available balance equals the ledger
          balance exactly. Simulate an authorisation above and the two will part
          company by precisely the amount authorised.
        </p>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Holds on this account, with the arithmetic behind each one
            </caption>
            <thead className="border-b border-border">
              <tr>
                <th scope="col" className={TH_CLASS}>
                  Hold
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Authorised A(E)
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Cleared C(E)
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Remaining H(E)
                </th>
                <th scope="col" className={TH_CLASS}>
                  {live ? "Settle it" : "Events"}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {holds.map((hold) => (
                <HoldRow
                  key={hold.holdId}
                  hold={hold}
                  live={live}
                  businessId={snapshot.business.businessId}
                  asOf={snapshot.asOf}
                  action={actions.clearing}
                />
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      <p className="border-t border-border px-5 py-3 text-xs text-muted">
        {active} of {holds.length} still withholding money.
      </p>
    </Panel>
  );
}

function HoldRow({
  hold,
  live,
  businessId,
  asOf,
  action,
}: {
  readonly hold: ConsoleHold;
  readonly live: boolean;
  readonly businessId: string;
  readonly asOf: string;
  readonly action: ConsoleAction;
}) {
  const overCaptured = hold.clearedCents > hold.authorisedCents;
  const excess = overCaptured ? hold.clearedCents - hold.authorisedCents : 0n;
  const partial =
    !overCaptured && hold.clearedCents > 0n && hold.remainingCents > 0n;
  // Rendered for every card authorisation, not only the outstanding ones.
  //
  // Two reasons, and the second one is a bug this originally had. An operator
  // demonstrating over-capture needs to capture against an authorisation with
  // nothing left on it — that is what over-capture IS. And a form that
  // disappears the moment its own action succeeds takes its result panel with
  // it: clear a hold in full and the sentence explaining what just happened
  // unmounts along with the control that produced it.
  const settleable = live && hold.kind === "card_auth" && hold.providerAuthId !== null;

  return (
    <tr className={hold.remainingCents === 0n ? "text-muted" : ""}>
      <td className={TD_CLASS}>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/accounts/holds/${hold.holdId}`}
            className={`font-medium text-text underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
          >
            {hold.descriptor}
          </Link>
          <Badge tone="quiet">{KIND_LABEL[hold.kind]}</Badge>
          {overCaptured ? (
            <Badge
              tone="negative"
              title="The network captured more than it authorised. The hold is correctly zero; the excess was never protected."
            >
              over-captured
            </Badge>
          ) : null}
          {partial ? <Badge tone="quiet">partially cleared</Badge> : null}
          {hold.closed ? (
            <Badge tone="quiet">
              closed · {CLOSED_REASON_LABEL[hold.closedReason ?? ""] ?? "closed"}
            </Badge>
          ) : null}
          {hold.closureReversed ? (
            <Badge
              tone="negative"
              title="The closure row on this hold was written in error and un-written by an append to hold_closure_reversal. Availability still withholds the money; the Remaining column does not."
            >
              closure reversed
            </Badge>
          ) : null}
        </div>

        <p className="mt-1 text-xs text-muted">
          Placed {formatTimestamp(hold.placedAt)} ({formatAge(hold.placedAt, asOf)})
          {hold.expiresAt === null ? null : (
            <> · expires {formatTimestamp(hold.expiresAt)}</>
          )}{" "}
          · {hold.eventCount} event{hold.eventCount === 1 ? "" : "s"} in E
        </p>

        <p className="mt-0.5 font-mono text-[11px] break-all text-muted">
          {hold.externalRef}
        </p>

        {hold.closureReversed ? (
          <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
            This hold&rsquo;s <span className="font-mono">hold_closure</span> row
            was written by a bug and un-written by an append to{" "}
            <span className="font-mono">hold_closure_reversal</span> — the only
            way back in an append-only table, and the whole subject of migration
            0011. <span className="font-mono">availableBalance()</span> reads the
            reversal and is still withholding{" "}
            <Money
              cents={
                hold.memoBalanceCents < 0n ? -hold.memoBalanceCents : hold.memoBalanceCents
              }
              tone="neutral"
            />
            ; the Remaining column reads $0.00 because{" "}
            <span className="font-mono">listHoldRows()</span> stops at the
            presence of a closure row. Both are shown because they are both
            true of the database as it stands.
          </p>
        ) : null}

        {overCaptured ? (
          <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
            Cleared <Money cents={hold.clearedCents} tone="neutral" /> against an
            authorisation of <Money cents={hold.authorisedCents} tone="neutral" />.
            The excess of <Money cents={excess} tone="neutral" /> was never held,
            so it was never protected. The hold is $0.00 because{" "}
            <span className="font-mono">max(A − C, 0)</span> is zero — not
            because anything failed.
          </p>
        ) : null}
      </td>

      <td className={`${TD_CLASS} text-right`}>
        <Money cents={hold.authorisedCents} tone="neutral" />
      </td>

      <td className={`${TD_CLASS} text-right`}>
        <Money cents={hold.clearedCents} tone="neutral" />
      </td>

      <td className={`${TD_CLASS} text-right`}>
        <Money
          cents={hold.remainingCents}
          tone="neutral"
          className={hold.remainingCents > 0n ? "font-medium" : ""}
        />
        {hold.memoBalanceCents === hold.remainingCents ? null : (
          <span
            className="mt-0.5 block text-[11px] text-muted"
            title="The memo book's own balance for this hold. A gap means a release posting has not landed yet; availability does not depend on it."
          >
            memo book: {formatUsd(hold.memoBalanceCents)}
          </span>
        )}
      </td>

      <td className={TD_CLASS}>
        {settleable && hold.providerAuthId !== null ? (
          <ClearingForm
            action={action}
            businessId={businessId}
            transactionToken={hold.providerAuthId}
            outstanding={hold.remainingCents > 0n}
            suggestion={
              hold.remainingCents > 0n
                ? formatUsd(hold.remainingCents, { symbol: false })
                : ""
            }
          />
        ) : (
          <Link
            href={`/accounts/holds/${hold.holdId}`}
            className={`text-xs underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
          >
            See the {hold.eventCount} event{hold.eventCount === 1 ? "" : "s"}
          </Link>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* The console                                                                */
/* -------------------------------------------------------------------------- */

export function ConsoleView({
  snapshot,
  live,
  actions,
  formKey,
  view,
  businesses,
}: {
  readonly snapshot: ConsoleSnapshot;
  readonly live: boolean;
  readonly actions: ConsoleActions;
  readonly formKey: string;
  readonly view: ConsoleViewState;
  readonly businesses: readonly ConsoleBusiness[];
}) {
  return (
    <div className="space-y-6">
      <header>
        {live ? (
          <div className="mb-3">
            <BusinessSelector
              view={view}
              businesses={businesses}
              selectedId={snapshot.business.businessId}
            />
          </div>
        ) : null}
        <h2 className="text-base font-semibold tracking-tight">
          {snapshot.business.legalName}{" "}
          <span className="font-normal text-muted">
            · {snapshot.business.accountName}
          </span>
        </h2>
        <div className="mt-2">
          <MetaList
            items={[
              { label: "As of", value: formatTimestamp(snapshot.asOf) },
              {
                label: "Booking watermark",
                value: (
                  <span className="font-mono">
                    {snapshot.bookingWatermark.toString()}
                  </span>
                ),
              },
              { label: "Currency", value: snapshot.business.currency },
            ]}
          />
        </div>
      </header>

      <BalancePanel snapshot={snapshot} />

      <CardsPanel
        snapshot={snapshot}
        live={live}
        actions={actions}
        formKey={formKey}
      />

      {live ? <SimulatorPanel snapshot={snapshot} actions={actions} /> : null}

      <HoldsPanel snapshot={snapshot} live={live} actions={actions} />
    </div>
  );
}
