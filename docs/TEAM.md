# The team: members, their cards, and what happens to money when one of them leaves

The first paragraph of the brief, verbatim from `docs/BRIEF.md`:

> Business current accounts. Customers hold a balance, send and receive
> payments, and **get a card for each person on the team**.

Everything downstream of that sentence was already built — real cardholders,
real virtual cards, authorisations decided inside a measured 6000 ms ASA window,
per-card controls versioned and pinned — and the sentence's **subject** was not.
There were two demo personas and no notion of a business having *people*.

That gap is why several controls in this build read thinner than they are:

* `assert_maker_checker()` has refused to let an initiator approve their own
  payment since migration 0001, in the database. But "initiator" and "approver"
  were demo personas rather than members of a company, so the constraint guarded
  a distinction nothing modelled.
* a spend limit was per **card**. A card is an instrument; re-issuing one is a
  new `card` row (0008), so a per-card monthly limit silently *resets* when a
  card is replaced. A limit is something you give a **person**.
* nothing answered *"who at this business can do what, and who spent this."*

This document is the design, the measurements, and an exact statement of what is
real.

---

## 1. The role model, and why these four

The brief names the verbs itself, one per line:

| The brief says | The role |
| --- | --- |
| "Users need to **see their balance**." | `viewer` |
| "Users need to **approve payments** above a threshold." | `approver` |
| …and a payment must be *raised* before it is approved | `initiator` |
| …and somebody holds the roles, the limits and the cards | `admin` |

Four roles, each because a sentence of the brief requires it, and none because a
permissions matrix looked asymmetric. **Four roles that are enforced beat twelve
that are documented**, so every capability below is read by a database trigger or
by the real-time authorisation decision, and none of them is read only by a
screen.

| capability | viewer | initiator | approver | admin |
| --- | --- | --- | --- | --- |
| `view_balance` | yes | yes | yes | yes |
| `raise_payment` | no | yes | yes | yes |
| `approve_payment` | no | no | yes | yes |
| `administer_team` | no | no | no | yes |

**One definition, two copies, and the copy is checked.** The authority is
`team_role_can(role, capability)` in migration 0033 — an `IMMUTABLE` SQL function
— because the triggers that actually refuse things cannot call TypeScript.
`src/lib/team/roles.ts` restates it so a screen can grey out a button without a
round trip, and `team.integration.test.ts` asserts the two agree **cell by cell**
against the live database, all sixteen cells plus a capability neither has heard
of. Two copies of a permission matrix is exactly how a permission system becomes
decorative.

### The objection worth making: why `admin` carries `approve_payment`

An administrator who can also approve holds unilateral control in a one-admin
business — they choose the approvers *and* are one. Taking approval away from
admins does not fix it; it moves it, because the admin can promote a compliant
subordinate instead. It is fixed by the independence rule in §5.

### What a member *is*

A member **is an `actor`** — `team_member.actor_id` — and not a parallel
identity. Every attribution in this system already runs through `actor_id`:
journal entries, payment instructions, approvals, card control versions.
Inventing a second principal type would mean each of those either learns about
members or silently keeps working on the old one, and the second is how a
permission system becomes decorative.

---

## 2. The schema

```
team_member                one spell of one person's membership of one business
  └─ team_member_version   append-only chain: state, role, THEIR OWN limits
card_member                which person holds which card  (PK: card_id)
card_auth_decision         + member_id, + member_version_id
```

### `team_member`

Deliberately carries no state and no role: those change over time and therefore
live in the chain, for the same reason `card_control_version` exists rather than
mutable columns on `card`.

`membership_seq` is the **spell**. Removal is terminal within a chain, so
re-hiring somebody is membership 2 — a new row, a new id, and their two spells
are two histories that cannot be confused. The alternative (writing an `active`
version after a `removed` one) would let a single append silently re-arm a card
that had been revoked, which is the one thing removal must not be one keystroke
away from. Re-adding **reuses their actor row**, so their old journal entries,
approvals and card decisions still point at the same principal and their history
reads as one person's.

### `team_member_version`

Role, state and the person's own limits in **one** chain, because they are one
question — "what is this person allowed to do, and since when" — and because a
decision pins **one** version id. Three chains would mean three ids on every row
and three ways for an audit to find a different answer.

`NULL` limit ≠ `0` limit, the same distinction 0014 makes for cards: `NULL` is
"no limit of this kind on this person", `0` is "this person spends nothing". Both
are reachable from the screen and they mean different things.

Four things a new version must satisfy, all asserted by
`assert_team_member_version()`:

1. **contiguity** and monotonic `effective_from` — 0014's argument applied to
   people;
2. **terminality** — nothing follows `removed`;
3. **the approval envelope** — see below;
4. **authorship** — the author is an **active** member holding `administer_team`
   here, or is Corgi staff. The word *active* is migration 0044's and it is the
   whole of §11: until 0044 a **removed** admin passed this check rather than
   failing it.

### `card_member`, and why it is a table rather than a column

`card` is append-only with `SELECT, INSERT` only, and its INSERT is owned by
`registerCard()` in `src/lib/holds/store.ts`. A nullable `member_id` column would
have meant either a second INSERT statement against `card` — **a second issuing
path, which is the thing to avoid** — or an UPDATE, which does not exist on that
table and never will. A binding table is written *after* the existing issuing
path runs, unchanged, and costs one indexed join on the hot path.

`PRIMARY KEY (card_id)`: a card belongs to exactly one person for its whole life.
Moving a card to a different person is re-issuing, which is what 0008 already
says about moving a card to a different *customer*.

