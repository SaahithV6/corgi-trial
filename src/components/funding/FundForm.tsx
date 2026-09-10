"use client";

import { useActionState, useId, useState } from "react";

import {
  fundFromExternalBankAction,
  type CallView,
  type FundResult,
  type FundingReceiptView,
} from "@/app/(app)/funding/actions";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";

import type { FundableAccountView, PolicyView } from "./data-contract";

/**
 * The form that links a real external bank and books a real deposit.
 *
 * ============================================================================
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DO, AND DOES NOT.
 *
 * 1. IT PERFORMS NO ARITHMETIC ON MONEY. There is not a cent count on its
 *    props: balances arrive as strings the server already formatted, and the
 *    amount is the literal characters somebody typed, sent as text. Whether the
 *    deposit raises `available` is decided by `readBalanceCents()` summing
 *    immutable rows in Postgres — the same reader that produced the headline
 *    figures above this form, deliberately — and the answer comes back on the
 *    receipt as two formatted figures. The browser is never told a number it could
 *    subtract, because a browser that can compute the available balance is a
 *    browser that can compute it wrong.
 *
 * 2. IT DOES NOT DECIDE THE HOLD PERIOD. The policy table is rendered so the
 *    reader can see which row will be chosen, and the note under the class
 *    selector quotes it — but the row that actually judges the deposit is
 *    selected inside the write path by `effectiveAvailabilityPolicy()`, by
 *    VALUE DATE, in the same transaction that opens the hold. The receipt
 *    prints the `policy_id` that was really pinned.
 *
 * 3. IT IS NOT THE VALIDATION. The `required` attributes and the `pattern`s are
 *    conveniences for somebody filling this in at speed. Every one of them is
 *    re-decided on the server, and a POST assembled by hand with none of these
 *    fields reaches exactly the same refusals. See the header of `actions.ts`.
 * ============================================================================
 */

const IDLE: FundResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  receipt: null,
  calls: null,
};

const FIXTURE_NOTE =
  "Demo fixture. Deposits are only booked from the live screen — this state has no live account behind it and no Plaid credentials in front of it, and the screen will not pretend otherwise.";

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

const CLASS_LABEL: Record<string, string> = {
  self: "Self — the customer's own verified external account",
  known: "Known — seen at least 3 times over at least 60 days",
  new: "New — a counterparty we have not seen before",
};

const SUBTYPE_LABEL: Record<string, string> = {
  checking: "Checking",
  savings: "Savings",
  "cash management": "Cash management",
};

const COUNTERPARTY_CLASSES = ["self", "known", "new"] as const;
const SUBTYPES = ["checking", "savings", "cash management"] as const;

/**
 * The ACH policy row that will judge a deposit dated this day, for this class.
 *
 * A PREDICTION, and labelled as one. It is the identical selection Postgres
 * makes in `effectiveAvailabilityPolicy()` — the newest row for the rail and
 * class whose `effective_from` is on or before the value date — but the row the
 * hold pins is chosen inside the transaction, and the receipt prints the id
 * that was actually written. The effective date is not carried on the contract,
 * so this matches on rail and class alone and says so.
 */
function predictedPolicy(
  policies: readonly PolicyView[],
  counterpartyClass: string,
): PolicyView | null {
  return (
    policies.find(
      (policy) => policy.rail === "ach" && policy.counterpartyClass === counterpartyClass,
    ) ?? null
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint === undefined ? null : (
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">{hint}</p>
      )}
    </div>
  );
}

export type FundFormProps = {
  readonly accounts: readonly FundableAccountView[];
  readonly policies: readonly PolicyView[];
  readonly defaultValueDate: string;
  /** Prefilled amount and reference on the edge state. */
  readonly prefillAmount: string | null;
  /** False on the fixture demo states, and when Plaid holds no credentials. */
  readonly live: boolean;
  readonly plaidConfigured: boolean;
};

