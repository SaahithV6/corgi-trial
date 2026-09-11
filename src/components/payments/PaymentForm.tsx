"use client";

import Link from "next/link";
import { useActionState, useId, useState } from "react";

import { raisePaymentAction, type RaiseResult } from "@/app/(app)/payments/actions";
import { FOCUS_RING } from "@/components/ui/primitives";
import { PAYOUT_RAILS, type PayoutRail } from "@/lib/approvals/types";

import type {
  PolicyOptionView,
  Prefill,
  SourceAccountView,
  WirePayeeOption,
} from "./data-contract";

/**
 * The form that raises a real payment instruction.
 *
 * ============================================================================
 * WHAT THIS COMPONENT IS NOT ALLOWED TO DO, AND DOES NOT.
 *
 * 1. IT PERFORMS NO ARITHMETIC ON MONEY. There is not a number on its props:
 *    thresholds arrive as strings the server already formatted, and the amount
 *    is the literal characters somebody typed, sent as text. Whether that
 *    amount reaches the threshold is decided by `requestPayment()` comparing
 *    two `bigint`s inside a Postgres transaction, and the answer comes back on
 *    the receipt. The browser is never told, because the browser has no way to
 *    work it out and no business trying.
 *
 * 2. IT IS NOT THE VALIDATION. The `required` attributes, the `pattern`s and
 *    the rail-shaped fieldsets are conveniences for a person filling this in at
 *    speed. Every one of them is re-decided on the server by
 *    `requestPaymentSchema` — the same schema the MCP write tool is validated
 *    against — and a POST assembled by hand with none of these fields reaches
 *    exactly the same refusals. See the header of `actions.ts`.
 *
 * 3. IT DOES NOT DISABLE THE SUBMIT BUTTON WHEN THE KYB GATE SAYS NO. This is
 *    the opposite of the approvals screen's disabled Approve button, and the
 *    difference is deliberate. There, the refusal is a fact about YOU (you
 *    raised this payment) and telling you in advance saves a pointless POST.
 *    Here, the refusal is a fact about a BUSINESS, it is the single most
 *    important thing this screen has to show, and a greyed-out button
 *    demonstrates nothing. Pressing it sends a real request to a real
 *    transaction, which reads `v_business_kyb` under its own snapshot and
 *    refuses with a code. A warning appears first so nobody is surprised; the
 *    button stays live so the refusal can be seen coming from the database
 *    rather than from a stylesheet.
 * ============================================================================
 */

const IDLE: RaiseResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  receipt: null,
};

const FIXTURE_NOTE =
  "Demo fixture. Instructions are only raised against the live form — this state has no live account list behind it, and the screen will not pretend otherwise.";

const RAIL_LABEL: Record<PayoutRail, string> = {
  ach: "ACH",
  wire: "Wire",
  usdc: "USDC",
  internal: "Internal book transfer",
};

const USDC_CHAINS = ["base-sepolia", "base", "ethereum", "polygon", "solana"] as const;

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS =
  "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

/**
 * The policy version that will judge a payment on this rail, dated this day.
 *
 * The identical selection Postgres makes in `effectivePolicyFor()`: the newest
 * row for the rail whose `effective_from` is on or before the value date.
 * `YYYY-MM-DD` strings compare lexicographically in calendar order, which is
 * the entire reason value dates are stored and carried in that format — so this
 * is a date comparison and not a re-implementation of the threshold rule. The
 * threshold itself is never compared to anything here.
 *
 * It is still only a PREDICTION. The row the instruction pins is chosen inside
 * the transaction, and the receipt prints the id that was actually written.
 */
function effectivePolicy(
  policies: readonly PolicyOptionView[],
  rail: PayoutRail,
  valueDate: string,
): PolicyOptionView | null {
  let best: PolicyOptionView | null = null;
  for (const policy of policies) {
    if (policy.rail !== rail) continue;
    if (policy.effectiveFrom > valueDate) continue;
    if (best === null || policy.effectiveFrom > best.effectiveFrom) best = policy;
  }
  return best;
}

