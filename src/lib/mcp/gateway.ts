/**
 * The live implementation of `Gateway`: every SQL statement the agent surface
 * can cause to run, in one file, so the tenant predicate can be reviewed in
 * one sitting.
 *
 * THE SCOPING RULE, stated once and obeyed everywhere below: **no query
 * reaches a row without passing through `account.business_id = $businessId`.**
 * The customer's money lives on per-business leaves of the chart (`2100`,
 * `9100`, `9200` — see `ledger/chart.ts`), so joining `journal_line` to
 * `account` and filtering on that column is not one predicate among several,
 * it is the boundary. House accounts (`business_id IS NULL`) are never
 * returned to a tenant token even when an entry touches both sides.
 *
 * ---------------------------------------------------------------------------
 * THIS MODULE NO LONGER DEFINES A BALANCE. That is the most important fact
 * about it, and it was not true until recently.
 *
 * Two bugs in `ledger/balances.ts`'s `availableBalance()` were found here while
 * wiring this surface up — a `hold.business_id` column that does not exist, and
 * an `active_holds` CTE summing every line of a memo entry that nets to zero by
 * construction, which computed a hold size of 0 for every hold that ever
 * existed. Both were reproduced against the live Neon branch. The response at
 * the time was for this file to compute the hold itemisation itself, and that
 * response was wrong in the long run: it made the agent surface the FIFTH
 * definition of available balance in a system that had just spent a migration
 * collapsing four. See the block below the imports for what replaced it and
 * what that cost. Every money figure this file returns now comes from a
 * function in `src/lib/ledger/**`.
 * ---------------------------------------------------------------------------
 */

import "server-only";

import { getPayment, requestPayment } from "@/lib/approvals";
import { destinationSchema, type PaymentDestination, type PayoutRail } from "@/lib/approvals/types";
import { listCardsWithControls, listDecisions } from "@/lib/cards/store";
// Reached past `@/lib/disputes`, deliberately: the barrel re-exports
// `./operations`, which imports `postEntry`. See `listDisputes` below.
import { listDisputeEvents, listDisputeStates } from "@/lib/disputes/store";
import { loadPayeeBook } from "@/lib/payees/store";
import { listPots as listPotsOfBusiness, readIdentity as readPotIdentity } from "@/lib/pots/store";
import { bookingWatermarkAt } from "@/lib/ledger/balances";
import { sql as defaultSql, type Sql } from "@/lib/ledger/db";
import {
  accountAvailability,
  bookingTimeOfSeq,
  currentBookingWatermark,
  findAccount as findLedgerAccount,
  holdItemisationAsOf,
  listAccounts,
  listLedgerLines,
  readAccountIdentity,
  readSnapshot,
  type LedgerSnapshot,
} from "@/lib/ledger/queries";
import { toReconBreak } from "@/lib/recon/diff";

import { ToolError } from "./types";
import type {
  AccountRef,
  AccrualDayRow,
  AccrualFilter,
  AccrualMonthRow,
  AccrualPage,
  AccrualScheduleRow,
  BalanceSnapshot,
  CardControlFilter,
  CardControlPage,
  CardControlRow,
  CardDecisionRow,
  DisputeEventProjection,
  DisputeFilter,
  DisputePage,
  DisputeRowProjection,
  Gateway,
  PayeeFilter,
  PayeeFindingRow,
  PayeeRow,
  PotBalanceRow,
  PotsSnapshot,
  StandingOccurrenceRow,
  StandingOrderFilter,
  StandingOrderPage,
  StandingOrderRow,
  QueuePaymentInput,
  QueuedPayment,
  ReconBreakPage,
  ReconBreakRow,
  ReconFilter,
  ResolvedActor,
  TransactionFilter,
  TransactionPage,
  TransactionRow,
} from "./types";

/*
 * ===========================================================================
 * THE FIFTH DEFINITION OF AVAILABLE BALANCE IS GONE. THIS IS THE ENTRY.
 * ===========================================================================
 *
 * This file used to compute the agent's available balance itself, out of
 * `holdItemisationAsOf` — and that computation differed from
 * `ledger_availability()`, the definition every screen in the product uses,
 * in two ways that both push the SAME DIRECTION:
 *
 *   1. it dropped `manual` holds, so an operator hold withheld nothing; and
 *   2. it had no pending-outbound term, so a debit already booked to leave
 *      tomorrow was still counted as spendable today.
 *
 * Both make the agent's figure LARGER than the customer's own screen. That is
 * the worst possible direction for this particular error, because
 * `initiate_payment` funds-checks against exactly this number: an agent could
 * queue a payment the customer's screen says they cannot afford, and the whole
 * safety argument for this surface is that an agent can only ever PROPOSE.
 * A proposal built on a number nobody else agrees with is not a proposal, it
 * is a disagreement with a customer's balance made on their behalf. Migration
 * 0022 collapsed four such definitions that differed by $30,662.10; this was
 * the fifth, and it escaped `v_balance_definition_drift` because that view
 * compares the definitions it knows about and this one was never registered
 * with it.
 *
 * So it is not registered — it is DELETED. Every figure below now comes from
 * `accountAvailability()`, which is one call to `ledger_availability()`, the
 * same Postgres function `v_available_balance` and the drift view are built
 * on. There is no longer a fifth definition to keep in step.
 *
 * WHAT THAT COST, STATED PLAINLY. Three figures an agent could previously be
 * given have moved, all of them DOWN:
 *
 *   * manual holds are now withheld;
 *   * future-dated debits are now subtracted;
 *   * future-dated CREDITS are no longer included — the old code asked for the
 *     balance at value date 9999-12-31, which handed the demo account
 *     $8,421.30 of standing-order credits value-dated 2027 as money it could
 *     spend today.
 *
 * Every one of those changes is conservative, and conservative is the only
 * defensible direction here: being cautious costs an agent a refusal it could
 * have avoided, being permissive costs a customer a payment they could not
 * afford.
 *
 * `holdItemisationAsOf` is still called, for ONE thing it can do that
 * `ledger_availability()` cannot — it splits the hold total into card
 * authorisations and uncleared credits and counts them, which is what turns
 * "available is $X" into an itemisation a person can check. The MONEY comes
 * from the authoritative function; the split and the counts are description.
 * The manual-hold term, which used to be silently missing, is now visible as
 * `otherHoldsCents` — the difference between the authoritative hold total and
 * the card-auth holds the itemisation can name.
 * ===========================================================================
 */

