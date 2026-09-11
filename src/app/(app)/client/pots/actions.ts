"use server";

/**
 * The customer moving their own money between their own pots.
 *
 * ===========================================================================
 * WHY THIS IS A CUSTOMER FEATURE AND NOT AN OPERATOR ONE
 * ===========================================================================
 *
 * The brief's stretch ladder asks for "sub-accounts or pots, with instant
 * internal transfers that are pure ledger moves". This build shipped that
 * entirely operator-side: `/pots` lets a member of bank staff open a pot on a
 * customer's behalf and move that customer's money about, and the customer
 * whose money it is could do neither. That polarity is backwards. Setting
 * aside money for payroll is the business doing its own bookkeeping; the bank
 * needs to SEE the pots, not to be the only party who can create one.
 *
 * ===========================================================================
 * ONE WRITER, TWO SURFACES
 * ===========================================================================
 *
 * Every write below goes through `openPot()` and `movePotFunds()` in
 * `@/lib/pots/transfer` — the same two functions the staff console's action
 * calls, reached through the library rather than through the other screen.
 * Nothing in this file takes the lock, decides a move, formats a journal line
 * or knows the shape of `journal_entry`. The advisory lock,
 * `lock_business_deposits()`, `decideMove()` behind it, the idempotency key,
 * the two legs summing to zero and the deferred trigger from migration 0057
 * all apply unchanged, because they are not applied here. They are applied in
 * the library and in the database.
 *
 * `src/app/(app)/pots/actions.ts` is not imported and is not touched. Two
 * surfaces calling one library function is correct; a second copy of the rule
 * is the defect.
 *
 * ===========================================================================
 * THE POT ID IS A CLAIM, AND IT IS CHECKED AS A PREDICATE
 * ===========================================================================
 *
 * A pot id arrives from a form, so it is worth nothing on its own. Before any
 * write, `ownsPot()` resolves it against the business this surface is scoped
 * to with `WHERE p.id = $1 AND p.business_id = $2` — one statement, both
 * columns, evaluated by Postgres before a row exists to be filtered. It is not
 * a `pots.find(...)` over a list read earlier: that would make tenant
 * isolation a step in a program, and `src/app/(app)/client/live-source.ts`
 * refuses that everywhere else on this surface for the same reason.
 *
 * A pot belonging to another business produces the same refusal as a pot that
 * does not exist, so this form cannot be used to discover which ids are real.
 *
 * ===========================================================================
 * MONEY IS INTEGER MINOR UNITS FROM THE FIRST CHARACTER
 * ===========================================================================
 *
 * `parseAmountCents()` splits what somebody typed on the decimal point as TEXT
 * and assembles a `bigint`. There is no `Number`, no `parseFloat` and no
 * `* 100` on this path at any point, so there is no step at which $19.99
 * becomes 1998.9999999999998.
 */

import { revalidatePath } from "next/cache";

import type { PotActionResult, PotFact } from "@/components/client/pots/action-state";
import { formatUsd } from "@/lib/format/money";
import { sql } from "@/lib/ledger/db";
import {
  isPotNegativeRefusal,
  POT_NEGATIVE_CODE,
  type MoveDirection,
} from "@/lib/pots/model";
import { movePotFunds, openPot, type MoveResult } from "@/lib/pots/transfer";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same sentence for a pot that is not real and a pot that is not theirs.
 *
 * Telling them apart would turn this form into an oracle for which pot ids
 * exist on the platform. `setClientCardControlsAction` makes the identical
 * choice for card ids and says so at length.
 */
const NOT_YOURS =
  "That pot is not on this business. The answer is the same for a pot that does not exist and one belonging to another customer — telling them apart would let anybody confirm which pots are real.";

function result(
  status: "posted" | "refused",
  code: string | null,
  message: string,
  facts: readonly PotFact[] = [],
): PotActionResult {
  return { status, code, message, facts, at: new Date().toISOString() };
}

function refused(code: string, message: string, facts: readonly PotFact[] = []) {
  return result("refused", code, message, facts);
}

/* -------------------------------------------------------------------------- */
/* Reading what somebody typed                                                */
/* -------------------------------------------------------------------------- */

