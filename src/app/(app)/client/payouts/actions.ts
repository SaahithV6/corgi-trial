"use server";

/**
 * The customer's two writes on a cross-border payout: ask for a rate, and
 * accept it.
 *
 * ===========================================================================
 * WHY THERE IS A CUSTOMER HALF AT ALL
 * ===========================================================================
 *
 * The feature is "a cross-border USDC payout with an FX quote THE CUSTOMER
 * ACCEPTS". The accepting is the whole point: it is what turns a rate from a
 * number we printed into a commitment we are held to. `/payouts` built the
 * operator's half — a member of staff raising a quote on a customer's behalf
 * and clicking accept for them — and a rate nobody was shown is not a rate
 * anybody agreed to.
 *
 * ===========================================================================
 * THE SAME LIBRARY, NOT THE OTHER SCREEN
 * ===========================================================================
 *
 * `observeRate`, `createQuote` and `acceptQuote` are `src/lib/fx/*` — the same
 * functions the operator action calls, reached through the library rather than
 * through the other screen. The expiry trigger, the funds check under an
 * advisory lock, the acceptance row and the commitment hold all apply
 * unchanged, because none of them is applied here: they are applied inside one
 * transaction in `src/lib/fx/store.ts` and in the database's own controls.
 * There is no second copy of any rule in this file.
 *
 * ===========================================================================
 * NOTHING HERE SETTLES AND NOTHING HERE BROADCASTS
 * ===========================================================================
 *
 * Accepting commits money; it does not move any. No journal entry is posted by
 * either action below — an offer is not a transaction and an acceptance is not
 * a transfer — and no chain transaction is signed. The settlement path exists
 * (`postUsdcPayout`, `scripts/payout-usdc.mjs`) and this file does not touch
 * it.
 *
 * ===========================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT
 * ===========================================================================
 *
 * Everything in the `FormData` is a claim:
 *
 *   businessId  a REFERENCE. Re-resolved against `business` server-side, and
 *               used as the tenant predicate on every read below. The page
 *               sends the business it is scoped to; the form does not offer it
 *               as a choice.
 *   buyCurrency checked against the closed corridor list, never passed through.
 *   amount      parsed from a decimal string to `bigint` cents HERE, by integer
 *               string arithmetic. No `parseFloat`, no `* 100`.
 *   quoteRef    a REFERENCE, and it is re-checked against the viewer's business
 *               as a SQL predicate before the acceptance is attempted. THE
 *               TERMS ARE NEVER READ FROM THE FORM. `fee_cents`,
 *               `customer_rate_scaled` and `buy_minor` are
 *               `GENERATED ALWAYS ... STORED` on `fx_quote`, so a commitment
 *               cannot disagree with the rate it claims — and a form that could
 *               name its own rate would be the whole feature undone.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import type {
  AcceptResult,
  QuoteLine,
  QuoteOffer,
  QuoteRequestResult,
} from "@/components/client/payouts/state";
import { formatUsd } from "@/lib/format/money";
import { costCents, formatBps, formatMinorUnits, formatRate, priceQuote } from "@/lib/fx/quote";
import { observeRate } from "@/lib/fx/rate";
import { acceptQuote, createQuote, type QuoteRecord } from "@/lib/fx/store";
import { CORRIDOR_CODES, DEFAULT_QUOTE_TTL_SECONDS, findCorridor } from "@/lib/fx/types";

import { readAvailableCents, readOwnedQuote } from "./live-read";

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A plain USD amount to `bigint` cents, by integer string arithmetic.
 *
 * Lifted in shape from `src/app/(app)/pots/actions.ts`, which states the
 * reasoning at length: `parseFloat("0.1")` is not 0.1, and a cent that arrives
 * through a double is a cent that can arrive wrong. Anything that is not a
 * plain amount — a sign, three decimal places, an exponent — comes back `null`
 * and is refused by name rather than guessed at.
 */
