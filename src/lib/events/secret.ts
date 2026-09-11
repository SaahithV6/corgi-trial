/**
 * The per-endpoint signing secret, and the type that stops it leaking.
 *
 * ===========================================================================
 * WHY THIS IS A TYPE AND NOT A STRING
 * ===========================================================================
 *
 * This repository has already leaked two live credentials into git history,
 * and the pre-commit gate exists because of it. A gate catches a secret that
 * gets committed; it catches nothing that goes to a log drain, an error
 * report, a `JSON.stringify(endpoint)` in a debug route, or a `console.log`
 * of a row in a stack trace. Those are the paths a `string` takes, silently,
 * the first time someone is tired.
 *
 * So the secret is never a `string` once it leaves the database. It is an
 * opaque object whose only content is behind a module-private `Symbol`, which
 * means:
 *
 *   JSON.stringify(secret)     -> "[redacted]"   (explicit toJSON)
 *   `${secret}`                -> "whsec_***"    (explicit toString)
 *   console.log(secret)        -> SigningSecret [redacted]   (inspect hook)
 *   {...secret}                -> {}             (symbol keys do not spread)
 *   Object.keys(secret)        -> []
 *
 * and the one way to get the bytes is to call `revealSecret()`, which is
 * greppable, named to be uncomfortable, and called in exactly two places in
 * this codebase:
 *
 *   1. `sign.ts`, to key the HMAC.
 *   2. `store.ts`'s `registerEndpoint()`, to hand the plaintext back ONCE to
 *      the caller that created it.
 *
 * There is no third caller and no read path anywhere in `src/lib/events/**`
 * or `src/components/events/**` that can produce one, because the SQL those
 * paths run does not select the column (see 0034 §2: the secret is in its own
 * table precisely so that `SELECT *` on an endpoint cannot return it).
 *
 * ===========================================================================
 * WHAT A SECRET LOOKS LIKE, AND WHY THAT SHAPE
 * ===========================================================================
 *
 * `whsec_` + base64(32 random bytes), which is the Standard Webhooks shape
 * that Lithic, Stripe and Svix all use. Not decoration: it means a customer
 * can paste this into any off-the-shelf Standard Webhooks verifier — the
 * `standardwebhooks` npm package, Svix's libraries, or the verifier in
 * `src/lib/webhooks/inbox.ts` that this build already uses to check LITHIC's
 * signatures — and it works with no adapter. The signing key is the
 * base64-DECODED body, exactly as `lithicVerifier` does it.
 *
 * 32 bytes because HMAC-SHA256's security is capped at its block-truncated
 * key length anyway and 256 bits of CSPRNG output is past every margin that
 * matters here. `randomBytes`, never `Math.random`.
 */

import { randomBytes } from "node:crypto";

/** Module-private. Nothing outside this file can name it, so nothing outside
 *  this file can read the secret without going through `revealSecret`. */
const MATERIAL = Symbol("corgi.outbound.signing-secret");

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export interface SigningSecret {
  readonly [MATERIAL]: string;
  /** The version this secret was issued as. Safe to log; identifies, does not authenticate. */
  readonly version: number;
  toString(): string;
  toJSON(): string;
  [INSPECT](): string;
}

export const SECRET_PREFIX = "whsec_";

/** Build the opaque wrapper around key material we already hold. */
export function wrapSecret(material: string, version: number): SigningSecret {
  return {
    [MATERIAL]: material,
    version,
    toString: () => `${SECRET_PREFIX}***`,
    toJSON: () => "[redacted]",
    [INSPECT]: () => `SigningSecret(v${version}) [redacted]`,
  };
}

/**
 * THE ONLY WAY TO READ KEY MATERIAL. Two callers, both named in this file's
 * header. If you are adding a third, the question to answer first is why the
 * secret has to leave the signer at all.
 */
export function revealSecret(secret: SigningSecret): string {
  return secret[MATERIAL];
}

/** A fresh secret. `whsec_` + base64 of 32 CSPRNG bytes. */
export function generateSecret(version = 1): SigningSecret {
  return wrapSecret(`${SECRET_PREFIX}${randomBytes(32).toString("base64")}`, version);
}

/**
 * Is this a secret we could have issued?
 *
 * Used only to validate material coming back OUT of the database, so a
 * truncated or mangled row fails loudly at the signer rather than producing
 * signatures that verify against nothing.
 */
export function looksLikeSecret(value: string): boolean {
  if (!value.startsWith(SECRET_PREFIX)) return false;
  const body = value.slice(SECRET_PREFIX.length);
  if (body.length < 16) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(body);
}
