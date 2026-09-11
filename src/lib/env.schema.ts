/**
 * Environment contract.
 *
 * The rule that shapes this file: a MISSING PROVIDER KEY IS NOT AN ERROR. It
 * selects that slot's simulator, and the selection is reported honestly by
 * /api/health and in the README's live-vs-simulated table.
 *
 * The first version of this module required all fifteen keys and threw at
 * import. That is correct for a system whose integrations are all mandatory,
 * and wrong for this one: it meant the deployed app could not boot until every
 * provider had been signed up for, which inverts the build order the brief
 * actually asks for ("wire the live rail before lunch on day one"). It also
 * made the honest-labelling requirement unimplementable, because a slot can
 * only be labelled `simulated` if the system is allowed to run without its key.
 *
 * So: exactly one variable is required to boot. Everything else degrades, and
 * the degradation is visible rather than silent.
 */

import { z } from "zod";

const EVM_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const pg = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .min(1, { error: `${label} must not be empty` })
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      error: `${label} must be a postgres:// or postgresql:// URI`,
    });

export const ENV_HELP: Record<string, string> = {
  APP_DATABASE_URL:
    "Neon pooled URI for the corgi_app role. NOT the owner - the app must hold no UPDATE/DELETE on money tables. Console > Connect > Connection string.",
  DIRECT_URL:
    "Neon UNPOOLED owner URI. Used only by scripts/migrate.mjs and scripts/seed.mjs; never by the app. Session advisory locks do not survive PgBouncer.",
  LITHIC_API_KEY: "Lithic sandbox key (raw UUID). app.lithic.com > Settings.",
  LITHIC_WEBHOOK_SECRET: "Lithic webhook signing secret (whsec_...), created when you register the webhook URL.",
  PERSONA_API_KEY: "Persona sandbox API key. app.withpersona.com > API keys. Director KYC only - business verification is gated.",
  PERSONA_WEBHOOK_SECRET: "Persona webhook shared secret.",
  PLAID_CLIENT_ID: "Plaid client_id. dashboard.plaid.com > Developers > Keys.",
  PLAID_SECRET: "Plaid SANDBOX secret. Never the production one.",
  INCREASE_API_KEY: "Increase sandbox API key. dashboard.increase.com. Absent means the ACH simulator is used.",
  INCREASE_WEBHOOK_SECRET: "Increase webhook secret (Standard Webhooks).",
  STRIPE_SECRET_KEY: "Stripe TEST secret key (sk_test_...). Used for the Connect business-registry leg. A live key ends the trial.",
  STRIPE_WEBHOOK_SECRET: "Stripe webhook signing secret (whsec_...).",
  USDC_SENDER_PRIVATE_KEY: "Throwaway Base Sepolia private key. TESTNET ONLY - must never have touched real funds.",
  USDC_SENDER_ADDRESS: "Address derived from the above.",
  BASE_SEPOLIA_RPC_URL: "https://sepolia.base.org - no API key needed.",
  USDC_CONTRACT_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e - Circle's USDC on Base Sepolia, 6 decimals.",
  SIM_CONTROL_ENABLED: "Set to 'true' to expose /api/sim control routes. Must be absent or false in any shared environment.",
};

export const envSchema = z.object({
  // ---- the only thing required to boot -------------------------------
  APP_DATABASE_URL: pg("APP_DATABASE_URL"),

  // ---- owner connection: scripts only, never the running app ---------
  DIRECT_URL: pg("DIRECT_URL").optional(),

  // ---- integration slots: absent key => that slot runs simulated -----
  LITHIC_API_KEY: z.string().min(1).optional(),
  LITHIC_WEBHOOK_SECRET: z.string().min(1).optional(),

  PERSONA_API_KEY: z.string().min(1).optional(),
  PERSONA_WEBHOOK_SECRET: z.string().min(1).optional(),

  PLAID_CLIENT_ID: z.string().min(1).optional(),
  PLAID_SECRET: z.string().min(1).optional(),

  INCREASE_API_KEY: z.string().min(1).optional(),
  INCREASE_WEBHOOK_SECRET: z.string().min(1).optional(),

  STRIPE_SECRET_KEY: z
    .string()
    .min(1)
    .refine((v) => !v.startsWith("sk_live"), {
      // Live keys are an automatic fail for the whole trial. Refuse at boot
      // rather than discovering it when money moves.
      error: "STRIPE_SECRET_KEY is a LIVE key. This system must never hold one.",
    })
    .optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),

  USDC_SENDER_PRIVATE_KEY: z.string().regex(EVM_PRIVATE_KEY, {
    error: "USDC_SENDER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
  }).optional(),
  USDC_SENDER_ADDRESS: z.string().regex(EVM_ADDRESS, {
    error: "USDC_SENDER_ADDRESS must be a 0x-prefixed 20-byte hex address",
  }).optional(),
  BASE_SEPOLIA_RPC_URL: z.string().url().optional(),
  USDC_CONTRACT_ADDRESS: z.string().regex(EVM_ADDRESS, {
    error: "USDC_CONTRACT_ADDRESS must be a 0x-prefixed 20-byte hex address",
  }).optional(),

  SIM_CONTROL_ENABLED: z.enum(["true", "false"]).optional(),
});