---

## 3. Approval rights, and the one thing this migration may not do

`corgi_app` holds **SELECT and only SELECT** on `actor`, and
`src/lib/approvals/approvals.integration.test.ts` asserts it by attempting
`INSERT INTO actor (kind, display_name, can_approve) VALUES ('agent', 'rogue',
true)` and requiring `permission denied`. That assertion is correct and it stays
true: **nothing in 0033 widens that grant.**

So adding a member goes through `team_add_member()`, a `SECURITY DEFINER`
function — the same pattern and the same argument as `ledger_append()`: *"so
corgi_app can call it without holding privileges it should not have."* Because it
is the only path, it can enforce things a grant cannot:

* `kind` is hardcoded `'human'` — the application cannot create an agent through
  this door, with or without approval rights;
* `business_id` is always set — it cannot mint a Corgi staff actor;
* `can_approve` is derived from the role, **once**, at creation;
* the membership and terms version 1 are written in the same statement, so **a
  membership with no terms is unrepresentable**;
* the author must hold `administer_team` in this business, or be Corgi staff.

### The consequence, stated rather than discovered

`actor.can_approve` is append-only and 0001 owns it, so **a member created as a
viewer or an initiator can never be promoted into approval rights.** Migration
0033 refuses that promotion *loudly*, at the moment somebody tries to write it:

```
actor 1a2b… was created without approval rights (actor.can_approve is false and
actor rows are append-only), so member 3c4d… cannot hold the role approver.
Approval rights are granted when the member is created, never afterwards
```

The alternative was to accept the promotion and have `assert_maker_checker()`
silently refuse the approval three days later, which is the defect class this
whole build hunts: **a screen that says yes and a database that says no.** A
demotion is always allowed, because narrowing is always safe.

The right end state is a narrow, audited `UPDATE (can_approve) ON actor` or a
second definer function; both are changes to a table `src/lib/approvals/` is
graded on and neither was this work's to make. §9 says what is needed.

---

## 4. Per-person limits, inside the same 6000 ms decision

`docs/CARD-CONTROLS.md` §2 measures the provider's window: **the hard timeout is
6000 ms and on timeout Lithic DECLINES**, stamping `CUSTOMER_ASA_TIMEOUT`. Our
own budget is 1400 ms against Lithic's 3000 ms recommendation, and the control
read owns 600 ms of it.

**The per-person check adds nothing to that budget, because it adds no round
trip.** `readControlsAndSpend()` was already one statement; it is still one
statement. It gained three `LEFT JOIN`s (`card_member`, `team_member`, `actor`,
`v_team_member_current`) and a second `CROSS JOIN LATERAL` that sums the person's
approved spend the same way the first one sums the card's.

`EXPLAIN (ANALYZE, BUFFERS)` on the new hot-path query, run on Neon:

```
Limit  (actual time=0.417..0.422 rows=1.00 loops=1)
  Buffers: shared hit=11
  ->  Index Scan using card_provider_key on card c  (actual time=0.016..0.016 rows=1.00)
  ->  Index Scan using card_member_pkey on card_member cm  (actual time=0.003..0.003)
  ...
Planning Time: 2.222 ms
Execution Time: 0.636 ms
```

**0.636 ms server-side**, against a 600 ms deadline — a ~940× margin, where the
card-only query measured 0.11 ms. Eleven shared buffer hits and no I/O. The
`Seq Scan`s in that plan are on tables with 4 and 19 rows; the planner will use
`card_auth_decision_member_velocity_idx` when the table is large, and no index
was added that the planner already has.

### The rules, in evaluation order

First match wins. `RULE_ORDER` in `src/lib/cards/decide.ts` is the evaluation
order and is a separate constant from the display order, so reordering a table on
a screen cannot change what a card is allowed to buy.

| # | rule | outcome | wire result |
| --- | --- | --- | --- |
| 1 | `control_store_unavailable` | decline | `VELOCITY_EXCEEDED` |
| 2 | `card_not_under_control` | approve | `APPROVED` |
| 3 | `balance_inquiry_not_a_purchase` | approve | `APPROVED` |
| 4 | `credit_not_a_purchase` | approve | `APPROVED` |
| **5** | **`member_removed`** | **decline** | **`CARD_PAUSED`** |
| **6** | **`member_suspended`** | **decline** | **`CARD_PAUSED`** |
| 7 | `card_frozen` | decline | `CARD_PAUSED` |
| 8 | `mcc_blocked` | decline | `UNAUTHORIZED_MERCHANT` |
| 9 | `per_transaction_limit_exceeded` | decline | `VELOCITY_EXCEEDED` |
| 10 | `daily_limit_exceeded` | decline | `VELOCITY_EXCEEDED` |
| 11 | `monthly_limit_exceeded` | decline | `VELOCITY_EXCEEDED` |
| **12** | **`member_per_transaction_limit_exceeded`** | **decline** | **`VELOCITY_EXCEEDED`** |
| **13** | **`member_daily_limit_exceeded`** | **decline** | **`VELOCITY_EXCEEDED`** |
| **14** | **`member_monthly_limit_exceeded`** | **decline** | **`VELOCITY_EXCEEDED`** |
| 15 | `no_controls_configured` | approve | `APPROVED` |
| 16 | `within_controls` | approve | `APPROVED` |

Four positions that are arguments, not accidents:

