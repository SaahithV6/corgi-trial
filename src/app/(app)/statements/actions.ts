"use server";

/**
 * Generate the statement PDF, from the ledger, on demand.
 *
 * ===========================================================================
 * WHY AN ACTION AND NOT A `route.ts`
 * ===========================================================================
 *
 * A `GET /statements/document.pdf` would be the nicer artefact — a link you
 * can forward, a URL you can `curl` twice and diff. It is not what this build
 * gets, and the reason is worth writing down rather than leaving as a shrug.
 *
 * `src/components/home/ScreenLinks.test.ts` walks `src/app` and asserts that
 * EVERY route this build serves is either named on the front door or written
 * down as deliberately absent, with a reason. That test exists because a
 * previous version of the front door claimed to list every screen while
 * listing six of thirteen, and `/funding` — leg two of the core loop — was
 * unreachable from the only URL in the submission email. A new route handler
 * under `/statements/` therefore fails that test until somebody decides where
 * it belongs, and the decision has to be recorded in
 * `src/components/home/ScreenLinks.tsx`, which this worker does not own.
 *
 * Taking the loophole — naming the file `route.tsx` so the walker misses it,
 * or hiding it under a group directory — would be defeating a completeness
 * test on purpose, which is a worse thing to have in the repository than a
 * slightly less convenient download. So the document is produced by an action
 * instead, which adds no route, breaks no test, and still hands the reader the
 * only thing that actually matters: a PDF file they can attach to an email.
 *
 * If the route is wanted later it is four lines of handler around
 * `renderStatementPdf` plus one entry on the front door.
 *
 * ===========================================================================
 * IT READS THE SAME WAY THE SCREEN DOES
 * ===========================================================================
 *
 * Through `loadStatementsScreen` — the same loader, resolving the same
 * account, the same value date and the same anchor from the same query shape.
 * There is no second definition of either closing balance, and no second
 * answer to "which day is this". Open the screen and take the document and you
 * have the same two figures at the same two watermarks, by construction.
 *
 * IT WRITES NOTHING. Rendering a statement is a query (see the note at the top
 * of `src/lib/statements/read.ts`); publishing one is a different operation in
 * a different module that takes an actor. Downloading a document must never
 * issue one.
 */

import type { BelievedAnchor } from "@/components/statements/data-contract";
import { isErr } from "@/lib/result";
import {
  documentFingerprint,
  renderStatementPdf,
  statementPdfFilename,
  type StatementPdfInput,
} from "@/lib/statements/pdf";

import { hasDatabase, loadStatementsScreen } from "./live-source";

import { assertOperatorAction } from "@/lib/authz/action-guard";

export type StatementPdfRequest = {
  readonly accountId?: string | undefined;
  readonly businessDate?: string | undefined;
  readonly version?: number | undefined;
  readonly anchor?: BelievedAnchor | undefined;
};

/**
 * The document, or the reason there is not one.
 *
 * The bytes cross to the client as base64 because a server action's return
 * value is serialised into the RSC payload, and a statement is a few tens of
 * kilobytes — small enough that the encoding overhead is irrelevant and large
 * enough that it is worth saying so. A failure is a VALUE, like everywhere
 * else in this console: the panel renders the reason rather than a boundary
 * swallowing it.
 */
export type StatementPdfResult =
  | {
      readonly ok: true;
      readonly filename: string;
      /** The account the screen resolved to. Echoed so a caller can re-read it. */
      readonly accountId: string;
      readonly base64: string;
      readonly byteLength: number;
      /** sha256 over the two readings and the watermarks they were taken at. */
      readonly fingerprint: string;
      readonly valueDate: string;
      readonly believedWatermark: number;
      readonly correctedWatermark: number;
    }
  | { readonly ok: false; readonly message: string };

export async function statementPdfAction(
  request: StatementPdfRequest,
): Promise<StatementPdfResult> {
  await assertOperatorAction("statementPdfAction");

  if (!hasDatabase()) {
    return {
      ok: false,
      message:
        "No database is configured, so there is no ledger to generate a statement from. " +
        "This document is never rendered from fixtures — a statement drawn from typed-in " +
        "numbers is the one artefact here that would be worth nothing.",
    };
  }

  const result = await loadStatementsScreen({
    ...(request.accountId === undefined ? {} : { accountId: request.accountId }),
    ...(request.businessDate === undefined ? {} : { businessDate: request.businessDate }),
    ...(request.version === undefined ? {} : { version: request.version }),
    ...(request.anchor === undefined ? {} : { anchor: request.anchor }),
  });

  if (isErr(result)) {
    return {
      ok: false,
      message: `The statement could not be read: ${result.error.message}. Nothing moved — this path holds no capability to write.`,
    };
  }

  const view = result.value;
  if (view.account === null || view.readings === null) {
    return {
      ok: false,
      message: "There is no customer account on this book to render a statement for.",
    };
  }

  const readings = view.readings;
  const input: StatementPdfInput = {
    account: {
      accountId: view.account.accountId,
      legalName: view.account.legalName,
      accountName: view.account.accountName,
    },
    readings,
    // The RESOLVED parameters, not the ones that were asked for. The screen may
    // have fallen back to a different day or a weaker anchor, and a document
    // that cited the question rather than the answer would not reproduce.
    sourceUrl: statementUrl(view.account.accountId, readings.valueDate, readings.anchor),
  };

  const bytes = renderStatementPdf(input);

  return {
    ok: true,
    filename: statementPdfFilename(input),
    accountId: view.account.accountId,
    base64: Buffer.from(bytes).toString("base64"),
    byteLength: bytes.byteLength,
    fingerprint: documentFingerprint(input),
    valueDate: readings.valueDate,
    believedWatermark: readings.believed.bookingWatermark,
    correctedWatermark: readings.corrected.bookingWatermark,
  };
}

/** The screen URL that reproduces this document. Printed on the page. */
function statementUrl(
  accountId: string,
  businessDate: string,
  anchor: BelievedAnchor,
): string {
  const query = new URLSearchParams({ account: accountId, day: businessDate, as: anchor });
  return `/statements?${query.toString()}`;
}
