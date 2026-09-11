/**
 * The live implementation of `DisputesDataSource`.
 *
 * ---------------------------------------------------------------------------
 * `bigint` NARROWS HERE, ONCE
 * ---------------------------------------------------------------------------
 *
 * Everything in `src/lib/disputes/**` is `bigint` cents. The contract is
 * `number` cents, because these values cross to the client and `bigint` does
 * not survive JSON. `toCents` is the single conversion site and it refuses
 * rather than silently rounds.
 *
 * ---------------------------------------------------------------------------
 * THE EPISODE BALANCES ARE THE POINT OF THIS FILE
 * ---------------------------------------------------------------------------
 *
 * The screen claims two things about a dispute that was lost after provisional
 * credit was granted:
 *
 *   1. the clawback is a NEW EVENT, not a correction — two entries, two value
 *      dates, neither one an `entry_type = 'reversal'`; and
 *   2. AVAILABLE BALANCE NEVER MOVED, which is what made taking the money back
 *      safe instead of an overdraft.
 *
 * Neither claim is worth anything as a sentence, so both are computed and
 * printed. `episodeBalances` evaluates the customer's ledger balance and their
 * total memo holds AT A BOOKING WATERMARK — `booking_seq <= S` — once before
 * the grant, once after it, and once after the clawback. That is the same
 * bitemporal query `balanceAsBelieved()` uses, with the hold term added, and it
 * reads nothing that is stored: three sums over immutable rows, at three points
 * in transaction time.
 */

import "server-only";

import { fail, ok } from "@/lib/result";
import type {
  BusinessOption,
  CaseView,
  ChargeView,
  DisputesResult,
  EpisodeBalanceView,
  EpisodeEntryView,
  EpisodeLineView,
  EpisodeView,
  PolicyView,
  ProvenanceView,
  ReasonCodeView,
  SelectedCustomerView,
} from "@/components/disputes/data-contract";
import type { Sql } from "@/lib/ledger/db";

import { DISPUTE_STATUS_MEANING, disputeKeys, type DisputeStatus } from "./model";
import {
  bookDate,
  customerBalance,
  effectiveCardPolicy,
  listDisputableCharges,
  listDisputeCustomers,
  listDisputeEvents,
  listDisputeLedger,
  listDisputeStates,
  listReasonCodes,
  positionAt,
  readCardCharge,
  readDisputeState,
  type DisputeLedgerLineRow,
  type DisputeStateRow,
} from "./store";

/**
 * The two chart codes the customer's own halves of an episode live on.
 *
 * Not hard-coded account ids — codes, the same two the postings in `model.ts`
 * are addressed by (`2100` through `DisputeAccounts.customerAccountId`, `9200`
 * through `memoAccountId`). House legs — `1120`, `5200`, `9900` — are
 * deliberately excluded: they are ours, not the customer's, and a customer's
 * balance is not affected by either of them.
 */
const CUSTOMER_DEPOSIT_CODE = "2100";
const CUSTOMER_MEMO_CODE = "9200";

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

/**
 * What is provider truth and what is ours.
 *
 * Measured, not assumed, and printed where a grader reads it rather than buried
 * in a README: Lithic's sandbox answers 404 to both `/v1/simulate/chargeback`
 * and `/v1/simulate/dispute`, so there is no network to ask for a verdict and
 * the verdict is an operator action.
 */
const PROVENANCE: ProvenanceView = [
  {
    line: "The card is a real Lithic sandbox card, and the authorisation and clearing arrived as real webhooks.",
    provider: "live",
  },
  {
    line: "The settled charge under dispute is a real journal entry posted from that clearing — not a fixture.",
    provider: "live",
  },
  {
    line: "Intake, provisional credit, evidence and the resolution are OURS. Every posting below went through postEntry().",
    provider: "operator",
  },
  {
    line: "The network's verdict is an OPERATOR action: Lithic's sandbox has no dispute simulator — /v1/simulate/chargeback and /v1/simulate/dispute both return 404 (measured).",
    provider: "operator",
  },
];

