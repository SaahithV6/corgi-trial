/**
 * ============================================================================
 * APPROVAL OPENS THE ACCOUNT.
 * ============================================================================
 *
 * The brief's core loop begins "open an account behind a real KYB check". The
 * check was real long before this module existed; the OPENING was not. Until
 * now the only thing that had ever created a customer's deposit leaf was
 * `scripts/seed.mjs`, gated on a hardcoded `opensAccounts: true` against one
 * fixture business — so two of the three demo businesses could not hold money,
 * and no amount of passing KYB would have changed that, because approval was
 * wired to nothing.
 *
 * This module is that wire. `db/migrations/0021_open_accounts.sql` is the other
 * half and the load-bearing half; read its header first.
 *
 * ----------------------------------------------------------------------------
 * IT IS A CONSEQUENCE, NOT A BUTTON.
 * ----------------------------------------------------------------------------
 *
 * `openAccountsOnApproval()` is called after EVERY write to
 * `kyb_verification_leg` that the console can perform — begin, refresh,
 * recheck, and the operator's own review — and it decides for itself whether
 * anything should happen. There is no "open accounts" control anywhere in this
 * product, and that is a design position rather than an omission:
 *
 *   An operator who has to remember a second step will one day not remember
 *   it, and the failure is silent. The business reads `approved` on the
 *   screen, `canTransact()` says yes, and the money arrives to find nowhere to
 *   land — which in this ledger means 2400 suspense and a reconciliation break
 *   nobody can explain from the KYB screen.
 *
 * Because the call is unconditional it must be cheap and safe when nothing has
 * changed, and it is: for a business that is not approved it makes one SELECT
 * and returns `not_yet`, and for one whose accounts are already open the
 * database does three no-op inserts. Idempotence is not a nicety here, it is
 * what permits the call site to be dumb.
 *
 * ----------------------------------------------------------------------------
 * THIS FILE IS NOT WHERE "APPROVED ONLY" IS ENFORCED.
 * ----------------------------------------------------------------------------
 *
 * It reads `v_business_kyb` before calling, and that read is a COURTESY — it
 * exists so the screen can say "still needs_review" instead of rendering a
 * database exception. Delete it and nothing about what the database permits
 * changes, because `business_accounts_open()` reads the same view inside its
 * own body and `corgi_app` holds no `INSERT` on `account` to route around it
 * with. The enforcement is a privilege boundary plus a check the caller cannot
 * assert past; this is a message.
 *
 * ----------------------------------------------------------------------------
 * NOTHING HERE POSTS TO THE JOURNAL.
 * ----------------------------------------------------------------------------
 *
 * Opening an account is not a money event. There is no opening entry, no zero
 * line, no balance written anywhere: an account with no `journal_line` rows has
 * a balance of zero by construction, which is the entire reason this system
 * derives balances instead of storing them. `postEntry` is not imported and
 * must not be.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { readAccountIdentities } from "@/lib/ledger/queries";
import { rootLogger, type Logger } from "@/lib/log";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import {
  OPEN_REFUSAL,
  type OpenAccountsOutcome,
  type OpenedAccount,
  type OpenRefusalCode,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Reading the gate                                                           */
/* -------------------------------------------------------------------------- */

type KybRow = { readonly kyb_status: string; readonly legs_on_file: string | number };

/**
 * The derived KYB status, straight from the view.
 *
 * Not `businessKybState()` from `src/lib/kyb/wire.ts`, deliberately: that
 * function parses the row into a validated `BusinessKybState` and returns
 * `null` on a shape it cannot read, which is exactly right for a gate that
 * decides whether money may move and wrong for this one. Here an unreadable
 * row must NOT silently become "not approved and therefore fine"; it must reach
 * `business_accounts_open()`, which will refuse it in SQL with a message naming
 * what it actually saw. So this reads the one column it needs and forms no
 * opinion about the rest.
 */
