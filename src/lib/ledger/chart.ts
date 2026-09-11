/**
 * The chart of accounts, as data.
 *
 * Authoritative source: research/ledger/DESIGN.md §2 (the account tree and
 * normal balances), §2.3 (this tree), §12 (rounding and the residual penny).
 * The DDL it lands in is db/migrations/0001_ledger.sql (`account`).
 *
 * ---------------------------------------------------------------------------
 * The three facts this file exists to make impossible to get wrong
 * ---------------------------------------------------------------------------
 *
 * 1. A CUSTOMER'S DEPOSIT BALANCE IS OUR LIABILITY, AND IT IS CREDIT-NORMAL.
 *    When a business deposits $10,000 with us we owe them $10,000: our cash at
 *    the sponsor bank goes up (debit, asset) and our obligation to them goes up
 *    (credit, liability). The customer "having money" is the bank "owing
 *    money". The operational consequence, which is the one that gets people
 *    fired: THE CUSTOMER SPENDING MONEY IS A DEBIT TO THEIR DEPOSIT ACCOUNT.
 *    Money out is a debit (we owe them less); money in is a credit. Model a
 *    deposit as an asset and every downstream number inverts.
 *
 * 2. SIGN CONVENTION: A DEBIT IS A POSITIVE `amount_cents`, A CREDIT IS
 *    NEGATIVE. One signed column, so "the entry balances" is
 *    `SUM(amount_cents) = 0` and "the account balance" is `SUM(amount_cents)`.
 *    `normalSide` (+1 debit-normal, -1 credit-normal) turns a raw signed sum
 *    into the natural balance a human expects to read, and is the only place
 *    the two conventions meet.
 *
 * 3. MONEY IS `bigint` CENTS. No floats, anywhere. Nothing in this module
 *    carries an amount at all, which is the cheapest way to keep that true.
 *
 * ---------------------------------------------------------------------------
 * Two books, one journal
 * ---------------------------------------------------------------------------
 *
 * Every account carries `book ∈ {financial, memo}`. The financial book is the
 * real general ledger. The memo book (the 9xxx subtree) holds card
 * authorisation holds and uncleared-credit holds, so that available balance is
 * derivable as `ledger − active holds` without a single hold posting polluting
 * the financial trial balance. An entry may not mix books (trigger-enforced in
 * 0001), so each book independently sums to zero.
 *
 * This module is pure data plus pure functions: no `postgres`, no `process`,
 * no I/O. `scripts/seed.mjs` imports it directly (Node strips the types), so
 * the chart the database gets and the chart the application reasons about are
 * the same array, never two lists that drift.
 */

// ---------------------------------------------------------------------------
// Vocabulary — these mirror the enums in 0001_ledger.sql exactly.
// ---------------------------------------------------------------------------

/** `account_type` in 0001_ledger.sql. */
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

/** `account_book` in 0001_ledger.sql. */
export type AccountBook = "financial" | "memo";

/** `rail` in 0001_ledger.sql. */
export type Rail = "card" | "ach" | "usdc" | "wire" | "internal";

/** +1 debit-normal (asset, expense); -1 credit-normal (liability, equity, income). */
export type NormalSide = 1 | -1;

/**
 * One node of the chart. `code` + `parent` is the whole tree; everything else
 * is what the `account` row needs, in the same vocabulary the column uses.
 */
export interface ChartAccount {
  /** Stable account code. Unique across the chart; the key everything joins on. */
  readonly code: string;
  /** Human name, used verbatim as `account.name`. */
  readonly name: string;
  /** Drives `normal_side`, which is GENERATED from it in the schema. */
  readonly type: AccountType;
  /** `financial` is the general ledger; `memo` is holds only. */
  readonly book: AccountBook;
  /** Parent account code, or `null` for a root. Parents are always rollups. */
  readonly parent: string | null;
  /** Rollup nodes are not postable; the balanced-entry trigger refuses lines to them. */
  readonly postable: boolean;
  /**
   * What lands in this account and when. Not decoration: this is the sentence
   * used to explain the account out loud, and it is carried into the seed
   * summary and the README so there is exactly one wording of it.
   */
  readonly why: string;
  /**
   * Set on the rail-facing control accounts. Reconciliation compares a scheme
   * file against the lines that hit these, so "which side of the ledger does
   * this file describe" is data rather than a hard-coded list.
   */
  readonly railControl?: Rail;
  /**
   * A rollup whose leaves are created dynamically, one per customer business,
   * sharing this node's `code` and scoped by `business_id`. See
   * `perBusinessCode` for the qualified form used outside the database.
   */
  readonly perBusiness?: true;
}