/**
 * An amount field, as characters.
 *
 * `null` means the field could not be read as money at all, which is a
 * different answer from "that is more than you have" and gets a different
 * sentence. Zero parses successfully and is refused one layer down by
 * `decideMove()`, which is where "a transfer moves a positive amount" is
 * written and should stay written.
 */
function parseAmountCents(raw: FormDataEntryValue | null): bigint | null {
  const text =
    typeof raw === "string" ? raw.trim().replace(/^\$/, "").replace(/,/g, "") : "";
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return null;
  const [dollars = "0", fraction = ""] = text.split(".");
  return BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** A reference is what the movement is FOR, and it is part of the idempotency key. */
function readReference(raw: FormDataEntryValue | null): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text.slice(0, 80);
}

/* -------------------------------------------------------------------------- */
/* The predicate                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Is this pot on this business?
 *
 * One statement, both columns, answered by Postgres. The row it returns is
 * discarded — the only thing wanted is whether the predicate matched, and
 * nothing downstream is allowed to depend on a figure read here rather than on
 * one read behind the transfer's own lock.
 */
async function ownsPot(potId: string, businessId: string): Promise<boolean> {
  if (!UUID.test(potId) || !UUID.test(businessId)) return false;
  const rows = await sql<{ id: string }[]>`
    SELECT p.id
      FROM pot p
     WHERE p.id = ${potId}::uuid
       AND p.business_id = ${businessId}::uuid
     LIMIT 1
  `;
  return rows[0] !== undefined;
}

/* -------------------------------------------------------------------------- */
/* Turning a library refusal into a sentence on the screen                    */
/* -------------------------------------------------------------------------- */

/**
 * The three refusals a customer can actually reach, plus the floor under them.
 *
 * `INSUFFICIENT_AVAILABLE` and `INSUFFICIENT_POT` arrive from `decideMove()`
 * already carrying the arithmetic that refused them, so the library's sentence
 * is rendered verbatim and this function adds only the figures beside it. The
 * codes are matched as TOKENS — `POT_NEGATIVE_CODE` is compared by identity,
 * never by looking for words in the prose, because the prose is written for a
 * human and may be reworded while the token is the contract.
 *
 * `POT_WOULD_GO_NEGATIVE` is migration 0057's deferred constraint trigger
 * refusing the COMMIT, and reaching it means the write did not come through
 * `decideMove()` at all. It is a defect rather than a customer error, and it
 * is labelled as one: the customer is told their money did not move and that
 * the failure is ours, rather than being shown arithmetic that would not
 * explain it.
 */
function refusalOf(move: Extract<MoveResult, { kind: "refused" }>): PotActionResult {
  const figures: PotFact[] = [
    { label: "You asked to move", value: formatUsd(move.requestedCents) },
  ];
  if (move.code === "INSUFFICIENT_AVAILABLE" || move.code === "INSUFFICIENT_POT") {
    figures.push(
      { label: "There was", value: formatUsd(move.coverCents) },
      { label: "Short by", value: formatUsd(move.shortfallCents) },
    );
  }

  // The token, twice, and never the prose. `movePotFunds()` already maps the
  // trigger onto its own code; the second arm catches a future path that lets
  // the raw message through as `MOVE_FAILED` instead, and it matches on
  // `POT_NEGATIVE_CODE` appearing in the text rather than on any sentence
  // around it — which is what `isPotNegativeRefusal()` is for.
  if (
    move.code === POT_NEGATIVE_CODE ||
    (move.code === "MOVE_FAILED" && isPotNegativeRefusal(move.reason))
  ) {
    return refused(
      POT_NEGATIVE_CODE,
      "Your money did not move, and nothing was written. The ledger's own guard refused this at the last moment, which means the check that should have caught it first did not run — that is a fault on our side, not something you did wrong. The pot is exactly as it was.",
      figures,
    );
  }

  if (move.code === "MOVE_FAILED") {
    return refused(
      "MOVE_FAILED",
      `Your money did not move. The transfer was rolled back in full, so the pot and your main balance are exactly as they were. ${move.reason}`,
      figures,
    );
  }

  return refused(move.code, move.reason, figures);
}

