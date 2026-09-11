import Link from "next/link";
import type { Route } from "next";

import { Money } from "@/components/ui/Money";
import {
  Badge,
  FOCUS_RING,
  Note,
  Panel,
  TableScroll,
  TD_CLASS,
  TH_CLASS,
  type BadgeTone,
} from "@/components/ui/primitives";

import type { InvariantCard, InvariantSection } from "./data-contract";
import { VERDICT_ORDER, isUnexplained, type Verdict } from "./decided";

/**
 * SECTION 1 — Is anything wrong right now?
 *
 * ============================================================================
 * THE ONLY THING THIS PANEL DOES IS SEPARATE A RED THAT WAS DECIDED FROM A RED
 * THAT IS NEW. Everything else on it serves that.
 * ============================================================================
 *
 * Both are the same colour in a terminal and both are the same colour here,
 * because they are the same fact — a view that must return zero rows is
 * returning rows — and pretending otherwise with a green tick on the decided
 * ones would be the screen overruling the gate. What separates them is the
 * BAND they sit in and the argument printed underneath, and the bands are
 * ordered so that the thing nobody has explained is at the top of the page.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * There is no score, no percentage and no "health". The rank is
 * `VERDICT_ORDER` and nothing else, and within a band the order is the gate's
 * own list. Two unexplained reds are not ranked against each other, because
 * this screen has no way to know which of them matters more and inventing one
 * would be inventing a severity — the row count, the money and the age are all
 * printed so a person can make that call with the facts in front of them.
 */

const TONE: Record<Verdict, BadgeTone> = {
  unreadable: "negative",
  new: "negative",
  grown: "negative",
  decided: "negative",
  shrunk: "neutral",
  holding: "positive",
};

const BAND_TITLE: Record<Verdict, string> = {
  unreadable: "Could not be read",
  new: "Red, and nobody has argued for it",
  grown: "Decided — and it has grown since",
  decided: "Red, decided, with the argument attached",
  shrunk: "Decided — and somebody has repaired some of it",
  holding: "Holding",
};

const BAND_BLURB: Record<Verdict, string> = {
  unreadable:
    "An unreadable guard and a satisfied one are indistinguishable to anything that treats an exception as zero. This is never a pass and it is never folded into the counts below.",
  new:
    "These views are returning rows and are not on the register in src/components/dashboard/decided.ts. Nobody has written down why they stand. Start here.",
  grown:
    "The view is on the register, and it is returning MORE rows than the register witnessed. The excess is not covered by the argument — it is ranked here, with the new findings, rather than absorbed into a population that was accepted on a different day.",
  decided:
    "Each of these is red on purpose. The argument and the citation are printed with the count, the rows behind the count are one click away, and dbcheck reports the same four.",
  shrunk:
    "The view is on the register and is returning FEWER rows than it witnessed. Somebody repaired part of it, which means the watermark in decided.ts is stale and should be moved down — reported here rather than lowered at render time, because a literal that edits itself is how one repair buys permanent headroom.",
  holding: "Zero rows. Read the reach note where there is one: an empty population is not the same claim as a satisfied one.",
};

