/**
 * The confirmation step itself: three legs in, one decision out.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THE JUDGEMENT THIS WHOLE FEATURE TURNS ON                                ║
 * ║                                                                          ║
 * ║ A FAILED ROUTING CHECKSUM IS A BLOCK.                                    ║
 * ║ A FAILED NAME MATCH IS A WARNING.                                        ║
 * ║                                                                          ║
 * ║ Not because one matters more. Because they are different KINDS of        ║
 * ║ statement.                                                               ║
 * ║                                                                          ║
 * ║ The checksum is a closed question. The ninth digit of a routing number    ║
 * ║ is chosen so the weighted sum lands on zero; a number that misses is not  ║
 * ║ a number any bank has, has had, or will be issued. There is no fact       ║
 * ║ about the world that could make it right, so there is no informed human   ║
 * ║ who could be right to override it. An "are you sure?" in front of         ║
 * ║ arithmetic is theatre: it teaches people that this system's warnings are  ║
 * ║ things you click through, and the next warning they click through is the  ║
 * ║ one that mattered.                                                        ║
 * ║                                                                          ║
 * ║ The name is an open question, and it is open in the direction of FALSE    ║
 * ║ POSITIVES. Companies trade under names that are not their registered      ║
 * ║ ones. Subsidiaries bank in a parent's name. Sole traders bank            ║
 * ║ personally. A factoring company is paid instead of the supplier who       ║
 * ║ raised the invoice. Every UK CoP scheme — the mature version of this      ║
 * ║ feature, running at national scale — lets the payer proceed after an      ║
 * ║ explicit acknowledgement, for exactly these reasons. A hard block on a    ║
 * ║ name mismatch does not stop fraud; it stops legitimate payments, and      ║
 * ║ then it gets switched off.                                                ║
 * ║                                                                          ║
 * ║ So the warning is made to COST something instead: `payee_acknowledgement` ║
 * ║ is a row with a named human, an instant and a sentence, a trigger         ║
 * ║ refuses one against a check that was not `warned`, and the row is         ║
 * ║ append-only like everything else. That is what makes "we let it through"  ║
 * ║ answerable afterwards, and it is what earns the name leg the right to be  ║
 * ║ a warning rather than a wall.                                             ║
 * ║                                                                          ║
 * ║ The line is drawn three times so it cannot be moved in one place:         ║
 * ║   1. `assertBlockIsArithmetic()` below, at runtime, on every check;       ║
 * ║   2. `payee_routing_number_possible`, a CHECK constraint — an impossible  ║
 * ║      routing number is not storable;                                      ║
 * ║   3. `payee_verification_block_is_arithmetic`, a second CHECK — a stored  ║
 * ║      verification cannot claim a block for a soft reason.                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT THIS MODULE MAY NOT DO. It does not write a journal entry, raise a
 * payment instruction, release a hold or touch a money table, and nothing it
 * calls does either. It answers a question about a destination. Posting is
 * `src/lib/ledger`'s job and raising is `src/lib/approvals`'.
 */

