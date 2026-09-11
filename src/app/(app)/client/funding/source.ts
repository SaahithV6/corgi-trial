import "server-only";

/**
 * The live read behind `/client/funding`.
 *
 * ===========================================================================
 * TENANT ISOLATION IS A PREDICATE HERE, AS IT IS EVERYWHERE ON THIS SURFACE
 * ===========================================================================
 *
 * `src/app/(app)/client/live-source.ts` lists its ten readers and the `WHERE`
 * clause each one applies, and refuses to decide which customer a row belongs
 * to anywhere else. This file makes the same refusal and the same list:
 *
 *   readBalanceScreen(businessId)          -> resolveSubject, then
 *                                             availableBalance(businessId)
 *                                             -> ledger_availability()
 *   readLinkedBanks(businessId, conn)      WHERE i.business_id = $1
 *                                            AND i.purpose = 'funding'
 *   fundableAccountsFor(itemId, conn)      WHERE item_id = $1 AND fundable
 *
 * The deposits this screen lists are NOT read here. They are the
 * `uncleared_credit` holds `readBalanceScreen()` already returns, filtered to
 * the ones this rail opened — because `src/lib/ledger/boundary.test.ts` is
 * right that a screen has no business writing its own SELECT against
 * `journal_entry` / `journal_line` / `account`, and because a second reader of
 * the same rows is a second answer waiting to disagree with the first.
 *
 * There is not one `.filter()`, `.find()` or `if (row.businessId === …)` in
 * this file deciding which customer a row belongs to. `fundableAccountsFor()`
 * takes an `item_id` rather than a business id, and that is safe for exactly
 * one reason: the ids it is called with are the ones `readLinkedBanks()`
 * already returned from a statement whose predicate named this business. An id
 * that came out of a scoped query is not a claim.
 *
 * The subject is resolved by `readBalanceScreen()` rather than by a second copy
 * of "which business is this screen about", so `/client/funding` lands on the
 * same customer `/client` does for the same URL, and the five availability
 * terms on it are that screen's — read from `ledger_availability()`, the ONE
 * definition, and neither added to nor clamped here.
 *
 * ===========================================================================
 * WHAT IS NOT READ
 * ===========================================================================
 *
 * `plaid_item_secret` is not touched by this module. The state of an Item is
 * read from `v_plaid_item_state`, whose `has_live_token` is a boolean and
 * whose fold — `orphaned` / `revoked` / `needs_reauth` / `healthy` — is
 * migration 0056 §11's own `CASE`, not a second derivation in TypeScript. No
 * access token is read, rendered or logged on this path; the only function in
 * the codebase that reads one returns an opaque wrapper, and this file does not
 * call it.
 *
 * The live modules are imported DYNAMICALLY because importing them evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * right for the app and wrong for a page whose job includes rendering the words
 * "no database configured". `src/app/(app)/client/sources.ts` does the same.
 */

import type { HoldLine, Loaded } from "@/components/client/contract";
import type {
  ClientFundingScreen,
  LinkedBankLine,
  OriginatedDepositLine,
} from "@/components/client/funding/contract";
import { hasDatabase } from "@/lib/has-database";
import type { Sql } from "@/lib/ledger/db";
import type { PlaidItemState } from "@/lib/rails/plaid/item-store";

/** The `plaid_item` rows this business linked for funding, with their state. */
async function readLinkedBanks(
  businessId: string,
  conn: Sql,
): Promise<readonly Omit<LinkedBankLine, "accounts">[]> {
  const rows = await conn<
    {
      item_id: string;
      institution_name: string | null;
      state: string;
      linked_at: Date | null;
      last_observed_at: Date;
      last_error_code: string | null;
      last_error_message: string | null;
    }[]
  >`
    SELECT v.item_id, v.institution_name, v.state, v.linked_at,
           v.last_observed_at, v.last_error_code, v.last_error_message
      FROM v_plaid_item_state v
     WHERE v.business_id = ${businessId}::uuid
       AND v.purpose = 'funding'
     ORDER BY v.linked_at DESC NULLS LAST, v.item_id`;

  return rows.map((row) => ({
    itemId: row.item_id,
    institutionName: row.institution_name,
    state: row.state as PlaidItemState,
    linkedAt: row.linked_at === null ? null : row.linked_at.toISOString(),
    lastObservedAt: row.last_observed_at.toISOString(),
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
  }));
}

