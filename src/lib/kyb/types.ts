/**
 * KYB / KYC vocabulary: the status lattice, the evidence label, the leg
 * interface every provider implements, and the one predicate that gates
 * transacting.
 *
 * No I/O, no environment, no network. Everything here is pure so the rules can
 * be tested without a key and read without a debugger.
 *
 * THE TWO INVARIANTS THIS FILE EXISTS TO STATE
 *
 *   1. STRICTEST WINS. A verification made of several legs is only as good as
 *      its worst leg. `strictestStatus` is a total order, not a heuristic.
 *   2. EVIDENCE DEGRADES. A result assembled from a simulated input is
 *      simulated, for ever, with no path back to "live". `DegradeEvidence` says
 *      so in the type system; `composite.ts` makes it impossible to construct a
 *      counterexample; `db/migrations/0005_kyb.sql` re-states it as a CHECK.
 *
 * Provider vocabulary is normalised INTO this file's four statuses. The raw
 * provider string is carried alongside on every leg (`rawStatus`) so nothing is
 * lost and the evidence pack can quote the provider verbatim.
 *
 * See ./README.md for the provider survey this is built on
 * (research/kyb/NOTES.md is the primary source).
 */

// ---------------------------------------------------------------------------
// 1. Evidence — is this a third party's answer, or one we manufactured?
// ---------------------------------------------------------------------------

/**
 * `live`      a third party we do not control produced this answer. For the
 *             director leg that means a real Persona sandbox inquiry; for the
 *             registry leg a real Stripe Connect test-mode account. Sandbox is
 *             still live in the sense that matters here: we did not decide it.
 * `simulated` WE produced this answer. Deterministic, reproducible, useful, and
 *             not admissible as verification of anything.
 *
 * There is deliberately no third value. "Partially live" is the state this
 * whole module exists to make unrepresentable.
 */
export type Evidence = 'live' | 'simulated';

/**
 * Type-level evidence degradation.
 *
 * `DegradeEvidence<'live', 'live'>` is `'live'`. EVERY other combination is
 * `'simulated'` — including the ones where only one leg was manufactured. A
 * composite whose leg types are statically known therefore cannot even be
 * *typed* as live unless both inputs were.
 *
 * When the legs are chosen at runtime (the factory picks per leg from the
 * environment) both parameters collapse to `Evidence` and this evaluates to
 * `'simulated' | 'live'` — which is why the type-level rule is not the only
 * defence. See `CompositeKybResult` in ./composite.ts for the value-level one.
 */
export type DegradeEvidence<A extends Evidence, B extends Evidence> = [A, B] extends
  ['live', 'live']
  ? 'live'
  : 'simulated';

/** The runtime half of `DegradeEvidence`, over any number of legs. */
export function degradeEvidence(legs: readonly Evidence[]): Evidence {
  return legs.every((e) => e === 'live') ? 'live' : 'simulated';
}

/** Human-facing label. The UI must render this next to any KYB status. */
export const EVIDENCE_LABEL: Record<Evidence, string> = {
  live: 'verified by a third party',
  simulated: 'SIMULATED — not verified by anyone',
};

// ---------------------------------------------------------------------------
// 2. The status lattice
// ---------------------------------------------------------------------------

/**
 * Four statuses, one total order:
 *
 *     rejected  >  needs_review  >  pending  >  approved
 *
 * Read it as "how much this blocks money": `approved` blocks nothing,
 * `rejected` blocks everything and will not resolve itself. Combining two legs
 * takes the MAXIMUM, so an approval can never dilute a decline.
 *
 * `approved` is the only status that permits transacting (see `canTransact`),
 * which means every mapping ambiguity below resolves the safe way by
 * construction: anything we are unsure about is not approved.
 */
export type KybStatus = 'approved' | 'pending' | 'needs_review' | 'rejected';

/**
 * Strictness rank. The numbers are ONLY meaningful relative to each other and
 * are duplicated, deliberately, as the declaration order of the `kyb_status`
 * enum in db/migrations/0005_kyb.sql — Postgres orders enums by declaration
 * order, which is what lets the migration express "strictest wins" as a CHECK
 * constraint with plain `>=` comparisons.
 */
export const KYB_STATUS_STRICTNESS: Record<KybStatus, number> = {
  approved: 0,
  pending: 1,
  needs_review: 2,
  rejected: 3,
};

