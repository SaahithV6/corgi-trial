import "server-only";

import { fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";
import {
  type DepositAccountRow,
  type HoldRow,
  type LedgerSnapshot,
  type PostingRow,
  type Sql,
  findDepositAccount,
  foldHoldTotals,
  ledgerBalanceCents,
  ledgerConnection,
  listDepositAccounts,
  listHoldRows,
  listPostingRows,
  readSnapshot,
} from "@/lib/ledger/queries";

import type {
  AccountDataSource,
  AccountSummary,
  Cents,
  Hold,
  Instant,
  Posting,
  ValueDate,
} from "./data-contract";

/**
 * `AccountDataSource`, backed by the live journal.
 *
 * ============================================================================
 * This file is the seam, and it is the only file in `src/components/**` that
 * is allowed to know a database exists.
 * ============================================================================
 *
 * `data-contract.ts` forbids components from importing `postgres`,
 * `src/lib/db` or `src/lib/ledger/*`. That rule is what keeps the screen a
 * pure function of the contract, and it holds: every component still imports
 * the interface and nothing else. This module is the adapter the rule exists
 * to make possible — it imports the ledger's read-only query helpers (never
 * `postgres`, never the `sql` handle itself) and translates their rows into
 * the contract's types. Nothing below renders anything, and nothing above
 * this file mentions SQL.
 *
 * Three things happen here and nowhere else:
 *
 * 1. **`bigint` becomes `number`.** The query layer carries money as `bigint`
 *    cents from the `int8` column all the way to this boundary. `toCents`
 *    narrows it and asserts the result is a safe integer, so a balance past
 *    2^53 cents fails loudly instead of rounding quietly. See the note on
 *    `Cents` in `data-contract.ts`.
 *
 * 2. **A throw becomes a value.** Every method returns a `Result`, carrying
 *    the real failure code — the Postgres `SQLSTATE` or the driver's connect
 *    error — so the screen's error state names what actually broke. It never
 *    reports the fixture's `LEDGER_QUERY_FAILED`, because a live failure that
 *    is indistinguishable from a demo is not a diagnosis.
 *
 * 3. **One snapshot answers all three reads.** The contract requires the three
 *    methods to be consistent as of a single instant. A `LedgerSnapshot` —
 *    `now()`, today in book time, and the booking watermark — is taken once
 *    per data source and passed into every query, so the headline balance is a
 *    fold over exactly the postings the table lists.
 */

/* -------------------------------------------------------------------------- */
/* Narrowing money, once                                                      */
/* -------------------------------------------------------------------------- */

/** Thrown by `toCents`, caught by the method boundary, rendered as an error. */
class UnsafeCentsError extends Error {
  constructor(field: string, value: bigint) {
    super(
      `${field} is ${value.toString()} cents, which cannot be represented exactly as a JS number`,
    );
    this.name = "UnsafeCentsError";
  }
}

/**
 * `bigint` cents to the contract's `number` cents, or a loud failure.
 *
 * `Number(9007199254740993n)` is `9007199254740992` — a silent, arbitrary
 * change to a money figure. `Number.isSafeInteger` is the only thing standing
 * between that and a screen that quietly shows the wrong balance, so the
 * conversion is a function with an assertion rather than a `Number()` call
 * sprinkled through a mapper.
 */
export function toCents(value: bigint, field: string): Cents {
  return toSafeInteger(value, field);
}

/** The same assertion for a count that is not money — the booking watermark. */
export function toSafeInteger(value: bigint, field: string): number {
  const narrowed = Number(value);
  if (!Number.isSafeInteger(narrowed)) throw new UnsafeCentsError(field, value);
  return narrowed;
}

/** `null` stays `null`: a memo posting has no ledger effect, which is not zero. */
function toCentsOrNull(value: bigint | null, field: string): Cents | null {
  return value === null ? null : toCents(value, field);
}

function toInstant(value: Date): Instant {
  return value.toISOString();
}

function toInstantOrNull(value: Date | null): Instant | null {
  return value === null ? null : value.toISOString();
}

/* -------------------------------------------------------------------------- */
/* Failure, as a value                                                        */
/* -------------------------------------------------------------------------- */

/** The driver's own code for what went wrong: a SQLSTATE, or a connect error. */
function driverCode(thrown: unknown): string | null {
  if (typeof thrown !== "object" || thrown === null) return null;
  const code: unknown = (thrown as { code?: unknown }).code;
  if (typeof code !== "string" || code.length === 0) return null;
  return code.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function messageOf(thrown: unknown): string {
  const raw =
    thrown instanceof Error ? thrown.message : String(thrown ?? "unknown error");
  const firstLine = raw.split("\n")[0] ?? raw;
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}...` : firstLine;
}

/**
 * A failed read, named honestly.
 *
 * The code an operator sees is the database's own: `LEDGER_42P01` for a
 * missing relation, `LEDGER_ECONNREFUSED` when Neon is unreachable,
 * `LEDGER_CENTS_NOT_SAFE_INTEGER` when a figure will not narrow. Only a
 * genuinely codeless throw falls back to `LEDGER_READ_FAILED`, and even that
 * is distinct from the fixture's `LEDGER_QUERY_FAILED`, so "the demo state" and
 * "the database is down" can never be confused on screen.
 *
 * Every one of these is retryable, and the panel says so, because this
 * interface is read-only by construction: a failed query cannot have moved
 * money. The ledger is append-only and a SELECT cannot alter it.
 */
function readFailure(operation: string, thrown: unknown) {
  const code =
    thrown instanceof UnsafeCentsError
      ? "LEDGER_CENTS_NOT_SAFE_INTEGER"
      : `LEDGER_${driverCode(thrown) ?? "READ_FAILED"}`;

  return fail(code, `${operation} failed: ${messageOf(thrown)}`, {
    retryable: true,
    source: "ledger.queries",
    operation,
  });
}

function accountNotFound(accountId: string) {
  return fail(
    "ACCOUNT_NOT_FOUND",
    `No customer deposit account ${accountId} exists on this book. Only 2100 accounts with a business are addressable here.`,
    { retryable: false, source: "ledger.queries", accountId },
  );
}

/* -------------------------------------------------------------------------- */
/* Presentation of things the journal stores structurally                     */
/* -------------------------------------------------------------------------- */

/**
 * The customer-facing account name.
 *
 * `account.name` is written by `perBusinessAccountName()` as
 * `<legal name> — business current account`, and the screen already shows the
 * business on the line beneath. Repeating it in the heading is noise, so the
 * legal-name prefix is trimmed when it is there and the whole name is used
 * when it is not.
 */
export function shortAccountName(accountName: string, legalName: string): string {
  const prefix = `${legalName} — `;
  if (!accountName.startsWith(prefix)) return accountName;
  const rest = accountName.slice(prefix.length).trim();
  if (rest.length === 0) return accountName;
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/**
 * The four characters that identify the account to a human.
 *
 * There is no account-number column in this schema — this build never issued
 * one, and inventing a plausible-looking routing/account pair on a screen an
 * operator might screenshot would be a lie about a banking artefact. The last
 * four of the account id are stable, unique, already public in the URL, and
 * honest about being an internal handle.
 */
export function accountHandleLast4(accountId: string): string {
  return accountId.replace(/-/g, "").slice(-4);
}

/** `fap · ach/known, 2 banking days, release 09:00` — §10.1, as one line. */
export function formatPolicyRef(policy: {
  readonly rail: string;
  readonly counterpartyClass: string;
  readonly bankingDaysHold: number;
  readonly releaseLocalTime: string;
} | null): string | null {
  if (policy === null) return null;
  const days = policy.bankingDaysHold === 1 ? "1 banking day" : `${policy.bankingDaysHold} banking days`;
  const time = policy.releaseLocalTime.slice(0, 5);
  return `fap · ${policy.rail}/${policy.counterpartyClass}, ${days}, release ${time}`;
}

/**
 * `card:evt_01K9…` — the rail and the provider's own id for the event.
 *
 * Shown as provenance so a figure on this screen can be traced back to the
 * webhook that produced it without a database client.
 */
export function formatSourceRef(
  rail: string | null,
  externalRef: string | null,
): string | null {
  if (externalRef === null) return null;
  return rail === null ? externalRef : `${rail}:${externalRef}`;
}

/**
 * The description, with the backdating stated rather than left to be inferred.
 *
 * §5's two clocks are both on the row already — the timestamp is the booking
 * axis and the value date is beneath it — but an operator scanning a statement
 * reads the description, and "this correction belongs to a day that closed
 * three weeks ago" is exactly the thing they must not miss. The structured
 * facts stay available on `LivePosting.backdated` and `.bookingDate` for
 * anything that wants to branch on them instead of read them.
 */
export function describePosting(row: {
  readonly description: string;
  readonly backdated: boolean;
  readonly valueDate: string;
}): string {
  if (!row.backdated) return row.description;
  return `${row.description} · backdated to ${row.valueDate}`;
}

/* -------------------------------------------------------------------------- */
/* Row → contract                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A hold as the contract sees it.
 *
 * `providerStatus` is `null` for every live hold, and that is the design
 * rather than a gap: `card_authorization` has no status column, because
 * DECISIONS 006 measured Lithic reporting `SETTLED` while $4.00 of a $10.00
 * authorisation was still outstanding. There is no rail opinion stored to
 * display, and `remainingCents` is derived from the event set, so the two can
 * never disagree here — the fixture keeps the disagreement on screen for the
 * `?state=` demos, where the point is to show what was avoided.
 */
export function toHold(row: HoldRow): Hold {
  return {
    id: row.holdId,
    kind: row.kind,
    descriptor: row.descriptor,
    authorisedCents: toCents(row.authorisedCents, `hold ${row.holdId} authorised`),
    clearedCents: toCents(row.clearedCents, `hold ${row.holdId} cleared`),
    remainingCents: toCents(row.remainingCents, `hold ${row.holdId} remaining`),
    closed: row.closed,
    placedAt: toInstant(row.placedAt),
    expiresAt: toInstantOrNull(row.expiresAt),
    availableAt: toInstantOrNull(row.availableAt),
    policyRef: formatPolicyRef(row.policy),
    providerStatus: null,
  };
}

/**
 * A posting, plus the two facts the contract does not carry yet.
 *
 * `Posting` already separates the clocks — `occurredAt` is the booking instant
 * and `valueDate` is the business day — so a `LivePosting` is a `Posting` in
 * every structural sense and the components take it unchanged. `bookingDate`
 * and `backdated` ride alongside for callers that want to branch on the
 * comparison rather than recompute it in the wrong timezone; the screen sees
 * the same fact stated in the description.
 */
export type LivePosting = Posting & {
  /** The business day we learned about it, in book time. §5's booking axis. */
  readonly bookingDate: ValueDate;
  /** `valueDate < bookingDate`: the entry belongs to an earlier business day. */
  readonly backdated: boolean;
  /** How many book days earlier. `0` when the entry was not backdated. */
  readonly backdatedByDays: number;
  readonly entryType: "original" | "reversal" | "rebook";
};

export function toPosting(row: PostingRow): LivePosting {
  return {
    id: row.entryId,
    book: row.book,
    description: describePosting(row),
    // The journal records the counterparty inside the description and the
    // external ref; there is no counterparty column to read, and inventing one
    // by parsing a free-text description would be a guess rendered as a fact.
    counterparty: null,
    occurredAt: toInstant(row.occurredAt),
    valueDate: row.valueDate,
    ledgerDeltaCents: toCentsOrNull(row.ledgerDeltaCents, `posting ${row.entryId} ledger delta`),
    availableDeltaCents: toCents(
      row.availableDeltaCents,
      `posting ${row.entryId} available delta`,
    ),
    holdId: row.holdId,
    sourceRef: formatSourceRef(row.rail, row.externalRef),
    bookingDate: row.bookingDate,
    backdated: row.backdated,
    backdatedByDays: row.backdatedByDays,
    entryType: row.entryType,
  };
}

/**
 * The summary, with the decomposition closed by construction.
 *
 * `availableCents` is computed here as `ledger − holds − uncleared` from the
 * very rows `listHolds` returns, so the identity the contract demands cannot
 * be violated by a second query drifting from the first. It is deliberately
 * not clamped: an over-captured authorisation settles above what was
 * authorised, and the honest answer is that the customer is overdrawn.
 */
export function toSummary(input: {
  readonly account: DepositAccountRow;
  readonly snapshot: LedgerSnapshot;
  readonly ledgerCents: bigint;
  readonly holds: readonly HoldRow[];
}): AccountSummary {
  const { activeHoldsCents, unclearedCreditsCents } = foldHoldTotals(input.holds);
  const availableCents =
    input.ledgerCents - activeHoldsCents - unclearedCreditsCents;

  return {
    accountId: input.account.accountId,
    accountName: shortAccountName(input.account.accountName, input.account.legalName),
    businessName: input.account.legalName,
    accountNumberLast4: accountHandleLast4(input.account.accountId),
    currency: "USD",
    ledgerCents: toCents(input.ledgerCents, "ledger balance"),
    availableCents: toCents(availableCents, "available balance"),
    activeHoldsCents: toCents(activeHoldsCents, "active holds"),
    unclearedCreditsCents: toCents(unclearedCreditsCents, "uncleared credits"),
    asOf: toInstant(input.snapshot.asOf),
    bookingWatermark: toSafeInteger(
      input.snapshot.bookingWatermark,
      "booking watermark",
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* The data source                                                            */
/* -------------------------------------------------------------------------- */

/** Newest-first page size when the caller does not ask for one. */
export const DEFAULT_POSTINGS_LIMIT = 25;
/** A page size a URL cannot talk this screen past. */
export const MAX_POSTINGS_LIMIT = 200;

function pageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_POSTINGS_LIMIT;
  const whole = Math.floor(limit);
  if (whole < 1) return 1;
  return whole > MAX_POSTINGS_LIMIT ? MAX_POSTINGS_LIMIT : whole;
}

/** Memoise a promise: the factory runs at most once per data source. */
function once<T>(factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= factory();
    return pending;
  };
}

export type LiveAccountDataSourceOptions = {
  /** Injected in tests. Production resolves the app's pooled handle lazily. */
  readonly conn?: Sql;
};

type Context = {
  readonly conn: Sql;
  readonly snapshot: LedgerSnapshot;
};

/**
 * The live implementation of the account screen's contract.
 *
 * One instance per render. The snapshot and the account lookup are memoised
 * across the three methods, so `Promise.all([summary, holds, postings])` takes
 * one `now()`, one watermark and one identity read between them rather than
 * three of each that could disagree.
 */
export function createLiveAccountDataSource(
  options: LiveAccountDataSourceOptions = {},
): AccountDataSource {
  const context = once<Context>(async () => {
    const conn = options.conn ?? (await ledgerConnection());
    return { conn, snapshot: await readSnapshot(conn) };
  });

  const accounts = new Map<string, Promise<DepositAccountRow | null>>();
  const account = async (accountId: string): Promise<DepositAccountRow | null> => {
    const cached = accounts.get(accountId);
    if (cached !== undefined) return cached;
    const pending = context().then(({ conn }) => findDepositAccount(accountId, conn));
    accounts.set(accountId, pending);
    return pending;
  };

  return {
    async getAccountSummary({ accountId }) {
      try {
        const { conn, snapshot } = await context();
        const found = await account(accountId);
        if (found === null) return accountNotFound(accountId);

        const [ledger, holds] = await Promise.all([
          ledgerBalanceCents(found.accountId, snapshot, conn),
          listHoldRows(found.accountId, snapshot, conn),
        ]);

        return ok(
          toSummary({ account: found, snapshot, ledgerCents: ledger, holds }),
        );
      } catch (thrown) {
        return readFailure("getAccountSummary", thrown);
      }
    },

    async listHolds({ accountId }) {
      try {
        const { conn, snapshot } = await context();
        const found = await account(accountId);
        if (found === null) return accountNotFound(accountId);

        const rows = await listHoldRows(found.accountId, snapshot, conn);
        return ok(rows.map(toHold));
      } catch (thrown) {
        return readFailure("listHolds", thrown);
      }
    },

    async listPostings({ accountId, limit }) {
      try {
        const { conn, snapshot } = await context();
        const found = await account(accountId);
        if (found === null) return accountNotFound(accountId);

        const rows = await listPostingRows(
          found.accountId,
          snapshot,
          pageSize(limit),
          conn,
        );
        return ok(rows.map(toPosting));
      } catch (thrown) {
        return readFailure("listPostings", thrown);
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The directory                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A row of `/accounts`.
 *
 * Deliberately not part of `AccountDataSource`: the account screen does not
 * need a list, and the contract stays narrow. It mirrors the fixture's
 * `DemoAccountRef` so the directory can render live and demo rows through one
 * table.
 */
export type LiveAccountRef = {
  readonly accountId: string;
  readonly accountName: string;
  readonly last4: string;
  readonly businessName: string;
  readonly ledgerCents: Cents;
  readonly availableCents: Cents;
};

/**
 * Every customer deposit account, with both balances.
 *
 * The figures come from `getAccountSummary` rather than from a second, wider
 * aggregate, so a row in the directory and the screen it links to are the same
 * fold of the same rows. A directory that quotes its own numbers is a
 * directory that will eventually disagree with the account it links to, and
 * "the list said $48,215.60 and the page says $47,000" is a support ticket
 * nobody can close.
 */
export async function listLiveAccounts(
  options: LiveAccountDataSourceOptions = {},
): Promise<Result<readonly LiveAccountRef[], ErrorShape>> {
  try {
    const conn = options.conn ?? (await ledgerConnection());
    const rows = await listDepositAccounts(conn);
    const source = createLiveAccountDataSource({ conn });

    const refs: LiveAccountRef[] = [];
    for (const row of rows) {
      const summary = await source.getAccountSummary({ accountId: row.accountId });
      if (!summary.ok) return summary;
      refs.push({
        accountId: row.accountId,
        accountName: summary.value.accountName,
        last4: summary.value.accountNumberLast4,
        businessName: summary.value.businessName,
        ledgerCents: summary.value.ledgerCents,
        availableCents: summary.value.availableCents,
      });
    }

    return ok(refs);
  } catch (thrown) {
    return readFailure("listLiveAccounts", thrown);
  }
}
