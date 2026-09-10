import Link from "next/link";

import { FOCUS_RING } from "@/components/ui/primitives";
import { BREAK_KIND_LABELS } from "@/lib/recon/types";

import type { BreakRow } from "./data-contract";
import { ALL_AGES, ALL_KINDS, breakHref, type BreakFilter } from "./view-state";

/**
 * Filters by category and by age.
 *
 * Plain links, not client state. Every filtered view therefore has a URL that
 * reproduces it, works with JavaScript disabled, and can be pasted into a
 * ticket — which is the actual use: "these are the four ACH breaks past two
 * closes, go and look".
 *
 * Each chip carries its own count, computed over the unfiltered list, so an
 * empty category is visibly empty rather than a chip you click to find out.
 * Selecting the chip that is already selected clears it, so there is no
 * separate "all" state to get out of sync.
 */
export function BreakFilters({
  filter,
  breaks,
}: {
  readonly filter: BreakFilter;
  readonly breaks: readonly BreakRow[];
}) {
  const kindCount = (kind: string): number =>
    breaks.filter((b) => b.kind === kind).length;
  const ageCount = (age: string): number =>
    breaks.filter((b) => b.ageBucket === age).length;

  return (
    <div className="space-y-3 border-b border-border px-5 py-4">
      <Group label="Category">
        <Chip
          href={breakHref(filter, { kind: null, selected: null })}
          current={filter.kind === null}
          count={breaks.length}
        >
          All
        </Chip>
        {ALL_KINDS.map((kind) => (
          <Chip
            key={kind}
            href={breakHref(filter, {
              kind: filter.kind === kind ? null : kind,
              selected: null,
            })}
            current={filter.kind === kind}
            count={kindCount(kind)}
          >
            {BREAK_KIND_LABELS[kind]}
          </Chip>
        ))}
      </Group>

      <Group label="Age">
        <Chip
          href={breakHref(filter, { age: null, selected: null })}
          current={filter.age === null}
          count={breaks.length}
        >
          Any
        </Chip>
        {ALL_AGES.map((age) => (
          <Chip
            key={age}
            href={breakHref(filter, {
              age: filter.age === age ? null : age,
              selected: null,
            })}
            current={filter.age === age}
            count={ageCount(age)}
          >
            {age === "31+" ? "31+ days" : `${age} days`}
          </Chip>
        ))}
      </Group>
    </div>
  );
}

function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="w-16 shrink-0 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  href,
  current,
  count,
  children,
}: {
  readonly href: string;
  readonly current: boolean;
  readonly count: number;
  readonly children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? "true" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${FOCUS_RING} ${
        current
          ? "border-border-strong bg-surface-raised font-medium text-text"
          : "border-border text-muted hover:text-text"
      } ${count === 0 && !current ? "opacity-55" : ""}`}
    >
      {children}
      <span className="tabular-nums text-[11px] text-muted">{count}</span>
    </Link>
  );
}
