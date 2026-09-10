"use server";

/**
 * The card & hold console's write path.
 *
 * ============================================================================
 * WHAT THESE ACTIONS DO AND DO NOT DO
 *
 * They call a PROVIDER. They do not post money.
 *
 * `issueCardAction` creates a real card on Lithic and registers it against a
 * customer's chart of accounts. `simulateAuthorizeAction` and
 * `simulateClearingAction` ask Lithic's SANDBOX SIMULATION endpoints to put an
 * authorisation, and then a clearing, onto that card. Lithic then delivers a
 * `card_transaction.updated` webhook to the deployed endpoint, the inbox stores
 * it, the dispatcher hands it to the Lithic consumer, and
 * `applyCardTransaction()` writes the memo and financial entries through
 * `postEntry()` → `ledger_append()`.
 *
 * Not one statement in this file writes to `journal_entry`, `journal_line`,
 * `hold`, `hold_closure` or `card_auth_event`. `drain()` below is the same
 * function `/api/drain` and the webhook route's `after()` call — running it
 * from here is a nudge on the existing pipeline, not a second one.
 *
 * The one row these actions do write is `card`, through `registerCard()`, which
 * is a binding from a provider token to a customer's 2100/9100 pair. It is
 * idempotent on `(provider, provider_card_token)`.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT
 *
 * Next's own guidance: "the route is reachable to anyone who can send the same
 * POST. Treat every action as an untrusted entry point." Two consequences are
 * honoured throughout:
 *
 *   - Every field is a CLAIM. `businessId` and `cardToken` are references and
 *     nothing else; the card's owner, its account and its memo leaf are re-read
 *     from the database inside the action. A caller who posts a card token
 *     belonging to another customer is refused by the ownership check, not by
 *     the absence of a button.
 *   - Every action requires a resolvable actor, exactly as `/approvals` does.
 *     That is demo identity rather than authentication — see the header of
 *     `src/lib/approvals/session.ts` — but "issue a real card on our Lithic
 *     account" is not something an anonymous POST should be able to do, and an
 *     unauthenticated caller now gets NO_ACTOR rather than a card.
 *
 * ============================================================================
 * THE PAN
 *
 * `POST /v1/simulate/authorize` is keyed by PAN, not by card token. [MEASURED]
 * `GET /v1/cards/{token}` returns `pan` in sandbox. So the PAN is fetched at
 * the instant a simulation needs it, held in a local, and dropped. It is never
 * stored — the `card` table has no column for it — never logged, and never
 * returned to the browser. `last_four` is the only fragment that reaches a
 * screen.
 *
 * ============================================================================
 * SLOW AND FAILED ROUND TRIPS
 *
 * A simulation fires a real webhook into production. The action waits a bounded
 * number of seconds for the effect to appear in the ledger, nudging the drain
 * while it waits, and then STOPS WAITING. It reports `pending` with the
 * transaction token, the inbox row it found and what that row is parked on. It
 * never reports success it has not measured, and it never hangs the request
 * open hoping.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentActor } from "@/lib/approvals/session";
import { availableBalance } from "@/lib/ledger/balances";
import { sql } from "@/lib/ledger/db";
import {
  findAuthorization,
  holdState,
  loadCardEvents,
  memoHoldBalance,
  registerCard,
  resolveCard,
  type HoldState,
} from "@/lib/holds";
import { rootLogger } from "@/lib/log";
import { formatUsd } from "@/lib/format/money";
import {
  createCard,
  getCard,
  simulateAuthorize,
  simulateClearing,
} from "@/lib/rails/lithic/client";
import { drain } from "@/lib/webhooks/drain";

import { centsToProviderAmount, parseUsdAmount } from "@/components/accounts/amount";
import type {
  ActionFact,
  BalanceFacts,
  ConsoleActionResult,
  ConsoleIntent,
} from "@/components/accounts/action-result";

const PROVIDER = "lithic";

/** Spend limit on a console-issued card. Per transaction, so nothing accrues. */
const CARD_SPEND_LIMIT_CENTS = 5_000_00;

