import { Money } from "@/components/ui/Money";
import {
  Badge,
  FieldLabel,
  Note,
  Panel,
} from "@/components/ui/primitives";
import { describeMcc } from "@/lib/cards/mcc";

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
              <CardRow key={card.cardId} card={card} />
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

function CardRow({ card }: { readonly card: CardLine }) {
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
          <div>
            <FieldLabel>Spent today</FieldLabel>
            <p className="text-sm">
              <Money cents={card.spentTodayCents} tone="neutral" />
            </p>
          </div>
          <div>
            <FieldLabel>Spent this month</FieldLabel>
            <p className="text-sm">
              <Money cents={card.spentThisMonthCents} tone="neutral" />
            </p>
          </div>
        </div>
      </div>
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
            ) : (
              <Badge tone="positive">approved</Badge>
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
            {decision.decidedAt}
            {decision.mcc === null ? null : ` · ${describeMcc(decision.mcc)}`}
            {" · "}
            <code>{decision.rule}</code>
          </p>
        </div>

        <div className="shrink-0 text-right">
          <Money cents={decision.amountCents} tone="neutral" />
        </div>
      </div>
    </li>
  );
}
