# Operations we do not hand an autonomous agent

The MCP surface at `POST /api/mcp` has eleven tools. Ten read —
`get_balance`, `list_pots`, `list_transactions`, `list_payees`,
`list_standing_orders`, `list_card_controls`, `list_accruals`,
`list_disputes`, `list_recon_breaks`, `list_agent_limits`. The eleventh writes
a request into a queue a person has to work through. That is the whole surface,
and the interesting property is not what is on it — it is what is missing and
why.

The reads grew and the writes did not. Six features shipped after the first cut
of this surface — pots, the payee book, standing orders, card controls,
disputes, fee accrual — and each one brought an obvious write with it. Every one
of those writes is refused below, with the reason, because "the agent can
already see it" is not an argument for letting it act. **Reads went from three
to ten and writes went from one to one.** That asymmetry is the design and not
an accident of what happened to be ready.

**One of the ten readers is this document.** `list_agent_limits` serves the
list below through the protocol, generated from `src/lib/mcp/limits.ts` rather
than transcribed from here. It exists because a written policy the agent cannot
read is enforced only by refusals the agent cannot interpret: the honest answer
to a model that tries `approve_payment` used to be
`unknown tool "approve_payment"`, which is indistinguishable from a typo and
invites it to guess `approve_instruction` next, then to invent a workaround,
then to tell a customer our software is broken. The tool answers the guess with
the argument, the enforcing constraint, and where the operation actually lives.
`src/lib/mcp/limits.test.ts` fails the build if any tool this document claims is
absent ever appears in the registry, so the policy and the surface cannot drift
apart.

This document is the list of what is missing. It is not a policy we intend to
enforce in code later; every item below is already absent from the tool
registry, and `src/lib/mcp/tools.test.ts` fails the build if a tool named after
one of them appears. Where the database can also refuse the operation, the
constraint is named, because a rule that lives only in a tool list is a rule
that survives exactly until someone adds a tool.

Since the newer readers arrived there is a second mechanical guard, and it
exists because the guarantee genuinely weakened. `list_card_controls` reads
through `@/lib/cards/store`, which also exports `setCardControls`;
`list_payees` reads through `@/lib/payees/store`, which also exports
`acknowledgeWarning`. A named import brings in one binding and nothing else, so
nothing became reachable — but "we did not import the write" is a fact about a
diff, and a fact about a diff is not a control.
`src/lib/mcp/no-write-imports.test.ts` makes it one: it reads every import
statement in `src/lib/mcp/` and fails the build if any of forty named
write functions, or any of twelve write-only modules, appears in one. The
failure message names the section of this document that argues the refusal.

The disputes and accrual readers added a second SHAPE of that problem, which is
worth naming because the first guard would not have caught it. `list_disputes`
needs `listDisputeStates`, which lives in `@/lib/disputes/store` beside
`insertDispute` — the familiar case. But `@/lib/disputes/index.ts` re-exports
`./operations`, which imports `postEntry`; and `@/lib/accrual/index.ts`
re-exports `./accrue`, which does the same. Importing a *barrel* for a read
brings in one binding and makes nothing new callable, and it still puts the
journal-writing module into this process's graph — which would quietly falsify
the strongest sentence in this document. The gateway therefore reaches past
both barrels, and both barrels are now forbidden modules, so that is a rule
rather than a habit.

**The agent surface also stopped defining a balance.** It used to compute
available balance itself and the figure it produced was LARGER than the
customer's own screen, by exactly the operator holds plus the debits already
booked to leave — which made it the fifth definition in a system that had just
spent migration 0022 collapsing four that differed by $30,662.10. It escaped
`v_balance_definition_drift` because that view compares the definitions it knows
about and this one was never registered with it. It is now deleted rather than
registered: every money figure the surface returns comes from
`ledger_availability()`. This mattered here more than it would elsewhere,
because `initiate_payment` funds-checks against exactly that number — a
permissive balance means an agent proposing a payment the customer cannot
afford, and the entire safety argument for this surface is that an agent can
only ever propose.

**Read the last section of this file before the debrief.** It sorts every
refusal into "the database will not represent it", "the capability is not in
the process", and "we chose not to expose it" — because those are three
different strengths of guarantee and the panel is right to ask which one each
item is.

A note on framing before the list. "Autonomous" here means: acting on a bearer
token, with no person reading the call before it happens. It does not mean
"untrusted". Most of these refusals would stand even if the agent were provably
correct 100% of the time, because the reason is rarely that the agent might be
wrong. It is usually that the operation's whole purpose is to be the moment a
second party looks — and an operation whose purpose is to be a second look
cannot be performed by the first.

---

## 1. Releasing an approved payment

**Absent tool:** `release_payment` / `submit_payment`.

An approved instruction is not a paid one. Release is the step that calls the
rail, posts to the journal, and turns a request into money leaving the FBO
account. In this system it is `releasePayment()` in `src/lib/approvals`, reached
only from the approvals screen.

The failure mode is not that the agent releases the wrong payment. It is that
handing an agent the release step collapses approval into a formality. Approval
means something because there is a gap between "a human said yes" and "the money
went", and a person can change their mind inside that gap — the beneficiary
turns out to be wrong, the invoice turns out to be a duplicate, the supplier
calls. An agent that releases on approval closes the gap to milliseconds. Worse,
it moves the release decision to whenever the agent next runs, which is a time
nobody chose: a payment approved on Friday afternoon and released at 03:00 on
Saturday by a retry loop has been released at the one hour when nobody is
watching the rail and nothing can be recalled before Monday.

There is a second, sharper reason. Release is the only operation on this system
that is not reversible by writing another row. An ACH debit is recallable for
about two banking days and a wire is not recallable at all; a USDC transfer is
final at the second confirmation. Everything else in this design — a wrong
posting, a wrong hold, a wrong instruction — is corrected by appending. Release
is the one place where "we can fix it afterwards" stops being true, so it is the
one place that gets a human's attention by construction rather than by policy.

## 2. Approving anything

**Absent tool:** `approve_payment`.

This is the one the schema makes impossible rather than merely absent, and it is
worth being precise about which layer does what.

`actor` carries `CONSTRAINT actor_only_humans_approve CHECK (NOT (kind <> 'human' AND can_approve))`.
An agent that can approve is not a row Postgres will store. On top of that,
`assert_maker_checker()` refuses an `approved` event whose actor is not a human
with `can_approve`, refuses one whose actor is the instruction's own initiator,
and refuses one citing a `content_hash` other than the instruction's. So even
with a direct connection and no application code in the way, the agent cannot
approve. That is not an assertion; `src/lib/mcp/mcp.integration.test.ts` attempts
it against the live database on every run and asserts SQLSTATE 42501:

```
SQLSTATE 42501
actor 3743dc53-4e1c-577e-9a0f-e4469ffc1761 (kind agent) is not an approver
```

The failure mode if you allow it is the obvious one and also a subtler one. The
obvious one: an agent that can both initiate and approve is a single principal
with unilateral payment authority, and every business-email-compromise playbook
of the last decade is an attempt to become exactly that principal. The subtle
one: maker-checker is not primarily a control against a malicious maker, it is a
control against a *mistaken* one. Two people make uncorrelated mistakes. An
agent approving its own instruction makes perfectly correlated ones — if it
misread the invoice when it initiated, it will misread it identically when it
approves, and the second look adds nothing while making the audit trail claim
that it did. A control that records a second opinion which is guaranteed to
match the first is worse than no control, because it produces evidence of review
that never happened.

