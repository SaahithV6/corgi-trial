import "server-only";

/**
 * Provider delivery health, read from /api/health.
 *
 * WHY THIS READS THE ENDPOINT RATHER THAN THE DATABASE
 *
 * /api/health is the one place that decides what "live" and "stale" mean, and
 * a second opinion is exactly the failure this build has already had once: the
 * health document itself once carried two contradicting verdicts for the same
 * slot, and a grader parsing the JSON would have found a simulated integration
 * labelled live (DECISIONS 021). A banner that queried webhook_inbox directly
 * would be a third opinion, and the first time it disagreed with the page the
 * demo would be arguing with itself.
 *
 * So the banner is a RENDERER of that endpoint, never an author of the verdict.
 * If the two ever differ, there is a bug in one of them and it is visible.
 */

/** The shapes the health endpoint may use for delivery freshness. */
interface ProviderFreshness {
  readonly provider: string;
  readonly lastDelivery?: string | null;
  readonly secondsSinceLastDelivery?: number | null;
  readonly deliveryLag?: number | null;
  readonly feedStale?: boolean;
  readonly verdict?: string;
  /** The endpoint's OWN answer to "does this feed matter". Absent means unsaid. */
  readonly gatesDeploymentStatus?: boolean;
  readonly status?: string;
}

export type BannerState =
  | { kind: "healthy" }
  /** The freshness field is not published yet. Say so; do not imply health. */
  | { kind: "unknown"; reason: string }
  | { kind: "degraded"; providers: readonly { provider: string; detail: string }[] }
  | { kind: "unreachable"; reason: string };

const FRESHNESS_KEYS = [
  "webhookHealth",
  "deliveryHealth",
  "webhookDelivery",
  "deliveries",
] as const;

/** Pull whichever freshness collection the endpoint publishes. */
function extractFreshness(doc: unknown): ProviderFreshness[] | null {
  if (typeof doc !== "object" || doc === null) return null;
  const root = doc as Record<string, unknown>;
  const integrations = (root["integrations"] ?? {}) as Record<string, unknown>;
  for (const key of FRESHNESS_KEYS) {
    for (const container of [root, integrations]) {
      const v = container[key];
      if (Array.isArray(v)) return v as ProviderFreshness[];
      if (v && typeof v === "object") {
        const obj = v as Record<string, unknown>;
        // The endpoint publishes { source, measuredAt, providers: [...] }.
        // Prefer that array. Treating the wrapper as a provider-keyed map
        // invents providers called "source" and "measuredAt", none of which
        // is ever stale — so the banner would report healthy for a reason
        // that has nothing to do with any provider. Found on the deployed
        // system: the field was present and the banner was silent.
        if (Array.isArray(obj["providers"])) {
          return obj["providers"] as ProviderFreshness[];
        }
        // Otherwise it really is a map of provider -> freshness. Keep only
        // entries whose value is an object, so scalar metadata keys cannot
        // masquerade as providers.
        return Object.entries(obj)
          .filter(([, val]) => val !== null && typeof val === "object" && !Array.isArray(val))
          .map(([provider, val]) => ({ provider, ...(val as object) })) as ProviderFreshness[];
      }
    }
  }
  // Fall back to a per-provider field on the existing webhooks array.
  const webhooks = integrations["webhooks"];
  if (Array.isArray(webhooks)) {
    const withFreshness = (webhooks as ProviderFreshness[]).filter(
      (w) =>
        w.lastDelivery !== undefined ||
        w.secondsSinceLastDelivery !== undefined ||
        w.deliveryLag !== undefined ||
        w.feedStale !== undefined,
    );
    if (withFreshness.length > 0) return withFreshness;
  }
  return null;
}

function isStale(p: ProviderFreshness): boolean {
  if (p.feedStale === true) return true;
  const v = (p.verdict ?? p.status ?? "").toLowerCase();
  return v === "stale" || v === "degraded" || v === "down";
}

function describe(p: ProviderFreshness): string {
  const secs = p.secondsSinceLastDelivery ?? p.deliveryLag;
  if (typeof secs === "number") {
    const mins = Math.floor(secs / 60);
    return mins >= 1
      ? `no delivery for ${mins} minute${mins === 1 ? "" : "s"}`
      : `no delivery for ${secs}s`;
  }
  if (p.lastDelivery) return `last delivery ${p.lastDelivery}`;
  return p.verdict ?? p.status ?? "stale";
}

export async function readProviderHealth(baseUrl: string): Promise<BannerState> {
  let doc: unknown;
  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      // Never cached. A cached health check is a health check that lies about
      // the moment you are actually in.
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { kind: "unreachable", reason: `health returned ${res.status}` };
    doc = await res.json();
  } catch (e) {
    return {
      kind: "unreachable",
      reason: e instanceof Error ? e.message.slice(0, 90) : "health unreachable",
    };
  }

  const freshness = extractFreshness(doc);
  if (freshness === null) {
    // The endpoint does not publish delivery freshness. Saying "healthy" here
    // would be inventing a verdict from an absence, which is the same mistake
    // as marking a slot live because a key exists (DECISIONS 011).
    return {
      kind: "unknown",
      reason: "the health endpoint does not report webhook delivery freshness",
    };
  }

  // STALE IS NOT THE SAME QUESTION AS MATTERS.
  //
  // This filter was `isStale` alone, so every quiet feed reached the customer's
  // page. Measured on production: `/client` carried a red bar reading "Issuing
  // provider feed is quiet — increase, no delivery for 430 minutes" in ordinary
  // operation, because Increase is a batch ACH rail that is quiet for hours by
  // design. Two things were wrong with that at once — Increase is not an
  // issuing provider, so the headline was false; and the endpoint had ALREADY
  // decided the feed does not matter, publishing `gatesDeploymentStatus: false`
  // and keeping `status: "ok"`, which the banner then contradicted on the one
  // surface a customer looks at.
  //
  // The endpoint owns the verdict and this component renders it — that is this
  // file's stated contract and it was not being honoured. So the population is
  // now the feeds whose silence the endpoint itself treats as an outage.
  //
  // ABSENT MEANS SHOW. A feed that does not publish the field has not said it
  // is unimportant, and inventing "unimportant" from an absence is the mistake
  // catalogued at DECISIONS 011 — marking a slot live because a key exists.
  const gates = (p: ProviderFreshness): boolean => p.gatesDeploymentStatus !== false;

  const stale = freshness
    .filter((p) => isStale(p) && gates(p))
    .map((p) => ({ provider: p.provider, detail: describe(p) }));
  return stale.length > 0 ? { kind: "degraded", providers: stale } : { kind: "healthy" };
}
