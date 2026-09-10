import { readProviderHealth, type BannerState } from "./provider-health";

/**
 * The provider-down banner.
 *
 * The published live-fire attack is: "Turn off your issuing provider's webhooks
 * for five minutes mid-demo and ask what the customer sees." The wrong answers
 * are a spinner, a stale number presented as current, and silence. The right
 * answer is that the console says the feed has gone quiet, keeps showing the
 * balances it can still prove, and invents nothing.
 *
 * That is why a stale feed does NOT blank the page or block the balances. The
 * ledger is append-only and every figure on screen is a fold over rows that are
 * already durable — those numbers stay true whether or not a provider is
 * talking to us. What a silent feed means is that there may be events we have
 * not heard about yet, and that is a different claim from "your balance is
 * wrong". The banner says the narrower, true thing.
 */

function baseUrl(): string {
  const fromVercel = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL;
  if (fromVercel) return `https://${fromVercel}`;
  return process.env.APP_BASE_URL ?? "http://localhost:3000";
}

function Bar({
  tone,
  title,
  children,
}: {
  tone: "warn" | "muted";
  title: string;
  children?: React.ReactNode;
}) {
  const cls =
    tone === "warn"
      ? "border-negative/40 bg-negative/10 text-negative"
      : "border-border bg-surface text-muted";
  return (
    <div
      role="status"
      aria-live="polite"
      data-provider-status={tone === "warn" ? "provider-down" : "unknown"}
      className={`mb-6 rounded-md border px-4 py-3 text-sm ${cls}`}
    >
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm opacity-90">{children}</div> : null}
    </div>
  );
}

export async function ProviderHealthBanner(): Promise<React.ReactElement | null> {
  let state: BannerState;
  try {
    state = await readProviderHealth(baseUrl());
  } catch {
    // The banner must never be the reason a page fails to render. A console
    // that 500s because its health widget threw is worse than one with no
    // widget.
    return null;
  }

  if (state.kind === "healthy") return null;

  if (state.kind === "degraded") {
    return (
      <Bar
        tone="warn"
        title={`Issuing provider feed is quiet — ${state.providers
          .map((p) => p.provider)
          .join(", ")}`}
      >
        <p>
          {state.providers.map((p) => `${p.provider}: ${p.detail}`).join(" · ")}.
        </p>
        <p className="mt-1">
          Balances below are still correct for every event we have received and
          stored. Authorisations that arrived during the gap will appear when the
          feed resumes; the inbox is durable and nothing is dropped.
        </p>
      </Bar>
    );
  }

  if (state.kind === "unreachable") {
    return (
      <Bar tone="warn" title="Cannot reach the health endpoint">
        <p>{state.reason}. Provider delivery status is unknown, not healthy.</p>
      </Bar>
    );
  }

  return (
    <Bar tone="muted" title="Provider delivery freshness is not reported yet">
      <p>{state.reason}. Liveness on /api/health is unaffected.</p>
    </Bar>
  );
}
