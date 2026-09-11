import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";
import type { AccountsOpenedView } from "@/app/(app)/onboarding/actions";

/**
 * ============================================================================
 * WHAT APPROVAL DID TO THE CHART OF ACCOUNTS.
 *
 * Rendered underneath whichever verb caused it, on the same response, because
 * the sentence this whole feature exists to make true is a CAUSAL one — "the
 * account opened because the check passed" — and a causal claim shown on a
 * different screen, after a refresh, is a claim the reader has to take on
 * trust.
 *
 * FOUR OUTCOMES, ALL PRINTED, INCLUDING THE BORING ONES:
 *
 *   opened    the interesting case. Names the three leaves and links the
 *             deposit account, which is now a real row a person can open.
 *   already   the SECOND press. It says so explicitly and names the constraint
 *             that refused the duplicate, because "opening twice opens once"
 *             is a property somebody will try in the debrief and it should be
 *             visible when they do rather than inferred from an absence.
 *   not_yet   the business is not approved. This is the gate working, not a
 *             step that failed, and it is styled as information rather than as
 *             an error for exactly that reason.
 *   failed    the KYB row landed and the account machinery did not. Said
 *             plainly, with the reassurance that matters: the observation is
 *             on file, it is append-only, and a retry is safe.
 *
 * THIS COMPONENT DECIDES NOTHING. Every sentence arrives already written by
 * the server action, from the outcome the database returned. A screen that
 * could compose its own account-opening story could compose a flattering one.
 * ============================================================================
 */
export function OpenedAccounts({ accounts }: { readonly accounts: AccountsOpenedView }) {
  const tone =
    accounts.kind === "opened"
      ? "positive"
      : accounts.kind === "failed"
        ? "negative"
        : "quiet";

  const heading =
    accounts.kind === "opened"
      ? "Accounts opened"
      : accounts.kind === "already"
        ? "Already open — nothing opened twice"
        : accounts.kind === "not_yet"
          ? "No accounts — not approved"
          : "Accounts did not open";

  return (
    <div className="mt-2 rounded-md border border-border bg-surface-raised px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h5 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Chart of accounts
        </h5>
        <Badge tone={tone}>{heading}</Badge>
      </div>

      <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">{accounts.message}</p>

      {accounts.leaves.length === 0 ? null : (
        <ul className="mt-2 space-y-1 text-[11px] leading-relaxed">
          {accounts.leaves.map((leaf) => (
            <li key={leaf.accountId} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-text">{leaf.code}</span>
              {leaf.accountId === accounts.depositAccountId ? (
                <Link
                  href={`/accounts/${leaf.accountId}`}
                  className={`text-text underline underline-offset-4 ${FOCUS_RING}`}
                >
                  {leaf.name}
                </Link>
              ) : (
                <span className="text-muted">{leaf.name}</span>
              )}
              <span className={leaf.opened ? "text-positive" : "text-muted"}>
                {leaf.opened ? "opened by this decision" : "already open"}
              </span>
              <span className="font-mono text-muted">{leaf.accountId}</span>
            </li>
          ))}
        </ul>
      )}

      {accounts.kind === "opened" ? (
        <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
          Every one of those accounts has a balance of <span className="font-mono">$0.00</span>, and
          it is zero <em>by construction</em> rather than because something wrote a zero: opening an
          account posts nothing to the journal, and a balance in this system is{" "}
          <span className="font-mono">SUM(journal_line)</span> over the account. The first money to
          move is the first entry.
        </p>
      ) : null}
    </div>
  );
}
