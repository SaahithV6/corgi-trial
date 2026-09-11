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
  type BadgeTone,
} from "@/components/ui/primitives";

import type { MachineSection } from "./data-contract";

/**
 * SECTION 3 — What did the machine do while I was away?
 *
 * ============================================================================
 * THE LIMIT COMES FIRST, BECAUSE IT CHANGES HOW EVERY NUMBER BELOW READS.
 *
 * There is no cron-run table in this schema. Nothing records that a tick
 * happened, what it answered, or how long it took. What this panel reads is
 * the EFFECT of a tick — the newest row in the store each job writes into —
 * and three things follow from that, all of them stated on the screen:
 *
 *   1. A tick that ran and had nothing to do writes nothing. So "no trace
 *      since Tuesday" cannot distinguish a job that stopped from a job with an
 *      empty in-tray. Several sweeps in this build ran for days doing exactly
 *      that and reported success.
 *   2. A tick that FAILED writes nothing either. An HTTP 500 on a schedule is
 *      invisible here, and it is invisible in the database generally: the
 *      status code lives in the platform's function log, which this
 *      deployment's runtime cannot read.
 *   3. A trace can be written by something that is not the cron. The
 *      standing-order refusals below carry `decided_by_run`, and its prefix is
 *      the only thing that says whether a tick or a test harness wrote the
 *      row. That column is printed for exactly this reason.
 *
 * The fix for all three is a run-log table written by the route itself — one
 * row per tick, with its verdict — which is a migration and outside this
 * screen's scope. It is named in docs/DASHBOARD.md as the follow-up rather
 * than left to be discovered.
 * ============================================================================
 */

const VERDICT_TONE: Record<string, BadgeTone> = {
  consuming: "positive",
  idle: "quiet",
  superseded: "quiet",
  backlogged: "neutral",
  dropping: "negative",
  never_consumed: "negative",
  unmeasured: "neutral",
};

