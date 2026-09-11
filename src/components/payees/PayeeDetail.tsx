import { FieldLabel, MetaList, Note, Panel } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";

import type { PayeeRow } from "./data-contract";
import { FindingList } from "./FindingList";
import {
  DirectoryBadge,
  EvidenceBadge,
  FreshnessBadge,
  FRESHNESS_HINT,
  NameMatchBadge,
  NAME_SOURCE_SENTENCE,
  OutcomeBadge,
} from "./labels";

/**
 * One payee, and everything the last check said about it.
 *
 * The three legs are shown SEPARATELY and in descending order of how much
 * they are worth, because collapsing them into a single "verified" is the
 * failure mode this whole screen exists to avoid:
 *
 *   1. THE ARITHMETIC — proved locally, no provider, either right or
 *      impossible. The strongest statement on the page, and the only one that
 *      can block.
 *   2. THE DIRECTORY — a real institution, confirmed by a named provider on a
 *      live call. Positive evidence when it hits; almost nothing when it
 *      misses in sandbox, and the panel says which.
 *   3. THE NAME — the leg Confirmation of Payee is actually made of, and the
 *      one no US provider can answer for a third party's account. It is here,
 *      it is honest about where the other name came from, and it never draws a
 *      tick it has not earned.
 */
export function PayeeDetail({ row }: { readonly row: PayeeRow }) {
  const unsigned = row.outcome === "warned" && !row.acknowledged;

  return (
    <div className="space-y-6">
      <Panel
        title={row.displayName}
        description={`Paid as "${row.holderName}". This is the name that would go on the payment, and the name the check compares.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <EvidenceBadge evidence={row.evidence} />
            <OutcomeBadge outcome={row.outcome} />
          </div>
        }
      >
        <div className="border-b border-border px-5 py-4">
          <MetaList
            items={[
              { label: "rail", value: row.rail },
              {
                label: "destination",
                value: (
                  <span className="font-mono">
                    {row.routingNumber ?? "—"}
                    {row.accountNumberLast4 === null ? "" : ` ••${row.accountNumberLast4}`}
                  </span>
                ),
              },
              { label: "added", value: `${formatTimestamp(row.createdAt)} by ${row.createdByName}` },
              {
                label: "last checked",
                value:
                  row.checkedAt === null
                    ? "never"
                    : `${formatTimestamp(row.checkedAt)} by ${row.checkedByName}`,
              },
            ]}
          />
        </div>

        {unsigned ? (
          <div className="px-5 py-4">
            <Note emphasis title="This payee's last check raised a warning that nobody has signed for">
              <p>
                A payment to this destination will be refused until somebody records why the
                difference is legitimate. That refusal is not the warning blocking the payment —
                the warning is overridable by anybody, in one step. It is a refusal to let the
                override be implicit. Names legitimately differ; who decided this one was fine is
                a fact worth keeping.
              </p>
            </Note>
          </div>
        ) : null}

        {row.acknowledged ? (
          <div className="px-5 py-4">
            <Note title={`Signed for by ${row.acknowledgedByName ?? "somebody"}`}>
              <p>
                {row.acknowledgementReason}
                {row.acknowledgedAt === null
                  ? ""
                  : ` — ${formatTimestamp(row.acknowledgedAt)}.`}
              </p>
              <p className="mt-2">
                The signature is attached to THAT check, not to this payee. A new check raises a
                new warning and needs a new signature; an acknowledgement from June says nothing
                about what was found this morning.
              </p>
            </Note>
          </div>
        ) : null}
      </Panel>

      <Panel
        title="1 · The routing number"
        as="h3"
        description="Arithmetic. No provider, no network, no counterparty. Either right or impossible."
      >
        <div className="space-y-3 px-5 py-4 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <FieldLabel>check digit</FieldLabel>
            <span>
              {row.checksumOk === null
                ? "not checked"
                : row.checksumOk
                  ? "holds — 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) is a multiple of ten"
                  : "FAILS — this routing number cannot exist"}
            </span>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <FieldLabel>fed prefix</FieldLabel>
            <span>
              {row.prefixAssigned === null
                ? "not checked"
                : row.prefixAssigned
                  ? "an allocated Federal Reserve range"
                  : "NOT an allocated range — possible, but never issued"}
            </span>
          </div>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            The check digit catches every single mistyped digit and about 89% of swapped adjacent
            pairs. It cannot see a swap of two digits that differ by exactly five, and it cannot
            see a swap of two digits three or six positions apart, because the weights repeat
            every three. It says nothing at all about the account number, which carries no
            checksum anywhere in the United States.
          </p>
        </div>
      </Panel>

      <Panel
        title="2 · The institution"
        as="h3"
        description="Does this routing number belong to a bank that exists, and does that bank take this rail?"
        actions={
          <DirectoryBadge
            directory={row.directory}
            institutionName={row.institutionName}
            provider={row.directoryProvider}
          />
        }
      >
        <div className="px-5 py-4 text-xs leading-relaxed text-muted">
          {row.directory === "found" ? (
            <p>
              Confirmed by <code>{row.directoryProvider}</code> on a live call. That is positive
              evidence about the BANK. It is not evidence about the account, and it is not
              evidence about who owns it.
            </p>
          ) : row.directory === "not_listed" ? (
            <p>
              <code>{row.directoryProvider}</code> answered and does not carry this routing
              number. In a sandbox that means very little — the test directory holds test banks,
              and every genuine routing number on this screen misses it. Against a production
              directory the same answer would be a warning.
            </p>
          ) : row.directory === "unavailable" ? (
            <p>
              The directory could not be reached. The check digit was still verified locally,
              which is the part that catches a typo; nobody confirmed the institution exists.
            </p>
          ) : (
            <p>This rail is not addressed by a routing number, so there was nothing to look up.</p>
          )}
        </div>
      </Panel>

      <Panel
        title="3 · The name"
        as="h3"
        description="What Confirmation of Payee is actually made of, and the leg the United States has no network for."
        actions={
          <NameMatchBadge
            match={row.nameMatch}
            source={row.nameSource}
            score={row.nameMatchScore}
          />
        }
      >
        <div className="space-y-3 px-5 py-4">
          <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
            <dt>
              <FieldLabel>you typed</FieldLabel>
            </dt>
            <dd className="text-sm">{row.holderName}</dd>

            <dt>
              <FieldLabel>the account is held by</FieldLabel>
            </dt>
            <dd className="text-sm">
              {row.counterpartyName ?? (
                <span className="text-muted">
                  nobody can tell us — there is no second name to compare
                </span>
              )}
            </dd>

            {row.nameProvider === null ? null : (
              <>
                <dt>
                  <FieldLabel>answered by</FieldLabel>
                </dt>
                <dd className="font-mono text-xs">{row.nameProvider}</dd>
              </>
            )}
          </dl>

          <p className="max-w-prose text-xs leading-relaxed text-muted">
            {row.nameSource === null
              ? "No name check has been run against this payee."
              : NAME_SOURCE_SENTENCE[row.nameSource]}
          </p>

          {row.nameSource === "payer_asserted" ? (
            <Note title="The algorithm is real. The counterparty's name is not something we can obtain.">
              <p>
                The comparison below is the same normalised, similarity-scored comparison a real
                CoP scheme performs — case, punctuation, legal form, word order and initials are
                all set aside, and a changed letter in a name is never allowed to score as a
                match. What is missing is the other side of it: no US provider will tell us the
                name on a third party&rsquo;s account from its number. When one can, it slots in
                here and nothing else changes.
              </p>
            </Note>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="What the check found"
        as="h3"
        description="Blocks first, then what needs a signature, then what is merely worth knowing."
        actions={<FreshnessBadge freshness={row.freshness} days={row.checkedDaysAgo} />}
      >
        <FindingList findings={row.findings} />
        <p className="border-t border-border px-5 py-3 text-[11px] leading-relaxed text-muted">
          {FRESHNESS_HINT[row.freshness]}
        </p>
      </Panel>
    </div>
  );
}
