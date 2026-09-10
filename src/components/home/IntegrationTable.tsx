import {
  Badge,
  FOCUS_RING,
  Panel,
  TD_CLASS,
  TH_CLASS,
  TableScroll,
  type BadgeTone,
} from "@/components/ui/primitives";
import { formatTimestamp } from "@/lib/format/datetime";
import { isErr } from "@/lib/result";
import type { ErrorShape, Result } from "@/lib/result";
import type { HealthView, IntegrationSlotView, SlotStatus } from "@/lib/home/summary";

/**
 * The integration honesty table.
 *
 * ============================================================================
 * Presenting a simulated integration as live fails the entire trial. This
 * component is the place that would do it, so it is built to be incapable of
 * it in three separate ways.
 * ============================================================================
 *
 * 1. **It computes no verdict.** Every row is rendered from a `HealthView`,
 *    which is parsed from `/api/health` on the same origin. This component
 *    imports nothing from `@/lib/env` and runs no probe, so it has no opinion
 *    of its own that could disagree with the endpoint.
 *
 * 2. **Only the literal `live` prints LIVE.** `verdictLabel` maps everything
 *    else — including a status this build has never seen — to a label that is
 *    not a claim of liveness. Under-claiming is pessimistic; over-claiming is
 *    the automatic fail, and the asymmetry is encoded rather than assumed.
 *
 * 3. **No verdict is shown without the evidence that earned it.** The evidence
 *    string is the round trip: `GET /v1/cards -> 200`, or
 *    `holds 20.00 USDC but only 0 wei gas`. A slot whose evidence the endpoint
 *    did not send is rendered saying so, because a green tick with no proof
 *    behind it is exactly the failure mode DECISIONS 011, 015 and 016 each
 *    caught in turn.
 *
 * If health is unreachable the table is replaced by the reason. It is never
 * reconstructed from which environment variables happen to be set: key presence
 * is a different question from liveness, and answering the second with the
 * first is how four providers end up labelled LIVE because someone pasted the
 * placeholders out of `.env.example` into a hosting dashboard.
 */

/* -------------------------------------------------------------------------- */
/* Labelling                                                                  */
/* -------------------------------------------------------------------------- */

/** LIVE only for `live`. `unknown` is not a synonym for simulated — say so. */
export function verdictLabel(status: SlotStatus): string {
  switch (status) {
    case "live":
      return "LIVE";
    case "simulated":
      return "SIMULATED";
    default:
      return "UNKNOWN";
  }
}

export function verdictTone(status: SlotStatus): BadgeTone {
  switch (status) {
    case "live":
      return "positive";
    case "simulated":
      return "neutral";
    default:
      return "negative";
  }
}

/** The evidence, or an honest admission that there is none to show. */
export function describeEvidence(slot: IntegrationSlotView): string {
  if (slot.evidence !== null) return slot.evidence;
  return "no evidence reported by /api/health for this slot";
}

/**
 * The one-line summary above the table.
 *
 * Counted from the rows themselves (`liveCount` is folded in the parser, not
 * read from the endpoint's own `integrations.live`), so the sentence and the
 * table cannot say different things.
 */
export function summariseHealth(health: HealthView): string {
  const simulated = health.total - health.liveCount;
  const plural = simulated === 1 ? "is" : "are";
  return `${health.liveCount} of ${health.total} integration slots are live against a real provider sandbox; ${simulated} ${plural} simulated and labelled so.`;
}

/** Slots the brief requires to be live that are not. Surfaced, never buried. */
export function unmetRequirements(
  health: HealthView,
): readonly IntegrationSlotView[] {
  return health.slots.filter((s) => s.mustBeLive && s.status !== "live");
}

/* -------------------------------------------------------------------------- */
/* The panel                                                                  */
/* -------------------------------------------------------------------------- */

