import { Suspense } from "react";
import Link from "next/link";
import type { Metadata } from "next";

import { isErr } from "@/lib/result";
import type { ErrorShape } from "@/lib/result";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
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
// Imports nothing itself, so asking whether there is a database cannot be the
// thing that crashes the page for not having one. See its header.
import { hasDatabase } from "@/lib/has-database";

import { RefusalPanel } from "@/components/timetravel/Refusal";
import { TransactionsSkeleton } from "@/components/timetravel/TransactionsSkeleton";
import { TransactionsView } from "@/components/timetravel/TransactionsView";
import {
  EMPTY_STATE_VALUE_DATE,
  FIXTURE_READ_FAILURE,
} from "@/components/timetravel/fixtures";
import { TRANSACTIONS_NO_DATABASE } from "@/components/timetravel/unreadable";

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
 * What the state bar says when the coordinates did not parse.
 *
 * It replaces the state hint rather than sitting beside it. `STATE_HINTS.default`
 * reads "the same reads the account screens take", which is a promise that this
 * render went to the book — hoverable, and false, over a panel saying the
 * request never reached a connection. One screen, one claim, includes the
 * claims a reader has to hover to find.
 */
const REFUSED_COORDINATE_HINT =
  "The time-travel coordinates on this URL did not parse, so no connection was opened and no row was read. Nothing below is a statement about this book at any instant. Clear the parameters to return to the live watermark.";

/**
 * What the state bar says when there is nothing to read.
 *
 * One sentence, used in two places — the line under the links, and the
 * tooltip on every state that would otherwise have read the database. The
 * tooltip mattered: it carried a hint promising the live watermark, and left
 * that promise hoverable on a screen whose badge says NO DATABASE. One screen,
 * one claim, includes the claims a reader has to hover to find.
 */
