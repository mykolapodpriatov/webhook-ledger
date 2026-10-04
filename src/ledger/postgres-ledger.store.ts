import { join } from 'node:path';
import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import { deliveries, tenantSequences } from '../db/schema';
import type { LedgerStore, SaveInput, SaveResult, StoredEvent } from './ledger-store';
import { LEDGER_OPTIONS, type LedgerOptions } from './ledger.service';

@Injectable()
export class PostgresLedgerStore
  implements LedgerStore, OnModuleInit, OnApplicationShutdown
{
  private readonly client: Sql;
  private readonly db: PostgresJsDatabase;
  private closed = false;

  constructor(@Inject(LEDGER_OPTIONS) options: LedgerOptions) {
    if (!options.databaseUrl) {
      throw new Error('DATABASE_URL is required to use PostgresLedgerStore.');
    }
    // max must stay above 1. One connection cannot run two transactions,
    // and the concurrent-insert path deadlocks on a pool of one.
    this.client = postgres(options.databaseUrl, {
      max: 10,
      connect_timeout: 10,
      // CREATE SCHEMA IF NOT EXISTS still emits a notice on later boots.
      onnotice: () => {},
    });
    this.db = drizzle(this.client);
  }

  async onModuleInit(): Promise<void> {
    await migrate(this.db, { migrationsFolder: join(process.cwd(), 'drizzle') });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.client.end({ timeout: 5 });
  }

  async save(input: SaveInput): Promise<SaveResult> {
    try {
      return await this.insertOrReplay(input);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      // The other transaction committed this key. Ours rolled back, so the
      // sequence increment went with it. Read the row that won.
      return this.replayOrConflict(input, error);
    }
  }

  async listAfter(
    tenantId: string,
    after: number,
    limit: number,
  ): Promise<StoredEvent[]> {
    const rows = await this.db
      .select()
      .from(deliveries)
      .where(and(eq(deliveries.tenantId, tenantId), gt(deliveries.sequence, after)))
      .orderBy(asc(deliveries.sequence))
      .limit(limit);
    return rows.map(toStored);
  }

  /** Test helper. Production traffic uses save and listAfter. */
  async clear(): Promise<void> {
    await this.db.delete(deliveries);
    await this.db.delete(tenantSequences);
  }

  private async insertOrReplay(input: SaveInput): Promise<SaveResult> {
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(deliveries)
        .where(
          and(
            eq(deliveries.tenantId, input.tenantId),
            eq(deliveries.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (found) {
        return sameBody(found, input);
      }

      const bumped = await tx
        .insert(tenantSequences)
        .values({ tenantId: input.tenantId, lastSequence: 1 })
        .onConflictDoUpdate({
          target: tenantSequences.tenantId,
          set: { lastSequence: sql`${tenantSequences.lastSequence} + 1` },
        })
        .returning({ lastSequence: tenantSequences.lastSequence });
      const sequence = bumped[0]?.lastSequence;
      if (sequence === undefined) {
        throw new Error('Sequence counter did not return a value.');
      }

      const inserted = await tx
        .insert(deliveries)
        .values({
          id: input.id,
          tenantId: input.tenantId,
          sequence,
          idempotencyKey: input.idempotencyKey,
          bodySha256: input.bodySha256,
          receivedAt: new Date(input.receivedAt),
          body: input.body,
        })
        .returning();
      const row = inserted[0];
      if (!row) {
        throw new Error('Insert did not return a row.');
      }
      return { kind: 'inserted', event: toStored(row) };
    });
  }

  private async replayOrConflict(input: SaveInput, error: unknown): Promise<SaveResult> {
    const rows = await this.db
      .select()
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenantId, input.tenantId),
          eq(deliveries.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    const found = rows[0];
    if (!found) {
      throw error;
    }
    return sameBody(found, input);
  }
}

function sameBody(row: typeof deliveries.$inferSelect, input: SaveInput): SaveResult {
  if (row.bodySha256 !== input.bodySha256) {
    return { kind: 'conflict', eventId: row.id };
  }
  return { kind: 'replayed', event: toStored(row) };
}

function toStored(row: typeof deliveries.$inferSelect): StoredEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    sequence: row.sequence,
    idempotencyKey: row.idempotencyKey,
    bodySha256: row.bodySha256,
    receivedAt: row.receivedAt.toISOString(),
    body: row.body,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code === '23505') {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return false;
}
