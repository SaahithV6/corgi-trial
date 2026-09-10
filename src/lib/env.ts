/**
 * Validated server environment.
 *
 * `server-only` makes importing this from a Client Component a build error
 * rather than a leaked secret. Nothing in here is ever prefixed
 * `NEXT_PUBLIC_`, and nothing in here may be re-exported from a module a
 * client component imports.
 *
 *   import { env } from "@/lib/env";
 *   const db = connect(env.DATABASE_URL);
 */
import "server-only";

import { parseEnv, type Env } from "./env.schema";

export { EnvironmentError, ENV_KEYS, ENV_HELP, envSchema } from "./env.schema";
export type { Env } from "./env.schema";

/**
 * Parsed once at module load, so a bad environment fails the process at
 * startup with a message naming every missing key, rather than at the first
 * request that happens to touch a rail.
 */
export const env: Env = parseEnv(process.env);
