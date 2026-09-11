/**
 * The two writes this feature has: open a pot, and move money between a pot and
 * the main balance.
 *
 * ===========================================================================
 * AN INTERNAL TRANSFER POSTS NO RAIL ENTRY.
 *
 * Two lines, one entity, one customer, one book. Both accounts are inside that
 * customer's own `2100` deposit subtree, so the entry sums to zero WITHIN the
 * customer's own money: no asset account moves, no settlement account moves, no
 * provider is called, no webhook is expected, nothing is scheduled and nothing
 * can be returned three days later. `rail = 'internal'` and `external_ref`,
 * `inbox_id` and `hold_id` are all NULL, because there is no external fact for
 * them to point at.
 *
 * That is the entire reason it is instant. Not "we made it fast" — there is
 * nothing to wait for. Every other money movement in this system is slow
 * because a third party has to agree; this one has no third party.
 *
 * WHAT IT IS NOT EXEMPT FROM. It goes through `postEntry()` like everything
 * else, which means `ledger_append()`: the advisory lock, the serialised
 * `booking_seq`, the monotonic `booking_time`, the hash chain, the
 * denormalised clocks, and the UNIQUE idempotency key. It is append-only. It
 * is bitemporal — value date and booking sequence are separate columns on it
 * exactly as they are on a card clearing. And it is reversible only in the way
 * everything here is reversible: by another entry.
 *
 * WHY NO MAKER-CHECKER. §16's threshold is on the MONEY-OUT path, and this
 * path has no money out: after the entry, the bank owes the customer exactly
 * what it owed before, to the cent, and the customer can move it straight back.
 * There is no counterparty to defraud and nothing to recall. Requiring a second
 * approver here would train people to click through approvals, which is the
 * failure mode maker-checker exists to prevent.
 * ===========================================================================
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import { postEntry } from "@/lib/ledger/post";
import { rootLogger } from "@/lib/log";

import {
  decideMove,
  moveDescription,
  moveIdempotencyKey,
  transferLegs,
  type MoveDirection,
  type RefusalCode,
} from "./model";
import {
  bookDate,
  findEntryByKey,
  findPot,
  isUuid,
  ledgerPosterActorId,
  readAvailability,
  readIdentity,
} from "./store";

const log = rootLogger.child({ module: "pots" });

/* -------------------------------------------------------------------------- */
/* Opening a pot                                                              */
/* -------------------------------------------------------------------------- */

export type OpenResult =
  | { readonly kind: "opened"; readonly potId: string; readonly accountCode: string }
  | { readonly kind: "refused"; readonly code: string; readonly reason: string };

/**
 * Open a pot: one `account` row under the customer's deposit leaf, one `pot`
 * row, both inside `pot_open()`.
 *
 * The application role holds SELECT on `account` and nothing else, so this
 * cannot be two INSERTs from here even if somebody wanted it to be. The
 * capability granted to `corgi_app` is "open a pot under this business's own
 * deposit leaf", not "INSERT on account".
 */
export async function openPot(
  args: {
    readonly businessId: string;
    readonly name: string;
    readonly purpose: string | null;
  },
  conn: Sql = sql,
): Promise<OpenResult> {
  if (!isUuid(args.businessId)) {
    return {
      kind: "refused",
      code: "NO_SUCH_BUSINESS",
      reason: "That is not a business id, so no account was looked up.",
    };
  }

  const name = args.name.trim();
  if (name.length === 0 || name.length > 60) {
    return {
      kind: "refused",
      code: "BAD_NAME",
      reason: "A pot name is 1 to 60 characters. It is how somebody refers to this money out loud.",
    };
  }

  try {
    const actorId = await ledgerPosterActorId(conn);
    const rows = await conn<{ pot_open: string }[]>`
      SELECT pot_open(
        ${args.businessId}::uuid,
        ${name},
        ${args.purpose === null || args.purpose.trim() === "" ? null : args.purpose.trim()},
        ${actorId}::uuid
      ) AS pot_open`;

    const potId = rows[0]?.pot_open;
    if (potId === undefined) {
      return {
        kind: "refused",
        code: "NO_POT_RETURNED",
        reason: "pot_open() returned no id — this should be impossible.",
      };
    }

    log.info("pot opened", { potId, businessId: args.businessId, name });
    return { kind: "opened", potId, accountCode: `2100.${potId}` };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // 23505 is the (business_id, name) unique constraint. A duplicate name is
    // the one refusal a person will actually hit, and it deserves its own
    // sentence rather than a Postgres string.
    if (message.includes("pot_name_unique")) {
      return {
        kind: "refused",
        code: "DUPLICATE_NAME",
        reason: `This business already has a pot called “${name}”. Two pots with one name would make “move it to ${name}” ambiguous, which is the only thing a pot name is for.`,
      };
    }
    log.error("pot_open failed", { businessId: args.businessId, message });
    return { kind: "refused", code: "OPEN_FAILED", reason: message.slice(0, 300) };
  }
}

