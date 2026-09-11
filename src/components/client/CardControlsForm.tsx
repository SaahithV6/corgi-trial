"use client";

import { useActionState, useId } from "react";

import {
  setClientCardControlsAction,
  setClientCardFrozenAction,
} from "@/app/(app)/client/cards-actions";
import { FOCUS_RING, Note } from "@/components/ui/primitives";
import { MCC_GROUPS } from "@/lib/cards/mcc";

import {
  CLIENT_CONTROL_IDLE,
  type ClientControlResult,
} from "./card-controls-state";

/**
 * The customer's own controls on one card.
 *
 * ===========================================================================
 * THE FORM OPENS PRE-FILLED WITH WHAT IS IN FORCE
 * ===========================================================================
 *
 * Saving writes a COMPLETE new version — the store appends a row carrying every
 * field, it does not patch the previous one. A form that opened blank would
 * therefore invite somebody to save a version that silently dropped every limit
 * they did not retype. So every field arrives filled with the current value and
 * the panel says what saving does.
 *
 * ===========================================================================
 * NO NUMBERS ON THIS COMPONENT'S PROPS
 * ===========================================================================
 *
 * Limits arrive as strings the server already formatted, and they leave as the
 * literal characters somebody typed. There is no arithmetic in this file and no
 * `Number(...)` anywhere in it; dollars become `bigint` cents inside the action,
 * by splitting text. This is a client component, so a `bigint` could not cross
 * the boundary even if one wanted it to.
 *
 * ===========================================================================
 * THE BUTTON IS NOT DISABLED BY ANYTHING THIS SCREEN BELIEVES
 * ===========================================================================
 *
 * Whether this card is theirs is decided by a `WHERE c.id = $1 AND
 * c.business_id = $2` inside the action, and whether the version number is
 * still free is decided by `assert_card_control_version()` in the database.
 * Pressing save shows the refusal from the place that actually refuses, which
 * is worth more than a greyed-out control that demonstrates nothing.
 *
 * FREEZING IS NOT A LIMIT AND IS SAID SEPARATELY. A frozen card declines every
 * authorisation whatever the limits say, so it is its own control with its own
 * sentence rather than a limit of zero — `0` means "may spend nothing" and
 * `null` means "no limit of this kind", and collapsing any of the three is how
 * a card ends up spending when somebody meant to stop it.
 */

