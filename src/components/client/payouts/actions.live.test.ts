/**
 * The customer's accept action, treated as the public POST endpoint it is.
 *
 * ── WHY THE ACTION IS IMPORTED AND CALLED, NOT POSTED TO ────────────────────
 *
 * `src/components/home/actions.test.ts` imports `openAccountAction` and calls
 * it. This does the same, for the same reason: a server action is an async
 * function, and driving it over HTTP proves the framework's encoding rather
 * than this code. `useActionState` puts the previous-state argument in fields
 * that cannot be reproduced by hand — a multipart POST with a `Next-Action`
 * header closes the connection, urlencoded 404s, and a no-JS multipart POST
 * returns 200 having rendered the page WITHOUT running the action, which looks
 * like a pass and is not.
 *
 * ── IT WRITES REAL ROWS AND IT IS GATED ─────────────────────────────────────
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test src/components/client/payouts
 *
 * Every module that opens a connection is imported DYNAMICALLY inside the
 * gate, because importing one evaluates `src/lib/env.ts`, which refuses to load
 * without a full set of keys — a suite that pulled them in at the top would
 * fail COLLECTION in a run that was only ever going to skip it. That is the
 * shape `src/lib/fx/hold.integration.test.ts` uses and for the same reason.
 *
 * The amounts are small and the quotes it leaves behind are named on their
 * `beneficiary_ref`. `fx_quote` is append-only; there is no undo.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type * as BalancesModule from "@/lib/ledger/balances";
import type * as RateModule from "@/lib/fx/rate";
import type * as StoreModule from "@/lib/fx/store";
import type * as ActionsModule from "@/app/(app)/client/payouts/actions";

import { ACCEPT_IDLE } from "./state";

/**
 * `revalidatePath` is a cache hint that throws outside a request scope, and it
 * is the one thing about a server action that genuinely cannot be exercised
 * from a test process. It is stubbed HERE rather than guarded in the action: a
 * `try/catch` around it in production code would be a swallow, and the action's
 * own rule is that nothing fails silently. Everything else — the parsing, the
 * ownership predicate, the store call, the refusal codes, the receipt — runs
 * exactly as it does behind the form.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const run = process.env["RUN_DB_TESTS"] === "1" ? describe : describe.skip;

/** Small, and twice over, so the second quote can exceed what the first left. */
const QUOTE_CENTS = 12_345n;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

run("acceptClientQuoteAction, against the live book", () => {
  let balances: typeof BalancesModule;
  let rate: typeof RateModule;
  let store: typeof StoreModule;
  let actions: typeof ActionsModule;

  /** The business under test, and another one, both DISCOVERED not pinned. */
  let subject = "";
  let other = "";
  let quoteRef = "";
  let sellCents = 0n;

  /**
   * The customer is discovered, and the reason is this book.
   *
   * Seven other agents are writing to it, an accepted commitment holds its
   * price until it settles or lapses, and a business that had money when this
   * file was written may have none by the time it runs. A suite that pinned one
   * id would report a failure of the feature when what it found was a funded
   * account somebody else had spent.
   */
  async function fundedBusiness(): Promise<string> {
    for (const business of await store.loadBusinesses()) {
      const { availableCents } = await balances.availableBalance(business.businessId);
      if (availableCents >= QUOTE_CENTS * 2n) return business.businessId;
    }
    throw new Error("no business on this book can afford the test quote");
  }

  beforeAll(async () => {
    balances = await import("@/lib/ledger/balances");
    rate = await import("@/lib/fx/rate");
    store = await import("@/lib/fx/store");
    actions = await import("@/app/(app)/client/payouts/actions");

    subject = await fundedBusiness();
    const rest = (await store.loadBusinesses()).filter((b) => b.businessId !== subject);
    const first = rest[0];
    if (first === undefined) throw new Error("one business on this book; isolation is untestable");
    other = first.businessId;

    const created = await store.createQuote({
      businessId: subject,
      buyCurrency: "MXN",
      sellCents: QUOTE_CENTS,
      beneficiaryRef: "ACTION TEST Rivera Textiles",
      destinationAddress: null,
      observation: await rate.observeRate("MXN"),
    });
    if (!created.ok) throw new Error(`could not set up: ${created.error.code}`);
    quoteRef = created.value.quoteRef;
    sellCents = created.value.sellCents;
  }, 120_000);

  it("refuses another customer's quote by the same sentence as one that does not exist", async () => {
    const real = await actions.acceptClientQuoteAction(
      ACCEPT_IDLE,
      form({ businessId: other, quoteRef }),
    );
    const invented = await actions.acceptClientQuoteAction(
      ACCEPT_IDLE,
      form({ businessId: other, quoteRef: "FXQ-ZZZZZZZZ" }),
    );

    expect(real.status).toBe("refused");
    expect(real.code).toBe("FX_QUOTE_NOT_FOUND");
    expect(real.lines).toEqual([]);
    // The whole point of the wording: a reference that is real but somebody
    // else's is indistinguishable from one that was invented, so the form
    // cannot be used to discover which references exist.
    expect(real.message).toBe(invented.message);
  }, 60_000);

  it("refuses a malformed reference before it reaches the database", async () => {
    const result = await actions.acceptClientQuoteAction(
      ACCEPT_IDLE,
      form({ businessId: subject, quoteRef: "'; drop table fx_quote; --" }),
    );
    expect(result.status).toBe("refused");
    expect(result.code).toBe("INVALID_FORM");
  }, 60_000);

  it("accepts the customer's own quote, and availability falls by exactly sell_cents", async () => {
    const before = await balances.availableBalance(subject);
    const result = await actions.acceptClientQuoteAction(
      ACCEPT_IDLE,
      form({ businessId: subject, quoteRef, reference: "ACTION-TEST" }),
    );
    const after = await balances.availableBalance(subject);

    // THE CLAIM THAT LANDED THIS MORNING, asserted rather than eyeballed: an
    // acceptance reserves the price it commits, and availability falls by that
    // and by nothing else.
    expect(result.status).toBe("accepted");
    expect(result.quoteRef).toBe(quoteRef);
    expect(before.availableCents - after.availableCents).toBe(sellCents);
    // A commitment is not a payment. The booked balance does not move.
    expect(after.ledgerCents).toBe(before.ledgerCents);
  }, 60_000);

  it("refuses a second acceptance that exceeds available, and writes nothing", async () => {
    const available = (await balances.availableBalance(subject)).availableCents;
    const tooBig = await store.createQuote({
      businessId: subject,
      buyCurrency: "MXN",
      sellCents: available + 100_00n,
      beneficiaryRef: "ACTION TEST more than is there",
      destinationAddress: null,
      observation: await rate.observeRate("MXN"),
    });
    if (!tooBig.ok) throw new Error(`could not set up: ${tooBig.error.code}`);

    const before = await balances.availableBalance(subject);
    const result = await actions.acceptClientQuoteAction(
      ACCEPT_IDLE,
      form({ businessId: subject, quoteRef: tooBig.value.quoteRef }),
    );
    const after = await balances.availableBalance(subject);

    expect(result.status).toBe("refused");
    expect(result.code).toBe("FX_COMMITMENT_EXCEEDS_AVAILABLE");
    // The message names the money and the fix, and the screen prints it whole.
    expect(result.message).toContain("no acceptance, no hold, no rate locked");
    expect(result.lines).toEqual([]);
    // Nothing was written, so nothing moved.
    expect(after.availableCents).toBe(before.availableCents);
  }, 60_000);
});
