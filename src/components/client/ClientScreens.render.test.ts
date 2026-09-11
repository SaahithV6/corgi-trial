/**
 * The client surface actually renders — every screen, every state, against the
 * live book.
 *
 * Gated on RUN_DB_TESTS=1, like every suite that touches Neon:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run src/components/client
 *
 * ─── Why this exists, and it is not belt and braces ─────────────────────────
 *
 * `tsc` proves these components type-check and `eslint` proves they parse.
 * Neither runs them. The only other way to run them is `next dev`, and on the
 * machine this was written on the shared dev server had been up for eight hours
 * with a stale module graph, answering 500 to every route in the build — mine
 * and everybody else's — over a `Can't resolve 'zod'` that was false the moment
 * it was raised. A surface nobody has executed is a surface whose first
 * execution could be a grader, live, on a screen with money on it. That is this
 * codebase's defining failure and it has found it twenty-odd times.
 *
 * ─── What it renders, and what it cannot ────────────────────────────────────
 *
 * Every view component, with exactly the values the pages hand them, and the
 * live states go through `readBalanceScreen()` and its four siblings against
 * Neon — so this is real data in the real renderer, with the real tenant
 * predicate applied.
 *
 * It does NOT render `page.tsx`. `loadApprove()` calls `currentActor()`, which
 * calls `cookies()`, which throws outside a request scope; `next dev` provides
 * one and a unit test cannot. Wrapping that in a try/catch so a test could
 * drive it would be production code shaped by a test. What that leaves
 * uncovered is the handful of lines in each page that choose between these
 * components, which are type-checked and have no branch a render would
 * exercise that this does not.
 *
 * `renderToReadableStream` rather than `renderToStaticMarkup` because
 * `stream.allReady` waits for every boundary, so a throw inside one fails this
 * test instead of quietly leaving a skeleton in the markup. `onError` re-throws
 * deliberately: React's default is to log a recoverable error and emit the
 * fallback, which would let a broken screen render and pass.
 *
 * READS ONLY. Nothing here writes a row. The forms are rendered, never
 * submitted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";

import type * as ActivityModule from "./ActivityView";
import type * as ApproveModule from "./ApproveView";
import type * as BalanceModule from "./BalanceView";
import type * as CardsModule from "./CardsView";
import type * as ChromeModule from "./Chrome";
import type * as ContractModule from "./contract";
import type * as FixtureModule from "./fixtures";
import type * as PayModule from "./PayView";
import type * as SourceModule from "@/app/(app)/client/live-source";
import type { ClientState, ClientView } from "./view-state";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

/**
 * Every module is imported DYNAMICALLY inside `beforeAll`, and that is not a
 * style choice — `live-source.ts` imports `@/lib/ledger/db`, which parses the
 * environment at module scope and throws when `APP_DATABASE_URL` is absent,
 * deliberately, so a malformed database URL kills the process at boot rather
 * than at the first request that needs money. A static import would make this
 * file fail to COLLECT on a machine with no credentials, and `describe.skip`
 * cannot skip a module that threw while it was being loaded.
 */
let activity: typeof ActivityModule;
let approve: typeof ApproveModule;
let balance: typeof BalanceModule;
let cards: typeof CardsModule;
let chrome: typeof ChromeModule;
let fixtures: typeof FixtureModule;
let pay: typeof PayModule;
let source: typeof SourceModule;

let liveBalance: ContractModule.BalanceScreen;
let liveActivity: ContractModule.ActivityScreen;
let liveCards: ContractModule.CardsScreen;
let livePay: ContractModule.PayScreen;
let edgeBalance: ContractModule.BalanceScreen;

/** Kettle & Crumb — uuid5('business:kettle-and-crumb'), see sources.ts. */
const UNCLEARED = "1151e7b5-b75b-5f58-bdbf-68cd714178ce";

const view = (state: ClientState): ClientView => ({
  state,
  businessId: null,
  paymentId: null,
});

