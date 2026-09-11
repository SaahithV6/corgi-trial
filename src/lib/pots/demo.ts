/**
 * Stand up believable pots for a demo business, idempotently.
 *
 * Why this exists as a module rather than as a one-off script somebody ran
 * once: the figures on `/pots` are real money on a live database, and "how did
 * that get there" has to be answerable by pointing at code rather than at a
 * terminal that has been closed. Every write here goes through the same
 * `openPot()` and `movePotFunds()` the screen's form calls — there is no seed
 * path that reaches the journal by another route.
 *
 * IDEMPOTENT IN BOTH HALVES, by two different mechanisms and neither of them an
 * `if`:
 *
 *   the pots       `UNIQUE (business_id, name)`; a second run is refused with
 *                  DUPLICATE_NAME and the existing pot is looked up.
 *   the transfers  `UNIQUE journal_entry.idempotency_key`, derived from the pot,
 *                  the direction and a FIXED reference — so the second run
 *                  replays and writes nothing rather than doubling the money.
 *
 * Run it with the gated test:
 *
 *   set -a; . ./.env; set +a; RUN_POT_DEMO=1 pnpm vitest run src/lib/pots/demo
 */

import "server-only";

import { formatUsd } from "@/lib/format/money";
import { sql, type Sql } from "@/lib/ledger/db";

import { listPots, readAvailability, readIdentity } from "./store";
import { movePotFunds, openPot } from "./transfer";

export interface DemoPotPlan {
  readonly name: string;
  readonly purpose: string;
  readonly amountCents: bigint;
  /** The source fact the idempotency key is derived from. Fixed, not generated. */
  readonly reference: string;
}

/** What a business plausibly sets aside, and why. */
export const DEMO_POTS: readonly DemoPotPlan[] = [
  {
    name: "Payroll — October",
    purpose: "Wages and payroll taxes for the October run, ring-fenced on the 1st",
    amountCents: 1_200_000n, // $12,000.00
    reference: "payroll-2026-10",
  },
  {
    name: "Sales tax",
    purpose: "State sales tax collected this quarter, held until the filing date",
    amountCents: 340_000n, // $3,400.00
    reference: "salestax-2026-q3",
  },
];

export interface DemoStep {
  readonly step: string;
  readonly detail: string;
}

export interface DemoOutcome {
  readonly steps: readonly DemoStep[];
  readonly before: string;
  readonly after: string;
}

async function describeBalances(businessId: string, conn: Sql): Promise<string> {
  const [identity, availability, pots] = await Promise.all([
    readIdentity(businessId, conn),
    readAvailability(businessId, conn),
    listPots(businessId, conn),
  ]);
  const potList = pots
    .map((p) => `${p.name}=${formatUsd(p.balanceCents)}`)
    .join(", ");
  return [
    `main=${formatUsd(identity?.mainCents ?? 0n)}`,
    `pots=${formatUsd(identity?.potsCents ?? 0n)}`,
    `total=${formatUsd(identity?.totalCents ?? 0n)}`,
    `subtree=${formatUsd(identity?.subtreeCents ?? 0n)}`,
    `holds=${formatUsd(availability.holdsCents)}`,
    `uncleared=${formatUsd(availability.unclearedCents)}`,
    `available=${formatUsd(availability.availableCents)}`,
    potList === "" ? "no pots" : `[${potList}]`,
  ].join(" · ");
}

