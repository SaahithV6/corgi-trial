import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";

import {
  DEMO_STATES,
  DEMO_STATE_HINTS,
  DEMO_STATE_LABELS,
  demoQuery,
  type OnboardingView,
} from "./demo-state";

/**
 * Live switch between the screen's five states.
 *
 * Dashed and muted on purpose — it is scaffolding, and scaffolding that looks
 * like a feature is a lie. Every entry is a plain link to the same route with a
 * different query string, so each state has a URL that reproduces it and only
 * `default` reads the database.
 */
/**
 * What the bar says when there is nothing to read.
 *
 * It replaces the state hint rather than sitting beside it. The `default` hint
 * reads "with the KYB state derived from its evidence", and over a screen that
 * read no evidence row it is a second claim that disagrees with the first.
 */
const NO_DATABASE_NOTE =
  "No database is configured for this deployment. No business was listed, no verification leg was read and no composite state was derived — an empty list here is not a book with no businesses on it, and no business awaiting review is not a queue somebody has cleared. The gate is unaffected: canTransact() reads the same view on every payment path and fails closed.";

/**
 * ONE SCREEN, ONE CLAIM ABOUT ITS DATA SOURCE. `noDatabase` comes from
 * `page.tsx`, which resolved it once with `hasDatabase()` and handed the same
 * value to `OnboardingView` to choose the source it reads through. When it is
 * set on the live state, this bar carries the screen's only source badge — the
 * body below it is a refusal and badges nothing.
 */
export function DemoStateBar({
  view,
  noDatabase = false,
}: {
  readonly view: OnboardingView;
  readonly noDatabase?: boolean;
}) {
  // `default` is the only state that reads the database, so it is the only one
  // that has nothing to show without one.
  const refusing = noDatabase && view.state === "default";

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
          {DEMO_STATES.map((state) => {
            const current = state === view.state;
            return (
              <Link
                key={state}
                href={`/onboarding${demoQuery(state)}`}
                aria-current={current ? "page" : undefined}
                title={DEMO_STATE_HINTS[state]}
                className={`rounded px-2 py-1 text-xs ${FOCUS_RING} ${
                  current
                    ? "bg-surface-raised font-medium text-text shadow-[inset_0_0_0_1px_var(--color-border-strong)]"
                    : "text-muted hover:text-text"
                }`}
              >
                {DEMO_STATE_LABELS[state]}
              </Link>
            );
          })}
        </div>

        {refusing ? <Badge tone="negative">NO DATABASE</Badge> : null}
      </div>

      <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
        {refusing
          ? NO_DATABASE_NOTE
          : view.state === "edge"
            ? "A real Stripe Identity session came back verified. The registry leg was ours. Both legs approve, so the verification is APPROVED — and its evidence reads SIMULATED, because a composite is only as live as its least live leg. There is no code path that could label that row live."
            : DEMO_STATE_HINTS[view.state]}
      </p>
    </aside>
  );
}
