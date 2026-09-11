/**
 * The driver: the outbox, and the door chaos puts its deliveries through.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * THE DOOR, AND WHY IT IS THIS ONE
 *
 * A chaos delivery is handed to `ingestWebhook` — the exact function the
 * deployed `/api/webhooks/[provider]` route calls, with the exact
 * `createPostgresInboxStore` the route uses — together with a verifier
 * registry chaos builds itself, holding `lithicVerifier({ secret: chaosSecret() })`.
 *
 * So a chaos delivery is:
 *
 *   verified   over its own raw bytes, by the production verifier factory
 *   persisted  into `webhook_inbox`, by the production store
 *   deduped    by UNIQUE (provider, provider_event_id), by Postgres
 *   dispatched by `drain()`, to the production Lithic consumer
 *   applied    by `applyCardTransaction`, to the real ledger
 *
 * and the ONE thing it is not is accepted over HTTP by the deployed route,
 * because chaos refuses to hold a provider's signing key. `./sign.ts` argues
 * that refusal at length; the short version is that the ACH simulator settled
 * this question for the rail next door and its answer is the right one.
 *
 * WHAT THAT COSTS, STATED HONESTLY. Two links of the chain are not exercised
 * by chaos: the HTTP shell in `src/app/api/webhooks/[provider]/route.ts`, and
 * the comparison of a signature against Lithic's own subscription secret.
 * Both ARE exercised, over real HTTP against the deployed URL, by
 * `src/test/livefire/attack-04`, `-07` and `-08`. Neither claim borrows the
 * other's evidence, and `docs/CHAOS.md` §4 draws the line in a table.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * THERE IS NO CHAOS BRANCH DOWNSTREAM OF THIS FILE. Nothing in
 * `src/lib/webhooks/**`, `src/lib/holds/**` or `src/lib/ledger/**` knows chaos
 * exists, and nothing in them was changed. If a duplicate is suppressed it is
 * because Postgres refused a second row; if an out-of-order clearing lands
 * correctly it is because the consumer was already order-independent; if an
 * event parks it is because the card is not registered and the system refuses
 * to guess whose money to move. Chaos gets no credit for any of it, which is
 * the point of running it.
 */

import 'server-only';

import { randomUUID } from 'node:crypto';

import { registerCard } from '@/lib/holds';
import { sql, type Sql } from '@/lib/ledger/db';
import { logger } from '@/lib/log';
import {
  createPostgresInboxStore,
  ingestWebhook,
  lithicVerifier,
  sqlExecutorFromPostgresJs,
  VerifierRegistry,
  type IngestResult,
} from '@/lib/webhooks/inbox';
import { drain } from '@/lib/webhooks/drain';

import { chaosBody, newEpisodeIdentifiers } from './body';
import { isDue, planDeliveries, describePlan, type PlannedDelivery } from './plan';
import { chaosSecret, signChaosDelivery } from './sign';
import { readChaosState, recordChaosEvent, webhooksOff } from './switch';
import {
  CHAOS_AUTH_CENTS,
  CHAOS_CLEARING_CENTS,
  CHAOS_PROVIDER,
  type ChaosDeliveryOutcome,
  type ChaosDeliveryRow,
  type ChaosStep,
} from './types';

const log = logger({ base: { module: 'chaos' } });

/**
 * Chaos's verifier registry.
 *
 * Built per call rather than held in a module-level singleton, so that the
 * process-wide `verifiers` registry — the one the deployed route uses — is
 * never mutated and cannot end up holding a verifier that accepts chaos bytes.
 * Building an HMAC verifier is microseconds; a registry leaking across a
 * serverless instance's requests would be a security bug.
 */
function chaosRegistry(): VerifierRegistry {
  return new VerifierRegistry().register(lithicVerifier({ secret: chaosSecret() }));
}

/** `RawRequest` is structural, so a delivery is an object literal. */
function asRawRequest(rawBody: string, headers: Readonly<Record<string, string>>): {
  text(): Promise<string>;
  headers: Headers;
} {
  return {
    text: () => Promise.resolve(rawBody),
    headers: new Headers(headers),
  };
}

// ---------------------------------------------------------------------------
// Starting an episode
// ---------------------------------------------------------------------------

