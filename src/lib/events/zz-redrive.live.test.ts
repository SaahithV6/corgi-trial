/** TEMPORARY redrive harness. Deleted after the run. */
import { describe, expect, it } from "vitest";

import { sql } from "@/lib/ledger/db";
import { drain } from "@/lib/webhooks/drain";

const LIVE = process.env["WIRE_REDRIVE"] === "1";

describe.runIf(LIVE)("redrive the parked inbound wires", () => {
  it(
    "drains",
    async () => {
      const before = await sql`
        SELECT id::text, event_type, state::text AS state, parked_on_ref, park_attempts
          FROM webhook_inbox
         WHERE parked_on_kind = 'inbound_wire_account_mapping'
         ORDER BY received_at`;
      // eslint-disable-next-line no-console
      console.log("BEFORE", before.length, JSON.stringify(before, null, 1));

      const due = await sql`
        UPDATE webhook_inbox SET next_attempt_at = now()
         WHERE parked_on_kind = 'inbound_wire_account_mapping' AND state = 'parked'
         RETURNING id::text`;
      // eslint-disable-next-line no-console
      console.log("BROUGHT DUE", due.length);

      for (let i = 0; i < 6; i++) {
        const r = await drain({ maxBatches: 5 });
        // eslint-disable-next-line no-console
        console.log(
          `DRAIN ${i}`,
          JSON.stringify({
            claimed: r.claimed,
            processed: r.processed,
            ignored: r.ignored,
            parked: r.parked,
            retried: r.retried,
            deadLettered: r.deadLettered,
            unparked: r.unparked,
            consumers: r.consumers,
            missing: r.missingConsumers,
          }),
        );
        if (r.claimed === 0) break;
      }

      const after = await sql`
        SELECT id::text, event_type, state::text AS state, parked_on_ref, park_attempts,
               left(coalesce(parked_reason, processing_error, ''), 160) AS reason
          FROM webhook_inbox
         WHERE id = ANY(${before.map((r) => r["id"] as string)}::uuid[])
         ORDER BY received_at`;
      // eslint-disable-next-line no-console
      console.log("AFTER", JSON.stringify(after, null, 1));

      const drift = await sql`SELECT count(*)::int AS n FROM v_wire_availability_drift`;
      // eslint-disable-next-line no-console
      console.log("DRIFT", JSON.stringify(drift));
      expect(drift[0]?.["n"]).toBe(0);
    },
    600_000,
  );
});
