import { createLiveFundingSource } from "@/app/(app)/funding/live-source";
import { ROLE_LABEL, readRole } from "@/components/app-shell/role";
import {
  Badge,
  FieldLabel,
  MetaList,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";

import { ErrorPanel } from "./ErrorPanel";
import { FundForm } from "./FundForm";
import { FundingSkeleton } from "./FundingSkeleton";
import { ItemErrorsPanel } from "./ItemErrorsPanel";
import type {
  FundableAccountView,
  FundingDataSource,
  FundingSnapshot,
  PolicyView,
  UnclearedHoldView,
} from "./data-contract";
import { isLiveState, type FundingView as View } from "./demo-state";
import { createFixtureSource } from "./fixtures";

export { FundingSkeleton };

/**
 * `/funding` — leg two of the core loop: fund the account from a linked
 * external bank.
 *
 * ============================================================================
 * THE INTERESTING DECISION HERE IS AVAILABILITY, NOT THE TRANSFER.
 *
 * Moving a balance is arithmetic. Deciding when the customer may SPEND it is a
 * risk position, and it is the one an inbound-credit path is judged on: an ACH
 * credit can be returned days after it lands, so a bank that raises `available`
 * at the same instant it raises `ledger` has lent the customer money against an
 * entry that can still come back.
 *
 * So this screen's headline is four numbers rather than one, and the gap
 * between the first and the last is the whole product:
 *
 *   ledger              what is on the book
 *   − card holds        withheld by live authorisations
 *   − uncleared         withheld by credits inside their return window
 *   = available         what can actually be spent
 *
 * `available` is DERIVED, every time, from immutable rows. There is no balance
 * column anywhere in this schema — `pnpm db:check` fails the build if one
 * appears — so there is no second number to drift and no cron job to fix it.
 * ============================================================================
 *
 * An async server component behind the page's Suspense boundary. `default` and
 * `edge` are the live database; the other three states are fixtures so a slow
 * read, a failed read and an empty book can each be shown on demand without
 * arranging one.
 */
export async function FundingView({ view }: { readonly view: View }) {
  const role = await readRole();
  const live = isLiveState(view.state);

  const source: FundingDataSource = live
    ? createLiveFundingSource()
    : // Narrowed by `isLiveState`; the fixture source has no case for the two
      // live states because writing one would be writing a fake deposit.
      createFixtureSource(view.state as "loading" | "empty" | "error");

  const result = await source.getSnapshot();

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <Header role={role} live={live} asOf={null} environment={null} />
        <ErrorPanel error={result.error} />
      </div>
    );
  }

  const snapshot = result.value;
  const held = snapshot.accounts.flatMap((account) =>
    account.unclearedHolds.filter((hold) => !hold.released),
  );

  return (
    <div className="space-y-6">
      <Header
        role={role}
        live={live}
        asOf={snapshot.asOf}
        environment={snapshot.provider.environment}
      />

      <Note title="What this screen does, and the one thing it does not">
        <p>
          Pressing the button makes five real HTTP requests to{" "}
          <code className="font-mono">sandbox.plaid.com</code> — a link token, a sandbox public
          token, an exchange, <code className="font-mono">/accounts/get</code> and{" "}
          <code className="font-mono">/auth/get</code> — and links a real Item at a real
          institution, returning that account&rsquo;s real ACH routing and account numbers. It then
          posts one financial entry and one memo entry through{" "}
          <code className="font-mono">postEntry()</code>, in one transaction, in bigint cents.
        </p>
        <p className="mt-2">
          <span className="font-medium text-text">
            No ACH entry is transmitted to any network.
          </span>{" "}
          <code className="font-mono">POST /ach_transfers</code> is not called from this path and
          the numbers Plaid returned are not registered with an originator. The deposit is booked
          at ORIGINATION — the moment the pull is instructed — against{" "}
          <code className="font-mono">1130 ACH receivable — inbound in transit</code>, which is
          what that account exists for and is how a bank books a debit at file-cut, before the file
          goes out. <code className="font-mono">1110</code> is deliberately untouched: debiting it
          would claim real dollars arrived at the sponsor bank, and none did. The journal
          entry&rsquo;s own description says so, for ever.
        </p>
        <p className="mt-2">
          Link&rsquo;s own UI cannot be driven from a server action — it is an iframe a person
          clicks through — so the flow uses{" "}
          <code className="font-mono">POST /sandbox/public_token/create</code> instead. That is
          Plaid&rsquo;s own endpoint on Plaid&rsquo;s own servers, and the Item it creates is
          indistinguishable from one made by clicking: same id space, same access token, same
          webhooks, same <code className="font-mono">/auth/get</code> numbers, same failure modes.
          The real <code className="font-mono">link-sandbox-…</code> token is minted anyway, shown
          on the receipt, and not used.
        </p>
      </Note>

      {snapshot.accounts.length === 0 ? (
        <EmptyBook />
      ) : (
        <>
          <BalanceStrip accounts={snapshot.accounts} />

          <Panel
            id="fund"
            title="Link an external bank and fund the balance"
            description="One form, one server action, one transaction. The hold, the financial entry and the memo entry commit together or not at all — a crash between the deposit and the hold would leave the customer able to spend money that has not cleared, which is the exact failure the hold exists to prevent, so it is not a window that is made small but one that does not exist."
            actions={
              <Badge tone={live && snapshot.provider.configured ? "positive" : "quiet"}>
                {live && snapshot.provider.configured ? "LIVE" : "FIXTURE"}
              </Badge>
            }
          >
            <FundForm
              accounts={snapshot.accounts}
              policies={snapshot.policies}
              defaultValueDate={snapshot.defaultValueDate}
              prefillAmount={view.state === "edge" ? "2500.00" : null}
              live={live}
              plaidConfigured={snapshot.provider.configured}
            />
          </Panel>
        </>
      )}

      {view.state === "edge" ? <EdgeNote held={held} /> : null}

      <HoldsPanel accounts={snapshot.accounts} />

      <Panel
        id="item-errors"
        title="When the bank connection breaks"
        description="Two failures Plaid can actually produce, driven live rather than illustrated. Nothing is drawn until the button is pressed, and what is drawn is what Plaid returned."
        actions={<Badge tone={snapshot.provider.configured ? "positive" : "quiet"}>
          {snapshot.provider.configured ? "LIVE" : "UNAVAILABLE"}
        </Badge>}
      >
        <ItemErrorsPanel enabled={snapshot.provider.configured} />
      </Panel>

      <PolicyTable policies={snapshot.policies} />

      <ProviderPanel snapshot={snapshot} />

      <p className="max-w-prose text-xs leading-relaxed text-muted">
        {role === "approver"
          ? "Acting as Approver: funding is not a maker-checker action and there is no queue behind it. An inbound credit is money arriving, not money leaving — the control that matters here is not a second human, it is the return window, and it is enforced by the hold rather than by a person."
          : "Acting as Staff: funding needs no approver. The control on an inbound credit is the availability hold, not a second signature — money arriving cannot be sent to the wrong payee, and the risk it does carry is that it comes back."}
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Header                                                                     */
/* -------------------------------------------------------------------------- */

function Header({
  role,
  live,
  asOf,
  environment,
}: {
  readonly role: "staff" | "approver";
  readonly live: boolean;
  readonly asOf: string | null;
  readonly environment: string | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Funding</h1>
        <Badge tone={live ? "positive" : "quiet"}>{live ? "LIVE" : "FIXTURE"}</Badge>
      </div>
      <p className="mt-0.5 text-sm text-muted">
        Money in, from a bank the customer linked themselves — and the return window that decides
        when they may spend it.
      </p>
      <div className="mt-3">
        <MetaList
          items={[
            { label: "Acting as", value: ROLE_LABEL[role] },
            { label: "Provider", value: "Plaid" },
            ...(environment === null
              ? []
              : [{ label: "Environment", value: <span className="font-mono">{environment}</span> }]),
            ...(asOf === null ? [] : [{ label: "As of", value: formatTimestamp(asOf) }]),
          ]}
        />
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* The four numbers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Ledger, card holds, uncleared credits and available, for every account.
 *
 * The subtraction is shown rather than the answer alone, because "available" on
 * its own is a number a customer has to take on trust and "ledger − holds −
 * uncleared" is one they can check against the table below it. Every figure is
 * a string the server formatted from a `bigint`; this component performs no
 * arithmetic at all.
 */
function BalanceStrip({ accounts }: { readonly accounts: readonly FundableAccountView[] }) {
  return (
    <div className="space-y-4">
      {accounts.map((account) => (
        <section
          key={account.id}
          aria-label={`${account.businessName} balances`}
          className="rounded-lg border border-border bg-surface"
        >
          <header className="border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold tracking-tight">{account.businessName}</h2>
            <p className="mt-0.5 text-xs text-muted">{account.accountName}</p>
          </header>
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-5">
            <Figure
              label="Ledger balance"
              value={account.balance.ledgerDisplay}
              hint="Settled on the book, at today's value date."
            />
            <Figure
              label="− Card holds"
              value={account.balance.cardHoldsDisplay}
              hint="Withheld by live card authorisations."
            />
            <Figure
              label="− Uncleared"
              value={account.balance.unclearedDisplay}
              hint="Inbound credits still inside their return window."
              emphasis={account.balance.unclearedDisplay !== "$0.00"}
            />
            <Figure
              label="− Committed out"
              value={account.balance.pendingOutboundDisplay}
              hint="Debits booked for a future value date. Already gone."
              emphasis={account.balance.pendingOutboundDisplay !== "$0.00"}
            />
            <Figure
              label="= Available"
              value={account.balance.availableDisplay}
              hint="What can actually be spent. Derived, never stored."
              negative={account.balance.availableIsNegative}
              strong
            />
          </div>
        </section>
      ))}
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  strong = false,
  negative = false,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
  readonly strong?: boolean;
  readonly negative?: boolean;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <FieldLabel>{label}</FieldLabel>
      <p
        className={`money mt-1 text-xl tabular-nums ${strong ? "font-semibold" : ""} ${
          negative ? "text-negative" : emphasis ? "text-text" : ""
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{hint}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Holds                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every uncleared-credit hold, itemised, with the day and the moment it
 * releases.
 *
 * The release is a property of the DATABASE, not of a job. `v_hold_state`'s
 * release predicate already contains
 * <code>kind = 'uncleared_credit' AND now() &gt;= available_at</code>, so
 * available rises on the clock with nothing running at all. The sweep in
 * `releaseAvailableCredits()` exists to write the `hold_closure` row and post
 * the memo entry that drives the 9200 leaf back to zero — bookkeeping that
 * makes every reader agree, not the thing that frees the money.
 */
function HoldsPanel({ accounts }: { readonly accounts: readonly FundableAccountView[] }) {
  const rows = accounts.flatMap((account) =>
    account.unclearedHolds.map((hold) => ({ account, hold })),
  );

  return (
    <Panel
      id="holds"
      title="Uncleared credits, itemised"
      description="Each row is one inbound credit that is on the book and not yet spendable, with the funds_availability_policy row it was created under and the exact instant it releases. A hold created in March is still explainable in December after the policy changed, because the hold cites a row and the row is still there."
    >
      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-medium">No credit is being held right now.</p>
          <p className="mx-auto mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
            Not an error, and not a claim that holds do not happen — it means every inbound credit
            on this book has passed its availability moment. Fund an account above and this table
            gains a row with a release date in the future.
          </p>
        </div>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={TH_CLASS}>
                  Account
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Held
                </th>
                <th scope="col" className={TH_CLASS}>
                  Releases
                </th>
                <th scope="col" className={TH_CLASS}>
                  Policy
                </th>
                <th scope="col" className={TH_CLASS}>
                  Source
                </th>
                <th scope="col" className={TH_CLASS}>
                  State
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ account, hold }) => (
                <HoldRowView key={hold.holdId} businessName={account.businessName} hold={hold} />
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

function HoldRowView({
  businessName,
  hold,
}: {
  readonly businessName: string;
  readonly hold: UnclearedHoldView;
}) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className={TD_CLASS}>
        <div>{businessName}</div>
        <div className="font-mono text-[11px] text-muted">{hold.holdId}</div>
      </td>
      <td className={`${TD_CLASS} money text-right font-medium`}>{hold.amountDisplay}</td>
      <td className={TD_CLASS}>
        {hold.releaseDate === null ? (
          <span className="text-muted">—</span>
        ) : (
          <>
            <div>{formatDate(hold.releaseDate)}</div>
            <div className="font-mono text-[11px] text-muted">{hold.availableAt}</div>
          </>
        )}
      </td>
      <td className={TD_CLASS}>
        {hold.policy === null ? (
          <span className="text-muted">—</span>
        ) : (
          <span className="font-mono text-xs">
            {hold.policy.rail}/{hold.policy.counterpartyClass} · {hold.policy.bankingDaysHold}{" "}
            {hold.policy.bankingDaysHold === 1 ? "day" : "days"} · {hold.policy.releaseLocalTime} ET
          </span>
        )}
      </td>
      <td className={TD_CLASS}>
        {hold.itemId === null ? (
          <span className="font-mono text-[11px] break-all text-muted">{hold.externalRef}</span>
        ) : (
          <>
            <div className="font-mono text-[11px] break-all">{hold.itemId}</div>
            <div className="font-mono text-[11px] break-all text-muted">{hold.plaidAccountId}</div>
          </>
        )}
      </td>
      <td className={TD_CLASS}>
        {hold.released ? (
          <Badge tone="quiet" {...(hold.closedReason === null ? {} : { title: hold.closedReason })}>
            released
          </Badge>
        ) : (
          <Badge tone="negative">withholding</Badge>
        )}
      </td>
    </tr>
  );
}

/* -------------------------------------------------------------------------- */
/* The edge state                                                             */
/* -------------------------------------------------------------------------- */

function EdgeNote({ held }: { readonly held: readonly UnclearedHoldView[] }) {
  const first = held[0];

  return (
    <Note emphasis title="The edge case: funded, and not yet available">
      {first === undefined ? (
        <p>
          <span className="font-medium text-text">
            There is no credit inside its return window on this book right now,
          </span>{" "}
          so there is nothing to show and this state will not draw a hold that does not exist. Fund
          an account with the form above — the button is prefilled with $2,500.00 — and come back:
          the ledger figure will be up by the full amount, available will be exactly where it was,
          and the hold will appear in the table below with the banking day and the 09:00 ET instant
          it releases on.
        </p>
      ) : (
        <>
          <p>
            <span className="font-medium text-text">
              {first.amountDisplay} is on the book and cannot be spent.
            </span>{" "}
            The ledger balance includes it in full. Available excludes it in full. The difference
            is not a rounding artefact or a pending state — it is an{" "}
            <code className="font-mono">uncleared_credit</code> hold, hold id{" "}
            <code className="font-mono">{first.holdId}</code>, and it releases on{" "}
            <span className="font-medium text-text">{first.releaseDate}</span> at{" "}
            <code className="font-mono">{first.availableAt}</code>.
          </p>
          <p className="mt-2">
            Nothing runs to make that happen. <code className="font-mono">v_hold_state</code>
            &rsquo;s release predicate already reads{" "}
            <code className="font-mono">
              kind = &apos;uncleared_credit&apos; AND now() &gt;= available_at
            </code>
            , so available rises on the clock whether or not any sweep ever executes. The sweep
            writes the closure row and posts the memo entry that returns the 9200 leaf to zero, so
            that every reader — including{" "}
            <code className="font-mono">availableBalance()</code>, whose predicate is closure-only
            — agrees about the same hold. Running it never is safe; the customer&rsquo;s available
            balance is already correct.
          </p>
          {first.policy === null ? null : (
            <p className="mt-2">
              The hold cites the policy row it was created under —{" "}
              <code className="font-mono">
                {first.policy.rail}/{first.policy.counterpartyClass}
              </code>
              , {first.policy.bankingDaysHold} banking{" "}
              {first.policy.bankingDaysHold === 1 ? "day" : "days"} at{" "}
              {first.policy.releaseLocalTime} ET — so raising the hold period tomorrow cannot
              retroactively change how long this credit was held. The table is append-only and
              effective-dated, and the version that judged a credit is chosen by its value date and
              never by today.
            </p>
          )}
        </>
      )}
    </Note>
  );
}

/* -------------------------------------------------------------------------- */
/* Panels                                                                     */
/* -------------------------------------------------------------------------- */

function EmptyBook() {
  return (
    <Panel title="Link an external bank and fund the balance" description="There is nothing to fund.">
      <div className="px-5 py-10 text-center">
        <p className="text-sm font-medium">No deposit account on this book can receive a credit.</p>
        <p className="mx-auto mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
          Not an error. A deposit account exists only after a business has been onboarded, and a
          business with no account has nowhere for an inbound credit to land — which is the
          structural half of the same gate the KYB check enforces explicitly. Start a verification
          on <code className="font-mono">/onboarding</code> and this form will have a destination.
        </p>
      </div>
    </Panel>
  );
}

/**
 * Every version of every rail's availability policy.
 *
 * Shown in full because that is the whole argument for effective dating:
 * `funds_availability_policy` is append-only, a change is a new row with a
 * later `effective_from`, and both rows exist for ever. A hold stores the id of
 * the row it was created under, so changing the ACH hold period tomorrow cannot
 * make a credit booked today look as though it was held for a different time.
 */
function PolicyTable({ policies }: { readonly policies: readonly PolicyView[] }) {
  return (
    <Panel
      id="policies"
      title="Funds availability policy, every row"
      description="The policy is DATA, not a branch in a webhook handler. Nothing in the code decides how long to hold anything: it reads banking_days_hold and release_local_time off a row and answers which instant that is."
    >
      <TableScroll>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={TH_CLASS}>
                Rail
              </th>
              <th scope="col" className={TH_CLASS}>
                Counterparty
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Banking days
              </th>
              <th scope="col" className={TH_CLASS}>
                Releases at
              </th>
              <th scope="col" className={TH_CLASS}>
                Why
              </th>
            </tr>
          </thead>
          <tbody>
            {policies.map((policy) => (
              <tr key={policy.id} className="border-b border-border last:border-b-0">
                <td className={`${TD_CLASS} font-mono`}>{policy.rail}</td>
                <td className={`${TD_CLASS} font-mono`}>{policy.counterpartyClass}</td>
                <td className={`${TD_CLASS} money text-right`}>{policy.bankingDaysHold}</td>
                <td className={`${TD_CLASS} font-mono text-xs`}>{policy.releaseLocalTime} ET</td>
                <td className={`${TD_CLASS} max-w-prose text-xs leading-relaxed text-muted`}>
                  {policy.note}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}

/**
 * What is known about the provider without calling it.
 *
 * `configured` is a fact about this deployment's environment and it is labelled
 * as exactly that. It is not a claim that Plaid is reachable, and this panel
 * deliberately does not probe: every claim about Plaid's behaviour on this
 * screen comes from a button somebody pressed and prints the request id that
 * came back.
 */
function ProviderPanel({ snapshot }: { readonly snapshot: FundingSnapshot }) {
  return (
    <Panel
      id="provider"
      title="The provider slot"
      description="Credentials present, environment, and where this deployment's Items are told to send their webhooks. Nothing here is a health check — a green tick that only means an environment variable is set is the failure this codebase keeps catching."
    >
      <div className="px-5 py-4">
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[14rem_1fr]">
          <dt className="text-muted">Credentials present</dt>
          <dd>
            {snapshot.provider.configured ? (
              <Badge tone="positive">PLAID_CLIENT_ID and PLAID_SECRET are set</Badge>
            ) : (
              <Badge tone="negative">absent — nothing on this screen can be linked</Badge>
            )}
          </dd>

          <dt className="text-muted">Environment</dt>
          <dd className="font-mono">{snapshot.provider.environment}</dd>

          <dt className="text-muted">Item webhook URL</dt>
          <dd className="break-all font-mono">
            {snapshot.provider.webhookUrl ?? (
              <span className="font-sans text-muted">
                none — Items created here would receive no webhooks
              </span>
            )}
          </dd>

          <dt className="text-muted">Webhook verification</dt>
          <dd className="max-w-prose">
            ES256 JWT in the <code className="font-mono">Plaid-Verification</code> header, checked
            against a key fetched from Plaid per <code className="font-mono">kid</code>, with a
            five-minute freshness window and a constant-time body hash. It lives in{" "}
            <code className="font-mono">src/lib/webhooks/route-handler.ts</code> and this screen
            does not re-implement it — a second copy is how the fifth provider gets verified
            differently from the first four.
          </dd>

          <dt className="text-muted">Not stored</dt>
          <dd className="max-w-prose">
            The Plaid <code className="font-mono">access_token</code>. This schema has no{" "}
            <code className="font-mono">plaid_item</code> table and adding one needs a migration
            this worker does not own, so the token is used for the two reads inside one server
            action and dropped. The durable record of the linkage is the{" "}
            <code className="font-mono">external_ref</code> on the money rows —{" "}
            <code className="font-mono">plaid:&lt;item&gt;:&lt;account&gt;:&lt;reference&gt;</code>{" "}
            — which is genuinely immutable, and genuinely means an Item that has never funded
            anything is not stored at all. See <code className="font-mono">docs/FUNDING.md</code>.
          </dd>
        </dl>
      </div>
    </Panel>
  );
}
