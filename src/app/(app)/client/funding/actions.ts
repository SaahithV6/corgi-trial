"use server";

/**
 * The customer's half of funding: link your own bank, and pull money in from it.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * The brief says "customers fund the account from an external bank THEY LINK
 * THEMSELVES". This build shipped funding entirely operator-side: `/funding`
 * lets a member of bank staff link an Item on a customer's behalf and pull
 * money in, and the customer whose money it is could do neither. That polarity
 * is backwards. Linking your own bank is the customer's act of consent; the
 * bank needs to SEE the linkage, not to be the only party who can create one.
 *
 * ===========================================================================
 * ONE LIBRARY, TWO CALLERS
 * ===========================================================================
 *
 * Every write below goes through `linkExternalAccount()`, `recordLinkedItem()`
 * and `fundFromLinkedAccount()` in `@/lib/rails/plaid/**` — the same functions
 * the staff console's action calls, reached through the library rather than
 * through the other screen. `src/app/(app)/funding/actions.ts` is NOT imported
 * and is not touched. Nothing here opens a transaction, formats a journal line,
 * chooses an availability policy or knows the shape of `hold`: the two unique
 * indexes that make a double-click one deposit, the `ON CONFLICT DO NOTHING`
 * that decides it, the value-date-driven policy lookup and the memo book's sign
 * inversion are all applied in the library and in the database. A second copy
 * of any of those rules is the defect, not the reuse.
 *
 * ===========================================================================
 * WHAT THIS DOES, AND WHAT IT DOES NOT
 * ===========================================================================
 *
 * IT DOES make real HTTP calls to `sandbox.plaid.com` and link a REAL Plaid
 * Item, and it DOES post real double-entry journal entries, in `bigint` cents,
 * to the live database.
 *
 * IT DOES NOT transmit an ACH entry to any network. `POST /ach_transfers` is
 * not called from this path and the numbers Plaid returned are not registered
 * with an originator. The deposit is booked at ORIGINATION, against 1130, which
 * is how a bank books a debit at file-cut before the file goes out — and the
 * journal entry's own `description` says so, for ever, on the row.
 *
 * IT DOES NOT make the money spendable. The credit raises the LEDGER balance
 * and an `uncleared_credit` hold withholds the identical amount from AVAILABLE
 * until the availability policy releases it. No balance is computed anywhere in
 * this file: `ledger_availability()` is the one definition of available, and
 * the five terms this screen prints are read from it.
 *
 * ===========================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT
 * ===========================================================================
 *
 * Nothing in the `FormData` is trusted. The business id, the Plaid item id and
 * the Plaid account id are CLAIMS, and each is resolved server-side against the
 * database by a statement that names both the id and the business —
 * `ownsLinkedAccount()`, one statement, three columns, evaluated by Postgres
 * before a row exists to be filtered. It is NOT a `.find()` over a list read
 * earlier: that would make tenant isolation a step in a program, and this
 * surface refuses that everywhere else.
 *
 * A bank belonging to another customer produces the SAME refusal as one that
 * does not exist, so this form cannot be used to discover which Plaid item ids
 * are real.
 *
 * NO ACCESS TOKEN IS READ, RENDERED OR LOGGED ON THIS PATH. `liveAccessTokenFor()`
 * is the only function that reads `plaid_item_secret`, it returns a wrapper
 * whose `toJSON()` is `[redacted]`, and the funding write does not need one at
 * all — the linkage it needs is already persisted in `plaid_item_account`.
 *
 * NOTE: the idle value for these forms lives in
 * `@/components/client/funding/action-state`, a plain module, NOT here. A
 * `"use server"` module may export only async functions; a `const` exported
 * from one becomes a callable server reference and the form crashes on first
 * render while typecheck stays clean.
 */

import { revalidatePath } from "next/cache";