/** Ascending strictness. Same order as the Postgres enum. */
export const KYB_STATUSES: readonly KybStatus[] = ['approved', 'pending', 'needs_review', 'rejected'];

/**
 * `Object.hasOwn`, not `in`: `'toString' in KYB_STATUS_STRICTNESS` is TRUE,
 * because `in` walks the prototype chain. A status column containing
 * `constructor` or `toString` must not narrow to a valid status.
 */
export function isKybStatus(value: unknown): value is KybStatus {
  return typeof value === 'string' && Object.hasOwn(KYB_STATUS_STRICTNESS, value);
}

/**
 * Narrow an untrusted string (a database column, a webhook field) to a status.
 * Returns null rather than guessing — callers fail closed on null.
 */
export function asKybStatus(value: unknown): KybStatus | null {
  return isKybStatus(value) ? value : null;
}

/** The stricter of two statuses. Associative and commutative: fold it freely. */
export function strictestStatus(a: KybStatus, b: KybStatus): KybStatus {
  return KYB_STATUS_STRICTNESS[a] >= KYB_STATUS_STRICTNESS[b] ? a : b;
}

/**
 * Fold a set of leg statuses. An EMPTY set is `pending`, never `approved`: a
 * verification nobody performed has not passed.
 */
export function strictestOf(statuses: readonly KybStatus[]): KybStatus {
  return statuses.reduce<KybStatus>(strictestStatus, statuses.length === 0 ? 'pending' : 'approved');
}

// ---------------------------------------------------------------------------
// 3. What a provider is asked, and what it answers
// ---------------------------------------------------------------------------

export interface KybAddress {
  readonly street1: string;
  readonly street2?: string | undefined;
  readonly city: string;
  /**
   * ISO 3166-2 subdivision. NOTE the provider split, which is a real trap:
   * Persona's Inquiries API wants the UNABBREVIATED US state ("California");
   * Stripe and Persona's KYB Transactions API want the abbreviation ("CA").
   * Each adapter formats this itself. Do not share a formatter.
   */
  readonly subdivision: string;
  readonly postalCode: string;
  /** 2-letter ISO country code, e.g. 'US'. */
  readonly countryCode: string;
}

/** A director, officer or beneficial owner. */
export interface KybPerson {
  readonly firstName: string;
  readonly lastName: string;
  readonly middleName?: string | undefined;
  /** YYYY-MM-DD. */
  readonly birthdate?: string | undefined;
  readonly emailAddress?: string | undefined;
  readonly phoneNumber?: string | undefined;
  readonly address?: KybAddress | undefined;
  /** 0-100. */
  readonly percentageOwnership?: number | undefined;
  /** Freeform: 'CEO', 'director', 'beneficial_owner'. */
  readonly association?: string | undefined;
  /**
   * SSN / national id. NEVER log this, never persist it here: `src/lib/log.ts`
   * redacts keys containing `ssn` and `tax_id`, which is a safety net and not
   * permission to pass it around.
   */
  readonly taxIdentificationNumber?: string | undefined;
}

export interface CreateKybVerificationInput {
  /** Our `business.id`. Round-trips back on the provider's webhooks. */
  readonly referenceId: string;
  readonly businessName: string;
  /** EIN. Formatting is the adapter's problem; pass it however you have it. */
  readonly taxIdentificationNumber: string;
  readonly registeredAddress: KybAddress;
  readonly physicalAddress?: KybAddress | undefined;
  /** The first entry is treated as the control person / representative. */
  readonly associatedPeople?: readonly KybPerson[] | undefined;
  /**
   * A Legal Entity Identifier the APPLICANT asserts is theirs, when they have
   * one. Twenty characters, ISO 17442.
   *
   * It is optional and it is not a formality: an asserted identifier is a
   * claim a registry can be asked about directly, so supplying one turns a
   * fuzzy name search into an exact lookup — and, when the identifier does not
   * exist, into a decline rather than a shrug. `src/lib/kyb/gleif.ts` treats
   * the two cases very differently and says why.
   */
  readonly lei?: string | undefined;
}

/** One named check inside a leg, with the provider's own reason strings. */
export interface KybCheck {
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'pending' | 'not_applicable';
  readonly reasons: readonly string[];
}

