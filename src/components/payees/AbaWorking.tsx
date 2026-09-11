import { Badge, FieldLabel, Note, TableScroll, TD_CLASS, TH_CLASS } from "@/components/ui/primitives";

import type { AbaExplanation } from "@/lib/payees/explain";

/**
 * The check digit, shown as arithmetic rather than as a verdict.
 *
 * ─── WHY THE WORKING AND NOT THE ANSWER ────────────────────────────────────
 *
 * This is the only leg of payee confirmation that BLOCKS, and the only one
 * with no provider, no network and no counterparty behind it. A block that
 * says "invalid routing number" is an assertion of authority, and a person who
 * believes they typed it correctly has no way to tell whether the software is
 * right or merely fussy. The next thing they do is look for somebody who can
 * turn it off.
 *
 * A block that says
 *
 *     3(0+4+0) + 7(1+1+3) + (1+5+3) = 12 + 35 + 9 = 56
 *     56 is 6 away from a multiple of ten
 *
 * is a claim the reader can check against the letterhead in front of them, on
 * paper, in ten seconds. Then the wall is obviously arithmetic and not policy,
 * which is the whole reason this feature is allowed to have exactly one wall
 * in it. Every other finding warns.
 *
 * ─── WHAT IT REFUSES TO SHOW ───────────────────────────────────────────────
 *
 * THE NINE SINGLE-DIGIT REPAIRS. Every weight (1, 3, 7) is invertible mod 10,
 * so for every position there is exactly one digit that would repair the sum:
 * an invalid routing number always has exactly nine single-digit repairs, no
 * more and no fewer, for every invalid number that has ever existed. "Did you
 * mean one of these nine?" is the sentence "it is wrong" retyped in nine
 * parts, and its only effect is to invite a clerk to pick one. The
 * TRANSPOSITION repair is different — usually there is none, and when there is
 * one it is a specific claim about what the hand did — so that one is named
 * and the nine are not.
 *
 * ─── AND WHAT IT ADMITS ────────────────────────────────────────────────────
 *
 * On a number that PASSES, it lists the adjacent swaps of that number this
 * arithmetic could not have caught. `101500001` is `101050001` with two
 * adjacent digits swapped and it passes, because the swapped digits differ by
 * exactly five and every adjacent weight difference has gcd 2 with ten. A
 * limitation the operator can see is a limitation; one only the author knows
 * about is a trap.
 *
 * Presentational and pure. It is handed an explanation and renders it; it
 * computes nothing, so it cannot disagree with the row that gets written.
 */
