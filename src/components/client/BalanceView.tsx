import { Money } from "@/components/ui/Money";
import {
  Badge,
  FieldLabel,
  MetaList,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import { formatCountdown, formatTimestamp } from "@/lib/format/datetime";

import type { BalanceScreen, BalanceTerms, HoldLine } from "./contract";
import { ClientHeaderBar } from "./Chrome";
import { holdKindExplanation, holdKindWord } from "./language";
import type { ClientView } from "./view-state";

/**
 * The headline a business owner actually needs.
 *
 * ===========================================================================
 * THE ONE NUMBER, AND THE ONE FUNCTION IT CAME FROM
 * ===========================================================================
 *
 * `terms` is `ledger_availability()`'s own five-column answer, carried across
 * unchanged. This component does not sum the hold table underneath it to
 * produce the total, does not clamp anything at zero, and does not compute
 * `available` at all — it RESTATES a subtraction Postgres already did, which is
 * why the figures on this screen and the figures on `/accounts` cannot
 * disagree: there is nothing here that could disagree.
 *
 * That is not a hypothetical discipline. This system has held four definitions
 * of "available" at once, two of which printed at the same instant on two
 * screens and differed by $25,040.70, and an agent surface was later caught
 * holding a fifth that read $17,035.50 above the customer's own screen. The
 * fix was not better care; it was migration 0022 putting the definition in one
 * SQL function and every caller reading it. This is the fifth caller.
 *
 * ===========================================================================
 * WHY THE SUBTRACTION IS ON THE SCREEN AT ALL
 * ===========================================================================
 *
 * Because the difference between the two figures is the entire product. A
 * customer who is told "balance $58,346.31, available $35,735.13" and nothing
 * else assumes the bank is holding their money for no reason. The three terms
 * that separate them are three genuinely different facts — their own card
 * spending, a deposit inside its return window, and money already committed out
 * — and each calls for a different response, so each gets its own row and its
 * own sentence. The word "memo" does not appear.
 */
export function BalanceView({
  screen,
  view,
}: {
  readonly screen: BalanceScreen;
  readonly view: ClientView;
}) {
  const { header, terms, holds } = screen;
  const negative = terms.availableCents < 0n;
  const differ = terms.availableCents !== terms.ledgerCents;

  return (
    <div className="space-y-6">
      <ClientHeaderBar
        screen="/client"
        view={view}
        header={header}
        title="Your balance"
        subtitle="What you have, what you can spend right now, and why those are two different numbers."
      />

      <section
        aria-labelledby="headline"
        className="rounded-lg border border-border bg-surface px-5 py-6"
      >
        <h2 id="headline" className="sr-only">
          Balance
        </h2>
        <div className="flex flex-wrap items-end gap-x-12 gap-y-6">
          <div>
            <FieldLabel>You can spend right now</FieldLabel>
            <p className="mt-1.5">
              <Money cents={terms.availableCents} className="text-4xl font-semibold" />
            </p>
            {negative ? (
              <p className="mt-1 text-xs text-negative">
                Below zero. Read the note underneath — this is correct, not a fault.
              </p>
            ) : null}
          </div>

          <div>
            <FieldLabel>In your account</FieldLabel>
            <p className="mt-1.5">
              <Money cents={terms.ledgerCents} className="text-2xl font-medium" tone="neutral" />
            </p>
            <p className="mt-1 text-xs text-muted">
              Every payment in and out that has been booked to your account.
            </p>
          </div>
        </div>

        <div className="mt-5 border-t border-border pt-3">
          <MetaList
            items={[
              { label: "as of", value: formatTimestamp(header.asOf) },
              { label: "business day", value: header.valueDate },
              { label: "everything we have learned up to", value: `entry ${header.bookingWatermark}` },
            ]}
          />
        </div>
      </section>

      {negative ? (
        <Note emphasis title="Your spendable balance is below zero, and that is the right answer">
          <p>
            You have{" "}
            <Money cents={terms.ledgerCents} tone="neutral" /> in the account and
            you can spend <Money cents={terms.availableCents} />. The gap is
            money that has <em>arrived</em> but has not <em>cleared</em>: an
            incoming bank transfer can be returned by the sender&rsquo;s bank
            after it lands, so we hold it for the return window rather than let
            you spend against something that can come back.
          </p>
          <p className="mt-2">
            We do not round this up to zero. A screen that showed &ldquo;$0.00
            available&rdquo; here would be hiding the size of the position from
            the person who has to manage it — and the figure would stop matching
            the one your bank is looking at.
          </p>
        </Note>
      ) : null}

      {differ ? (
        <Panel
          title="Why those two numbers are different"
          description="Line by line, in whole cents. This is the same subtraction the ledger did, written out — not a second calculation."
        >
          <DerivationTable terms={terms} />
        </Panel>
      ) : (
        <Panel
          title="Nothing is being held"
          description="Your spendable balance and your account balance are the same figure, because there is nothing set aside and nothing on its way out."
        >
          <DerivationTable terms={terms} />
        </Panel>
      )}

      <Panel
        title="What is set aside right now"
        description={
          holds.length === 0
            ? "Nothing. No card payment is waiting to settle, no deposit is inside its return window, and your bank has set nothing aside."
            : "Each one with its own arithmetic — what was authorised, what has settled, and what is still held. Not a conclusion: the numbers add up in front of you."
        }
      >
        {holds.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            There is nothing held against this account.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {holds.map((hold) => (
              <HoldRow key={hold.holdId} hold={hold} asOf={header.asOf} />
            ))}
          </ul>
        )}
      </Panel>

      <Note title="Where this number comes from">
        Your spendable balance is read from one function in the database —{" "}
        <code>ledger_availability()</code> — which every screen in this bank
        reads, including the one your bank&rsquo;s staff are looking at. There is
        no second copy of it and there is no stored balance anywhere in this
        system: every figure above is folded from the individual entries on your
        account at the instant this page loaded, which is why the page tells you
        that instant.
      </Note>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The subtraction, as rows.
 *
 * Every figure is `bigint` cents rendered by `<Money>`, which does integer
 * arithmetic on `bigint` and never touches a float. There is no division by
 * 100 anywhere in this file.
 *
 * The total row prints the FUNCTION'S answer, not the sum of the rows above it.
 * They are equal — that is the definition — but printing a locally computed
 * total would create a second number that could one day be different, and this
 * screen exists to have exactly one.
 */
function DerivationTable({ terms }: { readonly terms: BalanceTerms }) {
  const rows: readonly {
    readonly label: string;
    readonly hint: string;
    readonly cents: bigint;
    readonly negate: boolean;
  }[] = [
    {
      label: "In your account",
      hint: "Everything booked to your account, on or before today.",
      cents: terms.ledgerCents,
      negate: false,
    },
    {
      label: "Card payments waiting to settle",
      hint: "Someone used a card. The merchant has said what they expect to take; the final amount can differ and can arrive days later.",
      cents: terms.holdsCents,
      negate: true,
    },
    {
      label: "Money in, not cleared yet",
      hint: "It has landed. It can still be returned by the sender's bank, so it is not spendable until the return window closes.",
      cents: terms.unclearedCents,
      negate: true,
    },
    {
      label: "Payments already on their way out",
      hint: "You have instructed these and they are booked to leave. They are gone as far as spending goes, even if they have not arrived yet.",
      cents: terms.pendingOutboundCents,
      negate: true,
    },
  ];

  return (
    <TableScroll>
      <table className="w-full border-collapse">
        <caption className="sr-only">
          How your spendable balance is worked out from your account balance
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>
              What
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border">
              <td className={TD_CLASS}>
                <span className="font-medium">
                  {row.negate ? "less " : ""}
                  {row.label}
                </span>
                <span className="mt-0.5 block max-w-prose text-xs text-muted">
                  {row.hint}
                </span>
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                <Money
                  cents={row.negate ? -row.cents : row.cents}
                  tone={row.negate ? "direction" : "neutral"}
                  signed={row.negate}
                />
              </td>
            </tr>
          ))}
          <tr className="bg-surface-raised">
            <td className={`${TD_CLASS} font-semibold`}>
              What you can spend right now
              <span className="mt-0.5 block max-w-prose text-xs font-normal text-muted">
                The database&rsquo;s own answer, not a total added up on this page.
              </span>
            </td>
            <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
              <Money cents={terms.availableCents} className="font-semibold" />
            </td>
          </tr>
        </tbody>
      </table>
    </TableScroll>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * One hold, with the arithmetic rather than the verdict.
 *
 * `remaining` is not recomputed here. It is `max(authorised − cleared, 0)`
 * folded over the authorisation's whole event set by the hold model, which is
 * the only thing that survives an increment, a partial capture, an
 * over-capture and a reversal arriving in any order. A screen that subtracted
 * two columns would be right until the day a reversal landed out of order.
 */
function HoldRow({
  hold,
  asOf,
}: {
  readonly hold: HoldLine;
  /**
   * The one instant the whole screen was read at, passed in rather than read
   * from `Date.now()` here — `@/lib/format/datetime` states the rule and the
   * reason: a page that reads the clock deep inside a component is not a pure
   * function of its inputs and its fixtures stop being reproducible.
   */
  readonly asOf: string;
}) {
  const card = hold.kind === "card_auth";

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{holdKindWord(hold.kind)}</span>
            {hold.pending ? (
              <Badge tone="quiet" title="This hold is dated later than today, so it is not taken off today's spendable balance.">
                starts later
              </Badge>
            ) : null}
            {hold.releaseWaitsOnAPerson ? (
              <Badge tone="neutral" title="No clock releases this. A person does.">
                released by a person
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-sm">{hold.descriptor}</p>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {holdKindExplanation(hold.kind)}
          </p>
          <p className="mt-1 text-[11px] text-muted">
            Reference <code>{hold.externalRef}</code>
            {hold.availableAt === null
              ? hold.releaseWaitsOnAPerson
                ? " · no release date: this one is released by a person"
                : ""
              : ` · expected to clear ${formatTimestamp(hold.availableAt)} (${formatCountdown(hold.availableAt, asOf)})`}
            {hold.policyDays === null
              ? ""
              : ` · held for ${hold.policyDays} banking day${hold.policyDays === 1 ? "" : "s"} under the funds policy in force when it was placed`}
          </p>
        </div>

        <dl className="flex shrink-0 flex-wrap gap-x-6 gap-y-1 text-right text-xs">
          {card ? (
            <>
              <div>
                <dt className="text-muted">authorised</dt>
                <dd>
                  <Money cents={hold.authorisedCents} tone="neutral" />
                </dd>
              </div>
              <div>
                <dt className="text-muted">settled so far</dt>
                <dd>
                  <Money cents={hold.clearedCents} tone="neutral" />
                </dd>
              </div>
            </>
          ) : null}
          <div>
            <dt className="text-muted">still set aside</dt>
            <dd>
              <Money cents={hold.remainingCents} className="font-medium" />
            </dd>
          </div>
        </dl>
      </div>
    </li>
  );
}
