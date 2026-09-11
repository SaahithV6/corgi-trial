import { Money } from "@/components/ui/Money";
import { FieldLabel, Note, Panel } from "@/components/ui/primitives";

import { InterestArithmeticPanel } from "./InterestArithmeticPanel";
import { InterestDayTable } from "./InterestDayTable";
import { InterestEnrolmentTable } from "./InterestEnrolmentTable";
import { RateCardPanel } from "./RateCardPanel";
import type { InterestPanelView } from "./data-contract";
import type { AccrualFilter } from "./view-state";

/**
 * The interest half of `/accruals`.
 *
 * A sibling of the fee half rather than a second screen, because they are one
 * tick, one endpoint and one rounding policy with two clauses — and because
 * the interesting thing about them is precisely that they are DIFFERENT
 * arithmetic on the same book, which you cannot see if they are on two pages.
 *
 * The one thing this section refuses to do is imply a capability it has not
 * demonstrated. Overdraft interest is built, priced on the rate card, and has
 * posted nothing, because no deposit leaf on this book has been in debit on
 * any value date. `OverdraftMeasurement` says so with the numbers rather than
 * leaving a reader to infer it from an empty column.
 */
export function InterestSection({
  view,
  filter,
  bookDate,
}: {
  readonly view: InterestPanelView;
  readonly filter: AccrualFilter;
  readonly bookDate: string;
}) {
  const inv = view.invariants;
  const posted = view.days.filter((d) => d.disposition === "posted");
  const paid = posted.reduce(
    (t, d) => (d.arithmetic?.side === "credit" ? t + d.arithmetic.amountCents : t),
    0,
  );
  const charged = posted.reduce(
    (t, d) => (d.arithmetic?.side === "overdraft" ? t + d.arithmetic.amountCents : t),
    0,
  );
  const ties = posted.filter((d) => d.arithmetic?.rounding === "tie_to_even").length;
  const clean = inv.ledgerDrift === 0 && inv.rateDrift === 0;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold tracking-tight">
          Interest — a price for time and money
        </h2>
        <p className="mt-0.5 max-w-prose text-sm text-muted">
          The other half of the ladder, on the same daily tick. A balance and a
          number of days is not a fee for a service, so it does not go to{" "}
          <code>4200</code>: what we pay on a credit balance is an expense (
          <code>5400</code>) and what we charge on an overdraft is income (
          <code>4400</code>). One enrolment carries both rates and the sign of
          the balance on the day decides which one applies.
        </p>
      </header>

      {inv.ledgerDrift > 0 ? (
        <Note emphasis title="An interest posting disagrees with the journal entry it cites">
          <p>
            {inv.ledgerDrift} row{inv.ledgerDrift === 1 ? "" : "s"} in{" "}
            <code>v_interest_ledger_drift</code>: the amount, the value date or
            the side on an <code>interest_posting</code> is not what its journal
            entry says. <code>assert_interest_posting()</code> refuses that
            combination at insert, so a row here means the trigger is gone.
          </p>
        </Note>
      ) : null}

      {inv.rateDrift > 0 ? (
        <Note emphasis title="A day has been re-priced by a rate that came after it">
          <p>
            {inv.rateDrift} row{inv.rateDrift === 1 ? "" : "s"} in{" "}
            <code>v_interest_rate_drift</code>: a posting no longer resolves to
            the rate card that was effective on its own accrual date. That can
            only happen if a policy row was backdated behind{" "}
            <code>interest_rate_policy_forward_only</code> — and the days it
            re-priced are already on an append-only ledger, so the repair is a
            reversal and a re-book of each of them. Stop the tick.
          </p>
        </Note>
      ) : null}

      {inv.gap > 0 ? (
        <Note title="Interest days are owed that nothing has claimed">
          <p>
            {inv.gap} (enrolment, date) pair{inv.gap === 1 ? " is" : "s are"} due
            and unclaimed up to the book date. Normal for a few minutes after an
            enrolment is created and before the first tick; persistent means the
            tick is not running. Nothing is lost — the entry carries the date it
            accrued for — but the customer is owed interest the ledger has not
            yet credited.
          </p>
        </Note>
      ) : null}

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
        <Tile
          label="Paid to customers"
          value={<Money cents={paid} tone="neutral" />}
          note={`${posted.filter((d) => d.arithmetic?.side === "credit").length} day${
            posted.filter((d) => d.arithmetic?.side === "credit").length === 1 ? "" : "s"
          } of credit interest, debited to 5400`}
        />
        <Tile
          label="Charged on overdrafts"
          value={<Money cents={charged} tone="neutral" />}
          note={
            charged === 0
              ? "nothing — no deposit account has been in debit; see the measurement below"
              : `${posted.filter((d) => d.arithmetic?.side === "overdraft").length} day(s), credited to 4400`
          }
        />
        <Tile
          label="Exact half-cents"
          value={String(ties)}
          note={
            ties === 0
              ? "no day has landed on an exact half cent; §12.2's tiebreak is implemented and has not been needed"
              : "days where the fraction was exactly half a cent and §12.2 broke the tie to the even cent"
          }
        />
        <Tile
          label="Exactness"
          value={clean ? "EXACT" : `${inv.ledgerDrift + inv.rateDrift} DRIFT`}
          note={
            clean
              ? `every posting matches its entry · no day re-priced by a later rate · ${inv.unresolved} claimed and undecided`
              : "a posting disagrees with its entry, or a day has been re-priced"
          }
        />
      </div>

      <OverdraftMeasurement view={view} />

      <Panel
        title="The rate card"
        description="Effective-dated and append-only, following approval_policy and funds_availability_policy. A rate change is a NEW ROW with a later effective date — and interest_rate_policy_forward_only refuses any row that would re-price a date already accrued, so yesterday cannot be re-priced by accident or on purpose."
      >
        <RateCardPanel rows={view.rateCard} bookDate={bookDate} />
      </Panel>

      <Panel
        title="Enrolled accounts"
        description="One enrolment per account, carrying both rates. There is no product to choose: the sign of the balance on a business date decides which side of the book that date lands on."
      >
        <InterestEnrolmentTable rows={view.schedules} filter={filter} />
      </Panel>

      <Panel
        title="By day"
        description="One row per business date per enrolment, newest first, with the balance it was priced on, the rate that applied on THAT date, the exact fraction as two integers, and which way DESIGN §12.2 rounded it."
      >
        <InterestDayTable
          rows={view.days}
          filter={filter}
          scheduleCount={view.schedules.length}
        />
      </Panel>

      {view.selected === null ? (
        <p className="text-xs text-muted">
          Select an interest date to see the full working — balance, watermark,
          rate, day-count convention, the exact fraction, and what happened to
          the sub-cent remainder.
        </p>
      ) : (
        <InterestArithmeticPanel row={view.selected} filter={filter} />
      )}
    </div>
  );
}

