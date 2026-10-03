import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureVerdict = 'ok' | 'invalid' | 'stale';

export type VerifyInput = {
  secret: string;
  timestamp: string;
  signature: string;
  rawBody: Buffer;
  now: Date;
  toleranceSeconds: number;
};

/**
 * Signed bytes are the timestamp, a single dot, then the raw body.
 * The body is not re-serialized: a space or a different key order changes the signature.
 */
export function sign(secret: string, timestamp: string, rawBody: Buffer): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(timestamp);
  hmac.update('.');
  hmac.update(rawBody);
  return hmac.digest('hex');
}

export function verifySignature(input: VerifyInput): SignatureVerdict {
  const expected = createHmac('sha256', input.secret);
  expected.update(input.timestamp);
  expected.update('.');
  expected.update(input.rawBody);
  const expectedBytes = expected.digest();

  const provided = Buffer.from(input.signature, 'hex');
  if (
    provided.length !== expectedBytes.length ||
    !timingSafeEqual(provided, expectedBytes)
  ) {
    return 'invalid';
  }

  if (!/^\d{1,15}$/.test(input.timestamp)) {
    return 'invalid';
  }
  const sent = Number(input.timestamp);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (Math.abs(nowSeconds - sent) > input.toleranceSeconds) {
    return 'stale';
  }
  return 'ok';
}

export function sha256Hex(rawBody: Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}
