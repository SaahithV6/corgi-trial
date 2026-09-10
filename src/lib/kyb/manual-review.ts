/**
 * THE OPERATOR DECISION — what a `needs_review` queue is actually for.
 *
 * ===========================================================================
 * THE PROBLEM THIS SOLVES, STATED HONESTLY BECAUSE IT WAS OUR OWN.
 *
 * Moving the business-registry leg onto GLEIF was correct and it broke the
 * product. GLEIF is a real registry queried live, its population is
 * financial-market participants, and an ordinary small company is simply not in
 * it — so every business on this book came back `not_in_lei_registry`. That is
 * the right registry answer: a hit is strong evidence, a miss is evidence of
 * nothing, and a miss must never approve on its own.
 *
 * But `needs_review` is a QUEUE, not a verdict, and nothing could act on it. An
 * honest check became a permanently stuck account, and `canTransact()` — which
 * runs inside `requestPayment()` — refused every outbound payment on the book.
 *
 * There were three ways out and two of them were disqualifying:
 *
 *   WEAKEN THE GATE. Let `needs_review` transact. This deletes the only
 *   sentence the screen exists to make true.
 *
 *   INVENT AN LEI. Give a demo company a real company's identifier so the
 *   registry hits. This is the forgery the entire module is built against, and
 *   it would put a real Secretary of State citation on a fictional business.
 *
 *   REVIEW IT. What a real KYB operation does with a registry miss: a named
 *   human looks at the file, accepts or refuses other evidence, and writes down
 *   why. The registry still said what it said. A person said something else.
 *   The system records BOTH rather than collapsing them into one word.
 *
 * ===========================================================================
 * A REVIEW IS ANOTHER OBSERVATION, NOT AN EDIT.
 *
 * It is a row in `kyb_verification_leg` like any other, so:
 *
 *   - "latest per (business, leg) wins" folds it in with no special case —
 *     `v_business_kyb` needed no new branch, only `bool_and` becoming `max`;
 *   - the previous registry answer is still there, in full, with its citation
 *     and its provider code. Nothing is overwritten, because there is no UPDATE
 *     grant on that table to overwrite it with;
 *   - a reversal is a further row. An operator who approves and then thinks
 *     better of it appends a decline; both are in the history, in order, with
 *     both reasons.
 *
 * WHAT IS NEW is that a row can name a PERSON instead of a vendor, and the
 * evidence lattice grew `manual` to say so — ordered between `live` and
 * `simulated`, so the existing worst-wins fold makes the composite honest by
 * itself. See the `Evidence` doc comment in ./types.ts for why a human's
 * decision can be neither of the other two labels.
 *
 * ===========================================================================
 * THE ONE THING A REVIEW MAY NOT DO: CLEAR A THIRD PARTY'S DECLINE.
 *
 * `approveLegIsPermitted` refuses to approve a leg a provider has `rejected`.
 * That is a real policy choice and it deserves an argument rather than a
 * default.
 *
 * A registry `rejected` on this book means something specific: GLEIF reported
 * `entity.status INACTIVE` or `registration.status RETIRED` for a real company
 * the register says stopped trading, or answered 404 for an identifier the
 * applicant asserted. Those are DECISIONS a third party made about a fact,
 * not gaps in coverage. `needs_review` is the status that means "the registry
 * could not tell us", and that is the one a human is here to resolve.
 *
 * A real KYB operation with a compliance officer and an audit trail can of
 * course override a decline. This build has one operator role and no
 * four-eyes on KYB, so the safe boundary is the honest one: a reviewer clears
 * uncertainty, and does not overturn a refusal. A DECLINE by review is always
 * permitted — a human may always say no.
 * ===========================================================================
 */

import {
  KYB_LEG_LABEL,
  KYB_PROVIDER_CODE_CHECK,
  type KybCheck,
  type KybLegKind,
  type KybLegResult,
  type KybStatus,
} from './types';

// ---------------------------------------------------------------------------
// 1. Vocabulary
// ---------------------------------------------------------------------------