export async function seedDemoPots(
  businessId: string,
  conn: Sql = sql,
): Promise<DemoOutcome> {
  const steps: DemoStep[] = [];
  const before = await describeBalances(businessId, conn);

  for (const plan of DEMO_POTS) {
    const opened = await openPot(
      { businessId, name: plan.name, purpose: plan.purpose },
      conn,
    );

    let potId: string;
    if (opened.kind === "opened") {
      potId = opened.potId;
      steps.push({
        step: `open “${plan.name}”`,
        detail: `pot ${potId}, account code ${opened.accountCode}`,
      });
    } else if (opened.code === "DUPLICATE_NAME") {
      const rows = await conn<{ id: string }[]>`
        SELECT id FROM pot
         WHERE business_id = ${businessId}::uuid AND name = ${plan.name}`;
      const existing = rows[0];
      if (existing === undefined) {
        steps.push({ step: `open “${plan.name}”`, detail: `refused: ${opened.reason}` });
        continue;
      }
      potId = existing.id;
      steps.push({
        step: `open “${plan.name}”`,
        detail: `already exists (pot ${potId}) — refused by UNIQUE (business_id, name)`,
      });
    } else {
      steps.push({ step: `open “${plan.name}”`, detail: `refused: ${opened.reason}` });
      continue;
    }

    const moved = await movePotFunds(
      {
        potId,
        direction: "in",
        amountCents: plan.amountCents,
        reference: plan.reference,
      },
      conn,
    );

    if (moved.kind === "posted") {
      const r = moved.receipt;
      steps.push({
        step: `move ${formatUsd(plan.amountCents)} into “${plan.name}”`,
        detail: r.replay
          ? `replay — entry ${r.entryId} already existed under key ${r.idempotencyKey}; nothing written`
          : `entry ${r.entryId}, seq ${r.bookingSeq}, value date ${r.valueDate}, key ${r.idempotencyKey} · ` +
            `main ${formatUsd(r.before.mainCents)} → ${formatUsd(r.after.mainCents)} · ` +
            `available ${formatUsd(r.before.availableCents)} → ${formatUsd(r.after.availableCents)} · ` +
            `total ${formatUsd(r.before.totalCents)} → ${formatUsd(r.after.totalCents)}`,
      });
    } else {
      steps.push({
        step: `move ${formatUsd(plan.amountCents)} into “${plan.name}”`,
        detail: `refused ${moved.code}: ${moved.reason}`,
      });
    }
  }

  await releaseSome(businessId, conn, steps);

  return { steps, before, after: await describeBalances(businessId, conn) };
}

/**
 * Put some of it back, so the screen shows a move in BOTH directions.
 *
 * This is the reversibility claim on the demo data rather than only in a test:
 * money leaving a pot is an ORDINARY entry — `entry_type = 'original'`, its own
 * idempotency key, its own booking sequence — and the entry that put the money
 * in is not touched, because nothing in this system can touch it. Undoing a
 * transfer is not a correction; nothing was wrong, so there is nothing to
 * reverse.
 *
 * Idempotent by the same UNIQUE index as everything else on this path.
 */
const RELEASE_FROM = "Sales tax";
const RELEASE_CENTS = 40_000n; // $400.00
const RELEASE_REFERENCE = "salestax-2026-q3-partial-release";

async function releaseSome(
  businessId: string,
  conn: Sql,
  steps: DemoStep[],
): Promise<void> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM pot
     WHERE business_id = ${businessId}::uuid AND name = ${RELEASE_FROM}`;
  const pot = rows[0];
  if (pot === undefined) return;

  const released = await movePotFunds(
    {
      potId: pot.id,
      direction: "out",
      amountCents: RELEASE_CENTS,
      reference: RELEASE_REFERENCE,
    },
    conn,
  );

  if (released.kind === "posted") {
    const r = released.receipt;
    steps.push({
      step: `release ${formatUsd(RELEASE_CENTS)} from “${RELEASE_FROM}”`,
      detail: r.replay
        ? `replay — entry ${r.entryId} already existed under key ${r.idempotencyKey}; nothing written`
        : `entry ${r.entryId}, seq ${r.bookingSeq}, value date ${r.valueDate}, key ${r.idempotencyKey} · ` +
          `main ${formatUsd(r.before.mainCents)} → ${formatUsd(r.after.mainCents)} · ` +
          `available ${formatUsd(r.before.availableCents)} → ${formatUsd(r.after.availableCents)} · ` +
          `total ${formatUsd(r.before.totalCents)} → ${formatUsd(r.after.totalCents)}`,
    });
  } else {
    steps.push({
      step: `release ${formatUsd(RELEASE_CENTS)} from “${RELEASE_FROM}”`,
      detail: `refused ${released.code}: ${released.reason}`,
    });
  }
}