* **5 and 6 sit before rule 15.** `no_controls_configured` *approves*. If the
  member rules sat after it, a removed person holding a card nobody had ever
  configured would keep spending. `team.integration.test.ts` scenario 5 drives
  exactly that card: no control version at all, approved before the removal,
  `member_removed` after, with `controls_consulted: false` on the row.
* **5 and 6 sit after rules 3 and 4.** A **refund to a removed person's card is
  still approved.** The money goes back to the *business's* 2100 — the card posts
  to the customer's account, not to the individual — so declining it would leave
  the customer unable to receive their own money back because an employee left.
  Revoking somebody's ability to spend is not revoking the business's ability to
  be repaid.
* **Rule 15's predicate is tightened.** It now also requires the card to belong
  to nobody. A card with no control version whose *holder* has limits has been
  judged, and saying "no controls have been set" about it would be false.
* **The card is checked before the person.** The card is the narrower instrument
  and the thing an operator most recently touched; the person is the outer
  envelope, and *"you are inside every limit on this card but outside your own
  monthly allowance"* is the sentence that should come second. Both are recorded
  either way, under different rule names, so a decision log can be grouped by
  which scope refused.

### The person's spend is across every card they hold

That is the point of a per-person limit: a $2,000 monthly allowance that reset
every time somebody was given a second card would not be an allowance.
`team.integration.test.ts` scenario 8 approves $300 on card A and then watches
$200 on card B decline with `spend_cents: "30000"` and
`would_total_cents: "50000"` against a $400 daily limit — a decline **no per-card
limit can produce**.

### Which direction it fails in, and why

**It fails closed, and it inherits that rather than choosing it.**

The member facts arrive in the *same statement*, under the *same* 600 ms
deadline, as the card's. There is no second query, no second deadline and no new
way to be slow. If that one statement misses its deadline the lookup is
`unavailable` and rule 1 declines — which is the direction `docs/CARD-CONTROLS.md`
§5 already argued for, and which is **more** right for a member check than for a
card limit:

> Limits and category blocks are preferences. Freeze is a commitment, and a card
> control product whose off switch works only while the database is healthy has
> not shipped an off switch.

Removing somebody is a **revocation** — the same class of promise as freeze, made
about a person who may have just been dismissed. A revocation that only holds
while the database is reachable has not been made. The failure modes are not
symmetric: a wrong decline is recoverable and leaves a row saying why; a wrong
approval on the card of somebody who was removed this morning is money gone.

The one deliberate fail-**open** is unchanged and now has a sibling: **a card
that belongs to no member is judged exactly as it was before this feature
existed.** Every card in this book predates it. That is the same distinction rule
2 draws — *"we know the answer is no member"* versus *"we do not know the
answer"* — and the two get opposite defaults.

---

## 5. Maker-checker, now that there are members

`assert_maker_checker()` (0001) is **left alone**, for the reason 0007 gives at
length: it is applied, hashed and immutable, and re-issuing it to bolt on
branches would put the self-approval refusal at risk for the sake of an addition.
0007 added a second `BEFORE INSERT` trigger that composes with it. 0033 adds the
third, `payment_instruction_event_team`.

**This trigger can only ever refuse.** Every check is a narrowing of what 0001
already allows; there is no branch that permits an approval 0001 would have
refused. That property is what made it safe to add to a live path.

### (1) A member may only approve their own business's payments

A hole that existed until tonight: 0001 gates on `actor.can_approve`, which is
**global**. Alex Whitfield, a signer scoped to Ridgeline, could approve Kettle &
Crumb's payment and nothing in the database would have stopped him. Corgi staff —
actors with no membership anywhere — are unaffected, because approving across
customers is their job. Proven in `team.integration.test.ts`:

> `actor … is a member of another business and is not a member of business …`

### (2) The current role decides, not the actor column

A removed member's `actor` row still says `can_approve`, because actor rows are
append-only and 0001 owns that column. Their membership says `removed`, and this
is where that stops being a label. The test asserts both halves: that
`actor.can_approve` is still `true`, and that the approval is refused anyway.

### (3) The independence rule — the answer on mutual approval

**Can two members of the same business approve each other's payments?**

**Yes, and that is the deliberate answer.** What maker-checker actually buys is
that two humans looked at the same payment with the same content hash.
Forbidding peers from approving each other would make the control unusable for a
three-person business, and an unusable control is not a stricter control — it is
a control people route around by sharing a login, which destroys attribution
entirely and takes the audit trail with it. Every business banking product that
ships dual authorisation allows peer approval. Collusion is a real risk and no
threshold fixes it; it is answered by attribution and audit, both of which this
system has.

**Except where the second pair of eyes is not independent.** A member whose
**role, spend limits and continued membership** are all controlled by the
initiator is not a second pair of eyes; they are an extension of the first, and
the initiator can make that explicit at any time by writing a version of their
terms. So an approval is refused when the initiator holds `administer_team` in
the business and the approver does not:

> `maker-checker: actor … administers the team actor … belongs to, so a
> approver approving an admin's payment is not an independent approval. An
> admin's payment needs a peer admin or a Corgi staff approver`

**Only one direction is refused.** An admin approving a junior's payment is fine
— the approver is not under the initiator's control. A junior approving *their
admin's* payment is not.

**The consequence, stated rather than discovered:** a business with exactly one
admin cannot approve that admin's above-threshold payments internally. It must
appoint a second admin, or use a Corgi staff approver. That is precisely what a
bank means by "two authorised signatories", and it is the correct amount of
friction on the one account where a single person would otherwise hold both
halves of the control.

### (4) And the maker

