import Link from "next/link";

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

import { BusinessPicker } from "../Chrome";
import type { CustomerCase, DisputesScreen } from "./contract";
import { FileDisputeForm, type ChargeOption, type ReasonChoice } from "./FileDisputeForm";
import { deciderWord } from "./language";
import { CLIENT_SCREENS, clientQuery, type ClientView } from "../view-state";

/**
 * `/client/disputes` — the customer's half of dispute intake.
 *
 * ===========================================================================
 * WHY THIS SCREEN IS NOT `/disputes`
 * ===========================================================================
 *
 * `/disputes` is the operator's console: it sees every case on the book, it
 * decides them, and it moves the money. This screen sees ONE customer's
 * transactions and ONE customer's cases, it can raise a claim, and it can move
 * nothing. They share the library underneath and nothing else — there is no
 * second copy of the intake rules and no second definition of a status.
 *
 * ===========================================================================
 * THE BALANCE IS ON THIS SCREEN BECAUSE OF WHAT IT PROVES
 * ===========================================================================
 *
 * The figure at the top is `ledger_availability()`'s own answer, read through
 * the same reader `/client` uses. It is here so a customer can raise a claim,
 * look up, and see that their available balance has not moved — which is the
 * honest thing that happens, and the thing a screen that handed out provisional
 * credit on a form submission would quietly get wrong.
 *
 * ===========================================================================
 * ITS OWN NAV, DELIBERATELY
 * ===========================================================================
 *
 * `ClientNav` and `ClientStateBar` take a `ClientScreenHref`, which is the five
 * screens `CLIENT_SCREENS` declares. This is a sixth. Rather than widen a union
 * that two other files are checked against, this screen links back to the five
 * and carries the `?business=` parameter across, which is the part that
 * actually matters: on a surface whose whole subject is one customer, silently
 * changing customer on a nav click is the worst navigation bug available.
 */

/** A hold on the money the bank advanced, said as the customer experiences it. */
function advanceWord(row: CustomerCase): string {
  if (row.advancedCents === 0n) return "Nothing advanced";
  if (row.heldCents > 0n) return "Advanced, and held until the case ends";
  return "Advanced, and yours to spend";
}

