/**
 * The database side of card controls.
 *
 * SERVER ONLY. Two of the four functions below are on a path where a
 * cardholder is standing at a terminal, and the shape of this file is decided
 * by that:
 *
 *   readControlsAndSpend()   ONE round trip. Card, current control version and
 *                            both velocity windows in a single statement.
 *   appendDecision()         ONE insert. No transaction, nothing to lock.
 *   setCardControls()        off the hot path; writes version N+1.
 *   listDecisions() /
 *   listCardsWithControls()  off the hot path; the console's reads.
 *
 * NOTHING HERE TOUCHES THE JOURNAL. Not `journal_entry`, not `journal_line`,
 * not `ledger_append()`, not `hold`. The synchronous decision path reads
 * controls and recent spend and returns a verdict; money still moves on the
 * asynchronous `card_transaction.updated` webhook, through the inbox and the
 * consumer that already exist. The reason is in the header of `./decide.ts`
 * and it is worth repeating in the file that holds the SQL: a synchronous
 * decision that writes is a synchronous decision that can block on the
 * journal's append lock, and a blocked decision is a declined card.
 *
 * The connection is `@/lib/ledger/db`'s `sql`, deliberately, rather than a
 * second pool. It connects as `corgi_app`, which holds SELECT and INSERT on
 * these two tables and — provably, `pnpm db:check` — no UPDATE or DELETE
 * anywhere. A second handle would double this instance's connection footprint
 * against Neon's limit to gain nothing.
 */

import "server-only";

import { sql } from "@/lib/ledger/db";

import { CONTROL_READ_BUDGET_MS, DECISION_APPEND_BUDGET_MS, withDeadline } from "./budget";
import {
  PURCHASE_STATUSES,
  type AuthRequest,
  type CardControls,
  type CardControlsDraft,
  type CardState,
  type ControlLookup,
  type DecisionOutcome,
  type DecisionRecord,
  type DecisionSource,
  type Verdict,
} from "./types";

/* -------------------------------------------------------------------------- */
/* 1. The hot path read                                                       */
/* -------------------------------------------------------------------------- */

type LookupRow = {
  readonly card_id: string;
  readonly control_version_id: string | null;
  readonly version: number | null;
  readonly effective_from: Date | null;
  readonly card_state: CardState | null;
  readonly per_txn_limit_cents: bigint | null;
  readonly daily_limit_cents: bigint | null;
  readonly monthly_limit_cents: bigint | null;
  readonly blocked_mccs: string[] | null;
  readonly note: string | null;
  readonly day_cents: bigint;
  readonly month_cents: bigint;
};

/**
 * Everything the decision needs, in one statement.
 *
 * WHY ONE STATEMENT AND NOT THREE. Three obvious queries — find the card, read
 * its controls, sum its spend — is three round trips. On a warm instance in
 * `iad1` against Neon that is roughly 3 × 4 ms; on a cold one, or across a
 * region, it is 3 × 60 ms, and it is 3 chances to be the query that hangs.
 * The budget (`CONTROL_READ_BUDGET_MS`, 600 ms) is spent on ONE thing so that
 * a deadline miss is unambiguous: the store is gone, and `decide()` fails
 * closed with the reason recorded.
 *
 * WHY THE VELOCITY SUM IS OVER OUR OWN DECISIONS. See the long note on
 * `SpendToDate` in `./types.ts`. Short version: the ASA call happens before
 * anything asynchronous has arrived, so a ledger-derived figure would let five
 * $9 authorisations in four seconds all pass a $20 daily limit. Our own
 * decision log is the only source that already knows.
 *
 * THE FOUR FILTERS ON THAT SUM ARE EACH LOAD-BEARING:
 *   outcome = 'approve'   a decline consumed nothing.
 *   source = $source      a harness replay must not eat a real card's daily
 *                         limit, and a real purchase must not make a harness
 *                         assertion pass. The honesty column, enforced in SQL.
 *   request_status IN …   a refund is not spend (`PURCHASE_STATUSES`).
 *   decided_at >= now() - 40 days
 *                         prunes the scan to the partial index
 *                         `card_auth_decision_velocity_idx`. 40 rather than 31
 *                         because a month window opens on the first of the
 *                         book month and `book_date()` is America/New_York:
 *                         at 23:00 on the 31st, UTC has already rolled over.
 *
 * THE WINDOWS ARE BOOK WINDOWS. `book_date()` is migration 0001's function and
 * it is America/New_York — the same clock a statement closes on. A daily limit
 * that reset at UTC midnight would reset at 7pm local and nobody would be able
 * to explain why.
 */
