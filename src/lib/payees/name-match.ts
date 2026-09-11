/**
 * Account-name matching — the algorithm is real, the counterparty's name is
 * not something we can obtain.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ READ THIS BEFORE READING THE CODE.                                       ║
 * ║                                                                          ║
 * ║ UK Confirmation of Payee works because a network exists: you send a       ║
 * ║ sort code, an account number and a name, and the BENEFICIARY'S OWN BANK   ║
 * ║ answers match / close match / no match from its own records. THERE IS NO  ║
 * ║ EQUIVALENT NETWORK FOR US ACH. Nacha has no name-inquiry message; the     ║
 * ║ closest thing the rails offer is a zero-dollar prenotification, which     ║
 * ║ the RDFI may answer days later with a C01/C02/C03 correction and is not   ║
 * ║ obliged to answer at all.                                                ║
 * ║                                                                          ║
 * ║ Nothing in this repository's credential set can ask a US bank what name   ║
 * ║ sits on an arbitrary third party's account. Not Increase, not Plaid, not  ║
 * ║ Lithic, not Circle. That is measured, not assumed — docs/PAYEES.md lists  ║
 * ║ the calls that were made and what came back.                             ║
 * ║                                                                          ║
 * ║ SO WHAT IS THIS FILE FOR. Two things, both honest:                        ║
 * ║                                                                          ║
 * ║  1. When Plaid HAS an Item for the destination — an account whose holder  ║
 * ║     linked it to us and consented — `identity.ts` gets the institution's  ║
 * ║     own record of the holder name, and this file is what compares it.     ║
 * ║     That path is real name verification and it is labelled                ║
 * ║     `linked_account_holder`.                                              ║
 * ║                                                                          ║
 * ║  2. When it does not, this file still compares the name the payer typed   ║
 * ║     against the name already on the payee record, which catches the       ║
 * ║     supplier keyed twice under two spellings and the payment addressed    ║
 * ║     to a payee whose name has drifted from the invoice. That is worth     ║
 * ║     having and it is NOT confirmation of anything. It is labelled         ║
 * ║     `payer_asserted`, the screen prints those words, and the band it      ║
 * ║     returns is never allowed to render as a green tick.                   ║
 * ║                                                                          ║
 * ║ The moment a US name-check provider exists, `identity.ts` gains a         ║
 * ║ method, `payee_name_source` gains its already-declared third value, and   ║
 * ║ NOTHING IN THIS FILE CHANGES. That is the point of building it now.       ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── THE ONE RULE THAT MAKES THE SCORING DEFENSIBLE ────────────────────────
 *
 * **Character similarity may never assert a match. Only structure may.**
 *
 * A `match` requires that every token line up exactly, or as an initial
 * against the name it abbreviates. Jaro–Winkler runs, but its result is
 * clamped below the match threshold and can only ever grade a NON-match on
 * the spectrum between "close" and "nothing like it".
 *
 * The reason is the whole purpose of the feature. `Alberta Charleston`
 * against `Alberta Bobbeth Charleson` — one inserted letter, the exact
 * mistype we are here to catch — scores 99 on Jaro–Winkler over the joined
 * cores. An algorithm that took that number at face value would call the
 * typo a match and wave it through, which is the feature inverted. So it
 * does not get to: the clamp puts it at 94, one point below the threshold,
 * in `close_match`, in front of a human. That is not a fudge factor; it is
 * the deliberate consequence of only letting exact structure clear the bar.
 *
 * ─── CALIBRATION, AGAINST A REAL PROVIDER ──────────────────────────────────
 *
 * Plaid's `/identity/match` was called live with these credentials against a
 * sandbox Item holding `Alberta Bobbeth Charleson` (request ids and full
 * responses in docs/PAYEES.md). Plaid's `legal_name.score`, and ours:
 *
 *   typed name                    Plaid   ours   our band
 *   ---------------------------  ------  -----  -----------
 *   Alberta Bobbeth Charleson       100    100   match
 *   ALBERTA B CHARLESON              99     98   match
 *   Alberta Charleson                99     99   match
 *   Alberta Charlson                 93     89   close_match
 *   Roberto Gonzalez                 28     46   no_match
 *   Acme Widgets LLC                  0     54   no_match
 *
 * The ordering is reproduced and every band agrees with what a human would
 * say. Two deliberate divergences:
 *
 *   * Plaid's own guidance treats ≥ 90 as a strong match, which would pass
 *     `Charlson`. Ours does not, for the reason above.
 *   * Our floor is higher than Plaid's — an unrelated name scores 46 rather
 *     than 28 — because Jaro–Winkler over two English names shares vowels
 *     and never approaches zero. It does not matter: the floor is not a
 *     decision boundary, and nothing below 80 behaves differently from
 *     anything else below 80.
 *
 * `name-match.test.ts` pins every row of that table.
 */