/**
 * TWO RESERVED CHECK NAMES, AND WHY THEY ARE A CONVENTION RATHER THAN COLUMNS.
 *
 * `kyb_verification_leg` (db/migrations/0005_kyb.sql) stores `checks` as jsonb
 * and has no column for a provider's error code or for a registry citation.
 * Adding two would mean a migration, and — worse — two more columns that a
 * later UPDATE could disagree with the evidence about. So both travel inside
 * the evidence itself, under fixed names, and are read back out with the two
 * functions below.
 *
 * `provider_outcome`   reasons[0] is the provider's OWN machine-readable code:
 *                      `document_unverified_other`, `entity_status_inactive`,
 *                      `not_in_lei_registry`. reasons[1..] are its own prose.
 * `registry_citation`  reasons[0] is a checkable citation — which authority,
 *                      which entry, at what corroboration level.
 *
 * A screen that renders "rejected" and a screen that renders "rejected,
 * because gleif-lei answered `entity_status_inactive` for LEI 2549…, cited
 * against the Delaware Secretary of State" are different products, and only
 * the second one can be audited by someone who does not trust us.
 */
export const KYB_PROVIDER_CODE_CHECK = 'provider_outcome';
export const KYB_CITATION_CHECK = 'registry_citation';

function firstReasonOf(checks: readonly KybCheck[], name: string): string | null {
  const found = checks.find((c) => c.name === name);
  const reason = found?.reasons[0];
  return typeof reason === 'string' && reason.trim() !== '' ? reason : null;
}

/** The provider's own code for this leg's answer, or null if it gave none. */
export function providerCodeFromChecks(checks: readonly KybCheck[]): string | null {
  return firstReasonOf(checks, KYB_PROVIDER_CODE_CHECK);
}

/** The registry citation for this leg, or null if the leg cites nothing. */
export function citationFromChecks(checks: readonly KybCheck[]): string | null {
  return firstReasonOf(checks, KYB_CITATION_CHECK);
}

/** The two halves of KYB. Persona answers the first, Stripe Connect the second. */
export type KybLegKind = 'director_kyc' | 'business_registry';

export const KYB_LEG_LABEL: Record<KybLegKind, string> = {
  director_kyc: 'director / control-person KYC',
  business_registry: 'business registry check',
};

/**
 * What one leg answered.
 *
 * Generic in its evidence label so a provider's TYPE can promise what its
 * implementation is allowed to say: `SimulatedRegistryProvider` is declared as
 * `KybLegProvider<'simulated'>`, so returning `evidence: 'live'` from it is a
 * compile error rather than a code-review catch.
 */
export interface KybLegResult<E extends Evidence = Evidence> {
  readonly leg: KybLegKind;
  /** Adapter name, e.g. 'persona-inquiry'. Cited in the evidence pack. */
  readonly provider: string;
  /** Provider-side id: `inq_…`, `acct_…`, `sim_…`. Cited in the evidence pack. */
  readonly reference: string;
  /** Our business id, when the provider gave it back. */
  readonly referenceId: string | null;
  readonly status: KybStatus;
  /** The provider's own status string, before normalisation. Never dropped. */
  readonly rawStatus: string | null;
  readonly checks: readonly KybCheck[];
  /** Where to send the human, when the provider hosts a flow. */
  readonly hostedUrl: string | null;
  /** ISO 8601. When the provider told us this. */
  readonly observedAt: string;
  readonly evidence: E;
}

/**
 * One leg of KYB.
 *
 * Note what is NOT here: signature verification. Inbound webhooks are
 * authenticated once, by the verifier registry in `src/lib/webhooks/inbox.ts`
 * (`personaVerifier`, `stripeVerifier`), and land in the inbox. A KYB adapter
 * receives an ALREADY-VERIFIED payload and maps it — see `legFromPersonaEvent`
 * and `legFromStripeAccountEvent`. Two implementations of a signature scheme is
 * one implementation too many.
 */
export interface KybLegProvider<E extends Evidence = Evidence> {
  readonly leg: KybLegKind;
  /** Stable adapter name recorded on every result. */
  readonly name: string;
  /** What this provider is able to produce. Not a runtime claim: a type. */
  readonly evidence: E;
  /** Start (or restart) verification for a business. */
  begin(input: CreateKybVerificationInput): Promise<KybLegResult<E>>;
  /** Re-read the provider's current answer for a reference id. */
  refresh(reference: string): Promise<KybLegResult<E>>;
}

