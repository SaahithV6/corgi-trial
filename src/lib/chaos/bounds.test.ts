/**
 * The bounds.
 *
 * These assert the APPLICATION's half of the safety story. The other half —
 * the half that actually holds — is `chaos_control_bounded` in migration 0029,
 * which no code path can route around:
 *
 *     CHECK (expires_at > armed_at
 *            AND expires_at <= armed_at + interval '10 minutes')
 *
 * `validateArm` exists so a person gets a readable refusal before Postgres
 * gives them an unreadable one. It is tested here because a bound that is only
 * exercised through a database connection is a bound nobody checks, and because
 * the numbers in it are the reason a forgotten switch cannot outlive the demo.
 */

import { describe, expect, it } from 'vitest';

import { ChaosControlError, validateArm } from './bounds';
import {
  CHAOS_MAX_COPIES,
  CHAOS_MAX_REORDER_SECONDS,
  CHAOS_MAX_SECONDS,
  CHAOS_MAX_SETTLEMENT_DELAY_SECONDS,
  CHAOS_MIN_COPIES,
} from './types';

const BASE = { actor: 'tester' } as const;

describe('the ten-minute ceiling', () => {
  it('accepts an arming inside the ceiling', () => {
    expect(() =>
      validateArm({ ...BASE, control: 'webhooks_off', seconds: CHAOS_MAX_SECONDS }),
    ).not.toThrow();
  });

  it('refuses one second past it', () => {
    expect(() =>
      validateArm({ ...BASE, control: 'webhooks_off', seconds: CHAOS_MAX_SECONDS + 1 }),
    ).toThrow(ChaosControlError);
  });

  it('names the database constraint, so the refusal is not mistaken for a preference', () => {
    expect(() =>
      validateArm({ ...BASE, control: 'webhooks_off', seconds: 99_999 }),
    ).toThrow(/migration 0029|CHECK constraint/);
  });

  it('refuses a zero or negative arming', () => {
    expect(() => validateArm({ ...BASE, control: 'webhooks_off', seconds: 0 })).toThrow(
      ChaosControlError,
    );
    expect(() => validateArm({ ...BASE, control: 'webhooks_off', seconds: -60 })).toThrow(
      ChaosControlError,
    );
  });

  it('refuses a non-finite arming rather than writing NaN seconds', () => {
    expect(() =>
      validateArm({ ...BASE, control: 'webhooks_off', seconds: Number.NaN }),
    ).toThrow(ChaosControlError);
  });
});

describe('per-control parameters', () => {
  it('bounds the settlement delay', () => {
    expect(
      validateArm({ ...BASE, control: 'settlement_delay', seconds: 300, value: 45 }).params,
    ).toEqual({ seconds: 45 });
    expect(() =>
      validateArm({
        ...BASE,
        control: 'settlement_delay',
        seconds: 300,
        value: CHAOS_MAX_SETTLEMENT_DELAY_SECONDS + 1,
      }),
    ).toThrow(ChaosControlError);
  });

  it('refuses a single copy, because one copy is not chaos', () => {
    expect(() =>
      validateArm({ ...BASE, control: 'duplicate_delivery', seconds: 300, value: 1 }),
    ).toThrow(/not chaos/);
  });

  it('bounds the copy count at both ends', () => {
    expect(
      validateArm({ ...BASE, control: 'duplicate_delivery', seconds: 300, value: CHAOS_MIN_COPIES })
        .params,
    ).toEqual({ copies: CHAOS_MIN_COPIES });
    expect(() =>
      validateArm({
        ...BASE,
        control: 'duplicate_delivery',
        seconds: 300,
        value: CHAOS_MAX_COPIES + 1,
      }),
    ).toThrow(ChaosControlError);
  });

  it('bounds the reorder window', () => {
    expect(() =>
      validateArm({
        ...BASE,
        control: 'reorder_window',
        seconds: 300,
        value: CHAOS_MAX_REORDER_SECONDS + 1,
      }),
    ).toThrow(ChaosControlError);
  });

  it('refuses a fractional parameter rather than truncating it silently', () => {
    expect(() =>
      validateArm({ ...BASE, control: 'duplicate_delivery', seconds: 300, value: 2.5 }),
    ).toThrow(ChaosControlError);
  });

  it('scopes the outage to the one provider chaos can originate for', () => {
    expect(validateArm({ ...BASE, control: 'webhooks_off', seconds: 60 }).params).toEqual({
      provider: 'lithic',
    });
  });

  it('supplies a usable default for every parameterised control', () => {
    // The screen offers a number; a caller that omits one must still get a
    // demo rather than a crash.
    expect(validateArm({ ...BASE, control: 'settlement_delay', seconds: 60 }).params).toHaveProperty(
      'seconds',
    );
    expect(
      validateArm({ ...BASE, control: 'duplicate_delivery', seconds: 60 }).params,
    ).toHaveProperty('copies');
    expect(validateArm({ ...BASE, control: 'reorder_window', seconds: 60 }).params).toHaveProperty(
      'seconds',
    );
  });
});
