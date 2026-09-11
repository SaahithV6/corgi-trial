/**
 * `GET /api/v1/statements` and `GET /api/v1/statements/{business_date}`.
 *
 * ===========================================================================
 * A STATEMENT ENDPOINT THAT RETURNS ONE DOCUMENT IS LYING BY OMISSION
 * ===========================================================================
 *
 * "A merchant reverses Tuesday's settlement on Thursday. Tuesday's statement
 * now shows the corrected position, AND the system can still prove what it
 * believed on Wednesday." Those are two different documents for one business
 * day and both are true, so this endpoint returns both:
 *
 *   published  the document that was ISSUED, re-derived from the ledger at its
 *              own frozen watermark and checked against its stored hash on
 *              this read.
 *   corrected  the same day at TODAY's watermark: what the ledger now says
 *              that day was.
 *
 * Neither is a correction of the other in the sense of being more right. They
 * answer different questions — "what did you tell the customer on Wednesday"
 * and "what actually happened on Tuesday" — and an API that returns only the
 * second cannot survive a dispute, while one that returns only the first is a
 * filing cabinet.
 *
 * THE DIFFERENCE IS ITEMISED, NOT ASSERTED. `delta` is
 * `corrected.closing − published.closing`, and `late_postings` is every entry
 * with a value date inside the period that was booked ABOVE the published
 * watermark. `delta_is_explained` reports whether they reconcile:
 *
 *     corrected.closing − published.closing === Σ late_postings.amount
 *
 * If that identity ever fails the response says so rather than printing a
 * confident number. `explainsDelta` is `@/lib/statements/compare`'s own pure
 * function — the same one the console renders — not a second sum.
 *
 * `published.reproduced` is the reproducibility claim evaluated on every call:
 * the document is re-rendered from immutable ledger rows at its frozen
 * watermark and the result is hashed. `true` means the bytes we issued are the
 * bytes the ledger still produces. A claim the caller cannot see is a claim
 * they have to take on faith.
 *
 * ===========================================================================
 * NOTHING HERE PUBLISHES OR CLOSES
 * ===========================================================================
 *
 * `closeDay` and `publishStatement` are in the same module as the reads used
 * below and neither is imported — `no-write-imports.test.ts` in this directory
 * fails the build if they ever are. Closing a business day freezes a watermark
 * that every statement for that day is derived from, and issuing a document is
 * telling a customer what their money did. Both are acts of a named person.
 */

import { ledgerConnection } from "@/lib/ledger/queries";
import { compareStatement, explainsDelta } from "@/lib/statements/compare";
import { listStatementDays, readStatementAccount } from "@/lib/statements/read";
import type { StatementDocument } from "@/lib/statements/types";

import { badRequest, notFound } from "../errors";
import { isRealDate, limitParam, money, page, rejectUnknownParams, stringParam } from "../http";
import type { ApiContext, RouteResult } from "../handle";

const DEFAULT_ACCOUNT_CODE = "2100";

/**
 * Resolve the account a statement is for, scoped to this token's business.
 *
 * A statement is scoped to an ACCOUNT, but the close it is pinned to is
 * recorded per ENTITY — `book_day`'s key is `(entity_id, business_date)` —
 * so the entity has to be resolved from the account rather than taken from a
 * caller. `readStatementAccount` returns both, and the `businessId` on it is
 * compared to the grant even though the account was already found through the
 * gateway's scoped lookup: a boundary that depends on an earlier query having
 * been correct is not a boundary.
 */
async function resolveStatementAccount(ctx: ApiContext, code: string) {
  const ref = await ctx.gateway.findAccount(ctx.grant.businessId, code);
  if (ref === null) {
    throw notFound(
      "ACCOUNT_NOT_FOUND",
      `${ctx.grant.businessLegalName} has no open account with code ${code}`,
      "account_code names an open account belonging to this token's business",
      "Statements are issued for the business current account. GET /api/v1/accounts lists every code this token can name.",
      { account_code: code },
    );
  }

  const conn = await ledgerConnection();
  const account = await readStatementAccount(ref.accountId, conn);
  if (account === null || account.businessId !== ctx.grant.businessId) {
    throw notFound(
      "ACCOUNT_NOT_FOUND",
      `account ${code} is not a customer deposit account that statements are issued for`,
      "the account is a customer deposit account belonging to this token's business",
      "Statements exist for the business current account (code 2100). Memo-book and house accounts do not get statements.",
      { account_code: code },
    );
  }
  return { account, conn };
}

