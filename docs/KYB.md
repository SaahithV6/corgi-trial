# KYB / KYC — what is live, what is substituted, and what neither of them proves

The brief marks this slot **must be live** and names three vendors for it:
Persona KYB, Middesk, Sumsub. This document says exactly which of those we are
using (none), what we are using instead, why, what it does and does not prove,
and the two environment variables that move the leg onto a real vendor the hour
one becomes available.

Everything below was measured against the live APIs on 2026-09-10. Nothing in it
is quoted from documentation without a request behind it.

---

## The short version

The verification has two legs and they are **not equally compliant with the
brief**, so this document never averages them into one sentence.

| Leg | Provider | Third party? | Standing against the brief |
| --- | --- | --- | --- |
| director / control-person KYC | Stripe Identity | yes, real sandbox calls | **On the brief's own KYC menu** (Persona, Sumsub, Stripe Identity, Onfido). Compliant. No apology owed. |
| business registry | GLEIF (`api.gleif.org`) | yes, real reads of a real registry | **A substitution.** GLEIF is not one of the three vendors the brief names. It is a considered fallback, and it sits at the bottom of a precedence ladder every one of those vendors outranks. |

A verification is only as good as its worst leg, in both dimensions:

- **status** takes the strictest of the two (`rejected` > `needs_review` >
  `pending` > `approved`);
- **evidence** degrades to `simulated` if *either* leg was, permanently, with no
  path back.

Neither is stored. Both are derived — by `CompositeKybResult` in TypeScript and
by `v_business_kyb` in Postgres — every time they are read. There is no
`kyb_status` column for an `UPDATE` to forge.

---

## The one rule that matters about GLEIF

> **A hit is strong authoritative evidence. A miss is evidence of nothing.**

GLEIF holds **3,426,836** records, **360,275** of them with a US legal address,
against tens of millions of US entities. Its population is entities that were
required to obtain a Legal Entity Identifier to participate in financial
markets, not every company that exists. GRACE SEAFOOD CORP. is a real, active
New York corporation (NY DOS 4072354) and GLEIF returns nothing for it.

Therefore an absent record is `needs_review`. **Never `approved`.** A miss that
quietly approved would be strictly worse than the labelled simulator it
replaced, because it would wear a live evidence label while asserting a fact
nobody checked.

All three businesses seeded on this book are fictional, so **all three miss**,
and the screen says so in those words: *"not present in the LEI registry — this
is not evidence the business does not exist."* That is the correct answer,
arrived at by an authenticated round trip rather than asserted by us.

### The one absence that *is* evidence

If the applicant **asserted** an LEI and GLEIF answers HTTP 404 for it, they
have claimed an identifier that does not exist. That is a decline. "We could not
find you" and "the identifier you gave us is not real" are different sentences
and they get different statuses.

---

## What a GLEIF hit does not prove

Printed on the onboarding screen next to the leg, not just filed here.

- It does **not** prove the applicant controls the entity — no authority check,
  no signatory check.
- It does **not** check beneficial ownership or the ownership tree.
- It does **not** screen sanctions, PEP or adverse media.
- It does **not** verify an EIN or any tax identifier.
- Its coverage is partial, as above.

A KYB vendor would answer most of those. GLEIF answers exactly one question:
does this legal entity exist in the LEI registry, and what does the underlying
government register say about it. **No evidence string in this build implies
equivalence with Middesk, Persona KYB or Sumsub**, and that is a rule the code
enforces by printing the word "SUBSTITUTION" in the same badge as the word
"live".

---

## What a hit *is*: a citation, not a badge

Every GLEIF record was validated by an accredited Local Operating Unit against a
government company register, and the record names **which** register.
`entity.registeredAt.id` dereferences to a named authority; `entity.registeredAs`
is the entity's number in it. So the leg emits something a reviewer can follow:

```
GET /api/v1/lei-records/HWUPKR0MPOU8FGXBT394      -> 200
GET /api/v1/registration-authorities/RA000598     -> 200

GLEIF HWUPKR0MPOU8FGXBT394 — validated against Secretary of State, California,
entry 806592 (https://businesssearch.sos.ca.gov/); corroboration FULLY_CORROBORATED
```

That last line is the leg's `registry_citation` check, stored inside the
evidence and rendered on the card. Anybody can paste 806592 into the California
Secretary of State's own search page and see the entity.

