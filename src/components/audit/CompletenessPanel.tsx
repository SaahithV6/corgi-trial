import Link from "next/link";

import {
  Badge,
  FOCUS_RING,
  Note,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
} from "@/components/ui/primitives";
import type { Completeness } from "@/lib/audit/types";

import { auditHref, type AuditFilter } from "./view-state";

/**
 * Completeness, measured rather than asserted.
 *
 * `/breaks` prints "showing 7 of 7, the engine reported 7, this screen hides
 * none". The equivalent claim for an actor trail is harder, because the thing
 * it could be missing is not a row — it is a whole STORE. So this panel makes
 * four statements, each of which is a live query and none of which is a
 * constant in this file:
 *
 *   1. PER SOURCE: rows counted directly off the table, versus rows that came
 *      out of the projection. They must be equal. `v_audit_coverage_drift`
 *      is the invariant; it was made to fail on purpose against this database
 *      before it was believed (accrual_day 36 stored / 35 projected after one
 *      LEFT JOIN was changed to an INNER JOIN — see docs/AUDIT.md).
 *
 *   2. UNCLAIMED TABLES: every base table in the schema is either projected
 *      or excluded with a written reason. A table nobody has classified is
 *      reported here in red. This is the check a write-path audit log cannot
 *      have — there is no catalog of call sites, but there is a catalog of
 *      tables.
 *
 *   3. MUTABLE SOURCES: a projected source the application role can UPDATE or
 *      DELETE. Evidence the app can rewrite is not evidence.
 *
 *   4. EXCLUSIONS, WITH THE ARGUMENT: including the ones marked HOLE, which
 *      are the places an action is taken and recorded NOWHERE. Those are
 *      printed on the screen rather than buried in a document, because a
 *      trail that shows only what it has is exactly the trail that reads
 *      complete and is not.
 */
