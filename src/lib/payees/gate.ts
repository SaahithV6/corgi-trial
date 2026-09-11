/**
 * The one line that goes in `requestPayment()`.
 *
 * ─── WHAT THE GATE DOES, AND THE TWO THINGS IT DELIBERATELY DOES NOT ───────
 *
 * IT REFUSES TWO THINGS:
 *
 *   1. AN IMPOSSIBLE ROUTING NUMBER. Arithmetic, local, no provider, no
 *      round trip. A payment that cannot succeed should not enter the
 *      approvals queue and take a second human's attention on its way to
 *      failing.
 *
 *   2. A STANDING WARNING NOBODY HAS SIGNED FOR. If this destination is on
 *      the payee book and its most recent check came back `warned`, the
 *      payment does not proceed until a named human has recorded, in
 *      writing, why the difference is legitimate.
 *
 *      NOTE WHAT THIS IS AND IS NOT. It is not a block on the warning — the
 *      warning is still overridable, by anybody, at any time, in one step.
 *      It is a refusal to let the override be IMPLICIT. The remedy is a
 *      signature, not an exception, and the difference between those two is
 *      the difference between a control and a checkbox.
 *
 *   3. A WIRE WITH NO FEDWIRE ADDRESS ON IT. The wire destination carries a
 *      `wireRoutingNumber` now; before it did, it carried a BIC, which is a
 *      SWIFT identifier for a bank and not a Fedwire address. A wire raised
 *      without one gets neither check below, so it is refused rather than
 *      waved through — see WHICH DIRECTION IT FAILS IN.
 *
 *   4. A WIRE WHOSE BENEFICIARY, OR WHOSE BANK, IS NOT ON THE CONFIRMED BOOK.
 *      WIRE ONLY. See WHERE A WIRE'S ABA COMES FROM, below — this is the
 *      refusal that makes "the ABA comes from the payee book" a fact about
 *      the system rather than a habit of one screen.
 *
 *   5. A CHECK THAT COULD NOT BE RUN. If the payee-book lookup throws, this
 *      returns a refusal naming the check that did not complete. A payment
 *      that could not be checked is not a payment that has been checked.
 *
 * IT DOES NOT REFUSE:
 *
 *   * A DESTINATION THAT IS NOT ON THE BOOK. Requiring every payee to be
 *     pre-registered is a real product decision with real costs — it breaks
 *     the one-off refund, the emergency supplier payment, the payment raised
 *     by the MCP agent from an invoice — and the brief did not ask for it.
 *     An unknown destination still gets the arithmetic, which is the part
 *     that catches the typo.
 *
 *   * A STALE CHECK. A payee last verified in March is a payee whose SCREEN
 *     should say so, loudly, and whose payment should still go out. Blocking
 *     on age would mean a bank holiday and a slow re-check could stop
 *     payroll, and the fix people would reach for is turning the check off.
 *     Age is surfaced; it is not a gate.
 *
 * ─── WHERE A WIRE'S ABA COMES FROM. DECIDED 2026-09-11 ─────────────────────
 *
 * Two defensible stories were live at once and they disagreed, which is worse
 * than either of them being wrong.
 *
 *   THE RAIL'S STORY was that a wire beneficiary's ABA belongs to the
 *   CONFIRMED PAYEE BOOK, not to the instruction: `resolveWireBeneficiary()`
 *   looked it up at send time and refused a beneficiary nobody had checked, so
 *   `src/lib/rails/wire/outbound.integration.test.ts` deliberately raised a
 *   BIC-only wire.
 *
 *   THIS GATE'S STORY was that a wire must be validated against the number it
 *   will actually be sent to, so it demanded `wireRoutingNumber` on the
 *   instruction and refused without one.
 *
 * THE DECISION: THE BOOK IS AUTHORITATIVE, AND THE INSTRUCTION CARRIES A COPY
 * THAT THIS GATE PROVES CAME FROM IT.
 *
 * The deciding argument is MAKER-CHECKER, and it is not about payees at all.
 * `payment_instruction.content_hash` is what an approver must cite, and the
 * hash covers `counterparty`. If the ABA is not on the instruction then the
 * single most important fact about a wire — WHICH BANK RECEIVES THE MONEY — is
 * outside the thing two humans signed, and is instead re-resolved at release
 * time from a table that grows rows. Archive a payee, add a same-name
 * same-last-four payee at a different bank, and an already-approved wire
 * quietly addresses itself somewhere new. Nothing about the approval changed,
 * because the approval never covered it. A control that can be stepped around
 * by appending a row is not a control.
 *
 * So the number rides on the instruction, inside the hash, on the approver's
 * screen — and this gate refuses it unless it is the number a human already
 * confirmed for this beneficiary:
 *
 *   `PAYEE_WIRE_PAYEE_NOT_ON_BOOK`          no confirmed wire payee matches
 *                                           (rail, holderName, last4)
 *   `PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED` the beneficiary IS on the book,
 *                                           at a different bank
 *
 * Both were previously discovered by `originateApprovedWire()`, after two
 * approvals and a ledger entry. They are the same refusals, moved to the
 * front, which is what docs/WIRES.md §7 asked for. THE RAIL STILL MAKES THEM:
 * the gate runs on the way IN and cannot speak for what the book says at
 * release time, so `resolveWireBeneficiary()` re-checks the approved number
 * against the book before addressing the message. Two checks of one rule, at
 * the two moments that matter, over the reader in `store.ts` that both share.
 *
 * WHY THE SECOND RAIL IS NOT TREATED THIS WAY. ACH deliberately does not
 * require pre-registration — see IT DOES NOT REFUSE — because those costs are
 * costs of DELAY and an ACH entry is recallable for two banking days. A wire
 * is not, and "urgent payment, right now, to a beneficiary nobody has seen
 * before" is a verbatim description of business email compromise. Nothing on
 * the ACH path below changed.
 *
 * ─── COST ──────────────────────────────────────────────────────────────────
 *
 * No network call. A checksum is arithmetic and the book lookup is one index
 * scan on `(business_id, routing_number)`. Safe to run inside the payment
 * transaction, which is where it has to run: reading the payee book under the
 * same snapshot that writes the instruction is what stops a warning being
 * raised between the check and the INSERT.
 *
 * The provider legs — Increase's directory, Plaid's identity match — run when
 * a payee is added or re-checked, on the payee screen, where a person is
 * waiting and 150ms is affordable. A payment path that fanned out to two
 * third parties inside a transaction would be a payment path that fails when
 * they do.
 *
 * ─── WHICH DIRECTION IT FAILS IN, AND WHY IT CHANGED ───────────────────────
 *
 * IT USED TO FAIL OPEN, AND THAT WAS THE BUG. The standing-warning check was
 * wrapped, whole, in `try { … } catch { return null }`. Every outcome inside
 * it therefore arrived at the caller as the same value: "no warning on this
 * destination" and "the lookup exploded" were indistinguishable, and the
 * payment proceeded either way. The condition the guard exists to catch — a
 * database this transaction cannot read — was precisely the condition that
 * silently disabled the guard.
 *
 * IT NOW FAILS CLOSED, and the refusal names the check that did not run:
 * `PAYEE_STANDING_CHECK_UNAVAILABLE`. The old argument for failing open was
 * that "a destination-validation service that can stop every payment by
 * falling over is a worse risk than one that occasionally does not run". That
 * argument is about an OUTAGE IN A SEPARATE SERVICE. There is no separate
 * service: this runs on `tx`, the same connection and the same transaction
 * that is about to INSERT the instruction. A throw here does not mean the
 * payee book is unreachable while the payments path is healthy — it means
 * THIS transaction cannot read, and the INSERT two statements later is going
 * to fail anyway. Failing open bought availability that was not on offer, and
 * paid for it by disarming the check on the one rail that cannot recall money.
 *
 * THE ONE CASE THAT STILL PROCEEDS, NAMED EXACTLY, because a bare `catch` over
 * everything is what got us here:
 *
 *     AN ACH destination with no payee-book row, or on a business with no
 *     payee book at all, proceeds.
 *
 * That is `readAccountIdentity()` answering `null` for `businessId`, and the
 * `SELECT` answering zero rows. Both are ANSWERS, not failures: a deposit
 * account with no business row cannot have a payee book, and an unregistered
 * ACH destination is deliberately allowed (see IT DOES NOT REFUSE, above).
 * WHAT THAT CAN LET THROUGH: an ACH payment to a beneficiary nobody has ever
 * checked, with nothing but the ABA arithmetic in front of it. That is the
 * accepted trade on the rail where a mistake is recallable for two banking
 * days, and the reasoning is above.
 *
 * ON WIRE IT IS NOT AN ANSWER, IT IS THE REFUSAL. Both of those zero-row
 * outcomes become `PAYEE_WIRE_PAYEE_NOT_ON_BOOK` — see WHERE A WIRE'S ABA
 * COMES FROM. A deposit account with no business cannot have confirmed a wire
 * beneficiary, so a wire from one is a wire nobody has checked.
 */

