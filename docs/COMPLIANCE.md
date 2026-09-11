# The compliance checker

`scripts/compliance.mjs` audits this repo and its deployment against every rule
in the trial, mechanically, so the rules get **run** rather than remembered.

```bash
set -a; . ./.env; set +a
node scripts/compliance.mjs                  # everything, ~25s
node scripts/compliance.mjs --only AF3,AF5   # a subset, by check id or section
node scripts/compliance.mjs --delegations    # what is run, what is cited, what is not mechanisable
```

It is **read-only against production and the database**. Every HTTP call is a
GET, except an unsigned POST to each webhook route (refused at signature
verification before anything is stored — the response says so) and a
`tools/list` POST to the MCP endpoint, which is a read. Every SQL statement is a
SELECT, except the deliberately-forbidden UPDATE whose *refusal* is the
evidence. Nothing it does moves money or writes a row.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | no check failed, and every automatic-fail check could be performed |
| `1` | at least one check **FAILED** |
| `2` | no failure, but an automatic-fail check could not be performed, so the gate is **not** cleared |

---

## The four rules it obeys

**1. A verdict is derived, never asserted.** No check prints its own status. A
check produces a list of assertions and the runner computes the verdict from
them. Any hard assertion false is FAIL; any recorded unknown is UNKNOWN; a check
that made no assertion at all is UNKNOWN, not PASS. There is deliberately no
code path from "nothing went wrong" to PASS. This is the same discipline
`livefire.mjs` takes from Vitest's JSON rather than from the tests' own opinion
of themselves.

**2. A check that cannot be performed reports UNKNOWN, with the reason. Never
PASS.** A compliance tool that guesses is worse than no compliance tool, because
it converts an unexamined risk into a green line. This repo has documented the
"it looked fine" failure eight times — DECISIONS 011, 015, 016, 017, 021, 026,
033, 034 — and every one of them was a guard reporting green about something it
had not actually looked at.

**3. Never claim a capability not proven by a real call.** Where an existing
runnable already proves a claim end to end, this tool **cites** it and says so
on the scoreboard rather than re-running it or, worse, quietly taking credit for
it. `CITED` is printed in its own column and is never counted as a pass.

**4. Money is bigint cents, in this file too.** Amounts read out of the database
stay strings or BigInts. `Number()` is never applied to one.

### The verdict vocabulary

| Badge | Meaning |
| --- | --- |
| `PASS` | at least one hard assertion was made, and all of them held |
| `FAIL` | a hard assertion was false. This is a violation, printed again in the VIOLATIONS block |
| `WARN` | every hard assertion held, but a **soft** assertion did not. A soft assertion is a proxy for a requirement rather than the requirement itself; the reasoning is always printed beside it |
| `????` | UNKNOWN — the check could not be performed. Never a pass |
| `CITE` | the claim's end-to-end proof belongs to another runnable, named with its exact leg or attack number |

---

## What is delegated, and to what

### Invoked, exit code folded into the verdict

| Check | Script | What it proves |
| --- | --- | --- |
| AF2 | `scripts/audit-claims.mjs` | every tracked `.md` diffed against the live `/api/health`: no document presents a simulated slot as live |
| AF3 | `scripts/dbcheck.mjs` | UPDATE, DELETE and TRUNCATE attempted on `journal_entry`/`journal_line` as `corgi_app` and refused; every entry sums to zero; the six invariant views are empty |

These are **called, not reimplemented**. Two guards that check the same thing
drift apart, and the one nobody runs is the one that was right.

`compliance.mjs` extends rather than duplicates them: AF3 adds the whole-tree
source grep, the `has_table_privilege` sweep across all 35 money tables, the
`pg_trigger` sweep, and a real refused UPDATE on three tables `dbcheck.mjs` does
not cover (`statement`, `payment_instruction`, `pot`).

### Cited, never run from here

| Checks | Runnable | Why not run |
| --- | --- | --- |
| LF1–LF7 | `scripts/livefire.mjs --only N` | drives production and the provider sandboxes; minutes per run and rate-limited |
| NN2, NN5, NN6, NN7, G1–G10 | `scripts/coreloop.mjs`, `scripts/livefire.mjs` | same |

A tool that takes ten minutes is a tool nobody runs continuously, and this one
is meant to run continuously. So the behavioural half is cited with its exact
command, and the structural half — *does the mechanism exist in the deployed
schema* — is asserted here. Run the cited scripts before the debrief:

```bash
node scripts/coreloop.mjs
node scripts/livefire.mjs
```

---

## What is NOT mechanisable, and is reported UNKNOWN rather than faked

### AF6 — "Code you cannot explain line by line"

**This is UNKNOWN by construction and always will be.** Whether the author can
explain a line when a grader points at it is not a property of the repository.
The check says so as its first line rather than dressing up a proxy as the
thing itself.

