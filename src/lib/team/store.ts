/**
 * The database side of the team.
 *
 * SERVER ONLY. None of this is on the authorisation hot path — that read lives
 * in `src/lib/cards/store.ts`, in one statement, with a 600 ms deadline, and it
 * joins to the two views below rather than calling anything here. This file is
 * the console's reads and the admin's writes, and it may take its time.
 *
 * ─── THE THREE VERBS THIS FILE DOES NOT HAVE ────────────────────────────────
 *
 * There is no `deleteMember`, no `updateMember` and no `reassignCard`, and the
 * role it connects as could not express them if they were written. Removal is
 * `setMemberTerms({ state: 'removed' })` — ONE INSERT of terms version N+1.
 * The member row, their cards, their authorisations, their holds and every
 * journal entry they ever caused all stand exactly where they were.
 *
 * ─── NOT ONE STATEMENT HERE TOUCHES THE LEDGER ──────────────────────────────
 *
 * Not `journal_entry`, not `journal_line`, not `account`, not `hold` and not
 * `ledger_append()`. The balance a team screen shows comes from
 * `availableBalance()` in `@/lib/ledger/balances`, which is the ledger's own
 * named reader. `src/lib/ledger/boundary.test.ts` enforces that for every file
 * under `src/`, and this module is deliberately at zero.
 *
 * The two hold views it does read — `v_card_auth_hold` and `v_hold_state` —
 * are the hold model's own folds, published by 0001 for exactly this. Reading
 * them is asking the hold model what it thinks; re-deriving them here would be
 * this module inventing a fifth definition of "outstanding".
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";

import { isMemberState, isTeamRole, type MemberState, type TeamRole } from "./roles";
import type {
  MemberCard,
  MemberTerms,
  MemberTermsDraft,
  MemberTermsVersion,
  OutstandingAuthorisation,
  TeamMember,
  TeamMemberDetail,
  TeamOutcome,
} from "./types";

/**
 * The purchase statuses that consume a limit.
 *
 * Deliberately the SAME two values as `PURCHASE_STATUSES` in
 * `@/lib/cards/types`, and deliberately not imported from there: this module
 * must not drag the card-control module into a page render, and the day these
 * two lists disagree is caught by `team.integration.test.ts`, which asserts
 * they are equal. One list with a test beats one import with a cycle.
 */
const PURCHASE_STATUSES: readonly string[] = ["AUTHORIZATION", "FINANCIAL_AUTHORIZATION"];

/* -------------------------------------------------------------------------- */
/* 1. Reads                                                                   */
/* -------------------------------------------------------------------------- */

type MemberRow = {
  readonly member_id: string;
  readonly business_id: string;
  readonly actor_id: string;
  readonly membership_seq: number;
  readonly joined_at: Date;
  readonly display_name: string;
  readonly email: string | null;
  readonly actor_can_approve: boolean;
  readonly member_version_id: string;
  readonly terms_version: number;
  readonly terms_effective_from: Date;
  readonly state: string;
  readonly role: string;
  readonly per_txn_limit_cents: bigint | null;
  readonly daily_limit_cents: bigint | null;
  readonly monthly_limit_cents: bigint | null;
  readonly note: string;
  readonly can_view_balance: boolean;
  readonly can_raise_payment: boolean;
  readonly can_approve_payment: boolean;
  readonly can_administer_team: boolean;
};

/**
 * A `text` column arriving from Postgres is a claim until it is checked.
 *
 * The CHECK constraint in 0033 means only four roles can be in that column, so
 * this can only fail if the schema and this file have drifted. It throws rather
 * than defaulting, because a role this code does not understand must not be
 * silently rendered as the least privileged one — a screen that shows "viewer"
 * for a role it could not parse is a screen that lies about who can spend.
 */
function toRole(value: string): TeamRole {
  if (!isTeamRole(value)) throw new Error(`unknown team role in the database: ${value}`);
  return value;
}

function toState(value: string): MemberState {
  if (!isMemberState(value)) throw new Error(`unknown member state in the database: ${value}`);
  return value;
}

