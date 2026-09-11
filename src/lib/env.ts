/**
 * The parsed environment singleton, and the server-only door to it.
 *
 * WHY THIS IS A SEPARATE FILE FROM `./env.schema`. Almost everything exported
 * here is a re-export from there; the only original lines are the three
 * `const`s below. The split is not tidying, it is what keeps the contract
 * testable. `parseEnv` is a pure function of its argument, but the `env`
 * binding below calls it on `process.env` at module scope — so importing this
 * module at all parses the real environment and throws `EnvironmentError` if
 * it is incomplete. `src/lib/__tests__/env.test.ts` and `scaffold.test.ts`
 * import `../env.schema` and never this file, which lets them feed `parseEnv`
 * a fixture object and assert on the failure messages without a valid
 * environment existing at all.
 *
 * The same split is why `src/lib/webhooks/route-handler.ts` reads
 * `INTEGRATION_SLOTS` and `reportIntegrations` from the schema directly: that
 * module deliberately does not import `server-only`, and the slot table has to
 * stay reachable from it. The rule the two files keep is therefore — the
 * CONTRACT is pure and importable anywhere; the PARSED VALUE is server-only
 * and lives here.
 *
 * Why a missing provider key selects a simulator rather than failing the boot
 * is argued in `./env.schema`'s own header. It is not repeated here.
 *
 * ONE EXPORT BELOW HAS NO READER. `degradedMustBeLive` names the slots the
 * brief requires to be genuinely live that are currently running simulated;
 * as of this header nothing imports it (`grep -rn degradedMustBeLive src`
 * returns only its own definition). It is a correct answer to a question
 * nothing yet asks — check before assuming a screen is already using it.
 */

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
