/**
 * A refused webhook is a row.
 *
 * ---------------------------------------------------------------------------
 * THE HOLE THIS FILLS
 * ---------------------------------------------------------------------------
 * `route-handler.ts` answered a forged delivery with 401 and the sentence
 * "signature verification failed; nothing was stored", and stored nothing. The
 * refusal is right — an unauthenticated body must never reach the inbox — but
 * it meant every rejected attempt was absent from the system. `webhook_inbox`
 * holds only the
 * deliveries we ACCEPTED, so any trail, count or dashboard built on it reads
 * complete while the whole population of forged, misrouted and stale attempts
 * is invisible. "Is anyone hammering our webhook endpoints with bad
 * signatures?" answered with silence, and silence is indistinguishable from
 * safety. docs/AUDIT.md §2.1 item 2 named it; this closes it.
 *
 * The precedent is `payee_candidate_refusal` (0016 §2): a blocked candidate
 * never becomes a payee, so the caught typo — the product of the feature —
 * would otherwise leave no trace. Same shape, same argument.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS, WRITTEN DOWN
 * ---------------------------------------------------------------------------
 * Recording a refusal must not weaken the refusal, and the dangerous version of
 * this feature is the one that reads attacker bytes earlier than it used to in
 * order to describe them. So, precisely:
 *
 *   * `unknown_provider` is decided from the path segment alone and THE BODY IS
 *     NEVER READ. There is no verifier, so there is nothing that could ever
 *     authenticate those bytes; reading them to hash them would be reading an
 *     unauthenticated stream for a telemetry field. `0038`'s
 *     `webhook_refusal_body_read_iff_there_was_a_verifier` constraint makes
 *     that a database rule, not a convention: those rows have null body
 *     columns, and an edit that starts reading the body cannot store the result.
 *
 *   * For every other reason the body has ALREADY been read, by `ingestWebhook`,
 *     at exactly the point it always read it — step 1, before verification,
 *     because you cannot verify a signature over bytes you have not read. This
 *     module does not move that read one instruction earlier. `probeBody` wraps
 *     the request so that the single `await req.text()` inside `ingestWebhook`
 *     also computes a SHA-256 and a byte count on the way past. No second read
 *     (the body is a one-shot stream and the bytes are gone afterwards), no
 *     parse, no branch on content, and no reference to the bytes retained after
 *     the digest is taken.
 *
 *   * The digest is COMPUTED before verification and PERSISTED only after the
 *     verifier has returned a refusal. What must not happen before
 *     authentication is parsing, persisting verbatim, dispatching, or letting
 *     the content steer control flow. A fixed-width hash of bytes we were always
 *     going to hold in memory for the length of the HMAC is none of those.
 *
 * `route-handler.test.ts` already asserts the handler never calls `req.json()`
 * by handing it a request whose `json()` throws; that test passes unchanged
 * through the probe, which is the proof that the wrapper did not become a
 * second reader.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS RECORDED, AND WHAT IS REFUSED
 * ---------------------------------------------------------------------------
 * KEPT: provider (the sanitised path segment), endpoint, the instant, the
 * source address as `inet`, which header that address came from, a SHA-256 of
 * the body, the body's length, the reason, and the SHAPE of the signature
 * header — its scheme, how many `v1` entries it carried, how many bytes long it
 * was.
 *
 * REFUSED, each for a stated reason:
 *
 *   * THE BODY. A forged body is a document authored by an unauthenticated
 *     stranger. Storing it wholesale creates a place where an attacker chooses
 *     what our database contains and what our screens render — stored XSS, log
 *     injection, and unbounded free storage in one column. The hash answers the
 *     questions that matter operationally ("the same forgery again?", "is this
 *     the delivery the provider's dashboard says it sent?" — hash the replay and
 *     compare) without ever holding what it said.
 *
 *   * THE SIGNATURE VALUE. Its shape is diagnostic; its bytes are not. A
 *     43-character base64 v1 entry versus a 12-character one is the whole
 *     signal, and `signature_bytes` carries it.
 *
 *   * THE VERIFIER'S OWN REASON STRING. This one looks safe and is not:
 *     `plaidVerifier` builds `unexpected alg '<attacker string>'` and
 *     `no verification key for kid <attacker string>`, and
 *     `JWT signature check failed: ${String(err)}`. Those strings are matched
 *     against our own fixed patterns to pick a reason CODE and are then dropped.
 *     They still go to the log line, which is where attacker-influenced text was
 *     already going and is not rendered as data.
 *
 *   * THE USER AGENT, and every other free-text header. Attacker-chosen text
 *     with no diagnostic value that `source_ip` does not already carry better.
 *
 *   * THE REQUEST ID. `requestIdFrom` reads a caller-supplied `x-request-id`.
 *     It belongs in the log, not in a column an operator reads as fact.
 *
 *   * SECRETS, obviously, and by construction: nothing here ever touches one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A DENIAL-OF-SERVICE AMPLIFIER
 * ---------------------------------------------------------------------------
 * An unauthenticated endpoint that writes a row per request is free storage for
 * whoever finds the URL, and the write amplification IS the attack. Two bounds,
 * both stated with what they cost:
 *
 *   1. AGGREGATION. A row is a BUCKET — (provider, reason, source, minute) —
 *      carrying a count, a window and an exemplar. Ten thousand forgeries from
 *      one address in one minute are one row saying 10000. COST: the body hash,
 *      length and signature shape describe the FIRST request in the bucket only.
 *      `body_varied` (one boolean) preserves the difference that matters —
 *      one captured delivery replayed, versus ten thousand different probes.
 *
 *   2. A PER-INSTANCE WRITE BUDGET. At most `maxRowsPerMinute` statements and
 *      `maxRowsPerMinute` new rows per instance per minute. Refusals beyond it
 *      accumulate in memory and are written when the budget refills; distinct
 *      buckets beyond `maxRowsPerMinute` fold into an overflow row whose
 *      `source_header` is 'folded' and whose `source_ip` is null. For an
 *      `unknown_provider` flood the folded row drops the segment too, because
 *      the segment is attacker-chosen and is therefore itself an unbounded
 *      cardinality dimension — `/api/webhooks/aaa1`, `aaa2`, … COST: under a
 *      flood you learn the rate and the reason and lose per-source attribution;
 *      and a process that dies with counts pending loses them. Both are
 *      deliberate: an attacker must not be able to turn our telemetry into our
 *      outage, and losing the count of an attack we can see is cheaper than
 *      losing the database to it. The folded row makes the loss VISIBLE
 *      (`folded_rows_24h` in `v_webhook_refusal_rate`) rather than silent,
 *      which is the whole rule this build keeps rediscovering.
 *
 * The budget is per instance. Under horizontal scaling the ceiling is
 * instances × budget, which is a bound and not a guarantee; it is stated here
 * rather than implied.
 */