function toMember(row: MemberRow): TeamMember {
  return {
    memberId: row.member_id,
    businessId: row.business_id,
    actorId: row.actor_id,
    membershipSeq: row.membership_seq,
    joinedAt: row.joined_at.toISOString(),
    displayName: row.display_name,
    email: row.email,
    actorCanApprove: row.actor_can_approve,
    terms: {
      memberId: row.member_id,
      memberVersionId: row.member_version_id,
      version: row.terms_version,
      effectiveFrom: row.terms_effective_from.toISOString(),
      state: toState(row.state),
      role: toRole(row.role),
      perTxnLimitCents: row.per_txn_limit_cents,
      dailyLimitCents: row.daily_limit_cents,
      monthlyLimitCents: row.monthly_limit_cents,
      note: row.note,
    },
    canViewBalance: row.can_view_balance,
    canRaisePayment: row.can_raise_payment,
    canApprovePayment: row.can_approve_payment,
    canAdministerTeam: row.can_administer_team,
  };
}

/**
 * Everybody on one business's team, live members first.
 *
 * Removed members are INCLUDED and ordered last. That is the point: a team
 * screen that hides the people who were removed is a screen that cannot answer
 * "who spent this", which is the question the whole feature exists for. The
 * ledger is append-only and so is this list.
 */
export async function listTeam(businessId: string, conn: Sql = sql): Promise<readonly TeamMember[]> {
  const rows = await conn<MemberRow[]>`
    SELECT *
      FROM v_team_member
     WHERE business_id = ${businessId}
     ORDER BY (state = 'removed'), display_name, membership_seq DESC`;
  return rows.map(toMember);
}

export async function readMember(memberId: string, conn: Sql = sql): Promise<TeamMember | null> {
  const rows = await conn<MemberRow[]>`
    SELECT *
      FROM v_team_member
     WHERE member_id = ${memberId}`;
  const row = rows[0];
  return row === undefined ? null : toMember(row);
}

/** The member a given actor is, in a given business. Null for Corgi staff. */
export async function memberForActor(
  businessId: string,
  actorId: string,
  conn: Sql = sql,
): Promise<TeamMember | null> {
  const rows = await conn<MemberRow[]>`
    SELECT *
      FROM v_team_member
     WHERE business_id = ${businessId} AND actor_id = ${actorId}
     ORDER BY membership_seq DESC
     LIMIT 1`;
  const row = rows[0];
  return row === undefined ? null : toMember(row);
}

type CardRow = {
  readonly card_id: string;
  readonly member_id: string;
  readonly provider: string;
  readonly provider_card_token: string;
  readonly last_four: string | null;
  readonly nickname: string | null;
  readonly assigned_at: Date;
  readonly created_at: Date;
};

/** Every card held by the members of one business. */
export async function listMemberCards(
  businessId: string,
  conn: Sql = sql,
): Promise<readonly MemberCard[]> {
  const rows = await conn<CardRow[]>`
    SELECT cm.card_id, cm.member_id, c.provider, c.provider_card_token,
           c.last_four, c.nickname, cm.assigned_at, c.created_at
      FROM card_member cm
      JOIN card c ON c.id = cm.card_id
      JOIN team_member tm ON tm.id = cm.member_id
     WHERE tm.business_id = ${businessId}
     ORDER BY cm.assigned_at DESC`;
  return rows.map((row) => ({
    cardId: row.card_id,
    memberId: row.member_id,
    provider: row.provider,
    providerCardToken: row.provider_card_token,
    lastFour: row.last_four,
    nickname: row.nickname,
    assignedAt: row.assigned_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    providerState: null,
  }));
}

type OutstandingRow = {
  readonly auth_id: string;
  readonly provider_auth_id: string;
  readonly hold_id: string;
  readonly card_id: string;
  readonly last_four: string | null;
  readonly auth_net_cents: bigint;
  readonly captured_cents: bigint;
  readonly target_hold_cents: bigint;
  readonly memo_balance_cents: bigint;
  readonly expires_at: Date;
  readonly member_id: string;
};

