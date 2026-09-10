# Operations we do not hand an autonomous agent

The MCP surface at `POST /api/mcp` has four tools: `get_balance`,
`list_transactions`, `list_recon_breaks`, and `initiate_payment`. Three read.
The fourth writes a request into a queue a person has to work through. That is
the whole surface, and the interesting property is not what is on it — it is
what is missing and why.

This document is the list of what is missing. It is not a policy we intend to
enforce in code later; every item below is already absent from the tool
registry, and `src/lib/mcp/tools.test.ts` fails the build if a tool named after
one of them appears. Where the database can also refuse the operation, the
constraint is named, because a rule that lives only in a tool list is a rule
that survives exactly until someone adds a tool.

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

## The principle underneath all eight

Every refusal above is an instance of one rule:

> **An agent may state an intention. It may not make a fact final, and it may
> not change the rules that decide what is final.**

The three read tools observe facts. `initiate_payment` states an intention, in a
row whose only consequence is that a person sees it. Everything on the list
above is either the act of making something final (release, close, approve,
adjust, post) or the act of moving the boundary of what needs a human (policy,
credentials, card state).

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
maker-checker trigger, the revoked UPDATE grant. Where it cannot, the capability
is simply absent from the process — the MCP module does not import
`ledger/post.ts`, `approvals/decide.ts` or `approvals/release.ts`, so there is
no code path to reach even by mistake. The tool list is the outermost and
weakest layer, and it is the only one a future contributor can change by
accident.

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
