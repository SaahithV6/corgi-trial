/**
 * The whole dispute episode, against the REAL Neon database, moving REAL
 * (sandbox) money through `postEntry()`.
 *
 * Gated on RUN_DB_TESTS=1 so CI, which holds no credentials, skips rather than
 * fails. Run locally with:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test disputes.integration
 *
 * The scenario is the one the brief calls the edge case, end to end:
 *
 *   a REAL settled Lithic card clearing
 *     -> dispute raised (Visa 10.4, fraud)
 *     -> grant refused: above threshold, no second human
 *     -> authorisation refused four ways: raiser, customer, non-approver, agent
 *     -> authorised by a Corgi approver
 *     -> provisional credit granted   LEDGER up, AVAILABLE UNCHANGED
 *     -> evidence submitted
 *     -> lost
 *     -> withdrawal refused: money is outstanding, so this is a loss
 *     -> clawed back                  LEDGER down, AVAILABLE STILL UNCHANGED
 *
 * Every assertion is about MONEY or about a REFUSAL. The two that matter most:
 *
 *   * available balance does not move once across the entire episode, which is
 *     what makes taking the credit back safe rather than an overdraft; and
 *   * the grant and the clawback are two SEPARATE entries in two different
 *     correction groups, neither of them a `reversal`, each at its own value
 *     date. That is the correction-versus-new-event decision, asserted rather
 *     than described.
 *
 * Balances are read as DELTAS, never absolutes: the ledger is append-only, so a
 * test asserting an absolute figure passes once and then asserts the order the
 * suite happened to run in.
 */
import { beforeAll, describe, expect, it } from "vitest";

import type { Sql } from "@/lib/ledger/db";

// TYPE-ONLY at module scope, and dynamically imported in `beforeAll`.
//
// Importing the module for real evaluates `src/lib/env.ts`, which refuses to
// load without a full set of keys — so a static import would make this file
// fail to COLLECT in CI, where there are deliberately no credentials, instead
// of skipping. `describe.skip` cannot skip an import.
import type * as Disputes from "./index";
import type { Refused, Transitioned } from "./index";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const suite = RUN ? describe : describe.skip;

/** The demo customer. Looked up by name so a re-seed cannot dangle a uuid. */
const CUSTOMER_NAME = "Ridgeline Robotics, Inc.";

type Actors = {
  staff: string; // Priya Raman   — Corgi ops, CANNOT approve
  raiser: string; // Dana Okonkwo  — Corgi approver; raises this case
  checker: string; // Miles Ferrara — the second Corgi approver
  customer: string; // Alex Whitfield — Ridgeline's OWN approver
  agent: string; // the payments agent
};

let conn: Sql;
let disputes: typeof Disputes;
let actors: Actors;
let businessId: string;

