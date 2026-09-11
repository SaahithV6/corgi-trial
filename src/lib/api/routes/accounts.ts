/**
 * `GET /api/v1/accounts`, `/accounts/{code}` and `/accounts/{code}/balance`.
 *
 * ===========================================================================
 * WHY THE LIST CARRIES NO BALANCES
 * ===========================================================================
 *
 * The obvious design embeds a balance beside each account, and it is wrong
 * here for a reason this repo has already paid for once.
 *
 * A balance in this system is a point on TWO axes — a value date and a booking
 * watermark — and `balanceNow()` takes ONE snapshot (`clock_timestamp()`,
 * today's business day, the highest booking sequence) and evaluates every term
 * against it. Computing a balance per account in a loop takes a fresh snapshot
 * per account, so a list of four accounts is four different instants, and a
 * customer reading the page sums them into a total that was never true. The
 * ledger's own `home/summary.ts` hit exactly this and its fix was to put both
 * halves inside one `REPEATABLE READ` transaction rather than to paper over
 * the race.
 *
 * There is no scoped reader that returns several accounts' availability under
 * one snapshot, so rather than invent one here — which would be this surface
 * defining a balance, the thing `mcp/gateway.ts` spent a migration undoing —
 * the list answers identity and the gate, and `/balance` answers money, one
 * account at a time, one snapshot each. The gap is reported in docs/API.md
 * §What the ledger cannot answer yet.
 *
 * ===========================================================================
 * WHAT `can_transact` IS FOR
 * ===========================================================================
 *
 * "Businesses pass a check before the account opens" is a brief requirement,
 * and the way an integrator meets it badly is by discovering the gate for the
 * first time as a 422 on a payment. `can_transact` is the same predicate
 * (`canTransact()` in `@/lib/kyb`, the one every money path calls) reported
 * ahead of time, with the denial code and the message attached, so "why can I
 * read this account but not pay from it" is answerable before a payment is
 * attempted rather than after.
 *
 * It is a READ of the gate. Nothing here starts, advances or decides a KYB
 * case — see docs/API.md §Refused operations.
 */

import { transactGateForAccount } from "@/lib/kyb/wire";
import { ledgerConnection, listAccounts } from "@/lib/ledger/queries";

import { notFound } from "../errors";
import { dateParam, instantParam, money, page, rejectUnknownParams } from "../http";
import type { ApiContext, RouteResult } from "../handle";

/**
 * A chart code, and never an account uuid.
 *
 * Four digits for a leaf of the chart proper (`2100`, `9100`), optionally
 * followed by `.<uuid>` for a pot, which is how `@/lib/pots` names the
 * sub-leaves it opens under the deposit account. Accepting only four digits —
 * which this route did until a live chart was walked and three pot leaves came
 * back — would have 404'd accounts that the very same endpoint had just listed,
 * with links pointing at them.
 *
 * An account UUID is still refused: it is not a name a customer has, and
 * accepting one would make the address space guessable in a way chart codes
 * are not.
 */