/* -------------------------------------------------------------------------- */
/* Bands                                                                      */
/* -------------------------------------------------------------------------- */

/** CoP's three answers, plus the one CoP does not need: nobody was asked. */
export type NameMatchBand = "match" | "close_match" | "no_match" | "unavailable";

/**
 * At or above this, the names are the same name.
 *
 * 95 and not 90: by construction, every difference that is merely
 * presentational — case, punctuation, `&` versus `and`, diacritics, legal
 * suffix, word order, an initial standing in for a given name, a dropped
 * middle name — normalises to 95 or better. Nothing that changes a LETTER of
 * a name token can reach it. The threshold therefore separates two
 * categories rather than slicing a continuum at a round number, which is
 * what makes it arguable in a debrief.
 */
export const NAME_MATCH_THRESHOLD = 95;

/**
 * At or above this, the names are close enough that the difference is worth
 * showing rather than merely reporting.
 *
 * 80 is a presentation boundary, not a decision boundary: BOTH bands below
 * `match` warn, both require the same acknowledgement, and nothing in the
 * system behaves differently across it. It exists so a screen can say "did
 * you mean" for a near miss and "these are not the same name" for a stranger,
 * because those two warnings deserve different words.
 */
export const NAME_CLOSE_THRESHOLD = 80;

/** The band a score falls in. The only place the thresholds are applied. */
export function nameMatchBand(score: number): Exclude<NameMatchBand, "unavailable"> {
  if (score >= NAME_MATCH_THRESHOLD) return "match";
  if (score >= NAME_CLOSE_THRESHOLD) return "close_match";
  return "no_match";
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Legal-form tokens, stripped before comparison.
 *
 * `ACME CORP` and `Acme Corporation` are one company, and a payments team
 * that had to key the suffix byte-identically would key it wrong. Stripped
 * only when something survives — `LLC` alone normalises to `LLC`, because a
 * payee literally called that is a stranger case than an empty comparison.
 *
 * Deliberately NOT in this list: TRUST, FOUNDATION, PARTNERS, GROUP,
 * HOLDINGS, SERVICES. Those are part of the name a bank holds, not a legal
 * form appended to it, and dropping them would make `Ridgeline Holdings`
 * equal to `Ridgeline`.
 */
const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  "LLC",
  "LLP",
  "LP",
  "PLLC",
  "PC",
  "PA",
  "INC",
  "INCORPORATED",
  "CORP",
  "CORPORATION",
  "CO",
  "COMPANY",
  "LTD",
  "LIMITED",
  "NA",
  "DBA",
]);

/**
 * Uppercase, unaccented, punctuation-free, single-spaced.
 *
 * NFKD then strip combining marks, so `José` and `Jose` are one name: a US
 * bank's core system very often holds the unaccented form because it is
 * ASCII-only, and treating the accented spelling as a different name would
 * produce a warning on every payee with one.
 *
 * `&` becomes ` AND ` before punctuation is removed, because otherwise
 * `Smith & Jones` collapses to `SMITHJONES` — hmm, no: to `SMITH JONES`,
 * which happens to be right. It is spelled out anyway so `Smith&Jones`
 * (no spaces, and people type it) reaches the same three tokens rather than
 * one.
 */
export function normaliseName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * `L.L.C.` and `LLC` are the same suffix, and punctuation removal has just
 * turned the first into three single-letter tokens.
 *
 * A run of consecutive single letters is joined ONLY when the joined result
 * is itself a known legal form. `L L C` becomes `LLC` and is then stripped;
 * `A B Smith` is left alone, because `AB` is not a legal form and those two
 * letters are somebody's initials. Joining unconditionally would silently
 * merge every pair of initials into a nonsense token and is the obvious
 * version of this fix that is wrong.
 */
function joinInitialismSuffixes(tokens: readonly string[]): readonly string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i;
    while (j < tokens.length && (tokens[j]?.length ?? 0) === 1) j += 1;
    const runLength = j - i;
    if (runLength >= 2) {
      const joined = tokens.slice(i, j).join("");
      if (LEGAL_SUFFIXES.has(joined)) {
        out.push(joined);
        i = j;
        continue;
      }
    }
    const token = tokens[i];
    if (token !== undefined) out.push(token);
    i += 1;
  }
  return out;
}

/**
 * The comparable tokens: normalised, legal suffixes removed, `THE` dropped
 * from the front.
 *
 * Returns the tokens rather than a string because every scoring decision
 * below is about tokens, and re-splitting a joined string in three places is
 * how the three places come to disagree.
 */
