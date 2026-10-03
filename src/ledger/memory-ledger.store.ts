export type StoredEvent = {
  id: string;
  tenantId: string;
  sequence: number;
  idempotencyKey: string;
  bodySha256: string;
  receivedAt: string;
  body: unknown;
};

/**
 * Per-tenant sequences start at 1 and never skip, so `sequence > after`
 * is the same slice as `events.slice(after)`.
 */
export class MemoryLedgerStore {
  private readonly events = new Map<string, StoredEvent[]>();
  private readonly byKey = new Map<string, StoredEvent>();

  findByKey(tenantId: string, idempotencyKey: string): StoredEvent | undefined {
    return this.byKey.get(keyOf(tenantId, idempotencyKey));
  }

  append(event: StoredEvent): void {
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

  nextSequence(tenantId: string): number {
    const list = this.events.get(tenantId);
    const last = list?.[list.length - 1];
    return last === undefined ? 1 : last.sequence + 1;
  }

  listAfter(tenantId: string, after: number, limit: number): StoredEvent[] {
    const list = this.events.get(tenantId) ?? [];
    return list.slice(after, after + limit);
  }
}

function keyOf(tenantId: string, idempotencyKey: string): string {
  return `${tenantId}\0${idempotencyKey}`;
}
