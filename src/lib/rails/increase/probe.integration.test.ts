/**
 * The Increase ACH probe, earned here — and the rule that keeps the other four
 * cells from claiming more than their evidence says.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SUITE TALKS TO THE REAL INCREASE SANDBOX. It reads, and only reads: │
 * │ two authenticated GETs, no POST, no transfer, no money. It is gated on   │
 * │ RUN_LIVE_PROBES=1 AND on INCREASE_API_KEY being present, so CI — which   │
 * │ holds neither — skips rather than fails. Run it with:                    │
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_LIVE_PROBES=1 pnpm vitest run \          │
 * │     src/lib/rails/increase/probe.integration.test.ts                     │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THIS FILE EXISTS. `INCREASE_SUPPORT.probe` in ../adapters/ach.ts declares
 * `measured`, and `measured` is a claim about a call somebody made. A claim
 * whose only evidence is a paragraph decays the moment the key is rotated or
 * the account is closed. This is that call, in the repo, runnable by anyone
 * holding the credential — so the matrix cell can be re-earned in eight seconds
 * instead of believed. (When this file was written it was the only `measured`
 * cell in the Increase row; all five say it now, which is the subject of the
 * second box below.)
 *
 * WHAT IT DOES NOT EARN, AND THE DISTINCTION IS THE WHOLE POINT. Reading
 * `/accounts` proves the credential authenticates and the host answers; it
 * proves nothing whatsoever about whether `POST /ach_transfers` maps our
 * `TransferRequest` correctly, whether the settlement promotion fires, or
 * whether an R01 arrives shaped the way `research/ach/NOTES.md` guessed. A
 * probe that was allowed to promote its neighbours would be liveness by
 * presence wearing a round trip as a disguise.
 *
 * THOSE FOUR HAVE SINCE BEEN EARNED ELSEWHERE, AND NOT BY THIS FILE. The whole
 * ACH lifecycle ran against the sandbox — `originate`, `settle` and `reverse`
 * on `sandbox_ach_transfer_x5vdo5m7b6k924sszlms`, and `observe` in
 * ./observe.integration.test.ts against the stored verified bytes. docs/RAILS.md
 * §3 carries the ids, the two ledger entries and the re-run commands.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THE TRIPWIRE FIRED INTO AN EMPTY ROOM, AND THIS IS WHAT REPLACED IT.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The last case in this file used to pin all four of `originate`, `observe`,
 * `settle` and `reverse` to `proof: 'unexercised'`, and the header above it
 * said — correctly — that it existed to go red "the moment somebody makes the
 * declaration true". Somebody did: `INCREASE_SUPPORT` in ../adapters/ach.ts now
 * declares all five `measured`, each with an evidence string naming the call
 * and the sandbox object it produced. Nothing had ever RUN this suite, so the
 * tripwire fired into an empty room and the stale assertion sat green-by-skip
 * for hours.
 *
 * PINNING `measured` INSTEAD WOULD BE THE SAME MISTAKE IN A MIRROR. It would go
 * red the day somebody legitimately DEMOTES a cell — a key rotated, an endpoint
 * withdrawn, a sandbox object garbage-collected — which is precisely the
 * correction the honesty table exists to make easy. A test that punishes a
 * truthful downgrade is a test that argues for leaving a false `measured` in
 * place, and "a table that claims more than was proven is a failed submission"
 * is the rule this whole file serves.
 *
 * SO THE TWO INVARIANTS PINNED BELOW ARE THE ONES THAT DO NOT MOVE:
 *
 *   1. THE `probe` CELL, because THIS FILE IS ITS EVIDENCE. It is pinned to
 *      `measured` and its evidence string is pinned to the detail of the round
 *      trip made three lines earlier — so the cell cannot be demoted while this
 *      test is getting a 200, and cannot be reworded away from the call it
 *      names. The other four are pinned to nothing, deliberately.
 *
 *   2. NO CELL CLAIMS MORE THAN ITS EVIDENCE STRING SUPPORTS. `measured` has to
 *      name something a reader can go and check — a `sandbox_…` object id, an
 *      HTTP call, or the gated integration suite that makes it — because being
 *      checkable by somebody else is the only property that separates a
 *      measurement from an intention. `unexercised` has to name none of the
 *      three, so a cell cannot be quietly downgraded while keeping the boast.
 *      That rule is indifferent to WHICH word each cell holds, which is exactly
 *      why a legitimate demotion passes it and a hollow promotion does not.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT RE-ASSERT: that the declaration and
 * docs/RAILS.md §3 agree. `../contract.test.ts` already regenerates that table
 * from the adapters and compares it to the committed file character for
 * character. Two tests asserting one fact is two places to update and one place
 * to forget, so this one asserts only that the pointer is live — that §3 still
 * carries the generated-by marker and has not become a hand-written table with
 * extra steps.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { increaseAchAdapter } from '../adapters/ach';
import { RAIL_OPERATIONS } from '../contract';
import { IncreaseAchRail, INCREASE_SANDBOX_BASE_URL } from './client';

const KEY = process.env['INCREASE_API_KEY'] ?? '';
const RUN = process.env['RUN_LIVE_PROBES'] === '1' && KEY !== '';

const suite = RUN ? describe : describe.skip;

/**
 * A RE-EARNING HANDLE: something a reader can go and check.
 *
 * Three shapes, and they are the three the Increase row's cells actually carry:
 *   - an id the provider minted (`sandbox_ach_transfer_…`);
 *   - the method and path that were sent to it (`POST /ach_transfers`);
 *   - the gated integration suite that makes the call (`*.integration.test.ts`).
 *
 * The third is not a loophole, it is the case `observe` is: that operation never
 * calls Increase, it reads the EXACT signed bytes of deliveries Increase sent,
 * out of `webhook_inbox`. Its artefact is a suite that can replay them, not a
 * request id. What all three have in common is the only property that separates
 * `measured` from `unexercised` — somebody else can check it — which is this
 * file's own stated reason for existing.
 *
 * At module scope so the guard itself can be made to fail on purpose without a
 * credential: see the last describe in this file.
 */
