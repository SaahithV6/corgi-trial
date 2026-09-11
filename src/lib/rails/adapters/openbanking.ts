/**
 * Plaid, behind the contract — with four of the five operations refused.
 *
 * ─── THIS DOES NOT MAKE PLAID A `PaymentRail` ───────────────────────────────
 *
 * `plaid/types.ts` carries a boxed argument that Plaid must never be bolted
 * onto `PaymentRail`, because that would mean "four methods that all throw plus
 * a capabilities block claiming supportsCredit". That argument is right and
 * this file does not contradict it: Plaid has no `originate`, no `observe`, no
 * settlement and no reversal, and none of those absences is a method that
 * throws. They are four `{ supported: false, reason }` entries and four methods
 * that do not exist.
 *
 * What it does have is the fifth operation. "Is this integration live, and is
 * what it produces evidence of anything" is asked of Plaid exactly as it is
 * asked of Lithic, and before this adapter the only answer inside this package
 * was none — the Plaid probe lived in `src/lib/integrations/probe.ts` and
 * nothing in `rails/` could report on the biggest live integration it contains.
 *
 * So Plaid is in the contract at the width it genuinely has: 1 of 5. A
 * capability matrix whose most-refused row is the one integration everybody
 * assumes is a payment rail is worth more than a matrix that quietly leaves it
 * out.
 *
 * ─── WHY `observe` IS FALSE WHEN PLAID DOES SEND WEBHOOKS ───────────────────
 *
 * It sends plenty — `ITEM_LOGIN_REQUIRED`, `NEW_ACCOUNTS_AVAILABLE`,
 * `PENDING_EXPIRATION` — and this deployment receives and verifies them
 * (ES256 JWT, per-`kid` key cache, in `src/lib/webhooks/route-handler.ts`).
 * None of them is about money. `observe` in this contract means "turn a
 * verified delivery into a normalised fact about MONEY", and normalising
 * "this Item's credentials went stale" into a seven-member union whose members
 * are settled, returned and failed would be a category error with a `Money`
 * field attached to it.
 */

import {
  makeRailProbe,
  type RailAdapter,
  type RailIdentity,
  type RailProbe,
  type RailProbeOptions,
  type RailSupport,
} from '../contract';
import { PLAID_PROVIDER, PLAID_SANDBOX_BASE_URL } from '../plaid/types';
import { livenessFromStatus, readEnvValue, timedFetch } from './probe-http';

const PLAID_SUPPORT: RailSupport = {
  originate: {
    supported: false,
    reason:
      'Plaid cannot move a cent. It turns a bank login into an Item handle plus a routing and account number that some OTHER rail originates against.',
  },
  observe: {
    supported: false,
    reason:
      'Plaid’s webhooks are about the Item, not about money — ITEM_LOGIN_REQUIRED, PENDING_EXPIRATION. They are received and verified upstream; none of them normalises into a money event.',
  },
  settle: {
    supported: false,
    reason: 'Nothing settles. The ACH rail settles the transfer Plaid’s numbers made possible.',
  },
  reverse: {
    supported: false,
    reason: 'Nothing to reverse. The return code arrives on the rail that moved the money.',
  },
  probe: {
    supported: true,
    proof: 'measured',
    evidence:
      'POST /institutions/get with a fixed, well-formed body, so the only thing that can fail it is the credential. Measured: correct creds 200; wrong creds 400 INVALID_API_KEYS; a placeholder 400 INVALID_FIELD; the 11th call in a minute 429 INSTITUTIONS_GET_LIMIT.',
  },
};

/**
 * The open-banking adapter.
 *
 * `environment` separates a sandbox Item from a real customer's bank login.
 * Plaid moves no money, so that is not the sandbox-versus-production-money
 * distinction it is on the other rails — it is the one about whose credentials
 * are being handled, which matters at least as much.
 */
export function plaidOpenBankingAdapter(
  args: { readonly env?: Readonly<Record<string, string | undefined>> | undefined } = {},
): RailAdapter {
  const env = args.env ?? process.env;
  const baseUrl = (readEnvValue(env, 'PLAID_BASE_URL') ?? PLAID_SANDBOX_BASE_URL).replace(/\/+$/, '');
  const identity: RailIdentity = {
    slot: 'open_banking',
    provider: PLAID_PROVIDER,
    title: 'Plaid account linking',
    evidence: 'live',
    environment: baseUrl.includes('sandbox') ? 'sandbox' : 'production',
  };

  return {
    identity,
    supports: PLAID_SUPPORT,

    async probe(opts: RailProbeOptions = {}): Promise<RailProbe> {
      const clientId = readEnvValue(env, 'PLAID_CLIENT_ID');
      const secret = readEnvValue(env, 'PLAID_SECRET');
      if (clientId === undefined || secret === undefined) {
        return makeRailProbe(identity, {
          liveness: 'not_configured',
          detail: 'PLAID_CLIENT_ID/PLAID_SECRET absent',
          ms: 0,
        });
      }

      const { res, ms, err } = await timedFetch(
        `${baseUrl}/institutions/get`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // A CONSTANT body. The only variable left is the credential, which
          // is what makes a 400 here unambiguous.
          body: JSON.stringify({ client_id: clientId, secret, count: 1, offset: 0, country_codes: ['US'] }),
        },
        opts,
      );

      if (res === null) {
        return makeRailProbe(identity, { liveness: 'unreachable', detail: err ?? 'no response', ms });
      }

      // Plaid validates request SHAPE before credentials, so a 400 here is the
      // credential and nothing else — which is why this rail, alone, does NOT
      // use the shared 400-means-live rule. A placeholder such as
      // "your_plaid_client_id_here" produces 400 INVALID_FIELD, and reading
      // that as live is exactly the failure the enumerated table elsewhere
      // exists to prevent.
      if (res.status === 400) {
        const body = (await res.json().catch(() => null)) as { error_code?: string } | null;
        return makeRailProbe(identity, {
          liveness: 'unauthorised',
          detail: `credentials rejected (${body?.error_code ?? '400'})`,
          ms,
        });
      }

      if (res.status === 429) {
        const body = (await res.json().catch(() => null)) as { error_code?: string } | null;
        return makeRailProbe(identity, {
          liveness: 'rate_limited',
          detail: `POST /institutions/get -> 429 ${body?.error_code ?? 'RATE_LIMIT_EXCEEDED'} — the credential was never evaluated`,
          ms,
        });
      }

      return makeRailProbe(identity, {
        liveness: livenessFromStatus(res.status),
        detail: `POST /institutions/get -> ${res.status}`,
        ms,
      });
    },
  };
}