import type { DeliverySql } from '../integrations/delivery-health';
import { DELIVERY_THRESHOLDS } from '../integrations/delivery-health';
import type { SqlExecutor } from './inbox';
import { sha256Hex, type HeaderLookup, type HeadersLike } from './rawbody';

// ---------------------------------------------------------------------------
// 1. The vocabulary
// ---------------------------------------------------------------------------

/**
 * Five reasons, because these are five different operational stories with five
 * different owners. A single `invalid` bucket throws away the only thing the
 * table is for: "our secret is wrong" and "someone is forging" are the same
 * HTTP status and completely different incidents.
 *
 * Mirrors the `webhook_refusal_reason` enum in `0038_webhook_refusals.sql`.
 */
export type RefusalReason =
  /** No verifier for that path segment. The body is never read. */
  | 'unknown_provider'
  /** The scheme's signature headers are not present at all. */
  | 'signature_absent'
  /** A signature header is present and does not parse as this scheme. Misrouting. */
  | 'signature_malformed'
  /** Well-formed and did not verify. Wrong secret, or a forger. This one pages. */
  | 'signature_mismatch'
  /** Outside the ±300s replay window, or not a unix second count. */
  | 'timestamp_outside_window';

export const REFUSAL_REASONS: readonly RefusalReason[] = [
  'unknown_provider',
  'signature_absent',
  'signature_malformed',
  'signature_mismatch',
  'timestamp_outside_window',
];

/**
 * Which header the source address was read from, so an operator knows how much
 * to trust it. A CLOSED set — this can never hold a header name a caller
 * invented — matching the CHECK constraint on `webhook_refusal.source_header`.
 */
export type SourceHeader =
  | 'x-vercel-forwarded-for'
  | 'x-real-ip'
  | 'x-forwarded-for'
  | 'none'
  | 'unparseable'
  | 'folded';

/**
 * Most trusted first. The platform sets `x-vercel-forwarded-for` and
 * `x-real-ip` itself and overwrites whatever the caller sent;
 * `x-forwarded-for`'s leftmost entry is client-influenced, which is exactly why
 * the column that records WHICH header was used exists. An operator blocking an
 * address wants to know whether the address was asserted by our edge or by the
 * person we are blocking.
 */
const SOURCE_HEADERS: readonly Exclude<SourceHeader, 'none' | 'unparseable' | 'folded'>[] = [
  'x-vercel-forwarded-for',
  'x-real-ip',
  'x-forwarded-for',
];

// ---------------------------------------------------------------------------
// 2. Describing a delivery without keeping any of it
// ---------------------------------------------------------------------------

export interface SourceAddress {
  /** Dotted-quad or IPv6 text, or null. Stored into an `inet` column. */
  readonly ip: string | null;
  readonly header: SourceHeader;
}

/**
 * Strict enough that only something an `inet` column will accept gets through,
 * and bounded so a hostile header cannot make the regex engine the outage.
 * Anything else is recorded as `unparseable` with a null address, never
 * preserved as text nobody sanitised.
 */
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-fA-F:]{2,45}$/;

