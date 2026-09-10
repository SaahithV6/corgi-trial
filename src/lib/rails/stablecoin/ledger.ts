/**
 * Posting a confirmed USDC payout to the general ledger.
 *
 * ── THE ONE THING THIS MODULE REFUSES TO DO ─────────────────────────────────
 *
 * It will not accept anything but a `confirmed` outcome. The type makes that
 * unarguable: `postUsdcPayout` takes a `ConfirmedPayout`, which is only
 * constructible by `settleTransaction` after it has read a receipt back, seen
 * `status: 0x1`, and re-checked that the block is still canonical. A broadcast
 * transaction, a reverted one and a reorged one cannot be passed to this
 * function at all, so "we posted a payment that never happened" is a compile
 * error rather than a code review.
 *
 * ── THE ACCOUNTS, AND WHY THESE ONES ────────────────────────────────────────
 *
 *   DR  2100/<business>  the customer's deposit account
 *   CR  1140             USDC omnibus wallet — Base Sepolia
 *   CR  2900             rounding residual, only when there is sub-cent dust
 *
 * A customer's deposit is OUR LIABILITY and is credit-normal, so the customer
 * spending money is a DEBIT to it (chart.ts, fact 1). Our USDC holding is an
 * asset that just went down, so it is credited. Both accounts are already in
 * the chart with exactly this purpose written on them; nothing is invented.
 *
 * ── UNITS: WHY THE LEDGER IS IN CENTS AND NOT IN USDC ───────────────────────
 *
 * `journal_line.currency` is `char(3)` and every seeded account is `'USD'`,
 * and `assert_entry_balanced()` requires each currency in an entry to net to
 * zero *independently* — so an entry whose debit is USD and whose credit is
 * USDC cannot balance, by construction, without an FX bridge pair that this
 * chart does not have. Chart account 1140 already anticipates this and states
 * its own unit: "carried in cents at 1 USDC = 100 cents ... with sub-cent dust
 * going to 2900 rather than being truncated". That is the convention followed
 * here. The full six-decimal figure is not lost: it is carried on the entry's
 * `external_ref` and in the line memos, and the dust has its own line.
 *
 * The `Money` value that crossed the rail boundary is still `{ amount: bigint,
 * currency: 'USDC' }` — `../types.ts` keeps stablecoin and fiat apart in the
 * application, which is where the two could actually be added together by
 * accident. The narrowing to cents happens once, here, at the posting
 * boundary, and it is visible.
 *
 * ── GAS IS NOT POSTED, AND THAT IS A STATED GAP ─────────────────────────────
 *
 * Chart account 5300 ("Blockchain gas — USDC transfers") is the right home for
 * it and is deliberately left empty by this module. Gas is paid in ETH; the
 * chart has no ETH-denominated asset account to credit, and converting wei to
 * cents needs an ETH/USD rate that this system has no live source for.
 * Inventing one would be worse than the gap. On Base Sepolia the figure is
 * academic — a transfer costs on the order of 4×10^-7 ETH, which rounds to
 * zero cents and would be rejected as a zero-amount line anyway — but the
 * limitation is real on mainnet and is written down rather than discovered.
 * The actual `gasCostWei` is on the outcome and in the entry description.
 */

import "server-only";
import { postEntry } from "@/lib/ledger/post";
import { sql, type Sql } from "@/lib/ledger/db";
import { USDC_PROVIDER, formatUsdc, payoutIdempotencyKey, type ConfirmedPayout } from "./types";
import { blockValueDate, payoutAllocation } from "./allocation";

export { blockValueDate, payoutAllocation, type PayoutAllocation } from "./allocation";

/** The customer's deposit rollup; leaves are per business. */
const DEPOSIT_CODE = "2100";
/** The USDC omnibus wallet. */
const USDC_WALLET_CODE = "1140";
/** Where sub-cent dust goes instead of being truncated. */
const RESIDUAL_CODE = "2900";

export interface UsdcPayoutPostingInput {
  readonly outcome: ConfirmedPayout;
  readonly entityId: string;
  /** Whose money left. Resolves the 2100 leaf. */
  readonly businessId: string;
  readonly actorId: string;
  /** Free text for the entry description, e.g. a payout reference. */
  readonly reference?: string;
}

/** A posted line, with the chart code alongside the account uuid for display. */
export interface PostedLine {
  readonly accountCode: string;
  readonly accountId: string;
  readonly amountCents: bigint;
  readonly memo: string;
}

