"use client";

import { useActionState } from "react";

import {
  linkExternalBankAction,
  type LinkResultView,
} from "@/app/(app)/funding/actions";
import { Badge, FOCUS_RING, TD_CLASS, TH_CLASS, TableScroll } from "@/components/ui/primitives";

import type { CallView } from "@/app/(app)/funding/actions";

/**
 * STEP ONE OF THE LEG: link a bank, for a business that has never linked one.
 *
 * ============================================================================
 * WHY THIS PANEL EXISTS AT ALL
 * ============================================================================
 *
 * The published core loop reads "fund it from a linked external bank", and that
 * is two steps. Until this panel existed the screen only ever performed them
 * together, which meant a reader could not tell whether a business with no bank
 * linked was at the START of the leg or LOCKED OUT of it. Those are opposite
 * facts, and the difference is exactly the generality question: a screen that
 * only works for the customer who already has a linkage is a demo.
 *
 * So the first step has its own button, and it works for any business the gate
 * allows. It links a real Item at a real institution and prints what came back:
 * Plaid's `item_id`, the institution, and every depository account `/auth/get`
 * returned ACH routing numbers for.
 *
 * ============================================================================
 * WHAT IT DOES NOT DO
 * ============================================================================
 *
 * IT POSTS NOTHING. No journal entry, no hold, no balance movement — linking a
 * bank and pulling from it are different acts, and a panel that quietly did the
 * second while claiming the first would be the exact dishonesty this codebase
 * keeps auditing itself for.
 *
 * IT DOES NOT RUN ON RENDER, AND IT DOES NOT POLL. Every Plaid call on this
 * screen is behind a press. Linking creates real objects at a provider whose
 * sandbox is rationed — `/institutions/get` is ten calls per credential per
 * window, which is why the integration health probe caches its verdict — and a
 * page that linked on render would spend that quota on people who were only
 * reading. Nothing below is drawn until the button is pressed.
 *
 * IT DOES NOT CLAIM A LINK IT DID NOT GET. A refusal renders Plaid's own error
 * code — `RATE_LIMIT_EXCEEDED` included — and the calls that were attempted,
 * with their status codes and Plaid's `request_id`s. A rate limit mid-run shows
 * as a rate limit, not as a half-drawn success.
 */

const IDLE: LinkResultView = {
  status: "idle",
  code: null,
  message: "",
  businessId: null,
  businessName: null,
  itemId: null,
  institutionId: null,
  institutionName: null,
  linkToken: null,
  linkTokenExpiresAt: null,
  accounts: null,
  calls: null,
};

export type LinkPanelProps = {
  /** The business the press links a bank for. Empty when none is selected. */
  readonly businessId: string;
  readonly businessName: string;
  /** False when the gate refuses this business, or Plaid holds no credentials. */
  readonly enabled: boolean;
  /** Why the button is disabled, when it is. */
  readonly disabledReason: string;
};

