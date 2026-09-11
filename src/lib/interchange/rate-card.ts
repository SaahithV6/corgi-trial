/**
 * Interchange: the price of a settlement, as integer arithmetic.
 *
 * ─── What interchange is, in one paragraph ──────────────────────────────────
 *
 * When a card settles, the acquirer does not pay the issuer the full ticket.
 * It pays the ticket LESS interchange, and interchange is the issuer's revenue
 * — the thing that makes a card programme a business rather than a cost
 * centre. It is quoted as a percentage of the settled amount PLUS a fixed
 * amount per transaction (`1.65% + $0.10`), and both halves matter: the
 * percentage is most of the money on a big ticket and the fixed fee is most of
 * it on a small one.
 *
 * ─── Which DESIGN §12 clause governs, and why ───────────────────────────────
 *
 * **§12.2 — one value becomes one cent amount, round HALF TO EVEN.**
 *
 * The tempting answer is §12.3, largest remainder, because the words "a
 * percentage of an amount" sound like a split. They are not. §12.3's
 * precondition is a SOURCE AMOUNT being distributed across N shares that must
 * add back up to it exactly; the residual penny exists because the shares owe
 * the source a total. Interchange has no source to distribute. The settled
 * amount is not being divided between parties — it is an INPUT to a price, and
 * the price is one number.
 *
 * `docs/ACCRUAL.md` §13 makes exactly this argument one product over, for daily
 * interest, and the sentence transfers without modification:
 *
 *     "Largest-remainder needs a source amount to distribute. Daily interest
 *      has none. [...] What daily interest IS, exactly, is one value — a
 *      balance, a rate and one day — becoming one cent amount, which is
 *      §12.2's sentence with nothing left to interpret."
 *
 * Here it is a settled amount, a rate and a fixed fee becoming one cent
 * amount. Same clause, same reason.
 *
 * THE FIXED COMPONENT DOES NOT CHANGE THE ANSWER, and it is worth saying why,
 * because it is the half that looks like it might. `$0.10` is already an
 * integer number of cents. It is not rounded, it is not divided, and it is
 * ADDED AFTER the ad-valorem half has become an integer. So there is exactly
 * one rounding step in the whole calculation and it has exactly one operand:
 *
 *     ad_valorem = round_half_even(|settled| * rate_bps / 10000)
 *     interchange = ad_valorem + fixed_cents
 *
 * Adding an integer to an integer cannot introduce a fraction, so no second
 * rounding rule is needed and none is added. **This ledger still has exactly
 * two rounding rules**, they are the two `DESIGN §12` already had, and this
 * file reuses the §12.2 implementation the database already carries
 * (`interest_round_half_even`) rather than writing a third body of it. The
 * function is named for the product that first needed it; it is the RULE, not
 * the product.
 *
 * HALF TO EVEN AND NOT HALF UP, for §12.2's own stated reason — and note that
 * the reason §12.2 gives is *literally about this feature*:
 *
 *     "half-up biases every tie in one direction, and over a year of
 *      INTERCHANGE that bias is a real number."
 *
 * A half-cent tie on interchange is a tie between us and the acquirer. Half-up
 * hands it to us every single time, forever, on every transaction whose
 * `amount * bps` lands exactly on `5000 mod 10000`. At 165 bps that is every
 * ticket ending in a multiple that hits the half — a measurable, recurring,
 * one-directional transfer, which is exactly what §12.2 was written to stop.
 *
 * NOBODY EATS A RESIDUAL PENNY, and that is not a contradiction. §12.3's
 * residual is real money that must land on one of the shares. §12.2 has no
 * residual to place: the sub-cent fraction was never money, no party was ever
 * credited with it, and the entry is two equal and opposite lines summing to
 * zero. `2900 Rounding residual clearing` is likewise NOT engaged — 2900 is for
 * dust that ARRIVED as a real external amount with more precision than a cent
 * (a USDC transfer with six decimals), where truncating would break the
 * identity between customer balances and our obligation. A fraction of a cent
 * of interchange never arrived; it is precision that was never claimed. The
 * bound is half a cent per settlement, and `remainderUnits` is carried on the
 * row so the fraction that was dropped is visible rather than merely absent.
 *
 * The `4100` note in `chart.ts` used to say the residual penny lands on us "at
 * ordinal 0 in the allocation (DESIGN §12.5)". That sentence is about §12.3 and
 * it is still true of any allocation 4100 is ever a party to — but nothing on
 * this path is an allocation, so it does not describe what this module does.
 * The note has been sharpened to say both things.
 *
 * ─── No floats, including intermediates ─────────────────────────────────────
 *
 * Every operand and every result below is `bigint` or a small `number` used
 * only as a rate in basis points. There is no `/` that is not integer
 * division, no `Math.round`, no `toFixed`, and no value that ever holds a
 * fraction. The database re-derives all of it in `CHECK` constraints from the
 * same integers, so TypeScript computes and Postgres verifies.
 */

