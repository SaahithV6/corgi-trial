/**
 * The business-registry leg, answered by a real registry: GLEIF.
 *
 * ===========================================================================
 * WHAT THIS IS, PRECISELY, AND WHAT IT IS NOT.
 *
 * `api.gleif.org` is the Global Legal Entity Identifier Foundation's public
 * API. It needs no key, no account and no header; the data is published CC0.
 * Every record in it was validated by an accredited Local Operating Unit
 * against a government company register, and the record says WHICH register:
 * `entity.registeredAt.id` is a registration-authority code that dereferences
 * to a named authority and jurisdiction, and `entity.registeredAs` is the
 * entity's number in that register. So a hit here is not a badge — it is a
 * citation a reviewer can follow to a Secretary of State's own search page.
 *
 * IT IS NOT A UNIVERSAL COMPANY REGISTRY, AND THAT ASYMMETRY IS THE DESIGN.
 * GLEIF holds roughly 3.4 million records, about 360,000 of them US, against
 * tens of millions of US entities: its population is entities that were
 * required to obtain an LEI to participate in financial markets. A real,
 * active, perfectly ordinary corporation can be absent. Therefore:
 *
 *     A HIT IS STRONG AUTHORITATIVE EVIDENCE.
 *     A MISS IS EVIDENCE OF NOTHING.
 *
 * A miss is `needs_review` — never `approved`, and never `rejected`. Letting a
 * miss approve would build something strictly worse than the labelled
 * simulator it replaces, because it would wear a live evidence label while
 * asserting a fact nobody checked.
 *
 * THE ONE CASE WHERE ABSENCE *IS* EVIDENCE. If the applicant ASSERTED an LEI
 * and GLEIF answers 404 for it, they have claimed an identifier that does not
 * exist. That is a decline. The difference between "we could not find you" and
 * "the identifier you gave us is not real" is the difference between
 * `needs_review` and `rejected`, and it is the whole reason `lei` is a field
 * on `CreateKybVerificationInput`.
 * ===========================================================================
 *
 * MATCHING BY NAME IS A TRAP AND IS TREATED AS ONE.
 *
 * `filter[entity.legalName]` is a fuzzy, OR-over-tokens search, and it is the
 * single most dangerous thing in this API. Measured on 2026-09-10:
 *
 *   filter[entity.legalName]=Stripe, Inc.            -> total 76,770,
 *        data[0] = "ACCENT STRIPE, INC." — it matched on the token "INC"
 *   filter[entity.legalName]=Ridgeline Robotics, Inc.
 *        + filter[entity.legalAddress.country]=US    -> total 43,182,
 *        data[0] = "Pruvations Inc 401K Inc" — same token, same trap
 *
 * A build that trusted `data[0]` would cheerfully approve a bakery as an
 * aerospace firm, on a page that says "live third-party registry". So:
 *
 *   1. The PRIMARY candidate generator is `/api/v1/autocompletions?
 *      field=fulltext`, which is phrase-scoped rather than OR-over-tokens.
 *      Measured: `q=Stripe, Inc.` returns "ACCENT STRIPE, INC.",
 *      "STRIPE GLOBAL HOLDINGS INC." and "STRIPE, INC." — three, not 76,770 —
 *      and `q=Ridgeline Robotics, Inc.` returns `data: []`, a clean nothing.
 *   2. The fuzzy filter runs anyway, CONCURRENTLY, as a second generator,
 *      because it reaches records the autocompleter's index does not. Its
 *      `meta.pagination.total` is carried into the leg's reasons so the miss
 *      says "43,182 loose token matches, top 25 examined, none of them this
 *      company" rather than implying 25 was the whole search space.
 *   3. NEITHER IS TRUSTED. Every candidate's `legalName` and `otherNames` are
 *      re-verified against the applicant's name in OUR code, under a
 *      normalisation written down and tested here. No exact normalised match,
 *      no match at all. That last step is the one that has to hold even if
 *      GLEIF changes its ranking tomorrow.
 *
 * The `otherNames` half of step 3 is not decoration: LEI 549300CLHGIPTCYHQ143
 * is `STRIPE, LLC` with a PREVIOUS_LEGAL_NAME of `STRIPE, INC.`, Delaware
 * Division of Corporations entry 4675506. An applicant who gives the older name
 * is the same company, and a matcher that only read `legalName` would miss it.
 *
 * MEASURED, against the live API, on 2026-09-10:
 *
 *   GET /api/v1/lei-records/HWUPKR0MPOU8FGXBT394   -> 200  Apple Inc., ACTIVE,
 *        ISSUED, FULLY_CORROBORATED, jurisdiction US-CA, registeredAt RA000598,
 *        registeredAs 806592, otherNames ["Apple Computer, Inc."]
 *   GET /api/v1/registration-authorities/RA000598  -> 200
 *        internationalOrganizationName "Secretary of State", jurisdiction
 *        California / United States of America, https://businesssearch.sos.ca.gov/
 *   GET /api/v1/registration-authorities/RA000602  -> 200  "Division of
 *        Corporations, Department of State", Delaware, https://corp.delaware.gov/
 *   GET /api/v1/lei-records/254900ZT6ZFUC887FB87   -> 200  RESILIENCE PARENT,
 *        LLC — entity INACTIVE, registration RETIRED, successorEntity
 *        "POWER GRID COMPONENTS, INC."
 *   GET /api/v1/lei-records/5299000RS1SH8F7PJ323   -> 200  LifeX 2028 Income
 *        Bucket ETF — entity ACTIVE, registration LAPSED (203,636 US records
 *        are in this state: an unrenewed LEI says nothing about the company)
 *   GET /api/v1/lei-records/98450077CAFCB7A59084   -> 200  FINDTAPE.COM LLC —
 *        ACTIVE, ISSUED, but PARTIALLY_CORROBORATED
 *   GET /api/v1/lei-records/ZZZZZZZZZZZZZZZZZZZZ   -> 404. The body happens to
 *        be JSON today (`{"errors":[{"status":"404",…}]}`) and has been an HTML
 *        error page before now, which is exactly why this module branches on
 *        the STATUS CODE and never on anything parsed out of the body.
 *   GET /api/v1/lei-records?filter[entity.registeredAs]=806592
 *        &filter[entity.legalAddress.country]=US  -> 200  total 1, Apple Inc.
 *        (the exact reverse lookup: a register entry number is not a token, so
 *        it does not fuzz)
 *   COVERAGE: total 3,426,836 records; 360,275 with a US legal address.
 *   LATENCY: five sequential record reads, 0.60–0.68 s each, no throttling.
 *
 * NO SIGNATURE VERIFICATION LIVES HERE and none may be added: GLEIF is a read
 * API with no callbacks. Nothing in this file writes anything anywhere.
 */

