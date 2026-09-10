/**
 * The webhook inbox: one table, one ingestion path, one verifier per provider.
 *
 * Contract for every provider route handler, in this order and no other:
 *
 *   1. read the RAW body bytes            (rawbody.ts — before any parsing)
 *   2. verify the signature over them     (the verifier registered for this provider)
 *   3. persist the raw event              (INSERT ... ON CONFLICT DO NOTHING)
 *   4. return 2xx immediately             (Plaid gives us 10s; Lithic/Increase retry on non-2xx)
 *   5. process out of band                (dispatch.ts, from a cron/queue — never inline)
 *
 * Replay is a no-op decided by Postgres, not by application code:
 * `UNIQUE (provider, provider_event_id)` plus `ON CONFLICT DO NOTHING`, and the
 * number of rows the INSERT returned is what tells us whether this delivery was
 * the first one. There is no SELECT-then-INSERT anywhere, because that has a
 * race between the two statements and this does not.
 *
 * See db/migrations/0002_webhook_inbox.sql for the table and README.md for the
 * reasoning and the wiring.
 */

import {
  constantTimeEquals,
  parseVerifiedJson,
  readRawDelivery,
  sha256Hex,
  toHeaderLookup,
  WebhookPayloadParseError,
  type HeaderLookup,
  type RawRequest,
} from './rawbody';
import { createHmac, createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';

// ---------------------------------------------------------------------------
// 1. Row shape
// ---------------------------------------------------------------------------

/**
 * Provider names are plain strings, not a union or a database enum, so that
 * adding a fifth provider is a registration and a migration-free deploy.
 * The values in use today: 'lithic' | 'increase' | 'plaid' | 'persona'
 * (and 'stripe' for the business-registry leg — see README §6).
 */
export type ProviderName = string;

/** The four states an inbox row can be in. Ours, so this one IS an enum. */
export type InboxState = 'pending' | 'parked' | 'done' | 'dead';

export interface InboxEvent {
  /** uuid, matching the ledger's convention (journal_entry.inbox_id). */
  id: string;
  provider: ProviderName;
  providerEventId: string;
  /** Provider vocabulary, e.g. 'card_transaction.updated'. Null if unparseable. */
  eventType: string | null;
  payload: unknown;
  /** Only the signature-bearing headers. Never Authorization, never cookies. */
  headers: Record<string, string>;
  /** The exact bytes we verified. Kept so a signature can be re-checked later. */
  rawBody: string;
  receivedAt: Date;
  signatureVerifiedAt: Date;
  state: InboxState;
  /** Times the dispatcher has picked this row up (parks included). */
  attempts: number;
  /** Times the dispatcher has parked this row waiting for a referent. */
  parkAttempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  processedAt: Date | null;
  parkedOnKind: string | null;
  parkedOnRef: string | null;
  parkedReason: string | null;
  processingError: string | null;
  deadLetteredAt: Date | null;
}

export interface NewInboxEvent {
  provider: ProviderName;
  providerEventId: string;
  eventType: string | null;
  payload: unknown;
  headers: Record<string, string>;
  rawBody: string;
  receivedAt: Date;
  signatureVerifiedAt: Date;
  /** 'pending' normally; 'dead' for a verified body we cannot even parse. */
  state?: Extract<InboxState, 'pending' | 'dead'> | undefined;
  processingError?: string | null | undefined;
}

/** A thing an event can refer to. `kind` is the consumer's vocabulary
 *  ('card_authorization', 'ach_transfer', 'business'), `ref` the provider id. */
export interface EntityRef {
  kind: string;
  ref: string;
}

// ---------------------------------------------------------------------------
// 2. Verifiers: one per provider, registered by name
// ---------------------------------------------------------------------------

export interface VerifyInput {
  raw: string;
  headers: HeaderLookup;
  now: Date;
}

export type VerifyOutcome = { ok: true } | { ok: false; reason: string };

export interface IdentifyInput {
  raw: string;
  headers: HeaderLookup;
  payload: unknown;
}

export interface EventIdentity {
  providerEventId: string;
  eventType: string | null;
}

export interface WebhookVerifier {
  readonly provider: ProviderName;
  /** Headers to persist with the row. Everything else is dropped. */
  readonly signatureHeaders: readonly string[];
  /** Authenticate the RAW bytes. Must not parse them. */
  verify(input: VerifyInput): Promise<VerifyOutcome> | VerifyOutcome;
  /** Post-verification, post-parse sanity check (e.g. Plaid's `environment`). */
  accept?(input: IdentifyInput): VerifyOutcome;
  /** Pull the provider's stable event id and event type out of the delivery. */
  identify(input: IdentifyInput): EventIdentity;
  /**
   * The event id from headers alone, when the provider puts it there.
   * Lets us still file a verified-but-unparseable body instead of losing it.
   */
  identifyFromHeaders?(headers: HeaderLookup): string | null;
}

export class VerifierRegistry {
  private readonly byProvider = new Map<ProviderName, WebhookVerifier>();

  register(verifier: WebhookVerifier, opts: { replace?: boolean } = {}): this {
    const existing = this.byProvider.get(verifier.provider);
    if (existing && !opts.replace) {
      // Silent last-wins registration is how two workers ship two verifiers for
      // the same provider and nobody notices which one is live.
      throw new Error(
        `a verifier is already registered for provider '${verifier.provider}'; pass { replace: true } if that is deliberate`,
      );
    }
    this.byProvider.set(verifier.provider, verifier);
    return this;
  }

  get(provider: ProviderName): WebhookVerifier | undefined {
    return this.byProvider.get(provider);
  }

  providers(): ProviderName[] {
    return [...this.byProvider.keys()].sort();
  }
}

/** The process-wide registry. Wire it once at startup; see README §6. */
export const verifiers = new VerifierRegistry();

// --- 2a. Standard Webhooks (Lithic, Increase) ------------------------------

export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface StandardWebhooksOptions {
  provider: ProviderName;
  /** The signing secret exactly as the provider gave it to us. */
  secret: string | readonly string[];
  /**
   * How to turn the secret string into HMAC key bytes.
   * - 'base64': strip a leading `whsec_` and base64-DECODE the rest. This is
   *   what the Standard Webhooks spec says and what Lithic's SDK does.
   * - 'utf8': use the secret string's bytes as-is. This is what Increase's own
   *   reference implementation does with the Event Subscription shared_secret.
   * Getting this wrong produces a verifier that rejects every real delivery,
   * so it is an explicit argument rather than a guess.
   */
  secretEncoding: 'base64' | 'utf8';
  toleranceSeconds?: number | undefined;
  identify: (input: IdentifyInput) => EventIdentity;
}

const STANDARD_WEBHOOK_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const;

export function standardWebhooksVerifier(opts: StandardWebhooksOptions): WebhookVerifier {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const keys = (Array.isArray(opts.secret) ? opts.secret : [opts.secret as string]).map((s) =>
    opts.secretEncoding === 'base64'
      ? Buffer.from(s.replace(/^whsec_/, ''), 'base64')
      : Buffer.from(s, 'utf8'),
  );

  return {
    provider: opts.provider,
    signatureHeaders: STANDARD_WEBHOOK_HEADERS,

    verify({ raw, headers, now }: VerifyInput): VerifyOutcome {
      const id = headers('webhook-id');
      const timestamp = headers('webhook-timestamp');
      const signature = headers('webhook-signature');
      if (!id || !timestamp || !signature) {
        return { ok: false, reason: 'missing webhook-id / webhook-timestamp / webhook-signature' };
      }

      const drift = timestampDriftSeconds(timestamp, now);
      if (drift === null) return { ok: false, reason: 'webhook-timestamp is not a unix second count' };
      if (drift > tolerance) return { ok: false, reason: `timestamp too old (${drift}s > ${tolerance}s)` };
      if (drift < -tolerance) return { ok: false, reason: `timestamp too far in the future (${-drift}s)` };

      // The signed content is id.timestamp.RAW BODY. Note `raw`, not a
      // re-serialisation of the parsed body — see rawbody.ts.
      const signedContent = `${id}.${timestamp}.${raw}`;
      const expected = keys.map((key) =>
        createHmac('sha256', key).update(signedContent, 'utf8').digest('base64'),
      );

      // The header holds one or more space-separated `v1,<base64>` entries;
      // more than one appears while a secret is being rotated. Any match wins.
      for (const entry of signature.split(' ')) {
        const comma = entry.indexOf(',');
        if (comma < 0) continue;
        const version = entry.slice(0, comma);
        const candidate = entry.slice(comma + 1);
        if (version !== 'v1') continue; // unknown scheme version: ignore, never trust
        for (const e of expected) {
          if (constantTimeEquals(candidate, e)) return { ok: true };
        }
      }
      return { ok: false, reason: 'no v1 signature matched' };
    },

    identifyFromHeaders: (headers) => headers('webhook-id'),
    identify: opts.identify,
  };
}

/**
 * Lithic. Standard Webhooks, `whsec_`-prefixed base64 secret, and the message
 * id in the `webhook-id` header (Lithic documents it as equal to event.token).
 * The POSTed body is the payload object itself, carrying its own `event_type`.
 */
export function lithicVerifier(opts: {
  secret: string | readonly string[];
  toleranceSeconds?: number | undefined;
}): WebhookVerifier {
  return standardWebhooksVerifier({
    provider: 'lithic',
    secret: opts.secret,
    secretEncoding: 'base64',
    toleranceSeconds: opts.toleranceSeconds,
    identify: ({ headers, payload }) => ({
      // Stable across Lithic's eight retry attempts, which is exactly the
      // property a dedupe key needs.
      providerEventId: headers('webhook-id') ?? '',
      eventType: readString(payload, ['event_type']),
    }),
  });
}

/**
 * Increase. Standard Webhooks with the shared_secret used as raw bytes.
 * The body is an Event object: `{ id, category, associated_object_id, ... }`.
 * We prefer the body's own `id` over `webhook-id` because it is the id the
 * Increase API and dashboard use, which makes support conversations possible.
 */
export function increaseVerifier(opts: {
  secret: string | readonly string[];
  toleranceSeconds?: number | undefined;
}): WebhookVerifier {
  return standardWebhooksVerifier({
    provider: 'increase',
    secret: opts.secret,
    secretEncoding: 'utf8',
    toleranceSeconds: opts.toleranceSeconds,
    identify: ({ headers, payload }) => ({
      providerEventId: readString(payload, ['id']) ?? headers('webhook-id') ?? '',
      eventType: readString(payload, ['category']),
    }),
  });
}

// --- 2b. Timestamped hex HMAC (Persona, Stripe) ----------------------------

export interface TimestampedHmacOptions {
  provider: ProviderName;
  /** Header carrying `t=<unix>,v1=<hex>` groups. */
  header: string;
  /** One or more secrets; more than one while rotating. */
  secret: string | readonly string[];
  /**
   * Tolerance in seconds. Persona documents `t` but publishes NO tolerance and
   * checks none in its own sample, so 300s here is OUR policy, not Persona's.
   * Stripe documents 300s.
   */
  toleranceSeconds?: number | undefined;
  identify: (input: IdentifyInput) => EventIdentity;
}

/**
 * Persona's and Stripe's schemes are the same shape: HMAC-SHA256, hex digest,
 * over `${t}.${rawBody}`. They differ only in how multiple signatures are
 * packed into the header — Persona uses space-separated `t=..,v1=..` groups
 * during rotation, Stripe uses one group with several comma-separated `v1=`
 * entries. Splitting on spaces first and commas second parses both, so one
 * implementation covers both and each `v1` is checked against the `t` of its
 * own group.
 */
export function timestampedHmacVerifier(opts: TimestampedHmacOptions): WebhookVerifier {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const secrets = Array.isArray(opts.secret) ? [...opts.secret] : [opts.secret as string];
  const headerName = opts.header.toLowerCase();

  return {
    provider: opts.provider,
    signatureHeaders: [headerName],

    verify({ raw, headers, now }: VerifyInput): VerifyOutcome {
      const header = headers(headerName);
      if (!header) return { ok: false, reason: `missing ${headerName}` };

      let sawGroup = false;
      let lastReason = 'no v1 signature matched';
      for (const group of header.split(' ')) {
        if (!group.trim()) continue;
        let timestamp: string | null = null;
        const candidates: string[] = [];
        for (const pair of group.split(',')) {
          const eq = pair.indexOf('=');
          if (eq < 0) continue;
          const k = pair.slice(0, eq).trim();
          const v = pair.slice(eq + 1).trim();
          if (k === 't') timestamp = v;
          else if (k === 'v1') candidates.push(v);
          // v0 (Stripe's test-mode extra) and any future scheme: ignored.
        }
        if (!timestamp || candidates.length === 0) continue;
        sawGroup = true;

        const drift = timestampDriftSeconds(timestamp, now);
        if (drift === null) { lastReason = 'timestamp is not a unix second count'; continue; }
        if (drift > tolerance) { lastReason = `timestamp too old (${drift}s > ${tolerance}s)`; continue; }
        if (drift < -tolerance) { lastReason = `timestamp too far in the future (${-drift}s)`; continue; }

        const signedContent = `${timestamp}.${raw}`;
        for (const secret of secrets) {
          const expected = createHmac('sha256', secret).update(signedContent, 'utf8').digest('hex');
          for (const candidate of candidates) {
            if (constantTimeEquals(candidate, expected)) return { ok: true };
          }
        }
      }
      return { ok: false, reason: sawGroup ? lastReason : `malformed ${headerName}` };
    },

    identify: opts.identify,
  };
}

/**
 * Persona. `Persona-Signature: t=<unix>,v1=<hex>`, JSON:API envelope with the
 * event id at data.id and the event name at data.attributes.name.
 */
export function personaVerifier(opts: {
  secret: string | readonly string[];
  toleranceSeconds?: number | undefined;
}): WebhookVerifier {
  return timestampedHmacVerifier({
    provider: 'persona',
    header: 'persona-signature',
    secret: opts.secret,
    toleranceSeconds: opts.toleranceSeconds,
    identify: ({ payload }) => ({
      providerEventId: readString(payload, ['data', 'id']) ?? '',
      eventType: readString(payload, ['data', 'attributes', 'name']),
    }),
  });
}

/**
 * Stripe (business-registry leg). Included to prove requirement 6: a fifth
 * provider is a verifier plus a consumer registration. Nothing in dispatch.ts
 * changed to add it.
 */
export function stripeVerifier(opts: {
  secret: string | readonly string[];
  toleranceSeconds?: number | undefined;
}): WebhookVerifier {
  return timestampedHmacVerifier({
    provider: 'stripe',
    header: 'stripe-signature',
    secret: opts.secret,
    toleranceSeconds: opts.toleranceSeconds,
    identify: ({ payload }) => ({
      providerEventId: readString(payload, ['id']) ?? '',
      eventType: readString(payload, ['type']),
    }),
  });
}

// --- 2c. Plaid: ES256 JWT over a hash of the body --------------------------

export interface PlaidJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  alg?: string;
  kid?: string;
  use?: string;
  expired_at?: number | null;
}

