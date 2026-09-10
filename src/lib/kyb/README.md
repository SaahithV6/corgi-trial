# KYB / KYC

Two legs, one composite, and an evidence label that cannot be forged.

```
                    ┌──────────────────────────┐
  director KYC ────►│                          │
  (Persona)         │  CompositeKybProvider    │──►  CompositeKybResult
                    │   · strictest status     │      · status   (derived)
  business registry►│   · evidence degrades    │      · evidence (derived)
  (Stripe Connect)  │   · cites both legs      │      · citations
                    └──────────────────────────┘
                                                          │
                                              canTransact(business state)
                                                          │
                                            allowed: true ─┴─ allowed: false + code
```

| File | What it is |
|---|---|
| `types.ts` | The status lattice, the evidence label, the leg interface, and `canTransact` — the gate. Pure, no I/O. |
| `persona.ts` | Director / control-person KYC. Live Persona sandbox inquiries. |
| `stripe-registry.ts` | Business-registry check. Live Stripe Connect test-mode company verification. |
| `simulated-registry.ts` | The labelled fallback, for either leg. Always `evidence: 'simulated'`. |
| `composite.ts` | The combination rules, and the class that makes rule 2 unforgeable. |
| `index.ts` | The factory: choose per leg from the environment, announce it loudly, expose it to `/api/health`. |
| `db/migrations/0005_kyb.sql` | The evidence table and the derived-state view. |

---

## 1. Why this shape — the finding, not the assumption

The full survey is `research/kyb/NOTES.md`. Three facts drove every design decision here.

**Persona's business verification is gated behind a sales conversation.** Four
plan-availability tables list Business Verification as *Not Available* below Growth;
Essential has to buy it separately; and the API-first KYB guide's first step is
"Reach out to your Persona team" to have a `transaction_type_id` provisioned. There is no
self-serve path, so **we do not attempt it**. This is settled, from Persona's own docs.

**Persona's individual KYC is self-serve, and it is the only provider that can drive its
own lifecycle from the server.** `POST /inquiries/{id}/perform-simulate-actions` moves a
sandbox inquiry to pending / approved / declined / needs_review **and fires the real
webhook for each transition**. That is why Persona is the primary: the non-happy-path
states in the demo are Persona's transitions arriving over Persona's signature at our
deployed endpoint — not rows we flipped in our own database. Stripe Identity notably
cannot do this: it publishes no forced-outcome values and ships no CLI trigger fixture for
`verified` or `requires_input`, which is why it is not used here at all.

**Stripe Connect test mode does the business-registry leg, free and self-serve.** Real
company-registry check on name / EIN / owners / directors, with published magic EINs
`222221000`–`222221005` forcing company-not-found, owners-not-found, directors-not-found
and pending-response-from-registry, surfaced as structured `requirements.errors[]` codes
over signed `account.updated` webhooks.

Say it accurately, and the module's comments do: this is **Stripe Connect's company
verification, which performs a real registry check and returns structured failure codes**.
It is not a KYB vendor integration and nothing here implies it is.

One operational fact worth repeating because it is unforgiving: **Persona allows one
60-day trial per business, ever, and the free Starter plan no longer exists** (G2 and
Vendr still list it; it is historical). The trial is metered. Nothing in this module's
tests touches the live sandbox — every test injects `fetchImpl`.

---

## 2. The status lattice

Four statuses, one total order:

```
rejected  >  needs_review  >  pending  >  approved
```

Read it as *how much this blocks money*. Combining legs takes the **maximum**, so an
approval on one leg can never dilute a decline on the other. `approved` is the only status
that permits transacting, which means every mapping ambiguity resolves the safe way by
construction: anything we are not sure about is not approved.

The rank numbers in `KYB_STATUS_STRICTNESS` are duplicated, deliberately, as the
*declaration order* of the `kyb_status` enum in `0005_kyb.sql` — Postgres orders enums by
declaration order, so `max(status)` in `v_business_kyb` **is** "the strictest status".

### Persona inquiry → lattice

| Persona | Ours | Why |
|---|---|---|
| `created`, `pending` | `pending` | In flight. |
| `completed` | `pending` | **Not approved.** Persona is explicit that `completed` means the user reached the Completed screen; the decision is a separate post-inquiry phase. Mapping this to approved is the easiest way to let an unverified person through. |
| `approved` | `approved` | The decision. |
| `declined` | `rejected` | The decision. The only Persona status that reaches `rejected`. |
| `expired` | `needs_review` | Nobody decided anything and the inquiry is dead. A human must re-invite. |
| `failed` | `needs_review` | The user hit the Failed screen. Also not a decision. |
| `needs_review`, `marked_for_review` | `needs_review` | |
| *anything else* | `needs_review` | Persona warns "do not assume this is a static enumeration". An unknown status must never reach `approved`. |

