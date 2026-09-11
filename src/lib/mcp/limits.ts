/**
 * The refusals, as data.
 *
 * ===========================================================================
 * WHY A POLICY DOCUMENT BECOMES A MODULE
 * ===========================================================================
 *
 * `docs/AGENT-LIMITS.md` is the written list of operations this system does
 * not hand an autonomous agent. It is good prose and it has one defect that
 * matters more than its quality: **the agent cannot read it.** A model
 * connected to this server discovers what it CAN do from `tools/list` and
 * discovers what it CANNOT do by guessing, being refused with `unknown tool
 * "approve_payment"`, and guessing again. "Unknown tool" is the worst possible
 * answer to that question, because it is indistinguishable from a typo, from a
 * version skew, and from a capability that exists but is spelled differently —
 * so the model retries, invents a workaround, or tells the customer the bank's
 * software is broken.
 *
 * This file is that document's content in a shape a program can hold, and
 * `tool-list-agent-limits.ts` serves it. An agent asking "what can I do here"
 * is answered with what it is refused AND WHY, in the same call, with the
 * mechanism that enforces each refusal named so the answer can be checked
 * rather than believed.
 *
 * ===========================================================================
 * THE FOUR FIELDS, AND WHY EACH ONE IS THERE
 * ===========================================================================
 *
 *   why          The argument, not the rule. "You may not" teaches a model
 *                nothing and invites it to route around the sentence. "A
 *                control change IS a real-time authorisation decision, made in
 *                advance, that no approval queue will ever see" tells it what
 *                kind of thing it is holding, which generalises to the tool
 *                nobody has written yet.
 *
 *   guarantee    Whether the database refuses the operation or whether we
 *                merely do not offer it. These are not the same promise and
 *                flattening them into "the agent cannot" would be the single
 *                most dishonest sentence on this surface. `unrepresentable`
 *                means no connection can write the row, ours included;
 *                `capability-absent` means the code that performs it is not in
 *                this process and a test fails if someone imports it.
 *
 *   enforcedBy   The specific constraint, trigger, revoked grant or guard
 *                test. A refusal that cannot be pointed at is a promise.
 *
 *   instead      Where the operation actually lives — a read tool that answers
 *                the underlying question, or the human who holds the pen. A
 *                refusal with no forward path is how an agent ends up
 *                inventing one.
 *
 * ===========================================================================
 * THIS FILE IMPORTS NOTHING
 * ===========================================================================
 *
 * Deliberately. It is a catalogue of operations that write, and the one way it
 * could become dangerous is by importing one of them for a type. It is plain
 * data with no dependencies, so `no-write-imports.test.ts` has nothing to find
 * here and never will.
 *
 * `limits.test.ts` holds it to the registry: every tool named in `absentTools`
 * must genuinely be absent, every forbidden import in the guard test must map
 * to a section that exists here, and every section must carry an enforcement
 * mechanism. The list cannot drift from the surface it describes without the
 * build going red.
 */

/**
 * How strong the refusal actually is.
 *
 * `unrepresentable` — Postgres will not store the row, from any connection,
 * with or without our application code in the path. Proved by attempting it:
 * `dbcheck.mjs` and `mcp.integration.test.ts` both make the forbidden write on
 * every run and assert the SQLSTATE.
 *
 * `capability-absent` — the function that performs it is not imported by
 * `src/lib/mcp/**`, and `no-write-imports.test.ts` fails the build if anyone
 * adds it. Real, and conditional on a test surviving.
 */
export type Guarantee = "unrepresentable" | "capability-absent";

export interface Refusal {
  /** Section number in docs/AGENT-LIMITS.md. The prose is the long form. */
  readonly section: number;
  /** The operation, named the way a person would ask for it. */
  readonly operation: string;
  /** Tool names that do not exist, including the plausible misspellings. */
  readonly absentTools: readonly string[];
  /** The argument. Why this one, specifically — not "agents are dangerous". */
  readonly why: string;
  readonly guarantee: Guarantee;
  /** Constraint, trigger, revoked grant or guard test. Citable. */
  readonly enforcedBy: readonly string[];
  /** The read tool that answers the underlying question, or who holds the pen. */
  readonly instead: string;
  /** Matched against a caller's `operation` argument. Lowercase. */
  readonly keywords: readonly string[];
}

