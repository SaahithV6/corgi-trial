"use server";

/**
 * The events screen's write paths.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT, and this one takes a URL that the
 * server will then fetch. Everything in the `FormData` is a claim:
 *
 *   businessId  a REFERENCE, resolved against `business` by the foreign key on
 *               `outbound_endpoint`. A bad one is a constraint violation, not
 *               an endpoint on somebody else's books.
 *   url         re-validated by `checkUrlText` AND by a live DNS resolution
 *               with every returned address checked, inside `registerEndpoint`.
 *               Nothing about the browser-side `type="url"` is trusted; a POST
 *               assembled by hand reaches exactly the same refusals.
 *   eventTypes  intersected with the known event types, so an unknown string
 *               cannot become a subscription filter that silently matches
 *               nothing.
 *
 * ============================================================================
 * THE SECRET IS RETURNED EXACTLY ONCE, HERE, AND NEVER LOGGED.
 *
 * It travels on the action's return value into React state on the client, for
 * the length of one page view. It is not written to the screen's data source
 * (`data-contract.ts` has no field that could hold it), it is not in any view,
 * and `src/lib/events/store.ts` has no read path that can produce it again.
 *
 * The action does not log its own result. That is deliberate and it is not
 * belt-and-braces: `src/lib/log.ts` redacts any field whose key contains
 * "secret", so a `log.info("registered", result)` would have been safe — but
 * relying on a redaction list to make a code path safe is how the next field,
 * named something else, gets through.
 *
 * ============================================================================
 * `disableEndpointAction` WAS HERE AND IS DELETED. 2026-09-11.
 *
 * It parsed an endpoint id, called `disableEndpoint()` and revalidated
 * `/events`, and it worked. It had NO CALLER: nothing in `EventsView`,
 * `RegisterForm` or `page.tsx` rendered a control that posted to it, so no
 * operator could reach it and no refusal it produced could be read by anybody.
 *
 * This is the shape `confirmPayee()` had before it was wired (see the header of
 * `src/app/(app)/payees/actions.ts`), and that precedent argues for wiring
 * rather than deleting. It was deleted instead, for two reasons:
 *
 *   1. A `"use server"` export is a LIVE PUBLIC POST ENDPOINT whether or not a
 *      button points at it. An unreachable control is dead weight; an
 *      unreachable endpoint that stops webhook delivery for a customer is a
 *      capability with no audience and a blast radius, and the only thing
 *      guarding it was that nobody had guessed the action id. Deleting it is
 *      strictly the safer half of the choice.
 *   2. Nothing is lost. `disableEndpoint()` in `@/lib/events/store` still
 *      stands and is still exercised by `src/lib/events/roundtrip.live.test.ts`
 *      at two points. Restoring the action is re-adding twelve lines, and the
 *      next person to do it should do it together with the control that posts
 *      to it — that is the point of this note.
 *
 * The honest limit on this decision: wiring it would have meant editing the
 * events SCREEN, which was outside this change's remit. Somebody who owns
 * `src/components/events/**` should weigh the wiring on its merits; an
 * endpoint nobody can press is not the way to leave the question open.
 * ============================================================================
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { EVENT_TYPES } from "@/lib/events/envelope";

export type Issue = { readonly path: string; readonly message: string };

export type RegisterResult = {
  readonly status: "idle" | "registered" | "refused";
  readonly code: string | null;
  readonly message: string;
  readonly issues: readonly Issue[] | null;
  readonly endpointId: string | null;
  readonly url: string | null;
  /**
   * THE ONE-TIME REVEAL. Non-null only on the response to the call that
   * created the endpoint. Nothing can produce it again.
   */
  readonly secret: string | null;
};

const IDLE: RegisterResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  endpointId: null,
  url: null,
  secret: null,
};

const schema = z.object({
  businessId: z.string().uuid({ error: "pick a business" }),
  // Length only. The real policy is `checkUrlText` plus a DNS resolution, and
  // duplicating a slice of it here would create a second, weaker opinion about
  // what a safe URL is.
  url: z.string().min(12, { error: "a URL is required" }).max(2000),
  description: z.string().min(1, { error: "say what this endpoint is for" }).max(200),
  eventTypes: z.array(z.enum(EVENT_TYPES)).default([]),
});

function issuesOf(error: z.ZodError): readonly Issue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export async function registerEndpointAction(
  _previous: RegisterResult,
  form: FormData,
): Promise<RegisterResult> {
  const parsed = schema.safeParse({
    businessId: String(form.get("businessId") ?? ""),
    url: String(form.get("url") ?? "").trim(),
    description: String(form.get("description") ?? "").trim(),
    eventTypes: form.getAll("eventTypes").map(String),
  });

  if (!parsed.success) {
    return {
      ...IDLE,
      status: "refused",
      code: "INVALID_INPUT",
      message: "That endpoint was not registered.",
      issues: issuesOf(parsed.error),
    };
  }

  const { registerEndpoint, backfillEndpoint } = await import("@/lib/events/store");

  const result = await registerEndpoint({
    businessId: parsed.data.businessId,
    url: parsed.data.url,
    description: parsed.data.description,
    eventTypes: parsed.data.eventTypes,
  });

  if (!result.ok) {
    // The refusal's own message, verbatim. It names the range, the port or the
    // scheme — the whole point of `url.ts` writing them that way is that they
    // are safe and useful to show a customer.
    return {
      ...IDLE,
      status: "refused",
      code: result.error.code,
      message: result.error.message,
    };
  }

  // A small, bounded backfill so the first delivery is visible within a drain
  // rather than whenever the next payment happens. Five events, newest first.
  await backfillEndpoint(result.value.endpoint.id, 5);

  revalidatePath("/events");

  return {
    status: "registered",
    code: null,
    message:
      "Endpoint registered. Copy the signing secret now — it is not stored anywhere it can be read back, " +
      "and this is the only time it is shown.",
    issues: null,
    endpointId: result.value.endpoint.id,
    url: result.value.endpoint.url,
    secret: result.value.secretShownOnce,
  };
}

export type SimpleResult = {
  readonly status: "idle" | "done" | "refused";
  readonly message: string;
};

/**
 * Run the outbound drain by hand.
 *
 * Here for the same reason `/api/drain` exists on the inbound side: being able
 * to say "watch, I will drain it now" in front of a panel beats waiting for a
 * timer. It is safe to press at any time — generation is idempotent at the
 * database and delivery is claimed under a lease — and it is NOT the delivery
 * mechanism. A cron tick is.
 */
export async function drainOutboundAction(): Promise<SimpleResult> {
  const { drainOutbound } = await import("@/lib/events/drain");
  const result = await drainOutbound({ generateLimit: 200, maxBatches: 3 });
  revalidatePath("/events");
  return {
    status: "done",
    message:
      `Generated ${result.generated.eventsCreated} event(s) from seq ${result.generated.cursorFrom} to ` +
      `${result.generated.cursorTo}; claimed ${result.claimed}, delivered ${result.delivered}, ` +
      `retried ${result.retried}, dead-lettered ${result.deadLettered}.` +
      (result.generateError === null ? "" : ` Generation failed: ${result.generateError}`),
  };
}

