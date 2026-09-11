import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";

import { isErr } from "@/lib/result";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { RetryButton } from "@/components/ui/RetryButton";
import {
  AS_KNOWN_AT_PARAM,
  AS_OF_PARAM,
  parseTimeTravelParams,
  withTimeTravel,
  type TimeTravelRequest,
} from "@/lib/timetravel/params";
import { systemClock } from "@/lib/timetravel/clock";
import { WINDOWS, type Window } from "@/lib/timetravel/read";
// Type-only, so it is erased at compile time and importing it cannot drag
// `src/lib/env.ts` — which refuses to load without a full set of keys — into a
// page that must be able to render "no database configured".
import type { Sql } from "@/lib/ledger/db";

import { RefusalPanel } from "@/components/timetravel/Refusal";
import { TransactionsSkeleton } from "@/components/timetravel/TransactionsSkeleton";
import { TransactionsView } from "@/components/timetravel/TransactionsView";
import {
  EMPTY_STATE_VALUE_DATE,
  FIXTURE_READ_FAILURE,
  NO_DATABASE,
} from "@/components/timetravel/fixtures";

export const metadata: Metadata = {
  title: "Transactions · time travel · Corgi ops console",
};

/**
 * Never prerendered. Every figure on this page is a fold over the journal
 * taken at request time, at a point the URL chose. Baking one into a build
 * artefact would put a deploy-time belief on a screen whose entire claim is
 * that the belief is derived now.
 */
export const dynamic = "force-dynamic";

/**
 * The read at `?state=loading` is deliberately slowed by this much.
 *
 * Long enough that the real skeleton is visible and can be photographed;
 * short enough that nobody watching a demo loses the thread.
 */
const LOADING_STATE_DELAY_MS = 1_400;

const DEMO_STATES = ["default", "loading", "empty", "error", "edge"] as const;
type DemoState = (typeof DEMO_STATES)[number];

const STATE_HINTS: Record<DemoState, string> = {
  default: "Today at the live watermark. No time-travel parameter, no difference — the same reads the account screens take.",
  loading: "The real read, held open behind the real Suspense fallback. Live.",
  empty: "The value axis pinned before this book's first entry. A true zero, derived live — not a fixture of one.",
  error: "A synthesised read failure. The only fixture here: there is no honest way to make a live read fail on demand.",
  edge: "THE EDGE CASE — the most recent correction act, entered at an instant INSIDE its atomic write, so the cut guard fires.",
};

/**
 * `/transactions` — the time machine.
 *
 * ===========================================================================
 * WHAT THIS SCREEN IS FOR
 * ===========================================================================
 *
 * `?asOf=<date>&asKnownAt=<timestamp>` renders one account's business day at a
 * point on BOTH axes of the bitemporal ledger. Hold `asOf` still, move
 * `asKnownAt` across the moment a settlement was learned to be reversed, and
 * the same day's closing balance changes — with the difference accounted for,
 * entry by entry, and no row ever edited.
 *
 * ===========================================================================
 * THE FIVE URL STATES, FOUR OF THEM LIVE
 * ===========================================================================
 *
 *   (none)          today at the live watermark — LIVE
 *   ?state=loading  the real read, slowed; the skeleton is the real fallback
 *   ?state=empty    the value axis before the book's first entry — LIVE zero
 *   ?state=error    a synthesised read failure — the one fixture
 *   ?state=edge     the most recent correction act, entered MID-WRITE so the
 *                   cut guard fires — LIVE
 *
 * ...plus `?account=<uuid>` and `?window=day|week|month`.
 *
 * `edge` is the edge case on purpose and it is the one worth watching: it asks
 * for a booking instant between a reversal and its re-book, which is a state
 * that never existed — the two were written by one transaction — and the
 * screen snaps the cut below the whole act and says why.
 *
 * ===========================================================================
 * DEFAULT BEHAVIOUR IS UNCHANGED, AND THAT IS CHECKED HERE
 * ===========================================================================
 *
 * With no parameters, `parseTimeTravelParams` reports `absent`,
 * `resolveTimePoint` returns `readSnapshot()` verbatim — the same one query the
 * account screens take — and every figure below is the live one. There is no
 * extra round trip and no different code path.
 */
