/**
 * Circle's wire vocabulary, and the boundary where it stops being ours.
 *
 * ── THE ONE THING THAT MATTERS ABOUT CIRCLE'S SHAPE ──────────────────────────
 *
 * The transfer POST returns `{id, state: "INITIATED"}`. There is no
 * transaction hash. The hash appears later, on a `GET /v1/w3s/transactions/{id}`,
 * and until it does there is nothing on any chain to look at.
 *
 * That is the whole trap. An acknowledgement looks like a receipt, arrives in
 * the same call, has an id you can log, and means nothing about whether money
 * moved. DECISIONS 011 and 030 already settled the rule for this repo — a
 * payout is posted on a CONFIRMED receipt, never on an acknowledgement — and
 * `INITIATED` is precisely the acknowledgement that rule was written about.
 *
 * So this file makes the state machine explicit rather than leaving it to a
 * string comparison somewhere in a polling loop. `isTerminal()` is the only
 * place a Circle state is judged, and nothing in this package treats a
 * non-terminal state as anything at all.
 *
 * ── DECIMAL STRINGS ARE A WIRE FORMAT, NOT A NUMBER TYPE ────────────────────
 *
 * Circle speaks amounts as decimal strings: `"0.1"`, `"0.100000"`. Money in
 * this repo is a bigint of minor units and nothing else, so the conversion
 * happens exactly here, at the boundary, in both directions, with no float
 * anywhere in it — `parseFloat("0.1") * 1e6` is 100000.00000000001 and that is
 * not a joke, it is what the IEEE-754 double actually holds.
 */

import { USDC_DECIMALS } from "./types";

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

/**
 * Circle's transaction states, as observed and as documented.
 *
 * Kept as a plain string union rather than an enum because the field is
 * whatever Circle sends: an unknown state must be reportable, not a crash.
 * `CircleTransaction.state` is therefore `string`, and these constants are
 * what it is compared against.
 */
export const CIRCLE_TERMINAL_STATES = ["COMPLETE", "FAILED", "CANCELLED", "DENIED"] as const;

/** Reached the chain and succeeded, by Circle's own account. Still not proof. */
export const CIRCLE_SUCCESS_STATE = "COMPLETE";

/** The acknowledgement. Never a payout. See the header. */
export const CIRCLE_INITIATED_STATE = "INITIATED";

export type CircleTerminalState = (typeof CIRCLE_TERMINAL_STATES)[number];

export function isTerminal(state: string): state is CircleTerminalState {
  return (CIRCLE_TERMINAL_STATES as readonly string[]).includes(state);
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Minor units -> the decimal string Circle expects.
 *
 * Always six decimal places, because USDC has six and a padded string is
 * unambiguous to read in a log next to the bigint it came from.
 */
export function unitsToCircleAmount(units: bigint): string {
  if (units < 0n) throw new Error(`transfer amounts are positive: ${units}`);
  const scale = 10n ** BigInt(USDC_DECIMALS);
  return `${units / scale}.${(units % scale).toString().padStart(USDC_DECIMALS, "0")}`;
}

/**
 * A decimal string from Circle -> minor units. Exact, or an error.
 *
 * Rejects more than six decimal places rather than rounding: a figure USDC
 * cannot represent is a figure we were not told, and silently dropping a digit
 * off an amount is how a reconciliation break becomes unexplainable.
 */
export function circleAmountToUnits(amount: string): bigint {
  const text = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`not a decimal amount: ${JSON.stringify(amount)}`);
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > USDC_DECIMALS) {
    throw new Error(`${text} has ${frac.length} decimal places; USDC has ${USDC_DECIMALS}`);
  }
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/**
 * Every Circle response is `{ data: ... }`. Errors are `{ code, message }`.
 *
 * Only the fields this package reads are typed. Everything else is carried on
 * `raw` untouched, which is what an operator needs when a provider does
 * something the type did not anticipate.
 */
export interface CircleWalletSet {
  readonly id: string;
  readonly name: string | null;
}

export interface CircleWallet {
  readonly id: string;
  readonly address: string;
  readonly blockchain: string;
  readonly state: string;
  readonly accountType: string | null;
  readonly walletSetId: string | null;
}

export interface CircleTokenBalance {
  readonly tokenId: string;
  readonly tokenAddress: string | null;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly amount: string;
}

/**
 * A transaction as Circle reports it.
 *
 * `txHash` is `string | null` and not optional, because "there is no hash yet"
 * is the normal, expected answer for the first several seconds of every
 * transfer, and a field that can be `undefined` is a field somebody reads
 * without checking.
 */
export interface CircleTransaction {
  readonly id: string;
  readonly state: string;
  readonly txHash: string | null;
  readonly blockchain: string | null;
  readonly sourceAddress: string | null;
  readonly destinationAddress: string | null;
  /** Circle sends an array; USDC transfers carry exactly one. */
  readonly amounts: readonly string[];
  readonly errorReason: string | null;
  readonly errorDetails: string | null;
  readonly raw: unknown;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${what}: expected an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${what}: expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value;
}

function optionalStr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Unwrap `{ data: ... }`, or say which envelope was missing. */
export function circleData(body: unknown, what: string): Record<string, unknown> {
  const outer = record(body, what);
  if (!("data" in outer)) throw new Error(`${what}: response has no "data" envelope`);
  return record(outer["data"], `${what}.data`);
}

export function parseWalletSet(data: Record<string, unknown>): CircleWalletSet {
  const set = record(data["walletSet"] ?? data, "walletSet");
  return { id: str(set["id"], "walletSet.id"), name: optionalStr(set["name"]) };
}

export function parseWallet(value: unknown): CircleWallet {
  const w = record(value, "wallet");
  return {
    id: str(w["id"], "wallet.id"),
    address: str(w["address"], "wallet.address"),
    blockchain: str(w["blockchain"], "wallet.blockchain"),
    state: str(w["state"], "wallet.state"),
    accountType: optionalStr(w["accountType"]),
    walletSetId: optionalStr(w["walletSetId"]),
  };
}

export function parseTokenBalance(value: unknown): CircleTokenBalance {
  const b = record(value, "tokenBalance");
  const token = record(b["token"], "tokenBalance.token");
  const decimals = token["decimals"];
  return {
    tokenId: str(token["id"], "token.id"),
    // Native coins have no contract address; USDC always does.
    tokenAddress: optionalStr(token["tokenAddress"]),
    symbol: optionalStr(token["symbol"]),
    decimals: typeof decimals === "number" ? decimals : null,
    amount: str(b["amount"], "tokenBalance.amount"),
  };
}

/**
 * A transfer POST's response: an id and a state, and nothing else exists yet.
 *
 * Deliberately parsed by the same function as a full transaction, so that the
 * caller cannot accidentally hold a type that has a `txHash` field which
 * happens to be absent. It is `null`, explicitly, and it says `INITIATED`.
 */
export function parseTransaction(data: Record<string, unknown>): CircleTransaction {
  const t = record(data["transaction"] ?? data, "transaction");
  const amounts = t["amounts"];
  return {
    id: str(t["id"], "transaction.id"),
    state: str(t["state"], "transaction.state"),
    txHash: optionalStr(t["txHash"]),
    blockchain: optionalStr(t["blockchain"]),
    sourceAddress: optionalStr(t["sourceAddress"]),
    destinationAddress: optionalStr(t["destinationAddress"]),
    amounts: Array.isArray(amounts) ? amounts.filter((a): a is string => typeof a === "string") : [],
    errorReason: optionalStr(t["errorReason"]),
    errorDetails: optionalStr(t["errorDetails"]),
    raw: t,
  };
}