const ACCOUNT_CODE =
  /^[0-9]{4}(\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

const DEFAULT_ACCOUNT_CODE = "2100";

/** Hard ceiling on the chart this endpoint will walk for one business. */
const MAX_ACCOUNTS = 100;

interface AccountResource {
  readonly object: "account";
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly book: "financial" | "memo";
  readonly type: string;
  /** True when a journal line may name this account directly. */
  readonly postable: boolean;
  /** Readable through this API. Every account of the business is. */
  readonly readable: boolean;
  /** True when POST /api/v1/payments will accept it as the debit account. */
  readonly payable: boolean;
  readonly payable_note: string | null;
  readonly opened_at: string;
  readonly links: { readonly balance: string | null };
}

/**
 * A POT IS READABLE AND IS NOT PAYABLE, AND THAT IS A DECISION.
 *
 * A pot is a real leaf of the customer's own subtree — `2100.<uuid>` — on the
 * financial book and postable, so by the ledger's rules it could fund a
 * payment. This API will not let it, and the argument is AGENT-LIMITS §15's:
 * available balance is a control INPUT, and money in a pot is not in the main
 * account's available balance. An integration that can debit the payroll pot
 * directly has moved money out of the balance every other funding decision is
 * judged against, without moving anything the pots screen would show as a
 * transfer — the pot simply has less in it, and tomorrow's standing order will
 * be refused with a shortfall that names no cause.
 *
 * Reading one is a different act entirely and is allowed: "you have $X in the
 * main account and $Y earmarked for payroll" is an answer the surface should
 * be able to give, and giving it is what stops an integration reporting a
 * balance that is understated.
 */
const MAIN_LEAF = /^[0-9]{4}$/;

function toResource(account: {
  readonly code: string;
  readonly name: string;
  readonly currency: string;
  readonly book: "financial" | "memo";
  readonly type: string;
  readonly isPostable: boolean;
  readonly openedAt: Date;
}): AccountResource {
  const financial = account.isPostable && account.book === "financial";
  const isPot = !MAIN_LEAF.test(account.code);
  const payable = financial && !isPot;
  return {
    object: "account",
    code: account.code,
    name: account.name,
    currency: account.currency,
    book: account.book,
    type: account.type,
    postable: account.isPostable,
    readable: true,
    payable,
    payable_note: payable
      ? null
      : isPot
        ? "A pot is readable but not payable through this API. Debiting one directly would move money out of the balance every other funding decision is judged against, with nothing on the pots screen to show for it. Move funds between pots in the console, then pay from 2100."
        : "Memo-book accounts carry holds, not money. They have no balance endpoint and cannot fund a payment.",
    opened_at: account.openedAt.toISOString(),
    links: {
      // Every account of the business is readable, pots included. Only the
      // memo book has nothing a balance endpoint could say.
      balance: financial ? `/api/v1/accounts/${account.code}/balance` : null,
    },
  };
}

/**
 * The KYB gate for this business, read once per request.
 *
 * Keyed on the deposit account because that is what `transactGateForAccount`
 * takes and what `requestPayment()` will consult inside its own transaction.
 * Reading it here and reading it there can disagree by however long the caller
 * waits — which is why this is reported as information and the binding check
 * stays where the write is.
 */
async function readGate(
  accountId: string,
  conn: Awaited<ReturnType<typeof ledgerConnection>>,
): Promise<{
  readonly can_transact: boolean;
  readonly status: string | null;
  readonly evidence: string | null;
  readonly denial_code: string | null;
  readonly message: string | null;
}> {
  const decision = await transactGateForAccount(accountId, { conn });
  if (decision.allowed) {
    return {
      can_transact: true,
      status: decision.status,
      evidence: decision.evidence,
      denial_code: null,
      message: null,
    };
  }
  return {
    can_transact: false,
    status: decision.status,
    evidence: decision.evidence,
    denial_code: decision.code,
    message: decision.message,
  };
}

export async function listAccountsRoute(ctx: ApiContext): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ["limit"]);

  const conn = await ledgerConnection();
  // `businessId` comes from the GRANT. There is no query parameter that could
  // point this lookup at another tenant's chart, and `FORBIDDEN_QUERY_PARAMETERS`
  // is asserted over every route file so that there never will be.
  const accounts = await listAccounts(
    {
      businessId: ctx.grant.businessId,
      includeClosed: false,
      orderBy: "code",
      limit: MAX_ACCOUNTS,
    },
    conn,
  );

  // The gate is a property of the BUSINESS, not of a leaf, so it is read once
  // against the account the money would leave and reported on the envelope
  // rather than repeated on every row.
  const deposit = accounts.find(
    (a) => a.code === DEFAULT_ACCOUNT_CODE && a.book === "financial",
  );
  const gate =
    deposit === undefined
      ? {
          can_transact: false,
          status: null,
          evidence: null,
          denial_code: "NO_DEPOSIT_ACCOUNT",
          message:
            "This business has no open deposit account, so there is nowhere for money to land. An account is opened by a person, behind the KYB check, in the console.",
        }
      : await readGate(deposit.accountId, conn);

  const body = {
    ...page(accounts.map(toResource), MAX_ACCOUNTS, null),
    business: {
      id: ctx.grant.businessId,
      legal_name: ctx.grant.businessLegalName,
    },
    gate,
    request_id: ctx.requestId,
  };

  return { status: 200, body, audit: { accounts: accounts.length } };
}

