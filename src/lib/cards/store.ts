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
import { isMemberState, isTeamRole } from "@/lib/team/roles";

import { CONTROL_READ_BUDGET_MS, DECISION_APPEND_BUDGET_MS, withDeadline } from "./budget";
import {
  PURCHASE_STATUSES,
  isJudgedRule,
  type AuthRequest,
  type CardControls,
  type CardControlsDraft,
  type CardState,
  type ControlLookup,
  type DecisionOutcome,
  type DecisionRecord,
  type DecisionSource,
  type MemberDecisionTerms,
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

/** The member half of the same row. All null for a card nobody holds. */
type MemberRow = {
  readonly member_id: string | null;
  readonly member_version_id: string | null;
  readonly member_version: number | null;
  readonly member_name: string | null;
  readonly member_state: string | null;
  readonly member_role: string | null;
  readonly member_per_txn_limit_cents: bigint | null;
  readonly member_daily_limit_cents: bigint | null;
  readonly member_monthly_limit_cents: bigint | null;
  readonly member_day_cents: bigint;
  readonly member_month_cents: bigint;
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
      sql<(LookupRow & MemberRow)[]>`
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
               s.month_cents,
               cm.member_id,
               mv.member_version_id,
               mv.version              AS member_version,
               ma.display_name         AS member_name,
               mv.state                AS member_state,
               mv.role                 AS member_role,
               mv.per_txn_limit_cents  AS member_per_txn_limit_cents,
               mv.daily_limit_cents    AS member_daily_limit_cents,
               mv.monthly_limit_cents  AS member_monthly_limit_cents,
               ms.day_cents            AS member_day_cents,
               ms.month_cents          AS member_month_cents
          FROM card c
          LEFT JOIN v_card_control_current cc ON cc.card_id = c.id
          LEFT JOIN card_member cm            ON cm.card_id = c.id
          LEFT JOIN team_member tm            ON tm.id = cm.member_id
          LEFT JOIN actor ma                  ON ma.id = tm.actor_id
          LEFT JOIN v_team_member_current mv  ON mv.member_id = cm.member_id
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
            WHERE d.member_id = cm.member_id
              AND d.outcome = 'approve'
              AND d.source = ${params.source}
              AND d.request_status = ANY(${PURCHASE_STATUSES as string[]})
              AND d.decided_at >= now() - interval '40 days'
          ) ms
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
      return {
        status: "read",
        cardId: null,
        controls: null,
        spend: { dayCents: 0n, monthCents: 0n },
        member: null,
        memberSpend: { dayCents: 0n, monthCents: 0n },
      };
    }

    return {
      status: "read",
      cardId: row.card_id,
      controls: toControls(row),
      spend: { dayCents: row.day_cents, monthCents: row.month_cents },
      member: toMember(row),
      memberSpend: { dayCents: row.member_day_cents, monthCents: row.member_month_cents },
    };
  } catch (thrown) {
    return {
      status: "unavailable",
      detail: thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : "control read failed",
    };
  }
}

/**
 * The member half of the row, or null.
 *
 * `state` and `role` arrive as `text` and are NARROWED HERE rather than cast.
 * The CHECK constraints in 0033 mean only the known values can be in those
 * columns, so an unknown one means the schema and this file have drifted — and
 * the safe answer to "I do not recognise this person's state" on a path that
 * decides whether money moves is NOT to guess `active`. It returns null, which
 * makes the card behave as a card with no member: judged by its own controls,
 * approved or declined on those, and recorded with `member_id: null` so the
 * gap is visible in the decision log rather than assumed away.
 *
 * This is the only place in the module that could throw on a hot path, and it
 * deliberately does not.
 */
function toMember(row: MemberRow): MemberDecisionTerms | null {
  if (
    row.member_id === null ||
    row.member_version_id === null ||
    row.member_version === null ||
    row.member_state === null ||
    row.member_role === null
  ) {
    return null;
  }
  if (!isMemberState(row.member_state) || !isTeamRole(row.member_role)) return null;

  return {
    memberId: row.member_id,
    memberVersionId: row.member_version_id,
    version: row.member_version,
    displayName: row.member_name ?? "this cardholder",
    state: row.member_state,
    role: row.member_role,
    perTxnLimitCents: row.member_per_txn_limit_cents,
    dailyLimitCents: row.member_daily_limit_cents,
    monthlyLimitCents: row.member_monthly_limit_cents,
  };
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

/** The columns of the decision row, computed once so both inserts agree. */
function decisionColumns(params: AppendDecisionParams) {
  const { request, verdict, lookup } = params;
  // Denormalised at the instant of the decision, not joined later. A card's
  // member cannot change — `card_member` has the card as its PRIMARY KEY and no
  // UPDATE — so the join would give the same answer forever; but the per-person
  // velocity sum has to be an index scan over one column, and that column is
  // this one. `member_version_id` is the terms this was judged under, pinned
  // exactly as `control_version_id` pins the card's, so raising somebody's
  // limit tomorrow cannot make today's decline look wrong.
  const member = lookup.status === "read" ? (lookup.member ?? null) : null;
  return {
    provider: params.provider,
    providerAuthToken: request.providerAuthToken,
    providerCardToken: request.card.token,
    cardId: lookup.status === "read" ? lookup.cardId : null,
    controlVersionId:
      lookup.status === "read" && lookup.controls !== null
        ? lookup.controls.controlVersionId
        : null,
    memberId: member?.memberId ?? null,
    memberVersionId: member?.memberVersionId ?? null,
    amountCents: request.amountCents,
    mcc: request.mcc,
    merchantDescriptor: request.merchantDescriptor,
    requestStatus: request.requestStatus,
    outcome: verdict.outcome,
    result: verdict.result,
    rule: verdict.rule,
    reason: verdict.reason,
    inputs: verdict.inputs,
    latencyUs: params.latencyUs,
    source: params.source,
    requestId: params.requestId,
  } as const;
}

/**
 * START the append and hand back the promise. ONE statement, NO deadline, and
 * it never rejects: it resolves to the row id, or to `null` if the insert
 * genuinely failed.
 *
 * THE DEADLINE IS THE CALLER'S WILLINGNESS TO WAIT, NOT THE STATEMENT'S, and
 * separating the two is the whole reason this function exists rather than
 * being folded into `appendDecision()`.
 *
 * MEASURED, 2026-09-11T14:09:08Z, on the deployed responder, with a real
 * Lithic delivery: `appendDecision()` raced the insert against a 400 ms budget,
 * LOST the race, and returned null — and `withDeadline()` does not cancel the
 * loser, so the insert went on and committed 355 ms later. The route read that
 * null as "not written" and re-issued the insert from `after()`. One
 * authorisation, one decision, TWO ROWS: `8025729c-f3a8-4aa1-bfd5-b42405e16f9a`
 * appears twice with the same `request_id` and the same 600,390 µs latency.
 *
 * That is not a duplicate delivery — the append-only argument in
 * `docs/CARD-CONTROLS.md` §6 says a second DELIVERY is a second decision and
 * deserves its own row, and it does. This was one delivery recorded twice,
 * which is a lie in an append-only table and, on an APPROVE, would have eaten
 * its limit twice: the velocity sum is `SUM(amount_cents)` over approvals, so a
 * $200 authorisation recorded twice consumes $400 of the cardholder's day.
 *
 * So the retry path awaits THIS promise rather than starting another one.
 *
 * `inputs` is passed through `sql.json`. Money inside it is already decimal
 * strings (see `cents()` in `./decide.ts`); jsonb would happily store a
 * `numeric`, but every reader between here and a screen is JavaScript, and
 * `JSON.parse` turns 9007199254740993 into 9007199254740992.
 */
export function startDecisionAppend(params: AppendDecisionParams): Promise<string | null> {
  const c = decisionColumns(params);
  return sql<{ id: string }[]>`
    INSERT INTO card_auth_decision (
      provider, provider_auth_token, provider_card_token,
      card_id, control_version_id, member_id, member_version_id,
      amount_cents, mcc, merchant_descriptor, request_status,
      outcome, result_code, rule, reason, inputs,
      decision_latency_us, source, request_id
    ) VALUES (
      ${c.provider}, ${c.providerAuthToken}, ${c.providerCardToken},
      ${c.cardId}, ${c.controlVersionId}, ${c.memberId}, ${c.memberVersionId},
      ${c.amountCents}, ${c.mcc}, ${c.merchantDescriptor}, ${c.requestStatus},
      ${c.outcome}, ${c.result}, ${c.rule}, ${c.reason},
      ${sql.json(c.inputs as Parameters<typeof sql.json>[0])},
      ${c.latencyUs}, ${c.source}, ${c.requestId}
    )
    RETURNING id
  `.then(
    (rows) => rows[0]?.id ?? null,
    () => null,
  );
}

/**
 * Wait for an append that is already in flight, up to a budget.
 *
 * `null` means **"not known to be written"** and NOT "definitely not written",
 * and the difference is the bug above. The only caller that may act on a null
 * is one that has the original promise and can wait for its real answer.
 */
export async function awaitDecisionAppend(
  pending: Promise<string | null>,
  budgetMs: number = DECISION_APPEND_BUDGET_MS,
): Promise<string | null> {
  try {
    return await withDeadline(pending, budgetMs, "decision append");
  } catch {
    return null;
  }
}

/** What a re-append did. Three outcomes, because two would conflate them. */
export type ReappendOutcome =
  | { readonly status: "appended"; readonly id: string }
  | { readonly status: "already_recorded" }
  | { readonly status: "failed" };

/**
 * The LAST-RESORT re-append, for the case where the original insert genuinely
 * rejected. Off the hot path, in `after()`, after the response has gone out.
 *
 * Guarded by `WHERE NOT EXISTS`, so a first insert that committed and then lost
 * its connection before `RETURNING` came back cannot be recorded twice. One
 * statement, still — the guard is a subquery, not a round trip — and the hot
 * path's insert is left exactly as it was, unguarded, because on the hot path
 * there is by definition nothing yet to collide with.
 *
 * The guard keys on `(provider, provider_auth_token, source, request_id)`.
 * `request_id` is Lithic's own `webhook-id`, which is per MESSAGE: a genuine
 * second DELIVERY carries a different one and still gets its own row, exactly
 * as §6 argues it should.
 */
export async function reappendDecisionIfMissing(
  params: AppendDecisionParams,
  budgetMs: number = DECISION_APPEND_BUDGET_MS * 4,
): Promise<ReappendOutcome> {
  const c = decisionColumns(params);
  try {
    const rows = await withDeadline(
      sql<{ id: string }[]>`
        INSERT INTO card_auth_decision (
          provider, provider_auth_token, provider_card_token,
          card_id, control_version_id, member_id, member_version_id,
          amount_cents, mcc, merchant_descriptor, request_status,
          outcome, result_code, rule, reason, inputs,
          decision_latency_us, source, request_id
        )
        SELECT ${c.provider}, ${c.providerAuthToken}, ${c.providerCardToken},
               ${c.cardId}, ${c.controlVersionId}, ${c.memberId}, ${c.memberVersionId},
               ${c.amountCents}, ${c.mcc}, ${c.merchantDescriptor}, ${c.requestStatus},
               ${c.outcome}, ${c.result}, ${c.rule}, ${c.reason},
               ${sql.json(c.inputs as Parameters<typeof sql.json>[0])},
               ${c.latencyUs}, ${c.source}, ${c.requestId}
         WHERE NOT EXISTS (
           SELECT 1 FROM card_auth_decision d
            WHERE d.provider = ${c.provider}
              AND d.provider_auth_token = ${c.providerAuthToken}
              AND d.source = ${c.source}
              AND d.request_id IS NOT DISTINCT FROM ${c.requestId}
         )
        RETURNING id
      `,
      budgetMs,
      "decision re-append",
    );
    // NO ROW BACK IS NOT A FAILURE. It means the guard fired: the decision IS
    // recorded, by the very insert this one was covering for. Three outcomes,
    // not two, because "nothing was written" and "nothing NEEDED to be
    // written" are opposite facts and a caller that logs `decision_lost` for
    // both would raise an alarm about a row that is sitting right there.
    const id = rows[0]?.id;
    return id === undefined ? { status: "already_recorded" } : { status: "appended", id };
  } catch {
    return { status: "failed" };
  }
}

/**
 * Record one decision, start to finish. Append-only; there is no other verb.
 *
 * The one-shot form, for the harness, the console and the tests. The ASA route
 * does NOT use it: it needs the in-flight promise so that a missed deadline
 * does not become a second row. See `startDecisionAppend()`.
 */
export async function appendDecision(
  params: AppendDecisionParams,
  budgetMs: number = DECISION_APPEND_BUDGET_MS,
): Promise<string | null> {
  return awaitDecisionAppend(startDecisionAppend(params), budgetMs);
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
  readonly member_id: string | null;
  readonly member_name: string | null;
  readonly member_version: number | null;
};

/**
 * The decision history, newest first.
 *
 * `businessId` filters to one customer's cards. A decision on a card token
 * this book has never registered belongs to no business and is invisible here,
 * which is correct: it is in the table, and the SQL still finds it, but a
 * customer's screen should not show authorisations on somebody else's card.
 *
 * ─── WHY THE SECOND JOIN TO `card` EXISTS ───────────────────────────────────
 *
 * `v_card_auth_decision.business_id` comes from `LEFT JOIN card ON c.id =
 * d.card_id`, so it is NULL whenever `card_id` is NULL — and `card_id` is NULL
 * on exactly the row that matters most: a **fail-closed decline**. When the
 * control read misses its deadline the lookup has no card id to record, so
 * rule `control_store_unavailable` writes `card_id = NULL` even though the
 * `provider_card_token` on the row is one of this customer's own cards.
 *
 * The effect, found on 2026-09-11 by looking at the deployed screen rather
 * than at the query: the decline for transaction
 * `8025729c-f3a8-4aa1-bfd5-b42405e16f9a` — Noor Haddad's card, Ridgeline
 * Robotics — rendered on NOBODY's console. Which quietly falsified the fourth
 * argument for failing closed in `docs/CARD-CONTROLS.md` §5: *"it is auditable
 * either way… the customer who was declined can be found, told and made
 * whole"*. Not if the only screen that lists decisions cannot show the row.
 *
 * So the business is resolved from the TOKEN when the id is missing.
 * `card_provider_key UNIQUE (provider, provider_card_token)` makes that join
 * one-to-one, and it is deliberately restricted to `d.card_id IS NULL` so the
 * ordinary path still goes through the view exactly as before.
 *
 * This does NOT make `card_not_under_control` visible, and that asymmetry is
 * the point: there is no `card` row for that token at all, so `ct` is NULL and
 * the row stays out of every customer's screen. "We could not read the
 * controls for YOUR card" and "that is not a card of yours" get different
 * answers here for the same reason `decide()` gives them opposite defaults.
 *
 * Off the hot path. The ASA route never calls this.
 */
export async function listDecisions(params: {
  readonly businessId: string;
  readonly limit?: number;
}): Promise<readonly DecisionRecord[]> {
  const rows = await sql<DecisionRow[]>`
    SELECT d.id, d.decided_at, d.provider, d.provider_auth_token, d.provider_card_token,
           COALESCE(d.card_id, ct.id)           AS card_id,
           COALESCE(d.last_four, ct.last_four)  AS last_four,
           COALESCE(d.nickname, ct.nickname)    AS nickname,
           d.control_version,
           d.amount_cents, d.mcc, d.merchant_descriptor, d.request_status,
           d.outcome, d.result_code, d.rule, d.reason, d.inputs,
           d.decision_latency_us, d.source,
           base.member_id, ma.display_name AS member_name, mv.version AS member_version
      FROM v_card_auth_decision d
      -- ONE PK LOOKUP BACK TO THE BASE TABLE, AND THE REASON IS WORTH STATING.
      -- v_card_auth_decision (migration 0014) has an explicit column list, so
      -- the two columns 0033 added to card_auth_decision are not in it. The
      -- right fix is two more columns on that view, which needs a migration
      -- 0033 could no longer be (a migration is immutable once applied) and
      -- which this work was not scoped to write. So this reaches the same row
      -- by primary key rather than re-deriving the view's four joins here,
      -- which would leave a second definition of "a decision with its card and
      -- its control version" in the repository. Off the hot path: the ASA route
      -- never calls this.
      LEFT JOIN card_auth_decision base ON base.id = d.id
      LEFT JOIN team_member tm        ON tm.id = base.member_id
      LEFT JOIN actor ma              ON ma.id = tm.actor_id
      LEFT JOIN team_member_version mv ON mv.id = base.member_version_id
      -- The fail-closed row's owner, resolved by token because the id is NULL.
      LEFT JOIN card ct ON d.card_id IS NULL
                       AND ct.provider = d.provider
                       AND ct.provider_card_token = d.provider_card_token
     WHERE COALESCE(d.business_id, ct.business_id) = ${params.businessId}
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
    // DERIVED HERE, ONCE, so no screen has to know the taxonomy. `rule` is on
    // every row this append-only log has ever written, which is why this needed
    // no column and no backfill — see `UNJUDGED_RULES` in ./types.ts.
    judged: isJudgedRule(row.rule),
    reason: row.reason,
    inputs: row.inputs,
    decisionLatencyUs: row.decision_latency_us,
    source: row.source,
    memberId: row.member_id,
    memberName: row.member_name,
    memberVersion: row.member_version,
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