export function WrongNow({ section }: { readonly section: InvariantSection }) {
  const bands = VERDICT_ORDER.map((verdict) => ({
    verdict,
    cards: section.cards.filter((c) => c.classified.verdict === verdict),
  })).filter((band) => band.cards.length > 0);

  const t = section.tally;

  return (
    <Panel
      id="wrong-now"
      title="1 · Is anything wrong right now?"
      description="Every invariant view the gate checks, read at one instant, and split by whether somebody has already argued for the red."
      actions={
        <Link
          href={"/chaos" as Route}
          className={`text-xs underline underline-offset-4 hover:text-text ${FOCUS_RING}`}
        >
          Chaos harness
        </Link>
      }
    >
      <div className="space-y-5 px-5 py-4">
        <p className="max-w-prose text-sm leading-relaxed">{section.headline}</p>

        <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs">
          <Count label="views read" value={t.total} />
          <Count label="unreadable" value={t.unreadable} alarm={t.unreadable > 0} />
          <Count label="red, unexplained" value={t.unexplained} alarm={t.unexplained > 0} />
          <Count label="red, decided" value={t.decided} />
          <Count label="holding" value={t.holding} />
          <Count label="rows standing" value={t.standingRows} />
          <Count
            label="rows nobody has accounted for"
            value={t.unexplainedRows}
            alarm={t.unexplainedRows > 0}
          />
        </dl>

        <Note title="What this panel cannot see, and it is not a detail">
          <p>
            It reads <span className="money">SELECT count(*)</span> per view, through{" "}
            <code>readInvariants()</code> — the same list and the same reads the chaos
            dashboard uses. It does <strong>not</strong> read GUARD REACH, the population
            each view ranges over, which <code>node scripts/dbcheck.mjs</code> prints. A
            zero here is therefore a statement about the rows the view can see, and for
            several of these views that is smaller than the claim they make. Where a reach
            limit is written down, it is printed on the view&rsquo;s own row below rather
            than in this paragraph.
          </p>
          <p className="mt-2">
            The comparison point for &ldquo;decided&rdquo; is a literal in{" "}
            <code>src/components/dashboard/decided.ts</code>, witnessed by a named{" "}
            <code>dbcheck</code> run at a named instant. It is a watermark, not a
            measurement of the book: several branches write to this database and the
            standing populations move. That is why growth against it is reported as new
            and a shrink is reported as a stale watermark.
          </p>
        </Note>

        {bands.map((band) => (
          <section key={band.verdict} className="space-y-3">
            <header>
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em]">
                {BAND_TITLE[band.verdict]}{" "}
                <span className="text-muted">({band.cards.length})</span>
              </h3>
              <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
                {BAND_BLURB[band.verdict]}
              </p>
            </header>

            {band.verdict === "holding" ? (
              <HoldingTable cards={band.cards} />
            ) : (
              <div className="space-y-3">
                {band.cards.map((c) => (
                  <RedCard key={c.classified.view} card={c} />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </Panel>
  );
}

function Count({
  label,
  value,
  alarm = false,
}: {
  readonly label: string;
  readonly value: number;
  readonly alarm?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted">{label}</dt>
      <dd className={`money text-sm ${alarm ? "money-negative font-semibold" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * One red view, with the rows behind its count.
 *
 * The drill-through is the rule this screen is built to: a number you cannot
 * get to the rows of is a claim. Where a row names a hold, the identifier is a
 * link to that hold's own page. Where it does not — `v_advice_delta_unsound`
 * names an EVENT and there is no per-event screen in this build — the
 * identifier is printed as text and the panel says why, rather than linking
 * somewhere the row is not.
 */
function RedCard({ card }: { readonly card: InvariantCard }) {
  const c = card.classified;
  const decided = c.decided;

  return (
    <article className="rounded-md border border-border bg-surface-raised px-4 py-3">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h4 className="text-sm font-semibold">
          <code>{c.view}</code>
        </h4>
        <div className="flex items-center gap-2">
          {c.error === null ? (
            <Badge tone={TONE[c.verdict]}>
              {c.rows} row{c.rows === 1 ? "" : "s"}
            </Badge>
          ) : (
            <Badge tone="negative">unreadable</Badge>
          )}
          {c.witnessed === null ? null : (
            <Badge tone="quiet" title={`witnessed by dbcheck at ${decided?.witnessedAt ?? "?"}`}>
              register: {c.witnessed}
              {c.delta === null || c.delta === 0
                ? ""
                : c.delta > 0
                  ? ` (+${c.delta})`
                  : ` (${c.delta})`}
            </Badge>
          )}
        </div>
      </header>

      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{c.claim}</p>

      {c.error === null ? null : (
        <p className="mt-2 max-w-prose text-xs leading-relaxed money-negative">
          {c.error}
        </p>
      )}

      {decided === null ? null : (
        <div className="mt-3 space-y-1 border-l-2 border-border-strong pl-3">
          <p className="max-w-prose text-xs leading-relaxed">{decided.argument}</p>
          <p className="text-xs text-muted">
            Population: {decided.population}. Repairable:{" "}
            {decided.repairable === false ? "no" : decided.repairable}. Argument lives in{" "}
            <code>{decided.citation}</code>; witnessed at {decided.witnessedAt}.
          </p>
        </div>
      )}

      {c.reachLimit === null ? null : (
        <p className="mt-3 max-w-prose border-l-2 border-negative/40 pl-3 text-xs leading-relaxed text-muted">
          <span className="font-semibold money-negative">Reach: </span>
          {c.reachLimit}
        </p>
      )}

      {card.groups.length === 0 ? null : (
        <TableScroll>
          <table className="mt-3 w-full border-collapse text-left">
            <thead>
              <tr className="border-y border-border">
                <th className={TH_CLASS}>the view&rsquo;s own grouping</th>
                <th className={TH_CLASS}>rows</th>
                <th className={TH_CLASS}>holds</th>
                <th className={TH_CLASS}>Σ {card.groups[0]?.centsLabel ?? "cents"}</th>
              </tr>
            </thead>
            <tbody>
              {card.groups.map((g) => (
                <tr key={g.group} className="border-b border-border">
                  <td className={TD_CLASS}>
                    <code>{g.group}</code>
                  </td>
                  <td className={`${TD_CLASS} money`}>{g.rows}</td>
                  <td className={`${TD_CLASS} money`}>{g.holds ?? "—"}</td>
                  <td className={TD_CLASS}>
                    {g.cents === null ? "—" : <Money cents={g.cents} tone="neutral" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}

      {card.witnesses.length === 0 ? null : (
        <div className="mt-3">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
            {card.witnesses.length} of {c.rows} rows, so the count can be checked
          </p>
          <ul className="mt-1 space-y-1.5">
            {card.witnesses.map((w, i) => (
              <li key={`${w.providerAuthId ?? "row"}-${i}`} className="text-xs leading-relaxed">
                <span className="money">{w.group ?? "—"}</span>
                {" · "}
                {w.holdId === null ? (
                  <span className="money">{w.providerAuthId ?? "(no identifier)"}</span>
                ) : (
                  <Link
                    href={`/accounts/holds/${w.holdId}` as Route}
                    className={`money underline underline-offset-4 ${FOCUS_RING}`}
                  >
                    {w.providerAuthId ?? w.holdId}
                  </Link>
                )}
                {w.figures.map((f) => (
                  <span key={f.label}>
                    {" · "}
                    <span className="text-muted">{f.label} </span>
                    <Money cents={f.cents} tone="neutral" />
                  </span>
                ))}
                {w.detail === null ? null : (
                  <span className="text-muted"> · {w.detail}</span>
                )}
              </li>
            ))}
          </ul>
          {card.witnesses.every((w) => w.holdId === null) && c.rows > 0 ? (
            <p className="mt-1 max-w-prose text-xs text-muted">
              This view names an event, not a hold, and there is no per-event screen in
              this build — so the identifiers are printed rather than linked. They are the
              provider&rsquo;s own ids and they join straight into the audit trail and the
              provider dashboard.
            </p>
          ) : null}
        </div>
      )}

      {card.noWitnessReason === null ? null : (
        <p className="mt-3 max-w-prose border-l-2 border-border-strong pl-3 text-xs leading-relaxed text-muted">
          {card.noWitnessReason}
        </p>
      )}

      {isUnexplained(c.verdict) ? (
        <p className="mt-3 max-w-prose text-xs leading-relaxed">
          <span className="font-semibold">Nothing on this screen explains this.</span> It
          is not on the register, so no argument has been written for it. Either write one
          — with a citation — or repair it.
        </p>
      ) : null}
    </article>
  );
}

/** The quiet ones, as one table. Reach notes still print: a zero is not a claim. */
function HoldingTable({ cards }: { readonly cards: readonly InvariantCard[] }) {
  return (
    <TableScroll>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-y border-border">
            <th className={TH_CLASS}>view</th>
            <th className={TH_CLASS}>what it asserts</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((card) => (
            <tr key={card.classified.view} className="border-b border-border">
              <td className={TD_CLASS}>
                <code className="text-xs">{card.classified.view}</code>
              </td>
              <td className={TD_CLASS}>
                <p className="max-w-prose text-xs leading-relaxed">
                  {card.classified.claim}
                </p>
                {card.classified.reachLimit === null ? null : (
                  <p className="mt-1 max-w-prose border-l-2 border-negative/40 pl-3 text-xs leading-relaxed text-muted">
                    <span className="font-semibold money-negative">Reach: </span>
                    {card.classified.reachLimit}
                  </p>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
