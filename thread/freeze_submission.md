# Freeze submission email — draft

Reply on the existing thread. Everything inside the fence is the email.
Verified against commit `463488a` and the deployed URL at 2026-09-11T22:38Z.

```
Subject: Work trial: Saahith Veeramaneni, Track 3

Dear Corgi Staff,

Track 3, neobank. The four things.

1. DEPLOYED URL

https://corgi-trial-psi.vercel.app

Read it with no credential at all. Every operator screen and the whole customer
surface are open to a visitor: balances, the ledger, approvals, the audit trail.
Nothing is hidden behind the gate that you would need to see to judge the build.

To ACT — approve a payment, move money, change a card — there is one passphrase,
entered at /signin. I have put it in the line below this paragraph rather than in
the repo, and it is the only credential in this submission.

  Passphrase: <<SAAHITH: type the CONSOLE_PASSWORD value here before sending>>

The two roles are not two passwords. They are a switch in the top right of every
console page, labelled "Acting as", and each resolves to a different seeded
database actor:

  Staff (the default)   Priya Raman, can_approve = false
  Approver (one click)  Dana Okonkwo, can_approve = true

So: sign in once, then use the switch to change which principal you are acting
as. Raise a payment as Staff, switch to Approver, clear it. Staff cannot approve
anything, and Dana cannot approve a payment she raised herself — that refuses
with "that is you". The refusal is a database constraint, not a hidden button.

Signed out, a write is refused by the server rather than by a missing control:
every one answers 401 with x-corgi-authz: deny; SIGN_IN_REQUIRED, so one curl
proves it. The customer journey runs end to end from /client/open — apply, fund,
staff, schedule, read a statement — on a business that held nothing until its
KYB was approved at request time.

One command answers "is it all working", mapping the brief line by line against
the live book and this deployment:

  pnpm confirm

It needs APP_DATABASE_URL. Say the word and I will send read-only database
credentials so you can run it yourselves; otherwise the last run is in the repo.

2. REPO

https://github.com/SaahithV6/corgi-trial

It is private, and the invitations to @AlexanderReinicke and @mojafa — sent
10 September — are both still unaccepted as I write this. Until one is accepted
that link is a 404 for you, so please accept the invitation at
https://github.com/SaahithV6/corgi-trial/invitations before clicking. If you
would rather not, reply and I will make the repo public or send a tarball of the
tree at this commit.

The deployed commit is 463488a, and /api/health reports its own sha, so you can
check the tree against what is running. The decision log (DECISIONS.md, 59
entries, each timestamped, committed as I went rather than written at the end),
the seed script, .env.example and the cut list are all in the repo.

One thing about the seed, so you find it from me rather than from a blank
screen: `pnpm migrate` then `node scripts/seed.mjs` builds the schema, the chart
of accounts, the policies and the demo actors from nothing, idempotently. It
posts no money, deliberately — hand-written journal rows would bypass
`ledger_append()` and seed a book the invariants had never vetted. The postings
you see on the deployed URL were made by `scripts/coreloop.mjs` driving the real
server actions. So a fresh clone gives you a correct and empty ledger, and the
money arrives when you run that.

3. VIDEO

[LINK — unlisted, under five minutes]

4. EVIDENCE PACK

[LINK — shared folder]

The runnable half needs no link:

  https://corgi-trial-psi.vercel.app/api/health

/api/health is the authority on which slots are live — 7 of 7 at this reading,
each carrying the call that earned the label, and it publishes the webhook
delivery log alongside them: last delivery per provider, our own HTTP 202 back
to Lithic, and the parked and dead-lettered counts, unrounded. You can read all
of that without a credential from me.

With the database URL there is more:

  set -a; . ./.env; set +a
  node scripts/evidence.mjs

Claims about the live integrations, each printed beside the query or the call
that proves it, exit code 1 if any of them stops being true. It connects as the
application's restricted role, which holds no UPDATE or DELETE on a money table,
so it could not have tidied anything on the way past.

The business registry leg is GLEIF rather than one of the KYB providers on your
menu, for the reason I asked about earlier on this thread.

The standing red invariants in pnpm db:check, the parked and dead-lettered
webhook backlog, the one live-fire attack I skip on purpose, and the missing
off-ramp on the cross-border payout are all written up under "Known gaps, in one
place" in the README. I would rather you read them there than find them.

Thank you,
Saahith Veeramaneni
```

