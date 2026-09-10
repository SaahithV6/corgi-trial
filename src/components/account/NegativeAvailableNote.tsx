import { Money } from "@/components/ui/Money";
import { Note } from "@/components/ui/primitives";

import type { AccountSummary, Hold } from "./data-contract";
import { isOverCaptured, overCaptureCents } from "./derive";

/**
 * Why the available balance is below zero, said out loud.
 *
 * A negative available balance is the state most likely to be reported as a
 * display bug, so the screen explains it at the point of the number: which
 * authorisation, what was authorised, what was captured, and why the hold is
 * correctly zero. §10 is explicit that available is not clamped — clamping
 * shows a number the business cannot spend against and quietly loses the
 * overdraft.
 */
export function NegativeAvailableNote({
  summary,
  holds,
}: {
  readonly summary: AccountSummary;
  readonly holds: readonly Hold[];
}) {
  if (summary.availableCents >= 0) return null;

  const overCaptured = holds.filter(isOverCaptured);
  const excessCents = overCaptured.reduce(
    (total, hold) => total + overCaptureCents(hold),
    0,
  );

  return (
    <Note emphasis title="Available balance is negative. This is not a display bug.">
      {overCaptured.length === 0 ? (
        <p>
          Settled postings have exceeded the balance and the account is
          overdrawn by <Money cents={-summary.availableCents} tone="neutral" />.
          The figure is shown unclamped: an available balance floored at zero
          would hide a debt the business owes and cannot be reconciled against
          the journal.
        </p>
      ) : (
        <>
          {overCaptured.map((hold) => (
            <p key={hold.id}>
              <span className="font-medium text-text">{hold.descriptor}</span>{" "}
              authorised <Money cents={hold.authorisedCents} tone="neutral" /> and
              was withheld from availability at that amount. The network then
              cleared <Money cents={hold.clearedCents} tone="neutral" /> — an
              over-capture of{" "}
              <Money cents={overCaptureCents(hold)} tone="neutral" />, which was
              never authorised and therefore never held.
            </p>
          ))}
          <p className="mt-2">
            The hold released to <Money cents={0} tone="neutral" /> because{" "}
            <span className="font-mono">H(E) = max(A − C, 0)</span> is zero once
            captures exceed authorisations, and the settled clearing took the
            full amount out of the ledger. The account is overdrawn by{" "}
            <Money cents={-summary.availableCents} tone="neutral" />, of which{" "}
            <Money cents={excessCents} tone="neutral" /> was never protected by a
            hold in the first place.
          </p>
          <p className="mt-2">
            Fuel pumps and restaurant tips are where this happens; the figures
            above are the ones measured against the card rail&rsquo;s sandbox in
            DECISIONS 006 ($50.00 authorised, $73.40 cleared, hold 0). The rail
            reports the authorisation as <span className="font-mono">SETTLED</span>{" "}
            — which is also what it reports while a partial hold is still live,
            so it is displayed and never acted on.
          </p>
        </>
      )}
    </Note>
  );
}