/**
 * Is this policy's threshold at the floor — every payment approved, no band?
 *
 * `thresholdDisplay` is a STRING and that is not an accident: this contract
 * carries no cent count at all, because the browser has no correct use for one
 * (see the head of `data-contract.ts`). So the question asked here is not "is
 * the amount above the threshold" — the browser must never answer that, and
 * `requestPayment()` answers it by comparing two `bigint`s inside Postgres.
 * The question is whether the threshold is the zero the SERVER already
 * formatted, which is a string comparison against the server's own output of
 * `formatUsd(0n)` and involves no arithmetic on money whatsoever.
 */
function isFloorThreshold(policy: PolicyOptionView): boolean {
  return policy.thresholdDisplay === "$0.00";
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

export type PaymentFormProps = {
  readonly accounts: readonly SourceAccountView[];
  readonly policies: readonly PolicyOptionView[];
  readonly defaultValueDate: string;
  readonly prefill: Prefill | null;
  /** The confirmed wire beneficiaries, per business. See `WirePayeeOption`. */
  readonly wirePayeesByBusiness: Readonly<Record<string, readonly WirePayeeOption[]>>;
  /** False on the fixture demo states. Nothing is submitted from those. */
  readonly live: boolean;
};

export function PaymentForm({
  accounts,
  policies,
  defaultValueDate,
  wirePayeesByBusiness,
  prefill,
  live,
}: PaymentFormProps) {
  const [state, formAction, pending] = useActionState(raisePaymentAction, IDLE);

  // Default to an account that can actually transact, not merely the first one
  // alphabetically. The refused account is still one click away in the select
  // and still carries its code — but a payment form whose default source is a
  // business the gate will reject reads as broken rather than as instructive.
  const defaultAccount =
    accounts.find((account) => account.gate.allowed)?.id ?? accounts[0]?.id ?? "";
  const [accountId, setAccountId] = useState(prefill?.accountId ?? defaultAccount);
  const [rail, setRail] = useState<PayoutRail>(prefill?.rail ?? "ach");
  const [valueDate, setValueDate] = useState(defaultValueDate);
  const [wirePayeeId, setWirePayeeId] = useState("");

  const accountFieldId = useId();
  const railFieldId = useId();
  const amountFieldId = useId();
  const valueDateFieldId = useId();
  const referenceFieldId = useId();
  const gateNoteId = useId();

  const selected = accounts.find((account) => account.id === accountId) ?? null;
  const policy = effectivePolicy(policies, rail, valueDate);
  const otherAccounts = accounts.filter((account) => account.id !== accountId);

  // Scoped to the SOURCE ACCOUNT'S business. The payee book is keyed by
  // business, and a picker that offered another customer's beneficiaries would
  // be a payee book with no boundary.
  const wirePayees = selected === null ? [] : (wirePayeesByBusiness[selected.businessId] ?? []);
  const wirePayee = wirePayees.find((payee) => payee.payeeId === wirePayeeId) ?? null;

  return (
    <form action={formAction} className="space-y-5 px-5 py-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Pay from"
          hint="The customer deposit account the money would leave. The KYB gate is re-read against this id inside the write transaction."
        >
          <select
            id={accountFieldId}
            name="accountId"
            required
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            disabled={pending || accounts.length === 0}
            aria-describedby={selected !== null && !selected.gate.allowed ? gateNoteId : undefined}
            className={INPUT_CLASS}
          >
            {accounts.length === 0 ? <option value="">No account available</option> : null}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.businessName} — {account.gate.allowed ? "verified" : account.gate.code}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Rail"
          hint="Card is absent on purpose: the ledger books card settlement against it, but a card movement originates at a network, not at a person, so it is never a payment instruction."
        >
          <select
            id={railFieldId}
            name="rail"
            required
            value={rail}
            onChange={(event) => setRail(event.target.value as PayoutRail)}
            disabled={pending}
            className={INPUT_CLASS}
          >
            {PAYOUT_RAILS.map((option) => (
              <option key={option} value={option}>
                {RAIL_LABEL[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Amount (USD)"
          hint="Typed as dollars and cents, sent as text, and converted to integer cents by string arithmetic on the server. There is no parseFloat anywhere on this path."
        >
          <input
            id={amountFieldId}
            name="amount"
            type="text"
            inputMode="decimal"
            required
            autoComplete="off"
            placeholder="2500.00"
            defaultValue={prefill?.amount ?? ""}
            disabled={pending}
            className={`${INPUT_CLASS} money`}
          />
        </Field>

        <Field
          label="Value date"
          hint="A calendar date, not an instant — the day the money should land. It also chooses which version of the policy judges this payment."
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
      </div>

      <Field
        label="Reference — the fact that caused this payment"
        hint="An invoice number, a payroll run, a ticket. It is not stored on the instruction; it is what the idempotency key is derived from, so submitting the same reference for the same account twice returns the FIRST instruction and queues nothing new."
      >
        <input
          id={referenceFieldId}
          name="reference"
          type="text"
          required
          minLength={3}
          maxLength={120}
          autoComplete="off"
          placeholder="INV-2026-0914"
          defaultValue={prefill?.reference ?? ""}
          disabled={pending}
          className={INPUT_CLASS}
        />
      </Field>

      <fieldset className="rounded border border-border px-4 py-3">
        <legend className="px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Counterparty · {RAIL_LABEL[rail]}
        </legend>

        {rail === "ach" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Beneficiary name">
              <input
                name="holderName"
                type="text"
                required
                autoComplete="off"
                defaultValue={prefill?.holderName ?? ""}
                disabled={pending}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Routing number">
              <input
                name="routingNumber"
                type="text"
                required
                inputMode="numeric"
                pattern="\d{9}"
                placeholder="021000021"
                defaultValue={prefill?.routingNumber ?? ""}
                disabled={pending}
                className={`${INPUT_CLASS} money`}
              />
            </Field>
            <Field
              label="Account number — last four only"
              hint="The full number is not accepted by the schema and has no column to go in. An approver checks a beneficiary against the last four and a name; a system that never holds the other digits cannot leak them."
            >
              <input
                name="accountNumberLast4"
                type="text"
                required
                inputMode="numeric"
                pattern="\d{4}"
                placeholder="4417"
                defaultValue={prefill?.accountNumberLast4 ?? ""}
                disabled={pending}
                className={`${INPUT_CLASS} money`}
              />
            </Field>
            <Field label="Account type">
              <select name="accountType" required disabled={pending} className={INPUT_CLASS}>
                <option value="checking">checking</option>
                <option value="savings">savings</option>
              </select>
            </Field>
          </div>
        ) : null}

        {rail === "wire" ? (
          <WireBranch
            payees={wirePayees}
            selectedId={wirePayeeId}
            onSelect={setWirePayeeId}
            payee={wirePayee}
            pending={pending}
          />
        ) : null}

        {rail === "usdc" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Chain">
              <select name="chain" required disabled={pending} className={INPUT_CLASS}>
                {USDC_CHAINS.map((chain) => (
                  <option key={chain} value={chain}>
                    {chain}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Destination address"
              hint="USDC is its own currency code in the rails layer; the instruction still carries USD, because what is being instructed is an amount of US dollars settled over that rail."
            >
              <input
                name="address"
                type="text"
                required
                autoComplete="off"
                placeholder="0x…"
                disabled={pending}
                className={`${INPUT_CLASS} font-mono text-xs`}
              />
            </Field>
          </div>
        ) : null}

        {rail === "internal" ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="To account"
              hint="Both legs stay on our own book. Its policy version requires zero approvals, which is why the release path's treatment of a zero-approval instruction is worth reading before anyone automates this rail."
            >
              <select
                name="internalAccountId"
                required
                disabled={pending || otherAccounts.length === 0}
                className={INPUT_CLASS}
              >
                {otherAccounts.length === 0 ? (
                  <option value="">No other account on this book</option>
                ) : null}
                {otherAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.businessName} — {account.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Beneficiary name">
              <input
                name="holderName"
                type="text"
                required
                autoComplete="off"
                defaultValue={prefill?.holderName ?? ""}
                disabled={pending}
                className={INPUT_CLASS}
              />
            </Field>
          </div>
        ) : null}
      </fieldset>

      {/* ------------------------------------------------------------------ */}
      {/* The threshold, BEFORE anyone presses anything.                      */}
      {/* ------------------------------------------------------------------ */}
      <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
        <p className="text-xs font-semibold">What will judge this payment</p>
        {policy === null ? (
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-negative">
            No version of the {RAIL_LABEL[rail]} policy is in force on {valueDate || "that date"}.
            Submitting will be refused with <span className="font-mono">POLICY_MISSING</span> — a
            payment with no policy version to cite is a payment nobody agreed the rules for, and
            this system will not invent a default threshold to get past it.
          </p>
        ) : (
          <>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              {policy.requiredApprovals === 0 ? (
                <>
                  Any amount on this rail needs{" "}
                  <span className="font-medium text-text">no approvals</span> under{" "}
                  <span className="font-mono text-text">{policy.version}</span>.
                </>
              ) : isFloorThreshold(policy) ? (
                /*
                 * THE THRESHOLD IS AT THE FLOOR, SO THERE IS NO BAND AND NO
                 * "or more" TO QUOTE. Saying "$0.00 or more needs two
                 * approvals, below that zero" is arithmetically true and reads
                 * as nonsense next to a $42.00 wire, because there is nothing
                 * below $0.00. It is also the wrong shape of claim: a
                 * threshold PRICES A BAND in which a mistake is recoverable
                 * unattended, and ACH can draw one at $2,500 only because an
                 * ACH entry is recallable for two banking days. A wire has no
                 * such mechanism at ANY amount, so there is no amount at which
                 * the band can be drawn and the threshold sits at the floor.
                 */
                <>
                  <span className="font-medium text-text">Every payment on this rail</span>, at any
                  amount, needs{" "}
                  <span className="font-medium text-text">
                    {policy.requiredApprovals} approval
                    {policy.requiredApprovals === 1 ? "" : "s"}
                  </span>{" "}
                  from distinct humans who did not raise it, under{" "}
                  <span className="font-mono text-text">{policy.version}</span>. The threshold is{" "}
                  <span className="money">{policy.thresholdDisplay}</span> — there is no band below
                  it, because a threshold prices the amount under which a mistake is recoverable
                  unattended, and on this rail nothing is recoverable at any amount.
                </>
              ) : (
                <>
                  <span className="font-medium text-text">
                    {policy.thresholdDisplay} or more
                  </span>{" "}
                  on this rail needs{" "}
                  <span className="font-medium text-text">
                    {policy.requiredApprovals} approval
                    {policy.requiredApprovals === 1 ? "" : "s"}
                  </span>{" "}
                  from distinct humans who did not raise it. Below that, zero. The test is{" "}
                  <span className="font-mono">amount_cents &gt;= threshold_cents</span>, so an
                  amount exactly ON {policy.thresholdDisplay} needs the approval.
                </>
              )}
            </p>
            <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed text-muted">
              <span className="font-mono">{policy.version}</span> is the version in force for{" "}
              {RAIL_LABEL[rail]} on a value date of {valueDate}. Its id is written onto the
              instruction as <span className="font-mono">policy_id</span>, so this payment goes on
              citing the rule it was judged under even after somebody changes the rule — and
              because <span className="font-mono">approval_policy</span> is append-only and
              effective-dated, changing it is an INSERT with a later{" "}
              <span className="font-mono">effective_from</span>, never an edit. The row is picked
              again inside the transaction; the receipt prints the id that was actually pinned.
            </p>
            <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed text-muted">
              {policy.note}
            </p>
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The KYB gate, before and instead of a surprise.                     */}
      {/* ------------------------------------------------------------------ */}
      {selected === null ? null : (
        <div
          id={gateNoteId}
          className={`rounded-md border px-4 py-3 ${
            selected.gate.allowed ? "border-border bg-surface-raised" : "border-negative/50"
          }`}
        >
          <p
            className={`text-xs font-semibold ${
              selected.gate.allowed ? "text-text" : "text-negative"
            }`}
          >
            {selected.gate.allowed
              ? "This business may transact"
              : `This payment will be refused — ${selected.gate.code}`}
          </p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {selected.businessName}: verification is{" "}
            <span className="font-mono">{selected.gate.status ?? "not started"}</span> on{" "}
            <span className="font-mono">{selected.gate.evidence ?? "no"}</span> evidence.{" "}
            {selected.gate.message}
          </p>
          {selected.gate.allowed ? null : (
            <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed text-muted">
              The button below is deliberately still live. Press it and the refusal arrives from{" "}
              <span className="font-mono">canTransact()</span> inside the write transaction, with
              this code on it — an unverified entity can look, but not transact, and that is worth
              seeing happen rather than being told.
            </p>
          )}
          {selected.gate.allowed && !selected.gateIfLiveRequired.allowed ? (
            <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed text-muted">
              <span className="font-semibold text-text">
                Under a stricter policy this is refused:{" "}
              </span>
              <span className="font-mono">{selected.gateIfLiveRequired.code}</span>.{" "}
              {selected.gateIfLiveRequired.message} This deployment runs{" "}
              <span className="font-mono">requireLiveEvidence: false</span> because it has no
              provider keys for the registry leg, and a gate that denies everything teaches people
              to bypass the gate. What it never does is hide which one it is.
            </p>
          ) : null}
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Submit                                                              */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || !live}
          className={`inline-flex items-center rounded border border-border-strong px-3 py-1.5 text-xs font-medium ${FOCUS_RING} enabled:hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-45`}
        >
          {pending ? "Raising…" : "Queue this payment for a checker"}
        </button>
        <span className="text-[11px] leading-relaxed text-muted">
          {live
            ? "This writes one instruction and one 'requested' event. It moves no money."
            : FIXTURE_NOTE}
        </span>
      </div>

      <p aria-live="polite" className="sr-only">
        {pending ? "Raising the payment instruction" : state.message}
      </p>

      {state.status === "idle" ? null : state.status === "ok" && state.receipt !== null ? (
        <ReceiptPanel result={state} receipt={state.receipt} />
      ) : (
        <RefusalPanel result={state} />
      )}
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* The wire branch — a picker, not a text field                               */
/* -------------------------------------------------------------------------- */

const FRESHNESS_NOTE: Record<string, string> = {
  fresh: "checked in the last 30 days",
  ageing: "checked in the last 90 days",
  stale: "not checked for more than 90 days",
  never: "never checked",
};

/**
 * Pick a confirmed wire beneficiary, or be told why there is none.
 *
 * THE THREE FIELDS ARE HIDDEN INPUTS DERIVED FROM THE PICK, not typed. The
 * form still POSTs `holderName`, `wireRoutingNumber` and `accountNumberLast4`
 * exactly as the ACH branch POSTs its own — the server action is unchanged in
 * shape and re-validates all three through `destinationSchema` regardless of
 * what a hand-assembled POST claims. What the picker removes is the case where
 * a clerk types a beneficiary this rail is going to refuse.
 *
 * IT IS NOT THE CONTROL, and it must not be mistaken for one. A POST with any
 * beneficiary at all still reaches `gatePaymentOnPayee()` inside the write
 * transaction, which refuses a beneficiary that is not on the confirmed book
 * (`PAYEE_WIRE_PAYEE_NOT_ON_BOOK`) and refuses one carrying a bank the book
 * does not confirm for them (`PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED`); and a
 * wire still reaches `resolveWireBeneficiary()` before anything is put on
 * Fedwire. This screen is not the only door — the public API and the MCP write
 * tool reach `requestPayment()` without passing this way — so the picker is
 * the same refusal moved to the front, where it costs a clerk nothing instead
 * of costing two approvers their time.
 *
 * WHY THE NUMBER IS POSTED AT ALL rather than looked up at send time: it is
 * covered by `payment_instruction.content_hash`, so the bank two approvers
 * signed for is the bank the money goes to. The argument is in the header of
 * `src/lib/payees/gate.ts`. This field is therefore a COPY of the book's
 * number and never a clerk's typing, which is why it is a hidden input
 * derived from the pick.
 */
function WireBranch({
  payees,
  selectedId,
  onSelect,
  payee,
  pending,
}: {
  readonly payees: readonly WirePayeeOption[];
  readonly selectedId: string;
  readonly onSelect: (id: string) => void;
  readonly payee: WirePayeeOption | null;
  readonly pending: boolean;
}) {
  return (
    <div className="space-y-4">
      <Field
        label="Beneficiary — from the confirmed payee book"
        hint="A wire cannot be recalled, so this rail will not address a beneficiary nobody has checked. gatePaymentOnPayee() refuses one that is not on this business's book, and refuses a bank the book does not confirm for them; originateApprovedWire() checks the same thing again at the moment the money leaves. With a free-text field the first of those refusals arrives after two approvals and a ledger entry, so the choice is made here instead."
      >
        <select
          name="wirePayeeId"
          required
          value={selectedId}
          onChange={(event) => onSelect(event.target.value)}
          disabled={pending || payees.length === 0}
          className={INPUT_CLASS}
        >
          <option value="">
            {payees.length === 0
              ? "No confirmed wire payee on this business's book"
              : "Choose a beneficiary…"}
          </option>
          {payees.map((option) => (
            <option key={option.payeeId} value={option.payeeId}>
              {option.displayName} — {option.wireRoutingNumber} ••{option.accountNumberLast4}
              {option.gateRefusalCode === null ? "" : " (warning unsigned)"}
            </option>
          ))}
        </select>
      </Field>

      {payees.length === 0 ? (
        <p className="max-w-prose text-[11px] leading-relaxed text-muted">
          Nothing on this business&rsquo;s payee book is addressable by Fedwire. A beneficiary
          qualifies when it is on the book for the <span className="font-mono">wire</span> rail,
          is not archived, and carries a 9-digit routing number that passes the check digit — a
          BIC does not qualify, because Fedwire does not route on one. Add the payee on{" "}
          <Link href="/payees" className="underline">
            /payees
          </Link>
          , let the routing number be checked, then raise the payment.
        </p>
      ) : null}

      {payee === null ? null : (
        <>
          {/*
            The destination, assembled from the pick. `wireRoutingNumber` is the
            WIRE variant of the ABA — a different number from the same bank's
            ACH variant, which is the substitution this rail actually suffers
            and the reason the field is not called `routingNumber`.
          */}
          <input type="hidden" name="holderName" value={payee.holderName} />
          <input type="hidden" name="wireRoutingNumber" value={payee.wireRoutingNumber} />
          <input type="hidden" name="accountNumberLast4" value={payee.accountNumberLast4} />

          <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
            <p className="text-xs font-semibold">What will be on the Fedwire message</p>
            <dl className="mt-2 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[11rem_1fr]">
              <dt className={LABEL_CLASS}>Creditor name</dt>
              <dd>{payee.holderName}</dd>
              <dt className={LABEL_CLASS}>Wire routing number</dt>
              <dd className="money">
                {payee.wireRoutingNumber}
                {payee.institutionName === null ? null : (
                  <span className="ml-2 text-muted">{payee.institutionName}</span>
                )}
              </dd>
              <dt className={LABEL_CLASS}>Account</dt>
              <dd className="money">
                &bull;&bull;{payee.accountNumberLast4}
                <span className="ml-2 text-muted">
                  the book holds four digits and never the whole number
                </span>
              </dd>
              <dt className={LABEL_CLASS}>Last check</dt>
              <dd>
                <span className="font-mono">{payee.outcome ?? "never checked"}</span>
                <span className="ml-2 text-muted">
                  {FRESHNESS_NOTE[payee.freshness] ?? payee.freshness}
                  {payee.acknowledged ? ", warning signed for" : ""}
                </span>
              </dd>
            </dl>
          </div>

          {payee.gateRefusalCode === null ? null : (
            <div className="rounded-md border border-negative/50 px-4 py-3">
              <p className="text-xs font-semibold text-negative">
                This payment will be refused —{" "}
                <span className="font-mono">{payee.gateRefusalCode}</span>
              </p>
              <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                The last check on this beneficiary raised a warning and nobody has signed for it.
                The warning is not the block — it is overridable by anybody, in one step. What is
                refused is letting the override be <em>implicit</em>: open the payee, read what the
                check found, and record why it is right to pay this account. The button below stays
                live, and the refusal arrives from{" "}
                <span className="font-mono">gatePaymentOnPayee()</span> inside the write
                transaction rather than from this stylesheet.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Outcomes                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What to do next about a refusal this MODULE raises.
 *
 * The gate refusals arrive with their remedy already in the sentence —
 * `PAYEE_WARNING_UNACKNOWLEDGED` carries the `/payees?payee=<id>&sign=1` URL
 * that resolves it, and the wire gate says in as many words to pick the
 * beneficiary off the payee book. The four codes below are the ones `actions.ts`
 * produces before it ever reaches a gate, and they said accurately what had
 * failed and nothing about what to do about it. A code with no next step is a
 * dead end.
 *
 * Roles are switched with the "Acting as" control in the page header. There is
 * no URL that sets one, so the remedy names the control rather than inventing a
 * link that would not work.
 */
const REMEDY: Record<string, string> = {
  INVALID_FORM:
    "Next: fix the fields listed above and submit again. Nothing was written, so nothing needs undoing and the reference is still free to reuse.",
  INVALID_AMOUNT:
    "Next: type the amount as plain dollars and cents — 1250.00, no currency symbol, no thousands separator, no more than two decimal places. It is converted to integer cents by string arithmetic, so anything it cannot read exactly is refused rather than rounded.",
  PAYMENTS_NO_DATABASE:
    "Next: nothing on this screen. This deployment has no APP_DATABASE_URL, so no payment can be raised here at all and a second attempt changes nothing.",
  NO_ACTOR:
    "Next: pick an identity with the “Acting as” control in the page header. Every payment_instruction carries a requested_by, so a request with nobody behind it is not writable.",
};

/**
 * A refusal, with its code, rendered as itself.
 *
 * Not translated, not grouped, not softened into "something went wrong". The
 * code is the thing an operator quotes in a ticket and the thing a reviewer
 * greps the source for; hiding it to keep the panel tidy costs the reader the
 * only durable handle on what happened.
 */
function RefusalPanel({ result }: { readonly result: RaiseResult }) {
  const remedy = result.code === null ? undefined : REMEDY[result.code];
  return (
    <div className="rounded-md border border-negative/50 px-4 py-3">
      <p className="text-xs font-semibold text-negative">
        Refused. Nothing was queued.
        {result.code === null ? null : (
          <span className="ml-2 font-mono text-[11px] font-normal text-muted">{result.code}</span>
        )}
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{result.message}</p>

      {result.issues === null ? null : (
        <ul className="mt-2 space-y-1">
          {result.issues.map((issue) => (
            <li key={`${issue.path}:${issue.message}`} className="text-[11px] text-muted">
              <span className="font-mono text-text">{issue.path}</span> — {issue.message}
            </li>
          ))}
        </ul>
      )}

      {remedy === undefined ? null : (
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-text">{remedy}</p>
      )}

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        A refusal here is a decision the database made, not a failure of this screen. No{" "}
        <span className="font-mono">payment_instruction</span> row exists, no event was appended,
        and nothing needs to be undone — the whole call runs in one transaction, so a refusal
        leaves no half-written payment behind.
      </p>
    </div>
  );
}

/** The proof. Every figure on it came back from the write that just happened. */
function ReceiptPanel({
  result,
  receipt,
}: {
  readonly result: RaiseResult;
  readonly receipt: NonNullable<RaiseResult["receipt"]>;
}) {
  return (
    <div className="rounded-md border border-positive/50 px-4 py-3">
      <p className="text-xs font-semibold">
        {receipt.created ? "Queued — and nothing more than queued" : "Already queued — replayed"}
        <span className="ml-2 font-mono text-[11px] font-normal text-muted">{result.code}</span>
      </p>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{result.message}</p>

      <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[11rem_1fr]">
        <dt className={LABEL_CLASS}>Instruction id</dt>
        <dd className="font-mono break-all">{receipt.instructionId}</dd>

        <dt className={LABEL_CLASS}>Amount</dt>
        <dd className="money">
          {receipt.amountDisplay} · {receipt.rail} · value date {receipt.valueDate}
        </dd>

        <dt className={LABEL_CLASS}>Judged under</dt>
        <dd>
          <span className="font-mono">{receipt.policyVersion}</span>
          <span className="ml-2 text-muted">
            threshold {receipt.thresholdDisplay}, pinned as policy_id
          </span>
          <div className="mt-0.5 font-mono text-[11px] break-all text-muted">
            {receipt.policyId}
          </div>
        </dd>

        <dt className={LABEL_CLASS}>Approvals required</dt>
        <dd>
          {!receipt.needsApproval ? (
            <>
              <span className="money font-medium">0</span> — below the{" "}
              {receipt.thresholdDisplay} threshold on {receipt.rail}. The same release path still
              runs, with a required count of zero, and a person still has to press Release.
            </>
          ) : receipt.thresholdIsFloor ? (
            /*
             * NOT "reached the threshold". The threshold is $0.00, so nothing
             * was reached and there is no band this payment climbed into. See
             * `Receipt.thresholdIsFloor` for why the reason is the rail's
             * irrevocability and not the payment's size.
             */
            <>
              <span className="money font-medium">{receipt.approvalsRequired}</span> — every{" "}
              {receipt.rail} payment needs {receipt.approvalsRequired} distinct human approvers, at
              any amount, none of them you. The threshold is {receipt.thresholdDisplay}: there is
              no band below it, because a threshold prices the amount under which a mistake is
              recoverable unattended and a {receipt.rail} has no recall at any amount.
            </>
          ) : (
            <>
              <span className="money font-medium">{receipt.approvalsRequired}</span> — this amount
              reached the {receipt.thresholdDisplay} threshold on {receipt.rail}, so it cannot be
              released until that many distinct humans, none of them you, approve it.
            </>
          )}
        </dd>

        <dt className={LABEL_CLASS}>Content hash</dt>
        <dd className="font-mono text-[11px] break-all text-muted">{receipt.contentHash}</dd>
      </dl>

      <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
        An approval must cite that hash. It is sha256 over this payment&rsquo;s account, rail,
        amount, destination and value date — change any of them and this is a different
        instruction with a different hash, and an approval given for the old one does not apply.
      </p>

      <p className="mt-3 max-w-prose text-[11px] leading-relaxed text-muted">
        Write the instruction id down. The queue on /approvals holds this payment only until
        somebody releases or rejects it, and there is no screen in this console that lists a
        payment after that. What survives is the journal entry the release posts: it is named on
        the release event in the queue before the row leaves, its idempotency key is{" "}
        <span className="font-mono">payment:release:&lt;instruction id&gt;</span>, and it is on the
        paying account&rsquo;s Activity table at{" "}
        <Link href={`/accounts/${receipt.accountId}?rows=200`} className="underline underline-offset-4">
          /accounts/{receipt.accountId}
        </Link>
        .
      </p>

      <div className="mt-3">
        <Link
          href="/approvals"
          className={`inline-flex items-center rounded border border-border-strong px-3 py-1.5 text-xs font-medium ${FOCUS_RING} hover:bg-surface-raised`}
        >
          Open it in the approvals queue →
        </Link>
      </div>
    </div>
  );
}