async function actorByName(name: string): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM actor WHERE display_name = ${name} LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no actor '${name}'; run scripts/seed.mjs`);
  return row.id;
}

function refusalOf(result: Transitioned | Refused): Refused {
  if (result.kind !== "refused") {
    throw new Error(`expected a refusal, got ${result.kind} (${result.event})`);
  }
  return result;
}

beforeAll(async () => {
  if (!RUN) return;
  ({ sql: conn } = await import("@/lib/ledger/db"));
  disputes = await import("./index");

  const rows = await conn<{ id: string }[]>`
    SELECT id FROM business WHERE legal_name = ${CUSTOMER_NAME} LIMIT 1`;
  const row = rows[0];
  if (row === undefined) throw new Error(`no business '${CUSTOMER_NAME}'; run scripts/seed.mjs`);
  businessId = row.id;

  actors = {
    staff: await actorByName("Priya Raman"),
    raiser: await actorByName("Dana Okonkwo"),
    checker: await actorByName("Miles Ferrara"),
    customer: await actorByName("Alex Whitfield"),
    agent: await actorByName("Corgi payments agent"),
  };

  await settleAnythingLeftOpen();
});

/**
 * A suite that moves REAL money must not leave any.
 *
 * An earlier run that failed an assertion halfway through leaves a case with
 * provisional credit advanced and a live hold on the customer's account. The
 * next run would then measure its deltas against a book that is already
 * carrying someone else's outstanding advance, and — worse — the customer would
 * sit indefinitely holding money on a case nobody is working.
 *
 * So every open case belonging to this customer is driven to a terminal state
 * first, through the ordinary transitions and the ordinary postings. Nothing is
 * deleted and nothing is edited: an abandoned case is CLOSED, exactly the way a
 * real one would be, and the entries it made stand for ever.
 */
async function settleAnythingLeftOpen(): Promise<void> {
  for (const open of await disputes.listDisputeStates({ businessId, limit: 50 }, conn)) {
    if (open.isClosed) continue;

    if (open.granted) {
      // Money is outstanding. That is a loss, not a withdrawal.
      if (!open.lost && !open.won) {
        await disputes.recordDecision(
          {
            disputeId: open.id,
            outcome: "lost",
            actorId: actors.checker,
            detail: "Abandoned by an interrupted test run; closed as lost.",
          },
          conn,
        );
      }
      await disputes.clawBackCredit(
        {
          disputeId: open.id,
          actorId: actors.checker,
          detail: "Advance recovered when the abandoned case was closed.",
        },
        conn,
      );
      continue;
    }

    // Nothing advanced: the charge is simply released back.
    await disputes.recordDecision(
      {
        disputeId: open.id,
        outcome: "withdrawn",
        actorId: actors.staff,
        detail: "Abandoned by an interrupted test run; withdrawn, no money moved.",
      },
      conn,
    );
  }
}

suite("a dispute lost after provisional credit was granted", () => {
  it("runs the whole episode and never moves available balance", async () => {
    // ---- the subject: a real settled card charge with money still on it ----
    const charges = await disputes.listDisputableCharges({ businessId, limit: 10 }, conn);
    const charge = charges[0];
    expect(charge, "no disputable card charge in this customer's book").toBeDefined();
    if (charge === undefined) return;

    const amount = charge.netChargeCents - charge.alreadyClaimedCents;
    expect(amount).toBeGreaterThan(0n);

    const before = await disputes.customerBalance(charge.accountId, conn);

    // ---- intake -------------------------------------------------------
    const raised = await disputes.raiseDispute(
      {
        disputedEntryId: charge.entryId,
        reason: "fraud",
        network: "visa",
        networkCode: "10.4",
        narrative:
          "Cardholder states the card was in their possession and they did not make this purchase.",
        amountCents: amount,
        // Raised by an APPROVER on purpose: that is what makes the
        // maker-checker refusal below reachable at all. An operator who cannot
        // approve is refused one clause earlier, by `can_approve`.
        actorId: actors.raiser,
      },
      conn,
    );
    expect(raised.kind).toBe("raised");
    if (raised.kind !== "raised") return;
    const disputeId = raised.disputeId;

    // Raising a claim moves NO money. The customer is not made whole by
    // complaining; they are made whole by a decision to advance.
    const afterIntake = await disputes.customerBalance(charge.accountId, conn);
    expect(afterIntake.ledgerCents).toBe(before.ledgerCents);
    expect(afterIntake.availableCents).toBe(before.availableCents);

    // ---- maker-checker, four refusals ---------------------------------
    if (raised.needsAuthorization) {
      const noChecker = refusalOf(
        await disputes.grantProvisionalCredit({ disputeId, actorId: actors.raiser }, conn),
      );
      expect(noChecker.code).toBe("NEEDS_AUTHORIZATION");

      // 1. the initiator can never authorise their own case
      const selfAuth = refusalOf(
        await disputes.authorizeProvisionalCredit({ disputeId, actorId: actors.raiser }, conn),
      );
      expect(selfAuth.code).toBe("REFUSED_BY_POLICY");
      expect(selfAuth.message).toMatch(/maker-checker/i);

      // 2. neither can the CUSTOMER we would be advancing the money to, even
      //    though they hold can_approve on their own account's payments. This
      //    clause has no analogue in 0007 and it is the one a dispute needs:
      //    the counterparty to an advance cannot authorise it.
      const customerAuth = refusalOf(
        await disputes.authorizeProvisionalCredit({ disputeId, actorId: actors.customer }, conn),
      );
      expect(customerAuth.code).toBe("REFUSED_BY_POLICY");
      expect(customerAuth.message).toMatch(/customer business/i);

      // 3. nor an operator who is not an approver
      const staffAuth = refusalOf(
        await disputes.authorizeProvisionalCredit({ disputeId, actorId: actors.staff }, conn),
      );
      expect(staffAuth.code).toBe("REFUSED_BY_POLICY");
      expect(staffAuth.message).toMatch(/not an approver/i);

      // 4. and never the agent surface
      const agentAuth = refusalOf(
        await disputes.authorizeProvisionalCredit({ disputeId, actorId: actors.agent }, conn),
      );
      expect(agentAuth.code).toBe("REFUSED_BY_POLICY");
      expect(agentAuth.message).toMatch(/not an approver/i);

      // Not one of those refusals moved money.
      const afterRefusals = await disputes.customerBalance(charge.accountId, conn);
      expect(afterRefusals.ledgerCents).toBe(before.ledgerCents);

      const authorized = await disputes.authorizeProvisionalCredit(
        { disputeId, actorId: actors.checker, detail: "Case reviewed; advance approved." },
        conn,
      );
      expect(authorized.kind).toBe("transitioned");
    }

    // ---- the advance --------------------------------------------------
    const granted = await disputes.grantProvisionalCredit(
      { disputeId, actorId: actors.checker, detail: "Provisional credit advanced." },
      conn,
    );
    expect(granted.kind).toBe("transitioned");
    if (granted.kind !== "transitioned") return;
    expect(granted.entryIds).toHaveLength(2); // one financial, one memo

    const afterGrant = await disputes.customerBalance(charge.accountId, conn);

    // THE LEDGER MOVES: the customer's statement must show the credit on the
    // day we told them it was there.
    expect(afterGrant.ledgerCents - before.ledgerCents).toBe(amount);

    // AVAILABLE DOES NOT: the hold withholds exactly what the credit added.
    // This is the whole feature. A dispute credit is not settled funds.
    expect(afterGrant.availableCents).toBe(before.availableCents);
    expect(afterGrant.holdsCents - before.holdsCents).toBe(amount);

    // ---- evidence, then the network's answer --------------------------
    const evidence = await disputes.submitEvidence(
      { disputeId, actorId: actors.staff, detail: "Cardholder statement filed with Visa." },
      conn,
    );
    expect(evidence.kind).toBe("transitioned");

    const lost = await disputes.recordDecision(
      {
        disputeId,
        outcome: "lost",
        actorId: actors.checker,
        detail: "Network found for the merchant on representment.",
      },
      conn,
    );
    expect(lost.kind).toBe("transitioned");
    if (lost.kind !== "transitioned") return;

    // A case with money outstanding cannot simply be withdrawn.
    const cannotWithdraw = refusalOf(
      await disputes.recordDecision({ disputeId, outcome: "withdrawn", actorId: actors.staff }, conn),
    );
    expect(cannotWithdraw.code).toBe("ALREADY_DECIDED");

    // Losing, on its own, moves nothing. The money comes back on the clawback.
    const afterLoss = await disputes.customerBalance(charge.accountId, conn);
    expect(afterLoss.ledgerCents).toBe(afterGrant.ledgerCents);

    // ---- the clawback -------------------------------------------------
    const clawed = await disputes.clawBackCredit(
      { disputeId, actorId: actors.checker, detail: "Advance recovered from the customer." },
      conn,
    );
    expect(clawed.kind).toBe("transitioned");
    if (clawed.kind !== "transitioned") return;

    const afterClawback = await disputes.customerBalance(charge.accountId, conn);

    // The ledger is back where it started...
    expect(afterClawback.ledgerCents).toBe(before.ledgerCents);
    // ...the hold is gone...
    expect(afterClawback.holdsCents).toBe(before.holdsCents);
    // ...and AVAILABLE NEVER MOVED ONCE across the whole episode, which is why
    // taking the money back could not overdraw anybody.
    expect(afterClawback.availableCents).toBe(before.availableCents);

    // ---- the two entries, and why they are not one correction ---------
    const state = await disputes.readDisputeState(disputeId, conn);
    expect(state?.status).toBe("closed_lost_recovered");
    expect(state?.advancedCents).toBe(0n);
    expect(state?.heldCents).toBe(0n);
    expect(state?.holdReleased).toBe(true);

    const ledger = await disputes.listDisputeLedger(disputeId, conn);
    const financial = ledger.filter((l) => l.book === "financial");
    const grantLines = financial.filter((l) => l.eventKind === "provisional_credit_granted");
    const clawLines = financial.filter((l) => l.eventKind === "credit_clawed_back");

    expect(grantLines).toHaveLength(2);
    expect(clawLines).toHaveLength(2);

    // NEITHER is a reversal. A clawback is a new event, not a correction of the
    // grant: `reverseAndRebook` would have produced entry_type 'reversal' here,
    // carrying the grant's own value date, and erased the credit from the
    // statement of the day we told the customer it existed.
    for (const line of [...grantLines, ...clawLines]) {
      expect(line.entryType).toBe("original");
    }

    // Two entries, two booking sequences, and the clawback carries the day the
    // NETWORK decided rather than the day the credit was granted.
    const grantEntry = grantLines[0];
    const clawEntry = clawLines[0];
    expect(grantEntry).toBeDefined();
    expect(clawEntry).toBeDefined();
    if (grantEntry === undefined || clawEntry === undefined) return;
    expect(clawEntry.entryId).not.toBe(grantEntry.entryId);
    expect(clawEntry.bookingSeq).toBeGreaterThan(grantEntry.bookingSeq);
    expect(clawEntry.valueDate >= grantEntry.valueDate).toBe(true);

    // The memo book opened and released exactly once, and nets to nothing.
    const memo = ledger.filter((l) => l.book === "memo");
    expect(memo.reduce((acc, l) => acc + l.amountCents, 0n)).toBe(0n);

    // The invariant the whole hold model is protected by: a released hold
    // withholds nothing.
    const drift = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM v_hold_release_drift WHERE hold_id = ${clawed.holdId}::uuid`;
    expect(drift[0]?.n).toBe(0);
  });
});