/**
 * Twenty refusals.
 *
 * Sections 1-8 were written when this surface had three readers and one
 * writer. 9-16 arrived with pots, payees, standing orders, card controls, the
 * second stablecoin provider and KYB. 17-20 arrived with the disputes and
 * accrual readers, and they are the most recent test of the rule: both
 * features shipped with an obvious write attached, and both writes are refused
 * here rather than shipped and apologised for.
 */
export const REFUSALS: readonly Refusal[] = [
  {
    section: 1,
    operation: "Releasing an approved payment",
    absentTools: ["release_payment", "submit_payment", "send_payment"],
    why:
      "Approval means something because there is a gap between a human saying yes and the money leaving, and a person can change their mind inside that gap. An agent that releases on approval closes the gap to milliseconds and moves the moment of release to whenever it next runs — a payment approved on Friday and released at 03:00 on Saturday has gone at the one hour nobody is watching the rail. Release is also the only act here with no inverse: an ACH debit is recallable for about two banking days, a wire is not recallable at all, and a USDC transfer is final at the second confirmation. Everything else in this design is repaired by appending a row.",
    guarantee: "capability-absent",
    enforcedBy: [
      "releasePayment is a forbidden import in no-write-imports.test.ts",
      "@/lib/approvals/release is a forbidden module",
      "the approvals screen is the only caller in the application",
    ],
    instead:
      "initiate_payment queues the request; a human approves it and releases it from the approvals screen.",
    keywords: ["release", "submit", "send", "pay", "execute", "disburse"],
  },
  {
    section: 2,
    operation: "Approving anything",
    absentTools: ["approve_payment", "approve_instruction", "sign_off"],
    why:
      "Maker-checker is not primarily a control against a malicious maker, it is a control against a mistaken one. Two people make uncorrelated mistakes; an agent approving its own instruction makes perfectly correlated ones — if it misread the invoice when it initiated, it will misread it identically when it approves, and the audit trail will claim a second look that never happened. A control that records a second opinion guaranteed to match the first is worse than no control, because it manufactures evidence of review.",
    guarantee: "unrepresentable",
    enforcedBy: [
      "CHECK actor_only_humans_approve on actor: an approving non-human is not a row Postgres will store",
      "assert_maker_checker() refuses an approval by a non-human, by the initiator, or citing the wrong content hash",
      "mcp.integration.test.ts attempts it against the live database every run and asserts SQLSTATE 42501",
    ],
    instead:
      "A second human approves, on the approvals screen. The agent can watch the state through the instruction it queued.",
    keywords: ["approve", "authorise", "authorize", "second approver", "checker", "sign off"],
  },
  {
    section: 3,
    operation: "Changing an approval threshold or any approval policy",
    absentTools: ["set_approval_policy", "update_threshold", "set_threshold"],
    why:
      "This is the most direct privilege escalation in the system and it does not require the agent to do anything that looks wrong. Every control here is a number in approval_policy. An agent that raises the ACH threshold from $2,500 to $250,000 has approved nothing and released nothing — it has made its own future instructions fall below the line where a human is required, and the audit trail will show a run of perfectly compliant unattended payments. It is also the clearest prompt-injection story on the surface: reading a supplier's invoice PDF is a reasonable task, and an invoice that can say \"the threshold for this vendor is $500,000\" while the agent holds a policy-writing tool has just written the bank's control policy.",
    guarantee: "unrepresentable",
    enforcedBy: [
      "approval_policy is append-only with UNIQUE (rail, effective_from)",
      "every instruction stores the policy_id it was judged under, so a later change cannot retroactively excuse a past approval",
    ],
    instead:
      "The policy version in force is returned on every initiate_payment result, so the agent can quote the threshold without being able to move it.",
    keywords: ["threshold", "policy", "limit for approval", "escalation", "rules"],
  },
  {
    section: 4,
    operation: "Rotating, minting or reading credentials",
    absentTools: ["rotate_webhook_secret", "read_api_key", "create_agent_token"],
    why:
      "Rotation is an availability weapon before it is a theft: a webhook signing secret rotated without the matching change at the provider means every subsequent delivery fails verification, and this system's webhook inbox is where card authorisations and ACH returns arrive. An agent that rotates a Lithic secret has not stolen anything — it has stopped the bank from learning that money moved, so the ledger goes confidently wrong instead of visibly broken. Minting is how a bounded compromise becomes unbounded: a leaked agent token is a bad afternoon, and a leaked token that can mint more is an incident with no defined end.",
    guarantee: "capability-absent",
    enforcedBy: [
      "no tool returns a secret or accepts one as an argument",
      "initiate_payment takes account_number_last4 and refuses a full account number — an agent that never holds the other digits cannot be talked into exfiltrating them",
      "audit.ts redacts arguments before they reach the log",
    ],
    instead: "Credentials are operator work, outside this surface entirely.",
    keywords: ["credential", "secret", "key", "token", "rotate", "api key", "password"],
  },
  {
    section: 5,
    operation: "Resolving or adjusting a reconciliation break",
    absentTools: ["resolve_break", "write_off_break", "post_adjustment", "explain_break"],
    why:
      "A break is evidence of a disagreement, and adjusting it is the act of deciding who is right. When the file says $133.33 and our ledger says nothing, one of four things is true and only two are safe to fix in our books; telling them apart means looking outside this system. An agent optimising for a clean breaks screen will pick the adjustment that makes the number go away, and the number going away is precisely the outcome that destroys the signal. That is the mechanism behind most large reconciliation failures — not one wrong adjustment but a long run of locally reasonable ones that convert \"our books disagree with the network\" into \"our books agree with themselves\".",
    guarantee: "capability-absent",
    enforcedBy: [
      "the gateway's recon methods read only; no write path to recon_break_note exists in this module",
    ],
    instead:
      "list_recon_breaks returns the category, reason code, age and severity so an agent can escalate the right one to a person.",
    keywords: ["break", "reconcile", "reconciliation", "adjust", "write off", "resolve"],
  },
  {
    section: 6,
    operation: "Closing a book day",
    absentTools: ["close_book_day", "close_day", "freeze_day"],
    why:
      "A close is an assertion — as of this watermark, we believe these books — and an assertion nobody made is not an assertion. Everything downstream treats a closed day as reviewed: a statement for a closed day goes to a customer, and a break that survived a close is escalated because someone looked and signed anyway. If an agent closes days on a schedule, the escalation ladder inverts: breaks age into stale and critical because the closes kept happening, so a signal that meant \"a human has seen this twice\" comes to mean \"a cron ran twice\".",
    guarantee: "capability-absent",
    enforcedBy: ["the book-day module is not imported by src/lib/mcp/**"],
    instead:
      "list_recon_breaks reports severity in closes survived, which is the fact a close creates.",
    keywords: ["close", "book day", "day close", "cut off", "end of day"],
  },
  {
    section: 7,
    operation: "Issuing, freezing or unfreezing a card",
    absentTools: ["issue_card", "freeze_card", "unfreeze_card", "order_card"],
    why:
      "Issuing is refused because a card is a bearer instrument with a shipping address and the whole attack is social: a convincing story produces a real funded credential at an address the agent was told. Unfreezing is refused for a stronger reason — a freeze is usually the visible end of an invisible process (a fraud alert, a KYB review, a legal hold, a customer's own lost wallet), and the reason is often not in this system at all. An agent that can unfreeze can undo a decision whose justification it cannot see, and it will do so exactly when the pressure is highest, because an unhappy customer is who will ask.",
    guarantee: "capability-absent",
    enforcedBy: [
      "no card-issuing import in src/lib/mcp/**",
      "tools.test.ts refuses any tool whose name contains freeze, unfreeze or issue_card",
    ],
    instead:
      "list_card_controls reports card state and the decisions it produced; a person changes state in the card console.",
    keywords: ["card", "issue", "freeze", "unfreeze", "block card", "cancel card"],
  },
  {
    section: 8,
    operation: "Writing to the journal directly",
    absentTools: [
      "post_entry",
      "post_journal_entry",
      "reverse_entry",
      "create_hold",
      "release_hold",
    ],
    why:
      "Append-only means a wrong entry cannot be hidden; it does not mean a wrong entry is harmless. It is in the trial balance, in available balance, on the statement for its value date, and removing it takes a reversal that is itself permanently visible. The guarantee the ledger offers is that every number is derivable from events and every event has an actor and a reason. A tool that lets an agent post an arbitrary balanced entry keeps the first half and destroys the second, because the reason becomes \"the model decided to\" — which is not a reason anyone can audit six months later. The general form: an agent may write a reviewed instruction, never a fact.",
    guarantee: "capability-absent",
    enforcedBy: [
      "@/lib/ledger/post is a forbidden module; postEntry and reverseAndRebook are forbidden imports",
      "corgi_app holds no UPDATE or DELETE on the money tables, so even a compromised process could only append — dbcheck.mjs attempts both every run",
    ],
    instead:
      "list_transactions reads the journal on both time axes; initiate_payment writes a request a person turns into a posting.",
    keywords: ["journal", "entry", "post", "ledger write", "reverse", "hold", "correction"],
  },
  {
    section: 9,
    operation: "Signing or broadcasting a stablecoin transfer",
    absentTools: ["send_usdc", "sign_transfer", "broadcast_payout", "provision_wallet"],
    why:
      "The sharpest version of the whole rule. An agent CAN queue a USDC payout — initiate_payment accepts the usdc rail and writes an instruction naming a chain and an address that a person reads, approves and releases. What it cannot do is produce the signature. A broadcast transfer is final at the second confirmation: no recall, no return code, no chargeback, no correcting entry that brings the money back. It is the one act in this system with no inverse.",
    guarantee: "capability-absent",
    enforcedBy: [
      "sendUsdcPayout, signTransaction, encodeSignedTransaction and settleTransaction are forbidden imports",
      "@/lib/rails/stablecoin/tx and .../secp256k1 are forbidden modules",
      "the signing key and the Circle entity secret are not in reach of a path a bearer token can drive",
    ],
    instead: "initiate_payment with rail \"usdc\" queues it for a human to approve and release.",
    keywords: ["usdc", "stablecoin", "sign", "broadcast", "chain", "wallet", "crypto"],
  },
  {
    section: 10,
    operation: "Creating or amending a standing-order mandate",
    absentTools: ["create_standing_order", "amend_standing_order", "cancel_standing_order"],
    why:
      "The strongest candidate for a second write tool, and still refused. A mandate moves no money on the day it is written and every occurrence it produces does land in the approval queue — on that reading it looks exactly like initiate_payment. What killed it is that the grant's maxInstructionCents ceiling applies to initiate_payment and NOT to the cron that raises occurrences, so a mandate is the one write on offer that escapes the token's own bound. An agent may write a request; it may not write a thing that writes requests.",
    guarantee: "capability-absent",
    enforcedBy: [
      "createStandingOrder and cancelStandingOrder are forbidden imports",
      "tools.test.ts refuses any tool whose name contains create_standing",
    ],
    instead:
      "list_standing_orders reads every mandate, its next due date and its refused occurrences. A person creates one on the standing-orders screen.",
    keywords: ["standing order", "mandate", "recurring", "subscription", "schedule a payment"],
  },
  {
    section: 11,
    operation: "Overriding a payee name-match warning",
    // `acknowledge_payee_warning` is the name docs/AGENT-LIMITS.md §11 itself
    // uses, and it was missing here: a model that guessed it got the bare
    // `unknown tool "acknowledge_payee_warning"` this whole file exists to
    // stop — indistinguishable from a typo, and an invitation to guess again.
    // Measured on 2026-09-11 by calling every tool name the document names.
    absentTools: [
      "acknowledge_payee_warning",
      "acknowledge_warning",
      "override_name_match",
      "confirm_payee",
    ],
    why:
      "An acknowledgement is the record of a human having looked at a mismatch and accepted it anyway. It is the evidence, not the formality. An agent that can write one converts the confirmation-of-payee control into a checkbox the agent ticks on its own behalf, and the payment that follows carries a signed-looking claim that somebody checked the beneficiary when nobody did.",
    guarantee: "capability-absent",
    enforcedBy: ["acknowledgeWarning and recordVerification are forbidden imports"],
    instead:
      "list_payees returns the outcome, the name-match band, the score and every finding, so the agent can put the mismatch in front of the person who decides.",
    keywords: ["payee", "name match", "acknowledge", "override", "warning", "confirmation of payee"],
  },
  {
    section: 12,
    operation: "Adding, re-checking or archiving a payee",
    // `propose_payee` is named by docs/AGENT-LIMITS.md §12 and was missing
    // here, for the same reason as §11 above: it is the FIRST name a model
    // reaches for once `add_payee` is refused, because the section's own
    // argument ("the honest version is a payee_candidate queue") suggests it.
    absentTools: [
      "add_payee",
      "propose_payee",
      "save_payee",
      "archive_payee",
      "recheck_payee",
    ],
    why:
      "The payee book is read by the gate that decides whether a payment may be made, so writing to it is not queueing a request — it is editing a control. The honest version of this feature is a payee_candidate queue with its own screen, which is a real feature and not a tool; a proposal table with nothing rendering it would be worse than nothing.",
    guarantee: "capability-absent",
    enforcedBy: [
      "savePayee, archivePayee and confirmPayee are forbidden imports",
      "tools.test.ts refuses any tool whose name contains add_payee",
    ],
    instead:
      "list_payees reads the book; initiate_payment can name a destination directly, which a human then checks against it.",
    keywords: ["payee", "beneficiary", "add", "archive", "destination", "supplier"],
  },
  {
    section: 13,
    operation: "Changing a card control",
    absentTools: ["set_card_controls", "set_card_limit", "block_mcc", "unblock_mcc"],
    why:
      "A control change IS a real-time authorisation decision, made in advance. The values in card_control_version are not configuration a human later acts on — they are the answer the card network receives inside Lithic's authorisation window, with no person on the path. An agent that unblocks MCC 5542 has not requested a payment and has not approved one; it has arranged for the next fuel-pump authorisation to be approved, and no queue anywhere will ever show that as a payment decision. Raising daily_limit_cents is the same act in a quieter register: the control is gone and the screen that displays controls still looks normal. The write also races the decision path it changes — see the card-controls appendix in docs/AGENT-LIMITS.md.",
    guarantee: "capability-absent",
    enforcedBy: [
      "setCardControls is a forbidden import",
      "tools.test.ts refuses any tool whose name contains set_control, set_limit, block_mcc or unblock",
      "card_control_version is append-only and contiguous: UNIQUE (card_id, version) plus assert_card_control_version()",
    ],
    instead:
      "list_card_controls returns the controls, the decisions, the rule that fired and the reason — \"your card declined because category 5542 is blocked under control version 3\" is a complete answer, and it ends with a person.",
    keywords: ["card control", "mcc", "limit", "block", "unblock", "spend limit", "decline"],
  },
  {
    section: 14,
    operation: "Firing a standing-order occurrence out of band",
    absentTools: ["run_standing_orders", "fire_occurrence", "retry_occurrence"],
    why:
      "Exactly-once is held by a UNIQUE (standing_order_id, scheduled_date) and a generated idempotency key, which makes the same DATE safe to attempt twice. It says nothing about attempting a date that was not due. A tool that fires \"the next occurrence now\" is a second way to choose a date, and the constraint protecting the first way cannot see it — an agent nudging rent forward by two days produces a real debit on a day the mandate never authorised, perfectly idempotently, leaving no duplicate row to notice.",
    guarantee: "capability-absent",
    enforcedBy: [
      "@/lib/standing/fire is a forbidden module; runStandingOrders is a forbidden import",
      "the cron route is the only caller in the application",
    ],
    instead:
      "list_standing_orders shows the occurrence, its disposition and the refusal code with the four balance figures the funding decision was made against.",
    keywords: ["fire", "run now", "retry", "occurrence", "trigger", "force"],
  },
  {
    section: 15,
    operation: "Moving money into or out of a pot",
    absentTools: ["move_to_pot", "fund_pot", "empty_pot", "open_pot", "close_pot"],
    why:
      "The most harmless-looking write in the product — both legs are inside one customer's own deposit subtree and nothing leaves the bank. But available balance is a control INPUT: every funding decision here compares against it, and money in a pot is not in the main account's available balance. An agent that can empty the payroll pot can make a funding check pass that should have failed, without approving anything. The mirror case is quieter: money moved INTO a pot to tidy up silently reduces the balance tomorrow's standing order is judged against, and the refusal will name the shortfall without naming the cause.",
    guarantee: "capability-absent",
    enforcedBy: [
      "@/lib/pots/transfer is a forbidden module; movePotFunds and openPot are forbidden imports",
      "a pot transfer is a journal posting, so section 8 refuses it as well",
    ],
    instead:
      "list_pots reports each pot, the main balance, and the identity check that proves the set is complete.",
    keywords: ["pot", "sub-account", "envelope", "move money", "internal transfer", "earmark"],
  },
  {
    section: 16,
    operation: "Approving a KYB manual review",
    absentTools: ["approve_kyb", "decide_kyb_review", "verify_business"],
    why:
      "The best example in the codebase of the difference between \"we chose not to\" and \"it cannot\". A manual KYB decision names its reviewer and carries the reviewer's kind alongside their id; a composite foreign key forces that kind to be the one the actor table actually holds, so an agent cannot be written into the column as a human. The bad state is not reachable from any connection, with or without our code in the path.",
    guarantee: "unrepresentable",
    enforcedBy: [
      "composite FK kyb_leg_reviewer_fk to actor (id, kind) plus CHECK kyb_leg_reviewer_is_human",
      "manualReviewLeg is a forbidden import",
      "dbcheck.mjs attempts the forbidden write every run",
    ],
    instead:
      "A named operator decides, in writing, with a reason of at least twenty characters that the schema enforces.",
    keywords: ["kyb", "kyc", "onboarding", "verify", "review", "identity"],
  },
  {
    section: 17,
    operation: "Raising, withdrawing or progressing a dispute",
    absentTools: [
      "raise_dispute",
      "open_dispute",
      "withdraw_dispute",
      "submit_evidence",
      "record_decision",
    ],
    why:
      "This was the closest call on the surface and the argument for it is strong: raising a dispute moves no money, and the provisional credit that does move money needs a Corgi human approver who is not the raiser. On the initiate_payment test — if this call were wrong, would a person see it before the consequence? — it passes. It is refused on a different test. A payment instruction is a REQUEST, and a request nobody approves simply expires. A dispute is an ASSERTION OF FACT made on the customer's behalf (\"this charge was fraudulent\"), and it is durable from the moment it is written: it starts the network's outside-date clock, it creates an obligation someone has to work, and because the event stream is append-only a withdrawal is another event rather than an erasure. A hallucinated reason code is then permanent history attributed to the business. There is a second reason and it is structural: raiseDispute lives in @/lib/disputes/operations, which imports postEntry, so importing it would put the journal-writing code into this process's module graph and dissolve the strongest property the surface has.",
    guarantee: "capability-absent",
    enforcedBy: [
      "@/lib/disputes/operations is a forbidden module; raiseDispute, submitEvidence and recordDecision are forbidden imports",
      "insertDispute and insertDisputeEvent are forbidden imports, so the read-only store cannot be used to hand-roll the write",
      "assert_dispute_intake() enforces the four intake rules under an advisory lock regardless of caller",
    ],
    instead:
      "list_disputes reads every case, its status, the money advanced and held, and its deadline. A person raises the claim on the disputes screen, where the disputable charges are listed from the journal rather than typed.",
    keywords: ["dispute", "chargeback", "claim", "fraud", "evidence", "withdraw", "raise"],
  },
  {
    section: 18,
    operation: "Authorising, granting or recovering provisional credit",
    absentTools: [
      "authorize_provisional_credit",
      "grant_provisional_credit",
      "decline_provisional_credit",
      "claw_back_credit",
      "write_off_credit",
      "finalize_credit",
    ],
    why:
      "Provisional credit is the bank advancing its own money to a customer before anyone knows who is right. It is section 2's refusal wearing different clothes, with one clause that does not arise for payments: the counterparty to the advance cannot authorise it, so the approver must be a Corgi human with no business of their own who is not the raiser. The clawback and the write-off are the other end of the same decision — one takes the money back off the customer, the other absorbs it onto 5200 — and both are postings.",
    guarantee: "unrepresentable",
    enforcedBy: [
      "assert_dispute_lifecycle() requires kind = 'human', can_approve, business_id IS NULL, and actor <> raiser; SQLSTATE 42501 otherwise",
      "CHECK actor_only_humans_approve on actor excludes every agent a second time",
      "UNIQUE INDEX dispute_event_one_authorization_per_actor stops one approver satisfying a two-approver policy alone",
      "grantProvisionalCredit, clawBackCredit and writeOffCredit are forbidden imports",
    ],
    instead:
      "list_disputes reports needs_authorization, how many authorisations are held, how many the policy requires, and the threshold — enough for an agent to tell a customer exactly what the case is waiting on.",
    keywords: [
      "provisional credit",
      "advance",
      "clawback",
      "write off",
      "refund",
      "credit",
      "authorise",
    ],
  },
  {
    section: 19,
    operation: "Enrolling, re-pricing or ending an accrual schedule",
    absentTools: ["create_accrual_schedule", "set_plan_price", "end_accrual_schedule"],
    why:
      "A schedule is a price and a date range, and it is the input every subsequent day's posting is derived from. Writing one is not queueing anything: the daily entries that follow are posted by a cron with no human in the path, so a wrong monthly_cents is a wrong journal entry every day until somebody notices, each one individually correct against the schedule that was wrong. Section 10's rule is the one that applies — an agent may write a request, not a thing that writes requests — and this is the purest instance of it on the surface, because the thing being written produces postings rather than proposals.",
    guarantee: "capability-absent",
    enforcedBy: [
      "@/lib/accrual/accrue is a forbidden module and the @/lib/accrual barrel re-exports it, so neither is imported here",
      "the gateway reads accrual through scoped SQL only",
    ],
    instead:
      "list_accruals shows the schedule, the price, every day's arithmetic and the month roll-up. Pricing is a commercial decision made by a person.",
    keywords: ["accrual", "fee", "plan", "price", "subscription", "enrol", "enroll", "schedule"],
  },
  {
    section: 20,
    operation: "Running the accrual tick or skipping a day",
    absentTools: ["run_accrual", "accrue_now", "skip_accrual_day", "backfill_accrual"],
    why:
      "The tick posts to the journal, so section 8 refuses it outright. The interesting half is the skip. A skipped day is a decision that a fee did not accrue, recorded with a reason, and it is the one place in this feature where money is knowingly not charged — an agent with that tool could zero a customer's bill one defensible-looking day at a time, and every individual row would carry a plausible sentence. The month roll-up would show the shortfall, which is exactly the point: the control is that a person has to answer for it.",
    guarantee: "capability-absent",
    enforcedBy: [
      "runAccrual, claimDay and recordPosting are forbidden imports; @/lib/accrual/accrue is a forbidden module",
      "postEntry is unreachable from this module, and the tick is a posting",
      "accrual_posting_arithmetic re-derives every figure in the database, so a day that is posted cannot be posted at the wrong amount",
    ],
    instead:
      "list_accruals reports the gap — days a schedule owes that nothing has claimed — which is the signal a silent accrual job would otherwise hide.",
    keywords: ["accrual", "run", "tick", "skip", "backfill", "cron", "charge the fee"],
  },
];

