/**
 * THE RAIL CONTRACT — what is true of all five rails, and nothing else.
 *
 * ─── WHY THIS FILE EXISTS, STATED HONESTLY ──────────────────────────────────
 *
 * "A rail is an adapter, not a schema" was true of ./types.ts and true of
 * ./stablecoin/, and it was not true of the directory. Before this file there
 * were TWO adapter interfaces and three modules behind neither:
 *
 *   PaymentRail (./types.ts)              implemented by increase/ and achsim/
 *                                         — both ACH, i.e. one rail twice
 *   StablecoinPayoutProvider (./stablecoin/types.ts)
 *                                         implemented by the direct-signing
 *                                         path and by Circle — genuinely
 *                                         polymorphic, and the model for this
 *   lithic/                               a module of free functions
 *   plaid/                                a module of free functions, with a
 *                                         header explaining — correctly — why
 *                                         it must not be a PaymentRail
 *
 * The two interfaces disagreed about the same ideas. Identity was spelled
 * `RailCapabilities` in one and `{id, label}` in the other. Liveness was
 * spelled four ways across the repo: `ProviderHealth.liveness` (four words),
 * `ProbeResult.liveness` in src/lib/integrations/probe.ts (six words),
 * `RailSlotHealth` here (no liveness at all — see below), and nothing for
 * Lithic or Plaid inside this package.
 *
 * ─── WHAT THIS FILE DOES NOT DO ─────────────────────────────────────────────
 *
 * It does not unify `initiateCredit(TransferRequest)` with
 * `send(StablecoinPayoutInstruction)`. Those arguments differ because the
 * rails differ — an ACH instruction needs a routing number and a SEC-code
 * intent, a USDC instruction needs a chain id and a token contract — and
 * flattening them into one union would move the branch from the caller into
 * the adapter and call it an abstraction. A caller who is originating always
 * knows which rail it picked, because it picked the destination. So
 * `OriginatingRail` is generic in its INSTRUCTION and uniform in its OUTCOME,
 * and the outcome is the half a generic consumer actually reads.
 *
 * It does not replace `PaymentRail`. That interface is the right shape for the
 * rails that have all four of its methods, and both ACH adapters keep it
 * untouched. This contract is the SMALLER thing underneath it: the operations
 * that survive when you also have to describe a card rail that cannot
 * originate and a bank-linking adapter that cannot move a cent.
 *
 * ─── THE FIVE OPERATIONS, NAMED FROM THE EVIDENCE ───────────────────────────
 *
 * Read what the five rails do, not what a textbook says a rail is:
 *
 *   originate  push an instruction onto the network.        3 of 5 rails.
 *   observe    turn a verified inbound delivery into a
 *              normalised fact about money.                 3 of 5 rails.
 *   settle     report that money finally moved, and for
 *              how much — which is NOT how much was
 *              instructed.                                  3 of 5 rails.
 *   reverse    report that settled money came back.         2 of 5 rails.
 *   probe      describe its own liveness.                   5 of 5 rails.
 *
 * `probe` is the only universal one, and that is not a disappointment — it is
 * the finding. The question "is this integration live, and is what it produces
 * evidence of anything" is asked of every slot, on every health surface, in
 * the README table, and by the one rule in this trial that fails a submission
 * outright. It had five implementations and no interface.
 *
 * ─── UNSUPPORTED IS A TYPE, NOT A THROW ─────────────────────────────────────
 *
 * A card rail never originates a payment: the merchant's acquirer does, and
 * Lithic tells us about it afterwards. A chain transfer is final, so the USDC
 * rail has no `reverse` — not "an unimplemented reverse", none. Plaid moves no
 * money at all.
 *
 * So an unsupported operation is expressed twice over, and neither is a
 * runtime failure:
 *
 *   1. THE METHOD IS ABSENT FROM THE TYPE. `canObserve(rail)` narrows;
 *      calling `observe` on a rail that does not have it is a compile error,
 *      not a `RailError` at 3am. An adapter that throws "not supported" is a
 *      schema pretending to be an adapter.
 *   2. `supports[operation]` CARRIES THE REASON. Machine-readable, so the
 *      capability matrix in docs/RAILS.md is generated from the adapters and
 *      cannot drift from them.
 *
 * ─── AND A SUPPORTED OPERATION CARRIES ITS PROOF ────────────────────────────
 *
 * "Never claim a capability not proven by a real call." `RailSupportEntry`
 * makes that a field rather than a promise: a supported operation says whether
 * it has been `measured` against the provider, only `simulated`, or is
 * `unexercised` — real code on a real wire shape that has never once been run.
 * The Increase adapter is the honest case: every one of its operations is
 * `unexercised`, because there has never been an Increase key in this repo.
 * That fact is now in the type system and on the generated table, not only in
 * a README paragraph someone has to remember to update.
 */

