import { RetryButton } from "@/components/ui/RetryButton";
import { Badge, MetaList, Note, Panel } from "@/components/ui/primitives";
import type { ErrorShape } from "@/lib/result";

import type { TriageDataSource } from "./data-contract";
import { WaitingOnAHuman } from "./WaitingOnAHuman";
import { WhileYouWereAway } from "./WhileYouWereAway";
import { WrongNow } from "./WrongNow";
import {
  sourceBadge,
  sourceIsLive,
  type DashboardViewState,
  type SourceClaim,
} from "./view-state";

/**
 * The triage board.
 *
 * ============================================================================
 * THREE SECTIONS, IN THIS ORDER, AND THE ORDER IS THE PRODUCT.
 *
 *   1  Is anything wrong right now?      — and is it new, or was it decided?
 *   2  What is waiting on a human?       — the queues the machine refused
 *   3  What did the machine do?          — and what it refused, and cannot say
 *
 * An operator opening this build otherwise has to already know which of 21
 * screens holds the thing that is wrong. This is the screen that answers
 * "what needs me now", and every figure on it links to the screen that works
 * it — because a dashboard you cannot drill through is a claim, and this
 * build's whole posture is that a figure without its evidence is worthless.
 * ============================================================================
 *
 * NOT A METRICS DASHBOARD. There is no counter here that only goes up. Every
 * number is either a queue depth (which goes down when somebody does the work)
 * or a comparison against something written down (which is either matched or
 * not). "1,439 webhooks processed" is wallpaper and it is deliberately absent.
 *
 * THE BADGE COMES FROM `claim`, which `page.tsx` resolved once and gave to the
 * state bar as well. It used to come from `triage.live` while the bar above it
 * used the URL state, and on a deployment with no database the two rendered
 * opposite words on one screen. The snapshot's own `live` field is still
 * checked against the claim below, and a disagreement is a refusal rather than
 * a casting vote.
 */
export async function TriageView({
  source,
  view,
  claim,
}: {
  readonly source: TriageDataSource;
  readonly view: DashboardViewState;
  readonly claim: SourceClaim;
}) {
  const result = await source.read();

  if (!result.ok) {
    return claim.kind === "unreadable" ? (
      <TriageErrorPanel
        error={result.error}
        title="This screen cannot see the book"
        description="No database is configured for this deployment, so no view was read and no board is drawn. Nothing here says the ledger is fine; nothing here could."
      />
    ) : (
      <TriageErrorPanel error={result.error} />
    );
  }
  const triage = result.value;

  if (triage.live !== sourceIsLive(claim)) {
    return (
      <TriageErrorPanel
        error={CONTRADICTION(claim, triage.live)}
        title="The screen and its source disagree about what was read"
        description="Two claims about one read. Neither is shown as the answer, because a screen that picks one is a screen that can pick the wrong one."
      />
    );
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Start of shift"
        description="One read, one instant. Everything below describes the book as of the watermark on this line."
        actions={
          <Badge tone={sourceIsLive(claim) ? "positive" : "negative"}>
            {sourceBadge(claim)}
          </Badge>
        }
      >
        <div className="space-y-3 px-5 py-4">
          <MetaList
            items={[
              { label: "as of", value: <span className="money">{triage.readAt}</span> },
              {
                label: "booking watermark",
                value: <span className="money">{triage.bookingWatermark}</span>,
              },
              { label: "state", value: view.state },
            ]}
          />
          {claim.kind !== "fixture" ? null : (
            <Note emphasis title="Nothing on this screen is a statement about a real book">
              This is the <code>{claim.state}</code> fixture. The invariant counts, the
              queues and the traces below are drawn, not read. The claim section 1 makes
              is &ldquo;nothing new is wrong with the ledger&rdquo;, and a screenshot of a
              fixture making that claim would be the most misleading artefact this
              repository could produce — so the badge above says FIXTURE and this note is
              not dismissible.
            </Note>
          )}
        </div>
      </Panel>

      <WrongNow section={triage.invariants} />
      <WaitingOnAHuman human={triage.human} />
      <WhileYouWereAway machine={triage.machine} />
    </div>
  );
}

