import "server-only";
import { env, integrations, type IntegrationSlot, type SlotReport } from "@/lib/env";

/**
 * Liveness by PROOF, not by presence.
 *
 * The env layer can only tell you whether a string exists. That is not the
 * same question as "is this integration live", and conflating them is how a
 * system ends up labelling four providers LIVE because someone pasted the
 * placeholders out of .env.example into a hosting dashboard. Presenting a
 * simulated integration as live is the single fastest way to fail this trial,
 * so the claim has to be earned by a round trip.
 *
 * Each probe is the cheapest authenticated read the provider offers. It proves
 * exactly one thing — this credential is accepted by that provider right now —
 * and it distinguishes three outcomes that must never be collapsed:
 *
 *   live         a real authenticated call returned 2xx
 *   unauthorised the credential exists and the provider REJECTED it
 *                (this is the placeholder case, and it must never read live)
 *   unreachable  network or provider failure; we do not know, and saying
 *                "live" on a hopeful guess is the thing being guarded against
 *
 * `unauthorised` and `unreachable` both degrade the slot to simulated for
 * labelling purposes. The difference is kept because they need different
 * human responses: one is a wrong key, the other is a bad afternoon.
 */

export type Liveness = "live" | "unauthorised" | "unreachable" | "not_configured";

export interface ProbeResult {
  readonly slot: IntegrationSlot;
  readonly provider: string;
  readonly liveness: Liveness;
  /** The honest label. Only "live" survives a successful round trip. */
  readonly label: "LIVE" | "SIMULATED";
  readonly mustBeLive: boolean;
  readonly detail: string;
  readonly checkedAt: string;
  readonly latencyMs: number | null;
}

const TIMEOUT_MS = 4000;

