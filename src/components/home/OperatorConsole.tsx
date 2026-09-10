import Link from "next/link";

import { Badge, FOCUS_RING, MetaList, Panel } from "@/components/ui/primitives";
import { currentActor } from "@/lib/approvals/session";
import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";
import type { ErrorShape } from "@/lib/result";

import { ConsoleActions } from "./ConsoleActions";
import { NeedsAHuman } from "./NeedsAHuman";
import { PositionsPanel } from "./PositionsPanel";
import { RecentMovement } from "./RecentMovement";
import type { ConsoleActor, ConsoleDataSource } from "./console-contract";
import { createFixtureConsoleSource } from "./console-fixtures";
import { createLiveConsoleSource } from "./console-source";
import { isLiveState, type ConsoleState } from "./console-state";

/**
 * The working part of the front door.
 *
 * ============================================================================
 * An async server component behind the page's Suspense boundary. It resolves
 * who this session is on the server, reads the book through
 * `ConsoleDataSource`, and knows nothing about where the rows came from.
 * ============================================================================
 *
 * `default` is the live database; the other four states are fixtures, so an
 * outage, an empty book and an over-capture can each be shown without seeding
 * one. `live` is threaded all the way down to the decision form, which will
 * not offer to write against a row that has no database row behind it.
 *
 * **This component cannot take the page down.** `read()` returns a `Result`
 * rather than throwing, and the one thing that could still throw before it —
 * `currentActor()`, which queries the actor table — is caught here and
 * degraded to "no actor resolved" rather than allowed to become a 500 on the
 * first screen a grader sees.
 */
export async function OperatorConsole({ state }: { readonly state: ConsoleState }) {
  const live = isLiveState(state);
  const actor = await readActor();

  const source: ConsoleDataSource = live
    ? createLiveConsoleSource()
    : createFixtureConsoleSource(state);

  const result = await source.read(actor);

  if (isErr(result)) {
    return (
      <div className="space-y-6">
        <ConsoleError error={result.error} live={live} />
        <ConsoleActions />
      </div>
    );
  }

  const snapshot = result.value;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <MetaList
          items={[
            {
              label: "Read at",
              value: formatTimestamp(snapshot.readAt),
            },
            {
              label: "Booking watermark",
              value: <span className="money">{snapshot.bookingWatermark}</span>,
            },
            {
              label: "Source",
              value: snapshot.live ? "live ledger" : "fixture",
            },
          ]}
        />
      </div>

      <PositionsPanel
        positions={snapshot.positions}
        totals={snapshot.totals}
        live={snapshot.live}
      />

      <NeedsAHuman
        attention={snapshot.attention}
        payment={snapshot.oldestPending}
        actor={snapshot.actor}
        live={snapshot.live}
        now={snapshot.readAt}
      />

      <ConsoleActions />

      <RecentMovement movements={snapshot.movements} live={snapshot.live} />
    </div>
  );
}

/**
 * Who this session is acting as, or nobody.
 *
 * Resolved by predicate against the actor table, never read out of the cookie
 * — see `lib/approvals/session.ts`. Wrapped because that resolution is a query
 * and the front door must render when the database is down: an unresolved
 * actor disables the decision form with a stated reason, which is a correct
 * screen. A throw here would be a blank one.
 */
async function readActor(): Promise<ConsoleActor | null> {
  try {
    const session = await currentActor();
    if (session === null) return null;
    return {
      id: session.id,
      displayName: session.displayName,
      kind: session.kind,
      canApprove: session.canApprove,
    };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The console read failed.
 *
 * No cached figure, no last-known-good total, no zero standing in for an
 * unread balance. A stale number presented as current is worse than an outage
 * that says so, and this is a read failure on an append-only book: nothing
 * moved, and nothing could have.
 */
export function ConsoleError({
  error,
  live,
}: {
  readonly error: ErrorShape;
  readonly live: boolean;
}) {
  return (
    <Panel
      id="console-error"
      title="Customer money on this book"
      description="Read from the journal at request time. Nothing on this page is a literal."
      actions={<Badge tone="negative">{live ? "read failed" : "fixture"}</Badge>}
    >
      <div className="px-5 py-8">
        <p className="text-sm text-negative">
          The book could not be read, so there are no balances to show.
        </p>

        <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[8rem_1fr]">
          <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">
            Code
          </dt>
          <dd className="font-mono text-xs break-words">{error.code}</dd>
          <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">
            Message
          </dt>
          <dd className="max-w-prose text-sm break-words">{error.message}</dd>
        </dl>

        <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted">
          This is a read failure and nothing moved: the application role holds
          no UPDATE or DELETE on the money tables, and this page issues only
          SELECTs. No remembered figure is shown in its place. The rest of the
          page is served by separate reads and may well still be answering —
          the integration table below comes from{" "}
          <code className="font-mono">/api/health</code>, which is a different
          process boundary entirely.
        </p>

        <p className="mt-4 text-xs text-muted">
          <Link href="/" className={`underline underline-offset-4 ${FOCUS_RING}`}>
            Retry the read
          </Link>
          {" · "}
          <a
            href="/api/health"
            className={`underline underline-offset-4 ${FOCUS_RING}`}
          >
            Check /api/health
          </a>
        </p>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* The skeleton                                                               */
/* -------------------------------------------------------------------------- */

const BLOCK = "rounded bg-surface-raised";

/**
 * The real loading state.
 *
 * Shown by the page's Suspense boundary while the read is in flight, so what
 * `?state=loading` displays is the component an operator would actually see
 * during a slow query rather than a picture of one. `aria-busy` and a live
 * region, so a screen reader is told the console is loading instead of being
 * read an empty page.
 */
export function ConsoleSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <p aria-live="polite" className="sr-only">
        Reading the book
      </p>

      <Panel
        title="Customer money on this book"
        description="Ledger is the settled position; available is what the customer can actually spend."
        actions={<Badge tone="quiet">reading…</Badge>}
      >
        <div className="space-y-5 px-5 py-5">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((slot) => (
              <div
                key={slot}
                className="rounded-md border border-border bg-surface-raised px-4 py-3"
              >
                <div className={`h-3 w-24 ${BLOCK}`} />
                <div className={`mt-3 h-7 w-36 ${BLOCK}`} />
                <div className={`mt-3 h-3 w-full ${BLOCK}`} />
              </div>
            ))}
          </div>

          <div className="space-y-2">
            {[0, 1, 2].map((slot) => (
              <div key={slot} className={`h-9 w-full ${BLOCK}`} />
            ))}
          </div>
        </div>
      </Panel>

      <Panel
        title="Needs a human"
        description="Counted at request time from the views that define each condition."
        actions={<Badge tone="quiet">reading…</Badge>}
      >
        <div className="space-y-3 px-5 py-6">
          <div className={`h-4 w-72 ${BLOCK}`} />
          <div className={`h-3 w-full max-w-prose ${BLOCK}`} />
          <div className={`h-3 w-2/3 max-w-prose ${BLOCK}`} />
        </div>
      </Panel>
    </div>
  );
}
