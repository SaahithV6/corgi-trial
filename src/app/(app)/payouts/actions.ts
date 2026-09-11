"use server";

/**
 * The payouts screen's three write paths, and the one that deliberately does
 * not write.
 *
 * ============================================================================
 * WHAT THESE ACTIONS DO
 *
 *   requestQuoteAction  reads a mid rate from a real, free, keyless source,
 *                       then writes TWO append-only rows: the observation and
 *                       the quote. It computes no commitment — `buy_minor` is
 *                       a GENERATED column and the database derives it.
 *
 *   acceptQuoteAction   writes ONE append-only row. Whether it is allowed to
 *                       is decided by `fx_quote_acceptance_guard()` in the
 *                       database, never here.
 *
 *   sendPayoutAction    WRITES NOTHING AND BROADCASTS NOTHING. It runs the
 *                       gate and reports the verdict. See below.
 *
 * NONE OF THEM POSTS TO THE JOURNAL. An offer is not a transaction and an
 * acceptance is not a transfer; the posting happens at settlement and it is
 * `postUsdcPayout()`, one module over, which this work does not own. See
 * docs/FX.md §6 for the settlement entry and the one chart account that does
 * not exist yet.
 *
 * ============================================================================
 * WHY "SEND" DOES NOT SEND, STATED PLAINLY RATHER THAN HIDDEN
 *
 * Signing a Base Sepolia transaction needs `USDC_SENDER_PRIVATE_KEY`, and the
 * sanctioned path for that is `scripts/payout-usdc.mjs` — an operator CLI, run
 * from a terminal, which prints the transaction hash BEFORE it broadcasts so a
 * crash is recoverable. A button on a public URL that signs with a wallet key
 * on every click is a worse design than a button that refuses to, and a
 * 180-second wait for a receipt does not fit inside a serverless function
 * anyway.
 *
 * So this action runs the real gate against the real database and tells you
 * what it said. THAT IS THE FEATURE: an unaccepted or expired quote produces a
 * genuine refusal with a genuine code, and an accepted one produces the exact
 * command that will send it. The screen says all of this in words; nothing on
 * it claims a transfer happened.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Everything in the `FormData` is a
 * claim and every claim is re-validated here and again in the database:
 *
 *   businessId  a REFERENCE, resolved against `business` inside the insert.
 *   currency    checked against the closed corridor list, never passed through.
 *   amount      parsed from a decimal string to `bigint` cents HERE, by integer
 *               string arithmetic. No `parseFloat`, no `* 100`.
 *   quoteRef    a REFERENCE. The quote's terms are read from the row, never
 *               from the form — a form that could name its own rate would be
 *               the whole feature undone.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formatUsd } from "@/lib/format/money";
import { requireAcceptedQuote } from "@/lib/fx/gate";
import { formatMinorUnits, priceQuote } from "@/lib/fx/quote";
import { observeRate } from "@/lib/fx/rate";
import { acceptQuote, createQuote } from "@/lib/fx/store";
import { CORRIDOR_CODES, DEFAULT_QUOTE_TTL_SECONDS } from "@/lib/fx/types";
import { USDC_UNITS_PER_CENT } from "@/lib/rails/stablecoin/types";

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export type Issue = { readonly path: string; readonly message: string };

export type QuoteActionResult = {
  readonly status: "idle" | "quoted" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  readonly quoteRef: string | null;
};

export type AcceptActionResult = {
  readonly status: "idle" | "accepted" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  readonly quoteRef: string | null;
};

export type SendActionResult = {
  readonly status: "idle" | "cleared" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  /** The command that would actually send it, when the gate clears. */
  readonly command: string | null;
};

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A plain USD amount to `bigint` cents, by integer string arithmetic.
 *
 * Lifted in shape from `src/app/(app)/pots/actions.ts`, which states the
 * reasoning at length: `parseFloat("0.1")` is not 0.1, and a cent that arrives
 * through a double is a cent that can arrive wrong. Returns `null` for
 * anything that is not a plain amount — a sign, three decimal places, an
 * exponent — and the caller renders that as a refusal rather than guessing.
 *
 * Not exported: a `"use server"` module may only export async functions.
 */
function parseUsdToCents(raw: string): bigint | null {
  const cleaned = raw.trim().replaceAll(",", "").replace(/^\$/, "");
  if (!/^(?:0|[1-9]\d{0,10})(?:\.\d{1,2})?$/.test(cleaned)) return null;

  const dot = cleaned.indexOf(".");
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fraction = dot === -1 ? "" : cleaned.slice(dot + 1);

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
}