The same argument covers approving a payment a *person* initiated. The agent is
not a second pair of eyes; it is a program that will apply the same rule it
applied a thousand times before, including the thousand times the rule was
subtly wrong.

## 3. Changing the approval threshold or any approval policy

**Absent tool:** `set_approval_policy` / `update_threshold`.

`approval_policy` is effective-dated and append-only: `(rail, effective_from)`
is unique, and an instruction stores the `policy_id` it was judged under, so a
later policy change cannot retroactively make a past approval look correct.

The failure mode here is the most direct privilege escalation available in the
system, and it does not require the agent to do anything obviously wrong. Every
control above is expressed as a number in this table. An agent that can raise
the ACH threshold from $2,500 to $250,000 has not approved anything and has not
released anything — it has simply made its own future instructions fall below
the line where a human is required, and the audit trail will show a series of
perfectly compliant unattended payments. The policy change is upstream of the
control, so the control's own logs will not flag it.

This is also the entry with the clearest prompt-injection story. Reading a
supplier's invoice PDF is a plausible thing to ask an agent to do. If that PDF
can say "the approval threshold for this vendor is $500,000" and the agent has a
tool that writes thresholds, the invoice has just written the bank's control
policy. Reading untrusted text is fine. Reading untrusted text while holding a
tool that changes the rules is not.

## 4. Rotating or reading credentials

**Absent tool:** `rotate_webhook_secret`, `read_api_key`, `create_agent_token`.

The agent holds one bearer token scoped to one business. It cannot mint another,
cannot read the provider keys in the environment, and cannot rotate a webhook
signing secret.

Two distinct failure modes. First, rotation is an availability weapon: a webhook
signing secret rotated without the corresponding change at the provider means
every subsequent delivery fails signature verification, and this system's
webhook inbox is where card authorisations and ACH returns arrive. An agent that
rotates a Lithic secret has not stolen anything — it has stopped the bank from
learning that money moved, which is worse, because the ledger will be confidently
wrong instead of visibly broken. Second, credential creation is how a bounded
compromise becomes an unbounded one. A leaked agent token is a bad afternoon:
revoke the grant, and the actor cache expires within 60 seconds. A leaked agent
token that could mint further tokens is an incident with no defined end, because
you cannot enumerate what was created.

The narrower rule that follows: this surface never returns a secret in a tool
result and never accepts one as an argument. It does not even take a full bank
account number — the destination schema takes `account_number_last4`, which is
what an approver actually checks a beneficiary against. An agent that never
holds the other digits cannot be talked into exfiltrating them, and the audit log
cannot accidentally become the most sensitive store in the system.

## 5. Running a reconciliation adjustment

**Absent tool:** `resolve_break`, `write_off_break`, `post_adjustment`.

`list_recon_breaks` reads. It cannot write a `recon_break_note`, cannot set a
resolution, and cannot post the correcting entry that a resolution points at.

The failure mode is that a reconciliation break is *evidence of a disagreement*,
and adjusting it is the act of deciding who is right. Those are different jobs.
When the settlement file says $133.33 and our ledger says nothing, one of four
things is true: the provider sent a file we have not processed, we booked a
settlement that never happened, the webhook is lost, or the file is wrong. Only
the last two are safe to "fix" in our books, and telling them apart requires
looking outside this system — at the provider's dashboard, at a phone call.

An agent optimising for a clean breaks screen will pick the adjustment that
makes the number go away, and the number going away is exactly the outcome that
destroys the signal. This is the mechanism behind most large reconciliation
failures: not a single wrong adjustment, but a long run of small ones that each
looked locally reasonable and collectively converted "our books disagree with the
network" into "our books agree with themselves". By the time anyone notices, the
evidence of the original disagreement has been adjusted away, and there is no
longer a way to reconstruct what happened.

The severity ladder in `src/lib/recon/aging.ts` exists for the same reason:
`aged` means somebody signed off a book day with this break still open. That is
a fact about a human decision, and an agent that can resolve breaks can erase it.

## 6. Closing a book day

**Absent tool:** `close_book_day`.

Closing a day freezes it: statements are rendered against it, `book_day` records
the booking watermark it was closed at, and the reconciliation engine starts
counting closes survived as the severity signal.

The failure mode is that a close is an assertion — "as of this watermark, we
believe these books" — and an assertion nobody made is not an assertion. Everything
downstream treats a closed day as reviewed. A statement issued for a closed day
goes to a customer. A break that survived a close is escalated *because* someone
looked and signed anyway. If an agent closes days on a schedule, every one of
those downstream meanings quietly becomes false while every screen continues to
display them, and the escalation ladder in particular inverts: breaks age faster
into `stale` and `critical` because the closes kept happening, so the signal that
was supposed to mean "a human has now seen this twice" comes to mean "a cron ran
twice."

There is also a hard operational edge. A close taken at the wrong moment — mid
settlement window, before a known-late provider file — bakes a wrong position
into an issued statement, and this system deliberately cannot edit a statement.
The correction path is a reversal, a rebook and a corrected statement, which is
correct and is also a customer-facing event. That is a decision with a cost
attached, and costs are for people to accept.

## 7. Issuing, freezing or unfreezing a card

**Absent tools:** `issue_card`, `freeze_card`, `unfreeze_card`.

Issuing creates a live payment credential. Unfreezing restores one. Both are
plausible-sounding support actions and both are refused.

The failure modes differ in a way worth separating. *Issuing* is refused because
a card is a bearer instrument with a shipping address, and the whole attack is
social: a convincing story ("our new ops hire starts Monday") produces a real
card at an address the agent was told. The agent cannot verify the story, and the
cost of being wrong is a funded credential in someone else's hands. *Unfreezing*
is refused for a stronger reason: a freeze is almost always the visible end of an
invisible process — a fraud alert, a KYB review, a legal hold, a customer's own
"I lost my wallet". The freeze is one row; the reason often is not in this
system at all. An agent that can unfreeze can undo a decision whose justification
it cannot see, and it will do so precisely when the pressure is highest, because
an unhappy customer is exactly who will ask.

Freezing is the interesting case and I do not think it is obvious. See the
debatable section below.

## 8. Writing to the journal directly

**Absent tools:** `post_entry`, `post_journal_entry`, `reverse_entry`,
`create_hold`, `release_hold`.

Every money write in this system goes through `ledger_append()`, and only
`src/lib/ledger/post.ts` calls it. The MCP surface does not import that module
at all. `corgi_app` holds `SELECT` and `INSERT` on the money tables and no
`UPDATE` or `DELETE`, so even a compromised process cannot edit a posted entry —
it could only append.

That last sentence is why this entry matters even though the damage is bounded.
Append-only means a wrong entry cannot be hidden, but it does not mean a wrong
entry is harmless: it is in the trial balance, it is in the customer's available
balance, it is on the statement for its value date, and removing it requires a
reversal that is itself permanently visible. The guarantee the ledger offers is
"every number is derivable from events, and every event has an actor and a
reason". A tool that lets an agent post an arbitrary balanced entry keeps the
first half and destroys the second, because the reason becomes "the model
decided to", which is not a reason anyone can audit six months later.

