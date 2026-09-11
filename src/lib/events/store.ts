/**
 * Every statement this feature issues against Postgres, in one file.
 *
 * Same rule the inbox follows: the design lives in a handful of statements —
 * `ON CONFLICT DO NOTHING` with a row count, `FOR UPDATE SKIP LOCKED` with a
 * lease, a forward-only cursor — and those have to be readable line by line
 * rather than generated.
 *
 * THE SECRET IS SELECTED IN EXACTLY ONE FUNCTION (`liveSecretsFor`), which is
 * called from exactly one place (`deliver.ts`, to sign). Every other read in
 * this file goes through `v_outbound_delivery`, which does not join the
 * secret table at all — checkable by reading migration 0034 §9.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "@/lib/ledger/db";
// THE LEDGER IS READ THROUGH ITS OWN NAMED READERS, NEVER THROUGH SQL WRITTEN
// HERE. See `generateEvents`'s header and `src/lib/ledger/boundary.test.ts`:
// an event and the API resource it points at must be the same fact, and the
// only way to guarantee that is for both to run the same query.
import {
  currentBookingWatermark,
  listBusinesses,
  listLedgerLines,
  type LedgerLineRow,
} from "@/lib/ledger/readers";
import { err, ok, type Result } from "@/lib/result";

import { buildEnvelope, eventTypeFor, type Book, type EntryType, type EnvelopeLine, type EventType } from "./envelope";
import { generateSecret, looksLikeSecret, revealSecret, wrapSecret, type SigningSecret } from "./secret";
import { checkUrlText, type UrlRefusal } from "./url";
import { resolvePublicAddress } from "./transport";

/** The stream the generator walks. One today; the name is here so a second
 *  source (say, dispute state) does not have to share a watermark. */
export const JOURNAL_STREAM = "journal";

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

export interface EndpointRow {
  readonly id: string;
  readonly businessId: string;
  readonly businessName: string;
  readonly url: string;
  readonly description: string;
  readonly status: "active" | "disabled";
  readonly eventTypes: readonly string[];
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
  /** Live secret versions. The MATERIAL is never in this shape — see the file header. */
  readonly secretVersions: readonly number[];
}

export interface RegisteredEndpoint {
  readonly endpoint: EndpointRow;
  /**
   * THE ONLY TIME THIS STRING EXISTS OUTSIDE THE SIGNER.
   *
   * Returned once, to the caller that created the endpoint, so it can be put
   * in front of the human who will paste it into their own server. It is not
   * stored anywhere else, not logged, and there is no read path that can
   * produce it again. If it is lost, the endpoint is rotated — which is a
   * supported operation and a much better answer than a "reveal" button that
   * turns a write-once secret into a read-many one.
   */
  readonly secretShownOnce: string;
}

/**
 * Register an endpoint for a business.
 *
 * The URL is validated TWICE before a row exists: the textual policy
 * (`checkUrlText`) and a real DNS resolution with every returned address
 * checked (`resolvePublicAddress`). The second is not redundant with the
 * check at send time — it is what turns "your webhook never arrives" into
 * "we refused this URL when you typed it, and here is why", which is the
 * difference between a support ticket and a fixed configuration.
 */
export async function registerEndpoint(input: {
  readonly businessId: string;
  readonly url: string;
  readonly description: string;
  readonly eventTypes?: readonly EventType[] | undefined;
  readonly createdBy?: string | null | undefined;
}): Promise<Result<RegisteredEndpoint, UrlRefusal>> {
  const checked = checkUrlText(input.url);
  if (!checked.ok) return err(checked.error);

  const resolved = await resolvePublicAddress(checked.value.hostname);
  if ("code" in resolved) return err(resolved);

  const secret = generateSecret(1);

  const rows = await sql<{ id: string }[]>`
    INSERT INTO outbound_endpoint (business_id, url, description, event_types, created_by)
    VALUES (${input.businessId}::uuid,
            ${checked.value.href},
            ${input.description},
            ${(input.eventTypes ?? []) as string[]}::text[],
            ${input.createdBy ?? null}::uuid)
    ON CONFLICT (business_id, url) DO NOTHING
    RETURNING id`;

  const created = rows[0];
  if (created === undefined) {
    return err({
      code: "UNPARSEABLE",
      message: "this business has already registered that URL. Disable the existing endpoint, or rotate its secret.",
    });
  }

  await sql`
    INSERT INTO outbound_endpoint_secret (endpoint_id, version, secret)
    VALUES (${created.id}::uuid, 1, ${revealSecret(secret)})`;

  const endpoint = await findEndpoint(created.id);
  if (endpoint === null) {
    // Cannot happen: we just inserted it. Reported rather than asserted,
    // because a thrown error here would be indistinguishable from a validation
    // refusal at the call site.
    return err({ code: "UNPARSEABLE", message: "endpoint was created but could not be read back" });
  }

  return ok({ endpoint, secretShownOnce: revealSecret(secret) });
}