export interface PlaidVerifierOptions {
  /**
   * Fetch the JWK for a key id from `/webhook_verification_key/get` against the
   * SAME Plaid environment the webhook came from. Injected so this module needs
   * no Plaid client and no network in tests.
   */
  fetchVerificationKey: (kid: string) => Promise<PlaidJwk | null>;
  /** 'sandbox' during the trial. A stray production webhook must not land. */
  expectedEnvironment?: 'sandbox' | 'production' | undefined;
  toleranceSeconds?: number | undefined;
}

/**
 * Plaid signs an ES256 JWT whose payload carries `request_body_sha256`.
 * All six steps below are mandatory; dropping any one of them is a real
 * vulnerability, and step 2 is the classic algorithm-confusion defence.
 */
export function plaidVerifier(opts: PlaidVerifierOptions): WebhookVerifier {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  return {
    provider: 'plaid',
    signatureHeaders: ['plaid-verification'],

    async verify({ raw, headers, now }: VerifyInput): Promise<VerifyOutcome> {
      const token = headers('plaid-verification');
      if (!token) return { ok: false, reason: 'missing plaid-verification' };

      const parts = token.split('.');
      const [headerB64, payloadB64, signatureB64] = parts;
      if (
        parts.length !== 3 ||
        headerB64 === undefined ||
        payloadB64 === undefined ||
        signatureB64 === undefined
      ) {
        return { ok: false, reason: 'malformed JWT' };
      }

      // 1 + 2. Decode the JWT header WITHOUT trusting it, and pin the algorithm.
      let jwtHeader: { alg?: string; kid?: string };
      let claims: { iat?: number; request_body_sha256?: string };
      try {
        jwtHeader = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
        claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      } catch {
        return { ok: false, reason: 'JWT header/payload is not JSON' };
      }
      if (jwtHeader.alg !== 'ES256') return { ok: false, reason: `unexpected alg '${jwtHeader.alg}'` };
      if (!jwtHeader.kid) return { ok: false, reason: 'JWT has no kid' };

      // 3. Public key for this kid, from Plaid, cached by the caller.
      const jwk = await opts.fetchVerificationKey(jwtHeader.kid);
      if (!jwk) return { ok: false, reason: `no verification key for kid ${jwtHeader.kid}` };
      if (!isLiveKey(jwk)) return { ok: false, reason: 'verification key is expired' };

      // 4. Signature. ES256 signatures are raw r||s, which is `ieee-p1363`.
      let signatureValid = false;
      try {
        const key = createPublicKey({
          key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } as JsonWebKey,
          format: 'jwk',
        });
        signatureValid = cryptoVerify(
          'sha256',
          Buffer.from(`${headerB64}.${payloadB64}`, 'utf8'),
          { key, dsaEncoding: 'ieee-p1363' },
          Buffer.from(signatureB64, 'base64url'),
        );
      } catch (err) {
        return { ok: false, reason: `JWT signature check failed: ${String(err)}` };
      }
      if (!signatureValid) return { ok: false, reason: 'JWT signature does not verify' };

      // 5. Freshness.
      if (typeof claims.iat !== 'number') return { ok: false, reason: 'JWT has no iat' };
      const ageSeconds = Math.floor(now.getTime() / 1000) - claims.iat;
      if (ageSeconds > tolerance) return { ok: false, reason: `JWT too old (${ageSeconds}s)` };

      // 6. Body integrity, over the RAW bytes, in constant time. This is the
      // step that breaks the moment anyone re-serialises the payload.
      if (typeof claims.request_body_sha256 !== 'string') {
        return { ok: false, reason: 'JWT has no request_body_sha256' };
      }
      if (!constantTimeEquals(sha256Hex(raw), claims.request_body_sha256)) {
        return { ok: false, reason: 'body hash does not match request_body_sha256' };
      }
      return { ok: true };
    },

    accept({ payload }: IdentifyInput): VerifyOutcome {
      if (!opts.expectedEnvironment) return { ok: true };
      const env = readString(payload, ['environment']);
      if (env && env !== opts.expectedEnvironment) {
        return { ok: false, reason: `webhook environment '${env}' is not '${opts.expectedEnvironment}'` };
      }
      return { ok: true };
    },

    identify({ raw, payload }: IdentifyInput): EventIdentity {
      const type = readString(payload, ['webhook_type']);
      const code = readString(payload, ['webhook_code']);
      return {
        // Plaid ships NO event id of any kind. The dedupe key is therefore the
        // SHA-256 of the exact body — which is the value Plaid itself signed in
        // request_body_sha256, so it is stable across their 24 hours of
        // retries. The cost, stated plainly: two genuinely distinct webhooks
        // with byte-identical bodies collapse to one row. That is acceptable
        // precisely because every Plaid webhook is a "something changed, come
        // and read it" notification whose consumer re-fetches from the API, so
        // processing it once or twice reaches the same state. It would NOT be
        // acceptable for a money event carrying an amount.
        providerEventId: `sha256:${sha256Hex(raw)}`,
        eventType: type && code ? `${type}.${code}` : (type ?? code),
      };
    },
  };
}