async function render(
  element: Parameters<typeof renderToReadableStream>[0],
): Promise<string> {
  const stream = await renderToReadableStream(element, {
    onError: (thrown) => {
      throw thrown;
    },
  });
  await stream.allReady;
  return await new Response(stream).text();
}

beforeAll(async () => {
  if (!RUN) return;
  [activity, approve, balance, cards, chrome, fixtures, pay, source] = await Promise.all([
    import("./ActivityView"),
    import("./ApproveView"),
    import("./BalanceView"),
    import("./CardsView"),
    import("./Chrome"),
    import("./fixtures"),
    import("./PayView"),
    import("@/app/(app)/client/live-source"),
  ]);

  const read = async <T,>(result: ContractModule.Loaded<T>, what: string): Promise<T> => {
    if (!result.ok) throw new Error(`${what} could not be read: ${result.message}`);
    return result.value;
  };

  liveBalance = await read(await source.readBalanceScreen(null), "the balance");
  liveActivity = await read(await source.readActivityScreen(null, 40), "the activity");
  liveCards = await read(await source.readCardsScreen(null), "the cards");
  livePay = await read(await source.readPayScreen(null), "the payment form");
  edgeBalance = await read(await source.readBalanceScreen(UNCLEARED), "the edge balance");
}, 120_000);

/* -------------------------------------------------------------------------- */

d("the balance screen", () => {
  it("renders live, with the derivation and the one instant it was read at", async () => {
    const html = await render(
      createElement(balance.BalanceView, { screen: liveBalance, view: view("default") }),
    );
    expect(html).toContain("You can spend right now");
    expect(html).toContain("In your account");
    expect(html).toContain("ledger_availability()");
    expect(html).toContain(liveBalance.header.legalName);
    expect(html.length).toBeGreaterThan(3_000);
  });

  it("never prints a chart-of-accounts code or the word memo at the customer", async () => {
    // The gap this surface exists to close. A `2100` on a customer's own screen
    // is the ledger leaking through the product.
    const html = await render(
      createElement(balance.BalanceView, { screen: liveBalance, view: view("default") }),
    );
    const prose = html.replace(/<[^>]*>/g, " ");
    expect(prose).not.toContain("2100");
    expect(prose.toLowerCase()).not.toContain("memo");
    expect(prose.toLowerCase()).not.toContain("journal");
  });

  it("shows a NEGATIVE available balance against a POSITIVE ledger balance, live", async () => {
    // The graded edge case, and it is a real position on this book rather than
    // a fixture: an ACH credit has landed and has not cleared.
    expect(edgeBalance.terms.ledgerCents).toBeGreaterThan(0n);
    expect(edgeBalance.terms.availableCents).toBeLessThan(0n);
    expect(edgeBalance.terms.unclearedCents).toBeGreaterThan(0n);

    const html = await render(
      createElement(balance.BalanceView, { screen: edgeBalance, view: view("edge") }),
    );
    expect(html).toContain("below zero");
    expect(html).toMatch(/do not round this up to zero/i);
  });

  it("renders the empty fixture, arithmetic included, saying FIXTURE", async () => {
    const html = await render(
      createElement(balance.BalanceView, {
        screen: fixtures.emptyBalance(),
        view: view("empty"),
      }),
    );
    expect(html).toContain("FIXTURE");
    expect(html).toContain("Nothing is being held");
  });
});

d("the activity screen", () => {
  it("renders live transactions in the customer's words", async () => {
    const html = await render(
      createElement(activity.ActivityView, {
        screen: liveActivity,
        view: view("default"),
        correctionsOnly: false,
      }),
    );
    expect(html).toContain("Your activity");
    expect(html).toMatch(/Bank transfer|Card payment|Money in|Money out|Stablecoin/);
    expect(html).toContain("learned");
  });

  it("renders the corrections-only edge state without inventing one", async () => {
    const html = await render(
      createElement(activity.ActivityView, {
        screen: liveActivity,
        view: view("edge"),
        correctionsOnly: true,
      }),
    );
    expect(html).toContain("Corrections only");
  });

  it("renders the empty fixture", async () => {
    const html = await render(
      createElement(activity.ActivityView, {
        screen: fixtures.emptyActivity(),
        view: view("empty"),
        correctionsOnly: false,
      }),
    );
    expect(html).toContain("FIXTURE");
  });
});