/**
 * Authorisations still open on the cards of one business's members.
 *
 * `NOT ch.is_closed` is the hold model's OWN predicate — four ways to be
 * closed, from `v_card_auth_hold` — and not a second opinion about it. The memo
 * balance is read beside H(E) so the two can be compared by eye on the screen,
 * exactly as `v_card_hold_live` does for the staff console.
 */
export async function listOutstandingByMember(
  businessId: string,
  conn: Sql = sql,
): Promise<ReadonlyMap<string, readonly OutstandingAuthorisation[]>> {
  const rows = await conn<OutstandingRow[]>`
    SELECT ca.id                 AS auth_id,
           ca.provider_auth_id,
           ca.hold_id,
           cm.card_id,
           c.last_four,
           ch.auth_net_cents,
           ch.captured_cents,
           ch.target_hold_cents,
           hs.memo_balance_cents,
           ca.expires_at,
           cm.member_id
      FROM card_member cm
      JOIN team_member tm        ON tm.id = cm.member_id
      JOIN card c                ON c.id = cm.card_id
      JOIN card_authorization ca ON ca.card_id = cm.card_id
      JOIN v_card_auth_hold ch   ON ch.auth_id = ca.id
      JOIN v_hold_state hs       ON hs.hold_id = ca.hold_id
     WHERE tm.business_id = ${businessId}
       AND NOT ch.is_closed
     ORDER BY ca.first_seen_at DESC`;

  const out = new Map<string, OutstandingAuthorisation[]>();
  for (const row of rows) {
    const list = out.get(row.member_id) ?? [];
    list.push({
      authId: row.auth_id,
      providerAuthId: row.provider_auth_id,
      holdId: row.hold_id,
      cardId: row.card_id,
      lastFour: row.last_four,
      authorisedCents: row.auth_net_cents,
      capturedCents: row.captured_cents,
      targetHoldCents: row.target_hold_cents,
      memoBalanceCents: row.memo_balance_cents,
      expiresAt: row.expires_at.toISOString(),
    });
    out.set(row.member_id, list);
  }
  return out;
}

/**
 * Approved purchase spend per member, today and this book month.
 *
 * The same figure, the same filters and the same book windows as the velocity
 * sum on the authorisation path — `book_date()`, America/New_York, one source
 * lane — because a screen that showed a different number from the one the
 * decision used would be worse than a screen showing nothing. See the long note
 * on `SpendToDate` in `@/lib/cards/types` for why it is our own decision log
 * and not the ledger.
 */
export async function spendByMember(
  businessId: string,
  source: "provider" | "harness" = "provider",
  conn: Sql = sql,
): Promise<ReadonlyMap<string, { dayCents: bigint; monthCents: bigint }>> {
  const rows = await conn<
    { member_id: string; day_cents: bigint; month_cents: bigint }[]
  >`
    SELECT d.member_id,
           COALESCE(SUM(d.amount_cents) FILTER (
             WHERE book_date(d.decided_at) = book_date(now())
           ), 0)::bigint AS day_cents,
           COALESCE(SUM(d.amount_cents) FILTER (
             WHERE date_trunc('month', book_date(d.decided_at))
                 = date_trunc('month', book_date(now()))
           ), 0)::bigint AS month_cents
      FROM card_auth_decision d
      JOIN team_member tm ON tm.id = d.member_id
     WHERE tm.business_id = ${businessId}
       AND d.outcome = 'approve'
       AND d.source = ${source}
       AND d.request_status = ANY(${PURCHASE_STATUSES as string[]})
       AND d.decided_at >= now() - interval '40 days'
     GROUP BY d.member_id`;

  return new Map(
    rows.map((row) => [row.member_id, { dayCents: row.day_cents, monthCents: row.month_cents }]),
  );
}

/**
 * The whole team, assembled: people, cards, outstanding authorisations, spend.
 *
 * Four statements, not one, and not N+1. A page that ran one query per member
 * would be a page whose cost grows with the size of the customer's team; four
 * fixed reads is four fixed reads on a business with three members or thirty.
 */
