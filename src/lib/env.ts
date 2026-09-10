import "server-only";

import {
  parseEnv,
  reportIntegrations,
  type Env,
  type SlotReport,
} from "./env.schema";

export {
  EnvironmentError,
  ENV_KEYS,
  ENV_HELP,
  INTEGRATION_SLOTS,
  envSchema,
  reportIntegrations,
} from "./env.schema";
export type { Env, IntegrationSlot, SlotStatus, SlotReport } from "./env.schema";

/**
 * The parsed environment. The single place process.env is read.
 *
 * Parsed eagerly at import: a malformed APP_DATABASE_URL should kill the
 * process at boot, not at the first request that happens to need money.
 */
export const env: Env = parseEnv(process.env);

/** Live-vs-simulated for every integration slot. Derived, never stored. */
export const integrations: readonly SlotReport[] = reportIntegrations(env);

/** Slots the brief requires to be live that currently are not. */
export const degradedMustBeLive: readonly SlotReport[] = integrations.filter(
  (s) => s.mustBeLive && s.status === "simulated",
);
