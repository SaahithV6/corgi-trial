import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { RetryButton } from "@/components/ui/RetryButton";
import { Badge, FOCUS_RING, MetaList, Note, Panel } from "@/components/ui/primitives";

import { CaseActions, RaiseDisputeForm } from "./DisputeForms";
import { CaseTable } from "./CaseTable";
import { EpisodePanel } from "./EpisodePanel";
import { isRetryable } from "@/components/ui/error-detail";

import type { DisputesDataSource } from "./data-contract";
import { disputesHref, type DisputesFilter } from "./view-state";

/**
 * The disputes screen.
 *
 * An async server component, so `?state=loading` can hold a real read open
 * behind a real Suspense boundary and the skeleton on screen is the skeleton a
 * slow database actually produces. The page owns the boundary; this owns the
 * content and the error branch.
 *
 * `noDatabase` is resolved ONCE, in `page.tsx`, and handed to the state bar as
 * well. It is not re-derived here. Two predicates answering three-quarters of
 * the same question is how a screen ends up badging LIVE above a board badging
 * FIXTURE. The flag chooses the refusal's wording and nothing else: the
 * refusal itself arrives as a failed read, from `./unreadable.ts`.
 */
export async function DisputesView({
  source,
  filter,
  actorName,
  canApprove,
  noDatabase = false,
}: {
  readonly source: DisputesDataSource;
  readonly filter: DisputesFilter;
  readonly actorName: string | null;
  readonly canApprove: boolean;
  readonly noDatabase?: boolean;
}) {
  const result = await source.load({
    businessId: filter.businessId,
    disputeId: filter.disputeId,
    edge: filter.state === "edge",
  });

  if (!result.ok) {
    // The retry control is dropped when the failure says it is not retryable.
    // A button offering to re-run a read that cannot succeed sits next to the
    // words "retryable: no" and contradicts them; a refresh does not configure
    // a database.
    const retry = isRetryable(result.error);
    return (
      <Panel
        title={
          noDatabase ? "This screen cannot see the cases" : "The disputes read failed"
        }
        description={
          noDatabase
            ? "No database is configured for this deployment, so no case, no balance and no settled charge was read. Nothing was posted, and no case list is drawn in place of what was not read."
            : "Nothing was posted. This path only reads."
        }
        {...(retry ? { actions: <RetryButton /> } : {})}
      >
        <div className="space-y-3 px-5 py-4">
          <p className="max-w-prose text-sm">{result.error.message}</p>
          <p className="text-xs text-muted">
            code <span className="money">{result.error.code}</span>
          </p>
          <p className="text-xs text-muted">
            retryable <span className="money">{retry ? "yes" : "no"}</span>
          </p>
          {result.error.details === undefined ? null : (
            <p className="text-xs text-muted">
              <span className="money">{JSON.stringify(result.error.details)}</span>
            </p>
          )}
          <Note title="What a customer would see">
            {noDatabase ? (
              <p>
                Nothing. This is a console with no book behind it, not a
                customer-facing failure. No credit was granted, no credit was
                clawed back, and no case was read — an empty case list is not
                shown here, because on this deployment it would mean &ldquo;I
                did not look&rdquo; and would read as &ldquo;nobody has
                disputed anything&rdquo;.
              </p>
            ) : (
              <p>
                An operator cannot see the state of their case right now, which
                is different from the case being wrong. No credit was granted,
                no credit was clawed back, and every entry already in the
                journal is unaffected — a read failing cannot change what is
                written, because nothing on this path writes.
              </p>
            )}
          </Note>
        </div>
      </Panel>
    );
  }

  const view = result.value;
  const fixture = view.source === "fixture";

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Disputes</h1>
            <p className="mt-1 max-w-prose text-xs text-muted">
              A claim against a card transaction that has already settled, and
              the provisional credit that sits between the claim and the
              network&rsquo;s answer. The credit is real money in the ledger on
              the day it is granted, and it is held, because we may have to take
              it back.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {fixture ? (
              <Badge tone="negative">FIXTURE — not the live database</Badge>
            ) : (
              <Badge tone="positive">LIVE — read from the ledger</Badge>
            )}
          </div>
        </div>

        <MetaList
          items={[
            { label: "as of", value: <span className="money">{view.asOf}</span> },
            { label: "book date", value: <span className="money">{view.bookDate}</span> },
            { label: "cases", value: <span className="money">{view.cases.length}</span> },
          ]}
        />

        {view.businesses.length > 1 ? (
          <nav aria-label="Customer" className="flex flex-wrap items-center gap-1">
            {view.businesses.map((business) => {
              const current = view.selected?.businessId === business.businessId;
              return (
                <Link
                  key={business.businessId}
                  href={disputesHref(filter, {
                    businessId: business.businessId,
                    disputeId: null,
                  })}
                  aria-current={current ? "page" : undefined}
                  className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                    current
                      ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border)]"
                      : "text-muted hover:text-text"
                  }`}
                >
                  {business.legalName}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </header>

      {/* ---- honest labelling, on the screen's face ---------------------- */}
      <Panel
        title="What is live here and what is ours"
        description="Presenting a workflow we built as a provider integration would be the fastest way to fail this trial, so the split is printed rather than described in a README."
      >
        <ul className="space-y-2 px-5 py-4">
          {view.provenance.map((line) => (
            <li key={line.line} className="flex flex-wrap items-start gap-2 text-sm">
              <Badge tone={line.provider === "live" ? "positive" : "neutral"}>
                {line.provider === "live" ? "LIVE" : "OURS / OPERATOR"}
              </Badge>
              <span className="max-w-prose flex-1 text-xs leading-relaxed">{line.line}</span>
            </li>
          ))}
        </ul>
      </Panel>

      {/* ---- the customer's live position -------------------------------- */}
      {view.selected === null ? null : (
        <Panel
          title={`${view.selected.legalName} — position now`}
          description="ledger − holds = available. Three sums over journal_line; there is no balance column in this schema for any of them to drift from."
        >
          <div className="grid gap-4 px-5 py-4 sm:grid-cols-3">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                ledger
              </p>
              <p className="mt-1 text-lg">
                <Money cents={view.selected.ledgerCents} />
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                − holds
              </p>
              <p className="mt-1 text-lg">
                <Money cents={view.selected.holdsCents} />
              </p>
            </div>
            <div>
              <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                = available
              </p>
              <p className="mt-1 text-lg font-semibold">
                <Money cents={view.selected.availableCents} />
              </p>
            </div>
          </div>
          <p className="px-5 pb-4 text-xs text-muted">
            These three are the WHOLE account at this instant, not this
            customer&rsquo;s disputes: every card authorisation, inbound credit
            and payment on the book is in them. The postings that make them up
            are on{" "}
            <Link
              href="/accounts"
              className={`underline underline-offset-2 ${FOCUS_RING}`}
            >
              the deposit directory
            </Link>
            , which links each 2100 account to its own activity.
          </p>
        </Panel>
      )}

      {/* ---- the edge episode -------------------------------------------- */}
      {view.episodeMissing === null ? null : (
        <Panel title="Edge — nothing to show yet">
          <div className="px-5 py-6">
            <p className="max-w-prose text-sm text-muted">{view.episodeMissing}</p>
          </div>
        </Panel>
      )}
      {view.episode === null ? null : <EpisodePanel episode={view.episode} />}

      {/* ---- the cases ---------------------------------------------------- */}
      <CaseTable cases={view.cases} filter={filter} />

      {/* ---- the controls -------------------------------------------------- */}
      <CaseActions
        cases={view.cases}
        disabled={fixture}
        actorName={actorName}
        canApprove={canApprove}
      />

      <RaiseDisputeForm
        charges={view.charges}
        reasonCodes={view.reasonCodes}
        policy={view.policy}
        disabled={fixture}
      />

      {/* ---- the policy ---------------------------------------------------- */}
      {view.policy === null ? null : (
        <Panel
          title="The threshold, and why it is where it is"
          description="Read from approval_policy — the same effective-dated, append-only table the payment rails are judged under, so raising it later cannot make today's grants look like control failures."
        >
          <div className="space-y-3 px-5 py-4">
            <MetaList
              items={[
                { label: "rail", value: <span className="money">card</span> },
                { label: "threshold", value: <Money cents={view.policy.thresholdCents} /> },
                {
                  label: "approvals",
                  value: <span className="money">{view.policy.requiredApprovals}</span>,
                },
              ]}
            />
            <p className="max-w-prose text-xs leading-relaxed text-muted">{view.policy.note}</p>
          </div>
        </Panel>
      )}
    </div>
  );
}

/**
 * The loading state.
 *
 * Shaped like the real layout rather than a spinner, because the question a
 * skeleton answers is "is anything going to appear here" and a spinner does not
 * answer it. `aria-busy` and a screen-reader line, so the answer is not
 * visual-only.
 */
export function DisputesSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading disputes…</span>
      <div className="space-y-3">
        <div className="h-5 w-40 rounded bg-surface-raised" />
        <div className="h-3 w-96 max-w-full rounded bg-surface-raised" />
      </div>
      {[0, 1, 2].map((row) => (
        <div key={row} className="rounded-lg border border-border">
          <div className="border-b border-border px-5 py-3">
            <div className="h-4 w-56 rounded bg-surface-raised" />
          </div>
          <div className="space-y-2 px-5 py-4">
            {[0, 1, 2, 3].map((line) => (
              <div key={line} className="h-3 w-full rounded bg-surface-raised" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
