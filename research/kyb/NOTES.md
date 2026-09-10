# KYB / KYC provider research — can I get a real sandbox live today, free, self-serve?

Research date: **2026-09-09**. No accounts were created during this research; everything
below comes from public documentation, help-center articles and pricing pages. Anything I
could not confirm from a primary source is marked **UNCONFIRMED**.

---

## TL;DR verdict

**No dedicated KYB vendor will give you a free self-serve sandbox today.** Persona,
Middesk and Sumsub all gate business verification behind a sales conversation, an
account-manager provisioning step, or a credit card.

**But you are not stuck simulating the business leg.** The best result of this research is
that **Stripe Connect test mode performs a real company-registry check, free and
self-serve, with published magic EINs that force "company not found in registry", "owners
not found in registry", "directors not found in registry" and "pending response from
registry"** — returned as structured `requirements.errors[]` codes over signed webhooks.
That is a genuine KYB-shaped third-party signal at $0. See [§4.4](#44--stripe-connect-test-mode--the-actual-free-kyb-shaped-signal).

Note also that Persona's often-cited **$0 "Starter" plan no longer exists** — G2 and Vendr
still list it, but it is historical. What you get today is a 60-day sandbox-only trial, one
per business. See [§1.2](#12-what-the-free-tier-actually-is).

| Provider | Self-serve sandbox? | KYB in that sandbox? | Can you script every state? | Verdict |
|---|---|---|---|---|
| **Persona** | **Yes** — immediate sandbox key. 60-day Essential trial, sandbox-only, no card, but **one trial per business, ever** | **No** — Business Verification is "Not Available" free, and a separate purchase requiring support even at $250/mo | **Yes** — `perform-simulate-actions` drives every status and fires real webhooks | **Primary, for KYC** |
| **Stripe Connect** | **Yes** — test keys instantly (caveat: account must have "begun Connect platform onboarding") | **Effectively yes** — real registry check on company name / EIN / owners / directors | **Yes** — published magic EINs `222221000`–`222221005` | **Primary, for the business leg** |
| Stripe Identity | **Yes** — test-mode keys instantly | **No** — individual KYC only | **No** — see the negative finding in §4.3; only `cancel` is scriptable | Backup KYC only |
| Middesk | **No** — keys provisioned by sales; `middesk.com/pricing` 404s | (n/a) | (n/a) | Out |
| Sumsub | Signup yes, but Sandbox is doc'd as requiring "trialing or full access", and trial activation asks for **bank card + company information** | Yes, if you get in | Yes (`testCompleted`) | Out on the $0 / no-company constraint |

**Recommendation: Persona sandbox for live director KYC (because it is the only provider
that lets you drive pending / declined / needs-review from the server), plus Stripe Connect
test mode for the business-registry leg, behind one `KybProvider` interface — with a
labelled simulated registry as the fallback if Connect onboarding turns out gated.**
See [§5](#5-recommendation--the-honest-architecture).

The single most valuable capability here is Persona's **`perform-simulate-actions`**
endpoint: it drives a sandbox inquiry to `pending` / `approved` / `declined` /
`needs_review` on demand *and fires the real webhooks for each transition*. Stripe Identity
notably **cannot** do this — verified negative finding, §4.3.

---

## 1. Persona: is the sandbox self-serve? What's in the free tier? Is KYB included?

### 1.1 Sandbox is genuinely self-serve

From the API Keys doc (https://docs.withpersona.com/api-keys), verbatim:

> ### Sandbox
> [Sign up](https://withpersona.com/dashboard/signup) to get immediate access to a sandbox API key and start evaluating the API with sample data.
>
> ### Production
> When you're ready to use the API in production using live data, please [contact us](https://app.withpersona.com/dashboard/contact-us).

So: **sandbox = self-serve, production = sales call.** That is fine for this trial — the
requirement is a real third-party sandbox, not production.

I confirmed `https://withpersona.com/dashboard/signup` 301s to
`https://app.withpersona.com/dashboard/signup`, which returns 200. The page is a JS SPA and
returns no readable form markup to an automated fetch.

**On the email question:** the only public statement is from
https://docs.withpersona.com/api-quickstart-tutorial, verbatim — *"Register with your
**business email** and create your organization."* **UNCONFIRMED whether a gmail.com
address is actually rejected**; that may be guidance rather than enforcement, and no page
states a free-mail domain block. Don't plan around either answer — have a domain-backed
address ready if you own one, but try the personal one first. No credit card is required
either way.

**Fetch-access caveat, stated for honesty:** `withpersona.com` (the marketing site,
including `/pricing` and `/startups/`) and `support.withpersona.com` return **HTTP 403** to
automated fetching, and Wayback was unavailable. **Neither I nor the second researcher ever
read the pricing page's feature-comparison table.** Every plan/tier claim in this document
comes from `help.withpersona.com` and `docs.withpersona.com` — same company, and explicit —
but if you want the pricing page's own table, open it in a browser yourself.

### 1.2 What the free tier actually is

> **Watch out: the "free Starter plan, 500 verifications/month" you'll find on G2 and
> Vendr is stale.** Persona did launch a $0 Starter tier in Dec 2020 and the blog post
> (https://withpersona.com/blog/free-identity-verification/) is still live, but the current
> help center lists only **Essential / Growth / Enterprise**, and puts those 500 free
> services *inside* the $250/mo Essential plan. **There is no permanent free tier today.**
> **UNCONFIRMED** when it was retired — Persona never announced it. If any part of the
> trial brief assumes a free Starter plan, that assumption is out of date.

What actually exists is a trial. From the Plans Overview help article
(https://help.withpersona.com/articles/6oZbzp7jb7AWGClF5vpY3K/) and
https://help.withpersona.com/articles/4IzxlP0GOewGYkpG5fXah6/:

> To get started with Persona, you can start a free trial with no credit card required.
> During the 60-day trial, you'll have full access to the features available under the
> Essential Plan (up to 50 services). **By default the trial only features access to a
> Sandbox environment.**

and, from the same article:

> **Businesses are only allowed one trial experience and extensions for trials are
> uncommon.**

**You get one Persona trial, ever, per business.** Don't burn day 1 spelunking — decide
what you're building first, then sign up.

Also verbatim, on why production won't happen this week:

> Additional information and a **business verification review from our compliance team**
> may be required to request a trial with a Production environment.

Paid tiers: **Essential** from $250/mo annual (500 services/mo, then $1.50/service),
**Growth** (custom), **Enterprise** (custom).

**Tension worth knowing about, UNCONFIRMED:** the Environments doc says sandbox incurs *no
usage charges*, but the trial is described as "up to 50 services" *and* sandbox-only. No
page reconciles those. Assume the 50-service cap applies in sandbox and budget your
simulate-action calls accordingly.

Sandbox specifics (https://help.withpersona.com/articles/6I2kGhfPvSuUjYq4z6tpmB/):

- Sandbox API keys are prefixed **`persona_sandbox`**.
- "Persona doesn't perform any real verification or extraction of IDs within Sandbox."
- Sandbox inquiry name fields are **always overwritten to `Alexander J Sample`** — do not
  build assertions on the name you submitted coming back.
- Product runs "do not carry over between Sandbox and Production environments."

Separately there is a **Startup Program**
(https://help.withpersona.com/articles/1XNnqukfZY9VamF2e7jkuJ/) — 500 free Government ID
(+ optional Selfie) verifications and 1000 Relay services per month for a year, for
companies with <$5M funding / <50 employees. **It is application-based**, you apply from
Organization > Billing in the dashboard, and acceptance grants *production* access. Not
same-day, and not needed here.

**Sandbox itself is not metered.** From https://docs.withpersona.com/environments:

> Sandbox mode is provided so that you can test your integration without incurring any
> usage charges. **Real verifications are not performed within sandbox mode.**
> A toggle is provided that allows you to force passes or force fails so that you can view
> and test all the possible states for your integration.

### 1.3 KYB — this is where it falls down

**Persona's Business Verification / KYB is not on the free tier.** Persona publishes
per-feature plan-availability tables in the help center, and four of them agree:

| Feature | Startup | Essential | Growth | Enterprise |
|---|---|---|---|---|
| Business Verification Solution | **Not Available** | **Limited** | Available | Available |
| Business Registry Verification | **Not Available** | Available | Available | Available |
| Business Watchlist Report | **Not Available** | **Limited** (config is view-only) | Available | Available |
| Business Associated Persons | **Not Available** | **Not Available** | Available | Available |

Sources: https://help.withpersona.com/articles/4Z9k3Y9n4xlN6jMQpoVrGu/,
https://help.withpersona.com/articles/3pkLBWKg5wIQJru7PATxBc/,
https://help.withpersona.com/articles/4y3oaeL7pc2f5DHKT50smE/,
https://help.withpersona.com/articles/3pBDySJ0AAqp35RaYmeKzc/

And the decisive line, verbatim:

> To add either Business Verification Solution or the KYB Solution, please contact Persona
> support for assistance.

Even on Essential ($250/mo) the Business Verification Solution "**is bought on its own**" —
a separate purchase requiring a support conversation, not a checkbox. On Growth/Enterprise
it arrives bundled as part of KYB. Business Associated Persons access is "enabled at the
report template level" → "reach out to your account team."

**One genuine maybe, worth 10 minutes after signup.** The trial grants "features available
under the Essential Plan", and **Business Registry Verification is listed `Available` on
Essential** (unlike the packaged Business Verification *Solution*, which is `Limited`).
So it is *possible* a trial org can run a BRV verification in sandbox. **UNCONFIRMED** —
"features available under Essential" may or may not include an add-on that Essential
customers have to buy separately, and nothing states which way it resolves. Check
`Dashboard > Verification Templates` filtered to `verification-template/database-business`
before assuming either answer. If it's there, your business leg gets materially more real.
Plan for it not to be.

The API-first KYB guide (https://docs.withpersona.com/integration-guide-kyb-via-api) says
the same thing in developer terms, in its very first pre-integration checkbox:

> Make sure your organization is set up with the requisite transaction and workflows!
> **Reach out to your Persona team for support with this.**

That flow is built on **Transactions** and needs a `transaction_type_id` that only Persona
can provision for your org. There is no self-serve way to create one.

**Conclusion: Persona KYB is gated. Persona KYC is not.** Treat this as settled.

#### What *is* reachable on a sandbox key, business-wise (partially)

- `POST /api/v1/verification/database-businesses` (Database Business Verification) exists
  in the public API reference and accepts `business-name`, `registration-number`,
  `address-*`, plus a `verification-template-id`. It also takes
  `meta.debug-forced-status`, which is exactly the sandbox override we'd want.
  **UNCONFIRMED on two counts**: (a) whether a free sandbox org is given a
  `verification-template/database-business` template at all — the dashboard filter link in
  the docs implies you need one to already exist; (b) the allowed values of
  `debug-forced-status` are not enumerated anywhere (`passed`/`failed` is the obvious
  guess, matching the `debug` field on Transactions).
- Business **Reports** (Business Watchlist, Business Adverse Media, Business Lookup,
  Business Registrations Lookup) exist as report types with published sandbox test
  triggers — https://help.withpersona.com/articles/56sLAbSytkmI57zpbug3xc/ says
  **`Globovision`** forces a hit on Business Watchlist and Business Adverse Media, and
  **`Globovision` + `4100 Salzedo Street Coral Gables, FL 33146`** exercises Business
  Lookup. **But the report *templates* are the gate, not the endpoints.**
  https://docs.withpersona.com/reports lists only **9** report types and **Business Lookup
  is not among them**, with the warning *"If you are missing a template type you need,
  please contact us for assistance."* The endpoint exists (`POST /api/v1/reports/biz-lookup`,
  US entities only) but is not in the default template set.
  **UNCONFIRMED whether any business report template is pre-created on a trial org.**
  Worth 5 minutes of poking after signup — upside, not the plan.

### 1.4 Exact steps: signup → API key → template ID → inquiry ID

1. Go to **https://withpersona.com/dashboard/signup** (redirects to
   `app.withpersona.com/dashboard/signup`). Create the org. No credit card.
2. You land in the dashboard with an **environment switcher** in the top bar. Confirm it
   says **Sandbox**.
3. **API key**: `Dashboard > API > API Keys`
   (https://app.withpersona.com/dashboard/api-keys) → create/reveal the sandbox key.
   Sandbox and production have *separate* keys. Set permissions to at least
   `inquiry.read`, `inquiry.write`, `webhook.read`, `webhook.write`.
   → gives you `PERSONA_API_KEY`.
4. **Inquiry template**: `Dashboard > Inquiries > Templates`
   (https://app.withpersona.com/dashboard/inquiry-templates). Use or duplicate a
   Government ID + Selfie template. Copy the ID — a **Dynamic Flow** template ID starts
   with `itmpl_`; a deprecated Legacy one starts with `tmpl_`. You want `itmpl_`.
   → gives you `PERSONA_INQUIRY_TEMPLATE_ID`.
   (If you want to use `create_passed_verification` / `create_failed_verification` in
   simulate-actions, also grab the **verification template** ID, `vtmpl_…`, from
   `Dashboard > Verification Templates`.)
5. **Webhook**: `Dashboard > Integration > Webhooks`
   (https://app.withpersona.com/dashboard/webhooks) → add your deployed Vercel URL, select
   the `inquiry.*` events, and copy the `wbhsec_…` secret.
   → gives you `PERSONA_WEBHOOK_SECRET`.
6. **Environment ID** (optional, for hosted-flow links): visible in the dashboard as
   `env_…`.
7. Create your first inquiry — see §2. → gives you an `inq_…`.

**UNCONFIRMED:** whether a brand-new sandbox org ships with a ready-made Government ID
inquiry template or whether you have to build one in the flow editor. The editor is
drag-and-drop and self-serve either way, so this is minutes, not a blocker.

---

## 2. Persona Inquiry API — creating inquiries and driving every state

Base URL: **`https://api.withpersona.com/api/v1`**
(`https://withpersona.com/api/v1` also appears in Persona's own cookbooks — same surface.)

Auth (https://docs.withpersona.com/authentication):

```
Authorization: Bearer $API_KEY
```

Always over HTTPS. Also send `Persona-Version: 2025-12-08` to pin payload shapes, and
`Key-Inflection: kebab` to make the response casing explicit.

### 2.1 Create an inquiry server-side

`POST /api/v1/inquiries` — https://docs.withpersona.com/api-reference/inquiries/create-an-inquiry

```bash
curl -X POST https://api.withpersona.com/api/v1/inquiries \
  -H "Authorization: Bearer $PERSONA_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Persona-Version: 2025-12-08" \
  -H "Key-Inflection: kebab" \
  -H "Idempotency-Key: kyb-create-biz_123" \
  -d '{
    "data": {
      "attributes": {
        "inquiry-template-id": "itmpl_XXXXXXXXXXXXXXXX",
        "fields": {
          "name-first": "Jane",
          "name-last": "Doe",
          "birthdate": "1990-01-01",
          "email-address": "jane@example.com",
          "address-street-1": "123 Main St",
          "address-city": "San Francisco",
          "address-subdivision": "California",
          "address-postal-code": "94111",
          "address-country-code": "US"
        }
      }
    },
    "meta": {
      "auto-create-account": true,
      "auto-create-account-reference-id": "biz_123",
      "auto-create-one-time-link": true
    }
  }'
```

Notes that will bite you:

- Use `inquiry-template-id` for `itmpl_…`, `template-id` for legacy `tmpl_…`,
  `inquiry-template-version-id` for `itmplv_…`. Exactly one of the three.
- `fields.address-subdivision` on the **Inquiries** API wants the **unabbreviated** US
  state name ("California"). The **KYB Transactions** guide wants the **abbreviated**
  ISO 3166-2 form ("CA"). Don't share a formatter between them.
- `reference-id` on `data.attributes` is **deprecated** in favour of
  `meta.auto-create-account-reference-id`.
- **Inquiries expire after 24h by default.** Create them at the moment the user needs them,
  or override with `meta.expiration-after-create-interval-seconds`.
- `Idempotency-Key` is supported — use it.

Response is JSON:API: `data.id` is `inq_…`, `data.attributes.status` is `created`.

Retrieve: `GET /api/v1/inquiries/{inquiry-id}`
(https://docs.withpersona.com/api-reference/inquiries/retrieve-an-inquiry).

### 2.2 Hosted flow vs embedded flow

**Hosted flow** (https://docs.withpersona.com/hosted-flow) — zero client code, just a link.
Verified URL shapes:

```
# client-side inquiry creation from a template
https://inquiry.withpersona.com/verify?inquiry-template-id=itmpl_XXXXXXXXXXXXX

# resume a server-created inquiry (what you want)
https://inquiry.withpersona.com/verify?inquiry-id=inq_XXXXXXXXXXXXX

# with extras
https://inquiry.withpersona.com/verify?inquiry-template-id=itmpl_XXXX&environment-id=env_XXXX&reference-id=user_id1&language=ja&fields[name-first]=Jane

# resumed with a session token + redirect
https://inquiry.withpersona.com/verify?inquiry-id=inq_XXXX&session-token=123456&redirect-uri=https://withpersona.com/done
```

Orgs can be given a custom `<subdomain>.withpersona.com/verify` host.
`redirect-uri` destinations must be on a **domain allowlist** you configure
(https://docs.withpersona.com/hosted-flow-security) — add your Vercel domain early, it's an
easy thing to get stuck on at demo time.

**Embedded flow** (https://docs.withpersona.com/embedded-flow) — the `persona` JS SDK (v5)
opens the same flow in an iframe/modal inside your Next.js page. Better UX, and you can
pre-create the inquiry server-side and hand the client the `inq_…` plus a session token
(https://docs.withpersona.com/tutorial-embedded-flow-precreate). Persona is explicit that
client callbacks are **not** a source of truth:

> Handle Embedded Flow UI events without relying on callbacks for critical business logic.

Decide status from webhooks / the API, never from the browser.

**For a 48h trial: start with hosted flow.** It's a link, it works on mobile, and it
removes an entire class of iframe/CSP problems. Swap to embedded only if there's time.

### 2.3 Driving PENDING / APPROVED / DECLINED / NEEDS_REVIEW — the important part

Two mechanisms. Use both.

#### (a) Programmatic: `perform-simulate-actions` — the one that matters

`POST /api/v1/inquiries/{inquiry-id}/perform-simulate-actions`
— https://docs.withpersona.com/api-reference/inquiries/perform-simulate-actions
— https://docs.withpersona.com/integration-testing

> Performs a series of simulated actions on a **Sandbox** Inquiry.

Each action changes the inquiry status **and fires the corresponding real webhook event**:

| Simulate action | Resulting status | Event fired |
|---|---|---|
| `start_inquiry` | `pending` | `inquiry.started` |
| `complete_inquiry` | `completed` | `inquiry.completed` |
| `fail_inquiry` | `failed` | `inquiry.failed` |
| `expire_inquiry` | `expired` | `inquiry.expired` |
| `mark_for_review_inquiry` | `needs_review` | `inquiry.marked-for-review` |
| `approve_inquiry` | `approved` | `inquiry.approved` |
| `decline_inquiry` | `declined` | `inquiry.declined` |

Plus verification-level actions:

| Simulate action | Effect |
|---|---|
| `create_passed_verification` | creates a `passed` Verification, fires type-specific events then `verification.created` → `verification.submitted` → `verification.passed` |
| `create_failed_verification` | same but `failed` |

Both take `data["verification-template-id"]` (a `vtmpl_…`). Supported verification types
for this: Government ID, Document, Database, Selfie. Government ID / Document additionally
fire `document.created/submitted/processed`; Selfie fires `selfie.created/submitted/processed`;
Database fires none.

Verbatim request body from the API reference:

```json
{
  "meta": {
    "simulate-actions": [
      { "type": "start_inquiry" },
      { "data": { "verification-template-id": "vtmpl_CCLT7pvBZM8z5fumdb3QvW5cSrdr" }, "type": "create_failed_verification" },
      { "data": { "verification-template-id": "vtmpl_CCLT7pvBZM8z5fumdb3QvW5cSrdr" }, "type": "create_passed_verification" },
      { "type": "complete_inquiry" },
      { "type": "approve_inquiry" }
    ]
  }
}
```

Ready-to-run curls for the four demo states:

```bash
INQ=inq_XXXXXXXXXXXXXXXX
AUTH="Authorization: Bearer $PERSONA_API_KEY"
SIM="https://api.withpersona.com/api/v1/inquiries/$INQ/perform-simulate-actions"

# PENDING
curl -X POST "$SIM" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"meta":{"simulate-actions":[{"type":"start_inquiry"}]}}'

# APPROVED (with a passing gov-ID verification attached)
curl -X POST "$SIM" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"meta":{"simulate-actions":[
        {"type":"start_inquiry"},
        {"type":"create_passed_verification","data":{"verification-template-id":"vtmpl_XXXX"}},
        {"type":"complete_inquiry"},
        {"type":"approve_inquiry"}]}}'

# DECLINED (failing verification)
curl -X POST "$SIM" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"meta":{"simulate-actions":[
        {"type":"start_inquiry"},
        {"type":"create_failed_verification","data":{"verification-template-id":"vtmpl_XXXX"}},
        {"type":"complete_inquiry"},
        {"type":"decline_inquiry"}]}}'

# NEEDS_REVIEW
curl -X POST "$SIM" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"meta":{"simulate-actions":[
        {"type":"start_inquiry"},
        {"type":"complete_inquiry"},
        {"type":"mark_for_review_inquiry"}]}}'
```

This is the demo backbone: a "simulate outcome" control in your admin UI calls this, and
your app learns the result the same way it would in production — via a signed webhook from
Persona's servers to your Vercel deployment. Nothing is short-circuited.

#### (b) Interactive: the sandbox force pass/fail toggle

If you want to click through the real hosted flow on camera: in Sandbox, the flow's
right-hand **Simulate** panel has an **Advanced mode** toggle. Click through to the
Government ID screen, open **Check Results**, and select which checks should fail (e.g.
*Compromised submission*). **You can upload any photo as the ID in sandbox** — the outcome
comes from the Check Results you set, not the image.
(https://help.withpersona.com/articles/1az3sGqpcW5Zrne9I7lm49/,
https://docs.withpersona.com/environments)

#### (c) Report hits (if you get business report templates)

`Dashboard > Reports > All Reports > + Create report`, then use these published test values
(https://help.withpersona.com/articles/56sLAbSytkmI57zpbug3xc/):

| Report | Test value that forces a hit |
|---|---|
| Watchlist / Adverse Media | `Kim Jong Un` (or `Jong Kim Un`) |
| PEP | `Boris Johnson` |
| **Business Watchlist** | `Globovision` |
| **Business Adverse Media** | `Globovision` |
| **Business Lookup** | `Globovision` + `4100 Salzedo Street Coral Gables, FL 33146` |
| Crypto Address Watchlist | `1Fz29BQp82pE3vXXcsZoMNQ3KSHfMzfMe3` |
| Email Risk | `alexanderjsample@example.com` |
| Phone Risk | `+15005550006` |

Via API: `POST /api/v1/reports` with `data.attributes["report-template-id"]`, then poll
`GET /api/v1/reports/{id}` until `status` is `ready`
(https://docs.withpersona.com/reports-cookbook).

### 2.4 Inquiry lifecycle reference

From https://docs.withpersona.com/model-lifecycle:

| Phase | Status | Event | Meaning |
|---|---|---|---|
| Created | `created` | `inquiry.created` | Inquiry first created |
| Pending | `pending` | `inquiry.started` | User submitted a doc / began a verification |
| Done | `completed` | `inquiry.completed` | User reached the Completed screen |
| Done | `failed` | `inquiry.failed` | User reached the Failed screen |
| Done | `expired` | `inquiry.expired` | 24h (or configured) elapsed |
| Post-Inquiry | `approved` | `inquiry.approved` | Decision, via workflow or manual |
| Post-Inquiry | `needs review` | `inquiry.marked-for-review` | Decision |
| Post-Inquiry | `declined` | `inquiry.declined` | Decision |

Persona's own advice:

> When selecting which events … to configure in your webhooks we strongly recommend
> configuring both `approved` & `declined` as they are the most actionable.

Note the modelling subtlety worth calling out in your writeup: `completed` means *the user
is done*, not *we said yes*. Approved/declined/needs-review are a separate post-inquiry
decision phase. Map `completed` to your own "pending review", not to "verified". The
adapter in `adapter.draft.ts` does this.

Also from the API reference, verbatim, and worth respecting:

> Do not assume this is a static enumeration; Persona may add new values in the future
> without a versioned update.

---

## 3. Persona webhooks — registration, events, and the exact signature scheme

### 3.1 Registration

Dashboard: **Integration > Webhooks** (https://app.withpersona.com/dashboard/webhooks).
Webhooks are **per-environment** — a sandbox webhook only receives sandbox events.

Or via API — `POST /api/v1/webhooks`
(https://docs.withpersona.com/api-reference/webhooks/create-a-webhook):

```bash
curl -X POST https://api.withpersona.com/api/v1/webhooks \
  -H "Authorization: Bearer $PERSONA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "attributes": {
        "name": "corgi-neobank-sandbox",
        "url": "https://<your-app>.vercel.app/api/webhooks/persona",
        "enabled-events": [
          "inquiry.created", "inquiry.started", "inquiry.completed",
          "inquiry.failed", "inquiry.expired",
          "inquiry.approved", "inquiry.declined", "inquiry.marked-for-review",
          "verification.passed", "verification.failed"
        ],
        "api-version": "2025-12-08",
        "api-key-inflection": "kebab"
      }
    }
  }'
```

`*` enables all events. The response carries the secret:

```json
{ "data": { "attributes": {
  "secret": "wbhsec_abcdefgh-1234-5678-9ijk-lmnopqrstuvw",
  "secrets": [ { "value": "wbhsec_abcdefgh-1234-5678-9ijk-lmnopqrstuvw", "expires-at": null } ]
}}}
```

`secret` (singular) is **deprecated in favour of `secrets`** (a list, to support rotation).

Rotation: `POST /api/v1/webhooks/{webhook-id}/rotate-secret`, optional body
`{"meta":{"expires-in-seconds":N}}` — the old secret stays valid for that long.
(https://docs.withpersona.com/api-reference/webhooks/rotate-a-webhook-secret)

### 3.2 Delivery semantics

From https://docs.withpersona.com/webhooks and
https://docs.withpersona.com/webhooks-best-practices:

- POST, JSON:API format. Return `200`/`201`/`202`/`204`.
- **You have 5 seconds.** Miss it and Persona retries **up to 7 additional times with
  exponential backoff**. → ack first, process async.
- **Events are not ordered.** "Please utilize the `data.attributes.created-at` field to
  determine creation ordering."
- **Duplicates happen.** "We recommend making your event processing idempotent."
- Webhook API version is pinned per webhook and can differ between webhooks.

Payload envelope (verbatim example from the docs):

```json
{
  "data": {
    "type": "event",
    "id": "evt_XGuYWp7WuDzNxie5z16s7sGJ",
    "attributes": {
      "name": "inquiry.approved",
      "payload": {
        "data": {
          "type": "inquiry",
          "id": "inq_2CVZ4HyVg7qaboXz2PUHknAn",
          "attributes": {
            "status": "approved",
            "reference-id": null,
            "created-at": "2019-09-09T22:40:56.000Z",
            "completed-at": "2019-09-09T22:44:51.000Z",
            "expired-at": null
          }
        }
      }
    }
  }
}
```

So: event name at `data.attributes.name`, the affected object at
`data.attributes.payload.data`.

There is also a **Webhook Event Simulation** feature
(https://docs.withpersona.com/webhook-event-simulation) — but read the warning: *"Simulation
does not deliver actual Webhook Events to your Webhook's server URL."* It only previews the
payload and tells you whether it would deliver or skip. It is **not** a way to test your
endpoint. Use `perform-simulate-actions` for that; it produces real deliveries.

### 3.3 Signature verification — the exact recipe

Full text from https://docs.withpersona.com/webhooks-best-practices:

> Requests from webhooks will contain a `Persona-Signature` header with a
> hexadecimal-encoded HMAC. You should check that any request is authentic and safe to
> process by comparing this value with your own digest, computed from the request body and
> your webhook secret.
>
> The `Persona-Signature` header contains two comma-separated key-value pairs … The first
> key-value pair will be in the form `t=<unix_timestamp>` and represents the unix time that
> the request was sent. The second key-value pair will be in the form `v1=<signature>`,
> where the signature is computed from your webhook secret and a **dot-separated string
> composed of the unix timestamp joined with the request body**.
>
> It's possible to have more than one valid signature for a webhook if its secrets are in
> the process of rotating. … In this case, the `Persona-Signature` header will contain
> **two space-separated sets** of the key-value pairs described above.

Distilled:

| | |
|---|---|
| **Header** | `Persona-Signature` |
| **Format** | `t=<unix_seconds>,v1=<hex>` — during rotation, two groups separated by a **space**: `t=..,v1=<new> t=..,v1=<old>` |
| **Algorithm** | HMAC-SHA256, **hex** digest |
| **Signed string** | `` `${t}.${rawBody}` `` — literal `.` between timestamp and raw body |
| **Secret** | the `wbhsec_…` value |
| **Timestamp tolerance** | **Not documented by Persona.** See below. |
| **Rotation** | accept **either** signature; rotate via dashboard or the rotate-secret API |

Persona's own Node sample (verbatim from https://docs.withpersona.com/quickstart-webhooks):

```javascript
function verifyPersonaSignature(rawBody, signatureHeader, webhookSecret) {
  // Format: "t=<timestamp>,v1=<signature>" or multiple space-separated pairs during rotation
  const signaturePairs = signatureHeader.split(' ');
  const firstPair = signaturePairs[0];
  const timestamp = firstPair.split(',')[0].split('=')[1];

  const signatures = signaturePairs.map(pair => {
    const v1Match = pair.match(/v1=([^,]+)/);
    return v1Match ? v1Match[1] : null;
  }).filter(sig => sig !== null);

  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(timestamp + '.' + rawBody)
    .digest('hex');

  return signatures.some(signature =>
    crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature)));
}
```

Reproduce a signature by hand (useful for testing your handler without Persona):

```bash
BODY='{"data":{"type":"event","id":"evt_test","attributes":{"name":"inquiry.approved"}}}'
SECRET='wbhsec_your_secret'
T=$(date +%s)
SIG=$(printf '%s' "$T.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -r | cut -d' ' -f1)

curl -X POST https://<your-app>.vercel.app/api/webhooks/persona \
  -H "Content-Type: application/json" \
  -H "Persona-Signature: t=$T,v1=$SIG" \
  --data-raw "$BODY"
```

**Two things you must get right in Next.js App Router:**

1. **Use the raw body.** Persona is explicit: *"In some languages, parsing the JSON may
   result in something that's not equivalent to the request body. For example, JavaScript
   may round floats and reduce precision. We recommend using the raw request body when
   computing the HMAC."* In a route handler: `const raw = await req.text()`, HMAC that
   string, and only then `JSON.parse(raw)`. Never `await req.json()` first and
   re-stringify.
2. **Timestamp tolerance is your job.** Persona documents `t` but publishes **no tolerance
   window and no requirement to check it** — their own samples don't. Their sample also
   reads the timestamp from the first group only. Their scheme therefore has **no built-in
   replay protection**. `adapter.draft.ts` adds a **300 s** window (and verifies each
   rotation group against its own `t`); mark that in your writeup as *our* policy, not a
   Persona-published number. **UNCONFIRMED: whether Persona intends any tolerance at all.**

Also: use `crypto.timingSafeEqual` and guard it — it throws on length mismatch, which is
itself an oracle if you let the exception escape differently from a mismatch.

---

## 4. Fallbacks

### 4.1 Middesk — sales-gated. Out.

From https://docs.middesk.com/build/api-keys, verbatim:

> Middesk provisions two keys when your account is created: one for sandbox and one for
> production.
> Contact your account manager or contact sales to inquire about access.

- No public signup. `https://app.middesk.com/` is **sign-in only**.
- `https://www.middesk.com/pricing` returns **404** — no self-serve tier at all.
- `https://agent.middesk.com/signup` does exist but is a **different product** ("Agent for
  Employers", payroll tax registration), reached via payroll-provider referral links.
  **UNCONFIRMED** that it yields `mk_test_…` Business Verification keys; assume it does not.

Recorded for completeness, because Middesk is the best-fit product if this were a real
company with a budget:

- Sandbox base URL `https://api-sandbox.middesk.com/v1/`, key prefix `mk_test`;
  production `https://api.middesk.com/v1/`, `mk_live`. Key type and URL must match.
- Auth: HTTP Basic (`-u KEY:`) **or** `Authorization: Bearer <key>`.
- `POST /v1/businesses` with `name` (req), `addresses` (req), `tin`, `website`,
  `phone_numbers`, `people`, `external_id`, `orders`.
- Business statuses: `open`, `pending`, `in_audit`, `in_review`, `approved`, `rejected`.
- **Sandbox magic values** (https://docs.middesk.com/environments) drive *individual
  insights*, not a single overall-status switch. Only these two name the overall status:
  business name containing `short analyst review` (2 min delay) or `long analyst review`
  (10 min delay) → status moves to `in_review`. Other triggers: names
  `Unregistered Business`, `Similar Name Business`, `Unverified Name Business`,
  `Young Business`, `Domestic Missing`, `Domestic Inactive`, `Domestic Unknown`,
  `Partial Inactive`; entity-type names `Corporation` / `Partnership` /
  `Sole Proprietorship` / `Trust` / `Non Profit` / `Agent` / `LLC`; addresses
  `123/223/423 Grand St., New York, NY 10013` (no match / similar / approximate) and
  substrings `cmra`, `registered agent`, `undeliverable`, `PO Box`, `virtual office`;
  TINs `110000099` (name mismatch), `111222333`, `444555666`, `222333444`, `333444555`,
  `123456789` (not found); names containing `bankruptcy`, `watchlist hit`, `highrisk`,
  `liens found`; person `Al Capone` (criminal records).
  There is **no "Middesk Test Business" magic name** — that string appears to be folklore.
- The **Enhanced Sandbox** (scenario templates) explicitly **does not support API access**:
  *"Create and manage all scenarios through the Dashboard."*
- **Webhooks**: header **`X-Middesk-Signature-256`**, HMAC-**SHA256** hex, over the **raw
  request body only** — **no timestamp is part of the signature and no timestamp header is
  documented**, so there is no replay window at all. Docs: *"Always verify the HMAC
  signature against the raw request body before parsing it as JSON."* Alternative auth
  modes: mTLS (`CN=webhooks.middesk.com`) and OIDC/OAuth JWT (JWKS at
  `https://api.middesk.com/v1/webhooks/oidc_keys`).
- **Events**: `business.created`, `business.updated` (fires on status change except
  transitions to `in_audit`), plus `order.*`, `monitor.*`, `tin.*`, `registration.*`,
  `watchlist_result.created`, `bankruptcy.created`, `lien.*`, `person.*`, `address.*`.

### 4.2 Sumsub — self-serve signup, but sandbox wants a trial, and the trial wants a card

Signup is real: **https://cockpit.sumsub.com/**, and https://sumsub.com/pricing/ shows
"Sign up for free" on the Basic ($1.35/verification) and Compliance ($1.85/verification)
plans; only Enterprise says "Contact us". 14-day trial with 50 free checks.

But two doc statements collide with the $0 / no-company constraint:

From https://docs.sumsub.com/docs/test-in-sandbox, verbatim:

> You can switch between Sandbox and Production **if you are trialing or already have full
> access to production** (that is, when you go with a subscription plan or as an enterprise
> customer).

From https://docs.sumsub.com/docs/self-service — activating that trial requires filling in
**"Billing contact"**, **"Bank card details"**, and **"Company information"** forms.

Some third-party writeups claim the sandbox is free to any registered account with no
limits. **That could not be confirmed from Sumsub's own docs, and the primary docs say the
opposite.** Given "budget is strictly $0" and "no real company to verify", **do not build
the trial on Sumsub.** (After a trial lapses, users are documented as being "limited to
Sandbox only" — implying free sandbox persists, but only *after* attaching a card.)

If it were viable, the mechanics are good and worth knowing:

- Base URL `https://api.sumsub.com` for both modes — **the token decides the mode**. Tokens
  from Dev space → App Tokens; a sandbox token cannot be used in production or vice versa.
- Headers: `X-App-Token`, `X-App-Access-Ts`, `X-App-Access-Sig`. Signature is HMAC-SHA256
  (lowercase hex) over `ts + METHOD + requestURIWithQuery + body`, e.g.
  `1607551635POST/resources/accessTokens/sdk{"ttlInSecs": 600, ...}`. *"Your timestamp must
  be within 1 minute of the API server time."*
- KYB applicant: `POST /resources/applicants?levelName=<your-kyb-level>` with
  `"type": "company"` and `fixedInfo.companyInfo { companyName, registrationNumber,
  country (ISO-3), incorporatedOn, type, email, phone, website }`.
  **UNCONFIRMED:** `kyb-level` / `basic-kyc-level` are doc examples, not guaranteed
  presets — you create the level yourself under Companies → Create level (KYB Type:
  Full KYB / Registry and AML Check / AML Check).
- **KYB sandbox mock companies** (all `country: "GBR"`):
  `Demo Company With Beneficiaries Ltd` / `99999999` (active, with beneficiaries),
  `Demo Company Ltd` / `88888888` (active, no beneficiaries),
  `Demo Company Inactive Ltd` / `77777777` (inactive).
- **Deterministic outcome forcing** (sandbox only):
  `POST /resources/applicants/{applicantId}/status/testCompleted` with
  `{"reviewAnswer": "GREEN"|"RED", "rejectLabels": [], "reviewRejectType": "RETRY"|"FINAL"}`.
  This is genuinely the nicest simulation API of the four.
- **Webhooks**: headers **`x-payload-digest`** (hex) and **`x-payload-digest-alg`**.
  Algorithms `HMAC_SHA256_HEX` (dashboard default), `HMAC_SHA512_HEX`, `HMAC_SHA1_HEX`
  (legacy fallback for old webhooks) — **read the alg from the header, don't hardcode it**.
  Digest is over the **raw body bytes only**; no timestamp, so no replay window.
- **Events**: `applicantCreated` → `applicantPending` → `applicantReviewed` (with
  `reviewResult.reviewAnswer` = `GREEN`/`RED`), plus `applicantOnHold`,
  `applicantWorkflowCompleted`, `companyStructureChanged` (KYB), and ~25 others.
- Sandbox limit: 500 applicant profiles per rolling 24h; *"Sandbox mode has no approval
  algorithms."*

### 4.3 Stripe Identity — self-serve, definitely, but KYC not KYB

#### Self-serve: yes, immediately

From https://docs.stripe.com/keys: *"When you sign up for a Stripe account, we create three
types of API keys for you"* — `pk_test_`, `rk_test_`, `sk_test_`. Nothing conditions **test**
keys on business activation.

There's an even lower-friction path — https://docs.stripe.com/cli/sandbox, verbatim:

> If your CLI isn't logged into Stripe, this command provisions a new sandbox with working
> test API keys, **without requiring an account**. … Sandbox environments expire after 7
> days.

`stripe sandbox create --email you@example.com` returns
`{"secret_key":"rkcs_test_…","publishable_key":"pk_test_…","claim_url":…,"expires_at":…}`.
**Caveat:** that secret is a *restricted* key and **UNCONFIRMED** whether it carries Identity
write scope; plus the 7-day expiry. For a 48h trial, just register normally.

**The one real unknown.** Every Identity guide
(https://docs.stripe.com/identity/verify-identity-documents) opens with:

> ## Before you begin
> 1. Set up your Stripe account and **verify your business**.
> 2. **Fill out your Stripe Identity application** (dashboard.stripe.com/identity/application).

**UNCONFIRMED whether `POST /v1/identity/verification_sessions` succeeds with a test key on
an account that has not submitted the Identity application.** Stripe's docs never say either
way. **Verify this empirically in your first 30 minutes** — it's the highest-leverage
de-risking action on the Stripe side. Geographic GA is GB / JP / US only
(https://docs.stripe.com/identity/use-cases).

#### Scope: individual KYC only. Confirmed, no KYB.

https://docs.stripe.com/identity/verification-checks lists the *complete* check set:
**Document | Selfie | ID Number | Phone (invite only) | Address (invite only)**. The `type`
enum on create has exactly two values: `document`, `id_number`.

- **Does**: government-ID document authenticity (120+ countries), selfie↔document face
  match, extracted name/DOB/address/document number, SSN/national-ID validation.
- **Does not**: company existence, EIN/TIN validation, secretary-of-state or any business
  registry lookup, UBO discovery, business watchlist/adverse media, business
  classification, director verification. None of it, at any price. There is no mention of
  KYB anywhere on the Identity product or pricing pages.

Pricing (https://stripe.com/identity): $1.50/verification, 50¢/ID-number lookup, charged on
completion — but **test mode is free and runs no checks**.

#### Identity API

```bash
curl https://api.stripe.com/v1/identity/verification_sessions \
  -u "$STRIPE_SECRET_KEY:" \
  -d type=document \
  -d "options[document][require_matching_selfie]=true" \
  -d "options[document][require_id_number]=true" \
  -d "options[document][require_live_capture]=true" \
  -d "options[document][allowed_types][]=driving_license" \
  -d "options[document][allowed_types][]=passport" \
  -d "provided_details[email]=user@example.com" \
  -d client_reference_id=user_12345 \
  -d "metadata[user_id]=12345" \
  -d return_url="https://your-app.vercel.app/verify/done"
```

Response carries `id` (`vs_…`), `client_secret` (modal; expires 24h, single use), `url`
(redirect; expires 48h, single use), `status`, `livemode`.
Also: `GET /v1/identity/verification_sessions/{id}`, `POST …/{id}/cancel`, `POST …/{id}/redact`.

Status enum (https://docs.stripe.com/api/identity/verification_sessions/object):
`requires_input` | `processing` | `verified` | `canceled`.
**Gotcha: a session is *born* `requires_input`**, so that value means both "not started" and
"failed". Disambiguate on `last_error != null`.

`last_error.code` values (https://docs.stripe.com/identity/handle-verification-outcomes):
`consent_declined`, `under_supported_age`, `country_not_supported`, `document_expired`,
`document_unverified_other`, `document_type_not_supported`, `selfie_document_missing_photo`,
`selfie_face_mismatch`, `selfie_unverified_other`, `selfie_manipulated`,
`id_number_unverified_other`, `id_number_insufficient_document_data`, `id_number_mismatch`,
`address_mismatch`.

#### ⚠️ Negative finding: Identity has NO scriptable way to force outcomes

**This is verified, and it matters.** Verbatim from
https://docs.stripe.com/api/identity/verification_sessions/create:

> If your API key is in test mode, **verification checks won't actually process**, though
> everything else will occur as if in live mode.

and https://docs.stripe.com/keys (sandbox row): *"Identity doesn't perform any verification
checks."*

The only documented mechanism is a **UI picker inside the hosted flow** — *"Submit the
session by selecting a predefined test case"* — and **Stripe never names those test cases
anywhere in its docs.** Confirmed absences:

- `docs.stripe.com/testing` has **no Identity section at all**.
- There is no `docs.stripe.com/identity/testing` page (404 — I checked).
- The full create-parameter tree contains **no** test/debug/simulate/outcome field.
- **Stripe CLI triggers**: of the 121 fixtures in `stripe/stripe-cli`, the only Identity
  ones are `identity.verification_session.created`, `.canceled`, `.redacted`. There is
  **no `verified`, `requires_input`, or `processing` fixture** —
  `stripe trigger identity.verification_session.verified` will not work.

So, practically:

| Target status | How |
|---|---|
| `canceled` | `POST /v1/identity/verification_sessions/{id}/cancel` — **the only fully scriptable one** |
| `verified` | walk the hosted flow at `session.url` and pick a test case (human, or Playwright) |
| `requires_input` (failed) | same |
| `processing` | same, and rare — document checks usually resolve synchronously |

**This is the decisive reason not to make Stripe Identity the primary provider for this
trial.** Persona's `perform-simulate-actions` does exactly what Stripe refuses to: drives
every state from the server and fires the real webhook. If you do use Identity, the honest
mitigation is to hand-craft the event JSON and self-sign it with the endpoint secret using
the scheme below — and *say in the writeup that you did that, and why*.

#### Identity webhook events

From https://docs.stripe.com/identity/verification-sessions#events:
`identity.verification_session.created`, `.processing`, `.verified`, `.requires_input`,
`.canceled`, `.redacted`.

**Trap, verbatim:** `.redacted` — *"You must create a webhook endpoint which explicitly
subscribes to this event type to access it. Webhook endpoints which subscribe to all events
won't include this event type."*

#### Stripe webhook signature scheme (verbatim)

> The `Stripe-Signature` header included in each signed event contains a timestamp and one
> or more signatures … The timestamp has a `t=` prefix, and each signature has a scheme
> prefix. Schemes start with `v`, followed by an integer. Currently, the only valid live
> signature scheme is `v1`. To aid with testing, Stripe sends an additional signature with
> a fake `v0` scheme, for test events.

```
Stripe-Signature: t=1492774577,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd,v0=6ffbb59b2300aae63f272406069a9788598b792a944a07aba816edb039989a39
```

> Stripe generates signatures using a hash-based message authentication code (HMAC) with
> SHA-256. **To prevent downgrade attacks, ignore all schemes that aren't `v1`.**

Steps, verbatim: split on `,` then `=`; `signed_payload` = *"The timestamp (as a string); The
character `.`; The actual JSON payload (that is, the request body)"*; HMAC-SHA256 with the
endpoint signing secret; constant-time compare against **every** `v1`.

> Our libraries have a **default tolerance of 5 minutes** … **Don't use a tolerance value of
> `0`.** … If Stripe retries an event … we generate a new signature and timestamp for the
> new delivery attempt.

Rotation, verbatim:

> You can have multiple signatures with the same scheme-secret pair when you roll an
> endpoint's secret, and keep the previous secret active for **up to 24 hours**. During this
> time, your endpoint has multiple active secrets and Stripe generates one signature for
> each secret.

→ **Iterate over every `v1=` value, don't just read the first.**

Trap: *"Don't verify signatures on events forwarded by the CLI using the secret from a
Dashboard-managed endpoint, or the other way around."* Both start `whsec_`, different values.

**Structural comparison with Persona, worth a line in the writeup:** both use
`t=<unix>` + HMAC-SHA256 over `` `${t}.${rawBody}` ``. The differences are the header name,
the multi-signature delimiter (Stripe: comma-separated `v1=` entries in one header;
Persona: **space-separated whole groups**), Stripe's `v0` decoy scheme, and that Stripe
publishes a tolerance while Persona publishes none. One verifier shape covers both.

#### Test-mode webhooks to a deployed Vercel URL — confirmed yes

The CLI listener is the fallback for people *without* a public URL, not a requirement.
*"Registered webhook endpoints must be publicly accessible HTTPS URLs."* Register with a
test key:

```bash
curl https://api.stripe.com/v1/webhook_endpoints \
  -u "$STRIPE_TEST_SECRET_KEY:" \
  -d url="https://your-app.vercel.app/api/stripe/webhook" \
  -d "enabled_events[]"="identity.verification_session.verified" \
  -d "enabled_events[]"="identity.verification_session.requires_input"
```

Test-mode retry policy differs: *"We retry event deliveries created in a sandbox three times
over the course of a few hours"* (vs three days in live).

**Vercel gotchas:**

- **Redirects count as failures**, verbatim: *"We consider redirect responses to webhook
  requests as failures. Set the webhook endpoint destination to the URL resolved by the
  redirect."* Watch `www` → apex and trailing slashes. Point Stripe at the *final* URL.
- *"Stripe webhooks support only TLS versions v1.2 and v1.3."*
- Max 16 webhook endpoints per account.
- Raw body: in App Router use `await req.text()`. Stripe publishes a working example at
  `stripe-node/examples/webhook-signing/nextjs/app/api/webhooks/route.ts`.

---

### 4.4 ⭐ Stripe **Connect** test mode — the actual free KYB-shaped signal

**This is the most useful thing in this whole document and it nearly got missed.** Stripe's
KYB lives in **Connect account onboarding**, not Identity — and it is testable at $0 with
published **registry** magic values.

Create a Connect account with `business_type=company` (v1) or `identity.entity_type="company"`
(v2). `requirements.currently_due` comes back as real KYB fields:

```
["business_profile.mcc","business_profile.url","company.address.city","company.address.line1",
 "company.address.postal_code","company.address.state","company.name","company.phone",
 "company.tax_id","relationship.representative","relationship.owner"]
```

(v2 equivalent: `identity.business_details.registered_name`,
`identity.business_details.id_numbers.us_ein`,
`identity.attestations.persons_provided.owners`, …)

#### The published magic EINs — https://docs.stripe.com/connect/testing

Gating statement, verbatim: *"You can only use these values while testing with test API keys."*

| `company.tax_id` / `us_ein` | Effect |
|---|---|
| `000000000` | Successful business ID number match |
| `000000001` | Successful match, as a non-profit |
| `000000004` | **Unsuccessful** — inactive business status |
| `111111111` | **Unsuccessful** — identity mismatch |
| `111111112` | **Unsuccessful** — tax ID not issued |
| `222222222` | Successful, **immediate** match (result in the API response, not a webhook) |
| **`222221000`** | **Company not found in registry** |
| **`222221001`** | **Owners not found in registry** |
| **`222221002`** | **Directors not found in registry** |
| **`222221003`** | **Missing owners** on account vs registry |
| **`222221004`** | **Missing directors** on account vs registry |
| **`222221005`** | **Pending response from registry** |

Supporting tables: personal ID numbers (`000000000` match, `111111111` mismatch,
`111111113` inactive, `222222222` immediate); DOBs (`1901-01-01` match, `1902-01-01`
immediate match, **`1900-01-01` triggers an OFAC alert**); address tokens
(`address_full_match`, `address_no_match`, `address_line1_no_match`, `address_zip_no_match`,
`address_line1_zip_no_match`); trigger cards (`tok_visa_triggerNextRequirements`,
`tok_visa_triggerChargeBlock`, `tok_visa_triggerPayoutBlock`); plus test **file tokens**
for document-upload simulation.

#### Where the registry result surfaces

**Correction to a common assumption: there is NO `company.verification.status` field.**
`company.verification` contains only a `document` sub-object. `verification.status` exists on
**Person** objects, not on `company`. Don't build against it.

The registry signal comes through four places:

1. `requirements.currently_due` / `past_due` / `eventually_due` — field-name arrays.
2. `requirements.pending_verification` — *"Fields that are being reviewed"*. This is where
   `222221005` lands.
3. **`requirements.errors[]`** — the rich one. Each entry has `code`, `reason` (human-safe
   message) and `requirement` (which field to fix).
4. `requirements.disabled_reason` — `requirements.pending_verification`, `under_review`,
   `rejected.incomplete_verification`, `rejected.fraud`, `listed`, …

Registry-shaped `requirements.errors[].code` values (verbatim descriptions abbreviated):

| Code | Meaning |
|---|---|
| `verification_failed_tax_id_match` | Tax ID cannot be verified by the IRS |
| `verification_failed_tax_id_not_issued` | Tax ID not recognized by the IRS |
| `verification_failed_name_match` | Company name could not be verified |
| `verification_failed_keyed_match` | Keyed-in company name / ID / address unverifiable |
| `verification_failed_document_match` | Document could not be verified |
| `verification_missing_owners` | Owners identified that aren't on the account |
| `verification_missing_directors` | Directors identified that aren't on the account |
| `verification_missing_executives` | Executives identified that aren't on the account |
| `verification_directors_mismatch` | Directors don't match government records |
| `verification_extraneous_directors` | Extra directors added vs registry |
| `verification_legal_entity_structure_mismatch` | Business type/structure appears incorrect |
| `verification_failed_address_match` | Address could not be verified |
| `invalid_tax_id` / `invalid_tax_id_format` | 9 digits, no dashes |
| `invalid_company_name_denylisted` | Generic/well-known names unsupported |
| `invalid_address_registered_agent_address` / `_cmra_address` / `_private_mailbox` | Address-quality rejects |
| `verification_document_failed_test_mode` | Explicit test-mode simulation hook |

That is a genuine, machine-readable, third-party-shaped registry response — free, in test
mode, delivered to your Vercel endpoint via signed `account.updated` webhooks.

**The one caveat, verbatim** from https://docs.stripe.com/connect/testing-verification:

> You must provide a test API key from a Stripe account which **has begun Connect platform
> onboarding**. The auto-filled Stripe test API key causes these sample requests to fail.

**UNCONFIRMED whether "has begun" means one click in the Dashboard or a review.** The
wording reads self-serve (Connect platform onboarding is normally a self-serve Dashboard
flow), but this is the thing to check first. If it turns out to be gated, fall back to the
labelled simulated registry.

**Honesty note for the writeup:** Connect is Stripe verifying a business *to onboard it as a
Stripe-connected account*, not a general-purpose KYB API you'd sell as a compliance product.
Using it as your registry leg is legitimate and genuinely live — but describe it accurately.
Don't call it "a KYB vendor integration"; call it "Stripe Connect's company verification,
which performs a real registry check and returns structured failure codes."

---

## 5. Recommendation — the honest architecture

### The verdict, plainly

**No dedicated KYB vendor sandbox is free and self-serve.** Persona gates it behind
support, Middesk behind sales, Sumsub behind a credit card. Anyone claiming otherwise has
either not checked or is calling individual KYC "KYB".

**But the business leg does not have to be fake.** Stripe Connect test mode runs a real
company-registry check with published failure modes. So the honest architecture is better
than "verify the human, simulate the company" — it's **two live third-party legs, one of
which is a payments platform's own KYB rather than a KYB vendor's**, and you say so.

### Recommended stack

1. **Persona sandbox** — live, third-party, self-serve — for the **director /
   control-person KYC** leg (Government ID + Selfie + Database). Real inquiry IDs, real
   hosted flow, real signed webhooks to your Vercel deployment.
2. **`perform-simulate-actions`** as the demo control surface for pending / approved /
   declined / needs-review. These are *Persona's own* transitions and *Persona's own*
   webhooks — the only thing simulated is the end user's behaviour, which is what a sandbox
   is for.
3. **Stripe Connect test mode** — live, self-serve — for the **business-registry** leg.
   Company name + EIN + owners + directors, verified against a registry, with
   `222221000`–`222221005` to force *company not found* / *owners not found* / *directors
   not found* / *pending response from registry*. Read the outcome from
   `requirements.errors[]` (`code` / `reason` / `requirement`), not from a
   `company.verification.status` field — that field does not exist.
4. **`SimulatedRegistryProvider`** as the labelled fallback, used **only** if Connect
   platform onboarding turns out to need approval. Every result carries
   `evidence: "simulated"`, rendered as a visible badge and persisted on the row.
5. **Stripe Identity test mode** as an optional second KYC provider — good for proving the
   interface is genuinely provider-agnostic, but *not* the primary, because you cannot
   script its outcomes (§4.3).

### Why this is the honest answer, not a cop-out

The interface is the deliverable. `KybProvider` (see `adapter.draft.ts`) has
`createBusinessVerification` / `getVerification` / `verifyWebhook`, with implementations for
`PersonaDirectorKycProvider` (live KYC), `StripeConnectRegistryProvider` (live registry),
`SimulatedRegistryProvider` (labelled fallback), and `PersonaKybProvider` — the real
Transactions-based KYB, written out in full against the published docs, ready for the day
someone provisions a `transaction_type_id`. A reviewer can see exactly where every seam is.

`CompositeKybProvider` combines the person leg and the business leg, takes the **strictest**
of the two statuses, and degrades `evidence` to `"simulated"` if *either* leg was simulated.
**The system can never report "verified by a third party" when half the evidence was
manufactured.** That property is the point of the design, and it's worth calling out.

### Things to say out loud in the writeup

- "Persona KYB requires contacting their team to provision a transaction type — confirmed
  from their own integration guide and four plan-availability tables. So the registry leg
  runs through Stripe Connect's company verification instead, which does a real registry
  check. Here's the adapter; here are the ~40 lines that change when a Persona KYB key
  arrives."
- "Pending and declined are demonstrated through Persona's real sandbox lifecycle and real
  signed webhook deliveries, not by mutating my own database."
- "Stripe Identity publishes no forced-outcome test values and ships no CLI trigger fixture
  for `verified` or `requires_input` — I checked all 121 fixtures. That's why Identity is
  the backup, not the primary."
- "Persona publishes no replay tolerance for `Persona-Signature`. I chose 300 s, matching
  Stripe's documented default."
- "Stripe Connect is a payments platform verifying a business to onboard it, not a KYB
  product I'd sell as compliance. It's a real registry check and I'm using it as one — but
  I'm not going to call it a KYB vendor integration."

### Do this in the first 30 minutes

Remember you get **one Persona trial ever**, so know what you're doing before you click.

1. Sign up at https://withpersona.com/dashboard/signup. Confirm the environment switcher
   says **Sandbox** and that the API key is prefixed `persona_sandbox`.
2. Check `Dashboard > Verification Templates` filtered to
   `verification-template/database-business`, and `Dashboard > Reports` for Business
   Watchlist / Business Lookup templates. If either exists, you get *some* real business
   signal for free — upside, not the plan. If missing, proceed without them.
3. Add your Vercel domain to the hosted-flow redirect allowlist before you need it.
4. Create a webhook pointed at the deployed URL and fire `start_inquiry` at a throwaway
   inquiry to prove end-to-end delivery before writing any product code.
5. Remember the 50-service trial cap may apply in sandbox — don't loop simulate-actions in
   a test suite against the live sandbox.
6. Expect sandbox names to come back as `Alexander J Sample` regardless of what you sent.

On the Stripe side, in parallel:

7. Register a Stripe account, grab `sk_test_…`, and **check whether Connect platform
   onboarding is one Dashboard click or a review**. This decides whether your business leg
   is live or simulated — it's the single most important unknown in this document.
8. If you also want Identity: **test whether `POST /v1/identity/verification_sessions`
   succeeds before submitting the Identity application.** Stripe's docs are silent both
   ways.
9. Point the Stripe webhook at the *final* resolved URL (no `www`→apex redirect, no
   trailing-slash redirect) — Stripe counts 3xx as a delivery failure.

---

## Sources

**Persona**
- API keys / sandbox self-serve — https://docs.withpersona.com/api-keys
- Authentication — https://docs.withpersona.com/authentication
- Environments (sandbox is unmetered, force pass/fail) — https://docs.withpersona.com/environments
- Integration Testing (simulate actions table) — https://docs.withpersona.com/integration-testing
- Perform Simulate Actions — https://docs.withpersona.com/api-reference/inquiries/perform-simulate-actions
- Create an Inquiry — https://docs.withpersona.com/api-reference/inquiries/create-an-inquiry
- Retrieve an Inquiry — https://docs.withpersona.com/api-reference/inquiries/retrieve-an-inquiry
- Inquiry Model Lifecycle — https://docs.withpersona.com/model-lifecycle
- Creating Inquiries — https://docs.withpersona.com/creating-inquiries
- Inquiry Templates — https://docs.withpersona.com/inquiry-templates
- Hosted Flow — https://docs.withpersona.com/hosted-flow
- Hosted Flow security / redirect allowlist — https://docs.withpersona.com/hosted-flow-security
- Embedded Flow — https://docs.withpersona.com/embedded-flow
- Embedded Flow pre-create — https://docs.withpersona.com/tutorial-embedded-flow-precreate
- Webhooks overview (payload envelope, retries) — https://docs.withpersona.com/webhooks
- Webhook Best Practices (signature scheme) — https://docs.withpersona.com/webhooks-best-practices
- Quickstart: Webhooks (Node verify sample) — https://docs.withpersona.com/quickstart-webhooks
- Webhook Event Simulation (does *not* deliver) — https://docs.withpersona.com/webhook-event-simulation
- Create a Webhook — https://docs.withpersona.com/api-reference/webhooks/create-a-webhook
- Rotate a Webhook's secret — https://docs.withpersona.com/api-reference/webhooks/rotate-a-webhook-secret
- Events list — https://docs.withpersona.com/events
- Integration Guide: KYB via API (the gating statement) — https://docs.withpersona.com/integration-guide-kyb-via-api
- Create a Database Business Verification — https://docs.withpersona.com/api-reference/verifications/database-business-verifications/create-a-database-business-verification
- Reports — https://docs.withpersona.com/reports
- Reports Cookbook — https://docs.withpersona.com/reports-cookbook
- Business Verification Solution + plan table — https://help.withpersona.com/articles/4Z9k3Y9n4xlN6jMQpoVrGu/
- Business Registry Verification plan table — https://help.withpersona.com/articles/3pkLBWKg5wIQJru7PATxBc/
- Business Watchlist Report plan table — https://help.withpersona.com/articles/4y3oaeL7pc2f5DHKT50smE/
- Business Associated Persons plan table — https://help.withpersona.com/articles/3pBDySJ0AAqp35RaYmeKzc/
- Sandbox details (name overwrite, no charges) — https://help.withpersona.com/articles/6I2kGhfPvSuUjYq4z6tpmB/
- API quickstart ("register with your business email") — https://docs.withpersona.com/api-quickstart-tutorial
- Plans Overview (one trial per business) — https://help.withpersona.com/articles/6oZbzp7jb7AWGClF5vpY3K/
- Essential trial (sandbox-only, no card) — https://help.withpersona.com/articles/4IzxlP0GOewGYkpG5fXah6/
- Startup Program — https://help.withpersona.com/articles/1XNnqukfZY9VamF2e7jkuJ/
- Testing your Inquiry Template (Advanced mode / Check Results) — https://help.withpersona.com/articles/1az3sGqpcW5Zrne9I7lm49/
- Trigger report hits in sandbox — https://help.withpersona.com/articles/56sLAbSytkmI57zpbug3xc/

**Middesk**
- API keys ("contact sales") — https://docs.middesk.com/build/api-keys
- Sandbox / production environments + magic values — https://docs.middesk.com/environments
- Enhanced sandbox (no API access) — https://docs.middesk.com/enhanced-sandbox
- Secure webhooks — https://docs.middesk.com/build/secure-webhooks
- Create a business — https://docs.middesk.com/api-reference/business-verification/businesses/create-business
- Webhook events — https://docs.middesk.com/monitor-activity/events

**Stripe**
- API keys / test mode — https://docs.stripe.com/keys
- Sandboxes / CLI-provisioned sandbox — https://docs.stripe.com/sandboxes, https://docs.stripe.com/cli/sandbox
- Identity overview — https://docs.stripe.com/identity
- Identity verification checks (complete list) — https://docs.stripe.com/identity/verification-checks
- Identity verification sessions (statuses, events) — https://docs.stripe.com/identity/verification-sessions
- Create a VerificationSession (test-mode caveat) — https://docs.stripe.com/api/identity/verification_sessions/create
- Verify identity documents (the "Before you begin" gate) — https://docs.stripe.com/identity/verify-identity-documents
- Handle verification outcomes (`last_error.code`) — https://docs.stripe.com/identity/handle-verification-outcomes
- Identity use cases / country availability — https://docs.stripe.com/identity/use-cases
- Webhooks (signature scheme, tolerance, retries, 3xx=failure) — https://docs.stripe.com/webhooks
- Troubleshooting signature verification — https://docs.stripe.com/webhooks/signature
- **Connect testing — magic EINs / registry values** — https://docs.stripe.com/connect/testing
- Connect testing verification (requirements flow, v1 + v2) — https://docs.stripe.com/connect/testing-verification
- Account object (`requirements.errors[]`, `company`) — https://docs.stripe.com/api/accounts/object
- Identity pricing — https://stripe.com/identity

**Sumsub**
- Authentication — https://docs.sumsub.com/reference/authentication
- Create applicant — https://docs.sumsub.com/reference/create-applicant
- Test in Sandbox (the gating statement) — https://docs.sumsub.com/docs/test-in-sandbox
- Self-service (card + company required for trial) — https://docs.sumsub.com/docs/self-service
- Test Business Verification (mock companies) — https://docs.sumsub.com/docs/test-business-verification
- Simulate review response in Sandbox — https://docs.sumsub.com/reference/simulate-review-response-in-sandbox
- Webhook manager (digest headers) — https://docs.sumsub.com/docs/webhook-manager
- User verification webhooks — https://docs.sumsub.com/docs/user-verification-webhooks
- Pricing — https://sumsub.com/pricing/
