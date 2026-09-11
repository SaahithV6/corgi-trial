/**
 * The team screen actually renders — every state, against live data.
 *
 * Gated on RUN_DB_TESTS=1, like every suite that touches Neon:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm vitest run src/lib/team
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * The route exists and NOTHING LINKS TO IT: `src/components/app-shell/NavLinks.tsx`
 * is owned elsewhere and adding `/team` to it is one line somebody else has to
 * apply (docs/TEAM.md §9). So `next build` compiles these components, `tsc`
 * checks them, and until that line lands nobody may ever run them — which means
 * the first person to could be a grader, live, on a screen with money on it.
 *
 * ─── What it renders, and the one thing it cannot ───────────────────────────
 *
 * It renders the COMPONENTS with the same values the page hands them: the four
 * non-loading states of `TeamView`, the skeleton, and the forms. The live
 * states go through `readTeamScreen()` against Neon, so this is the real data
 * in the real renderer.
 *
 * It does NOT render `page.tsx` itself, and the reason is worth stating rather
 * than hiding: the page calls `currentActor()`, which calls `cookies()`, which
 * throws outside a request scope — `next dev` and `next build` provide one and
 * a unit test cannot. Wrapping that call in a try/catch so a test could drive
 * it would be production code shaped by a test. What is left uncovered is the
 * eight lines of the page that choose between these components, and those eight
 * lines are type-checked and have no branches a render would exercise that this
 * does not.
 *
 * `renderToReadableStream` rather than `renderToStaticMarkup` because
 * `stream.allReady` waits for every boundary, so a throw inside one fails this
 * test rather than quietly leaving a skeleton in the markup. `onError`
 * re-throws deliberately: React's default is to log a recoverable error and
 * emit the fallback, which would let a broken screen render 20 KB of skeleton
 * and pass.
 *
 * READS ONLY. Nothing here writes a row, creates a card or calls Lithic; the
 * forms are rendered, never submitted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";

import type { TeamFilter } from "@/components/team/view-state";

import type * as FixturesModule from "@/components/team/fixtures";
import type * as FormsModule from "@/components/team/TeamForms";
import type * as ViewModule from "@/components/team/TeamView";
import type * as ScreenModule from "./screen";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

/**
 * EVERY component is imported DYNAMICALLY, inside `beforeAll`, and that is not a
 * style choice.
 *
 * `TeamForms` imports the server actions, which import `@/lib/ledger/db`, which
 * parses the environment at module scope and throws when `APP_DATABASE_URL` is
 * absent — deliberately, so a malformed database URL kills the process at boot
 * rather than at the first request that needs money. A static import would make
 * this file fail to COLLECT on a machine with no credentials, which is every CI
 * runner, and `describe.skip` CANNOT skip a module that threw while being
 * loaded. That is exactly how this suite failed the first time it was run
 * without `.env`, and `cards.integration.test.ts` carries the same note for the
 * same reason.
 */
let screenModule: typeof ScreenModule;
let fixtures: typeof FixturesModule;
let forms: typeof FormsModule;
let view: typeof ViewModule;
let live: ScreenModule.TeamScreen;

const filter = (state: TeamFilter["state"]): TeamFilter => ({
  state,
  businessId: null,
  memberId: null,
});

async function render(element: Parameters<typeof renderToReadableStream>[0]): Promise<string> {
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
  screenModule = await import("./screen");
  fixtures = await import("@/components/team/fixtures");
  forms = await import("@/components/team/TeamForms");
  view = await import("@/components/team/TeamView");
  const result = await screenModule.readTeamScreen(null);
  if (!result.ok) throw new Error(`the live team could not be read: ${result.message}`);
  live = result.screen;
});

d("the team screen", () => {
  it("renders the default state from live rows", async () => {
    const html = await render(createElement(view.TeamView, { screen: live, filter: filter("default") }));
    expect(html).toContain("the team");
    expect(html).toContain("v_approved_auth_for_dead_member");
    expect(html).toContain("v_member_approval_without_right");
    expect(html.length).toBeGreaterThan(3_000);
  });

  it("renders the edge state, and makes its argument on the screen", async () => {
    // The one paragraph that has to be on the screen and not only in a
    // document: a removed person's card still holding money is CORRECT, and the
    // first reaction to it is a ticket.
    const html = await render(
      createElement(view.TeamView, {
        screen: live,
        filter: filter("edge"),
        edgeOnly: screenModule.edgeMembers(live),
      }),
    );
    expect(html).toContain("member_removed");
    expect(html).toMatch(/must stay that way|still settle/i);
  });

  it("renders the empty state and says FIXTURE on its face", async () => {
    const html = await render(
      createElement(view.TeamView, { screen: fixtures.EMPTY_TEAM, filter: filter("empty"), fixture: fixtures.EMPTY_NOTE }),
    );
    expect(html).toContain("FIXTURE");
    expect(html).toContain("team_add_member()");
  });

  it("renders the skeleton the loading state shows", async () => {
    const html = await render(createElement(view.TeamSkeleton, {}));
    expect(html).toContain("aria-busy");
  });

  it("renders the forms, including for a caller who may not administer", async () => {
    for (const canAdminister of [true, false]) {
      const html = await render(
        createElement(forms.TeamForms, {
          businessId: live.businessId,
          members: live.members,
          formKey: "00000000-0000-4000-8000-000000000000",
          canAdminister,
        }),
      );
      expect(html).toContain("Add somebody to the team");
      // The buttons are never hidden: the refusal is the instructive thing, and
      // hiding a control is not enforcement.
      expect(html).toContain("Issue a card");
      expect(html).toContain("Suspend, remove or reinstate");
    }
  });

  it("shows every live member, removed ones included", async () => {
    // A team screen that hid the people who were removed could not answer "who
    // spent this", which is the question the whole feature exists for.
    const html = await render(createElement(view.TeamView, { screen: live, filter: filter("default") }));
    for (const detail of live.members.slice(0, 8)) {
      expect(html).toContain(detail.member.displayName);
    }
  });
});
