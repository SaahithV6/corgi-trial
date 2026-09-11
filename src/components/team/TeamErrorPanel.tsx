import Link from "next/link";

import { Badge, FOCUS_RING } from "@/components/ui/primitives";
import { isRetryable } from "@/components/ui/error-detail";
import { RetryButton } from "@/components/ui/RetryButton";
import type { ErrorShape } from "@/lib/result";

/**
 * The error state, in the form the rest of this console uses.
 *
 * WHAT THIS REPLACES. A failed read was a bare `<Note>` carrying
 * `result.message` and a paragraph: no code, no `retryable`, no retry control,
 * and no source claim. An operator could not tell a transient Neon timeout
 * from a book with no business on it, had nothing to press either way, and the
 * screen made no statement at all about what it had read.
 *
 * The three rows are the ones every other screen here prints, in the order an
 * operator needs them: the machine-readable code, the message, and whether
 * trying again could possibly work. `readTeamScreen()` supplies only the
 * message, so `./unreadable.ts` supplies the rest at this boundary.
 *
 * THE FIRST SENTENCE IS THE ONE THAT MATTERS AND IT IS ABOUT SOMEWHERE ELSE.
 * A screen that cannot read the team shows this. The real-time authorisation
 * decision, given the same failure, DECLINES — a revocation that only holds
 * while the database is reachable has not been made. The two mechanisms fail
 * in opposite directions on purpose, and this panel is the read half.
 *
 * `claim` carries the screen's source badge when the panel IS the screen: the
 * `error` demo state is a drawing of a failure and says `fixture` on its face,
 * and a real failure claims nothing because it read nothing and is not
 * pretending otherwise. With no database the badge is on the state bar, which
 * is the screen's one claim.
 *
 * The retry control is dropped when the failure says it is not retryable. A
 * button offering to re-run a read that cannot succeed sits next to the words
 * "retryable: no" and contradicts them, and a refresh does not configure a
 * database.
 */
export function TeamErrorPanel({
  error,
  title = "The team could not be read",
  description = "This is a read failure. Nothing was written; this path only reads and it never posts. Note what the SAME failure means on the authorisation path: a screen that cannot read the team shows this, and the real-time authorisation decision DECLINES, because a revocation that only holds while the database is reachable has not been made.",
  claim,
}: {
  readonly error: ErrorShape;
  readonly title?: string;
  readonly description?: string;
  readonly claim?: string;
}) {
  return (
    <section
      aria-labelledby="team-error-title"
      className="rounded-lg border border-negative/40 bg-surface"
    >
      <div className="border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
          <h2
            id="team-error-title"
            className="text-sm font-semibold tracking-tight text-negative"
          >
            {title}
          </h2>
          {claim === undefined ? null : <Badge tone="quiet">{claim}</Badge>}
        </div>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{description}</p>
      </div>

      <div className="px-5 py-4">
        <dl className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Code</dt>
          <dd className="font-mono text-xs">{error.code}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Message</dt>
          <dd className="max-w-prose text-sm">{error.message}</dd>

          <dt className="text-xs uppercase tracking-[0.08em] text-muted">Retryable</dt>
          <dd className="font-mono text-xs">{isRetryable(error) ? "yes" : "no"}</dd>
        </dl>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {isRetryable(error) ? <RetryButton /> : null}
          <Link
            href="/team"
            className={`rounded px-2 py-1.5 text-xs text-muted underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
          >
            Leave this state
          </Link>
        </div>
      </div>
    </section>
  );
}
