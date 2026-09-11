"use server";

/**
 * The two writes the card control panel can make.
 *
 * `setCardControlsAction` appends a control version. `replayAuthorizationAction`
 * drives the real decision function with an ASA-shaped payload and records the
 * result in the harness lane.
 *
 * NEITHER OF THESE POSTS MONEY, and that is not an accident of what they
 * happen to call — there is no path from this file to `ledger_append()`,
 * `postEntry()` or any journal table. The whole feature is a decision surface;
 * money still moves on the asynchronous card webhook.
 *
 * WHY THE REPLAY ACTION EXISTS ON A SCREEN. It would be easy to leave the
 * harness in the test suite. It is here because the panel has to be able to
 * demonstrate a decline in front of someone, and because a demonstration that
 * can only be given when a provider cooperates is not a demonstration you can
 * rely on in a live-fire session. Every row it writes carries
 * `source = 'harness'`, the velocity query sums within one source lane so a
 * replay can never eat a real card's daily limit, and the history table shows
 * the lane in a badge. If Lithic is enrolled, the same card can be driven for
 * real from the console above and the two rows sit next to each other, labelled
 * differently, which is the most useful thing this screen does.
 *
 * `"use server"` files may export nothing but async functions, so the result
 * type and the `IDLE_CONTROL_RESULT` constant live in `@/lib/cards/view-state`.
 */

import { revalidatePath } from "next/cache";

import { currentActor } from "@/lib/approvals/session";
import { parseUsdAmount } from "@/components/accounts/amount";
import { parseMccList } from "@/lib/cards/mcc";
import { setCardControls } from "@/lib/cards/store";
import { replayAuthorization } from "@/lib/cards/harness";
import { isUuid } from "@/components/accounts/console-state";
import type { CardControlsActionResult } from "@/lib/cards/view-state";
import type { CardState } from "@/lib/cards/types";

function failed(
  code: string,
  message: string,
  intent: CardControlsActionResult["intent"],
  cardId: string | null,
): CardControlsActionResult {
  return { status: "failed", intent, code, message, facts: [], cardId, at: new Date().toISOString() };
}

/**
 * A limit field: blank means NO LIMIT, `0` means "may spend nothing".
 *
 * The two are different controls and both are reachable from the form. A
 * single sentinel would collapse them, and the collapse always goes the
 * dangerous way: an operator who typed 0 meaning "stop this card" would get
 * "no limit at all".
 */
function limitFrom(raw: string | null, label: string): { ok: true; cents: bigint | null } | { ok: false; message: string } {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return { ok: true, cents: null };
  if (/^\$?\s*0+(?:[.,]0{1,2})?$/.test(trimmed)) return { ok: true, cents: 0n };
  const parsed = parseUsdAmount(trimmed);
  if (!parsed.ok) return { ok: false, message: `${label}: ${parsed.message}` };
  return { ok: true, cents: parsed.cents };
}

export async function setCardControlsAction(
  _previous: CardControlsActionResult,
  formData: FormData,
): Promise<CardControlsActionResult> {
  const cardId = String(formData.get("cardId") ?? "");
  if (!isUuid(cardId)) {
    return failed("CARD_ID_INVALID", "That is not a card on this book.", "set_controls", null);
  }

  const rawState = String(formData.get("cardState") ?? "active");
  const cardState: CardState = rawState === "frozen" ? "frozen" : "active";

  const perTxn = limitFrom(formData.get("perTxn") as string | null, "Per transaction");
  if (!perTxn.ok) return failed("LIMIT_INVALID", perTxn.message, "set_controls", cardId);
  const daily = limitFrom(formData.get("daily") as string | null, "Daily");
  if (!daily.ok) return failed("LIMIT_INVALID", daily.message, "set_controls", cardId);
  const monthly = limitFrom(formData.get("monthly") as string | null, "Monthly");
  if (!monthly.ok) return failed("LIMIT_INVALID", monthly.message, "set_controls", cardId);

  const mccs = parseMccList(String(formData.get("blockedMccs") ?? ""));
  if (!mccs.ok) return failed("MCC_INVALID", mccs.message, "set_controls", cardId);

  const note = String(formData.get("note") ?? "").trim();
  if (note === "") {
    // NOT NULL in the database, and required here for the same reason: the
    // note is the first thing read in a dispute, and a control set nobody
    // explained is a control set nobody can defend.
    return failed(
      "NOTE_REQUIRED",
      "Say why. This version is permanent and the note is the first thing read when a decline is disputed.",
      "set_controls",
      cardId,
    );
  }

  // The actor is resolved server-side from the session, never taken from the
  // form. `created_by` references `actor(id)`, so a hand-edited value could
  // only name a row that already exists — but an id posted by a browser has no
  // business being the author of an append-only record either way.
  const actor = await currentActor();
  if (actor === null) {
    // `currentActor()` returns null when no seeded human matches the role. It
    // is a refusal and not a fallback: `created_by` is NOT NULL and references
    // `actor(id)`, and an append-only record whose author is a guess is worse
    // than no record.
    return failed(
      "NO_ACTOR",
      "This session does not resolve to an actor on the book, so there is nobody to record as the author of this control version.",
      "set_controls",
      cardId,
    );
  }

  const written = await setCardControls({
    cardId,
    draft: {
      cardState,
      perTxnLimitCents: perTxn.cents,
      dailyLimitCents: daily.cents,
      monthlyLimitCents: monthly.cents,
      blockedMccs: mccs.codes,
      note,
    },
    actorId: actor.id,
  });

  if (!written.ok) return failed(written.code, written.message, "set_controls", cardId);

  revalidatePath("/accounts");

  const c = written.controls;
  return {
    status: "ok",
    intent: "set_controls",
    code: "CONTROLS_APPLIED",
    message:
      `Control version ${c.version} is in force from ${c.effectiveFrom}. ` +
      `Version ${c.version - 1} is unchanged and still says what it said — ` +
      `every decision that cited it still cites it.`,
    facts: [
      { label: "Version", value: String(c.version) },
      { label: "State", value: c.cardState },
      { label: "Per transaction", value: describeLimit(c.perTxnLimitCents) },
      { label: "Daily", value: describeLimit(c.dailyLimitCents) },
      { label: "Monthly", value: describeLimit(c.monthlyLimitCents) },
      {
        label: "Blocked MCCs",
        value: c.blockedMccs.length === 0 ? "none" : c.blockedMccs.join(", "),
        mono: true,
      },
      { label: "Author", value: actor.displayName },
    ],
    cardId,
    at: new Date().toISOString(),
  };
}

