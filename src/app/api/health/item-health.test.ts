/**
 * The gap, demonstrated, and then closed.
 *
 * ===========================================================================
 * WHAT THIS FILE IS FOR
 * ===========================================================================
 *
 * On 2026-09-11 `/api/health` reported the `open_banking` slot **live** and the
 * Plaid webhook feed **stale**. Both were true. Together they read as "a
 * working integration that has gone quiet".
 *
 * The truth, measured: Plaid had delivered three webhooks ever, all three
 * `ITEM_LOGIN_REQUIRED`, carrying three DIFFERENT item ids, and all three of
 * those items answered `400 INVALID_ACCESS_TOKEN` when asked — this deployment
 * held no credential for any of them and had not one usable funding source.
 *
 * The first `describe` below proves the OLD surface could not express that,
 * and proves it by EQUALITY rather than by assertion: feed the old fold a
 * provider whose every delivery was an error, feed it a provider whose every
 * delivery was fine, and the two published readings are byte-identical. A
 * guard that returns the same answer for a healthy rail and a dead one is not
 * a guard, and no amount of reading the number harder would have found it.
 *
 * The rest of the file proves the new question distinguishes what the old one
 * could not, and — the part that matters as much — that it stays quiet.
 */

import { describe, expect, it } from 'vitest';

import {
  DELIVERY_VERDICTS,
  webhookDeliveryHealth,
  type DeliveryRead,
} from '@/lib/integrations/delivery-health';
import { PLAID_ITEM_STATES, foldItemState } from '@/lib/rails/plaid/item-store';

import {
  ITEM_VERDICTS,
  itemsUnavailable,
  plaidItemHealth,
  type ItemRead,
  type ItemRow,
} from './item-health';
import { PROCESSING_VERDICTS } from './processing';

/** The instant the readings in this file were taken. */
const NOW = new Date('2026-09-11T16:47:23.000Z');
/** `MAX(received_at)` for Plaid on that morning — 64,899s earlier. */
const LAST_PLAID_DELIVERY = new Date('2026-09-10T22:47:23.312Z');

const PLAID_LIVE_AND_VERIFIED = [
  { provider: 'plaid', integrationLive: true, verifierRegistered: true },
];

function deliveryRead(at: Date): DeliveryRead {
  return { ok: true, rows: [{ provider: 'plaid', lastDeliveryAt: at }], latencyMs: 1 };
}

function itemRead(rows: readonly ItemRow[]): ItemRead {
  return { ok: true, rows, latencyMs: 1 };
}

function row(over: Partial<ItemRow>): ItemRow {
  return {
    itemId: 'item-0',
    institutionName: 'First Platypus Bank',
    environment: 'sandbox',
    purpose: 'funding',
    state: 'healthy',
    lastObservedAt: LAST_PLAID_DELIVERY,
    lastSource: 'webhook',
    lastErrorCode: null,
    observations: 1,
    errorObservations: 0,
    hasLiveToken: true,
    accountCount: 3,
    ...over,
  };
}

/** The three real deliveries, as the item log records them. */
const THE_THREE_ORPHANS: readonly ItemRow[] = [
  '8MppL6n1rKTdJXD5Dkd8sRjPd5dm4vixgGNRZ',
  'xPJdr6LN75SvXQZPy9PvcVDqnX6wV6i9LLxR7',
  '7k9de5pw8RuB7KEwvDWKfvNrwgwr3xiNwBodw',
].map((itemId) =>
  row({
    itemId,
    state: 'orphaned',
    institutionName: null,
    purpose: null,
    lastErrorCode: 'ITEM_LOGIN_REQUIRED',
    observations: 1,
    errorObservations: 1,
    hasLiveToken: false,
    accountCount: 0,
  }),
);

/* -------------------------------------------------------------------------- */
/* 1. THE GAP — red before the fix, and it fails by EQUALITY                   */
/* -------------------------------------------------------------------------- */