import {
  NOT_TRANSMITTED,
  type FundingActionResult,
  type FundingFact,
} from "@/components/client/funding/action-state";
import { formatUsd } from "@/lib/format/money";
import { transactGateForBusiness } from "@/lib/kyb/wire";
import { sql } from "@/lib/ledger/db";
import {
  bookDateOf,
  FundingRefused,
  fundFromLinkedAccount,
  linkExternalAccount,
  plaidWebhookUrl,
  SANDBOX_INSTITUTION_ID,
} from "@/lib/rails/plaid/adapter";
import { PlaidClient } from "@/lib/rails/plaid/client";
import type { PlaidItemState } from "@/lib/rails/plaid/item-store";
import { PLAID_EVIDENCE, type PlaidLinkedAccount } from "@/lib/rails/plaid/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Drop the cached render of the screens this write changed.
 *
 * IT IS A CACHE HINT AND NOT PART OF THE WRITE, and that distinction is load
 * bearing rather than defensive. `revalidatePath()` needs Next's per-request
 * store and throws `Invariant: static generation store missing` without one —
 * which is exactly the position the test that DRIVES this action calls it from.
 * Letting that throw reach the caller turned a committed deposit into a
 * `LINK_FAILED` refusal: the money had moved and the screen said it had not,
 * which is the worst answer a funding screen can give.
 *
 * So the failure is contained here, where the only consequence of it is a stale
 * page on the next navigation. The rows are already committed by the time this
 * runs; nothing it can do or fail to do changes them.
 */
function revalidateFunding(): void {
  try {
    revalidatePath("/client/funding");
    revalidatePath("/client");
  } catch {
    // No request store — a test, or a call outside a render. Nothing to drop.
  }
}

function result(
  status: "posted" | "refused",
  code: string | null,
  message: string,
  facts: readonly FundingFact[] = [],
): FundingActionResult {
  return { status, code, message, facts, at: new Date().toISOString() };
}

function refused(
  code: string,
  message: string,
  facts: readonly FundingFact[] = [],
): FundingActionResult {
  return result("refused", code, message, facts);
}

/**
 * The same sentence for a bank that is not real and one that is not theirs.
 *
 * Telling them apart would turn this form into an oracle for which Plaid item
 * ids exist on the platform. `moveClientPotAction` makes the identical choice
 * for pot ids and says so at length.
 */
const NOT_YOURS =
  "That bank is not linked to this business. The answer is the same for a bank that does not exist and one belonging to another customer — telling them apart would let anybody confirm which linked accounts are real. Nothing was sent to Plaid and nothing was posted.";

/* -------------------------------------------------------------------------- */
/* Money in, from a text field                                                */
/* -------------------------------------------------------------------------- */

/**
 * `"2,500.00"` -> `250000n`, by integer string arithmetic.
 *
 * There is no `parseFloat`, no `Number(...)` and no `* 100` on this path.
 * `Number("0.1") * 100` is `10.000000000000002`, and a funding path that rounds
 * that has just invented a cent. The whole part and the fractional part are
 * separated as TEXT, padded as TEXT, and each converted straight to `bigint`.
 *
 * `null` for anything that is not a plain USD amount — a sign, an exponent,
 * three decimal places, a stray character. That is refused here rather than
 * guessed at further down.
 */
function parseAmountCents(raw: FormDataEntryValue | null): bigint | null {
  const text =
    typeof raw === "string" ? raw.trim().replace(/^\$/, "").replaceAll(",", "") : "";
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(text)) return null;
  const dot = text.indexOf(".");
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? "" : text.slice(dot + 1);
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
}

/** A reference is what the deposit is FOR, and it is part of the external ref. */
function readReference(raw: FormDataEntryValue | null): string {
  const text = typeof raw === "string" ? raw.trim() : "";
  return text.slice(0, 80);
}

/* -------------------------------------------------------------------------- */
/* The predicates                                                             */
/* -------------------------------------------------------------------------- */

/** Is this business real? One statement, one column, answered by Postgres. */
async function businessExists(businessId: string): Promise<boolean> {
  if (!UUID.test(businessId)) return false;
  const rows = await sql<{ id: string }[]>`
    SELECT b.id FROM business b WHERE b.id = ${businessId}::uuid LIMIT 1`;
  return rows[0] !== undefined;
}