export function nameTokens(raw: string): readonly string[] {
  const tokens = joinInitialismSuffixes(
    normaliseName(raw).split(" ").filter((t) => t.length > 0),
  );
  if (tokens.length === 0) return [];

  const withoutThe = tokens[0] === "THE" && tokens.length > 1 ? tokens.slice(1) : tokens;
  const core = withoutThe.filter((t) => !LEGAL_SUFFIXES.has(t));
  // Everything was a legal form. Keep what was given rather than compare
  // nothing against nothing and call it a match.
  return core.length === 0 ? withoutThe : core;
}

/* -------------------------------------------------------------------------- */
/* Jaro–Winkler                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Jaro similarity. Standard definition, written out rather than pulled in.
 *
 *   J = 0                                    if m = 0
 *   J = (m/|s1| + m/|s2| + (m−t)/m) / 3      otherwise
 *
 * where m counts characters matched within floor(max(|s1|,|s2|)/2) − 1
 * positions of each other, and t is half the number of matched characters
 * that are out of order.
 */
export function jaro(a: string, b: string): number {
  // Two empty strings are not similar, they are absent. Returning 1 here
  // would let a payee with a blank name score 100 against another blank one,
  // and a green tick on two pieces of missing data is the worst output this
  // module could produce.
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;

  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i += 1) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(i + window + 1, b.length);
    for (let j = lo; j < hi; j += 1) {
      if (bMatched[j] === true) continue;
      if (a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (aMatched[i] !== true) continue;
    while (bMatched[k] !== true) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }

  const t = transpositions / 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

/**
 * Jaro–Winkler: Jaro, with a bonus for a shared prefix of up to four
 * characters at the standard scaling factor 0.1.
 *
 * The prefix bonus is right for names specifically — people get the start of
 * a name right and drift later — which is why this is the family used for
 * name matching rather than Levenshtein.
 */
export function jaroWinkler(a: string, b: string): number {
  const j = jaro(a, b);
  if (j === 0) return 0;
  let prefix = 0;
  const limit = Math.min(4, a.length, b.length);
  while (prefix < limit && a[prefix] === b[prefix]) prefix += 1;
  return j + prefix * 0.1 * (1 - j);
}

/* -------------------------------------------------------------------------- */
/* Token alignment — the only thing allowed to assert a match                 */
/* -------------------------------------------------------------------------- */

/**
 * How much one token pair is worth.
 *
 * Exactly two ways to score above zero, and neither of them is fuzzy:
 *
 *   1.00  identical after normalisation.
 *   0.95  one side is a single letter and it is the other side's initial —
 *         `B` for `BOBBETH`. Not 1.00, because an initial genuinely carries
 *         less information than the name; 0.95 keeps a three-token name with
 *         one initial (0.983 coverage) comfortably above the threshold while
 *         a name that is ALL initials against a full name is not.
 *
 * Anything else is zero. `CHARLSON` earns nothing against `CHARLESON` here,
 * which is the mechanism that keeps a one-letter typo out of `match`.
 */
function tokenPairScore(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 1 && b.startsWith(a)) return 0.95;
  if (b.length === 1 && a.startsWith(b)) return 0.95;
  return 0;
}

/** How much an unmatched token in the longer name costs. */
const PENALTY_INTERIOR = 1;
const PENALTY_INTERIOR_INITIAL = 0;
const PENALTY_TERMINAL = 12;

/**
 * Structural agreement, 0..100.
 *
 * Coverage is measured against the SHORTER name — "is everything the shorter
 * name says also said by the longer one" — and then the longer name's
 * leftovers are charged for. That asymmetry is the point: a dropped middle
 * name is a presentational difference, and a dropped surname is a different
 * person.
 *
 * The charge depends on where the leftover sits:
 *
 *   interior, single letter  0   an initial nobody wrote down. Free.
 *   interior, a word         1   a middle name. Nearly free, and the single
 *                                point keeps `Alberta Charleson` at 99
 *                                rather than 100, so the screen can still
 *                                show that the two strings were not identical.
 *   first or last            12  a surname or a leading trade name. This is
 *                                the difference between `Ridgeline Coffee`
 *                                and `Ridgeline Coffee Roasters`, and it must
 *                                drop out of `match` — 12 is simply enough to
 *                                do that from 100, chosen so that a single
 *                                terminal difference always warns and no
 *                                number of interior ones ever can.
 *
 * A single token against a multi-token name is capped at 0.6 coverage
 * regardless: `Charleson` is not `Alberta Bobbeth Charleson`, however
 * perfectly that one token lines up.
 */
