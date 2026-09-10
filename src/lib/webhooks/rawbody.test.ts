import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  constantTimeEquals,
  parseVerifiedJson,
  readRawDelivery,
  sha256Hex,
  toHeaderLookup,
  WebhookPayloadParseError,
} from './rawbody';

/** A Request-shaped double. `text()` may only be read once, like the real one. */
function fakeRequest(body: string, headers: Record<string, string> = {}) {
  let consumed = false;
  return {
    async text() {
      if (consumed) throw new Error('body already consumed');
      consumed = true;
      return body;
    },
    headers,
  };
}

describe('readRawDelivery', () => {
  it('returns the body byte-for-byte, including insignificant whitespace', async () => {
    const body = '{"test": 2432232314,\n  "note": "two  spaces"}';
    const { raw } = await readRawDelivery(fakeRequest(body));
    expect(raw).toBe(body);
  });

  it('reads headers case-insensitively from a plain object', async () => {
    const { headers } = await readRawDelivery(fakeRequest('{}', { 'Webhook-Id': 'msg_1' }));
    expect(headers('webhook-id')).toBe('msg_1');
    expect(headers('WEBHOOK-ID')).toBe('msg_1');
    expect(headers('nope')).toBeNull();
  });

  it('reads headers from a fetch Headers instance', () => {
    const lookup = toHeaderLookup(new Headers({ 'Persona-Signature': 't=1,v1=abc' }));
    expect(lookup('persona-signature')).toBe('t=1,v1=abc');
  });
});

describe('the parse-then-restringify footgun', () => {
  // This is the single most expensive mistake available in a webhook handler,
  // so it gets a test that demonstrates it rather than a comment asserting it.
  const rawFromProvider = '{"test": 2432232314}';
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const sign = (body: string) =>
    createHmac('sha256', key)
      .update(`msg_p5jXN8AQM9LWM0D4loKWxJek.1614265330.${body}`, 'utf8')
      .digest('base64');

  it('produces a different signature after a JSON round trip', () => {
    const roundTripped = JSON.stringify(JSON.parse(rawFromProvider));

    // The values are equal...
    expect(JSON.parse(roundTripped)).toEqual(JSON.parse(rawFromProvider));
    // ...and the bytes are not. One space.
    expect(roundTripped).not.toBe(rawFromProvider);

    // The canonical Standard Webhooks test vector, which every provider using
    // that spec (Lithic, Increase) must reproduce:
    expect(sign(rawFromProvider)).toBe('g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    expect(sign(roundTripped)).toBe('Vif40peJBP7Iyl0XGmu61n4MwdrcHov5CFREBpE0svs=');
    expect(sign(roundTripped)).not.toBe(sign(rawFromProvider));
  });

  it('produces a different body hash after a JSON round trip (Plaid scheme)', () => {
    const roundTripped = JSON.stringify(JSON.parse(rawFromProvider));
    expect(sha256Hex(roundTripped)).not.toBe(sha256Hex(rawFromProvider));
  });
});

describe('parseVerifiedJson', () => {
  it('parses a verified body', () => {
    expect(parseVerifiedJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('throws a typed error rather than a bare SyntaxError', () => {
    expect(() => parseVerifiedJson('not json')).toThrow(WebhookPayloadParseError);
  });
});

describe('constantTimeEquals', () => {
  it('is true only for identical strings', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
  });

  it('does not throw on a length mismatch (which would itself be an oracle)', () => {
    expect(constantTimeEquals('a', 'aaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(constantTimeEquals('', 'x')).toBe(false);
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});