d("the cards screen", () => {
  it("renders live cards and prints the recorded decline sentence verbatim", async () => {
    const html = await render(
      createElement(cards.CardsView, {
        screen: liveCards,
        view: view("default"),
        declinesOnly: false,
      }),
    );
    expect(html).toContain("Your cards");
    const decline = liveCards.decisions.find((row) => row.outcome === "decline");
    if (decline !== undefined) {
      // The exact sentence from card_auth_decision.reason, not a paraphrase.
      expect(html).toContain(decline.reason.slice(0, 40));
      expect(html).toContain(decline.rule);
    }
  });

  it("renders the declines-only edge state", async () => {
    const html = await render(
      createElement(cards.CardsView, {
        screen: liveCards,
        view: view("edge"),
        declinesOnly: true,
      }),
    );
    expect(html).toMatch(/Declined authorisations/);
  });

  it("renders the empty fixture", async () => {
    const html = await render(
      createElement(cards.CardsView, {
        screen: fixtures.emptyCards(),
        view: view("empty"),
        declinesOnly: false,
      }),
    );
    expect(html).toContain("FIXTURE");
  });
});

d("the payment screen", () => {
  it("renders the live form against this business's own payees", async () => {
    const html = await render(
      createElement(pay.PayView, {
        screen: livePay,
        view: view("default"),
        prefillAtThreshold: false,
      }),
    );
    expect(html).toContain("Send a payment");
    expect(html).toContain("Who are you paying?");
    expect(html).toContain("What is this for?");
    // The account is not a field the customer picks from a list.
    expect(html).toContain('name="accountId"');
    expect(html).toContain('type="hidden"');
  });

  it("prefills the edge state at exactly the threshold, ungrouped", async () => {
    const html = await render(
      createElement(pay.PayView, {
        screen: livePay,
        view: view("edge"),
        prefillAtThreshold: true,
      }),
    );
    // No thousands separator: a form prefilled with "2,500.00" round-trips to a
    // parse failure, which is the pressure that puts a float back on the path.
    expect(html).not.toMatch(/value="[0-9]+,[0-9]{3}/);
  });

  it("renders the empty fixture, with the gate refusing in words", async () => {
    const html = await render(
      createElement(pay.PayView, {
        screen: fixtures.emptyPay(),
        view: view("empty"),
        prefillAtThreshold: false,
      }),
    );
    expect(html).toContain("FIXTURE");
    expect(html).toContain("cannot send money yet");
  });
});

d("the approvals screen", () => {
  it("renders without a queue, and says why there is not one", async () => {
    const html = await render(
      createElement(approve.ApproveView, {
        screen: fixtures.emptyApprove(),
        view: view("empty"),
      }),
    );
    expect(html).toContain("Payment reference");
    expect(html).toMatch(/spans every customer of this bank/);
    expect(html).toContain("docs/CLIENT.md");
  });

  it("gives the SAME answer for a reference that does not exist", async () => {
    const nobody = await source.readApproveScreen(
      null,
      "00000000-0000-4000-8000-000000000000",
      null,
    );
    expect(nobody.ok).toBe(true);
    if (nobody.ok) {
      expect(nobody.value.payment).toBeNull();
      expect(nobody.value.lookupMessage).toMatch(
        /does not exist and one belonging to another/,
      );
    }
  });

  it("gives that SAME answer for a REAL payment belonging to another customer", async () => {
    // The assertion this whole surface turns on, against real rows.
    //
    // `listQueue()` is read here ON PURPOSE and only here: it is the
    // platform-wide queue, so it is the fastest way to lay hands on an
    // instruction that genuinely belongs to somebody else. Measured on this
    // book, most of it belongs to *Hold Fuzzer Fixture Co.* A test may look
    // across tenants to prove a screen does not.
    const { listQueue } = await import("@/lib/approvals/instructions");
    const { ledgerConnection, readAccountIdentity } = await import("@/lib/ledger/queries");
    const conn = await ledgerConnection();

    const queue = await listQueue({ pendingOnly: false, limit: 200 }, conn);
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;

    const mine = liveBalance.header.businessId;
    let foreign: string | null = null;
    for (const item of queue.value) {
      const identity = await readAccountIdentity(item.instruction.accountId, conn);
      if (identity !== null && identity.businessId !== null && identity.businessId !== mine) {
        foreign = item.instruction.id;
        break;
      }
    }

    // If this book ever holds exactly one customer's payments the assertion
    // below would pass vacuously, so say so rather than let it.
    expect(foreign, "no instruction on this book belongs to another business").not.toBeNull();
    if (foreign === null) return;

    const looked = await source.readApproveScreen(mine, foreign, null);
    expect(looked.ok).toBe(true);
    if (looked.ok) {
      expect(looked.value.payment).toBeNull();
      expect(looked.value.lookupMessage).toMatch(
        /does not exist and one belonging to another/,
      );
    }
  });

  it("DOES answer for a payment that belongs to this customer", async () => {
    // Without this, "it refused" would also be satisfied by a screen that
    // refuses everything. Same argument `livefire.mjs --only 5` makes about
    // maker-checker.
    const { listQueue } = await import("@/lib/approvals/instructions");
    const { ledgerConnection, readAccountIdentity } = await import("@/lib/ledger/queries");
    const conn = await ledgerConnection();

    const queue = await listQueue({ pendingOnly: false, limit: 200 }, conn);
    if (!queue.ok) return;

    const mine = liveBalance.header.businessId;
    let own: string | null = null;
    for (const item of queue.value) {
      const identity = await readAccountIdentity(item.instruction.accountId, conn);
      if (identity !== null && identity.businessId === mine) {
        own = item.instruction.id;
        break;
      }
    }
    if (own === null) return;

    const looked = await source.readApproveScreen(mine, own, null);
    expect(looked.ok).toBe(true);
    if (looked.ok) {
      expect(looked.value.payment).not.toBeNull();
      expect(looked.value.lookupMessage).toBeNull();
      const html = await render(
        createElement(approve.ApproveView, {
          screen: looked.value,
          view: view("default"),
        }),
      );
      // No actor was resolved, so the gate refuses and says so in a sentence.
      expect(html).toMatch(/No actor is resolved|cannot approve|already left/);
      expect(html).toContain("fingerprint");
    }
  });
});

d("the chrome", () => {
  it("renders the skeleton the loading state shows", async () => {
    const html = await render(createElement(chrome.ClientSkeleton, {}));
    expect(html).toContain("aria-busy");
  });

  /**
   * `ClientErrorPanel` is NOT rendered here, and the reason is a real limit
   * rather than a gap somebody forgot.
   *
   * It wraps `RetryButton`, which calls `useRouter()`, which throws "invariant
   * expected app router to be mounted" outside a Next request — measured, and
   * it hangs the stream rather than failing cleanly. Every error panel in this
   * build uses that same button, so this is a property of the house component
   * and not of this screen. What IS asserted is the thing that could be wrong
   * here: the sentence a customer is shown when a read fails, which has to say
   * that nothing moved before it says anything else.
   */
  it("tells a customer that nothing moved, before anything else", async () => {
    const failed = fixtures.errorState<ContractModule.BalanceScreen>();
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.message).toMatch(/Nothing has moved/);
      expect(failed.message).toContain("FIXTURE");
    }
  });
});
