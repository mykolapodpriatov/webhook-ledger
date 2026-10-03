import { describe, expect, it } from 'vitest';
import { sign, timingSafeStringEqual, verifySignature } from './signature';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const SECRET = 'acme-ingest-secret-01';
const BODY = Buffer.from('{"type":"invoice.paid","id":"inv_1"}');

function verify(
  overrides: Partial<Parameters<typeof verifySignature>[0]> = {},
): ReturnType<typeof verifySignature> {
  const timestamp = String(NOW_SECONDS);
  return verifySignature({
    secret: SECRET,
    timestamp,
    signature: sign(SECRET, timestamp, BODY),
    rawBody: BODY,
    now: NOW,
    toleranceSeconds: 300,
    ...overrides,
  });
}

describe('verifySignature', () => {
  it('accepts a signature over the raw bytes', () => {
    expect(verify()).toBe('ok');
  });

  it('treats hex case as insignificant', () => {
    const timestamp = String(NOW_SECONDS);
    expect(verify({ signature: sign(SECRET, timestamp, BODY).toUpperCase() })).toBe('ok');
  });

  it('rejects a different secret', () => {
    expect(verify({ secret: 'other-ingest-secret' })).toBe('invalid');
  });

  it('rejects a body that was changed after signing', () => {
    expect(verify({ rawBody: Buffer.from('{"type":"invoice.paid","id":"inv_2"}') })).toBe(
      'invalid',
    );
  });

  it('rejects a signature computed for a different timestamp', () => {
    const timestamp = String(NOW_SECONDS);
    expect(
      verify({ signature: sign(SECRET, String(NOW_SECONDS - 5), BODY), timestamp }),
    ).toBe('invalid');
  });

  it('rejects whitespace that JSON.parse would ignore', () => {
    const spaced = Buffer.from('{ "type" : "invoice.paid" }');
    const timestamp = String(NOW_SECONDS);
    expect(
      verify({
        rawBody: spaced,
        signature: sign(SECRET, timestamp, Buffer.from('{"type":"invoice.paid"}')),
      }),
    ).toBe('invalid');
  });

  it('rejects a timestamp older than the tolerance, after the signature matches', () => {
    const timestamp = String(NOW_SECONDS - 301);
    expect(verify({ timestamp, signature: sign(SECRET, timestamp, BODY) })).toBe('stale');
  });

  it('rejects a timestamp ahead of the clock by more than the tolerance', () => {
    const timestamp = String(NOW_SECONDS + 301);
    expect(verify({ timestamp, signature: sign(SECRET, timestamp, BODY) })).toBe('stale');
  });

  it('accepts a timestamp on the tolerance boundary', () => {
    const timestamp = String(NOW_SECONDS - 300);
    expect(verify({ timestamp, signature: sign(SECRET, timestamp, BODY) })).toBe('ok');
  });

  it('rejects a signature that is not 32 bytes', () => {
    expect(verify({ signature: 'abcd' })).toBe('invalid');
  });
});

describe('timingSafeStringEqual', () => {
  it('matches equal strings and rejects different lengths', () => {
    expect(timingSafeStringEqual('acme-read-token-0001', 'acme-read-token-0001')).toBe(
      true,
    );
    expect(timingSafeStringEqual('short', 'acme-read-token-0001')).toBe(false);
    expect(timingSafeStringEqual('acme-read-token-0002', 'acme-read-token-0001')).toBe(
      false,
    );
  });
});