function CaseCard({ row }: { readonly row: CustomerCase }) {
  return (
    <li className="rounded-lg border border-border bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <p className="font-mono text-sm font-semibold">{row.caseRef}</p>
          <p className="mt-0.5 text-xs text-muted">
            {row.reasonWord} · raised {row.valueDate}
          </p>
        </div>
        <div className="text-right">
          <Money cents={row.amountCents} />
          <p className="mt-0.5 text-[11px] text-muted">claimed</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge tone={row.isClosed ? "quiet" : "neutral"}>{row.status.replaceAll("_", " ")}</Badge>
        <Badge tone={row.advancedCents > 0n ? "positive" : "quiet"}>{advanceWord(row)}</Badge>
        {/* PAST THE DATE IS NOT A NEGATIVE COUNTDOWN. The figure is
            `outside_date − CURRENT_DATE`, so a case still open after its
            deadline printed "-6 days until the network must have finished",
            which reads as a rendering fault rather than as the real and
            reportable fact that the network is late. Zero is its own sentence
            for the same reason. */}
        {row.isClosed ? null : row.daysToOutsideDate > 0 ? (
          <Badge tone="quiet">
            {row.daysToOutsideDate} days until the network must have finished
          </Badge>
        ) : row.daysToOutsideDate === 0 ? (
          <Badge tone="quiet">the network must finish this today</Badge>
        ) : (
          <Badge tone="negative">
            {-row.daysToOutsideDate} days past the date the network had to finish
          </Badge>
        )}
      </div>

      <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">{row.statusMeaning}</p>

      <p className="mt-3 max-w-prose border-l-2 border-border pl-3 text-xs leading-relaxed">
        &ldquo;{row.narrative}&rdquo;
      </p>

      {row.steps.length === 0 ? null : (
        <ol className="mt-4 space-y-2 border-t border-border pt-3">
          {row.steps.map((step) => (
            <li key={step.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="w-24 shrink-0 font-mono text-[11px] text-muted">
                {step.valueDate}
              </span>
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                {deciderWord(step.byCorgi)}
              </span>
              <span className="max-w-prose flex-1 text-xs leading-relaxed">
                {step.sentence}
                {step.amountCents === null ? null : (
                  <>
                    {" "}
                    <Money cents={step.amountCents} />
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function DisputesView({
  screen,
  view,
}: {
  readonly screen: DisputesScreen;
  readonly view: ClientView;
}) {
  const { header, charges, cases, reasons } = screen;

  // Formatted HERE, because the form below is a client component and carries no
  // figures on its props. Nothing downstream of this line does arithmetic.
  const chargeOptions: readonly ChargeOption[] = charges.map((charge) => ({
    entryId: charge.entryId,
    valueDate: charge.valueDate,
    description: charge.description,
    outstandingDisplay: formatUsd(charge.outstandingCents),
    cardWord:
      charge.cardLastFour === null
        ? "card not matched"
        : `card ending ${charge.cardLastFour}${
            charge.cardNickname === null ? "" : ` (${charge.cardNickname})`
          }`,
  }));

  const reasonChoices: readonly ReasonChoice[] = reasons.map((option) => ({
    reason: option.reason,
    label: option.label,
    networkCode: option.networkCode,
    networkLabel: option.networkLabel,
  }));

  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-border bg-surface px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-semibold tracking-tight">Disputed payments</h1>
              {header.live ? (
                <Badge tone="positive">live</Badge>
              ) : (
                <Badge tone="negative">fixture</Badge>
              )}
            </div>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              If a card payment went wrong, raise a claim here and follow it. Raising a claim does
              not move money and does not change what you can spend.
            </p>
            <p className="mt-2 text-sm font-medium">{header.legalName}</p>
            <p className="text-xs text-muted">
              {header.accountName ?? "No current account has been opened yet."}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[11px] uppercase tracking-[0.08em] text-muted">Available to spend</p>
            <Money cents={screen.availableCents} />
            <p className="mt-1 text-[11px] text-muted">
              ledger <Money cents={screen.ledgerCents} />
            </p>
            <p className="mt-1 text-[11px] text-muted">as of {header.valueDate}</p>
          </div>
        </div>

        {/* The subject, changeable HERE. Every other client screen carries the
            picker and this one did not, so a customer who had this screen open
            for the wrong business had to go to the balance, switch there, and
            navigate back — on the one screen where getting the subject wrong
            files a claim against the wrong book. */}
        <div className="mt-4 border-t border-border pt-3">
          <BusinessPicker screen="/client/disputes" view={view} header={header} />
        </div>

        <nav className="mt-4 flex flex-wrap gap-2 border-t border-border pt-3">
          {CLIENT_SCREENS.map((item) => {
            const active = item.href === "/client/disputes";
            return (
              <Link
                key={item.href}
                href={`${item.href}${clientQuery(view)}`}
                aria-current={active ? "page" : undefined}
                className={`rounded border px-2.5 py-1 text-xs ${FOCUS_RING} ${
                  active
                    ? "border-border-strong bg-surface-raised font-medium text-text"
                    : "border-border"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </header>

      <Panel
        title="Raise a claim"
        description="On a settled card payment. We file it with the card network on your behalf."
      >
        <div className="px-5 pb-5">
          <FileDisputeForm
            businessId={header.businessId}
            charges={chargeOptions}
            reasons={reasonChoices}
          />
        </div>
      </Panel>

      <Panel
        title="Your claims"
        description="Everything you have raised, and everything that has happened on it."
      >
        <div className="px-5 pb-5">
          {cases.length === 0 ? (
            <Note title="No claims">
            <p>
                You have not raised a claim on this account. When you do, it appears here with
                every step recorded against it — including the ones that are our decision rather
                than yours.
              </p>
            </Note>
          ) : (
            <ul className="mt-4 space-y-3">
              {cases.map((row) => (
                <CaseCard key={row.disputeId} row={row} />
              ))}
            </ul>
          )}
        </div>
      </Panel>

      <Panel
        title="What we can file, and what the network calls it"
        description="Your words on the left, the card network's own code on the right."
      >
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={TH_CLASS}>What went wrong</th>
                <th className={TH_CLASS}>Network code</th>
                <th className={TH_CLASS}>Their wording</th>
              </tr>
            </thead>
            <tbody>
              {reasons.map((option) => (
                <tr key={option.reason} className="border-t border-border">
                  <td className={TD_CLASS}>{option.label}</td>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{option.networkCode}</td>
                  <td className={`${TD_CLASS} text-xs text-muted`}>{option.networkLabel}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </div>
  );
}
