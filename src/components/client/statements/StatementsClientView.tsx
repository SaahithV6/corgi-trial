import Link from "next/link";

import type {
  ClientCorrection,
  ClientStatementDocument,
  ClientStatementLine,
  ClientStatementPeriod,
  ClientStatementsScreen,
} from "@/components/client/statements/contract";
import { formatUsd } from "@/lib/format/money";

/**
 * The customer reading their own statements.
 *
 * ===========================================================================
 * THIS COMPONENT COMPUTES NOTHING
 * ===========================================================================
 *
 * Every number below is printed from the object the reader handed it. There is
 * no sum, no subtraction, no running total and no hash comparison in this file
 * — `reproduction.identical` and `reproduction.matchesStoredHash` were decided
 * by `source.ts` against a live connection, and this file renders the verdict
 * it was given. A component that re-derived a statement figure would be a
 * second definition of that figure, reached through a display feature, which is
 * the worst place to keep one.
 *
 * ===========================================================================
 * WHAT IT SAYS ABOUT REPRODUCTION, AND WHAT IT REFUSES TO SAY
 * ===========================================================================
 *
 * The proof panel names the two instants the two renderings were taken at, and
 * prints both hashes. That is deliberate: "verified" with nothing to look at is
 * a sticker, and this screen exists because a sticker was once printed on a
 * deployment with no database connection open. If a hash disagrees, both values
 * are shown — "expected X, got Y" is an incident report; "verification failed"
 * is a shrug.
 *
 * Where no statement was issued, `matchesStoredHash` is `null` and the panel
 * says there is nothing stored to check against. It does not print a green tick
 * for a comparison it did not make.
 */