What it *can* assert, and does:

1. every production module under `src/lib/` carries a file header comment
   (soft — a header is evidence of intent, not of understanding);
2. `DECISIONS.md` entries are numbered and timestamped (hard);
3. those timestamps increase monotonically (**soft**, see below);
4. `git log --follow DECISIONS.md` shows the log written across many commits
   over many hours, not in one — the trial says "a single hour-47 commit titled
   'add decision log' defeats the purpose and we will read the git history"
   (hard).

Proxy 3 is soft on purpose. The trial asks for entries *written as you go*,
timestamped; it does not ask for a monotonic sequence, and parallel workers
writing up concurrent work land out of order. Proxy 4 is the check that actually
answers "written as you go", and it is hard.

### The others

| Check | Why UNKNOWN |
| --- | --- |
| SP2 | GitHub collaborator invitations are account state, not repo content |
| SP4 | the video link goes in the submission email, not the repo |
| SP5 | whether sandbox dashboard access has actually been shared is account state |
| AF4 (partial) | "no real personal data" is not decidable from a name in a seed file. What IS checked: every provider credential's shape or base URL, and that the deployed `/api/health` names no production host |
| AF2 (conditional) | see "the flapping-slot rule" below |

### The flapping-slot rule

`audit-claims.mjs` re-reads `/api/health` for its own truth. If that reading
disagrees with the one in this run's banner, the truth the documents were diffed
against was **unstable**, and a document contradiction cannot be told apart from
a transient provider probe failure.

Reporting FAIL there would send someone to edit a correct document. Reporting
PASS would hide a real contradiction. Neither is honest, so AF2 reports UNKNOWN
with both readings and says to re-run. This fires in practice: Plaid's
`POST /institutions/get` probe occasionally times out, and the endpoint reads
6 of 7 live for one request.

---

## Judgement calls the tool makes, written down so they can be argued with

Every one of these exists because the first version of the check was wrong in a
specific, recorded way.

**Money tables are wider than `journal_*`.** A table is a money table if a row
in it either records that money moved *or decides where money goes*. That takes
in card controls (a changed row changes an authorisation decision) and payees (a
changed row sends the payment to a different bank). 35 tables. `webhook_inbox`
is deliberately excluded: it is the provider's testimony, not our books, and it
holds the schema's one sanctioned column-level UPDATE grant.

**A statement written in order to be refused is proof, not breach.** The first
AF3 run flagged fifteen `await expect(sql\`UPDATE journal_entry …\`).rejects
.toThrow()` call sites — the strongest evidence in the repo that the rule holds.
A hit is now classified by its neighbourhood: refusal vocabulary within three
lines either side makes it a prover. Deliberately narrow — exempting every test
file wholesale would let a test that *genuinely* mutated a money row through
unexamined.

**A missing append-only trigger is WARN when the privilege still denies.** The
REVOKE is layer 1 and binds the application whether or not a trigger exists; the
trigger is layer 2 and also binds the table owner and any future role. A table
with neither is the automatic fail, and the privilege assertion catches that
case hard. A table protected by one and not the other is a defence-in-depth gap,
named and not allowed to hide.

**A live-mode prefix needs key material.** `sk` + `_live_` on its own is a
pattern, and three tracked documents print it while discussing the scanner that
hunts for it. Ten characters of key material is the line — the same reasoning as
the `{16,}` on `npg_` in `scripts/precommit.sh`.

**`Number(someBigIntOfCents)` is not a float.** It is an exact integer
conversion well inside `Number.MAX_SAFE_INTEGER`. The first NN9 pattern flagged
thirteen safe call sites; the second flagged `Number((cents * 100n) / total)` —
exact bigint arithmetic — because a nested paren made it look like a division.
The pattern is now the operations that actually *create* a decimal: `parseFloat`,
`toFixed`, `*100`/`/100` on a non-bigint, and division by a scientific literal.

**Numeric view columns are not a violation.** `SUM(bigint)` returns `numeric` in
Postgres, which is an exact decimal, and the trial permits "integer minor units
**or exact decimals**". The check runs against `BASE TABLE`s only and prints the
view count with the reasoning.

**This file excludes itself from two of its own scans, and says so.** It
contains the SQL verbs AF3 hunts for and the credential prefixes AF4 and AF5
hunt for. On its first run it flagged itself, exactly as `scripts/precommit.sh`
did. The live-key prefixes are assembled from fragments at runtime so the
literal string never appears here and `precommit.sh`'s tree scanner stays quiet
without a new `.secretscanignore` entry. The exemption list, with reasons, is
printed by `--delegations` and in the evidence of the checks that use it.

---

## AF5 is the check `precommit.sh` structurally cannot make

`scripts/precommit.sh` guards the staged diff and the working tree. A secret
removed from the tip but alive in an old commit is invisible to both, and is
still a committed secret.

