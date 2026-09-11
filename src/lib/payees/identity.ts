/**
 * The name the RECEIVING institution holds — where we can actually get it.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ HONESTY NOTE. `POST /identity/match` below has been executed against the │
 * │ real Plaid sandbox with the credentials in `PLAID_CLIENT_ID` /          │
 * │ `PLAID_SECRET`. Six comparisons, six 200s, transcribed in               │
 * │ docs/PAYEES.md with the scores. It is a live provider call and it does  │
 * │ real name verification.                                                 │
 * │                                                                         │
 * │ AND IT DOES NOT SOLVE CONFIRMATION OF PAYEE, because of what it needs   │
 * │ as input. See below.                                                    │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ─── THE SHAPE OF THE GAP ──────────────────────────────────────────────────
 *
 * `/identity/match` takes an ACCESS TOKEN, not a routing number and an
 * account number. An access token exists for an Item, and an Item exists
 * because a human sat in front of Plaid Link and typed their own bank
 * credentials. So the question Plaid can answer is:
 *
 *     "Does the name I typed match the name on THIS account that
 *      ITS OWN HOLDER connected to me?"
 *
 * and the question Confirmation of Payee answers is:
 *
 *     "Does the name I typed match the name on THAT account at
 *      SOMEBODY ELSE'S BANK, which I know only by its number?"
 *
 * Those are different questions. The second one has no answer available to
 * this system, from any provider in the credential set, and no amount of
 * engineering on our side produces one — it needs a network that does not
 * exist for US ACH.
 *
 * ─── SO WHAT IS THIS WORTH ─────────────────────────────────────────────────
 *
 * More than nothing, and exactly this much:
 *
 *   1. THE FUNDING SOURCE IS A LINKED ITEM. Every external account a customer
 *      funds from went through Plaid Link, so for those we can and do check
 *      that the name on the account is the name of the business we think we
 *      are dealing with. That is a real control and it runs on real data.
 *
 *   2. A PAYEE THAT IS ALSO A LINKED ITEM gets the real answer. If a supplier
 *      links an account to us — an onboarding step a marketplace can
 *      genuinely require — their payee record carries an access token and
 *      this module returns the institution's own record of the holder name.
 *      `payee_name_source` says `linked_account_holder` and it means it.
 *
 *   3. EVERY OTHER PAYEE gets `payer_asserted`, and the screen says so in
 *      words: no bank has confirmed anything. That is the truthful label and
 *      it is printed at the same size as the score.
 *
 * ─── WHAT WE CALIBRATE OFF IT ──────────────────────────────────────────────
 *
 * Plaid's `legal_name.score` is a real provider's opinion on the same
 * question `name-match.ts` answers locally, so it is a free calibration set.
 * The measured scores are in `name-match.ts`'s header and pinned in its test.
 * Our comparison reproduces Plaid's ordering and is deliberately stricter at
 * the one place it matters: a one-letter surname difference, which Plaid
 * scores 93 and its own guidance would pass at a ≥ 90 threshold.
 *
 * ─── THE ONE WE DID NOT USE ────────────────────────────────────────────────
 *
 * Increase exposes `POST /ach_prenotifications` and our key reaches it
 * (`GET /ach_prenotifications` → 200, empty list — measured). A prenote is
 * the genuine US mechanism for validating an account before sending money:
 * a zero-dollar entry the receiving bank may answer with a C01 (wrong
 * account number), C02 (wrong routing number) or C03 correction. It is not
 * in this module for two reasons, both deliberate:
 *
 *   * it is a WRITE to the rail, and this path validates rather than
 *     transacts — the brief's line, and this file keeps it;
 *   * the answer arrives in days via a webhook, so it is a background
 *     assurance loop, not a confirmation step in front of a payment.
 *
 * It is the right week-two feature and docs/PAYEES.md sketches it, with the
 * table it would write to (`payee_verification`, a second row, later) and the
 * webhook it would consume. It is described there as unbuilt, because it is.
 */

import { PLAID_PROVIDER, PLAID_SANDBOX_BASE_URL } from "@/lib/rails/plaid/types";

export const PLAID_IDENTITY_MATCH_PROVIDER = `${PLAID_PROVIDER}.identity_match`;

/**
 * [MEASURED] The subset of `/identity/match`'s per-account object we use.
 *
 * Plaid returns a great deal more — address, email and phone sub-scores, all
 * `null` in sandbox because nothing was supplied to match them against. Only
 * `legal_name` is read, because only `legal_name` answers the question, and
 * a `null` score elsewhere must never be mistaken for a failed check.
 */
type PlaidLegalNameMatch = {
  readonly score?: number | null;
  readonly is_first_name_or_last_name_match?: boolean | null;
  readonly is_nickname_match?: boolean | null;
  readonly is_business_name_detected?: boolean | null;
};

type PlaidIdentityMatchAccount = {
  readonly account_id?: string;
  readonly mask?: string | null;
  readonly name?: string | null;
  readonly official_name?: string | null;
  readonly legal_name?: PlaidLegalNameMatch | null;
};

type PlaidIdentityMatchResponse = {
  readonly accounts?: readonly PlaidIdentityMatchAccount[];
  readonly request_id?: string;
};

type PlaidIdentityOwner = { readonly names?: readonly string[] };
type PlaidIdentityAccount = {
  readonly account_id?: string;
  readonly owners?: readonly PlaidIdentityOwner[];
};
type PlaidIdentityResponse = {
  readonly accounts?: readonly PlaidIdentityAccount[];
  readonly request_id?: string;
};

