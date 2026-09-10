import { Badge } from "@/components/ui/primitives";

/**
 * A sha256, shown the way a hash is actually used.
 *
 * Truncated to the first twelve and last four hex characters, monospaced, with
 * the whole 64 in `title` and in the accessible name. Twelve characters is 48
 * bits — enough that two documents on one screen colliding is not a thing that
 * happens, and short enough that a human can compare two of them by eye, which
 * is the only comparison this component exists to support.
 *
 * The full value stays in the DOM for anyone who selects it, because the point
 * of putting a hash on a screen is that somebody can take it away and check it.
 */
export function Hash({
  value,
  label,
}: {
  readonly value: string;
  readonly label?: string;
}) {
  const short =
    value.length <= 20 ? value : `${value.slice(0, 12)}…${value.slice(-4)}`;
  return (
    <span className="font-mono text-xs" title={value}>
      <span aria-hidden="true">{short}</span>
      <span className="sr-only">
        {label === undefined ? "" : `${label} `}
        {value}
      </span>
    </span>
  );
}

/**
 * Whether re-deriving the document reproduced its stored hash.
 *
 * Computed on this page load, against the live ledger, at the statement's own
 * frozen watermark. It is on the screen rather than in a nightly job because a
 * reproducibility guarantee the reader cannot see is a guarantee they have to
 * take on faith — and this whole screen exists to replace faith with a number.
 *
 * The failing case is deliberately loud, and it distinguishes the two things
 * that can cause it. A renderer change is a deployment fact. Anything else is
 * a P1: the inputs below a frozen watermark are immutable rows that the
 * application role physically cannot update.
 */
export function ReproductionBadge({
  reproduced,
  formatChanged,
}: {
  readonly reproduced: boolean;
  readonly formatChanged: boolean;
}) {
  if (reproduced) {
    return (
      <Badge tone="positive" title="Re-rendered from the ledger on this page load and hashed to the stored value">
        HASH REPRODUCED
      </Badge>
    );
  }
  if (formatChanged) {
    return (
      <Badge
        tone="quiet"
        title="This document was rendered by an earlier canonical renderer; the two hashes were never comparable"
      >
        RENDERER CHANGED
      </Badge>
    );
  }
  return (
    <Badge tone="negative" title="The re-rendered document does not hash to the stored value">
      HASH MISMATCH
    </Badge>
  );
}