/** Plaid marks a rotated-out key with a non-null `expired_at`. */
function isLiveKey(jwk: PlaidJwk): boolean {
  return jwk.expired_at === null || jwk.expired_at === undefined;
}

/** Per-kid cache for Plaid verification keys. Plaid rotates; their own sample
 *  caches a single key globally, which breaks on the first rotation. */
export function cachedVerificationKeys(
  fetchKey: (kid: string) => Promise<PlaidJwk | null>,
): (kid: string) => Promise<PlaidJwk | null> {
  const cache = new Map<string, PlaidJwk>();
  return async (kid: string) => {
    const hit = cache.get(kid);
    if (hit) return hit;
    const key = await fetchKey(kid);
    if (key && isLiveKey(key)) cache.set(kid, key);
    return key;
  };
}

// ---------------------------------------------------------------------------
// 3. Storage
// ---------------------------------------------------------------------------

/**
 * The narrow database port this module needs: parameterised SQL in, rows out.
 * `pg.Pool`, `@neondatabase/serverless`'s Pool, and a thin wrapper over
 * Drizzle's `db.execute` all satisfy it (README §7). Keeping it this narrow
 * means the inbox's SQL is visible in one file and reviewable line by line,
 * which matters more here than ORM ergonomics: `ON CONFLICT DO NOTHING` with a
 * row count and `FOR UPDATE SKIP LOCKED` are the whole design.
 */
