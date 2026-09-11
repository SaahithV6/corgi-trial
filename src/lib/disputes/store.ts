/**
 * Every statement the dispute machinery issues.
 *
 * The rule this module obeys, inherited from `src/lib/holds/store.ts`: NO RAW
 * MONEY INSERTS. Nothing here writes `journal_entry` or `journal_line` — the
 * only money write path is `postEntry()`, which is the only caller of
 * `ledger_append()`. What this file does write is identity and evidence rows
 * the application role is allowed to append: `dispute`, `dispute_event`,
 * `hold`, `hold_closure`.
 *
 * The reads are all of views. `v_dispute_state` is a fold over the event
 * stream, `v_dispute_ledger` is a join through it to the journal, and neither
 * carries a stored status or a stored balance — there is no column here that a
 * cron job could be asked to repair.
 */

import "server-only";

import { balanceAsBelieved } from "@/lib/ledger/balances";
import type { Sql } from "@/lib/ledger/db";
import {
  heldCentsAsBelieved,
  readAccountIdentity,
  resolveChartCodes,
} from "@/lib/ledger/queries";

import { disputeHoldRef, type DisputeAccounts, type DisputeReason } from "./model";

// ---------------------------------------------------------------------------
// Rows, as the database hands them over
// ---------------------------------------------------------------------------

export interface DisputeRow {
  readonly id: string;
  readonly caseRef: string;
  readonly disputedEntryId: string;
  readonly accountId: string;
  readonly memoAccountId: string;
  readonly businessId: string;
  readonly cardId: string | null;
  readonly authId: string | null;
  readonly reason: DisputeReason;
  readonly network: string;
  readonly networkCode: string;
  readonly narrative: string;
  readonly amountCents: bigint;
  readonly valueDate: string;
  readonly networkOutsideDate: string;
  readonly raisedBy: string;
  readonly raisedAt: string;
  readonly policyId: string;
}

export interface DisputeStateRow extends DisputeRow {
  readonly status: string;
  readonly isClosed: boolean;
  readonly thresholdCents: bigint;
  readonly requiredApprovals: number;
  readonly needsAuthorization: boolean;
  readonly authorizations: number;
  readonly granted: boolean;
  readonly declined: boolean;
  readonly evidenceCount: number;
  readonly won: boolean;
  readonly lost: boolean;
  readonly withdrawn: boolean;
  readonly finalized: boolean;
  readonly clawedBack: boolean;
  readonly writtenOff: boolean;
  readonly grantHoldId: string | null;
  readonly decidedOn: string | null;
  readonly advancedCents: bigint;
  readonly heldCents: bigint;
  readonly holdReleased: boolean | null;
  readonly daysToOutsideDate: number;
  readonly legalName: string;
  readonly raisedByName: string;
}

type StateSqlRow = {
  dispute_id: string;
  case_ref: string;
  disputed_entry_id: string;
  account_id: string;
  memo_account_id: string;
  business_id: string;
  card_id: string | null;
  auth_id: string | null;
  reason: DisputeReason;
  network: string;
  network_code: string;
  narrative: string;
  amount_cents: bigint;
  value_date: string;
  network_outside_date: string;
  raised_by: string;
  raised_at: string;
  policy_id: string;
  status: string;
  is_closed: boolean;
  threshold_cents: bigint;
  required_approvals: number;
  needs_authorization: boolean;
  authorizations: number;
  granted: boolean;
  declined: boolean;
  evidence_count: number;
  won: boolean;
  lost: boolean;
  withdrawn: boolean;
  finalized: boolean;
  clawed_back: boolean;
  written_off: boolean;
  grant_hold_id: string | null;
  decided_on: string | null;
  advanced_cents: bigint;
  held_cents: bigint;
  hold_released: boolean | null;
  days_to_outside_date: number;
  legal_name: string;
  raised_by_name: string;
};