---

## Status mapping, implemented exactly

| GLEIF says | We say | Why |
| --- | --- | --- |
| `entity.status ACTIVE` + `registration.status ISSUED` + `FULLY_CORROBORATED` | `approved` | The only path to approved. |
| `entity.status INACTIVE` | `rejected` | The register says this entity no longer trades. A genuine earned decline. |
| `registration.status RETIRED` / `ANNULLED` / `CANCELLED` | `rejected` | The LEI registration was withdrawn. |
| `registration.status LAPSED` | `needs_review` | Nobody renewed the LEI. 203,636 US records sit here; it is a statement about the registration, not about the company. |
| `corroborationLevel` below `FULLY_CORROBORATED` | `needs_review` | The LOU did not fully validate the record against the register. |
| name matches, but the record is registered in another country | `needs_review` | See the cross-border trap below. |
| no match at all | `needs_review`, raw status `not_in_lei_registry` | Never approved, never rejected. |
| HTTP 404 on an LEI the applicant supplied | `rejected` | They asserted a non-existent identifier. |
| a status string this build has never seen | `needs_review` | Fail closed. |
| timeout / unreachable | the leg is **unanswered**: `pending`, evidence `simulated` | Nobody answered, so the row is ours. See below. |

The 404 is parsed on the **status code**, never on the body: GLEIF's 404 body is
JSON today and has been an HTML error page before now, and a decline must not
depend on their choice of error renderer.

### Reachability, measured

Live outcomes produced against the real API while building this:

| Outcome | Query | Result |
| --- | --- | --- |
| `approved` | `Apple Inc.` | LEI `HWUPKR0MPOU8FGXBT394`, California SoS entry 806592 |
| `approved` via a previous name | `STRIPE, INC.` | LEI `549300CLHGIPTCYHQ143` — legal name is `STRIPE, LLC`, Delaware entry 4675506 |
| `rejected` | LEI `254900ZT6ZFUC887FB87` | `RESILIENCE PARENT, LLC` — entity INACTIVE, registration RETIRED, successor `POWER GRID COMPONENTS, INC.` |
| `rejected` | LEI `ZZZZZZZZZZZZZZZZZZZZ` | HTTP 404 on an asserted identifier |
| `needs_review` (lapsed) | LEI `5299000RS1SH8F7PJ323` | `LifeX 2028 Income Bucket ETF` — ACTIVE but LAPSED |
| `needs_review` (corroboration) | LEI `98450077CAFCB7A59084` | `FINDTAPE.COM LLC` — ACTIVE, ISSUED, PARTIALLY_CORROBORATED |
| `needs_review` (jurisdiction) | `Apple Computer, Inc.` | An exact name match registered in **Ireland** |
| `needs_review` (miss) | each seeded business | `not_in_lei_registry` |

Every one of those is reproducible from the **Ask the registry** panel on
`/onboarding`, which runs the same live adapter and writes nothing.

---

## Three traps, and what was done about each

### 1. The fuzzy name filter

`filter[entity.legalName]` is an **OR over tokens**. Measured:

```
filter[entity.legalName]=Stripe, Inc.               -> total 76,770
   data[0] = "ACCENT STRIPE, INC."      (matched on the token "INC")

filter[entity.legalName]=Ridgeline Robotics, Inc.
   + filter[entity.legalAddress.country]=US         -> total 43,182
   data[0] = "Pruvations Inc 401K Inc"  (same token, same trap)
```

A build that trusted `data[0]` would approve a 401(k) plan as an aerospace firm.
So:

1. the **primary** candidate generator is
   `/api/v1/autocompletions?field=fulltext`, which is phrase-scoped —
   `q=Stripe, Inc.` returns three suggestions, not 76,770, and
   `q=Ridgeline Robotics, Inc.` returns `data: []`;
2. the fuzzy filter runs **concurrently** as a second generator, because it
   reaches records the autocompleter's index does not, and its
   `meta.pagination.total` is carried into the leg's own reasons so a miss says
   *"43,182 loose token matches, top 25 examined, none of them this company"*
   rather than implying 25 was the whole search space;
3. **neither is trusted.** Every candidate's `legalName` *and* `otherNames` are
   re-verified against the applicant's name in our own code, under a
   normalisation that keeps the legal-form suffix — `Ridgeline Robotics, Inc.`
   and `Ridgeline Robotics LLC` are different legal entities and a matcher that
   equated them would approve the wrong company.

