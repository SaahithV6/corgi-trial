Subject: Work trial: Saahith Veeramaneni, Track 3

---

Hi both,

Track 3, Neobank. Frozen at commit `826276a`.

**1 · Deployed URL**

https://corgi-trial-psi.vercel.app

There is no login for the customer side — open it and it works. The operator
console is **readable without any credential too**, on purpose: you can check
every claim below without me mailing you a secret. Writing is what needs the
passphrase.

- **Customer** — https://corgi-trial-psi.vercel.app/client
- **Operator** — https://corgi-trial-psi.vercel.app/
- **To act** — sign in at `/signin` with `PASSPHRASE_HERE`, then the
  **Acting as** control top-right switches between **Staff** (Priya Raman, no
  approval rights) and **Approver** (Dana Okonkwo, can approve). The switch
  selects which principal you are; it is not the credential.

Anonymous `POST` to any operator route returns `401` with
`x-corgi-authz: deny; SIGN_IN_REQUIRED`. With `CONSOLE_PASSWORD` unset the
console still reads and still refuses every write — an unset secret closes the
till, it never opens it. The trade is argued at the top of `docs/AUTH.md`
rather than in a footnote.

**2 · Repo**

https://github.com/SaahithV6/corgi-trial — @AlexanderReinicke and @mojafa
invited.

**3 · Video**

VIDEO_LINK_HERE

**4 · Evidence of the live integrations**

`/api/health` **publishes the webhook delivery log itself**, publicly, with no
credential:

https://corgi-trial-psi.vercel.app/api/health

It carries Lithic's latest delivery with our endpoint's own HTTP 202 and its
timestamp, per-provider last-delivery and lag, and the unrounded backlog —
parked and dead-lettered counts, not a rounded-up "all good". It cannot go
stale the way a screenshot can. EVIDENCE_EXTRA_HERE

---

**One command, if you want the whole thing checked at once**

```
pnpm confirm
```

It maps the brief line by line to a measurement taken at that moment — the ten
non-negotiables, the v1 scope, the five integrations with their live-or-
simulated column, the stretch ladder and the three things you say you grade
hardest. Nothing in it means "looks right": a row whose evidence cannot be
gathered prints UNPROVEN and says why, and it goes red when the write path is
unverified rather than reporting a clean board.

```
node scripts/coreloop.mjs
```

drives the seven-arrow core loop against the deployed URL in about ninety
seconds — open, fund, issue, authorise, settle for a different amount, raise a
payment needing a second approver, correct it, reconcile. Last run:
**PASS 7 · FAIL 0 · SKIP 0**, 112 HTTP calls to the deployment and 3 to the
Lithic sandbox, Ridgeline moving $14,221.33 → $10,947.93 available.

**Where I would look first**

- **Available is derived, not stored.** No table in this database has an
  `available_cents` column. It is one SQL function with five terms, and the
  customer screen, the console, the API and the agent all call that one.
  `/client` prints the subtraction rather than the conclusion.
- **The correction.** `/client/statements` opens on 2026-07-25: the original,
  the reversal, the re-book, the closing balance already corrected, and the
  document rebuilt twice on that page load with the same fingerprint both
  times. Value date and booking date are different columns on the base table.
- **The initiator cannot approve their own.** `/approvals`, top card: the
  controls are disabled and the reason names `assert_maker_checker()` and
  SQLSTATE 42501. The screen is telling you in advance what the database would
  do; it is not the check. The agent surface obeys the same rule — across this
  whole book it has requested 193 payments and approved 0.

**What is not here, and why**

- **No mobile app.** Deliberately cut, early, and recorded as a decision rather
  than discovered as a gap. Two surfaces already existed and a third would have
  been a third place for the same money to be described differently.
- **Six invariants are red right now**, and every one carries a written
  argument in `scripts/dbcheck.mjs` itself. `dbcheck` prints
  `NOT ON THE REGISTER` for any red that does not — there are none. The most
  interesting is over-capture: it writes no closure row, because the network
  reopened a hold after an over-capture and captured it, so closing on
  captured-exceeds-authorised would have freed money that was still authorised.
- **Reads are open to anyone with the link.** In a real bank that is not a
  small deviation, and `docs/AUTH.md` says so in those words along with the
  three things a real deployment needs that this does not have.
- **Two rows on the book came from proving the payee gate**, both $1.00, both
  still `requested`, neither approved or released. And a **$10,000 inbound ACH
  from CORGI TREASURY is deliberately unbooked** — nothing on the book can say
  whose it is, and mapping the account number would be guessing.

The decision log, seed script, `.env.example` and cut list are in the repo.

Thanks — looking forward to the debrief.

Saahith