/**
 * Basis points are the integer-scaled form of a rate: `165` is 1.65%.
 *
 * A `number` and not a `bigint` on purpose — it is a small integer that indexes
 * a rate card, it is never an amount of money, and `CHECK (0..10000)` on every
 * table that stores one keeps it that way. The one place it meets money is the
 * multiplication below, where it is widened to `bigint` before it touches a
 * cent.
 */
export type BasisPoints = number;

/** The denominator of a basis-point rate. 165 bps of X is `X * 165 / 10000`. */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Was the card physically there?
 *
 * This is the single biggest driver of real interchange after merchant
 * category, because it is the single biggest driver of fraud risk. It is read
 * off `pos.entry_mode` in the provider's own payload — see `./dimensions.ts`
 * for exactly which values map where, and for the measurement of what this
 * sandbox actually emits.
 *
 * `unknown` is a real third state and not an error. The provider may send a
 * transaction with no `pos` block at all, and "we were not told" is a different
 * claim from either of the other two — the same distinction `isRefused()` draws
 * about `result` in `holds/lithic-events.ts`. It is priced, deliberately, at
 * the CARD-PRESENT rate: card-present interchange is the LOWER of the two, so
 * an unproven presentment books the smaller number. Revenue we cannot
 * substantiate is revenue we do not claim.
 */
export type Presentment = "card_present" | "card_not_present" | "unknown";

export const PRESENTMENTS: readonly Presentment[] = [
  "card_present",
  "card_not_present",
  "unknown",
];

/** Which way the money went, and therefore which way the interchange went. */
export type InterchangeDirection = "earned" | "returned";

/** How the exact fraction became a cent amount. Mirrors `interest_rounding`. */
export type Rounding = "exact" | "down" | "up" | "tie_to_even";

/** One row of the rate card, as the arithmetic needs it. */
export interface RateCardEntry {
  /** The `interchange_rate_policy` row this came from. */
  readonly policyId: string;
  readonly category: string;
  readonly presentment: Presentment;
  /** The version's start date. Resolution is `<= the settlement's value date`. */
  readonly effectiveFrom: string;
  readonly rateBps: BasisPoints;
  /** The per-transaction component, already an integer number of cents. */
  readonly fixedCents: bigint;
}

/**
 * The complete working, so a number nobody can reproduce by hand is never
 * rendered anywhere. Every field is stored on `interchange_posting` and
 * re-derived by a `CHECK`.
 */
export interface InterchangeArithmetic {
  /** `|settled| * rate_bps`. A magnitude; the direction is carried separately. */
  readonly numerator: bigint;
  /** Always `BPS_DENOMINATOR`. Carried so the row states its own fraction. */
  readonly denominator: bigint;
  /** `numerator / denominator`, integer division. */
  readonly wholeCents: bigint;
  /** `numerator % denominator`. In ten-thousandths of a cent, `0 <= r < D`. */
  readonly remainderUnits: bigint;
  readonly rounding: Rounding;
  /** The percentage half, rounded to cents by §12.2. */
  readonly adValoremCents: bigint;
  readonly fixedCents: bigint;
  /** `adValoremCents + fixedCents`. The magnitude posted. */
  readonly interchangeCents: bigint;
}

