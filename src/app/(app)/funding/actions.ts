"use server";

/**
 * The funding screen's write path.
 *
 * ============================================================================
 * WHAT THIS ACTION DOES, AND — because this one really does move the balance —
 * WHAT IT DOES NOT.
 *
 * IT DOES:
 *   - make five REAL HTTP calls to `sandbox.plaid.com`, with this deployment's
 *     `PLAID_CLIENT_ID` / `PLAID_SECRET`, and link a REAL Plaid Item at a real
 *     institution, returning that account's real ACH routing and account
 *     numbers;
 *   - post ONE financial journal entry and ONE memo journal entry through
 *     `postEntry()`, in one transaction, in `bigint` cents, double-entry, to
 *     the live database.
 *
 * IT DOES NOT:
 *   - transmit an ACH entry to any network. `POST /ach_transfers` is not called
 *     from this path, and the numbers Plaid returned are not registered with an
 *     originator. The deposit is booked at ORIGINATION — the moment the pull is
 *     instructed — which is what account 1130 exists for, and is how a bank
 *     books a debit at file-cut, before the file goes out. The receipt says so,
 *     the journal entry's own description says so, and `docs/FUNDING.md` says
 *     so.
 *   - make the money spendable. That is the point of the whole screen: the
 *     deposit raises the ledger balance and withholds the identical amount from
 *     available through an `uncleared_credit` hold, until the banking day and
 *     the 09:00 New York instant that `funds_availability_policy` names.
 *
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT. Everything in the `FormData` is a
 * claim and every claim is re-validated here:
 *
 *   accountId   a REFERENCE. Resolved against `account` by
 *               `findDepositAccount()`, which returns null rather than reaching
 *               Postgres with a non-uuid. A caller who invents one gets a
 *               refusal, not a 500.
 *   amount      parsed from a decimal string to `bigint` cents HERE, by integer
 *               string arithmetic. There is no `parseFloat` and no `* 100` on
 *               this path. See `parseUsdToCents`.
 *   class       must be one of the three `counterparty_class` values the seeded
 *               policy table actually has rows for. An unknown class does not
 *               fall back to "release immediately" — it is refused, and so is a
 *               known class with no policy row covering the value date. A
 *               credit whose availability nobody has decided is not one this
 *               system makes spendable by default.
 *
 * The identity is NOT taken from the form: the posting actor is the
 * `ledger-poster` system actor, resolved by name inside the adapter.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formatUsd } from "@/lib/format/money";
import { transactGateForAccount, transactGateForBusiness } from "@/lib/kyb/wire";
import { sql } from "@/lib/ledger/db";
import { findDepositAccount } from "@/lib/ledger/queries";
import { rootLogger } from "@/lib/log";
import {
  alreadyFundedReference,
  FundingRefused,
  fundFromLinkedAccount,
  linkExternalAccount,
  plaidWebhookUrl,
  probeItemLoginRequired,
  probeLinkTimeFailure,
  SANDBOX_INSTITUTION_ID,
  type CounterpartyClass,
  type ItemErrorProbe,
  type PlaidCall,
} from "@/lib/rails/plaid/adapter";
import { describeSchedule } from "@/lib/rails/plaid/availability";
import { PlaidClient } from "@/lib/rails/plaid/client";
import { plaidErrorBody, PLAID_ITEM_ERROR_COPY } from "@/lib/rails/plaid/types";

import { readBalanceCents, type BalanceCents } from "./live-source";

/* -------------------------------------------------------------------------- */
/* What the form gets back                                                    */
/* -------------------------------------------------------------------------- */

/** One field-level complaint from zod, flattened. Never contains a row value. */
export type FieldIssue = {
  readonly path: string;
  readonly message: string;
};

/** One HTTP call to Plaid, as the screen prints it. */
export type CallView = {
  readonly endpoint: string;
  readonly status: number;
  readonly requestId: string | null;
  readonly ms: number;
  readonly ok: boolean;
  readonly errorCode: string | null;
};

/**
 * The four balances, before and after, already formatted.
 *
 * The pair is the receipt's entire argument: `ledger` moves by the deposit and
 * `available` does not move at all. Both are read from `availableBalance()`,
 * which is a SUM over immutable rows — there is no stored balance in this
 * schema for the two reads to disagree about.
 */
