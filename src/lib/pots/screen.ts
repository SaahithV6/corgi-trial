import "server-only";

import { ledgerConnection } from "@/lib/ledger/queries";
import { fail, ok } from "@/lib/result";
import type {
  AvailabilityView,
  BusinessOption,
  IdentityView,
  InvariantView,
  MovementView,
  PotView,
  PotsResult,
} from "@/components/pots/data-contract";

import { decideMove, identityOf } from "./model";
import {
  bookDate,
  listMovements,
  listPotBusinesses,
  listPots,
  readAvailability,
  readIdentity,
  readInvariants,
} from "./store";

/**
 * The live implementation of `PotsDataSource`.
 *
 * ---------------------------------------------------------------------------
 * `bigint` NARROWS HERE, ONCE
 * ---------------------------------------------------------------------------
 *
 * Everything in `src/lib/pots/**` is `bigint` cents. The contract is `number`
 * cents, because these values cross to the client and `bigint` does not survive
 * JSON. `toCents` is the single conversion site and it refuses rather than
 * silently rounds: an amount past 2^53 is a bug worth crashing on, not a number
 * to approximate in front of an operator.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIGURE ON THIS SCREEN IS A SUM OVER `journal_line`
 * ---------------------------------------------------------------------------
 *
 * The main balance, each pot's balance, the total, the recursive subtree total,
 * available, holds, uncleared. Nothing here reads a stored number, because
 * there is not one to read: `pnpm db:check` fails the build if a balance column
 * appears anywhere outside `statement`.
 */

/** The one bigint -> number narrowing in the read path. Refuses, never rounds. */
function toCents(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `${value} cents is past Number.MAX_SAFE_INTEGER; widen Cents to bigint before rendering it`,
    );
  }
  return Number(value);
}

/**
 * True when there is a database to read at all.
 *
 * Checked WITHOUT importing `src/lib/env.ts`, which refuses to load without a
 * full set of keys — the right behaviour for the app and the wrong behaviour
 * for a page that must be able to render the words "no database configured".
 */
export function hasDatabase(): boolean {
  const url = process.env["APP_DATABASE_URL"];
  return typeof url === "string" && url.length > 0;
}

/** What each invariant view is for, in one line, next to its row count. */
const INVARIANT_MEANING: Record<string, string> = {
  v_deposit_control_drift:
    "The 2100 subtree equals what we report as total customer money — pots included. This is the one a new account level was most likely to break, and it did break it: see docs/POTS.md §1.",
  v_pot_identity_drift:
    "main + Σ pots equals a recursive walk of the customer's deposit subtree, for every customer.",
  v_pot_negative: "No pot holds a negative balance. A pot cannot be overdrawn.",
  v_pot_orphan:
    "Every pot's account is a liability leaf parented directly on that business's own 2100 deposit account.",
  v_internal_transfer_impure:
    "Every pot transfer is exactly two lines, both inside one customer's deposit subtree.",
  v_entry_unbalanced: "Every journal entry sums to zero, per currency.",
  v_book_not_zero: "Each book nets to zero, per entity and currency, exactly.",
};

/**
 * The edge state: a move of one cent MORE than is available, refused.
 *
 * ===========================================================================
 * WHAT IS SYNTHETIC HERE AND WHAT IS NOT.
 *
 * SYNTHETIC: the amount. It is `availableCents + 1`, chosen so the refusal is
 * the tightest possible one — the customer is short by a single cent — because
 * a refusal that misses by $10,000 proves only that a big number is bigger.
 *
 * NOT SYNTHETIC: the four balances it is judged against, which are this
 * moment's live `availableBalance()`; the pot's name; and the FUNCTION that
 * refuses, which is `decideMove()` — the same one that decides inside the
 * transaction behind `lock_business_deposits()`. There is no second copy of the
 * rule for the demo to disagree with.
 *
 * NOT POSTED: the probe never reaches `postEntry()` and never takes the lock.
 * A render must not write, and this one does not.
 * ===========================================================================
 */
function edgeRefusal(
  availability: {
    readonly ledgerCents: bigint;
    readonly holdsCents: bigint;
    readonly unclearedCents: bigint;
    readonly availableCents: bigint;
  },
  potName: string,
) {
  const amountCents = availability.availableCents + 1n;
  const decision = decideMove(
    { direction: "in", amountCents },
    { availability, potBalanceCents: 0n, potName },
  );
  if (decision.kind !== "refuse") return null;

  return {
    code: decision.code,
    reason: decision.reason,
    potName,
    direction: "in" as const,
    requestedCents: toCents(decision.requestedCents),
    coverCents: toCents(decision.coverCents),
    shortfallCents: toCents(decision.shortfallCents),
  };
}

/**
 * One consistent read of everything the screen shows.
 *
 * `businessId` is the URL's choice and may be `null` (nothing chosen yet) or
 * unknown (a stale link). Neither is an error: the first customer on the book
 * is selected, which is what a person opening `/pots` wants.
 */
