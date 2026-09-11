/**
 * The ABA routing transit number check digit.
 *
 * This is the one part of payee confirmation that genuinely catches a typo
 * with no provider, no network and no counterparty. It is arithmetic:
 *
 *     3·(d1+d4+d7) + 7·(d2+d5+d8) + 1·(d3+d6+d9)  ≡  0  (mod 10)
 *
 * A number that fails it is not "probably wrong" or "unknown to us". It is
 * impossible: no such routing number has ever been issued and none ever will
 * be, because the ninth digit is chosen to make the sum land on zero. That is
 * why a failure here is the only BLOCK this feature has, and why every other
 * finding it produces is a warning. See docs/PAYEES.md.
 *
 * ─── WHAT IT CATCHES, AND WHAT IT DOES NOT ─────────────────────────────────
 *
 * Proved exhaustively in `aba.test.ts` over the whole error space rather than
 * asserted here:
 *
 *   SINGLE WRONG DIGIT — 100% caught. All three weights (1, 3, 7) are
 *     invertible mod 10, so w·δ ≡ 0 (mod 10) forces δ ≡ 0. Every one of the
 *     81 single-digit substitutions of every valid routing number changes the
 *     checksum. There is no exception.
 *
 *   ADJACENT TRANSPOSITION (the classic mistype) — 88.9% caught. Swapping
 *     positions i and i+1 shifts the sum by (w_i − w_{i+1})·(d_{i+1} − d_i).
 *     The adjacent weight differences are −4, +6, −2 repeating; each has
 *     gcd 2 with 10, so the swap is invisible exactly when the two digits
 *     differ by 5. THE MISS IS ENTIRELY {0↔5, 1↔6, 2↔7, 3↔8, 4↔9} — ten of
 *     the ninety ordered pairs of distinct digits, at every position equally.
 *     Everything else transposed is caught.
 *
 *   TRANSPOSITION THREE OR SIX APART — 0% caught. The weight pattern repeats
 *     every three digits, so positions 1&4, 2&5, 3&6, 4&7, 5&8, 6&9, 1&7, 2&8
 *     and 3&9 carry EQUAL weights and swapping them cannot change the sum by
 *     anything. A mod-10 checksum over a repeating weight vector has this
 *     hole by construction; it is not a bug in the implementation and no
 *     implementation of the ABA rule does better.
 *
 *   TWIN SHIFT (both of two adjacent digits mistyped by the same amount) —
 *     the weight pairs summing to 10 (positions 1&2, 4&5, 7&8, weights 3 and
 *     7) are completely invisible: 3δ + 7δ = 10δ ≡ 0 for every δ.
 *
 * The honest summary: this catches the overwhelming majority of the errors a
 * human hand actually makes at a keyboard, and it says nothing whatsoever
 * about whether the number belongs to a real bank — that is `directory.ts` —
 * or about the ACCOUNT number, which carries no checksum at all in the United
 * States. docs/PAYEES.md carries that argument in full.
 *
 * ─── THIS FILE AND `aba_checksum_ok()` IN MIGRATION 0016 ───────────────────
 *
 * The same arithmetic exists twice, in TypeScript and in Postgres, which is
 * normally the exact thing DECISIONS forbids. It is deliberate here and the
 * duplication is held equal by a test rather than by hope:
 * `payees.integration.test.ts` runs a corpus through BOTH and asserts they
 * agree digit for digit. The database copy has to exist because the block is
 * a CHECK constraint — the strongest possible statement of "this cannot be
 * stored" — and the TypeScript copy has to exist because a form should say
 * why before it round-trips.
 */

/**
 * The positional weights, in order. Reading them as data rather than writing
 * three sums by hand is what makes the transposition analysis below possible
 * at all: `weightAt()` is the same function the proof uses.
 */
export const ABA_WEIGHTS: readonly number[] = [3, 7, 1, 3, 7, 1, 3, 7, 1];

export const ABA_LENGTH = 9;