/** Longest plausible address text. Anything longer is not an address. */
const MAX_ADDRESS_CHARS = 45;

export function readSourceAddress(headers: HeaderLookup): SourceAddress {
  for (const name of SOURCE_HEADERS) {
    const raw = headers(name);
    if (raw === null || raw.trim() === '') continue;
    // Leftmost entry: the client as our edge saw it. Everything to the right
    // is proxy chain, and a chain an attacker can extend at will.
    const first = (raw.split(',')[0] ?? '').trim();
    const ip = normaliseAddress(first);
    return ip === null ? { ip: null, header: 'unparseable' } : { ip, header: name };
  }
  return { ip: null, header: 'none' };
}

/** Strip `[...]` brackets and a `:port`, then validate. Null if it is not an address. */
function normaliseAddress(value: string): string | null {
  if (value === '' || value.length > MAX_ADDRESS_CHARS + 8) return null;
  let candidate = value;
  const bracketed = /^\[([^\]]{2,45})\](?::\d{1,5})?$/.exec(candidate);
  if (bracketed?.[1] !== undefined) candidate = bracketed[1];
  else if (candidate.split(':').length === 2) candidate = candidate.split(':')[0] ?? candidate;
  if (candidate.length > MAX_ADDRESS_CHARS) return null;
  if (IPV4.test(candidate)) return candidate;
  // Reject the degenerate all-colons strings the loose IPv6 pattern would allow.
  if (IPV6.test(candidate) && candidate.includes(':') && /[0-9a-fA-F]/.test(candidate)) {
    return candidate;
  }
  return null;
}

export interface SignatureShape {
  readonly present: boolean;
  /**
   * A token from a CLOSED grammar, generated from the header's STRUCTURE and
   * never from its bytes: `absent`, `swh:v1x2` (Standard Webhooks, two v1
   * entries — what a secret rotation looks like), `tshmac:t+v1x1`, `jwt:3part`,
   * `swh:unparsed`, `other:present`. Matches
   * `^[a-z]+(:[a-z0-9+_-]{1,24})?$`, which is the CHECK on the column.
   */
  readonly shape: string;
  /** Total length of the scheme's signature-bearing headers. Never their values. */
  readonly bytes: number | null;
}

const ABSENT: SignatureShape = { present: false, shape: 'absent', bytes: null };

/**
 * Describe the signature the caller presented, from the header names the
 * verifier itself declares it signs (`WebhookVerifier.signatureHeaders`), so a
 * sixth provider is described correctly without editing this function.
 *
 * Counts are clamped to 9 so the token cannot grow: an attacker who sends four
 * hundred `v1,` entries gets `swh:v1x9`, not a four-hundred-character column
 * value. Bounding the OUTPUT rather than trusting the input is the rule.
 */
export function describeSignature(
  headers: HeaderLookup,
  signatureHeaders: readonly string[],
): SignatureShape {
  const values = signatureHeaders
    .map((name) => ({ name: name.toLowerCase(), value: headers(name) }))
    .filter((h): h is { name: string; value: string } => h.value !== null && h.value !== '');
  if (values.length === 0) return ABSENT;

  const bytes = values.reduce((total, h) => total + h.value.length, 0);
  const signature = values.find(
    (h) =>
      h.name === 'webhook-signature' ||
      h.name.endsWith('-signature') ||
      h.name === 'plaid-verification',
  );
  if (signature === undefined) {
    // Envelope headers present, the SIGNATURE itself absent. `present` is about
    // the signature and nothing else — a `webhook-id` is not a signature — so
    // this is `signature_absent`, and the shape is what distinguishes it from a
    // request that carried no scheme headers at all.
    return { present: false, shape: 'swh:nosig', bytes };
  }

  if (signature.name === 'plaid-verification') {
    return { present: true, shape: `jwt:${clamp(signature.value.split('.').length)}part`, bytes };
  }
  if (signature.name === 'webhook-signature') {
    // Standard Webhooks: space-separated `v1,<base64>` entries.
    const v1 = signature.value.split(' ').filter((e) => e.startsWith('v1,')).length;
    return { present: true, shape: v1 === 0 ? 'swh:unparsed' : `swh:v1x${clamp(v1)}`, bytes };
  }
  // Persona / Stripe: space-separated groups of `t=…,v1=…` pairs.
  let stamped = false;
  let v1 = 0;
  for (const group of signature.value.split(' ')) {
    for (const pair of group.split(',')) {
      const key = pair.slice(0, Math.max(pair.indexOf('='), 0)).trim();
      if (key === 't') stamped = true;
      else if (key === 'v1') v1 += 1;
    }
  }
  if (v1 === 0) return { present: true, shape: 'tshmac:unparsed', bytes };
  return { present: true, shape: `tshmac:${stamped ? 't+' : ''}v1x${clamp(v1)}`, bytes };
}

function clamp(n: number): number {
  return Math.min(Math.max(n, 0), 9);
}

