/**
 * THE SIGN-IN GATE. Authentication, at last — the thing `roles.ts` and
 * `policy.ts` both say at length that they are not.
 *
 * ============================================================================
 * WHAT WAS WRONG
 * ============================================================================
 *
 * `corgi_demo_role` is a cookie a visitor sets on themselves. The
 * authorisation boundary built on top of it is real — default deny, enforced
 * in middleware before any route or server action runs, re-derived by the
 * `(app)` layout and by 37 operator actions — but every one of those decisions
 * rests on a claim nobody verified. Anyone who knows the cookie name is staff.
 *
 * That was a deliberate, documented gap, not an oversight: `docs/DEMO.md` §1
 * said "there is nothing to sign into". It is the last structural hole, and
 * this module closes it.
 *
 * ============================================================================
 * THE SHAPE, AND WHY IT IS THIS SHAPE
 * ============================================================================
 *
 * ONE SHARED OPERATOR PASSPHRASE, HELD IN AN ENVIRONMENT VARIABLE.
 *
 * `CONSOLE_PASSWORD` is set on the Vercel project by a human and read here.
 * There is exact precedent in this repo — `CRON_SECRET` in
 * `src/app/api/cron/_auth.ts` — and this file follows its shape on purpose:
 * a secret that only ever exists in the environment, a constant-time
 * comparison, and a refusal that says nothing about which secret is missing.
 *
 * The passphrase is never a cookie. What the browser carries is a SIGNED
 * SESSION TOKEN: an expiry and a nonce, plus an HMAC-SHA256 over them under a
 * server-only key. A visitor cannot mint one the way they can mint
 * `corgi_demo_role`, because they do not hold the key — and the cookie is
 * `httpOnly`, so a script on the page cannot read one either.
 *
 * AUTHENTICATION GATES THE CONSOLE. ROLE SELECTION STAYS A SWITCH BEHIND IT.
 * One passphrase gets you in; the existing switch then chooses staff or
 * approver. The customer surface (`/client/**`) and `/` remain reachable
 * without it, because a customer is not staff and `/` is where the switch
 * lives. `docs/DEMO.md` and `scripts/verify-demo.mjs` depend on both halves.
 *
 * ============================================================================
 * WHY WEB CRYPTO AND NOT `node:crypto`
 * ============================================================================
 *
 * This module is imported by `src/middleware.ts`, which runs on the Edge
 * runtime, and by a server action, which runs on Node. `node:crypto` is not
 * available in the first. `crypto.subtle` is available in BOTH, and one
 * verifier for one token is worth more than the convenience of a synchronous
 * API — a second implementation is a second answer to the same question, which
 * is how this codebase's other thirty defects began.
 *
 * The PASSPHRASE comparison lives in `password.ts` and does use `node:crypto`,
 * because it only ever runs in the server action. Middleware never sees the
 * passphrase; it only ever verifies a signature.
 *
 * ============================================================================
 * WHAT THIS IS NOT — say it plainly, see docs/AUTH.md
 * ============================================================================
 *
 * Not per-user accounts. Not a password database. Not registration, not reset,
 * not MFA, not revocation. One shared operator passphrase is the honest scope
 * for a work trial, and an honest boundary beats a half-built identity system.
 * What a real deployment needs instead is written down in `docs/AUTH.md`.
 */

/** The session cookie. Distinct from `corgi_demo_role`, which it does not replace. */
export const SESSION_COOKIE = "corgi_console";

/** How long one sign-in lasts. Short, because there is no revocation. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * Domain separation for the HMAC key.
 *
 * The signing key is derived from the same secret the passphrase check uses
 * (see `signingSecret()`), so this string is what stops a session signature
 * from ever being confused with anything else computed under that secret.
 */
const KEY_CONTEXT = "corgi.console.session.v1";

/** Bumped if the token's payload shape ever changes; old tokens then fail. */
const TOKEN_VERSION = "v1";

/* -------------------------------------------------------------------------- */
/* Configuration — and the fail-closed rule                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why the console is refusing, when it is refusing for a configuration reason.
 *
 * `NOT_CONFIGURED` is the important one. An unset secret means NO AUTH under a
 * surprising number of designs, and that is exactly the shape this repo has
 * spent two days removing (`x-vercel-cron` granted everything; a missing key
 * once meant "skip the check"). Here an unset `CONSOLE_PASSWORD` means the
 * operator console is CLOSED, loudly, with the variable named on the page.
 */
export type ConsoleAuthRefusal =
  /** `CONSOLE_PASSWORD` is unset or empty in this environment. */
  | "NOT_CONFIGURED"
  /** No session cookie on the request. */
  | "NO_SESSION"
  /** A cookie was presented and its signature did not verify, or it was malformed. */
  | "BAD_SESSION"
  /** A correctly signed cookie whose expiry has passed. */
  | "EXPIRED_SESSION";

export type ConsoleAuthVerdict =
  | { readonly ok: true; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: ConsoleAuthRefusal };

/** The passphrase Saahith sets. Never logged, never defaulted, never printed. */
function consolePassword(): string | undefined {
  const value = process.env.CONSOLE_PASSWORD;
  return value === undefined || value === "" ? undefined : value;
}

/** True when this environment can gate the console at all. */
export function isConsoleAuthConfigured(): boolean {
  return consolePassword() !== undefined;
}

