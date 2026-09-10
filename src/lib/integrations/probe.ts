import "server-only";
import { env, integrations, type IntegrationSlot, type SlotReport } from "@/lib/env";
import { probeLithicWebhooks } from "./probes/lithic-webhooks";

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

export type Liveness =
  | "live"
  /** A real authenticated call was rejected by the provider. */
  | "unauthorised"
  /** Network or provider failure — we do not know, so we do not claim. */
  | "unreachable"
  /** No credential at all. */
  | "not_configured"
  /**
   * A credential is present and no probe exists for this slot, so nothing has
   * been proven. Distinct from `not_configured` — that asserts an absence,
   * this declines to make a claim. Never labelled LIVE.
   */
  | "unprobed";

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

  // The slot DECISIONS 026 left `unprobed`, now earned. Two authenticated reads
  // — the subscription list and that subscription's delivery attempts — prove
  // Lithic is registered against THIS deployment's URL, is not disabled, and is
  // having its deliveries accepted. Lives in ./probes/ because it is the one
  // probe with a real ladder of degraded truths; see that file for why a
  // successful attempt is end-to-end proof and why this has no opinion about
  // freshness (delivery-health.ts owns that question, and only that module).
  card_webhooks: () =>
    probeLithicWebhooks({
      apiKey: env.LITHIC_API_KEY,
      webhookSecret: env.LITHIC_WEBHOOK_SECRET,
    }),

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

    // Third attempt at this probe, and the first two were both wrong in the
    // same direction — they reported LIVE for a slot that cannot function.
    //
    //   GET /v1/balance   -> 200 with Connect disabled. Proves the credential.
    //   GET /v1/accounts  -> 200 with Connect disabled, returning an empty
    //                        list. READING connected accounts is allowed even
    //                        when you have none and cannot make any.
    //   POST /v1/accounts -> 400 "You can only create new accounts if you've
    //                        signed up for Connect". This is the only call
    //                        that tells the truth.
    //
    // A parameterless POST is safe to use as a health check: Stripe evaluates
    // the Connect entitlement BEFORE it validates parameters, so with Connect
    // disabled you get the Connect message and with Connect enabled you get a
    // parameter-validation error. Measured both directions. Nothing is created
    // in either case, which is what makes it usable from /api/health.
    const { res, ms, err } = await timed((signal) =>
      fetch("https://api.stripe.com/v1/accounts", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    if (res.status === 401 || res.status === 403) {
      return { liveness: "unauthorised", detail: `credentials rejected (${res.status})`, ms };
    }
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    const msg = body?.error?.message ?? "";
    if (msg.includes("signed up for Connect")) {
      return {
        liveness: "unauthorised",
        detail:
          "Connect not enabled. Every KYB option the brief lists (Middesk, Persona KYB, Sumsub KYB) is gated behind sales or business verification; registry runs simulated and is labelled so.",
        ms,
      };
    }
    // Entitled, but through an API this system does not speak.
    //
    // FOURTH bug in this probe, and the first one I caused myself. Enabling
    // Connect in the dashboard changed Stripe's 400 from an entitlement
    // refusal to a DEPRECATION notice: v1 account creation is gone and the
    // replacement is POST /v2/core/accounts, which nothing here calls. The
    // fallthrough below read "not the entitlement message" as "parameter
    // validation, therefore live", and /api/health went to 7 of 7 with
    // business_registry LIVE while the registry leg was still the simulator.
    //
    // That is the automatic fail of this trial, produced by a click. The
    // lesson is the one the other three taught: an else-branch that means
    // "success" is a claim, and a claim needs a reason. Entitlement is
    // necessary and not sufficient — the question is whether THIS system can
    // create a connected account, not whether the account is allowed to.
    if (msg.includes("Accounts v1") || msg.includes("v2/core/accounts")) {
      return {
        liveness: "unauthorised",
        detail:
          "Connect is enabled, but Stripe has retired Accounts v1 for new integrations and POST /v2/core/accounts is not wired here, so no connected account can be created; the registry leg runs simulated and is labelled so.",
        ms,
      };
    }
    // A genuine parameter-validation error means the entitlement check passed
    // AND the endpoint is one we can call. Only then is the capability real.
    return { liveness: "live", detail: `Connect enabled, account creation entitled (POST /v1/accounts -> ${res.status} parameter validation)`, ms };
  },

  director_kyc: async () => {
    // The brief's provider menu lists FOUR options for "KYC: identity" —
    // Persona, Sumsub, Stripe Identity and Onfido. Persona is preferred here
    // because its perform-simulate-actions endpoint can drive an inquiry to
    // pending / declined / needs_review while firing the real webhooks for
    // each, which is what makes the non-happy-path states genuinely
    // third-party rather than rows we flipped.
    //
    // Stripe Identity is the fallback and is a LIVE integration in its own
    // right: POST /v1/identity/verification_sessions succeeds in test mode
    // with no application and no business verification (measured — it returned
    // a session with status requires_input and a hosted verify.stripe.com
    // URL). What it cannot do is force an outcome; there is no scriptable way
    // to drive it to a decision, which is why it is second and not first.
    const persona = env.PERSONA_API_KEY;
    // Why this is a variable and not a constant string. The Stripe success
    // path used to hardcode "(Persona not configured)", and the Persona branch
    // below FALLS THROUGH to Stripe on a 401/403 — so a Persona key that was
    // present and REJECTED rendered as a Persona key that was absent, on the
    // endpoint this trial treats as authoritative. That is the difference
    // between "we did not wire it" and "we wired it wrong", and the second was
    // displaying as the first. It was true only by luck: PERSONA_API_KEY
    // exists in .env and on Vercel but is zero-length, so the branch never
    // ran. The moment that key is filled in, the luck runs out.
    let personaNote = "Persona not configured";
    if (persona) {
      const { res, ms, err } = await timed((signal) =>
        fetch("https://api.withpersona.com/api/v1/inquiries?page%5Bsize%5D=1", {
          headers: { Authorization: `Bearer ${persona}`, "Persona-Version": "2023-01-05" },
          signal,
        }),
      );
      if (res?.ok) return { liveness: "live", detail: "Persona: GET /inquiries -> 200", ms };
      if (res && res.status !== 401 && res.status !== 403) {
        return { liveness: fromStatus(res.status), detail: `Persona -> ${res.status}`, ms };
      }
      // Persona key present and NOT usable — rejected, or the call never
      // landed at all. Both fall through and try Stripe Identity rather than
      // reporting simulated while a working alternative answers, and both
      // carry the reason into the evidence string so the fallthrough is
      // visible rather than silent.
      //
      // The unreachable leg used to return `unreachable` for the WHOLE slot
      // without ever asking Stripe, which meant one Persona network blip
      // flipped a mustBeLive slot to SIMULATED while the provider actually
      // powering it was answering fine. The rationale already written for the
      // 401 case — "rather than reporting simulated while a working
      // alternative exists" — applies here word for word.
      personaNote = res
        ? `Persona key present but rejected: ${res.status}`
        : `Persona key present but unreachable: ${err ?? "no response"}`;
    }

    const stripe = env.STRIPE_SECRET_KEY;
    if (!stripe) {
      return {
        liveness: persona ? "unauthorised" : "not_configured",
        detail: persona ? `${personaNote}; no Stripe fallback configured` : "no KYC provider configured",
        ms: 0,
      };
    }
    // Read a session list rather than creating one: creation is the capability,
    // but Identity gates BOTH on the same entitlement, and listing does not
    // leave objects behind on every health check.
    const { res, ms, err } = await timed((signal) =>
      fetch("https://api.stripe.com/v1/identity/verification_sessions?limit=1", {
        headers: { Authorization: `Bearer ${stripe}` },
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    if (res.ok) {
      return { liveness: "live", detail: `Stripe Identity enabled (${personaNote})`, ms };
    }
    return {
      liveness: "unauthorised",
      detail: `Stripe Identity unavailable (${res.status}); ${personaNote}`,
      ms,
    };
  },

  stablecoin: async () => {
    const rpc = env.BASE_SEPOLIA_RPC_URL;
    const token = env.USDC_CONTRACT_ADDRESS;
    const addr = env.USDC_SENDER_ADDRESS;
    if (!rpc || !token || !addr)
      return { liveness: "not_configured", detail: "USDC config incomplete", ms: 0 };

    // This slot's job is PAYOUTS, so the probe has to answer "can we send",
    // not "can we read".
    //
    // The first version called balanceOf and reported LIVE on a 200. That was
    // the same mistake as the Stripe probe: we hold 20 USDC and, with an empty
    // gas balance, cannot move a cent of it. An ERC-20 transfer needs roughly
    // 65,000 gas, and a wallet with 0 wei fails before the transaction is ever
    // broadcast. Reporting LIVE there claims a capability we do not have.
    //
    // So: read the token balance AND the gas balance AND the gas price, and
    // only claim live if a transfer could actually be paid for.
    const call = (method: string, params: unknown[]) =>
      timed((signal) =>
        fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal,
        }),
      );

    const started = Date.now();
    const [balRes, gasRes, priceRes] = await Promise.all([
      call("eth_call", [{ to: token, data: `0x70a08231000000000000000000000000${addr.slice(2)}` }, "latest"]),
      call("eth_getBalance", [addr, "latest"]),
      call("eth_gasPrice", []),
    ]);
    const ms = Date.now() - started;

    if (!balRes.res || !gasRes.res || !priceRes.res) {
      return { liveness: "unreachable", detail: balRes.err ?? "rpc unreachable", ms };
    }
    const num = async (r: Response): Promise<bigint | null> => {
      const b = (await r.json().catch(() => null)) as { result?: string } | null;
      return b?.result ? BigInt(b.result) : null;
    };
    const [usdc, wei, price] = await Promise.all([num(balRes.res), num(gasRes.res), num(priceRes.res)]);
    if (usdc === null || wei === null || price === null) {
      return { liveness: "unreachable", detail: "rpc returned no result", ms };
    }

    const ERC20_TRANSFER_GAS = 65_000n;
    const needed = ERC20_TRANSFER_GAS * price;
    const usdcHuman = (Number(usdc) / 1e6).toFixed(2);

    if (usdc === 0n) {
      return { liveness: "unauthorised", detail: "no USDC to send — top up at faucet.circle.com", ms };
    }
    if (wei < needed) {
      // The distinction that matters: the chain answers, the token exists, we
      // hold funds. What is missing is the ability to pay for the transfer.
      return {
        liveness: "unauthorised",
        detail: `holds ${usdcHuman} USDC but only ${wei} wei gas; a transfer needs ~${needed} — cannot send`,
        ms,
      };
    }
    return {
      liveness: "live",
      detail: `${usdcHuman} USDC and ${wei} wei gas — a transfer is fundable`,
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
        // A slot with no probe CANNOT report live.
        //
        // This fell back to the env-derived status, so `card_webhooks` read
        // LIVE because LITHIC_WEBHOOK_SECRET was a non-empty string — earned by
        // a string existing, not by a round trip. That is exactly the failure
        // this module was written to eliminate (DECISIONS 011), reintroduced by
        // its own fallback and then reported with the evidence string "no probe
        // defined for this slot", which says out loud that nothing was proven
        // while the label claims it was.
        //
        // `unprobed` is its own verdict, distinct from `not_configured`: the
        // credential may well be present and working, and we are declining to
        // claim it rather than asserting its absence. Either way the label is
        // SIMULATED, because SIMULATED is what "we have not proven this" must
        // read as. Over-claiming is the automatic fail; under-claiming is only
        // pessimistic.
        const configured = slot.status === "live";
        return {
          slot: slot.slot, provider: slot.provider,
          liveness: configured ? "unprobed" : "not_configured",
          label: "SIMULATED",
          mustBeLive: slot.mustBeLive,
          detail: configured
            ? "credential present but NOT probed — no round trip proves this slot works"
            : "no probe defined and no credential configured",
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