export interface SqlExecutor {
  query<R = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

/**
 * The shape of a postgres.js client, structurally, so this module does not
 * import the driver. `sql.unsafe(text, params)` is postgres.js's parameterised
 * escape hatch: the SQL is ours and literal, the values are bound, so this is
 * not a string-interpolation hole.
 */
export interface PostgresJsLike {
  unsafe(query: string, params?: readonly unknown[]): PromiseLike<unknown>;
}

/**
 * Adapt the app's postgres.js client to the port above.
 *
 *   const sql = postgres(env.DATABASE_URL);
 *   const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(sql));
 *
 * postgres.js resolves a query to a RowList — an array of rows carrying a
 * `count` property, which is the row count for a RETURNING query and the
 * affected-row count otherwise. That count is what decides first-delivery
 * versus replay, so it is read explicitly rather than inferred from length.
 */
export function sqlExecutorFromPostgresJs(sql: PostgresJsLike): SqlExecutor {
  return {
    async query<R = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      const result = (await sql.unsafe(text, params)) as R[] & { count?: number };
      return { rows: [...result] as R[], rowCount: result.count ?? result.length };
    },
  };
}

export interface ClaimOptions {
  limit: number;
  now: Date;
  /** How long a claimed row is invisible to other workers. */
  leaseMs: number;
}

