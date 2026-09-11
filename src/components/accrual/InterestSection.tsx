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
 * demonstrated. Overdraft interest is built and priced on the rate card and
 * has posted nothing — and as of 2026-09-11 that is NO LONGER because nothing
 * has been in debit. One account is overdrawn by $858,941.45; the one business
 * date it closed in debit had already been claimed by the credit side, hours
 * earlier, while the date was still open. `OverdraftMeasurement` has three
 * branches for exactly that reason: rows on 4400, an overdraft with no rows,
 * and no overdraft at all. The middle one is the truth today and it is the
 * only one of the three that is not a slogan.
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
            and unclaimed up to the book date. <strong>Today is normally one of
            them for every enrolment</strong>: the tick will not price a business
            date until it has closed, because the basis is the settled balance at
            the END of the date — so the open day stands here until midnight and
            is taken by the first tick after it. Anything OLDER than today
            persisting means the tick is not running. Nothing is lost either way:
            the entry carries the date it accrued for, not the date the job ran.
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
              ? inv.overdrawnAccounts > 0
                ? `nothing yet — and ${inv.overdrawnAccounts} account${
                    inv.overdrawnAccounts === 1 ? " is" : "s are"
                  } overdrawn right now; read the measurement below`
                : "nothing — no deposit account is in debit; see the measurement below"
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

      {inv.pricedBeforeClose > 0 ? (
        <Note emphasis title="Days priced before their own business date closed">
          <p>
            <strong>{inv.pricedBeforeClose}</strong> posted interest day
            {inv.pricedBeforeClose === 1 ? "" : "s"} on this book
            {inv.pricedBeforeClose === 1 ? " was" : " were"} claimed on or
            before {inv.pricedBeforeClose === 1 ? "its" : "their"} own accrual
            date, moving <Money cents={inv.pricedBeforeCloseCents} tone="neutral" />.
            The basis is defined as the settled balance at the END of a business
            date; a date that has not ended has no such balance, so what those
            rows were priced on is the balance at the instant the tick ran.
          </p>
          <p className="mt-2">
            They cannot be re-<em>priced</em>: <code>interest_day</code> is{" "}
            <code>UNIQUE (schedule_id, accrual_date)</code>, and that is the
            index that makes the tick exactly-once. The tick was changed so this
            cannot recur — <code>interestPricingHorizon()</code> holds the open
            date back to the last date that has closed, a tick asked for today
            reports <code>openDateHeld</code> and prices through yesterday, and
            migration 0049 refuses the posting in Postgres whether or not that
            function is still there.
          </p>
          <p className="mt-2">
            They <em>are</em> corrected, by append. A re-price is not a second
            interest day, so it is not one: <code>interest_adjustment</code> is
            a different claim about the same day — a reversal and a re-book at
            the ORIGINAL value date, keyed{" "}
            <code>interest-adj:&lt;enrolment&gt;:&lt;date&gt;:&lt;watermark&gt;</code>
            . <strong>{inv.adjustments}</strong> day
            {inv.adjustments === 1 ? " has" : "s have"} been corrected and{" "}
            <strong>{inv.mispricedUncorrected}</strong> {" "}
            {inv.mispricedUncorrected === 1 ? "is" : "are"} queued in{" "}
            <code>v_interest_mispriced_uncorrected</code>.
            {inv.mispricedUncorrected === 0 && inv.adjustments === 0 ? (
              <>
                {" "}
                That queue is zero because the mispriced dates{" "}
                <strong>have not closed yet</strong>, not because there is
                nothing to do. The correction re-books what the date actually
                closed at, and a date that is still open has no such figure —
                correcting a mid-day price with a second mid-day price is the
                same defect twice, so{" "}
                <code>interest_adjustment_after_close</code> refuses it. The
                queue fills itself at midnight America/New_York.
              </>
            ) : null}
          </p>
        </Note>
      ) : null}

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

  if (overdraftDays > 0) {
    return (
      <Note title="Overdraft interest is live on this book">
        <p>
          <code>v_overdrawn_accounts</code> returns {inv.overdrawnAccounts} row
          {inv.overdrawnAccounts === 1 ? "" : "s"} right now (
          <Money cents={inv.overdrawnCents} tone="neutral" /> overdrawn), and{" "}
          {inv.overdrawnDaysInWindow} (account, value date) pair
          {inv.overdrawnDaysInWindow === 1 ? " was" : "s were"} in debit inside
          the 45-day catch-up window. {overdraftDays} day
          {overdraftDays === 1 ? " has" : "s have"} been priced on the overdraft
          side and posted to <code>4400</code>.
        </p>
      </Note>
    );
  }

  // THE HONEST MIDDLE CASE, AND THE ONE THIS BOOK IS IN: an account IS
  // overdrawn and `4400` still has nothing on it. Saying "live" here would be
  // a capability claim no row supports; saying "nothing has been in debit"
  // would be false. So it says both numbers and the reason they disagree.
  if (inv.overdrawnAccounts > 0) {
    return (
      <Note emphasis title="An account IS overdrawn — and 4400 still has no rows. Both, with the reason.">
        <p>
          <code>v_overdrawn_accounts</code> returns{" "}
          <strong>{inv.overdrawnAccounts}</strong> row
          {inv.overdrawnAccounts === 1 ? "" : "s"} right now —{" "}
          <Money cents={inv.overdrawnCents} tone="neutral" /> in debit — and{" "}
          <strong>{inv.overdrawnDaysInWindow}</strong> (account, value date)
          pair{inv.overdrawnDaysInWindow === 1 ? "" : "s"} inside the 45-day
          catch-up window closed in debit. Zero days have been priced on the
          overdraft side. Those two facts are not a contradiction and the reason
          is worth more than either of them.
        </p>
        <p className="mt-2">
          The one business date on which this book has ever closed in debit was
          already <em>claimed</em> — by the credit side, hours earlier, while
          the date was still open and the account was still in credit.{" "}
          <code>interest_day</code> is <code>UNIQUE (schedule_id,
          accrual_date)</code>, which is what makes the tick exactly-once, and
          it is the same index that makes a day priced early impossible to
          price again. {inv.pricedBeforeClose > 0 ? (
            <>
              <strong>{inv.pricedBeforeClose}</strong> posted interest day
              {inv.pricedBeforeClose === 1 ? "" : "s"} on this book
              {inv.pricedBeforeClose === 1 ? " was" : " were"} claimed on or
              before {inv.pricedBeforeClose === 1 ? "its" : "their"} own accrual
              date, moving <Money cents={inv.pricedBeforeCloseCents} tone="neutral" />
              .
            </>
          ) : null}
        </p>
        <p className="mt-2">
          The tick no longer prices an open business date —{" "}
          <code>interestPricingHorizon()</code> stops it at the last date that
          has actually closed — so the next date that closes in debit prices on{" "}
          <code>4400</code>
          {card === undefined
            ? ""
            : ` at ${percent(card.overdraftRateBps)} a year, ACT/${card.dayCountDenominator}`}{" "}
          with nothing reconfigured and nothing deployed.
        </p>
        <p className="mt-2">
          The rows already written stand — nothing is edited on this ledger —
          and they are <strong>corrected by append</strong>: an interest
          adjustment, the product §19 named, built by migration 0049. It is a
          reversal of the wrong entry plus a re-book at the ORIGINAL value date,
          which for this account crosses sides — <code>5400</code> paid back,{" "}
          <code>4400</code> charged. That correction has to price the balance the
          date actually CLOSED at, so it waits for the date to close for exactly
          the reason the tick now does;{" "}
          <code>v_interest_mispriced_uncorrected</code> holds{" "}
          <strong>{inv.mispricedUncorrected}</strong> and{" "}
          <code>interest_adjustment</code> holds{" "}
          <strong>{inv.adjustments}</strong>. The first date that closes in debit
          with the horizon in place needs no correction at all: it prices on{" "}
          <code>4400</code> the first time.
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