// ---------------------------------------------------------------------------
// The chart. Ordered parents-first, so a seeder can insert it as it reads it.
// ---------------------------------------------------------------------------

export const CHART: readonly ChartAccount[] = [
  // =========================================================================
  // 1000 ASSETS — debit-normal. What we own or are owed.
  // =========================================================================
  {
    code: "1000",
    name: "Assets",
    type: "asset",
    book: "financial",
    parent: null,
    postable: false,
    why: "Rollup for everything we own or are owed; a trial balance sums this subtree and never posts to it.",
  },
  {
    code: "1110",
    name: "Cash — FBO settlement account at sponsor bank",
    type: "asset",
    book: "financial",
    parent: "1000",
    postable: true,
    why: "The real dollars sitting in the for-benefit-of account at the sponsor bank; debited when funds actually land there and credited when they actually leave, never when a provider merely promises them.",
  },
  {
    code: "1120",
    name: "Card network settlement receivable",
    type: "asset",
    book: "financial",
    parent: "1000",
    railControl: "card",
    postable: true,
    why: "Money the card network owes us between a clearing we have booked and the day the network's settlement file funds it, so a clearing can hit the customer immediately without pretending cash arrived.",
  },
  {
    code: "1130",
    name: "ACH receivable — inbound in transit",
    type: "asset",
    book: "financial",
    parent: "1000",
    railControl: "ach",
    postable: true,
    why: "An inbound ACH credit we have been told about but whose settlement has not yet funded the FBO account; cleared to 1110 on the settlement date and reversed in full if the entry is returned.",
  },
  {
    code: "1140",
    name: "USDC omnibus wallet — Base Sepolia",
    type: "asset",
    book: "financial",
    parent: "1000",
    railControl: "usdc",
    postable: true,
    why: "Testnet USDC we actually hold on Base Sepolia, carried in cents at 1 USDC = 100 cents; debited on a confirmed inbound transfer and credited on a confirmed outbound one, with sub-cent dust going to 2900 rather than being truncated.",
  },
  {
    code: "1190",
    name: "Receivable from customers — overdrawn deposit accounts",
    type: "asset",
    book: "financial",
    parent: "1000",
    postable: false,
    why: "Reporting-time reclass only (v_overdrawn_accounts): a deposit account with a debit balance is money the customer owes us, and it is deliberately never posted here in the journal because auto-reclassing emits reversing entries every time a balance oscillates around zero.",
  },

  // =========================================================================
  // 2000 LIABILITIES — credit-normal. What we owe.
  // =========================================================================
  {
    code: "2000",
    name: "Liabilities",
    type: "liability",
    book: "financial",
    parent: null,
    postable: false,
    why: "Rollup for everything we owe, of which customer deposits are almost all of it.",
  },
  {
    code: "2100",
    name: "Customer deposits",
    type: "liability",
    book: "financial",
    parent: "2000",
    postable: false,
    perBusiness: true,
    why: "Control account for every customer's money: not postable itself, because the real balances are one leaf per business beneath it, and the sum of those leaves must equal this subtree exactly at every value date with no tolerance.",
  },
  {
    code: "2200",
    name: "Card network settlement payable",
    type: "liability",
    book: "financial",
    parent: "2000",
    railControl: "card",
    postable: true,
    why: "What we owe the card network for cleared spend before we fund the settlement window, credited on clearing and debited when the funding leaves 1110.",
  },
  {
    code: "2300",
    name: "ACH payable — outbound in transit",
    type: "liability",
    book: "financial",
    parent: "2000",
    railControl: "ach",
    postable: true,
    why: "An outbound ACH debit taken from the customer but not yet settled out of the FBO account; debited away on settlement, and left standing as the obligation if the entry is returned.",
  },
  {
    code: "2400",
    name: "Suspense — unapplied receipts",
    type: "liability",
    book: "financial",
    parent: "2000",
    postable: true,
    why: "Money that has genuinely arrived but that we cannot yet attribute to a customer — a wire with an unreadable reference, an ACH credit for a closed account — held as an obligation to somebody rather than dropped, and cleared to a deposit account or returned once identified.",
  },
  {
    code: "2410",
    name: "Suspense — unmatched clearings",
    type: "liability",
    book: "financial",
    parent: "2000",
    postable: true,
    why: "A clearing or force post that arrived before the customer it belongs to could be resolved; it is booked here immediately so the network position is right, then moved to the customer's deposit account when the attribution is made.",
  },
  {
    code: "2900",
    name: "Rounding residual clearing",
    type: "liability",
    book: "financial",
    parent: "2000",
    postable: true,
    why: "Sub-cent dust that cannot be allocated — USDC has six decimals, so 1.234567 USDC is 123.4567 cents — posted as a real journal line so the entry still sums to zero and the dust is a visible, ageable balance we sweep to 4200/5900 with an ordinary entry (DESIGN §12.6).",
  },

  // =========================================================================
  // 3000 EQUITY — credit-normal. Our own position.
  // =========================================================================
  {
    code: "3000",
    name: "Equity",
    type: "equity",
    book: "financial",
    parent: null,
    postable: false,
    why: "Rollup for the house's own position; nothing on a customer path ever touches this subtree.",
  },
  {
    code: "3100",
    name: "Retained earnings",
    type: "equity",
    book: "financial",
    parent: "3000",
    postable: true,
    why: "Where income and expense close at period end, so the balance sheet balances without a stored figure anywhere.",
  },
  {
    code: "3200",
    name: "Contributed capital — testnet funding",
    type: "equity",
    book: "financial",
    parent: "3000",
    postable: true,
    why: "The credit side of assets that arrive from outside the business without being earned or owed — the 20.00 USDC this wallet was funded with by the Circle faucet, and the Base Sepolia gas. Without it 1140 carried a payout it had never been funded for and read -$0.50 against a wallet holding 19.50 USDC: an asset that appeared with no corresponding credit, which is the one thing double-entry exists to make impossible. A faucet grant is not income and it is not a liability; nobody will ask for it back and we did not earn it, so it is a capital contribution and it is labelled as testnet so it can never be confused with real money raised.",
  },

  // =========================================================================
  // 4000 INCOME — credit-normal. What we earn.
  // =========================================================================
  {
    code: "4000",
    name: "Income",
    type: "income",
    book: "financial",
    parent: null,
    postable: false,
    why: "Rollup for revenue; credit-normal, so earning money is a credit here and the offsetting debit is the asset that received it.",
  },
  {
    code: "4100",
    name: "Interchange income",
    type: "income",
    book: "financial",
    parent: "4000",
    postable: true,
    why: "Our share of the interchange on card spend, credited on the CLEARING and never on the authorisation — an authorisation moves the memo book only, so interchange booked there would be revenue on money that may never settle. Priced by an effective-dated rate card (db/migrations/0031_interchange.sql) as basis points of the settled amount plus a fixed per-transaction fee, which is ONE value from ONE input and therefore DESIGN §12.2, round half to even: the fixed component is already whole cents and is added after the percentage half has been rounded, so percent-plus-fixed needs no second rounding step and this ledger still has exactly two rounding rules. It is NOT §12.3 — largest remainder needs a source amount to distribute across shares, and nothing here is being divided between parties — so there is no residual penny on this path at all. Where 4100 IS a party to a genuine allocation, §12.5 still applies and places it at ordinal 0 so the residual lands on the house rather than on the customer. Debited when a settlement is reversed: the repair is a new entry at the ORIGINAL value date, and v_interchange_unreversed and v_interchange_drift exist because revenue booked on spend that did not happen balances perfectly and no other invariant on this book would notice.",
  },
  {
    code: "4200",
    name: "Fee income",
    type: "income",
    book: "financial",
    parent: "4000",
    postable: true,
    why: "Fees we charge the customer — wire, expedited ACH, monthly platform — credited here at the same instant the customer's deposit account is debited for them.",
  },
  {
    code: "4300",
    name: "FX quote settlement variance",
    type: "income",
    book: "financial",
    parent: "4000",
    postable: true,
    why: "The difference between the rate a customer accepted and what the payout actually cost us by the time it settled. ONE signed account rather than a gain and a loss pair, because an FX variance is one fact with two signs and splitting it invites someone to report only the favourable half. It is not fee income — 4200 is what we charge, and netting variance into it would make a spread look like a price, which is exactly what 5100's own note forbids. It is not a credit loss either: nobody defaulted, the market moved. An accepted quote is a commitment we honour, so when it moves against us that is a real cost of having made a promise, and it belongs where someone can see the size of it.",
  },
  {
    code: "4400",
    name: "Interest income — overdraft",
    type: "income",
    book: "financial",
    parent: "4000",
    postable: true,
    why: "Interest charged on a customer's debit deposit balance, accrued daily on the balance actually outstanding at the end of each business date. It is not 4200: a fee is a price for a SERVICE and interest is a price for TIME AND MONEY — Reg DD discloses the two differently, and an APR netted into fee income makes a rate look like a charge, which is the same error 4300's note forbids in the other direction. It is not 4300 either: nothing about a rate moved under us, we quoted this one. It is credit-normal and sits beside 5400, its mirror on the expense side, because the same account can be overdrawn one day and in credit the next and the two days must land in different places rather than net into one balance that hides both.",
  },

  // =========================================================================
  // 5000 EXPENSE — debit-normal. What things cost us.
  // =========================================================================
  {
    code: "5000",
    name: "Expense",
    type: "expense",
    book: "financial",
    parent: null,
    postable: false,
    why: "Rollup for costs; debit-normal, so incurring a cost is a debit here.",
  },
  {
    code: "5100",
    name: "Network and processing fees",
    type: "expense",
    book: "financial",
    parent: "5000",
    postable: true,
    why: "What the card network, the sponsor bank and the ACH originator charge us, debited when the scheme or provider invoice is booked, never netted silently against 4100.",
  },
  {
    code: "5200",
    name: "Losses — chargebacks and write-offs",
    type: "expense",
    book: "financial",
    parent: "5000",
    postable: true,
    why: "Money we will not get back: a lost dispute, an unrecoverable overdraft on 1190, a 60-day unauthorised ACH return that no availability hold could have covered.",
  },
  {
    code: "5300",
    name: "Blockchain gas — USDC transfers",
    type: "expense",
    book: "financial",
    parent: "5000",
    postable: true,
    why: "Base Sepolia gas we burn sending USDC, debited from the confirmed receipt's actual gas used times effective gas price — our cost of moving the customer's money, so it is never charged to their deposit account.",
  },
  {
    code: "5400",
    name: "Interest expense — credit balances",
    type: "expense",
    book: "financial",
    parent: "5000",
    postable: true,
    why: "Interest we pay customers for holding a credit balance with us, accrued daily on the settled balance at the end of each business date. It is not 5100: that is what the network, the sponsor bank and the ACH originator charge US, and netting what we owe customers into what providers charge us would hide the size of both. It is not 5900 either — nothing here is a residual or a rounding artefact; this is the quoted price of deposits and it is the largest cost a deposit-taking business has. Debit-normal, and the mirror of 4400: one enrolment prices both sides and the sign of the balance on the day decides which account the day lands in.",
  },
  {
    code: "5900",
    name: "Rounding residual expense",
    type: "expense",
    book: "financial",
    parent: "5000",
    postable: true,
    why: "Where accumulated dust in 2900 is swept when it is ours to absorb, so the residual penny has a named home instead of being truncated into invisibility.",
  },

  // =========================================================================
  // 9000 MEMO BOOK — off balance sheet; every memo entry nets to zero inside
  // it, so the financial trial balance is never polluted by a hold.
  // =========================================================================
  {
    code: "9000",
    name: "Memo book",
    type: "liability",
    book: "memo",
    parent: null,
    postable: false,
    why: "Root of the off-balance-sheet book that carries holds; typed as a liability because its two live subtrees (9100, 9200) are obligations-shaped and the type of a non-postable rollup only ever affects how a trial balance groups it.",
  },
  {
    code: "9100",
    name: "Holds — card authorisations",
    type: "liability",
    book: "memo",
    parent: "9000",
    postable: false,
    perBusiness: true,
    why: "Control account for card authorisation holds, one leaf per business beneath it: credited when an authorisation opens a hold and debited as clearing, reversal or expiry consumes it, so available balance is ledger minus the sum of these.",
  },
  {
    code: "9200",
    name: "Holds — uncleared credits",
    type: "liability",
    book: "memo",
    parent: "9000",
    postable: false,
    perBusiness: true,
    why: "Control account for funds-availability holds on inbound credits, one leaf per business: credited when an ACH or USDC credit posts to the ledger before it is safe to spend, and debited when the policy's availability moment passes or the credit is returned.",
  },
  {
    code: "9900",
    name: "Memo contra",
    type: "asset",
    book: "memo",
    parent: "9000",
    postable: true,
    why: "The other side of every memo entry: each hold posting is two lines, a credit to the customer's 9100/9200 leaf and a debit here, which is what makes the memo book double-entry and independently zero-summed.",
  },
];

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const BY_CODE: ReadonlyMap<string, ChartAccount> = new Map(
  CHART.map((account) => [account.code, account]),
);

