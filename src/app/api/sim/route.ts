/**
 * POST /api/sim — the ACH simulator's control surface over HTTP.
 *
 * OFF UNLESS TWO CONDITIONS BOTH HOLD:
 *
 *   1. `NODE_ENV !== 'production'`, and
 *   2. `ACH_SIM_CONTROL_ENABLED === 'true'`.
 *
 * Two, not one, and neither of them defaults to on. A single flag is one
 * mis-set environment variable away from a production endpoint that mints
 * money-shaped events; requiring a non-production build AS WELL means the flag
 * alone cannot do it. When either condition fails the route answers 404 — not
 * 403 — because "there is no such endpoint here" is the honest description of a
 * production deployment, and it tells a prober nothing.
 *
 * Everything this route returns carries `evidence: "simulated"` and
 * `label: "SIMULATED"` at the top level, including error bodies. See
 * `src/lib/rails/achsim/control.ts`.
 *
 * The real work is `handleControlCommand`. This file is the HTTP shell: gate,
 * parse, delegate, respond.
 */

import { logger, requestIdFrom } from '@/lib/log';
import {
  AchSimControl,
  handleControlCommand,
  parseCommand,
  SIM_PRESETS,
  SIM_WEBHOOK_SECRET_DEFAULT,
  SIM_WEBHOOK_SECRET_ENV,
} from '@/lib/rails/achsim';

/** node:crypto for the webhook signatures. Not the Edge runtime. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled(): boolean {
  return (
    process.env.NODE_ENV !== 'production' && process.env['ACH_SIM_CONTROL_ENABLED'] === 'true'
  );
}

function notFound(requestId: string): Response {
  return Response.json(
    {
      requestId,
      error: {
        code: 'NOT_FOUND',
        message: 'no such endpoint',
      },
    },
    { status: 404, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
  );
}

/**
 * One control instance per server process, created lazily so that importing
 * this route in a production build constructs nothing at all.
 *
 * Deliberately in-memory and process-local: the simulator's state is a demo
 * script, not a record of money. It is meant to be thrown away, and a `reset`
 * action plus a process restart are the same thing.
 *
 * `signingTime: 'wall'` because these deliveries are meant to be POSTed at the
 * real webhook route over real HTTP, where the inbox enforces a 300-second
 * replay window against real time. A virtual timestamp in 2026 would be
 * correctly rejected. See `AchSimEngineOptions.signingTime`.
 */
let control: AchSimControl | null = null;

function controlInstance(): AchSimControl {
  control ??= new AchSimControl({
    secret: process.env[SIM_WEBHOOK_SECRET_ENV] ?? SIM_WEBHOOK_SECRET_DEFAULT,
    liveSecret: process.env['INCREASE_WEBHOOK_SECRET'],
    signingTime: 'wall',
    seed: process.env['ACH_SIM_SEED'] ?? 'achsim',
  });
  return control;
}

export async function POST(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request.headers);
  if (!enabled()) return notFound(requestId);

  const log = logger({ requestId, base: { route: 'POST /api/sim' } });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json(
      {
        requestId,
        evidence: 'simulated',
        label: 'SIMULATED',
        error: { code: 'BAD_JSON', message: 'body must be JSON' },
      },
      { status: 400, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
    );
  }

  const command = parseCommand(raw);
  if ('error' in command) {
    return Response.json(
      {
        requestId,
        evidence: 'simulated',
        label: 'SIMULATED',
        error: { code: 'BAD_COMMAND', message: command.error },
      },
      { status: 400, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
    );
  }

  const result = await handleControlCommand(controlInstance(), command);
  log.warn('sim.control', { action: command.action, httpStatus: result.httpStatus });

  return Response.json(
    { requestId, ...result.body },
    {
      status: result.httpStatus,
      headers: { 'cache-control': 'no-store', 'x-request-id': requestId },
    },
  );
}

/** A human poking the endpoint gets the menu, or a 404 in production. */
export function GET(request: Request): Response {
  const requestId = requestIdFrom(request.headers);
  if (!enabled()) return notFound(requestId);
  return Response.json(
    {
      requestId,
      evidence: 'simulated',
      label: 'SIMULATED',
      message:
        'ACH simulator control API. POST { "action": ... }. Nothing here is evidence of a real bank transfer.',
      actions: [
        'status',
        'presets',
        'reset',
        'start',
        'advance',
        'drain',
        'force_return',
        'force_noc',
        'outage',
        'clear_outage',
      ],
      presets: Object.keys(SIM_PRESETS),
    },
    { status: 200, headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
  );
}
