/**
 * A Plaid `access_token`, wrapped so it cannot be logged by accident.
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ===========================================================================
 *
 * Until migration 0056 this codebase held a Plaid access token for a few
 * hundred milliseconds inside `linkExternalAccount()` and then dropped it on
 * the floor. That was safe in exactly one way — a value that is never stored
 * cannot leak from storage — and unsafe in every other, because it meant an
 * Item could not be re-read, re-checked or repaired, and `/funding` had to
 * link a fresh Item on every single run.
 *
 * 0056 gives the token somewhere to live. The moment a credential has a
 * lifetime longer than one request, it needs a type whose whole job is to be
 * awkward to print. This is that type, and it is deliberately the same shape
 * as `src/lib/events/secret.ts` — same module-private symbol, same three
 * stringify hooks, same single greppable accessor — because a second
 * credential wrapper that behaves differently from the first is how one of
 * them ends up being the one nobody remembers the rules for.
 *
 * What it buys, concretely:
 *
 *   `${token}`                  -> "access-sandbox-***"
 *   JSON.stringify(token)       -> "[redacted]"     (explicit toJSON)
 *   console.log(token)          -> PlaidAccessToken [redacted]  (inspect hook)
 *   {...token}                  -> {}               (symbol keys do not spread)
 *   Object.keys(token)          -> []
 *   logger.info("x", { token }) -> "[redacted]"     (the logger JSON-encodes)
 *
 * The last line is the one that matters. This repository's logger serialises
 * its context bag, `rootLogger` ships to a log drain, and the README records
 * that two live credentials have already reached git history. A bare string
 * in a context bag is one `log.info` away from being permanent.
 *
 * ===========================================================================
 * WHAT A PLAID ACCESS TOKEN LOOKS LIKE
 * ===========================================================================
 *
 * `access-<environment>-<uuid>` — measured against the real sandbox on
 * 2026-09-11, e.g. `access-sandbox-` followed by a v4 uuid, 51 characters in
 * total. The environment is IN the token, which is why `looksLikePlaidAccessToken`
 * can check it and why 0056's `plaid_access_token_shape` CHECK can too.
 *
 * It is a BEARER credential and it does not expire. Anyone holding it can read
 * the linked account's balances, transactions, identity and full ACH numbers
 * until the Item is removed. It is not a session token and there is no refresh
 * step: there is nothing to rotate except by re-linking, which is a new Item.
 * That is precisely why it is worth this much ceremony.
 */

/**
 * Module-private. Nothing outside this file can name it, so nothing outside
 * this file can read the token without going through `revealAccessToken`.
 */
const MATERIAL = Symbol('corgi.plaid.access-token');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export const PLAID_TOKEN_PREFIX = 'access-';

export interface PlaidAccessToken {
  readonly [MATERIAL]: string;
  /**
   * Which stored version this is. Safe to log: it identifies the row, it does
   * not authenticate anything.
   */
  readonly version: number;
  toString(): string;
  toJSON(): string;
  [INSPECT](): string;
}

/** Build the opaque wrapper around token material we already hold. */
export function wrapAccessToken(material: string, version = 1): PlaidAccessToken {
  // `access-sandbox-` / `access-production-`, which is not secret and is the
  // one part worth seeing in a stack trace: a production token used against
  // the sandbox host fails in a way that is otherwise very confusing.
  const environmentHint = material.split('-').slice(0, 2).join('-');
  return {
    [MATERIAL]: material,
    version,
    toString: () => `${environmentHint}-***`,
    toJSON: () => '[redacted]',
    [INSPECT]: () => `PlaidAccessToken(v${version}) [redacted]`,
  };
}

/**
 * THE ONLY WAY TO READ TOKEN MATERIAL.
 *
 * Named to be uncomfortable and greppable, exactly as `revealSecret` is. It has
 * two legitimate callers and they are both in this package:
 *
 *   1. `item-store.ts`, to write the token to `plaid_item_secret`.
 *   2. `item-store.ts`, to hand it back to `PlaidClient` for a real call.
 *
 * If you are adding a third, the question to answer first is why the token has
 * to leave the module that talks to Plaid. It never has to reach a React tree,
 * a server action's return value, or a log line.
 */
export function revealAccessToken(token: PlaidAccessToken): string {
  return token[MATERIAL];
}

/**
 * Is this a token Plaid could have issued?
 *
 * Used to validate material coming back OUT of the database, so a truncated or
 * mangled row fails loudly HERE rather than as an opaque
 * `INVALID_ACCESS_TOKEN` from Plaid three calls later. 0056's CHECK constraint
 * asks a weaker version of the same question on the way in; this is the
 * read-side half, and having both is deliberate — the constraint protects the
 * column, this protects the caller.
 */
export function looksLikePlaidAccessToken(value: string): boolean {
  if (!value.startsWith(PLAID_TOKEN_PREFIX)) return false;
  // `access-<env>-<uuid>`: three segments at minimum, and the environment must
  // be one Plaid actually has. `development` is included because Plaid issued
  // tokens for it historically; this codebase never creates one.
  const parts = value.split('-');
  if (parts.length < 3) return false;
  const environment = parts[1];
  if (
    environment !== 'sandbox' &&
    environment !== 'development' &&
    environment !== 'production'
  ) {
    return false;
  }
  return value.length >= 20;
}