/** Cents as a decimal string, or the two words that are not amounts. */
function describeLimit(cents: bigint | null): string {
  if (cents === null) return "no limit";
  if (cents === 0n) return "$0.00 — may spend nothing";
  return `${cents.toString()} cents`;
}

/**
 * Replay one ASA-shaped authorisation through the real decision path.
 *
 * The payload shape comes from Lithic's published OpenAPI document; the
 * delivery does not come from Lithic. Both halves of that sentence are on the
 * screen beside this button and on every row it writes.
 */
export async function replayAuthorizationAction(
  _previous: CardControlsActionResult,
  formData: FormData,
): Promise<CardControlsActionResult> {
  const cardId = String(formData.get("cardId") ?? "");
  const cardToken = String(formData.get("cardToken") ?? "");
  if (cardToken === "") {
    return failed("CARD_TOKEN_MISSING", "No card token to replay against.", "replay", cardId);
  }

  const amount = parseUsdAmount(String(formData.get("amount") ?? ""));
  if (!amount.ok) return failed("AMOUNT_INVALID", amount.message, "replay", cardId);

  const rawMcc = String(formData.get("mcc") ?? "").trim();
  const mccs = parseMccList(rawMcc);
  if (!mccs.ok) return failed("MCC_INVALID", mccs.message, "replay", cardId);
  const mcc = mccs.codes[0] ?? "5542";

  const status = String(formData.get("requestStatus") ?? "AUTHORIZATION");

  // `Number(bigint)` is safe here and nowhere else in this codebase: the value
  // is going into a JSON payload, which cannot carry a bigint, and it has just
  // been range-checked against Number.MAX_SAFE_INTEGER. It becomes bigint again
  // the instant `parseAsaRequest` reads it back, and never becomes a number
  // between there and the database.
  if (amount.cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    return failed("AMOUNT_TOO_LARGE", "That amount cannot be carried in JSON.", "replay", cardId);
  }

  const result = await replayAuthorization({
    overrides: {
      cardToken,
      amountCents: Number(amount.cents),
      mcc,
      status,
      descriptor: "CORGI HARNESS REPLAY",
      token: crypto.randomUUID(),
    },
  });

  revalidatePath("/accounts");

  return {
    status: "ok",
    intent: "replay",
    code: result.verdict.result,
    message: result.verdict.reason,
    facts: [
      { label: "Outcome", value: result.verdict.outcome },
      { label: "Network result", value: result.verdict.result, mono: true },
      { label: "Rule", value: result.verdict.rule, mono: true },
      { label: "Decision latency", value: `${result.decisionLatencyUs} µs` },
      { label: "Source", value: "harness — not a provider call" },
      {
        label: "Control version",
        value:
          result.lookup.status === "read" && result.lookup.controls !== null
            ? String(result.lookup.controls.version)
            : "none",
      },
    ],
    cardId,
    at: new Date().toISOString(),
  };
}
