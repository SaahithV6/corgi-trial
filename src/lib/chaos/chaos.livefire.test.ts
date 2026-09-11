/**
 * CHAOS MODE, DRIVEN AGAINST THE LIVE SYSTEM.
 *
 * One test per control, plus the park/drain frame, plus the bound. Every
 * assertion is read back out of the live Neon database; nothing here mocks the
 * pipeline it is testing.
 *
 * ============================================================================
 * WHAT EACH TEST IS ENTITLED TO CLAIM
 *
 * This suite runs against a database shared with eleven other branches, and a
 * concurrent run of the integration suite has already been measured moving a
 * seeded business's ledger by 67,899 cents inside one 20-second window
 * (attack-07's header records it). So the claims are split the same way that
 * attack does it:
 *
 *   BY ATTRIBUTION — always asserted. "The deliveries chaos originated for
 *   THIS run reached these states." Nothing else writing to this database can
 *   satisfy those on our behalf or break them.
 *
 *   BY FREEZE — asserted only when the window really was quiet. "The
 *   customer's whole position did not move." Its absence is REPORTED rather
 *   than asserted away, because a suite that reports another process's writes
 *   as chaos corrupting the book is worse than one that says which it could
 *   not tell apart.
 *
 * ============================================================================
 * THE INVARIANTS ARE CHECKED AGAINST A BASELINE, NOT AGAINST ZERO
 *
 * This suite used to demand that EVERY invariant view be empty at every step,
 * and called that "the invariants held throughout". Four of them are not empty
 * and are not going to be: `v_refused_auth_hold`, `v_hold_expiry_drift`,
 * `v_advice_delta_unsound` and `v_hold_closure_unexplained` each carry a
 * standing, measured, deliberately unrepairable population — which is why
 * `node scripts/dbcheck.mjs` reads 37 passed / 4 FAILED and why those four are
 * accepted findings rather than bugs.
 *
 * So every case here failed on that one helper, 6 of 6, and would have failed
 * identically whether chaos corrupted the book or left it untouched. A test
 * that is red in both worlds distinguishes nothing, and this one was not
 * measuring chaos at all: it was measuring a fact about the book that was
 * already true before anything was armed.
 *
 * WHAT IS ASSERTED NOW: **chaos introduced no NEW violation.** The population
 * is captured from the live database in `beforeAll`, before a single control
 * is armed, and every later reading is compared against it — the same shape
 * `dbcheck --prove` uses, which counts a view, perturbs the book and asserts
 * the DELTA rather than demanding emptiness it knows it will not get. The
 * comparison itself is a pure function in `./baseline.ts`, and
 * `baseline.test.ts` makes it fail on purpose four ways, because the mirror of
 * a suite that cannot pass is a suite that cannot fail.
 *
 * FOUR THINGS THAT DID NOT GET WEAKER:
 *   - an UNREADABLE view is still never a pass, on its own channel, and no
 *     baseline value can excuse one;
 *   - a view that was EMPTY at capture is still held at empty, so the guards
 *     that matter to chaos — the balanced-entry, hold-drift and availability
 *     ones — are asserted exactly as hard as before;
 *   - a repaired view RATCHETS the baseline down, so a repair cannot be spent
 *     later as headroom to climb back into;
 *   - growth this suite cannot EXONERATE is a failure, not a shrug. See below.
 *
 * ── AND GROWTH IS ATTRIBUTED BEFORE IT IS BLAMED ──────────────────────────
 *
 * Eleven branches write to this database. `v_refused_auth_hold` was measured
 * climbing 251 -> 252 -> 255 across one 60-second run of this suite while
 * chaos's own rows accounted for NONE of it: the new rows are `auth-<epoch>`
 * fixtures from the holds integration suite, and chaos posts its authorisation
 * with `result: 'APPROVED'` so it cannot enter that view at all. Asserting the
 * raw delta would have swapped one suite that always fails for another that
 * fails whenever somebody else is working.
 *
 * So a grown view is a FAILURE unless this run can PROVE the new rows are not
 * its own, and there is exactly one way to prove it: the view exposes
 * `provider_auth_id` and none of its rows carry an authorisation token this
 * run originated. Every card-hold invariant does expose it — which is why
 * `dbcheck.mjs`'s `explain()` can select it from all three of the standing
 * card findings. A view that grew and CANNOT be attributed that way fails,
 * including every view with no `provider_auth_id` column at all: unknown is
 * never a pass, and that is the safe direction because chaos's whole risk
 * surface (a double-counted duplicate, a hold released twice, an unbalanced
 * entry) lands in exactly those views.
 *
 * Exonerated growth is REPORTED with the view and the delta, and the baseline
 * is re-taken at the new number so the same rows are not reported again.
 *
 * The baseline is read from the book, never written into this file. The four
 * populations move as other branches write, and a literal 212 here would be a
 * second lie with a shorter half-life than the first.
 * ============================================================================
 *
 * SKIPPED, LOUDLY, WITHOUT `LIVEFIRE=1`. A test that silently passes when it
 * could not run is the failure mode this repository keeps finding in its own
 * guards, so the skip names what is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Sql } from '@/lib/ledger/db';

import {
  captureBaseline,
  describeBaseline,
  describeGrowth,
  growth,
  ratchet,
  unreadable,
  type CapturedBaseline,
  type InvariantBaseline,
} from './baseline';
import type * as ChaosModule from './index';

const MISSING: string[] = [];
if (process.env['LIVEFIRE'] !== '1') MISSING.push('LIVEFIRE=1');
if (typeof process.env['APP_DATABASE_URL'] !== 'string' || process.env['APP_DATABASE_URL'] === '') {
  MISSING.push('APP_DATABASE_URL');
}

const READY = MISSING.length === 0;
const d = READY ? describe : describe.skip;

const ACTOR = 'chaos livefire suite';

d('chaos mode against the live system', () => {
  let sql: Sql;
  let chaos: typeof ChaosModule;

  /** The book as chaos found it. Captured once, before anything is armed. */
  let captured: CapturedBaseline;
  let baseline: InvariantBaseline;
  let viewCount = 0;

  /**
   * Every authorisation token THIS suite originated, across every run it
   * starts. The only thing that can put a chaos row into a card-hold invariant
   * view, and therefore the only thing that can convict chaos of growing one.
   */
  const ourAuthTokens: string[] = [];

  /** The invariant views that carry a `provider_auth_id`, i.e. the attributable ones. */
  let attributable: Set<string>;

  beforeAll(async () => {
    ({ sql } = await import('@/lib/ledger/db'));
    chaos = await import('./index');
    // Start from a known state: nothing armed.
    await chaos.disarmAll(ACTOR);

    // THE KNOWN POPULATION. Read from the live database, before the first
    // control is armed, so everything asserted afterwards is a statement about
    // what chaos did and not about what it walked in on.
    const readings = await chaos.readInvariants();
    viewCount = readings.length;
    captured = captureBaseline(readings);
    baseline = captured.baseline;
    // eslint-disable-next-line no-console
    console.log(describeBaseline(captured, viewCount));

    // Which views can be ASKED whose rows they are. Read from the catalogue
    // rather than listed here, so a view that gains or loses the column moves
    // itself in and out of the attributable set instead of drifting against a
    // hand-kept list — the same failure `invariants.test.ts` exists to catch.
    const withAuthId = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name = 'provider_auth_id'
         AND table_name = ANY(${readings.map((r) => r.view)})`;
    attributable = new Set(withAuthId.map((r) => r.table_name));
  });

  /**
   * How many rows of `view` belong to an authorisation THIS run originated.
   *
   * `null` means the question cannot be asked of this view at all, which is
   * treated as guilt rather than innocence.
   */
  async function rowsOfThisRunIn(view: string): Promise<number | null> {
    if (!attributable.has(view)) return null;
    const rows = await sql.unsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ${view} WHERE provider_auth_id = ANY($1)`,
      [ourAuthTokens],
    );
    return rows[0]?.n ?? 0;
  }

  /** `startChaosRun`, with the run's authorisation token recorded for attribution. */
  async function startRun(
    opts: Parameters<typeof ChaosModule.startChaosRun>[0],
  ): Promise<Awaited<ReturnType<typeof ChaosModule.startChaosRun>>> {
    const run = await chaos.startChaosRun(opts);
    ourAuthTokens.push(run.transactionToken);
    return run;
  }

  afterAll(async () => {
    // THE SUITE CANNOT LEAVE CHAOS ON. Even if a test throws halfway through.
    await chaos.disarmAll(ACTOR);
    const state = await chaos.readChaosState();
    expect(state.on).toBe(false);
  });

  /**
   * CHAOS INTRODUCED NO NEW VIOLATION — the claim, against the baseline.
   *
   * Not "the book is spotless". Four views carry an accepted, unrepairable
   * population and demanding zero of them made this suite unable to pass under
   * any behaviour of the system it tests. What is asserted is the DELTA: no
   * view returns more rows than it did before chaos was armed, and a view that
   * was empty then is empty now.
   *
   * An unreadable view is asserted separately and is never a pass, because an
   * unreadable invariant and a satisfied one are indistinguishable to anything
   * that treats an exception as a zero.
   */
  async function noNewViolations(when: string): Promise<void> {
    const readings = await chaos.readInvariants();

    // The list itself has to still be there. A helper that read nothing would
    // report no growth, for ever.
    expect(readings.length, 'the invariant list shrank mid-run').toBeGreaterThanOrEqual(
      Math.max(13, viewCount),
    );

    expect(unreadable(readings), `an invariant could not be READ ${when}`).toEqual([]);

    const grew = growth(baseline, readings);
    const ours: string[] = [];
    const elsewhere: string[] = [];

    for (const g of grew) {
      const mine = await rowsOfThisRunIn(g.view);
      if (mine === null) {
        ours.push(
          `${describeGrowth(g)} [NOT ATTRIBUTABLE: this view exposes no provider_auth_id, so ` +
            `this run cannot prove the new rows are not its own — and unknown is never a pass]`,
        );
      } else if (mine > 0) {
        ours.push(
          `${describeGrowth(g)} [${String(mine)} row(s) carry an authorisation THIS RUN ` +
            `originated: ${ourAuthTokens.join(', ')}]`,
        );
      } else {
        elsewhere.push(describeGrowth(g));
      }
    }

    // THE ASSERTION. Not "the book is spotless" — "chaos put nothing new on it".
    expect(
      ours,
      `chaos introduced a NEW invariant violation ${when}. Each line is ` +
        'view: known -> now, against the population this run captured before arming ' +
        'anything; see the [chaos baseline] block above.',
    ).toEqual([]);

    // Somebody else's writes. Named, with the delta, and re-baselined at the
    // new number — reported rather than asserted away, and never silently
    // folded into the claim chaos is making.
    if (elsewhere.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[chaos baseline] grew ${when}, and NOT from this run's rows — another branch is ` +
          `writing to this database. Re-baselined: ${elsewhere.join(' | ')}`,
      );
      for (const g of grew) {
        if (elsewhere.includes(describeGrowth(g))) baseline.set(g.view, g.now);
      }
    }

    // Somebody repaired a standing finding while this ran: take the repair as
    // the new floor, so it cannot be spent later as room to climb back into.
    const repaired = ratchet(baseline, readings);
    if (repaired.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[chaos baseline] repaired while the suite ran, baseline lowered: ${repaired.join(', ')}`);
    }
  }

  async function inboxStateOf(webhookId: string): Promise<string | null> {
    const rows = await sql<{ state: string }[]>`
      SELECT state::text AS state FROM webhook_inbox
       WHERE provider = 'lithic' AND provider_event_id = ${webhookId}`;
    return rows[0]?.state ?? null;
  }

  // -------------------------------------------------------------------------

  it('starts from a KNOWN population, not from a clean one', async () => {
    // The baseline exists and covers the whole list. A baseline that failed to
    // capture would make every later delta vacuously green, which is the same
    // hole as demanding zero, inverted.
    expect(viewCount).toBeGreaterThanOrEqual(13);
    expect(baseline.size + captured.unreadable.length).toBe(viewCount);

    // AN UNREADABLE VIEW IS NEVER A PASS, and least of all at capture: it would
    // leave a guard with no known population for the rest of the run.
    expect(captured.unreadable.map((u) => `${u.view}: ${u.error ?? '?'}`)).toEqual([]);

    // This book is NOT spotless and the suite says so out loud. The standing
    // population is the accepted, unrepairable findings `dbcheck` prints as
    // 4 failed — they are the reason the old "every view is empty" assertion
    // could not pass under any behaviour of the system it was testing.
    // eslint-disable-next-line no-console
    console.log(
      `[chaos baseline] standing at rest: ${
        captured.standing.length === 0
          ? 'nothing — every view empty'
          : captured.standing.map((sv) => `${sv.view}=${String(sv.rows)}`).join(' ')
      }`,
    );

    // And, trivially but not pointlessly, the book has not moved against
    // itself between the capture and this line.
    await noNewViolations('at rest, before chaos was armed');
    const state = await chaos.readChaosState();
    expect(state.on).toBe(false);
  });

  it('DUPLICATE DELIVERY — copies are absorbed by the inbox, not by chaos', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({
      control: 'duplicate_delivery',
      seconds: 120,
      value: 3,
      actor: ACTOR,
    });

    const run = await startRun({ actor: ACTOR, registerCardFirst: true });
    const outbox = await chaos.readOutbox(run.runId);

    // Three copies of each of the two lifecycle steps.
    expect(outbox).toHaveLength(6);

    // THE DEMONSTRATION: one accepted per slot, the rest suppressed. Postgres
    // decided that, on UNIQUE (provider, provider_event_id). Chaos did not look
    // the id up first and has no code path that could produce this answer.
    const accepted = outbox.filter((d0) => d0.outcome === 'accepted');
    const replays = outbox.filter((d0) => d0.outcome === 'replay');
    expect(accepted).toHaveLength(2);
    expect(replays).toHaveLength(4);

    // Every copy of a slot carried the SAME id. That is what handed the
    // suppression to the database.
    const authIds = new Set(
      outbox.filter((d0) => d0.step === 'authorization').map((d0) => d0.webhookId),
    );
    expect(authIds.size).toBe(1);

    // And the inbox holds exactly one row per slot, not three.
    const [count] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM webhook_inbox
       WHERE provider = 'lithic'
         AND provider_event_id IN ${sql([...authIds])}`;
    expect(count?.n).toBe(1);

    await noNewViolations('while every delivery was being sent three times');
    await chaos.disarmAll(ACTOR);
  });

  it('REORDER — the settlement is delivered before the authorisation it belongs to', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({ control: 'reorder_window', seconds: 120, value: 1, actor: ACTOR });

    const run = await startRun({ actor: ACTOR, registerCardFirst: true });
    const outbox = await chaos.readOutbox(run.runId);

    // seq 0 leaves first, and seq 0 is the CLEARING.
    const first = outbox.find((d0) => d0.seq === 0);
    expect(first?.step).toBe('clearing');
    expect(outbox.find((d0) => d0.seq === 1)?.step).toBe('authorization');

    // The clearing went out immediately; the authorisation it overtook is held
    // to the far edge of the buffer and released on the next pass.
    expect(first?.outcome).toBe('accepted');

    await noNewViolations('with the settlement delivered ahead of its authorisation');

    // Turn the buffer off and let the overtaken authorisation catch up.
    await chaos.disarmAll(ACTOR);
    await new Promise((r) => setTimeout(r, 1_500));
    await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });

    const after = await chaos.readOutbox(run.runId);
    expect(after.every((d0) => d0.outcome !== 'withheld')).toBe(true);

    await noNewViolations('after the out-of-order pair had both landed');
  });

  it('SETTLEMENT DELAY — the clearing is late, the authorisation is not', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({
      control: 'settlement_delay',
      seconds: 120,
      value: 3,
      actor: ACTOR,
    });

    const run = await startRun({ actor: ACTOR, registerCardFirst: true });
    const immediately = await chaos.readOutbox(run.runId);

    const auth = immediately.find((d0) => d0.step === 'authorization');
    const clearing = immediately.find((d0) => d0.step === 'clearing');

    // The authorisation went. The clearing did not: it is scheduled, not failed.
    expect(auth?.outcome).toBe('accepted');
    expect(clearing?.outcome).toBe('withheld');
    expect(Date.parse(clearing?.plannedAt ?? '')).toBeGreaterThan(Date.parse(auth?.plannedAt ?? ''));

    await noNewViolations('with a settlement still outstanding');

    // Wait it out and release. Nobody had to turn anything off: a delay is a
    // delay, and it expires on its own schedule.
    await new Promise((r) => setTimeout(r, 3_500));
    await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });

    const later = await chaos.readOutbox(run.runId);
    expect(later.find((d0) => d0.step === 'clearing')?.outcome).toBe('accepted');

    await noNewViolations('after the late settlement landed');
    await chaos.disarmAll(ACTOR);
  });

  it('WEBHOOKS OFF — nothing leaves, nothing is lost, and it catches up', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({ control: 'webhooks_off', seconds: 120, actor: ACTOR });

    const run = await startRun({ actor: ACTOR, registerCardFirst: true });
    const dark = await chaos.readOutbox(run.runId);

    // EVERY delivery is withheld, and every one of them EXISTS. That is the
    // difference between an outage and a cancellation.
    expect(dark).toHaveLength(2);
    expect(dark.every((d0) => d0.outcome === 'withheld')).toBe(true);
    expect(dark.every((d0) => d0.releasedAt === null)).toBe(true);

    // NOTHING WAS INVENTED FROM AN EVENT NOBODY WAS TOLD ABOUT. Asserted by
    // attribution: these ids reached no inbox row at all.
    for (const delivery of dark) {
      expect(await inboxStateOf(delivery.webhookId)).toBeNull();
    }

    // A release attempt while the switch is on does nothing and says so.
    const refused = await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });
    expect(refused.released).toBe(0);
    expect(refused.webhooksOff).toBe(true);

    await noNewViolations('while the feed was dark');

    // THE FEED COMES BACK. Turning the switch off IS the provider returning:
    // no sweeper, no requeue, no state transition.
    await chaos.disarmAll(ACTOR);
    const caughtUp = await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });
    expect(caughtUp.released).toBe(2);
    expect(caughtUp.accepted).toBe(2);

    const after = await chaos.readOutbox(run.runId);
    expect(after.every((d0) => d0.outcome === 'accepted')).toBe(true);

    await noNewViolations('after the backlog caught up');
  });

  it('PARKS — the system refuses to guess whose money to move, then drains', async () => {
    await chaos.disarmAll(ACTOR);

    // The card is deliberately NOT registered.
    const run = await startRun({ actor: ACTOR, registerCardFirst: false });

    // Give the dispatcher a moment; the drain runs inside the release.
    await new Promise((r) => setTimeout(r, 1_500));
    await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });

    const parked = await chaos.readChaosInbox(run.runId);
    expect(parked.length).toBeGreaterThan(0);

    // PARKED, on the card, with a reason a human can read. Not failed, not
    // dropped, not dead-lettered, and above all not posted against a customer
    // nobody chose.
    const onCard = parked.filter((r) => r.parkedOnKind === 'card');
    expect(onCard.length).toBeGreaterThan(0);
    expect(onCard[0]?.parkedOnRef).toBe(run.cardToken);
    expect(onCard[0]?.state).toBe('parked');

    // And nothing was posted for this card while it was unknown.
    //
    // Asserted on the AUTHORISATION token rather than the card, because
    // `card_authorization.card_id` is a foreign key into `card` — and while the
    // card is unregistered there is no `card` row for it to point at. That is
    // the refusal itself, stated in the schema: the system cannot record an
    // authorisation for a card it cannot attribute, so it does not record one.
    const [posted] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM card_authorization
       WHERE provider = 'lithic' AND provider_auth_id = ${run.transactionToken}`;
    expect(posted?.n).toBe(0);

    await noNewViolations('while deliveries were parked on an unregistered card');

    // NOW TELL IT WHOSE MONEY IT IS. The same rows — never re-delivered, never
    // re-signed — wake and post.
    const drained = await chaos.registerEpisodeCard(run.runId, ACTOR);
    expect(drained.registered).toBe(true);
    expect(drained.woken).toBeGreaterThan(0);

    await new Promise((r) => setTimeout(r, 1_000));

    const [nowPosted] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM card_authorization
       WHERE provider = 'lithic' AND provider_auth_id = ${run.transactionToken}`;
    expect(nowPosted?.n).toBeGreaterThan(0);

    await noNewViolations('after the parked deliveries drained');
  });

  it('THE BOUND — the database refuses an arming longer than ten minutes', async () => {
    // The application check first, with its readable message.
    await expect(
      chaos.armControl({ control: 'webhooks_off', seconds: 601, actor: ACTOR }),
    ).rejects.toThrow(/at most 600s|10 minutes|ten minutes/i);

    // And the constraint itself, reached around the application check by
    // writing the row directly. THIS is the guard that actually holds.
    await expect(
      sql`INSERT INTO chaos_control (control, armed_at, expires_at, armed_by, params)
          VALUES ('webhooks_off', now(), now() + interval '11 minutes', 'direct write', '{}'::jsonb)`,
    ).rejects.toThrow(/chaos_control_bounded/);

    const state = await chaos.readChaosState();
    expect(state.on).toBe(false);
  });

  it('EXPIRY — a control that runs out is absent, with no sweeper involved', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({ control: 'duplicate_delivery', seconds: 2, value: 2, actor: ACTOR });
    expect((await chaos.readChaosState()).on).toBe(true);

    await new Promise((r) => setTimeout(r, 2_500));

    // No job ran. `v_chaos_active` filters on now(), so the control is simply
    // not there any more.
    const state = await chaos.readChaosState();
    expect(state.on).toBe(false);
    expect(state.active).toHaveLength(0);
    // …and it is reported as history, so "it ran out" is distinguishable from
    // "it was never armed".
    expect(state.expired.some((e) => e.control === 'duplicate_delivery')).toBe(true);

    await chaos.disarmAll(ACTOR);
  });
});

if (!READY) {
  // eslint-disable-next-line no-console
  console.warn(`[chaos livefire] skipped; missing: ${MISSING.join(', ')}`);
}
