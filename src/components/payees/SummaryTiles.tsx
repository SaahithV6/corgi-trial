import { FieldLabel } from "@/components/ui/primitives";

import type { PayeeRow, RefusalRowView } from "./data-contract";

/**
 * Four counts, chosen so that the two interesting ones are impossible to miss.
 *
 * Not "how many payees do you have" — that is a number nobody acts on. These
 * are the four questions a payments lead asks about a payee book on a Monday
 * morning, in the order they matter:
 *
 *   * how many warnings is nobody carrying the can for;
 *   * how many payees has nobody looked at this quarter;
 *   * how many typos did the arithmetic stop;
 *   * how many of these checks were actually answered by a third party.
 */
function Tile({
  label,
  value,
  note,
  emphasis = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly note: string;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="bg-surface px-5 py-4">
      <FieldLabel>{label}</FieldLabel>
      <p
        className={`mt-1.5 text-2xl font-semibold tabular-nums ${
          emphasis ? "text-negative" : "text-text"
        }`}
      >
        {value}
      </p>
      <p className="mt-1.5 max-w-prose text-[11px] leading-relaxed text-muted">{note}</p>
    </div>
  );
}

export function SummaryTiles({
  rows,
  refusals,
}: {
  readonly rows: readonly PayeeRow[];
  readonly refusals: readonly RefusalRowView[];
}) {
  const live = rows.filter((r) => !r.archived);
  const unsigned = live.filter((r) => r.outcome === "warned" && !r.acknowledged).length;
  const unchecked = live.filter(
    (r) => r.freshness === "stale" || r.freshness === "never",
  ).length;
  const liveEvidence = live.filter((r) => r.evidence === "live").length;

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
      <Tile
        label="unsigned warnings"
        value={String(unsigned)}
        emphasis={unsigned > 0}
        note="Payments to these are refused until somebody records why the difference is right. The warning is overridable; the override is not implicit."
      />
      <Tile
        label="stale or unchecked"
        value={String(unchecked)}
        emphasis={unchecked > 0}
        note="Last checked over 90 days ago, or never. Payments still go out — age is surfaced, not gated."
      />
      <Tile
        label="typos caught"
        value={String(refusals.length)}
        note="Routing numbers the check digit refused. None of these became a payee; each is a row that says what was typed."
      />
      <Tile
        label="checks a provider answered"
        value={`${liveEvidence}/${live.length}`}
        note="Checks where a real third party answered a real call. The rest ran on local arithmetic only, and say so."
      />
    </div>
  );
}