/**
 * The book was not read, for whatever reason, and this is the whole screen.
 *
 * It says so, with the driver's own code, and it does NOT fall back to a
 * fixture. A triage board that quietly served drawn data when the database was
 * unreachable would be the worst possible version of this screen: the one
 * question it exists to answer is "is anything wrong", and an unread book
 * rendering as an all-clear is the same failure as an unreadable invariant
 * counting as a pass.
 *
 * `title` and `description` default to the failed-read wording and are
 * overridden for the two causes that are not a failed read — no database
 * configured, and a screen that disagrees with its own source. All three
 * refuse identically: no board, no counts, no tick.
 *
 * The retry control is dropped when the failure says it is not retryable. A
 * button offering to re-run a read that cannot succeed — there is no database
 * to refresh into existence — sits next to the words "retryable: no" and
 * contradicts them.
 */
export function TriageErrorPanel({
  error,
  title = "The triage board could not be read",
  description = "No board is drawn from nothing. This is not an all-clear.",
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
}) {
  const retryable = detail(error, "retryable");

  return (
    <Panel
      title={title}
      description={description}
      {...(retryable === "no" ? {} : { actions: <RetryButton /> })}
    >
      <div className="space-y-3 px-5 py-4">
        <MetaList
          items={[
            { label: "code", value: <span className="money">{error.code}</span> },
            { label: "retryable", value: retryable ?? "—" },
            { label: "source", value: detail(error, "source") ?? "—" },
          ]}
        />
        <p className="max-w-prose text-sm leading-relaxed">{error.message}</p>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Nothing on this path writes: it issues only SELECTs, and the application role
          holds SELECT and INSERT and nothing else on the money tables. A failure here
          cannot have moved anything.
        </p>
      </div>
    </Panel>
  );
}

/**
 * The screen resolved one source and was handed a snapshot claiming another.
 *
 * Unreachable as this file is written — the live source sets `live: true`, the
 * fixtures set `live: false`, and `page.tsx` picks between them from the same
 * claim it hands this component. It is checked anyway because the failure it
 * would produce is the one this repository keeps finding: a screen showing a
 * drawn board under a LIVE badge, with nothing on the page admitting which of
 * the two values was believed. A refusal loses a demo; picking one loses the
 * operator's ability to trust the badge at all.
 */
function CONTRADICTION(claim: SourceClaim, live: boolean): ErrorShape {
  return {
    code: "TRIAGE_SOURCE_CONTRADICTION",
    message: `The page resolved this screen's source as ${sourceBadge(claim)} and the snapshot it was handed reports live=${String(live)}. One of the two is wrong and this screen cannot tell which, so it shows neither. The board is not drawn.`,
    details: {
      retryable: false,
      source: "dashboard.triage",
      operation: "the source claim",
    },
  };
}

/**
 * `ErrorShape.details` is deliberately `unknown` — the type is shared by every
 * route in this build and a per-caller shape does not belong in it. The source
 * puts `{ retryable, source, operation }` there; this reads it back defensively
 * rather than casting, so a failure whose details came from somewhere else
 * renders as a dash instead of throwing inside the panel that exists to report
 * a throw.
 */
function detail(error: ErrorShape, key: string): string | null {
  const details: unknown = error.details;
  if (typeof details !== "object" || details === null) return null;
  const value: unknown = (details as Record<string, unknown>)[key];
  if (typeof value === "boolean") return value ? "yes" : "no";
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The real skeleton. Same shape, so the page does not jump when it resolves. */
export function TriageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Reading the book…</span>
      {["Start of shift", "1 · Is anything wrong right now?", "2 · What is waiting on a human?", "3 · What did the machine do while I was away?"].map(
        (title, i) => (
          <Panel key={title} title={title}>
            <div className="space-y-2 px-5 py-4">
              {Array.from({ length: i === 0 ? 1 : 4 }).map((_, row) => (
                <div
                  key={row}
                  className="h-4 animate-pulse rounded bg-surface-raised"
                  style={{ width: `${String(90 - row * 12)}%` }}
                />
              ))}
            </div>
          </Panel>
        ),
      )}
    </div>
  );
}
