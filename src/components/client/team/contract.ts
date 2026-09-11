/**
 * What `/client/team` renders, in one shape.
 *
 * ===========================================================================
 * NO `bigint` CROSSES THIS BOUNDARY, AND NO `number` EVER HOLDS MONEY
 * ===========================================================================
 *
 * Every figure below is a STRING the server formatted while it still held a
 * `bigint` of integer minor units, for the reason `src/lib/cards/types.ts`
 * gives: `JSON.parse` turns 9007199254740993 into 9007199254740992, and a limit
 * that silently rounds is a limit that silently fails open. The forms send back
 * the literal characters somebody typed and the server parses them as text into
 * a `bigint`. There is no `Number`, no `parseFloat` and no `* 100` on this path
 * at any point.
 *
 * ===========================================================================
 * A BLANK LIMIT AND A TYPED ZERO ARE DIFFERENT VALUES AND STAY DIFFERENT
 * ===========================================================================
 *
 * `perTxnField` is `""` when the member has no limit of that kind and `"0.00"`
 * when their limit is zero. `null` is "no limit of this kind on this person";
 * `0` is "this person spends nothing". Both are reachable from the form, the
 * database stores both, and a single sentinel would collapse them — always in
 * the dangerous direction. The display string keeps them apart in words too:
 * "no limit" versus "$0.00".
 *
 * This module is imported by client components. No `server-only`, no database.
 */

import type { MemberState, TeamRole } from "@/lib/team/roles";

/** One card a teammate holds. */
export type TeammateCard = {
  readonly cardId: string;
  /** "4242", or null when the issuer never told us. */
  readonly lastFour: string | null;
  readonly nickname: string | null;
  readonly issuedAt: string;
  /**
   * What the ISSUER says it is, when the screen asked. `null` means we did not
   * ask or Lithic did not answer — never "we assume it is open".
   */
  readonly providerState: string | null;
};

/** One person on the customer's own team. */
export type TeammateLine = {
  readonly memberId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly role: TeamRole;
  readonly state: MemberState;
  readonly joinedAt: string;
  readonly termsVersion: number;
  readonly termsEffectiveFrom: string;
  readonly note: string;

  /** "$250.00" or "no limit". */
  readonly perTxnDisplay: string;
  readonly dailyDisplay: string;
  readonly monthlyDisplay: string;
  /** "250.00" or "" — what the edit form starts with. Blank stays blank. */
  readonly perTxnField: string;
  readonly dailyField: string;
  readonly monthlyField: string;

  /** Approved purchase spend, across all their cards. */
  readonly spentTodayDisplay: string;
  readonly spentMonthDisplay: string;

  readonly cards: readonly TeammateCard[];
  /** Authorisations of theirs still in flight. Removal does not touch these. */
  readonly outstandingCount: number;
  readonly outstandingDisplay: string;

  /**
   * `actor.can_approve` — the envelope, fixed when this person was created,
   * because `actor` rows are append-only. A member whose envelope is false can
   * never hold `approver` or `admin`, whatever this screen offers, and
   * `assert_team_member_version()` is what actually refuses it.
   */
  readonly actorCanApprove: boolean;

  /**
   * True for the one member this surface is acting AS. Their own row carries no
   * edit and no remove: see `ACTING_RULE` below.
   */
  readonly isYou: boolean;
};

/**
 * Who this surface is acting as, and why that is not a staff actor.
 *
 * ===========================================================================
 * THE CUSTOMER ACTS AS THEIR OWN ADMIN, NOT AS CORGI STAFF
 * ===========================================================================
 *
 * `team_add_member()` (0044) has two authorship branches: an ACTIVE ADMIN OF
 * THIS BUSINESS, or a human actor who is not a member of it at all — the Corgi
 * staff branch, which is gated by nothing but `kind = 'human'`. The rest of
 * `/client` resolves the staff actor from the role cookie, and that is right
 * for a screen where staff are genuinely the ones acting.
 *
 * It is wrong here. Attributing a customer's team change to a staff actor would
 * take the UNGATED branch of the function on every write, which means the one
 * screen whose entire subject is "who may do what" would be the screen that
 * skipped the check. It would also make `v_team_terms_by_unauthorised_author`
 * pass for the wrong reason: staff are permitted by name in that view, so a
 * customer write laundered through a staff actor would never be counted.
 *
 * So this surface resolves the business's own active admin, by a predicate the
 * database applies (`WHERE business_id = $1 AND state = 'active' AND role =
 * 'admin'`), and attributes every write to them. The gated branch runs. When a
 * session claim replaces the demo control, one line changes — where the actor
 * id comes from — because every write beneath it already re-reads the actor's
 * membership rather than trusting the form.
 */
export type ActingAdmin = {
  readonly memberId: string;
  readonly actorId: string;
  readonly displayName: string;
  readonly role: TeamRole;
};

/**
 * THE RULE THIS SURFACE ADDS ON TOP OF THE DATABASE'S OWN.
 *
 * Stated once, here, so the screen and the actions quote the same sentence.
 */
export const ACTING_RULE =
  "You cannot change your own membership from this screen — not your role, not your limits, not your removal. " +
  "An administrator who can rewrite their own terms can grant themselves approval rights, and this is the screen " +
  "where that would happen. The database already refuses the widest version of it (actor.can_approve is decided " +
  "when a person is created and actor rows are append-only, so a viewer can never become an approver), and this " +
  "screen refuses the rest: ask another admin, or ask Corgi.";

export type ClientTeamScreen = {
  readonly subject: {
    readonly businessId: string;
    readonly legalName: string;
    readonly accountName: string | null;
    readonly asOf: string;
    readonly live: boolean;
    readonly businesses: readonly {
      readonly id: string;
      readonly legalName: string;
      readonly hasAccount: boolean;
    }[];
  };
  /**
   * `null` when this business has no active admin. Not an error: a business's
   * first admin is created by Corgi ops at account opening, because a business
   * cannot appoint its own first administrator. The screen renders the team and
   * refuses every write, saying which.
   */
  readonly actingAs: ActingAdmin | null;
  readonly members: readonly TeammateLine[];
};

/** The roles a customer may hand out, with the sentence each one means. */
export const CLIENT_ROLE_CHOICES = [
  "viewer",
  "initiator",
  "approver",
  "admin",
] as const satisfies readonly TeamRole[];