export async function findEndpoint(id: string): Promise<EndpointRow | null> {
  const rows = await readEndpoints({ id });
  return rows[0] ?? null;
}

export async function listEndpoints(businessId?: string | null): Promise<readonly EndpointRow[]> {
  return readEndpoints({ businessId: businessId ?? null });
}

/**
 * Filters are nullable parameters rather than composed SQL fragments, which
 * is the pattern the ledger readers already use. A fragment builder is how
 * the MCP surface ended up with nine optional WHERE pieces and its own idea
 * of what a row was; two nulls in a prepared statement cannot drift.
 */
async function readEndpoints(filter: {
  readonly id?: string | null | undefined;
  readonly businessId?: string | null | undefined;
}): Promise<readonly EndpointRow[]> {
  // NOTE THE COLUMN LIST. `outbound_endpoint_secret.secret` is not in it and
  // cannot be: the join below selects `version` only, aggregated.
  const rows = await sql<
    {
      id: string;
      business_id: string;
      business_name: string;
      url: string;
      description: string;
      status: "active" | "disabled";
      event_types: string[];
      created_at: Date;
      disabled_at: Date | null;
      secret_versions: number[] | null;
    }[]
  >`
    SELECT ep.id, ep.business_id, b.legal_name AS business_name, ep.url, ep.description,
           ep.status, ep.event_types, ep.created_at, ep.disabled_at,
           (SELECT array_agg(s.version ORDER BY s.version)
              FROM outbound_endpoint_secret s
             WHERE s.endpoint_id = ep.id AND s.retired_at IS NULL) AS secret_versions
      FROM outbound_endpoint ep
      JOIN business b ON b.id = ep.business_id
     WHERE (${filter.id ?? null}::uuid IS NULL OR ep.id = ${filter.id ?? null}::uuid)
       AND (${filter.businessId ?? null}::uuid IS NULL OR ep.business_id = ${filter.businessId ?? null}::uuid)
     ORDER BY ep.created_at DESC`;

  return rows.map((r) => ({
    id: r.id,
    businessId: r.business_id,
    businessName: r.business_name,
    url: r.url,
    description: r.description,
    status: r.status,
    eventTypes: r.event_types,
    createdAt: r.created_at,
    disabledAt: r.disabled_at,
    secretVersions: r.secret_versions ?? [],
  }));
}

/** Stop delivering to an endpoint. The row and its delivery log survive it. */
export async function disableEndpoint(id: string): Promise<void> {
  await sql`
    UPDATE outbound_endpoint
       SET status = 'disabled', disabled_at = now()
     WHERE id = ${id}::uuid AND status = 'active'`;
}

/**
 * Rotate: issue a new version, leave the old one live.
 *
 * Both secrets sign every delivery until the old one is retired, which is
 * what makes rotation invisible to a customer — the `webhook-signature`
 * header carries two space-separated `v1,` entries and any match wins. That
 * is not a special case we invented: it is what Lithic and Increase send us,
 * and what `standardWebhooksVerifier` already parses.
 */
export async function rotateEndpointSecret(id: string): Promise<Result<string, UrlRefusal>> {
  const rows = await sql<{ next: number }[]>`
    SELECT COALESCE(MAX(version), 0) + 1 AS next FROM outbound_endpoint_secret WHERE endpoint_id = ${id}::uuid`;
  const next = rows[0]?.next ?? 1;
  const secret = generateSecret(next);
  await sql`
    INSERT INTO outbound_endpoint_secret (endpoint_id, version, secret)
    VALUES (${id}::uuid, ${next}, ${revealSecret(secret)})`;
  return ok(revealSecret(secret));
}

