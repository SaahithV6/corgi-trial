import type { ReactNode } from "react";

/**
 * Shared surfaces for the console.
 *
 * Every colour here is a token from globals.css, so light and dark are one
 * definition rather than two. Nothing in this file may name a colour.
 */

/**
 * The focus ring, in one place.
 *
 * Drawn in the text colour rather than the border colour: a focus indicator
 * has to clear 3:1 against its background in both themes, and the border
 * tokens are deliberately quiet enough that they would not.
 */
export const FOCUS_RING =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";

export type PanelProps = {
  readonly title: string;
  readonly description?: string;
  /** Heading level, so the page's outline stays true. Defaults to `h2`. */
  readonly as?: "h2" | "h3";
  readonly actions?: ReactNode;
  readonly children: ReactNode;
  readonly id?: string;
};

export function Panel({
  title,
  description,
  as = "h2",
  actions,
  children,
  id,
}: PanelProps) {
  const Heading = as;
  const headingId = id === undefined ? undefined : `${id}-title`;

  return (
    <section
      className="rounded-lg border border-border bg-surface"
      {...(id === undefined ? {} : { id })}
      {...(headingId === undefined ? {} : { "aria-labelledby": headingId })}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-border px-5 py-4">
        <div>
          <Heading
            className="text-sm font-semibold tracking-tight"
            {...(headingId === undefined ? {} : { id: headingId })}
          >
            {title}
          </Heading>
          {description === undefined ? null : (
            <p className="mt-1 max-w-prose text-xs text-muted">{description}</p>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="flex items-center gap-3">{actions}</div>
        )}
      </header>
      {children}
    </section>
  );
}

export type BadgeTone = "neutral" | "quiet" | "negative" | "positive";

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "border-border-strong text-text",
  quiet: "border-border text-muted",
  negative: "border-negative/50 text-negative",
  positive: "border-positive/50 text-positive",
};

export function Badge({
  tone = "quiet",
  children,
  title,
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly title?: string;
}) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] leading-4 font-medium ${BADGE_TONE[tone]}`}
      {...(title === undefined ? {} : { title })}
    >
      {children}
    </span>
  );
}

/** A muted label above a figure. Uppercase, tracked, small — a ledger caption. */
export function FieldLabel({ children }: { readonly children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
      {children}
    </span>
  );
}

/** A row of key/value provenance, e.g. `as of · watermark`. */
export function MetaList({
  items,
}: {
  readonly items: readonly { readonly label: string; readonly value: ReactNode }[];
}) {
  return (
    <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-xs text-muted">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt className="text-muted">{item.label}</dt>
          <dd className="text-text">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * An explanatory note attached to a number the viewer may not expect.
 *
 * `emphasis` raises the border to the negative token: used where a figure is
 * legitimately alarming and the screen has to say why before someone files a
 * bug against the ledger.
 */
export function Note({
  emphasis = false,
  title,
  children,
}: {
  readonly emphasis?: boolean;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`rounded-md border px-4 py-3 ${
        emphasis ? "border-negative/40 bg-surface-raised" : "border-border bg-surface-raised"
      }`}
    >
      <p
        className={`text-xs font-semibold ${emphasis ? "text-negative" : "text-text"}`}
      >
        {title}
      </p>
      <div className="mt-1 max-w-prose text-xs leading-relaxed text-muted">
        {children}
      </div>
    </div>
  );
}

/** Table shell: horizontal scroll lives here so the page body never scrolls sideways. */
export function TableScroll({ children }: { readonly children: ReactNode }) {
  return <div className="overflow-x-auto">{children}</div>;
}

export const TH_CLASS =
  "whitespace-nowrap px-5 py-2.5 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

export const TD_CLASS = "px-5 py-3 align-top text-sm";