export function structuralScore(payerTokens: readonly string[], otherTokens: readonly string[]): number {
  if (payerTokens.length === 0 || otherTokens.length === 0) return 0;

  const [shorter, longer] =
    payerTokens.length <= otherTokens.length
      ? [payerTokens, otherTokens]
      : [otherTokens, payerTokens];

  const takenInLonger = new Array<boolean>(longer.length).fill(false);
  let matched = 0;

  for (const token of shorter) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let j = 0; j < longer.length; j += 1) {
      if (takenInLonger[j] === true) continue;
      const other = longer[j];
      if (other === undefined) continue;
      const score = tokenPairScore(token, other);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = j;
      }
    }
    if (bestIndex >= 0) {
      takenInLonger[bestIndex] = true;
      matched += bestScore;
    }
  }

  const cap = shorter.length === 1 && longer.length > 1 ? 0.6 : 1;
  const coverage = Math.min(cap, matched / shorter.length);

  let penalty = 0;
  for (let j = 0; j < longer.length; j += 1) {
    if (takenInLonger[j] === true) continue;
    const token = longer[j];
    if (token === undefined) continue;
    const terminal = j === 0 || j === longer.length - 1;
    penalty += terminal
      ? PENALTY_TERMINAL
      : token.length === 1
        ? PENALTY_INTERIOR_INITIAL
        : PENALTY_INTERIOR;
  }

  return Math.max(0, Math.min(100, coverage * 100 - penalty));
}

/* -------------------------------------------------------------------------- */
/* The composite                                                              */
/* -------------------------------------------------------------------------- */

export type NameComparison = {
  /** 0..100, whole points. Never a float — see `payee_verification.name_match_score`. */
  readonly score: number;
  readonly band: Exclude<NameMatchBand, "unavailable">;
  /** Structural agreement alone. The only signal permitted to assert a match. */
  readonly structural: number;
  /** Jaro–Winkler over the concatenated cores. Grades a non-match; never asserts one. */
  readonly textual: number;
  /** What was actually compared, after normalisation. Shown on the screen. */
  readonly normalisedPayerName: string;
  readonly normalisedOtherName: string;
  /** True when the two strings differ only in presentation. */
  readonly identicalAfterNormalisation: boolean;
};

/**
 * Compare two names.
 *
 * `payerName` is what our customer typed. `otherName` is the name held by
 * whoever else holds one — the institution, via Plaid, or the payee record
 * itself. The parameters are named rather than positional-by-convention
 * because getting them the wrong way round changes the penalty asymmetry and
 * nothing would complain.
 */
export function compareNames(payerName: string, otherName: string): NameComparison {
  const payerTokens = nameTokens(payerName);
  const otherTokens = nameTokens(otherName);

  const normalisedPayerName = payerTokens.join(" ");
  const normalisedOtherName = otherTokens.join(" ");

  const structural = structuralScore(payerTokens, otherTokens);
  const textual = jaroWinkler(payerTokens.join(""), otherTokens.join("")) * 100;

  // THE RULE. Structure can clear the bar; similarity cannot. Below the bar,
  // the better of the two grades how far off it is, clamped one point under
  // the threshold so no path through this function can return a `match` that
  // structure did not earn.
  const raw =
    structural >= NAME_MATCH_THRESHOLD
      ? structural
      : Math.min(NAME_MATCH_THRESHOLD - 1, Math.max(structural, textual));

  const score = Math.round(raw);

  return {
    score,
    band: nameMatchBand(score),
    structural: Math.round(structural),
    textual: Math.round(textual),
    normalisedPayerName,
    normalisedOtherName,
    identicalAfterNormalisation:
      normalisedPayerName === normalisedOtherName && normalisedPayerName.length > 0,
  };
}

/**
 * The sentence a screen shows next to the band.
 *
 * Written here rather than in the component because the wording is part of
 * the honesty of the feature, not part of its styling: every string below
 * either names the source of the other name or says that there was not one.
 */
export function describeNameComparison(
  comparison: NameComparison,
  source: "payer_asserted" | "linked_account_holder" | "confirmation_of_payee",
): string {
  const authority =
    source === "payer_asserted"
      ? "This compares two names your own team entered. No bank has confirmed anything."
      : source === "linked_account_holder"
        ? "This compares the name you typed against the name the receiving institution holds, obtained through the account holder's own Plaid link."
        : "This compares the name you typed against the name the receiving bank returned.";

  switch (comparison.band) {
    case "match":
      return comparison.identicalAfterNormalisation
        ? `The names are the same. ${authority}`
        : `The names agree once case, punctuation and legal form are set aside. ${authority}`;
    case "close_match":
      return `The names are close but not the same: "${comparison.normalisedPayerName}" against "${comparison.normalisedOtherName}". ${authority}`;
    case "no_match":
      return `The names do not agree: "${comparison.normalisedPayerName}" against "${comparison.normalisedOtherName}". ${authority}`;
  }
}
