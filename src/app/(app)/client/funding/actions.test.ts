/**
 * The customer's funding actions, DRIVEN — not described.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ This suite CALLS the server actions and writes real rows to the live     │
 * │ database. Gated on RUN_DB_TESTS=1, and it only ever touches the fixture  │
 * │ businesses (EIN `00-000000N`); no seeded customer is written to.         │
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run \             │
 * │     src/app/\(app\)/client/funding/actions.test.ts                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * WHY A TEST AND NOT `curl`. A Next 16 server action is not a URL you can POST
 * to by hand — it is reached through an encrypted action id the framework mints
 * at build time — so `curl` proves nothing about it. Importing the module and
 * calling the exported function is the only way to drive the real code path,
 * and it is the pattern `src/components/home/actions.test.ts` established.
 *
 * It is also the ONLY way to catch the `"use server"` export trap while it is
 * still cheap: a module that exports a constant typechecks perfectly and throws
 * on first render in a browser. Importing it here is what makes that a red test
 * instead of a blank screen.
 */

import { describe, expect, it } from "vitest";

import { FUNDING_IDLE } from "@/components/client/funding/action-state";

import { fundFromLinkedBankAction, linkClientBankAction } from "./actions";

const RUN =
  process.env["RUN_DB_TESTS"] === "1" &&
  typeof process.env["DATABASE_URL"] === "string" &&
  process.env["DATABASE_URL"].length > 0;

const suite = RUN ? describe : describe.skip;

/** KYB approved, has a 2100 deposit leaf and a 9200 hold leaf. EIN 00-0000001. */
const FIXTURE = "7e57b115-0000-5000-a000-0000000000f2";
/** KYB `pending`, so the gate must refuse it. EIN 00-0000000. */
const UNVERIFIED = "7e57b115-0000-5000-a000-000000000001";
function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