/** Decimal USDC to integer minor units, six decimals. Same discipline, other scale. */
function parseUsdcToUnits(raw: string): bigint | null {
  const cleaned = raw.trim().replaceAll(",", "");
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/.exec(cleaned);
  if (match === null) return null;
  const units = BigInt(match[1] ?? "0") * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  return units > 0n ? units : null;
}

const QUOTE_REF = /^FXQ-[0-9A-HJKMNP-TV-Z]{8}$/;

const requestSchema = z.object({
  businessId: z.string().trim().min(1, { error: "choose the customer" }),
  buyCurrency: z.enum(CORRIDOR_CODES as [string, ...string[]], {
    error: "choose a destination currency we quote",
  }),
  amount: z.string().trim().min(1, { error: "enter an amount" }),
  beneficiaryRef: z
    .string()
    .trim()
    .min(2, { error: "name who is being paid — it is what the customer will recognise" })
    .max(120, { error: "120 characters at most" }),
  destinationAddress: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, { error: "a 0x-prefixed 20-byte address, or leave it empty" })
    .optional()
    .or(z.literal("")),
});

const acceptSchema = z.object({
  quoteRef: z.string().trim().toUpperCase().regex(QUOTE_REF, { error: "not a quote reference" }),
  reference: z
    .string()
    .trim()
    .max(120)
    .regex(/^[A-Za-z0-9 ._/#-]*$/, {
      error: "letters, digits, spaces and . _ / # - only",
    })
    .optional()
    .or(z.literal("")),
});

const sendSchema = z.object({
  quoteRef: z.string().trim().toUpperCase().regex(QUOTE_REF, { error: "not a quote reference" }),
  amountUsdc: z.string().trim().min(1, { error: "enter the USDC amount this payout would send" }),
  toAddress: z
    .string()
    .trim()
    .regex(/^0x[0-9a-fA-F]{40}$/, { error: "a 0x-prefixed 20-byte address" })
    .optional()
    .or(z.literal("")),
});

function issuesOf(error: z.ZodError): readonly Issue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "(form)",
    message: issue.message,
  }));
}

/* -------------------------------------------------------------------------- */
/* Request a quote                                                            */
/* -------------------------------------------------------------------------- */

export async function requestQuoteAction(
  _previous: QuoteActionResult,
  formData: FormData,
): Promise<QuoteActionResult> {
  const parsed = requestSchema.safeParse({
    businessId: formData.get("businessId") ?? "",
    buyCurrency: formData.get("buyCurrency") ?? "",
    amount: formData.get("amount") ?? "",
    beneficiaryRef: formData.get("beneficiaryRef") ?? "",
    destinationAddress: formData.get("destinationAddress") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so no rate was fetched and no quote was written.",
      issues: issuesOf(parsed.error),
      quoteRef: null,
    };
  }

  const sellCents = parseUsdToCents(parsed.data.amount);
  if (sellCents === null || sellCents <= 0n) {
    return {
      status: "refused",
      code: "BAD_AMOUNT",
      message:
        "That is not a plain USD amount. Cents, two decimal places at most, no sign — a quote " +
        "is always for money going out.",
      issues: [{ path: "amount", message: "e.g. 1000.00" }],
      quoteRef: null,
    };
  }

  // The rate, from the real source. `observeRate` never throws: if the source
  // is down it returns a LABELLED simulated reading, which becomes
  // `evidence = 'simulated'` on the row and a banner on the screen. It does
  // not quietly pretend.
  const observation = await observeRate(parsed.data.buyCurrency);

  // Price it locally first, so a quote that cannot exist is refused before a
  // row is written for it — a $0.50 payout to Japan does not reach one yen
  // after the fee, and the customer should be told that rather than shown an
  // empty commitment.
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
      quoteRef: null,
    };
  }

  const address = parsed.data.destinationAddress;
  const created = await createQuote({
    businessId: parsed.data.businessId,
    buyCurrency: parsed.data.buyCurrency,
    sellCents,
    beneficiaryRef: parsed.data.beneficiaryRef,
    destinationAddress: address === undefined || address === "" ? null : address,
    observation,
  });

  if (!created.ok) {
    return {
      status: "refused",
      code: created.error.code,
      message: created.error.message,
      issues: null,
      quoteRef: null,
    };
  }

  const quote = created.value;
  revalidatePath("/payouts");

  return {
    status: "quoted",
    code: null,
    message:
      `Quote ${quote.quoteRef} stands for ${DEFAULT_QUOTE_TTL_SECONDS} seconds. ` +
      `${formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency)} to the ` +
      `beneficiary, priced from a ${observation.evidence === "live" ? "LIVE" : "SIMULATED"} ` +
      `${observation.source} mid of ${observation.literal} for ${observation.rateDate}. ` +
      "Nothing is committed until it is accepted, and nothing has been posted to the ledger.",
    issues: null,
    quoteRef: quote.quoteRef,
  };
}