/**
 * The `provider` recorded on a review row.
 *
 * Deliberately not a vendor name and deliberately not blank: every surface in
 * this build prints `provider` next to a leg, so the thing that appears beside
 * a manually-approved business has to read as a person's decision at a glance.
 * `db/migrations/0013` pins this exact string in a CHECK, in both directions —
 * a manual row must carry it, and no other row may.
 */
export const MANUAL_PROVIDER_NAME = 'operator-review';

/**
 * `provider_reference` prefix. Never `sim.` — 0005's
 * `kyb_leg_simulated_reference` refuses a `live` row carrying that mark, and a
 * review is not a simulation anyway. 0013 requires this prefix on every manual
 * row.
 */
export const MANUAL_REFERENCE_PREFIX = 'manual.';

/**
 * The floor on a written reason, in characters.
 *
 * Low enough to be no obstacle to a real explanation, high enough that a rubber
 * stamp has to be typed out on purpose. Restated as a CHECK in 0013 so the
 * database refuses a blank reason even if a future caller forgets to.
 */
export const MANUAL_MIN_REASON_LENGTH = 20;

/** What an operator can do to a leg. */
export type ManualDecision = 'approve' | 'decline';

export const MANUAL_DECISION_STATUS: Record<ManualDecision, KybStatus> = {
  approve: 'approved',
  decline: 'rejected',
};

/** Our own machine-readable code for each review outcome. */
export const MANUAL_CODES = {
  approved: 'operator_approved_after_review',
  declined: 'operator_declined_after_review',
} as const;

/** The reviewer, as much of them as a leg row records. */
export interface Reviewer {
  readonly id: string;
  readonly displayName: string;
  /**
   * `human` or nothing. 0013 carries this to the database as
   * `decided_by_kind` and constrains it with a composite foreign key to
   * `actor(id, kind)` plus a CHECK — so "an agent approved a KYB leg" is
   * unrepresentable rather than merely refused by this file.
   */
  readonly kind: string;
}

// ---------------------------------------------------------------------------
// 2. Whether the decision is allowed at all
// ---------------------------------------------------------------------------

export type ReviewRefusal =
  | { readonly code: 'REVIEW_REASON_TOO_SHORT'; readonly message: string }
  | { readonly code: 'REVIEW_REVIEWER_NOT_HUMAN'; readonly message: string }
  | { readonly code: 'REVIEW_CANNOT_CLEAR_A_DECLINE'; readonly message: string }
  | { readonly code: 'REVIEW_NOTHING_TO_REVIEW'; readonly message: string }
  | { readonly code: 'REVIEW_ALREADY_APPROVED'; readonly message: string };

/**
 * Every rule that can refuse a review, in one pure function.
 *
 * Pure and exported so the screen can grey a control for the same reason the
 * server refuses it, from the same code — the pattern the approvals queue
 * already uses. The server calls this again on every POST regardless of what
 * the button looked like.
 */