/** A provider call failed. Never carries a key, a body, or a PII field. */
export class KybProviderError extends Error {
  override readonly name = 'KybProviderError';
  readonly provider: string;
  readonly status: number | null;
  constructor(provider: string, message: string, status: number | null = null) {
    super(message);
    this.provider = provider;
    this.status = status;
  }
}

/** Configuration is missing or wrong. Thrown at construction, not at call time. */
export class KybConfigError extends Error {
  override readonly name = 'KybConfigError';
  readonly missing: readonly string[];
  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.missing = missing;
  }
}

// ---------------------------------------------------------------------------
// 4. The gate: an unverified entity can look, but not transact
// ---------------------------------------------------------------------------

/**
 * The KYB state of one business, as read from the `business` table
 * (db/migrations/0005_kyb.sql).
 *
 * `status` and `evidence` are typed as `string | null`, not as the narrow
 * unions, ON PURPOSE. This is the boundary where untrusted data arrives — a
 * column written by an older deploy, a hand-edited row, a JSON body. Taking the
 * raw value forces the narrowing to happen HERE, where the failure is a
 * denial, instead of at a cast somewhere that would let an unrecognised string
 * through as "not rejected, so fine".
 */
export interface BusinessKybState {
  readonly businessId: string;
  readonly status: string | null;
  readonly evidence: string | null;
  /** ISO 8601, or null while undecided. */
  readonly decidedAt: string | null;
}

/**
 * Read a `v_business_kyb` row into the gate's input.
 *
 * The column names live here, once, so no call site hand-rolls the mapping and
 * reaches for a cast while doing it. Everything stays a raw string: narrowing
 * is `canTransact`'s job, and doing it here would move the fail-closed decision
 * away from the place that denies.
 */
export function businessKybStateFromRow(row: Record<string, unknown>): BusinessKybState {
  const decidedAt = row['decided_at'];
  return {
    businessId: String(row['business_id'] ?? ''),
    status: typeof row['kyb_status'] === 'string' ? row['kyb_status'] : null,
    evidence: typeof row['kyb_evidence'] === 'string' ? row['kyb_evidence'] : null,
    decidedAt:
      decidedAt instanceof Date
        ? decidedAt.toISOString()
        : typeof decidedAt === 'string'
          ? decidedAt
          : null,
  };
}

export interface TransactPolicy {
  /**
   * Refuse to transact on simulated evidence.
   *
   * Default FALSE, and that default is a deliberate, stated choice: this
   * deployment runs without provider keys until they exist, and a gate that
   * denies everything teaches people to bypass the gate. What it never does is
   * hide the fact — an allowed decision always carries `evidence`, and a
   * caller that renders a green tick without reading it has ignored a value it
   * was handed. Set this to true in any deployment that touches real money.
   */
  readonly requireLiveEvidence: boolean;
}

export const DEFAULT_TRANSACT_POLICY: TransactPolicy = { requireLiveEvidence: false };

export type TransactDenialCode =
  /** No KYB row at all: the business was created and nothing was started. */
  | 'KYB_NOT_STARTED'
  /** A provider has not answered yet. Retryable by waiting. */
  | 'KYB_PENDING'
  /** A human has to look at it. Retryable by a person, not by the caller. */
  | 'KYB_NEEDS_REVIEW'
  /** Terminal. Not retryable. */
  | 'KYB_REJECTED'
  /** Verified, but not by anyone real, and this deployment requires real. */
  | 'KYB_EVIDENCE_SIMULATED'
  /** The stored state is not a value this build understands. Fail closed. */
  | 'KYB_STATE_UNREADABLE';

/**
 * The answer to "may this business move money?".
 *
 * Note there is no boolean anywhere in this type. A denial that cannot say why
 * becomes a support ticket, and a `false` at a call site becomes a 500 with no
 * message. `code` is for branching, `message` is safe to show a user, and
 * `status`/`evidence` are what the compliance view renders.
 */
export type TransactDecision =
  | {
      readonly allowed: true;
      readonly businessId: string;
      readonly status: 'approved';
      readonly evidence: Evidence;
      readonly decidedAt: string | null;
    }
  | {
      readonly allowed: false;
      readonly businessId: string;
      readonly code: TransactDenialCode;
      readonly message: string;
      readonly status: KybStatus | null;
      readonly evidence: Evidence | null;
    };

