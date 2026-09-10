/**
 * One route for every provider: POST /api/webhooks/{lithic,persona,plaid,increase,stripe}
 *
 * There is deliberately no per-provider route file. The provider is the path
 * segment, it is validated against the verifier registry, and everything else
 * — raw body, signature, inbox, status code, log line — lives in
 * `@/lib/webhooks/route-handler`. See `../README.md` for the failure table.
 */

import { handleWebhookRequest, WEBHOOK_PROVIDERS } from '@/lib/webhooks/route-handler';

/**
 * NODE RUNTIME, NOT EDGE. Signature verification is `node:crypto`:
 * `createHmac` and `timingSafeEqual` for Lithic / Increase / Persona / Stripe,
 * and `createPublicKey` + `verify` for Plaid's ES256 JWT. The Edge runtime has
 * no `node:crypto`, so on Edge this route would not fail at build time — it
 * would fail at the first real delivery, which is the worst possible moment to
 * discover it. Pinned explicitly rather than relying on the default.
 */
export const runtime = 'nodejs';

/**
 * Never prerendered, never cached, never deduplicated. A webhook is a side
 * effect delivered by POST; a cached response would ack a delivery we never
 * stored, and the provider would never send it again.
 */
export const dynamic = 'force-dynamic';

/** Params are a Promise in the App Router (Next 15+). */
type Context = { params: Promise<{ provider: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  const { provider } = await context.params;
  return handleWebhookRequest(request, provider);
}

/**
 * Providers only ever POST. A GET here is a human or a dashboard health probe,
 * so answer it honestly instead of letting the framework 405 with no body.
 */
export function GET(): Response {
  return Response.json(
    {
      error: {
        code: 'METHOD_NOT_ALLOWED',
        message: 'webhook endpoints accept POST only',
      },
      providers: WEBHOOK_PROVIDERS,
    },
    { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } },
  );
}
