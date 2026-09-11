import { Badge } from "@/components/ui/primitives";
import { ACTOR_KIND_DESCRIPTION, ACTOR_KIND_LABEL, type ActorKind } from "@/lib/audit/types";

/**
 * Who took the action, at a glance.
 *
 * THE ONE REQUIREMENT THIS COMPONENT EXISTS FOR: an action taken by an
 * autonomous agent must be distinguishable from one taken by a person without
 * reading the row. So the five kinds do not share a treatment:
 *
 *   human         quiet border, the name. The baseline; most rows are this.
 *   agent         NEGATIVE tone and the word AGENT in caps. Not because an
 *                 agent action is wrong — the surface is designed for it —
 *                 but because it is the row a reviewer must never skim past,
 *                 and a colour reserved for "look here" is the only thing
 *                 that survives a screenshot in a debrief.
 *   system        quiet, prefixed `run:` — a cron tick is not a person and
 *                 must not read like one, but it is also not a judgement
 *                 call and must not compete with the agent for attention.
 *   provider      quiet, prefixed with the provider name. A counterparty.
 *   unattributed  NEGATIVE tone. The store recorded the act and not the
 *                 actor; that is a defect and it is drawn like one.
 *
 * Colour is never the only channel: each badge carries its own word, and the
 * `title` carries the full sentence for a screen reader and a hover.
 */
export function ActorBadge({
  kind,
  label,
}: {
  readonly kind: ActorKind;
  readonly label: string;
}) {
  if (kind === "agent") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge tone="negative" title={ACTOR_KIND_DESCRIPTION.agent}>
          AGENT
        </Badge>
        <span className="text-sm">{label}</span>
      </span>
    );
  }

  if (kind === "unattributed") {
    return (
      <Badge tone="negative" title={ACTOR_KIND_DESCRIPTION.unattributed}>
        no actor recorded
      </Badge>
    );
  }

  if (kind === "human") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Badge tone="neutral" title={ACTOR_KIND_DESCRIPTION.human}>
          person
        </Badge>
        <span className="text-sm">{label}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="quiet" title={ACTOR_KIND_DESCRIPTION[kind]}>
        {kind === "system" ? "run" : "provider"}
      </Badge>
      <span className="text-sm text-muted">{label}</span>
    </span>
  );
}

export function ActorKindLabel({ kind }: { readonly kind: ActorKind }) {
  return <>{ACTOR_KIND_LABEL[kind]}</>;
}
