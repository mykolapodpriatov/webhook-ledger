import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import type { TenantConfig } from '../config';
import type { SaveInput, SaveResult } from './ledger-store';
import type { Clock } from './ledger.service';
import { PostgresLedgerStore } from './postgres-ledger.store';
import { sign } from './signature';

const databaseUrl = process.env.DATABASE_URL;
if (process.env.CI && !databaseUrl) {
  throw new Error(
    'DATABASE_URL is required when CI is set. The Postgres suite must not skip in CI.',
  );
}

const RECEIVED_AT = '2026-10-04T12:00:00.000Z';
const NOW = new Date(RECEIVED_AT);
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const CLOCK: Clock = { now: () => NOW };
const ACME: TenantConfig = {
  id: 'acme',
  ingestSecret: 'acme-ingest-secret-01',
  readToken: 'acme-read-token-0001',
};

function requireUrl(): string {
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.');
  }
  return databaseUrl;
}

function delivery(overrides: Partial<SaveInput> = {}): SaveInput {
  return {
    id: randomUUID(),
    tenantId: 'acme',
    idempotencyKey: `key-${randomUUID()}`,
    bodySha256: 'a'.repeat(64),
    receivedAt: RECEIVED_AT,
    body: { type: 'invoice.paid' },
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)('PostgresLedgerStore', () => {
  let store: PostgresLedgerStore;

  beforeAll(async () => {
    store = new PostgresLedgerStore({
      tenants: [ACME],
      clock: CLOCK,
      toleranceSeconds: 300,
      databaseUrl: requireUrl(),
    });
    await store.onModuleInit();
  });

  afterAll(async () => {
    await store.onApplicationShutdown();
  });

  beforeEach(async () => {
    await store.clear();
  });

  it('replays the same key and does not advance the sequence', async () => {
    const input = delivery();
    const first = await store.save(input);
    const second = await store.save(delivery({ ...input, id: randomUUID() }));
    expect(first.kind).toBe('inserted');
    expect(second).toEqual({ kind: 'replayed', event: storedEvent(first) });
    const rows = await store.listAfter('acme', 0, 10);
    expect(rows.map((row) => row.sequence)).toEqual([1]);
    expect(rows[0]?.receivedAt).toBe(RECEIVED_AT);
  });

  it('conflicts on the same key with a different hash and stores one row', async () => {
    const input = delivery();
    const first = await store.save(input);
    const conflict = await store.save(
      delivery({
        idempotencyKey: input.idempotencyKey,
        bodySha256: 'b'.repeat(64),
        body: { type: 'other' },
      }),
    );
    expect(conflict).toEqual({ kind: 'conflict', eventId: storedEvent(first).id });
    const next = await store.save(delivery());
    expect(storedEvent(next).sequence).toBe(2);
    expect(await store.listAfter('acme', 0, 10)).toHaveLength(2);
  });

  it('keeps a separate sequence per tenant and does not leak rows', async () => {
    await store.save(delivery());
    await store.save(delivery({ tenantId: 'beta' }));
    const acme = await store.listAfter('acme', 0, 10);
    const beta = await store.listAfter('beta', 0, 10);
    expect(acme.map((row) => row.sequence)).toEqual([1]);
    expect(beta.map((row) => row.tenantId)).toEqual(['beta']);
    expect(await store.listAfter('acme', 1, 10)).toEqual([]);
  });

  it('lets one of two concurrent same-key inserts win', async () => {
    const input = delivery();
    const [left, right] = await Promise.all([
      store.save(input),
      store.save(delivery({ ...input, id: randomUUID() })),
    ]);
    const kinds = [left.kind, right.kind].sort();
    expect(kinds).toEqual(['inserted', 'replayed']);
    const inserted = left.kind === 'inserted' ? left : right;
    const replayed = left.kind === 'replayed' ? left : right;
    expect(storedEvent(replayed).id).toBe(storedEvent(inserted).id);
    const rows = await store.listAfter('acme', 0, 10);
    expect(rows.map((row) => row.sequence)).toEqual([1]);
  });

  it('assigns contiguous sequences to concurrent different keys', async () => {
    const saved = await Promise.all([
      store.save(delivery({ idempotencyKey: 'a' })),
      store.save(delivery({ idempotencyKey: 'b' })),
      store.save(delivery({ idempotencyKey: 'c' })),
      store.save(delivery({ idempotencyKey: 'd' })),
    ]);
    expect(saved.every((result) => result.kind === 'inserted')).toBe(true);
    const sequences = (await store.listAfter('acme', 0, 10))
      .map((row) => row.sequence)
      .sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4]);
  });

  it('returns conflict when concurrent same-key requests differ', async () => {
    const key = 'race-key';
    const [left, right] = await Promise.all([
      store.save(delivery({ idempotencyKey: key, bodySha256: 'a'.repeat(64) })),
      store.save(delivery({ idempotencyKey: key, bodySha256: 'b'.repeat(64) })),
    ]);
    const inserted = [left, right].find((result) => result.kind === 'inserted');
    const conflict = [left, right].find((result) => result.kind === 'conflict');
    expect(inserted?.kind).toBe('inserted');
    expect(conflict).toEqual({
      kind: 'conflict',
      eventId: inserted ? storedEvent(inserted).id : '',
    });
    expect(await store.listAfter('acme', 0, 10)).toHaveLength(1);
  });

  it('keeps the row in a second store after the first one disconnects', async () => {
    const input = delivery({ idempotencyKey: 'persisted' });
    const first = new PostgresLedgerStore({
      tenants: [ACME],
      clock: CLOCK,
      toleranceSeconds: 300,
      databaseUrl: requireUrl(),
    });
    try {
      await first.onModuleInit();
      await first.save(input);
    } finally {
      await first.onApplicationShutdown();
    }

    const second = new PostgresLedgerStore({
      tenants: [ACME],
      clock: CLOCK,
      toleranceSeconds: 300,
      databaseUrl: requireUrl(),
    });
    try {
      await second.onModuleInit();
      const rows = await second.listAfter('acme', 0, 10);
      expect(rows.map((row) => row.idempotencyKey)).toEqual(['persisted']);
    } finally {
      await second.onApplicationShutdown();
    }
  });

  it('accepts a signed webhook and a new connection still sees the row', async () => {
    const app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register({
        tenants: [ACME],
        clock: CLOCK,
        toleranceSeconds: 300,
        databaseUrl: requireUrl(),
      }),
      new FastifyAdapter({ bodyLimit: 256 * 1024 }),
      { rawBody: true, logger: false },
    );
    app.enableShutdownHooks();
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const raw = Buffer.from('{"type":"invoice.paid","id":"inv_1"}');
    const timestamp = String(NOW_SECONDS);
    try {
      const accepted = await app.inject({
        method: 'POST',
        url: '/v1/tenants/acme/events',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': 'inv_1',
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': sign(ACME.ingestSecret, timestamp, raw),
        },
        payload: raw,
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json()).toMatchObject({ status: 'accepted', sequence: 1 });
    } finally {
      await app.close();
    }

    const reader = new PostgresLedgerStore({
      tenants: [ACME],
      clock: CLOCK,
      toleranceSeconds: 300,
      databaseUrl: requireUrl(),
    });
    try {
      await reader.onModuleInit();
      const rows = await reader.listAfter('acme', 0, 10);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        idempotencyKey: 'inv_1',
        sequence: 1,
        receivedAt: RECEIVED_AT,
        body: { type: 'invoice.paid', id: 'inv_1' },
      });
    } finally {
      await reader.onApplicationShutdown();
    }
  });
});

function storedEvent(
  result: SaveResult,
): Extract<SaveResult, { kind: 'inserted' }>['event'] {
  if (result.kind === 'conflict') {
    throw new Error('expected a stored event');
  }
  return result.event;
}
