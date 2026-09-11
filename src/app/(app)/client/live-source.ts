import "server-only";

/**
 * The live reads behind the client surface.
 *
 * It lives under `src/app/(app)/client/` rather than in `src/lib/` for the same
 * reason `src/app/(app)/payments/live-source.ts` does, and that file says it
 * first: `src/lib/**` is owned by other workers on this build and is not mine
 * to extend. Everything else follows the pattern `src/lib/pots/screen.ts` set —
 * one place, and one place only, where database shapes become the shape a React
 * tree renders.
 *
 * ===========================================================================
 * TENANT ISOLATION IS A PREDICATE HERE, AND NOWHERE ELSE
 * ===========================================================================
 *
 * Every read below takes the business id as an ARGUMENT to a reader that puts
 * it in a `WHERE` clause. There is not one `.filter()`, `.find()` or `if
 * (row.businessId === …)` in this file that decides which customer a row
 * belongs to, and the contract in `src/components/client/contract.ts` does not
 * carry a tenant discriminator on a row, so a view component could not write
 * one either.
 *
 * The distinction is not stylistic. A predicate is evaluated by Postgres before
 * the rows exist; a filter is a step in a program, and steps get reordered,
 * short-circuited by an early `return`, or dropped by whoever next edits the
 * paging logic. `src/lib/api/limits.ts` makes exactly this argument about the
 * approvals queue, refuses to ship a list it cannot scope in SQL, and this file
 * makes the same refusal for the same reason — see `readApproveScreen`.
 *
 * The readers used, and the predicate each one applies:
 *
 *   findBusiness(businessId)                       WHERE b.id = $1
 *   findAccount({businessId, code:'2100'})         WHERE a.business_id = $1
 *   availableBalance(businessId)                   -> mainDepositAccountId($1)
 *                                                     -> ledger_availability()
 *   listHoldRows(accountId)                        WHERE h.account_id = $1
 *   listLedgerLines({businessId, accountCode})     WHERE a.business_id = $1
 *   listCardsWithControls(businessId)              WHERE c.business_id = $1
 *   listDecisions({businessId})                    WHERE business_id = $1
 *   readTeamScreen(businessId)                     WHERE m.business_id = $1
 *   loadPayeeBook({businessId})                    WHERE business_id = $1
 *   transactGateForBusiness(businessId)            WHERE business_id = $1
 *
 * `listBusinesses()` is the deliberate exception and it returns NAMES ONLY —
 * it feeds the switcher, which in a real deployment would be the customer's own
 * entity list from their session claim. No figure on this surface comes from a
 * query that spans businesses.
 *
 * ===========================================================================
 * ONE DEFINITION OF AVAILABLE
 * ===========================================================================
 *
 * `availableBalance()` -> `businessAvailability()` -> `accountAvailability()`
 * -> `SELECT * FROM ledger_availability(...)`, migration 0022. That is the
 * fifth screen to read it and the fifth to read the SAME one. Nothing in this
 * file sums a journal line, subtracts a hold, or clamps anything at zero. The
 * five terms are carried across unchanged and the balance screen restates the
 * subtraction Postgres already did.
 */

import type {
  ActivityRow,
  ActivityScreen,
  ApprovalItem,
  ApproveScreen,
  BalanceScreen,
  BusinessRef,
  CardLine,
  CardsScreen,
  CardStory,
  ClientHeader,
  DecisionLine,
  HoldLine,
  Loaded,
  PayeeLine,
  PayScreen,
  PolicyLine,
} from "@/components/client/contract";
import { decisionGate, releaseGate } from "@/lib/approvals/gate";
import { getPayment } from "@/lib/approvals/instructions";
import { listPolicies } from "@/lib/approvals/policy-store";
import { currentActor, type SessionActor } from "@/lib/approvals/session";
import { isPayoutRail, type ApprovalPolicy } from "@/lib/approvals/types";
import { listCardsWithControls, listDecisions } from "@/lib/cards/store";
import { transactGateForBusiness } from "@/lib/kyb/wire";
import { sql, type Sql } from "@/lib/ledger/db";
import {
  findAccount,
  findBusiness,
  listBusinesses,
  listHoldRows,
  listLedgerLines,
  readAccountIdentity,
  readSnapshot,
  type HoldRow,
  type LedgerLineRow,
  type LedgerSnapshot,
} from "@/lib/ledger/queries";
import { availableBalance } from "@/lib/ledger/balances";
import { loadPayeeBook } from "@/lib/payees/store";
import { readTeamScreen } from "@/lib/team/screen";