export type ProviderNameCheck = {
  /** The provider slug. Present only when the provider actually answered. */
  readonly provider: string;
  /** Plaid's own 0..100 opinion. Kept alongside ours, never merged with it. */
  readonly providerScore: number;
  /**
   * The institution's record of the holder name, when `/identity/get`
   * surfaced it. Plaid's match endpoint does not return the name it matched
   * against — it returns a score — so this is fetched separately and is
   * `null` when that call was not made or found nothing.
   */
  readonly holderName: string | null;
  readonly accountId: string;
  readonly accountMask: string | null;
  readonly isFirstOrLastNameMatch: boolean | null;
  readonly isNicknameMatch: boolean | null;
  readonly isBusinessNameDetected: boolean | null;
  readonly requestId: string | null;
};

export type IdentityCheckResult =
  | { readonly available: true; readonly check: ProviderNameCheck }
  | { readonly available: false; readonly reason: string };

export interface IdentityNameSource {
  /**
   * Ask the institution what name is on the account behind `accessToken`.
   *
   * Returns `available: false` rather than throwing for every failure mode,
   * including "there is no access token for this payee", which is the normal
   * case and not an error.
   */
  match(input: {
    readonly accessToken: string;
    readonly accountId?: string | undefined;
    readonly legalName: string;
  }): Promise<IdentityCheckResult>;
}

export interface PlaidIdentityConfig {
  readonly clientId?: string | undefined;
  readonly secret?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * Whether to also call `/identity/get` for the name itself. On by default:
   * a score with no name beside it is a number a person cannot check, and the
   * whole point of showing a close match is letting somebody read both.
   */
  readonly fetchHolderName?: boolean | undefined;
}

/**
 * Plaid's identity match, as a name source.
 *
 * Credentials read at CALL time (the repo rule), sent as HEADERS and never as
 * body fields — `../rails/plaid/client.ts` has the argument, and it is that a
 * payload dump in a log line or an error report must not be able to contain
 * the secret.
 *
 * DEGRADES, NEVER THROWS.
 */
export class PlaidIdentityNameSource implements IdentityNameSource {
  readonly #config: PlaidIdentityConfig;

  constructor(config: PlaidIdentityConfig = {}) {
    this.#config = config;
  }

  async match(input: {
    readonly accessToken: string;
    readonly accountId?: string | undefined;
    readonly legalName: string;
  }): Promise<IdentityCheckResult> {
    const clientId = this.#config.clientId ?? process.env["PLAID_CLIENT_ID"];
    const secret = this.#config.secret ?? process.env["PLAID_SECRET"];
    if (clientId === undefined || secret === undefined) {
      return { available: false, reason: "no Plaid credentials are configured" };
    }
    if (input.legalName.trim().length === 0) {
      return { available: false, reason: "no name was supplied to match" };
    }

    const body = await this.#post<PlaidIdentityMatchResponse>("/identity/match", {
      access_token: input.accessToken,
      user: { legal_name: input.legalName },
    });
    if (body === null) return { available: false, reason: "Plaid did not answer /identity/match" };

    const account =
      input.accountId === undefined
        ? body.accounts?.[0]
        : body.accounts?.find((a) => a.account_id === input.accountId);

    if (account === undefined || account.account_id === undefined) {
      return { available: false, reason: "the Item holds no such account" };
    }

    const score = account.legal_name?.score;
    if (typeof score !== "number") {
      // Plaid returns `score: null` when it has no name on file for the
      // account. That is "not checked", not "no match", and the difference is
      // the same one `directory.ts` makes about `not_listed`.
      return { available: false, reason: "the institution holds no name for this account" };
    }

    const holderName = this.#config.fetchHolderName === false
      ? null
      : await this.#holderName(input.accessToken, account.account_id);

    return {
      available: true,
      check: {
        provider: PLAID_IDENTITY_MATCH_PROVIDER,
        providerScore: score,
        holderName,
        accountId: account.account_id,
        accountMask: account.mask ?? null,
        isFirstOrLastNameMatch: account.legal_name?.is_first_name_or_last_name_match ?? null,
        isNicknameMatch: account.legal_name?.is_nickname_match ?? null,
        isBusinessNameDetected: account.legal_name?.is_business_name_detected ?? null,
        requestId: body.request_id ?? null,
      },
    };
  }

  /** `/identity/get`, for the name itself. Failure is `null`, never a throw. */
  async #holderName(accessToken: string, accountId: string): Promise<string | null> {
    const body = await this.#post<PlaidIdentityResponse>("/identity/get", {
      access_token: accessToken,
    });
    const account = body?.accounts?.find((a) => a.account_id === accountId);
    return account?.owners?.[0]?.names?.[0] ?? null;
  }

  async #post<T>(path: string, payload: Record<string, unknown>): Promise<T | null> {
    const clientId = this.#config.clientId ?? process.env["PLAID_CLIENT_ID"];
    const secret = this.#config.secret ?? process.env["PLAID_SECRET"];
    if (clientId === undefined || secret === undefined) return null;

    const fetchImpl = this.#config.fetchImpl ?? globalThis.fetch;
    const baseUrl =
      this.#config.baseUrl ?? process.env["PLAID_BASE_URL"] ?? PLAID_SANDBOX_BASE_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs ?? 8_000);

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "PLAID-CLIENT-ID": clientId,
          "PLAID-SECRET": secret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The name source for a payee nobody has linked — which is nearly all of them.
 *
 * Not a stub and not a mock: it is the truthful implementation of "there is
 * no third party to ask about this destination", and it is what makes
 * `payer_asserted` the default rather than something a caller has to
 * remember to set.
 */
export const NO_IDENTITY_SOURCE: IdentityNameSource = {
  match: () =>
    Promise.resolve({
      available: false,
      reason:
        "This payee is not an account anyone has linked to us, and no US provider can " +
        "return the name on a third party's account from its number alone.",
    }),
};
