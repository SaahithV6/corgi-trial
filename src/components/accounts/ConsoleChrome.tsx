import Link from "next/link";

import { Badge, FOCUS_RING, Panel, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

import {
  CONSOLE_STATES,
  CONSOLE_STATE_HINTS,
  CONSOLE_STATE_LABELS,
  consoleQuery,
  type ConsoleView,
} from "./console-state";
import type { ConsoleBusiness } from "./contract";

/**
 * Chrome shared by the console and its drill-down: the state switcher, the
 * business selector, the skeleton and the error panel.
 */

/**
 * Live switch between the five states.
 *
 * Styled as scaffolding on purpose — dashed, muted, obviously not product —
 * because a demo control that looks like a feature is a lie. Every entry is a
 * plain link to the same route with a different query string, so each state
 * has a URL that reproduces it and none of them write anything.
 */
export function DemoStateBar({ view }: { readonly view: ConsoleView }) {
  return (
    <aside
      aria-label="Demo states"
      className="rounded-lg border border-dashed border-border-strong px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Demo state
        </span>

        <div className="flex flex-wrap items-center gap-1">
          {CONSOLE_STATES.map((state) => {
            const current = state === view.state;
            // The three fixture states describe a customer who does not exist,
            // so carrying a live business id into them would be meaningless.
            const keepBusiness = state === "default" || state === "loading";
            const href = `/accounts${consoleQuery({
              state,
              businessId: keepBusiness ? view.businessId : null,
            })}`;
            return (
              <Link
                key={state}
                href={href}
                aria-current={current ? "page" : undefined}
                title={CONSOLE_STATE_HINTS[state]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {CONSOLE_STATE_LABELS[state]}
              </Link>
            );
          })}
        </div>
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {CONSOLE_STATE_HINTS[view.state]}
      </p>
    </aside>
  );
}

/**
 * Which customer the console is pointed at.
 *
 * Rendered beside the console rather than in the demo bar, because it is not a
 * demo control: it selects a real customer, and `?business=` is a reference the
 * server re-reads rather than a value it trusts.
 */
export function BusinessSelector({
  view,
  businesses,
  selectedId,
}: {
  readonly view: ConsoleView;
  readonly businesses: readonly ConsoleBusiness[];
  readonly selectedId: string;
}) {
  if (businesses.length < 2) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        Customer
      </span>
      {businesses.map((business) => {
        const current = business.businessId === selectedId;
        return (
          <Link
            key={business.businessId}
            href={`/accounts${consoleQuery({
              state: view.state,
              businessId: business.businessId,
            })}`}
            aria-current={current ? "true" : undefined}
            className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
              current
                ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                : "text-muted hover:text-text"
            }`}
          >
            {business.legalName}
            <span className="ml-1.5 text-muted">
              {business.cardCount} card{business.cardCount === 1 ? "" : "s"}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

/**
 * The real skeleton, shown by the page's Suspense boundary while the console
 * reads. `?state=loading` holds that read open rather than faking this render,
 * which is the only way to know the shape below is the right one.
 */
export function ConsoleSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Reading the ledger…</span>

      <Panel
        title="Ledger, holds, available"
        description="Folding the journal at request time."
      >
        <div className="grid gap-px bg-border sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="bg-surface px-5 py-4">
              <div className="h-3 w-24 rounded bg-border" />
              <div className="mt-2 h-6 w-32 rounded bg-border" />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Cards" description="Reading the card bindings.">
        <div className="space-y-3 px-5 py-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-4 w-2/3 rounded bg-border" />
          ))}
        </div>
      </Panel>

      <Panel title="Holds" description="Folding H(E) over each authorisation's event set.">
        <div className="space-y-3 px-5 py-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-4 w-full rounded bg-border" />
          ))}
        </div>
      </Panel>
    </div>
  );
}

/**
 * A failed read.
 *
 * The retry is a real one — `router.refresh()` re-issues the same queries — and
 * the copy states the thing an operator most needs to hear about a read
 * failure on an append-only ledger: nothing moved, because a SELECT cannot
 * move anything.
 */
export function ConsoleErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <Panel
      title="The console could not be read"
      description="A read failed. No card was issued, no authorisation was simulated and no money moved."
      actions={<RetryButton label="Retry the read" />}
    >
      <div className="px-5 py-5">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Details of the failed read</caption>
          <tbody className="divide-y divide-border">
            <tr>
              <th scope="row" className={`${TH_CLASS} w-32`}>
                Code
              </th>
              <td className={`${TD_CLASS} font-mono text-xs`}>{error.code}</td>
            </tr>
            <tr>
              <th scope="row" className={TH_CLASS}>
                Message
              </th>
              <td className={`${TD_CLASS} max-w-prose`}>{error.message}</td>
            </tr>
          </tbody>
        </table>

        <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted">
          The ledger is append-only and this was a query, so there is nothing to
          roll back and nothing to reconcile. The controls are hidden rather
          than disabled while the read is failing: a card-issuing button on top
          of a screen that cannot tell you the balance is an invitation to act
          blind.
        </p>
      </div>
    </Panel>
  );
}

/**
 * The label that says which side of the line this render is on.
 *
 * A console that shows seeded demo money in the same chrome as a customer's
 * real balance, with nothing to tell them apart, is one screenshot away from a
 * very bad meeting.
 */
export function ProvenanceLine({ live }: { readonly live: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {live ? (
        <Badge tone="positive" title="Read from Neon at request time.">
          live ledger
        </Badge>
      ) : (
        <Badge tone="quiet" title="Fixture. Nothing on this view was read from the database.">
          fixture
        </Badge>
      )}
      <p className="text-xs text-muted">
        {live
          ? "Every figure below is a fold over journal lines taken as of one instant and one booking watermark, and every control below reaches a real provider."
          : "Fixture data behind the same components the live console uses. The query string is the only thing that selects it; nothing here was read from or written to the database, and the controls are inert."}
      </p>
    </div>
  );
}
