import { Badge, Note, Panel } from "@/components/ui/primitives";

import type { FindingRow, NameSource } from "./data-contract";
import { FindingList } from "./FindingList";
import { NAME_SOURCE_SENTENCE } from "./labels";

/**
 * The confirmation step itself — what a person sees between naming a
 * destination and the money leaving.
 *
 * Presentational and pure. It receives a decision that has already been made
 * by `verifyPayee()` and renders it; it does not decide anything, and it can
 * therefore never disagree with the row that gets written.
 *
 * ─── THE THREE SHAPES, AND WHY THEY LOOK DIFFERENT ─────────────────────────
 *
 * BLOCKED. No continue button exists in this branch — not disabled, ABSENT.
 * A disabled button says "you may not do this", which invites a person to
 * find out who can. There is nobody who can: the routing number is
 * arithmetically impossible, the database will not store it, and the only
 * route forward is different digits. The panel shows the arithmetic, because
 * a refusal somebody can check is a refusal they believe.
 *
 * WARNED. A continue path exists and it costs a sentence. The reason box is
 * required, the name that goes on it is the signed-in user's, and the whole
 * thing becomes an append-only row. Names legitimately differ — trading
 * names, subsidiaries, factoring companies — so a wall here would stop good
 * payments and would then be switched off. A signature does not.
 *
 * VERIFIED. Continue, with the notes still on the page rather than collapsed
 * behind a tick. What was and was not confirmed stays visible, because the
 * commonest failure of a feature like this is a green tick that a reader
 * takes to mean more than it says.
 */
export type ConfirmationView = {
  readonly decision: "verified" | "warned" | "blocked";
  readonly holderName: string;
  readonly routingNumber: string | null;
  readonly accountNumberLast4: string | null;
  readonly rail: string;
  readonly institutionName: string | null;
  readonly counterpartyName: string | null;
  readonly nameSource: NameSource | null;
  readonly nameMatchScore: number | null;
  readonly findings: readonly FindingRow[];
  /** Transposition repairs only. Never applied, only shown. */
  readonly suggestions: readonly string[];
};

export function ConfirmationStep({
  view,
  /** Rendered under the warning. The caller owns the form and the action. */
  acknowledgeForm,
  /** Rendered when the check is clean. The caller owns the submit. */
  continueAction,
}: {
  readonly view: ConfirmationView;
  readonly acknowledgeForm?: React.ReactNode;
  readonly continueAction?: React.ReactNode;
}) {
  const blocked = view.decision === "blocked";
  const warned = view.decision === "warned";

  return (
    <Panel
      title={
        blocked
          ? "This payment cannot be made"
          : warned
            ? "Check this before the money leaves"
            : "Destination checked"
      }
      description={`${view.holderName} · ${view.rail.toUpperCase()} ${view.routingNumber ?? ""}${
        view.accountNumberLast4 === null ? "" : ` ••${view.accountNumberLast4}`
      }`}
      actions={
        <Badge tone={blocked || warned ? "negative" : "positive"}>
          {blocked ? "BLOCKED" : warned ? "NEEDS A SIGNATURE" : "CHECKED"}
        </Badge>
      }
    >
      {blocked ? (
        <div className="px-5 py-4">
          <Note emphasis title="The routing number is arithmetically impossible">
            <p>
              There is no acknowledgement for this and no permission that grants it. The ninth
              digit of a routing number is chosen so that a weighted sum lands on a multiple of
              ten; this one does not, which means no bank has ever been issued it. The payee
              cannot be stored either — that is a database constraint, not a screen.
            </p>
            {view.suggestions.length > 0 ? (
              <p className="mt-2">
                Two adjacent digits look swapped. {view.suggestions.join(" or ")} would be valid
                — but confirm against the payee&rsquo;s own paperwork rather than taking a
                suggestion from us. Guessing which account to pay is worse than refusing.
              </p>
            ) : null}
          </Note>
        </div>
      ) : null}

      {warned ? (
        <div className="px-5 py-4">
          <Note emphasis title="You can send this. Somebody has to say why.">
            <p>
              Nothing below is impossible — it is unusual. Names legitimately differ: a supplier
              trading under one name and banking under another, a subsidiary paid into its
              parent&rsquo;s account, an invoice factored to a third party. A system that blocked
              on this would stop good payments, and would be switched off within a month.
            </p>
            <p className="mt-2">
              So it asks for a sentence instead. The sentence, your name and the time are kept
              against this exact check, and they are kept for good — the record is append-only.
              A new check raises a new warning and needs a new signature.
            </p>
          </Note>
        </div>
      ) : null}

      {view.counterpartyName !== null || view.nameSource !== null ? (
        <div className="border-t border-border px-5 py-4">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
            <dt className="text-xs uppercase tracking-[0.08em] text-muted">you typed</dt>
            <dd>{view.holderName}</dd>
            <dt className="text-xs uppercase tracking-[0.08em] text-muted">
              the account is held by
            </dt>
            <dd>
              {view.counterpartyName ?? (
                <span className="text-muted">
                  nobody can tell us — there is no second name to compare
                </span>
              )}
            </dd>
            {view.institutionName === null ? null : (
              <>
                <dt className="text-xs uppercase tracking-[0.08em] text-muted">at</dt>
                <dd>{view.institutionName}</dd>
              </>
            )}
          </dl>
          {view.nameSource === null ? null : (
            <p className="mt-3 max-w-prose text-xs leading-relaxed text-muted">
              {NAME_SOURCE_SENTENCE[view.nameSource]}
              {view.nameMatchScore === null
                ? ""
                : ` Similarity ${view.nameMatchScore} out of 100.`}
            </p>
          )}
        </div>
      ) : null}

      <div className="border-t border-border">
        <FindingList findings={view.findings} />
      </div>

      {/*
        A blocked check reaches neither branch, so there is no continue
        control in the markup at all. Not disabled — absent. A disabled
        button is an invitation to find somebody with the permission to
        enable it, and for arithmetic there is nobody.
      */}
      {warned && acknowledgeForm !== undefined ? (
        <div className="border-t border-border px-5 py-4">{acknowledgeForm}</div>
      ) : null}

      {!blocked && !warned && continueAction !== undefined ? (
        <div className="border-t border-border px-5 py-4">{continueAction}</div>
      ) : null}
    </Panel>
  );
}
