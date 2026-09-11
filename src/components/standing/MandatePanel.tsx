import { randomUUID } from "node:crypto";

import { Note } from "@/components/ui/primitives";

import { CancelMandateForm, CreateMandateForm } from "./MandateForms";
import type { CancellableMandate, MandateAccountOption } from "./data-contract";

/**
 * The write half of `/standing-orders`, loaded on the server.
 *
 * WHY THE IMPORTS ARE DYNAMIC. Importing `@/lib/ledger/queries` evaluates
 * `@/lib/env`, which refuses to load without a full set of keys. That is right
 * for the application and wrong for a page that must be able to render the
 * words "no database configured", so the imports happen inside the branch that
 * has already established there is a database to read — the same reasoning as
 * `selectSource` in the page, and the same defect it was written to avoid.
 *
 * WHY THE MANDATE KEY IS MINTED HERE. `standing_order.mandate_key` is UNIQUE
 * and `createStandingOrder()` replays rather than duplicating. Minting the key
 * on the server, per render, means the key identifies THIS FILLED-IN FORM: two
 * presses of the same button, or a browser replaying the POST, carry the same
 * key and the second one writes nothing. A key minted in the browser at submit
 * time would be fresh on every attempt and would create a second mandate — the
 * exact duplicate the index exists to refuse.
 *
 * This component reads. It does not fire anything, and neither do the forms it
 * draws: they write one `standing_order` row, which is an authority for a
 * later cron tick and not a payment.
 */
export async function MandatePanel() {
  const [{ sql }, { listDepositAccounts }, { bookToday, listStandingOrders }] = await Promise.all([
    import("@/lib/ledger/db"),
    import("@/lib/ledger/queries"),
    import("@/lib/standing"),
  ]);

  let accounts: readonly MandateAccountOption[];
  let mandates: readonly CancellableMandate[];
  let bookDate: string;
  try {
    const [rows, orders, today] = await Promise.all([
      listDepositAccounts(sql),
      listStandingOrders(50),
      bookToday(),
    ]);
    accounts = rows.map((row) => ({
      accountId: row.accountId,
      legalName: row.legalName,
      accountName: row.accountName,
      currency: row.currency,
    }));
    mandates = orders
      .filter((order) => !order.cancelled)
      .map((order) => ({
        id: order.id,
        reference: order.reference,
        cadence: order.cadence,
        nextDueDate: order.nextDueDate,
      }));
    bookDate = today;
  } catch (error) {
    // Fail closed and say which read failed. A form drawn over a failed read
    // would offer an account list that is not the account list, and a mandate
    // written against a stale option is a payment aimed at the wrong payee.
    return (
      <Note emphasis title="The authorise form is not available — STANDING_FORM_UNREADABLE">
        <p>
          The accounts, mandates and book date this form is built from could not
          be read: {error instanceof Error ? error.message : String(error)}. No
          form is drawn, because a picker built over a failed read would be
          offering choices nobody checked. Nothing was written and no mandate
          changed.
        </p>
      </Note>
    );
  }

  return (
    <div className="space-y-6">
      <CreateMandateForm accounts={accounts} mandateKey={`console:${randomUUID()}`} bookDate={bookDate} />
      <CancelMandateForm mandates={mandates} />
    </div>
  );
}