import type {
  Evidence,
  Money,
  RailEnvironment,
  RailEvent,
  RailKind,
  ReturnCategory,
} from './types';

// ---------------------------------------------------------------------------
// 1. Identity
// ---------------------------------------------------------------------------

/**
 * `RailKind`, plus the one slot in this directory that is not a rail.
 *
 * Plaid links a bank account; it originates nothing, observes no money and
 * settles nothing. `plaid/types.ts` argues at length that it must not be bent
 * into a `PaymentRail`, and that argument still holds — this contract does not
 * make it one. It participates through `probe` alone, with four explicit
 * refusals in `supports`, which is a more useful answer than leaving the
 * biggest live integration in the package outside every interface.
 *
 * Widening `RailKind` itself was the alternative and was rejected: that union
 * is read by `RailCapabilities` and `RailSlotHealth`, and `semantics.ts`
 * already declines to unify with it because the database enum is narrower
 * still. A new value there would typecheck its way to an INSERT the column
 * cannot store.
 */
export type RailSlot = RailKind | 'open_banking';

export interface RailIdentity {
  readonly slot: RailSlot;
  /** The stable slug persisted on ledger rows and webhook_inbox rows. */
  readonly provider: string;
  /** What a human reads. Never the slug on its own. */
  readonly title: string;
  /**
   * Whether this adapter's facts come from a real provider or from our
   * simulator. Sandbox counts as live: it is the provider's own system.
   */
  readonly evidence: Evidence;
  readonly environment: RailEnvironment;
}

// ---------------------------------------------------------------------------
// 2. The five operations, and what a rail says about each
// ---------------------------------------------------------------------------

export type RailOperation = 'originate' | 'observe' | 'settle' | 'reverse' | 'probe';

export const RAIL_OPERATIONS = [
  'originate',
  'observe',
  'settle',
  'reverse',
  'probe',
] as const satisfies readonly RailOperation[];

/**
 * How much of a supported operation has actually been run.
 *
 *   measured     exercised against the provider's own system, sandbox
 *                included. The `evidence` string names what was run.
 *   simulated    exercised, but only against our simulator. Proves the code
 *                path; proves nothing about a bank.
 *   unexercised  the code exists, the wire shape came from documentation, and
 *                it has never been run against the provider. This is not a
 *                defect — it is a claim nobody has earned yet, and saying so
 *                is the difference between a gap and a lie.
 */
export type RailProof = 'measured' | 'simulated' | 'unexercised';

export type RailSupportEntry =
  | {
      readonly supported: true;
      readonly proof: RailProof;
      /** What was run, or where the shape came from. One sentence. */
      readonly evidence: string;
    }
  | {
      readonly supported: false;
      /** Why this rail cannot do this, in domain terms. Never "TODO". */
      readonly reason: string;
    };

export type RailSupport = { readonly [K in RailOperation]: RailSupportEntry };

// ---------------------------------------------------------------------------
// 3. Liveness
// ---------------------------------------------------------------------------

/**
 * Liveness by proof, not by presence.
 *
 * The same six words as `Liveness` in src/lib/integrations/probe.ts, and
 * `contract.test.ts` holds a compile-time `Mutual<>` assertion against that
 * type so the two cannot drift. They are restated rather than imported because
 * that module is `server-only` and pulls in the validated env bag; a rail
 * adapter must stay importable from a test with no environment at all.
 *
 * `stablecoin/types.ts`'s `ProviderLiveness` is a four-word subset of this and
 * maps in without loss.
 */
export type RailLiveness =
  /** A real authenticated round trip returned 2xx. */
  | 'live'
  /** The credential exists and the provider REJECTED it. The placeholder case. */
  | 'unauthorised'
  /** Network or provider failure. We do not know, so we do not claim. */
  | 'unreachable'
  /** The provider rationed the reading. The credential was never evaluated. */
  | 'rate_limited'
  /** No credential at all. */
  | 'not_configured'
  /** A credential is present and nothing has been proven about it. */
  | 'unprobed';

