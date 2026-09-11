/**
 * `/economics` — is this programme profitable, from postings.
 *
 * Every number on this page is a sum of immutable journal lines, reached
 * through a view migration 0031 declares. There is no stored total anywhere and
 * nothing is computed here from anything other than the ledger, which is the
 * same discipline `v_available_balance` imposes on the balance screens: a
 * figure you cannot re-derive from the journal is a figure that will drift.
 *
 * The page is deliberately ordered as an argument rather than as a dashboard:
 *
 *   1. THE ANSWER    portfolio contribution, and the effective take rate
 *   2. PER CUSTOMER  who is profitable and who is not, and why
 *   3. THE RATE CARD what we charge, when it changed, and what each row priced
 *   4. BY DIMENSION  whether the rate card is doing work or is one number
 *                    wearing six hats
 *   5. THE WORKING   individual settlements with the arithmetic, including the
 *                    ones the merchant took back
 *   6. WHAT IS NOT PRICED, with the reason — because a revenue screen that
 *      only shows revenue is a revenue screen you cannot trust
 *   7. THE GUARDS    whether this page's own invariants hold, counted live
 */

// TYPES ONLY from the lib, which is the rule every other screen's
// `data-contract.ts` states: nothing under `src/components/**` reaches into its
// `src/lib/<feature>/*` for anything but types. This file used to take
// `formatBps` and `portfolioTotals` from here as VALUES, and that import alone
// took the whole page module down on a deployment with no database — see
// `./arithmetic.ts` for the measurement and for where they live now.
import type {
  CategoryRow,
  EconomicsDataSource,
  EconomicsView as EconomicsViewData,
  GuardRow,
  RateCardRow,
  SettlementRow,
  UnitEconomicsRow,
  UnpricedRow,
} from "@/lib/interchange/screen";
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

import { formatBps, portfolioTotals } from "./arithmetic";
import { EconomicsRefusal } from "./EconomicsRefusal";
import { economicsReadFailed } from "./unreadable";
import { economicsHref, type EconomicsFilter } from "./view-state";

