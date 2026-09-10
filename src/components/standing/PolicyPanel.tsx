import { Panel } from "@/components/ui/primitives";

import type { StandingInvariants } from "./data-contract";

/**
 * The policy, on the screen rather than only in a document.
 *
 * The requirement asks for "a written policy for the day the balance cannot
 * cover them". docs/STANDING-ORDERS.md is that document and it makes the full
 * argument; this panel is the operative sentence, in front of the person who
 * has to answer the payee's phone call, next to the row they are answering
 * about. A policy nobody can find while the phone is ringing is not a policy.
 *
 * The invariant counts sit here too, because they are the same claim from the
 * other end: the policy says a refused occurrence is recorded rather than
 * dropped, and `unresolved` is the count of firings that got as far as a claim
 * and no further. Zero is the normal reading. Non-zero is safe and visible,
 * which is the whole bargain.
 */
export function PolicyPanel({ invariants }: { readonly invariants: StandingInvariants }) {
  return (
    <Panel
      title="What happens when the money is not there"
      description="The written policy, in the place it has to be readable — beside the row it explains."
    >
      <div className="grid gap-5 px-5 py-4 md:grid-cols-2">
        <div className="space-y-3 text-xs leading-relaxed text-muted">
          <p>
            <strong className="text-text">Refuse the occurrence and close it.</strong>{" "}
            No partial payment, no carry-forward to tomorrow, no queue that
            fires whenever the money happens to arrive. The next occurrence is
            unaffected and comes round on its own date.
          </p>
          <p>
            <strong className="text-text">Checked against AVAILABLE, not the ledger.</strong>{" "}
            Available = ledger − active card authorisations − uncleared credits.
            Money committed to a hold is already spent; money in a credit that
            can still be returned is not yet ours to send.
          </p>
          <p>
            <strong className="text-text">The refusal is a row, not a silence.</strong>{" "}
            Code, sentence, and the four balances as observed at the moment of
            the decision. &ldquo;It never fired and nobody knows why&rdquo; is
            the failure that actually hurts, and it is a MISSING row — so a
            refusal is a present one.
          </p>
        </div>

        <div className="space-y-3 text-xs leading-relaxed text-muted">
          <p>
            <strong className="text-text">Rejected: partial payment.</strong> A
            mandate says &ldquo;$4,000 on the 1st&rdquo;. Sending $2,613.44
            invents an instruction nobody authorised, will not match the payee&rsquo;s
            invoice, and turns a clean failure into a reconciliation break at
            both ends.
          </p>
          <p>
            <strong className="text-text">Rejected: carry forward until funded.</strong>{" "}
            Unbounded, and it makes the debit land on a day nobody chose, at a
            size nobody expected, possibly doubled against the next scheduled
            one. That is the 3am surprise.
          </p>
          <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3">
            <div>
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">
                Claimed, undecided
              </dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-text">
                {invariants.unresolved}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">
                Double fires
              </dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums text-text">
                {invariants.doubleFires}
              </dd>
            </div>
          </dl>
          <p className="text-[11px]">
            Both read from views in migration 0012 on every render. The second
            one cannot be non-zero while{" "}
            <code>payment_instruction.idempotency_key</code> is UNIQUE — which
            is the point of writing it down: its emptiness is a consequence of a
            constraint, not of anybody&rsquo;s discipline.
          </p>
        </div>
      </div>
    </Panel>
  );
}