suite("the customer's funding actions", () => {
  /**
   * Linked once, at the top, and every later test funds from the SAME Item —
   * because that is the property migration 0056 bought and the thing the
   * operator screen could not do: an Item that survives the request that
   * created it.
   */
  let itemId = "";
  let plaidAccountId = "";

  it("links a bank the customer chose, and persists it", async () => {
    const linked = await linkClientBankAction(
      FUNDING_IDLE,
      form({ businessId: FIXTURE }),
    );

    expect(linked.status).toBe("posted");
    const connection = linked.facts.find((f) => f.label === "Connection");
    expect(connection?.value).toMatch(/^[A-Za-z0-9]{20,}$/);
    itemId = connection?.value ?? "";

    // NOTHING PRINTED IS KEY MATERIAL. An access token is `access-sandbox-…`;
    // the wrapper's `toJSON()` is `[redacted]`, and nothing on this path reads
    // one at all. Assert it over the whole receipt rather than field by field.
    const printed = JSON.stringify(linked);
    expect(printed).not.toContain("access-");
    expect(printed).not.toContain("access_token");
  }, 60_000);

  it("offers the accounts an ACH debit can actually be pulled from", async () => {
    const { fundableAccountsFor } = await import("@/lib/rails/plaid/item-store");
    const accounts = await fundableAccountsFor(itemId);

    // Checking, savings and cash management have ACH numbers. A mortgage and a
    // credit card do not, and are not offered.
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.map((a) => a.subtype)).not.toContain("mortgage");
    plaidAccountId = accounts[0]?.accountId ?? "";
    expect(plaidAccountId).not.toBe("");
  }, 30_000);

  it("funds the balance, and withholds every cent of it from available", async () => {
    const { availableBalance } = await import("@/lib/ledger/balances");
    const before = await availableBalance(FIXTURE);

    const reference = `client-test-${Date.now()}`;
    const posted = await fundFromLinkedBankAction(
      FUNDING_IDLE,
      form({
        businessId: FIXTURE,
        itemId,
        plaidAccountId,
        amount: "2,500.00",
        reference,
      }),
    );

    expect(posted.status).toBe("posted");
    expect(posted.code).toBeNull();
    expect(posted.message).toContain("available balance has not moved");

    const after = await availableBalance(FIXTURE);

    // THE WHOLE POINT OF THE SCREEN, AS ARITHMETIC. The ledger moves by the
    // deposit; available does not move at all, because the identical amount is
    // withheld by the `uncleared_credit` hold the library opened.
    expect(after.ledgerCents - before.ledgerCents).toBe(250000n);
    expect(after.unclearedCents - before.unclearedCents).toBe(250000n);
    expect(after.availableCents).toBe(before.availableCents);

    // The row says what did NOT happen, and the screen repeats the row.
    expect(posted.message).toContain("No ACH entry was sent to any network");

    // A second press of the same button books ONE deposit. Three unique
    // indexes decide that, not an `if` on this page.
    const replay = await fundFromLinkedBankAction(
      FUNDING_IDLE,
      form({
        businessId: FIXTURE,
        itemId,
        plaidAccountId,
        amount: "2,500.00",
        reference,
      }),
    );
    expect(replay.code).toBe("ALREADY_FUNDED");
    const settled = await availableBalance(FIXTURE);
    expect(settled.ledgerCents).toBe(after.ledgerCents);
  }, 60_000);

  it("refuses a linked bank that belongs to somebody else, in the same words as one that does not exist", async () => {
    const stolen = await fundFromLinkedBankAction(
      FUNDING_IDLE,
      form({
        businessId: UNVERIFIED,
        itemId,
        plaidAccountId,
        amount: "100.00",
        reference: "theft",
      }),
    );
    const invented = await fundFromLinkedBankAction(
      FUNDING_IDLE,
      form({
        businessId: UNVERIFIED,
        itemId: "MnotARealItem0000000000000000000000",
        plaidAccountId: "notARealAccount000000000000000000000",
        amount: "100.00",
        reference: "fishing",
      }),
    );

    expect(stolen.status).toBe("refused");
    expect(stolen.code).toBe("BANK_NOT_ON_THIS_BUSINESS");
    // Identical, so the form cannot be used as an oracle for which ids are real.
    expect(stolen.message).toBe(invented.message);
  }, 30_000);

  it("refuses a business nobody has verified, with the KYB vocabulary verbatim", async () => {
    // The claim is a REAL item id owned by a REAL other customer, pointed at a
    // business that has not passed KYB. Two reasons to refuse; the ownership
    // predicate is the first one reached, which is the correct order —
    // ownership is cheaper than the gate and leaks less.
    const refused = await fundFromLinkedBankAction(
      FUNDING_IDLE,
      form({
        businessId: UNVERIFIED,
        itemId: "MJwjyAyqGbtE688WL1ZLu67yaw44BRiDmRG5b",
        plaidAccountId: "nvpMyKyE1gCoxppykMQkuaZaa8l3qNT6k94n8",
        amount: "100.00",
        reference: "unverified",
      }),
    );
    expect(refused.status).toBe("refused");
    expect(refused.code).toBe("BANK_NOT_ON_THIS_BUSINESS");

    // And the gate itself, reached on a bank that IS theirs.
    const linked = await linkClientBankAction(
      FUNDING_IDLE,
      form({ businessId: UNVERIFIED }),
    );
    expect(linked.status).toBe("posted");
    const theirItem = linked.facts.find((f) => f.label === "Connection")?.value ?? "";
    const { fundableAccountsFor } = await import("@/lib/rails/plaid/item-store");
    const theirAccount = (await fundableAccountsFor(theirItem))[0]?.accountId ?? "";

    const gated = await fundFromLinkedBankAction(
      FUNDING_IDLE,
      form({
        businessId: UNVERIFIED,
        itemId: theirItem,
        plaidAccountId: theirAccount,
        amount: "100.00",
        reference: `gate-${Date.now()}`,
      }),
    );
    expect(gated.status).toBe("refused");
    expect(gated.code).toMatch(/^KYB_/);
  }, 90_000);

  it("will not read an amount it would have to round", async () => {
    for (const amount of ["-100", "1e3", "10.001", "", "100 dollars"]) {
      const refused = await fundFromLinkedBankAction(
        FUNDING_IDLE,
        form({ businessId: FIXTURE, itemId, plaidAccountId, amount, reference: "r" }),
      );
      expect(refused.code).toBe("AMOUNT_UNREADABLE");
    }
  }, 30_000);

  /**
   * THE STATE THIS BOOK ALREADY CARRIES, DRIVEN RATHER THAN DESCRIBED.
   *
   * `ITEM_LOGIN_REQUIRED` is already on this deployment — one Item was reset on
   * purpose and kept as a fixture — but that Item belongs to nobody, so the
   * scoped read on this screen cannot see it and the refusal it produces could
   * not be reached through the action. Rather than re-parent a fixture row to
   * fake the condition, this makes the condition FOR REAL on a throwaway Item
   * this fixture business owns:
   *
   *   POST /sandbox/item/reset_login   -> 200 {"reset_login": true}
   *   POST /item/get                   -> 200, error_code ITEM_LOGIN_REQUIRED
   *
   * `refreshItemState()` is the library call that makes the second one and
   * appends what it says, so `v_plaid_item_state` folds the Item to
   * `needs_reauth` by migration 0056 §11's own CASE — not by anything this test
   * asserted into place. There is no un-reset; the Item stays broken, which is
   * exactly why it is a throwaway and not the one anything was funded from.
   */
  it("tells a customer whose connection broke that a HUMAN has to sign in again", async () => {
    const [{ liveAccessTokenFor, refreshItemState }, { revealAccessToken }, { PlaidClient }] =
      await Promise.all([
        import("@/lib/rails/plaid/item-store"),
        import("@/lib/rails/plaid/secret"),
        import("@/lib/rails/plaid/client"),
      ]);

    const linked = await linkClientBankAction(FUNDING_IDLE, form({ businessId: FIXTURE }));
    const throwaway = linked.facts.find((f) => f.label === "Connection")?.value ?? "";
    expect(throwaway).not.toBe("");

    const client = new PlaidClient();
    const token = await liveAccessTokenFor(throwaway);
    expect(token).not.toBeNull();
    // The ONE place a token is revealed, and it is revealed to Plaid. The
    // wrapper masks everything after the prefix in `toString()` and serialises
    // as `[redacted]`, so neither a log line nor a React payload can carry it.
    expect(String(token)).toBe("access-sandbox-***");
    expect(JSON.stringify(token)).toBe('"[redacted]"');
    await client.sandboxResetLogin(revealAccessToken(token!));

    const refreshed = await refreshItemState(throwaway, { client });
    expect(refreshed.state).toBe("needs_reauth");
    expect(refreshed.errorCode).toBe("ITEM_LOGIN_REQUIRED");

    const { fundableAccountsFor } = await import("@/lib/rails/plaid/item-store");
    const account = (await fundableAccountsFor(throwaway))[0]?.accountId ?? "";

    const told = await fundFromLinkedBankAction(
      FUNDING_IDLE,
      form({
        businessId: FIXTURE,
        itemId: throwaway,
        plaidAccountId: account,
        amount: "500.00",
        reference: `reauth-${Date.now()}`,
      }),
    );

    expect(told.status).toBe("refused");
    expect(told.code).toBe("needs_reauth");
    // In the customer's own words, and it names WHO has to act.
    expect(told.message).toContain("A PERSON HAS TO DO");
    expect(told.message).toContain("ITEM_LOGIN_REQUIRED");
    expect(told.message).toContain("waiting will not clear it");
    expect(told.message).toContain("Your money is untouched");

    // And the screen's own read agrees, through the scoped predicate.
    const { loadClientFunding } = await import("./source");
    const screen = await loadClientFunding(FIXTURE, false);
    expect(screen.ok).toBe(true);
    if (screen.ok) {
      const bank = screen.value.banks.find((b) => b.itemId === throwaway);
      expect(bank?.state).toBe("needs_reauth");
      // A broken connection offers nothing to pull from.
      expect(bank?.accounts).toEqual([]);
    }
  }, 120_000);
});
