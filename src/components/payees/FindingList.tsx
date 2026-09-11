import { Badge } from "@/components/ui/primitives";

import type { FindingRow } from "./data-contract";
import { SEVERITY_LABEL, SEVERITY_TONE } from "./labels";

/**
 * What a check found, in severity order.
 *
 * Blocks first, then warnings, then notes — which is also the order of how
 * much they cost the reader, and the order the screen wants somebody to read
 * them in when they are deciding whether to sign.
 *
 * The severity chip is a word and not a colour alone. A payments screen gets
 * read on a laptop in a room with the blinds up by somebody who may not
 * distinguish the two reds, and "NEEDS A SIGNATURE" is unambiguous where a
 * tint is not.
 */
const ORDER: Record<FindingRow["severity"], number> = { block: 0, warn: 1, note: 2 };

export function FindingList({ findings }: { readonly findings: readonly FindingRow[] }) {
  if (findings.length === 0) {
    return (
      <p className="px-5 py-4 text-xs text-muted">
        No check has been run against this payee, so there is nothing to report — which is not
        the same as nothing being wrong.
      </p>
    );
  }

  const sorted = [...findings].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);

  return (
    <ul className="divide-y divide-border">
      {sorted.map((finding) => (
        <li key={finding.code} className="px-5 py-4">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <Badge tone={SEVERITY_TONE[finding.severity]}>
              {SEVERITY_LABEL[finding.severity]}
            </Badge>
            <h4 className="text-sm font-medium">{finding.title}</h4>
            <code className="text-[11px] text-muted">{finding.code}</code>
          </div>
          <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-muted">
            {finding.detail}
          </p>
        </li>
      ))}
    </ul>
  );
}
