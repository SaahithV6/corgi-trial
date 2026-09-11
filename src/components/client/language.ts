/**
 * The customer's words for the ledger's facts.
 *
 * ===========================================================================
 * WHAT THIS FILE IS ALLOWED TO DO, AND WHAT IT IS NOT
 * ===========================================================================
 *
 * ALLOWED: rename. "memo hold" becomes "set aside"; `2100` is never printed;
 * `uncleared_credit` becomes "arrived, not cleared yet".
 *
 * NOT ALLOWED: recompute, round, reclassify, or soften. Every function here
 * takes values that are already decided and returns a string. None of them
 * takes a number and returns a different number, and none of them decides
 * whether something is good or bad news — a negative available balance gets
 * the same neutral sentence a positive one does, because it is a correct
 * answer about the customer's real position and dressing it up is how a
 * customer learns not to trust the screen.
 *
 * The one rule that shows up as code: a decline's `reason` is rendered
 * VERBATIM from `card_auth_decision.reason`. There is deliberately no
 * rule-to-sentence lookup table here. The sentence was written at decision
 * time, inside the provider's timeout, by the function that made the decision,
 * and it is the sentence a dispute will be answered from in six months. A
 * second mapping in the UI would drift from it, and the drift would only be
 * discovered by a customer being told two different things.
 */

/** Money in or money out, in the customer's direction. */
export function directionWord(cents: bigint): "in" | "out" | "flat" {
  if (cents > 0n) return "in";
  if (cents < 0n) return "out";
  return "flat";
}

/** How the money travelled, named the way a business owner would say it. */
export function railWord(rail: string | null): string {
  switch (rail) {
    case "ach":
      return "Bank transfer (ACH)";
    case "wire":
      return "Wire";
    case "card":
      return "Card";
    case "usdc":
      return "Stablecoin payout";
    case "internal":
      return "Moved inside your account";
    case null:
      return "Adjustment";
    default:
      return rail;
  }
}

/**
 * What a hold is, in one noun phrase.
 *
 * These three kinds are the whole set (`HoldKindRow`), and each one is a
 * genuinely different reason the money is not spendable — which is why the
 * balance screen itemises them separately rather than printing one "pending"
 * figure. A customer who is told "$19,701.18 pending" cannot tell whether that
 * is their own card spending or a deposit the bank has not released, and those
 * two facts call for opposite actions.
 */
export function holdKindWord(kind: "card_auth" | "uncleared_credit" | "manual"): string {
  switch (kind) {
    case "card_auth":
      return "Card payment waiting to settle";
    case "uncleared_credit":
      return "Money in, not cleared yet";
    case "manual":
      return "Set aside by your bank";
  }
}

export function holdKindExplanation(
  kind: "card_auth" | "uncleared_credit" | "manual",
): string {
  switch (kind) {
    case "card_auth":
      return "Someone on your team used a card. The merchant has told us what they expect to charge, so we set that amount aside. The final amount can be different, and it can arrive days later — a fuel pump or a restaurant tip is the everyday case.";
    case "uncleared_credit":
      return "A payment has landed in your account and we have not released it to spend yet. An incoming bank transfer can be returned after it arrives, so we hold it for the return window rather than lend you money against something that can come back.";
    case "manual":
      return "Your bank has set this amount aside directly. It stays set aside until a person releases it — no clock will do it.";
  }
}

/**
 * "authorised $50.00, settled $73.40" — the sentence the brief asks for, built
 * from the two figures the hold model already folds over the event stream.
 *
 * Both figures come in as decided values. Nothing here subtracts.
 */
export function cardStorySentence(
  authorised: string,
  cleared: string,
  remaining: string,
  closed: boolean,
): string {
  if (closed) {
    return `Authorised ${authorised}, settled ${cleared}. Nothing is set aside any more.`;
  }
  if (cleared === remaining && cleared === authorised) {
    return `Authorised ${authorised}. Nothing has settled yet, so ${remaining} is set aside.`;
  }
  return `Authorised ${authorised}, settled ${cleared} so far, ${remaining} still set aside.`;
}

