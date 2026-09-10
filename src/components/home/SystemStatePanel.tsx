import { Money } from "@/components/ui/Money";
import { Badge, Panel, TableScroll } from "@/components/ui/primitives";
import { formatUsd } from "@/lib/format/money";
import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";
import type { SystemState } from "@/lib/home/summary";

/**
 * What the ledger actually contains, right now.
 *
 * Every figure below is a field of `SystemState`, and `SystemState` is one
 * SELECT taken at request time. There is no default, no fallback and no
 * remembered value: when the read fails the panel renders the failure, because
 * a landing page quoting last-known-good numbers is a page that lies quietly
 * during an outage — which is the worst possible moment to be doing it.
 */

/* -------------------------------------------------------------------------- */
/* Tiles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One headline figure.
 *
 * `count` and `cents` are mutually exclusive so money can never be rendered as
 * a bare number: a `cents` tile goes through `<Money>` and gets the tabular,
 * monospaced, sign-aware treatment every amount in this console gets, and a
 * `count` tile is an integer that is not money and must not be dressed as it.
 */
export interface Tile {
  readonly key: string;
  readonly label: string;
  readonly count: number | null;
  readonly cents: bigint | null;
  /** The provenance line: where the number came from, or what it proves. */
  readonly detail: string;
}

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * The tiles, derived from the state and nothing else.
 *
 * Pure, exported and tested, so "the page shows a number that is not in the
 * query result" is a test failure rather than something a reviewer has to spot.
 */
export function buildTiles(state: SystemState): readonly Tile[] {
  const w = state.webhooks;

  return [
    {
      key: "entries",
      label: "Journal entries",
      count: state.journalEntries,
      cents: null,
      detail: `${NUMBER.format(state.financialEntries)} financial · ${NUMBER.format(
        state.memoEntries,
      )} memo · ${NUMBER.format(state.journalLines)} lines, none of which was ever updated`,
    },
    {
      key: "card-auths",
      label: "Card authorisations",
      count: state.cardAuthorisations,
      cents: null,
      detail: `${NUMBER.format(
        state.cardAuthEvents,
      )} network events folded into them — a hold is a function of the event set, never of a provider's status field`,
    },
    {
      key: "holds",
      label: "Active holds",
      count: state.activeHolds,
      cents: null,
      detail: `withholding ${formatUsd(
        state.activeHoldCents,
      )} from available balance · available = ledger − holds − uncleared credits`,
    },
    {
      key: "webhooks",
      label: "Webhook deliveries processed",
      count: w.done,
      cents: null,
      detail: `of ${NUMBER.format(w.total)} verified and stored${
        w.parked > 0
          ? ` · ${NUMBER.format(w.parked)} parked on an entity not yet seen`
          : ""
      }${w.pending > 0 ? ` · ${NUMBER.format(w.pending)} queued` : ""}${
        w.dead > 0 ? ` · ${NUMBER.format(w.dead)} dead-lettered` : ""
      }`,
    },
    {
      key: "deposit-accounts",
      label: "Deposit accounts",
      count: state.depositAccounts,
      cents: null,
      detail:
        "open customer 2100 accounts — a business gets one when KYB approves it and not before",
    },
  ];
}