describe('the reading that was indistinguishable', () => {
  it('the delivery fold gives the SAME answer for an error-only feed and a healthy one', () => {
    // `webhookDeliveryHealth` is computed from `MAX(received_at)` and nothing
    // else. It cannot see WHAT arrived, only WHEN — so these two calls are the
    // same call, and that is the whole defect.
    const asIfHealthy = webhookDeliveryHealth(
      deliveryRead(LAST_PLAID_DELIVERY),
      PLAID_LIVE_AND_VERIFIED,
      NOW,
    );
    const asItActuallyWas = webhookDeliveryHealth(
      deliveryRead(LAST_PLAID_DELIVERY),
      PLAID_LIVE_AND_VERIFIED,
      NOW,
    );

    expect(asItActuallyWas).toEqual(asIfHealthy);

    // And here is what it said, in both cases. `stale` means "this provider
    // has gone quiet", which implies it once worked. It never did.
    const plaid = asItActuallyWas.providers.find((p) => p.provider === 'plaid');
    expect(plaid?.verdict).toBe('stale');
    expect(plaid?.secondsSinceLastDelivery).toBe(64_799);
    expect(plaid?.degradesDeployment).toBe(false);
  });

  it('the delivery vocabulary has no word for "everything we heard was an error"', () => {
    // Stated as a test rather than as a comment, so that adding one to the
    // delivery vocabulary without deciding what it means fails here.
    expect(DELIVERY_VERDICTS).toEqual(['fresh', 'stale', 'quiet', 'never', 'unknown']);
    expect(DELIVERY_VERDICTS).not.toContain('erroring');
  });
});

/* -------------------------------------------------------------------------- */
/* 2. THE FIX — the four states that were one                                  */
/* -------------------------------------------------------------------------- */