/**
 * What the book actually shows about overdrafts, measured on every render.
 *
 * This panel exists because the honest state of this feature is asymmetric and
 * a screen that hid that would be claiming a capability nothing has proven.
 * The brief that commissioned this work said the book had an account around
 * −$1,800. It does not, and did not: `v_overdrawn_accounts` is empty, and so
 * is the stronger question — whether ANY deposit leaf was in debit on ANY
 * value date inside the 45-day catch-up window.
 *
 * So `4400 Interest income — overdraft` exists, is priced on the rate card,
 * and carries no rows. The day an account does cross zero, the same enrolment
 * prices that day on 4400 with nothing reconfigured, and this panel changes on
 * its own.
 */
function OverdraftMeasurement({ view }: { readonly view: InterestPanelView }) {
  const inv = view.invariants;
  const overdraftDays = view.days.filter((d) => d.arithmetic?.side === "overdraft").length;
  const card = view.rateCard.find((r) => r.supersededOn === null && r.tier === "standard");

  if (inv.overdrawnAccounts > 0 || overdraftDays > 0) {
    return (
      <Note title="Overdraft interest is live on this book">
        <p>
          <code>v_overdrawn_accounts</code> returns {inv.overdrawnAccounts} row
          {inv.overdrawnAccounts === 1 ? "" : "s"} right now, and{" "}
          {inv.overdrawnDaysInWindow} (account, value date) pair
          {inv.overdrawnDaysInWindow === 1 ? " was" : "s were"} in debit inside
          the 45-day catch-up window. {overdraftDays} day
          {overdraftDays === 1 ? " has" : "s have"} been priced on the overdraft
          side and posted to <code>4400</code>.
        </p>
      </Note>
    );
  }

  return (
    <Note title="Overdraft interest is built, priced, and has no rows — measured, not assumed">
      <p>
        <code>v_overdrawn_accounts</code> returns <strong>0</strong> rows, and
        the stronger question returns <strong>{inv.overdrawnDaysInWindow}</strong>{" "}
        too: no customer deposit leaf has had a debit balance on{" "}
        <em>any</em> value date inside the 45-day catch-up window, at the live
        booking watermark. Every deposit account on this book is in credit and
        has been.
      </p>
      <p className="mt-2">
        So <code>4400 Interest income — overdraft</code> exists, is postable, is
        priced on the rate card
        {card === undefined
          ? ""
          : ` at ${percent(card.overdraftRateBps)} a year, ACT/${card.dayCountDenominator}`}
        , and carries a zero balance. That is the state of the book, not a gap
        in the feature: the enrolment already carries both rates, and the first
        business date on which an account closes in debit will price on 4400
        with nothing reconfigured and nothing deployed. The brief for this work
        said one account was around −$1,800; it was re-measured before a line
        was written, and it is not.
      </p>
      <p className="mt-2">
        The day side that IS demonstrated is credit interest — what we pay for
        holding a balance — and it is the larger of the two costs a
        deposit-taking business has, which is why it lives in its own expense
        account rather than netted into <code>5100</code>.
      </p>
    </Note>
  );
}

function percent(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(Math.abs(bps % 100)).padStart(2, "0")}%`;
}

function Tile({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly note: string;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <FieldLabel>{label}</FieldLabel>
      <p className="mt-1.5 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}
