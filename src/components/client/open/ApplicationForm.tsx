"use client";

/**
 * The application form, and the applicant's state after they submit.
 *
 * One component rather than two because they are one thing to the person using
 * it: the answer replaces the form in place, and the form stays on the page
 * underneath so a rejected applicant can read what they typed rather than
 * guessing at it.
 *
 * This file DECIDES NOTHING. Every sentence rendered below was written on the
 * server in `./actions.ts` and arrives on the result — the status word, the
 * headline, what happens next, the handover. A view that composed its own
 * "you're approved!" out of a status enum is exactly how a pending applicant
 * ends up reading an approval.
 */

import { useActionState } from "react";

import { applyAction } from "./actions";
import {
  IDLE_APPLICATION,
  MAX_DIRECTORS,
  STATE_TONE,
  type ApplicationResult,
} from "./application";

const DIRECTOR_SLOTS = Array.from({ length: MAX_DIRECTORS }, (_, index) => index);

const FIELD =
  "mt-1 w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-muted";

function Field({
  label,
  name,
  placeholder,
  required = true,
  hint,
  type = "text",
}: {
  readonly label: string;
  readonly name: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly hint?: string;
  readonly type?: string;
}) {
  return (
    <label className="block text-xs font-medium text-text">
      {label}
      {!required && <span className="ml-1 font-normal text-muted">(optional)</span>}
      <input
        className={FIELD}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder ?? ""}
        autoComplete="off"
      />
      {hint !== undefined && <span className="mt-1 block font-normal text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

function StatePanel({ result }: { readonly result: ApplicationResult }) {
  if (result.status === "idle") return null;

  if (result.status === "refused") {
    return (
      <div
        role="status"
        className="rounded-lg border border-rose-400/60 bg-rose-50 px-4 py-3 text-rose-900"
      >
        <p className="text-sm font-semibold">{result.headline}</p>
        <p className="mt-1 max-w-prose text-xs leading-relaxed">{result.detail}</p>
        {result.code !== null && (
          <p className="mt-2 font-mono text-[11px] opacity-80">{result.code}</p>
        )}
      </div>
    );
  }

  const state = result.state;
  if (state === null) return null;

  return (
    <div role="status" className={`rounded-lg border px-4 py-3 ${STATE_TONE[state]}`}>
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] opacity-80">
        {state === "pending" ? "Pending" : state === "approved" ? "Approved" : "Rejected"}
      </p>
      <p className="mt-1 text-sm font-semibold">{result.headline}</p>
      <p className="mt-1.5 max-w-prose text-xs leading-relaxed">{result.detail}</p>

      <p className="mt-2 max-w-prose text-xs leading-relaxed">
        <strong className="font-medium">
          {result.accountOpen
            ? "An account is open in your name."
            : "You have no account yet."}
        </strong>{" "}
        {result.accountOpen
          ? "Money can arrive and you can send it."
          : "Nothing was opened on the strength of this submission, so there is no balance to see and no money can arrive for you."}
      </p>

      {result.registry !== null && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 border-t border-current/20 pt-2 text-[11px]">
          <dt className="opacity-70">Register</dt>
          <dd className="font-mono">{result.registry.provider}</dd>
          <dt className="opacity-70">Asked by</dt>
          <dd>{result.registry.kind === "lei" ? "your Legal Entity Identifier" : "your legal name"}</dd>
          <dt className="opacity-70">Their answer</dt>
          <dd className="font-mono">{result.registry.status}</dd>
          <dt className="opacity-70">Evidence</dt>
          <dd className="font-mono">{result.registry.evidence}</dd>
          <dt className="opacity-70">Reference</dt>
          <dd className="font-mono break-all">{result.registry.reference}</dd>
          {result.registry.providerCode !== null && (
            <>
              <dt className="opacity-70">Their code</dt>
              <dd className="font-mono">{result.registry.providerCode}</dd>
            </>
          )}
          {result.registry.citation !== null && (
            <>
              <dt className="opacity-70">Checkable at</dt>
              <dd>{result.registry.citation}</dd>
            </>
          )}
        </dl>
      )}

      {result.registry !== null && result.registry.reasons.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed">
          {result.registry.reasons.map((reason, index) => (
            <li key={`${index}-${reason.slice(0, 24)}`}>{reason}</li>
          ))}
        </ul>
      )}

      {result.handover !== null && (
        <p className="mt-3 max-w-prose border-t border-current/20 pt-2 text-[11px] leading-relaxed">
          <strong className="font-medium">What happens next.</strong> {result.handover}
        </p>
      )}
    </div>
  );
}

export function ApplicationForm() {
  const [result, formAction, pending] = useActionState<ApplicationResult, FormData>(
    applyAction,
    IDLE_APPLICATION,
  );

  return (
    <div className="space-y-4">
      <StatePanel result={result} />

      <form action={formAction} className="space-y-5">
        <fieldset className="space-y-3 rounded-lg border border-border-strong p-4">
          <legend className="px-1 text-xs font-medium uppercase tracking-[0.08em] text-muted">
            Your business
          </legend>
          <Field
            label="Registered legal name"
            name="legalName"
            placeholder="Northwind Instruments, Inc."
            hint="Exactly as it appears on your incorporation documents — this is what we ask the company register about."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="EIN"
              name="ein"
              placeholder="12-3456789"
              hint="Nine digits. Sent in the body of this form and never in a link."
            />
            <Field
              label="Legal Entity Identifier"
              name="lei"
              required={false}
              placeholder="HWUPKR0MPOU8FGXBT394"
              hint="Twenty characters, if you hold one. It turns a name search into an exact lookup."
            />
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-border-strong p-4">
          <legend className="px-1 text-xs font-medium uppercase tracking-[0.08em] text-muted">
            Registered address
          </legend>
          <Field label="Street" name="street1" placeholder="1 Harbour Way" />
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="City" name="city" placeholder="Portland" />
            <Field label="State" name="subdivision" placeholder="OR" />
            <Field label="Postal code" name="postalCode" placeholder="97204" />
          </div>
        </fieldset>

        <fieldset className="space-y-3 rounded-lg border border-border-strong p-4">
          <legend className="px-1 text-xs font-medium uppercase tracking-[0.08em] text-muted">
            Directors
          </legend>
          <p className="max-w-prose text-[11px] leading-relaxed text-muted">
            Everyone who controls the business. Each of them has to pass an
            identity check of their own before an account can open — we cannot
            verify a company without verifying the people behind it. At least
            one is required; up to {MAX_DIRECTORS} are accepted here.
          </p>
          {DIRECTOR_SLOTS.map((index) => (
            <div key={index} className="grid gap-3 sm:grid-cols-2">
              <Field
                label={`Director ${index + 1} — full legal name`}
                name={`director.${index}.fullName`}
                required={index === 0}
                placeholder="Alex Mercer"
              />
              <Field
                label={`Director ${index + 1} — email`}
                name={`director.${index}.email`}
                type="email"
                required={index === 0}
                placeholder="alex@northwind.example"
              />
            </div>
          ))}
        </fieldset>

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-text px-4 py-2 text-sm font-medium text-surface disabled:opacity-50"
        >
          {pending ? "Asking the company register…" : "Submit application"}
        </button>
      </form>
    </div>
  );
}