export async function readControlsAndSpend(params: {
  readonly provider: string;
  readonly providerCardToken: string;
  readonly source: DecisionSource;
  readonly budgetMs?: number;
}): Promise<ControlLookup> {
  const budget = params.budgetMs ?? CONTROL_READ_BUDGET_MS;

  try {
    const rows = await withDeadline(
      sql<LookupRow[]>`
        SELECT c.id                       AS card_id,
               cc.control_version_id,
               cc.version,
               cc.effective_from,
               cc.card_state,
               cc.per_txn_limit_cents,
               cc.daily_limit_cents,
               cc.monthly_limit_cents,
               cc.blocked_mccs,
               cc.note,
               s.day_cents,
               s.month_cents
          FROM card c
          LEFT JOIN v_card_control_current cc ON cc.card_id = c.id
          CROSS JOIN LATERAL (
            SELECT
              COALESCE(SUM(d.amount_cents) FILTER (
                WHERE book_date(d.decided_at) = book_date(now())
              ), 0)::bigint AS day_cents,
              COALESCE(SUM(d.amount_cents) FILTER (
                WHERE date_trunc('month', book_date(d.decided_at))
                    = date_trunc('month', book_date(now()))
              ), 0)::bigint AS month_cents
            FROM card_auth_decision d
            WHERE d.card_id = c.id
              AND d.outcome = 'approve'
              AND d.source = ${params.source}
              AND d.request_status = ANY(${PURCHASE_STATUSES as string[]})
              AND d.decided_at >= now() - interval '40 days'
          ) s
         WHERE c.provider = ${params.provider}
           AND c.provider_card_token = ${params.providerCardToken}
         LIMIT 1
      `,
      budget,
      "control read",
    );

    const row = rows[0];
    // No row is a SUCCESSFUL read whose answer is "this book has never seen
    // that card token". It is emphatically not a failure, and `decide()`
    // treats the two oppositely — see `card_not_under_control`.
    if (row === undefined) {
      return { status: "read", cardId: null, controls: null, spend: { dayCents: 0n, monthCents: 0n } };
    }

    return {
      status: "read",
      cardId: row.card_id,
      controls: toControls(row),
      spend: { dayCents: row.day_cents, monthCents: row.month_cents },
    };
  } catch (thrown) {
    return {
      status: "unavailable",
      detail: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : "control read failed",
    };
  }
}

function toControls(row: LookupRow): CardControls | null {
  if (
    row.control_version_id === null ||
    row.version === null ||
    row.card_state === null ||
    row.effective_from === null
  ) {
    return null;
  }
  return {
    cardId: row.card_id,
    controlVersionId: row.control_version_id,
    version: row.version,
    effectiveFrom: row.effective_from.toISOString(),
    cardState: row.card_state,
    perTxnLimitCents: row.per_txn_limit_cents,
    dailyLimitCents: row.daily_limit_cents,
    monthlyLimitCents: row.monthly_limit_cents,
    blockedMccs: row.blocked_mccs ?? [],
    note: row.note ?? "",
  };
}

/* -------------------------------------------------------------------------- */
/* 2. The append                                                              */
/* -------------------------------------------------------------------------- */

export type AppendDecisionParams = {
  readonly provider: string;
  readonly request: AuthRequest;
  readonly lookup: ControlLookup;
  readonly verdict: Verdict;
  readonly latencyUs: number;
  readonly source: DecisionSource;
  readonly requestId: string | null;
};