export interface InboxStore {
  /**
   * Insert unless (provider, provider_event_id) already exists.
   * `inserted: false` means "replay", and it is Postgres that decided so.
   */
  insertIfNew(record: NewInboxEvent): Promise<{ inserted: boolean; id: string | null }>;
  /** Oldest-first batch of due rows, leased so two workers cannot share one. */
  claimBatch(opts: ClaimOptions): Promise<InboxEvent[]>;
  markProcessed(id: string, now: Date): Promise<void>;
  park(id: string, opts: { waitingFor: EntityRef; reason: string; now: Date; nextAttemptAt: Date }): Promise<void>;
  recordFailure(id: string, opts: { error: string; now: Date; nextAttemptAt: Date }): Promise<void>;
  deadLetter(id: string, opts: { error: string; now: Date }): Promise<void>;
  /** Wake every parked row waiting on one of these refs. Returns rows woken. */
  unparkWaitingFor(refs: readonly EntityRef[], now: Date): Promise<number>;
  /** Staff action after the bug is fixed: put a dead letter back in the queue. */
  requeueDeadLetter(id: string, now: Date): Promise<boolean>;
  get(id: string): Promise<InboxEvent | null>;
  findByProviderEventId(provider: ProviderName, providerEventId: string): Promise<InboxEvent | null>;
  listDeadLetters(limit?: number): Promise<InboxEvent[]>;
  listParked(limit?: number): Promise<InboxEvent[]>;
}

const COLUMNS = `
  id, provider, provider_event_id, event_type, payload, headers, raw_body,
  received_at, signature_verified_at, state, attempts, park_attempts,
  next_attempt_at, locked_until, processed_at, parked_on_kind, parked_on_ref,
  parked_reason, processing_error, dead_lettered_at`;