/** The weight applied to a 1-based digit position. */
export function abaWeight(position1Based: number): number {
  const w = ABA_WEIGHTS[position1Based - 1];
  if (w === undefined) {
    throw new RangeError(`routing number position ${position1Based} is not 1..${ABA_LENGTH}`);
  }
  return w;
}

const NINE_DIGITS = /^[0-9]{9}$/;

/**
 * Why a routing number is not a routing number.
 *
 * Separate codes for separate facts, because "you typed eight digits" and
 * "the ninth digit is wrong" are different messages to a human and only one
 * of them is interesting.
 */
export type AbaFormatProblem =
  | "EMPTY"
  | "NOT_NINE_DIGITS"
  | "NON_NUMERIC"
  | "CHECKSUM_FAILED";

export type AbaVerdict =
  | {
      readonly valid: true;
      /** The nine digits, whitespace and separators removed. */
      readonly routingNumber: string;
      /**
       * The weighted sum. Zero mod ten, by definition of `valid`. Surfaced
       * because a screen that shows the arithmetic is a screen somebody can
       * check against a printout.
       */
      readonly weightedSum: number;
      /**
       * Whether the first two digits fall in an allocated Federal Reserve
       * prefix range. FALSE IS NOT A BLOCK — see `abaPrefixAssigned`.
       */
      readonly prefixAssigned: boolean;
      /** e.g. "Federal Reserve district 11 (Dallas)" — for the screen. */
      readonly prefixDescription: string;
    }
  | {
      readonly valid: false;
      readonly problem: AbaFormatProblem;
      readonly message: string;
      /** What the digits normalised to, when they normalised to anything. */
      readonly routingNumber: string | null;
      /** Present only for CHECKSUM_FAILED, where the sum is the evidence. */
      readonly weightedSum: number | null;
    };

/**
 * Strip the separators a human types and nothing else.
 *
 * Spaces and hyphens go, because routing numbers are printed on cheques in
 * groups and pasted from PDFs with them. Anything else — a letter, a stray
 * digit, a unicode digit from another script — is left in place so the
 * verdict can say NON_NUMERIC rather than quietly deleting the evidence and
 * reporting a length problem.
 */
export function normaliseRoutingNumber(input: string): string {
  return input.replace(/[\s-]/g, "");
}

/** The weighted sum. Assumes nine ASCII digits; `checkRoutingNumber` gates it. */
function weightedSum(rn: string): number {
  let total = 0;
  for (let i = 0; i < ABA_LENGTH; i += 1) {
    // `rn` is known to be nine digits here, but `noUncheckedIndexedAccess`
    // is on and a silent NaN in a checksum is exactly the class of bug this
    // module exists to prevent, so the narrowing is real.
    const ch = rn[i];
    if (ch === undefined) throw new RangeError("routing number is shorter than nine digits");
    total += abaWeight(i + 1) * (ch.charCodeAt(0) - 48);
  }
  return total;
}

/**
 * Whether the ABA check digit is satisfied. The whole feature in one line.
 *
 * Returns false — never throws — for anything that is not nine digits, so a
 * caller can use it as a predicate without pre-validating. `checkRoutingNumber`
 * is the version that says WHY.
 */
export function abaChecksumOk(input: string): boolean {
  const rn = normaliseRoutingNumber(input);
  if (!NINE_DIGITS.test(rn)) return false;
  return weightedSum(rn) % 10 === 0;
}

/**
 * The Federal Reserve prefix allocation.
 *
 *   00       US Government
 *   01–12    Federal Reserve districts, primary
 *   21–32    thrift institutions (district + 20)
 *   61–72    electronic transaction identifiers (district + 60)
 *   80       traveler's cheques
 *
 * 13–20, 33–60, 73–79 and 81–99 have never been allocated.
 *
 * THIS IS A REGISTRY FACT, NOT AN ARITHMETIC ONE, and the difference is the
 * whole of this feature's block/warn line. A prefix outside these ranges is
 * not impossible the way a failed checksum is impossible — it is unissued
 * under an allocation scheme that a registrar maintains and could extend. So
 * it produces a loud warning and never a block. docs/PAYEES.md argues it.
 */
