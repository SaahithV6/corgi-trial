/**
 * Item state, end to end, against the REAL Plaid sandbox and the REAL database.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SUITE LINKS REAL PLAID ITEMS AND WRITES REAL ROWS. It is gated on   │
 * │ RUN_DB_TESTS=1 AND on both Plaid credentials, so CI — which holds        │
 * │ neither, deliberately — skips rather than fails. Run it with:            │
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm exec vitest run \        │
 * │     src/lib/rails/plaid/item-store.integration.test.ts                   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ===========================================================================
 * WHAT THIS PROVES THAT NO MOCK COULD
 * ===========================================================================
 *
 * The claim migration 0056 makes is that `/api/health` can now tell four
 * conditions apart which were previously one reading. Three of those four are
 * states of somebody else's system, and the only way to be sure the fold
 * matches reality is to PUT PLAID IN EACH STATE AND ASK IT:
 *
 *   healthy       link an Item, `/item/get` -> 200, `item.error` is null
 *   needs_reauth  `/sandbox/item/reset_login` -> 200, then `/item/get` -> 200
 *                 with `item.error.error_code = 'ITEM_LOGIN_REQUIRED'`
 *   orphaned      an item id with no stored credential — the state the three
 *                 2026-09-10 deliveries left this deployment in
 *   absent        no rows at all
 *
 * A fixture asserting `{error_code: 'ITEM_LOGIN_REQUIRED'}` would agree with
 * itself and prove nothing about whether Plaid still reports it that way or
 * whether the SQL fold in 0056 §11 reads it correctly.
 *
 * ===========================================================================
 * WHAT IS ROLLED BACK AND WHAT IS NOT
 * ===========================================================================
 *
 * Every DATABASE scenario runs inside a transaction that is thrown away, the
 * pattern `funding.integration.test.ts` established — real Postgres, real
 * triggers, real unique indexes, no rows left behind.
 *
 * THE PLAID SANDBOX IS NOT ROLLED BACK and cannot be. Each run links a couple
 * of throwaway Items on Plaid's side and one of them is deliberately broken.
 * That was already true of `probeItemLoginRequired()` and it is the honest
 * cost of testing against a real provider: nothing Plaid holds is a row on our
 * book.
 */

import { beforeAll, describe, expect, it } from 'vitest';

const RUN =
  process.env['RUN_DB_TESTS'] === '1' &&
  (process.env['PLAID_CLIENT_ID'] ?? '') !== '' &&
  (process.env['PLAID_SECRET'] ?? '') !== '';

import type * as Adapter from './adapter';
import type * as Client from './client';
import type * as Store from './item-store';
import type * as Secret from './secret';
import type * as Db from '@/lib/ledger/db';

const suite = RUN ? describe : describe.skip;

/** The seeded demo business. */
const RIDGELINE_BUSINESS = 'e274546d-6bdd-5266-b0fb-cc839a7811f9';

const ROLLBACK = 'plaid-item-store-integration-rollback';

