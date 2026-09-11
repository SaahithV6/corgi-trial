/**
 * The vocabulary of a team.
 *
 * Nothing here imports a database or `server-only`. Money is `bigint` cents at
 * every point, and where a figure crosses a serialisation boundary — a server
 * action's return value, the `inputs` column of a decision — it crosses as a
 * DECIMAL STRING of integer cents, for the reason `src/lib/cards/types.ts`
 * gives: `JSON.parse` turns 9007199254740993 into 9007199254740992, and a limit
 * that silently rounds is a limit that silently fails open.
 */

import type { MemberState, TeamRole } from "./roles";

/**
 * One person's terms, as of now: their role, their state and their own spend
 * limits.
 *
 * A `null` limit means "no limit of this kind on this person"; `0n` means "this
 * person spends nothing". Both are reachable from the screen and they mean
 * different things — the same distinction `CardControls` makes, for the same
 * reason, and a single sentinel would collapse them the dangerous way.
 *
 * THESE LIMITS SIT ON TOP OF THE CARD'S OWN, they do not replace them. A card
 * limit is a property of an INSTRUMENT: it resets when the card is re-issued,
 * because re-issuing is a new `card` row (0008). A member limit is a property
 * of a PERSON and survives the card being replaced. Both are enforced, in that
 * order, in the same authorisation decision.
 */
export type MemberTerms = {
  readonly memberId: string;
  readonly memberVersionId: string;
  readonly version: number;
  readonly effectiveFrom: string;
  readonly state: MemberState;
  readonly role: TeamRole;
  readonly perTxnLimitCents: bigint | null;
  readonly dailyLimitCents: bigint | null;
  readonly monthlyLimitCents: bigint | null;
  readonly note: string;
};

/** What an admin asked for. The version number is the store's to assign. */
export type MemberTermsDraft = {
  readonly state: MemberState;
  readonly role: TeamRole;
  readonly perTxnLimitCents: bigint | null;
  readonly dailyLimitCents: bigint | null;
  readonly monthlyLimitCents: bigint | null;
  readonly note: string;
};

/** A member, their person, their terms and their capabilities. */
export type TeamMember = {
  readonly memberId: string;
  readonly businessId: string;
  readonly actorId: string;
  readonly membershipSeq: number;
  readonly joinedAt: string;
  readonly displayName: string;
  readonly email: string | null;
  /**
   * `actor.can_approve` from 0001 — the ENVELOPE, fixed when the member was
   * created because `actor` rows are append-only. The member's current role is
   * what actually decides, and the composition is an AND: 0033 can only ever
   * narrow what 0001 already allows. See docs/TEAM.md §5.
   */
  readonly actorCanApprove: boolean;
  readonly terms: MemberTerms;
  readonly canViewBalance: boolean;
  readonly canRaisePayment: boolean;
  readonly canApprovePayment: boolean;
  readonly canAdministerTeam: boolean;
};

/** One card held by one member. */
export type MemberCard = {
  readonly cardId: string;
  readonly memberId: string;
  readonly provider: string;
  readonly providerCardToken: string;
  readonly lastFour: string | null;
  readonly nickname: string | null;
  readonly assignedAt: string;
  readonly createdAt: string;
  /**
   * What the ISSUER says the card is, read live from Lithic when the screen can
   * afford it. `null` means we did not ask or the provider did not answer —
   * never "we assume it is open".
   */
  readonly providerState: string | null;
};

/**
 * An authorisation that was outstanding on a member's card, with what the fold
 * over its event set currently says.
 *
 * This is the edge state. A member removed while holding one of these is the
 * state most likely to render wrong, and it is the one place where "delete the
 * user" would have been a money bug.
 */
export type OutstandingAuthorisation = {
  readonly authId: string;
  readonly providerAuthId: string;
  readonly holdId: string;
  readonly cardId: string;
  readonly lastFour: string | null;
  /** A(E), net of reversals. */
  readonly authorisedCents: bigint;
  /** C(E), including over-capture. */
  readonly capturedCents: bigint;
  /** H(E) = max(A − C, 0), or 0 once closed. */
  readonly targetHoldCents: bigint;
  /** What the memo book currently withholds. Equal to H(E) at the fixpoint. */
  readonly memoBalanceCents: bigint;
  readonly expiresAt: string;
};

/** A member, everything about them the team screen shows. */
export type TeamMemberDetail = {
  readonly member: TeamMember;
  readonly cards: readonly MemberCard[];
  readonly outstanding: readonly OutstandingAuthorisation[];
  /** Approved purchase spend today and this book month, across all their cards. */
  readonly spend: { readonly dayCents: bigint; readonly monthCents: bigint };
};

/** One version of one member's terms, for the history panel. */
export type MemberTermsVersion = MemberTerms & {
  readonly createdAt: string;
  readonly createdByName: string | null;
};

/** What a write returns. Never throws a provider error at a screen. */
export type TeamOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };
