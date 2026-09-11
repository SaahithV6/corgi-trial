"use server";

/**
 * The customer setting the rules on their own team's cards.
 *
 * ===========================================================================
 * WHY THIS IS A CUSTOMER FEATURE AND NOT AN OPERATOR ONE
 * ===========================================================================
 *
 * A business owner deciding that the workshop card may spend $200 a day, that
 * nobody may put a gambling transaction on it, and that the card belonging to
 * somebody who has just left is frozen, is the customer doing their own job.
 * The bank's operators need to SEE what the customer set and what it decided;
 * they are not the ones who should be setting it.
 *
 * This build had that polarity backwards: every control writer lived under
 * `src/components/accounts/**` on the staff console, and `/client/cards` could
 * only read. The consequence is measurable rather than theoretical — on this
 * book, 55 of 67 provider-lane approvals were made by a rule that compared
 * nothing, because the card carried no controls at all and nobody whose card it
 * was could set any.
 *
 * ===========================================================================
 * ONE WRITER, TWO SURFACES
 * ===========================================================================
 *
 * This calls `setCardControls()` in `@/lib/cards/store` — the same function the
 * staff console's own action calls, reached through the library rather than
 * through the other screen. The version arithmetic, the append-only insert and
 * `assert_card_control_version()` all apply unchanged, because they are not
 * applied here: they are applied in the store and in the database. The operator
 * screen is untouched, and there is no second copy of the rule.
 *
 * Nothing in this file is on the authorisation path. `decide()` is not imported
 * and not reachable from here; the measured 6000 ms ASA ceiling is a property
 * of that path and this write does not sit on it.
 *
 * ===========================================================================
 * THE CARD ID IS A CLAIM, AND IT IS CHECKED AS A PREDICATE
 * ===========================================================================
 *
 * A card id arrives from a form, so it is worth exactly nothing on its own.
 * Before any write, the id is resolved against the business this surface is
 * scoped to with `WHERE c.id = $1 AND c.business_id = $2` — one statement, both
 * columns, evaluated by Postgres. It is NOT a `cards.find(...)` over a list
 * fetched first: that would make tenant isolation a step in a program, and
 * `src/app/(app)/client/live-source.ts` refuses that everywhere else on this
 * surface for the same reason.
 *
 * A card belonging to another business produces the same refusal as a card that
 * does not exist, so this form cannot be used to discover which ids are real.
 *
 * `"use server"` modules may export only async functions, so the result type
 * and its idle value live in `@/components/client/card-controls-state`.
 */

import { revalidatePath } from "next/cache";

import type {
  ClientControlResult,
  ControlFact,
} from "@/components/client/card-controls-state";
import { currentActor } from "@/lib/approvals/session";
import { parseMccList } from "@/lib/cards/mcc";
import { setCardControls } from "@/lib/cards/store";
import type { CardState } from "@/lib/cards/types";
import { formatUsd } from "@/lib/format/money";
import { sql } from "@/lib/ledger/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The same sentence for a card that is not real and a card that is not theirs.
 *
 * Telling them apart would turn this form into an oracle for which card ids
 * exist on the platform. `readApproveScreen` makes the identical choice for
 * payment references and says so at length.
 */
const NOT_YOURS =
  "That card is not on this business. The answer is the same for a card that does not exist and one belonging to another customer — telling them apart would let anybody confirm which cards are real.";

function failed(
  code: string,
  message: string,
  cardId: string | null,
  facts: readonly ControlFact[] = [],
): ClientControlResult {
  return { status: "failed", code, message, facts, cardId, at: new Date().toISOString() };
}

/**
 * A limit field, as characters.
 *
 * BLANK IS "NO LIMIT OF THIS KIND" AND `0` IS "MAY SPEND NOTHING", and the two
 * are opposite instructions. A single sentinel collapses them and the collapse
 * always goes the dangerous way: somebody typing 0 to stop a card would get a
 * card with no ceiling at all. Both are stored, and `CardsView` renders them as
 * different sentences.
 *
 * `Number` never touches the string. Dollars and cents are split as text and
 * assembled with `BigInt`, so there is no float on this path at any point.
 */
function limitCents(
  raw: FormDataEntryValue | null,
  label: string,
): { readonly ok: true; readonly cents: bigint | null } | { readonly ok: false; readonly message: string } {
  const text = typeof raw === "string" ? raw.trim().replace(/^\$/, "").replace(/,/g, "") : "";
  if (text === "") return { ok: true, cents: null };
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) {
    return {
      ok: false,
      message: `${label}: write it in dollars and cents, like 250 or 250.00. Leave it empty for no limit of this kind, or type 0 to stop the card spending anything.`,
    };
  }
  const [dollars = "0", fraction = ""] = text.split(".");
  return { ok: true, cents: BigInt(dollars) * 100n + BigInt(fraction.padEnd(2, "0")) };
}

