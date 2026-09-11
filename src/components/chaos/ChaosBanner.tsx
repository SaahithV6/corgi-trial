/**
 * The banner. This is the most important component in the feature.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE RULE IT EXISTS FOR
 *
 * "A simulated integration presented as live is the fastest way to fail the
 * entire trial." A chaos control that fakes a provider outage is one
 * screenshot away from being exactly that — a picture of a banking console
 * saying a card issuer is down, taken from a system where the card issuer was
 * never down.
 *
 * So every word here is chosen against one test: COULD A SCREENSHOT OF THIS
 * BE MISTAKEN FOR EVIDENCE OF A REAL PROVIDER OUTAGE? The answer has to be no
 * even when the screenshot is cropped, even with no caption, and even to a
 * reader who has never seen this system.
 *
 * Three rules follow, and they are why the copy is written the way it is:
 *
 *   1. EVERY SENTENCE HAS US AS ITS SUBJECT. "Corgi is withholding", "we are
 *      sending", "we are releasing". Never "the provider is", never "Lithic
 *      is", never an adjective like "degraded" or "down" that describes THEM.
 *      The grammar carries the claim, so cropping cannot remove it.
 *
 *   2. THE PROVIDER IS EXPLICITLY EXONERATED, in the banner body, not in a
 *      footnote. "Lithic's sandbox is untouched" is a sentence that has to be
 *      deleted to make this screenshot mean the opposite, and deleting it is
 *      forgery rather than cropping.
 *
 *   3. `/api/health` IS NAMED AS AUTHORITATIVE. This screen is a test harness
 *      and says so. If any word here ever disagrees with that endpoint, the
 *      endpoint is right and this screen is wrong — which is the same rule
 *      `scripts/audit-claims.mjs` enforces across every document in the repo.
 *
 * WHAT THIS BANNER DELIBERATELY DOES NOT DO. It does not render a provider
 * status, a health verdict, or a red "OUTAGE" chip. The site-wide
 * `ProviderHealthBanner` in `src/components/system/` is the only thing allowed
 * to make a statement about a provider's health, it derives that from
 * `/api/health`, and chaos does not touch it, feed it, or imitate it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { formatCountdown, formatTimestamp } from '@/lib/format/datetime';

import type { ChaosStateView } from './data-contract';

/**
 * What each control does, phrased with US as the actor.
 *
 * These strings are the load-bearing copy of the whole feature. Note what is
 * absent from every one of them: the provider is never the subject of a verb,
 * and no sentence describes a state the provider is in.
 */
const EFFECT_WE_DID: Record<string, string> = {
  webhooks_off:
    'We are withholding card webhook deliveries that we originated ourselves. They are signed, durable and waiting in our own outbox.',
  settlement_delay: 'We are holding our own clearing delivery back before releasing it.',
  duplicate_delivery: 'We are sending each of our own deliveries more than once, byte for byte.',
  reorder_window:
    'We are releasing our own deliveries backwards, so the settlement arrives before the authorisation it belongs to.',
};

export function ChaosBanner({
  chaos,
  asOf,
}: {
  readonly chaos: ChaosStateView;
  readonly asOf: string;
}) {
  if (!chaos.on) {
    return (
      <aside
        role="status"
        aria-live="polite"
        data-chaos="off"
        className="rounded-lg border border-border bg-surface px-5 py-4"
      >
        <p className="text-sm font-semibold tracking-tight">Chaos mode is off.</p>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          No control is armed. Card webhook delivery is behaving normally, and this screen is
          showing the live webhook inbox and the live invariant views with nothing perturbing them.
        </p>
      </aside>
    );
  }

  return (
    <aside
      role="status"
      aria-live="polite"
      // Machine-readable, for a scraper or a screenshot tool, and deliberately
      // spelled to say whose doing it is.
      data-chaos="on"
      data-chaos-origin="corgi-chaos-mode"
      className="rounded-lg border border-negative/40 bg-negative/10 px-5 py-4"
    >
      <p className="text-sm font-semibold tracking-tight text-negative">
        CHAOS MODE IS ON — WE ARE DOING THIS, NOT THE PROVIDER.
      </p>

      <p className="mt-2 max-w-prose text-xs leading-relaxed text-negative">
        Corgi is deliberately perturbing the delivery of card webhooks that{' '}
        <strong>Corgi itself originated</strong> — their timing, their order, how many times they
        arrive, and whether they arrive at all.{' '}
        <strong>Lithic&rsquo;s sandbox is untouched.</strong> Its live event subscription has not
        been disabled, no provider has reported a problem, and{' '}
        <strong>nothing on this screen is evidence of a provider outage.</strong>
      </p>

      <p className="mt-2 max-w-prose text-xs leading-relaxed text-negative">
        This screen is a test harness. <code className="font-mono">/api/health</code> is the
        authoritative statement of which integrations are live; chaos mode does not write to it,
        read into it, or override it.
      </p>

      <ul className="mt-3 space-y-1.5">
        {chaos.controls
          .filter((c) => c.armed)
          .map((c) => (
            <li key={c.control} className="text-xs leading-relaxed text-negative">
              <span className="font-mono">{c.control}</span>{' '}
              <span className="text-muted">({c.setting})</span> —{' '}
              {EFFECT_WE_DID[c.control] ?? c.effect}
            </li>
          ))}
      </ul>

      <p className="mt-3 max-w-prose text-xs leading-relaxed text-negative">
        {chaos.allClearAt === null ? (
          'All chaos ends automatically.'
        ) : (
          <>
            <strong>
              All chaos ends automatically at {formatTimestamp(chaos.allClearAt)} (
              {formatCountdown(chaos.allClearAt, asOf)}).
            </strong>{' '}
            The ten-minute ceiling is a <code className="font-mono">CHECK</code> constraint in
            migration 0029, not a policy: the database refuses to store a longer arming, so a
            forgotten switch cannot outlive the demo.
          </>
        )}
      </p>
    </aside>
  );
}
