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
import { cardStorySentence, clockSentence, entryHeadline, railWord } from "./language";
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
 * PROVIDER REFERENCE that both sides already carry — `journal_entry.
 * external_ref` and `hold.external_ref` — and on nothing else. Matching them by
 * amount and date is the join a reconciliation engine refuses to make, for the
 * reason that applies exactly here: two $73.40 card payments on the same day
 * are not the same payment.
 *
 * When there is no matching authorisation the row simply does not carry the
 * sentence. A force post — a settlement that arrives with no authorisation at
 * all — is a real case on this rail, and inventing an authorised figure for it
 * would be the screen making something up.
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
  for (const story of cardStories) byRef.set(story.externalRef, story);

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
                    story={row.externalRef === null ? undefined : byRef.get(row.externalRef)}
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
            {cardStorySentence(
              formatUsd(story.authorisedCents),
              formatUsd(story.clearedCents),
              formatUsd(story.remainingCents),
              story.closed,
            )}
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