The general form of this rule is the one that generalises to tools nobody has
thought of yet: **an agent may write a reviewed instruction, never a fact.** A
`payment_instruction` is a request, and a request being wrong is survivable
because the next step is a person. A journal line is a claim about what
happened, and a wrong claim about what happened is the failure this entire
schema — the hash chain, the two clocks, the revoked UPDATE privilege — exists
to prevent.

---

# The refusals that came with the newer features

Sections 1-8 were written when this surface had three readers. Everything below
arrived with pots, payees, standing orders, card controls and the second
stablecoin provider — features the agent can now SEE, which is exactly when the
argument for letting it act gets made.

## 9. Signing or broadcasting a stablecoin transfer

**Absent tools:** `send_usdc`, `sign_transfer`, `broadcast_payout`,
`provision_wallet`.

There are now two USDC providers behind one interface: `direct`, which builds an
EIP-1559 transaction and signs it here with a secp256k1 key, and `circle`, which
asks Circle's Web3 Services to sign inside their custody. Neither is reachable
from this surface, and the reason is the same for both even though the mechanics
differ completely.

**What stops it structurally.** Three things, in decreasing order of strength.

1. *The capability is not in the process.* `src/lib/mcp/` imports nothing from
   `@/lib/rails/stablecoin`. `no-write-imports.test.ts` names `sendUsdcPayout`,
   `signTransaction`, `encodeSignedTransaction` and `settleTransaction` as
   forbidden imports and the modules `stablecoin/tx` and `stablecoin/secp256k1`
   as forbidden entirely, so the build fails if anyone adds one.
2. *The credentials are not held.* The direct path reads
   `USDC_SENDER_PRIVATE_KEY` at call time and holds it only for the life of the
   provider object; the Circle path needs `CIRCLE_API_KEY` and
   `CIRCLE_ENTITY_SECRET`. This surface never returns a secret and never accepts
   one, and an MCP token is not a credential for any of those three.
3. *The ledger side is separate anyway.* `settleTransaction()` is the single
   place in the codebase that decides "the chain accepted this transfer", and
   the booking that follows goes through `ledger/post.ts`, which this surface
   cannot reach at all — §8.

**What would have to change.** Somebody would have to import the adapter into
the MCP module (and delete the guard test that stops them), and the deployment
would have to put the signing key or the entity secret in reach of the request
path that a bearer token can drive.

**Why it is refused even though `initiate_payment` accepts the `usdc` rail.**
This is the sharpest version of the whole document's rule. An agent CAN queue a
USDC payout: it writes a `payment_instruction` naming a chain and an address,
which a person then reads and approves and releases. What it cannot do is
produce the signature. The distinction is not bureaucratic. A signed and
broadcast USDC transfer is final at the second confirmation — there is no
recall, no return code, no chargeback, no correcting entry that can bring the
money back. Everything else in this system is repaired by appending a row. A
broadcast is the one act with no inverse, so it is the one act that gets a
human's hand on it by construction.

## 10. Creating or amending a standing-order mandate

**Absent tools:** `create_standing_order`, `amend_standing_order`,
`cancel_standing_order`.

This was the strongest candidate for a second write tool, and the argument for
it is real: a mandate is not a payment, it moves no money on the day it is
written, and every occurrence it produces does land in the approval queue. On
that reading it looks exactly like `initiate_payment` — a request a person
judges later.

It is refused, for three reasons that only became visible when we tried to write
the tool.

**First: the mandate itself never enters the queue.** `createStandingOrder()`
inserts a `standing_order` row. That row is not a `payment_instruction`, no
`approval_policy` applies to it, and no approver ever sees "an agent proposed a
recurring payment". What a person eventually sees is occurrence #1, thirty days
later, looking like an ordinary scheduled debit. The context — that this
recurring authority was created by an agent on a Tuesday from an email — is gone
by the time anyone is asked. A write tool that lands in the queue *eventually*,
in a form that hides what it is, is worse than one that does not land there at
all, because it produces the appearance of review.

**Second: it escapes the token's own ceiling.** A grant may carry
`maxInstructionCents`, and `initiate_payment` enforces it on every call. A
mandate's occurrences are not raised by `initiate_payment` — they are raised by
the cron, under the mandate's `created_by` actor, through
`runStandingOrders()`. So an agent capped at $50,000 per instruction could
create a daily $49,000 mandate and never meet its ceiling again. The ceiling is
a control on a single act; a mandate is a factory for acts. **An agent may write
a request. It may not write a thing that writes requests.**

**Third: amendment is worse than creation.** An existing mandate carries a
customer's consent to a specific amount on a specific day. Changing the amount
reuses that consent for something it was not given for, and does so in a row
whose history a customer is unlikely to read.

**What stops it structurally.** The capability is absent from the process:
`createStandingOrder` and `cancelStandingOrder` are forbidden imports, and
`@/lib/standing/fire` is a forbidden module. The database does not itself refuse
an agent as `standing_order.created_by` — it is `REFERENCES actor(id)` with no
kind restriction — so this one is **capability-absent, not unrepresentable**.
The honest fix, if it ever mattered, is the pattern migration 0013 already
established: add a `created_by_kind` column, a composite FK to
`actor(id, kind)`, and a CHECK pinning it to `'human'`.

## 11. Overriding a payee name-match warning

**Absent tools:** `acknowledge_payee_warning`, `override_name_match`,
`confirm_payee`.

A `warn` finding on a payee — a close-but-not-identical holder name, a bank the
directory does not list, a twin on the book with different details — is cleared
by exactly one thing: a row in `payee_acknowledgement` naming an actor, an
instant, and a reason somebody typed.

**The signature is the whole control.** The warning is not information; the
product ships the information anyway, on the screen. What the warning does is
force a named person to put their name to "I know, and I am proceeding". An
agent that can write that row has not satisfied the control, it has emptied it:
the row still exists, the audit trail still says the warning was acknowledged,
and nobody looked. That is strictly worse than no control, for the same reason
§2 gives about an agent approving its own payment — it manufactures evidence of
a judgement that was never made.

There is a second reason specific to this check. The most valuable warning the
payee book produces is `TWIN_WITH_DIFFERENT_DETAILS`: the same counterparty name
already on the book with a different account. That is what a changed-bank-details
fraud looks like, and it is also what an innocent duplicate looks like, and
telling them apart requires something no agent can do — ringing the supplier on
a number you already had. An agent asked to clear that warning will clear it
from the same document that caused it.

**What stops it structurally.** The capability is absent:
`acknowledgeWarning` and `recordVerification` are forbidden imports. The
database enforces the shape of an acknowledgement — `reason` is NOT NULL and
non-blank, one per person per check — but `acknowledged_by` is
`REFERENCES actor(id)` and would accept an agent. So: **capability-absent, not
unrepresentable.** Making it unrepresentable is the 0013 pattern again, on
`payee_acknowledgement`, and of everything in this document it is the change I
would make first.

**What the agent CAN do, and why that is enough.** `list_payees` returns the
findings, the outcome, the freshness, the name source and the twin flag. An
agent can put "this payee's routing number does not match the one on the book,
last verified 101 days ago" into the `reason` field of an instruction, where the
approver reads it. Surfacing the problem to the person who signs is the useful
half. Signing it is the half that is not ours.

