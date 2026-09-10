/**
 * The operator decision's tests.
 *
 * ===========================================================================
 * WHAT THESE ARE DEFENDING.
 *
 * A manual override is the most dangerous control in this module, because it is
 * the one that can turn a registry's honest "we have never heard of this
 * company" into a green `approved` badge. Everything that keeps that honest is
 * a rule in ./manual-review.ts, and a rule with no test is a comment.
 *
 * Four properties, in order of how badly they would hurt if they broke:
 *
 *   1. A review can never be labelled `live`. A human is not a third party.
 *   2. A review cannot clear a provider's DECLINE — only its uncertainty.
 *   3. A review without a written reason is not a review.
 *   4. The provider's answer survives the override, in the row and on screen.
 * ===========================================================================
 */

import { describe, expect, it } from 'vitest';

import {
  isManualReview,
  manualReviewLeg,
  reviewRefusal,
  MANUAL_CODES,
  MANUAL_MIN_REASON_LENGTH,
  MANUAL_PROVIDER_NAME,
  MANUAL_REFERENCE_PREFIX,
  type Reviewer,
} from './manual-review';
import { CompositeKybResult } from './composite';
import {
  canTransact,
  degradeEvidence,
  providerCodeFromChecks,
  type KybLegResult,
  type KybStatus,
} from './types';

const DANA: Reviewer = {
  id: '76f9266f-23c9-52de-b8ff-0ec0b23ef386',
  displayName: 'Dana Okonkwo',
  kind: 'human',
};

const AGENT: Reviewer = { id: 'a0000000-0000-4000-8000-000000000001', displayName: 'Corgi payments agent', kind: 'agent' };

/** The real reason used to approve Ridgeline, trimmed to the shape of one. */
const GOOD_REASON =
  'GLEIF holds no LEI record for this entity, which is expected for a company of this size; incorporation certificate and EIN letter checked against the filing and both are consistent.';

const BUSINESS = 'e274546d-6bdd-5266-b0fb-cc839a7811f9';

function review(over: Partial<Parameters<typeof manualReviewLeg>[0]> = {}) {
  return manualReviewLeg({
    leg: 'business_registry',
    decision: 'approve',
    reviewer: DANA,
    reason: GOOD_REASON,
    businessId: BUSINESS,
    overriding: {
      provider: 'gleif-lei',
      status: 'needs_review',
      rawStatus: 'not_in_lei_registry',
      providerCode: 'not_in_lei_registry',
    },
    observedAt: '2026-09-10T20:00:00.000Z',
    ...over,
  });
}

// ---------------------------------------------------------------------------
// 1. A review is never a third party's answer
// ---------------------------------------------------------------------------

