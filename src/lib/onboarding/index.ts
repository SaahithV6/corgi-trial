/**
 * Account opening — the consequence of a passing KYB check.
 *
 * The module boundary is small on purpose. Everything that decides WHETHER an
 * account may open lives in `db/migrations/0021_open_accounts.sql`; everything
 * here is about saying what happened.
 */

export {
  accountOpenings,
  openAccountsOnApproval,
  openBusinessAccounts,
  type AccountOpeningRow,
} from "./open";

export {
  applicationState,
  applyForAccount,
  type ApplicationClaim,
  type ApplicationRow,
} from "./apply";

export {
  APPLY_REFUSAL,
  leafNameSuffix,
  OPEN_REFUSAL,
  PER_BUSINESS_ROLLUPS,
  type OpenAccountsOutcome,
  type OpenedAccount,
  type OpenRefusalCode,
  type ApplicantOutcome,
  type ApplyRefusalCode,
  type DirectorClaim,
} from "./types";