export interface StartRunOptions {
  readonly actor: string;
  /**
   * Register the card BEFORE the episode runs.
   *
   * False is the more interesting demo and it is the one the screen defaults
   * to: the deliveries land for a card nobody has bound to a customer, the
   * consumer answers `parked("card", <token>)`, and the parked count climbs
   * while the ledger does not move by one cent. That is not chaos being
   * clever — it is the system refusing to guess whose money to move, which is
   * the single most load-bearing behaviour in the whole build.
   */
  readonly registerCardFirst: boolean;
  /** Defaults to the first seeded business with a 2100/9100 account pair. */
  readonly businessId?: string | undefined;
  readonly note?: string | undefined;
}

export interface StartRunResult {
  readonly runId: string;
  readonly cardToken: string;
  readonly businessId: string;
  readonly transactionToken: string;
  readonly planned: number;
  readonly summary: string;
  readonly released: ReleaseResult;
}

/**
 * The customer whose book the episode moves.
 *
 * TWO CANDIDATE READS, AND NEITHER OF THEM IS `FROM account`. The obvious
 * query here is the 2100/9100 join that `registerCard` itself performs, and
 * writing it would put a fourth answer to "which accounts does a business
 * have" in a fourth module. `src/lib/ledger/boundary.test.ts` is a ratchet
 * against exactly that, and it is right: this file has no business knowing the
 * chart of accounts.
 *
 * So the preferred read is `card` — a business that ALREADY has a registered
 * card is, by construction, one for which `registerCard` succeeded, which is a
 * stronger predicate than re-deriving the join and a cheaper one to be wrong
 * about. The fallback is `v_business_accounts`, the view that already answers
 * "which businesses have a deposit account". If neither yields a business that
 * `registerCard` accepts, `registerCard` says so in its own words rather than
 * this function guessing at the reason.
 */
async function defaultBusinessId(conn: Sql): Promise<string> {
  const withCard = await conn<{ business_id: string }[]>`
    SELECT business_id
      FROM card
     WHERE provider = ${CHAOS_PROVIDER} AND business_id IS NOT NULL
     GROUP BY business_id
     ORDER BY count(*) DESC, business_id
     LIMIT 1`;
  const preferred = withCard[0];
  if (preferred !== undefined) return preferred.business_id;

  const anyBusiness = await conn<{ business_id: string }[]>`
    SELECT business_id
      FROM v_business_accounts
     WHERE deposit_account_id IS NOT NULL
     ORDER BY business_id
     LIMIT 1`;
  const fallback = anyBusiness[0];
  if (fallback === undefined) {
    throw new Error(
      'no business on this book has a deposit account; run `node scripts/seed.mjs` before using chaos mode',
    );
  }
  return fallback.business_id;
}

/**
 * Plan, sign and persist one episode, then release whatever is already due.
 *
 * The bodies are signed and written to `chaos_delivery` BEFORE anything is
 * ingested. That ordering is the thing that makes `webhooks_off` a real outage
 * rather than a cancellation: the deliveries exist, durably, and the switch
 * only decides whether they leave. Turning it off is the provider coming back,
 * and the backlog catches up.
 */
