"use client";

import { useActionState, useId, useState } from "react";

import {
  drainOutboundAction,
  registerEndpointAction,
  type RegisterResult,
  type SimpleResult,
} from "@/app/(app)/events/actions";
import { Badge, FOCUS_RING, Note, Panel } from "@/components/ui/primitives";

/**
 * Registering an endpoint, and the one screen in this console that shows a
 * secret.
 *
 * THE SECRET IS SHOWN ONCE AND THE SCREEN SAYS SO BEFORE IT IS SHOWN, not
 * after. A "copy this now" notice under a value people have already scrolled
 * past is a notice for the changelog, not for the user.
 *
 * It lives in this component's props for the length of one render pass and in
 * nothing else: not in the URL (a query parameter ends up in browser history,
 * in a proxy log, and in a screenshot), not in `localStorage`, not in a
 * revalidated server payload. Navigating away loses it, which is the correct
 * behaviour and is stated on the panel.
 *
 * The submit button is NOT disabled while the URL looks wrong. Same reasoning
 * the payments and pots forms give: the refusal is the most instructive thing
 * this screen can produce — it names the range, the port or the scheme — and a
 * greyed-out button demonstrates nothing.
 */

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = "text-[11px] font-medium uppercase tracking-[0.08em] text-muted";
const BUTTON_CLASS = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;

const IDLE: RegisterResult = {
  status: "idle",
  code: null,
  message: "",
  issues: null,
  endpointId: null,
  url: null,
  secret: null,
};

const DRAIN_IDLE: SimpleResult = { status: "idle", message: "" };

export type BusinessOption = { readonly id: string; readonly name: string };

export function RegisterForm({
  businesses,
  eventTypes,
}: {
  readonly businesses: readonly BusinessOption[];
  readonly eventTypes: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(registerEndpointAction, IDLE);
  const [drain, drainAction, draining] = useActionState(drainOutboundAction, DRAIN_IDLE);
  const [filtered, setFiltered] = useState(false);
  const urlId = useId();
  const descId = useId();
  const bizId = useId();

  return (
    <Panel
      title="Register an endpoint"
      description="https on port 443, resolving to a public address. The signing secret is generated here and shown once."
      actions={
        <form action={drainAction}>
          <button type="submit" className={BUTTON_CLASS} disabled={draining}>
            {draining ? "Draining…" : "Drain now"}
          </button>
        </form>
      }
    >
      <div className="space-y-4 px-5 py-4">
        {drain.status === "done" ? (
          <Note title="Drain complete">
            <p className="font-mono text-[11px]">{drain.message}</p>
          </Note>
        ) : null}

        {state.status === "registered" && state.secret !== null ? (
          <Note title="Copy this signing secret now. It is never shown again.">
            <p>
              Registered <span className="font-mono">{state.url}</span>. This value is not stored anywhere it
              can be read back — no screen, no API, no log. If you lose it, rotate the endpoint: both the old
              and the new secret sign every delivery until you retire the old one, so rotation is invisible to
              your verifier.
            </p>
            <p className="mt-3">
              <span className={LABEL_CLASS}>Signing secret</span>
            </p>
            <pre className="mt-1 overflow-x-auto rounded border border-border-strong bg-surface px-3 py-2 font-mono text-xs">
              {state.secret}
            </pre>
            <p className="mt-3">
              Verify with any Standard Webhooks implementation. The signed string is{" "}
              <code>{"{webhook-id}.{webhook-timestamp}.{raw body}"}</code>, HMAC-SHA256 over the{" "}
              <strong>base64-decoded</strong> secret body, compared against the <code>v1,</code> entries in{" "}
              <code>webhook-signature</code>. Verify the <strong>raw bytes</strong>: parsing and re-serialising
              the JSON changes the signature.
            </p>
          </Note>
        ) : null}

        {state.status === "refused" ? (
          <Note emphasis title={`Refused${state.code === null ? "" : ` (${state.code})`}`}>
            <p>{state.message}</p>
            {state.issues === null ? null : (
              <ul className="mt-2 list-disc pl-4">
                {state.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    <span className="font-mono text-[11px]">{issue.path}</span> — {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </Note>
        ) : null}

        <form action={formAction} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={LABEL_CLASS} htmlFor={bizId}>
                Business
              </label>
              <select id={bizId} name="businessId" className={INPUT_CLASS} disabled={pending} required>
                {businesses.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-muted">
                Scope. An endpoint receives this business&apos;s events and no other&apos;s.
              </p>
            </div>

            <div>
              <label className={LABEL_CLASS} htmlFor={descId}>
                What it is for
              </label>
              <input
                id={descId}
                name="description"
                className={INPUT_CLASS}
                disabled={pending}
                required
                maxLength={200}
                placeholder="Production ledger sync"
              />
              <p className="mt-1 text-[11px] text-muted">Printed on the delivery log beside every attempt.</p>
            </div>
          </div>

          <div>
            <label className={LABEL_CLASS} htmlFor={urlId}>
              Endpoint URL
            </label>
            <input
              id={urlId}
              name="url"
              type="url"
              className={`${INPUT_CLASS} font-mono`}
              disabled={pending}
              required
              maxLength={2000}
              placeholder="https://hooks.example.com/corgi"
            />
            <p className="mt-1 max-w-prose text-[11px] text-muted">
              Refused: anything but https, any port but 443, credentials in the URL, and any hostname that
              resolves — on any of its records — to loopback, a private range, link-local, CGNAT, multicast or
              reserved space. Redirects are never followed. The refusal tells you which.
            </p>
          </div>

          <fieldset className="rounded border border-border px-3 py-2">
            <legend className={`px-1 ${LABEL_CLASS}`}>Event types</legend>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={!filtered}
                onChange={(e) => setFiltered(!e.target.checked)}
                className={FOCUS_RING}
              />
              Every event type
            </label>
            {filtered ? (
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {eventTypes.map((t) => (
                  <label key={t} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" name="eventTypes" value={t} className={FOCUS_RING} />
                    <span className="font-mono text-[11px]">{t}</span>
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>

          <div className="flex items-center gap-3">
            <button type="submit" className={BUTTON_CLASS} disabled={pending}>
              {pending ? "Checking the URL…" : "Register endpoint"}
            </button>
            {pending ? (
              <Badge tone="quiet">resolving DNS and checking every address it answers with</Badge>
            ) : null}
          </div>
        </form>
      </div>
    </Panel>
  );
}
