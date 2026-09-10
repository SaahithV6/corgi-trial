"use server";

/**
 * The front door's one write-free action.
 *
 * ============================================================================
 * A SERVER ACTION IS A PUBLIC POST ENDPOINT — anyone who can send the same
 * POST reaches it. `src/app/(app)/approvals/actions.ts` says it at length and
 * that warning applies here too, so this action is deliberately the most
 * boring thing it could be: it navigates, and it touches nothing.
 * ============================================================================
 *
 * The account id that arrives in the form is treated as a CLAIM, not as a
 * fact. It is checked against `isAccountId` — the same guard the query layer
 * uses before a `::uuid` cast — and a value that does not pass is sent to the
 * account directory rather than interpolated into a URL. Nothing here reads a
 * balance, decides anything, or writes a row: the account screen re-reads
 * everything from the journal when it renders, so a forged id gets you a
 * "no such account" page and nothing else.
 *
 * The decision path on this page is NOT here. Approving and rejecting go
 * through `decideAction` in the approvals route, which is the one place those
 * refusals are translated, logged and revalidated — a second copy of that
 * action on the front door would be a second place for maker-checker to be
 * got wrong.
 */

import { redirect } from "next/navigation";
import type { Route } from "next";

import { isAccountId } from "@/lib/ledger/queries";

export async function openAccountAction(formData: FormData): Promise<never> {
  const requested = formData.get("accountId");
  const accountId = typeof requested === "string" ? requested.trim() : "";

  if (!isAccountId(accountId)) redirect("/accounts");

  redirect(`/accounts/${accountId}` as Route);
}