import {
  abaNearMisses,
  checkRoutingNumber,
} from "./aba";
import {
  NOT_CHECKED,
  type DirectoryLookup,
  type RoutingDirectory,
} from "./directory";
import { NO_IDENTITY_SOURCE, type IdentityNameSource } from "./identity";
import {
  compareNames,
  describeNameComparison,
  nameTokens,
  NAME_MATCH_THRESHOLD,
} from "./name-match";
import type {
  BookEntry,
  CheckEvidence,
  NameCheckResult,
  PayeeCandidate,
  PayeeCheck,
  PayeeFinding,
  PayeeOutcome,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Input hygiene, which is not verification                                   */
/* -------------------------------------------------------------------------- */

/**
 * Do the two typings of an account number agree?
 *
 * THE UNITED STATES PUTS NO CHECK DIGIT ON AN ACCOUNT NUMBER. There is no
 * length rule, no character rule and no checksum — an account number is
 * whatever string the receiving bank's core system assigned, and the only
 * party who can say whether it exists is that bank. So the arithmetic that
 * saves the routing number saves nothing here, and this is the entirety of
 * what a form can do about it unaided: make the person type it twice and
 * compare.
 *
 * Re-entry catches an independent slip on the second typing, which is most
 * of them. It cannot catch a number copied wrongly from an invoice and
 * pasted twice, and nothing on our side can. That case needs the receiving
 * bank, which means an ACH prenotification — a zero-dollar entry answered
 * days later with a C01/C02/C03 correction, and week two. docs/PAYEES.md.
 *
 * Deliberately NOT a `PayeeFinding` and deliberately not part of the
 * block/warn ladder: two different strings are a contradiction in the form,
 * not a fact about a bank, and mixing the two would blur the one distinction
 * this feature is built on. The form refuses; the checker never sees it.
 */
export function accountNumberEntryAgrees(first: string, second: string): boolean {
  const clean = (s: string) => s.replace(/[\s-]/g, "");
  return clean(first).length > 0 && clean(first) === clean(second);
}

/* -------------------------------------------------------------------------- */
/* The check                                                                  */
/* -------------------------------------------------------------------------- */

export type VerifyDeps = {
  /** Defaults to a directory that answers `not_checked` for everything. */
  readonly directory?: RoutingDirectory | undefined;
  /** Defaults to `NO_IDENTITY_SOURCE` — the truthful "nobody to ask". */
  readonly identity?: IdentityNameSource | undefined;
  /**
   * The payees already on this business's book, for the twin check. Empty is
   * a legitimate answer and means "first payee"; it is never an error.
   */
  readonly book?: readonly BookEntry[] | undefined;
  /** Injected so a test and a fixture are reproducible. */
  readonly now?: Date | undefined;
};

/**
 * Check a destination. Never throws, never writes, never moves money.
 */
export async function verifyPayee(
  candidate: PayeeCandidate,
  deps: VerifyDeps = {},
): Promise<PayeeCheck> {
  const now = deps.now ?? new Date();
  const findings: PayeeFinding[] = [];

  /* ---- leg 1: arithmetic ------------------------------------------------ */

  const needsRouting = candidate.rail === "ach" || candidate.rail === "wire";
  const verdict =
    needsRouting && candidate.routingNumber !== undefined
      ? checkRoutingNumber(candidate.routingNumber)
      : null;

  const checksumOk = verdict === null ? true : verdict.valid;
  const routingNumber = verdict === null ? null : verdict.routingNumber;
  const prefixAssigned = verdict !== null && verdict.valid ? verdict.prefixAssigned : true;

  let nearMisses: readonly { kind: string; candidate: string }[] = [];

  if (verdict !== null && !verdict.valid) {
    // ONLY TRANSPOSITIONS ARE SHOWN. Every invalid routing number has exactly
    // nine single-digit repairs — one per position, always, because all three
    // weights are coprime to 10 — so listing those is not a hint, it is a
    // restatement of "the number is wrong" in nine parts. A transposition
    // near miss is different: it is usually absent, and when it is present it
    // is a specific claim about what the hand did.
    nearMisses = abaNearMisses(candidate.routingNumber ?? "")
      .filter((m) => m.kind === "transposition")
      .map((m) => ({ kind: m.kind, candidate: m.candidate }));

    findings.push({
      code: "ROUTING_CHECKSUM_FAILED",
      severity: "block",
      title: "This routing number cannot exist",
      detail:
        verdict.message +
        (nearMisses.length > 0
          ? ` Swapping two adjacent digits would give ${nearMisses
              .map((m) => m.candidate)
              .join(" or ")}, which is the commonest way this happens. Confirm against the ` +
            "payee's own paperwork rather than taking a suggestion from us."
          : " Re-key it from the payee's own paperwork; no adjacent pair of digits explains the failure, " +
            "which usually means the number came from the wrong document rather than from a slip."),
    });
  }

  if (verdict !== null && verdict.valid && !verdict.prefixAssigned) {
    findings.push({
      code: "ROUTING_PREFIX_UNALLOCATED",
      severity: "warn",
      title: "The first two digits are not an allocated range",
      detail:
        `${verdict.prefixDescription}. The check digit holds, so the number is arithmetically ` +
        "possible, but no Federal Reserve district or thrift range has ever been issued with " +
        "this prefix. That combination is far more likely to be a fabricated number than a real " +
        "one. This warns rather than blocks because the allocation is a registry that can " +
        "change, unlike the arithmetic.",
    });
  }

  /* ---- leg 2: the directory --------------------------------------------- */
  //
  // Skipped entirely when the checksum failed. Asking a directory about a
  // number that cannot exist wastes a round trip in front of a person and
  // invites the answer to be misread as the reason.

  const directory: DirectoryLookup =
    verdict !== null && verdict.valid && deps.directory !== undefined
      ? await deps.directory.lookup(verdict.routingNumber)
      : NOT_CHECKED;

  if (directory.status === "found") {
    findings.push({
      code: "DIRECTORY_CONFIRMED",
      severity: "note",
      title: `${directory.institutionName ?? "The institution"} holds this routing number`,
      detail:
        `Confirmed live by ${directory.provider}. This says the routing number belongs to a ` +
        "real institution. It says nothing about the account number or about who owns the " +
        "account.",
    });

    const railUnsupported =
      (candidate.rail === "ach" && directory.achSupported === false) ||
      (candidate.rail === "wire" && directory.wireSupported === false);
    if (railUnsupported) {
      findings.push({
        code: "DIRECTORY_RAIL_UNSUPPORTED",
        severity: "warn",
        title: `${directory.institutionName ?? "This institution"} does not take ${candidate.rail.toUpperCase()}`,
        detail:
          "The directory says this institution does not accept transfers on the rail you have " +
          "chosen. Most often the payee has given you their wire routing number for an ACH " +
          "payment, or the reverse — the two are different numbers at most large banks.",
      });
    }
  }

  if (directory.status === "not_listed") {
    // THE HONEST BIT. In sandbox a miss means the sandbox directory is small,
    // not that the bank is fake — measured: every real routing number in the
    // seed data misses. Warning on it would flag every payment in the demo,
    // and a warning that fires on everything is a warning nobody reads.
    findings.push(
      directory.environment === "production"
        ? {
            code: "DIRECTORY_NOT_LISTED",
            severity: "warn",
            title: "No institution is registered against this routing number",
            detail:
              `${directory.provider} answered, and does not know this routing number. The check ` +
              "digit holds, so it is a possible number, but nobody appears to have been issued " +
              "it. Confirm the details with the payee before sending.",
          }
        : {
            code: "DIRECTORY_NOT_LISTED",
            severity: "note",
            title: "The sandbox directory does not carry this bank",
            detail:
              `${directory.provider} answered and has no entry for this routing number. In the ` +
              "sandbox that means almost nothing: the test directory holds test banks, and every " +
              "real routing number in this demo misses it. Against the production directory the " +
              "same answer would be a warning.",
          },
    );
  }

  if (directory.status === "unavailable") {
    findings.push({
      code: "DIRECTORY_UNAVAILABLE",
      severity: "note",
      title: "The routing-number directory could not be reached",
      detail:
        `${directory.unavailableReason ?? "No reason was given"}. The check digit was still ` +
        "verified locally, which is the part that catches a typo. Nobody confirmed the " +
        "institution exists.",
    });
  }

  /* ---- leg 3: the name --------------------------------------------------- */

  const name = await checkName(candidate, deps.identity ?? NO_IDENTITY_SOURCE, findings);

  /* ---- the book ---------------------------------------------------------- */

  const twin = findConflictingTwin(candidate, deps.book ?? []);
  if (twin !== null) {
    findings.push({
      code: "TWIN_WITH_DIFFERENT_DETAILS",
      severity: "warn",
      title: "You already pay someone by this name at a different account",
      detail:
        `"${twin.holderName}" is already on your payee book with ` +
        `${twin.routingNumber ?? "no"} routing ` +
        `${twin.accountNumberLast4 === null ? "" : `and an account ending ${twin.accountNumberLast4} `}` +
        "— different bank details for the same name. This is what a redirected-invoice fraud " +
        "looks like from the inside, and it is also what a supplier changing bank looks like. " +
        "Confirm the change by a channel you already had, not one from the email that asked " +
        "for it.",
    });
  }

  /* ---- the decision ------------------------------------------------------ */

  const decision = decide(findings);
  assertBlockIsArithmetic(decision, findings);

  const evidence: CheckEvidence =
    directory.provider !== null || name.provider !== null ? "live" : "simulated";

  return {
    decision,
    findings,
    acknowledgeable: decision !== "blocked",
    routingNumber,
    checksumOk,
    prefixAssigned,
    nearMisses,
    directory: directory.status,
    directoryProvider: directory.provider,
    institutionName: directory.institutionName,
    achSupported: directory.achSupported,
    wireSupported: directory.wireSupported,
    name,
    evidence,
    checkedAt: now.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* The name leg                                                               */
/* -------------------------------------------------------------------------- */

async function checkName(
  candidate: PayeeCandidate,
  identity: IdentityNameSource,
  findings: PayeeFinding[],
): Promise<NameCheckResult> {
  // The real path: an account whose holder linked it to us, so the
  // institution's own record of the name is obtainable.
  if (candidate.plaidAccessToken !== undefined) {
    const result = await identity.match({
      accessToken: candidate.plaidAccessToken,
      ...(candidate.plaidAccountId === undefined ? {} : { accountId: candidate.plaidAccountId }),
      legalName: candidate.holderName,
    });

    if (result.available) {
      const providerScore = result.check.providerScore;
      const holderName = result.check.holderName;

      // Two opinions, kept apart. Ours is computed only when we have the
      // other name to compute it from; where Plaid gave a score but no name,
      // Plaid's score IS the answer and we do not invent a second one.
      const comparison =
        holderName === null ? null : compareNames(candidate.holderName, holderName);

      // The strict rule, applied across both: a `match` needs BOTH the
      // provider at or above the threshold and — when we could compute one —
      // our own structural agreement. Either one dissenting drops the band.
      // Two independent opinions that disagree is precisely the case a human
      // should look at, and averaging them would hide it.
      const outcome =
        comparison !== null
          ? providerScore >= NAME_MATCH_THRESHOLD && comparison.band === "match"
            ? "match"
            : comparison.band === "no_match" || providerScore < 80
              ? "no_match"
              : "close_match"
          : providerScore >= NAME_MATCH_THRESHOLD
            ? "match"
            : providerScore >= 80
              ? "close_match"
              : "no_match";

      const score = comparison === null ? Math.round(providerScore) : comparison.score;

      pushNameFinding(findings, outcome, "linked_account_holder", holderName, candidate.holderName);

      return {
        outcome,
        score,
        source: "linked_account_holder",
        provider: result.check.provider,
        counterpartyName: holderName,
        providerScore: Math.round(providerScore),
        explanation:
          comparison === null
            ? `${result.check.provider} scored the name you typed at ${Math.round(providerScore)} out of 100 against the institution's record. The institution's own spelling was not returned.`
            : describeNameComparison(comparison, "linked_account_holder") +
              ` ${result.check.provider} independently scored it ${Math.round(providerScore)}.`,
      };
    }

    // Fall through: a linked account we could not reach is not a name we
    // asserted. Say why, and do not silently downgrade to a local comparison
    // that would look like a check somebody performed.
    findings.push({
      code: "NAME_NOT_VERIFIABLE",
      severity: "note",
      title: "The institution could not be asked for the account holder's name",
      detail: `${result.reason} Nothing about the name on the receiving account has been confirmed.`,
    });
    return {
      outcome: "unavailable",
      score: null,
      source: "payer_asserted",
      provider: null,
      counterpartyName: null,
      providerScore: null,
      explanation:
        "No third party was able to say what name is on this account, so the name has not been " +
        "checked against anything.",
    };
  }

  // The ordinary path, and the honest one.
  findings.push({
    code: "NAME_NOT_VERIFIABLE",
    severity: "note",
    title: "No bank has confirmed the name on this account",
    detail:
      "US ACH has no Confirmation of Payee network: there is no message that asks a receiving " +
      "bank what name is on an account, and no provider in this system can obtain one for a " +
      "third party's account. The name below is the one your own team typed. It has been " +
      "checked for internal consistency and for nothing else.",
  });

  return {
    outcome: "unavailable",
    score: null,
    source: "payer_asserted",
    provider: null,
    counterpartyName: null,
    providerScore: null,
    explanation:
      "The name on this payee is the name your team entered. No bank was asked to confirm it, " +
      "because for US ACH there is nobody to ask.",
  };
}

function pushNameFinding(
  findings: PayeeFinding[],
  outcome: NameCheckResult["outcome"],
  source: NameCheckResult["source"],
  counterpartyName: string | null,
  typedName: string,
): void {
  const authority =
    source === "linked_account_holder"
      ? "the name the receiving institution holds"
      : "the name on record";

  if (outcome === "close_match") {
    findings.push({
      code: "NAME_CLOSE_MATCH",
      severity: "warn",
      title: "The name is close, but not the same",
      detail:
        `You typed "${typedName}". ${counterpartyName === null ? "The institution's record" : `The institution holds "${counterpartyName}"`} — ` +
        `close to ${authority} but not identical. A single wrong letter is exactly what this ` +
        "check exists to surface. Confirm before sending, or record why the difference is " +
        "legitimate.",
    });
  }
  if (outcome === "no_match") {
    findings.push({
      code: "NAME_NO_MATCH",
      severity: "warn",
      title: "The name does not match the account",
      detail:
        `You typed "${typedName}"${counterpartyName === null ? "" : `, and the account is held by "${counterpartyName}"`}. ` +
        "Names legitimately differ — a trading name, a subsidiary, a factoring company — so this " +
        "does not stop the payment. It does need somebody to say, in writing, why it is right.",
    });
  }
  if (outcome === "match") {
    findings.push({
      code: "NAME_CONFIRMED_BY_INSTITUTION",
      severity: "note",
      title: "The receiving institution's record agrees with the name you typed",
      detail:
        "Obtained through the account holder's own link, not from a name-check network. It " +
        "confirms the holder of this account, and says nothing about whether this is the payee " +
        "your invoice meant.",
    });
  }
}

/* -------------------------------------------------------------------------- */
/* The book                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Another payee this business already has, with the same name and DIFFERENT
 * bank details.
 *
 * This is the only account-number check a system that stores four digits can
 * perform, and it happens to catch the failure that actually costs businesses
 * money: not a mistyped digit, but the right supplier paid at an account that
 * is not theirs any more — the redirected-invoice fraud. If you have paid
 * "Ridgeline Coffee Roasters" at ••4417 for a year and today's payment says
 * ••9002, somebody should look at that, and it should be a person rather than
 * a rule, because a supplier genuinely changing bank looks identical.
 *
 * Compared through `nameTokens` rather than byte-for-byte, so
 * `Ridgeline Coffee Roasters LLC` and `RIDGELINE COFFEE ROASTERS, L.L.C.` are
 * recognised as the same payee — which is the case where two records exist
 * precisely BECAUSE somebody keyed the name slightly differently the second
 * time. The view's `has_conflicting_twin` does the byte-identical version in
 * SQL; this is the one that catches the real thing.
 */
export function findConflictingTwin(
  candidate: PayeeCandidate,
  book: readonly BookEntry[],
): BookEntry | null {
  const mine = nameTokens(candidate.holderName).join(" ");
  if (mine.length === 0) return null;

  for (const entry of book) {
    if (nameTokens(entry.holderName).join(" ") !== mine) continue;
    const sameRouting = (entry.routingNumber ?? null) === (candidate.routingNumber ?? null);
    const sameLast4 =
      (entry.accountNumberLast4 ?? null) === (candidate.accountNumberLast4 ?? null);
    if (!sameRouting || !sameLast4) return entry;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The decision, and the assertion that guards it                             */
/* -------------------------------------------------------------------------- */

/** Worst severity wins. Three lines, no policy table, nothing configurable. */
export function decide(findings: readonly PayeeFinding[]): PayeeOutcome {
  if (findings.some((f) => f.severity === "block")) return "blocked";
  if (findings.some((f) => f.severity === "warn")) return "warned";
  return "verified";
}

/**
 * The line, enforced at runtime.
 *
 * `ROUTING_CHECKSUM_FAILED` is the only code permitted to carry `block`. If a
 * future edit gives another finding that severity — the easiest possible
 * mistake, one word in an object literal — this throws at the point of the
 * mistake rather than silently converting a warning into a wall that nobody
 * can override and nobody can find.
 *
 * A throw and not a log: a block the design did not sanction is a change to
 * the product's behaviour under a name that claims it did not change, and it
 * should stop a test rather than reach a customer.
 */
export function assertBlockIsArithmetic(
  decision: PayeeOutcome,
  findings: readonly PayeeFinding[],
): void {
  const blocks = findings.filter((f) => f.severity === "block");

  for (const finding of blocks) {
    if (finding.code !== "ROUTING_CHECKSUM_FAILED") {
      throw new Error(
        `payee check produced a BLOCK for ${finding.code}. Only ROUTING_CHECKSUM_FAILED may ` +
          "block: it is the one finding that is arithmetically impossible rather than merely " +
          "suspicious. Everything else warns and is acknowledgeable. See verify.ts.",
      );
    }
  }

  if ((decision === "blocked") !== (blocks.length > 0)) {
    throw new Error(
      `payee check decision ${decision} disagrees with ${blocks.length} blocking findings`,
    );
  }
}
