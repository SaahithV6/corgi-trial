/**
 * The simulator's webhook signer.
 *
 * IT SIGNS, IT DOES NOT VERIFY. Verification for every provider in this repo
 * lives in `src/lib/webhooks/inbox.ts`, once, generically. This module produces
 * deliveries in exactly the shape that module already understands — Standard
 * Webhooks: `webhook-id`, `webhook-timestamp`, `webhook-signature`, HMAC-SHA256
 * over `` `${id}.${timestamp}.${rawBody}` ``, base64, prefixed `v1,`. So a
 * simulated delivery goes through `ingestWebhook` -> the same verifier factory
 * -> the same inbox table -> the same dispatcher as a real Increase delivery.
 * There is no simulator-shaped branch anywhere in the receiving path, and
 * `signing.test.ts` proves it by verifying a simulated delivery with the
 * production verifier rather than with a copy of one.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE LABEL CANNOT BE FORGED
 *
 * Two of the three anti-forgery layers are in this file.
 *
 *   The marker is INSIDE THE SIGNED BYTES. Every simulated body carries
 *   `"simulated": true` at the top level, and the signature covers the body.
 *   Strip the marker to make a delivery look real and the HMAC no longer
 *   verifies; keep the signature and the marker is still there. There is no
 *   third option.
 *
 *   The KEY IS DIFFERENT. The simulator signs with `ACH_SIM_WEBHOOK_SECRET` and
 *   `assertNotTheLiveSecret` refuses to construct a signer with the value of
 *   `INCREASE_WEBHOOK_SECRET`. A simulated delivery therefore fails
 *   verification against the Increase subscription's shared secret, and a real
 *   Increase delivery fails verification against the simulator's. Producing a
 *   delivery that the `increase` route accepts requires Increase's own secret,
 *   which this package will not hold and refuses to use.
 *
 * The third layer is in ./clock.ts: simulated ids live in their own key space.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHmac } from 'node:crypto';

import {
  standardWebhooksVerifier,
  type WebhookVerifier,
} from '../../webhooks/inbox';

/** The inbox `provider` name simulated deliveries are filed under. */
export const ACHSIM_PROVIDER = 'achsim';

/**
 * The top-level marker every simulated body carries, inside the signed bytes.
 * Exported so a consumer can assert on it and so the README can quote it.
 */
export const SIMULATED_MARKER = 'simulated' as const;

export interface SignedDelivery {
  /** The exact bytes that were signed. Verify against THESE, never a re-serialisation. */
  readonly rawBody: string;
  /** Lower-cased, ready to hand to `ingestWebhook`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Convenience: the value of `webhook-id`, which is also the event id. */
  readonly webhookId: string;
}

export interface WebhookSignerOptions {
  /** The simulator's own signing secret. NOT the Increase one. */
  readonly secret: string;
  /**
   * The live Increase secret, if the process has one. Passed in so the signer
   * can refuse to be constructed with it. Defaults to
   * `process.env.INCREASE_WEBHOOK_SECRET`.
   */
  readonly liveSecret?: string | undefined;
}

export class SimulatedSecretMisuseError extends Error {
  override readonly name = 'SimulatedSecretMisuseError';
}

/**
 * The refusal. Called at construction, not at signing time, so a misconfigured
 * simulator fails at boot rather than at the moment it produces a delivery
 * somebody might believe.
 */
export function assertNotTheLiveSecret(secret: string, liveSecret: string | undefined): void {
  if (secret.trim() === '') {
    throw new SimulatedSecretMisuseError('ACH_SIM_WEBHOOK_SECRET must not be empty');
  }
  if (liveSecret !== undefined && liveSecret.trim() !== '' && secret.trim() === liveSecret.trim()) {
    throw new SimulatedSecretMisuseError(
      'the simulator was handed INCREASE_WEBHOOK_SECRET. It signs with its own key on purpose: ' +
        'sharing the key would make a simulated delivery verifiable as a real Increase one, ' +
        'which is the single thing this package exists to make impossible.',
    );
  }
}

/**
 * Sign a body the way Increase does.
 *
 * `secretEncoding` is the Increase convention — the shared secret's UTF-8 bytes
 * used directly as the HMAC key, rather than the spec's base64 decode that
 * Lithic uses. Matching Increase here is what makes the receiving path
 * identical: the same `standardWebhooksVerifier({ secretEncoding: 'utf8' })`
 * factory verifies both.
 */
export class WebhookSigner {
  private readonly secret: string;

  constructor(opts: WebhookSignerOptions) {
    const liveSecret = opts.liveSecret ?? process.env['INCREASE_WEBHOOK_SECRET'];
    assertNotTheLiveSecret(opts.secret, liveSecret);
    this.secret = opts.secret;
  }

  /**
   * Produce the `v1,<base64>` signature for a body.
   *
   * The signed content is `id.timestamp.rawBody`, and `rawBody` is a string the
   * caller has already serialised. Nothing here re-serialises anything, for the
   * same reason `rawbody.ts` exists on the receiving side.
   */
  signature(webhookId: string, timestampSeconds: number, rawBody: string): string {
    const signedContent = `${webhookId}.${timestampSeconds}.${rawBody}`;
    const mac = createHmac('sha256', Buffer.from(this.secret, 'utf8'))
      .update(signedContent, 'utf8')
      .digest('base64');
    return `v1,${mac}`;
  }

  /** A complete, signed delivery ready for `ingestWebhook`. */
  sign(webhookId: string, timestampSeconds: number, rawBody: string): SignedDelivery {
    return {
      rawBody,
      webhookId,
      headers: {
        'webhook-id': webhookId,
        'webhook-timestamp': String(timestampSeconds),
        'webhook-signature': this.signature(webhookId, timestampSeconds, rawBody),
        'content-type': 'application/json',
        // Not signed, and deliberately not load-bearing: a header a proxy can
        // strip is documentation, not a control. The control is the marker
        // inside the signed body.
        'x-simulated': 'true',
      },
    };
  }
}

/**
 * The verifier for simulated deliveries — the GENERIC one from the inbox, with
 * the simulator's provider name and secret. Not a new implementation; the whole
 * point is that there isn't one.
 *
 * Wiring it is one entry in `WEBHOOK_INTEGRATIONS`
 * (src/lib/webhooks/route-handler.ts), which this package does not own. Until
 * that entry exists the simulator drives the inbox directly, which is the same
 * `ingestWebhook` call the route makes.
 */
export function achsimVerifier(opts: {
  secret: string | readonly string[];
  toleranceSeconds?: number | undefined;
  provider?: string | undefined;
}): WebhookVerifier {
  return standardWebhooksVerifier({
    provider: opts.provider ?? ACHSIM_PROVIDER,
    secret: opts.secret,
    // Increase's convention, matched exactly. See the class comment.
    secretEncoding: 'utf8',
    toleranceSeconds: opts.toleranceSeconds,
    identify: ({ headers, payload }) => ({
      providerEventId: readString(payload, 'id') ?? headers('webhook-id') ?? '',
      eventType: readString(payload, 'category'),
    }),
  });
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}
