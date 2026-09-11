"use client";

import { useState, useTransition } from "react";

import {
  statementPdfAction,
  type StatementPdfResult,
} from "@/app/(app)/statements/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

import type { BothReadingsView } from "./data-contract";
import type { StatementFilter } from "./view-state";

/**
 * The way off this screen and into somebody else's inbox.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SCREEN IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 *
 * Everything around this control is the strongest thing in the module: a value
 * date re-derived from the journal on this page load, hashed, and shown beside
 * the figure a customer was actually told. None of it can be forwarded to an
 * accountant, attached to a filing, or read by somebody who was not at the
 * demo, because it exists only inside a React tree.
 *
 * The PDF is the same two readings — the same `renderStatement()` calls, the
 * same watermarks, the same `formatUsd` — serialised into the one format that
 * survives being emailed. It is generated from the ledger when this button is
 * pressed and never transcribed, which is the brief's document rule, and it
 * prints its own arithmetic so a reader can add the column up and land on the
 * closing figure.
 *
 * ---------------------------------------------------------------------------
 * WHY A BUTTON AND NOT A LINK
 * ---------------------------------------------------------------------------
 *
 * A `GET /statements/document.pdf` would be nicer and it is not what this
 * build has; the reason is written at the top of
 * `src/app/(app)/statements/actions.ts` and it is about not defeating the
 * front door's completeness test on purpose. The file that lands in Downloads
 * is identical either way, which is the part that matters.
 *
 * ---------------------------------------------------------------------------
 * IT CARRIES THIS SCREEN'S EXACT STATE
 * ---------------------------------------------------------------------------
 *
 * Account, value date, version and anchor all travel with the request, taken
 * from the RESOLVED view rather than the raw filter — the screen may have
 * fallen back to a different day or a weaker anchor than the URL asked for,
 * and the document has to be the one that is on the page. A reader who wants a
 * different anchor moves the anchor first and presses this again.
 */
export function StatementPdfLink({
  view,
  filter,
}: {
  readonly view: BothReadingsView;
  readonly filter: StatementFilter;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<StatementPdfResult | null>(null);

  function generate(): void {
    setResult(null);
    start(async () => {
      const produced = await statementPdfAction({
        ...(filter.accountId === null ? {} : { accountId: filter.accountId }),
        businessDate: view.valueDate,
        anchor: view.anchor,
        ...(view.published === null ? {} : { version: view.published.version }),
      });
      setResult(produced);
      if (produced.ok) save(produced.base64, produced.filename);
    });
  }

  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <p className="text-xs font-medium">
            Both readings, as a PDF an accountant can file
          </p>
          <p className="mt-0.5 max-w-prose text-[11px] leading-relaxed text-muted">
            Generated from the journal when you press this, never transcribed.
            Opening balance, every movement, closing balance, and the arithmetic
            that closes both loops:{" "}
            {view.differs
              ? "the day’s own, and as published + the later acts = as corrected."
              : "the day’s own, and both readings agreeing because nothing has landed above the watermark."}
          </p>
        </div>
        <button
          type="button"
          onClick={generate}
          disabled={pending}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border-strong bg-surface-raised px-3 py-1.5 text-xs font-medium ${FOCUS_RING} hover:bg-surface disabled:opacity-60`}
        >
          {pending ? "Generating from the ledger…" : "Download statement PDF"}
        </button>
      </div>

      {result === null ? null : result.ok ? (
        <p className="mt-2.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-muted">
          <span className="font-medium text-text">{result.filename}</span> —{" "}
          {result.byteLength.toLocaleString("en-US")} bytes, value date{" "}
          {result.valueDate}, read at booking watermarks {result.believedWatermark}{" "}
          and {result.correctedWatermark}. Document fingerprint{" "}
          <code className="tabular-nums">{result.fingerprint.slice(0, 16)}</code> — a
          sha256 over both readings&rsquo; own content hashes, so the same two
          watermarks always produce the same file.
        </p>
      ) : (
        <p className="mt-2.5 border-t border-border pt-2.5 text-[11px] leading-relaxed text-negative">
          {result.message}
        </p>
      )}
    </div>
  );
}

/**
 * Hand the browser the bytes as a file.
 *
 * A blob URL and a synthetic click, rather than a `data:` href: Chrome blocks
 * top-level navigation to `data:` URLs, and a download that works in one
 * browser and silently does nothing in another is worse than no button. The
 * object URL is revoked on the next tick — before that the download has not
 * necessarily started, and after it the blob is a leak that survives until the
 * tab closes.
 */
function save(base64: string, filename: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