import "server-only";

import type { PaymentDestination } from "@/lib/approvals/types";
import { sql, type Sql } from "@/lib/ledger/db";
import { readAccountIdentity } from "@/lib/ledger/queries";
import { isErr, type Result } from "@/lib/result";

import { checkRoutingNumber, abaNearMisses } from "./aba";
import { NOT_CHECKED, type RoutingDirectory } from "./directory";
import { NO_IDENTITY_SOURCE, type IdentityNameSource } from "./identity";
import {
  loadBookEntries,
  loadWireBeneficiaries,
  savePayee,
  type PayeeBookEntry,
  type SavedPayee,
} from "./store";
import type { BookEntry, PayeeCandidate, PayeeCheck } from "./types";
import { verifyPayee } from "./verify";

export type PayeeGateRefusal = {
  readonly code: string;
  readonly message: string;
};

/**
 * The routing number this destination is addressed by, whichever rail it is on.
 *
 * ACH and WIRE BOTH HAVE ONE, AND THEY ARE NOT THE SAME NUMBER. This function
 * exists because the line it replaces was
 *
 *     input.destination.type === "ach" ? input.destination.routingNumber : null
 *
 * and everything below keys off that value — so a wire received neither the
 * check-digit arithmetic nor the standing-warning lookup, on the one rail
 * where the money cannot be recovered. The bank a wire is going to has a WIRE
 * ABA that is a different number from its ACH ABA (`021000021` versus
 * `011401533` on the seeded Plaid item), which is exactly why the field is
 * named `wireRoutingNumber` and not `routingNumber`: the mistake this rail
 * suffers is substituting one for the other, and a field that accepts both
 * names accepts the substitution in silence.
 *
 * `undefined` on a wire means a pre-`wireRoutingNumber` instruction shape, and
 * the caller refuses it rather than skipping the checks.
 */