/**
 * The most occurrences one call will read across every mandate on the page.
 *
 * A mandate that has fired daily for a year has 365 of them, and a page of 25
 * such mandates is 9,125 rows to answer "when does my rent go out". The tool
 * shows a handful per mandate; this is the ceiling on what the database is
 * asked for, ordered newest first so the handful is the useful end.
 */
const STANDING_OCCURRENCE_CEILING = 500;

/** How deep a decline filter will scan. See the call site. */
const DECISION_SCAN_CEILING = 300;

/**
 * How many of a business's dispute cases one call reads before filtering.
 *
 * `v_dispute_state` is a fold over the event stream, so status is computed and
 * cannot be pushed into a WHERE clause without re-implementing the fold here —
 * which is the one thing this file refuses to do, because a second opinion
 * about whether a case is closed is a second opinion about whether the
 * customer's money is theirs. So the fold is asked for the business's cases
 * and the status filter is applied to the result. The ceiling bounds that: a
 * business with more than 200 disputes is an incident, and the page the tool
 * returns is capped far below it.
 */
const DISPUTE_SCAN_CEILING = 200;

/**
 * `standing_order.counterparty` as a destination, or null.
 *
 * The column is jsonb, which means its shape is not enforced by the database,
 * which means the boundary that reads it is the boundary that checks it. A row
 * that does not parse becomes null rather than an exception: the mandate's
 * schedule and its refusal history are still worth returning.
 */
