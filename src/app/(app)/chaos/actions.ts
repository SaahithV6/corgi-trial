"use server";

/**
 * The chaos screen's server actions.
 *
 * Six, and every one of them is either "arm something with a clock on it" or
 * "turn something off". There is deliberately no action that arms a control
 * without an expiry, because there is no such thing: `armControl` computes
 * `expires_at` in Postgres and `chaos_control_bounded` refuses anything over
 * ten minutes.
 *
 * NO REFUSAL IS SWALLOWED. Every failure comes back as a `refused` with the
 * code and the message the library produced, because a generic "something went
 * wrong" on a screen whose whole job is honesty would be the wrong kind of
 * irony.
 *
 * WHAT NONE OF THESE CAN DO. None of them writes to the ledger, posts a journal
 * entry, or touches a money table. `startEpisodeAction` causes money to move
 * only in the sense that it hands a signed webhook delivery to the same
 * `ingestWebhook` the deployed route calls; everything after that is the
 * ordinary pipeline's decision, and chaos has no branch in it.
 */

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { currentActor } from "@/lib/approvals/session";
import {
  armControl,
  ChaosControlError,
  disarmAll,
  disarmControl,
  isChaosControl,
  registerEpisodeCard,
  releaseDueDeliveries,
  startChaosRun,
  sweepExpired,
  type ChaosControl,
} from "@/lib/chaos";
import { logger } from "@/lib/log";

import type { ChaosActionResult } from "@/components/chaos/action-result";

import { assertOperatorAction } from "@/lib/authz/action-guard";

const log = logger({ base: { module: "chaos.actions" } });

const armSchema = z.object({
  control: z.string().trim().min(1),
  seconds: z.coerce.number().int().positive(),
  value: z.coerce.number().int().positive().optional(),
});

function refused(code: string, message: string, subject: string | null): ChaosActionResult {
  return { status: "refused", code, message, subject };
}

function done(message: string, subject: string | null): ChaosActionResult {
  return { status: "done", code: null, message, subject };
}

/** Who is pressing the button. Named on every audit line. */
async function actorName(): Promise<{ name: string; id: string | undefined }> {
  const actor = await currentActor();
  if (actor === null) return { name: "unidentified operator", id: undefined };
  return { name: actor.displayName, id: actor.id };
}

/**
 * Translate a thrown library error into a refusal a person can act on.
 *
 * `ChaosControlError` carries text written for exactly this moment — the
 * bounds explain themselves and name the database constraint behind them — so
 * it is passed through rather than replaced.
 */
function asRefusal(thrown: unknown, subject: string | null): ChaosActionResult {
  if (thrown instanceof ChaosControlError) {
    return refused("CHAOS_REFUSED", thrown.message, subject);
  }
  const message = thrown instanceof Error ? thrown.message : "unknown failure";
  log.warn("chaos.action_failed", { subject, error: message });
  return refused("CHAOS_FAILED", message, subject);
}

function revalidate(): void {
  revalidatePath("/chaos");
}

// ---------------------------------------------------------------------------
// Arming and disarming
// ---------------------------------------------------------------------------

export async function armControlAction(
  _previous: ChaosActionResult,
  formData: FormData,
): Promise<ChaosActionResult> {
  await assertOperatorAction("armControlAction");

  const parsed = armSchema.safeParse({
    control: formData.get("control") ?? "",
    seconds: formData.get("seconds") ?? "",
    value: formData.get("value") ?? undefined,
  });

  if (!parsed.success) {
    return refused(
      "INVALID_FORM",
      "The form could not be read, so nothing was armed. Chaos is in whatever state it was already in.",
      null,
    );
  }
  if (!isChaosControl(parsed.data.control)) {
    return refused("UNKNOWN_CONTROL", `there is no chaos control called '${parsed.data.control}'`, null);
  }

  const control: ChaosControl = parsed.data.control;
  const actor = await actorName();

  try {
    const armed = await armControl({
      control,
      seconds: parsed.data.seconds,
      actor: actor.name,
      actorId: actor.id,
      ...(parsed.data.value === undefined ? {} : { value: parsed.data.value }),
    });
    revalidate();
    return done(
      `${control} is armed and turns itself off in ${String(armed.secondsRemaining)}s. ` +
        `Nothing about the provider has changed — this is our switch.`,
      control,
    );
  } catch (thrown) {
    return asRefusal(thrown, control);
  }
}