function toState(row: StateSqlRow): DisputeStateRow {
  return {
    id: row.dispute_id,
    caseRef: row.case_ref,
    disputedEntryId: row.disputed_entry_id,
    accountId: row.account_id,
    memoAccountId: row.memo_account_id,
    businessId: row.business_id,
    cardId: row.card_id,
    authId: row.auth_id,
    reason: row.reason,
    network: row.network,
    networkCode: row.network_code,
    narrative: row.narrative,
    amountCents: row.amount_cents,
    valueDate: row.value_date,
    networkOutsideDate: row.network_outside_date,
    raisedBy: row.raised_by,
    raisedAt: row.raised_at,
    policyId: row.policy_id,
    status: row.status,
    isClosed: row.is_closed,
    thresholdCents: row.threshold_cents,
    requiredApprovals: row.required_approvals,
    needsAuthorization: row.needs_authorization,
    authorizations: row.authorizations,
    granted: row.granted,
    declined: row.declined,
    evidenceCount: row.evidence_count,
    won: row.won,
    lost: row.lost,
    withdrawn: row.withdrawn,
    finalized: row.finalized,
    clawedBack: row.clawed_back,
    writtenOff: row.written_off,
    grantHoldId: row.grant_hold_id,
    decidedOn: row.decided_on,
    advancedCents: row.advanced_cents,
    heldCents: row.held_cents,
    holdReleased: row.hold_released,
    daysToOutsideDate: row.days_to_outside_date,
    legalName: row.legal_name,
    raisedByName: row.raised_by_name,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readDisputeState(
  disputeId: string,
  conn: Sql,
): Promise<DisputeStateRow | null> {
  const rows = await conn<StateSqlRow[]>`
    SELECT s.dispute_id, s.case_ref, s.disputed_entry_id, s.account_id, s.memo_account_id,
           s.business_id, s.card_id, s.auth_id, s.reason::text AS reason,
           s.network, s.network_code, d.narrative, s.amount_cents,
           s.value_date::text AS value_date,
           s.network_outside_date::text AS network_outside_date,
           s.raised_by, s.raised_at::text AS raised_at, s.policy_id,
           s.status, s.is_closed, s.threshold_cents, s.required_approvals,
           s.needs_authorization, s.authorizations, s.granted, s.declined,
           s.evidence_count, s.won, s.lost, s.withdrawn, s.finalized,
           s.clawed_back, s.written_off, s.grant_hold_id,
           s.decided_on::text AS decided_on,
           -- Cast, deliberately: SUM(bigint) is numeric in Postgres and the
           -- driver's bigint override keys on OID 20, so an uncast aggregate
           -- arrives as a JS number and stops comparing equal to a bigint.
           s.advanced_cents::bigint AS advanced_cents,
           s.held_cents::bigint     AS held_cents,
           s.hold_released, s.days_to_outside_date,
           b.legal_name, ra.display_name AS raised_by_name
      FROM v_dispute_state s
      JOIN dispute  d    ON d.id = s.dispute_id
      JOIN business b    ON b.id = s.business_id
      JOIN actor    ra   ON ra.id = s.raised_by
     WHERE s.dispute_id = ${disputeId}::uuid`;
  const row = rows[0];
  return row === undefined ? null : toState(row);
}

export async function listDisputeStates(
  filter: { readonly businessId?: string | null; readonly limit?: number } = {},
  conn: Sql,
): Promise<readonly DisputeStateRow[]> {
  const rows = await conn<StateSqlRow[]>`
    SELECT s.dispute_id, s.case_ref, s.disputed_entry_id, s.account_id, s.memo_account_id,
           s.business_id, s.card_id, s.auth_id, s.reason::text AS reason,
           s.network, s.network_code, d.narrative, s.amount_cents,
           s.value_date::text AS value_date,
           s.network_outside_date::text AS network_outside_date,
           s.raised_by, s.raised_at::text AS raised_at, s.policy_id,
           s.status, s.is_closed, s.threshold_cents, s.required_approvals,
           s.needs_authorization, s.authorizations, s.granted, s.declined,
           s.evidence_count, s.won, s.lost, s.withdrawn, s.finalized,
           s.clawed_back, s.written_off, s.grant_hold_id,
           s.decided_on::text AS decided_on,
           -- Cast, deliberately: SUM(bigint) is numeric in Postgres and the
           -- driver's bigint override keys on OID 20, so an uncast aggregate
           -- arrives as a JS number and stops comparing equal to a bigint.
           s.advanced_cents::bigint AS advanced_cents,
           s.held_cents::bigint     AS held_cents,
           s.hold_released, s.days_to_outside_date,
           b.legal_name, ra.display_name AS raised_by_name
      FROM v_dispute_state s
      JOIN dispute  d    ON d.id = s.dispute_id
      JOIN business b    ON b.id = s.business_id
      JOIN actor    ra   ON ra.id = s.raised_by
     WHERE (${filter.businessId ?? null}::uuid IS NULL
            OR s.business_id = ${filter.businessId ?? null}::uuid)
     ORDER BY s.raised_at DESC
     LIMIT ${filter.limit ?? 50}`;
  return rows.map(toState);
}

export interface DisputeEventRow {
  readonly id: string;
  readonly kind: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly actorKind: string;
  readonly valueDate: string;
  readonly occurredAt: string;
  readonly amountCents: bigint | null;
  readonly entryId: string | null;
  readonly holdId: string | null;
  readonly detail: string | null;
}

export async function listDisputeEvents(
  disputeId: string,
  conn: Sql,
): Promise<readonly DisputeEventRow[]> {
  const rows = await conn<
    {
      id: string;
      kind: string;
      actor_id: string;
      actor_name: string;
      actor_kind: string;
      value_date: string;
      occurred_at: string;
      amount_cents: bigint | null;
      entry_id: string | null;
      hold_id: string | null;
      detail: string | null;
    }[]
  >`
    SELECT e.id, e.kind::text AS kind, e.actor_id, a.display_name AS actor_name,
           a.kind::text AS actor_kind, e.value_date::text AS value_date,
           e.occurred_at::text AS occurred_at, e.amount_cents, e.entry_id, e.hold_id, e.detail
      FROM dispute_event e
      JOIN actor a ON a.id = e.actor_id
     WHERE e.dispute_id = ${disputeId}::uuid
     ORDER BY e.occurred_at, e.id`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    actorId: r.actor_id,
    actorName: r.actor_name,
    actorKind: r.actor_kind,
    valueDate: r.value_date,
    occurredAt: r.occurred_at,
    amountCents: r.amount_cents,
    entryId: r.entry_id,
    holdId: r.hold_id,
    detail: r.detail,
  }));
}