/** Retire an old secret version once the customer has confirmed the new one. */
export async function retireEndpointSecret(id: string, version: number): Promise<void> {
  await sql`
    UPDATE outbound_endpoint_secret
       SET retired_at = now()
     WHERE endpoint_id = ${id}::uuid AND version = ${version} AND retired_at IS NULL`;
}

/**
 * THE ONE SELECT THAT READS KEY MATERIAL.
 *
 * Called from `deliver.ts` and nowhere else. Returns opaque `SigningSecret`
 * values, so even this function's result cannot be logged or serialised into
 * a string by accident.
 */
export async function liveSecretsFor(endpointId: string): Promise<readonly SigningSecret[]> {
  const rows = await sql<{ version: number; secret: string }[]>`
    SELECT version, secret
      FROM outbound_endpoint_secret
     WHERE endpoint_id = ${endpointId}::uuid AND retired_at IS NULL
     ORDER BY version DESC`;
  return rows
    .filter((r) => looksLikeSecret(r.secret))
    .map((r) => wrapSecret(r.secret, r.version));
}

/* -------------------------------------------------------------------------- */
/* Generation: the ledger cursor                                              */
/* -------------------------------------------------------------------------- */

export interface GenerateSummary {
  readonly entriesScanned: number;
  readonly eventsCreated: number;
  readonly deliveriesQueued: number;
  readonly cursorFrom: string;
  readonly cursorTo: string;
}

/** One (entry, business) pair being assembled out of the ledger's line rows. */
interface PendingEvent {
  readonly entryId: string;
  readonly businessId: string;
  readonly bookingSeq: bigint;
  readonly bookingTime: Date;
  readonly valueDate: string;
  readonly entryType: EntryType;
  readonly book: Book;
  readonly description: string;
  readonly rail: string | null;
  readonly externalRef: string | null;
  readonly reversesEntryId: string | null;
  readonly correctionGroupId: string | null;
  readonly currency: string;
  /** Signed cents, debit-positive after `normal_side`, summed over this business's lines. */
  netCents: bigint;
  readonly lines: EnvelopeLine[];
}

function toEnvelopeLine(line: LedgerLineRow): EnvelopeLine {
  return {
    account_code: line.accountCode,
    account_name: line.accountName,
    // Cents as a decimal STRING. The reader hands back `bigint`; turning it
    // into a JSON number here is the one place the ledger's bigint discipline
    // could be quietly lost, at the exact boundary where somebody else's
    // parser gets to decide what it means.
    amount_cents: line.amountCents.toString(),
    currency: line.currency,
    memo: line.memo,
  };
}

/**
 * Turn newly-booked journal entries into outbound events, and fan them out.
 *
 * ===========================================================================
 * THIS IS A CURSOR, NOT A HOOK, AND THAT IS THE WHOLE SAFETY ARGUMENT
 * ===========================================================================
 *
 * Nothing on the posting path calls this. It reads the ledger after the fact,
 * from a watermark, exactly the way a change-data-capture consumer would.
 * Three consequences, and the third is the one that matters:
 *
 *   1. No money transaction ever contains a delivery row, so a customer's
 *      slow or dead endpoint cannot lengthen, block or roll back a posting.
 *   2. No hook had to be added to code owned by other workers.
 *   3. The feed cannot lose an event to a crash. `booking_seq` is assigned
 *      under a serialised lock so sequence order is commit order (0001 §14) —
 *      "everything above N" is a set that can never gain rows below N later,
 *      which is precisely the property a watermark needs and which a
 *      timestamp does NOT have.
 *
 * At-least-once by construction: a worker can die between inserting the
 * events and advancing the cursor, so the next pass sees the same entries
 * again. The second pass produces nothing, because `UNIQUE (business_id,
 * source_entry_id, event_type)` and `UNIQUE (event_id, endpoint_id)` decide
 * it at the database with `ON CONFLICT DO NOTHING` — the same shape the inbox
 * uses for replay, for the same reason: no SELECT-then-INSERT race and no
 * `if` in application code that could be wrong.
 *
 * ===========================================================================
 * WHY THIS READS THROUGH `listLedgerLines` AND NOT ITS OWN SQL
 * ===========================================================================
 *
 * `boundary.test.ts` is a ratchet: nothing outside `src/lib/ledger/**` may
 * write SQL against `journal_entry`, `journal_line` or `account`, because
 * every module that does has, by definition, its own answer to what a
 * transaction row is — and this build has already had four answers to what a
 * balance is, two of which printed on two screens at once and disagreed by
 * $25,040.70.
 *
 * That argument applies here with more force than anywhere else, not less.
 * An event and the API row a customer reads back through `links` MUST be the
 * same fact: same columns, same sign convention, same idea of which lines
 * belong to a business. `GET /api/v1/transactions` is `listLedgerLines`. So
 * this is `listLedgerLines` too, with the same filter object, and an event
 * carrying a different amount from the API resource it points at is now
 * unrepresentable rather than merely unlikely.
 *
 * ===========================================================================
 * THE WINDOW, AND WHY IT IS A CEILING RATHER THAN A FLOOR
 * ===========================================================================
 *
 * `listLedgerLines` pages with `bookingSeqBelow` — a CEILING, ordered
 * descending — because it exists to serve "the newest N transactions". This
 * needs the opposite end: the OLDEST entries above the watermark.
 *
 * So the watermark plus a fixed window becomes the ceiling:
 *
 *     rows where booking_seq < (cursor + WINDOW + 1), newest first, limited
 *     ...then keep only booking_seq > cursor
 *
 * which is exactly the sequence range `(cursor, cursor + WINDOW]`, oldest
 * unprocessed first, and the cursor advances by at most WINDOW per pass. The
 * queue therefore drains from the back, in order, with no possibility of
 * stepping over an entry that a descending "newest N" page would have
 * truncated away.
 *
 * TRUNCATION IS DETECTED RATHER THAN ASSUMED. If a business returns exactly
 * `LINE_BUDGET` rows, the window may have overflowed the LIMIT and the
 * dropped rows would be the oldest — the ones that matter. The window is
 * halved and the pass retried, down to a single sequence. It cannot silently
 * skip.
 */
