/**
 * ============================================================================
 * APPLYING IS NOT OPENING.
 * ============================================================================
 *
 * `./open.ts` is the consequence of a passing check. This module is the step
 * BEFORE the check exists to pass: a business that is not on the book at all
 * becomes an APPLICANT — one `business` row, its directors as `actor` rows,
 * and a `business_application` recording what was claimed.
 *
 * `db/migrations/0065_business_apply.sql` is the other half and the
 * load-bearing half; read its header first. The one-line version: `corgi_app`
 * holds SELECT and only SELECT on `business` and `actor`
 * (`db/migrations/0001_ledger.sql:839`), so this file cannot and does not
 * contain an INSERT. It calls one SECURITY DEFINER function and reports what
 * it said.
 *
 * ----------------------------------------------------------------------------
 * THIS FILE IS NOT WHERE "CANNOT SELF-APPROVE" IS ENFORCED.
 * ----------------------------------------------------------------------------
 *
 * There is no status in the call below because there is no status in the
 * function's argument list — 0065 §10.3 asserts that against `pg_proc` at
 * migration time, so it is a property of the database and not a habit of this
 * module. Delete every line here and an applicant still cannot reach
 * `v_business_kyb`: the legs are written afterwards by the live provider
 * adapters in `src/lib/kyb/wire.ts`, and the composite folds the WEAKEST leg,
 * so a freshly created Stripe Identity session (`requires_input` → `pending`)
 * holds the whole application down however well the register answers.
 *
 * ----------------------------------------------------------------------------
 * NOTHING HERE OPENS AN ACCOUNT.
 * ----------------------------------------------------------------------------
 *
 * `openBusinessAccounts()` is deliberately not imported. An applicant has no
 * `2100` leaf, which is the sentence `src/components/client/contract.ts`
 * models, and the way to make that true is to have no code path that could
 * make it false.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { rootLogger, type Logger } from "@/lib/log";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import { APPLY_REFUSAL, type ApplicantOutcome, type ApplyRefusalCode, type DirectorClaim } from "./types";

/** What an applicant typed. Every field is a claim; none is treated as a fact. */
export type ApplicationClaim = {
  readonly legalName: string;
  readonly ein: string;
  readonly registeredAddress: {
    readonly street1: string;
    readonly city: string;
    readonly subdivision: string;
    readonly postalCode: string;
  };
  /** `null` when the applicant asserted no Legal Entity Identifier. */
  readonly lei: string | null;
  readonly directors: readonly DirectorClaim[];
};

type ApplyRow = {
  readonly business_id: string;
  readonly application_id: string;
  readonly created: boolean;
  readonly state: string;
  readonly directors_on_file: string | number;
};

