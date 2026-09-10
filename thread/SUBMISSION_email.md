Subject: Work trial: Saahith Veeramaneni, Track 3

Dear Corgi Staff,

Track 3, neobank. Freeze at 17:13 PDT on Friday 11 September. The four things:

1. Deployed URL
https://corgi-trial-psi.vercel.app

There is no login. Both roles are a switch in the header of every console page,
under "Acting as", and each resolves to a different seeded database actor.

  Staff (default, no cookie)  Priya Raman, can_approve = false
  Approver                    Dana Okonkwo, can_approve = true

Raise a payment as Staff, then switch to Approver to clear it. Staff cannot
approve their own payment, and the refusal comes from a database trigger rather
than a hidden button.

2. Repo
https://github.com/SaahithV6/corgi-trial
@AlexanderReinicke and @mojafa are invited. The decision log, seed script,
.env.example and cut list are all in it.

3. Video
[LINK]

4. Evidence pack
[LINK]

One thing worth reading before the debrief. /api/health is the authority on
which integrations are live, and every claim in the repo is checked against it
by scripts/audit-claims.mjs, which fails the commit if a document disagrees.
The one simulated slot says so, with the measured reason attached.

Thank you,
Saahith Veeramaneni