export async function generateEvents(
  opts: {
    readonly limit?: number | undefined;
    /**
     * BACKFILL. Scan from this sequence instead of the watermark, and do NOT
     * advance the watermark afterwards.
     *
     * A deliberate operator action, never the default, exactly as 0034's
     * cursor note says: the cursor starts at the ledger head so that turning
     * this feature on does not fan thousands of historical events at the first
     * endpoint anybody registers. Safe to run at any time because it is
     * idempotent by construction — `UNIQUE (business_id, source_entry_id,
     * event_type)` means a second pass over an already-emitted entry inserts
     * nothing — and bounded by the window.
     */
    readonly backfillFrom?: bigint | undefined;
  } = {},
): Promise<GenerateSummary> {
  const backfilling = opts.backfillFrom !== undefined;

  const cursorRows = await sql<{ last_sequence: bigint }[]>`
    SELECT last_sequence FROM outbound_cursor WHERE stream = ${JOURNAL_STREAM}`;
  const from = opts.backfillFrom ?? cursorRows[0]?.last_sequence ?? 0n;

  const ledgerHead = await currentBookingWatermark(sql);
  if (ledgerHead <= from) {
    return {
      entriesScanned: 0,
      eventsCreated: 0,
      deliveriesQueued: 0,
      cursorFrom: from.toString(),
      cursorTo: from.toString(),
    };
  }

  const businesses = await listBusinesses(sql);

  // Sequences per pass, and lines per business per pass. 200 entries is a
  // comfortable drain tick; 2000 lines is ten customer-facing lines for every
  // one of them, which no entry in this book comes near.
  const maxWindow = BigInt(opts.limit ?? 200);
  const LINE_BUDGET = 2_000;

  let window = maxWindow;
  let collected: Map<string, PendingEvent> | null = null;

  while (collected === null) {
    const ceiling = from + window + 1n;
    const pending = new Map<string, PendingEvent>();
    let truncated = false;

    for (const business of businesses) {
      const lines = await listLedgerLines(
        { businessId: business.businessId, bookingSeqBelow: ceiling, limit: LINE_BUDGET },
        sql,
      );
      if (lines.length === LINE_BUDGET) {
        truncated = true;
        break;
      }
      for (const line of lines) {
        if (line.bookingSeq <= from) continue;
        // One event per (entry, business): an entry that moves two businesses
        // is two facts and reaches two feeds, and an entry that moves none —
        // a house-only posting such as interchange income — reaches none.
        const key = `${line.entryId}:${business.businessId}`;
        const existing = pending.get(key);
        if (existing === undefined) {
          pending.set(key, {
            entryId: line.entryId,
            businessId: business.businessId,
            bookingSeq: line.bookingSeq,
            bookingTime: line.bookingTime,
            valueDate: line.valueDate,
            entryType: line.entryType,
            book: line.book,
            description: line.description,
            rail: line.rail,
            externalRef: line.externalRef,
            reversesEntryId: line.reversesEntryId,
            correctionGroupId: line.correctionGroupId,
            currency: line.currency,
            netCents: line.amountCents,
            lines: [toEnvelopeLine(line)],
          });
        } else {
          existing.netCents += line.amountCents;
          existing.lines.push(toEnvelopeLine(line));
        }
      }
    }

    if (!truncated) {
      collected = pending;
      break;
    }
    if (window === 1n) {
      // One sequence's worth of one business's lines exceeded the budget.
      // Refuse rather than emit a partial entry: a half-described movement is
      // worse than a late one.
      throw new Error(
        `outbound generation: a single booking sequence produced more than ${LINE_BUDGET} customer lines; ` +
          `raise LINE_BUDGET rather than emitting a truncated entry`,
      );
    }
    window = window / 2n;
  }

  // The watermark advances over the WINDOW that was scanned, not only the
  // entries that produced events — otherwise a run of house-only entries
  // would be re-scanned for ever.
  const head = ledgerHead < from + window ? ledgerHead : from + window;

  let eventsCreated = 0;
  let deliveriesQueued = 0;

  // Ascending, so a drain that is interrupted has emitted a prefix of the
  // feed rather than a scatter. Not a promise to the customer — `sequence`
  // is that — but it makes the delivery log readable.
  const ordered = [...collected.values()].sort((a, b) =>
    a.bookingSeq === b.bookingSeq ? a.businessId.localeCompare(b.businessId) : a.bookingSeq < b.bookingSeq ? -1 : 1,
  );

  for (const row of ordered) {
    const eventType = eventTypeFor(row.book, row.entryType);

    // THE ID IS MINTED HERE, NOT BY THE DATABASE.
    //
    // The body contains the event id and the body is signed, so the id has to
    // exist before the row does — `outbound_event` is guarded immutable
    // (0034 §7), so there is no "insert then UPDATE the body in" path and
    // there must not be: a body that can be edited after signing is a
    // signature over something other than what was sent. `randomUUID()` is
    // the same CSPRNG `gen_random_uuid()` reaches for; the only thing lost is
    // that the default is unused on this table.
    const eventId = randomUUID();

    const body = buildEnvelope({
      eventId,
      businessId: row.businessId,
      eventType,
      sequence: row.bookingSeq,
      occurredAt: row.bookingTime,
      valueDate: row.valueDate,
      entryId: row.entryId,
      entryType: row.entryType,
      book: row.book,
      description: row.description,
      rail: row.rail,
      externalRef: row.externalRef,
      reversesEntryId: row.reversesEntryId,
      correctionGroupId: row.correctionGroupId,
      netCents: row.netCents,
      currency: row.currency,
      lines: row.lines,
    });

    const inserted = await sql<{ id: string }[]>`
      INSERT INTO outbound_event (id, business_id, event_type, sequence, occurred_at, value_date, source_entry_id, body)
      VALUES (${eventId}::uuid, ${row.businessId}::uuid, ${eventType}, ${row.bookingSeq},
              ${row.bookingTime}, ${row.valueDate}::date, ${row.entryId}::uuid, ${body})
      ON CONFLICT (business_id, source_entry_id, event_type) DO NOTHING
      RETURNING id`;

    // Zero rows means this entry has already been emitted for this business.
    // Not an error: it is the at-least-once generator meeting its own guard,
    // and THE ROW COUNT IS THE DECISION — no SELECT first, so no race between
    // two statements, and no `if` over application state that could be wrong.
    if (inserted.length === 0) continue;

    eventsCreated += 1;

    const queued = await sql<{ id: string }[]>`
      INSERT INTO outbound_delivery (event_id, endpoint_id)
      SELECT ${eventId}::uuid, ep.id
        FROM outbound_endpoint ep
       WHERE ep.business_id = ${row.businessId}::uuid
         AND ep.status = 'active'
         AND (cardinality(ep.event_types) = 0 OR ${eventType} = ANY (ep.event_types))
      ON CONFLICT (event_id, endpoint_id) DO NOTHING
      RETURNING id`;
    deliveriesQueued += queued.length;
  }

  // A backfill never moves the watermark. It is a scan over history; the
  // watermark is a statement about what has been seen going forward, and
  // conflating the two is how a backfill silently skips live traffic.
  if (!backfilling && head > from) {
    await sql`
      UPDATE outbound_cursor
         SET last_sequence = ${head}, updated_at = now()
       WHERE stream = ${JOURNAL_STREAM} AND last_sequence < ${head}`;
  }

  return {
    entriesScanned: ordered.length,
    eventsCreated,
    deliveriesQueued,
    cursorFrom: from.toString(),
    cursorTo: head.toString(),
  };
}

