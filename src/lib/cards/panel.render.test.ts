/**
 * The card control panel actually renders — all five URL states.
 *
 * Gated on RUN_DB_TESTS=1, like the other suites that touch Neon:
 *
 *   set -a; . ./.env; set +a; RUN_DB_TESTS=1 pnpm test
 *
 * ─── Why this exists ────────────────────────────────────────────────────────
 *
 * `CardControlsPanel` is not mounted by any route yet — `/accounts/page.tsx` is
 * owned elsewhere and the mount is two lines somebody else has to apply (see
 * docs/CARD-CONTROLS.md §9). That means `next build` compiles it and `tsc`
 * checks it, and NOTHING EVER RUNS IT. A 700-line server component that has
 * never been rendered is a component that crashes the first time it is, in
 * somebody else's page, for reasons they will reasonably assume are theirs.
 *
 * So it is rendered here instead. `renderToReadableStream` rather than
 * `renderToStaticMarkup` because the panel is built out of async server
 * components behind Suspense boundaries — the enrollment probe and the control
 * read — and only the streaming renderer awaits them. `stream.allReady` waits
 * for every boundary to resolve, so a throw inside one fails this test rather
 * than silently leaving a fallback in the markup.
 *
 * `onError` re-throws deliberately. React's default is to log a recoverable
 * error and emit the fallback, which would let a broken panel render 20 KB of
 * skeleton and pass.
 *
 * ─── What it does and does not touch ────────────────────────────────────────
 *
 * READS ONLY. The live states read Neon and call Lithic's read-only
 * `GET /v1/responder_endpoints`. Nothing here writes a row, a control version
 * or a decision; the forms are rendered, not submitted.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";

import { CONTROL_VIEWS } from "./view-state";

const RUN = process.env["RUN_DB_TESTS"] === "1";
const d = RUN ? describe : describe.skip;

async function render(element: Parameters<typeof renderToReadableStream>[0]): Promise<string> {
  const stream = await renderToReadableStream(element, {
    onError: (thrown) => {
      throw thrown;
    },
  });
  await stream.allReady;
  return await new Response(stream).text();
}

d("CardControlsPanel", () => {
  // Driven from CONTROL_VIEWS rather than a hand-written list, so a sixth state
  // cannot be added to the type and left unrendered.
  for (const state of CONTROL_VIEWS) {
    it(`renders ?controls=${state} without throwing`, async () => {
      const { CardControlsPanel } = await import("@/components/accounts/CardControlsPanel");
      const html = await render(
        createElement(CardControlsPanel, { searchParams: { controls: state } }),
      );

      expect(html).toContain("Card controls");
      // The budget panel imports its numbers from `./budget`. If that import
      // ever becomes a hardcoded copy, this is what notices.
      expect(html).toContain("6000 ms");
      expect(html).toContain("600 ms");
      // Every state must render real content, not a bare shell.
      expect(html.length).toBeGreaterThan(4_000);
    });
  }

  it("names the fail-closed rule on the edge state", async () => {
    const { CardControlsPanel } = await import("@/components/accounts/CardControlsPanel");
    const html = await render(
      createElement(CardControlsPanel, { searchParams: { controls: "edge" } }),
    );
    expect(html).toContain("control_store_unavailable");
  });

  it("falls back to the live state for an unrecognised query value", async () => {
    // A malformed URL must show the real screen, never an error page.
    const { CardControlsPanel } = await import("@/components/accounts/CardControlsPanel");
    const html = await render(
      createElement(CardControlsPanel, { searchParams: { controls: "nonsense" } }),
    );
    expect(html).toContain("Card controls");
  });
});
