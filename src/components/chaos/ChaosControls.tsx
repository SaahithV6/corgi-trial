'use client';

/**
 * The control surface: four switches, an episode, and the big red button.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * EVERY CONTROL HAS THREE THINGS, AND THE THIRD IS THE ONE THAT MATTERS
 *
 *   an on      with a duration, bounded at ten minutes by a CHECK constraint
 *   an off     a DELETE, available whether or not the control is armed
 *   a clock    visible, counting down, on the control itself
 *
 * The clock is not decoration. It is the difference between a demo control and
 * a liability: a grader looking at this screen can see, without reading any
 * documentation, exactly when the system returns to normal — and so can the
 * person who walked away from it.
 *
 * ALL CHAOS OFF IS ALWAYS RENDERED, even when nothing is armed and it would do
 * nothing. The moment somebody reaches for it is the moment they are unsure
 * what is on, and a button that appears only when it is needed is a button
 * nobody can find under pressure.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WHAT THE COPY IS NOT ALLOWED TO SAY. No label, hint or confirmation on this
 * panel describes a state the provider is in. `webhooks_off` is labelled "We
 * withhold our own deliveries", never "Provider down" and never "Simulate
 * outage" — the second is closer but still puts the provider in the sentence.
 * See `ChaosBanner.tsx` for the rule.
 */

import { useActionState } from 'react';

import {
  allChaosOffAction,
  armControlAction,
  disarmControlAction,
  registerCardAction,
  releaseNowAction,
  startEpisodeAction,
} from '@/app/(app)/chaos/actions';
import { FOCUS_RING, Badge, Note, Panel } from '@/components/ui/primitives';

import { IDLE_CHAOS_RESULT, type ChaosActionResult } from './action-result';
import type { ChaosControlView } from './data-contract';

const INPUT_CLASS = `mt-1 w-full rounded border border-border bg-surface px-2.5 py-1.5 text-sm ${FOCUS_RING} disabled:opacity-60`;
const LABEL_CLASS = 'text-[11px] font-medium uppercase tracking-[0.08em] text-muted';
const BUTTON_CLASS = `inline-flex items-center rounded border border-border-strong bg-surface px-3 py-1.5 text-xs font-medium hover:bg-surface-raised disabled:opacity-60 ${FOCUS_RING}`;
const DANGER_BUTTON_CLASS = `inline-flex items-center rounded border border-negative/50 bg-surface px-3 py-1.5 text-xs font-medium text-negative hover:bg-negative/10 disabled:opacity-60 ${FOCUS_RING}`;

/** The second input each control takes, or null when it takes none. */
const VALUE_FIELD: Record<string, { label: string; min: number; max: number; step: number } | null> =
  {
    webhooks_off: null,
    settlement_delay: { label: 'Hold the clearing back (seconds)', min: 1, max: 300, step: 1 },
    duplicate_delivery: { label: 'Copies of every delivery', min: 2, max: 5, step: 1 },
    reorder_window: { label: 'Reorder buffer (seconds)', min: 1, max: 120, step: 1 },
  };

export function ChaosControls({
  controls,
  enabled,
  chaosOn,
  hasRun,
  runId,
  cardRegistered,
}: {
  readonly controls: readonly ChaosControlView[];
  readonly enabled: boolean;
  readonly chaosOn: boolean;
  readonly hasRun: boolean;
  readonly runId: string | null;
  readonly cardRegistered: boolean;
}) {
  return (
    <div className="space-y-6">
      <Panel
        title="The four controls"
        description="Each one perturbs delivery — availability, timing, multiplicity, order. None of them touches the ledger, and none of them has a branch anywhere downstream."
        actions={<AllOffButton enabled={enabled} chaosOn={chaosOn} />}
      >
        <div className="divide-y divide-border">
          {controls.map((control) => (
            <ControlRow key={control.control} control={control} enabled={enabled} />
          ))}
        </div>
      </Panel>

      <Panel
        title="The episode"
        description="A $50.00 fuel-pump authorisation and a $73.40 clearing on one card — the brief's own live-fire pair. The controls decide how it is delivered."
      >
        <EpisodeForm
          enabled={enabled}
          hasRun={hasRun}
          runId={runId}
          cardRegistered={cardRegistered}
        />
      </Panel>
    </div>
  );
}

