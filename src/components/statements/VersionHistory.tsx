import Link from "next/link";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";

import type { PublishedStatementView } from "./data-contract";
import { Hash } from "./Provenance";
import { statementHref, type StatementFilter } from "./view-state";

/**
 * Every version issued for this day, oldest first.
 *
 * A corrected statement is a NEW DOCUMENT WITH A VERSION, never an edit. That
 * is how banks do it, and it is the only answer that survives the question "so
 * which is it, immutable or corrected?" — v1 is immutable, v2 is corrected,
 * and both exist.
 *
 * Each row is selectable, and selecting it makes it the as-published side of
 * the comparison above. Selecting the newest version is worth doing in a demo:
 * the difference goes to zero and the corrections list empties, which is the
 * clearest possible statement that reissuing closed the gap without touching
 * what came before.
 *
 * The watermark and the hash are on screen because they are what make the
 * claim checkable rather than asserted. Two versions at the same watermark
 * MUST carry the same hash — the publisher refuses to write a second one, so
 * seeing two would mean something got past both the privilege layer and the
 * append-only trigger.
 */
export function VersionHistory({
  versions,
  selected,
  filter,
}: {
  readonly versions: readonly PublishedStatementView[];
  /**
   * The version anchoring the left-hand reading, or `null` when the reading is
   * anchored somewhere else entirely — at the day close, or at the instant
   * before a correction. A day can have published versions AND be read at a
   * watermark none of them was issued against; in that case no row is current
   * and the table says so by highlighting nothing.
   */
  readonly selected: PublishedStatementView | null;
  readonly filter: StatementFilter;
}) {
  const current = versions[versions.length - 1];

  return (
    <Panel
      title="Versions of this statement"
      description="A correction produces a new version. Nothing here is ever edited or withdrawn."
    >
      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Published versions of this day&rsquo;s statement, oldest first
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Version
              </th>
              <th scope="col" className={TH_CLASS}>
                Issued
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Watermark
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Lines
              </th>
              <th scope="col" className={`${TH_CLASS} text-right`}>
                Closing
              </th>
              <th scope="col" className={TH_CLASS}>
                Content hash
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => {
              const isSelected = selected !== null && version.statementId === selected.statementId;
              return (
                <tr
                  key={version.statementId}
                  className={`border-b border-border last:border-b-0 ${
                    isSelected ? "bg-surface-raised" : ""
                  }`}
                  aria-current={isSelected ? "true" : undefined}
                >
                  <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                    <Link
                      href={statementHref(filter, { version: version.version })}
                      className={`font-medium underline underline-offset-4 hover:text-muted ${FOCUS_RING}`}
                    >
                      v{version.version}
                    </Link>
                    {current !== undefined &&
                    version.statementId === current.statementId ? (
                      <Badge tone="neutral" title="The newest version issued for this day">
                        CURRENT
                      </Badge>
                    ) : null}
                  </th>

                  <td className={`${TD_CLASS} whitespace-nowrap text-xs text-muted`}>
                    {formatTimestamp(version.generatedAt)}
                    <span className="mt-0.5 block">{version.generatedBy}</span>
                  </td>

                  <td className={`${TD_CLASS} text-right tabular-nums`}>
                    {version.bookingWatermark}
                  </td>

                  <td className={`${TD_CLASS} text-right tabular-nums`}>
                    {version.lineCount}
                  </td>

                  <td className={`${TD_CLASS} text-right`}>
                    <Money cents={version.closingBalanceCents} />
                  </td>

                  <td className={TD_CLASS}>
                    <Hash value={version.contentHash} label={`version ${version.version}`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