`assert_team_initiator()` on `payment_instruction`: a member whose role does not
carry `raise_payment` cannot raise one, and a suspended or removed member cannot
raise one at all. Same narrowing property — an actor with no membership is
untouched, so the agent surface, the standing-order runner and Corgi staff all
behave exactly as they did.

---

## 6. Removing a member safely

Three things have to be true afterwards:

1. **their card stops authorising;**
2. **their history does not vanish;**
3. **an authorisation already outstanding still settles correctly.**

### (2) and (3) are free — by construction, not by care

Removal is **one INSERT**: a new `team_member_version` with `state = 'removed'`.
There is no verb available that could delete the member, the card, the
authorisation, the hold or a journal line; the role holds no `UPDATE` or `DELETE`
on any of them and the triggers refuse it even against the owner.

The settlement path is keyed on the **provider card token** and resolves to the
business's 2100 and 9100 leaves (`resolveCard`). Removal touches none of those,
so a clearing that arrives three days later posts exactly as it would have if
nobody had left.

The two bugs this avoids are worth naming, because both are what "delete user"
means in most systems:

* **releasing the hold** hands the customer back money the merchant is still
  going to claim. The clearing then arrives against a released hold: a double
  count, found days later by reconciliation.
* **deleting the card row** orphans the authorisation outright — the Lithic
  consumer parks on an unknown card token and the money never books at all.

### (1) takes work, because there are two mechanisms

| | mechanism | live when |
| --- | --- | --- |
| ours | the ASA decision declines on rule `member_removed` | Lithic is enrolled to call us — and **ASA is currently disenrolled** (`docs/CARD-CONTROLS.md` §1, call 7) |
| theirs | `PATCH /v1/cards/{token}` `{"state":"CLOSED"}` | always. The issuer enforces it on their own side |

A removal that relied on the ASA rule alone would be a revocation that **does
nothing tonight**, behind a screen that says the card is off. So removal does
both, and it calls **the provider first**: if the order were reversed and the
provider call failed, there would be a window in which this system says the
person is gone and their card still spends — a screen lying in the dangerous
direction.

**The append happens even if the provider call fails**, because a revocation must
not depend on a third party being reachable. What changes is that the result
carries `enforcedAtIssuer: false` and names the tokens still open, and the screen
says so in the failure colour. The two mechanisms are deliberately redundant and
fail in opposite directions: ours declines when *we* cannot be reached, theirs
declines when *they* cannot reach us.

`suspended → PAUSED` and `removed → CLOSED` line up the reversibility of the two
systems: a state that can be undone here maps to a state that can be undone
there, and a terminal state maps to a terminal one. A removal that only PAUSED
the card would leave a revoked person's card one API call away from spending
again.

---

## 7. Measured, end to end, with real ids

Every call below was made on **2026-09-11** against the live Lithic sandbox and
the live Neon database, by the code in `src/lib/team/`. Nothing here is inferred.

### Four real cards, one per person, on Ridgeline Robotics, Inc.

Issued through `createCard()` → `registerCard()` → `card_member` — the same
Lithic path `/accounts` uses, not a second one:

| person | role | Lithic card token | last four |
| --- | --- | --- | --- |
| Alex Whitfield | admin | `e54d6e93-631a-4d9d-9f39-f6e395f655aa` | 3787 |
| Noor Haddad | approver | `84b40e67-0eb3-4309-953e-cfd3b7305d70` | 2656 |
| Theo Marchetti | initiator | `43ea116a-b1ed-4023-83b5-ff69bf3e46f1` | 9128 |
| Ruth Castellanos | viewer | `d7a79245-c8a0-48b2-a987-3780adeb25b1` | 7282 |

### The removal, with money in flight

Theo Marchetti, member `25322920-f995-4aac-91e9-4de9efe46c29`:

```
1. simulate/authorize $50.00, MCC 5542
     transaction  a74d2a7f-0990-41d4-9739-6fa888abc9ba
   real webhook -> inbox -> dispatcher -> applyCardTransaction()
     auth   77ce76ce-2839-46a5-9988-aeef5979ca71
     hold   04e971a9-7b74-4cae-a397-7a80cb483f3f
     A(E) 5000   C(E) 0   H(E) 5000   memo 5000

2. REMOVE  (endMembership, state = removed)
     terms version 2
     PATCH /v1/cards/43ea116a-… {"state":"CLOSED"}  -> ok
     enforcedAtIssuer: true
     GET  /v1/cards/43ea116a-…                     -> "CLOSED"

3. outstanding AFTER the removal
     A(E) 5000   C(E) 0   H(E) 5000   memo 5000      ← IDENTICAL

4. simulate/clearing $73.40 on the CLOSED card       -> ACCEPTED
   real webhook -> the same pipeline
     A(E) 5000   C(E) 7340   H(E) 0   memo 0
```

**Three things that measurement establishes.**

* The outstanding authorisation is **byte-identical either side of the
  removal** — same hold id, same H(E), same memo balance. The integration suite
  asserts that on a fixture too, with `expect(after).toEqual(before)`.
* **Lithic accepts a clearing on a CLOSED card.** That is the fact the choice of
  `CLOSED` over `PAUSED` for removal rests on, and it had to be measured rather
  than assumed: if closing a card had blocked its outstanding authorisations from
  clearing, `CLOSED` would have been a money bug and `PAUSED` the only safe
  answer. It does not, so a removal is terminal at the issuer *and* the money
  still settles.