/* -------------------------------------------------------------------------- */
/* GET /api/v1/statements                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Closed business days this account has something to show for, newest first.
 *
 * "Something to show for" means a published statement OR at least one posting.
 * A day the entity closed on which this customer did nothing is excluded — its
 * statement is derivable (opening balance, no lines, the same closing balance)
 * and `GET /api/v1/statements/{date}` will still answer for it, but a book
 * with a nightly close has hundreds of them and they would crowd out every day
 * worth opening.
 *
 * `late_posting_count` is the column an integrator should watch: a non-zero
 * value means the published document for that day is no longer what the ledger
 * says the day was, and the detail endpoint will show the difference itemised.
 */
export async function listStatementsRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ["account_code", "limit"]);

  const code = stringParam(ctx.url, "account_code") ?? DEFAULT_ACCOUNT_CODE;
  const limit = limitParam(ctx.url, 90);
  const { account, conn } = await resolveStatementAccount(ctx, code);

  const days = await listStatementDays(
    { accountId: account.accountId, entityId: account.entityId, limit },
    conn,
  );

  const data = days.map((day) => ({
    object: "statement_day" as const,
    business_date: day.businessDate,
    /** When the entity signed the day off. */
    closed_at: day.closedAt,
    /** `max(booking_seq)` at the moment of close. The freeze. */
    booking_watermark: day.bookingWatermark.toString(),
    versions_published: day.versionCount,
    /** Lines on this account with this value date, as known NOW. */
    line_count: day.lineCount,
    /**
     * Lines with this value date booked ABOVE the close watermark. Non-zero
     * means the issued document and today's ledger disagree about this day.
     */
    late_posting_count: day.latePostingCount,
    links: { statement: `/api/v1/statements/${day.businessDate}?account_code=${code}` },
  }));

  return {
    status: 200,
    body: {
      ...page(data, limit, null),
      account: { code, name: account.accountName, currency: account.currency },
      business: { id: ctx.grant.businessId, legal_name: account.legalName },
      request_id: ctx.requestId,
    },
    audit: { days: data.length },
  };
}

/* -------------------------------------------------------------------------- */
/* GET /api/v1/statements/{business_date}                                     */
/* -------------------------------------------------------------------------- */