export type BalanceSnapshotView = {
  readonly ledgerDisplay: string;
  readonly availableDisplay: string;
  readonly cardHoldsDisplay: string;
  readonly unclearedDisplay: string;
};

export type FundingReceiptView = {
  /** Every Plaid call made, in order, with its status code and request id. */
  readonly calls: readonly CallView[];
  readonly itemId: string;
  readonly institutionName: string | null;
  readonly institutionId: string | null;
  readonly plaidAccountId: string;
  readonly plaidAccountName: string;
  readonly plaidAccountMask: string | null;
  readonly plaidAccountSubtype: string | null;
  /** Public bank routing data. Safe to print; the account number never is. */
  readonly routingNumber: string;
  readonly authMethod: string | null;
  /** Plaid's own balance figure, as a string, never converted to money. */
  readonly plaidBalanceDisplay: string | null;
  /** A REAL `link-sandbox-…` token, minted and shown and deliberately unused. */
  readonly linkToken: string | null;
  readonly linkTokenExpiresAt: string | null;

  readonly amountDisplay: string;
  readonly valueDate: string;
  readonly externalRef: string;

  readonly entryId: string;
  readonly memoEntryId: string;
  readonly holdId: string;

  readonly policyId: string;
  readonly policyRail: string;
  readonly counterpartyClass: string;
  readonly bankingDaysHold: number;
  readonly releaseLocalTime: string;
  readonly releaseDate: string;
  readonly availableAt: string;
  readonly calendarDaysHeld: number;
  readonly scheduleSentence: string;
  readonly skipped: readonly { readonly date: string; readonly reason: string }[];

  readonly before: BalanceSnapshotView;
  readonly after: BalanceSnapshotView;
  /** False when this reference had already funded — nothing new was written. */
  readonly created: boolean;
};

export type FundResult = {
  readonly status: "idle" | "ok" | "refused";
  /** The refusal code verbatim, or `FUNDED` on success. */
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly FieldIssue[] | null;
  readonly receipt: FundingReceiptView | null;
  /** Calls made before the failure, so a refusal still shows what was attempted. */
  readonly calls: readonly CallView[] | null;
};

/*
 * NOTE: the idle values for both actions live in the CLIENT components that
 * hold them (`FundForm.tsx`, `ItemErrorsPanel.tsx`), not here. A `"use server"`
 * module may only export async functions — every other export becomes a
 * callable server endpoint, and a `const` cannot be one. The build refuses it,
 * correctly.
 */

/* -------------------------------------------------------------------------- */
/* Money in, from a text field                                                */
/* -------------------------------------------------------------------------- */

/**
 * `"2,500.00"` -> `250000n`. The ONLY place a typed amount becomes money here.
 *
 * Integer string arithmetic, on purpose and without apology: there is no
 * `parseFloat`, no `Number(...)`, no `* 100`. `Number("0.1") * 100` is
 * `10.000000000000002`, and a funding desk that rounds that has just invented a
 * cent. The whole part and the fractional part are separated as TEXT, padded as
 * TEXT, and each converted straight to `bigint`.
 *
 * Returns `null` for anything that is not a plain USD amount — a negative sign,
 * three decimal places, an exponent, a currency symbol, an empty string. The
 * caller renders that as a refusal rather than guessing what was meant.
 *
 * Not exported: a `"use server"` module may only export async functions, and
 * this one has no business being reachable from a browser anyway.
 */
function parseUsdToCents(raw: string): bigint | null {
  const cleaned = raw.trim().replaceAll(",", "").replace(/^\$/, "");
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/.test(cleaned)) return null;

  const dot = cleaned.indexOf(".");
  const whole = dot === -1 ? cleaned : cleaned.slice(0, dot);
  const fraction = dot === -1 ? "" : cleaned.slice(dot + 1);

  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
}

/* -------------------------------------------------------------------------- */
/* The form's shape                                                           */
/* -------------------------------------------------------------------------- */

const COUNTERPARTY_CLASSES = ["self", "known", "new"] as const;

/** Depository subtypes the sandbox Item actually returns ACH numbers for. */
const PREFERRED_SUBTYPES = ["checking", "savings", "cash management"] as const;