export function namesAReEarningHandle(text: string): boolean {
  return (
    /sandbox_[a-z0-9_]+/i.test(text) ||
    /\b(?:GET|POST|PATCH|DELETE) \//.test(text) ||
    /\.integration\.test\.ts/.test(text)
  );
}

suite('the Increase ACH probe, against Increase', () => {
  const adapter = (): ReturnType<typeof increaseAchAdapter> =>
    increaseAchAdapter({
      rail: new IncreaseAchRail({}),
      env: { INCREASE_API_KEY: KEY, INCREASE_BASE_URL: INCREASE_SANDBOX_BASE_URL },
    });

  it('earns `live` from a real authenticated round trip, and names the call', async () => {
    const probe = await adapter().probe({ timeoutMs: 15_000 });

    expect(probe.liveness).toBe('live');
    // Both halves. A real provider AND a successful call.
    expect(probe.label).toBe('LIVE');
    expect(probe.evidence).toBe('live');
    expect(probe.provider).toBe('increase.ach');
    // The detail is the evidence, so it must name the call, not summarise it.
    expect(probe.detail).toBe('GET /accounts?limit=1 -> 200');
    expect(probe.ms).toBeGreaterThan(0);
    expect(Date.parse(probe.checkedAt)).not.toBeNaN();
  });

  it('is refused, not believed, when the credential is wrong', async () => {
    // The placeholder case, run for real: a well-formed key Increase has never
    // issued. It is non-empty, so every presence check in the repo would have
    // called it LIVE. Increase answers 401 and the verdict is `unauthorised`.
    const bogus = increaseAchAdapter({
      rail: new IncreaseAchRail({}),
      env: {
        INCREASE_API_KEY: 'not_a_real_increase_key_0000000000',
        INCREASE_BASE_URL: INCREASE_SANDBOX_BASE_URL,
      },
    });
    const probe = await bogus.probe({ timeoutMs: 15_000 });

    expect(probe.liveness).toBe('unauthorised');
    expect(probe.label).toBe('SIMULATED');
  });

  it('pins the `probe` cell to the round trip this file just made', async () => {
    // The cell this suite IS the evidence for, and the only one it pins. A
    // demotion of `probe` while this test is getting a 200 would be a false
    // downgrade, so pinning it here is not the mirror mistake — it is the cell
    // being re-earned on every run.
    const live = await adapter().probe({ timeoutMs: 15_000 });
    expect(live.liveness).toBe('live');

    const supports = adapter().supports;
    expect(supports.probe).toMatchObject({ supported: true, proof: 'measured' });
    if (supports.probe.supported !== true) throw new Error('unreachable');

    // AND THE EVIDENCE NAMES THE CALL THAT WAS JUST MADE. Not a paraphrase of
    // it: the adapter's own `detail` string, verbatim, inside the declaration.
    // A cell whose evidence has drifted from the call it cites is a cell whose
    // claim nobody can re-earn in eight seconds, which is the whole point.
    expect(supports.probe.evidence).toContain(live.detail);
    expect(supports.probe.evidence).toContain('probe.integration.test.ts');
  });

  it('lets no cell claim more than its evidence string supports', () => {
    const supports = adapter().supports;

    for (const op of RAIL_OPERATIONS) {
      const cell = supports[op];
      if (cell.supported !== true) {
        // An unsupported operation owes a reason in domain terms, never a TODO.
        expect(cell.reason.length, `${op}: an unsupported cell must say why`).toBeGreaterThan(20);
        expect(cell.reason.toLowerCase(), op).not.toContain('todo');
        continue;
      }

      expect(cell.evidence.length, `${op}: a supported cell must carry evidence`).toBeGreaterThan(20);
      expect(cell.evidence.toLowerCase(), op).not.toContain('todo');

      if (cell.proof === 'measured') {
        // THE ASSERTION THAT MATTERS. `measured` means somebody called the
        // provider, so the sentence has to carry something only the provider
        // could have produced. A `measured` whose evidence is a paragraph of
        // intent is the failure this rule exists for.
        expect(
          namesAReEarningHandle(cell.evidence),
          `${op} is declared 'measured' and its evidence names nothing anybody can go and ` +
            `check — no sandbox_ object id, no HTTP call, no integration suite. Either the ` +
            `call was made and the evidence should name it, or the cell is claiming more ` +
            `than was proven: "${cell.evidence}"`,
        ).toBe(true);
      }

      if (cell.proof === 'unexercised') {
        // THE OTHER DIRECTION, AND IT IS THE ONE THIS FILE GOT WRONG BEFORE. A
        // cell demoted to `unexercised` must lose the boast with the word: an
        // `unexercised` still citing a sandbox object is a stale declaration,
        // and a stale declaration is what the old assertion here was.
        expect(
          namesAReEarningHandle(cell.evidence),
          `${op} is declared 'unexercised' but its evidence still cites a provider ` +
            `artefact or a suite that would re-earn it, so one half of the cell has been ` +
            `updated and the other has not: "${cell.evidence}"`,
        ).toBe(false);
      }

      if (cell.proof === 'simulated') {
        // Exercised against OUR simulator. It must say so, and it must not
        // borrow the sandbox's credibility to do it.
        expect(cell.evidence.toLowerCase(), op).toMatch(/simulat/);
        expect(/sandbox_[a-z0-9_]+/i.test(cell.evidence), op).toBe(false);
      }
    }
  });

  it('leaves docs/RAILS.md §3 to contract.test.ts, and checks the pointer is live', () => {
    // NOT a second copy of the drift assertion — ../contract.test.ts already
    // regenerates the table and compares it character for character. What is
    // asserted here is only that §3 is still GENERATED: a table that quietly
    // became hand-written would keep passing a comparison nobody regenerates.
    const doc = readFileSync('docs/RAILS.md', 'utf8');
    expect(doc).toContain('<!-- generated by renderRailCapabilityMatrix(); see contract.test.ts -->');
  });
});

