/**
 * The dispute lifecycle, as operations.
 *
 * ---------------------------------------------------------------------------
 * ONE TRANSACTION PER TRANSITION, AND THE EVENT IS INSIDE IT
 * ---------------------------------------------------------------------------
 *
 * Every function here opens one transaction that does all of: the hold row, the
 * journal posting through `postEntry()`, and the `dispute_event` row that cites
 * them. That ordering is the whole safety argument. `assert_dispute_lifecycle()`
 * fires on the INSERT of the event, so a posting whose event the trigger
 * refuses is rolled back WITH IT — there is no window in which money has moved
 * and the case does not say so, and no window in which the case says so and the
 * money has not moved.
 *
 * It also means the trigger is not advisory. `canTransition()` in `model.ts`
 * runs first only so an operator sees a sentence instead of a SQLSTATE; if it
 * were deleted tomorrow, nothing illegal would become possible.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS OPERATOR-DRIVEN HERE
 * ---------------------------------------------------------------------------
 *
 * Measured against the live sandbox: Lithic has no dispute simulator —
 * `/v1/simulate/chargeback` and `/v1/simulate/dispute` both 404. So the
 * transaction and its settlement are real (a real sandbox card, a real webhook,
 * a real clearing in the financial book) and everything in THIS file is an
 * operator action: intake, the advance, the evidence, and the network's
 * verdict. `recordDecision` takes the verdict as an argument because there is
 * nobody to ask for it. Nothing here pretends otherwise.
 */

import "server-only";

import { postEntry, type Rail } from "@/lib/ledger/post";
import type { Sql } from "@/lib/ledger/db";

import {
  canTransition,
  caseRef as buildCaseRef,
  clawbackLines,
  disputeKeys,
  finalCreditLines,
  holdLines,
  networkOutsideDate,
  provisionalCreditLines,
  writeOffLines,
  type DisputeFold,
  type DisputeReason,
  type DisputeStatus,
} from "./model";
import {
  bookDate,
  closeDisputeHold,
  effectiveCardPolicy,
  heldCents,
  insertDispute,
  insertDisputeEvent,
  openDisputeHold,
  readAccountContext,
  readCardCharge,
  readDisputeState,
  type DisputeStateRow,
} from "./store";

const CARD_RAIL: Rail = "card";

export type Refused = {
  readonly kind: "refused";
  readonly code: string;
  readonly message: string;
};

export type Raised = {
  readonly kind: "raised";
  readonly disputeId: string;
  readonly caseRef: string;
  readonly amountCents: bigint;
  readonly needsAuthorization: boolean;
  readonly thresholdCents: bigint;
};

export type Transitioned = {
  readonly kind: "transitioned";
  readonly disputeId: string;
  readonly event: string;
  /** Financial and memo entry ids, in the order they were posted. */
  readonly entryIds: readonly string[];
  readonly holdId: string | null;
  readonly valueDate: string;
  readonly status: DisputeStatus;
};

function refuse(code: string, message: string): Refused {
  return { kind: "refused", code, message };
}

/**
 * Turn a trigger's `RAISE EXCEPTION` into something an operator can read.
 *
 * The SQLSTATEs are the ones 0019 uses deliberately: 42501 for a control
 * refusal (maker-checker, tenancy, a claim bigger than the charge), 55006 for
 * an illegal transition, 23502 for an event that fails to cite its money, 22007
 * for a date that cannot be. Anything else is a bug and is rethrown, because
 * swallowing an unknown database error in money code is how a system starts
 * lying quietly.
 */
const REFUSAL_STATES: Record<string, string> = {
  "42501": "REFUSED_BY_POLICY",
  "55006": "ILLEGAL_TRANSITION",
  "23502": "INCOMPLETE_EVENT",
  "22007": "IMPOSSIBLE_DATE",
  "23503": "NO_SUCH_ROW",
  "23505": "ALREADY_RECORDED",
};