function destinationRoutingNumber(destination: PaymentDestination): string | null {
  switch (destination.type) {
    case "ach":
      return destination.routingNumber;
    case "wire":
      return destination.wireRoutingNumber ?? null;
    // USDC is addressed by a chain address with its own checksum (EIP-55) and
    // internal transfers never leave this book. Neither has an ABA, and
    // neither is a rail this module has anything to say about.
    case "usdc":
    case "internal":
      return null;
  }
}

/**
 * Refuse a payment whose destination cannot be paid, whose standing warning
 * nobody has signed for, or whose checks could not be run. `null` means
 * proceed.
 *
 * NEVER THROWS — but "never throws" is not "always proceeds", and conflating
 * those two is what made this function a no-op on its own failure. Every
 * outcome is a VALUE now: a refusal object when something is wrong or
 * unknowable, `null` when the checks ran and found nothing. See WHICH
 * DIRECTION IT FAILS IN in the header for the one case that still proceeds and
 * what it can let through.
 */
export async function gatePaymentOnPayee(
  input: {
    readonly accountId: string;
    readonly destination: PaymentDestination;
  },
  conn: Sql = sql,
): Promise<PayeeGateRefusal | null> {
  const routingNumber = destinationRoutingNumber(input.destination);

  // ---- 0. a wire with nothing to route on ---------------------------------
  //
  // Ordered FIRST, before the arithmetic, because it is the reason the
  // arithmetic would otherwise be skipped. A BIC is not a substitute: it names
  // a bank on the SWIFT network and Fedwire does not read it.
  if (input.destination.type === "wire" && routingNumber === null) {
    return {
      code: "PAYEE_WIRE_ROUTING_NUMBER_MISSING",
      message:
        "This wire carries no 9-digit wire routing number, so there is nothing for the check " +
        "digit to be computed over and nothing to match against the payee book — the two checks " +
        "in front of a payment would both be skipped. A BIC is not a substitute: it identifies a " +
        "bank on the SWIFT network, while a domestic wire is routed by the receiving bank's WIRE " +
        "ABA, which is a different number from the same bank's ACH ABA. Pick the beneficiary from " +
        "the payee book, where that number has already been checked.",
    };
  }

  // ---- 1. arithmetic ------------------------------------------------------
  if (routingNumber !== null) {
    const verdict = checkRoutingNumber(routingNumber);
    if (!verdict.valid) {
      // Transpositions only. See `abaNearMisses` for why a single-digit
      // suggestion carries no information: there are always exactly nine.
      const swaps = abaNearMisses(routingNumber).filter((s) => s.kind === "transposition");
      return {
        code: "PAYEE_ROUTING_NUMBER_IMPOSSIBLE",
        message:
          `${verdict.message}` +
          (swaps.length > 0
            ? ` Two adjacent digits look swapped: ${swaps.map((s) => s.candidate).join(" or ")} would be valid. Check the payee's paperwork rather than accepting a guess.`
            : ""),
      };
    }
  }

  // ---- 2. a standing warning nobody has signed for ------------------------
  const last4 =
    input.destination.type === "ach" || input.destination.type === "wire"
      ? input.destination.accountNumberLast4
      : null;
  // Not a failure: USDC and internal transfers have neither of these, so there
  // is nothing on the payee book to look up. A wire with no routing number was
  // already refused at section 0, so this branch is USDC and internal only.
  if (routingNumber === null || last4 === null) return null;

  // WHOSE ACCOUNT IS THIS. The join to `account` was there for one column —
  // `business_id`, a foreign key — and `v_payee_book` is keyed by business.
  //
  // THE `try` WRAPS THE CALL AND NOT THE DECISION. Everything after it is a
  // decision about a value that came back, and the thing this has to
  // distinguish is "the database answered null" from "the database did not
  // answer". A `catch` around both reads them as the same event, which is
  // what made this gate silently self-disabling.
  let businessId: string | null;
  try {
    businessId = (await readAccountIdentity(input.accountId, conn))?.businessId ?? null;
  } catch (thrown) {
    return unavailable("the account's business could not be read", thrown);
  }
  if (businessId === null) {
    // An ANSWER, not a failure: a deposit account with no business row cannot
    // have a payee book, which is exactly what the old inner join said. On ACH
    // that means "nothing to look up" and the payment proceeds. On WIRE it
    // means the beneficiary cannot possibly have been confirmed, which is the
    // one thing this rail insists on.
    return input.destination.type === "wire"
      ? notOnBook(input.destination.holderName, last4)
      : null;
  }

  // ---- 3. a wire is addressed from the confirmed book ---------------------
  //
  // WIRE ONLY, and the ACH path below is untouched. See WHERE A WIRE'S ABA
  // COMES FROM in the header for why the number rides on the instruction and
  // this is what proves it came from the book.
  if (input.destination.type === "wire") {
    let confirmed: readonly PayeeBookEntry[];
    try {
      confirmed = await loadWireBeneficiaries(
        {
          businessId,
          holderName: input.destination.holderName,
          accountNumberLast4: last4,
        },
        conn,
      );
    } catch (thrown) {
      return unavailable("the payee book could not be read", thrown);
    }

    if (confirmed.length === 0) return notOnBook(input.destination.holderName, last4);

    // The beneficiary is known; is this the BANK we know them at? A wire to a
    // supplier you really do pay, at a bank you have never confirmed for them,
    // is not a near miss — it is what a redirected invoice looks like from the
    // inside. The matching rule deliberately leaves the routing number out
    // (see `loadWireBeneficiaries`) so that this is a separate sentence.
    const atThisBank = confirmed.filter((p) => p.routingNumber === routingNumber);
    if (atThisBank.length === 0) {
      const known = [...new Set(confirmed.map((p) => p.routingNumber).filter((n) => n !== null))];
      return {
        code: "PAYEE_WIRE_ROUTING_NUMBER_UNCONFIRMED",
        message:
          `"${input.destination.holderName}" ••${last4} is on your payee book, but not at ` +
          `${routingNumber}. ` +
          (known.length === 0
            ? "The confirmed record carries no routing number at all, so there is no Fedwire address anybody has checked for this beneficiary. "
            : `The wire routing number somebody confirmed for this beneficiary is ${known.join(" or ")}. `) +
          "Same supplier, different bank is what a redirected invoice looks like from the " +
          "inside, and a wire cannot be recalled once it is received. Confirm the change " +
          "through a channel you already had — not one from the message that asked for it — " +
          "and add the new details on /payees. Nothing was written and no payment was raised.",
      };
    }

    // Newest check first, so this is the CURRENT standing of the beneficiary
    // at this bank — the same rule the ACH branch applies below.
    const payee = atThisBank[0];
    if (payee === undefined) return notOnBook(input.destination.holderName, last4);
    return unsignedWarning(payee.displayName, payee.outcome, payee.acknowledged);
  }

  // ---- 4. ACH: a standing warning nobody has signed for -------------------
  let rows: readonly {
    display_name: string;
    outcome: string | null;
    acknowledged: boolean;
    freshness: string;
  }[];
  try {
    rows = await conn<
      {
        display_name: string;
        outcome: string | null;
        acknowledged: boolean;
        freshness: string;
      }[]
    >`
      SELECT v.display_name, v.outcome::text AS outcome, v.acknowledged, v.freshness
        FROM v_payee_book v
       WHERE v.business_id = ${businessId}::uuid
         AND v.routing_number = ${routingNumber}
         AND v.account_number_last4 = ${last4}
         AND NOT v.archived
       ORDER BY v.checked_at DESC NULLS LAST
       LIMIT 1`;
  } catch (thrown) {
    return unavailable("the payee book could not be read", thrown);
  }

  const found = rows[0];
  // Also an ANSWER: this ACH destination is not on the book. Deliberately
  // allowed — see IT DOES NOT REFUSE in the header, and section 3 above for
  // why that allowance stops at the wire rail's edge.
  if (found === undefined) return null;

  return unsignedWarning(found.display_name, found.outcome, found.acknowledged);
}