const formSchema = z.object({
  accountId: z.string().trim().min(1, { error: "choose the account the money lands in" }),
  amount: z.string().trim().min(1, { error: "enter an amount" }),
  valueDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, {
    error: "a value date is a calendar date, YYYY-MM-DD",
  }),
  counterpartyClass: z.enum(COUNTERPARTY_CLASSES, {
    error: "choose how well this payer is known",
  }),
  preferredSubtype: z.enum(PREFERRED_SUBTYPES, { error: "choose an account type" }),
  /**
   * The SOURCE FACT. Every idempotency key on this path is derived from it, so
   * submitting the same reference twice books ONE deposit and opens ONE hold —
   * decided by three unique indexes, not by an `if`.
   */
  reference: z
    .string()
    .trim()
    .min(3, { error: "reference the funding run this pays for" })
    .max(120)
    .regex(/^[A-Za-z0-9._/#-]+$/, {
      error: "letters, digits and . _ / # - only, and no spaces or colons",
    }),
});

function toCallViews(calls: readonly PlaidCall[]): readonly CallView[] {
  return calls.map((call) => ({
    endpoint: call.endpoint,
    status: call.status,
    requestId: call.requestId,
    ms: call.ms,
    ok: call.ok,
    errorCode: call.errorCode,
  }));
}