/** See `funding.integration.test.ts` — postgres.js puts `begin` on the pool only. */
type Scoped = {
  savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

function nested(handle: unknown): Db.Sql {
  const scoped = handle as Scoped;
  if (typeof scoped.begin !== 'function') {
    scoped.begin = (first: unknown, second?: unknown) => {
      const body = (typeof first === 'function' ? first : second) as (
        inner: unknown,
      ) => Promise<unknown>;
      return scoped.savepoint((inner) => Promise.resolve(body(nested(inner))));
    };
  }
  return handle as Db.Sql;
}

suite('plaid item state, against the real provider', () => {
  let adapter: typeof Adapter;
  let store: typeof Store;
  let secret: typeof Secret;
  let sql: Db.Sql;
  let PlaidClient: typeof Client.PlaidClient;

  beforeAll(async () => {
    adapter = await import('./adapter');
    store = await import('./item-store');
    secret = await import('./secret');
    ({ sql } = await import('@/lib/ledger/db'));
    ({ PlaidClient } = await import('./client'));
  });

  async function rolledBack(body: (tx: Db.Sql) => Promise<void>): Promise<void> {
    let failure: unknown = null;
    try {
      await sql.begin(async (raw) => {
        await body(nested(raw));
        throw new Error(ROLLBACK);
      });
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) failure = thrown;
    }
    if (failure !== null) throw failure;
  }

  /**
   * Run a statement that is EXPECTED to be refused, and return the SQLSTATE.
   *
   * Inside a savepoint, because a rejected statement aborts the whole
   * transaction in Postgres and every assertion after it would then fail with
   * `25P02 current transaction is aborted` — which looks like the refusal
   * working and is actually the test no longer testing anything.
   */
  async function refusedCode(tx: Db.Sql, statement: (scope: Db.Sql) => Promise<unknown>) {
    const scoped = tx as unknown as Scoped;
    try {
      await scoped.savepoint(async (inner) => statement(nested(inner)));
    } catch (thrown) {
      return (thrown as { code?: string }).code ?? null;
    }
    return null;
  }

  async function stateOf(itemId: string, tx: Db.Sql): Promise<string | undefined> {
    const [row] = await tx<{ state: string }[]>`
      SELECT state FROM v_plaid_item_state WHERE item_id = ${itemId}`;
    return row?.state;
  }

  /* ---------------------------------------------------------------------- */
  /* 1. A HEALTHY item, stored, and readable back                            */
  /* ---------------------------------------------------------------------- */

  it('stores a freshly linked Item and folds it to `healthy`', async () => {
    // `persist` is the real path: the access token is written by
    // `linkExternalAccount` itself and never returned to this test, which is
    // the point of the design.
    //
    // The whole link happens INSIDE the rolled-back transaction here because
    // the persistence is what is being tested; the five HTTP round trips are
    // Plaid's own latency and no other writer is waiting on this book during a
    // test run.
    await rolledBack(async (tx) => {
      const link = await adapter.linkExternalAccount({
        clientUserId: RIDGELINE_BUSINESS,
        mintLinkToken: false,
        persist: { businessId: RIDGELINE_BUSINESS, conn: tx },
      });
      expect(link.item.error).toBeNull();

      // THE FOLD, computed by the VIEW rather than by TypeScript.
      expect(await stateOf(link.item.item_id, tx)).toBe('healthy');

      const rows = await store.readItemStates(tx);
      const mine = rows.find((r) => r.itemId === link.item.item_id);
      expect(mine?.state).toBe('healthy');
      expect(mine?.hasLiveToken).toBe(true);
      expect(mine?.errorObservations).toBe(0);
      expect(mine?.businessId).toBe(RIDGELINE_BUSINESS);

      // The accounts came with it — fourteen on `ins_109508`, three of them
      // fundable — so a later request can offer a funding source without
      // linking anything.
      expect(mine?.accountCount).toBe(14);
      const fundable = await store.fundableAccountsFor(link.item.item_id, tx);
      expect(fundable.length).toBe(3);
      for (const account of fundable) {
        expect(account.routingNumber).toMatch(/^\d{9}$/);
      }
      // And the full account number is not among the stored columns.
      expect(JSON.stringify(fundable)).not.toMatch(/\d{12}/);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* 2. A BROKEN item — Plaid really breaks it, and the fold really sees it   */
  /* ---------------------------------------------------------------------- */

  it('an Item Plaid reports ITEM_LOGIN_REQUIRED on folds to `needs_reauth`', async () => {
    const client = new PlaidClient();

    // Link, then break it for real. `/sandbox/item/reset_login` is Plaid's own
    // endpoint driving Plaid's own state machine; there is no un-reset.
    const publicToken = await client.createSandboxPublicToken({
      institutionId: adapter.SANDBOX_INSTITUTION_ID,
      initialProducts: ['auth'],
    });
    const exchanged = await client.exchangePublicToken(publicToken.public_token);
    const accessToken = exchanged.access_token;
    const before = await client.getItem(accessToken);
    expect(before.item.error).toBeNull();

    const reset = await client.sandboxResetLogin(accessToken);
    expect(reset.reset_login).toBe(true);

    // THE ASYMMETRY THE WHOLE ERROR DESIGN HANGS ON: the product call fails,
    // and the diagnostic call succeeds and tells us why.
    await expect(client.getAuth(accessToken)).rejects.toMatchObject({
      code: 'ITEM_LOGIN_REQUIRED',
    });
    const after = await client.getItem(accessToken);
    expect(after.item.error?.error_code).toBe('ITEM_LOGIN_REQUIRED');

    await rolledBack(async (tx) => {
      await store.recordLinkedItem(
        {
          item: before.item,
          accounts: [],
          achNumbers: new Map(),
          accessToken: secret.wrapAccessToken(accessToken),
          environment: 'sandbox',
          purpose: 'diagnostic',
        },
        tx,
      );
      // Healthy at link time...
      expect(await stateOf(before.item.item_id, tx)).toBe('healthy');

      // ...and `refreshItemState` asks PLAID, appends what it said, and the
      // view folds the new last word. This is the call the health surface was
      // missing: `/institutions/get` could never have produced this.
      const refreshed = await store.refreshItemState(before.item.item_id, {
        client,
        conn: tx,
      });
      expect(refreshed.asked).toBe(true);
      expect(refreshed.errorCode).toBe('ITEM_LOGIN_REQUIRED');
      expect(refreshed.state).toBe('needs_reauth');

      expect(await stateOf(before.item.item_id, tx)).toBe('needs_reauth');

      // The history survives, which is the reason the log is append-only: an
      // operator can answer "how long has this been broken".
      const rows = await store.readItemStates(tx);
      const mine = rows.find((r) => r.itemId === before.item.item_id);
      expect(mine?.observations).toBe(2);
      expect(mine?.errorObservations).toBe(1);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* 3. THE STATE THIS DEPLOYMENT WAS ACTUALLY IN                            */
  /* ---------------------------------------------------------------------- */

  it('an item id we hold no credential for folds to `orphaned`, not to a broken funding source', async () => {
    await rolledBack(async (tx) => {
      // Exactly the shape of the three 2026-09-10 deliveries: Plaid named an
      // item, we recorded what it said, and we hold nothing to act with.
      const itemId = `orphan-${crypto.randomUUID()}`;
      await store.recordItemObservation(
        {
          itemId,
          source: 'webhook',
          webhookCode: 'ERROR',
          errorCode: 'ITEM_LOGIN_REQUIRED',
          errorType: 'ITEM_ERROR',
          errorMessage: 'the login details of this item have changed',
        },
        tx,
      );

      expect(await stateOf(itemId, tx)).toBe('orphaned');

      // The distinction that matters: this is NOT `needs_reauth`. There is no
      // human action that fixes it — Link update mode needs a link_token minted
      // FROM the access token, and we never stored one.
      expect(await stateOf(itemId, tx)).not.toBe('needs_reauth');
    });
  });

  it('records an observation for an item with no plaid_item row at all — no foreign key', async () => {
    // 0056 §4: `plaid_item_event.item_id` is deliberately NOT a foreign key,
    // because a foreign key would make the only honest record of an orphan
    // unwritable. If somebody adds one, this fails.
    await rolledBack(async (tx) => {
      const written = await store.recordItemObservation(
        { itemId: `no-such-item-${crypto.randomUUID()}`, source: 'webhook', webhookCode: 'ERROR' },
        tx,
      );
      expect(written).toBe(true);
    });
  });

  /* ---------------------------------------------------------------------- */
  /* 4. The guarantees the database makes, not the caller                    */
  /* ---------------------------------------------------------------------- */

  it('the observation log is append-only: TWO layers refuse an UPDATE, and the grant is the outer one', async () => {
    // 0056 §12 issues no UPDATE grant on `plaid_item_event` AND arms a trigger.
    // Measured here rather than assumed: as `corgi_app` the PRIVILEGE refuses
    // first, `42501`, and the trigger never gets the chance to fire.
    //
    // That ordering is worth pinning. A future migration that granted UPDATE
    // "just for a backfill" would move this from 42501 to 55006 and this test
    // would say so — which is the difference between two layers and one layer
    // that happens to be in front of a second nobody has checked. The TRIGGER
    // layer is proven independently, as the table owner, by the closing
    // self-test block inside 0056 itself: it performs this exact UPDATE and
    // refuses to commit the migration unless `55006` is raised.
    await rolledBack(async (tx) => {
      const itemId = `append-${crypto.randomUUID()}`;
      await store.recordItemObservation({ itemId, source: 'webhook', errorCode: 'X' }, tx);

      expect(
        await refusedCode(
          tx,
          (s) => s`UPDATE plaid_item_event SET error_code = 'TAMPERED' WHERE item_id = ${itemId}`,
        ),
      ).toBe('42501');

      // DELETE is refused the same way, so history cannot be dropped either.
      expect(
        await refusedCode(tx, (s) => s`DELETE FROM plaid_item_event WHERE item_id = ${itemId}`),
      ).toBe('42501');

      // And the row is still exactly as it was written.
      const [row] = await tx<{ error_code: string }[]>`
        SELECT error_code FROM plaid_item_event WHERE item_id = ${itemId}`;
      expect(row?.error_code).toBe('X');
    });
  });

  it('the access token column cannot be rewritten in place, only retired', async () => {
    await rolledBack(async (tx) => {
      const itemId = `rotate-${crypto.randomUUID()}`;
      await store.recordLinkedItem(
        {
          item: {
            item_id: itemId,
            institution_id: 'ins_109508',
            institution_name: null,
            webhook: null,
            available_products: [],
            billed_products: [],
            consent_expiration_time: null,
            update_type: 'background',
            error: null,
          },
          accounts: [],
          achNumbers: new Map(),
          accessToken: secret.wrapAccessToken(`access-sandbox-${crypto.randomUUID()}`),
          environment: 'sandbox',
        },
        tx,
      );

      // The column-level grant is `UPDATE (retired_at)` and nothing else, so a
      // caller that tries to swap the credential out is refused by the
      // privilege system rather than by a code review.
      expect(
        await refusedCode(
          tx,
          (s) =>
            s`UPDATE plaid_item_secret SET access_token = 'access-sandbox-stolen' WHERE item_id = ${itemId}`,
        ),
      ).toBe('42501');

      // Retirement is the one permitted mutation.
      await tx`UPDATE plaid_item_secret SET retired_at = now() WHERE item_id = ${itemId}`;
      // ...and with no live credential the item is `orphaned`, not `healthy`.
      expect(await stateOf(itemId, tx)).toBe('orphaned');
    });
  });

  it('a redelivered webhook writes nothing twice — the unique index decides', async () => {
    await rolledBack(async (tx) => {
      // A real inbox row, because `inbox_id` is a real foreign key and citing a
      // delivery that does not exist is not provenance.
      const [delivery] = await tx<{ id: string }[]>`
        INSERT INTO webhook_inbox (provider, provider_event_id, event_type, payload,
                                   raw_body, headers, signature_verified_at)
        VALUES ('plaid', ${`idem-${crypto.randomUUID()}`}, 'ITEM.ERROR', '{}'::jsonb,
                '{}', '{}'::jsonb, now())
        RETURNING id`;
      expect(delivery).toBeDefined();
      if (delivery === undefined) return;

      const itemId = `idem-${crypto.randomUUID()}`;
      const first = await store.recordItemObservation(
        { itemId, source: 'webhook', errorCode: 'ITEM_LOGIN_REQUIRED', inboxId: delivery.id },
        tx,
      );
      const second = await store.recordItemObservation(
        { itemId, source: 'webhook', errorCode: 'ITEM_LOGIN_REQUIRED', inboxId: delivery.id },
        tx,
      );

      expect(first).toBe(true);
      expect(second).toBe(false);

      const [count] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM plaid_item_event WHERE item_id = ${itemId}`;
      expect(Number(count?.n)).toBe(1);
    });
  });

  it('re-linking retires the old token rather than editing it', async () => {
    await rolledBack(async (tx) => {
      const itemId = `relink-${crypto.randomUUID()}`;
      const item = {
        item_id: itemId,
        institution_id: 'ins_109508',
        institution_name: 'First Platypus Bank',
        webhook: null,
        available_products: [],
        billed_products: [],
        consent_expiration_time: null,
        update_type: 'background',
        error: null,
      };
      const args = {
        item,
        accounts: [],
        achNumbers: new Map(),
        environment: 'sandbox' as const,
      };

      const first = await store.recordLinkedItem(
        { ...args, accessToken: secret.wrapAccessToken(`access-sandbox-${crypto.randomUUID()}`) },
        tx,
      );
      const second = await store.recordLinkedItem(
        { ...args, accessToken: secret.wrapAccessToken(`access-sandbox-${crypto.randomUUID()}`) },
        tx,
      );

      expect(first.created).toBe(true);
      expect(first.tokenVersion).toBe(1);
      // The identity row is not duplicated and not rewritten.
      expect(second.created).toBe(false);
      expect(second.tokenVersion).toBe(2);

      // Exactly one live token, and the old one is still readable so that
      // "which credential was live when this deposit was booked" stays
      // answerable.
      const rows = await tx<{ version: number; retired: boolean }[]>`
        SELECT version, (retired_at IS NOT NULL) AS retired
          FROM plaid_item_secret WHERE item_id = ${itemId} ORDER BY version`;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ version: 1, retired: true });
      expect(rows[1]).toMatchObject({ version: 2, retired: false });

      // And the state view still names exactly one item.
      expect(await stateOf(itemId, tx)).toBe('healthy');
    });
  });

  it('the stored token never renders itself, and a mangled row fails closed', async () => {
    await rolledBack(async (tx) => {
      const itemId = `secret-${crypto.randomUUID()}`;
      const material = `access-sandbox-${crypto.randomUUID()}`;
      await store.recordLinkedItem(
        {
          item: {
            item_id: itemId,
            institution_id: 'ins_109508',
            institution_name: null,
            webhook: null,
            available_products: [],
            billed_products: [],
            consent_expiration_time: null,
            update_type: 'background',
            error: null,
          },
          accounts: [],
          achNumbers: new Map(),
          accessToken: secret.wrapAccessToken(material),
          environment: 'sandbox',
        },
        tx,
      );

      const token = await store.liveAccessTokenFor(itemId, tx);
      expect(token).not.toBeNull();
      if (token === null) return;

      // The material round-tripped intact...
      expect(secret.revealAccessToken(token)).toBe(material);
      // ...and cannot be printed by accident. This is the whole reason the
      // wrapper exists: a logger JSON-encodes its context bag.
      expect(JSON.stringify(token)).toBe('"[redacted]"');
      expect(JSON.stringify({ token })).not.toContain(material);
      expect(`${token}`).not.toContain(material);
      expect(String(token)).toBe('access-sandbox-***');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* 5. THE LIMIT THAT DISAPPEARS                                            */
  /* ---------------------------------------------------------------------- */

  it('a stored Item survives the request, so two funding runs share one external_ref', async () => {
    // THE POINT OF THE MIGRATION, stated as money.
    //
    // `adapter.ts` recorded the hazard: the item id is part of the idempotency
    // key, and `/funding` linked a FRESH item on every run, so two runs
    // produced two different external refs and the unique indexes "make a
    // funding run replay-safe WITHIN one linked Item, and cannot see across
    // two". `alreadyFundedReference()` was a guard and explicitly not a
    // guarantee.
    //
    // With the Item stored, the SECOND run does not link at all — it reads the
    // funding source back — so both runs derive the SAME external ref and the
    // unique index, not a SELECT, decides.
    await rolledBack(async (tx) => {
      const link = await adapter.linkExternalAccount({
        clientUserId: RIDGELINE_BUSINESS,
        mintLinkToken: false,
        persist: { businessId: RIDGELINE_BUSINESS, conn: tx },
      });
      const checking = link.fundable.find((a) => a.subtype === 'checking');
      expect(checking).toBeDefined();
      if (checking === undefined) return;

      // Run two reads the funding source out of storage instead of linking.
      const stored = await store.fundableAccountsFor(link.item.item_id, tx);
      expect(stored.length).toBeGreaterThan(0);

      const reference = `ITEM-STORE-${crypto.randomUUID().slice(0, 8)}`;
      const [today] = await tx<{ value_date: string }[]>`
        SELECT to_char(book_date(now()), 'YYYY-MM-DD') AS value_date`;
      const valueDate = today?.value_date ?? '';

      const firstRun = await adapter.fundFromLinkedAccount({
        businessId: RIDGELINE_BUSINESS,
        amountCents: 125_000n,
        linked: checking,
        counterpartyClass: 'self',
        valueDate: valueDate as Adapter.FundingRequest['valueDate'],
        reference,
        conn: tx,
      });

      const secondRun = await adapter.fundFromLinkedAccount({
        businessId: RIDGELINE_BUSINESS,
        amountCents: 125_000n,
        linked: checking,
        counterpartyClass: 'self',
        valueDate: valueDate as Adapter.FundingRequest['valueDate'],
        reference,
        conn: tx,
      });

      // One deposit, not two. Postgres decided.
      expect(firstRun.created).toBe(true);
      expect(secondRun.created).toBe(false);
      expect(secondRun.externalRef).toBe(firstRun.externalRef);
      expect(secondRun.holdId).toBe(firstRun.holdId);
      expect(secondRun.entryId).toBe(firstRun.entryId);

      // And the ref cites the item that is now durable, so the linkage is
      // resolvable from the money row for as long as the row exists.
      expect(firstRun.externalRef).toContain(link.item.item_id);
      const [stillThere] = await tx<{ item_id: string }[]>`
        SELECT item_id FROM plaid_item WHERE item_id = ${link.item.item_id}`;
      expect(stillThere?.item_id).toBe(link.item.item_id);
    });
  });
});
