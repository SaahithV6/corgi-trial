import "server-only";
import { env, integrations, type IntegrationSlot, type SlotReport } from "@/lib/env";
import { probeLithicWebhooks } from "./probes/lithic-webhooks";
import {
  recallAttempt,
  recallVerdict,
  rememberAttempt,
  rememberVerdict,
} from "./verdict-cache";

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
  /**
   * The provider refused to evaluate the credential because we asked too
   * often. Split out of `unreachable` deliberately: "the provider had a bad
   * afternoon" and "we are polling harder than the provider permits" call for
   * opposite responses — wait, versus ask less — and collapsing them hid the
   * second inside the first for as long as this endpoint has existed. See
   * ./verdict-cache.ts for the measurement. Never labelled LIVE.
   */
  | "rate_limited"
  /** No credential at all. */
  | "not_configured"
  /**
   * A credential is present and no probe exists for this slot, so nothing has
   * been proven. Distinct from `not_configured` — that asserts an absence,
   * this declines to make a claim. Never labelled LIVE.
   */
  | "unprobed";

/**
 * The liveness vocabulary, enumerated so other modules can assert against it
 * instead of re-typing it. `delivery-health.test.ts` proves the delivery
 * verdicts are disjoint from these words, and it used to do that against a
 * hand-copied list that had already drifted — it was missing `unprobed`, so
 * the invariant it guards was being checked against a vocabulary that was no
 * longer the vocabulary.
 */
export const LIVENESS_VERDICTS: readonly Liveness[] = [
  "live",
  "unauthorised",
  "unreachable",
  "rate_limited",
  "not_configured",
  "unprobed",
];