/** The limit, as the customer will read it back. `null` and `0` differ here too. */
function limitFact(label: string, cents: bigint | null): ControlFact {
  return {
    label,
    value: cents === null ? "no limit" : cents === 0n ? "$0.00 — spends nothing" : formatUsd(cents),
  };
}

/**
 * Freeze or unfreeze one card, in one press.
 *
 * ===========================================================================
 * WHY THIS IS NOT THE RULES FORM
 * ===========================================================================
 *
 * `setClientCardControlsAction` below is the right shape for setting limits and
 * the wrong shape for stopping a card. Saving the rules form requires choosing
 * a radio, typing a reason, and submitting five other fields that are all part
 * of the version being written — so a card somebody is trying to stop RIGHT NOW
 * stays live until they have also satisfied a note field, and a typo in a limit
 * box (`LIMIT_INVALID`) refuses the freeze along with the limit. The safest
 * thing a cardholder can do was the hardest thing on the screen.
 *
 * So freezing is its own control, with its own action, and it is one press.
 *
 * WHAT IT CARRIES FORWARD. A control change is an INSERT of a COMPLETE version
 * (`setCardControls`), not a patch, so freezing has to re-state the limits that
 * are already in force or it would silently drop them. They are read in the
 * SAME statement that proves the card is this customer's, so there is no window
 * between the two and no second round trip.
 *
 * WHY THE NOTE IS WRITTEN HERE AND NOT ASKED FOR. `note` is NOT NULL and it is
 * the first thing read when a decline is disputed. Asking for it is what makes
 * the rules form slow, and a freeze does not need a reason to be defensible —
 * the record says exactly what happened and who did it, which is the whole job
 * of that column. The sentence stored is true of the only thing this action can
 * do.
 *
 * IDEMPOTENT ON PURPOSE. Pressing Freeze on an already-frozen card writes no
 * new version and says so, rather than appending v9, v10, v11 to a card nobody
 * changed. A version series is read by people; double-clicking a button must
 * not put noise in it.
 */
export async function setClientCardFrozenAction(
  _previous: ClientControlResult,
  formData: FormData,
): Promise<ClientControlResult> {
  const cardId = String(formData.get("cardId") ?? "");
  const businessId = String(formData.get("businessId") ?? "");
  if (!UUID.test(cardId) || !UUID.test(businessId)) {
    return failed("CARD_NOT_ON_THIS_BUSINESS", NOT_YOURS, null);
  }

  const freeze = String(formData.get("intent") ?? "") === "freeze";

  // One statement: the two-column predicate that decides whose card this is,
  // and the version in force, together. `LEFT JOIN LATERAL` so a card nobody
  // has ever set rules on still comes back — it can be frozen too.
  const [row] = await sql<
    {
      card_state: CardState | null;
      per_txn_limit_cents: bigint | null;
      daily_limit_cents: bigint | null;
      monthly_limit_cents: bigint | null;
      blocked_mccs: string[] | null;
    }[]
  >`
    SELECT cc.card_state,
           cc.per_txn_limit_cents,
           cc.daily_limit_cents,
           cc.monthly_limit_cents,
           cc.blocked_mccs
      FROM card c
      LEFT JOIN LATERAL (
        SELECT v.card_state,
               v.per_txn_limit_cents,
               v.daily_limit_cents,
               v.monthly_limit_cents,
               v.blocked_mccs
          FROM card_control_version v
         WHERE v.card_id = c.id
         ORDER BY v.version DESC
         LIMIT 1
      ) cc ON TRUE
     WHERE c.id = ${cardId}::uuid
       AND c.business_id = ${businessId}::uuid
     LIMIT 1
  `;
  if (row === undefined) {
    return failed("CARD_NOT_ON_THIS_BUSINESS", NOT_YOURS, null);
  }

  const alreadyFrozen = row.card_state === "frozen";
  if (alreadyFrozen === freeze) {
    return {
      status: "ok",
      code: null,
      message: freeze
        ? "This card was already frozen. Nothing changed and no new version was written — nothing is approved on it until you turn it back on."
        : "This card was already on. Nothing changed and no new version was written; payments on it are judged against the limits below.",
      facts: [],
      cardId,
      at: new Date().toISOString(),
    };
  }

  const actor = await currentActor();
  if (actor === null) {
    return failed(
      "NO_ACTOR",
      "This session does not resolve to anybody on the book, so there is nobody to record as having made this change.",
      cardId,
    );
  }

  const written = await setCardControls({
    cardId,
    draft: {
      cardState: freeze ? "frozen" : "active",
      perTxnLimitCents: row.per_txn_limit_cents,
      dailyLimitCents: row.daily_limit_cents,
      monthlyLimitCents: row.monthly_limit_cents,
      blockedMccs: row.blocked_mccs ?? [],
      note: freeze
        ? "Frozen from the customer's own card screen."
        : "Turned back on from the customer's own card screen.",
    },
    actorId: actor.id,
  });

  if (!written.ok) return failed(written.code, written.message, cardId);

  revalidatePath("/client/cards");

  const c = written.controls;
  return {
    status: "ok",
    code: null,
    message: freeze
      ? "This card is frozen. Nothing will be approved on it until you turn it back on, whatever the limits say. The card is not cancelled and the limits it had are unchanged."
      : "This card is on again. Payments are judged against the limits it already had — freezing never changed them.",
    facts: [
      { label: "Rules version", value: `v${c.version}`, mono: true },
      { label: "In force from", value: c.effectiveFrom, mono: true },
      { label: "Card", value: c.cardState === "frozen" ? "frozen" : "active" },
      limitFact("Per payment", c.perTxnLimitCents),
      limitFact("Per day", c.dailyLimitCents),
      limitFact("Per month", c.monthlyLimitCents),
    ],
    cardId,
    at: new Date().toISOString(),
  };
}