type OwnedAccount = {
  readonly itemId: string;
  readonly accountId: string;
  readonly institutionId: string | null;
  readonly institutionName: string | null;
  readonly name: string;
  readonly mask: string | null;
  readonly subtype: string | null;
  readonly routingNumber: string | null;
  readonly authMethod: string | null;
  readonly state: PlaidItemState;
  readonly lastErrorCode: string | null;
  readonly environment: "sandbox" | "production";
};

/**
 * Is this Plaid account, on this Plaid Item, linked to THIS business — and what
 * state is the Item in?
 *
 * ONE STATEMENT. The item id, the account id and the business id are all in the
 * `WHERE`, and the item's state comes from `v_plaid_item_state` in the same
 * round trip rather than from a second read that could observe a different
 * instant. `fundable` is in the predicate too: a mortgage or a credit card has
 * no ACH numbers and is not something an ACH debit can be pulled from, and a
 * caller who names one gets the same refusal as one who names a stranger's.
 */
async function ownsLinkedAccount(
  itemId: string,
  plaidAccountId: string,
  businessId: string,
): Promise<OwnedAccount | null> {
  if (!UUID.test(businessId)) return null;
  if (itemId === "" || plaidAccountId === "") return null;

  const [row] = await sql<
    {
      item_id: string;
      account_id: string;
      institution_id: string | null;
      institution_name: string | null;
      name: string;
      mask: string | null;
      subtype: string | null;
      routing_number: string | null;
      auth_method: string | null;
      state: string;
      last_error_code: string | null;
      environment: string;
    }[]
  >`
    SELECT pa.item_id, pa.account_id, pi.institution_id, pi.institution_name,
           pa.name, pa.mask, pa.subtype, pa.routing_number, pa.auth_method,
           v.state, v.last_error_code, pi.environment
      FROM plaid_item_account pa
      JOIN plaid_item pi        ON pi.item_id = pa.item_id
      JOIN v_plaid_item_state v ON v.item_id = pa.item_id
     WHERE pa.item_id       = ${itemId}
       AND pa.account_id    = ${plaidAccountId}
       AND pi.business_id   = ${businessId}::uuid
       AND pi.purpose       = 'funding'
       AND pa.fundable
     LIMIT 1`;

  if (row === undefined) return null;
  return {
    itemId: row.item_id,
    accountId: row.account_id,
    institutionId: row.institution_id,
    institutionName: row.institution_name,
    name: row.name,
    mask: row.mask,
    subtype: row.subtype,
    routingNumber: row.routing_number,
    authMethod: row.auth_method,
    state: row.state as PlaidItemState,
    lastErrorCode: row.last_error_code,
    environment: row.environment === "production" ? "production" : "sandbox",
  };
}

/* -------------------------------------------------------------------------- */
/* The four item states, in the customer's own words                          */
/* -------------------------------------------------------------------------- */

/**
 * What a customer is told when the Item is not in a state money can be pulled
 * from — and, for `needs_reauth`, WHO has to do something about it.
 *
 * The distinction is the whole reason the vocabulary has four words rather than
 * "ok"/"broken". `needs_reauth` is not a retry: Plaid's `ITEM_LOGIN_REQUIRED`
 * is cleared only by Link in UPDATE MODE, which needs a PERSON in a browser at
 * their own bank's login screen. No amount of waiting, and no button on this
 * page, will fix it. Saying "try again later" there would be a lie that costs
 * somebody their afternoon.
 *
 * `revoked` is terminal in the other direction — consent was withdrawn, and the
 * repair is a NEW link, not a repair of this one. `orphaned` is ours: we hold
 * no credential for the Item, so there is nothing to ask Plaid with, and that
 * is our problem to state rather than the customer's to solve.
 */
