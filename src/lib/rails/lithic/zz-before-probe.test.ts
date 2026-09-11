import { describe, it } from 'vitest';

import { getTransaction, normalizeTransaction } from './client';
import { RateLimiter } from './ratelimit';
import { IncreaseWireClient } from '../wire/client';

const INTERSTITIAL =
  '<!DOCTYPE html><html><head><title>Just a moment...</title></head>' +
  '<body><h1>Checking your browser before accessing sandbox.lithic.com</h1></body></html>';

function htmlOk(): typeof fetch {
  return (async () =>
    new Response(INTERSTITIAL, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
}

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

describe('BEFORE', () => {
  it('lithic non-JSON 200', async () => {
    try {
      const txn = await getTransaction('txn_whatever', {
        apiKey: 'probe',
        fetchImpl: htmlOk(),
        limiter: new RateLimiter({ limit: 1000, windowMs: 1, safetyMarginMs: 0 }),
      });
      out('LITHIC getTransaction returned (did not throw):');
      out(JSON.stringify(txn));
      out('LITHIC normalizeTransaction(...) =');
      out(JSON.stringify(normalizeTransaction(txn), null, 2));
    } catch (error) {
      out(`LITHIC threw ${(error as Error).name}: ${(error as Error).message}`);
    }
  });

  it('wire non-JSON 200', async () => {
    const client = new IncreaseWireClient({ apiKey: 'probe', fetchImpl: htmlOk() });
    try {
      const transfer = await client.getTransfer('wire_transfer_abc');
      out('WIRE getTransfer returned (did not throw):');
      out(JSON.stringify(transfer));
      out(`WIRE typeof=${typeof transfer} .id=${String((transfer as { id?: string }).id)}`);
    } catch (error) {
      out(`WIRE threw ${(error as Error).name}: ${(error as Error).message}`);
    }
  });

  it('wire empty 200', async () => {
    const emptyOk = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const client = new IncreaseWireClient({ apiKey: 'probe', fetchImpl: emptyOk });
    try {
      const transfer = await client.getTransfer('wire_transfer_abc');
      out(`WIRE empty-200 returned (did not throw): ${JSON.stringify(transfer)} typeof=${typeof transfer}`);
    } catch (error) {
      out(`WIRE empty-200 threw ${(error as Error).name}: ${(error as Error).message}`);
    }
  });
});
