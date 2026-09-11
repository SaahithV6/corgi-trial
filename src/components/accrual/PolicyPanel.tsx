import { Panel } from "@/components/ui/primitives";

import type { AccrualInvariants, InterestInvariantsView } from "./data-contract";

/**
 * The written policy, on the screen that implements it.
 *
 * The questions a reviewer will ask, answered where the numbers are rather
 * than only in docs/ACCRUAL.md — because the document and the screen drifting
 * apart is exactly how a rounding rule becomes two rounding rules.
 */
export function PolicyPanel({
  invariants,
  interest,
}: {
  readonly invariants: AccrualInvariants;
  readonly interest: InterestInvariantsView;
}) {
  return (
    <Panel
      title="The rules, and what the database enforces"
      description="Written in full in docs/ACCRUAL.md and in the headers of db/migrations/0020_accrual.sql and 0024_interest.sql. Summarised here because a policy nobody can find is a policy nobody follows."
    >
      <div className="space-y-4 px-5 py-4 text-xs leading-relaxed text-muted">
        <Item title="TWO rounding rules, because DESIGN §12 has two — and each product uses the one whose precondition it meets">
          <strong>§12.3, largest remainder, for the platform fee.</strong> One
          amount split across N shares: floor each share, then distribute the
          shortfall one penny at a time, which guarantees the shares sum to the
          source <em>exactly</em>. §12.4 breaks the tie by ordinal ascending and
          here the ordinal is the day of the month. Rounding each day on its own
          would bill $24.90 for a $25.00 plan.
          <br />
          <br />
          <strong>§12.2, half to even, for daily interest.</strong> One value —
          a balance, a rate and one day — to one cent amount. §12.3 is not
          merely worse here, it is <em>undefined</em>: largest remainder needs a
          source amount to distribute, and there is none, because the
          month&apos;s interest is not a known number until the month has
          happened and the balance changes every day. You cannot floor N shares
          of a number you do not have. Half to EVEN rather than half up because
          half-up would hand every exact half-cent to the same party forever —
          to us on an overdraft, to the customer on a credit balance.
          <br />
          <br />
          Two rules, not three, and neither was invented for this feature. The
          fee&apos;s residual penny is real money with an address; interest has
          no residual to place, which is why <code>2900</code> is not engaged.
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
          condition <code>v_overdrawn_accounts</code> exists to surface, and
          precisely what the overdraft rate on the card above would then price.
          That is a decision, written down, not an omission.
        </Item>

        <Item title="A rate change cannot re-price yesterday, and that is a trigger rather than a convention">
          The rate card is effective-dated and append-only, following{" "}
          <code>approval_policy</code> and <code>funds_availability_policy</code>.{" "}
          <code>interest_rate_at(tier, date)</code> resolves on the ACCRUAL
          date, so a replay of an old day re-derives the old rate by
          construction. On top of that,{" "}
          <code>interest_rate_policy_forward_only</code> refuses any new row
          whose effective date is not strictly after every existing row for its
          tier <em>and</em> strictly after every date already accrued under it —
          because afterwards the postings are immutable and the only repair
          would be a reversal and a re-book of every affected day.{" "}
          <code>v_interest_rate_drift</code> ({interest.rateDrift} rows) asks the
          same question of the whole book at any moment.
        </Item>

        <Item title="Interest is priced on the SETTLED ledger balance, at a recorded watermark">
          Not the available balance: a hold is money the customer still has and
          we still owe, so we still owe interest on it — a card authorisation is
          not a withdrawal. The basis comes from{" "}
          <code>ledger_settled_cents()</code>, which is migration 0022&apos;s
          single definition of a balance and not a private copy, with both
          bitemporal predicates. The booking watermark it was true at is stored
          beside it, because &ldquo;the balance on 9 September&rdquo; is only an
          answer once you say when you asked. A correction backdated into a day
          already priced does NOT re-price it — the number stands and remains
          reproducible from the row — and the interest adjustment that would
          re-price it is named as a gap in docs/ACCRUAL.md rather than
          half-built.
        </Item>

        <Item title="Interest credited daily compounds daily, and that is visible rather than hidden">
          Each day&apos;s interest is posted to the deposit account at that
          day&apos;s value date, so the next day&apos;s basis includes it. The
          product therefore compounds daily and the effective annual yield is
          slightly above the quoted rate. That is a consequence of &ldquo;accrued
          at end of day, visibly, on the ledger&rdquo; rather than a separate
          decision — the alternative would be a second balance definition that
          excludes interest lines, which is exactly the drift migration 0022
          spent a pass undoing.
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
