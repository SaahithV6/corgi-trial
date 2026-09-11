/**
 * Re-check a payee that is already on the book.
 *
 * ─── WHY THIS IS NOT `confirmPayee()` WITH AN `if` IN IT ───────────────────
 *
 * `confirmPayee()` turns a CANDIDATE into a payee: it reads the book, runs the
 * four legs, and then either writes a payee plus its first verification or
 * writes a `payee_candidate_refusal`. Every one of those sentences is about a
 * destination that is not on the book yet.
 *
 * Re-checking is a different act on a different subject, and the differences
 * are not cosmetic:
 *
 *   * THE PAYEE IS THE INPUT, not a typed candidate. Nothing about the
 *     beneficiary is re-entered, because re-keying the bank details in order
 *     to re-check them would make the re-check an opportunity to change them.
 *     A re-check must be able to say "the same details, checked again today"
 *     and mean it, so the details come out of the row.
 *
 *   * IT NEVER CREATES A PAYEE and it never writes a refusal. A blocked
 *     outcome here is unreachable by construction —
 *     `payee_routing_number_possible` means an impossible routing number was
 *     never storable in the first place — and `recordVerification()` refuses
 *     one anyway rather than trusting that.
 *
 *   * IT EXCLUDES ITSELF FROM THE TWIN PROBE. `findConflictingTwin()` looks
 *     for another payee on the same book with the same name and different
 *     details; the row being re-checked matches its own name and its own
 *     details, so leaving it in the list is harmless but leaving it in is also
 *     not obviously harmless, and "obviously" is the standard for a function
 *     that decides whether a warning fires. It is filtered by id.
 *
 * ─── WHY RE-CHECKING EXISTS AT ALL ─────────────────────────────────────────
 *
 * Because freshness here is DERIVED and not stamped: `v_payee_book` reads the
 * age of the newest `payee_verification` row against `now()` and labels it
 * fresh / ageing / stale, and there is no `is_verified` column anywhere to
 * re-stamp. The only way to make a check current is to run another one and
 * append it. A book confirmed in March is confirmable again today without a
 * new payee, and the two answers are two rows — which is the whole reason the
 * table is append-only.
 *
 * ─── AND IT FAILS CLOSED, FOR THE REASON IN §5d ────────────────────────────
 *
 * The book read is not wrapped in a `catch` that returns an empty list. A read
 * that did not complete means the twin probe did not run, and a `verified` row
 * written on the back of a probe that did not run is permanent evidence of a
 * check that never happened — on a table that is append-only by grant, by
 * REVOKE and by trigger. Every read here is its own `try`, the `try` wraps the
 * CALL and not the DECISION, and a throw returns `check: null` with nothing
 * written.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { isErr } from "@/lib/result";

import type { RoutingDirectory } from "./directory";
import { NO_IDENTITY_SOURCE, type IdentityNameSource } from "./identity";
import {
  loadBookEntries,
  loadPayeeBook,
  recordVerification,
  type PayeeBookEntry,
} from "./store";
import type { BookEntry, PayeeCandidate, PayeeCheck } from "./types";
import { verifyPayee } from "./verify";

export type RecheckRefusal = {
  readonly code: string;
  readonly message: string;
};

export type RecheckResult = {
  /**
   * NULL WHEN NO CHECK HAPPENED. The same rule `ConfirmPayeeResult.check`
   * follows and for the same reason: "a check that could not be run" and "a
   * check that found nothing" are different facts and only one of them may be
   * recorded. Do not widen this to a `PayeeCheck` with no findings.
   */
  readonly check: PayeeCheck | null;
  /** The appended row's id, when one was appended. */
  readonly verificationId: string | null;
  /** The payee as the book held it, for the screen to name what was checked. */
  readonly payee: PayeeBookEntry | null;
  readonly refusal: RecheckRefusal | null;
};

/** The error's CLASS, never its text — the same rule `gate.ts` applies. */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.name;
  return typeof thrown;
}

function unreadable(leg: string, thrown: unknown): RecheckRefusal {
  return {
    code: "PAYEE_BOOK_UNREADABLE",
    message:
      `The payee could not be re-checked: ${leg} could not be read, so the check did not run. ` +
      "NOTHING WAS WRITTEN — no verification row, and the standing on this payee is still " +
      "whatever the last completed check said. A check that could not be completed must not be " +
      "recorded as a check that succeeded, because `payee_verification` is append-only and the " +
      `word "verified" in it would outlive this failure for ever. Try again. (${describeThrown(thrown)})`,
  };
}