function refused(
  code: string,
  message: string,
  extra: { issues?: readonly FieldIssue[]; calls?: readonly CallView[] } = {},
): FundResult {
  return {
    status: "refused",
    code,
    message,
    issues: extra.issues ?? null,
    receipt: null,
    calls: extra.calls ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* The action                                                                 */
/* -------------------------------------------------------------------------- */

const FUNDED =
  "Booked. The ledger balance is up by the full amount and AVAILABLE HAS NOT MOVED — the identical amount is withheld by an uncleared-credit hold until the availability policy releases it. No ACH entry was transmitted to any network: the deposit is booked at origination against 1130, ACH receivable — inbound in transit.";

const REPLAYED =
  "Nothing new was written. This reference had already funded, so all three unique indexes — the hold's (kind, external_ref) and both entries' idempotency keys — matched existing rows and the ORIGINALS were returned. Postgres decided that, not an `if`. Pressing the button twice books one deposit.";

/**
 * Link an external bank and fund the balance from it.
 *
 * Shaped for `useActionState`, so a refusal renders inline under the form with
 * its code and the Plaid calls that were attempted, instead of throwing an
 * unexplained error boundary at somebody halfway through a funding run.
 */
export async function fundFromExternalBankAction(
  _previous: FundResult,
  formData: FormData,
): Promise<FundResult> {
  const parsed = formSchema.safeParse({
    accountId: formData.get("accountId") ?? "",
    amount: formData.get("amount") ?? "",
    valueDate: formData.get("valueDate") ?? "",
    counterpartyClass: formData.get("counterpartyClass") ?? "",
    preferredSubtype: formData.get("preferredSubtype") ?? "",
    reference: formData.get("reference") ?? "",
  });

  if (!parsed.success) {
    return refused(
      "INVALID_FORM",
      "The form could not be read, so nothing was sent to Plaid and nothing was posted. No Item was created and no journal entry exists.",
      {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(form)",
          message: issue.message,
        })),
      },
    );
  }

  const fields = parsed.data;
  const log = rootLogger.child({ screen: "funding" });

  const amountCents = parseUsdToCents(fields.amount);
  if (amountCents === null || amountCents <= 0n) {
    return refused(
      "INVALID_AMOUNT",
      "That is not an amount this system will convert to cents. Amounts are integer minor units; the text you type is turned into a bigint by string arithmetic, and anything with more than two decimal places, a sign, an exponent or a stray character is refused here rather than rounded somewhere further down.",
      { issues: [{ path: "amount", message: `could not read "${fields.amount}" as USD` }] },
    );
  }

  const account = await findDepositAccount(fields.accountId, sql);
  if (account === null) {
    return refused(
      "NO_SUCH_ACCOUNT",
      "No open customer deposit account has that id, so there is nowhere for an inbound credit to land. Nothing was sent to Plaid.",
      { issues: [{ path: "accountId", message: "not a 2100 account on this book" }] },
    );
  }

  // THE KYB GATE, AND IT IS BEFORE PLAID RATHER THAN AFTER IT.
  //
  // The brief's rule is "unverified entities can look but not transact", and it
  // has no inbound exemption. Funding raises a customer liability, the credit
  // can be returned for days afterwards, and an entity nobody has verified must
  // not be able to park a balance with us any more than it can send one.
  //
  // This is the SAME call `/payments` previews and the same call
  // `requestPayment()` makes inside its own transaction —
  // `transactGateForAccount()`, resolved from the account, handed straight to
  // `canTransact()`. The refusal carries `canTransact`'s code verbatim
  // (KYB_NEEDS_REVIEW, KYB_PENDING, KYB_REJECTED, KYB_NOT_STARTED,
  // KYB_STATE_UNREADABLE), because a second vocabulary for the same decision is
  // how two screens end up disagreeing about whether a customer is allowed.
  //
  // It runs BEFORE the Plaid calls, not after, for two reasons: a refused
  // business must not cause a real Item to be created at a real institution,
  // and Plaid's sandbox is rate limited, so a gate that spent five calls before
  // saying no would be a gate that costs more than the operation it refused.
  const gate = await transactGateForAccount(account.accountId, { conn: sql });
  if (!gate.allowed) {
    return refused(
      gate.code,
      `${gate.message} ${account.legalName} cannot be funded from an external bank until that is resolved. Nothing was sent to Plaid — no Item was created — and no journal entry exists. This is the identical gate /payments reads and requestPayment() enforces inside its own transaction; there is no inbound path around it.`,
    );
  }

  // THE DOUBLE-CLICK GUARD, and it is a guard rather than the guarantee.
  //
  // Idempotency on this path is three unique indexes, and every one of their
  // keys contains the Plaid `item_id` — which is fresh on every run, because
  // there is nowhere in this schema to persist an access token and re-read an
  // Item later. So the indexes make a funding run replay-safe WITHIN one linked
  // Item and cannot see across two, and the failure that leaves is the person
  // who presses "fund" twice because the first press spent four seconds in
  // Plaid round trips and looked like nothing happened.
  //
  // This SELECT catches that. Two requests racing between it and the INSERT
  // both pass it, and that is stated rather than hidden: see the header of
  // `rails/plaid/adapter.ts` and `docs/FUNDING.md`.
  const existing = await alreadyFundedReference(account.businessId, fields.reference, sql);
  if (existing !== null) {
    return refused(
      "ALREADY_FUNDED",
      `${account.legalName} has already funded under the reference "${fields.reference}" — hold ${existing.holdId}, external ref ${existing.externalRef}. Nothing was sent to Plaid and nothing was posted. Change the reference to book a genuinely different deposit; re-using it is how a double-click becomes two deposits, because the Plaid item id is part of every idempotency key on this path and this screen links a fresh Item on every run.`,
      { issues: [{ path: "reference", message: "already used by this business" }] },
    );
  }

  const client = new PlaidClient();
  if (!client.configured) {
    // An unconfigured Plaid is an ABSENT CAPABILITY, and this screen says so
    // rather than inventing a linked bank. There is no simulator behind this
    // slot and there deliberately is not one.
    return refused(
      "PLAID_NOT_CONFIGURED",
      "PLAID_CLIENT_ID and PLAID_SECRET are not both set in this deployment, so no Plaid call can be made and nothing was posted. There is no simulator behind this slot: an unconfigured Plaid is a missing capability, not a fallback.",
    );
  }

  // Read BEFORE the write, so the receipt's own arithmetic is provable rather
  // than asserted. This is a SUM over immutable rows — there is no stored
  // balance column in this schema for the two reads to disagree about — and it
  // is the SAME reader the headline on this screen uses, deliberately. See the
  // long note on `readBalanceCents`: the alternative in `ledger/balances.ts`
  // answers a different question and would put two figures $30,662.10 apart on
  // one page.
  const before = await readBalanceCents(account.accountId, sql);

  // Where this Item's ITEM/ERROR webhooks go. The stable production host, never
  // the per-deployment one — see `plaidWebhookUrl`.
  const webhook = plaidWebhookUrl();

  /* ---- link, for real ---------------------------------------------------- */

  let link;
  try {
    link = await linkExternalAccount({
      // Plaid is explicit that `client_user_id` must not be PII. The business
      // id is our own uuid and identifies nobody outside this system.
      clientUserId: account.businessId,
      institutionId: SANDBOX_INSTITUTION_ID,
      ...(webhook === null ? {} : { webhook }),
      client,
    });
  } catch (thrown) {
    const body = plaidErrorBody(thrown);
    const code = body?.error_code ?? "PLAID_LINK_FAILED";
    log.warn("funding.link_failed", { code, businessId: account.businessId });
    return refused(
      code,
      body === null
        ? `Plaid could not be reached, so no Item was created and nothing was posted. ${
            thrown instanceof Error ? thrown.message : "unknown transport failure"
          }`
        : `${body.error_message} ${PLAID_ITEM_ERROR_COPY[body.error_code] ?? ""} No Item usable for funding exists and nothing was posted.`.trim(),
    );
  }

  const calls = toCallViews(link.calls);

  const linked =
    link.fundable.find((candidate) => candidate.subtype === fields.preferredSubtype) ??
    link.fundable[0];

  if (linked === undefined) {
    return refused(
      "NO_FUNDABLE_ACCOUNT",
      "The Item linked successfully, but not one of its accounts is a depository account that Plaid returned ACH numbers for. There is nothing to pull from, and nothing was posted. A credit card, a CD, a mortgage and a 401k are all on this Item and none of them can fund a business current account.",
      { calls },
    );
  }

  /* ---- fund, for real ---------------------------------------------------- */

  try {
    const receipt = await fundFromLinkedAccount({
      businessId: account.businessId,
      amountCents,
      linked,
      counterpartyClass: fields.counterpartyClass as CounterpartyClass,
      valueDate: fields.valueDate,
      reference: fields.reference,
    });

    const after = await readBalanceCents(account.accountId, sql);

    log.info("funding.booked", {
      businessId: account.businessId,
      itemId: linked.itemId,
      entryId: receipt.entryId,
      holdId: receipt.holdId,
      created: receipt.created,
    });

    // The account screens show a balance that has just changed, and the holds
    // panel has a row it did not have a moment ago.
    revalidatePath("/funding");
    revalidatePath("/accounts");
    revalidatePath(`/accounts/${account.accountId}`);

    return {
      status: "ok",
      code: "FUNDED",
      message: receipt.created ? FUNDED : REPLAYED,
      issues: null,
      calls,
      receipt: {
        calls,
        itemId: linked.itemId,
        institutionName: linked.institutionName,
        institutionId: linked.institutionId,
        plaidAccountId: linked.accountId,
        plaidAccountName: linked.accountName,
        plaidAccountMask: linked.accountMask,
        plaidAccountSubtype: linked.subtype,
        routingNumber: linked.routingNumber,
        authMethod: linked.authMethod,
        plaidBalanceDisplay: linked.balanceDisplay,
        linkToken: link.linkToken?.token ?? null,
        linkTokenExpiresAt: link.linkToken?.expiresAt ?? null,

        amountDisplay: formatUsd(receipt.amountCents),
        valueDate: fields.valueDate,
        externalRef: receipt.externalRef,

        entryId: receipt.entryId,
        memoEntryId: receipt.memoEntryId,
        holdId: receipt.holdId,

        policyId: receipt.policy.id,
        policyRail: receipt.policy.rail,
        counterpartyClass: receipt.policy.counterpartyClass,
        bankingDaysHold: receipt.schedule.bankingDaysHold,
        releaseLocalTime: receipt.schedule.releaseLocalTime,
        releaseDate: receipt.schedule.releaseDate,
        availableAt: receipt.schedule.availableAt.toISOString(),
        calendarDaysHeld: receipt.schedule.calendarDaysHeld,
        scheduleSentence: describeSchedule(receipt.schedule),
        skipped: receipt.schedule.skipped.map((day) => ({
          date: day.date,
          reason: day.reason,
        })),

        before: toBalanceView(before),
        after: toBalanceView(after),
        created: receipt.created,
      },
    };
  } catch (thrown) {
    if (thrown instanceof FundingRefused) {
      log.warn("funding.refused", { code: thrown.code, businessId: account.businessId });
      return refused(thrown.code, thrown.message, { calls });
    }
    // An unexpected failure inside the transaction. The transaction is the
    // guarantee: the hold, the financial entry and the memo entry commit
    // together or not at all, so there is no half-funded state to describe.
    log.error("funding.failed", {
      businessId: account.businessId,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    });
    return refused(
      "FUNDING_FAILED",
      `The Item linked, but the posting transaction failed and was rolled back in full — no hold, no financial entry and no memo entry exist. ${
        thrown instanceof Error ? thrown.message : "unknown failure"
      }`,
      { calls },
    );
  }
}

