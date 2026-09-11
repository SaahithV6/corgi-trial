/**
 * What the card & hold console answers with on a deployment that has no
 * database.
 *
 * ============================================================================
 * THIS FILE IS NOT A FIXTURE, AND IT IS DELIBERATELY NOT IN `./fixtures.ts`.
 * ============================================================================
 *
 * A fixture is a drawing of a book. This is a refusal to draw one. `/accounts`
 * had no branch for "there is no database" at all — it could not have had one,
 * because the page module never finished loading: `./actions`, `./live-source`,
 * `./fixtures` and `CardControlsPanel` each reach `@/lib/ledger/db`, which
 * value-imports `@/lib/env`, which parses `process.env` at module scope and
 * throws `EnvironmentError` without `APP_DATABASE_URL`. Four static chains,
 * one of them through the fixtures, so even the drawn states died. The
 * operator got the framework's error page and no sentence about what was
 * wrong.
 *
 * WHAT THE SCREEN MUST NOT DO INSTEAD. Every panel on this console counts
 * something: cards registered, holds still withholding money, cards judged
 * against a control, deposit accounts on the book. Each of those figures is a
 * number an operator reads as a statement about a book. From an unread book
 * they are not small numbers, they are absent ones — "0 holds" is the sentence
 * "nothing is being withheld", and this deployment cannot say that. So the
 * console, the directory and the control panel are all replaced by the refusal
 * rather than being drawn empty.
 *
 * `retryable: false` because it is true: a refresh does not configure a
 * database, and every panel on this screen now drops its retry control when a
 * failure says so.
 */

import { fail, type ErrorShape, type Result } from "@/lib/result";

import type { HoldDetail } from "./contract";
// TYPE-ONLY. `./live-source` value-imports `@/lib/ledger/balances` -> `db` ->
// `env`, which throws without `APP_DATABASE_URL`; the type is erased and
// evaluates nothing, which is the whole reason this refusal can be reached.
import type { ConsoleData } from "./live-source";

/**
 * The console, the deposit directory and the card-control panel.
 *
 * One shape for all three because one condition explains all three, and three
 * differently-worded refusals on one screen would read as three different
 * problems.
 */
export const ACCOUNTS_NO_DATABASE: ErrorShape = {
  code: "ACCOUNTS_NO_DATABASE",
  message:
    "No database is configured for this deployment, so no business, no card, no hold, no balance and no control version was read. Nothing on this screen is a statement about a book. An empty holds table here does not mean nothing is being withheld, and an empty card list does not mean no card was issued.",
  details: {
    retryable: false,
    source: "accounts.console",
    operation: "the card and hold console",
  },
};

/** The hold drill-down, which reads one hold's event set and folds it. */
export const HOLD_NO_DATABASE: ErrorShape = {
  code: "HOLD_NO_DATABASE",
  message:
    "No database is configured for this deployment, so this hold's event set was not read and H(E) was not folded. This is not the statement that there is no such hold — that answer needs a book to look in.",
  details: {
    retryable: false,
    source: "accounts.hold",
    operation: "the hold drill-down",
  },
};

/**
 * The console's answer when there is nothing to read.
 *
 * A `Result` in the shape `loadConsole()` returns, so the refusal arrives
 * through the same channel as a failed read: one component renders the
 * console, one component renders the failure, and there is no second path on
 * which this screen could be drawn from nothing.
 */
export function unreadableConsole(
  error: ErrorShape = ACCOUNTS_NO_DATABASE,
): Result<ConsoleData, ErrorShape> {
  return fail(error.code, error.message, error.details);
}

/** The same, in the shape `loadHoldDetail()` returns. */
export function unreadableHoldDetail(
  error: ErrorShape = HOLD_NO_DATABASE,
): Result<HoldDetail | null, ErrorShape> {
  return fail(error.code, error.message, error.details);
}