export async function startChaosRun(
  opts: StartRunOptions,
  conn: Sql = sql,
): Promise<StartRunResult> {
  const state = await readChaosState(conn);
  const businessId = opts.businessId ?? (await defaultBusinessId(conn));
  const ids = newEpisodeIdentifiers();
  const runId = randomUUID();
  const now = new Date();

  const planned = planDeliveries({ runId, now, active: state.active });
  const summary = describePlan(planned);

  await conn`
    INSERT INTO chaos_run (id, started_at, started_by, card_token, business_id,
                           card_registered, transaction_token,
                           auth_cents, clearing_cents, controls, note)
    VALUES (${runId}::uuid, ${now}, ${opts.actor}, ${ids.cardToken}, ${businessId}::uuid,
            ${opts.registerCardFirst}, ${ids.transactionToken},
            ${CHAOS_AUTH_CENTS}, ${CHAOS_CLEARING_CENTS},
            ${conn.json(state.active.map((c) => c.control))}, ${opts.note ?? summary})`;

  // The card is bound BEFORE the deliveries land, or not at all. Registering it
  // later is a separate, deliberate action on the screen — see
  // `registerEpisodeCard` — because the drain from parked to posted is the
  // frame worth watching and it must be something a grader presses.
  if (opts.registerCardFirst) {
    await registerCard(
      {
        provider: CHAOS_PROVIDER,
        providerCardToken: ids.cardToken,
        businessId,
        lastFour: ids.cardToken.slice(-4),
        nickname: `chaos mode ${runId.slice(0, 8)}`,
      },
      conn,
    );
  }

  const secret = chaosSecret();

  // Sign ONCE PER SLOT and reuse the bytes for every copy. A duplicate that was
  // re-signed would carry a different `webhook-timestamp` and therefore a
  // different signature, which is a different delivery that merely looks
  // similar — and the replay suppression it is meant to demonstrate would be
  // suppressing the wrong thing.
  const signedBySeq = new Map<number, { rawBody: string; headers: Record<string, string> }>();

  for (const slot of planned) {
    if (!signedBySeq.has(slot.seq)) {
      const body = chaosBody(slot.step, {
        runId,
        transactionToken: ids.transactionToken,
        cardToken: ids.cardToken,
        authCents: CHAOS_AUTH_CENTS,
        clearingCents: CHAOS_CLEARING_CENTS,
        created: now,
        shapedBy: slot.shapedBy.join('+'),
        authEventToken: ids.authEventToken,
        clearingEventToken: ids.clearingEventToken,
        descriptor: `CORGI CHAOS ${runId.slice(0, 6).toUpperCase()}`,
      });
      const signed = signChaosDelivery({ secret, webhookId: slot.webhookId, body, at: now });
      signedBySeq.set(slot.seq, { rawBody: signed.rawBody, headers: { ...signed.headers } });
    }
    const signed = signedBySeq.get(slot.seq);
    if (signed === undefined) continue;

    await conn`
      INSERT INTO chaos_delivery (run_id, seq, step, copy_index, provider,
                                  webhook_id, raw_body, headers, planned_at,
                                  outcome, detail)
      VALUES (${runId}::uuid, ${slot.seq}, ${slot.step}, ${slot.copyIndex}, ${CHAOS_PROVIDER},
              ${slot.webhookId}, ${signed.rawBody}, ${conn.json(signed.headers)},
              ${slot.plannedAt}, 'withheld',
              ${slot.shapedBy.length === 0 ? null : `shaped by ${slot.shapedBy.join(', ')}`})`;
  }

  await recordChaosEvent(
    {
      kind: 'run_started',
      runId,
      actor: opts.actor,
      detail: `episode started: ${summary}`,
      params: {
        card_registered: opts.registerCardFirst,
        controls: state.active.map((c) => c.control),
      },
    },
    conn,
  );

  const released = await releaseDueDeliveries({ actor: opts.actor }, conn);

  return {
    runId,
    cardToken: ids.cardToken,
    businessId,
    transactionToken: ids.transactionToken,
    planned: planned.length,
    summary,
    released,
  };
}

// ---------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------

export interface ReleaseResult {
  readonly considered: number;
  readonly released: number;
  readonly accepted: number;
  readonly suppressedReplays: number;
  readonly refused: number;
  readonly heldBack: number;
  readonly webhooksOff: boolean;
  readonly drained: boolean;
  readonly note: string;
}

interface OutboxRow {
  id: string;
  run_id: string;
  seq: number;
  step: string;
  copy_index: number;
  webhook_id: string;
  raw_body: string;
  headers: Record<string, string>;
  planned_at: Date;
  outcome: string;
}

/**
 * Release everything the armed controls now allow, and drain.
 *
 * Called on every page load and by the screen's explicit button. Idempotent by
 * construction: a row leaves the outbox exactly once because the UPDATE that
 * records its outcome is what makes `isDue` false for it, and even a double
 * release would be absorbed downstream by the same replay suppression that
 * absorbs the duplicate control.
 */
