/**
 * The one thing this feature needs from the issuer that the rail adapter does
 * not already do: change a card's state.
 *
 * ─── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────
 *
 * Removing a member has to stop their card authorising. This system has a
 * real-time authorisation decision that would do it — rule `member_removed` in
 * `@/lib/cards/decide` — and that decision is only reached when Lithic is
 * enrolled to call us, which it is NOT today (docs/CARD-CONTROLS.md §1, call 7:
 * ASA is disenrolled, deliberately, until the responder is deployed).
 *
 * So a removal that relied on the ASA rule alone would be a revocation that
 * does nothing tonight, on a screen that says the card is off. That is the
 * exact shape of defect this build spends its time hunting, and the fix is not
 * a caveat in a document: it is a second, independent mechanism that works
 * without ASA. `PATCH /v1/cards/{token}` is enforced by the ISSUER, on their
 * side of the network, whether or not they are calling us.
 *
 * The two mechanisms are deliberately redundant and they fail in opposite
 * directions — ours declines when we cannot be reached, theirs declines when
 * they cannot reach us — so a removal holds under both halves of the outage
 * matrix.
 *
 * ─── WHY A BARE `fetch` AND NOT `rails/lithic/client` ───────────────────────
 *
 * That client is the right thing for every other Lithic call and it is used
 * unchanged for issuing (`createCard`, in `./issue.ts`). It has no
 * `updateCard`, and `src/lib/rails/**` is not this work's to change tonight. So
 * this is a bare `fetch` with its own deadline, the same shape and the same
 * precedent as `@/lib/cards/provider.ts`, which fetches the ASA secret the same
 * way and says why in its own header.
 *
 * It is off every hot path: removal is a human pressing a button, not an
 * authorisation waiting on a 6000 ms window.
 *
 * ─── WHAT IT NEVER DOES ─────────────────────────────────────────────────────
 *
 * It never reads or returns a PAN. `PATCH /v1/cards/{token}` answers with the
 * non-PCI card shape, and nothing below plucks `pan` out of it even if one
 * arrives.
 */

import "server-only";

/**
 * Lithic's card states, verbatim from their OpenAPI document.
 *
 *   OPEN    authorises normally.
 *   PAUSED  declines, reversibly. The card object survives and can be
 *           re-opened — which is what makes it the right state for a SUSPENDED
 *           member, whose membership is also reversible.
 *   CLOSED  terminal at the provider. Lithic documents it as permanent: a
 *           closed card cannot be re-opened. That is the right state for a
 *           REMOVED member, whose membership is also terminal here.
 *
 * `PENDING_ACTIVATION` and `PENDING_FULFILLMENT` exist for physical cards and
 * are not settable by us.
 */
export const PROVIDER_CARD_STATES = ["OPEN", "PAUSED", "CLOSED"] as const;

export type ProviderCardState = (typeof PROVIDER_CARD_STATES)[number];

export type ProviderCardOutcome =
  | { readonly ok: true; readonly state: string; readonly token: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

const SANDBOX_BASE = "https://sandbox.lithic.com/v1";

/** Generous: this is a button press, not an authorisation. */
const TIMEOUT_MS = 8_000;

function baseUrl(): string {
  return process.env["LITHIC_BASE_URL"] ?? SANDBOX_BASE;
}

function apiKey(): string | null {
  const key = process.env["LITHIC_API_KEY"];
  return key === undefined || key === "" ? null : key;
}

/**
 * Set a card's state at the issuer.
 *
 * Returns an outcome rather than throwing, because the caller — removing a
 * member — must be able to record that the local revocation succeeded and the
 * provider call did not. THAT COMBINATION IS A REAL STATE AND IT MUST BE
 * VISIBLE: the member is removed here, their card still says OPEN at Lithic,
 * and somebody has to be told. Swallowing it would leave a live card behind a
 * screen that says it is dead.
 *
 * Lithic sends the API key BARE in `Authorization`, with no `Bearer` prefix —
 * the one line of this that differs from every other provider in the repo.
 */
export async function setProviderCardState(params: {
  readonly providerCardToken: string;
  readonly state: ProviderCardState;
  readonly timeoutMs?: number;
}): Promise<ProviderCardOutcome> {
  const key = apiKey();
  if (key === null) {
    return {
      ok: false,
      code: "NOT_CONFIGURED",
      message: "LITHIC_API_KEY is not set, so the card's state at the issuer was not changed.",
    };
  }

  try {
    const response = await fetch(
      `${baseUrl()}/cards/${encodeURIComponent(params.providerCardToken)}`,
      {
        method: "PATCH",
        headers: {
          authorization: key,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ state: params.state }),
        cache: "no-store",
        signal: AbortSignal.timeout(params.timeoutMs ?? TIMEOUT_MS),
      },
    );

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        code: `HTTP_${response.status}`,
        message: `PATCH /v1/cards/${params.providerCardToken} returned ${response.status}: ${text.slice(0, 300)}`,
      };
    }

    // Only two fields are read out of the body, and `pan` is not one of them.
    const body = JSON.parse(text) as { state?: unknown; token?: unknown };
    return {
      ok: true,
      state: typeof body.state === "string" ? body.state : params.state,
      token: typeof body.token === "string" ? body.token : params.providerCardToken,
    };
  } catch (thrown) {
    return {
      ok: false,
      code: "PROVIDER_UNREACHABLE",
      message:
        thrown instanceof Error
          ? `${thrown.name}: ${thrown.message}`
          : "the issuer could not be reached",
    };
  }
}

/**
 * What the issuer currently says a card is.
 *
 * Used by the team screen so it can print the PROVIDER's opinion beside ours
 * rather than implying they agree. `null` means we did not get an answer, and
 * the screen says "not read" — never "OPEN".
 */
export async function readProviderCardState(
  providerCardToken: string,
  timeoutMs = 3_000,
): Promise<string | null> {
  const key = apiKey();
  if (key === null) return null;
  try {
    const response = await fetch(
      `${baseUrl()}/cards/${encodeURIComponent(providerCardToken)}`,
      {
        method: "GET",
        headers: { authorization: key, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as { state?: unknown };
    return typeof body.state === "string" ? body.state : null;
  } catch {
    return null;
  }
}

/**
 * The state a member's card should be in, given their membership state.
 *
 * One function so the mapping exists once. `suspended -> PAUSED` and
 * `removed -> CLOSED` line up the reversibility of the two systems: a state
 * that can be undone here maps to a state that can be undone there, and a
 * terminal state maps to a terminal one. A removal that only PAUSED the card
 * would leave a revoked person's card one API call away from spending again.
 */
export function providerStateFor(memberState: "active" | "suspended" | "removed"): ProviderCardState {
  switch (memberState) {
    case "active":
      return "OPEN";
    case "suspended":
      return "PAUSED";
    case "removed":
      return "CLOSED";
  }
}
