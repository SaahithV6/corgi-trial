/**
 * The gate, proved rather than described.
 *
 * Every value in this file is generated at run time from `randomUUID()`. There
 * is no passphrase literal anywhere in this repository and there must never be
 * one: a test fixture that is also a real credential is how a secret gets
 * committed, and `.secretscanignore` is not a plan.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_CLEARED,
  SESSION_COOKIE_OPTIONS,
  isConsoleAuthConfigured,
  mintSession,
  safeNext,
  verifySession,
} from "./session";
import { verifyPassphrase } from "./password";

const PASSPHRASE = `test-${randomUUID()}`;

let saved: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  saved = process.env["CONSOLE_PASSWORD"];
  savedSecret = process.env["CONSOLE_SESSION_SECRET"];
  process.env["CONSOLE_PASSWORD"] = PASSPHRASE;
  delete process.env["CONSOLE_SESSION_SECRET"];
});

afterEach(() => {
  if (saved === undefined) delete process.env["CONSOLE_PASSWORD"];
  else process.env["CONSOLE_PASSWORD"] = saved;
  if (savedSecret === undefined) delete process.env["CONSOLE_SESSION_SECRET"];
  else process.env["CONSOLE_SESSION_SECRET"] = savedSecret;
});

describe("the passphrase check", () => {
  it("accepts the configured passphrase", () => {
    expect(verifyPassphrase(PASSPHRASE)).toEqual({ ok: true });
  });

  it("refuses everything else, with ONE reason and no oracle", () => {
    // A wrong value, a prefix, a longer value and the empty string all return
    // byte-identical verdicts. There is nothing in the result that separates
    // "wrong password" from "no such user", because there are no users.
    const refused = { ok: false, reason: "REFUSED" };
    expect(verifyPassphrase(`${PASSPHRASE}x`)).toEqual(refused);
    expect(verifyPassphrase(PASSPHRASE.slice(0, -1))).toEqual(refused);
    expect(verifyPassphrase("")).toEqual(refused);
    expect(verifyPassphrase(randomUUID())).toEqual(refused);
  });

  it("FAILS CLOSED when CONSOLE_PASSWORD is unset — an unset secret is not an open door", () => {
    delete process.env["CONSOLE_PASSWORD"];
    expect(isConsoleAuthConfigured()).toBe(false);
    // Note the reason: not `ok: true`, and not `REFUSED` either. The caller can
    // tell an administrator what to fix without telling a stranger anything.
    expect(verifyPassphrase(PASSPHRASE)).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
    expect(verifyPassphrase("")).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });

  it("refuses the empty passphrase as a CONFIGURATION, not as a credential", () => {
    process.env["CONSOLE_PASSWORD"] = "";
    expect(isConsoleAuthConfigured()).toBe(false);
    expect(verifyPassphrase("")).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
  });
});

describe("the session token", () => {
  it("round-trips a freshly minted session", async () => {
    const token = await mintSession();
    expect(token).not.toBeNull();
    const verdict = await verifySession(token ?? undefined);
    expect(verdict.ok).toBe(true);
  });

  it("carries no secret — the passphrase never reaches the browser", async () => {
    const token = (await mintSession()) ?? "";
    expect(token).not.toContain(PASSPHRASE);
    expect(token.length).toBeGreaterThan(40);
  });

  it("refuses a FORGED token: right shape, wrong signature", async () => {
    const forged = `v1.${Date.now() + 3_600_000}.${randomUUID()}.${Buffer.from(
      randomUUID(),
    ).toString("base64url")}`;
    expect(await verifySession(forged)).toEqual({ ok: false, reason: "BAD_SESSION" });
  });

  it("refuses an EDITED token: valid signature, expiry pushed out", async () => {
    // The attack a naive scheme loses to. Take a real token, move the expiry
    // into the future, keep the signature. The signature is over the payload,
    // so editing the payload invalidates it — and the signature is checked
    // BEFORE the expiry is parsed, so the edited field never gets read.
    const token = (await mintSession()) ?? "";
    const [, , nonce, signature] = token.split(".");
    const edited = `v1.${Date.now() + 999_999_999}.${nonce}.${signature}`;
    expect(await verifySession(edited)).toEqual({ ok: false, reason: "BAD_SESSION" });
  });

  it("refuses a token signed under a DIFFERENT passphrase", async () => {
    const token = (await mintSession()) ?? "";
    process.env["CONSOLE_PASSWORD"] = `rotated-${randomUUID()}`;
    // This is also the revocation mechanism: rotating the passphrase ends
    // every live session, because the signing key is derived from it.
    expect(await verifySession(token)).toEqual({ ok: false, reason: "BAD_SESSION" });
  });

  it("refuses an EXPIRED token, and says which", async () => {
    const token = (await mintSession(Date.now() - 9 * 60 * 60 * 1000)) ?? "";
    expect(await verifySession(token)).toEqual({ ok: false, reason: "EXPIRED_SESSION" });
  });

  it("refuses no cookie, an empty cookie and rubbish", async () => {
    expect(await verifySession(undefined)).toEqual({ ok: false, reason: "NO_SESSION" });
    expect(await verifySession("")).toEqual({ ok: false, reason: "NO_SESSION" });
    expect(await verifySession("nonsense")).toEqual({ ok: false, reason: "BAD_SESSION" });
    expect(await verifySession("v2.1.2.3")).toEqual({ ok: false, reason: "BAD_SESSION" });
  });

  it("FAILS CLOSED with no CONSOLE_PASSWORD, even for a token it once signed", async () => {
    const token = (await mintSession()) ?? "";
    delete process.env["CONSOLE_PASSWORD"];
    expect(await verifySession(token)).toEqual({ ok: false, reason: "NOT_CONFIGURED" });
    expect(await mintSession()).toBeNull();
  });

  it("honours an independent CONSOLE_SESSION_SECRET when one is set", async () => {
    process.env["CONSOLE_SESSION_SECRET"] = randomUUID();
    const token = (await mintSession()) ?? "";
    expect((await verifySession(token)).ok).toBe(true);
    // And a session signed under the independent key does not survive its
    // removal, which is what makes it independent rather than decorative.
    delete process.env["CONSOLE_SESSION_SECRET"];
    expect(await verifySession(token)).toEqual({ ok: false, reason: "BAD_SESSION" });
  });
});

describe("the cookie", () => {
  it("is httpOnly, secure and sameSite=lax — the properties the role cookie lacks", () => {
    expect(SESSION_COOKIE_OPTIONS.httpOnly).toBe(true);
    expect(SESSION_COOKIE_OPTIONS.secure).toBe(true);
    expect(SESSION_COOKIE_OPTIONS.sameSite).toBe("lax");
    expect(SESSION_COOKIE_OPTIONS.path).toBe("/");
    expect(SESSION_COOKIE_OPTIONS.maxAge).toBeGreaterThan(0);
  });

  it("is deleted by sign-out with the same attributes, so the browser matches it", () => {
    expect(SESSION_COOKIE_CLEARED.maxAge).toBe(0);
    expect(SESSION_COOKIE_CLEARED.path).toBe(SESSION_COOKIE_OPTIONS.path);
    expect(SESSION_COOKIE_CLEARED.httpOnly).toBe(true);
  });
});

describe("the ?next= destination", () => {
  it("keeps a same-origin path", () => {
    expect(safeNext("/accounts")).toBe("/accounts");
    expect(safeNext("/accounts?state=empty")).toBe("/accounts?state=empty");
  });

  it("refuses anything that could leave this origin", () => {
    // An open redirect on a sign-in page is the oldest phishing primitive
    // there is: the link is genuinely ours and the landing page is not.
    expect(safeNext("//evil.example")).toBeNull();
    expect(safeNext("https://evil.example")).toBeNull();
    expect(safeNext("javascript:alert(1)")).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext("")).toBeNull();
  });

  it("refuses /signin itself, so a successful sign-in never loops back to the form", () => {
    expect(safeNext("/signin")).toBeNull();
    expect(safeNext("/signin?next=/accounts")).toBeNull();
  });
});
