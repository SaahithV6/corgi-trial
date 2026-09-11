/**
 * Increase's wire API, spoken directly.
 *
 * ─── WHY THIS IS NOT `IncreaseAchRail` WITH A DIFFERENT PATH ────────────────
 *
 * MEASURED 2026-09-11. The first attempt at `POST /wire_transfers` sent the
 * fields the ACH client sends and the fields every published example used to
 * carry, and got back a 400 that is worth quoting in full because it is the
 * whole reason this file exists:
 *
 *   message_to_recipient: Unexpected parameter.
 *   remittance:           Required parameter.
 *   beneficiary_name:     Unexpected parameter.
 *   creditor:             Required parameter.
 *
 * Increase's wire endpoint has moved to ISO 20022 nouns — `creditor`,
 * `debtor`, `remittance` — while the ACH endpoint has not. `beneficiary_name`
 * and `message_to_recipient` still come BACK on the response object as
 * compatibility aliases, and are rejected on the way in. An adapter that
 * assumed one provider means one request shape would have shipped a rail that
 * 400s on every call, and the only way to find that out is to make the call.
 *
 * ─── WHAT EACH METHOD IS, AND WHETHER IT IS REAL ────────────────────────────
 *
 *   createTransfer        REAL. POST /wire_transfers.
 *   getTransfer           REAL. GET /wire_transfers/{id}.
 *   getInboundTransfer    REAL. GET /inbound_wire_transfers/{id}.
 *   reverseInboundTransfer REAL, and deliberately named without "simulate":
 *                         POST /inbound_wire_transfers/{id}/reverse is a
 *                         PRODUCTION method. It is this bank sending a
 *                         received wire back out, not a sandbox affordance.
 *                         MEASURED: 200, reason `creditor_request`.
 *   simulateSubmit        SANDBOX ONLY. POST /simulations/wire_transfers/
 *                         {id}/submit. Plays the Fed accepting the message.
 *   simulateInbound       SANDBOX ONLY. POST /simulations/inbound_wire_
 *                         transfers. Plays another bank sending us money.
 *   simulateReverse       SANDBOX ONLY. POST /simulations/wire_transfers/
 *                         {id}/reverse. Plays the BENEFICIARY'S bank sending
 *                         our money back — see ./types.ts for why that is not
 *                         the same thing as us reversing anything.
 *
 * The `simulate` prefix is load-bearing. Those three play the counterparty;
 * the rest instruct the bank. A method that blurred the two would let a demo
 * present a simulated arrival as a real one.
 *
 * ─── NO WEBHOOK VERIFICATION HERE ───────────────────────────────────────────
 *
 * Same rule as ../types.ts: `src/lib/webhooks/inbox.ts` owns the one Standard
 * Webhooks verifier and the provider registry. By the time this module sees a
 * body the bytes are already authenticated.
 */

import { RailError, type Evidence, type Money } from '../types';

import {
  WIRE_PROVIDER,
  type IncreaseInboundWireTransfer,
  type IncreaseWireTransfer,
  type WireInstruction,
} from './types';

/** Same host constant the ACH client uses, restated rather than imported. */
export const INCREASE_WIRE_SANDBOX_BASE_URL = 'https://sandbox.increase.com';

/**
 * `creditor.name`, measured. 140 is a 200; 141 is a 400 naming the field.
 *
 * Not 22. That is ACH's `individual_name`, a Nacha field, and assuming one
 * provider means one field length is the same mistake as assuming one provider
 * means one request shape — which this endpoint already punished once.
 */
export const WIRE_CREDITOR_NAME_MAX = 140;

export interface IncreaseWireClientOptions {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** Sandbox unless the base URL says otherwise. See `environment`. */
  readonly evidence?: Evidence | undefined;
  /** Per-request ceiling. Defaults to 30s; see `#request`. */
  readonly timeoutMs?: number | undefined;
}

