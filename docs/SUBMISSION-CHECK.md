# Submission check

Is the package the trial asks for actually complete, and is the email true?

Checked against commit `463488a` (`git log -1`) and the deployed URL at
**2026-09-11T22:38Z**. Every verdict below is a measurement; the command that
produced it is printed beside it. Where something is missing this file says so
rather than describing the file that was supposed to contain it.

**Scoreboard — 8 items: 2 complete, 4 with a gap a grader will hit, 2 absent.**

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Deployed URL + credentials for two roles, in the email body | **COMPLETE, once Saahith types the passphrase** |
| 2 | Repo access for @AlexanderReinicke and @mojafa | **BLOCKED — neither invitation accepted; the link is a 404 for them** |
| 3 | Decision log, in the repo, timestamped | **COMPLETE — and the history supports it** |
| 4 | Five-minute video of the money path | **ABSENT — not recorded** |
| 5 | Evidence of live integrations, incl. webhook delivery log | **PARTIAL — /api/health carries it; no screenshots, no dashboard invite** |
| 6 | Seed script standing up demo data from zero | **PARTIAL — schema yes, believable data no; and `dbreset` loses 67 grants** |
| 7 | `.env.example` documenting every key | **INCOMPLETE — `CONSOLE_PASSWORD` is missing, and it gates every write** |
| 8 | Cut list: what was not built, and week two | **PRESENT BUT WRONG AGAIN — it still claims auth was cut; auth shipped** |

---

## 1. Deployed URL and two-role credentials — COMPLETE, with one human step

`https://corgi-trial-psi.vercel.app` serves, and the deployment is the commit
this repo is on:

```
$ curl -s https://corgi-trial-psi.vercel.app/api/health | jq .commit
{ "shortSha": "463488a", "source": "VERCEL_GIT_COMMIT_SHA" }
$ git log -1 --format=%h        →  463488a
```

**The access model is not what the older docs say, and the email now says it
correctly.** Reads are open to a visitor holding nothing. Writes need one
passphrase, entered at `/signin`. Measured:

```
$ for p in / /signin /payments /approvals /accounts /team /dashboard \
           /client /client/open /client/pay /client/funding; do
    curl -s -o /dev/null -w "$p %{http_code}\n" https://corgi-trial-psi.vercel.app$p
  done
  →  200 on every one, with no cookie

$ curl -s -D - -X POST -H 'Accept: application/json' \
       https://corgi-trial-psi.vercel.app/approvals
  →  HTTP/2 401
     x-corgi-authz: deny; SIGN_IN_REQUIRED
```

So a grader can read the entire book — ledger, approvals, audit, the customer
surface — without asking Saahith for anything, and is refused by the server, by
name, the moment they try to act. That is a good story and the email tells it.

The two roles are a switch, not two passwords: `Acting as` in the top right
resolves to two seeded actors, **Priya Raman** (`can_approve = false`) and
**Dana Okonkwo** (`can_approve = true`) — both created by `scripts/seed.mjs`
(lines 182, 200). Signing in grants the ability to act; the switch chooses the
principal you act as.

**The one gap, and it is on Saahith, not on the build.** The passphrase is
`CONSOLE_PASSWORD`, set on the Vercel project. It is deliberately not in this
repo and no agent has been given it. **If Saahith sends the email without
typing it in, the graders can read everything and approve nothing** — and
approving something is the specific thing the trial asks them to do.
`thread/freeze_submission.md` carries a marked line for exactly this.

**A contradiction he should know about:** `docs/DEMO.md` §1 is headed *"There is
nothing to sign into"* and still says *"the credential is a role switch"*. That
was true until commit `5cd3729` and is false now. The email above does not
repeat it, but the repo contradicts the email until that file is fixed. Same
staleness in `thread/SUBMISSION_email.md:9`. Neither file is mine to edit.

## 2. Repo access — BLOCKED, and this is the item most likely to cost points

```
$ gh api repos/SaahithV6/corgi-trial/invitations
  → 2 invitations, both created 2026-09-10T00:32:41Z, permission "read",
    expired: false, invitees AlexanderReinicke and mojafa

$ gh api repos/SaahithV6/corgi-trial --jq '{private,visibility}'
  → { "private": true, "visibility": "private" }

$ gh api repos/SaahithV6/corgi-trial/collaborators --jq '.[].login'
  → SaahithV6        (nobody else has accepted)
```

