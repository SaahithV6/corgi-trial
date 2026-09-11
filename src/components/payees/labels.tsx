import { Badge, type BadgeTone } from "@/components/ui/primitives";

import type {
  CheckEvidence,
  DirectoryOutcome,
  FindingSeverity,
  Freshness,
  NameMatchOutcome,
  NameSource,
  PayeeOutcome,
} from "./data-contract";

/**
 * Every word this screen puts next to a result, in one file.
 *
 * Here rather than inline because the wording IS the feature. The whole risk
 * of a payee-confirmation screen is that it says "verified" next to something
 * nobody verified, and the defence against that is having one place where
 * every label is written down and can be read end to end by somebody deciding
 * whether it is true.
 *
 * Three rules, applied below without exception:
 *
 *   1. NO GREEN TICK WITHOUT A THIRD PARTY. `payer_asserted` never renders in
 *      the positive tone, however high the score, because nobody confirmed
 *      anything.
 *   2. "NOT CHECKED" IS NEVER DRAWN LIKE "CHECKED AND FINE". `unavailable`
 *      and `not_listed` get the quiet tone and a sentence, never a tick.
 *   3. THE AUTHORITY IS NAMED. Every positive statement carries the provider
 *      that made it.
 */

/**
 * What the last check decided, and — for a warning — whether anybody has
 * signed for it yet.
 *
 * `acknowledged` is read here rather than only underneath the badge because
 * the badge is the part an operator scans. A warned payee that somebody HAS
 * signed for was reading NEEDS A SIGNATURE in red above the words "signed by
 * Dana Okonkwo": a badge demanding an action that had already been taken, on
 * the one screen whose job is to say which payees are holding payments up.
 * The warning does not go away when it is signed for — the names still differ —
 * so the label keeps the word WARNED and adds who settled it.
 */
export function OutcomeBadge({
  outcome,
  acknowledged = false,
}: {
  readonly outcome: PayeeOutcome | null;
  readonly acknowledged?: boolean;
}) {
  if (outcome === null) return <Badge tone="quiet">NEVER CHECKED</Badge>;
  if (outcome === "warned" && acknowledged) {
    return <Badge tone="neutral">WARNED · SIGNED FOR</Badge>;
  }
  const tone: BadgeTone =
    outcome === "blocked" ? "negative" : outcome === "warned" ? "negative" : "positive";
  const label =
    outcome === "blocked" ? "BLOCKED" : outcome === "warned" ? "NEEDS A SIGNATURE" : "CHECKED";
  return <Badge tone={tone}>{label}</Badge>;
}

export function FreshnessBadge({
  freshness,
  days,
}: {
  readonly freshness: Freshness;
  readonly days: number | null;
}) {
  const tone: BadgeTone =
    freshness === "stale" ? "negative" : freshness === "never" ? "quiet" : "quiet";
  const label =
    freshness === "never"
      ? "no check on file"
      : days === null
        ? freshness
        : days === 0
          ? "checked today"
          : `checked ${days} day${days === 1 ? "" : "s"} ago`;
  return (
    <Badge tone={tone} title={FRESHNESS_HINT[freshness]}>
      {label.toUpperCase()}
    </Badge>
  );
}

export const FRESHNESS_HINT: Record<Freshness, string> = {
  fresh: "Checked within the last 30 days.",
  ageing: "Checked between 30 and 90 days ago. Still the last thing we know.",
  stale:
    "Checked more than 90 days ago. Bank details change and businesses are acquired; an answer " +
    "from last quarter is an answer about last quarter. Re-check before you send.",
  never: "Nobody has ever run a check against this payee.",
};

/**
 * The name result.
 *
 * The tone deliberately depends on the SOURCE as well as the outcome. A
 * `match` that nobody but us asserted is not a positive result, it is an
 * internal consistency check, and drawing it green would be the single most
 * misleading pixel on the screen.
 */
export function NameMatchBadge({
  match,
  source,
  score,
}: {
  readonly match: NameMatchOutcome | null;
  readonly source: NameSource | null;
  readonly score: number | null;
}) {
  if (match === null) return <Badge tone="quiet">NOT CHECKED</Badge>;
  if (match === "unavailable") {
    return (
      <Badge tone="quiet" title="No third party can say what name is on this account.">
        NAME NOT VERIFIABLE
      </Badge>
    );
  }
  const confirmed = source === "linked_account_holder" || source === "confirmation_of_payee";
  const tone: BadgeTone =
    match === "match" ? (confirmed ? "positive" : "quiet") : "negative";
  const label =
    match === "match" ? "NAME MATCH" : match === "close_match" ? "CLOSE MATCH" : "NO MATCH";
  return (
    <Badge
      tone={tone}
      {...(score === null ? {} : { title: `similarity ${score}/100` })}
    >
      {label}
      {score === null ? "" : ` · ${score}`}
    </Badge>
  );
}

export const NAME_SOURCE_SENTENCE: Record<NameSource, string> = {
  payer_asserted:
    "Both names here were entered by your own team. No bank has confirmed anything, because US " +
    "ACH has no Confirmation of Payee network to ask.",
  linked_account_holder:
    "The other name came from the receiving institution's own record, obtained through the " +
    "account holder's Plaid link.",
  confirmation_of_payee:
    "The other name came from the receiving bank, through a name-check network.",
};

export function DirectoryBadge({
  directory,
  institutionName,
  provider,
}: {
  readonly directory: DirectoryOutcome | null;
  readonly institutionName: string | null;
  readonly provider: string | null;
}) {
  if (directory === null || directory === "not_checked") {
    return <Badge tone="quiet">NO ROUTING NUMBER</Badge>;
  }
  if (directory === "found") {
    return (
      <Badge
        tone="positive"
        {...(provider === null ? {} : { title: `confirmed by ${provider}` })}
      >
        {(institutionName ?? "INSTITUTION FOUND").toUpperCase()}
      </Badge>
    );
  }
  if (directory === "not_listed") {
    return (
      <Badge tone="quiet" title="The directory answered and does not know this routing number.">
        NOT IN DIRECTORY
      </Badge>
    );
  }
  return (
    <Badge tone="quiet" title="The directory could not be reached. The check digit still held.">
      DIRECTORY UNREACHABLE
    </Badge>
  );
}

export function EvidenceBadge({ evidence }: { readonly evidence: CheckEvidence | null }) {
  if (evidence === null) return null;
  return evidence === "live" ? (
    <Badge tone="neutral" title="A real third party answered a real call during this check.">
      LIVE
    </Badge>
  ) : (
    <Badge tone="quiet" title="No third party was reached. Only local arithmetic ran.">
      LOCAL ONLY
    </Badge>
  );
}

export const SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  block: "negative",
  warn: "negative",
  note: "quiet",
};

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  block: "BLOCKS",
  warn: "NEEDS A SIGNATURE",
  note: "NOTE",
};