### Stripe requirements → lattice

Precedence, strictest first, so a decline is never masked by a field that also happens to
be outstanding:

1. an error code in `STRIPE_REJECT_CODES` → `rejected`
2. `disabled_reason` `rejected.*` / `listed` → `rejected`
3. any other error, or `disabled_reason: under_review` → `needs_review`
4. `pending_verification` non-empty (this is where EIN `222221005` lands) → `pending`
5. `currently_due` / `past_due` non-empty → `pending`
6. nothing outstanding → `approved`

An error code this build has never seen lands on (3) — held for review, never approved.

**A correction worth keeping, because the obvious guess is wrong: there is no
`company.verification.status` field.** `company.verification` holds only a `document`
sub-object; `verification.status` exists on *Person* objects. The outcome is read from
`requirements`, and `stripe-registry.test.ts` asserts that an account carrying a
`company.verification.status: "verified"` is still read from `requirements`.

---

## 3. Evidence, and why a forged `"live"` is unrepresentable

`evidence` is `'live'` (a third party we do not control produced this answer) or
`'simulated'` (we produced it). There is deliberately no third value: *partly live* is the
state this module exists to make impossible.

**The rule: a composite is `live` only if every leg was `live`.** It degrades, and it never
un-degrades.

`CompositeKybResult` **has no `evidence` field.** It has a private `#legs` field and an
`evidence` *getter* derived from it. That one choice closes every route at once, and
`composite.test.ts` tries each and asserts it fails:

| Route | Why it fails |
|---|---|
| 1. Write an object literal typed `CompositeKybResult` | The `#legs` private field makes the class **nominally** typed. No literal can satisfy it. *(compile error)* |
| 2. `new CompositeKybResult(…, 'live')` | The constructor is `private`. The only entry points are `of()` and `rehydrate()`, and **neither takes an evidence argument** — both derive it. *(compile error)* |
| 3. Subclass and override the getter | A private constructor makes the class unextendable. *(compile error)* |
| 4. `Object.defineProperty(result, 'evidence', …)` | Instances are frozen, so defining a shadowing own property throws `TypeError`. Plain assignment to a setter-less accessor throws too. *(runtime)* |
| 5. Replace the prototype getter | `Object.freeze(CompositeKybResult.prototype)`. *(runtime)* |
| 6. Store a forged label and read it back | `rehydrate()` takes **legs, not a label**. A hand-edited `evidence` column is ignored on read and recomputed. *(by construction)* |
| 7. Type it live from a simulated leg | `of()` returns `CompositeKybResult<DegradeEvidence<A, B>>`, and `CompositeKybResult<'simulated'>` is not assignable to `CompositeKybResult<'live'>`. *(compile error)* |
| 8. Have a simulated provider claim live | `SimulatedRegistryProvider` is declared `KybLegProvider<'simulated'>`, so `evidence: 'live'` is a type error **inside** that file. *(compile error)* |

The compile-time routes are asserted with `@ts-expect-error`, which means `pnpm typecheck`
fails if any of them ever *stops* being an error. They are load-bearing tests, not comments.

The same rule is stated a third time in Postgres: `v_business_kyb` derives evidence with
`bool_and(evidence = 'live')` over the latest leg rows, and there is **no stored column to
forge**. `kyb_verification_leg` additionally carries a CHECK refusing any row that claims
`live` while carrying a simulator's mark (`provider_reference LIKE 'sim.%'` or
`provider LIKE 'simulated-%'`).

### The one non-obvious consequence

A leg whose provider **did not answer** (timeout, 502) produces `status: 'pending'`,
`evidence: 'simulated'` — see `failedLeg`. Labelling it `live` would claim a third party
said "pending" when no third party said anything. So a transient outage degrades the whole
composite to simulated. That is loud, correct, and self-healing: the next successful
`refresh` recomputes both legs from scratch.

---

## 4. The factory

```
key present  ->  live adapter,      evidence 'live'
key absent   ->  simulated adapter, evidence 'simulated', and it says so
```

There is no third branch, and in particular **no "try live, fall back to simulated on
error"** anywhere in this module. A silent fallback produces a system that looks live in
the logs and is not. A live adapter that cannot reach its provider fails the leg loudly; it
never quietly becomes a simulator.

The two legs are selected **independently**. Persona present, Stripe absent is a normal
state — live director KYC, simulated registry — and the composite is then `simulated`
overall, because half the evidence was manufactured.