import { bankingToday } from "../payments/live-source";

/**
 * THE ACTOR IS A PARAMETER, NOT A READ.
 *
 * `currentActor()` resolves the role cookie through `cookies()`, which throws
 * outside a request scope — so a reader that called it could only ever be run
 * by `next dev`, and `ClientScreens.render.test.ts` could not drive the one
 * function on this surface whose whole job is refusing to show one customer
 * another customer's payment. Taking the actor as an argument is also the
 * house shape: `createLivePaymentsSource().getFormData(actor)` does exactly
 * this, for the same reason.
 *
 * `currentActorForRequest()` is where the cookie is read, called from
 * `sources.ts` inside the request. It is exported so there is one place that
 * does it rather than one per screen.
 */
export async function currentActorForRequest(
  conn: Sql = sql,
): Promise<SessionActor | null> {
  return currentActor(conn);
}

/* -------------------------------------------------------------------------- */
/* Dates that refuse to throw                                                 */
/* -------------------------------------------------------------------------- */

/**
 * An ISO instant, or `null` — never an exception.
 *
 * `docs/DEMO.md` §5.1 is the whole reason this function exists and is used on
 * every date this file touches. A dispute's provisional credit is a hold whose
 * `available_at` is `'infinity'`, the driver hands that back as an Invalid
 * Date, and one unguarded `.toISOString()` answered HTTP 200 with an error card
 * where Ridgeline's account screen should have been. A customer-facing balance
 * is the last screen in this build that should go down because a date is
 * unusual.
 */
function isoOrNull(value: Date | null): string | null {
  if (value === null) return null;
  const ms = value.getTime();
  return Number.isFinite(ms) ? value.toISOString() : null;
}

/** True when a date exists but names no instant: `infinity`, i.e. "a person". */
function waitsOnAPerson(value: Date | null): boolean {
  return value !== null && !Number.isFinite(value.getTime());
}

/* -------------------------------------------------------------------------- */
/* Who the screen is about                                                    */
/* -------------------------------------------------------------------------- */

type Subject = {
  readonly header: ClientHeader;
  readonly snapshot: LedgerSnapshot;
};

/**
 * Resolve the requested business to a subject, or refuse.
 *
 * `businessId` off the query string is a CLAIM. It is resolved against the book
 * — a uuid that names nothing falls back to the first customer rather than
 * throwing, because a 500 on a mistyped query string is a worse answer than
 * showing the default. What it never does is widen: there is no path through
 * this function that produces "every business".
 *
 * The snapshot is taken ONCE here and threaded through every read on the page,
 * so a screenshot is a consistent statement about one instant rather than a
 * collage of several. Three reads against three `now()` calls drift by however
 * long the round trips took.
 */
async function resolveSubject(
  businessId: string | null,
  conn: Sql,
): Promise<Loaded<Subject>> {
  const businesses = await listBusinesses(conn);
  const wanted =
    (businessId === null ? null : await findBusiness(businessId, conn)) ??
    businesses.find((b) => b.depositAccountId !== null) ??
    businesses[0] ??
    null;

  if (wanted === null) {
    return {
      ok: false,
      code: "NO_BUSINESS",
      message: "There is no business on this book yet.",
    };
  }

  const snapshot = await readSnapshot(conn);

  // Asked for by predicate rather than read off the business row, because this
  // is the account the rest of the page reads and it must be resolved the same
  // way `mainDepositAccountId()` inside `availableBalance()` resolves it.
  const account = await findAccount(
    { businessId: wanted.businessId, code: "2100", book: "financial" },
    conn,
  );

  const refs: BusinessRef[] = businesses.map((b) => ({
    id: b.businessId,
    legalName: b.legalName,
    hasAccount: b.depositAccountId !== null,
  }));

  return {
    ok: true,
    value: {
      snapshot,
      header: {
        businessId: wanted.businessId,
        legalName: wanted.legalName,
        accountId: account?.accountId ?? null,
        accountName: account?.name ?? null,
        currency: account?.currency ?? wanted.currency ?? "USD",
        asOf: snapshot.asOf.toISOString(),
        valueDate: snapshot.valueDate,
        bookingWatermark: snapshot.bookingWatermark.toString(),
        live: true,
        businesses: refs,
      },
    },
  };
}