export async function setClientCardControlsAction(
  _previous: ClientControlResult,
  formData: FormData,
): Promise<ClientControlResult> {
  const cardId = String(formData.get("cardId") ?? "");
  const businessId = String(formData.get("businessId") ?? "");
  if (!UUID.test(cardId) || !UUID.test(businessId)) {
    return failed("CARD_NOT_ON_THIS_BUSINESS", NOT_YOURS, null);
  }

  // The predicate. One statement, both columns, evaluated by Postgres before
  // any row exists to be filtered — never a `.find()` over a list.
  const owned = await sql<{ id: string }[]>`
    SELECT c.id
      FROM card c
     WHERE c.id = ${cardId}::uuid
       AND c.business_id = ${businessId}::uuid
     LIMIT 1
  `;
  if (owned[0] === undefined) {
    return failed("CARD_NOT_ON_THIS_BUSINESS", NOT_YOURS, null);
  }

  const rawState = String(formData.get("cardState") ?? "active");
  const cardState: CardState = rawState === "frozen" ? "frozen" : "active";

  const perTxn = limitCents(formData.get("perTxn"), "Per payment");
  if (!perTxn.ok) return failed("LIMIT_INVALID", perTxn.message, cardId);
  const daily = limitCents(formData.get("daily"), "Per day");
  if (!daily.ok) return failed("LIMIT_INVALID", daily.message, cardId);
  const monthly = limitCents(formData.get("monthly"), "Per month");
  if (!monthly.ok) return failed("LIMIT_INVALID", monthly.message, cardId);

  const mccs = parseMccList(String(formData.get("blockedMccs") ?? ""));
  if (!mccs.ok) return failed("MCC_INVALID", mccs.message, cardId);

  const note = String(formData.get("note") ?? "").trim();
  if (note === "") {
    // NOT NULL in the database, and asked for here for the same reason the
    // console asks: the note is the first thing read when a decline is
    // disputed, and a rule nobody explained is a rule nobody can defend.
    return failed(
      "NOTE_REQUIRED",
      "Say why you are changing this. What you write is kept with the change and cannot be edited afterwards — it is the first thing anybody reads if one of these rules turns a payment down.",
      cardId,
    );
  }

  // Resolved from the session, never taken from the form. `created_by` is NOT
  // NULL and references `actor(id)`; an append-only record whose author is a
  // value a browser posted is worse than no record.
  const actor = await currentActor();
  if (actor === null) {
    return failed(
      "NO_ACTOR",
      "This session does not resolve to anybody on the book, so there is nobody to record as having made this change.",
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

  if (!written.ok) return failed(written.code, written.message, cardId);

  revalidatePath("/client/cards");

  const c = written.controls;
  return {
    status: "ok",
    code: null,
    message:
      c.cardState === "frozen"
        ? "This card is frozen. Nothing will be approved on it until you turn it back on, whatever the limits below say."
        : "The new rules are in force. Every authorisation from now on is judged against them; decisions already made keep the rules they were made under.",
    facts: [
      { label: "Rules version", value: `v${c.version}`, mono: true },
      { label: "In force from", value: c.effectiveFrom, mono: true },
      { label: "Card", value: c.cardState === "frozen" ? "frozen" : "active" },
      limitFact("Per payment", c.perTxnLimitCents),
      limitFact("Per day", c.dailyLimitCents),
      limitFact("Per month", c.monthlyLimitCents),
      {
        label: "Blocked merchant types",
        value: c.blockedMccs.length === 0 ? "none" : c.blockedMccs.join(", "),
        mono: c.blockedMccs.length > 0,
      },
    ],
    cardId,
    at: new Date().toISOString(),
  };
}