function TileCard({ tile }: { readonly tile: Tile }) {
  return (
    <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {tile.label}
      </dt>
      <dd className="mt-1.5">
        <span className="block text-2xl font-semibold tracking-tight">
          {tile.cents === null ? (
            <span className="money">{NUMBER.format(tile.count ?? 0)}</span>
          ) : (
            <Money cents={tile.cents} />
          )}
        </span>
        <span className="mt-1.5 block text-xs leading-relaxed text-muted">
          {tile.detail}
        </span>
      </dd>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The trial balance                                                          */
/* -------------------------------------------------------------------------- */

const CELL_HEAD =
  "whitespace-nowrap py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted";
const CELL = "py-3 align-top text-sm";

function TrialBalance({ state }: { readonly state: SystemState }) {
  const tb = state.trialBalance;
  const balanced = tb.differenceCents === 0n;

  return (
    <section aria-labelledby="trial-balance-heading">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 id="trial-balance-heading" className="text-sm font-semibold tracking-tight">
          Trial balance — financial book
        </h3>
        {balanced ? (
          <Badge tone="quiet">balanced</Badge>
        ) : (
          <Badge tone="negative">out of balance</Badge>
        )}
      </div>

      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        Debits are positive and credits negative in one signed column, so
        &ldquo;the book balances&rdquo; is{" "}
        <code className="font-mono">SUM(amount_cents) = 0</code> across{" "}
        {NUMBER.format(tb.accounts)} accounts. The memo book that carries holds is
        off balance sheet and sums to zero independently, so no authorisation can
        pollute the figures below.
      </p>

      <TableScroll>
        <table className="mt-3 w-full border-collapse text-sm">
          <caption className="sr-only">
            Trial balance of the financial book: total debits, total credits and
            the difference between them
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={CELL_HEAD}>
                Side
              </th>
              <th scope="col" className={`${CELL_HEAD} text-right`}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <tr>
              <th scope="row" className={`${CELL} text-left font-normal`}>
                Debits
              </th>
              <td className={`${CELL} text-right`}>
                <Money cents={tb.debitCents} tone="neutral" />
              </td>
            </tr>
            <tr>
              <th scope="row" className={`${CELL} text-left font-normal`}>
                Credits
              </th>
              <td className={`${CELL} text-right`}>
                <Money cents={tb.creditCents} tone="neutral" />
              </td>
            </tr>
            <tr>
              <th scope="row" className={`${CELL} text-left font-medium`}>
                Difference
                <span className="mt-0.5 block max-w-prose text-xs font-normal text-muted">
                  {balanced
                    ? "zero, at every value date, with no tolerance"
                    : "not zero — a bug to fix, never a number to overwrite; nothing in this system repairs it"}
                </span>
              </th>
              <td className={`${CELL} text-right`}>
                <Money cents={tb.differenceCents} tone="neutral" className="font-semibold" />
              </td>
            </tr>
          </tbody>
        </table>
      </TableScroll>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

export function SystemStatePanel({
  state,
}: {
  readonly state: Result<SystemState, ErrorShape>;
}) {
  if (isErr(state)) {
    return (
      <Panel
        id="system-state"
        title="Live system state"
        description="Read from the journal at request time. Nothing on this page is a literal."
      >
        <div className="px-5 py-8">
          <p className="text-sm text-negative">
            The ledger could not be read, so there are no figures to show.
          </p>
          <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[8rem_1fr]">
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">Code</dt>
            <dd className="font-mono text-xs break-words">{state.error.code}</dd>
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">Message</dt>
            <dd className="max-w-prose text-sm break-words">{state.error.message}</dd>
          </dl>
          <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted">
            This is a read failure and nothing moved: the application role holds
            no UPDATE or DELETE on the money tables, and this page issues a
            single SELECT. No cached or remembered figure is shown in its place,
            because a stale balance presented as current is worse than an outage
            that says so. The integration table below is served by{" "}
            <code className="font-mono">/api/health</code>, which is a separate
            process boundary and may well still be answering.
          </p>
        </div>
      </Panel>
    );
  }

  const s = state.value;

  return (
    <Panel
      id="system-state"
      title="Live system state"
      description="Every figure is a fold over immutable rows, taken in one statement so they all describe the same instant. There is no balance column in this schema."
      actions={<Badge tone="positive">live query</Badge>}
    >
      <div className="space-y-6 px-5 py-5">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {buildTiles(s).map((tile) => (
            <TileCard key={tile.key} tile={tile} />
          ))}
        </dl>

        <TrialBalance state={s} />

        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Read at {formatTimestamp(s.readAt.toISOString())} · booking watermark{" "}
          <span className="money">{s.bookingWatermark.toString()}</span>
          {s.lastPostedAt === null
            ? null
            : ` · last entry booked ${formatTimestamp(s.lastPostedAt.toISOString())}`}
          {s.webhooks.lastDeliveryAt === null
            ? null
            : ` · last webhook delivery ${formatTimestamp(
                s.webhooks.lastDeliveryAt.toISOString(),
              )}`}
        </p>
      </div>
    </Panel>
  );
}