function asRefusal(thrown: unknown): Refused | null {
  if (typeof thrown !== "object" || thrown === null) return null;
  const code = (thrown as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const mapped = REFUSAL_STATES[code];
  if (mapped === undefined) return null;
  const message = (thrown as { message?: unknown }).message;
  return refuse(mapped, typeof message === "string" ? message : "the database refused this");
}

function foldOf(state: DisputeStateRow): DisputeFold {
  return {
    status: state.status as DisputeStatus,
    granted: state.granted,
    declined: state.declined,
    decided: state.won || state.lost || state.withdrawn,
    needsAuthorization: state.needsAuthorization,
    authorizations: state.authorizations,
    requiredApprovals: state.requiredApprovals,
  };
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/**
 * Raise a dispute against a settled card transaction.
 *
 * The subject is an ENTRY ID, never an amount somebody typed. Everything about
 * whose money it was, which card it was, and whether any of it is still owed is
 * read off the journal — see `listDisputableCharges` — and the four intake
 * rules are enforced again by `assert_dispute_intake()` under an advisory lock,
 * so a second concurrent claim on the same charge cannot slip between the check
 * and the insert.
 */
export async function raiseDispute(
  args: {
    readonly disputedEntryId: string;
    readonly reason: DisputeReason;
    readonly network: string;
    readonly networkCode: string;
    readonly narrative: string;
    readonly amountCents: bigint;
    readonly actorId: string;
    readonly valueDate?: string;
  },
  conn: Sql,
): Promise<Raised | Refused> {
  const charge = await readCardCharge(args.disputedEntryId, conn);
  if (charge === null) {
    return refuse(
      "NOT_DISPUTABLE",
      "That entry is not a settled card transaction. Only a card-rail entry in the " +
        "financial book that debited this customer and paid the network can be disputed — " +
        "which is why an authorisation, a provisional credit and a clawback are all absent " +
        "from the list.",
    );
  }
  if (charge.netChargeCents <= 0n) {
    return refuse(
      "ALREADY_REVERSED",
      "The merchant already reversed this settlement, so the money is back and there is " +
        "nothing left to claim.",
    );
  }

  const valueDate = args.valueDate ?? (await bookDate(conn));
  const outstanding = charge.netChargeCents - charge.alreadyClaimedCents;
  if (args.amountCents > outstanding) {
    return refuse(
      "OVER_CLAIMED",
      `Only ${outstanding} cents of this ${charge.netChargeCents} cent charge is still unclaimed.`,
    );
  }

  // The customer's 9200 memo leaf comes from the chart, reached through their
  // own deposit account — never from the form.
  const accounts = await readAccountContext(charge.accountId, conn);

  const policy = await effectiveCardPolicy(valueDate, conn);
  if (policy === null) {
    return refuse(
      "NO_CARD_POLICY",
      "No card-rail approval policy is in force. Disputes cannot be judged without one.",
    );
  }

  // Short, sayable, and NOT the uuid. A customer has to be able to read it out.
  const suffix = Math.random().toString(36).slice(2, 8);

  try {
    return await conn.begin(async (tx) => {
      const disputeId = await insertDispute(
        {
          caseRef: buildCaseRef(valueDate, suffix),
          disputedEntryId: args.disputedEntryId,
          accountId: charge.accountId,
          memoAccountId: accounts.memoAccountId,
          cardId: charge.cardId,
          authId: charge.authId,
          reason: args.reason,
          network: args.network,
          networkCode: args.networkCode,
          narrative: args.narrative,
          amountCents: args.amountCents,
          valueDate,
          networkOutsideDate: networkOutsideDate(valueDate),
          raisedBy: args.actorId,
          policyId: policy.id,
        },
        tx as unknown as Sql,
      );

      await insertDisputeEvent(
        {
          disputeId,
          kind: "raised",
          actorId: args.actorId,
          valueDate,
          amountCents: args.amountCents,
          detail: args.narrative,
        },
        tx as unknown as Sql,
      );

      return {
        kind: "raised" as const,
        disputeId,
        caseRef: buildCaseRef(valueDate, suffix),
        amountCents: args.amountCents,
        needsAuthorization:
          args.amountCents >= policy.thresholdCents && policy.requiredApprovals > 0,
        thresholdCents: policy.thresholdCents,
      };
    });
  } catch (thrown) {
    const refusal = asRefusal(thrown);
    if (refusal === null) throw thrown;
    return refusal;
  }
}

// ---------------------------------------------------------------------------
// A bookkeeping-only transition: no money, one event row
// ---------------------------------------------------------------------------

async function recordEvent(
  args: {
    readonly disputeId: string;
    readonly kind:
      | "provisional_credit_authorized"
      | "provisional_credit_declined"
      | "evidence_submitted"
      | "won"
      | "lost"
      | "withdrawn";
    readonly actorId: string;
    readonly valueDate?: string;
    readonly detail?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  const state = await readDisputeState(args.disputeId, conn);
  if (state === null) return refuse("NO_SUCH_DISPUTE", "There is no such case.");

  const verdict = canTransition(foldOf(state), args.kind);
  if (!verdict.allowed) return refuse(verdict.code, verdict.message);

  const valueDate = args.valueDate ?? (await bookDate(conn));

  try {
    await insertDisputeEvent(
      {
        disputeId: args.disputeId,
        kind: args.kind,
        actorId: args.actorId,
        valueDate,
        detail: args.detail ?? null,
      },
      conn,
    );
  } catch (thrown) {
    const refusal = asRefusal(thrown);
    if (refusal === null) throw thrown;
    return refusal;
  }

  const after = await readDisputeState(args.disputeId, conn);
  return {
    kind: "transitioned",
    disputeId: args.disputeId,
    event: args.kind,
    entryIds: [],
    holdId: null,
    valueDate,
    status: (after?.status ?? state.status) as DisputeStatus,
  };
}

/** The second human. Must be a Corgi approver, not the raiser, not the customer. */
export function authorizeProvisionalCredit(
  args: { readonly disputeId: string; readonly actorId: string; readonly detail?: string },
  conn: Sql,
): Promise<Transitioned | Refused> {
  return recordEvent({ ...args, kind: "provisional_credit_authorized" }, conn);
}

/** We decline to advance. The customer is made whole on the decision, not before. */
export function declineProvisionalCredit(
  args: { readonly disputeId: string; readonly actorId: string; readonly detail?: string },
  conn: Sql,
): Promise<Transitioned | Refused> {
  return recordEvent({ ...args, kind: "provisional_credit_declined" }, conn);
}

/** Evidence filed with the network. Repeatable until a decision lands. */
export function submitEvidence(
  args: {
    readonly disputeId: string;
    readonly actorId: string;
    readonly detail?: string;
    readonly valueDate?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  return recordEvent({ ...args, kind: "evidence_submitted" }, conn);
}

/**
 * The network's verdict — OPERATOR-DRIVEN, because the sandbox has no
 * chargeback simulator to ask. `valueDate` is the day the network decided, and
 * it is the day the clawback will carry.
 */
export function recordDecision(
  args: {
    readonly disputeId: string;
    readonly outcome: "won" | "lost" | "withdrawn";
    readonly actorId: string;
    readonly valueDate?: string;
    readonly detail?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  const { outcome, ...rest } = args;
  return recordEvent({ ...rest, kind: outcome }, conn);
}

// ---------------------------------------------------------------------------
// The money
// ---------------------------------------------------------------------------

/**
 * Advance the customer their money while the network decides.
 *
 * Three writes, one transaction:
 *
 *   1. the hold row, `uncleared_credit`, `available_at = 'infinity'`;
 *   2. the FINANCIAL entry — CR the customer, DR 1120 — so their ledger balance
 *      and their statement show the credit on the day we granted it;
 *   3. the MEMO entry — CR their 9200 leaf, DR 9900 — so their AVAILABLE
 *      balance does not move at all.
 *
 * The third is the point of the feature. The credit is real and it is not
 * spendable, so if the case is lost the clawback takes back money that is still
 * there. Without the hold, losing a dispute overdraws a customer who did
 * nothing wrong.
 */
export async function grantProvisionalCredit(
  args: {
    readonly disputeId: string;
    readonly actorId: string;
    readonly valueDate?: string;
    readonly detail?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  const state = await readDisputeState(args.disputeId, conn);
  if (state === null) return refuse("NO_SUCH_DISPUTE", "There is no such case.");

  const verdict = canTransition(foldOf(state), "provisional_credit_granted");
  if (!verdict.allowed) return refuse(verdict.code, verdict.message);

  const valueDate = args.valueDate ?? (await bookDate(conn));

  try {
    return await conn.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const accounts = await readAccountContext(state.accountId, tx);

      const holdId = await openDisputeHold(
        {
          disputeId: state.id,
          accountId: state.accountId,
          memoAccountId: state.memoAccountId,
          valueDate,
        },
        tx,
      );

      const financialEntryId = await postEntry(
        {
          entityId: accounts.entityId,
          valueDate,
          book: "financial",
          description: `Provisional credit ${state.caseRef} — ${state.reason}`,
          idempotencyKey: disputeKeys.provisionalCredit(state.id),
          actorId: args.actorId,
          rail: CARD_RAIL,
          externalRef: state.caseRef,
          lines: provisionalCreditLines(accounts, state.amountCents),
        },
        tx,
      );

      const memoEntryId = await postEntry(
        {
          entityId: accounts.entityId,
          valueDate,
          book: "memo",
          description: `Hold on provisional credit ${state.caseRef}`,
          idempotencyKey: disputeKeys.holdOpen(state.id),
          actorId: args.actorId,
          rail: CARD_RAIL,
          externalRef: state.caseRef,
          holdId,
          lines: holdLines(accounts, state.amountCents),
        },
        tx,
      );

      await insertDisputeEvent(
        {
          disputeId: state.id,
          kind: "provisional_credit_granted",
          actorId: args.actorId,
          valueDate,
          amountCents: state.amountCents,
          entryId: financialEntryId,
          holdId,
          detail: args.detail ?? null,
        },
        tx,
      );

      return {
        kind: "transitioned" as const,
        disputeId: state.id,
        event: "provisional_credit_granted",
        entryIds: [financialEntryId, memoEntryId],
        holdId,
        valueDate,
        status: "provisional_credit_granted" as DisputeStatus,
      };
    });
  } catch (thrown) {
    const refusal = asRefusal(thrown);
    if (refusal === null) throw thrown;
    return refusal;
  }
}

/**
 * Release the hold behind a granted credit. Closure row FIRST, posting second —
 * availability reads "released" as the closure existing, so a crash between the
 * two leaves the customer's available balance already correct.
 */
async function releaseGrantHold(
  state: DisputeStateRow,
  args: { readonly actorId: string; readonly valueDate: string; readonly reason: string },
  tx: Sql,
): Promise<string> {
  const holdId = state.grantHoldId;
  if (holdId === null) throw new Error(`dispute ${state.id} has no grant hold to release`);

  const held = await heldCents(holdId, state.memoAccountId, tx);
  if (held <= 0n) {
    throw new Error(
      `dispute ${state.id} holds ${held} cents; there is nothing to release and the event would cite no entry`,
    );
  }

  await closeDisputeHold(holdId, args.reason, args.actorId, tx);

  const accounts = await readAccountContext(state.accountId, tx);

  const entryId = await postEntry(
    {
      entityId: accounts.entityId,
      valueDate: args.valueDate,
      book: "memo",
      description: `Release hold on provisional credit ${state.caseRef} — ${args.reason}`,
      idempotencyKey: disputeKeys.holdRelease(state.id),
      actorId: args.actorId,
      rail: CARD_RAIL,
      externalRef: state.caseRef,
      holdId,
      lines: holdLines(accounts, -held),
    },
    tx,
  );
  return entryId;
}

/**
 * The case was WON.
 *
 * With an advance: the hold releases and the credit already on the books simply
 * becomes spendable. NOTHING moves in the financial book — winning does not
 * credit the customer a second time, and it does not debit 1110 either, because
 * no cash has arrived. The receivable stays on 1120 until a scheme file funds
 * it, which is exactly what 1120 is for and exactly what reconciliation will
 * then match.
 *
 * Without an advance: the credit is posted now, final, with no hold behind it.
 */
export async function finalizeCredit(
  args: {
    readonly disputeId: string;
    readonly actorId: string;
    readonly valueDate?: string;
    readonly detail?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  const state = await readDisputeState(args.disputeId, conn);
  if (state === null) return refuse("NO_SUCH_DISPUTE", "There is no such case.");

  const verdict = canTransition(foldOf(state), "credit_finalized");
  if (!verdict.allowed) return refuse(verdict.code, verdict.message);

  const valueDate = args.valueDate ?? state.decidedOn ?? (await bookDate(conn));

  try {
    return await conn.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const entryIds: string[] = [];
      let citedEntryId: string;
      let holdId: string | null = null;

      if (state.granted) {
        holdId = state.grantHoldId;
        const memoEntryId = await releaseGrantHold(
          state,
          { actorId: args.actorId, valueDate, reason: "dispute won; provisional credit is final" },
          tx,
        );
        entryIds.push(memoEntryId);
        citedEntryId = memoEntryId;
      } else {
        const accounts = await readAccountContext(state.accountId, tx);
        const entryId = await postEntry(
          {
            entityId: accounts.entityId,
            valueDate,
            book: "financial",
            description: `Dispute ${state.caseRef} won — credit posted final`,
            idempotencyKey: disputeKeys.finalCredit(state.id),
            actorId: args.actorId,
            rail: CARD_RAIL,
            externalRef: state.caseRef,
            lines: finalCreditLines(accounts, state.amountCents),
          },
          tx,
        );
        entryIds.push(entryId);
        citedEntryId = entryId;
      }

      await insertDisputeEvent(
        {
          disputeId: state.id,
          kind: "credit_finalized",
          actorId: args.actorId,
          valueDate,
          amountCents: state.amountCents,
          entryId: citedEntryId,
          holdId,
          detail: args.detail ?? null,
        },
        tx,
      );

      return {
        kind: "transitioned" as const,
        disputeId: state.id,
        event: "credit_finalized",
        entryIds,
        holdId,
        valueDate,
        status: "closed_won" as DisputeStatus,
      };
    });
  } catch (thrown) {
    const refusal = asRefusal(thrown);
    if (refusal === null) throw thrown;
    return refusal;
  }
}

/**
 * The case was LOST, and we take the advance back.
 *
 * THIS IS A NEW EVENT, NOT A CORRECTION, and the proof is the value date: it is
 * the day the NETWORK DECIDED, supplied by the caller, and it is deliberately
 * not the grant's. `reverseAndRebook` is the wrong tool and calling it here
 * would be the bug this whole feature exists to avoid — it carries the
 * original's value date, which would erase the credit from the statement of the
 * day we told the customer it was there.
 *
 * Two entries stand afterwards, on two different days, neither one an edit of
 * the other. The hold has been live the entire time, so the money is still
 * there to take and the customer cannot be overdrawn by losing.
 *
 * `writeOff` is the same transition with the other answer to "who eats it":
 * 5200 instead of the customer's account.
 */
async function resolveLost(
  args: {
    readonly disputeId: string;
    readonly actorId: string;
    readonly recover: boolean;
    readonly valueDate?: string;
    readonly detail?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  const kind = args.recover ? "credit_clawed_back" : "credit_written_off";

  const state = await readDisputeState(args.disputeId, conn);
  if (state === null) return refuse("NO_SUCH_DISPUTE", "There is no such case.");

  const verdict = canTransition(foldOf(state), kind);
  if (!verdict.allowed) return refuse(verdict.code, verdict.message);

  // The network's decision date, not today's. See the doc comment above.
  const valueDate = args.valueDate ?? state.decidedOn ?? (await bookDate(conn));

  try {
    return await conn.begin(async (raw) => {
      const tx = raw as unknown as Sql;
      const accounts = await readAccountContext(state.accountId, tx);

      const memoEntryId = await releaseGrantHold(
        state,
        {
          actorId: args.actorId,
          valueDate,
          reason: args.recover
            ? "dispute lost; provisional credit recovered"
            : "dispute lost; provisional credit written off",
        },
        tx,
      );

      const financialEntryId = await postEntry(
        {
          entityId: accounts.entityId,
          valueDate,
          book: "financial",
          description: args.recover
            ? `Dispute ${state.caseRef} lost — provisional credit recovered`
            : `Dispute ${state.caseRef} lost — provisional credit written off`,
          idempotencyKey: args.recover
            ? disputeKeys.clawback(state.id)
            : disputeKeys.writeOff(state.id),
          actorId: args.actorId,
          rail: CARD_RAIL,
          externalRef: state.caseRef,
          lines: args.recover
            ? clawbackLines(accounts, state.amountCents)
            : writeOffLines(accounts, state.amountCents),
        },
        tx,
      );

      await insertDisputeEvent(
        {
          disputeId: state.id,
          kind,
          actorId: args.actorId,
          valueDate,
          amountCents: state.amountCents,
          entryId: financialEntryId,
          holdId: state.grantHoldId,
          detail: args.detail ?? null,
        },
        tx,
      );

      return {
        kind: "transitioned" as const,
        disputeId: state.id,
        event: kind,
        entryIds: [financialEntryId, memoEntryId],
        holdId: state.grantHoldId,
        valueDate,
        status: (args.recover
          ? "closed_lost_recovered"
          : "closed_lost_written_off") as DisputeStatus,
      };
    });
  } catch (thrown) {
    const refusal = asRefusal(thrown);
    if (refusal === null) throw thrown;
    return refusal;
  }
}

/** Lost, and the customer repays the advance. The published EDGE case. */
export function clawBackCredit(
  args: {
    readonly disputeId: string;
    readonly actorId: string;
    readonly valueDate?: string;
    readonly detail?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  return resolveLost({ ...args, recover: true }, conn);
}

/** Lost, and we absorb it. The cost lands on 5200, where the chart says it goes. */
export function writeOffCredit(
  args: {
    readonly disputeId: string;
    readonly actorId: string;
    readonly valueDate?: string;
    readonly detail?: string;
  },
  conn: Sql,
): Promise<Transitioned | Refused> {
  return resolveLost({ ...args, recover: false }, conn);
}
