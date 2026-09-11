import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { formatDate } from "@/lib/format/datetime";

import type { AccountOption, DayOption } from "./data-contract";
import { statementHref, type StatementFilter } from "./view-state";

/**
 * Pick a business, then pick a value date.
 *
 * Both are links, not a form: the view is entirely URL state, so a picker that
 * needed JavaScript to work would make the screen unshareable and untestable
 * for no gain.
 *
 * The day chips carry two counts and both are load-bearing:
 *
 *   `v2` (or higher)  this day has been reissued — a correction landed after
 *                     it was published. These are the interesting days and the
 *                     screen makes them findable rather than making an
 *                     operator open each one.
 *   `+n late`         entries with this value date were booked after the
 *                     close. A day can have late postings without ever having
 *                     been reissued, which is a real backlog and worth seeing
 *                     from the picker.
 *
 * A closed day with no activity is still listed. "We closed and nothing
 * happened" and "we never closed" are different facts and only one of them is
 * a problem; hiding the first would leave an operator unable to tell them apart.
 *
 * A date that is NOT a closed day gets a chip too, marked `open`, whenever the
 * URL selects one. The screen can read any value date on both axes — that is
 * the point of deriving the readings rather than storing them — and a picker
 * that could only express the closed ones would make the most demoable view on
 * this screen reachable only by hand-editing the query string.
 */
export function StatementPicker({
  accounts,
  days,
  filter,
  selectedAccountId,
  selectedDay,
}: {
  readonly accounts: readonly AccountOption[];
  readonly days: readonly DayOption[];
  readonly filter: StatementFilter;
  readonly selectedAccountId: string | null;
  readonly selectedDay: string | null;
}) {
  return (
    <div className="space-y-3">
      <Group label="Business">
        {accounts.length === 0 ? (
          <span className="text-xs text-muted">No customer deposit accounts.</span>
        ) : (
          accounts.map((account) => (
            <Chip
              key={account.accountId}
              // Changing the business drops the day: a date that exists for one
              // account's book need not have a statement on another's, and
              // carrying it would land on a spurious empty state.
              href={statementHref(filter, {
                accountId: account.accountId,
                businessDate: null,
                version: null,
              })}
              current={account.accountId === selectedAccountId}
            >
              {account.legalName}
            </Chip>
          ))
        )}
      </Group>

      <Group label="Value date">
        {selectedDay !== null && !days.some((d) => d.businessDate === selectedDay) ? (
          // The selected date is not a closed day. That is a legitimate view
          // and the most interesting one during a debrief — a correction that
          // landed this morning lives on a day nobody has signed off yet — so
          // it is shown as a chip of its own rather than leaving the row
          // looking as though nothing is selected.
          <Chip
            href={statementHref(filter, { businessDate: selectedDay, version: null })}
            current
            title="This business day has not been closed. Both readings still answer; no watermark has been frozen for it."
          >
            {formatDate(selectedDay)}
            <Tag muted>open</Tag>
          </Chip>
        ) : null}

        {days.length === 0 ? (
          <span className="text-xs text-muted">
            No business day has been closed for this book yet.
          </span>
        ) : (
          days.slice(0, 14).map((day) => (
            <Chip
              key={day.businessDate}
              href={statementHref(filter, {
                businessDate: day.businessDate,
                version: null,
              })}
              current={day.businessDate === selectedDay}
              title={`Closed at booking watermark ${day.bookingWatermark}`}
            >
              {formatDate(day.businessDate)}
              {day.versionCount > 1 ? (
                <Tag tone="negative">v{day.versionCount}</Tag>
              ) : day.versionCount === 1 ? (
                <Tag>v1</Tag>
              ) : (
                <Tag muted>—</Tag>
              )}
              {day.latePostingCount > 0 ? (
                <Tag tone="negative">+{day.latePostingCount} late</Tag>
              ) : null}
            </Chip>
          ))
        )}
      </Group>
    </div>
  );
}

function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="w-24 shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  href,
  current,
  title,
  children,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly title?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "true" : undefined}
      {...(title === undefined ? {} : { title })}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${FOCUS_RING} ${
        current
          ? "border-border-strong bg-surface-raised font-medium text-text"
          : "border-border text-muted hover:text-text"
      }`}
    >
      {children}
    </Link>
  );
}

function Tag({
  tone = "neutral",
  muted = false,
  children,
}: {
  readonly tone?: "neutral" | "negative";
  readonly muted?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <span
      className={`tabular-nums text-[10px] ${
        tone === "negative" ? "text-negative" : muted ? "text-muted/60" : "text-muted"
      }`}
    >
      {children}
    </span>
  );
}