export async function readTeam(
  businessId: string,
  conn: Sql = sql,
): Promise<readonly TeamMemberDetail[]> {
  const [members, cards, outstanding, spend] = await Promise.all([
    listTeam(businessId, conn),
    listMemberCards(businessId, conn),
    listOutstandingByMember(businessId, conn),
    spendByMember(businessId, "provider", conn),
  ]);

  return members.map((member) => ({
    member,
    cards: cards.filter((card) => card.memberId === member.memberId),
    outstanding: outstanding.get(member.memberId) ?? [],
    spend: spend.get(member.memberId) ?? { dayCents: 0n, monthCents: 0n },
  }));
}

/** Every version of one member's terms, newest first. The audit trail. */
export async function listTermsVersions(
  memberId: string,
  limit = 12,
  conn: Sql = sql,
): Promise<readonly MemberTermsVersion[]> {
  const rows = await conn<
    {
      id: string;
      version: number;
      effective_from: Date;
      state: string;
      role: string;
      per_txn_limit_cents: bigint | null;
      daily_limit_cents: bigint | null;
      monthly_limit_cents: bigint | null;
      note: string;
      created_at: Date;
      created_by_name: string | null;
    }[]
  >`
    SELECT v.id, v.version, v.effective_from, v.state, v.role,
           v.per_txn_limit_cents, v.daily_limit_cents, v.monthly_limit_cents,
           v.note, v.created_at, a.display_name AS created_by_name
      FROM team_member_version v
      LEFT JOIN actor a ON a.id = v.created_by
     WHERE v.member_id = ${memberId}
     ORDER BY v.version DESC
     LIMIT ${limit}`;

  return rows.map((row) => ({
    memberId,
    memberVersionId: row.id,
    version: row.version,
    effectiveFrom: row.effective_from.toISOString(),
    state: toState(row.state),
    role: toRole(row.role),
    perTxnLimitCents: row.per_txn_limit_cents,
    dailyLimitCents: row.daily_limit_cents,
    monthlyLimitCents: row.monthly_limit_cents,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
  }));
}

/* -------------------------------------------------------------------------- */
/* 2. Writes                                                                  */
/* -------------------------------------------------------------------------- */

function failure(thrown: unknown, fallback: string): { ok: false; code: string; message: string } {
  const code = (thrown as { code?: string }).code ?? "TEAM_WRITE_FAILED";
  const message = thrown instanceof Error ? thrown.message : fallback;
  // A plpgsql RAISE arrives with the sentence the migration wrote, and that
  // sentence is the useful half: "actor X administers the team actor Y belongs
  // to…" is what an operator needs. It is surfaced verbatim, truncated, rather
  // than replaced with "permission denied".
  return { ok: false, code, message: message.split("\n")[0]?.slice(0, 400) ?? fallback };
}

/**
 * Add a person to a business.
 *
 * Goes through `team_add_member()`, a SECURITY DEFINER function, because
 * `corgi_app` holds SELECT and only SELECT on `actor` — and
 * `approvals.integration.test.ts` asserts that by trying to insert an agent
 * approver and requiring `permission denied`. That assertion stays true: this
 * path does not widen the grant, it calls a function the owner wrote, which
 * hardcodes `kind = 'human'`, always sets `business_id`, derives `can_approve`
 * from the role once, writes terms version 1 in the same statement, and checks
 * that the author holds `administer_team`. Same pattern and same argument as
 * `ledger_append()`.
 */
export async function addMember(
  params: {
    readonly businessId: string;
    readonly displayName: string;
    readonly email: string;
    readonly role: TeamRole;
    readonly actorId: string;
    readonly note: string;
    readonly perTxnLimitCents?: bigint | null;
    readonly dailyLimitCents?: bigint | null;
    readonly monthlyLimitCents?: bigint | null;
  },
  conn: Sql = sql,
): Promise<TeamOutcome<string>> {
  try {
    const [row] = await conn<{ member_id: string }[]>`
      SELECT team_add_member(
        ${params.businessId}::uuid,
        ${params.displayName},
        ${params.email},
        ${params.role},
        ${params.actorId}::uuid,
        ${params.note},
        ${params.perTxnLimitCents ?? null}::bigint,
        ${params.dailyLimitCents ?? null}::bigint,
        ${params.monthlyLimitCents ?? null}::bigint
      ) AS member_id`;
    if (row === undefined) {
      return { ok: false, code: "NOT_WRITTEN", message: "The member was not created." };
    }
    return { ok: true, value: row.member_id };
  } catch (thrown) {
    return failure(thrown, "The member was not created.");
  }
}

