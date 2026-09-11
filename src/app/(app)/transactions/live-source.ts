import "server-only";

/**
 * The live reads behind `/transactions`.
 *
 * ===========================================================================
 * WHY THIS LIVES UNDER `src/app/` AND NOT UNDER `src/lib/`
 * ===========================================================================
 *
 * The same reason `statements/live-source.ts`, `funding/live-source.ts` and
 * `payments/live-source.ts` do: those `src/lib/` modules belong to other
 * workers on this build, and a screen's own composition layer has no business
 * being a shared module anyway.
 *
 * It therefore writes NO SQL of its own. Every read is a named reader out of
 * `src/lib/ledger/**` or a function in `src/lib/timetravel/**` that composes
 * them. That is what keeps `src/lib/ledger/boundary.test.ts` green, and it is
 * also what stops this file becoming a fifth definition of a balance — which
 * is a thing that has already happened to this system once, and cost $25,040.70
 * of disagreement between two screens.
 */

import { ledgerConnection, listDepositAccounts } from "@/lib/ledger/queries";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";
import { correctionLandmarks } from "@/lib/timetravel/landmarks";
import { NoSuchAccountError, readAccountAtPoint, foldClosing } from "@/lib/timetravel/read";
import type { TimePoint } from "@/lib/timetravel/point";
import type { Window } from "@/lib/timetravel/read";
import type {
  AccountOption,
  PostingRow,
  TransactionsView,
} from "@/components/timetravel/contract";

/*
 * THE PREDICATE THAT USED TO LIVE HERE IS GONE ON PURPOSE.
 *
 * `export function hasDatabase()` sat at this line, inside a module that opens
 * a connection, and `page.tsx` reached it with
 * `const { hasDatabase } = await import("./live-source")`. That import only
 * succeeds when a database IS configured, so the predicate could only ever
 * return true to the caller that needed a false — the defect this console
 * carried on eight screens.
 *
 * The page now asks `@/lib/has-database`, which imports nothing, and this copy
 * had no importers left. It is deleted rather than left as dead code because a
 * predicate named `hasDatabase` living in a live module is the attractor that
 * produced the shape in the first place: the next person to need the question
 * answered finds it here, one `await import` away, and writes the bug again.
 */

function readFailure(where: string, thrown: unknown): Result<never, ErrorShape> {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return fail("LEDGER_READ_FAILED", `${where} could not be read: ${message.slice(0, 220)}`, {
    retryable: true,
    source: `timetravel.${where}`,
  });
}

/**
 * The whole screen, for one account, at one point.
 *
 * `accountId` is a REFERENCE out of the query string and is never trusted for
 * anything but selection: it is matched against the list this function just
 * read, and an id that is not in that list falls back to the busiest deposit
 * account rather than reaching a query. That is the same rule the accounts
 * console applies, and it is the reason a malformed `?account=` cannot become
 * a database error.
 */
export async function loadTransactions(args: {
  readonly accountId: string | null;
  readonly window: Window;
  readonly point: TimePoint;
}): Promise<Result<TransactionsView, ErrorShape>> {
  try {
    const conn = await ledgerConnection();

    const deposits = await listDepositAccounts(conn);
    const accounts: readonly AccountOption[] = deposits.map((row) => ({
      accountId: row.accountId,
      accountName: row.accountName,
      legalName: row.legalName,
    }));

    const chosen =
      (args.accountId === null
        ? undefined
        : deposits.find((row) => row.accountId === args.accountId)) ?? deposits[0];

    if (chosen === undefined) {
      return fail(
        "NO_ACCOUNTS",
        "No customer deposit account has been opened, so there is nothing to read at any point in time. A business gets its 2100 account when KYB approves it, and not before.",
        { retryable: false, source: "timetravel.transactions" },
      );
    }

    const at = await readAccountAtPoint(
      { accountId: chosen.accountId, point: args.point, window: args.window },
      conn,
    );

    const landmarks = await correctionLandmarks({ accountId: chosen.accountId }, conn);

    // The running balance is folded HERE, from the opening figure the reader
    // is shown, so the column somebody adds up by eye is the same arithmetic
    // the headline claims. A second SUM in SQL would be a second definition.
    let running = at.period.openingBalanceCents;
    const postings: PostingRow[] = at.period.lines.map((line) => {
      running += line.signedCents;
      return { line, runningCents: running, late: false };
    });

    const closingCents = foldClosing(at.period);

    return ok({
      source: "live",
      point: args.point,
      window: args.window,
      accounts,
      account: at.account,
      from: at.from,
      to: at.to,
      openingCents: at.period.openingBalanceCents,
      postings,
      closingCents,
      closingNowCents: at.closingNowCents,
      deltaCents: at.closingNowCents - closingCents,
      late: at.late,
      lateNetCents: at.lateNetCents,
      explained: at.explained,
      pending: at.pending,
      availability: at.availability,
      landmarks,
    });
  } catch (thrown) {
    if (thrown instanceof NoSuchAccountError) {
      return fail(
        "NO_SUCH_ACCOUNT",
        "That account id does not name an account on this book. 'No postings' and 'no such account' are different answers and this screen will not render the second as the first.",
        { retryable: false, source: "timetravel.transactions" },
      );
    }
    return readFailure("transactions", thrown);
  }
}
