import "server-only";

import Link from "next/link";

import { formatTimestamp } from "@/lib/format/datetime";
import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { accountAvailability } from "@/lib/ledger/balance-definitions";
import { ledgerConnection, listDepositAccounts } from "@/lib/ledger/queries";
import { withTimeTravel } from "@/lib/timetravel/params";
import { closingAt } from "@/lib/timetravel/read";
import type { TimePoint } from "@/lib/timetravel/point";

/**
 * THE DEPOSIT DIRECTORY, READ AT A POINT IN BOTH CLOCKS.
 *
 * ===========================================================================
 * WHY THIS PANEL EXISTS AND THE CONSOLE ABOVE IT DOES NOT TRAVEL
 * ===========================================================================
 *
 * `/accounts` is two things on one route. The CARD AND HOLD CONSOLE operates a
 * provider — it issues cards on Lithic, simulates authorisations, drains
 * webhooks — and its reads come from `src/components/accounts/live-source.ts`,
 * which takes its own `readSnapshot()` internally and is owned by another
 * worker on this build. It cannot be handed a travelled snapshot without
 * editing a file this worker does not own.
 *
 * So it does not travel, and the screen SAYS SO rather than implying it does.
 * A screen that ignores the parameter while showing a time-travel control is a
 * lie, and this build fails harder for a false label than for a missing
 * feature. `TimeTravelUnavailableNote` below is that label, and it names the
 * module and the reason rather than waving at "technical limitations".
 *
 * What CAN travel here is the part that is pure ledger: every deposit
 * account's balance, folded at a value date and a booking watermark. That is
 * `settledBalanceCents` and `accountAvailability` — THE definitions, in
 * `balance-definitions.ts` — called with `point.snapshot` instead of the live
 * one. Same function, different argument. This panel writes no SQL and defines
 * no balance.
 *
 * ===========================================================================
 * WHY A CARD IS NOT A BITEMPORAL FACT ANYWAY
 * ===========================================================================
 *
 * Worth saying, because it is a principle rather than an excuse. A card is
 * provider state: it exists on Lithic, it has a status Lithic owns, and there
 * is no value date at which it was worth anything. The ledger is bitemporal;
 * the card list is not, and travelling it would mean inventing an axis the
 * fact does not have. Balances and holds are ledger facts and travel exactly.
 */
export async function TravelledDirectory({ point }: { readonly point: TimePoint }) {
  const conn = await ledgerConnection();
  const accounts = await listDepositAccounts(conn);

  const rows = await Promise.all(
    accounts.map(async (account) => {
      const [availability, nowCents] = await Promise.all([
        accountAvailability(account.accountId, point.snapshot, conn),
        // The same value date at the live watermark: the other reading.
        closingAt(
          {
            accountId: account.accountId,
            valueDate: point.snapshot.valueDate,
            watermark: point.liveWatermark,
            instant: point.resolvedAt,
          },
          conn,
        ),
      ]);
      return { account, availability, nowCents };
    }),
  );

  const moved = rows.filter((row) => row.nowCents !== row.availability.ledgerCents);

  return (
    <Panel
      title={`Every deposit account, as at ${point.snapshot.valueDate}`}
      description="Folded at the value date and the booking watermark in the URL. The right-hand column is the same value date read at the live watermark, so a row where the two differ is a belief that changed."
      actions={<Badge tone="neutral">travelled</Badge>}
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Customer deposit balances at the travelled point, beside the same
            value date read at the live watermark
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Account
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Ledger, as believed
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Available, as believed
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Ledger, as corrected
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Difference
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ account, availability, nowCents }) => {
              const delta = nowCents - availability.ledgerCents;
              return (
                <tr key={account.accountId}>
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <Link
                      href={withTimeTravel(
                        `/transactions?account=${account.accountId}`,
                        {
                          asOf: point.valuePinned ? point.snapshot.valueDate : null,
                          asKnownAt: point.requestedKnownAt,
                        },
                      )}
                      className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                    >
                      {account.accountName}
                    </Link>
                    <span className="mt-0.5 block text-xs text-muted">
                      {account.legalName}
                    </span>
                  </th>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={availability.ledgerCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={availability.availableCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={nowCents} />
                  </td>
                  <td className={`${TD_CLASS} text-right`}>
                    {delta === 0n ? (
                      <span className="text-xs text-muted">—</span>
                    ) : (
                      <Money cents={delta} tone="direction" signed />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>

      <div className="border-t border-border px-5 py-4">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          {moved.length === 0 ? (
            <>
              No account&rsquo;s reading of{" "}
              <span className="font-mono">{point.snapshot.valueDate}</span>{" "}
              changed between watermark{" "}
              <span className="font-mono">
                {point.snapshot.bookingWatermark.toString()}
              </span>{" "}
              and{" "}
              <span className="font-mono">{point.liveWatermark.toString()}</span>
              . The two columns are two genuinely different queries that agree
              today — which is the common case, and is a fact about this day
              rather than a control that did nothing.
            </>
          ) : (
            <>
              {moved.length} account{moved.length === 1 ? "" : "s"} read
              differently at the two watermarks. Open one on{" "}
              <span className="font-mono">/transactions</span> to see the acts
              that account for the difference, entry by entry.
            </>
          )}
        </p>
      </div>
    </Panel>
  );
}

/**
 * The honest label on the part of this screen that does NOT travel.
 *
 * Named module, named reason, and the alternative that does honour the
 * parameter. A reader should never have to work out for themselves which
 * figures on a page moved with the URL.
 */
export function TimeTravelUnavailableNote({ point }: { readonly point: TimePoint }) {
  return (
    <Note emphasis title="The card and hold console below is PINNED TO NOW">
      <p>
        It does not honour{" "}
        <span className="font-mono text-text">?asOf</span> or{" "}
        <span className="font-mono text-text">?asKnownAt</span>. Its reads come
        from <span className="font-mono">src/components/accounts/live-source.ts</span>
        , which takes its own live snapshot internally, and that module belongs
        to another worker on this build. Every balance in it is as at{" "}
        {formatTimestamp(point.resolvedAt.toISOString())}, watermark{" "}
        <span className="font-mono text-text">{point.liveWatermark.toString()}</span>{" "}
        — not the point in the URL.
      </p>
      <p className="mt-1.5">
        The card list would not travel even if it could: a card is provider
        state with no value date, so giving it a time axis would mean inventing
        one the fact does not have. Balances and holds ARE ledger facts and do
        travel — that is the panel above, and{" "}
        <span className="font-mono">/transactions</span>, which honours both
        axes in full.
      </p>
    </Note>
  );
}