export function createPostgresInboxStore(sql: SqlExecutor): InboxStore {
  const rowsToEvents = (rows: Record<string, unknown>[]) => rows.map(rowToEvent);

  return {
    async insertIfNew(record) {
      // The whole of requirement 2 is these six lines. No SELECT first, no
      // if-statement: the unique index is the decision, and `rowCount` is how
      // we learn what it decided.
      //
      // EVERY reused parameter is cast explicitly, on every use.
      //
      // $7 appears three times (received_at, next_attempt_at, and the CASE for
      // dead_lettered_at) and $9 twice (the state column and the CASE's
      // comparison). Postgres deduces a type per use site and refuses the
      // statement outright when two deductions disagree — "inconsistent types
      // deduced for parameter $N". The CASE arms are the usual culprit: a
      // bare NULL on one branch leaves the other branch's type unpinned.
      //
      // This failed ONLY in production, against a real Lithic delivery. The
      // in-memory test double used by the unit tests never parses SQL, so a
      // statement Postgres will not accept passes every test. The signature
      // verified correctly; the row simply never landed, and the route
      // answered 500 — which is right, because it makes the provider retry.
      const inserted = await sql.query<{ id: string }>(
        `insert into webhook_inbox
           (provider, provider_event_id, event_type, payload, headers, raw_body,
            received_at, signature_verified_at, state, next_attempt_at,
            processing_error, dead_lettered_at)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6,
                 $7::timestamptz, $8::timestamptz,
                 $9::webhook_inbox_state,
                 $7::timestamptz, $10,
                 case when $9::webhook_inbox_state = 'dead'
                      then $7::timestamptz else null end)
         on conflict (provider, provider_event_id) do nothing
         returning id`,
        [
          record.provider,
          record.providerEventId,
          record.eventType,
          JSON.stringify(record.payload ?? null),
          JSON.stringify(record.headers ?? {}),
          record.rawBody,
          record.receivedAt,
          record.signatureVerifiedAt,
          record.state ?? 'pending',
          record.processingError ?? null,
        ],
      );
      const insertedRow = inserted.rows[0];
      if ((inserted.rowCount ?? inserted.rows.length) > 0 && insertedRow) {
        return { inserted: true, id: insertedRow.id };
      }
      // Replay. Look the existing row up only so the caller can log an id;
      // nothing about the decision depends on this second statement.
      const existing = await sql.query<{ id: string }>(
        `select id from webhook_inbox where provider = $1 and provider_event_id = $2`,
        [record.provider, record.providerEventId],
      );
      return { inserted: false, id: existing.rows[0]?.id ?? null };
    },

    async claimBatch({ limit, now, leaseMs }) {
      // FOR UPDATE SKIP LOCKED inside the CTE: two dispatcher instances take
      // disjoint batches instead of blocking on each other. `attempts` is
      // incremented on CLAIM, not on failure, so a worker that crashes
      // mid-processing still burns an attempt and a poison event cannot loop
      // for ever. Ordering is (next_attempt_at, received_at) = oldest first,
      // matching webhook_inbox_due_idx in 0002_webhook_inbox.sql.
      //
      // Parked rows are claimed too, once their re-check time arrives, and the
      // claim moves them back to 'pending'. That timer is the safety net under
      // unparkWaitingFor: a park never depends on another event turning up for
      // the row to be looked at again.
      const claimed = await sql.query(
        `with due as (
           select id
           from webhook_inbox
           where state in ('pending', 'parked')
             and next_attempt_at <= $1
             and (locked_until is null or locked_until <= $1)
           order by next_attempt_at, received_at
           limit $2
           for update skip locked
         )
         update webhook_inbox w
         set attempts = w.attempts + 1,
             state = 'pending',
             locked_until = $1::timestamptz + make_interval(secs => $3::double precision)
         from due
         where w.id = due.id
         returning ${COLUMNS}`,
        [now, limit, leaseMs / 1000],
      );
      return rowsToEvents(claimed.rows).sort(
        (a, b) =>
          a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
          a.receivedAt.getTime() - b.receivedAt.getTime(),
      );
    },

    async markProcessed(id, now) {
      await sql.query(
        `update webhook_inbox
         set state = 'done', processed_at = $2, locked_until = null, processing_error = null
         where id = $1 and state = 'pending'`,
        [id, now],
      );
    },

    async park(id, { waitingFor, reason, nextAttemptAt }) {
      await sql.query(
        `update webhook_inbox
         set state = 'parked',
             park_attempts = park_attempts + 1,
             parked_on_kind = $2, parked_on_ref = $3, parked_reason = $4,
             next_attempt_at = $5, locked_until = null
         where id = $1 and state = 'pending'`,
        [id, waitingFor.kind, waitingFor.ref, reason, nextAttemptAt],
      );
    },

    async recordFailure(id, { error, nextAttemptAt }) {
      await sql.query(
        `update webhook_inbox
         set processing_error = $2, next_attempt_at = $3, locked_until = null
         where id = $1 and state = 'pending'`,
        [id, error, nextAttemptAt],
      );
    },

    async deadLetter(id, { error, now }) {
      await sql.query(
        `update webhook_inbox
         set state = 'dead', dead_lettered_at = $2, processing_error = $3, locked_until = null
         where id = $1 and state <> 'done'`,
        [id, now, error],
      );
    },

    async unparkWaitingFor(refs, now) {
      if (refs.length === 0) return 0;
      // One statement for the whole batch: unnest the (kind, ref) pairs and
      // join. Wakes every parked row whose referent has just appeared.
      const kinds = refs.map((r) => r.kind);
      const ids = refs.map((r) => r.ref);
      // parked_on_kind / parked_on_ref are deliberately NOT cleared: the row
      // leaves 'parked' so the partial index stops matching it anyway, and
      // keeping them answers "what was this waiting for?" long afterwards.
      const woken = await sql.query(
        `update webhook_inbox w
         set state = 'pending', next_attempt_at = $3, locked_until = null
         from unnest($1::text[], $2::text[]) as arrived(kind, ref)
         where w.state = 'parked'
           and w.parked_on_kind = arrived.kind
           and w.parked_on_ref = arrived.ref
         returning w.id`,
        [kinds, ids, now],
      );
      return woken.rowCount ?? woken.rows.length;
    },

    async requeueDeadLetter(id, now) {
      const res = await sql.query(
        `update webhook_inbox
         set state = 'pending', dead_lettered_at = null, next_attempt_at = $2,
             attempts = 0, park_attempts = 0, locked_until = null
         where id = $1 and state = 'dead'
         returning id`,
        [id, now],
      );
      return (res.rowCount ?? res.rows.length) > 0;
    },

    async get(id) {
      const res = await sql.query(`select ${COLUMNS} from webhook_inbox where id = $1`, [id]);
      return res.rows[0] ? rowToEvent(res.rows[0]) : null;
    },

    async findByProviderEventId(provider, providerEventId) {
      const res = await sql.query(
        `select ${COLUMNS} from webhook_inbox where provider = $1 and provider_event_id = $2`,
        [provider, providerEventId],
      );
      return res.rows[0] ? rowToEvent(res.rows[0]) : null;
    },

    async listDeadLetters(limit = 100) {
      const res = await sql.query(
        `select ${COLUMNS} from webhook_inbox where state = 'dead'
         order by dead_lettered_at desc, id desc limit $1`,
        [limit],
      );
      return rowsToEvents(res.rows);
    },

    async listParked(limit = 100) {
      const res = await sql.query(
        `select ${COLUMNS} from webhook_inbox where state = 'parked'
         order by next_attempt_at, id limit $1`,
        [limit],
      );
      return rowsToEvents(res.rows);
    },
  };
}

function rowToEvent(row: Record<string, unknown>): InboxEvent {
  return {
    id: String(row.id),
    provider: row.provider as string,
    providerEventId: row.provider_event_id as string,
    eventType: (row.event_type as string | null) ?? null,
    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
    headers: (typeof row.headers === 'string' ? JSON.parse(row.headers) : row.headers) as Record<string, string>,
    rawBody: row.raw_body as string,
    receivedAt: asDate(row.received_at)!,
    signatureVerifiedAt: asDate(row.signature_verified_at)!,
    state: row.state as InboxState,
    attempts: Number(row.attempts),
    parkAttempts: Number(row.park_attempts),
    nextAttemptAt: asDate(row.next_attempt_at)!,
    lockedUntil: asDate(row.locked_until),
    processedAt: asDate(row.processed_at),
    parkedOnKind: (row.parked_on_kind as string | null) ?? null,
    parkedOnRef: (row.parked_on_ref as string | null) ?? null,
    parkedReason: (row.parked_reason as string | null) ?? null,
    processingError: (row.processing_error as string | null) ?? null,
    deadLetteredAt: asDate(row.dead_lettered_at),
  };
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(v as string);
}

