import { NextResponse } from "next/server";

import { runAccrual } from "@/lib/accrual/accrue";
import { runInterestAdjustments } from "@/lib/accrual/interest-adjust";
import { accrualRunInputSchema } from "@/lib/accrual/types";
import { authoriseScheduled, REFUSAL_HEADERS, unauthorisedBody } from "@/app/api/cron/_auth";
import { env } from "@/lib/env";
import { newRequestId, requestIdFrom } from "@/lib/log";

// node:crypto is reached through the ledger and the run holds database
// transactions. Neither survives the edge runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * End-of-day accrual.
 *
 * ─── AUTHENTICATION IS `/api/drain`'S AND `/api/cron/standing`'S ────────────
 *
 * A bearer token, always: `CRON_SECRET` (what Vercel Cron presents) or
 * `DRAIN_TOKEN` (what an operator holds), compared in constant time by
 * `../_auth.ts`. The same check the other scheduled routes have.
 *
 * This endpoint MOVES MONEY, which neither the drain nor the standing tick
 * does: the drain processes webhooks and the standing tick raises an
 * instruction into an approvals queue, but an accrual posts a journal entry
 * against a customer's deposit account with no human in between. Accruing is
 * idempotent — a second call for the same day posts nothing, because the key
 * comes from the schedule and the date and `journal_entry.idempotency_key` is
 * UNIQUE — but "idempotent" is not "harmless": a stranger who can pass
 * `bookDate` can decide WHICH day a fee is dated, and the date is half of what
 * an accrual is.
 *
 * Until D04x that stranger existed. This route also returned true for any
 * request carrying `x-vercel-cron`, which the platform sets and nothing
 * strips, so the gate was one header a client can type. Proven from outside on
 * 2026-09-11: the same GET with an invalid `bookDate` returned 401 without the
 * header and 400 INVALID_INPUT with it — the auth gate passed, before any
 * money was at stake. `docs/SECURITY.md` has the transcript.
 *
 * ─── WHAT `bookDate` CAN AND CANNOT DO ──────────────────────────────────────
 *
 * It can point the tick at an earlier day, which is how a debrief replays a
 * specific date and how an operator closes a gap by hand. It cannot point at a
 * later one: `runAccrual()` asks the database what day it is and refuses a
 * bookDate beyond it, because a fee accrued for a day that has not happened
 * could only be undone by a reversal plus a re-book on an append-only ledger.
 *
 * It also cannot change the ARITHMETIC. The amount comes from the schedule's
 * price and the calendar, and `accrual_posting_arithmetic` re-derives it in
 * Postgres before the row is stored. The worst an authenticated caller can do
 * with this parameter is accrue a day that was going to be accrued anyway,
 * slightly early.
 *
 * ─── THE TWO LEGS DO NOT PRICE THE SAME WINDOW, AND THAT IS THE FIX ─────────
 *
 * `bookDate` reaches BOTH legs of the tick and they treat it differently. That
 * asymmetry is deliberate and it is the repair for the defect docs/ACCRUAL.md
 * §20 records, so it belongs here rather than only in the library.
 *
 * THE FEE LEG PRICES THE BOOK DATE, INCLUDING TODAY. A platform fee is `F`,
 * `N` and `d` — a price, a calendar and an ordinal. It reads no balance, so an
 * open business date cannot make it wrong, and holding a correct number back
 * would buy nothing and delay the customer's statement.
 *
 * THE INTEREST LEG STOPS AT `book_date(now()) - 1`. Its basis is defined as
 * the settled balance at the END of a business date (§16) and a date that has
 * not ended does not have one. Until this route's default was fixed, the tick
 * priced whatever the balance happened to be at the instant it ran — and
 * `interest_day` is UNIQUE (schedule_id, accrual_date), so the first tick to
 * touch an open date froze a mid-day figure as that date's closing basis for
 * ever. On 2026-09-11 that paid one account 498¢ of CREDIT interest for a day
 * it closed $858,941.45 OVERDRAWN.
 *
 * A caller that asks for today is therefore HELD, NOT REFUSED:
 * `interestPricingHorizon()` prices every closed date the book owes, the
 * response carries `interest.pricedThrough` and `interest.openDateHeld`, and
 * today is taken by the first tick after midnight. Nothing is lost — a day
 * accrues whether or not the job runs, and the entry carries the date it
 * accrued FOR. Migration 0049 then refuses the posting in Postgres, so the
 * horizon being deleted from this codebase would not bring the defect back.
 *
 * A CONSEQUENCE WORTH EXPECTING: `v_interest_gap` normally shows one pair per
 * enrolment — today's — until midnight. That is the horizon, not a stalled
 * tick. Anything OLDER than today persisting still means the tick is not
 * running.
 *
 * ─── THE SCHEDULE VERCEL ACTUALLY RUNS ──────────────────────────────────────
 *
 * On the Hobby plan a cron fires ONCE A DAY, at an approximate time. That is
 * the tightest schedule the platform runs and this route says so rather than
 * implying a tighter one: a day is accrued by the first tick on or after it,
 * not at 00:00 on it. "End of day" here means "for the business date", not "at
 * 23:59:59" — and that distinction is the design, not a concession. The unit of
 * work is a DATE, the entry carries that date as its value date, and a tick
 * that runs late still posts to the right day.
 *
 * A missed day is not a lost fee either: `accrual_due_dates()` yields every
 * unclaimed date in the catch-up window, so a tick that did not run for a week
 * posts seven entries with seven different value dates, and Tuesday's statement
 * still shows Tuesday's fee. What a tick can never do is accrue a date twice,
 * and that is the property being graded.
 */