export interface DisputeLedgerLineRow {
  readonly eventKind: string;
  readonly entryId: string;
  readonly valueDate: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: string;
  readonly book: string;
  readonly entryType: string;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly ordinal: number;
  readonly accountCode: string;
  readonly accountName: string;
  readonly amountCents: bigint;
}

/** Every journal line a dispute caused, financial and memo, in booking order. */
export async function listDisputeLedger(
  disputeId: string,
  conn: Sql,
): Promise<readonly DisputeLedgerLineRow[]> {
  const rows = await conn<
    {
      event_kind: string;
      entry_id: string;
      value_date: string;
      booking_seq: bigint;
      booking_time: string;
      book: string;
      entry_type: string;
      description: string;
      idempotency_key: string;
      ordinal: number;
      account_code: string;
      account_name: string;
      amount_cents: bigint;
    }[]
  >`
    -- No DISTINCT ON any more, and that is the point of the change.
    --
    -- v_dispute_ledger unions two sources: entries cited by an event, and the
    -- memo entries reachable through the grant's hold. Those sets OVERLAPPED in
    -- exactly one case -- a dispute that was WON, where the finalising event
    -- cites the hold RELEASE entry, which is also a memo posting on that hold.
    -- UNION did not collapse them because event_kind differs, so every line of
    -- that entry came back twice and the episode screen printed it twice.
    --
    -- Found by reading the live book after the first won case, not by a test.
    -- It was deduped here, at the read, because 0019 was already applied.
    -- Migration 0023 fixes it where it belongs: the memo source now excludes
    -- entries the dispute's own events already cite, so the named event keeps
    -- the label that says WHY the posting happened and nothing is dropped by a
    -- blanket DISTINCT. v_dispute_ledger_double_count -- in dbcheck -- is the
    -- standing assertion that this read needs no dedupe of its own.
    SELECT event_kind, entry_id, value_date::text AS value_date, booking_seq,
           booking_time::text AS booking_time, book::text AS book,
           entry_type::text AS entry_type, description, idempotency_key,
           ordinal, account_code, account_name, amount_cents
      FROM v_dispute_ledger
     WHERE dispute_id = ${disputeId}::uuid
     ORDER BY booking_seq, ordinal`;
  return rows.map((r) => ({
    eventKind: r.event_kind,
    entryId: r.entry_id,
    valueDate: r.value_date,
    bookingSeq: r.booking_seq,
    bookingTime: r.booking_time,
    book: r.book,
    entryType: r.entry_type,
    description: r.description,
    idempotencyKey: r.idempotency_key,
    ordinal: r.ordinal,
    accountCode: r.account_code,
    accountName: r.account_name,
    amountCents: r.amount_cents,
  }));
}