## Before sending — what Saahith must do

1. **Type the passphrase.** Replace the `<<SAAHITH: …>>` line with the
   `CONSOLE_PASSWORD` value set on the Vercel project. It is deliberately not
   written down anywhere in this repo, and no agent has been given it. Without
   it the graders can read everything and approve nothing, which is the one
   thing the trial explicitly asks them to do.

2. **Video link.** Still not recorded. `docs/VIDEO-SCRIPT.md` is the shot list.
   Its FLAGS section matters: the Lithic sandbox daily spend cap was exhausted,
   so do not simulate an authorisation on camera.

3. **Evidence folder link.** No screenshots captured, no folder exists. The
   shot list is `docs/EVIDENCE-PACK.md` §5 — the Lithic subscription and its
   delivery log, the Increase ACH transfer that settled and then returned R01,
   and the Stripe TEST MODE banner. If you provision read-only dashboard access
   instead, replace the bracketed link with the invite. If you send neither,
   delete the heading's bracket and let /api/health carry item 4 alone — say so
   plainly rather than leaving an empty placeholder in a sent email.

4. **Three repo fixes that make the repo stop contradicting this email.** None
   is mine to edit; all three are small, and `docs/SUBMISSION-CHECK.md` has the
   evidence. (a) `.env.example` is missing `CONSOLE_PASSWORD` and
   `CONSOLE_SESSION_SECRET` — two lines, and without them a grader's clone can
   read everything and write nothing. (b) `docs/CUT-LIST.md` §6 still says
   authentication was *"cut on day one and still cut"*; it shipped three commits
   later. (c) `docs/DEMO.md` §1 still says *"There is nothing to sign into"*.

5. **The invitations.** Verified pending, not accepted, at 2026-09-11T22:30Z
   (`gh api repos/SaahithV6/corgi-trial/invitations` — both created
   2026-09-10T00:32:41Z, `expired: false`, permission `read`). If either is
   accepted before you send, soften that paragraph to match.

## Numbers quoted above, and where they came from

- **commit 463488a** — `git log -1` and
  `https://corgi-trial-psi.vercel.app/api/health` → `commit.shortSha`
  `463488a`, source `VERCEL_GIT_COMMIT_SHA`. They agree.
- **7 of 7 live** — same read, 2026-09-11T22:38Z. `integrations.live` 7,
  `integrations.total` 7, `integrations.warnings` empty.
- **status "ok"** — same read. The earlier draft said "degraded"; that is no
  longer true. `webhookProcessing.degradedBy` and `webhookHealth.degradedBy`
  are both empty. Re-read the endpoint before sending and match the line to it.
- **Writes refused signed-out** — `curl -X POST -H 'Accept: application/json'
  https://corgi-trial-psi.vercel.app/approvals` → `HTTP/2 401`,
  `x-corgi-authz: deny; SIGN_IN_REQUIRED`.
- **Reads open** — `/`, `/signin`, `/payments`, `/approvals`, `/accounts`,
  `/team`, `/dashboard`, `/client`, `/client/open`, `/client/pay`,
  `/client/funding` all return 200 with no cookie.
- **59 decision entries** — `grep -cE '^## ' DECISIONS.md`, each headed with an
  ISO-8601 UTC timestamp; 39 separate commits touch the file across all three
  days.

## One thing the email deliberately does not claim

It does not say "there is no login". That sentence was true until commit
5cd3729 and is now false — `docs/DEMO.md` §1 still says it, and still says "the
credential is a role switch", which would send a grader hunting for a control
that no longer grants the ability to act. **`docs/DEMO.md` needs correcting and
I do not own that file.** If it is not corrected before sending, the email above
is still accurate on its own terms, but the repo will contradict it.