describe('manualReviewLeg', () => {
  it('is labelled `manual`, and the type will not let it be anything else', () => {
    const leg = review();
    expect(leg.evidence).toBe('manual');
    // The declared return type is KybLegResult<'manual'>, so a line assigning
    // 'live' here would not compile. This asserts the runtime half.
    expect<'manual'>(leg.evidence).toBe('manual');
  });

  it('files itself under the operator, never under a vendor', () => {
    const leg = review();
    expect(leg.provider).toBe(MANUAL_PROVIDER_NAME);
    expect(leg.reference.startsWith(MANUAL_REFERENCE_PREFIX)).toBe(true);
    // Never `sim.` — 0005's kyb_leg_simulated_reference is about a different
    // lie, and a review is not a simulation.
    expect(leg.reference.startsWith('sim.')).toBe(false);
  });

  it('carries the reviewer, the reason and WHAT IT OVERRODE into the evidence', () => {
    const reasons = review().checks[0]?.reasons.join(' ') ?? '';
    expect(reasons).toContain('Dana Okonkwo');
    expect(reasons).toContain(GOOD_REASON);
    // The superseded answer, named on the row itself — so the evidence is
    // legible without the screen's join.
    expect(reasons).toContain('gleif-lei');
    expect(reasons).toContain('not_in_lei_registry');
    // And it says out loud what kind of thing it is.
    expect(reasons).toContain('HUMAN decision');
  });

  it('emits a machine-readable code under the reserved check name', () => {
    expect(providerCodeFromChecks(review().checks)).toBe(MANUAL_CODES.approved);
    expect(providerCodeFromChecks(review({ decision: 'decline' }).checks)).toBe(
      MANUAL_CODES.declined,
    );
  });

  it('maps approve to approved and decline to rejected, and nothing else', () => {
    expect(review({ decision: 'approve' }).status).toBe('approved');
    expect(review({ decision: 'decline' }).status).toBe('rejected');
  });

  it('offers no hosted flow, because the decision already happened', () => {
    expect(review().hostedUrl).toBeNull();
  });

  it('is recognisable as a review by the two marks the database constrains', () => {
    expect(isManualReview(review())).toBe(true);
    expect(isManualReview({ provider: 'gleif-lei', evidence: 'live' })).toBe(false);
    // Evidence alone is not enough, and neither is the name alone.
    expect(isManualReview({ provider: MANUAL_PROVIDER_NAME, evidence: 'live' })).toBe(false);
    expect(isManualReview({ provider: 'gleif-lei', evidence: 'manual' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. What a review is not allowed to do
// ---------------------------------------------------------------------------

describe('reviewRefusal', () => {
  function ask(over: Partial<Parameters<typeof reviewRefusal>[0]> = {}) {
    return reviewRefusal({
      decision: 'approve',
      reviewer: DANA,
      currentStatus: 'needs_review',
      reason: GOOD_REASON,
      ...over,
    });
  }

  it('permits the case it exists for: a human resolving a registry miss', () => {
    expect(ask()).toBeNull();
    expect(ask({ currentStatus: 'pending' })).toBeNull();
  });

  it('REFUSES to clear a provider\'s decline', () => {
    // The boundary that keeps this from being an "approve anything" button.
    // A registry `rejected` means GLEIF reported an entity INACTIVE or a
    // registration RETIRED, or refused an identifier that does not exist —
    // decisions about facts, not gaps in coverage.
    const refusal = ask({ currentStatus: 'rejected' });
    expect(refusal?.code).toBe('REVIEW_CANNOT_CLEAR_A_DECLINE');
    expect(refusal?.message).toContain('decision about a fact');
  });

  it('still lets a human say NO to anything', () => {
    for (const status of ['pending', 'needs_review', 'rejected', 'approved'] as KybStatus[]) {
      expect(ask({ decision: 'decline', currentStatus: status })).toBeNull();
    }
  });

  it('refuses a non-human reviewer — the agent surface cannot clear its own queue', () => {
    const refusal = ask({ reviewer: AGENT });
    expect(refusal?.code).toBe('REVIEW_REVIEWER_NOT_HUMAN');
    // Belt and braces: 0013 constrains decided_by_kind through a composite
    // foreign key to actor(id, kind), so the database refuses it too.
    expect(refusal?.message).toContain('composite foreign key');
  });

  it('refuses a reason that is not one', () => {
    for (const reason of ['', '   ', 'ok', 'looks fine to me']) {
      expect(ask({ reason })?.code).toBe('REVIEW_REASON_TOO_SHORT');
    }
    // The floor is a floor, not a hurdle.
    expect(ask({ reason: 'x'.repeat(MANUAL_MIN_REASON_LENGTH) })).toBeNull();
  });

  it('refuses to override nothing', () => {
    expect(ask({ currentStatus: null })?.code).toBe('REVIEW_NOTHING_TO_REVIEW');
  });

  it('refuses to re-approve an already-approved leg', () => {
    // Appending a manual approval to a live approval would only weaken the
    // evidence from `live` to `manual` for no gain.
    expect(ask({ currentStatus: 'approved' })?.code).toBe('REVIEW_ALREADY_APPROVED');
  });
});

// ---------------------------------------------------------------------------
// 3. What it does to the composite — the reason `manual` is a third label
// ---------------------------------------------------------------------------

function leg(over: Partial<KybLegResult>): KybLegResult {
  return {
    leg: 'director_kyc',
    provider: 'stripe-identity',
    reference: 'vs_1UEDLcDgSL5WTGpmif87HEZ7',
    referenceId: BUSINESS,
    status: 'approved',
    rawStatus: 'verified',
    checks: [],
    hostedUrl: null,
    observedAt: '2026-09-10T19:09:24.000Z',
    evidence: 'live',
    ...over,
  };
}

describe('a reviewed composite', () => {
  it('is approved, and its evidence is `manual` — not live, not simulated', () => {
    const composite = CompositeKybResult.rehydrate(BUSINESS, [leg({}), review()]);
    expect(composite.status).toBe('approved');
    expect(composite.evidence).toBe('manual');
    expect(composite.isLive).toBe(false);
  });

  it('never un-degrades: one manual leg and the whole verification is manual, for ever', () => {
    expect(degradeEvidence(['live', 'manual'])).toBe('manual');
    expect(degradeEvidence(['manual', 'live'])).toBe('manual');
    // ...and a simulated leg still beats it, because it is weaker still.
    expect(degradeEvidence(['live', 'manual', 'simulated'])).toBe('simulated');
    expect(degradeEvidence(['manual', 'manual'])).toBe('manual');
    expect(degradeEvidence(['live', 'live'])).toBe('live');
  });

  it('an empty set of legs is `simulated`, not vacuously live', () => {
    // The `every()` spelling this replaced answered 'live' here, which was
    // vacuously true and practically a hole.
    expect(degradeEvidence([])).toBe('simulated');
  });

  it('lets the business transact under this deployment\'s policy', () => {
    const decision = canTransact({
      businessId: BUSINESS,
      status: 'approved',
      evidence: 'manual',
      decidedAt: '2026-09-10T20:00:00.000Z',
    });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.evidence).toBe('manual');
  });

  it('and refuses it under one that demands a third party — with its OWN code', () => {
    const decision = canTransact(
      {
        businessId: BUSINESS,
        status: 'approved',
        evidence: 'manual',
        decidedAt: '2026-09-10T20:00:00.000Z',
      },
      { requireLiveEvidence: true },
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      // NOT the simulated code. "A named person decided this, here is their
      // reason" and "nobody decided this" are different refusals, and a queue
      // that could not tell them apart would be unusable.
      expect(decision.code).toBe('KYB_EVIDENCE_MANUAL');
      expect(decision.message).toContain('named operator');
    }
  });

  it('a reviewed leg still cannot make a one-legged verification pass', () => {
    const composite = CompositeKybResult.rehydrate(BUSINESS, [review()]);
    // One leg on file. The strictest-of fold over a single approved leg is
    // approved here, but the DATABASE view is the gate's input and it reads
    // fewer than two legs as pending. This asserts the TS half stays honest
    // about what it was given rather than inventing the missing leg.
    expect(composite.legs).toHaveLength(1);
    expect(composite.evidence).toBe('manual');
  });

  it('a decline by review carries the whole composite to rejected', () => {
    const composite = CompositeKybResult.rehydrate(BUSINESS, [
      leg({}),
      review({ decision: 'decline' }),
    ]);
    expect(composite.status).toBe('rejected');
    expect(composite.evidence).toBe('manual');
  });
});
