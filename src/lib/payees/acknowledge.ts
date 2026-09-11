/**
 * Signing for a warning — the act that makes a warning a warning.
 *
 * ─── WHY A SIGNATURE HAS TO NAME WHAT IT SIGNED FOR ────────────────────────
 *
 * `payee_acknowledgement` is a named human, an instant and a sentence, and it
 * is what earns the name leg the right to be a warning rather than a wall. But
 * a sentence on its own answers the wrong question. Six months from now the
 * row reads
 *
 *     Priya Raman · 2026-09-11 · "Checked with the supplier, this is fine."
 *
 * and nobody can tell whether Priya was waving through *a name that did not
 * match* or *a beneficiary at a different bank from the one already on the
 * book*. Those are different acts. The first is routine — trading names,
 * subsidiaries, factoring companies. The second is the exact shape of a
 * redirected invoice, and it is the one finding this book's four-digit account
 * numbers can produce at all. A signature that cannot distinguish them is a
 * signature for "a warning", which is the checkbox this feature exists not to
 * be.
 *
 * So the stored reason is COMPOSED: the operator's own sentence, and then the
 * findings it answers, by code and by title, in the row. One text column, one
 * row per person per check, and the row says what was in front of them.
 *
 * ─── AND THE SET OF FINDINGS IS RE-READ, NEVER TAKEN FROM THE BROWSER ──────
 *
 * The form posts the codes it displayed. That is a CLAIM about what was on
 * screen, and between the render and the submit a re-check can land — the
 * whole point of §freshness is that re-checking is normal — at which point the
 * warning standing against the payee is not the warning the operator read.
 *
 * `signWarning()` therefore re-reads `payee_verification` by id and refuses
 * unless the posted set is EXACTLY the warn-severity set that row carries.
 * Not a subset: acknowledging one of two warnings and having the payment
 * proceed would be the implicit override the gate exists to refuse. Not a
 * superset either, because a signature naming a finding the check did not make
 * is a false statement in an append-only table.
 *
 * The refusal is `PAYEE_WARNING_MOVED`, and it is recoverable in one step:
 * reload, read what the current check found, sign that.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { fail, isErr, ok, type Result } from "@/lib/result";

import {
  composeAcknowledgement,
  REASON_MIN_LENGTH,
  type AcknowledgedFinding,
} from "./acknowledge-text";
import { acknowledgeWarning, loadVerification, type StoredVerification } from "./store";

/**
 * Re-exported so the server half is a single import for callers that do not
 * need the pure half on its own. `acknowledge-text.ts` is the definition; this
 * is a door onto it, not a copy.
 */
export { composeAcknowledgement, REASON_MIN_LENGTH, type AcknowledgedFinding };

export type SignWarningInput = {
  readonly verificationId: string;
  readonly actorId: string;
  readonly reason: string;
  /** The finding codes the form displayed and the operator ticked. */
  readonly codes: readonly string[];
};

export type Signature = {
  readonly acknowledgementId: string;
  readonly verificationId: string;
  readonly payeeId: string;
  readonly holderName: string;
  readonly displayName: string;
  /** Exactly what went into the column. */
  readonly reason: string;
  readonly findings: readonly AcknowledgedFinding[];
};

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  const right = new Set(b);
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

/**
 * Record a signature against one check.
 *
 * Every refusal below is a VALUE with a code. The database has the last word
 * in any case — `assert_payee_acknowledgement_answers_a_warning()` refuses an
 * acknowledgement against a check that was not `warned`, and the unique index
 * refuses a second one from the same person — so these are readable refusals
 * in front of guarantees, never instead of them.
 */
export async function signWarning(
  input: SignWarningInput,
  conn: Sql = sql,
): Promise<Result<Signature>> {
  if (input.reason.trim().length < REASON_MIN_LENGTH) {
    return fail(
      "ACKNOWLEDGEMENT_NEEDS_A_REASON",
      `Proceeding past a payee warning needs a sentence saying why, and at least ` +
        `${REASON_MIN_LENGTH} characters of one. That sentence is the whole reason the warning ` +
        "is allowed to be a warning rather than a wall — it is what somebody reads six months " +
        "from now when they are asking how this payment left the building. Name the channel you " +
        "confirmed through, not the fact that you confirmed.",
    );
  }

  let stored: StoredVerification | null;
  try {
    stored = await loadVerification(input.verificationId, conn);
  } catch (thrown) {
    return fail(
      "PAYEE_CHECK_UNREADABLE",
      "The check being signed for could not be read, so nothing was written. A signature " +
        "recorded against a check nobody could read would name findings nobody verified were " +
        `on it. Try again. (${thrown instanceof Error ? thrown.name : typeof thrown})`,
    );
  }

  if (stored === null) {
    return fail(
      "PAYEE_CHECK_NOT_FOUND",
      "No check on this book has that id, so there is nothing to sign for and nothing was " +
        "written.",
    );
  }

  if (stored.outcome !== "warned") {
    return fail(
      "PAYEE_CHECK_NOT_WARNED",
      `That check came back "${stored.outcome}", and an acknowledgement only exists for a ` +
        "warning. Signing for a clean check is noise in an audit trail, and signing for a block " +
        "is a contradiction — an impossible routing number is not storable, so there is nothing " +
        "for a signature to wave through. The database refuses this at the row as well.",
    );
  }

  const warned: readonly AcknowledgedFinding[] = stored.findings
    .filter((finding) => finding.severity === "warn")
    .map((finding) => ({ code: finding.code, title: finding.title }));

  if (warned.length === 0) {
    return fail(
      "PAYEE_CHECK_HAS_NO_WARNINGS",
      "That check is recorded as warned but carries no warn-level finding in its detail, so " +
        "there is nothing a signature could name. Re-check the payee: a signature has to say " +
        "what it answered, and this one would have nothing to say.",
    );
  }

  if (!sameSet(input.codes, warned.map((finding) => finding.code))) {
    return fail(
      "PAYEE_WARNING_MOVED",
      "The findings you were shown are not the findings on the check that is standing now. " +
        `This check currently carries ${warned.map((f) => f.code).join(", ")}. Nothing was ` +
        "written. Either a re-check landed while this page was open, or not every warning was " +
        "acknowledged — and a signature must answer ALL of them, because acknowledging one of " +
        "two and letting the payment through is exactly the implicit override the payment gate " +
        "refuses. Reload the payee, read what the current check found, and sign that.",
    );
  }

  const reason = composeAcknowledgement(input.reason, warned);

  const recorded = await acknowledgeWarning(
    { verificationId: input.verificationId, actorId: input.actorId, reason },
    conn,
  );
  if (isErr(recorded)) return recorded;

  return ok({
    acknowledgementId: recorded.value.acknowledgementId,
    verificationId: stored.verificationId,
    payeeId: stored.payeeId,
    holderName: stored.holderName,
    displayName: stored.displayName,
    reason,
    findings: warned,
  });
}