/**
 * How long an action waits for a webhook round trip before it says `pending`.
 *
 * Deliberately short. The delivery is usually two or three seconds, and the
 * honest failure of a long wait is a request that dies at the platform's
 * function timeout with nothing to show for it. Whatever has not landed by
 * here is picked up by "Drain and re-read", by the webhook route's own
 * `after()` nudge, or by the 04:17 cron — none of which lose the money,
 * because the inbox row was durable before any of them ran.
 */
const LANDING_BUDGET_MS = 9_000;
const POLL_INTERVAL_MS = 900;

/**
 * A second, shorter wait for the memo book to agree with `H(E)`.
 *
 * `applyCardTransaction()` is two transactions, deliberately: the facts and the
 * closure land first, and the compare-and-append that moves the memo balance
 * lands second. That split is the crash-safety argument, and it means there is
 * a real instant in which the event set says the clearing arrived and the memo
 * book has not yet been told.
 *
 * Reading the balances in that instant produces a TRUE but misleading pair of
 * numbers — a partial clearing looks like it took the money twice, once off the
 * ledger and once off availability, because the hold has not shrunk yet. So the
 * action waits for the fixpoint (`memo balance == H(E)`), and if it does not
 * arrive it says so on the result rather than presenting the mid-flight
 * reading as the outcome.
 */
const CONVERGENCE_BUDGET_MS = 6_000;

/* -------------------------------------------------------------------------- */
/* Result helpers                                                             */
/* -------------------------------------------------------------------------- */

function now(): string {
  return new Date().toISOString();
}

function refuse(
  intent: ConsoleIntent,
  code: string,
  message: string,
  facts: readonly ActionFact[] = [],
): ConsoleActionResult {
  return {
    status: "failed",
    intent,
    code,
    message,
    facts,
    balances: null,
    holdId: null,
    at: now(),
  };
}

async function balanceFacts(businessId: string): Promise<BalanceFacts> {
  const b = await availableBalance(businessId, sql);
  return {
    ledgerCents: b.ledgerCents.toString(),
    holdsCents: b.holdsCents.toString(),
    unclearedCents: b.unclearedCents.toString(),
    availableCents: b.availableCents.toString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Anything the provider client threw, as a sentence.
 *
 * `LithicApiError` carries the body, which is where the useful half of a 400
 * lives ("'merchant_currency' requires that 'merchant_amount' is set"). It is
 * shown, truncated, because an operator staring at a refusal needs the
 * provider's own words and there is no secret in them. The API key is never
 * part of an error body.
 */
function providerMessage(thrown: unknown): string {
  if (thrown instanceof Error) {
    const body = (thrown as { body?: unknown }).body;
    const detail =
      body === undefined ? "" : ` ${JSON.stringify(body)}`.slice(0, 300);
    return `${thrown.message}${detail}`.slice(0, 400);
  }
  return String(thrown).slice(0, 300);
}

/* -------------------------------------------------------------------------- */
/* Shared guards                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in actor, or a refusal.
 *
 * Demo identity, not authentication. It is still a gate: an anonymous POST to
 * this endpoint cannot resolve one, so it cannot create a card on our Lithic
 * account.
 */
async function requireActor(
  intent: ConsoleIntent,
): Promise<{ ok: true; actorId: string } | { ok: false; result: ConsoleActionResult }> {
  const actor = await currentActor();
  if (actor === null) {
    return {
      ok: false,
      result: refuse(
        intent,
        "NO_ACTOR",
        "No actor could be resolved for this session, so there is nobody to attribute this to and nothing was done.",
      ),
    };
  }
  return { ok: true, actorId: actor.id };
}

/** The business exists and has both leaves of the chart. Re-read, never trusted. */
async function requireBusiness(
  businessId: string,
): Promise<{ legalName: string } | null> {
  const [row] = await sql<{ legal_name: string }[]>`
    SELECT b.legal_name
      FROM business b
      JOIN account dep  ON dep.business_id = b.id AND dep.code = '2100'
      JOIN account memo ON memo.business_id = b.id AND memo.code = '9100'
     WHERE b.id = ${businessId}::uuid
     LIMIT 1`;
  return row === undefined ? null : { legalName: row.legal_name };
}

/* -------------------------------------------------------------------------- */
/* 1. Issue a card                                                            */
/* -------------------------------------------------------------------------- */

const issueSchema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
  nickname: z.string().trim().max(60).optional(),
  /**
   * Generated once per render and sent back with the form.
   *
   * `Idempotency-Key` is the one place Lithic documents native idempotency, so
   * a double-submitted form returns the SAME card rather than creating a second
   * one on the account. A key from the client is untrusted, and the worst it
   * can do is hand its sender a card it has already created.
   */
  formKey: z.uuid({ error: "the form did not carry a usable idempotency key" }),
});