export async function releaseDueDeliveries(
  opts: { actor: string; runId?: string | undefined },
  conn: Sql = sql,
): Promise<ReleaseResult> {
  const state = await readChaosState(conn);
  const off = webhooksOff(state);
  const now = new Date();

  const rows = opts.runId === undefined
    ? await conn<OutboxRow[]>`
        SELECT id, run_id, seq, step, copy_index, webhook_id, raw_body, headers,
               planned_at, outcome
          FROM chaos_delivery
         WHERE outcome = 'withheld'
         ORDER BY planned_at, seq, copy_index`
    : await conn<OutboxRow[]>`
        SELECT id, run_id, seq, step, copy_index, webhook_id, raw_body, headers,
               planned_at, outcome
          FROM chaos_delivery
         WHERE outcome = 'withheld' AND run_id = ${opts.runId}::uuid
         ORDER BY planned_at, seq, copy_index`;

  if (off) {
    // THE OUTAGE, AND WHAT IT IS NOT. Nothing leaves. Nothing is marked
    // failed, retried or dead-lettered, because none of those things happened:
    // the deliveries are sitting in an outbox we are refusing to flush. A row
    // that recorded an outage as a delivery FAILURE would be a lie about our
    // own switch, and it is the exact lie the banner exists to prevent.
    return {
      considered: rows.length,
      released: 0,
      accepted: 0,
      suppressedReplays: 0,
      refused: 0,
      heldBack: rows.length,
      webhooksOff: true,
      drained: false,
      note:
        rows.length === 0
          ? 'webhooks are off. Nothing is waiting.'
          : `webhooks are off. ${String(rows.length)} deliveries are waiting in the outbox and will ` +
            'catch up the moment the switch is turned off or runs out.',
    };
  }

  const due = rows.filter((row) =>
    isDue({ plannedAt: row.planned_at, outcome: row.outcome }, { now, webhooksOff: false }),
  );

  if (due.length === 0) {
    return {
      considered: rows.length,
      released: 0,
      accepted: 0,
      suppressedReplays: 0,
      refused: 0,
      heldBack: rows.length,
      webhooksOff: false,
      drained: false,
      note:
        rows.length === 0
          ? 'nothing waiting.'
          : `${String(rows.length)} delivery(s) are scheduled for later and are not due yet.`,
    };
  }

  const registry = chaosRegistry();
  const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(conn));

  let accepted = 0;
  let suppressed = 0;
  let refused = 0;

  for (const row of due) {
    let outcome: ChaosDeliveryOutcome;
    let inboxId: string | null = null;
    let detail: string | null = null;

    try {
      const result: IngestResult = await ingestWebhook(
        CHAOS_PROVIDER,
        asRawRequest(row.raw_body, row.headers),
        { store, registry },
      );
      switch (result.status) {
        case 'accepted':
          outcome = 'accepted';
          inboxId = result.id;
          accepted += 1;
          break;
        case 'replay':
          // THE DEMONSTRATION. Postgres refused the duplicate on
          // UNIQUE (provider, provider_event_id). Chaos did not check for it,
          // did not look it up first, and has no code path that could have
          // produced this answer.
          outcome = 'replay';
          inboxId = result.id;
          suppressed += 1;
          detail = 'suppressed by webhook_inbox UNIQUE (provider, provider_event_id)';
          break;
        case 'dead_on_arrival':
          outcome = 'dead_on_arrival';
          inboxId = result.id;
          refused += 1;
          detail = result.reason;
          break;
        case 'rejected':
          outcome = 'rejected';
          refused += 1;
          detail = result.reason;
          break;
      }
    } catch (thrown) {
      outcome = 'failed';
      refused += 1;
      detail = thrown instanceof Error ? thrown.message.slice(0, 200) : 'ingest threw';
      log.warn('chaos.release_failed', { deliveryId: row.id, error: detail });
    }

    await conn`
      UPDATE chaos_delivery
         SET outcome     = ${outcome},
             released_at = ${now},
             inbox_id    = ${inboxId}::uuid,
             detail      = ${detail}
       WHERE id = ${row.id}::uuid`;
  }

  // The ordinary drain, with no arguments chaos invented. Whatever happens to
  // these rows now happens to them as webhook deliveries, not as chaos.
  let drained = false;
  try {
    await drain();
    drained = true;
  } catch (thrown) {
    log.warn('chaos.drain_failed', {
      error: thrown instanceof Error ? thrown.message : 'unknown',
    });
  }

  await recordChaosEvent(
    {
      kind: 'released',
      ...(opts.runId === undefined ? {} : { runId: opts.runId }),
      actor: opts.actor,
      detail:
        `released ${String(due.length)}: ${String(accepted)} accepted, ` +
        `${String(suppressed)} suppressed as replays, ${String(refused)} refused`,
      params: { accepted, suppressed, refused },
    },
    conn,
  );

  return {
    considered: rows.length,
    released: due.length,
    accepted,
    suppressedReplays: suppressed,
    refused,
    heldBack: rows.length - due.length,
    webhooksOff: false,
    drained,
    note:
      `${String(due.length)} delivery(s) left the outbox: ${String(accepted)} accepted, ` +
      `${String(suppressed)} suppressed as replays by the inbox's own unique key, ` +
      `${String(refused)} refused.`,
  };
}

