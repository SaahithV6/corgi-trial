/**
 * An outbound wire, through the SAME `requestPayment()` path as ACH.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ THIS SUITE MOVES MONEY, AND THEN ROLLS IT BACK. It raises a real payment │
 * │ instruction, approves it twice, releases it — which posts a real journal │
 * │ entry out of the customer's deposit account — and then puts it on        │
 * │ Increase's sandbox Fedwire. Gated on RUN_DB_TESTS=1 AND INCREASE_API_KEY.│
 * │                                                                          │
 * │   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run \             │
 * │     src/lib/rails/wire/outbound.integration.test.ts                      │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * THE CLAIM UNDER TEST IS A NEGATIVE ONE: that adding a wire rail required NO
 * new money-out path, and that maker-checker, the KYB gate, the content hash
 * and the ledger posting all apply to a wire because they were never about
 * ACH in the first place. A negative claim is proven by running the existing
 * code and watching it behave — so every call below except the last is a
 * function that existed before this rail did.
 *
 * The one new call is `originateApprovedWire()`, and it happens AFTER the
 * ledger entry and the `released` event have both committed. That order is the
 * argument: an unapproved wire cannot reach Fedwire because it cannot be
 * released, and a wire that left with no ledger entry is impossible because
 * the entry came first.
 *
 * ===========================================================================
 * THE WHOLE SUITE IS ONE TRANSACTION, AND IT IS ROLLED BACK
 * ===========================================================================
 *
 * Per run this file used to leave, on the LIVE book: one payee, one
 * `payee_verification`, one `payment_instruction`, four
 * `payment_instruction_event` rows and one journal entry of two lines against
 * 1110 CASH and the customer's 2100. Twelve runs' worth of that is still on
 * the book and stays there — append-only is the point — but this run adds
 * none. Per-run cost: 1 payee / 1 instruction / 4 events / 1 entry / 2 lines
 * before, ZERO after.
 *
 * WHY THE WHOLE SUITE AND NOT ONE TRANSACTION PER TEST, as
 * `src/lib/fx/fx.integration.test.ts` and `src/lib/ledger/ledger.integration.test.ts`
 * do: because this file is not six independent scenarios. It is ONE
 * maker-checker flow told in six steps, and each step reads back the
 * instruction the previous step left — by idempotency key, out of the
 * database. Roll back between them and step four has nothing to approve. The
 * six `it` blocks are how the flow is narrated, and turning them into one
 * enormous test to make the rollback fit would lose that, so the transaction
 * is opened in `beforeAll` and thrown away in `afterAll` instead.
 *
 * The cost of that choice, stated plainly: `ledger_append` takes
 * `pg_advisory_xact_lock` per entity and holds it to end of transaction, so
 * from the moment `releasePayment()` posts until `afterAll` rolls back, other
 * writers to this entity's ledger wait. That window is the last test only —
 * the two `originateApprovedWire` calls — and it is seconds, not minutes.
 * Nothing before the release takes that lock.
 *
 * The rule and the exemptions are written up in `docs/TESTING.md`.
 *
 * The Increase sandbox wire is NOT rolled back and cannot be: it is somebody
 * else's system. That is what a live integration means, it was already true
 * before this change, and it is exactly why the ledger entry authorising it
 * has to be real at the moment it is sent — which, inside the transaction, it
 * is.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const KEY = process.env['INCREASE_API_KEY'] ?? '';
const RUN = process.env['RUN_DB_TESTS'] === '1' && KEY !== '';

import type * as Approvals from '@/lib/approvals';
import type * as Db from '@/lib/ledger/db';
import type * as Payees from '@/lib/payees';
import type * as Outbound from './outbound';

const suite = RUN ? describe : describe.skip;

/** `JSON.stringify` throws on a bigint, and every amount here is one. */
const show = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));

const RIDGELINE_BUSINESS = 'e274546d-6bdd-5266-b0fb-cc839a7811f9';
const INCREASE_ACCOUNT = 'sandbox_account_zkfx1wcn4brwoaiyksj6';

/** Seeded actors. Their roles are the point, so they are named. */
const PRIYA = 'b3c4f786-5d1b-5194-9aae-6342ba0ef606'; // maker, can_approve = false
const DANA = '76f9266f-23c9-52de-b8ff-0ec0b23ef386'; // checker #1
const MILES = '9fff2b99-0a56-56cd-8fdf-699d64d085ac'; // checker #2