/**
 * Run the legs again against a payee already on the book, and append the
 * answer.
 */
export async function recheckPayee(
  input: {
    readonly payeeId: string;
    readonly actorId: string;
    readonly directory?: RoutingDirectory | undefined;
    readonly identity?: IdentityNameSource | undefined;
    readonly now?: Date | undefined;
  },
  conn: Sql = sql,
): Promise<RecheckResult> {
  let rows: readonly PayeeBookEntry[];
  try {
    rows = await loadPayeeBook({ payeeId: input.payeeId }, conn);
  } catch (thrown) {
    return {
      check: null,
      verificationId: null,
      payee: null,
      refusal: unreadable("the payee's own row", thrown),
    };
  }

  const payee = rows[0];
  if (payee === undefined) {
    return {
      check: null,
      verificationId: null,
      payee: null,
      refusal: {
        code: "PAYEE_NOT_FOUND",
        message:
          "No payee on this book has that id. Nothing was written. If you followed a link out " +
          "of a payment refusal, the payee may have been archived since — archived payees are " +
          "still on the book and still readable, so a missing one means the id is wrong.",
      },
    };
  }

  if (payee.archived) {
    // AN ARCHIVED PAYEE IS A WITHDRAWN BENEFICIARY, and re-checking one would
    // append a fresh `verified` row to a beneficiary nobody intends to pay —
    // which is exactly the row a later reader would take as permission.
    // Archival is an append with a reason on it; the way back is to add the
    // beneficiary again and have the arithmetic run over the new details.
    return {
      check: null,
      verificationId: null,
      payee,
      refusal: {
        code: "PAYEE_ARCHIVED",
        message:
          `"${payee.holderName}" was archived${payee.archivedAt === null ? "" : ` on ${payee.archivedAt.slice(0, 10)}`}` +
          `${payee.archivalReason === null ? "" : ` — ${payee.archivalReason}`}. A withdrawn ` +
          "beneficiary is not re-checked: appending a fresh check to it would leave a current-" +
          "looking row on a payee nobody intends to pay, and a later reader would take that as " +
          "permission. Add the beneficiary again if they are back, so the details go through the " +
          "arithmetic as new ones. Nothing was written.",
      },
    };
  }

  let book: readonly BookEntry[];
  try {
    book = await loadBookEntries(payee.businessId, conn);
  } catch (thrown) {
    return { check: null, verificationId: null, payee, refusal: unreadable("the payee book", thrown) };
  }

  const candidate: PayeeCandidate = {
    businessId: payee.businessId,
    displayName: payee.displayName,
    holderName: payee.holderName,
    rail: payee.rail,
    ...(payee.routingNumber === null ? {} : { routingNumber: payee.routingNumber }),
    ...(payee.accountNumberLast4 === null ? {} : { accountNumberLast4: payee.accountNumberLast4 }),
    ...(payee.accountType === "checking" || payee.accountType === "savings"
      ? { accountType: payee.accountType }
      : {}),
  };

  const check = await verifyPayee(candidate, {
    // OMITTED rather than defaulted to a stub. `verifyPayee()` falls back to a
    // directory that answers `not_checked` for everything, which is the
    // truthful "nobody was asked" — and it is a different fact from
    // `unavailable`, which means somebody was asked and did not answer.
    ...(input.directory === undefined ? {} : { directory: input.directory }),
    identity: input.identity ?? NO_IDENTITY_SOURCE,
    // Itself excluded: a row is not its own twin, and a twin probe that can
    // match the subject is a probe whose answer depends on whether the caller
    // remembered to filter.
    book: book.filter((entry) => entry.id !== payee.payeeId),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  const recorded = await recordVerification(
    { payeeId: payee.payeeId, check, actorId: input.actorId },
    conn,
  );

  if (isErr(recorded)) {
    return {
      check,
      verificationId: null,
      payee,
      refusal: { code: recorded.error.code, message: recorded.error.message },
    };
  }

  return {
    check,
    verificationId: recorded.value.verificationId,
    payee,
    refusal: null,
  };
}