/**
 * THE PREDICATE. Every code path that is about to move money calls this one
 * function, and there is deliberately no boolean-returning sibling to reach for
 * instead.
 *
 *   const gate = canTransact(state);
 *   if (!gate.allowed) return fail(gate.code, gate.message);
 *
 * Fails closed on every input it does not understand: a null row, an unknown
 * status string, an unknown evidence string. The only path to `allowed: true`
 * is a status that reads exactly `approved` and an evidence label this build
 * recognises.
 */
export function canTransact(
  state: BusinessKybState | null | undefined,
  policy: TransactPolicy = DEFAULT_TRANSACT_POLICY,
): TransactDecision {
  if (!state) {
    return {
      allowed: false,
      businessId: '(unknown)',
      code: 'KYB_NOT_STARTED',
      message: 'This business has no verification on file. It can be viewed, but not transacted on.',
      status: null,
      evidence: null,
    };
  }

  const status = asKybStatus(state.status);
  const evidence = asEvidence(state.evidence);

  if (state.status === null) {
    return {
      allowed: false,
      businessId: state.businessId,
      code: 'KYB_NOT_STARTED',
      message: 'Verification has not been started for this business.',
      status: null,
      evidence,
    };
  }
  if (status === null) {
    // An unrecognised status is not "probably fine". It is a deploy skew or a
    // hand-edited row, and the safe reading of a value we cannot parse is no.
    return {
      allowed: false,
      businessId: state.businessId,
      code: 'KYB_STATE_UNREADABLE',
      message: 'The stored verification state is not readable by this build; transacting is blocked.',
      status: null,
      evidence,
    };
  }

  switch (status) {
    case 'rejected':
      return {
        allowed: false,
        businessId: state.businessId,
        code: 'KYB_REJECTED',
        message: 'Verification was declined. This business cannot transact.',
        status,
        evidence,
      };
    case 'needs_review':
      return {
        allowed: false,
        businessId: state.businessId,
        code: 'KYB_NEEDS_REVIEW',
        message: 'Verification is with a reviewer. This business can be viewed, but not transacted on.',
        status,
        evidence,
      };
    case 'pending':
      return {
        allowed: false,
        businessId: state.businessId,
        code: 'KYB_PENDING',
        message: 'Verification is still in progress. This business can be viewed, but not transacted on.',
        status,
        evidence,
      };
    case 'approved':
      break;
  }

  if (evidence === null) {
    return {
      allowed: false,
      businessId: state.businessId,
      code: 'KYB_STATE_UNREADABLE',
      message: 'Verification is approved but its evidence label is unreadable; transacting is blocked.',
      status,
      evidence: null,
    };
  }
  if (policy.requireLiveEvidence && evidence === 'simulated') {
    return {
      allowed: false,
      businessId: state.businessId,
      code: 'KYB_EVIDENCE_SIMULATED',
      message:
        'Verification passed on simulated evidence. This deployment requires a third-party verification before transacting.',
      status,
      evidence,
    };
  }

  return {
    allowed: true,
    businessId: state.businessId,
    status: 'approved',
    evidence,
    decidedAt: state.decidedAt,
  };
}

/** Thrown by `assertCanTransact`. Carries the decision, so nothing is lost. */
export class KybGateError extends Error {
  override readonly name = 'KybGateError';
  readonly decision: Extract<TransactDecision, { allowed: false }>;
  constructor(decision: Extract<TransactDecision, { allowed: false }>) {
    super(`${decision.code}: ${decision.message}`);
    this.decision = decision;
  }
}

/**
 * Imperative form, for call sites in the middle of a transaction where an
 * early return is not available. Same rules, same reasons, louder failure.
 */
export function assertCanTransact(
  state: BusinessKybState | null | undefined,
  policy: TransactPolicy = DEFAULT_TRANSACT_POLICY,
): Extract<TransactDecision, { allowed: true }> {
  const decision = canTransact(state, policy);
  if (!decision.allowed) throw new KybGateError(decision);
  return decision;
}

export function isEvidence(value: unknown): value is Evidence {
  return value === 'live' || value === 'simulated';
}

export function asEvidence(value: unknown): Evidence | null {
  return isEvidence(value) ? value : null;
}