function parseDestination(raw: unknown): PaymentDestination | null {
  const parsed = destinationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * `payee_verification.detail.findings` as a list, defensively.
 *
 * Same argument as `parseDestination`, and the same one the payee screen
 * makes about the same column: these are RENDERED, never used to decide
 * anything. The decision columns beside them — outcome, name match, checksum —
 * are the decision, and a findings blob of an unexpected shape shows as no
 * findings rather than costing the caller the row.
 */
function findingsOf(detail: unknown): readonly PayeeFindingRow[] {
  if (typeof detail !== "object" || detail === null) return [];
  const raw = (detail as { findings?: unknown }).findings;
  if (!Array.isArray(raw)) return [];

  const out: PayeeFindingRow[] = [];
  for (const item of raw.slice(0, 25)) {
    if (typeof item !== "object" || item === null) continue;
    const { code, severity, title, detail: text } = item as Record<string, unknown>;
    if (typeof code !== "string" || typeof title !== "string" || typeof text !== "string") continue;
    if (severity !== "block" && severity !== "warn" && severity !== "note") continue;
    out.push({ code, severity, title, detail: text });
  }
  return out;
}

export interface GatewayOptions {
  /** Override the connection. Tests and scripts pass one; the route does not. */
  readonly conn?: Sql;
}

export function liveGateway(options: GatewayOptions = {}): Gateway {
  const conn = options.conn ?? defaultSql;

  return {
    async resolveActor(actorId: string, businessId: string): Promise<ResolvedActor | null> {
      const rows = await conn<
        {
          id: string;
          kind: "human" | "agent" | "system";
          display_name: string;
          can_approve: boolean;
          business_id: string | null;
          legal_name: string;
        }[]
      >`
        SELECT a.id, a.kind, a.display_name, a.can_approve, a.business_id, b.legal_name
          FROM actor a
          CROSS JOIN business b
         WHERE a.id = ${actorId}::uuid
           AND b.id = ${businessId}::uuid`;

      const row = rows[0];
      if (row === undefined) return null;
      return {
        actorId: row.id,
        kind: row.kind,
        displayName: row.display_name,
        canApprove: row.can_approve,
        actorBusinessId: row.business_id,
        businessLegalName: row.legal_name,
      };
    },

    async findAccount(businessId: string, code: string): Promise<AccountRef | null> {
      // `business_id = $1` and not `business_id = $1 OR business_id IS NULL`.
      // A tenant token cannot name a house account, so `1110` (the FBO cash
      // account, which is every customer's money pooled) is simply not
      // addressable through this surface.
      const account = await findLedgerAccount(
        { businessId, code, includeClosed: false },
        conn,
      );
      if (account === null) return null;
      return {
        accountId: account.accountId,
        code: account.code,
        name: account.name,
        currency: account.currency,
        book: account.book,
        isPostable: account.isPostable,
      };
    },

    async balanceNow(businessId: string, accountId: string): Promise<BalanceSnapshot> {
      // ONE snapshot, three axes, taken once. `readSnapshot` is the ledger's
      // own live point — `clock_timestamp()` rather than `now()`, today's
      // business day from the database's `book_date()`, and the highest
      // booking sequence we have learned. Three reads against three separate
      // `now()` calls drift by however long the round trips took.
      const point = await readSnapshot(conn);
      return snapshot(conn, businessId, accountId, point);
    },

    async balanceAsOf(
      businessId: string,
      accountId: string,
      asOfValueDate: string,
      asOfBookingSeq: bigint | null,
    ): Promise<BalanceSnapshot> {
      // The hold-release predicate needs a wall clock, because `hold_closure`
      // carries `closed_at` and no booking sequence. Translating the watermark
      // back into an instant keeps the two axes consistent: a hold released
      // after the moment we are asking about was still open then. With no
      // watermark, the question is "what does today's knowledge say about that
      // business day", so the instant is now and the watermark is the live one.
      const [asOf, watermark] = await Promise.all([
        asOfBookingSeq === null
          ? Promise.resolve(null)
          : bookingTimeOfSeq(asOfBookingSeq, conn),
        asOfBookingSeq === null
          ? currentBookingWatermark(conn)
          : Promise.resolve(asOfBookingSeq),
      ]);

      return snapshot(conn, businessId, accountId, {
        asOf: asOf ?? new Date(),
        valueDate: asOfValueDate,
        bookingWatermark: watermark,
      });
    },

    async bookingWatermarkAt(at: Date): Promise<bigint> {
      return bookingWatermarkAt(at, conn);
    },

    async listTransactions(
      businessId: string,
      filter: TransactionFilter,
    ): Promise<TransactionPage> {
      // ONE EXTRA ROW, to answer "is there a next page" without a count(*).
      //
      // The query itself is `listLedgerLines` now. It used to be assembled
      // here out of nine optional `conn\`…\`` fragments reduced into a WHERE
      // clause — which meant the agent surface owned its own definition of
      // what a transaction row is, columns, sign convention and all. An agent
      // and a screen disagreeing about a customer's transactions is the exact
      // failure `src/lib/ledger/boundary.test.ts` was written to stop, and it
      // would have happened in front of a customer.
      const rows = await listLedgerLines(
        {
          businessId,
          accountCode: filter.accountCode,
          valueDateFrom: filter.valueDateFrom,
          valueDateTo: filter.valueDateTo,
          bookingDateFrom: filter.bookingDateFrom,
          bookingDateTo: filter.bookingDateTo,
          rail: filter.rail,
          book: filter.book,
          bookingSeqBelow: filter.cursorBookingSeqBelow,
          limit: filter.limit + 1,
        },
        conn,
      );

      const page = rows.slice(0, filter.limit);
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > filter.limit && last !== undefined ? last.bookingSeq.toString() : null;

      return {
        rows: page.map(
          (r): TransactionRow => ({
            entryId: r.entryId,
            accountCode: r.accountCode,
            accountName: r.accountName,
            valueDate: r.valueDate,
            bookingDate: r.bookingDate,
            bookingTime: r.bookingTime.toISOString(),
            bookingSeq: r.bookingSeq,
            entryType: r.entryType,
            book: r.book,
            description: r.description,
            rail: r.rail,
            externalRef: r.externalRef,
            amountCents: r.amountCents,
            currency: r.currency,
            memo: r.memo,
            reversesEntryId: r.reversesEntryId,
            correctionGroupId: r.correctionGroupId,
          }),
        ),
        nextCursor,
      };
    },

    async listReconBreaks(businessId: string, filter: ReconFilter): Promise<ReconBreakPage> {
      // The diff itself is NOT re-implemented here. `v_recon_break`
      // (db/migrations/0006_recon.sql) is the single definition of the three
      // categories, and `toReconBreak` from `@/lib/recon/diff` applies the age
      // bucket and severity from `recon/aging.ts`. What this module adds is one
      // thing: the tenant predicate, pushed into the WHERE clause rather than
      // applied in TypeScript afterwards.
      //
      // Pushed down for two reasons. It is the faster plan — measured against
      // the live branch, 185ms scoped versus 708ms for the whole view — and
      // more importantly it means there is no moment at which this process
      // holds another business's break in memory. A filter applied after the
      // fetch is a filter someone can forget to apply.
      //
      // Membership is decided by the customer's own leaf, never by the rail
      // control account: a settlement entry touches both, and keying on the
      // control account would give every business every break on the rail.
      const rows = await conn<Parameters<typeof toReconBreak>[0][]>`
        SELECT v.file_id, v.provider, v.rail::text AS rail,
               v.business_date::text AS business_date,
               v.break_kind, v.reason_code, v.break_key, v.external_ref,
               v.value_date::text AS value_date,
               v.file_row_id, v.file_row_no, v.entry_id, v.entry_booking_seq,
               v.correction_group_id,
               v.file_amount_cents, v.ledger_amount_cents, v.ledger_net_cents,
               v.break_amount_cents, v.description,
               v.age_days, v.closes_crossed, v.explained_by
          FROM v_recon_break v
         WHERE v.entry_id IS NOT NULL
           AND (${filter.includeExplained} OR v.explained_by IS NULL)
           AND (${filter.category}::text IS NULL OR v.break_kind = ${filter.category}::text)
           AND (${filter.minAgeDays}::int IS NULL OR v.age_days >= ${filter.minAgeDays}::int)
           -- TENANCY STAYS IN SQL, and it is the one ledger reference in
           -- this file that is NOT moving behind a named reader. See the
           -- paragraph above: a pre-fetch is a filter someone can forget to
           -- apply, and on an agent surface the thing being forgotten would be
           -- tenant isolation. Expressing it as "ask the ledger which of these
           -- entries are yours, then filter in TypeScript" makes the isolation
           -- a step rather than a predicate, and a step can be reordered,
           -- short-circuited or dropped by someone editing the paging logic.
           -- Two references, deliberately kept. DECISIONS has the argument.
           AND EXISTS (
                 SELECT 1
                   FROM journal_line l
                   JOIN account a ON a.id = l.account_id
                  WHERE l.entry_id = v.entry_id
                    AND a.business_id = ${businessId}::uuid)
         ORDER BY v.age_days DESC, v.break_key
         LIMIT ${filter.limit}`;

      // A break with no journal entry has no account, so it has no business.
      // Counted, never listed; see the tool's header for the argument.
      const [unattributed] = await conn<{ count: number }[]>`
        SELECT count(*)::int AS count
          FROM v_recon_break v
         WHERE v.entry_id IS NULL
           AND (${filter.includeExplained} OR v.explained_by IS NULL)`;

      const mapped: ReconBreakRow[] = rows.map((row) => {
        const b = toReconBreak(row);
        return {
          category: b.kind,
          reasonCode: b.reasonCode,
          breakKey: b.breakKey,
          externalRef: b.externalRef,
          valueDate: b.valueDate,
          ageDays: b.ageDays,
          ageBucket: b.ageBucket,
          severity: b.severity,
          rail: b.rail,
          provider: b.provider,
          entryId: b.entryId,
          fileAmountCents: b.fileAmountCents,
          ledgerAmountCents: b.ledgerAmountCents,
          breakAmountCents: b.breakAmountCents,
          description: b.description,
          explainedBy: b.explainedBy,
        };
      });

      return { rows: mapped, unattributableOpenBreaks: unattributed?.count ?? 0 };
    },

    async listPots(businessId: string): Promise<PotsSnapshot> {
      // Three reads, all scoped, none of them a second opinion about a number
      // this repo already computes. `listPots` and `readIdentity` are the pots
      // module's own queries over `v_pot_balance`, `v_pot_identity` and
      // `v_pot_subtree`; the chart code and the recursive walk live there.
      const [pots, identity] = await Promise.all([
        listPotsOfBusiness(businessId, conn),
        readPotIdentity(businessId, conn),
      ]);

      // No pots and no identity row is a legitimate state — a business that has
      // never opened one. The main balance is then the whole subtree, and
      // saying so keeps the identity check meaningful instead of reporting a
      // difference against zero.
      if (identity === null) {
        return { pots: [], mainCents: 0n, potsCents: 0n, totalCents: 0n, subtreeCents: 0n };
      }

      // Summed here as well as read from `v_pot_identity`, deliberately: this
      // is the total of the rows the caller is about to be shown, and the
      // identity figure is the database's. They agree, and the tool reports
      // both totals against the subtree walk so a disagreement would be
      // visible rather than averaged away.
      const potsCents = pots.reduce((acc, pot) => acc + pot.balanceCents, 0n);

      return {
        pots: pots.map(
          (pot): PotBalanceRow => ({
            potId: pot.potId,
            name: pot.name,
            purpose: pot.purpose,
            accountCode: pot.accountCode,
            openedAt: pot.openedAt.toISOString(),
            balanceCents: pot.balanceCents,
          }),
        ),
        mainCents: identity.mainCents,
        potsCents,
        totalCents: identity.totalCents,
        subtreeCents: identity.subtreeCents,
      };
    },

    async listPayees(businessId: string, filter: PayeeFilter): Promise<readonly PayeeRow[]> {
      // `loadPayeeBook` is the payees module's own read of `v_payee_book`, and
      // it already takes the business id — the tenant predicate is in the view
      // query rather than applied here afterwards. The filtering below is over
      // derived labels (`outcome`, `freshness`) that the view computes, so it
      // is a projection of the same rows and not a second definition of them.
      const entries = await loadPayeeBook({ businessId }, conn);

      const needle = filter.holderNameContains?.toLowerCase() ?? null;

      const matched = entries.filter((entry) => {
        if (!filter.includeArchived && entry.archived) return false;
        if (filter.rail !== null && entry.rail !== filter.rail) return false;
        if (filter.outcome !== null && entry.outcome !== filter.outcome) return false;
        if (filter.freshness !== null && entry.freshness !== filter.freshness) return false;
        if (needle !== null) {
          const haystack = `${entry.holderName} ${entry.displayName}`.toLowerCase();
          if (!haystack.includes(needle)) return false;
        }
        return true;
      });

      return matched.slice(0, filter.limit).map(
        (entry): PayeeRow => ({
          payeeId: entry.payeeId,
          displayName: entry.displayName,
          holderName: entry.holderName,
          rail: entry.rail,
          routingNumber: entry.routingNumber,
          accountNumberLast4: entry.accountNumberLast4,
          accountType: entry.accountType,
          createdAt: entry.createdAt,
          createdByName: entry.createdByName,
          archived: entry.archived,
          archivedAt: entry.archivedAt,
          checkedAt: entry.checkedAt,
          checkedByName: entry.checkedByName,
          outcome: entry.outcome,
          freshness: entry.freshness,
          checkedDaysAgo: entry.checkedDaysAgo,
          checksumOk: entry.checksumOk,
          prefixAssigned: entry.prefixAssigned,
          directory: entry.directory,
          directoryProvider: entry.directoryProvider,
          institutionName: entry.institutionName,
          nameMatch: entry.nameMatch,
          nameMatchScore: entry.nameMatchScore,
          nameSource: entry.nameSource,
          counterpartyName: entry.counterpartyName,
          evidence: entry.evidence,
          findings: findingsOf(entry.detail),
          acknowledged: entry.acknowledged,
          acknowledgedAt: entry.acknowledgedAt,
          acknowledgedByName: entry.acknowledgedByName,
          acknowledgementReason: entry.acknowledgementReason,
          hasConflictingTwin: entry.hasConflictingTwin,
        }),
      );
    },

    async listStandingOrders(
      businessId: string,
      filter: StandingOrderFilter,
    ): Promise<StandingOrderPage> {
      // `v_standing_order_schedule` carries `business_id` because a mandate
      // points at an account, and an account belongs to a business. The
      // standing-orders module's own `listStandingOrders()` is platform-wide —
      // it feeds an operator screen — so it is not reused here; the predicate
      // is pushed into the WHERE clause instead, for the same two reasons as
      // the recon read above: it is the faster plan, and there is no moment at
      // which this process holds another business's mandate in memory.
      const orders = await conn<
        {
          id: string;
          reference: string;
          account_name: string;
          rail: PayoutRail;
          amount_cents: bigint;
          currency: string;
          counterparty: unknown;
          cadence: string;
          day_of_month: number | null;
          day_of_week: number | null;
          start_date: string;
          end_date: string | null;
          created_at: Date;
          created_by_name: string;
          cancelled: boolean;
          cancelled_at: Date | null;
          cancellation_reason: string | null;
          next_due_date: string | null;
        }[]
      >`
        SELECT s.id, s.reference, s.account_name,
               s.rail::text AS rail, s.amount_cents, s.currency, s.counterparty,
               s.cadence::text AS cadence, s.day_of_month, s.day_of_week,
               s.start_date::text AS start_date, s.end_date::text AS end_date,
               s.created_at, s.created_by_name,
               s.cancelled, s.cancelled_at, s.cancellation_reason,
               n.next_due_date::text AS next_due_date
          FROM v_standing_order_schedule s
          LEFT JOIN v_standing_order_next n ON n.standing_order_id = s.id
         WHERE s.business_id = ${businessId}::uuid
           AND (${filter.includeCancelled} OR NOT s.cancelled)
         ORDER BY s.cancelled, s.created_at DESC
         LIMIT ${filter.limit}`;

      const ids = orders.map((o) => o.id);

      // One query for the occurrences of every mandate on the page rather than
      // one per mandate. `v_standing_order_history` carries its own
      // `business_id`, and BOTH predicates are applied: the id list narrows,
      // the business id is the boundary. A list of ids assembled from a scoped
      // query is already safe, but a boundary that depends on an earlier query
      // having been correct is not a boundary.
      const occurrences =
        ids.length === 0
          ? []
          : await conn<
              {
                occurrence_id: string;
                standing_order_id: string;
                scheduled_date: string;
                idempotency_key: string;
                claimed_at: Date;
                disposition: "raised" | "refused" | null;
                instruction_id: string | null;
                refusal_code: string | null;
                refusal_reason: string | null;
                observed_ledger_cents: bigint | null;
                observed_holds_cents: bigint | null;
                observed_uncleared_cents: bigint | null;
                observed_available_cents: bigint | null;
                shortfall_cents: bigint | null;
                decided_at: Date | null;
              }[]
            >`
              SELECT h.occurrence_id, h.standing_order_id,
                     h.scheduled_date::text AS scheduled_date,
                     h.idempotency_key, h.claimed_at,
                     h.disposition::text AS disposition, h.instruction_id,
                     h.refusal_code, h.refusal_reason,
                     h.observed_ledger_cents, h.observed_holds_cents,
                     h.observed_uncleared_cents, h.observed_available_cents,
                     h.shortfall_cents, h.decided_at
                FROM v_standing_order_history h
               WHERE h.business_id = ${businessId}::uuid
                 AND h.standing_order_id = ANY(${ids}::uuid[])
               ORDER BY h.scheduled_date DESC, h.claimed_at DESC
               LIMIT ${STANDING_OCCURRENCE_CEILING}`;

      return {
        orders: orders.map(
          (row): StandingOrderRow => ({
            id: row.id,
            reference: row.reference,
            accountName: row.account_name,
            rail: row.rail,
            amountCents: row.amount_cents,
            currency: row.currency.trim(),
            // jsonb is a column whose shape the database does not enforce, so
            // the boundary that reads it is the boundary that checks it —
            // `standing/store.ts` takes the same position on the same column.
            // A malformed destination renders as null rather than throwing:
            // one historical row of an unexpected shape must not take out the
            // answer to "when does my rent go out".
            destination: parseDestination(row.counterparty),
            cadence: row.cadence,
            dayOfMonth: row.day_of_month,
            dayOfWeek: row.day_of_week,
            startDate: row.start_date,
            endDate: row.end_date,
            nextDueDate: row.next_due_date,
            cancelled: row.cancelled,
            cancelledAt: row.cancelled_at?.toISOString() ?? null,
            cancellationReason: row.cancellation_reason,
            createdAt: row.created_at.toISOString(),
            createdByName: row.created_by_name,
          }),
        ),
        occurrences: occurrences.map(
          (row): StandingOccurrenceRow => ({
            occurrenceId: row.occurrence_id,
            standingOrderId: row.standing_order_id,
            scheduledDate: row.scheduled_date,
            idempotencyKey: row.idempotency_key,
            claimedAt: row.claimed_at.toISOString(),
            disposition: row.disposition,
            instructionId: row.instruction_id,
            refusalCode: row.refusal_code,
            refusalReason: row.refusal_reason,
            observedLedgerCents: row.observed_ledger_cents,
            observedHoldsCents: row.observed_holds_cents,
            observedUnclearedCents: row.observed_uncleared_cents,
            observedAvailableCents: row.observed_available_cents,
            shortfallCents: row.shortfall_cents,
            decidedAt: row.decided_at?.toISOString() ?? null,
          }),
        ),
      };
    },

    async listCardControls(
      businessId: string,
      filter: CardControlFilter,
    ): Promise<CardControlPage> {
      // Both of these are the cards module's own scoped reads. Reusing them
      // matters more here than anywhere else on this surface: the day/month
      // spend figure is the single most arguable number in the card-controls
      // feature (approved-decision sum, provider lane only, purchases only,
      // book-time windows), and a second copy of that query in this file would
      // eventually disagree with the panel a person is looking at while the
      // agent is talking to them.
      const [cards, decisions] = await Promise.all([
        listCardsWithControls(businessId, filter.limit),
        filter.decisionLimit === 0
          ? Promise.resolve([])
          : listDecisions({
              businessId,
              // Over-fetch when filtering to declines, so asking for the last
              // 20 declines does not silently return three because the other
              // seventeen of the last twenty decisions were approvals.
              limit: filter.declinesOnly
                ? Math.min(filter.decisionLimit * 5, DECISION_SCAN_CEILING)
                : filter.decisionLimit,
            }),
      ]);

      const kept = (filter.declinesOnly
        ? decisions.filter((d) => d.outcome === "decline")
        : decisions
      ).slice(0, filter.decisionLimit);

      return {
        cards: cards.map(
          (card): CardControlRow => ({
            cardId: card.cardId,
            lastFour: card.lastFour,
            nickname: card.nickname,
            createdAt: card.createdAt,
            controls: card.controls,
            spendDayCents: card.spend.dayCents,
            spendMonthCents: card.spend.monthCents,
          }),
        ),
        // `providerCardToken` and `providerAuthToken` are dropped here, on the
        // way out of the database and before anything else in this process can
        // see them. See `CardDecisionRow`.
        decisions: kept.map(
          (d): CardDecisionRow => ({
            decidedAt: d.decidedAt,
            cardId: d.cardId,
            lastFour: d.lastFour,
            nickname: d.nickname,
            amountCents: d.amountCents,
            mcc: d.mcc,
            merchantDescriptor: d.merchantDescriptor,
            requestStatus: d.requestStatus,
            outcome: d.outcome,
            resultCode: d.resultCode,
            rule: d.rule,
            judged: d.judged,
            reason: d.reason,
            controlVersion: d.controlVersion,
            decisionLatencyUs: d.decisionLatencyUs,
            source: d.source,
          }),
        ),
      };
    },

    async listDisputes(businessId: string, filter: DisputeFilter): Promise<DisputePage> {
      // `listDisputeStates` is the disputes module's OWN read of
      // `v_dispute_state`, and it already takes a business id — the tenant
      // predicate is in its WHERE clause, not applied here afterwards.
      //
      // IMPORTED FROM `@/lib/disputes/store` AND NOT FROM `@/lib/disputes`.
      // The barrel re-exports `./operations`, which imports `postEntry`. A
      // named import from the barrel would bring in one binding and nothing
      // else, so nothing would become CALLABLE — but it would put the
      // journal-writing module into this process's graph, and "the MCP module
      // does not import ledger/post.ts" is the strongest sentence in
      // docs/AGENT-LIMITS.md. It stays true by reaching past the barrel.
      // `no-write-imports.test.ts` now fails the build on either spelling.
      const states = await listDisputeStates(
        { businessId, limit: DISPUTE_SCAN_CEILING },
        conn,
      );

      // Counted over every case, then filtered. A caller asking for open cases
      // and being told "0" should still learn that eleven closed ones exist —
      // otherwise "do we have any disputes" gets the wrong answer from the
      // tool that was supposed to know.
      const openCount = states.filter((s) => !s.isClosed).length;
      const closedCount = states.length - openCount;

      const matched = states.filter((state) => {
        if (filter.status !== null) return state.status === filter.status;
        if (filter.openOnly && state.isClosed) return false;
        return true;
      });

      const page = matched.slice(0, filter.limit);

      // One events query per case on the page, in parallel, and only when the
      // caller asked. A case has at most a dozen events, and the page is
      // capped at 25 — so this is bounded by construction rather than by hope.
      const eventsByCase = filter.includeEvents
        ? await Promise.all(page.map((state) => listDisputeEvents(state.id, conn)))
        : page.map(() => []);

      return {
        cases: page.map((state, index): DisputeRowProjection => {
          const events = eventsByCase[index] ?? [];
          return {
            disputeId: state.id,
            caseRef: state.caseRef,
            disputedEntryId: state.disputedEntryId,
            reason: state.reason,
            network: state.network,
            networkCode: state.networkCode,
            narrative: state.narrative,
            amountCents: state.amountCents,
            status: state.status,
            isClosed: state.isClosed,
            raisedByName: state.raisedByName,
            raisedAt: state.raisedAt,
            valueDate: state.valueDate,
            decidedOn: state.decidedOn,
            networkOutsideDate: state.networkOutsideDate,
            daysToOutsideDate: state.daysToOutsideDate,
            advancedCents: state.advancedCents,
            heldCents: state.heldCents,
            holdReleased: state.holdReleased,
            needsAuthorization: state.needsAuthorization,
            authorizations: state.authorizations,
            requiredApprovals: state.requiredApprovals,
            thresholdCents: state.thresholdCents,
            events: events.map(
              (event): DisputeEventProjection => ({
                kind: event.kind,
                occurredAt: event.occurredAt,
                valueDate: event.valueDate,
                actorName: event.actorName,
                actorKind: event.actorKind,
                amountCents: event.amountCents,
                entryId: event.entryId,
                detail: event.detail,
              }),
            ),
          };
        }),
        openCount,
        closedCount,
      };
    },

    async listAccruals(businessId: string, filter: AccrualFilter): Promise<AccrualPage> {
      // TENANCY WITHOUT TOUCHING THE LEDGER'S TABLES.
      //
      // The accrual tables key on `account_id` and carry no `business_id`, so
      // the obvious query is `JOIN account a ON a.id = s.account_id WHERE
      // a.business_id = $1` — seven times over, once per statement below. That
      // is seven new direct references to `account` from a module outside
      // `src/lib/ledger/**`, which is precisely the debt `ledger/boundary.test.ts`
      // is a ratchet against: 235 such references across 50 files is how this
      // system ended up with four disagreeing definitions of a balance.
      //
      // So the business's accounts are resolved ONCE, through the ledger's own
      // named reader, and the accrual queries filter on that id list. The list
      // is small — a business has a handful of leaves — and it comes from the
      // single definition of "which accounts are this business's" rather than
      // from a predicate this file writes seven times and could get subtly
      // wrong in one of them.
      //
      // `v_accrual_month` is the exception and it needs no help: the view
      // carries its own `business_id` column, so the predicate is direct.
      const accounts = await listAccounts({ businessId }, conn);
      const accountIds = accounts.map((a) => a.accountId);
      if (accountIds.length === 0) {
        return {
          schedules: [],
          months: [],
          days: [],
          invariants: { monthDrift: 0, ledgerDrift: 0, unresolved: 0, gapDays: 0 },
          accruedToDateCents: 0n,
        };
      }

      // What is NOT re-derived here is the arithmetic. Every figure below is a
      // stored column that `accrual_posting_arithmetic` re-computed with
      // `accrual_daily_share()` before Postgres would accept the row.
      const [schedules, months, days, invariants, accrued] = await Promise.all([
        conn<
          {
            schedule_id: string;
            plan_name: string;
            product: string;
            account_id: string;
            monthly_cents: bigint;
            currency: string;
            start_date: string;
            end_date: string | null;
          }[]
        >`
          SELECT s.id AS schedule_id, s.plan_name, s.product::text AS product,
                 s.account_id, s.monthly_cents, s.currency,
                 s.start_date::text AS start_date, s.end_date::text AS end_date
            FROM accrual_schedule s
           WHERE s.account_id = ANY(${accountIds}::uuid[])
           ORDER BY s.start_date DESC, s.plan_name
           LIMIT ${filter.scheduleLimit}`,

        conn<
          {
            schedule_id: string;
            plan_name: string;
            month_start: string;
            days_in_month: number;
            monthly_cents: bigint;
            residual_pennies_in_month: number;
            residual_pennies_applied: bigint;
            days_claimed: bigint;
            days_decided: bigint;
            days_posted: bigint;
            days_skipped: bigint;
            accrued_cents: bigint;
            remaining_cents: bigint;
            month_complete: boolean;
          }[]
        >`
          SELECT m.schedule_id, m.plan_name, m.month_start::text AS month_start,
                 m.days_in_month, m.monthly_cents, m.residual_pennies_in_month,
                 m.residual_pennies_applied, m.days_claimed, m.days_decided,
                 m.days_posted, m.days_skipped,
                 -- SUM(bigint) is numeric in Postgres and the driver's bigint
                 -- override keys on OID 20, so an uncast aggregate arrives as
                 -- a JS number. Cast, or the money silently stops being exact.
                 m.accrued_cents::bigint   AS accrued_cents,
                 m.remaining_cents::bigint AS remaining_cents,
                 m.month_complete
            FROM v_accrual_month m
           WHERE m.business_id = ${businessId}::uuid
           ORDER BY m.month_start DESC, m.plan_name
           LIMIT ${filter.monthLimit}`,

        conn<
          {
            schedule_id: string;
            plan_name: string;
            accrual_date: string;
            disposition: "posted" | "skipped" | null;
            entry_id: string | null;
            skip_reason: string | null;
            monthly_cents: bigint | null;
            days_in_month: number | null;
            day_of_month: number | null;
            base_share_cents: bigint | null;
            residual_pennies: number | null;
            residual_applied: boolean | null;
            amount_cents: bigint | null;
            cumulative_cents: bigint | null;
            claimed_at: Date;
            decided_at: Date | null;
          }[]
        >`
          SELECT ad.schedule_id, s.plan_name,
                 ad.accrual_date::text AS accrual_date,
                 ap.disposition::text  AS disposition,
                 ap.entry_id, ap.skip_reason,
                 ap.monthly_cents, ap.days_in_month, ap.day_of_month,
                 ap.base_share_cents, ap.residual_pennies, ap.residual_applied,
                 ap.amount_cents, ap.cumulative_cents,
                 ad.claimed_at, ap.decided_at
            FROM accrual_day ad
            JOIN accrual_schedule s ON s.id = ad.schedule_id
            LEFT JOIN accrual_posting ap ON ap.accrual_day_id = ad.id
           WHERE s.account_id = ANY(${accountIds}::uuid[])
             AND (${filter.includeSkipped} OR ap.disposition IS DISTINCT FROM 'skipped')
           ORDER BY ad.accrual_date DESC, s.plan_name
           LIMIT ${filter.dayLimit}`,

        conn<
          { month_drift: bigint; ledger_drift: bigint; unresolved: bigint; gap_days: bigint }[]
        >`
          SELECT
            (SELECT count(*) FROM v_accrual_month_drift d
              WHERE d.account_id = ANY(${accountIds}::uuid[]))   AS month_drift,
            (SELECT count(*)
               FROM v_accrual_ledger_drift d
               JOIN accrual_day ad      ON ad.id = d.accrual_day_id
               JOIN accrual_schedule s  ON s.id  = ad.schedule_id
              WHERE s.account_id = ANY(${accountIds}::uuid[]))   AS ledger_drift,
            (SELECT count(*) FROM v_accrual_unresolved u
              WHERE u.account_id = ANY(${accountIds}::uuid[]))   AS unresolved,
            (SELECT count(*) FROM v_accrual_gap g
              WHERE g.account_id = ANY(${accountIds}::uuid[]))   AS gap_days`,

        conn<{ total: bigint }[]>`
          SELECT COALESCE(SUM(ap.amount_cents), 0)::bigint AS total
            FROM accrual_posting ap
            JOIN accrual_day ad     ON ad.id = ap.accrual_day_id
            JOIN accrual_schedule s ON s.id  = ad.schedule_id
           WHERE s.account_id = ANY(${accountIds}::uuid[])
             AND ap.disposition = 'posted'`,
      ]);

      const counts = invariants[0];
      const nameOf = new Map(accounts.map((a) => [a.accountId, a.name]));

      return {
        schedules: schedules.map(
          (row): AccrualScheduleRow => ({
            scheduleId: row.schedule_id,
            planName: row.plan_name,
            product: row.product,
            accountName: nameOf.get(row.account_id) ?? "",
            monthlyCents: row.monthly_cents,
            currency: row.currency.trim(),
            startDate: row.start_date,
            endDate: row.end_date,
          }),
        ),
        months: months.map(
          (row): AccrualMonthRow => ({
            scheduleId: row.schedule_id,
            planName: row.plan_name,
            monthStart: row.month_start,
            daysInMonth: row.days_in_month,
            monthlyCents: row.monthly_cents,
            residualPenniesInMonth: row.residual_pennies_in_month,
            residualPenniesApplied: Number(row.residual_pennies_applied),
            daysClaimed: Number(row.days_claimed),
            daysDecided: Number(row.days_decided),
            daysPosted: Number(row.days_posted),
            daysSkipped: Number(row.days_skipped),
            accruedCents: row.accrued_cents,
            remainingCents: row.remaining_cents,
            monthComplete: row.month_complete,
          }),
        ),
        days: days.map(
          (row): AccrualDayRow => ({
            scheduleId: row.schedule_id,
            planName: row.plan_name,
            accrualDate: row.accrual_date,
            disposition: row.disposition,
            entryId: row.entry_id,
            skipReason: row.skip_reason,
            monthlyCents: row.monthly_cents,
            daysInMonth: row.days_in_month,
            dayOfMonth: row.day_of_month,
            baseShareCents: row.base_share_cents,
            residualPennies: row.residual_pennies,
            residualApplied: row.residual_applied,
            amountCents: row.amount_cents,
            cumulativeCents: row.cumulative_cents,
            claimedAt: row.claimed_at.toISOString(),
            decidedAt: row.decided_at?.toISOString() ?? null,
          }),
        ),
        invariants: {
          monthDrift: Number(counts?.month_drift ?? 0n),
          ledgerDrift: Number(counts?.ledger_drift ?? 0n),
          unresolved: Number(counts?.unresolved ?? 0n),
          gapDays: Number(counts?.gap_days ?? 0n),
        },
        accruedToDateCents: accrued[0]?.total ?? 0n,
      };
    },

    async queuePayment(input: QueuePaymentInput): Promise<QueuedPayment> {
      // `requestPayment` is the approvals module's own entry point for this
      // surface. It validates, picks the policy version in force on the value
      // date, computes the content hash over its canonical preimage, inserts
      // the instruction and appends the `requested` event — all in one
      // transaction. Nothing about payments is re-implemented here.
      const requested = await requestPayment(
        {
          accountId: input.accountId,
          rail: input.rail,
          amountCents: input.amountCents,
          currency: input.currency,
          destination: input.destination,
          valueDate: input.valueDate,
          requestedByActorId: input.requestedByActorId,
          idempotencyKey: input.idempotencyKey,
        },
        conn,
      );

      if (!requested.ok) {
        throw new ToolError(requested.error.code, requested.error.message, {
          details: requested.error.details,
        });
      }

      // Read the instruction back rather than describing what we think we
      // wrote. The state comes from folding the event stream, the approvals
      // held are counted the way the trigger counts them, and `requested_at`
      // is the row's own timestamp — which matters on a replay, where the
      // honest answer is when the ORIGINAL was raised.
      const stored = await getPayment(requested.value.instructionId, conn);
      if (!stored.ok) {
        throw new ToolError(stored.error.code, stored.error.message);
      }

      const queued = stored.value;
      return {
        instructionId: queued.instruction.id,
        contentHash: queued.instruction.contentHash,
        replayed: !requested.value.created,
        requestedAt: queued.instruction.requestedAt,
        state: queued.state,
        approvalsHeld: queued.approvalsHeld,
        approvalsRequired: queued.approvalsRequired,
        aboveThreshold: queued.aboveThreshold,
        policy: {
          policyId: queued.instruction.policy.id,
          version: queued.instruction.policy.version,
          rail: queued.instruction.policy.rail,
          effectiveFrom: queued.instruction.policy.effectiveFrom,
          thresholdCents: queued.instruction.policy.thresholdCents,
          requiredApprovals: queued.instruction.policy.requiredApprovals,
          note: queued.instruction.policy.note,
        },
      };
    },
  };
}

/**
 * Ledger balance, hold itemisation and available balance for one account, at
 * one point on each of the two time axes.
 *
 * available = ledger - card authorisation holds - uncleared credits, and the
 * subtrahends are computed from the memo book rather than read off a column,
 * which is the whole point: there is no `available_balance` anywhere to drift.
 *
 * Holds attach to the customer's deposit account, so for any other account of
 * the business (there are none postable today, but the chart allows them) the
 * hold terms are zero and available equals ledger. That is correct rather than
 * convenient — a hold on the deposit account does not encumber a different
 * account.
 */
async function snapshot(
  conn: Sql,
  businessId: string,
  accountId: string,
  point: LedgerSnapshot,
): Promise<BalanceSnapshot> {
  // THE TENANT CHECK, MADE EXPLICIT RATHER THAN INHERITED.
  //
  // Every caller reaches this through `findAccount(businessId, code)`, so the
  // account id is already the product of a scoped lookup. That is not a
  // boundary — it is a boundary that depends on an earlier query having been
  // correct, which this file refuses to rely on elsewhere and should not rely
  // on here. `ledger_availability()` takes an account id and no business, so
  // the predicate that used to ride along inside the hold query has to be
  // stated somewhere, and stating it is one indexed lookup by primary key.
  const identity = await readAccountIdentity(accountId, conn);
  if (identity === null || identity.businessId !== businessId) {
    throw new ToolError(
      "ACCOUNT_NOT_FOUND",
      "That account does not belong to the business this token is scoped to.",
    );
  }

  // THE ONE DEFINITION. `accountAvailability` is a single call to
  // `ledger_availability()` — the same function `v_available_balance` and
  // `v_balance_definition_drift` are built on, and therefore the same number
  // the customer's own screen shows. See the block at the top of this file for
  // what this replaced and what it cost.
  //
  // The itemisation runs beside it for the hold SPLIT and the counts, which
  // the availability function does not return. Its money terms are used only
  // to name the card-authorisation share; the totals are the authority's.
  const [availability, itemisation] = await Promise.all([
    accountAvailability(accountId, point, conn),
    holdItemisationAsOf(
      {
        businessId,
        accountId,
        asOfValueDate: point.valueDate,
        asOfBookingSeq: point.bookingWatermark,
        closureCutoff: point.asOf,
      },
      conn,
    ),
  ]);

  // Everything the itemisation can name, and everything it cannot, separately.
  // `otherHoldsCents` is the term that was previously missing altogether: the
  // authoritative hold total less the card authorisations, which is the
  // operator (`manual`) holds. Clamped at zero because it is a description
  // rather than an input — if the two ever disagreed the other way, the
  // authoritative total still stands and the split is what is wrong.
  const cardAuthHoldsCents =
    itemisation.holdsCents > availability.holdsCents
      ? availability.holdsCents
      : itemisation.holdsCents;
  const otherHoldsCents = availability.holdsCents - cardAuthHoldsCents;

  return {
    ledgerCents: availability.ledgerCents,
    holdsCents: availability.holdsCents,
    cardAuthHoldsCents,
    otherHoldsCents,
    unclearedCents: availability.unclearedCents,
    pendingOutboundCents: availability.pendingOutboundCents,
    // Allowed to go negative, deliberately: an over-captured fuel-pump
    // authorisation settles above what was authorised and the customer really
    // is overdrawn. A floor at zero would hide that from the agent.
    availableCents: availability.availableCents,
    cardHoldCount: itemisation.cardHoldCount,
    unclearedHoldCount: itemisation.unclearedHoldCount,
  };
}


