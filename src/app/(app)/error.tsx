"use client";

/**
 * The last honest thing a screen can say.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * There was no `error.tsx` anywhere under `(app)` until the last day. A reader
 * that threw past its own guard therefore left the page in its Suspense
 * fallback — a skeleton, animating, at HTTP 200, forever. An operator watching
 * it had no way to tell "this is loading" from "this died", and the status code
 * said everything was fine.
 *
 * That is the same shape this repository has catalogued 31 times and spent two
 * days removing: a surface reporting health because the failure was shaped like
 * the success. `/team` served a skeleton and a 200 for hours. `/statements`
 * printed HASH REPRODUCED with no connection open. A permanently-loading
 * skeleton is the third member of that family, and it is the one that was still
 * standing.
 *
 * Next composes this for every route segment under `(app)`, so a screen added
 * tomorrow is covered without anyone remembering — the same default-deny
 * property the authorisation policy is built on.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not retry automatically, and it does not pretend the money is fine.
 * A read that threw tells you nothing about the book; the only true statement
 * available here is that this screen could not be drawn and why. Whether the
 * underlying operation happened is a question for the ledger, and the ledger is
 * append-only — so the honest instruction is to re-read it, not to re-submit.
 */

import { useEffect } from "react";

export default function AppSegmentError({
  error,
  reset,
}: {
  readonly error: Error & { readonly digest?: string };
  readonly reset: () => void;
}) {
  useEffect(() => {
    // Server-thrown errors reach the client with their message replaced by a
    // digest. Printing it is the only way a reader can match what they see to
    // the server log line that actually says what happened.
    // eslint-disable-next-line no-console
    console.error("[corgi] screen failed to render", error.digest ?? error.message);
  }, [error]);

  return (
    <div className="space-y-4 p-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">
          This screen could not be drawn
        </h1>
        <p className="mt-0.5 max-w-prose text-sm text-muted">
          A read failed after the page had started rendering, so what you are
          looking at is not an empty book — it is a screen that never got one.
          Nothing on this page was written, and nothing here is a statement
          about your balance.
        </p>
      </header>

      <dl className="max-w-prose space-y-1 text-xs">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted">code</dt>
          <dd>
            <code>SCREEN_RENDER_FAILED</code>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted">digest</dt>
          <dd>
            <code>{error.digest ?? "(none — this one threw on the client)"}</code>
          </dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted">retryable</dt>
          <dd>
            yes — this re-runs the read. It does not re-submit anything, because
            nothing here submitted.
          </dd>
        </div>
      </dl>

      <button
        type="button"
        onClick={reset}
        className="rounded border px-3 py-1.5 text-sm underline-offset-4 hover:underline"
      >
        Read it again
      </button>

      <p className="max-w-prose text-[11px] leading-relaxed text-muted">
        If it fails again, the book itself may be unreachable rather than this
        one screen — <a href="/api/health" className="underline underline-offset-4">/api/health</a>{" "}
        answers that directly, and it is the surface every document here defers
        to when they disagree.
      </p>
    </div>
  );
}
