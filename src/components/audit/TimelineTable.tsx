import Link from "next/link";

import { Money } from "@/components/ui/Money";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import type { ActorAction } from "@/lib/audit/types";

import { ActorBadge } from "./ActorBadge";
import { auditHref, type AuditFilter } from "./view-state";

/**
 * One business, everything that happened to it, in order.
 *
 * BOTH TIME AXES, AND ONLY WHERE THEY DIFFER. Every row carries
 * `occurred_at` (when it happened) and `recorded_at` (when we learned). Most
 * stores keep one clock and the two are equal; printing them twice would
 * imply a second observation that never took place, so the second column is
 * rendered as a dash with the pair spelled out in the tooltip, and a row where
 * they genuinely disagree gets the `learned later` badge. That badge is the
 * bitemporal story made visible on a screen that is not about money: a KYB
 * decision observed at the provider on Tuesday and recorded here on Thursday
 * is the same shape as Tuesday's settlement reversed on Thursday.
 *
 * ORDERED BY ONE NAMED AXIS AT A TIME, never by a blend of the two: the header
 * marks which clock is sorting the list, and `?order=` switches it. See
 * `listActions()` for why a single `GREATEST(...)` order answers both
 * questions by answering neither.
 */
export function TimelineTable({
  actions,
  filter,
}: {
  readonly actions: readonly ActorAction[];
  readonly filter: AuditFilter;
}) {
  return (
    <TableScroll>
      <table className="w-full border-collapse">
        <caption className="sr-only">
          Actions taken against this business, most recent first. Each row names the actor, the
          surface, and the append-only store the fact was read from.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th scope="col" className={TH_CLASS}>
              Occurred{filter.order === "occurred" ? " ▾" : ""}
            </th>
            <th scope="col" className={TH_CLASS}>
              Recorded{filter.order === "recorded" ? " ▾" : ""}
            </th>
            <th scope="col" className={TH_CLASS}>
              Actor
            </th>
            <th scope="col" className={TH_CLASS}>
              Action
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              Amount
            </th>
            <th scope="col" className={TH_CLASS}>
              Source
            </th>
          </tr>
        </thead>
        <tbody>
          {actions.map((a) => {
            const selected = filter.selected === a.actionId;
            return (
              <tr
                key={a.actionId}
                className={`border-b border-border/60 ${selected ? "bg-surface-raised" : ""}`}
              >
                <td className={`${TD_CLASS} whitespace-nowrap tabular-nums text-muted`}>
                  {formatTimestamp(a.occurredAt)}
                </td>
                <td className={`${TD_CLASS} whitespace-nowrap tabular-nums text-muted`}>
                  {a.timeAxesDiffer ? (
                    <span className="inline-flex items-center gap-1.5">
                      {formatTimestamp(a.recordedAt)}
                      <Badge
                        tone="neutral"
                        title={`Happened ${a.occurredAt}; this book learned ${a.recordedAt}.`}
                      >
                        learned later
                      </Badge>
                    </span>
                  ) : (
                    <span title="One clock in this store: it happened and was recorded together.">
                      —
                    </span>
                  )}
                </td>
                <td className={TD_CLASS}>
                  <ActorBadge kind={a.actorKind} label={a.actorLabel} />
                </td>
                <td className={TD_CLASS}>
                  <Link
                    href={auditHref(filter, { selected: selected ? null : a.actionId })}
                    className={`rounded ${FOCUS_RING} hover:underline`}
                    aria-expanded={selected}
                  >
                    {a.summary}
                  </Link>
                  <div className="mt-0.5 font-mono text-[11px] text-muted">{a.action}</div>
                </td>
                <td className={`${TD_CLASS} text-right tabular-nums`}>
                  {a.amountCents === null ? (
                    <span className="text-muted" title="This action has no amount.">
                      —
                    </span>
                  ) : (
                    <Money cents={a.amountCents} tone="neutral" />
                  )}
                </td>
                <td className={TD_CLASS}>
                  <Link
                    href={auditHref(filter, { source: a.source, page: 0, selected: null })}
                    className={`font-mono text-[11px] text-muted hover:text-text ${FOCUS_RING} rounded`}
                  >
                    {a.source}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}