/**
 * A settled card charge, as the intake form needs it.
 *
 * `net_charge_cents` is summed over the whole CORRECTION GROUP, not the single
 * entry: if the merchant already reversed the settlement there is nothing left
 * to dispute, and that is a fact about the group rather than about one row. The
 * intake trigger applies the same rule against the same sum, so the form and
 * the database cannot disagree about what is disputable.
 */
export interface DisputableChargeRow {
  readonly entryId: string;
  readonly valueDate: string;
  readonly bookingSeq: bigint;
  readonly description: string;
  readonly externalRef: string | null;
  readonly netChargeCents: bigint;
  readonly alreadyClaimedCents: bigint;
  readonly accountId: string;
  readonly businessId: string;
  readonly legalName: string;
  readonly cardId: string | null;
  readonly cardLastFour: string | null;
  readonly cardNickname: string | null;
  readonly authId: string | null;
  readonly providerAuthId: string | null;
  readonly authOrigin: string | null;
}

/**
 * The charge query, once.
 *
 * `onlyOutstanding` is applied IN SQL, outside the LIMIT, and that ordering is
 * the whole reason this is one function rather than a filter in JavaScript. The
 * first version took the newest N card charges and then dropped the claimed
 * ones, so once the newest N were all disputed the list came back EMPTY while
 * the customer still had dozens of disputable charges below them. Found by the
 * integration suite running out of charges on its seventh episode.
 */
async function queryCharges(
  filter: {
    readonly businessId?: string | null;
    readonly entryId?: string | null;
    readonly onlyOutstanding?: boolean;
    readonly limit?: number;
  },
  conn: Sql,
): Promise<readonly DisputableChargeRow[]> {
  const rows = await conn<
    {
      entry_id: string;
      value_date: string;
      booking_seq: bigint;
      description: string;
      external_ref: string | null;
      net_charge_cents: bigint;
      already_claimed_cents: bigint;
      account_id: string;
      business_id: string;
      legal_name: string;
      card_id: string | null;
      card_last_four: string | null;
      card_nickname: string | null;
      auth_id: string | null;
      provider_auth_id: string | null;
      auth_origin: string | null;
    }[]
  >`
    WITH charge AS (
      SELECT e.id                AS entry_id,
             e.correction_group_id,
             e.value_date,
             e.booking_seq,
             e.description,
             e.external_ref,
             a.id                AS account_id,
             a.business_id,
             l.amount_cents
        FROM journal_entry e
        JOIN journal_line  l ON l.entry_id = e.id
        JOIN account       a ON a.id = l.account_id
                            AND a.code = '2100'
                            AND a.business_id IS NOT NULL
       WHERE e.rail = 'card'
         AND e.book = 'financial'
         AND l.amount_cents > 0
         -- The entry must ALSO credit 2200, the card network settlement
         -- payable. That is the shape of a real card clearing or force post
         -- (postCardMovement in src/lib/holds/store.ts): the customer was
         -- debited and THE NETWORK WAS PAID.
         --
         -- Found by running this feature against the live book: without this
         -- clause a dispute CLAWBACK is itself disputable, because it too is a
         -- card-rail entry debiting the customer. It is not a purchase, there
         -- is no merchant behind it and there is no network case to file, so it
         -- must never appear here. The same test excludes a provisional credit,
         -- a write-off and the pre-0008 fixtures that settled straight to 1110.
         --
         -- Since migration 0023 this is the SECOND place the rule is applied:
         -- assert_dispute_intake() now refuses the INSERT, so a caller that
         -- never asks this function cannot raise the dispute either. This
         -- clause stays because a list and a gate are different jobs -- the
         -- form must not offer a charge the trigger would then refuse.
         AND EXISTS (
           SELECT 1
             FROM journal_line  l2
             JOIN account       a2 ON a2.id = l2.account_id
            WHERE l2.entry_id = e.id
              AND a2.code = '2200'
              AND l2.amount_cents < 0
         )
         AND (${filter.businessId ?? null}::uuid IS NULL
              OR a.business_id = ${filter.businessId ?? null}::uuid)
         AND (${filter.entryId ?? null}::uuid IS NULL
              OR e.id = ${filter.entryId ?? null}::uuid)
    )
    SELECT * FROM (
    SELECT c.entry_id,
           c.value_date::text AS value_date,
           c.booking_seq,
           c.description,
           c.external_ref,
           -- The group's net position on this customer's account: a reversed
           -- settlement nets to zero and drops out of the list entirely.
           (SELECT COALESCE(SUM(l2.amount_cents), 0)::bigint
              FROM journal_entry e2
              JOIN journal_line  l2 ON l2.entry_id = e2.id
             WHERE e2.correction_group_id = c.correction_group_id
               AND l2.account_id = c.account_id)          AS net_charge_cents,
           (SELECT COALESCE(SUM(d.amount_cents), 0)::bigint
              FROM dispute d
             WHERE d.disputed_entry_id = c.entry_id
               AND NOT EXISTS (SELECT 1 FROM dispute_event de
                                WHERE de.dispute_id = d.id
                                  AND de.kind::text = 'withdrawn')) AS already_claimed_cents,
           c.account_id,
           c.business_id,
           b.legal_name,
           ca.card_id,
           cd.last_four       AS card_last_four,
           cd.nickname        AS card_nickname,
           ca.id              AS auth_id,
           ca.provider_auth_id,
           ca.origin          AS auth_origin
      FROM charge c
      JOIN business b    ON b.id = c.business_id
      LEFT JOIN card_authorization ca ON ca.provider_auth_id = c.external_ref
      LEFT JOIN card cd  ON cd.id = ca.card_id
    ) x
   WHERE (${filter.onlyOutstanding ?? false} = false
          OR x.net_charge_cents > x.already_claimed_cents)
   ORDER BY x.booking_seq DESC
   LIMIT ${filter.limit ?? 40}`;

  return rows.map((r) => ({
      entryId: r.entry_id,
      valueDate: r.value_date,
      bookingSeq: r.booking_seq,
      description: r.description,
      externalRef: r.external_ref,
      netChargeCents: r.net_charge_cents,
      alreadyClaimedCents: r.already_claimed_cents,
      accountId: r.account_id,
      businessId: r.business_id,
      legalName: r.legal_name,
      cardId: r.card_id,
      cardLastFour: r.card_last_four,
      cardNickname: r.card_nickname,
      authId: r.auth_id,
      providerAuthId: r.provider_auth_id,
      authOrigin: r.auth_origin,
    }));
}