export interface ProbeResult {
  readonly slot: IntegrationSlot;
  readonly provider: string;
  readonly liveness: Liveness;
  /** The honest label. Only "live" survives a successful round trip. */
  readonly label: "LIVE" | "SIMULATED";
  readonly mustBeLive: boolean;
  readonly detail: string;
  /** When THIS reading was taken. */
  readonly checkedAt: string;
  readonly latencyMs: number | null;
  /**
   * True when the round trip behind this verdict happened during this reading.
   * False when the verdict is quoted from the last one that was earned —
   * always with `provenAt` and `ageSeconds` beside it, so a reader is never
   * asked to take a dated fact for a present-tense one. Null where no round
   * trip is involved at all (`not_configured`, `unprobed`).
   */
  readonly fresh: boolean | null;
  /** ISO instant of the round trip that earned this verdict, when there was one. */
  readonly provenAt: string | null;
  /** Age of that round trip, in whole seconds. 0 on a fresh reading. */
  readonly ageSeconds: number | null;
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

/**
 * Map an HTTP status onto liveness.
 *
 * FIFTH BUG IN THIS FUNCTION'S FAMILY, and the widest. It used to read
 *
 *     if (status >= 400 && status < 500) return "live";
 *
 * on the reasoning that a non-auth 4xx proves the credential was accepted well
 * enough to be told the request was wrong. That is true of 400 and 422 — the
 * request reached the application and was judged on its content — and it is
 * false of everything else in the range, in ways that were live in production:
 *
 *   429  Rate limited. The credential was never evaluated. `open_banking` was
 *        reporting LIVE with the evidence string `POST /institutions/get -> 429`,
 *        which is a sentence that refutes itself.
 *   404  The path does not exist. Measured at Lithic: `/v1/not_a_real_endpoint`
 *        answers 404 WITH a valid key and 404 with NO Authorization header at
 *        all. So a typo in a URL read as a live integration.
 *   408  A timeout wearing a 4xx.
 *
 * "A simulated integration presented as live is the fastest way to fail the
 * entire trial", and a probe that infers liveness from a status the server
 * returns to strangers is how that happens by accident rather than by intent.
 *
 * So the range is now enumerated rather than bracketed. A status this function
 * has not been taught about is `unreachable` — the verdict that claims least.
 */
function fromStatus(status: number): Liveness {
  if (status >= 200 && status < 300) return "live";
  if (status === 401 || status === 403) return "unauthorised";
  // The request was authenticated, reached the application, and was rejected on
  // its CONTENT. That is the only 4xx shape that evidences a working credential.
  if (status === 400 || status === 409 || status === 422) return "live";
  // Throttling is its OWN verdict now, not a shade of unreachable.
  //
  // Narrowing 429 out of `live` was the right fix and it was not the whole
  // fix: it converted a silent wrong answer into a visible flapping one,
  // because `unreachable` says "the provider failed" when what happened is
  // "we asked eleven times in a minute and Plaid allows ten". Same label,
  // SIMULATED, for the same reason — nothing was proven — but the evidence
  // string now names the thing an operator has to change.
  if (status === 429) return "rate_limited";
  // A missing path or a timeout: the credential was never judged. Not
  // evidence of anything, in either direction.
  if (status === 404 || status === 408) return "unreachable";
  if (status >= 400 && status < 500) return "unreachable";
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
    // 429 carries Plaid's own error_code into the evidence, because
    // `INSTITUTIONS_GET_LIMIT` is the difference between "Plaid is throttling
    // this one endpoint" and "Plaid is throttling this credential", and the
    // first is a probe-design problem while the second is an account problem.
    // Measured: the bucket allows 10 calls and returns 429 on the 11th.
    if (res.status === 429) {
      const body = (await res.json().catch(() => null)) as { error_code?: string } | null;
      return {
        liveness: "rate_limited",
        detail:
          `POST /institutions/get -> 429 ${body?.error_code ?? "RATE_LIMIT_EXCEEDED"}` +
          " — Plaid rationed this reading; the credential was never evaluated",
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
    // This slot is GLEIF now, not Stripe Connect.
    //
    // It probed Connect because Connect was the plan, and it kept probing
    // Connect after the registry leg moved — which is how /api/health came to
    // report `simulated` for a leg that was answering live, the same drift as
    // reporting `live` for one that was not, pointed the other way. The probe
    // must ask the provider the APPLICATION uses.
    //
    // GLEIF needs no credential at all, which is the whole reason it is here:
    // every KYB option the brief lists (Middesk, Persona KYB, Sumsub KYB) is
    // gated behind sales or a business email, and Stripe Connect — now
    // enabled — retired Accounts v1 for new integrations. See DECISIONS 034.
    //
    // A known-good LEI is used rather than a name search: name matching on
    // GLEIF is a fuzzy token match that returns tens of thousands of loose
    // hits, so a lookup by identifier is the only call whose success means
    // what it looks like. Apple's LEI is public reference data, not ours.
    const { res, ms, err } = await timed((signal) =>
      fetch("https://api.gleif.org/api/v1/lei-records/HWUPKR0MPOU8FGXBT394", {
        headers: { accept: "application/vnd.api+json" },
        signal,
      }),
    );
    if (!res) return { liveness: "unreachable", detail: err ?? "no response", ms };
    if (!res.ok) {
      return {
        liveness: "unreachable",
        detail: `GET /v1/lei-records/HWUPKR0MPOU8FGXBT394 -> ${res.status}`,
        ms,
      };
    }
    const body = (await res.json().catch(() => null)) as
      | { data?: { attributes?: { entity?: { legalName?: { name?: string } } } } }
      | null;
    const name = body?.data?.attributes?.entity?.legalName?.name ?? "";
    if (name === "") {
      return { liveness: "unreachable", detail: "200 with no legalName in the record", ms };
    }
    // LIVE, and the evidence says whose registry it is, because GLEIF is a
    // SUBSTITUTION for the three providers the brief names and a reader must
    // not mistake it for one of them.
    return {
      liveness: "live",
      detail: `GET api.gleif.org /v1/lei-records/{lei} -> 200 (${name}); GLEIF is a substitution for Middesk / Persona KYB / Sumsub KYB, all gated`,
      ms,
    };
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
    // Integer division, not `Number(usdc) / 1e6`.
    //
    // "Money is never a float" is a non-negotiable and this line was the only
    // place in the repo that broke it. It is "only a display string", which is
    // exactly the excuse that puts a float next to money — and USDC has six
    // decimals, so above 2^53 minor units the double stops being exact. The
    // value here is small today. The rule is not about today.
    const usdcWhole = usdc / 1_000_000n;
    const usdcCents = (usdc % 1_000_000n) / 10_000n;
    const usdcHuman = `${usdcWhole}.${usdcCents.toString().padStart(2, "0")}`;

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

/* -------------------------------------------------------------------------- */
/* Rationed slots                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Some providers ration the probe endpoint. For those, a health request is not
 * free and a health request per probe call is a design error.
 *
 * THE MEASUREMENT (2026-09-11, ./verdict-cache.ts carries the full log). Plaid
 * allows ten `/institutions/get` calls per credential per window and answers
 * the eleventh with 429 `INSTITUTIONS_GET_LIMIT`. Reproduced against the
 * deployment: fourteen consecutive `GET /api/health` requests produced ten
 * `live` readings and then three `simulated` ones. One compliance run reads
 * this endpoint four or more times by itself, audit-claims.mjs reads it again,
 * and any uptime monitor pointed at it reads it for ever — so the eleventh
 * reading was routine rather than exotic, which is why the flap showed up
 * "roughly one run in three".
 *
 * A slot listed here is probed at most once per `refreshMs` — counted from the
 * last ATTEMPT, not the last success, so a throttled window is not answered by
 * hammering the provider that is throttling us. Between refreshes the last
 * EARNED verdict is quoted with its age attached. When a refresh does fire and
 * cannot reach a verdict — throttled, or the network failed — the last earned
 * verdict is still quoted, up to `maxQuoteMs`, and past that the slot reports
 * what actually happened this time and claims nothing.
 *
 * THE NUMBERS, AND WHY THESE ONES.
 *
 *   refreshMs 20s   Three calls a minute against a budget of ten. That leaves
 *                   room for two more instances of this function, plus a
 *                   script on a laptop sharing the same client_id, before
 *                   anyone sees a 429 at all. Short enough that a credential
 *                   revoked right now is reported within twenty seconds.
 *   maxQuoteMs 5m   The cliff. If Plaid has refused to evaluate our credential
 *                   for five unbroken minutes — which needs someone ELSE
 *                   burning the budget, since our own draw is three a minute —
 *                   then the honest answer stops being "it was live at 12:04"
 *                   and becomes "we have not been able to check for five
 *                   minutes". `rate_limited` is that answer, and it is
 *                   SIMULATED, and it says why.
 *
 * DELIBERATELY ONLY PLAID. Every other slot still probes on every reading.
 * Quoting is a concession bought by a measured ration, not a default: applied
 * to `card_webhooks` or `card_issuing` it would put a five-minute delay
 * between a Lithic outage and the endpoint admitting to it, and
 * attack-07-provider-outage is the test that says that delay is unacceptable.
 * A slot joins this table when someone has MEASURED a ration on it, and the
 * measurement goes in the comment.
 */
interface RationPolicy {
  readonly refreshMs: number;
  readonly maxQuoteMs: number;
  /** Shipped in the evidence string so the policy can be argued with. */
  readonly ration: string;
}

const RATIONED: Partial<Record<IntegrationSlot, RationPolicy>> = {
  open_banking: {
    refreshMs: 20_000,
    maxQuoteMs: 5 * 60_000,
    ration: "Plaid allows 10 /institutions/get per credential per window",
  },
};

/** Whole seconds, rounded down, for a human-facing age. */
const seconds = (ms: number): number => Math.floor(ms / 1000);

interface Reading {
  readonly liveness: Liveness;
  readonly detail: string;
  readonly ms: number;
  readonly fresh: boolean | null;
  readonly provenAtMs: number | null;
}

/**
 * One slot's reading, with the ration policy applied if it has one.
 *
 * The shape of the argument, in one place: a reading that did not reach a
 * verdict must not overwrite one that did, and a verdict that is being quoted
 * rather than re-earned must carry its age. Everything below is those two
 * sentences.
 */
async function readSlot(slot: IntegrationSlot, probe: Prober): Promise<Reading> {
  const policy = RATIONED[slot];
  if (policy === undefined) {
    const r = await probe();
    const earned = r.liveness === "live" || r.liveness === "unauthorised";
    return { ...r, fresh: earned ? true : null, provenAtMs: earned ? Date.now() : null };
  }

  // 1. Inside the refresh window: do not spend a unit of the ration at all.
  const held = recallVerdict(slot, policy.refreshMs, Date.now());
  if (held !== null) {
    return {
      liveness: held.liveness,
      detail:
        `${held.detail} [quoted, not re-probed: earned ${seconds(held.ageMs)}s ago; ` +
        `${policy.ration}, so this slot round-trips at most once per ${seconds(policy.refreshMs)}s]`,
      ms: held.latencyMs,
      fresh: false,
      provenAtMs: held.provenAtMs,
    };
  }

  // 2. Due for a refresh — unless the last refresh ALSO reached no verdict
  //    within the same interval. Measured: without this branch, a burst of
  //    health checks against an already-empty bucket spent thirteen more
  //    units of Plaid's ration in forty seconds, which keeps the bucket empty
  //    and delays the recovery it is waiting for. One attempt per interval,
  //    whether or not the last one worked.
  const lastAttempt = recallAttempt(slot);
  if (lastAttempt !== null && Date.now() - lastAttempt.atMs < policy.refreshMs) {
    const waited = seconds(Date.now() - lastAttempt.atMs);
    const fallback = recallVerdict(slot, policy.maxQuoteMs, Date.now());
    if (fallback !== null) {
      return {
        liveness: fallback.liveness,
        detail:
          `${fallback.detail} [quoted, earned ${seconds(fallback.ageMs)}s ago; the attempt ` +
          `${waited}s ago reached no verdict (${lastAttempt.detail}) and this slot will not ` +
          `re-ask for another ${seconds(policy.refreshMs) - waited}s]`,
        ms: fallback.latencyMs,
        fresh: false,
        provenAtMs: fallback.provenAtMs,
      };
    }
    return {
      // The cache is a dumb store and holds the verdict as a string; this is
      // the one place it comes back into the type, and an unrecognised word
      // becomes the verdict that claims least rather than being trusted.
      liveness: LIVENESS_VERDICTS.find((v) => v === lastAttempt.liveness) ?? "unreachable",
      detail:
        `${lastAttempt.detail} [last attempt ${waited}s ago; no verdict earned within the last ` +
        `${seconds(policy.maxQuoteMs)}s, so nothing is claimed for this slot]`,
      ms: 0,
      fresh: null,
      provenAtMs: null,
    };
  }

  // 3. A real round trip.
  const now = Date.now();
  const r = await probe();
  // A slot with no credential never left the process: nothing to remember,
  // nothing to back off from, and no ration was spent.
  if (r.liveness === "not_configured" || r.liveness === "unprobed") {
    return { ...r, fresh: null, provenAtMs: null };
  }
  rememberAttempt(slot, r, now);
  if (r.liveness === "live" || r.liveness === "unauthorised") {
    rememberVerdict(slot, r, now);
    return { ...r, fresh: true, provenAtMs: now };
  }

  // 4. The round trip reached no verdict — throttled, or the network failed.
  //    Report what we last KNEW, with its age, rather than downgrading the
  //    slot on evidence we do not have.
  const fallback = recallVerdict(slot, policy.maxQuoteMs, Date.now());
  if (fallback !== null) {
    return {
      liveness: fallback.liveness,
      detail:
        `${fallback.detail} [quoted, earned ${seconds(fallback.ageMs)}s ago; ` +
        `this reading reached no verdict: ${r.detail}]`,
      ms: fallback.latencyMs,
      fresh: false,
      provenAtMs: fallback.provenAtMs,
    };
  }

  // 5. Nothing recent enough to quote. Say so, and say which kind of silence
  //    it was. This is the verdict that must NOT be smoothed away: it is the
  //    endpoint admitting it has not been able to check.
  return {
    liveness: r.liveness,
    detail:
      `${r.detail} [no verdict earned within the last ${seconds(policy.maxQuoteMs)}s, ` +
      `so nothing is claimed for this slot]`,
    ms: r.ms,
    fresh: null,
    provenAtMs: null,
  };
}

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
          fresh: null, provenAt: null, ageSeconds: null,
        };
      }
      const { liveness, detail, ms, fresh, provenAtMs } = await readSlot(slot.slot, probe);
      return {
        slot: slot.slot,
        provider: slot.provider,
        liveness,
        // The whole point: ONLY a proven round trip earns the LIVE label.
        // A quoted verdict was proven by a round trip too — `provenAt` and
        // `ageSeconds` say which one and how long ago, and `fresh: false` says
        // out loud that this reading did not repeat it.
        label: liveness === "live" ? "LIVE" : "SIMULATED",
        mustBeLive: slot.mustBeLive,
        detail,
        checkedAt,
        latencyMs: ms || null,
        fresh,
        provenAt: provenAtMs === null ? null : new Date(provenAtMs).toISOString(),
        // Clamped at zero. The round trip that earned a FRESH verdict finishes
        // after this reading started, so a naive `start - provenAt` published
        // an age of -1s on every unrationed slot — a small lie, in the field
        // whose entire job is to stop small lies.
        ageSeconds: provenAtMs === null ? null : Math.max(0, seconds(Date.now() - provenAtMs)),
      };
    }),
  );
}
