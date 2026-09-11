"use client";

import { useActionState, useId, useState } from "react";

import {
  importAndRunAction,
  rerunReconciliationAction,
} from "@/app/(app)/reconciliation/actions";
// Not from the action module: a `"use server"` file exports only server
// references, so importing a plain object from one hands the client a stub.
import {
  RECON_RUN_IDLE,
  type ReconRunResult,
} from "@/components/recon/run-action-result";
import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";

/**
 * The two ways an operator starts a reconciliation, and what they are careful
 * not to claim.
 *
 * 1. A RUN IS NOT A FIX. Both buttons report; neither corrects anything. The
 *    receipt says "found N breaks", never "reconciled", unless the run's break
 *    count is actually zero — that word is earned by the number on the render
 *    that prints it or it is not written.
 *
 * 2. NEITHER BUTTON MOVES MONEY, which is why neither is type-to-confirm. A
 *    run reads the book and appends its findings beside it; the worst outcome
 *    of a mis-press is one more immutable row in the run history saying the
 *    same thing as the row above it. Friction here would be friction spent in
 *    the wrong place.
 *
 * 3. THEY ARE HIDDEN WHEN THEY WOULD LIE. On a fixture demo state, or with no
 *    database configured, there is no real file to run and no book to run it
 *    against, so the panel is replaced by the sentence saying so. A button that
 *    posts into a deployment with nothing behind it is worse than no button.
 *
 * 4. THE REFUSALS NAME THEIR REMEDY. `NO_ACTOR` says to pick an actor on
 *    /approvals; `NOT_A_SETTLEMENT_FILE` prints the header line the parser
 *    wants; `RECON_RUN_FAILED` after a successful import says the file does not
 *    need uploading again. A code with no next step is a dead end.
 */

const BUTTON = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;
const INPUT = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";

function Receipt({ result }: { readonly result: ReconRunResult }) {
  if (result.status === "idle") return null;
  return (
    <Note emphasis={result.status === "failed"} title={result.code ?? "Result"}>
      <p>{result.message}</p>
      {result.facts.length === 0 ? null : (
        <dl className="mt-2 flex flex-col gap-1">
          {result.facts.map((fact) => (
            <div key={fact.label} className="flex flex-wrap items-baseline gap-2">
              <dt className="text-[11px] uppercase tracking-[0.08em] text-muted">{fact.label}</dt>
              <dd className={fact.mono === true ? "font-mono text-[11px] text-text" : "text-[11px] text-text"}>
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {result.href === null ? null : (
        <p className="mt-2">
          <a className="underline underline-offset-4" href={result.href}>
            Open this run
          </a>{" "}
          &mdash; its breaks, its rejects and the file row behind each one.
        </p>
      )}
    </Note>
  );
}

/** Reconcile the file on screen against the book as it stands now. */
function Rerun({
  fileId,
  filename,
  runNo,
}: {
  readonly fileId: string;
  readonly filename: string;
  readonly runNo: number;
}) {
  const [result, action, pending] = useActionState(rerunReconciliationAction, RECON_RUN_IDLE);

  return (
    <form action={action} className="space-y-3 px-5 py-4">
      <input type="hidden" name="fileId" value={fileId} />
      <p className="max-w-prose text-xs leading-relaxed text-muted">
        Matches <span className="font-mono text-[11px]">{filename}</span> against the book as it
        stands at this moment and writes run #{runNo + 1}. Run #{runNo} is not touched: a break
        it reported stays reported there for as long as anyone asks what was open that night.
        Use this after a correcting entry has posted, to find out whether the file and the book
        now agree.
      </p>
      <button className={BUTTON} type="submit" disabled={pending}>
        {pending ? "Matching the file against the book…" : "Run this file again"}
      </button>
      <Receipt result={result} />
    </form>
  );
}

/** Import a settlement file that is not on record yet, and run it. */
function ImportAndRun() {
  const [result, action, pending] = useActionState(importAndRunAction, RECON_RUN_IDLE);
  const [chosen, setChosen] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState<string | null>(null);
  const id = useId();

  // Submitting clears the file input — the browser resets it — so the line
  // below it must clear too. Left alone it went on naming a file next to a
  // control reading "No file chosen", which is a small version of exactly the
  // thing this screen exists to avoid: a caption disagreeing with the state it
  // captions. `result.at` changes once per completed submission, so this
  // adjusts state during render rather than in an effect.
  if (result.at !== shownFor) {
    setShownFor(result.at);
    if (chosen !== null) setChosen(null);
  }

  return (
    <form action={action} className="space-y-3 px-5 py-4">
      <div>
        <label className={LABEL} htmlFor={`${id}-file`}>
          Settlement file
        </label>
        <input
          className={INPUT}
          id={`${id}-file`}
          name="file"
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          onChange={(event) => {
            const picked = event.target.files?.[0];
            setChosen(picked === undefined ? null : `${picked.name} · ${picked.size} bytes`);
          }}
        />
        <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-muted">
          The provider&rsquo;s nightly file, exactly as it arrived. It is hashed as given and
          never normalised, so a trailing newline is part of its identity. Re-uploading bytes
          already on record does not make a second copy — it runs them again, which is a
          different question with a possibly different answer.
        </p>
        {chosen === null ? null : (
          <p className="mt-1 font-mono text-[11px] text-text">{chosen}</p>
        )}
      </div>
      <button className={BUTTON} type="submit" disabled={pending}>
        {pending ? "Importing and matching…" : "Import this file and reconcile it"}
      </button>
      <Receipt result={result} />
    </form>
  );
}

/**
 * The run panel.
 *
 * `runnable` is decided by the page, from the same one value that picks the
 * LIVE / FIXTURE badge and the refusal wording, so this panel cannot offer a
 * run on a screen that is showing a drawing.
 */
export function RunControls({
  runnable,
  current,
}: {
  readonly runnable: boolean;
  /**
   * The run on screen, or `null` when nothing has been reconciled yet.
   *
   * `null` is not an error state: it is the first night, and it is the one
   * moment when importing a file is the only thing an operator can usefully
   * do. The re-run form is omitted rather than shown pointing at nothing.
   */
  readonly current: {
    readonly fileId: string;
    readonly filename: string;
    readonly runNo: number;
  } | null;
}) {
  if (!runnable) {
    return (
      <Panel
        title="Running a reconciliation"
        description="Not available on this screen."
        actions={<Badge tone="quiet">unavailable</Badge>}
      >
        <p className="max-w-prose px-5 py-4 text-xs leading-relaxed text-muted">
          The figures above are a fixture, or no database is configured. There is no file to
          import and no book to match it against, so no run can be started from here. Clear the
          demo state on the bar above, on a deployment with a database, and the controls appear.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Run a reconciliation"
      description="A run appends. It never revises an earlier one, and it never corrects the book."
      actions={<Badge tone="neutral">writes recon_run</Badge>}
    >
      {current === null ? null : (
        <>
          <Rerun
            fileId={current.fileId}
            filename={current.filename}
            runNo={current.runNo}
          />
          <div className="border-t border-border" />
        </>
      )}
      <ImportAndRun />
    </Panel>
  );
}