/* -------------------------------------------------------------------------- */
/* Accept it                                                                  */
/* -------------------------------------------------------------------------- */

export async function acceptQuoteAction(
  _previous: AcceptActionResult,
  formData: FormData,
): Promise<AcceptActionResult> {
  const parsed = acceptSchema.safeParse({
    quoteRef: formData.get("quoteRef") ?? "",
    reference: formData.get("reference") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read, so nothing was accepted and nothing was written.",
      issues: issuesOf(parsed.error),
      quoteRef: null,
    };
  }

  const reference = parsed.data.reference;
  const accepted = await acceptQuote({
    quoteRef: parsed.data.quoteRef,
    reference: reference === undefined || reference === "" ? null : reference,
  });

  revalidatePath("/payouts");

  if (!accepted.ok) {
    return {
      status: "refused",
      code: accepted.error.code,
      message: accepted.error.message,
      issues: null,
      quoteRef: parsed.data.quoteRef,
    };
  }

  const quote = accepted.value;
  return {
    status: "accepted",
    code: null,
    message:
      `Accepted with ${quote.acceptedWithSecondsToSpare ?? 0} seconds to spare. We are now ` +
      `committed to delivering ` +
      `${formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency)} for ` +
      `${formatUsd(quote.sellCents)}, whatever the market does before ` +
      `${quote.settleBy ?? "the window closes"}. Nothing has been posted to the FINANCIAL ` +
      "ledger — a commitment is not a transaction — but their available balance has fallen " +
      `by ${formatUsd(quote.sellCents)}: since migration 0053 an accepted quote places a memo ` +
      "hold for the price it commits, so the same dollars cannot be committed twice.",
    issues: null,
    quoteRef: quote.quoteRef,
  };
}

/* -------------------------------------------------------------------------- */
/* Send it — the gate, and only the gate                                      */
/* -------------------------------------------------------------------------- */

export async function sendPayoutAction(
  _previous: SendActionResult,
  formData: FormData,
): Promise<SendActionResult> {
  const parsed = sendSchema.safeParse({
    quoteRef: formData.get("quoteRef") ?? "",
    amountUsdc: formData.get("amountUsdc") ?? "",
    toAddress: formData.get("toAddress") ?? "",
  });

  if (!parsed.success) {
    return {
      status: "refused",
      code: "INVALID_FORM",
      message: "The form could not be read. The gate was not run and nothing was sent.",
      issues: issuesOf(parsed.error),
      command: null,
    };
  }

  const amountUnits = parseUsdcToUnits(parsed.data.amountUsdc);
  if (amountUnits === null) {
    return {
      status: "refused",
      code: "BAD_AMOUNT",
      message: "That is not a USDC amount. Six decimal places at most, and greater than zero.",
      issues: [{ path: "amountUsdc", message: "e.g. 996.50" }],
      command: null,
    };
  }

  const to = parsed.data.toAddress;
  const refusal = await requireAcceptedQuote({
    quoteRef: parsed.data.quoteRef,
    amountUnits,
    toAddress: to === undefined || to === "" ? null : to,
  });

  if (refusal !== null) {
    return {
      status: "refused",
      code: refusal.code,
      message: refusal.message,
      issues: null,
      command: null,
    };
  }

  // Cleared. The transfer itself is the operator CLI's job — see the header.
  const whole = amountUnits / 1_000_000n;
  const fraction = (amountUnits % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const amountArg = fraction === "" ? `${whole}` : `${whole}.${fraction}`;

  return {
    status: "cleared",
    code: null,
    message:
      `The gate cleared ${parsed.data.quoteRef}: an accepted, unexpired, unspent commitment, and ` +
      `${amountUnits} USDC units — ${formatUsd(amountUnits / USDC_UNITS_PER_CENT)} at par — is ` +
      "within what the customer authorised. NOTHING WAS SENT BY THIS BUTTON: signing needs the " +
      "wallet key, and the sanctioned path for that is the operator CLI, which prints the " +
      "transaction hash before it broadcasts so a crash is recoverable.",
    issues: null,
    command:
      `node scripts/payout-usdc.mjs --quote ${parsed.data.quoteRef} --amount ${amountArg}` +
      (to === undefined || to === "" ? "" : ` --to ${to}`),
  };
}
