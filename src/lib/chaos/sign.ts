/**
 * Chaos mode's signer, and the refusal that makes it honest.
 *
 * IT SIGNS, IT DOES NOT VERIFY. Verification is `src/lib/webhooks/inbox.ts`,
 * once, generically, for every provider. This module produces deliveries in
 * exactly the shape that module already understands — Standard Webhooks:
 * `webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256 over
 * `` `${id}.${timestamp}.${rawBody}` ``, base64, prefixed `v1,` — so a chaos
 * delivery goes through the same `ingestWebhook`, the same verifier factory
 * (`lithicVerifier`), the same `webhook_inbox` table and the same dispatcher as
 * a real Lithic delivery. There is no chaos-shaped branch anywhere in the
 * receiving path, and `sign.test.ts` proves it by verifying a chaos delivery
 * with the production verifier rather than with a copy of one.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THE LABEL CANNOT BE FORGED
 *
 * This is the file the whole feature's honesty rests on, so the argument is
 * written out rather than assumed.
 *
 * The temptation, and what it would cost. The deployed `/api/webhooks/lithic`
 * route verifies against `LITHIC_WEBHOOK_SECRET`. The shortest path to "chaos
 * drives the card lifecycle" is therefore to sign chaos bodies with THAT key
 * and POST them at the deployed endpoint. `src/test/livefire/attack-04` and
 * `attack-07` both do exactly that, deliberately and with the construction
 * labelled in their headers, because a live-fire rehearsal has no other way to
 * produce an out-of-order clearing or a swallowed delivery.
 *
 * A SHIPPED SCREEN IS NOT A REHEARSAL SUITE. The ACH simulator already settled
 * this question for the rail next door, and its answer is the right one:
 *
 *   "The KEY IS DIFFERENT. The simulator signs with `ACH_SIM_WEBHOOK_SECRET`
 *    and `assertNotTheLiveSecret` refuses to construct a signer with the value
 *    of `INCREASE_WEBHOOK_SECRET`. [...] Producing a delivery that the
 *    `increase` route accepts requires Increase's own secret, which this
 *    package will not hold and refuses to use."
 *                                  — src/lib/rails/achsim/signing.ts
 *
 * So chaos holds its own key and refuses every provider's. The consequence is
 * worth stating plainly because it is a real limitation and not a technicality:
 *
 *   A CHAOS DELIVERY CANNOT BE ACCEPTED BY THE DEPLOYED WEBHOOK ROUTE.
 *
 * `/api/webhooks/lithic` will answer 401 to anything chaos signs, for ever, and
 * that is the property being bought. Chaos hands its deliveries to
 * `ingestWebhook` IN-PROCESS with its own verifier registry, which exercises
 * every step of the receiving pipeline except the HTTP shell and the comparison
 * against Lithic's own subscription secret. Those two are exercised by
 * attack-04, -07 and -08 over real HTTP against the deployed URL. `docs/CHAOS.md`
 * §4 says which is which, and neither claim is allowed to borrow the other's
 * evidence.
 *
 * The second layer is in ./body.ts: the `corgi_chaos` marker is inside the
 * signed bytes. The third is in ./types.ts: every chaos `webhook-id` lives in
 * the `chaos_` key space, so `webhook_inbox.provider_event_id` — half of the
 * table's own replay key — announces the row's origin.
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createHmac } from 'node:crypto';

import { CHAOS_EVENT_ID_PREFIX } from './types';

/** Read from the environment when present. Never committed; there is a default. */
export const CHAOS_WEBHOOK_SECRET_ENV = 'CHAOS_WEBHOOK_SECRET';

/**
 * The fallback signing key when `CHAOS_WEBHOOK_SECRET` is unset.
 *
 * A hard-coded default is normally a smell. Here it is correct and it is safe,
 * for the same three reasons the simulator's is: this key signs nothing but
 * chaos traffic; an attacker who forges a chaos delivery gains the ability to
 * insert a row that says `corgi_chaos` on it in three independent places; and
 * the alternative — falling back to a provider's secret — is the one outcome
 * this module exists to prevent.
 *
 * Base64 of `chaos-mode-development-only-not-a-real-secret`, `whsec_`-prefixed
 * so it is shaped like the thing it is standing in for and is unmistakable in a
 * log line or a config dump.
 */
export const CHAOS_WEBHOOK_SECRET_DEFAULT =
  'whsec_Y2hhb3MtbW9kZS1kZXZlbG9wbWVudC1vbmx5LW5vdC1hLXJlYWwtc2VjcmV0';

/**
 * Every provider webhook secret this deployment might hold.
 *
 * Named individually rather than pattern-matched on `*_WEBHOOK_SECRET`: a new
 * provider must be added here by hand, and a pattern that silently covers
 * tomorrow's variable name is exactly the kind of guard that looks like it is
 * working while a rename walks past it.
 */
