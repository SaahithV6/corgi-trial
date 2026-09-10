/**
 * Environment schema and parser.
 *
 * This module is deliberately free of `server-only` so it can be unit tested
 * and so the parser can be exercised without a live process environment. It
 * holds no values. `src/lib/env.ts` is the only module that reads
 * `process.env`, and that one is server-only.
 */
import { z } from "zod";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

/** A non-empty, whitespace-trimmed secret. */
const secret = (label: string) =>
  z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, { error: `${label} must not be empty` });

const url = (label: string) =>
  secret(label).refine((value) => URL.canParse(value), {
    error: `${label} must be a valid URL`,
  });

/**
 * Every key, with a one-line note used verbatim in the failure message so an
 * operator reading a crashed boot log knows what the key is and where it comes
 * from without opening another file.
 */
export const ENV_HELP: Record<string, string> = {
  DATABASE_URL:
    "Postgres connection string (Neon dashboard -> Connection Details, pooled).",
  LITHIC_API_KEY: "Lithic sandbox API key (Lithic dashboard -> Developers -> API Keys).",
  LITHIC_WEBHOOK_SECRET:
    "Lithic webhook signing secret (Lithic dashboard -> Developers -> Webhooks).",
  PERSONA_API_KEY: "Persona sandbox API key (Persona dashboard -> API Keys).",
  PERSONA_WEBHOOK_SECRET:
    "Persona webhook shared secret (Persona dashboard -> Webhooks -> the webhook's secret).",
  PLAID_CLIENT_ID: "Plaid client id (Plaid dashboard -> Team Settings -> Keys).",
  PLAID_SECRET: "Plaid sandbox secret (Plaid dashboard -> Team Settings -> Keys).",
  INCREASE_API_KEY: "Increase sandbox API key (Increase dashboard -> Developers -> API Keys).",
  INCREASE_WEBHOOK_SECRET:
    "Increase webhook secret (Increase dashboard -> Developers -> Event Subscriptions).",
  STRIPE_SECRET_KEY: "Stripe test-mode secret key, sk_test_... (Stripe dashboard -> Developers -> API Keys).",
  STRIPE_WEBHOOK_SECRET:
    "Stripe webhook signing secret, whsec_... (Stripe dashboard -> Developers -> Webhooks, or `stripe listen`).",
  USDC_SENDER_PRIVATE_KEY:
    "0x-prefixed 32-byte private key of the Base Sepolia payout wallet. Testnet funds only.",
  USDC_SENDER_ADDRESS:
    "0x-prefixed address derived from USDC_SENDER_PRIVATE_KEY; kept explicit so a mismatch is caught at boot.",
  BASE_SEPOLIA_RPC_URL:
    "Base Sepolia JSON-RPC endpoint (Alchemy/Infura, or https://sepolia.base.org).",
  USDC_CONTRACT_ADDRESS:
    "USDC token contract on Base Sepolia (0x036CbD53842c5426634e7929541eC2318f3dCF7e).",
};

export const envSchema = z.object({
  // Storage
  DATABASE_URL: url("DATABASE_URL"),

  // Card issuing — Lithic
  LITHIC_API_KEY: secret("LITHIC_API_KEY"),
  LITHIC_WEBHOOK_SECRET: secret("LITHIC_WEBHOOK_SECRET"),

  // KYB / KYC — Persona
  PERSONA_API_KEY: secret("PERSONA_API_KEY"),
  PERSONA_WEBHOOK_SECRET: secret("PERSONA_WEBHOOK_SECRET"),

  // Open banking — Plaid
  PLAID_CLIENT_ID: secret("PLAID_CLIENT_ID"),
  PLAID_SECRET: secret("PLAID_SECRET"),

  // ACH rail — Increase
  INCREASE_API_KEY: secret("INCREASE_API_KEY"),
  INCREASE_WEBHOOK_SECRET: secret("INCREASE_WEBHOOK_SECRET"),

  // Cards-on-file / collections — Stripe
  STRIPE_SECRET_KEY: secret("STRIPE_SECRET_KEY"),
  STRIPE_WEBHOOK_SECRET: secret("STRIPE_WEBHOOK_SECRET"),

  // Stablecoin payout — USDC on Base Sepolia
  USDC_SENDER_PRIVATE_KEY: secret("USDC_SENDER_PRIVATE_KEY").regex(EVM_PRIVATE_KEY, {
    error: "USDC_SENDER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string",
  }),
  USDC_SENDER_ADDRESS: secret("USDC_SENDER_ADDRESS").regex(EVM_ADDRESS, {
    error: "USDC_SENDER_ADDRESS must be a 0x-prefixed 20-byte hex address",
  }),
  BASE_SEPOLIA_RPC_URL: url("BASE_SEPOLIA_RPC_URL"),
  USDC_CONTRACT_ADDRESS: secret("USDC_CONTRACT_ADDRESS").regex(EVM_ADDRESS, {
    error: "USDC_CONTRACT_ADDRESS must be a 0x-prefixed 20-byte hex address",
  }),
});

export type Env = z.infer<typeof envSchema>;

/** Every key the app requires, in declaration order. */
export const ENV_KEYS = Object.keys(envSchema.shape) as ReadonlyArray<keyof Env>;

export class EnvironmentError extends Error {
  override readonly name = "EnvironmentError";
  readonly keys: readonly string[];

  constructor(message: string, keys: readonly string[]) {
    super(message);
    this.keys = keys;
  }
}

/**
 * Parse a raw environment bag.
 *
 * Throws `EnvironmentError` naming every offending key — not just the first —
 * because fixing one missing secret only to crash on the next is a bad loop to
 * put someone in at 3am. Values are never echoed back in the message.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const problems = new Map<string, string>();
  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? "(unknown)");
    if (problems.has(key)) continue;
    const present = typeof raw[key] === "string" && raw[key].trim() !== "";
    problems.set(key, present ? issue.message : `${key} is missing`);
  }

  const keys = [...problems.keys()];
  const lines = keys.map((key) => {
    const help = ENV_HELP[key];
    return `  - ${problems.get(key) ?? key}${help ? `\n      ${help}` : ""}`;
  });

  const message = [
    `Environment is not usable: ${keys.length} problem${keys.length === 1 ? "" : "s"}.`,
    ...lines,
    "",
    "Copy .env.example to .env and fill these in. Never commit .env.",
  ].join("\n");

  throw new EnvironmentError(message, keys);
}
