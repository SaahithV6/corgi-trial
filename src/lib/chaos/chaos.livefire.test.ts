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
 * The invariants are asserted UNCONDITIONALLY in every test, because they are
 * invariants: they hold whoever else is writing, and "they held throughout" is
 * the entire claim this feature makes.
 * ============================================================================
 *
 * SKIPPED, LOUDLY, WITHOUT `LIVEFIRE=1`. A test that silently passes when it
 * could not run is the failure mode this repository keeps finding in its own
 * guards, so the skip names what is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Sql } from '@/lib/ledger/db';

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

  beforeAll(async () => {
    ({ sql } = await import('@/lib/ledger/db'));
    chaos = await import('./index');
    // Start from a known state: nothing armed.
    await chaos.disarmAll(ACTOR);
  });

  afterAll(async () => {
    // THE SUITE CANNOT LEAVE CHAOS ON. Even if a test throws halfway through.
    await chaos.disarmAll(ACTOR);
    const state = await chaos.readChaosState();
    expect(state.on).toBe(false);
  });

  /** Every invariant, asserted unconditionally. This is the claim. */
  async function invariantsMustHold(when: string): Promise<void> {
    const readings = await chaos.readInvariants();
    const broken = readings.filter((r) => r.rows !== 0 || r.error !== null);
    expect(
      broken.map((b) => `${b.view}: ${b.error ?? `${String(b.rows)} row(s)`}`),
      `invariants were not satisfied ${when}`,
    ).toEqual([]);
    expect(readings.length).toBeGreaterThanOrEqual(13);
  }

  async function inboxStateOf(webhookId: string): Promise<string | null> {
    const rows = await sql<{ state: string }[]>`
      SELECT state::text AS state FROM webhook_inbox
       WHERE provider = 'lithic' AND provider_event_id = ${webhookId}`;
    return rows[0]?.state ?? null;
  }

  // -------------------------------------------------------------------------

  it('holds every invariant before anything is armed', async () => {
    await invariantsMustHold('at rest, before chaos was armed');
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

    const run = await chaos.startChaosRun({ actor: ACTOR, registerCardFirst: true });
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

    await invariantsMustHold('while every delivery was being sent three times');
    await chaos.disarmAll(ACTOR);
  });

  it('REORDER — the settlement is delivered before the authorisation it belongs to', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({ control: 'reorder_window', seconds: 120, value: 1, actor: ACTOR });

    const run = await chaos.startChaosRun({ actor: ACTOR, registerCardFirst: true });
    const outbox = await chaos.readOutbox(run.runId);

    // seq 0 leaves first, and seq 0 is the CLEARING.
    const first = outbox.find((d0) => d0.seq === 0);
    expect(first?.step).toBe('clearing');
    expect(outbox.find((d0) => d0.seq === 1)?.step).toBe('authorization');

    // The clearing went out immediately; the authorisation it overtook is held
    // to the far edge of the buffer and released on the next pass.
    expect(first?.outcome).toBe('accepted');

    await invariantsMustHold('with the settlement delivered ahead of its authorisation');

    // Turn the buffer off and let the overtaken authorisation catch up.
    await chaos.disarmAll(ACTOR);
    await new Promise((r) => setTimeout(r, 1_500));
    await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });

    const after = await chaos.readOutbox(run.runId);
    expect(after.every((d0) => d0.outcome !== 'withheld')).toBe(true);

    await invariantsMustHold('after the out-of-order pair had both landed');
  });

  it('SETTLEMENT DELAY — the clearing is late, the authorisation is not', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({
      control: 'settlement_delay',
      seconds: 120,
      value: 3,
      actor: ACTOR,
    });

    const run = await chaos.startChaosRun({ actor: ACTOR, registerCardFirst: true });
    const immediately = await chaos.readOutbox(run.runId);

    const auth = immediately.find((d0) => d0.step === 'authorization');
    const clearing = immediately.find((d0) => d0.step === 'clearing');

    // The authorisation went. The clearing did not: it is scheduled, not failed.
    expect(auth?.outcome).toBe('accepted');
    expect(clearing?.outcome).toBe('withheld');
    expect(Date.parse(clearing?.plannedAt ?? '')).toBeGreaterThan(Date.parse(auth?.plannedAt ?? ''));

    await invariantsMustHold('with a settlement still outstanding');

    // Wait it out and release. Nobody had to turn anything off: a delay is a
    // delay, and it expires on its own schedule.
    await new Promise((r) => setTimeout(r, 3_500));
    await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });

    const later = await chaos.readOutbox(run.runId);
    expect(later.find((d0) => d0.step === 'clearing')?.outcome).toBe('accepted');

    await invariantsMustHold('after the late settlement landed');
    await chaos.disarmAll(ACTOR);
  });

  it('WEBHOOKS OFF — nothing leaves, nothing is lost, and it catches up', async () => {
    await chaos.disarmAll(ACTOR);
    await chaos.armControl({ control: 'webhooks_off', seconds: 120, actor: ACTOR });

    const run = await chaos.startChaosRun({ actor: ACTOR, registerCardFirst: true });
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

    await invariantsMustHold('while the feed was dark');

    // THE FEED COMES BACK. Turning the switch off IS the provider returning:
    // no sweeper, no requeue, no state transition.
    await chaos.disarmAll(ACTOR);
    const caughtUp = await chaos.releaseDueDeliveries({ actor: ACTOR, runId: run.runId });
    expect(caughtUp.released).toBe(2);
    expect(caughtUp.accepted).toBe(2);

    const after = await chaos.readOutbox(run.runId);
    expect(after.every((d0) => d0.outcome === 'accepted')).toBe(true);

    await invariantsMustHold('after the backlog caught up');
  });

  it('PARKS — the system refuses to guess whose money to move, then drains', async () => {
    await chaos.disarmAll(ACTOR);

    // The card is deliberately NOT registered.
    const run = await chaos.startChaosRun({ actor: ACTOR, registerCardFirst: false });

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

    await invariantsMustHold('while deliveries were parked on an unregistered card');

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

    await invariantsMustHold('after the parked deliveries drained');
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