export function FundForm({
  accounts,
  policies,
  defaultValueDate,
  prefillAmount,
  live,
  plaidConfigured,
}: FundFormProps) {
  const [state, formAction, pending] = useActionState(fundFromExternalBankAction, IDLE);

  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [counterpartyClass, setCounterpartyClass] = useState<string>("self");
  const [valueDate, setValueDate] = useState(defaultValueDate);

  const accountFieldId = useId();
  const amountFieldId = useId();
  const valueDateFieldId = useId();
  const classFieldId = useId();
  const subtypeFieldId = useId();
  const referenceFieldId = useId();

  const policy = predictedPolicy(policies, counterpartyClass);
  const submittable = live && plaidConfigured && accounts.length > 0;

  return (
    <form action={formAction} className="space-y-5 px-5 py-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Fund into"
          hint="The customer deposit account (2100) the inbound credit lands in. Resolved again on the server; nothing the browser says about it is believed."
        >
          <select
            id={accountFieldId}
            name="accountId"
            required
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={pending || accounts.length === 0}
            className={INPUT_CLASS}
          >
            {accounts.length === 0 ? <option value="">No account available</option> : null}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.businessName} — available {account.balance.availableDisplay}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Amount (USD)"
          hint="Typed as dollars and cents, sent as text, converted to integer cents by string arithmetic on the server. There is no parseFloat anywhere on this path."
        >
          <input
            id={amountFieldId}
            name="amount"
            type="text"
            inputMode="decimal"
            required
            autoComplete="off"
            placeholder="2500.00"
            defaultValue={prefillAmount ?? ""}
            disabled={pending}
            className={`${INPUT_CLASS} money`}
          />
        </Field>

        <Field
          label="Value date"
          hint="The day the credit belongs to. It chooses the policy version AND is the day the banking-day count is measured from — so a Friday value date on a one-banking-day hold releases on Monday."
        >
          <input
            id={valueDateFieldId}
            name="valueDate"
            type="date"
            required
            value={valueDate}
            onChange={(event) => setValueDate(event.target.value)}
            disabled={pending}
            className={INPUT_CLASS}
          />
        </Field>

        <Field
          label="Counterparty class"
          hint="The only input to how long the money is held. A Plaid-linked account is the customer's OWN bank, so `self` is the honest default — and it is still a hold, because a customer can overdraw their own outside bank as easily as anyone else can."
        >
          <select
            id={classFieldId}
            name="counterpartyClass"
            required
            value={counterpartyClass}
            onChange={(event) => setCounterpartyClass(event.target.value)}
            disabled={pending}
            className={INPUT_CLASS}
          >
            {COUNTERPARTY_CLASSES.map((option) => (
              <option key={option} value={option}>
                {CLASS_LABEL[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="External account type"
          hint="Which of the linked Item's depository accounts to pull from. The Item has fourteen accounts and only three of them have ACH numbers; the receipt prints which one was actually used."
        >
          <select
            id={subtypeFieldId}
            name="preferredSubtype"
            required
            defaultValue="checking"
            disabled={pending}
            className={INPUT_CLASS}
          >
            {SUBTYPES.map((option) => (
              <option key={option} value={option}>
                {SUBTYPE_LABEL[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Reference — the fact this funding run is identified by"
          hint="Every idempotency key on this path is derived from it, together with the Plaid item id — and this screen links a fresh Item on every press, so the unique indexes make a run replay-safe within one Item and cannot see across two. A reference this business has already funded under is refused ALREADY_FUNDED by a check before anything is sent to Plaid: a guard against the double-click, not a race-proof guarantee. No spaces and no colons — the reference is one segment of the external ref that joins the hold to its entries."
        >
          <input
            id={referenceFieldId}
            name="reference"
            type="text"
            required
            minLength={3}
            maxLength={120}
            autoComplete="off"
            pattern="[A-Za-z0-9._/#-]+"
            defaultValue={`FUND-${defaultValueDate}`}
            disabled={pending}
            className={`${INPUT_CLASS} font-mono`}
          />
        </Field>
      </div>

      {policy === null ? (
        <p className="rounded border border-negative/40 px-4 py-3 text-xs leading-relaxed text-negative">
          No <code className="font-mono">funds_availability_policy</code> row was loaded for ACH /{" "}
          {counterpartyClass}. Submitting will be refused{" "}
          <code className="font-mono">NO_AVAILABILITY_POLICY</code> rather than defaulting to
          &ldquo;release immediately&rdquo; — a credit whose availability nobody has decided is not
          one this system will make spendable by guessing.
        </p>
      ) : (
        <p className="rounded border border-border bg-surface-raised px-4 py-3 text-xs leading-relaxed text-muted">
          <span className="font-medium text-text">
            Predicted policy: {policy.bankingDaysHold} banking{" "}
            {policy.bankingDaysHold === 1 ? "day" : "days"}, releasing at {policy.releaseLocalTime}{" "}
            ET.
          </span>{" "}
          {policy.note} The row that actually judges this deposit is selected inside the write
          transaction by value date, and the receipt prints the{" "}
          <code className="font-mono">policy_id</code> it pinned.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!submittable || pending}
          className={`rounded border border-border-strong px-3 py-1.5 text-sm font-medium ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {pending ? "Linking and posting…" : "Link a bank and fund"}
        </button>
        <span className="text-xs text-muted">
          {submittable
            ? "Five real calls to sandbox.plaid.com, then one financial entry and one memo entry through postEntry(), in one transaction."
            : plaidConfigured
              ? FIXTURE_NOTE
              : "Plaid holds no credentials in this deployment, so nothing can be linked. The button is disabled rather than failing halfway."}
        </span>
      </div>

      {state.status === "refused" ? <Refusal state={state} /> : null}
      {state.status === "ok" && state.receipt !== null ? (
        <Receipt receipt={state.receipt} message={state.message} />
      ) : null}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Refusals                                                                   */
/* -------------------------------------------------------------------------- */

function Refusal({ state }: { readonly state: FundResult }) {
  return (
    <section
      aria-live="polite"
      className="rounded-md border border-negative/40 bg-surface-raised px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs font-semibold text-negative">Refused</span>
        <code className="font-mono text-xs">{state.code}</code>
      </div>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>

      {state.issues === null ? null : (
        <ul className="mt-2 space-y-1">
          {state.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`} className="text-xs text-muted">
              <code className="font-mono">{issue.path}</code> — {issue.message}
            </li>
          ))}
        </ul>
      )}

      {state.calls === null || state.calls.length === 0 ? null : (
        <div className="mt-3">
          <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
            Plaid calls attempted
          </p>
          <CallLog calls={state.calls} />
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The receipt                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The proof.
 *
 * Every id on it is a real one — Plaid's `item_id` and `account_id`, Plaid's
 * own `request_id` per call, the two `journal_entry` ids and the `hold` id — so
 * that somebody who does not trust this screen can check every claim it makes
 * against Plaid's dashboard and against the database. A receipt that said
 * "linked" and "funded" would prove nothing, and this project has already
 * shipped four probes that reported LIVE for capabilities that did not exist.
 */
function Receipt({
  receipt,
  message,
}: {
  readonly receipt: FundingReceiptView;
  readonly message: string;
}) {
  return (
    <section
      aria-live="polite"
      className="space-y-4 rounded-md border border-positive/40 bg-surface-raised px-4 py-4"
    >
      <div>
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-xs font-semibold text-positive">
            {receipt.created ? "Booked" : "Replayed"}
          </span>
          <Badge tone="positive">LIVE</Badge>
        </div>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{message}</p>
      </div>

      {/* The whole argument of the screen, in four numbers twice. */}
      <div>
        <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
          The balance, before and after
        </p>
        <TableScroll>
          <table className="mt-1 w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={TH_CLASS}>
                  Figure
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Before
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  After
                </th>
                <th scope="col" className={TH_CLASS}>
                  What happened
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border">
                <td className={TD_CLASS}>Ledger balance</td>
                <td className={`${TD_CLASS} money text-right`}>
                  {receipt.before.ledgerDisplay}
                </td>
                <td className={`${TD_CLASS} money text-right font-medium`}>
                  {receipt.after.ledgerDisplay}
                </td>
                <td className={`${TD_CLASS} text-xs text-muted`}>
                  Up by {receipt.amountDisplay}. The deposit posted.
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={TD_CLASS}>Uncleared credits</td>
                <td className={`${TD_CLASS} money text-right`}>
                  {receipt.before.unclearedDisplay}
                </td>
                <td className={`${TD_CLASS} money text-right font-medium`}>
                  {receipt.after.unclearedDisplay}
                </td>
                <td className={`${TD_CLASS} text-xs text-muted`}>
                  Up by the same {receipt.amountDisplay}, withheld by the hold below.
                </td>
              </tr>
              <tr className="border-b border-border">
                <td className={TD_CLASS}>Card holds</td>
                <td className={`${TD_CLASS} money text-right`}>
                  {receipt.before.cardHoldsDisplay}
                </td>
                <td className={`${TD_CLASS} money text-right`}>
                  {receipt.after.cardHoldsDisplay}
                </td>
                <td className={`${TD_CLASS} text-xs text-muted`}>
                  Untouched — a deposit is not an authorisation.
                </td>
              </tr>
              <tr>
                <td className={`${TD_CLASS} font-medium`}>Available</td>
                <td className={`${TD_CLASS} money text-right`}>
                  {receipt.before.availableDisplay}
                </td>
                <td className={`${TD_CLASS} money text-right font-medium`}>
                  {receipt.after.availableDisplay}
                </td>
                <td className={`${TD_CLASS} text-xs text-muted`}>
                  <span className="font-medium text-text">Unchanged.</span> That is the point: an
                  ACH credit can still be returned, so it is on the book and not yet spendable.
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
          When it becomes spendable
        </p>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          {receipt.scheduleSentence}
        </p>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[12rem_1fr]">
          <Row label="Release date">{receipt.releaseDate}</Row>
          <Row label="Available at">
            <span className="font-mono">{receipt.availableAt}</span>
          </Row>
          <Row label="Policy row">
            <span className="font-mono">{receipt.policyId}</span>{" "}
            <span className="text-muted">
              ({receipt.policyRail}/{receipt.counterpartyClass}, {receipt.bankingDaysHold} banking{" "}
              {receipt.bankingDaysHold === 1 ? "day" : "days"} at {receipt.releaseLocalTime} ET)
            </span>
          </Row>
          {receipt.skipped.length === 0 ? null : (
            <Row label="Banking days skipped">
              {receipt.skipped
                .map((day) =>
                  day.reason === "weekend"
                    ? `${day.date} (weekend)`
                    : `${day.date} (Federal Reserve holiday)`,
                )
                .join(", ")}
            </Row>
          )}
        </dl>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.08em] text-muted">What was written</p>
        <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[12rem_1fr]">
          <Row label="Financial entry">
            <span className="font-mono">{receipt.entryId}</span>
          </Row>
          <Row label="Memo entry">
            <span className="font-mono">{receipt.memoEntryId}</span>
          </Row>
          <Row label="Hold">
            <span className="font-mono">{receipt.holdId}</span>
          </Row>
          <Row label="External ref">
            <span className="font-mono break-all">{receipt.externalRef}</span>
          </Row>
        </dl>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.08em] text-muted">What was linked</p>
        <dl className="mt-1 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[12rem_1fr]">
          <Row label="Institution">
            {receipt.institutionName ?? "—"}{" "}
            <span className="font-mono text-muted">{receipt.institutionId ?? ""}</span>
          </Row>
          <Row label="Plaid item">
            <span className="font-mono break-all">{receipt.itemId}</span>
          </Row>
          <Row label="Plaid account">
            <span className="font-mono break-all">{receipt.plaidAccountId}</span>{" "}
            <span className="text-muted">
              {receipt.plaidAccountName}
              {receipt.plaidAccountMask === null ? "" : ` ••${receipt.plaidAccountMask}`}
              {receipt.plaidAccountSubtype === null ? "" : ` (${receipt.plaidAccountSubtype})`}
            </span>
          </Row>
          <Row label="ACH routing">
            <span className="font-mono">{receipt.routingNumber}</span>{" "}
            <span className="text-muted">
              public bank routing data — the account number is never rendered, logged or written
              to the journal
            </span>
          </Row>
          <Row label="Auth method">{receipt.authMethod ?? "—"}</Row>
          <Row label="Plaid’s own balance">
            {receipt.plaidBalanceDisplay ?? "—"}{" "}
            <span className="text-muted">
              a float from Plaid, shown verbatim and never converted to money
            </span>
          </Row>
          {receipt.linkToken === null ? null : (
            <Row label="Link token">
              <span className="font-mono break-all">{receipt.linkToken}</span>{" "}
              <span className="text-muted">
                real, expires {receipt.linkTokenExpiresAt}, and deliberately unused — completing
                Link needs a person in an iframe
              </span>
            </Row>
          )}
        </dl>
      </div>

      <div>
        <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
          Every call that was made
        </p>
        <CallLog calls={receipt.calls} />
      </div>
    </section>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}

/**
 * The evidence.
 *
 * Endpoint, status code, Plaid's own `request_id` and the wall-clock time.
 * Anybody can take a request id from this table to Plaid's dashboard and see
 * the same call; that is the difference between a screen that says it is live
 * and a screen that can be checked by somebody who does not trust it.
 */
function CallLog({ calls }: { readonly calls: readonly CallView[] }) {
  return (
    <TableScroll>
      <table className="mt-1 w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>
              Endpoint
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Status
            </th>
            <th scope="col" className={TH_CLASS}>
              Plaid request id
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              ms
            </th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call, index) => (
            <tr
              key={`${call.endpoint}:${call.requestId ?? index}`}
              className="border-b border-border last:border-b-0"
            >
              <td className={`${TD_CLASS} font-mono text-xs`}>{call.endpoint}</td>
              <td className={`${TD_CLASS} money text-right`}>
                {call.ok ? (
                  <span className="text-positive">{call.status}</span>
                ) : (
                  <span className="text-negative">
                    {call.status === 0 ? "—" : call.status}
                    {call.errorCode === null ? "" : ` ${call.errorCode}`}
                  </span>
                )}
              </td>
              <td className={`${TD_CLASS} font-mono text-xs text-muted`}>
                {call.requestId ?? "—"}
              </td>
              <td className={`${TD_CLASS} money text-right text-muted`}>{call.ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