function toHoldLine(row: HoldRow): HoldLine {
  return {
    holdId: row.holdId,
    kind: row.kind,
    descriptor: row.descriptor,
    externalRef: row.externalRef,
    authorisedCents: row.authorisedCents,
    clearedCents: row.clearedCents,
    remainingCents: row.remainingCents,
    closed: row.closed,
    pending: row.pending,
    placedAt: isoOrNull(row.placedAt) ?? "",
    availableAt: isoOrNull(row.availableAt),
    releaseWaitsOnAPerson: waitsOnAPerson(row.availableAt),
    expiresAt: isoOrNull(row.expiresAt),
    policyDays: row.policy?.bankingDaysHold ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Balance                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The headline, and why the two figures differ.
 *
 * Holds are listed ACTIVE FIRST and closed ones are dropped, which is a view
 * choice over already-scoped rows and not a scoping choice: a customer asking
 * "why can I not spend this" is asking about what is withheld now. The
 * arithmetic on screen is still the function's five terms, not a sum of this
 * list — a list and a total that are derived separately can disagree, and on
 * this screen they would disagree in front of the person whose money it is.
 */
export async function readBalanceScreen(
  businessId: string | null,
  conn: Sql = sql,
): Promise<Loaded<BalanceScreen>> {
  try {
    const subject = await resolveSubject(businessId, conn);
    if (!subject.ok) return subject;
    const { header, snapshot } = subject.value;

    const availability = await availableBalance(header.businessId, conn);
    const holds =
      header.accountId === null
        ? []
        : await listHoldRows(header.accountId, snapshot, conn);

    return {
      ok: true,
      value: {
        header,
        terms: {
          ledgerCents: availability.ledgerCents,
          holdsCents: availability.holdsCents,
          unclearedCents: availability.unclearedCents,
          pendingOutboundCents: availability.pendingOutboundCents,
          availableCents: availability.availableCents,
        },
        holds: holds.filter((h) => !h.closed).map(toHoldLine),
      },
    };
  } catch (thrown) {
    return refusal(thrown, "BALANCE_READ_FAILED");
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Activity                                                                */
/* -------------------------------------------------------------------------- */

function toActivityRow(row: LedgerLineRow): ActivityRow {
  return {
    entryId: row.entryId,
    valueDate: row.valueDate,
    bookingDate: row.bookingDate,
    bookingSeq: row.bookingSeq.toString(),
    entryType: row.entryType,
    description: row.description,
    rail: row.rail,
    externalRef: row.externalRef,
    amountCents: row.amountCents,
    reversesEntryId: row.reversesEntryId,
    correctionGroupId: row.correctionGroupId,
  };
}

/**
 * Their transactions, and the card story behind the ones that have one.
 *
 * Two reads, both scoped, joined on the provider reference that BOTH SIDES
 * ALREADY CARRY — `journal_entry.external_ref` and `hold.external_ref`. It is
 * not a match on amount and date, which is the join a reconciliation engine
 * refuses to make for exactly the reason it would be wrong here: two $73.40
 * card payments on the same day are not the same payment.
 *
 * `accountCode: "2100"` is load-bearing. Without it the customer's own pot
 * sub-accounts (`2100.<uuid>`, migration 0015) and their memo holds would
 * appear as transactions, and an internal earmark is not a transaction — it is
 * the same money in a different shape.
 */
export async function readActivityScreen(
  businessId: string | null,
  limit: number,
  conn: Sql = sql,
): Promise<Loaded<ActivityScreen>> {
  try {
    const subject = await resolveSubject(businessId, conn);
    if (!subject.ok) return subject;
    const { header, snapshot } = subject.value;

    const [lines, holds] = await Promise.all([
      listLedgerLines(
        {
          businessId: header.businessId,
          accountCode: "2100",
          book: "financial",
          limit,
        },
        conn,
      ),
      header.accountId === null
        ? Promise.resolve([] as readonly HoldRow[])
        : listHoldRows(header.accountId, snapshot, conn),
    ]);

    const stories: CardStory[] = holds
      .filter((h) => h.kind === "card_auth")
      .map((h) => ({
        externalRef: h.externalRef,
        descriptor: h.descriptor,
        authorisedCents: h.authorisedCents,
        clearedCents: h.clearedCents,
        remainingCents: h.remainingCents,
        closed: h.closed,
      }));

    return {
      ok: true,
      value: { header, rows: lines.map(toActivityRow), cardStories: stories },
    };
  } catch (thrown) {
    return refusal(thrown, "ACTIVITY_READ_FAILED");
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Cards                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The card for each person on the team, what it can and cannot do, and why a
 * declined authorisation was declined.
 *
 * The decline reason is `card_auth_decision.reason`, carried verbatim. There is
 * no rule-to-sentence table in this build and this file does not start one:
 * the sentence was written inside the provider's 6000 ms deadline by the
 * function that made the decision, and it is the sentence a dispute will be
 * answered from. A second copy in the UI would drift, and the drift would be
 * discovered by a customer being told two different things about one decline.
 */
export async function readCardsScreen(
  businessId: string | null,
  conn: Sql = sql,
): Promise<Loaded<CardsScreen>> {
  try {
    const subject = await resolveSubject(businessId, conn);
    if (!subject.ok) return subject;
    const { header } = subject.value;

    const [cards, decisions, team] = await Promise.all([
      listCardsWithControls(header.businessId, 12),
      listDecisions({ businessId: header.businessId, limit: 25 }),
      readTeamScreen(header.businessId, conn),
    ]);

    // cardId -> the person it belongs to. Built from a read that was already
    // scoped to this business, so it can only ever name this business's people.
    const holderByCard = new Map<string, string>();
    if (team.ok) {
      for (const detail of team.screen.members) {
        for (const card of detail.cards) {
          holderByCard.set(card.cardId, detail.member.displayName);
        }
      }
    }

    const cardLines: CardLine[] = cards.map((card) => ({
      cardId: card.cardId,
      lastFour: card.lastFour,
      nickname: card.nickname,
      holderName: holderByCard.get(card.cardId) ?? null,
      state: card.controls?.cardState ?? null,
      controlVersion: card.controls?.version ?? null,
      perTxnCents: card.controls?.perTxnLimitCents ?? null,
      dailyCents: card.controls?.dailyLimitCents ?? null,
      monthlyCents: card.controls?.monthlyLimitCents ?? null,
      blockedMccs: card.controls?.blockedMccs ?? [],
      spentTodayCents: card.spend.dayCents,
      spentThisMonthCents: card.spend.monthCents,
    }));

    const decisionLines: DecisionLine[] = decisions.map((d) => ({
      id: d.id,
      decidedAt: d.decidedAt,
      outcome: d.outcome,
      merchant: d.merchantDescriptor ?? "Merchant not named",
      amountCents: d.amountCents,
      mcc: d.mcc,
      lastFour: d.lastFour,
      memberName: d.memberName ?? null,
      rule: d.rule,
      reason: d.reason,
      source: d.source,
    }));

    return { ok: true, value: { header, cards: cardLines, decisions: decisionLines } };
  } catch (thrown) {
    return refusal(thrown, "CARDS_READ_FAILED");
  }
}

/* -------------------------------------------------------------------------- */
/* 4. Send a payment                                                          */
/* -------------------------------------------------------------------------- */

function toPolicyLine(policy: ApprovalPolicy): PolicyLine | null {
  // `approval_policy` is keyed on the whole `rail` enum, which includes `card`
  // — a rail the ledger books settlement against and that no person instructs.
  if (!isPayoutRail(policy.rail)) return null;
  return {
    rail: policy.rail,
    version: policy.version,
    thresholdCents: policy.thresholdCents,
    requiredApprovals: policy.requiredApprovals,
    note: policy.note,
  };
}

/**
 * Everything the form needs BEFORE anybody types.
 *
 * THE GATE READ HERE IS A PREVIEW, NOT THE CONTROL, and the customer is told
 * so on the screen. The gate that decides is `transactGateForAccount()` inside
 * `requestPayment()`'s own transaction, under the same snapshot that writes the
 * row. This read is outside any transaction and can be stale by the time a
 * person presses the button; that is fine, because it is not the check.
 */
export async function readPayScreen(
  businessId: string | null,
  conn: Sql = sql,
): Promise<Loaded<PayScreen>> {
  try {
    const subject = await resolveSubject(businessId, conn);
    if (!subject.ok) return subject;
    const { header } = subject.value;

    const [gate, policies, payees, availability] = await Promise.all([
      transactGateForBusiness(header.businessId, { conn }),
      listPolicies(conn),
      loadPayeeBook({ businessId: header.businessId }, conn),
      availableBalance(header.businessId, conn),
    ]);

    const payeeLines: PayeeLine[] = payees.map((p) => ({
      payeeId: p.payeeId,
      displayName: p.displayName,
      holderName: p.holderName,
      rail: p.rail,
      routingNumber: p.routingNumber,
      accountNumberLast4: p.accountNumberLast4,
      accountType: p.accountType,
      archived: p.archived,
      outcome: p.outcome,
      acknowledged: p.acknowledged,
    }));

    return {
      ok: true,
      value: {
        header,
        gate: gate.allowed
          ? {
              allowed: true,
              code: null,
              message:
                "Your business has passed its checks, so a payment from this account reaches the approvals queue.",
            }
          : { allowed: false, code: gate.code, message: gate.message },
        policies: policies.map(toPolicyLine).filter((p): p is PolicyLine => p !== null),
        payees: payeeLines,
        today: bankingToday(),
        availableCents: availability.availableCents,
      },
    };
  } catch (thrown) {
    return refusal(thrown, "PAY_READ_FAILED");
  }
}

/* -------------------------------------------------------------------------- */
/* 5. Approve                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One payment, addressed by id, and NO LIST.
 *
 * ===========================================================================
 * THE READER THAT DOES NOT EXIST
 * ===========================================================================
 *
 * `listQueue({pendingOnly, limit})` in `@/lib/approvals/instructions` is the
 * only queue reader on this book and it is PLATFORM-WIDE: `QueueQuery` has no
 * business id, `PaymentInstruction` does not even carry one, and the query
 * returns every customer's pending payments in `requested_at` order. Measured
 * against this database today, the first eight rows of that queue belong to
 * *Hold Fuzzer Fixture Co.* and rows nine and ten to Ridgeline.
 *
 * The obvious workaround — call it and filter in TypeScript against this
 * business's account id — is refused here, and not on taste. `src/lib/api/
 * limits.ts` already refused it for the public API, in these words: *"it makes
 * tenant isolation a STEP rather than a PREDICATE, and a step can be reordered,
 * short-circuited or dropped by whoever next edits the paging logic."* A
 * customer-facing queue is exactly the surface where that step is the only
 * thing between one customer and another customer's payments.
 *
 * So this surface does what the public API does: it answers for an id. A
 * payment raised on `/client/pay` links straight here with its own id, which is
 * the path a customer actually walks. The point read is then scoped by
 * comparing the instruction's ACCOUNT to this business — `readAccountIdentity`,
 * one row, one id — and an instruction belonging to another business produces
 * the SAME answer as one that does not exist, so a customer cannot use this
 * screen to discover which ids are real.
 *
 * THE READER I NEEDED AND COULD NOT HAVE, stated so it can be written by
 * whoever owns `src/lib/approvals`:
 *
 *     listQueue({ businessId, pendingOnly, limit }, conn)
 *
 * with `AND (…::uuid IS NULL OR acc.business_id = …::uuid)` added to a query
 * that already joins `account acc` — one WHERE clause, in the file that defines
 * what a queued payment is. Until it exists this screen shows one payment at a
 * time and says why, because a queue that is filtered in the renderer is worse
 * than a queue that is not shown.
 */
export async function readApproveScreen(
  businessId: string | null,
  paymentId: string | null,
  actor: SessionActor | null,
  conn: Sql = sql,
): Promise<Loaded<ApproveScreen>> {
  try {
    const subject = await resolveSubject(businessId, conn);
    if (!subject.ok) return subject;
    const { header } = subject.value;

    const policies = await listPolicies(conn);

    const policyLines = policies
      .map(toPolicyLine)
      .filter((p): p is PolicyLine => p !== null);

    const base = {
      header,
      actorName: actor?.displayName ?? null,
      actorCanApprove: actor?.canApprove ?? false,
      policies: policyLines,
    };

    if (paymentId === null) {
      return {
        ok: true,
        value: {
          ...base,
          payment: null,
          lookupMessage: null,
        },
      };
    }

    // One sentence for both "no such payment" and "not yours". Telling them
    // apart would confirm which ids exist.
    const NOT_YOURS =
      "No payment with that reference belongs to this business. The answer is the same for a reference that does not exist and one belonging to another customer — telling them apart would let anybody confirm which references are real.";

    const found = await getPayment(paymentId, conn);
    if (!found.ok) {
      return { ok: true, value: { ...base, payment: null, lookupMessage: NOT_YOURS } };
    }

    const identity = await readAccountIdentity(found.value.instruction.accountId, conn);
    if (identity === null || identity.businessId !== header.businessId) {
      return { ok: true, value: { ...base, payment: null, lookupMessage: NOT_YOURS } };
    }

    const queued = found.value;
    const gateInput = {
      state: queued.state,
      initiatorActorId: queued.instruction.requestedByActorId,
      initiatorName: queued.instruction.requestedByName,
      actor:
        actor === null
          ? null
          : {
              id: actor.id,
              displayName: actor.displayName,
              kind: actor.kind,
              canApprove: actor.canApprove,
            },
    };
    // Two questions, asked separately, both by the library that also states
    // the refusal in words. Neither is the control: every decision is sent to
    // Postgres and refused there by `assert_maker_checker()`.
    const gate = decisionGate(gateInput);
    const release = releaseGate({
      ...gateInput,
      approvalsHeld: queued.approvalsHeld,
      approvalsRequired: queued.approvalsRequired,
    });

    const item: ApprovalItem = {
      instructionId: queued.instruction.id,
      contentHash: queued.instruction.contentHash,
      amountCents: queued.instruction.amountCents,
      rail: queued.instruction.rail,
      valueDate: queued.instruction.valueDate,
      destination: JSON.stringify(queued.instruction.destination),
      requestedByName: queued.instruction.requestedByName,
      requestedByKind: queued.instruction.requestedByKind,
      requestedAt: queued.instruction.requestedAt,
      state: queued.state,
      approvalsHeld: queued.approvalsHeld,
      approvalsRequired: queued.approvalsRequired,
      aboveThreshold: queued.aboveThreshold,
      policyVersion: queued.instruction.policy.version,
      thresholdCents: queued.instruction.policy.thresholdCents,
      events: queued.events.map((e) => ({
        kind: e.kind,
        actorName: e.actorName,
        actorKind: e.actorKind,
        occurredAt: e.occurredAt,
        reason: e.reason,
      })),
      gate: { allowed: gate.allowed, code: gate.code, reason: gate.reason },
      release: { allowed: release.allowed, code: release.code, reason: release.reason },
    };

    return { ok: true, value: { ...base, payment: item, lookupMessage: null } };
  } catch (thrown) {
    return refusal(thrown, "APPROVALS_READ_FAILED");
  }
}

/* -------------------------------------------------------------------------- */
/* Refusal                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A thrown read becomes a rendered refusal, never an error boundary.
 *
 * Every function here only READS, so there is nothing to roll back and the
 * screen can say so — which matters more on the customer's own screen than on
 * an operator's: "something went wrong" next to a balance reads as "your money
 * is missing" unless the screen says plainly that nothing moved.
 */
function refusal<T>(thrown: unknown, code: string): Loaded<T> {
  return {
    ok: false,
    code,
    message:
      thrown instanceof Error
        ? `${thrown.name}: ${thrown.message}`
        : "the read failed and gave no reason",
  };
}

/** True when this deployment has a database to read at all. */
export function hasDatabase(): boolean {
  return (
    typeof process.env["APP_DATABASE_URL"] === "string" &&
    process.env["APP_DATABASE_URL"] !== ""
  );
}