/** Every account code in the chart, in tree order. */
export const CHART_CODES: readonly string[] = CHART.map((account) => account.code);

/** Resolve an account by code. Returns `undefined` for a code not in the chart. */
export function findAccount(code: string): ChartAccount | undefined {
  return BY_CODE.get(code);
}

/**
 * Resolve an account by code, or throw. Use this at a call site that has
 * already decided the code is a constant of this module: a typo becomes a
 * loud failure at the posting boundary rather than an `undefined` that
 * silently produces a one-legged entry.
 */
export function requireAccount(code: string): ChartAccount {
  const account = BY_CODE.get(code);
  if (account === undefined) {
    throw new Error(`no account '${code}' in the chart of accounts`);
  }
  return account;
}

/** Direct children of an account code, in chart order. */
export function childrenOf(code: string): readonly ChartAccount[] {
  return CHART.filter((account) => account.parent === code);
}

/**
 * +1 for debit-normal (asset, expense), -1 for credit-normal (liability,
 * equity, income). Mirrors the GENERATED `account.normal_side` column exactly.
 * Multiply a raw `SUM(amount_cents)` by this to get the natural balance:
 * a customer holding $100 reads +10000 even though their lines sum to -10000.
 */
export function normalSide(type: AccountType): NormalSide {
  return type === "asset" || type === "expense" ? 1 : -1;
}

