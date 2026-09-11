/**
 * `/client/funding`, rendered.
 *
 * A SERVER COMPONENT. Every `bigint` is formatted here, while the server still
 * holds it, and only text crosses into the two client forms — `bigint` does not
 * survive that serialisation and turning cents into a `number` on the way is
 * the defect this codebase has already shipped once.
 *
 * NOTHING ON THIS PAGE COMPUTES A BALANCE. The five terms below are
 * `ledger_availability()`'s, printed as they were read: ledger, card holds,
 * uncleared credits, committed out, available. They are not added up, adjusted
 * or clamped here — one definition of available, in the database, and this
 * screen is a reader of it.
 */

import type {
  ClientFundingScreen,
  LinkedBankLine,
} from "@/components/client/funding/contract";
import { FundForm, LinkBankForm, type FundChoice } from "@/components/client/funding/FundingForms";
import { formatUsd } from "@/lib/format/money";

type Action = Parameters<typeof LinkBankForm>[0]["action"];

/**
 * What each of the four states means to the person whose money it is.
 *
 * `needs_reauth` gets the longest sentence on the page and it is the only one
 * that names WHO has to act, because it is the only one where the answer is "a
 * person, at their own bank's login screen". Plaid's `ITEM_LOGIN_REQUIRED` is
 * not cleared by waiting and not cleared by a retry: Link in update mode, in a
 * browser, is the only thing that clears it. Telling somebody to "try again
 * later" there costs them their afternoon.
 */
const STATE_COPY: Record<
  LinkedBankLine["state"],
  { readonly badge: string; readonly tone: string; readonly says: string }
> = {
  healthy: {
    badge: "Working",
    tone: "border-emerald-500/40 text-emerald-700 dark:text-emerald-400",
    says: "This connection is live. Money can be pulled from the accounts listed below.",
  },
  needs_reauth: {
    badge: "Needs you to sign in again",
    tone: "border-amber-500/50 text-amber-700 dark:text-amber-400",
    says:
      "Your bank has stopped accepting this connection and is asking for a login again. A PERSON HAS TO DO THIS — somebody needs to sign in to the bank once more and re-authorise the connection, at the bank's own login screen. There is no button here that can do it for you, and waiting will not clear it. Nothing can be pulled from this account until then, and nothing on your balance has changed.",
  },
  revoked: {
    badge: "Access withdrawn",
    tone: "border-rose-500/50 text-rose-700 dark:text-rose-400",
    says:
      "Permission for this connection was removed. Re-authorising will not bring it back — this one is finished, and a new link has to be made. Nothing can be pulled from it.",
  },
  orphaned: {
    badge: "We lost the connection",
    tone: "border-border-strong text-muted",
    says:
      "This one is ours rather than yours: we no longer hold the credential for this connection, so we cannot even ask your bank whether it still works. Link the bank again and it becomes usable.",
  },
};

function Term({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.06em] text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{value}</dd>
      {note === undefined ? null : (
        <dd className="mt-0.5 text-[11px] leading-relaxed text-muted">{note}</dd>
      )}
    </div>
  );
}

