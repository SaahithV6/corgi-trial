/**
 * The composite: director KYC + business registry, combined honestly.
 *
 * This is the file to read first, and the one to attack first.
 *
 * Two legs answer. The composite:
 *
 *   1. takes the STRICTEST of the two statuses — rejected > needs_review >
 *      pending > approved — so an approval on one leg can never dilute a
 *      decline on the other;
 *   2. degrades `evidence` to `simulated` if EITHER leg was simulated;
 *   3. records, per leg, which provider answered and with what reference id, so
 *      the evidence pack can cite `inq_…` / `acct_…` rather than assert.
 *
 * RULE 2 IS THE POINT, AND IT IS NOT ENFORCED BY CONVENTION.
 *
 * `CompositeKybResult` has no `evidence` field. It has a private `#legs` field
 * and an `evidence` GETTER derived from it. That single design choice closes
 * every forgery route at once:
 *
 *   - You cannot write one as an object literal. The private field makes the
 *     class nominally typed, so `const r: CompositeKybResult = { evidence:
 *     'live', … }` is a compile error naming the missing private member.
 *   - You cannot construct one with an evidence of your choosing. The
 *     constructor is `private`; the only entry points are `of()` and
 *     `rehydrate()`, and neither takes an evidence argument — both derive it.
 *   - You cannot subclass one and override the getter. A private constructor
 *     makes the class unextendable.
 *   - You cannot overwrite it afterwards. Instances are frozen, so
 *     `Object.defineProperty(result, 'evidence', …)` throws instead of
 *     shadowing the prototype getter, and the prototype itself is frozen too.
 *   - You cannot smuggle a forged label in from storage. `rehydrate()` takes
 *     legs, not a label, so a hand-edited `kyb_evidence = 'live'` column is
 *     ignored on read and recomputed from the legs that produced it.
 *   - You cannot even TYPE a forgery when the legs are statically known:
 *     `CompositeKybResult<'live'>` is only obtainable from two `'live'` legs,
 *     because `of()` returns `CompositeKybResult<DegradeEvidence<A, B>>`.
 *
 * `composite.test.ts` tries all six and asserts each one fails.
 *
 * The last line of defence is in the database: db/migrations/0005_kyb.sql
 * carries a CHECK constraint refusing any row whose composite evidence is
 * `live` while a leg's is not. Three independent statements of one rule, none
 * of which is a comment.
 */

import {
  degradeEvidence,
  strictestOf,
  type CreateKybVerificationInput,
  type DegradeEvidence,
  type Evidence,
  type KybCheck,
  type KybLegKind,
  type KybLegProvider,
  type KybLegResult,
  type KybStatus,
} from './types';

// ---------------------------------------------------------------------------
// 1. The result
// ---------------------------------------------------------------------------

/** The provider reference ids needed to re-read both legs. */
export interface KybReferences {
  readonly director: string;
  readonly registry: string;
}

/** JSON shape written to (and read back from) the database and the API. */
export interface CompositeKybJson {
  readonly referenceId: string;
  readonly status: KybStatus;
  readonly evidence: Evidence;
  readonly createdAt: string;
  readonly legs: readonly KybLegResult[];
}

/**
 * A two-leg verification whose status and evidence are DERIVED, never stored.
 *
 * The type parameter is the evidence this instance can be typed as; it is
 * `Evidence` (i.e. unknown until runtime) whenever the legs were chosen from
 * the environment, and narrows to a literal when they were not.
 */
export class CompositeKybResult<E extends Evidence = Evidence> {
  /**
   * The only state. Everything else on this class is a function of it.
   * `#`-private, which is what makes the class nominally typed to TypeScript
   * and genuinely unreachable at runtime.
   */
  readonly #legs: readonly KybLegResult[];
  readonly #referenceId: string;
  readonly #createdAt: string;

  /**
   * Private: there is no way to hand this class an evidence label. Use `of()`
   * for a fresh verification or `rehydrate()` for one read back from storage.
   */
  private constructor(referenceId: string, legs: readonly KybLegResult[], createdAt: string) {
    this.#referenceId = referenceId;
    this.#legs = Object.freeze([...legs]);
    this.#createdAt = createdAt;
    // Non-extensible, so a later `defineProperty` cannot shadow the getters
    // below with an own data property.
    Object.freeze(this);
  }