/** Convenience: the normal side of a charted account. */
export function normalSideOf(code: string): NormalSide {
  return normalSide(requireAccount(code).type);
}

// ---------------------------------------------------------------------------
// Per-customer accounts
// ---------------------------------------------------------------------------

/** The rollup whose leaves are the customers' own money. */
export const DEPOSIT_PARENT_CODE = "2100";
/** The rollup whose leaves carry card authorisation holds, in the memo book. */
export const CARD_HOLD_PARENT_CODE = "9100";
/** The rollup whose leaves carry uncleared-credit holds, in the memo book. */
export const UNCLEARED_HOLD_PARENT_CODE = "9200";

/** Separates the rollup code from the business id in a qualified code. */
export const QUALIFIED_CODE_SEPARATOR = "/";

/**
 * The row shape a per-business account is stored as.
 *
 * IMPORTANT and easy to get wrong: in the database the stored `account.code`
 * is the BARE rollup code ('2100'), and the customer is identified by
 * `business_id`. The uniqueness constraint is
 * `UNIQUE NULLS NOT DISTINCT (entity_id, code, business_id)`, and
 * `v_available_balance`, `v_overdrawn_accounts` and `v_deposit_control_drift`
 * all select on `code = '2100' AND business_id IS NOT NULL`. Storing
 * '2100/<uuid>' in the code column would make every one of those views return
 * nothing, silently.
 */