function parseUsdToCents(raw: string): bigint | null {
  const cleaned = raw.trim().replaceAll(",", "").replace(/^\$/, "");
  if (!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(cleaned)) return null;

  const dot = cleaned.indexOf(".");
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fraction = dot === -1 ? "" : cleaned.slice(dot + 1);

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUOTE_REF = /^FXQ-[0-9A-HJKMNP-TV-Z]{8}$/;

const requestSchema = z.object({
  businessId: z.string().trim().regex(UUID, { error: "no account is in view" }),
  buyCurrency: z.enum(CORRIDOR_CODES as [string, ...string[]], {
    error: "choose somewhere we can pay",
  }),
  amount: z.string().trim().min(1, { error: "enter an amount" }),
  beneficiaryRef: z
    .string()
    .trim()
    .min(2, { error: "name who is being paid — it is what you will recognise on the receipt" })
    .max(120, { error: "120 characters at most" }),
});

const acceptSchema = z.object({
  businessId: z.string().trim().regex(UUID, { error: "no account is in view" }),
  quoteRef: z.string().trim().toUpperCase().regex(QUOTE_REF, { error: "not a quote reference" }),
  reference: z
    .string()
    .trim()
    .max(120)
    .regex(/^[A-Za-z0-9 ._/#-]*$/, { error: "letters, digits, spaces and . _ / # - only" })
    .optional()
    .or(z.literal("")),
});

function issuesOf(error: z.ZodError): readonly { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(form)",
    message: issue.message,
  }));
}

/**
 * The same sentence for a quote that is not real and a quote that is not yours.
 *
 * Telling them apart would turn this form into an oracle for which references
 * exist on the platform. `readApproveScreen` and `cards-actions.ts` make the
 * identical choice, for payment references and card ids.
 */
const NOT_YOURS =
  "That quote is not on this account. The answer is the same for a reference that does not " +
  "exist and one belonging to another customer — telling them apart would let anybody confirm " +
  "which references are real. Nothing was written.";

/* -------------------------------------------------------------------------- */
/* The offer, in the customer's own words                                     */
/* -------------------------------------------------------------------------- */

/**
 * The breakdown, in the order a person reads it.
 *
 * Every figure is read back off the `fx_quote` row — nothing on this page is
 * recomputed from the preview. Two of these lines are ones a customer is
 * normally not shown:
 *
 *   THE MID, with the characters the source printed and the date on them, so
 *   the spread can be checked rather than believed.
 *
 *   THE SPREAD, as its own line and as a dollar figure. A provider quoting "no
 *   fees" is taking its margin inside the rate, where nobody can see it without
 *   knowing the mid. A basis-point number the customer has to apply themselves
 *   is not a disclosure.
 */
function offerLines(quote: QuoteRecord): readonly QuoteLine[] {
  const delivery = formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency);
  const midLabel = formatRate(quote.midRateScaled, quote.rateScale, { minDecimals: 4 });
  const yourRate = formatRate(quote.customerRateScaled, quote.rateScale, { minDecimals: 4 });
  const atMid = costCents({
    buyMinor: quote.buyMinor,
    rateScaled: quote.midRateScaled,
    rateScale: quote.rateScale,
    buyExponent: quote.buyExponent,
  });

  return [
    {
      label: "You send",
      value: formatUsd(quote.sellCents),
      emphasis: true,
      note:
        "What leaves your account the moment you accept. It does not move afterwards, whatever " +
        "the market does.",
    },
    {
      label: "Our fee",
      value: `− ${formatUsd(quote.feeCents)}`,
      note:
        `${formatUsd(quote.feeFlatCents)} flat plus ${formatBps(quote.feeBps)} of the amount, ` +
        "rounded up to the cent. Rounding a fee up is in our favour, by at most one cent.",
    },
    {
      label: "Exchanged",
      value: formatUsd(quote.netCents),
      note:
        "What is actually converted, after the fee. Everything below is worked out from this " +
        "figure and not from what you send.",
    },
    {
      label: `Market mid rate USD/${quote.buyCurrency}`,
      value: midLabel,
      note:
        quote.rateEvidence === "live"
          ? `${quote.rateSource} printed “${quote.rateLiteral}” for ${quote.rateDate}` +
            `${quote.rateHttpStatus === null ? "" : `, HTTP ${quote.rateHttpStatus}`}. A daily ` +
            "reference rate, not a price anybody trades at — the mid is shown so you can check " +
            "what we charge on top of it."
          : "SIMULATED. This came from a built-in fallback table dated " +
            `${quote.rateDate}, because the live source could not be reached. It is not a ` +
            "market rate.",
    },
    {
      label: "What we take on the rate",
      value: `${formatUsd(quote.netCents - atMid)} (${formatBps(quote.spreadBps)})`,
      note:
        "The difference between what your money buys at the mid rate above and what it buys at " +
        "your rate below. This is the charge that normally hides inside an exchange rate. It is " +
        "on top of the fee, not instead of it.",
    },
    {
      label: "Your rate",
      value: yourRate,
      emphasis: true,
      note:
        "The rate you get if you accept — and the rate you still get if the market has moved by " +
        "the time it is paid out.",
    },
    {
      label: "They receive",
      value: delivery,
      emphasis: true,
      note:
        `Rounded down to the smallest ${quote.buyCurrency} unit: a fraction of one cannot be ` +
        "delivered by anybody, and rounding up would promise money we did not buy. This is the " +
        "amount you are committing us to.",
    },
  ];
}