export function reviewRefusal(args: {
  readonly decision: ManualDecision;
  readonly reviewer: Reviewer;
  /** The leg's CURRENT status, i.e. the latest observation before this one. */
  readonly currentStatus: KybStatus | null;
  readonly reason: string;
}): ReviewRefusal | null {
  if (args.reviewer.kind !== 'human') {
    return {
      code: 'REVIEW_REVIEWER_NOT_HUMAN',
      message:
        'A KYB leg can only be decided by a human. The database refuses it too — 0013 constrains the reviewer to actor.kind = \'human\' with a composite foreign key, so this is an absent capability rather than a check anybody could forget.',
    };
  }

  if (args.reason.trim().length < MANUAL_MIN_REASON_LENGTH) {
    return {
      code: 'REVIEW_REASON_TOO_SHORT',
      message: `A review needs a written reason of at least ${MANUAL_MIN_REASON_LENGTH} characters. The reason IS the evidence here — without it this row would say a person approved a business and nothing about why, which is worse than the registry answer it replaces.`,
    };
  }

  if (args.currentStatus === null) {
    return {
      code: 'REVIEW_NOTHING_TO_REVIEW',
      message:
        'There is no observation on this leg to review. Start a verification first — a review resolves what a provider said, and overriding nothing is not a review.',
    };
  }

  if (args.decision === 'approve' && args.currentStatus === 'rejected') {
    return {
      code: 'REVIEW_CANNOT_CLEAR_A_DECLINE',
      message:
        'A provider DECLINED this leg, and a decline is a decision about a fact rather than a gap in coverage — the registry reporting an entity as INACTIVE or RETIRED, or refusing an identifier that does not exist. Review resolves uncertainty (`pending`, `needs_review`); it does not overturn a refusal. This build has one operator role and no four-eyes on KYB, so that boundary stays where it is.',
    };
  }

  if (args.decision === 'approve' && args.currentStatus === 'approved') {
    return {
      code: 'REVIEW_ALREADY_APPROVED',
      message:
        'This leg is already approved, so there is nothing for a review to resolve. Appending a manual approval here would only weaken its evidence label from live to manual for no gain.',
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 3. The row
// ---------------------------------------------------------------------------

/**
 * Build a review observation.
 *
 * Typed `KybLegResult<'manual'>`, which is a promise the type system holds it
 * to: this function cannot produce a row labelled `live`, and no caller can
 * relabel what it returns.
 *
 * `reference` encodes the decision and the reviewer, so the id printed beside
 * the leg says what it is without a join — the same property that makes
 * `gleif.notfound.<LEI>` readable at a glance.
 */
export function manualReviewLeg(args: {
  readonly leg: KybLegKind;
  readonly decision: ManualDecision;
  readonly reviewer: Reviewer;
  readonly reason: string;
  readonly businessId: string;
  /** What is being overridden, for the reasons and the reference. */
  readonly overriding: {
    readonly provider: string;
    readonly status: KybStatus;
    readonly rawStatus: string | null;
    readonly providerCode: string | null;
  } | null;
  readonly observedAt?: string | undefined;
}): KybLegResult<'manual'> {
  const observedAt = args.observedAt ?? new Date().toISOString();
  const status = MANUAL_DECISION_STATUS[args.decision];
  const reason = args.reason.trim();
  const code = args.decision === 'approve' ? MANUAL_CODES.approved : MANUAL_CODES.declined;

  const overridden =
    args.overriding === null
      ? 'there was no provider observation to override'
      : `overrides ${args.overriding.provider}, which answered ${args.overriding.status}${
          args.overriding.providerCode === null ? '' : ` (${args.overriding.providerCode})`
        }${args.overriding.rawStatus === null ? '' : ` — raw status ${args.overriding.rawStatus}`}`;

  const checks: KybCheck[] = [
    {
      name: 'operator_review',
      status: args.decision === 'approve' ? 'passed' : 'failed',
      reasons: [
        `${KYB_LEG_LABEL[args.leg]} ${args.decision === 'approve' ? 'APPROVED' : 'DECLINED'} by ${args.reviewer.displayName} on review`,
        `reason given: ${reason}`,
        overridden,
        // Said on the row itself, not only in a document: whoever reads this
        // evidence later should not have to know our conventions to know that
        // a person decided it.
        'this is a HUMAN decision, not a third party\'s answer — its evidence label is `manual`, and the composite it belongs to can never read `live` again',
      ],
    },
    {
      name: KYB_PROVIDER_CODE_CHECK,
      status: args.decision === 'approve' ? 'passed' : 'failed',
      reasons: [code, `reviewer actor id ${args.reviewer.id}`],
    },
  ];

  return {
    leg: args.leg,
    provider: MANUAL_PROVIDER_NAME,
    reference: `${MANUAL_REFERENCE_PREFIX}${args.decision}.${args.leg}.${args.businessId}.${observedAt}`,
    referenceId: args.businessId,
    status,
    rawStatus: code,
    checks,
    // A review is not a flow anybody can be sent to. It already happened.
    hostedUrl: null,
    observedAt,
    evidence: 'manual',
  };
}

/** Is this leg row an operator decision rather than a provider's answer? */
export function isManualReview(leg: {
  readonly provider: string;
  readonly evidence: string;
}): boolean {
  return leg.evidence === 'manual' && leg.provider === MANUAL_PROVIDER_NAME;
}