/** The receipt, as the customer will read it back. */
function receiptFacts(
  move: Extract<MoveResult, { kind: "posted" }>,
): readonly PotFact[] {
  const { receipt } = move;
  return [
    // NOT `receipt.amountCents` on a replay. The receipt carries the amount
    // that was typed; the `Entry` line below carries the id of an entry that
    // already existed, and the amount is not part of the idempotency key — so
    // the two can describe different movements. `postedMessage()` says so in
    // words, and this line stops the figure contradicting it.
    receipt.replay
      ? { label: "Moved", value: "nothing — this reference was already posted" }
      : { label: "Moved", value: formatUsd(receipt.amountCents) },
    {
      label: `“${receipt.potName}” now holds`,
      value: formatUsd(receipt.after.potCents),
    },
    { label: "Main balance", value: formatUsd(receipt.after.mainCents) },
    { label: "Available to spend", value: formatUsd(receipt.after.availableCents) },
    { label: "Value date", value: receipt.valueDate, mono: true },
    { label: "Entry", value: receipt.entryId, mono: true },
  ];
}

/**
 * The sentence on a posted move.
 *
 * A REPLAY IS NOT A SECOND TRANSFER AND MUST NOT READ LIKE ONE. Submitting the
 * same reference twice lands on the same `journal_entry.idempotency_key`, and
 * the library returns the entry that already exists having written nothing.
 * Saying "moved" again would tell somebody their money moved twice.
 */
function postedMessage(move: Extract<MoveResult, { kind: "posted" }>): string {
  const { receipt } = move;
  if (receipt.replay) {
    return "This transfer had already gone through, so nothing was written a second time. What you are looking at is the entry that already exists: a reference names one movement, and one movement is one entry. To move more money, give it a different reference.";
  }
  return receipt.direction === "in"
    ? `${formatUsd(receipt.amountCents)} is now set aside in “${receipt.potName}”. It is still your money and it is still on your account — it is no longer counted as available to spend, so a card payment or a transfer cannot reach it.`
    : `${formatUsd(receipt.amountCents)} is back in your main balance and available to spend from now. “${receipt.potName}” holds ${formatUsd(receipt.after.potCents)}.`;
}

/* -------------------------------------------------------------------------- */
/* 1. Open a pot                                                              */
/* -------------------------------------------------------------------------- */

export async function createClientPotAction(
  _previous: PotActionResult,
  formData: FormData,
): Promise<PotActionResult> {
  const businessId = String(formData.get("businessId") ?? "");
  if (!UUID.test(businessId)) {
    return refused(
      "NO_SUCH_BUSINESS",
      "This screen is not scoped to a business, so there is no account to open a pot under.",
    );
  }

  const name = String(formData.get("name") ?? "").trim();
  const purposeRaw = String(formData.get("purpose") ?? "").trim();

  const opened = await openPot({
    businessId,
    name,
    purpose: purposeRaw === "" ? null : purposeRaw,
  });

  if (opened.kind === "refused") {
    return refused(opened.code, opened.reason);
  }

  revalidatePath("/client/pots");
  return result(
    "posted",
    null,
    `“${name}” is open and holds $0.00. A pot is a real account under your own current account, not a label on a screen — nothing has moved into it yet, so your available balance is unchanged.`,
    [
      { label: "Pot", value: name },
      { label: "Holds", value: formatUsd(0n) },
      { label: "Account code", value: opened.accountCode, mono: true },
    ],
  );
}

/* -------------------------------------------------------------------------- */
/* 2. Move money in, or back out                                              */
/* -------------------------------------------------------------------------- */