/**
 * Create a real card on Lithic and bind it to a customer.
 *
 * ONLY FROM AN EXPLICIT PRESS. There is no code path from rendering this route
 * to this function; it is reachable only by POSTing the form. A page that
 * issued a card on render would put one card per page load on the Lithic
 * account, and the account already carries the scars of automated test runs.
 */
export async function issueCardAction(
  _previous: ConsoleActionResult,
  formData: FormData,
): Promise<ConsoleActionResult> {
  const intent: ConsoleIntent = "issue_card";

  const parsed = issueSchema.safeParse({
    businessId: formData.get("businessId"),
    nickname: formData.get("nickname") ?? undefined,
    formKey: formData.get("formKey"),
  });
  if (!parsed.success) {
    return refuse(
      intent,
      "INVALID_REQUEST",
      "That request could not be read, so no card was created. Reload the console and try again.",
    );
  }

  const gate = await requireActor(intent);
  if (!gate.ok) return gate.result;

  const { businessId, formKey } = parsed.data;
  const nickname = parsed.data.nickname === "" ? undefined : parsed.data.nickname;
  const log = rootLogger.child({ action: "accounts.issueCard", businessId });

  const business = await requireBusiness(businessId);
  if (business === null) {
    return refuse(
      intent,
      "NO_SUCH_BUSINESS",
      "That business does not have both a 2100 deposit account and a 9100 memo account, so a card issued to it would have nowhere to spend from and nowhere to hold. Nothing was created.",
    );
  }

  let card;
  try {
    card = await createCard(
      {
        type: "VIRTUAL",
        memo: `corgi console · ${business.legalName}`.slice(0, 50),
        spend_limit: CARD_SPEND_LIMIT_CENTS,
        spend_limit_duration: "TRANSACTION",
        state: "OPEN",
      },
      { idempotencyKey: formKey },
    );
  } catch (thrown) {
    log.warn("accounts.issueCard.provider_failed", { error: providerMessage(thrown) });
    return refuse(
      intent,
      "PROVIDER_REFUSED",
      `Lithic refused to create the card, so nothing was registered here either: ${providerMessage(thrown)}`,
    );
  }

  try {
    await registerCard(
      {
        provider: PROVIDER,
        providerCardToken: card.token,
        businessId,
        lastFour: card.last_four,
        ...(nickname === undefined ? {} : { nickname }),
      },
      sql,
    );
  } catch (thrown) {
    // The card exists at Lithic and we could not bind it. Say exactly that:
    // an unregistered card is one whose authorisations will PARK rather than
    // post, and an operator needs to know the token to finish the job.
    log.error("accounts.issueCard.register_failed", {
      cardToken: card.token,
      error: providerMessage(thrown),
    });
    return refuse(
      intent,
      "REGISTER_FAILED",
      `Lithic created card ${card.token}, but it could not be bound to this customer, so any authorisation on it will park instead of posting: ${providerMessage(thrown)}`,
      [{ label: "Lithic card token", value: card.token, mono: true }],
    );
  }

  log.info("accounts.issueCard.ok", { cardToken: card.token, lastFour: card.last_four });
  revalidatePath("/accounts");

  return {
    status: "ok",
    intent,
    code: "CARD_ISSUED",
    message: `Card created on Lithic and registered to ${business.legalName}. This is a real card object on a real card program — the token below resolves at GET /v1/cards. Its authorisations will post to this customer's 2100 account and hold against their 9100.`,
    facts: [
      { label: "Lithic card token", value: card.token, mono: true },
      { label: "Last four", value: card.last_four, mono: true },
      { label: "Expires", value: `${card.exp_month}/${card.exp_year}`, mono: true },
      { label: "State", value: card.state },
      { label: "Spend limit", value: "$5,000.00 per transaction" },
    ],
    balances: null,
    holdId: null,
    at: now(),
  };
}

