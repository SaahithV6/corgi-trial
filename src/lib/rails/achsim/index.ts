/**
 * The ACH simulator, in one import.
 *
 *   import { createAchRail } from '@/lib/rails/achsim';
 *   const { rail, health, engine } = createAchRail();
 *
 * `rail` is a `PaymentRail` and nothing about using it differs from the live
 * adapter. `health` is what `/api/health` prints. `engine` is non-null only
 * when the simulator was selected, and is how a demo drives the awkward cases.
 *
 * Everything this package produces says `evidence: 'simulated'`. See
 * ../README.md, "Three layers, none of them a promise", for why that cannot be
 * removed or faked.
 */

export {
  DEFAULT_EPOCH_MS,
  IdMinter,
  VirtualClock,
  days,
  hours,
  mulberry32,
  seedFrom,
} from './clock';

export {
  ACH_SIM_RETURN_CODES,
  ACHSIM_PROVIDER_SLUG,
  AchSimEngine,
  DEFAULT_SCENARIO,
  isAchSimReturnCode,
  returnReasonFor,
  type AchSimEngineOptions,
  type AchSimNocSpec,
  type AchSimOutage,
  type AchSimReturnCode,
  type AchSimReturnCodeSpec,
  type AchSimReturnSpec,
  type AchSimScenario,
  type AchSimTransferRecord,
  type DeliveryIntent,
  type SimulatedDelivery,
} from './engine';

export {
  ACHSIM_PROVIDER,
  SIMULATED_MARKER,
  SimulatedSecretMisuseError,
  WebhookSigner,
  achsimVerifier,
  assertNotTheLiveSecret,
  type SignedDelivery,
  type WebhookSignerOptions,
} from './signing';

export {
  ACHSIM_CAPABILITIES,
  AchSimRail,
  type AchSimRailOptions,
  type SimulatedCapabilities,
} from './rail';

export {
  AchSimControl,
  SIM_DESTINATION,
  SIM_PRESETS,
  describeDelivery,
  describeTransfer,
  handleControlCommand,
  isPresetName,
  parseCommand,
  type AchSimControlOptions,
  type SimCommand,
  type SimCommandResult,
  type SimPresetName,
} from './control';

export {
  LIVE_ACH_ENV,
  LIVE_ACH_WEBHOOK_ENV,
  SIM_WEBHOOK_SECRET_DEFAULT,
  SIM_WEBHOOK_SECRET_ENV,
  achRailHealth,
  createAchRail,
  type AchRailSelection,
  type CreateAchRailOptions,
  type EnvBag,
} from './factory';
