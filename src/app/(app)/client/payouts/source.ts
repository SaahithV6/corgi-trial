import "server-only";

/**
 * Whether there is a book to read, and the read itself.
 *
 * The live module is imported DYNAMICALLY, for the reason
 * `src/app/(app)/client/sources.ts` states: importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * right for the app and wrong for a page whose job includes rendering the
 * sentence "this deployment has no database configured".
 *
 * The no-database answer here is a REFUSAL rather than an empty screen, and
 * that differs from the other five client screens on purpose. An empty balance
 * is a true statement about an account nobody has paid; an empty payouts page
 * would invite somebody to type an amount into a form whose Accept button
 * cannot reach a database. A named code and a sentence is the honest answer.
 */

import type { Loaded } from "@/components/client/contract";
import type { PayoutsScreen } from "@/components/client/payouts/contract";
import type { ClientView } from "@/components/client/view-state";

async function databaseAvailable(): Promise<boolean> {
  const { hasDatabase } = await import("../live-source");
  return hasDatabase();
}

export async function loadPayouts(view: ClientView): Promise<Loaded<PayoutsScreen>> {
  if (!(await databaseAvailable())) {
    return {
      ok: false,
      code: "NO_DATABASE",
      message:
        "This deployment has no database configured, so there is no account to quote against " +
        "and no offer could be written. Nothing here is a statement about anybody's money.",
    };
  }
  const { readPayoutsScreen } = await import("./live-read");
  return readPayoutsScreen(view.businessId);
}