/**
 * Queue existing events for an endpoint that did not exist when they were
 * created.
 *
 * Fan-out happens at event creation, so an endpoint registered today receives
 * nothing that happened yesterday. That is the right default — a customer
 * integrating now wants what happens now — but it makes the first minutes of
 * an integration untestable, which is when a customer most needs to see a
 * delivery land. So this exists, bounded and explicit: the N most recent
 * events for that endpoint's business, matching its subscription filter.
 *
 * `ON CONFLICT DO NOTHING` makes it safe to run twice; the newest events are
 * chosen rather than the oldest, because the point is a live-looking sample
 * and not a replay of history.
 */
export async function backfillEndpoint(endpointId: string, limit = 5): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO outbound_delivery (event_id, endpoint_id)
    SELECT e.id, ep.id
      FROM outbound_endpoint ep
      JOIN LATERAL (
        SELECT ev.id, ev.event_type
          FROM outbound_event ev
         WHERE ev.business_id = ep.business_id
         ORDER BY ev.sequence DESC
         LIMIT ${limit}
      ) e ON (cardinality(ep.event_types) = 0 OR e.event_type = ANY (ep.event_types))
     WHERE ep.id = ${endpointId}::uuid AND ep.status = 'active'
    ON CONFLICT (event_id, endpoint_id) DO NOTHING
    RETURNING id`;
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* The delivery queue                                                         */
/* -------------------------------------------------------------------------- */

export interface ClaimedDelivery {
  readonly deliveryId: string;
  readonly eventId: string;
  readonly endpointId: string;
  readonly url: string;
  readonly attempts: number;
  readonly body: string;
  /**
   * Carried through the claim on purpose.
   *
   * Fan-out only queues for `active` endpoints, so this looks redundant — and
   * it is not. Disabling an endpoint does nothing to the rows ALREADY in the
   * queue, and without this they keep knocking on a door somebody explicitly
   * closed, for eight attempts each, while the screen says "nothing further is
   * queued for it". `deliver.ts` turns a disabled endpoint into a dead letter
   * that says so, which is the honest end for a delivery nobody wants.
   */
  readonly endpointStatus: "active" | "disabled";
}

/**
 * Claim due deliveries, oldest first, under a lease.
 *
 * `FOR UPDATE SKIP LOCKED` so two workers never pick the same row, and
 * `attempts` is incremented AT CLAIM rather than at failure — the inbox's
 * poison-message defence, unchanged: a worker that dies mid-delivery has
 * still spent an attempt, so an endpoint that reliably kills workers cannot
 * loop for ever.
 *
 * `locked_until` is a lease and not a state. A worker that dies releases its
 * work by doing nothing at all.
 */
export async function claimDeliveries(opts: {
  readonly limit: number;
  readonly now: Date;
  readonly leaseMs: number;
}): Promise<readonly ClaimedDelivery[]> {
  const until = new Date(opts.now.getTime() + opts.leaseMs);
  const rows = await sql<
    {
      id: string;
      event_id: string;
      endpoint_id: string;
      url: string;
      attempts: number;
      body: string;
      endpoint_status: "active" | "disabled";
    }[]
  >`
    WITH due AS (
      SELECT d.id
        FROM outbound_delivery d
       WHERE d.state = 'pending'
         AND d.next_attempt_at <= ${opts.now}
         AND (d.locked_until IS NULL OR d.locked_until <= ${opts.now})
       ORDER BY d.next_attempt_at, d.created_at
       FOR UPDATE SKIP LOCKED
       LIMIT ${opts.limit}
    )
    UPDATE outbound_delivery d
       SET locked_until = ${until}, attempts = d.attempts + 1
      FROM due
     WHERE d.id = due.id
    RETURNING d.id, d.event_id, d.endpoint_id, d.attempts,
              (SELECT ep.url    FROM outbound_endpoint ep WHERE ep.id = d.endpoint_id) AS url,
              (SELECT ep.status FROM outbound_endpoint ep WHERE ep.id = d.endpoint_id)::text AS endpoint_status,
              (SELECT e.body    FROM outbound_event e    WHERE e.id = d.event_id)      AS body`;

  return rows.map((r) => ({
    deliveryId: r.id,
    eventId: r.event_id,
    endpointId: r.endpoint_id,
    url: r.url,
    attempts: r.attempts,
    body: r.body,
    endpointStatus: r.endpoint_status,
  }));
}

export async function recordAttempt(input: {
  readonly deliveryId: string;
  readonly attemptNo: number;
  readonly durationMs: number;
  readonly responseStatus: number | null;
  readonly responseExcerpt: string | null;
  readonly error: string | null;
  readonly webhookId: string;
  readonly webhookTimestamp: number;
  readonly secretVersion: number;
  readonly resolvedIp: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO outbound_attempt
      (delivery_id, attempt_no, duration_ms, response_status, response_excerpt, error,
       webhook_id, webhook_timestamp, secret_version, resolved_ip)
    VALUES (${input.deliveryId}::uuid, ${input.attemptNo}, ${input.durationMs},
            ${input.responseStatus}, ${input.responseExcerpt}, ${input.error},
            ${input.webhookId}, ${input.webhookTimestamp}, ${input.secretVersion},
            ${input.resolvedIp}::inet)
    ON CONFLICT (delivery_id, attempt_no) DO NOTHING`;
}

