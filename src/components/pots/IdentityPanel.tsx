import { Money } from "@/components/ui/Money";
import { Badge, FieldLabel, Note, Panel } from "@/components/ui/primitives";

import type { AvailabilityView, IdentityView, PotView } from "./data-contract";

/**
 * The two pieces of arithmetic this screen exists to show, written out.
 *
 * 1. `main + Σ pots = total deposit liability`, with the right-hand side
 *    derived a SECOND, independent way — a recursive walk of the customer's
 *    deposit subtree in `v_pot_subtree`, which never reads the `pot` table —
 *    and the difference between the two printed as a figure. A screen that
 *    says "balanced ✓" is asking to be believed. This one shows its working.
 *
 * 2. `available = main − card holds − uncleared credits`, on the MAIN leaf.
 *    This is the number that answers the design question the feature turns on:
 *    money moved into a pot leaves the main leaf, so `main` drops, so
 *    `available` drops with it. A pot ring-fences money — it is not a label.
 *    Nothing in `availableBalance()` knows pots exist; the fall-out is
 *    structural, which is why the row below labels it as derived rather than
 *    enforced.
 */
export function IdentityPanel({
  identity,
  availability,
  pots,
  legalName,
}: {
  readonly identity: IdentityView;
  readonly availability: AvailabilityView;
  readonly pots: readonly PotView[];
  readonly legalName: string;
}) {
  return (
    <Panel
      id="identity"
      title="The identity, shown"
      description={`Every figure below is SUM(journal_line) over an account. ${legalName} holds one deposit leaf and ${pots.length === 1 ? "one pot" : `${pots.length} pots`} beneath it.`}
      actions={
        identity.holds ? (
          <Badge tone="positive">two derivations agree</Badge>
        ) : (
          <Badge tone="negative">DRIFT — v_pot_identity_drift will be non-empty</Badge>
        )
      }
    >
      <div className="space-y-5 px-5 py-4">
        {/* ---- main + Σ pots = total ------------------------------------ */}
        <div>
          <FieldLabel>main + Σ pots = total deposit liability</FieldLabel>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
            <Money cents={identity.mainCents} className="font-semibold" />
            <span className="text-muted">+</span>
            <Money cents={identity.potsCents} className="font-semibold" />
            <span className="text-muted">=</span>
            <Money cents={identity.totalCents} className="font-semibold" />
          </div>
          <dl className="mt-3 grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
            <Row
              label="main — the 2100 deposit leaf, code 2100"
              cents={identity.mainCents}
            />
            <Row
              label={`Σ pots — ${pots.length} account${pots.length === 1 ? "" : "s"}, codes 2100.<uuid>`}
              cents={identity.potsCents}
            />
            <Row
              label="total, summed from the rows above"
              cents={identity.totalCents}
            />
            <Row
              label="v_pot_subtree — WITH RECURSIVE over account.parent_id"
              cents={identity.subtreeCents}
            />
          </dl>
          <p className="mt-2 text-xs text-muted">
            difference:{" "}
            <Money
              cents={identity.differenceCents}
              tone="direction"
              signed
              className="font-semibold"
            />{" "}
            — the two derivations share no query, no table and no code path, so
            a zero here is agreement and not a restatement.
          </p>
        </div>

        {/* ---- available ------------------------------------------------ */}
        <div className="border-t border-border pt-4">
          <FieldLabel>available on the main balance</FieldLabel>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-base">
            <Money cents={availability.ledgerCents} className="font-semibold" />
            <span className="text-muted">−</span>
            <Money cents={availability.holdsCents} className="font-semibold" />
            <span className="text-muted">−</span>
            <Money cents={availability.unclearedCents} className="font-semibold" />
            <span className="text-muted">=</span>
            <Money
              cents={availability.availableCents}
              className="font-semibold"
              tone="auto"
            />
          </div>
          <dl className="mt-3 grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
            <Row label="ledger — the main leaf only, pots excluded" cents={availability.ledgerCents} />
            <Row label="− active card authorisation holds" cents={availability.holdsCents} />
            <Row label="− uncleared inbound credits" cents={availability.unclearedCents} />
            <Row label="= available to spend, or to earmark" cents={availability.availableCents} />
          </dl>
        </div>

        <Note title="Why moving money into a pot lowers what can be spent">
          <p>
            <code>availableBalance()</code> reads the account whose code is
            exactly <code>2100</code>. A pot&rsquo;s account code is{" "}
            <code>2100.&lt;pot uuid&gt;</code>, so a pot is invisible to it — and
            to <code>v_available_balance</code>,{" "}
            <code>v_overdrawn_accounts</code>, the statements reader and the card
            hold store, all of which address a customer&rsquo;s spendable money
            by that same exact equality.
          </p>
          <p className="mt-2">
            An internal transfer DEBITS the main leaf and CREDITS the pot. The
            main leaf&rsquo;s balance falls by the amount moved, so available
            falls with it; the customer&rsquo;s total is unchanged, so the
            deposit control account still balances. Not one line of{" "}
            <code>src/lib/ledger/**</code> was changed to get that behaviour: it
            is what happens when the pot is a real account and the transfer is a
            real posting. A pot that left available alone would be a label on a
            spreadsheet, and a card swipe would spend the payroll money.
          </p>
        </Note>
      </div>
    </Panel>
  );
}

function Row({ label, cents }: { readonly label: string; readonly cents: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border/60 pb-1">
      <dt className="text-muted">{label}</dt>
      <dd>
        <Money cents={cents} />
      </dd>
    </div>
  );
}