/**
 * Record one decision. Append-only; there is no other verb available.
 *
 * Returns the row id, or null if the insert failed. A NULL RETURN IS NOT
 * SWALLOWED BY THE CALLER — the route logs it at `error` and re-tries the
 * append in `after()`. The response still goes out either way, because the
 * cardholder's purchase must not fail because our audit trail was slow.
 *
 * `inputs` is passed through `sql.json`. Money inside it is already decimal
 * strings (see `cents()` in `./decide.ts`); jsonb would happily store a
 * `numeric`, but every reader between here and a screen is JavaScript, and
 * `JSON.parse` turns 9007199254740993 into 9007199254740992.
 */
export async function appendDecision(
  params: AppendDecisionParams,
  budgetMs: number = DECISION_APPEND_BUDGET_MS,
): Promise<string | null> {
  const { request, verdict, lookup } = params;
  const cardId = lookup.status === "read" ? lookup.cardId : null;
  const controlVersionId =
    lookup.status === "read" && lookup.controls !== null
      ? lookup.controls.controlVersionId
      : null;

  try {
    const rows = await withDeadline(
      sql<{ id: string }[]>`
        INSERT INTO card_auth_decision (
          provider, provider_auth_token, provider_card_token,
          card_id, control_version_id,
          amount_cents, mcc, merchant_descriptor, request_status,
          outcome, result_code, rule, reason, inputs,
          decision_latency_us, source, request_id
        ) VALUES (
          ${params.provider}, ${request.providerAuthToken}, ${request.card.token},
          ${cardId}, ${controlVersionId},
          ${request.amountCents}, ${request.mcc}, ${request.merchantDescriptor},
          ${request.requestStatus},
          ${verdict.outcome}, ${verdict.result}, ${verdict.rule}, ${verdict.reason},
          ${sql.json(verdict.inputs as Parameters<typeof sql.json>[0])},
          ${params.latencyUs}, ${params.source}, ${params.requestId}
        )
        RETURNING id
      `,
      budgetMs,
      "decision append",
    );
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* 3. Setting controls — off the hot path                                     */
/* -------------------------------------------------------------------------- */

export type SetControlsOutcome =
  | { readonly ok: true; readonly controls: CardControls }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Write version N+1.
 *
 * There is no UPDATE. A control change is an INSERT, the same way a correction
 * to the ledger is a reversal plus a re-book: the version a past decision cited
 * has to still say what it said when the decision was made, or the decision log
 * is worthless.
 *
 * CONCURRENCY. Two operators pressing Save in the same second both compute
 * N+1, both insert, and `UNIQUE (card_id, version)` lets exactly one through.
 * The loser is retried ONCE, against the version the winner wrote — so the
 * second save is applied on top of the first rather than silently discarding
 * it. One retry and not a loop: a second collision means genuine contention on
 * one card, and a screen that spins is worse than a screen that says "someone
 * else just changed this, look again".
 *
 * The version arithmetic is also checked in the database by
 * `assert_card_control_version()`. Both, on purpose: the trigger is the
 * guarantee, this is the retry that turns the guarantee into a usable screen.
 */
export async function setCardControls(params: {
  readonly cardId: string;
  readonly draft: CardControlsDraft;
  readonly actorId: string;
}): Promise<SetControlsOutcome> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [current] = await sql<{ version: number }[]>`
      SELECT version FROM card_control_version
       WHERE card_id = ${params.cardId}
       ORDER BY version DESC
       LIMIT 1
    `;
    const nextVersion = (current?.version ?? 0) + 1;

    try {
      const [row] = await sql<
        {
          id: string;
          version: number;
          effective_from: Date;
        }[]
      >`
        INSERT INTO card_control_version (
          card_id, version, card_state,
          per_txn_limit_cents, daily_limit_cents, monthly_limit_cents,
          blocked_mccs, note, created_by
        ) VALUES (
          ${params.cardId}, ${nextVersion}, ${params.draft.cardState},
          ${params.draft.perTxnLimitCents}, ${params.draft.dailyLimitCents},
          ${params.draft.monthlyLimitCents},
          ${params.draft.blockedMccs as string[]}, ${params.draft.note}, ${params.actorId}
        )
        RETURNING id, version, effective_from
      `;
      if (row === undefined) {
        return { ok: false, code: "NOT_WRITTEN", message: "The control version was not written." };
      }
      return {
        ok: true,
        controls: {
          cardId: params.cardId,
          controlVersionId: row.id,
          version: row.version,
          effectiveFrom: row.effective_from.toISOString(),
          cardState: params.draft.cardState,
          perTxnLimitCents: params.draft.perTxnLimitCents,
          dailyLimitCents: params.draft.dailyLimitCents,
          monthlyLimitCents: params.draft.monthlyLimitCents,
          blockedMccs: params.draft.blockedMccs,
          note: params.draft.note,
        },
      };
    } catch (thrown) {
      const code = (thrown as { code?: string }).code;
      // 23505 unique_violation: somebody else took this version number.
      if (code === "23505" && attempt === 0) continue;
      if (code === "23505") {
        return {
          ok: false,
          code: "VERSION_RACE",
          message:
            "Another change to this card's controls landed while this one was being written. Reload and apply it again.",
        };
      }
      return {
        ok: false,
        code: code ?? "CONTROL_WRITE_FAILED",
        message: thrown instanceof Error ? thrown.message : "The control version was not written.",
      };
    }
  }
  return { ok: false, code: "VERSION_RACE", message: "The control version was not written." };
}

