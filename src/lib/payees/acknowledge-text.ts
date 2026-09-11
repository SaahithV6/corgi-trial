/**
 * The sentence a signature becomes — the pure half, so the form can show it.
 *
 * ─── WHY THIS IS SPLIT OUT OF `acknowledge.ts` ─────────────────────────────
 *
 * `acknowledge.ts` imports `server-only`, because it re-reads the check from
 * Postgres before anything is written. This file has no I/O and no clock, so
 * the browser can call it — and it has to, because the form shows the operator
 * EXACTLY what will be stored before they store it.
 *
 * That preview is not a nicety. The stored reason is composed: the operator's
 * own words, then the findings it answers, by code and by title. Composing a
 * sentence on somebody's behalf and then putting their name to it is only
 * acceptable if they read it first — otherwise the signature says something
 * the signer never saw.
 *
 * One function, called in both places, so the preview and the row cannot
 * differ. The server does not trust the preview: it recomposes from the
 * findings it read out of `payee_verification`, and the form's copy of them is
 * a claim it re-checks. They agree because it is the same fold over the same
 * list, not because the browser was believed.
 */

/**
 * The minimum a sentence has to be before it is a sentence.
 *
 * Twelve characters. Not a serious barrier and not meant to be one — it stops
 * "ok", "fine" and "." without pretending that a length threshold can tell a
 * considered reason from a padded one. What makes the reason worth anything is
 * that it is permanent and attributed, not that it is long.
 */
export const REASON_MIN_LENGTH = 12;

export type AcknowledgedFinding = {
  readonly code: string;
  readonly title: string;
};

/**
 * The stored `reason`, composed.
 *
 * The operator's own words come FIRST, because they are the part a later
 * reader is trying to find. The enumeration follows, because it is the part
 * that says what the words were about — and without it the row reads
 *
 *     Priya Raman · 2026-09-11 · "Checked with the supplier, this is fine."
 *
 * which cannot tell you whether Priya was waving through a name that did not
 * match or a beneficiary at a bank nobody had confirmed for them. Those are
 * different acts, and only one of them is the shape of a redirected invoice.
 */
export function composeAcknowledgement(
  reason: string,
  findings: readonly AcknowledgedFinding[],
): string {
  const named = findings.map((finding) => `${finding.code} ("${finding.title}")`).join("; ");
  const count = findings.length === 1 ? "1 finding" : `${findings.length} findings`;
  return `${reason.trim()} — signed for ${count} on this check: ${named}.`;
}