export const RAIL_LIVENESS_VERDICTS = [
  'live',
  'unauthorised',
  'unreachable',
  'rate_limited',
  'not_configured',
  'unprobed',
] as const satisfies readonly RailLiveness[];

export interface RailProbe {
  readonly slot: RailSlot;
  readonly provider: string;
  readonly title: string;
  readonly liveness: RailLiveness;
  readonly evidence: Evidence;
  /**
   * The word a README table or a badge may use.
   *
   * LIVE requires BOTH halves: a real provider (`evidence === 'live'`) AND a
   * round trip that succeeded (`liveness === 'live'`). Either alone is how a
   * simulator gets presented as an integration, or a pasted placeholder gets
   * presented as a working key. See `railProbeLabel`.
   */
  readonly label: 'LIVE' | 'SIMULATED';
  /** Why. Always populated, including on `live`. */
  readonly detail: string;
  readonly ms: number;
  readonly checkedAt: string;
}

/**
 * The one place the honest label is computed.
 *
 * Both halves, every time. `achRailHealth()` in ./achsim/factory.ts computes a
 * label from `INCREASE_API_KEY` being a non-empty string and nothing else,
 * which is exactly the failure probe.ts was written to stop; that function is
 * left alone here because changing it would change behaviour, and it is named
 * in docs/RAILS.md instead.
 */
export function railProbeLabel(evidence: Evidence, liveness: RailLiveness): 'LIVE' | 'SIMULATED' {
  return evidence === 'live' && liveness === 'live' ? 'LIVE' : 'SIMULATED';
}

/**
 * Build a probe result from an identity and a verdict.
 *
 * The ONLY constructor for a `RailProbe`, so `label` is computed by
 * `railProbeLabel` every time and cannot be passed in. An adapter that could
 * supply its own label is an adapter that could label a simulator LIVE, and
 * "a simulated integration presented as live" is an automatic fail — so the
 * field is not the adapter's to write.
 */
export function makeRailProbe(
  identity: RailIdentity,
  verdict: {
    readonly liveness: RailLiveness;
    readonly detail: string;
    readonly ms: number;
    readonly checkedAt?: string | undefined;
  },
): RailProbe {
  return {
    slot: identity.slot,
    provider: identity.provider,
    title: identity.title,
    liveness: verdict.liveness,
    evidence: identity.evidence,
    label: railProbeLabel(identity.evidence, verdict.liveness),
    detail: verdict.detail,
    ms: verdict.ms,
    checkedAt: verdict.checkedAt ?? new Date().toISOString(),
  };
}

