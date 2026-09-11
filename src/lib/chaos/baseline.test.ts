/**
 * The baseline comparison, made to fail on purpose.
 *
 * A guard nobody has seen fail is a claim, and this one replaced an assertion
 * that could not pass with an assertion that must not silently always pass.
 * The four cases below are the four ways that could happen:
 *
 *   1. a view GROWS                 -> reported. This is the assertion.
 *   2. a view is unchanged          -> silent, even at 212 rows. This is why
 *                                      the suite can run on this book at all.
 *   3. a view SHRINKS               -> silent, and the baseline follows it down
 *                                      so the headroom cannot be spent later.
 *   4. a view cannot be READ        -> never a pass, on its own channel, with
 *                                      no baseline value able to excuse it.
 *
 * No database and no clock: `baseline.ts` has no imports, which is the reason
 * these run in CI alongside `plan.test.ts` and `sign.test.ts` while the live
 * suite they serve needs `LIVEFIRE=1` and Neon.
 */

import { describe, expect, it } from 'vitest';

import {
  captureBaseline,
  describeBaseline,
  describeGrowth,
  growth,
  ratchet,
  unreadable as unreadableViews,
  type InvariantRowCount,
} from './baseline';

/** A reading, spelled the way `readInvariants()` spells one. */
function reading(view: string, rows: number, error: string | null = null): InvariantRowCount {
  return { view, claim: `${view} claims something`, rows, error };
}

/**
 * The four standing populations, as they actually stood.
 *
 * The numbers are the ones `node scripts/dbcheck.mjs` printed while this was
 * being written — 37 passed, 4 failed — and they are here as a FIXTURE of the
 * shape, not as an expectation about the live book. The live suite captures
 * its own; see `baseline.ts`'s header for why a literal would be a second lie.
 */
const AS_FOUND: readonly InvariantRowCount[] = [
  reading('v_entry_unbalanced', 0),
  reading('v_book_not_zero', 0),
  reading('v_refused_auth_hold', 235),
  reading('v_hold_expiry_drift', 12),
  reading('v_advice_delta_unsound', 1),
  reading('v_hold_closure_unexplained', 4),
];