export function LinkPanel({ businessId, businessName, enabled, disabledReason }: LinkPanelProps) {
  const [state, formAction, pending] = useActionState(linkExternalBankAction, IDLE);

  return (
    <form action={formAction} className="space-y-4 px-5 py-5">
      <input type="hidden" name="businessId" value={businessId} />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={!enabled || pending}
          className={`rounded border border-border-strong px-3 py-1.5 text-sm font-medium ${FOCUS_RING} disabled:cursor-not-allowed disabled:opacity-50`}
        >
          {pending ? "Linking at Plaid…" : `Link a bank for ${businessName}`}
        </button>
        <span className="max-w-prose text-xs leading-relaxed text-muted">
          {enabled
            ? "Five real HTTP requests to sandbox.plaid.com. A real Item is created. No journal entry is posted, no hold is opened and no balance moves — this is the first half of the leg on its own."
            : disabledReason}
        </span>
      </div>

      {state.status === "refused" ? (
        <section
          aria-live="polite"
          className="rounded-md border border-negative/40 bg-surface-raised px-4 py-3"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs font-semibold text-negative">Refused</span>
            <code className="font-mono text-xs">{state.code}</code>
          </div>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>
          {state.calls === null || state.calls.length === 0 ? null : (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
                Plaid calls attempted
              </p>
              <CallLog calls={state.calls} />
            </div>
          )}
        </section>
      ) : null}

      {state.status === "ok" ? (
        <section
          aria-live="polite"
          className="space-y-4 rounded-md border border-positive/40 bg-surface-raised px-4 py-4"
        >
          <div>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-semibold text-positive">Linked</span>
              <Badge tone="positive">LIVE</Badge>
            </div>
            <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{state.message}</p>
          </div>

          <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-[12rem_1fr]">
            <dt className="text-muted">Plaid item id</dt>
            <dd className="break-all font-mono">{state.itemId}</dd>
            <dt className="text-muted">Institution</dt>
            <dd>
              {state.institutionName ?? "(not named)"}{" "}
              <span className="font-mono text-muted">{state.institutionId ?? ""}</span>
            </dd>
            <dt className="text-muted">Link token</dt>
            <dd className="break-all font-mono">
              {state.linkToken ?? "(none minted)"}
              {state.linkTokenExpiresAt === null ? null : (
                <span className="ml-2 font-sans text-muted">
                  expires {state.linkTokenExpiresAt}
                </span>
              )}
            </dd>
          </dl>

          {state.accounts === null || state.accounts.length === 0 ? (
            <p className="max-w-prose text-xs leading-relaxed text-muted">
              Not one account on this Item is a depository account Plaid returned ACH numbers for.
            </p>
          ) : (
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
                Accounts this Item can be funded from
              </p>
              <TableScroll>
                <table className="mt-1 w-full border-collapse">
                  <thead>
                    <tr className="border-b border-border">
                      <th scope="col" className={TH_CLASS}>
                        Account
                      </th>
                      <th scope="col" className={TH_CLASS}>
                        Subtype
                      </th>
                      <th scope="col" className={TH_CLASS}>
                        Routing
                      </th>
                      <th scope="col" className={`${TH_CLASS} text-right`}>
                        Plaid balance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.accounts.map((account) => (
                      <tr key={account.plaidAccountId} className="border-b border-border last:border-b-0">
                        <td className={TD_CLASS}>
                          <div>
                            {account.name}
                            {account.mask === null ? null : (
                              <span className="text-muted"> ····{account.mask}</span>
                            )}
                          </div>
                          <div className="font-mono text-[11px] break-all text-muted">
                            {account.plaidAccountId}
                          </div>
                        </td>
                        <td className={`${TD_CLASS} font-mono text-xs`}>
                          {account.subtype ?? "—"}
                        </td>
                        <td className={`${TD_CLASS} font-mono text-xs`}>{account.routingNumber}</td>
                        <td className={`${TD_CLASS} text-right font-mono text-xs`}>
                          {account.balanceDisplay ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableScroll>
              <p className="mt-2 max-w-prose text-[11px] leading-relaxed text-muted">
                The account number is not printed and is not stored. Routing numbers are public
                bank data; the other half is what an attacker actually needs, and a system that
                never holds it cannot leak it.
              </p>
            </div>
          )}

          {state.calls === null ? null : (
            <div>
              <p className="text-[11px] uppercase tracking-[0.08em] text-muted">
                The calls that did it
              </p>
              <CallLog calls={state.calls} />
            </div>
          )}

          <p className="max-w-prose text-[11px] leading-relaxed text-muted">
            This Item is NOT persisted. There is no{" "}
            <code className="font-mono">plaid_item</code> table in this schema, so the access token
            was used for the two reads above and dropped. The durable record of a linkage is the{" "}
            <code className="font-mono">external_ref</code> on the money rows a funding run writes.
            Pressing &ldquo;Link a bank and fund&rdquo; below links a fresh Item and books against
            that one — which is why funding remains one press end to end, and why this button is a
            demonstration that the step is available rather than a prerequisite for the next.
          </p>
        </section>
      ) : null}
    </form>
  );
}

/** Every call, with Plaid's own request id. The evidence, not a summary of it. */
function CallLog({ calls }: { readonly calls: readonly CallView[] }) {
  return (
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
              Request id
            </th>
            <th scope="col" className={`${TH_CLASS} text-right`}>
              ms
            </th>
          </tr>
        </thead>
        <tbody>
          {calls.map((call, index) => (
            <tr key={`${call.endpoint}:${index}`} className="border-b border-border last:border-b-0">
              <td className={`${TD_CLASS} font-mono text-xs`}>{call.endpoint}</td>
              <td className={`${TD_CLASS} text-right font-mono text-xs`}>
                <span className={call.ok ? "" : "text-negative"}>{call.status}</span>
                {call.errorCode === null ? null : (
                  <span className="ml-2 text-negative">{call.errorCode}</span>
                )}
              </td>
              <td className={`${TD_CLASS} font-mono text-[11px] break-all text-muted`}>
                {call.requestId ?? "—"}
              </td>
              <td className={`${TD_CLASS} text-right font-mono text-xs text-muted`}>{call.ms}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