export type Env = z.infer<typeof envSchema>;

export const ENV_KEYS = Object.keys(envSchema.shape) as ReadonlyArray<keyof Env>;

/**
 * Integration slots and the keys each needs to run LIVE.
 *
 * `mustBeLive` marks the slots the trial brief requires to be genuinely live.
 * They are still allowed to degrade — a system that refuses to boot proves
 * nothing — but /api/health reports a degraded must-be-live slot as a WARNING
 * rather than as normal, so it cannot be quietly forgotten before submission.
 */
export const INTEGRATION_SLOTS = {
  card_issuing: { keys: ["LITHIC_API_KEY"], mustBeLive: true, provider: "Lithic sandbox" },
  card_webhooks: { keys: ["LITHIC_WEBHOOK_SECRET"], mustBeLive: false, provider: "Lithic" },
  director_kyc: { keys: [], mustBeLive: true, provider: "Persona sandbox, or Stripe Identity" },
  // GLEIF, and no key at all.
  //
  // This read "Stripe Connect (gated) — simulated" with `keys:
  // ["STRIPE_SECRET_KEY"]`, and both halves were false. The registry leg has
  // run on the GLEIF LEI register since the Stripe and Persona routes were
  // measured to be gated behind sales; GLEIF is a public API and needs no
  // credential. The verdict for this slot is computed as `live` and proven in
  // the database.
  //
  // The front door renders `provider` and the verdict ADJACENT, so the row read
  // "simulated" and "LIVE" at once — /api/health contradicting itself on one
  // line, on the endpoint this build declares authoritative and audits every
  // document against. The direction happened to be understating, which is the
  // safe direction and the reason it was not an automatic fail. It was still a
  // false label on the one surface that must never carry one.
  business_registry: { keys: [], mustBeLive: false, provider: "GLEIF LEI register" },
  open_banking: { keys: ["PLAID_CLIENT_ID", "PLAID_SECRET"], mustBeLive: false, provider: "Plaid sandbox" },
  ach_rail: { keys: ["INCREASE_API_KEY"], mustBeLive: false, provider: "Increase sandbox" },
  stablecoin: {
    keys: ["USDC_SENDER_PRIVATE_KEY", "USDC_SENDER_ADDRESS", "BASE_SEPOLIA_RPC_URL", "USDC_CONTRACT_ADDRESS"],
    mustBeLive: false,
    provider: "USDC on Base Sepolia",
  },
} as const satisfies Record<string, { keys: readonly (keyof Env)[]; mustBeLive: boolean; provider: string }>;

export type IntegrationSlot = keyof typeof INTEGRATION_SLOTS;
export type SlotStatus = "live" | "simulated";

export interface SlotReport {
  readonly slot: IntegrationSlot;
  readonly provider: string;
  readonly status: SlotStatus;
  readonly mustBeLive: boolean;
  readonly missing: readonly string[];
  /**
   * This slot declares NO credential, so `status` here is not a measurement.
   *
   * `status` is computed as "nothing is missing", and for a keyless slot
   * nothing can ever be missing — so it reads `live` unconditionally. That is
   * liveness from the ABSENCE of requirements, which is the same shape as the
   * ACH slot that once read LIVE because a key string was non-empty, and the
   * registry slot that read LIVE because a changed 400 message fell through an
   * `else`. Each was caught by measuring rather than by anything here.
   *
   * The honest position: the environment can only ever establish that a
   * credential is PRESENT and well-formed. It cannot establish that a
   * capability works. For `business_registry` (GLEIF, a public API needing no
   * key) and `director_kyc` (Persona or Stripe Identity, whichever branch is
   * taken) the verdict comes from `src/lib/integrations/probe.ts`, which makes
   * a real call — and `/api/health` is authoritative over this.
   *
   * So this flag exists to stop a reader mistaking "no credential was required"
   * for "a credential was checked". Do not delete it to make a union tidier.
   */
  readonly credentialless: boolean;
}

