import { RetryButton } from "@/components/ui/RetryButton";
import { Badge, MetaList, Note, Panel } from "@/components/ui/primitives";
import type { ErrorShape } from "@/lib/result";

import type { TriageDataSource } from "./data-contract";
import { WaitingOnAHuman } from "./WaitingOnAHuman";
import { WhileYouWereAway } from "./WhileYouWereAway";
import { WrongNow } from "./WrongNow";
import type { DashboardViewState } from "./view-state";

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
 */
export async function TriageView({
  source,
  view,
}: {
  readonly source: TriageDataSource;
  readonly view: DashboardViewState;
}) {
  const result = await source.read();

  if (!result.ok) return <TriageErrorPanel error={result.error} />;
  const triage = result.value;

  return (
    <div className="space-y-6">
      <Panel
        title="Start of shift"
        description="One read, one instant. Everything below describes the book as of the watermark on this line."
        actions={
          <Badge tone={triage.live ? "positive" : "negative"}>
            {triage.live ? "LIVE" : "FIXTURE"}
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
          {triage.live ? null : (
            <Note emphasis title="Nothing on this screen is a statement about a real book">
              This is the <code>{view.state}</code> fixture. The invariant counts, the
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
 * The read failed.
 *
 * It says so, with the driver's own code, and it does NOT fall back to a
 * fixture. A triage board that quietly served drawn data when the database was
 * unreachable would be the worst possible version of this screen: the one
 * question it exists to answer is "is anything wrong", and an unread book
 * rendering as an all-clear is the same failure as an unreadable invariant
 * counting as a pass.
 */
export function TriageErrorPanel({ error }: { readonly error: ErrorShape }) {
  return (
    <Panel
      title="The triage board could not be read"
      description="No board is drawn from nothing. This is not an all-clear."
      actions={<RetryButton />}
    >
      <div className="space-y-3 px-5 py-4">
        <MetaList
          items={[
            { label: "code", value: <span className="money">{error.code}</span> },
            { label: "retryable", value: detail(error, "retryable") ?? "—" },
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