export function AbaWorking({
  explanation,
  /** Named so the heading can say WHICH of a bank's two ABAs this is. */
  railLabel,
}: {
  readonly explanation: AbaExplanation;
  readonly railLabel?: string | undefined;
}) {
  if (explanation.state === "empty") {
    return (
      <p className="text-xs leading-relaxed text-muted">
        The weighted sum appears here as you type, digit by digit. Nothing is sent anywhere to
        compute it — the check digit is arithmetic, and it is the one part of this screen that
        needs no provider, no network and no counterparty.
      </p>
    );
  }

  if (explanation.state === "not_numeric" || explanation.state === "wrong_length") {
    return (
      <div className="space-y-2">
        <p className="text-xs leading-relaxed text-muted">{explanation.message}</p>
        <p className="font-mono text-sm">{explanation.typed}</p>
      </div>
    );
  }

  const { holds } = explanation;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <span className="font-mono text-base tracking-[0.2em]">{explanation.routingNumber}</span>
        <Badge tone={holds ? "neutral" : "negative"}>
          {holds ? "THE CHECK DIGIT HOLDS" : "ARITHMETICALLY IMPOSSIBLE"}
        </Badge>
        {railLabel === undefined ? null : <Badge tone="quiet">{railLabel}</Badge>}
      </div>

      <TableScroll>
        <table className="w-full border-collapse">
          <caption className="sr-only">
            Each digit, the weight its position carries, and the product
          </caption>
          <thead>
            <tr className="border-b border-border">
              <th scope="col" className={TH_CLASS}>
                position
              </th>
              {explanation.terms.map((term) => (
                <th key={term.position} scope="col" className={`${TH_CLASS} text-right`}>
                  d{term.position}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <tr>
              <th scope="row" className={`${TH_CLASS} text-left`}>
                digit
              </th>
              {explanation.terms.map((term) => (
                <td key={term.position} className={`${TD_CLASS} text-right font-mono`}>
                  {term.digit}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className={`${TH_CLASS} text-left`}>
                weight
              </th>
              {explanation.terms.map((term) => (
                <td key={term.position} className={`${TD_CLASS} text-right font-mono text-muted`}>
                  ×{term.weight}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row" className={`${TH_CLASS} text-left`}>
                product
              </th>
              {explanation.terms.map((term) => (
                <td key={term.position} className={`${TD_CLASS} text-right font-mono`}>
                  {term.product}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </TableScroll>

      <div className="space-y-1 font-mono text-xs leading-relaxed">
        <div>3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9)</div>
        <div>= {explanation.substituted}</div>
        <div>= {explanation.products}</div>
        <div className="text-sm">
          = {explanation.total}
          {holds
            ? `   ≡ 0 (mod 10)`
            : `   ≡ ${explanation.remainder} (mod 10) — ${explanation.remainder} away from a multiple of ten`}
        </div>
      </div>

      {holds ? null : (
        <Note emphasis title="No bank has this routing number">
          <p>
            The ninth digit of a routing number is <em>chosen</em> so that this sum lands on a
            multiple of ten. This one misses, which does not mean the number is unknown to us —
            it means no such number has ever been issued and none ever will be. There is no
            acknowledgement for this and nobody who can grant one; the database will not hold it
            either, because <code>payee_routing_number_possible</code> is a CHECK constraint
            rather than a rule in a service.
          </p>
          {explanation.transpositions.length > 0 ? (
            <p className="mt-2">
              <strong>Two adjacent digits look swapped.</strong> Putting positions{" "}
              {explanation.transpositions
                .map((t) => `${t.positions[0]} and ${t.positions[1]}`)
                .join(", or ")}{" "}
              back gives{" "}
              <span className="font-mono">
                {explanation.transpositions.map((t) => t.candidate).join(" or ")}
              </span>
              , which would be valid. That is the commonest slip there is — but confirm it
              against the payee&rsquo;s own paperwork rather than accepting a suggestion from us.
              Guessing which account to pay is worse than refusing.
            </p>
          ) : (
            <p className="mt-2">
              No adjacent pair of digits explains the failure, which usually means the number came
              from the wrong document rather than from a slip of the hand. Re-key it from the
              payee&rsquo;s own paperwork.
            </p>
          )}
          <p className="mt-2 text-[11px]">
            The nine single-digit repairs are deliberately not listed. Every weight here is
            invertible mod 10, so <em>every</em> invalid routing number has exactly nine of them —
            one per position, always — and offering them would be the sentence &ldquo;it is
            wrong&rdquo; retyped in nine parts.
          </p>
        </Note>
      )}

      {holds ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <FieldLabel>fed prefix</FieldLabel>
            <span className="text-xs">
              {explanation.prefixAssigned
                ? explanation.prefixDescription
                : `${explanation.prefixDescription} — outside the allocated ranges. Possible arithmetic, never-issued prefix: a fact about a registry, so it warns rather than blocks.`}
            </span>
          </div>

          {explanation.invisibleSwaps.length > 0 ? (
            <Note title="What this arithmetic could NOT have caught on this number">
              <p>
                The check digit is blind to a swap of two adjacent digits that differ by exactly
                five, because each adjacent weight difference (−4, +6, −2) shares a factor of two
                with ten. On this number that is{" "}
                {explanation.invisibleSwaps
                  .map(
                    (swap) =>
                      `positions ${swap.positions[0]}&${swap.positions[1]} (${swap.digits[0]}↔${swap.digits[1]}) — indistinguishable from ${swap.candidate}`,
                  )
                  .join("; ")}
                . It is also blind to any swap of two positions three or six apart, because the
                weight pattern repeats every three digits and those positions carry equal weights.
              </p>
              <p className="mt-2">
                Neither is a defect in this implementation — no correct implementation of the ABA
                rule does better — and neither is caught anywhere downstream. The receiving bank
                catches it, days later, as an R03 or R04 return.
              </p>
            </Note>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
