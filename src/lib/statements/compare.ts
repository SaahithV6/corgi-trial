import type { Sql } from "@/lib/ledger/queries";

import { verifyStatement } from "./publish";
import {
  currentWatermark,
  listLatePostings,
  listStatementVersions,
  renderStatement,
} from "./read";
import type {
  BusinessDate,
  LatePosting,
  PublishedStatement,
  StatementComparison,
} from "./types";

/**
 * As published, versus as corrected.
 *
 * ---------------------------------------------------------------------------
 * BOTH ARE TRUE, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * The published figure is what the statement said on the day it was issued.
 * The corrected figure is what the ledger now says that day was. Neither one
 * is a correction of the other in the sense of being *more right*: they are
 * answers to two different questions, and the whole reason this ledger is
 * bitemporal is that both have to be answerable at once.
 *
 *     "What did you tell the customer on Wednesday?"   -> as published
 *     "What actually happened on Tuesday?"             -> as corrected
 *
 * A system that stores only the first is a filing cabinet. A system that
 * stores only the second cannot survive a dispute, a regulator, or a customer
 * holding a printout. A system that quietly replaces the first with the second
 * has destroyed evidence.
 *
 * ---------------------------------------------------------------------------
 * THE DIFFERENCE IS ITEMISED, NOT ASSERTED
 * ---------------------------------------------------------------------------
 *
 * A screen that says "these two numbers differ" is useless; the operator's
 * next question is "by what, and because of what". So the comparison carries
 * `latePostings` — every entry with a value date inside the period that was
 * booked ABOVE the published watermark — and it checks its own arithmetic:
 *
 *     corrected.closing - published.closing === Σ latePostings.signedCents
 *
 * If that identity fails, the gap is not explained by anything we can name.
 * `explainsDelta` reports it rather than rounding it off, and the screen shows
 * the disagreement instead of a confident number. The alternative — printing
 * the delta and hoping — is how a reconciliation screen trains its readers to
 * ignore it.
 */

export interface CompareRequest {
  readonly accountId: string;
  readonly businessDate: BusinessDate;
  /**
   * Which published version is the "as published" side.
   *
   * Defaults to **v1**, deliberately. v1 is the document issued against the
   * close watermark — the one that went out, the one a customer could be
   * holding, and the one whose divergence from today is the story. Later
   * versions are selectable, and selecting the current one is the honest way
   * to show that a reissue closed the gap: the delta goes to zero and the late
   * postings list empties.
   */
  readonly version?: number;
}

/**
 * Everything the statement screen needs about one (account, day), in one read.
 *
 * `null` when nothing has been published for that day — which is a state, not
 * an error: a day can be closed with no statement issued yet, and the screen
 * says exactly that rather than inventing a document.
 */
export async function compareStatement(
  request: CompareRequest,
  conn: Sql,
): Promise<StatementComparison | null> {
  const period = {
    accountId: request.accountId,
    periodStart: request.businessDate,
    periodEnd: request.businessDate,
  };

  const versions = await listStatementVersions(period, conn);
  if (versions.length === 0) return null;

  const published = selectVersion(versions, request.version);

  // Re-derive the published document from the ledger at its own watermark and
  // check the hash. Done on every load, not nightly: a reproducibility claim
  // the reader cannot see is a claim they have to take on faith.
  const verification = await verifyStatement(published.statementId, conn);
  if (verification === null) {
    throw new Error(
      `statement ${published.statementId} vanished between two reads in one transaction`,
    );
  }

  // ONE watermark for both halves of the comparison.
  //
  // Read first, then used as the ceiling for both the corrected rendering and
  // the itemised list. Letting the two reads take their own `MAX(booking_seq)`
  // would let an entry commit between them and appear in the explanation but
  // not in the figure it is supposed to explain — the delta would then fail to
  // reconcile against its own line items, on a screen whose entire job is to
  // show that it does.
  const nowWatermark = await currentWatermark(conn);

  const [correctedDocument, allLate] = await Promise.all([
    renderStatement({ ...period, bookingWatermark: nowWatermark }, conn),
    listLatePostings({ ...period, sinceWatermark: published.bookingWatermark }, conn),
  ]);

  const latePostings = allLate.filter((p) => p.bookingSeq <= nowWatermark);

  return {
    published,
    publishedDocument: verification.document,
    reproduced: verification.reproduced,
    correctedDocument,
    deltaCents:
      correctedDocument.closingBalanceCents - verification.document.closingBalanceCents,
    latePostings,
    versions,
  };
}

/**
 * v1 by default; the named version when it exists; the newest as a last resort.
 *
 * Falling back rather than throwing on an unknown version number is the same
 * call `parseBreakFilter` makes on the reconciliation screen: a mistyped URL
 * should show the real screen, because a 500 on a bad query string is a worse
 * answer than ignoring it.
 */
function selectVersion(
  versions: readonly PublishedStatement[],
  wanted: number | undefined,
): PublishedStatement {
  if (wanted !== undefined) {
    const named = versions.find((v) => v.version === wanted);
    if (named !== undefined) return named;
  }
  const first = versions[0];
  if (first === undefined) throw new Error("selectVersion called with no versions");
  return first;
}

/**
 * Does the itemised list account for the whole difference?
 *
 * Pure, so it is covered in CI without a database. Exported because the screen
 * renders the answer: an unexplained delta is shown as unexplained.
 */
export function explainsDelta(
  deltaCents: bigint,
  latePostings: readonly LatePosting[],
): boolean {
  const summed = latePostings.reduce((acc, p) => acc + p.signedCents, 0n);
  return summed === deltaCents;
}

/**
 * Group the late postings by correction group, oldest first within each.
 *
 * A reversal-and-rebook is ONE act that produced two or three entries, and an
 * operator asking "why is Tuesday different" wants the act. Entries with no
 * correction group — an ordinary late settlement that simply arrived after the
 * close — each stand alone, because they are each their own act.
 *
 * Pure. The grouping rule is a judgement about how corrections read, and it
 * belongs somewhere it can be argued with in a test rather than inside a
 * `GROUP BY`.
 */
export interface CorrectionGroup {
  /** `null` for an entry that is not part of a correction. */
  readonly correctionGroupId: string | null;
  readonly postings: readonly LatePosting[];
  readonly netCents: bigint;
  /** True when the group contains a reversal — the shape the brief asks for. */
  readonly isCorrection: boolean;
}

export function groupLatePostings(
  postings: readonly LatePosting[],
): readonly CorrectionGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, LatePosting[]>();

  for (const posting of postings) {
    // An entry with no correction group gets a key nothing can collide with,
    // so two unrelated late settlements never merge into one "act".
    const key =
      posting.correctionGroupId === null
        ? `entry:${posting.entryId}`
        : `group:${posting.correctionGroupId}`;
    const bucket = byKey.get(key);
    if (bucket === undefined) {
      order.push(key);
      byKey.set(key, [posting]);
    } else {
      bucket.push(posting);
    }
  }

  return order.map((key) => {
    const postingsInGroup = byKey.get(key) ?? [];
    const first = postingsInGroup[0];
    return {
      correctionGroupId: first?.correctionGroupId ?? null,
      postings: postingsInGroup,
      netCents: postingsInGroup.reduce((acc, p) => acc + p.signedCents, 0n),
      isCorrection: postingsInGroup.some(
        (p) => p.entryType === "reversal" || p.entryType === "rebook",
      ),
    };
  });
}