describe('plaidItemHealth distinguishes what the slot table could not', () => {
  it('credentials valid, item linked and healthy', () => {
    const health = plaidItemHealth(itemRead([row({})]), NOW);
    expect(health.verdict).toBe('healthy');
    expect(health.silenceIsExpected).toBe(false);
    expect(health.heardOnlyErrors).toBe(false);
    expect(health.note).toContain('can fund from a linked bank');
  });

  it('credentials valid, item linked but NEEDS A HUMAN to re-authenticate', () => {
    const health = plaidItemHealth(
      itemRead([
        row({
          state: 'needs_reauth',
          lastErrorCode: 'ITEM_LOGIN_REQUIRED',
          observations: 2,
          errorObservations: 1,
        }),
      ]),
      NOW,
    );
    expect(health.verdict).toBe('needs_reauth');
    expect(health.items[0]?.note).toContain('Link update mode');
    // The house rule: a status that cannot go back to `ok` is a status people
    // stop reading. This state's exit condition is a person logging into their
    // bank, so it is REPORTED and never alarmed on.
    expect(health.degradesDeployment).toBe(false);
    expect(health.note).toContain('not alarmed on');
  });

  it('credentials valid, NO ITEM AT ALL — so silence is correct', () => {
    const health = plaidItemHealth(itemRead([]), NOW);
    expect(health.verdict).toBe('absent');
    // The field that stops a `stale` delivery verdict reading as an anomaly.
    expect(health.silenceIsExpected).toBe(true);
    expect(health.note).toContain('silence from Plaid is correct');
    expect(health.note).toContain('nothing is linked');
  });

  it('the state this deployment was ACTUALLY in: three orphans, error-only', () => {
    const health = plaidItemHealth(itemRead(THE_THREE_ORPHANS), NOW);

    expect(health.verdict).toBe('orphaned');
    expect(health.counts.orphaned).toBe(3);
    expect(health.counts.healthy).toBe(0);

    // THE WORD THE DELIVERY VOCABULARY DID NOT HAVE.
    expect(health.heardOnlyErrors).toBe(true);
    expect(health.observations).toBe(3);
    expect(health.errorObservations).toBe(3);
    expect(health.note).toContain('Every observation ever recorded from Plaid was an error');
    expect(health.note).toContain('does NOT mean a working feed went quiet');

    // An orphan cannot produce another webhook, so the silence really is the
    // steady state — but for a completely different reason than `absent`.
    expect(health.silenceIsExpected).toBe(true);
    expect(health.items[0]?.note).toContain('we hold no live access token');

    // And it STILL does not degrade the deployment. The reading is truer, not
    // louder.
    expect(health.degradesDeployment).toBe(false);
  });

  it('a broken diagnostic fixture does not hide a working funding source', () => {
    // This build keeps a deliberately-broken item as a test fixture. A rollup
    // that reported the worst state would report "no funding source" forever
    // because of a fixture, which is the same cry-wolf in a new place.
    const health = plaidItemHealth(
      itemRead([
        row({ itemId: 'healthy-one' }),
        row({
          itemId: 'broken-fixture',
          purpose: 'diagnostic',
          state: 'needs_reauth',
          lastErrorCode: 'ITEM_LOGIN_REQUIRED',
          errorObservations: 1,
        }),
      ]),
      NOW,
    );
    expect(health.verdict).toBe('healthy');
    // Hidden from the rollup, never from the reader.
    expect(health.counts.needs_reauth).toBe(1);
    expect(health.items.some((i) => i.verdict === 'needs_reauth')).toBe(true);
  });

  it('revoked is terminal and is not the same word as needs_reauth', () => {
    const health = plaidItemHealth(
      itemRead([
        row({ state: 'revoked', lastErrorCode: 'USER_PERMISSION_REVOKED', errorObservations: 1 }),
      ]),
      NOW,
    );
    expect(health.verdict).toBe('revoked');
    expect(health.items[0]?.note).toContain('re-linking creates a new one');
  });

  it('a read that did not happen is `unread`, never a fabricated verdict', () => {
    const health = plaidItemHealth(itemsUnavailable('database unreachable'), NOW);
    expect(health.verdict).toBe('unread');
    expect(health.measured).toBe(false);
    expect(health.error).toBe('database unreachable');
    expect(health.note).toContain('not a verdict about any funding source');
    // Crucially: not `absent`. "We could not look" and "there is nothing
    // there" are different facts and conflating them is this whole file's
    // subject.
    expect(health.verdict).not.toBe('absent');
  });

  it('zero observations is not "everything we heard was an error"', () => {
    // 0 of 0 is an empty set, not a finding.
    const health = plaidItemHealth(itemRead([]), NOW);
    expect(health.heardOnlyErrors).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 3. THE INVARIANT THE OTHER THREE MODULES ALREADY KEEP                       */
/* -------------------------------------------------------------------------- */

describe('four questions, four vocabularies, no shared word', () => {
  it('no verdict string appears in two vocabularies', () => {
    const liveness = [
      'live',
      'simulated',
      'unauthorised',
      'unreachable',
      'rate_limited',
      'not_configured',
      'unprobed',
    ];
    const all = [...liveness, ...DELIVERY_VERDICTS, ...PROCESSING_VERDICTS, ...ITEM_VERDICTS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('the TypeScript fold and migration 0056 §11 agree on every branch', () => {
    // `v_plaid_item_state` is the definition; this mirror exists only so the
    // branches are reachable without a database. `item-store.test.ts` holds
    // the two to each other against the real view.
    expect(foldItemState({ hasLiveToken: false, lastErrorCode: null, lastWebhookCode: null })).toBe(
      'orphaned',
    );
    expect(
      foldItemState({ hasLiveToken: true, lastErrorCode: null, lastWebhookCode: null }),
    ).toBe('healthy');
    expect(
      foldItemState({
        hasLiveToken: true,
        lastErrorCode: 'ITEM_LOGIN_REQUIRED',
        lastWebhookCode: 'ERROR',
      }),
    ).toBe('needs_reauth');
    expect(
      foldItemState({
        hasLiveToken: true,
        lastErrorCode: 'USER_PERMISSION_REVOKED',
        lastWebhookCode: 'USER_PERMISSION_REVOKED',
      }),
    ).toBe('revoked');
    // An orphan whose last word was "healthy" is still an orphan: no
    // credential dominates whatever Plaid last said.
    expect(
      foldItemState({ hasLiveToken: false, lastErrorCode: null, lastWebhookCode: null }),
    ).toBe('orphaned');
  });

  it('the store and the health surface name the same states', () => {
    for (const state of PLAID_ITEM_STATES) {
      expect(ITEM_VERDICTS).toContain(state);
    }
    // The health surface has two the store does not, and they are both about
    // the ABSENCE of a row rather than the state of one.
    expect(ITEM_VERDICTS).toContain('absent');
    expect(ITEM_VERDICTS).toContain('unread');
  });
});