// ---------------------------------------------------------------------------
// 3. Classification
// ---------------------------------------------------------------------------

/**
 * OUR OWN reason strings, from `inbox.ts`'s verifiers. They are matched here
 * and DROPPED; none of them is ever stored, because several interpolate
 * attacker-chosen text (`unexpected alg '…'`, `no verification key for kid …`).
 *
 * The fallback is `signature_mismatch` — the loudest bucket — on purpose. If a
 * verifier's prose changes and a pattern stops matching, this misreports a
 * stale timestamp as a forgery, which someone investigates. The other default
 * would misreport a forgery as a formatting problem, which nobody does.
 * `refusals.test.ts` pins every string the shipped verifiers can produce, so
 * the drift is caught by the suite rather than by the fallback.
 */
const TIMESTAMP_REASON =
  /timestamp|too old|too far in the future|no iat|unix second count/i;
const MALFORMED_REASON =
  /^missing |^malformed |unexpected alg|has no kid|header\/payload is not JSON|no verification key for kid/i;

export interface ClassifyInput {
  /** False when the path segment has no verifier at all. */
  readonly verifierFound: boolean;
  readonly signature: SignatureShape;
  /** The verifier's reason. Read, matched, and never stored. */
  readonly reason: string;
}

export function classifyRefusal(input: ClassifyInput): RefusalReason {
  if (!input.verifierFound) return 'unknown_provider';

  // MALFORMED IS TESTED FIRST, and the order is load-bearing. The Standard
  // Webhooks verifier's reason for a missing header is
  // "missing webhook-id / webhook-timestamp / webhook-signature", which
  // CONTAINS the word "timestamp" — testing the timestamp pattern first
  // reported every unsigned delivery as a clock problem. Found by the pinned
  // table in `refusals.test.ts`, which is exactly what it is for.
  if (MALFORMED_REASON.test(input.reason)) {
    return input.signature.present ? 'signature_malformed' : 'signature_absent';
  }
  // Before absence: a delivery can be both unsigned AND stale, and "your clock
  // is wrong" is the finding that changes what an operator does.
  if (TIMESTAMP_REASON.test(input.reason)) return 'timestamp_outside_window';
  if (!input.signature.present) return 'signature_absent';
  if (input.signature.shape.endsWith(':unparsed')) return 'signature_malformed';
  return 'signature_mismatch';
}

// ---------------------------------------------------------------------------
// 4. The body probe
// ---------------------------------------------------------------------------

/**
 * The shape `ingestWebhook` needs: raw text, once, plus headers. Structurally
 * identical to `RawRequest` in `rawbody.ts`, and deliberately restated rather
 * than imported as that name, because the point of the probe is that it is
 * indistinguishable from the request it wraps.
 */
export interface ProbeableRequest {
  text(): Promise<string>;
  headers: HeadersLike;
}

export interface BodyFacts {
  readonly sha256: string;
  readonly bytes: number;
}

export interface BodyProbe {
  /** Hand THIS to `ingestWebhook`. It reads the body exactly once, as before. */
  readonly request: ProbeableRequest;
  /** The digest and length, or null if the body was never read. */
  observed(): BodyFacts | null;
}

/**
 * Wrap a request so that the one `await req.text()` inside `ingestWebhook` also
 * yields a SHA-256 and a byte count on the way past.
 *
 * This is a tee, not a second read. The body is a one-shot stream: reading it
 * twice is impossible, which is the property that makes this safe rather than a
 * promise that it is. `raw` is not retained — the digest is taken and the
 * reference is dropped with the stack frame — and nothing here parses, inspects
 * or branches on the content.
 *
 * `observed()` returns null when the body was never read, which is the
 * `unknown_provider` path: no verifier, so the bytes are left on the wire.
 */
export function probeBody(req: ProbeableRequest): BodyProbe {
  let facts: BodyFacts | null = null;
  const request: ProbeableRequest = {
    headers: req.headers,
    async text(): Promise<string> {
      const raw = await req.text();
      facts = { sha256: sha256Hex(raw), bytes: Buffer.byteLength(raw, 'utf8') };
      return raw;
    },
  };
  return { request, observed: () => facts };
}

// ---------------------------------------------------------------------------
// 5. The observation and the store
// ---------------------------------------------------------------------------

export interface RefusalObservation {
  /** The path segment, ALREADY sanitised to `[A-Za-z0-9_-]{0,40}` by the caller. */
  readonly provider: string;
  /** True when the segment names an integration we ship, even if unconfigured. */
  readonly providerKnown: boolean;
  readonly reasonCode: RefusalReason;
  readonly source: SourceAddress;
  readonly signature: SignatureShape;
  /** Null only for `unknown_provider`, where the body was never read. */
  readonly body: BodyFacts | null;
  readonly at: Date;
}

