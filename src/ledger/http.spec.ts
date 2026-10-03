import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { configureApp } from '../configure-app';
import type { TenantConfig } from '../config';
import type { Clock } from './ledger.service';
import { sign } from './signature';

const NOW = new Date('2026-10-04T12:00:00.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const CLOCK: Clock = { now: () => NOW };

const ACME: TenantConfig = {
  id: 'acme',
  ingestSecret: 'acme-ingest-secret-01',
  readToken: 'acme-read-token-0001',
};

const SPACED = Buffer.from('{ "type" : "invoice.paid", "id": "inv_1" }');
const COMPACT = Buffer.from('{"type":"invoice.paid","id":"inv_1"}');

describe('HTTP', () => {
  let app: NestFastifyApplication;

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  async function start(): Promise<void> {
    app = await NestFactory.create<NestFastifyApplication>(
      AppModule.register({ tenants: [ACME], clock: CLOCK, toleranceSeconds: 300 }),
      new FastifyAdapter({ bodyLimit: 256 * 1024 }),
      { rawBody: true, logger: false },
    );
    configureApp(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  function post(raw: Buffer, overrides: Record<string, string> = {}) {
    const timestamp = overrides['x-webhook-timestamp'] ?? String(NOW_SECONDS);
    const signature =
      overrides['x-webhook-signature'] ?? sign(ACME.ingestSecret, timestamp, raw);
    return app.inject({
      method: 'POST',
      url: '/v1/tenants/acme/events',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': overrides['idempotency-key'] ?? 'inv_1',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': signature,
      },
      payload: raw,
    });
  }

  it('verifies the raw bytes, not a re-serialized body', async () => {
    await start();
    const accepted = await post(SPACED);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ status: 'accepted', sequence: 1 });

    const signedAsCompact = await post(SPACED, {
      'idempotency-key': 'inv_2',
      'x-webhook-signature': sign(ACME.ingestSecret, String(NOW_SECONDS), COMPACT),
    });
    expect(signedAsCompact.statusCode).toBe(401);
    expect(signedAsCompact.json()).toMatchObject({ error: 'invalid_signature' });
  });

  it('replays with 200 and conflicts with 409', async () => {
    await start();
    const first = await post(COMPACT);
    const replay = await post(COMPACT);
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ status: 'replayed', id: first.json().id });

    const conflict = await post(Buffer.from('{"type":"other"}'));
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: 'idempotency_conflict',
      eventId: first.json().id,
    });
  });

  it('rejects a body that is not a JSON object before storing it', async () => {
    await start();
    const raw = Buffer.from('[]');
    const response = await post(raw, { 'idempotency-key': 'not-an-object' });
    expect(response.statusCode).toBe(400);

    const feed = await app.inject({
      method: 'GET',
      url: '/v1/tenants/acme/events',
      headers: { authorization: `Bearer ${ACME.readToken}` },
    });
    expect(feed.json()).toEqual({ events: [], nextCursor: null });
  });

  it('requires the tenant read token and does not leak events', async () => {
    await start();
    await post(COMPACT);

    const missing = await app.inject({
      method: 'GET',
      url: '/v1/tenants/acme/events',
    });
    expect(missing.statusCode).toBe(400);

    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/tenants/acme/events',
      headers: { authorization: 'Bearer wrong-read-token1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toMatchObject({ error: 'unauthorized' });

    const ok = await app.inject({
      method: 'GET',
      url: '/v1/tenants/acme/events?limit=10',
      headers: { authorization: `Bearer ${ACME.readToken}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      nextCursor: '1',
      events: [
        {
          sequence: 1,
          idempotencyKey: 'inv_1',
          body: { type: 'invoice.paid', id: 'inv_1' },
        },
      ],
    });
  });

  it('serves health and an OpenAPI document that lists both routes', async () => {
    await start();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const spec = await app.inject({ method: 'GET', url: '/docs-json' });
    expect(spec.statusCode).toBe(200);
    const paths = Object.keys(spec.json().paths as Record<string, unknown>);
    expect(paths).toContain('/v1/tenants/{tenantId}/events');
    expect(paths).toContain('/health');
  });
});
