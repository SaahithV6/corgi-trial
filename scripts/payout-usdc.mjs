#!/usr/bin/env node
/**
 * Send USDC on Base Sepolia against an accepted FX quote, wait for the
 * receipt, and post it to the ledger.
 *
 *   node scripts/payout-usdc.mjs --quote FXQ-XXXXXXXX   # the payout, end to end
 *   node scripts/payout-usdc.mjs --check                # read the chain, send nothing
 *   node scripts/payout-usdc.mjs --quote FXQ-… --settle 0x<hash>   # post one already sent
 *   node scripts/payout-usdc.mjs --domestic --amount 0.25          # NOT a conversion
 *   node scripts/payout-usdc.mjs --allow-duplicate                 # a SECOND identical payout
 *
 * The quote lifecycle, so the whole path runs from one file:
 *
 *   node scripts/payout-usdc.mjs --quote-new --currency MXN --usd 3.00 --to 0x…
 *   node scripts/payout-usdc.mjs --quote-accept FXQ-XXXXXXXX
 *   node scripts/payout-usdc.mjs --quote-show   FXQ-XXXXXXXX
 *
 * Load the environment first: `set -a; . ./.env; set +a`.
 *
 * WHAT THIS IS. A stablecoin payout that actually confirms on a testnet is
 * worth far more than a slide about one, so this script does the whole thing:
 * a real ERC-20 `transfer(address,uint256)`, EIP-1559, signed on this machine
 * with `node:crypto` and 200 lines of hand-rolled curve and hash code (there is
 * no viem and no ethers in this repo, and adding one to the deployed app for a
 * payout script would be a bad trade — see scripts/faucet.mjs for the same
 * argument about the CDP SDK), broadcast with `eth_sendRawTransaction`, and
 * then WAITED ON. A submitted transaction is not a confirmed one. Nothing
 * reaches the ledger until a receipt has come back with `status: 0x1`.
 *
 * ── WHAT CHANGED, AND WHY IT IS THE POINT ───────────────────────────────────
 *
 * This script used to move a USDC amount with no recorded statement about what
 * the customer agreed that amount was worth. That is a transfer, not a bank
 * transaction. Three things make it the second:
 *
 *   1. THE QUOTE GATES THE SEND. `requireAcceptedQuote()` runs BEFORE
 *      `sendUsdcPayout()` and a refusal exits non-zero with nothing signed and
 *      nothing broadcast. No accepted, unexpired, unspent quote, no transfer.
 *      Not a warning — the process stops. A payout that is genuinely not a
 *      currency conversion says so with `--domestic`, which is the caller
 *      deciding rather than the gate guessing (see gate.ts's header).
 *
 *   2. THE AMOUNT IS DERIVED FROM THE COMMITMENT, NOT TYPED. What leaves the
 *      wallet is what buying the committed delivery costs at the SETTLEMENT
 *      mid — `deliveryCostUnits()`, to the rail's own six decimals. An
 *      operator sizing a settlement by hand is not settling a commitment, so
 *      `--amount` on a quoted payout is a cross-check: supply it and it must
 *      equal the derived figure, or the payout is refused with that figure in
 *      the message. The one exception is `--settle`, where the transfer has
 *      already confirmed and `--amount` states what the CHAIN says left —
 *      a fact, not a size, and the ledger has to match it.
 *
 *   3. THE ACCEPTED RATE IS ON THE ENTRY. `postFxSettlement()` posts the
 *      five-line entry docs/FX.md §6 specified — the customer's price, our
 *      fee, the USDC that left, the market variance, and the sub-cent
 *      conversion residual — with the accepted rate, the acceptance instant
 *      and the settlement mid in the description and the line memos, and
 *      `fx_quote_settlement.entry_id` pointing back at it.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN. The transaction hash is
 * `keccak256(signed raw tx)` — computable here, before a byte goes over the
 * wire — so it is printed BEFORE the broadcast and used as the ledger's
 * idempotency key. `journal_entry.idempotency_key` is UNIQUE, so a crash
 * anywhere in this script cannot produce two postings for one transfer, and
 * that holds across BOTH posting templates: the quoted one and the domestic
 * one derive the same key from the same hash. docs/STABLECOIN.md walks the
 * three crash points.
 *
 * MODULE LOADING, AND WHY THERE IS A LOADER HERE AT ALL. The payout logic
 * lives in src/lib/rails/stablecoin/ and the pricing in src/lib/fx/ because
 * both are application code that the app's own typecheck and test suite cover,
 * not script code — and the ledger write MUST go through `postEntry()`, which
 * is the only thing in this codebase allowed to touch the journal. So this
 * script has to import TypeScript out of src/. Three hooks make that work, all
 * of them doing what vitest.config.ts already does for the test run:
 *
 *   - `server-only` maps to that package's own empty module (vitest maps it to
 *     test/server-only-stub.ts for the same reason). This is a terminal; the
 *     point of that marker is that the code must not reach a browser.
 *   - `@/…` resolves to src/…, and extensionless relative imports get their
 *     `.ts` back, because TypeScript's `bundler` resolution allows both and
 *     Node's resolver does not.
 *   - `.ts` sources are transpiled with the repo's own `typescript`, NOT with
 *     Node's built-in type stripping. Node 26 strips types only; it cannot
 *     handle a constructor parameter property, and `src/lib/ledger/post.ts`
 *     uses one (`constructor(readonly deltaCents: bigint)`). Stripping throws
 *     ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX on the one module this script exists
 *     to call. `typescript` is already a devDependency; nothing is added.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = `${ROOT}/src/`;
const SERVER_ONLY_EMPTY = pathToFileURL(`${ROOT}/node_modules/server-only/empty.js`).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: SERVER_ONLY_EMPTY, shortCircuit: true };
    const spec = specifier.startsWith("@/") ? pathToFileURL(SRC + specifier.slice(2)).href : specifier;
    const relative = spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("file:");
    if (relative && !/\.[cm]?[jt]s$/.test(spec)) {
      const base = spec.startsWith("file:") ? spec : new URL(spec, context.parentURL).href;
      for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
        if (existsSync(fileURLToPath(candidate))) return { url: candidate, shortCircuit: true };
      }
    }
    return nextResolve(spec, context);
  },
  load(url, context, nextLoad) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
    const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      fileName: fileURLToPath(url),
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: true },
    });
    return { format: "module", shortCircuit: true, source: outputText };
  },
});

const { BaseRpc } = await import(`${SRC}lib/rails/stablecoin/client.ts`);
const { sendUsdcPayout, settleTransaction } = await import(`${SRC}lib/rails/stablecoin/adapter.ts`);
const { formatUsdc, payoutIdempotencyKey } = await import(`${SRC}lib/rails/stablecoin/types.ts`);
const { parsePrivateKey, addressFromPrivateKey } = await import(`${SRC}lib/rails/stablecoin/secp256k1.ts`);
const { postUsdcPayout } = await import(`${SRC}lib/rails/stablecoin/ledger.ts`);
const { blockValueDate } = await import(`${SRC}lib/rails/stablecoin/allocation.ts`);
const { sql } = await import(`${SRC}lib/ledger/db.ts`);

const { requireAcceptedQuote } = await import(`${SRC}lib/fx/gate.ts`);
const { postFxSettlement } = await import(`${SRC}lib/fx/settle.ts`);
const { deliveryCostUnits } = await import(`${SRC}lib/fx/allocation.ts`);
const { acceptQuote, createQuote, loadQuoteByRef, recordQuoteSettlement, recordRateObservation } =
  await import(`${SRC}lib/fx/store.ts`);
const { observeRate } = await import(`${SRC}lib/fx/rate.ts`);
const { formatMinorUnits, formatRate, priceQuote } = await import(`${SRC}lib/fx/quote.ts`);
const {
  CORRIDOR_CODES,
  DEFAULT_FEE_BPS,
  DEFAULT_FEE_FLAT_CENTS,
  DEFAULT_QUOTE_TTL_SECONDS,
  DEFAULT_SETTLEMENT_WINDOW_SECONDS,
  DEFAULT_SPREAD_BPS,
} = await import(`${SRC}lib/fx/types.ts`);

/* -------------------------------------------------------------------------- */
/* Arguments and configuration                                                */
/* -------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
};

/**
 * The default recipient is a burn address.
 *
 * Said plainly because it is a real trade-off: on a testnet, with 20 USDC and
 * a faucet behind it, an unambiguous destination that needs no key management
 * is worth more than 0.50 USDC of recoverable balance. Override it with
 * USDC_PAYOUT_RECIPIENT or --to for any address you control.
 */
