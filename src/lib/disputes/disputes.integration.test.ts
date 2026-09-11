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
 *
 * ===========================================================================
 * EVERY EPISODE RUNS INSIDE A TRANSACTION THAT IS ROLLED BACK
 * ===========================================================================
 *
 * Three real dispute cases per run against the SEEDED DEMO CUSTOMER, with
 * their provisional credits, their holds and their clawbacks — eight journal
 * entries and three live holds, every one of them showing on the disputes
 * screen as a case somebody would have to work. Twenty-eight cases are on the
 * live book and stay there, because a money table has no DELETE. This run adds
 * none. Per-run cost: 3 cases / 8 entries / 3 holds before, ZERO after.
 *
 * The case is really raised, the trigger really fires, the hold is really
 * opened and released and `v_hold_release_drift` is really consulted — and
 * then the transaction is thrown away. The rule and the exemptions are written
 * up in `docs/TESTING.md`; the pattern is the one proved in
 * `src/lib/fx/fx.integration.test.ts`.
 *
 * TWO THINGS ARE NOT WRAPPED, and neither costs a row:
 *
 *   ▸ "refuses a dispute raised against a clawback entry, at the trigger" —
 *     the INSERT is refused by `assert_dispute_intake()`, so nothing is
 *     written. It reads a clawback out of the committed book to aim at; those
 *     exist permanently — nine of them today — and cannot be removed. On a
 *     database reset to zero it would find none and this suite would have to
 *     be run twice, which is the price of not manufacturing a clawback to
 *     delete afterwards.
 *   ▸ "returns every dispute line exactly once" — a standing invariant read
 *     over the whole book. It writes nothing and a rollback would only narrow
 *     what it can see.
 *
 * `settleAnythingLeftOpen()` in `beforeAll` also still COMMITS, on purpose:
 * see its own note. It is remediation for runs that predate this change, not
 * per-run cost, and it is a no-op the moment there is nothing left open.
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

/** What postgres.js hands a transaction body. Structural, to avoid the import. */
type Scoped = {
  savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

/**
 * Give a transaction handle the `.begin()` that the dispute operations call.
 *
 * `grantProvisionalCredit`, `clawBackCredit` and their siblings each wrap the
 * event row, the journal entry and the hold movement in one `conn.begin(...)`
 * — which is the whole safety argument: a granted credit whose hold did not
 * open is money the customer can spend twice. But postgres.js puts `begin` on
 * the POOL only; a transaction scope gets `savepoint`, and the two are the
 * same function internally (`scope(c, fn, name)`) differing only in whether a
 * savepoint name is issued. Without this shim every operation throws
 * `conn.begin is not a function`, and the only way to run an episode inside a
 * transaction would be to stop calling the production code.
 *
 * `Sql(handler)` builds a fresh object per scope, so this adds the property to
 * this transaction's handle and to nothing else.
 */
function nested(handle: unknown): Sql {
  const scoped = handle as Scoped;
  if (typeof scoped.begin !== "function") {
    scoped.begin = (first: unknown, second?: unknown) => {
      const body = (typeof first === "function" ? first : second) as (
        inner: unknown,
      ) => Promise<unknown>;
      return scoped.savepoint((inner) => Promise.resolve(body(nested(inner))));
    };
  }
  return handle as Sql;
}

const ROLLBACK = "disputes-integration-rollback";

/**
 * Run an episode against the live database and then throw it away.
 *
 * Anything that is not the sentinel is a real failure — a broken assertion or
 * a statement Postgres refused — and is rethrown so the run goes red. It
 * rolled back either way.
 */
async function rolledBack(body: (tx: Sql) => Promise<void>): Promise<void> {
  let failure: unknown = null;
  try {
    await conn.begin(async (raw) => {
      await body(nested(raw));
      throw new Error(ROLLBACK);
    });
  } catch (thrown) {
    if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) failure = thrown;
  }
  if (failure !== null) throw failure;
}