export function IntegrationTable({
  health,
}: {
  readonly health: Result<HealthView, ErrorShape>;
}) {
  if (isErr(health)) {
    return (
      <Panel
        id="integrations"
        title="Integrations — live or simulated"
        description="Read from /api/health on this origin, so this table cannot disagree with that endpoint."
      >
        <div className="px-5 py-8">
          <p className="text-sm text-negative">
            <code className="font-mono">/api/health</code> could not be read, so
            no live-or-simulated verdict can be shown.
          </p>
          <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-[8rem_1fr]">
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">Code</dt>
            <dd className="font-mono text-xs break-words">{health.error.code}</dd>
            <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">
              Message
            </dt>
            <dd className="max-w-prose text-sm break-words">{health.error.message}</dd>
          </dl>
          <p className="mt-4 max-w-prose text-xs leading-relaxed text-muted">
            The table is deliberately not reconstructed from the environment.
            Which credentials are <em>present</em> is a different question from
            which integrations are <em>live</em> — a placeholder key, a Stripe
            account without Connect and a USDC wallet with no gas all look
            configured and none of them works — so a verdict that was not earned
            by a real round trip is not shown at all.
          </p>
          <p className="mt-3 text-xs text-muted">
            <a
              href="/api/health"
              className={`underline underline-offset-4 ${FOCUS_RING}`}
            >
              Try /api/health directly
            </a>
          </p>
        </div>
      </Panel>
    );
  }

  const view = health.value;
  const unmet = unmetRequirements(view);

  return (
    <Panel
      id="integrations"
      title="Integrations — live or simulated"
      description="Read from /api/health on this origin, so this table cannot disagree with that endpoint. A verdict is earned by an authenticated round trip to the provider, never by the presence of an API key."
      actions={
        <a href="/api/health" className={`text-xs underline underline-offset-4 ${FOCUS_RING}`}>
          /api/health
        </a>
      }
    >
      <div className="border-b border-border px-5 py-3">
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          {summariseHealth(view)}
        </p>
        {unmet.length === 0 ? null : (
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-negative">
            {unmet.length === 1 ? "One slot" : `${unmet.length} slots`} the brief
            requires to be live {unmet.length === 1 ? "is" : "are"} not:{" "}
            {unmet.map((s) => s.slot).join(", ")}.
          </p>
        )}
      </div>

      <TableScroll>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Every integration slot, its provider, whether it is live or
            simulated, and the round trip that earned that verdict
          </caption>
          <thead className="border-b border-border">
            <tr>
              <th scope="col" className={TH_CLASS}>
                Slot
              </th>
              <th scope="col" className={TH_CLASS}>
                Provider
              </th>
              <th scope="col" className={TH_CLASS}>
                Verdict
              </th>
              <th scope="col" className={TH_CLASS}>
                Evidence
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {view.slots.map((slot) => (
              <tr key={slot.slot}>
                <th scope="row" className={`${TD_CLASS} text-left font-normal`}>
                  <span className="font-mono text-xs">{slot.slot}</span>
                  {slot.mustBeLive ? (
                    <span className="mt-0.5 block text-[11px] text-muted">
                      must be live for the trial
                    </span>
                  ) : null}
                </th>
                <td className={TD_CLASS}>{slot.provider}</td>
                <td className={TD_CLASS}>
                  <Badge tone={verdictTone(slot.status)}>
                    {verdictLabel(slot.status)}
                  </Badge>
                  {slot.liveness === null || slot.liveness === slot.status ? null : (
                    <span className="mt-1 block font-mono text-[11px] text-muted">
                      {slot.liveness}
                    </span>
                  )}
                </td>
                <td className={`${TD_CLASS} max-w-prose text-xs leading-relaxed text-muted`}>
                  {describeEvidence(slot)}
                  {slot.latencyMs === null ? null : (
                    <span className="mt-0.5 block">{slot.latencyMs} ms</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      <p className="border-t border-border px-5 py-3 text-xs leading-relaxed text-muted">
        Probed at{" "}
        {view.checkedAt === null
          ? "an unreported time"
          : formatTimestamp(view.checkedAt)}
        {view.commitShortSha === null ? null : ` · build ${view.commitShortSha}`}
        {view.databaseReachable === null
          ? null
          : ` · database ${view.databaseReachable ? "reachable" : "UNREACHABLE"}`}
        {view.databaseLatencyMs === null ? null : ` in ${view.databaseLatencyMs} ms`}
        {` · health reports ${view.status}`}
      </p>
    </Panel>
  );
}