| Env var | Leg | Required for live? |
|---|---|---|
| `PERSONA_API_KEY` | director KYC | yes |
| `PERSONA_INQUIRY_TEMPLATE_ID` | director KYC | yes (`itmpl_…`, not the legacy `tmpl_…`) |
| `PERSONA_VERIFICATION_TEMPLATE_ID` | director KYC | optional — only for `create_passed/failed_verification` in simulate scripts |
| `PERSONA_ENVIRONMENT_ID` | director KYC | optional — appended to hosted-flow links |
| `STRIPE_SECRET_KEY` | business registry | yes (`sk_test_…`) |
| `KYB_FORCE_SIMULATED` | either | escape hatch: `director_kyc`, `business_registry`, or `all` |

`KYB_FORCE_SIMULATED` exists for exactly one documented risk: Stripe says the test key must
come from an account "which has begun Connect platform onboarding", and does not say
whether that is one dashboard click or a review. If it turns out to be gated, this switches
the registry leg back **without a deploy**, and the health endpoint shows the reason.

### Startup

`createKybProvider()` announces the selection once per process: one line per leg, `warn`
for any simulated leg naming the env var that would fix it, plus a summary line carrying
`evidenceCeiling`. Env var **names** appear; values never do (`index.test.ts` asserts it).

```
WARN  kyb.leg.simulated  leg=business_registry provider=simulated-registry
                         reason="no live registry check: STRIPE_SECRET_KEY not set"
WARN  kyb.selection      evidenceCeiling=simulated
                         note="at least one leg is simulated; every verification this
                               deployment produces is labelled simulated"
```

### Health

`/api/health` reads the same `selectKybLegs()` the factory uses, so the endpoint cannot
advertise a leg as live while the factory built a simulator for it. One line in
`src/app/api/health/route.ts`:

```ts
import { kybHealthReport } from '@/lib/kyb';
// ...inside the response body:
kyb: kybHealthReport(env),
```

`evidenceCeiling` is named a *ceiling* on purpose: it is a statement about the wiring, not
a claim that anything has been verified.

---

## 5. The gate

`business.kyb` state gates transacting. **An unverified entity can look, but not transact.**

One predicate, and deliberately no boolean-returning sibling to reach for instead:

```ts
import { canTransact } from '@/lib/kyb';

const gate = canTransact(state);           // state comes from v_business_kyb
if (!gate.allowed) return fail(gate.code, gate.message);
```

The failure mode is explicit: `TransactDecision` has no boolean anywhere in it. A denial
carries a `code` to branch on, a `message` safe to show a user, and the `status` /
`evidence` the compliance view renders.

| Code | Meaning | Recoverable by |
|---|---|---|
| `KYB_NOT_STARTED` | No verification on file. | starting one |
| `KYB_PENDING` | A provider has not answered. | waiting |
| `KYB_NEEDS_REVIEW` | A human has to act. | a reviewer |
| `KYB_REJECTED` | A decision to say no. | nothing — terminal |
| `KYB_EVIDENCE_SIMULATED` | Approved, but not by anyone real, and this deployment requires real. | a real key |
| `KYB_STATE_UNREADABLE` | The stored state is not a value this build understands. | a deploy |

**It fails closed.** `status` and `evidence` are typed `string | null`, not the narrow
unions, because this is the boundary where untrusted data arrives — a column written by an
older deploy, a hand-edited row. Taking the raw value forces the narrowing to happen *here*,
where the failure is a denial, rather than at a cast that would let an unrecognised string
through as "not rejected, so fine". `types.test.ts` asserts the denial for `'verified'`,
`'ok'`, `'APPROVED'`, `'approved '`, `''` and `'toString'`.

`requireLiveEvidence` defaults to **false**, and that default is a stated choice, not an
oversight: this deployment runs without provider keys until they exist, and a gate that
denies everything teaches people to bypass the gate. What it never does is hide the fact —
an allowed decision always carries `evidence`. **Set it to true in any deployment that
touches real money.**

---

## 6. Webhooks

**This module implements no signature verification, and must never start.** Persona and
Stripe deliveries are authenticated exactly once, by `personaVerifier` and `stripeVerifier`
in `src/lib/webhooks/inbox.ts`, and land in the webhook inbox. The KYB adapters map an
**already-verified** payload:

- `legFromPersonaEvent(payload)` — `inquiry.*` envelope → a live director leg.
- `legFromStripeAccountEvent(payload)` — `account.updated` → a live registry leg.

Both return `null` for events that are not theirs. `persona.test.ts` and
`stripe-registry.test.ts` each assert that this module exports nothing matching
`/signature|hmac|verifywebhook/`, so a second HMAC implementation fails the suite.

Register these events:

| Provider | Events |
|---|---|
| Persona | `inquiry.created`, `.started`, `.completed`, `.failed`, `.expired`, `.approved`, `.declined`, `.marked-for-review` |
| Stripe | `account.updated` |

