"use client";

import { useActionState, useId, useState } from "react";

import {
  acceptClientQuoteAction,
  requestClientQuoteAction,
} from "@/app/(app)/client/payouts/actions";
import { FOCUS_RING } from "@/components/ui/primitives";

import type { QuoteLine } from "./contract";
import { ACCEPT_IDLE, QUOTE_REQUEST_IDLE } from "./state";

/**
 * Ask for a rate, read what it costs, accept it.
 *
 * ===========================================================================
 * THE ACCEPT FORM CARRIES A REFERENCE AND NOTHING ELSE
 * ===========================================================================
 *
 * There is no rate on it, no amount on it and no destination on it. The only
 * fields that travel are the quote reference, the business this page is scoped
 * to, and an optional note of the customer's own. Every term of the commitment
 * is read back off the `fx_quote` row by the server — where `fee_cents`,
 * `customer_rate_scaled` and `buy_minor` are generated columns, so the row
 * cannot disagree with the rate it claims. A form that could name its own rate
 * would be the whole feature undone.
 *
 * ===========================================================================
 * NO ARITHMETIC IN THIS FILE
 * ===========================================================================
 *
 * Every figure below arrives as a string the server already formatted. There is
 * no `Number(...)` here and nothing is summed, compared or rounded. Whether the
 * customer can afford what they are accepting is decided by two `bigint`s
 * compared inside a Postgres transaction holding a lock, and the answer comes
 * back as a named refusal.
 *
 * ===========================================================================
 * THE REFUSAL IS THE FEATURE, SO THE BUTTON IS NOT DISABLED
 * ===========================================================================
 *
 * The Accept button stays live even when the offer costs more than the balance
 * shown on this page. That figure was read seconds ago, outside any
 * transaction; the decision is taken again inside `acceptQuote()`'s own
 * transaction under an advisory lock, and a screen that pre-empted it would be
 * claiming to know an answer only the database has. What the customer gets
 * instead is the real refusal, with its code and the money in it.
 */

export type CorridorOption = {
  readonly currency: string;
  readonly name: string;
  readonly destination: string;
};

const INPUT_CLASS = "rounded border border-border-strong bg-surface px-2.5 py-2 text-sm";

/**
 * The two refusals that mean money IS committed, not that nothing happened.
 *
 * Both are raised because an acceptance already exists on this quote, so the
 * blanket "nothing was written · your available balance is unchanged" line is
 * false under exactly these codes and true under every other one.
 */
const ALREADY_COMMITTED: ReadonlySet<string> = new Set([
  "FX_QUOTE_ALREADY_ACCEPTED",
  "FX_QUOTE_ALREADY_SETTLED",
]);