export function abaPrefixAssigned(rn: string): boolean {
  if (!NINE_DIGITS.test(rn)) return false;
  const prefix = Number(rn.slice(0, 2));
  return (
    (prefix >= 0 && prefix <= 12) ||
    (prefix >= 21 && prefix <= 32) ||
    (prefix >= 61 && prefix <= 72) ||
    prefix === 80
  );
}

/** The twelve Federal Reserve districts, for a screen that says where a bank sits. */
const FED_DISTRICT: readonly string[] = [
  "Boston",
  "New York",
  "Philadelphia",
  "Cleveland",
  "Richmond",
  "Atlanta",
  "Chicago",
  "St. Louis",
  "Minneapolis",
  "Kansas City",
  "Dallas",
  "San Francisco",
];

/**
 * A human sentence for the first two digits.
 *
 * Not a validation result — purely the label a screen puts next to the
 * digits so an operator can sanity-check "this supplier banks in Texas"
 * against "district 11 (Dallas)".
 */
export function describeAbaPrefix(rn: string): string {
  if (!NINE_DIGITS.test(rn)) return "not a routing number";
  const prefix = Number(rn.slice(0, 2));
  if (prefix === 0) return "US Government";
  if (prefix === 80) return "traveler's cheques";
  const district = ((): number | null => {
    if (prefix >= 1 && prefix <= 12) return prefix;
    if (prefix >= 21 && prefix <= 32) return prefix - 20;
    if (prefix >= 61 && prefix <= 72) return prefix - 60;
    return null;
  })();
  if (district === null) return `prefix ${rn.slice(0, 2)} is not an allocated range`;
  const name = FED_DISTRICT[district - 1] ?? "unknown";
  const kind =
    prefix <= 12 ? "primary" : prefix <= 32 ? "thrift" : "electronic transaction identifier";
  return `Federal Reserve district ${district} (${name}), ${kind}`;
}

/**
 * The full verdict, with a reason a person can act on.
 *
 * Deliberately a discriminated union rather than `{ ok, error? }`: the caller
 * that wants `weightedSum` should not be able to read it off a failure that
 * never computed one.
 */
export function checkRoutingNumber(input: string): AbaVerdict {
  const rn = normaliseRoutingNumber(input);

  if (rn.length === 0) {
    return {
      valid: false,
      problem: "EMPTY",
      message: "A routing number is required.",
      routingNumber: null,
      weightedSum: null,
    };
  }
  if (!/^[0-9]+$/.test(rn)) {
    return {
      valid: false,
      problem: "NON_NUMERIC",
      message: "A routing number is nine digits. This contains something that is not a digit.",
      routingNumber: rn,
      weightedSum: null,
    };
  }
  if (rn.length !== ABA_LENGTH) {
    return {
      valid: false,
      problem: "NOT_NINE_DIGITS",
      message: `A routing number is nine digits. This has ${rn.length}.`,
      routingNumber: rn,
      weightedSum: null,
    };
  }

  const sum = weightedSum(rn);
  if (sum % 10 !== 0) {
    return {
      valid: false,
      problem: "CHECKSUM_FAILED",
      // The arithmetic is in the message on purpose. "Invalid routing number"
      // teaches a person nothing and reads like the software being fussy;
      // showing that the weighted sum missed zero by n is a claim they can
      // check, and it is what makes the block obviously not a policy choice.
      message:
        `The check digit does not hold: 3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) = ${sum}, ` +
        `which is ${sum % 10} away from a multiple of ten. No bank has this routing number.`,
      routingNumber: rn,
      weightedSum: sum,
    };
  }

  return {
    valid: true,
    routingNumber: rn,
    weightedSum: sum,
    prefixAssigned: abaPrefixAssigned(rn),
    prefixDescription: describeAbaPrefix(rn),
  };
}

/* -------------------------------------------------------------------------- */
/* Telling a person WHICH typo they probably made                             */
/* -------------------------------------------------------------------------- */