const NO_DATABASE_HINT =
  "No database is configured for this deployment. No account was listed, no posting was folded and no closing balance was derived — nothing below was read, and no day is drawn in its place.";

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

  // ONE VALUE, TWO SURFACES. The state bar's badge and the section's refusal
  // both come from this line. They used to be worked out separately and both
  // printed the word `live` on a deployment that had read nothing — the state
  // bar because the state was not `error`, and the error panel because the
  // failure was not a fixture.
  const noDatabase = !hasDatabase();

  return (
    <div className="space-y-6">
      <StateBar state={state} noDatabase={noDatabase} coordinatesRefused={!parsed.ok} />

      {parsed.ok ? (
        <Suspense
          key={`${state}:${accountId ?? ""}:${window}:${keyOf(parsed.request)}`}
          fallback={<TransactionsSkeleton />}
        >
          <TransactionsSection
            state={state}
            noDatabase={noDatabase}
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
  noDatabase,
  accountId,
  window,
  request,
  basePath,
  liveHref,
}: {
  readonly state: DemoState;
  readonly noDatabase: boolean;
  readonly accountId: string | null;
  readonly window: Window;
  readonly request: TimeTravelRequest;
  readonly basePath: string;
  readonly liveHref: string;
}) {
  if (state === "error") {
    return <ErrorPanel error={FIXTURE_READ_FAILURE} claim="fixture" liveHref={liveHref} />;
  }

  // Asked of `@/lib/has-database`, which imports nothing. It used to be asked
  // by destructuring `hasDatabase` off `await import("./live-source")` — the
  // shape that on five sibling screens made the guard unreachable, because
  // importing a live source evaluates `@/lib/env` and throws without
  // `APP_DATABASE_URL`. It happened to survive here; it survived on luck.
  if (noDatabase) {
    return (
      <ErrorPanel
        error={TRANSACTIONS_NO_DATABASE}
        claim="unreadable"
        liveHref={liveHref}
      />
    );
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
    return <ErrorPanel error={result.error} claim="live" liveHref={liveHref} />;
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

/**
 * The demo-state switch, and THE SCREEN'S ONE CLAIM ABOUT ITS DATA SOURCE.
 *
 * The badge on the right used to read `live` for every state but `error`,
 * which made it a claim about the URL rather than about the data: with no
 * database configured it said `live` above a panel that also said `live`,
 * on a screen that had read nothing. `noDatabase` is resolved once in
 * `TransactionsPage` and this badge and the section's refusal both come from
 * it, so the two cannot disagree.
 *
 * THERE IS A SECOND WAY THIS SCREEN READS NOTHING, and the repair above did
 * not cover it. `?asOf=` and `?asKnownAt=` are validated by a pure function
 * BEFORE a connection is opened — that is the point of validating them, so an
 * impossible coordinate never reaches the database — and when the validation
 * fails the page renders `RefusalPanel` in place of the board. On a deployment
 * WITH a database, in the `default` state, `noDatabase` is false and the badge
 * read `live` directly above a panel whose own words are "nothing was read and
 * nothing moved ... this request never reached a connection".
 *
 * So the badge now takes `read`, which is the question it was always trying to
 * answer: did THIS render reach the book. It is one more input to the same
 * value rather than a second predicate — `TransactionsPage` computes it on the
 * line where it already knows both halves, and passes the answer down.
 */
function StateBar({
  state,
  noDatabase,
  coordinatesRefused,
}: {
  readonly state: DemoState;
  readonly noDatabase: boolean;
  /** The coordinates did not parse, so no connection was opened for this render. */
  readonly coordinatesRefused: boolean;
}) {
  const refusing = noDatabase && state !== "error";

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
                title={refusing && option !== "error" ? NO_DATABASE_HINT : STATE_HINTS[option]}
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
        {refusing ? (
          <Badge tone="negative">NO DATABASE</Badge>
        ) : state === "error" ? (
          <Badge tone="quiet">fixture</Badge>
        ) : coordinatesRefused ? (
          // No badge, because there is no source to name. The refusal below
          // says what happened; a `live` here would contradict it and a
          // `fixture` here would be a different untruth.
          <Badge tone="quiet">NOTHING READ</Badge>
        ) : (
          <Badge tone="positive">live</Badge>
        )}
      </div>
      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {refusing
          ? NO_DATABASE_HINT
          : coordinatesRefused
            ? REFUSED_COORDINATE_HINT
            : STATE_HINTS[state]}
      </p>
    </aside>
  );
}

/**
 * The read did not happen, for one of three reasons, and this is the whole
 * screen.
 *
 * `claim` says WHICH of the three, and it is the same word the state bar used:
 *
 *   fixture     `?state=error`, a synthesised failure, badged as drawn
 *   live        a real read of a real book that failed
 *   unreadable  there is no database. The panel carries NO badge, because the
 *               state bar above it already carries the screen's one claim and
 *               a second badge here is a second claim a reader has to reconcile.
 *
 * The retry control is dropped when the failure says it is not retryable. A
 * button offering to re-run a read that cannot succeed sits next to the words
 * "retryable: no" and contradicts them; a refresh does not configure a
 * database.
 */
function ErrorPanel({
  error,
  claim,
  liveHref,
}: {
  readonly error: ErrorShape;
  readonly claim: "fixture" | "live" | "unreadable";
  readonly liveHref: string;
}) {
  const refusing = claim === "unreadable";
  const retry = isRetryable(error);

  return (
    <Panel
      title={refusing ? "This screen cannot see the book" : "This point could not be read"}
      description={
        refusing
          ? "No database is configured for this deployment, so no point in time was resolved and no day is drawn. Nothing here is a reading of an empty book."
          : "A read failure. Nothing moved — this screen only ever issues SELECTs and the journal is append-only."
      }
      {...(refusing
        ? {}
        : {
            actions:
              claim === "fixture" ? (
                <Badge tone="quiet">fixture</Badge>
              ) : (
                <Badge tone="negative">live</Badge>
              ),
          })}
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
              <tr>
                <th scope="row" className={`${TH_CLASS} text-left`}>
                  Retryable
                </th>
                <td className={`${TD_CLASS} font-mono text-xs`}>
                  {retry ? "yes" : "no"}
                </td>
              </tr>
            </tbody>
          </table>
        </TableScroll>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {retry ? <RetryButton /> : null}
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
