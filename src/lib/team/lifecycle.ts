/**
 * The two operations that touch both this system and the issuer: giving a
 * person a card, and taking one away.
 *
 * ============================================================================
 * ISSUING REUSES THE EXISTING PATH. IT DOES NOT FORK IT.
 *
 * `createCard()` from `@/lib/rails/lithic/client` is the same function
 * `src/app/(app)/accounts/actions.ts` calls — same rate limiter, same
 * idempotency key, same `Card` type, same $5,000-per-transaction provider
 * backstop. `registerCard()` from `@/lib/holds` is the same function that binds
 * a provider token to a customer's 2100/9100 pair, with the same
 * `ON CONFLICT (provider, provider_card_token) DO NOTHING`.
 *
 * The ONLY thing this module adds is one more row — `card_member` — saying
 * whose card it is. That is why 0033 put the binding in its own table rather
 * than a column on `card`: a column would have needed a second INSERT statement
 * against `card` (a second issuing path, which is the thing to avoid) or an
 * UPDATE, which does not exist on that table and never will.
 *
 * ============================================================================
 * REMOVAL IS THE INTERESTING ONE, AND THE ORDER IS THE ARGUMENT.
 *
 * Three things have to be true after a member is removed:
 *
 *   1. THEIR CARD STOPS AUTHORISING.
 *   2. THEIR HISTORY DOES NOT VANISH.
 *   3. AN AUTHORISATION ALREADY OUTSTANDING STILL SETTLES CORRECTLY.
 *
 * (2) and (3) are free, and they are free BY CONSTRUCTION rather than by care:
 * removal is one INSERT into `team_member_version`. There is no verb available
 * that could delete the member, the card, the authorisation, the hold or a
 * journal line — the role holds no UPDATE or DELETE on any of them and the
 * triggers refuse it even against the owner. The settlement path is keyed on
 * the PROVIDER CARD TOKEN and resolves to the business's 2100 and 9100 leaves
 * (`resolveCard`), and removal touches none of those, so a clearing that
 * arrives three days later posts exactly as it would have if nobody had left.
 *
 * A "delete user" that released the hold would hand the customer back money the
 * merchant is still going to claim, and the clearing would then arrive against
 * a released hold: a double count, found days later by reconciliation. A
 * "delete user" that deleted the card row would orphan the authorisation
 * outright — the Lithic consumer parks on an unknown card token and the money
 * never books at all. Neither is reachable from here.
 *
 * (1) is the one that takes work, because there are TWO mechanisms and they are
 * live at different times:
 *
 *   OURS    the real-time authorisation decision declines on rule
 *           `member_removed`. Reached only while Lithic is enrolled to call us,
 *           and ASA is currently DISENROLLED (docs/CARD-CONTROLS.md §1).
 *   THEIRS  `PATCH /v1/cards/{token}` with `state: CLOSED`. Enforced by the
 *           issuer on their own side, today, whether or not they are calling
 *           us.
 *
 * So removal does both, and it does the PROVIDER CALL FIRST. If the order were
 * reversed and the provider call failed, there would be a window in which this
 * system says the person is gone and their card still spends — a screen that
 * lies in the dangerous direction. Doing the issuer first means the common case
 * is enforced before it is announced.
 *
 * THE APPEND HAPPENS EVEN IF THE PROVIDER CALL FAILS, and that is deliberate
 * too: a revocation must not depend on a third party being reachable. What
 * changes is that the result says `enforcedAtIssuer: false` and names the
 * tokens still open, so the failure is loud, actionable and on the screen
 * rather than in a log. Once ASA is enrolled, our own rule covers exactly that
 * gap from the other side.
 * ============================================================================
 */

import "server-only";

import { applyDefaultControls } from "@/lib/cards/defaults";
import { registerCard } from "@/lib/holds";
import { sql, type Sql } from "@/lib/ledger/db";
import { createCard } from "@/lib/rails/lithic/client";