/**
 * Write terms version N+1.
 *
 * There is no UPDATE. A change to what somebody may do is an INSERT, for the
 * reason `setCardControls` gives about card controls and the reason 0007 gives
 * about approval policies: the version a past decision cited has to still say
 * what it said when the decision was made, or the decision log is worthless.
 *
 * CONCURRENCY. Two admins pressing Save in the same second both compute N+1,
 * both insert, and `UNIQUE (member_id, version)` lets exactly one through. The
 * loser is retried ONCE, against the version the winner wrote — so the second
 * change lands on top of the first instead of silently discarding it. One retry
 * and not a loop: a second collision means genuine contention on one person, and
 * a screen that spins is worse than one that says "somebody else just changed
 * this".
 */
export async function setMemberTerms(
  params: {
    readonly memberId: string;
    readonly draft: MemberTermsDraft;
    readonly actorId: string;
  },
  conn: Sql = sql,
): Promise<TeamOutcome<MemberTerms>> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [current] = await conn<{ version: number }[]>`
      SELECT version FROM team_member_version
       WHERE member_id = ${params.memberId}
       ORDER BY version DESC
       LIMIT 1`;
    if (current === undefined) {
      return {
        ok: false,
        code: "NO_SUCH_MEMBER",
        message: "That member has no terms, so there is no version to follow.",
      };
    }
    const nextVersion = current.version + 1;

    try {
      const [row] = await conn<{ id: string; version: number; effective_from: Date }[]>`
        INSERT INTO team_member_version (
          member_id, version, state, role,
          per_txn_limit_cents, daily_limit_cents, monthly_limit_cents,
          note, created_by
        ) VALUES (
          ${params.memberId}::uuid, ${nextVersion}, ${params.draft.state}, ${params.draft.role},
          ${params.draft.perTxnLimitCents}, ${params.draft.dailyLimitCents},
          ${params.draft.monthlyLimitCents}, ${params.draft.note}, ${params.actorId}::uuid
        )
        RETURNING id, version, effective_from`;
      if (row === undefined) {
        return { ok: false, code: "NOT_WRITTEN", message: "The terms were not written." };
      }
      return {
        ok: true,
        value: {
          memberId: params.memberId,
          memberVersionId: row.id,
          version: row.version,
          effectiveFrom: row.effective_from.toISOString(),
          state: params.draft.state,
          role: params.draft.role,
          perTxnLimitCents: params.draft.perTxnLimitCents,
          dailyLimitCents: params.draft.dailyLimitCents,
          monthlyLimitCents: params.draft.monthlyLimitCents,
          note: params.draft.note,
        },
      };
    } catch (thrown) {
      const code = (thrown as { code?: string }).code;
      if (code === "23505" && attempt === 0) continue;
      if (code === "23505") {
        return {
          ok: false,
          code: "VERSION_RACE",
          message:
            "Another change to this member's terms landed while this one was being written. Reload and apply it again.",
        };
      }
      return failure(thrown, "The terms were not written.");
    }
  }
  return { ok: false, code: "VERSION_RACE", message: "The terms were not written." };
}

/**
 * Bind a card to a person.
 *
 * The card must ALREADY EXIST — it is created by the existing issuing path
 * (`createCard()` at Lithic, then `registerCard()`), which this does not
 * duplicate and does not replace. This writes the one row that says whose it is.
 *
 * Idempotent on `card_id`: pressing the button twice binds the card once.
 * `ON CONFLICT DO NOTHING` is safe here precisely because the primary key IS the
 * card, so the second press cannot quietly rebind the card to somebody else —
 * it is a no-op, and the read below returns whoever holds it.
 */
