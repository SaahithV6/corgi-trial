import Link from "next/link";
import type { Route } from "next";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
} from "@/components/ui/primitives";

import type { HumanSection } from "./data-contract";

/**
 * SECTION 2 — What is waiting on a human?
 *
 * ============================================================================
 * Five queues, each one a thing the machine has refused to decide on its own.
 * That framing is the point: none of these is a failure. Every one of them is
 * the system declining to guess, and the correct response to all five is a
 * person, not a retry.
 * ============================================================================
 *
 * RANKED BY WHAT THE ROWS SAY, NEVER BY A SCORE
 *
 *   approvals      by age of the oldest still-pending instruction
 *   breaks         by `recon/aging.ts` — the recon module's own ladder, which
 *                  is about DAY CLOSES rather than about money: `aged` means
 *                  somebody signed off a book day with this break open. This
 *                  screen imports that order rather than restating it.
 *   parked         by how many deliveries are waiting on the same referent
 *   dead letters   by count, with the oldest age the view itself computed
 *   credits        by when the transfer was first seen
 *
 * There is no cross-queue ranking. An approvals queue and a recon break are
 * not commensurable and pretending they are, with one number, is how a
 * dashboard starts lying.
 */
export function WaitingOnAHuman({ human }: { readonly human: HumanSection }) {
  const nothing =
    human.approvals.pending === 0 &&
    human.disputes.needingDecision === 0 &&
    human.parkedTotal === 0 &&
    human.deadLetterTotal === 0 &&
    human.unattributed.length === 0 &&
    human.breaks.breaks.length === 0;

  return (
    <Panel
      id="waiting"
      title="2 · What is waiting on a human?"
      description="Decisions the machine has deliberately refused to make on its own. Every row names the referent it is waiting for."
    >
      <div className="space-y-5 px-5 py-4">
        {nothing ? (
          <p className="max-w-prose text-sm leading-relaxed">
            Nothing. No payment is awaiting a second approver, no dispute is awaiting a
            decision, every delivery has found its referent, and last night&rsquo;s file
            reconciled clean.
          </p>
        ) : null}

        {/* ---- approvals + disputes ---- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Tile
            title="Payments awaiting a second approver"
            href="/approvals"
            linkText="Approvals queue"
          >
            <p className="text-2xl money">
              {human.approvals.pending}
              {human.approvals.capped ? (
                <span className="ml-1 align-super text-xs text-muted">at least</span>
              ) : null}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {human.approvals.aboveThreshold} of them above the policy threshold and
              therefore blocked until a second human signs —{" "}
              <Money cents={human.approvals.aboveThresholdCents} tone="neutral" /> of{" "}
              <Money cents={human.approvals.totalCents} tone="neutral" /> queued.
            </p>
            <p className="mt-1 text-xs text-muted">
              {human.approvals.oldestAt === null
                ? "Nothing pending."
                : `Oldest raised ${human.approvals.oldestAt}.`}
            </p>
            {human.approvals.capped ? (
              <p className="mt-1 max-w-prose text-xs leading-relaxed money-negative">
                The queue read hit its 200-row page limit, so this count is a FLOOR and
                the &ldquo;oldest&rdquo; above is the oldest on the page, not on the book.
              </p>
            ) : null}
          </Tile>

          <Tile title="Disputes awaiting a decision" href="/disputes" linkText="Disputes">
            <p className="text-2xl money">{human.disputes.needingDecision}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              Open, needing an authorisation nobody has granted or declined.{" "}
              {human.disputes.open} open in total, {human.disputes.closed} closed. Every
              predicate here is a boolean column of <code>v_dispute_state</code> — the
              schema&rsquo;s own answer to what a dispute&rsquo;s position is.
            </p>
          </Tile>
        </div>

        {/* ---- recon breaks ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Reconciliation breaks, by age{" "}
            <span className="text-muted">
              ({human.breaks.breaks.length} on the most recent run)
            </span>
          </h3>
          {human.breaks.run === null ? (
            <p className="max-w-prose text-xs leading-relaxed text-muted">
              No file has been reconciled on this book yet.
            </p>
          ) : (
            <>
              <p className="max-w-prose text-xs leading-relaxed text-muted">
                Run {human.breaks.run.runNo} of{" "}
                <code>{human.breaks.run.filename}</code>, business date{" "}
                {human.breaks.run.businessDate}: {human.breaks.run.matchedCount} of{" "}
                {human.breaks.run.fileRowCount} rows matched,{" "}
                {human.breaks.run.breakCount} broke,{" "}
                <Money cents={human.breaks.run.breakTotalCents} tone="neutral" />{" "}
                out. Severity and age bucket come from{" "}
                <code>src/lib/recon/aging.ts</code> — the engine&rsquo;s own ladder,
                which measures DAY CLOSES crossed, not money.
              </p>
              <div className="flex flex-wrap gap-2">
                {human.breaks.bySeverity.map((s) => (
                  <Badge key={s.severity} tone={s.severity === "explained" ? "quiet" : "neutral"}>
                    {s.severity}: {s.count}
                  </Badge>
                ))}
                {human.breaks.byAge.map((a) => (
                  <Badge key={a.bucket} tone="quiet">
                    {a.bucket} days: {a.count}
                  </Badge>
                ))}
              </div>
              <TableScroll>
                <table className="w-full border-collapse text-left">
                  <thead>
                    <tr className="border-y border-border">
                      <th className={TH_CLASS}>break</th>
                      <th className={TH_CLASS}>severity</th>
                      <th className={TH_CLASS}>age</th>
                      <th className={TH_CLASS}>out by</th>
                      <th className={TH_CLASS}>why it ranks there</th>
                    </tr>
                  </thead>
                  <tbody>
                    {human.breaks.breaks.map((b) => (
                      <tr key={b.id} className="border-b border-border">
                        <td className={TD_CLASS}>
                          <Link
                            href={`/reconciliation?break=${encodeURIComponent(b.id)}` as Route}
                            className={`money text-xs underline underline-offset-4 ${FOCUS_RING}`}
                          >
                            {b.externalRef}
                          </Link>
                          <p className="text-xs text-muted">{b.kind}</p>
                        </td>
                        <td className={TD_CLASS}>
                          <Badge tone={b.severity === "explained" ? "quiet" : "neutral"}>
                            {b.severity}
                          </Badge>
                        </td>
                        <td className={`${TD_CLASS} money text-xs`}>
                          {b.ageDays}d · {b.closesCrossed} close
                          {b.closesCrossed === 1 ? "" : "s"}
                        </td>
                        <td className={TD_CLASS}>
                          <Money cents={b.breakAmountCents} signed tone="direction" />
                        </td>
                        <td className={TD_CLASS}>
                          <p className="max-w-prose text-xs leading-relaxed text-muted">
                            {b.severityReason}
                          </p>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
              <Note title="This panel is scoped to one run, and the book is not">
                <p>
                  <code>/reconciliation</code> shows a run — a (file, booking watermark)
                  pair, which is how an ops team works: &ldquo;last night&rsquo;s ACH
                  file&rdquo;. This panel shows the same run so every break above links
                  to a row that screen will actually contain.
                </p>
                <p className="mt-2">
                  Across <em>every</em> file ever ingested,{" "}
                  <span className="money">{human.breaks.bookWide}</span> breaks are open
                  in <code>v_recon_break</code> right now. That figure is{" "}
                  <strong>not drillable from this screen</strong> and it is not comparable
                  with the run count above — no screen in this build lists breaks across
                  files. A book-wide breaks view is the follow-up this panel names rather
                  than a number it quietly omits.
                </p>
              </Note>
            </>
          )}
        </section>

        {/* ---- parked ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Parked deliveries <span className="text-muted">({human.parkedTotal})</span>
          </h3>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            A verified money event the system is holding because it names a referent this
            book has never seen. Not an error and not a drop:{" "}
            <strong>nothing was posted</strong>, because posting would mean guessing whose
            money to move. Each group names what it is waiting for; registering that
            referent drains the group on the next drain tick.
          </p>
          {human.parked.length === 0 ? (
            <p className="text-xs text-muted">Nothing parked.</p>
          ) : (
            <TableScroll>
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-y border-border">
                    <th className={TH_CLASS}>waiting for</th>
                    <th className={TH_CLASS}>referent</th>
                    <th className={TH_CLASS}>held</th>
                    <th className={TH_CLASS}>the consumer&rsquo;s own words</th>
                  </tr>
                </thead>
                <tbody>
                  {human.parked.map((p) => (
                    <tr key={`${p.kind}:${p.ref ?? "—"}`} className="border-b border-border">
                      <td className={TD_CLASS}>
                        <code className="text-xs">{p.kind}</code>
                      </td>
                      <td className={`${TD_CLASS} money text-xs`}>{p.ref ?? "—"}</td>
                      <td className={`${TD_CLASS} money`}>{p.count}</td>
                      <td className={TD_CLASS}>
                        <p className="max-w-prose text-xs leading-relaxed text-muted">
                          {p.reason ?? "no reason recorded"}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </section>

        {/* ---- dead letters ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Dead letters <span className="text-muted">({human.deadLetterTotal})</span>
          </h3>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            Retry budget exhausted. Bounded failure in front of a person rather than
            silence — the delivery is still in <code>webhook_inbox</code>, still verified,
            still un-posted. <code>scripts/redrive.mjs</code> is what clears them once the
            referent exists.
          </p>
          {human.deadLetters.length === 0 ? (
            <p className="text-xs text-muted">None.</p>
          ) : (
            <TableScroll>
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-y border-border">
                    <th className={TH_CLASS}>provider</th>
                    <th className={TH_CLASS}>was waiting for</th>
                    <th className={TH_CLASS}>count</th>
                    <th className={TH_CLASS}>oldest</th>
                    <th className={TH_CLASS}>newest one&rsquo;s reason</th>
                  </tr>
                </thead>
                <tbody>
                  {human.deadLetters.map((d) => (
                    <tr key={`${d.provider}:${d.kind ?? "—"}`} className="border-b border-border">
                      <td className={TD_CLASS}>
                        <code className="text-xs">{d.provider}</code>
                      </td>
                      <td className={TD_CLASS}>
                        <code className="text-xs">{d.kind ?? "—"}</code>
                      </td>
                      <td className={`${TD_CLASS} money`}>{d.count}</td>
                      <td className={`${TD_CLASS} money text-xs`}>
                        {d.oldestAgeDays === null ? "—" : `${d.oldestAgeDays}d`}
                      </td>
                      <td className={TD_CLASS}>
                        <p className="max-w-prose text-xs leading-relaxed text-muted">
                          {d.reason ?? "no reason recorded"}
                        </p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </section>

        {/* ---- unattributed credits ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Inbound credits nobody can attribute{" "}
            <span className="text-muted">({human.unattributed.length})</span>
          </h3>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            Money arrived and the system cannot tell whose it is. The correct behaviour is
            the one taken: nothing posted, no balance moved, and a person has to attribute
            it by hand. Each row is one inbound transfer, however many deliveries it
            produced.
          </p>
          {human.unattributed.length === 0 ? (
            <p className="text-xs text-muted">None.</p>
          ) : (
            <ul className="space-y-2">
              {human.unattributed.map((u) => (
                <li
                  key={u.transferId}
                  className="rounded-md border border-border bg-surface-raised px-4 py-3"
                >
                  <p className="money text-xs">{u.transferId}</p>
                  <p className="mt-1 text-xs text-muted">
                    first seen {u.firstSeenAt} · {u.ageDays}d · {u.deliveries} deliver
                    {u.deliveries === 1 ? "y" : "ies"} · {u.stillParked} still parked ·{" "}
                    {u.deadLettered} dead-lettered · attributed:{" "}
                    {u.attributed ? "yes" : "no"}
                  </p>
                  <p className="mt-1 max-w-prose text-xs leading-relaxed">
                    {u.reason ?? "no reason recorded"}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Panel>
  );
}

function Tile({
  title,
  href,
  linkText,
  children,
}: {
  readonly title: string;
  readonly href: string;
  readonly linkText: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-surface-raised px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">{title}</h3>
        <Link
          href={href as Route}
          className={`text-xs underline underline-offset-4 ${FOCUS_RING}`}
        >
          {linkText}
        </Link>
      </div>
      {children}
    </div>
  );
}