export async function markDelivered(input: {
  readonly deliveryId: string;
  readonly status: number;
  readonly now: Date;
}): Promise<void> {
  await sql`
    UPDATE outbound_delivery
       SET state = 'delivered', delivered_at = ${input.now}, last_status = ${input.status},
           last_error = NULL, last_attempt_at = ${input.now}, locked_until = NULL
     WHERE id = ${input.deliveryId}::uuid AND state = 'pending'`;
}

export async function scheduleRetry(input: {
  readonly deliveryId: string;
  readonly status: number | null;
  readonly error: string;
  readonly nextAttemptAt: Date;
  readonly now: Date;
}): Promise<void> {
  await sql`
    UPDATE outbound_delivery
       SET next_attempt_at = ${input.nextAttemptAt}, locked_until = NULL,
           last_status = ${input.status}, last_error = ${clip(input.error, 2000)},
           last_attempt_at = ${input.now}
     WHERE id = ${input.deliveryId}::uuid AND state = 'pending'`;
}

export async function deadLetter(input: {
  readonly deliveryId: string;
  readonly status: number | null;
  readonly reason: string;
  readonly now: Date;
}): Promise<void> {
  await sql`
    UPDATE outbound_delivery
       SET state = 'dead', dead_at = ${input.now}, dead_reason = ${clip(input.reason, 2000)},
           last_status = ${input.status}, last_error = ${clip(input.reason, 2000)},
           last_attempt_at = ${input.now}, locked_until = NULL
     WHERE id = ${input.deliveryId}::uuid AND state = 'pending'`;
}