function toBalanceView(balance: BalanceCents): BalanceSnapshotView {
  return {
    ledgerDisplay: formatUsd(balance.ledgerCents),
    availableDisplay: formatUsd(balance.availableCents),
    cardHoldsDisplay: formatUsd(balance.holdsCents),
    unclearedDisplay: formatUsd(balance.unclearedCents),
  };
}

/* -------------------------------------------------------------------------- */
/* Step one of the leg: link a bank, and only link a bank                     */
/* -------------------------------------------------------------------------- */

/** One depository account on a freshly linked Item, as the screen prints it. */
export type LinkedAccountView = {
  readonly plaidAccountId: string;
  readonly name: string;
  readonly officialName: string | null;
  readonly mask: string | null;
  readonly subtype: string | null;
  /** Public bank routing data. Safe to print; the account number never is. */
  readonly routingNumber: string;
  readonly balanceDisplay: string | null;
};

export type LinkResultView = {
  readonly status: "idle" | "ok" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly businessId: string | null;
  readonly businessName: string | null;
  readonly itemId: string | null;
  readonly institutionId: string | null;
  readonly institutionName: string | null;
  readonly linkToken: string | null;
  readonly linkTokenExpiresAt: string | null;
  readonly accounts: readonly LinkedAccountView[] | null;
  readonly calls: readonly CallView[] | null;
};