## 12. Adding, re-checking or archiving a payee

**Absent tools:** `add_payee`, `propose_payee`, `recheck_payee`,
`archive_payee`.

The other candidate for a second write tool, and it fails on a distinction worth
stating carefully: **the payee book is a control input, not a queue.**

`gatePaymentOnPayee()` runs inside `requestPayment()`'s transaction and decides
whether a destination may be paid at all. It reads the book. So writing to the
book is not asking a person for something — it is changing the thing that will
decide, later, without anyone being asked again. That is the "may not change the
rules that decide what is final" half of this document's rule, in a place where
it is easy to miss because a payee looks like data rather than policy.

Concretely: an agent that can add a payee can add one with a valid checksum and
a plausible name, and every future payment to it passes the gate silently. No
approval queue is involved, because the gate's whole purpose is to run before
the queue.

"But it would be a *proposal*, not a payee" is the obvious repair, and it needs
a table that does not exist: a `payee_candidate` queue with its own screen and
its own reviewer. That is a real feature with a real design, and half of it —
a proposal table with no screen — would be worse than nothing, because the
proposals would sit unread while the agent told customers they had been
submitted.

**What stops it structurally.** Capability-absent: `savePayee`, `archivePayee`,
`recordVerification` and `confirmPayee` are forbidden imports. Nothing in the
schema forbids an agent as `payee.created_by`. A re-check is refused for one
more reason on top: `confirmPayee()` calls the routing directory and the
identity provider, so an agent that could drive it could drive our provider
quota from a loop, and this surface's `openWorldHint: false` — which clients
use to decide whether to run a tool unattended — would become a lie.

## 13. Changing card controls

**Absent tools:** `set_card_controls`, `set_card_limit`, `block_mcc`,
`unblock_mcc`, and (from §7) `freeze_card` / `unfreeze_card`.

§7 refused issuing, freezing and unfreezing when cards first shipped. Controls
are the same family and they deserve their own entry, because the failure mode
is one step less obvious and one step worse.

**A control change is a real-time authorisation decision made in advance.** The
values in `card_control_version` are not configuration that a human later acts
on. They ARE the answer the card network receives, inside Lithic's ASA timeout,
measured in this system at 40-150ms, with no person anywhere on the path. So an
agent that can unblock MCC 5542 has not requested a payment and has not
approved one; it has arranged for the next fuel-pump authorisation to be
approved, and there is no queue anywhere that will ever show that as a payment
decision. The money moves, the ledger records an ordinary card settlement, and
the only trace of the decision is a control version row nobody had a reason to
read.

Raising a limit is the same act in a quieter register. `daily_limit_cents` is
the number `decide()` compares spend against; an agent that can set it to null
has removed the control while leaving the screen that displays controls looking
completely normal.

There is also a direction-of-error argument that cuts the other way and I want
to name it rather than pretend it does not exist. *Tightening* a control is
safe-direction: blocking a category or lowering a limit stops money. An agent
that detects an obvious compromise pattern at 03:00 and tightens is doing
something defensible, and §7's debatable section already concedes the same point
about freezing. I have kept it off anyway, for the reason §7 gives: a false
positive on the one card a small business runs on is a payroll card declining at
a pump, and a half-built version — tighten-only, with no notification, no SLA
and no unwind path — is worse than none.

**What stops it structurally.** Capability-absent, and now guarded:
`setCardControls` is a forbidden import in `no-write-imports.test.ts`, and
`tools.test.ts` refuses any tool whose name contains `freeze`, `unfreeze`,
`set_control`, `set_limit`, `block_mcc` or `unblock`. The database enforces that
control versions are append-only and contiguous — `card_control_version_key` on
`(card_id, version)` plus `assert_card_control_version()`, which refuses a gap
or a backwards `effective_from` — so a change could never be hidden. But
`created_by` is `REFERENCES actor(id)`: an agent-attributed control version is
representable. **Capability-absent, not unrepresentable**, and the 0013 pattern
is the fix.

**What the agent CAN do.** `list_card_controls` returns the controls, the
decisions, the rule that fired and the reason. "Your card declined because
category 5542 is blocked on it, under control version 3 set on the 8th; someone
with access to the card console can change that" is a complete and useful
answer. It ends with a person, which is the point.

## 14. Firing a standing-order occurrence out of band

**Absent tools:** `run_standing_orders`, `fire_occurrence`, `retry_occurrence`.

Distinct from §10 — this is not creating authority, it is exercising authority
that already exists, which sounds much safer and is not.

Exactly-once across restarts and retries is the published requirement, and it is
held by three things working together: `standing_order_occurrence` is UNIQUE on
`(standing_order_id, scheduled_date)`; its `idempotency_key` is GENERATED by
Postgres as `standing:<order>:<date>`; and `payment_instruction.idempotency_key`
is itself UNIQUE, so a second attempt at the same date returns the ORIGINAL
instruction instead of raising a second one.

Notice what that guarantee is actually about: it makes the same DATE safe to
attempt twice. It says nothing about attempting a date that was not due. A tool
that fires "the next occurrence now" is a second way to choose a date, and the
constraint that protects the first way cannot see it. An agent nudging a rent
payment forward by two days because a customer asked produces a real debit on a
day the mandate never authorised — and it will be perfectly idempotent, so
running it twice will not even leave a second row to notice.

**What stops it structurally.** `runStandingOrders()` is the only function that
fires anything; `@/lib/standing/fire` is a forbidden module in the import guard,
and `standing/index.ts` deliberately exports no helper that raises a payment on
its own. The application reaches it from exactly one place, the cron route. The
UNIQUE constraint and the generated key mean that even a compromised caller
cannot double-fire a date — the damage is bounded to firing a date early, which
is why this entry is about dates rather than about duplicates.

## 15. Moving money into or out of a pot

**Absent tools:** `move_to_pot`, `fund_pot`, `empty_pot`, `open_pot`,
`close_pot`.

A pot transfer moves nothing outside the bank: both legs are inside one
customer's own deposit subtree, and `v_internal_transfer_impure` is an invariant
view that stays empty precisely to prove it. It is the most harmless-looking
write in the product.

It is a journal posting, so §8 refuses it — an agent may write a reviewed
instruction, never a fact — and `movePotFunds` and `openPot` are forbidden
imports. But the specific reason is better than the general one.

**Available balance is a control input.** Every funding decision in this system
compares against available: `decideFunding()` for standing orders,
`decideMove()` for pots themselves, the approval path for payments. Money in a
pot is not in the main account's available balance. So an agent that can move
money out of the payroll pot can make a funding check pass that would otherwise
have failed — not by approving anything, just by relocating the money the check
looks at. The rent goes out, the payroll does not, and every row involved is a
perfectly ordinary internal transfer.

The mirror case is as bad and quieter: an agent that moves money INTO a pot to
"tidy up" has silently reduced the available balance that tomorrow's standing
order is judged against, and the refusal that follows will name the shortfall
without naming the cause.

## 16. Approving a KYB manual review

**Absent tool:** `approve_kyb`, `decide_kyb_review`.

This is the one the schema makes **unrepresentable**, and it is the best example
in the codebase of why that is a different kind of answer.