export async function getAccountRoute(ctx: ApiContext, code: string): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, []);

  // Resolved through the gateway FIRST, so that an unknown or out-of-tenant
  // code produces the 404 before any second query runs. The identity read
  // below repeats `businessId` rather than trusting the first lookup to have
  // scoped it — the same belt-and-braces `gateway.ts`'s `snapshot()` applies,
  // and for the same reason: a boundary that depends on an earlier query
  // having been correct is not a boundary.
  const ref = await findOr404(ctx, code);
  const conn = await ledgerConnection();
  const identities = await listAccounts(
    { businessId: ctx.grant.businessId, code: ref.code, includeClosed: false, limit: 1 },
    conn,
  );
  const identity = identities[0];
  if (identity === undefined) {
    throw notFound(
      "ACCOUNT_NOT_FOUND",
      `${ctx.grant.businessLegalName} has no open account with code ${ref.code}`,
      "the chart code names an open account belonging to this token's business",
      "GET /api/v1/accounts lists every code this token can name.",
      { account_code: ref.code },
    );
  }

  const gate =
    identity.isPostable && identity.book === "financial"
      ? await readGate(identity.accountId, conn)
      : null;

  return {
    status: 200,
    body: {
      ...toResource(identity),
      business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
      gate,
      request_id: ctx.requestId,
    },
    audit: { account_code: identity.code },
  };
}

/**
 * `GET /api/v1/accounts/{code}/balance` — ledger, available, and the
 * difference itemised.
 *
 * THE DIFFERENCE IS NEVER A SINGLE NUMBER. "Available is $412.60 less than
 * ledger" is not actionable; "two card authorisations totalling $362.60, one
 * uncleared ACH credit of $50.00" is an answer a support agent can read out.
 * Each term is a SUM over immutable rows at query time — there is no
 * `available_balance` column in this schema to drift.
 *
 * The two as-of parameters are the bitemporal query exposed, and they are
 * independent:
 *
 *   as_of_value_date   valid time      — what does the ledger say about Tuesday
 *   as_of_booking_time transaction time — what did we BELIEVE on Wednesday
 *
 * Both answerable at once is the published live-fire question: a merchant
 * reverses Tuesday's settlement on Thursday; show Tuesday now, and prove what
 * you believed on Wednesday. An integrator who can only ask the first will
 * confidently tell a customer the corrected figure was always there.
 */