AF5 does three things `precommit.sh` does not:

1. **`git grep` across every commit on every ref**, in chunks, for the same
   credential shapes `precommit.sh` uses — because a secret the commit gate
   would refuse today must not be alive in an old object either.
2. **`git log -S` on every current `.env` secret value.** A shape rule has false
   negatives; an exact value has none. The value goes in argv and is visible to
   other local processes for the life of the call; only the key name is ever
   printed.
3. **Proves liveness by calling the provider.** A shape match says "this looks
   like a token". `POST sandbox.plaid.com/item/get` says whether it *is* one. A
   credential you can demonstrate authenticating is worth more than a regex hit
   someone can argue with, and DECISIONS 023 set the rule this serves:
   **rotate before cleaning** — a scrubbed file with a live credential in the
   history is still a live credential.

---

## The check list

### Section A — the six automatic fails

| id | Rule | How it is checked |
| --- | --- | --- |
| AF1 | Localhost only, or a video in place of a URL | every console screen fetched from the public HTTPS origin; no tracked `.md` presents localhost *as the deployment* (lines that warn against localhost are exempt); the deployed URL is named in `README.md` and `docs/DEMO.md` |
| AF2 | A simulated integration presented as live | `/api/health` slots must each carry call evidence, not a present key; `audit-claims.mjs` invoked and its exit code folded in; UNKNOWN if the endpoint's own reading moved during the run |
| AF3 | UPDATE or DELETE on money rows. Anywhere. Ever | whole-tree grep; `has_table_privilege` over 35 money tables; `information_schema.role_table_grants`; `pg_trigger`; `dbcheck.mjs` invoked; **a real UPDATE attempted as `corgi_app` on three further tables and asserted refused** |
| AF4 | Live-mode keys, real money, real personal data | per-provider shape rules; base-URL rules where the shape carries no marker (and that stated, rather than implied); no live prefix + key material anywhere in the tree; the deployed health evidence names no production host |
| AF5 | Secrets committed to the repo | `git grep` across all refs; `git log -S` on every current `.env` secret; **Plaid token liveness proven by a real call** |
| AF6 | Code you cannot explain line by line | UNKNOWN by construction, with four proxies. See above |

### Section B — the ten non-negotiables

NN1 deployment and two roles (the role switch exercised at the deployed origin
with and without the cookie) · NN2 the ledger, including a **real bitemporal
as-of query against the deployed MCP surface** · NN3 live integrations · NN4
webhooks (unsigned POST refused at each provider path; the UNIQUE replay key;
the `parked` state; real inbox counts) · NN5 the correction test · NN6
maker-checker (`assert_maker_checker` source read for 42501 and the agent case)
· NN7 reconciliation · NN8 the MCP surface (`tools/list` against production;
read/write split from the tools' own annotations; 401 when unauthenticated;
`docs/AGENT-LIMITS.md`) · NN9 money is never a float · NN10 the decision log.

### Section C — the Track 3 domain gauntlet

G1–G10, one per item in `docs/BRIEF.md`. Each asserts the mechanism exists in
the **deployed** schema — the brief says the mechanics must live "in your schema
and your state machines, not your README" — and cites the runnable that proves
the behaviour.

### Section D — the seven live-fire scenarios

LF1–LF7, delegated in full to `scripts/livefire.mjs` and reported `CITED`. Each
resolves its own test file on disk, so a renamed or deleted attack reports
UNKNOWN rather than citing something that is not there.

### Section E — the submission package

SP1–SP8, the eight items from `docs/TRIAL-VERBATIM.md`. SP7 is the sharp one: it
asserts that **every key in `.env` has an entry in `.env.example`**.

---

## Known gaps in the tool itself

- **Dynamic routes are not probed.** `/accounts/[accountId]` and
  `/accounts/holds/[holdId]` need a real id, and inventing one would test a 404
  path. `coreloop.mjs` legs 2–4 drive both with ids it created.
- **The seed is asserted to exist, not to run.** A from-zero run writes to the
  database, which this tool must not do.
- **The deployed environment's credentials are not readable.** AF4 checks the
  local `.env` and, separately, what the deployed `/api/health` reports about
  the hosts it called. A live key set only in Vercel's environment and never in
  `.env` would be invisible to the shape checks — the health evidence is the
  only signal, and it is asserted.
- **`docs/MCP.md` publishes a working bearer token.** `compliance.mjs` uses it
  to exercise the deployed agent surface, and flags it as WARN under NN8. It is
  the agent-surface equivalent of the two demo logins the submission requires,
  and `MCP_AGENT_TOKENS` holds only its digest — but it is a credential in a
  tracked file, and the tool's job is to surface that rather than decide it.
  Set `MCP_COMPLIANCE_TOKEN` to check the surface without it.