export const PROVIDER_SECRET_ENV_KEYS = [
  'LITHIC_WEBHOOK_SECRET',
  'INCREASE_WEBHOOK_SECRET',
  'PERSONA_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_SECRET',
  'ACH_SIM_WEBHOOK_SECRET',
] as const;

export class ChaosSecretMisuseError extends Error {
  override readonly name = 'ChaosSecretMisuseError';
}

export type EnvBag = Readonly<Record<string, string | undefined>>;

/**
 * The refusal. Called when the secret is resolved, not at signing time, so a
 * misconfigured deployment fails at the moment somebody presses a chaos button
 * rather than at the moment it produces a delivery somebody might believe.
 */
export function assertNotAProviderSecret(secret: string, env: EnvBag): void {
  const trimmed = secret.trim();
  if (trimmed === '') {
    throw new ChaosSecretMisuseError(`${CHAOS_WEBHOOK_SECRET_ENV} must not be empty`);
  }
  for (const key of PROVIDER_SECRET_ENV_KEYS) {
    const providerSecret = env[key];
    if (providerSecret === undefined) continue;
    if (providerSecret.trim() === '') continue;
    if (providerSecret.trim() !== trimmed) continue;
    throw new ChaosSecretMisuseError(
      `chaos mode was handed ${key}. It signs with its own key on purpose: sharing the key ` +
        'would make a chaos delivery verifiable as a real provider delivery, which is the one ' +
        'thing this module exists to prevent. Set CHAOS_WEBHOOK_SECRET to a different value.',
    );
  }
}

/** The chaos signing key, refusal applied. */
export function chaosSecret(env: EnvBag = process.env): string {
  const secret = env[CHAOS_WEBHOOK_SECRET_ENV] ?? CHAOS_WEBHOOK_SECRET_DEFAULT;
  assertNotAProviderSecret(secret, env);
  return secret;
}

export interface SignedChaosDelivery {
  /** The exact bytes that were signed. Verify against THESE, never a re-serialisation. */
  readonly rawBody: string;
  /** Lower-cased, ready to hand to `ingestWebhook`. */
  readonly headers: Readonly<Record<string, string>>;
  /** The `webhook-id`, which is also `webhook_inbox.provider_event_id`. */
  readonly webhookId: string;
}

export interface SignChaosOptions {
  readonly secret: string;
  readonly webhookId: string;
  /** The body object. Serialised ONCE, here, and the bytes are what is signed. */
  readonly body: unknown;
  /** Wall-clock instant. The inbox enforces a 300s replay window against it. */
  readonly at?: Date | undefined;
}

/**
 * Sign one chaos delivery.
 *
 * `signingTime` is always wall-clock, unlike the ACH simulator's virtual-clock
 * option, because there is no path here that replays a delivery into the past:
 * `standardWebhooksVerifier` rejects anything outside ±300s and a chaos
 * delivery that the inbox refuses is a demo that silently does nothing.
 */
export function signChaosDelivery(opts: SignChaosOptions): SignedChaosDelivery {
  if (!opts.webhookId.startsWith(CHAOS_EVENT_ID_PREFIX)) {
    // The key space is one of the three layers that make a chaos row
    // identifiable for ever. A caller that skips it has removed a third of the
    // honesty guarantee, so this is a throw and not a warning.
    throw new ChaosSecretMisuseError(
      `a chaos webhook id must start with '${CHAOS_EVENT_ID_PREFIX}'; got '${opts.webhookId}'`,
    );
  }
  const rawBody = JSON.stringify(opts.body);
  const timestamp = Math.floor((opts.at?.getTime() ?? Date.now()) / 1_000);
  // Same transformation `lithicVerifier` applies on the way in: strip a leading
  // `whsec_`, base64-DECODE the rest. Written out rather than imported because
  // the verifier's copy is the one that matters and this one must be seen to
  // agree with it.
  const key = Buffer.from(opts.secret.replace(/^whsec_/, ''), 'base64');
  const signature = createHmac('sha256', key)
    .update(`${opts.webhookId}.${String(timestamp)}.${rawBody}`, 'utf8')
    .digest('base64');
  return {
    rawBody,
    webhookId: opts.webhookId,
    headers: {
      'webhook-id': opts.webhookId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': `v1,${signature}`,
      'content-type': 'application/json',
    },
  };
}

/**
 * The id for one delivery slot.
 *
 * `copyIndex` is deliberately NOT in the id. The duplicate control's whole
 * point is that every copy carries the SAME `webhook-id`, so that
 * `webhook_inbox UNIQUE (provider, provider_event_id)` — the replay suppression
 * that existed before chaos did — is the thing that absorbs them. An id that
 * varied per copy would turn N duplicates into N distinct facts and would prove
 * nothing at all.
 */
export function chaosWebhookId(runId: string, seq: number): string {
  return `${CHAOS_EVENT_ID_PREFIX}${runId.replace(/-/g, '')}_${String(seq).padStart(2, '0')}`;
}
