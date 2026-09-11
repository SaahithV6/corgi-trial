/**
 * Every adapter in this directory, and the one function that assembles them.
 *
 * `allRailAdapters()` is what a health surface, a settlement feed or a
 * generated capability table asks for. It builds the five adapters from an
 * environment bag and NOTHING ELSE: no network, no database handle, no key
 * read into module scope. Constructing the set is free; only `probe()` costs a
 * round trip.
 */

export { achSimAdapter, increaseAchAdapter, type AchInstruction } from './ach';
export { lithicCardAdapter, parseLithicEvent, LITHIC_PROVIDER_SLUG } from './card';
export { plaidOpenBankingAdapter } from './openbanking';
export { stablecoinRailAdapter } from './stablecoin';
export {
  DEFAULT_PROBE_TIMEOUT_MS,
  livenessFromStatus,
  readEnvValue,
  timedFetch,
} from './probe-http';

import { AchSimEngine } from '../achsim/engine';
import { AchSimRail } from '../achsim/rail';
import { WebhookSigner } from '../achsim/signing';
import type { RailAdapter } from '../contract';
import { IncreaseAchRail } from '../increase/client';
import { achSimAdapter, increaseAchAdapter } from './ach';
import { lithicCardAdapter } from './card';
import { plaidOpenBankingAdapter } from './openbanking';
import { readEnvValue } from './probe-http';

export interface AllRailsOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * The USDC rail, if the caller has one.
   *
   * Not built here, deliberately. Every other adapter needs only environment
   * strings; a stablecoin provider needs an RPC client and, on the direct
   * path, a parsed private key — and `directProvider()` THROWS when
   * `USDC_SENDER_PRIVATE_KEY` is absent. Constructing it inside a function
   * whose whole promise is "this is free and cannot fail" would make a
   * capability table impossible to render on a box with no signing key. The
   * caller that has a provider passes it; `stablecoinRailAdapter` wraps it.
   */
  readonly stablecoin?: RailAdapter | undefined;
}

/**
 * The ACH slot is ONE rail, served by one of two adapters.
 *
 * Which one follows `createAchRail`'s rule exactly — `INCREASE_API_KEY`
 * present means the live adapter — so the contract's view of the ACH slot and
 * the application's cannot disagree about who is serving it. Both are never
 * returned at once: an honesty table that listed a live rail and its simulator
 * side by side would be describing a deployment that does not exist.
 */
export function achAdapterFor(env: Readonly<Record<string, string | undefined>>): RailAdapter {
  if (readEnvValue(env, 'INCREASE_API_KEY') !== undefined) {
    return increaseAchAdapter({ rail: new IncreaseAchRail({}), env });
  }
  const signer = new WebhookSigner({
    secret: readEnvValue(env, 'ACH_SIM_WEBHOOK_SECRET') ?? 'achsim-development-only-not-a-real-secret',
    ...(readEnvValue(env, 'INCREASE_WEBHOOK_SECRET') === undefined
      ? {}
      : { liveSecret: readEnvValue(env, 'INCREASE_WEBHOOK_SECRET') }),
  });
  const engine = new AchSimEngine({ signer, seed: readEnvValue(env, 'ACH_SIM_SEED') ?? 'achsim' });
  return achSimAdapter({ rail: new AchSimRail({ engine }) });
}

export function allRailAdapters(opts: AllRailsOptions = {}): readonly RailAdapter[] {
  const env = opts.env ?? process.env;
  const rails: RailAdapter[] = [
    achAdapterFor(env),
    lithicCardAdapter({ env }),
    plaidOpenBankingAdapter({ env }),
  ];
  if (opts.stablecoin !== undefined) rails.push(opts.stablecoin);
  return rails;
}
