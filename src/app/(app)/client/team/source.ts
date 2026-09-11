import "server-only";

/**
 * The live read behind `/client/team`.
 *
 * ===========================================================================
 * EVERY READER HERE WAS ALREADY WRITTEN, AND EVERY ONE TAKES A PREDICATE
 * ===========================================================================
 *
 *   readBalanceScreen(businessId)   resolves the subject and the switcher —
 *                                   the same resolution `/client` and
 *                                   `/client/pots` use, so the same URL lands
 *                                   on the same customer on all three
 *   readTeam(businessId, conn)      WHERE business_id = $1, four times over
 *   resolveActingAdmin(businessId)  WHERE business_id = $1 AND state = 'active'
 *                                     AND role = 'admin'
 *
 * There is not one `.filter()`, `.find()` or `if (row.businessId === …)` in
 * this file deciding which customer a row belongs to. `readTeam()` is the same
 * function `/team` calls; it is reached through `@/lib/team/store`, never
 * through the operator's screen module, so `src/app/(app)/team/**` and
 * `src/components/team/**` are untouched by this feature.
 *
 * ===========================================================================
 * WHAT THIS SCREEN DELIBERATELY DOES NOT SHOW
 * ===========================================================================
 *
 * The operator's team screen renders `readTeamInvariants()` — three counts
 * taken over EVERY business on the book. They are zero, and a count of zero
 * leaks nothing, but this surface's standing claim is "no other customer's
 * figures anywhere on the page" and a platform-wide count is a platform-wide
 * figure. So the invariants are checked where they belong — `pnpm db:check`,
 * the integration tests, and the receipt of any write that could move them —
 * and not rendered here.
 *
 * The full Lithic card token is not rendered either. The customer's own last
 * four identifies their card to them; the provider token is an operator's
 * handle on a provider account and belongs on the operator's screen.
 *
 * ===========================================================================
 * WHY THE LIVE MODULES ARE IMPORTED DYNAMICALLY
 * ===========================================================================
 *
 * Importing them evaluates `src/lib/env.ts`, which refuses to load without a
 * full set of keys. That is right for the app and wrong for a page whose job
 * includes rendering the words "no database configured". `sources.ts` and
 * `pots/source.ts` do the same thing for the same reason.
 */

import type { Loaded } from "@/components/client/contract";
import type {
  ClientTeamScreen,
  TeammateCard,
  TeammateLine,
} from "@/components/client/team/contract";
import { formatUsd, sumCents } from "@/lib/format/money";
import { hasDatabase } from "@/lib/has-database";
import type { TeamMemberDetail } from "@/lib/team/types";

/**
 * A limit as the edit form should start.
 *
 * `null` -> `""`, and `0n` -> `"0.00"`. THE TWO ARE NOT THE SAME and the whole
 * round trip keeps them apart: a blank field parses back to `null`, a typed
 * zero parses back to `0n`. A form that rendered `null` as `"0.00"` would
 * silently convert "no limit of this kind" into "spends nothing" the first time
 * anybody pressed Save on an unrelated field.
 *
 * Integer division on `bigint`, so no float touches the money at any point.
 */
function limitField(cents: bigint | null): string {
  if (cents === null) return "";
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const fraction = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${abs / 100n}.${fraction}`;
}

/** The same distinction, in words. */
function limitDisplay(cents: bigint | null): string {
  return cents === null ? "no limit" : formatUsd(cents);
}

function toLine(detail: TeamMemberDetail, actingMemberId: string | null): TeammateLine {
  const { member, cards, outstanding, spend } = detail;
  // `sumCents()`, not `reduce((sum, a) => sum + a.targetHoldCents, 0n)`.
  // That reduce is what put `05000` on this screen: `v_card_auth_hold`
  // publishes its folds as `numeric`, postgres.js hands a `numeric` over as a
  // STRING, and `0n + "5000"` is the string `"05000"` — silently, with no type
  // error, all the way to `formatUsd()`, which refused it. `@/lib/team/store`
  // now parses those columns at the read (`centsFrom`), so this is bigint
  // arithmetic; summing through the money module means the next reader that
  // hands this line a string is refused here too, by name, instead of
  // concatenated.
  const outstandingCents = sumCents(outstanding.map((a) => a.targetHoldCents));

  return {
    memberId: member.memberId,
    displayName: member.displayName,
    email: member.email,
    role: member.terms.role,
    state: member.terms.state,
    joinedAt: member.joinedAt,
    termsVersion: member.terms.version,
    termsEffectiveFrom: member.terms.effectiveFrom,
    note: member.terms.note,

    perTxnDisplay: limitDisplay(member.terms.perTxnLimitCents),
    dailyDisplay: limitDisplay(member.terms.dailyLimitCents),
    monthlyDisplay: limitDisplay(member.terms.monthlyLimitCents),
    perTxnField: limitField(member.terms.perTxnLimitCents),
    dailyField: limitField(member.terms.dailyLimitCents),
    monthlyField: limitField(member.terms.monthlyLimitCents),

    spentTodayDisplay: formatUsd(spend.dayCents),
    spentMonthDisplay: formatUsd(spend.monthCents),

    cards: cards.map(
      (card): TeammateCard => ({
        cardId: card.cardId,
        lastFour: card.lastFour,
        nickname: card.nickname,
        issuedAt: card.assignedAt,
        providerState: card.providerState,
      }),
    ),
    outstandingCount: outstanding.length,
    outstandingDisplay: formatUsd(outstandingCents),

    actorCanApprove: member.actorCanApprove,
    isYou: actingMemberId !== null && actingMemberId === member.memberId,
  };
}

/**
 * Read this business's own team.
 *
 * A failed read is a RESULT, not a throw: the page renders the refusal panel.
 * Nothing here is caught and dropped — this module only reads, so a failure
 * means the page cannot be drawn, never that anybody's access changed.
 */
export async function loadClientTeam(
  businessId: string | null,
  slow: boolean,
): Promise<Loaded<ClientTeamScreen>> {
  if (!hasDatabase()) {
    return {
      ok: false,
      code: "NO_DATABASE",
      message:
        "This deployment has no database configured, so there is nothing to read. That is not the same claim as “your team could not be read”.",
    };
  }

  try {
    const [{ readBalanceScreen }, { sql }, store, acting] = await Promise.all([
      import("../live-source"),
      import("@/lib/ledger/db"),
      import("@/lib/team/store"),
      import("./acting"),
    ]);

    const balance = await readBalanceScreen(businessId);
    if (!balance.ok) return balance;
    const { header } = balance.value;

    // `?state=loading` slows the READ, so the real skeleton is held open by a
    // genuinely slow query rather than by a mock of a slow render.
    if (slow) await new Promise((resolve) => setTimeout(resolve, 1200));

    const [members, actingAs] = await Promise.all([
      store.readTeam(header.businessId, sql),
      acting.resolveActingAdmin(header.businessId, sql),
    ]);

    return {
      ok: true,
      value: {
        subject: {
          businessId: header.businessId,
          legalName: header.legalName,
          accountName: header.accountName,
          asOf: header.asOf,
          live: header.live,
          businesses: header.businesses,
        },
        actingAs,
        members: members.map((detail) => toLine(detail, actingAs?.memberId ?? null)),
      },
    };
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return {
      ok: false,
      code: "TEAM_READ_FAILED",
      message: `Your team could not be read. Nobody's access changed — every statement on this path is a SELECT. ${message.slice(0, 300)}`,
    };
  }
}
