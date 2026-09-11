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
 *   4. A CHECK THAT COULD NOT BE RUN. If the payee-book lookup throws, this
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
 *     A destination with no payee-book row, on a business with no payee book
 *     at all, proceeds.
 *
 * That is `readAccountIdentity()` answering `null` for `businessId`, and the
 * `SELECT` answering zero rows. Both are ANSWERS, not failures: a deposit
 * account with no business row cannot have a payee book, and an unregistered
 * destination is deliberately allowed (see IT DOES NOT REFUSE, above). WHAT
 * THAT CAN LET THROUGH: a payment to a beneficiary nobody has ever checked,
 * with nothing but the ABA arithmetic in front of it. On ACH that is the
 * accepted trade and the reasoning is above. On WIRE it is not, and it is
 * closed one layer down rather than here — `resolveWireBeneficiary()` refuses
 * to address a Fedwire message to a beneficiary that is not on the confirmed
 * book, so an unregistered wire destination passes this gate and is refused
 * before any money leaves.
 */

import "server-only";

import type { PaymentDestination } from "@/lib/approvals/types";
import { sql, type Sql } from "@/lib/ledger/db";
import { readAccountIdentity } from "@/lib/ledger/queries";
import { isErr, type Result } from "@/lib/result";

import { checkRoutingNumber, abaNearMisses } from "./aba";
import { NOT_CHECKED, type RoutingDirectory } from "./directory";
import { NO_IDENTITY_SOURCE, type IdentityNameSource } from "./identity";
import { loadBookEntries, savePayee, type SavedPayee } from "./store";
import type { PayeeCandidate, PayeeCheck } from "./types";
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
  // An ANSWER, not a failure: a deposit account with no business row cannot
  // have a payee book, which is exactly what the old inner join said.
  if (businessId === null) return null;

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

  const payee = rows[0];
  // Also an ANSWER: this destination is not on the book. Deliberately allowed
  // — see IT DOES NOT REFUSE in the header, and the wire rail's own refusal
  // for why that allowance stops at this rail's edge.
  if (payee === undefined) return null;

  if (payee.outcome === "warned" && !payee.acknowledged) {
    return {
      code: "PAYEE_WARNING_UNACKNOWLEDGED",
      message:
        `The last check on "${payee.display_name}" raised a warning that nobody has signed ` +
        "for. Open the payee, read what the check found, and record why it is right to pay " +
        "this account. The payment can then be raised — the warning does not stop it, but " +
        "somebody has to put their name to it.",
    };
  }

  return null;
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
  readonly check: PayeeCheck;
  /** Null when the check was blocked, because a blocked candidate is not a payee. */
  readonly saved: SavedPayee | null;
  /** Present when the check was blocked: what the refusal said. */
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
  const book = await loadBookEntries(input.candidate.businessId, conn).catch(
    () => [] as const,
  );

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
