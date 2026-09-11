/**
 * The Stripe consumer: identity, which is a gate and not a movement.
 *
 * ─── THE DECISION, AND THE ARGUMENT FOR IT ──────────────────────────────────
 *
 * Nine verified Stripe deliveries were dead-lettered as "no consumer
 * registered". None of them is money: they are
 * `identity.verification_session.{processing,requires_input,verified,canceled}`
 * for the director-KYC leg. Three answers were available.
 *
 *   1. LEAVE THEM DEAD-LETTERING. Defensible, and rejected. The dead-letter
 *      screen is an alarm an operator is meant to act on. Nine rows nobody can
 *      act on train an operator to scroll past the tenth, which will be a
 *      returned payment.
 *
 *   2. ACKNOWLEDGE AND DROP. Honest, and not enough. The brief says polling is
 *      a fallback strategy, not the design, and this build's KYB state moves
 *      today only when a human presses "Refresh from the provider". A verified
 *      delivery that changes nothing is a webhook pipeline in name.
 *
 *   3. ACKNOWLEDGE AND RECORD — what this file does. The delivery appends one
 *      `kyb_verification_leg` observation, carrying `inbox_id`, which is what
 *      makes the account gate move on Stripe's schedule instead of an
 *      operator's. NO LEDGER ENTRY IS POSTED AND NONE EVER WILL BE: an identity
 *      check is a permission, not a payment, and a consumer that posted for one
 *      would be inventing money out of a KYC result.
 *
 * ─── IT READS THE SESSION BACK, IT DOES NOT TRUST THE EVENT BODY ────────────
 *
 * The delivery carries the session object inline, and this consumer ignores it
 * except as a pointer, for a specific and measured reason. `kyb_verification_leg`
 * is append-only and the screen folds it "latest wins" by
 * `(observed_at DESC, recorded_at DESC, seq DESC)`. Every event about one
 * session carries the SAME `observed_at`, because `identitySessionToLeg` dates
 * an observation by `session.created` — so between two deliveries about one
 * session, the one RECORDED last wins. Out-of-order delivery would therefore
 * let a stale `requires_input` beat a `verified` and quietly un-verify a
 * business.
 *
 * A `GET /v1/identity/verification_sessions/{id}` removes that entirely: both
 * deliveries read the same current session, so whichever lands last records the
 * truth. This is the same doctrine the Increase consumer runs on — the event is
 * a nudge, the provider is the source — and it is why neither consumer contains
 * a single line of ordering logic.
 *
 * ─── IDEMPOTENCE ────────────────────────────────────────────────────────────
 *
 * `INSERT ... SELECT WHERE NOT EXISTS (inbox_id = $1)`. One statement, so a
 * replay of the same delivery writes no second row. This is a weaker guarantee
 * than the ledger's unique index and it is named as weaker: two workers holding
 * the same inbox row at the same instant could both pass the guard. They cannot
 * hold it at the same instant — `claimBatch` leases the row with
 * `FOR UPDATE SKIP LOCKED` — so the window needs a lease expiry mid-flight to
 * open at all, and the cost if it ever does is one duplicate evidence row with
 * an identical status, not a double-counted anything. The money tables get
 * indexes; an evidence log gets a guard, and the difference is stated rather
 * than blurred.
 *
 * ─── WHAT IT DOES NOT DO ────────────────────────────────────────────────────
 *
 * It does not activate an account, open a leg it has never seen, or write the
 * registry leg. `v_business_kyb` derives the gate from the legs, `canTransact()`
 * reads it, and both stay exactly where they are.
 */

import "server-only";

import { sql, type Sql } from "@/lib/ledger/db";
import type { KybLegResult } from "@/lib/kyb/types";
import {
  legRow,
  StripeIdentityDirectorKycProvider,
  STRIPE_IDENTITY_PROVIDER_NAME,
} from "@/lib/kyb/wire";

import {
  consumers,
  ignored,
  parked,
  processed,
  type ConsumerContext,
  type ConsumerRegistry,
  type ConsumerResult,
  type WebhookConsumer,
} from "../dispatch";
import type { InboxEvent } from "../inbox";
import { readStoredPayload, readString } from "./payload";

export const STRIPE_WEBHOOK_PROVIDER = "stripe";

/** The only Stripe family this build subscribes to. */
const IDENTITY_PREFIX = "identity.verification_session.";

// ---------------------------------------------------------------------------
// 1. Reading the delivery
// ---------------------------------------------------------------------------

export interface IdentityPointer {
  readonly sessionId: string;
  /** `metadata.reference_id` — the business id we set when the session was created. */
  readonly referenceId: string | null;
  /** The status in the DELIVERY. Logged for comparison; never recorded. */
  readonly deliveredStatus: string | null;
}

