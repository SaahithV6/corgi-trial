import "server-only";

/**
 * The payee screen's data source, against the live database.
 *
 * The other side of `src/components/payees/data-contract.ts`. Everything the
 * screen shows comes through here, and the screen imports nothing else from
 * this directory — the same seam `src/lib/standing/screen.ts` maintains, for
 * the same reason: a component that can open a connection is a component that
 * eventually does.
 *
 * THE READ IS A READ. No check runs here, no provider is called, nothing is
 * written. Re-rendering this page a hundred times produces a hundred
 * identical rows and zero API calls, which is what makes "last checked two
 * days ago" a true statement rather than an artefact of when somebody last
 * looked at the screen.
 */

import type {
  FindingRow,
  PayeeBookView,
  PayeeDataSource,
  PayeeRow,
  RefusalRowView,
} from "@/components/payees/data-contract";
import { sql, type Sql } from "@/lib/ledger/db";
import { fail, ok, type ErrorShape, type Result } from "@/lib/result";

import { IncreaseRoutingDirectory } from "./directory";
import { loadPayeeBook, loadRefusals, type PayeeBookEntry } from "./store";

/**
 * `payee_verification.detail` is jsonb we wrote, which is exactly the reason
 * to re-validate it on the way out rather than cast it.
 *
 * `standing/store.ts` takes the same position on `counterparty`: a jsonb
 * column is a column whose shape the database does not enforce, so the
 * boundary that reads it is the boundary that checks it. A malformed detail
 * blob renders as no findings rather than throwing — a screen that 500s
 * because one historical row has an unexpected shape is worse than one that
 * shows the decision columns, which are the decision.
 */
function findingsFrom(detail: unknown): readonly FindingRow[] {
  if (typeof detail !== "object" || detail === null) return [];
  const raw = (detail as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];

  const out: FindingRow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { code, severity, title, detail: text } = item as Record<string, unknown>;
    if (typeof code !== "string" || typeof title !== "string" || typeof text !== "string") {
      continue;
    }
    if (severity !== "block" && severity !== "warn" && severity !== "note") continue;
    out.push({ code, severity, title, detail: text });
  }
  return out;
}

function toRow(entry: PayeeBookEntry): PayeeRow {
  return {
    payeeId: entry.payeeId,
    businessName: entry.businessName,
    displayName: entry.displayName,
    holderName: entry.holderName,
    rail: entry.rail,
    routingNumber: entry.routingNumber,
    accountNumberLast4: entry.accountNumberLast4,
    accountType: entry.accountType,
    createdAt: entry.createdAt,
    createdByName: entry.createdByName,
    archived: entry.archived,
    archivedAt: entry.archivedAt,
    archivalReason: entry.archivalReason,
    checkedAt: entry.checkedAt,
    checkedByName: entry.checkedByName,
    outcome: entry.outcome,
    freshness: entry.freshness,
    checkedDaysAgo: entry.checkedDaysAgo,
    checksumOk: entry.checksumOk,
    prefixAssigned: entry.prefixAssigned,
    directory: entry.directory,
    directoryProvider: entry.directoryProvider,
    institutionName: entry.institutionName,
    nameMatch: entry.nameMatch,
    nameMatchScore: entry.nameMatchScore,
    nameSource: entry.nameSource,
    nameProvider: entry.nameProvider,
    counterpartyName: entry.counterpartyName,
    evidence: entry.evidence,
    findings: findingsFrom(entry.detail),
    acknowledged: entry.acknowledged,
    acknowledgedAt: entry.acknowledgedAt,
    acknowledgedByName: entry.acknowledgedByName,
    acknowledgementReason: entry.acknowledgementReason,
    hasConflictingTwin: entry.hasConflictingTwin,
  };
}

function toRefusal(row: {
  readonly id: string;
  readonly attemptedAt: string;
  readonly attemptedByName: string;
  readonly holderName: string;
  readonly rail: PayeeRow["rail"];
  readonly routingNumber: string;
  readonly accountNumberLast4: string | null;
  readonly code: string;
  readonly reason: string;
}): RefusalRowView {
  return {
    id: row.id,
    attemptedAt: row.attemptedAt,
    attemptedByName: row.attemptedByName,
    holderName: row.holderName,
    rail: row.rail,
    routingNumber: row.routingNumber,
    accountNumberLast4: row.accountNumberLast4,
    code: row.code,
    reason: row.reason,
  };
}

/**
 * Which directory would answer if a check were run now.
 *
 * Reported rather than assumed, because `not_listed` means "this bank does
 * not exist" in production and "the test directory is small" in sandbox, and
 * a reader cannot interpret a single row on this screen without knowing
 * which. Derived from the base URL by `IncreaseRoutingDirectory`, and `none`
 * when no key is configured at all.
 */
function directoryEnvironment(): PayeeBookView["directoryEnvironment"] {
  const key = process.env["INCREASE_API_KEY"];
  if (key === undefined || key.length === 0) return "none";
  return new IncreaseRoutingDirectory({}).environment;
}

/** The live source. Failure is a value; the screen renders the error state. */
export function livePayeeSource(conn: Sql = sql): PayeeDataSource {
  return {
    load: async (filter = {}): Promise<Result<PayeeBookView, ErrorShape>> => {
      try {
        const [entries, refusals] = await Promise.all([
          loadPayeeBook(
            {
              ...(filter.businessId === undefined ? {} : { businessId: filter.businessId }),
              ...(filter.payeeId === undefined ? {} : { payeeId: filter.payeeId }),
            },
            conn,
          ),
          loadRefusals(
            {
              ...(filter.businessId === undefined ? {} : { businessId: filter.businessId }),
              limit: 25,
            },
            conn,
          ),
        ]);

        return ok({
          asOf: new Date().toISOString(),
          source: "live",
          directoryEnvironment: directoryEnvironment(),
          rows: entries.map(toRow),
          refusals: refusals.map(toRefusal),
        });
      } catch (error) {
        return fail(
          "PAYEE_BOOK_UNAVAILABLE",
          "The payee book could not be read. No check ran and nothing was written — this " +
            "screen only reads.",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}
