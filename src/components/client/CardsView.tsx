import { Money } from "@/components/ui/Money";
import {
  Badge,
  FieldLabel,
  Note,
  Panel,
} from "@/components/ui/primitives";
import { describeMcc } from "@/lib/cards/mcc";
import { formatTimestamp } from "@/lib/format/datetime";
import { formatUsd } from "@/lib/format/money";

import {
  CardControlsForm,
  FreezeCardButton,
  type CardControlsDefaults,
} from "./CardControlsForm";
import type { CardLine, CardsScreen, DecisionLine } from "./contract";
import { ClientHeaderBar } from "./Chrome";
import type { ClientView } from "./view-state";

/**
 * The card for each person on the team, what it can and cannot do, and why a
 * declined authorisation was declined.
 *
 * ===========================================================================
 * THE DECLINE SENTENCE IS NOT WRITTEN HERE
 * ===========================================================================
 *
 * `decision.reason` is rendered verbatim from `card_auth_decision.reason`. That
 * sentence was composed at decision time, inside the issuer's measured 6000 ms
 * authorisation deadline, by the function that actually made the decision, and
 * it was written down in the same row as the rule that fired and the figures
 * the rule compared.
 *
 * There is deliberately no rule-to-sentence lookup table in this component, and
 * there is none anywhere else in this build either. A second mapping in the UI
 * would be a second answer to "why was I declined", it would drift from the
 * stored one the moment either changed, and the drift would be discovered by a
 * cardholder being told one thing on screen and another in a dispute six months
 * later. The screen's job here is to show the record, not to paraphrase it.
 *
 * The machine-readable `rule` is printed beside the sentence in small type, so
 * a customer ringing up can read out a token that means the same thing to the
 * person who answers.
 *
 * ===========================================================================
 * A LIMIT OF NONE AND A LIMIT OF ZERO ARE DIFFERENT
 * ===========================================================================
 *
 * `null` means there is no limit of that kind on this card; `0` means this card
 * may spend nothing. Both are reachable and they mean opposite things, so they
 * are rendered as different sentences. Collapsing them — the obvious `limit ||
 * "no limit"` — fails open on the dangerous one, which is why the store keeps
 * them apart and this screen keeps them apart too.
 */