export async function getStatementRoute(
  ctx: ApiContext,
  businessDate: string,
): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ["account_code", "version"]);

  const date = businessDate.trim();
  if (!isRealDate(date)) {
    throw badRequest(
      "INVALID_DATE",
      `"${date.slice(0, 32)}" is not a calendar date`,
      "the path segment is a business date written YYYY-MM-DD",
      "Statements are addressed by business day, e.g. /api/v1/statements/2026-09-08. GET /api/v1/statements lists the closed days this account has something to show for.",
      { received: date.slice(0, 32) },
    );
  }

  const code = stringParam(ctx.url, "account_code") ?? DEFAULT_ACCOUNT_CODE;
  const version = versionParam(ctx.url);
  const { account, conn } = await resolveStatementAccount(ctx, code);

  const comparison = await compareStatement(
    {
      accountId: account.accountId,
      businessDate: date,
      ...(version === null ? {} : { version }),
    },
    conn,
  );

  if (comparison === null) {
    throw notFound(
      "NO_STATEMENT_PUBLISHED",
      `nothing has been published for ${date} on account ${code}`,
      "a statement version exists for this account and business date",
      "This is a state, not an error: a day can be closed with no statement issued yet, and a day that is still open has no frozen watermark to issue one against. GET /api/v1/statements lists the days that do have one. Publishing is an act of a named person and has no endpoint on this API.",
      { business_date: date, account_code: code },
    );
  }

  const explained = explainsDelta(comparison.deltaCents, comparison.latePostings);

  return {
    status: 200,
    body: {
      object: "statement",
      business_date: date,
      account: { code, name: account.accountName, currency: account.currency },
      business: { id: ctx.grant.businessId, legal_name: account.legalName },

      published: {
        statement_id: comparison.published.statementId,
        version: comparison.published.version,
        generated_at: comparison.published.generatedAt,
        generated_by: comparison.published.generatedBy,
        booking_watermark: comparison.published.bookingWatermark.toString(),
        content_hash: comparison.published.contentHash,
        format: comparison.published.format,
        /**
         * Re-derived from immutable ledger rows at the frozen watermark on
         * THIS read, and hashed. True means the bytes we issued are the bytes
         * the ledger still produces.
         */
        reproduced: comparison.reproduced,
        recomputed_hash: comparison.recomputedHash,
        /**
         * True when the stored row was rendered by a different renderer than
         * the one running, which makes `reproduced: false` a deployment fact
         * rather than a ledger fact. Without this, a renderer change and a
         * tampered row would be indistinguishable.
         */
        format_changed: comparison.formatChanged,
        document: serialiseDocument(comparison.publishedDocument),
      },

      corrected: {
        booking_watermark: comparison.correctedDocument.bookingWatermark.toString(),
        document: serialiseDocument(comparison.correctedDocument),
      },

      delta: {
        amount: money(comparison.deltaCents),
        /**
         * Does the itemised list account for the whole difference? If this is
         * ever false, the gap is not explained by anything we can name — which
         * is an incident, not a number to render, and it is reported rather
         * than rounded off.
         */
        is_explained: explained,
        late_postings: comparison.latePostings.map((posting) => ({
          entry_id: posting.entryId,
          value_date: posting.valueDate,
          booking_seq: posting.bookingSeq.toString(),
          booking_time: posting.bookingTime,
          entry_type: posting.entryType,
          description: posting.description,
          external_ref: posting.externalRef,
          reverses_entry_id: posting.reversesEntryId,
          correction_group_id: posting.correctionGroupId,
          amount: money(posting.signedCents),
          /**
           * Its value date is BEFORE the period, so it moved the OPENING
           * balance. Same effect on the closing figure and a completely
           * different thing to read: "the day before was restated" rather than
           * "this day was corrected".
           */
          affects_opening: posting.affectsOpening,
        })),
      },

      /** Every version issued for this day, oldest first. The lineage. */
      versions: comparison.versions.map((v) => ({
        statement_id: v.statementId,
        version: v.version,
        booking_watermark: v.bookingWatermark.toString(),
        opening_balance: money(v.openingBalanceCents),
        closing_balance: money(v.closingBalanceCents),
        line_count: v.lineCount,
        content_hash: v.contentHash,
        format: v.format,
        generated_at: v.generatedAt,
      })),

      note:
        "Both documents are true. `published` is what the customer was told, re-derived at its frozen watermark; `corrected` is what the ledger now says that day was. A correction produces a NEW version, never an edit — which is how a real bank issues a corrected statement and the only answer that survives 'so which is it, immutable or corrected?'.",
      request_id: ctx.requestId,
    },
    audit: {
      business_date: date,
      version: comparison.published.version,
      reproduced: comparison.reproduced,
      delta_cents: comparison.deltaCents.toString(),
    },
  };
}

function serialiseDocument(doc: StatementDocument): Record<string, unknown> {
  return {
    period_start: doc.periodStart,
    period_end: doc.periodEnd,
    opening_balance: money(doc.openingBalanceCents),
    closing_balance: money(doc.closingBalanceCents),
    line_count: doc.lineCount,
    lines: doc.lines.map((line) => ({
      entry_id: line.entryId,
      value_date: line.valueDate,
      /** `(value_date, booking_seq, ordinal)` is a TOTAL order. */
      booking_seq: line.bookingSeq.toString(),
      ordinal: line.ordinal,
      entry_type: line.entryType,
      description: line.description,
      external_ref: line.externalRef,
      rail: line.rail,
      reverses_entry_id: line.reversesEntryId,
      correction_group_id: line.correctionGroupId,
      /** Signed: positive is money in for the holder. */
      amount: money(line.signedCents),
      running_balance: money(line.runningBalanceCents),
    })),
  };
}

function versionParam(url: URL): number | null {
  const raw = stringParam(url, "version");
  if (raw === null) return null;
  if (!/^[0-9]{1,4}$/.test(raw)) {
    throw badRequest(
      "INVALID_VERSION",
      `version="${raw}" is not a whole number`,
      "version is a positive integer naming a published statement version",
      "Versions start at 1 and are listed in `versions` on the response. Omit the parameter to get v1 — the document that went out, and the one whose divergence from today is the story.",
      { received: raw },
    );
  }
  return Number.parseInt(raw, 10);
}