export async function EconomicsView({
  source,
  filter,
}: {
  readonly source: EconomicsDataSource;
  readonly filter: EconomicsFilter;
}) {
  let data: EconomicsViewData;
  try {
    data = await source.load();
  } catch (error) {
    return <EconomicsError error={error} />;
  }

  const totals = portfolioTotals(data.businesses);
  const selected =
    filter.settlementId === null
      ? null
      : (data.settlements.find((s) => s.id === filter.settlementId) ?? null);

  if (totals.pricedSettlements === 0 && data.settlements.length === 0) {
    return <EconomicsEmpty data={data} />;
  }

  return (
    <div className="space-y-6">
      <SummaryTiles totals={totals} />

      {selected === null ? null : <ArithmeticPanel row={selected} />}

      <Panel
        title="Contribution by customer"
        description="Income less expense, per business, entirely from journal lines. Largest contribution first, ties by legal name, so the businesses this programme loses money on are the last rows rather than the hidden ones. A house income or expense line belongs to the customer whose own deposit account the same entry moved; interchange is the exception and is attributed by the settlement it prices, because none of that money is the customer's."
      >
        <UnitEconomicsTable rows={data.businesses} />
      </Panel>

      <Panel
        title="The rate card"
        description="Effective-dated like approval_policy and the interest rate policy. Resolution is on the SETTLEMENT'S value date, so a rate change cannot re-price last week — enforced by interchange_rate_policy_forward_only on the way in and by v_interchange_rate_drift for ever after."
      >
        <RateCardTable rows={data.rateCard} />
      </Panel>

      <Panel
        title="Interchange by merchant category and presentment"
        description="The two dimensions the Lithic event data actually carries. Most interchange first, then by category and presentment. Net of reversals, because gross revenue on spend that was taken back is the number this feature exists not to report."
      >
        <CategoryTable rows={data.categories} />
      </Panel>

      <Panel
        title="Priced settlements"
        description="The most recent settlements, with what each was worth. A row whose net is zero was reversed by the merchant and its interchange was unbooked at the original value date. Select one to see the whole arithmetic."
      >
        <SettlementTable rows={data.settlements} selectedId={filter.settlementId} />
      </Panel>

      <Panel
        title="Settled card movements carrying no interchange"
        description="Not an error, and shown rather than hidden. A settlement with no provider transaction record has no merchant and no entry mode to read, and a dimension that cannot be populated from a real event is not invented."
      >
        <UnpricedTable rows={data.unpriced} total={data.unpricedTotal} />
      </Panel>

      <Panel
        title="The guards on this page's own numbers"
        description="Counted live, on every render. Each must return zero rows, and each has been made to fail on purpose against this database."
      >
        <GuardTable rows={data.guards} />
      </Panel>

      <p className="text-xs text-muted">
        Read at {data.asOf}. Every figure above is derivable from{" "}
        <code className="money">journal_entry</code> and{" "}
        <code className="money">journal_line</code> at any past booking watermark;
        this page reports the live one.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. The answer
// ---------------------------------------------------------------------------

function SummaryTiles({ totals }: { readonly totals: ReturnType<typeof portfolioTotals> }) {
  const profitable = totals.netContributionCents >= 0n;

  return (
    <section className="rounded-lg border border-border bg-surface">
      <div className="grid grid-cols-2 gap-px border-b border-border bg-border md:grid-cols-4">
        <Tile label="Interchange earned" cents={totals.interchangeCents} tone="direction" />
        <Tile label="Platform fees" cents={totals.feeIncomeCents} tone="direction" />
        <Tile
          label="Interest paid on deposits"
          cents={-totals.interestExpenseCents}
          tone="direction"
        />
        <Tile label="Net contribution" cents={totals.netContributionCents} tone="direction" big />
      </div>
      <div className="px-5 py-4">
        <MetaList
          items={[
            { label: "businesses", value: totals.businesses },
            { label: "settlements priced", value: totals.pricedSettlements },
            { label: "of which reversed", value: totals.reversedSettlements },
            {
              label: "net settled spend",
              value: <Money cents={totals.netSettledCents} tone="neutral" />,
            },
            {
              label: "effective take rate",
              value:
                totals.effectiveRateBps === null ? (
                  <span className="text-muted">no spend</span>
                ) : (
                  <span className="money">
                    {formatBps(totals.effectiveRateBps)} ({String(totals.effectiveRateBps)} bps)
                  </span>
                ),
            },
          ]}
        />
        <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
          {profitable
            ? "The programme covers its costs on this book: interchange plus platform fees exceed the interest paid on the deposits that fund the balances."
            : "The programme does not cover its costs on this book. Interest paid on deposits is the largest cost a deposit-taking business has, and card spend has not yet grown into it."}{" "}
          The take rate is interchange as basis points of net settled spend, computed in integer
          cents and truncated — a ratio for a human to read, never an amount of money.
        </p>
      </div>
    </section>
  );
}

function Tile({
  label,
  cents,
  tone,
  big = false,
}: {
  readonly label: string;
  readonly cents: bigint;
  readonly tone: "direction" | "neutral";
  readonly big?: boolean;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <FieldLabel>{label}</FieldLabel>
      <div className={big ? "mt-1 text-xl font-semibold" : "mt-1 text-lg"}>
        <Money cents={cents} tone={tone} signed={tone === "direction"} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Per customer
// ---------------------------------------------------------------------------

function UnitEconomicsTable({ rows }: { readonly rows: readonly UnitEconomicsRow[] }) {
  if (rows.length === 0) {
    return <p className="px-5 py-6 text-sm text-muted">No customer has a deposit account yet.</p>;
  }

  return (
    <TableScroll>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH_CLASS}>Business</th>
            <th className={`${TH_CLASS} text-right`}>Settlements</th>
            <th className={`${TH_CLASS} text-right`}>Net spend</th>
            <th className={`${TH_CLASS} text-right`}>Interchange</th>
            <th className={`${TH_CLASS} text-right`}>Fees</th>
            <th className={`${TH_CLASS} text-right`}>Interest paid</th>
            <th className={`${TH_CLASS} text-right`}>Other cost</th>
            <th className={`${TH_CLASS} text-right`}>Contribution</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.businessId} className="border-b border-border last:border-0">
              <td className={TD_CLASS}>
                <div className="font-medium">{r.legalName}</div>
                {r.reversedSettlements > 0 ? (
                  <div className="mt-1">
                    <Badge tone="quiet">{r.reversedSettlements} reversed</Badge>
                  </div>
                ) : null}
              </td>
              <td className={`${TD_CLASS} text-right money`}>{r.pricedSettlements}</td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={r.netSettledCents} tone="neutral" />
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={r.interchangeCents} tone="direction" />
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={r.feeIncomeCents} tone="neutral" />
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={-r.interestExpenseCents} tone="direction" />
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={-r.otherExpenseCents} tone="direction" />
              </td>
              <td className={`${TD_CLASS} text-right font-medium`}>
                <Money cents={r.netContributionCents} tone="direction" signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ---------------------------------------------------------------------------
// 3. The rate card
// ---------------------------------------------------------------------------

function RateCardTable({ rows }: { readonly rows: readonly RateCardRow[] }) {
  return (
    <TableScroll>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH_CLASS}>Band</th>
            <th className={TH_CLASS}>Presentment</th>
            <th className={TH_CLASS}>In force</th>
            <th className={`${TH_CLASS} text-right`}>Rate</th>
            <th className={`${TH_CLASS} text-right`}>Per transaction</th>
            <th className={`${TH_CLASS} text-right`}>Priced</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-border last:border-0">
              <td className={TD_CLASS}>
                <span className="font-medium">{r.category}</span>
                {r.categoryIsDefault ? (
                  <span className="ml-2">
                    <Badge tone="neutral" title="Any MCC the map does not name prices here.">
                      default
                    </Badge>
                  </span>
                ) : null}
                <div className="mt-0.5 text-xs text-muted">{r.mccsMapped} MCC(s) mapped</div>
              </td>
              <td className={TD_CLASS}>
                <Badge tone={r.presentment === "card_present" ? "quiet" : "neutral"}>
                  {r.presentment.replaceAll("_", " ")}
                </Badge>
              </td>
              <td className={`${TD_CLASS} money text-xs`}>
                {r.effectiveFrom} →{" "}
                {r.supersededOn === null ? (
                  <span className="text-positive">current</span>
                ) : (
                  r.supersededOn
                )}
              </td>
              <td className={`${TD_CLASS} text-right money`}>
                {formatBps(r.rateBps)}
                <span className="ml-1 text-xs text-muted">({r.rateBps} bps)</span>
              </td>
              <td className={`${TD_CLASS} text-right`}>
                <Money cents={r.fixedCents} tone="neutral" />
              </td>
              <td className={`${TD_CLASS} text-right money`}>{r.settlementsPriced}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ---------------------------------------------------------------------------
// 4. By dimension
// ---------------------------------------------------------------------------

function CategoryTable({ rows }: { readonly rows: readonly CategoryRow[] }) {
  if (rows.length === 0) {
    return <p className="px-5 py-6 text-sm text-muted">Nothing priced yet.</p>;
  }

  const ties = rows.reduce((n, r) => n + r.halfCentTies, 0);

  return (
    <>
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className={TH_CLASS}>Band</th>
              <th className={TH_CLASS}>Presentment</th>
              <th className={`${TH_CLASS} text-right`}>Settlements</th>
              <th className={`${TH_CLASS} text-right`}>Net spend</th>
              <th className={`${TH_CLASS} text-right`}>Interchange</th>
              <th className={`${TH_CLASS} text-right`}>Half-cent ties</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.category}:${r.presentment}`} className="border-b border-border last:border-0">
                <td className={`${TD_CLASS} font-medium`}>{r.category}</td>
                <td className={TD_CLASS}>
                  <Badge tone={r.presentment === "card_present" ? "quiet" : "neutral"}>
                    {r.presentment.replaceAll("_", " ")}
                  </Badge>
                </td>
                <td className={`${TD_CLASS} text-right money`}>{r.settlements}</td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={r.netSettledCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={r.interchangeCents} tone="direction" />
                </td>
                <td className={`${TD_CLASS} text-right money`}>{r.halfCentTies}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <div className="border-t border-border px-5 py-4">
        <Note title="The half-cent column, and why it is on this screen">
          A tie is a settlement whose percentage half landed on <em>exactly</em> half a cent.
          DESIGN §12.2 breaks it to the EVEN cent rather than up, for the reason §12.2 itself
          gives — and the reason it gives is literally about interchange: half-up would hand
          every one of those ties to us, forever. There {ties === 1 ? "is" : "are"} {ties} on this
          book. The sub-cent fractions that were dropped are carried on each posting row
          (`remainder_units`, in ten-thousandths of a cent) so the precision that was never
          claimed is visible rather than merely absent.
        </Note>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 5. The working
// ---------------------------------------------------------------------------

function SettlementTable({
  rows,
  selectedId,
}: {
  readonly rows: readonly SettlementRow[];
  readonly selectedId: string | null;
}) {
  if (rows.length === 0) {
    return <p className="px-5 py-6 text-sm text-muted">Nothing priced yet.</p>;
  }

  return (
    <TableScroll>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className={TH_CLASS}>Value date</th>
            <th className={TH_CLASS}>Merchant</th>
            <th className={TH_CLASS}>Band</th>
            <th className={`${TH_CLASS} text-right`}>Settled</th>
            <th className={`${TH_CLASS} text-right`}>Rate</th>
            <th className={`${TH_CLASS} text-right`}>Interchange</th>
            <th className={`${TH_CLASS} text-right`}>Now worth</th>
            <th className={TH_CLASS}>&nbsp;</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const reversed = r.reversalEntryId !== null;
            return (
              <tr
                key={r.id}
                className={`border-b border-border last:border-0 ${
                  r.id === selectedId ? "bg-surface-raised" : ""
                }`}
              >
                <td className={`${TD_CLASS} money text-xs`}>{r.valueDate}</td>
                <td className={TD_CLASS}>
                  <div>{r.descriptor ?? "—"}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {r.businessName} · MCC {r.mcc ?? "—"} · {r.entryMode ?? "no entry mode"}
                  </div>
                </td>
                <td className={TD_CLASS}>
                  <Badge tone="quiet">{r.category}</Badge>
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={r.settledCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} text-right money text-xs`}>
                  {formatBps(r.rateBps)} + <Money cents={r.fixedCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={r.interchangeCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={r.bookedNaturalCents} tone="direction" />
                  {reversed ? (
                    <div className="mt-1">
                      {r.reversalReason === null ? (
                        <Badge tone="negative">unbooked {r.valueDate}</Badge>
                      ) : (
                        <Badge tone="negative" title={r.reversalReason}>
                          unbooked {r.valueDate}
                        </Badge>
                      )}
                    </div>
                  ) : null}
                </td>
                <td className={TD_CLASS}>
                  <a
                    className="text-xs underline underline-offset-2"
                    href={economicsHref({ settlementId: r.id })}
                  >
                    working
                  </a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

/**
 * The whole calculation for one settlement, in integers.
 *
 * "A number a customer cannot reproduce by hand is a number they will dispute",
 * and the counterparty here is an acquirer with its own ledger. Every operand
 * is stored on `interchange_posting` and re-derived by a CHECK constraint, so
 * this panel is not a claim ABOUT the arithmetic — it IS the arithmetic, read
 * back off the row that Postgres refused to store in any other form.
 */
function ArithmeticPanel({ row }: { readonly row: SettlementRow }) {
  const reversed = row.reversalEntryId !== null;

  return (
    <Panel
      title={`The working — ${row.descriptor ?? row.providerEventId}`}
      description={`${row.category} / ${row.presentment.replaceAll("_", " ")}, priced by the card effective ${row.rateEffectiveFrom}`}
      actions={
        <a className="text-xs underline underline-offset-2" href={economicsHref({})}>
          close
        </a>
      }
    >
      <div className="space-y-4 px-5 py-4">
        <pre className="money overflow-x-auto rounded-md border border-border bg-surface-raised px-4 py-3 text-xs leading-relaxed">
{`settled          ${row.settledCents} cents        (${row.direction})
rate             ${row.rateBps} bps + ${row.fixedCents}c

N = |settled| * bps        = ${row.numerator}
D                          = ${row.denominator}
q = N div D                = ${row.wholeCents}
r = N mod D                = ${row.remainderUnits}        (ten-thousandths of a cent)
2r ${compare(row.remainderUnits, row.denominator)} D  ->  ${row.rounding.replaceAll("_", " ")}

ad valorem                 = ${row.adValoremCents}
+ fixed                    = ${row.fixedCents}
= interchange              = ${row.interchangeCents} cents

settlement now nets        = ${row.netSettledCents} cents
interchange now on book    = ${row.bookedNaturalCents} cents`}
        </pre>

        <MetaList
          items={[
            { label: "settlement entry", value: <code className="money text-xs">{row.settlementEntryId}</code> },
            { label: "interchange entry", value: <code className="money text-xs">{row.entryId}</code> },
            ...(row.reversalEntryId === null
              ? []
              : [
                  {
                    label: "reversal entry",
                    value: <code className="money text-xs">{row.reversalEntryId}</code>,
                  },
                ]),
            ...(row.rebookEntryId === null
              ? []
              : [
                  {
                    label: "re-book entry",
                    value: <code className="money text-xs">{row.rebookEntryId}</code>,
                  },
                ]),
            { label: "network", value: row.network ?? "—" },
          ]}
        />

        {reversed ? (
          <Note emphasis title="This settlement was taken back, and so was the revenue">
            {row.reversalReason ??
              "the settlement it priced was reversed, so the interchange was never earned"}
            . The repair is a <strong>new entry at the original value date</strong> — never an
            edit — so the day the spend happened shows the corrected position and the system can
            still prove what it believed before the merchant reversed it. Interchange booked on a
            settlement that later reverses and is not unbooked would overstate revenue for ever,
            and no invariant about whether entries balance would ever notice: the entry that
            should not exist balances perfectly. <code className="money">v_interchange_drift</code>{" "}
            is the guard written for exactly that, and it reads the journal rather than any
            bookkeeping table.
          </Note>
        ) : (
          <Note title="Why this is booked here and not at authorisation">
            Interchange is earned on the CLEARING. An authorisation moves the memo book only — the
            financial book does not move at all — so interchange booked there would be revenue on
            money that may never settle: the amount can change, the capture can never arrive, and
            an expiry or a full reversal ends with nothing having moved.
          </Note>
        )}
      </div>
    </Panel>
  );
}

function compare(remainder: bigint, denominator: bigint): string {
  const twice = 2n * remainder;
  if (twice > denominator) return ">";
  if (twice < denominator) return "<";
  return "=";
}

// ---------------------------------------------------------------------------
// 6. What is not priced
// ---------------------------------------------------------------------------

function UnpricedTable({
  rows,
  total,
}: {
  readonly rows: readonly UnpricedRow[];
  readonly total: number;
}) {
  if (total === 0) {
    return (
      <p className="px-5 py-6 text-sm text-muted">
        Every settled card movement on this book carries interchange.
      </p>
    );
  }

  return (
    <>
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className={TH_CLASS}>Value date</th>
              <th className={TH_CLASS}>Kind</th>
              <th className={TH_CLASS}>Provider reference</th>
              <th className={`${TH_CLASS} text-right`}>Customer</th>
              <th className={TH_CLASS}>Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.settlementEntryId} className="border-b border-border last:border-0">
                <td className={`${TD_CLASS} money text-xs`}>{r.valueDate}</td>
                <td className={TD_CLASS}>
                  <Badge tone="quiet">{r.kind}</Badge>
                </td>
                <td className={`${TD_CLASS} money text-xs`}>{r.providerAuthId ?? "—"}</td>
                <td className={`${TD_CLASS} text-right`}>
                  <Money cents={r.customerCents} tone="neutral" />
                </td>
                <td className={`${TD_CLASS} max-w-prose text-xs text-muted`}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
      <div className="border-t border-border px-5 py-4 text-xs text-muted">
        Showing {rows.length} of {total}. Almost all of these are synthetic authorisations that
        integration tests built by hand: they never had a merchant, so there is nothing to read a
        merchant category or an entry mode off. Inventing one to make a number appear is exactly
        what a rate card must not do.
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// 7. The guards
// ---------------------------------------------------------------------------

function GuardTable({ rows }: { readonly rows: readonly GuardRow[] }) {
  return (
    <ul className="divide-y divide-border">
      {rows.map((g) => (
        <li key={g.view} className="flex items-start justify-between gap-6 px-5 py-3">
          <div>
            <code className="money text-xs">{g.view}</code>
            <p className="mt-0.5 max-w-prose text-xs text-muted">{g.claim}</p>
          </div>
          <Badge tone={g.rows === 0 ? "positive" : "negative"}>
            {g.rows === 0 ? "0 rows" : `${g.rows} row(s)`}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// The other states
// ---------------------------------------------------------------------------

export function EconomicsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <div className="rounded-lg border border-border bg-surface">
        <div className="grid grid-cols-2 gap-px bg-border md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-surface px-5 py-4">
              <div className="h-3 w-24 rounded bg-border" />
              <div className="mt-3 h-5 w-28 rounded bg-border" />
            </div>
          ))}
        </div>
      </div>
      {[0, 1].map((i) => (
        <div key={i} className="rounded-lg border border-border bg-surface">
          <div className="border-b border-border px-5 py-4">
            <div className="h-3 w-40 rounded bg-border" />
          </div>
          <div className="space-y-3 px-5 py-4">
            {[0, 1, 2, 3].map((j) => (
              <div key={j} className="h-4 w-full rounded bg-border" />
            ))}
          </div>
        </div>
      ))}
      <p className="sr-only">Loading the unit economics.</p>
    </div>
  );
}

function EconomicsEmpty({ data }: { readonly data: EconomicsViewData }) {
  return (
    <div className="space-y-6">
      <Panel
        title="No card has settled yet"
        description="Interchange is earned on the clearing. Until a card transaction settles there is nothing to price, and this page will not invent a figure to fill itself."
      >
        <div className="px-5 py-5">
          <Note title="What would make this page fill">
            Authorise a card and then capture it. The authorisation alone moves the memo book and
            nothing else — available balance drops, the ledger balance does not, and no revenue is
            recognised. The clearing is what books interchange, at the rate card effective on that
            settlement&rsquo;s own value date.
          </Note>
        </div>
      </Panel>

      <Panel
        title="The rate card, already in force"
        description="Effective-dated and append-only, whether or not anything has priced against it yet."
      >
        <RateCardTable rows={data.rateCard} />
      </Panel>
    </div>
  );
}

/**
 * A read that failed, through the same panel the no-database refusal uses.
 *
 * One component, two causes, told apart by their code and their words. It used
 * to be a panel of its own that printed the thrown message under the heading
 * "What failed" with no machine-readable code beside it, and offered a bare
 * `Retry` link unconditionally — which on the cause this screen could not
 * previously reach at all, no database configured, would have been an offer to
 * refresh a deployment into having one.
 */
function EconomicsError({ error }: { readonly error: unknown }) {
  return (
    <EconomicsRefusal
      error={economicsReadFailed(error)}
      title="The economics could not be read"
      description="Nothing is shown rather than a stale or partial number."
    />
  );
}