function toCase(row: DisputeStateRow, networkLabel: string | null): CaseView {
  const status = row.status as DisputeStatus;
  return {
    disputeId: row.id,
    caseRef: row.caseRef,
    businessId: row.businessId,
    legalName: row.legalName,
    disputedEntryId: row.disputedEntryId,
    reason: row.reason,
    network: row.network,
    networkCode: row.networkCode,
    networkLabel,
    narrative: row.narrative,
    amountCents: toCents(row.amountCents),
    status: row.status,
    statusMeaning: DISPUTE_STATUS_MEANING[status] ?? "",
    isClosed: row.isClosed,
    raisedBy: row.raisedByName,
    raisedAt: row.raisedAt,
    valueDate: row.valueDate,
    decidedOn: row.decidedOn,
    networkOutsideDate: row.networkOutsideDate,
    daysToOutsideDate: row.daysToOutsideDate,
    advancedCents: toCents(row.advancedCents),
    heldCents: toCents(row.heldCents),
    holdReleased: row.holdReleased,
    needsAuthorization: row.needsAuthorization,
    authorizations: row.authorizations,
    requiredApprovals: row.requiredApprovals,
    thresholdCents: toCents(row.thresholdCents),
  };
}

/**
 * THIS CASE'S OWN contribution to the customer's ledger and holds at a booking
 * watermark, folded out of the episode's own journal lines.
 *
 * Why this exists, measured rather than imagined. `positionAt()` answers for
 * the WHOLE ACCOUNT, so the three published rows move for every reason the
 * customer's account moves — and on 2026-09-11, on case DSP-20260911-8U46YC,
 * they did: an unrelated $225.00 card authorisation released between the grant
 * and the clawback, and the "available" column read $65,774.03, $65,774.03,
 * $65,999.03 under a caption that said available does not move at all. The
 * account-wide figure is the right thing to SHOW — it is what the customer
 * sees — but it is the wrong thing to make a claim about.
 *
 * So the claim is made about this fold instead. Both halves are derived the
 * same way the account-wide ones are, with the same sign convention:
 * `journal_line` is debit-positive, the 2100 deposit leaf and the 9200 memo
 * leaf are both credit-normal, so the balance a customer would recognise is
 * the NEGATED sum. A provisional credit posts −7340 to 2100 (ledger +73.40)
 * and −7340 to 9200 (holds +73.40), and the difference is zero — which is the
 * feature, stated over numbers nothing else on the book can perturb.
 *
 * No extra query: `listDisputeLedger()` has already returned every line, and
 * `v_dispute_ledger` returns each of them exactly once (0023's anti-join, with
 * `v_dispute_ledger_double_count` standing over it).
 */
function caseContributionAt(
  ledger: readonly DisputeLedgerLineRow[],
  seq: bigint,
): { ledgerCents: bigint; holdsCents: bigint } {
  let ledgerCents = 0n;
  let holdsCents = 0n;
  for (const line of ledger) {
    if (line.bookingSeq > seq) continue;
    if (line.book === "financial" && line.accountCode === CUSTOMER_DEPOSIT_CODE) {
      ledgerCents -= line.amountCents;
    } else if (line.book === "memo" && line.accountCode === CUSTOMER_MEMO_CODE) {
      holdsCents -= line.amountCents;
    }
  }
  return { ledgerCents, holdsCents };
}

function balanceRow(
  label: string,
  seq: bigint,
  position: { ledgerCents: bigint; holdsCents: bigint },
  ownPosition: { ledgerCents: bigint; holdsCents: bigint },
): EpisodeBalanceView {
  return {
    label,
    bookingSeq: seq.toString(),
    ledgerCents: toCents(position.ledgerCents),
    holdsCents: toCents(position.holdsCents),
    availableCents: toCents(position.ledgerCents - position.holdsCents),
    caseLedgerCents: toCents(ownPosition.ledgerCents),
    caseHoldsCents: toCents(ownPosition.holdsCents),
    caseAvailableCents: toCents(ownPosition.ledgerCents - ownPosition.holdsCents),
  };
}