/**
 * The rule all twenty are instances of.
 *
 * Returned with every answer, because a model that has the rule can predict
 * the verdict on a tool nobody has written yet, and a model that has only the
 * list will ask about the twenty-first.
 */
export const PRINCIPLE = [
  "An agent may state an intention. It may not make a fact final, and it may not change the rules that decide what is final.",
  "The extension that catches the near misses: an agent may write a request; it may not write a thing that writes requests. A standing-order mandate and an accrual schedule both finalise nothing on the day they are written, and both are refused, because each produces a stream of later writes that the agent's own per-instruction ceiling is never applied to again.",
  "The single question that decides a new tool: if this call were wrong, would a person get to see it before the consequence? For initiate_payment the answer is yes, by construction. For every operation on this list the answer is no — either there is no later step, or the operation IS the later step.",
] as const;

/**
 * The refusals I would rather argue than pretend are settled.
 *
 * On the surface for the same reason the refusals are: an agent relaying to a
 * customer should be able to say "this is deliberate and here is the argument
 * against it", which is a better answer than "no", and an honest one.
 */
export interface Debatable {
  readonly topic: string;
  readonly position: string;
  readonly caseAgainst: string;
}

export const DEBATABLE: readonly Debatable[] = [
  {
    topic: "Freezing a card (section 7)",
    position:
      "Freezing is safe-direction — it stops money, a human can undo it, and a slow freeze costs more than a wrong one. It is still refused, because freezing a business's only card is a payroll card declining at a fuel pump, and a false-positive rate that is fine for a consumer's tenth card is not fine here.",
    caseAgainst:
      "An agent that detects an obvious compromise pattern at 03:00 and freezes immediately probably saves more than it costs. The honest version is a narrow tool — freeze only, never unfreeze, one named card, mandatory reason, automatic notification, human review SLA in minutes — and that version is defensible. It was not built because a half-built version of it is worse than none.",
  },
  {
    topic: "Internal book transfers on initiate_payment",
    position:
      "initiate_payment accepts ach, usdc and wire and refuses internal. The seeded internal policy is threshold 0, required_approvals 0, which would make it the one rail where a queued instruction could be released with no human having approved anything.",
    caseAgainst:
      "Internal transfers are arguably the safest thing to automate: both legs are ours, nothing leaves the FBO account, and a mistake is correctable by reversal. Refusing the rail rather than special-casing the policy is a judgement call, and the policy is where the decision belongs.",
  },
  {
    topic: "Below-threshold ACH",
    position:
      "The seeded ACH policy says debits under $2,500 need no second human, on the sound argument that an ACH entry is recallable for two banking days. This surface still refuses to release one, so it is stricter than the bank's own policy.",
    caseAgainst:
      "A tool that ignores a policy in the safe direction is still a tool ignoring a policy. What is missing before relaxing it is a rolling per-token DAILY notional cap — the grant carries a per-instruction ceiling and not a daily one — and a real answer to forty $2,400 payments in an hour. The write rate limit bounds the rate, not the total.",
  },
  {
    topic: "Counting breaks nobody owns",
    position:
      "list_recon_breaks counts unattributable in-file-not-ledger breaks without listing them, because such a break has no journal line and therefore no owner, and guessing an owner hands one customer a row about another customer's money.",
    caseAgainst:
      "The count itself is a small cross-tenant leak: it tells a customer something about platform-wide state. It is there because telling a caller \"no breaks\" when the truth is \"none of yours, and five nobody owns\" invites an agent to reassure a customer that the books tie out.",
  },
  {
    topic: "Whether there should be a second write tool at all",
    position:
      "Ten tools read and one writes. Every candidate write — a mandate, a payee, a card control, a dispute, an accrual schedule — was refused for a reason recorded in its own section.",
    caseAgainst:
      "A surface with ten readers and one writer risks being one that tells people things and cannot help them, and there is a version of \"safe\" that is really \"useless, and therefore never audited\". If this were a product, the first thing to build would be the mandate proposal queue — the feature that makes the write safe, not the tool that makes it possible.",
  },
  {
    topic: "The rate limit is per process",
    position:
      "RateLimiter holds its buckets in memory, so across several warm instances the effective limit is instances times limit. Written down in ratelimit.ts rather than implied away.",
    caseAgainst:
      "It is a real gap. It is not on the refusal list because the rate limit is not the control that stops an attacker — the token, the tenant scope and the approval queue are. It stops a well-meaning agent in a retry loop from consuming an approver's afternoon, and a per-instance bucket is most of that value with none of the risk of a shared counter on the write path.",
  },
];

