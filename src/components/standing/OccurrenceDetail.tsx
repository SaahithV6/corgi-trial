import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";
import { formatDate, formatTimestamp } from "@/lib/format/datetime";

import type { OccurrenceRow } from "./data-contract";
import { standingHref, type StandingFilter } from "./view-state";

/**
 * One occurrence, in full.
 *
 * The panel exists for one figure: the AVAILABLE balance at the moment of the
 * decision, shown as the arithmetic that produced it rather than as a number to
 * be taken on trust.
 *
 *     ledger  −  card holds  −  uncleared credits  =  available
 *
 * All four are read off the outcome row, where the firing routine wrote them,
 * AS OBSERVED. They are deliberately not re-derived on this render. Re-deriving
 * them tomorrow answers a different question — "what is the balance now" — and
 * would quietly rewrite the reason a payment was refused, which is precisely
 * the kind of retroactive edit this whole system exists to make impossible.
 *
 * When the ledger on its own would have covered the payment, the panel says so
 * in as many words. That is the case the customer rings up about: "there was
 * twenty grand in the account and you did not pay my rent." The honest answer
 * is that most of it was committed to a card authorisation that had not settled
 * and to a credit that could still be pulled back, and neither is spendable.
 */
export function OccurrenceDetail({
  row,
  filter,
  accountId,
}: {
  readonly row: OccurrenceRow;
  readonly filter: StandingFilter;
  /**
   * The account the mandate debits, when the caller could resolve it from the
   * mandate list on the same render. `null` when it could not — the occurrence
   * row does not carry it, and a link that might be to the wrong account is
   * worse than no link.
   */
  readonly accountId?: string | null;
}) {
  const hasFigures = row.observedAvailableCents !== null;

  return (
    <Panel
      id="occurrence"
      title={`${row.reference} · due ${formatDate(row.scheduledDate)}`}
      description={
        row.disposition === "raised"
          ? "Raised into the approvals queue through requestPayment(), the same function a human-initiated payment goes through."
          : row.disposition === "refused"
            ? "Attempted and refused. The occurrence is closed and is not carried forward; the next one is unaffected."
            : "Claimed and not yet decided. Nothing moved."
      }
      actions={
        <Link
          href={standingHref(filter, { occurrenceId: null })}
          className={`rounded px-2 py-1 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
        >
          Close
        </Link>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <MetaList
          items={[
            { label: "occurrence", value: <span className="font-mono text-[11px]">{row.occurrenceId}</span> },
            { label: "idempotency key", value: <span className="font-mono text-[11px]">{row.idempotencyKey}</span> },
            { label: "claimed", value: formatTimestamp(row.claimedAt) },
            {
              label: "decided",
              value: row.decidedAt === null ? "—" : formatTimestamp(row.decidedAt),
            },
            { label: "run", value: <span className="font-mono text-[11px]">{row.decidedByRun ?? row.claimedBy}</span> },
          ]}
        />

        {hasFigures ? (
          <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
            <p className="text-xs font-semibold">
              The balance this decision was made against, as observed
            </p>
            <dl className="mt-3 grid max-w-md gap-y-1.5 text-sm">
              <Figure label="Ledger balance" cents={row.observedLedgerCents} />
              <Figure label="Less card authorisations" cents={negate(row.observedHoldsCents)} />
              <Figure label="Less uncleared credits" cents={negate(row.observedUnclearedCents)} />
              <div className="mt-1 flex items-baseline justify-between border-t border-border pt-1.5">
                <dt className="text-xs font-semibold">Available</dt>
                <dd className="text-sm font-semibold">
                  <Money cents={row.observedAvailableCents ?? 0} tone="auto" />
                </dd>
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <dt className="text-xs text-muted">Amount due</dt>
                <dd className="text-sm">
                  <Money cents={row.amountCents} tone="neutral" />
                </dd>
              </div>
              {row.shortfallCents === null ? null : (
                <div className="flex items-baseline justify-between">
                  <dt className="text-xs text-muted">Shortfall</dt>
                  <dd className="text-sm text-negative">
                    <Money cents={row.shortfallCents} tone="neutral" />
                  </dd>
                </div>
              )}
            </dl>
          </div>
        ) : (
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            No balances were recorded on this occurrence. That is expected on a
            raised payment: the funds check passed, the instruction carries the
            amount and the value date, and storing a snapshot of a balance that
            was merely sufficient would be a stored number with no question to
            answer.
          </p>
        )}

        {row.ledgerWouldHaveCovered ? (
          <Note emphasis title="The ledger covered this payment. The available balance did not.">
            <p>
              This is the refusal worth understanding, and it is not a bug.{" "}
              <strong>Available = ledger − active card holds − uncleared credits.</strong>{" "}
              A card authorisation is money the customer has already committed:
              a $50 fuel-pump hold that has not settled is not spendable, and
              paying rent out of it creates an overdraft nobody agreed to on the
              day the pump captures. An uncleared credit can still be taken back
              — ACH gives the originator days to return it — and a standing
              order leaves on a rail that is slower to recall than the credit
              is, so funding one from it is lending.
            </p>
            <p className="mt-2">
              A system that checked the ledger balance here would have paid, and
              would have been wrong on both counts.
            </p>
          </Note>
        ) : null}

        {row.disposition === "refused" ? (
          <div>
            <p className="text-xs font-semibold">
              Refusal · <span className="font-mono">{row.refusalCode}</span>
            </p>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              {row.refusalReason}
            </p>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              What to do about it: this occurrence is closed and will not be retried, so paying
              this one takes a fresh payment on <Link href="/payments" className={`underline underline-offset-4 ${FOCUS_RING}`}>/payments</Link>, which goes
              through the same approvals queue. To stop the next occurrence refusing for the same
              reason, the available balance is what has to change, and{" "}
              {accountId === null || accountId === undefined ? (
                <>the account&rsquo;s own page breaks down where the withheld money is</>
              ) : (
                <Link
                  href={`/accounts/${accountId}`}
                  className={`underline underline-offset-4 ${FOCUS_RING}`}
                >
                  the account&rsquo;s own page
                </Link>
              )}{" "}
              — it lists every hold and uncleared credit standing between the ledger balance and
              the available one, with the date each releases.
            </p>
          </div>
        ) : null}

        {row.instructionId === null ? null : (
          <div>
            <p className="text-xs font-semibold">Payment instruction</p>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
              <span className="font-mono">{row.instructionId}</span> — raised
              through <code>requestPayment()</code>, so it cites the approval
              policy version in force on its value date, carries a content hash,
              and passed the KYB gate. The person who set this mandate up is its{" "}
              <code>requested_by</code>, which means the database will refuse
              their approval of it.{" "}
              <Link href="/approvals" className={`underline underline-offset-4 ${FOCUS_RING}`}>
                Open the approvals queue
              </Link>
              . That queue lists payments raised and not yet released, so it does not carry an
              instruction id to match on and it drops a payment once somebody releases it — an
              instruction missing from it has been released or rejected, not lost.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

function negate(cents: number | null): number | null {
  return cents === null ? null : -cents;
}

function Figure({
  label,
  cents,
}: {
  readonly label: string;
  readonly cents: number | null;
}) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="text-sm">
        {cents === null ? "—" : <Money cents={cents} tone="neutral" />}
      </dd>
    </div>
  );
}