/**
 * A wire beneficiary nobody has confirmed.
 *
 * The same sentence `resolveWireBeneficiary()` says at send time, said here
 * instead — which is the entire point of moving it. A refusal that arrives
 * after two humans have approved and a journal entry has posted has cost two
 * people's attention and left a reconciliation break to explain; the same
 * refusal at `requestPayment()` costs a form error.
 */
function notOnBook(holderName: string, last4: string): PayeeGateRefusal {
  return {
    code: "PAYEE_WIRE_PAYEE_NOT_ON_BOOK",
    message:
      `No confirmed wire payee matches "${holderName}" ••${last4} on this business's payee ` +
      "book. A wire is final on receipt and business email compromise is a WELL-FORMED " +
      "instruction — an urgent payment to a real-sounding beneficiary at a real bank — so " +
      "this rail will not address one nobody has checked. ACH deliberately allows it, because " +
      "an ACH entry is recallable for two banking days and a wire is not. Add the beneficiary " +
      "on /payees, let the routing number be checked, then raise the payment. Nothing was " +
      "written and no payment was raised.",
  };
}

/**
 * The standing-warning refusal, for whichever rail found the row.
 *
 * One function so the two branches cannot drift into two policies. Note what
 * it is and is not: not a block on the warning — that is overridable by
 * anybody in one step — but a refusal to let the override be IMPLICIT.
 */