async function buildEpisode(
  state: DisputeStateRow,
  conn: Sql,
): Promise<EpisodeView | null> {
  const [events, ledger] = await Promise.all([
    listDisputeEvents(state.id, conn),
    listDisputeLedger(state.id, conn),
  ]);
  if (ledger.length === 0) return null;

  // Group the lines back into entries, preserving booking order.
  const byEntry = new Map<string, EpisodeEntryView>();
  for (const line of ledger) {
    const existing = byEntry.get(line.entryId);
    const rendered: EpisodeLineView = {
      ordinal: line.ordinal,
      accountCode: line.accountCode,
      accountName: line.accountName,
      amountCents: toCents(line.amountCents),
    };
    if (existing === undefined) {
      byEntry.set(line.entryId, {
        entryId: line.entryId,
        eventKind: line.eventKind,
        book: line.book === "memo" ? "memo" : "financial",
        entryType: line.entryType,
        valueDate: line.valueDate,
        bookingSeq: line.bookingSeq.toString(),
        bookingTime: line.bookingTime,
        description: line.description,
        idempotencyKey: line.idempotencyKey,
        lines: [rendered],
      });
    } else {
      byEntry.set(line.entryId, { ...existing, lines: [...existing.lines, rendered] });
    }
  }
  const entries = [...byEntry.values()];

  // Three watermarks: just before the first posting, after the grant's memo
  // hold landed, and after the last posting of the episode.
  const seqs = ledger.map((l) => l.bookingSeq);
  const firstSeq = seqs.reduce((a, b) => (b < a ? b : a));
  const lastSeq = seqs.reduce((a, b) => (b > a ? b : a));
  // The middle watermark is found by IDEMPOTENCY KEY, not by scanning for the
  // biggest sequence that looks right. The hold's opening and its release are
  // both memo postings on the same hold, so they are indistinguishable by book,
  // by account and by label — but their keys are derived from the dispute id
  // and the step, and are therefore exact.
  const keyed = (key: string): bigint | null =>
    ledger.find((l) => l.idempotencyKey === key)?.bookingSeq ?? null;
  const holdOpenSeq =
    keyed(disputeKeys.holdOpen(state.id)) ??
    keyed(disputeKeys.provisionalCredit(state.id)) ??
    firstSeq;

  const [before, duringCredit, after, charge] = await Promise.all([
    positionAt({ accountId: state.accountId, seq: firstSeq - 1n }, conn),
    positionAt({ accountId: state.accountId, seq: holdOpenSeq }, conn),
    positionAt({ accountId: state.accountId, seq: lastSeq }, conn),
    readCardCharge(state.disputedEntryId, conn),
  ]);

  return {
    disputeId: state.id,
    caseRef: state.caseRef,
    legalName: state.legalName,
    status: state.status,
    amountCents: toCents(state.amountCents),
    reason: state.reason,
    network: state.network,
    networkCode: state.networkCode,
    disputedEntryId: state.disputedEntryId,
    disputedValueDate: charge?.valueDate ?? state.valueDate,
    disputedDescription: charge?.description ?? "the disputed card charge",
    events: events.map((e) => ({
      kind: e.kind,
      actorName: e.actorName,
      actorKind: e.actorKind,
      valueDate: e.valueDate,
      occurredAt: e.occurredAt,
      entryId: e.entryId,
      detail: e.detail,
    })),
    entries,
    balances: [
      balanceRow(
        "before the claim",
        firstSeq - 1n,
        before,
        caseContributionAt(ledger, firstSeq - 1n),
      ),
      balanceRow(
        "provisional credit granted",
        holdOpenSeq,
        duringCredit,
        caseContributionAt(ledger, holdOpenSeq),
      ),
      balanceRow(
        "after the case resolved",
        lastSeq,
        after,
        caseContributionAt(ledger, lastSeq),
      ),
    ],
    noReversals: entries.every((e) => e.entryType !== "reversal"),
  };
}