/**
 * One edit that would turn an invalid routing number into a valid one.
 *
 * This is not a correction and nothing may apply it automatically — a system
 * that guesses which account to pay is a worse system than one that refuses.
 *
 * ─── THE TWO KINDS ARE WORTH VERY DIFFERENT AMOUNTS ────────────────────────
 *
 * A SUBSTITUTION NEAR MISS IS WORTHLESS AS A SUGGESTION, and the arithmetic
 * says why: all three weights are coprime to 10, so for EVERY position there
 * is EXACTLY ONE digit that would repair the checksum. An invalid routing
 * number therefore always has exactly nine single-digit repairs — one per
 * position, no more and no fewer, for every invalid number that has ever
 * existed. "Did you mean one of these nine?" is not a hint; it is a
 * restatement of the fact that the number is wrong. `abaNearMisses` returns
 * them because the count is a useful thing to assert in a test, and
 * `verify.ts` does not show them to anybody.
 *
 * A TRANSPOSITION NEAR MISS IS DIAGNOSTIC. Usually there are none; when
 * there is one, it says "you swapped these two adjacent digits", which is
 * the commonest hand slip there is and is a specific, checkable claim about
 * what went wrong. That one is worth showing.
 *
 * Transpositions are therefore listed first, and `verify.ts` shows only
 * those.
 */
export type AbaNearMiss =
  | { readonly kind: "transposition"; readonly positions: readonly [number, number]; readonly candidate: string }
  | { readonly kind: "substitution"; readonly position: number; readonly candidate: string };

/**
 * Every single-edit repair of an invalid routing number.
 *
 * Adjacent transpositions first, then single-digit substitutions, because a
 * transposition is the likelier hand slip and a screen that lists the likely
 * cause first is a screen people read. Capped by the caller, not here.
 */
export function abaNearMisses(input: string): readonly AbaNearMiss[] {
  const rn = normaliseRoutingNumber(input);
  if (!NINE_DIGITS.test(rn) || abaChecksumOk(rn)) return [];

  const out: AbaNearMiss[] = [];
  const digits = rn.split("");

  for (let i = 0; i < ABA_LENGTH - 1; i += 1) {
    const a = digits[i];
    const b = digits[i + 1];
    if (a === undefined || b === undefined || a === b) continue;
    const swapped = [...digits];
    swapped[i] = b;
    swapped[i + 1] = a;
    const candidate = swapped.join("");
    if (abaChecksumOk(candidate)) {
      out.push({ kind: "transposition", positions: [i + 1, i + 2], candidate });
    }
  }

  for (let i = 0; i < ABA_LENGTH; i += 1) {
    const original = digits[i];
    if (original === undefined) continue;
    for (let v = 0; v <= 9; v += 1) {
      const replacement = String(v);
      if (replacement === original) continue;
      const edited = [...digits];
      edited[i] = replacement;
      const candidate = edited.join("");
      if (abaChecksumOk(candidate)) {
        out.push({ kind: "substitution", position: i + 1, candidate });
      }
    }
  }

  return out;
}

/**
 * Whether swapping two positions of a VALID routing number would be caught.
 *
 * Exported because it is the honest limit of the feature and the screen says
 * it out loud on the payee whose digits happen to sit in the blind spot:
 * "the check digit cannot distinguish this number from 011401533 — the two
 * digits you swapped differ by five." A limitation a user can see is a
 * limitation; one only the author knows about is a trap.
 *
 * `false` means the swap is INVISIBLE to the checksum.
 */
export function transpositionIsDetectable(
  rn: string,
  posA1Based: number,
  posB1Based: number,
): boolean {
  const a = rn[posA1Based - 1];
  const b = rn[posB1Based - 1];
  if (a === undefined || b === undefined) return false;
  const digitA = a.charCodeAt(0) - 48;
  const digitB = b.charCodeAt(0) - 48;
  if (digitA === digitB) return false; // swapping equal digits is not an error
  const shift = (abaWeight(posA1Based) - abaWeight(posB1Based)) * (digitB - digitA);
  return ((shift % 10) + 10) % 10 !== 0;
}