function databaseCode(thrown: unknown): string | undefined {
  if (typeof thrown === "object" && thrown !== null && "code" in thrown) {
    const code = (thrown as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * Map 0065's refusals onto codes the screen can branch on — BY SQLSTATE, never
 * by message text, for `./types.ts`'s reason: a refusal identified by string
 * matching is one rewording away from being reclassified as an unknown
 * failure.
 */
function refusalFor(sqlstate: string | undefined): ApplyRefusalCode {
  if (sqlstate === "42501") return APPLY_REFUSAL.EIN_ALREADY_ON_BOOK;
  if (sqlstate === "22023") return APPLY_REFUSAL.APPLICATION_INVALID;
  if (sqlstate === "23503") return APPLY_REFUSAL.NOTHING_TO_APPLY_TO;
  if (sqlstate === "40001") return APPLY_REFUSAL.APPLICATION_RACED;
  return APPLY_REFUSAL.APPLICATION_FAILED;
}

/**
 * File an application. One round trip, one function, one act.
 *
 * Idempotent on the normalised EIN: a second submission returns the first
 * applicant with `created: false`, which is a more useful answer than "no
 * error" and is what lets the caller keep its response identical between a
 * first application and a repeat.
 */
export async function applyForAccount(
  claim: ApplicationClaim,
  options: { readonly conn?: Sql; readonly log?: Logger } = {},
): Promise<Result<ApplicantOutcome, ErrorShape>> {
  const conn = options.conn ?? sql;
  const log = options.log ?? rootLogger;

  // The directors are passed as one jsonb value rather than as parallel
  // arrays: the function validates each element itself, and a name/email pair
  // that travelled together cannot be mispaired on the way in.
  //
  // NOTE THE `::text::jsonb` IN THE CALL BELOW, which is not decoration.
  // postgres.js inspects the parameter's target type, and for a `::jsonb`
  // parameter it JSON-ENCODES the JavaScript value it was given — so a string
  // that is already JSON arrives double-encoded and `jsonb_typeof()` reads
  // `string` rather than `object`. Measured: the first run of this module was
  // refused by 0065 with "a registered address object is required", which is
  // the function catching it. Binding as text and parsing in SQL sends the
  // bytes that were meant.
  const directors = claim.directors.map((director) => ({
    fullName: director.fullName,
    email: director.email,
  }));

  let rows: readonly ApplyRow[];
  try {
    rows = await conn<ApplyRow[]>`
      SELECT business_id, application_id, created, state, directors_on_file
        FROM business_apply(
               ${claim.legalName},
               ${claim.ein},
               ${JSON.stringify(claim.registeredAddress)}::text::jsonb,
               ${claim.lei},
               ${JSON.stringify(directors)}::text::jsonb,
               NULL)`;
  } catch (thrown) {
    const sqlstate = databaseCode(thrown);
    const code = refusalFor(sqlstate);
    // The EIN, the address and the directors are absent from this log line on
    // purpose, exactly as they are absent from the action's. What is worth
    // knowing is that an application was refused and by which rule.
    log.warn("applicant.refused", { code, sqlstate: sqlstate ?? null });
    return fail(code, thrown instanceof Error ? thrown.message : String(thrown));
  }

  const row = rows[0];
  if (row === undefined) {
    return fail(
      APPLY_REFUSAL.APPLICATION_FAILED,
      "business_apply() returned no row. Nothing can be said about an application that produced no answer, and this module does not guess at one.",
    );
  }

  // Restated here rather than trusted: 0065's CHECK makes any other value
  // unrepresentable, so reaching this branch means the constraint is gone.
  if (row.state !== "pending") {
    return fail(
      APPLY_REFUSAL.APPLICATION_FAILED,
      `business_apply() returned state '${row.state}'. An application can only ever be pending — a row saying otherwise means business_application_never_approved is no longer on the table.`,
    );
  }

  const outcome: ApplicantOutcome = {
    businessId: row.business_id,
    applicationId: row.application_id,
    created: row.created,
    directorsOnFile: Number(row.directors_on_file),
  };
  log.info("applicant.filed", {
    businessId: outcome.businessId,
    created: outcome.created,
    directors: outcome.directorsOnFile,
  });
  return ok(outcome);
}

/** Where an application got to, straight from `v_business_application`. */
export type ApplicationRow = {
  readonly applicationId: string;
  readonly businessId: string;
  readonly legalName: string;
  readonly state: string;
  readonly kybStatus: string | null;
  readonly legsOnFile: number;
  readonly hasDepositAccount: boolean;
};

type ApplicationViewRow = {
  readonly application_id: string;
  readonly business_id: string;
  readonly legal_name: string;
  readonly application_state: string;
  readonly kyb_status: string | null;
  readonly legs_on_file: string | number | null;
  readonly has_deposit_account: boolean;
};

/**
 * Read one applicant's own state back.
 *
 * BY `business_id` AND NEVER BY EIN. An EIN lookup is an oracle — type a
 * competitor's EIN, learn whether they bank here — and `/client/open`'s page
 * header says so in as many words. The id is something the caller was just
 * handed for the application it just filed.
 */
export async function applicationState(
  businessId: string,
  options: { readonly conn?: Sql } = {},
): Promise<ApplicationRow | null> {
  const conn = options.conn ?? sql;
  const rows = await conn<ApplicationViewRow[]>`
    SELECT application_id, business_id, legal_name, application_state,
           kyb_status::text AS kyb_status, legs_on_file, has_deposit_account
      FROM v_business_application
     WHERE business_id = ${businessId}::uuid`;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    applicationId: row.application_id,
    businessId: row.business_id,
    legalName: row.legal_name,
    state: row.application_state,
    kybStatus: row.kyb_status,
    legsOnFile: Number(row.legs_on_file ?? 0),
    hasDepositAccount: row.has_deposit_account,
  };
}