/* -------------------------------------------------------------------------- */
/* 2. Simulate an authorisation                                               */
/* -------------------------------------------------------------------------- */

const authorizeSchema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
  cardToken: z.uuid({ error: "that is not a card token" }),
  amount: z.string().min(1).max(24),
  descriptor: z.string().trim().min(1).max(25),
  mcc: z
    .string()
    .trim()
    .regex(/^\d{4}$/, { error: "an MCC is four digits" }),
});

/** How many facts we hold for a transaction. The baseline a wait measures from. */
async function countEvents(transactionToken: string): Promise<number> {
  const [row] = await sql<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n
      FROM card_auth_event ev
      JOIN card_authorization ca ON ca.id = ev.auth_id
     WHERE ca.provider = ${PROVIDER} AND ca.provider_auth_id = ${transactionToken}`;
  return Number(row?.n ?? 0n);
}

/**
 * What the inbox has to say about a transaction that has not landed.
 *
 * This is the sentence that makes a `pending` state actionable rather than a
 * shrug: whether the delivery arrived at all, whether it was parked, and on
 * what.
 */
async function describeInbox(transactionToken: string): Promise<string> {
  try {
    const [row] = await sql<
      {
        id: string;
        state: string;
        parked_on_kind: string | null;
        parked_reason: string | null;
        received_at: Date;
      }[]
    >`
      SELECT id, state::text AS state, parked_on_kind, parked_reason, received_at
        FROM webhook_inbox
       WHERE provider = ${PROVIDER} AND payload->>'token' = ${transactionToken}
       ORDER BY received_at DESC
       LIMIT 1`;
    if (row === undefined) {
      return "No webhook for this transaction has reached the inbox yet, so there is nothing to drain. Lithic delivers to the deployed endpoint, not to a local server.";
    }
    const parked =
      row.parked_on_kind === null
        ? ""
        : ` parked on ${row.parked_on_kind}${row.parked_reason === null ? "" : ` (${row.parked_reason})`}`;
    return `Inbox row ${row.id} is in state ${row.state}${parked}, received ${row.received_at.toISOString()}.`;
  } catch {
    return "The inbox could not be inspected.";
  }
}

/**
 * Wait for a predicate to become true, nudging the drain between attempts.
 *
 * The drain is the deployed pipeline's own function, so this is the "watch, I
 * will drain it now" of the debrief rather than a shortcut around anything. It
 * is idempotent — the dispatcher claims rows under a lease and every consumer
 * is idempotent — so racing the deployment's own `after()` nudge changes
 * nothing.
 */
async function waitFor<T>(
  probe: () => Promise<T | null>,
  budgetMs: number,
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = await probe();
    if (found !== null) return found;
    if (Date.now() >= deadline) return null;
    try {
      await drain({ maxBatches: 2 });
    } catch {
      // A failed drain is not a failed simulation. The row stays claimed until
      // its lease expires and is picked up again; the wait simply continues.
    }
    if (Date.now() >= deadline) return null;
    await sleep(POLL_INTERVAL_MS);
  }
}

type Landing =
  | {
      /** The facts arrived AND the memo book agrees with H(E). */
      readonly status: "settled";
      readonly holdId: string;
      readonly state: HoldState;
      readonly memoCents: bigint;
    }
  | {
      /** The facts arrived; the compare-and-append has not run yet. */
      readonly status: "posting_pending";
      readonly holdId: string;
      readonly state: HoldState;
      readonly memoCents: bigint;
    }
  /** No new fact reached the ledger inside the budget. */
  | { readonly status: "absent" };

/**
 * Wait for a provider call to become a fact, and then for the memo book to
 * agree with the model about what that fact means.
 *
 * Both halves go through the library rather than through SQL of their own:
 * `loadCardEvents()` reads the set, `holdState()` folds it, and
 * `memoHoldBalance()` asks the journal what it currently says. The screen
 * therefore cannot report a hold size the posting path would disagree with,
 * because it is asking the posting path's own functions.
 */
async function awaitLanding(
  providerAuthId: string,
  baselineEvents: number,
): Promise<Landing> {
  const read = async (): Promise<{
    holdId: string;
    state: HoldState;
    memoCents: bigint;
    eventCount: number;
  } | null> => {
    const identity = await findAuthorization(PROVIDER, providerAuthId, sql);
    if (identity === null) return null;
    const events = await loadCardEvents(identity.authId, sql);
    if (events.length <= baselineEvents) return null;
    const state = holdState(events, { expiresAt: identity.expiresAt, now: new Date() });
    const memoCents = await memoHoldBalance(identity.holdId, identity.memoAccountId, sql);
    return { holdId: identity.holdId, state, memoCents, eventCount: events.length };
  };

  const fact = await waitFor(read, LANDING_BUDGET_MS);
  if (fact === null) return { status: "absent" };

  const converged = await waitFor(
    async () => {
      const now = await read();
      return now !== null && now.memoCents === now.state.holdCents ? now : null;
    },
    CONVERGENCE_BUDGET_MS,
  );

  const final = converged ?? fact;
  return {
    status: converged === null ? "posting_pending" : "settled",
    holdId: final.holdId,
    state: final.state,
    memoCents: final.memoCents,
  };
}

/**
 * Put a real authorisation on a real card through Lithic's sandbox simulator.
 *
 * The money is not real. The card is, the transaction is, and the webhook that
 * comes back is a genuine provider delivery through the deployed endpoint. The
 * screen says all four of those things on the control itself.
 */
export async function simulateAuthorizeAction(
  _previous: ConsoleActionResult,
  formData: FormData,
): Promise<ConsoleActionResult> {
  const intent: ConsoleIntent = "authorize";

  const parsed = authorizeSchema.safeParse({
    businessId: formData.get("businessId"),
    cardToken: formData.get("cardToken"),
    amount: formData.get("amount"),
    descriptor: formData.get("descriptor"),
    mcc: formData.get("mcc"),
  });
  if (!parsed.success) {
    return refuse(
      intent,
      "INVALID_REQUEST",
      `That request could not be read, so nothing was sent to Lithic: ${parsed.error.issues[0]?.message ?? "invalid input"}.`,
    );
  }

  const gate = await requireActor(intent);
  if (!gate.ok) return gate.result;

  const amount = parseUsdAmount(parsed.data.amount);
  if (!amount.ok) return refuse(intent, "INVALID_AMOUNT", amount.message);

  const { businessId, cardToken, descriptor, mcc } = parsed.data;
  const log = rootLogger.child({ action: "accounts.authorize", businessId });

  // The card is a REFERENCE. Its owner is read from the database, and a token
  // that belongs to somebody else is refused here rather than authorised
  // against the business the form claimed.
  const binding = await resolveCard(PROVIDER, cardToken, sql);
  if (binding === null) {
    return refuse(
      intent,
      "UNKNOWN_CARD",
      "That card is not registered here. An authorisation on an unregistered card parks in the inbox rather than posting to anybody's account — which is the correct behaviour, and the reason this is refused before Lithic is called.",
    );
  }
  if (binding.businessId !== businessId) {
    return refuse(
      intent,
      "CARD_NOT_OWNED",
      "That card belongs to a different customer. Nothing was sent to Lithic.",
    );
  }

  let pan: string;
  try {
    const card = await getCard(cardToken);
    if (card.pan === undefined || card.pan === "") {
      return refuse(
        intent,
        "NO_PAN",
        "Lithic returned this card without a PAN, and the simulator is keyed by PAN rather than by token. That is expected outside the sandbox PCI shape; nothing was simulated.",
      );
    }
    pan = card.pan;
  } catch (thrown) {
    return refuse(
      intent,
      "PROVIDER_UNAVAILABLE",
      `The card could not be re-read from Lithic, so no authorisation was attempted: ${providerMessage(thrown)}`,
    );
  }

  // Measured with the card already registered and before anything is
  // simulated, so the only thing between the two readings is this
  // authorisation.
  const before = await balanceFacts(businessId);

  let transactionToken: string;
  try {
    const auth = await simulateAuthorize({
      amount: centsToProviderAmount(amount.cents, "amount"),
      descriptor,
      pan,
      status: "AUTHORIZATION",
      mcc,
    });
    if (auth.token === undefined || auth.token === "") {
      return refuse(
        intent,
        "NO_TRANSACTION_TOKEN",
        "Lithic accepted the simulation but returned no transaction token, so there is nothing to follow. Nothing has been claimed about the ledger.",
      );
    }
    transactionToken = auth.token;
  } catch (thrown) {
    log.warn("accounts.authorize.provider_failed", { error: providerMessage(thrown) });
    return refuse(
      intent,
      "PROVIDER_REFUSED",
      `Lithic refused the simulated authorisation: ${providerMessage(thrown)}`,
    );
  }

  const landing = await awaitLanding(transactionToken, 0);
  revalidatePath("/accounts");

  const providerFacts: ActionFact[] = [
    { label: "Lithic transaction token", value: transactionToken, mono: true },
    { label: "Lithic card token", value: binding.providerCardToken, mono: true },
    { label: "Amount authorised", value: formatUsd(amount.cents), mono: true },
    { label: "Descriptor", value: descriptor },
    { label: "MCC", value: mcc, mono: true },
  ];

  if (landing.status === "absent") {
    const inbox = await describeInbox(transactionToken);
    log.warn("accounts.authorize.pending", { transactionToken });
    return {
      status: "pending",
      intent,
      code: "AWAITING_WEBHOOK",
      message: `Lithic accepted the authorisation and returned transaction ${transactionToken}. The webhook has not yet become a hold in this ledger, so NOTHING is being claimed about the balances. ${inbox} Press "Drain and re-read" to run the pipeline again — the inbox row is durable, so the effect is not lost, only late.`,
      facts: providerFacts,
      balances: null,
      holdId: null,
      at: now(),
    };
  }

  const after = await balanceFacts(businessId);
  log.info("accounts.authorize.ok", {
    transactionToken,
    holdId: landing.holdId,
    settlement: landing.status,
  });

  return {
    status: landing.status === "settled" ? "ok" : "pending",
    intent,
    code: landing.status === "settled" ? "AUTHORISED" : "POSTING_PENDING",
    message:
      landing.status === "settled"
        ? "Simulated at Lithic, delivered as a real webhook, posted by the existing pipeline. The available balance fell by the authorised amount and the ledger balance did not move a cent — an authorisation is a memo posting, and there is no code path from one to a financial entry."
        : `The authorisation is in the ledger and H(E) is ${formatUsd(landing.state.holdCents)}, but the memo posting that moves the hold to that figure has not landed yet — the memo book still reads ${formatUsd(landing.memoCents)}. The figures below were taken mid-flight and are not the settled answer. Press "Drain and re-read": the compare-and-append is idempotent and lands on the next event or the expiry sweep, so nothing is lost.`,
    facts: providerFacts,
    balances: { before, after },
    holdId: landing.holdId,
    at: now(),
  };
}

/* -------------------------------------------------------------------------- */
/* 3. Simulate a clearing                                                     */
/* -------------------------------------------------------------------------- */

const clearingSchema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
  transactionToken: z.uuid({ error: "that is not a Lithic transaction token" }),
  /** Blank clears the full authorised amount — Lithic's own default. */
  amount: z.string().max(24).optional(),
});

/**
 * Clear an outstanding authorisation, in whole or in part.
 *
 * A clearing is where the money actually moves: the customer's 2100 is debited
 * and 2200 (what we owe the network) is credited, and the hold falls to
 * `max(A − C, 0)`. Over-capture is allowed through deliberately — clearing more
 * than was authorised is what a fuel pump does, and the screen exists to show
 * what that does to an available balance.
 */
export async function simulateClearingAction(
  _previous: ConsoleActionResult,
  formData: FormData,
): Promise<ConsoleActionResult> {
  const intent: ConsoleIntent = "clearing";

  const parsed = clearingSchema.safeParse({
    businessId: formData.get("businessId"),
    transactionToken: formData.get("transactionToken"),
    amount: formData.get("amount") ?? undefined,
  });
  if (!parsed.success) {
    return refuse(
      intent,
      "INVALID_REQUEST",
      `That request could not be read, so nothing was sent to Lithic: ${parsed.error.issues[0]?.message ?? "invalid input"}.`,
    );
  }

  const gate = await requireActor(intent);
  if (!gate.ok) return gate.result;

  const { businessId, transactionToken } = parsed.data;
  const raw = (parsed.data.amount ?? "").trim();

  let amountCents: bigint | null = null;
  if (raw !== "") {
    const parsedAmount = parseUsdAmount(raw);
    if (!parsedAmount.ok) return refuse(intent, "INVALID_AMOUNT", parsedAmount.message);
    amountCents = parsedAmount.cents;
  }

  const log = rootLogger.child({ action: "accounts.clearing", transactionToken });

  // The authorisation is a reference too: it must already exist in this ledger
  // and belong to the business the form named.
  const [owner] = await sql<{ hold_id: string; business_id: string }[]>`
    SELECT ca.hold_id, a.business_id
      FROM card_authorization ca
      JOIN account a ON a.id = ca.account_id
     WHERE ca.provider = ${PROVIDER} AND ca.provider_auth_id = ${transactionToken}`;

  if (owner === undefined) {
    return refuse(
      intent,
      "UNKNOWN_AUTHORISATION",
      "This ledger has no authorisation with that transaction token, so there is nothing here for a clearing to settle against. Nothing was sent to Lithic.",
    );
  }
  if (owner.business_id !== businessId) {
    return refuse(
      intent,
      "AUTH_NOT_OWNED",
      "That authorisation belongs to a different customer. Nothing was sent to Lithic.",
    );
  }

  const baseline = await countEvents(transactionToken);
  const before = await balanceFacts(businessId);

  try {
    await simulateClearing({
      token: transactionToken,
      ...(amountCents === null
        ? {}
        : { amountCents: centsToProviderAmount(amountCents, "amountCents") }),
    });
  } catch (thrown) {
    log.warn("accounts.clearing.provider_failed", { error: providerMessage(thrown) });
    return refuse(
      intent,
      "PROVIDER_REFUSED",
      `Lithic refused the simulated clearing: ${providerMessage(thrown)}`,
    );
  }

  // [MEASURED] The clearing response carries no token — a clearing is an event
  // on the existing transaction, not a new object. So the thing to wait for is
  // a new member of E, not a new id, and then for the memo book to agree with
  // what the enlarged set means.
  const landing = await awaitLanding(transactionToken, baseline);

  revalidatePath("/accounts");

  const facts: ActionFact[] = [
    { label: "Lithic transaction token", value: transactionToken, mono: true },
    {
      label: "Amount cleared",
      value:
        amountCents === null ? "full authorised amount" : formatUsd(amountCents),
      mono: amountCents !== null,
    },
  ];

  if (landing.status === "absent") {
    const inbox = await describeInbox(transactionToken);
    log.warn("accounts.clearing.pending", { transactionToken });
    return {
      status: "pending",
      intent,
      code: "AWAITING_WEBHOOK",
      message: `Lithic accepted the clearing. Its webhook has not yet added a fact to this authorisation's event set, so NOTHING is being claimed about the balances. ${inbox} The inbox row is durable — press "Drain and re-read".`,
      facts,
      balances: null,
      holdId: owner.hold_id,
      at: now(),
    };
  }

  const after = await balanceFacts(businessId);
  log.info("accounts.clearing.ok", {
    transactionToken,
    settlement: landing.status,
    holdCents: landing.state.holdCents.toString(),
  });

  const settledFacts: ActionFact[] = [
    ...facts,
    { label: "A(E) after", value: formatUsd(landing.state.authorisedCents), mono: true },
    { label: "C(E) after", value: formatUsd(landing.state.capturedCents), mono: true },
    { label: "H(E) after", value: formatUsd(landing.state.holdCents), mono: true },
  ];

  return {
    status: landing.status === "settled" ? "ok" : "pending",
    intent,
    code: landing.status === "settled" ? "CLEARED" : "POSTING_PENDING",
    message:
      landing.status === "settled"
        ? "The clearing landed. This is the half of the lifecycle that moves real ledger money: the customer's deposit account is debited and 2200 — what we owe the network — is credited, while the hold falls to max(A − C, 0). A partial clearing takes the same amount off both sides at once, so the ledger drops and the available balance does not; the money was already withheld."
        : `The clearing is in the event set and H(E) is now ${formatUsd(landing.state.holdCents)}, but the memo posting that shrinks the hold to that figure has not landed yet — the memo book still reads ${formatUsd(landing.memoCents)}. The figures below were taken mid-flight, so availability is understated: it is still withholding money the clearing has already taken off the ledger. Press "Drain and re-read". Nothing is lost; the compare-and-append is idempotent and posts the difference exactly once.`,
    facts: settledFacts,
    balances: { before, after },
    holdId: owner.hold_id,
    at: now(),
  };
}