A business whose automated KYB legs come back `needs_review` can be approved by
a named operator, in writing. That decision is a row in `kyb_verification_leg`
with `evidence = 'manual'`. Migration 0013 constrains it as follows:

```sql
ALTER TABLE actor ADD CONSTRAINT actor_id_kind_uniq UNIQUE (id, kind);

ALTER TABLE kyb_verification_leg
  ADD COLUMN decided_by_actor_id uuid,
  ADD COLUMN decided_by_kind     actor_kind,
  ADD CONSTRAINT kyb_leg_reviewer_fk
    FOREIGN KEY (decided_by_actor_id, decided_by_kind) REFERENCES actor (id, kind),
  ADD CONSTRAINT kyb_leg_reviewer_is_human CHECK (
    decided_by_kind IS NULL OR decided_by_kind = 'human'),
  ADD CONSTRAINT kyb_leg_manual_has_reviewer CHECK (
    (evidence::text = 'manual') = (decided_by_actor_id IS NOT NULL)),
  ADD CONSTRAINT kyb_leg_manual_has_reason CHECK (
    evidence::text <> 'manual' OR length(btrim(decision_reason)) >= 20);
```

Read the first two together. The row carries the reviewer's `kind` alongside
their id, and the composite foreign key forces that `kind` to be the one the
`actor` table actually holds for that id — you cannot claim an agent is a human
by writing `'human'` in the column, because the FK would find no matching
`(id, kind)` pair. The CHECK then pins it to `'human'`. The combination means a
KYB decision attributed to an agent is not a row Postgres will store, at all,
from any connection, with or without our application code in the path.

### Why that is better than a check in application code

A check in application code is a statement about one code path. The composite FK
is a statement about the data. Five concrete differences:

1. **It covers paths that do not exist yet.** An application check protects the
   function it is written in. The FK protects the admin console, the migration
   script somebody runs at 2am, the backfill, the psql session, the feature
   written next year by someone who never read this file. Every one of those is
   a way the check gets skipped and the FK does not.
2. **It cannot be skipped under pressure.** Application checks are removed in
   incidents — that is when the pressure to "just approve it so the customer can
   trade" is highest and the review of the change is weakest. Removing this one
   requires a migration, which is a reviewed artefact with a name and a date.
3. **It makes the bad state unrepresentable rather than unreachable.** There is
   no moment, even inside a transaction that later rolls back, at which the
   database holds a KYB approval by an agent. Anything reading the table —
   including a replica, a dump, or an auditor's query — sees a set that cannot
   contain the thing.
4. **It fails loudly and specifically.** The refusal is an SQLSTATE at the
   statement, not a branch that might be logged and swallowed. `dbcheck.mjs`
   attempts forbidden writes on every run and asserts the refusals, so the
   guarantee is demonstrated rather than asserted — the same way
   `mcp.integration.test.ts` attempts an agent approval and asserts SQLSTATE
   42501.
5. **It survives being wrong about the application.** The strongest argument for
   database-level rules is that they hold even when our belief about how the
   code works turns out to be false. Two bugs in `availableBalance()` — recorded
   at the top of `src/lib/mcp/gateway.ts` — are what that looks like in this
   repo: careful code, confidently wrong, for weeks. A constraint does not
   depend on our being right.

**What would have to change for an agent to do it.** A migration dropping
`kyb_leg_reviewer_is_human` and `kyb_leg_reviewer_fk`, plus a tool, plus
whatever the deployment does to let the MCP process reach the KYB module — which
it does not import at all today, and `manualReviewLeg` is a forbidden import.
Three deliberate acts, each visible in review. That is the difference between
"we chose not to" and "it cannot": both are answers, but only one of them
survives the person who chose being replaced.

---

# The refusals that came with disputes and accrual

Sections 9-16 arrived with pots, payees, standing orders, card controls and
KYB. These four arrived with the disputes and fee-accrual readers, and §17 is
the closest call anywhere in this document — it is the one candidate write that
passes the `initiate_payment` test and is refused anyway.

## 17. Raising, withdrawing or progressing a dispute

**Absent tools:** `raise_dispute`, `open_dispute`, `withdraw_dispute`,
`submit_evidence`, `record_decision`.

**The argument FOR this tool is the strongest in the document and I want it
written down first.** Raising a dispute moves no money: the case opens at status
`raised`, nothing is posted, and the only thing that exists is a claim. The
money movement — provisional credit — needs a Corgi human approver who is not
the raiser and who belongs to no customer business, enforced by
`assert_dispute_lifecycle()` at SQLSTATE 42501. So on this document's own test —
*if this call were wrong, would a person get to see it before the consequence?*
— a `raise_dispute` tool **passes**, and it passes more convincingly than
`initiate_payment` does, because a dispute needs two human steps before a cent
moves and a payment needs one.

It is refused on a different test, and the difference is worth the paragraph.

**A payment instruction is a REQUEST. A dispute is an ASSERTION OF FACT.** An
unapproved payment instruction simply expires; nothing happened, and the only
cost was an approver's attention. A dispute is durable from the moment it is
written, and it is durable in three ways at once. It starts the network's
outside-date clock — `network_outside_date`, after which there is no case left
to make, so a wrong case consumes a real deadline. It creates an obligation
somebody has to work, on a queue that is not the payments queue. And because
`dispute_event` is append-only, **a withdrawal is another event and not an
erasure**: a claim of fraud that a model composed out of a customer's ambiguous
sentence is permanent history attributed to that business, filed against a named
merchant, in a record we would hand to a regulator. "The agent said the charge
was fraudulent" is not a sentence that gets better with a withdrawal event after
it.

There is a second reason and it is structural rather than a judgement.
`raiseDispute()` lives in `@/lib/disputes/operations`, and that module imports
`postEntry` — it has to, because the grant, the clawback and the write-off are
postings. Importing it would put `ledger/post.ts` into this process's module
graph. Nothing would become callable, and the strongest sentence in this
document would nonetheless stop being true. Splitting intake out of that module
is a real and reasonable change; it is a change in a module this surface does
not own, and "we restructured someone else's feature so we could have a tool" is
not a thing to do at hour forty of a build.

**What stops it structurally.** `@/lib/disputes/operations` is a forbidden
module. `raiseDispute`, `submitEvidence` and `recordDecision` are forbidden
imports — and so are `insertDispute` and `insertDisputeEvent`, which live in the
read-only store the gateway *does* import, so the write cannot be hand-rolled
out of the pieces. `assert_dispute_intake()` independently enforces the four
intake rules under an advisory lock: only a settled card-rail entry in the
financial book can be disputed, the claim cannot exceed what is unclaimed, and
the two accounts must be the `2100` and `9200` leaves of the SAME business.

**What the agent CAN do.** `list_disputes` returns every case, its status folded
from its own event stream, what has been advanced, what is still held, what the
case is waiting on and how many days are left before the network's deadline.
"Your claim is with the network, $73.40 was advanced to you on the 8th and is
held until the verdict, and the case has 48 days left" is a complete answer, and
it ends with a person.

**If this moved onto the surface**, the honest version is a `dispute_intake`
proposal queue with its own screen — the same shape the payee book needs in
§12 — where an operator converts a proposal into a case. That is a feature, not
a tool. The tool without the queue is the part that looks like progress.

## 18. Authorising, granting or recovering provisional credit