function unsignedWarning(
  displayName: string,
  outcome: string | null,
  acknowledged: boolean,
): PayeeGateRefusal | null {
  if (outcome !== "warned" || acknowledged) return null;
  return {
    code: "PAYEE_WARNING_UNACKNOWLEDGED",
    message:
      `The last check on "${displayName}" raised a warning that nobody has signed ` +
      "for. Open the payee, read what the check found, and record why it is right to pay " +
      "this account. The payment can then be raised — the warning does not stop it, but " +
      "somebody has to put their name to it.",
  };
}

/**
 * The refusal for a check that did not run.
 *
 * It names WHICH check could not be completed, because that is the difference
 * between a refusal an operator can act on and "invalid request". The
 * underlying error text is deliberately NOT included: it is a Postgres message
 * naming internal ids and table structure, and this string is rendered on a
 * screen. It goes where the rest of this build sends raw driver text — the
 * structured log — via the caller that already logs `payments.refused` with
 * the code.
 */
function unavailable(what: string, thrown: unknown): PayeeGateRefusal {
  return {
    code: "PAYEE_STANDING_CHECK_UNAVAILABLE",
    message:
      `The payee check could not be completed: ${what}. Nothing was written and no payment was ` +
      "raised. This is a refusal rather than a pass on purpose — a payment that could not be " +
      "checked is not a payment that has been checked, and the failure that stops this lookup is " +
      "the same failure that would hide a standing warning on the beneficiary. Retry; if it " +
      "persists, the transaction cannot read the database and no payment on any rail should be " +
      `raised until it can. (${describeThrown(thrown)})`,
  };
}

