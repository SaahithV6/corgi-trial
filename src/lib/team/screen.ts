/**
 * What `/team` renders, in one shape, assembled on the server.
 *
 * The component that draws this screen is a pure function of the value below.
 * That is what makes the five URL states honest: `default` and `edge` are this
 * value read from the live database, `loading` is this value behind a
 * genuinely slow read, and `empty` and `error` are this value constructed by
 * `src/components/team/fixtures.ts`. The renderer cannot tell them apart, so a
 * fixture state proves the real state renders.
 *
 * THE BALANCE ON THIS SCREEN COMES FROM THE LEDGER'S OWN READER.
 * `availableBalance()` in `@/lib/ledger/balances` — not a query of this
 * module's own. A team screen that summed `journal_line` itself would be a
 * fifth definition of "available", which is the defect migration 0022 spent a
 * whole pass undoing.
 */

import "server-only";

import { availableBalance } from "@/lib/ledger/balances";
import { sql, type Sql } from "@/lib/ledger/db";
import { findBusiness, listBusinesses } from "@/lib/ledger/readers";

import { readTeam, readTeamInvariants } from "./store";
import type { TeamMemberDetail } from "./types";

export type TeamInvariant = {
  readonly view: string;
  readonly claim: string;
  readonly rows: number;
};

export type TeamScreen = {
  readonly businessId: string;
  readonly legalName: string;
  readonly members: readonly TeamMemberDetail[];
  /** Every business on the book, so the screen can switch customer. */
  readonly businesses: readonly { readonly id: string; readonly legalName: string }[];
  readonly balance: {
    readonly ledgerCents: bigint;
    readonly holdsCents: bigint;
    readonly availableCents: bigint;
  } | null;
  readonly invariants: readonly TeamInvariant[];
  readonly asOf: string;
  /**
   * True when every figure on this screen came out of the database on this
   * request. False for the fixture states, which say FIXTURE on their face.
   */
  readonly live: boolean;
};

export type TeamScreenResult =
  | { readonly ok: true; readonly screen: TeamScreen }
  | { readonly ok: false; readonly message: string };

/**
 * Read the whole screen.
 *
 * `businessId` is a request parameter and therefore a CLAIM: it is resolved
 * against the book, and an id that names nothing falls back to the first
 * customer rather than throwing. A 500 on a mistyped query string is a worse
 * answer than showing the default.
 */
export async function readTeamScreen(
  businessId: string | null,
  conn: Sql = sql,
): Promise<TeamScreenResult> {
  try {
    const businesses = await listBusinesses(conn);
    const wanted =
      (businessId === null ? null : await findBusiness(businessId, conn)) ??
      (businesses[0] ?? null);
    if (wanted === null) {
      return { ok: false, message: "There is no business on this book yet." };
    }

    const [members, invariants, availability] = await Promise.all([
      readTeam(wanted.businessId, conn),
      readTeamInvariants(conn),
      // A business whose 2100 leaf was never opened has no balance to show, and
      // that is a rendered state rather than a crash: KYB gates the account, so
      // a pending business genuinely has a team and no money.
      wanted.depositAccountId === null
        ? Promise.resolve(null)
        : availableBalance(wanted.businessId, conn).catch(() => null),
    ]);

    return {
      ok: true,
      screen: {
        businessId: wanted.businessId,
        legalName: wanted.legalName,
        members,
        businesses: businesses.map((b) => ({ id: b.businessId, legalName: b.legalName })),
        balance:
          availability === null
            ? null
            : {
                ledgerCents: availability.ledgerCents,
                holdsCents: availability.holdsCents,
                availableCents: availability.availableCents,
              },
        invariants,
        asOf: new Date().toISOString(),
        live: true,
      },
    };
  } catch (thrown) {
    return {
      ok: false,
      message:
        thrown instanceof Error
          ? `${thrown.name}: ${thrown.message}`
          : "the team could not be read",
    };
  }
}

/**
 * The edge view: only the members who were removed or suspended while holding
 * an outstanding authorisation.
 *
 * A FILTER OVER THE LIVE SCREEN, not a separate query and not a fixture. The
 * rows are the same rows the default state shows; this picks the ones that are
 * the point. If nobody is in that state the screen says so plainly rather than
 * inventing somebody — a demo state that manufactures its own subject proves
 * nothing.
 */
export function edgeMembers(screen: TeamScreen): readonly TeamMemberDetail[] {
  return screen.members.filter(
    (m) => m.member.terms.state !== "active" && m.outstanding.length > 0,
  );
}