/* -------------------------------------------------------------------------- */
/* The delivery log                                                           */
/* -------------------------------------------------------------------------- */

export interface DeliveryLogRow {
  readonly deliveryId: string;
  readonly state: "pending" | "delivered" | "dead";
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastStatus: number | null;
  readonly lastError: string | null;
  readonly lastAttemptAt: Date | null;
  readonly deliveredAt: Date | null;
  readonly deadAt: Date | null;
  readonly deadReason: string | null;
  readonly queuedAt: Date;
  readonly eventId: string;
  readonly businessId: string;
  readonly eventType: string;
  readonly sequence: string;
  readonly occurredAt: Date;
  readonly valueDate: string;
  readonly bodyBytes: number;
  readonly endpointId: string;
  readonly url: string;
  readonly endpointDescription: string;
  readonly lastResponseStatus: number | null;
  readonly lastResponseExcerpt: string | null;
  readonly lastDurationMs: number | null;
  readonly lastResolvedIp: string | null;
  readonly lastWebhookId: string | null;
}

export async function listDeliveryLog(opts: {
  readonly businessId?: string | null | undefined;
  readonly state?: "pending" | "delivered" | "dead" | null | undefined;
  readonly limit?: number | undefined;
}): Promise<readonly DeliveryLogRow[]> {
  const rows = await sql<
    {
      delivery_id: string;
      state: "pending" | "delivered" | "dead";
      attempts: number;
      next_attempt_at: Date;
      last_status: number | null;
      last_error: string | null;
      last_attempt_at: Date | null;
      delivered_at: Date | null;
      dead_at: Date | null;
      dead_reason: string | null;
      queued_at: Date;
      event_id: string;
      business_id: string;
      event_type: string;
      sequence: bigint;
      occurred_at: Date;
      value_date: string;
      body_bytes: number;
      endpoint_id: string;
      url: string;
      endpoint_description: string;
      last_response_status: number | null;
      last_response_excerpt: string | null;
      last_duration_ms: number | null;
      last_resolved_ip: string | null;
      last_webhook_id: string | null;
    }[]
  >`
    SELECT delivery_id, state, attempts, next_attempt_at, last_status, last_error, last_attempt_at,
           delivered_at, dead_at, dead_reason, queued_at, event_id, business_id, event_type,
           sequence, occurred_at, value_date::text AS value_date, body_bytes,
           endpoint_id, url, endpoint_description,
           last_response_status, last_response_excerpt, last_duration_ms,
           host(last_resolved_ip) AS last_resolved_ip, last_webhook_id
      FROM v_outbound_delivery
     WHERE (${opts.businessId ?? null}::uuid IS NULL OR business_id = ${opts.businessId ?? null}::uuid)
       AND (${opts.state ?? null}::text IS NULL OR state::text = ${opts.state ?? null}::text)
     ORDER BY queued_at DESC, sequence DESC
     LIMIT ${opts.limit ?? 100}`;

  return rows.map((r) => ({
    deliveryId: r.delivery_id,
    state: r.state,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    lastStatus: r.last_status,
    lastError: r.last_error,
    lastAttemptAt: r.last_attempt_at,
    deliveredAt: r.delivered_at,
    deadAt: r.dead_at,
    deadReason: r.dead_reason,
    queuedAt: r.queued_at,
    eventId: r.event_id,
    businessId: r.business_id,
    eventType: r.event_type,
    sequence: r.sequence.toString(),
    occurredAt: r.occurred_at,
    valueDate: r.value_date,
    bodyBytes: r.body_bytes,
    endpointId: r.endpoint_id,
    url: r.url,
    endpointDescription: r.endpoint_description,
    lastResponseStatus: r.last_response_status,
    lastResponseExcerpt: r.last_response_excerpt,
    lastDurationMs: r.last_duration_ms,
    lastResolvedIp: r.last_resolved_ip,
    lastWebhookId: r.last_webhook_id,
  }));
}