// ---------------------------------------------------------------------------
// Draining the parks
// ---------------------------------------------------------------------------

export interface RegisterCardResult {
  readonly registered: boolean;
  readonly woken: number;
  readonly note: string;
}

/**
 * Bind the episode's card to its customer, and wake what was waiting on it.
 *
 * THIS IS THE FRAME WORTH WATCHING. Before it, the deliveries are verified,
 * durable and PARKED: the system has the money event and refuses to post it,
 * because it does not know whose money to move and will not guess. After it,
 * the same events — not re-delivered, not re-signed, not re-anything — post
 * against the right customer at the right value date.
 *
 * `unparkWaitingFor` is the SAME call the dispatcher makes when a consumer
 * reports that it produced a `card` ref. Chaos is not reaching around the park
 * mechanism; it is telling it the truth it was waiting for.
 */
export async function registerEpisodeCard(
  runId: string,
  actor: string,
  conn: Sql = sql,
): Promise<RegisterCardResult> {
  const rows = await conn<{ card_token: string; business_id: string | null; card_registered: boolean }[]>`
    SELECT card_token, business_id, card_registered FROM chaos_run WHERE id = ${runId}::uuid`;
  const run = rows[0];
  if (run === undefined) throw new Error(`no chaos run ${runId}`);
  if (run.business_id === null) throw new Error(`chaos run ${runId} has no business`);
  if (run.card_registered) {
    return { registered: false, woken: 0, note: 'this episode’s card was already registered.' };
  }

  await registerCard(
    {
      provider: CHAOS_PROVIDER,
      providerCardToken: run.card_token,
      businessId: run.business_id,
      lastFour: run.card_token.slice(-4),
      nickname: `chaos mode ${runId.slice(0, 8)}`,
    },
    conn,
  );
  await conn`UPDATE chaos_run SET card_registered = true WHERE id = ${runId}::uuid`;

  const store = createPostgresInboxStore(sqlExecutorFromPostgresJs(conn));
  const woken = await store.unparkWaitingFor([{ kind: 'card', ref: run.card_token }], new Date());

  let drained = false;
  try {
    await drain();
    drained = true;
  } catch (thrown) {
    log.warn('chaos.drain_failed', {
      error: thrown instanceof Error ? thrown.message : 'unknown',
    });
  }

  await recordChaosEvent(
    {
      kind: 'card_registered',
      runId,
      actor,
      detail: `card registered; ${String(woken)} parked delivery(s) woken`,
      params: { woken, drained },
    },
    conn,
  );

  return {
    registered: true,
    woken,
    note:
      woken === 0
        ? 'card registered. Nothing was parked on it.'
        : `card registered. ${String(woken)} parked delivery(s) woken and drained — the same events, ` +
          'never re-delivered, now posted against the customer they always belonged to.',
  };
}

// ---------------------------------------------------------------------------
// Reading the outbox
// ---------------------------------------------------------------------------

export async function readOutbox(runId: string, conn: Sql = sql): Promise<ChaosDeliveryRow[]> {
  const rows = await conn<
    {
      id: string;
      run_id: string;
      seq: number;
      step: string;
      copy_index: number;
      webhook_id: string;
      planned_at: Date;
      released_at: Date | null;
      outcome: string;
      inbox_id: string | null;
      detail: string | null;
    }[]
  >`
    SELECT id, run_id, seq, step, copy_index, webhook_id, planned_at,
           released_at, outcome, inbox_id, detail
      FROM chaos_delivery
     WHERE run_id = ${runId}::uuid
     ORDER BY seq, copy_index`;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    step: r.step as ChaosStep,
    copyIndex: r.copy_index,
    webhookId: r.webhook_id,
    plannedAt: r.planned_at.toISOString(),
    releasedAt: r.released_at === null ? null : r.released_at.toISOString(),
    outcome: r.outcome as ChaosDeliveryOutcome,
    inboxId: r.inbox_id,
    detail: r.detail,
  }));
}

/** Exported for the tests: the plan a set of controls would produce. */
export { planDeliveries, type PlannedDelivery };
