CREATE TABLE "tenant_sequences" (
  "tenant_id" text PRIMARY KEY NOT NULL,
  "last_sequence" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
  "id" uuid PRIMARY KEY NOT NULL,
  "tenant_id" text NOT NULL,
  "sequence" integer NOT NULL,
  "idempotency_key" text NOT NULL,
  "body_sha256" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "body" jsonb NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_tenant_key" ON "deliveries" USING btree ("tenant_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_tenant_sequence" ON "deliveries" USING btree ("tenant_id", "sequence");