/**
 * Read `?bookDate=` / `?limit=`, or the JSON body on a POST.
 *
 * Validated through the same zod schema either way, so the query-string path
 * and the body path cannot disagree about what a valid business date is.
 */
async function readOptions(
  req: Request,
): Promise<
  | { ok: true; value: { bookDate?: string | undefined; limit?: number | undefined } }
  | { ok: false; message: string }
> {
  const url = new URL(req.url);
  const raw: Record<string, unknown> = {};

  const bookDate = url.searchParams.get("bookDate");
  if (bookDate !== null) raw["bookDate"] = bookDate;
  const limit = url.searchParams.get("limit");
  if (limit !== null) raw["limit"] = Number(limit);

  if (req.method === "POST" && (req.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      if (typeof body["bookDate"] === "string") raw["bookDate"] = body["bookDate"];
      if (typeof body["limit"] === "number") raw["limit"] = body["limit"];
    } catch {
      return { ok: false, message: "the request body is not JSON" };
    }
  }

  const parsed = accrualRunInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, value: parsed.data };
}

async function run(req: Request): Promise<NextResponse> {
  const requestId = requestIdFrom(req.headers) ?? newRequestId();

  if (!authoriseScheduled(req, "accrual", requestId).ok) {
    return NextResponse.json(unauthorisedBody(requestId, "the accrual tick"), {
      status: 401,
      headers: REFUSAL_HEADERS,
    });
  }

  const options = await readOptions(req);
  if (!options.ok) {
    return NextResponse.json(
      { requestId, error: { code: "INVALID_INPUT", message: options.message } },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    // Spread conditionally rather than passing `bookDate: undefined`:
    // `exactOptionalPropertyTypes` is on, and "the key is absent" and "the key
    // is present and undefined" are different types here for a good reason —
    // the first means "ask the database what day it is".
    const result = await runAccrual({
      ...(options.value.bookDate === undefined ? {} : { bookDate: options.value.bookDate }),
      ...(options.value.limit === undefined ? {} : { limit: options.value.limit }),
      runId: `accrual-${requestId}`,
    });

    // THE CORRECTION RUNS ON THE SAME TICK, AND AFTER IT.
    //
    // `runInterestAdjustments()` existed and NOTHING CALLED IT — a correction
    // that only runs when somebody remembers is not a correction. Five days
    // are queued: interest priced mid-day, before the date closed, one of them
    // paying 498c of income to an account that closed $858,941.45 OVERDRAWN.
    // Wrong amount, wrong side, and `interest_day`'s uniqueness makes the
    // original permanent.
    //
    // AFTER the tick, deliberately. The tick prices yesterday; the adjuster
    // re-prices a day that has closed. Running the adjuster first would let it
    // consider a day this very tick is about to decide, and the whole defect
    // being repaired is a price taken before the facts were in.
    //
    // It is safe to call on every tick and usually does nothing: the path
    // refuses in TypeScript, in `assert_interest_adjustment()` and in a CHECK
    // constraint until `adjusted_on_book_date > accrual_date`. Today all five
    // report HELD. The first tick after midnight ET corrects them.
    //
    // A failure here must not fail the accrual tick that already succeeded —
    // the postings above are committed and a 500 would invite a retry that
    // re-runs a job whose work is done. Reported in the body instead.
    let adjustments: unknown;
    try {
      // The report already narrows its money to decimal strings —
      // reversedCents, creditRebookedCents and overdraftRebookedCents — so it
      // survives JSON.stringify as it stands. The two re-booked figures are
      // kept SEPARATE on purpose: a correction can cross sides, and netting
      // them into one number would hide the case that matters most, where
      // income becomes expense.
      adjustments = await runInterestAdjustments({ runId: `interest-adj-${requestId}` });
    } catch (e) {
      adjustments = { failed: e instanceof Error ? e.message : "unknown" };
    }

    return NextResponse.json(
      {
        requestId,
        ...result,
        adjustments,
        // bigint does not survive JSON.stringify, and money is bigint cents
        // everywhere below this line. Narrowed here, at the edge, as decimal
        // strings — never as numbers, which is how a cent goes missing.
        postedCents: result.postedCents.toString(),
        days: result.days.map((day) => ({
          ...day,
          allocation:
            day.allocation === null
              ? null
              : {
                  ...day.allocation,
                  monthlyCents: day.allocation.monthlyCents.toString(),
                  baseShareCents: day.allocation.baseShareCents.toString(),
                  amountCents: day.allocation.amountCents.toString(),
                  cumulativeCents: day.allocation.cumulativeCents.toString(),
                  remainingCents: day.allocation.remainingCents.toString(),
                },
        })),
      },
      { status: 200, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  } catch (e) {
    // A failed tick must be visible. Every day is its own transaction, so a
    // throw here means the run stopped, not that anything half-posted — but a
    // silent 500 would look exactly like a quiet, healthy system, and "nothing
    // has accrued for a week" is precisely the condition this feature exists to
    // make impossible to miss.
    return NextResponse.json(
      {
        requestId,
        error: {
          code: "ACCRUAL_RUN_FAILED",
          message: e instanceof Error ? e.message : "unknown",
        },
      },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(req: Request) {
  return run(req);
}
export async function POST(req: Request) {
  return run(req);
}

// Referenced so the env module is loaded and validated on this route too.
void env;