export async function moveClientPotAction(
  _previous: PotActionResult,
  formData: FormData,
): Promise<PotActionResult> {
  const businessId = String(formData.get("businessId") ?? "");
  const potId = String(formData.get("potId") ?? "");

  // WHICH WAY IS NOT A DEFAULT. The two directions are carried by the two
  // submit buttons, and a submit button contributes its name only when it is
  // the one that was pressed — so a form submitted by pressing Enter in the
  // amount box arrives with no `direction` at all. Reading that as "in" meant
  // money went INTO a pot without anybody having chosen a direction, which is
  // the one thing the two-button layout exists to prevent. There is no safe
  // default between two opposite instructions; the honest answer is to say
  // which button says which.
  const rawDirection = String(formData.get("direction") ?? "");
  if (rawDirection !== "in" && rawDirection !== "out") {
    return refused(
      "DIRECTION_NOT_CHOSEN",
      "Say which way the money goes. Press “Set aside in this pot” to move it into the pot, or “Release back to my balance” to take it out — pressing Enter does not choose one, and nothing was moved.",
    );
  }
  const direction: MoveDirection = rawDirection;

  if (!(await ownsPot(potId, businessId))) {
    return refused("POT_NOT_ON_THIS_BUSINESS", NOT_YOURS);
  }

  const amountCents = parseAmountCents(formData.get("amount"));
  if (amountCents === null) {
    return refused(
      "AMOUNT_UNREADABLE",
      "Write the amount in dollars and cents, like 250 or 250.00. A transfer moves a positive amount; to move money the other way, use the other button rather than a minus sign.",
    );
  }

  const reference = readReference(formData.get("reference"));
  if (reference === "") {
    return refused(
      "REFERENCE_REQUIRED",
      "Say what this is for — “payroll-2026-09”, an invoice number, a job. It is kept on the entry, and it is also what makes a double-click one transfer instead of two: the same reference for the same pot and direction lands on the entry that already exists rather than posting a second one.",
    );
  }

  const move = await movePotFunds({ potId, direction, amountCents, reference });
  if (move.kind === "refused") return refusalOf(move);

  revalidatePath("/client/pots");
  return result("posted", null, postedMessage(move), receiptFacts(move));
}

/* -------------------------------------------------------------------------- */
/* 3. Move money from one pot to another                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pot to pot, as the two entries it actually is.
 *
 * ===========================================================================
 * TWO ENTRIES, AND THE SCREEN SAYS SO RATHER THAN PRETENDING OTHERWISE
 * ===========================================================================
 *
 * `movePotFunds()` moves money between ONE pot and the main balance, because
 * that is the shape the pot rules are written for: a move IN is capped by
 * `ledger_availability()`, and a move OUT is capped by the pot's own balance.
 * A pot-to-pot transfer is a release followed by an earmark, and this function
 * does exactly that — two calls to the one library function, in order, each
 * with its own lock, its own decision and its own journal entry.
 *
 * What it deliberately does NOT do is open its own transaction around both.
 * Wrapping two calls that each call `conn.begin()` would either nest a
 * transaction or hold the deposit lock across a second acquisition of it, and
 * this surface is not the place to invent a new transaction boundary for the
 * pots library. So the honest failure mode is stated instead of hidden: if the
 * release succeeds and the earmark is refused, THE MONEY IS IN THE MAIN
 * BALANCE, and the result below says so in those words with both figures on
 * it. Nothing is lost and nothing is silently half-done — the customer is told
 * exactly where their money is and what to do next.
 *
 * The first leg is the RELEASE, never the earmark, and the order is the whole
 * safety property: releasing first means the intermediate state is money
 * sitting spendable in the main balance, which is a normal state a customer
 * can act on. Earmarking first would require the main balance to cover the
 * amount before the source pot had given it up, which would refuse most
 * legitimate transfers and leave the surprising state on the failure path.
 */
