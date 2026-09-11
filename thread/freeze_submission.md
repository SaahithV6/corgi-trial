# Freeze submission email — draft

Reply on the existing thread. Everything inside the fence is the email.

```
Subject: Work trial: Saahith Veeramaneni, Track 3

Dear Corgi Staff,

Track 3, neobank. The four things.

1. DEPLOYED URL

https://corgi-trial-psi.vercel.app

There is no login and no password. The two roles are a switch in the header of
every page, labelled "Acting as", and each resolves to a different seeded
database actor.

  Staff, the default with no cookie   Priya Raman, can_approve = false
  Approver, one click                 Dana Okonkwo, can_approve = true

Raise a payment as Staff, then switch to Approver to clear it. Staff cannot
approve anything, and Dana cannot approve the payments she raised herself:
those refuse with "that is you". The refusal comes from the database, not from
a hidden button. Every console URL also accepts
curl -b 'corgi_demo_role=approver' if you would rather script it than click.

2. REPO

https://github.com/SaahithV6/corgi-trial

Private, with @AlexanderReinicke and @mojafa invited on 10 September. Both
invitations are still pending acceptance as I send this. The deployed commit is
0fa057d and /api/health reports its own sha, so you can check the tree against
what is running. Decision log, seed script, .env.example and cut list are all in
the repo.

3. VIDEO

[LINK — unlisted, under five minutes]

4. EVIDENCE PACK

[LINK — shared folder, three screenshots]

The screenshots are the smaller half, and they cover only what a logged-in human
can see and you cannot: provider-side account ownership, the environment badge,
and the send side of the wire. The larger half is runnable.

  set -a; . ./.env; set +a
  node scripts/evidence.mjs

22 claims about the live integrations, each printed beside the query or the call
that proves it, exit code 1 if any of them stops being true. It connects as the
application's restricted role, which holds no UPDATE or DELETE on a money table,
so it could not have tidied anything on the way past. Read-only database access
and sandbox keys can be provisioned if you would rather run the provider legs
yourselves.

/api/health is the authority on which slots are live: 7 of 7 at this reading,
each one carrying the call that earned the label. The business registry leg is
GLEIF rather than one of the KYB providers on your menu, for the reason I asked
about earlier on this thread.

It reads status "degraded" right now, and that is a webhook consumer backlog
rather than a dead provider. That, the four standing red invariants in
pnpm db:check, the one live-fire attack I skip on purpose, and the missing
off-ramp on the cross-border payout are written up under "Known gaps, in one
place" in the README.

Thank you,
Saahith Veeramaneni
```

## Before sending — the two placeholders and one check

1. **Video link.** Not recorded. `docs/VIDEO-SCRIPT.md` is the shot list, and
   its FLAGS section matters: the Lithic sandbox daily spend cap was exhausted,
   so do not simulate an authorisation on camera.
2. **Evidence folder link.** No screenshots have been captured and no folder
   exists. The three shots are `docs/EVIDENCE-PACK.md` §5 — Lithic subscription
   `ep_3J8yb9xommtOdKee1FzpUA4GBrW` and its delivery log, the Increase ACH
   transfer that settled and then returned R01, and the Stripe TEST MODE banner.
   If you provision read-only dashboard access instead, replace the bracketed
   link with the invite and drop the sentence about the screenshots.
3. **The two invitations.** Verified pending, not accepted, at
   2026-09-11T14:24Z. If either is accepted before you send, change the line to
   say so.

## Two numbers quoted above, and where they came from

- **7 of 7 live** — read from `https://corgi-trial-psi.vercel.app/api/health` at
  2026-09-11T14:24Z, commit `0fa057de`. Re-read it before sending; the line
  should match the page.
- **status "degraded"** — same read. `integrations.warnings` is empty and all
  seven slots are live; the degrade comes from `webhookProcessing.degradedBy`
  naming Increase, on parked deliveries. `scripts/verify-demo.mjs` fails its
  check 1 on exactly this and passes the other seventeen (17 PASS, 1 FAIL,
  1 SKIP of 19, run 14:27Z). Do not send an email claiming "ok".
