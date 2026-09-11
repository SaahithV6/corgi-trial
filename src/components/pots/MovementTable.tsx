import { Money } from "@/components/ui/Money";
import {
  Badge,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import type { MovementView } from "./data-contract";

/**
 * The internal transfers this customer's pots have seen, as journal entries.
 *
 * NOT "every" ONE, AND THE HEADER SAYS SO. `listMovements()` selects
 * `WHERE e.rail = 'internal' AND e.idempotency_key LIKE 'pot:%'`, newest first
 * by `booking_seq`, `LIMIT 50`. Both exclusions matter and neither was printed:
 * the cap silently truncates a busy customer, and the key prefix is the
 * WRITER'S OWN LABEL, which `v_internal_transfer_impure` on this same screen
 * already confesses is bypassable — the $50.00 posted out of a pot under an
 * `ach:` key on 2026-09-11 moved a pot balance and never appeared in this
 * table. So the description names the order, the cap, and the view that catches
 * what the key prefix misses.
 *
 * There is no `pot_transfer` table behind this. The rows are `journal_entry`
 * joined to `journal_line`, and both lines of each entry are printed with their
 * stored signs, because "sums to zero" is a claim best answered by showing the
 * two numbers.
 *
 * THE FOUR RIGHT-HAND COLUMNS ARE THE POINT. `rail`, `external_ref`,
 * `hold_id`, `inbox_id` are the columns that carry an external fact when there
 * is one: the provider's transfer id, the webhook delivery it arrived on, the
 * card hold it consumed. On an internal transfer they read `internal`, `—`,
 * `—`, `—`, and that is the evidence for "no rail was touched". Asserting it in
 * prose would be worth nothing; the columns that would betray it are on screen.
 *
 * AND SO IS THE `entry_type` COLUMN. A move out of a pot is an `original`
 * entry, not a reversal and not an edit — putting money back is an ordinary
 * transfer in the other direction, which is what makes the whole thing
 * reversible without a correction path. The correction path still exists, and
 * an entry booked here for the wrong amount is reversed and re-booked exactly
 * like a card clearing; it would show up in this column as `reversal` and
 * `rebook`, on the ORIGINAL entry's value date.
 */
export function MovementTable({
  movements,
}: {
  readonly movements: readonly MovementView[];
}) {
  return (
    <Panel
      id="movements"
      title="Internal transfers"
      description="Two lines, one customer, one book, rail = internal. Instant because there is nothing external to wait for. Newest first by booking sequence, capped at 50: an older transfer than the last row is not shown here. The population is entries whose idempotency key begins pot: — the writer's own label — so an entry that moved pot money without that key is absent from this table and is caught instead by v_pot_line_provenance in the invariants above."
      actions={<Badge tone="quiet">{movements.length} shown</Badge>}
    >
      {movements.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          No internal transfers yet. When there are, each one is a journal entry
          and nothing else — there is no separate transfers table for this list
          to read from, and no second copy of the truth to drift.
        </p>
      ) : (
        <TableScroll>
          <table className="w-full border-collapse">
            <caption className="sr-only">
              Internal transfers between the main balance and this
              customer&rsquo;s pots
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={TH_CLASS}>
                  Value date · seq
                </th>
                <th scope="col" className={TH_CLASS}>
                  Entry
                </th>
                <th scope="col" className={TH_CLASS}>
                  Lines (debit positive, credit negative)
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Amount
                </th>
                <th scope="col" className={TH_CLASS}>
                  rail · external_ref · hold_id · inbox_id
                </th>
              </tr>
            </thead>
            <tbody>
              {movements.map((m) => (
                <tr key={m.entryId} className="border-b border-border align-top">
                  <td className={TD_CLASS}>
                    <span className="money text-xs">{m.valueDate}</span>
                    <p className="mt-0.5 text-xs text-muted">
                      seq <span className="money">{m.bookingSeq}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{m.actorName}</p>
                  </td>

                  <td className={TD_CLASS}>
                    <p className="text-sm">{m.description}</p>
                    <p className="mt-1 text-[11px] text-muted">
                      entry{" "}
                      <span className="money break-all">{m.entryId}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted">
                      key{" "}
                      <span className="money break-all">{m.idempotencyKey}</span>
                    </p>
                    <p className="mt-1">
                      <Badge tone={m.entryType === "original" ? "quiet" : "neutral"}>
                        {m.entryType}
                      </Badge>{" "}
                      <Badge tone={m.direction === "in" ? "neutral" : "quiet"}>
                        {m.direction === "in" ? "earmarked" : "released"}
                      </Badge>
                    </p>
                  </td>

                  <td className={TD_CLASS}>
                    <ul className="space-y-1">
                      {m.lines.map((line, index) => (
                        <li
                          key={`${m.entryId}:${index}`}
                          className="flex items-baseline justify-between gap-4 text-xs"
                        >
                          <span className="text-muted">
                            <span className="money">{line.accountCode}</span>{" "}
                            {line.accountLabel}
                          </span>
                          <Money
                            cents={line.amountCents}
                            tone="direction"
                            signed
                          />
                        </li>
                      ))}
                      <li className="flex items-baseline justify-between gap-4 border-t border-border pt-1 text-xs">
                        <span className="text-muted">sums to</span>
                        <Money
                          cents={m.lines.reduce((a, l) => a + l.amountCents, 0)}
                          tone="neutral"
                          signed
                        />
                      </li>
                    </ul>
                  </td>

                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={m.amountCents} className="font-semibold" />
                  </td>

                  <td className={`${TD_CLASS} text-xs`}>
                    <span className="money">{m.railColumns.rail ?? "—"}</span>
                    <span className="text-muted"> · </span>
                    <span className="money">{m.railColumns.externalRef ?? "—"}</span>
                    <span className="text-muted"> · </span>
                    <span className="money">{m.railColumns.holdId ?? "—"}</span>
                    <span className="text-muted"> · </span>
                    <span className="money">{m.railColumns.inboxId ?? "—"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      <div className="border-t border-border px-5 py-4">
        <Note title="Reversibility, and what it is not">
          <p>
            Money leaving a pot is another ordinary entry in the other
            direction: <code>entry_type = original</code>, its own idempotency
            key, its own booking sequence. Nothing about the entry that put the
            money in is touched, and there is no path in this codebase that
            could touch it — <code>corgi_app</code> holds no UPDATE or DELETE on{" "}
            <code>journal_entry</code> or <code>journal_line</code>, and{" "}
            <code>pnpm db:check</code> proves that by attempting both.
          </p>
          <p className="mt-2">
            A transfer posted for the WRONG amount is a different problem and
            gets the same answer as everywhere else in this system: a reversal
            at the original value date plus a re-book, tied by a correction
            group. Both would appear in this table, on the day it happened.
          </p>
        </Note>
      </div>
    </Panel>
  );
}