suite("the other two ways a case can end", () => {
  /**
   * WON, after an advance.
   *
   * The interesting assertion is the one about what does NOT happen: winning
   * does not credit the customer a second time and it does not debit cash.
   * The credit was already posted on the day it was granted; winning makes it
   * SPENDABLE, which is a memo-book fact and not a financial one. And no cash
   * has arrived — the receivable stays on 1120 until a scheme file funds it,
   * because 1110's own rule is that it is debited when funds land and never
   * when a provider merely promises them.
   */
  it("won: the hold releases, available RISES, and the financial book does not move", async () => {
    const charges = await disputes.listDisputableCharges({ businessId, limit: 10 }, conn);
    const charge = charges[0];
    expect(charge).toBeDefined();
    if (charge === undefined) return;

    const amount = charge.netChargeCents - charge.alreadyClaimedCents;
    const before = await disputes.customerBalance(charge.accountId, conn);

    const raised = await disputes.raiseDispute(
      {
        disputedEntryId: charge.entryId,
        reason: "duplicate",
        network: "visa",
        networkCode: "12.6.1",
        narrative: "Cardholder was charged twice for the same purchase on the same day.",
        amountCents: amount,
        actorId: actors.raiser,
      },
      conn,
    );
    expect(raised.kind).toBe("raised");
    if (raised.kind !== "raised") return;

    if (raised.needsAuthorization) {
      await disputes.authorizeProvisionalCredit({ disputeId: raised.disputeId, actorId: actors.checker }, conn);
    }
    const granted = await disputes.grantProvisionalCredit(
      { disputeId: raised.disputeId, actorId: actors.checker },
      conn,
    );
    expect(granted.kind).toBe("transitioned");

    const afterGrant = await disputes.customerBalance(charge.accountId, conn);
    expect(afterGrant.availableCents).toBe(before.availableCents);

    await disputes.recordDecision(
      { disputeId: raised.disputeId, outcome: "won", actorId: actors.checker },
      conn,
    );

    const finalized = await disputes.finalizeCredit(
      { disputeId: raised.disputeId, actorId: actors.checker },
      conn,
    );
    expect(finalized.kind).toBe("transitioned");
    if (finalized.kind !== "transitioned") return;

    // ONE entry, and it is the memo release. Winning posts nothing financial.
    expect(finalized.entryIds).toHaveLength(1);

    const afterWin = await disputes.customerBalance(charge.accountId, conn);
    expect(afterWin.ledgerCents).toBe(afterGrant.ledgerCents);
    // NOW available rises — the money is finally the customer's to spend.
    expect(afterWin.availableCents - before.availableCents).toBe(amount);

    const ledger = await disputes.listDisputeLedger(raised.disputeId, conn);
    const financialEntries = new Set(
      ledger.filter((l) => l.book === "financial").map((l) => l.entryId),
    );
    expect(financialEntries.size).toBe(1); // the grant, and nothing else

    const state = await disputes.readDisputeState(raised.disputeId, conn);
    expect(state?.status).toBe("closed_won");
    expect(state?.heldCents).toBe(0n);
  });

  /**
   * LOST, and WE eat it.
   *
   * Somebody always absorbs a lost dispute. `clawBackCredit` says the customer
   * repays; this says we do, and the cost lands on 5200, whose own note in the
   * chart of accounts names exactly this case. Making the choice an explicit
   * operator action is the point: the alternative is a codebase that silently
   * decides who pays.
   */
  it("lost and written off: the customer keeps the money and 5200 carries the cost", async () => {
    const charges = await disputes.listDisputableCharges({ businessId, limit: 10 }, conn);
    const charge = charges[0];
    expect(charge).toBeDefined();
    if (charge === undefined) return;

    const amount = charge.netChargeCents - charge.alreadyClaimedCents;
    const before = await disputes.customerBalance(charge.accountId, conn);
    const lossBefore = await lossAccountCents();

    const raised = await disputes.raiseDispute(
      {
        disputedEntryId: charge.entryId,
        reason: "goods_not_received",
        network: "visa",
        networkCode: "13.1",
        narrative: "Cardholder paid for a delivery that never arrived and the merchant is unreachable.",
        amountCents: amount,
        actorId: actors.raiser,
      },
      conn,
    );
    expect(raised.kind).toBe("raised");
    if (raised.kind !== "raised") return;

    if (raised.needsAuthorization) {
      await disputes.authorizeProvisionalCredit({ disputeId: raised.disputeId, actorId: actors.checker }, conn);
    }
    await disputes.grantProvisionalCredit({ disputeId: raised.disputeId, actorId: actors.checker }, conn);
    await disputes.recordDecision(
      { disputeId: raised.disputeId, outcome: "lost", actorId: actors.checker },
      conn,
    );

    const written = await disputes.writeOffCredit(
      {
        disputeId: raised.disputeId,
        actorId: actors.checker,
        detail: "Below our recovery threshold; absorbed rather than taken back off the customer.",
      },
      conn,
    );
    expect(written.kind).toBe("transitioned");

    const after = await disputes.customerBalance(charge.accountId, conn);
    // The customer KEEPS the credit, and it is now spendable.
    expect(after.ledgerCents - before.ledgerCents).toBe(amount);
    expect(after.availableCents - before.availableCents).toBe(amount);

    // And the cost is ours, visibly, on the account whose note names this case.
    expect((await lossAccountCents()) - lossBefore).toBe(amount);

    const state = await disputes.readDisputeState(raised.disputeId, conn);
    expect(state?.status).toBe("closed_lost_written_off");
  });
});

/** 5200 in natural (debit-positive) terms. */
async function lossAccountCents(): Promise<bigint> {
  const rows = await conn<{ cents: bigint }[]>`
    SELECT COALESCE(SUM(natural_cents), 0)::bigint AS cents
      FROM v_trial_balance WHERE code = '5200'`;
  return rows[0]?.cents ?? 0n;
}