/**
 * In-memory InboxStore.
 *
 * This is a TEST DOUBLE, not a second implementation of the inbox. Its only
 * contract is to mirror the constraints the migration declares — above all
 * `UNIQUE (provider, provider_event_id)` — so the dispatcher's behaviour can be
 * exercised without a database. The authoritative replay test runs against real
 * Postgres when WEBHOOK_INBOX_TEST_DATABASE_URL is set; see inbox.test.ts.
 */
export function createMemoryInboxStore(): InboxStore & { all(): InboxEvent[] } {
  const rows = new Map<string, InboxEvent>();
  const byNaturalKey = new Map<string, string>();
  let nextId = 1;
  const key = (p: string, e: string) => `${p} ${e}`;
  const clone = (e: InboxEvent): InboxEvent => ({ ...e });

  return {
    all: () => [...rows.values()].map(clone),

    async insertIfNew(record) {
      const k = key(record.provider, record.providerEventId);
      const existing = byNaturalKey.get(k);
      if (existing) return { inserted: false, id: existing };
      const id = String(nextId++);
      const state = record.state ?? 'pending';
      rows.set(id, {
        id,
        provider: record.provider,
        providerEventId: record.providerEventId,
        eventType: record.eventType,
        payload: record.payload,
        headers: record.headers,
        rawBody: record.rawBody,
        receivedAt: record.receivedAt,
        signatureVerifiedAt: record.signatureVerifiedAt,
        state,
        attempts: 0,
        parkAttempts: 0,
        nextAttemptAt: record.receivedAt,
        lockedUntil: null,
        processedAt: null,
        parkedOnKind: null,
        parkedOnRef: null,
        parkedReason: null,
        processingError: record.processingError ?? null,
        deadLetteredAt: state === 'dead' ? record.receivedAt : null,
      });
      byNaturalKey.set(k, id);
      return { inserted: true, id };
    },

    async claimBatch({ limit, now, leaseMs }) {
      const due = [...rows.values()]
        .filter(
          (r) =>
            (r.state === 'pending' || r.state === 'parked') &&
            r.nextAttemptAt.getTime() <= now.getTime() &&
            (r.lockedUntil === null || r.lockedUntil.getTime() <= now.getTime()),
        )
        .sort(
          (a, b) =>
            a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
            a.receivedAt.getTime() - b.receivedAt.getTime() ||
            Number(a.id) - Number(b.id),
        )
        .slice(0, limit);
      for (const r of due) {
        r.attempts += 1;
        r.state = 'pending';
        r.lockedUntil = new Date(now.getTime() + leaseMs);
      }
      return due.map(clone);
    },

    async markProcessed(id, now) {
      const r = rows.get(id);
      if (!r || r.state !== 'pending') return;
      r.state = 'done';
      r.processedAt = now;
      r.lockedUntil = null;
      r.processingError = null;
    },

    async park(id, { waitingFor, reason, nextAttemptAt }) {
      const r = rows.get(id);
      if (!r || r.state !== 'pending') return;
      r.state = 'parked';
      r.parkAttempts += 1;
      r.parkedOnKind = waitingFor.kind;
      r.parkedOnRef = waitingFor.ref;
      r.parkedReason = reason;
      r.nextAttemptAt = nextAttemptAt;
      r.lockedUntil = null;
    },

    async recordFailure(id, { error, nextAttemptAt }) {
      const r = rows.get(id);
      if (!r || r.state !== 'pending') return;
      r.processingError = error;
      r.nextAttemptAt = nextAttemptAt;
      r.lockedUntil = null;
    },

    async deadLetter(id, { error, now }) {
      const r = rows.get(id);
      if (!r || r.state === 'done') return;
      r.state = 'dead';
      r.deadLetteredAt = now;
      r.processingError = error;
      r.lockedUntil = null;
    },

    async unparkWaitingFor(refs, now) {
      let woken = 0;
      for (const r of rows.values()) {
        if (r.state !== 'parked') continue;
        if (!refs.some((ref) => ref.kind === r.parkedOnKind && ref.ref === r.parkedOnRef)) continue;
        r.state = 'pending';
        r.nextAttemptAt = now;
        r.lockedUntil = null;
        woken += 1;
      }
      return woken;
    },

    async requeueDeadLetter(id, now) {
      const r = rows.get(id);
      if (!r || r.state !== 'dead') return false;
      r.state = 'pending';
      r.deadLetteredAt = null;
      r.nextAttemptAt = now;
      r.attempts = 0;
      r.parkAttempts = 0;
      r.lockedUntil = null;
      return true;
    },

    async get(id) {
      const r = rows.get(id);
      return r ? clone(r) : null;
    },

    async findByProviderEventId(provider, providerEventId) {
      const id = byNaturalKey.get(key(provider, providerEventId));
      return id ? clone(rows.get(id)!) : null;
    },

    async listDeadLetters(limit = 100) {
      return [...rows.values()].filter((r) => r.state === 'dead').slice(0, limit).map(clone);
    },

    async listParked(limit = 100) {
      return [...rows.values()].filter((r) => r.state === 'parked').slice(0, limit).map(clone);
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Ingestion — what the route handler calls
// ---------------------------------------------------------------------------

export type IngestResult =
  /** First delivery. Row written, nothing processed yet. */
  | { status: 'accepted'; httpStatus: 202; id: string; providerEventId: string; eventType: string | null }
  /** Postgres refused the duplicate. Nothing happened, and that is correct. */
  | { status: 'replay'; httpStatus: 200; id: string | null; providerEventId: string }
  /** Filed for staff, but not dispatchable (verified bytes we cannot parse). */
  | { status: 'dead_on_arrival'; httpStatus: 202; id: string | null; providerEventId: string; reason: string }
  /** Nothing persisted. 401 for a bad signature, 404 for an unknown provider. */
  | { status: 'rejected'; httpStatus: 400 | 401 | 404; reason: string };

export interface IngestDeps {
  store: InboxStore;
  registry?: VerifierRegistry | undefined;
  now?: (() => Date) | undefined;
}

/**
 * Verify, persist, and return. This function never processes anything, never
 * touches the ledger, and never awaits a consumer — that is dispatch.ts's job,
 * out of band. Requirement 3 is enforced by the fact that there is nothing in
 * this file that could do the work even if a caller wanted it to.
 */
export async function ingestWebhook(
  provider: ProviderName,
  req: RawRequest,
  deps: IngestDeps,
): Promise<IngestResult> {
  const now = deps.now ?? (() => new Date());
  const registry = deps.registry ?? verifiers;

  const verifier = registry.get(provider);
  if (!verifier) {
    return { status: 'rejected', httpStatus: 404, reason: `no verifier registered for '${provider}'` };
  }

  // STEP 1 — raw bytes first, always. Nothing above this line touched the body.
  const { raw, headers } = await readRawDelivery(req);

  // STEP 2 — verify over those exact bytes.
  const receivedAt = now();
  const outcome = await verifier.verify({ raw, headers, now: receivedAt });
  if (!outcome.ok) {
    // 401 and no row: an unauthenticated body is not evidence of anything, and
    // storing it would let anyone who can reach the URL fill the inbox.
    return { status: 'rejected', httpStatus: 401, reason: outcome.reason };
  }
  const signatureVerifiedAt = now();
  const capturedHeaders = captureHeaders(headers, verifier.signatureHeaders);

  // STEP 3 — only now is it safe to parse.
  let payload: unknown;
  try {
    payload = parseVerifiedJson(raw);
  } catch (err) {
    if (!(err instanceof WebhookPayloadParseError)) throw err;
    // The signature verified, so these really are the provider's bytes; losing
    // them would be losing evidence. If the provider puts an id in a header we
    // can still file the row — dead on arrival, visible to staff — and 2xx so
    // the provider stops retrying something a retry cannot fix.
    const headerId = verifier.identifyFromHeaders?.(headers) ?? null;
    if (!headerId) {
      return { status: 'rejected', httpStatus: 400, reason: 'verified body is not valid JSON' };
    }
    const filed = await deps.store.insertIfNew({
      provider,
      providerEventId: headerId,
      eventType: null,
      payload: null,
      headers: capturedHeaders,
      rawBody: raw,
      receivedAt,
      signatureVerifiedAt,
      state: 'dead',
      processingError: err.message,
    });
    return {
      status: 'dead_on_arrival',
      httpStatus: 202,
      id: filed.id,
      providerEventId: headerId,
      reason: err.message,
    };
  }

  const accepted = verifier.accept?.({ raw, headers, payload }) ?? { ok: true };
  if (!accepted.ok) {
    return { status: 'rejected', httpStatus: 400, reason: accepted.reason };
  }

  const identity = verifier.identify({ raw, headers, payload });
  if (!identity.providerEventId) {
    return { status: 'rejected', httpStatus: 400, reason: 'could not determine provider event id' };
  }

  // STEP 4 — one INSERT. The unique index decides first-delivery vs replay.
  const result = await deps.store.insertIfNew({
    provider,
    providerEventId: identity.providerEventId,
    eventType: identity.eventType,
    payload,
    headers: capturedHeaders,
    rawBody: raw,
    receivedAt,
    signatureVerifiedAt,
  });

  if (!result.inserted) {
    return { status: 'replay', httpStatus: 200, id: result.id, providerEventId: identity.providerEventId };
  }
  return {
    status: 'accepted',
    httpStatus: 202,
    id: result.id!,
    providerEventId: identity.providerEventId,
    eventType: identity.eventType,
  };
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Signed-header capture. Deliberately an allowlist: an inbox row is kept for
 *  years and must never accumulate Authorization headers or cookies. */
function captureHeaders(headers: HeaderLookup, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = headers(name);
    if (value !== null) out[name.toLowerCase()] = value;
  }
  return out;
}

/** now - t, in seconds. Positive means the delivery is old. Null if unparseable. */
function timestampDriftSeconds(timestamp: string, now: Date): number | null {
  if (!/^-?\d+$/.test(timestamp.trim())) return null;
  const t = Number(timestamp.trim());
  if (!Number.isFinite(t)) return null;
  return Math.floor(now.getTime() / 1000) - t;
}

/** Read a nested string off an unknown payload without trusting its shape. */
function readString(payload: unknown, path: readonly string[]): string | null {
  let cursor: unknown = payload;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return null;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return typeof cursor === 'string' ? cursor : null;
}

export { toHeaderLookup };