/** JPMorgan Chase's WIRE routing number. The Plaid item's ACH one is 011401533. */
const WIRE_ROUTING = '021000021';
const BENEFICIARY = 'Northwind Industrial LLC';
const LAST4 = '0000';
const FULL_ACCOUNT_NUMBER = '1111222233330000';

/** What postgres.js hands a transaction body. Structural, to avoid the import. */
type Scoped = {
  savepoint: <T>(fn: (scoped: unknown) => Promise<T>) => Promise<T>;
  begin?: unknown;
};

/**
 * Give a transaction handle the `.begin()` that the production code calls.
 *
 * `requestPayment`, `releasePayment` and `confirmPayee` each wrap their writes
 * in `conn.begin(...)`, which is right — an instruction and its event, a payee
 * and its verification, must land together or not at all. But postgres.js puts
 * `begin` on the POOL only; a transaction scope gets `savepoint`, and the two
 * are the same function internally (`scope(c, fn, name)`) differing only in
 * whether a savepoint name is issued. Without this shim those calls throw
 * `conn.begin is not a function` and the only way to run this flow inside a
 * transaction would be to stop calling the production functions — which would
 * mean this file no longer tests the money-out path it exists to test.
 *
 * `Sql(handler)` builds a fresh object per scope, so this adds the property to
 * this transaction's handle and to nothing else.
 */
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

const ROLLBACK = 'wire-outbound-integration-rollback';
const SAVEPOINT_ROLLBACK = 'wire-outbound-savepoint-rollback';

