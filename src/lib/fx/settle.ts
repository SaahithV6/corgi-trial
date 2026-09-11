/**
 * Posting the settlement of an accepted quote to the general ledger.
 *
 * ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
 *
 * docs/FX.md §6 printed this entry and then said, honestly, that nothing in
 * the feature posted it because the chart had no account for the variance:
 *
 *     DR  2100/<business>   sell_cents              the committed price
 *     CR  4200              fee_cents               our disclosed fee
 *     CR  1140              settlement_cost_cents   the USDC that actually left
 *     CR/DR  ????           variance_cents          what the market move cost us
 *
 * `4300 FX quote settlement variance` now exists in `src/lib/ledger/chart.ts`
 * and in the deployed schema, with the `why` that doc asked for. So the entry
 * posts, and this module is the thing that posts it. It adds one line the doc
 * did not have — `CR 2900` for the sub-cent conversion residual — for the
 * reason argued at length in ./allocation.ts: 4300 is a market position and a
 * rounding artefact folded into it is a residual nobody owns.
 *
 * ── WHY IT IS NOT `postUsdcPayout()` ────────────────────────────────────────
 *
 * `src/lib/rails/stablecoin/ledger.ts` posts a two-line entry — the customer's
 * deposit against the wallet — which is the correct entry for a USDC transfer
 * that is *not* a currency conversion: moving a customer's own dollars to
 * their own wallet has no fee, no commitment and no variance. A cross-border
 * payout is a different transaction with a different template, and special-
 * casing the rail module on "is there a quote" would put FX vocabulary inside
 * a rail adapter. A rail is an adapter, not a schema; the brief says so.
 *
 * BOTH PATHS USE THE SAME IDEMPOTENCY KEY — `payoutIdempotencyKey(txHash)` —
 * which is UNIQUE on `journal_entry`. That is deliberate and it is the safety
 * net: one confirmed transfer can produce exactly one entry no matter which of
 * the two templates ran, so a script that crashed after the quoted posting and
 * was re-run without `--quote` cannot double-book the money. It would return
 * the entry that already exists.
 *
 * ── THE TWO CLOCKS ──────────────────────────────────────────────────────────
 *
 * `valueDate` is the BLOCK's own day in book time — when the money moved —
 * exactly as `blockValueDate()` computes it for the unquoted path. It is not
 * the day the quote was accepted, and that is the whole bitemporal point: a
 * quote accepted on Tuesday and settled on Thursday is a Thursday movement of
 * money against a Tuesday commitment. Wednesday's statement shows nothing,
 * because nothing had moved; Thursday's shows the payout AND the rate agreed
 * on Tuesday, because the acceptance instant and the accepted rate are written
 * onto the entry's description and onto the customer's own line memo. The
 * booking axis is `ledger_append`'s, as always.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import { resolveChartCodes } from "@/lib/ledger/queries";

import {
  FX_SETTLEMENT_ACCOUNTS,
  fundingAllocation,
  settlementLines,
  type FundingAllocation,
  type SettlementLinePlan,
} from "./allocation";
import { formatMinorUnits, formatRate } from "./quote";
import type { QuoteRecord } from "./store";

/** A posted line, with its chart code alongside the account uuid for display. */
export interface PostedSettlementLine extends SettlementLinePlan {
  readonly accountId: string;
}

export interface FxSettlementPosting {
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly valueDate: string;
  readonly allocation: FundingAllocation;
  readonly lines: readonly PostedSettlementLine[];
}

export interface PostFxSettlementInput {
  /** The quote being consumed. Read from the database, never from a form. */
  readonly quote: QuoteRecord;
  readonly entityId: string;
  readonly actorId: string;
  /** The USDC that actually left the wallet, in minor units. */
  readonly fundedUnits: bigint;
  /** The mid we settled against, and its scale. Not the quoted mid. */
  readonly settlementMidRateScaled: bigint;
  readonly settlementRateScale: bigint;
  /** The chain's handle. This posts AFTER a receipt, never after a broadcast. */
  readonly txHash: string;
  /** The block's day in book time. From the block timestamp, not `Date.now()`. */
  readonly valueDate: string;
  /** `payoutIdempotencyKey(txHash)` — supplied so the rail owns its own shape. */
  readonly idempotencyKey: string;
  /** Free text for the description, e.g. an operator's payout reference. */
  readonly reference?: string;
  /** For the description: the provider and block that moved it. */
  readonly provenance?: string;
}

