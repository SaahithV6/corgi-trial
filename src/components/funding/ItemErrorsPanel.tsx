"use client";

import { useActionState } from "react";

import {
  probeItemErrorsAction,
  type ItemErrorView,
  type ProbeResult,
} from "@/app/(app)/funding/actions";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";

/**
 * The two non-happy paths, driven for real on demand.
 *
 * NOTHING HERE IS RENDERED UNTIL SOMEBODY PRESSES THE BUTTON, and what is
 * rendered afterwards is what Plaid actually returned to this deployment. There
 * is no fixture behind this panel: an error state nobody drove is a fabricated
 * one, and a screen that draws `ITEM_LOGIN_REQUIRED` from a constant is telling
 * you about a failure mode it has never seen.
 *
 * The two failures are structurally different, which is why both are here:
 *
 *   AT LINK TIME    `override_password: 'error_ITEM_LOCKED'` makes
 *                   `/sandbox/public_token/create` itself return 400. NO ITEM
 *                   IS CREATED. There is nothing to store, nothing to retry and
 *                   nothing to reconnect — the customer has to unlock the
 *                   account at their own bank.
 *   AFTER LINK      `/sandbox/item/reset_login` breaks a healthy Item. Every
 *                   product call fails afterwards — and `/item/get` still
 *                   answers 200 with the diagnosis. The DIAGNOSIS IS THE CALL
 *                   THAT SUCCEEDS, and it is the only one that can say what
 *                   broke, and that Plaid had already told us, at a timestamp.
 *
 * The second is driven on a THROWAWAY Item, always. There is no un-reset:
 * recovery is Link in update mode, which needs a browser, so an Item broken
 * here stays broken. That is exactly why it is never the Item anything was
 * funded from.
 */

const IDLE: ProbeResult = {
  status: "idle",
  message: "",
  code: null,
  linkTime: null,
  afterLink: null,
};

export function ItemErrorsPanel({ enabled }: { readonly enabled: boolean }) {
  const [state, formAction, pending] = useActionState(probeItemErrorsAction, IDLE);

  return (
    <form action={formAction} className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!enabled || pending}
          className={`rounded border border-border-strong px-3 py-1.5 text-sm font-medium ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {pending ? "Breaking two items…" : "Break an item, for real"}
        </button>
        <span className="max-w-prose text-xs leading-relaxed text-muted">
          {enabled
            ? "Creates two throwaway Plaid Items — one that fails at link time and one that is broken after linking — and prints exactly what Plaid returned. Neither touches the account you funded from, and no money moves."
            : "Plaid holds no credentials in this deployment, so no failure can be driven and none is drawn."}
        </span>
      </div>

      {state.status === "refused" ? (
        <div className="rounded-md border border-negative/40 bg-surface-raised px-4 py-3">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs font-semibold text-negative">Probe refused</span>
            <code className="font-mono text-xs">{state.code}</code>
          </div>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>
        </div>
      ) : null}

      {state.status === "ok" ? (
        <div className="space-y-4" aria-live="polite">
          <p className="max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>
          {state.linkTime === null ? null : (
            <ErrorCard
              title="Fails at LINK time — no Item is ever created"
              why="The customer's account is locked at their bank. The failure is the create call itself, so there is no Item, no access token and nothing to persist. Retrying from here cannot help: the unlock happens on the bank's own site."
              probe={state.linkTime}
            />
          )}
          {state.afterLink === null ? null : (
            <ErrorCard
              title="Breaks AFTER linking — the Item exists and is dead"
              why="The bank invalidated the credentials on an Item that had already linked. Money already booked against it is unaffected and existing uncleared holds keep running on their own clock — they do not depend on the Item. What cannot happen until the customer re-authenticates through Link in update mode is reading a fresh routing or account number."
              probe={state.afterLink}
            />
          )}
        </div>
      ) : null}
    </form>
  );
}

function ErrorCard({
  title,
  why,
  probe,
}: {
  readonly title: string;
  readonly why: string;
  readonly probe: ItemErrorView;
}) {
  return (
    <section className="rounded-md border border-negative/40 bg-surface-raised px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-xs font-semibold text-negative">{title}</h3>
        <code className="font-mono text-xs">{probe.errorCode}</code>
        <Badge tone="quiet">{probe.stage === "link" ? "at link" : "after link"}</Badge>
      </div>

      <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{why}</p>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-[12rem_1fr]">
        <dt className="text-muted">Item</dt>
        <dd className="break-all font-mono">
          {probe.itemId ?? (
            <span className="font-sans text-muted">none — the Item was never created</span>
          )}
        </dd>

        <dt className="text-muted">Plaid error_type</dt>
        <dd className="font-mono">{probe.errorType}</dd>

        <dt className="text-muted">Plaid error_message</dt>
        <dd className="max-w-prose">{probe.errorMessage}</dd>

        <dt className="text-muted">Plaid display_message</dt>
        <dd className="max-w-prose">
          {probe.displayMessage ?? (
            <span className="text-muted">
              null — Plaid sends no customer-facing text for this code, which is why the copy below
              exists rather than a blank box
            </span>
          )}
        </dd>

        {probe.explanation === null ? null : (
          <>
            <dt className="text-muted">What it means here</dt>
            <dd className="max-w-prose">{probe.explanation}</dd>
          </>
        )}

        {probe.lastWebhook === null ? null : (
          <>
            <dt className="text-muted">Plaid already told us</dt>
            <dd>
              <code className="font-mono">{probe.lastWebhook.code}</code> at{" "}
              <span className="font-mono">{probe.lastWebhook.sentAt}</span> — from{" "}
              <code className="font-mono">/item/get</code>&rsquo;s{" "}
              <code className="font-mono">status.last_webhook</code>, on the call that SUCCEEDED
            </dd>
          </>
        )}

        {probe.documentationUrl === null ? null : (
          <>
            <dt className="text-muted">Plaid docs</dt>
            <dd className="break-all font-mono">{probe.documentationUrl}</dd>
          </>
        )}
      </dl>

      <div className="mt-3">
        <p className="text-[11px] uppercase tracking-[0.08em] text-muted">Calls made</p>
        <TableScroll>
          <table className="mt-1 w-full border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className={TH_CLASS}>
                  Endpoint
                </th>
                <th scope="col" className={`${TH_CLASS} text-right`}>
                  Status
                </th>
                <th scope="col" className={TH_CLASS}>
                  Plaid request id
                </th>
              </tr>
            </thead>
            <tbody>
              {probe.calls.map((call, index) => (
                <tr
                  key={`${call.endpoint}:${call.requestId ?? index}`}
                  className="border-b border-border last:border-b-0"
                >
                  <td className={`${TD_CLASS} font-mono text-xs`}>{call.endpoint}</td>
                  <td className={`${TD_CLASS} money text-right`}>
                    {call.ok ? (
                      <span className="text-positive">{call.status}</span>
                    ) : (
                      <span className="text-negative">
                        {call.status === 0 ? "—" : call.status}
                        {call.errorCode === null ? "" : ` ${call.errorCode}`}
                      </span>
                    )}
                  </td>
                  <td className={`${TD_CLASS} font-mono text-xs text-muted`}>
                    {call.requestId ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </div>
    </section>
  );
}