function toOffer(quote: QuoteRecord): QuoteOffer {
  const corridor = findCorridor(quote.buyCurrency);
  return {
    quoteRef: quote.quoteRef,
    destination:
      corridor === undefined
        ? quote.buyCurrency
        : `${corridor.name} (${corridor.currency}), to ${corridor.destination}`,
    beneficiaryRef: quote.beneficiaryRef,
    costDisplay: formatUsd(quote.sellCents),
    deliveryDisplay: formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency),
    expiresAt: quote.expiresAt,
    expiresInSeconds: Number(quote.expiresInSeconds < 0n ? 0n : quote.expiresInSeconds),
    rateEvidence: quote.rateEvidence,
    lines: offerLines(quote),
  };
}

/* -------------------------------------------------------------------------- */
/* Ask for a rate                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Write the rate reading and the offer. Commit nothing.
 *
 * Two append-only rows, one transaction, and no hold: a quote is an offer and
 * an offer costs the customer nothing. Their available balance is unchanged by
 * this action and the screen says so.
 */
export async function requestClientQuoteAction(
  _previous: QuoteRequestResult,
  formData: FormData,
): Promise<QuoteRequestResult> {
  const parsed = requestSchema.safeParse({
    businessId: formData.get("businessId") ?? "",
    buyCurrency: formData.get("buyCurrency") ?? "",
    amount: formData.get("amount") ?? "",
    beneficiaryRef: formData.get("beneficiaryRef") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so no rate was fetched and no quote was written.",
      issues: issuesOf(parsed.error),
      offer: null,
    };
  }

  const sellCents = parseUsdToCents(parsed.data.amount);
  if (sellCents === null || sellCents <= 0n) {
    return {
      status: "refused",
      code: "BAD_AMOUNT",
      message:
        "That is not a plain dollar amount. Dollars and cents, two decimal places at most, and " +
        "no sign — a payout is always money going out. Nothing was written.",
      issues: [{ path: "amount", message: "e.g. 1000.00" }],
      offer: null,
    };
  }

  // The rate, from the real source. `observeRate` never throws: when the source
  // is unreachable it returns a LABELLED simulated reading, which becomes
  // `evidence = 'simulated'` on the row and a warning on the offer. It does not
  // quietly pretend to be a market rate.
  const observation = await observeRate(parsed.data.buyCurrency);

  // Priced locally first, so an offer that cannot exist is refused before a row
  // is written for it: fifty cents to Japan does not reach one yen after the
  // fee, and saying so is better than showing an empty promise.
  try {
    priceQuote({
      sellCents,
      buyCurrency: parsed.data.buyCurrency,
      midRateScaled: observation.rateScaled,
      feeFlatCents: 100n,
      feeBps: 25,
      spreadBps: 50,
    });
  } catch (cause) {
    return {
      status: "refused",
      code: "UNQUOTABLE",
      message: cause instanceof Error ? cause.message : String(cause),
      issues: [{ path: "amount", message: "try a larger amount" }],
      offer: null,
    };
  }

  const created = await createQuote({
    businessId: parsed.data.businessId,
    buyCurrency: parsed.data.buyCurrency,
    sellCents,
    beneficiaryRef: parsed.data.beneficiaryRef,
    destinationAddress: null,
    observation,
  });

  if (!created.ok) {
    return {
      status: "refused",
      code: created.error.code,
      message: created.error.message,
      issues: null,
      offer: null,
    };
  }

  revalidatePath("/client/payouts");

  return {
    status: "quoted",
    code: null,
    message:
      `This offer stands for ${DEFAULT_QUOTE_TTL_SECONDS} seconds. Nothing is committed and ` +
      "your balance has not changed — read the arithmetic, then accept it or let it lapse.",
    issues: null,
    offer: toOffer(created.value),
  };
}