/** The error's CLASS, never its text. Enough to tell a timeout from a typo. */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.name;
  return typeof thrown;
}

/* -------------------------------------------------------------------------- */
/* The full check, for the payee screen                                       */
/* -------------------------------------------------------------------------- */

export type ConfirmPayeeResult = {
  /**
   * NULL WHEN THE CHECK DID NOT HAPPEN.
   *
   * Not "happened and found nothing" — that is a `PayeeCheck` with no
   * findings. Null means one of the legs could not be run at all, so there is
   * no result to report and none was recorded. See `confirmPayee`.
   */
  readonly check: PayeeCheck | null;
  /** Null when the check was blocked, because a blocked candidate is not a payee. */
  readonly saved: SavedPayee | null;
  /** Present when the check was blocked or could not be run: what the refusal said. */
  readonly refusal: PayeeGateRefusal | null;
};

/**
 * Check a destination against everything available, and record the result.
 *
 * This is the confirmation step in full: arithmetic, then the live directory,
 * then whatever name evidence exists, then the payee book's own twin probe —
 * and then a row, whichever way it went. A blocked candidate becomes a
 * `payee_candidate_refusal`; anything else becomes a payee and its first
 * verification.
 *
 * `directory` and `identity` are parameters rather than module singletons so
 * a test can run the whole path without a network and a demo can run it with
 * one, and so that "which provider answered" is never a global.
 *
 * ─── THE THIRD PLACE THIS FAILED OPEN, AND THE WORST OF THEM ───────────────
 *
 * Fixed 2026-09-11, after §5b had already closed the same shape in
 * `gatePaymentOnPayee()`. The book read for the twin probe was
 *
 *     const book = await loadBookEntries(businessId, conn).catch(() => []);
 *
 * and every consequence of that one line ran downhill. `findConflictingTwin()`
 * over an empty list finds nothing, so `TWIN_WITH_DIFFERENT_DETAILS` — the
 * only account-number check a book of last-four digits can perform, and the
 * one that catches the redirected invoice — could not fire. With no warn-level
 * finding, `decide()` returned `verified`. And then `savePayee()` wrote that
 * word into `payee_verification`, a table that is append-only by grant, by
 * REVOKE and by trigger.
 *
 * SO A TRANSIENT READ FAILURE BECAME PERMANENT EVIDENCE OF A CHECK THAT NEVER
 * HAPPENED, on the book that gates money leaving the building. That is worse
 * than the gate's version: there the payment proceeded and left nothing
 * behind, here the row outlives the outage and can never be corrected, only
 * superseded. Every screen, every freshness band and the payment gate itself
 * then read a check nobody ran. Nothing downstream can tell the difference,
 * because nothing downstream was given one.
 *
 * IT NOW FAILS CLOSED AND WRITES NOTHING. No payee, no verification, no
 * refusal row — `payee_candidate_refusal` is for a candidate the ARITHMETIC
 * refused, and this candidate was not refused, it was not examined. The
 * caller gets `check: null`, `saved: null` and a refusal naming the leg that
 * could not run, and the honest remedy is to press the button again.
 *
 * THE CASE THAT STILL PROCEEDS, NAMED EXACTLY, because a bare `catch` over
 * everything is what got us here:
 *
 *     `loadBookEntries()` RETURNING ZERO ROWS.
 *
 * An empty book is an ANSWER and it is the commonest one: it means this is
 * the business's first payee. `verifyPayee()` already says so in as many
 * words — "Empty is a legitimate answer and means 'first payee'; it is never
 * an error". WHAT THAT CAN LET THROUGH: nothing the twin probe would have
 * caught, because a twin needs an existing record to be a twin of. The catch
 * conflated that answer with "the database did not answer", which are the two
 * things this has to tell apart.
 */