const linkSchema = z.object({
  businessId: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, {
      error: "choose the business to link a bank for",
    }),
});

function refusedLink(code: string, message: string, calls: readonly CallView[] | null = null): LinkResultView {
  return {
    status: "refused",
    code,
    message,
    businessId: null,
    businessName: null,
    itemId: null,
    institutionId: null,
    institutionName: null,
    linkToken: null,
    linkTokenExpiresAt: null,
    accounts: null,
    calls,
  };
}

/**
 * LINK AN EXTERNAL BANK, AND POST NOTHING.
 *
 * ============================================================================
 * WHY THIS IS A SEPARATE BUTTON FROM "FUND"
 * ============================================================================
 *
 * Because "fund it from a linked external bank" is two steps and a business
 * that has never linked one has to be able to take the first. A screen that
 * could only link a bank as a side effect of moving money would be a screen
 * where having no bank linked is a PRECONDITION of funding rather than the
 * opening move of it — and the reader has no way to tell the two apart until
 * they try it with a customer who has never linked anything.
 *
 * So this action does exactly the first half: five real HTTP requests to
 * `sandbox.plaid.com`, a real Item at a real institution, and that Item's real
 * depository accounts with the real ACH routing numbers `/auth/get` returned.
 * It posts no journal entry, opens no hold and moves no balance. Whatever it
 * prints, it observed.
 *
 * ============================================================================
 * IT IS AN EXPLICIT ACTION, AND THAT IS A RATE-LIMIT DECISION AS WELL AS A
 * DESIGN ONE
 * ============================================================================
 *
 * Nothing on this screen calls Plaid on render. Linking creates real objects at
 * a provider that rations its sandbox — `/institutions/get` is ten calls per
 * credential per window, which is why the integration health probe caches its
 * verdict — so a page that linked on render, or polled for a link, would burn
 * quota on readers who never pressed anything. Every Plaid call this screen
 * makes is behind a button a person pressed, and every one of them is printed
 * with its status code and Plaid's own `request_id`.
 *
 * If Plaid refuses — rate limit included — that is what is rendered, with
 * Plaid's own error code. It is never smoothed into a link that did not happen.
 *
 * ============================================================================
 * THE ITEM IS NOT PERSISTED, AND SAYING SO IS THE POINT
 * ============================================================================
 *
 * There is no `plaid_item` table in this schema and adding one needs a
 * migration this worker does not own, so the `access_token` is used for the two
 * reads inside this action and dropped. The durable record of a linkage is the
 * `external_ref` on the money rows a FUNDING run writes —
 * `plaid:<item>:<account>:<reference>` — which is genuinely immutable and
 * genuinely means an Item that has never funded anything is not stored at all.
 *
 * The honest consequence, stated rather than hidden: pressing this button and
 * then pressing "fund" links TWO Items, and the deposit is booked against the
 * second. That is why the fund form remains one press end to end. This button
 * exists to prove the step is available to any business — and to show what
 * comes back — not to be a prerequisite for the next one.
 */
