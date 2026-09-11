import "server-only";

/**
 * Every SQL statement the payee book issues, in one file.
 *
 * The rules the rest of `src/lib/payees` depends on:
 *
 *   * NOTHING HERE WRITES TO A MONEY TABLE. No journal entry, no journal
 *     line, no hold, no payment instruction. Grep this file for `journal` and
 *     find nothing. Validating a destination is not posting to one.
 *
 *   * FRESHNESS IS READ, NEVER COMPUTED. `payee_verification_freshness()` in
 *     migration 0016 owns the age bands and `v_payee_book` applies them. This
 *     module reads the label off the view. DECISIONS 024's rule, applied to a
 *     second calendar question.
 *
 *   * A BLOCKED CANDIDATE IS NOT A PAYEE. `savePayee` refuses one and writes
 *     a `payee_candidate_refusal` instead, because the caught typo is the
 *     product of this feature and it has to leave a row. The database would
 *     refuse the payee anyway — `payee_routing_number_possible` — so this is
 *     the readable refusal in front of the structural one, never instead of
 *     it.
 */

import { sql, type Sql } from "@/lib/ledger/db";
import { fail, ok, type Result } from "@/lib/result";

import type {
  BookEntry,
  CheckEvidence,
  DirectoryOutcome,
  Freshness,
  NameMatchOutcome,
  NameSource,
  PayeeCandidate,
  PayeeCheck,
  PayeeOutcome,
  PayeeRail,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

type BookRow = {
  readonly payee_id: string;
  readonly business_id: string;
  readonly business_name: string;
  readonly display_name: string;
  readonly holder_name: string;
  readonly rail: PayeeRail;
  readonly routing_number: string | null;
  readonly account_number_last4: string | null;
  readonly account_type: string | null;
  readonly payee_key: string;
  readonly created_at: Date;
  readonly created_by_name: string;
  readonly archived: boolean;
  readonly archived_at: Date | null;
  readonly archival_reason: string | null;
  readonly verification_id: string | null;
  readonly checked_at: Date | null;
  readonly checked_by_name: string | null;
  readonly outcome: PayeeOutcome | null;
  readonly checksum_ok: boolean | null;
  readonly prefix_assigned: boolean | null;
  readonly directory: DirectoryOutcome | null;
  readonly directory_provider: string | null;
  readonly institution_name: string | null;
  readonly ach_supported: boolean | null;
  readonly wire_supported: boolean | null;
  readonly name_match: NameMatchOutcome | null;
  readonly name_match_score: number | null;
  readonly name_source: NameSource | null;
  readonly name_provider: string | null;
  readonly counterparty_name: string | null;
  readonly evidence: CheckEvidence | null;
  readonly detail: unknown;
  readonly freshness: Freshness;
  readonly checked_days_ago: number | null;
  readonly acknowledged: boolean;
  readonly acknowledged_at: Date | null;
  readonly acknowledged_by_name: string | null;
  readonly acknowledgement_reason: string | null;
  readonly has_conflicting_twin: boolean;
};

export type PayeeBookEntry = {
  readonly payeeId: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly displayName: string;
  readonly holderName: string;
  readonly rail: PayeeRail;
  readonly routingNumber: string | null;
  readonly accountNumberLast4: string | null;
  readonly accountType: string | null;
  readonly payeeKey: string;
  readonly createdAt: string;
  readonly createdByName: string;
  readonly archived: boolean;
  readonly archivedAt: string | null;
  readonly archivalReason: string | null;
  readonly verificationId: string | null;
  readonly checkedAt: string | null;
  readonly checkedByName: string | null;
  readonly outcome: PayeeOutcome | null;
  readonly checksumOk: boolean | null;
  readonly prefixAssigned: boolean | null;
  readonly directory: DirectoryOutcome | null;
  readonly directoryProvider: string | null;
  readonly institutionName: string | null;
  readonly achSupported: boolean | null;
  readonly wireSupported: boolean | null;
  readonly nameMatch: NameMatchOutcome | null;
  readonly nameMatchScore: number | null;
  readonly nameSource: NameSource | null;
  readonly nameProvider: string | null;
  readonly counterpartyName: string | null;
  readonly evidence: CheckEvidence | null;
  /**
   * `payee_verification.detail` as stored: the findings list the service
   * produced, verbatim. Handed to the screen to RENDER and never parsed to
   * make a decision — the decision columns above are the decision.
   */
  readonly detail: unknown;
  readonly freshness: Freshness;
  readonly checkedDaysAgo: number | null;
  readonly acknowledged: boolean;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByName: string | null;
  readonly acknowledgementReason: string | null;
  readonly hasConflictingTwin: boolean;
};

function toEntry(row: BookRow): PayeeBookEntry {
  return {
    payeeId: row.payee_id,
    businessId: row.business_id,
    businessName: row.business_name,
    displayName: row.display_name,
    holderName: row.holder_name,
    rail: row.rail,
    routingNumber: row.routing_number,
    accountNumberLast4: row.account_number_last4,
    accountType: row.account_type,
    payeeKey: row.payee_key,
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
    archived: row.archived,
    archivedAt: row.archived_at === null ? null : row.archived_at.toISOString(),
    archivalReason: row.archival_reason,
    verificationId: row.verification_id,
    checkedAt: row.checked_at === null ? null : row.checked_at.toISOString(),
    checkedByName: row.checked_by_name,
    outcome: row.outcome,
    checksumOk: row.checksum_ok,
    prefixAssigned: row.prefix_assigned,
    directory: row.directory,
    directoryProvider: row.directory_provider,
    institutionName: row.institution_name,
    achSupported: row.ach_supported,
    wireSupported: row.wire_supported,
    nameMatch: row.name_match,
    nameMatchScore: row.name_match_score,
    nameSource: row.name_source,
    nameProvider: row.name_provider,
    counterpartyName: row.counterparty_name,
    evidence: row.evidence,
    detail: row.detail,
    freshness: row.freshness,
    checkedDaysAgo: row.checked_days_ago,
    acknowledged: row.acknowledged,
    acknowledgedAt: row.acknowledged_at === null ? null : row.acknowledged_at.toISOString(),
    acknowledgedByName: row.acknowledged_by_name,
    acknowledgementReason: row.acknowledgement_reason,
    hasConflictingTwin: row.has_conflicting_twin,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The book, newest payee first.
 *
 * `businessId` narrows to one customer; omitting it is the operator view.
 * There is no `where verified = true` here and there could not be, because
 * there is no such column — the caller filters on `outcome` and `freshness`,
 * both derived at read time.
 */
export async function loadPayeeBook(
  filter: { readonly businessId?: string | undefined; readonly payeeId?: string | undefined } = {},
  conn: Sql = sql,
): Promise<readonly PayeeBookEntry[]> {
  const rows = await conn<BookRow[]>`
    SELECT * FROM v_payee_book
     WHERE (${filter.businessId ?? null}::uuid IS NULL OR business_id = ${filter.businessId ?? null}::uuid)
       AND (${filter.payeeId ?? null}::uuid IS NULL OR payee_id = ${filter.payeeId ?? null}::uuid)
     ORDER BY created_at DESC, payee_id DESC`;
  return rows.map(toEntry);
}

/** The shape `verifyPayee`'s twin check wants. A projection, not a second query path. */
export async function loadBookEntries(
  businessId: string,
  conn: Sql = sql,
): Promise<readonly BookEntry[]> {
  const rows = await conn<
    {
      id: string;
      holder_name: string;
      rail: PayeeRail;
      routing_number: string | null;
      account_number_last4: string | null;
    }[]
  >`
    SELECT p.id, p.holder_name, p.rail::text AS rail,
           p.routing_number, p.account_number_last4
      FROM payee p
      LEFT JOIN payee_archival a ON a.payee_id = p.id
     WHERE p.business_id = ${businessId}::uuid
       AND a.payee_id IS NULL`;
  return rows.map((r) => ({
    id: r.id,
    holderName: r.holder_name,
    rail: r.rail,
    routingNumber: r.routing_number,
    accountNumberLast4: r.account_number_last4,
  }));
}

export type RefusalRow = {
  readonly id: string;
  readonly businessId: string;
  readonly attemptedAt: string;
  readonly attemptedByName: string;
  readonly holderName: string;
  readonly rail: PayeeRail;
  readonly routingNumber: string;
  readonly accountNumberLast4: string | null;
  readonly code: string;
  readonly reason: string;
};

/**
 * Every destination the arithmetic refused.
 *
 * This is the evidence the feature works, and it is why the table exists: a
 * blocked candidate never becomes a payee, so without this the caught typo
 * would be invisible in the database five minutes after it was caught.
 */
export async function loadRefusals(
  filter: { readonly businessId?: string | undefined; readonly limit?: number | undefined } = {},
  conn: Sql = sql,
): Promise<readonly RefusalRow[]> {
  const rows = await conn<
    {
      id: string;
      business_id: string;
      attempted_at: Date;
      attempted_by_name: string;
      holder_name: string;
      rail: PayeeRail;
      routing_number: string;
      account_number_last4: string | null;
      code: string;
      reason: string;
    }[]
  >`
    SELECT r.id, r.business_id, r.attempted_at, a.display_name AS attempted_by_name,
           r.holder_name, r.rail::text AS rail, r.routing_number,
           r.account_number_last4, r.code, r.reason
      FROM payee_candidate_refusal r
      JOIN actor a ON a.id = r.attempted_by
     WHERE (${filter.businessId ?? null}::uuid IS NULL
            OR r.business_id = ${filter.businessId ?? null}::uuid)
     ORDER BY r.attempted_at DESC
     LIMIT ${filter.limit ?? 50}`;
  return rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    attemptedAt: r.attempted_at.toISOString(),
    attemptedByName: r.attempted_by_name,
    holderName: r.holder_name,
    rail: r.rail,
    routingNumber: r.routing_number,
    accountNumberLast4: r.account_number_last4,
    code: r.code,
    reason: r.reason,
  }));
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export type SavedPayee = {
  readonly payeeId: string;
  readonly verificationId: string;
  readonly outcome: PayeeOutcome;
  /** False when the key already existed and this call wrote nothing new. */
  readonly created: boolean;
};

/**
 * Store a payee and its first check, in one transaction.
 *
 * A BLOCKED CHECK NEVER GETS PAST THE FIRST BRANCH. It becomes a
 * `payee_candidate_refusal` and an `Err`, and the caller is told which digits
 * were refused and why. The database would refuse the INSERT anyway — the
 * CHECK constraint is the thing that actually guarantees it — but a
 * constraint violation is a 23514 with a constraint name in it, and a person
 * filling in a form deserves the sentence instead.
 *
 * Replaying the same `payeeKey` returns the existing payee and writes no
 * second row. The UNIQUE index decides, not an `if`: the same construction
 * `requestPayment()` uses, for the same reason. Two copies of one supplier's
 * bank details is how a business ends up paying the stale one.
 */
export async function savePayee(
  input: {
    readonly candidate: PayeeCandidate;
    readonly check: PayeeCheck;
    readonly payeeKey: string;
    readonly actorId: string;
  },
  conn: Sql = sql,
): Promise<Result<SavedPayee>> {
  const { candidate, check, payeeKey, actorId } = input;

  if (check.decision === "blocked") {
    const blocking = check.findings.find((f) => f.severity === "block");
    await conn`
      INSERT INTO payee_candidate_refusal
        (business_id, attempted_by, holder_name, rail, routing_number,
         account_number_last4, code, reason, detail)
      VALUES
        (${candidate.businessId}::uuid,
         ${actorId}::uuid,
         ${candidate.holderName},
         ${candidate.rail}::rail,
         ${candidate.routingNumber ?? ""},
         ${candidate.accountNumberLast4 ?? null},
         ${blocking?.code ?? "ROUTING_CHECKSUM_FAILED"},
         ${blocking?.detail ?? "The routing number fails the ABA check digit."},
         ${conn.json({ findings: check.findings, nearMisses: check.nearMisses })})`;

    return fail(
      blocking?.code ?? "ROUTING_CHECKSUM_FAILED",
      blocking?.detail ?? "The routing number fails the ABA check digit.",
      { nearMisses: check.nearMisses },
    );
  }

  try {
    return await conn.begin(async (tx) => {
      const inserted = await tx<{ id: string }[]>`
        INSERT INTO payee
          (business_id, display_name, holder_name, rail,
           routing_number, account_number_last4, account_type,
           created_by, payee_key)
        VALUES
          (${candidate.businessId}::uuid,
           ${candidate.displayName},
           ${candidate.holderName},
           ${candidate.rail}::rail,
           ${check.routingNumber},
           ${candidate.accountNumberLast4 ?? null},
           ${candidate.accountType ?? null},
           ${actorId}::uuid,
           ${payeeKey})
        ON CONFLICT (payee_key) DO NOTHING
        RETURNING id`;

      const created = inserted[0];
      if (created === undefined) {
        const [existing] = await tx<{ id: string }[]>`
          SELECT id FROM payee WHERE payee_key = ${payeeKey}`;
        if (existing === undefined) {
          return fail("PAYEE_KEY_RACE", "The payee key conflicted but no payee could be read.");
        }
        // A replay writes no second payee. It DOES write a fresh
        // verification, because re-checking an existing payee is exactly the
        // thing the freshness bands exist to encourage, and refusing to
        // record today's check because the payee is old would be backwards.
        const verificationId = await insertVerification(tx as unknown as Sql, existing.id, check, actorId);
        return ok({
          payeeId: existing.id,
          verificationId,
          outcome: check.decision,
          created: false,
        });
      }

      const verificationId = await insertVerification(tx as unknown as Sql, created.id, check, actorId);
      return ok({
        payeeId: created.id,
        verificationId,
        outcome: check.decision,
        created: true,
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // `payee_routing_number_possible` firing here means a caller reached
    // savePayee with a blocked check it did not declare blocked. That is a
    // bug in the caller, and it deserves the constraint's name.
    return fail("PAYEE_REFUSED", `The payee could not be stored: ${message}`);
  }
}

/**
 * Append a check against an existing payee.
 *
 * Separate from `savePayee` because re-checking is the normal case: a payee
 * verified six months ago is not the same as one verified today, and the way
 * to make it today's is to append, never to update.
 */
export async function recordVerification(
  input: {
    readonly payeeId: string;
    readonly check: PayeeCheck;
    readonly actorId: string;
  },
  conn: Sql = sql,
): Promise<Result<{ readonly verificationId: string }>> {
  if (input.check.decision === "blocked") {
    return fail(
      "BLOCKED_CHECK_NOT_STORABLE",
      "A blocked check cannot be recorded against a stored payee: an impossible routing " +
        "number cannot be in the payee table in the first place.",
    );
  }
  try {
    const verificationId = await insertVerification(conn, input.payeeId, input.check, input.actorId);
    return ok({ verificationId });
  } catch (error) {
    return fail(
      "VERIFICATION_REFUSED",
      `The check could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function insertVerification(
  conn: Sql,
  payeeId: string,
  check: PayeeCheck,
  actorId: string,
): Promise<string> {
  const [row] = await conn<{ id: string }[]>`
    INSERT INTO payee_verification
      (payee_id, checked_by, outcome, checksum_ok, prefix_assigned,
       directory, directory_provider, institution_name,
       ach_supported, wire_supported,
       name_match, name_match_score, name_source, name_provider,
       counterparty_name, evidence, detail)
    VALUES
      (${payeeId}::uuid,
       ${actorId}::uuid,
       ${check.decision}::payee_verification_outcome,
       ${check.checksumOk},
       ${check.prefixAssigned},
       ${check.directory}::payee_directory_result,
       ${check.directoryProvider},
       ${check.institutionName},
       ${check.achSupported},
       ${check.wireSupported},
       ${check.name.outcome}::payee_name_match,
       ${check.name.score},
       ${check.name.source}::payee_name_source,
       ${check.name.provider},
       ${check.name.counterpartyName},
       ${check.evidence}::payee_check_evidence,
       ${conn.json({ findings: check.findings, nameExplanation: check.name.explanation })})
    RETURNING id`;
  if (row === undefined) throw new Error("payee_verification INSERT returned no row");
  return row.id;
}

/**
 * Sign for a warning.
 *
 * The database refuses this against a check that was not `warned` — see
 * `assert_payee_acknowledgement_answers_a_warning()` — so the readable
 * message here is a courtesy in front of a guarantee, not the guarantee.
 */
export async function acknowledgeWarning(
  input: {
    readonly verificationId: string;
    readonly actorId: string;
    readonly reason: string;
  },
  conn: Sql = sql,
): Promise<Result<{ readonly acknowledgementId: string }>> {
  if (input.reason.trim().length === 0) {
    return fail(
      "ACKNOWLEDGEMENT_NEEDS_A_REASON",
      "Proceeding past a payee warning needs a sentence saying why. That sentence is the " +
        "whole reason the warning is allowed to be a warning.",
    );
  }
  try {
    const [row] = await conn<{ id: string }[]>`
      INSERT INTO payee_acknowledgement (verification_id, acknowledged_by, reason)
      VALUES (${input.verificationId}::uuid, ${input.actorId}::uuid, ${input.reason})
      ON CONFLICT (verification_id, acknowledged_by) DO NOTHING
      RETURNING id`;
    if (row === undefined) {
      const [existing] = await conn<{ id: string }[]>`
        SELECT id FROM payee_acknowledgement
         WHERE verification_id = ${input.verificationId}::uuid
           AND acknowledged_by = ${input.actorId}::uuid`;
      if (existing === undefined) {
        return fail("ACKNOWLEDGEMENT_RACE", "The acknowledgement conflicted but none was found.");
      }
      return ok({ acknowledgementId: existing.id });
    }
    return ok({ acknowledgementId: row.id });
  } catch (error) {
    return fail(
      "ACKNOWLEDGEMENT_REFUSED",
      `The acknowledgement was refused: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Remove a payee by appending, never by deleting. */
export async function archivePayee(
  input: {
    readonly payeeId: string;
    readonly actorId: string;
    readonly reason: string;
  },
  conn: Sql = sql,
): Promise<Result<{ readonly archived: true }>> {
  try {
    await conn`
      INSERT INTO payee_archival (payee_id, archived_by, reason)
      VALUES (${input.payeeId}::uuid, ${input.actorId}::uuid, ${input.reason})
      ON CONFLICT (payee_id) DO NOTHING`;
    return ok({ archived: true });
  } catch (error) {
    return fail(
      "ARCHIVAL_REFUSED",
      `The payee could not be archived: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The database's own copy of the check digit.
 *
 * Exists so `payees.integration.test.ts` can hold the TypeScript and the SQL
 * implementations equal over a corpus instead of trusting that two copies of
 * one rule stayed in step. That test is the only reason to call it.
 */
export async function abaChecksumOkInDatabase(
  routingNumber: string,
  conn: Sql = sql,
): Promise<boolean> {
  const [row] = await conn<{ ok: boolean }[]>`
    SELECT aba_checksum_ok(${routingNumber}) AS ok`;
  return row?.ok ?? false;
}

/**
 * The same, for a whole corpus, in one round trip.
 *
 * The equality test wants three hundred answers and three hundred network
 * round trips to Neon is twenty seconds of a test suite that has a budget.
 * `unnest` turns it into one.
 */
export async function abaChecksumOkInDatabaseBatch(
  routingNumbers: readonly string[],
  conn: Sql = sql,
): Promise<ReadonlyMap<string, boolean>> {
  const rows = await conn<{ rn: string; ok: boolean }[]>`
    SELECT rn, aba_checksum_ok(rn) AS ok
      FROM unnest(${conn.array([...routingNumbers])}::text[]) AS rn`;
  return new Map(rows.map((r) => [r.rn, r.ok]));
}