export function CompletenessPanel({
  completeness,
  bySource,
  filter,
}: {
  readonly completeness: Completeness;
  readonly bySource: Readonly<Record<string, number>>;
  readonly filter: AuditFilter;
}) {
  const { sources, unclaimed, mutable, weak, exclusions } = completeness;
  const stored = sources.reduce((n, s) => n + s.storedRows, 0n);
  const projected = sources.reduce((n, s) => n + s.projectedRows, 0n);
  const dropped = sources.reduce((n, s) => n + s.droppedRows, 0n);
  const awaiting = sources.filter((s) => s.disposition === "awaiting_wiring");
  const holes = exclusions.filter((e) => e.isHole);

  return (
    <Panel
      title="Completeness"
      description={`${sources.length} sources reconciled against the stores they read: ${projected.toLocaleString()} rows projected, ${stored.toLocaleString()} rows stored, ${dropped.toLocaleString()} dropped.`}
    >
      <div className="space-y-5 px-5 py-4">
        {dropped === 0n ? (
          <Note title="Every projected source reconciles exactly">
            <code>v_audit_coverage_drift</code> is empty: for all {sources.length} sources, the row
            count taken directly off the table equals the row count that came out of the
            projection. The two counts are computed independently on purpose — deriving one from
            the other would make the check read green because it is the same number twice.
          </Note>
        ) : (
          <Note emphasis title={`${dropped.toLocaleString()} rows exist in a store and not on this timeline`}>
            A join in the projection is dropping rows. Every row below with a non-zero drop is an
            action that happened and that this screen cannot show you.
          </Note>
        )}

        {unclaimed.length > 0 ? (
          <Note
            emphasis
            title={`${unclaimed.length} base table${unclaimed.length === 1 ? "" : "s"} in this schema ${unclaimed.length === 1 ? "is" : "are"} not classified`}
          >
            <p>
              The trail does not cover these, and it says so rather than reading complete:{" "}
              <span className="font-mono">{unclaimed.join(", ")}</span>.
            </p>
            <p className="mt-1">
              Each one must be appended to <code>audit_source</code> as projected or as excluded
              with a written reason. Until then, any action recorded only in one of them is absent
              from this screen.
            </p>
          </Note>
        ) : (
          <Note title="Every base table in the schema is classified">
            <code>v_audit_source_unclaimed</code> is empty. The detector is the widest possible one
            — every base table, no name pattern and no column-shape heuristic — because a narrower
            detector can be fooled by a store shaped exactly like the thing it would skip.
          </Note>
        )}

        {mutable.length > 0 ? (
          <Note emphasis title="A source on this timeline is not append-only">
            <span className="font-mono">
              {mutable.map((m) => `${m.source} (${m.privileges})`).join(", ")}
            </span>
            . The application role can rewrite these rows, so they are not evidence and must be
            excluded from the trail rather than shown on it.
          </Note>
        ) : (
          <Note title="Every source on this timeline is append-only for the application">
            <code>v_audit_source_mutable</code> is empty: <code>corgi_app</code> holds no UPDATE,
            DELETE or TRUNCATE on any projected store. The trail owns no rows of its own, so there
            is nothing here to edit either.
            {weak.length > 0 ? (
              <>
                {" "}
                {weak.length} source{weak.length === 1 ? "" : "s"} (
                <span className="font-mono">{weak.map((w) => w.source).join(", ")}</span>) rest on
                privileges alone with no BEFORE UPDATE OR DELETE trigger, so the table OWNER could
                still rewrite them. Every money table has both layers; these have one.
              </>
            ) : null}
          </Note>
        ) }

        {awaiting.length > 0 ? (
          <Note emphasis title={`${awaiting.length} surface is recorded nowhere durable`}>
            {awaiting.map((s) => (
              <p key={s.source} className="mt-1">
                <span className="font-mono">{s.source}</span> — {s.reason}
              </p>
            ))}
          </Note>
        ) : null}

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            per source — stored versus projected
          </p>
          <TableScroll>
            <table className="w-full border-collapse">
              <caption className="sr-only">
                Each projected source, the rows stored in it, the rows the projection produced, and
                how many of them belong to the business on screen.
              </caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className={TH_CLASS}>
                    Source
                  </th>
                  <th scope="col" className={TH_CLASS}>
                    Surface
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Stored
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Projected
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    Dropped
                  </th>
                  <th scope="col" className={`${TH_CLASS} text-right`}>
                    This business
                  </th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.source} className="border-b border-border/60">
                    <td className={`${TD_CLASS} font-mono text-[11px]`}>
                      <Link
                        href={auditHref(filter, { source: s.source, page: 0, selected: null })}
                        className={`rounded hover:underline ${FOCUS_RING}`}
                      >
                        {s.source}
                      </Link>
                      {s.disposition === "awaiting_wiring" ? (
                        <>
                          {" "}
                          <Badge tone="negative" title={s.reason}>
                            not wired
                          </Badge>
                        </>
                      ) : null}
                    </td>
                    <td className={`${TD_CLASS} text-muted`}>{s.surface ?? "—"}</td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {s.storedRows.toLocaleString()}
                    </td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {s.projectedRows.toLocaleString()}
                    </td>
                    <td className={`${TD_CLASS} text-right tabular-nums`}>
                      {s.droppedRows === 0n ? (
                        <span className="text-muted">0</span>
                      ) : (
                        <Badge tone="negative">{s.droppedRows.toLocaleString()}</Badge>
                      )}
                    </td>
                    <td className={`${TD_CLASS} text-right tabular-nums text-muted`}>
                      {(bySource[s.source] ?? 0).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </div>

        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            {holes.length} place{holes.length === 1 ? "" : "s"} an action is taken and recorded
            nowhere
          </p>
          <ul className="space-y-2 text-xs">
            {holes.map((h) => (
              <li key={h.source} className="rounded border border-negative/40 px-3 py-2">
                <span className="font-mono text-[11px]">{h.source}</span>
                <span className="ml-2 text-muted">{h.reason.replace(/^HOLE\.\s*/, "")}</span>
              </li>
            ))}
          </ul>
        </div>

        <details className="text-xs">
          <summary className={`cursor-pointer rounded text-muted ${FOCUS_RING}`}>
            {exclusions.length} tables deliberately not on the trail, each with its argument
          </summary>
          <ul className="mt-2 space-y-1.5">
            {exclusions
              .filter((e) => !e.isHole)
              .map((e) => (
                <li key={e.source} className="flex flex-wrap gap-x-2">
                  <span className="font-mono text-[11px]">{e.source}</span>
                  <span className="max-w-prose text-muted">{e.reason}</span>
                </li>
              ))}
          </ul>
        </details>
      </div>
    </Panel>
  );
}