export interface QueueCounts {
  readonly pending: number;
  readonly delivered: number;
  readonly dead: number;
  readonly dueNow: number;
  readonly cursor: string;
  readonly ledgerHead: string;
}

export async function queueCounts(businessId?: string | null): Promise<QueueCounts> {
  const rows = await sql<
    { pending: number; delivered: number; dead: number; due_now: number }[]
  >`
    SELECT count(*) FILTER (WHERE state = 'pending')::int   AS pending,
           count(*) FILTER (WHERE state = 'delivered')::int AS delivered,
           count(*) FILTER (WHERE state = 'dead')::int      AS dead,
           count(*) FILTER (WHERE state = 'pending' AND next_attempt_at <= now())::int AS due_now
      FROM v_outbound_delivery
     WHERE (${businessId ?? null}::uuid IS NULL OR business_id = ${businessId ?? null}::uuid)`;

  const watermark = await sql<{ cursor: bigint | null }[]>`
    SELECT last_sequence AS cursor FROM outbound_cursor WHERE stream = ${JOURNAL_STREAM}`;
  // The ledger's head comes from the ledger's own reader, not from a MAX()
  // written here. Four modules were computing that inline before
  // `currentBookingWatermark` existed; this is not going to be the fifth.
  const head = await currentBookingWatermark(sql);

  const c = rows[0];
  return {
    pending: c?.pending ?? 0,
    delivered: c?.delivered ?? 0,
    dead: c?.dead ?? 0,
    dueNow: c?.due_now ?? 0,
    cursor: (watermark[0]?.cursor ?? 0n).toString(),
    ledgerHead: head.toString(),
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