/* -------------------------------------------------------------------------- */
/* 4. Drain and re-read                                                       */
/* -------------------------------------------------------------------------- */

const drainSchema = z.object({
  businessId: z.uuid({ error: "that is not a business id" }),
});

/**
 * Run the webhook pipeline now, and re-read the balances.
 *
 * The same `drain()` the cron and `/api/drain` call. It is what turns a stored
 * delivery into money, it is idempotent at three unique indexes, and it exists
 * as a button because "watch, I will drain it now" beats waiting for a timer in
 * front of an audience.
 */
export async function drainAction(
  _previous: ConsoleActionResult,
  formData: FormData,
): Promise<ConsoleActionResult> {
  const intent: ConsoleIntent = "drain";

  const parsed = drainSchema.safeParse({ businessId: formData.get("businessId") });
  if (!parsed.success) {
    return refuse(intent, "INVALID_REQUEST", "That request could not be read.");
  }

  const gate = await requireActor(intent);
  if (!gate.ok) return gate.result;

  const { businessId } = parsed.data;
  const before = await balanceFacts(businessId);

  let summary;
  try {
    summary = await drain();
  } catch (thrown) {
    return refuse(
      intent,
      "DRAIN_FAILED",
      `The drain failed: ${providerMessage(thrown)}. Nothing is lost — claimed rows are released when their lease expires and are picked up again.`,
    );
  }

  const after = await balanceFacts(businessId);
  revalidatePath("/accounts");

  const facts: ActionFact[] = [
    { label: "Claimed", value: String(summary.claimed), mono: true },
    { label: "Processed", value: String(summary.processed), mono: true },
    { label: "Ignored", value: String(summary.ignored), mono: true },
    { label: "Parked", value: String(summary.parked), mono: true },
    { label: "Unparked", value: String(summary.unparked), mono: true },
    { label: "Dead-lettered", value: String(summary.deadLettered), mono: true },
    {
      label: "Consumers",
      value: summary.consumers.length === 0 ? "none registered" : summary.consumers.join(", "),
    },
    { label: "Took", value: `${summary.durationMs} ms`, mono: true },
  ];

  return {
    status: "ok",
    intent,
    code: "DRAINED",
    message:
      summary.missingConsumers.length > 0
        ? `The drain ran with a consumer missing (${summary.missingConsumers.join("; ")}), which means card deliveries were not processed. That is reported rather than hidden: a drain with no consumer registered processes nothing and otherwise looks exactly like a healthy quiet system.`
        : "The webhook inbox was drained through the same path the cron uses. Every layer of it is idempotent, so running it again on the same rows posts nothing.",
    facts,
    balances: { before, after },
    holdId: null,
    at: now(),
  };
}