/**
 * DESIGN §12.2 on a rational `N/D`, in integers.
 *
 *     q = N div D, r = N mod D
 *     2r > D  -> past the half:   q + 1
 *     2r < D  -> short of it:     q
 *     2r = D  -> EXACTLY the half: round to the EVEN cent, i.e. up iff q is odd
 *
 * `2r` against `D` rather than `r` against `D/2` is deliberate: `D/2` on
 * integers truncates for an odd `D` and would silently classify some genuine
 * ties as "down", which is the bias half-even exists to remove. `D` is 10000
 * here and therefore even, so the trap is not live — but the body is written to
 * be correct for any `D`, because it is the same five lines as
 * `interest_round_half_even()` and the two must not diverge.
 */
export function roundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error(`round-half-even denominator must be positive, got ${denominator}`);
  }
  if (numerator < 0n) {
    // The sign is carried by `direction`, never by the division. A negative
    // numerator here means a caller passed a signed amount where a magnitude
    // was required, and truncating division would round one direction away
    // from zero and the other toward it — a bias nothing would state out loud.
    throw new Error(
      `round-half-even takes a MAGNITUDE; ${numerator} is signed, and the direction belongs on the posting`,
    );
  }
  const q = numerator / denominator;
  const r = numerator % denominator;
  const twice = 2n * r;
  if (twice > denominator) return q + 1n;
  if (twice < denominator) return q;
  return q + (q % 2n);
}

/** Which of the four cases §12.2 took. Recorded per posting, never inferred. */
export function roundingOf(numerator: bigint, denominator: bigint): Rounding {
  const r = numerator % denominator;
  if (r === 0n) return "exact";
  const twice = 2n * r;
  if (twice === denominator) return "tie_to_even";
  return twice > denominator ? "up" : "down";
}

/**
 * Price one settlement.
 *
 * `settledCents` is a MAGNITUDE — a positive number of cents that actually
 * settled. Whether that was a purchase or a refund is `InterchangeDirection`,
 * decided by the sign of the customer's own leg on the settlement entry, and it
 * is applied when the journal lines are built. Rounding a magnitude and
 * carrying the sign separately is the same discipline `interest_side_of` uses
 * and for the same reason.
 */
export function priceSettlement(
  settledCents: bigint,
  rate: Pick<RateCardEntry, "rateBps" | "fixedCents">,
): InterchangeArithmetic {
  if (settledCents <= 0n) {
    throw new Error(
      `interchange is priced on a settled MAGNITUDE greater than zero; got ${settledCents}`,
    );
  }
  if (!Number.isInteger(rate.rateBps) || rate.rateBps < 0 || rate.rateBps > 10_000) {
    throw new Error(`rate ${rate.rateBps} bps is not an integer in [0, 10000]`);
  }
  if (rate.fixedCents < 0n) {
    throw new Error(`fixed component ${rate.fixedCents} cannot be negative`);
  }

  // BigInt(rate.rateBps) and not `settledCents * BigInt(...)` written inline:
  // the widening happens once, before the multiplication, so there is no
  // arrangement of these operands in which a `number` touches a cent.
  const numerator = settledCents * BigInt(rate.rateBps);
  const denominator = BPS_DENOMINATOR;
  const wholeCents = numerator / denominator;
  const remainderUnits = numerator % denominator;
  const adValoremCents = roundHalfEven(numerator, denominator);

  return {
    numerator,
    denominator,
    wholeCents,
    remainderUnits,
    rounding: roundingOf(numerator, denominator),
    adValoremCents,
    fixedCents: rate.fixedCents,
    // The only addition in the file, and it is integer + integer. See the
    // header: this is why there is no second rounding step and no third rule.
    interchangeCents: adValoremCents + rate.fixedCents,
  };
}

/**
 * The interchange a settlement is worth, in NATURAL terms: positive is revenue
 * to us, negative is revenue handed back.
 *
 * `netCustomerCents` is the customer's own leg across the settlement's whole
 * correction group, signed the way the ledger signs a line: POSITIVE is a debit
 * — money away from the customer, i.e. a purchase — and negative is a credit.
 *
 * This is the one function that decides "how much interchange should exist for
 * this settlement, right now", and it is used in three places that must agree:
 * the booking path, the correction path, and `v_interchange_drift`, which asks
 * the same question of the whole book in SQL. A settlement corrected to zero
 * returns zero, which is the trap this feature exists not to fall into.
 */