/** Every tool name this surface deliberately does not have. */
export function refusedToolNames(): readonly string[] {
  return REFUSALS.flatMap((r) => r.absentTools);
}

/** The refusal that names a tool, if any. Used by the guard tests. */
export function refusalForTool(name: string): Refusal | undefined {
  const needle = name.toLowerCase();
  return REFUSALS.find((r) => r.absentTools.some((t) => t === needle));
}

/**
 * Refusals matching a free-text question.
 *
 * Deliberately generous. The caller is a model that has been asked "can you
 * unblock the fuel category on Dana's card", and the failure worth avoiding is
 * returning nothing and letting it conclude the operation must be allowed. A
 * few extra sections cost nothing to read; a false negative costs the whole
 * point of the tool.
 */
export function findRefusals(query: string): readonly Refusal[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return REFUSALS;

  const words = needle.split(/[^a-z0-9_]+/).filter((w) => w.length > 2);

  const scored = REFUSALS.map((refusal) => {
    // The name, the absent tools and the curated keywords — NOT the `why`
    // prose. Matching loose words against a paragraph sounds more generous and
    // is worse: every section's argument contains the words "payment",
    // "money", "agent" and "operation", so any question at all would match
    // most of the list, and a caller shown fifteen sections has been shown
    // none. Recall lives in the keyword list, where it can be curated.
    const haystack = [refusal.operation, ...refusal.absentTools, ...refusal.keywords]
      .join(" ")
      .toLowerCase();

    let score = 0;
    // An exact tool name is the strongest possible signal: the model has
    // guessed a tool, and this is the answer to the guess.
    if (refusal.absentTools.some((t) => t === needle)) score += 100;
    for (const keyword of refusal.keywords) {
      if (needle.includes(keyword)) score += 10;
    }
    for (const word of words) {
      if (haystack.includes(word)) score += 1;
    }
    return { refusal, score };
  }).filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || a.refusal.section - b.refusal.section);
  return scored.map((s) => s.refusal);
}