export async function disarmControlAction(
  _previous: ChaosActionResult,
  formData: FormData,
): Promise<ChaosActionResult> {
  await assertOperatorAction("disarmControlAction");

  const raw = String(formData.get("control") ?? "");
  if (!isChaosControl(raw)) {
    return refused("UNKNOWN_CONTROL", `there is no chaos control called '${raw}'`, null);
  }
  const actor = await actorName();
  try {
    const wasArmed = await disarmControl(raw, actor.name);
    revalidate();
    return done(
      wasArmed
        ? `${raw} is off. Any delivery it was holding back is now due and catches up on the next release.`
        : `${raw} was not armed.`,
      raw,
    );
  } catch (thrown) {
    return asRefusal(thrown, raw);
  }
}

/**
 * The big red button.
 *
 * Rendered on EVERY state of the screen, including the state where nothing is
 * armed. The moment somebody needs it is the moment they are not sure what is
 * armed, and a button that appears only when it is needed is a button nobody
 * can find under pressure.
 */
export async function allChaosOffAction(
  _previous: ChaosActionResult,
  _formData: FormData,
): Promise<ChaosActionResult> {
  await assertOperatorAction("allChaosOffAction");

  const actor = await actorName();
  try {
    const turnedOff = await disarmAll(actor.name);
    await sweepExpired();
    revalidate();
    return done(
      turnedOff === 0
        ? "Nothing was armed. Chaos is off."
        : `${String(turnedOff)} control(s) turned off. Chaos is off, and every withheld delivery is now due.`,
      "all",
    );
  } catch (thrown) {
    return asRefusal(thrown, "all");
  }
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

export async function startEpisodeAction(
  _previous: ChaosActionResult,
  formData: FormData,
): Promise<ChaosActionResult> {
  await assertOperatorAction("startEpisodeAction");

  const registerFirst = String(formData.get("registerCardFirst") ?? "") === "yes";
  const actor = await actorName();
  try {
    const run = await startChaosRun({ actor: actor.name, registerCardFirst: registerFirst });
    revalidate();
    return done(
      `Episode ${run.runId.slice(0, 8)} started: ${run.summary}. ${run.released.note}` +
        (registerFirst
          ? ""
          : " The card is deliberately NOT registered, so the deliveries park rather than posting against a customer nobody chose."),
      "episode",
    );
  } catch (thrown) {
    return asRefusal(thrown, "episode");
  }
}

/**
 * Release whatever the armed controls now allow.
 *
 * This is the "and now the provider comes back" button. It is also called on
 * every page load, so a delayed settlement lands without anyone pressing
 * anything — the button exists because "watch, I will release it now" beats
 * waiting for a timer in front of a panel.
 */
export async function releaseNowAction(
  _previous: ChaosActionResult,
  _formData: FormData,
): Promise<ChaosActionResult> {
  await assertOperatorAction("releaseNowAction");

  const actor = await actorName();
  try {
    const released = await releaseDueDeliveries({ actor: actor.name });
    revalidate();
    return done(released.note, "release");
  } catch (thrown) {
    return asRefusal(thrown, "release");
  }
}

/**
 * Bind the episode's card, and wake what was parked waiting for it.
 *
 * The frame worth watching: the same events, never re-delivered and never
 * re-signed, go from parked to posted the instant the system is told whose
 * money it is.
 */
export async function registerCardAction(
  _previous: ChaosActionResult,
  formData: FormData,
): Promise<ChaosActionResult> {
  await assertOperatorAction("registerCardAction");

  const runId = String(formData.get("runId") ?? "");
  if (runId === "") {
    return refused("NO_RUN", "no episode was named, so no card was registered", "card");
  }
  const actor = await actorName();
  try {
    const result = await registerEpisodeCard(runId, actor.name);
    revalidate();
    return done(result.note, "card");
  } catch (thrown) {
    return asRefusal(thrown, "card");
  }
}
