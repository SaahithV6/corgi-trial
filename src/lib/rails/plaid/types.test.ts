/**
 * The pure helpers in `./types.ts`.
 *
 * No network, no database, no mocks — this module imports nothing but
 * `../types`, which is the reason the external-ref format and the fundability
 * rule live here rather than inside the adapter: they are the two decisions on
 * this path that a reader has to be able to check in isolation.
 *
 * The account list in `FUNDABLE` is the real one. `ins_109508` returns fourteen
 * accounts, and eleven of them cannot fund a business current account.
 */

import { describe, expect, it } from 'vitest';

import {
  FUNDABLE_SUBTYPES,
  formatPlaidBalance,
  isFundable,
  parsePlaidExternalRef,
  plaidExternalRef,
  PLAID_ITEM_ERROR_COPY,
  type PlaidAccount,
} from './types';

function account(overrides: Partial<PlaidAccount> = {}): PlaidAccount {
  return {
    account_id: 'Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6',
    balances: {
      available: 100,
      current: 110,
      limit: null,
      iso_currency_code: 'USD',
      unofficial_currency_code: null,
    },
    mask: '0000',
    name: 'Plaid Checking',
    official_name: 'Plaid Gold Standard 0% Interest Checking',
    type: 'depository',
    subtype: 'checking',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* external refs                                                              */
/* -------------------------------------------------------------------------- */

describe('plaidExternalRef', () => {
  it('is the only durable record of the linkage, and round-trips exactly', () => {
    const ref = plaidExternalRef(
      'N5pKn4VqKMcgAJ9XNGGaUK4Kk77zL3UrVAJov',
      'Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6',
      'FUND-2026-09-10',
    );
    expect(ref).toBe(
      'plaid:N5pKn4VqKMcgAJ9XNGGaUK4Kk77zL3UrVAJov:Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6:FUND-2026-09-10',
    );
    expect(parsePlaidExternalRef(ref)).toEqual({
      itemId: 'N5pKn4VqKMcgAJ9XNGGaUK4Kk77zL3UrVAJov',
      accountId: 'Z597jowb7pcJjZlm3rrNsNgX4Qz1kgf9gxen6',
      reference: 'FUND-2026-09-10',
    });
  });

  it('refuses a colon in any component, because the ref has to stay parseable', () => {
    // This ref is what joins a hold to the entries that opened and released it.
    // An ambiguous one is a hold nobody can attribute, which is worse than a
    // refusal at the call site.
    expect(() => plaidExternalRef('item:1', 'acct', 'ref')).toThrow(/itemId/);
    expect(() => plaidExternalRef('item', 'acct:1', 'ref')).toThrow(/accountId/);
    expect(() => plaidExternalRef('item', 'acct', 'ref:1')).toThrow(/reference/);
  });

  it('refuses an empty component', () => {
    expect(() => plaidExternalRef('', 'acct', 'ref')).toThrow(TypeError);
    expect(() => plaidExternalRef('item', 'acct', '')).toThrow(TypeError);
  });
});

describe('parsePlaidExternalRef', () => {
  it('is null for a ref belonging to another rail', () => {
    expect(parsePlaidExternalRef('lithic:auth_123')).toBeNull();
    expect(parsePlaidExternalRef('increase:transfer:abc:def')).toBeNull();
  });

  it('is null for the wrong number of parts or an empty one', () => {
    expect(parsePlaidExternalRef('plaid:item:acct')).toBeNull();
    expect(parsePlaidExternalRef('plaid:item:acct:ref:extra')).toBeNull();
    expect(parsePlaidExternalRef('plaid::acct:ref')).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* fundability                                                                */
/* -------------------------------------------------------------------------- */

describe('isFundable', () => {
  it('accepts the depository subtypes an ACH debit can be pulled from', () => {
    for (const subtype of FUNDABLE_SUBTYPES) {
      expect(isFundable(account({ subtype }))).toBe(true);
    }
  });

  it('refuses a credit card, which is where the returned entry comes from', () => {
    expect(isFundable(account({ type: 'credit', subtype: 'credit card' }))).toBe(false);
  });

  it('refuses a CD, an HSA, a loan and an investment account', () => {
    // All four are on the real `ins_109508` Item. Filtering on
    // `type === 'depository'` alone still admits the CD and the HSA, neither of
    // which can be debited on demand — which is why the subtype list is explicit.
    expect(isFundable(account({ type: 'depository', subtype: 'cd' }))).toBe(false);
    expect(isFundable(account({ type: 'depository', subtype: 'hsa' }))).toBe(false);
    expect(isFundable(account({ type: 'loan', subtype: 'mortgage' }))).toBe(false);
    expect(isFundable(account({ type: 'investment', subtype: '401k' }))).toBe(false);
  });

  it('refuses an account with no subtype at all', () => {
    expect(isFundable(account({ subtype: null }))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* balances that are not money                                                */
/* -------------------------------------------------------------------------- */

describe('formatPlaidBalance', () => {
  it('renders Plaid’s number as Plaid sent it, with no arithmetic', () => {
    // `23631.9805` is a real value from the sandbox 401k. It is not a cent
    // count, multiplying it by 100 is the float bug the ledger exists to avoid,
    // and rounding it to $23,631.98 would be this codebase asserting a figure
    // that is not on anybody's book.
    expect(
      formatPlaidBalance({
        available: null,
        current: 23631.9805,
        limit: null,
        iso_currency_code: 'USD',
        unofficial_currency_code: null,
      }),
    ).toBe('23631.9805 USD');
  });

  it('falls back to `available` when `current` is null', () => {
    expect(
      formatPlaidBalance({
        available: 110,
        current: null,
        limit: null,
        iso_currency_code: 'USD',
        unofficial_currency_code: null,
      }),
    ).toBe('110 USD');
  });

  it('is null when the institution published no balance', () => {
    expect(
      formatPlaidBalance({
        available: null,
        current: null,
        limit: null,
        iso_currency_code: null,
        unofficial_currency_code: null,
      }),
    ).toBeNull();
  });

  it('omits the currency suffix when there is none', () => {
    expect(
      formatPlaidBalance({
        available: null,
        current: 110,
        limit: null,
        iso_currency_code: null,
        unofficial_currency_code: null,
      }),
    ).toBe('110');
  });
});

/* -------------------------------------------------------------------------- */
/* error copy                                                                 */
/* -------------------------------------------------------------------------- */

describe('PLAID_ITEM_ERROR_COPY', () => {
  it('covers ITEM_LOGIN_REQUIRED, whose display_message Plaid sends as null', () => {
    // Measured: `/auth/get` on a reset Item returns `display_message: null`. A
    // UI that renders only that field shows a blank box on the single most
    // common error a funding screen has to explain.
    expect(PLAID_ITEM_ERROR_COPY['ITEM_LOGIN_REQUIRED']).toBeDefined();
    expect(PLAID_ITEM_ERROR_COPY['ITEM_LOCKED']).toBeDefined();
  });
});