/**
 * Post the settlement. Idempotent on the transaction hash.
 *
 * A second call with the same hash returns the SAME entry id and writes
 * nothing — `ledger_append`'s behaviour on a repeated `idempotency_key`,
 * enforced by a UNIQUE constraint in Postgres rather than by a check this
 * function performs.
 *
 * It does NOT write `fx_quote_settlement`. That row is the caller's, because
 * it is a second write to a second table and the honest shape is the one the
 * schema already admits: `fx_quote_settlement.entry_id` is nullable precisely
 * because the posting and the settlement record are two writes and a crash can
 * land between them. The recovery is the same as everywhere else on this path
 * — re-run with the hash; the entry is idempotent and the settlement row's
 * PRIMARY KEY refuses a second.
 */
export async function postFxSettlement(
  input: PostFxSettlementInput,
  conn: Sql = sql,
): Promise<FxSettlementPosting> {
  const { quote } = input;

  // THE ONE PRECONDITION THIS MODULE CHECKS ITSELF, and it is not the gate's.
  //
  // The gate refuses a payout before it is sent; this runs after, including on
  // the `--settle` recovery path where the gate deliberately does not run
  // because the value has already left. A LAPSED commitment still posts here —
  // the money moved against a real agreed rate and the ledger has to say so,
  // and the database refuses to mark the quote consumed, which is the right
  // place for that refusal. But a quote NOBODY EVER ACCEPTED has no agreed
  // rate, so there is nothing true to write on the entry. That movement is a
  // domestic transfer (`--domestic`), not an FX settlement, and calling it one
  // would put a rate the customer never saw into the audit trail of the
  // record that exists to be trusted.
  if (quote.acceptedAt === null) {
    throw new Error(
      `quote ${quote.quoteRef} was never accepted, so there is no agreed rate to record on a ` +
        "journal entry. Nothing was written. A transfer that settles no commitment posts " +
        "through the domestic template instead.",
    );
  }

  const allocation = fundingAllocation({
    sellCents: quote.sellCents,
    feeCents: quote.feeCents,
    fundedUnits: input.fundedUnits,
  });

  const deliveryLabel = formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency);
  const customerRateLabel = formatRate(quote.customerRateScaled, quote.rateScale, {
    minDecimals: 4,
  });
  const settlementMidLabel = formatRate(input.settlementMidRateScaled, input.settlementRateScale, {
    minDecimals: 4,
  });

  const plan = settlementLines({
    ...allocation,
    fundedUnits: input.fundedUnits,
    deliveryLabel,
    customerRateLabel,
    settlementMidLabel,
    quoteRef: quote.quoteRef,
    txHash: input.txHash,
  });

  // Through the ledger's own named reader, in one round trip, rather than five
  // `SELECT id FROM account` of this module's own — the boundary
  // `src/lib/ledger/boundary.test.ts` enforces, and the reason it exists: six
  // modules once carried four different sets of predicates for "which account
  // is 1130", which is four different answers.
  const chart = await resolveChartCodes(
    {
      entityId: input.entityId,
      businessId: quote.businessId,
      houseCodes: plan.filter((l) => !l.perBusiness).map((l) => l.accountCode),
      businessCodes: plan.filter((l) => l.perBusiness).map((l) => l.accountCode),
    },
    conn,
  );

  const lines: PostedSettlementLine[] = plan.map((line) => {
    const account = chart.get(line.accountCode);
    if (account === undefined) {
      throw new Error(
        `no account ${line.accountCode}${line.perBusiness ? `/${quote.businessId}` : ""} for ` +
          `entity ${input.entityId} — the FX settlement entry has nowhere to post and nothing ` +
          "was written",
      );
    }
    return { ...line, accountId: account.accountId };
  });

  // Everything a reader needs to reconstruct the deal without a join, because
  // a statement line that says only "USDC payout" cannot answer "at what rate
  // did I agree to this".
  const description =
    `Cross-border payout ${quote.quoteRef} — ${deliveryLabel} to ${quote.beneficiaryRef} ` +
    `at an accepted rate of ${customerRateLabel} ${quote.buyCurrency}/${quote.sellCurrency} ` +
    `(mid ${formatRate(quote.midRateScaled, quote.rateScale, { minDecimals: 4 })} less ` +
    `${quote.spreadBps}bp), accepted ${quote.acceptedAt ?? "unknown"}, settled against a mid of ` +
    `${settlementMidLabel}` +
    `${input.reference === undefined ? "" : ` (${input.reference})`}` +
    `${input.provenance === undefined ? "" : ` — ${input.provenance}`}`;

  const entryId = await postEntry(
    {
      entityId: input.entityId,
      valueDate: input.valueDate,
      book: "financial",
      description,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      lines: lines.map((line) => ({
        accountId: line.accountId,
        amountCents: line.amountCents,
        memo: line.memo,
      })),
      rail: "usdc",
      externalRef: input.txHash,
    },
    conn,
  );

  return {
    entryId,
    idempotencyKey: input.idempotencyKey,
    valueDate: input.valueDate,
    allocation,
    lines,
  };
}

export { FX_SETTLEMENT_ACCOUNTS };