export function CardsView({
  screen,
  view,
  declinesOnly,
}: {
  readonly screen: CardsScreen;
  readonly view: ClientView;
  readonly declinesOnly: boolean;
}) {
  const { header, cards, decisions } = screen;

  // A VIEW over decisions that are already scoped to this business by a WHERE
  // clause. Narrowing to declines is the point of the edge state; it is not
  // what keeps another customer's cards off this page.
  const shown = declinesOnly ? decisions.filter((d) => d.outcome === "decline") : decisions;

  return (
    <div className="space-y-6">
      <ClientHeaderBar
        screen="/client/cards"
        view={view}
        header={header}
        title="Your cards"
        subtitle="One card for each person on your team, what each card is allowed to do, and every authorisation decision made on them."
      />

      <Panel
        title="Cards"
        description={
          cards.length === 0
            ? "No cards have been issued on this account yet."
            : "A card's limits are a version, not a setting: changing them writes a new version and the old one still explains the decisions made under it."
        }
      >
        {cards.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            There are no cards on this account.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {cards.map((card) => (
              <CardRow key={card.cardId} card={card} businessId={header.businessId} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title={declinesOnly ? "Declined authorisations" : "Authorisation decisions"}
        description={
          shown.length === 0
            ? declinesOnly
              ? "No card on this account has been declined."
              : "No authorisation has been decided on these cards yet."
            : "Every time a card was presented, what we decided, and the reason recorded at the moment we decided it — inside the time the network gives us to answer."
        }
      >
        {shown.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            {declinesOnly
              ? "Nothing has been declined on this account. That is a real answer about a real book."
              : "There is nothing to show yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {shown.map((decision) => (
              <DecisionRow key={decision.id} decision={decision} />
            ))}
          </ul>
        )}
      </Panel>

      <Note title="What happens when a card is used">
        Presenting a card does not move money. The shop asks us whether we will
        stand behind an amount; we answer in under six seconds, and if we say
        yes we set that amount aside so it cannot be spent twice. The money
        itself moves later — sometimes days later, and often for a different
        amount, because a fuel pump asks for a round number before it knows what
        you pumped and a restaurant asks before the tip. Both figures are on your{" "}
        <strong className="font-medium text-text">Activity</strong> page, side by
        side, for every card payment.
      </Note>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function limitSentence(label: string, cents: bigint | null) {
  if (cents === null) {
    return (
      <div>
        <FieldLabel>{label}</FieldLabel>
        <p className="text-sm text-muted">No limit</p>
      </div>
    );
  }
  if (cents === 0n) {
    return (
      <div>
        <FieldLabel>{label}</FieldLabel>
        <p className="text-sm">
          <Money cents={0n} /> — this card may spend nothing
        </p>
      </div>
    );
  }
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <p className="text-sm">
        <Money cents={cents} tone="neutral" />
      </p>
    </div>
  );
}

/**
 * The current rules, as the characters the form should open with.
 *
 * `null` becomes `""` — no limit of this kind — and `0` becomes `"0.00"`, which
 * means the card spends nothing. The two are opposite instructions and this is
 * the point on the round trip where collapsing them would be easiest and worst.
 *
 * Formatted WITHOUT grouping: a field pre-filled with "2,500.00" round-trips to
 * a parse failure, which is the exact pressure that puts a float back on the
 * path. `PayView` makes the same choice for the same reason.
 */
function limitField(cents: bigint | null): string {
  return cents === null ? "" : formatUsd(cents, { symbol: false, group: false });
}

function controlDefaults(card: CardLine, businessId: string): CardControlsDefaults {
  return {
    cardId: card.cardId,
    businessId,
    perTxn: limitField(card.perTxnCents),
    daily: limitField(card.dailyCents),
    monthly: limitField(card.monthlyCents),
    blockedMccs: card.blockedMccs.join(", "),
    frozen: card.state === "frozen",
    // `null` is "nobody has ever set a control version", which is not the same
    // as "active with no limits" — the card is not governed at all.
    ungoverned: card.state === null,
  };
}

function CardRow({
  card,
  businessId,
}: {
  readonly card: CardLine;
  readonly businessId: string;
}) {
  const cardLabel =
    card.holderName ??
    card.nickname ??
    (card.lastFour === null ? "this card" : `the card ending ${card.lastFour}`);

  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">
              {card.holderName ?? card.nickname ?? "Unassigned card"}
            </span>
            <span className="text-sm text-muted">
              {card.lastFour === null ? "card" : `•• ${card.lastFour}`}
            </span>
            {card.state === "frozen" ? (
              <Badge tone="negative">frozen — nothing will be approved</Badge>
            ) : card.state === "active" ? (
              <Badge tone="positive">active</Badge>
            ) : (
              <Badge tone="quiet" title="Nobody has set limits on this card. It is not governed by a control version.">
                no limits set
              </Badge>
            )}
            {card.controlVersion === null ? null : (
              <Badge tone="quiet" title="The version of this card's rules that is in force. Older versions still explain older decisions.">
                rules v{card.controlVersion}
              </Badge>
            )}
          </div>

          {card.nickname === null || card.holderName === null ? null : (
            <p className="mt-0.5 text-xs text-muted">{card.nickname}</p>
          )}

          {card.blockedMccs.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              No merchant types are blocked on this card.
            </p>
          ) : (
            <p className="mt-2 max-w-prose text-xs leading-relaxed text-muted">
              <span className="font-medium text-text">Cannot be used at: </span>
              {card.blockedMccs.map((mcc) => describeMcc(mcc)).join(" · ")}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap gap-x-6 gap-y-2 text-right">
          {limitSentence("Per payment", card.perTxnCents)}
          {limitSentence("Per day", card.dailyCents)}
          {limitSentence("Per month", card.monthlyCents)}
          {/* AUTHORISED, NOT SPENT. These two figures are the sum of the
              amounts we APPROVED on this card — `card_auth_decision` — and an
              approval is a promise to stand behind an amount, not a payment.
              A fuel pump authorises $50 before it knows what you pumped and
              settles for $31.20; the note at the foot of this screen says so,
              and "Spent today: $50.00" directly above it said otherwise.

              They are labelled rather than recomputed because this is exactly
              the figure the two limits beside them are compared against:
              `decide.ts` checks the day and month windows against this same
              sum, so relabelling makes the tile explain the limit next to it,
              while a settled figure would explain nothing about either. What
              actually left the account is on Activity, beside its
              authorisation. */}
          <div>
            <FieldLabel>Authorised today</FieldLabel>
            <p className="text-sm">
              <Money cents={card.spentTodayCents} tone="neutral" />
            </p>
          </div>
          <div>
            <FieldLabel>Authorised this month</FieldLabel>
            <p className="text-sm">
              <Money cents={card.spentThisMonthCents} tone="neutral" />
            </p>
          </div>
          <p className="w-full max-w-prose text-left text-xs leading-relaxed text-muted">
            The two figures above are what we approved on this card, which is
            what the daily and monthly limits are measured against. They are not
            what was taken from your account: an approval sets an amount aside
            and the payment settles later, often for less. What was actually
            taken is on your{" "}
            <strong className="font-medium text-text">Activity</strong> page,
            beside the authorisation it settled.
          </p>
        </div>
      </div>

      {/* One press, above the rules form. Stopping a card is the safest thing
          on this screen and it used to be the slowest: a radio, a mandatory
          reason, and five other fields that could refuse the freeze on a typo. */}
      <FreezeCardButton
        cardId={card.cardId}
        businessId={businessId}
        frozen={card.state === "frozen"}
        cardLabel={cardLabel}
      />

      {/* KEYED ON THE STATE IT OPENS WITH. Every field below is uncontrolled
          (`defaultChecked`, `defaultValue`), which React does not re-sync when
          new props arrive — so after the one-press freeze above revalidated
          this page, the radio here still read "On", and the next "Save these
          rules" would have written `active` and quietly unfrozen a card nobody
          asked to unfreeze. Changing the key remounts the form so it re-opens
          pre-filled with what is actually in force. */}
      <CardControlsForm
        key={`${card.state ?? "ungoverned"}:${card.controlVersion ?? 0}`}
        defaults={controlDefaults(card, businessId)}
        cardLabel={cardLabel}
      />
    </li>
  );
}

function DecisionRow({ decision }: { readonly decision: DecisionLine }) {
  const declined = decision.outcome === "decline";
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {declined ? (
              <Badge tone="negative">declined</Badge>
            ) : decision.judged ? (
              <Badge tone="positive">approved</Badge>
            ) : (
              // APPROVED, AND NOTHING CHECKED IT. Not a failure and not painted
              // as one — but not the same green badge as an approval a limit
              // cleared, which is what it wore until now. The recorded sentence
              // below already says why; this stops the badge contradicting it.
              <Badge
                tone="quiet"
                title="Approved because no control applied to this card, not because a control allowed it. Nothing was compared."
              >
                approved · nothing checked it
              </Badge>
            )}
            <span className="text-sm font-medium">{decision.merchant}</span>
            {decision.lastFour === null ? null : (
              <span className="text-xs text-muted">•• {decision.lastFour}</span>
            )}
            {decision.memberName === null ? null : (
              <span className="text-xs text-muted">{decision.memberName}</span>
            )}
            {decision.source === "harness" ? (
              <Badge
                tone="quiet"
                title="Our own test probe, not a real authorisation from the card network. Labelled rather than hidden."
              >
                our test, not the network
              </Badge>
            ) : null}
          </div>

          {/* The recorded sentence, verbatim. See the header of this file. */}
          <p className="mt-1 max-w-prose text-xs leading-relaxed">{decision.reason}</p>

          <p className="mt-1 text-[11px] text-muted">
            {/* `decidedAt` is an ISO instant and it used to print as one.
                `formatTimestamp` renders every instant in this build in the
                one banking timezone, so a decline's time can be compared with
                a hold's release time and a statement's cut-off without the
                reader converting anything in their head. */}
            {formatTimestamp(decision.decidedAt)}
            {decision.mcc === null ? null : ` · ${describeMcc(decision.mcc)}`}
            {" · "}
            <code>{decision.rule}</code>
          </p>
        </div>

        {/* EVERY ROW HERE IS AN AUTHORISATION, AND NONE OF THEM IS A CHARGE.
            The figure is what the shop asked us to stand behind. On an
            approval it was set aside as a hold and the money is still in the
            account; on a decline nothing was set aside at all. The column used
            to print the amount bare, which reads as a charge — and beside a
            "Spent today" tile it read as a charge twice. */}
        <div className="shrink-0 text-right">
          <Money cents={decision.amountCents} tone="neutral" />
          <p className="mt-0.5 text-[11px] text-muted">
            {declined
              ? "asked for · nothing held"
              : "authorised · held, not yet taken"}
          </p>
        </div>
      </div>
    </li>
  );
}