* The **over-capture** settled for $73.40 against $50.00 authorised, released the
  hold exactly once, and posted to Ridgeline's 2100 — for a person who was not on
  the team when the money moved. Which is correct: the business owes the
  merchant, not the employee.

### The edge state's standing row

Cass Brennan, member `e19c319a-c5ed-4d1e-a6c7-dcff818505f2`, card
`249a5d92-a3f0-450b-938c-d1c07e9e534e` (•••• 5601), removed with authorisation
`20d97e68-45bb-4dd7-a34c-d9d4d4af2dc2` still outstanding: hold
`d827e731-9283-452c-976b-7dddcee22669`, H(E) $50.00, card `CLOSED` at Lithic.
That is what `/team?state=edge` renders, live.

### Both invariants, made to fail on purpose first

A guard nobody has seen fail is a claim. Both were made to fail against this
database, in transactions that were rolled back, **before** they were written
down here.

```
v_approved_auth_for_dead_member        0 -> 1
  a card_auth_decision with outcome 'approve', request_status 'AUTHORIZATION'
  and member_version_id pointing at a version whose state is 'removed'
  (team.integration.test.ts scenario 11 — asserts the delta, then rolls back)

v_member_approval_without_right        0 -> 1
  a payment_instruction_event 'approved' by a member whose role at that instant
  was 'viewer'. BOTH triggers had to be disabled to write it at all —
  assert_maker_checker (actor.can_approve is false) and
  assert_team_maker_checker (the role does not carry approve_payment) — which
  is itself the proof that the two compose.
  row: {"role_at_approval":"viewer","state_at_approval":"active"}
```

Both are zero against this database, and the `/team` screen counts them on every
request, because an assertion nothing queries is a comment.

---

## 8. The screen

`/team`. Five states on `?state=`, plus `?business=` and `?member=`.

| URL | state |
| --- | --- |
| `/team` | **default** — live members, live cards, live limits beside live spend |
| `/team?state=loading` | **loading** — the real skeleton in front of a genuinely slow read (3 s) |
| `/team?state=empty` | **empty** — a business with an account and no people. Not an error |
| `/team?state=error` | **error** — the read failed; names what the *same* failure means on the authorisation path |
| `/team?state=edge` | **edge** — **a member removed while holding an outstanding authorisation** |

**`default` and `edge` are live; `edge` is a FILTER over the same rows** rather
than a second read, so the two can never disagree — and when nobody is in that
state the screen says so instead of manufacturing a subject. `empty` and `error`
are fixtures and print FIXTURE on their own face.

The edge state is the one that matters, because it is the state most likely to
render wrong: a screen that shows "removed" beside "$50.00 held" invites a
ticket. So the screen makes the argument at the point of the evidence — what
removal did, what it did not touch, and why that money is still there.

`src/lib/team/screen.render.test.ts` renders every state through
`renderToReadableStream`, waits on `stream.allReady` so a throw inside a boundary
fails the test rather than emitting a fallback, and re-throws from `onError`. The
live states read Neon. Nothing in it writes.

---

## 9. What is needed from files this work could not touch

Reported rather than done, because each is in a module another agent owns
tonight.

1. **`src/components/app-shell/NavLinks.tsx` — one line.** `/team` exists and
   nothing links to it. Until that lands, the route is reachable only by typing
   the URL.

2. **`db/migrations/` — two columns on a view.** `v_card_auth_decision` (0014)
   has an explicit column list, so the two columns 0033 added to
   `card_auth_decision` are not in it:

   ```sql
   CREATE OR REPLACE VIEW v_card_auth_decision AS
   SELECT …, d.member_id, d.member_version_id FROM …;
   ```

   A migration is immutable once applied, so 0033 can no longer be that file.
   `listDecisions()` currently reaches the two columns by primary key back to the
   base table, which works and is one index lookup off the hot path.

3. **`scripts/dbcheck.mjs` — ~~two lines~~ LANDED.** Both invariant views are
   now in `INVARIANT_VIEWS` beside the others, and both are proved by
   `--prove`. 0044 added a third, `v_team_terms_by_unauthorised_author`, in a
   side array — see item 6 for why, and for the one-word caption it leaves
   behind.

4. **`scripts/seed.mjs` — a team block.** The demo team was created by calling
   `team_add_member()` and `issueCardToMember()` directly. A seed that stands up
   believable demo data from zero should create four members and four cards.
   `addMember()` and `issueCardToMember()` in `src/lib/team/` are the two calls it
   needs.

5. **`src/lib/approvals/` — nothing required, one thing wanted.** No change is
   needed for anything above to work: 0033's triggers compose with
   `assert_maker_checker()` and narrow it, and the grant surface is untouched.
   What is *wanted* is a way to grant approval rights to an existing member —
   today `actor.can_approve` is fixed at creation (§3) and a promotion across
   that boundary is refused. The narrow fix is a second `SECURITY DEFINER`
   function owned by `approvals/`, `approvals_grant_can_approve(actor_id,
   granted_by)`, writing an append-only `actor_approval_grant` row that
   `assert_maker_checker()` reads instead of the column. That changes a function
   0007 explicitly says to leave alone, so it belongs to whoever owns that
   module, not to this one.

