import { NextResponse } from "next/server";

import { runAccrual } from "@/lib/accrual/accrue";
import { accrualRunInputSchema } from "@/lib/accrual/types";
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
 * Vercel Cron sends `x-vercel-cron`; an operator sends the bearer token. The
 * same two callers, checked the same way, reusing the same `DRAIN_TOKEN`
 * secret — one shared operator credential for the scheduled jobs rather than a
 * third variable that has to be remembered on every deploy and that is a silent
 * 401 when it is not.
 *
 * This endpoint MOVES MONEY, which neither of the other two does: the drain
 * processes webhooks and the standing tick raises an instruction into an
 * approvals queue, but an accrual posts a journal entry against a customer's
 * deposit account with no human in between. So it is authenticated, always, and
 * there is no unauthenticated path. Accruing is idempotent — a second call for
 * the same day posts nothing, because the key comes from the schedule and the
 * date and `journal_entry.idempotency_key` is UNIQUE — but "idempotent" is not
 * "harmless": a stranger who can pass `bookDate` can decide WHICH day a fee is
 * dated, and the date is half of what an accrual is.
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
function authorised(req: Request): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const secret = process.env.DRAIN_TOKEN;
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

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

  if (!authorised(req)) {
    return NextResponse.json(
      {
        requestId,
        error: {
          code: "UNAUTHORISED",
          message: "the accrual tick requires the cron header or a bearer token",
        },
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
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
    return NextResponse.json(
      {
        requestId,
        ...result,
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