export interface UsdcPayoutPosting {
  readonly entryId: string;
  readonly idempotencyKey: string;
  readonly valueDate: string;
  readonly lines: readonly PostedLine[];
}

/** One account id, by code, for this entity. Throws rather than posting nowhere. */
async function resolveAccount(
  conn: Sql,
  entityId: string,
  code: string,
  businessId: string | null,
): Promise<string> {
  const rows = businessId === null
    ? await conn<{ id: string }[]>`
        SELECT id FROM account
         WHERE entity_id = ${entityId}::uuid AND code = ${code} AND business_id IS NULL`
    : await conn<{ id: string }[]>`
        SELECT id FROM account
         WHERE entity_id = ${entityId}::uuid AND code = ${code}
           AND business_id = ${businessId}::uuid`;
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error(
      `no account ${code}${businessId === null ? "" : `/${businessId}`} for entity ${entityId}`,
    );
  }
  return id;
}

/**
 * Post the payout. Idempotent on the transaction hash.
 *
 * A second call with the same confirmed outcome returns the SAME entry id and
 * writes nothing — that is `ledger_append`'s behaviour on a repeated
 * `idempotency_key`, enforced by a UNIQUE constraint in Postgres rather than
 * by a check this function performs. The caller cannot tell the two apart and
 * has no reason to want to.
 */
export async function postUsdcPayout(
  input: UsdcPayoutPostingInput,
  conn: Sql = sql,
): Promise<UsdcPayoutPosting> {
  const { outcome } = input;
  const units = outcome.amount.amount;
  const allocation = payoutAllocation(units);
  const { walletCreditCents: cents, dustUnits } = allocation;
  if (cents === 0n && dustUnits > 0n) {
    // Below one cent the whole movement is dust, and a 0-cent debit is a
    // forbidden zero line. Refuse loudly rather than posting a lie.
    throw new Error(
      `${formatUsdc(units)} is below one cent; the ledger carries 1140 in cents and cannot represent it`,
    );
  }

  const [depositId, walletId, residualId] = await Promise.all([
    resolveAccount(conn, input.entityId, DEPOSIT_CODE, input.businessId),
    resolveAccount(conn, input.entityId, USDC_WALLET_CODE, null),
    dustUnits > 0n ? resolveAccount(conn, input.entityId, RESIDUAL_CODE, null) : Promise.resolve(null),
  ]);

  // Debit the customer the rounded-UP cent when there is dust, credit the
  // wallet the whole cents it actually parted with, and put the difference in
  // 2900. The entry sums to zero and the fraction stays visible.
  const dust = allocation.residualCreditCents;
  const memo = `${formatUsdc(units)} to ${outcome.to} — tx ${outcome.txHash}`;

  const lines: PostedLine[] = [
    { accountCode: `${DEPOSIT_CODE}/${input.businessId}`, accountId: depositId, amountCents: allocation.depositDebitCents, memo },
    { accountCode: USDC_WALLET_CODE, accountId: walletId, amountCents: -cents, memo },
  ];
  if (residualId !== null) {
    lines.push({
      accountCode: RESIDUAL_CODE,
      accountId: residualId,
      amountCents: -dust,
      memo: `sub-cent residual on ${formatUsdc(units)}: ${dustUnits} of 10000 units of a cent`,
    });
  }

  const valueDate = blockValueDate(outcome.receipt.blockTimestamp);
  const idempotencyKey = payoutIdempotencyKey(outcome.txHash);

  const entryId = await postEntry(
    {
      entityId: input.entityId,
      valueDate,
      book: "financial",
      description:
        `USDC payout ${formatUsdc(units)} to ${outcome.to}` +
        `${input.reference === undefined ? "" : ` (${input.reference})`}` +
        ` — ${USDC_PROVIDER} block ${outcome.receipt.blockNumber}, gas ${outcome.receipt.gasCostWei} wei`,
      idempotencyKey,
      actorId: input.actorId,
      lines: lines.map(({ accountId, amountCents, memo: lineMemo }) => ({
        accountId,
        amountCents,
        memo: lineMemo,
      })),
      rail: "usdc",
      // The chain's own identifier for this movement, so a ledger row can be
      // taken to a block explorer without a join through anything.
      externalRef: outcome.txHash,
    },
    conn,
  );

  return { entryId, idempotencyKey, valueDate, lines };
}
