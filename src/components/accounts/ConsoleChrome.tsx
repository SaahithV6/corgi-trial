import Link from "next/link";

import { Badge, FOCUS_RING, Panel, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
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
 * A failed read, and the refusal that is not one.
 *
 * The retry is a real one — `router.refresh()` re-issues the same queries — and
 * the copy states the thing an operator most needs to hear about a read
 * failure on an append-only ledger: nothing moved, because a SELECT cannot
 * move anything.
 *
 * THE RETRY IS NOW CONDITIONAL, and the flag it is conditional on is printed.
 * `actions={<RetryButton label="Retry the read" />}` was unconditional, so
 * this panel offered to re-run a read for every failure it could be handed,
 * including `ACCOUNTS_NO_DATABASE` — a deployment with no database to read
 * from, which no number of refreshes configures. A control that cannot work is
 * worse than a missing one: the operator spends the outage pressing it.
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the cause that is not a failed read. Both refuse identically:
 * no business, no card, no hold, no balance.
 */
export function ConsoleErrorPanel({
  error,
  title = "The console could not be read",
  description = "A read failed. No card was issued, no authorisation was simulated and no money moved.",
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
}) {
  const retryable = isRetryable(error);

  return (
    <Panel
      title={title}
      description={description}
      actions={retryable ? <RetryButton label="Retry the read" /> : null}
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
            <tr>
              <th scope="row" className={TH_CLASS}>
                Retryable
              </th>
              <td className={`${TD_CLASS} font-mono text-xs`}>
                {retryable ? "yes" : "no"}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted">
          The ledger is append-only and this was a query, so there is nothing to
          roll back and nothing to reconcile. The controls are hidden rather
          than disabled while the read is failing: a card-issuing button on top
          of a screen that cannot tell you the balance is an invitation to act
          blind.
          {retryable
            ? ""
            : " No retry is offered either, for the same reason: this failure is a fact about the deployment, and the same request would produce the same answer."}
        </p>
      </div>
    </Panel>
  );
}

/**
 * Where each region of this page got its figures.
 *
 * ============================================================================
 * THIS LINE USED TO MAKE A PAGE-WIDE CLAIM THAT WAS NOT TRUE OF THE PAGE.
 * ============================================================================
 *
 * It took one boolean — `isLiveConsole(view)` — and on `?state=edge` printed
 * `fixture` above the sentence "nothing here was read from or written to the
 * database, and the controls are inert", at the top of a page which, further
 * down, ran `listLiveAccounts()` under an unconditional `live ledger` badge
 * and mounted the card-control panel with live write forms on a SEPARATE
 * `?controls=` axis under a third badge from a third predicate.
 *
 * Three predicates, three claims, one render, and no reader could tell which
 * of them the page meant. It was wrong with a database configured and it would
 * have been wrong without one.
 *
 * `/accounts` is genuinely three regions with three sources — that is the
 * design, and the deposit directory being live while the console is posed is
 * the point of having both. So the fix is not one badge over a mixed page: it
 * is to stop generalising. Each region is named, each carries the badge its
 * OWN source predicate produced, and every one of those predicates is resolved
 * once in `page.tsx` and handed both to this line and to the component that
 * reads. They cannot disagree because there is nothing left to disagree with.
 *
 * With no database configured there is only one thing to say and this line
 * says it once. The regions below are refusals, and a refusal badges nothing.
 */
export type ConsoleProvenance = {
  /** The card & hold console: live on `default` and `loading`. */
  readonly console: boolean;
  /** The deposit directory: live whenever there is a book to fold. */
  readonly directory: boolean;
  /** The card-control panel, on its own `?controls=` axis. */
  readonly controls: boolean;
};

const REGION_LABEL: Record<keyof ConsoleProvenance, string> = {
  console: "Card & hold console",
  directory: "Every deposit account",
  controls: "Card controls",
};

const REGION_NOTE: Record<keyof ConsoleProvenance, { live: string; fixture: string }> = {
  console: {
    live: "Real cards on a real Lithic program, real holds, and balances folded from journal lines at one instant and one booking watermark. Its controls reach the provider.",
    fixture:
      "A drawing, selected by ?state=. Nothing in it was read from or written to the database and its controls are inert.",
  },
  directory: {
    live: "Every 2100 deposit account on the book, folded at request time. Same fold as the per-account screen each row links to.",
    fixture:
      "Not read. This region has no fixture — when it cannot read the book it refuses rather than drawing one.",
  },
  controls: {
    live: "Control versions and authorisation decisions read from the book, and the append and replay forms write.",
    fixture:
      "A drawing, selected by ?controls=. It reads nothing, and its append and replay buttons are disabled rather than pressable.",
  },
};

export function ProvenanceLine({
  provenance,
  noDatabase = false,
}: {
  readonly provenance: ConsoleProvenance;
  readonly noDatabase?: boolean;
}) {
  if (noDatabase) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Badge
          tone="negative"
          title="No APP_DATABASE_URL is set for this deployment. Nothing on this screen was read from a book."
        >
          NO DATABASE
        </Badge>
        <p className="max-w-prose text-xs text-muted">
          No database is configured for this deployment. The console, the
          deposit directory and the card controls below all refuse rather than
          draw: no balance was folded, no card was listed and no control version
          was read. The demo table at the foot of the page is a drawing and says
          so.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {(["console", "directory", "controls"] as const).map((region) => {
        const live = provenance[region];
        return (
          <div key={region} className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="w-44 shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
              {REGION_LABEL[region]}
            </span>
            {live ? (
              <Badge tone="positive" title="Read from Neon at request time.">
                live ledger
              </Badge>
            ) : (
              <Badge
                tone="quiet"
                title="Fixture. Nothing in this region was read from the database."
              >
                fixture
              </Badge>
            )}
            <p className="max-w-prose text-xs text-muted">
              {live ? REGION_NOTE[region].live : REGION_NOTE[region].fixture}
            </p>
          </div>
        );
      })}
    </div>
  );
}