export function interchangeForNet(
  netCustomerCents: bigint,
  rate: Pick<RateCardEntry, "rateBps" | "fixedCents">,
): { readonly naturalCents: bigint; readonly direction: InterchangeDirection | null } {
  if (netCustomerCents === 0n) return { naturalCents: 0n, direction: null };
  const magnitude = netCustomerCents > 0n ? netCustomerCents : -netCustomerCents;
  const { interchangeCents } = priceSettlement(magnitude, rate);
  return netCustomerCents > 0n
    ? { naturalCents: interchangeCents, direction: "earned" }
    : { naturalCents: -interchangeCents, direction: "returned" };
}

/**
 * The journal lines of one interchange entry.
 *
 * DEBIT 2200, CREDIT 4100 when we earn it. 2200 is what we owe the card network
 * for cleared spend, and interchange is precisely the part of that spend we do
 * NOT owe them — so reducing 2200 is not a bookkeeping convenience, it is the
 * economically true statement: the net we will fund into the settlement window
 * is spend minus interchange, and after this entry 2200 holds exactly that
 * number. The alternative, debiting `1120 Card network settlement receivable`,
 * would inflate both sides of the balance sheet with a receivable and a payable
 * against the same counterparty for the same transaction.
 *
 * A refund is the same entry with the signs swapped: the interchange goes back.
 * A purchase fully refunded therefore nets to ZERO interchange BY
 * CONSTRUCTION — the ad-valorem halves cancel because they are the same
 * magnitude at the same rate, and the fixed halves cancel because they are the
 * same integer. There is no arm and no special case; it falls out of the signs.
 *
 * ORDINAL 0 IS THE HOUSE LINE (2200 is the network, 4100 is us) — DESIGN §12.5
 * wants Corgi's own income or expense line at ordinal 0 in any ALLOCATION so
 * that §12.4's tie-break puts the residual penny on us. Nothing here is an
 * allocation and there is no residual penny to place, so the rule does not bite;
 * the ordering is nevertheless fixed by this template rather than by whatever
 * order a map iterated in, which is the half of §12.4 that is unconditional.
 */
export function interchangeLines(
  accounts: { readonly networkPayableId: string; readonly interchangeIncomeId: string },
  naturalCents: bigint,
): readonly { readonly accountId: string; readonly amountCents: bigint; readonly memo: string }[] {
  if (naturalCents === 0n) {
    throw new Error("an interchange entry of zero cents has no lines; do not post it");
  }
  // Earned: debit 2200 (we owe the network less), credit 4100 (we earned it).
  // Returned: the exact opposite. One expression, both directions.
  return [
    {
      accountId: accounts.networkPayableId,
      amountCents: naturalCents,
      memo: naturalCents > 0n ? "interchange withheld from network settlement" : "interchange returned to network settlement",
    },
    {
      accountId: accounts.interchangeIncomeId,
      amountCents: -naturalCents,
      memo: naturalCents > 0n ? "interchange earned on settlement" : "interchange returned on reversal",
    },
  ];
}

/** The idempotency key of the interchange entry for one settlement event. */
export function interchangePostingKey(providerEventId: string): string {
  return `interchange:${providerEventId}`;
}

/**
 * The idempotency key of the RE-BOOK half of a re-priced interchange posting.
 *
 * Distinct from `interchangePostingKey` on purpose: the reversal is keyed
 * `reversal:<original entry id>` by `reverseAndRebook()`, and the re-book needs
 * a key of its own that a redelivery re-derives identically. Same shape as
 * `correctionRebookKey` in `holds/corrections.ts`, and the same argument — the
 * chain is never followed to the re-book, so a replay re-decides the same
 * repair rather than reversing it.
 */
export function interchangeRebookKey(providerEventId: string): string {
  return `interchange:corrected:${providerEventId}`;
}
