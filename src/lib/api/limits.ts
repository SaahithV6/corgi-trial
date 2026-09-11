/**
 * What the public HTTP API refuses, as data.
 *
 * ===========================================================================
 * THE RULE: AT LEAST AS STRICT AS THE AGENT SURFACE, NEVER LESS
 * ===========================================================================
 *
 * `docs/AGENT-LIMITS.md` and `src/lib/mcp/limits.ts` already hold twenty
 * refusals for the MCP surface, each with an argument, an enforcement
 * mechanism and a forward path. Every one of them applies here unchanged and
 * is INHERITED rather than restated — `inheritedRefusals()` below is literally
 * that array. Restating twenty arguments in a second file is how the two lists
 * disagree six weeks from now, and a divergence would show up as an HTTP
 * endpoint that exists for an operation the agent surface argued against.
 *
 * WHY THE HTTP SURFACE MUST BE STRICTER, and it is not a slogan:
 *
 *   1. THE AUDIENCE IS WIDER AND FLATTER. An MCP token is handed to one agent
 *      configured by one operator. An HTTP token is handed to whoever an
 *      integrator's engineering team decides should hold it, lives in their
 *      CI, and is copied into their staging environment. The blast radius of
 *      one leaked credential is the same set of operations, reached by more
 *      people, more often.
 *
 *   2. NOBODY READS THE REFUSAL. The MCP surface's refusals are written for a
 *      language model that will read `reason` and `instead` and change course
 *      — `list_agent_limits` exists precisely so it can. An HTTP client reads
 *      a status code. A 403 with a beautiful paragraph in it is retried in a
 *      loop by a `while (!ok)` that someone wrote at 2am. So an operation that
 *      is merely DISCOURAGED on the agent surface has to be ABSENT here.
 *
 *   3. THE CALL RATE IS MACHINE RATE, NOT CONVERSATION RATE. An agent writes
 *      when a person asks it to. An integration writes on a webhook, on a
 *      cron, and on every retry of both. Every argument in AGENT-LIMITS that
 *      turns on write frequency — §13's above all — is strictly worse here.
 *
 * ===========================================================================
 * THIS FILE IMPORTS ONE THING, AND IT IS A LIST OF STRINGS
 * ===========================================================================
 *
 * `@/lib/mcp/limits` is a catalogue of operations that write and it imports
 * nothing at all, deliberately, so that it can never become the module that
 * makes one of them reachable. This file imports that catalogue and nothing
 * else, for the same reason. `no-write-imports.test.ts` in this directory
 * asserts it.
 */

import { PRINCIPLE, REFUSALS, type Guarantee, type Refusal } from "@/lib/mcp/limits";

export type { Guarantee, Refusal };
export { PRINCIPLE };

/** The twenty, unchanged. Every one applies to this surface too. */
export function inheritedRefusals(): readonly Refusal[] {
  return REFUSALS;
}

/**
 * One refusal that exists because this is HTTP and not MCP.
 *
 * Numbered `A1..` so that a citation is never ambiguous against
 * AGENT-LIMITS §1..§20.
 */
export interface ApiRefusal {
  /** `A3`. Cited in docs/API.md. */
  readonly ref: string;
  readonly operation: string;
  /** Paths that do not exist, including the plausible guesses. */
  readonly absentEndpoints: readonly string[];
  readonly why: string;
  readonly guarantee: Guarantee;
  readonly enforcedBy: readonly string[];
  readonly instead: string;
  /** AGENT-LIMITS sections this sharpens, if any. */
  readonly sharpens: readonly number[];
}