function readEnv(
  env: Readonly<Record<string, string | undefined>>,
  key: string,
): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Increase's error bodies are RFC 9457 problem details.
 *
 * The three fields are read for the message and the rest is preserved on
 * `RailError.raw`, because a normalised error that discards the provider's own
 * words is a support ticket nobody can answer.
 */
interface ProblemDetails {
  readonly type?: string;
  readonly title?: string;
  readonly detail?: string | null;
  readonly status?: number;
}

function problemMessage(body: unknown, fallback: string): string {
  if (typeof body !== 'object' || body === null) return fallback;
  const p = body as ProblemDetails;
  const parts = [p.title, p.detail].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  return parts.length > 0 ? parts.join(' ') : fallback;
}

/**
 * `retryable` is decided by the status and NEVER by the message.
 *
 * A 429 or a 5xx may be retried with the SAME idempotency key. A 400 or a 422
 * is our request being wrong, and retrying it fails again more expensively —
 * which the measured 400 above proves is the common case on this endpoint.
 */
function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export class IncreaseWireClient {
  readonly #key: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly evidence: Evidence;

  constructor(opts: IncreaseWireClientOptions = {}) {
    const env = opts.env ?? process.env;
    this.#key = opts.apiKey ?? readEnv(env, 'INCREASE_API_KEY');
    this.#baseUrl = (
      opts.baseUrl ??
      readEnv(env, 'INCREASE_BASE_URL') ??
      INCREASE_WIRE_SANDBOX_BASE_URL
    ).replace(/\/+$/, '');
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    // Sandbox is still Increase's own system, so the evidence is `live`. What
    // separates sandbox money from real money is the environment, not the
    // evidence — ../types.ts is explicit about that distinction.
    this.evidence = opts.evidence ?? 'live';
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  get configured(): boolean {
    return this.#key !== undefined;
  }

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string; signal?: AbortSignal } = {},
  ): Promise<T> {
    if (this.#key === undefined) {
      throw new RailError('INCREASE_API_KEY is not set; the wire rail has no credential', {
        provider: WIRE_PROVIDER,
        code: 'not_configured',
        retryable: false,
        evidence: this.evidence,
      });
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#key}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    // Idempotency-Key is OUR clientReferenceId. A replay with identical
    // parameters returns the ORIGINAL object and a 200; a replay with
    // different parameters is a 409 and a bug in our key generation, never a
    // retry. This is the same contract the ACH client documents.
    if (opts.idempotencyKey !== undefined) headers['Idempotency-Key'] = opts.idempotencyKey;

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
        // A caller's signal wins; otherwise a timeout, ALWAYS.
        //
        // This was the only HTTP client in the repo with no timeout, on the one
        // rail where money cannot be recovered. Every other provider client
        // sets `AbortSignal.timeout(...)` — Persona, Stripe, GLEIF, the KYB
        // wire, and this file's own `probe()`, which sidestepped `#request`
        // and used `timedFetch`. So the gap was on the money-moving calls
        // specifically and on nothing else.
        //
        // Without it, a hung connection to Increase leaves an originate
        // request outstanding with no bound: the request either completes or
        // does not, and we never learn which. For a Fedwire transfer that is
        // the worst state available — it has no return window, so "did it
        // send?" cannot be answered by waiting.
        //
        // 30s rather than the 15s the KYB clients use: this call ORIGINATES a
        // payment. Timing out a read costs a retry; timing out a write while
        // the far side is still committing costs certainty. The idempotency
        // key makes the retry safe, and a longer bound makes it rarer.
        signal: opts.signal ?? AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new RailError(
        `${method} ${path} did not reach Increase: ${error instanceof Error ? error.message : String(error)}`,
        {
          provider: WIRE_PROVIDER,
          code: 'network_error',
          retryable: true,
          evidence: this.evidence,
          raw: error,
        },
      );
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      throw new RailError(problemMessage(parsed, `${method} ${path} -> ${res.status}`), {
        provider: WIRE_PROVIDER,
        code: `http_${res.status}`,
        httpStatus: res.status,
        retryable: retryableStatus(res.status),
        evidence: this.evidence,
        raw: parsed,
      });
    }

    return parsed as T;
  }

  /* ---------------------------------------------------------------------- */
  /* Real methods                                                           */
  /* ---------------------------------------------------------------------- */

  /**
   * Instruct a wire.
   *
   * The body is the measured shape and every field in it was demanded by a
   * real 400 rather than read off a page:
   *
   *   creditor.name                    required. The beneficiary.
   *   remittance.category              required. 'unstructured' | 'tax'.
   *   remittance.unstructured.message  required WHEN category is unstructured.
   *   routing_number + account_number  "exactly one of external_account or
   *                                     routing_number", then "exactly one of
   *                                     external_account or account_number" —
   *                                     two separate 400s, one per field.
   *
   * The amount is `Number(...)` at exactly this line and nowhere else, and it
   * is guarded: a wire large enough to leave the safe-integer range is a bug
   * in the caller, not a number to truncate.
   */
  async createTransfer(
    instruction: WireInstruction,
    opts: { signal?: AbortSignal } = {},
  ): Promise<IncreaseWireTransfer> {
    if (instruction.amount.currency !== 'USD') {
      throw new RailError(
        `a Fedwire funds transfer is USD; refusing ${instruction.amount.currency}`,
        {
          provider: WIRE_PROVIDER,
          code: 'currency_not_supported',
          retryable: false,
          evidence: this.evidence,
        },
      );
    }
    if (instruction.amount.amount <= 0n) {
      throw new RailError('a wire amount must be a positive integer number of cents', {
        provider: WIRE_PROVIDER,
        code: 'invalid_amount',
        retryable: false,
        evidence: this.evidence,
      });
    }
    if (instruction.amount.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new RailError('wire amount exceeds the safe integer range the provider accepts', {
        provider: WIRE_PROVIDER,
        code: 'amount_out_of_range',
        retryable: false,
        evidence: this.evidence,
      });
    }
    // MEASURED 2026-09-11 by binary search against the sandbox: 140 characters
    // is a 200, 141 is a 400 reading `creditor.name: Maximum length is 140.`
    // The payee book allows `holderName` up to 200, so the gap is real.
    //
    // REFUSED, NOT TRUNCATED, and the difference from the ACH path is
    // deliberate. `individual_name` on an ACH entry is a 22-character Nacha
    // field that almost no legal name fits, so truncating there is the only
    // workable answer and the adapter does it. 140 is generous: a beneficiary
    // name that does not fit is a data problem, and silently shortening one on
    // an IRREVOCABLE payment would change who the message is addressed to,
    // after two humans approved the instruction that named them. The remedy is
    // for a person to shorten it on the payee record, on purpose.
    if (instruction.beneficiary.name.length > WIRE_CREDITOR_NAME_MAX) {
      throw new RailError(
        `beneficiary name is ${instruction.beneficiary.name.length} characters; Increase accepts at most ${WIRE_CREDITOR_NAME_MAX} on creditor.name. Nothing was sent. Shorten the name on the payee record rather than here — truncating a beneficiary on an irrevocable payment changes who it is addressed to.`,
        {
          provider: WIRE_PROVIDER,
          code: 'beneficiary_name_too_long',
          retryable: false,
          evidence: this.evidence,
        },
      );
    }

    return this.#request<IncreaseWireTransfer>('POST', '/wire_transfers', {
      idempotencyKey: instruction.clientReferenceId,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
      body: {
        account_id: instruction.sourceAccountId,
        amount: Number(instruction.amount.amount),
        creditor: { name: instruction.beneficiary.name },
        remittance: {
          category: 'unstructured',
          unstructured: { message: instruction.remittance },
        },
        // THE WIRE VARIANT. See `WireBeneficiary.wireRoutingNumber`.
        routing_number: instruction.beneficiary.wireRoutingNumber,
        account_number: instruction.beneficiary.accountNumber,
      },
    });
  }

  /** The authoritative read-back. Webhooks are pointers; this is the fact. */
  getTransfer(id: string, opts: { signal?: AbortSignal } = {}): Promise<IncreaseWireTransfer> {
    return this.#request<IncreaseWireTransfer>('GET', `/wire_transfers/${encodeURIComponent(id)}`, opts);
  }

  getInboundTransfer(
    id: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<IncreaseInboundWireTransfer> {
    return this.#request<IncreaseInboundWireTransfer>(
      'GET',
      `/inbound_wire_transfers/${encodeURIComponent(id)}`,
      opts,
    );
  }

  /**
   * Send a received wire back out. NOT a simulation.
   *
   * MEASURED: 200, and the object comes back `status: "reversed"` with
   * `reversal: { reason: "creditor_request", reversed_at }`. The creditor is
   * us. This is an ORIGINATION in the opposite direction dressed as a verb on
   * the arrival, and the ledger treats it as one: see `debitReturnedInboundWire`
   * in ./ledger.ts, which takes money out of the customer on the day we sent
   * it back and leaves the day it arrived exactly as it was.
   */
  reverseInboundTransfer(
    id: string,
    reason: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<IncreaseInboundWireTransfer> {
    return this.#request<IncreaseInboundWireTransfer>(
      'POST',
      `/inbound_wire_transfers/${encodeURIComponent(id)}/reverse`,
      { body: { reason }, ...opts },
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Sandbox affordances — these play the COUNTERPARTY, never us            */
  /* ---------------------------------------------------------------------- */

  /**
   * Play the Federal Reserve accepting the message.
   *
   * MEASURED: one call takes the transfer from `pending_creating` straight to
   * `complete`, with a `submission.input_message_accountability_data` and a
   * `transaction_id`. There is no intermediate day and no settlement object —
   * which is the finding, not a sandbox shortcut. See ./semantics.ts.
   */
  simulateSubmit(id: string, opts: { signal?: AbortSignal } = {}): Promise<IncreaseWireTransfer> {
    return this.#request<IncreaseWireTransfer>(
      'POST',
      `/simulations/wire_transfers/${encodeURIComponent(id)}/submit`,
      { body: {}, ...opts },
    );
  }

  /**
   * Play the BENEFICIARY'S bank sending the money back.
   *
   * Named `simulate` and placed among the counterparty affordances on purpose.
   * There is no non-simulated sibling for this and there never will be: we
   * cannot make a beneficiary's bank return a wire, which is precisely what
   * `supports.reverse === false` says.
   */
  simulateReverse(id: string, opts: { signal?: AbortSignal } = {}): Promise<IncreaseWireTransfer> {
    return this.#request<IncreaseWireTransfer>(
      'POST',
      `/simulations/wire_transfers/${encodeURIComponent(id)}/reverse`,
      { body: {}, ...opts },
    );
  }

  /**
   * Play another bank wiring us money.
   *
   * MEASURED: the endpoint accepts `account_number_id` and `amount` and
   * NOTHING else — `debtor`, `remittance`, `originator_name` and
   * `originator_routing_number` were each rejected by name with "Unexpected
   * parameter." So the debtor on a simulated arrival is Increase's own fixed
   * fixture (debtor_routing_number 101050001) and cannot be chosen. That is a
   * limit of the sandbox and it is stated here rather than worked around,
   * because a caller that believed it could set the sender would be building
   * a payee-matching feature on a value it does not control.
   */
  simulateInbound(
    args: { readonly accountNumberId: string; readonly amount: Money },
    opts: { signal?: AbortSignal } = {},
  ): Promise<IncreaseInboundWireTransfer> {
    if (args.amount.currency !== 'USD') {
      throw new RailError(`an inbound wire is USD; refusing ${args.amount.currency}`, {
        provider: WIRE_PROVIDER,
        code: 'currency_not_supported',
        retryable: false,
        evidence: this.evidence,
      });
    }
    return this.#request<IncreaseInboundWireTransfer>(
      'POST',
      '/simulations/inbound_wire_transfers',
      {
        body: {
          account_number_id: args.accountNumberId,
          amount: Number(args.amount.amount),
        },
        ...opts,
      },
    );
  }
}