/**
 * Settled card charges with money STILL OUTSTANDING on them — the intake list.
 *
 * A charge the merchant already reversed nets to zero over its correction group
 * and drops out here, and one that is fully claimed drops out too. The intake
 * trigger applies the same two rules against the same two sums, so the form and
 * the database cannot disagree about what is disputable.
 */
export async function listDisputableCharges(
  filter: { readonly businessId?: string | null; readonly limit?: number } = {},
  conn: Sql,
): Promise<readonly DisputableChargeRow[]> {
  return queryCharges({ ...filter, onlyOutstanding: true }, conn);
}

/**
 * ONE card charge by entry id, WITHOUT the outstanding filter.
 *
 * Deliberately unfiltered: the disputed charge on a case that has already been
 * fully claimed is exactly the one the case screen needs to name, and it is by
 * definition no longer disputable. Callers that are about to WRITE check the
 * outstanding amount themselves, and the trigger checks it again.
 */
export async function readCardCharge(
  entryId: string,
  conn: Sql,
): Promise<DisputableChargeRow | null> {
  const rows = await queryCharges({ entryId, limit: 1 }, conn);
  return rows[0] ?? null;
}

export interface ReasonCodeRow {
  readonly network: string;
  readonly networkCode: string;
  readonly reason: DisputeReason;
  readonly networkLabel: string;
  readonly evidenceNote: string;
}