**Absent tools:** `authorize_provisional_credit`, `grant_provisional_credit`,
`decline_provisional_credit`, `claw_back_credit`, `write_off_credit`,
`finalize_credit`.

§2 wearing different clothes, with one clause that does not arise for payments
and that is worth reading:

> **The counterparty to the advance cannot authorise it.** Provisional credit is
> the bank advancing its OWN money to this customer, so an approver belonging to
> the disputing business would be approving a payment to themselves. The
> authoriser must be a Corgi human approver — `business_id IS NULL` — who is not
> the raiser.

`assert_dispute_lifecycle()` enforces all of that: `kind = 'human'`,
`can_approve`, `business_id IS NULL`, and `actor_id <> raised_by`, each with its
own SQLSTATE 42501 message. `actor_only_humans_approve` on `actor` excludes
every agent a second time, from a different direction. And
`dispute_event_one_authorization_per_actor` is a UNIQUE INDEX that stops one
approver writing two rows to satisfy a two-approver policy — the failure mode
`count(*)` would have missed and `count(DISTINCT actor_id)` catches.

**Guarantee: unrepresentable.** An agent-authorised provisional credit is not a
row Postgres will store, from any connection, with or without our code in the
path. The clawback and the write-off are the other end of the same decision —
one takes the money back off the customer, the other absorbs it onto `5200` —
and both are postings, so §8 refuses them as well.

**What the agent CAN do.** `list_disputes` reports `needs_authorization`, how
many authorisations are held, how many the policy requires, and the threshold.
That is enough to tell a customer exactly what their case is waiting on without
being able to be the thing it is waiting on.

## 19. Enrolling, re-pricing or ending an accrual schedule

**Absent tools:** `create_accrual_schedule`, `set_plan_price`,
`end_accrual_schedule`.

A schedule is a price and a date range. Writing one queues nothing: the daily
entries that follow are posted by a cron with no human anywhere on the path, so
a wrong `monthly_cents` is a wrong journal entry every day until somebody
notices — and every one of those entries is individually *correct* against the
schedule that was wrong, which is why nothing alarms. `accrual_posting_arithmetic`
re-derives the allocation on every insert and would happily certify the
arithmetic of the wrong price.

This is §10's rule in its purest form — *an agent may write a request; it may
not write a thing that writes requests* — and it is a step worse than §10,
because a standing-order mandate produces INSTRUCTIONS that a person still
approves, while an accrual schedule produces POSTINGS that nobody does.

Pricing is also simply a commercial decision. "What does this customer pay us"
is not a question with a correct answer an agent could compute; it is a question
someone negotiated.

**What stops it structurally.** `@/lib/accrual/accrue` is a forbidden module and
`@/lib/accrual` re-exports it, so neither is imported; the gateway reads accrual
through scoped SQL and `@/lib/accrual/types`, which is pure arithmetic with no
database handle at all.