import {
  KybProviderError,
  KYB_CITATION_CHECK,
  KYB_PROVIDER_CODE_CHECK,
  strictestOf,
  type CreateKybVerificationInput,
  type KybCheck,
  type KybLegProvider,
  type KybLegResult,
  type KybStatus,
} from './types';

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

export const GLEIF_DEFAULT_BASE_URL = 'https://api.gleif.org';

export const GLEIF_PROVIDER_NAME = 'gleif-lei';

/**
 * ===========================================================================
 * GLEIF IS A SUBSTITUTION, AND EVERY SURFACE MUST SAY SO.
 *
 * The brief names three providers for the KYB slot — Persona KYB, Middesk,
 * Sumsub KYB — and marks the slot **must be live**. GLEIF is none of them.
 * Presenting it as though it satisfied that list would be exactly the dressed-up
 * claim this whole module exists to prevent, so the substitution is stated in
 * the same breath as the provider name, everywhere: here, in the wiring panel,
 * on every entity card, and in docs/KYB.md.
 *
 * WHY ALL THREE NAMED OPTIONS ARE SHUT, measured rather than assumed:
 * Persona's KYB guide opens by telling you to contact their team, and signup
 * needs a business email this build does not have; Middesk and Sumsub KYB are
 * both behind a sales conversation. Stripe Connect's company verification was
 * the fourth candidate and was gated behind platform onboarding (DECISION 017).
 *
 * NOTE THE SPLIT WITH THE OTHER LEG. The director leg needs no such apology:
 * Stripe Identity is on the brief's own KYC identity menu (Persona, Sumsub,
 * Stripe Identity, Onfido). Director KYC is COMPLIANT. Only the registry half
 * is substituted.
 * ===========================================================================
 */
export const GLEIF_LEG_REASON =
  'SUBSTITUTE for the brief\'s named KYB vendors (Persona KYB, Middesk, Sumsub KYB), all three of which are gated behind a sales conversation — measured, not assumed. GLEIF (api.gleif.org) is the Global LEI index: a real third-party registry, queried live, no key and no account, CC0 data, every record validated by an accredited LOU against a named government company register. A hit cites that register; a MISS is needs_review and never an approval.';

/**
 * WHAT A GLEIF HIT DOES NOT PROVE.
 *
 * Printed on the screen next to the leg rather than left in a file nobody
 * opens, because it is the first thing a hostile reviewer should be told rather
 * than the first thing they get to discover. A KYB vendor would answer most of
 * these; GLEIF answers exactly one question — does this legal entity exist in
 * the LEI registry, and what does the underlying register say about it.
 */
export const GLEIF_LIMITS: readonly string[] = [
  'it does NOT prove the applicant controls the entity — no authority, no signatory check',
  'it does NOT check beneficial ownership or the ownership tree',
  'it does NOT screen sanctions, PEP or adverse media',
  'it does NOT verify an EIN or any tax identifier',
  'its population is financial-market participants: 360,275 US records against tens of millions of US entities, so a real active company can be absent — GRACE SEAFOOD CORP. (NY DOS 4072354) returns total 0',
];

/**
 * How a miss must read on screen. Not a failure, not a shrug — a non-answer,
 * said plainly, in the words the coverage fact actually supports.
 */
export const GLEIF_MISS_HEADLINE =
  'not present in the LEI registry — this is not evidence the business does not exist';

export interface GleifConfig {
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Test seam. Every test injects this; nothing in the suite calls GLEIF. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** Sent as `User-Agent`. GLEIF does not require one; being identifiable is manners. */
  readonly userAgent?: string | undefined;
}

export const GLEIF_DEFAULT_USER_AGENT = 'corgi-trial-kyb/1.0 (+https://corgi-trial-psi.vercel.app)';

/**
 * How many autocompletion suggestions may be turned into a record read.
 *
 * The cap applies AFTER `namesMatch` has already filtered the suggestions, so
 * reaching it means several distinct LEIs share one normalised legal name —
 * which happens, and which is a reason to look at all of them rather than to
 * pick one. It exists to bound the request count, not to choose a winner.
 */
export const GLEIF_MAX_AUTOCOMPLETE_READS = 5;

/**
 * How deep into the fuzzy filter's ranking this build is willing to look.
 *
 * Deliberately small. The filter returns tens of thousands of loose token
 * matches and the ranking is not ours; reading 25 or reading 250 changes
 * nothing about precision, because `nameMatchesRecord` decides either way. The
 * `total` is reported instead, which is the honest thing a page size cannot be.
 */
export const GLEIF_FUZZY_PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// 2. The vocabulary GLEIF answers in, mapped to ours
// ---------------------------------------------------------------------------

/**
 * Our own machine-readable code for each outcome, carried on the leg under the
 * `provider_outcome` check so the screen can print it and a reviewer can grep
 * for it. Each one names the GLEIF field it was read from.
 */