**Plainly: the repo is private and neither grader has accepted. A grader who
clicks the repo link in the email today gets a 404 — not a permission page, a
404, because GitHub hides the existence of private repos.** It will look to them
like the link is wrong or the repo was deleted. Deliverables 3, 6, 7 and 8 all
live in that repo, so this one blockage takes four of the eight items with it.

The invitations have not expired (they are good for 7 days from 09-10, so
through 09-17), so the options are:

1. **Say it in the email** — the draft now does, with the direct link
   `https://github.com/SaahithV6/corgi-trial/invitations` and a request to
   accept before clicking. Cheapest, and it is honest.
2. **Make the repo public.** Removes the problem entirely. Check first that the
   secret scrub at `1e84388` ("two real credentials were committed. Rotated,
   scrubbed") means history is clean — the credentials were rotated, but a
   public repo exposes the history to anyone, not just the graders.
3. **Send a tarball of the tree at `463488a`** as a fallback in the same email.

The draft offers 1 with 2 and 3 as a reply-away fallback. That is the right
shape: it does not make a grader chase him.

## 3. Decision log — COMPLETE, and the history genuinely supports it

`DECISIONS.md`, 175 KB at the repo root.

```
$ grep -cE '^## ' DECISIONS.md                    →  59 entries
$ grep -nE '^## .* — 20[0-9]{2}-' DECISIONS.md | head
  001 — 2026-09-10T00:26Z — Track 1, Policy administration
  002 — 2026-09-10T00:30Z — Supersedes 001: Track 3, Neobank
  003 — 2026-09-10T00:45Z — Cost-benefit across all three tracks
```

Every entry carries an ISO-8601 UTC timestamp in its heading. **Timestamped: yes.**

The trial's real concern is a log written at the end to look like a log. It was
not:

```
$ git log --format='%h %ci' -- DECISIONS.md | wc -l    →  39 commits
$ git log --format='%ci' | cut -d' ' -f1 | sort | uniq -c
     21 2026-09-09
     70 2026-09-10
     30 2026-09-11
```

**39 separate commits touch `DECISIONS.md`, spread across all three days** — the
first is `e1d1759 2026-09-09 17:26 "Decision log 001: pick Track 1"`, twenty-six
minutes into the build, and the most recent is `f33a288 2026-09-11 10:54`. The
entries also record reversals in place (002 supersedes 001; `f2d3254` marks a
count in entry 034 as history after it stopped being true), which is the
signature of a log kept rather than composed. **No single late commit. The
history supports the document.**

## 4. Five-minute video — ABSENT

There is no video.

```
$ git ls-files | grep -iE '\.(mp4|mov|webm|gif|png|jpg|jpeg|webp|pdf)$'
  → (no output)
```

Zero media files, tracked or untracked, anywhere outside `node_modules`. No
Loom, YouTube, Drive or Vimeo link exists in `docs/`, `README.md`, `thread/` or
`DECISIONS.md` — every hit is the requirement itself or a `[LINK]` placeholder.
`.gitignore` does not exclude media, so this is a real absence.

What exists is a shot list: `docs/VIDEO-SCRIPT.md`, 497 lines, 14 shots, stated
runtime **4:52**, each shot with its URL, what must be in frame, the spoken
line, and a fallback if it hangs. It is shootable as written and it fits the
five-minute limit. **But it predates the sign-in gate** and would break on
camera: it instructs the recorder to clear the role cookie and drive the
maker-checker shot as Staff, which now needs the passphrase first.

There is a newer, corrected script — `docs/NARRATION.md`, ~5 minutes, written
around `/client` and narrating the "sign in to act" notice. **It is untracked
(`git status` → `?? docs/NARRATION.md`), so it is not in the repo a grader
clones, and nothing references it.** Someone should commit it; it is not mine.

**This is a human task and nothing in the repo can discharge it.** The email
carries a bracketed placeholder.

## 5. Evidence of live integrations — PARTIAL, and stronger than the docs admit

The requirement is read-only dashboard access or screenshots, **including the
webhook delivery log**.

**Screenshots: none exist.** `docs/EVIDENCE-PACK.md` §5 is a shot list — three
frames to capture, never captured. **Dashboard access: not provisioned.** §4
offers read-only Neon access and sandbox keys *"on request"*, and falls back to
the screenshots that do not exist. On the literal wording of the requirement,
**this item is not met.**

**But the build answers it in a way the evidence pack does not claim, and the
email should lead with it.** `/api/health` is public, needs no credential, and
publishes the webhook delivery log itself:

```
$ curl -s https://corgi-trial-psi.vercel.app/api/health
  integrations.live 7, integrations.total 7, warnings []
  status "ok"
```

Per-slot, each carrying the call that earned the label — Lithic sandbox
(`GET /v1/cards → 200`), Lithic webhooks, Stripe Identity, GLEIF, Plaid
sandbox, Increase sandbox, USDC on Base Sepolia. The `card_webhooks` slot's
evidence string is the delivery log, in the response body:

> `GET /v1/event_subscriptions/ep_3J8yb9xommtOdKee1FzpUA4GBrW/attempts -> 200:`
> `subscription enabled at …/api/webhooks/lithic; latest delivery SUCCESS,`
> `our endpoint answered HTTP 202 at 2026-09-11T22:00:18.060Z`

and `integrations.webhookHealth` / `webhookProcessing` publish per-provider last
delivery, last consumed, and the backlog **unrounded**: Lithic **31 parked,
69 dead-lettered**, oldest 108,206 s. A grader can read all of that from a URL.

Two caveats to be honest about:

- It is our own server reporting its own round trips. It is not provider-side
  attestation, which is what a screenshot of the Lithic dashboard would be.
  The USDC leg is the exception — that one is verifiable on a public block
  explorer, independently of anything Saahith controls.
- `scripts/evidence.mjs` does genuinely reconcile Lithic's attempts against our
  `webhook_inbox` by the id returned in our own 202, which is a stronger
  artefact than a screenshot — but it needs `LITHIC_API_KEY` and
  `APP_DATABASE_URL`, so **a grader cannot run it**. The pasted attempt table
  in `docs/EVIDENCE-PACK.md` §3.2 is text a human typed and carries no
  signature.

**Verdict: the delivery log IS visible to a grader, via `/api/health`, and that
is worth saying in the email. The screenshots and the dashboard invite the
requirement names are still missing, and the cheapest fix is the three frames in
`docs/EVIDENCE-PACK.md` §5 — Shot 1 is the delivery log and takes a minute.**

Also: `docs/EVIDENCE-PACK.md` §4 and §8 still quote `pnpm db:check` as *"35
passed, 1 failed"* and its own tick sheet says the item *"counts only if 35
passed, 1 failed"*. `docs/CUT-LIST.md` and `docs/REMAINING.md` both give 43/4.
**The evidence pack would fail its own acceptance test today.** Not my file.

## 6. Seed script from zero — THE SCHEMA COMES UP; A *BELIEVABLE BOOK* DOES NOT

Read, not run. **Nothing in this check executed `dbreset`, `seed` or `migrate`
against the live book.**

The trial asks for *"a seed script that stands up believable demo data from
zero"*. The schema half is solid. The believable-data half is not met, and the
seed script says so about itself.

**The sequence.** `scripts/dbreset.mjs:28` does `DROP SCHEMA public CASCADE`,
recreates it, shells out to `scripts/migrate.mjs` (line 34) and re-grants
`corgi_app`. **It does not call seed.** The documented order (`README.md:698`)
is in fact `pnpm migrate` → `node scripts/seed.mjs` → `pnpm db:check`; there is
no `pnpm seed` alias, which `README.md:704` states outright.

### 6a. What the seed actually writes — seven tables

`scripts/seed.mjs` touches `book_entity`, `business`, `actor`, `account`,
`approval_policy`, `funds_availability_policy`, `rail_event_semantics`. That is
1 program entity, 3 businesses (Ridgeline approved, Kettle & Crumb pending,
Silverline rejected), 7 actors, 33 house chart accounts plus per-business leaves
**for the approved business only**, and three policy tables.

**What is absent from the money path:**

| the trial's demo path | in the seed? |
| --- | --- |
| a business | yes, 3 |
| an approved KYB | **no** — zero `kyb_verification_leg` rows; KYB state is implied by a magic EIN and by whether accounts exist |
| a funded account | **no** — `journal_entry` count is 0 |
| payments | **no** `payment_instruction`, no approvals |
| cards | **no** `card`, `card_authorization`, `card_auth_event` or holds |
| a team | **no** `team_member` |
| pots, payees, standing orders, disputes, recon, statements | **none** |

The script is honest about it — it prints `journal_entry rows: 0` and *"This
script posts no money, by design"* (lines 1024–1026), and closes with *"None.
This book holds only the three businesses above, which is what a freshly seeded
database looks like before any test suite has run"*. **The design reason is
good**: hand-writing journal rows would bypass `ledger_append()` and seed a book
the invariants never vetted.

**But the consequence is the deliverable.** `seed.mjs:1000–1012` prints seven
deep links as "the story" — `/onboarding`, `/funding`, `/accounts/<id>`,
`/payments`, `/approvals`, `/reconciliation`, `/statements`. **On a fresh seed
every one of them is empty.** The money on the deployed site exists because
`scripts/coreloop.mjs` has been run against it, and coreloop needs
`APP_DATABASE_URL`, live Lithic credentials and a `DRAIN_TOKEN`. **There is no
offline path from zero to a funded book.** A grader who clones, migrates and
seeds gets a correct, empty ledger — not a demo.

This is the honest verdict: **the script stands up a schema and its reference
data from zero, reproducibly and idempotently. It does not stand up believable
demo data.** If one thing is added before sending, it should be a documented
line in the README saying exactly that, so the gap is disclosed rather than
discovered.

### 6b. `dbreset` destroys 67 table grants and never restores them

This is a real defect, not a stylistic one. `scripts/dbreset.mjs:41` runs
`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM corgi_app`, and the re-grant
list beneath it is **hardcoded, naming 25 tables**. Migrations grant `corgi_app`
privileges on **92**. So a `dbreset` build silently loses grants on 67 tables
including **`card`**, `pot`, `payee`, `standing_order`, `dispute`, `team_member`,
`interest_*`, `interchange_*`, `outbound_*` and `mcp_audit`, plus the
column-level UPDATEs from `0034` and `0038`.

The script's own comment (lines 59–93) documents this exact failure — it already
ate `v_webhook_dead_letter` and `v_webhook_parked` from `0002` and left them
unreadable for the rest of the build — **fixes it for views by deriving them
from `information_schema.views`, and then leaves it in place for tables by
explicit choice** (lines 83–86: *"Tables stay explicit above, deliberately"*).
The argument it makes three lines earlier — *"A hardcoded list cannot notice a
view nobody added it to — the same failure this build has catalogued twenty-four
times"* — applies verbatim to the table list directly above it.

It runs the other way too: `rail_event_semantics` is in dbreset's grant list but
**no migration grants it at all**. So `migrate`-only and `dbreset` produce two
different, both-incomplete privilege sets.

Related, and cheap to fix: `dbreset.mjs:30` grants to `corgi_app` **before**
migrations run, but the role is created by `0001_ledger.sql:810`. On a genuinely
virgin cluster that line raises `role "corgi_app" does not exist` and dbreset
dies before migrating. It works today only because roles survive `DROP SCHEMA`.

### 6c. Migration ordering — sound, with one pair to name

**The migration runner is as described** — `scripts/migrate.mjs:22`:

```js
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
```

Default lexical sort, `filename text PRIMARY KEY` (line 26), and a `sha256`
drift check (lines 39–42) that refuses a file whose body changed after it was
applied. So the duplicate numbers are harmless *to the runner*: it keys on the
full filename, not the number, and 61 files apply as 61 distinct rows.

**The duplicate pairs, and whether lexical sort satisfies every dependency:**

```
$ ls db/migrations | wc -l                        →  61
$ ls db/migrations | sed 's/_.*//' | sort | uniq -d →  0053  0054  0056
```

| Lexical order | Creates | Depends on |
| --- | --- | --- |
| `0053_card_auth_judged.sql` | 3 card-auth views | `card_auth_decision`, `card` — both far earlier |
| `0053_fx_commitment_hold.sql` | `fx_commitment_hold`, **`fx_commitment_regime`**, 2 views, alters `hold_closure` | earlier `hold` tables |
| `0054_deposit_and_memo_provenance.sql` | 4 deposit/memo views | earlier journal tables |
| `0054_fx_commitment_regime_immutable.sql` | nothing — a trigger/grant | **`fx_commitment_regime`**, `ledger_row_is_immutable` |
| `0056_advice_base_reconstruction.sql` | 2 advice views | earlier advice tables |
| `0056_plaid_item_state.sql` | 4 `plaid_item*` tables, 3 indexes, 1 view | earlier `business` |

**Every dependency is satisfied.** The two files in each pair are in unrelated
domains (card-auth vs fx, deposit vs fx, advice vs plaid), so within a pair the
order does not matter. The one dependency that crosses the duplicate numbers is
the fx chain — `0054_fx_commitment_regime_immutable.sql` acts `ON
fx_commitment_regime`, which `0053_fx_commitment_hold.sql` creates — and lexical
sort puts `0053_fx…` before `0054_fx…`, so it resolves. Verified:

```
$ grep -oiE "ON +fx_commitment_regime" db/migrations/0054_fx_commitment_regime_immutable.sql
  →  ON fx_commitment_regime
```

A full forward-reference sweep across all 61 files — every `FROM`, `JOIN`,
`INSERT INTO` and `UPDATE` target cross-checked against the index of what each
file creates, in lexical order — found **zero genuine forward references**.

**The one pair to name as fragile is `0056`.** Both files are mutually
independent, so nothing breaks. But the lexical apply order is the **reverse of
the authoring order**: `0056_advice_base_reconstruction.sql` was written at
10:07 and applies first; `0056_plaid_item_state.sql` was written at 10:01 and
applies second. It works purely by accident of the alphabet, and the numbering
actively conceals that — `dbreset.mjs:46` even refers to "0056's four tables" as
though `0056` named a single migration. A third `0056_*.sql` added later would
land in an arbitrary position between them.

The general form of the risk, worth one README line rather than a fix now: the
order is correct *by alphabet*, not by declared dependency. A future
`0053_aaa_fx_regime_tweak.sql` would sort ahead of `0053_fx_commitment_hold.sql`
and fail on a table that does not exist yet — and it would only fail on a
from-zero rebuild, never on an incremental one, which is the worst place for it
to hide.

**One structural note that is not an ordering bug but bites from zero:** four
migrations insert chart rows with `INSERT … SELECT … FROM book_entity/account`
(`0024:274,282` for 4400/5400, `0053_fx_commitment_hold:100` for 9300,
`0061:64` for 9400). Migrate runs *before* seed, so `book_entity` is empty and
all four **insert zero rows silently**. They are rescued only because
`src/lib/ledger/chart.ts` also carries those four codes and seed creates them.
Remove one code from `chart.ts` and the account vanishes from a from-zero build
with no error anywhere.

### 6d. What the seed does get right

1,080 lines, idempotent by construction — *"every INSERT is `ON CONFLICT DO
NOTHING` with no conflict target, so ANY unique constraint absorbs a re-run"*
(line 31) — with `uuid5()` ids derived from stable names, so a re-seed is a
no-op rather than a duplicate.

```
$ grep -nE "ep_[A-Za-z0-9]{10,}|acct_[A-Za-z0-9]{8,}|https://" scripts/seed.mjs
  →  (no output)
```

**No hardcoded provider ids, account tokens or live URLs.** It does not secretly
depend on the state of Saahith's sandboxes, which is the usual way a "from zero"
seed turns out not to be one. The only literals are three Stripe test-mode magic
EINs (lines 126, 131, 136), which are documented sandbox values. It imports the
chart from `src/lib/ledger/chart.ts` rather than retyping it, so the two cannot
drift.

The three businesses are chosen to make a point rather than to fill a screen:
**Ridgeline Robotics** approved, **Kettle & Crumb Bakery** pending and holding
no accounts at all so that KYB approval can be shown opening a chart of accounts
at request time, and **Silverline Freight** rejected. Both staff actors the demo
needs are here — `Dana Okonkwo` (line 182, `can_approve = true`) and `Priya
Raman` (line 200, `false`) — plus an agent actor that
`actor_only_humans_approve` makes unable to hold `can_approve` at all (line 222).

That much is exactly right. It is the postings that are missing.

### 6e. `verify-demo.mjs` does not verify the seed

Worth knowing, because its name suggests otherwise. It is a 1,177-line **HTTP
walker against a deployed URL** — it opens no database connection. Two things
blunt it here:

- **Step 0 requires `CONSOLE_PASSWORD`** in the shell *and* on the deployment,
  and does a real sign-in POST. Without it every later check 401s. So this
  script is itself gated on the credential missing from `.env.example` (§7).
- **Against a freshly reset-and-seeded database it would fail, not pass** —
  step 13's account lookup, step 15's live-account sweep and steps 18–19's
  reconciliation break all need rows the seed does not create.

Also: its most persuasive check, step 13 (*"a $50.00 authorisation moves
AVAILABLE and does not move the LEDGER"*), fetches
`/accounts/acct_operating_4417?auth=pending` — not a real account id — and step
14 then asserts that same page says *"nothing here was written to the
database"*. It proves a rendered fixture, not a posting. That is not dishonest,
the page declares itself, but the number it produces should not be quoted as
evidence that the money path works.

## 7. `.env.example` — INCOMPLETE, and the missing key is the one that matters

```
$ grep -rhoE "process\.env(\.[A-Z0-9_]+|\[['\"][A-Z0-9_]+['\"]\])" src scripts test \
    | grep -oE '[A-Z0-9_]{3,}' | sort -u | wc -l        →  74 variables read
$ grep -oE '^#?\s*[A-Z0-9_]{3,}=' .env.example | tr -d '#= ' | sort -u | wc -l  →  51
$ grep -n CONSOLE .env.example
  →  NO MATCH
```

**`CONSOLE_PASSWORD` is not in `.env.example`. Neither is `CONSOLE_SESSION_SECRET`.**
`.env.example` was last written 2026-09-11 03:42; the sign-in gate landed at
14:29. It is documented in `docs/AUTH.md`, but deliverable 7 names
`.env.example` and that is the file a grader opens.

Consequence, concretely: a grader clones the repo, copies `.env.example`, boots
it, and gets a console they can read and **cannot write to at all** — every
write returns `503 CONSOLE_NOT_CONFIGURED` (`src/middleware.ts:325`, which fails
closed on an unset secret by design and names the variable on the page). They
will conclude the maker-checker flow is broken. **This is a one-line fix in a
file I do not own and it should be made before sending.**

The other 32 undocumented names are, to be fair, mostly test opt-in flags
(`RUN_LIVE_PROBES`, `RUN_PROOF`, `RUN_LITHIC_TESTS`, `FUZZ_EXHAUSTIVE`, …) and
script base-URL overrides (`CONFIRM_BASE_URL`, `EVIDENCE_BASE_URL`,
`REDRIVE_BASE_URL`) that all default sensibly — none of them blocks a boot. But
three are not flags and are worth a line each: `INCREASE_ACCOUNT_ID`,
`LITHIC_API_BASE`, `MCP_COMPLIANCE_TOKEN`.

The credentials that *do* matter are all present and correctly shaped —
`APP_DATABASE_URL` at line 39 among them, which is what `pnpm confirm` needs.

## 8. Cut list — PRESENT, HONEST IN STRUCTURE, AND WRONG ON THE HEADLINE ITEM

`docs/CUT-LIST.md`, 1,152 lines. It has both halves the trial asks for: §3 what
was cut, §4 what is deliberately unfinished and visible, §5 twelve week-two
items in value order, §6 what is off the list on purpose. §0 timestamps every
figure. The structure is genuinely good, and §2 records the earlier rewrite —
the version that reproduced the T+2h "not building" list as current scope and
thereby disclaimed seven features that had shipped.

**It has drifted into the same error again.** `docs/CUT-LIST.md:1130`, §6:

> **An authentication system.** Cut on day one and still cut. The role switcher
> is a cookie … Building auth would consume a day and prove nothing about a
> ledger.

Authentication shipped three commits later: `5cd3729` (14:29), `790b403`
(15:18), `463488a` (15:23). `src/lib/auth/session.ts` opens *"THE SIGN-IN GATE.
Authentication, at last — the thing `roles.ts` and `policy.ts` both say at
length that they are not."* HMAC-SHA256 signed session, httpOnly cookie,
constant-time compare, `src/lib/auth/password.ts`, `src/app/signin/`,
`src/middleware.ts` enforcing it, and a 400-line `docs/AUTH.md` that did not
exist when the cut list was written. §4.5 repeats the stale sentence.

**This is the exact failure the cut list was rewritten to fix, and it is now
pointing at the single most visible thing built on the last day.** A grader who
reads §6 and then lands on `/signin` learns that the cut list cannot be trusted
— which is expensive, because the cut list is the document whose entire value is
that it can be.

Mechanically: last edited `f33a288 2026-09-11 10:54`, **ten commits and 207
files before HEAD**; §0 pins its figures to `225f00d`, twelve commits back. §3.2
prints the holds cron as `11 8 * * *`; `vercel.json` now says `23 14 * * *`.

It is also silent on the two gaps a grader meets first — **no video** and **no
evidence screenshots**. Both are disclosed in `docs/REMAINING.md` and in the
email draft, neither in the cut list.

`scripts/audit-claims.mjs`, the guard that fails a commit when a document
disagrees with reality, only audits integration-slot liveness against
`/api/health`. It has no coverage of scope claims, which is why the auth line
survived.

---

## What a grader cannot do today

1. **Open the repo link.** Private, no invitation accepted. (§2)
2. **Watch the video.** It does not exist. (§4)
3. **See a provider-side screenshot or a dashboard.** None; `/api/health`
   substitutes and is better than the docs claim, but is our own word. (§5)
4. **Clone it and see a working book.** Migrate and seed give a correct, empty
   ledger; every screen the seed points at is blank until `coreloop.mjs` is run
   against live providers. (§6a)
5. **Boot a clone and approve anything**, because `CONSOLE_PASSWORD` is not in
   `.env.example`. (§7)
6. **Trust §6 of the cut list.** (§8)

Of those, **(1) is the one that costs the most**, because it takes four other
deliverables down with it and looks to the grader like a broken link rather than
a pending invitation.

## The five things worth fixing before sending, in order

Each is small, and none is mine to edit.

1. **Accept-the-invitation line in the email** — already drafted, or make the
   repo public. Nothing else matters if they cannot open it.
2. **Add `CONSOLE_PASSWORD` and `CONSOLE_SESSION_SECRET` to `.env.example`.**
   Two lines. Without them a clone cannot approve anything.
3. **Fix `docs/CUT-LIST.md` §6 and §4.5** — delete or reverse the "authentication
   … cut on day one and still cut" claim. It is the one document whose value is
   that it can be trusted, and it is wrong about the most visible thing built on
   the last day.
4. **Fix `docs/DEMO.md` §1** — *"There is nothing to sign into"* is now false and
   directly contradicts the email.
5. **Add one README line** saying `migrate` + `seed` produces a correct but
   empty book, and that the demo money comes from `coreloop.mjs`. Disclosing
   that is worth more than the gap costs.

## Rows written by this check

**None.** Every measurement above is a `GET`, a `git log`, a `gh api` read, or a
`grep`. No script that writes was run; `scripts/dbreset.mjs`, `scripts/seed.mjs`
and `scripts/migrate.mjs` were read, never executed. One attempted run of
`scripts/verify-demo.mjs` (which is itself read-only) was refused by the sandbox
and was not retried or worked around, so the demo-walk count in `docs/DEMO.md`
— *13 PASS, 5 FAIL, 1 SKIP at 2026-09-11T05:02Z* — **is unverified at this
commit and is probably stale in the build's favour**: its worst-named failure,
the Ridgeline Robotics account screen rendering an error card, no longer
reproduces. `/accounts` lists both businesses and all six account detail pages
return 200 with no error card in the markup. Someone with permission should
re-run it before the number is quoted anywhere.
