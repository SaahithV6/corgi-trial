import { describe, expect, it } from 'vitest';

import {
  asEvidence,
  asKybStatus,
  assertCanTransact,
  businessKybStateFromRow,
  canTransact,
  degradeEvidence,
  KybGateError,
  KYB_STATUSES,
  KYB_STATUS_STRICTNESS,
  strictestOf,
  strictestStatus,
  type BusinessKybState,
  type KybStatus,
} from './types';

// ---------------------------------------------------------------------------
// The lattice
// ---------------------------------------------------------------------------

describe('the status lattice', () => {
  it('orders rejected > needs_review > pending > approved', () => {
    const s = KYB_STATUS_STRICTNESS;
    expect(s.rejected).toBeGreaterThan(s.needs_review);
    expect(s.needs_review).toBeGreaterThan(s.pending);
    expect(s.pending).toBeGreaterThan(s.approved);
  });

  it('lists statuses in ascending strictness, matching the Postgres enum', () => {
    // db/migrations/0005_kyb.sql declares kyb_status in this order so that
    // max(status) in v_business_kyb IS "the strictest status".
    expect([...KYB_STATUSES]).toEqual(['approved', 'pending', 'needs_review', 'rejected']);
  });

  it('is commutative and associative, so legs can be folded in any order', () => {
    for (const a of KYB_STATUSES) {
      for (const b of KYB_STATUSES) {
        expect(strictestStatus(a, b)).toBe(strictestStatus(b, a));
        for (const c of KYB_STATUSES) {
          expect(strictestStatus(strictestStatus(a, b), c)).toBe(
            strictestStatus(a, strictestStatus(b, c)),
          );
        }
      }
    }
  });

  it('folds an empty set to pending, never approved', () => {
    expect(strictestOf([])).toBe('pending');
  });

  it('folds a set to its strictest member', () => {
    expect(strictestOf(['approved', 'approved'])).toBe('approved');
    expect(strictestOf(['approved', 'pending'])).toBe('pending');
    expect(strictestOf(['approved', 'rejected', 'pending'])).toBe('rejected');
    expect(strictestOf(['needs_review', 'pending'])).toBe('needs_review');
  });

  it('narrows untrusted strings and refuses everything else', () => {
    expect(asKybStatus('approved')).toBe('approved');
    expect(asKybStatus('APPROVED')).toBeNull();
    expect(asKybStatus('verified')).toBeNull();
    expect(asKybStatus(null)).toBeNull();
    expect(asKybStatus(undefined)).toBeNull();
    expect(asKybStatus(1)).toBeNull();
    // Prototype keys must not be mistaken for statuses.
    expect(asKybStatus('toString')).toBeNull();
    expect(asKybStatus('constructor')).toBeNull();
  });
});