The exact reverse lookup, `filter[entity.registeredAs]=806592`, returns total 1:
a register entry number is not a token, so it does not fuzz.

### 2. The cross-border near-miss

Searching `Apple Computer, Inc.` resolves to LEI `549300G81RQKP7XW2N18` — an
ACTIVE, ISSUED, FULLY_CORROBORATED record registered at the Companies
Registration Office in **Ireland**, entry 76941. Every signal says approve, the
names are identical, and no name check could ever separate them. This is a US
business-account product, so a country mismatch is `needs_review`: a US
applicant *can* control a foreign entity, and that is a question for a human.

### 3. An outage that reads like a miss

Each of the two search generators swallows its own failure, so that one
answering is still a search. Composed naively that has a very specific bug: with
GLEIF unreachable, both swallow, the candidate list is empty, and the leg comes
back `needs_review` saying *"not present in the LEI registry"* — a sentence
asserting a registry was consulted, on a request nobody received.

So when **neither** generator answers, the adapter throws, and the composite
records a `pending` leg labelled **`simulated`** carrying
`provider_reachable: failed`. Nobody answered, so the row is ours. `pending`
blocks transacting exactly as `needs_review` does; the whole difference is what
the screen is allowed to say. `gleif.test.ts` pins both halves — a total outage
must fail, a partial one must not.

---

## The director leg cannot reach `rejected`, and here is the transcript

Stripe Identity's session status is `requires_input` / `processing` /
`verified` / `canceled`, and on its own it cannot express a decline.
`last_error` is the other half of the sentence.

Measured on the live test-mode API:

```
GET  /v1/identity/verification_sessions/vs_1UEFoWDgSL5WTGpmMCJLolW6
     -> 200  status "requires_input"
             last_error {code: "document_unverified_other",
                         reason: "The document is invalid."}

POST /v1/identity/verification_sessions/vs_1UEFoWDgSL5WTGpmMCJLolW6/cancel
     -> 200  status "canceled", url null, client_secret null,
             **last_error null**            <- the refusal is ERASED

GET  the same session again
     -> 200  still "canceled", still last_error null

POST .../cancel  (again)
     -> 200  no-op, so the state is stable rather than a race

POST /v1/identity/verification_sessions/vs_1UEDLcDgSL5WTGpmif87HEZ7/cancel
     -> 400  "You cannot cancel this VerificationSession because it has a
              status of \"verified\"."      <- Stripe enforces the transition

POST .../redact
     -> 200  redaction {status: "processing"}; status stays canceled
```

So the only terminal state Stripe will hand back has had the refusal deleted out
of it, and a cancelled session with no refusal to point at is **not** a decline.
Manufacturing one out of an operator's click is exactly the forgery this module
exists to prevent.

**Consequence, stated rather than left to be discovered:** the director leg's
worst real outcome is `needs_review`. The wiring panel prints its reachable
statuses with `rejected` struck through and says why.

The composite still reaches `rejected` on live third-party evidence — on the
**registry** leg, where GLEIF declines a withdrawn company or a fabricated
identifier. Strictest-wins carries it to the composite. A rejected verification
on this book is a real registry's refusal, not a button somebody pressed.

### What each session maps to

| Stripe session | We say | Real? |
| --- | --- | --- |
| `verified` | `approved` | yes — `vs_1UEDLcDgSL5WTGpmif87HEZ7`, Ridgeline |
| `requires_input`, no `last_error` | `pending` | yes — `vs_1UEDMJDgSL5WTGpmoO0O0tPh`, Silverline |
| `requires_input` + `last_error` | `needs_review` | yes — `vs_1UEDNIDgSL5WTGpm9Zl8jRAH`, Kettle & Crumb, `document_unverified_other` |
| `canceled`, no `last_error` | `needs_review` | yes — measured, and it is every cancelled session |
| `canceled` + `last_error` | `rejected` | **unreachable today.** Kept because it is the correct reading if Stripe stops erasing the field, and labelled dead. |

---

## The precedence ladder — GLEIF is a rung, not a hard-coding

`src/lib/kyb/registry-precedence.ts` holds the order, once, as data. Both
surfaces that choose a provider walk it — `selectKybLegs()` behind `/api/health`
and `selectWiredLegs()` behind the screen — which is what stops them describing
the same leg differently.