export async function confirmPayee(
  input: {
    readonly candidate: PayeeCandidate;
    readonly payeeKey: string;
    readonly actorId: string;
    readonly directory?: RoutingDirectory | undefined;
    readonly identity?: IdentityNameSource | undefined;
    readonly now?: Date | undefined;
  },
  conn: Sql = sql,
): Promise<ConfirmPayeeResult> {
  // THE `try` WRAPS THE CALL AND NOT THE DECISION, the same rule
  // `gatePaymentOnPayee()` follows. `[]` is a legitimate ANSWER and reaches
  // `verifyPayee()` as one; a throw is not an answer and stops here, before
  // anything is written.
  let book: readonly BookEntry[];
  try {
    book = await loadBookEntries(input.candidate.businessId, conn);
  } catch (thrown) {
    return {
      check: null,
      saved: null,
      refusal: {
        code: "PAYEE_BOOK_UNREADABLE",
        message:
          "The payee could not be checked: this business's existing payee book could not be " +
          "read, so the twin probe — the check that asks whether you already pay this same " +
          "name at a different account — did not run. That is the only account-number check " +
          "this system can perform, and it is the one that catches a redirected invoice. " +
          "NOTHING WAS WRITTEN: no payee, no verification, no refusal. A check that could not " +
          "be completed must not be recorded as a check that succeeded, because " +
          "`payee_verification` is append-only and the word `verified` in it would outlive " +
          `this failure for ever. Try again. (${describeThrown(thrown)})`,
      },
    };
  }

  const check = await verifyPayee(input.candidate, {
    ...(input.directory === undefined ? {} : { directory: input.directory }),
    identity: input.identity ?? NO_IDENTITY_SOURCE,
    book,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  const saved: Result<SavedPayee> = await savePayee(
    {
      candidate: input.candidate,
      check,
      payeeKey: input.payeeKey,
      actorId: input.actorId,
    },
    conn,
  );

  if (isErr(saved)) {
    return {
      check,
      saved: null,
      refusal: { code: saved.error.code, message: saved.error.message },
    };
  }
  return { check, saved: saved.value, refusal: null };
}

/** Re-exported so a caller that only wants the "nothing to look up" value has it. */
export { NOT_CHECKED };
