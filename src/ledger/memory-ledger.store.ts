import { Injectable } from '@nestjs/common';
import type { LedgerStore, SaveInput, SaveResult, StoredEvent } from './ledger-store';

/**
 * Per-tenant sequences start at 1 and never skip, so `sequence > after`
 * is the same slice as `events.slice(after)`.
 *
 * save does not await between the key check and the append, so two calls
 * on this process cannot both insert. The Postgres store is what makes
 * that true across connections.
 */
@Injectable()
export class MemoryLedgerStore implements LedgerStore {
  private readonly events = new Map<string, StoredEvent[]>();
  private readonly byKey = new Map<string, StoredEvent>();

  async save(input: SaveInput): Promise<SaveResult> {
    const existing = this.byKey.get(keyOf(input.tenantId, input.idempotencyKey));
    if (existing) {
      if (existing.bodySha256 !== input.bodySha256) {
        return { kind: 'conflict', eventId: existing.id };
      }
      return { kind: 'replayed', event: existing };
    }

    const stored: StoredEvent = {
      ...input,
      sequence: this.nextSequence(input.tenantId),
    };
    this.append(stored);
    return { kind: 'inserted', event: stored };
  }

  async listAfter(
    tenantId: string,
    after: number,
    limit: number,
  ): Promise<StoredEvent[]> {
    const list = this.events.get(tenantId) ?? [];
    return list.slice(after, after + limit);
  }

  private append(event: StoredEvent): void {
    const list = this.events.get(event.tenantId) ?? [];
    const last = list[list.length - 1];
    const expected = last === undefined ? 1 : last.sequence + 1;
    if (event.sequence !== expected) {
      throw new Error(
        `Refusing to append sequence ${event.sequence} for ${event.tenantId}; expected ${expected}.`,
      );
    }
    list.push(event);
    this.events.set(event.tenantId, list);
    this.byKey.set(keyOf(event.tenantId, event.idempotencyKey), event);
  }

  private nextSequence(tenantId: string): number {
    const list = this.events.get(tenantId);
    const last = list?.[list.length - 1];
    return last === undefined ? 1 : last.sequence + 1;
  }
}

function keyOf(tenantId: string, idempotencyKey: string): string {
  return `${tenantId}\0${idempotencyKey}`;
}
