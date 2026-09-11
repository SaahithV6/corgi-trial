/**
 * The local harness: drive the real decision path with an ASA-shaped payload,
 * with the provider replaced and NOTHING ELSE replaced.
 *
 * ─── What this is for, and what it is not ───────────────────────────────────
 *
 * ASA is enableable on this program — `GET /v1/responder_endpoints?type=
 * AUTH_STREAM_ACCESS` answers 200, and enrolling is a documented POST away —
 * so the primary evidence for this feature is a real Lithic call, recorded
 * with `source = 'provider'`. This harness is not a substitute for that and
 * must never be presented as one.
 *
 * It exists for the three things a live provider call is bad at:
 *
 *   1. THE CASES YOU CANNOT ASK A SANDBOX FOR. "The control store did not
 *      answer" is a decision this system has to get right and there is no
 *      Lithic endpoint that produces it.
 *   2. SPEED. A limit table with eleven rules has more branches than anyone
 *      will drive by hand at 1 request per second against a sandbox.
 *   3. REGRESSION. The decision function is graded on being *the same*
 *      function the provider drives, and the only way to keep it that way is
 *      to call it from both places.
 *
 * ─── What is real here and what is synthesised ──────────────────────────────
 *
 * REAL: `parseAsaRequest`, `decide`, `readControlsAndSpend`, `appendDecision`
 *       and the database they read and write. Byte for byte the same code the
 *       route runs.
 * SYNTHESISED: the HTTP delivery and the payload. There is no signature to
 *       verify because nobody signed anything, and the payload comes from
 *       `asaPayload()`, which is built from Lithic's published schema rather
 *       than captured from a delivery.
 *
 * That distinction is not left to this comment. Every row this writes carries
 * `source = 'harness'`, the velocity query sums within one source lane so a
 * harness run can never eat a real card's daily limit, and the console labels
 * harness rows on the screen.
 */

import "server-only";

import { stopwatch } from "./budget";
import { parseAsaRequest } from "./asa";
import { decide } from "./decide";
import { asaPayload, type AsaPayloadOverrides } from "./fixtures";
import { appendDecision, readControlsAndSpend } from "./store";
import type { AuthRequest, ControlLookup, Verdict } from "./types";

export type HarnessResult = {
  readonly request: AuthRequest;
  readonly lookup: ControlLookup;
  readonly verdict: Verdict;
  readonly decisionLatencyUs: number;
  readonly decisionId: string | null;
  /** Always 'harness'. Present so a caller cannot forget to state it. */
  readonly source: "harness";
};

/**
 * Replay one ASA-shaped authorisation against the live control store.
 *
 * The `provider` argument defaults to `'lithic'` because the card table is
 * keyed on `(provider, provider_card_token)` and a harness that looked cards
 * up under a different provider would silently exercise the
 * `card_not_under_control` branch for everything and prove nothing.
 */
export async function replayAuthorization(params: {
  readonly overrides?: AsaPayloadOverrides;
  readonly provider?: string;
  /** Skip the append. For a dry run that must leave no trace. */
  readonly record?: boolean;
}): Promise<HarnessResult> {
  const provider = params.provider ?? "lithic";
  const request = parseAsaRequest(asaPayload(params.overrides ?? {}));

  const clock = stopwatch();
  const lookup = await readControlsAndSpend({
    provider,
    providerCardToken: request.card.token,
    source: "harness",
  });
  const verdict = decide(request, lookup);
  const decisionLatencyUs = clock();

  const decisionId =
    params.record === false
      ? null
      : await appendDecision({
          provider,
          request,
          lookup,
          verdict,
          latencyUs: decisionLatencyUs,
          source: "harness",
          requestId: null,
        });

  return { request, lookup, verdict, decisionLatencyUs, decisionId, source: "harness" };
}
