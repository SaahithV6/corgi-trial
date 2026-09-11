import Link from "next/link";

import { FOCUS_RING, Panel, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import type { TimeTravelRefusal } from "@/lib/timetravel/params";

/**
 * AN IMPOSSIBLE COORDINATE, REFUSED.
 *
 * ===========================================================================
 * WHY THIS IS A PANEL AND NOT A FALLBACK
 * ===========================================================================
 *
 * Everywhere else on this console a malformed query parameter falls back to
 * the default, because a 500 on a bad URL is a worse answer than ignoring it.
 * `/statements` shows the default day for a mistyped `?day=` and the day
 * picker says which day it picked.
 *
 * That rule is inverted for these two parameters and the inversion is the
 * point. Ignoring `?day=` shows you a different day and the screen tells you.
 * Ignoring `?asKnownAt=` shows you TODAY'S BELIEF under a heading claiming it
 * is a past one — the failure is a number, it is invisible, and the whole
 * claim of the screen is that the number is what we believed at that moment.
 *
 * So nothing is rendered in its place. Not a default day, not a zero, not a
 * greyed-out figure. The screen says which parameter it will not honour, what
 * is wrong with it, and WHY that is a refusal rather than a coercion — because
 * a reader who disagrees with the third column is disagreeing with a decision
 * somebody made, which they can argue with, rather than with a validator,
 * which they cannot.
 */
export function RefusalPanel({
  refusals,
  liveHref,
}: {
  readonly refusals: readonly TimeTravelRefusal[];
  readonly liveHref: string;
}) {
  return (
    <Panel
      title="This point in time cannot be rendered"
      description="Both parameters are checked, so a URL with two problems reports two problems rather than revealing the second only after the first is fixed."
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Time-travel parameters this request will not honour, with the reason
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Parameter
              </th>
              <th scope="col" className={TH_CLASS}>
                What is wrong
              </th>
              <th scope="col" className={TH_CLASS}>
                Why it is refused rather than ignored
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {refusals.map((refusal) => (
              <tr key={`${refusal.param}:${refusal.code}`}>
                <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                  <span className="font-mono text-xs">?{refusal.param}=</span>
                  <span className="mt-0.5 block max-w-[16rem] truncate font-mono text-[11px] text-negative">
                    {refusal.given}
                  </span>
                  <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
                    {refusal.code}
                  </span>
                </th>
                <td className={TD_CLASS}>{refusal.what}</td>
                <td className={`${TD_CLASS} max-w-prose text-muted`}>
                  {refusal.because}
                  {refusal.suggestion === null ? null : (
                    <span className="mt-1 block font-mono text-[11px] text-text">
                      try ?{refusal.suggestion}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      <div className="border-t border-border px-5 py-4">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Nothing was read and nothing moved. The ledger is append-only and a
          query cannot alter it; this request never reached a connection,
          because the two parameters are validated before one is opened.
        </p>
        <Link
          href={liveHref}
          className={`mt-2 inline-block text-sm underline underline-offset-4 ${FOCUS_RING}`}
        >
          Read the book as it stands now
        </Link>
      </div>
    </Panel>
  );
}