export async function assignCardToMember(
  params: {
    readonly cardId: string;
    readonly memberId: string;
    readonly actorId: string;
  },
  conn: Sql = sql,
): Promise<TeamOutcome<{ readonly heldBy: string }>> {
  try {
    await conn`
      INSERT INTO card_member (card_id, member_id, assigned_by)
      VALUES (${params.cardId}::uuid, ${params.memberId}::uuid, ${params.actorId}::uuid)
      ON CONFLICT (card_id) DO NOTHING`;
    const [row] = await conn<{ member_id: string }[]>`
      SELECT member_id FROM card_member WHERE card_id = ${params.cardId}`;
    if (row === undefined) {
      return { ok: false, code: "NOT_BOUND", message: "The card was not bound to anybody." };
    }
    return { ok: true, value: { heldBy: row.member_id } };
  } catch (thrown) {
    return failure(thrown, "The card was not bound.");
  }
}

/**
 * Cards this business has issued that belong to NO member.
 *
 * Every card in the book predates tonight, so this list is long and that is
 * honest: they are business cards, not people's cards, and the authorisation
 * path treats them exactly as it did before. Offered on the screen so an
 * operator can bind one to a person without issuing a new one.
 */
export async function listUnassignedCards(
  businessId: string,
  limit = 8,
  conn: Sql = sql,
): Promise<readonly Omit<MemberCard, "memberId" | "assignedAt">[]> {
  const rows = await conn<
    {
      id: string;
      provider: string;
      provider_card_token: string;
      last_four: string | null;
      nickname: string | null;
      created_at: Date;
    }[]
  >`
    SELECT c.id, c.provider, c.provider_card_token, c.last_four, c.nickname, c.created_at
      FROM card c
     WHERE c.business_id = ${businessId}
       AND NOT EXISTS (SELECT 1 FROM card_member cm WHERE cm.card_id = c.id)
     ORDER BY c.created_at DESC
     LIMIT ${limit}`;
  return rows.map((row) => ({
    cardId: row.id,
    provider: row.provider,
    providerCardToken: row.provider_card_token,
    lastFour: row.last_four,
    nickname: row.nickname,
    createdAt: row.created_at.toISOString(),
    providerState: null,
  }));
}

/* -------------------------------------------------------------------------- */
/* 3. The invariants, read from the application                               */
/* -------------------------------------------------------------------------- */

/**
 * The views 0033 and 0044 assert are empty, counted.
 *
 * Exposed so the team screen can state the claim and its current value rather
 * than assert it in prose. A guard nobody queries is a comment — this build has
 * found seventeen of those — and the screen is one more place that queries
 * them.
 *
 * THE THIRD ONE IS 0044'S. `v_team_terms_by_unauthorised_author` is the guard
 * on the authorship hole: 0033 established the author's authority with a lookup
 * filtered `AND state <> 'removed'` and then gated on `IF v_author IS NOT NULL`,
 * where NULL is the Corgi-staff break-glass — so a REMOVED member fell out of
 * the branch that checks and into the branch that trusts, and could mint a new
 * approver. `src/components/team/TeamView.tsx` still captions this block "Two
 * invariants from migration 0033"; that is one stale word and it is named in
 * docs/TEAM.md §9, because `src/components/**` is owned elsewhere tonight.
 */
export async function readTeamInvariants(
  conn: Sql = sql,
): Promise<readonly { readonly view: string; readonly claim: string; readonly rows: number }[]> {
  const [dead] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM v_approved_auth_for_dead_member`;
  const [right] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM v_member_approval_without_right`;
  const [author] = await conn<{ n: number }[]>`
    SELECT count(*)::int AS n FROM v_team_terms_by_unauthorised_author`;
  return [
    {
      view: "v_approved_auth_for_dead_member",
      claim:
        "no purchase was approved under member terms that were suspended or removed at the instant it was decided",
      rows: dead?.n ?? 0,
    },
    {
      view: "v_member_approval_without_right",
      claim:
        "no payment was approved by a member whose role, at that instant, did not carry approve_payment",
      rows: right?.n ?? 0,
    },
    {
      view: "v_team_terms_by_unauthorised_author",
      claim:
        "no member's terms were written by somebody who, at that instant, was a member of that business without being an active admin of it",
      rows: author?.n ?? 0,
    },
  ];
}