/* -------------------------------------------------------------------------- */
/* The guard, made to fail on purpose — and this half needs no credential      */
/* -------------------------------------------------------------------------- */

/**
 * A guard nobody has seen fail is a claim, and this file is the one that just
 * learned what that costs: its old assertion could not fail because nothing ran
 * it. So the predicate the new one stands on is exercised UNGATED, in CI, where
 * a missing `INCREASE_API_KEY` cannot skip it into silence.
 */
describe('what counts as evidence', () => {
  it('accepts the three shapes a real measurement leaves behind', () => {
    // The provider minted it.
    expect(namesAReEarningHandle('POST /ach_transfers -> sandbox_ach_transfer_x5vdo')).toBe(true);
    // We sent it.
    expect(namesAReEarningHandle('GET /accounts?limit=1 -> 200 against sandbox.increase.com')).toBe(true);
    // Somebody can replay it.
    expect(namesAReEarningHandle('parseEvent over 5 real deliveries. increase/observe.integration.test.ts.')).toBe(true);
  });

  it('REFUSES a sentence that only describes an intention', () => {
    // Every one of these is a plausible evidence string and none of them can be
    // checked by anybody. A `measured` cell holding one is a cell claiming more
    // than was proven, which is the automatic-fail side of this trial's line.
    for (const hollow of [
      'the wire shape is taken from the published API documentation',
      'implemented and reviewed; should work against the sandbox',
      'handled, untested',
      'the same branch the ACH consumer takes, so it is covered',
      'covered by unit tests in adapters/ach.test.ts',
    ]) {
      expect(namesAReEarningHandle(hollow), hollow).toBe(false);
    }
  });
});