import { providerStateFor, setProviderCardState } from "./provider";
import { assignCardToMember, listTermsVersions, readMember, setMemberTerms } from "./store";
import type { MemberCard, OutstandingAuthorisation, TeamOutcome } from "./types";

const PROVIDER = "lithic";

/**
 * The provider's own per-transaction backstop on a member card.
 *
 * The SAME figure the existing console uses, deliberately. It is Lithic's
 * limit, not ours: it applies whether or not ASA is enrolled and whether or not
 * this system is up, which is exactly what a backstop is for. The member's own
 * limits are enforced by us, in the authorisation decision, and are typically
 * far tighter — Theo's $250 per transaction sits inside this $5,000.
 */
const CARD_SPEND_LIMIT_CENTS = 5_000_00;

/* -------------------------------------------------------------------------- */
/* 1. Issue a card to a person                                                */
/* -------------------------------------------------------------------------- */

export type IssuedCard = {
  readonly cardId: string;
  readonly providerCardToken: string;
  readonly lastFour: string;
  readonly expMonth: string;
  readonly expYear: string;
  readonly providerState: string;
  readonly memberId: string;
  readonly displayName: string;
};

/**
 * Create a real card on Lithic and give it to a member.
 *
 * Every field is a CLAIM, in the sense `accounts/actions.ts` sets out: the
 * member id is a reference and the member's business, state and name are
 * re-read here. A caller who posts a member id belonging to another customer is
 * refused by the ownership check, not by the absence of a button — and then
 * refused again by `assert_card_member()` in the database if the check were
 * ever removed.
 *
 * ONLY FROM AN EXPLICIT PRESS. There is no path from rendering a page to this
 * function; a page that issued a card on render would put one real card per
 * page load on the Lithic account.
 */
