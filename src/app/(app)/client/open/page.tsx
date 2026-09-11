import type { Metadata } from "next";

import { ApplicationForm } from "@/components/client/open/ApplicationForm";

export const metadata: Metadata = {
  title: "Open an account · Corgi",
};

/**
 * Never prerendered. Submitting asks a live third-party register, and a page
 * baked at build time on a machine with no network would be a page that lies
 * about what it can do.
 */
export const dynamic = "force-dynamic";

/**
 * `/client/open` — the business's own way in.
 *
 * ===========================================================================
 * THE GAP THIS FILLS
 * ===========================================================================
 *
 * The brief's core loop begins "open an account behind a real KYB check → fund
 * it → issue a card". This build had the check, the enforcement and the
 * account-opening consequence, and no way for a business to START. `/onboarding`
 * is the operator's console: it verifies a business that is already on the
 * book, which makes step one something staff do TO a customer. Everything under
 * `/client` then assumes an existing, verified customer. Between "a business
 * exists in the world" and "a business exists on this book" there was nothing.
 *
 * This screen is that step, and it is deliberately the ONLY thing here: a form,
 * and an honest statement of where the application got to.
 *
 * ===========================================================================
 * TENANT ISOLATION, ON A SURFACE THAT HAS NO TENANT YET
 * ===========================================================================
 *
 * `src/app/(app)/client/live-source.ts` opens by saying isolation on this
 * surface is a `WHERE` predicate evaluated by Postgres and never a `.filter()`
 * in a program. This screen honours that rule by having no read to scope: an
 * applicant is not yet a tenant, there is no `business_id` to be a predicate
 * of, and so THERE IS NO QUERY HERE AT ALL. No list, no lookup by EIN, no "do
 * we already know you" probe — every one of those would be a cross-applicant
 * read wearing a form's clothes, and an EIN lookup in particular is an oracle:
 * type a competitor's EIN, learn whether they bank here.
 *
 * The consequence is exact and worth stating: an applicant can see their own
 * submission's answer and there is no code path on this route by which they
 * could see anyone else's, because nothing on this route reads a row.
 *
 * ===========================================================================
 * NO PII IN A URL
 * ===========================================================================
 *
 * This page takes no `searchParams` and the form is a server action, so the
 * EIN, the address and the directors travel in a POST body and appear in no
 * link, no history entry and no server log line. The route is a bare path with
 * nothing after it.
 */
export default function OpenAccountPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold text-text">Open a business account</h1>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          Tell us who you are and we will check it. Your legal name goes to a
          real company register, and the people who control the business have to
          pass an identity check of their own. Nothing is opened in your name
          until both come back — <strong className="font-medium text-text">an
          account does not exist until the check passes</strong>, so there is no
          moment where you can see a balance that a failed check has to take
          away again.
        </p>
        <p className="max-w-prose text-xs leading-relaxed text-muted">
          We report the <strong className="font-medium text-text">weaker</strong> of
          the two checks rather than an average of them. One unfinished check
          holds the whole application, which is why an application can sit at
          pending while half of it has already passed.
        </p>
      </header>

      <ApplicationForm />
    </div>
  );
}
