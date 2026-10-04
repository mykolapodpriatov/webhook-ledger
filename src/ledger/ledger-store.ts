export type StoredEvent = {
  id: string;
  tenantId: string;
  sequence: number;
  idempotencyKey: string;
  bodySha256: string;
  receivedAt: string;
  body: unknown;
};

export type SaveInput = {
  id: string;
  tenantId: string;
  idempotencyKey: string;
  bodySha256: string;
  receivedAt: string;
  body: unknown;
};

export type SaveResult =
  | { kind: 'inserted'; event: StoredEvent }
  | { kind: 'replayed'; event: StoredEvent }
  | { kind: 'conflict'; eventId: string };

/**
 * Idempotency and sequence allocation happen inside save, in one step.
 * Two callers cannot both observe "missing" and then both insert.
 */
export interface LedgerStore {
  save(input: SaveInput): Promise<SaveResult>;
  listAfter(tenantId: string, after: number, limit: number): Promise<StoredEvent[]>;
}

export const LEDGER_STORE = Symbol('LEDGER_STORE');