export const GLEIF_CODES = {
  /** entity.status ACTIVE, registration.status ISSUED, FULLY_CORROBORATED. */
  matchActiveIssued: 'lei_active_issued',
  /** entity.status INACTIVE — the register says this entity no longer trades. */
  entityInactive: 'entity_status_inactive',
  /** registration.status RETIRED or ANNULLED — the LEI itself was withdrawn. */
  registrationWithdrawn: 'lei_registration_withdrawn',
  /** registration.status LAPSED — nobody renewed it. Says nothing about the company. */
  registrationLapsed: 'lei_registration_lapsed',
  /** corroborationLevel below FULLY_CORROBORATED — the LOU did not fully verify it. */
  partiallyCorroborated: 'lei_not_fully_corroborated',
  /** A status string this build has never seen. Held for a human. */
  unrecognised: 'lei_status_not_recognised',
  /** No record for this name. NEVER an approval and NEVER a decline. */
  notInRegistry: 'not_in_lei_registry',
  /** The applicant asserted an LEI and GLEIF answered 404 for it. */
  assertedLeiNotFound: 'asserted_lei_not_found',
  /** Candidates came back, none of whose names actually matched. */
  nameMismatch: 'lei_name_mismatch',
  /** The name matched, but the record is registered in another country. */
  jurisdictionMismatch: 'lei_jurisdiction_mismatch',
} as const;

/** `entity.status` values GLEIF publishes. Anything else is held for review. */
const ENTITY_STATUS: Readonly<Record<string, KybStatus>> = {
  ACTIVE: 'approved',
  INACTIVE: 'rejected',
  NULL: 'needs_review',
};

/** `registration.status` values GLEIF publishes. */
const REGISTRATION_STATUS: Readonly<Record<string, KybStatus>> = {
  ISSUED: 'approved',
  LAPSED: 'needs_review',
  PENDING_TRANSFER: 'needs_review',
  PENDING_ARCHIVAL: 'needs_review',
  PENDING_VALIDATION: 'needs_review',
  DUPLICATE: 'needs_review',
  MERGED: 'needs_review',
  RETIRED: 'rejected',
  ANNULLED: 'rejected',
  CANCELLED: 'rejected',
  TRANSFERRED: 'needs_review',
};

/**
 * `Object.hasOwn`, not a bare index, for the reason stated three times in this
 * codebase already: `MAP['toString']` walks the prototype chain and returns a
 * FUNCTION, which `?? 'needs_review'` would pass straight through as a status.
 * A registry's status field is untrusted input like any other.
 */
function lookupStatus(map: Readonly<Record<string, KybStatus>>, raw: string | null): KybStatus | null {
  if (raw === null) return null;
  if (!Object.hasOwn(map, raw)) return null;
  return map[raw] ?? null;
}

// ---------------------------------------------------------------------------
// 3. Name normalisation — the guard against the fuzzy-match trap
// ---------------------------------------------------------------------------

/**
 * Fold a legal name to a comparison key.
 *
 * Deliberately conservative: case, punctuation, diacritics and runs of
 * whitespace are removed, and NOTHING ELSE IS. In particular the legal-form
 * suffix is kept, because "Ridgeline Robotics, Inc." and "Ridgeline Robotics
 * LLC" are different legal entities and a matcher that equates them is a
 * matcher that approves the wrong company.
 *
 * The one liberty taken is `&` -> `and`, which is an orthographic variant of
 * the same word rather than a different name — "Kettle & Crumb" and "Kettle
 * and Crumb" are the same entity in every register that has an opinion.
 */
export function normaliseEntityName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[\u00d8\u0152\u00c6\u00c5\u00d0\u00de\u0141]/g, (c) => NON_DECOMPOSING[c] ?? c)
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

/**
 * Latin letters NFKD does not take apart, because they are letters in their own
 * right rather than a base plus an accent.
 *
 * Without this, `S\u00f8rensen` folds to `S RENSEN` — the `\u00f8` becomes a
 * separator — and a Danish company that spells its own name correctly stops
 * matching the register's transliteration of it. The cost of being wrong here is
 * RECALL, never precision: an over-eager fold can only ever equate two spellings
 * of the same word, and every candidate is still checked against the applicant's
 * name in full afterwards. Written as escapes rather than literals so a
 * mangled encoding somewhere in the toolchain cannot silently empty the class.
 */
const NON_DECOMPOSING: Readonly<Record<string, string>> = {
  '\u00d8': 'O',
  '\u0152': 'OE',
  '\u00c6': 'AE',
  '\u00c5': 'A',
  '\u00d0': 'D',
  '\u00de': 'TH',
  '\u0141': 'L',
};

/** Exact equality under `normaliseEntityName`, and nothing looser. */
export function namesMatch(a: string, b: string): boolean {
  const left = normaliseEntityName(a);
  return left !== '' && left === normaliseEntityName(b);
}

/**
 * ISO 17442: 20 characters, upper-case alphanumeric. Checked so a stray EIN or
 * a pasted URL is treated as "no LEI supplied" rather than sent to the API as
 * a path segment.
 */
