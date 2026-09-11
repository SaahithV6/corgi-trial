import { Panel } from "@/components/ui/primitives";

import type { AccrualInvariants } from "./data-contract";

/**
 * The written policy, on the screen that implements it.
 *
 * Four questions a reviewer will ask, answered where the numbers are rather
 * than only in docs/ACCRUAL.md — because the document and the screen drifting
 * apart is exactly how a rounding rule becomes two rounding rules.
 */
export function PolicyPanel({ invariants }: { readonly invariants: AccrualInvariants }) {
  return (
    <Panel
      title="The rule, and what the database enforces"
      description="Written in full in docs/ACCRUAL.md and in the header of db/migrations/0020_accrual.sql. Summarised here because a policy nobody can find is a policy nobody follows."
    >
      <div className="space-y-4 px-5 py-4 text-xs leading-relaxed text-muted">
        <Item title="The rounding rule is the one already in this ledger, not a second one">
          research/ledger/DESIGN.md §12.3: an amount split across N shares is
          allocated by LARGEST REMAINDER — floor each share, then distribute the
          shortfall one penny at a time — which guarantees the shares sum to the
          source <em>exactly</em>. §12.4 breaks the tie by ordinal ascending, and
          here the ordinal is the day of the month. Half-to-even (§12.2) is the
          rule for turning one value into one cent amount, and applying it per
          day would bill $24.90 for a $25.00 plan. Two rounding rules in one
          ledger is a reconciliation break waiting to happen, so there is one.
        </Item>

        <Item title="Someone eats the penny, deterministically, and it is nobody over a whole month">
          The residual pennies go to the earliest days. Over a complete month the
          total is exactly the price, so nobody eats anything —{" "}
          <code>v_accrual_month_drift</code> is the query that proves it and it
          currently returns {invariants.monthDrift} rows. Over a PARTIAL month
          the front-loading means a mid-month close can leave a customer up to
          (price mod days) cents — at most 30¢ on a $25.00 plan — ahead of exact
          pro-rata, and a mid-month open the same amount behind. That is
          disclosed and bounded rather than absent, and it is the price of
          following the rule that was already written down instead of inventing
          a second one for this feature.
        </Item>

        <Item title="Running it twice for the same day posts once">
          The unit is the (schedule, date) pair.{" "}
          <code>accrual_day</code> is UNIQUE on it, and its idempotency key —{" "}
          <code>accrual:&lt;schedule&gt;:&lt;YYYY-MM-DD&gt;</code> — is a
          GENERATED column derived by Postgres from those two source facts, never
          from a uuid the job made up. It is handed to <code>postEntry()</code>,
          where <code>journal_entry.idempotency_key</code> is UNIQUE, so a second
          tick gets the original entry back and writes nothing. The row lock is a
          liveness device, not the safety device.
        </Item>

        <Item title="The entry is dated the day it accrued for">
          Value date and booking date are different columns and this is the case
          that proves it. A tick that catches up three days posts three entries
          with three value dates and today&apos;s booking sequence, so Tuesday&apos;s
          statement shows Tuesday&apos;s fee even when the job ran on Friday.{" "}
          <code>assert_accrual_posting()</code> refuses any entry whose value
          date is not the accrual date, and{" "}
          <code>v_accrual_ledger_drift</code> ({invariants.ledgerDrift} rows)
          watches for it afterwards.
        </Item>

        <Item title="An accrual is not funds-checked">
          The fee accrued because the month passed, not because the balance
          allowed it. Refusing to accrue on a thin balance would make that day&apos;s
          statement wrong and the month stop summing to the price, so a fee can
          push a deposit account into a debit balance — which is precisely the
          condition <code>v_overdrawn_accounts</code> exists to surface. That is
          a decision, written down, not an omission.
        </Item>
      </div>
    </Panel>
  );
}

function Item({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-semibold text-text">{title}</p>
      <p className="mt-1 max-w-prose">{children}</p>
    </div>
  );
}