export function asIdentityPointer(payload: Record<string, unknown>): IdentityPointer | null {
  const sessionId = readString(payload, ["data", "object", "id"]);
  if (sessionId === null || !sessionId.startsWith("vs_")) return null;
  return {
    sessionId,
    referenceId: readString(payload, ["data", "object", "metadata", "reference_id"]),
    deliveredStatus: readString(payload, ["data", "object", "status"]),
  };
}

// ---------------------------------------------------------------------------
// 2. Whose business is this session?
// ---------------------------------------------------------------------------

/**
 * Resolve the business two ways, in this order.
 *
 *   1. `metadata.reference_id`, which `StripeIdentityDirectorKycProvider.begin`
 *      stamps on every session it creates. Checked against the `business`
 *      table — an id Stripe echoes back is still input, and a row that named a
 *      business we do not have would fail the foreign key at 3am instead of
 *      here.
 *   2. Failing that, an existing leg that already cites this session. This is
 *      what catches a session created before the metadata convention, and it
 *      is a read of our own evidence rather than of the provider's payload.
 *
 * Neither answering is not an error: Stripe's test dashboard and this build's
 * own shape probes both create sessions with no `reference_id` and no leg, and
 * they are real deliveries that belong to nobody.
 */
/**
 * `metadata` is a free-text bag the provider will echo back verbatim, so a
 * `reference_id` is a STRING and not a business id until it looks like one.
 *
 * MEASURED, 2026-09-11: a real delivery carried `reference_id: "probe-shape"`,
 * and casting it straight to `::uuid` made Postgres raise
 * `invalid input syntax for type uuid`, which the dispatcher correctly recorded
 * as a failure and scheduled for retry — a retry that could never succeed,
 * eight times, ending in a dead letter whose message was a Postgres type error
 * rather than "this session belongs to nobody". A shape check before the cast
 * turns that into the right answer on the first attempt.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findBusinessForSession(
  pointer: IdentityPointer,
  conn: Sql,
): Promise<string | null> {
  if (pointer.referenceId !== null && UUID.test(pointer.referenceId)) {
    const [row] = await conn<{ id: string }[]>`
      SELECT id FROM business WHERE id = ${pointer.referenceId}::uuid LIMIT 1`;
    if (row !== undefined) return row.id;
  }
  const [leg] = await conn<{ business_id: string }[]>`
    SELECT business_id
      FROM kyb_verification_leg
     WHERE provider_reference = ${pointer.sessionId}
     ORDER BY seq DESC
     LIMIT 1`;
  return leg?.business_id ?? null;
}

// ---------------------------------------------------------------------------
// 3. Recording the observation
// ---------------------------------------------------------------------------

export interface RecordedLeg {
  readonly written: boolean;
  readonly status: string;
  readonly rawStatus: string | null;
}

/**
 * Append one director-KYC observation, keyed on the inbox row.
 *
 * The mapping from a Stripe session to our lattice is NOT re-implemented here:
 * the leg comes back from `StripeIdentityDirectorKycProvider.refresh()` and is
 * turned into a row by `legRow()`, both owned by the KYB module, so a change to
 * what `canceled` means happens in one place. What this function owns is the
 * INSERT, which duplicates the private `insertLeg` in
 * `kyb/wire.ts` — stated plainly because that file calls itself "THE ONE
 * INSERT in this module" and it is right to. The honest fix is for `wire.ts` to
 * export an insert that takes an `inbox_id`; until whoever owns that file does,
 * this statement is the alternative to a webhook path that records nothing, and
 * it is the only writer that has ever filled `kyb_verification_leg.inbox_id` —
 * the column, its foreign key and its partial index were added for exactly this
 * and had no writer at all.
 */
export async function recordIdentityLeg(args: {
  readonly businessId: string;
  readonly leg: KybLegResult<"live">;
  readonly inboxId: string;
  readonly conn: Sql;
}): Promise<RecordedLeg> {
  const row = legRow(args.businessId, args.leg);
  const checks = row.checks.map((c) => ({
    name: c.name,
    status: c.status,
    reasons: [...c.reasons],
  }));

  const written = await args.conn<{ id: string }[]>`
    INSERT INTO kyb_verification_leg
      (business_id, leg, provider, provider_reference, status, evidence, raw_status, checks,
       observed_at, inbox_id)
    SELECT ${args.businessId}::uuid,
           ${row.leg}::kyb_leg,
           ${row.provider},
           ${row.providerReference},
           ${row.status}::kyb_status,
           ${row.evidence}::kyb_evidence,
           ${row.rawStatus},
           ${args.conn.json(checks)},
           ${row.observedAt}::timestamptz,
           ${args.inboxId}::uuid
     WHERE NOT EXISTS (
       SELECT 1 FROM kyb_verification_leg WHERE inbox_id = ${args.inboxId}::uuid)
    RETURNING id`;

  return { written: written.length > 0, status: row.status, rawStatus: row.rawStatus };
}