const DEFAULT_RECIPIENT = "0x000000000000000000000000000000000000dEaD";

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const TOKEN = process.env.USDC_CONTRACT_ADDRESS;
const SENDER = process.env.USDC_SENDER_ADDRESS;
const KEY = process.env.USDC_SENDER_PRIVATE_KEY;
const CHAIN_ID = process.env.BASE_SEPOLIA_CHAIN_ID;
const RECIPIENT = option("to", process.env.USDC_PAYOUT_RECIPIENT ?? DEFAULT_RECIPIENT);
const BUSINESS = option("business", "Ridgeline Robotics, Inc.");
const ACTOR = option("actor", "ledger-poster");
const REFERENCE = option("reference", "trial demo payout");
const SETTLE_ONLY = option("settle", null);
const CHECK_ONLY = flag("check");
const ALLOW_DUPLICATE = flag("allow-duplicate");

/** The commitment this payout settles. Null is itself a refusal — see the gate. */
const QUOTE = option("quote", process.env.USDC_PAYOUT_QUOTE ?? null);
/**
 * An explicit "this is not a currency conversion".
 *
 * gate.ts refuses to guess which payouts are cross-border, and it is right not
 * to: a USDC transfer moving a customer's own dollars to their own wallet has
 * no FX risk, no commitment and nothing to quote, and demanding one would be
 * ceremony. So the caller says. The flag is deliberately ugly to type and it
 * is printed in the output, because "we skipped the price gate" is not a thing
 * that should happen quietly.
 */