export function WhileYouWereAway({ machine }: { readonly machine: MachineSection }) {
  const holes = machine.completeness.exclusions.filter((e) => e.isHole);
  const awaiting = machine.completeness.sources.filter(
    (s) => s.disposition === "awaiting_wiring",
  );

  return (
    <Panel
      id="machine"
      title="3 · What did the machine do while I was away?"
      description="The scheduled jobs, what they posted, and what they refused — read from the traces they left, not from a tick nobody records."
      actions={
        <Link
          href={"/audit" as Route}
          className={`text-xs underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
        >
          Audit trail
        </Link>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <Note emphasis title="This panel reads effects, not ticks — and the difference matters">
          <p>
            Nothing in this schema records that a scheduled job ran. Every timestamp below
            is the newest row in the store that job <em>writes into</em>, so a tick that
            ran and had nothing to do is indistinguishable from a tick that never
            happened, and a tick that returned HTTP 500 is indistinguishable from both.
            The status code lives in the platform&rsquo;s function log, which this runtime
            cannot read.
          </p>
          <p className="mt-2">
            Read a stale timestamp as <em>&ldquo;nothing has been written here
            since&rdquo;</em> and nothing stronger. The fix is a run-log table written by
            the route itself — one row per tick, with its verdict — which is a migration
            and is named as the follow-up in <code>docs/DASHBOARD.md</code>.
          </p>
        </Note>

        {/* ---- the five jobs ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Scheduled jobs <span className="text-muted">(vercel.json)</span>
          </h3>
          <TableScroll>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-y border-border">
                  <th className={TH_CLASS}>job</th>
                  <th className={TH_CLASS}>schedule</th>
                  <th className={TH_CLASS}>last trace</th>
                  <th className={TH_CLASS}>rows</th>
                  <th className={TH_CLASS}>what it does · what proves it</th>
                </tr>
              </thead>
              <tbody>
                {machine.jobs.map((job) => (
                  <tr key={job.path} className="border-b border-border">
                    <td className={TD_CLASS}>
                      <code className="text-xs">{job.path}</code>
                    </td>
                    <td className={`${TD_CLASS} money text-xs`}>{job.schedule}</td>
                    <td className={`${TD_CLASS} money text-xs`}>
                      {job.lastTraceAt ?? "never"}
                    </td>
                    <td className={`${TD_CLASS} money`}>{job.traceCount}</td>
                    <td className={TD_CLASS}>
                      <p className="max-w-prose text-xs leading-relaxed">{job.what}</p>
                      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                        Traced by <code>{job.tracedBy}</code> — {job.traceNote}.
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </section>

        {/* ---- webhook processing ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Webhook consumers, per provider
          </h3>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            The <code>webhookProcessing</code> field of <code>/api/health</code>, computed
            by the same two functions the endpoint calls —{" "}
            <code>readWebhookProcessing()</code> then{" "}
            <code>webhookProcessingHealth()</code> — so this screen and the JSON cannot
            disagree. The verdict vocabulary is theirs: <code>dropping</code> and{" "}
            <code>never_consumed</code> are the two that mean money events are arriving
            and not being applied.
          </p>
          {machine.processing.measured ? null : (
            <p className="max-w-prose text-xs leading-relaxed money-negative">
              Not measured: {machine.processing.error ?? "unknown"}. That is not a verdict
              about the consumers — it is the absence of one.
            </p>
          )}
          <TableScroll>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-y border-border">
                  <th className={TH_CLASS}>provider</th>
                  <th className={TH_CLASS}>verdict</th>
                  <th className={TH_CLASS}>last consumed</th>
                  <th className={TH_CLASS}>parked</th>
                  <th className={TH_CLASS}>dead</th>
                  <th className={TH_CLASS}>what that means</th>
                </tr>
              </thead>
              <tbody>
                {machine.processing.providers.map((p) => (
                  <tr key={p.provider} className="border-b border-border">
                    <td className={TD_CLASS}>
                      <p className="text-xs font-medium">{p.label}</p>
                      <code className="text-xs text-muted">{p.provider}</code>
                    </td>
                    <td className={TD_CLASS}>
                      <Badge tone={VERDICT_TONE[p.verdict] ?? "quiet"}>{p.verdict}</Badge>
                    </td>
                    <td className={`${TD_CLASS} money text-xs`}>
                      {p.lastConsumed ?? "never"}
                    </td>
                    <td className={`${TD_CLASS} money`}>{p.parked.count}</td>
                    <td className={`${TD_CLASS} money`}>
                      {p.deadLettered.count}
                      {p.deadLettered.count > 0 ? (
                        <span className="ml-1 text-xs text-muted">
                          ({p.deadLettered.sinceLastConsumed} since it last consumed)
                        </span>
                      ) : null}
                    </td>
                    <td className={TD_CLASS}>
                      <p className="max-w-prose text-xs leading-relaxed text-muted">
                        {p.note}
                      </p>
                      {p.deadLettered.supersededByConsumption ? (
                        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                          Every dead letter predates a later success: a backlog to
                          redrive, not evidence of current loss.
                        </p>
                      ) : null}
                      {p.deadLettered.clearedBy === null ? null : (
                        <p className="mt-1 text-xs text-muted">
                          Cleared by <code>{p.deadLettered.clearedBy}</code>.
                        </p>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </section>

        {/* ---- refusals ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            What the standing-order tick refused
          </h3>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            A refusal is an outcome, not a crash: the occurrence is closed, the next one
            is unaffected, and the tick recorded every availability term it observed so
            the decline can be re-derived rather than believed.{" "}
            <code>decided_by_run</code> is grouped on its prefix because that is the only
            thing that says <em>who</em> ran it — <code>standing-…</code> is the cron
            route, <code>test-…</code> is a harness.
          </p>
          {machine.refusals.length === 0 ? (
            <p className="text-xs text-muted">Nothing refused.</p>
          ) : (
            <TableScroll>
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-y border-border">
                    <th className={TH_CLASS}>code</th>
                    <th className={TH_CLASS}>run</th>
                    <th className={TH_CLASS}>count</th>
                    <th className={TH_CLASS}>newest</th>
                    <th className={TH_CLASS}>available it saw</th>
                    <th className={TH_CLASS}>short by</th>
                  </tr>
                </thead>
                <tbody>
                  {machine.refusals.map((r) => (
                    <tr key={`${r.code}:${r.runPrefix}`} className="border-b border-border">
                      <td className={TD_CLASS}>
                        <code className="text-xs">{r.code}</code>
                        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                          {r.reason}
                        </p>
                      </td>
                      <td className={TD_CLASS}>
                        <Badge tone={r.runPrefix === "standing" ? "neutral" : "quiet"}>
                          {r.runPrefix}
                        </Badge>
                      </td>
                      <td className={`${TD_CLASS} money`}>{r.count}</td>
                      <td className={`${TD_CLASS} money text-xs`}>{r.newestAt ?? "—"}</td>
                      <td className={TD_CLASS}>
                        {r.observedAvailableCents === null ? (
                          "—"
                        ) : (
                          <Money cents={r.observedAvailableCents} tone="neutral" />
                        )}
                      </td>
                      <td className={TD_CLASS}>
                        {r.shortfallCents === null ? (
                          "—"
                        ) : (
                          <Money cents={r.shortfallCents} tone="auto" />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </section>

        {/* ---- sweeps ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Hold closures, by the writer each one declares
          </h3>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            <code>hold_closure.source</code> is the same partition{" "}
            <code>dbcheck</code>&rsquo;s GUARD REACH block prints for{" "}
            <code>v_hold_closure_not_terminal</code>. Two of these writers are sweeps —{" "}
            <code>expiry_sweep</code> and <code>availability_sweep</code> — and the rest
            are the posting path, a repair, a dispute or a test fixture. That distinction
            is what lets a count of closures be read as machine activity rather than as
            an unexplained pile of releases.
          </p>
          <TableScroll>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-y border-border">
                  <th className={TH_CLASS}>declared writer</th>
                  <th className={TH_CLASS}>closures</th>
                  <th className={TH_CLASS}>oldest</th>
                  <th className={TH_CLASS}>newest</th>
                </tr>
              </thead>
              <tbody>
                {machine.sweeps.map((s) => (
                  <tr key={s.source ?? "undeclared"} className="border-b border-border">
                    <td className={TD_CLASS}>
                      <code className="text-xs">{s.source ?? "(undeclared)"}</code>
                    </td>
                    <td className={`${TD_CLASS} money`}>{s.count}</td>
                    <td className={`${TD_CLASS} money text-xs`}>{s.oldestAt ?? "—"}</td>
                    <td className={`${TD_CLASS} money text-xs`}>{s.newestAt ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </section>

        {/* ---- outbound ---- */}
        {machine.outbound.length === 0 ? null : (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
              Outbound deliveries
            </h3>
            <div className="flex flex-wrap gap-2">
              {machine.outbound.map((o) => (
                <Badge key={o.state} tone={o.state === "dead" ? "negative" : "quiet"}>
                  {o.state}: {o.count}
                  {o.lastStatus === null ? "" : ` · last HTTP ${o.lastStatus}`}
                </Badge>
              ))}
            </div>
            <p className="max-w-prose text-xs leading-relaxed text-muted">
              This is the one place a status code IS recorded, because the outbound
              deliverer is the client and writes what it got back. Nothing records the
              status codes of the inbound cron ticks, which is the asymmetry the note at
              the top of this section is about.{" "}
              <Link
                href={"/events" as Route}
                className={`underline underline-offset-4 ${FOCUS_RING}`}
              >
                Outbound events
              </Link>
            </p>
          </section>
        )}

        {/* ---- machine actions from the audit trail ---- */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
            Non-human actions, from the audit trail
          </h3>
          <p className="max-w-prose text-xs leading-relaxed text-muted">
            <code>v_actor_action</code> is one projection over every action store the
            trail covers, and it classifies the actor. This is that projection filtered to
            everything that is not a person, ordered by <code>recorded_at</code> — when
            this book <em>learned</em> — and not by <code>occurred_at</code>, which for a
            ledger entry is its value date and can be in the future. Two clocks; this
            section is about the second one.
          </p>
          <TableScroll>
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-y border-border">
                  <th className={TH_CLASS}>store</th>
                  <th className={TH_CLASS}>surface</th>
                  <th className={TH_CLASS}>actor</th>
                  <th className={TH_CLASS}>actions</th>
                  <th className={TH_CLASS}>newest recorded</th>
                </tr>
              </thead>
              <tbody>
                {machine.actions.map((a) => (
                  <tr key={`${a.source}:${a.actorKind}`} className="border-b border-border">
                    <td className={TD_CLASS}>
                      <code className="text-xs">{a.source}</code>
                    </td>
                    <td className={`${TD_CLASS} text-xs`}>{a.surface}</td>
                    <td className={TD_CLASS}>
                      <Badge tone={a.actorKind === "agent" ? "neutral" : "quiet"}>
                        {a.actorKind}
                      </Badge>
                    </td>
                    <td className={`${TD_CLASS} money`}>{a.count}</td>
                    <td className={`${TD_CLASS} money text-xs`}>{a.newestAt ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </section>

        {/* ---- completeness: what the trail itself cannot see ---- */}
        <Note
          emphasis={
            machine.completeness.unclaimed.length > 0 || machine.completeness.mutable.length > 0
          }
          title="What the audit trail above does NOT cover"
        >
          <p>
            The trail reconciles itself against its own stores —{" "}
            <code>loadCompleteness()</code>, the same read <code>/audit</code> renders —
            and this is what it says about its own gaps.{" "}
            <span className="money">{machine.completeness.sources.length}</span> sources
            projected, <span className="money">{awaiting.length}</span> awaiting wiring,{" "}
            <span className="money">{machine.completeness.exclusions.length}</span>{" "}
            deliberately excluded, of which{" "}
            <span className="money">{holes.length}</span>{" "}
            {holes.length === 1 ? "is a HOLE" : "are HOLES"} — a place an action is taken
            and recorded nowhere, as opposed to one folded into another source.
          </p>
          {machine.completeness.unclaimed.length > 0 ? (
            <p className="mt-2 money-negative">
              {machine.completeness.unclaimed.length} base table(s) are unclassified:{" "}
              <code>{machine.completeness.unclaimed.join(", ")}</code>. A trail that reads
              complete and is not is worse than no trail.
            </p>
          ) : null}
          {machine.completeness.mutable.length > 0 ? (
            <p className="mt-2 money-negative">
              {machine.completeness.mutable.length} projected source(s) can be UPDATEd or
              DELETEd by the application role. This must be empty.
            </p>
          ) : null}
          {machine.completeness.weak.length > 0 ? (
            <p className="mt-2">
              {machine.completeness.weak.length} source(s) are defended by privileges
              alone, with no BEFORE UPDATE OR DELETE trigger — so the OWNER could still
              rewrite them. Not an invariant; a statement about the strength of the
              evidence.
            </p>
          ) : null}
          {holes.length === 0 ? null : (
            <ul className="mt-2 space-y-1">
              {holes.map((h) => (
                <li key={h.source}>
                  <code>{h.source}</code> — {h.reason}
                </li>
              ))}
            </ul>
          )}
        </Note>
      </div>
    </Panel>
  );
}
