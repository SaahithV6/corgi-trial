import "server-only";

import { decisionGate, releaseGate } from "@/lib/approvals/gate";
import { listQueue } from "@/lib/approvals/instructions";
import { describeDestination, type QueuedPayment } from "@/lib/approvals/types";
import {
  ledgerConnection,
  listDepositAccounts,
  listDepositMovements,
  readSnapshot,
  type Sql,
} from "@/lib/ledger/queries";
import { createLiveAccountDataSource } from "@/components/account/live-data-source";
import { err, fail, ok } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";

import { foldTotals } from "./console-derive";
import type {
  AccountPosition,
  Attention,
  ConsoleActor,
  ConsoleDataSource,
  ConsoleSnapshot,
  Movement,
  PendingPayment,
} from "./console-contract";

/**
 * The front door's live read.
 *
 * ============================================================================
 * This is the only file under `src/components/home/**` that is allowed to know
 * a database exists. Everything else in this directory renders
 * `console-contract.ts` and could not open a connection if it wanted to.
 * ============================================================================
 *
 * Three rules it is built to, all of them inherited from the page it feeds:
 *
 * 1. **Reuse the fold, never re-derive it.** The balances come from
 *    `createLiveAccountDataSource`, which is the same source `/accounts` and
 *    the account screen itself render. A front door that ran its own balance
 *    aggregate would eventually disagree with the screen it links to, and
 *    "the home page said $84,939.18 and the account says $84,000" is a support
 *    ticket nobody can close. The pending queue likewise comes from
 *    `listQueue`, which defines "pending" as the ABSENCE of a closing event in
 *    SQL — that definition lives in one place and this file does not restate
 *    it.
 *
 * 2. **A throw becomes a value.** Every path returns a `Result`, carrying the
 *    driver's own code, so the page renders the failure instead of a 500.
 *
 * 3. **Nothing here writes.** The application role holds SELECT and INSERT and
 *    nothing else on the money tables (DECISIONS 008), and this issues only
 *    SELECTs: a failure on this path cannot have moved anything, which is why
 *    every error it produces is marked retryable.
 */

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
 * A failed read, named honestly — `CONSOLE_42P01`, `CONSOLE_ECONNREFUSED`.
 *
 * The same vocabulary the account and home-summary panels use, so an operator
 * comparing two error panels is reading one set of codes rather than three.
 */