describe('degradeEvidence', () => {
  it('is live only when every leg is live', () => {
    expect(degradeEvidence(['live', 'live'])).toBe('live');
    expect(degradeEvidence(['live', 'simulated'])).toBe('simulated');
    expect(degradeEvidence(['simulated', 'live'])).toBe('simulated');
    expect(degradeEvidence(['simulated'])).toBe('simulated');
  });

  it('treats no legs at all as SIMULATED, because nobody vouched for it', () => {
    // This assertion used to expect 'live', on the reasoning that an empty
    // conjunction is vacuously true and that the "both legs required" rule
    // lives elsewhere (v_business_kyb: legs_on_file < 2 => pending).
    //
    // Vacuously true is the wrong default for a claim about who verified
    // something. A verification made of no legs rests on nobody's word, and the
    // safe answer to "how good is this evidence" when there is no evidence is
    // the weakest label, not the strongest. The old spelling meant a bug that
    // dropped both legs would report the strongest possible evidence, which is
    // the failure mode this whole module exists to prevent.
    expect(degradeEvidence([])).toBe('simulated');
  });

  it('narrows untrusted evidence strings', () => {
    expect(asEvidence('live')).toBe('live');
    expect(asEvidence('simulated')).toBe('simulated');
    expect(asEvidence('real')).toBeNull();
    expect(asEvidence(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

function state(overrides: Partial<BusinessKybState> = {}): BusinessKybState {
  return {
    businessId: 'biz_1',
    status: 'approved',
    evidence: 'live',
    decidedAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  };
}

describe('canTransact', () => {
  it('allows an approved business verified by a third party', () => {
    const decision = canTransact(state());
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.evidence).toBe('live');
      expect(decision.decidedAt).toBe('2026-09-09T00:00:00.000Z');
    }
  });

  it('denies every status other than approved, with a reason for each', () => {
    const expected: Record<Exclude<KybStatus, 'approved'>, string> = {
      pending: 'KYB_PENDING',
      needs_review: 'KYB_NEEDS_REVIEW',
      rejected: 'KYB_REJECTED',
    };
    for (const [status, code] of Object.entries(expected)) {
      const decision = canTransact(state({ status }));
      expect(decision.allowed, status).toBe(false);
      if (!decision.allowed) {
        expect(decision.code).toBe(code);
        expect(decision.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('denies a business with no verification at all', () => {
    const decision = canTransact(null);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('KYB_NOT_STARTED');
  });

  it('denies a row whose verification was never started', () => {
    const decision = canTransact(state({ status: null, evidence: null, decidedAt: null }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('KYB_NOT_STARTED');
  });

  // The fail-closed tests. These are the ones that matter: every unknown value
  // must land on a denial, because the alternative is an unverified business
  // transacting because a string did not match any `case`.
  it('fails closed on a status this build does not understand', () => {
    for (const status of ['verified', 'ok', 'APPROVED', 'approved ', '', 'toString']) {
      const decision = canTransact(state({ status }));
      expect(decision.allowed, status).toBe(false);
      if (!decision.allowed) expect(decision.code).toBe('KYB_STATE_UNREADABLE');
    }
  });

  it('fails closed on an approved row whose evidence label is unreadable', () => {
    const decision = canTransact(state({ evidence: 'third-party' }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('KYB_STATE_UNREADABLE');
  });

  it('fails closed on an approved row with no evidence label at all', () => {
    const decision = canTransact(state({ evidence: null }));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('KYB_STATE_UNREADABLE');
  });

  it('allows simulated evidence by default, but says so in the decision', () => {
    const decision = canTransact(state({ evidence: 'simulated' }));
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.evidence).toBe('simulated');
  });

  it('denies simulated evidence when the deployment requires live', () => {
    const decision = canTransact(state({ evidence: 'simulated' }), { requireLiveEvidence: true });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.code).toBe('KYB_EVIDENCE_SIMULATED');
  });

  it('still allows live evidence under the strict policy', () => {
    expect(canTransact(state(), { requireLiveEvidence: true }).allowed).toBe(true);
  });
});

describe('businessKybStateFromRow', () => {
  it('reads a v_business_kyb row without narrowing it', () => {
    expect(
      businessKybStateFromRow({
        business_id: 'biz_1',
        kyb_status: 'approved',
        kyb_evidence: 'live',
        decided_at: new Date('2026-09-09T00:00:00.000Z'),
      }),
    ).toEqual({
      businessId: 'biz_1',
      status: 'approved',
      evidence: 'live',
      decidedAt: '2026-09-09T00:00:00.000Z',
    });
  });

  it('passes an unrecognised column value through as-is, for the gate to refuse', () => {
    const state = businessKybStateFromRow({ business_id: 'biz_1', kyb_status: 'verified' });
    expect(state.status).toBe('verified');
    expect(state.evidence).toBeNull();
    expect(canTransact(state).allowed).toBe(false);
  });

  it('survives a row with nothing in it', () => {
    const state = businessKybStateFromRow({});
    expect(state).toEqual({ businessId: '', status: null, evidence: null, decidedAt: null });
    expect(canTransact(state).allowed).toBe(false);
  });
});

describe('assertCanTransact', () => {
  it('returns the decision when allowed', () => {
    expect(assertCanTransact(state()).status).toBe('approved');
  });

  it('throws a KybGateError carrying the whole decision', () => {
    try {
      assertCanTransact(state({ status: 'rejected' }));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(KybGateError);
      const gate = error as KybGateError;
      expect(gate.decision.code).toBe('KYB_REJECTED');
      expect(gate.message).toContain('KYB_REJECTED');
    }
  });
});