6. **`src/lib/chaos/invariants.ts` — one line, and `TeamView.tsx` — one word.**
   0044's `v_team_terms_by_unauthorised_author` runs in `scripts/dbcheck.mjs`
   from a side array, for the reason every previous side array existed:
   `src/lib/chaos/invariants.test.ts` parses the gate's FIRST array literal and
   asserts the chaos dashboard's copy lists exactly the same views in the same
   order, and `src/lib/chaos/**` was outside this change's write scope —
   appending above without the mirroring edit turns `pnpm test` red for a
   worker who cannot fix it. Whoever owns that module moves the view into the
   first array and mirrors it, in one commit. Separately,
   `readTeamInvariants()` now returns **three** invariants and
   `src/components/team/TeamView.tsx:157` still captions the block "Two
   invariants from migration 0033". The rows are right and live; the caption is
   one stale word.

---

## 10. What is deliberately not built

* **No per-member MCC blocks.** MCC belongs to the card, which is the instrument
  presented at the terminal. A person-level category rule is a rule engine, and
  `docs/CARD-CONTROLS.md` §10 already declines to build one.
* **No promotion across the approval boundary.** §3. Refused loudly rather than
  accepted and ignored.
* **No per-member availability check.** The authorisation path still does not
  read the ledger, for the reason `docs/CARD-CONTROLS.md` §4 gives: a synchronous
  decision that contends with the journal's append lock is a declined card.
  "Can this person spend" and "does this business have the money" are different
  questions and only the second one needs the journal.
* **A voided authorisation still does not give its velocity slot back** until the
  window rolls — now for the person as well as for the card. Conservative
  direction, and it is a second query on a budgeted path.
* **One card per person is not enforced.** A member may hold several, and their
  limits apply across all of them, which is the correct behaviour for a
  replacement card issued mid-month. Nothing stops an admin issuing five.
* **Multi-business membership is representable and untested at scale.** The
  schema scopes everything by `(business_id, actor_id)`, so an accountant on two
  teams works; no screen offers it.

---

## 11. The authorship hole, and migration 0044

`docs/TEST-AUDIT.md` §1 found it and proved it twice. This section is the
repair, measured the same way.

### What was wrong

`assert_team_member_version()` clause (d) and `team_add_member()` both
established the author's authority with the same lookup and the same gate —
`0033:309-322` and `0033:818-831`:

```sql
SELECT tmc.role INTO v_author
  FROM team_member tm
  JOIN v_team_member_current tmc ON tmc.member_id = tm.id
 WHERE tm.business_id = …
   AND tm.actor_id    = <the author>
   AND tmc.state <> 'removed'          -- <<<<
 ORDER BY tm.membership_seq DESC
 LIMIT 1;

IF v_author IS NOT NULL AND NOT team_role_can(v_author, 'administer_team') THEN
  RAISE EXCEPTION …
```

`v_author IS NULL` is the **Corgi-staff break-glass branch** — 0033 says so at
`:250-252` and `:817`, "an admin of this business, or Corgi staff". Staff carry
`business_id IS NULL`, match no `team_member` row, and are correctly waved
through.

But `AND tmc.state <> 'removed'` made the lookup **also** return NULL for a
removed member of that very business. Removal did not fail the authorship
check; it moved the actor out of the branch that **checks** and into the branch
that **trusts**. **What the lookup excluded from itself was exactly the
population it existed to stop.**

The code could not tell *"no such member"* from *"a member who was removed"*,
because it asked one question — `role` — and threw the second fact away inside
the `WHERE` clause. Those are different facts and they deserve opposite answers.

### Why it is worse than an ordinary authorisation hole

`actor.can_approve` is decided **once**, inside `team_add_member()`, and `actor`
is append-only — §3. So a removed admin did not merely edit a row. They minted
a **fresh approving principal**: a new `actor` with `can_approve = true`, an
active `approver` membership, and a live claim on the second pair of eyes the
whole maker-checker control rests on.

Removal is meant to be the remedy for a compromised signer. It was the
qualification.

### Why 23 green passes missed it

All 17 membership writes in `team.integration.test.ts` passed `actorId: STAFF`
(`business_id IS NULL`) — **the NULL branch by construction** — and
`src/lib/approvals/session.ts:70-78` resolves the console session with
`WHERE kind = 'human' AND business_id IS NULL`, so the product has no caller
that can drive the other branch either. The check that
`src/app/(app)/team/actions.ts:35-40` cites as its reason for having no
TypeScript copy **had never once executed**. All 275 `team_member_version` rows
on this book are authored by Corgi staff; that is the measurement, not an
inference.

### The fix

The state filter comes **out** of the lookup and becomes a **refusal**:

```sql
SELECT tmc.role, tmc.state INTO v_author_role, v_author_state
  FROM team_member tm
  JOIN v_team_member_current tmc ON tmc.member_id = tm.id
 WHERE tm.business_id = …
   AND tm.actor_id    = <the author>
 ORDER BY tm.membership_seq DESC
 LIMIT 1;
v_author_found := FOUND;

IF v_author_found THEN
  IF v_author_state <> 'active' THEN RAISE …   -- names the state
  IF NOT team_role_can(v_author_role, 'administer_team') THEN RAISE …  -- 0033's sentence, unchanged
END IF;
```

**This is not a new idea.** It is exactly the shape the other two triggers in
0033 already use, twenty lines apart — `assert_team_initiator()` and
`assert_team_maker_checker()` both take `FOUND` into a boolean and then refuse
`state <> 'active'` by name. Those two got it right. The two authorship checks
are the two that did not, and after 0044 all four read the same way.

`suspended` is refused by the same line, for the same reason: 0033 §7 already
holds that a suspended member may neither raise nor approve a payment, and
deciding *who else may* is strictly more authority than either.

