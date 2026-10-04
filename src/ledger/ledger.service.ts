import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { TenantConfig } from '../config';
import { LEDGER_STORE, type LedgerStore, type StoredEvent } from './ledger-store';
import { sha256Hex, timingSafeStringEqual, verifySignature } from './signature';

export type Clock = { now(): Date };

export type LedgerOptions = {
  tenants: TenantConfig[];
  clock: Clock;
  toleranceSeconds: number;
  databaseUrl?: string;
};

export const LEDGER_OPTIONS = Symbol('LEDGER_OPTIONS');

export type PublicEvent = {
  id: string;
  tenantId: string;
  sequence: number;
  idempotencyKey: string;
  receivedAt: string;
  body: unknown;
};

export type AcceptInput = {
  tenantId: string;
  rawBody: Buffer;
  body: unknown;
  timestamp: string;
  signature: string;
  idempotencyKey: string;
};

export type AcceptResult =
  | { kind: 'accepted'; event: PublicEvent }
  | { kind: 'replayed'; event: PublicEvent }
  | { kind: 'invalid_signature' }
  | { kind: 'stale_timestamp' }
  | { kind: 'idempotency_conflict'; eventId: string };

export type ReadInput = {
  tenantId: string;
  token: string;
  after: number | undefined;
  limit: number;
};

export type ReadResult =
  | { kind: 'ok'; events: PublicEvent[]; nextCursor: string | null }
  | { kind: 'unauthorized' }
  | { kind: 'invalid_cursor' };

@Injectable()
export class LedgerService {
  private readonly tenants: Map<string, TenantConfig>;
  /**
   * Random per process, not a published dummy. A caller who does not know a
   * real secret cannot produce a matching HMAC, so a missing tenant and a bad
   * signature return the same result.
   */
  private readonly unknownSecret = randomBytes(32).toString('hex');
  private readonly unknownReadToken = randomBytes(32).toString('hex');

  constructor(
    @Inject(LEDGER_OPTIONS) private readonly options: LedgerOptions,
    @Inject(LEDGER_STORE) private readonly store: LedgerStore,
  ) {
    this.tenants = new Map(options.tenants.map((tenant) => [tenant.id, tenant]));
  }

  async accept(input: AcceptInput): Promise<AcceptResult> {
    const tenant = this.tenants.get(input.tenantId);
    const verdict = verifySignature({
      secret: tenant?.ingestSecret ?? this.unknownSecret,
      timestamp: input.timestamp,
      signature: input.signature,
      rawBody: input.rawBody,
      now: this.options.clock.now(),
      toleranceSeconds: this.options.toleranceSeconds,
    });
    if (!tenant || verdict === 'invalid') {
      return { kind: 'invalid_signature' };
    }
    if (verdict === 'stale') {
      return { kind: 'stale_timestamp' };
    }

    const saved = await this.store.save({
      id: randomUUID(),
      tenantId: input.tenantId,
      idempotencyKey: input.idempotencyKey,
      bodySha256: sha256Hex(input.rawBody),
      receivedAt: this.options.clock.now().toISOString(),
      body: input.body,
    });
    if (saved.kind === 'inserted') {
      return { kind: 'accepted', event: toPublic(saved.event) };
    }
    if (saved.kind === 'replayed') {
      return { kind: 'replayed', event: toPublic(saved.event) };
    }
    return { kind: 'idempotency_conflict', eventId: saved.eventId };
  }

  async read(input: ReadInput): Promise<ReadResult> {
    const tenant = this.tenants.get(input.tenantId);
    const expected = tenant?.readToken ?? this.unknownReadToken;
    if (!tenant || !timingSafeStringEqual(input.token, expected)) {
      return { kind: 'unauthorized' };
    }
    if (
      input.after !== undefined &&
      (!Number.isSafeInteger(input.after) || input.after < 0)
    ) {
      return { kind: 'invalid_cursor' };
    }
    const after = input.after ?? 0;
    const events = await this.store.listAfter(input.tenantId, after, input.limit);
    const last = events[events.length - 1];
    let nextCursor: string | null;
    if (last !== undefined) {
      nextCursor = String(last.sequence);
    } else if (input.after !== undefined && input.after > 0) {
      nextCursor = String(input.after);
    } else {
      nextCursor = null;
    }
    return { kind: 'ok', events: events.map(toPublic), nextCursor };
  }
}

function toPublic(event: StoredEvent): PublicEvent {
  return {
    id: event.id,
    tenantId: event.tenantId,
    sequence: event.sequence,
    idempotencyKey: event.idempotencyKey,
    receivedAt: event.receivedAt,
    body: event.body,
  };
}