export async function linkExternalBankAction(
  _previous: LinkResultView,
  formData: FormData,
): Promise<LinkResultView> {
  const parsed = linkSchema.safeParse({ businessId: formData.get("businessId") ?? "" });
  if (!parsed.success) {
    return refusedLink(
      "INVALID_FORM",
      "No business was named, so nothing was sent to Plaid and no Item was created.",
    );
  }

  const businessId = parsed.data.businessId;

  // The same gate, before the same provider, for the same reason as funding: a
  // business that may not transact must not cause an Item to be created in its
  // name at a real institution.
  const gate = await transactGateForBusiness(businessId, { conn: sql });
  if (!gate.allowed) {
    return refusedLink(
      gate.code,
      `${gate.message} No bank can be linked for this business until that is resolved — nothing was sent to Plaid and no Item was created.`,
    );
  }

  const client = new PlaidClient();
  if (!client.configured) {
    return refusedLink(
      "PLAID_NOT_CONFIGURED",
      "PLAID_CLIENT_ID and PLAID_SECRET are not both set in this deployment, so no Plaid call can be made and no Item exists. There is no simulator behind this slot: an unconfigured Plaid is a missing capability, not a fallback.",
    );
  }

  const webhook = plaidWebhookUrl();
  const log = rootLogger.child({ screen: "funding", step: "link" });

  try {
    const link = await linkExternalAccount({
      clientUserId: businessId,
      institutionId: SANDBOX_INSTITUTION_ID,
      ...(webhook === null ? {} : { webhook }),
      client,
    });
    const calls = toCallViews(link.calls);

    log.info("funding.linked", { businessId, itemId: link.item.item_id });

    return {
      status: "ok",
      code: "LINKED",
      message:
        link.fundable.length === 0
          ? "The Item linked, and not one of its accounts is a depository account Plaid returned ACH numbers for. There is nothing on it to fund from. Nothing was posted."
          : "Linked. A real Plaid Item now exists at a real institution and the accounts below are the ones Plaid returned ACH routing numbers for. NOTHING WAS POSTED — no journal entry, no hold, no balance moved. Funding is the next press.",
      businessId,
      businessName: null,
      itemId: link.item.item_id,
      institutionId: link.item.institution_id ?? null,
      institutionName: link.item.institution_name ?? null,
      linkToken: link.linkToken?.token ?? null,
      linkTokenExpiresAt: link.linkToken?.expiresAt ?? null,
      accounts: link.fundable.map((account) => ({
        plaidAccountId: account.accountId,
        name: account.accountName,
        officialName: account.officialName,
        mask: account.accountMask,
        subtype: account.subtype,
        routingNumber: account.routingNumber,
        balanceDisplay: account.balanceDisplay,
      })),
      calls,
    };
  } catch (thrown) {
    const body = plaidErrorBody(thrown);
    const code = body?.error_code ?? "PLAID_LINK_FAILED";
    log.warn("funding.link_failed", { code, businessId });
    return refusedLink(
      code,
      body === null
        ? `Plaid could not be reached, so no Item was created and nothing was posted. ${
            thrown instanceof Error ? thrown.message : "unknown transport failure"
          }`
        : `${body.error_message} ${PLAID_ITEM_ERROR_COPY[body.error_code] ?? ""} No Item exists and nothing was posted — this is Plaid's own code, rendered as it came back rather than smoothed into a link that did not happen.`.trim(),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* The non-happy paths, driven for real                                       */
/* -------------------------------------------------------------------------- */

export type ItemErrorView = {
  readonly stage: "link" | "after_link";
  readonly itemId: string | null;
  readonly errorCode: string;
  readonly errorType: string;
  readonly errorMessage: string;
  readonly displayMessage: string | null;
  readonly documentationUrl: string | null;
  /** This package's own copy for the code, because Plaid's is often null. */
  readonly explanation: string | null;
  readonly lastWebhook: { readonly code: string; readonly sentAt: string } | null;
  readonly calls: readonly CallView[];
};

export type ProbeResult = {
  readonly status: "idle" | "ok" | "refused";
  readonly message: string;
  readonly code: string | null;
  readonly linkTime: ItemErrorView | null;
  readonly afterLink: ItemErrorView | null;
};

function toItemErrorView(probe: ItemErrorProbe): ItemErrorView {
  return {
    stage: probe.stage,
    itemId: probe.itemId,
    errorCode: probe.errorCode,
    errorType: probe.errorType,
    errorMessage: probe.errorMessage,
    displayMessage: probe.displayMessage,
    documentationUrl: probe.documentationUrl,
    explanation: PLAID_ITEM_ERROR_COPY[probe.errorCode] ?? null,
    lastWebhook: probe.lastWebhook,
    calls: toCallViews(probe.calls),
  };
}

const PROBED =
  "Both failures are real and were driven just now against Plaid's own sandbox. Neither touched the account you funded from: the link-time failure creates no Item at all, and the post-link failure was driven on a THROWAWAY Item created for the purpose. There is no un-reset — recovery is Link in update mode, which needs a browser — so that Item stays broken, which is exactly why it is not one anything was funded from.";

/**
 * Drive Plaid's two item-error states for real and render what came back.
 *
 * These are two structurally different failures and the screen shows both:
 *
 *   LINK TIME      `override_password: 'error_ITEM_LOCKED'` makes
 *                  `/sandbox/public_token/create` itself return 400. No Item is
 *                  created; there is nothing to store, retry or reconnect.
 *   AFTER LINK     `/sandbox/item/reset_login` breaks a healthy Item. Every
 *                  product call then fails `ITEM_LOGIN_REQUIRED` — and
 *                  `/item/get` still answers 200 with the diagnosis and the
 *                  timestamp of the webhook Plaid already sent us.
 *
 * Nothing is simulated. If Plaid stops honouring either the probe throws rather
 * than rendering a failure nobody drove.
 */
export async function probeItemErrorsAction(
  _previous: ProbeResult,
  _formData: FormData,
): Promise<ProbeResult> {
  const client = new PlaidClient();
  if (!client.configured) {
    return {
      status: "refused",
      code: "PLAID_NOT_CONFIGURED",
      message:
        "PLAID_CLIENT_ID and PLAID_SECRET are not both set in this deployment, so no failure can be driven. An error state nobody drove is not one this screen will draw.",
      linkTime: null,
      afterLink: null,
    };
  }

  const probeWebhook = plaidWebhookUrl();

  try {
    const [linkTime, afterLink] = await Promise.all([
      probeLinkTimeFailure("ITEM_LOCKED", client),
      probeItemLoginRequired({
        client,
        ...(probeWebhook === null ? {} : { webhook: probeWebhook }),
      }),
    ]);

    return {
      status: "ok",
      code: "PROBED",
      message: PROBED,
      linkTime: toItemErrorView(linkTime),
      afterLink: toItemErrorView(afterLink),
    };
  } catch (thrown) {
    const body = plaidErrorBody(thrown);
    return {
      status: "refused",
      code: body?.error_code ?? "PROBE_FAILED",
      message:
        body === null
          ? `The probe could not be completed: ${
              thrown instanceof Error ? thrown.message : "unknown failure"
            }. Nothing is rendered, because an error state this screen did not actually observe is a fabricated one.`
          : `${body.error_message} — the probe itself failed, at a step that was not the failure being demonstrated, so nothing is rendered.`,
      linkTime: null,
      afterLink: null,
    };
  }
}