/* -------------------------------------------------------------------------- */
/* 4. The console's reads                                                     */
/* -------------------------------------------------------------------------- */

export type CardWithControls = {
  readonly cardId: string;
  readonly providerCardToken: string;
  readonly lastFour: string | null;
  readonly nickname: string | null;
  readonly createdAt: string;
  readonly controls: CardControls | null;
  /** Approved purchase spend today and this book month, in the provider lane. */
  readonly spend: { readonly dayCents: bigint; readonly monthCents: bigint };
};

/**
 * Every card on one business, with its current controls and today's spend.
 *
 * Newest first, capped. A business with 90 test cards on it — this book has
 * one — must not render 90 control panels; the panel is for the cards someone
 * is actually working with, and the cap is stated on the screen rather than
 * silently applied.
 */
export async function listCardsWithControls(
  businessId: string,
  limit = 6,
): Promise<readonly CardWithControls[]> {
  const rows = await sql<
    (LookupRow & {
      provider_card_token: string;
      last_four: string | null;
      nickname: string | null;
      created_at: Date;
    })[]
  >`
    SELECT c.id                       AS card_id,
           c.provider_card_token,
           c.last_four,
           c.nickname,
           c.created_at,
           cc.control_version_id,
           cc.version,
           cc.effective_from,
           cc.card_state,
           cc.per_txn_limit_cents,
           cc.daily_limit_cents,
           cc.monthly_limit_cents,
           cc.blocked_mccs,
           cc.note,
           s.day_cents,
           s.month_cents
      FROM card c
      LEFT JOIN v_card_control_current cc ON cc.card_id = c.id
      CROSS JOIN LATERAL (
        SELECT
          COALESCE(SUM(d.amount_cents) FILTER (
            WHERE book_date(d.decided_at) = book_date(now())
          ), 0)::bigint AS day_cents,
          COALESCE(SUM(d.amount_cents) FILTER (
            WHERE date_trunc('month', book_date(d.decided_at))
                = date_trunc('month', book_date(now()))
          ), 0)::bigint AS month_cents
        FROM card_auth_decision d
        WHERE d.card_id = c.id
          AND d.outcome = 'approve'
          AND d.source = 'provider'
          AND d.request_status = ANY(${PURCHASE_STATUSES as string[]})
          AND d.decided_at >= now() - interval '40 days'
      ) s
     WHERE c.business_id = ${businessId}
     ORDER BY c.created_at DESC
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    cardId: row.card_id,
    providerCardToken: row.provider_card_token,
    lastFour: row.last_four,
    nickname: row.nickname,
    createdAt: row.created_at.toISOString(),
    controls: toControls(row),
    spend: { dayCents: row.day_cents, monthCents: row.month_cents },
  }));
}

type DecisionRow = {
  readonly id: string;
  readonly decided_at: Date;
  readonly provider: string;
  readonly provider_auth_token: string;
  readonly provider_card_token: string;
  readonly card_id: string | null;
  readonly last_four: string | null;
  readonly nickname: string | null;
  readonly control_version: number | null;
  readonly amount_cents: bigint;
  readonly mcc: string | null;
  readonly merchant_descriptor: string | null;
  readonly request_status: string;
  readonly outcome: DecisionOutcome;
  readonly result_code: string;
  readonly rule: string;
  readonly reason: string;
  readonly inputs: Record<string, unknown>;
  readonly decision_latency_us: number;
  readonly source: DecisionSource;
};

/**
 * The decision history, newest first.
 *
 * `businessId` filters to one customer's cards; a decision on an unregistered
 * card token belongs to no business and is therefore invisible here, which is
 * correct — it is in the table, and `/api/health` and the SQL both find it,
 * but a customer's screen should not show authorisations on somebody else's
 * card.
 */
export async function listDecisions(params: {
  readonly businessId: string;
  readonly limit?: number;
}): Promise<readonly DecisionRecord[]> {
  const rows = await sql<DecisionRow[]>`
    SELECT d.id, d.decided_at, d.provider, d.provider_auth_token, d.provider_card_token,
           d.card_id, d.last_four, d.nickname, d.control_version,
           d.amount_cents, d.mcc, d.merchant_descriptor, d.request_status,
           d.outcome, d.result_code, d.rule, d.reason, d.inputs,
           d.decision_latency_us, d.source
      FROM v_card_auth_decision d
     WHERE d.business_id = ${params.businessId}
     ORDER BY d.decided_at DESC
     LIMIT ${params.limit ?? 25}
  `;

  return rows.map((row) => ({
    id: row.id,
    decidedAt: row.decided_at.toISOString(),
    provider: row.provider,
    providerAuthToken: row.provider_auth_token,
    providerCardToken: row.provider_card_token,
    cardId: row.card_id,
    lastFour: row.last_four,
    nickname: row.nickname,
    controlVersion: row.control_version,
    amountCents: row.amount_cents,
    mcc: row.mcc,
    merchantDescriptor: row.merchant_descriptor,
    requestStatus: row.request_status,
    outcome: row.outcome,
    resultCode: row.result_code,
    rule: row.rule,
    reason: row.reason,
    inputs: row.inputs,
    decisionLatencyUs: row.decision_latency_us,
    source: row.source,
  }));
}

/** Every version of one card's controls, newest first. The audit trail. */
export async function listControlVersions(
  cardId: string,
  limit = 12,
): Promise<readonly (CardControls & { readonly createdAt: string })[]> {
  const rows = await sql<
    {
      id: string;
      version: number;
      effective_from: Date;
      card_state: CardState;
      per_txn_limit_cents: bigint | null;
      daily_limit_cents: bigint | null;
      monthly_limit_cents: bigint | null;
      blocked_mccs: string[];
      note: string;
      created_at: Date;
    }[]
  >`
    SELECT id, version, effective_from, card_state,
           per_txn_limit_cents, daily_limit_cents, monthly_limit_cents,
           blocked_mccs, note, created_at
      FROM card_control_version
     WHERE card_id = ${cardId}
     ORDER BY version DESC
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    cardId,
    controlVersionId: row.id,
    version: row.version,
    effectiveFrom: row.effective_from.toISOString(),
    cardState: row.card_state,
    perTxnLimitCents: row.per_txn_limit_cents,
    dailyLimitCents: row.daily_limit_cents,
    monthlyLimitCents: row.monthly_limit_cents,
    blockedMccs: row.blocked_mccs,
    note: row.note,
    createdAt: row.created_at.toISOString(),
  }));
}