export function FundingClientView({
  screen,
  linkAction,
  fundAction,
  today,
}: {
  readonly screen: ClientFundingScreen;
  readonly linkAction: Action;
  readonly fundAction: Action;
  readonly today: string;
}) {
  const { subject, banks, terms, deposits } = screen;

  const choices: readonly FundChoice[] = banks.flatMap((bank) =>
    bank.accounts.map((account) => ({
      itemId: bank.itemId,
      plaidAccountId: account.plaidAccountId,
      label: `${bank.institutionName ?? "Linked bank"} — ${account.name}${
        account.mask === null ? "" : ` ••${account.mask}`
      }`,
    })),
  );

  const attention = banks.filter((bank) => bank.state !== "healthy");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-base font-medium">Add money to your account</h1>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          {subject.legalName}
          {subject.accountName === null ? "" : ` · ${subject.accountName}`} · as of{" "}
          {subject.asOf}
        </p>
      </header>

      {/* --------------------------------------------------------------- */}
      {/* What the money is doing, in the ledger's own five terms           */}
      {/* --------------------------------------------------------------- */}
      <section className="rounded-lg border border-border-strong p-4">
        <h2 className="text-sm font-medium">Your balance, and what you can spend</h2>
        <dl className="mt-3 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
          <Term
            label="On your account"
            value={formatUsd(terms.ledgerCents)}
            note="Everything that has landed, spendable or not."
          />
          <Term
            label="Waiting to clear"
            value={formatUsd(terms.unclearedCents)}
            note="Deposits that are here but not yet yours to spend."
          />
          <Term
            label="Held for cards"
            value={formatUsd(terms.holdsCents)}
            note="Card payments authorised but not yet settled."
          />
          <Term
            label="Committed out"
            value={formatUsd(terms.pendingOutboundCents)}
            note="Payments you have already instructed."
          />
          <Term
            label="You can spend"
            value={formatUsd(terms.availableCents)}
            note="The only figure that matters at a till."
          />
        </dl>
        <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
          These five figures are the database&rsquo;s, not this page&rsquo;s.
          They come from one definition of &ldquo;available&rdquo; that every
          screen in this system reads; nothing here adds them up again.
        </p>
      </section>

      {/* --------------------------------------------------------------- */}
      {/* The two writes                                                    */}
      {/* --------------------------------------------------------------- */}
      <div className="grid gap-4 lg:grid-cols-2">
        <LinkBankForm
          businessId={subject.businessId}
          action={linkAction}
          configured={screen.plaidConfigured}
        />
        <FundForm
          businessId={subject.businessId}
          choices={choices}
          action={fundAction}
          today={today}
        />
      </div>

      {/* --------------------------------------------------------------- */}
      {/* The linked banks and their state                                  */}
      {/* --------------------------------------------------------------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">
          Your linked banks{attention.length === 0 ? "" : ` · ${attention.length} need attention`}
        </h2>
        {banks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border-strong p-4 text-xs text-muted">
            You have not linked a bank yet. Link one above and the accounts it
            lets us pull from will be listed here, along with whether the
            connection is working.
          </p>
        ) : (
          banks.map((bank) => {
            const copy = STATE_COPY[bank.state];
            return (
              <article
                key={bank.itemId}
                className={`rounded-lg border p-4 ${copy.tone.split(" ")[0]} border-border-strong`}
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <h3 className="text-sm font-medium">
                    {bank.institutionName ?? "Linked bank"}
                  </h3>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${copy.tone}`}
                  >
                    {copy.badge}
                  </span>
                  <span className="font-mono text-[10px] text-muted">{bank.itemId}</span>
                </div>
                <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
                  {copy.says}
                </p>
                {bank.lastErrorCode === null ? null : (
                  <p className="mt-1.5 text-[11px] text-muted">
                    Your bank&rsquo;s own words for it:{" "}
                    <code className="font-mono">{bank.lastErrorCode}</code>
                    {bank.lastErrorMessage === null ? "" : ` — ${bank.lastErrorMessage}`}
                  </p>
                )}
                {bank.accounts.length === 0 ? null : (
                  <ul className="mt-2.5 space-y-1">
                    {bank.accounts.map((account) => (
                      <li key={account.plaidAccountId} className="text-xs text-muted">
                        {account.name}
                        {account.mask === null ? "" : ` ••${account.mask}`}
                        {account.subtype === null ? "" : ` · ${account.subtype}`}
                        {account.routingNumber === null
                          ? ""
                          : ` · routing ${account.routingNumber}`}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[10px] text-muted">
                  Linked {bank.linkedAt ?? "—"} · last checked {bank.lastObservedAt}
                </p>
              </article>
            );
          })
        )}
      </section>

      {/* --------------------------------------------------------------- */}
      {/* What has already been pulled in, and what it really is            */}
      {/* --------------------------------------------------------------- */}
      <section>
        <h2 className="text-sm font-medium">Money you have moved in</h2>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          Each of these was <strong className="font-medium">instructed</strong>{" "}
          and written down. No payment file was sent to any bank network for
          them: the entry records the moment the pull was instructed, which is
          why the money sits on your account and out of your spendable balance
          at the same time, and every one of those entries says exactly that in
          its own description. What is listed here is the hold each deposit
          opened — the thing actually keeping the money out of your spendable
          balance — and the moment it stops.
        </p>
        {deposits.length === 0 ? (
          <p className="mt-3 rounded-lg border border-dashed border-border-strong p-4 text-xs text-muted">
            Nothing has been moved in yet.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-xs">
              <thead className="text-[11px] uppercase tracking-[0.06em] text-muted">
                <tr>
                  <th className="py-1.5 pr-4 font-medium">Moved in</th>
                  <th className="py-1.5 pr-4 font-medium">Amount</th>
                  <th className="py-1.5 pr-4 font-medium">Still held back</th>
                  <th className="py-1.5 pr-4 font-medium">Spendable from</th>
                  <th className="py-1.5 pr-4 font-medium">Reference</th>
                </tr>
              </thead>
              <tbody>
                {deposits.map((deposit) => (
                  <tr key={deposit.holdId} className="border-t border-border-strong/60">
                    <td className="py-1.5 pr-4 font-mono tabular-nums">
                      {deposit.placedAt}
                    </td>
                    <td className="py-1.5 pr-4 tabular-nums">
                      {formatUsd(deposit.amountCents)}
                    </td>
                    <td className="py-1.5 pr-4 tabular-nums">
                      {formatUsd(deposit.remainingCents)}
                    </td>
                    <td className="py-1.5 pr-4 text-muted">
                      {deposit.releaseWaitsOnAPerson
                        ? "when somebody here releases it"
                        : (deposit.availableAt ?? "already spendable")}
                    </td>
                    <td className="py-1.5 pr-4 font-mono text-[11px] text-muted">
                      {deposit.externalRef}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