Both functions are **replaced**, in `db/migrations/0044_team_author_removed.sql`
— 0033 is applied and hashed and `scripts/migrate.mjs` refuses a file whose
contents changed. `CREATE OR REPLACE FUNCTION` keeps the OID and therefore the
ACL; it does **not** keep `proconfig`, so `SET search_path = public, pg_temp` is
restated in both bodies, and a `DO` block at the foot of 0044 reads `proconfig`,
`prosecdef`, `proacl` and the trigger's `tgfoid` back out of the catalogue and
aborts the migration if any of them moved. Verified after applying:

```
assert_team_member_version  proconfig {search_path=public, pg_temp}  secdef f  acl NULL
team_add_member             proconfig {search_path=public, pg_temp}  secdef t
                            acl {neondb_owner=X/neondb_owner,corgi_app=X/neondb_owner}
```

### Made to fail and made to pass, on the live database

`corgi_app` — **the application role, not the owner** — inside a transaction
that ended by throwing. Nothing was disabled and nothing was left behind.

```
current_user = corgi_app
BEFORE  {"unauthorised_author":0,"approval_without_right":0,
         "ridgeline_members":205,"ridgeline_approvers":58}

(3) an ACTIVE admin of this business — the non-NULL branch that must STILL PASS
    active admin promotes a colleague approver -> admin
      -> ALLOWED   terms version 2 written

    remove that admin (authored by Corgi staff)
      admin is now state=removed role=admin; their actor.can_approve is still true

(1) the REMOVED member, both functions
    removed admin authors the colleague's next terms
      -> REFUSED   actor 9a10de1d-… is a removed member of business e274546d-…
                   and cannot change a member's terms; only an ACTIVE admin of
                   this business, or Corgi staff, may. A removed member is not
                   Corgi staff -- staff hold no membership of any business, and
                   ending somebody's membership ends their authority rather
                   than conferring the bank's
    removed admin calls team_add_member() to mint an approver
      -> REFUSED   actor 9a10de1d-… is a removed member of business e274546d-…
                   and cannot add members; only an ACTIVE admin of this
                   business, or Corgi staff, may. A removed member is not Corgi
                   staff -- and adding a member is the one moment
                   actor.can_approve is decided, so this door is how a removed
                   signer would mint their own second pair of eyes

(2) genuine Corgi staff (kind=human business_id=null can_approve=true)
    Corgi staff authors the same colleague's terms
      -> ALLOWED   terms version 3 written

AFTER   {"unauthorised_author":0,"approval_without_right":0,
         "ridgeline_members":207,"ridgeline_approvers":60}
DELTA   unauthorised_author 0 -> 0     approval_without_right 0 -> 0
        ridgeline_members  205 -> 207  ridgeline_approvers   58 -> 60

OUTSIDE, after the rollback  {"unauthorised_author":0,"approval_without_right":0,
                              "ridgeline_members":205,"ridgeline_approvers":58}
rows left behind: 0
```

**Read the deltas carefully.** `ridgeline_members 205 -> 207` and
`ridgeline_approvers 58 -> 60` are the **two fixture members Corgi staff
created** — the admin (whose role carries `approve_payment`) and the colleague
approver. The **Audit Ghost is not in them**: the removed admin's
`team_add_member()` call was refused, so no third member and no third approver
appears. Before 0044 the same script ran on the same book and both refusals
read `ALLOWED`, the second one returning *"a new active approver,
actor.can_approve = true"*. That before/after pair was measured by applying
0044's body inside a transaction and rolling it back, before the migration was
applied for real.

### The invariant

```
v_team_terms_by_unauthorised_author      0 -> 1
  a team_member_version whose author was, AT THE INSTANT THEY WROTE IT, a member
  of that business without being an ACTIVE holder of administer_team
  (scripts/dbcheck.mjs --prove, and team.integration.test.ts scenario 13)
```

**It is not `v_member_approval_without_right` widened, and that was considered
first.** That view reads `payment_instruction_event` and asks who approved a
*payment*. This defect lands in `team_member_version`, and — worse — the
approver it mints is `active`, correctly-roled and **perfectly legitimate at the
instant they approve**. The fraud is one level up, in who put them there. No
widening of a view over payment approvals can see a table it does not read.

Historically exact, the same way `v_member_approval_without_right` is: the
author's terms are the ones in force **when the row was written**, never their
terms today. An admin who wrote a version on Monday and was removed on Friday is
not a violation, and a guard that said otherwise would turn every removal into a
retroactive indictment of everything that person ever did, go permanently red,
and stop being read.

**Strictly before** (`v.created_at < tmv.created_at`), deliberately: `created_at`
defaults to `now()`, which is the **transaction** timestamp, so two versions
written in one transaction carry the same instant and `<=` would let a change
made later in a transaction indict a write made earlier in it — a false positive
on a legitimate write. The only state `<` gives up is an author who removes
themselves and writes somebody else's terms inside **one** transaction, and the
trigger refuses that outright because `v_team_member_current` inside that same
transaction already reads `removed`.

It is **wider than the defect**, on 0043's argument: it reports every version
written by a member of that business who was not an active `administer_team`
holder at the time — removed, suspended, or simply the wrong role. Narrowing it
to `state = 'removed'` would be an exclusion shaped like the failure, which is
the sentence this whole finding is about.

