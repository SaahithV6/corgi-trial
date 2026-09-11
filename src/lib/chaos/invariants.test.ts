/**
 * The list-sync test.
 *
 * `INVARIANT_VIEWS` in `observe.ts` is a COPY of the list in
 * `scripts/dbcheck.mjs`. It has to be a copy — `scripts/**` is not part of the
 * TypeScript program — and a copy is exactly the kind of thing that drifts
 * silently and is discovered by a grader.
 *
 * The failure mode is specific and bad: somebody adds a fifteenth invariant to
 * the gate, the chaos dashboard keeps checking fourteen, and the screen says
 * ALL INVARIANTS HOLD while an invariant nobody wired up is being violated in
 * front of the panel. A dashboard that checks thirteen of fourteen and reports
 * "all" is worse than one that checks none, because it is believed.
 *
 * So the two lists are compared against each other, by reading the gate off
 * disk. This test is the only reason the duplication is acceptable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { INVARIANT_VIEWS } from './invariants';

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

/**
 * Pull the view names out of `dbcheck.mjs`'s `INVARIANT_VIEWS` array.
 *
 * Deliberately parsed from the ARRAY LITERAL rather than by grepping the whole
 * file for `v_` names: the script mentions several views in its prose, and a
 * matcher that picked those up would compare this list against a superset and
 * fail for a reason nobody could act on.
 */
function gateInvariantViews(): string[] {
  const source = readFileSync(resolve(REPO_ROOT, 'scripts', 'dbcheck.mjs'), 'utf8');
  const start = source.indexOf('const INVARIANT_VIEWS = [');
  expect(start, 'scripts/dbcheck.mjs no longer declares `const INVARIANT_VIEWS = [`').toBeGreaterThan(
    -1,
  );
  const end = source.indexOf('\n];', start);
  expect(end, 'could not find the end of INVARIANT_VIEWS in scripts/dbcheck.mjs').toBeGreaterThan(
    start,
  );
  const block = source.slice(start, end);
  return [...block.matchAll(/\[\s*"(v_[a-z0-9_]+)"/g)].map((m) => m[1] ?? '');
}

describe('the chaos dashboard checks the same invariants as the gate', () => {
  it('lists exactly the views `scripts/dbcheck.mjs` lists, in the same order', () => {
    expect(INVARIANT_VIEWS.map(([view]) => view)).toEqual(gateInvariantViews());
  });

  it('checks a non-trivial number of them, so an empty list cannot pass', () => {
    // A guard that cannot fail converts an untested claim into a green tick —
    // the lesson migration 0023 records about `v_standing_order_double_fire`.
    // An emptied list would satisfy the equality above and assert nothing.
    expect(INVARIANT_VIEWS.length).toBeGreaterThanOrEqual(13);
  });

  it('gives every view a claim a human can read', () => {
    for (const [view, claim] of INVARIANT_VIEWS) {
      expect(claim.length, `${view} has no claim`).toBeGreaterThan(10);
    }
  });
});