export interface RailProbeOptions {
  readonly signal?: AbortSignal | undefined;
  /** Injected in tests. Never a global in production code either. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// 4. The base contract
// ---------------------------------------------------------------------------

/**
 * Every adapter in this directory. Two fields and one method.
 *
 * That is deliberately almost nothing: it is the intersection of an ACH rail,
 * a card rail, a chain rail and a bank-linking adapter, and the intersection is
 * small because those things are genuinely different. Everything else is
 * reached through a narrowing predicate.
 */
export interface RailAdapter {
  readonly identity: RailIdentity;
  readonly supports: RailSupport;
  /** The cheapest honest answer to "could this rail work right now?". */
  probe(opts?: RailProbeOptions): Promise<RailProbe>;
}

// ---------------------------------------------------------------------------
// 5. observe / settle / reverse
// ---------------------------------------------------------------------------

/**
 * What a settlement looks like once the rail has been taken out of it.
 *
 * `kind` is the whole reason `settle` and `reverse` are two operations and not
 * one: a settlement and a return are both movements of money and they are not
 * the same movement, and a rail can have the first without the second. ACH has
 * both. A card has both (clearing, and reversal or chargeback). USDC has the
 * first and CANNOT have the second — the chain is final, and
 * `capabilities.supportsReturns` has said so all along.
 */
export interface RailSettlement {
  readonly slot: RailSlot;
  readonly provider: string;
  readonly evidence: Evidence;
  /** The provider's handle on the movement. The join key for everything. */
  readonly ref: string;
  /**
   * THE IDENTITY OF THIS SETTLEMENT, which is not the identity of the delivery
   * that carried it and not always the identity of the transfer either.
   *
   * This field is here because the first draft of `reportSettlements` reported
   * $375.00 of ACH where $125.00 had moved, and the reason is worth keeping:
   *
   *   - AN ACH TRANSFER SETTLES ONCE. Increase's webhook body is a POINTER, so
   *     `parseEvent` reads the transfer back, and EVERY delivery for that
   *     transfer — the submission notification, the settlement notification, a
   *     redelivery three days later — resolves to the transfer's CURRENT
   *     state. That is a feature: it is exactly what makes out-of-order
   *     delivery harmless. It also means a feed that sums per delivery counts
   *     one settlement once per notification ever sent. So on ACH the
   *     settlement's identity is the TRANSFER's.
   *
   *   - A CARD TRANSACTION SETTLES AS MANY TIMES AS IT LIKES. Partial
   *     captures, multiple captures, over-capture: auth 1000, clearing 600,
   *     clearing 300 is three events and two settlements on ONE transaction.
   *     Keying those by the transaction would collapse them into one and lose
   *     $3.00. So on a card the settlement's identity is the CLEARING EVENT's.
   *
   * Only the adapter knows which of those its rail is, which is why this value
   * is supplied by the adapter and not derived in here. Deduplication in
   * `reportSettlements` is `(provider, settlementRef, kind)` — "twice is one",
   * the same rule the webhook layer applies to deliveries, applied here to
   * money.
   */
  readonly settlementRef: string;
  readonly kind: 'settled' | 'returned';
  /**
   * What actually moved. Integer minor units, `bigint`, positive magnitude.
   * NOT the amount that was instructed — on a card those differ by design.
   */
  readonly amount: Money;
  /** When the network says it happened. Never inferred from our own clock. */
  readonly at: string;
  /** Populated only on `returned`. */
  readonly returnCategory?: ReturnCategory | undefined;
  /** The network-native code, e.g. 'R01' or a card reversal type. */
  readonly returnCode?: string | null | undefined;
}

/**
 * One verified inbound delivery, normalised.
 *
 * `event` is the existing seven-member `RailEvent` union from ./types.ts,
 * reused rather than replaced: it was already the right vocabulary and it is
 * already the ledger's input. `settlement` is the same delivery read as money,
 * and it is non-null for exactly the deliveries that moved some.
 *
 * The two are separate fields rather than one because they answer different
 * questions and a consumer usually wants only one of them. The dispatcher
 * wants the event (including `unknown`, so it can return 200 and move on); a
 * reconciliation sweep wants the settlement and nothing else.
 */
export interface RailObservation {
  readonly event: RailEvent;
  readonly settlement: RailSettlement | null;
}

/**
 * The rail-agnostic half of "did this delivery move money?".
 *
 * Every observing adapter ends up here, because once a provider payload has
 * been normalised into a `RailEvent` the question stops being about the
 * provider: exactly two of the seven event types are money moving, and both
 * carry their own amount. (`settled` only carries one as of the change
 * recorded on that variant in ./types.ts — before it, this function could not
 * have been written, which is the concrete thing the contract bought.)
 *
 * `submitted` is deliberately NOT a settlement. An ACH transfer that has been
 * handed to the network has not moved anyone's money yet, and counting it
 * would double-count it three days later.
 */
export function settlementFromEvent(event: RailEvent, settlementRef: string): RailSettlement | null {
  const base = {
    slot: event.railKind satisfies RailSlot,
    provider: event.provider,
    evidence: event.evidence,
    ref: event.transferId,
    settlementRef,
  } as const;

  switch (event.type) {
    case 'settled':
      return { ...base, kind: 'settled', amount: event.amount, at: event.settledAt };
    case 'returned':
      return {
        ...base,
        kind: 'returned',
        amount: event.amount,
        at: event.returnedAt,
        returnCategory: event.reason.category,
        returnCode: event.reason.code,
      };
    case 'submitted':
    case 'failed':
    case 'canceled':
    case 'correction':
    case 'unknown':
      return null;
  }
}

export interface ObservingRail extends RailAdapter {
  /**
   * An already-VERIFIED raw body -> one normalised observation.
   *
   * Same contract as `PaymentRail.parseEvent`, and for the same reasons:
   * verification happened upstream in `src/lib/webhooks/inbox.ts`, and this
   * MUST NEVER THROW on an unrecognised payload — a throw becomes a 5xx and a
   * provider that collects enough 5xx responses disables the subscription.
   * A failed read-back is the one exception and is still allowed to throw,
   * because not knowing the state is not the same as the event being
   * uninteresting.
   */
  observe(rawBody: string): Promise<RailObservation>;
}

// ---------------------------------------------------------------------------
// 6. originate
// ---------------------------------------------------------------------------

/**
 * The rail-agnostic fate of an instruction.
 *
 * Deliberately NOT `RailTransferStatus`. That union was written for ACH and it
 * has no honest home for three things a chain rail routinely produces: a
 * receipt that stopped being canonical after a reorg, a broadcast the node
 * later forgot, and a transaction the provider named that does not carry the
 * transfer we asked for. All three are "there is a handle and we do not know",
 * and mapping them onto `submitted` or `failed` would be a lie chosen for the
 * convenience of an enum.
 */
export type RailOriginationStatus =
  /** The network or provider has it. Nothing is final. */
  | 'accepted'
  /** Money provably moved. Proven by a read-back, never by an acknowledgement. */
  | 'settled'
  /** It never left us. Nothing was put on a wire. */
  | 'refused'
  /** It left us and did not arrive. */
  | 'failed'
  /** A handle exists and the outcome is unknown. Nothing may be posted. */
  | 'indeterminate';

export interface RailOrigination {
  readonly slot: RailSlot;
  readonly provider: string;
  readonly evidence: Evidence;
  /**
   * The provider's id for the instruction, or null when the provider never
   * named one — a pre-broadcast refusal has nothing to find later.
   */
  readonly ref: string | null;
  readonly amount: Money;
  readonly status: RailOriginationStatus;
  readonly at: string;
  /** Whatever the rail actually returned, untouched. Nothing is lost here. */
  readonly raw: unknown;
}

/**
 * The OTHER way a settlement arrives.
 *
 * On ACH and on cards a settlement is an inbound event, days later, and
 * `settlementFromEvent` is the road in. On a chain there is no inbound event
 * at all — nobody calls us — and the settlement is the receipt the originating
 * call already read back off the block before it was willing to return
 * `confirmed`. Same fact, same `RailSettlement`, different door.
 *
 * That difference is exactly why `settle` is its own operation in this
 * contract rather than a corollary of `observe`. A rail can settle without
 * observing anything.
 *
 * Only `settled` produces one. `accepted` is a broadcast, `indeterminate` is a
 * hash with no answer attached, and neither is money that has moved — the
 * stablecoin rail's whole design is that an acknowledgement cannot be rounded
 * up to a payment.
 */
export function settlementFromOrigination(origination: RailOrigination): RailSettlement | null {
  if (origination.status !== 'settled' || origination.ref === null) return null;
  return {
    slot: origination.slot,
    provider: origination.provider,
    evidence: origination.evidence,
    ref: origination.ref,
    // A chain transaction hash is the settlement: one hash, one transfer, one
    // confirmation. There is no second event to distinguish.
    settlementRef: origination.ref,
    kind: 'settled',
    amount: origination.amount,
    at: origination.at,
  };
}

/**
 * Generic in the INSTRUCTION, uniform in the OUTCOME. See the header.
 *
 * `I` is `TransferRequest` on ACH and `StablecoinPayoutInstruction` on USDC,
 * and a caller that is originating has already chosen between them by choosing
 * a destination. What a caller does NOT want to branch on afterwards is how
 * the answer is shaped, which is what `RailOrigination` fixes.
 */
export interface OriginatingRail<I> extends RailAdapter {
  originate(instruction: I): Promise<RailOrigination>;
}

// ---------------------------------------------------------------------------
// 7. Narrowing — the alternative to a method that throws
// ---------------------------------------------------------------------------

/**
 * Does this rail observe inbound deliveries?
 *
 * Both halves are checked: the declaration in `supports` AND the method. They
 * cannot legitimately disagree — `contract.test.ts` asserts they never do
 * across every adapter — but a predicate that trusted only the declaration
 * would narrow a lying adapter into a crash, and one that trusted only the
 * method would let an undeclared capability in through the back door.
 */
export function canObserve(rail: RailAdapter): rail is ObservingRail {
  return (
    rail.supports.observe.supported &&
    typeof (rail as Partial<ObservingRail>).observe === 'function'
  );
}

/**
 * Does this rail originate outbound movements?
 *
 * Narrows to `OriginatingRail<never>` on purpose. A caller holding a rail it
 * cannot name has no instruction it could legally build, and pretending
 * otherwise with `unknown` would hand it a method whose argument it must cast
 * to call. The honest generic use of `originate` is to REPORT on it — which
 * `supports.originate` covers without a method at all.
 */
export function canOriginate(rail: RailAdapter): rail is OriginatingRail<never> {
  return (
    rail.supports.originate.supported &&
    typeof (rail as Partial<OriginatingRail<never>>).originate === 'function'
  );
}

/** Whether a declared operation is supported, for callers that only need the flag. */
export function supportsOperation(rail: RailAdapter, operation: RailOperation): boolean {
  return rail.supports[operation].supported;
}

/** The reason an operation is unsupported, or null when it is supported. */
export function unsupportedReason(rail: RailAdapter, operation: RailOperation): string | null {
  const entry = rail.supports[operation];
  return entry.supported ? null : entry.reason;
}

// ---------------------------------------------------------------------------
// 8. THE GENERIC LIVENESS REPORTER
// ---------------------------------------------------------------------------

/**
 * Probe every rail, in parallel, in one vocabulary.
 *
 * The caller does not know — and this function does not learn — which rail is
 * which. Each adapter owns its own cheapest authenticated read; all this does
 * is fan out and keep the order stable so a rendered table does not reshuffle
 * between refreshes.
 *
 * NOTHING HERE CAN THROW. A rail whose probe rejects is reported as
 * `unreachable` with the error's message as the detail, because one provider
 * having a bad afternoon must not take the honesty table down — and a health
 * surface that 500s tells an operator less than one that says which slot is
 * broken.
 */
export async function probeRails(
  rails: readonly RailAdapter[],
  opts?: RailProbeOptions,
): Promise<readonly RailProbe[]> {
  return Promise.all(
    rails.map(async (rail): Promise<RailProbe> => {
      const started = Date.now();
      try {
        return await rail.probe(opts);
      } catch (error) {
        return makeRailProbe(rail.identity, {
          liveness: 'unreachable',
          detail: `probe threw: ${error instanceof Error ? error.message : String(error)}`,
          ms: Date.now() - started,
        });
      }
    }),
  );
}

/**
 * The honesty table, in one line.
 *
 * `live` counts only rails that are BOTH a real provider and answering, which
 * is the number the brief's "at least two integrations are genuinely live"
 * rule is about.
 */
export function summariseProbes(probes: readonly RailProbe[]): {
  readonly live: number;
  readonly simulated: number;
  readonly total: number;
} {
  const live = probes.filter((p) => p.label === 'LIVE').length;
  return { live, simulated: probes.length - live, total: probes.length };
}

// ---------------------------------------------------------------------------
// 9. THE GENERIC SETTLEMENT REPORTER
// ---------------------------------------------------------------------------

/** One verified delivery, addressed to a rail by its provider slug. */
export interface RailDelivery {
  /** Matched against `identity.provider`. */
  readonly provider: string;
  /** The verified bytes, exactly as received. */
  readonly rawBody: string;
}

export interface RailSettlementReport {
  readonly settlements: readonly RailSettlement[];
  /** Deliveries that parsed but moved no money — an auth, a no-op, an unknown. */
  readonly nonSettling: readonly RailEvent[];
  /** Deliveries addressed to a provider none of the given rails answers for. */
  readonly unroutable: readonly RailDelivery[];
  /**
   * Settlements this feed had already seen, dropped from `settlements` and
   * from `net` but kept here.
   *
   * Twice is one — and a feed that silently discarded the second copy would
   * be indistinguishable from a feed that never received it. Replays and
   * pointer-webhook re-reads land here, in the open.
   */
  readonly duplicates: readonly RailSettlement[];
  /** Net movement per currency, in integer minor units. Returns subtract. */
  readonly net: ReadonlyMap<Money['currency'], bigint>;
}

/**
 * ONE settlement reporter, across every rail that has settlements.
 *
 * This is the function that had to be possible for the contract to be worth
 * anything, and the reason it was not possible before is worth writing down:
 * a Lithic clearing, an Increase settlement and a simulated ACH settlement
 * used to come back as three unrelated types — `NormalizedTransaction`,
 * `RailEvent` with no amount on it, and the same again — so every consumer
 * that wanted "what settled today, for how much" either branched per provider
 * or reached into `raw`.
 *
 * It knows nothing about ACH, cards or chains. It routes by slug, calls
 * `observe`, and adds up `bigint` minor units per currency. A rail added
 * tomorrow is covered by this function on the day its adapter exists.
 *
 * ORDER IS PRESERVED. Deliveries come back in the order they were given, not
 * in completion order, because a settlement feed that reshuffles under load is
 * a reconciliation input that cannot be diffed twice and match.
 */
export async function reportSettlements(
  rails: readonly ObservingRail[],
  deliveries: readonly RailDelivery[],
): Promise<RailSettlementReport> {
  const byProvider = new Map<string, ObservingRail>();
  for (const rail of rails) byProvider.set(rail.identity.provider, rail);

  const settlements: RailSettlement[] = [];
  const nonSettling: RailEvent[] = [];
  const unroutable: RailDelivery[] = [];
  const duplicates: RailSettlement[] = [];
  const net = new Map<Money['currency'], bigint>();
  const seen = new Set<string>();

  const results = await Promise.all(
    deliveries.map(async (delivery) => {
      const rail = byProvider.get(delivery.provider);
      if (rail === undefined) return { delivery, observation: null };
      return { delivery, observation: await rail.observe(delivery.rawBody) };
    }),
  );

  for (const { delivery, observation } of results) {
    if (observation === null) {
      unroutable.push(delivery);
      continue;
    }
    const { settlement } = observation;
    if (settlement === null) {
      nonSettling.push(observation.event);
      continue;
    }
    // Twice is one. See `RailSettlement.settlementRef` for why the key is
    // what it is and why only the adapter could have chosen it.
    const key = `${settlement.provider} ${settlement.settlementRef} ${settlement.kind}`;
    if (seen.has(key)) {
      duplicates.push(settlement);
      continue;
    }
    seen.add(key);

    settlements.push(settlement);
    // A return moves money the other way. Summing magnitudes would report a
    // settle-then-return pair as twice the movement instead of none.
    const signed = settlement.kind === 'returned' ? -settlement.amount.amount : settlement.amount.amount;
    net.set(settlement.amount.currency, (net.get(settlement.amount.currency) ?? 0n) + signed);
  }

  return { settlements, nonSettling, unroutable, duplicates, net };
}

// ---------------------------------------------------------------------------
// 10. THE CAPABILITY MATRIX — generated, so it cannot drift from the code
// ---------------------------------------------------------------------------

export interface RailCapabilityCell {
  readonly operation: RailOperation;
  readonly supported: boolean;
  readonly proof: RailProof | null;
  /** The evidence sentence when supported, the refusal reason when not. */
  readonly note: string;
}

export interface RailCapabilityRow {
  readonly identity: RailIdentity;
  readonly cells: readonly RailCapabilityCell[];
}

export function railCapabilityMatrix(rails: readonly RailAdapter[]): readonly RailCapabilityRow[] {
  return rails.map((rail) => ({
    identity: rail.identity,
    cells: RAIL_OPERATIONS.map((operation): RailCapabilityCell => {
      const entry = rail.supports[operation];
      return entry.supported
        ? { operation, supported: true, proof: entry.proof, note: entry.evidence }
        : { operation, supported: false, proof: null, note: entry.reason };
    }),
  }));
}

/** The glyph for a cell. `~` is "supported, and nobody has run it". */
export function capabilityGlyph(cell: RailCapabilityCell): '+' | '~' | '-' {
  if (!cell.supported) return '-';
  return cell.proof === 'unexercised' ? '~' : '+';
}

/**
 * The matrix as a Markdown table, so docs/RAILS.md is GENERATED from the
 * adapters rather than typed next to them.
 *
 * `contract.test.ts` regenerates this and compares it against the block
 * committed in docs/RAILS.md. A rail that gains or loses an operation turns
 * the suite red until the doc is regenerated, which is the only way a table
 * like this stays true for longer than a week.
 */
export function renderRailCapabilityMatrix(rails: readonly RailAdapter[]): string {
  const rows = railCapabilityMatrix(rails);
  const header = `| Rail | Provider | Evidence | ${RAIL_OPERATIONS.join(' | ')} |`;
  const rule = `| --- | --- | --- | ${RAIL_OPERATIONS.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => {
    const cells = row.cells.map((cell) => capabilityGlyph(cell)).join(' | ');
    return `| ${row.identity.title} | \`${row.identity.provider}\` | ${row.identity.evidence} | ${cells} |`;
  });
  return [header, rule, ...body].join('\n');
}