export function isLeiFormat(value: string): boolean {
  return /^[A-Z0-9]{20}$/.test(value.trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// 4. The record, and the verdict it produces
// ---------------------------------------------------------------------------

export interface GleifRecordView {
  readonly lei: string;
  readonly legalName: string;
  readonly otherNames: readonly string[];
  readonly entityStatus: string | null;
  readonly registrationStatus: string | null;
  readonly corroborationLevel: string | null;
  readonly jurisdiction: string | null;
  readonly country: string | null;
  /** Registration-authority code, e.g. `RA000598`. Dereferenceable. */
  readonly registeredAtId: string | null;
  /** The entity's number in that authority's register, e.g. `806592`. */
  readonly registeredAs: string | null;
  readonly lastUpdateDate: string | null;
  readonly successorName: string | null;
}

export interface GleifVerdict {
  readonly status: KybStatus;
  readonly code: string;
  readonly reasons: readonly string[];
}

/**
 * What a name search actually looked at. Carried into the leg's reasons so a
 * miss describes its own search space instead of just reporting emptiness.
 */
export interface GleifSearch {
  readonly candidates: readonly GleifRecordView[];
  /** How many suggestions the autocompleter offered, before name-matching. */
  readonly autocompleteSuggestions: number;
  /** How many of those survived `namesMatch` and were read as records. */
  readonly autocompleteHits: number;
  /** `meta.pagination.total` from the fuzzy filter, or null if it failed. */
  readonly fuzzyTotal: number | null;
  /** How many of those this build actually examined. */
  readonly fuzzyExamined: number;
}

/**
 * The miss, in the words the search itself supports.
 *
 * Exported and pure so the tests can assert on the sentences rather than on a
 * network call — these strings end up in front of a compliance reviewer, and a
 * reason that overstated what was searched would be the same class of mistake
 * as an evidence label that overstated who answered.
 */
export function describeSearch(name: string, search: GleifSearch): readonly string[] {
  const quoted = JSON.stringify(name);
  const lines: string[] = [];

  lines.push(
    search.autocompleteSuggestions === 0
      ? `GET /api/v1/autocompletions?field=fulltext&q=${name} returned no suggestions at all`
      : `GET /api/v1/autocompletions?field=fulltext returned ${search.autocompleteSuggestions} suggestion(s) for ${quoted}, of which ${search.autocompleteHits} matched the applicant's name exactly under this build's normalisation`,
  );

  if (search.fuzzyTotal === null) {
    lines.push(
      'the fuzzy filter[entity.legalName] search did not answer, so only the autocompletion index was consulted',
    );
  } else if (search.fuzzyTotal === 0) {
    lines.push(
      'filter[entity.legalName] + filter[entity.legalAddress.country]=US also returned nothing — not even a loose token match',
    );
  } else {
    lines.push(
      `filter[entity.legalName] + filter[entity.legalAddress.country]=US reported ${search.fuzzyTotal.toLocaleString('en-US')} loose token match(es). That filter is an OR over tokens — "Inc" on its own matches tens of thousands of companies — so it is a candidate generator and never an answer; this build read the top ${search.fuzzyExamined} in full and re-verified every name itself.`,
    );
  }

  if (search.candidates.length > 0) {
    lines.push(
      `${search.candidates.length} candidate record(s) were read in full and none of their legal or previous names equals ${quoted}; a near-miss is not a match, so none of them was used`,
    );
  }

  lines.push(
    'GLEIF holds 3,426,836 records, 360,275 of them US, against tens of millions of US entities: its population is financial-market participants. A MISS is evidence of nothing and can never be an approval.',
  );
  return lines;
}

/**
 * The verdict, as a fold of independent signals rather than an if-chain.
 *
 * Every signal contributes a status and the STRICTEST wins, which is the same
 * rule the composite applies across legs, applied here across fields. It
 * matters: a record can be `entity.status: ACTIVE` with
 * `registration.status: RETIRED`, and a chain that checked entity status first
 * and returned would approve a withdrawn registration.
 *
 * `code` names the strictest contributing signal, because that is the one a
 * human is being asked about.
 */
export function gleifRecordToVerdict(
  record: GleifRecordView,
  expectedCountry: string | null = null,
): GleifVerdict {
  const signals: { status: KybStatus; code: string; reason: string }[] = [];

  /**
   * THE CROSS-BORDER NEAR-MISS, WHICH IS THE ONE THE NAME CHECK CANNOT CATCH.
   *
   * Measured: searching the name "Apple Computer, Inc." resolves to LEI
   * 549300G81RQKP7XW2N18 — an ACTIVE, ISSUED, FULLY_CORROBORATED record whose
   * name matches exactly and which is registered at the Companies Registration
   * Office in IRELAND, entry 76941. Every other signal on that record says
   * approve. It is not the US company an applicant to a US business account
   * means, and nothing in `namesMatch` could ever tell you so, because the
   * names are identical.
   *
   * The autocompletion generator carries no country filter (the endpoint has
   * no parameter for one), so this is where the constraint has to live. It is
   * `needs_review` rather than a decline: a US applicant CAN be the control
   * person of a foreign entity, and that is a question for a human.
   */
  // `typeof`, not `!== null`: this value crosses from a form and from a
  // `CreateKybVerificationInput` whose address fields are optional at runtime
  // however they are typed, and `undefined.toUpperCase()` inside a KYB decision
  // is a 500 where a `needs_review` belonged.
  const wanted = typeof expectedCountry === 'string' ? expectedCountry.trim().toUpperCase() : '';
  if (wanted !== '' && record.country !== null && record.country.toUpperCase() !== wanted) {
    signals.push({
      status: 'needs_review',
      code: GLEIF_CODES.jurisdictionMismatch,
      reason: `the name matches, but GLEIF registers this entity in ${record.country}${
        record.jurisdiction === null ? '' : ` (jurisdiction ${record.jurisdiction})`
      } and the application is for a ${wanted} business — an identical legal name in another country is a different company until a human says otherwise`,
    });
  }

  const entity = lookupStatus(ENTITY_STATUS, record.entityStatus);
  if (entity === null) {
    signals.push({
      status: 'needs_review',
      code: GLEIF_CODES.unrecognised,
      reason: `entity.status ${record.entityStatus ?? '(absent)'} is not a value this build recognises; held for review`,
    });
  } else if (entity !== 'approved') {
    signals.push({
      status: entity,
      code: GLEIF_CODES.entityInactive,
      reason: `entity.status is ${record.entityStatus ?? '(absent)'}${
        record.successorName === null ? '' : `; GLEIF names a successor entity: ${record.successorName}`
      }`,
    });
  }

  const registration = lookupStatus(REGISTRATION_STATUS, record.registrationStatus);
  if (registration === null) {
    signals.push({
      status: 'needs_review',
      code: GLEIF_CODES.unrecognised,
      reason: `registration.status ${record.registrationStatus ?? '(absent)'} is not a value this build recognises; held for review`,
    });
  } else if (registration === 'rejected') {
    signals.push({
      status: 'rejected',
      code: GLEIF_CODES.registrationWithdrawn,
      reason: `registration.status is ${record.registrationStatus ?? '(absent)'} — the LEI registration was withdrawn`,
    });
  } else if (registration !== 'approved') {
    signals.push({
      status: registration,
      code: GLEIF_CODES.registrationLapsed,
      reason: `registration.status is ${record.registrationStatus ?? '(absent)'} — the LEI was not renewed, which is a statement about the registration and not about the company`,
    });
  }

  if (record.corroborationLevel !== 'FULLY_CORROBORATED') {
    signals.push({
      status: 'needs_review',
      code: GLEIF_CODES.partiallyCorroborated,
      reason: `registration.corroborationLevel is ${record.corroborationLevel ?? '(absent)'}, not FULLY_CORROBORATED — the LOU did not fully validate this record against the register`,
    });
  }

  if (signals.length === 0) {
    return {
      status: 'approved',
      code: GLEIF_CODES.matchActiveIssued,
      reasons: [
        `entity.status ACTIVE, registration.status ISSUED, corroborationLevel FULLY_CORROBORATED for LEI ${record.lei}`,
      ],
    };
  }

  const status = strictestOf(signals.map((s) => s.status));
  const strictest = signals.find((s) => s.status === status);
  return {
    status,
    code: strictest?.code ?? GLEIF_CODES.unrecognised,
    reasons: signals.map((s) => s.reason),
  };
}

// ---------------------------------------------------------------------------
// 5. References — what goes in `provider_reference`, so a refresh can repeat
// ---------------------------------------------------------------------------

/**
 * A leg's reference has to be enough to re-ask the same question later, and
 * `kyb_verification_leg.provider_reference` is the only thing carried forward.
 * Three shapes, and the prefix says which:
 *
 *   `HWUPKR0MPOU8FGXBT394`     a resolved LEI. Refresh re-reads that record.
 *   `gleif.notfound.<LEI>`     an asserted LEI GLEIF answered 404 for. Refresh
 *                              asks again, because a registration can appear.
 *   `gleif.nomatch.<name>`     a name search that matched nothing. Refresh
 *                              re-runs the search.
 *
 * None of them may start `sim.` — the migration's `kyb_leg_simulated_reference`
 * CHECK refuses a live row carrying one, which is exactly the protection we
 * want and exactly why these are prefixed `gleif.` instead.
 */
export const GLEIF_NOT_FOUND_PREFIX = 'gleif.notfound.';
export const GLEIF_NO_MATCH_PREFIX = 'gleif.nomatch.';

export type GleifQuery =
  | { readonly kind: 'lei'; readonly lei: string }
  | { readonly kind: 'name'; readonly name: string };

/** Decode a stored reference back into the question that produced it. */
export function decodeGleifReference(reference: string): GleifQuery | null {
  const trimmed = reference.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith(GLEIF_NOT_FOUND_PREFIX)) {
    const lei = trimmed.slice(GLEIF_NOT_FOUND_PREFIX.length);
    return isLeiFormat(lei) ? { kind: 'lei', lei: lei.toUpperCase() } : null;
  }
  if (trimmed.startsWith(GLEIF_NO_MATCH_PREFIX)) {
    const name = trimmed.slice(GLEIF_NO_MATCH_PREFIX.length);
    return name === '' ? null : { kind: 'name', name };
  }
  return isLeiFormat(trimmed) ? { kind: 'lei', lei: trimmed.toUpperCase() } : null;
}

// ---------------------------------------------------------------------------
// 6. The adapter
// ---------------------------------------------------------------------------

/**
 * Declared `KybLegProvider<'live'>`, which is a promise the type system holds
 * it to: nothing in this class can return `evidence: 'simulated'`.
 *
 * A GLEIF answer is `live` EVEN WHEN IT IS "no record". A third party we do not
 * control was asked and answered; that the answer is unhelpful does not make it
 * ours. The honesty is carried by the STATUS — `needs_review` — and not by
 * quietly relabelling the evidence.
 */
export class GleifRegistryProvider implements KybLegProvider<'live'> {
  readonly leg = 'business_registry' as const;
  readonly name = GLEIF_PROVIDER_NAME;
  readonly evidence = 'live' as const;

  constructor(private readonly cfg: GleifConfig = {}) {}

  async begin(input: CreateKybVerificationInput): Promise<KybLegResult<'live'>> {
    const asserted = input.lei?.trim().toUpperCase() ?? '';
    const query: GleifQuery =
      asserted !== '' && isLeiFormat(asserted)
        ? { kind: 'lei', lei: asserted }
        : { kind: 'name', name: input.businessName };
    return this.answer(
      query,
      input.businessName,
      input.referenceId,
      input.registeredAddress.countryCode,
    );
  }

  /**
   * Re-ask the same question. A GET against a read-only public index creates
   * nothing and is safe to repeat as often as anyone likes.
   *
   * The applicant's name is not stored on the leg row, so a `gleif.nomatch.`
   * reference carries it — which is why the encoder puts it there rather than
   * hashing it.
   */
  async refresh(reference: string): Promise<KybLegResult<'live'>> {
    const query = decodeGleifReference(reference);
    if (query === null) {
      throw new KybProviderError(
        this.name,
        `cannot re-read a GLEIF leg from the reference ${JSON.stringify(reference)}: it is neither an LEI nor one of this adapter's own reference forms`,
      );
    }
    const expectedName = query.kind === 'name' ? query.name : null;
    // A refresh has no application in front of it, so it asserts no expected
    // country. The stored reference carries the question and nothing else.
    return this.answer(query, expectedName, null, null);
  }

  /**
   * One question, one answer, one leg.
   *
   * `expectedName` is the applicant's own name. When it is present, a record
   * that does not match it under `namesMatch` is NOT this business's record,
   * however good the record looks.
   */
  private async answer(
    query: GleifQuery,
    expectedName: string | null,
    referenceId: string | null,
    expectedCountry: string | null,
  ): Promise<KybLegResult<'live'>> {
    const observedAt = new Date().toISOString();

    if (query.kind === 'lei') {
      const found = await this.getLeiRecord(query.lei);
      if (found === null) {
        // The applicant asserted an identifier and the registry says it does
        // not exist. This is the one absence that IS evidence.
        return this.makeLeg({
          reference: `${GLEIF_NOT_FOUND_PREFIX}${query.lei}`,
          referenceId,
          status: 'rejected',
          rawStatus: 'lei_not_found_http_404',
          code: GLEIF_CODES.assertedLeiNotFound,
          reasons: [
            `GET /api/v1/lei-records/${query.lei} answered HTTP 404 — GLEIF holds no record with that LEI`,
            'an identifier the applicant asserted and the registry does not recognise is a decline, not a gap in coverage',
          ],
          citation: null,
          observedAt,
        });
      }
      // An asserted LEI whose record names a different company is worse than
      // no LEI: it is an assertion the registry contradicts.
      if (expectedName !== null && !nameMatchesRecord(expectedName, found)) {
        return this.makeLeg({
          reference: found.lei,
          referenceId,
          status: 'needs_review',
          rawStatus: `${found.entityStatus ?? '(absent)'}/${found.registrationStatus ?? '(absent)'}`,
          code: GLEIF_CODES.nameMismatch,
          reasons: [
            `LEI ${found.lei} exists, but GLEIF records its legal name as ${JSON.stringify(found.legalName)}, which does not match the applicant's ${JSON.stringify(expectedName)}`,
          ],
          citation: await this.citation(found),
          observedAt,
        });
      }
      return this.legFromRecord(found, referenceId, observedAt, expectedCountry);
    }

    const search = await this.searchByName(query.name);
    const match = search.candidates.find((record) => nameMatchesRecord(query.name, record));
    if (match === undefined) {
      // THE MISS. Not an approval, not a decline. See the header.
      return this.makeLeg({
        reference: `${GLEIF_NO_MATCH_PREFIX}${query.name}`,
        referenceId,
        status: 'needs_review',
        rawStatus: GLEIF_CODES.notInRegistry,
        // WHICH GENERATOR SAW SOMETHING DECIDES WHICH CODE THIS IS, and only
        // the precise one counts. `lei_name_mismatch` should mean "the registry
        // offered records that could plausibly have been you and none was" —
        // the 25 records the fuzzy token filter returns for every query
        // containing "Inc" are not that, and coding them as near-misses would
        // read as though a search had narrowed on the applicant when it had
        // not. So the code follows the AUTOCOMPLETION index: suggestions that
        // failed the name check are a mismatch; no suggestions at all is an
        // absence.
        code:
          search.autocompleteSuggestions === 0
            ? GLEIF_CODES.notInRegistry
            : GLEIF_CODES.nameMismatch,
        reasons: [GLEIF_MISS_HEADLINE, ...describeSearch(query.name, search)],
        citation: null,
        observedAt,
      });
    }
    return this.legFromRecord(match, referenceId, observedAt, expectedCountry);
  }

  private async legFromRecord(
    record: GleifRecordView,
    referenceId: string | null,
    observedAt: string,
    expectedCountry: string | null,
  ): Promise<KybLegResult<'live'>> {
    const verdict = gleifRecordToVerdict(record, expectedCountry);
    return this.makeLeg({
      reference: record.lei,
      referenceId,
      status: verdict.status,
      rawStatus: `${record.entityStatus ?? '(absent)'}/${record.registrationStatus ?? '(absent)'}`,
      code: verdict.code,
      reasons: verdict.reasons,
      citation: await this.citation(record),
      observedAt,
    });
  }

  /**
   * Assemble a leg. The only place this adapter constructs one.
   *
   * Named `makeLeg` rather than `leg` because `leg` is already the readonly
   * discriminant property every `KybLegProvider` carries, and a method that
   * shadowed it would be a compile error rather than a subtlety.
   */
  private makeLeg(fields: {
    reference: string;
    referenceId: string | null;
    status: KybStatus;
    rawStatus: string;
    code: string;
    reasons: readonly string[];
    citation: string | null;
    observedAt: string;
  }): KybLegResult<'live'> {
    const checks: KybCheck[] = [
      {
        name: 'business_registry_match',
        status:
          fields.status === 'approved' ? 'passed' : fields.status === 'rejected' ? 'failed' : 'pending',
        reasons: [...fields.reasons],
      },
      {
        name: KYB_PROVIDER_CODE_CHECK,
        status: fields.status === 'approved' ? 'passed' : 'failed',
        reasons: [fields.code],
      },
    ];
    if (fields.citation !== null) {
      checks.push({
        name: KYB_CITATION_CHECK,
        status: 'passed',
        reasons: [fields.citation],
      });
    }
    return {
      leg: 'business_registry',
      provider: this.name,
      reference: fields.reference,
      referenceId: fields.referenceId,
      status: fields.status,
      rawStatus: fields.rawStatus,
      checks,
      hostedUrl: null,
      observedAt: fields.observedAt,
      evidence: 'live',
    };
  }

  /**
   * Dereference `registeredAt.id` to a named authority, so the leg cites the
   * government register rather than asserting one.
   *
   * BEST EFFORT ON PURPOSE. A citation is an enrichment of an answer we already
   * have; failing to fetch it must not turn a decided leg into an error. The
   * fallback still names the raw authority code, which is itself checkable.
   */
  private async citation(record: GleifRecordView): Promise<string | null> {
    if (record.registeredAtId === null) return null;
    const entry = record.registeredAs === null ? '' : `, entry ${record.registeredAs}`;
    let authority: GleifAuthority | null = null;
    try {
      authority = await this.getRegistrationAuthority(record.registeredAtId);
    } catch {
      authority = null;
    }
    if (authority === null || authority.name === null) {
      return `GLEIF ${record.lei} — validated against registration authority ${record.registeredAtId}${entry}; corroboration ${record.corroborationLevel ?? '(absent)'}`;
    }
    const site = authority.website === null ? '' : ` (${authority.website})`;
    return `GLEIF ${record.lei} — validated against ${authority.name}, ${placeOf(record, authority)}${entry}${site}; corroboration ${record.corroborationLevel ?? '(absent)'}`;
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /** `null` means a clean 404. Every other failure throws. */
  private async getLeiRecord(lei: string): Promise<GleifRecordView | null> {
    const response = await this.request(`/api/v1/lei-records/${encodeURIComponent(lei)}`);
    // MEASURED: a 404 here carries an HTML body, so this branch keys on the
    // STATUS CODE and never on anything parsed out of the body.
    if (response.status === 404) return null;
    const body = await this.readJson(response, `/api/v1/lei-records/${lei}`);
    const record = readRecord(readPath(body, ['data']));
    if (record === null) {
      throw new KybProviderError(this.name, `GLEIF returned a record for ${lei} this build cannot read`);
    }
    return record;
  }

  /**
   * CANDIDATE GENERATION, AND NOTHING MORE.
   *
   * Two generators, run concurrently, merged and de-duplicated. Neither one
   * decides anything — `nameMatchesRecord` in the caller does — so the only
   * thing adding a second generator can change is RECALL, never precision.
   * That property is what makes it safe to reach for the fuzzy filter at all.
   *
   * A failure in either generator is swallowed rather than thrown: one of the
   * two answering is a search, and turning a partial search into a provider
   * error would convert a `needs_review` miss into a `pending` outage for no
   * gain. If BOTH fail, `request()` has already thrown out of the first await.
   */
  private async searchByName(name: string): Promise<GleifSearch> {
    const [autocomplete, fuzzy] = await Promise.all([
      this.autocomplete(name),
      this.fuzzyByLegalName(name),
    ]);

    /**
     * ===================================================================
     * A TOTAL OUTAGE IS NOT A MISS, AND THIS BUILD'S OWN TESTS CAUGHT IT
     * READING LIKE ONE.
     *
     * Each generator swallows its own failure, so that one of the two
     * answering is still a search. Composed naively that is a bug with a
     * very specific shape: with GLEIF unreachable, BOTH swallow, the merged
     * candidate list is empty, and the leg comes back `needs_review` saying
     * "not present in the LEI registry" — a sentence asserting that a
     * registry was consulted and had no record, when in fact nobody
     * answered anything. Live evidence, a citation-shaped claim, and no
     * round trip behind it.
     *
     * So when NEITHER generator answered, this throws. `attemptLeg()` in
     * ./composite.ts turns that into a `pending` leg labelled `simulated`
     * carrying `provider_reachable: failed`, which is the honest reading:
     * nobody answered, so the row is ours. `pending` blocks transacting
     * exactly as `needs_review` does, so failing closed costs nothing and
     * the difference is entirely in what the screen is allowed to say.
     * ===================================================================
     */
    if (!autocomplete.answered && !fuzzy.answered) {
      throw new KybProviderError(
        this.name,
        `GLEIF answered neither the autocompletion nor the legal-name search for ${JSON.stringify(name)}; this leg is unanswered, not a miss`,
      );
    }

    const byLei = new Map<string, GleifRecordView>();
    for (const record of [...autocomplete.records, ...fuzzy.records]) {
      if (!byLei.has(record.lei)) byLei.set(record.lei, record);
    }

    return {
      candidates: [...byLei.values()],
      autocompleteSuggestions: autocomplete.suggestions,
      autocompleteHits: autocomplete.records.length,
      fuzzyTotal: fuzzy.total,
      fuzzyExamined: fuzzy.records.length,
    };
  }

  /**
   * GENERATOR 1: `/api/v1/autocompletions?field=fulltext`.
   *
   * Phrase-scoped rather than OR-over-tokens, and it returns the LEI alongside
   * each suggestion, so a name that matches under `namesMatch` can be turned
   * into a full record with one further GET instead of a scan.
   *
   * The name filter is applied to the SUGGESTION before any record is fetched:
   * a query returning four suggestions costs at most one record read, not four,
   * and the fictional demo businesses cost zero because they return `data: []`.
   */
  private async autocomplete(
    name: string,
  ): Promise<{ answered: boolean; suggestions: number; records: readonly GleifRecordView[] }> {
    const params = new URLSearchParams();
    params.set('field', 'fulltext');
    params.set('q', name);
    const path = `/api/v1/autocompletions?${params.toString()}`;

    let entries: unknown[];
    try {
      const response = await this.request(path);
      if (response.status === 404) return { answered: true, suggestions: 0, records: [] };
      const data = readPath(await this.readJson(response, path), ['data']);
      entries = Array.isArray(data) ? data : [];
    } catch {
      return { answered: false, suggestions: 0, records: [] };
    }

    const leis: string[] = [];
    for (const entry of entries) {
      const value = readString(entry, ['attributes', 'value']);
      const lei = readString(entry, ['relationships', 'lei-records', 'data', 'id']);
      if (value === null || lei === null) continue;
      if (!namesMatch(name, value)) continue;
      if (!isLeiFormat(lei)) continue;
      if (!leis.includes(lei)) leis.push(lei);
      if (leis.length >= GLEIF_MAX_AUTOCOMPLETE_READS) break;
    }

    const records: GleifRecordView[] = [];
    for (const lei of leis) {
      try {
        const record = await this.getLeiRecord(lei);
        if (record !== null) records.push(record);
      } catch {
        // A suggestion whose record will not load is not a match; the fuzzy
        // generator and the miss path below both still get their turn.
      }
    }
    return { answered: true, suggestions: entries.length, records };
  }

  /**
   * GENERATOR 2: the fuzzy `filter[entity.legalName]`, quantified.
   *
   * `total` is carried out of `meta.pagination` deliberately. It is the number
   * that makes the trap visible on screen: a miss that says "43,182 loose token
   * matches, top 25 examined, none of them this company" is a description of
   * what was actually searched, and "0 candidates" would not have been.
   */
  private async fuzzyByLegalName(
    name: string,
  ): Promise<{ answered: boolean; total: number | null; records: readonly GleifRecordView[] }> {
    const params = new URLSearchParams();
    params.set('filter[entity.legalName]', name);
    params.set('filter[entity.legalAddress.country]', 'US');
    params.set('page[size]', String(GLEIF_FUZZY_PAGE_SIZE));
    const path = `/api/v1/lei-records?${params.toString()}`;

    try {
      const response = await this.request(path);
      if (response.status === 404) return { answered: true, total: 0, records: [] };
      const body = await this.readJson(response, path);
      const data = readPath(body, ['data']);
      const rawTotal = readPath(body, ['meta', 'pagination', 'total']);
      const total = typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null;
      if (!Array.isArray(data)) return { answered: true, total, records: [] };
      const records: GleifRecordView[] = [];
      for (const entry of data) {
        const record = readRecord(entry);
        if (record !== null) records.push(record);
      }
      return { answered: true, total, records };
    } catch {
      return { answered: false, total: null, records: [] };
    }
  }

  private async getRegistrationAuthority(code: string): Promise<GleifAuthority | null> {
    const path = `/api/v1/registration-authorities/${encodeURIComponent(code)}`;
    const response = await this.request(path);
    if (response.status === 404) return null;
    const body = await this.readJson(response, path);
    const attributes = readPath(body, ['data', 'attributes']);
    const raw = readPath(attributes, ['jurisdictions']);
    const jurisdictions: string[] = [];
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        const name = readString(entry, ['jurisdiction']) ?? readString(entry, ['country']);
        if (name !== null && !jurisdictions.includes(name)) jurisdictions.push(name);
      }
    }
    return {
      name:
        readString(attributes, ['internationalOrganizationName']) ??
        readString(attributes, ['organizationName']),
      jurisdictions,
      website: readString(attributes, ['website']),
    };
  }

  private async request(path: string): Promise<Response> {
    const doFetch = this.cfg.fetchImpl ?? fetch;
    try {
      return await doFetch(`${this.cfg.baseUrl ?? GLEIF_DEFAULT_BASE_URL}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.api+json',
          'User-Agent': this.cfg.userAgent ?? GLEIF_DEFAULT_USER_AGENT,
        },
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (error) {
      // GLEIF publishes no SLA. An unreachable registry must fail the leg
      // loudly — `attemptLeg` in ./composite.ts turns this into a `pending`
      // leg labelled `simulated`, which is the honest reading: nobody
      // answered, so the row is ours.
      throw new KybProviderError(
        this.name,
        `GLEIF GET ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readJson(response: Response, path: string): Promise<unknown> {
    if (!response.ok) {
      throw new KybProviderError(this.name, `GLEIF GET ${path} -> ${response.status}`, response.status);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new KybProviderError(this.name, `GLEIF GET ${path} returned a body that is not JSON`);
    }
  }
}

/** A registration authority, dereferenced from `entity.registeredAt.id`. */
export interface GleifAuthority {
  readonly name: string | null;
  /** Every jurisdiction this authority covers. Often one; sometimes fifty. */
  readonly jurisdictions: readonly string[];
  readonly website: string | null;
}

/**
 * WHERE TO SAY THIS ENTITY IS REGISTERED, without asserting more than is known.
 *
 * A registration authority can cover many jurisdictions. RA000598 covers
 * exactly one — California — so naming it is a fact. The SEC's entry covers
 * every US state and territory, and the first element of that array is not the
 * entity's jurisdiction; an early draft printed one of GLEIF's ETFs as
 * registered in GUAM because it took `jurisdictions[0]` and stopped thinking.
 *
 * So: name the authority's jurisdiction only when the authority HAS one, and
 * otherwise fall back to the entity's own `entity.jurisdiction` (ISO 3166-2,
 * e.g. `US-DE`), which is the record's own statement about itself and is the
 * only field entitled to answer this question.
 */
export function placeOf(record: GleifRecordView, authority: GleifAuthority): string {
  const single = authority.jurisdictions.length === 1 ? authority.jurisdictions[0] : undefined;
  return single ?? record.jurisdiction ?? record.country ?? 'unstated jurisdiction';
}

/** Does this record belong to the applicant? Legal name or any other name. */
export function nameMatchesRecord(expected: string, record: GleifRecordView): boolean {
  if (namesMatch(expected, record.legalName)) return true;
  return record.otherNames.some((name) => namesMatch(expected, name));
}

// ---------------------------------------------------------------------------
// 7. Reading GLEIF's JSON:API shape
// ---------------------------------------------------------------------------

/** One `lei-records` element -> the fields this module actually uses. */
export function readRecord(entry: unknown): GleifRecordView | null {
  const attributes = readPath(entry, ['attributes']);
  const lei = readString(attributes, ['lei']);
  const legalName = readString(attributes, ['entity', 'legalName', 'name']);
  if (lei === null || legalName === null) return null;

  const otherNamesRaw = readPath(attributes, ['entity', 'otherNames']);
  const otherNames = Array.isArray(otherNamesRaw)
    ? otherNamesRaw.map((n) => readString(n, ['name'])).filter((n): n is string => n !== null)
    : [];

  return {
    lei,
    legalName,
    otherNames,
    entityStatus: readString(attributes, ['entity', 'status']),
    registrationStatus: readString(attributes, ['registration', 'status']),
    corroborationLevel: readString(attributes, ['registration', 'corroborationLevel']),
    jurisdiction: readString(attributes, ['entity', 'jurisdiction']),
    country: readString(attributes, ['entity', 'legalAddress', 'country']),
    registeredAtId: readString(attributes, ['entity', 'registeredAt', 'id']),
    registeredAs: readString(attributes, ['entity', 'registeredAs']),
    lastUpdateDate: readString(attributes, ['registration', 'lastUpdateDate']),
    successorName: readString(attributes, ['entity', 'successorEntity', 'name']),
  };
}

function readPath(value: unknown, path: readonly string[]): unknown {
  let cursor: unknown = value;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function readString(value: unknown, path: readonly string[]): string | null {
  const found = readPath(value, path);
  return typeof found === 'string' && found.trim() !== '' ? found : null;
}