export async function listReasonCodes(conn: Sql): Promise<readonly ReasonCodeRow[]> {
  const rows = await conn<
    {
      network: string;
      network_code: string;
      reason: DisputeReason;
      network_label: string;
      evidence_note: string;
    }[]
  >`
    SELECT network, network_code, reason::text AS reason, network_label, evidence_note
      FROM dispute_reason_code
     ORDER BY network, network_code`;
  return rows.map((r) => ({
    network: r.network,
    networkCode: r.network_code,
    reason: r.reason,
    networkLabel: r.network_label,
    evidenceNote: r.evidence_note,
  }));
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

/**
 * Everything a dispute posting needs to know about accounts, in ONE query.
 *
 * Four house accounts and the customer's own memo leaf, reached from the
 * customer's deposit account and nothing else. There is no hard-coded uuid
 * here and no per-call round trip per code: the codes are the chart's own, and
 * a missing one is a loud failure at the posting boundary rather than an
 * `undefined` that produces a one-legged entry.
 *
 * Written as one statement on purpose. `src/lib/ledger/boundary.test.ts` is a
 * ratchet on how many places outside `src/lib/ledger/**` write SQL against
 * `account`, `journal_entry` and `journal_line`, and it is right to be: a
 * module that opens its own account lookups is a module with its own idea of
 * what the chart is. Four lookups became one, and one is the bill this module
 * pays.
 */
export interface AccountContext extends DisputeAccounts {
  readonly entityId: string;
  /** 2200. Not posted to here — used to recognise a real card clearing. */
  readonly networkPayableAccountId: string;
}

export async function readAccountContext(
  customerAccountId: string,
  conn: Sql,
): Promise<AccountContext> {
  // The chart a dispute needs before it can post: four HOUSE codes and one of
  // the customer's own leaves. It was a self-join across `account` with a
  // two-branch ON clause; it is `resolveChartCodes` now, which is the same
  // question — "these codes, for this entity and this business" — asked once.
  const customer = await readAccountIdentity(customerAccountId, conn);
  if (customer === null) {
    throw new Error(
      `the chart is missing an account a dispute on ${customerAccountId} needs (9200/1120/5200/9900/2200)`,
    );
  }

  const chart = await resolveChartCodes(
    {
      entityId: customer.entityId,
      businessId: customer.businessId,
      houseCodes: ["1120", "5200", "9900", "2200"],
      businessCodes: ["9200"],
    },
    conn,
  );

  const memo = chart.get("9200");
  const receivable = chart.get("1120");
  const loss = chart.get("5200");
  const contra = chart.get("9900");
  const network = chart.get("2200");

  if (
    memo === undefined ||
    receivable === undefined ||
    loss === undefined ||
    contra === undefined ||
    network === undefined
  ) {
    throw new Error(
      `the chart is missing an account a dispute on ${customerAccountId} needs (9200/1120/5200/9900/2200)`,
    );
  }

  return {
    entityId: customer.entityId,
    customerAccountId,
    memoAccountId: memo.accountId,
    receivableAccountId: receivable.accountId,
    lossAccountId: loss.accountId,
    memoContraAccountId: contra.accountId,
    networkPayableAccountId: network.accountId,
  };
}

/**
 * The customer's position at a booking watermark: `booking_seq <= S`.
 *
 * TWO SUMS, ONE AXIS EACH, AND NOTHING STORED ON EITHER SIDE.
 *
 *   ledger  the 2100 leaf's balance as we had it booked by S
 *   holds   every hold of that account's own memo balance, likewise
 *
 * The memo sum is restricted to `hold.memo_account_id` for the reason
 * `availableBalance()` gives at length: both legs of a memo entry are in an
 * unrestricted sum and they cancel to zero, always.
 *
 * "Released" is not consulted and does not need to be. A released hold has had
 * its release POSTED, so its memo balance at any watermark after that posting
 * is already zero — and `v_hold_release_drift`, which `pnpm db:check` asserts
 * is empty, is exactly the invariant that keeps that true.
 *
 * This is what lets the screen print the customer's ledger and available
 * balance BEFORE the advance, WHILE it was outstanding, and AFTER the case
 * resolved, instead of asserting that available never moved.
 */
export async function positionAt(
  args: { readonly accountId: string; readonly seq: bigint },
  conn: Sql,
): Promise<{ ledgerCents: bigint; holdsCents: bigint }> {
  // The ledger half is the ledger module's own question, so it is asked with
  // the ledger module's own function rather than re-expressed here. The value
  // date is unbounded on purpose: this asks "everything we had BOOKED by S",
  // which is the transaction-time axis alone.
  // BOTH halves are the ledger module's questions now, and both are asked with
  // the ledger module's own functions rather than re-expressed here. The memo
  // sum used to be a `CROSS JOIN LATERAL` in this file: a second fold over the
  // memo book, in a product module, which is the shape that produced four
  // disagreeing balances once already.
  const [ledgerCents, holdsCents] = await Promise.all([
    balanceAsBelieved(args.accountId, "9999-12-31", args.seq, conn),
    heldCentsAsBelieved({ accountId: args.accountId, seq: args.seq }, conn),
  ]);
  return { ledgerCents, holdsCents };
}

/**
 * Every customer with a deposit account, read through `v_available_balance`.
 *
 * Deliberately not a fresh `SELECT ... FROM account`: the view already defines
 * "a customer with money" as `code = '2100' AND business_id IS NOT NULL`, and a
 * second definition of that is a second definition that can drift.
 */
export async function listDisputeCustomers(
  conn: Sql,
): Promise<readonly { businessId: string; legalName: string; accountId: string }[]> {
  const rows = await conn<{ business_id: string; legal_name: string; account_id: string }[]>`
    SELECT v.business_id, b.legal_name, v.account_id
      FROM v_available_balance v
      JOIN business b ON b.id = v.business_id
     ORDER BY b.legal_name`;
  return rows.map((r) => ({
    businessId: r.business_id,
    legalName: r.legal_name,
    accountId: r.account_id,
  }));
}

/** The `card` policy version in force on a date. Effective-dated, append-only. */
export async function effectiveCardPolicy(
  asOf: string,
  conn: Sql,
): Promise<{ id: string; thresholdCents: bigint; requiredApprovals: number; note: string } | null> {
  const rows = await conn<
    { id: string; threshold_cents: bigint; required_approvals: number; note: string }[]
  >`
    SELECT id, threshold_cents, required_approvals, note
      FROM approval_policy
     WHERE rail = 'card' AND effective_from <= ${asOf}::date
     ORDER BY effective_from DESC
     LIMIT 1`;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        thresholdCents: row.threshold_cents,
        requiredApprovals: row.required_approvals,
        note: row.note,
      };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export async function insertDispute(
  args: {
    readonly caseRef: string;
    readonly disputedEntryId: string;
    readonly accountId: string;
    readonly memoAccountId: string;
    readonly cardId: string | null;
    readonly authId: string | null;
    readonly reason: DisputeReason;
    readonly network: string;
    readonly networkCode: string;
    readonly narrative: string;
    readonly amountCents: bigint;
    readonly valueDate: string;
    readonly networkOutsideDate: string;
    readonly raisedBy: string;
    readonly policyId: string;
  },
  conn: Sql,
): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    INSERT INTO dispute (case_ref, disputed_entry_id, account_id, memo_account_id,
                         card_id, auth_id, reason, network, network_code, narrative,
                         amount_cents, value_date, network_outside_date, raised_by, policy_id)
    VALUES (${args.caseRef}, ${args.disputedEntryId}::uuid, ${args.accountId}::uuid,
            ${args.memoAccountId}::uuid, ${args.cardId}::uuid, ${args.authId}::uuid,
            ${args.reason}::dispute_reason, ${args.network}, ${args.networkCode},
            ${args.narrative}, ${args.amountCents}, ${args.valueDate}::date,
            ${args.networkOutsideDate}::date, ${args.raisedBy}::uuid, ${args.policyId}::uuid)
    RETURNING id`;
  const row = rows[0];
  if (row === undefined) throw new Error("dispute insert returned no id");
  return row.id;
}

export async function insertDisputeEvent(
  args: {
    readonly disputeId: string;
    readonly kind: string;
    readonly actorId: string;
    readonly valueDate: string;
    readonly amountCents?: bigint | null;
    readonly entryId?: string | null;
    readonly holdId?: string | null;
    readonly detail?: string | null;
  },
  conn: Sql,
): Promise<string> {
  const rows = await conn<{ id: string }[]>`
    INSERT INTO dispute_event (dispute_id, kind, actor_id, value_date,
                               amount_cents, entry_id, hold_id, detail)
    VALUES (${args.disputeId}::uuid, ${args.kind}::dispute_event_kind,
            ${args.actorId}::uuid, ${args.valueDate}::date,
            ${args.amountCents ?? null}, ${args.entryId ?? null}::uuid,
            ${args.holdId ?? null}::uuid, ${args.detail ?? null})
    RETURNING id`;
  const row = rows[0];
  if (row === undefined) throw new Error("dispute_event insert returned no id");
  return row.id;
}

/**
 * Open the hold that withholds a provisional credit.
 *
 * `available_at` is `'infinity'`, which is not a sentinel: `hold_clock` in 0001
 * requires an uncleared-credit hold to carry one, `v_hold_state` releases such a
 * hold when `now() >= available_at`, and the literal truth about a dispute
 * credit is that NO CLOCK EVER RELEASES IT. It is awaiting a decision, not a
 * settlement. Release is a `hold_closure` row and nothing else.
 *
 * `ON CONFLICT (kind, external_ref) DO NOTHING` makes the hold exactly-once per
 * dispute by construction, the same way `ensureAuthorization` does for a card
 * authorisation: two racing grants both try, one loser's row never exists, and
 * both read back the same hold.
 */
export async function openDisputeHold(
  args: {
    readonly disputeId: string;
    readonly accountId: string;
    readonly memoAccountId: string;
    readonly valueDate: string;
  },
  conn: Sql,
): Promise<string> {
  const externalRef = disputeHoldRef(args.disputeId);
  await conn`
    INSERT INTO hold (account_id, memo_account_id, kind, external_ref, value_date, available_at)
    VALUES (${args.accountId}::uuid, ${args.memoAccountId}::uuid, 'uncleared_credit',
            ${externalRef}, ${args.valueDate}::date, 'infinity'::timestamptz)
    ON CONFLICT (kind, external_ref) DO NOTHING`;
  const rows = await conn<{ id: string }[]>`
    SELECT id FROM hold WHERE kind = 'uncleared_credit' AND external_ref = ${externalRef}`;
  const row = rows[0];
  if (row === undefined) throw new Error(`failed to open the hold for dispute ${args.disputeId}`);
  return row.id;
}

/**
 * Close a hold. `PRIMARY KEY (hold_id)` makes this exactly-once BY
 * CONSTRUCTION. Written before the release posting, deliberately: availability
 * reads "released" as this row existing, so a crash between the two leaves the
 * customer's available balance already correct and the posting as bookkeeping.
 */
export async function closeDisputeHold(
  holdId: string,
  reason: string,
  actorId: string,
  conn: Sql,
): Promise<boolean> {
  const rows = await conn`
    INSERT INTO hold_closure (hold_id, reason, actor_id)
    VALUES (${holdId}::uuid, ${reason}, ${actorId}::uuid)
    ON CONFLICT (hold_id) DO NOTHING
    RETURNING hold_id`;
  return rows.length > 0;
}

/**
 * The memo book's own answer for one hold, in natural (positive) terms.
 *
 * Re-exported from `src/lib/holds/store.ts` rather than rewritten. It is the
 * same question about the same two tables, and a second copy of it is a second
 * chance to get the `normal_side` inversion wrong — which is the error that
 * module's own comment calls the classic one.
 */
export { memoHoldBalance as heldCents } from "@/lib/holds";

/** The book's own business date, from `book_date()`. Not the server's timezone. */
export async function bookDate(conn: Sql): Promise<string> {
  const rows = await conn<{ d: string }[]>`SELECT to_char(book_date(now()),'YYYY-MM-DD') AS d`;
  const row = rows[0];
  if (row === undefined) throw new Error("book_date() returned nothing");
  return row.d;
}

/** Ledger and available balance for one customer, both derived, neither stored. */
export interface CustomerBalance {
  readonly ledgerCents: bigint;
  readonly holdsCents: bigint;
  readonly availableCents: bigint;
}

export async function customerBalance(
  accountId: string,
  conn: Sql,
): Promise<CustomerBalance> {
  const rows = await conn<
    { ledger_balance_cents: bigint; active_holds_cents: bigint; available_cents: bigint }[]
  >`
    -- Cast, deliberately. SUM(bigint) is numeric in Postgres, and the driver's
    -- bigint override keys on OID 20, so an uncast view column arrives as a JS
    -- number and every comparison against a bigint silently fails. Money must
    -- not round-trip through a float here.
    SELECT ledger_balance_cents::bigint AS ledger_balance_cents,
           active_holds_cents::bigint   AS active_holds_cents,
           available_cents::bigint      AS available_cents
      FROM v_available_balance WHERE account_id = ${accountId}::uuid`;
  const row = rows[0];
  return {
    ledgerCents: row?.ledger_balance_cents ?? 0n,
    holdsCents: row?.active_holds_cents ?? 0n,
    availableCents: row?.available_cents ?? 0n,
  };
}