export async function issueCardToMember(
  params: {
    readonly businessId: string;
    readonly memberId: string;
    readonly actorId: string;
    /** Generated once per render; Lithic's own `Idempotency-Key`. */
    readonly formKey: string;
    readonly nickname?: string;
  },
  conn: Sql = sql,
): Promise<TeamOutcome<IssuedCard>> {
  const member = await readMember(params.memberId, conn);
  if (member === null) {
    return { ok: false, code: "NO_SUCH_MEMBER", message: "That member does not exist." };
  }
  if (member.businessId !== params.businessId) {
    return {
      ok: false,
      code: "MEMBER_NOT_OWNED",
      message: "That member belongs to a different business. Nothing was sent to Lithic.",
    };
  }
  if (member.terms.state !== "active") {
    return {
      ok: false,
      code: "MEMBER_NOT_ACTIVE",
      message: `${member.displayName} is ${member.terms.state}, so no card may be issued to them. Nothing was sent to Lithic.`,
    };
  }

  let card;
  try {
    card = await createCard(
      {
        type: "VIRTUAL",
        // The memo reaches the issuer and the ASA payload. A person's name and
        // nothing else: no email, no id, no note.
        memo: `corgi · ${member.displayName}`.slice(0, 50),
        spend_limit: CARD_SPEND_LIMIT_CENTS,
        spend_limit_duration: "TRANSACTION",
        state: "OPEN",
      },
      { idempotencyKey: params.formKey },
    );
  } catch (thrown) {
    return {
      ok: false,
      code: "PROVIDER_REFUSED",
      message: `Lithic refused to create the card, so nothing was registered here either: ${describe(thrown)}`,
    };
  }

  // The existing binding, unchanged: provider token -> the business's 2100 and
  // 9100 leaves. This is what makes an authorisation post to the right book.
  let binding;
  try {
    binding = await registerCard(
      {
        provider: PROVIDER,
        providerCardToken: card.token,
        businessId: params.businessId,
        lastFour: card.last_four,
        nickname: params.nickname ?? member.displayName,
      },
      conn,
    );
  } catch (thrown) {
    return {
      ok: false,
      code: "REGISTER_FAILED",
      message: `Lithic created card ${card.token}, but it could not be bound to this customer, so any authorisation on it will park instead of posting: ${describe(thrown)}`,
    };
  }

  // A card issued to a person arrives WITH a control version.
  //
  // This is the second product issuance path — `issueCardAction()` on
  // /accounts is the first — and it was the one still leaving cards
  // uncontrolled. 880 of 911 cards had no control version, which is why 48 of
  // 51 provider approvals were decided by `no_controls_configured`: a rule
  // that judged nothing, on a card nobody had said anything about.
  //
  // The default DECLINES NOTHING and is chosen so it cannot: per-transaction
  // $5,000, equal to the `spend_limit` this same function already sends Lithic
  // above, same axis and same inclusivity. What it buys is that the decision
  // row cites a pinned control VERSION instead of citing nothing, that a
  // freeze becomes a version bump rather than a first-ever creation, and that
  // rule 15 stops being noise and starts meaning "this card reached the book
  // without going through a product issuance path".
  //
  // Deliberately NOT a trigger: an uncontrolled card must stay representable,
  // because a fail-open that cannot be produced cannot be tested — and the
  // fail-open sibling is a real, proven branch of the ASA decision.
  //
  // A failure here must not orphan the card. It is already created at Lithic
  // and bound to the customer by the statement above; refusing the whole
  // issuance over a missing default would leave a real provider card with no
  // owner on this book, which is strictly worse than an uncontrolled one.
  await applyDefaultControls({ cardId: binding.cardId }).catch(() => undefined);

  // And the one new row: whose card it is.
  const assigned = await assignCardToMember(
    { cardId: binding.cardId, memberId: params.memberId, actorId: params.actorId },
    conn,
  );
  if (!assigned.ok) {
    return {
      ok: false,
      code: assigned.code,
      message: `Lithic created card ${card.token} and it is bound to this customer, but not to a person, so its authorisations will be attributable to the card and not to anybody: ${assigned.message}`,
    };
  }
  if (assigned.value.heldBy !== params.memberId) {
    return {
      ok: false,
      code: "CARD_ALREADY_HELD",
      message:
        "That card is already held by somebody else. A card belongs to one person for its life; re-assigning is re-issuing.",
    };
  }

  return {
    ok: true,
    value: {
      cardId: binding.cardId,
      providerCardToken: card.token,
      lastFour: card.last_four,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      providerState: card.state,
      memberId: params.memberId,
      displayName: member.displayName,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Suspend and remove                                                      */
/* -------------------------------------------------------------------------- */

export type CardRevocation = {
  readonly cardId: string;
  readonly providerCardToken: string;
  readonly lastFour: string | null;
  readonly requestedState: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type RemovalResult = {
  readonly memberId: string;
  readonly displayName: string;
  readonly state: "suspended" | "removed";
  readonly termsVersion: number;
  /** True only when EVERY card came back confirmed at the issuer. */
  readonly enforcedAtIssuer: boolean;
  readonly cards: readonly CardRevocation[];
  /**
   * Authorisations that were outstanding at the instant of the removal.
   *
   * They are NOT cancelled, NOT released and NOT reversed. They are reported so
   * the person pressing the button can see exactly what money is still in
   * flight and will still settle against this customer's account. This list is
   * the answer to "what happens to a pending hold when you delete a user", and
   * the answer is "nothing happens to it, and here it is".
   */
  readonly outstanding: readonly OutstandingAuthorisation[];
};

/**
 * Suspend or remove a member.
 *
 * See the header for why the issuer is called first and why the append happens
 * either way.
 */
export async function endMembership(
  params: {
    readonly memberId: string;
    readonly businessId: string;
    readonly actorId: string;
    readonly state: "suspended" | "removed";
    readonly note: string;
  },
  conn: Sql = sql,
): Promise<TeamOutcome<RemovalResult>> {
  const member = await readMember(params.memberId, conn);
  if (member === null) {
    return { ok: false, code: "NO_SUCH_MEMBER", message: "That member does not exist." };
  }
  if (member.businessId !== params.businessId) {
    return {
      ok: false,
      code: "MEMBER_NOT_OWNED",
      message: "That member belongs to a different business. Nothing was changed.",
    };
  }
  if (member.terms.state === "removed") {
    return {
      ok: false,
      code: "ALREADY_REMOVED",
      message: `${member.displayName} was already removed at ${member.terms.effectiveFrom}. Removal is terminal: there is nothing to remove twice, and re-adding them is a new membership.`,
    };
  }

  // What was in flight BEFORE anything changed. Read first so the record is of
  // the instant the removal was decided, not of the instant it finished.
  const outstanding = await outstandingForMember(params.memberId, conn);

  // ---- the issuer, first -------------------------------------------------
  const cards = await cardsForMember(params.memberId, conn);
  const wanted = providerStateFor(params.state);
  const revocations: CardRevocation[] = [];
  for (const card of cards) {
    const result = await setProviderCardState({
      providerCardToken: card.providerCardToken,
      state: wanted,
    });
    revocations.push({
      cardId: card.cardId,
      providerCardToken: card.providerCardToken,
      lastFour: card.lastFour,
      requestedState: wanted,
      ok: result.ok,
      detail: result.ok
        ? `the issuer confirms this card is ${result.state}`
        : `${result.code}: ${result.message}`,
    });
  }

  // ---- then the fact, whether or not the issuer answered ------------------
  const written = await setMemberTerms(
    {
      memberId: params.memberId,
      draft: {
        state: params.state,
        // The role is carried forward unchanged. Removing somebody is not a
        // demotion and must not be recorded as one: the chain has to be able to
        // say what they were when they left.
        role: member.terms.role,
        perTxnLimitCents: member.terms.perTxnLimitCents,
        dailyLimitCents: member.terms.dailyLimitCents,
        monthlyLimitCents: member.terms.monthlyLimitCents,
        note: params.note,
      },
      actorId: params.actorId,
    },
    conn,
  );
  if (!written.ok) {
    return {
      ok: false,
      code: written.code,
      message:
        revocations.length === 0
          ? written.message
          : `${written.message} NOTE: ${revocations.filter((r) => r.ok).length} of ${revocations.length} card(s) were already set to ${wanted} at the issuer, so they will decline even though this system still shows the member as ${member.terms.state}.`,
    };
  }

  return {
    ok: true,
    value: {
      memberId: params.memberId,
      displayName: member.displayName,
      state: params.state,
      termsVersion: written.value.version,
      enforcedAtIssuer: revocations.every((r) => r.ok),
      cards: revocations,
      outstanding,
    },
  };
}

/**
 * Put a suspended member back.
 *
 * Only from `suspended`. `removed` is terminal and the database refuses a
 * version after it, so this cannot be the accidental undo of a revocation —
 * bringing somebody back is `team_add_member()` again, which opens a NEW
 * membership spell and issues a NEW card.
 */
export async function reinstateMember(
  params: {
    readonly memberId: string;
    readonly businessId: string;
    readonly actorId: string;
    readonly note: string;
  },
  conn: Sql = sql,
): Promise<TeamOutcome<RemovalResult>> {
  const member = await readMember(params.memberId, conn);
  if (member === null) {
    return { ok: false, code: "NO_SUCH_MEMBER", message: "That member does not exist." };
  }
  if (member.businessId !== params.businessId) {
    return { ok: false, code: "MEMBER_NOT_OWNED", message: "That member belongs to a different business." };
  }
  if (member.terms.state !== "suspended") {
    return {
      ok: false,
      code: "NOT_SUSPENDED",
      message: `${member.displayName} is ${member.terms.state}. Only a suspended member can be reinstated; removal is terminal.`,
    };
  }

  const written = await setMemberTerms(
    {
      memberId: params.memberId,
      draft: {
        state: "active",
        role: member.terms.role,
        perTxnLimitCents: member.terms.perTxnLimitCents,
        dailyLimitCents: member.terms.dailyLimitCents,
        monthlyLimitCents: member.terms.monthlyLimitCents,
        note: params.note,
      },
      actorId: params.actorId,
    },
    conn,
  );
  if (!written.ok) return { ok: false, code: written.code, message: written.message };

  // The local fact first here, and the issuer second, because the directions
  // are reversed: this widens what the card may do. The safe order for widening
  // is "be sure we mean it, then tell the provider", which is the mirror of the
  // argument for revoking.
  const cards = await cardsForMember(params.memberId, conn);
  const revocations: CardRevocation[] = [];
  for (const card of cards) {
    const result = await setProviderCardState({
      providerCardToken: card.providerCardToken,
      state: "OPEN",
    });
    revocations.push({
      cardId: card.cardId,
      providerCardToken: card.providerCardToken,
      lastFour: card.lastFour,
      requestedState: "OPEN",
      ok: result.ok,
      detail: result.ok
        ? `the issuer confirms this card is ${result.state}`
        : `${result.code}: ${result.message}`,
    });
  }

  return {
    ok: true,
    value: {
      memberId: params.memberId,
      displayName: member.displayName,
      // The result type carries the two ending states; reinstatement reports
      // the state it came FROM so a caller cannot mistake it for a removal.
      state: "suspended",
      termsVersion: written.value.version,
      enforcedAtIssuer: revocations.every((r) => r.ok),
      cards: revocations,
      outstanding: [],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Small reads these two need                                              */
/* -------------------------------------------------------------------------- */

async function cardsForMember(memberId: string, conn: Sql): Promise<readonly MemberCard[]> {
  const rows = await conn<
    {
      card_id: string;
      provider: string;
      provider_card_token: string;
      last_four: string | null;
      nickname: string | null;
      assigned_at: Date;
      created_at: Date;
    }[]
  >`
    SELECT cm.card_id, c.provider, c.provider_card_token, c.last_four, c.nickname,
           cm.assigned_at, c.created_at
      FROM card_member cm
      JOIN card c ON c.id = cm.card_id
     WHERE cm.member_id = ${memberId}
     ORDER BY cm.assigned_at DESC`;
  return rows.map((row) => ({
    cardId: row.card_id,
    memberId,
    provider: row.provider,
    providerCardToken: row.provider_card_token,
    lastFour: row.last_four,
    nickname: row.nickname,
    assignedAt: row.assigned_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    providerState: null,
  }));
}

/**
 * What is still open on one member's cards.
 *
 * `NOT ch.is_closed` is `v_card_auth_hold`'s own predicate — the fold over the
 * event set, four ways to be closed — and not a second opinion about it.
 */
export async function outstandingForMember(
  memberId: string,
  conn: Sql = sql,
): Promise<readonly OutstandingAuthorisation[]> {
  const rows = await conn<
    {
      auth_id: string;
      provider_auth_id: string;
      hold_id: string;
      card_id: string;
      last_four: string | null;
      auth_net_cents: bigint;
      captured_cents: bigint;
      target_hold_cents: bigint;
      memo_balance_cents: bigint;
      expires_at: Date;
    }[]
  >`
    SELECT ca.id AS auth_id, ca.provider_auth_id, ca.hold_id, cm.card_id, c.last_four,
           ch.auth_net_cents, ch.captured_cents, ch.target_hold_cents,
           hs.memo_balance_cents, ca.expires_at
      FROM card_member cm
      JOIN card c                ON c.id = cm.card_id
      JOIN card_authorization ca ON ca.card_id = cm.card_id
      JOIN v_card_auth_hold ch   ON ch.auth_id = ca.id
      JOIN v_hold_state hs       ON hs.hold_id = ca.hold_id
     WHERE cm.member_id = ${memberId}
       AND NOT ch.is_closed
     ORDER BY ca.first_seen_at DESC`;
  return rows.map((row) => ({
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
  }));
}

/** Re-exported so a caller needs one import for the whole lifecycle. */
export { listTermsVersions };

function describe(thrown: unknown): string {
  if (thrown instanceof Error) {
    const body = (thrown as { body?: unknown }).body;
    const detail = body === undefined ? "" : ` ${JSON.stringify(body)}`.slice(0, 300);
    return `${thrown.message}${detail}`.slice(0, 400);
  }
  return String(thrown).slice(0, 300);
}