function readFailure(operation: string, thrown: unknown): Result<never, ErrorShape> {
  return fail(
    `CONSOLE_${driverCode(thrown) ?? "READ_FAILED"}`,
    `${operation} could not be read: ${messageOf(thrown)}`,
    { retryable: true, source: "home.console", operation },
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Positions                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every customer deposit account, with all four figures.
 *
 * `createLiveAccountDataSource` memoises one snapshot — one `now()`, one
 * booking watermark — across every call it serves, so the whole table is a
 * statement about a single instant rather than a collage of several.
 *
 * `bigint` in, `bigint` out. The account contract narrows to `number` at its
 * own boundary with a documented safe-integer assertion; this widens straight
 * back, because the front door sums across the book and a total has no such
 * bound to lean on. `BigInt(n)` on an already-narrowed safe integer is exact.
 */
async function readPositions(conn: Sql): Promise<readonly AccountPosition[]> {
  const rows = await listDepositAccounts(conn);
  const source = createLiveAccountDataSource({ conn });

  const positions: AccountPosition[] = [];
  for (const row of rows) {
    const summary = await source.getAccountSummary({ accountId: row.accountId });
    // A read that failed for one account must not be rendered as a zero
    // balance for it. Fail the whole panel; the page still renders.
    if (!summary.ok) throw new PositionError(summary.error);

    positions.push({
      accountId: row.accountId,
      accountName: summary.value.accountName,
      businessName: summary.value.businessName,
      last4: summary.value.accountNumberLast4,
      ledgerCents: BigInt(summary.value.ledgerCents),
      availableCents: BigInt(summary.value.availableCents),
      activeHoldsCents: BigInt(summary.value.activeHoldsCents),
      unclearedCreditsCents: BigInt(summary.value.unclearedCreditsCents),
    });
  }

  return positions;
}

/** Carries a contract-shaped error out through the `catch` without flattening it. */
class PositionError extends Error {
  readonly shape: ErrorShape;
  constructor(shape: ErrorShape) {
    super(shape.message);
    this.name = "PositionError";
    this.shape = shape;
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Movement, and everything else countable, in ONE statement               */
/* -------------------------------------------------------------------------- */

/** How many recent lines the console shows. A front door, not a statement. */
export const MOVEMENT_LIMIT = 8;

/**
 * The last few lines that touched a customer's money.
 *
 * `l.amount_cents * a.normal_side` is the whole reason this reads naturally:
 * a customer's deposit is a LIABILITY of the bank, so the underlying line is
 * negative when the customer receives money. Multiplying by `normal_side` —
 * the same trick `v_ledger_balance` uses — hands the renderer a figure that is
 * positive for money in, and no component has to know which way round a
 * liability sits.
 *
 * Ordered by `booking_seq`, the total order of what we LEARNED, not by value
 * date. A settlement backdated to 2010 and booked this afternoon belongs at
 * the top of "recent movement" — that is exactly what recent means here — and
 * the value date is printed beside it so the two clocks are never confused.
 */
async function readMovements(conn: Sql): Promise<readonly Movement[]> {
  const rows = await listDepositMovements(MOVEMENT_LIMIT, conn);

  return rows.map((row) => ({
    entryId: row.entryId,
    bookingSeq: row.bookingSeq.toString(),
    bookingTime: row.bookingTime.toISOString(),
    valueDate: row.valueDate,
    entryType: row.entryType,
    description: row.description,
    rail: row.rail,
    externalRef: row.externalRef,
    amountCents: row.amountCents,
    accountId: row.accountId,
    businessName: row.businessName,
  }));
}

interface CountsRow {
  readonly read_at: Date;
  readonly booking_watermark: bigint;
  readonly overdrawn_accounts: number;
  readonly parked_webhooks: number;
  readonly dead_webhooks: number;
  readonly businesses_not_approved: number;
}

/**
 * The counts, in one statement.
 *
 * One statement is one MVCC snapshot, which is the only way these figures can
 * be describing the same instant as each other. Counts are cast `::int`
 * deliberately: `count(*)` is `int8`, which `lib/ledger/db.ts` parses into a JS
 * `bigint` so a cent count can never lose precision — correct for money, and
 * needless ceremony for a row count.
 *
 * Every one of them is read from the view that already defines it.
 * `v_overdrawn_accounts` and `v_business_kyb` are the schema's own answers to
 * "who is overdrawn" and "who may transact", and re-deriving either here would
 * be a second opinion about a question the database already answers.
 */
async function readCounts(conn: Sql): Promise<CountsRow> {
  // The instant AND the watermark from the ledger's own snapshot, in one
  // statement — which is stricter than what this query did before, not looser.
  // It used to read `now()` beside its own `MAX(booking_seq)`; `now()` is the
  // TRANSACTION's start and `readSnapshot` uses `clock_timestamp()`, which is
  // when the watermark was actually taken. The counts below are a second
  // statement and therefore a second MVCC snapshot; they are queue depths on
  // an operator console, not money, and none of them is derivable from the
  // watermark, so nothing here can disagree with itself.
  const snapshot = await readSnapshot(conn);

  const rows = await conn<Omit<CountsRow, "read_at" | "booking_watermark">[]>`
    SELECT (SELECT count(*) FROM v_overdrawn_accounts)::int        AS overdrawn_accounts,
           (SELECT count(*) FROM webhook_inbox
             WHERE state = 'parked')::int                          AS parked_webhooks,
           (SELECT count(*) FROM webhook_inbox
             WHERE state = 'dead')::int                            AS dead_webhooks,
           (SELECT count(*) FROM v_business_kyb
             WHERE kyb_status <> 'approved')::int                  AS businesses_not_approved`;

  const row = rows[0];
  if (row === undefined) {
    // Unreachable against Postgres — a SELECT with no FROM returns one row —
    // but a driver that returned nothing must not become "0 things need a
    // human" on a screen whose job is to say what needs one.
    throw new Error("the console counts query returned no row");
  }
  return { ...row, read_at: snapshot.asOf, booking_watermark: snapshot.bookingWatermark };
}

/* -------------------------------------------------------------------------- */
/* 3. The queue                                                               */
/* -------------------------------------------------------------------------- */

/**
 * How many pending payments the console reads to find the oldest.
 *
 * `listQueue` caps at 200 itself. Reading the page and reporting whether it
 * was full is honest in both directions: below the cap the count is exact and
 * the last row really is the oldest; at the cap the console says "at least"
 * and stops claiming to have found the oldest thing on the book.
 */
export const QUEUE_PAGE = 200;

function toPending(
  payment: QueuedPayment,
  actor: ConsoleActor | null,
): PendingPayment {
  const { instruction } = payment;
  const gateInput = {
    state: payment.state,
    initiatorActorId: instruction.requestedByActorId,
    initiatorName: instruction.requestedByName,
    actor,
  };

  return {
    id: instruction.id,
    amountCents: instruction.amountCents,
    currency: instruction.currency,
    rail: instruction.rail,
    state: payment.state,
    destination: describeDestination(instruction.destination),
    accountName: instruction.accountName,
    businessName: instruction.businessName,
    initiatorName: instruction.requestedByName,
    initiatorKind: instruction.requestedByKind,
    requestedAt: instruction.requestedAt,
    valueDate: instruction.valueDate,
    policyVersion: instruction.policy.version,
    thresholdCents: instruction.policy.thresholdCents,
    aboveThreshold: payment.aboveThreshold,
    approvalsHeld: payment.approvalsHeld,
    approvalsRequired: payment.approvalsRequired,
    contentHash: instruction.contentHash,
    gate: decisionGate(gateInput),
    releaseGate: releaseGate({
      ...gateInput,
      approvalsHeld: payment.approvalsHeld,
      approvalsRequired: payment.approvalsRequired,
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* The source                                                                 */
/* -------------------------------------------------------------------------- */

export type LiveConsoleOptions = {
  /** Injected in tests. Production resolves the app's pooled handle lazily. */
  readonly conn?: Sql;
};

/**
 * The live console.
 *
 * The four reads run concurrently and share one connection. They are NOT one
 * statement — the balance fold takes its own snapshot and the queue is a
 * different table entirely — so `readAt` is stamped by the counts query and
 * the page prints it as provenance rather than implying an atomic view of
 * everything at once.
 */
export function createLiveConsoleSource(
  options: LiveConsoleOptions = {},
): ConsoleDataSource {
  return {
    async read(actor) {
      try {
        const conn = options.conn ?? (await ledgerConnection());

        const [positions, movements, counts, queue] = await Promise.all([
          readPositions(conn),
          readMovements(conn),
          readCounts(conn),
          listQueue({ pendingOnly: true, limit: QUEUE_PAGE }, conn),
        ]);

        if (!queue.ok) return queue;

        // `listQueue` orders newest first, so the oldest still-pending payment
        // is the last row of the page.
        const pending = queue.value;
        const oldest = pending.length === 0 ? null : pending[pending.length - 1];

        const attention: Attention = {
          pendingPayments: pending.length,
          pendingCapped: pending.length >= QUEUE_PAGE,
          oldestPendingAt: oldest?.instruction.requestedAt ?? null,
          overdrawnAccounts: counts.overdrawn_accounts,
          parkedWebhooks: counts.parked_webhooks,
          deadLetteredWebhooks: counts.dead_webhooks,
          businessesNotApproved: counts.businesses_not_approved,
        };

        return ok({
          readAt: counts.read_at.toISOString(),
          bookingWatermark: counts.booking_watermark.toString(),
          actor,
          positions,
          totals: foldTotals(positions),
          movements,
          attention,
          oldestPending:
            oldest === undefined || oldest === null ? null : toPending(oldest, actor),
          live: true,
        } satisfies ConsoleSnapshot);
      } catch (thrown) {
        if (thrown instanceof PositionError) return err(thrown.shape);
        return readFailure("the operator console", thrown);
      }
    },
  };
}