export const API_REFUSALS: readonly ApiRefusal[] = [
  {
    ref: "A1",
    operation: "Writing a card control — a limit, an MCC block, an allow list",
    absentEndpoints: [
      "PUT /api/v1/cards/{id}/controls",
      "POST /api/v1/cards/{id}/limits",
      "POST /api/v1/cards/{id}/block-mcc",
      "PATCH /api/v1/cards/{id}",
    ],
    why:
      "A control change IS a real-time authorisation decision, made in advance. The values in card_control_version are not configuration a human later acts on — they ARE the answer the card network receives, inside Lithic's authorisation window, with no person on the path. Test it against the question this build decides new capabilities with: if this call were wrong, would a person get to see it before the consequence? For a queued payment, yes, by construction. For a control change, NO, and no in a specific way — the person who eventually sees the consequence sees a settled card transaction that looks exactly like every other settled card transaction. There is nothing to review, because the review step is the thing that was written. " +
      "THE HTTP-SPECIFIC HALF, which is the reason this entry exists separately from AGENT-LIMITS §13. docs/CARD-CONTROLS.md §2 MEASURED Lithic's timeout rather than quoting it: a stalled ASA responder returns 6.527 s against a 0.334 s baseline, so the hard ceiling is 6000 ms and on timeout Lithic DECLINES — it does not approve and it does not retry into an approval. Our own decision path runs at 40-150 ms. The naive objection, that a control write might not land before the authorisation arrives, is WRONG and worth discarding explicitly: a write that commits before the ASA request is seen and one that commits after is not, which is an ordinary race between two transactions and the same race a human clicking the same button runs. The real argument is about failure mode and frequency. The control write and the authorisation decision contend on the same rows, and the decision path's timeout IS a decline. A human writes a control a few times in a card's life, from a screen, with a person waiting for the page to load. An HTTP integration writes controls from a webhook handler, on a schedule, in a retry loop, possibly for every card at once, possibly while a webhook storm is already loading the same rows — and it does so without any of the natural rate limiting a person at a keyboard provides. Every other write on this surface fails safe under load: a payment instruction that cannot be written is a payment that does not get queued, and somebody notices. A control write that contends fails INTO a decline, on a card somebody is standing in front of, at a pump, attributed to nothing.",
    guarantee: "capability-absent",
    enforcedBy: [
      "no route exists under src/app/api/v1/cards/**",
      "setCardControls is a forbidden import in src/lib/api/no-write-imports.test.ts",
      "card_control_version is append-only and contiguous: UNIQUE (card_id, version) plus assert_card_control_version()",
    ],
    instead:
      "Read the controls and the decisions. A complete answer — 'this card declined because category 5542 is blocked under control version 3, set on the 8th by Priya' — is actionable and ends with a person, which is the property this surface exists to preserve. Changing it is a console action. What would change this verdict, concretely: a card_control_proposal table with its own screen and an approval step, so the write lands in a queue the way a payment does. At that point the integration is proposing again and this entry stops applying.",
    sharpens: [13],
  },
  {
    ref: "A2",
    operation: "Reading or returning a card number, CVV, expiry or full bank account number",
    absentEndpoints: [
      "GET /api/v1/cards/{id}/pan",
      "GET /api/v1/cards/{id}/secrets",
      "GET /api/v1/payees/{id}/account-number",
    ],
    why:
      "No endpoint on this API returns a PAN, a CVV, an expiry or a full account number, and no endpoint ACCEPTS a full account number either. The write side is the half people forget: the approvals module stores `accountNumberLast4` because an approver needs to RECOGNISE a beneficiary, not to be able to re-key the payment somewhere else. Honouring that one layer earlier means a compromised integration cannot exfiltrate a full account number from a response it triggers, and the audit log — which is shipped to a log aggregator by some unrelated deploy sooner or later — cannot accidentally become the most sensitive store in the system. Last four identifies a beneficiary in an investigation; the other ten only create liability. A routing number is the deliberate exception and is carried in full: it is published by the Federal Reserve and it is exactly what an investigator needs to name the receiving institution.",
    guarantee: "capability-absent",
    enforcedBy: [
      "every destination schema in src/lib/api/routes/payments.ts takes account_number_last4 and refuses a longer value",
      "redactArguments() masks account_number, iban, card_number and pan to last four before anything is logged",
      "no route under src/app/api/v1/** reads the issuer's card detail endpoints",
    ],
    instead:
      "Last four plus the holder name is what a payments team actually checks a beneficiary against, and it is on every payee and every payment response.",
    sharpens: [7],
  },
  {
    ref: "A3",
    operation: "Replaying a webhook, simulating an authorisation, or driving the provider simulators",
    absentEndpoints: [
      "POST /api/v1/webhooks/replay",
      "POST /api/v1/simulate/authorization",
      "POST /api/v1/cards/{id}/simulate",
    ],
    why:
      "This deployment has operator routes that replay provider events and drive the simulators, and they are deliberately NOT under /api/v1 and never will be. An integrator who can replay a settlement webhook can manufacture a settlement: the consumers are idempotent, so a replay of a REAL event is correctly a no-op — but a synthesised one that has never been delivered is a journal entry with a provider's name on it and no provider behind it. That is indistinguishable, in the ledger and on the statement, from money that actually moved. The whole reconciliation feature exists to catch exactly this disagreement between provider truth and our books, and handing a caller the ability to write the provider's side of it would make the breaks screen unable to tell a real break from a manufactured one.",
    guarantee: "capability-absent",
    enforcedBy: [
      "no route exists under src/app/api/v1/webhooks/** or src/app/api/v1/simulate/**",
      "the operator routes sit outside /api/v1 behind their own token and signature verification",
    ],
    instead:
      "Read the consequences: GET /api/v1/transactions shows every entry a provider event produced, and GET /api/v1/reconciliation/breaks shows where the provider's file and this ledger disagree.",
    sharpens: [5, 8],
  },
  {
    ref: "A4",
    operation: "Naming a house account, or reading anything platform-wide",
    absentEndpoints: [
      "GET /api/v1/accounts/1110",
      "GET /api/v1/businesses",
      "GET /api/v1/ledger/trial-balance",
    ],
    why:
      "The customer's money lives on per-business leaves of the chart. `1110` — the FBO cash account — is every customer's money pooled, and the rail control accounts are every business's settlements on that rail. A single settlement entry touches BOTH the customer's leaf and the control account, so an endpoint keyed on the control account would hand one business every other business's activity on the rail. The gateway's scoping predicate is `business_id = $1` and NOT `business_id = $1 OR business_id IS NULL`, so a house account is not merely filtered out — it is not addressable. A cross-business read on this surface is a data breach, not a bug, and src/lib/api/isolation.test.ts asserts it against the live database on every run.",
    guarantee: "capability-absent",
    enforcedBy: [
      "gateway.findAccount filters on business_id = $1 with no IS NULL disjunct",
      "FORBIDDEN_QUERY_PARAMETERS — no endpoint declares business_id, account_id, entity_id or any sibling; routes.test.ts asserts it over every route file",
      "src/lib/api/isolation.test.ts attempts a cross-business read against the live database and asserts the refusal",
    ],
    instead:
      "GET /api/v1/accounts lists every code this token can name. The one deliberate platform-wide figure on the whole surface is `unattributable_open_breaks` on the reconciliation endpoint — a COUNT, never a list, argued in that file.",
    sharpens: [],
  },
  {
    ref: "A5",
    operation: "Originating an internal book transfer",
    absentEndpoints: ['POST /api/v1/payments with rail "internal"'],
    why:
      "The seeded internal-rail policy is threshold 0, required approvals 0. Every other rail on this endpoint produces an instruction that a human must release; `internal` would produce the one instruction on this surface that could be released with nobody having approved anything, which breaks the single sentence the whole design rests on — an integrator can propose money movement and can never cause it. The counter-argument is real and is recorded rather than hidden: internal transfers are arguably the safest thing to automate, both legs are ours, nothing leaves the FBO account, and a mistake is correctable by reversal. Refusing the RAIL rather than special-casing the POLICY is a judgement call, and the policy is where the decision properly belongs. Until the policy says so, the rail is absent.",
    guarantee: "capability-absent",
    enforcedBy: [
      'the rail enum on POST /api/v1/payments is ["ach","usdc","wire"] and additionalProperties is false',
      "a body naming any other rail is refused as INVALID_ARGUMENTS before any database call",
    ],
    instead:
      "Pots and internal moves are console operations. AGENT-LIMITS §15 carries the separate argument about why moving money between a customer's own pots is not the harmless write it looks like — available balance is a control INPUT, and emptying a pot can make a funding check pass that should have failed.",
    sharpens: [15],
  },
  {
    ref: "A6",
    operation: "Backdating a payment, or dating one beyond 90 days",
    absentEndpoints: ["POST /api/v1/payments with a value_date in the past"],
    why:
      "Backdating money OUT is not a correction, it is a claim that a payment already happened — and on a bitemporal ledger that claim lands on a day whose statement may already have been issued. A genuine correction is a reversal plus a re-book, both of them journal entries, both of them made by a person, and neither of them reachable from this surface. The forward bound is the other half of the same rule: past 90 days an instruction is really a mandate, and a mandate is a thing that writes payments. This surface may write a request; it may not write a thing that writes requests, because the per-instruction ceiling on the token is never applied again to the stream a mandate produces.",
    guarantee: "capability-absent",
    enforcedBy: [
      "value_date is compared against book-time today before any write, in src/lib/api/routes/payments.ts",
      "reverseAndRebook and postEntry are forbidden imports",
      "createStandingOrder is a forbidden import; no route exists under src/app/api/v1/standing-orders/**",
    ],
    instead:
      "Send today's date or a future one. GET /api/v1/statements/{date} shows what a corrected day looks like from the outside: a new version, the delta itemised, and both readings side by side.",
    sharpens: [8, 10],
  },
  {
    ref: "A7",
    operation: "Closing a book day, or publishing or reissuing a statement",
    absentEndpoints: [
      "POST /api/v1/statements",
      "POST /api/v1/statements/{date}/publish",
      "POST /api/v1/book-days/{date}/close",
    ],
    why:
      "Closing a day freezes the watermark that every statement for that day is derived from — it is the act that decides what 'as published' will mean forever, and a day closed at the wrong moment silently changes what a customer was told. Publishing is telling a customer what their money did. AGENT-LIMITS §6 refuses the close for the agent surface; this entry extends it to the publish and the reissue, which the agent surface never had endpoints near because it has no statement tool. Both are acts of a named person and both are recorded as such: `book_day.closed_by` and `statement.generated_by` carry an actor id, and an integration's id in that column would be a signature nobody signed.",
    guarantee: "capability-absent",
    enforcedBy: [
      "closeDay, publishStatement and reissueStatement are forbidden imports in src/lib/api/no-write-imports.test.ts",
      "statement and book_day are append-only: corgi_app holds SELECT and INSERT and nothing else",
      "no route under src/app/api/v1/statements/** accepts a method other than GET",
    ],
    instead:
      "GET /api/v1/statements lists the closed days and GET /api/v1/statements/{date} returns both readings with the difference itemised and the published hash re-verified on every call.",
    sharpens: [6],
  },
  {
    ref: "A8",
    operation: "Anything that would let one credential satisfy both halves of a control",
    absentEndpoints: [
      "POST /api/v1/payments/{id}/approve",
      "POST /api/v1/payments/{id}/release",
      "POST /api/v1/payees/{id}/acknowledge",
      "POST /api/v1/kyb/{id}/approve",
    ],
    why:
      "The generalisation of §1, §2, §11 and §16, stated once for this surface because an HTTP API is where somebody eventually asks for a convenience endpoint that collapses two steps. Every control in this build is a SECOND opinion: maker-checker on a payment, a signature on a name-match warning, a human decision on a KYB review. A control that records a second opinion guaranteed to match the first is worse than no control, because it manufactures evidence of review. The approval half of every one of those is unreachable here, and for maker-checker it is not merely unreachable — it is unrepresentable: `CHECK (NOT (kind <> 'human' AND can_approve))` means an approving non-human is not a row Postgres will store, and `assert_maker_checker()` refuses an approval by a non-human, by the initiator, or citing a different content hash. The credential this API authenticates resolves to exactly such an actor, by construction, and src/lib/api/auth.ts refuses a grant that does not.",
    guarantee: "unrepresentable",
    enforcedBy: [
      "CHECK actor_only_humans_approve on actor",
      "assert_maker_checker() — three independent refusals, none of them in TypeScript",
      "payment_instruction_event.pie_one_decision_per_actor",
      "src/lib/api/auth.ts refuses any grant resolving to an actor with can_approve = true or kind <> 'agent'",
      "approvePayment, rejectPayment, cancelPayment, releasePayment, acknowledgeWarning and manualReviewLeg are forbidden imports",
    ],
    instead:
      "POST /api/v1/payments queues the request and GET /api/v1/payments/{id} shows its whole event stream, so an integration can WATCH a human approve and release it. That is the complete loop from the outside, and the missing verb is the point of the design.",
    sharpens: [1, 2, 11, 16],
  },
];