export async function transferBetweenClientPotsAction(
  _previous: PotActionResult,
  formData: FormData,
): Promise<PotActionResult> {
  const businessId = String(formData.get("businessId") ?? "");
  const fromPotId = String(formData.get("fromPotId") ?? "");
  const toPotId = String(formData.get("toPotId") ?? "");

  if (fromPotId === toPotId) {
    return refused(
      "SAME_POT",
      "Those are the same pot. Moving money from a pot to itself would post two lines that cancel, which is a fact about nothing.",
    );
  }
  if (!(await ownsPot(fromPotId, businessId)) || !(await ownsPot(toPotId, businessId))) {
    return refused("POT_NOT_ON_THIS_BUSINESS", NOT_YOURS);
  }

  const amountCents = parseAmountCents(formData.get("amount"));
  if (amountCents === null) {
    return refused(
      "AMOUNT_UNREADABLE",
      "Write the amount in dollars and cents, like 250 or 250.00.",
    );
  }

  const reference = readReference(formData.get("reference"));
  if (reference === "") {
    return refused(
      "REFERENCE_REQUIRED",
      "Say what this is for. It is kept on both entries, and it is what makes a double-click one transfer instead of two.",
    );
  }

  const release = await movePotFunds({
    potId: fromPotId,
    direction: "out",
    amountCents,
    reference,
  });
  if (release.kind === "refused") {
    revalidatePath("/client/pots");
    return refusalOf(release);
  }

  const earmark = await movePotFunds({
    potId: toPotId,
    direction: "in",
    amountCents,
    reference,
  });

  revalidatePath("/client/pots");

  if (earmark.kind === "refused") {
    const stranded = refusalOf(earmark);
    return refused(
      stranded.code ?? "MOVE_FAILED",
      `The money left “${release.receipt.potName}” and is sitting in your main balance, spendable, right now. The second half did not go through: ${stranded.message} Nothing is lost — move it into the pot you meant, or back where it came from.`,
      [
        {
          label: `Released from “${release.receipt.potName}”`,
          value: formatUsd(amountCents),
        },
        { label: "Now in your main balance", value: formatUsd(release.receipt.after.mainCents) },
        ...stranded.facts,
      ],
    );
  }

  // ---------------------------------------------------------------------
  // A REPLAY IS NOT A TRANSFER, AND EACH LEG REPLAYS ON ITS OWN.
  //
  // `moveIdempotencyKey()` is `pot:<potId>:<direction>:<reference>` and the
  // AMOUNT IS DELIBERATELY NOT IN IT, so pressing the button twice — or typing
  // a different figure under the same reference — lands on the entry that
  // already exists and writes nothing. The receipt still carries the amount
  // that was TYPED, because that is what the caller passed; the `entryId`
  // beside it is the entry that was already there, which may have been posted
  // for something else entirely. Printing the two together is how a screen
  // tells somebody $500.00 moved when nothing did, under the id of an entry
  // that says $50.00.
  //
  // So the typed amount is not printed on any replayed leg. What is printed is
  // what is true: the pot balances, which on a replay are the balances read
  // behind the lock a moment ago, and the entry the reference already names.
  //
  // The two legs replay independently and the three combinations mean three
  // different things, including one where the money is sitting in the main
  // balance — so they are answered separately rather than collapsed.
  // ---------------------------------------------------------------------
  const fromName = release.receipt.potName;
  const toName = earmark.receipt.potName;
  const balances: readonly PotFact[] = [
    { label: `“${fromName}” now holds`, value: formatUsd(release.receipt.after.potCents) },
    { label: `“${toName}” now holds`, value: formatUsd(earmark.receipt.after.potCents) },
    { label: "Available to spend", value: formatUsd(earmark.receipt.after.availableCents) },
    { label: "Release entry", value: release.receipt.entryId, mono: true },
    { label: "Earmark entry", value: earmark.receipt.entryId, mono: true },
  ];

  if (release.receipt.replay && earmark.receipt.replay) {
    return result(
      "posted",
      null,
      `Nothing was written. Both halves of this transfer are already in your journal under the reference “${reference}”, so this press posted no entry and moved no money — what you are looking at is the pair of entries that already exist. The amounts on them are whatever they were posted for, which is not necessarily what you have just typed: a reference names one movement, and the amount is not part of what makes it one. The balances below are the pots as they stand right now. To move money again, give it a different reference.`,
      balances,
    );
  }

  if (release.receipt.replay) {
    return result(
      "posted",
      null,
      `Only the second half was written. “${fromName}” had already released money under the reference “${reference}” — that entry was left alone and nothing came out of the pot a second time — and the earmark into “${toName}” has now been posted for ${formatUsd(amountCents)}. Check the two balances below against what you meant to move: if the release you are replaying was for a different amount, this press has not moved the two pots by the same figure.`,
      balances,
    );
  }

  if (earmark.receipt.replay) {
    return result(
      "posted",
      null,
      `Only the first half was written, and your money is in your main balance. ${formatUsd(amountCents)} came out of “${fromName}”, but the earmark into “${toName}” was already in your journal under the reference “${reference}”, so nothing was set aside a second time and that ${formatUsd(amountCents)} is sitting spendable in your main balance right now. Nothing is lost. Move it into “${toName}” under a different reference, or put it back where it came from.`,
      [
        { label: "Released from", value: `“${fromName}”` },
        { label: "Now in your main balance", value: formatUsd(release.receipt.after.mainCents) },
        ...balances,
      ],
    );
  }

  return result(
    "posted",
    null,
    `${formatUsd(amountCents)} moved from “${fromName}” to “${toName}”. That is two journal entries, not one: a release and an earmark, each decided on its own behind its own lock. Your total is unchanged — the money never left your account.`,
    balances,
  );
}
