/**
 * The wire rail.
 *
 * `./adapter.ts`   the rail contract's five operations, one of which is
 *                  refused — `reverse`, with the measurement that earns the
 *                  refusal in the `supports` entry itself.
 * `./client.ts`    Increase's ISO-20022-shaped wire endpoints.
 * `./semantics.ts` provider objects -> the seven-member `RailEvent` union.
 *                  Pure; no network, no database, no clock.
 * `./ledger.ts`    booking a wire, and the immediate-availability proof.
 * `./outbound.ts`  the provider leg of a payment `requestPayment()` already
 *                  raised, approved and released.
 * `./types.ts`     the vocabulary, and the measured wire shapes.
 *
 * NOT REGISTERED IN `../adapters/index.ts`, and that is a deliberate scope
 * line rather than an omission. `allRailAdapters()` feeds
 * `renderRailCapabilityMatrix()`, which `contract.test.ts` asserts appears
 * VERBATIM in docs/RAILS.md — so adding a sixth row turns that suite red until
 * the doc is regenerated, and both of those files belong to the rails owner.
 * The two-line change and the regenerated table are in docs/WIRES.md §7.
 *
 * The `server-only` split matters here: `./adapter.ts`, `./client.ts`,
 * `./semantics.ts` and `./types.ts` touch no database and are importable from
 * anywhere, including a test with no environment at all. `./ledger.ts` and
 * `./outbound.ts` are `server-only` because they hold a connection. This
 * module re-exports both halves, so a client component must import the
 * specific file rather than the index — the same rule the other rails follow.
 */

export {
  IncreaseWireAdapter,
  increaseWireAdapter,
  WIRE_SUPPORT,
  type WireAdapterOptions,
} from './adapter';

export {
  IncreaseWireClient,
  INCREASE_WIRE_SANDBOX_BASE_URL,
  type IncreaseWireClientOptions,
} from './client';

export {
  inboundCredit,
  inboundWireEvent,
  outboundWireEvent,
  parseEventPointer,
  returnOfFunds,
  wireSemanticsKey,
  wireSettlementRef,
} from './semantics';

export {
  creditInboundWire,
  debitReturnedInboundWire,
  readWireAvailabilityDrift,
  readWireCredits,
  wireExternalRef,
  wireValueDate,
  WireBookingRefused,
  type CreditInboundWireArgs,
  type WireAvailabilityProof,
  type WireCreditReceipt,
  type WireReturnReceipt,
} from './ledger';

export {
  originateApprovedWire,
  resolveWireBeneficiary,
  WireOriginationRefused,
  type OriginateApprovedWireArgs,
  type OriginatedWire,
  type ResolvedWireBeneficiary,
} from './outbound';

export {
  isWireDelivery,
  WIRE_EVENT_CATEGORIES,
  WIRE_PROVIDER,
  WIRE_TITLE,
  type IncreaseEventPointer,
  type IncreaseInboundWireTransfer,
  type IncreaseWireReversal,
  type IncreaseWireTransfer,
  type InboundWireCredit,
  type WireBeneficiary,
  type WireInstruction,
} from './types';
