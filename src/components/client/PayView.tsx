import { Money } from "@/components/ui/Money";
import { Note, Panel, TableScroll, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";
import { formatUsd } from "@/lib/format/money";

import type { PayScreen } from "./contract";
import { ClientHeaderBar } from "./Chrome";
import { ClientPaymentForm, type PayeeOption, type RailOption } from "./PaymentForm";
import { railWord } from "./language";
import { clientHref, type ClientView } from "./view-state";

/**
 * Send a payment — the customer's side of the existing money-out path.
 *
 * The server half of this screen. It reads the gate, the policies and this
 * business's own payee book, turns every `bigint` into a string HERE (the form
 * below is a client component and carries no numbers on its props), and hands
 * the rest to `ClientPaymentForm`, which posts to the staff console's own
 * `raisePaymentAction`.
 *
 * The payee list is `loadPayeeBook({ businessId })` — a predicate, so the only
 * payees offered are this customer's own. There is no path on this screen to a
 * beneficiary somebody else confirmed.
 */
export function PayView({
  screen,
  view,
  prefillAtThreshold,
}: {
  readonly screen: PayScreen;
  readonly view: ClientView;
  readonly prefillAtThreshold: boolean;
}) {
  const { header, gate, policies, payees } = screen;

  const rails: readonly RailOption[] = policies.map((policy) => ({
    rail: policy.rail,
    label: railWord(policy.rail),
    thresholdDisplay: formatUsd(policy.thresholdCents),
    requiredApprovals: policy.requiredApprovals,
    note: policy.note,
  }));

  const payeeOptions: readonly PayeeOption[] = payees
    .filter((p) => !p.archived)
    .map((p) => ({
      payeeId: p.payeeId,
      label: `${p.displayName} — ${railWord(p.rail)}${
        p.accountNumberLast4 === null ? "" : `, account ending ${p.accountNumberLast4}`
      }`,
      holderName: p.holderName,
      rail: p.rail,
      routingNumber: p.routingNumber ?? "",
      accountNumberLast4: p.accountNumberLast4 ?? "",
      accountType: p.accountType ?? "",
      warned: p.outcome === "warned" && !p.acknowledged,
    }));

  // `?state=edge` prefills EXACTLY the threshold for the first rail offered, so
  // the screen demonstrates the band rather than describing it. Formatted here,
  // as a string, without grouping — a form pre-filled with "2,500.00" round
  // trips to a parse failure, which is the exact pressure that puts a float
  // back on the display path.
  const firstPolicy = policies[0];
  const amountPrefill =
    prefillAtThreshold && firstPolicy !== undefined
      ? formatUsd(firstPolicy.thresholdCents, { symbol: false, group: false })
      : null;

  return (
    <div className="space-y-6">
      <ClientHeaderBar
        screen="/client/pay"
        view={view}
        header={header}
        title="Send a payment"
        subtitle="Money leaves your account the same way it does for everyone: checked, hashed, and — above a certain size — signed off by a second person."
      />

      <Panel
        title="Payment"
        description="Nothing here moves money. Filling this in asks for a payment; a person releases it afterwards, and that is a separate act by a separate call."
      >
        {gate.allowed ? null : (
          <div className="border-b border-border px-5 py-4">
            <div className="rounded-md border border-negative/40 bg-surface-raised px-4 py-3">
              <p className="text-xs font-semibold text-negative">
                Your account cannot send money yet
              </p>
              <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                {gate.message}
              </p>
              <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                The form below is still here and its button still works. The
                check runs again inside the payment itself, so pressing send
                shows you this refusal from the server rather than from this
                page &mdash; which is the honest way round, and the same reason
                the account with no balance is still drawn rather than hidden.
              </p>
            </div>
          </div>
        )}

        <div className="px-5 py-5">
          {header.accountId === null ? (
            <p className="text-sm text-muted">
              No current account has been opened for this business yet, so there
              is nothing to pay from. An account opens when the business passes
              its checks — not before, and not by hand.
            </p>
          ) : (
            <ClientPaymentForm
              accountId={header.accountId}
              rails={rails}
              payees={payeeOptions}
              today={screen.today}
              availableDisplay={formatUsd(screen.availableCents)}
              approvalsHref={clientHref("/client/approvals", {
                businessId: view.businessId,
              })}
              amountPrefill={amountPrefill}
            />
          )}
        </div>
      </Panel>

      <Panel
        title="When somebody else has to approve"
        description="The threshold is a property of how the money travels, not of how much you trust the person sending it — and it is pinned onto the payment when you raise it, so changing the rule later cannot re-judge a payment already in the queue."
      >
        {policies.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">No policy is in force.</p>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">Approval thresholds by rail</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={TH_CLASS}>
                    How it travels
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Needs approval at
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Why
                  </th>
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr key={policy.version} className="border-b border-border">
                    <td className={TD_CLASS}>
                      <span className="font-medium">{railWord(policy.rail)}</span>
                      <span className="mt-0.5 block text-[11px] text-muted">
                        <code>{policy.version}</code>
                      </span>
                    </td>
                    <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                      {policy.requiredApprovals === 0 ? (
                        <span className="text-sm text-muted">no approval needed</span>
                      ) : policy.thresholdCents === 0n ? (
                        <span className="text-sm">every payment</span>
                      ) : (
                        <Money cents={policy.thresholdCents} tone="neutral" />
                      )}
                    </td>
                    <td className={`${TD_CLASS} max-w-prose text-xs text-muted`}>
                      {policy.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Note title="What happens after you press send">
        Your instruction is written down and locked to its own contents — the
        account, the amount, where it is going and the date — so an approval
        given for one payment cannot be moved onto another. If it is over the
        threshold it waits for a second person, and{" "}
        <strong className="font-medium text-text">
          that person can never be you
        </strong>
        , whoever you are and whatever you are allowed to do. Your bank does not
        apply that rule in software it could forget to run: the database refuses
        to record the approval at all.
      </Note>
    </div>
  );
}