  /**
   * Combine a fresh pair of leg results.
   *
   * The return type is the evidence-degradation rule expressed in the type
   * system: two `'live'` legs give `CompositeKybResult<'live'>`, and every
   * other combination gives `CompositeKybResult<'simulated'>`.
   */
  static of<A extends Evidence, B extends Evidence>(
    referenceId: string,
    director: KybLegResult<A>,
    registry: KybLegResult<B>,
    observedAt: string = new Date().toISOString(),
  ): CompositeKybResult<DegradeEvidence<A, B>> {
    return new CompositeKybResult<DegradeEvidence<A, B>>(referenceId, [director, registry], observedAt);
  }

  /**
   * Rebuild from stored legs.
   *
   * Deliberately takes NO status and NO evidence. A stored `kyb_status` /
   * `kyb_evidence` pair is a cache of this computation, and a cache is not a
   * source of truth: if a row says `live` and its legs say otherwise, the legs
   * win and the row was wrong.
   */
  static rehydrate(
    referenceId: string,
    legs: readonly KybLegResult[],
    createdAt: string = new Date().toISOString(),
  ): CompositeKybResult {
    return new CompositeKybResult<Evidence>(referenceId, legs, createdAt);
  }

  get referenceId(): string {
    return this.#referenceId;
  }

  get createdAt(): string {
    return this.#createdAt;
  }

  /** Every leg, in the order they were combined. Frozen. */
  get legs(): readonly KybLegResult[] {
    return this.#legs;
  }

  /** Rule 1: strictest wins. No leg, no approval — an empty set is `pending`. */
  get status(): KybStatus {
    return strictestOf(this.#legs.map((leg) => leg.status));
  }

  /**
   * Rule 2: degrade to `simulated` if any leg was.
   *
   * The cast is the ONE place in this module where a type is asserted rather
   * than proved, and it is sound by construction: `of()` only produces
   * `E = DegradeEvidence<A, B>` from legs whose evidence is `A` and `B`, which
   * is exactly what `degradeEvidence` computes here. Nothing outside this class
   * can reach `#legs` to make the two disagree.
   */
  get evidence(): E {
    return degradeEvidence(this.#legs.map((leg) => leg.evidence)) as E;
  }

  /** True only when every leg was answered by a third party. */
  get isLive(): boolean {
    return this.evidence === 'live';
  }

  leg(kind: KybLegKind): KybLegResult | null {
    return this.#legs.find((l) => l.leg === kind) ?? null;
  }

  get directorLeg(): KybLegResult | null {
    return this.leg('director_kyc');
  }

  get registryLeg(): KybLegResult | null {
    return this.leg('business_registry');
  }

  /** The first hosted flow a human can be sent to, if any leg has one. */
  get hostedUrl(): string | null {
    return this.#legs.find((l) => l.hostedUrl !== null)?.hostedUrl ?? null;
  }

  /** Provider references, for the evidence pack: which provider said what. */
  get citations(): readonly {
    readonly leg: KybLegKind;
    readonly provider: string;
    readonly reference: string;
    readonly status: KybStatus;
    readonly evidence: Evidence;
    readonly observedAt: string;
  }[] {
    return this.#legs.map((l) => ({
      leg: l.leg,
      provider: l.provider,
      reference: l.reference,
      status: l.status,
      evidence: l.evidence,
      observedAt: l.observedAt,
    }));
  }

  /** Every check from every leg, flattened, tagged with its leg. */
  get checks(): readonly (KybCheck & { readonly leg: KybLegKind })[] {
    return this.#legs.flatMap((l) => l.checks.map((c) => ({ ...c, leg: l.leg })));
  }

  /**
   * Serialise. `status` and `evidence` are computed at call time, so a
   * serialised copy is a snapshot of a derivation and never a second source of
   * truth — `rehydrate()` ignores both fields on the way back in.
   */
  toJSON(): CompositeKybJson {
    return {
      referenceId: this.#referenceId,
      status: this.status,
      evidence: this.evidence,
      createdAt: this.#createdAt,
      legs: this.#legs,
    };
  }
}