/**
 * Run one call on a SAVEPOINT and roll that savepoint back, keeping its value.
 *
 * THIS IS THE ONE THING THE ROLLBACK GENUINELY CHANGED IN THIS FILE, and it is
 * a finding about the code rather than about the test.
 *
 * The four maker-checker refusals are `RAISE EXCEPTION` from the dispute
 * authorisation trigger. `recordEvent()` makes its INSERT directly on the
 * connection it was handed and converts the SQLSTATE into a `Refused` — which
 * is the right shape for a screen, and it means the exception never escapes.
 * Outside a transaction that was the end of it. INSIDE one it is not: by the
 * time the refusal is returned the transaction is already in the aborted
 * state, and the next statement — the `readDisputeState` that opens the SECOND
 * refusal — fails before it can ask anything. Four working controls became one
 * failure carrying the first one's message.
 *
 * A savepoint gives each refusal somewhere to land. The body must THROW to get
 * out: postgres.js issues `ROLLBACK TO SAVEPOINT` on a rejected body and
 * `RELEASE` on a resolved one, and RELEASE on an aborted subtransaction fails
 * exactly the same way — so the sentinel is thrown once the value is captured.
 *
 * Every refusal is entirely real: the trigger fires, against the live
 * database, on a row genuinely offered to it. Nothing here is relaxed, and no
 * assertion in this file was changed to make a wrapped test pass.
 */
