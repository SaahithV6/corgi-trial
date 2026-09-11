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
 */

import "server-only";

import type { PaymentDestination } from "@/lib/approvals/types";
import { sql, type Sql } from "@/lib/ledger/db";
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
 * Refuse a payment whose destination cannot be paid, or whose standing
 * warning nobody has signed for. `null` means proceed.
 *
 * NEVER THROWS. A failure inside the gate returns `null` — the payment
 * proceeds — rather than turning a payee-book problem into a payment outage.
 * That is the deliberate direction to fail in: the ledger, the KYB gate and
 * maker-checker are the controls that must hold, and this one is an
 * additional check in front of them. A destination-validation service that
 * can stop every payment by falling over is a worse risk than one that
 * occasionally does not run.
 */
export async function gatePaymentOnPayee(
  input: {
    readonly accountId: string;
    readonly destination: PaymentDestination;
  },
  conn: Sql = sql,
): Promise<PayeeGateRefusal | null> {
  const routingNumber =
    input.destination.type === "ach" ? input.destination.routingNumber : null;

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
  try {
    const last4 =
      input.destination.type === "ach" || input.destination.type === "wire"
        ? input.destination.accountNumberLast4
        : null;
    if (routingNumber === null || last4 === null) return null;

    const rows = await conn<
      {
        display_name: string;
        outcome: string | null;
        acknowledged: boolean;
        freshness: string;
      }[]
    >`
      SELECT v.display_name, v.outcome::text AS outcome, v.acknowledged, v.freshness
        FROM v_payee_book v
        JOIN account a ON a.business_id = v.business_id
       WHERE a.id = ${input.accountId}::uuid
         AND v.routing_number = ${routingNumber}
         AND v.account_number_last4 = ${last4}
         AND NOT v.archived
       ORDER BY v.checked_at DESC NULLS LAST
       LIMIT 1`;

    const payee = rows[0];
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
  } catch {
    // See the note above on which direction to fail in.
    return null;
  }
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