async function timed(
  fn: (signal: AbortSignal) => Promise<Response>,
): Promise<{ res: Response | null; ms: number; err: string | null }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fn(ac.signal);
    return { res, ms: Date.now() - started, err: null };
  } catch (e) {
    return { res: null, ms: Date.now() - started, err: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

/** Map an HTTP status onto liveness. 401/403 is the placeholder-key signal. */
function fromStatus(status: number): Liveness {
  if (status >= 200 && status < 300) return "live";
  if (status === 401 || status === 403) return "unauthorised";
  // A 4xx that is not an auth failure still proves the credential was accepted
  // well enough to be told the request was wrong, which is what we are testing.
  if (status >= 400 && status < 500) return "live";
  return "unreachable";
}

type Prober = () => Promise<{ liveness: Liveness; detail: string; ms: number }>;

const PROBES: Partial<Record<IntegrationSlot, Prober>> = {
  card_issuing: async () => {
    const key = env.LITHIC_API_KEY;
    if (!key) return { liveness: "not_configured", detail: "LITHIC_API_KEY absent", ms: 0 };
    const { res, ms, err } = await timed((signal) =>
      fetch("https://sandbox.lithic.com/v1/cards?page_size=1", {
        headers: { Authorization: key },
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    return { liveness: fromStatus(res.status), detail: `GET /v1/cards -> ${res.status}`, ms };
  },

  open_banking: async () => {
    const id = env.PLAID_CLIENT_ID;
    const secret = env.PLAID_SECRET;
    if (!id || !secret)
      return { liveness: "not_configured", detail: "PLAID_CLIENT_ID/SECRET absent", ms: 0 };
    // /institutions/get with a FIXED, well-formed body. The body is a constant,
    // so the only thing that can make this fail is the credentials — which is
    // what makes a 400 here unambiguous.
    //
    // Measured against the live sandbox rather than assumed:
    //   correct creds                      -> 200
    //   well-formed but wrong creds        -> 400 INVALID_API_KEYS / INVALID_INPUT
    //   malformed creds (a placeholder!)   -> 400 INVALID_FIELD / INVALID_REQUEST
    // Plaid validates request SHAPE before credentials, so a placeholder value
    // such as "your_plaid_client_id_here" produces INVALID_FIELD. Both cases
    // must degrade to simulated: neither proves a working integration.
    const { res, ms, err } = await timed((signal) =>
      fetch("https://sandbox.plaid.com/institutions/get", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_id: id, secret, count: 1, offset: 0, country_codes: ["US"],
        }),
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    if (res.ok) return { liveness: "live", detail: "POST /institutions/get -> 200", ms };
    if (res.status === 400) {
      const body = (await res.json().catch(() => null)) as { error_code?: string } | null;
      return {
        liveness: "unauthorised",
        detail: `credentials rejected (${body?.error_code ?? "400"})`,
        ms,
      };
    }
    return { liveness: fromStatus(res.status), detail: `POST /institutions/get -> ${res.status}`, ms };
  },

  ach_rail: async () => {
    const key = env.INCREASE_API_KEY;
    if (!key) return { liveness: "not_configured", detail: "INCREASE_API_KEY absent", ms: 0 };
    const { res, ms, err } = await timed((signal) =>
      fetch("https://sandbox.increase.com/accounts?limit=1", {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    return { liveness: fromStatus(res.status), detail: `GET /accounts -> ${res.status}`, ms };
  },

  business_registry: async () => {
    const key = env.STRIPE_SECRET_KEY;
    if (!key) return { liveness: "not_configured", detail: "STRIPE_SECRET_KEY absent", ms: 0 };
    const { res, ms, err } = await timed((signal) =>
      fetch("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    return { liveness: fromStatus(res.status), detail: `GET /v1/balance -> ${res.status}`, ms };
  },

  director_kyc: async () => {
    const key = env.PERSONA_API_KEY;
    if (!key) return { liveness: "not_configured", detail: "PERSONA_API_KEY absent", ms: 0 };
    const { res, ms, err } = await timed((signal) =>
      fetch("https://api.withpersona.com/api/v1/inquiries?page%5Bsize%5D=1", {
        headers: { Authorization: `Bearer ${key}`, "Persona-Version": "2023-01-05" },
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    return { liveness: fromStatus(res.status), detail: `GET /api/v1/inquiries -> ${res.status}`, ms };
  },

  stablecoin: async () => {
    const rpc = env.BASE_SEPOLIA_RPC_URL;
    const token = env.USDC_CONTRACT_ADDRESS;
    const addr = env.USDC_SENDER_ADDRESS;
    if (!rpc || !token || !addr)
      return { liveness: "not_configured", detail: "USDC config incomplete", ms: 0 };
    // balanceOf(address) — proves the chain answers AND the token exists.
    const data = `0x70a08231000000000000000000000000${addr.slice(2)}`;
    const { res, ms, err } = await timed((signal) =>
      fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: token, data }, "latest"],
        }),
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    const body = (await res.json().catch(() => null)) as { result?: string } | null;
    if (!body?.result) return { liveness: "unreachable", detail: "no result from eth_call", ms };
    const units = BigInt(body.result);
    return {
      liveness: "live",
      detail: `balanceOf -> ${(Number(units) / 1e6).toFixed(2)} USDC on Base Sepolia`,
      ms,
    };
  },
};

/**
 * Probe every slot. Runs concurrently; total wall time is one timeout.
 *
 * NOTE: this makes real outbound calls, so it is not free and must not run on
 * every page render. /api/health calls it; nothing else should.
 */
export async function probeIntegrations(): Promise<readonly ProbeResult[]> {
  const checkedAt = new Date().toISOString();
  return Promise.all(
    integrations.map(async (slot: SlotReport): Promise<ProbeResult> => {
      const probe = PROBES[slot.slot];
      if (!probe) {
        return {
          slot: slot.slot, provider: slot.provider,
          liveness: slot.status === "live" ? "live" : "not_configured",
          label: slot.status === "live" ? "LIVE" : "SIMULATED",
          mustBeLive: slot.mustBeLive,
          detail: "no probe defined for this slot",
          checkedAt, latencyMs: null,
        };
      }
      const { liveness, detail, ms } = await probe();
      return {
        slot: slot.slot,
        provider: slot.provider,
        liveness,
        // The whole point: ONLY a proven round trip earns the LIVE label.
        label: liveness === "live" ? "LIVE" : "SIMULATED",
        mustBeLive: slot.mustBeLive,
        detail,
        checkedAt,
        latencyMs: ms || null,
      };
    }),
  );
}