suite('an outbound wire, through requestPayment()', () => {
  let requestPayment: typeof Approvals.requestPayment;
  let approvePayment: typeof Approvals.approvePayment;
  let releasePayment: typeof Approvals.releasePayment;
  let getPayment: typeof Approvals.getPayment;
  let confirmPayee: typeof Payees.confirmPayee;
  let originateApprovedWire: typeof Outbound.originateApprovedWire;
  let resolveWireBeneficiary: typeof Outbound.resolveWireBeneficiary;

  /**
   * The handle every test below uses. It is NOT the pool — it is a transaction
   * opened in `beforeAll` and rolled back in `afterAll`, so every row this
   * suite writes exists for the length of the run and then never existed.
   */
  let tx: Db.Sql;
  /** Resolves the `beforeAll` transaction body so `afterAll` can end it. */
  let release: () => void;
  /** Settles when the rollback has actually happened. `afterAll` awaits it. */
  let rolledBack: Promise<void>;

  let valueDate: string;
  const run = `wire-${Date.now()}`;

  beforeAll(async () => {
    ({ requestPayment, approvePayment, releasePayment, getPayment } = await import(
      '@/lib/approvals'
    ));
    ({ confirmPayee } = await import('@/lib/payees'));
    ({ originateApprovedWire, resolveWireBeneficiary } = await import('./outbound'));
    const { sql } = await import('@/lib/ledger/db');

    // Open the transaction and hand its handle out, then park the body on a
    // promise nobody resolves until `afterAll`. postgres.js scopes a
    // transaction to a callback, so keeping one open across tests means
    // keeping that callback alive.
    let ready: () => void = () => {};
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let finish: () => void = () => {};
    const isFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });

    rolledBack = sql
      .begin(async (raw) => {
        tx = nested(raw);
        ready();
        await isFinished;
        // The only way out of a postgres.js transaction body without a COMMIT.
        throw new Error(ROLLBACK);
      })
      .then(
        () => undefined,
        (thrown: unknown) => {
          // Anything that is not the sentinel is a real failure — rethrow it so
          // the run goes red rather than reporting a clean rollback over a
          // broken one. It rolled back either way.
          if (!(thrown instanceof Error) || thrown.message !== ROLLBACK) throw thrown;
        },
      );

    await isReady;
    release = finish;

    const [row] = await tx<{ value_date: string }[]>`
      SELECT to_char(book_date(now()), 'YYYY-MM-DD') AS value_date`;
    valueDate = row?.value_date ?? '';
  });

  afterAll(async () => {
    release?.();
    await rolledBack;
  });

  /**
   * Run one call on a SAVEPOINT and then roll that savepoint back, keeping its
   * return value.
   *
   * This exists for exactly one call site and the reason is worth the fifteen
   * lines. `approvePayment()` makes its INSERT directly on the connection it is
   * handed and converts a refusal into `{ ok: false }` — which is the right
   * shape for a console but means the exception never escapes. Outside a
   * transaction that is harmless. INSIDE one it is not: the trigger's error has
   * already put the transaction into the aborted state, and Postgres will
   * refuse every statement after it with "current transaction is aborted"
   * until somebody rolls back. Two tests would then fail for a reason that has
   * nothing to do with wires.
   *
   * A savepoint gives the refusal somewhere to land. The body must THROW to get
   * out — postgres.js issues `ROLLBACK TO SAVEPOINT` on a rejected body and
   * `RELEASE` on a resolved one, and RELEASE on an aborted subtransaction fails
   * exactly the same way — so the sentinel is thrown after the value is
   * captured.
   *
   * The refusal itself is entirely real: the trigger fires, against the live
   * database, on a row that genuinely was inserted first. Nothing is relaxed.
   */
  async function onSavepoint<T>(body: (scoped: Db.Sql) => Promise<T>): Promise<T> {
    const captured: T[] = [];
    try {
      await (tx as unknown as Scoped).savepoint(async (raw) => {
        captured.push(await body(nested(raw)));
        throw new Error(SAVEPOINT_ROLLBACK);
      });
    } catch (thrown) {
      if (!(thrown instanceof Error) || thrown.message !== SAVEPOINT_ROLLBACK) throw thrown;
    }
    const [value] = captured;
    if (captured.length === 0) throw new Error('the savepoint body returned nothing');
    return value as T;
  }

  const destination = {
    type: 'wire' as const,
    holderName: BENEFICIARY,
    // A SWIFT BIC, because that is the only bank identifier
    // `destinationSchema`'s wire variant has room for. A domestic Fedwire
    // beneficiary is addressed by a 9-digit WIRE ABA, which this shape cannot
    // carry — see the header of ./outbound.ts and docs/WIRES.md §6.
    bic: 'CHASUS33',
    accountNumberLast4: LAST4,
  };

  /* ---- the payee book is the wire's address book ----------------------- */

  it('puts the beneficiary on the payee book, with its WIRE routing number', async () => {
    const result = await confirmPayee(
      {
        candidate: {
          businessId: RIDGELINE_BUSINESS,
          displayName: `Northwind (wire) ${run}`,
          holderName: BENEFICIARY,
          rail: 'wire',
          routingNumber: WIRE_ROUTING,
          accountNumberLast4: LAST4,
        },
        payeeKey: `wire:${WIRE_ROUTING}:${LAST4}:${run}`,
        actorId: PRIYA,
      },
      tx,
    );

    expect(result.refusal).toBeNull();
    expect(result.saved).not.toBeNull();
    // The ABA arithmetic ran, against the WIRE variant.
    expect(result.check.checksumOk).toBe(true);
    expect(result.check.routingNumber).toBe(WIRE_ROUTING);

    // And the rail can find it, with the number the instruction cannot carry.
    const resolved = await resolveWireBeneficiary(
      { businessId: RIDGELINE_BUSINESS, destination },
      tx,
    );
    expect(resolved.wireRoutingNumber).toBe(WIRE_ROUTING);
    expect(resolved.holderName).toBe(BENEFICIARY);
  }, 30_000);

  it('refuses a beneficiary nobody has confirmed — on this rail only', async () => {
    // `gatePaymentOnPayee()` deliberately allows an unknown ACH destination:
    // requiring pre-registration breaks the one-off refund and the emergency
    // supplier payment, and on ACH a delay is recoverable because the entry
    // is. On a wire it is not, and "urgent payment to a beneficiary nobody
    // has seen before" is a verbatim description of business email
    // compromise, so this rail refuses instead.
    //
    // The refusal is a read that finds nothing, so it cannot poison the
    // surrounding transaction the way a refused write would.
    await expect(
      resolveWireBeneficiary(
        {
          businessId: RIDGELINE_BUSINESS,
          destination: { ...destination, holderName: `Nobody Who Exists ${run}` },
        },
        tx,
      ),
    ).rejects.toThrow(/WIRE_PAYEE_NOT_ON_BOOK|not on the book|payee book/i);
  }, 30_000);

  /* ---- maker-checker, unchanged, on a rail it never heard of ----------- */

  it('raises a wire citing the WIRE policy — $0 threshold, two approvers', async () => {
    const raised = await requestPayment(
      {
        accountId: await depositAccountId(tx),
        rail: 'wire',
        amountCents: 4_200n,
        currency: 'USD',
        destination,
        valueDate,
        requestedByActorId: PRIYA,
        idempotencyKey: `itest:${run}`,
      },
      tx,
    );

    expect(raised.ok, show(raised)).toBe(true);
    if (!raised.ok) return;

    // $42.00 — far below ACH's $2,500 — and it still needs TWO humans,
    // because the wire threshold is $0 and the reason is recoverability
    // rather than size. Nothing in `requestPayment()` knows that; it read the
    // `approval_policy` row in force for this rail on this value date.
    expect(raised.value.policy.rail).toBe('wire');
    expect(raised.value.policy.thresholdCents).toBe(0n);
    expect(raised.value.approvalsRequired).toBe(2);
    expect(raised.value.created).toBe(true);

    // NO MONEY HAS MOVED. An unapproved instruction has no ledger footprint at
    // all, not even a hold.
    const queued = await getPayment(raised.value.instructionId, tx);
    expect(queued.ok && queued.value.state).toBe('requested');
  }, 30_000);

  it('refuses the initiator approving her own wire — at the DATABASE', async () => {
    const found = await instruction(tx, `itest:${run}`);
    // On a savepoint — see `onSavepoint` above. The trigger fires for real;
    // what the savepoint buys is that the aborted subtransaction it leaves
    // behind does not take the next two tests with it.
    const decision = await onSavepoint((scoped) =>
      approvePayment(
        { instructionId: found.id, actorId: PRIYA, contentHash: found.contentHash },
        scoped,
      ),
    );
    expect(decision.ok).toBe(false);
  }, 30_000);

  it('will not release on one approval when the policy asks for two', async () => {
    const found = await instruction(tx, `itest:${run}`);
    const first = await approvePayment(
      { instructionId: found.id, actorId: DANA, contentHash: found.contentHash },
      tx,
    );
    expect(first.ok, show(first)).toBe(true);

    const early = await releasePayment({ instructionId: found.id, actorId: DANA }, tx);
    expect(early.ok).toBe(false);

    // The STATE is `approved` after one decision — the fold names the last
    // event, and one person did approve. What stops the money is not the state
    // but the COUNT against the policy the instruction cites: 1 held, 2
    // required. Those are different questions and the release gate asks the
    // second one, which is why a two-approver rule cannot be satisfied by a
    // screen that only looks at a status.
    const queued = await getPayment(found.id, tx);
    expect(queued.ok && queued.value.state).toBe('approved');
    expect(queued.ok && queued.value.approvalsHeld).toBe(1);
    expect(queued.ok && queued.value.approvalsRequired).toBe(2);

    // And nothing is on the ledger: no entry cites this instruction.
    const posted = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM payment_instruction_event
       WHERE instruction_id = ${found.id}::uuid AND entry_id IS NOT NULL`;
    expect(posted[0]?.n).toBe(0);
  }, 30_000);

  /* ---- released, then and only then put on a wire ---------------------- */

  it('releases on the second approval, posts to 1110, and reaches Fedwire', async () => {
    const found = await instruction(tx, `itest:${run}`);
    const second = await approvePayment(
      { instructionId: found.id, actorId: MILES, contentHash: found.contentHash },
      tx,
    );
    expect(second.ok, show(second)).toBe(true);

    const released = await releasePayment({ instructionId: found.id, actorId: MILES }, tx);
    expect(released.ok, show(released)).toBe(true);
    if (!released.ok) return;

    // Through the ledger's own named reader, not SQL of this test's —
    // `src/lib/ledger/boundary.test.ts` failed the first draft of this line
    // by name, and was right to: a rail test that knows the shape of
    // `journal_line` is a rail test that will disagree with the ledger about
    // it one day.
    const { listLedgerLines } = await import('@/lib/ledger/queries');
    // NO `businessId` filter: that predicate scopes to the customer's own
    // accounts and 1110 is a HOUSE leaf (`business_id IS NULL`), so filtering
    // by business would hide exactly the leg under test.
    //
    // Read on `tx`, because the entry under test is uncommitted and the pool
    // cannot see it. That is not a weakening: the reader, the view and the
    // arithmetic are the same ones the application runs.
    const lines = await listLedgerLines(
      { rail: 'wire', book: 'financial', limit: 200 },
      tx,
    );
    const legs = lines
      .filter((l) => l.entryId === released.value.entryId)
      .sort((a, b) => a.accountCode.localeCompare(b.accountCode));
    // The customer's balance falls by the full amount and the house leg is
    // 1110 — CASH, not an in-transit liability. `releasePayment()` already
    // knew that before this rail existed: "the cash is gone the moment a wire
    // leaves; there is no in-transit window worth modelling on an irrevocable
    // rail".
    //
    // Asserted on the ENTRY's own lines rather than on the account balance,
    // because `wire.integration.test.ts` credits this same business while this
    // file runs. A balance delta would be asserting that nothing else in the
    // system is running; two lines of one entry are this payment and nothing
    // else.
    //
    // `listLedgerLines` returns `amount_cents * normal_side` — the SIGNED
    // EFFECT ON THE ACCOUNT, not the raw column. So both legs are NEGATIVE and
    // that is the whole sentence: house cash falls by $42.00 and the money we
    // owe the customer falls by $42.00. The raw column has opposite signs
    // (1110 is debit-normal at -4200, 2100 is credit-normal at +4200), and
    // getting that inversion backwards is what makes an outbound payment
    // increase the customer's balance.
    expect(legs.map((l) => l.accountCode)).toEqual(['1110', '2100']);
    expect(legs.map((l) => l.amountCents)).toEqual([-4_200n, -4_200n]);

    // NOW it goes on the network, and not one instant earlier. `conn: tx` is
    // load-bearing: the guard inside `originateApprovedWire` refuses anything
    // that is not `released`, and the release it must see is the one three
    // lines up, which only this transaction can read. A pool connection here
    // would read `requested` and refuse — which is the guard working, and is
    // why passing the handle is the honest fix rather than relaxing it.
    const sent = await originateApprovedWire({
      instructionId: found.id,
      beneficiaryAccountNumber: FULL_ACCOUNT_NUMBER,
      sourceAccountId: INCREASE_ACCOUNT,
      conn: tx,
    });

    expect(sent.origination.ref).toMatch(/^sandbox_wire_transfer_/);
    expect(sent.origination.amount).toEqual({ amount: 4_200n, currency: 'USD' });
    expect(sent.origination.provider).toBe('increase.wire');
    // Addressed from the CONFIRMED BOOK, not from the instruction. The wire
    // ABA never entered `payment_instruction.counterparty` and never reached
    // an approver's screen.
    expect(sent.beneficiary.wireRoutingNumber).toBe(WIRE_ROUTING);
    // The idempotency key is the instruction, so pressing send twice cannot
    // send two wires — Increase returns the original.
    expect(sent.instruction.clientReferenceId).toBe(`payment:${found.id}`);

    const again = await originateApprovedWire({
      instructionId: found.id,
      beneficiaryAccountNumber: FULL_ACCOUNT_NUMBER,
      sourceAccountId: INCREASE_ACCOUNT,
      conn: tx,
    });
    expect(again.origination.ref).toBe(sent.origination.ref);
  }, 90_000);

  /* ---- helpers --------------------------------------------------------- */

  async function depositAccountId(conn: Db.Sql): Promise<string> {
    const { mainDepositAccountId } = await import('@/lib/ledger/queries');
    const id = await mainDepositAccountId(RIDGELINE_BUSINESS, conn);
    if (id === null) throw new Error('the seeded business has no deposit account');
    return id;
  }

  async function instruction(
    conn: Db.Sql,
    idempotencyKey: string,
  ): Promise<{ id: string; contentHash: string }> {
    const [row] = await conn<{ id: string; content_hash: string }[]>`
      SELECT id, encode(content_hash, 'hex') AS content_hash
        FROM payment_instruction WHERE idempotency_key = ${idempotencyKey}`;
    if (row === undefined) throw new Error(`no instruction for ${idempotencyKey}`);
    return { id: row.id, contentHash: row.content_hash };
  }
});