export async function loadPotsView(args: {
  readonly businessId: string | null;
  readonly edge?: boolean;
}): Promise<PotsResult> {
  try {
    const conn = await ledgerConnection();

    const businessRows = await listPotBusinesses(conn);
    const businesses: readonly BusinessOption[] = businessRows.map((row) => ({
      businessId: row.businessId,
      legalName: row.legalName,
      mainAccountId: row.mainAccountId,
    }));

    const day = await bookDate(conn);
    const invariants = await readInvariants(conn);
    const invariantViews: readonly InvariantView[] = invariants.map((row) => ({
      view: row.view,
      rows: row.rows,
      what: INVARIANT_MEANING[row.view] ?? "",
    }));

    // The URL's choice wins. Failing that, default to a customer who actually
    // HAS a pot rather than to whoever sorts first alphabetically — same
    // reasoning as the payments form defaulting to an account that can
    // transact. A screen whose default view is empty reads as broken rather
    // than as instructive, and every customer is still one click away.
    const withPots = await conn<{ business_id: string; funded: boolean }[]>`
      SELECT business_id::text AS business_id,
             bool_or(balance_cents <> 0) AS funded
        FROM v_pot_balance
       GROUP BY business_id`;
    const funded = new Set(
      withPots.filter((row) => row.funded).map((row) => row.business_id),
    );
    const anyPot = new Set(withPots.map((row) => row.business_id));

    const selected =
      businesses.find((b) => b.businessId === args.businessId) ??
      businesses.find((b) => funded.has(b.businessId)) ??
      businesses.find((b) => anyPot.has(b.businessId)) ??
      businesses[0] ??
      null;

    if (selected === null) {
      return ok({
        source: "live",
        asOf: new Date().toISOString(),
        bookDate: day,
        businesses,
        selected: null,
        pots: [],
        identity: null,
        availability: null,
        movements: [],
        invariants: invariantViews,
        refusal: null,
      });
    }

    const [potRows, identityRow, availability, movementRows] = await Promise.all([
      listPots(selected.businessId, conn),
      readIdentity(selected.businessId, conn),
      readAvailability(selected.businessId, conn),
      listMovements(selected.businessId, 50, conn),
    ]);

    const identityCalc = identityOf(
      identityRow?.mainCents ?? availability.ledgerCents,
      potRows,
      identityRow?.subtreeCents ?? availability.ledgerCents,
    );

    const totalCents = identityCalc.totalCents;
    const pots: readonly PotView[] = potRows.map((pot) => ({
      potId: pot.potId,
      name: pot.name,
      purpose: pot.purpose,
      accountCode: pot.accountCode,
      accountId: pot.accountId,
      balanceCents: toCents(pot.balanceCents),
      openedAt: pot.openedAt.toISOString(),
      // Integer arithmetic on bigint, then narrowed. There is no `/ 100`
      // anywhere on this path and no float touches a money figure.
      sharePercent:
        totalCents === 0n
          ? 0
          : Number((pot.balanceCents * 100n) / totalCents),
    }));

    const identity: IdentityView = {
      mainCents: toCents(identityCalc.mainCents),
      potsCents: toCents(identityCalc.potsCents),
      totalCents: toCents(identityCalc.totalCents),
      subtreeCents: toCents(identityCalc.subtreeCents),
      differenceCents: toCents(identityCalc.totalCents - identityCalc.subtreeCents),
      holds: identityCalc.holds,
    };

    const availabilityView: AvailabilityView = {
      ledgerCents: toCents(availability.ledgerCents),
      holdsCents: toCents(availability.holdsCents),
      unclearedCents: toCents(availability.unclearedCents),
      availableCents: toCents(availability.availableCents),
    };

    const mainLabel = `${selected.legalName} — main balance`;
    const movements: readonly MovementView[] = movementRows.map((row) => {
      const potLine = {
        accountLabel: `Pot “${row.potName}”`,
        accountCode: `2100.${row.potId}`,
        amountCents: toCents(row.potAmountCents),
        side: (row.potAmountCents > 0n ? "debit" : "credit") as "debit" | "credit",
      };
      const mainLine = {
        accountLabel: mainLabel,
        accountCode: "2100",
        amountCents: toCents(row.mainAmountCents),
        side: (row.mainAmountCents > 0n ? "debit" : "credit") as "debit" | "credit",
      };
      const amount =
        row.potAmountCents < 0n ? -row.potAmountCents : row.potAmountCents;

      return {
        entryId: row.entryId,
        valueDate: row.valueDate,
        bookingSeq: row.bookingSeq.toString(),
        bookingTime: row.bookingTime.toISOString(),
        entryType: row.entryType,
        description: row.description,
        idempotencyKey: row.idempotencyKey,
        actorName: row.actorName,
        potId: row.potId,
        potName: row.potName,
        direction: row.direction,
        amountCents: toCents(amount),
        // Debit first, which is how a journal entry is read out loud.
        lines: row.direction === "in" ? [mainLine, potLine] : [potLine, mainLine],
        railColumns: {
          rail: row.rail,
          externalRef: row.externalRef,
          holdId: row.holdId,
          inboxId: row.inboxId,
        },
      };
    });

    return ok({
      source: "live",
      asOf: new Date().toISOString(),
      bookDate: day,
      businesses,
      selected,
      pots,
      identity,
      availability: availabilityView,
      movements,
      invariants: invariantViews,
      refusal:
        args.edge === true
          ? edgeRefusal(availability, potRows[0]?.name ?? "a pot")
          : null,
    });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(
      "POTS_READ_FAILED",
      "The pots read failed. No money moved: this path only reads, and the two writes on this screen are server actions raised from a form.",
      { detail: message.slice(0, 300) },
    );
  }
}