async function onSavepoint<T>(tx: Sql, body: (scoped: Sql) => Promise<T>): Promise<T> {
  const captured: T[] = [];
  try {
    await (tx as unknown as Scoped).savepoint(async (raw) => {
      captured.push(await body(nested(raw)));
      throw new Error(ROLLBACK);
    });
  } catch (thrown) {
    if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) throw thrown;
  }
  const [value] = captured;
  if (captured.length === 0) throw new Error("the savepoint body returned nothing");
  return value as T;
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
 *
 * THIS COMMITS, AND IT HAS TO. It is not a scenario under test; it is repair
 * of the live book, and repair that is rolled back has repaired nothing. It is
 * also now the only thing in this file that can write: every episode below
 * runs inside a transaction that is discarded, so no future run can abandon a
 * case halfway and leave a customer holding an advance. What this drains is
 * the backlog left by the runs that came before, after which it is a no-op.
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
    await rolledBack(async (tx) => {
      // ---- the subject: a real settled card charge with money still on it ----
      const charges = await disputes.listDisputableCharges({ businessId, limit: 10 }, tx);
      const charge = charges[0];
      expect(charge, "no disputable card charge in this customer's book").toBeDefined();
      if (charge === undefined) return;

      const amount = charge.netChargeCents - charge.alreadyClaimedCents;
      expect(amount).toBeGreaterThan(0n);

      const before = await disputes.customerBalance(charge.accountId, tx);

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
        tx,
      );
      expect(raised.kind).toBe("raised");
      if (raised.kind !== "raised") return;
      const disputeId = raised.disputeId;

      // Raising a claim moves NO money. The customer is not made whole by
      // complaining; they are made whole by a decision to advance.
      const afterIntake = await disputes.customerBalance(charge.accountId, tx);
      expect(afterIntake.ledgerCents).toBe(before.ledgerCents);
      expect(afterIntake.availableCents).toBe(before.availableCents);

      // ---- maker-checker, four refusals ---------------------------------
      if (raised.needsAuthorization) {
        const noChecker = refusalOf(
          await disputes.grantProvisionalCredit({ disputeId, actorId: actors.raiser }, tx),
        );
        expect(noChecker.code).toBe("NEEDS_AUTHORIZATION");

        // 1. the initiator can never authorise their own case
        const selfAuth = refusalOf(
          await onSavepoint(tx, (scoped) =>
            disputes.authorizeProvisionalCredit(
              { disputeId, actorId: actors.raiser },
              scoped,
            ),
          ),
        );
        expect(selfAuth.code).toBe("REFUSED_BY_POLICY");
        expect(selfAuth.message).toMatch(/maker-checker/i);

        // 2. neither can the CUSTOMER we would be advancing the money to, even
        //    though they hold can_approve on their own account's payments. This
        //    clause has no analogue in 0007 and it is the one a dispute needs:
        //    the counterparty to an advance cannot authorise it.
        const customerAuth = refusalOf(
          await onSavepoint(tx, (scoped) =>
            disputes.authorizeProvisionalCredit(
              { disputeId, actorId: actors.customer },
              scoped,
            ),
          ),
        );
        expect(customerAuth.code).toBe("REFUSED_BY_POLICY");
        expect(customerAuth.message).toMatch(/customer business/i);

        // 3. nor an operator who is not an approver
        const staffAuth = refusalOf(
          await onSavepoint(tx, (scoped) =>
            disputes.authorizeProvisionalCredit(
              { disputeId, actorId: actors.staff },
              scoped,
            ),
          ),
        );
        expect(staffAuth.code).toBe("REFUSED_BY_POLICY");
        expect(staffAuth.message).toMatch(/not an approver/i);

        // 4. and never the agent surface
        const agentAuth = refusalOf(
          await onSavepoint(tx, (scoped) =>
            disputes.authorizeProvisionalCredit(
              { disputeId, actorId: actors.agent },
              scoped,
            ),
          ),
        );
        expect(agentAuth.code).toBe("REFUSED_BY_POLICY");
        expect(agentAuth.message).toMatch(/not an approver/i);

        // Not one of those refusals moved money.
        const afterRefusals = await disputes.customerBalance(charge.accountId, tx);
        expect(afterRefusals.ledgerCents).toBe(before.ledgerCents);

        const authorized = await disputes.authorizeProvisionalCredit(
          { disputeId, actorId: actors.checker, detail: "Case reviewed; advance approved." },
          tx,
        );
        expect(authorized.kind).toBe("transitioned");
      }

      // ---- the advance --------------------------------------------------
      const granted = await disputes.grantProvisionalCredit(
        { disputeId, actorId: actors.checker, detail: "Provisional credit advanced." },
        tx,
      );
      expect(granted.kind).toBe("transitioned");
      if (granted.kind !== "transitioned") return;
      expect(granted.entryIds).toHaveLength(2); // one financial, one memo

      const afterGrant = await disputes.customerBalance(charge.accountId, tx);

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
        tx,
      );
      expect(evidence.kind).toBe("transitioned");

      const lost = await disputes.recordDecision(
        {
          disputeId,
          outcome: "lost",
          actorId: actors.checker,
          detail: "Network found for the merchant on representment.",
        },
        tx,
      );
      expect(lost.kind).toBe("transitioned");
      if (lost.kind !== "transitioned") return;

      // A case with money outstanding cannot simply be withdrawn.
      const cannotWithdraw = refusalOf(
        await disputes.recordDecision({ disputeId, outcome: "withdrawn", actorId: actors.staff }, tx),
      );
      expect(cannotWithdraw.code).toBe("ALREADY_DECIDED");

      // Losing, on its own, moves nothing. The money comes back on the clawback.
      const afterLoss = await disputes.customerBalance(charge.accountId, tx);
      expect(afterLoss.ledgerCents).toBe(afterGrant.ledgerCents);

      // ---- the clawback -------------------------------------------------
      const clawed = await disputes.clawBackCredit(
        { disputeId, actorId: actors.checker, detail: "Advance recovered from the customer." },
        tx,
      );
      expect(clawed.kind).toBe("transitioned");
      if (clawed.kind !== "transitioned") return;

      const afterClawback = await disputes.customerBalance(charge.accountId, tx);

      // The ledger is back where it started...
      expect(afterClawback.ledgerCents).toBe(before.ledgerCents);
      // ...the hold is gone...
      expect(afterClawback.holdsCents).toBe(before.holdsCents);
      // ...and AVAILABLE NEVER MOVED ONCE across the whole episode, which is why
      // taking the money back could not overdraw anybody.
      expect(afterClawback.availableCents).toBe(before.availableCents);

      // ---- the two entries, and why they are not one correction ---------
      const state = await disputes.readDisputeState(disputeId, tx);
      expect(state?.status).toBe("closed_lost_recovered");
      expect(state?.advancedCents).toBe(0n);
      expect(state?.heldCents).toBe(0n);
      expect(state?.holdReleased).toBe(true);

      const ledger = await disputes.listDisputeLedger(disputeId, tx);
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
      const drift = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM v_hold_release_drift WHERE hold_id = ${clawed.holdId}::uuid`;
      expect(drift[0]?.n).toBe(0);
    });
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
    await rolledBack(async (tx) => {
      const charges = await disputes.listDisputableCharges({ businessId, limit: 10 }, tx);
      const charge = charges[0];
      expect(charge).toBeDefined();
      if (charge === undefined) return;

      const amount = charge.netChargeCents - charge.alreadyClaimedCents;
      const before = await disputes.customerBalance(charge.accountId, tx);

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
        tx,
      );
      expect(raised.kind).toBe("raised");
      if (raised.kind !== "raised") return;

      if (raised.needsAuthorization) {
        await disputes.authorizeProvisionalCredit({ disputeId: raised.disputeId, actorId: actors.checker }, tx);
      }
      const granted = await disputes.grantProvisionalCredit(
        { disputeId: raised.disputeId, actorId: actors.checker },
        tx,
      );
      expect(granted.kind).toBe("transitioned");

      const afterGrant = await disputes.customerBalance(charge.accountId, tx);
      expect(afterGrant.availableCents).toBe(before.availableCents);

      await disputes.recordDecision(
        { disputeId: raised.disputeId, outcome: "won", actorId: actors.checker },
        tx,
      );

      const finalized = await disputes.finalizeCredit(
        { disputeId: raised.disputeId, actorId: actors.checker },
        tx,
      );
      expect(finalized.kind).toBe("transitioned");
      if (finalized.kind !== "transitioned") return;

      // ONE entry, and it is the memo release. Winning posts nothing financial.
      expect(finalized.entryIds).toHaveLength(1);

      const afterWin = await disputes.customerBalance(charge.accountId, tx);
      expect(afterWin.ledgerCents).toBe(afterGrant.ledgerCents);
      // NOW available rises — the money is finally the customer's to spend.
      expect(afterWin.availableCents - before.availableCents).toBe(amount);

      const ledger = await disputes.listDisputeLedger(raised.disputeId, tx);
      const financialEntries = new Set(
        ledger.filter((l) => l.book === "financial").map((l) => l.entryId),
      );
      expect(financialEntries.size).toBe(1); // the grant, and nothing else

      const state = await disputes.readDisputeState(raised.disputeId, tx);
      expect(state?.status).toBe("closed_won");
      expect(state?.heldCents).toBe(0n);
    });
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
    await rolledBack(async (tx) => {
      const charges = await disputes.listDisputableCharges({ businessId, limit: 10 }, tx);
      const charge = charges[0];
      expect(charge).toBeDefined();
      if (charge === undefined) return;

      const amount = charge.netChargeCents - charge.alreadyClaimedCents;
      const before = await disputes.customerBalance(charge.accountId, tx);
      const lossBefore = await lossAccountCents(tx);

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
        tx,
      );
      expect(raised.kind).toBe("raised");
      if (raised.kind !== "raised") return;

      if (raised.needsAuthorization) {
        await disputes.authorizeProvisionalCredit({ disputeId: raised.disputeId, actorId: actors.checker }, tx);
      }
      await disputes.grantProvisionalCredit({ disputeId: raised.disputeId, actorId: actors.checker }, tx);
      await disputes.recordDecision(
        { disputeId: raised.disputeId, outcome: "lost", actorId: actors.checker },
        tx,
      );

      const written = await disputes.writeOffCredit(
        {
          disputeId: raised.disputeId,
          actorId: actors.checker,
          detail: "Below our recovery threshold; absorbed rather than taken back off the customer.",
        },
        tx,
      );
      expect(written.kind).toBe("transitioned");

      const after = await disputes.customerBalance(charge.accountId, tx);
      // The customer KEEPS the credit, and it is now spendable.
      expect(after.ledgerCents - before.ledgerCents).toBe(amount);
      expect(after.availableCents - before.availableCents).toBe(amount);

      // And the cost is ours, visibly, on the account whose note names this case.
      expect((await lossAccountCents(tx)) - lossBefore).toBe(amount);

      const state = await disputes.readDisputeState(raised.disputeId, tx);
      expect(state?.status).toBe("closed_lost_written_off");
    });
  });
});

/**
 * 5200 in natural (debit-positive) terms.
 *
 * Takes its connection rather than closing over the pool. It is called from
 * inside a rolled-back transaction, on either side of a write-off that only
 * that transaction can see, so reading the pool here would report a delta of
 * zero against a book where the cost really had landed — a passing assertion
 * about the wrong book.
 */
async function lossAccountCents(handle: Sql): Promise<bigint> {
  const rows = await handle<{ cents: bigint }[]>`
    SELECT COALESCE(SUM(natural_cents), 0)::bigint AS cents
      FROM v_trial_balance WHERE code = '5200'`;
  return rows[0]?.cents ?? 0n;
}

/**
 * INTAKE, AT THE ROW — the two guards migration 0023 moved into SQL.
 *
 * Both of these were real defects found by running the feature against the
 * live book, written down in docs/DISPUTES.md §8, and fixed in TypeScript
 * because 0019 was already applied and an applied migration is immutable.
 * 0023 moved them where they belong, and these are the tests that say so.
 */
suite("the guards that moved into the database", () => {
  /**
   * A DISPUTE CLAWBACK IS NOT A DISPUTABLE CHARGE.
   *
   * It is a card-rail entry that debits the customer, so it satisfied every
   * rule `assert_dispute_intake()` had: card, financial, a net debit on this
   * customer's deposit leaf, within the amount unclaimed. There is one such
   * case standing in the live book — a customer disputed the recovery of their
   * own provisional credit — and it is left standing, because deleting history
   * to make a guard look older than it is would be the worse crime.
   *
   * The rule: a disputable charge must ALSO CREDIT 2200, the network
   * settlement payable. That is the shape of a real clearing — the customer
   * was debited AND THE NETWORK WAS PAID — and there is no network case to
   * file against an entry that paid nobody.
   *
   * It already lived in `listDisputableCharges()`, which is a LIST. This
   * asserts it at the INSERT, where a caller that never asks the list still
   * meets it.
   */
  it("refuses a dispute raised against a clawback entry, at the trigger", async () => {
    const rows = await conn<
      {
        entry_id: string;
        account_id: string;
        memo_account_id: string;
        raised_by: string;
        policy_id: string;
      }[]
    >`
      SELECT de.entry_id, d.account_id, d.memo_account_id, d.raised_by, d.policy_id
        FROM dispute_event de
        JOIN dispute d ON d.id = de.dispute_id
       WHERE de.kind = 'credit_clawed_back' AND de.entry_id IS NOT NULL
       ORDER BY de.occurred_at DESC
       LIMIT 1`;
    const claw = rows[0];
    expect(claw).toBeDefined();
    if (claw === undefined) return;

    // The list has never offered it. That is the courtesy in front of the gate.
    const offered = await disputes.listDisputableCharges({ businessId, limit: 50 }, conn);
    expect(offered.map((c) => c.entryId)).not.toContain(claw.entry_id);

    // And now the gate itself, reached the way a script or the MCP write
    // surface would reach it: straight at the table.
    const caseRef = `TEST-CLAWBACK-${Date.now()}`;
    await expect(
      conn`
        INSERT INTO dispute (case_ref, disputed_entry_id, account_id, memo_account_id,
                             reason, network, network_code, narrative, amount_cents,
                             value_date, network_outside_date, raised_by, policy_id)
        VALUES (${caseRef}, ${claw.entry_id}::uuid, ${claw.account_id}::uuid,
                ${claw.memo_account_id}::uuid, 'fraud', 'visa', '10.4',
                'A clawback is not a purchase and there is no network case to file.',
                100, book_date(now()), book_date(now()) + 120,
                ${claw.raised_by}::uuid, ${claw.policy_id}::uuid)`,
    ).rejects.toThrow(/network settlement payable|2200/i);
  });

  /**
   * ONE LINE, ONE ROW.
   *
   * `v_dispute_ledger` unions the entries an event cites with the memo entries
   * reachable through the grant's hold, and on a WON case those sets overlapped
   * in exactly one place: the finalising event cites the hold RELEASE, which is
   * also a memo posting on that hold. UNION did not collapse them because
   * `event_kind` differs, so the episode screen printed the release twice —
   * $73.40 appearing to move twice on the one screen whose whole purpose is
   * that the ledger can be checked by hand.
   *
   * It was deduped at the read with DISTINCT ON. 0023 fixes the view, by
   * ANTI-JOIN rather than by DISTINCT: the memo source yields only what the
   * events do not already carry, so a duplicate arising any OTHER way still
   * shows up — and `v_dispute_ledger_double_count` is the standing assertion
   * that none does. It is in `scripts/dbcheck.mjs`.
   */
  it("returns every dispute line exactly once, with no dedupe at the read", async () => {
    const dbl = await conn<{ n: number }[]>`
      SELECT count(*)::int AS n FROM v_dispute_ledger_double_count`;
    expect(dbl[0]?.n).toBe(0);

    // And on a won case specifically, which is where the overlap lived.
    for (const state of await disputes.listDisputeStates({ businessId, limit: 50 }, conn)) {
      if (state.status !== "closed_won") continue;
      const lines = await disputes.listDisputeLedger(state.id, conn);
      const seen = new Set(lines.map((l) => `${l.entryId}:${l.ordinal}`));
      expect(seen.size).toBe(lines.length);
    }
  });
});