async function derivedStatus(businessId: string, conn: Sql): Promise<string | null> {
  const rows = await conn<KybRow[]>`
    SELECT kyb_status::text AS kyb_status, legs_on_file
      FROM v_business_kyb
     WHERE business_id = ${businessId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : row.kyb_status;
}

/* -------------------------------------------------------------------------- */
/* Opening                                                                    */
/* -------------------------------------------------------------------------- */

type OpenRow = {
  readonly rollup_code: string;
  readonly account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  readonly opened: boolean;
};

/**
 * Map a database refusal onto a code the screen can branch on.
 *
 * BY SQLSTATE, never by message text. 0021 raises `42501` for both refusals it
 * can make — the business is not approved, and the actor is an agent — because
 * both are "you may not", and they are told apart by the only other thing the
 * caller already knows: whether the status it just read was `approved`.
 */
function refusalFor(code: string | undefined, statusWasApproved: boolean): OpenRefusalCode {
  if (code === "42501") {
    return statusWasApproved ? OPEN_REFUSAL.ACTOR_MAY_NOT_OPEN : OPEN_REFUSAL.KYB_NOT_APPROVED;
  }
  if (code === "23503") return OPEN_REFUSAL.NOTHING_TO_OPEN;
  return OPEN_REFUSAL.ACCOUNT_OPEN_FAILED;
}

function databaseCode(thrown: unknown): string | undefined {
  if (typeof thrown === "object" && thrown !== null && "code" in thrown) {
    const code = (thrown as { code: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function databaseMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/**
 * Open a business's chart of accounts. The unconditional form: it calls the
 * database whatever the KYB state is, and lets the database refuse.
 *
 * Use `openAccountsOnApproval()` at a call site that runs after every KYB
 * write; use this one where "not approved" genuinely is an error to report.
 */
export async function openBusinessAccounts(
  businessId: string,
  actorId: string,
  options: { readonly conn?: Sql; readonly log?: Logger } = {},
): Promise<Result<OpenAccountsOutcome, ErrorShape>> {
  const conn = options.conn ?? sql;
  const log = (options.log ?? rootLogger).child({ businessId });
  return openWithStatus(businessId, actorId, await derivedStatus(businessId, conn), conn, log);
}

/**
 * The body of both entry points, taking the KYB status the caller already read.
 *
 * Threaded rather than re-read so that `openAccountsOnApproval()` makes ONE
 * round trip for the gate and not two. The status is used for exactly one
 * thing — telling 0021's two `42501` refusals apart — and never to decide
 * whether to call; that decision belongs to the database.
 */
async function openWithStatus(
  businessId: string,
  actorId: string,
  status: string | null,
  conn: Sql,
  log: Logger,
): Promise<Result<OpenAccountsOutcome, ErrorShape>> {
  let rows: readonly OpenRow[];
  try {
    rows = await conn<OpenRow[]>`
      SELECT rollup_code, account_id, account_code, account_name, opened
        FROM business_accounts_open(${businessId}::uuid, ${actorId}::uuid)`;
  } catch (thrown) {
    const code = refusalFor(databaseCode(thrown), status === "approved");
    const message = databaseMessage(thrown);
    log.warn("accounts.open.refused", { code, sqlstate: databaseCode(thrown) ?? null, status });
    return fail(
      code,
      code === OPEN_REFUSAL.KYB_NOT_APPROVED
        ? `No account was opened: ${message} The check is inside business_accounts_open(), which reads v_business_kyb itself — there is no argument a caller can pass to assert an approval it does not have.`
        : `No account was opened. ${message}`,
    );
  }

  const accounts: readonly OpenedAccount[] = rows.map((row) => ({
    rollupCode: row.rollup_code,
    accountId: row.account_id,
    code: row.account_code,
    name: row.account_name,
    opened: row.opened,
  }));

  const deposit = accounts.find((account) => account.rollupCode === "2100");
  if (deposit === undefined) {
    // Unreachable while `per_business_rollup` holds 2100, and loud rather than
    // silent if that ever stops being true: a business whose chart opened
    // without a deposit leaf has nowhere for money to land, and returning `ok`
    // would be this module claiming otherwise.
    return fail(
      OPEN_REFUSAL.ACCOUNT_OPEN_FAILED,
      "business_accounts_open() returned no 2100 deposit leaf. The chart of accounts opened without the account money lands in, which is not a state this system has a meaning for.",
    );
  }

  const openedNow = accounts.filter((account) => account.opened);
  if (openedNow.length > 0) {
    log.info("accounts.opened", {
      actorId,
      opened: openedNow.map((account) => account.rollupCode),
      depositAccountId: deposit.accountId,
    });
  }

  return ok({
    kind: openedNow.length > 0 ? "opened" : "already",
    businessId,
    accounts,
    depositAccountId: deposit.accountId,
  });
}

/**
 * THE CONSEQUENCE HOOK. Call this after any write to `kyb_verification_leg`.
 *
 * Returns `not_yet` rather than a failure when the business is not approved,
 * because at this call site that is not a failure — it is the overwhelmingly
 * common case, and an error return would push every caller into writing the
 * same `if (code === 'KYB_NOT_APPROVED') ignore` branch, which is how a real
 * refusal eventually gets ignored along with it.
 *
 * NEVER THROWS. A KYB observation has already been appended by the time this
 * runs, and that row is the compliance record; losing it to an exception from
 * the account machinery would be the tail wagging the dog. A failure here is
 * returned, logged, and shown on the screen, and the business sits in
 * `v_approved_without_accounts` until somebody presses anything on the
 * onboarding screen again — which is safe, because this is idempotent.
 */
export async function openAccountsOnApproval(
  businessId: string,
  actorId: string,
  options: { readonly conn?: Sql; readonly log?: Logger } = {},
): Promise<Result<OpenAccountsOutcome, ErrorShape>> {
  const conn = options.conn ?? sql;
  const log = (options.log ?? rootLogger).child({ businessId });

  let status: string | null;
  try {
    status = await derivedStatus(businessId, conn);
  } catch (thrown) {
    log.warn("accounts.open.state_unreadable", { error: databaseMessage(thrown) });
    return fail(
      OPEN_REFUSAL.ACCOUNT_OPEN_FAILED,
      "The KYB state could not be read, so no account was opened. The verification itself is recorded — that row is append-only and is not affected by this.",
    );
  }

  if (status !== "approved") {
    return ok({
      kind: "not_yet",
      businessId,
      status: status ?? "unknown",
      accounts: [],
    });
  }

  return openWithStatus(businessId, actorId, status, conn, log);
}

/* -------------------------------------------------------------------------- */
/* Reading what was opened                                                    */
/* -------------------------------------------------------------------------- */

export type AccountOpeningRow = {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly openedAt: string;
  readonly openedBy: string;
  readonly kybStatus: string;
  readonly kybEvidence: string;
};

/**
 * The provenance rows for a business: which approval opened which account.
 *
 * Read-only, and there is no writer for it outside `business_accounts_open()`.
 * A row here can only say `approved` — 0021 puts that in a CHECK — so the
 * question "was this account opened behind a passing check?" is answered by
 * the row EXISTING, never by reading its contents.
 */
export async function accountOpenings(
  businessId: string,
  conn: Sql = sql,
): Promise<readonly AccountOpeningRow[]> {
  const rows = await conn<
    {
      account_id: string;
      code: string;
      name: string;
      opened_at: Date;
      opened_by: string;
      kyb_status: string;
      kyb_evidence: string;
    }[]
  >`
    SELECT o.account_id, o.opened_at,
           COALESCE(act.display_name, o.opened_by::text) AS opened_by,
           o.kyb_status::text   AS kyb_status,
           o.kyb_evidence::text AS kyb_evidence
      FROM account_opening o
      LEFT JOIN actor act ON act.id = o.opened_by
     WHERE o.business_id = ${businessId}::uuid
     ORDER BY o.opened_at, o.account_id`;

  // `code` and `name` are the ledger's columns; the join that used to fetch
  // them was also the ORDER BY's second key. It is `o.account_id` now, and the
  // rows are re-sorted by `(opened_at, code)` below — in that order, and with
  // the codes in hand — so the list a caller sees is unchanged.
  const accounts = await readAccountIdentities(
    rows.map((r) => r.account_id),
    conn,
  );
  // The join was INNER: an opening whose account has gone was not a row.
  const present = rows.filter((r) => accounts.has(r.account_id));
  present.sort((x, y) => {
    const byTime = x.opened_at.getTime() - y.opened_at.getTime();
    if (byTime !== 0) return byTime;
    const xc = accounts.get(x.account_id)?.code ?? "";
    const yc = accounts.get(y.account_id)?.code ?? "";
    return xc < yc ? -1 : xc > yc ? 1 : 0;
  });

  return present.map((row) => ({
    accountId: row.account_id,
    code: accounts.get(row.account_id)?.code ?? "",
    name: accounts.get(row.account_id)?.name ?? "",
    openedAt: row.opened_at.toISOString(),
    openedBy: row.opened_by,
    kybStatus: row.kyb_status,
    kybEvidence: row.kyb_evidence,
  }));
}