export interface PerBusinessAccountRef {
  /** The value written to `account.code` — bare, never qualified. */
  readonly code: string;
  /** The value written to `account.business_id`. */
  readonly businessId: string;
  /** The value written to `account.parent_id`'s account, by code. */
  readonly parentCode: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The qualified code — `'2100/<business_id>'` — used in logs, statements,
 * error messages and tests. It is a display and addressing form only; see
 * `PerBusinessAccountRef` for what is actually stored.
 */
export function perBusinessCode(parentCode: string, businessId: string): string {
  const parent = requireAccount(parentCode);
  if (parent.perBusiness !== true) {
    throw new Error(`account '${parentCode}' does not carry per-business leaves`);
  }
  if (!UUID_RE.test(businessId)) {
    throw new Error(`'${businessId}' is not a business uuid`);
  }
  return `${parent.code}${QUALIFIED_CODE_SEPARATOR}${businessId}`;
}

/**
 * The exact inverse of `perBusinessCode`. Returns `null` for anything that is
 * not a well-formed qualified code for a per-business rollup that exists in
 * the chart — including a bare rollup code, which addresses the control
 * account and not a customer.
 */
export function parsePerBusinessCode(qualified: string): PerBusinessAccountRef | null {
  const cut = qualified.indexOf(QUALIFIED_CODE_SEPARATOR);
  if (cut < 0) return null;

  const parentCode = qualified.slice(0, cut);
  const businessId = qualified.slice(cut + QUALIFIED_CODE_SEPARATOR.length);

  const parent = findAccount(parentCode);
  if (parent === undefined || parent.perBusiness !== true) return null;
  if (!UUID_RE.test(businessId)) return null;

  return { code: parent.code, businessId, parentCode: parent.code };
}

/** The qualified code of a customer's deposit account: their money, our liability. */
export function depositAccountCode(businessId: string): string {
  return perBusinessCode(DEPOSIT_PARENT_CODE, businessId);
}

/** The business id inside a qualified deposit code, or `null` if it is not one. */
export function parseDepositAccountCode(qualified: string): string | null {
  const ref = parsePerBusinessCode(qualified);
  return ref !== null && ref.code === DEPOSIT_PARENT_CODE ? ref.businessId : null;
}

/** The qualified code of a business's card-authorisation hold account (memo book). */
export function cardHoldAccountCode(businessId: string): string {
  return perBusinessCode(CARD_HOLD_PARENT_CODE, businessId);
}

/** The qualified code of a business's uncleared-credit hold account (memo book). */
export function unclearedHoldAccountCode(businessId: string): string {
  return perBusinessCode(UNCLEARED_HOLD_PARENT_CODE, businessId);
}

/** Every per-business rollup, i.e. every account that gets a leaf per customer. */
export const PER_BUSINESS_PARENTS: readonly ChartAccount[] = CHART.filter(
  (account) => account.perBusiness === true,
);

/**
 * The full set of accounts to open when a business passes KYB: their deposit
 * account plus one memo hold account per hold kind. Returned in the order they
 * must be inserted, which is the order the rollups appear in the chart.
 */
export function accountsForBusiness(businessId: string): readonly PerBusinessAccountRef[] {
  return PER_BUSINESS_PARENTS.map((parent) => ({
    code: parent.code,
    businessId,
    parentCode: parent.code,
  }));
}

/** The `account.name` a customer leaf is opened under. */
export function perBusinessAccountName(parentCode: string, legalName: string): string {
  const parent = requireAccount(parentCode);
  switch (parent.code) {
    case DEPOSIT_PARENT_CODE:
      return `${legalName} — business current account`;
    case CARD_HOLD_PARENT_CODE:
      return `${legalName} — card authorisation holds`;
    case UNCLEARED_HOLD_PARENT_CODE:
      return `${legalName} — uncleared credit holds`;
    default:
      return `${legalName} — ${parent.name}`;
  }
}
