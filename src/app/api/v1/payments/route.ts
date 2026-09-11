/**
 * POST /api/v1/payments — queue a payment for HUMAN approval.
 *
 * `readOnly: false` on the spec is enforcement, not decoration: it is what
 * puts this route under the much smaller write budget, because a queued
 * payment costs a human's attention and sixty a minute is a denial-of-service
 * attack on the approver — who is the control this entire design rests on.
 *
 * There is no GET here. Listing a business's instructions needs a scoped
 * reader that `@/lib/approvals` does not expose, and post-filtering a
 * platform-wide queue in TypeScript would make tenant isolation a step rather
 * than a predicate. Reported in GET /api/v1/limits under `missing_readers`
 * rather than worked around.
 */

import { apiDeps } from "@/lib/api/deps";
import { handle } from "@/lib/api/handle";
import { createPaymentRoute } from "@/lib/api/routes/payments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handle(request, apiDeps(), {
    name: "POST /api/v1/payments",
    readOnly: false,
    run: createPaymentRoute,
  });
}