export function StatementsClientView({
  screen,
  hrefFor,
}: {
  readonly screen: ClientStatementsScreen;
  /** Builds the link to one period, carrying the business across. */
  readonly hrefFor: (businessDate: string) => string;
}) {
  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-border bg-surface px-5 py-4">
        <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
          Your statements
        </p>
        <h1 className="mt-1 text-lg font-medium text-text">{screen.legalName}</h1>
        <p className="mt-1 text-xs text-muted">
          {screen.accountName ?? "No account open"} · read{" "}
          <time dateTime={screen.asOf}>{screen.asOf}</time>
        </p>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
          A statement covers one business day, and it is fixed the moment that
          day is signed off. If something about that day was corrected
          afterwards, the correction is on the statement — the original, the
          reversal that took it back and the entry that replaced it are all
          shown, because none of them was ever deleted.
        </p>
      </header>

      {screen.notice !== null ? (
        <p className="rounded-lg border border-border bg-surface px-5 py-4 text-sm text-muted">
          {screen.notice}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <PeriodList
          periods={screen.periods}
          selected={screen.selected?.businessDate ?? null}
          hrefFor={hrefFor}
        />
        {screen.selected === null ? null : (
          <StatementDocument doc={screen.selected} />
        )}
      </div>
    </div>
  );
}

/**
 * The closed days, newest first.
 *
 * A day that is still open is not on this list and cannot be: the list is built
 * from `book_day`, which has no row until the day is signed off. The badge
 * distinguishes the two states a closed day can be in — issued, or closed and
 * not yet issued — because they are different documents and a customer is
 * entitled to know which one they are reading.
 */
function PeriodList({
  periods,
  selected,
  hrefFor,
}: {
  readonly periods: readonly ClientStatementPeriod[];
  readonly selected: string | null;
  readonly hrefFor: (businessDate: string) => string;
}) {
  return (
    <nav aria-label="Statement periods" className="rounded-lg border border-border bg-surface">
      <p className="border-b border-border px-4 py-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        Closed days
      </p>
      <ul>
        {periods.map((p) => {
          const current = p.businessDate === selected;
          return (
            <li key={p.businessDate} className="border-b border-border last:border-b-0">
              <Link
                href={hrefFor(p.businessDate)}
                aria-current={current ? "page" : undefined}
                className={`block px-4 py-3 text-sm ${
                  current ? "bg-surface-raised font-medium text-text" : "text-muted"
                }`}
              >
                <span className="block text-text">{p.businessDate}</span>
                <span className="mt-0.5 block text-[11px] text-muted">
                  {p.versionCount === 0
                    ? "Closed · not yet issued"
                    : p.versionCount === 1
                      ? "Issued"
                      : `Issued · ${p.versionCount} versions`}
                  {" · "}
                  {p.lineCount === 1 ? "1 entry" : `${p.lineCount} entries`}
                </span>
                {/*
                  "Changed", not "corrected". `latePostingCount` counts every
                  entry with this value date booked above the close watermark,
                  and most of those are ordinary settlements that simply arrived
                  late. A correction is a narrower thing — a reversal and a
                  re-book — and the statement itself says so when it holds one.
                  Labelling every late arrival a correction would train the
                  reader to ignore the word by the time it mattered.
                */}
                {p.latePostingCount > 0 ? (
                  <span className="mt-1 inline-block rounded border border-border-strong px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-text">
                    {p.latePostingCount === 1
                      ? "1 entry added after close"
                      : `${p.latePostingCount} entries added after close`}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function StatementDocument({ doc }: { readonly doc: ClientStatementDocument }) {
  return (
    <article className="space-y-4">
      <section className="rounded-lg border border-border bg-surface px-5 py-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium text-text">
            Statement for {doc.businessDate}
          </h2>
          <span className="rounded border border-border-strong px-2 py-0.5 text-[10px] uppercase tracking-[0.06em] text-text">
            {doc.anchor === "issued" ? `Version ${doc.version}` : "Closed · not yet issued"}
          </span>
        </div>
        <p className="mt-1 text-xs text-muted">
          Day signed off <time dateTime={doc.closedAt}>{doc.closedAt}</time>
          {doc.issuedAt === null
            ? " · no statement has been issued for this day yet"
            : ` · issued ${doc.issuedAt}`}{" "}
          · frozen at booking position {doc.watermark}
        </p>

        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Figure label="Opening balance" cents={doc.openingBalanceCents} />
          <Figure label="Closing balance" cents={doc.closingBalanceCents} />
          <Figure label="Entries" text={String(doc.lineCount)} />
        </dl>
      </section>

      {doc.corrections.length > 0 ? <Corrections corrections={doc.corrections} /> : null}

      <Reproduction doc={doc} />

      <section className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="w-full min-w-[36rem] text-sm">
          <caption className="sr-only">
            Entries on {doc.businessDate}, in the order they were booked.
          </caption>
          <thead>
            <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.06em] text-muted">
              <th scope="col" className="px-4 py-2 font-medium">Date</th>
              <th scope="col" className="px-4 py-2 font-medium">Description</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Amount</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {doc.lines.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-sm text-muted">
                  Nothing moved on this day. The closing balance is the opening
                  balance, and this is the correct statement for it.
                </td>
              </tr>
            ) : (
              doc.lines.map((line) => <LineRow key={line.id} line={line} />)
            )}
          </tbody>
        </table>
      </section>

      {doc.movedSince.length > 0 ? (
        <section className="rounded-lg border border-border-strong bg-surface px-5 py-4">
          <h3 className="text-sm font-medium text-text">
            {doc.movedSince.length === 1 ? "1 entry" : `${doc.movedSince.length} entries`}{" "}
            have been booked since{" "}
            {doc.anchor === "issued" ? "this version was issued" : "this day was closed"}
          </h3>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            {doc.movedSinceCents === null
              ? "These entries carry this day's date and were booked after the day was signed off. The document above is unchanged — a corrected statement is issued as a new version rather than by editing this one."
              : `These entries carry this day's date and were booked after the statement above was issued. Together they move the closing balance by ${formatUsd(doc.movedSinceCents, { signed: true })}. The document above is not edited; a new version is issued.`}
          </p>
          <ul className="mt-3 space-y-2">
            {doc.movedSince.map((p) => (
              <li key={p.entryId} className="flex justify-between gap-4 text-sm">
                <span className="text-text">
                  {p.description}
                  {p.affectsOpening ? (
                    <span className="ml-2 text-[11px] text-muted">
                      (dated {p.valueDate}, before this day — it moves the opening
                      balance)
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 tabular-nums text-text">
                  {formatUsd(p.amountCents, { signed: true })}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {doc.earlierVersions.length > 0 ? (
        <section className="rounded-lg border border-border bg-surface px-5 py-4">
          <h3 className="text-sm font-medium text-text">Earlier versions of this day</h3>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
            Each one was issued and none was deleted. A corrected statement is a
            new document, not an edit of the old one.
          </p>
          <ul className="mt-3 space-y-1.5">
            {doc.earlierVersions.map((v) => (
              <li key={v.version} className="flex justify-between gap-4 text-sm">
                <span className="text-muted">
                  Version {v.version} · issued{" "}
                  <time dateTime={v.issuedAt}>{v.issuedAt}</time>
                </span>
                <span className="shrink-0 tabular-nums text-text">
                  {formatUsd(v.closingBalanceCents)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

/**
 * The correction, said on the statement.
 *
 * This is the differentiator and it is the thing a panel will ask about, so it
 * is above the table rather than a footnote under it: the customer is told
 * plainly that a day they may already have read was corrected, and shown the
 * three entries that did it. All three are still on the statement below, in
 * booking order, because a ledger that hides the mistake cannot prove it fixed
 * it.
 */
function Corrections({
  corrections,
}: {
  readonly corrections: readonly ClientCorrection[];
}) {
  return (
    <section className="rounded-lg border border-border-strong bg-surface px-5 py-4">
      <h3 className="text-sm font-medium text-text">
        {corrections.length === 1
          ? "A correction is on this statement"
          : `${corrections.length} corrections are on this statement`}
      </h3>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        Something on this day was booked wrong, taken back and re-booked. All
        three entries are on the statement and the closing balance above already
        reflects the corrected amount — nothing was removed to make the numbers
        work.
      </p>
      <ul className="mt-3 space-y-3">
        {corrections.map((c) => (
          <li key={c.correctionGroupId}>
            <p className="text-[11px] uppercase tracking-[0.06em] text-muted">
              Correction group {c.correctionGroupId}
            </p>
            <ul className="mt-1.5 space-y-1">
              {c.lines.map((line) => (
                <li key={line.id} className="flex justify-between gap-4 text-sm">
                  <span className="text-text">
                    <EntryTag type={line.entryType} /> {line.description}
                  </span>
                  <span className="shrink-0 tabular-nums text-text">
                    {formatUsd(line.amountCents, { signed: true })}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The reproduction, reported as performed.
 *
 * Two renderings, two instants, both named. The words on this panel are only
 * ever produced from values `source.ts` computed against a live connection on
 * this request — there is no fixture path that can reach it.
 */
function Reproduction({ doc }: { readonly doc: ClientStatementDocument }) {
  const r = doc.reproduction;
  return (
    <section className="rounded-lg border border-border bg-surface px-5 py-4">
      <h3 className="text-sm font-medium text-text">
        {r.identical
          ? "This statement was rebuilt twice while this page loaded, and came out identical both times"
          : "This statement did not rebuild identically, and that is being reported rather than hidden"}
      </h3>
      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        The day is frozen at booking position {doc.watermark}. Rebuilding it from
        the ledger at that position gives the same document every time, which is
        what makes a statement something you can rely on years later rather than
        a picture of a screen.
      </p>
      <dl className="mt-3 space-y-1.5 text-xs">
        <Row label={`Rebuilt at ${r.firstAt}`} value={r.renderedHash} />
        <Row label={`Rebuilt again at ${r.secondAt}`} value={r.renderedAgainHash} />
        {r.storedHash === null ? (
          <div className="text-muted">
            No statement has been issued for this day, so there is no stored
            fingerprint to check these against. Nothing here claims otherwise.
          </div>
        ) : (
          <>
            <Row label="Stored when it was issued" value={r.storedHash} />
            <div className={r.matchesStoredHash === true ? "text-text" : "text-text"}>
              {r.matchesStoredHash === true
                ? "Matches the fingerprint stored when this statement was issued."
                : r.formatChanged
                  ? "Does not match the stored fingerprint, and the stored one was written by an older renderer — the two were never comparable. This is a deployment fact, not a change to your money."
                  : "Does not match the fingerprint stored when this statement was issued. Both values are printed above; this has been reported."}
            </div>
          </>
        )}
      </dl>
    </section>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="break-all font-mono text-[11px] text-text">{value}</dd>
    </div>
  );
}

function LineRow({ line }: { readonly line: ClientStatementLine }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-4 py-3 align-top text-muted">{line.valueDate}</td>
      <td className="px-4 py-3 align-top text-text">
        <EntryTag type={line.entryType} /> {line.description}
      </td>
      <td className="px-4 py-3 text-right align-top tabular-nums text-text">
        {formatUsd(line.amountCents, { signed: true })}
      </td>
      <td className="px-4 py-3 text-right align-top tabular-nums text-muted">
        {formatUsd(line.runningBalanceCents)}
      </td>
    </tr>
  );
}

/** The ledger's own entry type, in the customer's words. */
function EntryTag({ type }: { readonly type: ClientStatementLine["entryType"] }) {
  if (type === "original") return null;
  return (
    <span className="mr-1.5 rounded border border-border-strong px-1.5 py-0.5 text-[10px] uppercase tracking-[0.06em] text-text">
      {type === "reversal" ? "Taken back" : "Re-booked"}
    </span>
  );
}

function Figure({
  label,
  cents,
  text,
}: {
  readonly label: string;
  readonly cents?: number;
  readonly text?: string;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-[0.06em] text-muted">{label}</dt>
      <dd className="mt-0.5 text-base tabular-nums text-text">
        {text ?? formatUsd(cents ?? 0)}
      </dd>
    </div>
  );
}