// A frozen prototype means the `evidence` getter cannot be replaced wholesale
// either. Cheap, and it closes the last route that does not require patching
// this file.
Object.freeze(CompositeKybResult.prototype);

// ---------------------------------------------------------------------------
// 2. The provider
// ---------------------------------------------------------------------------

/**
 * Runs both legs and combines them.
 *
 * Legs run CONCURRENTLY, and a leg that throws does not abort the other. See
 * `failedLeg` for what an unavailable provider produces and why it is labelled
 * `simulated`.
 */
export class CompositeKybProvider {
  readonly name = 'composite-kyb';

  constructor(
    private readonly directorKyc: KybLegProvider,
    private readonly registry: KybLegProvider,
  ) {}

  /** Which adapter is wired to each leg. Read by the health report. */
  get wiring(): Record<KybLegKind, { readonly provider: string; readonly evidence: Evidence }> {
    return {
      director_kyc: { provider: this.directorKyc.name, evidence: this.directorKyc.evidence },
      business_registry: { provider: this.registry.name, evidence: this.registry.evidence },
    };
  }

  async begin(input: CreateKybVerificationInput): Promise<CompositeKybResult> {
    const [director, registryResult] = await Promise.all([
      attemptLeg('director_kyc', this.directorKyc, () => this.directorKyc.begin(input)),
      attemptLeg('business_registry', this.registry, () => this.registry.begin(input)),
    ]);
    return CompositeKybResult.of(input.referenceId, director, registryResult);
  }

  async refresh(referenceId: string, refs: KybReferences): Promise<CompositeKybResult> {
    const [director, registryResult] = await Promise.all([
      attemptLeg('director_kyc', this.directorKyc, () => this.directorKyc.refresh(refs.director)),
      attemptLeg('business_registry', this.registry, () => this.registry.refresh(refs.registry)),
    ]);
    return CompositeKybResult.of(referenceId, director, registryResult);
  }

  /** Re-read both legs of an existing composite, using its own citations. */
  async refreshFrom(previous: CompositeKybResult): Promise<CompositeKybResult> {
    const director = previous.directorLeg;
    const registryLeg = previous.registryLeg;
    if (!director || !registryLeg) {
      throw new Error('cannot refresh a composite that is missing a leg');
    }
    return this.refresh(previous.referenceId, {
      director: director.reference,
      registry: registryLeg.reference,
    });
  }
}

/**
 * Run one leg, converting a thrown provider error into a leg result rather than
 * letting it abort the other leg.
 */
async function attemptLeg(
  leg: KybLegKind,
  provider: KybLegProvider,
  call: () => Promise<KybLegResult>,
): Promise<KybLegResult> {
  try {
    return await call();
  } catch (error) {
    return failedLeg(leg, provider.name, error);
  }
}

/**
 * What an unavailable provider contributes.
 *
 * `status: 'pending'` — nothing was decided, so nothing may transact.
 *
 * `evidence: 'simulated'` — and this is the counter-intuitive one worth
 * defending. The provider did not answer; WE wrote this row. Labelling it
 * `live` would be claiming a third party said "pending" when no third party
 * said anything, which is precisely the lie this module exists to prevent. The
 * consequence is that a transient outage on either leg degrades the whole
 * composite to simulated — which is loud, correct, and self-healing, because
 * the next successful `refresh` recomputes both legs from scratch.
 */
export function failedLeg(leg: KybLegKind, provider: string, error: unknown): KybLegResult<'simulated'> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    leg,
    provider: `${provider}-unavailable`,
    reference: '',
    referenceId: null,
    status: 'pending',
    rawStatus: null,
    checks: [
      {
        name: 'provider_reachable',
        status: 'failed',
        reasons: [`${provider} did not answer: ${message}`],
      },
    ],
    hostedUrl: null,
    observedAt: new Date().toISOString(),
    evidence: 'simulated',
  };
}