**What the agent CAN do.** `list_accruals` returns the schedule, the price,
every day's arithmetic and the month roll-up. A customer asking "why is this
84¢ and yesterday 83¢" gets `$25.00 ÷ 30 = 83¢ with 10¢ left over; day 10 is one
of the first 10, so it carries one` — which is the answer, not a deflection.

## 20. Running the accrual tick or skipping a day

**Absent tools:** `run_accrual`, `accrue_now`, `skip_accrual_day`,
`backfill_accrual`.

The tick posts to the journal, so §8 refuses it outright and there is nothing
interesting to say about that half.

**The skip is the interesting half.** A skipped day is a recorded decision that
a fee did NOT accrue, with a reason, and it is the only place in this feature
where money is knowingly not charged. An agent holding that tool could zero a
customer's bill one defensible-looking day at a time, and every individual row
would carry a plausible sentence — "customer was in dispute", "service was
degraded" — that a person reading one row would accept. The month roll-up would
show the shortfall, and that is exactly the point: the control is that a person
has to answer for the gap, and an agent that can write the skip is an agent that
can produce the gap without anybody being asked.

Note the asymmetry with §14, which refuses firing a standing-order occurrence
early. There, the damage is a real debit on a day nobody authorised. Here the
damage is the absence of a debit, which alarms nothing and looks like nothing.
Refusing both is the same rule applied to money moving and money not moving, and
the second is the one that is easy to forget.

**What the agent CAN do.** `list_accruals` returns `gap_days` — days a schedule
owes that nothing has claimed. Persistently non-zero means the tick is not
running and the customer is silently not being billed, which is the single
failure a quiet accrual job otherwise hides. An agent that can SEE the gap and
cannot CREATE one is exactly the right side of this line.

---

# Which of these cannot happen, and which we merely refuse

The panel will ask, and the honest answer is not the same for every row.

| Refusal | Strongest guarantee | Where it lives |
| --- | --- | --- |
| Approving a payment (§2) | **Unrepresentable** | `actor_only_humans_approve` CHECK + `assert_maker_checker()`; proved live, SQLSTATE 42501 |
| Approving a KYB review (§16) | **Unrepresentable** | composite FK to `actor(id, kind)` + `kyb_leg_reviewer_is_human` |
| Editing or deleting a money row (§8) | **Unrepresentable** | `corgi_app` holds no UPDATE or DELETE on the money tables; `dbcheck.mjs` attempts it every run |
| Double-firing an occurrence (§14) | **Unrepresentable** | UNIQUE `(standing_order_id, scheduled_date)` + generated idempotency key + UNIQUE on `payment_instruction.idempotency_key` |
| Retroactively changing a past approval (§3) | **Unrepresentable** | `approval_policy` append-only, unique `(rail, effective_from)`; instructions store `policy_id` |
| Releasing a payment (§1) | Capability-absent | not imported; `releasePayment` forbidden in `no-write-imports.test.ts` |
| Signing or broadcasting USDC (§9) | Capability-absent + no credentials | forbidden imports and modules; the signing key and entity secret are not in reach of this path |
| Posting to the journal (§8) | Capability-absent | `@/lib/ledger/post` is a forbidden module |
| Changing card controls (§13) | Capability-absent | `setCardControls` forbidden import |
| Acknowledging a payee warning (§11) | Capability-absent | `acknowledgeWarning` forbidden import |
| Writing the payee book (§12) | Capability-absent | `savePayee`, `archivePayee`, `confirmPayee` forbidden imports |
| Creating or amending a mandate (§10) | Capability-absent | `createStandingOrder`, `cancelStandingOrder` forbidden imports |
| Firing an occurrence out of band (§14) | Capability-absent | `@/lib/standing/fire` forbidden module; one caller in the app, the cron route |
| Moving money between pots (§15) | Capability-absent | `@/lib/pots/transfer` forbidden module |
| Raising or progressing a dispute (§17) | Capability-absent | `@/lib/disputes/operations` forbidden module; `raiseDispute`, `insertDispute`, `insertDisputeEvent`, `submitEvidence`, `recordDecision` forbidden imports |
| Enrolling or re-pricing an accrual schedule (§19) | Capability-absent | `@/lib/accrual/accrue` and the `@/lib/accrual` barrel are forbidden modules |
| Running the accrual tick or skipping a day (§20) | Capability-absent | `runAccrual`, `claimDay`, `recordPosting` forbidden imports; the tick is a posting, so §8 applies |
| Issuing, freezing, unfreezing a card (§7) | Capability-absent | no import, no tool, name-banned in `tools.test.ts` |
| Resolving a recon break (§5) | Capability-absent | the gateway's recon methods read; no write path exists |
| Closing a book day (§6) | Capability-absent | not imported |
| Rotating or minting credentials (§4) | Capability-absent | not imported; no tool returns or accepts a secret |

Nothing on this surface rests on the tool list alone. That matters, because the
tool list is the layer a future contributor changes by accident, and it is the
only one of the three that a single well-meaning pull request can move.

The five rows at the top are the ones I would defend without knowing anything
about our code. The rest are real but conditional: they hold as long as nobody
deletes a test and writes an import. **The gap between those two groups is the
honest measure of this design, and closing more of it is a schema change, not a
policy.** The specific next step is named three times above: `payee_acknowledgement`,
`card_control_version` and `standing_order` all carry a plain
`REFERENCES actor(id)`, and migration 0013 already demonstrates the four lines
that would make an agent-attributed row impossible in each.

---

## The principle underneath all twenty

Every refusal above is an instance of one rule:

> **An agent may state an intention. It may not make a fact final, and it may
> not change the rules that decide what is final.**

The ten read tools observe facts. `initiate_payment` states an intention, in a
row whose only consequence is that a person sees it. Everything on the list
above is either the act of making something final (release, close, approve,
adjust, post, sign, fire) or the act of moving the boundary of what needs a
human (policy, credentials, card controls, the payee book, a mandate).

The newer entries added a third shape that is worth naming on its own, because
it is the one that nearly got through: **an act that creates future acts.** A
standing-order mandate is not a payment and does not finalise anything, so it
passes the two tests above and is still refused — §10 — because it produces a
stream of instructions that the agent's own per-instruction ceiling will never
be applied to again. The extended rule: *an agent may write a request; it may
not write a thing that writes requests.*

This is a stronger and more useful rule than "agents should not touch money".
It says exactly where the line is, it explains why `initiate_payment` is allowed
to write to a money-adjacent table while `post_entry` is not, and it predicts
the answer for tools that do not exist yet. Anything that would let an agent
either finalise or redefine goes on the far side of the line, and the test is a
single question: **if this call were wrong, would a person get to see it before
the consequence?** For `initiate_payment` the answer is yes, by construction.
For every operation above the answer is no — either because there is no later
step, or because the operation *is* the later step.

The corollary is that the line is enforced at the narrowest place it can be, not
at the tool list. Where the database can refuse, it refuses: the actor CHECK, the
maker-checker trigger, the composite reviewer FK, the revoked UPDATE grant, the
UNIQUE on `(mandate, scheduled date)`. Where it cannot, the capability is absent
from the process — the MCP module does not import `ledger/post.ts`,
`approvals/decide.ts`, `approvals/release.ts`, `pots/transfer.ts`,
`standing/fire.ts` or anything under `rails/stablecoin/`, and since the newer
readers arrived that absence is asserted by a test rather than left to a
reader's diff. The tool list is the outermost and weakest layer, and it is the
only one a future contributor can change by accident — which is why the layer
below it is now mechanical too.

---

## Where the line is genuinely debatable

I would rather argue these than pretend they are settled.

**Freezing a card.** Freezing is safe-direction: it stops money, it is
reversible by a human, and the cost of a wrong freeze is inconvenience while the
cost of a slow freeze is loss. There is a real argument that an agent detecting
an obvious compromise pattern at 03:00 should freeze immediately and file for
human review, and that refusing this costs more money than it saves. I have kept
it off the surface anyway, for one reason: freezing a business's card is not
inconvenience at scale. It is a payroll card declining at a fuel pump, or a
supplier's card being refused in front of a customer. A false-positive rate that
is fine for a consumer's tenth card is not fine for the one card a small business
runs on. If this moved onto the surface, the honest version would be a *narrow*
tool — freeze only, never unfreeze, only on a specific card, mandatory reason,
automatic notification and a human review SLA measured in minutes — and not a
general card-state tool. I think that version is defensible. I did not build it
because a half-built version of it is worse than none.

**Internal book transfers.** `initiate_payment` accepts `ach`, `usdc` and
`wire`. It refuses `internal`, and the reason is uncomfortable: the seeded
approval policy for `internal` is `threshold 0, required_approvals 0` — book
transfers between our own accounts need no approval, on the sound argument that
both legs are ours, nothing leaves the FBO account, and a mistake is correctable
by a reversal. That reasoning is right. But it makes `internal` the one rail
where a queued instruction could be released with no human ever having
approved it, which would make it the single thing on this surface that can move
money unattended. I refused the rail rather than special-case the policy,
because special-casing a policy inside a tool is exactly the kind of local
exception that later gets copied. A reasonable person could argue the opposite:
that internal transfers are the safest possible thing to automate and that
refusing them is cargo-culting. I would want to see the release path's treatment
of zero-approval instructions before I moved.

**Below-threshold ACH.** The seeded ACH policy says debits under $2,500 need no
second human, and reasons it explicitly: an ACH entry is recallable for two
banking days, which bounds the damage. Taken at face value, that is a written
argument that a sub-$2,500 ACH debit could be released unattended — and this
surface still refuses to release it. So this surface is stricter than the bank's
own policy. That is a defensible choice for a first release and it is not
obviously the right permanent one: the policy is where this decision belongs, and
a tool that ignores a policy in the safe direction is still a tool ignoring a
policy. What I would want before relaxing it is a per-token daily notional cap
(the grant already carries a per-instruction ceiling; a rolling daily one is the
missing half) and a real answer to what happens when the same agent queues forty
$2,400 payments in an hour. The current answer is the write rate limit, six per
minute, which bounds the rate but not the total.

**Reading another business's data.** Scoping here is per-token and absolute: a
tool call cannot name a business, and a chart code resolves inside the grant's
business. That is right for a customer-facing agent. It is wrong for an ops
agent that needs to see the whole platform's unmatched settlement rows — which
is why `list_recon_breaks` counts unattributable breaks without listing them,
and says so in its own response. That count is itself a small cross-tenant leak:
it tells a customer something about platform-wide state. I judged that a caller
being told "no breaks" when the truth is "none of yours, and five nobody owns" is
the worse error, because it invites an agent to tell a customer the books tie
out. Someone could reasonably want that count gone.

**The rate limit is per process.** `RateLimiter` holds its buckets in memory. On
a platform that runs several warm instances the effective limit is
(instances x limit). This is written down in `src/lib/mcp/ratelimit.ts` rather
than implied away, and it is a real gap. It is not on this list because the rate
limit is not the control that stops an attacker — the token, the tenant scope
and the approval queue are. It is the control that stops a well-meaning agent in
a retry loop from consuming an approver's afternoon, and for that purpose a
per-instance bucket is most of the value at none of the risk of putting a shared
counter on the write path.

**Whether there should be a second write tool at all.** The brief for this round
of work offered one, and named two candidates: raising a standing-order mandate
and proposing a payee. I added neither, and it is the decision in this document
most worth arguing with.

The case for a mandate tool is genuinely strong. Occurrences DO land in the
approval queue; no money moves on the day the mandate is written; and a business
that asks an agent "set up the rent" is asking for something reasonable. What
killed it was §10's second reason rather than its first: the grant's
`maxInstructionCents` ceiling applies to `initiate_payment` and not to the cron
that raises occurrences, so a mandate is the one write on offer that escapes the
token's own bound. If a future round wants this, the honest version is
`maxRecurringCentsPerMonth` on the grant, a `standing_order_proposal` table with
its own screen, and an approval that is about the MANDATE rather than about
occurrence #1. That is three pieces of work, and two of them are not MCP.

The case for a payee tool is weaker for a reason that took a while to see: the
payee book is read by the gate that decides whether a payment may be made, so
writing to it is not queueing a request, it is editing a control. A
`payee_candidate` queue fixes that and is a real feature with a real screen; a
proposal table with no screen would be worse than nothing.

The argument against my own position is simple and I want it recorded: a surface
with seven readers and one writer risks being a surface that tells people things
and cannot help them, and there is a version of "safe" that is really just
"useless, and therefore never audited". If this were a product rather than a
trial, the first thing I would build is the mandate proposal queue — the feature
that makes the write safe, not the tool that makes it possible.

**One thing I would not argue about.** Every refusal above is a refusal to let
an agent act unattended. None of them is a claim that the operation is
dangerous *in itself*, and none of them should be read as a reason not to build
a good screen for a person to do it on. The list is about who holds the pen,
not about whether the pen exists.

---

# Appendix: should an agent ever write a card control?

This is the one I was asked to argue rather than assert, so here is the
argument, including the half I do not act on.

## The case FOR, made properly

It is not weak. Card controls are the most operationally useful write in the
product and the one customers ask for most, because the question arrives at the
worst possible time: a card declines at a pump at 06:00 and the person who can
change a control is asleep. Tightening is safe-direction — blocking a category
or lowering a limit STOPS money, and the cost of being wrong is inconvenience
while the cost of being slow is loss. An agent that notices six declines in four
minutes across three states and tightens a card at 03:00 is doing something a
good ops team would do. Refusing it costs real money and I am not going to
pretend otherwise.

## The timing argument, with the measured number

`docs/CARD-CONTROLS.md` §2 measured Lithic's authorisation timeout rather than
quoting it: an ASA responder that stalls returns `6.527 s` against a `0.334 s`
baseline, so **the hard ceiling is 6000 ms, and on timeout Lithic DECLINES.** It
does not approve, it does not retry into an approval; the transaction comes back
`UNKNOWN_HOST_TIMEOUT` with `CUSTOMER_ASA_TIMEOUT` in `detailed_results`. Our own
decision path runs at 40-150 ms, a fortieth of the ceiling and a twentieth of
Lithic's 3000 ms recommendation, which is our actual SLO.

The naive version of the timing objection is "a control write might not land
before the authorisation arrives, so the agent's change would be ignored." That
version is **wrong and I want to discard it explicitly**, because arguing
against a weak form of the objection is how a bad decision gets made. A control
write is a row in `card_control_version`; the decision path reads the current
version at authorisation time. There is no cache to warm and no propagation
delay to a third party. A write that commits before the ASA request arrives is
seen; one that commits after is not. That is an ordinary race between two
database transactions, and it is the same race a human clicking the same button
runs.

**The real timing argument is about the failure mode, not the latency.** The
control write and the authorisation decision are on the same path, and the
decision path has a 6000 ms ceiling with a DECLINE at the end of it. That means
the cost of anything that slows or contends on `card_control_version` is not a
stale answer — it is a declined transaction that would otherwise have been
approved, attributed to nothing, at a pump. A human writes a control roughly
never: a few times a card's life, from a screen, with a person waiting for the
page to load. An agent writes controls on a schedule, in a retry loop, in
response to events, possibly for many cards at once, possibly while a webhook
storm is already loading the same rows. The difference is not correctness, it is
**write frequency against a real-time read path whose timeout is a decline**.
Every other write on this surface fails safe under load: a payment instruction
that cannot be written is a payment that does not get queued, and someone
notices. A control write that contends fails INTO a decline on a card somebody
is standing in front of.

That is the argument I would make to the panel, and I would concede immediately
that it is an argument about operational prudence rather than a proof.

## The argument I actually rest on

Even granting perfect timing and infinite capacity, §13 stands on its own and
would still refuse this:

**A control change IS an authorisation decision, made in advance.** The values
in `card_control_version` are not configuration that a human later acts on. They
ARE the answer the card network receives, inside 6000 ms, with no person on the
path. So an agent that unblocks MCC 5542 has not requested a payment and has not
approved one — it has arranged for the next fuel-pump authorisation to be
approved, and **there is no queue anywhere that will ever show that as a payment
decision.** The money moves, the ledger records an ordinary card settlement, and
the only trace of the decision is a control version row nobody had a reason to
read.

Test it against this document's own question — *if this call were wrong, would a
person get to see it before the consequence?* For `initiate_payment` the answer
is yes, by construction: an approver reads the row. For a control change the
answer is **no, and it is no in a specific and nasty way** — the person who
eventually sees the consequence sees a settled card transaction that looks
exactly like every other settled card transaction. There is nothing to review,
because the review step is the thing that was written.

## Why "tighten-only" does not rescue it

The obvious narrowing is to allow the safe direction and refuse the other. Three
problems, in increasing order of how much they bother me.

1. **Tightening a business's only card is not inconvenience at scale.** It is a
   payroll card declining at a pump, or a supplier's card refused in front of a
   customer. A false-positive rate that is fine for a consumer's tenth card is
   not fine for the one card a small business runs on.
2. **A tighten with no unwind path is a freeze with extra steps.** The agent
   cannot loosen — that is the whole point of tighten-only — so every false
   positive escalates to a human anyway, at 03:00, which is the hour the tool
   existed to cover. The half-built version does not solve the problem it was
   built for.
3. **The direction is not actually well-defined.** Lowering `daily_limit_cents`
   is tightening. Blocking an MCC is tightening. Adding an *allow* list is
   tightening for every category except the ones on it, and a model asked to
   "restrict this card to fuel and parking" would reach for exactly that. A
   permission that depends on classifying a diff as safe-direction is a
   permission whose boundary a model gets to argue about, and it will argue
   correctly nine times and creatively once.

## The verdict

**Read-only, and that is what is built.** `list_card_controls` returns the
controls, the current spend against each limit, the headroom, the real-time
decisions, the rule that fired and the network result code — everything needed
to say "your card declined because category 5542 is blocked on it under control
version 3, set on the 8th by Priya; someone with access to the card console can
change that." That answer is complete, it is actionable, and it ends with a
person, which is the property the whole surface is built to preserve.

**What would change my mind**, concretely, because "no" without that is just
taste:

* a `card_control_proposal` table with its own screen and an approval step, so
  the write lands in a queue the way `initiate_payment` does — at which point
  the agent is proposing again and §13 stops applying;
* OR a freeze-only, one-card, mandatory-reason, auto-notifying tool with a human
  review SLA measured in minutes and an automatic expiry that unwinds it if
  nobody confirms — the expiry being the piece that fixes objection 2 above.

Both are features with screens and SLAs attached. Neither is a tool. The version
that is only a tool is the one that looks like progress and is not, and I would
rather defend a surface that is honestly narrower than one that is quietly
wider.