/** Every endpoint path this surface deliberately does not have. */
export function refusedEndpoints(): readonly string[] {
  return API_REFUSALS.flatMap((r) => r.absentEndpoints);
}

/**
 * What this surface cannot answer yet, and why it is reported rather than
 * worked around.
 *
 * `src/lib/ledger/readers.ts` is the boundary and reaching around it is what
 * `boundary.test.ts` ratchets against. Where a question needs a reader nobody
 * has written, the honest answer is to name the reader — not to assemble the
 * query here and become the next module with its own definition of a customer's
 * money.
 */
export interface MissingReader {
  readonly question: string;
  readonly wanted: string;
  readonly whyNotWorkedAround: string;
}

export const MISSING_READERS: readonly MissingReader[] = [
  {
    question: "List every payment instruction belonging to one business.",
    wanted:
      "A business-scoped variant of listQueue() in @/lib/approvals/instructions — the query already joins `account`, so the predicate is one WHERE clause away from where it belongs.",
    whyNotWorkedAround:
      "listQueue() is platform-wide: it feeds an operator screen and is called with an already-scoped session. The obvious workaround — fetch the queue and filter it in TypeScript against this business's account ids — is precisely the pattern mcp/gateway.ts refuses for reconciliation breaks, and for two reasons that both apply here: it is the slower plan, and it makes tenant isolation a STEP rather than a PREDICATE, and a step can be reordered, short-circuited or dropped by whoever next edits the paging logic. On a public API that step is the only thing between one customer and another customer's payments. So POST /api/v1/payments returns an id and GET /api/v1/payments/{id} answers for it, and the list waits for the reader.",
  },
  {
    question: "Several accounts' balances under ONE snapshot.",
    wanted:
      "A reader that takes a set of account ids and returns availability for all of them at one `readSnapshot()` — the plural form of accountAvailability().",
    whyNotWorkedAround:
      "Computing them in a loop takes a fresh snapshot per account, so a list of four accounts is four different instants and any total a caller derives from it was never true. GET /api/v1/accounts therefore answers identity and the KYB gate, and /accounts/{code}/balance answers money, one account and one snapshot at a time.",
  },
  {
    question: "Attach the caller's reason to the instruction a person will approve.",
    wanted:
      "A `reason` parameter on requestPayment(), written to payment_instruction_event.reason — the column already exists and is already NULL for every `requested` event.",
    whyNotWorkedAround:
      "POST /api/v1/payments requires `reason` and it reaches the audit log and nothing else, because requestPayment() takes no such parameter and this surface will not write the event row itself. Documented as a gap rather than quietly dropped: an integrator who believes their reason reaches the approver and finds it did not has been misled by the API, which is worse than being told the field is audit-only.",
  },
];