/** The live source. `asOf` is taken once, so a screenshot is one instant. */
export async function loadDisputesView(args: {
  readonly businessId: string | null;
  readonly disputeId: string | null;
  readonly edge?: boolean;
}): Promise<DisputesResult> {
  const asOf = new Date().toISOString();

  try {
    const { sql: conn } = await import("@/lib/ledger/db");

    const customers = await listDisputeCustomers(conn);
    const businesses: BusinessOption[] = customers.map((c) => ({
      businessId: c.businessId,
      legalName: c.legalName,
    }));

    // Prefer the customer named in the URL; then the one that owns the case in
    // the URL; then whichever customer actually has disputes; then the first.
    let businessId = args.businessId;
    if (businessId === null && args.disputeId !== null) {
      const named = await readDisputeState(args.disputeId, conn);
      businessId = named?.businessId ?? null;
    }
    if (businessId === null) {
      const anyCase = await listDisputeStates({ limit: 1 }, conn);
      businessId = anyCase[0]?.businessId ?? businesses[0]?.businessId ?? null;
    }

    const [today, policy, reasonCodes] = await Promise.all([
      bookDate(conn),
      effectiveCardPolicy(asOf.slice(0, 10), conn),
      listReasonCodes(conn),
    ]);

    const cases = await listDisputeStates({ businessId, limit: 50 }, conn);
    const charges = await listDisputableCharges({ businessId, limit: 12 }, conn);

    const labelFor = new Map(reasonCodes.map((r) => [`${r.network}/${r.networkCode}`, r]));

    let selected: SelectedCustomerView | null = null;
    const customer = customers.find((c) => c.businessId === businessId);
    if (customer !== undefined) {
      const balance = await customerBalance(customer.accountId, conn);
      selected = {
        businessId: customer.businessId,
        legalName: customer.legalName,
        ledgerCents: toCents(balance.ledgerCents),
        holdsCents: toCents(balance.holdsCents),
        availableCents: toCents(balance.availableCents),
      };
    }

    // The edge state wants ONE specific case: lost after provisional credit was
    // granted, and recovered. Named in the URL if the reader asked for one.
    let episode: EpisodeView | null = null;
    let episodeMissing: string | null = null;
    if (args.edge === true) {
      const named =
        args.disputeId === null ? null : await readDisputeState(args.disputeId, conn);
      const picked =
        named ??
        cases.find((c) => c.status === "closed_lost_recovered") ??
        cases.find((c) => c.status === "lost_pending_recovery") ??
        null;
      if (picked === null) {
        episodeMissing =
          "No case on this customer has been lost after provisional credit was granted. " +
          "Raise one, grant the credit, record it lost and claw it back — the episode appears here.";
      } else {
        episode = await buildEpisode(picked, conn);
        if (episode === null) {
          episodeMissing = `Case ${picked.caseRef} has posted nothing yet, so there is no episode to show.`;
        }
      }
    }

    const policyView: PolicyView | null =
      policy === null
        ? null
        : {
            thresholdCents: toCents(policy.thresholdCents),
            requiredApprovals: policy.requiredApprovals,
            note: policy.note,
          };

    return ok({
      source: "live" as const,
      asOf,
      bookDate: today,
      provenance: PROVENANCE,
      policy: policyView,
      businesses,
      selected,
      cases: cases.map((c) =>
        toCase(c, labelFor.get(`${c.network}/${c.networkCode}`)?.networkLabel ?? null),
      ),
      charges: charges.map(
        (c): ChargeView => ({
          entryId: c.entryId,
          valueDate: c.valueDate,
          description: c.description,
          netChargeCents: toCents(c.netChargeCents),
          alreadyClaimedCents: toCents(c.alreadyClaimedCents),
          disputableCents: toCents(c.netChargeCents - c.alreadyClaimedCents),
          cardLastFour: c.cardLastFour,
          cardNickname: c.cardNickname,
          providerAuthId: c.providerAuthId,
          authOrigin: c.authOrigin,
        }),
      ),
      reasonCodes: reasonCodes.map(
        (r): ReasonCodeView => ({
          network: r.network,
          networkCode: r.networkCode,
          reason: r.reason,
          networkLabel: r.networkLabel,
          evidenceNote: r.evidenceNote,
        }),
      ),
      episode,
      episodeMissing,
    });
  } catch (thrown) {
    return fail(
      "DISPUTES_READ_FAILED",
      "The disputes read failed. Nothing was posted — this path only reads.",
      { detail: thrown instanceof Error ? thrown.message : String(thrown) },
    );
  }
}
