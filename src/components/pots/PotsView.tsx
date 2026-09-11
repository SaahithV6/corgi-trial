import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { RetryButton } from "@/components/ui/RetryButton";
import {
  Badge,
  FOCUS_RING,
  MetaList,
  Note,
  Panel,
} from "@/components/ui/primitives";

import { isRetryable } from "@/components/ui/error-detail";

import type { PotsDataSource } from "./data-contract";
import { IdentityPanel } from "./IdentityPanel";
import { InvariantPanel } from "./InvariantPanel";
import { MovementTable } from "./MovementTable";
import { OpenPotForm, MoveForm } from "./PotForms";
import { PotTable } from "./PotTable";
import { potsHref, type PotsFilter } from "./view-state";

/**
 * The pots screen.
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
export async function PotsView({
  source,
  filter,
  noDatabase = false,
}: {
  readonly source: PotsDataSource;
  readonly filter: PotsFilter;
  readonly noDatabase?: boolean;
}) {
  const result = await source.load({
    businessId: filter.businessId,
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
        title={noDatabase ? "This screen cannot see the pots" : "The pots read failed"}
        description={
          noDatabase
            ? "No database is configured for this deployment, so no pot, no balance and no transfer was read. Nothing was posted, and nothing below is drawn in place of what was not read."
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
              <span className="money">
                {JSON.stringify(result.error.details)}
              </span>
            </p>
          )}
          <Note title="What a customer would see">
            {noDatabase ? (
              <p>
                Nothing. This is a console with no book behind it, not a
                customer-facing failure. No pot was opened, no transfer was
                posted, and no figure on this screen was read from anything —
                which is why the identity between the pot total and the deposit
                liability is not shown as holding. It was not checked.
              </p>
            ) : (
              <p>
                The balance they can act on is unknown right now, which is
                different from wrong. No pot was opened, no transfer was posted,
                and the entries already in the journal are unaffected — a read
                failing cannot change what is written, because nothing on this
                path writes.
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
            <h1 className="text-lg font-semibold tracking-tight">Pots</h1>
            <p className="mt-1 max-w-prose text-xs text-muted">
              Sub-accounts of a customer&rsquo;s deposit liability, with internal
              transfers that are pure ledger moves. Two lines, one customer, no
              rail, instant — because there is nothing external to wait for.
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
            {
              label: "book date",
              value: <span className="money">{view.bookDate}</span>,
            },
            {
              label: "customers",
              value: <span className="money">{view.businesses.length}</span>,
            },
          ]}
        />

        {view.businesses.length > 1 ? (
          <nav aria-label="Customer" className="flex flex-wrap items-center gap-1">
            {view.businesses.map((business) => {
              const current =
                view.selected?.businessId === business.businessId;
              return (
                <Link
                  key={business.businessId}
                  href={potsHref(filter, { businessId: business.businessId })}
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

      {view.refusal === null ? null : (
        <Panel
          id="refusal"
          title="Edge — more into a pot than is available"
          description="Decided by decideMove(), the same function the transaction runs behind lock_business_deposits(). Nothing was posted."
          actions={<Badge tone="negative">{view.refusal.code}</Badge>}
        >
          <div className="space-y-3 px-5 py-4">
            <p className="max-w-prose text-sm">{view.refusal.reason}</p>
            <dl className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-3">
              <Figure label="requested" cents={view.refusal.requestedCents} />
              <Figure label="available to cover it" cents={view.refusal.coverCents} />
              <Figure label="short by" cents={view.refusal.shortfallCents} />
            </dl>
            <Note emphasis title="Why this is the edge case that matters">
              <p>
                The gate is <code>available</code>, not the ledger balance. A
                customer looking at their own balance can be refused an earmark
                for money that is genuinely theirs but is already committed — to
                a card authorisation that has not settled, or to an inbound
                credit that has not cleared and could still be pulled back.
                Earmarking it would let a pot promise money a settlement is about
                to take.
              </p>
              <p className="mt-2">
                The refusal is a decision, not an exception: it is a value the
                write path returns, the entry is never attempted, and the journal
                is untouched. There is no half-posted transfer to clean up
                because there is no state between the check and the posting —
                they are the same transaction, behind the same lock.
              </p>
            </Note>
          </div>
        </Panel>
      )}

      {view.selected === null ? (
        <Panel title="No customers" description="Nothing on the book has a deposit account.">
          <p className="px-5 py-6 text-sm text-muted">
            A pot is a sub-account of a customer&rsquo;s deposit liability, so
            there has to be a customer with a deposit account first. That happens
            when a business passes KYB.
          </p>
        </Panel>
      ) : (
        <>
          {view.identity !== null && view.availability !== null ? (
            <IdentityPanel
              identity={view.identity}
              availability={view.availability}
              pots={view.pots}
              legalName={view.selected.legalName}
            />
          ) : null}

          {view.identity !== null ? (
            <PotTable
              pots={view.pots}
              identity={view.identity}
              legalName={view.selected.legalName}
            />
          ) : null}

          <MoveForm pots={view.pots} disabled={fixture} />

          <OpenPotForm business={view.selected} disabled={fixture} />

          <MovementTable movements={view.movements} />

          <InvariantPanel invariants={view.invariants} />
        </>
      )}
    </div>
  );
}

function Figure({ label, cents }: { readonly label: string; readonly cents: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-1">
      <dt className="text-muted">{label}</dt>
      <dd>
        <Money cents={cents} className="font-semibold" />
      </dd>
    </div>
  );
}

/**
 * The skeleton the Suspense boundary falls back to.
 *
 * Shaped like the real screen — the identity block, the pot table, the ledger —
 * so the layout does not jump when the data arrives. `aria-busy` and a live
 * region so a screen reader is told something is loading rather than being read
 * an empty page.
 */
export function PotsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading pots and balances…</span>

      <div className="space-y-3">
        <div className="h-5 w-24 rounded bg-surface-raised" />
        <div className="h-3 w-96 max-w-full rounded bg-surface-raised" />
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <div className="h-4 w-40 rounded bg-surface-raised" />
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="h-6 w-72 max-w-full rounded bg-surface-raised" />
          <div className="grid gap-2 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-3 rounded bg-surface-raised" />
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-surface">
        <div className="border-b border-border px-5 py-4">
          <div className="h-4 w-20 rounded bg-surface-raised" />
        </div>
        <div className="divide-y divide-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between px-5 py-3">
              <div className="h-3 w-48 rounded bg-surface-raised" />
              <div className="h-3 w-24 rounded bg-surface-raised" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