export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;

  const state = pickState(resolved);
  const accountId = firstParam(resolved["account"]) ?? null;
  const window = pickWindow(resolved);

  // ONE CLOCK, TAKEN ONCE, AT THE TOP. Nothing below this line calls
  // `new Date()` — see `src/lib/timetravel/clock.ts` for the defect that
  // taught this system why that matters.
  const clock = systemClock;
  const parsed = parseTimeTravelParams(applyStatePreset(resolved, state), clock.now());

  const basePath = buildBasePath({ state, accountId, window, resolved });
  const liveHref = withTimeTravel(basePath, { asOf: null, asKnownAt: null });

  return (
    <div className="space-y-6">
      <StateBar state={state} />

      {parsed.ok ? (
        <Suspense
          key={`${state}:${accountId ?? ""}:${window}:${keyOf(parsed.request)}`}
          fallback={<TransactionsSkeleton />}
        >
          <TransactionsSection
            state={state}
            accountId={accountId}
            window={window}
            request={parsed.request}
            basePath={basePath}
            liveHref={liveHref}
          />
        </Suspense>
      ) : (
        // Refused BEFORE a connection is opened. The two parameters are
        // validated by a pure function, so an impossible coordinate never
        // reaches the database at all.
        <RefusalPanel refusals={parsed.refusals} liveHref={liveHref} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The section                                                                */
/* -------------------------------------------------------------------------- */

/**
 * An async server component, so the skeleton above is a real fallback rather
 * than a mock.
 *
 * The live module is imported dynamically because importing it evaluates
 * `src/lib/env.ts`, which refuses to load without a full set of keys. That is
 * right for the app and wrong for a page that must be able to render the words
 * "no database configured".
 */
async function TransactionsSection({
  state,
  accountId,
  window,
  request,
  basePath,
  liveHref,
}: {
  readonly state: DemoState;
  readonly accountId: string | null;
  readonly window: Window;
  readonly request: TimeTravelRequest;
  readonly basePath: string;
  readonly liveHref: string;
}) {
  if (state === "error") {
    return <ErrorPanel error={FIXTURE_READ_FAILURE} fixture liveHref={liveHref} />;
  }

  const { hasDatabase } = await import("./live-source");
  if (!hasDatabase()) {
    return <ErrorPanel error={NO_DATABASE} fixture={false} liveHref={liveHref} />;
  }

  // The loading state is not a mock of a slow read; it IS a slow read.
  if (state === "loading") {
    await new Promise((resolve) => setTimeout(resolve, LOADING_STATE_DELAY_MS));
  }

  const { ledgerConnection } = await import("@/lib/ledger/queries");
  const { resolveTimePoint } = await import("@/lib/timetravel/point");
  const { loadTransactions } = await import("./live-source");

  const conn = await ledgerConnection();

  // `edge` resolves LIVE: it finds the book's most recent correction act and
  // enters it at the instant inside its atomic write. It cannot invent one —
  // when the book has none, the request is left alone and the screen reads
  // today, which is the honest answer to "show me a corrected day" on a book
  // that has not corrected anything.
  const effective =
    state === "edge" ? await edgeRequest(request, conn) : request;

  const point = await resolveTimePoint(effective, conn, systemClock);
  const result = await loadTransactions({ accountId, window, point });

  if (isErr(result)) {
    return <ErrorPanel error={result.error} fixture={false} liveHref={liveHref} />;
  }

  return (
    <TransactionsView view={result.value} basePath={basePath} liveHref={liveHref} />
  );
}

/**
 * Point the request at the book's most recent correction act, mid-write.
 *
 * A URL that already names either axis wins: `?state=edge&asKnownAt=…` means
 * "the edge state, but I have chosen where to stand", and overriding a
 * coordinate a reader typed would make the parameter a suggestion.
 */
async function edgeRequest(
  request: TimeTravelRequest,
  conn: Sql,
): Promise<TimeTravelRequest> {
  if (request.asOfValueDate !== null || request.asKnownAt !== null) return request;

  const { bestDemonstration } = await import("@/lib/timetravel/landmarks");
  const act = await bestDemonstration(conn);
  if (act === null) return request;

  const midWrite =
    act.landmarks.find((landmark) => landmark.kind === "midWrite") ??
    act.landmarks.find((landmark) => landmark.kind === "before");
  if (midWrite === undefined) return request;

  return {
    ...request,
    absent: false,
    asOfValueDate: act.valueDate,
    asOfRaw: act.valueDate,
    asKnownAt: new Date(midWrite.at),
    asKnownAtRaw: midWrite.at,
  };
}

/* -------------------------------------------------------------------------- */
/* Chrome                                                                     */
/* -------------------------------------------------------------------------- */

function StateBar({ state }: { readonly state: DemoState }) {
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
          {DEMO_STATES.map((option) => {
            const current = option === state;
            return (
              <Link
                key={option}
                href={option === "default" ? "/transactions" : `/transactions?state=${option}`}
                aria-current={current ? "page" : undefined}
                title={STATE_HINTS[option]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {option}
              </Link>
            );
          })}
        </div>
        {state === "error" ? (
          <Badge tone="quiet">fixture</Badge>
        ) : (
          <Badge tone="positive">live</Badge>
        )}
      </div>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {STATE_HINTS[state]}
      </p>
    </aside>
  );
}

function ErrorPanel({
  error,
  fixture,
  liveHref,
}: {
  readonly error: { readonly code: string; readonly message: string };
  readonly fixture: boolean;
  readonly liveHref: string;
}) {
  return (
    <Panel
      title="This point could not be read"
      description="A read failure. Nothing moved — this screen only ever issues SELECTs and the journal is append-only."
      actions={fixture ? <Badge tone="quiet">fixture</Badge> : <Badge tone="negative">live</Badge>}
    >
      <div className="px-5 py-6">
        <TableScroll>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">The failure</caption>
            <tbody className="divide-y divide-border">
              <tr>
                <th scope="row" className={`${TH_CLASS} text-left`}>
                  Code
                </th>
                <td className={`${TD_CLASS} font-mono text-xs`}>{error.code}</td>
              </tr>
              <tr>
                <th scope="row" className={`${TH_CLASS} text-left`}>
                  Message
                </th>
                <td className={`${TD_CLASS} max-w-prose`}>{error.message}</td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <RetryButton />
          <Link
            href={liveHref}
            className={`text-sm underline underline-offset-4 ${FOCUS_RING}`}
          >
            Read the book as it stands now
          </Link>
        </div>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* URL plumbing                                                               */
/* -------------------------------------------------------------------------- */

function firstParam(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === undefined || raw === "" ? undefined : raw;
}

function pickState(params: Record<string, string | string[] | undefined>): DemoState {
  const raw = firstParam(params["state"]);
  return DEMO_STATES.find((state) => state === raw) ?? "default";
}

function pickWindow(params: Record<string, string | string[] | undefined>): Window {
  const raw = firstParam(params["window"]);
  return WINDOWS.find((window) => window === raw) ?? "day";
}

/**
 * The `empty` state pins the value axis, and it does so by REWRITING THE
 * QUERY rather than by taking a different code path.
 *
 * That is the point of doing it this way: `?state=empty` is exactly
 * `?asOf=1979-01-02`, it goes through the same parser and the same resolver as
 * a coordinate a reader typed, and the emptiness it shows is derived rather
 * than declared. A demo state implemented as a branch proves nothing about the
 * feature it is demonstrating.
 */
function applyStatePreset(
  params: Record<string, string | string[] | undefined>,
  state: DemoState,
): Record<string, string | string[] | undefined> {
  if (state !== "empty") return params;
  if (firstParam(params[AS_OF_PARAM]) !== undefined) return params;
  return { ...params, [AS_OF_PARAM]: EMPTY_STATE_VALUE_DATE };
}

/** The current URL with all its non-time state — the base every link builds on. */
function buildBasePath({
  state,
  accountId,
  window,
  resolved,
}: {
  readonly state: DemoState;
  readonly accountId: string | null;
  readonly window: Window;
  readonly resolved: Record<string, string | string[] | undefined>;
}): string {
  const params = new URLSearchParams();
  if (state !== "default") params.set("state", state);
  if (accountId !== null) params.set("account", accountId);
  if (window !== "day") params.set("window", window);

  const asOf = firstParam(resolved[AS_OF_PARAM]);
  const asKnownAt = firstParam(resolved[AS_KNOWN_AT_PARAM]);
  if (asOf !== undefined) params.set(AS_OF_PARAM, asOf);
  if (asKnownAt !== undefined) params.set(AS_KNOWN_AT_PARAM, asKnownAt);

  const query = params.toString();
  return query === "" ? "/transactions" : `/transactions?${query}`;
}

/** A Suspense key that changes whenever the point does. */
function keyOf(request: TimeTravelRequest): string {
  return `${request.asOfValueDate ?? ""}@${request.asKnownAt?.toISOString() ?? ""}`;
}