describe('the known population', () => {
  it('captures the four standing findings WITHOUT calling them clean', () => {
    const captured = captureBaseline(AS_FOUND, new Date('2026-09-11T05:00:00Z'));

    expect(captured.standing.map((s) => s.view)).toEqual([
      'v_refused_auth_hold',
      'v_hold_expiry_drift',
      'v_advice_delta_unsound',
      'v_hold_closure_unexplained',
    ]);
    expect(captured.standingRows).toBe(252);
    // The baseline holds every readable view, empty ones included, because a
    // view at zero growing to one is exactly the delta this exists to catch.
    expect(captured.baseline.size).toBe(6);
    expect(captured.baseline.get('v_entry_unbalanced')).toBe(0);
    expect(captured.baseline.get('v_refused_auth_hold')).toBe(235);
  });

  it('says nothing while the standing population stands still', () => {
    // THE CASE THE OLD ASSERTION COULD NOT EXPRESS. Four accepted findings,
    // 252 rows, and chaos changed none of them: that is a PASS.
    const { baseline } = captureBaseline(AS_FOUND);
    expect(growth(baseline, AS_FOUND)).toEqual([]);
  });

  it('reports a view that GREW, in the delta form dbcheck --prove uses', () => {
    const { baseline } = captureBaseline(AS_FOUND);
    const after = AS_FOUND.map((r) =>
      r.view === 'v_refused_auth_hold' ? reading(r.view, 236) : r,
    );

    const grew = growth(baseline, after);
    expect(grew).toHaveLength(1);
    expect(grew[0]).toMatchObject({ view: 'v_refused_auth_hold', known: 235, now: 236, grew: 1 });
    expect(describeGrowth(grew[0]!)).toContain('v_refused_auth_hold: 235 -> 236 (+1)');
  });

  it('reports a view that went from EMPTY to one row — the interesting failure', () => {
    // This is the one that would mean chaos corrupted the book: a guard that
    // was clean before it was armed and is not clean after.
    const { baseline } = captureBaseline(AS_FOUND);
    const after = AS_FOUND.map((r) => (r.view === 'v_entry_unbalanced' ? reading(r.view, 1) : r));

    const grew = growth(baseline, after);
    expect(grew).toHaveLength(1);
    expect(describeGrowth(grew[0]!)).toContain('v_entry_unbalanced: 0 -> 1 (+1)');
  });

  it('counts a view with NO baseline entry from zero, not from nowhere', () => {
    const { baseline } = captureBaseline(AS_FOUND);
    const grew = growth(baseline, [...AS_FOUND, reading('v_added_by_another_branch', 3)]);
    expect(grew).toHaveLength(1);
    expect(describeGrowth(grew[0]!)).toContain('v_added_by_another_branch: 0 -> 3 (+3)');
  });

  it('does not treat a repair as a violation, and takes the repair as the new floor', () => {
    const { baseline } = captureBaseline(AS_FOUND);
    const repairedTo4 = AS_FOUND.map((r) =>
      r.view === 'v_refused_auth_hold' ? reading(r.view, 4) : r,
    );

    expect(growth(baseline, repairedTo4)).toEqual([]);
    expect(ratchet(baseline, repairedTo4)).toEqual(['v_refused_auth_hold: 235 -> 4']);
    expect(baseline.get('v_refused_auth_hold')).toBe(4);

    // AND THE HEADROOM IS GONE. Without the ratchet, a view repaired from 235
    // to 4 could climb all the way back to 235 with nothing firing.
    const backTo235 = growth(baseline, AS_FOUND);
    expect(backTo235).toHaveLength(1);
    expect(describeGrowth(backTo235[0]!)).toContain('v_refused_auth_hold: 4 -> 235 (+231)');
  });

  it('never moves the baseline UP, because that direction is the failure', () => {
    const { baseline } = captureBaseline(AS_FOUND);
    const worse = AS_FOUND.map((r) =>
      r.view === 'v_advice_delta_unsound' ? reading(r.view, 900) : r,
    );
    expect(ratchet(baseline, worse)).toEqual([]);
    expect(baseline.get('v_advice_delta_unsound')).toBe(1);
    // Still reported, on the next read as on this one.
    expect(growth(baseline, worse)).toHaveLength(1);
  });
});

describe('an invariant nobody could read', () => {
  const BROKEN: readonly InvariantRowCount[] = [
    reading('v_entry_unbalanced', 0),
    reading('v_book_not_zero', -1, 'permission denied for view v_book_not_zero'),
  ];

  it('is not given a baseline entry, because there is no population to know', () => {
    const captured = captureBaseline(BROKEN);
    expect(captured.baseline.has('v_book_not_zero')).toBe(false);
    expect(captured.unreadable.map((u) => u.view)).toEqual(['v_book_not_zero']);
  });

  it('is NEVER a pass, and never reaches the delta channel to be excused by one', () => {
    const { baseline } = captureBaseline(AS_FOUND);
    // It carries rows: -1, which would read as a DECREASE against any
    // baseline — the exact way an unreadable guard turns into a silent pass.
    // It is filtered out of the delta channel and reported on its own.
    expect(growth(baseline, BROKEN)).toEqual([]);
    expect(ratchet(baseline, BROKEN)).toEqual([]);

    const captured = captureBaseline(BROKEN);
    expect(captured.unreadable).toHaveLength(1);

    // Its own channel, carrying the driver's message rather than a row count.
    const named = unreadableViews(BROKEN);
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('v_book_not_zero: permission denied for view');
  });
});

describe('what the run prints', () => {
  it('names every standing population in cents-free plain rows, so nobody opens psql', () => {
    const captured = captureBaseline(AS_FOUND, new Date('2026-09-11T05:00:00Z'));
    const text = describeBaseline(captured, AS_FOUND.length);

    expect(text).toContain('6 invariant view(s) read at 2026-09-11T05:00:00.000Z');
    expect(text).toContain('2 empty, 4 carrying a standing population (252 row(s)), 0 unreadable');
    expect(text).toContain('v_refused_auth_hold = 235 row(s)');
    // The sentence that keeps a screenshot of this output honest.
    expect(text).toContain('NO VIEW GROWS');
    expect(text).toContain('not a claim that it is spotless');
  });
});