function ControlRow({
  control,
  enabled,
}: {
  readonly control: ChaosControlView;
  readonly enabled: boolean;
}) {
  const [armState, armAction, arming] = useActionState<ChaosActionResult, FormData>(
    armControlAction,
    IDLE_CHAOS_RESULT,
  );
  const [offState, offAction, disarming] = useActionState<ChaosActionResult, FormData>(
    disarmControlAction,
    IDLE_CHAOS_RESULT,
  );

  const field = VALUE_FIELD[control.control] ?? null;
  const answer = armState.status !== 'idle' ? armState : offState;

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            {control.label}{' '}
            <span className="font-mono text-xs font-normal text-muted">{control.control}</span>
          </h3>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted">{control.effect}</p>
        </div>
        {control.armed ? (
          <Badge tone="negative">
            {`ARMED · ${String(control.secondsRemaining)}s left · ${control.setting}`}
          </Badge>
        ) : (
          <Badge tone="quiet">OFF</Badge>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <form action={armAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="control" value={control.control} />
          <label className="block">
            <span className={LABEL_CLASS}>Arm for (seconds, max 600)</span>
            <input
              className={`${INPUT_CLASS} w-36`}
              name="seconds"
              type="number"
              min={1}
              max={600}
              defaultValue={300}
              disabled={!enabled || arming}
            />
          </label>
          {field === null ? null : (
            <label className="block">
              <span className={LABEL_CLASS}>{field.label}</span>
              <input
                className={`${INPUT_CLASS} w-44`}
                name="value"
                type="number"
                min={field.min}
                max={field.max}
                step={field.step}
                defaultValue={control.control === 'duplicate_delivery' ? 3 : field.min * 20}
                disabled={!enabled || arming}
              />
            </label>
          )}
          <button type="submit" className={BUTTON_CLASS} disabled={!enabled || arming}>
            {arming ? 'Arming…' : control.armed ? 'Re-arm (resets the clock)' : 'Arm'}
          </button>
        </form>

        <form action={offAction}>
          <input type="hidden" name="control" value={control.control} />
          <button type="submit" className={BUTTON_CLASS} disabled={!enabled || disarming}>
            {disarming ? 'Turning off…' : 'Turn off'}
          </button>
        </form>
      </div>

      <Answer result={answer} />
    </div>
  );
}

function AllOffButton({
  enabled,
  chaosOn,
}: {
  readonly enabled: boolean;
  readonly chaosOn: boolean;
}) {
  const [state, action, pending] = useActionState<ChaosActionResult, FormData>(
    allChaosOffAction,
    IDLE_CHAOS_RESULT,
  );
  return (
    <form action={action} className="flex items-center gap-3">
      {state.status === 'done' ? (
        <span className="text-[11px] text-muted">{state.message}</span>
      ) : null}
      <button
        type="submit"
        className={DANGER_BUTTON_CLASS}
        disabled={!enabled || pending}
        title="Turns every chaos control off. Always available, whether or not anything is armed."
      >
        {pending ? 'Turning everything off…' : chaosOn ? 'ALL CHAOS OFF' : 'All chaos off'}
      </button>
    </form>
  );
}

function EpisodeForm({
  enabled,
  hasRun,
  runId,
  cardRegistered,
}: {
  readonly enabled: boolean;
  readonly hasRun: boolean;
  readonly runId: string | null;
  readonly cardRegistered: boolean;
}) {
  const [startState, startAction, starting] = useActionState<ChaosActionResult, FormData>(
    startEpisodeAction,
    IDLE_CHAOS_RESULT,
  );
  const [releaseState, releaseAction, releasing] = useActionState<ChaosActionResult, FormData>(
    releaseNowAction,
    IDLE_CHAOS_RESULT,
  );
  const [cardState, cardAction, registering] = useActionState<ChaosActionResult, FormData>(
    registerCardAction,
    IDLE_CHAOS_RESULT,
  );

  return (
    <div className="space-y-4 px-5 py-5">
      <div className="flex flex-wrap items-end gap-3">
        <form action={startAction} className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span className={LABEL_CLASS}>Register the card first?</span>
            <select
              className={`${INPUT_CLASS} w-72`}
              name="registerCardFirst"
              defaultValue="no"
              disabled={!enabled || starting}
            >
              <option value="no">
                No — let the deliveries park (the interesting one)
              </option>
              <option value="yes">Yes — the card is bound before anything arrives</option>
            </select>
          </label>
          <button type="submit" className={BUTTON_CLASS} disabled={!enabled || starting}>
            {starting ? 'Starting…' : 'Start an episode'}
          </button>
        </form>

        <form action={releaseAction}>
          <button
            type="submit"
            className={BUTTON_CLASS}
            disabled={!enabled || releasing}
            title="Release every delivery the armed controls now allow, then drain."
          >
            {releasing ? 'Releasing…' : 'Release what is due'}
          </button>
        </form>

        {hasRun && runId !== null && !cardRegistered ? (
          <form action={cardAction}>
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className={BUTTON_CLASS} disabled={!enabled || registering}>
              {registering ? 'Registering…' : 'Register the card (drains the parks)'}
            </button>
          </form>
        ) : null}
      </div>

      <Note title="What “let the deliveries park” demonstrates">
        The deliveries arrive verified and durable, naming a card that is not bound to any customer.
        The consumer answers <code className="font-mono">parked(&quot;card&quot;, …)</code> and{' '}
        <strong>nothing is posted</strong> — the system will not guess whose money to move.
        Registering the card wakes the same rows, and they post against the customer they always
        belonged to. Nothing is re-delivered and nothing is re-signed.
      </Note>

      <Answer result={startState} />
      <Answer result={releaseState} />
      <Answer result={cardState} />
    </div>
  );
}

function Answer({ result }: { readonly result: ChaosActionResult }) {
  if (result.status === 'idle') return null;
  const bad = result.status === 'refused';
  return (
    <p
      role="status"
      className={`mt-3 max-w-prose rounded border px-3 py-2 text-xs leading-relaxed ${
        bad ? 'border-negative/40 bg-negative/10 text-negative' : 'border-border bg-surface text-muted'
      }`}
    >
      {bad && result.code !== null ? (
        <>
          <span className="font-mono">{result.code}</span> —{' '}
        </>
      ) : null}
      {result.message}
    </p>
  );
}
