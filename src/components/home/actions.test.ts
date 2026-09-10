/**
 * The front door's server action, treated as the public POST endpoint it is.
 *
 * A server action is reachable by anyone who can send the same POST — the
 * rendered `<select>` is a convenience, not a constraint — so the only thing
 * that matters here is what happens to a value the form never offered. These
 * tests send the ones an attacker would: a traversal, a SQL fragment, a
 * `::uuid` cast bomb, an empty string. Every one of them must land on the
 * account directory, never be interpolated into a path.
 *
 * `redirect()` signals by throwing an error whose `digest` carries the target,
 * which is exactly what makes the destination assertable without a browser.
 */
import { describe, expect, it } from "vitest";

import { openAccountAction } from "./actions";

/** The path `redirect()` was called with, read out of the thrown digest. */
async function redirectTarget(accountId: string | null): Promise<string> {
  const form = new FormData();
  if (accountId !== null) form.set("accountId", accountId);

  try {
    await openAccountAction(form);
  } catch (thrown) {
    const digest = (thrown as { digest?: unknown }).digest;
    if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) {
      throw thrown;
    }
    // `NEXT_REDIRECT;push;/accounts/<id>;<type>;`
    const parts = digest.split(";");
    return parts[2] ?? "";
  }
  throw new Error("openAccountAction returned without redirecting");
}

const REAL = "a0c41a37-2be1-5c30-bfe9-03455f048fac";

describe("openAccountAction", () => {
  it("opens the account it was given", async () => {
    await expect(redirectTarget(REAL)).resolves.toBe(`/accounts/${REAL}`);
  });

  it("tolerates the whitespace a copy-paste brings with it", async () => {
    await expect(redirectTarget(`  ${REAL}\n`)).resolves.toBe(
      `/accounts/${REAL}`,
    );
  });

  it("sends anything that is not an account id to the directory", async () => {
    for (const hostile of [
      "",
      "   ",
      "not-a-uuid",
      "../../etc/passwd",
      "../approvals",
      `${REAL}/../../onboarding`,
      "' OR 1=1 --",
      "%2e%2e%2f",
      `${REAL}extra`,
      "00000000-0000-0000-0000-00000000000g",
      "<script>alert(1)</script>",
    ]) {
      await expect(
        redirectTarget(hostile),
        `${hostile} must not reach a path`,
      ).resolves.toBe("/accounts");
    }
  });

  it("sends a missing field to the directory rather than throwing", async () => {
    await expect(redirectTarget(null)).resolves.toBe("/accounts");
  });

  it("never reads anything but the account id from the form", async () => {
    // An actor id, a role, an amount: none of these are fields this action
    // reads, so a caller who adds them changes nothing. Identity and money
    // are decided by the screens that own them, against the database.
    const form = new FormData();
    form.set("accountId", REAL);
    form.set("actorId", "somebody-else");
    form.set("role", "approver");
    form.set("amountCents", "100000000");

    try {
      await openAccountAction(form);
    } catch (thrown) {
      const digest = (thrown as { digest?: unknown }).digest;
      expect(String(digest)).toContain(`/accounts/${REAL}`);
      return;
    }
    throw new Error("openAccountAction returned without redirecting");
  });
});
