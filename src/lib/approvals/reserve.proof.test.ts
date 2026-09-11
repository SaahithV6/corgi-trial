/**
 * THE PROOF, in one transaction that is always rolled back.
 *
 * Migration 0061 is applied INSIDE the transaction (Postgres DDL is
 * transactional), the two arms run against it, and the whole thing rolls back:
 * not one row of this file survives, on a live book.
 *
 * BEFORE arm  — the approval path AS IT WAS: a bare INSERT of the `approved`
 *               event, which is verbatim what `decide.ts` did before this
 *               change. Nothing is withheld; two payments totalling more than
 *               the balance both clear; the second release drives the account
 *               negative.
 * AFTER arm   — the approval path AS IT IS: `approvePayment()`. The first
 *               approval withholds the money, and the second payment — the
 *               drain — is refused at the moment it is approved.
 *
 * Gated on RUN_PROOF=1 so it never runs in CI or in `pnpm test`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type * as ApprovalsModule from "./index";
import type { sql as SqlHandle } from "@/lib/ledger/db";

const RUN = process.env.RUN_PROOF === "1";
const d = RUN ? describe : describe.skip;

const usd = (c: bigint) => `${c < 0n ? "-" : ""}$${(c < 0n ? -c : c) / 100n}.${((c < 0n ? -c : c) % 100n).toString().padStart(2, "0")}`;

d("0061 — an approved payment reserves the money it will release", () => {
  it("before and after, on the live book, rolled back", async () => {
    // THE OWNER CONNECTION, because the migration is applied inside this
    // transaction and `corgi_app` deliberately holds no DDL rights. The
    // privilege model is therefore NOT what this run exercises; the money
    // behaviour is. Every app function below takes this connection explicitly,
    // so the code under test is the code that ships.
    const { default: postgres } = await import("postgres");
    const sql = postgres(process.env.DATABASE_URL!, {
      max: 1,
      // The same bigint parser `src/lib/ledger/db.ts` configures. Without it
      // money comes back as strings and the code under test would be running
      // on a different numeric contract than it does in production.
      types: {
        bigint: {
          to: 20,
          from: [20],
          serialize: (v: bigint | number) => v.toString(),
          parse: (v: string) => BigInt(v),
        },
      },
      onnotice: () => {},
    });
    const A: typeof ApprovalsModule = await import("./index");
    const log: string[] = [];
    const say = (line: string) => {
      log.push(line);
      // eslint-disable-next-line no-console
      console.log(line);
    };

    type Tx = typeof SqlHandle;

    await sql
      .begin(async (outer) => {
        // Inside a transaction, postgres.js exposes `savepoint()` and not
        // `begin()`. The code under test opens its own transaction, which in
        // production is a real BEGIN and here must be a savepoint, so that the
        // whole proof can still be rolled back. This is the harness adapting to
        // the driver, not the code under test being altered.
        const raw = outer as unknown as {
          begin?: unknown;
          savepoint?: (cb: unknown) => unknown;
        };
        if (typeof raw.begin !== "function" && typeof raw.savepoint === "function") {
          raw.begin = raw.savepoint.bind(outer);
        }
        const tx = outer as unknown as Tx;

        // ---- the subject ------------------------------------------------
        const [acct] = await tx<
          { id: string; entity_id: string; business_id: string; legal_name: string }[]
        >`
          SELECT a.id, a.entity_id, a.business_id, b.legal_name
            FROM account a JOIN business b ON b.id = a.business_id
           WHERE a.code = '2100' AND b.legal_name = 'Pots Integration Fixture Co.'`;
        if (!acct) throw new Error("fixture account missing");

        const humans = await tx<{ id: string; display_name: string; can_approve: boolean }[]>`
          SELECT id, display_name, can_approve FROM actor
           WHERE kind = 'human' AND business_id IS NULL ORDER BY display_name`;
        const approvers = humans.filter((h) => h.can_approve);
        const maker = humans.find((h) => !h.can_approve);
        if (!maker || approvers.length < 2) throw new Error("seed first");
        const [checker1, checker2] = approvers;

        const [policy] = await tx<{ id: string }[]>`
          SELECT id FROM approval_policy
           WHERE rail = 'ach' AND threshold_cents <= 2000000
           ORDER BY required_approvals DESC, effective_from DESC LIMIT 1`;
        if (!policy) throw new Error("no approval policy");

        const availability = async () => {
          const [row] = await tx<{ available: string; holds: string; ledger: string }[]>`
            SELECT available_cents AS available, hold_cents AS holds, ledger_cents AS ledger
              FROM ledger_availability(${acct.id}::uuid, book_date(now()),
                                       (SELECT max(booking_seq) FROM journal_entry), now())`;
          // The raw driver hands bigints back as strings; the app's own
          // connection parses them. Coerced here so the arithmetic below is
          // integer minor units throughout.
          return {
            available: BigInt(row!.available),
            holds: BigInt(row!.holds),
            ledger: BigInt(row!.ledger),
          };
        };

        /** Raise an instruction directly: the harness, not the fix. */
        const raise = async (amountCents: bigint, tag: string) => {
          const [row] = await tx<{ id: string; hash: string }[]>`
            INSERT INTO payment_instruction
              (account_id, rail, amount_cents, currency, counterparty, value_date,
               requested_by, policy_id, idempotency_key, content_hash)
            VALUES (${acct.id}::uuid, 'ach', ${amountCents}, 'USD',
                    ${tx.json({ type: "ach", holderName: "Proof Co", routingNumber: "021000021", accountNumberLast4: "0000", accountType: "checking" })}::jsonb,
                    book_date(now()), ${maker.id}::uuid, ${policy.id}::uuid,
                    ${`proof:0061:${tag}:${Date.now()}`},
                    decode(md5(random()::text) || md5(random()::text), 'hex'))
            RETURNING id, encode(content_hash, 'hex') AS hash`;
          await tx`
            INSERT INTO payment_instruction_event (instruction_id, kind, actor_id, value_date)
            VALUES (${row!.id}::uuid, 'requested', ${maker.id}::uuid, book_date(now()))`;
          return row!;
        };

        const P1 = 2_000_000n; // $20,000.00
        const P2 = 2_400_000n; // $24,000.00  — the drain

        const start = await availability();
        say(`SUBJECT  ${acct.legal_name}  2100 ${acct.id}`);
        say(`START    ledger ${usd(start.ledger)}  holds ${usd(start.holds)}  AVAILABLE ${usd(start.available)}`);

        /* ================= BEFORE ======================================== */
        say("");
        say("=== BEFORE (the approval path as it was: a bare event INSERT) ===");
        await tx`SAVEPOINT before_arm`;
        // 0061's tables exist only after the migration, and the BEFORE arm must
        // run without them — so it runs first, on the book exactly as it is.
        const b1 = await raise(P1, "before-1");
        const b2 = await raise(P2, "before-2");
        for (const [inst, who] of [
          [b1, checker1],
          [b1, checker2],
          [b2, checker1],
          [b2, checker2],
        ] as const) {
          await tx`
            INSERT INTO payment_instruction_event
              (instruction_id, kind, actor_id, approved_content_hash, value_date)
            VALUES (${inst.id}::uuid, 'approved', ${who!.id}::uuid,
                    decode(${inst.hash}, 'hex'), book_date(now()))`;
        }
        const afterApprove = await availability();
        say(`APPROVE  ${usd(P1)} and ${usd(P2)}, two checkers each`);
        say(`         AVAILABLE ${usd(afterApprove.available)}  holds ${usd(afterApprove.holds)}   <- UNMOVED`);

        const r1 = await A.releasePayment({ instructionId: b1.id, actorId: checker1!.id }, tx);
        const r2 = await A.releasePayment({ instructionId: b2.id, actorId: checker1!.id }, tx);
        const afterRelease = await availability();
        say(`RELEASE  1 -> ${r1.ok ? "POSTED " + r1.value.entryId : "refused " + r1.error.message}`);
        say(`RELEASE  2 -> ${r2.ok ? "POSTED " + r2.value.entryId : "refused " + r2.error.message}`);
        say(`AFTER    ledger ${usd(afterRelease.ledger)}  AVAILABLE ${usd(afterRelease.available)}`);
        say(`         ${usd(P1 + P2)} left against ${usd(start.available)} available`);
        if (!r1.ok) say(`         raw: ${JSON.stringify(r1.error)}`);
        expect(r1.ok && r2.ok).toBe(true);
        await tx`ROLLBACK TO SAVEPOINT before_arm`;

        /* ================= migration ===================================== */
        const [applied] = await tx<{ t: string | null }[]>`
          SELECT to_regclass('payment_release_hold')::text AS t`;
        if (applied?.t === null) {
          const migration = readFileSync(
            path.join(process.cwd(), "db/migrations/0061_payment_release_hold.sql"),
            "utf8",
          );
          await tx.unsafe(migration);
          say("");
          say("=== migration 0061 applied inside this transaction (guard green) ===");
        } else {
          say("");
          say("=== migration 0061 already applied to this book ===");
        }

        /* ================= AFTER ========================================= */
        say("");
        say("=== AFTER (the approval path as it is: approvePayment()) ===");
        const a1 = await raise(P1, "after-1");
        const a2 = await raise(P2, "after-2");

        const approve = async (inst: { id: string; hash: string }, who: string) =>
          A.approvePayment({ instructionId: inst.id, actorId: who, contentHash: inst.hash }, tx);

        const ok1 = await approve(a1, checker1!.id);
        const ok2 = await approve(a1, checker2!.id);
        const held = await availability();
        say(`APPROVE  ${usd(P1)} -> ${ok1.ok && ok2.ok ? "recorded, both checkers" : "refused"}`);
        say(`         AVAILABLE ${usd(held.available)}  holds ${usd(held.holds)}   <- WITHHELD`);

        const drain1 = await approve(a2, checker1!.id);
        const drain2 = await approve(a2, checker2!.id);
        const drainRefused = !drain1.ok || !drain2.ok;
        say(`DRAIN    approve ${usd(P2)} -> ${drainRefused ? "REFUSED" : "recorded"}`);
        if (!drain1.ok) say(`         ${drain1.error.code}: ${drain1.error.message}`);
        else if (!drain2.ok) say(`         ${drain2.error.code}: ${drain2.error.message}`);

        const rel = await A.releasePayment({ instructionId: a1.id, actorId: checker1!.id }, tx);
        const end = await availability();
        const [guard] = await tx<{ n: string }[]>`SELECT count(*) AS n FROM v_payment_release_unheld`;
        const [closure] = await tx<{ source: string }[]>`
          SELECT hc.source FROM hold_closure hc
            JOIN payment_release_hold prh ON prh.hold_id = hc.hold_id
           WHERE prh.instruction_id = ${a1.id}::uuid`;
        say(`RELEASE  1 -> ${rel.ok ? "POSTED " + rel.value.entryId : "refused " + rel.error.message}`);
        say(`         hold closed, source = ${closure?.source ?? "(none)"}`);
        say(`AFTER    ledger ${usd(end.ledger)}  holds ${usd(end.holds)}  AVAILABLE ${usd(end.available)}`);
        say(`GUARD    v_payment_release_unheld = ${guard!.n} rows`);

        expect(drainRefused).toBe(true);
        expect(held.available).toBe(start.available - P1);
        expect(Number(guard!.n)).toBe(0);

        // NOTHING COMMITS.
        throw new Error("PROOF COMPLETE — rolling back");
      })
      .catch((e: Error) => {
        if (!/PROOF COMPLETE/.test(e.message)) throw e;
      })
      .finally(async () => {
        await sql.end();
      });
  }, 120_000);
});