Persona's deliveries are **not ordered** and **may be duplicated** — order on
`data.attributes.created-at`, and dedupe is the inbox's `UNIQUE (provider,
provider_event_id)`. That is why `kyb_verification_leg` stores `observed_at` separately
from `recorded_at` and the view reads the latest by `observed_at`: a webhook arriving out
of order cannot un-approve a business.

---

## 7. Storage

`db/migrations/0005_kyb.sql`. **There is no `business.kyb_status` column**, and that is the
design, not an omission — see §3. What exists:

- `kyb_verification_leg` — one row per observation, append-only (`GRANT SELECT, INSERT`
  only; `REVOKE UPDATE, DELETE, TRUNCATE`). Carries `provider` + `provider_reference`, so
  the evidence pack cites `persona-inquiry` / `inq_ABC…` rather than asserting. `inbox_id`
  traces a status back to the exact signed bytes that produced it.
- `v_business_kyb` — the derived state the gate reads: `max(status)` across the latest leg
  per business, `bool_and(evidence = 'live')`, and **`legs_on_file < 2` → `pending`**. A
  business with only one leg on file has not passed a verification half of which was never
  performed.

Read a row into the gate with `businessKybStateFromRow(row)` — the column names live in one
place so no call site hand-rolls the mapping and reaches for a cast while doing it.

**One measured correction, recorded because it was a genuine bug.** "Latest observation
wins" needs a *total* order, and `(observed_at, recorded_at)` is not one: two rows written
in the same transaction share a `recorded_at`, because `now()` is fixed for the life of a
transaction. The first draft tie-broke on `id DESC` — a random uuid — which means it picked
at random between a live leg and a simulated one. Caught by applying the migration inside a
transaction that was rolled back, and asserting the view's output at each step; fixed with a
`bigserial seq` so the fallback is insertion order. That validation run also proves the
`kyb_leg_simulated_reference` CHECK refuses a simulator's output filed as live evidence.

---

## 8. When a real key appears

This is the whole list.

**A Persona sandbox key** (`PERSONA_API_KEY` + `PERSONA_INQUIRY_TEMPLATE_ID`): the factory
selects `PersonaDirectorKycProvider` instead of `SimulatedDirectorKycProvider`, the boot log
turns from `warn kyb.leg.simulated` to `info kyb.leg.selected`, and `/api/health` shows the
director leg `live`. **No code changes.** Register the webhook at
`/api/webhooks/persona` with the `wbhsec_…` secret in `PERSONA_WEBHOOK_SECRET` — that
verifier is already in the registry. Demo the non-happy paths with
`provider.simulate(inquiryId, provider.scriptFor('declined'))`.

**A Stripe test key** (`STRIPE_SECRET_KEY`): the factory selects
`StripeConnectRegistryProvider`. Use the magic EINs to force each registry failure. Register
`account.updated` at `/api/webhooks/stripe`, pointed at the **final resolved URL** — Stripe
counts a 3xx as a delivery failure. If Connect platform onboarding turns out to be gated,
set `KYB_FORCE_SIMULATED=business_registry` and the leg says so honestly.

**Both keys**: `evidenceCeiling` becomes `live`, and a verification where both legs approve
is the first one this system will label `live`. Nothing about the composite, the lattice or
the gate changes — which is the point of having built them this way first.

**A Persona KYB entitlement** (someone provisions a `transaction_type_id`): that is a new
`KybLegProvider<'live'>` for the `business_registry` leg — `POST /transactions` with
`business_name` / `business_tax_identification_number` / `associated_people` in **snake**
case (the Inquiries API is kebab), status read from `transaction.status-updated`. It slots
in at one line in `selectRegistryLeg`. The shape is written out in
`research/kyb/adapter.draft.ts` as `PersonaKybProvider`, against the published docs, so the
day it arrives is a wiring change and not a research project.

---

## 9. Known unconfirmed

Carried forward from `research/kyb/NOTES.md` rather than quietly dropped:

- Whether a test key from an account that has not "begun Connect platform onboarding" can
  create accounts at all. Mitigation: `KYB_FORCE_SIMULATED`.
- The exact response key carrying Persona's `auto-create-one-time-link`. The adapter reads
  both plausible locations and falls back to the documented deterministic hosted-flow URL,
  so this degrades to a working link rather than to `null`.
- Whether a trial org ships with a ready-made Government ID inquiry template, and whether
  `verification-template/database-business` is present on a trial (it would give the
  registry leg a second live signal). Upside, not the plan.
- Persona publishes **no** replay tolerance for `Persona-Signature`. The 300 s window in
  `src/lib/webhooks/inbox.ts` is our policy, matching Stripe's documented default.