/* -------------------------------------------------------------------------- */
/* Moving money                                                               */
/* -------------------------------------------------------------------------- */

export interface MoveReceipt {
  readonly entryId: string;
  readonly valueDate: string;
  readonly bookingSeq: string;
  readonly potId: string;
  readonly potName: string;
  readonly direction: MoveDirection;
  readonly amountCents: bigint;
  readonly idempotencyKey: string;
  readonly rail: "internal";
  /** True when this key had already been posted and nothing new was written. */
  readonly replay: boolean;
  readonly before: Snapshot;
  readonly after: Snapshot;
}

export interface Snapshot {
  readonly mainCents: bigint;
  readonly potCents: bigint;
  readonly potsCents: bigint;
  readonly totalCents: bigint;
  readonly availableCents: bigint;
  readonly holdsCents: bigint;
  readonly unclearedCents: bigint;
  /** Debits booked for a future value date: committed out, no hold row. */
  readonly pendingOutboundCents: bigint;
}

export type MoveResult =
  | { readonly kind: "posted"; readonly receipt: MoveReceipt }
  | {
      readonly kind: "refused";
      readonly code: RefusalCode | "NO_SUCH_POT" | "MOVE_FAILED";
      readonly reason: string;
      readonly requestedCents: bigint;
      readonly coverCents: bigint;
      readonly shortfallCents: bigint;
      readonly snapshot: Snapshot | null;
    };

/**
 * Move money between the main balance and a pot.
 *
 * The whole thing runs in ONE transaction, and the first statement in it takes
 * the lock:
 *
 *   1. `lock_business_deposits()` — a row lock over this customer's 2100 leaf
 *      and every pot beneath it, held to COMMIT. Everything after it reads a
 *      balance nobody else can move underneath it.
 *   2. read the availability and the pot's balance,
 *   3. `decideMove()` — the same pure function the screen used to draw itself,
 *      now deciding rather than forecasting,
 *   4. `postEntry()` — two lines, sum zero, rail `internal`,
 *   5. read the balances back, so the receipt shows before AND after and the
 *      caller does not have to take the arithmetic on trust.
 *
 * Steps 2 and 5 are separate reads of the same views. That is the point: the
 * "after" figures are not the "before" figures plus the amount computed in
 * TypeScript, they are what the ledger says once the entry is in it.
 */