/* -------------------------------------------------------------------------- */
/* Accept it                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Accept an offer, which reserves the money it commits.
 *
 * The expiry is NOT re-checked here before the write, and that is deliberate:
 * `fx_quote_acceptance_guard()` decides. A pre-check in TypeScript would be a
 * second, weaker copy of the control — and it could not close the race between
 * reading `expires_at` and writing the row, which the trigger closes by
 * construction. `acceptQuote()` translates the exception into a named refusal
 * and this action prints it.
 *
 * The ownership check is different in kind and happens FIRST, because it is not
 * a control the database enforces: `fx_quote` has no notion of who is looking
 * at the screen. `readOwnedQuote()` asks for the reference AND the business in
 * one statement, and a quote that is not this customer's is refused before any
 * rate source, any lock and any write.
 */
export async function acceptClientQuoteAction(
  _previous: AcceptResult,
  formData: FormData,
): Promise<AcceptResult> {
  const parsed = acceptSchema.safeParse({
    businessId: formData.get("businessId") ?? "",
    quoteRef: formData.get("quoteRef") ?? "",
    reference: formData.get("reference") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so nothing was accepted and nothing was written.",
      quoteRef: null,
      lines: [],
    };
  }

  const owned = await readOwnedQuote({
    businessId: parsed.data.businessId,
    quoteRef: parsed.data.quoteRef,
  });

  if (owned === null) {
    return {
      status: "refused",
      code: "FX_QUOTE_NOT_FOUND",
      message: NOT_YOURS,
      quoteRef: parsed.data.quoteRef,
      lines: [],
    };
  }

  const availableBefore = await readAvailableCents(parsed.data.businessId);

  const reference = parsed.data.reference;
  const accepted = await acceptQuote({
    quoteRef: owned.quoteRef,
    reference: reference === undefined || reference === "" ? null : reference,
  });

  revalidatePath("/client/payouts");
  revalidatePath("/client");

  if (!accepted.ok) {
    return {
      status: "refused",
      code: accepted.error.code,
      message: accepted.error.message,
      quoteRef: owned.quoteRef,
      lines: [],
    };
  }

  const quote = accepted.value;
  const availableAfter = await readAvailableCents(parsed.data.businessId);

  return {
    status: "accepted",
    code: null,
    message:
      `You accepted ${quote.quoteRef} with ` +
      `${quote.acceptedWithSecondsToSpare ?? 0n} seconds to spare. We now owe your beneficiary ` +
      `${formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency)} for ` +
      `${formatUsd(quote.sellCents)}, at the rate on the offer, whatever the market does before ` +
      `${quote.settleBy ?? "the window closes"}. Nothing has been posted to your account — a ` +
      "commitment is not a payment, and no money has left yet — but the amount is reserved, so " +
      "the same dollars cannot be committed to a second payout.",
    quoteRef: quote.quoteRef,
    lines: [
      {
        label: "Committed",
        value: formatUsd(quote.sellCents),
        emphasis: true,
        note: "Reserved against your account as a hold. It is not a payment and not a fee.",
      },
      {
        label: "They receive",
        value: formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency),
        emphasis: true,
        note: `To ${quote.beneficiaryRef}, at ${formatRate(quote.customerRateScaled, quote.rateScale, { minDecimals: 4 })}.`,
      },
      {
        label: "You could spend before",
        value: formatUsd(availableBefore),
        note: "Your available balance the instant before the acceptance was written.",
      },
      {
        label: "You can spend now",
        value: formatUsd(availableAfter),
        emphasis: true,
        note:
          `Lower by ${formatUsd(availableBefore - availableAfter)}, which is exactly what you ` +
          "committed. The money is still in your account; it is spoken for.",
      },
      {
        label: "We must pay them by",
        value: quote.settleBy ?? "—",
        note:
          "We honour this rate for the whole window. Past it the commitment lapses, the hold " +
          "comes off, and a payout needs a fresh quote.",
      },
    ],
  };
}