// ---------------------------------------------------------------------------
// 4. The consumer
// ---------------------------------------------------------------------------

export interface StripeIdentityDeps {
  /** Injected in tests. Defaults to a real `GET` against Stripe at call time. */
  readonly readLeg?: (sessionId: string) => Promise<KybLegResult<"live">>;
  readonly conn?: Sql;
  readonly env?: Record<string, string | undefined>;
}

export function createStripeIdentityConsumer(deps: StripeIdentityDeps = {}): WebhookConsumer {
  const readLeg =
    deps.readLeg ??
    (async (sessionId: string): Promise<KybLegResult<"live">> => {
      const env = deps.env ?? process.env;
      const secretKey = env["STRIPE_SECRET_KEY"];
      if (secretKey === undefined || secretKey.trim() === "") {
        // Thrown, not ignored. A missing credential is a deployment fact that
        // will be fixed; retrying is right, and the dead letter after eight
        // attempts names the variable.
        throw new Error(
          "STRIPE_SECRET_KEY is not set, so the identity session cannot be read back and the " +
            "delivery cannot be recorded",
        );
      }
      const provider = new StripeIdentityDirectorKycProvider({ secretKey });
      // `refresh` is a GET. It creates nothing at Stripe and is safe to repeat.
      return provider.refresh(sessionId);
    });

  return {
    provider: STRIPE_WEBHOOK_PROVIDER,

    async handle(event: InboxEvent, ctx: ConsumerContext): Promise<ConsumerResult> {
      const eventType = event.eventType ?? "";
      if (!eventType.startsWith(IDENTITY_PREFIX)) {
        // Stripe fires hundreds of event types. This build subscribes to one
        // family; anything else is recognised and not ours, and ending the row
        // here is not the same answer as a failure.
        return ignored(`not an ${IDENTITY_PREFIX}* event (${eventType || "no event type"})`);
      }

      const payload = readStoredPayload(event.payload);
      if (payload === null) return ignored("payload is not a JSON object");

      const pointer = asIdentityPointer(payload);
      if (pointer === null) {
        return ignored("payload carries no data.object.id that looks like a verification session");
      }

      const conn = deps.conn ?? sql;
      const businessId = await findBusinessForSession(pointer, conn);
      if (businessId === null) {
        // A real, signed delivery about a session this book never asked for —
        // a dashboard test or a shape probe. IGNORED, not parked: parking is
        // for a referent that will arrive, and a session created outside the
        // onboarding flow never acquires a business.
        return ignored(
          `identity session ${pointer.sessionId} belongs to no business on this book: it carries ` +
            `no metadata.reference_id we recognise and no kyb_verification_leg cites it. Recorded ` +
            `in the inbox, not in the evidence log.`,
        );
      }

      // Read back, never trust the body. See the header.
      const leg = await readLeg(pointer.sessionId);

      if (leg.reference.trim() === "") {
        // Stripe answered with something that is not this session. Park rather
        // than file an evidence row under a reference we invented; the table's
        // `kyb_leg_reference_nonempty` CHECK would refuse it anyway, and a park
        // says why instead of throwing a constraint name at an operator.
        return parked(
          "stripe_identity_session",
          pointer.sessionId,
          `re-reading identity session ${pointer.sessionId} returned no session id, so there is ` +
            `nothing to file it under. Nothing was recorded.`,
        );
      }

      const recorded = await recordIdentityLeg({
        businessId,
        leg,
        inboxId: event.id,
        conn,
      });

      ctx.logger.info("stripe.identity.recorded", {
        inboxId: event.id,
        businessId,
        sessionId: pointer.sessionId,
        // Both, side by side, because they can differ — and when they do, the
        // read-back is the one we recorded and the delivery is the one that was
        // stale.
        deliveredStatus: pointer.deliveredStatus,
        observedStatus: recorded.rawStatus,
        kybStatus: recorded.status,
        legWritten: recorded.written,
        provider: STRIPE_IDENTITY_PROVIDER_NAME,
      });

      return processed([
        { kind: "kyb_director_session", ref: pointer.sessionId },
        { kind: "business", ref: businessId },
      ]);
    },
  };
}

export const stripeIdentityConsumer: WebhookConsumer = createStripeIdentityConsumer();

export function registerStripeIdentityConsumer(
  registry: ConsumerRegistry = consumers,
  opts: { replace?: boolean } = {},
): ConsumerRegistry {
  return registry.register(stripeIdentityConsumer, opts);
}