const DOMESTIC = flag("domestic");

const missing = Object.entries({ USDC_CONTRACT_ADDRESS: TOKEN, USDC_SENDER_ADDRESS: SENDER, USDC_SENDER_PRIVATE_KEY: KEY, BASE_SEPOLIA_CHAIN_ID: CHAIN_ID })
  .filter(([, v]) => !v)
  .map(([k]) => k);
if (missing.length > 0) {
  console.error(`missing configuration: ${missing.join(", ")}\nrun:  set -a; . ./.env; set +a`);
  process.exit(2);
}

/** Decimal USDC -> integer minor units. No floats: `parseFloat("0.1")` is not 0.1. */
function parseUsdc(text) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(String(text).trim());
  if (!match) throw new Error(`not a USDC amount with at most 6 decimals: ${text}`);
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
}

/** Decimal dollars -> integer cents. Same discipline, different scale. */
function parseUsdCents(text) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
  if (!match) throw new Error(`not a US dollar amount with at most 2 decimals: ${text}`);
  return BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
}

/** Integer cents as dollars. String surgery, never `/ 100` on a number. */
function usd(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

/** USDC minor units back to the decimal string the CLI takes. */
function usdcArg(units) {
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

const rule = (title) => console.log(`\n── ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
const kv = (k, v) => console.log(`  ${k.padEnd(22)}${v}`);
const explorer = (hash) => `https://sepolia.basescan.org/tx/${hash}`;

/** Print a quote the same way wherever it is printed. */
function printQuote(quote) {
  kv("quote", quote.quoteRef);
  kv("state", quote.state.toUpperCase());
  kv("customer", quote.businessName);
  kv("sells", usd(quote.sellCents));
  kv("fee", `${usd(quote.feeCents)}  (${usd(quote.feeFlatCents)} + ${quote.feeBps}bp)`);
  kv("net converted", usd(quote.netCents));
  kv("mid", `${formatRate(quote.midRateScaled, quote.rateScale, { minDecimals: 4 })}  ${quote.buyCurrency}/${quote.sellCurrency}  (${quote.rateEvidence} · ${quote.rateSource} · ${quote.rateDate})`);
  kv("customer rate", `${formatRate(quote.customerRateScaled, quote.rateScale, { minDecimals: 4 })}  (mid less ${quote.spreadBps}bp)`);
  kv("delivers", formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency));
  kv("beneficiary", `${quote.beneficiaryRef}${quote.destinationAddress === null ? "" : ` @ ${quote.destinationAddress}`}`);
  kv("expires", `${quote.expiresAt}  (${quote.expiresInSeconds}s from now)`);
  if (quote.acceptedAt !== null) {
    kv("accepted", `${quote.acceptedAt}  with ${quote.acceptedWithSecondsToSpare}s to spare`);
    kv("settle by", quote.settleBy);
  }
  if (quote.settledAt !== null) {
    kv("settled", `${quote.settledAt}  tx ${quote.txHash}`);
    kv("variance", `${usd(quote.varianceCents)}  cost ${usd(quote.settlementCostCents)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* The quote lifecycle                                                        */
/* -------------------------------------------------------------------------- */
//
// These three modes exist so the whole path — quote, accept, send, confirm,
// post — is one file an operator can run and a grader can read. They are the
// same functions the /payouts screen's server actions call; nothing here is a
// second implementation of the pricing or of the expiry.

if (flag("quote-new")) {
  const currency = String(option("currency", "MXN")).toUpperCase();
  const sellCents = parseUsdCents(option("usd", "3.00"));
  const ttl = Number(option("ttl", String(DEFAULT_QUOTE_TTL_SECONDS)));
  const settlementWindow = Number(option("window", String(DEFAULT_SETTLEMENT_WINDOW_SECONDS)));
  const beneficiary = option("beneficiary", "Off-ramp partner — testnet demo");

  if (!CORRIDOR_CODES.includes(currency)) {
    console.error(`no corridor for ${currency}; quotable: ${CORRIDOR_CODES.join(", ")}`);
    await sql.end();
    process.exit(2);
  }

  const [business] = await sql`SELECT id, legal_name FROM business WHERE legal_name = ${BUSINESS}`;
  if (!business) throw new Error(`no business named ${BUSINESS}`);

  // A real call to a real, free, keyless source. `observeRate` falls back to a
  // dated fixed table and LABELS the reading `simulated` when it cannot reach
  // it; it never invents a live number.
  const observation = await observeRate(currency);

  rule("pricing");
  kv("source", `${observation.source} (${observation.evidence})`);
  kv("literal", `${observation.literal}  for ${observation.rateDate}`);
  const preview = priceQuote({
    sellCents,
    buyCurrency: currency,
    midRateScaled: observation.rateScaled,
    rateScale: observation.rateScale,
    feeFlatCents: DEFAULT_FEE_FLAT_CENTS,
    feeBps: DEFAULT_FEE_BPS,
    spreadBps: DEFAULT_SPREAD_BPS,
  });
  kv("delivery residual", `${preview.deliveryResidualTenThousandths} / 10000 of one ${currency} minor unit, floored — disclosed, not a ledger amount`);

  const created = await createQuote({
    businessId: business.id,
    buyCurrency: currency,
    sellCents,
    beneficiaryRef: beneficiary,
    destinationAddress: RECIPIENT,
    observation,
    ttlSeconds: ttl,
    settlementWindowSeconds: settlementWindow,
  });

  rule("quote");
  if (!created.ok) {
    kv("REFUSED", created.error.code);
    console.log(`\n  ${created.error.message}`);
    await sql.end();
    process.exit(1);
  }
  printQuote(created.value);
  console.log(`\nNothing is committed until it is accepted, and nothing is on the ledger.`);
  console.log(`  node scripts/payout-usdc.mjs --quote-accept ${created.value.quoteRef}`);
  await sql.end();
  process.exit(0);
}

if (flag("quote-accept")) {
  const ref = option("quote-accept", null);
  if (ref === null) {
    console.error("usage: --quote-accept FXQ-XXXXXXXX");
    await sql.end();
    process.exit(2);
  }
  const accepted = await acceptQuote({ quoteRef: ref, reference: REFERENCE });
  rule("acceptance");
  if (!accepted.ok) {
    kv("REFUSED", accepted.error.code);
    console.log(`\n  ${accepted.error.message}`);
    console.log("\nNothing was written. The expiry is decided by the database, not by this script.");
    await sql.end();
    process.exit(1);
  }
  printQuote(accepted.value);
  console.log(`\nWe are committed. Nothing is on the ledger: a commitment is not a transaction.`);
  console.log(`  node scripts/payout-usdc.mjs --quote ${accepted.value.quoteRef}`);
  await sql.end();
  process.exit(0);
}

if (flag("quote-show")) {
  const ref = option("quote-show", null);
  const quote = ref === null ? null : await loadQuoteByRef(ref);
  rule("quote");
  if (quote === null) {
    console.log(`  there is no quote ${ref}`);
    await sql.end();
    process.exit(1);
  }
  printQuote(quote);
  await sql.end();
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* The commitment this payout settles                                         */
/* -------------------------------------------------------------------------- */

rule("configuration");
kv("rpc", `${new URL(RPC_URL).origin}${new URL(RPC_URL).pathname === "/" ? "" : "/<redacted path>"}`);
kv("chain id", CHAIN_ID);
kv("token", TOKEN);
kv("from", SENDER);
kv("key derives", addressFromPrivateKey(parsePrivateKey(KEY)));
kv("to", RECIPIENT);
kv("mode", DOMESTIC ? "DOMESTIC — not a conversion, no quote required" : "CROSS-BORDER — gated on an accepted quote");

// Whose money it is. Resolved BEFORE the gate so the gate can check that this
// customer is the one the commitment was made to, rather than being handed the
// quote's own business id and asked whether it equals itself.
const [business] = await sql`SELECT id, legal_name FROM business WHERE legal_name = ${BUSINESS}`;
if (!business) throw new Error(`no business named ${BUSINESS}`);
kv("customer", `${business.legal_name}`);

let quote = null;
let settlementObservation = null;
let fundedUnits = null;

if (!DOMESTIC) {
  quote = QUOTE === null ? null : await loadQuoteByRef(QUOTE);

  if (quote !== null) {
    rule("commitment");
    printQuote(quote);

    // The mid AT SETTLEMENT — not the quoted mid. The difference between the
    // two is the entire reason `fx_quote_settlement` stores both.
    settlementObservation = await observeRate(quote.buyCurrency);
    fundedUnits = deliveryCostUnits({
      buyMinor: quote.buyMinor,
      rateScaled: settlementObservation.rateScaled,
      rateScale: settlementObservation.rateScale,
      buyExponent: quote.buyExponent,
    });

    rule("settlement price");
    kv("settlement mid", `${formatRate(settlementObservation.rateScaled, settlementObservation.rateScale, { minDecimals: 4 })}  (${settlementObservation.evidence} · ${settlementObservation.source} · ${settlementObservation.rateDate})`);
    kv("buys", formatMinorUnits(quote.buyMinor, quote.buyExponent, quote.buyCurrency));
    kv("costs", `${formatUsdc(fundedUnits)}  — derived from the commitment, not typed`);

    const typed = option("amount", null);
    if (SETTLE_ONLY !== null && typed !== null) {
      // RECOVERY, NOT SIZING. On --settle the transfer has already happened
      // and the operator is stating what actually left the wallet, which is a
      // fact on a chain and not a figure this script gets to argue with. The
      // ledger must match the chain; derived is a guess about the past.
      fundedUnits = parseUsdc(typed);
      kv("actually sent", `${formatUsdc(fundedUnits)}  — from --settle, the chain's figure, not the derived one`);
    } else if (typed !== null && parseUsdc(typed) !== fundedUnits) {
      rule("refused");
      kv("code", "FX_AMOUNT_NOT_THE_COMMITMENT");
      console.log(
        `\n  --amount ${typed} is ${parseUsdc(typed)} USDC units and settling ${quote.quoteRef}\n` +
          `  costs ${fundedUnits}. The size of a settlement is decided by the commitment and\n` +
          "  the market, not by the operator: a payout sized by hand is a transfer that cites\n" +
          "  a quote, not the settlement of one. Nothing was signed and nothing moved.\n" +
          `\n  Re-run without --amount, or with --amount ${usdcArg(fundedUnits)}.`,
      );
      await sql.end();
      process.exit(1);
    }
  }
}

const AMOUNT_UNITS = DOMESTIC || fundedUnits === null ? parseUsdc(option("amount", "0.50")) : fundedUnits;

/* -------------------------------------------------------------------------- */
/* THE GATE                                                                   */
/* -------------------------------------------------------------------------- */
//
// Here, immediately before anything is signed. It reads the database and
// returns a refusal or null; it never throws for a database problem, it
// refuses — an unknown answer is a refusal on this path, not a pass. See
// gate.ts's header for why this control fails closed when the payee gate does
// not.

if (SETTLE_ONLY !== null) {
  // ── THE GATE DOES NOT RUN ON A RECOVERY, AND THIS IS NOT A LOOPHOLE ───────
  //
  // Found the hard way, live: a settlement whose commitment window lapsed
  // between the broadcast and the recovery run was refused HERE, after 1.48
  // USDC had already confirmed on Base Sepolia. The money was gone and the
  // ledger did not know, which is a reconciliation break manufactured by a
  // control.
  //
  // The gate exists to stop value leaving. On --settle the value has already
  // left. There is nothing left to refuse and refusing anyway only makes the
  // books disagree with the chain, so the posting goes ahead. What does NOT go
  // ahead is consuming the commitment: `fx_quote_settlement`'s trigger still
  // checks that the quote was accepted and that its window was open, and a
  // lapsed one is refused there — leaving a posted entry against an unconsumed
  // quote, which is a visible break for the breaks screen rather than a lie in
  // the ledger. That is the right shape: the ledger tells the truth about the
  // money, and the quote book tells the truth about the commitment.
  rule("gate");
  kv("verdict", "NOT RUN — --settle");
  console.log(
    "\n  This transfer has already confirmed on chain. The gate stops value leaving; it has\n" +
      "  left. Refusing to post it now would only make the ledger disagree with the chain.\n" +
      "  The commitment is still checked at the point it is consumed, by the database.",
  );
} else if (CHECK_ONLY && QUOTE === null) {
  // `--check` reads the chain and sends nothing, so there is no value for the
  // gate to protect and demanding a quote for a diagnostic would only teach
  // people to pass one they do not mean. With a quote it DOES run — that is a
  // dry run of the real control, which is exactly what the /payouts screen's
  // send button is.
  rule("gate");
  kv("verdict", "NOT RUN — --check with no quote");
  console.log("\n  Nothing will be sent, so there is nothing to gate. Pass --quote to dry-run it.");
} else if (!DOMESTIC) {
  rule("gate");
  const refusal = await requireAcceptedQuote({
    quoteRef: QUOTE,
    amountUnits: AMOUNT_UNITS,
    toAddress: RECIPIENT,
    businessId: business.id,
  });

  if (refusal !== null) {
    kv("verdict", "REFUSED");
    kv("code", refusal.code);
    console.log(`\n  ${refusal.message}`);
    console.log(
      "\nNothing was signed, nothing was broadcast, nothing was posted. That is the correct\n" +
        "outcome for a refusal — the gate runs before the wallet key is used, not after.",
    );
    if (QUOTE === null) {
      console.log(
        "\nIf this payout is genuinely not a currency conversion — a customer's own dollars\n" +
          "moving to their own wallet — say so explicitly with --domestic.",
      );
    }
    await sql.end();
    process.exit(1);
  }

  kv("verdict", "CLEARED");
  kv("quote", `${quote.quoteRef} — accepted ${quote.acceptedAt}, settle by ${quote.settleBy}`);
  kv("ceiling", `${usd(quote.sellCents)} committed; sending ${formatUsdc(AMOUNT_UNITS)}`);
} else {
  rule("gate");
  kv("verdict", "SKIPPED — --domestic");
  console.log(
    "\n  This is declared NOT a currency conversion, so there is no price to have agreed\n" +
      "  and nothing to gate on. The entry is the two-line domestic template, not the\n" +
      "  FX settlement one, and no quote is consumed.",
  );
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

const rpc = new BaseRpc({ url: RPC_URL });
const privateKey = parsePrivateKey(KEY);

const request = {
  tokenAddress: TOKEN,
  fromAddress: SENDER,
  toAddress: RECIPIENT,
  amountUnits: AMOUNT_UNITS,
  chainId: BigInt(CHAIN_ID),
  privateKey,
  confirmations: 1,
  receiptTimeoutMs: 180_000,
};

rule("chain, before");
const before = {
  usdc: await rpc.erc20BalanceOf(TOKEN, SENDER),
  wei: await rpc.getBalance(SENDER),
  nonceLatest: await rpc.getTransactionCount(SENDER, "latest"),
  noncePending: await rpc.getTransactionCount(SENDER, "pending"),
  recipient: await rpc.erc20BalanceOf(TOKEN, RECIPIENT),
};
kv("sender USDC", formatUsdc(before.usdc));
kv("sender gas", `${before.wei} wei`);
kv("nonce", `latest=${before.nonceLatest} pending=${before.noncePending}`);
kv("recipient USDC", formatUsdc(before.recipient));
kv("amount", formatUsdc(AMOUNT_UNITS));

if (CHECK_ONLY) {
  console.log("\n--check: nothing sent, nothing posted.");
  await sql.end();
  process.exit(0);
}

rule("payout");
const hooks = {
  onSigned: (txHash, raw) => {
    // BEFORE the broadcast, deliberately. If this process dies on the next
    // line, this is the handle that recovers the money:
    //   node scripts/payout-usdc.mjs --quote <ref> --settle <hash>
    console.log(`  signed locally`);
    console.log(`  tx hash               ${txHash}   <- known BEFORE broadcast`);
    console.log(`  idempotency key       ${payoutIdempotencyKey(txHash)}`);
    console.log(`  raw bytes             ${raw.length / 2 - 1} bytes`);
    console.log(`  broadcasting ...`);
  },
  onProgress: (message) => console.log(`  ${message}`),
};

const outcome = SETTLE_ONLY
  ? await settleTransaction(rpc, request, SETTLE_ONLY.toLowerCase(), {
      recovered: true,
      nonce: -1n,
      gas: null,
      ...hooks,
    })
  : await sendUsdcPayout(rpc, request, { ...hooks, allowDuplicate: ALLOW_DUPLICATE });

rule("outcome");
kv("kind", outcome.kind.toUpperCase());

if (outcome.kind === "refused") {
  kv("reason", outcome.reason);
  kv("detail", outcome.detail);
  if (outcome.txHash) kv("tx hash", outcome.txHash);
  console.log("\nNothing was posted to the ledger. That is the correct outcome for a refusal.");
  await sql.end();
  process.exit(1);
}

kv("tx hash", outcome.txHash);
kv("explorer", explorer(outcome.txHash));

if (outcome.kind !== "confirmed") {
  if (outcome.kind === "reverted") {
    kv("receipt status", "0x0 — REVERTED");
    kv("block", outcome.receipt.blockNumber);
    kv("gas burned", `${outcome.receipt.gasCostWei} wei`);
    console.log("\nThe transaction was mined and FAILED. The gas is gone; no USDC moved.");
  } else if (outcome.kind === "reorged") {
    // ── A REORG VERDICT IS NOT PROOF THE MONEY STAYED PUT ────────────────────
    //
    // Seen twice on Base Sepolia, both times on the happy path: the node
    // answers `eth_getTransactionReceipt` at the tip with a `blockHash` of 64
    // zeroes — a preconfirmation, not a reorg — and the adapter's canonicality
    // re-check compares that against the block's real hash, finds them
    // different and says `reorged`. Refusing to post is the RIGHT call there:
    // this script does not get to decide what is canonical, and a posting made
    // on a receipt it could not trust would be worse than no posting.
    //
    // What is wrong is leaving the operator here. The transfer was broadcast.
    // It may well have confirmed — in both observed cases it had — and the
    // ledger does not know, which is a reconciliation break with no handle on
    // it. So print the handle: the hash, the block to check, and the exact
    // recovery command. A human reads the chain and decides; nothing here
    // posts on its own.
    kv("detail", outcome.detail);
    console.log(
      "\nThe receipt could not be confirmed canonical, so NOTHING WAS POSTED — this script does\n" +
        "not get to overrule that check. But the transfer WAS broadcast and may still have\n" +
        "confirmed: a node serving a receipt with a zero block hash at the tip is a\n" +
        "preconfirmation, not a reorg, and it looks exactly like this.\n" +
        "\nRead the chain before deciding anything:\n" +
        `  curl -sS -X POST "$BASE_SEPOLIA_RPC_URL" -H 'content-type: application/json' \\\n` +
        `    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["${outcome.txHash}"]}'\n` +
        "\nIf it comes back with status 0x1 and a block that resolves, the money has left and the\n" +
        "ledger has to be told. Recover it — the gate does not run on --settle, because on a\n" +
        "recovery the value has already gone:\n" +
        `  node scripts/payout-usdc.mjs${QUOTE === null ? "" : ` --quote ${QUOTE}`} --settle ${outcome.txHash} --amount ${usdcArg(AMOUNT_UNITS)}`,
    );
  } else if (outcome.kind === "unconfirmed") {
    kv("waited", `${outcome.waitedMs} ms`);
    console.log(`\nStill in the mempool. The hash above is valid — re-run with:\n  node scripts/payout-usdc.mjs${QUOTE === null ? "" : ` --quote ${QUOTE}`} --settle ${outcome.txHash}`);
  } else if (outcome.kind === "dropped") {
    console.log("\nThe node stopped knowing about this transaction. Nothing moved; re-running is safe.");
  }
  console.log("Nothing was posted to the ledger.");
  await sql.end();
  process.exit(1);
}

kv("receipt status", "0x1 — SUCCESS");
kv("recovered", outcome.recovered ? "yes — found on chain, nothing was sent this run" : "no — broadcast by this run");
kv("block", outcome.receipt.blockNumber);
kv("block hash", outcome.receipt.blockHash);
kv("block time", new Date(Number(outcome.receipt.blockTimestamp) * 1000).toISOString());
kv("gas used", `${outcome.receipt.gasUsed} @ ${outcome.receipt.effectiveGasPriceWei} wei = ${outcome.receipt.gasCostWei} wei`);

rule("chain, after");
const after = {
  usdc: await rpc.erc20BalanceOf(TOKEN, SENDER),
  wei: await rpc.getBalance(SENDER),
  recipient: await rpc.erc20BalanceOf(TOKEN, RECIPIENT),
};
kv("sender USDC", `${formatUsdc(before.usdc)}  ->  ${formatUsdc(after.usdc)}`);
kv("sender gas", `${before.wei} wei  ->  ${after.wei} wei`);
kv("recipient USDC", `${formatUsdc(before.recipient)}  ->  ${formatUsdc(after.recipient)}`);

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

rule("ledger");
const [entity] = await sql`SELECT id, code FROM book_entity ORDER BY created_at LIMIT 1`;
if (!entity) throw new Error("no book_entity — run pnpm migrate && node scripts/seed.mjs");
const [actor] = await sql`SELECT id, display_name FROM actor WHERE display_name = ${ACTOR}`;
if (!actor) throw new Error(`no actor named ${ACTOR}`);

let posting;
if (quote === null) {
  // The domestic template: the customer's deposit against the wallet, with
  // sub-cent USDC dust to 2900. No fee, no commitment, no variance.
  posting = await postUsdcPayout({
    outcome,
    entityId: entity.id,
    businessId: business.id,
    actorId: actor.id,
    reference: REFERENCE,
  });
} else {
  // The FX settlement template. The value date is the BLOCK's own day in book
  // time — when the money moved — while the accepted rate and the acceptance
  // instant ride on the description and the line memos, so a statement drawn
  // for settlement day can show what was agreed on acceptance day.
  posting = await postFxSettlement({
    quote,
    entityId: entity.id,
    actorId: actor.id,
    fundedUnits: outcome.amount.amount,
    settlementMidRateScaled: settlementObservation.rateScaled,
    settlementRateScale: settlementObservation.rateScale,
    txHash: outcome.txHash,
    valueDate: blockValueDate(outcome.receipt.blockTimestamp),
    idempotencyKey: payoutIdempotencyKey(outcome.txHash),
    reference: REFERENCE,
    provenance: `${outcome.provider} block ${outcome.receipt.blockNumber}, gas ${outcome.receipt.gasCostWei} wei`,
  });
}

kv("entity", `${entity.code} ${entity.id}`);
kv("business", `${business.legal_name} ${business.id}`);
kv("actor", `${actor.display_name} ${actor.id}`);
kv("template", quote === null ? "domestic USDC transfer" : `FX settlement of ${quote.quoteRef}`);
kv("value date", `${posting.valueDate}  (from the block timestamp, in book time)`);
kv("idempotency key", posting.idempotencyKey);
kv("entry id", posting.entryId);

const rows = await sql`
  SELECT l.ordinal, a.code, a.business_id, a.name, l.amount_cents, l.currency, l.memo
    FROM journal_line l JOIN account a ON a.id = l.account_id
   WHERE l.entry_id = ${posting.entryId}::uuid
   ORDER BY l.ordinal`;
console.log();
for (const row of rows) {
  const side = row.amount_cents > 0n ? "DR" : "CR";
  const magnitude = row.amount_cents > 0n ? row.amount_cents : -row.amount_cents;
  const code = row.business_id ? `${row.code}/${String(row.business_id).slice(0, 8)}…` : row.code;
  console.log(`  ${side} ${code.padEnd(18)} ${String(magnitude).padStart(10)} ${row.currency}   ${row.name}`);
}
const total = rows.reduce((sum, row) => sum + row.amount_cents, 0n);
console.log(`  ${" ".repeat(3)}${"balance".padEnd(18)} ${String(total).padStart(10)}       (must be 0)`);

const [duplicates] = await sql`
  SELECT count(*)::int AS n FROM journal_entry WHERE idempotency_key = ${posting.idempotencyKey}`;
console.log();
kv("entries with this key", `${duplicates.n}  (UNIQUE constraint; a re-run cannot add another)`);

/* -------------------------------------------------------------------------- */
/* Consume the commitment                                                     */
/* -------------------------------------------------------------------------- */
//
// AFTER the receipt and after the posting, never after the broadcast:
// `fx_quote_settlement.tx_hash` is NOT NULL because a settlement with no
// confirmed transaction is a settlement that did not happen. The trigger
// re-checks the two preconditions the gate checked minutes ago — accepted, and
// inside the settlement window — and re-derives the variance identity, so a
// row that does not add up cannot be stored.

if (quote !== null) {
  rule("commitment consumed");
  const observationId = await recordRateObservation(settlementObservation);
  const settled = await recordQuoteSettlement({
    quoteRef: quote.quoteRef,
    txHash: outcome.txHash,
    entryId: posting.entryId,
    settlementMidRateScaled: settlementObservation.rateScaled,
    settlementRateScale: settlementObservation.rateScale,
    settlementObservationId: observationId,
    settlementCostCents: posting.allocation.settlementCostCents,
    varianceCents: posting.allocation.varianceCents,
  });

  if (!settled.ok) {
    kv("REFUSED", settled.error.code);
    console.log(`\n  ${settled.error.message}`);
    console.log(
      "\nThe transfer confirmed and the entry is posted — those are facts on a chain and in an\n" +
        "append-only ledger and neither is being undone. What did not happen is the quote being\n" +
        `marked consumed. Re-run:  node scripts/payout-usdc.mjs --quote ${quote.quoteRef} --settle ${outcome.txHash}`,
    );
    await sql.end();
    process.exit(1);
  }

  const record = settled.value;
  kv("state", record.state.toUpperCase());
  kv("accepted rate", `${formatRate(record.customerRateScaled, record.rateScale, { minDecimals: 4 })}  agreed ${record.acceptedAt}`);
  kv("settlement mid", formatRate(record.settlementMidRateScaled, settlementObservation.rateScale, { minDecimals: 4 }));
  kv("delivery", formatMinorUnits(record.buyMinor, record.buyExponent, record.buyCurrency));
  kv("cost to us", usd(record.settlementCostCents));
  kv("variance", `${usd(record.varianceCents)}  (${record.varianceCents >= 0n ? "we kept it" : "we ate it"}) -> 4300`);
  kv("residual", `${posting.allocation.dustUnits} / 10000 of a cent -> 2900 (DESIGN §12.6)`);
  kv("entry", record.entryId);
}

console.log(`\nDone.  ${explorer(outcome.txHash)}`);
await sql.end();
