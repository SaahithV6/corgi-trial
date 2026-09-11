/**
 * Rendering a real page module on a machine with no `APP_DATABASE_URL`.
 *
 * ============================================================================
 * Shared by the six `no-database.test.ts` files under `src/components/**`, one
 * per screen, because the assertion each of them makes is the same one and a
 * sixth hand-written copy of this harness is a sixth chance to write it wrong.
 * The per-screen file holds what is per-screen: the words that screen must not
 * say, the badges it can carry, and the argument for why.
 * ============================================================================
 *
 * NO DATABASE IS NEEDED TO RUN ANY OF THEM, so they are not gated and they run
 * in CI, which holds no credentials on purpose. That is the point: CI is a
 * machine with no `APP_DATABASE_URL`, which is exactly the deployment these
 * tests describe.
 *
 * `renderToReadableStream` rather than `renderToStaticMarkup` so
 * `stream.allReady` waits for the Suspense boundary — a throw inside it fails
 * the test instead of quietly leaving the skeleton in the markup — and
 * `onError` re-throws, because React's default is to log a recoverable error
 * and emit the fallback, which would let a crashed screen render and pass.
 */

import { renderToReadableStream } from "react-dom/server";
import type { ReactNode } from "react";

/** A page module, as `await import("@/app/(app)/<route>/page")` returns it. */
export type PageModule = {
  default: (props: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
  }) => Promise<ReactNode>;
};

/**
 * Render one page at one query string, and give back its markup.
 *
 * The import is the caller's, and it must be DYNAMIC and must happen after
 * `APP_DATABASE_URL` is deleted: a static import would evaluate the page module
 * while the variable is still set, and whether that module can be loaded
 * without one is half of what is under test.
 */
export async function renderPage(
  page: PageModule,
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  const node = await page.default({ searchParams: Promise.resolve(searchParams) });
  const stream = await renderToReadableStream(node, {
    onError(thrown: unknown) {
      throw thrown;
    },
  });
  await stream.allReady;
  return await new Response(stream).text();
}

/**
 * Which source claims a screen is making, as a SET.
 *
 * The assertion is on the set rather than on one string because "the badge is
 * right" and "the screen makes exactly one claim" are different assertions, and
 * only the second one catches two badges disagreeing — which is what
 * `/dashboard` was doing, LIVE on its state bar above FIXTURE on its board, and
 * what `/transactions` was doing with the word `live` in both places on a
 * deployment that had read nothing.
 *
 * A badge is the whole text of its own element, so the delimiters are the tags
 * around it. Callers pass the badge vocabulary their screen can produce.
 */
export function claimsIn(html: string, badges: readonly string[]): string[] {
  return badges.filter((badge) => html.includes(`>${badge}<`));
}

/**
 * Is a retry control on the page?
 *
 * Matched on the button's own text rather than on the substring "Retry", which
 * also occurs inside the word "retryable" — the very line the button would be
 * contradicting.
 */
export function hasRetryControl(html: string): boolean {
  return html.includes(">Retry<") || html.includes(">Retrying");
}