export async function movePotFunds(
  args: {
    readonly potId: string;
    readonly direction: MoveDirection;
    readonly amountCents: bigint;
    readonly reference: string;
    readonly valueDate?: string;
  },
  conn: Sql = sql,
): Promise<MoveResult> {
  const pot = await findPot(args.potId, conn);
  if (pot === null) {
    return {
      kind: "refused",
      code: "NO_SUCH_POT",
      reason: "No pot with that id. Nothing was read and nothing was posted.",
      requestedCents: args.amountCents,
      coverCents: 0n,
      shortfallCents: 0n,
      snapshot: null,
    };
  }

  const idempotencyKey = moveIdempotencyKey(
    pot.potId,
    args.direction,
    args.reference,
  );

  try {
    return await conn.begin(async (tx) => {
      const t = tx as unknown as Sql;

      // 1. The lock. Before any balance is read, so the answer cannot go stale
      //    between the check and the posting.
      await t`SELECT lock_business_deposits(${pot.businessId}::uuid)`;

      const before = await snapshot(pot.businessId, pot.potAccountId, t);

      // A replay: this exact fact is already in the journal. Report the entry
      // that exists rather than pretending to have written a second one.
      const existing = await findEntryByKey(idempotencyKey, t);
      if (existing !== null) {
        return {
          kind: "posted" as const,
          receipt: {
            entryId: existing.entryId,
            valueDate: existing.valueDate,
            bookingSeq: existing.bookingSeq.toString(),
            potId: pot.potId,
            potName: pot.name,
            direction: args.direction,
            amountCents: args.amountCents,
            idempotencyKey,
            rail: "internal" as const,
            replay: true,
            before,
            after: before,
          },
        };
      }

      // 3. The decision, behind the lock, on figures nobody can move.
      const decision = decideMove(
        { direction: args.direction, amountCents: args.amountCents },
        {
          availability: {
            ledgerCents: before.mainCents,
            holdsCents: before.holdsCents,
            unclearedCents: before.unclearedCents,
            pendingOutboundCents: before.pendingOutboundCents,
            availableCents: before.availableCents,
          },
          potBalanceCents: before.potCents,
          potName: pot.name,
        },
      );

      if (decision.kind === "refuse") {
        log.info("pot move refused", {
          potId: pot.potId,
          code: decision.code,
          requested: decision.requestedCents.toString(),
          cover: decision.coverCents.toString(),
        });
        return {
          kind: "refused" as const,
          code: decision.code,
          reason: decision.reason,
          requestedCents: decision.requestedCents,
          coverCents: decision.coverCents,
          shortfallCents: decision.shortfallCents,
          snapshot: before,
        };
      }

      const valueDate = args.valueDate ?? (await bookDate(t));
      const actorId = await ledgerPosterActorId(t);
      const legs = transferLegs({
        mainAccountId: pot.mainAccountId,
        potAccountId: pot.potAccountId,
        potName: pot.name,
        direction: args.direction,
        amountCents: args.amountCents,
      });

      // 4. Through postEntry(), like every other money write in the system.
      const entryId = await postEntry(
        {
          entityId: pot.entityId,
          valueDate,
          book: "financial",
          entryType: "original",
          description: moveDescription(pot.name, args.direction, args.reference),
          idempotencyKey,
          actorId,
          rail: "internal",
          lines: legs.map((leg) => ({
            accountId: leg.accountId,
            amountCents: leg.amountCents,
            memo: leg.memo,
          })),
        },
        t,
      );

      // 5. Read it back rather than compute it.
      const after = await snapshot(pot.businessId, pot.potAccountId, t);
      const posted = await findEntryByKey(idempotencyKey, t);

      log.info("pot move posted", {
        entryId,
        potId: pot.potId,
        direction: args.direction,
        amountCents: args.amountCents.toString(),
      });

      return {
        kind: "posted" as const,
        receipt: {
          entryId,
          valueDate,
          bookingSeq: posted?.bookingSeq.toString() ?? "unknown",
          potId: pot.potId,
          potName: pot.name,
          direction: args.direction,
          amountCents: args.amountCents,
          idempotencyKey,
          rail: "internal" as const,
          replay: false,
          before,
          after,
        },
      };
    });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    log.error("pot move failed", { potId: args.potId, message });
    return {
      kind: "refused",
      code: "MOVE_FAILED",
      reason: message.slice(0, 300),
      requestedCents: args.amountCents,
      coverCents: 0n,
      shortfallCents: 0n,
      snapshot: null,
    };
  }
}

/**
 * Every figure the screen shows, at one instant, from the views.
 *
 * `potCents` is read from `v_pot_balance` by ACCOUNT rather than by pot id so
 * that the before/after pair is a sum over `journal_line` on both sides and the
 * "after" is never the "before" with arithmetic done to it.
 */
async function snapshot(
  businessId: string,
  potAccountId: string,
  conn: Sql,
): Promise<Snapshot> {
  const [identity, availability, potRows] = await Promise.all([
    readIdentity(businessId, conn),
    readAvailability(businessId, conn),
    conn<{ balance_cents: bigint }[]>`
      SELECT COALESCE(balance_cents, 0)::bigint AS balance_cents
        FROM v_pot_balance WHERE account_id = ${potAccountId}::uuid`,
  ]);

  return {
    mainCents: identity?.mainCents ?? availability.ledgerCents,
    potCents: potRows[0]?.balance_cents ?? 0n,
    potsCents: identity?.potsCents ?? 0n,
    totalCents: identity?.totalCents ?? availability.ledgerCents,
    availableCents: availability.availableCents,
    holdsCents: availability.holdsCents,
    unclearedCents: availability.unclearedCents,
    pendingOutboundCents: availability.pendingOutboundCents,
  };
}
