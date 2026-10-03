import { describe, expect, it } from 'vitest';
import type { TenantConfig } from '../config';
import { LedgerService, type Clock } from './ledger.service';
import { MemoryLedgerStore } from './memory-ledger.store';
import { sign } from './signature';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const CLOCK: Clock = { now: () => NOW };

const ACME: TenantConfig = {
  id: 'acme',
  ingestSecret: 'acme-ingest-secret-01',
  readToken: 'acme-read-token-0001',
};
const BETA: TenantConfig = {
  id: 'beta',
  ingestSecret: 'beta-ingest-secret-01',
  readToken: 'beta-read-token-0001',
};

function createService(): LedgerService {
  return new LedgerService(
    { tenants: [ACME, BETA], clock: CLOCK, toleranceSeconds: 300 },
    new MemoryLedgerStore(),
  );
}

function accept(
  service: LedgerService,
  overrides: {
    tenantId?: string;
    body?: string;
    key?: string;
    secret?: string;
    timestamp?: string;
    signature?: string;
  } = {},
) {
  const tenantId = overrides.tenantId ?? 'acme';
  const raw = Buffer.from(overrides.body ?? '{"type":"invoice.paid"}');
  const timestamp = overrides.timestamp ?? String(NOW_SECONDS);
  const secret = overrides.secret ?? ACME.ingestSecret;
  return service.accept({
    tenantId,
    rawBody: raw,
    body: JSON.parse(raw.toString('utf8')) as unknown,
    timestamp,
    signature: overrides.signature ?? sign(secret, timestamp, raw),
    idempotencyKey: overrides.key ?? 'delivery-1',
  });
}

describe('LedgerService.accept', () => {
  it('stores a delivery and gives the tenant its own sequence', () => {
    const service = createService();
    const first = accept(service);
    const second = accept(service, { key: 'delivery-2', body: '{"type":"next"}' });
    const other = accept(service, {
      tenantId: 'beta',
      secret: BETA.ingestSecret,
      key: 'delivery-1',
    });

    expect(first).toMatchObject({
      kind: 'accepted',
      event: { sequence: 1, tenantId: 'acme' },
    });
    expect(second).toMatchObject({ kind: 'accepted', event: { sequence: 2 } });
    expect(other).toMatchObject({
      kind: 'accepted',
      event: { sequence: 1, tenantId: 'beta' },
    });
  });

  it('replays the original event when the same key and bytes arrive again', () => {
    const service = createService();
    const first = accept(service);
    const second = accept(service);
    expect(first.kind).toBe('accepted');
    expect(second).toEqual({
      kind: 'replayed',
      event: first.kind === 'accepted' ? first.event : {},
    });
    const feed = service.read({
      tenantId: 'acme',
      token: ACME.readToken,
      after: undefined,
      limit: 50,
    });
    expect(feed.kind === 'ok' && feed.events).toHaveLength(1);
  });

  it('conflicts when the same key is reused with different bytes', () => {
    const service = createService();
    const first = accept(service);
    const conflict = accept(service, { body: '{"type":"invoice.paid","extra":true}' });
    expect(first.kind).toBe('accepted');
    expect(conflict).toEqual({
      kind: 'idempotency_conflict',
      eventId: first.kind === 'accepted' ? first.event.id : '',
    });
    const feed = service.read({
      tenantId: 'acme',
      token: ACME.readToken,
      after: undefined,
      limit: 50,
    });
    expect(feed.kind === 'ok' && feed.events).toHaveLength(1);
  });

  it('stores nothing for a bad signature, an unknown tenant, or a stale timestamp', () => {
    const service = createService();
    expect(accept(service, { signature: 'ab'.repeat(32) })).toEqual({
      kind: 'invalid_signature',
    });
    expect(
      accept(service, { tenantId: 'missing', secret: 'not-the-tenant-secret' }),
    ).toEqual({ kind: 'invalid_signature' });
    const stale = String(NOW_SECONDS - 301);
    const raw = Buffer.from('{"type":"invoice.paid"}');
    expect(
      accept(service, {
        timestamp: stale,
        signature: sign(ACME.ingestSecret, stale, raw),
      }),
    ).toEqual({ kind: 'stale_timestamp' });

    const feed = service.read({
      tenantId: 'acme',
      token: ACME.readToken,
      after: undefined,
      limit: 50,
    });
    expect(feed).toMatchObject({ kind: 'ok', events: [] });
  });
});

describe('LedgerService.read', () => {
  it('returns events after the cursor and stops at the limit', () => {
    const service = createService();
    accept(service, { key: 'a' });
    accept(service, { key: 'b', body: '{"n":2}' });
    accept(service, { key: 'c', body: '{"n":3}' });

    const page = service.read({
      tenantId: 'acme',
      token: ACME.readToken,
      after: 1,
      limit: 1,
    });
    expect(page).toMatchObject({
      kind: 'ok',
      nextCursor: '2',
      events: [{ sequence: 2, idempotencyKey: 'b' }],
    });

    const rest = service.read({
      tenantId: 'acme',
      token: ACME.readToken,
      after: 2,
      limit: 50,
    });
    expect(rest).toMatchObject({
      kind: 'ok',
      nextCursor: '3',
      events: [{ sequence: 3 }],
    });
  });

  it('does not return another tenant events', () => {
    const service = createService();
    accept(service);
    const feed = service.read({
      tenantId: 'beta',
      token: BETA.readToken,
      after: undefined,
      limit: 50,
    });
    expect(feed).toEqual({ kind: 'ok', events: [], nextCursor: null });
  });

  it('keeps the cursor when the page is empty and the caller already passed one', () => {
    const service = createService();
    const feed = service.read({
      tenantId: 'acme',
      token: ACME.readToken,
      after: 4,
      limit: 50,
    });
    expect(feed).toEqual({ kind: 'ok', events: [], nextCursor: '4' });
  });

  it('rejects a bad read token and an unknown tenant with the same result', () => {
    const service = createService();
    accept(service);
    expect(
      service.read({
        tenantId: 'acme',
        token: 'wrong-read-token1',
        after: undefined,
        limit: 50,
      }),
    ).toEqual({ kind: 'unauthorized' });
    expect(
      service.read({
        tenantId: 'missing',
        token: ACME.readToken,
        after: undefined,
        limit: 50,
      }),
    ).toEqual({ kind: 'unauthorized' });
  });

  it('rejects a negative cursor', () => {
    const service = createService();
    expect(
      service.read({ tenantId: 'acme', token: ACME.readToken, after: -1, limit: 50 }),
    ).toEqual({ kind: 'invalid_cursor' });
  });
});
