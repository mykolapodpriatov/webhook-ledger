import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const tenantSequences = pgTable('tenant_sequences', {
  tenantId: text('tenant_id').primaryKey(),
  lastSequence: integer('last_sequence').notNull(),
});

export const deliveries = pgTable(
  'deliveries',
  {
    id: uuid('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    sequence: integer('sequence').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    bodySha256: text('body_sha256').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true, mode: 'date' }).notNull(),
    body: jsonb('body').notNull(),
  },
  (table) => [
    uniqueIndex('deliveries_tenant_key').on(table.tenantId, table.idempotencyKey),
    uniqueIndex('deliveries_tenant_sequence').on(table.tenantId, table.sequence),
  ],
);