```
KYB_FORCE_SIMULATED      the escape hatch, honoured AHEAD of everything
1. Persona KYB           vendor, named by the brief   adapter EXISTS
2. Middesk               vendor, named by the brief   adapter NOT WRITTEN
3. Sumsub KYB            vendor, named by the brief   adapter NOT WRITTEN
4. Stripe Connect        vendor, not on the brief     adapter EXISTS
5. GLEIF                 registry, not a vendor       adapter EXISTS, no
                         credential, so this rung always matches
-  simulated-registry    reachable only by the escape hatch
```

Every vendor sits above GLEIF; GLEIF sits above the simulator.
`composite.ts` has never known which registry it is talking to, the screen reads
the provider name off the leg, and the database's `provider` column is a string.

### To move this leg to Persona KYB

Set two environment variables and redeploy:

```
PERSONA_API_KEY=persona_sandbox_…
PERSONA_KYB_TEMPLATE_ID=itmpl_…      # a BUSINESS template, not the director one
```

That is the whole change. No file is edited. On the next boot the ladder selects
`persona-kyb-inquiry`, the wiring panel's badge flips from **LIVE, but a
SUBSTITUTION** to **on the brief's menu**, `/api/health`'s note stops using the
word "substitution", and every new evidence row records Persona as the provider.
`index.test.ts` and `registry-precedence.test.ts` assert exactly this, so the
promise is held by a test rather than by this paragraph.

`PERSONA_KYB_TEMPLATE_ID` is deliberately a separate variable from
`PERSONA_INQUIRY_TEMPLATE_ID`: the director template and the business template
are different objects, and one variable serving both would point a business
inquiry at a person flow the first time somebody set it.

**What is proven about that adapter and what is not.** Proven: the endpoint, the
auth, the version header, the status vocabulary and the webhook envelope are the
Inquiries API's, shared with the director leg and exercised by
`persona.test.ts`. Not proven: the field names a business template expects,
because Persona KYB is gated behind a sales conversation and nobody here has
seen one. Persona ignores fields a template does not declare, so the failure
mode of being wrong is a hosted flow that asks a human for what we could have
prefilled — not a wrong verdict. Nothing in the status mapping depends on the
fields.

### To move it to Middesk or Sumsub

Their adapters are **not written**, and deliberately so: writing one against
documentation alone, with no key and no response body to test against, and
shipping it as though it worked would be a bigger lie than the substitution it
was meant to avoid. Add `src/lib/kyb/middesk.ts` implementing
`KybLegProvider<'live'>` for `business_registry`, then set that rung's `build`.
No other file changes.

Until then, **setting `MIDDESK_API_KEY` does not silently do nothing.** The rung
falls through to the next one — it has to — but it carries a note out with it,
and the wiring panel and the health report both print:

> `MIDDESK_API_KEY` is set, but no Middesk adapter has been written … This leg
> has therefore FALLEN THROUGH to the next rung and is NOT Middesk.

A key that looks like it took effect and did not is the exact shape of failure
this module exists to prevent.

### Stripe Connect needs its own opt-in

`STRIPE_SECRET_KEY` is already spent on the *director* leg. If the Connect rung
matched on it alone, shipping the ladder would have silently moved the registry
leg onto an adapter measured non-functional on this account — Accounts v1 is
retired for new integrations and `POST /v2/core/accounts` is not wired here. So
that rung requires `STRIPE_CONNECT_KYB` as well. One shared credential must not
select two unrelated capabilities.

---

## Operational note: `KYB_FORCE_SIMULATED` currently suppresses this leg

The environment carries `KYB_FORCE_SIMULATED=business_registry`, set back when
the registry leg was Stripe Connect and Connect turned out to be gated. It is
now suppressing a working, credential-free, live registry.

**Unset it** (in Vercel and in `.env`) for the registry leg to run on GLEIF. The
escape hatch stays in the code because it is the documented way to demonstrate
the composite's evidence-degradation rule on demand — `?state=edge` on
`/onboarding` shows what it looks like — but it should not be on by default.

While it is set, the screen says so in words rather than reading "live".

---

## What the screen shows

`/onboarding`, five URL-driven states, unchanged:

| URL | State |
| --- | --- |
| `/onboarding` | the live derived state, read from Neon |
| `?state=loading` | the real skeleton, held open by a genuinely slow read |
| `?state=empty` | no businesses on the book |
| `?state=error` | the state read failed; retry is live |
| `?state=edge` | a real verified Stripe Identity session + a forced simulator registry leg: **approved on `simulated` evidence**, because evidence degrades and never un-degrades |

On the live state, per business: the derived status and evidence badges, **who
decided it** (the legs whose own status equals the derived one, with the
provider's own machine-readable code and the citation), the evidence rows
themselves, both `canTransact()` readings side by side — this deployment's and
`requireLiveEvidence`'s — where money would land, and the four verbs.

The **Ask the registry** panel runs the live adapter against any name or LEI and
writes nothing, about anybody. It carries one-click worked examples for each
outcome in the reachability table above.

Identity sessions are created **only on an explicit action**, never on render: a
render path that creates provider objects litters a real Stripe account on every
page load, prefetch and bot. `beginVerification()` additionally refuses a second
session for a business that already has evidence on file. The registry leg is a
read against a key-less public index, so `Re-check the registry` is free to
repeat — and with an LEI in the box it asks a *different* question, because an
asserted identifier can be confirmed, contradicted, or never heard of.

The applicant's LEI claim is **not stored**. `kyb_verification_leg` records what
a provider said, and "the applicant says their LEI is X" is not that. What lands
in the table is GLEIF's answer, under GLEIF's name, with GLEIF's own code — or,
when the identifier does not exist, a `gleif.notfound.` reference that says so
in the id itself.

---

## Current state of the book

All three seeded businesses are fictional. All three miss the registry. Both
legs are answered by third parties, so the composite is labelled `live` — and
`live` is a statement about **who answered**, never about what they said.

| Business | Director leg | Registry leg | Composite |
| --- | --- | --- | --- |
| Ridgeline Robotics, Inc. | `approved` — Stripe `verified` | `needs_review` — `not_in_lei_registry` | `needs_review`, evidence `live` |
| Kettle & Crumb Bakery LLC | `needs_review` — Stripe `requires_input` + `document_unverified_other` | `needs_review` — `not_in_lei_registry` | `needs_review`, evidence `live` |
| Silverline Freight Co. | `pending` — Stripe `requires_input` | `needs_review` — `not_in_lei_registry` | `needs_review`, evidence `live` |
| Holds Integration Fixture Co. | none | none | `pending` — nothing on file, so `KYB_NOT_STARTED` |

None of them may transact, and the reason differs per row. That is the sentence
this screen exists to make true: **an unverified entity can look, but not
transact** — enforced twice, once by `canTransact()` and once structurally,
because a business gets its `2100` deposit account on approval and not before,
and money has nowhere to land until then.

---

## What remains simulated, and why

- **The director leg's `rejected`.** Not reachable on Stripe Identity; the
  transcript is above. Left unreachable rather than faked.
- **`?state=edge`.** A fixture, labelled FIXTURE in the header, of a state the
  live deployment is not in. It exists so the evidence-degradation rule can be
  shown on demand rather than asserted.
- **`SimulatedRegistryProvider` / `SimulatedDirectorKycProvider`.** Reachable
  only through `KYB_FORCE_SIMULATED`, and every answer they give is prefixed
  `simulated:` in its own reference id, its own raw status and its own reasons.
  The database refuses a row claiming `live` evidence while carrying a `sim.`
  reference.
- **Middesk and Sumsub adapters.** Not written, for the reason above.

---

## Files

| Path | What lives there |
| --- | --- |
| `src/lib/kyb/types.ts` | the status lattice, the evidence label, `canTransact()` |
| `src/lib/kyb/composite.ts` | strictest-wins, evidence degradation, and the six forgery routes it closes |
| `src/lib/kyb/gleif.ts` | the registry adapter: matching, the verdict fold, citations |
| `src/lib/kyb/registry-precedence.ts` | the ladder, and the swap procedure in code |
| `src/lib/kyb/persona.ts` | the shared Inquiries machinery, the director leg, and the KYB leg that a template id would select |
| `src/lib/kyb/wire.ts` | Stripe Identity, selection, persistence, the gate, the probe |
| `src/app/(app)/onboarding/actions.ts` | the four verbs and the probe, each an untrusted POST |
| `src/components/onboarding/` | the screen, its data contract, and its fixtures |
