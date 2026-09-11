import { Money } from "@/components/ui/Money";
import {
  Badge,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import type { ActivityRow, ActivityScreen, CardStory } from "./contract";
import { ClientHeaderBar } from "./Chrome";
import { clockSentence, entryHeadline, railWord } from "./language";
import type { ClientView } from "./view-state";
import { formatUsd } from "@/lib/format/money";

/**
 * Their transactions, in plain language.
 *
 * ===========================================================================
 * ONE MOVEMENT, ONE ROW — AND THE CARD STORY ATTACHED TO IT
 * ===========================================================================
 *
 * The brief asks for "Card payment at a fuel pump, authorised $50, settled
 * $73.40" rather than four journal lines, and the interesting half of that
 * sentence is not the wording — it is that the two figures come from two
 * different places and have to be joined without lying.
 *
 * The settled amount is a journal line on the customer's account. The
 * authorised amount is not on the journal at all: it is a fold over the card
 * authorisation's event set, held in the memo book. They are joined on the
 * PROVIDER AUTHORISATION ID that both sides already carry — and on nothing
 * else. Matching them by amount and date is the join a reconciliation engine
 * refuses to make, for the reason that applies exactly here: two $73.40 card
 * payments on the same day are not the same payment.
 *
 * The lookup key is `story.providerRef`, NOT `story.externalRef`. The hold
 * spells that id `lithic:acc10f7c-…` and the settlement spells it `acc10f7c-…`;
 * keying on the hold's spelling matched nothing on any live book and this
 * sentence had never rendered. See the header of `readActivityScreen`.
 *
 * When there is no matching authorisation the row simply does not carry the
 * sentence. A force post — a settlement that arrives with no authorisation at
 * all — is a real case on this rail, and there are 211 of them on this book.
 * It DOES reach a hold, created `clearing_first`, so the story is found; but
 * A(E) is zero because no authorisation event ever landed, and printing "held
 * $0.00" would be the screen making something up. That case says so instead.
 *
 * ===========================================================================
 * BOTH CLOCKS, ALWAYS, WHEN THEY DIFFER
 * ===========================================================================
 *
 * Value date is when it happened; booking date is when we learned. A
 * settlement reversed on Thursday posts at Tuesday's value date, so Tuesday's
 * figures change and Wednesday's belief is still reproducible. A customer
 * statement that printed one date would make that look like the bank quietly
 * editing history, which is the one thing this ledger never does.
 */
export function ActivityView({
  screen,
  view,
  correctionsOnly,
}: {
  readonly screen: ActivityScreen;
  readonly view: ClientView;
  readonly correctionsOnly: boolean;
}) {
  const { header, rows, cardStories } = screen;

  const byRef = new Map<string, CardStory>();
  for (const story of cardStories) byRef.set(story.providerRef, story);

  // A VIEW over rows that are already scoped to this customer, not a scoping
  // step. The isolation happened in the WHERE clause that produced `rows`;
  // this picks which of the customer's own rows are the point of the edge
  // state. `edgeMembers()` in src/lib/team/screen.ts is the same pattern.
  const shown = correctionsOnly
    ? rows.filter((r) => r.entryType !== "original" || r.correctionGroupId !== null)
    : rows;

  return (
    <div className="space-y-6">
      <ClientHeaderBar
        screen="/client/activity"
        view={view}
        header={header}
        title="Your activity"
        subtitle="Everything that has moved through your account, newest first — and for card payments, what was authorised beside what actually settled."
      />

      {correctionsOnly ? (
        <Note title="Corrections only">
          {shown.length === 0
            ? "Nothing on this account has been corrected. That is a real answer about a real book, not an empty fixture — switch customer, or go back to the default state."
            : "A correction is a new entry, never an edit. The original is still here and so is the entry that reverses it; both are dated the day the thing happened, and the account balance for that day changed when we learned the truth."}
        </Note>
      ) : null}

      <Panel
        title={correctionsOnly ? "Corrected transactions" : "Transactions"}
        description={
          shown.length === 0
            ? "Nothing here yet."
            : `${shown.length} movement${shown.length === 1 ? "" : "s"}, newest first. Amounts are from your point of view: money in is positive.`
        }
      >
        {shown.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            There is nothing to show on this account.
          </p>
        ) : (
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">Your transactions</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={TH_CLASS}>
                    Date
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    What happened
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <TransactionRow
                    key={`${row.entryId}:${row.bookingSeq}`}
                    row={row}
                    // Card rows where money LEFT, and only those.
                    //
                    // Card rail, because a bare provider reference on another
                    // rail is a different namespace and a chance collision
                    // would attach a card's authorisation to a wire.
                    //
                    // Money out, because the sentence is about the settlement:
                    // a refund and the reversal of a clearing share the same
                    // authorisation and would each repeat "taken when it
                    // settled" about a row on which nothing was taken.
                    //
                    // Originals, because a correction already says what it is
                    // in its own headline, and three adjacent rows repeating
                    // one authorisation's story is noise on the row that
                    // matters. The settlement keeps it.
                    story={
                      row.rail !== "card" ||
                      row.entryType !== "original" ||
                      row.amountCents >= 0n ||
                      row.externalRef === null
                        ? undefined
                        : byRef.get(row.externalRef)
                    }
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Note title="Why some transactions show two dates">
        When a payment is corrected, or arrives late, the day it{" "}
        <em>happened</em> and the day we <em>found out</em> are different. We
        keep both. Your transaction stays on the day it happened — so the
        balance for that day is right — and we record separately when we learned
        about it, so we can always show you what your account looked like at any
        moment in the past. Nothing is ever rewritten or removed.
      </Note>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The two figures, in the customer's words, on the row they belong to.
 *
 * Every number here is read off the hold fold that `listHoldRows` already
 * computed — A(E), C(E), H(E). Nothing is recomputed and no second definition
 * of a hold is introduced; the only arithmetic is C(E) − A(E), which is the
 * difference the customer is actually asking about and is not a hold.
 *
 * "More than expected" is the fuel pump over-capturing and the restaurant
 * adding a tip — the everyday case, not an error — so it is worded as a fact
 * rather than a warning. "Less than expected" is the same sentence with the
 * comparison flipped, and it carries the remaining figure because that money
 * is still withheld and the customer can see it missing from available.
 *
 * A FORCE POST GETS NO INVENTED FIGURE. A settlement that arrives with no
 * authorisation behind it still creates a hold — `ensureAuthorization()` with
 * `origin = 'clearing_first'` — so this function is reached with A(E) = 0.
 * Quoting "held $0.00" would read as a fact about the authorisation, and there
 * was no authorisation. It says that instead.
 */
function customerCardStory(story: CardStory): string {
  const cleared = formatUsd(story.clearedCents);

  if (story.authorisedCents <= 0n) {
    return story.clearedCents > 0n
      ? `Nothing was held for this one — it reached us without an authorisation, and ${cleared} was taken when it settled.`
      : "Nothing was held for this one — it reached us without an authorisation.";
  }

  const held = `Held ${formatUsd(story.authorisedCents)} when it was authorised`;

  if (story.clearedCents === 0n) {
    return story.closed
      ? `${held} · nothing was ever taken, and that money is yours again.`
      : `${held} · nothing has settled yet, so ${formatUsd(story.remainingCents)} is still set aside.`;
  }

  const gap = story.clearedCents - story.authorisedCents;
  const compared =
    gap === 0n
      ? "exactly what was expected"
      : gap > 0n
        ? `${formatUsd(gap)} more than expected`
        : `${formatUsd(-gap)} less than expected`;

  const tail =
    story.closed || story.remainingCents === 0n
      ? ""
      : ` The remaining ${formatUsd(story.remainingCents)} is still set aside.`;

  return `${held} · taken ${cleared} when it settled · ${compared}.${tail}`;
}

/* -------------------------------------------------------------------------- */

function TransactionRow({
  row,
  story,
}: {
  readonly row: ActivityRow;
  readonly story: CardStory | undefined;
}) {
  const clocks = clockSentence(row.valueDate, row.bookingDate);
  const corrected = row.entryType !== "original";

  return (
    <tr className="border-b border-border">
      <td className={`${TD_CLASS} whitespace-nowrap`}>
        <span className="text-sm">{row.valueDate}</span>
        {clocks === null ? null : (
          <span className="mt-0.5 block text-[11px] text-muted">
            learned {row.bookingDate}
          </span>
        )}
      </td>

      <td className={TD_CLASS}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{entryHeadline(row)}</span>
          <Badge tone="quiet">{railWord(row.rail)}</Badge>
          {corrected ? <Badge tone="negative">correction</Badge> : null}
        </div>

        {story === undefined ? null : (
          <p className="mt-1 max-w-prose text-xs leading-relaxed">
            {customerCardStory(story)}
          </p>
        )}

        {clocks === null ? null : (
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{clocks}</p>
        )}

        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
          {row.description}
          {row.externalRef === null ? null : (
            <>
              {" · "}
              <code>{row.externalRef}</code>
            </>
          )}
        </p>
      </td>

      <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
        <Money cents={row.amountCents} tone="direction" signed />
      </td>
    </tr>
  );
}