function LineList({ lines }: { readonly lines: readonly QuoteLine[] }) {
  return (
    <dl className="divide-y divide-border">
      {lines.map((line) => (
        <div key={line.label} className="grid gap-1 py-3 sm:grid-cols-[14rem_1fr] sm:gap-4">
          <dt className="text-sm font-medium">{line.label}</dt>
          <dd>
            <p className={line.emphasis === true ? "money text-lg font-semibold" : "money text-sm"}>
              {line.value}
            </p>
            <p className="mt-0.5 text-xs text-muted">{line.note}</p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function QuoteDesk({
  businessId,
  corridors,
  availableDisplay,
}: {
  readonly businessId: string;
  readonly corridors: readonly CorridorOption[];
  /** `"$35,514.93"` — formatted by the server, shown as context, never compared. */
  readonly availableDisplay: string;
}) {
  const [quoteState, quoteAction, quotePending] = useActionState(
    requestClientQuoteAction,
    QUOTE_REQUEST_IDLE,
  );
  const [acceptState, acceptAction, acceptPending] = useActionState(
    acceptClientQuoteAction,
    ACCEPT_IDLE,
  );
  const ids = useId();
  const [currency, setCurrency] = useState(corridors[0]?.currency ?? "MXN");

  const corridor = corridors.find((c) => c.currency === currency);
  const issueFor = (path: string) =>
    quoteState.issues?.find((issue) => issue.path === path)?.message ?? null;

  const offer = quoteState.offer;
  // The receipt belongs to the offer on screen, or to nothing. A result left
  // over from a previous quote must never be read as a verdict on this one.
  //
  // `quoteRef === null` IS ALSO THIS OFFER'S VERDICT. A refusal raised before
  // the action could read a quote reference — a malformed form, most reachably
  // a reference field with a comma or an apostrophe in it — comes back with no
  // ref to match, so the strict comparison threw it away: the customer pressed
  // Accept, the button finished, and NOTHING appeared. Silence after a press on
  // a control that commits money is the worst possible answer, and it was the
  // one a normal invoice reference produced.
  const verdict =
    acceptState.quoteRef === null || acceptState.quoteRef === offer?.quoteRef
      ? acceptState
      : null;

  return (
    <div className="space-y-6">
      <section
        aria-labelledby={`${ids}-ask`}
        className="rounded-lg border border-border bg-surface px-5 py-5"
      >
        <h2 id={`${ids}-ask`} className="text-base font-semibold">
          Ask for a rate
        </h2>
        <p className="mt-1 text-sm text-muted">
          We fetch the market rate, show you what we charge on top of it, and hold the price for
          two minutes. Asking costs nothing and commits nothing.
        </p>

        <form action={quoteAction} className="mt-5 space-y-5">
          <input type="hidden" name="businessId" value={businessId} />

          <div className="grid gap-5 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Where is it going?</span>
              <select
                name="buyCurrency"
                value={currency}
                onChange={(event) => setCurrency(event.target.value)}
                className={`${INPUT_CLASS} ${FOCUS_RING}`}
              >
                {corridors.map((option) => (
                  <option key={option.currency} value={option.currency}>
                    {option.destination} — {option.name} ({option.currency})
                  </option>
                ))}
              </select>
              <span className="text-xs text-muted">
                {corridor === undefined
                  ? "Choose a destination."
                  : `We quote five destinations. Each one is a promise that somebody at the far end can pay ${corridor.destination} in ${corridor.name}s.`}
              </span>
              {issueFor("buyCurrency") === null ? null : (
                <span className="text-xs text-negative">{issueFor("buyCurrency")}</span>
              )}
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">How much are you sending?</span>
              <input
                name="amount"
                inputMode="decimal"
                placeholder="0.00"
                aria-describedby={`${ids}-amount-hint`}
                className={`money ${INPUT_CLASS} ${FOCUS_RING}`}
              />
              <span id={`${ids}-amount-hint`} className="text-xs text-muted">
                In US dollars, which is what leaves your account. You can spend{" "}
                {availableDisplay} right now.
              </span>
              {issueFor("amount") === null ? null : (
                <span className="text-xs text-negative">{issueFor("amount")}</span>
              )}
            </label>

            <label className="flex flex-col gap-1.5 sm:col-span-2">
              <span className="text-sm font-medium">Who is being paid?</span>
              <input
                name="beneficiaryRef"
                placeholder="Rivera Textiles, Guadalajara"
                className={`${INPUT_CLASS} ${FOCUS_RING}`}
              />
              <span className="text-xs text-muted">
                The name you will recognise on the receipt. It travels with the quote so you can
                tell two commitments apart later.
              </span>
              {issueFor("beneficiaryRef") === null ? null : (
                <span className="text-xs text-negative">{issueFor("beneficiaryRef")}</span>
              )}
            </label>
          </div>

          <button
            type="submit"
            disabled={quotePending}
            className={`rounded border border-border-strong bg-surface-raised px-4 py-2 text-sm font-medium ${FOCUS_RING} disabled:opacity-60`}
          >
            {quotePending ? "Getting the rate…" : "Get a rate"}
          </button>
        </form>

        {quoteState.status === "refused" ? (
          <div className="mt-4 rounded border border-negative/40 bg-negative/5 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wide text-negative">
              {quoteState.code}
            </p>
            <p className="mt-1 text-sm">{quoteState.message}</p>
          </div>
        ) : null}
      </section>

      {offer === null ? null : (
        <section
          aria-labelledby={`${ids}-offer`}
          className="rounded-lg border border-border-strong bg-surface px-5 py-5"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h2 id={`${ids}-offer`} className="text-base font-semibold">
              {offer.costDisplay} to {offer.beneficiaryRef}
            </h2>
            <p className="font-mono text-xs text-muted">{offer.quoteRef}</p>
          </div>
          <p className="mt-1 text-sm text-muted">
            {offer.destination}. {quoteState.message}
          </p>

          <p className="mt-3 text-sm">
            This offer stops standing at <span className="font-mono">{offer.expiresAt}</span>, which
            was {offer.expiresInSeconds} seconds away when this page was drawn. After that it is
            not a rate anybody would deal at and accepting it will be refused.
          </p>

          {offer.rateEvidence === "simulated" ? (
            <p className="mt-3 rounded border border-border-strong bg-surface-raised px-3 py-2 text-sm">
              The live rate source could not be reached, so this price is built on a stored
              fallback rate rather than on today&rsquo;s market. It is labelled simulated on the
              record as well as here.
            </p>
          ) : null}

          <div className="mt-4 border-t border-border pt-1">
            <LineList lines={offer.lines} />
          </div>

          <form action={acceptAction} className="mt-5 space-y-4 border-t border-border pt-5">
            <input type="hidden" name="businessId" value={businessId} />
            <input type="hidden" name="quoteRef" value={offer.quoteRef} />

            <label className="flex max-w-md flex-col gap-1.5">
              <span className="text-sm font-medium">What is this for? (optional)</span>
              <input
                name="reference"
                placeholder="INV-2041"
                className={`${INPUT_CLASS} ${FOCUS_RING}`}
              />
              <span className="text-xs text-muted">
                Your own note against the commitment. It does not change any of the figures above.
              </span>
            </label>

            <p className="text-sm">
              Accepting holds {offer.costDisplay} against your account and commits us to{" "}
              {offer.deliveryDisplay}. The money does not leave yet and no payment is made — but
              you cannot commit the same dollars to a second payout.
            </p>

            <button
              type="submit"
              disabled={acceptPending}
              className={`rounded border border-border-strong bg-surface-raised px-4 py-2 text-sm font-medium ${FOCUS_RING} disabled:opacity-60`}
            >
              {acceptPending ? "Accepting…" : `Accept this rate and hold ${offer.costDisplay}`}
            </button>
          </form>

          {verdict === null || verdict.status === "idle" ? null : verdict.status === "refused" ? (
            <div className="mt-4 rounded border border-negative/40 bg-negative/5 px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide text-negative">
                Refused — {verdict.code}
              </p>
              <p className="mt-1 text-sm">{verdict.message}</p>
              {/* THIS SENTENCE IS A CLAIM ABOUT THE CUSTOMER'S MONEY AND IT WAS
                  PRINTED UNDER EVERY CODE. On `FX_QUOTE_ALREADY_ACCEPTED` and
                  `FX_QUOTE_ALREADY_SETTLED` the refusal is precisely that an
                  acceptance and a hold DO exist and availability HAS moved — and
                  pressing Accept a second time on the offer still on screen is
                  the ordinary way to reach them. So the reassurance is printed
                  only where it is true: this press wrote nothing, which is a
                  different statement from nothing having been written. */}
              {ALREADY_COMMITTED.has(verdict.code ?? "") ? (
                <p className="mt-2 text-xs text-muted">
                  This press wrote nothing. An earlier acceptance of this same
                  quote did, and the money it committed is still held — the two
                  figures at the top of this page say how much.
                </p>
              ) : (
                <p className="mt-2 text-xs text-muted">
                  Nothing was written: no acceptance, no hold, no rate locked. Your available
                  balance is unchanged.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4 rounded border border-border-strong bg-surface-raised px-4 py-3">
              <p className="text-xs font-medium uppercase tracking-wide">Accepted</p>
              <p className="mt-1 text-sm">{verdict.message}</p>
              <div className="mt-2">
                <LineList lines={verdict.lines} />
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