/**
 * Everything `/client/funding` renders, for one business.
 *
 * A failed read is a RESULT, not a throw: `Loaded` carries a code and a
 * sentence and the page renders the refusal panel. Nothing here is caught and
 * dropped — this module only reads, so a failure means the page could not be
 * drawn, never that money moved.
 */
export async function loadClientFunding(
  businessId: string | null,
  slow: boolean,
): Promise<Loaded<ClientFundingScreen>> {
  if (!hasDatabase()) {
    return {
      ok: false,
      code: "NO_DATABASE",
      message:
        "This deployment has no database configured, so there is nothing to read. That is not the same claim as “your account could not be read”.",
    };
  }

  try {
    const [{ readBalanceScreen }, { sql }, store, { PlaidClient }] = await Promise.all([
      import("../live-source"),
      import("@/lib/ledger/db"),
      import("@/lib/rails/plaid/item-store"),
      import("@/lib/rails/plaid/client"),
    ]);

    const balance = await readBalanceScreen(businessId);
    if (!balance.ok) return balance;
    const { header, terms } = balance.value;

    // `?state=loading` slows the READ, so the real skeleton is held open by a
    // genuinely slow query. It does not mock a slow render.
    if (slow) await new Promise((resolve) => setTimeout(resolve, 1200));

    const items = await readLinkedBanks(header.businessId, sql);

    // The money already pulled in, taken from the holds the balance reader
    // already returned. `plaid:` is the prefix `plaidExternalRef()` writes on
    // every hold this rail opens, so the filter is on the ref FORMAT and not on
    // which customer the row belongs to — that was decided by the predicate
    // inside `readBalanceScreen()`, before these rows existed.
    const deposits: readonly OriginatedDepositLine[] = balance.value.holds
      .filter(
        (hold: HoldLine) =>
          hold.kind === "uncleared_credit" && hold.externalRef.startsWith("plaid:"),
      )
      .map((hold: HoldLine) => ({
        holdId: hold.holdId,
        descriptor: hold.descriptor,
        externalRef: hold.externalRef,
        amountCents: hold.authorisedCents,
        remainingCents: hold.remainingCents,
        placedAt: hold.placedAt,
        availableAt: hold.availableAt,
        releaseWaitsOnAPerson: hold.releaseWaitsOnAPerson,
      }));

    const banks: readonly LinkedBankLine[] = await Promise.all(
      items.map(async (item) => ({
        ...item,
        // An Item that cannot be pulled from offers no accounts to pull from.
        // This is not cosmetic: showing a chooser under a broken Item invites
        // somebody to press a button that the write path will refuse anyway.
        accounts:
          item.state === "healthy"
            ? await store.fundableAccountsFor(item.itemId, sql).then((rows) =>
                rows.map((row) => ({
                  plaidAccountId: row.accountId,
                  name: row.name,
                  mask: row.mask,
                  subtype: row.subtype,
                  routingNumber: row.routingNumber,
                  authMethod: row.authMethod,
                })),
              )
            : [],
      })),
    );

    return {
      ok: true,
      value: {
        subject: {
          businessId: header.businessId,
          legalName: header.legalName,
          accountName: header.accountName,
          asOf: header.asOf,
          live: header.live,
          businesses: header.businesses,
        },
        banks,
        terms,
        deposits,
        plaidConfigured: new PlaidClient().configured,
      },
    };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      ok: false,
      code: "FUNDING_READ_FAILED",
      message: `Your linked banks could not be read. Nothing moved — every read on this screen is a SELECT. ${message.slice(0, 300)}`,
    };
  }
}
