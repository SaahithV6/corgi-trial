import "server-only";

/**
 * The live read behind `/client/pots`.
 *
 * ===========================================================================
 * THREE READERS, ALL OF THEM ALREADY WRITTEN
 * ===========================================================================
 *
 *   readBalanceScreen(businessId)   -> resolves the subject, then
 *                                      availableBalance() -> ledger_availability()
 *   listPots(businessId, conn)      WHERE pb.business_id = $1
 *   readIdentity(businessId, conn)  WHERE i.business_id = $1
 *
 * Every one of them takes the business id as an ARGUMENT that becomes a
 * `WHERE` clause inside Postgres. There is not one `.filter()`, `.find()` or
 * `if (row.businessId === …)` in this file deciding which customer a row
 * belongs to. A predicate is evaluated before the rows exist; a filter is a
 * step in a program, and steps get reordered or dropped by whoever next edits
 * the paging logic.
 *
 * The subject is resolved by `readBalanceScreen()` rather than by a fourth
 * copy of "which business is this screen about", so `/client/pots` lands on
 * the same customer `/client` does for the same URL, and the header, the
 * business switcher and the five availability terms are all the ones that
 * screen already computes.
 *
 * ===========================================================================
 * ONE DEFINITION OF AVAILABLE
 * ===========================================================================
 *
 * The five terms on this screen are `readBalanceScreen()`'s, untouched. This
 * file does not add, subtract or clamp any of them. The only arithmetic
 * anywhere near this feature is `identityOf()` in `@/lib/pots/model`, which
 * exists precisely to CHECK a sum rather than to define one, and it is a pure
 * function with a unit test.
 *
 * ===========================================================================
 * WHY THE LIVE MODULES ARE IMPORTED DYNAMICALLY
 * ===========================================================================
 *
 * Importing them evaluates `src/lib/env.ts`, which refuses to load without a
 * full set of keys. That is right for the app and wrong for a page whose job
 * includes rendering the words "no database configured".
 * `src/app/(app)/client/sources.ts` does the same thing for the same reason.
 */

import type { Loaded } from "@/components/client/contract";
import type { ClientPotsScreen, PotLine } from "@/components/client/pots/contract";
import { hasDatabase } from "@/lib/has-database";
import { identityOf } from "@/lib/pots/model";

/**
 * Read this business's pots, their balances, and the identity that checks them.
 *
 * A failed read is a RESULT, not a throw: `Loaded` carries a code and a
 * sentence and the page renders the refusal panel. Nothing here is caught and
 * dropped — this screen only reads, so a failure means the page cannot be
 * drawn, never that money moved.
 */
export async function loadClientPots(
  businessId: string | null,
  slow: boolean,
): Promise<Loaded<ClientPotsScreen>> {
  if (!hasDatabase()) {
    return {
      ok: false,
      code: "NO_DATABASE",
      message:
        "This deployment has no database configured, so there is nothing to read. That is not the same claim as “your account could not be read”.",
    };
  }

  try {
    const [{ readBalanceScreen }, { sql }, store] = await Promise.all([
      import("../live-source"),
      import("@/lib/ledger/db"),
      import("@/lib/pots/store"),
    ]);

    const balance = await readBalanceScreen(businessId);
    if (!balance.ok) return balance;
    const { header, terms } = balance.value;

    // `?state=loading` slows the READ so the real skeleton is held open by a
    // genuinely slow query. It does not mock a slow render.
    if (slow) await new Promise((resolve) => setTimeout(resolve, 1200));

    const [rows, identityRow] = await Promise.all([
      store.listPots(header.businessId, sql),
      store.readIdentity(header.businessId, sql),
    ]);

    const pots: readonly PotLine[] = rows.map((row) => ({
      potId: row.potId,
      name: row.name,
      purpose: row.purpose,
      balanceCents: row.balanceCents,
      accountCode: row.accountCode,
      openedAt: row.openedAt.toISOString(),
    }));

    // `identityOf()` re-derives `main + Σ pots` here rather than trusting the
    // view's own `total_cents`, which is the entire point of it: the screen
    // shows two independent routes to one number and the difference between
    // them, so a reader checks the arithmetic instead of a green tick.
    const identity =
      identityRow === null
        ? null
        : identityOf(
            identityRow.mainCents,
            rows.map((row) => ({
              potId: row.potId,
              name: row.name,
              balanceCents: row.balanceCents,
            })),
            identityRow.subtreeCents,
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
        pots,
        terms,
        identity,
      },
    };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      ok: false,
      code: "POTS_READ_FAILED",
      message: `Your pots could not be read. Nothing moved — every read on this screen is a SELECT. ${message.slice(0, 300)}`,
    };
  }
}
