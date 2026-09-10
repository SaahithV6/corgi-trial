import { createHash } from "node:crypto";

import type { StatementDocument, StatementLine } from "./types";

/**
 * The canonical rendering, and the hash taken over it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE HASH IS A FUNCTION OF
 * ---------------------------------------------------------------------------
 *
 * Exactly four inputs and nothing else:
 *
 *     (format version, account, period, booking watermark)
 *
 * Everything below those is drawn from immutable rows bounded by the
 * watermark, so the hash is a pure function of that tuple. Concretely:
 *
 *   - `statement.id`, `version` and `generated_at` are NOT in the preimage.
 *     If they were, re-rendering could never reproduce a published hash and
 *     the whole guarantee would be circular. A document is identified by what
 *     it says, not by the row that stores it.
 *   - `runningBalanceCents` is not in the preimage either: it is determined by
 *     the opening balance and the prefix of line amounts, both of which are.
 *   - The format version IS in the preimage, first. A renderer change is a
 *     real change to the artefact and it must be loud, not silent. If this
 *     module's output ever changes shape, `STATEMENT_FORMAT` changes with it,
 *     every hash changes, and `verifyStatement` reports it against every
 *     historical row instead of quietly agreeing.
 *
 * ---------------------------------------------------------------------------
 * WHY NETSTRING FIELDS RATHER THAN A DELIMITER
 * ---------------------------------------------------------------------------
 *
 * `src/lib/recon/run.ts` joins its fields with `:` and `|`, which is fine
 * there because every field is a code, an id or a decimal. A statement carries
 * `description` and `external_ref`, which are free text arriving from a
 * provider. With a plain delimiter, a description containing `|` could forge a
 * different set of lines that hashes identically — a preimage ambiguity, which
 * in a tamper-evidence context is a real hole and not a nitpick.
 *
 * So every field is emitted length-prefixed, `<utf8 byte length>:<value>`.
 * The encoding is unambiguous: given the preimage there is exactly one field
 * sequence that produces it, whatever the text contains. The literal newlines
 * between records are there so a human can read the preimage in a diff; they
 * carry no parsing weight because the lengths already do.
 *
 * ---------------------------------------------------------------------------
 * ORDER
 * ---------------------------------------------------------------------------
 *
 * Lines are sorted by `(value_date, booking_seq, ordinal)` — a total order,
 * since `booking_seq` is unique per entry and `ordinal` is unique within one.
 * `sortLines` applies it here rather than trusting the caller's `ORDER BY`, so
 * the canonical form is canonical even if someone hands this function rows in
 * whatever order a future query returns them.
 *
 * No floats anywhere: amounts enter as `bigint` and are rendered with
 * `toString()`, which is exact.
 */

/**
 * The renderer's version, first field of every preimage.
 *
 * Bump this if and only if the canonical rendering changes. Bumping it
 * invalidates every stored `content_hash`, which is the point: a silent
 * renderer change that made old statements unverifiable would be worse than a
 * loud one that makes them fail verification with a reason.
 */
export const STATEMENT_FORMAT = "corgi.statement.v1";

/** `<utf8 byte length>:<value>` — unambiguous whatever the value contains. */
function field(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

function record(tag: string, ...values: readonly string[]): string {
  return [tag, ...values.map(field)].join(" ");
}

/**
 * A nullable text field.
 *
 * `null` and the empty string are different facts about a provider reference —
 * "the entry carries none" versus "the entry carries a blank one" — and a
 * literal `"null"` in the data is a third. The presence marker keeps all three
 * apart: absent is `-`, present is `+` followed by the value, and the length
 * prefix already makes the value itself unambiguous.
 */
function optional(value: string | null): string {
  return value === null ? "-" : `+${value}`;
}

/** The total order. Exported because the read path and the tests both need it. */
export function compareLines(a: StatementLine, b: StatementLine): number {
  if (a.valueDate !== b.valueDate) return a.valueDate < b.valueDate ? -1 : 1;
  if (a.bookingSeq !== b.bookingSeq) return a.bookingSeq < b.bookingSeq ? -1 : 1;
  return a.ordinal - b.ordinal;
}

export function sortLines(lines: readonly StatementLine[]): readonly StatementLine[] {
  return [...lines].sort(compareLines);
}

/**
 * Attach running balances to lines that are already in canonical order.
 *
 * Kept separate from the query so the arithmetic is testable without a
 * database, and so there is one definition of "running balance" rather than
 * one in SQL and one in TypeScript that can disagree.
 */
export function withRunningBalances(
  openingBalanceCents: bigint,
  lines: readonly Omit<StatementLine, "runningBalanceCents">[],
): readonly StatementLine[] {
  let running = openingBalanceCents;
  return lines.map((line) => {
    running += line.signedCents;
    return { ...line, runningBalanceCents: running };
  });
}

/**
 * The exact bytes the content hash is taken over.
 *
 * Returned as a string rather than kept private so a test can assert the
 * DOCUMENT is byte-identical across generations, not merely that two hashes
 * agree. A hash comparison proves equality; showing the preimage proves what
 * was compared, and in a debrief that difference matters.
 */
export function canonicalStatement(doc: StatementDocument): string {
  const lines = sortLines(doc.lines);

  const head = [
    record("format", STATEMENT_FORMAT),
    record("account", doc.accountId),
    record("period", doc.periodStart, doc.periodEnd),
    record("watermark", doc.bookingWatermark.toString()),
    record("opening", doc.openingBalanceCents.toString()),
    record("closing", doc.closingBalanceCents.toString()),
    record("count", lines.length.toString()),
  ];

  const body = lines.map((l) =>
    record(
      "line",
      l.valueDate,
      l.bookingSeq.toString(),
      l.ordinal.toString(),
      l.signedCents.toString(),
      l.entryType,
      optional(l.externalRef),
      optional(l.rail),
      optional(l.reversesEntryId),
      l.description,
    ),
  );

  // Trailing newline so the preimage is a sequence of complete records and a
  // document with N lines can never be a prefix of one with N+1.
  return `${[...head, ...body].join("\n")}\n`;
}

/** sha256 over the canonical rendering, lowercase hex. */
export function statementHash(doc: StatementDocument): string {
  return createHash("sha256").update(canonicalStatement(doc), "utf8").digest("hex");
}

/**
 * Closing balance from opening plus the lines.
 *
 * The document carries `closingBalanceCents` because `statement` stores it —
 * deliberately, as the as-published figure that must stay queryable exactly as
 * issued (DECISIONS 008, and `scripts/dbcheck.mjs` exempts the table by name
 * with that reasoning). This function is how the stored number is derived, and
 * `foldClosing(opening, lines) === closing` is checked before anything is
 * written, so the stored figure can never be a number nobody can reproduce.
 */
export function foldClosing(
  openingBalanceCents: bigint,
  lines: readonly { readonly signedCents: bigint }[],
): bigint {
  return lines.reduce((acc, l) => acc + l.signedCents, openingBalanceCents);
}
