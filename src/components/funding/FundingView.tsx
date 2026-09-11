import Link from "next/link";

import { ROLE_LABEL, readRole, type Role } from "@/components/app-shell/role";
import {
  Badge,
  FieldLabel,
  FOCUS_RING,
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
import { LinkPanel } from "./LinkPanel";
import type {
  BusinessView,
  FundableAccountView,
  FundingDataSource,
  FundingSnapshot,
  PolicyView,
  TransactGateView,
  UnclearedHoldView,
} from "./data-contract";
import { demoQuery, isLiveState, type FundingView as View } from "./demo-state";
import { createFixtureSource } from "./fixtures";
import { FUNDING_SCREEN_UNREADABLE, createUnreadableFundingSource } from "./unreadable";

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
 * ============================================================================
 * ANY BUSINESS, NOT THE ONE THIS WAS BUILT AGAINST
 * ============================================================================
 *
 * The screen is pointed at a customer by `?business=<uuid>` — the lever
 * `/accounts`, `/pots`, `/payouts` and `/disputes` already use — and at the
 * first business that may transact and has an account when the query string
 * says nothing. Whichever is selected, the KYB gate is read for it and printed
 * with its code, exactly as `/payments` does, and the form for a business that
 * may not transact is refused at the write rather than merely hidden.
 *
 * The gate table lists EVERY business on the book, not every deposit account,
 * because a business that has never had an account opened is invisible to an
 * account-shaped list — and "why can I not fund this one" is a question the
 * screen has to be able to answer about a customer that has nothing yet.
 *
 * An async server component behind the page's Suspense boundary. `default` and
 * `edge` are the live database; the other three states are fixtures so a slow
 * read, a failed read and an empty book can each be shown on demand without
 * arranging one.
 */
export async function FundingView({
  view,
  noDatabase = false,
}: {
  readonly view: View;
  readonly noDatabase?: boolean;
}) {
  const role = await readRole();
  const live = isLiveState(view.state);

  const source = await selectSource(view, live, noDatabase);

  const result = await source.getSnapshot(view.businessId);

  if (isErr(result)) {
    // No source badge on a refusal. `LIVE` over a screen that opened no
    // connection is the claim this repair exists to withdraw, and the four
    // balance figures it would sit above were never read.
    return (
      <div className="space-y-6">
        <Header role={role} live={null} asOf={null} environment={null} selected={null} />
        <ErrorPanel error={result.error} />
      </div>
    );
  }

  const snapshot = result.value;
  const selected =
    snapshot.businesses.find((business) => business.id === snapshot.selectedBusinessId) ?? null;
  const held = snapshot.accounts.flatMap((account) =>
    (account.unclearedHolds ?? []).filter((hold) => !hold.released),
  );

  return (
    <div className="space-y-6">
      <Header
        role={role}
        live={live}
        asOf={snapshot.asOf}
        environment={snapshot.provider.environment}
        selected={selected}
      />

      <BusinessPicker view={view} businesses={snapshot.businesses} selected={selected} />

      {selected === null ? null : <SelectedGateNote business={selected} />}

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

      <GatePanel businesses={snapshot.businesses} selectedId={snapshot.selectedBusinessId} />

      <Panel
        id="link"
        title="Step one — link an external bank"
        description="The first half of the leg, on its own, for any business the gate allows. It creates a real Plaid Item and prints what came back. It posts nothing: no journal entry, no hold, no balance movement. Nothing here runs on render and nothing polls — every Plaid call on this screen is behind a press, because linking creates real objects at a provider that rations its sandbox."
        actions={
          <Badge tone={live && snapshot.provider.configured ? "positive" : "quiet"}>
            {live && snapshot.provider.configured ? "LIVE" : "UNAVAILABLE"}
          </Badge>
        }
      >
        {selected === null ? (
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium">No business is on this book to link a bank for.</p>
          </div>
        ) : (
          <LinkPanel
            businessId={selected.id}
            businessName={selected.legalName}
            enabled={live && snapshot.provider.configured && selected.gate.allowed}
            disabledReason={
              !selected.gate.allowed
                ? `${selected.legalName} may not transact — ${selected.gate.code}. No Item will be created in its name. Resolve the verification on /onboarding first.`
                : !snapshot.provider.configured
                  ? "Plaid holds no credentials in this deployment, so nothing can be linked. The button is disabled rather than failing halfway."
                  : "Demo fixture. Nothing is linked from a state with no live business behind it."
            }
          />
        )}
      </Panel>

      {snapshot.accounts.length === 0 ? (
        <EmptyBook />
      ) : (
        <>
          <BalanceStrip accounts={snapshot.accounts} selectedId={snapshot.selectedBusinessId} />

          <Panel
            id="fund"
            title="Step two — fund the balance from it"
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
              selectedBusinessId={snapshot.selectedBusinessId}
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
  selected,
}: {
  // `Role`, not the two operator roles spelled out. A customer never reaches
  // this screen — src/middleware.ts answers 403 OPERATOR_ONLY before it renders
  // — so narrowing here would be a second, weaker copy of that decision living
  // in a prop type, and the two would drift.
  readonly role: Role;
  // `null` means "this render read nothing, so it badges nothing". LIVE and
  // FIXTURE are both claims about where four balance figures came from, and a
  // refusal has no figures and no claim.
  readonly live: boolean | null;
  readonly asOf: string | null;
  readonly environment: string | null;
  readonly selected: BusinessView | null;
}) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Funding</h1>
        {live === null ? null : (
          <Badge tone={live ? "positive" : "quiet"}>{live ? "LIVE" : "FIXTURE"}</Badge>
        )}
      </div>
      <p className="mt-0.5 text-sm text-muted">
        Money in, from a bank the customer linked themselves — and the return window that decides
        when they may spend it.
      </p>
      <div className="mt-3">
        <MetaList
          items={[
            { label: "Acting as", value: ROLE_LABEL[role] },
            ...(selected === null
              ? []
              : [
                  { label: "Business", value: selected.legalName },
                  {
                    label: "Business id",
                    value: <span className="font-mono text-[11px]">{selected.id}</span>,
                  },
                ]),
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
/* Choosing the customer                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Which business this screen is pointed at — a row of links, and nothing more.
 *
 * Selection is a URL, not a session and not a form: every entry is a plain
 * `href` to `/funding?business=<id>` carrying the current demo state, so the
 * view somebody is looking at can be pasted into a message and reproduces
 * exactly. That is the same contract the demo-state bar keeps and the same
 * lever `/accounts?business=` already had.
 *
 * SELECTING A BUSINESS GRANTS NOTHING. Every row is clickable, including ones
 * the gate refuses, because "why can I not fund this customer" is a question the
 * screen has to be able to answer — and it answers it by showing the refusal
 * with its code rather than by hiding the customer. The permission is decided by
 * `canTransact()` at the write, never by which link was pressed.
 */
function BusinessPicker({
  view,
  businesses,
  selected,
}: {
  readonly view: View;
  readonly businesses: readonly BusinessView[];
  readonly selected: BusinessView | null;
}) {
  if (businesses.length === 0) return null;

  return (
    <aside
      aria-label="Business"
      className="rounded-lg border border-border bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Business
        </span>
        <div className="flex flex-wrap items-center gap-1">
          {businesses.map((business) => {
            const current = business.id === selected?.id;
            return (
              <Link
                key={business.id}
                href={`/funding${demoQuery({ state: view.state, businessId: business.id })}`}
                aria-current={current ? "page" : undefined}
                title={business.gate.message}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {business.legalName}
                <span className={business.gate.allowed ? "ml-1.5 text-positive" : "ml-1.5 text-negative"}>
                  {business.gate.allowed ? "✓" : (business.gate.code ?? "refused")}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        <code className="font-mono">?business=&lt;uuid&gt;</code> selects the customer, the same
        lever <code className="font-mono">/accounts</code>, <code className="font-mono">/pots</code>
        , <code className="font-mono">/payouts</code> and <code className="font-mono">/disputes</code>{" "}
        honour. It composes with <code className="font-mono">?state=</code>, it is matched against
        the businesses actually on the book, and it grants nothing — the KYB gate is read for
        whichever business is selected and read again inside the write path.
      </p>
    </aside>
  );
}

/**
 * The selected business's gate, said plainly, above everything else.
 *
 * A refusal has to be the first thing on the screen for the customer it applies
 * to, not a cell in a table further down that somebody has to find. This is the
 * same decision `canTransact()` made, with the same code, in the same words
 * `/payments` uses.
 */
function SelectedGateNote({ business }: { readonly business: BusinessView }) {
  if (business.gate.allowed) {
    return (
      <Note title={`${business.legalName} may transact`}>
        <p>
          {business.gate.message} Status{" "}
          <code className="font-mono">{business.gate.status ?? "—"}</code>, evidence{" "}
          <code className="font-mono">{business.gate.evidence ?? "—"}</code>.{" "}
          {business.depositAccountId === null ? (
            <>
              No deposit account has been opened for it yet, so there is nowhere for an inbound
              credit to land. Open one on <code className="font-mono">/onboarding</code>.
            </>
          ) : (
            <>
              Deposit account <code className="font-mono">{business.depositAccountId}</code> is open
              and can receive a credit.
            </>
          )}
        </p>
        {business.gateIfLiveRequired.allowed ? null : (
          <p className="mt-2">
            Under the stricter policy a real-money deployment would run —{" "}
            <code className="font-mono">requireLiveEvidence: true</code> — this same business is
            refused <code className="font-mono">{business.gateIfLiveRequired.code}</code>. Both
            answers are shown because the deployment&rsquo;s policy is a choice, and a screen that
            only printed the permissive one would be hiding which choice was made.
          </p>
        )}
      </Note>
    );
  }

  return (
    <section
      aria-labelledby="funding-gate-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 id="funding-gate-title" className="text-sm font-semibold tracking-tight text-negative">
            {business.legalName} may not transact
          </h2>
          <code className="font-mono text-xs text-negative">{business.gate.code}</code>
        </div>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{business.gate.message}</p>
      </div>
      <div className="px-5 py-4">
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted">KYB status</dt>
          <dd className="font-mono">{business.gate.status ?? "(none on file)"}</dd>
          <dt className="text-muted">Evidence</dt>
          <dd className="font-mono">{business.gate.evidence ?? "(none on file)"}</dd>
          <dt className="text-muted">Deposit account</dt>
          <dd className="font-mono break-all">
            {business.depositAccountId ?? "(none opened)"}
          </dd>
          <dt className="text-muted">What happens if you post anyway</dt>
          <dd className="max-w-prose">
            The same refusal, from the server. The gate is re-read in{" "}
            <code className="font-mono">fundFromExternalBankAction</code> before a single byte goes
            to Plaid, so a hand-assembled POST to this route is refused{" "}
            <code className="font-mono">{business.gate.code}</code> without creating an Item and
            without posting an entry. Hiding the form is a courtesy; the gate is the control.
          </dd>
        </dl>
        <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted">
          Funding is transacting. Money arriving raises a customer liability and can be returned for
          days afterwards, so the brief&rsquo;s rule — unverified entities can look but not transact
          — has no inbound exemption. Resolve the verification on{" "}
          <Link
            href="/onboarding"
            className={`underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            /onboarding
          </Link>
          .
        </p>
      </div>
    </section>
  );
}

/**
 * EVERY business on the book, gated — not every deposit account.
 *
 * The shape `/payments` uses, with one deliberate difference: the rows come from
 * `business` rather than from the account list, so a customer who has never had
 * an account opened still appears. An account-shaped table simply omits such a
 * business, and an omission is indistinguishable from a bug to whoever is asking
 * about it.
 *
 * Both columns are the same call under two policies, as on `/payments`: what
 * this deployment does, and what a deployment requiring live third-party
 * evidence would do. Printing only the first would be quietly choosing the
 * permissive answer on the reader's behalf.
 */
function GatePanel({
  businesses,
  selectedId,
}: {
  readonly businesses: readonly BusinessView[];
  readonly selectedId: string | null;
}) {
  return (
    <Panel
      id="gate"
      title="The KYB gate, read for every business on the book"
      description="A preview, not the control. The gate that decides runs inside the funding action, before anything is sent to Plaid — so a business approved when this page rendered and revoked a second later is refused at the write, which is the only place it matters. Every refusal code in this table is resolved in one place: /onboarding, which holds the evidence each code is about and the form that adds to it."
    >
      {businesses.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm font-medium">No business has been onboarded yet.</p>
        </div>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={TH_CLASS}>
                  Business
                </th>
                <th scope="col" className={TH_CLASS}>
                  Status
                </th>
                <th scope="col" className={TH_CLASS}>
                  Evidence
                </th>
                <th scope="col" className={TH_CLASS}>
                  Deposit account
                </th>
                <th scope="col" className={TH_CLASS}>
                  This deployment
                </th>
                <th scope="col" className={TH_CLASS}>
                  If live evidence were required
                </th>
              </tr>
            </thead>
            <tbody>
              {businesses.map((business) => (
                <tr
                  key={business.id}
                  className={`border-b border-border last:border-b-0 ${
                    business.id === selectedId ? "bg-surface-raised" : ""
                  }`}
                >
                  <td className={TD_CLASS}>
                    <div>{business.legalName}</div>
                    <div className="font-mono text-[11px] text-muted">{business.id}</div>
                  </td>
                  <td className={`${TD_CLASS} font-mono text-xs`}>{business.gate.status ?? "—"}</td>
                  <td className={`${TD_CLASS} font-mono text-xs`}>
                    {business.gate.evidence ?? "—"}
                  </td>
                  <td className={TD_CLASS}>
                    {business.depositAccountId === null ? (
                      <span className="text-muted">none opened</span>
                    ) : (
                      <span className="font-mono text-[11px] break-all">
                        {business.depositAccountId}
                      </span>
                    )}
                  </td>
                  <td className={TD_CLASS}>
                    <GateCell gate={business.gate} />
                  </td>
                  <td className={TD_CLASS}>
                    <GateCell gate={business.gateIfLiveRequired} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </Panel>
  );
}

function GateCell({ gate }: { readonly gate: TransactGateView }) {
  return gate.allowed ? (
    <Badge tone="positive">may be funded</Badge>
  ) : (
    <code className="font-mono text-xs text-negative" title={gate.message}>
      {gate.code}
    </code>
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
function BalanceStrip({
  accounts,
  selectedId,
}: {
  readonly accounts: readonly FundableAccountView[];
  readonly selectedId: string | null;
}) {
  // The selected customer first. Every account stays on the page — funding is a
  // book-wide screen and the form can target any of them — but the one the URL
  // points at is the one the reader came for.
  const ordered = [...accounts].sort((a, b) => {
    const aSelected = a.businessId === selectedId ? 0 : 1;
    const bSelected = b.businessId === selectedId ? 0 : 1;
    return aSelected - bSelected || a.businessName.localeCompare(b.businessName);
  });

  return (
    <div className="space-y-4">
      {ordered.map((account) => (
        <section
          key={account.id}
          aria-label={`${account.businessName} balances`}
          className={`rounded-lg border bg-surface ${
            account.businessId === selectedId ? "border-border-strong" : "border-border"
          }`}
        >
          <header className="border-b border-border px-5 py-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h2 className="text-sm font-semibold tracking-tight">{account.businessName}</h2>
              {account.gate.allowed ? null : (
                <code className="font-mono text-[11px] text-negative" title={account.gate.message}>
                  {account.gate.code}
                </code>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted">{account.accountName}</p>
          </header>

          {account.balance === null ? (
            <div className="px-5 py-6">
              <p className="text-sm font-medium text-negative">
                This account&rsquo;s balances could not be read.
              </p>
              <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                {account.readError?.message ??
                  "No detail came back with the failure, which is itself the fact worth reporting."}
              </p>
              <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
                No figure is shown rather than a zero standing in for one, and the rest of this book
                is unaffected: a read that fails for one customer is one customer&rsquo;s failure,
                not the screen&rsquo;s. Nothing was funded — this is a read.
              </p>
            </div>
          ) : (
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
          )}
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
    (account.unclearedHolds ?? []).map((hold) => ({ account, hold })),
  );
  const unread = accounts.filter((account) => account.unclearedHolds === null);

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

      {unread.length === 0 ? null : (
        <p className="border-t border-border px-5 py-3 text-xs leading-relaxed text-muted">
          {unread.map((account) => account.businessName).join(", ")} could not be read, so no hold
          is listed for{" "}
          {unread.length === 1 ? "that account" : "those accounts"} — an omission that is stated
          rather than left to look like an empty result.
        </p>
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
        {hold.neverReleases ? (
          // `available_at = infinity`. Not a missing date and not a bug: a
          // dispute's provisional credit is released by a person deciding the
          // case, never by a clock. Printing a date here would be inventing one,
          // and formatting this value as one is what took the screen down.
          <>
            <div className="font-medium">on a decision, not a clock</div>
            <div className="font-mono text-[11px] text-muted">available_at = infinity</div>
          </>
        ) : hold.releaseDate === null ? (
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

/**
 * Which source answers this view.
 *
 * Live for `default` and `edge`, fixture for the other three — and a REFUSAL
 * for the two live states when there is no database to read.
 *
 * THE LIVE MODULE IS IMPORTED DYNAMICALLY, AND THAT IS THE REPAIR. It used to
 * be a static `import { createLiveFundingSource } from "@/app/(app)/funding/live-source"`
 * at the top of this file. That module opens with `import { sql } from "@/lib/ledger/db"`,
 * which reaches `@/lib/env`, which throws `EnvironmentError` at module scope
 * without `APP_DATABASE_URL` — deliberately, so a malformed database URL kills
 * the process at boot rather than at the first request that needs money. A
 * static import therefore took the whole page module down with it, including
 * the three fixture states that need no database at all. Measured with the
 * variable deleted, `/funding` rendered the framework's error page.
 *
 * Deferring it means the screen can render the words "no database configured".
 * `noDatabase` is resolved in `page.tsx` by `@/lib/has-database`, which imports
 * nothing, so the question cannot be the thing that crashes for the condition
 * it asks about.
 *
 * The three drawn states are checked FIRST and stay drawn either way: they are
 * demonstrations, and "no database" does not make a drawing any more or less
 * drawn.
 */
async function selectSource(
  view: View,
  live: boolean,
  noDatabase: boolean,
): Promise<FundingDataSource> {
  // Narrowed by `isLiveState`; the fixture source has no case for the two live
  // states because writing one would be writing a fake deposit.
  if (!live) return createFixtureSource(view.state as "loading" | "empty" | "error");

  if (noDatabase) return createUnreadableFundingSource(FUNDING_SCREEN_UNREADABLE);

  const { createLiveFundingSource } = await import("@/app/(app)/funding/live-source");
  return createLiveFundingSource();
}