`scripts/dbcheck.mjs` reads **37 passed / 4 failed** (was 36/4; the four reds are
unchanged and none is this work's), and `--prove` covers **25 of 25** invariant
views.

### The test that would have caught it

`team.integration.test.ts` scenario **13 — the author of a member's terms, the
non-STAFF branch**. Seven cases, and every one of them passes a **real business
member** as the author, which nothing else in this repository does:

| case | author | expected |
| --- | --- | --- |
| active admin authors a colleague's terms | active `admin` member | **allowed** |
| active member without `administer_team` | active `initiator` member | refused, 0033's sentence verbatim |
| **removed admin authors terms** | `removed` `admin` member | **refused, naming `removed`** |
| **removed admin calls `team_add_member()`** | `removed` `admin` member | **refused; no actor, no membership, no approval right left behind** |
| suspended admin authors terms | `suspended` `admin` member | refused, naming `suspended` |
| Corgi staff authors terms | `business_id IS NULL`, member of nothing | **allowed** |
| the invariant can fail | — | `0 -> 1`, rolled back, `0` outside |

The removed-admin case also asserts that their `actor.can_approve` is **still
`true`** before the refusal — 0001 owns that column and it is append-only — which
is the same half-truth §5(2) makes about approvals, now made about authorship:
the actor row says what a principal *may* be; the membership says whether they
*are*, at each instant.

The invariant's proof goes through the **front door** on the application role
with every trigger armed, because the state it reports is one the trigger
structurally cannot see: the admin is active when they write the row, and the
removal lands afterwards carrying an earlier `created_at`. No trigger reads
`created_at`. That is the gate and the guard doing different jobs, which is why
both exist.

### Does anything else in the schema have this shape?

Every migration was swept for the same pattern — a lookup that excludes the
disqualified population and then treats the resulting NULL as permission. The
two in 0033 are the only instances. §11a records the method, the counts, and
what was checked and cleared.

### 11a. The sweep: does anything else have this shape?

**No. It appears exactly twice in the schema and both are the two 0044 repairs.**

All 40 files in `db/migrations/` (20,646 lines) were swept, both halves of the
pattern independently:

* the **filter** half — an authority or eligibility `SELECT … INTO` whose
  `WHERE` excludes the disqualified population (`state <> …`, `NOT IN`,
  `revoked_at IS NULL`, `AND NOT deleted`, and the rest);
* the **gate** half — `IF v IS NOT NULL AND NOT <ok> THEN RAISE`,
  `IF NOT FOUND THEN RETURN NEW`, `IF v IS NULL THEN … RETURN`.

135 `SELECT … INTO` sites exist across 26 files; 33 carry an exclusionary
predicate and every one was read in full. The filter-half grep returns 15 hits
schema-wide and only two sit inside an authority lookup: `0033:314` and
`0033:823`. There is no third instance.

**Why it is rare here:** the house style expresses absence as
`IS DISTINCT FROM` or as an explicit `IF NOT FOUND THEN RAISE`, and **both
refuse on NULL**. `assert_card_member()` at `0033:457-472` is the counter-example
sitting in the same migration as the bug — `IF v_state IS DISTINCT FROM 'active'
THEN RAISE … COALESCE(v_state, 'not a member')` — which refuses a NULL and even
prints the reason. The two defective sites were the only places in 20,646 lines
where an authority lookup pushed a disqualifying predicate *into* its `WHERE`
clause and then read the result with a plain `IS NOT NULL`.

Checked and cleared, with the reason in each case:

| function | why it is not this bug |
| --- | --- |
| `assert_maker_checker()` (0001) | the filtered lookup is a `count(DISTINCT …)`, which returns **0, never NULL**, and the gate is `IF v_approvals < required THEN RAISE` — so the exclusion makes the count *smaller* and pushes toward the **refusing** branch. The inverse of the defect |
| `assert_payment_lifecycle()` (0007) | same count-based shape, same inverse argument |
| `assert_team_maker_checker()` (0033) | no state filter at all; `FOUND` into a boolean, then `<> 'active'` raises. **This is the shape 0044 adopts** |
| `assert_team_initiator()` (0033) | no state filter; `IF NOT FOUND THEN RETURN NEW` is reachable only by an actor with no membership row |
| `assert_card_member()` (0033) | `IS DISTINCT FROM 'active'` — NULL refuses |
| `assert_team_member_spell()` (0033) | `IS DISTINCT FROM 'removed'` — NULL refuses |
| `assert_payee_acknowledgement…()` (0016) | the NULL case **raises** before any comparison |
| `assert_dispute_intake()` / lifecycle (0019, 0023) | two filtered lookups, both `COALESCE(SUM…,0)` / `count()`; both exclusions make the gate *stricter* |
| `open_business_accounts()` (0021) | every `NOT FOUND` branch raises — the most defensively written gate in the schema |
| `assert_standing_order_occurrence()` (0012) | the closest structural rhyme, and the `WHERE` excludes **nothing**: NULL means "never cancelled" |
| rate-card monotonicity (0024, 0031) | literally `IF v_latest IS NOT NULL AND …`, but `max()` over an **unfiltered** population — NULL means "no rate card exists yet" |
| `assert_card_auth_event_result()` (0026) | a near-miss worth naming: `IF NEW.result <> 'APPROVED' AND v_kind <> 'declined'` *would* fall permissive on a NULL `v_kind`, but the lookup excludes nothing, `card_auth_event.kind` is `NOT NULL` and `event_id` is FK-backed, so NULL is unreachable |
| `lock_*()` helpers (0008, 0012, 0020, 0024) | they **return** `v_id IS NOT NULL` as their answer; the caller decides. Not gates |
| audit (0035), mcp wiring (0037), webhook refusals (0038) | no `SELECT … INTO` at all; 0038 compares only `NEW.*` against `OLD.*` |
