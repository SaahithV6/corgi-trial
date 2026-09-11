/**
 * The dispute vocabulary, in the customer's words.
 *
 * Pure, and deliberately a TRANSLATION rather than a second vocabulary. Every
 * key here is an enum value from `db/migrations/0019_disputes.sql`, so a reason
 * or an event kind that the database grows and this file has not learned shows
 * up as its own raw name on screen rather than as a blank or a wrong sentence.
 *
 * The status sentences are NOT here. `DISPUTE_STATUS_MEANING` in
 * `@/lib/disputes` already says what each status means and the operator screen
 * reads out the same strings; writing a second set for the customer is how two
 * surfaces end up disagreeing about what "lost pending recovery" means.
 */

/** What the customer says went wrong. Keys are `dispute_reason` in 0019. */
const REASON_WORDS: Record<string, string> = {
  fraud: "I did not make this payment",
  goods_not_received: "I paid and nothing arrived",
  duplicate: "I was charged twice for the same thing",
  incorrect_amount: "The amount charged is wrong",
  not_as_described: "What arrived is not what was sold to me",
  credit_not_processed: "A refund I was promised never arrived",
};

export function reasonWord(reason: string): string {
  return REASON_WORDS[reason] ?? reason.replaceAll("_", " ");
}

/** One step on a case, said plainly. Keys are `dispute_event_kind` in 0019. */
const STEP_WORDS: Record<string, string> = {
  raised: "You raised this claim.",
  provisional_credit_authorized:
    "A second Corgi approver signed off on advancing the money early. It has not been paid yet.",
  provisional_credit_granted:
    "We advanced you the money while the card network decides. It is in your balance and it is " +
    "held, so it cannot be spent until the case ends — that is what makes it safe for us to " +
    "advance it at all.",
  provisional_credit_declined:
    "We decided not to advance the money early. You are made whole when the case is decided, " +
    "not before.",
  evidence_submitted: "We filed your evidence with the card network.",
  won: "The card network decided in your favour.",
  lost: "The card network decided in the merchant's favour.",
  withdrawn: "The claim was withdrawn before any money moved.",
  credit_finalized: "The credit is now final and the hold is released. The money is yours to spend.",
  credit_clawed_back:
    "The advance was taken back off your account, dated the day the network decided. The advance " +
    "still stands on the day it was made — neither entry was erased.",
  credit_written_off:
    "We lost the case and chose to absorb it rather than take the money back off you.",
};

export function stepSentence(kind: string): string {
  return STEP_WORDS[kind] ?? kind.replaceAll("_", " ");
}

/**
 * Whether a step was Corgi's decision rather than the customer's.
 *
 * Read off the actor's own `business_id` at the source — an actor with a
 * business is somebody on the customer's team, an actor without one is us.
 * This function only names the two, so the screen never has to guess.
 */
export function deciderWord(byCorgi: boolean): string {
  return byCorgi ? "Corgi" : "You";
}