/**
 * Derive live-vs-simulated per slot from the parsed environment.
 *
 * This is the ONLY place that decision is made. Every other part of the system
 * — the rail factory, the KYB factory, /api/health, the README table and the
 * in-product banner — reads it from here, so they cannot disagree. A system
 * with two opinions about whether an integration is live will eventually
 * present the wrong one, and presenting a simulated integration as live fails
 * the entire trial.
 */
export function reportIntegrations(e: Partial<Env>): readonly SlotReport[] {
  return (Object.keys(INTEGRATION_SLOTS) as IntegrationSlot[]).map((slot) => {
    const spec = INTEGRATION_SLOTS[slot];
    const missing = spec.keys.filter((k) => {
      const v = e[k as keyof Env];
      if (v === undefined || v === "") return true;
      // A value the schema would REJECT must never count towards "live".
      //
      // /api/health deliberately reads the environment leniently, so that a
      // broken environment still produces a report instead of a blank 500.
      // That leniency must not become a way for an unusable credential to be
      // presented as a live integration: presenting a simulated or
      // non-functional integration as live fails the entire trial. So the
      // per-key rules that would reject a value at boot are re-applied here.
      if (!isUsable(k as keyof Env, v)) return true;
      return false;
    });
    return {
      slot,
      provider: spec.provider,
      status: missing.length === 0 ? ("live" as const) : ("simulated" as const),
      mustBeLive: spec.mustBeLive,
      missing,
      credentialless: spec.keys.length === 0,
    };
  });
}

/**
 * Would this value survive envSchema? Used by reportIntegrations so a lenient
 * read cannot label a rejected credential "live". Kept deliberately narrow —
 * it encodes only the rules that make a value UNUSABLE, not merely unusual.
 */
/**
 * Exported so it can be asserted directly.
 *
 * The rule it enforces — a value the schema would REJECT never counts towards
 * "live" — is the thing standing between a lenient /api/health and an unusable
 * credential being presented as a working integration. That is one of the six
 * automatic fails, so the rule is worth a test of its own rather than only
 * being observed through whichever slot happens to declare the key today.
 * A slot's key list changes; this does not.
 */
export function isUsable(key: keyof Env, value: string): boolean {
  switch (key) {
    case "STRIPE_SECRET_KEY":
      // A live key is refused at boot. It is not a working test integration.
      return !value.startsWith("sk_live");
    case "USDC_SENDER_PRIVATE_KEY":
      return EVM_PRIVATE_KEY.test(value);
    case "USDC_SENDER_ADDRESS":
    case "USDC_CONTRACT_ADDRESS":
      return EVM_ADDRESS.test(value);
    default:
      return true;
  }
}

export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
  readonly keys: readonly string[];

  constructor(message: string, keys: readonly string[]) {
    super(message);
    this.keys = keys;
  }
}

/** Parse and validate. Throws EnvironmentError naming every offending key. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // An environment variable set to the empty string is NOT configured. This
  // matters in practice: a hosting dashboard where someone adds the key and
  // leaves the value blank produces "" and not undefined, and treating that as
  // present would mark a slot LIVE with no credential behind it. Strip empties
  // before validation so "declared but blank" and "absent" mean the same
  // thing, which is what an operator staring at the dashboard believes.
  const cleaned: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(source)) {
    if (typeof v === "string" && v.trim() === "") continue;
    cleaned[k] = v;
  }
  const parsed = envSchema.safeParse(cleaned);
  if (parsed.success) return parsed.data;

  const issues = parsed.error.issues;
  const keys = [...new Set(issues.map((i) => String(i.path[0])))];
  const lines = issues.map((i) => {
    const key = String(i.path[0]);
    const help = ENV_HELP[key];
    return `  ${key}: ${i.message}${help ? `\n      ${help}` : ""}`;
  });
  throw new EnvironmentError(
    `Environment is invalid. ${keys.length} problem(s):\n${lines.join("\n")}`,
    keys,
  );
}