export async function getBalanceRoute(ctx: ApiContext, code: string): Promise<RouteResult> {
  rejectUnknownParams(ctx.url, ["as_of_value_date", "as_of_booking_time"]);

  const account = await findOr404(ctx, code);
  const asOfValueDate = dateParam(ctx.url, "as_of_value_date");
  const bookingTime = instantParam(ctx.url, "as_of_booking_time");

  const watermark =
    bookingTime === null ? null : await ctx.gateway.bookingWatermarkAt(bookingTime);

  const basis: "current" | "as_of_value_date" | "as_believed" =
    bookingTime !== null ? "as_believed" : asOfValueDate !== null ? "as_of_value_date" : "current";

  // A transaction-time cut with no valid-time cut still needs a day to report
  // on. Book-time today is the only defensible default and it is NAMED in the
  // response, so a caller is never guessing which day it got.
  const valueDate = asOfValueDate ?? ctx.bookToday;

  const snapshot =
    basis === "current"
      ? await ctx.gateway.balanceNow(ctx.grant.businessId, account.accountId)
      : await ctx.gateway.balanceAsOf(
          ctx.grant.businessId,
          account.accountId,
          valueDate,
          watermark,
        );

  const components = [
    {
      kind: "card_auth_holds" as const,
      count: snapshot.cardHoldCount,
      amount: money(-snapshot.cardAuthHoldsCents),
      explanation:
        "Card authorisations still open. The merchant holds the customer's promise; the money has not left the ledger and cannot be spent twice.",
    },
    {
      kind: "operator_holds" as const,
      count: null,
      amount: money(-snapshot.otherHoldsCents),
      explanation:
        "Holds a person placed deliberately — a compliance review, a disputed credit, a fraud freeze. The reason is usually not in this system; surface the amount and refer the customer to a person rather than guess.",
    },
    {
      kind: "uncleared_credits" as const,
      count: snapshot.unclearedHoldCount,
      amount: money(-snapshot.unclearedCents),
      explanation:
        "Inbound credits booked but not released under the funds-availability policy. An ACH credit is returnable for days after it lands.",
    },
    {
      kind: "pending_outbound" as const,
      count: null,
      amount: money(-snapshot.pendingOutboundCents),
      explanation:
        "Debits already booked with a future value date: money committed to leave. Still inside the ledger balance and not spendable. Derived from journal lines, so it has no hold row and no count.",
    },
  ].filter((item) => item.amount.cents !== "0" || item.kind === "card_auth_holds");

  return {
    status: 200,
    body: {
      object: "balance",
      business: { id: ctx.grant.businessId, legal_name: ctx.grant.businessLegalName },
      account: {
        code: account.code,
        name: account.name,
        currency: account.currency,
        book: account.book,
      },
      as_of: {
        basis,
        value_date: basis === "current" ? null : valueDate,
        booking_time: bookingTime === null ? null : bookingTime.toISOString(),
        booking_watermark: watermark === null ? null : watermark.toString(),
      },
      ledger_balance: money(snapshot.ledgerCents),
      available_balance: money(snapshot.availableCents),
      difference: {
        total: money(snapshot.availableCents - snapshot.ledgerCents),
        components,
      },
      formula:
        "available = ledger − active holds (card authorisations AND operator holds) − uncleared credits − debits already booked to leave on a future value date. Every term is a SUM over immutable rows at query time; no balance is stored in this schema. This is ledger_availability() in Postgres — the same function the customer's own screens use, so this figure can never be more permissive than what the customer is shown.",
      request_id: ctx.requestId,
    },
    audit: { account_code: account.code, basis },
  };
}

/**
 * Resolve a chart code inside this token's business, or 404.
 *
 * `findAccount` on the gateway filters on `business_id = $1` and NOT on
 * `business_id = $1 OR business_id IS NULL`, so `1110` — the FBO cash account,
 * which is every customer's money pooled — is simply not addressable through
 * this surface. Another business's code and a code that does not exist produce
 * the same 404, deliberately: a distinguishable answer is an enumeration
 * oracle.
 */
async function findOr404(ctx: ApiContext, code: string) {
  const trimmed = code.trim();
  if (!ACCOUNT_CODE.test(trimmed)) {
    throw notFound(
      "ACCOUNT_NOT_FOUND",
      `"${trimmed}" is not a chart-of-accounts code`,
      "the path segment is a chart code belonging to this token's business",
      "Accounts are addressed by chart code: four digits for a leaf of the chart (/api/v1/accounts/2100/balance), or 2100.<pot-uuid> for a pot. Account uuids on their own are not accepted, and house accounts — the pooled FBO cash account and the rail control accounts — are not addressable at all. GET /api/v1/accounts lists every code this token can name.",
      { received: trimmed.slice(0, 32) },
    );
  }

  const account = await ctx.gateway.findAccount(ctx.grant.businessId, trimmed);
  if (account === null) {
    throw notFound(
      "ACCOUNT_NOT_FOUND",
      `${ctx.grant.businessLegalName} has no open account with code ${trimmed}`,
      "the chart code names an open account belonging to this token's business",
      "GET /api/v1/accounts lists every code this token can name. The answer is the same for a code that does not exist and a code that belongs to another business — telling them apart would let a caller enumerate the chart.",
      { account_code: trimmed },
    );
  }
  return account;
}

/** The chart code every endpoint defaults to. Echoed by `GET /api/v1`. */
export const BUSINESS_CURRENT_ACCOUNT_CODE = DEFAULT_ACCOUNT_CODE;