/**
 * Turn a journal entry's own description into something a customer reads.
 *
 * A REWRITE OF THE LABEL, NEVER OF THE ENTRY. The original description is
 * always rendered underneath, because the customer's copy of the record has to
 * match the bank's copy of the record, and because a support call starts with
 * somebody reading out the reference.
 */
export function entryHeadline(row: {
  readonly description: string;
  readonly rail: string | null;
  readonly entryType: "original" | "reversal" | "rebook";
  readonly amountCents: bigint;
}): string {
  if (row.entryType === "reversal") return "Correction — the original was taken back";
  if (row.entryType === "rebook") return "Correction — booked again at the right amount";

  const inbound = row.amountCents > 0n;
  switch (row.rail) {
    case "card":
      return inbound ? "Refund on a card payment" : "Card payment";
    case "ach":
      return inbound ? "Bank transfer in" : "Bank transfer out";
    case "wire":
      return inbound ? "Wire received" : "Wire sent";
    case "usdc":
      return inbound ? "Stablecoin received" : "Stablecoin payout";
    case "internal":
      return "Moved between your own balances";
    default:
      return inbound ? "Money in" : "Money out";
  }
}

/**
 * The two clocks, said plainly.
 *
 * Bitemporality is the hardest thing on this book to explain and the easiest
 * to hide, and hiding it is what makes a customer ring up. When the day a
 * transaction happened and the day we learned about it differ, the screen says
 * both, in these words.
 */
export function clockSentence(valueDate: string, bookingDate: string): string | null {
  if (valueDate === bookingDate) return null;
  return `Happened ${valueDate}. We learned about it ${bookingDate}, and it is dated the day it happened — not the day it reached us.`;
}

/** A payment's destination, without ever printing a full account number. */
export function destinationSentence(destination: unknown): string {
  if (typeof destination !== "object" || destination === null) return "Not recorded";
  const d = destination as Record<string, unknown>;
  const holder = typeof d["holderName"] === "string" ? d["holderName"] : null;
  switch (d["type"]) {
    case "ach": {
      const last4 = typeof d["accountNumberLast4"] === "string" ? d["accountNumberLast4"] : "????";
      const kind = typeof d["accountType"] === "string" ? d["accountType"] : "account";
      return `${holder ?? "Unnamed payee"} — ${kind} ending ${last4}, by bank transfer`;
    }
    case "wire": {
      const last4 = typeof d["accountNumberLast4"] === "string" ? d["accountNumberLast4"] : "????";
      return `${holder ?? "Unnamed payee"} — account ending ${last4}, by wire`;
    }
    case "usdc": {
      const address = typeof d["address"] === "string" ? d["address"] : "";
      const chain = typeof d["chain"] === "string" ? d["chain"] : "testnet";
      const shown = address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address;
      return `${shown} on ${chain}, in USDC`;
    }
    case "internal":
      return `${holder ?? "Another balance"} — inside this bank`;
    default:
      return "Not recorded";
  }
}

/**
 * The state of a payment, for somebody who does not work here.
 *
 * The underlying states are a fold over an append-only event stream
 * (`foldState`), and this renames them; it does not re-derive them.
 */
export function paymentStateWord(state: string): string {
  switch (state) {
    case "requested":
      return "Waiting for approval";
    case "approved":
      return "Approved — not sent yet";
    case "released":
    case "submitted":
      return "On its way";
    case "settled":
      return "Arrived";
    case "rejected":
      return "Turned down";
    case "cancelled":
      return "Cancelled";
    case "returned":
      return "Came back";
    case "failed":
      return "Did not go through";
    default:
      return state;
  }
}

/** What a lifecycle event was, in the customer's words. */
export function eventWord(kind: string): string {
  switch (kind) {
    case "requested":
      return "Asked for";
    case "approved":
      return "Approved";
    case "rejected":
      return "Turned down";
    case "cancelled":
      return "Cancelled";
    case "released":
      return "Sent";
    case "submitted":
      return "Handed to the rail";
    case "settled":
      return "Arrived";
    case "returned":
      return "Returned";
    case "failed":
      return "Failed";
    default:
      return kind;
  }
}
