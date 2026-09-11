"use client";

import { useActionState } from "react";

import { recheckPayeeAction, type ConfirmResult } from "@/app/(app)/payees/actions";
import { FOCUS_RING, Note } from "@/components/ui/primitives";

import { ConfirmationResult } from "./ConfirmationResult";

/**
 * Check a payee that is already on the book, again.
 *
 * ─── WHY THIS BUTTON EXISTS AT ALL ─────────────────────────────────────────
 *
 * Because freshness here is DERIVED and not stamped. `v_payee_book` reads the
 * age of the newest `payee_verification` row against `now()` and labels it
 * fresh / ageing / stale; there is no `is_verified` column anywhere in this
 * feature and there could not be, because a stored flag has to be re-stamped
 * by something and the thing that re-stamps it is the thing that eventually
 * does not. The only way to make a check current is to run another one and
 * append it.
 *
 * So "a book that was confirmed months ago can be confirmed again without a
 * new payee" is not a convenience — it is the only operation that can move a
 * payee out of `stale`, and without it the bands were a label nobody could
 * act on.
 *
 * ─── NOTHING ABOUT THE BENEFICIARY IS RE-ENTERED ───────────────────────────
 *
 * There are no fields here on purpose. The details come out of the row, so a
 * re-check can mean "the same details, checked again today" and mean it
 * exactly. A form that re-keyed the bank details in order to re-check them
 * would make every re-check an opportunity to change them, which is the one
 * thing a re-check must not be: an unnoticed edit wearing the word "verify".
 *
 * Changing a beneficiary's bank details is adding a payee, and it goes through
 * the arithmetic and the twin probe as new details — which is what raises
 * `TWIN_WITH_DIFFERENT_DETAILS` and puts a person in front of it.
 *
 * ─── AND IT APPENDS ────────────────────────────────────────────────────────
 *
 * Today's answer is a new row. The previous check stays on the book exactly as
 * it was recorded, including its findings and whoever signed for them. The
 * signature does NOT carry over: an acknowledgement is attached to the check
 * it answered, so a re-check that raises a warning needs a new signature, and
 * a payment is refused until it has one. That is deliberate — a signature from
 * June says nothing about what was found this morning.
 */

const IDLE: ConfirmResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  receipt: null,
};

export function RecheckForm({
  payeeId,
  acknowledged,
}: {
  readonly payeeId: string;
  /** Whether a signature currently stands. It will not survive the re-check. */
  readonly acknowledged: boolean;
}) {
  const [state, formAction, pending] = useActionState(recheckPayeeAction, IDLE);

  return (
    <div className="space-y-4">
      <form action={formAction} className="flex flex-wrap items-center gap-4">
        <input type="hidden" name="payeeId" value={payeeId} />
        <button
          type="submit"
          disabled={pending}
          className={`rounded border border-border-strong px-3 py-1.5 text-sm font-medium ${FOCUS_RING} disabled:opacity-50`}
        >
          {pending ? "Running the check" : "Re-check this payee"}
        </button>
        <p className="max-w-prose text-[11px] leading-relaxed text-muted">
          Runs the arithmetic, Increase&rsquo;s routing-number directory on a live call, and the
          twin probe against this book — on the details already on the row. Nothing is re-entered,
          so a re-check cannot quietly become an edit. The answer is appended; the previous check
          stays exactly as it was recorded.
        </p>
      </form>

      {acknowledged ? (
        <Note title="A signature does not survive a re-check, and that is the point">
          <p>
            The acknowledgement standing on this payee is attached to the check it answered, not
            to the payee. If today&rsquo;s check raises a warning it will be a new warning on a
            new row, with nobody&rsquo;s name against it, and a payment will be refused until
            somebody signs again. An acknowledgement from months ago says nothing about what was
            found this morning.
          </p>
        </Note>
      ) : null}

      {state.status === "refused" && state.receipt === null ? (
        <Note emphasis title={state.code ?? "Refused"}>
          <p>{state.message}</p>
        </Note>
      ) : null}

      {state.receipt === null ? null : (
        <ConfirmationResult
          receipt={state.receipt}
          headline={state.message}
          code={state.code}
          refused={state.status === "refused"}
        />
      )}
    </div>
  );
}