/**
 * The secret the session signature is computed under.
 *
 * `CONSOLE_SESSION_SECRET` if it is set — an independent key is strictly
 * better and a real deployment should set one. Otherwise the passphrase
 * itself, put through a context string so the key is not the passphrase.
 *
 * Deriving from the passphrase has a property worth having and worth naming:
 * ROTATING `CONSOLE_PASSWORD` INVALIDATES EVERY LIVE SESSION. With no session
 * store there is no other way to revoke one, so changing the passphrase is the
 * revocation mechanism this build has. It also means one variable for a human
 * to set, which is the difference between a gate that gets deployed and a gate
 * that gets skipped.
 */
function signingSecret(): string | undefined {
  const explicit = process.env.CONSOLE_SESSION_SECRET;
  if (explicit !== undefined && explicit !== "") return `${KEY_CONTEXT}|${explicit}`;
  const password = consolePassword();
  return password === undefined ? undefined : `${KEY_CONTEXT}|${password}`;
}

/* -------------------------------------------------------------------------- */
/* The token                                                                  */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return base64url(new Uint8Array(signature));
}

/**
 * Compare two signatures without an early return.
 *
 * Both operands are base64url of a fixed 32-byte digest, so they are the same
 * length whenever the signature is well-formed; the length is folded into the
 * accumulator rather than short-circuited on, so a wrong-length forgery takes
 * the same path as a wrong-value one. No `===` on the strings themselves,
 * which would return on the first differing byte.
 */
function signaturesMatch(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/**
 * Mint a session token. Called ONLY after the passphrase has been verified.
 *
 * The payload is an expiry and a nonce. It carries no identity because there
 * is none to carry: this build has one operator principal, and inventing a
 * subject claim that means nothing would be the half-built identity system
 * `docs/AUTH.md` argues against.
 */
export async function mintSession(now: number = Date.now()): Promise<string | null> {
  const secret = signingSecret();
  if (secret === undefined) return null;
  const expiresAt = now + SESSION_TTL_SECONDS * 1000;
  const payload = `${TOKEN_VERSION}.${expiresAt}.${crypto.randomUUID()}`;
  return `${payload}.${await hmac(secret, payload)}`;
}

/**
 * Verify a session token. The whole gate, and it fails closed at every step.
 *
 * Runs on the Edge (middleware) and on Node (the layout and the header). One
 * function, three runtimes, one answer — the rule `roles.ts` is written under.
 */
export async function verifySession(
  token: string | undefined,
  now: number = Date.now(),
): Promise<ConsoleAuthVerdict> {
  const secret = signingSecret();
  if (secret === undefined) return { ok: false, reason: "NOT_CONFIGURED" };
  if (token === undefined || token === "") return { ok: false, reason: "NO_SESSION" };

  const lastDot = token.lastIndexOf(".");
  if (lastDot <= 0) return { ok: false, reason: "BAD_SESSION" };
  const payload = token.slice(0, lastDot);
  const presented = token.slice(lastDot + 1);

  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { ok: false, reason: "BAD_SESSION" };
  }

  // The signature is checked BEFORE the expiry is read, so an unsigned token
  // can never reach the parsing of a field it controls.
  if (!signaturesMatch(presented, await hmac(secret, payload))) {
    return { ok: false, reason: "BAD_SESSION" };
  }

  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt)) return { ok: false, reason: "BAD_SESSION" };
  if (expiresAt <= now) return { ok: false, reason: "EXPIRED_SESSION" };

  return { ok: true, expiresAt };
}

/* -------------------------------------------------------------------------- */
/* The cookie                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The attributes every session cookie carries.
 *
 * `httpOnly` is the load-bearing one and it is the whole difference from
 * `corgi_demo_role`: a visitor — or a script running on the page — cannot
 * write this cookie, so the claim it carries is the server's and not theirs.
 *
 * `sameSite: "lax"` because the sign-in POST is a same-site form and the
 * console is navigated to by link; `secure` because the deployed origin is
 * HTTPS and a session cookie has no business on the wire in clear.
 */
export const SESSION_COOKIE_OPTIONS = {
  path: "/",
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  maxAge: SESSION_TTL_SECONDS,
} as const;

/** The same attributes, with the lifetime that deletes it. Used by sign-out. */
export const SESSION_COOKIE_CLEARED = {
  ...SESSION_COOKIE_OPTIONS,
  maxAge: 0,
} as const;

/* -------------------------------------------------------------------------- */
/* What a refused request is told                                             */
/* -------------------------------------------------------------------------- */

/** The code on the refusal, in the header and in the body. One word per cause. */
export const SIGN_IN_REQUIRED = "SIGN_IN_REQUIRED" as const;
export const CONSOLE_NOT_CONFIGURED = "CONSOLE_NOT_CONFIGURED" as const;

/** Where a signed-out visitor is sent, carrying where they were going. */
export const SIGN_IN_PATH = "/signin";

/**
 * Sanitise a `?next=` destination.
 *
 * Only a same-origin absolute path is ever honoured — no scheme, no host, no
 * protocol-relative `//evil`. An open redirect on a sign-in page is the oldest
 * phishing primitive there is, and the check is cheap.
 */
export function safeNext(candidate: string | undefined): string | null {
  if (candidate === undefined || candidate === "") return null;
  if (!candidate.startsWith("/")) return null;
  if (candidate.startsWith("//")) return null;
  if (candidate.startsWith("/signin")) return null;
  return candidate;
}