function itemStateRefusal(owned: OwnedAccount): FundingActionResult | null {
  const where = owned.institutionName ?? "your bank";
  const facts: readonly FundingFact[] = [
    { label: "Bank", value: where },
    { label: "Account", value: `${owned.name}${owned.mask === null ? "" : ` ••${owned.mask}`}` },
    { label: "Connection state", value: owned.state, mono: true },
    ...(owned.lastErrorCode === null
      ? []
      : [{ label: "Plaid said", value: owned.lastErrorCode, mono: true }]),
  ];

  switch (owned.state) {
    case "healthy":
      return null;

    case "needs_reauth":
      return refused(
        "needs_reauth",
        `Nothing was pulled and nothing was posted. The connection to ${where} has stopped working: the bank is asking for a login again, and that is something A PERSON HAS TO DO — somebody has to sign in to ${where} once more and re-authorise this connection, at the bank's own login screen. There is no button here that can do it and waiting will not clear it: Plaid returned ITEM_LOGIN_REQUIRED, and the only thing that clears that code is a human re-authenticating. Your money is untouched and your balance has not changed. Once the connection is re-authorised this account works again exactly as it did.`,
        facts,
      );

    case "revoked":
      return refused(
        "revoked",
        `Nothing was pulled and nothing was posted. Access to ${where} was withdrawn — somebody removed this connection's permission, either at ${where} or in this app. Re-authorising will not bring it back; this connection is finished and a NEW one has to be made. Your money is untouched.`,
        facts,
      );

    case "orphaned":
      return refused(
        "orphaned",
        `Nothing was pulled and nothing was posted, and this one is ours rather than yours. We no longer hold the credential for this connection, so there is nothing we can ask ${where} with — we cannot even check whether it still works. Link the bank again and this account becomes usable. Your money is untouched.`,
        facts,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* 1. Link a bank                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The customer links their own external bank.
 *
 * `linkExternalAccount()` is the library function `/funding` calls, with
 * `persist` given, so the Item, its access token and its accounts are written
 * by `recordLinkedItem()` in ONE transaction — an Item row with no token is an
 * Item nobody can ever read again, which is what the three `orphaned` rows on
 * this book are.
 *
 * `clientUserId` IS THE BUSINESS ID AND NEVER AN EMAIL. Plaid is explicit that
 * the value must not be personally identifying, and a uuid is not.
 *
 * A real `link-sandbox-…` token is minted by `/link/token/create` — the actual
 * first step of the production, browser-driven flow — and then not used,
 * because completing Link needs a person in an iframe. That is stated on the
 * receipt rather than hidden: what this deployment can do without a browser is
 * the sandbox public-token shortcut, and pretending otherwise would be claiming
 * a flow this build has not shipped.
 */
export async function linkClientBankAction(
  _previous: FundingActionResult,
  formData: FormData,
): Promise<FundingActionResult> {
  const businessId = String(formData.get("businessId") ?? "");

  if (!(await businessExists(businessId))) {
    return refused(
      "NO_SUCH_BUSINESS",
      "This screen is not scoped to a business, so there is no account for a linked bank to fund. Nothing was sent to Plaid.",
    );
  }

  const client = new PlaidClient();
  if (!client.configured) {
    // An unconfigured Plaid is an ABSENT CAPABILITY, and this screen says so
    // rather than inventing a linked bank. There is deliberately no simulator.
    return refused(
      "PLAID_NOT_CONFIGURED",
      "This deployment has no Plaid credentials configured, so no bank can be linked. There is no simulator behind this: an unconfigured Plaid is a missing capability, not a fallback, and inventing a linked bank here would be inventing your money's source.",
    );
  }

  try {
    // `plaidWebhookUrl()` returns null to mean "create this Item with no
    // webhook", and the option is absent rather than null, so an Item is never
    // registered against the string "null".
    const webhook = plaidWebhookUrl();
    const linked = await linkExternalAccount({
      clientUserId: businessId,
      institutionId: SANDBOX_INSTITUTION_ID,
      ...(webhook === null ? {} : { webhook }),
      persist: { businessId, conn: sql, purpose: "funding" },
    });

    revalidateFunding();

    const names = linked.fundable
      .map((a) => `${a.accountName}${a.accountMask === null ? "" : ` ••${a.accountMask}`}`)
      .join(", ");

    return result(
      "posted",
      null,
      `${linked.item.institution_name ?? "Your bank"} is linked. ${linked.fundable.length} account${linked.fundable.length === 1 ? " is" : "s are"} set up to pull from: ${names}. The connection — not your bank password — is what we keep, and we keep it as an opaque credential this screen cannot read or print. Nothing has moved: linking a bank is consent, not a payment.`,
      [
        { label: "Bank", value: linked.item.institution_name ?? "unknown" },
        { label: "Connection", value: linked.item.item_id, mono: true },
        { label: "Accounts to pull from", value: String(linked.fundable.length) },
        {
          label: "Link token (minted, unused)",
          value:
            linked.linkToken === null
              ? "not minted"
              : `${linked.linkToken.token.slice(0, 18)}… expires ${linked.linkToken.expiresAt}`,
          mono: true,
        },
      ],
    );
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return refused(
      "LINK_FAILED",
      `Your bank was not linked and nothing was posted. ${message.slice(0, 300)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Fund from a linked bank                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Pull money in from a bank this customer has already linked.
 *
 * The counterparty class is NOT taken from the form and is not a choice this
 * screen offers. A Plaid-linked account is the customer's OWN external bank,
 * verified by Plaid at link time, which is exactly what `self` means in
 * `funds_availability_policy` — and the seeded `self` row still holds it one
 * banking day, because a customer can overdraw their own outside bank as easily
 * as anyone else can. Letting a customer pick their own hold period would be
 * letting them pick how long their money is at risk for.
 */
export async function fundFromLinkedBankAction(
  _previous: FundingActionResult,
  formData: FormData,
): Promise<FundingActionResult> {
  const businessId = String(formData.get("businessId") ?? "");
  const itemId = String(formData.get("itemId") ?? "").trim();
  const plaidAccountId = String(formData.get("plaidAccountId") ?? "").trim();

  // THE OWNERSHIP RE-CHECK, BEFORE ANYTHING ELSE AND IN SQL.
  const owned = await ownsLinkedAccount(itemId, plaidAccountId, businessId);
  if (owned === null) return refused("BANK_NOT_ON_THIS_BUSINESS", NOT_YOURS);

  // The connection's state decides whether money can come from it at all, and
  // `needs_reauth` is the one the customer has to be told about in their own
  // words, because the repair is a person and not a retry.
  const broken = itemStateRefusal(owned);
  if (broken !== null) return broken;

  const amountCents = parseAmountCents(formData.get("amount"));
  if (amountCents === null || amountCents <= 0n) {
    return refused(
      "AMOUNT_UNREADABLE",
      "Write the amount in dollars and cents, like 2500 or 2500.00. Nothing was pulled. Amounts are whole cents here — the text you type is turned into an integer number of cents by string arithmetic, so anything with a sign, an exponent or three decimal places is refused rather than rounded somewhere you cannot see.",
    );
  }

  const reference = readReference(formData.get("reference"));
  if (reference === "" || !/^[A-Za-z0-9._/#-]+$/.test(reference)) {
    return refused(
      "REFERENCE_REQUIRED",
      "Say what this deposit is for — “opening-float”, an invoice number, a month. Letters, digits and . _ / # - only, with no spaces. It is kept on the entry, and it is also what makes a double-click one deposit instead of two: the same reference against the same account lands on the rows that already exist rather than posting a second deposit.",
    );
  }

  // THE KYB GATE, AND IT HAS NO INBOUND EXEMPTION.
  //
  // "Unverified entities can look but not transact" has no carve-out for money
  // coming IN: funding raises a customer liability, the credit can be returned
  // for days afterwards, and an entity nobody has verified must not be able to
  // park a balance with us. This is the identical call `/payments` previews and
  // `requestPayment()` enforces inside its own transaction, and the refusal
  // carries `canTransact()`'s code verbatim — a second vocabulary for one
  // decision is how two screens end up disagreeing about who is allowed.
  const gate = await transactGateForBusiness(businessId, { conn: sql });
  if (!gate.allowed) {
    return refused(
      gate.code,
      `${gate.message} Until that is resolved, money cannot be pulled in from your linked bank either — the rule is the same in both directions, because a balance parked with us is as much a transaction as one sent out. Nothing was pulled and nothing was posted.`,
      [{ label: "Bank", value: owned.institutionName ?? "your bank" }],
    );
  }

  const linked: PlaidLinkedAccount = {
    itemId: owned.itemId,
    accountId: owned.accountId,
    institutionId: owned.institutionId,
    institutionName: owned.institutionName,
    accountName: owned.name,
    officialName: null,
    accountMask: owned.mask,
    subtype: owned.subtype,
    // Persisted at link time by `recordLinkedItem()` from `/auth/get`. Public
    // bank routing data; the account number is not read on this path at all.
    routingNumber: owned.routingNumber ?? "",
    authMethod: owned.authMethod,
    balanceDisplay: null,
    evidence: PLAID_EVIDENCE,
    environment: owned.environment,
  };

  const valueDate = bookDateOf();

  try {
    const receipt = await fundFromLinkedAccount({
      businessId,
      amountCents,
      linked,
      // Not a form field. See the note above this function.
      counterpartyClass: "self",
      valueDate,
      reference,
      conn: sql,
    });

    revalidateFunding();

    const where = `${owned.institutionName ?? "your bank"}${owned.mask === null ? "" : ` ••${owned.mask}`}`;
    const facts: readonly FundingFact[] = [
      { label: "From", value: where },
      { label: "Amount", value: formatUsd(receipt.amountCents) },
      { label: "Value date", value: receipt.schedule.valueDate, mono: true },
      {
        label: "Available to spend from",
        value: `${receipt.schedule.releaseDate} ${receipt.policy.releaseLocalTime} New York`,
      },
      { label: "Hold", value: receipt.holdId, mono: true },
      { label: "Entry", value: receipt.entryId, mono: true },
      { label: "Reference", value: receipt.externalRef, mono: true },
    ];

    // A REPLAY IS NOT A SECOND DEPOSIT AND MUST NOT READ LIKE ONE. The hold's
    // `UNIQUE (kind, external_ref)` and both entries' idempotency keys decided
    // this, not an `if` — pressing the button twice books one deposit.
    if (!receipt.created) {
      return result(
        "posted",
        "ALREADY_FUNDED",
        `Nothing was written. This deposit is already on your account under the reference “${reference}”, so this press posted no entry and pulled no money — what you are looking at is the deposit that already exists. The database decided that, not a check on this page: the hold and both journal entries are unique on this reference. To fund again, give it a different reference.`,
        facts,
      );
    }

    return result(
      "posted",
      null,
      `${formatUsd(receipt.amountCents)} is on its way in from ${where}, and it is on your account NOW — but it is not yours to spend yet. Your ledger balance is up by the full amount and your available balance has not moved at all: the identical amount is held back until ${receipt.schedule.releaseDate} at ${receipt.policy.releaseLocalTime} New York, which is ${receipt.policy.bankingDaysHold} banking day${receipt.policy.bankingDaysHold === 1 ? "" : "s"} after today. ${NOT_TRANSMITTED} We have instructed the pull and written it down honestly; the money has not yet crossed any bank rail.`,
      facts,
    );
  } catch (thrown) {
    if (thrown instanceof FundingRefused) {
      return refused(
        thrown.code,
        `Nothing was posted and no money moved. ${thrown.message}`,
      );
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return refused(
      "FUNDING_FAILED",
      `Nothing was posted and no money moved — the whole thing was rolled back, so your balance is exactly as it was. ${message.slice(0, 300)}`,
    );
  }
}