const INPUT = `mt-1 w-full rounded border border-border-strong bg-surface px-2.5 py-2 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

function Receipt({ result }: { readonly result: ClientControlResult }) {
  if (result.status === "idle") return null;
  return (
    <Note emphasis={result.status === "failed"} title={result.code ?? "Saved"}>
      <p>{result.message}</p>
      {result.facts.length === 0 ? null : (
        <dl className="mt-2 flex flex-col gap-1">
          {result.facts.map((fact) => (
            <div key={fact.label} className="flex flex-wrap items-baseline gap-2">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">
                {fact.label}
              </dt>
              <dd
                className={
                  fact.mono === true
                    ? "font-mono text-[11px] text-text"
                    : "text-[11px] text-text"
                }
              >
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Note>
  );
}

/**
 * Freeze, in one press.
 *
 * The rules form below can also freeze a card, and it is the wrong place to do
 * it from: it needs a radio, a reason, and five other fields that are all part
 * of the version it writes, so a bad character in a limit box refuses the
 * freeze along with the limit. Stopping a card is the safest thing a cardholder
 * can do and it was the slowest control on the screen.
 *
 * This is deliberately NOT behind a confirmation. Freezing is reversible by the
 * button that replaces it, costs nothing if it was a mistake, and a card being
 * used by somebody who should not have it is measured in seconds. The
 * irreversible direction is the other one — but turning a card back on only
 * restores the limits it already had, so it is not destructive either, and a
 * dialog in front of it would train people to click through dialogs.
 *
 * The receipt is the action's own sentence, printed where the button is, so the
 * page does not have to be re-read to know whether the press landed.
 */
export function FreezeCardButton({
  cardId,
  businessId,
  frozen,
  cardLabel,
}: {
  readonly cardId: string;
  readonly businessId: string;
  readonly frozen: boolean;
  readonly cardLabel: string;
}) {
  const [result, action, pending] = useActionState(
    setClientCardFrozenAction,
    CLIENT_CONTROL_IDLE,
  );
  const mine = result.cardId === null || result.cardId === cardId;

  return (
    <form action={action} className="mt-3 flex flex-col items-start gap-1.5">
      <input type="hidden" name="cardId" value={cardId} />
      <input type="hidden" name="businessId" value={businessId} />
      <input type="hidden" name="intent" value={frozen ? "unfreeze" : "freeze"} />
      <button
        type="submit"
        disabled={pending}
        aria-label={
          frozen ? `Turn ${cardLabel} back on` : `Freeze ${cardLabel} now`
        }
        className={`rounded border border-border-strong px-3 py-1.5 text-xs font-medium ${FOCUS_RING} disabled:opacity-60 ${
          frozen ? "bg-surface" : "text-negative"
        }`}
      >
        {pending
          ? frozen
            ? "Turning it on…"
            : "Freezing…"
          : frozen
            ? "Turn this card back on"
            : "Freeze this card"}
      </button>
      <span className="max-w-prose text-[11px] leading-relaxed text-muted">
        {frozen
          ? "It keeps the limits it already had."
          : "Stops every payment on it at once. Reversible here; the limits are untouched."}
      </span>
      {mine && result.status !== "idle" ? (
        <div className="w-full max-w-prose">
          <Note emphasis={result.status === "failed"} title={result.code ?? "Done"}>
            <p>{result.message}</p>
          </Note>
        </div>
      ) : null}
    </form>
  );
}

export type CardControlsDefaults = {
  readonly cardId: string;
  readonly businessId: string;
  /** `""` for "no limit of this kind", `"0.00"` for "may spend nothing". */
  readonly perTxn: string;
  readonly daily: string;
  readonly monthly: string;
  readonly blockedMccs: string;
  readonly frozen: boolean;
  /** True when nobody has ever set a control version on this card. */
  readonly ungoverned: boolean;
};

export function CardControlsForm({
  defaults,
  cardLabel,
}: {
  readonly defaults: CardControlsDefaults;
  readonly cardLabel: string;
}) {
  const [result, action, pending] = useActionState(
    setClientCardControlsAction,
    CLIENT_CONTROL_IDLE,
  );
  const ids = useId();

  // The receipt belongs to the card that produced it. Without this a refusal
  // raised on one card would print under every card on the page.
  const mine = result.cardId === null || result.cardId === defaults.cardId;

  return (
    <form action={action} className="mt-4 space-y-4 border-t border-border pt-4">
      <input type="hidden" name="cardId" value={defaults.cardId} />
      {/* A claim, not a permission: the action re-resolves both ids together
          against `card` before it writes anything. */}
      <input type="hidden" name="businessId" value={defaults.businessId} />

      <div>
        <p className="text-sm font-medium">Set the rules on this card</p>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
          Saving records a complete new set of rules for {cardLabel} and keeps
          the old one. Every box below is part of it, so change what you mean to
          change and leave the rest as it stands.
          {defaults.ungoverned
            ? " Nothing has ever been set on this card, so today every payment on it is approved without any rule being compared."
            : ""}
        </p>
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className={LABEL}>Is the card usable</legend>
        <label className="flex items-baseline gap-2 text-sm">
          <input
            type="radio"
            name="cardState"
            value="active"
            defaultChecked={!defaults.frozen}
          />
          <span>
            On
            <span className="ml-1 text-xs text-muted">
              — payments are judged against the limits below.
            </span>
          </span>
        </label>
        <label className="flex items-baseline gap-2 text-sm">
          <input
            type="radio"
            name="cardState"
            value="frozen"
            defaultChecked={defaults.frozen}
          />
          <span>
            Frozen
            <span className="ml-1 text-xs text-muted">
              — nothing is approved on it at all, whatever the limits say. The
              card is not cancelled and you can turn it back on here.
            </span>
          </span>
        </label>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className={LABEL}>Most in one payment</span>
          <input
            name="perTxn"
            inputMode="decimal"
            defaultValue={defaults.perTxn}
            placeholder="no limit"
            className={`money ${INPUT}`}
          />
        </label>
        <label className="block">
          <span className={LABEL}>Most in a day</span>
          <input
            name="daily"
            inputMode="decimal"
            defaultValue={defaults.daily}
            placeholder="no limit"
            className={`money ${INPUT}`}
          />
        </label>
        <label className="block">
          <span className={LABEL}>Most in a month</span>
          <input
            name="monthly"
            inputMode="decimal"
            defaultValue={defaults.monthly}
            placeholder="no limit"
            className={`money ${INPUT}`}
          />
        </label>
      </div>
      <p className="max-w-prose text-xs leading-relaxed text-muted">
        In dollars and cents. Leave a box empty for no limit of that kind. Type{" "}
        <code>0</code> and that card spends nothing — which is a different
        instruction from leaving it empty, and both are kept.
      </p>

      <label className="block">
        <span className={LABEL}>Merchant types this card cannot be used at</span>
        <input
          name="blockedMccs"
          defaultValue={defaults.blockedMccs}
          placeholder="7995, 5813"
          aria-describedby={`${ids}-mcc`}
          className={INPUT}
        />
        <span id={`${ids}-mcc`} className="mt-1 block max-w-prose text-xs leading-relaxed text-muted">
          Four-digit merchant category codes, separated by commas. Common ones:{" "}
          {MCC_GROUPS.map((group) => `${group.label} (${group.codes.join(", ")})`).join(
            " · ",
          )}
          . The category is the one the merchant&rsquo;s own bank puts on the
          payment, so it describes the shop rather than what was bought.
        </span>
      </label>

      <label className="block">
        <span className={LABEL}>Why are you changing this</span>
        <input
          name="note"
          placeholder="Sam left the team; workshop card capped for the new starter"
          className={INPUT}
        />
        <span className="mt-1 block max-w-prose text-xs leading-relaxed text-muted">
          Kept with the change and never edited afterwards. If one of these
          rules turns a payment down, this is the first thing anybody reads.
        </span>
      </label>

      <button
        type="submit"
        disabled={pending}
        className={`rounded border border-border-strong bg-surface-raised px-4 py-2 text-sm font-medium ${FOCUS_RING} disabled:opacity-60`}
      >
        {pending ? "Saving…" : "Save these rules"}
      </button>

      {mine ? <Receipt result={result} /> : null}
    </form>
  );
}