/** One row, ready for the upsert. `refusals` is how many requests it stands for. */
export interface RefusalBucket {
  readonly provider: string;
  readonly endpoint: string;
  readonly reasonCode: RefusalReason;
  readonly sourceIp: string | null;
  readonly sourceHeader: SourceHeader;
  readonly minuteBucket: Date;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly refusals: number;
  readonly signaturePresent: boolean;
  readonly signatureShape: string;
  readonly signatureBytes: number | null;
  readonly bodyBytes: number | null;
  readonly bodySha256: string | null;
  readonly bodyVaried: boolean;
}

export interface RefusalStore {
  /** Upsert a batch of buckets. One statement; the unique index decides. */
  record(buckets: readonly RefusalBucket[]): Promise<void>;
}

const INSERT_COLUMNS = [
  'provider',
  'endpoint',
  'reason_code',
  'source_ip',
  'source_header',
  'minute_bucket',
  'first_seen_at',
  'last_seen_at',
  'refusals',
  'signature_present',
  'signature_shape',
  'signature_bytes',
  'body_bytes',
  'body_sha256',
  'body_varied',
] as const;

/**
 * The Postgres store, over the same narrow `SqlExecutor` port the inbox uses.
 *
 * ON CONFLICT DO UPDATE, and the three advancing columns are the only three
 * `corgi_app` holds UPDATE on (0038 §6), so this statement is the ONLY update
 * the application can physically express against this table. The facts — who,
 * when, which endpoint, which reason, which body hash — are ungranted, exactly
 * as `webhook_inbox`'s are.
 *
 * `body_varied` is computed in SQL rather than in TypeScript because the value
 * it compares against is the row already in the table, which this process may
 * never have seen: another instance may have opened the bucket.
 */
export function createPostgresRefusalStore(sql: SqlExecutor): RefusalStore {
  return {
    async record(buckets) {
      if (buckets.length === 0) return;
      const params: unknown[] = [];
      const tuples = buckets.map((b) => {
        const values = [
          b.provider,
          b.endpoint,
          b.reasonCode,
          b.sourceIp,
          b.sourceHeader,
          b.minuteBucket,
          b.firstSeenAt,
          b.lastSeenAt,
          b.refusals,
          b.signaturePresent,
          b.signatureShape,
          b.signatureBytes,
          b.bodyBytes,
          b.bodySha256,
          b.bodyVaried,
        ];
        const base = params.length;
        params.push(...values);
        // Every parameter is cast at its use site. DECISIONS 020 and the note
        // in inbox.ts: Postgres deduces a type per use site and refuses the
        // statement when two deductions disagree, and an in-memory double can
        // never catch it because it does not parse SQL.
        return (
          `($${base + 1}, $${base + 2}, $${base + 3}::webhook_refusal_reason, ` +
          `$${base + 4}::inet, $${base + 5}, $${base + 6}::timestamptz, ` +
          `$${base + 7}::timestamptz, $${base + 8}::timestamptz, $${base + 9}::integer, ` +
          `$${base + 10}::boolean, $${base + 11}, $${base + 12}::integer, ` +
          `$${base + 13}::bigint, $${base + 14}, $${base + 15}::boolean)`
        );
      });

      await sql.query(
        `insert into webhook_refusal (${INSERT_COLUMNS.join(', ')})
         values ${tuples.join(', ')}
         on conflict (provider, reason_code, minute_bucket, source_ip, source_header)
         do update set
           refusals     = webhook_refusal.refusals + excluded.refusals,
           last_seen_at = greatest(webhook_refusal.last_seen_at, excluded.last_seen_at),
           body_varied  = webhook_refusal.body_varied
                          or excluded.body_varied
                          or (webhook_refusal.body_sha256 is distinct from excluded.body_sha256)`,
        params,
      );
    },
  };
}

/** In-memory store for the tests. A double, not a second implementation. */
export function createMemoryRefusalStore(): RefusalStore & { all(): RefusalBucket[] } {
  const rows = new Map<string, RefusalBucket>();
  const key = (b: RefusalBucket) =>
    [b.provider, b.reasonCode, b.minuteBucket.toISOString(), b.sourceIp ?? '', b.sourceHeader].join('|');
  return {
    all: () => [...rows.values()],
    async record(buckets) {
      for (const b of buckets) {
        const k = key(b);
        const existing = rows.get(k);
        if (existing === undefined) {
          rows.set(k, b);
          continue;
        }
        rows.set(k, {
          ...existing,
          refusals: existing.refusals + b.refusals,
          lastSeenAt: existing.lastSeenAt > b.lastSeenAt ? existing.lastSeenAt : b.lastSeenAt,
          bodyVaried:
            existing.bodyVaried || b.bodyVaried || existing.bodySha256 !== b.bodySha256,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 6. The recorder — aggregation and the write budget
// ---------------------------------------------------------------------------

/**
 * At most this many statements, and this many new rows, per instance per
 * minute. Sixty is one a second: far above any real refusal rate (a genuine
 * provider never fails a signature), and far below anything that costs us
 * money under a flood.
 */
export const DEFAULT_MAX_ROWS_PER_MINUTE = 60;

export interface RecorderOptions {
  readonly store: RefusalStore;
  readonly maxRowsPerMinute?: number | undefined;
  /** Called with anything that went wrong writing. Never throws at the caller. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

interface PendingBucket {
  provider: string;
  providerKnown: boolean;
  reasonCode: RefusalReason;
  sourceIp: string | null;
  sourceHeader: SourceHeader;
  minute: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  count: number;
  signature: SignatureShape;
  body: BodyFacts | null;
  varied: boolean;
}

export interface RefusalRecorder {
  /** Observe one refusal. Aggregates, and writes if the budget allows. */
  observe(o: RefusalObservation): Promise<void>;
  /** Force everything held in memory to the store. For tests and shutdown. */
  flush(): Promise<void>;
  /** Buckets currently held in memory, for assertions. */
  pendingCount(): number;
}

export function createRefusalRecorder(options: RecorderOptions): RefusalRecorder {
  const max = options.maxRowsPerMinute ?? DEFAULT_MAX_ROWS_PER_MINUTE;
  const pending = new Map<string, PendingBucket>();
  /**
   * Every bucket key opened in the CURRENT minute, written or still pending.
   *
   * `pending.size` is not the cap and cannot be: draining it to the database
   * empties the map, so a cap read off `pending.size` resets every time the
   * budget lets a write through and the row count per minute is then unbounded.
   * Measured by `refills the budget when the minute rolls` in the test, which
   * saw five rows in a minute with a budget of two.
   */
  let seen = new Set<string>();
  let minute = -1;
  let budget = max;

  const write = async (buckets: readonly RefusalBucket[]) => {
    if (buckets.length === 0) return;
    try {
      await options.store.record(buckets);
    } catch (error) {
      // A refusal that cannot be recorded must never turn a 401 into a 500.
      // The request was refused either way; this is telemetry about the
      // refusal, and telemetry does not get to change the answer.
      options.onError?.(error);
    }
  };

  const drain = (limit: number): RefusalBucket[] => {
    const taken: RefusalBucket[] = [];
    for (const [key, bucket] of pending) {
      if (taken.length >= limit) break;
      taken.push(toBucket(bucket));
      pending.delete(key);
    }
    return taken;
  };

  return {
    pendingCount: () => pending.size,

    async flush() {
      await write(drain(Number.POSITIVE_INFINITY));
    },

    async observe(o: RefusalObservation) {
      const bucketMinute = Math.floor(o.at.getTime() / 60_000);
      if (bucketMinute !== minute) {
        // The minute rolled. Everything still held belongs to a bucket that can
        // no longer receive anything, so it is written and the budget refills.
        const carry = drain(Number.POSITIVE_INFINITY);
        minute = bucketMinute;
        budget = max;
        seen = new Set<string>();
        await write(carry);
      }

      // THE OVERFLOW FOLD. Beyond `max` distinct buckets in a minute we stop
      // attributing sources — and for an unknown provider we stop keeping the
      // segment, because the segment is attacker-chosen and is itself an
      // unbounded cardinality dimension (/api/webhooks/aaa1, aaa2, …). The fold
      // key is therefore (known provider or '', reason, 'folded'), of which
      // there are at most (providers + 1) × 5 per minute.
      let key = bucketKey(o.provider, o.reasonCode, o.source, bucketMinute);
      let folded = false;
      if (!seen.has(key) && seen.size >= max) {
        folded = true;
        const provider = o.providerKnown ? o.provider : '';
        key = bucketKey(provider, o.reasonCode, { ip: null, header: 'folded' }, bucketMinute);
      }
      seen.add(key);

      const existing = pending.get(key);
      if (existing === undefined) {
        pending.set(key, {
          provider: folded && !o.providerKnown ? '' : o.provider,
          providerKnown: o.providerKnown,
          reasonCode: o.reasonCode,
          sourceIp: folded ? null : o.source.ip,
          sourceHeader: folded ? 'folded' : o.source.header,
          minute: bucketMinute,
          firstSeenAt: o.at,
          lastSeenAt: o.at,
          count: 1,
          signature: o.signature,
          body: o.body,
          varied: false,
        });
      } else {
        existing.count += 1;
        if (o.at > existing.lastSeenAt) existing.lastSeenAt = o.at;
        if ((existing.body?.sha256 ?? null) !== (o.body?.sha256 ?? null)) existing.varied = true;
      }

      if (budget <= 0) return;
      const batch = drain(budget);
      budget -= batch.length;
      await write(batch);
    },
  };
}

function bucketKey(
  provider: string,
  reason: RefusalReason,
  source: SourceAddress,
  minute: number,
): string {
  return [provider, reason, minute, source.ip ?? '', source.header].join('|');
}

function toBucket(p: PendingBucket): RefusalBucket {
  return {
    provider: p.provider,
    endpoint: `/api/webhooks/${p.provider}`,
    reasonCode: p.reasonCode,
    sourceIp: p.sourceIp,
    sourceHeader: p.sourceHeader,
    minuteBucket: new Date(p.minute * 60_000),
    firstSeenAt: p.firstSeenAt,
    lastSeenAt: p.lastSeenAt,
    refusals: p.count,
    signaturePresent: p.signature.present,
    signatureShape: p.signature.shape,
    signatureBytes: p.signature.bytes,
    bodyBytes: p.body?.bytes ?? null,
    bodySha256: p.body?.sha256 ?? null,
    bodyVaried: p.varied,
  };
}

// ---------------------------------------------------------------------------
// 7. The health field — read by /api/health, folded here
// ---------------------------------------------------------------------------

/**
 * A FOURTH question, and a fourth vocabulary.
 *
 * `probe.ts` asks "does this credential still work?" (live / simulated /
 * unauthorised / …). `delivery-health.ts` asks "is this provider still talking
 * to us?" (fresh / stale / quiet / never / unknown). `processing.ts` asks "did
 * we do anything with what arrived?" (consuming / backlogged / dropping /
 * never_consumed / idle / unmeasured). None of them can express "we are
 * refusing deliveries", because all three read `webhook_inbox`, and a refused
 * delivery is by definition not in it.
 *
 * DECISIONS 021 and `consistency.test.ts`: one opinion per question, and no
 * shared word between vocabularies, so `live` + `fresh` + `consuming` +
 * `forged` is four facts about four questions rather than a contradiction.
 */
export type RefusalVerdict =
  /** Nothing refused in the window. */
  | 'clean'
  /** Refusals, all of them unsigned / malformed / unroutable. Scanning. */
  | 'probed'
  /** Stale timestamps dominate: a replayed capture, or OUR clock has drifted. */
  | 'stale_clock'
  /** A well-formed signature did not verify. Wrong secret, or a forger. */
  | 'forged'
  /** The query did not run. Stated, never guessed. */
  | 'uncounted';

export const REFUSAL_VERDICTS: readonly RefusalVerdict[] = [
  'clean',
  'probed',
  'stale_clock',
  'forged',
  'uncounted',
];

export interface RefusalRateRow {
  readonly provider: string;
  readonly reasonCode: RefusalReason;
  readonly refusals15m: number;
  readonly refusals24h: number;
  readonly distinctSources24h: number;
  readonly foldedRows24h: number;
  readonly lastSeenAt: Date | null;
}

export type RefusalRead =
  | { readonly ok: true; readonly rows: readonly RefusalRateRow[]; readonly latencyMs: number }
  | { readonly ok: false; readonly error: string; readonly latencyMs: number | null };

export const REFUSAL_QUERY_TIMEOUT_MS = 2_500;

export function refusalsUnavailable(error: string): RefusalRead {
  return { ok: false, error, latencyMs: null };
}

/**
 * One round trip, reading `v_webhook_refusal_rate` — the windows live in the
 * view so a psql session and this endpoint cannot disagree about what "15
 * minutes" means. Never throws: a health endpoint that cannot answer because
 * its own enrichment query failed has become the outage.
 */
export async function readWebhookRefusals(
  sql: DeliverySql,
  timeoutMs: number = REFUSAL_QUERY_TIMEOUT_MS,
): Promise<RefusalRead> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`webhook refusal query exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    const query = sql`
      select provider, reason_code, refusals_15m, refusals_24h,
             distinct_sources_24h, folded_rows_24h, last_seen_at
        from v_webhook_refusal_rate
    `;
    const result = (await Promise.race([query, timeout])) as readonly unknown[];
    return { ok: true, rows: result.map(toRateRow), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: Date.now() - startedAt,
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function toRateRow(raw: unknown): RefusalRateRow {
  const row = (raw ?? {}) as Record<string, unknown>;
  const reason = row['reason_code'];
  return {
    provider: typeof row['provider'] === 'string' ? row['provider'] : '',
    reasonCode: (REFUSAL_REASONS as readonly string[]).includes(reason as string)
      ? (reason as RefusalReason)
      : 'signature_mismatch',
    refusals15m: toCount(row['refusals_15m']),
    refusals24h: toCount(row['refusals_24h']),
    distinctSources24h: toCount(row['distinct_sources_24h']),
    foldedRows24h: toCount(row['folded_rows_24h']),
    lastSeenAt: toDate(row['last_seen_at']),
  };
}

function toCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

export interface ProviderRefusalHealth {
  readonly provider: string;
  readonly label: string;
  readonly refusals15m: number;
  readonly refusals24h: number;
  readonly byReason: Readonly<Record<RefusalReason, number>>;
  readonly distinctSources24h: number;
  readonly lastRefusal: string | null;
  readonly secondsSinceLastRefusal: number | null;
  readonly verdict: RefusalVerdict;
  readonly note: string;
}

export interface WebhookRefusalHealth {
  readonly source: 'webhook_refusal (v_webhook_refusal_rate)';
  readonly measuredAt: string;
  readonly measured: boolean;
  readonly error: string | null;
  readonly queryLatencyMs: number | null;
  /**
   * Providers whose verdict is `forged`. NOT `degradedBy`, and this endpoint
   * never marks the deployment degraded from a refusal: a stranger with curl
   * must not be able to turn our status page red, which is exactly how a status
   * page trains its readers to ignore it. It is an operator's queue, not an
   * outage.
   */
  readonly needsAttention: readonly string[];
  readonly providers: readonly ProviderRefusalHealth[];
  /**
   * Refusals aimed at a path segment that names no integration of ours. Counted
   * and NEVER listed: the segment is attacker-authored text, and a health
   * endpoint is a screen.
   */
  readonly unroutable: {
    readonly refusals15m: number;
    readonly refusals24h: number;
    readonly distinctSegments24h: number;
  };
  /** Buckets that stopped attributing a source because the write budget was spent. */
  readonly foldedRows24h: number;
}

const NO_REASONS: Readonly<Record<RefusalReason, number>> = Object.freeze({
  unknown_provider: 0,
  signature_absent: 0,
  signature_malformed: 0,
  signature_mismatch: 0,
  timestamp_outside_window: 0,
});

/**
 * Fold the read into the published field. Pure: no clock of its own, no
 * database, no network, so every branch is reachable from a test rather than
 * only from an incident.
 */
export function webhookRefusalHealth(read: RefusalRead, now: Date): WebhookRefusalHealth {
  const rows = read.ok ? read.rows : [];
  const known = new Set(Object.keys(DELIVERY_THRESHOLDS));

  const providers = Object.entries(DELIVERY_THRESHOLDS).map(([provider, threshold]) =>
    reportFor(provider, threshold.label, rows.filter((r) => r.provider === provider), read.ok, now),
  );

  const unroutableRows = rows.filter((r) => !known.has(r.provider));
  const segments = new Set(unroutableRows.map((r) => r.provider));

  return {
    source: 'webhook_refusal (v_webhook_refusal_rate)',
    measuredAt: now.toISOString(),
    measured: read.ok,
    error: read.ok ? null : read.error,
    queryLatencyMs: read.latencyMs,
    needsAttention: providers.filter((p) => p.verdict === 'forged').map((p) => p.provider),
    providers,
    unroutable: {
      refusals15m: unroutableRows.reduce((n, r) => n + r.refusals15m, 0),
      refusals24h: unroutableRows.reduce((n, r) => n + r.refusals24h, 0),
      distinctSegments24h: segments.size,
    },
    foldedRows24h: rows.reduce((n, r) => n + r.foldedRows24h, 0),
  };
}

function reportFor(
  provider: string,
  label: string,
  rows: readonly RefusalRateRow[],
  measured: boolean,
  now: Date,
): ProviderRefusalHealth {
  if (!measured) {
    return {
      provider,
      label,
      refusals15m: 0,
      refusals24h: 0,
      byReason: NO_REASONS,
      distinctSources24h: 0,
      lastRefusal: null,
      secondsSinceLastRefusal: null,
      verdict: 'uncounted',
      note: 'the refusal table could not be read; this is not a verdict about anybody',
    };
  }

  const byReason: Record<RefusalReason, number> = { ...NO_REASONS };
  for (const row of rows) byReason[row.reasonCode] += row.refusals24h;

  const refusals15m = rows.reduce((n, r) => n + r.refusals15m, 0);
  const refusals24h = rows.reduce((n, r) => n + r.refusals24h, 0);
  const distinctSources24h = rows.reduce((n, r) => Math.max(n, r.distinctSources24h), 0);
  const lastSeen = rows.reduce<Date | null>(
    (newest, r) => (r.lastSeenAt !== null && (newest === null || r.lastSeenAt > newest) ? r.lastSeenAt : newest),
    null,
  );

  const verdict: RefusalVerdict =
    refusals24h === 0
      ? 'clean'
      : byReason.signature_mismatch > 0
        ? 'forged'
        : byReason.timestamp_outside_window > 0
          ? 'stale_clock'
          : 'probed';

  return {
    provider,
    label,
    refusals15m,
    refusals24h,
    byReason,
    distinctSources24h,
    lastRefusal: lastSeen?.toISOString() ?? null,
    secondsSinceLastRefusal:
      lastSeen === null ? null : Math.max(0, Math.floor((now.getTime() - lastSeen.getTime()) / 1000)),
    verdict,
    note: NOTES[verdict],
  };
}

const NOTES: Readonly<Record<RefusalVerdict, string>> = {
  clean: 'no refused deliveries in the last 24 hours',
  probed: 'refused deliveries, none of them carrying a signature that failed to verify: scanning, or a misrouted provider',
  stale_clock: 'signatures outside the replay window: a replayed capture, or our clock has drifted and we are now refusing genuine deliveries',
  forged: 'a well-formed signature did not verify. Either the signing secret is wrong here — in which case real deliveries are being dropped — or someone is forging. The source address tells you which',
  uncounted: 'the refusal table could not be read; this is not a verdict about anybody',
};
